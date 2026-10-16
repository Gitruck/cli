/**
 * 合成烘焙的计划层（change add-composite-bake，design D1 / D3 / D7）：纯计算、零 I/O（文件指纹经注入）。
 *
 * - 烘焙对象 = `beat_track` 上 HTML 带合成元数据块的颗粒（与颗粒预渲计划同口径，不论谁铺的）；
 * - 输入按**当前时间线**现算（`buildSnapshot`），不读 `composite/build.json`；
 * - 取用区间：逐个出片帧模拟出片台的取帧（`stage.html` 的 `sourceFor`，本文件 `sourceAt` 是它的 TS 镜像），
 *   按素材收集源时刻、相隔 ≥ `CLUSTER_GAP_SEC` 秒就分簇；出片台遇到簇外时刻会退回直接定位原素材并计数；
 * - 缓存键：烘焙 ABI + 出片台字节 + 颗粒 HTML + 现算输入 + 被引用素材指纹 + 帧率尺寸 + 浏览器构建。
 */
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { clipSpeed } from "./clip-speed";
import { detectComposite, type CompositeBlock } from "./composite-particle";
import { buildSnapshot, canonicalBytes, type CompositeSnapshot, type ResolveGtrk } from "./composite-resolve";
import { resolveParticleHtmlRef, type BeatLike, type MaterialLike } from "./particle-qtrle";

/** 烘焙 ABI：产物像素口径的版本（出片台取帧 / 绘制 / 截帧方式变了就加一，旧缓存随之失效）。 */
export const BAKE_ABI = 1;
/** 同一素材两段取用相隔超过它就各转一个中间文件（spike-1：避免把相隔很远的取用段并成一大段白转码）。 */
export const CLUSTER_GAP_SEC = 3;
/** 每段帧数（工作池任务单元；只管负载均衡）。 */
export const CHUNK_FRAMES = 90;
/** 合成舞台尺寸（`gtrk-composite@1` 恒 1920×1080）。 */
export const STAGE_SIZE: [number, number] = [1920, 1080];

export interface BakeClip {
	clip_id: string;
	material: string;
	clip_st: number;
	track_st: number;
	track_ed: number;
	speed: number;
}
export interface BakeTrack {
	index: number;
	clips: BakeClip[];
}

/** 出片台的一颗合成（`stageInit` 的 `entries[]` 元素，外加烘焙需要的身份字段）。 */
export interface BakeEntry {
	/** `composition_id`（缺席时 = `clip_id`）。 */
	id: string;
	clipId: string;
	trackIndex: number;
	/** 颗粒 HTML（内联的已读出；文件的读出后同样放这里）。 */
	html: string;
	/** 窗口（工程帧网格），秒。 */
	window: [number, number];
	window_f: [number, number];
	anchors_f: Record<string, number>;
	texts: Record<string, unknown>;
	bindings: Record<string, Record<string, unknown>>;
	snapshot: CompositeSnapshot;
}

export interface BakePlanFailure {
	clipId: string;
	id: string;
	reason: string;
}

export interface BakePlan {
	rate: number;
	tracks: BakeTrack[];
	entries: BakeEntry[];
	failed: BakePlanFailure[];
}

type Obj = Record<string, unknown>;
const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** `.gtrk` 视频轨 → 出片台轨表（含恒定变速）。 */
export function bakeTracks(gtrk: Obj): BakeTrack[] {
	return ((gtrk.video_track as Obj[] | undefined) ?? []).map((t) => ({
		index: num(t.track_index),
		clips: ((t.track_timeline as Obj[] | undefined) ?? [])
			.filter((c) => typeof c.material === "string" && c.material)
			.map((c) => ({
				clip_id: String(c.clip_id),
				material: String(c.material),
				clip_st: num(c.clip_st),
				track_st: num(c.track_st),
				track_ed: num(c.track_ed),
				speed: clipSpeed(c),
			})),
	}));
}

