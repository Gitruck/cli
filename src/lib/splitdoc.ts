/**
 * 拆分稿机器契约 v1 —— 解析 / 校验 / 落地投影（纯逻辑，不碰文件 IO）。
 *
 * 校验（split-doc-contract spec）：结构/枚举 → id 合法性（存在/from≤to/beats 不重叠）→ handoff 按 lane 分型
 * → transcript_hash 硬拒。错误逐条含 beat id + 原因。落地（timeline-projection spec）：整 beat 全 dropped → 跳过
 * 并入 report；部分 dropped → 按存活包络收缩、标 shrunk。落地产 struct_meta.split 快照 + dispatch 派单清单。
 */
import type { ProjectionView } from "./projection";

export const BASE_TRACKS = ["真人出镜", "口播继续", "旁白主导"] as const;
export const LANES = ["A_ROLL", "MG", "AI_DRAMA", "FILM_BROLL"] as const;
export const NARRATIVES = [
	"mirror-hook",
	"demolition",
	"container-translation",
	"abyssal-fall",
	"holding",
	"reversal-elevation",
	"callback-closure",
	"typography-emphasis",
] as const;
export const CONTAINER_STAGES = [
	"none",
	"seed",
	"expand",
	"translate",
	"rupture",
	"flip",
	"callback",
] as const;
export const IRREPLACEABILITY = ["必须真人出镜", "优先 MG", "可被 B-roll 替代", "可降级处理"] as const;
export const AUX_TYPES = [
	"quote-card",
	"term-callout",
	"network-diagram",
	"archive-caption",
	"pause-card",
	"data-annotation",
	"timeline-tag",
	// 第八枚（add-aux-rrv-overlay-particle）：承接透明叠层颗粒派单的 aux 类型——
	// 与前七枚纯建议性不同，overlay aux 必带 handoff（duration_hint 正数）、由 buildLanding
	// 投影进 dispatch.mg + 合成 struct_meta.split.beats（lane=MG），铺出叠在底轨主视觉上的透明颗粒。
	"overlay",
] as const;

export type Lane = (typeof LANES)[number];

/**
 * 遗留 lane 别名（去品牌化读旧兼容）：既有工程/拆分稿的品牌名读入即归一为中性名。
 * 写侧一律新名（buildLanding/struct_meta/dispatch）；此表只服务读侧双名认旧。
 */
const LEGACY_LANE_ALIASES: Record<string, Lane> = { RRV_MG: "MG" };

/** lane 归一：命中中性枚举或遗留别名即返回中性 Lane；否则 undefined（非法）。 */
export function normalizeLane(v: unknown): Lane | undefined {
	if (typeof v !== "string") return undefined;
	if ((LANES as readonly string[]).includes(v)) return v as Lane;
	return LEGACY_LANE_ALIASES[v];
}

export interface SplitSpan {
	from: string;
	to: string;
}

/** 辅助层挂载范围三型：整 beat / id 区间 / 触发点。 */
export type AuxMount = "same_beat" | { from: string; to: string } | { trigger: string };

export interface SplitAuxLayer {
	type: string;
	mount: AuxMount;
	role: string;
	note?: string;
	necessity?: string;
	promote_condition?: string;
	fallback?: string;
	/**
	 * 颗粒派单入参（add-aux-rrv-overlay-particle）：仅 `type==="overlay"` 的 aux 承接——
	 * 镜像 MG lane 的 handoff。`duration_hint`（正数秒）必填，其余可选透传给派生颗粒。
	 */
	handoff?: { duration_hint: number; category?: string; slug_hint?: string; theme?: string; bg?: string };
}

export interface SplitBeat {
	id: string;
	span: SplitSpan;
	base_track: string;
	lane: string;
	narrative: string;
	container_stage: string;
	rhythm: string;
	visual_task: string;
	irreplaceability: string;
	handoff?: Record<string, unknown>;
	aux_layers?: SplitAuxLayer[];
	fallback?: string;
	callback_of?: string;
	note?: string;
}

export interface SplitDoc {
	contract_version: string;
	transcript_hash: string;
	beats: SplitBeat[];
	queues?: Record<string, unknown>;
}

