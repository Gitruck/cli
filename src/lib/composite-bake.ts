/**
 * 合成烘焙的执行层（change add-composite-bake）：中间文件、工作目录锁、常驻工作池、编码拼接、进度与取消。
 * 计划与缓存键在 `composite-bake-plan.ts`；浏览器驱动在 `composite-browser.ts`；出片台是 `assets/composite-kit/stage.html`。
 *
 * 设计依据见 change design（D2–D8）与 explore §五：
 * - 截帧：headless-shell 走 beginFrame（确定性出帧），系统浏览器退路走截图；
 * - 分段：常驻工作页从共享队列取「一颗合成 × 90 帧」，每段先渲染前一帧（不出图）再出图；
 * - 取帧：取用段按簇转全帧内中间文件，起点对齐源帧、时间戳归零，实测帧时间戳表交给出片台；
 * - 产物：`<.gtrk 目录>/assets/composite-bake/<键>.mp4`，先写临时文件再改名。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { availableParallelism, cpus } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	bakeCacheKey,
	bakeFrameCount,
	bakeFrameTime,
	CHUNK_FRAMES,
	entryMaterials,
	isImagePath,
	materialPath,
	planBake,
	sourceClusters,
	type BakeEntry,
	type BakePlan,
	type BakePlanFailure,
	type SourceCluster,
} from "./composite-bake-plan";
import { HeadlessBrowser, resolveBakeBrowser, type BakeBrowser } from "./composite-browser";
import { resolveFfmpeg, FFMPEG_INSTALL_HINT, type FfmpegResolution } from "./ffmpeg";
import { packageRoot } from "./paths";
import { fetchBrowserManifest, installBrowser } from "./runtime-assets";

type Obj = Record<string, unknown>;

/** 进度事件（`--progress jsonl` 逐行输出；客户端据此画进度）。 */
export type BakeEvent =
	| { type: "start"; composites: number; frames: number; cached: number; failed: number }
	| { type: "browser"; phase: "resolved" | "missing" | "installing" | "installed"; source?: string; mode?: string; exe?: string; got?: number; total?: number; note?: string }
	| { type: "prep"; done: number; total: number }
	| { type: "progress"; done: number; total: number; fps: number }
	| { type: "composite"; id: string; clip_id: string; state: "done" | "cached" | "failed"; path?: string; frames?: number; reason?: string }
	| { type: "cancelled" }
	| { type: "done"; ok: boolean; seconds: number };

export interface BakeItem {
	id: string;
	clipId: string;
	state: "done" | "cached" | "failed";
	path?: string;
	frames?: number;
	reason?: string;
}

export interface BakeResult {
	items: BakeItem[];
	browser: { source: string; mode: string; exe: string; build: string } | null;
	fps: number;
	workers: number;
	seconds: number;
	/** 出片台没走中间文件、直接定位原素材的次数（> 0 说明取用区间算漏了，慢但结果正确）。 */
	fallbackSeeks: number;
	/** 首次画出的不是要的那一帧、经等待或重新定位才对上的槽位次数（帧号条核对；机器越忙越多，结果仍正确）。 */
	retakes: number;
	cancelled: boolean;
	/**
	 * 资源释放完毕（工作页退出、临时目录删除）。结果先交回、释放在后台进行（工作页正常退出加删目录要 0.2–2 秒，
	 * 机器忙或强杀后文件被占时可到十几秒，不该让用户等）；调用方退出进程前 SHOULD 等它。没起过工作页时缺省。
	 */
	settled?: Promise<void>;
}

export class BakeEnvError extends Error {}

/** 工作页正常用完时给它自己退出的宽限；超时再强制结束进程树。 */
export const BROWSER_CLOSE_GRACE_MS = 3000;

export interface BakeOptions {
	gtrk: Obj;
	/** 素材相对路径基准与产物落点（= .gtrk 所在目录；快照交接时为 `--base`）。 */
	baseDir: string;
	fps?: number;
	workers?: number;
	only?: string[];
	installBrowser?: boolean;
	onEvent?: (ev: BakeEvent) => void;
	signal?: AbortSignal;
	/** 测试注入。 */
	chunkFrames?: number;
	browser?: BakeBrowser | null;
	/** 测试注入：截帧改为无损 PNG，另存一份到该目录（`<clip_id>-<帧号 6 位>.png`），供逐位比对（tasks 3.6 / 2.6）。 */
	dumpFrames?: string;
	/** 测试注入：每段编码器起来后回调（用来模拟编码器中途退出）。 */
	onEncoder?: (enc: ChildProcess, chunk: { clipId: string; a: number; attempt: number }) => void;
}

