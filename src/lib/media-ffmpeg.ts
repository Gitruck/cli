/**
 * 看片命令族的 ffmpeg 层（add-reference-video-reading · media-command spec）：
 * probe、按时刻精确取帧、区间逐帧连续解码、拼带标签的页、截证据片段、变化点采样流。
 *
 * 全部走 `ffmpeg.ts` 定位的绝对路径，不碰用户环境；中间物（解码帧、每页 ASS）由调用方放系统 temp、用完即删。
 *
 * ## 取帧为什么「提前 2 秒跳入 + trim + showinfo」
 *
 * 输入端 `-ss` 只能跳到关键帧附近；在它前面 2 秒跳入、再用 `trim=start=<t>` 解码到 `t` 处或之后的第一帧，
 * 既快又准（hypit 实测与全解码逐字节相同）。**标签写 showinfo 回读的 `pts_time`，MUST NOT 写请求值**：
 * VFR 片、请求时刻不落在帧边界时两者不同，写请求值等于在证据上造假。
 * `-copyts -start_at_zero` 让回读的时间就是源片时钟（与转写稿同一条时钟）。
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { FFMPEG_INSTALL_HINT, ffprobeJson, runFfmpeg } from "./ffmpeg";
import { assFilterPath, localFontFamilies, systemFontFamilies } from "./media";
import { fontsDir } from "./paths";
import { hasLocalFonts } from "./runtime-assets";
import { BOUNDARY_SIDE, BoundaryScorer, type BoundaryCandidate } from "./media-grid";
import { r3 } from "./frame-domain";

// ───────────────────────────── probe ─────────────────────────────

export interface MediaProbe {
	path: string;
	duration: number;
	hasVideo: boolean;
	hasAudio: boolean;
	/** 显示尺寸（已计入像素宽高比与旋转）。无视频流时为 0。 */
	width: number;
	height: number;
	/** 编码尺寸。 */
	codedWidth: number;
	codedHeight: number;
	/** r_frame_rate；静帧 / 探不到为 0。 */
	fps: number;
	avgFps?: number;
	/** `|avg − r| / r > 1%` 判 VFR；探不到为 null。 */
	vfr: boolean | null;
	rotation: number;
	codec?: string;
}

function ratio(v: unknown): number {
	if (typeof v !== "string") return 0;
	const [n, d] = v.split(/[/:]/).map(Number);
	if (!Number.isFinite(n)) return 0;
	if (d === undefined) return n;
	return d ? n / d : 0;
}

/** ffprobe JSON → MediaProbe（纯函数，单测用假输出）。 */
export function probeFromJson(path: string, info: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> }): MediaProbe {
	const streams = info.streams ?? [];
	const video = streams.find(
		(s) => s.codec_type === "video" && (s.disposition as { attached_pic?: number } | undefined)?.attached_pic !== 1,
	);
	const hasAudio = streams.some((s) => s.codec_type === "audio");
	const duration = Number(info.format?.duration);
	if (!(Number.isFinite(duration) && duration > 0)) throw new Error(`${path}：探不到时长`);
	if (!video && !hasAudio) throw new Error(`${path}：没有音视频流`);
	if (!video) {
		return { path, duration: r3(duration), hasVideo: false, hasAudio, width: 0, height: 0, codedWidth: 0, codedHeight: 0, fps: 0, vfr: null, rotation: 0 };
	}
	const codedWidth = Number(video.width) || 0;
	const codedHeight = Number(video.height) || 0;
	let rotation = 0;
	for (const sd of (video.side_data_list as Array<Record<string, unknown>> | undefined) ?? []) {
		if (typeof sd.rotation === "number") rotation = sd.rotation;
	}
	const tagRotate = Number((video.tags as Record<string, unknown> | undefined)?.rotate);
	if (!rotation && Number.isFinite(tagRotate)) rotation = tagRotate;
	const sar = ratio(video.sample_aspect_ratio) || 1;
	let width = Math.round(codedWidth * sar);
	let height = codedHeight;
	if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
	const fps = ratio(video.r_frame_rate);
	const avg = ratio(video.avg_frame_rate);
	const avgFps = avg > 0 ? r3(avg) : undefined;
	const vfr = avgFps !== undefined && fps > 0 ? Math.abs(avg - fps) / fps > 0.01 : null;
	return {
		path,
		duration: r3(duration),
		hasVideo: true,
		hasAudio,
		width,
		height,
		codedWidth,
		codedHeight,
		fps: r3(fps),
		avgFps,
		vfr,
		rotation,
		codec: typeof video.codec_name === "string" ? video.codec_name : undefined,
	};
}

