/**
 * gtrk matrix —— B-roll 双口检索纯逻辑（matrix-command / broll-plan-contract spec）。
 *
 * 身份路由（档位主/子类型次，不降级不缓存）：matrix_member_type === "internal" → /task/custom/search；
 * 其他任何值（external/缺失/未知新档位）→ /task/video_clip_search（与网关「仅 internal 放行」对齐）。
 * 栏目配置显式消费（成片层）：column_tag_ids **字符串数组原样**传（雪花 id >2^53，parse 成 number 必丢精度）。
 * 错误按 body.code 分支（403 与 6401/6402 均伪装成 HTTP 500；master 层参数错经网关代理一律 6401——双语义）。
 */
import type { CloudConfig } from "./config";
import type { FilmDispatch } from "./splitdoc";
import type { ColumnBroll } from "./column-config";
import { parseJson, CloudError, type ApiResp } from "./cloud";

// ── 类型（broll-plan-contract spec 字段级）────────────────────────────────

/** 服务端 result 原样字段 + 本地附加（仅 excluded_hint / also_matched_queries 两个）。
 * clip_id 一律**字符串**：服务端返回雪花大整数（>2^53），JSON.parse 成 number 必丢精度
 * （真机实测 …141 被砸成 …140，两个不同 clip 撞成同一 id）——解析层引号化，契约统一字符串。
 *
 * 本地形态（add-matrix-local-search · broll-plan-contract，2026-08-12 联测收口）：`source:"local"` 标记，
 * `clip_id`=`local-<blake3-16>`——**与云端同构：材料 id 由消费方既有拼接 `broll-`+clip_id 得出
 * `broll-local-<blake3-16>`，MUST NOT 在 clip_id 里预置 `broll-` 前缀（否则拼出 `broll-broll-` 双前缀）**；
 * `local_path`/`cover_path` 替代 `url`/`cover_url`（无 24h 签名过期语义，url 系字段 MUST NOT 出现）；
 * `segments` 结构与云端形态逐字段一致。云端形态字段与语义不变（无 source 键即云端）。 */
export interface PlanResult {
	clip_id: string;
	score: number;
	/** 云端形态必有；本地形态（source:"local"）MUST NOT 出现。 */
	url?: string;
	/** 云端形态必有；本地形态 MUST NOT 出现（封面走 cover_path）。 */
	cover_url?: string;
	duration?: number;
	width?: number;
	height?: number;
	fps?: number;
	orientation?: string;
	/** 按 score 降序（非时间序）；best = 段内最像 query 的一帧时刻（截取/缩略锚点）。 */
	segments?: { start: number; end: number; best: number; score: number }[];
	note?: string | null;
	matched?: Record<string, unknown>;
	// internal 口独有
	material_class?: string;
	level?: string;
	is_copyright?: boolean;
	// 本地检索形态（local-material-search spec）
	source?: "local";
	/** 本地素材绝对路径（免下载免上传，消费方按它/asset:// 直读，MUST NOT 推导远程 preview URL）。 */
	local_path?: string;
	/** 工程内封面相对路径（assets/broll-cover/<id>.jpg），可缺省待铺轨时现抽。 */
	cover_path?: string;
	// 本地附加
	excluded_hint?: true;
	also_matched_queries?: string[];
	[k: string]: unknown;
}

/** 本地形态 clip_id 前缀（broll-plan-contract 2026-08-12 收口）：`local-<blake3-16>`。
 * 材料 id 前缀 `broll-local-` 是消费方拼 `broll-` 之后的产物，MUST NOT 出现在 clip_id 里
 * （此处独立声明避免与 matrix-lay 环依赖）。 */
const LOCAL_CLIP_PREFIX = "local-";

/** result 是否本地形态（消费方分流判据：source 标记或 local_path 存在性）。 */
export function isLocalPlanResult(r: Pick<PlanResult, "source" | "local_path">): boolean {
	return r.source === "local" || typeof r.local_path === "string";
}

/**
 * 本地形态 result 轻校验（broll-plan-contract「本地结果形态」逐条）：返回违约描述数组（空=合规）。
 * 仓内无 zod，按既有 validateSplitDoc 先例做手写校验，供组装侧/测试对拍 spec。
 */
