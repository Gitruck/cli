/**
 * 字幕上轨纯函数面（add-subtitle-lay-command）——transcript 投影实例 → 客户端契约形态的
 * text 元素 → `.gtrk` 的 `struct_meta.client_visual_elements`（cve）text lane 幂等替换。
 *
 * ## 契约正本（只读参考，MUST NOT 改 opencut 仓）
 *
 * 逐字段对齐客户端「一键上字幕」产物（opencut-rewrite/apps/web/src/subtitles/*）：
 *  - 样式表：`style-presets.ts` 的 vendored 快照（摘录日期 2026-08-21；其上游是云端
 *    `video_ai_subtitle` 的 ASS 模板 1080×1920 / 1920×1080 两档 Style 行，摘录日期 2026-08-19）。
 *    漂移风险与客户端同族：云端/客户端改模板本文件不自动跟，两处锚同一正本、换模板一起对表。
 *  - 元素构造：`build-subtitle-text-element.ts`（DOM 测量版）——本文件是它的**确定性静态几何**
 *    等价实现（design D3）：客户端折行按空白符分词（`split(/\s+/)`），CJK 无空格文本恒单
 *    「词」不折行 ⇒ content 只做归一；垂直落位只依赖行数（块高 = 行数×行高），水平落位在
 *    「7 预设边距全对称 + textAlign 恒 center」下恒 0。黄金样本实证（1920×1080 default 单行）：
 *    positionY = 1080 − 75 − 45 − 540 = 420，与客户端 DOM 测量产物同值。
 *  - cve 形状与读侧信任边界：`tonghe/client-visual-elements.ts`（schema 1 / lane 白名单 /
 *    时间字段整数 tick / params 有限标量）。
 *  - 字幕身份判据：`subtitle-actions.ts` 的 `params.subtitleCue === true`
 *    （MUST NOT 用 subtitlePresetId 当判据——.ass 自带样式的 cue 无预设 id 但仍是字幕）。
 *
 * 黄金对照：tts-104164677111025670-video-project-260819-094650/gtrk/project.gtrk 的
 * cve lanes[0]（被客户端保存过的真实字幕 lane），已抽进 test/fixtures/subtitle-golden/。
 */
import { randomUUID } from "node:crypto";
// 第 ② 级切点护栏的词表与判据（tasks §2 要求词表落独立文件：换表只动那一个文件）。
import { splitsWord } from "./caption-word-guard";

/** 客户端 MediaTime 刻度（opencut wasm TICKS_PER_SECOND）。 */
export const SUBTITLE_TICKS_PER_SECOND = 120000;

/** 最小可读时长（秒）——客户端 MIN_CAPTION_DURATION_SECONDS 同值：短于此的投影实例丢弃并计数。 */
export const MIN_CAPTION_SEC = 0.8;

/** 云端恒用字体（客户端 SUBTITLE_FONT_FAMILY 同标尺；CSS 回落 sans-serif 由客户端兜）。 */
export const SUBTITLE_FONT_FAMILY = "思源黑体 CN Bold";

/** 字号换算基准（客户端 FONT_SIZE_SCALE_REFERENCE：渲染 px = app 值 × canvasH / 90）。 */
const FONT_SIZE_SCALE_REFERENCE = 90;

/** 预设 id 与云端 `subtitle_type` / 客户端 SUBTITLE_PRESET_IDS 一字不差。 */
export const SUBTITLE_PRESET_IDS = [
	"default",
	"outline",
	"cinema_yellow",
	"immersive_box",
	"wide_spacing",
	"deep_shadow",
	"boxed",
] as const;

export type SubtitlePresetId = (typeof SUBTITLE_PRESET_IDS)[number];

export const DEFAULT_SUBTITLE_PRESET_ID: SubtitlePresetId = "default";

/** 颜色 id 与云端 `subtitle_color` / 客户端 SUBTITLE_COLOR_IDS 一字不差。 */
export const SUBTITLE_COLOR_IDS = [
	"雅黑",
	"淡绿",
	"森林绿",
	"湖蓝",
	"道奇蓝",
	"钢蓝",
	"浅粉红",
	"深橙",
	"珊瑚橙",
	"橙红",
	"土豪金",
] as const;

export type SubtitleColorId = (typeof SUBTITLE_COLOR_IDS)[number];

export const DEFAULT_SUBTITLE_COLOR_ID: SubtitleColorId = "雅黑";

export const SUBTITLE_COLORS: Record<SubtitleColorId, string> = {
	雅黑: "#333333",
	淡绿: "#6BC76A",
	森林绿: "#20A21F",
	湖蓝: "#11BBF0",
	道奇蓝: "#1D88F1",
	钢蓝: "#4682B4",
	浅粉红: "#F37271",
	深橙: "#FF8C00",
	珊瑚橙: "#FF7F50",
	橙红: "#F74B0E",
	土豪金: "#ECC71E",
};

/** boxed 半透明分流：ASS alpha `A4` ⇒ CSS alpha = (255−0xA4)/255（客户端 BOXED_COLOR_ALPHA 同式）。 */
const BOXED_COLOR_ALPHA = (255 - 0xa4) / 255;

/** &H401C1C1C ⇒ #1C1C1C alpha 0x40 ⇒ CSS 0.75（客户端 SOFT_DARK_SHADOW 同值）。 */
const SOFT_DARK_SHADOW = "rgba(28, 28, 28, 0.75)";
/** &H60000000 ⇒ #000000 alpha 0x60 ⇒ CSS 0.62（客户端 BOX_DROP_SHADOW 同值）。 */
const BOX_DROP_SHADOW = "rgba(0, 0, 0, 0.62)";

