/**
 * MG 颗粒静态 lint（add-rrv-lay，去品牌化前 rrv-lint）——六铁律的**机器可判定静态子集**，纯本地零云端。
 *
 * 契约正本 contracts/gsap-emit-v1.md。**只查静态可判定项**——逐帧非冻结只有真 Hyperframes 能判
 * （契约明令禁本地无头模拟），留客户端出片期，不在此。
 *
 * 铁律⑦（tl 总长 ≥ 坑位包络）只能给**静态下界**，故本文件对它恒非致命、只做提醒层；
 * 且**逐调用降级**——解析不了的调用跳过、能解析的照算（忽略若干调用得到的仍是合法下界），
 * 一条都算不出时**显式报**「无法静态估长」而非静默（fix-mg-lint-law7-estimate）。
 *
 * 契约「回调与 seek 语义」的三项（`x-callback-driven` / `x-engine-api-override` / `x-raf-interval`）
 * **恒非致命**：该主题的主防线是契约压在**引擎侧**的 MUST（定帧 MUST 保证 GSAP 回调可达），
 * 本文件只做哨兵（define-seek-suppress-events-contract）。
 *
 * 铁律⑧ `8-primitive-merge` 同样**恒非致命**：它只提示「循环批量生成、整组同步驱动」的重复图元
 * 可无损合并，**不是**渲染风险判定。真实触发轴未知、根治在渲染侧；本项只落实契约铁律⑧的作者侧形态规避。
 *
 * 顺带从颗粒 HTML 的 background 声明推导 opaque（权威源是颗粒作者，非可缺省的 dispatch.bg）。
 * 推导面 = **根 style ∪ 根下首个全幅子层 style**（契约铁律4④）——2026-07-26 r69 真渲实测：
 * 根元素的绘制属性在子合成挂载时被丢弃，实心底只有下沉子层才落成像素
 * （align-particle-solid-backdrop-contract；旧实现只读根 style，把唯一合法写法判成 opaque=false）。
 */

export interface LintViolation {
	law: string;
	fatal: boolean;
	msg: string;
}
export interface LintResult {
	ok: boolean;
	violations: LintViolation[];
	/**
	 * 从「根 style ∪ 根下首个全幅子层 style」的 background 推导：
	 * 有非透明底=true(满屏盖底) / 两处皆无或皆 transparent=false(透明叠加)。
	 */
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

/** 解析颗粒 HTML 内的 `data-composition-id`（拿不到=undefined）。供命令层定位派单条目用。 */
export function parseCompositionId(html: string): string | undefined {
	const root = rootTag(html);
	return root ? attr(root, "data-composition-id") : undefined;
}

/** 非渲染性子节点：找「第一个子**层**」时要跳过（它们不画像素，不可能是实心底）。 */
const NON_RENDERING = ["style", "script", "meta", "link", "title"];

/**
 * **根下第一个渲染性子元素**的开标签。
 *
 * 取法：从根开标签结束处起，依次跳过空白、`<!-- -->` 注释、以及 `NON_RENDERING` 里那些非渲染节点
 * （`<style>` / `<script>` 连同其内容整块跳过，`<meta>` / `<link>` 跳过该标签），取下一个元素的开标签。
 * 拿不到（根后面直接是文本 / 已闭合 / 只有注释与样式）→ `null`。
 *
 * **为什么要跳 `<style>`**：真机颗粒的写法惯例不统一——`回声定位` 的满屏颗粒是「根 → 注释 → `.bgfill` → `<style>`」，
 * 但把 `<style>` 写在前面同样合法。若不跳，后一种写法的实心底会被漏看、合规颗粒被误判 `opaque=false`
 * （正是本 change 要根除的那类误判）。契约说的是「第一个全幅子**层**」，样式表不是层。
 */
function firstChildTag(html: string, rootTagStr: string | null): string | null {
	if (!rootTagStr) return null;
	const at = html.indexOf(rootTagStr);
	if (at < 0) return null;
	let i = at + rootTagStr.length;
	for (;;) {
		while (i < html.length && /\s/.test(html[i])) i++;
		if (html.startsWith("<!--", i)) {
			const end = html.indexOf("-->", i + 4);
			if (end < 0) return null;
			i = end + 3;
			continue;
		}
		const m = /^<([a-zA-Z][\w-]*)\b[^>]*>/.exec(html.slice(i));
		if (!m) return null;
		const name = m[1].toLowerCase();
		if (!NON_RENDERING.includes(name)) return m[0];
		// 跳过整块：有闭合标签的（style/script/title）连内容一起跳，自闭合的（meta/link）只跳标签
		const close = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(i));
		i += close ? close.index + close[0].length : m[0].length;
	}
}

/** 该开标签的 style 是否「全幅铺满」（契约铁律4①：`position:absolute` + `inset:0` 或等价 `top/left/width/height`）。 */
function isFullBleed(tagStr: string): boolean {
	const style = (attr(tagStr, "style") ?? "").toLowerCase();
	if (!/position\s*:\s*(?:absolute|fixed)/.test(style)) return false;
	if (/\binset\s*:\s*0(?:px|%)?\b/.test(style)) return true;
	const has = (p: string) => new RegExp(`\\b${p}\\s*:\\s*0(?:px|%)?\\s*(?:;|$)`).test(style);
	const full = (p: string) => new RegExp(`\\b${p}\\s*:\\s*(?:100%|100vw|100vh|1920px|1080px)\\s*(?:;|$)`).test(style);
	return has("top") && has("left") && full("width") && full("height");
}

