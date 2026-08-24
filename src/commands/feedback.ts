/**
 * `gtrk feedback` —— 用户摩擦上报（change link-friction-telemetry-cli）。
 *
 * 上游契约正本：gitruck-infra `openspec/changes/add-friction-telemetry/`
 * （`POST /feedback/report`；`migration.sql` 定列与值域）。
 *
 * ## 这个命令与「崩溃上报」是两件事
 *
 * 判据是**主语是谁**：系统抛了异常 → 那是硬报错通道（另一条链路）；
 * **人觉得难受** → 本命令。所以本命令的 `<message>` 是**人写的**，不是栈。
 *
 * ## 告知式提交：本命令唯一真正的产品立场
 *
 * 上游那张表的「告知档」值域**只有两档**（用户亲手提交 / 助手已告知），
 * **没有静默档**——纯静默采集在那条链路上**写不出来**，不是被校验拦住。
 * CLI 侧对应的执行点就是 D2 那道非 TTY 硬门：
 *
 * > **非 TTY + 没有 `--disclosed` ⇒ 拒绝上报、零网络往返、非零退出。**
 *
 * ⚠️ **`-y/--yes` MUST NOT 构成豁免。** 本仓 `-y` 的既有语义是「跳过交互提示」
 * （`init` / `install` / `matrix` 的计费确认都是这个意思），而本件把「告知」
 * 定义为**协议要求**而非交互提示。这条极容易被后来者当成普通确认框顺手加进
 * `-y` 的豁免列表——上游 design D5 专门提醒过，本文件与单测各钉一次。
 *
 * ## 本地脱敏是**镜像**，不是判据
 *
 * 服务端是唯一判据点。本地也做一遍的**唯一**理由是：
 * 如果不做，念给用户听的是原文、入库的是脱敏后——**用户批准的和实际发出的不是同一份**，
 * 「告知式提交」当场破功。与「减轻服务端负担」无关。
 * ⇒ 服务端 400 时 **MUST NOT** 本地绕过或自动改写重发。
 *
 * ## 配置留痕禁区（守卫比审查更锋利）
 *
 * 本文件 **MUST NOT import 用户配置模块**：连拿都拿不到，就不可能塞进上报载荷。
 * 根地址与 Key 的读取封在 `config.ts` 内部（那是鉴权路径，不是上报路径）。
 *
 * 守卫是 `test/feedback.test.mjs` 里的一条**纯 grep**：把那些禁止上报的配置字段名
 * 逐个在本文件源码里搜，要求零命中。禁区清单在测试里，**刻意不抄一份到这里**——
 * 抄过来的话，这段注释自己就会命中那道 grep（初版就这么绊倒过一次）。
 * 那道守卫也刻意**不开**「注释里不算」的豁免口：豁免口一开，
 * 它就从「grep」退化成「审查内容」，而它的锋利恰恰来自不讲道理。
 */
import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { release } from "node:os";
import { CloudError, parseJson } from "../lib/cloud";
import { noticeOnce } from "../lib/compliance-notice";
import { loadConfig, type CloudConfig } from "../lib/config";
import { log, routeLogsToStderr } from "../lib/log";
import { promptConfirm } from "../lib/prompt";
import { currentVersion } from "../lib/version";

// ---------------------------------------------------------------------------
// 值域（逐字对齐上游 DDL 的 ENUM）
// ---------------------------------------------------------------------------

