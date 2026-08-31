/**
 * B-roll 本地素材编排 —— 上行投影层（change: add-broll-arrange-atom P2.1）。
 *
 * 把本地 `BrollPlan` 投影成上行请求体。服务端对应件 infra `add-broll-arrange-api`
 * （`POST /task/cli/broll_arrange`）。
 *
 * ## 适用面（主理人 2026-08-29 终裁）
 *
 * **只承担本地素材上轨铺排这条业务线。** 素材矩阵路（素材库检索 → 客户端挑选 →
 * 确认 / 快速模式铺到位）的编排决策**继续在本地跑、逐字不动**——按业务线切，不按算法切。
 *
 * ## 硬判据：决策链零读的字段一律不上行
 *
 * 被砍掉的恰好是隐私最脏的一批：绝对路径 / note / 负词 / describe 文本 / 签名 URL /
 * 几何列。实测 12-beat 真实工程 435KB → 投影后 60KB。
 *
 * ★ **白名单而非黑名单**，这条是结构性的：`PlanResult` 带 `[k: string]: unknown`
 * 开放索引签名，任何人往 plan 里塞新字段都合法。黑名单只能挡住写它那天已知的那些，
 * 明天新增的脏字段会**静默上行**——而且没有任何测试会红。白名单反过来：新字段默认
 * 不上行，要上行必须有人来这里显式加一行，那一行就是审查点。
 *
 * ## 上行集是怎么定的：从服务端**实读**字段反推
 *
 * 不是照着 design 的字段表抄，而是把移植后的决策层（infra
 * `utils/process/media/vision/broll_arrange/`）里所有 `r.get(...)` / `s[...]` 扫一遍，
 * 得到 result 级 10 键、segment 级 6 键、beat 级 8 键、anchor 级 3 键。
 * 判据是「投影前后本地 `planBeatFills` 产物**逐字节相同**」，由 26 份金样对拍钉死
 * （见 `test/broll-arrange-wire.test.mjs`）——那条测试同时证明了两件事：
 * 没多传（隐私）、没少传（正确性）。
 *
 * ## 三处形态是刻意「不优化」的
 *
 * 服务端已带 26 份金样上线，**MUST NOT 为了让上行体好看而改它**。故：
 *
 * 1. `is_local` 上行成 `source: "local"` 而不是布尔 —— 服务端判据逐字是
 *    `source == "local" or isinstance(local_path, str)`。`"local"` 是 5 字节枚举常量，
 *    **不是路径**；design 要求不上行的是 `local_path` 的**值**，此处正满足。
 * 2. `blurry` 上行成 `describe.usable_flags.blurry` 这个三层嵌套 —— 服务端从那里读。
 *    `describe` 的其余键（desc 文本 / tags / mark）是隐私最脏的部分，**一个都不带**。
 * 3. `motion_p50` 上行成 `motion: { p50 }` —— 同理。且 p50 非有限数时**整键缺席**
 *    （对齐本地 SQL 的 `IS NOT NULL` 口径：缺席 = 不可判，MUST NOT 当「平稳」用）。
 *
 * ## 三条评审红线
 *
 * 1. **query 原文上行**：服务端 `pool_by_query` 按字符串建表，锚也按字符串找池。
 *    纯下标会让两端取到不同池、锚钉到不同素材。隐私不亏（query 本来就发云端检索）。
 * 2. **mark / highlight 是两张独立值表**：本地两条独立 SQL（highlight 多一个
 *    `AND highlight IS NOT NULL` 谓词），可命中不同行不同距离。MUST 本地跑完两条查询、
 *    上行**已决议分值**；MUST NOT 合并成一张表。
 * 3. **queries 数组一条都不许丢**：顺序即叙事轮转序。空 results 的 query 也照传——
 *    丢一条，轮转序整体错位一格，而落轨字节照样合法、永不被发现。
 */

import type { ArrangeTier, BrollPlan, DirectSlot, PlanAnchor, PlanBeat, PlanQuery, PlanResult } from "./matrix";
import type { DedupScope, GapFillMode, MarkLookup } from "./matrix-lay";
// ★ 值import：值表探针键的段枚举 MUST 与候选池同源，见 `materializeSignalTable` 头注。
import { segmentsOf } from "./matrix-lay";
import { METERING_ALGO_PIN, arrangeUnits, scaleOfRequest } from "./arrange-metering";

// ── 上行体形态 ────────────────────────────────────────────────────────────