/** 缺省并发：`min(⌊逻辑核数 / 3⌋, 6)`，至少 1；系统浏览器退路再降一档（design D6）。 */
export function defaultWorkers(cores: number, mode: BakeBrowser["mode"]): number {
	const k = Math.max(1, Math.min(Math.floor(cores / 3), 6));
	return mode === "screenshot" ? Math.max(1, k - 1) : k;
}

export const bakeDir = (baseDir: string) => join(baseDir, "assets", "composite-bake");

/**
 * 每段的编码参数：截帧 JPEG（全范围 YCbCr）→ RGB → **BT.709 限幅范围** yuv420p，并写明色彩标记。
 * ⚠️ 不能直接 `-pix_fmt yuv420p`：ffmpeg 会把 JPEG 的全范围标记原样带进 H.264（`yuvj420p` / pc / bt470bg），
 * 而 Chromium（客户端预览与原生导出的解码方）不认 H.264 的全范围标记、按限幅范围拉伸——实测背景 242 → 255 过曝，
 * PSNR 24.6 dB；按本参数编码后 Chromium 解码 40.3 dB（apply 时实测，2026-10-15）。剪映 / Pr 对 HD 素材同样按 BT.709 限幅理解。
 */
export const BAKE_ENCODE_ARGS = [
	"-vf", "format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
	"-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
	// 色彩标记写进码流 VUI：经过 -vf 后单靠 -color_primaries / -color_trc 写不进去（实测 unknown）
	"-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv",
	"-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
];
/**
 * 帧号条：中间文件底部加高 `FRAME_TAG_H` 的条带，把本文件内的帧序号按 16 位黑白块写进去（块宽随画宽，`floor(iw/32)*2`）。
 * 出片台画完一帧先读回这条、核对是不是要的那一帧，不对就等它到位（必要时重新定位），始终不对则报错让该段重试。
 * ⚠️ 不能只信 `<video>` 的 `seeked`：机器满载时 `seeked` 已触发而新帧还没送到可画处，画出的是上一帧或空帧
 * （全量测试并发下取帧金样 240 帧错 2 帧：一帧前一帧、一帧全黑）。成片只取条带以上的画面。
 */
export const FRAME_TAG_H = 16;
export const FRAME_TAG_BITS = 16;
function segmentFilter(): string {
	const boxes = Array.from(
		{ length: FRAME_TAG_BITS },
		(_, b) => `drawbox=x=${b}*floor(iw/32)*2:y=ih-${FRAME_TAG_H}:w=floor(iw/32)*2:h=${FRAME_TAG_H}:color=white:t=fill:enable='eq(mod(floor(n/${2 ** b}),2),1)'`,
	);
	return ["setpts=PTS-STARTPTS", `pad=iw:ih+${FRAME_TAG_H}:0:0:black`, ...boxes].join(",");
}
/**
 * 中间文件编码参数（全帧内、时间戳归零后**原样保留**）。
 * ⚠️ `-enc_time_base 1/90000` + 同刻度封装不可省：编码器缺省时基 = 1 / 平均帧率，可变帧率素材的时间戳会被吸到这张网格上
 * （实测手机式 VFR 源 0.1533 → 0.1525），出片台按实测表找覆盖帧就错一帧（取帧金样实测 240 帧错 6 帧）。
 * 显式比值而非 `demux` / `-1`：两种特殊值的写法在 ffmpeg 各版本间不同，比值写法通用。
 */
export const SEGMENT_ENCODE_ARGS = [
	"-vf", segmentFilter(), "-fps_mode", "passthrough", "-enc_time_base", "1/90000", "-video_track_timescale", "90000",
	"-c:v", "libx264", "-g", "1", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p",
];
export const STAGE_HTML = () => join(packageRoot(), "assets", "composite-kit", "stage.html");

/**
 * 颗粒在烘焙台里的内容安全策略：资源类指令与客户端预览运行时（`public/tonghe/player.html`）逐条一致；
 * `script-src` 因注入方式不同而不同（客户端以 blob 执行颗粒脚本，烘焙台内联执行），见 design D5。
 */
export const BAKE_CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** 给颗粒文档注入 CSP（`<head>` 后第一位；没有 head 时放最前）。 */
export function withCsp(html: string): string {
	const meta = `<meta http-equiv="Content-Security-Policy" content="${BAKE_CSP}">`;
	const m = /<head\b[^>]*>/i.exec(html);
	return m ? html.slice(0, m.index + m[0].length) + meta + html.slice(m.index + m[0].length) : meta + html;
}

