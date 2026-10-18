/**
 * CLI 使用统计（change `add-usage-analytics`）。
 *
 * 事件规范正本：gitruck-infra《同合云埋点体系方案》「四、事件规范」；姊妹件：即剪 `add-usage-analytics`
 * （共用规范，不共用代码）。收数端：自建 Umami，`https://api.ai-mcn.tv:10000/e/gc`（`/api/send` 原样格式）。
 *
 * ## 三道闸（任一不满足：不写队列、不起子进程、零请求）
 *
 * 1. **正式发布版**：从源码跑、单测（`NODE_TEST_CONTEXT`）、`CI` 环境一律不发。
 * 2. **已告知**：`usageAnalyticsNoticeVersion === USAGE_NOTICE_VERSION`。宁可漏，不先发后说。
 * 3. **开关开**：`GITRUCK_USAGE_STATS=0` / `DO_NOT_TRACK=1` / 配置 `usageAnalytics:false` 任一即关；
 *    环境变量优先于配置（本仓惯例，同 `GITRUCK_CRASH_REPORT`）。
 *
 * ## 零额外等待（design D1）
 *
 * 命令结束时只**同步追加一行**到 `~/.gitruck/usage-queue.jsonl`，再起一个脱离父进程的后台子进程
 * （`<node> <入口> __usage-flush`，`detached` + `unref`）去发，父进程照常立即退出。
 * 发送进程同一时间至多一个（锁文件）；发不出去的留在队列，下次再发，带原始时间戳。
 *
 * ## 不发什么
 *
 * 命令参数与选项值、文件名、路径、工程内容、API Key、错误消息原文；任何设备 / 安装标识。
 * 请求 MUST NOT 带 `Authorization`——收数端不认 Key，带了只是白白外发凭据。
 *
 * ## ⚠️ User-Agent 不能含 `node`（design D2，2026-10-18 实测）
 *
 * Umami 的爬虫判定会把含 `node` 字样的 UA 静默丢掉（回 `{"beep":"boop"}`）。
 * 采用 `gtrk-cli/<版本> (<系统段>)`：不冒充浏览器，系统照样认得出（六种系统段实测通过）。
 *
 * ## 硬约束
 *
 * **绝不抛、除一次性告知外绝不打印、绝不改命令的输出与退出码。**
 */
import { spawn as realSpawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { release as osRelease } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitruckHome } from "./paths";
import { readUserConfig as realReadUserConfig, writeUserConfig as realWriteUserConfig, type UserConfig } from "./user-config";
import { currentVersion } from "./version";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 收数口（公网入口，绝对地址）。 */
export const USAGE_COLLECT_URL = "https://api.ai-mcn.tv:10000/e/gc";
/** Umami 站点「gtrk CLI」（2026-10-18 建）。 */
export const USAGE_WEBSITE_ID = "88fc28d4-6fc3-4b74-9c26-d161f0fe0c92";
export const USAGE_HOSTNAME = "gtrk.cli";
/** 告知留痕版本。文案实质变更时 bump 一次。 */
export const USAGE_NOTICE_VERSION = "usage-analytics-v1";
/** 关闭开关的环境变量名。 */
export const USAGE_ENV = "GITRUCK_USAGE_STATS";
/** 隐藏的发送子命令：`src/index.ts` 在 commander 解析之前短路它。 */
export const FLUSH_COMMAND = "__usage-flush";

export const QUEUE_FILE = "usage-queue.jsonl";
export const LOCK_FILE = "usage-flush.lock";
/** 上一次发送进程结束的时间戳文件（成败都写）。 */
export const LAST_FLUSH_FILE = "usage-flush.last";
/** 队列上限，满了丢最旧的。 */
export const QUEUE_MAX = 200;
/** 队列里超过 7 天的丢弃。 */
export const QUEUE_TTL_MS = 7 * 24 * 3600 * 1000;
/** 一个发送进程最多发这么多条。 */
export const FLUSH_BATCH = 50;
/** 单个请求超时（收数口 `/e/` 自己 5 秒内必返回）。 */
export const REQUEST_TIMEOUT_MS = 5000;
/** 一个发送进程的总时长上限。 */
export const FLUSH_BUDGET_MS = 30_000;
/** 锁文件超过这么久视为上一个发送进程已经没了。 */
export const LOCK_STALE_MS = 60_000;
/** 认领文件超过这么久视为上次中断，并回队列。 */
export const SENDING_STALE_MS = 10 * 60_000;
/**
 * 两次起发送进程之间至少隔这么久（apply 实测，design ⟲ 1）：agent 连续调用时，上一条命令的发送进程
 * 会和下一条命令抢 CPU（背靠背实测中位数多出约 100 ms）。限频后连续调用只有第一条起进程，其余只写队列。
 */
