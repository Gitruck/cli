/**
 * gtrk media —— 本地看片工具族（add-reference-video-reading · media-command spec）。
 *
 *   probe <视频>        时长 / 显示尺寸 / 帧率（VFR）/ 旋转 / 音轨
 *   lines <转写稿>      逐句列表；--find 列出台词每处出现
 *   frames <视频>       单帧（--at / --every / --frames / --every-frame），带 --transcript 或 --label 时帧下方加标签
 *   tile <视频>         一张带标签的抽帧网格
 *   tiles <视频>        分页网格；--ranges 多区间；--every-frame 每段连续解码、保留每一原始帧
 *   boundaries <视频>   视觉变化候选（机械证据，不是镜头判定）；--transcript 时标注对着哪句话
 *   cut <视频>          截一段证据片
 *
 * 纯本地、零计费、不联网、不要 API Key：只读本地文件、只调本机 ffmpeg。参考片精读（/gtrk-ref-reading）的取证工具，
 * 也用来复核自家成片。**只出证据，不出结论**——判读归 agent，写进精读目录的 ANALYSIS / TIMELINE。
 *
 * 方法与命令面来源：hypit `media` 命令族（用户 2026-10-18 已取得 hypit 创始人同意深度参考），gtrk 重写实现：
 * 原生吃 gtrk transcript v1、标签用 libass 画（中文整句上下文）、落点由调用方显式给。
 *
 * 形态沿仓内铁律：顶层命令 + 首个 positional 词内部分派（同 qc / audio / project）。
 */
import type { Command } from "commander";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { requireFfmpeg } from "../lib/ffmpeg";
import { log, routeLogsToStderr } from "../lib/log";
import { readJson } from "../lib/read-json";
import { r3 } from "../lib/frame-domain";
import {
	type FrameWords,
	type TimedTranscript,
	clockWarnings,
	findPhrase,
	loadTranscriptFile,
	sentenceContext,
	utterancesIn,
	wordsAt,
} from "../lib/media-transcript";
import {
	DEFAULT_BOUNDARY_RATE,
	DEFAULT_BOUNDARY_THRESHOLD,
	type LabelLine,
	type RangeEntry,
	type RangeSpec,
	type ResolvedRange,
	buildFrameLabel,
	buildPageAss,
	formatClock,
	labelBandHeight,
	mergeCandidates,
	pageGeometry,
	paginateCount,
	parseAtList,
	parseRangesFile,
	parseTime,
	resolveRange,
	sampleRange,
	secondsStem,
} from "../lib/media-grid";
import {
	EXTRACT_CONCURRENCY,
	FRAMES_PER_PROCESS,
	type MediaProbe,
	assertGridFilters,
	cutClip,
	decodeInterval,
	extractFramesBatch,
	mapPool,
	pickLabelFont,
	probeMedia,
	renderPage,
	scanBoundaries,
} from "../lib/media-ffmpeg";

export const MEDIA_SUBCOMMANDS = ["probe", "lines", "frames", "tile", "tiles", "boundaries", "cut"] as const;
export type MediaSub = (typeof MEDIA_SUBCOMMANDS)[number];

/** 产物回执的 `kind` 前缀：`--force` 只认带它的旧产物。 */
export const MEDIA_KIND_PREFIX = "gtrk.media.";

export const DEFAULT_CELL = 480;
export const DEFAULT_COLS = 3;
export const DEFAULT_ROWS = 3;
/** `tile` 单张上限：再多就该分页（`tiles`），一张图里的标签会小到读不清。 */
export const MAX_TILE_CELLS = 60;
/** 单次调用逐帧解码总量上限：逐帧是看「一个动作」的尺度，不是看一段的尺度。 */
export const MAX_EVERY_FRAME = 1800;

export interface MediaOpts {
	transcript?: string;
	start?: string;
	end?: string;
	around?: string;
	occurrence?: string;
	padding?: string;
	at?: string;
	every?: string;
	frames?: string;
	everyFrame?: boolean;
	ranges?: string;
	label?: boolean;
	cell?: string;
	cols?: string;
	rows?: string;
	find?: string;
	rate?: string;
	threshold?: string;
	minGap?: string;
	out?: string;
	force?: boolean;
	ffmpegPath?: string;
	json?: boolean;
}

// ───────────────────────────── 入参工具 ─────────────────────────────

function num(raw: string | undefined, label: string, o: { int?: boolean; min?: number; max?: number } = {}): number | undefined {
	if (raw === undefined) return undefined;
	const v = Number(raw);
	const ok = Number.isFinite(v) && (!o.int || Number.isSafeInteger(v)) && (o.min === undefined || v >= o.min) && (o.max === undefined || v <= o.max);
	if (!ok) {
		const range = [o.min !== undefined ? `≥${o.min}` : "", o.max !== undefined ? `≤${o.max}` : ""].filter(Boolean).join(" 且 ");
		throw new Error(`${label} 须是${o.int ? "整数" : "数字"}${range ? `（${range}）` : ""}，得到「${raw}」`);
	}
	return v;
}