/** 段级上行形态（6 键；`cuts` / `motion` 缺省即整键缺席）。 */
export interface WireSegment {
	start: number;
	end: number;
	best: number;
	score: number;
	/** 段内已知场景切点。MUST NOT 裁剪或近似——丢了就退回闪帧（唯一量级风险字段）。 */
	cuts?: number[];
	/** 只带 p50 一维；不可判时整键缺席（不是 0，也不是 null）。 */
	motion?: { p50: number };
}

/** 候选级上行形态。`url` / `cover_url` / `local_path` / `note` / `width` / `height` /
 * `describe.desc` / `describe.tags` / `matched` / `also_matched_queries` 一律不在此。 */
export interface WireResult {
	clip_id: string;
	score: number;
	kind?: "video" | "image";
	/** 恒为字面量 `"local"`，仅当本地形态时出现——枚举常量，不是路径。 */
	source?: "local";
	fps?: number;
	duration?: number;
	pinned?: true;
	excluded_hint?: true;
	/** 只带 blurry 一个信号位；describe 的其余键（含全部文本）不上行。 */
	describe?: { usable_flags: { blurry: true } };
	segments?: WireSegment[];
}

export interface WireQuery {
	/** 红线 1：原文，MUST NOT 换成下标。 */
	query: string;
	results?: WireResult[];
}

/** 锚级上行形态。★ `utterance`（口播原文整句）**不上行**——服务端零读，纯展示用。 */
export interface WireAnchor {
	keyword: string;
	at_sec: number | null;
	query: string;
}

export interface WireBeat {
	/** ★ 进 FNV-1a 随机种子，**不可匿名化**（改一个字符，整条轨的镜头顺序全变）。 */
	beat: string;
	track_st: number;
	track_ed: number;
	per_shot_sec?: number;
	requested_shots?: number;
	anchors?: WireAnchor[];
	/** 红线 3：顺序即叙事轮转序，一条都不许丢。 */
	queries: WireQuery[];
	/** 编排档位，**逐 beat**（design §3 同片可混档）。缺席 = 未标注，服务端按低档处置。
	 * ⚠️ 这个 `mode` 是**编排策略**，与取数路 `ArrangeMode`（local|shadow|cloud）无关，见 matrix.ts 的 ArrangeTier。 */
	arrange_mode?: ArrangeTier;
	/** 直排槽（高档入参）。缺席 = 本 beat 无出处直给。 */
	direct_slots?: WireDirectSlot[];
}

/** 上行的直排槽。与本地 `DirectSlot` 同构——本层只做投影不做变形。 */
export interface WireDirectSlot {
	clip_id: string;
	clip_st: number;
	clip_ed: number;
	track_st?: number;
	track_ed?: number;
	query?: string;
}

export interface WirePlan {
	plan_version: "v1";
	member_type: "internal" | "external" | "local";
	beats: WireBeat[];
}

/** 值表：键 = `${clip_id}@${tsMs}`，与服务端 `_table_lookup` 的拼法逐字一致。 */
export type WireSignalTable = Record<string, number>;

export interface WireOpts {
	noImage?: boolean;
	dedupScope?: DedupScope;
	markWeight?: number;
	highlightWeight?: number;
	/** 红线 2：与 highlightTable **两张独立表**，MUST NOT 合并。 */
	markTable?: WireSignalTable;
	highlightTable?: WireSignalTable;
	cutAlign?: { ratio: number; starts: number[] };
	gapFill?: GapFillMode;
}

export interface ArrangeRequest {
	plan: WirePlan;
	lay: number;
	score_floor: number;
	/** 计量口径版本。服务端不认识的版本会拒绝，**不会**回落默认价目执行。 */
	algo_pin: string;
	/** 本地用同一公式自算的编排量，**仅供服务端做一致性校验**。
	 * ⚠️ 它**不是**计费依据——计费恒以服务端复算值为准（两值一致时同样成立）。 */
	estimated_units: number;
	/** 本次调用的编排量硬上限；超限服务端**前置拒绝**、零执行零计费。 */
	cost_cap?: number;
	opts?: WireOpts;
}

/** 本地决策层入参（`planBeatFills` 的 opts 子集，含闭包形态的值表）。 */
export interface LocalArrangeOpts {
	noImage?: boolean;
	dedupScope?: DedupScope;
	markWeight?: number;
	markLookup?: MarkLookup;
	highlightWeight?: number;
	highlightLookup?: MarkLookup;
	cutAlign?: { ratio: number; starts: number[] };
	gapFill?: GapFillMode;
}

// ── 投影 ──────────────────────────────────────────────────────────────────

