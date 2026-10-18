/**
 * 看片命令族的纯计算层（add-reference-video-reading · media-command spec）：
 * 时间解析、采样、区间（含按台词定位）、帧标签排版、整页 ASS、视觉变化点打分。零 IO。
 *
 * ## 标签为什么在这里排、交给 libass 画
 *
 * 标签是「字与画面对在一起」的唯一载体：时码、正在读的字、所在整句。错位或溢出到邻格，
 * 判读结论就会指向错误的时刻——比没有网格更有害（同 `contact-sheet.ts` 的纪律）。所以：
 *  · **一行一条 Dialogue、逐行 `\pos` 定位**，行高由这里定，不交给字体度量 ⇒ 标签带高度可预先算定；
 *  · **宽度按保守估算换行**（全角 1.0 字号、拉丁 0.6–0.9），宁可早换行，不可越界；
 *  · ASS 的 `PlayResX/Y` MUST 等于页面实际像素——不等时 libass 会整体缩放，所有坐标一起错。
 */
import type { FrameWords, SentenceContext, TimedTranscript } from "./media-transcript";
import { findPhrase } from "./media-transcript";
import { r3, sec2ms } from "./frame-domain";

// ───────────────────────────── 时间 ─────────────────────────────

/** 秒数或 `[hh:]mm:ss[.mmm]` → 秒。`label` 进报错。 */
export function parseTime(raw: unknown, label: string): number {
	if (typeof raw === "number") {
		if (Number.isFinite(raw) && raw >= 0) return raw;
		throw new Error(`${label} 须是非负秒数，得到 ${raw}`);
	}
	const s = String(raw ?? "").trim();
	if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
	const m = s.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
	if (m) {
		const h = Number(m[1] ?? 0);
		const min = Number(m[2]);
		const sec = Number(m[3]);
		if (sec < 60 && (m[1] === undefined || min < 60)) return h * 3600 + min * 60 + sec;
	}
	throw new Error(`${label} 须是秒数（如 83.4）或时码（如 1:23.4 / 00:01:23.400），得到「${s}」`);
}

/** 秒 → `HH:MM:SS.mmm`（毫秒四舍五入）。 */
export function formatClock(seconds: number): string {
	const ms = Math.max(0, sec2ms(seconds));
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
}

/** 文件名里的秒：`123.9` → `123_900s`。 */
export function secondsStem(seconds: number): string {
	return `${seconds.toFixed(3).replace(".", "_")}s`;
}

// ───────────────────────────── 采样 ─────────────────────────────

/** 不给 `--every/--frames` 时的概览密度（同 hypit）：每秒 1.5 帧，夹在 4–9 帧之间。调用方要看快变化时自己加密。 */
export function defaultFrameCount(seconds: number): number {
	return Math.min(9, Math.max(4, Math.round(seconds * 1.5)));
}

