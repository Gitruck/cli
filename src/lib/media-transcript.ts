/**
 * 看片命令族的转写稿层（add-reference-video-reading · media-command spec）：读稿、按台词定位、某时刻在读什么。
 *
 * 纯函数 + 一个读盘入口（{@link loadTranscriptFile}），不碰 ffmpeg，便于离线单测。
 *
 * ## 认两种形态
 *
 *  · **gtrk transcript v1**（`gtrk transcript --json` 的产物，原生）：`utterances[]{id,text,st,ed,words[]{w,st,ed}}`；
 *  · **hypit.transcript@1**（兼容）：`passages[]{words[]{text,start_seconds?,end_seconds?}}`，一段当一句，句号 `p<n>`。
 *
 * 某句 `words` 为空（服务端落回句级、或 v1 早期产物）时**整句当作一个字**参与定位与标注，并标 `whole`，
 * 标签据此明示「仅句级时码」——MUST NOT 把句级时间摊成假字级。
 *
 * ## 定位为什么按字流找子串
 *
 * gtrk 的中文转写是**逐字**的（`w` 是单个汉字），没有词边界可言。hypit 的整词匹配在这里等价于逐字匹配，
 * 但它要求从词边界起止；这里把全部字归一后拼成一条字流、每个字符记回所属的字，直接找子串，
 * 起止取首字的 `start` 与末字的 `end`。代价：英文里 `cat` 会命中 `category`——多处命中时强制
 * `--occurrence` 兜住误选（MUST NOT 默认取第一处）。
 */
import { readJson } from "./read-json";

export type TranscriptFormat = "gtrk.transcript.v1" | "hypit.transcript@1";

export interface TimedWord {
	text: string;
	/** 源片秒；缺失即缺失，MUST NOT 补猜。 */
	start?: number;
	end?: number;
	/** 所属句在 `utterances` 中的下标。 */
	u: number;
	/** 句级回退：整句充当一个字。 */
	whole?: boolean;
}

export interface TimedUtterance {
	id: string;
	text: string;
	st?: number;
	ed?: number;
	/** 本句的字在 `words` 中的区间 [first, last)。 */
	first: number;
	last: number;
	/** 是否带字级时码（false = 整句一个「字」）。 */
	wordLevel: boolean;
}

export interface TimedTranscript {
	format: TranscriptFormat;
	/** gtrk v1 记录的源文件名（时钟一致性检查用）。 */
	source?: string;
	/** gtrk v1 记录的源时长（秒）。 */
	duration?: number;
	utterances: TimedUtterance[];
	words: TimedWord[];
}

function fail(label: string, msg: string): never {
	throw new Error(`${label}：${msg}`);
}

function optTime(v: unknown, label: string, what: string): number | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(label, `${what} 不是非负秒数（得到 ${JSON.stringify(v)}）`);
	return v;
}

const LATIN_EDGE = /[A-Za-z0-9]$/;
const LATIN_HEAD = /^[A-Za-z0-9]/;

/** 把字拼回句子：两侧都是拉丁字母 / 数字时补一个空格（英文按词、中文按字，混排两不误）。 */
export function joinWords(texts: readonly string[]): string {
	let out = "";
	for (const t of texts) {
		if (out && LATIN_EDGE.test(out) && LATIN_HEAD.test(t)) out += " ";
		out += t;
	}
	return out;
}