/** splitdoc 校验用词表（来自有效栏目配置，column-config spec）。 */
export interface VocabCtx {
	narrative: readonly string[];
	container_stage: readonly string[];
	base_track: readonly string[];
	/** "allow" 时 narrative/container_stage/base_track 三项不做枚举校验（纯自由串，完全异构栏目）。 */
	unknown_narrative?: "allow" | "reject";
}

/** 校验上下文：utterance id 的**权威源序**（用于区间/重叠判定）+ 当前 transcript 的 text_hash。 */
export interface ValidationCtx {
	utteranceIds: string[];
	transcriptHash: string;
	/** 有效栏目配置的 vocab；缺省 = 内置默认（现枚举），校验行为与词表化前一致。 */
	vocab?: VocabCtx;
}

export interface ValidationResult {
	errors: string[];
	warnings: string[];
}

function isNonEmptyStr(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function enumOk<T extends readonly string[]>(v: unknown, list: T): boolean {
	return typeof v === "string" && (list as readonly string[]).includes(v);
}

/**
 * 全量校验拆分稿。返回逐条错误 + 警告；`errors` 非空即整体拒绝（命令层非 0 退出、零副作用）。
 */
export function validateSplitDoc(doc: unknown, ctx: ValidationCtx): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
		return { errors: ["拆分稿必须是一个 JSON 对象"], warnings };
	}
	const d = doc as Record<string, unknown>;

	// 校验源 = 有效栏目 vocab；缺省 = 内置枚举（默认栏目行为不变）。unknown_narrative=allow 时该三项放行自由串。
	const vocab: VocabCtx = ctx.vocab ?? {
		narrative: NARRATIVES,
		container_stage: CONTAINER_STAGES,
		base_track: BASE_TRACKS,
	};
	const freeVocab = vocab.unknown_narrative === "allow";

	if (d.contract_version !== "v1") {
		errors.push(`contract_version 必须为 "v1"（实际：${JSON.stringify(d.contract_version)}）`);
	}
	if (!isNonEmptyStr(d.transcript_hash)) {
		errors.push("缺 transcript_hash（应从投影视图透传）");
	} else if (d.transcript_hash !== ctx.transcriptHash) {
		errors.push(
			`transcript_hash 不匹配：拆分稿 ${d.transcript_hash} ≠ 当前 transcript ${ctx.transcriptHash}——转写已变更，请重新导出视图并重拆`,
		);
	}

	if (!Array.isArray(d.beats) || d.beats.length === 0) {
		errors.push("beats 必须是非空数组");
		return { errors, warnings };
	}

	const idIndex = new Map<string, number>();
	ctx.utteranceIds.forEach((id, i) => idIndex.set(id, i));

	// 逐 beat 校验，同时收集合法区间供重叠检测
	const ranges: { id: string; from: number; to: number }[] = [];
	const seenBeatIds = new Set<string>();

	(d.beats as unknown[]).forEach((raw, i) => {
		const tag = (() => {
			const bid = (raw as Record<string, unknown>)?.id;
			return isNonEmptyStr(bid) ? bid : `beats[${i}]`;
		})();
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			errors.push(`${tag}：beat 必须是对象`);
			return;
		}
		const b = raw as Record<string, unknown>;

		if (!isNonEmptyStr(b.id)) errors.push(`${tag}：缺 id`);
		else if (!/^B\d{2,}$/.test(b.id)) errors.push(`${b.id}：id 须为 "B"+两位起序号（如 B01）`);
		else if (seenBeatIds.has(b.id)) errors.push(`${b.id}：beat id 重复`);
		else seenBeatIds.add(b.id);

		// base_track/narrative/container_stage 校验源 = 栏目 vocab（默认=内置枚举）；allow 时放行自由串（仍须非空）
		if (freeVocab) {
			if (!isNonEmptyStr(b.base_track)) errors.push(`${tag}：缺 base_track`);
			if (!isNonEmptyStr(b.narrative)) errors.push(`${tag}：缺 narrative`);
			if (!isNonEmptyStr(b.container_stage)) errors.push(`${tag}：缺 container_stage`);
		} else {
			if (!enumOk(b.base_track, vocab.base_track)) errors.push(`${tag}：base_track 非法（栏目词表：${vocab.base_track.join(" | ")}）`);
			if (!enumOk(b.narrative, vocab.narrative)) errors.push(`${tag}：narrative 非法（不在栏目词表内）`);
			if (!enumOk(b.container_stage, vocab.container_stage)) errors.push(`${tag}：container_stage 非法（不在栏目词表内）`);
		}
		// lane 双名认旧：遗留品牌值（如 RRV_MG）归一后放行，不判非法（既有工程零迁移）
		if (!normalizeLane(b.lane)) errors.push(`${tag}：lane 非法（四选一：${LANES.join(" | ")}）`);
		if (!enumOk(b.irreplaceability, IRREPLACEABILITY)) errors.push(`${tag}：irreplaceability 非法（四枚举之一）`);
		if (!isNonEmptyStr(b.rhythm)) errors.push(`${tag}：缺 rhythm（人读节奏标签）`);
		if (!isNonEmptyStr(b.visual_task)) errors.push(`${tag}：缺 visual_task（一句话视觉任务）`);

		// span 与 id 合法性
		const span = b.span as Record<string, unknown> | undefined;
		let fromIdx = -1;
		let toIdx = -1;
		if (!span || !isNonEmptyStr(span.from) || !isNonEmptyStr(span.to)) {
			errors.push(`${tag}：缺 span.from / span.to（utterance id 区间）`);
		} else {
			if (!idIndex.has(span.from)) errors.push(`${tag}：span.from 引用了不存在的 utterance id ${span.from}`);
			else fromIdx = idIndex.get(span.from)!;
			if (!idIndex.has(span.to)) errors.push(`${tag}：span.to 引用了不存在的 utterance id ${span.to}`);
			else toIdx = idIndex.get(span.to)!;
			if (fromIdx >= 0 && toIdx >= 0) {
				if (fromIdx > toIdx) errors.push(`${tag}：区间倒序（span.from ${span.from} 晚于 span.to ${span.to}）`);
				else if (isNonEmptyStr(b.id)) ranges.push({ id: b.id, from: fromIdx, to: toIdx });
			}
		}

		// handoff 按 lane 分型
		validateHandoff(tag, b, errors, warnings);

		// 辅助层
		if (b.aux_layers != null) {
			if (!Array.isArray(b.aux_layers)) errors.push(`${tag}：aux_layers 必须是数组`);
			else (b.aux_layers as unknown[]).forEach((a, ai) => validateAux(`${tag}.aux[${ai}]`, a, idIndex, errors, warnings));
		}
	});

	// 区间重叠检测（按 from 升序，相邻比对）
	const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
	for (let i = 1; i < sorted.length; i++) {
		const prev = sorted[i - 1];
		const cur = sorted[i];
		if (cur.from <= prev.to) {
			errors.push(`${prev.id} 与 ${cur.id}：utterance 区间重叠（beats 之间不允许交集）`);
		}
	}

	return { errors, warnings };
}

