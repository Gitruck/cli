/**
 * 本地媒体预处理（供 oralcut「只传小文件」）：探原片几何、抽 16k 单声道 mp3、压 720p 代理。
 * 抽出物按原片指纹（size:mtime）命名缓存到 ~/.gitruck/audio-cache/，同一毛片重剪免重抽。
 * 全部委托 ffmpeg/ffprobe（绝对路径，见 ffmpeg.ts），不碰用户环境。
 */
import { mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { audioCacheDir } from "./paths";
import { ffprobeJson, requireFfmpeg, runFfmpeg } from "./ffmpeg";

export interface Geometry {
	width: number;
	height: number;
	/** 帧率（r_frame_rate 求值），如 30 / 29.97。 */
	fps: number;
	/** 时长（秒）。 */
	duration: number;
}

function parseFps(rate: unknown): number {
	if (typeof rate !== "string") return 0;
	const [n, d] = rate.split("/").map(Number);
	if (!n || !d) return Number(rate) || 0;
	return n / d;
}

/** 探原片真实几何 {width,height,fps,duration}（客户端本地探得，随请求回传给云端做工程画布与计费校验）。 */
export function probeGeometry(inputAbs: string, ffmpegPath?: string): Geometry {
	const { ffprobe } = requireFfmpeg(ffmpegPath);
	const info = ffprobeJson(ffprobe, [
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height,r_frame_rate",
		"-show_entries", "format=duration",
		"-of", "json",
		inputAbs,
	]) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
	const s = (info.streams && info.streams[0]) || {};
	const duration = Number(info.format?.duration) || 0;
	return {
		width: Number(s.width) || 0,
		height: Number(s.height) || 0,
		fps: parseFps(s.r_frame_rate),
		duration,
	};
}

/** 探任意媒体文件时长（秒），用于抽出物一致性自检。 */
export function probeDuration(path: string, ffmpegPath?: string): number {
	const { ffprobe } = requireFfmpeg(ffmpegPath);
	const info = ffprobeJson(ffprobe, [
		"-v", "error", "-show_entries", "format=duration", "-of", "json", path,
	]) as { format?: Record<string, unknown> };
	return Number(info.format?.duration) || 0;
}

/** 抽出物按原片指纹缓存的目标路径。 */
async function artifactPath(inputAbs: string, ext: string): Promise<string> {
	const s = await stat(inputAbs);
	const base = basename(inputAbs, extname(inputAbs));
	await mkdir(audioCacheDir(), { recursive: true });
	return join(audioCacheDir(), `${base}.${s.size}_${Math.round(s.mtimeMs)}.${ext}`);
}

/** 本地抽 16k 单声道 mp3（云端转写目标格式，ASR.core 直通、体积最小）。命中缓存则复用。 */
export async function extractAudio(inputAbs: string, ffmpegPath?: string): Promise<string> {
	const { ffmpeg } = requireFfmpeg(ffmpegPath);
	const out = await artifactPath(inputAbs, "mp3");
	if (existsSync(out)) return out;
	await runFfmpeg(ffmpeg, [
		"-y", "-v", "error", "-i", inputAbs,
		"-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k",
		out,
	]);
	return out;
}

/** 本地压 720p 代理视频（visual_assist 时上传物；视觉说话检测在 720p 上做足够）。命中缓存则复用。 */
export async function compress720p(inputAbs: string, ffmpegPath?: string): Promise<string> {
	const { ffmpeg } = requireFfmpeg(ffmpegPath);
	const out = await artifactPath(inputAbs, "720p.mp4");
	if (existsSync(out)) return out;
	await runFfmpeg(ffmpeg, [
		"-y", "-v", "error", "-i", inputAbs,
		"-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
		"-c:a", "aac", "-movflags", "+faststart",
		out,
	]);
	return out;
}

/** 抽出物时长与原片一致性自检（容差默认 1s）；不一致抛错（防残缺上传少计费/异常）。 */
export function assertDurationConsistent(
	originalDuration: number,
	artifactAbs: string,
	ffmpegPath?: string,
	tolSec = 1.0,
): void {
	const got = probeDuration(artifactAbs, ffmpegPath);
	if (originalDuration > 0 && Math.abs(got - originalDuration) > tolSec) {
		throw new Error(
			`抽出物时长（${got.toFixed(2)}s）与原片（${originalDuration.toFixed(2)}s）不一致（容差 ${tolSec}s），` +
				`疑似抽取异常，已中止上传`,
		);
	}
}

// ---------------------------------------------------------------- 本地字幕烧录（align-ai-subtitle-audio-only）

/** 从 .ass 的 `Style:` 行取出所声明的字体名集合（第 2 个字段）。 */
export function assFontNames(assText: string): string[] {
	const names = new Set<string>();
	for (const line of assText.split(/\r?\n/)) {
		if (!line.startsWith("Style:")) continue;
		const font = line.slice("Style:".length).split(",")[1]?.trim();
		if (font) names.add(font);
	}
	return [...names];
}

/**
 * 本机是否装了指定字体。走 ffmpeg 的 fontconfig 视角以外的路径不可靠，故直接查系统字体目录的
 * 名称表代价高——这里用 ffmpeg 自带的 `-f lavfi drawtext` 探测：字体不可解析时 ffmpeg 会报错。
 * 返回 true=可用。探测失败（ffmpeg 无 drawtext 等）一律返回 null 表示「测不出来」，由调用方决定。
 */
export async function probeFontAvailable(font: string, ffmpegPath?: string): Promise<boolean | null> {
	const { ffmpeg } = requireFfmpeg(ffmpegPath);
	try {
		await runFfmpeg(ffmpeg, [
			"-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.04",
			"-vf", `drawtext=font='${font}':text=A`, "-frames:v", "1", "-f", "null", "-",
		]);
		return true;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// 字体缺失时 fontconfig 报 "Cannot find a valid font for the family ..."；
		// 其余错误（滤镜不可用等）说明探测本身失效，回 null 而不是误判成缺字体。
		if (/valid font|font.*not found|Fontconfig error/i.test(msg)) return false;
		return null;
	}
}

/**
 * 本地把 .ass 烧进视频（毛片不出本地、烧好的成片也不从云端下行）。
 * 字幕滤镜按 ffmpeg `ass` 滤镜走（自带样式，不做二次覆写）；音轨直拷不重编码。
 */
export async function burnSubtitle(
	videoAbs: string,
	assAbs: string,
	outAbs: string,
	opts: { ffmpegPath?: string; crf?: number; codec?: string } = {},
): Promise<string> {
	const { ffmpeg } = requireFfmpeg(opts.ffmpegPath);
	// ass 滤镜的路径参数要转义 Windows 盘符冒号与反斜杠，否则被当成滤镜参数分隔符
	const filterPath = assAbs.replace(/\\/g, "/").replace(/:/g, "\\:");
	await runFfmpeg(ffmpeg, [
		"-y", "-v", "error", "-i", videoAbs,
		"-vf", `ass='${filterPath}'`,
		"-c:v", opts.codec ?? "libx264", "-crf", String(opts.crf ?? 18), "-preset", "medium",
		"-c:a", "copy", "-movflags", "+faststart",
		outAbs,
	]);
	return outAbs;
}
