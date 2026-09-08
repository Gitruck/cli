/**
 * 产物落点可写性闸（add-artifact-landing-gate · capability `artifact-landing-gate`）。
 *
 * 裁决（2026-09-07 事故后主理人拍板 D5）：**改变产物落点的兜底不是良性降级**。
 * 落点写不进去时，MUST 给硬信号并阻塞，MUST NOT 静默改投 cwd / temp / 兄弟目录。
 * 本模块只负责**实证可写**这一件事，阻塞重探与文案由调用方（Gate A / Gate B）持有。
 *
 * 三层形态照 `src/lib/cloud-render-guard.ts`：纯探针 → assert 包装 → 多落点挂载。
 *
 * ══ 两条硬约束，MUST NOT 在实现里绕开 ══
 *
 * ① **MUST NOT 用 `fs.access` / `accessSync` / `W_OK` 推断权限。**
 *    Windows ACL、只读挂载、云同步占位文件三种真机形态下权限位会说谎。
 *    全仓今日这三个符号零命中，所以这不是「改掉一个错模式」，是「新增时别引进来」。
 *    判据只认**真实写入**：独占创建一个零字节点文件，用完即删。
 *
 * ② **MUST NOT 用 `mkdir(outDir)` → 写 → `rmdir` 的形态探针。**
 *    撞 `oralcut-result-persistence :: 失败不留空壳产物目录` —— 进程若死在 mkdir 与 rmdir 之间，
 *    留下的正是那条明令禁止的空壳目录，且该失守不会以任何形式报错。
 *    故探针恒落**落点自身（若已存在）或其最近的既存祖先目录**。
 *
 * ══ 诚实边界 ══
 * 探针证明**权限**，不证明**容量**：零字节写成功不代表磁盘装得下 500MB 的剪映草稿。
 * 本闸是加法而非替代，落地阶段的失败分类与非零退出是它的兜底（见 materialize 侧 Gate B）。
 */
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** 机读拒绝码（`--json` / `error.code` 同值）。 */
export const ARTIFACT_LANDING_CODE = "artifact_landing_not_writable";

/** 探针文件名前缀。测试据此断言「跑完无残留」；MUST NOT 用它去清扫历史文件（未经请求的删除）。 */
export const LANDING_PROBE_PREFIX = ".gtrk-write-probe.";

/** 被判为「本地写入失败」的 errno（与 materialize 侧 `isLocalWriteError` 同表）。 */
export const LOCAL_WRITE_ERRNOS = ["EACCES", "EPERM", "EROFS", "ENOSPC", "ENAMETOOLONG"] as const;

export type LandingProbeReason =
	/** 一路上溯到根（含 UNC 共享根）都没有一个既存目录——盘符未映射 / 共享未连接。 */
	| "no_existing_ancestor"
	/** 找到了既存祖先，但在其中独占创建零字节文件失败。 */
	| "write_denied";

export interface LandingProbeFailure {
	/** 调用方请求的落点（已 `resolve`）。 */
	target: string;
	/** 实际被探的目录（最近的既存祖先）；`no_existing_ancestor` 时为 null。 */
	probed: string | null;
	reason: LandingProbeReason;
	/** 原始 errno（如 `EACCES`）；取不到时 null。 */
	errno: string | null;
	/** 原始错误消息尾部，供人读文案引用。 */
	detail: string | null;
}

export type LandingProbeResult = { ok: true; probed: string } | ({ ok: false } & LandingProbeFailure);

export class ArtifactLandingError extends Error {
	readonly code = ARTIFACT_LANDING_CODE;
	constructor(
		readonly failure: LandingProbeFailure,
		/** 人读的落点名目，如「产物目录」「剪映草稿根」。 */
		readonly label: string,
	) {
		super(
			failure.reason === "no_existing_ancestor"
				? `${label}不可写：${failure.target} —— 一路上溯都找不到既存目录` +
						"（盘符未映射 / 网络共享未连接 / 路径拼错？）"
				: `${label}不可写：${failure.target}` +
						`（实际探测目录 ${failure.probed}${failure.errno ? ` · ${failure.errno}` : ""}）` +
						`${failure.detail ? ` —— ${failure.detail}` : ""}`,
		);
		this.name = "ArtifactLandingError";
	}
}

