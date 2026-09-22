/**
 * 切点音频吸附（纯函数，零 IO）——把轨上的切点推到口播的停顿里（openspec: add-cut-point-audio-snap）。
 *
 * ## 立题：按句界铺出来的切点，与随机撒点没有统计差异
 *
 * 2026-09-20 用一条 537 秒 / 232 镜的成片量了三组切点的**谷深**
 * （切点处能量 ÷ 前后 0.5s 窗内峰值，越小越贴停顿）：
 *
 * | | 谷深中位 | 谷深<0.3 |
 * |---|---|---|
 * | `ai-drama lay` 按句界铺 + 补缝后 | **0.254** | 55% |
 * | 主理人逐镜手调后 | **0.0037** | 87% |
 * | 全片随机撒点对照 | **0.247** | 56% |
 *
 * 第一行与第三行**无差异**。主理人为此手推了 194/232 个切点（84%），中位位移 0.369s。
 *
 * ## 判据：锚在「下一段语音开口之前」，不是「上一段语音结束处」
 *
 * 手调成品实测：切点到**下一段语音开口**的距离中位 **0.030s**，67% 落在 ≥100ms 的真实停顿里。
 * 句间空隙可达数百毫秒——锚在上一段结束处，新画面会先空放到下一句开口；
 * 锚在下一段开口前 30ms，**画面切换与人声开口同时落地**，这才是「卡」的来源。
 *
 * ## MUST NOT 用 ASR 句界当靶
 *
 * 实测被 ASR 判为「句子内部」的切点里 **57% 实际落在 ≥100ms 的真实停顿上**
 * （ASR 把两个气口合成了一句）；反过来 ASR 的句末时码常含尾部气口。
 * ASR 句界只是停顿的**近似索引**，不是靶——靶是音频本身。
 *
 * ## 与 `audio-tighten` 的口径关系
 *
 * 静音阈值沿用同一条结论：**相对全片峰值**（`SILENCE_REL_THRESHOLD`），
 * 绝对 dB 在 TTS 上失效（真机 `silencedetect -25dB` 报 0 段）。
 * 但**检测窗不同**：`audio-tighten` 用 0.1s（够粗到不被单个辅音打断），
 * 本模块要分辨 30ms 量级的落点，故用 20ms 窗 / 10ms 跳步。两处各自正确，MUST NOT 合并。
 */

import { r3 } from "./frame-domain";
import { SILENCE_REL_THRESHOLD } from "./audio-tighten";

/** 包络窗长（秒）。20ms 足以分辨气口，又不会被单个采样尖峰带偏。 */
export const SNAP_WIN_SEC = 0.02;
/** 包络跳步（秒）。10ms = 落点分辨率；再细对判据无增益、只增计算量。 */
export const SNAP_HOP_SEC = 0.01;
/** 默认搜索窗（秒，单侧）。实测手调位移中位 0.369s，0.4 能覆盖绝大多数。 */
export const SNAP_WINDOW_DEFAULT = 0.4;
/** 默认提前量（秒）。实测手调成品到下一段语音开口的距离中位 0.030s。 */
export const SNAP_LEAD_DEFAULT = 0.03;
/** 谷深计算的半径（秒）。 */
export const DIP_RADIUS_SEC = 0.5;

export interface SnapEnvelope {
	/** 逐跳步的 RMS。 */
	rms: Float64Array;
	hopSec: number;
	/** 全片峰值（谷深与静音阈的分母）。 */
	peak: number;
	/** 语音判定阈 = peak × rel。 */
	voiceThr: number;
	durSec: number;
}

/**
 * 由单声道 PCM 建包络。
 *
 * ⚠️ 与 `audio-align.rmsEnvelope` 不同：那个**去均值**（为归一化互相关服务），
 * 本模块要的是绝对能量高低，去均值会把静音段推成负数、谷深失去意义。
 */
export function buildEnvelope(pcm: Int16Array, sampleRate: number, rel = SILENCE_REL_THRESHOLD): SnapEnvelope {
	const win = Math.max(1, Math.round(sampleRate * SNAP_WIN_SEC));
	const hop = Math.max(1, Math.round(sampleRate * SNAP_HOP_SEC));
	const n = pcm.length >= win ? Math.floor((pcm.length - win) / hop) + 1 : 0;
	const rms = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let acc = 0;
		const base = i * hop;
		for (let k = 0; k < win; k++) {
			const v = (pcm[base + k] as number) / 32768;
			acc += v * v;
		}
		rms[i] = Math.sqrt(acc / win);
	}
	let peak = 0;
	for (let i = 0; i < n; i++) if (rms[i] > peak) peak = rms[i] as number;
	return {
		rms,
		hopSec: SNAP_HOP_SEC,
		peak,
		voiceThr: peak * rel,
		durSec: r3(pcm.length / sampleRate),
	};
}

