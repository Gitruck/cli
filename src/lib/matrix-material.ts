/**
 * gtrk matrix material —— 通用三态素材检索纯逻辑（2×2 路由矩阵**下半行**，add-matrix-material-search）。
 *
 * 2×2 路由矩阵：
 *            external 公开口            internal 矩阵成员口
 *   剪辑向    /task/video_clip_search    /task/custom/video_clip_search   （matrix.ts，剪辑向 segments）
 *   通用三态  /task/material_search      /task/custom/material_search     （本文件，下载向出参）
 *
 * 身份判据**不另写**：一律经 matrix.ts 的 `decideRoute`（非字符串 "internal" 的任何值——缺失/external/
 * 未知新档位——一律 external），与网关「仅 internal 放行」对齐；本文件只换端点表，不降级不缓存。
 *
 * 两档入参差异（服务端契约，public-material-search spec 明文「入参 MUST 只接受
 * scope/query/top_k/diversity/request_id」）：`copyright_scope` 与 `filters`（时长区间）**仅 custom 口**存在，
 * 公开口 MUST NOT 收——故 buildMaterialSearchBody 对 external 档不拼这两键（命令层显式提示，不静默忽略）。
 *
 * 两档出参差异（★ 2026-08-22 核实，勿按旧说法实现）：`audio_type` 与 `accompaniment_url`（song 类伴奏直链）
 * **两档通用**——公开口 `_serialize` 本就吐出，custom 口继承它再加字段；**只有 `is_copyright`（及 clip scope 的
 * `material_class`）是 internal 独有**。external 档缺 `is_copyright` 时归一层如实缺省，MUST NOT 补 false/空串
 * 假值（服务端明确不补齐该差异——公开口该字段恒 true，信息量为零，容错分支长期保留）。
 */
import type { CloudConfig } from "./config";
import { CloudError, type ApiResp } from "./cloud";
import { SEARCH_TIMEOUT_MS, classifyApiError, decideRoute, type Tier } from "./matrix";

// ── 常量与路由表（与剪辑向 ENDPOINTS 并列声明）────────────────────────────

export type MaterialScope = "clip" | "image" | "audio";

export const MATERIAL_SCOPES = ["clip", "image", "audio"] as const;

/** 缺省三态：本零件第一需求场景是 BGM（clip 想要剪辑向 segments 请用 `matrix search`）。 */
export const MATERIAL_SCOPE_DEFAULT: MaterialScope = "audio";

/** 缺省候选数（推荐 3-5 首的量级；服务端上限 50）。 */
export const MATERIAL_TOP_K_DEFAULT = 5;
export const MATERIAL_TOP_K_MAX = 50;

export const MATERIAL_ENDPOINTS: Record<Tier, string> = {
	internal: "/task/custom/material_search",
	external: "/task/material_search",
};

/** 计费口径（人类可读输出如实提示）：公开口 1 积分/次；custom 口 0 元（成员免费，0 元照留痕带 task_id）。 */
export const MATERIAL_BILLING_NOTE: Record<Tier, string> = {
	internal: "0 积分（矩阵成员免费，0 元照留痕带 task_id）",
	external: "1 积分/次",
};

// ── 卡脖子 upsell（收敛触发，不污染候选）──────────────────────────────────

export const MATRIX_UPSELL_URL = "https://ai-mcn.tv/#creator-network";

export const MATRIX_UPSELL_MESSAGE =
	`加入同和新媒体矩阵可免费搜全库（含非商用/概念素材）：${MATRIX_UPSELL_URL}`;

export interface MaterialUpsell {
	message: string;
	url: string;
}

/**
 * upsell 判定（纯函数）：**当且仅当** external 档 且 结果条数不足（0 条，或少于请求量的一半）时出。
 * internal 档恒不出（成员已在全库，提示无意义）。返回 undefined = 不提示。
 */
export function decideMaterialUpsell(tier: Tier, resultCount: number, topK: number): MaterialUpsell | undefined {
	if (tier !== "external") return undefined;
	if (resultCount === 0 || resultCount < topK / 2) {
		return { message: MATRIX_UPSELL_MESSAGE, url: MATRIX_UPSELL_URL };
	}
	return undefined;
}

/**
 * 身份路由（下半行）：**复用剪辑向同一 `decideRoute` 判据**，只把端点换成通用素材行——
 * 本文件 MUST NOT 另写 `memberType === "internal"` 之类的身份逻辑。
 */
export function decideMaterialRoute(memberType: unknown): { tier: Tier; endpoint: string } {
	const { tier } = decideRoute(memberType);
	return { tier, endpoint: MATERIAL_ENDPOINTS[tier] };
}

/** 已探得档位 → 端点（命令层用 probeMemberType 的结果直接取，同一张路由表）。 */
export function materialEndpointFor(tier: Tier): string {
	return MATERIAL_ENDPOINTS[tier];
}

