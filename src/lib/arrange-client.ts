/**
 * B-roll 编排端点薄客户端 + 预估确认门（change: add-broll-arrange-atom P2.2b）。
 *
 * 口径（与 infra `add-broll-arrange-api` 互锁）：
 *   - `POST <apiBase>/task/cli/broll_arrange`，同步 JSON 直返（**非异步任务，不轮询**）；
 *   - 鉴权沿 cloud-link 口径：`Authorization: <apikey>`（**非 Bearer**）；
 *   - 计费按新计量维度**编排量**；金额**恒由服务端复算**，本地上行的 `estimated_units`
 *     只供一致性校验。
 *
 * ## ★ 重试为什么在这里是安全的（而在别处不是）
 *
 * 传输失败有一类最难办的情形：请求其实到了、服务端也跑完扣了费，只是响应在回程丢了。
 * 盲目重试 = **二次扣费**。本口能安全重试，靠的不是运气，是服务端那张幂等表：
 * 它从**规范化请求体**复算幂等键，字节相同的重发恒不二次扣费、直接回放首次结果。
 *
 * 所以这里有一条不可动的纪律：**请求体只序列化一次，重试逐字节复用同一个字符串**。
 * 一旦某次重试重新 `JSON.stringify` 而键序有任何差异，它在服务端就是**另一个请求**，
 * 幂等失效、真的会再扣一次。这条不是理论洁癖——键序差异在对象被中途改动时真的会发生。
 *
 * 另一半保险在响应里：`data.idempotency_recorded === false` 表示服务端的幂等登记没写成，
 * **本次调用不受幂等保护**。此时若再发生传输失败，重试就不再安全——按不重试处理。
 *
 * ## 业务拒绝不重试
 *
 * 6210-6214（双端复算不一致 / 超 cost_cap / 口径版本不认识 / 幂等键与请求体不匹配 /
 * 编排档位未实现）全部是**确定性**判定：同一个请求重发一百次也是同一个结果。
 * 进退避只是把用户的时间烧掉，还让日志看起来像网络故障。
 */

import { noticeOnce } from "./compliance-notice";
import type { ArrangeRequest } from "./arrange-wire";
import type { ArrangeResponse } from "./arrange-apply";

/** 端点不可达（退避重试用尽后的硬失败）。 */
export const ARRANGE_UNREACHABLE_CODE = "arrange_endpoint_unreachable";

/** infra 编排原子错误码（error_codes.py 6210-6214）。 */
export const ARRANGE_ESTIMATE_MISMATCH = 6210;
export const ARRANGE_COST_CAP_EXCEEDED = 6211;
export const ARRANGE_UNKNOWN_ALGO_PIN = 6212;
export const ARRANGE_IDEMPOTENCY_MISMATCH = 6213;
export const ARRANGE_MODE_UNSUPPORTED = 6214;
/** infra 既有 402 家族。 */
export const QUOTA_INSUFFICIENT_CODE = 6201;
export const BALANCE_INSUFFICIENT_CODE = 6202;

/** 编排是纯 CPU 几十毫秒 + 一个来回；给 120s 是为了容大 plan 的上行体（极端密剪 269KB gzip）。 */
export const ARRANGE_TIMEOUT_MS = 120_000;
export const ARRANGE_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

export class ArrangeError extends Error {
	readonly code = ARRANGE_UNREACHABLE_CODE;
	/** 跨 bundle 判别标记（`instanceof` 在多 bundle 下类身份不唯一——同 `EmbedRejectedError` 先例）。
	 * 回滚层靠它认「端点不可达」，认错就会把可回落的故障当成真 bug 抛给用户。 */
	readonly unreachable = true;
	constructor(msg: string) {
		super(msg);
		this.name = "ArrangeError";
	}
}

/** 服务端业务拒绝：确定性判定，重试无意义，立抛不进退避。 */
export class ArrangeRejectedError extends Error {
	readonly rejected = true;
	constructor(
		readonly code: number,
		msg: string,
	) {
		super(`服务端拒绝了编排请求（code=${code}）：${msg}${hintFor(code)}`);
		this.name = "ArrangeRejectedError";
	}
}

