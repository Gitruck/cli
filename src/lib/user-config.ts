/**
 * 用户级持久配置：~/.gitruck/config.json。
 * 由 `gtrk init` 一次性写入（API Key / 根地址 / 剪映草稿目录），之后所有命令免重复配置。
 * 与上传缓存、ffmpeg、抽出物缓存同住 ~/.gitruck/。读为 sync（配置极小），写在 init 流程里调。
 */
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { gitruckHome } from "./paths";
import { readJsonSync } from "./read-json";

/** 云端 API 默认根地址（生产）。init 预填、loadConfig 兜底，用户一般只需填 Key。 */
export const DEFAULT_API_BASE = "https://api.ai-mcn.tv:10000";

const DIR = gitruckHome();
const FILE = join(DIR, "config.json");

export interface UserConfig {
	apiBase?: string;
	apiKey?: string;
	jianyingDraftDir?: string;
	/** 缺省栏目配置 id（gtrk split --column 未传时取此；再缺省 = 内置默认栏目）。 */
	defaultColumn?: string;
	/** 自建 embed 端点完整 URL 覆盖（add-matrix-local-search；缺省 = apiBase 推导，env GITRUCK_EMBED_URL 优先级更高）。 */
	embedUrl?: string;
	/** 素材理解端点完整 URL 覆盖（add-matrix-describe-and-window；缺省 = apiBase 推导
	 * `/task/cli/material_describe`，env GITRUCK_DESCRIBE_URL 优先级更高）。 */
	describeUrl?: string;
	/** 合规告知留痕（add-compliance-notice）：已告知的条款版本标识。缺失 = 未告知；
	 * 与 CLI 常量 TERMS_VERSION 不一致（条款实质更新后 bump）⇒ 重新告知一次。
	 * **纯本地留痕**，MUST NOT 上报服务端；它 MUST NOT 被当作任何命令的执行前置条件。 */
	termsNoticeVersion?: string;
	/** 合规告知留痕（add-compliance-notice）：告知时间戳（ISO 8601）。 */
	termsNoticeAt?: string;
	/** 崩溃自动上报开关（link-client-error-report-cli）：`false` 表关，缺失 = 开。
	 * 环境变量 `GITRUCK_CRASH_REPORT=0` 优先级更高（临时关一次不该要求改配置文件）。
	 * **纯本地开关**，MUST NOT 上报服务端；它 MUST NOT 被当作任何命令的执行前置条件。 */
	crashReport?: boolean;
	/** 崩溃上报告知留痕（link-client-error-report-cli）：已告知的文案版本标识。缺失 = 未告知。
	 * ⚠️ **未告知 ⇒ 不上报**（design D7：宁可漏报，也不让「先发后说」在任何时序下发生）。
	 * **纯本地留痕**，MUST NOT 上报服务端；它 MUST NOT 被当作任何命令的执行前置条件。 */
	crashReportNoticeVersion?: string;
	/** 首跑教程指路留痕（add-first-run-tutorial）：已指路的时间戳（ISO 8601）。缺失 = 未指路。
	 * **纯本地留痕**，MUST NOT 上报服务端；它 MUST NOT 被当作任何命令的执行前置条件。
	 * 注：存量老用户（配置里已有 apiKey）会被静默补痕、不打印——见 first-run-tutorial.ts 的 looksOnboarded()。 */
	firstRunNoticeAt?: string;
}

export function configPath(): string {
	return FILE;
}

export function readUserConfig(): UserConfig {
	if (!existsSync(FILE)) return {};
	try {
		return readJsonSync<UserConfig>(FILE);
	} catch {
		return {}; // 损坏当空，init 可重写
	}
}

/**
 * 合并写入（保留未传字段）。
 *
 * ⚠️ 写失败**照旧抛**，MUST NOT 走 `sidecar-write`
 * （change `fix-sidecar-write-failure-kills-command` · design D6）：
 * `gtrk init` 存 API Key 那次它是**交付物** —— 吞了用户会以为存上了，
 * 下一条命令撞 401，那时离根因已经很远。
 *
 * 同一个函数被**崩溃告知留痕**调的那次确实是旁路，所以那一处由 `crash-report.ts` 在
 * **自己的调用点**包 `try`（那里注释写着「落痕失败不阻断」）。
 * ⇒ 判据挂调用点，不挂函数。
 *
 * 本次只把 Node 原文换成带路径与处置建议的人话；顺带它也就不再被判成崩溃。
 */
export function writeUserConfig(patch: UserConfig): void {
	try {
		mkdirSync(DIR, { recursive: true });
		const merged = { ...readUserConfig(), ...patch };
		writeFileSync(FILE, JSON.stringify(merged, null, 2));
	} catch (e) {
		const code = (e as { code?: unknown })?.code;
		const why = typeof code === "string" ? code : e instanceof Error ? e.message : String(e);
		throw new Error(
			`配置存不进 ${FILE}（${why}）。\n` +
				`多半是那个文件正被别的程序占着，或者目录不让写（企业策略 / 网盘同步 / 杀软）。\n` +
				`处理：确认那个目录可写之后重跑；急用可以先设环境变量 GITRUCK_API_KEY 绕开配置文件。`,
		);
	}
}
