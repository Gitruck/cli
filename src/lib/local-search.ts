/**
 * 本地索引检索（add-matrix-local-search · local-material-search spec）。
 *
 * 链路：查询文本经自建端点 embed（调用方负责）→ 索引全量载入内存 Float32Array →
 * 进程内点积（MUST NOT 经任何网络检索服务）→ 帧命中聚合为素材内 sub-segment →
 * 组装与云端 PlanResult **同构**的本地形态结果（source:"local"，url 系字段 MUST NOT 出现）。
 *
 * 聚合（D5）：media_matrix aggregate_frame_hits_to_subsegments 语义的 TS 移植，
 * 以 POC pipeline.py 的 aggregate() 为黄金样本逐条对拍（单测 fixture 由该 Python 函数原样跑出）：
 * gap≤3000ms 归窗 → ±750ms buffer → 窗分 top3 加权 0.5/0.3/0.2（不足 3 帧取最高分）
 * → best=窗内最高分帧 → 场景边界对齐裁剪 → 窗宽 <1500ms 丢弃（CLI 侧增量）。
 * 丢弃判定放在**对齐之后**：对齐只会扩窗，先丢会把 POC 保留的「素材端点碎窗被场景对齐救回」
 * 的段错杀——黄金样本对拍（spec SHALL）优先于参数罗列顺序。
 */
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { PlanResult } from "./matrix";
import { BROLL_MATERIAL_PREFIX } from "./matrix-lay";
import { decodeVec, type SqlDb } from "./local-index";

// ── 聚合参数（POC 标定基线）───────────────────────────────────────────────
export const AGG_GAP_MS = 3000;
export const AGG_BUFFER_MS = 750;
/** 窗宽下限（毫秒）：buffer 后仍窄于此（只能是被素材端点钳出来的碎窗）即丢弃。 */
export const MIN_SEGMENT_WIDTH_MS = 1500;
/** 每查询进入聚合的 top 帧数（POC TOPK_FRAMES）。 */
export const TOPK_FRAMES_DEFAULT = 60;
/** 本地模式 score 地板缺省值（--score-floor；独立参数，MUST NOT 复用云端地板的校准假设——
 * 数值上同为 0.2 是 POC 对本域的标定结果，完美命中可低至 0.246，处置表见 SKILL.md）。 */
export const LOCAL_SCORE_FLOOR_DEFAULT = 0.2;

/** 单帧命中（聚合输入；同素材内按 ts 升序）。 */
export interface FrameHit {
	ts_ms: number;
	scene_st_ms: number;
	scene_ed_ms: number;
	duration_ms: number;
	score: number;
}