export function probeMedia(ffprobe: string, path: string): MediaProbe {
	const info = ffprobeJson(ffprobe, [
		"-v", "error",
		"-show_entries",
		"format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,sample_aspect_ratio:stream_disposition=attached_pic:stream_side_data=rotation:stream_tags=rotate",
		"-of", "json", path,
	]) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
	return probeFromJson(path, info);
}

// ───────────────────────────── 能力与字体 ─────────────────────────────

const filterCache = new Map<string, Set<string>>();

/** 本机 ffmpeg 的滤镜清单（进程内缓存）。 */
export function ffmpegFilters(ffmpeg: string): Set<string> {
	const hit = filterCache.get(ffmpeg);
	if (hit) return hit;
	const r = spawnSync(ffmpeg, ["-hide_banner", "-filters"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	const set = new Set<string>();
	for (const ln of (r.stdout || "").split(/\r?\n/)) {
		const m = ln.trim().match(/^\S+\s+(\S+)/);
		if (m) set.add(m[1]);
	}
	filterCache.set(ffmpeg, set);
	return set;
}

/** 带标签的网格需要 `ass`（libass）与 `tile`；缺了就在取帧之前报错，MUST NOT 静默产出无标签网格。 */
export function assertGridFilters(ffmpeg: string): void {
	const f = ffmpegFilters(ffmpeg);
	const missing = ["ass", "tile", "showinfo", "trim"].filter((n) => !f.has(n));
	if (missing.length) {
		throw new Error(
			`本机 ffmpeg 缺少滤镜 ${missing.join(" / ")}（带标签的网格要用 libass 画字、tile 拼格）。` +
				`换一个带 libass 的构建：gtrk deps install --ffmpeg（同合云镜像的构建自带）。\n${FFMPEG_INSTALL_HINT}`,
		);
	}
}

/** 标签字体候选（按序取第一个本机有的）。都没有时交给 libass 的字形回退。 */
export const LABEL_FONT_CANDIDATES = [
	"HarmonyOS Sans SC",
	"Source Han Sans SC",
	"Source Han Sans CN",
	"Noto Sans CJK SC",
	"Noto Sans SC",
	"Alibaba PuHuiTi",
	"Microsoft YaHei",
	"PingFang SC",
	"DengXian",
	"WenQuanYi Micro Hei",
];

let fontCache: string | undefined;

export function pickLabelFont(): string {
	if (fontCache) return fontCache;
	let families: Set<string>;
	try {
		families = new Set([...localFontFamilies(), ...systemFontFamilies()]);
	} catch {
		families = new Set();
	}
	fontCache = LABEL_FONT_CANDIDATES.find((f) => families.has(f)) ?? "Microsoft YaHei";
	return fontCache;
}

// ───────────────────────────── 取帧 ─────────────────────────────

/** 把任意切块的文本流还原成完整行（`\r\n` / `\n` / `\r` 都算行尾，空行丢弃）；`end()` 交出残行。 */
export function createLineSplitter(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
	let buf = "";
	return {
		push(chunk: string) {
			buf += chunk;
			const parts = buf.split(/\r\n|\n|\r/);
			buf = parts.pop() ?? "";
			// 块恰好切在 `\r\n` 中间时，`\r` 已算行尾、下一块开头的 `\n` 只会产出空行（丢弃），不会多出一行
			for (const ln of parts) if (ln) onLine(ln);
		},
		end() {
			if (buf) onLine(buf);
			buf = "";
		},
	};
}

/**
 * 跑 ffmpeg，stderr 按**完整行**回调。
 *
 * ⚠️ 不能用「每个数据块按换行切」：块边界会切在一行中间，被切开的 showinfo 行两半都不匹配，
 * 时间戳就少一个——而帧文件一个不少，于是后面每一格的时间标签整体前移一格（负载高时实测 15 帧只读回 12 个）。
 * 这里攒到换行才回调，进程结束时把残行也交出去；`-nostats` 由调用方加，免得进度行（`\r` 结尾）混进来。
 */
export function runFfmpegLines(ffmpeg: string, args: readonly string[], onLine: (line: string) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(ffmpeg, [...args], { env: process.env, windowsHide: true });
		let tail = "";
		const lines = createLineSplitter(onLine);
		p.stderr.setEncoding("utf8");
		p.stderr.on("data", (chunk: string) => {
			tail = (tail + chunk).slice(-4000);
			lines.push(chunk);
		});
		p.on("error", reject);
		p.on("close", (code) => {
			lines.end();
			if (code === 0) resolve();
			else reject(new Error(`ffmpeg 退出码 ${code}：${tail.slice(-600)}`));
		});
	});
}