/** 有限数才透传；其余（undefined / null / NaN / Infinity）一律**整键缺席**。
 * 缺席与 0 在决策层是不同语义（fps 缺席 ⇒ 帧吸附整步跳过），不可用 0 兜底。 */
function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function projectSegment(s: NonNullable<PlanResult["segments"]>[number]): WireSegment {
	const out: WireSegment = { start: s.start, end: s.end, best: s.best, score: s.score };
	// cuts 原样透传（MUST NOT 裁剪或近似）；非数组即整键缺席
	if (Array.isArray(s.cuts)) out.cuts = s.cuts.slice();
	// 同本地 SQL 的 IS NOT NULL 口径：不可判 ⇒ 整键缺席，MUST NOT 当「平稳」用
	const p50 = num(s.motion?.p50);
	if (p50 !== undefined) out.motion = { p50 };
	return out;
}

function projectResult(r: PlanResult): WireResult {
	const out: WireResult = { clip_id: r.clip_id, score: r.score };
	if (r.kind === "image" || r.kind === "video") out.kind = r.kind;
	// 逐字对齐服务端判据 `source=="local" || 有 local_path`：本地形态上行枚举常量，
	// **路径的值不出域**。两条本地判据在此归一成一条——服务端看到的是同一个结论。
	if (r.source === "local" || typeof r.local_path === "string") out.source = "local";
	const fps = num(r.fps);
	if (fps !== undefined) out.fps = fps;
	const duration = num(r.duration);
	if (duration !== undefined) out.duration = duration;
	if (r.pinned === true) out.pinned = true;
	if (r.excluded_hint) out.excluded_hint = true;
	// describe 只取 blurry 一个信号位；desc / tags / mark 一律不上行
	if ((r.describe?.usable_flags as Record<string, unknown> | undefined)?.blurry === true) {
		out.describe = { usable_flags: { blurry: true } };
	}
	if (Array.isArray(r.segments)) out.segments = r.segments.map(projectSegment);
	return out;
}

function projectQuery(q: PlanQuery): WireQuery {
	// `recalled`（服务端回显的召回数）与 `error` 决策层零读，不上行
	const out: WireQuery = { query: q.query };
	if (Array.isArray(q.results)) out.results = q.results.map(projectResult);
	return out;
}

function projectAnchor(a: PlanAnchor): WireAnchor {
	// ★ utterance（口播原文整句）零读，不上行
	return { keyword: a.keyword, at_sec: num(a.at_sec) ?? null, query: a.query };
}

/** 直排槽投影（add-arrange-direct-tier）：源窗必传，时间线位置成对传或都不传。
 * `query` 传**原文**——红线 1：q_idx 会因空池折叠而错位。 */
function projectDirectSlot(d: DirectSlot): WireDirectSlot {
	const out: WireDirectSlot = { clip_id: d.clip_id, clip_st: d.clip_st, clip_ed: d.clip_ed };
	const ts = num(d.track_st);
	const te = num(d.track_ed);
	// 成对才传：只给一半是无意义的半个约束，投影层不替它猜另一半
	if (ts !== undefined && te !== undefined) {
		out.track_st = ts;
		out.track_ed = te;
	}
	if (d.query) out.query = d.query;
	return out;
}

function projectBeat(b: PlanBeat): WireBeat {
	// `exclude[]`（派单负词）决策层零读——本地已折算进候选的 excluded_hint，不上行
	const out: WireBeat = {
		beat: b.beat,
		track_st: b.track_st,
		track_ed: b.track_ed,
		// 红线 3：queries 原序原条数，空 results 的也照传
		queries: b.queries.map(projectQuery),
	};
	const per = num(b.per_shot_sec);
	if (per !== undefined) out.per_shot_sec = per;
	const req = num(b.requested_shots);
	if (req !== undefined) out.requested_shots = req;
	if (Array.isArray(b.anchors) && b.anchors.length) out.anchors = b.anchors.map(projectAnchor);
	// ★ 档位**逐 beat 取自 beat 自己**（design §3「档位逐 beat 标注，同一片内可混档」）。
	//   此前是整份 plan 一个值铺给所有 beat，那样混档在结构上就不可能。
	//   ⚠️ 缺席即整键不上行，**MUST NOT 补成 "semantic"**——同 motion/fps 的既有纪律：
	//   缺席是「没标注」，补默认值会让服务端分不清「用户选了低档」与「用户没选」。
	if (b.arrange_mode) out.arrange_mode = b.arrange_mode;
	if (Array.isArray(b.direct_slots) && b.direct_slots.length) out.direct_slots = b.direct_slots.map(projectDirectSlot);
	return out;
}

