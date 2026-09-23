/**
 * `gtrk pip lay` 的纯函数层（add-pip-companion-lay）：双源画中画——把口播粗剪的每个切点镜像到**同步录制的伴随源**
 * （屏录 / 第二机位），铺出「伴随源满幅轨 + 人像画中画副本轨」，画中画带契约 `clip_transform` / `border_radius` / `clip_mask`。
 *
 * 布局 A（design D1，主理人拍板）：主轨与镜像音轨**一字不动**（`split` / `subtitle lay` 对 transcript 的锚不变），
 * 新增两条叠加视频轨：`N+1` 伴随源满幅（`muted:true`）、`N+2` 人像画中画副本（主轨 clip 的复制、新 `clip_id`、`muted:true`——
 * 人声由主轨镜像音轨承担，MUST NOT 双声）。
 *
 * 偏移口径与 `gtrk audio align` 同一套：`offset` = 伴随源 t=0 落在参考（人像）时钟上的位置，**正 = 伴随源晚开录**
 * ⇒ 参考时刻 R 对应伴随源时刻 `R − offset`。镜像切点只改源窗起点 `clip_st' = clip_st − offset`，
 * `track_st / duration` **原样**取主轨值（接缝零重叠自动继承，T2）；整毫秒域计算（T1），源窗以 `[0, 伴随源时长 + 1ms]` 为墙
 * 两端各钳一次（T5「值与墙同钳」）：可用区间为空 → 留空不铺；短于 duration → 只铺可用部分、其余留空；MUST NOT 拉伸或变速。
 * 换算只走 `frame-domain.ts`（T3）。`clip_st'` 保源钟毫秒、不吸源帧（契约 §1.1；屏录多 VFR / 与人像帧率不同）。
 *
 * 幂等：自产 clip 全部写 `producer = {by:"gtrk:pip@1", run}`；重铺先剥 `by` 同值的 clip，剥空的轨删除；用户动过而失去身份的
 * clip 保留 + 明示（`add-clip-producer-identity` 纪律）。写盘前 `assertGtrkWriteInvariants(ownClipIds)`（本模块不写盘）。
 */
import { ms2sec, r3, sec2ms } from "./frame-domain";
import { assertGtrkWriteInvariants } from "./gtrk-invariants";

export const PIP_PRODUCER_BY = "gtrk:pip@1";
export const PIP_COMPANION_MATERIAL_ID = "pip-companion";
export const PIP_COMPANION_TRACK_NAME = "屏录";
export const PIP_TRACK_NAME = "人像画中画";
export type PipShape = "ellipse" | "rectangle" | "heart" | "diamond" | "star" | "none";
export type PipAnchor = "bottom-right" | "bottom-left" | "top-right" | "top-left" | "center";
export const PIP_SHAPES: readonly PipShape[] = ["ellipse", "rectangle", "heart", "diamond", "star", "none"];
export const PIP_ANCHORS: readonly PipAnchor[] = ["bottom-right", "bottom-left", "top-right", "top-left", "center"];

export function pipProducerTag(run: string): string {
	return JSON.stringify({ by: PIP_PRODUCER_BY, run });
}

/** 该 clip 是否本零件自产（`producer.by` 逐字等于本命名空间）。 */
export function isPipProduced(clip: { producer?: unknown }): boolean {
	if (typeof clip.producer !== "string") return false;
	try {
		const p = JSON.parse(clip.producer) as { by?: unknown };
		return p?.by === PIP_PRODUCER_BY;
	} catch {
		return false;
	}
}

// ─────────────────────────── 镜像切点（design D3） ───────────────────────────

export interface MainClipView {
	/** 源素材 id；随视图携带，铺轨 MUST NOT 按 clip_id 反查主轨（同轨同名 clip_id 在真产物里存在） */
	material: string;
	clip_id: string;
	clip_st: number;
	track_st: number;
	duration: number;
}

