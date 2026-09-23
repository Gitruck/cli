/**
 * Hyperframes registry block → gtrk MG 颗粒的**机械改写**与**兼容预筛**（change add-mg-registry-neutral-source · design D2 / D4）。
 *
 * 纯函数、零 I/O：输入块 HTML 字符串与目标参数，输出改写后 HTML + 逐条日志 + 可改点清单。
 * 改写只做机械项（template 包裹 / 改 id / 去 data-start 贴坑位 / 实心底下沉 / GSAP 源 / 字体 / 时长贴坑位 / 画布贴合）；
 * **内容与审美归 agent 改写**（spec「中性块的内容与审美 MUST 由 agent 改写」），本模块 MUST NOT 套色板。
 *
 * 契约对照（contracts/gsap-emit-v1.md 八铁律 + mg-lint.ts 可判子集）见 design.md D2 表；改写后调用方 MUST 跑 lintParticle 致命项。
 *
 * ⚠️ 画布：lint 铁律 1 硬要求根 `data-width="1920" data-height="1080"`（`1-width` / `1-height` 致命），
 * 故本模块**只产 1920×1080 颗粒**；块尺寸不同时用信箱缩放贴进 1920×1080，**MUST NOT 拉伸**。
 * 提案里「竖屏工程根改 1080×1920」与契约冲突，按「工件偏了」订正：非 1920×1080 画布由命令层拒绝并提示走栏目 skill。
 */
import { estimateTimelineSec } from "./mg-lint";

/** 契约铁律 5 指定的 GSAP CDN（lint CDN_OK 白名单）。 */
export const CONTRACT_GSAP_SRC = "https://lib.baomitu.com/gsap/3.13.0/gsap.min.js";
/**
 * 缺省字体。
 *
 * ⟲ 2026-09-16（change: link-cloud-font-library）原注释「运行时资产镜像里**唯一**可证的 CJK 字体
 * （manifest `font` 项）」已过时：字体源已统一到同合云字体库，可分发中文字体现有 **48 族 / 184 款**，
 * 不再是唯一一款。本值保持不变——改它会改变存量颗粒的渲染结果，属行为变更、不在本件射程。
 *
 * 授权：对应字体 = 思源黑体 CN（SIL OFL），2026-09-16 实测在可分发清单内。
 *
 * ⚠️ **留碑：这个名字是「族名 + 字重」混写**，规范形态应是族名 `Source Han Sans CN` + `font-weight: 700`。
 * 服务端 `font_services._assign_face_ids` 的注释记过这条的代价：把字重并进族名且不带 weight 描述符，
 * 会让 CSS 认为该族只有 400 一档，请求 bold 时在**已经是粗体**的字形上再合成一层加粗。
 * 本仓 `subtitle-lay.SUBTITLE_FONT_FAMILY`（`思源黑体 CN Bold`）是同一形态，但那条走 libass、
 * 按 name 表 family 匹配而该文件确有此记录，故对字幕链**不是缺陷**；HTML/CSS 这条才是。
 * 收口归另件，本件只登记不动值。
 */
export const DEFAULT_FONT = "Source Han Sans CN Bold";
export const PARTICLE_W = 1920;
export const PARTICLE_H = 1080;
/** 铁律 8 高危形态的 tag 集（重复图元：网格 / 排线 / 噪点 / 半调 / 扫描线）——命中即 `review`，须真渲验收。 */
export const HIGH_RISK_TAGS: readonly string[] = ["grain", "scanline", "scanlines", "noise", "grid", "halftone", "static", "stripes", "stripe"];

export type Compat = "ok" | "review" | "excluded";

export interface RegistryItemLike {
	name: string;
	tags?: string[];
	width?: number;
	height?: number;
	duration?: number;
	files?: { path: string; target?: string; type?: string }[];
}

export interface PrescreenResult {
	compat: Compat;
	reasons: string[];
}

export interface AdoptOptions {
	/** 目标 composition_id（派单模式 = `<工程slug>-<beatId>`）。 */
	compositionId: string;
	/** 坑位包络（秒）。 */
	slotSec: number;
	/** 透明叠加 / 满屏；缺省按块自身底色推断（body / 根有实色底 ⇒ fullscreen）。 */
	category?: "overlay" | "fullscreen";
	font?: string;
	gsapSrc?: string;
	/** 块尺寸（registry-item dimensions）；缺省从根 data-width/height 读，再缺省 1920×1080。 */
	blockWidth?: number;
	blockHeight?: number;
	/** registry 声明的块时长（秒）；静态估长算不出时以它为准做压速 / 驻留，缺省读根 data-duration。 */
	declaredDurationSec?: number;
}