/** 精确取帧的预解码距离（秒）。 */
export const SEEK_RUN_UP = 2;

/** showinfo 行里的 `pts_time:`（只认 showinfo 自己的行）。 */
export function parseShowinfoTimes(lines: readonly string[]): number[] {
	const out: number[] = [];
	for (const ln of lines) {
		if (!ln.includes("Parsed_showinfo")) continue;
		const m = ln.match(/\bn:\s*\d+\s.*?\bpts_time:\s*(-?\d+(?:\.\d+)?)/);
		if (m) out.push(Number(m[1]));
	}
	return out;
}

const scaleTo = (width?: number) => (width ? `,scale=${width}:-2:flags=bicubic` : "");

/** 一个进程里取几个时刻：每个时刻一路输入（各自粗跳），一条滤镜链、一个输出。 */
export const FRAMES_PER_PROCESS = 8;

/** 具名 showinfo 实例（`showinfo@g<k>`）的第 0 帧时间：多路同进程时按实例名认领，不靠日志先后。 */
export function parseNamedShowinfo(lines: readonly string[], count: number): Array<number | undefined> {
	const out = new Array<number | undefined>(count).fill(undefined);
	for (const ln of lines) {
		const m = ln.match(/\[showinfo@g(\d+) @ [^\]]*\]\s*n:\s*0\s.*?\bpts_time:\s*(-?\d+(?:\.\d+)?)/);
		if (!m) continue;
		const k = Number(m[1]);
		if (k < count && out[k] === undefined) out[k] = Number(m[2]);
	}
	return out;
}

/**
 * 一批时刻在**一个** ffmpeg 进程里取帧：每个时刻一路 `-ss` 粗跳的输入 + `trim=start=<t>` 精确落帧，
 * 各自写一个 JPEG；返回各帧在源片时钟上的真实时间（与入参同序）。
 * 进程启动是这里的主成本（静态构建的 ffmpeg 约 200MB），按批合并比一帧一进程省一个量级。
 */
