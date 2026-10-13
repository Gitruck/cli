/**
 * 合成颗粒识别（change link-composite-particle-profile，design D1）。
 *
 * 规则正本在 infra capability `composite-particle-profile`（`gitruck-infra/openspec/changes/
 * add-composite-particle-profile/`），参考实现 `gitruck-infra/utils/process/media/vision/composite_particle/detect.py`；
 * 客户端同款在 `gitruck-opencut-rewrite/apps/web/src/tonghe/composite-detect.ts`。三端对同一组识别用例
 * （infra `utils/test/fixtures/composite_particle/detect/`）。
 *
 * - 合成颗粒 = 颗粒 HTML 里恰有一个 `<script type="application/json" data-gtrk-composite>`；判据只看内容。
 * - 子串快判 + 标签级扫描：跳过注释与 `<script>` 正文（与 HTML 原始文本内容模型一致），所以正文里出现
 *   这串字的普通颗粒不会被误判；不引 DOM 依赖。
 * - 本仓只用到「是不是」与「own 槽位指着哪些素材」：出片跳过（本版本不渲染合成颗粒）与重铺零引用保护。
 *   状态判定（新鲜 / 需重渲）不在本仓。
 *
 * 零依赖叶子模块。
 */

export const COMPOSITE_MARKER = "data-gtrk-composite";

export type CompositeKind = "none" | "composite" | "invalid";

export interface CompositeBinding {
	kind: "ref" | "ref-lane" | "own";
	material?: string | null;
	[k: string]: unknown;
}

export interface CompositeBlock {
	profile?: string;
	composition_id?: string;
	slots?: Record<string, { bind: { kind: CompositeBinding["kind"] }; label?: string }>;
	resolved?: { bindings?: Record<string, CompositeBinding>; [k: string]: unknown };
	[k: string]: unknown;
}

export interface CompositeDetection {
	kind: CompositeKind;
	block?: CompositeBlock;
	reason?: string;
	compositionId?: string;
}

const ATTR_RE = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(raw: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of raw.matchAll(ATTR_RE)) {
		const name = m[1].toLowerCase();
		if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? "");
	}
	return out;
}

/** 顺序扫描所有 `<script>`：跳过注释，脚本正文不再当作标签扫描。 */
function scanScripts(html: string): Array<{ attrs: Map<string, string>; body: string }> {
	const out: Array<{ attrs: Map<string, string>; body: string }> = [];
	const lower = html.toLowerCase();
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt < 0) break;
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			i = end < 0 ? html.length : end + 3;
			continue;
		}
		if (lower.startsWith("<script", lt) && /[\s>/]/.test(html.charAt(lt + 7))) {
			const tagEnd = html.indexOf(">", lt);
			if (tagEnd < 0) break;
			const attrs = parseAttrs(html.slice(lt + 7, tagEnd));
			const close = lower.indexOf("</script", tagEnd + 1);
			const bodyEnd = close < 0 ? html.length : close;
			out.push({ attrs, body: html.slice(tagEnd + 1, bodyEnd) });
			i = close < 0 ? html.length : bodyEnd + 8;
			continue;
		}
		i = lt + 1;
	}
	return out;
}

/** 颗粒 HTML 中全部合成颗粒元数据块的原文（未解析）。 */
export function findCompositeBlocks(html: unknown): string[] {
	if (typeof html !== "string" || !html.includes(COMPOSITE_MARKER)) return [];
	return scanScripts(html)
		.filter((s) => s.attrs.has(COMPOSITE_MARKER) && (s.attrs.get("type") ?? "").trim().toLowerCase() === "application/json")
		.map((s) => s.body);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(text);
		return v && typeof v === "object" && !Array.isArray(v) ? v : null;
	} catch {
		return null; // 解析兜底：不是合法 JSON 对象即视为无效块
	}
}

/** 判定颗粒身份。`invalid` 的颗粒按「不支持方」处理（出片跳过并提示），MUST NOT 当普通颗粒渲。 */
export function detectComposite(html: unknown): CompositeDetection {
	const blocks = findCompositeBlocks(html);
	if (blocks.length === 0) return { kind: "none" };
	if (blocks.length > 1) {
		return { kind: "invalid", reason: `含 ${blocks.length} 个 data-gtrk-composite 元数据块，只允许一个` };
	}
	const block = parseJsonObject(blocks[0]) as CompositeBlock | null;
	if (!block) return { kind: "invalid", reason: "元数据块不是合法的 JSON 对象" };
	const compositionId = typeof block.composition_id === "string" ? block.composition_id : undefined;
	return { kind: "composite", block, compositionId };
}

/** 合成颗粒 `own` 槽位当前填入的素材 id（重铺剥离时计为「被引用」）。待填充（null）不算。 */
export function ownMaterials(block: CompositeBlock | undefined): string[] {
	const out: string[] = [];
	for (const b of Object.values(block?.resolved?.bindings ?? {})) {
		if (b?.kind === "own" && typeof b.material === "string" && b.material) out.push(b.material);
	}
	return out;
}

/** 出片跳过时对用户的说法（计划 `skipped[].reason` 与 `gtrk mg render` 拒绝同一句）。 */
export function compositeSkipReason(d: CompositeDetection, fallbackId: string): string {
	const id = d.compositionId || fallbackId;
	return d.kind === "invalid"
		? `合成颗粒（${id}）元数据无效，暂不支持渲染，该段按粗剪输出：${d.reason ?? ""}`
		: `合成颗粒（${id}）暂不支持渲染，该段按粗剪输出`;
}

// ── 重铺零引用保护（matrix-lay，design D2）──────────────────────────────────

/** 一次扫描的结果：交给 `layBrollTracks` 的 `compositeRefs`（纯函数不做 IO，读盘在命令层）。 */
export interface CompositeRefScan {
	/** 合成颗粒 `own` 槽位指着的素材 id（去重、首见序）——重铺剥离时 MUST 计为「仍被引用」。 */
	ids: string[];
	/** 读不到 HTML 的颗粒 clip：不知道它是不是合成颗粒、引用了谁 ⇒ 本轮 MUST 一条素材登记都不剥。 */
	readFailures: Array<{ clipId: string; reason: string }>;
}

type LooseBeatClip = { clip_id?: unknown; html?: unknown; html_material?: unknown };

/**
 * 扫工程全部 beat clip。`readHtml` 返回该颗粒的 HTML；颗粒本就没有 HTML 来源（只有 composition 名）时返回
 * `undefined`（不是失败）；读盘失败时抛错（记入 `readFailures`）。
 */
export function scanCompositeOwnRefs(
	gtrk: Record<string, unknown>,
	readHtml: (clip: LooseBeatClip) => string | undefined,
): CompositeRefScan {
	const ids: string[] = [];
	const seen = new Set<string>();
	const readFailures: CompositeRefScan["readFailures"] = [];
	const tracks = Array.isArray(gtrk.beat_track) ? (gtrk.beat_track as Array<{ track_timeline?: LooseBeatClip[] }>) : [];
	for (const t of tracks) {
		for (const clip of t.track_timeline ?? []) {
			let html: string | undefined;
			try {
				html = readHtml(clip);
			} catch (e) {
				readFailures.push({ clipId: String(clip.clip_id ?? "?"), reason: (e as Error).message });
				continue;
			}
			const d = detectComposite(html);
			if (d.kind !== "composite") continue;
			for (const id of ownMaterials(d.block)) {
				if (!seen.has(id)) {
					seen.add(id);
					ids.push(id);
				}
			}
		}
	}
	return { ids, readFailures };
}
