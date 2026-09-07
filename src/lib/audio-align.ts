/**
 * 音画对轨（add-audio-align-command）：外录音轨 vs 视频内录的偏移检测 + 置信度 + 换轨。
 *
 * 两级检测：
 *   ① 包络域粗对齐——双方抽 4kHz 单声道 PCM → 25ms RMS 包络（40Hz）→ FFT 互相关求 lag，
 *      归一化后取主峰；置信度 = 主峰 / 次峰（次峰在主峰 ±2s 邻域之外取）。
 *   ② PCM 域细化——取视频音轨能量最高的 ~30s 窗，在粗值 ±120ms 内直接互相关，分辨率 0.25ms。
 *
 * 偏移语义（全库统一）：offsetSec = 外录在视频时间轴上的起点。
 *   正值 = 外录晚开录（外录 t=0 对应视频 t=offset）；负值 = 外录早开录（换轨时裁外录头）。
 *
 * 低置信兜底：产「对齐工程」.gtrk（Profile B 双素材）交客户端拖齐；读回时
 *   offset = 音轨 clip track_st − 视频 clip track_st（两 clip 各自 ≥0，相对错开表达正负）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { requireFfmpeg, runFfmpeg } from "./ffmpeg";
import { probeGeometry, probeDuration } from "./media";
import { r3 } from "./frame-domain";

/** 粗对齐 PCM 采样率（Hz）。 */
const PCM_RATE = 4000;
/** 包络窗（样本数）：25ms @4kHz → 包络 40Hz。 */
const ENV_WIN = 100;
/** 包络采样率（Hz）。 */
const ENV_RATE = PCM_RATE / ENV_WIN;
/** 次峰搜索时剔除主峰邻域（秒）。 */
const PEAK_EXCLUDE_SEC = 2;
/** 细化窗时长（秒）与搜索半径（秒）。 */
const REFINE_WIN_SEC = 30;
const REFINE_RADIUS_SEC = 0.12;

/**
 * 置信度阈值缺省值（主峰/次峰显著性比）。
 * ⚠️ 真机标定值——2026-08-27 雅歌样本三组对照（正确配对 vs 裁头错位 vs 无关配对）标定，
 * 数据与方法见 change `add-audio-align-command` tasks §3.1 实录；改值须重标。
 */
export const DEFAULT_ALIGN_THRESHOLD = 2.0;

export interface AlignDetection {
	/** 外录在视频时间轴上的起点（秒；正=外录晚开录）。 */
	offsetSec: number;
	/** 主峰 / 次峰显著性比（≥1；越大越可信）。 */
	confidence: number;
	/** 粗对齐峰的归一化相关值（-1..1，诊断用）。 */
	peakCorr: number;
}

/** 抽 4kHz 单声道 s16le 裸 PCM 到临时文件，返回 Int16Array。 */
async function extractPcm(inputAbs: string, outPath: string, ffmpegPath?: string): Promise<Int16Array> {
	const { ffmpeg } = requireFfmpeg(ffmpegPath);
	await runFfmpeg(ffmpeg, [
		"-y", "-v", "error", "-i", inputAbs,
		"-vn", "-ac", "1", "-ar", String(PCM_RATE), "-f", "s16le", "-c:a", "pcm_s16le",
		outPath,
	]);
	const buf = readFileSync(outPath);
	return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

/** 25ms RMS 包络（去均值，供归一化互相关）。 */
export function rmsEnvelope(pcm: Int16Array): Float64Array {
	const n = Math.floor(pcm.length / ENV_WIN);
	const env = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let acc = 0;
		const base = i * ENV_WIN;
		for (let j = 0; j < ENV_WIN; j++) {
			const v = pcm[base + j] / 32768;
			acc += v * v;
		}
		env[i] = Math.sqrt(acc / ENV_WIN);
	}
	// 去均值
	let mean = 0;
	for (let i = 0; i < n; i++) mean += env[i];
	mean /= Math.max(1, n);
	for (let i = 0; i < n; i++) env[i] -= mean;
	return env;
}