export async function extractFramesBatch(
	ffmpeg: string,
	src: string,
	items: ReadonlyArray<{ at: number; out: string }>,
	width?: number,
): Promise<number[]> {
	const inputs: string[] = [];
	const chains: string[] = [];
	const outputs: string[] = [];
	for (const [k, it] of items.entries()) {
		const jump = Math.max(0, r3(it.at - SEEK_RUN_UP));
		inputs.push("-copyts", "-start_at_zero", ...(jump > 0 ? ["-ss", String(jump)] : []), "-i", src);
		chains.push(`[${k}:v:0]trim=start=${it.at},showinfo@g${k}=checksum=0${scaleTo(width)}[o${k}]`);
		outputs.push("-map", `[o${k}]`, "-frames:v", "1", "-fps_mode", "passthrough", "-pix_fmt", "yuvj420p", "-q:v", "3", it.out);
	}
	const lines: string[] = [];
	await runFfmpegLines(
		ffmpeg,
		["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-y", ...inputs, "-filter_complex", chains.join(";"), ...outputs],
		(ln) => lines.push(ln),
	);
	const times = parseNamedShowinfo(lines, items.length);
	return times.map((t, k) => {
		if (t === undefined || !existsSync(items[k].out)) throw new Error(`${items[k].at}s 处（含）之后没有视频帧`);
		return r3(t);
	});
}

/** 取 `at` 处或之后的第一帧，写 JPEG；返回该帧在源片时钟上的真实时间。 */
export async function extractFrameAt(ffmpeg: string, src: string, at: number, out: string, width?: number): Promise<number> {
	const [t] = await extractFramesBatch(ffmpeg, src, [{ at, out }], width);
	return t;
}

/** 区间 [start, end) 连续解码一次，保留每一原始帧及其真实时间（VFR 保留真实间隔）。文件名 `%06d.jpg` 从 0 起。 */
export async function decodeInterval(
	ffmpeg: string,
	src: string,
	start: number,
	end: number,
	dir: string,
	width?: number,
): Promise<Array<{ at: number; path: string }>> {
	mkdirSync(dir, { recursive: true });
	const lines: string[] = [];
	await runFfmpegLines(
		ffmpeg,
		[
			"-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-y", "-copyts", "-start_at_zero",
			...(start > 0 ? ["-ss", String(start)] : []),
			"-i", src, "-map", "0:v:0", "-an",
			"-vf", `trim=start=${start}:end=${end},showinfo=checksum=0${scaleTo(width)}`,
			"-fps_mode", "passthrough", "-pix_fmt", "yuvj420p", "-q:v", "3", "-start_number", "0",
			join(dir, "%06d.jpg"),
		],
		(ln) => lines.push(ln),
	);
	const times = parseShowinfoTimes(lines);
	if (!times.length) throw new Error(`[${start}, ${end}) 内没有视频帧`);
	// 帧文件与时间戳 MUST 一一对应：差一个，后面每一格的标签都会错位，宁可作废不交付
	const written = readdirSync(dir).filter((f) => /^\d{6}\.jpg$/.test(f)).length;
	if (written !== times.length) {
		throw new Error(`解出 ${written} 帧却读回 ${times.length} 个时间戳——为免标签错位，本次作废（可重跑；反复出现请反馈）`);
	}
	return times.map((at, i) => ({ at: r3(at), path: join(dir, `${String(i).padStart(6, "0")}.jpg`) }));
}

/** 有限并发的有序 map：结果按入参顺序返回，与完成顺序无关（格序由此构造性保证）。 */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return out;
}

/** 同时跑几个取帧进程（每个进程内已有多路解码）。 */
export const EXTRACT_CONCURRENCY = Math.max(1, Math.min(2, cpus().length || 1));

// ───────────────────────────── 拼页 ─────────────────────────────

export interface RenderPageInput {
	/** 本页各格的帧文件，**顺序即格序**。 */
	frames: readonly string[];
	cols: number;
	rows: number;
	cellWidth: number;
	pictureHeight: number;
	labelHeight: number;
	/** 本页 ASS 文本（`buildPageAss` 产出，PlayRes 已等于页面像素）。 */
	ass: string;
	/** 临时工作目录（调用方负责删除）。 */
	workDir: string;
	out: string;
}

/**
 * 拼一页：帧按格序硬链接 / 复制成 `%05d.jpg`，`scale → pad 出标签带 → tile → ass` 一条滤镜链出图。
 * 末页不满时 `tile` 在 EOF 补底色输出（rows 已按实际格数算，空格只出现在最后一行）。
 */