/** 只认本地文件：链接直接拒（gtrk 的合规边界——不提供下载入口）。 */
export function requireLocalFile(input: string | undefined, what: string): string {
	if (!input) throw new Error(`缺少${what}路径`);
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
		throw new Error(`gtrk media 只处理本地文件，不下载链接：${input}（请先把${what}合法取得并放到本地）`);
	}
	const abs = resolve(input);
	if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`${what}不存在或不是文件：${abs}`);
	return abs;
}

function rangeSpecFromOpts(opts: MediaOpts): RangeSpec {
	const spec: RangeSpec = {};
	if (opts.start !== undefined) spec.start = parseTime(opts.start, "--start");
	if (opts.end !== undefined) spec.end = parseTime(opts.end, "--end");
	if (opts.around !== undefined) spec.around = opts.around;
	if (opts.occurrence !== undefined) spec.occurrence = num(opts.occurrence, "--occurrence", { int: true, min: 1 });
	if (opts.padding !== undefined) spec.padding = parseTime(opts.padding, "--padding");
	return spec;
}

interface VideoCtx {
	ffmpeg: string;
	ffprobe: string;
	src: string;
	probe: MediaProbe;
	transcript?: TimedTranscript;
	transcriptPath?: string;
	warnings: string[];
}

async function openVideo(input: string | undefined, opts: MediaOpts): Promise<VideoCtx> {
	const src = requireLocalFile(input, "视频");
	const { ffmpeg, ffprobe } = requireFfmpeg(opts.ffmpegPath);
	const probe = probeMedia(ffprobe, src);
	if (!probe.hasVideo) throw new Error(`${src}：没有视频流（看片命令需要画面）`);
	const warnings: string[] = [];
	let transcript: TimedTranscript | undefined;
	let transcriptPath: string | undefined;
	if (opts.transcript) {
		transcriptPath = requireLocalFile(opts.transcript, "转写稿");
		transcript = await loadTranscriptFile(transcriptPath);
		for (const w of clockWarnings(transcript, { name: src, duration: probe.duration })) {
			warnings.push(w);
			log.warn(w);
		}
	}
	return { ffmpeg, ffprobe, src, probe, transcript, transcriptPath, warnings };
}

// ───────────────────────────── 落点纪律 ─────────────────────────────

function requireOut(sub: string, out: string | undefined): string {
	if (!out) {
		throw new Error(`gtrk media ${sub} 须用 -o/--out 指定产物落点——看片产物不落当前目录、也不落源片旁（精读时放 <精读目录>/evidence/<描述名>）`);
	}
	return resolve(out);
}

function readKind(file: string): string | undefined {
	try {
		const doc = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as { kind?: unknown };
		return typeof doc.kind === "string" ? doc.kind : undefined;
	} catch {
		return undefined;
	}
}

/** 目录型产物：须不存在；`--force` 只清本命令族的旧产物（含 `kind` 为 gtrk.media.* 的 index.json）。 */
export function prepareOutDir(out: string, force: boolean | undefined): void {
	if (!existsSync(out)) return;
	const own = statSync(out).isDirectory() && (readKind(join(out, "index.json")) ?? "").startsWith(MEDIA_KIND_PREFIX);
	if (!force) throw new Error(`落点已存在：${out}（换个名字；若是本命令之前的产物，加 --force 覆盖）`);
	if (!own) throw new Error(`拒绝覆盖：${out} 不是 gtrk media 的产物目录（缺少本命令族的 index.json）——--force 只覆盖自家旧产物`);
	rmSync(out, { recursive: true, force: true });
}

/** 文件型产物：扩展名须在白名单；须不存在，`--force` 只覆盖同类产物。 */
export function prepareOutFile(out: string, force: boolean | undefined, exts: readonly string[], kind?: string): void {
	const ext = extname(out).toLowerCase();
	if (!exts.includes(ext)) throw new Error(`落点扩展名须是 ${exts.join(" / ")}，得到「${ext || "（无）"}」`);
	if (!existsSync(out)) {
		mkdirSync(dirname(out), { recursive: true });
		return;
	}
	if (!force) throw new Error(`落点已存在：${out}（换个名字；若是本命令之前的产物，加 --force 覆盖）`);
	if (!statSync(out).isFile()) throw new Error(`拒绝覆盖：${out} 是目录`);
	if (kind && readKind(out) !== kind) throw new Error(`拒绝覆盖：${out} 不是 gtrk media 的同类产物——--force 只覆盖自家旧产物`);
}

function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-media-"));
	return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** 目录型产物：首次写入时创建、直写；失败整目录回收（不留半成品）。 */