interface AssTierRow {
	playResX: number;
	playResY: number;
	fontSize: number;
	/** BorderStyle=1 时为描边宽（向外）；=3 时为底框内边距。ASS px。 */
	outline: number;
	/** 投影偏移（向右下）。ASS px。 */
	shadow: number;
	marginL: number;
	marginR: number;
	marginV: number;
}

interface SubtitlePresetDef {
	borderStyle: 1 | 3;
	textColor: string;
	shadowColor: string | null;
	glyphScaleX: number;
	glyphScaleY: number;
	portrait: AssTierRow;
	landscape: AssTierRow;
}

const P = { playResX: 1080, playResY: 1920, marginL: 36, marginR: 36 };
const L = { playResX: 1920, playResY: 1080, marginL: 100, marginR: 100 };

/** 7 预设两档 Style 行快照（与客户端 SUBTITLE_STYLE_PRESETS 逐值同源）。 */
const SUBTITLE_STYLE_PRESETS: Record<SubtitlePresetId, SubtitlePresetDef> = {
	default: {
		borderStyle: 1,
		textColor: "#ffffff",
		shadowColor: SOFT_DARK_SHADOW,
		glyphScaleX: 100,
		glyphScaleY: 100,
		portrait: { ...P, fontSize: 100, outline: 0, shadow: 4, marginV: 400 },
		landscape: { ...L, fontSize: 75, outline: 0, shadow: 4, marginV: 75 },
	},
	outline: {
		borderStyle: 1,
		textColor: "#ffffff",
		shadowColor: "#6a6a6a",
		glyphScaleX: 100,
		glyphScaleY: 100,
		portrait: { ...P, fontSize: 100, outline: 10, shadow: 3.6, marginV: 400 },
		landscape: { ...L, fontSize: 75, outline: 10, shadow: 3.6, marginV: 50 },
	},
	cinema_yellow: {
		borderStyle: 1,
		// &H0000D7FF（BGR）⇒ #FFD700 金黄——唯一改文字主色的预设。
		textColor: "#ffd700",
		shadowColor: null,
		glyphScaleX: 100,
		glyphScaleY: 100,
		portrait: { ...P, fontSize: 100, outline: 10, shadow: 0, marginV: 400 },
		landscape: { ...L, fontSize: 75, outline: 10, shadow: 0, marginV: 50 },
	},
	immersive_box: {
		borderStyle: 3,
		textColor: "#ffffff",
		shadowColor: BOX_DROP_SHADOW,
		glyphScaleX: 100,
		glyphScaleY: 100,
		portrait: { ...P, fontSize: 100, outline: 15, shadow: 8, marginV: 400 },
		landscape: { ...L, fontSize: 75, outline: 15, shadow: 8, marginV: 50 },
	},
	wide_spacing: {
		borderStyle: 1,
		textColor: "#ffffff",
		shadowColor: SOFT_DARK_SHADOW,
		// 唯一改字形比例的预设（ScaleX 90 / ScaleY 115）。
		glyphScaleX: 90,
		glyphScaleY: 115,
		portrait: { ...P, fontSize: 100, outline: 4, shadow: 2, marginV: 400 },
		landscape: { ...L, fontSize: 75, outline: 4, shadow: 2, marginV: 50 },
	},
	deep_shadow: {
		borderStyle: 1,
		textColor: "#ffffff",
		shadowColor: "#000000",
		glyphScaleX: 100,
		glyphScaleY: 100,
		portrait: { ...P, fontSize: 100, outline: 4, shadow: 10, marginV: 400 },
		landscape: { ...L, fontSize: 75, outline: 4, shadow: 10, marginV: 50 },
	},
	boxed: {
		borderStyle: 3,
		textColor: "#ffffff",
		shadowColor: null,
		glyphScaleX: 100,
		glyphScaleY: 100,
		portrait: { ...P, fontSize: 100, outline: 20, shadow: 0, marginV: 400 },
		landscape: { ...L, fontSize: 75, outline: 20, shadow: 0, marginV: 50 },
	},
};

/** CLI 入参硬闸：非法值报错列合法值（MUST NOT 静默回落——与客户端读侧容错是两回事）。 */
export function parsePresetId(raw: string | undefined): SubtitlePresetId {
	if (raw === undefined) return DEFAULT_SUBTITLE_PRESET_ID;
	if ((SUBTITLE_PRESET_IDS as readonly string[]).includes(raw)) return raw as SubtitlePresetId;
	throw new Error(`未知字幕样式「${raw}」——合法取值：${SUBTITLE_PRESET_IDS.join(" / ")}`);
}

export function parseColorId(raw: string | undefined): SubtitleColorId {
	if (raw === undefined) return DEFAULT_SUBTITLE_COLOR_ID;
	if ((SUBTITLE_COLOR_IDS as readonly string[]).includes(raw)) return raw as SubtitleColorId;
	throw new Error(`未知字幕颜色「${raw}」——合法取值：${SUBTITLE_COLOR_IDS.join(" / ")}`);
}

export type SubtitleOrientation = "landscape" | "portrait";

/** 横竖屏档位（客户端 buildSubtitleStyleOverrides 同判据：宽≥高走横屏档）。 */
export function orientationOf(canvas: { width: number; height: number }): SubtitleOrientation {
	return canvas.width >= canvas.height ? "landscape" : "portrait";
}