export const FLUSH_MIN_INTERVAL_MS = 30_000;
/** 队列积到这么大（约 50 条）就不等间隔，照起发送进程。 */
export const FLUSH_FORCE_BYTES = 32 * 1024;

export const USAGE_NOTICE_LINE =
	`📊  使用统计已开启：只发命令名、成败与耗时区间（不含参数、文件与凭据）。` +
	`关闭：gtrk init --no-usage-stats，或设 ${USAGE_ENV}=0`;
export const USAGE_NOTICE_LINE_OFF =
	`📊  使用统计已关闭（本机不会发送任何使用统计）。` +
	`重新开启：删掉配置里的 usageAnalytics 或设 ${USAGE_ENV}=1`;

// ---------------------------------------------------------------------------
// 注入面
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

/**
 * 单测注入旋钮（形制同 `__crashReportIo`）。**生产恒 `null`**，走真实现。
 * 每个字段都可缺省，缺省走真实现。
 */
export const __usageAnalyticsIo: {
	impl: null | {
		env?: () => Env;
		now?: () => number;
		/** `~/.gitruck` 的位置（测试给临时目录）。 */
		home?: () => string;
		fetch?: typeof fetch;
		spawn?: (cmd: string, args: string[], opts: Record<string, unknown>) => { unref(): void; on(ev: string, fn: () => void): unknown };
		readUserConfig?: () => UserConfig;
		writeUserConfig?: (patch: UserConfig) => void;
		stderr?: (chunk: string) => void;
		version?: () => string;
		/** 闸 1 里的「从源码运行」判定。 */
		fromSource?: () => boolean;
		platform?: () => { platform: string; arch: string; release: string; node: string };
		isTTY?: () => boolean;
		pid?: () => number;
		/** 发送子进程用的入口脚本（缺省 `process.argv[1]`）。 */
		entry?: () => string | undefined;
	};
} = { impl: null };

