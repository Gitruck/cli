/**
 * 本地媒体预处理（供 oralcut「只传小文件」）：探原片几何、抽 16k 单声道 mp3、压 720p 代理。
 * 抽出物按原片指纹（size:mtime）命名缓存到 ~/.gitruck/audio-cache/，同一毛片重剪免重抽。
 * 全部委托 ffmpeg/ffprobe（绝对路径，见 ffmpeg.ts），不碰用户环境。
 */
import { mkdir, stat } from "node:fs/promises";
import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { audioCacheDir, fontsDir } from "./paths";
import { ffprobeJson, requireFfmpeg, runFfmpeg } from "./ffmpeg";
import { hasLocalFonts } from "./runtime-assets";

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
/**
 * 探音频声道布局（`stereo` / `mono` / …），拿不到返回 undefined。
 *
 * 用途：写音频 material 的 `audio_channel` 字段——客户端 `materialMediaKind` 的音频判据是
 * 「无 video_size ∧ 有 audio_channel」的合取，漏写该字段会让音频素材在素材库里显示成视频
 * （2026-08-22 真机实锤：BGM mp3 显示为「视频 4:59」）。后端 `video_project_struct` 写出的
 * 音频 material 一直带此字段，CLI 自产音轨与它对齐。
 */
export function probeAudioChannel(path: string, ffmpegPath?: string): string | undefined {
	// 探不到就返回 undefined（调用方不写该键）：它只服务素材库的图标/类型呈现，
	// **MUST NOT 因为探测失败而阻断音频上轨**——时长探测已经在上游把「这是不是有效音频」判过了。
	let info: { streams?: Array<Record<string, unknown>> };
	try {
		const { ffprobe } = requireFfmpeg(ffmpegPath);
		info = ffprobeJson(ffprobe, [
			"-v", "error", "-select_streams", "a:0",
			"-show_entries", "stream=channel_layout,channels", "-of", "json", path,
		]) as { streams?: Array<Record<string, unknown>> };
	} catch {
		return undefined;
	}
	const st = info.streams?.[0];
	if (!st) return undefined;
	const layout = typeof st.channel_layout === "string" ? st.channel_layout.trim() : "";
	if (layout) return layout;
	const n = Number(st.channels);
	if (n === 1) return "mono";
	if (n === 2) return "stereo";
	return n > 0 ? String(n) : undefined;
}
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

/** ass 滤镜的路径参数要转义 Windows 盘符冒号与反斜杠，否则被当成滤镜参数分隔符。 */
function assFilterPath(p: string): string {
	return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

// ---- 本地字体家族名解析（零依赖读 sfnt `name` 表）----
// libass 按**家族名**匹配（.ass 的 Style 行写的是家族名，不是文件名），故不能按文件名判断有无。
// 只读 nameID 1（家族）/ 4（全名）/ 16（排版家族），覆盖各平台各语言记录——
// 思源黑体的简中家族名「思源黑体 CN Bold」正是记在 platformID=3 / langID=0x804 上。

/** 解 sfnt `name` 表（入参就是该表本身，偏移相对表首）。 */
function nameTableNames(buf: Buffer): string[] {
	const out: string[] = [];
	if (buf.length < 6) return out;
	const count = buf.readUInt16BE(2);
	const strBase = buf.readUInt16BE(4);
	for (let i = 0; i < count; i++) {
		const r = 6 + i * 12;
		if (r + 12 > buf.length) break;
		const platformID = buf.readUInt16BE(r);
		const nameID = buf.readUInt16BE(r + 6);
		if (nameID !== 1 && nameID !== 4 && nameID !== 16) continue;
		const len = buf.readUInt16BE(r + 8);
		const off = strBase + buf.readUInt16BE(r + 10);
		if (off + len > buf.length) continue;
		const slice = buf.subarray(off, off + len);
		let s: string;
		if (platformID === 1) {
			s = slice.toString("latin1"); // Mac 平台记录多为单字节
		} else {
			// platformID 3（Windows）/ 0（Unicode）是 UTF-16**BE**，Node 只有 utf16le，
			// 故先复制再字节交换（swap16 会原地改，且要求长度为偶数）
			const even = slice.length % 2 === 0 ? slice : slice.subarray(0, slice.length - 1);
			s = Buffer.from(even).swap16().toString("utf16le");
		}
		const v = s.replace(/\0/g, "").trim();
		if (v) out.push(v);
	}
	return out;
}

/**
 * 读单个字体文件里声明的家族名（含 .ttc 集合内各子字体）。解析失败回空数组，不抛。
 *
 * **只部分读取**：字体动辄 8 MB，而要扫的系统字体目录有几百个文件——整读会读进数 GB。
 * 故只读「头部 + 表目录」定位 name 表，再单读 name 表那一段。
 */
export function fontFileFamilies(path: string): string[] {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const head = Buffer.alloc(12);
		if (readSync(fd, head, 0, 12, 0) < 12) return [];

		const bases: number[] = [];
		if (head.toString("latin1", 0, 4) === "ttcf") {
			const n = head.readUInt32BE(8);
			const dir = Buffer.alloc(Math.min(n, 64) * 4);
			readSync(fd, dir, 0, dir.length, 12);
			for (let i = 0; i < dir.length / 4; i++) bases.push(dir.readUInt32BE(i * 4));
		} else {
			bases.push(0);
		}

		const out: string[] = [];
		for (const base of bases) {
			const h = base === 0 ? head : Buffer.alloc(12);
			if (base !== 0 && readSync(fd, h, 0, 12, base) < 12) continue;
			const numTables = h.readUInt16BE(4);
			if (!numTables || numTables > 512) continue;
			const dir = Buffer.alloc(numTables * 16);
			if (readSync(fd, dir, 0, dir.length, base + 12) < dir.length) continue;
			let nameOff = 0;
			let nameLen = 0;
			for (let i = 0; i < numTables; i++) {
				if (dir.toString("latin1", i * 16, i * 16 + 4) === "name") {
					nameOff = dir.readUInt32BE(i * 16 + 8);
					nameLen = dir.readUInt32BE(i * 16 + 12);
					break;
				}
			}
			if (!nameOff || !nameLen || nameLen > 1 << 20) continue;
			const nameBuf = Buffer.alloc(nameLen);
			if (readSync(fd, nameBuf, 0, nameLen, nameOff) < nameLen) continue;
			out.push(...nameTableNames(nameBuf));
		}
		return out;
	} catch {
		return [];
	} finally {
		if (fd !== null) try { closeSync(fd); } catch { /* 忽略 */ }
	}
}