// ------------------------------------------------------------------ 工作目录：锁与清扫

/** 心跳间隔与判死阈值：运行中每 2 秒刷新锁文件修改时间，30 秒没刷新即判遗留（不靠 PID——PID 会被复用）。 */
const HEARTBEAT_MS = 2000;
export const STALE_AFTER_MS = 30_000;

/** 清扫遗留工作目录（锁文件超过阈值未刷新、或没有锁文件）。返回清掉的目录。 */
export function sweepStaleWorkDirs(dir: string, now = Date.now()): string[] {
	if (!existsSync(dir)) return [];
	const swept: string[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(".work-")) continue;
		const p = join(dir, name);
		const lock = join(p, "lock.json");
		let stale = true;
		try {
			stale = now - statSync(lock).mtimeMs > STALE_AFTER_MS;
		} catch {
			/* 没有锁文件 = 遗留 */
		}
		if (stale) {
			rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			swept.push(p);
		}
	}
	return swept;
}

function openWorkDir(dir: string): { path: string; release: () => Promise<void> } {
	mkdirSync(dir, { recursive: true });
	sweepStaleWorkDirs(dir);
	const path = join(dir, `.work-${process.pid}-${Date.now()}`);
	mkdirSync(path, { recursive: true });
	const lock = join(path, "lock.json");
	writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
	const timer = setInterval(() => {
		const t = new Date();
		try {
			utimesSync(lock, t, t);
		} catch {
			/* 目录已被删（取消收尾中）：心跳无事可做 */
		}
	}, HEARTBEAT_MS);
	timer.unref();
	return {
		path,
		// 异步删：取消时编码器刚被结束、文件可能还占着，同步重试会卡住事件循环
		release: async () => {
			clearInterval(timer);
			await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		},
	};
}

// ------------------------------------------------------------------ 中间文件

interface Segment {
	url: string;
	off: number;
	ed: number;
	pts: number[];
	/** 底部帧号条高度（出片台据此核对已画帧、裁掉条带）。 */
	tag: number;
	/** 转到了素材结尾（簇右端超出素材最后一帧）：出片台对更晚的源时刻取本文件末帧——素材到头了，与客户端「超出取末帧」同口径。 */
	eof: boolean;
}

