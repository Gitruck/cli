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
 * 段内黑段明细（black，fix-index-gradual-transition-blindness）：与 cuts **并列**的正交信号——
 * 素材黑段全集（black_spans 表）中与段区间有**交叠**者随段透出，供铺轨把窗口收缩到黑段一侧；
 * 旧库无数据（black_indexed NULL）时整键省略。两者都遵同一条三态语义：
 * 缺席=没扫过（不可判）/ `[]`=扫过且没有 / 有值=就是这些。
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

/** 段级运动量摘要（add-material-motion-signal）：去重后帧间分分位 + 样本数 + 有效帧率。
 * 段跨多场景时按各场景时长加权；任一分位不可判（样本不足）的场景不参与加权。 */
export interface SegmentMotion {
	p50: number;
	p90: number;
	samples: number;
	effective_fps?: number;
}

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
	/** 带运动信号的场景跨度（add-material-motion-signal）：按 st_ms 升序，只含 motion 可判的场景。
	 * undefined/空 = 该素材无运动信号（旧库未重建），段不透出 motion。 */
	motionScenes?: { st_ms: number; ed_ms: number; p50: number; p90: number; samples: number; effectiveFps: number | null }[];
	/** 源片黑段全集（毫秒，升序；fix-index-gradual-transition-blindness）：仅 black_indexed=1 的素材携带
	 * （`[]`=扫过且真无黑段）；undefined=旧库没扫过（检索段整键不透出 `black`）。
	 * ⚠️ 与 cutsMs 同构的**三态**，MUST NOT 拿长度判「扫没扫过」。 */
	blackMs?: [number, number][];
}

export interface LoadedIndex {
	dim: number;
	/** n × dim 扁平矩阵。 */
	vectors: Float32Array;
	frames: LoadedFrame[];
	materials: LoadedMaterial[];
}