export function validateLocalResult(r: PlanResult): string[] {
	const errs: string[] = [];
	if (r.source !== "local") errs.push('本地 result 必须带 source:"local" 标记');
	// `broll-local-…` 不以 `local-` 开头 → 双前缀形态（预置了 broll-）在此同被拦下
	if (!r.clip_id.startsWith(LOCAL_CLIP_PREFIX)) {
		errs.push(
			`clip_id 必须为 ${LOCAL_CLIP_PREFIX}<blake3-16> 且 MUST NOT 预置 broll- 前缀（得到 ${r.clip_id}）——材料 id 由消费方拼 broll-+clip_id 得出`,
		);
	}
	if (typeof r.local_path !== "string" || !r.local_path) errs.push("本地 result 缺 local_path（素材绝对路径）");
	for (const k of ["url", "cover_url", "url_ttl_note"] as const) {
		if (k in r) errs.push(`本地 result MUST NOT 出现 ${k}（无签名过期语义）`);
	}
	const segs = r.segments ?? [];
	for (let i = 1; i < segs.length; i++) {
		if (segs[i]!.score > segs[i - 1]!.score) {
			errs.push("segments 必须按 score 降序");
			break;
		}
	}
	for (const s of segs) {
		if (!(s.start <= s.best && s.best <= s.end)) {
			errs.push(`segment best 必须落在 [start,end] 内（${s.start}–${s.end} best=${s.best}）`);
			break;
		}
	}
	return errs;
}

export interface PlanQuery {
	query: string;
	/** 服务端回显（过滤前真实召回数）——results 的兄弟字段。 */
	recalled?: number;
	results?: PlanResult[];
	error?: { code?: number; msg: string };
}

export interface PlanBeat {
	beat: string;
	track_st: number;
	track_ed: number;
	requested_shots?: number;
	per_shot_sec?: number;
	exclude?: string[];
	queries: PlanQuery[];
}

export interface BrollPlan {
	plan_version: "v1";
	generated_at: string;
	/** 云端双口沿用 internal/external；本地检索（--local）为 "local"。 */
	member_type: "internal" | "external" | "local";
	/** 常量注记（云端形态必含）：结果 url 带签名默认 24h 过期，重跑 gtrk matrix 即重签。
	 * 本地形态 MUST NOT 出现（无签名过期语义，broll-plan-contract）。 */
	url_ttl_note?: string;
	project_slug?: string;
	column_id?: string;
	beats: PlanBeat[];
}

export const URL_TTL_NOTE = "结果 url 带签名默认 24h 过期；过期后重跑 gtrk matrix 即重签（plan 幂等重生成）。";

export interface SearchFilters {
	min_duration?: number;
	max_duration?: number;
	orientation?: string;
	min_width?: number;
	/** clip_id 维度排除——同 column_tag_ids,一律字符串防大整数精度(服务端 int() 兼容)。本期未用。 */
	exclude_ids?: string[];
	level?: string;
	is_copyright?: boolean;
}

/** custom 口（矩阵成员）请求体；通用口 = 去掉 material_class/column_tag_ids/facets。 */
export interface SearchBody {
	query: string;
	top_k: number;
	material_class?: string;
	/** 字符串数组原样（服务端 int() 逐元素兼容；JS 侧绝不 parse 成 number）。 */
	column_tag_ids?: string[];
	facets?: Record<string, unknown>;
	filters?: SearchFilters;
}

export interface SearchRespData {
	request_id?: string | null;
	recalled?: number;
	results?: PlanResult[];
}

// ── 路由（不降级不缓存）──────────────────────────────────────────────────

export type Tier = "internal" | "external";

export const ENDPOINTS: Record<Tier, string> = {
	internal: "/task/custom/search",
	external: "/task/video_clip_search",
};

/** 凡非字符串 "internal" 的任何值（缺失/external/未知新档位）一律 external——与网关「仅 internal 放行」对齐。 */
export function decideRoute(memberType: unknown): { tier: Tier; endpoint: string } {
	const tier: Tier = memberType === "internal" ? "internal" : "external";
	return { tier, endpoint: ENDPOINTS[tier] };
}

// ── 请求构建（派单翻译 + 栏目配置注入）───────────────────────────────────

/** 宽召回系数：top_k = clamp(shots*3, 10, 50)。联调后可调，plan 里记 requested_shots 供对照。 */
const WIDE_RECALL_FACTOR = 3;
const TOP_K_MIN = 10;
const TOP_K_MAX = 50; // 服务端硬上限（超 50 静默钳位）
const TOP_K_DEFAULT = 10;

function asPositiveInt(v: unknown): number | undefined {
	return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}