/** 迭代 radix-2 FFT（就地，re/im 双数组）。 */
function fft(re: Float64Array, im: Float64Array, invert: boolean): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = ((invert ? 1 : -1) * 2 * Math.PI) / len;
		const wRe = Math.cos(ang);
		const wIm = Math.sin(ang);
		for (let i = 0; i < n; i += len) {
			let curRe = 1;
			let curIm = 0;
			for (let j = 0; j < len / 2; j++) {
				const uRe = re[i + j];
				const uIm = im[i + j];
				const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
				const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
				re[i + j] = uRe + vRe;
				im[i + j] = uIm + vIm;
				re[i + j + len / 2] = uRe - vRe;
				im[i + j + len / 2] = uIm - vIm;
				const nextRe = curRe * wRe - curIm * wIm;
				curIm = curRe * wIm + curIm * wRe;
				curRe = nextRe;
			}
		}
	}
	if (invert) {
		for (let i = 0; i < n; i++) {
			re[i] /= n;
			im[i] /= n;
		}
	}
}

/**
 * FFT 互相关：返回 corr[lag]，lag ∈ [-(nb-1), na-1]，corr 数组下标 = lag + (nb-1)。
 * a = 参考（视频内录包络）、b = 待对齐（外录包络）；lag>0 表示 b 相对 a 右移（b 晚开始）。
 */
export function crossCorrelate(a: Float64Array, b: Float64Array): { corr: Float64Array; lagOfIndex: (i: number) => number } {
	const total = a.length + b.length - 1;
	let size = 1;
	while (size < total) size <<= 1;
	const aRe = new Float64Array(size);
	const aIm = new Float64Array(size);
	const bRe = new Float64Array(size);
	const bIm = new Float64Array(size);
	aRe.set(a);
	bRe.set(b);
	fft(aRe, aIm, false);
	fft(bRe, bIm, false);
	// A · conj(B)
	for (let i = 0; i < size; i++) {
		const re = aRe[i] * bRe[i] + aIm[i] * bIm[i];
		const im = aIm[i] * bRe[i] - aRe[i] * bIm[i];
		aRe[i] = re;
		aIm[i] = im;
	}
	fft(aRe, aIm, true);
	// 循环相关 → 线性 lag：lag ≥ 0 在 [0, na-1]，lag < 0 在 [size-nb+1, size-1]（映射 lag = i - size）
	const corr = new Float64Array(total);
	const nb = b.length;
	for (let lag = -(nb - 1); lag < a.length; lag++) {
		const idx = lag >= 0 ? lag : size + lag;
		corr[lag + nb - 1] = aRe[idx];
	}
	return { corr, lagOfIndex: (i: number) => i - (nb - 1) };
}

/** 主峰 + 邻域外次峰 → 偏移（包络 bin）与置信度。 */
export function pickPeak(corr: Float64Array, lagOfIndex: (i: number) => number, excludeBins: number): {
	lag: number;
	confidence: number;
	peakNorm: number;
} {
	let best = 0;
	for (let i = 1; i < corr.length; i++) if (corr[i] > corr[best]) best = i;
	let second = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < corr.length; i++) {
		if (Math.abs(i - best) <= excludeBins) continue;
		if (corr[i] > second) second = corr[i];
	}
	const peak = corr[best];
	// 全负/退化保护：以 |次峰| 为分母；次峰非正时置信度按峰值绝对占比给大数
	const confidence = second > 0 ? peak / second : peak > 0 ? 99 : 1;
	return { lag: lagOfIndex(best), confidence, peakNorm: peak };
}

/** PCM 域细化：在 coarse ±radius 内直接互相关（取视频能量最高 30s 窗）。返回细化后的 lag（PCM 样本）。 */
export function refineLag(videoPcm: Int16Array, extPcm: Int16Array, coarseLagPcm: number): number {
	const winLen = Math.min(REFINE_WIN_SEC * PCM_RATE, videoPcm.length);
	// 找视频能量最高窗（步进 1s）
	let bestStart = 0;
	let bestEnergy = -1;
	const step = PCM_RATE;
	for (let s = 0; s + winLen <= videoPcm.length; s += step) {
		let e = 0;
		for (let i = s; i < s + winLen; i += 16) e += Math.abs(videoPcm[i]);
		if (e > bestEnergy) {
			bestEnergy = e;
			bestStart = s;
		}
	}
	const radius = Math.round(REFINE_RADIUS_SEC * PCM_RATE);
	let bestLag = coarseLagPcm;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (let lag = coarseLagPcm - radius; lag <= coarseLagPcm + radius; lag += 1) {
		let acc = 0;
		let count = 0;
		for (let i = bestStart; i < bestStart + winLen; i += 4) {
			const j = i - lag;
			if (j < 0 || j >= extPcm.length) continue;
			acc += (videoPcm[i] / 32768) * (extPcm[j] / 32768);
			count++;
		}
		if (count === 0) continue;
		const score = acc / count;
		if (score > bestScore) {
			bestScore = score;
			bestLag = lag;
		}
	}
	return bestLag;
}

