/**
 * RRV 颗粒静态 lint（add-rrv-lay）——六铁律的**机器可判定静态子集**，纯本地零云端。
 *
 * 契约正本 contracts/gsap-emit-v1.md。**只查静态可判定项**——tl 总长≥duration、逐帧非冻结
 * 只有真 Hyperframes 能判（契约明令禁本地无头模拟），留客户端出片期，不在此。
 *
 * 顺带从颗粒 HTML 根 background 声明推导 opaque（权威源是颗粒作者，非可缺省的 dispatch.bg）。
 */

export interface LintViolation {
	law: string;
	fatal: boolean;
	msg: string;
}
export interface LintResult {
	ok: boolean;
	violations: LintViolation[];
	/** 从根 background 推导：有非透明底=true(满屏盖底) / 无或 transparent=false(透明叠加) */
	opaque: boolean;
	/** 解析到的 data-composition-id（拿不到=undefined） */
	compositionId?: string;
}

/** 已知渲染机可达 CDN 白名单（契约铁律5）；jsdelivr 国内不稳=告警非致命。 */
const CDN_OK = [/lib\.baomitu\.com/i, /cdnjs\.cloudflare\.com/i, /unpkg\.com/i];
const CDN_WARN = [/jsdelivr\.net/i];

/** 取根 `<div data-composition-id...>` 的开标签（第一个带 data-composition-id 的元素）。 */
function rootTag(html: string): string | null {
	const m = html.match(/<[a-zA-Z][^>]*\bdata-composition-id\s*=[^>]*>/);
	return m ? m[0] : null;
}

function attr(tag: string, name: string): string | undefined {
	const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
	return m ? m[1] : undefined;
}

