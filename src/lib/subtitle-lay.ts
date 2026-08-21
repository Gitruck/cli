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
}: {
	/** 落轨序（0 起）；name = `Caption <index+1>`。 */
	index: number;
	text: string;
	startSec: number;
	durationSec: number;
	presetId: SubtitlePresetId;
	colorId: SubtitleColorId;
	canvas: { width: number; height: number };
}): SubtitleElement {
	const content = normalizeSubtitleContent(text);
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

/**
 * 投影视图 → 字幕窗口序列：存活实例按 track_st 序（projectTranscript 已排）逐条转窗口；
 * 短于 MIN_CAPTION_SEC（轨上时长）的实例丢弃并计数（客户端 droppedShortCount 同口径）。
 */
export function captionsFromProjection(utterances: ProjectedUtterance[]): {
	captions: CaptionWindow[];
	droppedShort: number;
} {
	const captions: CaptionWindow[] = [];
	let droppedShort = 0;
	for (const u of utterances) {
		if (u.dropped || u.track_st === null || u.track_ed === null) continue;
		const durationSec = u.track_ed - u.track_st;
		if (durationSec < MIN_CAPTION_SEC) {
			droppedShort += 1;
			continue;
		}
		captions.push({ text: u.text, startSec: u.track_st, durationSec });
	}
	return { captions, droppedShort };
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