export interface MirroredCut {
	/** 来源主轨 clip。 */
	from: string;
	/** 伴随源轨上的落位（与主轨逐字节同）。 */
	track_st: number;
	track_ed: number;
	/** 铺出的时长（≤ 主轨 duration；等于 0 ⇒ 留空）。 */
	duration: number;
	/** 伴随源源窗起点（源钟秒，已钳）。 */
	clip_st: number;
	clip_ed: number;
	/** 被钳掉的毫秒数（头 / 尾）；两者之和 = 主轨 duration − 铺出 duration。 */
	clamped_head_ms: number;
	clamped_tail_ms: number;
	/** 整段不可用 ⇒ 留空。 */
	empty: boolean;
}

/**
 * 主轨切点 → 伴随源轨切点。`offsetSec` 为伴随源 t=0 在参考钟上的位置（正 = 晚开录）；`companionDurationSec` = 伴随源实测时长。
 */
export function mirrorCuts(mainClips: readonly MainClipView[], offsetSec: number, companionDurationSec: number): MirroredCut[] {
	const offMs = sec2ms(offsetSec);
	const wallMs = sec2ms(companionDurationSec) + 1; // 素材上界 +1ms 容差（gtrk-invariants `assertSourceBound` 同口径）
	const out: MirroredCut[] = [];
	for (const c of mainClips) {
		const durMs = sec2ms(c.duration);
		const trackStMs = sec2ms(c.track_st);
		const srcStMs = sec2ms(c.clip_st) - offMs; // 伴随源源钟
		const srcEdMs = srcStMs + durMs;
		const usableSt = Math.max(srcStMs, 0);
		const usableEd = Math.min(srcEdMs, wallMs);
		const headClamp = usableSt - srcStMs;
		const tailClamp = srcEdMs - usableEd;
		const laidMs = usableEd - usableSt;
		if (laidMs <= 0 || durMs <= 0) {
			out.push({
				from: c.clip_id,
				track_st: ms2sec(trackStMs),
				track_ed: ms2sec(trackStMs + durMs),
				duration: 0,
				clip_st: 0,
				clip_ed: 0,
				clamped_head_ms: durMs,
				clamped_tail_ms: 0,
				empty: true,
			});
			continue;
		}
		// 头部被钳时轨上落位随之后移（伴随源在那一段不存在，MUST NOT 拉伸补齐）
		const laidTrackSt = trackStMs + headClamp;
		out.push({
			from: c.clip_id,
			track_st: ms2sec(laidTrackSt),
			track_ed: ms2sec(laidTrackSt + laidMs),
			duration: ms2sec(laidMs),
			clip_st: ms2sec(usableSt),
			clip_ed: ms2sec(usableSt + laidMs),
			clamped_head_ms: headClamp,
			clamped_tail_ms: tailClamp,
			empty: false,
		});
	}
	return out;
}

// ─────────────────────────── 画中画几何与蒙版（design D4） ───────────────────────────

export interface PipGeometry {
	/** 契约 `clip_transform`。 */
	clip_transform: { position_x: number; position_y: number; scale_x: number; scale_y: number; rotation: number; alpha: number };
	/** 画中画显示尺寸（画布像素）。 */
	width: number;
	height: number;
}

/**
 * 用户量 → 契约变换：`scale` = 画中画显示**高度**占画布高度比例（缺省 0.28）；`anchor` 缺省右下；`margin` 画布像素（缺省 40）。
 * `k = (scale × H) / fitH`（contain-fit 反算），位置按中心原点（+y 下）。
 */
