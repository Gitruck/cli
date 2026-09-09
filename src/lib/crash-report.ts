/**
 * CLI 崩溃自动上报（change `link-client-error-report-cli`）。
 *
 * 上游契约正本：gitruck-infra `openspec/changes/add-client-error-report/`
 * （`POST /error/report`；字段集 / 长度上限 / `source` 值域 / `occurrence_count` 语义
 * **全部由主件钉死**）。⚠️ 契约疑问 MUST 回主件提，MUST NOT 在本仓自裁（SOP §A.7.2 第 5 条）。
 * 姊妹件：`gitruck-opencut-rewrite/link-client-error-report-client`（客户端半，同一判据两处实现）。
 *
 * ## 服务端字段对表（2026-09-10 逐字核 `biz/gitruck_cloud/public/api/error_report.py`）
 *
 * | 字段 | 约束 | 本模块 |
 * |---|---|---|
 * | `error_msg` | 必填，**> 2000 字符直接 400，不截断** | 端侧先 {@link capText} 到 2000 |
 * | `error_stack` | 可选，**> 20000 字符直接 400，不截断** | 端侧先 {@link capText} 到 20000 |
 * | `source` | 枚举 `cli` / `client`（**没有 `server` 档，且永远不会开**） | 恒 `"cli"` |
 * | `app_code` | ≤ 32，**服务端截断不拒绝** | 恒 `"gtrk-cli"` |
 * | `reporter_version` | ≤ 32，服务端截断 | `currentVersion()` |
 * | `device_id` | ≤ 32，可选 | **不传**（CLI 无设备标识概念，spec 明令载荷 MUST NOT 带设备标识） |
 * | `occurrence_count` | 缺省 1；**「传 1 了事就是真丢数据」（服务端 docstring 原话）** | 本窗口累计值 |
 * | `error_code` | int 可选 | 不传（服务端缺省落 `INTERNAL_ERROR`） |
 * | `task_id` | int 可选 | 有 {@link setCrashContext} 上下文时才传 |
 *
 * 鉴权硬要求（`@require_auth`）：无 Key ⇒ 401。⇒ 本模块**无 Key 时零请求**，
 * 且**不打印任何鉴权类报错**——崩溃已经够糟了，不该再叠一条「你没配 Key」的噪声。
 *
 * ## ⚠️ 与摩擦通道（`gtrk feedback`）的告知口径**刻意不同**，MUST NOT 照抄
 *
 * - 摩擦：**每条都要用户点头**（`--disclosed`；非 TTY 未声明就拒绝上报）。
 *   因为那是**用户自撰文本**，agent 代提时必须先念给用户听，念的和入库的必须是同一份。
 * - 崩溃：**一次性告知 + 默认开 + 常驻开关**。
 *   因为崩溃发生时**没有人可以告知**——进程已经在倒地了。
 *   换成「每次点头」等于永远收不到崩溃报告；换成「静默永久开」则答不出
 *   B 端客户那句必答题「你的软件背着我发了什么」。一次告知 + 可关，两头都站得住。
 *   （服务端 `error_report.py` 头注释是这段口径的正本。）
 *
 * ## 三条硬约束
 *
 * ① **绝不抛**。本模块任何导出函数在任何分支都 MUST NOT 向调用方抛出——
 *    它挂在崩溃路径上，自己再炸一次就把用户唯一的线索也弄丢了。
 * ② **呈现先于上报**。调用方 MUST 先把原始错误打给用户，再 `await` 本模块。
 * ③ **不重试、不落盘队列**。CLI 进程短命，重试只会把退出拖得更久；
 *    跨进程节流的收益也小——服务端 L1 已按哈希 upsert 压行。
 */
import { createHash } from "node:crypto";
import { loadConfig as realLoadConfig } from "./config";
import { readUserConfig as realReadUserConfig, writeUserConfig as realWriteUserConfig, type UserConfig } from "./user-config";
import { currentVersion } from "./version";

// ---------------------------------------------------------------------------
// 常量（服务端契约 + 产品数字）
// ---------------------------------------------------------------------------