export async function writeIntoNewDir<T>(out: string, fn: () => Promise<T>): Promise<T> {
	mkdirSync(out, { recursive: true });
	try {
		return await fn();
	} catch (e) {
		rmSync(out, { recursive: true, force: true });
		throw e;
	}
}

function emit(result: unknown, json: boolean | undefined): void {
	if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
}

// ───────────────────────────── 标签与拼页 ─────────────────────────────

export interface CellMeta {
	/** 页内格序（左上起、先行后列，从 0 起）。 */
	cell?: number;
	at: number;
	requested?: number;
	frame?: number;
	state?: FrameWords["state"];
	utterance?: string;
	word?: string;
	word_st?: number;
	word_ed?: number;
}

function describeFrame(at: number, t: TimedTranscript | undefined, cellWidth: number, extra: { requested?: number; frame?: number }): { lines: LabelLine[]; meta: CellMeta } {
	const meta: CellMeta = { at, ...extra };
	if (!t) return { lines: buildFrameLabel({ at, frameNo: extra.frame }, cellWidth), meta };
	const fw = wordsAt(t, at);
	const context = sentenceContext(t, fw);
	meta.state = fw.state;
	if (fw.utterance) meta.utterance = fw.utterance.id;
	if (fw.state === "word") {
		meta.word = fw.active.map((w) => w.text).join("");
		meta.word_st = Math.min(...fw.active.map((w) => w.start as number));
		meta.word_ed = Math.max(...fw.active.map((w) => w.end as number));
	}
	return { lines: buildFrameLabel({ at, frameNo: extra.frame, words: fw, context }, cellWidth), meta };
}

interface Frame {
	path: string;
	at: number;
	requested?: number;
	frame?: number;
}

/** 格内画面高：按显示尺寸（已计入像素宽高比与旋转——ffmpeg 解码时自动转正）等比，取偶数。 */
export function pictureHeight(probe: Pick<MediaProbe, "width" | "height">, cellWidth: number): number {
	return Math.max(2, Math.round((cellWidth * probe.height) / probe.width / 2) * 2);
}

interface ComposeResult {
	file: string;
	page: number;
	cells: CellMeta[];
}

/** 把一串帧按页拼成带标签网格。`fileFor(page, pages)` 给出每页落点；格序 = 入参顺序。 */
async function composeGrids(
	ctx: VideoCtx,
	frames: readonly Frame[],
	layout: { cols: number; perPage: number; cell: number },
	work: string,
	fileFor: (page: number, pages: number) => string,
): Promise<ComposeResult[]> {
	if (!frames.length) return [];
	const font = pickLabelFont();
	const picH = pictureHeight(ctx.probe, layout.cell);
	const described = frames.map((f) => describeFrame(f.at, ctx.transcript, layout.cell, { requested: f.requested, frame: f.frame }));
	const pages = paginateCount(frames.length, layout.perPage);
	const out: ComposeResult[] = [];
	for (const p of pages) {
		const slice = described.slice(p.from, p.to);
		const maxLines = Math.max(1, ...slice.map((d) => d.lines.length));
		const geom = pageGeometry(slice.length, layout.cols, layout.cell, picH, labelBandHeight(maxLines, layout.cell));
		const file = fileFor(p.page, pages.length);
		await renderPage(ctx.ffmpeg, {
			frames: frames.slice(p.from, p.to).map((f) => f.path),
			cols: geom.cols,
			rows: geom.rows,
			cellWidth: layout.cell,
			pictureHeight: picH,
			labelHeight: geom.labelHeight,
			ass: buildPageAss(geom, slice.map((d) => d.lines), font),
			workDir: join(work, `page-${p.page}`),
			out: file,
		});
		out.push({ file, page: p.page, cells: slice.map((d, k) => ({ cell: k, ...d.meta })) });
	}
	return out;
}

function cellWidthFor(opts: MediaOpts, probe: MediaProbe): number {
	return num(opts.cell, "--cell", { int: true, min: 80, max: 3840 }) ?? Math.max(80, Math.min(DEFAULT_CELL, probe.width));
}

/** 采样取帧（并发、按序命名）；报告落在同一帧上的重复采样（采样间隔小于帧间隔）。 */
async function sampleFrames(ctx: VideoCtx, times: readonly number[], dir: string, width?: number): Promise<Frame[]> {
	mkdirSync(dir, { recursive: true });
	const items = times.map((at, i) => ({ at, out: join(dir, `${String(i).padStart(6, "0")}.jpg`) }));
	const batches: Array<typeof items> = [];
	for (let i = 0; i < items.length; i += FRAMES_PER_PROCESS) batches.push(items.slice(i, i + FRAMES_PER_PROCESS));
	const actual = (await mapPool(batches, EXTRACT_CONCURRENCY, (b) => extractFramesBatch(ctx.ffmpeg, ctx.src, b, width))).flat();
	let dup = 0;
	for (let i = 1; i < actual.length; i++) if (actual[i] === actual[i - 1]) dup++;
	if (dup) {
		const w = `${dup} 个采样落在与前一个相同的帧上（采样间隔小于帧间隔）——看逐帧请用 --every-frame`;
		ctx.warnings.push(w);
		log.warn(w);
	}
	return times.map((t, i) => ({ path: join(dir, `${String(i).padStart(6, "0")}.jpg`), at: actual[i], requested: t }));
}