/**
 * path 是否落在任一 dirs 之下，**或恰为该路径本身**（win32 不区分大小写；resolve 归一）。
 *
 * ★ `p === base` 那一支是**单文件收窄**（add-local-search-material-scope）：
 * `--dirs` 传一个素材文件时，检索域就是那一个素材。这条分支本来就在（写它是为了
 * 「传目录时目录自身也算命中」），单文件恰好落进来是个巧合——本 change 把巧合**升为立意**，
 * 表达式一字不改，改的是索引侧的枚举（那边此前枚举不到单文件，于是这条路走不通）。
 */
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
		// 黑段全集（fix-index-gradual-transition-blindness）：与 cuts 同款两小步，三态语义同构——
		// 先按 black_indexed=1 给在场素材开空数组（`[]`=扫过且无黑），再按 (material_id, st_ms) 序回填。
		// ⚠️ 两步 MUST 分开：合成一条 `SELECT … FROM black_spans` 就再也分不出
		//    「这素材没扫过」与「这素材扫过但一个黑段都没有」——那正是 fix-cut-scan-warning-semantics 的坑。
		let anyBlackIndexed = false;
		for (const m of db.all<{ id: number }>("SELECT id FROM materials WHERE black_indexed = 1")) {
			const matIdx = matIdxByKey.get(m.id);
			if (matIdx === undefined) continue; // 不在检索域/文件已消失
			materials[matIdx]!.blackMs = [];
			anyBlackIndexed = true;
		}
		if (anyBlackIndexed) {
			for (const b of db.all<{ material_id: number; st_ms: number; ed_ms: number }>(
				"SELECT material_id, st_ms, ed_ms FROM black_spans ORDER BY material_id, st_ms",
			)) {
				const matIdx = matIdxByKey.get(b.material_id);
				if (matIdx !== undefined) materials[matIdx]!.blackMs?.push([b.st_ms, b.ed_ms]);
			}
		}
		// 运动信号（add-material-motion-signal）：**场景级**数据同样走素材级小查询——
		// 挂到逐帧 JOIN 上会按帧重复 N 次（实测多一列即多约 11% 载入耗时）。只取可判的场景。
		for (const s of db.all<{
			material_id: number;
			st_ms: number;
			ed_ms: number;
			motion_p50: number;
			motion_p90: number;
			motion_samples: number;
			effective_fps: number | null;
		}>(
			`SELECT material_id, st_ms, ed_ms, motion_p50, motion_p90, motion_samples, effective_fps
			 FROM scenes WHERE motion_p50 IS NOT NULL ORDER BY material_id, st_ms`,
		)) {
			const matIdx = matIdxByKey.get(s.material_id);
			if (matIdx === undefined) continue;
			const m = materials[matIdx]!;
			(m.motionScenes ??= []).push({
				st_ms: s.st_ms,
				ed_ms: s.ed_ms,
				p50: s.motion_p50,
				p90: s.motion_p90,
				samples: s.motion_samples,
				effectiveFps: s.effective_fps,
			});
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
const r4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * 段级运动量摘要（add-material-motion-signal · local-material-search spec）：
 * 取与段 [stMs, edMs] 有交集的**可判**场景，按交集时长加权平均 p50/p90；样本数取和。
 * 有效帧率取加权占比最大的那个场景的值（同一段内混合帧率时以主体为准）。
 * 无可判场景（旧库未重建 / 全是样本不足的静止场景）返回 undefined —— 段不透出 motion，
 * 语义是「不可判」而非「平稳」。
 */
export function segmentMotion(
	scenes: NonNullable<LoadedMaterial["motionScenes"]>,
	stMs: number,
	edMs: number,
): SegmentMotion | undefined {
	let wSum = 0;
	let p50 = 0;
	let p90 = 0;
	let samples = 0;
	let bestW = 0;
	let fps: number | null = null;
	for (const s of scenes) {
		const w = Math.min(edMs, s.ed_ms) - Math.max(stMs, s.st_ms);
		if (w <= 0) continue;
		wSum += w;
		p50 += s.p50 * w;
		p90 += s.p90 * w;
		samples += s.samples;
		if (w > bestW) {
			bestW = w;
			fps = s.effectiveFps;
		}
	}
	if (wSum <= 0) return undefined;
	return {
		p50: r4(p50 / wSum),
		p90: r4(p90 / wSum),
		samples,
		...(fps !== null ? { effective_fps: fps } : {}),
	};
}

/**
 * 段级形态（本地）。
 *
 * ⚠️ `black` 键（fix-index-gradual-transition-blindness）目前只在这里表达：契约正本
 * `matrix.ts` 的 `PlanResult["segments"]` 与 `validatePlanForLay` 的形态校验**不在本 change
 * 的文件射程内**（并行施工分工），须由接手方同批补齐——见本 change 的 handoff。
 * 写出的 JSON 形态即最终形态，接手方只需把类型与校验补上，无需改本文件。
 *
 * ⚠️ 给接手方的一条硬约束：`black` 的校验 **MUST NOT 照抄 `cuts` 的「严格落在 (start,end) 开区间内」**
 * ——黑段中点已被注入成场景边界，而段边界恒落在场景边界上 ⇒ **黑段横跨段界是常态而非例外**
 * （真机 424.083–424.367 的中点 424.225 就是段界，两侧段各含它一半）。照抄即把正常产物判成坏形态。
 */
type LocalPlanSegment = NonNullable<PlanResult["segments"]>[number] & { black?: [number, number][] };

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
			segments: kept.map((s): LocalPlanSegment => {
				// 段内切点明细（fix-broll-flash-frames D5）：切点全集中严格落在段开区间内者随段透出
				// （铺轨端点吸附消残片用）。
				// ★ 字段在不在场 ⇔ **该素材扫没扫过切点**（fix-cut-scan-warning-semantics）：
				//   · 缺席 = `cuts_indexed` 未置位（旧库/没建过索引）⇒ 真的不可判；
				//   · `[]`  = 扫过了，只是这一段里恰好没有切点 ⇒ 可判，且判出来是「没有」。
				//   上一版拿 `cutsInSeg.length` 当判据，把后者也写成缺席，于是下游把
				//   「这段没切点」误报成「这素材没扫过切点」，并开出「重跑索引」这条昂贵且无效的处方。
				const cutsInSeg = mat.cutsMs?.filter((t) => t > s.start_ms && t < s.end_ms) ?? [];
				// 段内黑段明细（fix-index-gradual-transition-blindness）：与 `cuts` **并列**的正交信号。
				// ★ 三态语义与 cuts 逐条同构（缺席=没扫过 / `[]`=扫过且无黑 / 有值=这些）——
				//   判据恒是 `mat.blackMs !== undefined`，**MUST NOT 拿 length 当判据**（那个坑踩过一次）。
				// ★ 判交叠而非「严格落在段内」：黑段中点已被注入成场景边界，而段边界恒落在场景边界上
				//   ⇒ 黑段**横跨段界是常态**（真机那条 424.083–424.367 就骑在段界 424.225 上）。
				//   用开区间判据会让骑缝的黑段整条消失，而它恰恰是最该被消费方看见的那一类。
				// ★ 值给**未裁剪的源坐标**（可能越出 [start,end] 一点）：消费方要吸附的是黑场的真边界，
				//   给裁到段界的坐标等于把端点吸到黑段中点上——落一个正好包着半截黑的窗口。
				const blackInSeg = mat.blackMs?.filter(([bs, be]) => bs < s.end_ms && be > s.start_ms) ?? [];
				// 段级运动量（add-material-motion-signal）：无信号时省略字段（「不可判」≠「平稳」）
				const motion = mat.motionScenes?.length ? segmentMotion(mat.motionScenes, s.start_ms, s.end_ms) : undefined;
				return {
					start: r3(s.start_ms / 1000),
					end: r3(s.end_ms / 1000),
					best: r3(s.best_ts_ms / 1000),
					score: s.score,
					...(mat.cutsMs !== undefined ? { cuts: cutsInSeg.map((t) => r3(t / 1000)) } : {}),
					...(mat.blackMs !== undefined
						? { black: blackInSeg.map(([bs, be]) => [r3(bs / 1000), r3(be / 1000)] as [number, number]) }
						: {}),
					...(motion ? { motion } : {}),
				};
			}),
		};
		results.push(r);
	}
	// 纯 score 混排 + 严格同分视频优先（稳定 tie-break，不做整体降权系数）
	results.sort((a, b) => b.score - a.score || kindRank(a) - kindRank(b));
	return { recalled, results };
}