// ── 参数解析（非法值参数错误拒绝，不做静默回落）──────────────────────────

/** `--scope`：缺省 audio；非三态取值一律参数错误（不猜不回落）。 */
export function parseMaterialScope(raw: string | undefined): MaterialScope {
	const v = (raw ?? "").trim();
	if (!v) return MATERIAL_SCOPE_DEFAULT;
	if (!(MATERIAL_SCOPES as readonly string[]).includes(v)) {
		throw new Error(`--scope 取值非法（${raw}）——只支持 ${MATERIAL_SCOPES.join(" | ")}（缺省 ${MATERIAL_SCOPE_DEFAULT}）`);
	}
	return v as MaterialScope;
}

/** `--top-k`：缺省 5；正整数，超服务端上限 50 钳位。 */
export function parseMaterialTopK(raw: string | undefined): number {
	if (raw === undefined || String(raw).trim() === "") return MATERIAL_TOP_K_DEFAULT;
	const n = Number(String(raw).trim());
	if (!Number.isFinite(n) || n < 1) throw new Error(`--top-k 取值非法（${raw}）——须为 ≥1 的整数（缺省 ${MATERIAL_TOP_K_DEFAULT}）`);
	return Math.min(Math.floor(n), MATERIAL_TOP_K_MAX);
}

export interface MaterialDurationBounds {
	min?: number;
	max?: number;
}

