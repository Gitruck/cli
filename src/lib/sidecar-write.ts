/**
 * 旁路记账的统一写入口（change `fix-sidecar-write-failure-kills-command`）。
 *
 * 生产报错 `base_error#202`（外部客户）：`uploadCached` 把文件传完之后，去写一条约 1 KB 的
 * 上传记账，`EPERM` 一抛，**第三步挣来的 `fileId` 跟着陪葬**，整条命令死在第五步。
 * 客户重试时缓存里没那条记录 ⇒ 整个文件再传一遍。
 * 而同一个文件的读侧写着「缓存损坏不致命，当空处理」——**坏了能忍，写不进去却要命**。
 *
 * ## 它是干什么的
 *
 * 本模块只服务**旁路记账**：缓存、续传断点、使用历史、留痕账本 ——
 * 本次命令不为它们而跑，它们下次可以重建。这类写失败 MUST 吞。
 *
 * ## ⚠️ 也不是所有旁路写都该收编进来
 *
 * 本模块**强制告知**（`consequence` 必填）。所以它只适合「后果用户**可感知且可行动**」的那些：
 * 上传记账写不上 ⇒ 下次重传几百 MB，用户看得见（慢），也有得做（去修那个目录的权限）。
 *
 * 本仓另有三处旁路写**刻意不收编**（2026-09-19 逐处核过），因为它们的后果用户既感知不到、
 * 也无从行动，告知一条只会变噪声：
 *
 * | 站点 | 写不上的后果 |
 * |---|---|
 * | `enum-catalog.ts` `writeSnapshot` | 下次多拉一次清单 |
 * | `text-templates.ts` `writeCache` | 下次多拉一次目录 |
 * | `skill-freshness.ts` `writeSkillManifest` | 日后核对判不出、静默跳过；**且它返回 boolean**，调用方本就有信号 |
 *
 * ⇒ 要不要告知，看**后果用户感不感知、能不能行动**；不是「凡旁路写都告知」。
 *
 * ## ⚠️ MUST NOT 用于交付物
 *
 * 判据是**调用语境**，不是写入函数（spec `local-io-resilience`）：
 * 同一个写入函数在一处是交付物、在另一处是旁路记账，是常态。
 *
 * 本仓现成的两个**反例**，它们刻意不走本模块：
 * - `user-config.ts` 的 `writeUserConfig` —— `gtrk init` 存 API Key 那次是**交付物**。
 *   吞了用户会以为 Key 存上了，下一条命令撞 401，那时离根因已经很远。
 * - `column-config.ts` 的 `appendStyleSkillEntry` —— `gtrk skills` 登记是用户按下的动作。
 *
 * 反过来，`writeUserConfig` 被**崩溃告知留痕**调的那次又确实是旁路 ——
 * 所以那一处由 `compliance-notice` 在自己的调用点包 `try`。函数不知道自己这次被谁调，
 * **只有调用点知道**。
 *
 * ## 三条硬约束
 *
 * ① **绝不抛。** 本模块挂在「用户已经拿到结果」之后的路径上；自己再炸一次，
 *    就把本件要治的事原样做了一遍。连告知那一步都包在 `try` 里——
 *    `log.warn` 在流写不动时是会抛的（姊妹件 design D2 只吞两个具名码）。
 * ② **原子写。** `writeFile` 的 `'w'` 先截断再写：中途失败会把**整份记账写没**，
 *    读侧解析失败 ⇒ 回落空 ⇒ 历史上所有文件全量重传。先写 temp 再替换，
 *    要么整份换新、要么原样不动。
 *    ⚠️ 替换失败时**删 temp**——与姊妹件的 `writeMarkdownAtomic` 恰好相反（那边要保留）。
 *    语境不同：那份内容是用户付过费的，这份下次自己会重算。
 * ③ **不重试。** 它下次自己会重来，为一条簿子多等几百毫秒不划算。
 *
 * ## 不保证什么
 *
 * 进程被硬杀在「写完 temp、还没替换」那个毫秒级窗口里时，`~/.gitruck` 下会留一个 `.tmp`
 * 残骸。没做清理：触发窗口极窄、单个文件极小，为它加一套年龄闸不划算。
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log";

export interface SidecarWriteOpts {
	/** 人话名字，只进文案（「上传记账」「分片续传断点」…）。 */
	label: string;
	/** 这次没记上的**后果**，一句话。让用户知道降级成了什么，而不只是「出错了」。 */
	consequence: string;
}