function validateHandoff(
	tag: string,
	b: Record<string, unknown>,
	errors: string[],
	warnings: string[],
): void {
	const lane = b.lane;
	const handoff = b.handoff as Record<string, unknown> | undefined;
	if (lane === "A_ROLL") {
		if (handoff != null) warnings.push(`${tag}：A_ROLL 不应带 handoff，已忽略`);
		return;
	}
	// MG（去品牌化前 RRV_MG）：双名认旧，遗留 lane 值同走此分支
	if (lane === "MG" || lane === "RRV_MG") {
		if (!handoff || typeof handoff.duration_hint !== "number") {
			errors.push(`${tag}：MG 的 handoff.duration_hint 必填（秒，数值）`);
		}
		// category 可选软校验（裁决⑩，lane 不新增故宽松：非法只告警不拒）；已知集含新旧品类键，遗留值不告警
		if (handoff && handoff.category !== undefined && !isKnownCategory(handoff.category)) {
			warnings.push(`${tag}：handoff.category「${String(handoff.category)}」非已知品类（${MG_CATEGORIES.join("/")}），已透传但下游按 opaque 反推`);
		}
		return;
	}
	if (lane === "FILM_BROLL") {
		const q = handoff?.queries;
		if (!Array.isArray(q) || q.length === 0 || !q.every((x) => isNonEmptyStr(x))) {
			errors.push(`${tag}：FILM_BROLL 缺检索 query（handoff.queries 必须为非空字符串数组）`);
		}
		return;
	}
	// AI_DRAMA：字段全可选，下游有推断默认——不强校验
}