/**
 * 找出工程里的合成颗粒并按当前时间线组装出片输入。`readText` 读颗粒 HTML 文件（注入便于测试）。
 * 无效 / 未解析的合成颗粒、取不到 HTML 的颗粒记进 `failed`，不阻断其它颗。
 */
export function planBake(
	gtrk: Obj,
	gtrkDir: string,
	readText: (path: string) => string,
	{ only = [] as string[] } = {},
): BakePlan {
	const rate = num(gtrk.video_rate);
	const materials = (gtrk.materials as MaterialLike[] | undefined) ?? [];
	const entries: BakeEntry[] = [];
	const failed: BakePlanFailure[] = [];
	for (const t of (gtrk.beat_track as Obj[] | undefined) ?? []) {
		if (t.hidden === true) continue;
		const trackIndex = num(t.track_index, 10);
		for (const beat of (t.track_timeline as BeatLike[] | undefined) ?? []) {
			const clipId = typeof beat.clip_id === "string" && beat.clip_id ? beat.clip_id : String(beat.material ?? "?");
			const ref = resolveParticleHtmlRef(beat, materials, gtrkDir);
			if (!ref) continue; // 取不到 HTML 的普通颗粒归颗粒计划处理；这里只认合成
			let html: string;
			try {
				html = ref.kind === "inline" ? ref.html : readText(ref.path);
			} catch (e) {
				continue; // 读不出 → 也归颗粒计划报（它有统一的读失败口径）
			}
			const d = detectComposite(html);
			if (d.kind === "none") continue;
			const id = d.compositionId || clipId;
			if (only.length && !only.some((o) => o === id || o === clipId)) continue;
			if (d.kind === "invalid") {
				failed.push({ clipId, id, reason: `合成颗粒元数据无效：${d.reason ?? ""}` });
				continue;
			}
			const block = d.block as CompositeBlock;
			const resolved = block.resolved as Obj | undefined;
			if (!resolved || typeof resolved !== "object") {
				failed.push({ clipId, id, reason: "合成颗粒未解析（先跑 gtrk composite build）" });
				continue;
			}
			const beatWin = { track_st: num(beat.track_st), track_ed: num(beat.track_ed) };
			const snapshot = buildSnapshot(gtrk as unknown as ResolveGtrk, beatWin, block);
			const texts: Record<string, unknown> = {};
			for (const s of snapshot.slots) if (s.kind === "text") texts[String(s.slot)] = (s.cues as unknown[] | undefined) ?? [];
			const [f0, f1] = snapshot.window;
			if (!(f1 > f0)) {
				failed.push({ clipId, id, reason: "窗口时长为零" });
				continue;
			}
			entries.push({
				id,
				clipId,
				trackIndex,
				html,
				window: [f0 / rate, f1 / rate],
				window_f: [f0, f1],
				anchors_f: (resolved.anchors_f as Record<string, number> | undefined) ?? {},
				texts,
				bindings: (resolved.bindings as Record<string, Record<string, unknown>> | undefined) ?? {},
				snapshot,
			});
		}
	}
	if (only.length) {
		const seen = new Set([...entries.flatMap((e) => [e.id, e.clipId]), ...failed.flatMap((f) => [f.id, f.clipId])]);
		const missing = only.filter((o) => !seen.has(o));
		if (missing.length) throw new Error(`--only 点名的合成颗粒不存在：${missing.join("、")}`);
	}
	return { rate, tracks: bakeTracks(gtrk), entries, failed };
}

/** 产物帧数：`ceil(窗口时长 × fps)`，盖满整个窗口（spike-4：向下取整会在窗口末尾露出不足一帧的下层画面）。 */
export function bakeFrameCount(entry: Pick<BakeEntry, "window_f">, rate: number, fps: number): number {
	const dur = (entry.window_f[1] - entry.window_f[0]) / rate;
	return Math.ceil(dur * fps - 1e-9);
}