export function pipGeometry(args: {
	canvas: [number, number];
	materialSize?: [number, number];
	scale?: number;
	anchor?: PipAnchor;
	margin?: number;
}): PipGeometry {
	const [W, H] = args.canvas;
	const mw = args.materialSize && args.materialSize[0] > 0 ? args.materialSize[0] : W;
	const mh = args.materialSize && args.materialSize[1] > 0 ? args.materialSize[1] : H;
	const fit = Math.min(W / mw, H / mh);
	const fitW = mw * fit;
	const fitH = mh * fit;
	const s = args.scale !== undefined && Number.isFinite(args.scale) && args.scale > 0 ? args.scale : 0.28;
	const k = r3((s * H) / fitH);
	const w = fitW * k;
	const h = fitH * k;
	const m = args.margin !== undefined && Number.isFinite(args.margin) && args.margin >= 0 ? args.margin : 40;
	const anchor = args.anchor ?? "bottom-right";
	let px = 0;
	let py = 0;
	if (anchor !== "center") {
		px = anchor.endsWith("right") ? W / 2 - w / 2 - m : -(W / 2 - w / 2 - m);
		py = anchor.startsWith("bottom") ? H / 2 - h / 2 - m : -(H / 2 - h / 2 - m);
	}
	return {
		clip_transform: { position_x: r3(px), position_y: r3(py), scale_x: k, scale_y: k, rotation: 0, alpha: 1 },
		width: r3(w),
		height: r3(h),
	};
}

export interface PipMaskSpec {
	shape: Exclude<PipShape, "none">;
	center_x?: number;
	center_y?: number;
	width: number;
	height: number;
	corner_radius?: number;
	feather?: number;
}

/**
 * 契约 `clip_mask`（元素归一化、中心原点）：`ellipse` / `heart` / `diamond` / `star` = 短边内切（`width×w == height×h`）；
 * `rectangle` = 满幅 + `corner_radius`（缺省 0.25）；`none` → undefined。
 */
export function pipMask(args: {
	shape: PipShape;
	width: number;
	height: number;
	feather?: number;
	cornerRadius?: number;
}): PipMaskSpec | undefined {
	if (args.shape === "none") return undefined;
	const feather = args.feather !== undefined && Number.isFinite(args.feather) ? Math.min(100, Math.max(0, args.feather)) : 10;
	if (args.shape === "rectangle") {
		const cr = args.cornerRadius !== undefined && Number.isFinite(args.cornerRadius) ? Math.min(1, Math.max(0, args.cornerRadius)) : 0.25;
		return { shape: "rectangle", width: 1, height: 1, ...(cr > 0 ? { corner_radius: r3(cr) } : {}), ...(feather > 0 ? { feather: r3(feather) } : {}) };
	}
	const short = Math.min(args.width, args.height);
	if (!(short > 0)) return undefined;
	return {
		shape: args.shape,
		width: r3(short / args.width),
		height: r3(short / args.height),
		...(feather > 0 ? { feather: r3(feather) } : {}),
	};
}

// ─────────────────────────── 铺轨（design D1 / D6） ───────────────────────────

interface LooseTrack {
	track_index?: unknown;
	track_timeline?: Record<string, unknown>[];
	[k: string]: unknown;
}

const isGapClip = (c: Record<string, unknown>): boolean => c.material === null || c.material === undefined;

/** 主轨 = `track_index` 最小的非黑底垫轨（与 `matrix lay` / `render` 的 `pickPreviewMainTrack` 同口径）。 */
export function pickMainTrack(gtrk: Record<string, unknown>): LooseTrack | undefined {
	const tracks = (Array.isArray(gtrk.video_track) ? gtrk.video_track : []) as LooseTrack[];
	const black = (gtrk.struct_meta as { broll?: { black_track?: unknown } } | undefined)?.broll?.black_track ?? null;
	const sorted = tracks
		.filter((t) => typeof t.track_index === "number")
		.sort((a, b) => (a.track_index as number) - (b.track_index as number));
	const nonBlack = typeof black === "number" ? sorted.filter((t) => t.track_index !== black) : sorted;
	return nonBlack[0] ?? sorted[0];
}

