/**
 * 视频转文字稿的纯数据层：ASR 结果归一、Agent 待总结协议、妙记式 Markdown 渲染。
 *
 * 不做网络、不读写文件，便于离线单测。CLI 只产忠实转写和稳定骨架；
 * `## 总结` 由驱动 CLI 的 Agent 阅读全文后写回同一个 Markdown。
 */

export interface TimedText {
	text: string;
	start: number;
	end: number;
}

export interface NormalizedAsr {
	text: string;
	sentences: TimedText[];
	words: TimedText[];
}

export interface TranscriptMarkdownInput {
	title: string;
	sourceName: string;
	durationSec: number;
	language: string;
	generatedAt: Date;
	asr: NormalizedAsr;
}

/** 驱动 Agent 必须原地替换并在交付前确认消失的稳定标记。 */
export const AGENT_SUMMARY_PENDING = "<!-- gtrk:agent-summary-pending -->";

function finiteNumber(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function timeFrom(item: Record<string, unknown>, secondsKey: string, msKey: string, shortKey: string): number {
	const seconds = finiteNumber(item[secondsKey]);
	if (seconds != null) return seconds;
	const milliseconds = finiteNumber(item[msKey]);
	if (milliseconds != null) return milliseconds / 1000;
	return finiteNumber(item[shortKey]) ?? 0;
}

function normalizeTimedList(value: unknown): TimedText[] {
	if (!Array.isArray(value)) return [];
	const items: TimedText[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as Record<string, unknown>;
		const text = typeof item.text === "string" ? item.text.trim() : "";
		if (!text) continue;
		const start = timeFrom(item, "start_time", "begin_time_ms", "st");
		const end = timeFrom(item, "end_time", "end_time_ms", "ed");
		items.push({ text, start, end: Math.max(start, end) });
	}
	return items.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** 兼容 Handler 实际字段与 Swagger 文档字段。无可用正文时明确失败。 */
export function normalizeAsrOutput(output: Record<string, unknown>): NormalizedAsr {
	let sentences = normalizeTimedList(output.sentence_tc_list ?? output.sentence_list);
	const words = normalizeTimedList(output.word_tc_list ?? output.word_list);
	let text = "";
	for (const key of ["asr_text", "text"] as const) {
		const value = output[key];
		if (typeof value === "string" && value.trim()) {
			text = value.trim();
			break;
		}
	}

	if (sentences.length === 0 && words.length > 0) {
		sentences = [{
			text: text || words.map((word) => word.text).join(""),
			start: words[0]?.start ?? 0,
			end: words[words.length - 1]?.end ?? 0,
		}];
	}
	if (!text && sentences.length > 0) text = sentences.map((sentence) => sentence.text).join("\n");
	if (!text.trim() || sentences.length === 0) {
		throw new Error("ASR 任务已完成，但没有返回可用的文字或句级时间戳");
	}
	return { text: text.trim(), sentences, words };
}

/** 秒 → 固定 [HH:MM:SS] 所需正文（向下取整，避免显示尚未到达的下一秒）。 */
export function formatTimestamp(seconds: number): string {
	const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 只补句末标点，不碰句内识别文本。 */
export function ensureTerminalPunctuation(text: string): string {
	const value = text.trim();
	if (!value) return value;
	return /[。！？!?；;：:]$/.test(value) ? value : `${value}。`;
}

function localDateTime(date: Date): string {
	const p = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** 固定三段式 Markdown；无说话人数据时不生成伪标签。 */
export function renderTranscriptMarkdown(input: TranscriptMarkdownInput): string {
	const timed = input.asr.sentences.flatMap((sentence) => [
		`**[${formatTimestamp(sentence.start)}]**`,
		"",
		ensureTerminalPunctuation(sentence.text),
		"",
	]);

	return [
		`# ${input.title}`,
		"",
		`> 生成时间：${localDateTime(input.generatedAt)}  `,
		`> 视频时长：${formatTimestamp(input.durationSec)}  `,
		`> 来源：本地视频 \`${input.sourceName}\`  `,
		`> 识别语言：${input.language}`,
		"",
		"## 总结",
		"",
		AGENT_SUMMARY_PENDING,
		"> 待驱动 CLI 的 Agent 阅读下方完整文字稿后，在此生成总结。",
		"",
		"## 文字记录",
		"",
		...timed,
		"## 纯文本",
		"",
		input.asr.text.trim(),
		"",
	].join("\n");
}
