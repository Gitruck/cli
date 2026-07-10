/**
 * matrix 候选铺轨纯逻辑（matrix-lay-tracks spec，add-matrix-smart-fill 平铺版）。
 *
 * 核心语义（主理人 2026-07-10 对齐）：**一个 FILM_BROLL beat 区间由多颗粒平铺占满**，
 * 填哪几颗、各自起止由算法决定。吸收主理人旧方案思想（词锚定/置信度阈值/低于阈值不采纳），
 * 映射到 segments 底座：
 *   - 取材单元 = (clip, segment) 对（候选全部命中段，segment.score 降序）；
 *   - 槽位按 query 叙事序轮转（拆分稿 query 顺序 = beat 的叙事子意象序）；
 *   - score < 地板不采纳 → 槽位留空（overlay 留空自然露主轨 A-roll，优于硬塞）；
 *   - 紧邻槽位不同 clip；(clip,segment) 对跨轨不复用（轨 2 = 真正差异化方案）；
 *   - excluded_hint（note 命中派单负词）不进自动填充，人工面板仍可选。
 * 素材 = 已下载落地的 preview 代理（契约铁律「无 url 素材态」，url 只活在 struct_meta.broll）。
 * 幂等：自产物 = `broll-` 前缀 materials + `struct_meta.broll.lay_tracks` 登记的轨。
 */
import type { BrollPlan, PlanBeat, PlanResult } from "./matrix";

export const BROLL_PREVIEW_DIR = "assets/broll-preview";
export const BROLL_MATERIAL_PREFIX = "broll-";
/** struct_meta.broll 每 beat 候选精简集上限（全集回 plan 文件）。 */
export const BROLL_META_CANDIDATE_CAP = 12;
/** 目标镜头长缺省（秒）。 */
export const SHOT_TARGET_DEFAULT = 3;
/** 最小可用镜头长（秒）：低于此长度的碎片不铺。 */
export const MIN_SHOT_SEC = 1.2;
/** segment 置信度地板：低于则不采纳（--score-floor 覆盖）。
 * 0.2 = 真机量纲校准（2026-07-10 回声定位）：该后端 score 集中于 0.1~0.4，0.25+ 已是强命中。 */
export const SCORE_FLOOR_DEFAULT = 0.2;
/** 单 beat 单轨槽位上限（防呆）。 */
export const MAX_SLOTS_PER_BEAT = 32;

export interface DownloadedProxy {
	/** 相对 gtrk 目录路径（assets/broll-preview/<clip_id>.mp4）。 */
	rel: string;
	source: "preview" | "raw";
}

/** 平铺槽位（laid.slots 条目；双时基窗口）。 */
export interface FillSlot {
	clip_id: string;
	query: string;
	score: number;
	clip_st: number;
	clip_ed: number;
	track_st: number;
	track_ed: number;
}

export interface BrollMetaCandidate {
	clip_id: string;
	score: number;
	cover_url: string;
	preview_path: string | null;
	source: "preview" | "raw" | null;
	raw_url: string;
	seg: { start: number; end: number; best: number } | null;
}

export interface BrollMetaBeat {
	beat: string;
	track_st: number;
	track_ed: number;
	per_shot_sec?: number;
	candidates: BrollMetaCandidate[];
	/** 每轨一条；clip_id = 首槽 clip（兼容旧消费方），slots 为平铺明细。 */
	laid: { order: number; clip_id: string; track_index: number; slots: FillSlot[] }[];
	pinned: null;
}

export interface StructMetaBroll {
	contract_version: "v1";
	generated_at: string;
	plan_path: string;
	lay_tracks: number[];
	confirmed: false;
	beats: BrollMetaBeat[];
}

/** beat 候选合并：各 query results（beat 内已去重）按 score 降序（面板/下载排序用）。 */
export function mergedCandidates(beat: PlanBeat): PlanResult[] {
	const all: PlanResult[] = [];
	for (const q of beat.queries) for (const r of q.results ?? []) all.push(r);
	return all.sort((a, b) => b.score - a.score);
}

/** 代理 url 决策：出参 preview_url 优先；缺失按 cover_url 模式推导。 */
export function previewUrlFor(result: PlanResult): string | null {
	const direct = (result as { preview_url?: unknown }).preview_url;
	if (typeof direct === "string" && direct) return direct;
	const cover = result.cover_url;
	if (typeof cover === "string") {
		const derived = cover.replace(/\/keyframe\/([^/]+)\/cover\.jpg.*$/, "/preview/$1.mp4");
		if (derived !== cover) return derived;
	}
	return null;
}