/** 聚合产物（素材内命中段，毫秒；按 score 降序）。 */
export interface SubSegment {
	start_ms: number;
	end_ms: number;
	best_ts_ms: number;
	score: number;
	best_frame_score: number;
	n_frames: number;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * 帧命中 → sub-segments（POC aggregate() 语义逐行对齐 + 窗宽丢弃增量）。
 * 入参 hits 须为**同一素材**内、按 ts_ms 升序。
 */
export function aggregateFrameHits(
	hits: FrameHit[],
	opts: { gapMs?: number; bufferMs?: number; minWidthMs?: number } = {},
): SubSegment[] {
	if (!hits.length) return [];
	const gapMs = opts.gapMs ?? AGG_GAP_MS;
	const bufferMs = opts.bufferMs ?? AGG_BUFFER_MS;
	const minWidthMs = opts.minWidthMs ?? MIN_SEGMENT_WIDTH_MS;

	// gap 归窗
	const windows: FrameHit[][] = [];
	let cur: FrameHit[] = [hits[0]!];
	for (const h of hits.slice(1)) {
		if (h.ts_ms - cur[cur.length - 1]!.ts_ms <= gapMs) cur.push(h);
		else {
			windows.push(cur);
			cur = [h];
		}
	}
	windows.push(cur);

	const segs: SubSegment[] = [];
	for (const w of windows) {
		// buffer 扩窗 + 素材端点钳位
		const durMs = w[0]!.duration_ms;
		let st = Math.max(0, w[0]!.ts_ms - bufferMs);
		let ed = Math.min(durMs, w[w.length - 1]!.ts_ms + bufferMs);
		// 窗分：top3 加权 0.5/0.3/0.2；不足 3 帧取最高分（POC：len<3 时 wscore=scores[0]）
		const scores = w.map((h) => h.score).sort((a, b) => b - a);
		const wscore = scores.length >= 3 ? 0.5 * scores[0]! + 0.3 * scores[1]! + 0.2 * scores[2]! : scores[0]!;
		// best = 窗内最高分帧（分数并列取先到者，与 Python max() 一致）
		let best = w[0]!;
		for (const h of w) if (h.score > best.score) best = h;
		// 场景边界对齐裁剪：向 best 帧所在场景扩（越界 ≤gap 才扩，POC 同款守卫）
		if (best.scene_st_ms >= st - gapMs) st = Math.min(st, best.scene_st_ms);
		if (best.scene_ed_ms <= ed + gapMs) ed = Math.max(ed, best.scene_ed_ms);
		// 窗宽丢弃（CLI 侧增量）：对齐后仍窄于下限（只可能是素材端点钳出的碎窗且场景没救回）才丢
		if (ed - st < minWidthMs) continue;
		segs.push({
			start_ms: st,
			end_ms: ed,
			best_ts_ms: best.ts_ms,
			score: round4(wscore),
			best_frame_score: round4(best.score),
			n_frames: w.length,
		});
	}
	segs.sort((a, b) => b.score - a.score);
	return segs;
}

// ── 索引载入（3.1：全量进内存；载入+单查询 <100ms@千帧级）─────────────────

interface LoadedFrame {
	matIdx: number;
	ts_ms: number;
	scene_st_ms: number;
	scene_ed_ms: number;
}

export interface LoadedMaterial {
	materialId: string;
	path: string;
	durationMs: number;
	width: number | null;
	height: number | null;
	fps: number | null;
}

export interface LoadedIndex {
	dim: number;
	/** n × dim 扁平矩阵。 */
	vectors: Float32Array;
	frames: LoadedFrame[];
	materials: LoadedMaterial[];
}

/** path 是否落在任一 dirs 之下（win32 不区分大小写；resolve 归一）。 */
export function pathInDirs(path: string, dirs: string[]): boolean {
	const norm = (p: string): string => {
		const r = resolve(p);
		return process.platform === "win32" ? r.toLowerCase() : r;
	};
	const p = norm(path);
	return dirs.some((d) => {
		const base = norm(d);
		return p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);
	});
}

interface FrameJoinRow {
	ts_ms: number;
	vec: Uint8Array;
	st_ms: number;
	ed_ms: number;
	mkey: number;
	material_id: string;
	path: string;
	duration_ms: number;
	width: number | null;
	height: number | null;
	fps: number | null;
}

/**
 * 全量载入 dirs 圈定范围内的帧向量与元数据。
 * 文件已消失的素材被过滤（索引行保留——D2 可移动盘口径）；fileExists 可注入（测试）。
 */
export function loadLocalIndex(
	db: SqlDb,
	dirs: string[],
	deps: { fileExists?: (p: string) => boolean } = {},
): LoadedIndex {
	const fileExists = deps.fileExists ?? existsSync;
	const rows = db.all<FrameJoinRow>(
		`SELECT f.ts_ms, f.vec, s.st_ms, s.ed_ms,
		        m.id AS mkey, m.material_id, m.path, m.duration_ms, m.width, m.height, m.fps
		 FROM frames f
		 JOIN scenes s ON f.scene_id = s.id
		 JOIN materials m ON f.material_id = m.id
		 ORDER BY m.id, f.ts_ms`,
	);
	const materials: LoadedMaterial[] = [];
	const matIdxByKey = new Map<number, number>();
	const presentByKey = new Map<number, boolean>();
	const frames: LoadedFrame[] = [];
	const vecs: Float32Array[] = [];
	let dim = 0;
	for (const r of rows) {
		let present = presentByKey.get(r.mkey);
		if (present === undefined) {
			present = pathInDirs(r.path, dirs) && fileExists(r.path);
			presentByKey.set(r.mkey, present);
		}
		if (!present) continue;
		let matIdx = matIdxByKey.get(r.mkey);
		if (matIdx === undefined) {
			matIdx = materials.length;
			matIdxByKey.set(r.mkey, matIdx);
			materials.push({
				materialId: r.material_id,
				path: r.path,
				durationMs: r.duration_ms,
				width: r.width,
				height: r.height,
				fps: r.fps,
			});
		}
		const v = decodeVec(r.vec);
		if (dim === 0) dim = v.length;
		else if (v.length !== dim) throw new Error(`索引向量维度不一致（${v.length} vs ${dim}）——索引损坏，请 gtrk matrix index --rebuild`);
		frames.push({ matIdx, ts_ms: r.ts_ms, scene_st_ms: r.st_ms, scene_ed_ms: r.ed_ms });
		vecs.push(v);
	}
	const flat = new Float32Array(vecs.length * dim);
	vecs.forEach((v, i) => flat.set(v, i * dim));
	return { dim, vectors: flat, frames, materials };
}