function validateAux(
	tag: string,
	raw: unknown,
	idIndex: Map<string, number>,
	errors: string[],
	warnings: string[],
): void {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		errors.push(`${tag}：辅助层必须是对象`);
		return;
	}
	const a = raw as Record<string, unknown>;
	if (!enumOk(a.type, AUX_TYPES)) errors.push(`${tag}：type 非法（八类之一）`);
	if (!isNonEmptyStr(a.role)) errors.push(`${tag}：缺 role（职责）`);
	// overlay 叠层颗粒类型（add-aux-rrv-overlay-particle）：强校验 handoff.duration_hint 正数
	// （该 aux 要生成颗粒，无时长不成立）；category 走软校验（非法告警不拒，同 lane 分型纪律）。
	if (a.type === "overlay") {
		const handoff = a.handoff as Record<string, unknown> | undefined;
		if (!handoff || typeof handoff.duration_hint !== "number" || !(handoff.duration_hint > 0)) {
			errors.push(`${tag}：overlay aux 缺颗粒时长（handoff.duration_hint 必填且须为正数）`);
		}
		if (handoff && handoff.category !== undefined && !isKnownCategory(handoff.category)) {
			warnings.push(`${tag}：handoff.category「${String(handoff.category)}」非已知品类（${MG_CATEGORIES.join("/")}），已透传但下游按 opaque 反推`);
		}
	}
	const m = a.mount;
	if (m === "same_beat") return;
	if (typeof m === "object" && m !== null) {
		const mo = m as Record<string, unknown>;
		if (isNonEmptyStr(mo.trigger)) {
			if (!idIndex.has(mo.trigger)) errors.push(`${tag}：mount.trigger 引用了不存在的 utterance id ${mo.trigger}`);
			return;
		}
		if (isNonEmptyStr(mo.from) && isNonEmptyStr(mo.to)) {
			if (!idIndex.has(mo.from)) errors.push(`${tag}：mount.from 引用了不存在的 utterance id ${mo.from}`);
			if (!idIndex.has(mo.to)) errors.push(`${tag}：mount.to 引用了不存在的 utterance id ${mo.to}`);
			if (idIndex.has(mo.from) && idIndex.has(mo.to) && idIndex.get(mo.from)! > idIndex.get(mo.to)!) {
				errors.push(`${tag}：mount 区间倒序`);
			}
			return;
		}
	}
	errors.push(`${tag}：mount 非法（应为 "same_beat" | {from,to} | {trigger}）`);
}

// ── 落地投影 ──────────────────────────────────────────────────────────────

export interface SplitMetaBeat {
	id: string;
	lane: string;
	span: SplitSpan;
	track_st: number;
	track_ed: number;
	shrunk?: boolean;
	handoff?: Record<string, unknown>;
	/**
	 * 源时基区间（add-split-source-ranges）：v1 恒单元素 = span 源包络 [from.st, to.ed]，
	 * 含句间静默与被剪词——消费方以「源区间 ∩ 当刻颗粒源窗口」投影即得实际覆盖，
	 * 恢复被剪词（变长）即点亮。数组形状为将来按投影实例精化预留。
	 */
	source_ranges?: { st: number; ed: number }[];
	/**
	 * 语义字段透传（add-split-source-ranges）：客户端色带 hover 详情卡展示「这段对应什么」。
	 * 原样透传拆分稿 narrative（叙事功能）/container_stage（容器阶段）/visual_task（视觉任务描述）。
	 */
	narrative?: string;
	container_stage?: string;
	visual_task?: string;
	/** MG 品类子类型透传（裁决⑩）：供 opencut 色带按 category 分层（overlay 透明叠加/fullscreen 不透明满屏）。 */
	category?: string;
}