function hintFor(code: number): string {
	switch (code) {
		case ARRANGE_ESTIMATE_MISMATCH:
			return "\n——双端编排量公式漂移了（多半是 CLI 与服务端版本错配）。升级 CLI 后重试；本次未执行也未计费。";
		case ARRANGE_COST_CAP_EXCEEDED:
			return "\n——本次未执行也未计费。调高 --arrange-cost-cap 或缩小 plan 规模（减 beat / 减候选 / 减轨数）。";
		case ARRANGE_UNKNOWN_ALGO_PIN:
			return "\n——服务端不认识本地的计量口径版本，且**不会**回落到默认价目执行（回落即按另一套价静默计费）。升级 CLI。";
		case ARRANGE_IDEMPOTENCY_MISMATCH:
			return "\n——同一幂等键此前对应的是另一份请求。这通常意味着本地请求体在重试之间被改动过。";
		case ARRANGE_MODE_UNSUPPORTED:
			return "\n——服务端尚未实现该编排档位，且 MUST NOT 静默降级到低档执行。改用已实现的档位。";
		case QUOTA_INSUFFICIENT_CODE:
		case BALANCE_INSUFFICIENT_CODE:
			return "\n——额度或余额不足（前置拒绝，本次任务不扣费）。";
		default:
			return "";
	}
}

export interface ArrangeEndpoint {
	url: string;
	apiKey: string;
}

export interface ArrangeDeps {
	fetchFn?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	backoffBaseMs?: number;
	timeoutMs?: number;
	retries?: number;
}

export function resolveArrangeUrl(apiBase: string): string {
	const env = process.env.GITRUCK_ARRANGE_URL?.trim();
	if (env) return env;
	return `${apiBase.replace(/\/+$/, "")}/task/cli/broll_arrange`;
}

/** 4xx 业务拒绝判据（与 embed-client 同口径）：429 与 5xx 属传输面可退避，其余 4xx 带业务码即拒绝。 */
function parseBusinessRejection(status: number, text: string): ArrangeRejectedError | null {
	if (status === 429 || status >= 500) return null;
	try {
		const j = JSON.parse(text) as { code?: unknown; msg?: unknown };
		if (typeof j.code === "number" && j.code !== 200) {
			return new ArrangeRejectedError(j.code, typeof j.msg === "string" && j.msg ? j.msg : `HTTP ${status}`);
		}
	} catch {
		/* 非 JSON 响应体：按传输面处理（走重试） */
	}
	return null;
}