/** 区间均分 n 段、取各段中点（两端不贴边，避免取到区间外的转场帧）。 */
export function evenSamples(start: number, end: number, n: number): number[] {
	if (!(end > start)) throw new Error(`区间须终点晚于起点（${start}–${end}）`);
	if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--frames 须是 ≥1 的整数，得到 ${n}`);
	return Array.from({ length: n }, (_, i) => r3(start + ((i + 0.5) * (end - start)) / n));
}

/** 从起点起每隔 `every` 秒一帧，不含终点。 */
export function intervalSamples(start: number, end: number, every: number): number[] {
	if (!(end > start)) throw new Error(`区间须终点晚于起点（${start}–${end}）`);
	if (!(Number.isFinite(every) && every >= 0.001)) throw new Error(`--every 须 ≥ 0.001 秒，得到 ${every}`);
	const n = Math.ceil((end - start) / every);
	return Array.from({ length: n }, (_, i) => r3(start + i * every)).filter((t) => t < end);
}

/** `--at` 列表：逗号分隔的秒或时码，严格递增，且早于片尾。 */
export function parseAtList(raw: string, duration: number): number[] {
	const parts = String(raw).split(",").map((s) => s.trim());
	if (!parts.length || parts.some((p) => !p)) throw new Error(`--at 须是逗号分隔的时刻列表，得到「${raw}」`);
	const times = parts.map((p) => r3(parseTime(p, "--at")));
	assertSampleTimes(times, duration, "--at");
	return times;
}

/** 采样时刻须严格递增（毫秒级去重后）且早于片尾。 */
export function assertSampleTimes(times: readonly number[], duration: number, label: string): void {
	if (!times.length) throw new Error(`${label}：区间内没有采样点`);
	for (const [i, t] of times.entries()) {
		if (t >= duration) throw new Error(`${label}：时刻 ${t}s 不早于片尾（${duration}s）`);
		if (i > 0 && !(t > times[i - 1])) throw new Error(`${label}：采样时刻须严格递增（精确到毫秒），${times[i - 1]} → ${t}`);
	}
}

// ───────────────────────────── 区间 ─────────────────────────────

export interface RangeSpec {
	start?: number;
	end?: number;
	around?: string;
	occurrence?: number;
	padding?: number;
}

export interface ResolvedRange {
	start: number;
	end: number;
	/** 区间来源：秒，或台词（含命中处的字级起止）。 */
	around?: { phrase: string; occurrence: number; matches: number; start: number; end: number; utterance: string };
}

export const DEFAULT_PADDING = 0.3;

/** 区间解析：`around` 与 `start/end` 互斥；台词多处命中且没给 `occurrence` ⇒ 报错列出每处（MUST NOT 默认取第一处）。 */
export function resolveRange(spec: RangeSpec, duration: number, transcript?: TimedTranscript): ResolvedRange {
	if (spec.around !== undefined) {
		if (spec.start !== undefined || spec.end !== undefined) throw new Error("--around 与 --start/--end 只能二选一");
		if (!transcript) throw new Error("--around 须配 --transcript（按台词定位要字级时码）");
		const matches = findPhrase(transcript, spec.around);
		if (!matches.length) throw new Error(`转写稿里找不到台词「${spec.around}」（忽略标点空白大小写后仍无命中）`);
		if (matches.length > 1 && spec.occurrence === undefined) {
			const list = matches.map((m) => `${m.occurrence}: ${r3(m.start)}–${r3(m.end)}s（${m.utterance}）`).join("；");
			throw new Error(`台词「${spec.around}」出现 ${matches.length} 次：${list}。用 --occurrence <n> 选一处，或改用 --start/--end`);
		}
		const occurrence = spec.occurrence ?? 1;
		const m = matches[occurrence - 1];
		if (!m) throw new Error(`--occurrence ${occurrence} 超出台词「${spec.around}」的 ${matches.length} 处命中`);
		const pad = spec.padding ?? DEFAULT_PADDING;
		if (!(Number.isFinite(pad) && pad >= 0)) throw new Error(`--padding 须是非负秒数，得到 ${pad}`);
		const start = Math.max(0, r3(m.start - pad));
		const end = Math.min(r3(duration), r3(m.end + pad));
		if (!(end > start)) throw new Error(`台词「${spec.around}」落在视频之外——确认 --transcript 是这条视频的转写稿`);
		return {
			start,
			end,
			around: { phrase: spec.around, occurrence, matches: matches.length, start: m.start, end: m.end, utterance: m.utterance },
		};
	}
	if (spec.occurrence !== undefined || spec.padding !== undefined) throw new Error("--occurrence / --padding 只配 --around 用");
	const start = spec.start ?? 0;
	const end = spec.end ?? duration;
	if (!(start >= 0 && end > start)) throw new Error(`区间须满足 0 ≤ 起点 < 终点，得到 ${start}–${end}`);
	if (end > duration + 0.001) throw new Error(`区间终点 ${end}s 超出片长 ${duration}s`);
	return { start: r3(start), end: r3(Math.min(end, duration)) };
}

export interface RangeEntry {
	id?: string;
	spec: RangeSpec;
	frames?: number;
	every?: number;
}

const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,59}$/u;

/** `--ranges` 文件内容校验。逐帧模式下各项不得带 frames / every（每一帧都要，没有采样可选）。 */
export function parseRangesFile(raw: unknown, everyFrame: boolean): RangeEntry[] {
	if (!Array.isArray(raw) || raw.length === 0) throw new Error("--ranges 须是非空 JSON 数组");
	const out: RangeEntry[] = [];
	const ids = new Set<string>();
	for (const [i, item] of raw.entries()) {
		const at = `--ranges 第 ${i + 1} 项`;
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${at} 须是对象`);
		const r = item as Record<string, unknown>;
		const known = new Set(["id", "start", "end", "around", "occurrence", "padding", "frames", "every"]);
		for (const k of Object.keys(r)) if (!known.has(k)) throw new Error(`${at} 有不认识的字段「${k}」`);
		let id: string | undefined;
		if (r.id !== undefined) {
			if (typeof r.id !== "string" || !SAFE_ID.test(r.id)) throw new Error(`${at} 的 id 须是安全文件名（字母 / 数字 / 汉字开头，可含 . _ -，≤60 字）`);
			if (ids.has(r.id)) throw new Error(`${at} 的 id「${r.id}」重复`);
			ids.add(r.id);
			id = r.id;
		}
		const spec: RangeSpec = {};
		if (r.start !== undefined) spec.start = parseTime(r.start, `${at}.start`);
		if (r.end !== undefined) spec.end = parseTime(r.end, `${at}.end`);
		if (r.around !== undefined) {
			if (typeof r.around !== "string" || !r.around.trim()) throw new Error(`${at}.around 须是非空台词`);
			spec.around = r.around;
		}
		if (r.occurrence !== undefined) {
			if (!Number.isSafeInteger(r.occurrence) || (r.occurrence as number) < 1) throw new Error(`${at}.occurrence 须是 ≥1 的整数`);
			spec.occurrence = r.occurrence as number;
		}
		if (r.padding !== undefined) spec.padding = parseTime(r.padding, `${at}.padding`);
		if (spec.around === undefined && (spec.start === undefined || spec.end === undefined)) {
			throw new Error(`${at} 须给 start + end，或给 around`);
		}
		const entry: RangeEntry = { spec, ...(id ? { id } : {}) };
		if (r.frames !== undefined) {
			if (!Number.isSafeInteger(r.frames) || (r.frames as number) < 1) throw new Error(`${at}.frames 须是 ≥1 的整数`);
			entry.frames = r.frames as number;
		}
		if (r.every !== undefined) {
			if (typeof r.every !== "number" || !(r.every >= 0.001)) throw new Error(`${at}.every 须 ≥ 0.001 秒`);
			entry.every = r.every;
		}
		if (entry.frames !== undefined && entry.every !== undefined) throw new Error(`${at} 的 frames 与 every 只能二选一`);
		if (everyFrame && (entry.frames !== undefined || entry.every !== undefined)) {
			throw new Error(`${at}：--every-frame 下不得再带 frames / every（每一帧都会保留）`);
		}
		out.push(entry);
	}
	return out;
}

