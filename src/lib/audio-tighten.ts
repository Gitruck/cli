/**
 * 配音轨句间停顿收紧（add-audio-tighten-pauses）——**决策纯函数**。
 *
 * 立题：`fragment_interval` 只覆盖自训音色；云引擎音色（真机三条片用的就是）在合成侧
 * **没有任何办法**调短停顿。实测 `voice-B.wav` 202.96s 里 53.9s 是句间静音（26.6%），
 * 收到 0.2s 后全片少 28.8 秒。
 *
 * 本文件只做「该压哪些、压完时码怎么映射」，不碰文件 IO —— 那部分在 `commands/audio.ts`。
 *
 * ## 五条判据（每条都是真机踩出来的，改之前先读）
 *
 * ① **只压跨句界的静音**。句与句在 transcript 里**首尾相接**，停顿包在每句自己的时段内——
 *    「波形里所有静音」≠「句间停顿」。真机误压 14/14/15 处句内换气（「店在上野阿美横町 ／
 *    JR 高架桥底下 ／ 叫珍珍轩」这种换气被削 0.1s），主理人一耳朵听出句子发赶。
 * ② **静音判据用相对 RMS**（见 `detectSilenceRuns`）。`ffmpeg silencedetect` 在 -25dB
 *    都报 **0 段**——TTS 的底噪高于那个阈值。
 * ③ **引用段整体豁免**。它在轨上的时长 MUST 恒等于源片时长，从中间削一截就是画音错位；
 *    真机曾在一处同期声中间挖掉 0.884s，听感不易察觉、铺轨时是错位近一秒。
 * ④ **产物是原件多 clip 铺轨，MUST NOT 烤成新音频文件**。烤死了用户就调不动、也退不回。
 * ⑤ **`transcript` 一个字都不改**。`projectTranscript` 的映射是
 *    `track = clip.track_st + (句时码 − clip.clip_st)`：轴留在**源文件**时间上，
 *    clip 本身就是那张源→轨映射表。再把轴也映射一遍 = 映射两次，beat 窗口整体错位，
 *    引用段全部判「越出 beat 窗口」落不进去（真机 9/9 全废，画面留 4–5s 洞）。
 */

/** 相对峰值的静音阈（0.02 = 峰值的 2%）。绝对 dB 阈在 TTS 上失效，见文件头注 ②。 */
export const SILENCE_REL_THRESHOLD = 0.02;
/** RMS 检测窗（秒）。0.1s 是「够细到分得开句界、又粗到不被单个辅音打断」的实测折中。 */
export const SILENCE_WIN_SEC = 0.1;
/** 收紧后保留的静音（秒）。0.2 是主理人 2026-09-02 听片认可值。
 *  ⚠️ 它是**这个音色 + 这类解说**的结论，换题材/换音色未必合适——所以可配。 */
export const TIGHTEN_KEEP_DEFAULT = 0.2;
/** 短于此的静音不动：那是字间/词间的自然停顿，压了会连读。 */
export const TIGHTEN_MIN_SILENCE_DEFAULT = 0.3;
/** 「贴着句界」的容差（秒）：静音段端点与句界距离在此内即算跨句界。 */
export const TIGHTEN_BOUNDARY_TOL_DEFAULT = 0.15;

export interface Interval {
	st: number;
	ed: number;
}

/** 一刀 = 被删掉的源区间 `[src_from, src_to)`。 */
export interface TightenCut {
	src_from: number;
	src_to: number;
}

export interface TightenPlan {
	cuts: TightenCut[];
	/** 因「句内换气」被跳过的静音段数——这是本件与朴素实现的**唯一**区别，必须可观测。 */
	skippedInterior: number;
	/** 因落在豁免区间（引用段）被跳过的静音段数。 */
	skippedProtected: number;
	/** 因短于 minSilence 被跳过的。 */
	skippedShort: number;
	/** 合计削掉的秒数。 */
	removedSec: number;
}

import { r3 } from "./frame-domain";

/**
 * 由逐窗 RMS 序列找出静音段。
 *
 * ⚠️ 阈值是**相对全片峰值**的，不是绝对 dB：TTS 的底噪高于常用的 -25dB，
 * 用绝对阈会一段都找不出来（真机 `silencedetect -25dB` 报 0 段）。
 */
export function detectSilenceRuns(rms: readonly number[], winSec: number, rel: number): Interval[] {
	if (!rms.length) return [];
	const peak = Math.max(...rms);
	if (!(peak > 0)) return [];
	const thr = peak * rel;
	const runs: Interval[] = [];
	let i = 0;
	while (i < rms.length) {
		if ((rms[i] as number) < thr) {
			let j = i;
			while (j < rms.length && (rms[j] as number) < thr) j++;
			runs.push({ st: r3(i * winSec), ed: r3(j * winSec) });
			i = j;
		} else i++;
	}
	return runs;
}