/** 上游写口。⚠️ 拼在 `loadConfig().base` 之后。 */
export const CRASH_REPORT_PATH = "/error/report";
/** `source` 值域里 CLI 那一档。服务端 `CLIENT_SOURCES = ('cli', 'client')`。 */
export const CRASH_SOURCE = "cli";
/** `app_code`。与客户端半的 `opencut` 并列，便于按端分桶。 */
export const CRASH_APP_CODE = "gtrk-cli";
/** 服务端 `ERROR_MSG_MAX_CHARS`。 */
export const ERROR_MSG_MAX_CHARS = 2000;
/** 服务端 `ERROR_STACK_MAX_CHARS`。 */
export const ERROR_STACK_MAX_CHARS = 20000;
/** 硬超时。崩溃路径上多等一秒都是用户在等，2 s 到点就走。 */
export const CRASH_TIMEOUT_MS = 2000;
/** 节流窗口。 */
export const THROTTLE_WINDOW_MS = 60_000;
/** 告知留痕版本。文案实质变更时 bump 一次，老用户被重新告知一次。 */
export const CRASH_NOTICE_VERSION = "crash-report-v1";
/** 关闭开关的环境变量名。 */
export const CRASH_REPORT_ENV = "GITRUCK_CRASH_REPORT";

/**
 * 合并突发的时间片。
 *
 * ⚠️ **不是延迟，是正确性所需**：spec 要求「60 次崩溃 ⇒ 一次请求且 `occurrence_count=60`」。
 * 一轮同步爆发（`for` 里连抛 60 次 / 一批 `unhandledRejection` 微任务）里，
 * 若第一次就立刻发网络请求，它只能带 `1`，剩下 59 次要么再发 59 个请求、要么被丢掉
 * ——后者正是服务端 docstring 骂的「传 1 了事就是真丢数据」。
 * 让**认领发送的那一次**先跨过一个宏任务边界，同步爆发就已经全部计完数了。
 */
export const COALESCE_MS = 0;

// ---------------------------------------------------------------------------
// 注入面
// ---------------------------------------------------------------------------

/**
 * 单测注入旋钮（形制同 `compliance-notice.ts` 的 deps 参数、`friction-report` 的 `__…Io`）。
 * **生产恒 `null`**，走真实现。
 */
export const __crashReportIo: {
	impl: null | {
		fetch: typeof fetch;
		/** 缺 Key 时 MUST 抛（与 `loadConfig` 同语义）——本模块据此判「无 Key」。 */
		loadConfig: () => { base: string; apiKey: string };
		readUserConfig: () => UserConfig;
		writeUserConfig: (patch: UserConfig) => void;
		now: () => number;
		stderr: (chunk: string) => void;
		version?: () => string;
		/** 覆盖开关环境变量的读取（缺省读 `process.env`）。 */
		env?: (name: string) => string | undefined;
	};
} = { impl: null };

function io() {
	return (
		__crashReportIo.impl ?? {
			fetch,
			loadConfig: realLoadConfig,
			readUserConfig: realReadUserConfig,
			writeUserConfig: realWriteUserConfig,
			now: () => Date.now(),
			stderr: (chunk: string) => void process.stderr.write(chunk),
			version: currentVersion,
			env: (name: string) => process.env[name],
		}
	);
}

// ---------------------------------------------------------------------------
// D1 · 崩溃判据（单一函数；MUST NOT 由各命令自行判定）
// ---------------------------------------------------------------------------

/** 捕获入口。`toplevel` 是 `src/index.ts` 的 `parseAsync().catch`。 */
export type CrashKind = "uncaught" | "unhandledRejection" | "toplevel";

/** 引擎抛的错误类型 = 程序缺陷。用构造器名判而不是 `instanceof`：跨 realm / 跨 bundle 稳。 */
const ENGINE_ERROR_NAMES = new Set([
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
]);

/** Node 系统错误码形态（`ENOENT` / `EACCES` / `ECONNRESET`…）。 */
const SYS_CODE_RE = /^E[A-Z0-9]+$/;

/**
 * 什么算「崩溃」—— **机械判据，不靠人工标注**（design D1）。
 *
 * - `uncaught` / `unhandledRejection`：**恒为崩溃**（没人接住 = 谁都没预料到）。
 * - `toplevel`：是崩溃**当且仅当** ①引擎抛的错误类型、②带 `E***` 系统码、③抛的不是 `Error`。
 *
 * **不报的三类**（本仓约定的「预期内失败」）：`CloudError`（服务端已记）、
 * commander 的 `CommanderError`（用法错）、带人话文案的普通 `Error`（如「缺 API Key」）。
 *
 * ⚠️ **已知盲区**：程序缺陷被写成 `throw new Error("xxx")` ⇒ 漏报。**这是取舍不是遗漏**：
 * 漏报的代价是「少一条」，误报的代价是「多一百条噪声淹掉真信号」。
 * 观察窗内若发现某类高频漏报，在此加一条**具名**判据，MUST NOT 放宽整体。
 */
