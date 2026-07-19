/**
 * MAD beat 卡点量化（add-tool-mad D8）：downbeat 量化 + 固定节奏 + 三级降级判据。
 * 纯函数（喂 mock 分析结果可单测）；不触云端。
 */
import type { DegradeLevel } from "./types";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** 云端 audio_music_analyze 输出的关切字段。 */
export interface BeatAnalysis {
	bpm?: number;
	beats?: number[];
	downbeats?: number[];
}

/** 母时间线上一个窗口的落点与展示时长。 */
export interface WinPlacement {
	dropAt: number;
	outLen: number;
}

/** beat marker（母时间线秒 + 是否 downbeat）。 */
export interface BeatMarker {
	t: number;
	downbeat: boolean;
}

export interface BeatPlan {
	placements: WinPlacement[];
	markers: BeatMarker[];
}

/** 窗口自然时长钳（秒）。 */
export const MIN_WIN = 0.4;
export const MAX_WIN = 6;

/** 档②/③固定节奏：窗口自然时长顺排、钳 [0.4,6]。 */
export function fixedRhythm(natLens: number[]): BeatPlan {
	const placements: WinPlacement[] = [];
	let t = 0;
	for (const nl of natLens) {
		const outLen = clamp(nl, MIN_WIN, MAX_WIN);
		placements.push({ dropAt: r3(t), outLen: r3(outLen) });
		t += outLen;
	}
	return { placements, markers: [] };
}

/**
 * 档①downbeat 量化：切点吸附 downbeat（间隔过长/缺 → 回退 beats）；beats/downbeats 均空 → 回退固定节奏。
 * outLen = 相邻切点距离，钳 [0.4,6]（窗口只裁短——子合成 = 完整 IR，裁窗天然可裁）。
 * 返回 { plan, level }：level 1 = 成功量化；level 2 = 空节拍回退固定节奏（BGM 仍入轨由上层决定）。
 */
export function beatQuantized(natLens: number[], analysis: BeatAnalysis): { plan: BeatPlan; level: DegradeLevel } {
	const dbs = (analysis.downbeats ?? []).filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
	const bts = (analysis.beats ?? []).filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
	// downbeat 间隔过长（> MAX_WIN）→ 回退 beats（更密的切点）
	const dbSpanOk = dbs.length >= 2 && dbs[1] - dbs[0] <= MAX_WIN;
	const snap = dbSpanOk ? dbs : bts;
	const snapSet = new Set(dbs.map((t) => r3(t))); // 用于 marker downbeat 标签
	if (snap.length < 2) {
		// 无节拍音乐 → 回退固定节奏（档②行为）
		return { plan: fixedRhythm(natLens), level: 2 };
	}

	const placements: WinPlacement[] = [];
	let t = 0;
	let si = 0;
	for (let i = 0; i < natLens.length; i++) {
		const dropAt = t;
		// 找 dropAt 之后（留 MIN_WIN 地板）最近的切点
		while (si < snap.length && snap[si] <= dropAt + MIN_WIN) si++;
		if (si >= snap.length) {
			// 切点用尽 → 余下窗口固定节奏顺排
			const outLen = clamp(natLens[i], MIN_WIN, MAX_WIN);
			placements.push({ dropAt: r3(dropAt), outLen: r3(outLen) });
			t = dropAt + outLen;
			continue;
		}
		const nextSnap = snap[si];
		const slotLen = clamp(nextSnap - dropAt, MIN_WIN, MAX_WIN);
		placements.push({ dropAt: r3(dropAt), outLen: r3(slotLen) });
		t = dropAt + slotLen; // 下一窗口从本切点起（切点对齐 downbeat/beat）
		si++;
	}

	// markers：落在 [0, 末窗切点] 内的全部节拍（downbeat 带标签）
	const totalDur = placements.length ? placements[placements.length - 1].dropAt + placements[placements.length - 1].outLen : 0;
	const allBeats = [...new Set([...bts, ...dbs].map((x) => r3(x)))].sort((a, b) => a - b);
	const markers: BeatMarker[] = allBeats
		.filter((tt) => tt >= 0 && tt <= totalDur + 1e-6)
		.map((tt) => ({ t: tt, downbeat: snapSet.has(tt) }));

	return { plan: { placements, markers }, level: 1 };
}