/** `--min-duration` / `--max-duration`（秒）：可单独或组合给出；负数 / 非数字 / 上界小于下界一律参数错误。 */
export function parseMaterialDurationBounds(minRaw: string | undefined, maxRaw: string | undefined): MaterialDurationBounds {
	const one = (raw: string | undefined, flag: string): number | undefined => {
		if (raw === undefined || String(raw).trim() === "") return undefined;
		const n = Number(String(raw).trim());
		if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} 取值非法（${raw}）——须为非负数字（秒）`);
		return n;
	};
	const min = one(minRaw, "--min-duration");
	const max = one(maxRaw, "--max-duration");
	if (min !== undefined && max !== undefined && max < min) {
		throw new Error(`时长区间非法（--min-duration ${min} > --max-duration ${max}）——上界不能小于下界`);
	}
	return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

// ── 请求构建 ──────────────────────────────────────────────────────────────

export interface MaterialSearchParams {
	scope: MaterialScope;
	query: string;
	topK: number;
	diversity?: boolean;
	/** internal 档 → `copyright_scope:"commercial"`（缺省 all 搜全库）；external 档公开口无该入参。 */
	commercialOnly?: boolean;
	minDuration?: number;
	maxDuration?: number;
}

export interface MaterialSearchBody {
	scope: MaterialScope;
	query: string;
	top_k: number;
	diversity?: boolean;
	/** custom 口独有。 */
	copyright_scope?: "all" | "commercial";
	/** custom 口独有（clip/audio 适用；image 无时长语义服务端忽略）。 */
	filters?: { min_duration?: number; max_duration?: number };
}

/**
 * 请求体构建：公开口只拼服务端白名单四键（scope/query/top_k/diversity），custom 口另加
 * `copyright_scope` 与 `filters`——**MUST NOT** 把 custom 专属键漏给公开口（服务端入参白名单明文）。
 */
export function buildMaterialSearchBody(tier: Tier, p: MaterialSearchParams): MaterialSearchBody {
	const body: MaterialSearchBody = { scope: p.scope, query: p.query, top_k: p.topK };
	if (p.diversity) body.diversity = true;
	if (tier === "internal") {
		body.copyright_scope = p.commercialOnly ? "commercial" : "all";
		const filters: { min_duration?: number; max_duration?: number } = {};
		if (p.minDuration !== undefined) filters.min_duration = p.minDuration;
		if (p.maxDuration !== undefined) filters.max_duration = p.maxDuration;
		if (Object.keys(filters).length) body.filters = filters;
	}
	return body;
}

// ── 响应归一（有则透出、无则缺省，绝不造假值）────────────────────────────

/** 下载向结果形态。两档通用键 + internal 独有键（`is_copyright` / clip 的 `material_class`）。 */
export interface MaterialResult {
	/** 素材主键——雪花大整数，一律**字符串**（JSON.parse 成 number 必丢精度）。 */
	id: string;
	score?: number;
	note?: string | null;
	tags?: string[];
	duration?: number;
	/** audio scope：`pure` 纯音乐 / `song` 歌曲（两档通用）。 */
	audio_type?: string;
	download_url?: string;
	cover_url?: string;
	/** song 类现成伴奏直链——**两档通用**（公开口序列化本就吐出，custom 口继承之）。 */
	accompaniment_url?: string;
	/** **仅 internal 档**：是否可商用。external 档如实缺省，MUST NOT 补假值。 */
	is_copyright?: boolean;
	/** **仅 internal 档 clip scope**：real_shot / concept。 */
	material_class?: string;
	[k: string]: unknown;
}

export interface MaterialRespData {
	request_id?: string | null;
	task_id?: string | null;
	total?: number;
	results: MaterialResult[];
}

/**
 * 单条归一：服务端字段**原样透传**（title/author/preview_url/thumb_url/width/height… 各态字段随服务端演进），
 * 只做两件事——① `id` 归一为字符串；② `score` 归一为数字。缺席的键（如 external 档的 `is_copyright`）
 * **一律不补**：补 false/空串会把「不知道」谎报成「不可商用」。
 */
export function normalizeMaterialResult(raw: unknown): MaterialResult | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = { ...(raw as Record<string, unknown>) } as MaterialResult;
	const id = (raw as Record<string, unknown>).id;
	if (id === undefined || id === null || id === "") return undefined;
	r.id = String(id);
	const score = (raw as Record<string, unknown>).score;
	if (typeof score === "string" && score.trim() !== "" && Number.isFinite(Number(score))) r.score = Number(score);
	return r;
}

export function normalizeMaterialResults(raw: unknown): MaterialResult[] {
	if (!Array.isArray(raw)) return [];
	return raw.map(normalizeMaterialResult).filter((r): r is MaterialResult => r !== undefined);
}

/** 结果按 duration 过滤（公开口无 filters 入参时的本地兜底；无 duration 语义的条目不误杀）。 */
export function filterMaterialsByDuration(results: MaterialResult[], bounds: MaterialDurationBounds): MaterialResult[] {
	if (bounds.min === undefined && bounds.max === undefined) return results;
	return results.filter((r) => {
		const d = r.duration;
		if (typeof d !== "number" || !Number.isFinite(d)) return true; // image 等无时长语义：不参与过滤
		if (bounds.min !== undefined && d < bounds.min) return false;
		if (bounds.max !== undefined && d > bounds.max) return false;
		return true;
	});
}

/** 错误分类：403 指路公开条（本行专属文案），其余复用剪辑向 `classifyApiError`。 */
export function classifyMaterialApiError(code: number | undefined, msg?: string): string {
	if (code === 403) {
		return "非矩阵成员或身份可能已变更——矩阵成员口（custom/material_search）仅对 internal 档位开放，公开口 /task/material_search 可直接用（1 积分/次，只含可商用素材）";
	}
	return classifyApiError(code, msg);
}

/**
 * 把响应文本里的大整数 `id` 引号化后再 JSON.parse（照 parseClipIdSafe 先例）——素材主键是雪花大整数
 * （>2^53），JSON.parse 成 number 丢精度且不可逆，必须在文本层拦截。`task_id`/`request_id` 等不受影响
 * （正则要求 `"id"` 完整键名）。
 */
export function parseMaterialIdSafe<T>(text: string, status: number): ApiResp<T> {
	try {
		return JSON.parse(text.replace(/"id"\s*:\s*(\d+)/g, '"id":"$1"')) as ApiResp<T>;
	} catch {
		throw new Error(`服务响应解析失败 (HTTP ${status})`);
	}
}

/** 包络双形态兼容（照既有 embed/describe 先例）：`data` 直挂 results，或再套一层 `data.data`。 */
export function unwrapMaterialData(data: unknown): Record<string, unknown> {
	if (!data || typeof data !== "object" || Array.isArray(data)) return {};
	const d = data as Record<string, unknown>;
	if (!Array.isArray(d.results) && d.data && typeof d.data === "object" && !Array.isArray(d.data)) {
		return d.data as Record<string, unknown>;
	}
	return d;
}

/** 单次通用素材检索。抛 CloudError（含分类文案）——调用方决定怎么呈现。 */
export async function searchMaterialOnce(cfg: CloudConfig, tier: Tier, body: MaterialSearchBody): Promise<MaterialRespData> {
	const res = await fetch(`${cfg.base}${MATERIAL_ENDPOINTS[tier]}`, {
		method: "POST",
		headers: { accept: "application/json", "Content-Type": "application/json", Authorization: cfg.apiKey },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
	});
	const r = parseMaterialIdSafe<Record<string, unknown>>(await res.text(), res.status);
	if (r.code !== 200) throw new CloudError(r.code, classifyMaterialApiError(r.code, r.msg));
	const data = unwrapMaterialData(r.data);
	return {
		...(typeof data.request_id === "string" ? { request_id: data.request_id } : {}),
		...(data.task_id !== undefined && data.task_id !== null ? { task_id: String(data.task_id) } : {}),
		...(typeof data.total === "number" ? { total: data.total } : {}),
		results: normalizeMaterialResults(data.results),
	};
}