/** preview 代理的近似尺寸（≤640 宽等比、偶数高）。 */
export function previewDims(width?: number, height?: number): [number, number] | undefined {
	if (!width || !height || width <= 0 || height <= 0) return undefined;
	if (width <= 640) return [width, height];
	const h = Math.max(2, Math.round((height * 640) / width / 2) * 2);
	return [640, h];
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

// ── 平铺填充 ──────────────────────────────────────────────────────────────

interface Pair {
	cand: PlanResult;
	seg: { start: number; end: number; best: number; score: number };
	query: string;
	/** consumed 集键：clip + 段起点（同 clip 不同命中段是不同镜头源）。 */
	key: string;
}

/** 每 query 的取材池：results 展开全部 segments，score 降序；excluded_hint 与低于地板的对不进池。 */
function buildQueryPools(beat: PlanBeat, scoreFloor: number): { query: string; pool: Pair[] }[] {
	const out: { query: string; pool: Pair[] }[] = [];
	for (const q of beat.queries) {
		const pool: Pair[] = [];
		for (const cand of q.results ?? []) {
			if (cand.excluded_hint) continue; // 命中派单负词：自动填充跳过（人工面板保留）
			const segs = cand.segments?.length
				? cand.segments
				: // 无命中段的候选降级为整片伪段（少见；score 用 clip 级分）
					[{ start: 0, end: cand.duration ?? SHOT_TARGET_DEFAULT, best: (cand.duration ?? SHOT_TARGET_DEFAULT) / 2, score: cand.score }];
			for (const seg of segs) {
				if (seg.score < scoreFloor) continue; // 低于阈值不采纳（主理人旧方案原则）
				pool.push({ cand, seg, query: q.query, key: `${cand.clip_id}@${seg.start}` });
			}
		}
		pool.sort((a, b) => b.seg.score - a.seg.score);
		if (pool.length) out.push({ query: q.query, pool });
	}
	return out;
}

/** 该对可供的最大镜头长：有素材时长则允许向段外扩（同素材相邻画面），否则只信段长。 */
function pairAvail(p: Pair): number {
	const dur = typeof p.cand.duration === "number" && p.cand.duration > 0 ? p.cand.duration : undefined;
	return dur ?? Math.max(0, p.seg.end - p.seg.start);
}

/**
 * 单 beat 单轨平铺：游标从 track_st 贪心铺到 track_ed。
 * consumed 跨轨共享（(clip,seg) 对不复用 → 轨间方案差异化）。
 */
export function fillBeatTrack(opts: {
	beat: PlanBeat;
	consumed: Set<string>;
	scoreFloor: number;
}): FillSlot[] {
	const { beat, consumed, scoreFloor } = opts;
	const span = beat.track_ed - beat.track_st;
	if (!(span > 0)) return [];
	const shots =
		typeof beat.requested_shots === "number" && beat.requested_shots > 0 ? beat.requested_shots : undefined;
	const shotTarget =
		typeof beat.per_shot_sec === "number" && beat.per_shot_sec > 0
			? beat.per_shot_sec
			: shots
				? Math.min(Math.max(span / shots, 1.5), 6)
				: SHOT_TARGET_DEFAULT;

	const pools = buildQueryPools(beat, scoreFloor);
	if (!pools.length) return [];

	const slots: FillSlot[] = [];
	let cursor = beat.track_st;
	let prevClip: string | null = null;
	let gapRun = 0;

	for (let slotIdx = 0; slotIdx < MAX_SLOTS_PER_BEAT; slotIdx++) {
		const remaining = beat.track_ed - cursor;
		if (remaining < MIN_SHOT_SEC) break; // 碎尾留空（露 A-roll）

		const minLen = Math.min(MIN_SHOT_SEC, remaining);
		// query 叙事序轮转：本槽位从 slotIdx 对应的 query 起，池干涸/无合格对则轮下一条
		let pick: Pair | null = null;
		for (let t = 0; t < pools.length && !pick; t++) {
			const { pool } = pools[(slotIdx + t) % pools.length];
			pick =
				pool.find(
					(p) => !consumed.has(p.key) && p.cand.clip_id !== prevClip && pairAvail(p) >= minLen,
				) ?? null;
		}
		if (!pick) {
			// 本槽位无合格对（可能仅因紧邻去重被挡）：留空一个镜头位继续，隔空后同 clip 可再用；连空两次视为干涸
			gapRun++;
			if (gapRun >= 2) break;
			cursor += Math.min(shotTarget, remaining);
			prevClip = null;
			continue;
		}
		gapRun = 0;

		const d = Math.min(shotTarget, pairAvail(pick), remaining);
		// 源窗：best 居中截 d；有素材时长则钳 [0, dur]（允许出段），否则钳段界
		const dur = typeof pick.cand.duration === "number" && pick.cand.duration > 0 ? pick.cand.duration : undefined;
		const lo = dur !== undefined ? 0 : pick.seg.start;
		const hi = dur ?? pick.seg.end;
		const maxSt = Math.max(lo, hi - d);
		const clipSt = Math.min(Math.max(pick.seg.best - d / 2, lo), maxSt);

		slots.push({
			clip_id: pick.cand.clip_id,
			query: pick.query,
			score: pick.seg.score,
			clip_st: r3(clipSt),
			clip_ed: r3(clipSt + d),
			track_st: r3(cursor),
			track_ed: r3(cursor + d),
		});
		consumed.add(pick.key);
		prevClip = pick.cand.clip_id;
		cursor += d;
	}
	return slots;
}

/** 全 plan 预填充（纯函数）：先定「填哪些颗粒」，供调用方下载后再落轨。 */
export function planBeatFills(
	plan: BrollPlan,
	lay: number,
	scoreFloor: number,
): { fills: Map<string, FillSlot[][]>; clipIds: Set<string> } {
	const fills = new Map<string, FillSlot[][]>();
	const clipIds = new Set<string>();
	const consumed = new Set<string>();
	for (const beat of plan.beats) {
		const perTrack: FillSlot[][] = [];
		for (let k = 0; k < Math.max(0, lay); k++) {
			const slots = fillBeatTrack({ beat, consumed, scoreFloor });
			perTrack.push(slots);
			for (const s of slots) clipIds.add(s.clip_id);
		}
		fills.set(beat.beat, perTrack);
	}
	return { fills, clipIds };
}

// ── 落轨（剥旧 + append + struct_meta.broll）─────────────────────────────

interface LooseTrack {
	track_index?: number;
	track_timeline?: { material?: unknown }[];
	[k: string]: unknown;
}
interface LooseMaterial {
	id?: unknown;
	[k: string]: unknown;
}

export interface LayResult {
	next: Record<string, unknown>;
	summary: { laidTracks: number[]; laidClips: number; beatsWithCandidates: number };
	broll: StructMetaBroll;
}

/**
 * 铺轨主函数（纯函数，不做 IO）：剥离上次自产物 → 按 fills 平铺 append 素材与 overlay 轨 →
 * 写 struct_meta.broll。下载失败的槽位被丢弃（留空露 A-roll，调用方已告警）。
 */
export function layBrollTracks(opts: {
	gtrk: Record<string, unknown>;
	plan: BrollPlan;
	lay: number;
	fills: Map<string, FillSlot[][]>;
	downloads: Map<string, DownloadedProxy>;
	generatedAt: string;
	planPath: string;
}): LayResult {
	const { gtrk, plan, lay, fills, downloads } = opts;
	const videoTracks = [...((gtrk.video_track as LooseTrack[] | undefined) ?? [])];
	const materials = [...((gtrk.materials as LooseMaterial[] | undefined) ?? [])];
	const structMeta = { ...((gtrk.struct_meta as Record<string, unknown> | undefined) ?? {}) };

	// ── 剥离自产物（幂等重铺；登记缺失宁留勿删）──
	const prevBroll = structMeta.broll as { lay_tracks?: unknown } | undefined;
	const prevIndices = new Set<number>(
		Array.isArray(prevBroll?.lay_tracks)
			? (prevBroll!.lay_tracks as unknown[]).filter((x): x is number => typeof x === "number")
			: [],
	);
	const removedTracks = videoTracks.filter((t) => typeof t.track_index === "number" && prevIndices.has(t.track_index));
	const keptTracks = videoTracks.filter((t) => !(typeof t.track_index === "number" && prevIndices.has(t.track_index)));
	const removedMaterialIds = new Set<string>();
	for (const t of removedTracks) {
		for (const c of t.track_timeline ?? []) {
			const m = c.material;
			if (typeof m === "string" && m.startsWith(BROLL_MATERIAL_PREFIX)) removedMaterialIds.add(m);
		}
	}
	const keptMaterials = materials.filter((m) => !(typeof m.id === "string" && removedMaterialIds.has(m.id)));

	// ── 按 fills 平铺构建 ──
	const canvas = Array.isArray(gtrk.video_size) ? (gtrk.video_size as number[]) : [1920, 1080];
	const baseIndex = keptTracks.reduce((mx, t) => Math.max(mx, typeof t.track_index === "number" ? t.track_index : 0), -1) + 1;
	const candById = new Map<string, PlanResult>();
	for (const beat of plan.beats) for (const c of mergedCandidates(beat)) if (!candById.has(c.clip_id)) candById.set(c.clip_id, c);

	const metaBeats: BrollMetaBeat[] = [];
	const newMaterialsById = new Map<string, LooseMaterial>();
	const trackClips = new Map<number, Record<string, unknown>[]>();
	let laidClips = 0;
	let beatsWithCandidates = 0;

	for (const beat of plan.beats) {
		const merged = mergedCandidates(beat);
		if (merged.length > 0) beatsWithCandidates++;
		const perTrack = fills.get(beat.beat) ?? [];
		const laid: BrollMetaBeat["laid"] = [];

		for (let k = 0; k < perTrack.length; k++) {
			// 下载失败的槽位丢弃（留空）；全空轨槽不建 laid 条目
			const slots = perTrack[k].filter((s) => downloads.has(s.clip_id));
			if (!slots.length) continue;
			const trackIndex = baseIndex + k;
			const bucket = trackClips.get(trackIndex) ?? [];
			slots.forEach((s, i) => {
				const materialId = `${BROLL_MATERIAL_PREFIX}${s.clip_id}`;
				if (!newMaterialsById.has(materialId)) {
					const cand = candById.get(s.clip_id);
					const dims = previewDims(cand?.width, cand?.height);
					const mat: LooseMaterial = { id: materialId, path: downloads.get(s.clip_id)!.rel };
					if (typeof cand?.duration === "number") mat.duration = cand.duration;
					if (dims) mat.video_size = dims;
					if (typeof cand?.fps === "number") mat.video_rate = cand.fps;
					newMaterialsById.set(materialId, mat);
				}
				bucket.push({
					clip_id: `${beat.beat}-broll-${k}-${i}`,
					material: materialId,
					clip_st: s.clip_st,
					clip_ed: s.clip_ed,
					track_st: s.track_st,
					track_ed: s.track_ed,
					duration: r3(s.track_ed - s.track_st),
				});
				laidClips++;
			});
			trackClips.set(trackIndex, bucket);
			laid.push({ order: k, clip_id: slots[0].clip_id, track_index: trackIndex, slots });
		}

		const metaBeat: BrollMetaBeat = {
			beat: beat.beat,
			track_st: beat.track_st,
			track_ed: beat.track_ed,
			candidates: merged.slice(0, BROLL_META_CANDIDATE_CAP).map((c) => {
				const dl = downloads.get(c.clip_id);
				const seg = c.segments?.[0];
				return {
					clip_id: c.clip_id,
					score: c.score,
					cover_url: c.cover_url,
					preview_path: dl?.rel ?? null,
					source: dl?.source ?? null,
					raw_url: c.url,
					seg: seg ? { start: seg.start, end: seg.end, best: seg.best } : null,
				};
			}),
			laid,
			pinned: null,
		};
		if (typeof beat.per_shot_sec === "number") metaBeat.per_shot_sec = beat.per_shot_sec;
		metaBeats.push(metaBeat);
	}

	const createdTracks = [...trackClips.entries()]
		.filter(([, clips]) => clips.length > 0)
		.sort((a, b) => a[0] - b[0])
		.map(([track_index, clips]) => ({
			track_index,
			track_size: [canvas[0], canvas[1]],
			muted: false,
			track_timeline: clips.sort((a, b) => (a.track_st as number) - (b.track_st as number)),
		}));

	const broll: StructMetaBroll = {
		contract_version: "v1",
		generated_at: opts.generatedAt,
		plan_path: opts.planPath,
		lay_tracks: createdTracks.map((t) => t.track_index),
		confirmed: false,
		beats: metaBeats,
	};

	const next: Record<string, unknown> = {
		...gtrk,
		materials: [...keptMaterials, ...newMaterialsById.values()],
		video_track: [...keptTracks, ...createdTracks],
		struct_meta: { ...structMeta, broll },
	};
	return {
		next,
		summary: { laidTracks: broll.lay_tracks, laidClips, beatsWithCandidates },
		broll,
	};
}