export function mainClipViews(track: LooseTrack): MainClipView[] {
	const out: MainClipView[] = [];
	for (const c of track.track_timeline ?? []) {
		if (isGapClip(c)) continue;
		const clipId = typeof c.clip_id === "string" ? c.clip_id : "";
		const clipSt = Number(c.clip_st);
		const trackSt = Number(c.track_st);
		const duration = Number(c.duration);
		if (!clipId || !Number.isFinite(clipSt) || !Number.isFinite(trackSt) || !(duration > 0)) continue;
		out.push({ clip_id: clipId, material: String(c.material ?? ""), clip_st: clipSt, track_st: trackSt, duration });
	}
	return out;
}

export interface StripResult {
	gtrk: Record<string, unknown>;
	removedClips: number;
	removedTracks: number[];
	/** 曾在自产轨上、但已失去身份（用户动过）的 clip：保留 + 明示。 */
	keptForeign: Array<{ track_index: number; clip_id: string }>;
}

/** 剥旧：删本零件自产 clip（按 `producer.by`），剥空的轨整条删除；其他轨与 `track_index` 不动。 */
export function stripPipClips(gtrk: Record<string, unknown>): StripResult {
	const tracks = (Array.isArray(gtrk.video_track) ? gtrk.video_track : []) as LooseTrack[];
	const prevMeta = (gtrk.struct_meta as { pip?: { lay_tracks?: unknown } } | undefined)?.pip;
	const prevTracks = new Set(
		Array.isArray(prevMeta?.lay_tracks) ? (prevMeta!.lay_tracks as unknown[]).filter((n): n is number => typeof n === "number") : [],
	);
	let removedClips = 0;
	const removedTracks: number[] = [];
	const keptForeign: StripResult["keptForeign"] = [];
	const nextTracks: LooseTrack[] = [];
	for (const t of tracks) {
		const clips = t.track_timeline ?? [];
		const own = clips.filter((c) => isPipProduced(c));
		if (own.length === 0) {
			nextTracks.push(t);
			continue;
		}
		const foreign = clips.filter((c) => !isPipProduced(c) && !isGapClip(c));
		removedClips += own.length;
		if (foreign.length === 0) {
			if (typeof t.track_index === "number") removedTracks.push(t.track_index);
			continue; // 整条自产轨：删
		}
		for (const c of foreign) {
			keptForeign.push({ track_index: typeof t.track_index === "number" ? t.track_index : -1, clip_id: String(c.clip_id ?? "") });
		}
		nextTracks.push({ ...t, track_timeline: foreign });
	}
	// 登记过但已被用户整条删掉的轨：不在 tracks 里，无事可做
	void prevTracks;
	const materials = (Array.isArray(gtrk.materials) ? gtrk.materials : []) as Record<string, unknown>[];
	const keptMaterials = materials.filter((m) => m.id !== PIP_COMPANION_MATERIAL_ID);
	return {
		gtrk: { ...gtrk, video_track: nextTracks, materials: keptMaterials },
		removedClips,
		removedTracks: removedTracks.sort((a, b) => a - b),
		keptForeign,
	};
}

export interface StructMetaPip {
	contract_version: "v1";
	generated_at: string;
	offset_sec: number;
	confidence?: number;
	companion: { material_id: string; path: string; duration: number; video_size?: [number, number] };
	lay_tracks: number[];
	companion_track: number | null;
	pip_track: number | null;
	geometry: PipGeometry["clip_transform"];
	border_radius?: number;
	clip_mask?: PipMaskSpec;
	cuts: Array<Pick<MirroredCut, "from" | "track_st" | "track_ed" | "duration" | "clip_st" | "clamped_head_ms" | "clamped_tail_ms" | "empty">>;
}