export const CATEGORIES = [
	"complaint",
	"env_unstable",
	"confused",
	"blocked",
	"agent_self_detected",
	"feature_request",
	"other",
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * 类目的中文标签。**全仓单一副本**：回显给人看走这张表，机读面走契约枚举值，
 * 两者互不污染（把枚举值直接念给用户听是英文黑话；把中文标签发给服务端会被值域拒）。
 */
export const CATEGORY_LABELS: Record<Category, string> = {
	complaint: "抱怨吐槽",
	env_unstable: "环境不稳",
	confused: "用法困惑",
	blocked: "使用受阻",
	agent_self_detected: "助手自查",
	feature_request: "功能诉求",
	other: "其他",
};

/** 平台标识 → 念给人听的说法。仅用于回显，**不进载荷**（载荷恒用契约值 win32/darwin/linux）。 */
const PLATFORM_LABELS: Record<string, string> = {
	win32: "Windows",
	darwin: "macOS",
	linux: "Linux",
};

export const SUMMARY_MAX_CHARS = 512;
export const USER_QUOTE_MAX_CHARS = 2000;

// ---------------------------------------------------------------------------
// context 白名单（镜像上游 design D4 第一道表格的 13 个 key）
// ---------------------------------------------------------------------------

interface WhitelistEntry {
	type: "string" | "int";
	pattern?: RegExp;
	min?: number;
	max?: number;
}

/**
 * **13 个 key**，逐个钉死类型与形态 / 值域。不在表内、类型不符、形态不匹配的，
 * 在本地就拒（**MUST NOT 静默丢弃**：静默丢弃会让调用方以为传进去了）。
 *
 * ⚠️ `command` 只收「命令名 + 至多两级子命令」，**含任何参数即拒**——参数里必然带路径。
 * ⚠️ `route` / `webview_version` 是客户端侧的 key，本命令不填，但保留在表里以便
 *    `--context` 的错误提示能列全服务端认得的 key。
 */
export const CONTEXT_WHITELIST: Record<string, WhitelistEntry> = {
	os: { type: "string", pattern: /^(win32|darwin|linux)$/ },
	os_release: { type: "string", pattern: /^[0-9][0-9A-Za-z.\-]{0,31}$/ },
	arch: { type: "string", pattern: /^(x64|arm64|ia32|arm)$/ },
	locale: { type: "string", pattern: /^[a-z]{2}(-[A-Za-z]{2})?$/ },
	command: { type: "string", pattern: /^[a-z][a-z0-9-]{0,31}( [a-z][a-z0-9-]{0,31}){0,2}$/ },
	exit_code: { type: "int", min: -256, max: 256 },
	duration_ms: { type: "int", min: 0, max: 86_400_000 },
	route: { type: "string", pattern: /^[a-z][a-z0-9/_-]{0,63}$/ },
	webview_version: { type: "string", pattern: /^[0-9][0-9A-Za-z.\-]{0,31}$/ },
	task_type: { type: "string", pattern: /^[a-z][a-z0-9_]{0,63}$/ },
	error_code: { type: "int", min: 0, max: 65535 },
	project_id: { type: "string", pattern: /^[0-9a-fA-F-]{8,64}$/ },
	column_key: { type: "string", pattern: /^[a-z][a-z0-9_-]{0,63}$/ },
};

/** `--context` 允许调用方显式传的 key（其余四个由本命令自动填，传了也没意义）。 */
const USER_SETTABLE_KEYS = [
	"exit_code",
	"duration_ms",
	"task_type",
	"error_code",
	"project_id",
	"column_key",
];

// ---------------------------------------------------------------------------
// 脱敏规则（镜像上游 `friction_sanitize.py` 的 REDACTION_RULES）
// ---------------------------------------------------------------------------

/**
 * **有序**规则表：顺序即语义，**先具体后泛化**，逐条对齐服务端那一份。
 *
 * 为什么顺序要紧（三条，都踩过）：
 * 1. 凭据键值对（②）必须在「裸长串」（⑪/⑫）之前——否则 `api_key=9f8e...` 里的值
 *    会先被当成长串替换掉，而「api_key=」这几个字反而留在原文里，像是钥匙名泄漏了。
 * 2. Bearer（①）必须在键值对（②）之前——否则 `Authorization: Bearer eyJ…`
 *    只会被吃掉「Bearer」三个字，真令牌留在原文里。
 * 3. 凭据规则（①-④）必须在路径规则（⑤/⑥）之前，且 ② 的分隔符必需——
 *    路径里出现 `secret` 这类词时，可选分隔符会让凭据规则咬断路径。
 *
 * ⚠️ 规则⑤的 `(?<![A-Za-z])` 不可省：没有它，`https://` 里的 `s:/` 会命中盘符形态，
 * 于是**每一个 URL 都被整条当成路径抹掉**，排障线索全丢。
 * （服务端那边 2026-08-24 由单测抓到过，不是假想。）
 *
 * ⚠️ **已知残留（诚实登记，供 tasks 8.12 的两侧比对）**：Python 的 `\b` / `\w` 按
 * unicode 算，中日韩字符算「词字符」；JS 的 `\w` 只是 `[A-Za-z0-9_]`。
 * 于是 `密码password=1` 这种**中文紧贴英文关键词**的形态，两侧判定会不同
 * （JS 更激进）。规则⑤的字符类已用 `\p{L}\p{N}` 对齐，`\b` 处保留原样。
 * 后果**不是数据泄漏**——服务端仍是唯一判据点，本地更激进只意味着回显更干净。
 */
export const REDACTION_RULES: readonly { re: RegExp; to: string }[] = [
	// ① Bearer 型凭据。⚠️ **MUST 先于键值对规则**：否则 `Authorization: Bearer eyJ…`
	//    会被键值对规则只吃掉「Bearer」三个字，真正的令牌反而留在原文里。
	{ re: /\bbearer\s+\S+/gi, to: "<凭据已隐去>" },
	// ② 凭据键值对（键名 + **必需的**分隔符）
	//
	//    ⚠️⚠️ **分隔符 `[:=]` 是必需的，MUST NOT 退回成 `[:=]?`。**（2026-08-24 修）
	//    可选分隔符时这条规则的形状是「关键词 + 下一个词」，于是它会吃掉用户原话：
	//      「我的 token 用完了」        → 「我的 <凭据已隐去>」
	//      「password 改了之后就登不上」 → 「<凭据已隐去>」（整句消失）
	//      「D:\secret\a.mp4」          → 「D:\<凭据已隐去>」（路径规则再也匹配不上）
	//    而**这条通道的全部价值就是用户原话**。真凭据形态必然带 `:` 或 `=`；
	//    没有分隔符的裸凭据由 ③ 与 ⑫ 兜。
	{
		re: /\b(?:api[_-]?key|secret|token|password|passwd|authorization)\b\s*[:=]\s*\S+/gi,
		to: "<凭据已隐去>",
	},
	// ③ 同合云自家 API Key 的形态：无分隔符也要抹（② 收紧之后的针对性补偿）
	{ re: /\bgc_[A-Za-z0-9_-]{16,}\b/g, to: "<凭据已隐去>" },
	// ④ JWT。⚠️ **不能靠 ⑫ 的「裸 base64 ≥40」兜**：JWT 被 `.` 切成多段，
	//    每段常常短于 40（实测 36 / 27）⇒ 一条规则都命中不了、明文入库。
	{ re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, to: "<凭据已隐去>" },
	// ⑤ Windows 绝对路径 / UNC
	{ re: /(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/g, to: "<路径已隐去>" },
	// ⑥ POSIX 用户目录
	{ re: /(?:~|\/(?:home|Users|root|mnt|media))\/[^\s"'<>|]*/g, to: "<路径已隐去>" },
	// ⑦ URL 的 query 段（保留路径，砍掉 query —— 路径有排障价值，query 常带内容）
	{ re: /(https?:\/\/[^\s"'<>]*?)\?[^\s"'<>]*/g, to: "$1" },
	// ⑧ 邮箱（字符类用 unicode 属性对齐 Python 的 `\w`）
	{ re: /[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+\.[\p{L}\p{N}_.]+/gu, to: "<邮箱已隐去>" },
	// ⑨ 手机号
	{ re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, to: "<手机号已隐去>" },
	// ⑩ 证件号
	{ re: /(?<!\d)\d{17}[\dXx](?!\d)/g, to: "<证件号已隐去>" },
	// ⑪ 裸长十六进制（≥32）
	{ re: /\b[0-9a-fA-F]{32,}\b/g, to: "<凭据已隐去>" },
	// ⑫ 裸 base64 长串（≥40）
	{ re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, to: "<凭据已隐去>" },
];

/**
 * 按 {@link REDACTION_RULES} 的顺序做形态替换。
 *
 * ⚠️ 用**替换**而非拒绝：拒绝会把用户原话整条丢掉，而原话是这条通道最有价值的部分。
 */
export function redactText(text: string | undefined): string | undefined {
	if (text == null) return undefined;
	let out = String(text);
	for (const { re, to } of REDACTION_RULES) {
		re.lastIndex = 0; // 带 g 的正则是有状态的，复用前必须归零
		out = out.replace(re, to);
	}
	return out;
}

// ---------------------------------------------------------------------------
// 载荷构建
// ---------------------------------------------------------------------------

export interface FeedbackPayload {
	event_id: string;
	source: "cli" | "agent";
	category: Category;
	disclosure: "user_submitted" | "agent_disclosed";
	summary: string;
	user_quote?: string;
	context: Record<string, string | number>;
	task_id?: number;
	reporter_version: string;
}

export interface FeedbackOpts {
	command?: string;
	category?: string;
	quote?: string;
	taskId?: string;
	context?: string[];
	disclosed?: boolean;
	yes?: boolean;
	json?: boolean;
}

/** 注入面（仅测试用；生产零注入）。 */
export interface FeedbackDeps {
	cfg?: CloudConfig;
	fetchFn?: typeof fetch;
	/** 判据取 stdout：「载荷要被人看见」这件事发生在输出侧。 */
	isTty?: () => boolean;
	confirm?: (message: string) => Promise<boolean>;
	/** 人读输出通道，缺省 process.stderr。 */
	write?: (chunk: string) => void;
	randomToken?: () => string;
}

/**
 * 解析 `--context k=v`。**非白名单 key ⇒ 拒绝并列出可用 key**。
 *
 * ⚠️ MUST NOT 静默丢弃：静默丢弃会让调用方以为传进去了，
 * 而它其实什么都没上报——那种「以为做了」的失败最难发现。
 */
export function parseContextPairs(pairs: readonly string[] | undefined): {
	context: Record<string, string | number>;
	error?: string;
} {
	const context: Record<string, string | number> = {};
	for (const raw of pairs ?? []) {
		const eq = raw.indexOf("=");
		if (eq <= 0) {
			return { context, error: `--context 需要 k=v 形式，收到「${raw}」` };
		}
		const key = raw.slice(0, eq).trim();
		const value = raw.slice(eq + 1).trim();
		const entry = CONTEXT_WHITELIST[key];
		if (!entry || !USER_SETTABLE_KEYS.includes(key)) {
			return {
				context,
				error: `--context 不认识「${key}」。可用：${USER_SETTABLE_KEYS.join(" / ")}`,
			};
		}
		if (entry.type === "int") {
			if (!/^-?\d+$/.test(value)) {
				return { context, error: `--context ${key} 需要整数，收到「${value}」` };
			}
			const n = Number(value);
			if ((entry.min != null && n < entry.min) || (entry.max != null && n > entry.max)) {
				return { context, error: `--context ${key} 超出取值范围（${entry.min} ~ ${entry.max}）` };
			}
			context[key] = n;
			continue;
		}
		if (entry.pattern && !entry.pattern.test(value)) {
			return { context, error: `--context ${key} 的写法不符合要求，收到「${value}」` };
		}
		context[key] = value;
	}
	return { context };
}

/**
 * 自动采集四个环境 key。
 *
 * ⚠️ **形态不符即剔除，MUST NOT 兜底成 `unknown` / 空串**：兜底值是假信号，
 * 读侧无从区分「没采到」与「采到了就是这个值」。
 * ⚠️ `locale` 可能是 `zh-Hans-CN` 这种三段式 —— 不匹配就整个剔掉，
 * **MUST NOT 自作主张截成 `zh-CN`**（截了就是伪造）。
 */
function collectEnvContext(): Record<string, string> {
	const out: Record<string, string> = {};
	const put = (key: string, value: string) => {
		const entry = CONTEXT_WHITELIST[key];
		if (entry?.pattern?.test(value)) out[key] = value;
	};
	put("os", process.platform);
	put("arch", process.arch);
	put("os_release", release());
	try {
		put("locale", new Intl.DateTimeFormat().resolvedOptions().locale);
	} catch {
		/* 取不到就是没有这一维，不兜底 */
	}
	return out;
}

/**
 * 构建载荷（已脱敏）。返回 `{ payload }` 或 `{ error }`——**校验全部走返回值，零 throw**。
 *
 * ⚠️ 长度校验在**替换之后**做（替换可能变长），且超限 ⇒ 拒绝**不截断**：
 * 截断会把一句话截成误导性的半句。
 */
export function buildFeedbackPayload(
	message: string,
	opts: FeedbackOpts,
	deps: FeedbackDeps = {},
): { payload?: FeedbackPayload; error?: string } {
	const summaryRaw = (message ?? "").trim();
	if (!summaryRaw) return { error: "请把要反馈的内容写清楚（第一个参数）" };

	// ⚠️ `--command` 严格必填，**MUST NOT 兜底填 `feedback`**：
	//    兜底会让读侧无法区分「跑 feedback 时遇到摩擦」与「通过反馈通道报了件与命令无关的事」。
	const command = (opts.command ?? "").trim();
	if (!command) {
		return { error: "请用 --command 说明这条反馈发生在哪个命令上，例如 --command \"matrix search\"" };
	}
	if (!CONTEXT_WHITELIST.command.pattern?.test(command)) {
		return {
			error:
				`--command 只填命令名（可带至多两级子命令），不要带参数。收到「${command}」，` +
				`应写成 --command "matrix search"`,
		};
	}

	const category = (opts.category ?? "other") as Category;
	if (!CATEGORIES.includes(category)) {
		return { error: `--category 只能是：${CATEGORIES.join(" / ")}` };
	}

	const parsed = parseContextPairs(opts.context);
	if (parsed.error) return { error: parsed.error };

	let taskId: number | undefined;
	if (opts.taskId != null && String(opts.taskId).trim() !== "") {
		if (!/^\d+$/.test(String(opts.taskId).trim())) {
			return { error: `--task-id 需要纯数字，收到「${opts.taskId}」` };
		}
		taskId = Number(String(opts.taskId).trim());
	}

	const summary = redactText(summaryRaw) as string;
	// ⚠️ 未传 / 空白 ⇒ **不带该键**（服务端落 NULL），MUST NOT 传空串
	const quoteRaw = opts.quote?.trim();
	const userQuote = quoteRaw ? (redactText(quoteRaw) as string) : undefined;

	if ([...summary].length > SUMMARY_MAX_CHARS) {
		return { error: `反馈内容过长（上限 ${SUMMARY_MAX_CHARS} 字），请精简后重试` };
	}
	if (userQuote && [...userQuote].length > USER_QUOTE_MAX_CHARS) {
		return { error: `--quote 过长（上限 ${USER_QUOTE_MAX_CHARS} 字），请精简后重试` };
	}

	const payload: FeedbackPayload = {
		event_id: (deps.randomToken ?? (() => randomUUID().replace(/-/g, "")))(),
		// 一个旋钮定两件事：`--disclosed` ⇒ 助手代提 + 已告知。
		// 不留第二个旋钮的理由：两个旗标只有一种合法组合，留两个只会多三种非法态要挡。
		source: opts.disclosed ? "agent" : "cli",
		disclosure: opts.disclosed ? "agent_disclosed" : "user_submitted",
		category,
		summary,
		...(userQuote ? { user_quote: userQuote } : {}),
		context: { ...collectEnvContext(), ...parsed.context, command },
		...(taskId != null ? { task_id: taskId } : {}),
		reporter_version: currentVersion(),
	};
	return { payload };
}

// ---------------------------------------------------------------------------
// 回显（念给用户听的那一段）
// ---------------------------------------------------------------------------

/**
 * 渲染要念给用户的全文。
 *
 * ⚠️ **回显的是脱敏后的那一份**：念给用户的内容 = 将要入库的内容，否则「告知」是假的。
 * ⚠️ **MUST NOT 打印任何 JSON key 名**（客户面黑盒）：用中文标签。
 * ⚠️ 随附信息**压成一行**，不逐项一行：agent 上下文是稀缺资源。
 */
export function renderDisclosureNotice(payload: FeedbackPayload): string {
	const bits: string[] = [];
	if (payload.context.command) bits.push(`命令 ${payload.context.command}`);
	bits.push(`版本 ${payload.reporter_version}`);
	const platform = payload.context.os ? PLATFORM_LABELS[String(payload.context.os)] : undefined;
	if (platform) bits.push(`系统 ${platform}${payload.context.arch ? ` ${payload.context.arch}` : ""}`);
	if (payload.task_id != null) bits.push(`任务 ${payload.task_id}`);

	const lines = [
		`类型：${CATEGORY_LABELS[payload.category]}`,
		`摘要：${payload.summary}`,
		...(payload.user_quote ? [`你的原话：${payload.user_quote}`] : []),
		`随附信息：${bits.join(" ｜ ")}`,
	];
	return ["────────", ...lines, "────────"].join("\n");
}

/** 非 TTY 拒绝时打给 agent 看的完整指引（`--json` 时也原样进机读面的 notice 字段）。 */
export function renderRefusalNotice(payload: FeedbackPayload): string {
	return [
		"⚠️  这条反馈还没有经过用户确认，本次未发送。",
		"    请把下面这段原样念给用户，得到同意后，在原命令上加 --disclosed 重跑：",
		renderDisclosureNotice(payload),
	].join("\n");
}

// ---------------------------------------------------------------------------
// 云端调用
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 15_000;

/**
 * 发送。形状逐字对齐 `src/commands/project.ts::callAudioProjectStruct`
 * （同步口范式：无文件、无轮询、直接 POST、`code===200` 分流）。
 *
 * ⚠️ 合规告知挂在这里——**内容真正离开本机之前**。拒绝上报那条路零网络往返、
 * 内容根本没离机，所以那条路**不挂**（`test/compliance-notice.test.mjs` 的收口清单在管）。
 *
 * ⚠️ 只对**网络层失败**（连接失败 / 超时 / 无响应体）重试 1 次，且**复用同一令牌**；
 * 对任何带业务码的响应**零重试**（4xx 业务错误重试无意义）。
 */
export async function postFeedback(
	cfg: CloudConfig,
	payload: FeedbackPayload,
	fetchFn: typeof fetch = fetch,
): Promise<{ duplicated: boolean; retried: boolean }> {
	noticeOnce();

	let lastNetworkError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await fetchFn(`${cfg.base}/feedback/report`, {
				method: "POST",
				headers: { Authorization: cfg.apiKey, "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			const r = await parseJson<{ duplicated?: unknown }>(res);
			if (r.code === 200) {
				const data = (r.data ?? {}) as { duplicated?: unknown };
				return { duplicated: data.duplicated === true, retried: attempt > 0 };
			}
			// 带业务码 ⇒ 零重试
			throw new CloudError(r.code, `反馈提交失败 (code=${r.code ?? "?"})：${r.msg ?? "未知错误"}`);
		} catch (e) {
			if (e instanceof CloudError) throw e;
			lastNetworkError = e;
		}
	}
	throw lastNetworkError instanceof Error
		? lastNetworkError
		: new Error(String(lastNetworkError));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export interface FeedbackResult {
	ok: boolean;
	submitted: boolean;
	duplicated?: boolean;
	category?: Category;
	code?: "needs_user_confirmation" | "cancelled_by_user";
	notice?: string;
	/** 建议的进程退出码。机读面 MUST NOT 与退出码矛盾。 */
	exitCode: number;
}

export async function runFeedback(
	message: string,
	opts: FeedbackOpts,
	deps: FeedbackDeps = {},
): Promise<FeedbackResult> {
	if (opts.json) routeLogsToStderr();
	const write = deps.write ?? ((chunk: string) => void process.stderr.write(chunk));
	const isTty = deps.isTty ?? (() => process.stdout.isTTY === true);

	const built = buildFeedbackPayload(message, opts, deps);
	if (built.error || !built.payload) throw new Error(built.error ?? "反馈内容不完整");
	const payload = built.payload;

	// ── 告知硬门 ──────────────────────────────────────────────────────────
	// ⚠️ 四条路，无第五条。`-y` **不在**任何一条的豁免位上。
	if (!opts.disclosed) {
		if (!isTty()) {
			// 路 4：非 TTY 且未声明 ⇒ 拒绝。零网络往返、非零退出。
			// ⚠️ `-y` 到这里**没有任何作用** —— 它跳过的是「等回答」，
			//    而这条路根本没有可等的回答，缺的是「有没有告知过用户」。
			const notice = renderRefusalNotice(payload);
			write(`${notice}\n`);
			return {
				ok: false,
				submitted: false,
				// 机读码取中性串，**不叫** disclosure_required：
				// 避免把契约字段名漏进可能被转述给用户的文本
				code: "needs_user_confirmation",
				notice,
				exitCode: 1,
			};
		}
		// 路 2 / 3：TTY 下**恒回显**载荷；`-y` 只跳过「等回答」这一步
		write(`${renderDisclosureNotice(payload)}\n`);
		if (!opts.yes) {
			const agreed = await (deps.confirm ?? promptConfirm)("确认发送？");
			if (!agreed) {
				// 主动取消不是失败 ⇒ 退出码 0
				return { ok: true, submitted: false, code: "cancelled_by_user", exitCode: 0 };
			}
		}
	}
	// 路 1（`--disclosed`）**刻意不复读载荷**：已经念过了，复读只污染 agent 上下文。

	const cfg = deps.cfg ?? loadConfig();
	const { duplicated, retried } = await postFeedback(cfg, payload, deps.fetchFn);

	// ⚠️ 首发就撞重复 ⇒ 必须出声。这是「令牌被写死」这类事故**唯一会被发现的地方**，
	//    MUST NOT 静默按成功收口。命中发生在内部重试上则是幂等在正常起作用，不打扰。
	if (duplicated && !retried) {
		log.warn("这条内容刚刚已经报过了，本次未重复记录");
	}

	return { ok: true, submitted: true, duplicated, category: payload.category, exitCode: 0 };
}

export function registerFeedback(program: Command): void {
	program
		.command("feedback <message>")
		.description(
			"把使用中的不顺手反馈给同合云（告知式提交：助手代提时必须先把内容念给你听、得到同意）",
		)
		.option("--command <name>", "这条反馈发生在哪个命令上，如 \"matrix search\"（必填，不要带参数）")
		.option("--category <c>", `类别：${CATEGORIES.join(" / ")}（默认 other）`)
		.option("--quote <text>", "你的原话（可选）")
		.option("--task-id <id>", "关联的任务 ID（可选）")
		.option("--context <k=v>", "附加信息，可重复", (v: string, acc: string[]) => [...acc, v], [])
		.option("--disclosed", "声明「已把完整内容念给用户并获得同意」——助手代提时必须带")
		.option("-y, --yes", "跳过终端里的确认等待（注意：它不能替代上面那条声明）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (message: string, opts: FeedbackOpts) => {
			const result = await runFeedback(message, opts);
			if (opts.json) {
				const { exitCode: _exit, ...body } = result;
				process.stdout.write(`${JSON.stringify(body)}\n`);
			} else if (result.submitted) {
				log.ok("已记录并反馈给同合云");
			} else if (result.code === "cancelled_by_user") {
				log.info("已取消，未发送");
			}
			if (result.exitCode !== 0) process.exitCode = result.exitCode;
		});
}