export interface StructMetaSplit {
	contract_version: string;
	transcript_hash: string;
	projected_at: string;
	/** 口播素材 id（= transcript.material_id）——消费方脱离 transcript 文件定位素材绑定。 */
	material_id?: string;
	beats: SplitMetaBeat[];
}

/** MG 颗粒品类子类型（裁决⑩，不新增 lane）。一期 overlay/fullscreen；二期扩 subtitle/title。 */
export const MG_CATEGORIES = ["overlay", "fullscreen", "subtitle", "title"] as const;
export type MgCategory = (typeof MG_CATEGORIES)[number];
/**
 * 透明/不透明默认映射（category → 期望 opaque）。透明叠加品类→false，满屏底层品类→true。
 * 双名认旧：同时含中性新键（overlay/fullscreen/subtitle/title）与遗留品牌键
 * （rrv-overlay/mg-fullscreen/explain-subtitle/op-ed-title），既有工程/颗粒零迁移仍命中。
 */
export const CATEGORY_EXPECTED_OPAQUE: Record<string, boolean> = {
	overlay: false,
	fullscreen: true,
	subtitle: false,
	title: true,
	// 遗留品牌键（读旧兼容）
	"rrv-overlay": false,
	"mg-fullscreen": true,
	"explain-subtitle": false,
	"op-ed-title": true,
};
export function isMgCategory(v: unknown): v is MgCategory {
	return typeof v === "string" && (MG_CATEGORIES as readonly string[]).includes(v);
}
/** 已知品类（含遗留品牌键）：命中即视为已知、软校验不告警。 */
function isKnownCategory(v: unknown): boolean {
	return typeof v === "string" && Object.prototype.hasOwnProperty.call(CATEGORY_EXPECTED_OPAQUE, v);
}

export interface MgDispatch {
	beat: string;
	composition_id: string;
	duration: number | null;
	/** 品类子类型（可选；缺省=向后兼容，下游回落颗粒 HTML 反推 opaque）。 */
	category?: unknown;
	theme?: unknown;
	bg?: unknown;
	slug_hint?: unknown;
	track_st: number;
	track_ed: number;
}
export interface FilmDispatch {
	beat: string;
	queries: string[];
	shots?: unknown;
	per_shot_sec?: unknown;
	exclude?: unknown;
	track_st: number;
	track_ed: number;
}
export interface AiDramaDispatch {
	beat: string;
	track_st: number;
	track_ed: number;
	[k: string]: unknown;
}
export interface Dispatch {
	mg: MgDispatch[];
	film_broll: FilmDispatch[];
	ai_drama: AiDramaDispatch[];
}

export interface SkipReport {
	beat: string;
	reason: string;
}
export interface ShrinkReport {
	beat: string;
	kept: number;
	dropped: number;
	track_st: number;
	track_ed: number;
}

export interface Landing {
	split: StructMetaSplit;
	dispatch: Dispatch;
	skipped: SkipReport[];
	shrunk: ShrinkReport[];
	/**
	 * 校验通过却无派单分支的 lane（footgun 防御）：A_ROLL 故意无派单，此处只收未来扩展
	 * LANES 却漏改 dispatch 分派的遗漏 lane——落地不再静默，交由命令层告警。
	 */
	unhandledLanes: string[];
}

/**
 * 落地：把（已校验通过的）拆分稿 × 投影视图 → struct_meta.split 快照 + dispatch 派单清单 + 收缩/跳过报告。
 * 纯函数，不写文件。整 beat 全 dropped 跳过；部分 dropped 按存活包络收缩。
 */
/** 3 位小数（对齐 transcript / gtrk 秒值精度，与投影层 r3 同式）。 */
function r3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