export interface BuildPipArgs {
	gtrk: Record<string, unknown>;
	/** 伴随源（相对 gtrk 目录的落地路径或绝对路径，原样写进 materials.path）。 */
	companion: { path: string; duration: number; video_size?: [number, number]; video_rate?: number };
	offsetSec: number;
	confidence?: number;
	geometry: PipGeometry;
	mask?: PipMaskSpec;
	borderRadius?: number;
	generatedAt: string;
	warn?: (m: string) => void;
	info?: (m: string) => void;
}

export interface BuildPipResult {
	next: Record<string, unknown>;
	meta: StructMetaPip;
	summary: {
		companionTrack: number | null;
		pipTrack: number | null;
		laidCompanion: number;
		laidPip: number;
		emptyCuts: number;
		clampedCuts: number;
		strip: Omit<StripResult, "gtrk">;
	};
}

/**
 * 铺轨主函数（纯：不读盘不写盘）。先剥旧再铺；主轨零改动；两条新轨 `track_index` = 剥旧后现存最大 + 1 / + 2；
 * 写方自检在返回前跑（违约即抛、命令层还没到 `writeGtrkAtomic` ⇒ 工程零改动）。
 */
export function buildPipTracks(args: BuildPipArgs): BuildPipResult {
	const strip = stripPipClips(args.gtrk);
	const gtrk = strip.gtrk;
	const main = pickMainTrack(gtrk);
	if (!main) throw new Error("工程没有视频主轨，无法镜像切点");
	const mainViews = mainClipViews(main);
	if (mainViews.length === 0) throw new Error("主轨没有可镜像的 clip（全是空档或时码缺失）");
	const cuts = mirrorCuts(mainViews, args.offsetSec, args.companion.duration);

	const tracks = (Array.isArray(gtrk.video_track) ? gtrk.video_track : []) as LooseTrack[];
	const maxIndex = Math.max(
		-1,
		...tracks.map((t) => (typeof t.track_index === "number" ? t.track_index : -1)),
		...((Array.isArray(gtrk.beat_track) ? gtrk.beat_track : []) as LooseTrack[]).map((t) =>
			typeof t.track_index === "number" ? t.track_index : -1,
		),
	);
	const companionIndex = maxIndex + 1;
	const pipIndex = maxIndex + 2;
	const producer = pipProducerTag(args.generatedAt);
	const canvas = gtrk.video_size as [number, number];

	// 伴随源满幅轨
	const companionClips: Record<string, unknown>[] = [];
	const seenIds = new Map<string, number>();
	const uniqueId = (base: string): string => {
		const n = (seenIds.get(base) ?? 0) + 1;
		seenIds.set(base, n);
		return n === 1 ? base : `${base}~${n}`;
	};
	let emptyCuts = 0;
	let clampedCuts = 0;
	for (const cut of cuts) {
		if (cut.empty) {
			emptyCuts++;
			args.info?.(`镜像切点：主轨 ${cut.from}（${r3(cut.track_st)}–${r3(cut.track_ed)}s）在伴随源中不存在，留空`);
			continue;
		}
		if (cut.clamped_head_ms > 0 || cut.clamped_tail_ms > 0) {
			clampedCuts++;
			args.info?.(
				`镜像切点：主轨 ${cut.from} 伴随源源窗越界，钳掉头 ${cut.clamped_head_ms}ms / 尾 ${cut.clamped_tail_ms}ms（该段留空，不拉伸）`,
			);
		}
		companionClips.push({
			clip_id: uniqueId(`pip-c-${cut.from}`),
			material: PIP_COMPANION_MATERIAL_ID,
			clip_st: cut.clip_st,
			clip_ed: cut.clip_ed,
			track_st: cut.track_st,
			track_ed: cut.track_ed,
			duration: cut.duration,
			muted: true,
			producer,
		});
	}

	// 人像画中画副本轨（主轨 clip 复制：同 material / 同源窗 / 同落位；新 clip_id；静音；带几何与蒙版）
	const pipClips: Record<string, unknown>[] = [];
	for (const v of mainViews) {
		if (!v.material) continue;
		pipClips.push({
			clip_id: uniqueId(`pip-p-${v.clip_id}`),
			material: v.material,
			clip_st: v.clip_st,
			clip_ed: r3(v.clip_st + v.duration),
			track_st: v.track_st,
			track_ed: r3(v.track_st + v.duration),
			duration: v.duration,
			muted: true,
			clip_transform: args.geometry.clip_transform,
			...(args.borderRadius !== undefined && args.borderRadius > 0 ? { border_radius: r3(args.borderRadius) } : {}),
			...(args.mask ? { clip_mask: args.mask } : {}),
			producer,
		});
	}

	const companionTrack: LooseTrack | null = companionClips.length
		? {
				track_index: companionIndex,
				track_size: canvas,
				track_name: PIP_COMPANION_TRACK_NAME,
				muted: true,
				track_timeline: companionClips,
			}
		: null;
	const pipTrack: LooseTrack | null = pipClips.length
		? {
				track_index: pipIndex,
				track_size: canvas,
				track_name: PIP_TRACK_NAME,
				muted: true,
				track_timeline: pipClips,
			}
		: null;
	const created = [companionTrack, pipTrack].filter((t): t is LooseTrack => t !== null);

	const companionMaterial: Record<string, unknown> = {
		id: PIP_COMPANION_MATERIAL_ID,
		path: args.companion.path,
		duration: r3(args.companion.duration),
		...(args.companion.video_size ? { video_size: args.companion.video_size } : {}),
		...(args.companion.video_rate ? { video_rate: args.companion.video_rate } : {}),
	};
	const meta: StructMetaPip = {
		contract_version: "v1",
		generated_at: args.generatedAt,
		offset_sec: r3(args.offsetSec),
		...(args.confidence !== undefined ? { confidence: r3(args.confidence) } : {}),
		companion: {
			material_id: PIP_COMPANION_MATERIAL_ID,
			path: args.companion.path,
			duration: r3(args.companion.duration),
			...(args.companion.video_size ? { video_size: args.companion.video_size } : {}),
		},
		lay_tracks: created.map((t) => t.track_index as number),
		companion_track: companionTrack ? companionIndex : null,
		pip_track: pipTrack ? pipIndex : null,
		geometry: args.geometry.clip_transform,
		...(args.borderRadius !== undefined && args.borderRadius > 0 ? { border_radius: r3(args.borderRadius) } : {}),
		...(args.mask ? { clip_mask: args.mask } : {}),
		cuts: cuts.map(({ from, track_st, track_ed, duration, clip_st, clamped_head_ms, clamped_tail_ms, empty }) => ({
			from, track_st, track_ed, duration, clip_st, clamped_head_ms, clamped_tail_ms, empty,
		})),
	};
	const structMeta = { ...((gtrk.struct_meta as Record<string, unknown> | undefined) ?? {}), pip: meta };
	const materials = (Array.isArray(gtrk.materials) ? gtrk.materials : []) as Record<string, unknown>[];
	const next: Record<string, unknown> = {
		...gtrk,
		materials: [...materials, companionMaterial],
		video_track: [...tracks, ...created],
		struct_meta: structMeta,
	};
	assertGtrkWriteInvariants(next, "pip lay", {
		ownClipIds: new Set([...companionClips, ...pipClips].map((c) => c.clip_id as string)),
		warn: args.warn,
	});
	return {
		next,
		meta,
		summary: {
			companionTrack: companionTrack ? companionIndex : null,
			pipTrack: pipTrack ? pipIndex : null,
			laidCompanion: companionClips.length,
			laidPip: pipClips.length,
			emptyCuts,
			clampedCuts,
			strip: { removedClips: strip.removedClips, removedTracks: strip.removedTracks, keptForeign: strip.keptForeign },
		},
	};
}

