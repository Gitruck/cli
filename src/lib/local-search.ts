/**
 * 本地索引检索（add-matrix-local-search · local-material-search spec）。
 *
 * 链路：查询文本经自建端点 embed（调用方负责）→ 索引全量载入内存 Float32Array →
 * 进程内点积（MUST NOT 经任何网络检索服务）→ 帧命中聚合为素材内 sub-segment →
 * 组装与云端 PlanResult **同构**的本地形态结果（source:"local"，url 系字段 MUST NOT 出现）。
 *
 * 聚合（D5 + fix-broll-flash-frames D2 整景并集）：media_matrix aggregate_frame_hits_to_subsegments
 * 的 TS 移植，段边界口径经 fix-broll-flash-frames 收口为**整景并集**：
 * gap≤3000ms 归窗 → 段 = [首命中帧所在场景 st, 末命中帧所在场景 ed]（归窗跨过的中间场景整景收录）
 * → 窗分 top3 加权 0.5/0.3/0.2（不足 3 帧取最高分）→ best=窗内最高分帧 → 窗宽 <1500ms 丢弃。
 * ±750ms buffer 裸边与「只对齐 best 帧所在场景」的旧口径废止——段边界骑在场景切点两侧是旅拍
 * 打样闪帧实锤根因之一；stable 整景特例被本口径自然吸收（语义零变化）。
 * **POC 黄金样本对拍在段边界处有意破口**（fix-broll-flash-frames design D2 决策记录）：
 * fixtures/local-search/golden-aggregate.json 已由新实现重跑固化为新基线。
 * 段内切点明细（cuts）：素材切点全集（local-index cuts 表）中严格落在段开区间内的切点随段透出，
 * 供铺轨端点吸附消残片；旧库无数据（cuts_indexed NULL）时省略字段。
 */
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { PlanResult } from "./matrix";
import { BROLL_MATERIAL_PREFIX } from "./matrix-lay";
import { decodeVec, type SqlDb } from "./local-index";

// ── 聚合参数（POC 标定基线）───────────────────────────────────────────────
export const AGG_GAP_MS = 3000;
/** 窗宽下限（毫秒）：整景并集后仍窄于此（命中场景本身过短）即丢弃——短于铺轨最小槽长的碎景铺不了。 */
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
	/** 所在场景为 stable（add-index-stability-sampling；中点单帧代表整场景）。
	 * 缺省/false = unstable，聚合行为与本 change 之前逐字节一致。 */
	stable?: boolean;
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
 * 帧命中 → sub-segments（POC aggregate() 归窗/窗分/best 语义 + fix-broll-flash-frames D2 整景并集）。
 * 入参 hits 须为**同一素材**内、按 ts_ms 升序。
 */
export function aggregateFrameHits(
	hits: FrameHit[],
	opts: { gapMs?: number; minWidthMs?: number } = {},
): SubSegment[] {
	if (!hits.length) return [];
	const gapMs = opts.gapMs ?? AGG_GAP_MS;
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
		// 整景并集（fix-broll-flash-frames D2）：st=首命中帧所在场景起点、ed=末命中帧所在场景终点
		// （hits 升序 ⇒ 首/末命中即时间最早/最晚；归窗跨过的中间场景整景收录）。段边界恒落场景
		// 边界/素材端点上——±buffer 裸边与「只对齐 best 场景」旧口径废止（骑缝段=闪帧根因之一）；
		// stable 整景特例被本口径自然吸收（单帧命中的首=末=best，仍是整场景段）。
		const st = w[0]!.scene_st_ms;
		const ed = w[w.length - 1]!.scene_ed_ms;
		// 窗分：top3 加权 0.5/0.3/0.2；不足 3 帧取最高分（POC：len<3 时 wscore=scores[0]）
		const scores = w.map((h) => h.score).sort((a, b) => b - a);
		const wscore = scores.length >= 3 ? 0.5 * scores[0]! + 0.3 * scores[1]! + 0.2 * scores[2]! : scores[0]!;
		// best = 窗内最高分帧（分数并列取先到者，与 Python max() 一致）
		let best = w[0]!;
		for (const h of w) if (h.score > best.score) best = h;
		// 窗宽丢弃：整景并集后仍窄于下限（命中场景本身过短）才丢
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
	/** 所在场景 stable=1（旧库 NULL/0 恒 false —— unstable 语义）。 */
	stable: boolean;
}