/** 从一段 style 串里取 background 声明 → 有无声明 / 是否非透明。 */
function bgOf(style: string): { declared: boolean; opaque: boolean } {
	const bg = style.match(/background(?:-color)?\s*:\s*([^;"']+)/i);
	if (!bg) return { declared: false, opaque: false };
	const val = bg[1].trim().toLowerCase();
	const transparent = val === "transparent" || val === "none" || /rgba\([^)]*,\s*0\s*\)/.test(val);
	return { declared: true, opaque: !transparent };
}

/** `deriveOpaque` 的完整推导结果（align-particle-solid-backdrop-contract：推导面由「根」扩为「根 ∪ 首个全幅子层」）。 */
export interface OpaqueDerivation {
	/** 该颗粒事实上是否满屏不透明（= 两处任一声明了非透明底）。 */
	opaque: boolean;
	/** 两处**至少一处**有 background 声明（契约铁律4③「透明与否 MUST 显式」的判据面）。 */
	declared: boolean;
	/** 根 style 上声明了**非透明**底 —— 契约铁律4② 明令禁止的形态（实测不落成像素）。 */
	solidOnRoot: boolean;
	/** 根下首个全幅子层上声明了非透明底 —— 契约钦定的**唯一**合法形态。 */
	solidOnChild: boolean;
}

/**
 * 推导 opaque：**推导面 = 根 `style` ∪ 根下首个全幅子层 `style`**（契约 gsap-emit v1 铁律4④，同源）。
 *
 * **为什么要看子层**（align-particle-solid-backdrop-contract，2026-07-26 r69 真渲四格实验）：
 * **根元素的绘制属性在子合成挂载时被丢弃**——实心底写根 style 时一个像素都不落地（实测四角 = 底轨基线，
 * 底轨完全透出），同一颗粒把同一底色改写到根下首个全幅子层则满屏落地（实测四角 ≈ 声明色）。
 * 故契约铁律 4 已改为「实心底 MUST 下沉为根下第一个全幅子层、根 MUST 保持零视觉」，
 * 旧实现只读根 style，会把**唯一合法的写法**判成 `opaque=false`（满屏不透明颗粒被登记成透明叠加）。
 *
 * **「全幅」判据**（`isFullBleed`）：`position:absolute|fixed` **且**（`inset:0` 或 `top:0`+`left:0`+`width:100%`+`height:100%` 等价形态）。
 * 不铺满的子层不是「实心底」（可能只是个卡片），不进推导面。
 *
 * **两处都声明时取「有任一非透明底即 opaque」**：颗粒画出的不透明像素只要有一层是满幅的，成片里就盖住底轨——
 * 这与 `clip.opaque` 要表达的事实（「该颗粒是否满屏不透明」）同义。
 */
function deriveOpaque(rootTagStr: string | null, childTagStr: string | null): OpaqueDerivation {
	if (!rootTagStr) return { opaque: false, declared: false, solidOnRoot: false, solidOnChild: false };
	const root = bgOf(attr(rootTagStr, "style") ?? "");
	const childFull = childTagStr !== null && isFullBleed(childTagStr);
	const child = childFull ? bgOf(attr(childTagStr as string, "style") ?? "") : { declared: false, opaque: false };
	return {
		opaque: root.opaque || child.opaque,
		declared: root.declared || child.declared,
		solidOnRoot: root.opaque,
		solidOnChild: child.opaque,
	};
}

/**
 * 品类→期望透明度（与 splitdoc CATEGORY_EXPECTED_OPAQUE 同源，此处独立避跨包依赖）。
 * 双名认旧：同时含中性新键（overlay/fullscreen/subtitle/title）与遗留品牌键，既有颗粒零迁移仍命中。
 */
const CATEGORY_EXPECTED_OPAQUE: Record<string, boolean> = {
	overlay: false,
	fullscreen: true,
	subtitle: false,
	title: true,
	// 遗留品牌键（读旧兼容）
	"rrv-overlay": false,
	"mg-fullscreen": true,
	"explain-subtitle": false,
	"op-ed-title": true,
};


/** 铁律⑦ 静态估长的结果（fix-mg-lint-law7-estimate：由 `number | null` 换成带可解析度的结构）。 */
export interface TimelineEstimate {
	/** 静态下界估长（秒）。含 `repeat:-1` 时为 `Infinity`；一条都算不进去时为 0。 */
	est: number;
	/** **对下界有非零贡献**的调用数（口径见函数注释）。`0` = 静态估不出，调用方 MUST 显式报，MUST NOT 静默。 */
	parsed: number;
	/** 因静态解析不了（表达式 position / 非字面量 duration / 负时长）而跳过的调用数。跳过仍是合法下界。 */
	skipped: number;
	/** 是否出现 `repeat:-1`（无限循环 → tl 时长 Infinity，铁律⑦ 无法静态验证）。 */
	hasInfiniteRepeat: boolean;
}

/** 纯数字字面量（含负号/小数），非此即「静态解析不了」。 */
const NUM_LIT = /^-?\d+(?:\.\d+)?$/;
/** 取对象字面量里某个键的**原始取值串**（到下一个 `,` / `}` 为止；解析不了的形态原样带回来判定）。 */
function rawProp(body: string, key: string): string | undefined {
	const m = new RegExp(`\\b${key}\\s*:\\s*([^,}\\n]+)`).exec(body);
	return m ? m[1].trim() : undefined;
}
function numProp(body: string, key: string): number | null {
	const raw = rawProp(body, key);
	if (raw === undefined) return null;
	return NUM_LIT.test(raw) ? Number(raw) : Number.NaN; // NaN = 有这个键但静态解析不了
}

/**
 * 铁律⑦ 静态估长（**尽力而为下界**）：扫 `tl.to/from/fromTo/set/add(...)` 的 duration / repeat /
 * repeatDelay / position，算出「时间线至少有这么长」。
 *
 * **立论（fix-mg-lint-law7-estimate 的核心）**：铁律⑦ 要的是**下界**，而下界只需要「能解析的那些调用」——
 * **忽略解析不了的调用，得到的仍然是合法下界**。故本函数**逐调用降级**：解析得了的计入，解析不了的
 * `skipped++` 跳过，**MUST NOT 因个别调用不可解析就放弃整颗估算**（旧实现遇 repeat/yoyo/表达式 position
 * 即整体 `return null`，恰好覆盖栏目主力写法 → 真机 21/21 全沉默，安全网从不展开）。
 *
 * 单个调用的跨度 `span = duration × (repeat + 1) + repeatDelay × repeat`：
 * - `yoyo: true` **不改总长**（只反转交替次的播放方向），不再是沉默理由；
 * - `repeat` 非数字字面量（`repeat: loops(4.9,1.7)` / `repeat: R.rep`）按 `repeat = 0` 记 —— 偏小、仍是下界；
 * - `repeat: -1` 记 `Infinity` 并置 `hasInfiniteRepeat`（调用方另出告警：无限循环令铁律⑦不可静态验证）。
 *
 * 有数字型绝对 position 的调用计 `max(pos + span)`，无 position 的链式调用计 `sum(span)`，估长取二者之大者。
 *
 * **`parsed` 的口径（本 change 定死）**：计**对下界有非零贡献**的调用数（`pos === null ? span > 0 : pos + span > 0`）。
 * 故「只有 `tl.set(el,{x:1})` 这类零时长调用」= `parsed 0` = 估不出；等价于 `est === 0`。
 *
 * **匹配范围（开放问题一的处置）**：`gsap.` 直调（`gsap.to/set(...)`）**不计**——它不挂在 tl 上、不影响 tl 长度。
 * ⚠️ 仍未处理**嵌套 timeline**（`t2.to(...)` 之后 `tl.add(t2, pos)`）：那些子 tween 会被当成 tl 自身的链式调用
 * 累加 → **高估**、破坏下界性质。真机 21 颗实查 `gsap.timeline(` 均只出现一次，暂不收窄到 tl 变量名
 * （收窄会让其他写法惯例的颗粒整颗估不出，代价更大）。
 */
export function estimateTimelineSec(html: string): TimelineEstimate {
	// 逐个截取 `<recv>.<method>( … );` 的实参串（非贪婪到 `);`，颗粒规范里每个调用都独立成句）。
	const re = /(?:([A-Za-z_$][\w$]*)\s*)?\.\s*(?:to|from|fromTo|set|add)\s*\(([\s\S]*?)\)\s*;/g;
	const calls: { body: string; pos: string | null }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		if (m[1] === "gsap") continue; // gsap.to/set 直调不挂在 tl 上，不参与 tl 长度
		const args = m[2] ?? "";
		// position = 最后一个顶层实参（在最后一个 `}` 之后）；无 `}` 则视作无 position
		const lastBrace = args.lastIndexOf("}");
		let pos: string | null = null;
		if (lastBrace >= 0) {
			const tail = args.slice(lastBrace + 1).replace(/^\s*,\s*/, "").trim();
			if (tail) pos = tail.replace(/^["']|["']$/g, "");
		}
		calls.push({ body: args, pos });
	}

	let chain = 0;
	let maxEnd = 0;
	let parsed = 0;
	let skipped = 0;
	let hasInfiniteRepeat = false;
	for (const c of calls) {
		// ① position：表达式 / 相对串 / 标签 → 跳过**该条**（其余照常参与），不整体放弃
		if (c.pos !== null && !NUM_LIT.test(c.pos)) {
			skipped++;
			continue;
		}
		// ② duration：缺省视作 0（`tl.set` 等）；写了但非数字字面量（`duration: R.bd`）或负数 → 跳过该条
		const durProp = numProp(c.body, "duration");
		if (durProp !== null && (!Number.isFinite(durProp) || durProp < 0)) {
			skipped++;
			continue;
		}
		const dur = durProp ?? 0;
		// ③ repeat：-1=无限；非负整数按次数放大；非字面量按 0 记（偏小、仍是下界）。yoyo 不改总长。
		const repProp = numProp(c.body, "repeat");
		let span: number;
		if (repProp === -1) {
			hasInfiniteRepeat = true;
			span = Number.POSITIVE_INFINITY;
		} else {
			const rep = repProp !== null && Number.isFinite(repProp) && repProp > 0 ? repProp : 0;
			const rdProp = numProp(c.body, "repeatDelay");
			const rd = rdProp !== null && Number.isFinite(rdProp) && rdProp > 0 ? rdProp : 0;
			span = dur * (rep + 1) + rd * rep;
		}
		const contrib = c.pos !== null ? Number(c.pos) + span : span;
		if (contrib > 0) parsed++;
		if (c.pos !== null) maxEnd = Math.max(maxEnd, Number(c.pos) + span);
		else chain += span;
	}
	const raw = Math.max(chain, maxEnd);
	const est = Number.isFinite(raw) ? Math.round(raw * 1000) / 1000 : raw;
	return { est, parsed, skipped, hasInfiniteRepeat };
}

// ── 契约「回调与 seek 语义」的静态信号（define-seek-suppress-events-contract · ③兜底哨兵）──
//
// 背景：GSAP `seek(t)` 默认 `suppressEvents=true` → **补间目标属性照常插值、但回调不跑**，
// 写在 `onUpdate` 里的 DOM 写入一次都不执行 → 翻车形态不是黑屏、是**画面定在初始态**。
// 契约收口后**主防线在引擎侧**（MUST 用 `seek(t,false)` / `time(t)` / `progress(p)` 定帧），
// 本文件这两项只是**哨兵**：引擎换实现或失守时有人喊一声。故**恒非致命**，
// MUST NOT 把「用回调驱动画面」判成违规（那是未采纳的路线②）。

/** 时间线回调钩子（引擎定帧时是否触发它们，由契约「回调与 seek 语义」的引擎侧条款决定）。 */
const TL_HOOKS = ["onUpdate", "onStart", "onComplete", "onRepeat"] as const;

/** DOM / 属性写入关键字：回调体内出现即视作「画面靠回调驱动」。纯计算型回调（只改状态对象）不命中。 */
const DOM_WRITE =
	/\.setAttribute(?:NS)?\s*\(|\.textContent\s*=(?!=)|\.inner(?:HTML|Text)\s*=(?!=)|\.style\.[A-Za-z_$][\w$]*\s*=(?!=)|\.style\.setProperty\s*\(|\.classList\s*\.\s*(?:add|remove|toggle|replace)\s*\(/;

/** 跳过字符串字面量：`i` 指向引号，返回闭合引号下标（未闭合则串尾）。 */
function skipString(src: string, i: number): number {
	const q = src[i];
	for (let j = i + 1; j < src.length; j++) {
		if (src[j] === "\\") {
			j++;
			continue;
		}
		if (src[j] === q) return j;
	}
	return src.length;
}

/**
 * 从 `open`（指向 `{`）起花括号配平，返回块体（不含外层花括号）。跳字符串与注释。
 * ⚠️ 不解析正则字面量（`/\{/` 这类会算错）——本组检查恒非致命，误差可接受。
 */
function braceBlock(src: string, open: number): string {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '"' || c === "'" || c === "`") {
			i = skipString(src, i);
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			i = nl < 0 ? src.length : nl;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const e = src.indexOf("*/", i + 2);
			i = e < 0 ? src.length : e + 1;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return src.slice(open + 1, i);
	}
	return src.slice(open + 1);
}

/** 解析具名函数体（一层，不递归）：`function f(){…}` / `var f = function(){…}` / `var f = (…)=>{…}`。 */
function namedFnBody(html: string, name: string): string | null {
	const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const decl = new RegExp(`\\bfunction\\s+${n}\\s*\\([^)]*\\)\\s*\\{`).exec(html);
	if (decl) return braceBlock(html, decl.index + decl[0].length - 1);
	const assign = new RegExp(
		`\\b(?:var|let|const)\\s+${n}\\s*=\\s*(?:function\\s*[\\w$]*\\s*\\([^)]*\\)|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)\\s*\\{`,
	).exec(html);
	if (assign) return braceBlock(html, assign.index + assign[0].length - 1);
	return null;
}

/** 跟不进去的「函数调用」噪音：这些关键字后面也跟 `(`，逐一去解析纯属浪费（解析不到也无害，仅为清晰）。 */
const NOT_A_CALL = new Set(["if", "for", "while", "switch", "catch", "return", "function", "typeof", "new", "delete", "void", "in", "of", "do", "else"]);

// ── 铁律⑧：循环批量生成的可合并重复图元（add-particle-primitive-merge-law）──

/** 铁律⑧只覆盖能机械合成 `<path>` 多子路径、且可读性成本可控的图元。 */
const MERGEABLE_PRIMITIVES = new Set(["line", "rect", "path", "polyline", "polygon"]);
/** 只用于「已能静态求出批量」时过滤可读性收益很小的小批次；不是渲染风险阈值。 */
const PRIMITIVE_MERGE_MIN = 8;

export interface PrimitiveLoopBatch {
	tag: string;
	parent: string;
	count: number | null;
	perElementDriven: boolean;
	site: string;
}

/** 先把 HTML 注释等长置空，避免注释里的 `<script>` 被误当成可执行脚本。 */
function maskHtmlComments(src: string): string {
	const out = src.split("");
	for (let at = src.indexOf("<!--"); at >= 0; at = src.indexOf("<!--", at)) {
		const close = src.indexOf("-->", at + 4);
		const end = close < 0 ? src.length : close + 3;
		for (let i = at; i < end; i++) if (out[i] !== "\r" && out[i] !== "\n") out[i] = " ";
		at = end;
	}
	return out.join("");
}

/** 有 `<script>` 时只保留其 body（等长、保留换行）；裸 JS 单测/片段则原样返回。 */
function scriptBodiesOnly(src: string): string {
	const openRe = /<script\b[^>]*>/gi;
	const first = openRe.exec(src);
	if (!first) return src;
	const out: string[] = src.split("").map((c) => (c === "\r" || c === "\n" ? c : " "));
	let open: RegExpExecArray | null = first;
	while (open) {
		const bodyStart = (open.index as number) + open[0].length;
		const closeRe = /<\/script\s*>/gi;
		closeRe.lastIndex = bodyStart;
		const close = closeRe.exec(src);
		const bodyEnd = close?.index ?? src.length;
		for (let i = bodyStart; i < bodyEnd; i++) out[i] = src[i];
		openRe.lastIndex = close ? close.index + close[0].length : src.length;
		open = openRe.exec(src);
	}
	return out.join("");
}

/**
 * 把 JS 注释与 regex literal 替成等长空白（换行保留），避免其中的引号或伪代码干扰后续扫描。
 * 字符串保持原样，供 `CREATE_PRIMITIVE` 读取第二实参的 tag；引号内的伪代码由 `maskJsStrings` 再屏蔽。
 */
function maskJsComments(src: string): string {
	const out = src.split("");
	const blank = (from: number, to: number) => {
		for (let i = from; i < to; i++) if (out[i] !== "\r" && out[i] !== "\n") out[i] = " ";
	};
	const canStartRegexAfter = new Set(["(", "[", "{", "=", ":", ",", ";", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">"]);
	const keywordBeforeRegex = new Set(["return", "case", "throw", "else", "do", "yield", "await"]);
	const regexStartsAt = (at: number) => {
		let prev = at - 1;
		while (prev >= 0 && /\s/.test(out[prev])) prev--;
		if (prev < 0 || canStartRegexAfter.has(out[prev])) return true;
		if (!/[\w$]/.test(out[prev])) return false;
		let begin = prev;
		while (begin > 0 && /[\w$]/.test(out[begin - 1])) begin--;
		return keywordBeforeRegex.has(out.slice(begin, prev + 1).join(""));
	};
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === '"' || c === "'" || c === "`") {
			i = skipString(src, i);
			continue;
		}
		if (src.startsWith("<!--", i)) {
			const end = src.indexOf("-->", i + 4);
			const to = end < 0 ? src.length : end + 3;
			blank(i, to);
			i = to - 1;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const end = src.indexOf("\n", i + 2);
			const to = end < 0 ? src.length : end;
			blank(i, to);
			i = to - 1;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			const to = end < 0 ? src.length : end + 2;
			blank(i, to);
			i = to - 1;
			continue;
		}
		if (c !== "/" || src[i + 1] === "=" || !regexStartsAt(i)) continue;
		let inClass = false;
		let end = -1;
		for (let j = i + 1; j < src.length; j++) {
			if (src[j] === "\\") {
				j++;
				continue;
			}
			if (src[j] === "\r" || src[j] === "\n") break;
			if (src[j] === "[") inClass = true;
			else if (src[j] === "]") inClass = false;
			else if (src[j] === "/" && !inClass) {
				end = j + 1;
				while (end < src.length && /[A-Za-z]/.test(src[end])) end++;
				break;
			}
		}
		if (end < 0) continue;
		blank(i, end);
		i = end - 1;
	}
	return out.join("");
}

/** 再把字符串替成等长空白，供结构 / 调用 / driver 正则使用；标签识别仍在只去注释的源码上跑。 */
function maskJsStrings(src: string): string {
	const out = src.split("");
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c !== '"' && c !== "'" && c !== "`") continue;
		const end = skipString(src, i);
		for (let j = i; j <= end && j < out.length; j++) if (out[j] !== "\r" && out[j] !== "\n") out[j] = " ";
		i = end;
	}
	return out.join("");
}

interface LoopSite {
	kind: "for" | "while";
	bodyStart: number;
	bodyEnd: number;
	count: number | null;
	header: string;
}

/** 与 `braceBlock` 同口径地跳过字符串/注释，找与 `open` 配平的右圆括号。 */
function closeParen(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '"' || c === "'" || c === "`") {
			i = skipString(src, i);
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			i = nl < 0 ? src.length : nl;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const e = src.indexOf("*/", i + 2);
			i = e < 0 ? src.length : e + 1;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return -1;
}

function skipSpace(src: string, at: number): number {
	while (at < src.length && /\s/.test(src[at])) at++;
	return at;
}

/** 返回 `{…}` 的右花括号后一位；未配平时退到源码末尾。 */
function braceStatementEnd(src: string, open: number): number {
	const body = braceBlock(src, open);
	const close = open + 1 + body.length;
	return src[close] === "}" ? close + 1 : src.length;
}

/**
 * 无花括号 loop 后“一条 JS statement”的结尾。控制语句递归解析自己的 body，
 * 普通表达式才按分号/ASI 收口，避免把 loop 外下一条调用误归进来。
 */
function statementEnd(src: string, start: number): number {
	const at = skipSpace(src, start);
	if (src[at] === "{") return braceStatementEnd(src, at);
	const keyword = /^([A-Za-z_$][\w$]*)\b/.exec(src.slice(at))?.[1] ?? "";

	if (keyword === "if" || keyword === "for" || keyword === "while" || keyword === "with" || keyword === "switch") {
		const open = src.indexOf("(", at + keyword.length);
		const close = open < 0 ? -1 : closeParen(src, open);
		if (close < 0) return src.length;
		if (keyword === "switch") {
			const block = skipSpace(src, close + 1);
			return src[block] === "{" ? braceStatementEnd(src, block) : statementEnd(src, block);
		}
		const bodyEnd = statementEnd(src, close + 1);
		if (keyword !== "if") return bodyEnd;
		const next = skipSpace(src, bodyEnd);
		return /^else\b/.test(src.slice(next)) ? statementEnd(src, next + 4) : bodyEnd;
	}

	if (keyword === "do") {
		const bodyEnd = statementEnd(src, at + 2);
		const trailer = skipSpace(src, bodyEnd);
		if (!/^while\b/.test(src.slice(trailer))) return bodyEnd;
		const open = src.indexOf("(", trailer + 5);
		const close = open < 0 ? -1 : closeParen(src, open);
		if (close < 0) return src.length;
		const semi = skipSpace(src, close + 1);
		return src[semi] === ";" ? semi + 1 : close + 1;
	}

	if (keyword === "try") {
		let end = statementEnd(src, at + 3);
		for (;;) {
			const next = skipSpace(src, end);
			if (/^catch\b/.test(src.slice(next))) {
				let body = skipSpace(src, next + 5);
				if (src[body] === "(") {
					const close = closeParen(src, body);
					if (close < 0) return src.length;
					body = skipSpace(src, close + 1);
				}
				end = statementEnd(src, body);
				continue;
			}
			if (/^finally\b/.test(src.slice(next))) {
				end = statementEnd(src, next + 7);
				continue;
			}
			return end;
		}
	}

	let parens = 0;
	let brackets = 0;
	let braces = 0;
	for (let i = at; i < src.length; i++) {
		const c = src[i];
		if (c === '"' || c === "'" || c === "`") {
			i = skipString(src, i);
			continue;
		}
		if (c === "(") parens++;
		else if (c === ")") parens = Math.max(0, parens - 1);
		else if (c === "[") brackets++;
		else if (c === "]") brackets = Math.max(0, brackets - 1);
		else if (c === "{") braces++;
		else if (c === "}") {
			if (braces === 0 && parens === 0 && brackets === 0) return i;
			braces = Math.max(0, braces - 1);
		} else if (c === ";" && parens === 0 && brackets === 0 && braces === 0) return i + 1;
		else if ((c === "\r" || c === "\n") && parens === 0 && brackets === 0 && braces === 0) {
			let prev = i - 1;
			while (prev >= at && /\s/.test(src[prev])) prev--;
			let next = skipSpace(src, i + 1);
			// ASI：完整表达式后的换行结束当前单语句；`.` / `(`/`[` / 运算符开头则仍是续行。
			if (
				prev >= at &&
				/[\w$)\]'"`}]/.test(src[prev]) &&
				next < src.length &&
				!/[.(\[`?+\-*/%&|^<>=,:]/.test(src[next])
			)
				return i;
		}
	}
	return src.length;
}

/** 只计算纯数字字面量三段式 `for`；逐次模拟 JS Number 加法，避免小数步长被代数公式舍错一轮。 */
function numericForCount(header: string): number | null {
	const parts = header.split(";");
	if (parts.length !== 3) return null;
	const init = /^(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*$/.exec(parts[0].trim());
	if (!init) return null;
	const name = init[1];
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const cond = new RegExp(`^${escaped}\\s*(<=|<|>=|>)\\s*(-?\\d+(?:\\.\\d+)?)\\s*$`).exec(parts[1].trim());
	if (!cond) return null;
	const updateRaw = parts[2].trim();
	let step: number | null = null;
	if (new RegExp(`^(?:${escaped}\\s*\\+\\+|\\+\\+\\s*${escaped})$`).test(updateRaw)) step = 1;
	else if (new RegExp(`^(?:${escaped}\\s*--|--\\s*${escaped})$`).test(updateRaw)) step = -1;
	else {
		const by = new RegExp(`^${escaped}\\s*([+-])=\\s*(-?\\d+(?:\\.\\d+)?)$`).exec(updateRaw);
		if (by) step = (by[1] === "+" ? 1 : -1) * Number(by[2]);
	}
	if (step === null || !Number.isFinite(step) || step === 0) return null;

	const from = Number(init[2]);
	const to = Number(cond[2]);
	const op = cond[1];
	if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
	const compare = (value: number) =>
		op === "<" ? value < to : op === "<=" ? value <= to : op === ">" ? value > to : value >= to;
	if (!compare(from)) return 0;
	if ((step > 0 && op.startsWith(">")) || (step < 0 && op.startsWith("<"))) return null;
	if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && Number.isSafeInteger(step)) {
		const distance = step > 0 ? to - from : from - to;
		if (!Number.isSafeInteger(distance) || distance < 0) return null;
		const stride = Math.abs(step);
		const count = op === "<" || op === ">" ? Math.ceil(distance / stride) : Math.floor(distance / stride) + 1;
		return Number.isSafeInteger(count) ? count : null;
	}
	let value = from;
	let count = 0;
	while (compare(value)) {
		if (++count > 1_000_000) {
			// 小数超大循环不再逐次耗时；这里仍是纯数字头，退到代数估算而不是误称“边界非数字”。
			const distance = step > 0 ? to - from : from - to;
			const stride = Math.abs(step);
			const estimated = op === "<" || op === ">" ? Math.ceil(distance / stride) : Math.floor(distance / stride) + 1;
			return Number.isSafeInteger(estimated) && estimated >= 0 ? estimated : null;
		}
		const next = value + step;
		if (Object.is(next, value) || !Number.isFinite(next)) return null;
		value = next;
	}
	return count;
}

/** 找出所有 loop 的精确体区间；有 `{}` 用 `braceBlock`，否则只纳入紧随其后的单条语句。 */
function loopSites(html: string): LoopSite[] {
	const out: LoopSite[] = [];
	const doWhileTrailers = new Set<number>();
	const doRe = /\bdo\b/g;
	let dm: RegExpExecArray | null;
	while ((dm = doRe.exec(html))) {
		const bodyEnd = statementEnd(html, dm.index + dm[0].length);
		const trailer = skipSpace(html, bodyEnd);
		if (/^while\b/.test(html.slice(trailer))) doWhileTrailers.add(trailer);
	}
	const re = /\b(for|while)\s*\(/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		if (m[1] === "while" && doWhileTrailers.has(m.index)) continue;
		const open = m.index + m[0].lastIndexOf("(");
		const close = closeParen(html, open);
		if (close < 0) continue;
		let at = close + 1;
		while (at < html.length && /\s/.test(html[at])) at++;
		let bodyStart = at;
		let bodyEnd: number;
		if (html[at] === "{") {
			const body = braceBlock(html, at);
			bodyStart = at + 1;
			bodyEnd = bodyStart + body.length;
		} else bodyEnd = statementEnd(html, at);
		const kind = m[1] as "for" | "while";
		const header = html.slice(open + 1, close);
		out.push({
			kind,
			bodyStart,
			bodyEnd,
			count: kind === "for" ? numericForCount(header) : null,
			header,
		});
	}
	return out;
}

interface FunctionSite {
	name: string | null;
	declStart: number;
	bodyStart: number;
	bodyEnd: number;
	body: string;
	params: Set<string>;
	immediatelyInvoked: boolean;
}

/**
 * 函数的精确体区间。赋值式先认，防 `const f=function inner(){}` 被同时登记成 `f` 与 `inner`；
 * 再补声明 / IIFE / callback 形态。具名体继续复用 `namedFnBody` 的既有解析口径。
 */
function namedFunctionSites(code: string): FunctionSite[] {
	const out: FunctionSite[] = [];
	const invocationAfter = (declStart: number, bodyEnd: number, expression: boolean) => {
		let before = declStart - 1;
		while (before >= 0 && /\s/.test(code[before])) before--;
		const expressionContext = expression || (before >= 0 && /[(!=,:+\-~?]/.test(code[before]));
		let after = bodyEnd + 1;
		while (after < code.length && /\s/.test(code[after])) after++;
		if (code[after] === "(") return expressionContext;
		if (code[before] !== "(") return false;
		let groupingCount = 0;
		let beforeOpen = before;
		while (beforeOpen >= 0 && code[beforeOpen] === "(") {
			groupingCount++;
			beforeOpen--;
			while (beforeOpen >= 0 && /\s/.test(code[beforeOpen])) beforeOpen--;
		}
		// `consume(function(){…})()` / `consume(0,function(){…})()` 调的是 consume 的返回值，不是 callback。
		if (beforeOpen >= 0 && /[\w$)\]]/.test(code[beforeOpen])) return false;
		for (let i = 0; i < groupingCount; i++) {
			if (code[after] !== ")") return false;
			after = skipSpace(code, after + 1);
		}
		return expressionContext && code[after] === "(";
	};
	const patterns: Array<{ re: RegExp; nameGroup: number | null; expression: boolean }> = [
		{
			re: /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:async\s+)?function\s*\*?\s*[\w$]*\s*\([^)]*\)|(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)\s*\{/g,
			nameGroup: 1,
			expression: true,
		},
		{
			re: /\b(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
			nameGroup: 1,
			expression: false,
		},
		{
			re: /\b(?:async\s+)?function\s*\*?\s*\([^)]*\)\s*\{/g,
			nameGroup: null,
			expression: true,
		},
		{
			re: /(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
			nameGroup: null,
			expression: true,
		},
	];
	for (const { re, nameGroup, expression } of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(code))) {
			const open = m.index + m[0].lastIndexOf("{");
			const paired = braceBlock(code, open);
			const bodyStart = open + 1;
			const bodyEnd = bodyStart + paired.length;
			// 赋值式已登记的同一函数体，不再按内部函数名 / 匿名表达式重复登记。
			if (out.some((fn) => fn.bodyStart === bodyStart)) continue;
			const name = nameGroup === null ? null : m[nameGroup];
			const signature = m[0].slice(0, m[0].lastIndexOf("{"));
			const parenGroups = [...signature.matchAll(/\(([^()]*)\)/g)];
			const singleArrow = /=\s*([A-Za-z_$][\w$]*)\s*=>\s*$/.exec(signature);
			const rawParams = parenGroups.at(-1)?.[1] ?? singleArrow?.[1] ?? "";
			const params = new Set(
				rawParams
					.split(",")
					.map((part) => /^([A-Za-z_$][\w$]*)/.exec(part.trim())?.[1])
					.filter((name): name is string => Boolean(name)),
			);
			out.push({
				name,
				declStart: m.index,
				bodyStart,
				bodyEnd,
				body: paired,
				params,
				immediatelyInvoked: invocationAfter(m.index, bodyEnd, expression),
			});
		}
	}
	// 上面的快速正则不覆盖 `function f(p=getParent()){…}` 这类参数内嵌圆括号；用配平扫描补齐函数边界。
	const functionRe = /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g;
	let fm: RegExpExecArray | null;
	while ((fm = functionRe.exec(code))) {
		const open = fm.index + fm[0].lastIndexOf("(");
		const close = closeParen(code, open);
		if (close < 0) continue;
		let brace = close + 1;
		while (brace < code.length && /\s/.test(code[brace])) brace++;
		if (code[brace] !== "{") continue;
		const paired = braceBlock(code, brace);
		const bodyStart = brace + 1;
		const bodyEnd = bodyStart + paired.length;
		if (out.some((fn) => fn.bodyStart === bodyStart)) continue;
		const prefix = code.slice(Math.max(0, fm.index - 160), fm.index);
		const assigned = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(prefix);
		const name = assigned?.[1] ?? fm[1] ?? null;
		const params = new Set(
			code
				.slice(open + 1, close)
				.split(",")
				.map((part) => /^([A-Za-z_$][\w$]*)/.exec(part.trim())?.[1])
				.filter((param): param is string => Boolean(param)),
		);
		out.push({
			name,
			declStart: fm.index,
			bodyStart,
			bodyEnd,
			body: paired,
			params,
			immediatelyInvoked: invocationAfter(fm.index, bodyEnd, assigned !== null || fm[1] === undefined),
		});
	}
	// 同理补齐 `const f=(p=getParent())=>{…}` 这类参数内嵌圆括号的具名 arrow factory。
	const arrowRe = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
	let am: RegExpExecArray | null;
	while ((am = arrowRe.exec(code))) {
		const open = am.index + am[0].lastIndexOf("(");
		const close = closeParen(code, open);
		if (close < 0) continue;
		let arrow = skipSpace(code, close + 1);
		if (!code.startsWith("=>", arrow)) continue;
		const brace = skipSpace(code, arrow + 2);
		if (code[brace] !== "{") continue;
		const paired = braceBlock(code, brace);
		const bodyStart = brace + 1;
		const bodyEnd = bodyStart + paired.length;
		if (out.some((fn) => fn.bodyStart === bodyStart)) continue;
		const params = new Set(
			code
				.slice(open + 1, close)
				.split(",")
				.map((part) => /^([A-Za-z_$][\w$]*)/.exec(part.trim())?.[1])
				.filter((param): param is string => Boolean(param)),
		);
		out.push({
			name: am[1],
			declStart: am.index,
			bodyStart,
			bodyEnd,
			body: paired,
			params,
			immediatelyInvoked: invocationAfter(am.index, bodyEnd, true),
		});
	}
	return out.sort((a, b) => a.declStart - b.declStart);
}

const CREATE_PRIMITIVE =
	/\b(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=(?!=)\s*document\s*\.\s*createElementNS\s*\(\s*[^,]+,\s*["']([A-Za-z][\w-]*)["']\s*\)/gi;

function escapedIdent(name: string): string {
	return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从 create 后的同一执行作用域取 `<parent>.appendChild(<elVar>)`；重赋值或嵌套函数一律不借用。 */
function appendedParent(
	body: string,
	elVar: string,
	baseAt: number,
	sameExecutionScope: (absoluteAt: number) => boolean,
): string | null {
	const el = escapedIdent(elVar);
	const appendRe = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*appendChild\\s*\\(\\s*${el}\\s*\\)`, "g");
	let append: RegExpExecArray | null;
	while ((append = appendRe.exec(body)) && !sameExecutionScope(baseAt + append.index));
	if (!append) return null;
	const reassignRe = new RegExp(`\\b(?:(?:var|let|const)\\s+)?${el}\\s*=(?!=)`, "g");
	let reassign: RegExpExecArray | null;
	while ((reassign = reassignRe.exec(body))) {
		if (reassign.index >= append.index) break;
		if (body[reassign.index - 1] === ".") continue;
		if (sameExecutionScope(baseAt + reassign.index)) return null;
	}
	return append[1];
}

/** `<elVar>` 是否在 loop/factory 体内被直接驱动，或 push 后以数组/数组下标作 tween 首实参。 */
function perElementDriven(html: string, body: string, elVar: string): boolean {
	const el = escapedIdent(elVar);
	if (new RegExp(`\\bgsap\\s*\\.\\s*set\\s*\\(\\s*${el}\\b`).test(body)) return true;
	if (new RegExp(`\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*(?:to|from|fromTo)\\s*\\(\\s*${el}\\b`).test(body)) return true;
	const pushes = new Set<string>();
	for (const pm of body.matchAll(new RegExp(`\\b([A-Za-z_$][\\w$]*)(?:\\s*\\[[^\\]]+\\])?\\s*\\.\\s*push\\s*\\(\\s*${el}\\s*\\)`, "g")))
		pushes.add(pm[1]);
	for (const arr of pushes) {
		const a = escapedIdent(arr);
		if (new RegExp(`\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*(?:to|from|fromTo)\\s*\\(\\s*${a}(?:\\s*\\[[^\\]]+\\])?\\s*,`).test(html))
			return true;
	}
	return false;
}

/**
 * 静态识别「循环批量生成、且整组同步驱动」的可合并图元。
 *
 * - create 可直接位于 loop 体内，也可位于被 loop 调用的具名 factory 体内；
 * - 归属靠 loop 精确体区间，不做“前 N 字符出现 for”邻近猜测；
 * - 工厂内外的嵌套 loop 相乘，独立 loop 在同一 `tag + parent` 批次内相加；任一项不可求则批次 count=null；
 * - 注释与字符串先做等长屏蔽，函数声明体不继承声明点外层 loop，声明签名也不算调用；
 * - 本函数只报写法事实，不推断渲染风险。复杂动态 JS 一律漏向“不报”。
 */
export function detectPrimitiveLoops(html: string): PrimitiveLoopBatch[] {
	const source = maskJsComments(scriptBodiesOnly(maskHtmlComments(html)));
	const code = maskJsStrings(source);
	const loops = loopSites(code);
	const functions = namedFunctionSites(code);
	const containingFunction = (at: number): FunctionSite | null =>
		functions
			.filter((fn) => at >= fn.bodyStart && at < fn.bodyEnd)
			.sort((a, b) => a.bodyEnd - a.bodyStart - (b.bodyEnd - b.bodyStart))[0] ?? null;
	const functionOwner = (fn: FunctionSite): FunctionSite | null => containingFunction(fn.declStart);
	const hasOwnVariableBinding = (scope: FunctionSite, name: string) => {
		if (scope.params.has(name)) return true;
		const re = new RegExp(`\\b(?:var|let|const|class)\\s+${escapedIdent(name)}\\b`, "g");
		re.lastIndex = scope.bodyStart;
		let binding: RegExpExecArray | null;
		while ((binding = re.exec(code)) && binding.index < scope.bodyEnd)
			if (containingFunction(binding.index) === scope) return true;
		return false;
	};
	const resolveFunction = (name: string, at: number): FunctionSite | null => {
		let scope = containingFunction(at);
		while (scope) {
			const local = functions
				.filter((fn) => fn.name === name && functionOwner(fn) === scope)
				.sort((a, b) => b.declStart - a.declStart)[0];
			if (local) return local;
			if (scope.name === name) return scope;
			if (hasOwnVariableBinding(scope, name)) return null;
			scope = functionOwner(scope);
		}
		return (
			functions
				.filter((fn) => fn.name === name && functionOwner(fn) === null)
			.sort((a, b) => b.declStart - a.declStart)[0] ?? null
		);
	};
	const parentBindingScope = (fn: FunctionSite, parent: string): FunctionSite | null => {
		let scope: FunctionSite | null = fn;
		while (scope) {
			if (hasOwnVariableBinding(scope, parent)) return scope;
			scope = functionOwner(scope);
		}
		return null;
	};
	const freshParentDeclaration = (parent: string, before: number, scope: FunctionSite | null): number | null => {
		const ident = escapedIdent(parent);
		const re = new RegExp(
			`\\b(?:var|let|const)\\s+${ident}\\s*=\\s*(?:document\\s*\\.\\s*createElement(?:NS)?\\s*\\(|new\\b)`,
			"g",
		);
		re.lastIndex = scope?.bodyStart ?? 0;
		let found: number | null = null;
		let m: RegExpExecArray | null;
		while ((m = re.exec(code)) && m.index < before && (!scope || m.index < scope.bodyEnd))
			if (containingFunction(m.index) === scope) found = m.index;
		return found;
	};
	const loopsForOneParent = (owned: LoopSite[], freshAt: number | null) =>
		freshAt === null ? owned : owned.filter((loop) => freshAt < loop.bodyStart || freshAt >= loop.bodyEnd);
	/**
	 * 只取当前执行作用域里的 loop：函数声明文本即使写在外层 loop 里，函数体也不会在“声明”时执行，
	 * 因而不能把那个外层 loop 乘给函数体；真正的外层次数由调用点另算。
	 */
	const executionLoopsAt = (at: number): LoopSite[] => {
		const fn = containingFunction(at);
		return loops.filter((loop) => {
			if (at < loop.bodyStart || at >= loop.bodyEnd) return false;
			if (fn) return loop.bodyStart >= fn.bodyStart && loop.bodyEnd <= fn.bodyEnd;
			return containingFunction(loop.bodyStart) === null;
		});
	};
	const loopProduct = (owned: LoopSite[]): number | null => {
		if (owned.some((loop) => loop.count === null)) return null;
		let product = 1;
		for (const loop of owned) {
			product *= loop.count as number;
			if (!Number.isSafeInteger(product)) return null;
		}
		return product;
	};
	const innermostLoopBody = (at: number, owned = executionLoopsAt(at)): string => {
		const loop = owned.sort((a, b) => a.bodyEnd - a.bodyStart - (b.bodyEnd - b.bodyStart))[0];
		return loop ? code.slice(loop.bodyStart, loop.bodyEnd) : "";
	};
	type MutableBatch = {
		tag: string;
		parent: string;
		count: number;
		unknown: boolean;
		perElementDriven: boolean;
		sites: Set<string>;
	};
	const grouped = new Map<string, MutableBatch>();
	const add = (tag: string, parent: string, count: number | null, driven: boolean, site: string, scope: string) => {
		/*
		 * `scope` 隔开不同函数里的参数 / 局部 parent；闭包引用的同名 parent 仍与顶层批次累计。
		 * 同一工厂参数在不同调用点究竟指向哪个 DOM 节点仍刻意不求值
		 *（proposal「同一父节点怎么判」已拍定只认 appendChild 的标识符）。
		 */
		const key = `${scope}\u0000${tag}\u0000${parent}`;
		const batch =
			grouped.get(key) ??
			{ tag, parent, count: 0, unknown: false, perElementDriven: false, sites: new Set<string>() };
		if (count === null) batch.unknown = true;
		else {
			batch.count += count;
			if (!Number.isSafeInteger(batch.count)) batch.unknown = true;
		}
		batch.perElementDriven ||= driven;
		batch.sites.add(site);
		grouped.set(key, batch);
	};

	type CreateSite = {
		at: number;
		tag: string;
		elVar: string;
		parent: string;
		fn: FunctionSite | null;
		loops: LoopSite[];
	};
	const creates: CreateSite[] = [];
	CREATE_PRIMITIVE.lastIndex = 0;
	let cm: RegExpExecArray | null;
	while ((cm = CREATE_PRIMITIVE.exec(source))) {
		// `source` 为读取 tag 保留字符串；起点若在 `code` 中已被屏蔽，整段只是字符串里的伪代码。
		if (!code[cm.index] || /\s/.test(code[cm.index])) continue;
		const tag = cm[2].toLowerCase();
		if (!MERGEABLE_PRIMITIVES.has(tag)) continue;
		const fn = containingFunction(cm.index);
		const owned = executionLoopsAt(cm.index);
		const nearest = owned
			.slice()
			.sort((a, b) => a.bodyEnd - a.bodyStart - (b.bodyEnd - b.bodyStart))[0];
		// create 自己在 loop 内时，append 也必须落在该 loop 体内；loop 外 append 只会追加最终一次赋值。
		// 只有“create 不在 loop 内的 factory”才在完整函数体里找 append。
		const bodyStart = nearest?.bodyStart ?? fn?.bodyStart ?? cm.index;
		const body = nearest ? code.slice(nearest.bodyStart, nearest.bodyEnd) : (fn?.body ?? "");
		const tailStart = Math.max(0, cm.index - bodyStart) + cm[0].length;
		const parent = appendedParent(
			body.slice(tailStart),
			cm[1],
			bodyStart + tailStart,
			(at) => containingFunction(at) === fn,
		);
		if (!parent) continue;
		creates.push({ at: cm.index, tag, elVar: cm[1], parent, fn, loops: owned });
	}

	type CallSite = { at: number; loops: LoopSite[] };
	const callsByFunction = new Map<number, CallSite[]>();
	const pushCall = (fn: FunctionSite, at: number) => {
		const list = callsByFunction.get(fn.declStart) ?? [];
		list.push({ at, loops: executionLoopsAt(at) });
		callsByFunction.set(fn.declStart, list);
	};
	const functionNames = new Set(functions.map((fn) => fn.name).filter((name): name is string => name !== null));
	for (const call of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
		const name = call[1];
		const at = call.index as number;
		let before = at - 1;
		while (before >= 0 && /\s/.test(code[before])) before--;
		if (NOT_A_CALL.has(name) || !functionNames.has(name) || code[before] === ".") continue;
		// `function make(` 的 `make(` 是声明签名，不是一次调用。
		if (functions.some((fn) => fn.name === name && at >= fn.declStart && at < fn.bodyStart)) continue;
		const target = resolveFunction(name, at);
		if (target) pushCall(target, at);
	}
	// `(function named(){…})()` / `(function(){…})()` / `(()=>{…})()` 没有第二个具名调用 token，补执行入口。
	for (const fn of functions) if (fn.immediatelyInvoked) pushCall(fn, fn.bodyEnd);

	for (const create of creates) {
		if (!create.fn) {
			// ① create 直接落在 loop 体内：嵌套次数由当前执行作用域中的所有祖先 loop 相乘。
			if (create.loops.length === 0) continue;
			const nearest = create.loops
				.slice()
				.sort((a, b) => a.bodyEnd - a.bodyStart - (b.bodyEnd - b.bodyStart))[0];
			const body = innermostLoopBody(create.at, create.loops);
			const freshAt = freshParentDeclaration(create.parent, create.at, null);
			add(
				create.tag,
				create.parent,
				loopProduct(loopsForOneParent(create.loops, freshAt)),
				perElementDriven(code, body, create.elVar),
				`${nearest.kind} (${nearest.header.trim()})`,
				freshAt === null ? "shared-parent" : `fresh-parent:${freshAt}`,
			);
			continue;
		}

		/*
		 * ② 具名 factory：只跟一层显式调用。factory 自己还有 loop 时，内部 trip count 与调用点
		 * 的外部 loop 相乘，而不是把“定义处内层次数”和“调用处外层次数”各算一批后相加。
		 */
		const fnCalls = callsByFunction.get(create.fn.declStart) ?? [];
		if (fnCalls.length === 0 && create.loops.length > 0) {
			// 函数体自己的 loop 本身即满足“create 落在配平 loop 体内”；无需猜测 callback 的运行时可达性。
			const nearest = create.loops
				.slice()
				.sort((a, b) => a.bodyEnd - a.bodyStart - (b.bodyEnd - b.bodyStart))[0];
			const boundParent = parentBindingScope(create.fn, create.parent);
			const freshAt = freshParentDeclaration(create.parent, create.at, boundParent);
			add(
				create.tag,
				create.parent,
				loopProduct(loopsForOneParent(create.loops, freshAt)),
				perElementDriven(code, innermostLoopBody(create.at, create.loops), create.elVar),
				`${nearest.kind} (${nearest.header.trim()})`,
				freshAt !== null
					? `fresh-parent:${freshAt}`
					: boundParent
						? `function:${boundParent.declStart}`
						: "shared-parent",
			);
		}
		for (const call of fnCalls) {
			if (create.loops.length === 0 && call.loops.length === 0) continue;
			const callerBody = innermostLoopBody(call.at, call.loops);
			const boundParent = parentBindingScope(create.fn, create.parent);
			const freshAt = freshParentDeclaration(create.parent, create.at, boundParent);
			const oneParentInside = loopProduct(loopsForOneParent(create.loops, freshAt));
			const oneParentOutside = loopProduct(loopsForOneParent(call.loops, freshAt));
			const freshOwnedByFactory = freshAt !== null && boundParent === create.fn;
			// 工厂内新建的 parent 每次调用都不是同一节点；参数 parent 仍按 spec 的标识符口径累计。
			const count =
				freshOwnedByFactory
					? oneParentInside
					: oneParentInside === null || oneParentOutside === null
						? null
						: oneParentInside * oneParentOutside;
			add(
				create.tag,
				create.parent,
				count,
				perElementDriven(code, `${create.fn.body}\n${callerBody}`, create.elVar),
				create.fn.name ? `factory ${create.fn.name}` : `IIFE @${create.fn.declStart}`,
				freshAt !== null
					? `fresh-parent:${freshAt}`
					: boundParent
						? `function:${boundParent.declStart}`
						: "shared-parent",
			);
		}
	}

	return [...grouped.values()].map((batch) => ({
		tag: batch.tag,
		parent: batch.parent,
		count: batch.unknown ? null : batch.count,
		perElementDriven: batch.perElementDriven,
		site: [...batch.sites].join(" + "),
	}));
}

/**
 * 回调体（或它调用的具名函数体）里是否有 DOM 写入。
 *
 * **为什么要跟进调用**：栏目主力写法是 `onUpdate: render` / `onUpdate: function(){ layoutGaps(st.k); }`——
 * DOM 写入几乎从不直接躺在回调体里。只认「回调体本身出现关键字」的话，真机上真用 `onUpdate` 的 5 颗里
 * 只认得出 4 颗，安全网等于半开（同 fix-mg-lint-law7-estimate 的教训：认不出主力写法的检查等于没有）。
 * 故沿调用链再跟 `hops` 层具名函数（`seen` 防环 + 防重复展开）。恒非致命，误差可接受。
 */
function bodyWritesDom(html: string, body: string, hops: number, seen: Set<string>): boolean {
	if (DOM_WRITE.test(body)) return true;
	if (hops <= 0) return false;
	for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
		const name = m[1];
		if (NOT_A_CALL.has(name) || seen.has(name)) continue;
		seen.add(name);
		const b = namedFnBody(html, name);
		if (b && bodyWritesDom(html, b, hops - 1, seen)) return true;
	}
	return false;
}

/** 契约「回调与 seek 语义」的两类静态信号。 */
export interface SeekSignals {
	/** (a) 时间线回调体内含 DOM/属性写入 = 画面靠回调驱动。 */
	callbackDom: boolean;
	/** 命中 (a) 的钩子名（去重、按 TL_HOOKS 顺序），供文案点名。 */
	hooks: string[];
	/** (b) 运行时覆写引擎所调 API（重赋值 `tl.seek` / 把 `__timelines[…]` 换成包装对象）。 */
	engineApiOverride: boolean;
	/** 命中 (b) 的形态描述，供文案点名。 */
	overrideForms: string[];
}

/**
 * 静态识别契约「回调与 seek 语义」的两类信号。
 *
 * **(a) 回调驱动画面**：逐个找 `onUpdate|onStart|onComplete|onRepeat :`，取其值——
 * 内联 `function(){…}` / 箭头函数取函数体；**具名引用**（`onUpdate: render`，栏目主力写法、
 * 真机与 3 件 exemplar 皆此形）解析具名函数体，并沿调用链再跟 2 层（见 `bodyWritesDom`）。
 * 只认「链上出现 DOM 写入关键字」，纯计算型回调（只改状态对象、由属性补间落到画面）**不报**——
 * 这是本 change 拍死的口径。已知漏网（都往「不报」偏，宁可漏不可误伤）：成员表达式引用
 * （`R.render`）、超过 2 跳的间接调用、经变量传递的函数值。
 *
 * **(b) 引擎 API 覆写**：`x.seek = …` / `x["seek"] = …` 的重赋值；以及
 * `window.__timelines[…] = <非裸标识符>`（合规注册恒为 `__timelines[id] = tl`，故裸标识符 RHS **不报**，
 * 真机 21/21 与全部 exemplar 均为该形 → 零误伤）。
 */
export function detectSeekSignals(html: string): SeekSignals {
	// (a) 回调体内的 DOM 写入
	const hooks = new Set<string>();
	const hookRe = new RegExp(`\\b(${TL_HOOKS.join("|")})\\s*:\\s*`, "g");
	let hm: RegExpExecArray | null;
	while ((hm = hookRe.exec(html))) {
		const hook = hm[1];
		const at = hm.index + hm[0].length;
		const rest = html.slice(at);
		let body: string | null = null;
		let mm: RegExpExecArray | null;
		if ((mm = /^function\s*[A-Za-z_$]?[\w$]*\s*\([^)]*\)\s*\{/.exec(rest))) {
			body = braceBlock(html, at + mm[0].length - 1); // 内联匿名/具名函数
		} else if ((mm = /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/.exec(rest))) {
			const after = at + mm[0].length;
			// 箭头函数：块体取配平块，表达式体取到行尾（够覆盖 `()=>el.textContent=v` 这类单表达式）
			body = html[after] === "{" ? braceBlock(html, after) : rest.slice(mm[0].length).split("\n")[0];
		} else if ((mm = /^([A-Za-z_$][\w$]*)/.exec(rest))) {
			body = namedFnBody(html, mm[1]); // 具名引用 → 解析一层
		}
		if (body && bodyWritesDom(html, body, 2, new Set())) hooks.add(hook);
	}

	// (b) 引擎 API 覆写
	const overrideForms: string[] = [];
	if (/\.\s*seek\s*=(?!=)|\[\s*["']seek["']\s*\]\s*=(?!=)/.test(html)) overrideForms.push("重新赋值 `.seek`");
	for (const rm of html.matchAll(/window\s*\.\s*__timelines\s*\[[^\]]*\]\s*=\s*([^;\n]*)/g)) {
		const rhs = rm[1].split("//")[0].trim();
		// 合规注册是 `__timelines[id] = tl`（裸标识符）；换成对象字面量/函数/包装表达式才是覆写
		if (rhs && !/^[A-Za-z_$][\w$]*$/.test(rhs)) {
			overrideForms.push("`__timelines[…]` 被赋成包装对象而非时间线本体");
			break;
		}
	}

	return {
		callbackDom: hooks.size > 0,
		hooks: TL_HOOKS.filter((h) => hooks.has(h)),
		engineApiOverride: overrideForms.length > 0,
		overrideForms,
	};
}

export function lintParticle(
	html: string,
	opts: {
		/**
		 * **期望** composition_id（不是覆盖值）——铺轨模式=该条派单的 `composition_id`；
		 * `mg lint <file>` = 文件名 basename（仅当它形如 composition_id 或命中派单时才传）。
		 * 与 HTML 内解析出的 `data-composition-id` 不等 → 致命 `1-cid-expect`（复制改名漏改内部 id）。
		 */
		compositionId?: string;
		dispatchIds?: string[];
		category?: string;
		/**
		 * 该颗粒的槽位包络（秒）。给了才跑铁律⑦启发式；裸 lint / 未命中派单时不给 → 整项跳过。
		 * 契约明令「逐帧与总长只有真渲染引擎能判」，故本项**恒非致命**、只做提醒。
		 */
		slotDuration?: number;
	} = {},
): LintResult {
	const v: LintViolation[] = [];
	const push = (law: string, fatal: boolean, msg: string) => v.push({ law, fatal, msg });

	// 铁律1：<template> 包裹 + 根 data-* 三件
	if (!/<template[\s>]/i.test(html)) push("1-template", true, "缺 <template> 包裹根元素（裸 div 整片渲染失败）");
	const root = rootTag(html);
	const cid = root ? attr(root, "data-composition-id") : undefined;
	if (!root || !cid) push("1-composition-id", true, "根元素缺 data-composition-id");
	// 期望 id 一致性：opts.compositionId 是**期望值**（铺轨=派单 id / lint=形如 cid 的 basename），不再覆盖 cid。
	// 不等 = 复制 <id>.html 改名时漏改内部 id → 落轨会写出以期望 id 命名的 clip/material，
	// 但文件注册的是另一个 __timelines 键、且与同名颗粒抢同一个 [data-composition-id] 样式作用域。
	if (opts.compositionId && cid && opts.compositionId !== cid)
		push(
			"1-cid-expect",
			true,
			`HTML 内 data-composition-id「${cid}」与期望 id「${opts.compositionId}」不符（复制改名漏改内部 id？）——` +
				`按期望 id 落轨会写出 clip_id/material 指向「${opts.compositionId}」，而本文件注册的是 __timelines["${cid}"]，渲染必错`,
		);
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

	// 铁律4 后半：透明与否必须显式 + 实心底 MUST 下沉子层（align-particle-solid-backdrop-contract）。
	// 推导面 = 根 style ∪ 根下首个全幅子层 style，与契约铁律4④ 同源。
	const { opaque, declared, solidOnRoot, solidOnChild } = deriveOpaque(root, firstChildTag(html, root));
	if (root && !declared)
		push(
			"4-bg-explicit",
			false,
			"根与根下首个全幅子层**都**没有显式声明 background（契约铁律4③：透明与否 MUST 显式）——" +
				"满屏颗粒应在根下第一个全幅子层（position:absolute;inset:0）声明实心底；" +
				"透明叠加颗粒应在根显式写 background:transparent。缺省按透明叠加 opaque=false 处理",
		);
	// 契约铁律4①② 明令禁止的形态：实心底写在根 style 上。恒**非致命**（不拦铺轨），但必须点名后果。
	if (solidOnRoot && !solidOnChild)
		push(
			"4-bg-on-root",
			false,
			"实心底写在**根 style** 上（契约铁律4①②：MUST 下沉为根下第一个全幅子层，根 MUST 保持零视觉）——" +
				"**根元素的绘制属性会在子合成挂载时被丢弃**，这层底在成片里一个像素都不落地：" +
				"前景照常渲出、底没了、底轨透出来，观感是「浮空面板」；而本地播放器与客户端预览都看不出（2026-07-26 r69 真渲实测，见契约铁律4证据锚）。" +
				"改法是机械的：把这条 background 声明整体搬到根下新增的第一个全幅子层" +
				'（<div style="position:absolute;inset:0;background:<原底色>;z-index:0;"></div>），根上改写 background:transparent',
		);

	// 铁律6：禁 var()
	if (/var\(\s*--/.test(html)) push("6-css-var", true, "含 CSS var(--...)（Hyperframes 不解析→整片全黑，须字面值）");

	// 契约「回调与 seek 语义」：③兜底哨兵 + 引擎 API 覆写。**两项恒非致命**——
	// 主防线是契约①的引擎侧 MUST（定帧 MUST 保证回调可达），本地静态检查只做提醒。
	const sig = detectSeekSignals(html);
	if (sig.engineApiOverride)
		push(
			"x-engine-api-override",
			false,
			`颗粒在运行时覆写了渲染引擎所调用的 API（${sig.overrideForms.join("、")}）——它会推翻引擎**显式**传入的 ` +
				`seek(t, true)（颗粒无权静默否决引擎意图），且只在引擎恰好走 seek 时有效，引擎改走 time() / progress() 即完全失效。` +
				`按契约「回调与 seek 语义」，回调可达性应由**引擎侧**承担，颗粒侧垫片属过渡态——` +
					`引擎侧结论已于 2026-07-26 经真机核实（引擎 producer 0.6.101 定帧时回调可达），既有垫片可择期清理（删后须重渲复验），新颗粒不应再加`,
		);
	// 哨兵：(a) 有、(b) 无才报——作者已自带兜底时重复提醒是噪音（判定表第二行）
	if (sig.callbackDom && !sig.engineApiOverride)
		push(
			"x-callback-driven",
			false,
			`画面靠时间线回调驱动（${sig.hooks.join(" / ")} 体内写 DOM），且本颗粒无任何 seek 兜底。` +
				`该写法**合规**——其可达性由契约「回调与 seek 语义」的**引擎侧 MUST 条款**保证` +
					`（2026-07-26 已真机核实：引擎 producer 0.6.101 定帧时回调可达；结论**绑定该引擎版本**），` +
				`作者不必也不应为此加装 tl.seek 垫片。本项只是**哨兵**：引擎若失守或换实现，补间属性照常插值、回调不跑 → ` +
				`画面会静默定格在初始态（不是黑屏，本地播放器与客户端预览都看不出）`,
		);
	// 契约「专属坑」：别用 rAF/setInterval 驱动画面（不被 seek，等于冻结）。静态正则分不清用途 → 非致命
	const timers = [
		/\brequestAnimationFrame\s*\(/.test(html) ? "requestAnimationFrame(" : null,
		/\bsetInterval\s*\(/.test(html) ? "setInterval(" : null,
	].filter(Boolean);
	if (timers.length)
		push(
			"x-raf-interval",
			false,
			`含 ${timers.join(" 与 ")}——这类自有时钟**不被 seek 驱动**，逐帧渲染时等于冻结（契约：所有视觉变化必须挂在 tl 上）。` +
				`静态正则分不清「驱动画面」与其它用途（如一次性布局测量），故只提醒、不拦`,
		);

	// 派生：composition_id 对齐 dispatch。**用 HTML 内解析出的 cid** 比对——
	// 旧实现拿调用方传入的期望 id 自比自（铺轨模式下恒有值）＝恒真检查，等于没查。
	if (opts.dispatchIds && cid && !opts.dispatchIds.includes(cid))
		push("x-dispatch", false, `composition_id "${cid}" 不在 dispatch.mg 派单中`);

	// 品类↔opaque 对账（裁决⑩，声明+校验；以 HTML 反推 opaque 为准，不符只告警）
	if (opts.category && opts.category in CATEGORY_EXPECTED_OPAQUE) {
		const expect = CATEGORY_EXPECTED_OPAQUE[opts.category];
		if (expect !== opaque)
			push("x-category-opaque", false, `category「${opts.category}」期望${expect ? "不透明满屏" : "透明叠加"}，但颗粒 HTML 反推为${opaque ? "不透明满屏" : "透明叠加"}（以 HTML 为准落 clip.opaque=${opaque}）`);
	}

	// 铁律⑦：颗粒应占满坑位并终态驻留。静态估长只能给**下界**，故恒非致命（含下面两条提示）——
	// 真正的判据是渲染引擎逐帧 seek，本项只提醒。**但「算不出来」MUST NOT 与「算过且通过」同形沉默。**
	if (typeof opts.slotDuration === "number" && opts.slotDuration > 0) {
		const slot = opts.slotDuration;
		const { est, parsed, skipped, hasInfiniteRepeat } = estimateTimelineSec(html);
		if (hasInfiniteRepeat)
			push(
				"7-infinite-repeat",
				false,
				`含 repeat:-1 无限循环 → tl 时长为 Infinity，铁律⑦（总长 ≥ 坑位）无法静态验证；请改用按坑位算死的有限 repeat（次数 = ceil(剩余时长 / 单圈时长)），坑位包络 ${slot}s`,
			);
		if (parsed === 0)
			push(
				"7-no-estimate",
				false,
				`无法静态估长（无一条可解析的时长调用${skipped ? `，${skipped} 条因表达式 position / 非字面量 duration 跳过` : ""}），铁律⑦未校验——须真渲染引擎 seek 验收颗粒是否占满坑位 ${slot}s 并终态驻留`,
			);
		else if (Number.isFinite(est) && est < slot)
			push(
				"7-fill-slot",
				false,
				`时间线静态估长 ~${est}s，短于槽位包络 ${slot}s（铁律⑦：颗粒应占满坑位并终态驻留）——静态估算是**下界**（${skipped} 条调用因无法静态解析被跳过），仅供参考，最终以真渲染引擎逐帧为准`,
			);
	}

	// 铁律⑧：只提示可无损合并的写法形态，**不是**风险判定；恒非致命，不影响 ok / 铺轨 / 退出码。
	for (const batch of detectPrimitiveLoops(html)) {
		if (batch.perElementDriven || (batch.count !== null && batch.count < PRIMITIVE_MERGE_MIN)) continue;
		const amount =
			batch.count === null ? "条数未知（循环边界非数字字面量）" : `静态估算 ${batch.count} 个`;
		push(
			"8-primitive-merge",
			false,
			`${batch.site} 向同一父节点「${batch.parent}」循环生成 ${amount} <${batch.tag}>。` +
				"这里有一批可无损合并的重复图元：请按相同 stroke/fill 分档合并成单个 <path> 的多子路径；" +
				"合并后画面逐像素不变，属零成本改法。本项只提示写法形态，最终画面仍以真渲染出片为准",
		);
	}

	return { ok: !v.some((x) => x.fatal), violations: v, opaque, compositionId: cid };
}