export function buildLanding(
	doc: SplitDoc,
	view: ProjectionView,
	opts: {
		utteranceIds: string[];
		projectSlug: string;
		projectedAt: string;
		/** 源时基索引（add-split-source-ranges）：传则落地写 source_ranges/material_id，不传不写（向后兼容）。 */
		sourceIndex?: {
			materialId: string;
			utterances: Map<string, { st: number; ed: number }>;
		};
	},
): Landing {
	// id → 存活投影实例（可多实例）；无实例即该 id 被全剪
	const byId = new Map<string, { track_st: number; track_ed: number }[]>();
	for (const id of opts.utteranceIds) byId.set(id, []);
	for (const u of view.utterances) {
		if (u.dropped || u.track_st == null || u.track_ed == null) continue;
		if (!byId.has(u.id)) byId.set(u.id, []);
		byId.get(u.id)!.push({ track_st: u.track_st, track_ed: u.track_ed });
	}
	const idIndex = new Map<string, number>();
	opts.utteranceIds.forEach((id, i) => idIndex.set(id, i));

	const split: StructMetaSplit = {
		contract_version: doc.contract_version,
		transcript_hash: doc.transcript_hash,
		projected_at: opts.projectedAt,
		...(opts.sourceIndex ? { material_id: opts.sourceIndex.materialId } : {}),
		beats: [],
	};
	const dispatch: Dispatch = { mg: [], film_broll: [], ai_drama: [] };
	const skipped: SkipReport[] = [];
	const shrunk: ShrinkReport[] = [];
	const unhandledLanes = new Set<string>();

	for (const beat of doc.beats) {
		const fromIdx = idIndex.get(beat.span.from)!;
		const toIdx = idIndex.get(beat.span.to)!;
		const spanIds = opts.utteranceIds.slice(fromIdx, toIdx + 1);
		const instances = spanIds.flatMap((id) => byId.get(id) ?? []);
		const droppedCount = spanIds.filter((id) => (byId.get(id)?.length ?? 0) === 0).length;

		if (instances.length === 0) {
			skipped.push({ beat: beat.id, reason: "span 内全部 utterance 被剪，未落轨" });
			continue;
		}
		const track_st = Math.min(...instances.map((x) => x.track_st));
		const track_ed = Math.max(...instances.map((x) => x.track_ed));
		const isShrunk = droppedCount > 0;

		// 读旧写新：遗留 lane 值（RRV_MG）归一为中性名 MG 后落地/派单（既有工程零迁移）
		const lane = normalizeLane(beat.lane) ?? beat.lane;
		const metaBeat: SplitMetaBeat = { id: beat.id, lane, span: beat.span, track_st, track_ed };
		if (opts.sourceIndex) {
			const from = opts.sourceIndex.utterances.get(beat.span.from);
			const to = opts.sourceIndex.utterances.get(beat.span.to);
			// span 源包络（design D1）；端点异常防御跳过，不阻断落地
			if (from && to && to.ed > from.st) {
				metaBeat.source_ranges = [{ st: r3(from.st), ed: r3(to.ed) }];
			}
		}
		if (isShrunk) metaBeat.shrunk = true;
		// 语义透传（add-split-source-ranges）：客户端 hover 详情卡「这段对应什么」
		if (beat.narrative) metaBeat.narrative = beat.narrative;
		if (beat.container_stage) metaBeat.container_stage = beat.container_stage;
		if (beat.visual_task) metaBeat.visual_task = beat.visual_task;
		// MG 品类透传（裁决⑩）：category 原样透传（含遗留品牌值，opaque passthrough），供 opencut 色带按 category 分层
		if (lane === "MG" && typeof beat.handoff?.category === "string") metaBeat.category = beat.handoff.category;
		if (lane !== "A_ROLL" && beat.handoff) metaBeat.handoff = beat.handoff;
		split.beats.push(metaBeat);

		if (isShrunk) {
			shrunk.push({ beat: beat.id, kept: spanIds.length - droppedCount, dropped: droppedCount, track_st, track_ed });
		}

		const h = beat.handoff ?? {};
		const compositionId = `${opts.projectSlug}-${beat.id}`;
		if (lane === "MG") {
			dispatch.mg.push({
				beat: beat.id,
				composition_id: compositionId,
				duration: typeof h.duration_hint === "number" ? h.duration_hint : null,
				...(h.category !== undefined ? { category: h.category } : {}),
				theme: h.theme,
				bg: h.bg,
				slug_hint: h.slug_hint,
				track_st,
				track_ed,
			});
		} else if (lane === "FILM_BROLL") {
			dispatch.film_broll.push({
				beat: beat.id,
				queries: Array.isArray(h.queries) ? (h.queries as string[]) : [],
				shots: h.shots,
				per_shot_sec: h.per_shot_sec,
				exclude: h.exclude,
				track_st,
				track_ed,
			});
		} else if (lane === "AI_DRAMA") {
			dispatch.ai_drama.push({ beat: beat.id, ...h, track_st, track_ed });
		} else if (lane !== "A_ROLL") {
			// A_ROLL 故意无派单；其余 lane 过了校验却无 dispatch 分支
			// = 未来扩展 LANES 漏改此处 → 收集告警，不静默丢队列（footgun 防御）
			unhandledLanes.add(lane);
		}

		// ── aux 叠层颗粒投影（add-aux-rrv-overlay-particle）─────────────────────
		// 主 beat 派单后，把每条 type="overlay" 的 aux 投影为派生颗粒：进 dispatch.mg +
		// 追加合成 struct_meta.split.beats（lane=MG、category=overlay），铺出叠在底轨主视觉上的透明颗粒。
		// composition_id=<slug>-<beatId>-aux<n>（n 从 1，位置计数保证全局唯一 + 幂等）。
		// 注意：此处到达时主 beat 必有存活实例（上方 instances.length===0 已 continue），故 same_beat 恒有效落轨。
		let auxN = 0;
		for (const aux of beat.aux_layers ?? []) {
			if (aux.type !== "overlay") continue;
			auxN += 1;
			const auxTag = `${beat.id}-aux${auxN}`;
			const mount = aux.mount;
			// mount 投影：same_beat 复用主 beat span；{from,to} 取该子区间存活实例包络；{trigger} 一期不支持
			let auxFromId: string;
			let auxToId: string;
			if (mount === "same_beat") {
				auxFromId = beat.span.from;
				auxToId = beat.span.to;
			} else if ("from" in mount && "to" in mount) {
				auxFromId = mount.from;
				auxToId = mount.to;
			} else {
				// {trigger} 点挂载无干净源区间（duration_hint 是时间线秒非源秒 → 跟随会不准），一期 skip + 告警，二期补合成窗口
				skipped.push({ beat: auxTag, reason: "overlay aux 使用 {trigger} 点挂载，一期不支持（二期补合成窗口）" });
				continue;
			}
			const auxFromIdx = idIndex.get(auxFromId)!;
			const auxToIdx = idIndex.get(auxToId)!;
			const auxSpanIds = opts.utteranceIds.slice(auxFromIdx, auxToIdx + 1);
			const auxInstances = auxSpanIds.flatMap((id) => byId.get(id) ?? []);
			if (auxInstances.length === 0) {
				// 全 dropped：与主 beat 全剪同纪律，计入 skipped 不静默丢
				skipped.push({ beat: auxTag, reason: "overlay aux 源区间 utterance 全被剪，未落轨" });
				continue;
			}
			const auxTrackSt = Math.min(...auxInstances.map((x) => x.track_st));
			const auxTrackEd = Math.max(...auxInstances.map((x) => x.track_ed));
			const auxCompositionId = `${opts.projectSlug}-${beat.id}-aux${auxN}`;
			const ah = aux.handoff;

			dispatch.mg.push({
				beat: beat.id,
				composition_id: auxCompositionId,
				duration: ah && typeof ah.duration_hint === "number" ? ah.duration_hint : null,
				category: "overlay",
				theme: ah?.theme,
				bg: ah?.bg,
				slug_hint: ah?.slug_hint,
				track_st: auxTrackSt,
				track_ed: auxTrackEd,
			});

			const auxMetaBeat: SplitMetaBeat = {
				id: auxTag,
				lane: "MG",
				span: { from: auxFromId, to: auxToId },
				track_st: auxTrackSt,
				track_ed: auxTrackEd,
				category: "overlay",
			};
			// 源包络（同主 beat：传 sourceIndex 才写）——满足客户端 beats.every(source_ranges) 跟随门槛
			if (opts.sourceIndex) {
				const sfrom = opts.sourceIndex.utterances.get(auxFromId);
				const sto = opts.sourceIndex.utterances.get(auxToId);
				if (sfrom && sto && sto.ed > sfrom.st) {
					auxMetaBeat.source_ranges = [{ st: r3(sfrom.st), ed: r3(sto.ed) }];
				}
			}
			split.beats.push(auxMetaBeat);
		}
	}

	return { split, dispatch, skipped, shrunk, unhandledLanes: [...unhandledLanes] };
}