/**
 * 定夺该压哪些静音段。
 *
 * `boundaries` = 句界时刻（前一句 `ed` / 后一句 `st`；两者相等，给一份即可）。
 * 片头引导静音也算——把 `0` 放进 `boundaries` 即可。
 */
export function planTightenCuts(
	runs: readonly Interval[],
	boundaries: readonly number[],
	protect: readonly Interval[],
	opts: { keep: number; minSilence: number; boundaryTol: number },
): TightenPlan {
	const { keep, minSilence, boundaryTol } = opts;
	const cuts: TightenCut[] = [];
	let skippedInterior = 0;
	let skippedProtected = 0;
	let skippedShort = 0;
	let removedSec = 0;
	for (const run of runs) {
		if (run.ed - run.st < minSilence) {
			skippedShort++;
			continue;
		}
		// ③ 引用段整体豁免：轨长 MUST 恒等于源长
		if (protect.some((p) => p.ed > run.st + 1e-9 && p.st < run.ed - 1e-9)) {
			skippedProtected++;
			continue;
		}
		// ① 只压跨句界的；句内换气原样保留
		if (!boundaries.some((b) => run.st - boundaryTol <= b && b <= run.ed + boundaryTol)) {
			skippedInterior++;
			continue;
		}
		const from = r3(run.st + keep);
		if (from >= run.ed - 1e-9) continue; // 本就不长于 keep，无可削
		cuts.push({ src_from: from, src_to: run.ed });
		removedSec += run.ed - from;
	}
	return { cuts, skippedInterior, skippedProtected, skippedShort, removedSec: r3(removedSec) };
}

/**
 * 由刀口表建「源时刻 → 轨时刻」映射。
 *
 * 落在被删区间内的时刻**钉到刀口起点**——那一瞬间在成片里已不存在，
 * 钳到边界是唯一自洽的答案（返回区间中点或原值都会造出逆序）。
 */
export function makeTightenMapper(cuts: readonly TightenCut[]): (t: number) => number {
	let acc = 0;
	const pref = cuts.map((c) => {
		const before = acc;
		acc += c.src_to - c.src_from;
		return { lo: c.src_from, hi: c.src_to, before };
	});
	return (t: number): number => {
		let removed = 0;
		for (const p of pref) {
			if (t >= p.hi) removed = p.before + (p.hi - p.lo);
			else if (t > p.lo) return r3(p.lo - p.before);
			else break;
		}
		return r3(t - removed);
	};
}

/**
 * 由刀口表算「保留下来的源区间」——配音轨就按这些区间逐段成 clip（判据 ④）。
 *
 * ⚠️ 引用段**不从这里剔除**：它必须留在配音轨上。真机曾把它挪到独立轨/独立素材，
 * 结果 `projectTranscript` 只认配音素材的 clip，那几句「零存活」，
 * 重投影判定「整段已被剪出成片」而**跳过整个 beat**，画面留下 4–5 秒的洞（A/B/C 各 3 处）。
 */
export function keepIntervals(totalDur: number, cuts: readonly TightenCut[]): Interval[] {
	const out: Interval[] = [];
	let cur = 0;
	for (const c of cuts) {
		if (c.src_from - cur > 0.005) out.push({ st: r3(cur), ed: r3(c.src_from) });
		cur = c.src_to;
	}
	if (totalDur - cur > 0.005) out.push({ st: r3(cur), ed: r3(totalDur) });
	return out;
}

/**
 * 把保留区间按给定边界再切一刀（不改总覆盖，只改分段）。
 *
 * 用途：让**引用段单独成一个 clip**，用户在客户端里能单独选中它调出入点。
 * ⚠️ 它仍留在配音轨上、仍是同一素材 —— 只是切开。MUST NOT 借此把它挪走：
 * `projectTranscript` 只认配音素材的 clip，挪走那几句就「零存活」、整个 beat 被跳过。
 */
export function splitIntervalsAt(intervals: readonly Interval[], marks: readonly number[]): Interval[] {
	const pts = [...new Set(marks.filter((x) => Number.isFinite(x)))].sort((a, b) => a - b);
	const out: Interval[] = [];
	for (const iv of intervals) {
		let cur = iv.st;
		for (const p of pts) {
			if (p > cur + 0.005 && p < iv.ed - 0.005) {
				out.push({ st: r3(cur), ed: r3(p) });
				cur = p;
			}
		}
		out.push({ st: r3(cur), ed: r3(iv.ed) });
	}
	return out;
}

/** 客户端字幕的时间单位（`client_visual_elements.time_unit === "tick"`）：120000 tick/秒。 */
export const CVE_TICKS_PER_SEC = 120000;