// ─────────────────────────── 低置信兜底：对齐工程（design D2） ───────────────────────────

/** 双视频对齐工程（Profile B）：main = 人像整段、overlay = 伴随源整段按估测偏移摆放；用户在客户端拖齐两条画面后保存。 */
export function buildPipAlignProject(args: {
	referenceAbs: string;
	companionAbs: string;
	offsetEstimate: number;
	referenceGeo: { width: number; height: number; rate: number; duration: number };
	companionGeo: { width: number; height: number; duration: number };
}): Record<string, unknown> {
	const fwd = (p: string): string => p.replace(/\\/g, "/");
	const vStart = r3(Math.max(0, -args.offsetEstimate));
	const cStart = r3(Math.max(0, args.offsetEstimate));
	const { width, height, rate } = args.referenceGeo;
	return {
		version: "v1",
		video_size: [width, height],
		video_rate: rate,
		duration: r3(Math.max(vStart + args.referenceGeo.duration, cStart + args.companionGeo.duration)),
		materials: [
			{ id: "pip-align-ref", path: fwd(args.referenceAbs), duration: r3(args.referenceGeo.duration), video_size: [width, height], video_rate: rate },
			{ id: "pip-align-comp", path: fwd(args.companionAbs), duration: r3(args.companionGeo.duration), video_size: [args.companionGeo.width, args.companionGeo.height] },
		],
		video_track: [
			{
				track_index: 0,
				track_size: [width, height],
				track_name: "人像（参考）",
				track_timeline: [
					{ clip_id: "pip-align-ref-0", material: "pip-align-ref", clip_st: 0, clip_ed: r3(args.referenceGeo.duration), track_st: vStart, track_ed: r3(vStart + args.referenceGeo.duration), duration: r3(args.referenceGeo.duration) },
				],
			},
			{
				track_index: 1,
				track_size: [width, height],
				track_name: "伴随源（拖到与人像对齐）",
				muted: true,
				track_timeline: [
					{ clip_id: "pip-align-comp-0", material: "pip-align-comp", clip_st: 0, clip_ed: r3(args.companionGeo.duration), track_st: cStart, track_ed: r3(cStart + args.companionGeo.duration), duration: r3(args.companionGeo.duration), muted: true },
				],
			},
		],
		audio_track: [],
		beat_track: [],
	};
}

