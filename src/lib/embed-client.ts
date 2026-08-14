/**
 * 同合云自建 embed 端点薄客户端（add-matrix-local-search D3 / local-material-index spec）。
 *
 * 口径（与 infra link-model-rpc-public-embed-api 互锁）：
 *   - `POST <url>`，body `{input:[{text}|{image:<base64>}]（可混批）, normalized:true,
 *     session_token?}`（图像请求 MUST 带有效计量会话 token；纯文本免 token 免费；
 *     internal 矩阵成员豁免——见下方「计量会话」）；
 *   - 响应兼容两形态：裸 `{data:[{index, embedding}], usage}`（D2 契约/Jina 形态）与 infra
 *     包络 `{code, msg, data:{data:[…], usage}}`——jina-clip-v2 满 1024 维 normalized 向量
 *     （与云端素材矩阵同语义空间）；
 *   - 鉴权沿 cloud-link 口径：`Authorization: <apikey>`（**非 Bearer**）；
 *   - 批 ≤16/请求（图上限；文本一并压在同一上限内，服务端文本上限 64 更宽松）；
 *   - 传输失败/5xx/429 指数退避重试 3 次后**硬失败**（机读 code `embed_endpoint_unreachable`），
 *     **绝不回落 Jina 官方 API 或任何第三方端点**（key/限流/合规三重不确定性不许回流）；
 *     服务端**业务拒绝**（4xx 业务码：6030 超批 / 6031 图片超限 / 6033 会话缺失·失效 /
 *     6201·6202 积分不足等）重试无意义 → 立抛 `EmbedRejectedError` 不进退避；
 *   - 超时 180s：容 model-rpc 懒加载冷启动（600s 空闲逐出后首请求可达分钟级）。
 *
 * 计量会话（infra 计费细案第 6 条，两仓钉死 2026-08-12）：
 *   - `POST <url>/session/open {planned_units}` → `{session_token, pre_deducted_credits}`
 *     （预扣 = ceil(planned×0.1)，0.1 积分/张、文本免费、internal 豁免）；
 *   - `POST <url>/session/close {session_token}` → `{used_units, settled_credits, refunded_credits}`
 *     （结算 Decimal ROUND_HALF_UP；used>0 最低 1 积分；used=0 全退）；
 *   - 会话 Redis TTL 2h；超时未 close 由服务端 /internal/quota/reconcile 兜底结算。
 *
 * 端点 URL 决议：env GITRUCK_EMBED_URL > ~/.gitruck config.embedUrl > `<apiBase>/task/cli/embed`
 * （infra 实际落点：cli 域，2026-08-12 失配修正——原 `/gc/embed` 推导已废）。
 */
import { CloudError } from "./cloud";
import { noticeOnce } from "./compliance-notice";
import { readUserConfig } from "./user-config";

export const EMBED_UNREACHABLE_CODE = "embed_endpoint_unreachable";
/** infra 新错误码：图像 embed 请求缺/无效 session_token（计量会话防绕过）。 */
export const EMBED_SESSION_TOKEN_REJECTED_CODE = 6033;
/** infra 既有 402 家族：配额不足 / 余额不足（error_codes.py，会话 open 预扣失败时返回）。 */
export const QUOTA_INSUFFICIENT_CODE = 6201;
export const BALANCE_INSUFFICIENT_CODE = 6202;
/** 计费单价（与 infra 细案钉死）：图像 0.1 积分/张（文本免费）；预扣=ceil(planned×0.1)。 */
export const EMBED_CREDITS_PER_IMAGE = 0.1;
/** 单请求输入上限（infra 防滥用：≤16 图；文本从严同批）。 */
export const EMBED_BATCH_MAX = 16;
/** jina-clip-v2 满维（normalized）。 */
export const EMBED_DIM = 1024;
/** HTTP 超时：≥180s 容冷启动（infra D4，与 media_matrix 内部调用口径一致）。 */
export const EMBED_TIMEOUT_MS = 180_000;
/** 指数退避重试次数（失败面 = 1 次首发 + 3 次重试后硬失败）。 */
export const EMBED_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

export type EmbedInput = { text: string } | { image: string };