/**
 * 从 `target` 起一路上溯，返回**最近的既存目录**；一路到根都没有则 null。
 *
 * 终止条件靠 `dirname` 的不动点：`C:\` 与 UNC 共享根 `\\server\share` 的 dirname 都是自身，
 * 故 UNC 天然止于共享根，MUST NOT 上溯到 `\\server`（那不是一个可写目录概念）。
 * 路径上存在同名**文件**时继续上溯（被文件占位不构成可用落点）。
 */
export function nearestExistingAncestor(target: string): string | null {
	let cur = resolve(target);
	for (;;) {
		if (existsSync(cur)) {
			try {
				if (statSync(cur).isDirectory()) return cur;
			} catch {
				/* 竞态：existsSync 与 statSync 之间被删。按不存在处理，继续上溯 */
			}
		}
		const parent = dirname(cur);
		if (parent === cur) return null; // 到根（含 UNC 共享根）仍无既存目录
		cur = parent;
	}
}

/**
 * 在**已存在**的目录里做一次真实写入探针：独占创建（`flag:"wx"`）零字节点文件 → 立即删除。
 * 形态照仓内既有范式 `src/lib/gtrk-writeback.ts:124-135`；删除失败吞掉（无害）。
 */
export async function probeDirWritable(
	dir: string,
): Promise<{ ok: true } | { ok: false; errno: string | null; detail: string | null }> {
	const probe = join(dir, `${LANDING_PROBE_PREFIX}${randomBytes(6).toString("hex")}.tmp`);
	try {
		await writeFile(probe, "", { flag: "wx" });
		return { ok: true };
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		return {
			ok: false,
			errno: typeof err?.code === "string" ? err.code : null,
			detail: typeof err?.message === "string" ? err.message : null,
		};
	} finally {
		try {
			await unlink(probe);
		} catch {
			/* 探针未建成或已被清走，删除失败无害 */
		}
	}
}

/** 纯探针：解析落点 → 最近既存祖先 → 真实写入。**MUST NOT 创建落点目录本身。** */
export async function probeLandingWritable(target: string): Promise<LandingProbeResult> {
	const abs = resolve(target);
	const probed = nearestExistingAncestor(abs);
	if (probed === null) {
		return { ok: false, target: abs, probed: null, reason: "no_existing_ancestor", errno: null, detail: null };
	}
	const r = await probeDirWritable(probed);
	if (r.ok) return { ok: true, probed };
	return { ok: false, target: abs, probed, reason: "write_denied", errno: r.errno, detail: r.detail };
}

/** assert 包装：不可写即抛 `ArtifactLandingError`（code = `artifact_landing_not_writable`）。 */
export async function assertLandingWritable(target: string, label: string): Promise<string> {
	const r = await probeLandingWritable(target);
	if (r.ok) return r.probed;
	const { ok: _ok, ...failure } = r;
	throw new ArtifactLandingError(failure, label);
}

/**
 * 多落点挂载：按序探一组落点，**第一个失败即抛**。
 * 用于 Gate A 一次性覆盖「产物目录根」与（要产剪映格式且已解析出草稿根时）「剪映草稿根」。
 * `target` 为 null / 空串的条目**跳过**（如未请求剪映格式、或草稿根压根没探到——
 * 后者维持既有 WARN 语义，不由本闸接管，见 tasks §0 的 0.5）。
 */
export async function assertLandingsWritable(
	targets: ReadonlyArray<{ target: string | null | undefined; label: string }>,
): Promise<void> {
	for (const t of targets) {
		if (!t.target) continue;
		await assertLandingWritable(t.target, t.label);
	}
}

/**
 * `child` 是否位于 `root` **之内**（含 root 自身）。
 *
 * ⚠️ **两侧都先 realpath 再比**，MUST NOT 用字符串前缀：2026-09-07 现场就有一条
 * `work/project -> …案例7-场景3_extaudio-video-project-260907-211529` 的软链——
 * 字面前缀既会**误杀**经软链抵达的合规写入，又能被随手造一条软链**绕过**。
 * 路径不存在时对该侧退化为 `resolve()`（尚未创建的落点仍要能判）。
 */
export function isInsideDir(child: string, root: string): boolean {
	const real = (p: string): string => {
		try {
			return realpathSync(resolve(p));
		} catch {
			return resolve(p); // 尚不存在：按字面解析，仍好过不判
		}
	};
	const rel = relative(real(root), real(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