const FONT_EXT = /\.(otf|ttf|ttc|otc)$/i;

/** 扫一个目录（可递归，深度有限）收集字体家族名。目录不存在/无权限静默跳过。 */
function scanFontDir(dir: string, out: Set<string>, depth = 0): void {
	if (depth > 3) return;
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(dir, { withFileTypes: true }) as never;
	} catch {
		return;
	}
	for (const e of entries as unknown as Array<{ name: string; isDirectory(): boolean }>) {
		const p = join(dir, e.name);
		if (e.isDirectory()) scanFontDir(p, out, depth + 1);
		else if (FONT_EXT.test(e.name)) for (const n of fontFileFamilies(p)) out.add(n);
	}
}

let _famCache: string[] | null = null;
/** ~/.gitruck/fonts 下所有字体声明的家族名（进程内缓存）。 */
export function localFontFamilies(): string[] {
	if (_famCache) return _famCache;
	const out = new Set<string>();
	scanFontDir(fontsDir(), out);
	_famCache = [...out];
	return _famCache;
}

/** 各平台系统字体目录。 */
function systemFontDirs(): string[] {
	const home = homedir();
	if (process.platform === "win32") {
		return [
			join(process.env.SystemRoot || "C:\\Windows", "Fonts"),
			join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Microsoft", "Windows", "Fonts"),
		];
	}
	if (process.platform === "darwin") {
		return ["/System/Library/Fonts", "/Library/Fonts", join(home, "Library", "Fonts")];
	}
	return ["/usr/share/fonts", "/usr/local/share/fonts", join(home, ".local/share/fonts"), join(home, ".fonts")];
}

let _sysCache: string[] | null = null;
/**
 * 系统已装字体的家族名（进程内缓存）。
 *
 * **为什么不用 ffmpeg 探测**：`drawtext` 走 fontconfig，字体缺失时它**静默替换**并照常退 0
 * ——实测本机上「绝不存在的字体名」与真实字体同样退 0，探不出缺失。故改为正面枚举系统字体目录、
 * 按 name 表比家族名，这才让「两处均缺 ⇒ 报错」这条判据真的可判。
 */
export function systemFontFamilies(): string[] {
	if (_sysCache) return _sysCache;
	const out = new Set<string>();
	for (const d of systemFontDirs()) scanFontDir(d, out);
	_sysCache = [...out];
	return _sysCache;
}

/**
 * 本地把 .ass 烧进视频（毛片不出本地、烧好的成片也不从云端下行）。
 * 字幕滤镜按 ffmpeg `ass` 滤镜走（自带样式，不做二次覆写）；音轨直拷不重编码。
 *
 * 字体供给：~/.gitruck/fonts 有字体时给 `ass` 滤镜传 `fontsdir`，libass 会与系统字体源合并
 * ——**不安装进系统字体表、不写注册表、不要管理员权限**（change: add-runtime-asset-mirror）。
 * 用户系统已装的字体照常可用，两处任一命中即可渲染。
 */
export async function burnSubtitle(
	videoAbs: string,
	assAbs: string,
	outAbs: string,
	opts: { ffmpegPath?: string; crf?: number; codec?: string } = {},
): Promise<string> {
	const { ffmpeg } = requireFfmpeg(opts.ffmpegPath);
	let filter = `ass='${assFilterPath(assAbs)}'`;
	if (hasLocalFonts()) filter += `:fontsdir='${assFilterPath(fontsDir())}'`;
	await runFfmpeg(ffmpeg, [
		"-y", "-v", "error", "-i", videoAbs,
		"-vf", filter,
		"-c:v", opts.codec ?? "libx264", "-crf", String(opts.crf ?? 18), "-preset", "medium",
		"-c:a", "copy", "-movflags", "+faststart",
		outAbs,
	]);
	return outAbs;
}

/**
 * 字体是否可用于烧录：`~/.gitruck/fonts`（经 fontsdir）与系统字体目录**任一命中即可**。
 *
 * 判据是**按 name 表比家族名**（libass 就是这么匹配的），不是文件名、也不是 fontconfig 探测
 * ——后者在 Windows 上探不出缺失（见 systemFontFamilies 注释）。
 * 兜底：两处枚举都空（异常环境，如无权限读字体目录）时不武断判缺，退回 ffmpeg 探测。
 */
export async function fontUsableForBurn(font: string, ffmpegPath?: string): Promise<boolean> {
	const local = localFontFamilies();
	const sys = systemFontFamilies();
	if (local.includes(font) || sys.includes(font)) return true;
	if (local.length === 0 && sys.length === 0) {
		return (await probeFontAvailable(font, ffmpegPath)) !== false;
	}
	return false;
}