/** 一个区间的采样时刻：every > frames > 缺省概览密度。 */
export function sampleRange(range: ResolvedRange, opts: { every?: number; frames?: number }, duration: number): number[] {
	if (opts.every !== undefined && opts.frames !== undefined) throw new Error("--every 与 --frames 只能二选一");
	const times =
		opts.every !== undefined
			? intervalSamples(range.start, range.end, opts.every)
			: evenSamples(range.start, range.end, opts.frames ?? defaultFrameCount(range.end - range.start));
	assertSampleTimes(times, duration, "采样");
	return times;
}

// ───────────────────────────── 标签排版 ─────────────────────────────

export type Tone = "meta" | "main" | "dim" | "ctx" | "hi";

export interface LabelSeg {
	text: string;
	tone: Tone;
}

export type LabelLine = LabelSeg[];

/** 格内标签的左右内边距 / 上下内边距（像素）。 */
export const LABEL_PAD_X = 8;
export const LABEL_PAD_Y = 6;
/** 整句上下文最多占几行。 */
export const CONTEXT_LINES = 2;

/** 标签字号（ASS 字号，≈ 行高）：跟格宽走，有下限。 */
export function labelFontSize(cellWidth: number): number {
	return Math.max(13, Math.round(cellWidth / 24));
}

