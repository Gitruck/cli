/**
 * 只有客户端会画的视觉状态（change link-client-only-notice）。
 *
 * `struct_meta.client_visual_elements`（文本 / 贴纸 / 图形 / 特效）和 `struct_meta.client_background`
 * （画布背景）只有客户端预览与本地导出会画；`gtrk render` 不读它们，`gtrk project export` 经服务端往返
 * 也带不上。客户端已不在编辑器里常驻提示这件事（客户端 `revise-track-header-notices`），提示落到这两个
 * 命令上：用户在这里才真受影响。
 *
 * 两个命令共用这一份计数与文案；文案面向人，MUST NOT 出现字段名。
 */

export interface ClientOnlySummary {
	text: number;
	sticker: number;
	graphic: number;
	effect: number;
	/** 未知类型的元素（如实计入，不猜） */
	other: number;
	/** `client_background` 在场且不是缺省纯黑 */
	background: boolean;
}

type ElementType = "text" | "sticker" | "graphic" | "effect";
const KNOWN: readonly ElementType[] = ["text", "sticker", "graphic", "effect"];

/** 客户端缺省画布底色（客户端 `background/color.ts::DEFAULT_BACKGROUND_COLOR`）。 */
const DEFAULT_BACKGROUND_COLOR = "#000000";

function lanesOf(cve: unknown): unknown[] {
	if (Array.isArray(cve)) return cve;
	if (cve && typeof cve === "object" && Array.isArray((cve as { lanes?: unknown }).lanes)) {
		return (cve as { lanes: unknown[] }).lanes;
	}
	return [];
}

/**
 * 画布背景是否不是缺省：与客户端写 `clientState.background` 的判据同口径
 * （`apps/web/src/tonghe/serializer-gtrk-v1.ts`：`type === "color"` 且色值大小写不敏感等于缺省色 ⇒ 缺省）。
 */
function backgroundIsCustom(bg: unknown): boolean {
	if (!bg || typeof bg !== "object") return false;
	const b = bg as { type?: unknown; color?: unknown };
	return !(b.type === "color" && typeof b.color === "string" && b.color.toLowerCase() === DEFAULT_BACKGROUND_COLOR);
}

export function summarizeClientOnly(gtrk: { struct_meta?: unknown }): ClientOnlySummary {
	const sm = (gtrk.struct_meta && typeof gtrk.struct_meta === "object" ? gtrk.struct_meta : {}) as Record<string, unknown>;
	const out: ClientOnlySummary = { text: 0, sticker: 0, graphic: 0, effect: 0, other: 0, background: backgroundIsCustom(sm.client_background) };
	for (const lane of lanesOf(sm.client_visual_elements)) {
		const elements = lane && typeof lane === "object" ? (lane as { elements?: unknown }).elements : undefined;
		if (!Array.isArray(elements)) continue;
		for (const el of elements) {
			const type = el && typeof el === "object" ? (el as { type?: unknown }).type : undefined;
			if (KNOWN.includes(type as ElementType)) out[type as ElementType] += 1;
			else out.other += 1;
		}
	}
	return out;
}

/** 元素总数（不含画布背景）。 */
export function clientOnlyElementCount(s: ClientOnlySummary): number {
	return s.text + s.sticker + s.graphic + s.effect + s.other;
}

function backgroundLabel(bg: unknown): string {
	const b = (bg && typeof bg === "object" ? bg : {}) as { type?: unknown; color?: unknown };
	if (b.type === "blur") return "模糊";
	if (b.type === "color" && typeof b.color === "string") return `纯色 ${b.color}`;
	return "自定义";
}

/**
 * 人话提示；什么都没有时返回 null（不打）。
 * `verb`：`render` = 本地渲染成片；`export` = 导出剪映 / Pr / OTIO 等工程文件。
 */
export function clientOnlyNotice(
	s: ClientOnlySummary,
	verb: "render" | "export",
	background?: unknown,
): string | null {
	const parts: string[] = [];
	if (s.text) parts.push(`${s.text} 段文字`);
	if (s.sticker) parts.push(`${s.sticker} 个贴纸`);
	if (s.graphic) parts.push(`${s.graphic} 个图形`);
	if (s.effect) parts.push(`${s.effect} 个特效`);
	if (s.other) parts.push(`另有 ${s.other} 个其它元素`);
	if (!parts.length && !s.background) return null;
	const where = verb === "render" ? "gtrk render 的成片里" : "这次导出的工程文件里";
	const bg = s.background ? `画布背景（${backgroundLabel(background)}）` : "";
	const head = parts.length
		? `工程里有 ${parts.join("、")}只在客户端出画，${where}没有它们${bg ? `；${bg}也不会带上` : ""}。`
		: `工程的${bg}只在客户端出画，${where}没有它。`;
	const it = parts.length ? "它们" : "它";
	const tail =
		verb === "export" && s.text
			? "要把文字带进剪映草稿，请在客户端导出剪映草稿。"
			: `要${it}进成片，请在客户端本地导出。`;
	return head + tail;
}