async function arrangeOnce(
	endpoint: ArrangeEndpoint,
	/** ★ 已序列化的请求体，**逐字节复用**——重新 stringify 会让幂等失效（见文件头注）。 */
	bodyText: string,
	fetchFn: typeof fetch,
	timeoutMs: number,
): Promise<ArrangeResponse> {
	const res = await fetchFn(endpoint.url, {
		method: "POST",
		headers: {
			accept: "application/json",
			"Content-Type": "application/json",
			Authorization: endpoint.apiKey, // 裸 apikey，非 Bearer
		},
		body: bodyText,
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		const rejected = parseBusinessRejection(res.status, text);
		if (rejected) throw rejected;
		throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
	}
	const body = (await res.json()) as { code?: unknown; msg?: unknown; data?: unknown };
	if (typeof body.code === "number" && body.code !== 200) {
		// HTTP 200 却带非 200 业务码的防御分支
		throw new ArrangeRejectedError(body.code, typeof body.msg === "string" ? body.msg : `code=${body.code}`);
	}
	if (!body.data || typeof body.data !== "object") throw new Error("响应缺 data（非编排契约响应）");
	return body.data as ArrangeResponse;
}

/**
 * 发起编排请求。传输失败指数退避重试，业务拒绝立抛。
 *
 * 重试安全性由服务端幂等表保证，前提是**请求体逐字节相同**——故这里只序列化一次。
 */
export async function requestArrange(
	endpoint: ArrangeEndpoint,
	req: ArrangeRequest,
	deps: ArrangeDeps = {},
): Promise<ArrangeResponse> {
	// 合规告知：plan 的 beat 名与检索词由此离机（投影层已砍掉路径/描述文本/签名 URL）
	noticeOnce();
	const fetchFn = deps.fetchFn ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const backoffBase = deps.backoffBaseMs ?? BACKOFF_BASE_MS;
	const timeoutMs = deps.timeoutMs ?? ARRANGE_TIMEOUT_MS;
	const retries = deps.retries ?? ARRANGE_RETRIES;

	// ★ 只序列化这一次。下面每次重试都复用它，一个字节都不重算。
	const bodyText = JSON.stringify(req);

	let lastErr = "";
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt > 0) await sleep(backoffBase * 2 ** (attempt - 1)); // 1s → 2s → 4s
		try {
			return await arrangeOnce(endpoint, bodyText, fetchFn, timeoutMs);
		} catch (e) {
			if ((e as { rejected?: unknown } | null)?.rejected === true) throw e; // 业务拒绝：确定性，重试无意义
			lastErr = e instanceof Error ? e.message : String(e);
		}
	}
	throw new ArrangeError(
		`编排端点不可达或响应异常（${endpoint.url}）：${lastErr}——已指数退避重试 ${retries} 次。\n` +
			"重试用的是逐字节相同的请求体，服务端幂等表保证不会因此二次扣费。",
	);
}

// ── 预估确认门（P2.2b）────────────────────────────────────────────────────

export interface EstimateGateOpts {
	/** `--yes`：跳过确认，直接跑。 */
	assumeYes?: boolean;
	/** 本次上限；给了就随请求上行，服务端超限**前置拒绝**、零执行零计费。 */
	costCap?: number;
	/** 交互确认（测试注入；缺省时不交互 ⇒ 按未确认处理）。 */
	confirm?: (prompt: string) => Promise<boolean>;
	log?: { info: (m: string) => void; warn: (m: string) => void };
}

export interface EstimateGateResult {
	proceed: boolean;
	/** 未放行时的机读原因（`declined` = 用户拒绝；`no_tty` = 无从确认）。 */
	reason?: "declined" | "no_tty";
}

/**
 * 跑前展示编排量预估并征求确认。
 *
 * 措辞纪律：**MUST NOT 把预估说成「将扣 N 积分」**。本地算的是**编排量**，
 * 不是钱；单价由主理人定、且计费金额恒以服务端复算值为准。把它说成钱，
 * 一旦服务端复算出别的数（或单价调整），我们就等于当面失信了一次。
 */
export async function estimateGate(units: number, opts: EstimateGateOpts = {}): Promise<EstimateGateResult> {
	const log = opts.log ?? { info: () => {}, warn: () => {} };
	const capNote = opts.costCap !== undefined ? `（本次上限 ${opts.costCap}，超限服务端前置拒绝、零执行零计费）` : "";
	log.info(
		`本次云端编排的**编排量**预估为 ${units}${capNote}。` +
			"该值由本地按与服务端同一公式算出，随请求上行仅供一致性校验——" +
			"实际计费恒以服务端复算值为准，两值不一致时服务端会拒绝执行且不计费。",
	);
	if (opts.assumeYes) return { proceed: true };
	if (!opts.confirm) {
		// 非交互环境（CI / 管道）里默认**不跑**：花钱的动作不该在没人看着的时候自己发生。
		log.warn("非交互环境无法确认，本轮不发起云端编排。要在脚本里跑请显式加 --yes。");
		return { proceed: false, reason: "no_tty" };
	}
	const ok = await opts.confirm(`确认发起云端编排（编排量 ${units}）？`);
	if (!ok) log.info("已取消，未发起请求——零执行零计费。");
	return ok ? { proceed: true } : { proceed: false, reason: "declined" };
}