/** 行高：ASS 字号已≈字体的上伸 + 下伸，留一点行距。 */
export function labelLineHeight(fontSize: number): number {
	return Math.round(fontSize * 1.2);
}

function isWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1faff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	);
}

/** 单字宽（以字号为 1）。偏保守：实测全角字宽约 0.9 字号，这里按 1.0 算。 */
export function charWidthEm(ch: string): number {
	const cp = ch.codePointAt(0) ?? 0;
	if (isWide(cp)) return 1;
	if (ch === " ") return 0.35;
	if ("MWmw@".includes(ch)) return 0.9;
	if (cp >= 0x41 && cp <= 0x5a) return 0.72;
	return 0.6;
}

export function textWidthEm(s: string): number {
	let w = 0;
	for (const ch of s) w += charWidthEm(ch);
	return w;
}

/** 断行原子：一个全角字、一串拉丁字母数字、一个空格、或其它单个字符。 */
function atoms(text: string): string[] {
	return text.match(/[A-Za-z0-9'’]+|\s|[\s\S]/gu) ?? [];
}

/**
 * 按宽度折行（贪心）。英文不在词中间断，单词本身超宽时才按字切；行首空格丢掉。
 * 同色相邻片段合并，输出可直接逐行生成 Dialogue。
 */
export function wrapSegments(segs: readonly LabelSeg[], maxEm: number): LabelLine[] {
	const lines: LabelLine[] = [];
	let line: LabelSeg[] = [];
	let width = 0;
	const push = (text: string, tone: Tone) => {
		const last = line[line.length - 1];
		if (last && last.tone === tone) last.text += text;
		else line.push({ text, tone });
	};
	const breakLine = () => {
		if (line.length) lines.push(line);
		line = [];
		width = 0;
	};
	for (const seg of segs) {
		for (const atom of atoms(seg.text)) {
			const w = textWidthEm(atom);
			if (/^\s$/.test(atom)) {
				if (width === 0) continue;
				if (width + w > maxEm) {
					breakLine();
					continue;
				}
				push(atom, seg.tone);
				width += w;
				continue;
			}
			if (width + w <= maxEm) {
				push(atom, seg.tone);
				width += w;
				continue;
			}
			if (w <= maxEm) {
				breakLine();
				push(atom, seg.tone);
				width = w;
				continue;
			}
			for (const ch of atom) {
				const cw = charWidthEm(ch);
				if (width + cw > maxEm && width > 0) breakLine();
				push(ch, seg.tone);
				width += cw;
			}
		}
	}
	breakLine();
	// 行尾空格不占位但会让人误以为有内容，去掉
	for (const l of lines) {
		const last = l[l.length - 1];
		if (last) last.text = last.text.replace(/\s+$/u, "");
	}
	return lines.filter((l) => l.some((s) => s.text.length));
}

/**
 * 整句上下文开窗：整句放得下就整句；放不下就以高亮字为中心向两侧对称扩，截断处补「…」；
 * 没有高亮（句间空隙 / 仅句级）就从句首取到放满为止。
 */
export function fitContext(ctx: SentenceContext, maxEm: number, maxLines = CONTEXT_LINES, prefix = ""): LabelSeg[] {
	const { chars } = ctx;
	const build = (lo: number, hi: number): LabelSeg[] => {
		const segs: LabelSeg[] = [];
		if (prefix) segs.push({ text: prefix, tone: "dim" });
		if (lo > 0) segs.push({ text: "…", tone: "ctx" });
		if (ctx.hiStart >= 0) {
			const a = Math.max(lo, Math.min(ctx.hiStart, hi));
			const b = Math.max(a, Math.min(ctx.hiEnd, hi));
			if (a > lo) segs.push({ text: chars.slice(lo, a).join(""), tone: "ctx" });
			if (b > a) segs.push({ text: chars.slice(a, b).join(""), tone: "hi" });
			if (hi > b) segs.push({ text: chars.slice(b, hi).join(""), tone: "ctx" });
		} else if (hi > lo) {
			segs.push({ text: chars.slice(lo, hi).join(""), tone: "ctx" });
		}
		if (hi < chars.length) segs.push({ text: "…", tone: "ctx" });
		return segs;
	};
	const fits = (lo: number, hi: number) => wrapSegments(build(lo, hi), maxEm).length <= maxLines;
	if (fits(0, chars.length)) return build(0, chars.length);

	let lo: number;
	let hi: number;
	if (ctx.hiStart >= 0) {
		lo = ctx.hiStart;
		hi = ctx.hiEnd;
		// 高亮本身就放不下（超长英文词组）：从高亮起点往后截
		while (hi > lo + 1 && !fits(lo, hi)) hi -= 1;
		let grew = true;
		while (grew) {
			grew = false;
			if (lo > 0 && fits(lo - 1, hi)) {
				lo -= 1;
				grew = true;
			}
			if (hi < chars.length && fits(lo, hi + 1)) {
				hi += 1;
				grew = true;
			}
		}
	} else {
		lo = 0;
		hi = 0;
		while (hi < chars.length && fits(0, hi + 1)) hi += 1;
	}
	return build(lo, hi);
}

export interface FrameLabelInput {
	/** 源片真实时间（秒）。 */
	at: number;
	/** 逐帧模式下区间内帧号（从 0 起）。 */
	frameNo?: number;
	/** 带转写稿时：此刻在读什么 + 所在句。 */
	words?: FrameWords;
	context?: SentenceContext;
}

/** 一帧的标签行：时码行 / 当前字行 / 所在整句（≤2 行）。不带转写稿时只有时码行。 */
export function buildFrameLabel(input: FrameLabelInput, cellWidth: number): LabelLine[] {
	const fs = labelFontSize(cellWidth);
	const maxEm = (cellWidth - 2 * LABEL_PAD_X) / fs;
	const u = input.words?.utterance;
	const head: LabelSeg[] = [{ text: `${input.at.toFixed(3)}s · ${formatClock(input.at)}`, tone: "meta" }];
	if (input.frameNo !== undefined) head.push({ text: ` · 帧#${input.frameNo}`, tone: "meta" });
	if (input.words && u && input.words.state !== "gap") head.push({ text: ` · ${u.id}`, tone: "dim" });
	const lines = wrapSegments(head, maxEm);
	const fw = input.words;
	if (!fw) return lines;

	const second: LabelSeg[] = [];
	switch (fw.state) {
		case "word": {
			const ws = fw.active;
			const st = Math.min(...ws.map((w) => w.start as number));
			const ed = Math.max(...ws.map((w) => w.end as number));
			second.push({ text: `「${ws.map((w) => w.text).join("")}」`, tone: "hi" });
			second.push({ text: ` ${st.toFixed(3)}–${ed.toFixed(3)}s`, tone: "dim" });
			break;
		}
		case "sentence-only":
			second.push({ text: `（仅句级时码 ${u?.st?.toFixed(3) ?? "?"}–${u?.ed?.toFixed(3) ?? "?"}s）`, tone: "dim" });
			break;
		case "between-words":
			second.push({ text: "—（此刻无字在读）", tone: "dim" });
			break;
		case "gap": {
			const parts = [fw.prev ? `上句 ${fw.prev.id}` : "", fw.next ? `下句 ${fw.next.id}` : ""].filter(Boolean).join(" · ");
			second.push({ text: `—（句间空隙${parts ? ` · ${parts}` : ""}）`, tone: "dim" });
			break;
		}
		default:
			second.push({ text: "—（转写稿此处无时码）", tone: "dim" });
	}
	lines.push(...wrapSegments(second, maxEm));
	if (input.context && input.context.chars.length) {
		const prefix = fw.state === "gap" ? (fw.nearest === "prev" ? "上句：" : "下句：") : "";
		lines.push(...wrapSegments(fitContext(input.context, maxEm, CONTEXT_LINES, prefix), maxEm).slice(0, CONTEXT_LINES));
	}
	return lines;
}

/** 标签带高度（像素）：行数 × 行高 + 上下内边距。 */
export function labelBandHeight(lineCount: number, cellWidth: number): number {
	return lineCount * labelLineHeight(labelFontSize(cellWidth)) + 2 * LABEL_PAD_Y;
}

// ───────────────────────────── 页面几何与 ASS ─────────────────────────────

/** 与 ffmpeg `tile=…:margin=8:padding=8` 一致：外边距 / 格间距。 */
export const GRID_MARGIN = 8;
export const GRID_PADDING = 8;

export interface PageGeometry {
	cols: number;
	rows: number;
	cellWidth: number;
	pictureHeight: number;
	labelHeight: number;
	width: number;
	height: number;
}

export function pageGeometry(cells: number, cols: number, cellWidth: number, pictureHeight: number, labelHeight: number): PageGeometry {
	const c = Math.max(1, Math.min(cols, cells));
	const rows = Math.max(1, Math.ceil(cells / c));
	const cellH = pictureHeight + labelHeight;
	return {
		cols: c,
		rows,
		cellWidth,
		pictureHeight,
		labelHeight,
		width: 2 * GRID_MARGIN + c * cellWidth + (c - 1) * GRID_PADDING,
		height: 2 * GRID_MARGIN + rows * cellH + (rows - 1) * GRID_PADDING,
	};
}

/** 第 i 格（左上起、先行后列）左上角坐标。 */
export function cellOrigin(geom: PageGeometry, index: number): { x: number; y: number } {
	const col = index % geom.cols;
	const row = Math.floor(index / geom.cols);
	return {
		x: GRID_MARGIN + col * (geom.cellWidth + GRID_PADDING),
		y: GRID_MARGIN + row * (geom.pictureHeight + geom.labelHeight + GRID_PADDING),
	};
}

/** ASS 颜色是 `&HBBGGRR&`。 */
const TONE_COLOR: Record<Tone, string> = {
	meta: "&HF5F5F5&",
	main: "&HF5F5F5&",
	dim: "&H9E9E9E&",
	ctx: "&HC8C8C8&",
	hi: "&H80DCFF&",
};

/** ASS 没有可靠的字面量转义：`\` `{` `}` 换成全角形，换行折成空格。 */
export function escapeAssText(s: string): string {
	return s.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/[\r\n]+/g, " ");
}

/** 一页的 ASS：每格标签逐行 `\an7\pos` 定位在画面下方的标签带里。 */
export function buildPageAss(geom: PageGeometry, labels: readonly LabelLine[][], fontFamily: string): string {
	const fs = labelFontSize(geom.cellWidth);
	const lh = labelLineHeight(fs);
	const head = [
		"[Script Info]",
		"ScriptType: v4.00+",
		`PlayResX: ${geom.width}`,
		`PlayResY: ${geom.height}`,
		"WrapStyle: 2",
		"ScaledBorderAndShadow: yes",
		"YCbCr Matrix: None",
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
		`Style: L,${fontFamily.replace(/,/g, " ")},${fs},&H00F5F5F5,&H00F5F5F5,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
	];
	const events: string[] = [];
	for (const [i, lines] of labels.entries()) {
		const o = cellOrigin(geom, i);
		for (const [li, line] of lines.entries()) {
			const x = o.x + LABEL_PAD_X;
			const y = o.y + geom.pictureHeight + LABEL_PAD_Y + li * lh;
			const body = line
				.map((s) => `{\\c${TONE_COLOR[s.tone]}\\b${s.tone === "hi" ? 1 : 0}}${escapeAssText(s.text)}`)
				.join("");
			events.push(`Dialogue: 0,0:00:00.00,9:59:59.00,L,,0,0,0,,{\\an7\\pos(${x},${y})}${body}`);
		}
	}
	return `${[...head, ...events].join("\n")}\n`;
}

/** 按页切：每页 cols×rows 格，顺序保持。 */
export function paginateCount(total: number, perPage: number): Array<{ page: number; from: number; to: number }> {
	const per = Math.max(1, Math.floor(perPage));
	const out: Array<{ page: number; from: number; to: number }> = [];
	for (let i = 0; i < total; i += per) out.push({ page: out.length + 1, from: i, to: Math.min(total, i + per) });
	return out;
}

// ───────────────────────────── 视觉变化点 ─────────────────────────────

export const BOUNDARY_SIDE = 32;
export const DEFAULT_BOUNDARY_RATE = 12;
export const DEFAULT_BOUNDARY_THRESHOLD = 0.1;

export interface BoundaryCandidate {
	at: number;
	score: number;
}

/**
 * 相邻采样的缩略画面差（同 hypit）：32×32 RGB，逐字节差的均值 / 255。≥ 阈值即候选。
 * **流式**：`push` 任意切块的原始字节流，只留上一帧——长片的原始流可达数百 MB，MUST NOT 整块读入。
 * 分数是机械证据：渐变、闪白、大幅运动都会命中，MUST NOT 当镜头 / 切点。
 */
export class BoundaryScorer {
	readonly candidates: BoundaryCandidate[] = [];
	frames = 0;
	private readonly frameBytes = BOUNDARY_SIDE * BOUNDARY_SIDE * 3;
	private prev: Uint8Array | null = null;
	private pending = new Uint8Array(0);

	constructor(
		private readonly rate: number,
		private readonly threshold: number,
		private readonly offset = 0,
	) {}

	push(chunk: Uint8Array): void {
		let buf = chunk;
		if (this.pending.length) {
			buf = new Uint8Array(this.pending.length + chunk.length);
			buf.set(this.pending);
			buf.set(chunk, this.pending.length);
		}
		let pos = 0;
		while (pos + this.frameBytes <= buf.length) {
			const frame = buf.slice(pos, pos + this.frameBytes);
			if (this.prev) {
				let total = 0;
				for (let k = 0; k < frame.length; k++) total += Math.abs(frame[k] - this.prev[k]);
				const score = total / frame.length / 255;
				if (score >= this.threshold) {
					this.candidates.push({ at: r3(this.offset + this.frames / this.rate), score: r3(score) });
				}
			}
			this.prev = frame;
			this.frames += 1;
			pos += this.frameBytes;
		}
		this.pending = buf.slice(pos);
	}
}

/** 把间距 < minGap 的相邻候选并成一簇，保留簇内分数最高者。minGap ≤ 0 不并。 */
export function mergeCandidates(cands: readonly BoundaryCandidate[], minGap: number): BoundaryCandidate[] {
	if (!(minGap > 0)) return [...cands];
	const out: BoundaryCandidate[] = [];
	let cluster: BoundaryCandidate | null = null;
	let lastAt = -Infinity;
	for (const c of cands) {
		if (cluster && c.at - lastAt < minGap) {
			if (c.score > cluster.score) cluster = c;
		} else {
			if (cluster) out.push(cluster);
			cluster = c;
		}
		lastAt = c.at;
	}
	if (cluster) out.push(cluster);
	return out;
}