/** 解析转写稿对象（已 JSON.parse）。`label` 用于报错定位（通常是文件路径）。 */
export function parseTranscript(raw: unknown, label = "转写稿"): TimedTranscript {
	if (!raw || typeof raw !== "object") fail(label, "不是 JSON 对象");
	const doc = raw as Record<string, unknown>;
	const words: TimedWord[] = [];
	const utterances: TimedUtterance[] = [];

	if (doc.version === "v1" && Array.isArray(doc.utterances)) {
		for (const [i, item] of (doc.utterances as unknown[]).entries()) {
			if (!item || typeof item !== "object") fail(label, `utterances[${i}] 不是对象`);
			const u = item as Record<string, unknown>;
			const text = typeof u.text === "string" ? u.text.replace(/\s+/g, " ").trim() : "";
			const st = optTime(u.st, label, `utterances[${i}].st`);
			const ed = optTime(u.ed, label, `utterances[${i}].ed`);
			const id = typeof u.id === "string" && u.id ? u.id : `u${i + 1}`;
			const first = words.length;
			const list = Array.isArray(u.words) ? (u.words as unknown[]) : [];
			for (const [j, w] of list.entries()) {
				if (!w || typeof w !== "object" || typeof (w as { w?: unknown }).w !== "string") {
					fail(label, `utterances[${i}].words[${j}] 缺 w 文本`);
				}
				const ww = w as Record<string, unknown>;
				const ws = optTime(ww.st, label, `utterances[${i}].words[${j}].st`);
				const we = optTime(ww.ed, label, `utterances[${i}].words[${j}].ed`);
				if (ws !== undefined && we !== undefined && we < ws) fail(label, `utterances[${i}].words[${j}] 终点早于起点`);
				words.push({ text: String(ww.w), start: ws, end: we, u: utterances.length });
			}
			const wordLevel = words.length > first;
			if (!wordLevel && text) words.push({ text, start: st, end: ed, u: utterances.length, whole: true });
			utterances.push({ id, text, st, ed, first, last: words.length, wordLevel });
		}
		return {
			format: "gtrk.transcript.v1",
			source: typeof doc.source === "string" ? doc.source : undefined,
			duration: typeof doc.duration === "number" && Number.isFinite(doc.duration) ? doc.duration : undefined,
			utterances,
			words,
		};
	}

	if (doc.format === "hypit.transcript@1" && Array.isArray(doc.passages)) {
		for (const [i, item] of (doc.passages as unknown[]).entries()) {
			const list = item && typeof item === "object" ? (item as { words?: unknown }).words : undefined;
			if (!Array.isArray(list)) fail(label, `passages[${i}] 缺 words 数组`);
			const first = words.length;
			for (const [j, w] of (list as unknown[]).entries()) {
				if (!w || typeof w !== "object" || typeof (w as { text?: unknown }).text !== "string") {
					fail(label, `passages[${i}].words[${j}] 缺 text`);
				}
				const ww = w as Record<string, unknown>;
				const ws = optTime(ww.start_seconds, label, `passages[${i}].words[${j}].start_seconds`);
				const we = optTime(ww.end_seconds, label, `passages[${i}].words[${j}].end_seconds`);
				if (ws !== undefined && we !== undefined && we < ws) fail(label, `passages[${i}].words[${j}] 终点早于起点`);
				words.push({ text: String(ww.text), start: ws, end: we, u: utterances.length });
			}
			if (words.length === first) continue; // 空段没有任何可定位的东西
			const own = words.slice(first);
			const starts = own.map((w) => w.start).filter((v): v is number => v !== undefined);
			const ends = own.map((w) => w.end).filter((v): v is number => v !== undefined);
			utterances.push({
				id: `p${i + 1}`,
				text: joinWords(own.map((w) => w.text)),
				st: starts.length ? Math.min(...starts) : undefined,
				ed: ends.length ? Math.max(...ends) : undefined,
				first,
				last: words.length,
				wordLevel: true,
			});
		}
		return { format: "hypit.transcript@1", utterances, words };
	}

	fail(
		label,
		"认不出的转写稿形态。认得两种：gtrk transcript --json 的产物（version:\"v1\" + utterances[]），" +
			"或 hypit.transcript@1（format + passages[]）",
	);
}

/** 读盘 + 解析（剥 BOM、人话报错走 readJson）。 */
export async function loadTranscriptFile(path: string): Promise<TimedTranscript> {
	return parseTranscript(await readJson(path, "转写稿"), path);
}

/** 定位用归一：NFKC + 小写 + 去标点 / 空白（同 hypit；`$` 这类符号保留）。 */
export function searchable(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
}

export interface PhraseMatch {
	/** 第几处（从 1 起）。 */
	occurrence: number;
	start: number;
	end: number;
	/** 首字所在句号。 */
	utterance: string;
	firstWord: number;
	lastWord: number;
}

/** 在转写稿里找台词的每一处出现（不重叠，按时间序）。首末字缺时码 ⇒ 报错，让调用方改用 --start/--end。 */
export function findPhrase(t: TimedTranscript, phrase: string): PhraseMatch[] {
	const query = searchable(phrase);
	if (!query) throw new Error("--around / --find 需要至少一个字（去掉标点空白后为空）");
	let stream = "";
	const owner: number[] = [];
	for (const [i, w] of t.words.entries()) {
		const s = searchable(w.text);
		stream += s;
		for (let k = 0; k < s.length; k++) owner.push(i);
	}
	const out: PhraseMatch[] = [];
	let from = 0;
	for (;;) {
		const idx = stream.indexOf(query, from);
		if (idx < 0) break;
		const firstWord = owner[idx];
		const lastWord = owner[idx + query.length - 1];
		const start = t.words[firstWord].start;
		const end = t.words[lastWord].end;
		if (start === undefined || end === undefined) {
			throw new Error(`台词「${phrase}」第 ${out.length + 1} 处的首字或末字没有时码，请看它所在的句子后改用 --start/--end`);
		}
		out.push({
			occurrence: out.length + 1,
			start,
			end,
			utterance: t.utterances[t.words[firstWord].u]?.id ?? "?",
			firstWord,
			lastWord,
		});
		from = idx + query.length;
	}
	return out;
}

export type FrameWordState = "word" | "between-words" | "sentence-only" | "gap" | "none";

export interface FrameWords {
	state: FrameWordState;
	/** 此刻正在读的字（`state` 为 word / sentence-only 时非空）。 */
	active: TimedWord[];
	/** 所在句；句间空隙时为最近的一句。 */
	utterance?: TimedUtterance;
	/** 句间空隙时：最近一句在此刻之前（prev）还是之后（next）。 */
	nearest?: "prev" | "next";
	prev?: TimedUtterance;
	next?: TimedUtterance;
}