/** 异步跑 ffprobe（探帧表要解码，长素材可达数秒；同步调用会卡住事件循环、进度行断档）。 */
function probeJson(ff: FfmpegResolution, args: string[]): Promise<Obj> {
	return new Promise((res, rej) => {
		const p = spawn(ff.ffprobe, ["-v", "error", ...args, "-of", "json"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const out: Buffer[] = [];
		let err = "";
		p.stdout?.on("data", (d: Buffer) => out.push(d));
		p.stderr?.on("data", (d) => (err = (err + String(d)).slice(-2000)));
		p.on("error", rej);
		p.on("close", (code) => {
			if (code !== 0) return rej(new Error(`ffprobe 失败：${err.slice(-300)}`));
			try {
				res(JSON.parse(Buffer.concat(out).toString("utf8") || "{}") as Obj);
			} catch (e) {
				rej(e as Error);
			}
		});
	});
}

const startOf = (j: Obj): number => {
	const s = Number((j.streams as Obj[] | undefined)?.[0]?.start_time);
	return Number.isFinite(s) ? s : 0;
};

/**
 * 视频流起点（秒，缺省 0）：ffprobe 的帧时间戳是绝对值，`-ss` 与 `<video>.currentTime` 相对文件起点。
 * 同一次烘焙内按文件记住（`cache`）：Windows 上起进程是同步的，满载时单次能卡住主线程近 1 秒，能省一次是一次。
 */
async function streamStart(ff: FfmpegResolution, file: string, cache?: Map<string, number>): Promise<number> {
	const hit = cache?.get(file);
	if (hit !== undefined) return hit;
	const s = startOf(await probeJson(ff, ["-select_streams", "v:0", "-show_entries", "stream=start_time", file]));
	cache?.set(file, s);
	return s;
}

/**
 * 帧时间戳表（相对文件起点、升序）：`from..to` 秒范围内；不给范围则全片。
 * 先读容器的包索引（不解码，快一个量级；剔除标了丢弃 `D` 的包——编辑列表裁掉的那些不出画），
 * 有包缺时间戳（个别裸流 / 老容器）时退回逐帧解码。apply 时实测：逐帧解码让测试工程预处理多花约 20 秒。
 */
export async function frameTimes(ff: FfmpegResolution, file: string, range?: [number, number], startCache?: Map<string, number>): Promise<number[]> {
	// 全片：起点与包时间戳一次 ffprobe 取齐；带范围：先要起点才能换算绝对区间
	const known = range ? await streamStart(ff, file, startCache) : undefined;
	const interval = range ? ["-read_intervals", `${(known! + Math.max(range[0], 0)).toFixed(6)}%${(known! + range[1]).toFixed(6)}`] : [];
	const pk = await probeJson(ff, ["-select_streams", "v:0", "-show_entries", range ? "packet=pts_time,flags" : "stream=start_time:packet=pts_time,flags", ...interval, file]);
	const start = known ?? startOf(pk);
	const rel = (ts: number[]) => ts.map((t) => t - start).sort((a, b) => a - b);
	const packets = ((pk.packets as Obj[] | undefined) ?? []).filter((x) => !String(x.flags ?? "").includes("D"));
	const pts = packets.map((x) => Number(x.pts_time));
	if (pts.length && pts.every((t) => Number.isFinite(t))) return rel(pts);
	const fr = await probeJson(ff, ["-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", ...interval, file]);
	return rel(((fr.frames as Obj[] | undefined) ?? []).map((f) => Number(f.best_effort_timestamp_time)).filter((t) => Number.isFinite(t)));
}

/**
 * 一簇取用段 → 全帧内中间文件。起点对齐到「覆盖簇起点的那一帧」：先探出该帧时间戳 st，以略早于它的位置
 * 精确寻址，保证中间文件第 0 帧就是这一帧；`setpts=PTS-STARTPTS` 归零后再**实测**全表（不假设首帧为 0）。
 */
async function makeSegment(
	ff: FfmpegResolution,
	src: string,
	c: SourceCluster,
	out: string,
	startCache?: Map<string, number>,
	track?: Set<ChildProcess>,
): Promise<Segment> {
	const near = await frameTimes(ff, src, [c.from - 1.5, c.from + 0.5], startCache);
	const st = near.filter((t) => t <= c.from + 1e-6).pop() ?? near[0] ?? Math.max(c.from, 0);
	const dur = c.to - st + 0.5;
	await run(ff.ffmpeg, [
		"-v", "error", "-y",
		"-ss", Math.max(st - 0.001, 0).toFixed(6), "-t", dur.toFixed(6), "-i", src,
		"-an", ...SEGMENT_ENCODE_ARGS, out,
	], track);
	const pts = await frameTimes(ff, out);
	if (!pts.length) throw new Error(`中间文件没有帧：${out}`);
	const step = pts.length > 1 ? pts[pts.length - 1] - pts[pts.length - 2] : 1 / 30;
	const ed = st + (pts[pts.length - 1] - pts[0]) + step;
	return { url: pathToFileURL(out).href, off: st, ed, pts, tag: FRAME_TAG_H, eof: ed <= c.to };
}

/** 跑一个子进程到结束；给了 `track` 就在运行期间登记进去（取消时据此结束）。 */
function run(cmd: string, args: string[], track?: Set<ChildProcess>): Promise<void> {
	return new Promise((res, rej) => {
		const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
		track?.add(p);
		p.on("close", () => track?.delete(p));
		let err = "";
		p.stderr?.on("data", (d) => (err = (err + String(d)).slice(-2000)));
		p.on("error", rej);
		p.on("close", (code) => (code === 0 ? res() : rej(new Error(`${cmd} 退出码 ${code}：${err.trim().slice(-400)}`))));
	});
}

/** 有限并发跑一组任务。 */
async function limit<T>(n: number, jobs: Array<() => Promise<T>>): Promise<T[]> {
	const out: T[] = new Array(jobs.length);
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, jobs.length) }, async () => {
			for (let j; (j = i++) < jobs.length; ) out[j] = await jobs[j]();
		}),
	);
	return out;
}

// ------------------------------------------------------------------ 主流程

interface Chunk {
	entry: BakeEntry;
	a: number;
	b: number;
	attempt: number;
}

/** 无新事件时重发上一条阶段事件的间隔：机读进度相邻两行不超过 1 秒（预处理、装浏览器、启动工作页期间同样成立）。 */
const KEEPALIVE_MS = 600;