function hexToRgba(hex: string, alpha: number): string {
	const value = hex.replace("#", "");
	const r = Number.parseInt(value.slice(0, 2), 16);
	const g = Number.parseInt(value.slice(2, 4), 16);
	const b = Number.parseInt(value.slice(4, 6), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * content 归一（客户端 wrapSubtitleText 的无测量等价形态）：trim + \r\n→\n，逐段 trim、
 * 段内空白符折叠为单空格。CJK 无空格文本 = 客户端逐字节同值；含空格长句不折行属已知偏差
 * （客户端无 DOM 时同样降级，design Risks 记录）。
 */
export function normalizeSubtitleContent(text: string): string {
	const normalized = text.trim().replace(/\r\n/g, "\n");
	return normalized
		.split("\n")
		.map((paragraph) => {
			const trimmed = paragraph.trim();
			return trimmed ? trimmed.split(/\s+/).join(" ") : "";
		})
		.join("\n");
}

/** 中日韩后继判据（U+3000-30FF 标点/假名、U+3400-9FFF 表意、U+F900-FAFF 兼容、U+FF00-FFEF 全角）。 */
const CJK_NEXT = /[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/**
 * 字幕文本去标点（★ 主理人 2026-08-21 真机走查拍板）：中英逗号（，,）与中英句号（。.）
 * 替换为空格——「有些标点符号在字幕里也不好看」；其余标点（引号「」『』、顿号、问号、
 * 感叹号、破折号等）一律保留（裁定只点名逗号句号）。
 *
 *  - 英文句号防误伤小数/缩写：只替换后面跟空白、行尾或中日韩字符的 `.`；
 *    `3.5`、`U.S.`（词内）、`example.com` 这类后接字母/数字的句点不动。
 *  - 英文逗号防误伤千分位：两侧都是数字的 `,`（`1,000`）不动，其余全换（同一
 *    「别误伤数字」原则的逗号侧最小豁免）。
 *  - 中文逗号句号无此顾虑，全换。
 *
 * 只做「标点 → 空格」一步；收尾（连续空格折叠为一、行首行尾空格裁掉——行尾句号
 * 换出的空格因此直接消失、结尾干净）交由既有 normalizeSubtitleContent 统一完成。
 * 只影响写出的字幕 content；transcript.json 原文 MUST NOT 改。
 */
export function stripSubtitlePunctuation(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "，" || ch === "。") {
			out += " ";
			continue;
		}
		if (ch === ",") {
			const prev = i > 0 ? text[i - 1] : "";
			const next = i + 1 < text.length ? text[i + 1] : "";
			out += /[0-9]/.test(prev) && /[0-9]/.test(next) ? ch : " ";
			continue;
		}
		if (ch === ".") {
			const next = i + 1 < text.length ? text[i + 1] : "";
			out += next === "" || /\s/.test(next) || CJK_NEXT.test(next) ? " " : ch;
			continue;
		}
		out += ch;
	}
	return out;
}

/** 秒 → 整数 tick（客户端 mediaTimeFromSeconds 的取整同义；cve 读侧硬闸要求整数非负）。 */
export function secondsToTicks(seconds: number): number {
	return Math.round(seconds * SUBTITLE_TICKS_PER_SECOND);
}

/**
 * 构造单条字幕元素的 params（37 键全集，键序与黄金样本一致）。
 * 全部换算的**运算次序**逐式对齐客户端（IEEE 浮点逐位同值——黄金样本 deepEqual 锁定）。
 */
export function buildSubtitleParams({
	presetId,
	colorId,
	canvas,
	content,
}: {
	presetId: SubtitlePresetId;
	colorId: SubtitleColorId;
	canvas: { width: number; height: number };
	content: string;
}): Record<string, string | number | boolean> {
	const preset = SUBTITLE_STYLE_PRESETS[presetId];
	const row = orientationOf(canvas) === "landscape" ? preset.landscape : preset.portrait;
	const colorHex = SUBTITLE_COLORS[colorId];

	// 字号：app 单位 = (Fontsize/PlayResY) × 90（客户端 fontSizeRatioOfPlayHeight × FONT_SIZE_SCALE_REFERENCE）。
	const fontSizeApp = (row.fontSize / row.playResY) * FONT_SIZE_SCALE_REFERENCE;
	// 尺寸型参数（描边宽/投影偏移）：app = assPx × 90 / playResY（运算次序同客户端 toAppUnit）。
	const toAppUnit = (assPx: number) => (assPx * FONT_SIZE_SCALE_REFERENCE) / row.playResY;

	const isBox = preset.borderStyle === 3;
	// bs3 底框内边距（background.padding 参数域）：渲染 px 目标 = outline × canvasH / playResY，
	// 参数 = 目标 × 15 / fontSizeApp（运算次序同客户端 paddingParam）。
	const paddingParam = isBox
		? ((row.outline * canvas.height) / row.playResY) * (15 / fontSizeApp)
		: 0;
	const backgroundColor = isBox
		? presetId === "boxed"
			? hexToRgba(colorHex, BOXED_COLOR_ALPHA)
			: colorHex
		: "#000000";
	const strokeEnabled = !isBox && row.outline > 0;
	const shadowEnabled = preset.shadowColor !== null && row.shadow > 0;

	// ── 确定性静态几何（design D3；客户端 measureWrappedTextBlock + resolvePositionX/Y 的无测量等价）──
	// 垂直：块高只依赖行数；visualRect.top = −高/2 ⇒ bottom = 高/2（bs3 再加底框 paddingY 像素）。
	const scaledFontSize = fontSizeApp * (canvas.height / FONT_SIZE_SCALE_REFERENCE);
	const lineHeight = 1.2;
	const lineHeightPx = lineHeight * scaledFontSize;
	const lineCount = content.split("\n").length;
	const blockHeight = lineCount * lineHeightPx;
	const paddingPx = isBox ? paddingParam * (fontSizeApp / 15) : 0;
	const visualBottom = blockHeight / 2 + paddingPx;
	const glyphScaleY = preset.glyphScaleY / 100;
	const margin = canvas.height * (row.marginV / row.playResY);
	const positionY = canvas.height - margin - visualBottom * glyphScaleY - canvas.height / 2;
	// 水平：7 预设边距全对称 + textAlign 恒 center ⇒ 恒 0（客户端公式代入即得，与测量宽度无关）。
	const positionX = 0;

	return {
		content,
		fontSize: fontSizeApp,
		fontFamily: SUBTITLE_FONT_FAMILY,
		color: preset.textColor,
		textAlign: "center",
		// ASS 模板 Bold 标志位恒 0（家族名自带 Bold 字重），故 normal（客户端 B 案同口径）。
		fontWeight: "normal",
		fontStyle: "normal",
		textDecoration: "none",
		letterSpacing: 0,
		lineHeight,
		"background.enabled": isBox,
		"background.color": backgroundColor,
		"background.cornerRadius": 0,
		// bs1 走客户端 text 元素缺省（30/42，黄金样本同值）；bs3 走底框内边距参数域。
		"background.paddingX": isBox ? paddingParam : 30,
		"background.paddingY": isBox ? paddingParam : 42,
		"background.offsetX": 0,
		"background.offsetY": 0,
		"stroke.enabled": strokeEnabled,
		"stroke.color": strokeEnabled ? colorHex : "#000000",
		"stroke.width": strokeEnabled ? toAppUnit(row.outline) : 0,
		"shadow.enabled": shadowEnabled,
		"shadow.color": shadowEnabled ? (preset.shadowColor as string) : "#000000",
		"shadow.offsetX": shadowEnabled ? toAppUnit(row.shadow) : 0,
		"shadow.offsetY": shadowEnabled ? toAppUnit(row.shadow) : 0,
		"shadow.blur": 0,
		glyphScaleX: preset.glyphScaleX,
		glyphScaleY: preset.glyphScaleY,
		"transform.positionX": positionX,
		"transform.positionY": positionY,
		"transform.scaleX": 1,
		"transform.scaleY": 1,
		"transform.rotate": 0,
		opacity: 1,
		blendMode: "normal",
		subtitleCue: true,
		subtitlePresetId: presetId,
		subtitleColorId: colorId,
	};
}

/** cve 元素（结构化 unknown——形状对齐客户端 pickClientVisualElement 白名单）。 */
export interface SubtitleElement {
	id: string;
	type: "text";
	name: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	params: Record<string, string | number | boolean>;
}

/** 单条投影实例 → text 元素（键序对齐黄金样本：id/type/name/startTime/duration/trimStart/trimEnd/params）。 */
export function buildCaptionElement({
	index,
	text,
	startSec,
	durationSec,
	presetId,
	colorId,
	canvas,
	keepPunctuation = false,
}: {
	/** 落轨序（0 起）；name = `Caption <index+1>`。 */
	index: number;
	text: string;
	startSec: number;
	durationSec: number;
	presetId: SubtitlePresetId;
	colorId: SubtitleColorId;
	canvas: { width: number; height: number };
	/** true = 保留原始标点（--keep-punctuation 逃生口）；缺省清洗逗号句号。 */
	keepPunctuation?: boolean;
}): SubtitleElement {
	const content = normalizeSubtitleContent(
		keepPunctuation ? text : stripSubtitlePunctuation(text),
	);
	return {
		id: randomUUID(),
		type: "text",
		name: `Caption ${index + 1}`,
		startTime: secondsToTicks(startSec),
		duration: secondsToTicks(durationSec),
		trimStart: 0,
		trimEnd: 0,
		params: buildSubtitleParams({ presetId, colorId, canvas, content }),
	};
}

/** 投影视图句条（lib/projection.ts ViewUtterance 的消费面子集）。 */
export interface ProjectedUtterance {
	/**
	 * 源 utterance id（`ViewUtterance.id` 一路透传）。同一句被智能剪辑切成多个存活实例时，
	 * 这些实例的 id 相同——⓪ 同句回缝就以它为唯一判据。
	 * **可选**：不传时回缝恒不触发，存量调用行为逐字不变（fix-subtitle-lay-duplicate-instances 回归闸）。
	 */
	id?: string;
	text: string;
	track_st: number | null;
	track_ed: number | null;
	dropped: boolean;
}

export interface CaptionWindow {
	text: string;
	startSec: number;
	durationSec: number;
}

/** 字宽单位：CJK/全角 1.0、ASCII/半角 0.5（与服务端拆行口径同源）。 */
export function textUnits(text: string): number {
	let n = 0;
	for (const ch of text) n += ch.codePointAt(0)! > 0x2e80 ? 1 : 0.5;
	return n;
}

// ── 切点选择：三级回退（fix-caption-split-word-boundary，2026-09-02 旅拍三条真机复盘）────
//
// 归因（proposal §〇/§一）：真机上的「嫌|冷」「正|对」「这件|事」「真实|过着」四处词中断
// **不是** TTS 切的（引擎六种 `text_split_method` 全部只在标点处切，句内切不出这种断点），
// 是本文件自己切的——原实现只抄到 infra `subtitle-line-split` 正本的第 ①「均分定锚点」，
// 第 ②「在锚点浮动窗内挑词边界」③「词边界无解才字符强切」两步从来没写；更难堪的是旧头注
// 已经把「切点在 ±2 字符内有空格则吸附到空格」承诺出去了，实现里只有一句 `p.trim()`。
// 本节补的就是 ②③（并把那句承诺真正兑现），锚点那一步一行不动。
// 第 ② 级的词表与判据不在本文件——它是待替换品（HanLP 蒸馏快照到位后整表换掉），
// 单独落在 `caption-word-guard.ts`，本节只 import `splitsWord` 这一个入口。

/**
 * 锚点浮动窗（单位=字宽）。对齐 infra `subtitle-line-split` 正本 spec:8-14
 * 「切点浮动窗口的用途是**在预算内挑一个更好的词边界**，MUST NOT 成为越过预算的通道」
 * ——不是 CLI 自创的旋钮，所以不开 CLI 开关（`--max-units` 已是唯一旋钮，0 即关）。
 */
export const CAPTION_SPLIT_FLOAT_UNITS = 2;

/** 天然停顿点：切在这些字**之后**零歧义（取 infra `text_segmentation_method.py` 的 splits 集 + 常见收尾标点）。 */
const CAPTION_BREAK_AFTER_PUNCT = new Set([
	"，", "。", "？", "！", "、", "；", "：", "…", "—", "～",
	",", ".", "?", "!", ";", ":", "~",
	"」", "』", "》", "】", "）", ")", "”", "’",
]);

/** ASCII 原子字符（字母/数字）——原子串守卫的基元。 */
const ATOMIC_ASCII = /[0-9A-Za-z]/;

/**
 * 原子串守卫：连续 ASCII 字母/数字串、以及 `3.5` / `1,000` / `example.com` 这类含中缀符的
 * 数值/点分形态 SHALL 视为不可切原子。判据与 `stripSubtitlePunctuation`（:251）对小数、
 * 千分位、域名的保护口径同源（那边是「别把标点换成空格」，这边是「别在这儿下刀」），
 * 但**只读不改**那个函数。
 *
 * 返回 true = 切点 `cut`（切在 chars[cut] 之前）落在某个原子串内部。
 */
function splitsAtomicRun(chars: string[], cut: number): boolean {
	const a = chars[cut - 1] ?? "";
	const b = chars[cut] ?? "";
	const prev2 = chars[cut - 2] ?? "";
	const next2 = chars[cut + 1] ?? "";
	const alnum = (ch: string) => ch !== "" && ATOMIC_ASCII.test(ch);
	const digit = (ch: string) => ch !== "" && /[0-9]/.test(ch);
	if (alnum(a) && alnum(b)) return true;
	// 切在中缀符**之前**：`3|.5`、`example|.com`、`1|,000`
	if (alnum(a) && b === "." && alnum(next2)) return true;
	if (digit(a) && b === "," && digit(next2)) return true;
	// 切在中缀符**之后**：`3.|5`、`example.|com`、`1,|000`
	if (a === "." && alnum(b) && alnum(prev2)) return true;
	if (a === "," && digit(b) && digit(prev2)) return true;
	return false;
}

/** 切点左侧是标点之后位 / 空白位（第 ① 级信号；空白位顺带兑现旧头注承诺的「空格吸附」）。 */
function isPunctOrSpaceBoundary(chars: string[], cut: number): boolean {
	const a = chars[cut - 1] ?? "";
	const b = chars[cut] ?? "";
	if (/\s/.test(a) || /\s/.test(b)) return true;
	return CAPTION_BREAK_AFTER_PUNCT.has(a);
}

/** chars[from, to) 里是否有非空白字符（纯空白窗会被下游 `filter(Boolean)` 吞掉 ⇒ 凭空少一段）。 */
function hasVisible(chars: string[], from: number, to: number): boolean {
	for (let i = from; i < to; i++) if (!/\s/.test(chars[i])) return true;
	return false;
}

/** 切点命中级别：punct=① 标点/空白，guard=② 词表护栏放行，anchor=③ 退化回锚点。 */
export type CaptionSplitTier = "punct" | "guard" | "anchor";

/**
 * 在锚点浮动窗内挑一个合规切点（纯函数）。
 *
 * @param chars       本窗全部字符（码点切分）
 * @param prefixUnits 字宽前缀和（`prefixUnits[i]` = chars[0..i) 的字宽），长度 chars.length+1
 * @param startIndex  本段起点下标（预算守卫要算「本段字宽」，光有锚点算不出来——
 *                    故比 tasks 1.2 的签名草稿多这一个入参）
 * @param anchorIndex 第 ① 步均分定出的锚点切点（切在 chars[anchorIndex] 之前）
 * @param maxUnits    单窗字宽上限
 * @param partsLeft   本次切点**之后**还要产生的段数（含末段）
 *
 * 三级回退：① 标点/空白 → ② 词表护栏 → ③ 退回 anchorIndex。
 * ①② 两级都受**预算守卫**约束（对齐 infra spec:8-10「MUST NOT 成为越过预算的通道」）：
 * 本段字宽 ≤ maxUnits **且** 剩余字宽 ≤ maxUnits × partsLeft，缺一即拒——只守前者会把
 * 超宽整块推给末段。③ 不受预算守卫约束：它就是落地前的行为本身，逐字符一致，永不失败。
 */
export function pickSplitIndex(
	chars: string[],
	prefixUnits: number[],
	startIndex: number,
	anchorIndex: number,
	maxUnits: number,
	partsLeft: number,
): { index: number; tier: CaptionSplitTier } {
	const total = prefixUnits[chars.length];
	const anchorAt = prefixUnits[anchorIndex];
	const cands: number[] = [];
	for (let c = startIndex + 1; c < chars.length; c++) {
		if (Math.abs(prefixUnits[c] - anchorAt) > CAPTION_SPLIT_FLOAT_UNITS + 1e-9) continue;
		// 后面还要切出 partsLeft 段，每段至少留 1 个字——段数由第 ① 步定死，MUST NOT 被切点浮动改掉
		if (chars.length - c < partsLeft) continue;
		// 两侧都得有实字：切出一个纯空白窗会被 `filter(Boolean)` 吞掉，等于凭空少一段
		if (!hasVisible(chars, startIndex, c) || !hasVisible(chars, c, chars.length)) continue;
		cands.push(c);
	}
	// 排序：先近后远；等距时**向回收缩**优先（infra 正本「算法 SHALL 自锚点向回收缩」）
	cands.sort((x, y) => {
		const dx = Math.abs(prefixUnits[x] - anchorAt);
		const dy = Math.abs(prefixUnits[y] - anchorAt);
		if (Math.abs(dx - dy) > 1e-9) return dx - dy;
		return x - y;
	});
	const inBudget = (c: number) =>
		prefixUnits[c] - prefixUnits[startIndex] <= maxUnits + 1e-9 &&
		total - prefixUnits[c] <= maxUnits * partsLeft + 1e-9;
	// ① 标点 / 空白优先（零歧义、零词表；原子串守卫仍然生效——`3.5` 里的 `.` 不是停顿点）
	for (const c of cands) {
		if (!inBudget(c) || splitsAtomicRun(chars, c)) continue;
		if (isPunctOrSpaceBoundary(chars, c)) return { index: c, tier: "punct" };
	}
	// ② 词表护栏（含锚点自身：锚点若本来就不切词，走的就是这一级，不算退化）
	for (const c of cands) {
		if (!inBudget(c) || splitsAtomicRun(chars, c)) continue;
		if (!splitsWord(chars, c)) return { index: c, tier: "guard" };
	}
	// ③ 退化：退回锚点。宁可一处切得难看，也不抛错、不吞字、不越预算段数。
	return { index: anchorIndex, tier: "anchor" };
}

/** 拆窗统计出参（退化计数走出参而非返回值：`splitCaptionWindow` 的数组返回形状 MUST NOT 变）。 */
export interface CaptionSplitStats {
	/** 第 ③ 级（无词边界可用、退回字宽均分）命中次数。 */
	fallbackCount: number;
}

/**
 * 超宽句拆窗：**① 锚点均分（不贪心）→ ② 浮动窗内挑不切词的切点 → ③ 无解退回锚点**
 * 三步（与 infra `subtitle-line-split` 正本同构）。段数由第 ① 步定死，时间按各段字宽比例内插、
 * 末端对齐原句末——第 ②③ 步只改**文本分配点**，时间线零扰动。
 *
 * 第 ① 级的空白位就是旧头注承诺过的「空格吸附」（旧实现只有一句 `p.trim()`，承诺了没写）；
 * 第 ③ 级命中次数经 `stats` 出参上抛，由命令层出 INFO 与 `--json`——看不见的退化等于没修。
 */
export function splitCaptionWindow(
	win: CaptionWindow,
	maxUnits: number,
	stats?: CaptionSplitStats,
): CaptionWindow[] {
	const total = textUnits(win.text);
	if (!maxUnits || total <= maxUnits) return [win];
	const parts = Math.max(2, Math.ceil(total / maxUnits));
	const target = total / parts;
	const chars = [...win.text];
	// 字宽前缀和（prefix[i] = chars[0..i) 的字宽），供锚点定位与预算守卫 O(1) 取值
	const prefix: number[] = [0];
	for (const ch of chars) prefix.push(prefix[prefix.length - 1] + (ch.codePointAt(0)! > 0x2e80 ? 1 : 0.5));

	// 段数以**落地前的锚点法产物**为准，而不是 parts：字宽粒度让每段有少量过冲，极端输入下
	// 末几段够不到 target（少切一刀），或末刀正好落在句尾（没有尾窗）——两种情况下落地前的
	// 段数都不等于 parts（fuzz 实证：maxUnits=3 的乱码串上 ~23% 命中，13/20 两个真实档位 0 命中）。
	// 本件只改切点位置、MUST NOT 改段数，所以先照落地前的实现原样跑一遍，只取它切出几段。
	const refPieces: string[] = [];
	{
		let acc = 0;
		let cur = "";
		for (const ch of chars) {
			cur += ch;
			acc += ch.codePointAt(0)! > 0x2e80 ? 1 : 0.5;
			if (refPieces.length < parts - 1 && acc >= target - 1e-9) {
				refPieces.push(cur);
				cur = "";
				acc = 0;
			}
		}
		if (cur.trim()) refPieces.push(cur);
	}
	const cutsNeeded = refPieces.filter((p) => p.trim()).length - 1;

	const cuts: number[] = [];
	let start = 0;
	for (let seg = 1; seg <= cutsNeeded; seg++) {
		const partsLeft = cutsNeeded - seg + 1; // 本次切点之后还要产生的段数（含末段）
		// 锚点 = 自**本段起点**累加到 target 的第一个下标（与落地前逐字符同式：旧实现每段把 acc 归零）
		let anchor = start + 1;
		while (anchor < chars.length && prefix[anchor] - prefix[start] < target - 1e-9) anchor++;
		// 切点浮动会让后面的段起点跟着挪，挪多了末几段够不到 target。此时把锚点夹到
		// 「后面每段至少留 1 个字」的边界上，保证刀数恒为 cutsNeeded（段数守恒的兜底，正常语料夹不动）。
		const hardLimit = chars.length - partsLeft;
		if (anchor > hardLimit) anchor = hardLimit;
		if (anchor <= start) break;
		const picked = pickSplitIndex(chars, prefix, start, anchor, maxUnits, partsLeft);
		if (picked.tier === "anchor" && stats) stats.fallbackCount += 1;
		cuts.push(picked.index);
		start = picked.index;
	}
	const pieces: string[] = [];
	let from = 0;
	for (const c of cuts) {
		pieces.push(chars.slice(from, c).join(""));
		from = c;
	}
	const tail = chars.slice(from).join("");
	if (tail.trim()) pieces.push(tail);
	// 切点若落在空白处，两侧的悬空格在此裁掉（文本无损的唯一豁免：仅空白）
	const cleaned = pieces.map((p) => p.trim()).filter(Boolean);
	const out: CaptionWindow[] = [];
	let cursor = win.startSec;
	const unitsList = cleaned.map((p) => textUnits(p));
	const unitsSum = unitsList.reduce((a, b) => a + b, 0) || 1;
	for (let i = 0; i < cleaned.length; i++) {
		const dur = win.durationSec * (unitsList[i] / unitsSum);
		out.push({ text: cleaned[i], startSec: cursor, durationSec: dur });
		cursor += dur;
	}
	// 尾窗对齐原句末端（浮点残差归尾）
	if (out.length) {
		const last = out[out.length - 1];
		last.durationSec = win.startSec + win.durationSec - last.startSec;
	}
	return out;
}

export interface CaptionShapingOpts {
	/** 单窗最大字宽单位（CJK=1/ASCII=0.5）；0/缺省 = 不拆窗。 */
	maxUnits?: number;
	/** 相邻窗 gap ≤ 此秒数时桥接（前窗延续到后窗起点，消灭闪烁）；0/缺省 = 不桥接。 */
	maxGapSec?: number;
}

/**
 * ⓪ 同句回缝阈值（秒）。相邻两个**同 id** 投影实例的 gap ≤ 此值即认定「本来就是一句话被剪成了两片」，
 * 合并成一条上轨（时间取包络、文本仍是整句）。
 *
 * 取值 0.5（2026-09-04 拍板）：真机样本里同句相邻实例的实际 gap 为 0.07~0.13s，
 * 而该剪没剪的真实句间停顿通常 > 0.5s，两个分布之间有一个数量级的空档。
 *
 * **MUST NOT 与 `shaping.maxGapSec` 共用**：`--max-gap` 管「视觉上要不要拉长前条以消灭闪烁」，
 * 回缝管「这两片本来是同一句话」——是两个问题。`--max-gap 0`（关桥接）时回缝仍须生效，
 * 否则重复字幕会随手一个 flag 就回来。也不开 CLI 旋钮（多一个开关多一份误用）。
 */
export const CAPTION_RESEW_GAP_SEC = 0.5;

/** ⓪ 回缝后的单元（同 id 多实例已并成一条，时间为包络）。 */
interface SewnUnit {
	id?: string;
	text: string;
	startSec: number;
	endSec: number;
}

/**
 * ⓪ 同句回缝：把「同一 utterance 被切成的多个投影实例」并回一条。
 *
 * 背景（2026-09-04 真机）：投影器对同一句的每个存活实例都吐**整句**文本，逐实例上轨就是
 * 同一句在时间线上重复 N 遍（样本工程 151 条字幕里 39 种文本重复、共 89 个实例）。
 *
 * 判据：**相邻**且 **id 相同** 且 **gap ≤ CAPTION_RESEW_GAP_SEC**。
 * gap 用 `<=` 且**不设下界**——负 gap（完全重叠：同一素材被摆在两条 audio 轨上时投影器会吐出
 * 时码全等的两个实例）正是重复字幕最刺眼的形态，重叠时取包络即可。
 * 文本恒取整句（不拼接），故乱序实例天然不会被拼出语序颠倒的句子。
 */
function sewSameUtterance(utterances: ProjectedUtterance[]): { units: SewnUnit[]; mergedCount: number } {
	const units: SewnUnit[] = [];
	let mergedCount = 0;
	for (const u of utterances) {
		if (u.dropped || u.track_st === null || u.track_ed === null) continue;
		const prev = units[units.length - 1];
		if (
			prev &&
			prev.id !== undefined &&
			u.id !== undefined &&
			prev.id === u.id &&
			u.track_st - prev.endSec <= CAPTION_RESEW_GAP_SEC
		) {
			prev.startSec = Math.min(prev.startSec, u.track_st);
			prev.endSec = Math.max(prev.endSec, u.track_ed);
			mergedCount += 1;
			continue;
		}
		units.push({ id: u.id, text: u.text, startSec: u.track_st, endSec: u.track_ed });
	}
	return { units, mergedCount };
}

/**
 * 投影视图 → 字幕窗口序列：存活实例按 track_st 序（projectTranscript 已排）先 ⓪ 同句回缝，
 * 再逐条转窗口；短于 MIN_CAPTION_SEC（轨上时长）的**回缝后单元**丢弃并计数
 * （客户端 droppedShortCount 同口径）。
 * 可选整形（fix-subtitle-lay-split-and-gap，真机挑刺 2026-08-27）：
 *   maxUnits —— 超宽句拆窗（整句上轨会溢出画布）；
 *   maxGapSec —— 小 gap 桥接（几百 ms 的字幕消失-再现在播放时闪得难受）。
 *
 * 步序 MUST 是 ⓪回缝 → MIN_CAPTION_SEC 过滤 → ①拆窗 → ②桥接
 * （fix-subtitle-lay-duplicate-instances）：回缝若排在过滤之后，同句的两个短实例会各自先被丢掉，
 * 明明合起来够长却丢了字；排在拆窗之后则每片都已按整句拆过一遍，重复已经落地、缝不回来了。
 */
export function captionsFromProjection(
	utterances: ProjectedUtterance[],
	shaping: CaptionShapingOpts = {},
): {
	captions: CaptionWindow[];
	droppedShort: number;
	splitCount: number;
	/** 拆窗时第 ③ 级退化（无词边界可用、退回字宽均分）命中次数——词表够不够用的唯一可观测信号。 */
	splitFallbackCount: number;
	bridgedCount: number;
	/** ⓪ 同句回缝并掉的实例数（= 存活实例数 − 回缝后单元数）。0 = 本次没有一句被剪成多片。 */
	mergedCount: number;
} {
	// ⓪ 同句回缝（MUST 在 MIN_CAPTION_SEC 过滤与拆窗/桥接之前）
	const { units, mergedCount } = sewSameUtterance(utterances);
	const raw: CaptionWindow[] = [];
	let droppedShort = 0;
	for (const u of units) {
		const durationSec = u.endSec - u.startSec;
		if (durationSec < MIN_CAPTION_SEC) {
			droppedShort += 1;
			continue;
		}
		raw.push({ text: u.text, startSec: u.startSec, durationSec });
	}
	// ① 拆窗（拆出的子窗 MUST NOT 二次复检 MIN_CAPTION_SEC——丢一个子窗 = 丢一段文本，比一个短窗更糟）
	let splitCount = 0;
	const splitStats: CaptionSplitStats = { fallbackCount: 0 };
	const captions: CaptionWindow[] = [];
	for (const w of raw) {
		const parts = shaping.maxUnits ? splitCaptionWindow(w, shaping.maxUnits, splitStats) : [w];
		if (parts.length > 1) splitCount += parts.length - 1;
		captions.push(...parts);
	}
	// ② gap 桥接（不跨越真实长停顿——只桥 ≤ maxGapSec 的小缝）
	let bridgedCount = 0;
	if (shaping.maxGapSec && shaping.maxGapSec > 0) {
		for (let i = 0; i + 1 < captions.length; i++) {
			const cur = captions[i];
			const next = captions[i + 1];
			const gap = next.startSec - (cur.startSec + cur.durationSec);
			if (gap > 0 && gap <= shaping.maxGapSec) {
				cur.durationSec = next.startSec - cur.startSec;
				bridgedCount += 1;
			}
		}
	}
	return {
		captions,
		droppedShort,
		splitCount,
		splitFallbackCount: splitStats.fallbackCount,
		bridgedCount,
		mergedCount,
	};
}

// ── cve 幂等替换 ─────────────────────────────────────────────────────────

/** cve 形状版本（客户端 CLIENT_VISUAL_ELEMENTS_SCHEMA 同值）。 */
export const CVE_SCHEMA = 1;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 字幕 lane 判据（design D5，与客户端 isSubtitleTextElement 同源）：
 * text lane、元素非空且**全部**元素 `params.subtitleCue === true`。
 * 含任何无 subtitleCue 元素的 lane（用户手加内容）恒不认——宁可不认、不放水。
 */
export function isSubtitleLane(lane: unknown): boolean {
	if (!isPlainObject(lane) || lane.type !== "text") return false;
	const elements = lane.elements;
	if (!Array.isArray(elements) || elements.length === 0) return false;
	return elements.every(
		(el) =>
			isPlainObject(el) &&
			isPlainObject(el.params) &&
			(el.params as Record<string, unknown>).subtitleCue === true,
	);
}

export interface ReplaceSubtitleLaneResult {
	/** 新 cve 镜像（整键替换 struct_meta.client_visual_elements）。 */
	mirror: Record<string, unknown>;
	/** 被替换掉的既有字幕 lane 条数。 */
	replacedLanes: number;
}

/**
 * cve 幂等替换（design D6）：既有 cve 合法（schema===1 且 lanes 为数组）时保留 scene_id 与
 * 非字幕 lane（原样透传，不重建——用户内容零丢失），字幕 lane 全部剥除、新 lane 置 lanes[0]
 * （对齐客户端一键上字幕 AddTrackCommand index 0）；cve 缺失/形状非法时新建镜像
 * （scene_id = 新 UUID——客户端对 scene_id 不匹配按良性降级照常还原）。
 */
export function replaceSubtitleLane(
	existing: unknown,
	elements: SubtitleElement[],
): ReplaceSubtitleLaneResult {
	const subtitleLane = { type: "text", contract: [], elements };
	if (
		isPlainObject(existing) &&
		existing.schema === CVE_SCHEMA &&
		Array.isArray(existing.lanes)
	) {
		const kept = existing.lanes.filter((lane) => !isSubtitleLane(lane));
		return {
			mirror: {
				...existing,
				lanes: [subtitleLane, ...kept],
			},
			replacedLanes: existing.lanes.length - kept.length,
		};
	}
	return {
		mirror: { schema: CVE_SCHEMA, scene_id: randomUUID(), lanes: [subtitleLane] },
		replacedLanes: 0,
	};
}