function asPositiveNum(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function shotsToTopK(shots: unknown, override?: number): number {
	if (override && override > 0) return Math.min(Math.max(Math.floor(override), 1), TOP_K_MAX);
	const n = asPositiveInt(shots);
	if (!n) return TOP_K_DEFAULT;
	return Math.min(Math.max(n * WIDE_RECALL_FACTOR, TOP_K_MIN), TOP_K_MAX);
}

/** facets = facet_defaults 经 facet_allowed 剪除（INTERSECTION 语义消费端执行）；值不预检（白名单权威在服务端）。 */
export function trimFacets(
	defaults: Record<string, unknown> | undefined,
	allowed: string[] | undefined,
): Record<string, unknown> | undefined {
	if (!defaults || typeof defaults !== "object") return undefined;
	const entries = Object.entries(defaults).filter(([k]) => !allowed || allowed.includes(k));
	return entries.length ? Object.fromEntries(entries) : undefined;
}

const MATERIAL_CLASSES = ["real_shot", "concept"] as const;

export function buildSearchBody(
	tier: Tier,
	query: string,
	dispatch: Pick<FilmDispatch, "shots" | "per_shot_sec"> | undefined,
	broll: ColumnBroll | undefined,
	overrides: { topK?: number; materialClass?: string } = {},
): SearchBody {
	const body: SearchBody = { query, top_k: shotsToTopK(dispatch?.shots, overrides.topK) };

	const perShot = asPositiveNum(dispatch?.per_shot_sec);
	if (perShot) body.filters = { min_duration: perShot };

	if (tier === "internal") {
		// 栏目配置显式消费——external 三项全不注入（通用口契约没有这些参数，零污染）
		if (broll?.column_tag_ids?.length) body.column_tag_ids = [...broll.column_tag_ids];
		const mc = overrides.materialClass ?? broll?.material_class_policy;
		if (mc && (MATERIAL_CLASSES as readonly string[]).includes(mc)) body.material_class = mc;
		const facets = trimFacets(broll?.facet_defaults, broll?.facet_allowed);
		if (facets) body.facets = facets;
	}
	return body;
}

// ── plan 构建（beat 内去重 + exclude 标记 + 失败局部化）─────────────────

function strArr(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v.filter((x): x is string => typeof x === "string");
	return out.length ? out : undefined;
}

/** exclude 词命中 note → excluded_hint 标记（标记不删除：出参文本仅 note，判不全；删除会无声损召回）。 */
export function markExcluded(results: PlanResult[], exclude: string[] | undefined): void {
	if (!exclude?.length) return;
	for (const r of results) {
		if (typeof r.note === "string" && r.note && exclude.some((w) => (r.note as string).includes(w))) {
			r.excluded_hint = true;
		}
	}
}

/** beat 内跨 query 按 clip_id 去重：保 score 最高的出现，其余 query 记进 also_matched_queries。跨 beat 不去重。 */
export function dedupeBeatQueries(queries: PlanQuery[]): void {
	// clip_id(字符串) → 当前最优 { query 下标, result 引用 }
	const bestByClip = new Map<string, { qi: number; r: PlanResult }>();
	for (let qi = 0; qi < queries.length; qi++) {
		for (const r of queries[qi].results ?? []) {
			const prev = bestByClip.get(r.clip_id);
			if (!prev || r.score > prev.r.score) bestByClip.set(r.clip_id, { qi, r });
		}
	}
	for (let qi = 0; qi < queries.length; qi++) {
		const q = queries[qi];
		if (!q.results) continue;
		q.results = q.results.filter((r) => {
			const best = bestByClip.get(r.clip_id)!;
			if (best.qi === qi && best.r === r) return true;
			// 被去重：把本 query 记到胜者的 also_matched_queries
			const list = (best.r.also_matched_queries ??= []);
			if (!list.includes(q.query)) list.push(q.query);
			return false;
		});
	}
}

export interface QueryOutcome {
	query: string;
	data?: SearchRespData;
	error?: { code?: number; msg: string };
}

export function buildPlanBeat(entry: FilmDispatch, outcomes: QueryOutcome[]): PlanBeat {
	const beat: PlanBeat = {
		beat: entry.beat,
		track_st: entry.track_st,
		track_ed: entry.track_ed,
		queries: [],
	};
	// 派单原值透传（挑选 UI 的建议数据）
	const shots = asPositiveInt(entry.shots);
	if (shots) beat.requested_shots = shots;
	const perShot = asPositiveNum(entry.per_shot_sec);
	if (perShot) beat.per_shot_sec = perShot;
	const exclude = strArr(entry.exclude);
	if (exclude) beat.exclude = exclude;

	for (const o of outcomes) {
		if (o.error) {
			beat.queries.push({ query: o.query, error: o.error });
			continue;
		}
		const results = (o.data?.results ?? []).map((r) => ({ ...r }));
		markExcluded(results, exclude);
		const pq: PlanQuery = { query: o.query, results };
		if (typeof o.data?.recalled === "number") pq.recalled = o.data.recalled; // results 的兄弟字段
		beat.queries.push(pq);
	}
	dedupeBeatQueries(beat.queries);
	return beat;
}

export function buildPlan(opts: {
	generatedAt: string;
	memberType: Tier | "local";
	projectSlug?: string;
	columnId?: string;
	beats: PlanBeat[];
}): BrollPlan {
	const plan: BrollPlan = {
		plan_version: "v1",
		generated_at: opts.generatedAt,
		member_type: opts.memberType,
		// 本地 plan 无 url 签名语义 → url_ttl_note MUST NOT 出现；云端形态与本 change 之前逐字节一致
		...(opts.memberType === "local" ? {} : { url_ttl_note: URL_TTL_NOTE }),
		beats: opts.beats,
	};
	if (opts.projectSlug) plan.project_slug = opts.projectSlug;
	if (opts.columnId) plan.column_id = opts.columnId;
	return plan;
}

// ── 错误分类（按 body.code；HTTP 状态仅网络兜底）─────────────────────────

export function classifyApiError(code: number | undefined, msg?: string): string {
	switch (code) {
		case 400:
			return `请求体非法（网关校验）：${msg || "请求参数或请求体格式错误"}`;
		case 6502:
			return "鉴权失败——检查 API Key（gtrk init 重配）";
		case 403:
			return "非矩阵成员或身份可能已变更——矩阵成员口（custom/search）仅对 internal 档位开放";
		case 6401:
			// 双语义：master 层参数错误经网关代理后也以 6401 呈现
			return "检索上游故障，或检索参数/栏目配置非法（如 facets 值拼写）——稍后重试仍失败请检查栏目配置的 broll 块";
		case 6402:
			return "检索上游超时——稍后重试";
		default:
			return `云端错误 (code=${code ?? "?"})：${msg || "未知错误"}`;
	}
}

// ── HTTP 调用（薄封装，超时 25s：网关硬超时 15s 必先回包）────────────────

export const SEARCH_TIMEOUT_MS = 25_000;

/** 身份探针：POST /user/get_user_info（无 body 参数）。探针失败 = 整体失败（没有身份就没有正确的口）。 */
export async function probeMemberType(cfg: CloudConfig): Promise<Tier> {
	const res = await fetch(`${cfg.base}/user/get_user_info`, {
		method: "POST",
		headers: { accept: "application/json", Authorization: cfg.apiKey },
		body: "",
		signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
	});
	const r = await parseJson<{ matrix_member_type?: unknown }>(res);
	if (r.code !== 200) throw new CloudError(r.code, classifyApiError(r.code, r.msg));
	return decideRoute(r.data?.matrix_member_type).tier;
}

/** 把响应文本里的大整数 clip_id 引号化后再 JSON.parse——JSON.parse 对 >2^53 的 number 丢精度且不可逆,
 * 必须在文本层拦截（reviver 拿到的已是丢精度的 number,来不及）。 */
export function parseClipIdSafe<T>(text: string, status: number): ApiResp<T> {
	try {
		return JSON.parse(text.replace(/"clip_id"\s*:\s*(\d+)/g, '"clip_id":"$1"')) as ApiResp<T>;
	} catch {
		throw new Error(`服务响应解析失败 (HTTP ${status})`);
	}
}

/** 单次检索调用。抛 CloudError（含分类文案）——调用方决定局部化还是整体失败。 */
export async function searchOnce(cfg: CloudConfig, tier: Tier, body: SearchBody): Promise<SearchRespData> {
	const res = await fetch(`${cfg.base}${ENDPOINTS[tier]}`, {
		method: "POST",
		headers: { accept: "application/json", "Content-Type": "application/json", Authorization: cfg.apiKey },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
	});
	const r = parseClipIdSafe<SearchRespData>(await res.text(), res.status);
	if (r.code !== 200) throw new CloudError(r.code, classifyApiError(r.code, r.msg));
	return r.data ?? {};
}