export async function renderPage(ffmpeg: string, input: RenderPageInput): Promise<void> {
	mkdirSync(input.workDir, { recursive: true });
	for (const [i, f] of input.frames.entries()) {
		const dst = join(input.workDir, `${String(i).padStart(5, "0")}.jpg`);
		try {
			linkSync(f, dst);
		} catch {
			copyFileSync(f, dst);
		}
	}
	const assPath = join(input.workDir, "page.ass");
	writeFileSync(assPath, input.ass, "utf8");
	const w = input.cellWidth;
	const h = input.pictureHeight;
	let ass = `ass='${assFilterPath(assPath)}'`;
	if (hasLocalFonts()) ass += `:fontsdir='${assFilterPath(fontsDir())}'`;
	const vf = [
		`scale=${w}:${h}:flags=bicubic`,
		"setsar=1",
		`pad=${w}:${h + input.labelHeight}:0:0:color=0x0c0c0c`,
		`tile=${input.cols}x${input.rows}:margin=8:padding=8:color=0x0c0c0c`,
		ass,
	].join(",");
	const isPng = /\.png$/i.test(input.out);
	await runFfmpeg(ffmpeg, [
		"-hide_banner", "-nostdin", "-v", "error", "-y",
		"-framerate", "25", "-start_number", "0", "-i", join(input.workDir, "%05d.jpg"),
		"-vf", vf, "-frames:v", "1",
		...(isPng ? [] : ["-pix_fmt", "yuvj420p", "-q:v", "3"]),
		input.out,
	]);
}

// ───────────────────────────── 截段 ─────────────────────────────

/** 截一段证据片：提前跳入 + 精确定位，重编码（不做逐帧烧时码，见 design D7）。 */
export async function cutClip(ffmpeg: string, src: string, start: number, end: number, out: string): Promise<void> {
	const jump = Math.max(0, r3(start - SEEK_RUN_UP));
	const runUp = r3(start - jump);
	await runFfmpeg(ffmpeg, [
		"-hide_banner", "-nostdin", "-v", "error", "-y",
		...(jump > 0 ? ["-ss", String(jump)] : []),
		"-i", src,
		...(runUp > 0 ? ["-ss", String(runUp)] : []),
		"-t", String(r3(end - start)),
		"-map", "0:v:0?", "-map", "0:a:0?",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
		out,
	]);
}

// ───────────────────────────── 变化点采样流 ─────────────────────────────

/** 按 `rate` 采样成 32×32 RGB 原始流，边读边打分（只留上一帧）。 */
export function scanBoundaries(
	ffmpeg: string,
	src: string,
	opts: { start: number; end: number; rate: number; threshold: number },
): Promise<{ candidates: BoundaryCandidate[]; samples: number }> {
	return new Promise((resolve, reject) => {
		const args = [
			"-hide_banner", "-nostdin", "-v", "error",
			...(opts.start > 0 ? ["-ss", String(opts.start)] : []),
			"-t", String(r3(opts.end - opts.start)),
			"-i", src, "-map", "0:v:0", "-an",
			"-vf", `fps=${opts.rate},scale=${BOUNDARY_SIDE}:${BOUNDARY_SIDE},format=rgb24`,
			"-f", "rawvideo", "-",
		];
		const scorer = new BoundaryScorer(opts.rate, opts.threshold, opts.start);
		const p = spawn(ffmpeg, args, { env: process.env });
		let tail = "";
		p.stdout.on("data", (chunk: Buffer) => scorer.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
		p.stderr.on("data", (b: Buffer) => {
			tail = (tail + b.toString("utf8")).slice(-2000);
		});
		p.on("error", reject);
		p.on("close", (code) => {
			if (code === 0) resolve({ candidates: scorer.candidates, samples: scorer.frames });
			else reject(new Error(`ffmpeg 退出码 ${code}：${tail.slice(-600)}`));
		});
	});
}