export interface LoadedMaterial {
	materialId: string;
	path: string;
	/** video|image（add-matrix-local-image-broll；迁移后旧行恒 video）。 */
	kind: string;
	durationMs: number;
	width: number | null;
	height: number | null;
	fps: number | null;
	/** 切点全集（毫秒，升序；fix-broll-flash-frames D4/D5）：仅 cuts_indexed=1 的素材携带
	 * （`[]`=真无切点）；undefined=旧库无数据（检索段不透出 cuts）。 */
	cutsMs?: number[];
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
	/** scenes.stable（1=stable；NULL/0=unstable）。 */
	scene_stable: number | null;
	mkey: number;
	material_id: string;
	path: string;
	kind: string | null;
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
	// 逐帧 JOIN 只取帧级/场景级/素材几何列——**素材级标志位（如 cuts_indexed）MUST NOT 挂在这条
	// 查询上**：它按帧重复 N 次，千帧级实测多一列即多约 11% 载入耗时（3.1 验收线 <100ms 很紧）。
	// 素材级数据一律走下方的小查询按 material 取一次。
	const rows = db.all<FrameJoinRow>(
		`SELECT f.ts_ms, f.vec, s.st_ms, s.ed_ms, s.stable AS scene_stable,
		        m.id AS mkey, m.material_id, m.path, m.kind, m.duration_ms, m.width, m.height, m.fps
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
				kind: r.kind === "image" ? "image" : "video",
				durationMs: r.duration_ms,
				width: r.width,
				height: r.height,
				fps: r.fps,
			});
		}
		const v = decodeVec(r.vec);
		if (dim === 0) dim = v.length;
		else if (v.length !== dim) throw new Error(`索引向量维度不一致（${v.length} vs ${dim}）——索引损坏，请 gtrk matrix index --rebuild`);
		frames.push({ matIdx, ts_ms: r.ts_ms, scene_st_ms: r.st_ms, scene_ed_ms: r.ed_ms, stable: r.scene_stable === 1 });
		vecs.push(v);
	}
	// 切点全集（fix-broll-flash-frames D5）：素材级两小步——先按 material 取标志位（在场素材才问），
	// 置位者初始化空数组（`[]`=真无切点，undefined=旧库无数据，两者语义不同）；再按 (material_id, t_ms)
	// 主键序回填。两条查询都是 O(素材数/切点数)，与帧数无关。
	if (matIdxByKey.size > 0) {
		let anyIndexed = false;
		for (const m of db.all<{ id: number; cuts_indexed: number | null }>(
			"SELECT id, cuts_indexed FROM materials WHERE cuts_indexed = 1",
		)) {
			const matIdx = matIdxByKey.get(m.id);
			if (matIdx === undefined) continue; // 不在检索域/文件已消失
			materials[matIdx]!.cutsMs = [];
			anyIndexed = true;
		}
		if (anyIndexed) {
			for (const c of db.all<{ material_id: number; t_ms: number }>(
				"SELECT material_id, t_ms FROM cuts ORDER BY material_id, t_ms",
			)) {
				const matIdx = matIdxByKey.get(c.material_id);
				if (matIdx !== undefined) materials[matIdx]!.cutsMs?.push(c.t_ms);
			}
		}
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

/** 排序 tie-break 键（★ 主理人 2026-08-12 拍板）：纯 score 混排、严格同分视频优先（kind video<image）。 */
const kindRank = (r: Pick<PlanResult, "kind">): number => (r.kind === "image" ? 1 : 0);

/**
 * 单查询检索：内存点积 → top 帧 → 按素材分组聚合 → score 地板过滤 → PlanResult 同构组装。
 * 零网络（查询向量由调用方 embed 好传入）。
 * 图片素材（add-matrix-local-image-broll D7）：kind:"image"、segments 恒零区间形态；
 * `includeImages:false`（--no-image-broll）时图片帧完全不参与点积排位（不出候选池、不占 topk）。
 *
 * 源时间窗（add-matrix-describe-and-window · search-source-window spec）：`sourceWindowSec`
 * 显式传入时——过滤发生在**聚合后段级**：段与窗口有交集（闭区间相触即交）即保留，段边界原样
 * 不裁剪（裁剪归铺轨槽长逻辑）；与 scoreFloor/includeImages 等过滤器 AND 叠加；图片素材（无时间轴）
 * 整体排除（不占 topk 不出候选池）；窗口无命中返回 ok 空结果（recalled=窗内召回口径），
 * 扩窗重试是配方层（agent）逻辑，MUST NOT 由本函数自动扩窗。
 */
export function searchLoadedIndex(
	index: LoadedIndex,
	queryVec: Float32Array,
	opts: {
		topkFrames?: number;
		scoreFloor?: number;
		includeImages?: boolean;
		/** 源时间窗（秒，[start,end]）：仅返回与窗口有交集的 segments。 */
		sourceWindowSec?: readonly [number, number];
	} = {},
): LocalSearchOutcome {
	const topk = opts.topkFrames ?? TOPK_FRAMES_DEFAULT;
	const floor = opts.scoreFloor ?? LOCAL_SCORE_FLOOR_DEFAULT;
	const win = opts.sourceWindowSec;
	// 显式传窗口 = 图片素材整体排除（无时间轴，谈不上「落在窗内」）——与 includeImages AND 叠加
	const includeImages = opts.includeImages !== false && !win;
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
	const eligible: number[] = [];
	for (let i = 0; i < n; i++) {
		if (!includeImages && index.materials[index.frames[i]!.matIdx]!.kind === "image") continue;
		eligible.push(i);
	}
	const order = eligible.sort((a, b) => sims[b]! - sims[a]!).slice(0, topk);

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
			...(f.stable ? { stable: true } : {}),
		});
		byMat.set(f.matIdx, list);
	}
	let recalled = 0;
	const results: PlanResult[] = [];
	for (const [matIdx, hits] of byMat) {
		const matMeta = index.materials[matIdx]!;
		// 图片素材：单帧向量、无场景轴——不走聚合，segments 恒零区间形态（消费方不特判不炸）
		if (matMeta.kind === "image") {
			recalled += 1;
			const score = round4(hits.reduce((mx, h) => Math.max(mx, h.score), Number.NEGATIVE_INFINITY));
			if (score < floor) continue;
			results.push({
				source: "local",
				kind: "image",
				clip_id: localClipIdForMaterialId(matMeta.materialId),
				score,
				local_path: matMeta.path,
				...(matMeta.width != null ? { width: matMeta.width } : {}),
				...(matMeta.height != null ? { height: matMeta.height } : {}),
				...(matMeta.width != null && matMeta.height != null
					? { orientation: matMeta.width >= matMeta.height ? "landscape" : "portrait" }
					: {}),
				segments: [{ start: 0, end: 0, best: 0, score }],
			});
			continue;
		}
		hits.sort((a, b) => a.ts_ms - b.ts_ms);
		let segs = aggregateFrameHits(hits);
		// 源时间窗过滤（段级交集，闭区间相触即交；段边界原样不裁剪）——先于 recalled 计数：
		// 窗口是检索域限定（同 includeImages 语义），recalled 报的是**窗内**真实召回
		if (win) {
			const [stMs, edMs] = [win[0] * 1000, win[1] * 1000];
			segs = segs.filter((s) => s.end_ms >= stMs && s.start_ms <= edMs);
		}
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
			segments: kept.map((s) => {
				// 段内切点明细（fix-broll-flash-frames D5）：切点全集中严格落在段开区间内者随段透出
				// （铺轨端点吸附消残片用）；cuts_indexed 未置位（旧库）或段内无切点时省略字段。
				const cutsInSeg = mat.cutsMs?.filter((t) => t > s.start_ms && t < s.end_ms) ?? [];
				return {
					start: r3(s.start_ms / 1000),
					end: r3(s.end_ms / 1000),
					best: r3(s.best_ts_ms / 1000),
					score: s.score,
					...(cutsInSeg.length ? { cuts: cutsInSeg.map((t) => r3(t / 1000)) } : {}),
				};
			}),
		};
		results.push(r);
	}
	// 纯 score 混排 + 严格同分视频优先（稳定 tie-break，不做整体降权系数）
	results.sort((a, b) => b.score - a.score || kindRank(a) - kindRank(b));
	return { recalled, results };
}