/** 检测外录相对视频的偏移与置信度（两级：包络粗对齐 + PCM 细化）。 */
export async function detectOffset(
	videoAbs: string,
	extAudioAbs: string,
	workDir: string,
	ffmpegPath?: string,
): Promise<AlignDetection> {
	const vPcm = await extractPcm(videoAbs, join(workDir, "align-video.pcm"), ffmpegPath);
	const ePcm = await extractPcm(extAudioAbs, join(workDir, "align-ext.pcm"), ffmpegPath);
	if (vPcm.length < ENV_WIN * 10 || ePcm.length < ENV_WIN * 10) {
		throw new Error("音频太短（不足 0.25s），无法对轨");
	}
	const vEnv = rmsEnvelope(vPcm);
	const eEnv = rmsEnvelope(ePcm);
	const { corr, lagOfIndex } = crossCorrelate(vEnv, eEnv);
	// 归一化（皮尔逊分母）
	let na = 0;
	let nb = 0;
	for (let i = 0; i < vEnv.length; i++) na += vEnv[i] * vEnv[i];
	for (let i = 0; i < eEnv.length; i++) nb += eEnv[i] * eEnv[i];
	const denom = Math.sqrt(na * nb) || 1;
	for (let i = 0; i < corr.length; i++) corr[i] /= denom;
	const picked = pickPeak(corr, lagOfIndex, Math.round(PEAK_EXCLUDE_SEC * ENV_RATE));
	const coarseLagPcm = picked.lag * ENV_WIN;
	const fineLagPcm = refineLag(vPcm, ePcm, coarseLagPcm);
	return {
		offsetSec: fineLagPcm / PCM_RATE,
		confidence: Math.round(picked.confidence * 100) / 100,
		peakCorr: Math.round(picked.peakNorm * 1000) / 1000,
	};
}

/** 换轨：视频流 -c:v copy 零像素改动，音轨换外录（按 offset 摆放），-shortest 以视频为准。 */
export async function muxExternalAudio(
	videoAbs: string,
	extAudioAbs: string,
	offsetSec: number,
	outAbs: string,
	ffmpegPath?: string,
): Promise<void> {
	const { ffmpeg } = requireFfmpeg(ffmpegPath);
	// 音频流须与视频流**严格等长且 start_time=0**——两条真机实撞的教训：
	// ① 外录常比视频短（尾部没录到），不补齐 → 音频流短于视频，下游 oralcut 抽音频护栏按
	//    时长不一致拒收（木洲样本差 1.45s）；且 `-af apad`+`-shortest` 组合有 muxer 截断竞态铺不满。
	// ② 正偏移若用 `-itsoffset` 表达，偏移会被编码成音频流的 start_time——下游抽音频（-vn）
	//    丢 start_time ⇒ 时长差重现（木洲二撞）。
	// 终局口径：正偏移用 adelay 在流内补前置静音（start_time 恒 0），尾部 apad=whole_dur=视频长。
	const vDur = probeDuration(videoAbs, ffmpegPath);
	const filters: string[] = [];
	const args = ["-y", "-v", "error", "-i", videoAbs];
	if (offsetSec >= 0.0005) {
		args.push("-i", extAudioAbs);
		filters.push(`adelay=${Math.round(offsetSec * 1000)}:all=1`);
	} else if (offsetSec <= -0.0005) {
		args.push("-ss", (-offsetSec).toFixed(4), "-i", extAudioAbs);
	} else {
		args.push("-i", extAudioAbs);
	}
	filters.push(`apad=whole_dur=${vDur.toFixed(4)}`);
	args.push(
		"-map", "0:v:0", "-map", "1:a:0",
		"-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
		"-af", filters.join(","),
		"-movflags", "+faststart",
		outAbs,
	);
	await runFfmpeg(ffmpeg, args);
}

const fwd = (p: string): string => resolve(p).replace(/\\/g, "/");