// ── 人读稿渲染（单向，不回读）─────────────────────────────────────────────

/** 由拆分稿 + 落地结果渲染人读 Markdown（沿旧版式：总览 / Beat Timeline / 四队列）。 */
export function renderSplitMarkdown(
	doc: SplitDoc,
	landing: Landing,
	meta: { projectSlug: string; projectedAt: string },
): string {
	const L: string[] = [];
	const metaById = new Map(landing.split.beats.map((b) => [b.id, b]));
	const skippedIds = new Set(landing.skipped.map((s) => s.beat));

	L.push(`# 视觉拆分稿（${meta.projectSlug}）`);
	L.push("");
	L.push(`- contract_version：\`${doc.contract_version}\``);
	L.push(`- transcript_hash：\`${doc.transcript_hash}\``);
	L.push(`- projected_at：\`${meta.projectedAt}\``);
	L.push(`- beats：${doc.beats.length}（落轨 ${landing.split.beats.length} · 跳过 ${landing.skipped.length} · 收缩 ${landing.shrunk.length}）`);
	L.push("");
	L.push("# Beat Timeline");
	L.push("");
	for (const beat of doc.beats) {
		const mb = metaById.get(beat.id);
		L.push(`## ${beat.id}${skippedIds.has(beat.id) ? "（整段被剪 · 跳过）" : mb?.shrunk ? "（部分被剪 · 已收缩）" : ""}`);
		L.push(`- 文稿范围：\`${beat.span.from} … ${beat.span.to}\``);
		L.push(`- 底轨：\`${beat.base_track}\``);
		L.push(`- 主层：\`${beat.lane}\``);
		L.push(`- 叙事功能：\`${beat.narrative}\``);
		L.push(`- 容器阶段：\`${beat.container_stage}\``);
		if (beat.rhythm) L.push(`- 节奏标签：\`${beat.rhythm}\``);
		L.push(`- 视觉任务：${beat.visual_task}`);
		L.push(`- 不可替代性：\`${beat.irreplaceability}\``);
		if (mb) L.push(`- 轨道时码：\`${mb.track_st}s … ${mb.track_ed}s\``);
		if (beat.callback_of) L.push(`- 回扣对象：\`${beat.callback_of}\``);
		for (const a of beat.aux_layers ?? []) {
			const mount = a.mount === "same_beat" ? "同 beat" : "trigger" in a.mount ? `触发 ${a.mount.trigger}` : `${a.mount.from} … ${a.mount.to}`;
			L.push(`  - 辅助层 \`${a.type}\`（${mount}）：${a.role}`);
		}
		L.push("");
	}

	L.push("# Production Queues");
	L.push("");
	L.push("## A_ROLL Queue");
	for (const b of doc.beats.filter((x) => x.lane === "A_ROLL" && !skippedIds.has(x.id))) {
		L.push(`- \`${b.id}\` ${b.visual_task}`);
	}
	L.push("");
	L.push("## MG Queue");
	for (const r of landing.dispatch.mg) {
		L.push(`- \`${r.beat}\` composition_id=\`${r.composition_id}\`${r.duration != null ? ` · ${r.duration}s` : ""}`);
	}
	L.push("");
	L.push("## AI_DRAMA Queue");
	for (const a of landing.dispatch.ai_drama) L.push(`- \`${a.beat}\` ${a.track_st}s…${a.track_ed}s`);
	L.push("");
	L.push("## FILM_BROLL Queue");
	for (const f of landing.dispatch.film_broll) L.push(`- \`${f.beat}\` queries=[${f.queries.join(" / ")}]`);
	L.push("");
	return L.join("\n");
}