export interface PipAlignResume {
	referenceAbs: string;
	companionAbs: string;
	/** 用户确认后的偏移（伴随源轨 track_st − 人像轨 track_st）。 */
	offsetSec: number;
}

/** 读回对齐工程：两条轨首 clip 的 `track_st` 之差即人工确认偏移。 */
export function readPipAlignOffset(doc: Record<string, unknown>, resolveAbs: (p: string) => string): PipAlignResume {
	const materials = (Array.isArray(doc.materials) ? doc.materials : []) as Record<string, unknown>[];
	const byId = new Map(materials.map((m) => [String(m.id), m]));
	const tracks = (Array.isArray(doc.video_track) ? doc.video_track : []) as LooseTrack[];
	const first = (materialId: string): Record<string, unknown> | undefined => {
		for (const t of tracks) for (const c of t.track_timeline ?? []) if (c.material === materialId) return c;
		return undefined;
	};
	const ref = first("pip-align-ref");
	const comp = first("pip-align-comp");
	if (!ref || !comp) throw new Error("对齐工程不完整：找不到人像 / 伴随源 clip（须由 gtrk pip lay 产出、客户端只拖不删）");
	const refPath = String(byId.get("pip-align-ref")?.path ?? "");
	const compPath = String(byId.get("pip-align-comp")?.path ?? "");
	if (!refPath || !compPath) throw new Error("对齐工程素材缺 path，无法定位原文件");
	return {
		referenceAbs: resolveAbs(refPath),
		companionAbs: resolveAbs(compPath),
		offsetSec: r3(Number(comp.track_st ?? 0) - Number(ref.track_st ?? 0)),
	};
}