/** 模块自己是不是从 `src/` 跑起来的（发布物是打包后的 `dist/index.js`）。 */
function defaultFromSource(): boolean {
	try {
		return /[\\/]src[\\/]lib[\\/]usage-analytics\.ts$/.test(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

function io() {
	const i = __usageAnalyticsIo.impl;
	return {
		env: i?.env ?? (() => process.env as Env),
		now: i?.now ?? (() => Date.now()),
		home: i?.home ?? gitruckHome,
		fetch: i?.fetch ?? fetch,
		spawn:
			i?.spawn ??
			((cmd: string, args: string[], opts: Record<string, unknown>) => realSpawn(cmd, args, opts as Parameters<typeof realSpawn>[2])),
		readUserConfig: i?.readUserConfig ?? realReadUserConfig,
		writeUserConfig: i?.writeUserConfig ?? realWriteUserConfig,
		stderr: i?.stderr ?? ((chunk: string) => void process.stderr.write(chunk)),
		version: i?.version ?? currentVersion,
		fromSource: i?.fromSource ?? defaultFromSource,
		platform:
			i?.platform ??
			(() => ({ platform: process.platform, arch: process.arch, release: osRelease(), node: process.versions.node })),
		isTTY: i?.isTTY ?? (() => !!process.stdin.isTTY && !!process.stdout.isTTY),
		pid: i?.pid ?? (() => process.pid),
		entry: i?.entry ?? (() => process.argv[1]),
	};
}

// ---------------------------------------------------------------------------
// 闸与开关
// ---------------------------------------------------------------------------

/** 命令收尾期间的配置快照（一次命令只读一次配置文件；apply 实测每次读约 1–2 ms）。 */
let configSnapshot: UserConfig | null = null;

function readConfig(): UserConfig {
	return configSnapshot ?? io().readUserConfig();
}

function withConfigSnapshot<T>(fn: () => T): T {
	try {
		configSnapshot = io().readUserConfig();
	} catch {
		configSnapshot = {};
	}
	try {
		return fn();
	} finally {
		configSnapshot = null;
	}
}

let versionCache: string | null = null;

function cliVersion(): string {
	if (versionCache === null) versionCache = io().version();
	return versionCache;
}

const truthy = (v: string | undefined) => v != null && v.trim() !== "" && !/^(0|false|no|off)$/i.test(v.trim());

/** 开关四态，供 `gtrk doctor` 如实呈现。 */
export type UsageSwitchState = "on" | "off-env" | "off-dnt" | "off-config";

export function usageSwitchState(): UsageSwitchState {
	try {
		const d = io();
		const env = d.env();
		const own = env[USAGE_ENV];
		if (own != null && own.trim() === "0") return "off-env";
		if (truthy(env.DO_NOT_TRACK)) return "off-dnt";
		try {
			if (readConfig().usageAnalytics === false) return "off-config";
		} catch {
			/* 配置读不出 = 不当作关闭 */
		}
		return "on";
	} catch {
		return "on";
	}
}

/** 闸 1 不过的原因（`null` = 是正式发布版环境）。`doctor` 用它如实说「开但这里不发」。 */
export function notSendableReason(): "source" | "test" | "ci" | null {
	const d = io();
	const env = d.env();
	if (d.fromSource()) return "source";
	if (env.NODE_TEST_CONTEXT) return "test";
	if (truthy(env.CI)) return "ci";
	return null;
}

function hasNotice(): boolean {
	try {
		return readConfig().usageAnalyticsNoticeVersion === USAGE_NOTICE_VERSION;
	} catch {
		return false;
	}
}

/** 三道闸全开？ */
export function usageGatesOpen(): boolean {
	try {
		return notSendableReason() === null && hasNotice() && usageSwitchState() === "on";
	} catch {
		return false;
	}
}

let noticedInThisProcess = false;

/**
 * 幂等告知：挂在崩溃上报告知的同一批告知点之后，**不新增会打印的时刻**。
 * 非正式发布版（源码 / 单测 / CI）不告知——那里本来就不发。
 *
 * @param opts.force 无视留痕强制打印一次。只给 `gtrk init --no-usage-stats` 用（当场确认）。
 * @returns 是否本次打印了。绝不抛。
 */
export function usageAnalyticsNoticeOnce(opts: { force?: boolean } = {}): boolean {
	try {
		const d = io();
		if (!opts.force) {
			if (notSendableReason() !== null) return false;
			if (hasNotice() || noticedInThisProcess) return false;
		}
		const line = usageSwitchState() === "on" ? USAGE_NOTICE_LINE : USAGE_NOTICE_LINE_OFF;
		d.stderr(`\x1b[2m${line}\x1b[0m\n`);
		noticedInThisProcess = true;
		try {
			d.writeUserConfig({ usageAnalyticsNoticeVersion: USAGE_NOTICE_VERSION });
		} catch {
			/* 落痕失败：下次会再告知一次，这期间不发（未告知不上报） */
		}
		return true;
	} catch {
		return false;
	}
}

/** `gtrk init --no-usage-stats`：写配置关掉，并删掉本机还没发出去的。 */
export function disableUsageAnalytics(): void {
	try {
		io().writeUserConfig({ usageAnalytics: false });
	} catch {
		/* 写配置失败由 init 自己的写盘路径报；这里不抛 */
	}
	clearUsageQueue();
}

export function clearUsageQueue(): void {
	try {
		rmSync(join(io().home(), QUEUE_FILE), { force: true });
	} catch {
		/* 删不掉无害 */
	}
}

// ---------------------------------------------------------------------------
// 白名单与分桶（与即剪 `usage-analytics.ts` 同一套判据）
// ---------------------------------------------------------------------------

type PropValue = string | number | boolean;

const SAFE_VALUE_RE = /^[A-Za-z0-9<>][A-Za-z0-9_.:+<>-]{0,47}$/;
const GC_TOKEN_RE = /gc_[A-Za-z0-9]{16,}/;

export function cleanValue(v: unknown): PropValue | undefined {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
	if (typeof v !== "string") return undefined;
	const s = v.trim();
	if (!SAFE_VALUE_RE.test(s) || GC_TOKEN_RE.test(s)) return undefined;
	return s;
}

/** `command_run` 放行的属性。 */
export const COMMAND_RUN_PROPS = ["command", "result", "error_code", "elapsed_bucket", "invoker"] as const;
/** 公共属性。 */
export const COMMON_PROP_KEYS = ["cli_version", "os", "arch", "node_major", "has_api_key"] as const;

/** 耗时分桶（毫秒），档位与即剪、工具箱逐字一致。 */
export function elapsedBucket(ms: number): string {
	const s = Math.max(0, ms) / 1000;
	if (s < 10) return "<10s";
	if (s < 60) return "10-60s";
	if (s < 300) return "1-5min";
	if (s < 1800) return "5-30min";
	return ">30min";
}

/** Node 系统错误码形态（`ENOENT` / `EACCES`…）。 */
const SYS_CODE_RE = /^E[A-Z0-9]+$/;

/**
 * 只取错误码或分类，MUST NOT 带消息原文：
 * `CloudError` 的数字码 → Node 系统错误码 → 本仓哨兵常量（全大写消息）→ `Error.name` → `unknown`。
 */
export function errorCodeOf(e: unknown): string {
	if (e && typeof e === "object") {
		const code = (e as { code?: unknown }).code;
		if (typeof code === "number" && Number.isFinite(code)) return String(code);
		if (typeof code === "string" && (SYS_CODE_RE.test(code) || /^[A-Z][A-Z0-9_]{2,31}$/.test(code))) return code;
	}
	const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
	if (/^[A-Z][A-Z0-9_]{2,31}$/.test(msg)) return msg;
	if (e instanceof Error && /^[A-Za-z]{2,32}$/.test(e.name)) return e.name;
	return "unknown";
}

/**
 * 调用方：`AI_AGENT` 的名称段（业界通用约定，值形如 `claude-code`、`devin@1`、`claude-code_2-1-299_agent`）
 * → 各 agent 自己的标记 → 终端 → `unknown`。只留 `[a-z0-9-]`，≤ 24 字，不带版本。
 */
export function detectInvoker(env: Env, isTTY: boolean): string {
	const ai = env.AI_AGENT;
	if (truthy(ai)) {
		const name = ai!
			.trim()
			.toLowerCase()
			.split(/[@_\s/]/)[0]
			.replace(/[^a-z0-9-]/g, "")
			.slice(0, 24);
		if (name) return name;
	}
	if (truthy(env.CLAUDECODE) || truthy(env.CLAUDE_CODE)) return "claude-code";
	if (truthy(env.CURSOR_AGENT)) return "cursor";
	if (truthy(env.GEMINI_CLI)) return "gemini-cli";
	if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID) return "codex";
	return isTTY ? "terminal" : "unknown";
}

/** `gtrk-cli/<版本> (<系统段>)`。⚠️ MUST NOT 含 `node`（会被判爬虫）。 */
export function usageUserAgent(version: string, platform: string, arch: string, release: string): string {
	let seg: string;
	if (platform === "win32") {
		const nt = /^(\d+\.\d+)/.exec(release)?.[1] ?? "10.0";
		seg = `Windows NT ${nt}; ${arch === "arm64" ? "ARM64" : arch === "x64" ? "Win64; x64" : "Win32"}`;
	} else if (platform === "darwin") {
		seg = `Macintosh; ${arch === "arm64" ? "ARM" : "Intel"} Mac OS X 10_15_7`;
	} else if (platform === "linux") {
		seg = `X11; Linux ${arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch}`;
	} else {
		seg = platform;
	}
	return `gtrk-cli/${version} (${seg})`.replace(/node/gi, "");
}

function osName(platform: string): string {
	if (platform === "win32") return "windows";
	if (platform === "darwin") return "macos";
	if (platform === "linux") return "linux";
	return "other";
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

/** Umami `/api/send` 原样格式。 */
export interface UmamiBody {
	type: "event";
	payload: {
		website: string;
		hostname: string;
		url: string;
		language?: string;
		name?: string;
		data?: Record<string, PropValue>;
		/** 秒。补发时看板按发生时刻算。 */
		timestamp: number;
	};
}

export interface QueueItem {
	at: number;
	/** 发送时用的 UA（组装时就定下，补发不随新版本漂移）。 */
	ua: string;
	body: UmamiBody;
}

function hasApiKey(env: Env): boolean {
	try {
		return !!((env.GITRUCK_API_KEY ?? "").trim() || (readConfig().apiKey ?? "").trim());
	} catch {
		return false;
	}
}

/**
 * 父进程只从环境变量取语言（零开销）。取不到就留空，由发送进程用 `Intl` 补
 * （apply 实测：`Intl` 首次调用约 15 ms，Windows 上 `LANG` 通常没设，放在父进程就是每条命令都付一次）。
 */
function language(env: Env): string | undefined {
	const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
	const m = /^([a-z]{2})[_-]([A-Za-z]{2})/.exec(raw);
	return m ? `${m[1]}-${m[2].toUpperCase()}` : undefined;
}

/** 发送进程里补语言：`zh-Hans-HK` 这类取「语言-地区」两段。 */
function intlLanguage(): string | undefined {
	try {
		const loc = Intl.DateTimeFormat().resolvedOptions().locale || "";
		const parts = loc.split("-");
		const lang = parts[0];
		const region = parts.slice(1).find((x) => /^[A-Z]{2}$/.test(x));
		return lang && /^[a-z]{2,3}$/.test(lang) ? (region ? `${lang}-${region}` : lang) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 一条命令的两条记录：页面访问（命令热度）+ `command_run`（成败与耗时）。
 * 为什么要页面访问：Umami 的「页面」排行只统计页面访问，带 url 的事件不计入（design D3 实测）。
 */
export function buildCommandItems(input: {
	path: string[];
	startedAt: number;
	endedAt: number;
	result: "ok" | "fail";
	errorCode?: string;
}): QueueItem[] {
	const d = io();
	const env = d.env();
	const p = d.platform();
	const version = cliVersion();
	const ua = usageUserAgent(version, p.platform, p.arch, p.release);
	const segs = input.path.map((s) => s.trim()).filter((s) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(s));
	const url = segs.length ? `/${segs.join("/")}` : "/";
	const lang = language(env);
	const base = { website: USAGE_WEBSITE_ID, hostname: USAGE_HOSTNAME, url, ...(lang ? { language: lang } : {}) };

	const data: Record<string, PropValue> = {};
	const raw: Record<string, unknown> = {
		command: segs.join(".") || "root",
		result: input.result,
		error_code: input.result === "fail" ? input.errorCode ?? "unknown" : undefined,
		elapsed_bucket: elapsedBucket(input.endedAt - input.startedAt),
		invoker: detectInvoker(env, d.isTTY()),
		cli_version: version,
		os: osName(p.platform),
		arch: p.arch,
		node_major: Number.parseInt(p.node, 10),
		has_api_key: hasApiKey(env),
	};
	for (const k of [...COMMAND_RUN_PROPS, ...COMMON_PROP_KEYS]) {
		const v = cleanValue(raw[k]);
		if (v !== undefined) data[k] = v;
	}
	return [
		{ at: input.startedAt, ua, body: { type: "event", payload: { ...base, timestamp: Math.floor(input.startedAt / 1000) } } },
		{
			at: input.endedAt,
			ua,
			body: { type: "event", payload: { ...base, name: "command_run", data, timestamp: Math.floor(input.endedAt / 1000) } },
		},
	];
}

// ---------------------------------------------------------------------------
// 本机队列
// ---------------------------------------------------------------------------

function queuePath(): string {
	return join(io().home(), QUEUE_FILE);
}

/** 同步追加（单行小写入，多个 gtrk 进程并发追加不会交错成半行）。绝不抛。 */
export function enqueue(items: QueueItem[]): void {
	if (!items.length) return;
	try {
		mkdirSync(io().home(), { recursive: true });
		appendFileSync(queuePath(), items.map((x) => JSON.stringify(x)).join("\n") + "\n");
	} catch {
		/* 写不进去就算了：统计可以丢，命令不能受影响 */
	}
}

function parseLines(text: string, now: number): QueueItem[] {
	const out: QueueItem[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const x = JSON.parse(line) as QueueItem;
			if (typeof x?.at === "number" && x.body?.payload && typeof x.ua === "string" && now - x.at <= QUEUE_TTL_MS) out.push(x);
		} catch {
			/* 坏行跳过 */
		}
	}
	return out;
}

/** 读当前队列（只读，不认领）。给单测与 doctor 用。 */
export function readUsageQueue(): QueueItem[] {
	try {
		const p = queuePath();
		return existsSync(p) ? parseLines(readFileSync(p, "utf8"), io().now()) : [];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// 命令生命周期（src/index.ts 接线）
// ---------------------------------------------------------------------------

let current: { path: string[]; startedAt: number; recorded: boolean } | null = null;

/** 仅供单测。 */
export function resetUsageAnalyticsState(): void {
	current = null;
	noticedInThisProcess = false;
	configSnapshot = null;
	versionCache = null;
}

/** `preAction`：记命令路径与起点。闸不开也记（结束时再判），开销只是一个对象。 */
export function beginCommand(path: string[]): void {
	try {
		current = { path, startedAt: io().now(), recorded: false };
	} catch {
		/* 绝不抛 */
	}
}

/**
 * 命令结束（`postAction` 或顶层出口）：同步写队列，再起发送子进程。同一条命令只记一次。
 * 结果判定：抛出 ⇒ fail；`exitCode` 非零 ⇒ fail；否则 ok。
 */
export function finishCommand(outcome: { error?: unknown; exitCode?: number | string | null }): void {
	try {
		if (!current || current.recorded) return;
		current.recorded = true;
		withConfigSnapshot(() => finishCommandInner(outcome));
	} catch {
		/* 绝不抛 */
	}
}

function finishCommandInner(outcome: { error?: unknown; exitCode?: number | string | null }): void {
	try {
		if (!current || !usageGatesOpen()) return;
		const code = Number(outcome.exitCode ?? 0);
		const failed = outcome.error !== undefined || (Number.isFinite(code) && code !== 0);
		const errorCode = outcome.error !== undefined ? errorCodeOf(outcome.error) : failed ? `exit_${code}` : undefined;
		enqueue(
			buildCommandItems({ path: current.path, startedAt: current.startedAt, endedAt: io().now(), result: failed ? "fail" : "ok", errorCode }),
		);
		spawnFlusher();
	} catch {
		/* 绝不抛 */
	}
}

/**
 * `process.on("exit")` 兜底：绕过 postAction 与顶层出口的路径（如 `prompt.ts` 的 `process.exit(130)`）。
 * 只能同步——写队列、不起子进程，下次再发。
 */
export function finishOnExit(code: number): void {
	try {
		if (!current || current.recorded) return;
		current.recorded = true;
		withConfigSnapshot(() => finishOnExitInner(code));
	} catch {
		/* 绝不抛 */
	}
}

function finishOnExitInner(code: number): void {
	try {
		if (!current || !usageGatesOpen()) return;
		enqueue(
			buildCommandItems({
				path: current.path,
				startedAt: current.startedAt,
				endedAt: io().now(),
				result: code === 0 ? "ok" : "fail",
				errorCode: code === 130 ? "SIGINT" : code === 0 ? undefined : `exit_${code}`,
			}),
		);
	} catch {
		/* 绝不抛 */
	}
}

function lockFresh(): boolean {
	try {
		const st = statSync(join(io().home(), LOCK_FILE));
		return io().now() - st.mtimeMs < LOCK_STALE_MS;
	} catch {
		return false;
	}
}

/** 距上一次发送进程结束不到 {@link FLUSH_MIN_INTERVAL_MS}，且队列还不大。 */
function flushedRecently(): boolean {
	try {
		const home = io().home();
		const last = statSync(join(home, LAST_FLUSH_FILE)).mtimeMs;
		if (io().now() - last >= FLUSH_MIN_INTERVAL_MS) return false;
		try {
			return statSync(join(home, QUEUE_FILE)).size < FLUSH_FORCE_BYTES;
		} catch {
			return true;
		}
	} catch {
		return false; // 从没发过
	}
}

/**
 * 起一个脱离父进程的发送进程；父进程不等它。不起的情形（事件留在队列，由后面的进程带走）：
 * 已有新鲜的锁；或上一次发送不到 30 秒且队列不大（限频，见 {@link FLUSH_MIN_INTERVAL_MS}）。
 */
export function spawnFlusher(): void {
	try {
		if (lockFresh() || flushedRecently()) return;
		const d = io();
		const entry = d.entry();
		if (!entry) return;
		const child = d.spawn(process.execPath, [entry, FLUSH_COMMAND], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		/* 沙箱禁止 spawn 等：事件留在队列，无害 */
	}
}

// ---------------------------------------------------------------------------
// 发送进程（`gtrk __usage-flush`）
// ---------------------------------------------------------------------------

type SendOutcome = "sent" | "drop" | "retry";

async function sendOne(item: QueueItem): Promise<SendOutcome> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await io().fetch(USAGE_COLLECT_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", "User-Agent": item.ua },
			body: JSON.stringify(item.body),
			signal: ctl.signal,
		});
		if (res.ok) return "sent";
		if (res.status === 429 || res.status >= 500) return "retry";
		return "drop";
	} catch {
		return "retry";
	} finally {
		clearTimeout(timer);
	}
}

function acquireLock(): number | null {
	const p = join(io().home(), LOCK_FILE);
	for (let i = 0; i < 2; i++) {
		try {
			const fd = openSync(p, "wx");
			writeSync(fd, String(io().pid()));
			return fd;
		} catch {
			if (lockFresh()) return null;
			try {
				rmSync(p, { force: true }); // 陈旧锁：上一个发送进程已经没了
			} catch {
				return null;
			}
		}
	}
	return null;
}

function releaseLock(fd: number): void {
	try {
		closeSync(fd);
	} catch {
		/* ignore */
	}
	try {
		rmSync(join(io().home(), LOCK_FILE), { force: true });
	} catch {
		/* ignore */
	}
}

/** 把超过 {@link SENDING_STALE_MS} 的认领文件（上次中断）并回队列。 */
function reclaimStale(): void {
	const home = io().home();
	const now = io().now();
	for (const f of readdirSync(home)) {
		if (!/^usage-queue\.\d+\.sending$/.test(f)) continue;
		const p = join(home, f);
		try {
			if (now - statSync(p).mtimeMs < SENDING_STALE_MS) continue;
			enqueue(parseLines(readFileSync(p, "utf8"), now));
			rmSync(p, { force: true });
		} catch {
			/* ignore */
		}
	}
}

/**
 * 发送进程主体。认领（rename）→ 过期与上限裁剪 → 顺序发，最多 {@link FLUSH_BATCH} 条、
 * 总时长 ≤ {@link FLUSH_BUDGET_MS} → 没发完的、失败的追加回队列。绝不抛。
 */
export async function runUsageFlush(): Promise<{ sent: number; requeued: number }> {
	const result = { sent: 0, requeued: 0 };
	try {
		if (!usageGatesOpen()) {
			if (usageSwitchState() !== "on") clearUsageQueue();
			return result;
		}
		const d = io();
		const home = d.home();
		if (!existsSync(home)) return result;
		const fd = acquireLock();
		if (fd === null) return result;
		const claimed = join(home, `usage-queue.${d.pid()}.sending`);
		try {
			reclaimStale();
			try {
				renameSync(queuePath(), claimed);
			} catch {
				return result; // 没有队列
			}
			const started = d.now();
			const items = parseLines(readFileSync(claimed, "utf8"), started)
				.sort((a, b) => a.at - b.at)
				.slice(-QUEUE_MAX);
			const fallbackLang = intlLanguage();
			let i = 0;
			for (; i < items.length && i < FLUSH_BATCH; i++) {
				if (d.now() - started > FLUSH_BUDGET_MS) break;
				if (!items[i].body.payload.language && fallbackLang) items[i].body.payload.language = fallbackLang;
				const r = await sendOne(items[i]);
				if (r === "retry") break;
				if (r === "sent") result.sent++;
			}
			const rest = items.slice(i);
			result.requeued = rest.length;
			enqueue(rest);
			rmSync(claimed, { force: true });
		} finally {
			markFlushed();
			releaseLock(fd);
		}
	} catch {
		/* 绝不抛 */
	}
	return result;
}

/** 记下「刚发过一轮」（成败都记：断网时同样限频，不会每条命令起一个进程去撞）。 */
function markFlushed(): void {
	try {
		const p = join(io().home(), LAST_FLUSH_FILE);
		writeFileSync(p, String(io().now()));
		const t = io().now() / 1000;
		utimesSync(p, t, t);
	} catch {
		/* ignore */
	}
}