/** 低置信兜底：产对齐工程（Profile B 双素材；两 clip 相对错开表达正负偏移，各自 ≥0）。 */
export function buildAlignProject(
	videoAbs: string,
	extAudioAbs: string,
	offsetEstimate: number,
	geo: { width: number; height: number; fps: number; duration: number },
	extDuration: number,
): Record<string, unknown> {
	const vStart = r3(Math.max(0, -offsetEstimate));
	const aStart = r3(Math.max(0, offsetEstimate));
	return {
		version: "v1",
		video_size: [geo.width, geo.height],
		video_rate: Math.max(1, Math.round(geo.fps)),
		duration: r3(Math.max(vStart + geo.duration, aStart + extDuration)),
		materials: [
			{ id: "align-video", path: fwd(videoAbs), duration: r3(geo.duration), video_size: [geo.width, geo.height], video_rate: Math.max(1, Math.round(geo.fps)) },
			{ id: "align-ext-audio", path: fwd(extAudioAbs), duration: r3(extDuration), audio_channel: "stereo" },
		],
		video_track: [
			{
				track_index: 0,
				track_size: [geo.width, geo.height],
				track_timeline: [
					{ clip_id: "align-v0", material: "align-video", clip_st: 0, clip_ed: r3(geo.duration), track_st: vStart, track_ed: r3(vStart + geo.duration), duration: r3(geo.duration) },
				],
			},
		],
		audio_track: [
			{
				track_index: 0,
				track_timeline: [
					{ clip_id: "align-a0", material: "align-ext-audio", clip_st: 0, clip_ed: r3(extDuration), track_st: aStart, track_ed: r3(aStart + extDuration), duration: r3(extDuration) },
				],
			},
		],
	};
}

export interface AlignResumeInfo {
	videoAbs: string;
	extAudioAbs: string;
	/** 用户确认后的偏移（音轨 track_st − 视频轨 track_st）。 */
	offsetSec: number;
}

/** 读回对齐工程：素材路径 + 人工确认偏移。 */
export function readAlignOffset(gtrkPath: string): AlignResumeInfo {
	const j = JSON.parse(readFileSync(gtrkPath, "utf8")) as Record<string, unknown>;
	const materials = (j.materials ?? []) as Array<Record<string, unknown>>;
	const byId = new Map(materials.map((m) => [String(m.id), m]));
	const vTracks = (j.video_track ?? []) as Array<Record<string, unknown>>;
	const aTracks = (j.audio_track ?? []) as Array<Record<string, unknown>>;
	const firstClip = (tracks: Array<Record<string, unknown>>): Record<string, unknown> | undefined => {
		for (const tr of tracks) {
			for (const c of (tr.track_timeline ?? []) as Array<Record<string, unknown>>) {
				if (c.material) return c;
			}
		}
		return undefined;
	};
	const vc = firstClip(vTracks);
	const ac = firstClip(aTracks);
	if (!vc || !ac) throw new Error("对齐工程不完整：找不到视频/音频 clip");
	const vMat = byId.get(String(vc.material));
	const aMat = byId.get(String(ac.material));
	const vPath = String(vMat?.path ?? "");
	const aPath = String(aMat?.path ?? "");
	if (!vPath || !aPath) throw new Error("对齐工程素材缺 path，无法定位原文件");
	const abs = (p: string): string => (isAbsolute(p) ? p : resolve(dirname(gtrkPath), p));
	return {
		videoAbs: abs(vPath),
		extAudioAbs: abs(aPath),
		offsetSec: r3(Number(ac.track_st ?? 0) - Number(vc.track_st ?? 0)),
	};
}

/** 换轨产物路径：`<视频名>_extaudio.<原扩展名>`（mov 沿用 mov，其余归 mp4）。 */
export function alignOutputPath(videoAbs: string, outDir?: string): string {
	const ext = extname(videoAbs).toLowerCase() === ".mov" ? ".mov" : ".mp4";
	const stem = basename(videoAbs, extname(videoAbs));
	return join(outDir ?? dirname(videoAbs), `${stem}_extaudio${ext}`);
}

/** 对齐工程路径：`<视频名>_align.gtrk`。 */
export function alignProjectPath(videoAbs: string, outDir?: string): string {
	const stem = basename(videoAbs, extname(videoAbs));
	return join(outDir ?? dirname(videoAbs), `${stem}_align.gtrk`);
}

export function writeAlignProject(path: string, project: Record<string, unknown>): void {
	writeFileSync(path, JSON.stringify(project, null, 1), "utf8");
}