/** embed 端点硬失败（机读 code 固定 `embed_endpoint_unreachable`，--json 口径直出）。 */
export class EmbedError extends Error {
	readonly code = EMBED_UNREACHABLE_CODE;
	constructor(msg: string) {
		super(msg);
		this.name = "EmbedError";
	}
}

/** 端点**业务拒绝**（服务端 4xx 业务码）：与「不可达」相区分——重试无意义，立抛不进退避。
 * 跨 bundle 判别用 `rejected === true` 标记（instanceof 在多 bundle 下类身份不唯一）。 */
export class EmbedRejectedError extends Error {
	readonly rejected = true;
	constructor(
		readonly code: number,
		msg: string,
	) {
		super(
			`自建 embed 端点拒绝了请求（code=${code}）：${msg}` +
				(code === EMBED_SESSION_TOKEN_REJECTED_CODE
					? "——计量会话缺失或已过期（Redis TTL 2h）：重跑 gtrk matrix index 会自动重开会话续跑（指纹增量，已完成素材零重算）"
					: ""),
		);
		this.name = "EmbedRejectedError";
	}
}

export interface EmbedEndpoint {
	url: string;
	apiKey: string;
}

/** 端点 URL 决议（env > ~/.gitruck 配置 > apiBase 推导默认——infra 实际落点 cli 域）。 */
export function resolveEmbedUrl(apiBase: string): string {
	const env = process.env.GITRUCK_EMBED_URL?.trim();
	if (env) return env;
	const cfg = readUserConfig().embedUrl?.trim();
	if (cfg) return cfg;
	return `${apiBase.replace(/\/+$/, "")}/task/cli/embed`;
}

/** 测试注入面 + 请求选项（mock 端点夹具走 fetchFn；生产零注入）。 */
export interface EmbedDeps {
	fetchFn?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	/** 退避基数（毫秒，默认 1000 → 1s/2s/4s）；测试压短。 */
	backoffBaseMs?: number;
	timeoutMs?: number;
	/** 计量会话 token（请求体字段 `session_token`）：图像请求必带；纯文本/internal 豁免可缺省。 */
	sessionToken?: string;
}

interface EmbedRespRow {
	index: number;
	embedding: number[];
}

/** 4xx 业务拒绝判据：429 限流与 5xx 属传输面（可退避重试），其余 4xx 携带业务码即拒绝。 */
function parseBusinessRejection(status: number, text: string): EmbedRejectedError | null {
	if (status === 429 || status >= 500) return null;
	try {
		const j = JSON.parse(text) as { code?: unknown; msg?: unknown };
		if (typeof j.code === "number" && j.code !== 200) {
			return new EmbedRejectedError(j.code, typeof j.msg === "string" && j.msg ? j.msg : `HTTP ${status}`);
		}
	} catch {
		/* 非 JSON 响应体：按传输面处理（走重试） */
	}
	return null;
}