// ── 点积检索 + PlanResult 同构组装（3.1/3.3）──────────────────────────────

/**
 * 索引库材料 id（`broll-local-<hash>`，D6 身份形态）→ plan clip_id（`local-<hash>`）。
 * broll-plan-contract（2026-08-12 收口）：clip_id MUST NOT 预置 `broll-` 前缀——材料 id 由
 * 消费方既有拼接 `broll-`+clip_id 复原，同构且杜绝 `broll-broll-` 双前缀。
 */
export function localClipIdForMaterialId(materialId: string): string {
	return materialId.startsWith(BROLL_MATERIAL_PREFIX) ? materialId.slice(BROLL_MATERIAL_PREFIX.length) : materialId;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface LocalSearchOutcome {
	/** 过滤（score 地板）前的真实召回段数（PlanQuery.recalled 口径）。 */
	recalled: number;
	/** 本地形态 PlanResult（score 降序）。 */
	results: PlanResult[];
}

/**
 * 单查询检索：内存点积 → top 帧 → 按素材分组聚合 → score 地板过滤 → PlanResult 同构组装。
 * 零网络（查询向量由调用方 embed 好传入）。
 */
export function searchLoadedIndex(
	index: LoadedIndex,
	queryVec: Float32Array,
	opts: { topkFrames?: number; scoreFloor?: number } = {},
): LocalSearchOutcome {
	const topk = opts.topkFrames ?? TOPK_FRAMES_DEFAULT;
	const floor = opts.scoreFloor ?? LOCAL_SCORE_FLOOR_DEFAULT;
	const n = index.frames.length;
	if (n === 0 || queryVec.length !== index.dim) return { recalled: 0, results: [] };

	// 点积（向量均 normalized，点积即余弦相似度）
	const sims = new Float32Array(n);
	const { vectors, dim } = index;
	for (let i = 0; i < n; i++) {
		let s = 0;
		const off = i * dim;
		for (let j = 0; j < dim; j++) s += vectors[off + j]! * queryVec[j]!;
		sims[i] = s;
	}
	const order = [...sims.keys()].sort((a, b) => sims[b]! - sims[a]!).slice(0, topk);

	// 按素材分组（组内按 ts 升序）→ 聚合
	const byMat = new Map<number, FrameHit[]>();
	for (const idx of order) {
		const f = index.frames[idx]!;
		const mat = index.materials[f.matIdx]!;
		const list = byMat.get(f.matIdx) ?? [];
		list.push({
			ts_ms: f.ts_ms,
			scene_st_ms: f.scene_st_ms,
			scene_ed_ms: f.scene_ed_ms,
			duration_ms: mat.durationMs,
			score: sims[idx]!,
		});
		byMat.set(f.matIdx, list);
	}
	let recalled = 0;
	const results: PlanResult[] = [];
	for (const [matIdx, hits] of byMat) {
		hits.sort((a, b) => a.ts_ms - b.ts_ms);
		const segs = aggregateFrameHits(hits);
		recalled += segs.length;
		const kept = segs.filter((s) => s.score >= floor); // 低于地板不进候选池
		if (!kept.length) continue;
		const mat = index.materials[matIdx]!;
		const r: PlanResult = {
			source: "local",
			// clip_id 无 broll- 前缀（材料 id 由消费方拼 broll-+clip_id 得出，杜绝双前缀）
			clip_id: localClipIdForMaterialId(mat.materialId),
			score: kept[0]!.score,
			local_path: mat.path,
			duration: r3(mat.durationMs / 1000),
			...(mat.width != null ? { width: mat.width } : {}),
			...(mat.height != null ? { height: mat.height } : {}),
			...(mat.fps != null ? { fps: r3(mat.fps) } : {}),
			...(mat.width != null && mat.height != null ? { orientation: mat.width >= mat.height ? "landscape" : "portrait" } : {}),
			segments: kept.map((s) => ({
				start: r3(s.start_ms / 1000),
				end: r3(s.end_ms / 1000),
				best: r3(s.best_ts_ms / 1000),
				score: s.score,
			})),
		};
		results.push(r);
	}
	results.sort((a, b) => b.score - a.score);
	return { recalled, results };
}