/** 第 k 个出片帧对应的时间线秒。 */
export const bakeFrameTime = (entry: Pick<BakeEntry, "window_f">, rate: number, fps: number, k: number): number =>
	entry.window_f[0] / rate + k / fps;

// ------------------------------------------------------------------ 取帧（stage.html sourceFor 的 TS 镜像）

export interface SourceRef {
	material: string;
	sec: number;
}

/**
 * 出片台在时间线秒 `T`、颗粒局部帧 `f` 为一个绑定取的源（素材 + 源秒）。**与 `assets/composite-kit/stage.html`
 * 的 `sourceFor` 同一算法**——那边改，这里同批改（`test/composite-bake-plan.test.mjs` 以样例对拍出片台）。
 */
export type ClipIndex = Map<string, { clip: BakeClip; clips: BakeClip[] }>;

/** 片段 id → 片段与它所在轨（按起点排序）；与出片台 `stageInit` 建的 `byClip` 同形。 */
export function clipIndex(tracks: BakeTrack[]): ClipIndex {
	const idx: ClipIndex = new Map();
	for (const t of tracks) {
		const clips = [...t.clips].sort((a, b) => a.track_st - b.track_st);
		for (const c of clips) idx.set(c.clip_id, { clip: c, clips });
	}
	return idx;
}

export function sourceAt(b: Record<string, unknown>, T: number, f: number, index: ClipIndex, rate: number): SourceRef | null {
	const lastT = (c: BakeClip) => c.track_ed - 1 / rate;
	const src = (c: BakeClip, t: number) => c.clip_st + (t - c.track_st) * c.speed;
	const laneOf = (clipId: string) => index.get(clipId) ?? null;
	if (b.kind === "ref") {
		const hit = laneOf(String(b.clip_id));
		if (!hit) return null;
		const c = hit.clip;
		return { material: c.material, sec: src(c, Math.min(Math.max(T, c.track_st), lastT(c))) };
	}
	if (b.kind === "ref-lane") {
		const hit = laneOf(String(b.lane_clip_id));
		if (!hit) return null;
		const act = hit.clips.find((c) => T >= c.track_st && T < c.track_ed);
		if (act) return { material: act.material, sec: src(act, T) };
		const prev = hit.clips.filter((c) => c.track_ed <= T).pop();
		if (prev) return { material: prev.material, sec: src(prev, lastT(prev)) };
		const next = hit.clips.find((c) => c.track_st > T);
		return next ? { material: next.material, sec: next.clip_st } : null;
	}
	if (b.kind === "own" && typeof b.material === "string") {
		const k = Math.min(Math.max(f - num(b.starts_at_f), 0), num(b.dur_f, 1) - 1);
		return { material: b.material, sec: num(b.src_in_ms) / 1000 + k / rate };
	}
	return null;
}

/** 一个素材的一簇取用段（源秒，闭区间）。 */
export interface SourceCluster {
	material: string;
	from: number;
	to: number;
}

/** 逐出片帧模拟取帧，按素材收集源秒并按间隔分簇。 */
export function sourceClusters(plan: BakePlan, fps: number, gap = CLUSTER_GAP_SEC): SourceCluster[] {
	const secs = new Map<string, number[]>();
	const index = clipIndex(plan.tracks);
	for (const e of plan.entries) {
		const n = bakeFrameCount(e, plan.rate, fps);
		for (let k = -1; k < n; k++) {
			// k = -1：段首预滚可能取到的前一帧（窗口起点之前的那一帧）
			const T = bakeFrameTime(e, plan.rate, fps, Math.max(k, 0)) - (k < 0 ? 1 / fps : 0);
			const F = Math.round(T * plan.rate);
			const f = Math.min(Math.max(F - e.window_f[0], 0), e.window_f[1] - e.window_f[0] - 1);
			const Tf = (e.window_f[0] + f) / plan.rate;
			for (const b of Object.values(e.bindings)) {
				if (!b || b.kind === "text") continue;
				const s = sourceAt(b, Tf, f, index, plan.rate);
				if (!s) continue;
				const list = secs.get(s.material) ?? [];
				list.push(s.sec);
				secs.set(s.material, list);
			}
		}
	}
	const out: SourceCluster[] = [];
	for (const [material, list] of secs) {
		list.sort((a, b) => a - b);
		let cur: SourceCluster | null = null;
		for (const s of list) {
			if (cur && s - cur.to < gap) cur.to = Math.max(cur.to, s);
			else {
				cur = { material, from: s, to: s };
				out.push(cur);
			}
		}
	}
	return out;
}

