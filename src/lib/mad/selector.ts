/**
 * MAD 规则选择器（add-tool-mad D4）：六维纯规则、确定性可复现（--seed）。
 *   ① 窗口数预算（--duration ÷ 目标平均窗长 → 8~10 窗）
 *   ② 类目轮转（10 类循环抽取保多样性）
 *   ③ 源档位优先（format 四值归并两档：NV 并 AM 档优先、剪映并 AE 档降权）
 *   ④ 横竖屏匹配（同向优先，竖屏池不足用横屏 cover 兜底）
 *   ⑤ 同 pattern 一片内去重
 *   ⑥ n_seen 加权 × unmapped_fx_ratio 降权
 * 素材游标轮转分配 + srcOffset 在素材时长内错开。抽样带种子 PRNG。
 */
import type { Orientation, PoolEntry, UserVideo } from "./types";

/** mulberry32：小巧确定性 PRNG（同种子同序列）。 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 源档位：format → 档权重（NV/AM 优先档 1.0；剪映/AE 降权档 0.55）。 */
function tierWeight(format: PoolEntry["format"]): number {
	// NV 并入 AM 档（关键帧曲线完整）；剪映并入 AE 档（具名动画降解、回放发直）降权
	if (format === "am" || format === "nv") return 1.0;
	return 0.55; // ae / 剪映
}

/** 条目朝向。 */
function entryOrientation(e: PoolEntry): Orientation {
	return e.h > e.w ? "portrait" : "landscape";
}

/** 加权分：n_seen 加权（开方压缩长尾）× 源档位 × 朝向 × (1−未映射 fx 占比) × slot 有效性。 */
function baseWeight(e: PoolEntry, orientation: Orientation): number {
	const nSeen = Math.sqrt(Math.max(1, e.n_seen));
	const tier = tierWeight(e.format);
	const orient = entryOrientation(e) === orientation ? 1.0 : 0.5; // 异向可 cover 兜底但降权
	const fxPenalty = Math.max(0.1, 1 - Math.min(1, Math.max(0, e.unmapped_fx_ratio)));
	return nSeen * tier * orient * fxPenalty;
}

/** 带权随机抽一个（返回索引）；空数组返回 -1。 */
function weightedPick(weights: number[], rnd: () => number): number {
	const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
	if (total <= 0) return weights.length ? Math.floor(rnd() * weights.length) : -1;
	let r = rnd() * total;
	for (let i = 0; i < weights.length; i++) {
		r -= Math.max(0, weights[i]);
		if (r <= 0) return i;
	}
	return weights.length - 1;
}

export interface ChosenWindow {
	entry: PoolEntry;
	/** 分配的用户素材。 */
	video: UserVideo;
	/** 该窗口 srcOffset 基准（素材时长内错开）。 */
	srcOffsetBase: number;
}

export interface SelectOpts {
	pool: PoolEntry[];
	videos: UserVideo[];
	/** --duration（秒）。 */
	durationSec: number;
	/** 母合成朝向（素材多数决）。 */
	orientation: Orientation;
	/** 复现种子。 */
	seed: number;
	/** 目标平均窗长（秒，窗口数预算用；缺省 2.2）。 */
	targetAvgSec?: number;
}

/** 窗口数预算：--duration ÷ 目标平均窗长，钳 [6,12]（文案口径落 8~10）。 */
export function budgetWindowCount(durationSec: number, targetAvgSec = 2.2): number {
	const n = Math.round(durationSec / Math.max(0.5, targetAvgSec));
	return Math.min(12, Math.max(6, n));
}

/**
 * 选窗口序列（确定性）。类目轮转 + 同 pattern 去重 + 加权抽样 + 素材游标轮转。
 * 池不足时放宽去重（保证凑够预算），异向条目 cover 兜底。
 */
export function selectWindows(opts: SelectOpts): ChosenWindow[] {
	const { pool, videos, durationSec, orientation, seed } = opts;
	const rnd = mulberry32(seed || 1);
	const want = budgetWindowCount(durationSec, opts.targetAvgSec);
	if (pool.length === 0 || videos.length === 0) return [];

	// 类目分组（保序）
	const cats = [...new Set(pool.map((e) => e.cat))];
	const byCat = new Map<string, PoolEntry[]>();
	for (const c of cats) byCat.set(c, pool.filter((e) => e.cat === c));

	const chosen: ChosenWindow[] = [];
	const usedPatterns = new Set<string>();
	const usedUids = new Set<string>();
	let catCursor = 0;
	let videoCursor = 0;
	// srcOffset 游标：每素材累进错开
	const srcCursor = new Map<string, number>();

	const tryPickFrom = (candidates: PoolEntry[], relaxDedup: boolean): PoolEntry | null => {
		const pool2 = candidates.filter((e) => !usedUids.has(e.uid) && (relaxDedup || !usedPatterns.has(e.pid)));
		if (pool2.length === 0) return null;
		const weights = pool2.map((e) => baseWeight(e, orientation));
		const idx = weightedPick(weights, rnd);
		return idx >= 0 ? pool2[idx] : null;
	};

	let guard = 0;
	while (chosen.length < want && guard < want * (cats.length + 4) + 50) {
		guard++;
		let entry: PoolEntry | null = null;
		// ② 类目轮转：从当前游标起找一个有候选的类目
		for (let k = 0; k < cats.length && !entry; k++) {
			const cat = cats[(catCursor + k) % cats.length];
			entry = tryPickFrom(byCat.get(cat) ?? [], false);
			if (entry) catCursor = (catCursor + k + 1) % cats.length;
		}
		// 全类目去重后无候选 → 放宽 pattern 去重再来一轮（仍避免同 uid）
		if (!entry) entry = tryPickFrom(pool, true);
		if (!entry) break;

		usedUids.add(entry.uid);
		usedPatterns.add(entry.pid);

		// 素材游标轮转分配 + srcOffset 错开
		const video = videos[videoCursor % videos.length];
		videoCursor++;
		const winLen = Math.max(0.4, entry.t1 - entry.t0);
		const prev = srcCursor.get(video.path) ?? 0;
		// 在素材时长内错开取段（留窗长余量，回绕）
		const room = Math.max(0.1, video.duration - winLen);
		const srcOffsetBase = room > 0 ? prev % room : 0;
		srcCursor.set(video.path, prev + winLen);

		chosen.push({ entry, video, srcOffsetBase });
	}
	return chosen;
}