export interface AdoptResult {
	html: string;
	/** 逐条改写日志（做了什么、改了哪些节点）。 */
	log: string[];
	/** 推断出的品类（用于 lint category 与 dispatch 对齐）。 */
	category: "overlay" | "fullscreen";
	/** 可改点清单：文案 / 数值数组 / 色值——给 agent 定位「内容与审美」改写处。 */
	editable: { texts: string[]; numberArrays: string[]; colors: string[] };
	/** 时长贴坑位的处置。 */
	timing: { estimatedSec: number; slotSec: number; action: "timeScale" | "hold" | "hold-unestimated" | "none"; factor?: number };
}

export class AdoptError extends Error {
	constructor(
		message: string,
		public readonly reason: string,
	) {
		super(message);
		this.name = "AdoptError";
	}
}

// ── 小工具 ───────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sectionInner(html: string, tag: "head" | "body"): string | undefined {
	const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
	return m ? m[1] : undefined;
}

/** 根开标签：第一个带 data-composition-id 的元素（允许多行属性）。 */
function findRootOpen(html: string): { tag: string; open: string; start: number; end: number; cid: string } | undefined {
	const re = /<([a-zA-Z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?\bdata-composition-id\s*=\s*(?:"([^"]+)"|'([^']+)')(?:[^>"']|"[^"]*"|'[^']*')*>/;
	const m = re.exec(html);
	if (!m) return undefined;
	return { tag: m[1], open: m[0], start: m.index, end: m.index + m[0].length, cid: m[2] ?? m[3] };
}

/** 从根开标签末尾起，跳过 script/style/注释内容，按同名标签深度找匹配闭合标签；返回闭合标签的起止位置。 */
function findMatchingClose(html: string, from: number, tag: string): { start: number; end: number } | undefined {
	const t = tag.toLowerCase();
	let depth = 1;
	let i = from;
	const n = html.length;
	while (i < n) {
		const lt = html.indexOf("<", i);
		if (lt < 0) return undefined;
		const rest = html.slice(lt, lt + 12).toLowerCase();
		if (rest.startsWith("<!--")) {
			const e = html.indexOf("-->", lt + 4);
			i = e < 0 ? n : e + 3;
			continue;
		}
		if (rest.startsWith("<script")) {
			const e = html.toLowerCase().indexOf("</script>", lt);
			i = e < 0 ? n : e + 9;
			continue;
		}
		if (rest.startsWith("<style")) {
			const e = html.toLowerCase().indexOf("</style>", lt);
			i = e < 0 ? n : e + 8;
			continue;
		}
		const closeRe = new RegExp(`^</${t}\\s*>`, "i");
		const openRe = new RegExp(`^<${t}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "i");
		const slice = html.slice(lt);
		const cm = closeRe.exec(slice);
		if (cm) {
			depth -= 1;
			if (depth === 0) return { start: lt, end: lt + cm[0].length };
			i = lt + cm[0].length;
			continue;
		}
		const om = openRe.exec(slice);
		if (om) {
			if (!/\/\s*>$/.test(om[0])) depth += 1;
			i = lt + om[0].length;
			continue;
		}
		i = lt + 1;
	}
	return undefined;
}

function attrOf(open: string, name: string): string | undefined {
	const m = open.match(new RegExp(`\\b${esc(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
	return m ? (m[1] ?? m[2]) : undefined;
}

function setAttr(open: string, name: string, value: string): string {
	const re = new RegExp(`\\s${esc(name)}\\s*=\\s*(?:"[^"]*"|'[^']*')`, "i");
	if (re.test(open)) return open.replace(re, ` ${name}="${value}"`);
	return open.replace(/\s*\/?>$/, (m) => ` ${name}="${value}"${m.trim()}`);
}

function dropAttr(open: string, name: string): string {
	return open.replace(new RegExp(`\\s${esc(name)}\\s*=\\s*(?:"[^"]*"|'[^']*')`, "gi"), "");
}

/** 取 style 属性里某声明的值（最后一次出现）。 */
function styleDecl(style: string, prop: RegExp): string | undefined {
	let last: string | undefined;
	for (const m of style.matchAll(new RegExp(`(?:^|;)\\s*(${prop.source})\\s*:\\s*([^;]+)`, "gi"))) last = m[2].trim();
	return last;
}

function stripStyleDecl(style: string, prop: RegExp): string {
	return style
		.replace(new RegExp(`(?:^|;)\\s*(?:${prop.source})\\s*:[^;]*`, "gi"), "")
		.replace(/^\s*;\s*/, "")
		.trim();
}

const BG_PROP = /background(?:-color|-image)?/;

/** 是否「非透明」底色字面值。 */
function isSolid(v: string | undefined): boolean {
	if (!v) return false;
	const s = v.trim().toLowerCase();
	if (s === "none" || s === "transparent" || s === "initial" || s === "inherit" || s === "unset") return false;
	if (/rgba?\([^)]*,\s*0\s*\)/.test(s)) return false;
	return true;
}

/**
 * 顶层 CSS 规则枚举（深度 0 的 `selector { body }`；`@` 规则整块原样透传）。
 * 只用于头部 `<style>` 的作用域化与 html/body 规则清除，不做完整 CSS 解析。
 */
function mapTopLevelRules(css: string, fn: (selector: string, body: string) => string | null): string {
	const out: string[] = [];
	let i = 0;
	const n = css.length;
	while (i < n) {
		const brace = css.indexOf("{", i);
		if (brace < 0) {
			out.push(css.slice(i));
			break;
		}
		const selector = css.slice(i, brace);
		// 找匹配的 }
		let depth = 1;
		let j = brace + 1;
		while (j < n && depth > 0) {
			const ch = css[j];
			if (ch === "{") depth += 1;
			else if (ch === "}") depth -= 1;
			j += 1;
		}
		const body = css.slice(brace + 1, j - 1);
		const sel = selector.trim();
		if (sel.startsWith("@")) {
			out.push(`${selector}{${body}}`);
		} else {
			const r = fn(sel, body);
			if (r !== null) out.push(r);
		}
		i = j;
	}
	return out.join("\n");
}

function isDocLevelSelector(sel: string): boolean {
	return sel
		.split(",")
		.map((s) => s.trim())
		.every((s) => /^(html|body|:root)$/i.test(s));
}

/** 把头部全局样式收进颗粒作用域：html/body/:root 规则整条丢；其余选择器前缀根选择器（已含根选择器的不重复前缀）。 */
function scopeGlobalCss(css: string, rootSel: string): { css: string; droppedDocRules: number; scoped: number } {
	let droppedDocRules = 0;
	let scoped = 0;
	const out = mapTopLevelRules(css, (sel, body) => {
		if (!sel) return null;
		if (isDocLevelSelector(sel)) {
			droppedDocRules += 1;
			return null;
		}
		const parts = sel.split(",").map((s) => s.trim()).filter(Boolean);
		const mapped = parts.map((p) => {
			if (p.includes("data-composition-id")) return p;
			if (/^(html|body|:root)\b/i.test(p)) return p.replace(/^(html|body|:root)\b\s*/i, `${rootSel} `);
			scoped += 1;
			return `${rootSel} ${p}`;
		});
		return `${mapped.join(", ")} {${body}}`;
	});
	return { css: out, droppedDocRules, scoped };
}

/** 从头部样式里读 body 底色（供 fullscreen 推断与 bgfill 取色）。 */
function docBackground(css: string): string | undefined {
	let found: string | undefined;
	mapTopLevelRules(css, (sel, body) => {
		if (isDocLevelSelector(sel)) {
			const v = styleDecl(body.replace(/\s+/g, " "), BG_PROP);
			if (v !== undefined) found = v;
		}
		return null;
	});
	return found;
}

function replaceFontFamilies(s: string, font: string): { out: string; count: number } {
	let count = 0;
	const out = s.replace(/font-family\s*:\s*[^;}"']+(?:"[^"]*"[^;}]*|'[^']*'[^;}]*)*/gi, () => {
		count += 1;
		return `font-family: "${font}", sans-serif`;
	});
	return { out, count };
}

/** CSS token boundaries: quoted URLs and comments may themselves contain semicolons. */
function stripCssImports(css: string): { css: string; count: number } {
	const tokens = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|@import\b/gi;
	let out = "", start = 0, count = 0;
	for (let m; (m = tokens.exec(css));) {
		if (!/^@import$/i.test(m[0])) continue;
		let quote = "", depth = 0, end = tokens.lastIndex;
		for (; end < css.length; end++) {
			const ch = css[end];
			if (ch === "\\") { end++; continue; }
			if (quote) { if (ch === quote) quote = ""; continue; }
			if (ch === '"' || ch === "'") { quote = ch; continue; }
			if (ch === "/" && css[end + 1] === "*") {
				const close = css.indexOf("*/", end + 2);
				if (close < 0) break;
				end = close + 1; continue;
			}
			if (ch === "(") depth++;
			if (ch === ")") depth--;
			if (ch === ";" && depth === 0) break;
		}
		if (css[end] !== ";" || quote || depth !== 0) continue;
		out += css.slice(start, m.index);
		start = end + 1;
		tokens.lastIndex = start;
		count++;
	}
	return { css: out + css.slice(start), count };
}

// ── 预筛（发版期脚本与取块态共用）───────────────────────────────────────────

/**
 * 子元素上的可见窗属性（根之外）：`data-start≠0`、`data-end`、以及 **短于根时长**的 `data-duration` 才算「有语义的窗」。
 * `data-start="0"` + `data-duration=根时长` 的全窗子元素（registry 里常见的「整块一层」写法）对预览无影响，不计。
 */
function childTimingAttrs(rootInner: string, rootDurationSec: number | undefined): { nonZeroStart: number; windows: number } {
	let nonZeroStart = 0;
	let windows = 0;
	for (const m of rootInner.matchAll(/<[a-zA-Z][\w-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
		const tag = m[0];
		const st = attrOf(tag, "data-start");
		const du = attrOf(tag, "data-duration");
		const en = attrOf(tag, "data-end");
		if (st !== undefined && Number(st) !== 0) nonZeroStart += 1;
		if (en !== undefined) windows += 1;
		if (du !== undefined) {
			const d = Number(du);
			if (!(rootDurationSec !== undefined && Number.isFinite(d) && d >= rootDurationSec - 1e-6)) windows += 1;
		}
	}
	return { nonZeroStart, windows };
}

export function prescreenBlock(html: string, item: RegistryItemLike): PrescreenResult {
	const reasons: string[] = [];
	let compat: Compat = "ok";
	const exclude = (r: string) => {
		compat = "excluded";
		reasons.push(r);
	};
	const review = (r: string) => {
		if (compat !== "excluded") compat = "review";
		reasons.push(r);
	};

	const files = item.files ?? [];
	const nonHtml = files.filter((f) => !/\.html?$/i.test(f.path));
	if (files.length > 1 || nonHtml.length > 0) exclude(`多文件块（${files.map((f) => f.path).join(", ")}）：颗粒 MUST 自包含`);

	const root = findRootOpen(html);
	if (!root) exclude("找不到 data-composition-id 根元素");
	if (/data-composition-src/i.test(html)) exclude("含 data-composition-src 嵌套子合成：客户端预览不实现嵌套");

	for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
		if (!/gsap(?:\.min)?\.js/i.test(m[1])) exclude(`引外部库脚本 ${m[1]}：客户端只执行 GSAP vendor 与内联脚本`);
	}
	if (/Math\.random\s*\(/.test(html)) exclude("含 Math.random()（lint 铁律 3 致命）");
	if (/Date\.now\s*\(|new\s+Date\s*\(\s*\)/.test(html)) exclude("含 Date.now / new Date()（lint 铁律 3 致命）");
	if (/var\(\s*--/.test(html)) exclude("含 CSS var(--…)（lint 铁律 6 致命）");
	if (/<video\b|<audio\b/i.test(html)) exclude("含 <video>/<audio> 媒体元素：颗粒 MUST 自包含且客户端预览不承载媒体");
	for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
		if (/^https?:\/\//i.test(m[1])) exclude(`外链图片 ${m[1]}：颗粒 MUST 自包含`);
	}
	if (root) {
		const close = findMatchingClose(html, root.end, root.tag);
		const inner = close ? html.slice(root.end, close.start) : "";
		const rootDur = Number(attrOf(root.open, "data-duration"));
		const t = childTimingAttrs(inner, Number.isFinite(rootDur) && rootDur > 0 ? rootDur : item.duration);
		if (t.nonZeroStart > 0 || t.windows > 0) exclude(`子元素带 data-start≠0 / data-duration / data-end（${t.nonZeroStart + t.windows} 处）：Hyperframes 可见窗语义客户端预览不实现`);
	}
	if (/requestAnimationFrame\s*\(|setInterval\s*\(/.test(html)) review("含 requestAnimationFrame / setInterval 自有时钟：逐帧渲染可能冻结，须人眼确认（lint x-raf-interval）");
	if (/<canvas\b/i.test(html)) review("含 <canvas>（WebGL / 2D）：客户端预览按 DOM 快照呈现不含画布像素，只有真渲能看");
	const tags = (item.tags ?? []).map((t) => t.toLowerCase());
	const hit = tags.filter((t) => HIGH_RISK_TAGS.includes(t));
	if (hit.length > 0) review(`铁律 8 高危形态（tags: ${hit.join(", ")}），待真渲验收`);
	if (!/gsap\s*\.\s*timeline\s*\(/.test(html)) exclude("未见 gsap.timeline(：不是 GSAP 时间线块");
	if (!/window\s*\.\s*__timelines\s*\[/.test(html)) exclude("未见 window.__timelines 注册");
	return { compat, reasons };
}

// ── 改写 ─────────────────────────────────────────────────────────────────

export function adoptBlock(srcHtml: string, opts: AdoptOptions): AdoptResult {
	const log: string[] = [];
	const newId = opts.compositionId;
	const font = opts.font ?? DEFAULT_FONT;
	const gsapSrc = opts.gsapSrc ?? CONTRACT_GSAP_SRC;
	const slot = opts.slotSec;
	if (!(slot > 0)) throw new AdoptError("坑位包络必须为正数秒", "slot");

	// 0. 拆文档：head / body（无 body 视为整段即 body）
	const headInner = sectionInner(srcHtml, "head") ?? "";
	const bodyInner = sectionInner(srcHtml, "body") ?? srcHtml;

	const root = findRootOpen(bodyInner);
	if (!root) throw new AdoptError("找不到 data-composition-id 根元素", "no-root");
	const close = findMatchingClose(bodyInner, root.end, root.tag);
	if (!close) throw new AdoptError("根元素闭合标签找不到", "no-close");
	const oldId = root.cid;
	let rootOpen = root.open;
	let inner = bodyInner.slice(root.end, close.start);
	const outside = bodyInner.slice(0, root.start) + bodyInner.slice(close.end);
	log.push(`根元素 <${root.tag} data-composition-id="${oldId}">，根内 ${inner.length} 字节，根外 ${outside.trim().length} 字节`);

	// 1. 外部脚本：只允许 GSAP；其余 → 拒改
	const scriptSrcs: string[] = [];
	for (const m of (headInner + bodyInner).matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi)) scriptSrcs.push(m[1]);
	const foreign = scriptSrcs.filter((s) => !/gsap(?:\.min)?\.js/i.test(s));
	if (foreign.length > 0) throw new AdoptError(`引外部库脚本，拒绝改写：${foreign.join(", ")}`, "foreign-script");
	const stripSrcScripts = (s: string) => s.replace(/<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>\s*<\/script>/gi, "");

	// 2. 头部资源：字体 <link> / @import 去掉；头部 <style> 收集；头部内联脚本收集
	let importN = 0;
	const cleanCss = (css: string) => {
		const r = stripCssImports(css);
		importN += r.count;
		return r.css;
	};
	const headStyles = [...headInner.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => cleanCss(m[1]));
	const headInlineScripts = [...stripSrcScripts(headInner).matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
	const droppedLinks = (headInner.match(/<link\b[^>]*>/gi) ?? []).length;
	if (droppedLinks) log.push(`去掉头部 <link> ${droppedLinks} 个（字体外链 / preconnect）`);
	// 根外（body 里根之后）的内联脚本 / 样式也收进来
	const outsideScripts = [...stripSrcScripts(outside).matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
	const outsideStyles = [...outside.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => cleanCss(m[1]));
	inner = inner.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_m, attrs, css) => `<style${attrs}>${cleanCss(css)}</style>`);
	if (outsideScripts.length) log.push(`根外内联脚本 ${outsideScripts.length} 段移入根内末尾（客户端只执行 template 内脚本）`);
	if (outsideStyles.length) log.push(`根外 <style> ${outsideStyles.length} 段收进根作用域`);

	// 3. 品类推断（在改写底色之前读原始底色）
	const rootStyle = attrOf(rootOpen, "style") ?? "";
	const rootBg = styleDecl(rootStyle, BG_PROP);
	const docBg = docBackground(headStyles.concat(outsideStyles).join("\n"));
	let rootRuleBg: string | undefined;
	const rootSelOld = `[data-composition-id="${oldId}"]`;
	const rootIdAttr = attrOf(rootOpen, "id");
	const allCss = headStyles.concat(outsideStyles, [...inner.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1])).join("\n");
	mapTopLevelRules(allCss, (sel, body) => {
		const s = sel.trim();
		if (s === rootSelOld || (rootIdAttr && s === `#${rootIdAttr}`)) {
			const v = styleDecl(body.replace(/\s+/g, " "), BG_PROP);
			if (v !== undefined) rootRuleBg = v;
		}
		return null;
	});
	const solidBg = [rootBg, rootRuleBg, docBg].find((v) => isSolid(v));
	const category: "overlay" | "fullscreen" = opts.category ?? (solidBg ? "fullscreen" : "overlay");
	log.push(`品类：${category}${opts.category ? "（派单指定）" : `（按底色推断：root=${rootBg ?? "-"} rule=${rootRuleBg ?? "-"} body=${docBg ?? "-"}）`}`);

	// 4. 头部 / 根外样式收进作用域（html/body 规则整条丢，其余前缀根选择器；此时仍用旧 id，稍后统一改名）
	let scopedCss = "";
	let dropped = 0;
	let scopedN = 0;
	for (const css of headStyles.concat(outsideStyles)) {
		const r = scopeGlobalCss(css, rootSelOld);
		scopedCss += `${r.css}\n`;
		dropped += r.droppedDocRules;
		scopedN += r.scoped;
	}
	if (headStyles.length + outsideStyles.length) log.push(`头部样式：丢 html/body/:root 规则 ${dropped} 条，作用域化选择器 ${scopedN} 个`);

	// 5. 根元素：去 data-start，data-duration 贴坑位，尺寸钉 1920×1080，实心底下沉
	rootOpen = dropAttr(rootOpen, "data-start");
	rootOpen = setAttr(rootOpen, "data-duration", String(slot));
	const bw = opts.blockWidth ?? (Number(attrOf(rootOpen, "data-width")) || PARTICLE_W);
	const bh = opts.blockHeight ?? (Number(attrOf(rootOpen, "data-height")) || PARTICLE_H);
	rootOpen = setAttr(rootOpen, "data-width", String(PARTICLE_W));
	rootOpen = setAttr(rootOpen, "data-height", String(PARTICLE_H));
	let newRootStyle = stripStyleDecl(rootStyle, BG_PROP);
	// 根几何：绝对定位铺满 1920×1080（覆盖块自带的 width/height）
	newRootStyle = stripStyleDecl(newRootStyle, /width|height|position|inset|top|left/);
	newRootStyle = `position:absolute;inset:0;width:${PARTICLE_W}px;height:${PARTICLE_H}px;overflow:hidden;${category === "overlay" ? "background:transparent;" : "background:transparent;"}${newRootStyle ? `${newRootStyle};` : ""}`;
	rootOpen = setAttr(rootOpen, "style", newRootStyle.replace(/;;+/g, ";"));
	log.push(`根：去 data-start，data-duration=${slot}，尺寸 ${PARTICLE_W}×${PARTICLE_H}，根底色改 transparent（铁律 4 根零视觉）`);

	// 6. 子元素的可见窗属性整体去掉：预筛已保证剩下的只有「全窗」子元素（start 0 + duration = 根时长），
	//    但服务端 Hyperframes 会照 data-duration 在窗末隐藏元素——坑位比块长时最后几秒会空掉（破铁律 7 终态驻留）。
	//    去掉后元素随根整段在场；根自己的 data-duration 已贴坑位。
	const childWin = (inner.match(/\sdata-(?:start|duration|track-index)\s*=\s*["'][^"']*["']/gi) ?? []).length;
	inner = inner.replace(/\sdata-(?:start|duration|track-index)\s*=\s*["'][^"']*["']/gi, "");
	if (childWin) log.push(`去掉子元素 data-start / data-duration / data-track-index ${childWin} 处（全窗子元素改为随根整段在场）`);

	// 7. 画布贴合：块尺寸 ≠ 1920×1080 ⇒ 信箱缩放包一层（不拉伸）
	let fitOpen = "";
	let fitClose = "";
	if (bw !== PARTICLE_W || bh !== PARTICLE_H) {
		const k = Math.min(PARTICLE_W / bw, PARTICLE_H / bh);
		fitOpen = `<div class="gtrk-fit" style="position:absolute;left:50%;top:50%;width:${bw}px;height:${bh}px;transform:translate(-50%,-50%) scale(${Number(k.toFixed(4))});transform-origin:center center;">`;
		fitClose = "</div>";
		log.push(`画布贴合：块 ${bw}×${bh} → 信箱缩放 ×${k.toFixed(4)} 居中进 ${PARTICLE_W}×${PARTICLE_H}（不拉伸）`);
	}

	// 8. 实心底：fullscreen ⇒ 根下首个全幅子层承载；根 / 根选择器规则里的 background 去掉
	let bgfill = "";
	if (category === "fullscreen") {
		bgfill = `<div class="gtrk-bgfill" style="position:absolute;inset:0;background:${solidBg ?? "#000000"};z-index:0;"></div>`;
		log.push(`实心底下沉：根下首个全幅子层 background:${solidBg ?? "#000000"}（铁律 4①）`);
	}
	const stripRootRuleBg = (css: string) =>
		mapTopLevelRules(css, (sel, body) => {
			const s = sel.trim();
			if (s === rootSelOld || (rootIdAttr && s === `#${rootIdAttr}`)) return `${sel} {${body.replace(/(?:^|;)\s*background(?:-color|-image)?\s*:[^;]*/gi, "")}}`;
			return `${sel} {${body}}`;
		});
	scopedCss = stripRootRuleBg(scopedCss);
	inner = inner.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (m, a, css) => `<style${a}>${stripRootRuleBg(css)}</style>`);

	// 9. 字体：所有 font-family 声明换成指定字体；@import 去掉
	const f1 = replaceFontFamilies(scopedCss, font);
	const f2 = replaceFontFamilies(inner, font);
	const f3 = replaceFontFamilies(rootOpen, font);
	scopedCss = f1.out;
	inner = f2.out;
	rootOpen = f3.out;
	log.push(`字体：font-family 声明 ${f1.count + f2.count + f3.count} 处 → "${font}"${importN ? `；去 @import ${importN} 条` : ""}`);

	// 10. 组装：<template><root>bgfill + fit(inner) + scoped style + gsap + scripts + 时长修正</root></template>
	const scripts = [...headInlineScripts, ...outsideScripts];
	const assembledInner = [
		bgfill,
		fitOpen,
		inner,
		fitClose,
		scopedCss.trim() ? `<style>${scopedCss}</style>` : "",
		`<script src="${gsapSrc}"></script>`,
		...scripts.map((s) => `<script>${s}</script>`),
	]
		.filter(Boolean)
		.join("\n");
	let html = `<template>\n${rootOpen}\n${assembledInner}\n</${root.tag}>\n</template>\n`;
	log.push(`GSAP 源 → ${gsapSrc}（原：${scriptSrcs.join(", ") || "无"}）`);

	// 11. 改 id：data-composition-id / __timelines 键 / 选择器 / 字符串字面量 / #id
	const q = esc(oldId);
	const before = html;
	html = html
		.replace(new RegExp(`data-composition-id\\s*=\\s*(["'])${q}\\1`, "g"), `data-composition-id="${newId}"`)
		.replace(new RegExp(`__timelines\\s*\\[\\s*(["'])${q}\\1\\s*\\]`, "g"), `__timelines["${newId}"]`)
		.replace(new RegExp(`\\[data-composition-id=(["'])${q}\\1\\]`, "g"), `[data-composition-id="${newId}"]`)
		.replace(new RegExp(`(["'])${q}\\1`, "g"), `"${newId}"`);
	if (rootIdAttr) {
		const qi = esc(rootIdAttr);
		html = html
			.replace(new RegExp(`\\bid\\s*=\\s*(["'])${qi}\\1`), `id="${newId}"`)
			.replace(new RegExp(`#${qi}(?![\\w-])`, "g"), `#${newId}`)
			.replace(new RegExp(`getElementById\\(\\s*(["'])${qi}\\1\\s*\\)`, "g"), `getElementById("${newId}")`);
	}
	const renamed = (before.match(new RegExp(q, "g")) ?? []).length - (html.match(new RegExp(q, "g")) ?? []).length;
	log.push(`改 id：${oldId} → ${newId}（替换 ${renamed} 处）`);

	// 12. 时长贴坑位（铁律 7）：无限循环 → 有限次；估长 > 坑位 → timeScale；< 坑位 → 末尾驻留补间
	if (/repeat\s*:\s*-1/.test(html)) {
		const times = Math.max(1, Math.ceil(slot * 4));
		html = html.replace(/repeat\s*:\s*-1/g, `repeat: ${times}`);
		log.push(`repeat:-1 → repeat: ${times}（按坑位 ${slot}s 以 0.25s/圈保守折算，铁律 7 禁无限循环）`);
	}
	const est = estimateTimelineSec(html);
	const declared = opts.declaredDurationSec ?? (Number(attrOf(root.open, "data-duration")) || undefined);
	const estimable = est.parsed > 0 && Number.isFinite(est.est) && est.est > 0;
	// 静态估长是**下界**；算不出时回落 registry 声明时长（块作者标的播放长度），仍算不出才盲补驻留
	const known = estimable ? est.est : declared && declared > 0 ? declared : undefined;
	const basis = estimable ? "静态估长" : known ? "registry 声明时长" : "无";
	let timing: AdoptResult["timing"] = { estimatedSec: known ?? 0, slotSec: slot, action: "none" };
	let fix = "";
	if (known === undefined) {
		// 驻留补间带**绝对 position 0**：lint 的估长取 max(pos+span)，无 position 的补间只进「链式累加」那一支、算不进去
		fix = `t.to({}, { duration: ${slot} }, 0);`;
		timing = { estimatedSec: 0, slotSec: slot, action: "hold-unestimated" };
		log.push(`时长：无法静态估长且无声明时长，补 ${slot}s 驻留补间（position 0）保证总长 ≥ 坑位`);
	} else if (known > slot + 0.05) {
		const k = Number((known / slot).toFixed(3));
		fix = `t.timeScale(${k});`;
		timing = { estimatedSec: known, slotSec: slot, action: "timeScale", factor: k };
		log.push(`时长：${basis} ~${known}s > 坑位 ${slot}s → timeScale(${k})${k > 1.5 ? "（压速比 > 1.5，节奏感会变，建议换更接近坑位的块）" : ""}`);
	} else if (known < slot - 0.05) {
		const hold = Number((slot - known).toFixed(3));
		const pos = Number(known.toFixed(3));
		fix = `t.to({}, { duration: ${hold} }, ${pos});`;
		timing = { estimatedSec: known, slotSec: slot, action: "hold" };
		log.push(`时长：${basis} ~${known}s < 坑位 ${slot}s → 在 ${pos}s 处补 ${hold}s 驻留补间`);
	} else {
		log.push(`时长：${basis} ~${known}s ≈ 坑位 ${slot}s，不动`);
	}
	if (fix) {
		const fixScript = `<script>(function(){var n=0;function fit(){var t=window.__timelines&&window.__timelines["${newId}"];if(!t){if(++n<200)setTimeout(fit,0);return;}${fix}}fit();})();</script>`;
		html = html.replace(/\n<\/([a-zA-Z][\w-]*)>\n<\/template>\n$/, (m, tag) => `\n${fixScript}\n</${tag}>\n</template>\n`);
	}

	// 13. 可改点清单
	const textNodes = [...inner.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").matchAll(/>([^<>{}]{2,80})</g)]
		.map((m) => m[1].trim())
		.filter((t) => t && !/^[\s\d.,%:-]+$/.test(t));
	const numberArrays = [...scripts.join("\n").matchAll(/\[\s*-?\d[\d.,\s-]{3,}\]/g)].map((m) => m[0].replace(/\s+/g, " "));
	const colors = [...new Set((html.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((c) => c.toLowerCase()))];
	const editable = { texts: [...new Set(textNodes)].slice(0, 40), numberArrays: numberArrays.slice(0, 20), colors: colors.slice(0, 30) };
	log.push(`可改点：文案 ${editable.texts.length} / 数值数组 ${editable.numberArrays.length} / 色值 ${editable.colors.length}（内容与审美归 agent，MUST NOT 原样铺）`);

	return { html, log, category, editable, timing };
}