/**
 * 已经告知过的目标，按**路径**记（拍板 A，2026-09-19）。
 *
 * 同一目标反复失败几乎必然同根因，说一次够了；换个目标再说一次，
 * 免得第二个不同的根因被第一个盖掉。
 */
const notified = new Set<string>();

/** 单测注入旋钮（形制同 `crash-report.ts` 的 `__crashReportIo`）。**生产恒 `null`**。 */
export const __sidecarWriteIo: {
	impl: null | {
		writeFile?: (p: string, body: string) => Promise<void>;
		rename?: (from: string, to: string) => Promise<void>;
		writeFileSync?: (p: string, body: string) => void;
		renameSync?: (from: string, to: string) => void;
		warn?: (msg: string) => void;
	};
} = { impl: null };

/** 仅供单测：清空已告知集合与注入面（生产代码不该调）。 */
export function resetSidecarWriteState(): void {
	notified.clear();
	__sidecarWriteIo.impl = null;
}

function tempFor(path: string): string {
	return `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
}

/**
 * 告知一次。**本函数自身也绝不抛**——`log.warn` 在流写不动时是会抛的，
 * 而这里已经在兜底路径上，再炸一次就没人接了。
 */
function notifyOnce(path: string, opts: SidecarWriteOpts, cause: unknown): void {
	try {
		if (notified.has(path)) return;
		notified.add(path);
		const code = (cause as { code?: unknown })?.code;
		const why = typeof code === "string" ? code : cause instanceof Error ? cause.message : String(cause);
		const warn = __sidecarWriteIo.impl?.warn ?? ((m: string) => log.warn(m));
		warn(`${opts.label}没写进 ${path}（${why}）。本次结果不受影响；${opts.consequence}。`);
	} catch {
		/* 连告知都失败就彻底静默——兜底路径上 MUST NOT 再抛 */
	}
}

/** 异步式。收编 `await writeFile(记账文件, …)` 那一族站点。**MUST NOT 抛**。 */
export async function writeSidecar(path: string, body: string, opts: SidecarWriteOpts): Promise<void> {
	const io = __sidecarWriteIo.impl ?? {};
	const temp = tempFor(path);
	try {
		await mkdir(dirname(path), { recursive: true });
		await (io.writeFile ?? ((p: string, b: string) => writeFile(p, b, "utf8")))(temp, body);
		await (io.rename ?? ((a: string, b: string) => rename(a, b)))(temp, path);
	} catch (e) {
		await rm(temp, { force: true }).catch(() => {});
		notifyOnce(path, opts, e);
	}
}

/** 同步式。收编 `writeFileSync(记账文件, …)` 那一族站点。**MUST NOT 抛**。 */
export function writeSidecarSync(path: string, body: string, opts: SidecarWriteOpts): void {
	const io = __sidecarWriteIo.impl ?? {};
	const temp = tempFor(path);
	try {
		mkdirSync(dirname(path), { recursive: true });
		(io.writeFileSync ?? ((p: string, b: string) => writeFileSync(p, b, "utf8")))(temp, body);
		(io.renameSync ?? ((a: string, b: string) => renameSync(a, b)))(temp, path);
	} catch (e) {
		try {
			rmSync(temp, { force: true });
		} catch {
			/* 连清 temp 都失败：不值得因此打断，残骸留着 */
		}
		notifyOnce(path, opts, e);
	}
}