/** 某源片时刻在读什么。区间按左闭右开判定；**无字时如实给状态，不推断静音**。 */
export function wordsAt(t: TimedTranscript, at: number): FrameWords {
	const active = t.words.filter((w) => w.start !== undefined && w.end !== undefined && w.start <= at && at < w.end);
	if (active.length) {
		const utterance = t.utterances[active[0].u];
		return { state: active[0].whole ? "sentence-only" : "word", active, utterance };
	}
	const inside = t.utterances.find((u) => u.st !== undefined && u.ed !== undefined && u.st <= at && at < u.ed);
	if (inside) return { state: inside.wordLevel ? "between-words" : "sentence-only", active: [], utterance: inside };
	let prev: TimedUtterance | undefined;
	let next: TimedUtterance | undefined;
	for (const u of t.utterances) {
		if (u.ed !== undefined && u.ed <= at && (!prev || (prev.ed ?? -1) <= u.ed)) prev = u;
		if (u.st !== undefined && u.st > at && (!next || (next.st ?? Infinity) > u.st)) next = u;
	}
	if (!prev && !next) return { state: "none", active: [] };
	const dPrev = prev ? at - (prev.ed as number) : Infinity;
	const dNext = next ? (next.st as number) - at : Infinity;
	const nearest = dPrev <= dNext ? "prev" : "next";
	return { state: "gap", active: [], utterance: nearest === "prev" ? prev : next, nearest, prev, next };
}

export interface SentenceContext {
	/** 句子文本，按码点拆开（标签排版按码点算宽）。 */
	chars: string[];
	/** 高亮区间 [hiStart, hiEnd)（码点下标）；无高亮为 -1。 */
	hiStart: number;
	hiEnd: number;
}

/**
 * 所在整句 + 当前字的位置。
 *
 * 原句带标点、字流不带：按序 `indexOf` 把每个字对回原句；任何一个字对不上（归一差异、ASR 改写）
 * 就退回「用字拼句」——高亮位置宁可准，标点宁可丢。
 */
export function sentenceContext(t: TimedTranscript, fw: FrameWords): SentenceContext | undefined {
	const u = fw.utterance;
	if (!u) return undefined;
	const own = t.words.slice(u.first, u.last);
	const activeIdx = fw.active.filter((w) => !w.whole).map((w) => t.words.indexOf(w) - u.first).filter((i) => i >= 0);
	const noHi = (text: string): SentenceContext => ({ chars: Array.from(text), hiStart: -1, hiEnd: -1 });
	if (!u.wordLevel) return noHi(u.text);
	if (!activeIdx.length) return noHi(u.text || joinWords(own.map((w) => w.text)));

	const lo = Math.min(...activeIdx);
	const hi = Math.max(...activeIdx);
	const locate = (text: string): [number, number] | null => {
		let cursor = 0;
		const pos: number[] = [];
		for (const w of own) {
			const at = text.indexOf(w.text, cursor);
			if (at < 0) return null;
			pos.push(at);
			cursor = at + w.text.length;
		}
		return [pos[lo], pos[hi] + own[hi].text.length];
	};
	let text = u.text;
	let span = text ? locate(text) : null;
	if (!span) {
		text = joinWords(own.map((w) => w.text));
		span = locate(text);
	}
	if (!span) return noHi(text);
	const cp = (i: number) => Array.from(text.slice(0, i)).length;
	return { chars: Array.from(text), hiStart: cp(span[0]), hiEnd: cp(span[1]) };
}

/** 落在 [start, end) 内（有交叠即算）的句子，供 `lines` 列表。 */
export function utterancesIn(t: TimedTranscript, start = 0, end = Infinity): TimedUtterance[] {
	return t.utterances.filter((u) => {
		const s = u.st ?? u.ed;
		const e = u.ed ?? u.st;
		if (s === undefined || e === undefined) return start === 0 && end === Infinity;
		return e >= start && s < end;
	});
}

/**
 * 时钟一致性告警（只告警不拦）：转写稿与视频不是同一条时，标签会**全部对错时间**而且看不出来。
 * 判据：记录的时长差 > 1 秒；记录的源文件名与视频不同名；最后一个字落在视频结尾之后 1 秒以上。
 */
export function clockWarnings(t: TimedTranscript, video: { name: string; duration: number }): string[] {
	const out: string[] = [];
	if (t.duration !== undefined && Math.abs(t.duration - video.duration) > 1) {
		out.push(`转写稿记录的时长 ${t.duration.toFixed(1)}s 与视频 ${video.duration.toFixed(1)}s 相差超过 1 秒——转写稿可能不是这条视频的`);
	}
	if (t.source) {
		const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
		if (base(t.source) !== base(video.name)) {
			out.push(`转写稿记录的源文件是「${base(t.source)}」，与视频「${base(video.name)}」不同名——确认是同一条片（改过名可忽略）`);
		}
	}
	let lastEnd = -1;
	for (const w of t.words) if (w.end !== undefined && w.end > lastEnd) lastEnd = w.end;
	if (lastEnd > video.duration + 1) {
		out.push(`转写稿最后一个字在 ${lastEnd.toFixed(1)}s，超出视频时长 ${video.duration.toFixed(1)}s——转写稿可能不是这条视频的`);
	}
	return out;
}