export function assertEveryFrameBudget(ranges: readonly ResolvedRange[], probe: MediaProbe): void {
	const fps = Math.max(probe.fps, probe.avgFps ?? 0, 1);
	const est = ranges.reduce((s, r) => s + Math.ceil((r.end - r.start) * fps), 0);
	if (est > MAX_EVERY_FRAME) {
		throw new Error(
			`逐帧模式预计要解 ${est} 帧，超过单次上限 ${MAX_EVERY_FRAME}——逐帧是看一个动作的尺度：收窄区间（--around 配小 --padding），或分几次跑`,
		);
	}
}

function rangeJson(r: ResolvedRange, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...extra,
		start: r.start,
		end: r.end,
		...(r.around ? { around: r.around.phrase, occurrence: r.around.occurrence, matches: r.around.matches, utterance: r.around.utterance } : {}),
	};
}

/** 非 --ranges 的单区间采样：`--at` 与区间 / 密度选项互斥。 */
function resolveSingle(opts: MediaOpts, ctx: VideoCtx): { range: ResolvedRange; times?: number[] } {
	if (opts.at !== undefined) {
		for (const [k, v] of Object.entries({ "--start": opts.start, "--end": opts.end, "--around": opts.around, "--every": opts.every, "--frames": opts.frames, "--every-frame": opts.everyFrame })) {
			if (v !== undefined && v !== false) throw new Error(`--at 不能与 ${k} 同用`);
		}
		const times = parseAtList(opts.at, ctx.probe.duration);
		return { range: { start: times[0], end: times[times.length - 1] }, times };
	}
	const range = resolveRange(rangeSpecFromOpts(opts), ctx.probe.duration, ctx.transcript);
	if (opts.everyFrame) {
		if (opts.every !== undefined || opts.frames !== undefined) throw new Error("--every-frame 不能与 --every / --frames 同用");
		return { range };
	}
	const times = sampleRange(range, { every: num(opts.every, "--every", { min: 0.001 }), frames: num(opts.frames, "--frames", { int: true, min: 1 }) }, ctx.probe.duration);
	return { range, times };
}

// ───────────────────────────── 子命令 ─────────────────────────────

export async function runMediaProbe(input: string | undefined, opts: MediaOpts = {}): Promise<Record<string, unknown>> {
	const src = requireLocalFile(input, "媒体");
	const { ffprobe } = requireFfmpeg(opts.ffmpegPath);
	const p = probeMedia(ffprobe, src);
	const result = { ok: true, mode: "probe", ...p };
	if (!opts.json) {
		log.info(src);
		log.info(
			p.hasVideo
				? `  ${p.duration}s  ${p.width}×${p.height}${p.rotation ? `（旋转 ${p.rotation}°）` : ""}  ${p.fps ? `${p.fps}fps` : "静帧"}${p.vfr ? `（VFR，平均 ${p.avgFps}fps）` : ""}  ${p.hasAudio ? "有音轨" : "无音轨"}${p.codec ? `  ${p.codec}` : ""}`
				: `  ${p.duration}s  仅音频`,
		);
	}
	return result;
}

export async function runMediaLines(input: string | undefined, opts: MediaOpts = {}): Promise<Record<string, unknown>> {
	const path = requireLocalFile(input, "转写稿");
	const t = await loadTranscriptFile(path);
	if (opts.find !== undefined) {
		const matches = findPhrase(t, opts.find).map((m) => {
			const u = t.utterances.find((x) => x.id === m.utterance);
			return { occurrence: m.occurrence, start: r3(m.start), end: r3(m.end), utterance: m.utterance, text: u?.text ?? "" };
		});
		if (!opts.json) {
			log.info(`「${opts.find}」共 ${matches.length} 处`);
			for (const m of matches) log.info(`  #${m.occurrence}  ${m.start.toFixed(3)}–${m.end.toFixed(3)}s  ${m.utterance}  ${m.text}`);
		}
		return { ok: true, mode: "lines", transcript: path, format: t.format, find: opts.find, matches };
	}
	const start = opts.start !== undefined ? parseTime(opts.start, "--start") : 0;
	const end = opts.end !== undefined ? parseTime(opts.end, "--end") : Infinity;
	const list = utterancesIn(t, start, end).map((u) => ({
		id: u.id,
		st: u.st,
		ed: u.ed,
		text: u.text,
		word_level: u.wordLevel,
	}));
	if (!opts.json) {
		for (const u of list) {
			const span = `${u.st?.toFixed(3) ?? "?"}–${u.ed?.toFixed(3) ?? "?"}`;
			log.info(`${u.id.padEnd(5)} ${span.padEnd(17)} ${u.text}`);
		}
		log.info(`共 ${list.length} 句（${t.format}${list.some((u) => !u.word_level) ? "；部分句仅句级时码" : ""}）`);
	}
	return { ok: true, mode: "lines", transcript: path, format: t.format, utterances: list };
}