export function isCrash(e: unknown, kind: CrashKind): boolean {
	if (kind !== "toplevel") return true;
	if (!(e instanceof Error)) return true; // 抛了个非 Error：本身就是缺陷
	if (ENGINE_ERROR_NAMES.has(e.name)) return true;
	const code = (e as { code?: unknown }).code;
	return typeof code === "string" && SYS_CODE_RE.test(code);
}

// ---------------------------------------------------------------------------
// D4 · 凭据抹除 / D5 · 可见截断
// ---------------------------------------------------------------------------

/** 抹除后的占位符。 */
export const KEY_PLACEHOLDER = "<KEY>";

/** 平台 Key 的字面形态。 */
const GC_TOKEN_RE = /gc_[A-Za-z0-9]{16,}/g;
/** `Authorization: <值>` 头（日志/栈里常见）。 */
const AUTH_HEADER_RE = /(authorization"?\s*[:=]\s*"?)([^"\s,}]+)/gi;

/** 正则元字符转义（把凭据字面值当字面量匹配）。 */
function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 只抹凭据，**不做其他脱敏**（design D4）。
 *
 * 路径 / 数字 / UUID 的归一化在**服务端**（主件 D3，且只作用于哈希）。
 * 端侧再做一份就是第二份判据，必与服务端漂移——`link-friction-telemetry-client` 同一论证。
 *
 * ⚠️ 与 CLI 摩擦上报「做本地脱敏」的差异：摩擦要**念给用户听**，念的和入库的必须同一份；
 * 崩溃没有回显环节，所以只需保证「凭据不出机」这一条。
 */
export function scrubCredentials(text: string, secrets: readonly (string | undefined)[] = []): string {
	if (!text) return text;
	let out = text;
	for (const s of secrets) {
		// 太短的「凭据」当噪声跳过：否则一个两字符的值会把全文打成 <KEY>
		if (typeof s === "string" && s.trim().length >= 8) {
			out = out.replace(new RegExp(escapeRe(s.trim()), "g"), KEY_PLACEHOLDER);
		}
	}
	out = out.replace(GC_TOKEN_RE, KEY_PLACEHOLDER);
	out = out.replace(AUTH_HEADER_RE, (_m, head: string) => `${head}${KEY_PLACEHOLDER}`);
	return out;
}

/**
 * 超长时**保头砍尾**并留可见标记（design D5）。
 *
 * 服务端对超长**拒绝不截断**，理由是「截断过的栈看起来完整、可能少了根因帧」。
 * 端侧原样发就是白发一次 400。处置：JS 栈的根因帧在**顶部** ⇒ 保头不丢根因；
 * 且截断**可见** ⇒ 服务端担心的「看起来完整」不再成立。
 */
export function capText(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = text.slice(0, Math.max(0, max - 100));
	return `${head}\n…[truncated by gtrk-cli, original length ${text.length}]`;
}

// ---------------------------------------------------------------------------
// D3 · 节流键与 occurrence_count
// ---------------------------------------------------------------------------

interface Bucket {
	/** 尚未随任何请求上报出去的累计次数。 */
	pending: number;
	/** 上一次真发请求的时刻；0 = 从未发过。 */
	lastSentAt: number;
	/** 本窗口已有人认领发送（正在跨合并时间片）。 */
	claimed: boolean;
}

const buckets = new Map<string, Bucket>();

/** 仅供单测：清空进程内节流状态与上下文（生产代码不该调）。 */
export function resetCrashReportState(): void {
	buckets.clear();
	crashContext = {};
	installed = false;
	noticedInThisProcess = false;
}

/**
 * 节流键 = `sha256(name + "\n" + 首个栈帧)`。
 *
 * ⚠️ 用**栈帧**而非消息做键：消息里常带可变数字（`任务 1234 超时`），
 * 每条都是新键 ⇒ 节流形同虚设（主件 D3 记过的病灶）。栈帧对同一处缺陷稳定。
 */
export function throttleKey(e: unknown): string {
	const name = e instanceof Error ? e.name : typeof e;
	const stack = e instanceof Error && typeof e.stack === "string" ? e.stack : "";
	let frame = "";
	for (const raw of stack.split("\n")) {
		const line = raw.trim();
		if (!line.startsWith("at ")) continue;
		if (line.includes("crash-report")) continue; // 本模块自己的帧不参与派生
		frame = line;
		break;
	}
	return createHash("sha256").update(`${name}\n${frame}`).digest("hex");
}

// ---------------------------------------------------------------------------
// D6 · task_id 上下文
// ---------------------------------------------------------------------------

let crashContext: { taskId?: string } = {};

/**
 * 登记「当前正在处理哪个云端任务」。**唯一接入点是 `cloud.ts` 的 `submitTask()` 成功分支**
 * （design D6）——它是所有云端任务命令的漏斗，一处接就全覆盖。
 * 缺省不传 `task_id`，服务端落 0，与其既有口径一致。
 */
export function setCrashContext(ctx: { taskId?: string }): void {
	crashContext = { ...crashContext, ...ctx };
}

// ---------------------------------------------------------------------------
// D7 · 告知与开关
// ---------------------------------------------------------------------------

/**
 * 告知行。**恰好一行**——本 CLI 的主要使用者是 agent，多余输出实打实污染其上下文
 * （与 `compliance-notice` 的「≤3 行」同一条纪律）。
 */
export const CRASH_NOTICE_LINE =
	`🛟  崩溃自动上报已开启：仅上传错误消息与堆栈（不含素材、工程内容与凭据）。` +
	`关闭：gtrk init --no-crash-report，或设 ${CRASH_REPORT_ENV}=0`;

/**
 * 已关闭时的告知行。
 * ⚠️ **关掉了也要告知一次**：用户需要知道「这个功能存在、现在是关的、怎么再打开」——
 * 只在开着时才说，等于把「我关掉了什么」这件事藏起来。
 */
export const CRASH_NOTICE_LINE_OFF =
	`🛟  崩溃自动上报已关闭（本机不会发送任何崩溃报告）。` +
	`重新开启：删掉配置里的 crashReport 或设 ${CRASH_REPORT_ENV}=1`;

let noticedInThisProcess = false;

/**
 * 幂等告知：挂在**既有告知点之后**（`gtrk init` 成功路径、云端内容出口的 `noticeOnce()` 之后）。
 * 不新增「会打印的时刻」⇒ 纯本地命令零告知的既有条款不受影响。
 *
 * 返回是否**本次**打印了。任何异常一律吞掉（告知失败 ≠ 命令失败）。
 *
 * @param opts.force 无视留痕强制打印一次。**只给 `gtrk init --no-crash-report` 用**：
 *   用户刚显式改了开关状态，必须当场得到一句确认，否则命令看起来什么也没干。
 *   常规漏斗 MUST NOT 传 —— 传了就是每条命令复读，正是「一次性告知」要避免的。
 */
export function crashReportNoticeOnce(opts: { force?: boolean } = {}): boolean {
	const d = io();
	try {
		let recorded: string | undefined;
		try {
			recorded = d.readUserConfig().crashReportNoticeVersion;
		} catch {
			recorded = undefined; // 读不出 = 视为未留痕（重新告知一次）
		}
		if (!opts.force) {
			if (recorded === CRASH_NOTICE_VERSION) return false;
			if (noticedInThisProcess) return false;
		}

		// 文案按**当下的开关状态**选：`gtrk init --no-crash-report` 会先写下 `crashReport:false`
		// 再走到这里，于是用户读到的是「已关闭」而不是一句与事实相反的「已开启」。
		const line = crashSwitchState() === "on" ? CRASH_NOTICE_LINE : CRASH_NOTICE_LINE_OFF;
		d.stderr(`\x1b[2m${line}\x1b[0m\n`);
		noticedInThisProcess = true;

		try {
			d.writeUserConfig({ crashReportNoticeVersion: CRASH_NOTICE_VERSION });
		} catch {
			// 良性降级：告知的目的是「用户看见」，看见已经发生；落痕失败不阻断、不抛天书。
			// ⚠️ 代价诚实登记：留痕没写上 ⇒ 下次会再告知一次，**且这期间不上报**（未告知不上报）。
		}
		return true;
	} catch {
		return false; // 绝不抛（硬约束①）
	}
}

/** 开关三态，供 `gtrk doctor` 如实呈现。 */
export type CrashSwitchState = "on" | "off-env" | "off-config";

/**
 * 开关判定：`GITRUCK_CRASH_REPORT=0` **优先于** `config.json` 的 `crashReport`，两者缺省为开。
 * 环境变量优先是本仓惯例（`GITRUCK_API_KEY` / `GITRUCK_API_BASE` 同）：
 * 临时关一次不该要求改配置文件。
 */
export function crashSwitchState(): CrashSwitchState {
	const d = io();
	const env = (d.env ?? ((n: string) => process.env[n]))(CRASH_REPORT_ENV);
	if (env != null && env.trim() === "0") return "off-env";
	try {
		if (d.readUserConfig().crashReport === false) return "off-config";
	} catch {
		/* 配置读不出 = 不当作关闭（缺省为开） */
	}
	return "on";
}

// ---------------------------------------------------------------------------
// 上报
// ---------------------------------------------------------------------------

/** 上报结果。**只用于测试与自省**，调用方不该据此改变任何用户可见行为。 */
export type CrashReportResult =
	| "sent"
	| "not-a-crash"
	| "off"
	| "unnotified"
	| "auth"
	| "throttled"
	| "unreachable"
	| "rejected"
	| "internal-error";

/** 服务端接受的字段全集。载荷 key 集合 MUST ⊆ 本集合（`test/crash-report.test.mjs` 守卫）。 */
export const SERVER_PAYLOAD_KEYS = [
	"error_msg",
	"error_stack",
	"source",
	"app_code",
	"reporter_version",
	"device_id",
	"occurrence_count",
	"error_code",
	"task_id",
] as const;

function sleep(ms: number): Promise<void> {
	return new Promise((r) => void setTimeout(r, ms));
}

/**
 * 上报一次崩溃。**任何分支都不抛**（硬约束①）。
 *
 * 顺序：判据 → 开关 → 告知痕迹 → 凭据 → 节流认领 → 合并时间片 → 组装 → 发送（2 s 硬超时）。
 * ⚠️ 「开关 / 告知痕迹 / 无 Key」三道闸都在**任何网络动作之前**，且都零输出——
 * 崩溃时刻用户已经在看一个报错了，不该再叠一条上报器的絮叨。
 */
export async function reportCrash(e: unknown, opts: { kind: CrashKind }): Promise<CrashReportResult> {
	try {
		if (!isCrash(e, opts.kind)) return "not-a-crash";
		if (crashSwitchState() !== "on") return "off";

		const d = io();

		// 未告知不上报（design D7）：宁可漏掉「从未 init 过」的用户的崩溃
		// （他们没 Key 本来也发不出），也不让「先发后说」在任何时序下发生。
		let notified = false;
		try {
			notified = d.readUserConfig().crashReportNoticeVersion === CRASH_NOTICE_VERSION;
		} catch {
			notified = false;
		}
		if (!notified) return "unnotified";

		// 无 Key ⇒ 零请求、零鉴权报错（spec「缺 API Key」场景）
		let cfg: { base: string; apiKey: string };
		try {
			cfg = d.loadConfig();
		} catch {
			return "auth";
		}
		if (!cfg.apiKey) return "auth";

		// ── 节流：同步计数，认领者跨一个宏任务边界后再发（见 COALESCE_MS 注释）
		const key = throttleKey(e);
		const now = d.now();
		const b = buckets.get(key) ?? { pending: 0, lastSentAt: 0, claimed: false };
		b.pending += 1;
		buckets.set(key, b);
		const windowOpen = b.lastSentAt !== 0 && now - b.lastSentAt < THROTTLE_WINDOW_MS;
		if (windowOpen || b.claimed) return "throttled";
		b.claimed = true;

		await sleep(COALESCE_MS);

		const occurrenceCount = b.pending;
		b.pending = 0;
		b.lastSentAt = d.now();
		b.claimed = false;

		// ── 组装。⚠️ key 集合 MUST ⊆ SERVER_PAYLOAD_KEYS；
		//    MUST NOT 塞任何本地留痕 / 开关字段（termsNoticeVersion / crashReport / …）、
		//    设备标识、主机名、环境变量、工程内容。
		const secrets = [cfg.apiKey, (d.env ?? ((n: string) => process.env[n]))("GITRUCK_API_KEY")];
		const name = e instanceof Error ? e.name : "NonError";
		const rawMsg = e instanceof Error ? e.message : String(e);
		const rawStack = e instanceof Error && typeof e.stack === "string" ? e.stack : "";

		const payload: Record<string, unknown> = {
			error_msg: capText(scrubCredentials(`${name}: ${rawMsg}`, secrets), ERROR_MSG_MAX_CHARS),
			error_stack: capText(scrubCredentials(rawStack, secrets), ERROR_STACK_MAX_CHARS),
			source: CRASH_SOURCE,
			app_code: CRASH_APP_CODE,
			reporter_version: (d.version ?? currentVersion)(),
			occurrence_count: occurrenceCount,
		};
		const taskId = Number(crashContext.taskId);
		if (Number.isFinite(taskId) && taskId > 0) payload.task_id = taskId;

		const body = JSON.stringify(payload); // 序列化抛 ⇒ 落到外层 catch，被吞掉

		// ── 发送。2 s 硬超时用 `unref()` 的定时器：**MUST NOT 拖住事件循环**，
		//    race 输了也照样让调用方去 exit。不重试（硬约束③）。
		const timer = setTimeout(() => {}, CRASH_TIMEOUT_MS);
		timer.unref?.();
		let res: Response | "timeout";
		try {
			res = await Promise.race([
				d.fetch(`${cfg.base}${CRASH_REPORT_PATH}`, {
					method: "POST",
					headers: { Authorization: cfg.apiKey, "Content-Type": "application/json" },
					body,
				}),
				sleep(CRASH_TIMEOUT_MS).then(() => "timeout" as const),
			]);
		} catch {
			clearTimeout(timer);
			d.stderr(degradeLine("网络不可达"));
			return "unreachable";
		}
		clearTimeout(timer);

		if (res === "timeout") {
			d.stderr(degradeLine(`超过 ${CRASH_TIMEOUT_MS} ms 未响应`));
			return "unreachable";
		}
		if (!res.ok) {
			d.stderr(degradeLine(`服务端 HTTP ${res.status}`));
			return "rejected";
		}
		return "sent";
	} catch {
		// 硬约束①：上报器内部任何异常（含序列化失败）都被吞掉。
		// 原始崩溃信息由调用方在**本函数之前**已经呈现给用户，不受影响。
		return "internal-error";
	}
}

/**
 * 良性降级一行（`benign-degradation` 口径：已知根因就打人话，别抛上游天书）。
 * ⚠️ 恒 stderr、恒一行、恒不含凭据。
 */
function degradeLine(why: string): string {
	return `\x1b[2m   （崩溃报告未能上报：${why}。不影响本次结果；关闭上报：${CRASH_REPORT_ENV}=0）\x1b[0m\n`;
}

// ---------------------------------------------------------------------------
// 三个入口
// ---------------------------------------------------------------------------

let installed = false;

/**
 * 顶层出口（`src/index.ts` 的 `parseAsync().catch`）的上报侧。
 *
 * ⚠️ **只负责上报，不负责呈现、不负责退出**——那两件仍由 `index.ts` 原样做，
 * 且**呈现 MUST 在本函数之后**（design D2：调用方 `await` 完再 `console.error` 原句）。
 * 本函数恒 resolve，最长 {@link CRASH_TIMEOUT_MS}。
 */
export async function handleTopLevelError(e: unknown): Promise<void> {
	try {
		await Promise.race([reportCrash(e, { kind: "toplevel" }), sleep(CRASH_TIMEOUT_MS)]);
	} catch {
		/* 绝不抛 */
	}
}

/**
 * 装进程级钩子（uncaught / unhandledRejection）。**幂等**。
 *
 * ⚠️ `process.on("uncaughtException")` 在全仓**只允许出现在本文件**
 * （`test/crash-report.test.mjs` 源码级守卫）——多处装钩子等于多套退出语义。
 */
export function installCrashHooks(): void {
	if (installed) return;
	installed = true;

	process.on("uncaughtException", (err) => {
		void finishAndExit(err, "uncaught");
	});
	process.on("unhandledRejection", (reason) => {
		const err =
			reason instanceof Error
				? reason
				: Object.assign(new Error(String(reason)), { name: "UnhandledRejection" });
		void finishAndExit(err, "unhandledRejection");
	});
}

/**
 * 钩子的共同尾巴：**先呈现、再上报、硬超时后退出**（design D2）。
 *
 * 呈现用 `console.error(err.stack ?? err)`——与 Node 默认的未捕获异常呈现等价；
 * MUST 先于任何上报动作，这样上报器出错也影响不到用户看到的东西。
 */
async function finishAndExit(err: Error, kind: CrashKind): Promise<void> {
	try {
		console.error(err.stack ?? String(err));
	} catch {
		/* 连打印都失败就没救了，继续走退出 */
	}
	try {
		await Promise.race([reportCrash(err, { kind }), sleep(CRASH_TIMEOUT_MS)]);
	} catch {
		/* 绝不抛 */
	}
	process.exit(1);
}