// ------------------------------------------------------------------ 缓存键

export interface MaterialFingerprint {
	id: string;
	size: number;
	mtime_ms: number;
}

/** 合成用到的全部素材 id（逐帧取帧 + own 绑定），按 id 排序。 */
export function entryMaterials(entry: BakeEntry, plan: Pick<BakePlan, "rate" | "tracks">, fps: number): string[] {
	const ids = new Set<string>();
	const sub: BakePlan = { rate: plan.rate, tracks: plan.tracks, entries: [entry], failed: [] };
	for (const c of sourceClusters(sub, fps)) ids.add(c.material);
	for (const b of Object.values(entry.bindings)) if (b?.kind === "own" && typeof b.material === "string") ids.add(b.material);
	return [...ids].sort();
}

/**
 * 缓存键（design D7）：覆盖且仅覆盖决定像素的输入。`fingerprint` 给出素材文件指纹（缺失时返回 null，键里记 missing）。
 * 不含工作池参数 / 分段方式——分段等价由确定性旗标与预滚保证。
 */
export function bakeCacheKey(
	entry: BakeEntry,
	plan: Pick<BakePlan, "rate" | "tracks">,
	opts: {
		fps: number;
		browserBuild: string;
		stageSha256: string;
		/** 编码参数签名（编码设置一变，旧产物不再命中）。 */
		encodeSig: string;
		fingerprint: (materialId: string) => MaterialFingerprint | null;
	},
): string {
	const fps = Math.round(opts.fps);
	const materials = entryMaterials(entry, plan, fps).map((id) => opts.fingerprint(id) ?? { id, size: -1, mtime_ms: -1 });
	// 取帧随时间线上片段位置与变速变化：把用到的片段（起止、入点、速度）一并进键（速度可能非整数，转字符串）
	const clips = plan.tracks
		.flatMap((t) => t.clips)
		.filter((c) => materials.some((m) => m.id === c.material))
		.map((c) => [c.clip_id, c.material, String(c.clip_st), String(c.track_st), String(c.track_ed), String(c.speed)])
		.sort();
	const identity = {
		abi: BAKE_ABI,
		stage: opts.stageSha256,
		html: createHash("sha256").update(entry.html).digest("hex"),
		inputs: createHash("sha256").update(canonicalBytes(entry.snapshot)).digest("hex"),
		clips,
		materials: materials.map((m) => [m.id, String(m.size), String(Math.round(m.mtime_ms))]),
		fps,
		size: STAGE_SIZE.map(String),
		browser: opts.browserBuild,
		encode: opts.encodeSig,
	};
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
}

/** 素材 id → 绝对路径（相对路径按 `base` 解析；无 path 的返回 null）。 */
export function materialPath(gtrk: Obj, id: string, base: string): string | null {
	const m = ((gtrk.materials as Obj[] | undefined) ?? []).find((x) => x.id === id);
	const p = m && typeof m.path === "string" && m.path ? m.path : null;
	return p ? (isAbsolute(p) ? p : resolve(base, p)) : null;
}

/** 图片素材（按扩展名；出片台用 <img> 画）。 */
export const isImagePath = (p: string): boolean => /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(p);