/** 单批请求（不重试）；业务拒绝抛 EmbedRejectedError，其余异常按文本抛给上层重试逻辑。 */
async function embedOnce(
	endpoint: EmbedEndpoint,
	inputs: EmbedInput[],
	deps: Required<Pick<EmbedDeps, "fetchFn" | "timeoutMs">> & Pick<EmbedDeps, "sessionToken">,
): Promise<Float32Array[]> {
	const res = await deps.fetchFn(endpoint.url, {
		method: "POST",
		headers: {
			accept: "application/json",
			"Content-Type": "application/json",
			Authorization: endpoint.apiKey, // 裸 apikey，非 Bearer（cloud-link 口径）
		},
		body: JSON.stringify({
			input: inputs,
			normalized: true,
			...(deps.sessionToken ? { session_token: deps.sessionToken } : {}),
		}),
		signal: AbortSignal.timeout(deps.timeoutMs),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		const rejected = parseBusinessRejection(res.status, text);
		if (rejected) throw rejected;
		throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
	}
	const body = (await res.json()) as { code?: unknown; msg?: unknown; data?: unknown };
	if (typeof body.code === "number" && body.code !== 200) {
		// HTTP 200 却带非 200 业务码的防御分支（infra 常态是 4xx 配业务码）
		throw new EmbedRejectedError(body.code, typeof body.msg === "string" ? body.msg : `code=${body.code}`);
	}
	// 双形态兼容：裸 {data:[…]}（D2 契约/Jina 形态）或 infra 包络 {code,msg,data:{data:[…],usage}}
	let rows: unknown = body.data;
	if (rows && typeof rows === "object" && !Array.isArray(rows)) rows = (rows as { data?: unknown }).data;
	if (!Array.isArray(rows)) throw new Error("响应缺 data 数组（非 embed 契约响应）");
	const data = rows as EmbedRespRow[];
	if (data.length !== inputs.length) {
		throw new Error(`响应条数 ${data.length} 与输入 ${inputs.length} 不符`);
	}
	const sorted = [...data].sort((a, b) => a.index - b.index);
	return sorted.map((r) => {
		if (!Array.isArray(r.embedding) || r.embedding.length !== EMBED_DIM) {
			throw new Error(`embedding 维度异常（期待满 ${EMBED_DIM} 维，得到 ${r.embedding?.length ?? "?"}）`);
		}
		return Float32Array.from(r.embedding);
	});
}

/**
 * 批量向量化：按 ≤16/请求切批，逐批指数退避重试，任一批 3 次重试仍失败 → EmbedError 整体硬失败；
 * 服务端业务拒绝（EmbedRejectedError，如 6033 会话失效/6031 图片超限）不进重试立抛。
 * 返回与 inputs 一一对位的向量数组。
 */
export async function embedInputs(
	endpoint: EmbedEndpoint,
	inputs: EmbedInput[],
	deps: EmbedDeps = {},
): Promise<Float32Array[]> {
	if (inputs.length === 0) return [];
	// 合规告知（add-compliance-notice 2.2）：抽帧/检索词由此离机（matrix index / --local），
	// 名字里带 local 也一样——判据是内容是否离机，不是命令名。零输入不算出口，故在早退之后。
	noticeOnce();
	const fetchFn = deps.fetchFn ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const backoffBase = deps.backoffBaseMs ?? BACKOFF_BASE_MS;
	const timeoutMs = deps.timeoutMs ?? EMBED_TIMEOUT_MS;

	const out: Float32Array[] = [];
	for (let off = 0; off < inputs.length; off += EMBED_BATCH_MAX) {
		const batch = inputs.slice(off, off + EMBED_BATCH_MAX);
		let lastErr = "";
		let done = false;
		for (let attempt = 0; attempt <= EMBED_RETRIES; attempt++) {
			if (attempt > 0) await sleep(backoffBase * 2 ** (attempt - 1)); // 1s → 2s → 4s
			try {
				out.push(...(await embedOnce(endpoint, batch, { fetchFn, timeoutMs, sessionToken: deps.sessionToken })));
				done = true;
				break;
			} catch (e) {
				if ((e as { rejected?: unknown } | null)?.rejected === true) throw e; // 业务拒绝：重试无意义
				lastErr = e instanceof Error ? e.message : String(e);
			}
		}
		if (!done) {
			// 硬失败不降级：MUST NOT 回落任何第三方端点
			throw new EmbedError(
				`自建 embed 端点不可达或响应异常（${endpoint.url}）：${lastErr}——已指数退避重试 ${EMBED_RETRIES} 次。` +
					`不会回落第三方端点；请确认同合云 embed API 已上线、~/.gitruck 配置 embedUrl / 环境变量 GITRUCK_EMBED_URL 指向正确`,
			);
		}
	}
	return out;
}

// ── 计量会话（session metering）客户端 ─────────────────────────────────────

/** 会话端点挂在 embed 端点之下（`<embedUrl>/session/open|close`）——env/config 覆盖 embedUrl 时随之走。 */
function embedSessionUrl(embedUrl: string, leaf: "open" | "close"): string {
	return `${embedUrl.replace(/\/+$/, "")}/session/${leaf}`;
}

export interface EmbedSessionOpenResult {
	sessionToken: string;
	/** 预扣积分 = ceil(planned_units × 0.1)（服务端权威值，CLI 只回显）。 */
	preDeductedCredits: number;
}

export interface EmbedSessionCloseResult {
	usedUnits: number;
	/** 实结积分（Decimal ROUND_HALF_UP；used>0 最低 1 积分；used=0 全退）。 */
	settledCredits: number;
	refundedCredits: number;
}

/**
 * 会话端点通用 POST：ApiResp `{code,msg,data}` 包络；传输失败/5xx/429 退避重试，
 * 业务码非 200（如 6201/6202 积分不足）→ CloudError 立抛不重试。
 */
async function postSessionJson(
	url: string,
	apiKey: string,
	payload: unknown,
	deps: EmbedDeps,
): Promise<{ code?: number; msg?: string; data?: unknown }> {
	const fetchFn = deps.fetchFn ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const backoffBase = deps.backoffBaseMs ?? BACKOFF_BASE_MS;
	const timeoutMs = deps.timeoutMs ?? EMBED_TIMEOUT_MS;
	let lastErr = "";
	for (let attempt = 0; attempt <= EMBED_RETRIES; attempt++) {
		if (attempt > 0) await sleep(backoffBase * 2 ** (attempt - 1));
		try {
			const res = await fetchFn(url, {
				method: "POST",
				headers: {
					accept: "application/json",
					"Content-Type": "application/json",
					Authorization: apiKey, // 裸 apikey，非 Bearer
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(timeoutMs),
			});
			const text = await res.text().catch(() => "");
			let body: { code?: unknown; msg?: unknown; data?: unknown } = {};
			try {
				body = JSON.parse(text) as typeof body;
			} catch {
				/* 非 JSON：按传输面重试 */
			}
			const code = typeof body.code === "number" ? body.code : undefined;
			if (res.ok && (code === undefined || code === 200)) {
				return { code, msg: typeof body.msg === "string" ? body.msg : undefined, data: body.data };
			}
			// 业务拒绝（4xx 非 429 且带业务码，如 6201/6202 积分不足）：立抛不重试
			if (code !== undefined && code !== 200 && res.status !== 429 && res.status < 500) {
				throw new CloudError(code, typeof body.msg === "string" && body.msg ? body.msg : `code=${code}`);
			}
			lastErr = `HTTP ${res.status}：${(typeof body.msg === "string" ? body.msg : text).slice(0, 200)}`;
		} catch (e) {
			if (e instanceof CloudError) throw e; // 本模块内刚抛出的业务拒绝：透传
			lastErr = e instanceof Error ? e.message : String(e);
		}
	}
	throw new EmbedError(`计量会话端点不可达或响应异常（${url}）：${lastErr}——已指数退避重试 ${EMBED_RETRIES} 次`);
}

/** 开计量会话：`{planned_units}` → `{session_token, pre_deducted_credits}`。
 * 积分不足（6201/6202）以 CloudError 抛出（调用方补「所需积分」文案后退出）。 */
export async function openEmbedSession(
	endpoint: EmbedEndpoint,
	plannedUnits: number,
	deps: EmbedDeps = {},
): Promise<EmbedSessionOpenResult> {
	if (!(Number.isInteger(plannedUnits) && plannedUnits > 0)) {
		throw new Error(`planned_units 必须为正整数（得到 ${plannedUnits}）——零计划帧不开会话`);
	}
	const url = embedSessionUrl(endpoint.url, "open");
	const r = await postSessionJson(url, endpoint.apiKey, { planned_units: plannedUnits }, deps);
	const data = (r.data ?? {}) as { session_token?: unknown; pre_deducted_credits?: unknown };
	if (typeof data.session_token !== "string" || !data.session_token) {
		throw new EmbedError(`会话 open 响应缺 session_token（${url}）——非计量会话契约响应`);
	}
	return {
		sessionToken: data.session_token,
		preDeductedCredits: typeof data.pre_deducted_credits === "number" ? data.pre_deducted_credits : 0,
	};
}

/** 关计量会话（完成/失败均调）：`{session_token}` → 实际用量与结算/退还积分。 */
export async function closeEmbedSession(
	endpoint: EmbedEndpoint,
	sessionToken: string,
	deps: EmbedDeps = {},
): Promise<EmbedSessionCloseResult> {
	const url = embedSessionUrl(endpoint.url, "close");
	const r = await postSessionJson(url, endpoint.apiKey, { session_token: sessionToken }, deps);
	const data = (r.data ?? {}) as { used_units?: unknown; settled_credits?: unknown; refunded_credits?: unknown };
	const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	return {
		usedUnits: num(data.used_units),
		settledCredits: num(data.settled_credits),
		refundedCredits: num(data.refunded_credits),
	};
}