export async function runMediaFrames(input: string | undefined, opts: MediaOpts = {}): Promise<Record<string, unknown>> {
	const out = requireOut("frames", opts.out);
	if (opts.at === undefined && opts.every === undefined && opts.frames === undefined && !opts.everyFrame) {
		throw new Error("gtrk media frames 须指定 --at / --every / --frames / --every-frame 之一");
	}
	const ctx = await openVideo(input, opts);
	const labeled = Boolean(opts.label || ctx.transcript);
	if (labeled) assertGridFilters(ctx.ffmpeg);
	const { range, times } = resolveSingle(opts, ctx);
	if (opts.everyFrame) assertEveryFrameBudget([range], ctx.probe);
	prepareOutDir(out, opts.force);
	// 单帧缺省保留源分辨率；带标签时格宽 = 源显示宽（标签字号随之放大）
	const cell = opts.cell !== undefined ? cellWidthFor(opts, ctx.probe) : labeled ? ctx.probe.width : undefined;

	log.step(`▶ 取帧：${basename(ctx.src)} ${range.start}–${range.end}s${opts.everyFrame ? "（逐帧）" : `（${times?.length} 个时刻）`}`);
	const result = await withTemp(async (work) => {
		const frames: Frame[] = opts.everyFrame
			? (await decodeInterval(ctx.ffmpeg, ctx.src, range.start, range.end, join(work, "decoded"), cell)).map((f, i) => ({ ...f, frame: i }))
			: await sampleFrames(ctx, times as number[], join(work, "sampled"), cell);
		const names = frames.map((f, i) => `${String(i + 1).padStart(4, "0")}-${secondsStem(f.at)}.jpg`);
		return writeIntoNewDir(out, async () => {
			const written: Array<CellMeta & { file: string }> = [];
			if (labeled) {
				// 一帧一页：标签带在画面下方，不遮原片字幕与图形
				const pages = await composeGrids(ctx, frames, { cols: 1, perPage: 1, cell: cell as number }, join(work, "labeled"), (page) => join(out, names[page - 1]));
				for (const [i, p] of pages.entries()) written.push({ file: names[i], ...p.cells[0] });
			} else {
				for (const [i, f] of frames.entries()) {
					writeFileSync(join(out, names[i]), readFileSync(f.path));
					written.push({ file: names[i], at: f.at, ...(f.requested !== undefined ? { requested: f.requested } : {}), ...(f.frame !== undefined ? { frame: f.frame } : {}) });
				}
			}
			const index = {
				kind: `${MEDIA_KIND_PREFIX}frames`,
				version: 1,
				source: ctx.src,
				transcript: ctx.transcriptPath ?? null,
				mode: opts.everyFrame ? "every-frame" : "sampled",
				labeled,
				range: rangeJson(range),
				frames: written,
			};
			writeFileSync(join(out, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
			return written;
		});
	});
	log.ok(`${result.length} 帧${labeled ? "（带标签）" : ""} → ${out}`);
	return {
		ok: true,
		mode: "frames",
		out,
		index: join(out, "index.json"),
		labeled,
		range: rangeJson(range),
		frames: result.map((f) => ({ path: join(out, f.file), at: f.at, ...(f.frame !== undefined ? { frame: f.frame } : {}) })),
		warnings: ctx.warnings,
	};
}

export async function runMediaTile(input: string | undefined, opts: MediaOpts = {}): Promise<Record<string, unknown>> {
	const out = requireOut("tile", opts.out);
	if (opts.everyFrame) throw new Error("tile 不做逐帧——逐帧会超出一张图的可读量，请用 tiles --every-frame 分页");
	const ctx = await openVideo(input, opts);
	assertGridFilters(ctx.ffmpeg);
	const { range, times } = resolveSingle(opts, ctx);
	const samples = times as number[];
	if (samples.length > MAX_TILE_CELLS) {
		throw new Error(`一张网格最多 ${MAX_TILE_CELLS} 格，本次 ${samples.length} 个时刻——用 gtrk media tiles 分页，或调大 --every / 调小 --frames`);
	}
	prepareOutFile(out, opts.force, [".jpg", ".jpeg", ".png"]);
	const cell = cellWidthFor(opts, ctx.probe);
	const cols = num(opts.cols, "--cols", { int: true, min: 1, max: 20 }) ?? DEFAULT_COLS;

	log.step(`▶ 网格：${basename(ctx.src)} ${range.start}–${range.end}s，${samples.length} 格`);
	const page = await withTemp(async (work) => {
		const frames = await sampleFrames(ctx, samples, join(work, "sampled"), cell);
		try {
			const [p] = await composeGrids(ctx, frames, { cols, perPage: frames.length, cell }, work, () => out);
			return p;
		} catch (e) {
			rmSync(out, { force: true });
			throw e;
		}
	});
	log.ok(`${page.cells.length} 格 → ${out}`);
	return {
		ok: true,
		mode: "tile",
		out,
		range: rangeJson(range),
		cols: Math.min(cols, page.cells.length),
		cell_width: cell,
		cells: page.cells,
		warnings: ctx.warnings,
	};
}

export async function runMediaTiles(input: string | undefined, opts: MediaOpts = {}): Promise<Record<string, unknown>> {
	const out = requireOut("tiles", opts.out);
	const ctx = await openVideo(input, opts);
	assertGridFilters(ctx.ffmpeg);
	const cell = cellWidthFor(opts, ctx.probe);
	const cols = num(opts.cols, "--cols", { int: true, min: 1, max: 20 }) ?? DEFAULT_COLS;
	const rows = num(opts.rows, "--rows", { int: true, min: 1, max: 20 }) ?? DEFAULT_ROWS;

	type Planned = { index: number; id?: string; range: ResolvedRange; times?: number[] };
	let planned: Planned[];
	if (opts.ranges !== undefined) {
		for (const [k, v] of Object.entries({ "--start": opts.start, "--end": opts.end, "--around": opts.around, "--at": opts.at, "--occurrence": opts.occurrence, "--padding": opts.padding })) {
			if (v !== undefined) throw new Error(`--ranges 不能与 ${k} 同用（区间写在文件里）`);
		}
		if (opts.everyFrame && (opts.every !== undefined || opts.frames !== undefined)) throw new Error("--every-frame 不能与 --every / --frames 同用");
		const entries: RangeEntry[] = parseRangesFile(await readJson(requireLocalFile(opts.ranges, "区间文件"), "区间文件"), Boolean(opts.everyFrame));
		const every = num(opts.every, "--every", { min: 0.001 });
		const frames = num(opts.frames, "--frames", { int: true, min: 1 });
		planned = entries.map((e, i) => {
			const range = resolveRange(e.spec, ctx.probe.duration, ctx.transcript);
			if (opts.everyFrame) return { index: i, id: e.id, range };
			const density = e.every !== undefined || e.frames !== undefined ? { every: e.every, frames: e.frames } : { every, frames };
			return { index: i, id: e.id, range, times: sampleRange(range, density, ctx.probe.duration) };
		});
	} else {
		const single = resolveSingle(opts, ctx);
		planned = [{ index: 0, range: single.range, times: single.times }];
	}
	if (opts.everyFrame) assertEveryFrameBudget(planned.map((p) => p.range), ctx.probe);
	prepareOutDir(out, opts.force);

	const total = opts.everyFrame ? "逐帧" : `${planned.reduce((s, p) => s + (p.times?.length ?? 0), 0)} 格`;
	log.step(`▶ 分页网格：${basename(ctx.src)}，${planned.length} 段，${total}，每页 ${cols}×${rows}`);
	const grids = await withTemp((work) =>
		writeIntoNewDir(out, async () => {
			const all: Array<ComposeResult & { range: number }> = [];
			for (const p of planned) {
				const frames: Frame[] = opts.everyFrame
					? (await decodeInterval(ctx.ffmpeg, ctx.src, p.range.start, p.range.end, join(work, `decoded-${p.index}`), cell)).map((f, i) => ({ ...f, frame: i }))
					: await sampleFrames(ctx, p.times as number[], join(work, `sampled-${p.index}`), cell);
				const stem = `${String(p.index + 1).padStart(3, "0")}-${p.id ?? `${secondsStem(p.range.start)}-${secondsStem(p.range.end)}`}`;
				const pages = await composeGrids(ctx, frames, { cols, perPage: cols * rows, cell }, join(work, `grid-${p.index}`), (page, n) =>
					join(out, `${stem}${n > 1 ? `-p${String(page).padStart(3, "0")}` : ""}.jpg`),
				);
				log.info(`  段 ${p.index + 1}：${p.range.start}–${p.range.end}s，${frames.length} 帧 → ${pages.length} 页`);
				all.push(...pages.map((g) => ({ ...g, range: p.index })));
			}
			const index = {
				kind: `${MEDIA_KIND_PREFIX}tiles`,
				version: 1,
				source: ctx.src,
				transcript: ctx.transcriptPath ?? null,
				mode: opts.everyFrame ? "every-frame" : "sampled",
				cols,
				rows,
				cell_width: cell,
				ranges: planned.map((p) => rangeJson(p.range, { index: p.index, ...(p.id ? { id: p.id } : {}) })),
				grids: all.map((g) => ({ file: relative(out, g.file).replace(/\\/g, "/"), range: g.range, page: g.page, cells: g.cells })),
			};
			writeFileSync(join(out, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
			return all;
		}),
	);
	log.ok(`${grids.length} 张网格 → ${out}`);
	return {
		ok: true,
		mode: "tiles",
		out,
		index: join(out, "index.json"),
		ranges: planned.map((p) => rangeJson(p.range, { index: p.index, ...(p.id ? { id: p.id } : {}) })),
		grids: grids.map((g) => ({ path: g.file, range: g.range, page: g.page, cells: g.cells.length, from: g.cells[0]?.at, to: g.cells[g.cells.length - 1]?.at })),
		warnings: ctx.warnings,
	};
}

export async function runMediaBoundaries(input: string | undefined, opts: MediaOpts = {}): Promise<Record<string, unknown>> {
	const ctx = await openVideo(input, opts);
	const range = resolveRange(rangeSpecFromOpts(opts), ctx.probe.duration, ctx.transcript);
	const rate = num(opts.rate, "--rate", { min: 0.1, max: 120 }) ?? DEFAULT_BOUNDARY_RATE;
	const threshold = num(opts.threshold, "--threshold", { min: 0, max: 1 }) ?? DEFAULT_BOUNDARY_THRESHOLD;
	const minGap = num(opts.minGap, "--min-gap", { min: 0 }) ?? 0;
	const outFile = opts.out ? resolve(opts.out) : undefined;
	if (outFile) prepareOutFile(outFile, opts.force, [".json"], `${MEDIA_KIND_PREFIX}boundaries`);

	log.step(`▶ 视觉变化候选：${basename(ctx.src)} ${range.start}–${range.end}s，${rate} 采样/秒，阈值 ${threshold}`);
	const scan = await scanBoundaries(ctx.ffmpeg, ctx.src, { start: range.start, end: range.end, rate, threshold });
	const merged = mergeCandidates(scan.candidates, minGap);
	const t = ctx.transcript;
	const candidates = merged.map((c) => {
		if (!t) return c;
		const fw = wordsAt(t, c.at);
		const u = fw.utterance;
		return {
			...c,
			state: fw.state,
			...(u && fw.state !== "gap" ? { utterance: u.id, text: u.text } : {}),
			...(fw.state === "word" ? { word: fw.active.map((w) => w.text).join("") } : {}),
			...(fw.state === "gap" ? { prev: fw.prev?.id, next: fw.next?.id } : {}),
		};
	});
	const span = range.end - range.start;
	const doc = {
		kind: `${MEDIA_KIND_PREFIX}boundaries`,
		version: 1,
		ok: true,
		mode: "boundaries",
		source: ctx.src,
		transcript: ctx.transcriptPath ?? null,
		range: rangeJson(range),
		rate,
		threshold,
		min_gap: minGap,
		samples: scan.samples,
		count: candidates.length,
		mean_gap: r3(span / (candidates.length + 1)),
		note: "视觉变化候选是机械证据（缩略画面相邻差），不是镜头 / 切点判定：渐变、闪白、大幅运动都会命中",
		candidates,
		warnings: ctx.warnings,
	};
	if (outFile) writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
	if (!opts.json) {
		log.info(`${candidates.length} 个视觉变化候选（平均约 ${doc.mean_gap}s 一个；分数不是镜头判定）`);
		for (const c of candidates.slice(0, 40)) {
			const ann =
				"utterance" in c
					? `  ${c.utterance}${"word" in c && c.word ? `「${c.word}」` : ""} ${String(c.text).slice(0, 24)}`
					: "state" in c && c.state === "gap"
						? `  （句间空隙 ${"prev" in c && c.prev ? c.prev : "片头"} → ${"next" in c && c.next ? c.next : "片尾"}）`
						: "";
			log.info(`  ${c.at.toFixed(3)}s  ${formatClock(c.at)}  score ${c.score}${ann}`);
		}
		if (candidates.length > 40) log.info(`  … 还有 ${candidates.length - 40} 个${outFile ? `，全量见 ${outFile}` : "（--json 或 -o <file.json> 取全量）"}`);
	}
	return outFile ? { ...doc, out: outFile } : doc;
}

export async function runMediaCut(input: string | undefined, opts: MediaOpts = {}): Promise<Record<string, unknown>> {
	const out = requireOut("cut", opts.out);
	const ctx = await openVideo(input, opts);
	const range = resolveRange(rangeSpecFromOpts(opts), ctx.probe.duration, ctx.transcript);
	prepareOutFile(out, opts.force, [".mp4", ".mov", ".mkv"]);
	log.step(`▶ 截证据片：${basename(ctx.src)} ${range.start}–${range.end}s`);
	try {
		await cutClip(ctx.ffmpeg, ctx.src, range.start, range.end, out);
	} catch (e) {
		rmSync(out, { force: true });
		throw e;
	}
	log.ok(`${r3(range.end - range.start)}s → ${out}`);
	return { ok: true, mode: "cut", out, range: rangeJson(range), seconds: r3(range.end - range.start), warnings: ctx.warnings };
}

// ───────────────────────────── 注册 ─────────────────────────────

const RUNNERS: Record<MediaSub, (input: string | undefined, opts: MediaOpts) => Promise<Record<string, unknown>>> = {
	probe: runMediaProbe,
	lines: runMediaLines,
	frames: runMediaFrames,
	tile: runMediaTile,
	tiles: runMediaTiles,
	boundaries: runMediaBoundaries,
	cut: runMediaCut,
};

export async function runMedia(words: readonly string[] | undefined, opts: MediaOpts): Promise<Record<string, unknown>> {
	if (opts.json) routeLogsToStderr();
	const [sub, input, ...rest] = words ?? [];
	if (!sub || !(MEDIA_SUBCOMMANDS as readonly string[]).includes(sub)) {
		throw new Error(`用法：gtrk media <${MEDIA_SUBCOMMANDS.join("|")}> <输入> [选项]${sub ? `（不认识的子命令「${sub}」）` : ""}`);
	}
	if (rest.length) throw new Error(`gtrk media ${sub} 只接受一个输入，多出：${rest.join(" ")}`);
	const result = await RUNNERS[sub as MediaSub](input, opts);
	emit(result, opts.json);
	return result;
}

export function registerMedia(program: Command): void {
	program
		.command("media [words...]")
		.description(
			"本地看片工具族（纯本地、零计费、不联网）：probe / lines / frames / tile / tiles / boundaries / cut——按时码或台词取帧、拼带台词标签的网格、逐帧看动效、找视觉变化候选；参考片精读（/gtrk-ref-reading）的取证工具",
		)
		.option("--transcript <json>", "台词标注与定位：gtrk transcript --json 的产物（v1），兼容 hypit.transcript@1；须是这条视频的转写稿")
		.option("--start <t>", "区间起点：秒（83.4）或时码（1:23.4 / 00:01:23.400），缺省 0")
		.option("--end <t>", "区间终点，缺省片尾")
		.option("--around <台词>", "按台词定位区间（须配 --transcript；与 --start/--end 互斥；多处出现须配 --occurrence）")
		.option("--occurrence <n>", "台词多处出现时取第几处（从 1 起；gtrk media lines --find 可先列出）")
		.option("--padding <s>", "--around 区间两侧各加的秒数（缺省 0.3）")
		.option("--at <t,t,…>", "[frames/tile/tiles] 指定时刻列表（严格递增）")
		.option("--every <s>", "[frames/tile/tiles] 从起点起每隔 s 秒一帧（不含终点）")
		.option("--frames <n>", "[frames/tile/tiles] 区间均分 n 段、各取中点（缺省概览密度：每秒 1.5 帧，4–9 帧）")
		.option("--every-frame", "[frames/tiles] 每段连续解码一次、保留每一原始帧（看动效用；单次上限 1800 帧）")
		.option("--ranges <json>", "[tiles] 多区间文件：[{id?, start, end} | {id?, around, occurrence?, padding?}]，各项可带 frames / every")
		.option("--label", "[frames] 没有 --transcript 时也在帧下方加时码标签")
		.option("--cell <px>", "[frames/tile/tiles] 格宽像素（缺省 min(480, 源宽)）")
		.option("--cols <n>", "[tile/tiles] 列数（缺省 3）")
		.option("--rows <n>", "[tiles] 每页行数（缺省 3）")
		.option("--find <台词>", "[lines] 列出该台词每处出现的序号、起止秒与所在句")
		.option("--rate <n>", "[boundaries] 每秒采样数（缺省 12）")
		.option("--threshold <r>", "[boundaries] 变化分数阈值 0..1（缺省 0.1）")
		.option("--min-gap <s>", "[boundaries] 间距小于它的相邻候选并成分数最高的一个（缺省 0 = 不并）")
		.option("-o, --out <path>", "产物落点（必填）：frames/tiles 为新目录、tile 为 .jpg/.png、cut 为 .mp4/.mov/.mkv；boundaries 可选写 .json")
		.option("--force", "落点已是本命令族的旧产物时覆盖（其它已存在的路径一律拒绝）")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录（缺省 ~/.gitruck/ffmpeg → 系统 PATH）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[] | undefined, opts: MediaOpts) => {
			await runMedia(words, opts);
		});
}