export async function bakeComposites(opts: BakeOptions): Promise<BakeResult> {
	const sink = opts.onEvent ?? (() => {});
	let lastAt = Date.now();
	let lastStatus: BakeEvent | null = null;
	const emit = (ev: BakeEvent) => {
		lastAt = Date.now();
		if (ev.type === "prep" || ev.type === "progress" || (ev.type === "browser" && ev.phase === "installing")) lastStatus = ev;
		sink(ev);
	};
	const keepalive = setInterval(() => {
		if (lastStatus && Date.now() - lastAt >= KEEPALIVE_MS) emit(lastStatus);
	}, 100);
	keepalive.unref();
	try {
		return await bakeRun(opts, emit);
	} finally {
		clearInterval(keepalive);
	}
}

async function bakeRun(opts: BakeOptions, emit: (ev: BakeEvent) => void): Promise<BakeResult> {
	const t0 = Date.now();
	const plan = planBake(opts.gtrk, opts.baseDir, (p) => readFileSync(p, "utf8"), { only: opts.only });
	const fps = Math.round(opts.fps ?? plan.rate);
	if (!(fps > 0)) throw new Error(`fps 非法：${opts.fps}`);
	const items: BakeItem[] = plan.failed.map((f: BakePlanFailure) => ({ id: f.id, clipId: f.clipId, state: "failed" as const, reason: f.reason }));
	const result: BakeResult = { items, browser: null, fps, workers: 0, seconds: 0, fallbackSeeks: 0, retakes: 0, cancelled: false };
	if (!plan.entries.length) {
		for (const it of items) emit({ type: "composite", id: it.id, clip_id: it.clipId, state: "failed", reason: it.reason });
		result.seconds = (Date.now() - t0) / 1000;
		return result;
	}

	// 没有要烤的合成就不需要 ffmpeg（`project export` 对无合成工程不得因此失败）
	const ff = resolveFfmpeg();
	if (!ff) throw new BakeEnvError(FFMPEG_INSTALL_HINT);

	// ---- 浏览器
	let browser = opts.browser !== undefined ? opts.browser : resolveBakeBrowser();
	if ((!browser || browser.source === "system") && opts.installBrowser) {
		emit({ type: "browser", phase: "installing" });
		const bm = await fetchBrowserManifest();
		await installBrowser(bm, { onProgress: (got, total) => emit({ type: "browser", phase: "installing", got, total }) });
		browser = resolveBakeBrowser();
		emit({ type: "browser", phase: "installed" });
	}
	if (!browser) {
		emit({ type: "browser", phase: "missing" });
		throw new BakeEnvError("找不到可用的浏览器：装钉定版本的 chrome-headless-shell（gtrk deps install --browser），或安装 Chrome / Edge，或设环境变量 GTRK_CHROME。");
	}
	emit({
		type: "browser",
		phase: "resolved",
		source: browser.source,
		mode: browser.mode,
		exe: browser.exe,
		...(browser.source === "system" ? { note: "使用系统浏览器：更慢、并发已降档；装钉定版本可提速：gtrk deps install --browser" } : {}),
	});
	result.browser = { source: browser.source, mode: browser.mode, exe: browser.exe, build: browser.build };

	// ---- 缓存
	const outDir = bakeDir(opts.baseDir);
	const stagePath = STAGE_HTML();
	const stageSha256 = createHash("sha256").update(readFileSync(stagePath)).digest("hex");
	const fingerprint = (id: string) => {
		const p = materialPath(opts.gtrk, id, opts.baseDir);
		if (!p || !existsSync(p)) return null;
		const st = statSync(p);
		return { id, size: st.size, mtime_ms: st.mtimeMs };
	};
	const todo: Array<{ entry: BakeEntry; key: string; out: string; frames: number }> = [];
	for (const entry of plan.entries) {
		// 素材缺失：直接判该颗失败并点名（否则出片台会一直等 <video> 元数据，直到 CDP 超时才失败）
		const missing = entryMaterials(entry, plan, fps)
			.map((id) => ({ id, path: materialPath(opts.gtrk, id, opts.baseDir) }))
			.filter((m) => !m.path || !existsSync(m.path));
		if (missing.length) {
			items.push({ id: entry.id, clipId: entry.clipId, state: "failed", reason: `素材缺失：${missing.map((m) => m.path ?? `${m.id}（工程里没有路径）`).join("、")}` });
			continue;
		}
		const key = bakeCacheKey(entry, plan, { fps, browserBuild: browser.build, stageSha256, encodeSig: [...SEGMENT_ENCODE_ARGS, "|", ...BAKE_ENCODE_ARGS].join(" "), fingerprint });
		const out = join(outDir, `${key}.mp4`);
		const frames = bakeFrameCount(entry, plan.rate, fps);
		if (existsSync(out)) items.push({ id: entry.id, clipId: entry.clipId, state: "cached", path: out, frames });
		else todo.push({ entry, key, out, frames });
	}
	const totalFrames = todo.reduce((s, x) => s + x.frames, 0);
	emit({ type: "start", composites: plan.entries.length + plan.failed.length, frames: totalFrames, cached: items.filter((i) => i.state === "cached").length, failed: items.filter((i) => i.state === "failed").length });
	for (const it of items) emit({ type: "composite", id: it.id, clip_id: it.clipId, state: it.state, path: it.path, frames: it.frames, reason: it.reason });
	if (!todo.length) {
		result.seconds = (Date.now() - t0) / 1000;
		return result;
	}

	// ---- 工作目录、取消
	const work = openWorkDir(outDir);
	const live = { browsers: new Set<HeadlessBrowser>(), encoders: new Set<ChildProcess>() };
	// 浏览器一律异步收尾（同步 taskkill 会卡住事件循环、进度断档）。正常用完的先请它自己退（整棵进程树一起收、
	// 文件随即解锁）；出错 / 取消的立即强制结束——遗留的子进程由 `closeAsync` 同时按进程树收掉（满载时等它自己退
	// 也退不及，只会白等宽限）。收尾不挡结果：结果先交回，收尾的 Promise 由 `settled` 交代
	const closing: Promise<void>[] = [];
	const retire = (b: HeadlessBrowser, graceful = false) => {
		if (!live.browsers.delete(b)) return;
		closing.push(b.closeAsync(graceful ? BROWSER_CLOSE_GRACE_MS : 0));
	};
	const boots: Promise<unknown>[] = [];
	let cancelled = false;
	// 取消即刻并行结束本次起的编码器与浏览器：在途的 CDP 调用随之失败返回，不必等各工作页渲完手上这一帧
	const onAbort = () => {
		cancelled = true;
		for (const enc of live.encoders) enc.kill("SIGKILL");
		for (const b of [...live.browsers]) retire(b);
	};
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const failComposite = new Map<string, string>();
	try {
		// ---- 分段队列与并发数（只依赖待烤清单，先算出来：预处理期间就把工作页拉起来）
		const chunkFrames = opts.chunkFrames ?? CHUNK_FRAMES;
		const queue: Chunk[] = [];
		const chunksOf = new Map<string, { total: number; done: string[] }>();
		for (const x of todo) {
			const files: string[] = [];
			for (let a = 0; a < x.frames; a += chunkFrames) queue.push({ entry: x.entry, a, b: Math.min(x.frames, a + chunkFrames), attempt: 0 });
			chunksOf.set(x.entry.clipId, { total: Math.ceil(x.frames / chunkFrames), done: files });
		}
		const K = Math.max(1, Math.min(opts.workers ?? defaultWorkers(cpuCount(), browser.mode), queue.length));
		result.workers = K;

		const stageUrl = pathToFileURL(stagePath).href;
		const launchMode = browser.mode === "beginframe" ? "beginframe" : "screenshot-soft";
		let launchGate: Promise<void> = Promise.resolve();
		/** 起一个工作页并打开出片台（还不装数据）。逐个错开；打不开就换新进程重试（系统浏览器多实例同时起时偶发首导航卡死，spike-1）。 */
		const boot = async (): Promise<HeadlessBrowser> => {
			for (let attempt = 1; ; attempt++) {
				const prev = launchGate;
				let release!: () => void;
				launchGate = new Promise((r) => (release = r));
				await prev;
				if (cancelled) {
					release();
					throw new CancelledError();
				}
				let b: HeadlessBrowser | null = null;
				try {
					b = await HeadlessBrowser.launch(browser!.exe, launchMode);
					live.browsers.add(b);
					await b.open(stageUrl, 20000);
					release();
					return b;
				} catch (e) {
					release();
					if (b) retire(b);
					if (cancelled) throw new CancelledError();
					if (attempt >= 3) throw e;
				}
			}
		};
		// 起浏览器（每个 1–2 秒，满载时十几秒，且须错开）与预处理（转中间文件）同时进行，而不是等预处理完才逐个起
		const prebooted = Array.from({ length: K }, () => {
			const p = boot().then(
				(b) => ({ b }),
				(e: unknown) => ({ e }),
			);
			boots.push(p);
			return p;
		});

		// ---- 中间文件（只为要烤的颗粒）
		const sub: BakePlan = { ...plan, entries: todo.map((x) => x.entry), failed: [] };
		const clusters = sourceClusters(sub, fps).filter((c) => {
			const p = materialPath(opts.gtrk, c.material, opts.baseDir);
			return p && existsSync(p) && !isImagePath(p);
		});
		const segs: Record<string, Segment[]> = {};
		const startCache = new Map<string, number>();
		let prepDone = 0;
		emit({ type: "prep", done: 0, total: clusters.length });
		const segResults = await limit(
			6,
			clusters.map((c, i) => async () => {
				if (cancelled) return null;
				const src = materialPath(opts.gtrk, c.material, opts.baseDir) as string;
				try {
					const seg = await makeSegment(ff, src, c, join(work.path, `src-${i}.mp4`), startCache, live.encoders);
					return { material: c.material, seg };
				} catch {
					return null; // 转不出来：出片台退回直接定位原素材（慢但正确），不判失败
				} finally {
					emit({ type: "prep", done: ++prepDone, total: clusters.length });
				}
			}),
		);
		for (const r of segResults) if (r) (segs[r.material] ??= []).push(r.seg);
		if (cancelled) throw new CancelledError();

		// ---- 颗粒文档（注入 CSP）与出片台数据
		const materials: Record<string, string> = {};
		const images: string[] = [];
		for (const m of (opts.gtrk.materials as Obj[] | undefined) ?? []) {
			if (typeof m.id !== "string") continue;
			const p = materialPath(opts.gtrk, m.id, opts.baseDir);
			if (!p) continue;
			materials[m.id] = pathToFileURL(p).href;
			if (isImagePath(p)) images.push(m.id);
		}
		const stageEntries = todo.map(({ entry }, i) => {
			const file = join(work.path, `composite-${i}.html`);
			writeFileSync(file, withCsp(entry.html));
			return { id: entry.id, window_f: entry.window_f, anchors_f: entry.anchors_f, texts: entry.texts, bindings: entry.bindings, url: pathToFileURL(file).href };
		});
		const stageData = { fps: plan.rate, entries: stageEntries, materials, images, segs, tracks: plan.tracks };

		let framesDone = 0;
		const tRender = Date.now();
		let lastEmit = 0;
		const tick = (force = false) => {
			const now = Date.now();
			if (!force && now - lastEmit < 250) return;
			lastEmit = now;
			const sec = (now - tRender) / 1000; // 帧/秒只算渲染段（不含预处理）
			emit({ type: "progress", done: framesDone, total: totalFrames, fps: Math.round((framesDone / Math.max(sec, 0.001)) * 10) / 10 });
		};
		const heartbeat = setInterval(() => tick(true), 1000);
		heartbeat.unref();

		const stageInit = `stageInit(${JSON.stringify(stageData)}); window.SETTLE = -1; true`;
		/** 取一个装好数据的工作页：先用预处理期间起好的，起失败了或用完了再现起。 */
		const launch = async (): Promise<HeadlessBrowser> => {
			const pre = prebooted.shift();
			const got = pre ? await pre : null;
			const b = got && "b" in got ? got.b : await boot();
			try {
				await b.evaluate(stageInit);
				return b;
			} catch (e) {
				retire(b);
				throw e;
			}
		};

		const finishComposite = async (x: (typeof todo)[number]) => {
			const c = chunksOf.get(x.entry.clipId)!;
			const list = join(work.path, `concat-${x.key}.txt`);
			writeFileSync(list, c.done.sort().map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
			const tmp = join(outDir, `.${x.key}.${process.pid}.tmp.mp4`);
			await run(ff.ffmpeg, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", tmp]);
			renameSync(tmp, x.out);
			const item: BakeItem = { id: x.entry.id, clipId: x.entry.clipId, state: "done", path: x.out, frames: x.frames };
			items.push(item);
			emit({ type: "composite", id: item.id, clip_id: item.clipId, state: "done", path: item.path, frames: item.frames });
		};

		const worker = async () => {
			let b: HeadlessBrowser | null = null;
			try {
				for (let q: Chunk | undefined; !cancelled && (q = queue.shift()); ) {
					if (failComposite.has(q.entry.clipId)) continue;
					const x = todo.find((t) => t.entry.clipId === q!.entry.clipId)!;
					const file = join(work.path, `${x.key}-${String(q.a).padStart(6, "0")}.mp4`);
					try {
						if (!b) b = await launch();
						await renderChunk(b, q, file);
						const c = chunksOf.get(q.entry.clipId)!;
						c.done.push(file);
						if (c.done.length === c.total) await finishComposite(x);
					} catch (e) {
						if (cancelled) return;
						if (b) {
							retire(b);
							b = null;
						}
						if (q.attempt === 0) queue.push({ ...q, attempt: 1 });
						else failComposite.set(q.entry.clipId, (e as Error).message);
					}
				}
			} finally {
				if (b && !cancelled) retire(b, true);
			}
		};

		const renderChunk = async (b: HeadlessBrowser, q: Chunk, file: string) => {
			const { entry } = q;
			const dump = opts.dumpFrames;
			const enc = spawn(
				ff.ffmpeg,
				["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", dump ? "png" : "mjpeg", "-i", "-", ...BAKE_ENCODE_ARGS, "-r", String(fps), file],
				{ stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
			);
			live.encoders.add(enc);
			opts.onEncoder?.(enc, { clipId: entry.clipId, a: q.a, attempt: q.attempt });
			let encErr = "";
			enc.stderr?.on("data", (d) => (encErr = (encErr + String(d)).slice(-1000)));
			enc.stdin?.on("error", () => {});
			let encExited = false;
			const closed = new Promise<number | null>((r) => enc.on("close", (code) => ((encExited = true), r(code))));
			let counted = 0;
			try {
				// 段首预滚：先渲染前一帧（不出图），段首帧的渲染历史与连续渲染一致
				if (q.a > 0) await b.evaluate(`renderAt(${bakeFrameTime(entry, plan.rate, fps, q.a - 1)})`);
				for (let k = q.a; k < q.b; k++) {
					if (cancelled) throw new CancelledError();
					// 编码器中途退出：本段立即判失败（否则剩下的帧白渲一遍、逐帧往已关的管道里空写）
					if (encExited) throw new Error(`编码器提前退出（退出码 ${await closed}）：${encErr.trim()}`);
					const r = await b.evaluate<{ used?: Array<{ viaSeg?: boolean; waits?: number }> }>(`renderAt(${bakeFrameTime(entry, plan.rate, fps, k)})`);
					for (const u of r?.used ?? []) {
						if (u.viaSeg === false) result.fallbackSeeks++;
						if ((u.waits ?? 0) > 0) result.retakes++;
					}
					const img = dump ? await b.screenshot("png") : await b.screenshot("jpeg", 92);
					if (dump) writeFileSync(join(dump, `${entry.clipId}-${String(k).padStart(6, "0")}.png`), img);
					// 编码器被结束（取消）时 drain 永远不会来：同时等它退出，否则这个工作页会一直挂着
					if (!enc.stdin!.write(img)) await Promise.race([new Promise((r) => enc.stdin!.once("drain", r)), closed]);
					framesDone++;
					counted++;
					tick();
				}
				enc.stdin!.end();
				const code = await closed;
				if (code !== 0) throw new Error(`编码失败（退出码 ${code}）：${encErr.trim()}`);
			} catch (e) {
				framesDone -= counted; // 本段作废（重试或判失败）：进度退回，重试时不重复计
				throw e;
			} finally {
				live.encoders.delete(enc);
				if (enc.exitCode === null) enc.kill("SIGKILL");
			}
		};

		try {
			await Promise.all(Array.from({ length: K }, () => worker()));
		} finally {
			clearInterval(heartbeat);
		}
		if (cancelled) throw new CancelledError();
		tick(true);
		for (const x of todo) {
			const reason = failComposite.get(x.entry.clipId);
			if (reason) {
				items.push({ id: x.entry.id, clipId: x.entry.clipId, state: "failed", reason });
				emit({ type: "composite", id: x.entry.id, clip_id: x.entry.clipId, state: "failed", reason });
			}
		}
	} catch (e) {
		if (!(e instanceof CancelledError)) throw e;
		result.cancelled = true;
	} finally {
		opts.signal?.removeEventListener("abort", onAbort);
		if (cancelled) {
			for (const enc of live.encoders) enc.kill("SIGKILL");
			result.cancelled = true;
		}
		// 预起的工作页可能还在路上（或根本没被用上）：等它们落定后一并收掉，再删工作目录（浏览器退了文件才解锁）
		result.settled = Promise.allSettled(boots)
			.then(() => {
				for (const b of [...live.browsers]) retire(b, !cancelled);
				return Promise.all(closing);
			})
			.then(() => work.release())
			.catch(() => {
				/* 删不掉的留在产物目录的 .work-*，下次运行按锁心跳清扫 */
			});
	}
	if (result.cancelled) emit({ type: "cancelled" });
	result.seconds = (Date.now() - t0) / 1000;
	return result;
}

class CancelledError extends Error {}

function cpuCount(): number {
	return typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
}