function idxAt(env: SnapEnvelope, t: number): number {
	return Math.round(t / env.hopSec);
}
function energyAt(env: SnapEnvelope, t: number): number {
	const i = idxAt(env, t);
	return i >= 0 && i < env.rms.length ? (env.rms[i] as number) : 0;
}

/**
 * 谷深 = 该时刻能量 ÷ 前后 `radius` 秒窗内峰值。越小越贴停顿。
 * 这是**验收判据**：手调成品中位 0.0037，随机撒点 0.247。
 */
export function dipDepth(env: SnapEnvelope, t: number, radius = DIP_RADIUS_SEC): number {
	const lo = Math.max(0, idxAt(env, t - radius));
	const hi = Math.min(env.rms.length - 1, idxAt(env, t + radius));
	if (hi < lo) return 1;
	let local = 0;
	for (let i = lo; i <= hi; i++) if (env.rms[i] > local) local = env.rms[i] as number;
	if (!(local > 0)) return 0;
	return energyAt(env, t) / local;
}

/**
 * 找 `t` 附近**最近的一次语音开口**（能量由低于阈值跨到高于阈值的上升沿）。
 * 在 `[t - window, t + window]` 内搜；没有返回 null。
 */
export function nearestOnset(env: SnapEnvelope, t: number, window: number): number | null {
	const lo = Math.max(1, idxAt(env, t - window));
	const hi = Math.min(env.rms.length - 1, idxAt(env, t + window));
	let best: number | null = null;
	let bestDist = Infinity;
	for (let i = lo; i <= hi; i++) {
		const prev = env.rms[i - 1] as number;
		const cur = env.rms[i] as number;
		if (prev < env.voiceThr && cur >= env.voiceThr) {
			const at = i * env.hopSec;
			const d = Math.abs(at - t);
			if (d < bestDist) {
				bestDist = d;
				best = at;
			}
		}
	}
	return best;
}

export interface SnapOptions {
	/** 单侧搜索窗（秒）。 */
	window?: number;
	/** 锚点提前量（秒）：落在语音开口之前这么多。 */
	lead?: number;
}

export type SnapSkipReason = "no_onset_in_window" | "target_out_of_range" | "already_aligned";

export interface SnapDecision {
	/** 原切点（秒）。 */
	from: number;
	/** 目标切点（秒）；未吸附时等于 `from`。 */
	to: number;
	moved: boolean;
	/** 未吸附的原因。 */
	skip?: SnapSkipReason;
	/** 吸附前后的谷深（验收读数）。 */
	dipBefore: number;
	dipAfter: number;
}

/**
 * 为一串切点算吸附方案。**只算不写**——写由调用方交给 `gtrk patch` 的既有编辑路径。
 *
 * @param bounds 每个切点的可移动区间 `[lo, hi]`（由相邻元素的边界决定）。
 *   目标越界时 MUST NOT 夹逼到边界——那会把切点放到一个不满足判据的位置；
 *   一律判 `target_out_of_range` 保持原位，由回执列出。
 */
export function planSnap(
	cuts: readonly number[],
	bounds: ReadonlyArray<{ lo: number; hi: number }>,
	env: SnapEnvelope,
	opts: SnapOptions = {},
): SnapDecision[] {
	const window = opts.window ?? SNAP_WINDOW_DEFAULT;
	const lead = opts.lead ?? SNAP_LEAD_DEFAULT;
	return cuts.map((t, i) => {
		const dipBefore = dipDepth(env, t);
		const onset = nearestOnset(env, t, window);
		if (onset === null) {
			return { from: t, to: t, moved: false, skip: "no_onset_in_window", dipBefore, dipAfter: dipBefore };
		}
		const target = r3(onset - lead);
		const b = bounds[i];
		if (b && (target < b.lo || target > b.hi)) {
			return { from: t, to: t, moved: false, skip: "target_out_of_range", dipBefore, dipAfter: dipBefore };
		}
		if (Math.abs(target - t) < env.hopSec / 2) {
			return { from: t, to: t, moved: false, skip: "already_aligned", dipBefore, dipAfter: dipBefore };
		}
		return { from: t, to: target, moved: true, dipBefore, dipAfter: dipDepth(env, target) };
	});
}

/** 中位数（读数汇总用）。 */
export function median(xs: readonly number[]): number {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? (s[m] as number) : (((s[m - 1] as number) + (s[m] as number)) / 2);
}