/**
 * 值表物化：把本地的查询闭包变成可上行的字典。
 *
 * 探针键取「决策层会查的每一个 `(clip_id, tsMs)`」——枚举 MUST 走 `matrix-lay` 的
 * `segmentsOf`，**与候选池共用同一个函数**（含无 `segments` 候选降级出的整片伪段）。
 * 这个集合是**有限且可枚举**的，所以物化不丢信息，也不会多带（不会把整张缓存表倒上去）。
 *
 * ⚠️ 这里曾经自己写过一遍 `r.segments ?? []`，并在注释里声称「与 matrix-lay 某行逐字一致」
 * ——写下那句时它就不一致：无 `segments` 的候选决策层会去查整片伪段的位点，
 * 而这里从没探测过它。症状不是报错，是**云端与本地复算的融合分不同 ⇒ 落位不同 ⇒
 * cloud 档自校验判不一致 ⇒ 一份已计费的产物被丢弃**。
 * 故 MUST NOT 再把枚举抄一份到本文件，注释形式的「口径一致」承诺也 MUST NOT 复辟。
 *
 * ⚠️ 命中不到的 `(clip, ts)` **不进表**：缺席在服务端语义是「该维度无缓存，权重回吐给
 * 语义分」；若补成 0，会变成「该维度得 0 分」——两者对排序的影响方向相反。
 * 「探哪些键」与「查不到写不写」是两件事，本条不受上面那条修正影响。
 */
export function materializeSignalTable(plan: BrollPlan, lookup: MarkLookup): WireSignalTable {
	const table: WireSignalTable = {};
	for (const beat of plan.beats) {
		for (const q of beat.queries) {
			for (const r of q.results ?? []) {
				for (const seg of segmentsOf(r)) {
					const tsMs = Math.round(seg.best * 1000);
					const key = `${r.clip_id}@${tsMs}`;
					if (key in table) continue;
					const v = lookup(r.clip_id, tsMs);
					if (typeof v === "number" && Number.isFinite(v)) table[key] = v;
				}
			}
		}
	}
	return table;
}

function projectOpts(plan: BrollPlan, opts: LocalArrangeOpts): WireOpts | undefined {
	const out: WireOpts = {};
	if (opts.noImage !== undefined) out.noImage = opts.noImage;
	if (opts.dedupScope !== undefined) out.dedupScope = opts.dedupScope;
	if (opts.markWeight !== undefined) out.markWeight = opts.markWeight;
	if (opts.highlightWeight !== undefined) out.highlightWeight = opts.highlightWeight;
	// 红线 2：两条独立查询、两张独立表，MUST NOT 合并
	if (opts.markLookup) {
		const t = materializeSignalTable(plan, opts.markLookup);
		if (Object.keys(t).length) out.markTable = t;
	}
	if (opts.highlightLookup) {
		const t = materializeSignalTable(plan, opts.highlightLookup);
		if (Object.keys(t).length) out.highlightTable = t;
	}
	if (opts.cutAlign) out.cutAlign = { ratio: opts.cutAlign.ratio, starts: opts.cutAlign.starts.slice() };
	// gapFill 已由命令层按工程形态门控（服务端看不见 .gtrk，MUST 上行门控后的**有效值**）
	if (opts.gapFill !== undefined) out.gapFill = opts.gapFill;
	return Object.keys(out).length ? out : undefined;
}

/**
 * plan → 上行请求体。**唯一一处「本地世界 → 线上世界」的翻译**。
 *
 * `estimated_units` 由本地同一机械公式算出，随请求上行**仅供服务端一致性校验**；
 * 服务端会独立复算并以它自己的值计费（本体系历史上发生过客户端欺骗服务端的事件，
 * 故复算不可省——两值一致时同样成立）。
 */
export function projectArrangeRequest(
	plan: BrollPlan,
	lay: number,
	scoreFloor: number,
	opts: LocalArrangeOpts = {},
	extra: { costCap?: number } = {},
): ArrangeRequest {
	const wirePlan: WirePlan = {
		plan_version: plan.plan_version,
		member_type: plan.member_type,
		beats: plan.beats.map(projectBeat),
	};
	const wireOpts = projectOpts(plan, opts);
	const req: ArrangeRequest = {
		plan: wirePlan,
		lay,
		score_floor: scoreFloor,
		algo_pin: METERING_ALGO_PIN,
		estimated_units: arrangeUnits(scaleOfRequest(plan, lay, opts)),
	};
	if (wireOpts) req.opts = wireOpts;
	if (extra.costCap !== undefined) req.cost_cap = extra.costCap;
	return req;
}
