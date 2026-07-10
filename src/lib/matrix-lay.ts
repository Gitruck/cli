/**
 * matrix 候选铺轨纯逻辑（matrix-lay-tracks spec）。
 *
 * 轨语义：轨 k = 每个 FILM_BROLL beat 的第 k 名候选（beat 内已去重，跨 query 按 score 降序合并）。
 * 素材 = 已下载落地的 preview 代理（相对 gtrk 目录 `assets/broll-preview/<clip_id>.mp4`）——
 * 契约铁律「无 url 素材态」，url 只活在 struct_meta.broll 的候选记录里。
 * 幂等：自产物 = `broll-` 前缀 materials + `struct_meta.broll.lay_tracks` 登记的轨；重铺只替换自产物，
 * 登记缺失宁留勿删（旧轨当用户轨对待）。
 */
import type { BrollPlan, PlanBeat, PlanResult } from "./matrix";

export const BROLL_PREVIEW_DIR = "assets/broll-preview";
export const BROLL_MATERIAL_PREFIX = "broll-";
/** struct_meta.broll 每 beat 候选精简集上限（全集回 plan 文件）。 */
export const BROLL_META_CANDIDATE_CAP = 12;

export interface DownloadedProxy {
	/** 相对 gtrk 目录路径（assets/broll-preview/<clip_id>.mp4）。 */
	rel: string;
	source: "preview" | "raw";
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
	laid: { order: number; clip_id: string; track_index: number }[];
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

/** beat 候选合并：各 query results（beat 内已去重）按 score 降序。 */
export function mergedCandidates(beat: PlanBeat): PlanResult[] {
	const all: PlanResult[] = [];
	for (const q of beat.queries) for (const r of q.results ?? []) all.push(r);
	return all.sort((a, b) => b.score - a.score);
}

export interface ClipWindow {
	clip_st: number;
	clip_ed: number;
	track_st: number;
	track_ed: number;
}

/**
 * 窗口计算：d = min(beat 跨度, per_shot_sec(若有), 素材可用长)；有命中段以 best 为中心截 d、
 * 钳在 [0, duration-d]；无 segments 从 0 起。d 无法为正（素材/跨度异常）返回 null。
 */
export function computeWindow(
	beat: Pick<PlanBeat, "track_st" | "track_ed" | "per_shot_sec">,
	result: PlanResult,
): ClipWindow | null {
	const span = beat.track_ed - beat.track_st;
	if (!(span > 0)) return null;
	const dur = typeof result.duration === "number" && result.duration > 0 ? result.duration : undefined;
	let d = span;
	if (typeof beat.per_shot_sec === "number" && beat.per_shot_sec > 0) d = Math.min(d, beat.per_shot_sec);
	if (dur !== undefined) d = Math.min(d, dur);
	if (!(d > 0)) return null;

	const seg = result.segments?.[0];
	let clipSt = 0;
	if (seg && typeof seg.best === "number") {
		const maxSt = dur !== undefined ? Math.max(0, dur - d) : Math.max(0, seg.best - d / 2);
		clipSt = Math.min(Math.max(seg.best - d / 2, 0), maxSt);
	}
	const r3 = (n: number) => Math.round(n * 1000) / 1000;
	return {
		clip_st: r3(clipSt),
		clip_ed: r3(clipSt + d),
		track_st: r3(beat.track_st),
		track_ed: r3(beat.track_st + d),
	};
}

/** 代理 url 决策：出参 preview_url 优先；缺失按 cover_url 模式推导（keyframe/<id>/cover.jpg → preview/<id>.mp4）。 */
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

/** preview 代理的近似尺寸（≤640 宽等比、偶数高；缺原始宽高返回 undefined）。 */
export function previewDims(width?: number, height?: number): [number, number] | undefined {
	if (!width || !height || width <= 0 || height <= 0) return undefined;
	if (width <= 640) return [width, height];
	const h = Math.max(2, Math.round((height * 640) / width / 2) * 2);
	return [640, h];
}

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
 * 铺轨主函数（纯函数，不做 IO）：剥离上次自产物 → append 素材与 overlay 轨 → 写 struct_meta.broll。
 * @param downloads clip_id → 已落地代理信息；未下载成功的候选槽位被丢弃（调用方已告警）。
 */
export function layBrollTracks(opts: {
	gtrk: Record<string, unknown>;
	plan: BrollPlan;
	lay: number;
	downloads: Map<string, DownloadedProxy>;
	generatedAt: string;
	planPath: string;
}): LayResult {
	const { gtrk, plan, lay, downloads } = opts;
	const videoTracks = [...((gtrk.video_track as LooseTrack[] | undefined) ?? [])];
	const materials = [...((gtrk.materials as LooseMaterial[] | undefined) ?? [])];
	const structMeta = { ...((gtrk.struct_meta as Record<string, unknown> | undefined) ?? {}) };

	// ── 剥离自产物（幂等重铺；登记缺失宁留勿删）──
	const prevBroll = structMeta.broll as { lay_tracks?: unknown } | undefined;
	const prevIndices = new Set<number>(
		Array.isArray(prevBroll?.lay_tracks) ? (prevBroll!.lay_tracks as unknown[]).filter((x): x is number => typeof x === "number") : [],
	);
	const removedTracks = videoTracks.filter((t) => typeof t.track_index === "number" && prevIndices.has(t.track_index));
	const keptTracks = videoTracks.filter((t) => !(typeof t.track_index === "number" && prevIndices.has(t.track_index)));
	// 只删「broll- 前缀且被被删轨引用」的素材（宁留勿删）
	const removedMaterialIds = new Set<string>();
	for (const t of removedTracks) {
		for (const c of t.track_timeline ?? []) {
			const m = c.material;
			if (typeof m === "string" && m.startsWith(BROLL_MATERIAL_PREFIX)) removedMaterialIds.add(m);
		}
	}
	const keptMaterials = materials.filter((m) => !(typeof m.id === "string" && removedMaterialIds.has(m.id)));

	// ── 构建候选与轨 ──
	const canvas = Array.isArray(gtrk.video_size) ? (gtrk.video_size as number[]) : [1920, 1080];
	const baseIndex = keptTracks.reduce((mx, t) => Math.max(mx, typeof t.track_index === "number" ? t.track_index : 0), -1) + 1;

	const metaBeats: BrollMetaBeat[] = [];
	const newMaterialsById = new Map<string, LooseMaterial>();
	const trackClips: { track_index: number; clips: Record<string, unknown>[] }[] = [];
	let laidClips = 0;
	let beatsWithCandidates = 0;

	for (const beat of plan.beats) {
		const merged = mergedCandidates(beat);
		if (merged.length > 0) beatsWithCandidates++;
		const laid: BrollMetaBeat["laid"] = [];

		for (let k = 0; k < Math.max(0, lay); k++) {
			const cand = merged[k];
			if (!cand) continue;
			const dl = downloads.get(cand.clip_id);
			if (!dl) continue; // 下载失败丢槽位（调用方已告警）
			const win = computeWindow(beat, cand);
			if (!win) continue;

			const materialId = `${BROLL_MATERIAL_PREFIX}${cand.clip_id}`;
			if (!newMaterialsById.has(materialId)) {
				const dims = previewDims(cand.width, cand.height);
				const mat: LooseMaterial = { id: materialId, path: dl.rel };
				if (typeof cand.duration === "number") mat.duration = cand.duration;
				if (dims) mat.video_size = dims;
				if (typeof cand.fps === "number") mat.video_rate = cand.fps;
				newMaterialsById.set(materialId, mat);
			}
			let bucket = trackClips.find((t) => t.track_index === baseIndex + k);
			if (!bucket) {
				bucket = { track_index: baseIndex + k, clips: [] };
				trackClips.push(bucket);
			}
			bucket.clips.push({
				clip_id: `${beat.beat}-broll-${k}`,
				material: materialId,
				clip_st: win.clip_st,
				clip_ed: win.clip_ed,
				track_st: win.track_st,
				track_ed: win.track_ed,
				duration: Math.round((win.track_ed - win.track_st) * 1000) / 1000,
			});
			laid.push({ order: k, clip_id: cand.clip_id, track_index: baseIndex + k });
			laidClips++;
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

	// 空轨不建：lay_tracks 只记实际有 clip 的轨
	const createdTracks = trackClips
		.filter((t) => t.clips.length > 0)
		.sort((a, b) => a.track_index - b.track_index)
		.map((t) => ({
			track_index: t.track_index,
			track_size: [canvas[0], canvas[1]],
			muted: false,
			track_timeline: t.clips.sort((a, b) => (a.track_st as number) - (b.track_st as number)),
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
