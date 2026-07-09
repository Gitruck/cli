/**
 * 拆分稿机器契约 v1 —— 解析 / 校验 / 落地投影（纯逻辑，不碰文件 IO）。
 *
 * 校验（split-doc-contract spec）：结构/枚举 → id 合法性（存在/from≤to/beats 不重叠）→ handoff 按 lane 分型
 * → transcript_hash 硬拒。错误逐条含 beat id + 原因。落地（timeline-projection spec）：整 beat 全 dropped → 跳过
 * 并入 report；部分 dropped → 按存活包络收缩、标 shrunk。落地产 struct_meta.split 快照 + dispatch 派单清单。
 */
import type { ProjectionView } from "./projection";

export const BASE_TRACKS = ["真人出镜", "口播继续", "旁白主导"] as const;
export const LANES = ["A_ROLL", "RRV_MG", "AI_DRAMA", "FILM_BROLL"] as const;
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
] as const;

export type Lane = (typeof LANES)[number];

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

/** 校验上下文：utterance id 的**权威源序**（用于区间/重叠判定）+ 当前 transcript 的 text_hash。 */
export interface ValidationCtx {
	utteranceIds: string[];
	transcriptHash: string;
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

		if (!enumOk(b.base_track, BASE_TRACKS)) errors.push(`${tag}：base_track 非法（三选一：${BASE_TRACKS.join(" | ")}）`);
		if (!enumOk(b.lane, LANES)) errors.push(`${tag}：lane 非法（四选一：${LANES.join(" | ")}）`);
		if (!enumOk(b.narrative, NARRATIVES)) errors.push(`${tag}：narrative 非法（八枚举之一）`);
		if (!enumOk(b.container_stage, CONTAINER_STAGES)) errors.push(`${tag}：container_stage 非法（七枚举之一）`);
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
			else (b.aux_layers as unknown[]).forEach((a, ai) => validateAux(`${tag}.aux[${ai}]`, a, idIndex, errors));
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
	if (lane === "RRV_MG") {
		if (!handoff || typeof handoff.duration_hint !== "number") {
			errors.push(`${tag}：RRV_MG 的 handoff.duration_hint 必填（秒，数值）`);
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
): void {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		errors.push(`${tag}：辅助层必须是对象`);
		return;
	}
	const a = raw as Record<string, unknown>;
	if (!enumOk(a.type, AUX_TYPES)) errors.push(`${tag}：type 非法（七类之一）`);
	if (!isNonEmptyStr(a.role)) errors.push(`${tag}：缺 role（职责）`);
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
}

export interface StructMetaSplit {
	contract_version: string;
	transcript_hash: string;
	projected_at: string;
	/** 口播素材 id（= transcript.material_id）——消费方脱离 transcript 文件定位素材绑定。 */
	material_id?: string;
	beats: SplitMetaBeat[];
}

export interface RrvDispatch {
	beat: string;
	composition_id: string;
	duration: number | null;
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
	rrv_mg: RrvDispatch[];
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
	const dispatch: Dispatch = { rrv_mg: [], film_broll: [], ai_drama: [] };
	const skipped: SkipReport[] = [];
	const shrunk: ShrinkReport[] = [];

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

		const metaBeat: SplitMetaBeat = { id: beat.id, lane: beat.lane, span: beat.span, track_st, track_ed };
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
		if (beat.lane !== "A_ROLL" && beat.handoff) metaBeat.handoff = beat.handoff;
		split.beats.push(metaBeat);

		if (isShrunk) {
			shrunk.push({ beat: beat.id, kept: spanIds.length - droppedCount, dropped: droppedCount, track_st, track_ed });
		}

		const h = beat.handoff ?? {};
		const compositionId = `${opts.projectSlug}-${beat.id}`;
		if (beat.lane === "RRV_MG") {
			dispatch.rrv_mg.push({
				beat: beat.id,
				composition_id: compositionId,
				duration: typeof h.duration_hint === "number" ? h.duration_hint : null,
				theme: h.theme,
				bg: h.bg,
				slug_hint: h.slug_hint,
				track_st,
				track_ed,
			});
		} else if (beat.lane === "FILM_BROLL") {
			dispatch.film_broll.push({
				beat: beat.id,
				queries: Array.isArray(h.queries) ? (h.queries as string[]) : [],
				shots: h.shots,
				per_shot_sec: h.per_shot_sec,
				exclude: h.exclude,
				track_st,
				track_ed,
			});
		} else if (beat.lane === "AI_DRAMA") {
			dispatch.ai_drama.push({ beat: beat.id, ...h, track_st, track_ed });
		}
		// A_ROLL：真人底轨直出，无下游派单
	}

	return { split, dispatch, skipped, shrunk };
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
	L.push("## RRV_MG Queue");
	for (const r of landing.dispatch.rrv_mg) {
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