/** 根 style 里的 background 声明 → 是否非透明底。无声明/transparent/none = 透明叠加。 */
function deriveOpaque(rootTagStr: string | null): { opaque: boolean; declared: boolean } {
	if (!rootTagStr) return { opaque: false, declared: false };
	const style = attr(rootTagStr, "style") ?? "";
	const bg = style.match(/background(?:-color)?\s*:\s*([^;"']+)/i);
	if (!bg) return { opaque: false, declared: false };
	const val = bg[1].trim().toLowerCase();
	const transparent = val === "transparent" || val === "none" || /rgba\([^)]*,\s*0\s*\)/.test(val);
	return { opaque: !transparent, declared: true };
}

/** 一期品类→期望透明度（与 splitdoc CATEGORY_EXPECTED_OPAQUE 同源，此处独立避跨包依赖）。 */
const CATEGORY_EXPECTED_OPAQUE: Record<string, boolean> = {
	"rrv-overlay": false,
	"mg-fullscreen": true,
	"explain-subtitle": false,
	"op-ed-title": true,
};

export function lintParticle(
	html: string,
	opts: { compositionId?: string; dispatchIds?: string[]; category?: string } = {},
): LintResult {
	const v: LintViolation[] = [];
	const push = (law: string, fatal: boolean, msg: string) => v.push({ law, fatal, msg });

	// 铁律1：<template> 包裹 + 根 data-* 三件
	if (!/<template[\s>]/i.test(html)) push("1-template", true, "缺 <template> 包裹根元素（裸 div 整片渲染失败）");
	const root = rootTag(html);
	const cid = root ? attr(root, "data-composition-id") : undefined;
	if (!root || !cid) push("1-composition-id", true, "根元素缺 data-composition-id");
	if (root) {
		if (attr(root, "data-width") !== "1920") push("1-width", true, `根 data-width 应为 "1920"（实为 ${attr(root, "data-width") ?? "缺"}）`);
		if (attr(root, "data-height") !== "1080") push("1-height", true, `根 data-height 应为 "1080"（实为 ${attr(root, "data-height") ?? "缺"}）`);
	}

	// 铁律2：paused timeline + __timelines 注册且 id 匹配（空白宽容；接受字面量与 var 常量两惯例）
	if (!/gsap\.timeline\s*\(\s*\{[^}]*\bpaused\s*:\s*true\b[^}]*\}\s*\)/.test(html))
		push("2-paused", true, "缺 gsap.timeline({ paused: true })");
	// 注册键可为字符串字面量 __timelines["id"] 或标识符 __timelines[ID]（ID 由 var/const/let 赋字面串）
	const regMatch = html.match(/window\.__timelines\s*\[\s*(["']([^"']+)["']|[A-Za-z_$][\w$]*)\s*\]\s*=/);
	if (!regMatch) push("2-register", true, "缺 window.__timelines[<id>] = 注册");
	else {
		let regId: string | undefined = regMatch[2]; // 字面量
		if (regId === undefined) {
			// 标识符：解析其 var/const/let 赋值的字面串
			const ident = regMatch[1];
			const vm = html.match(new RegExp(`(?:var|const|let)\\s+${ident}\\s*=\\s*["']([^"']+)["']`));
			regId = vm?.[1];
			if (!regId) push("2-register", true, `__timelines[${ident}] 的 ${ident} 未见字面串赋值，无法静态判定注册 id`);
		}
		if (cid && regId !== undefined && regId !== cid)
			push("2-id-match", true, `__timelines 注册 id "${regId}" 与 data-composition-id "${cid}" 不一致`);
	}

	// 铁律3：确定性（禁 random/Date）
	if (/Math\.random\s*\(/.test(html)) push("3-random", true, "含 Math.random()（破 StaticGuard，逐帧不确定）");
	if (/Date\.now\s*\(/.test(html)) push("3-date-now", true, "含 Date.now()");
	if (/new\s+Date\s*\(\s*\)/.test(html)) push("3-new-date", true, "含无参 new Date()");

	// 铁律4 前半：自包含——script src 必 http(s)，无相对外链
	for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
		const src = m[1];
		if (!/^https?:\/\//i.test(src)) push("4-script-rel", true, `<script src> 非 http(s) 绝对 url：${src}`);
		else if (CDN_WARN.some((r) => r.test(src))) push("5-cdn-jsdelivr", false, `CDN 用 jsdelivr（国内渲染机不稳，建议 lib.baomitu.com）：${src}`);
		else if (!CDN_OK.some((r) => r.test(src))) push("5-cdn-unknown", false, `CDN 不在已知可达白名单（渲染机可能拉不到）：${src}`);
	}
	// 其他相对外链（img/link/use/url()）——违反自包含
	for (const [re, tag] of [
		[/<img\b[^>]*\bsrc\s*=\s*["'](?!https?:|data:)[^"']+["']/gi, "<img src>"],
		[/<link\b[^>]*\bhref\s*=\s*["'](?!https?:|data:)[^"']+["']/gi, "<link href>"],
		[/<use\b[^>]*\b(?:xlink:)?href\s*=\s*["'](?!#|https?:|data:)[^"']+["']/gi, "<use href>"],
		[/\burl\(\s*["']?(?!https?:|data:|#)[^)"']+["']?\s*\)/gi, "css url()"],
	] as [RegExp, string][]) {
		if (re.test(html)) push("4-rel-asset", true, `含相对外链 ${tag}（违反自包含，渲染机读不到）`);
	}

	// 铁律4 后半：根 background 声明存在（透明与否必须显式）
	const { opaque, declared } = deriveOpaque(root);
	if (root && !declared)
		push("4-bg-explicit", false, "根未显式声明 background（透明与否应明确；缺省按透明叠加 opaque=false 处理）");

	// 铁律6：禁 var()
	if (/var\(\s*--/.test(html)) push("6-css-var", true, "含 CSS var(--...)（Hyperframes 不解析→整片全黑，须字面值）");

	// 派生：composition_id 对齐 dispatch
	const effectiveCid = opts.compositionId ?? cid;
	if (opts.dispatchIds && effectiveCid && !opts.dispatchIds.includes(effectiveCid))
		push("x-dispatch", false, `composition_id "${effectiveCid}" 不在 dispatch.rrv_mg 派单中`);

	// 品类↔opaque 对账（裁决⑩，声明+校验；以 HTML 反推 opaque 为准，不符只告警）
	if (opts.category && opts.category in CATEGORY_EXPECTED_OPAQUE) {
		const expect = CATEGORY_EXPECTED_OPAQUE[opts.category];
		if (expect !== opaque)
			push("x-category-opaque", false, `category「${opts.category}」期望${expect ? "不透明满屏" : "透明叠加"}，但颗粒 HTML 反推为${opaque ? "不透明满屏" : "透明叠加"}（以 HTML 为准落 clip.opaque=${opaque}）`);
	}

	return { ok: !v.some((x) => x.fatal), violations: v, opaque, compositionId: cid };
}
