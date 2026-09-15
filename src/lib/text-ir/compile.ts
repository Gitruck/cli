/**
 * IR 文字子集 v0.1 → gsap-emit v1 透明颗粒（TypeScript 实现）。
 *
 * ## 这是第二实现，正本在 Python
 *
 * 正本 = `gitruck-infra/utils/process/media/vision/text_ir/compile.py`。本文件是它的
 * **逐字节等价移植**，存在的唯一理由是让 L0 改动（改字 / 改色 / 改字体 / 改时长）
 * 能在本地跑完，不必每动一个参数就打一次云端往返
 * （change `move-text-ir-compiler-to-client`）。
 *
 * ⚠️ **两份实现的产物 MUST 逐字节相同**，由 CI 的等价闸守着（93 份金样逐份对拍）。
 * 改这个文件**必须**同步改 Python 那份，反之亦然。闸判红时 MUST NOT 加容差——
 * `html_sha256` 是精确比较，差一个空格与差一整段在下游是同一个后果：
 * 服务端产物被判成 `detached`、云端改写入口失效，**而且不报错**。
 *
 * ## 为什么能对得上
 *
 * 跨语言逐字节相同不是自然发生的，靠的是三件事：
 *
 * 1. **数值归一**（正本 2026-09-14 加的）。Python 对 float 1.0 打印 "1.0"、JS 打印 "1"，
 *    而 JS 端 `JSON.parse` 之后分不出这两者。正本在 `canonical_json` 与 `compile_ir`
 *    入口都把整数值的浮点归整，本文件照做。
 * 2. **显式 `.1f`** 的地方用 `toFixed(1)`，两端同形。
 * 3. **非整数浮点**两端本来就一致（同一套 IEEE754 + 同一套最短往返表示），
 *    只有科学计数法的切换阈值不同 —— `pyNum()` 把那一档也对齐了。
 */

/** 铁律 5：GSAP 只许走这个 CDN（云渲容器里只放行它）。 */
const CDN = "https://lib.baomitu.com/gsap/3.13.0/gsap.min.js";

/** IR 通道名 → GSAP 属性名。次序见 `ANIM_CHANNELS`。 */
const CH: Record<string, string> = {
	x: "x",
	y: "y",
	scale: "scale",
	sx: "scaleX",
	sy: "scaleY",
	rot: "rotation",
	rotX: "rotationX",
	rotY: "rotationY",
	opacity: "opacity",
	ls: "letterSpacing",
	// v0.2：斜切。纯 transform、零卷积。
	skx: "skewX",
	sky: "skewY",
};

/**
 * 通道遍历次序。**MUST NOT 用对象自身的键序**：IR 的哈希走键排序后的规范化 JSON，
 * 两份语义相同但键序不同的 IR 有同一个 `ir_sha256`；产物若跟着键序走，
 * 同一个 IR 在两处会编出不同 HTML，三态身份与内容寻址缓存当场崩。
 * 这条是 38 份金样对拍抓出来的（正本同注）。
 */
const ANIM_CHANNELS = [
	"x",
	"y",
	"scale",
	"sx",
	"sy",
	"rot",
	"rotX",
	"rotY",
	"opacity",
	"ls",
	// v0.2 追加**恒在末尾**：本表是产物通道次序的唯一真相，往中间插会让既有金样整体位移。
	"skx",
	"sky",
] as const;

const DEFAULT_FONT = "思源黑体";
const EPS = 1e-6;

export class TextIrCompileError extends Error {}

/** IR 正文里出现了会截断内嵌载体的字面量（对应正本的 `IrCarrierConflict`）。 */
export class IrCarrierConflict extends TextIrCompileError {}

/**
 * 内嵌 IR 块。与正本 `identity.ir_script_block` 同口径。
 *
 * `</template>` 会把载体提前截断（与旧载体怕 `</script>` 同一类风险）。槽位文本与
 * `note` 都是自由文本，用户完全可以敲出这串。**当场报错，不静默转义**：转义会让内嵌的
 * 字节与 `canonicalJson` 的字节不再一致，而 `ir_sha256` 正是按后者算的——一转义三态就开始骗人。
 *
 * ⚠️ 编译搬到客户端之后这条路径从「服务端兜底」变成**用户输入直达**，
 * 少了它就是：用户在槽位里敲了 `</template>` → 颗粒静默截断、渲染出半截、不报错。
 */
function irCarrierBlock(ir: Dict): string {
	const payload = canonicalJson(ir);
	if (payload.includes("</template>")) {
		throw new IrCarrierConflict("IR 正文含 `</template>` 字面量，会截断内嵌载体；请改写该文本（多半在槽位或 note 里）");
	}
	return `<template data-gtrk-ir>${payload}</template>`;
}

type Json = unknown;
// biome-ignore lint/suspicious/noExplicitAny: IR 是开放形状的字典，正本也是 dict
type Dict = Record<string, any>;

// ── 数值 ──────────────────────────────────────────────────────────────

/** 整数值的浮点 → 整数（对齐正本的 `_n()` / `canon_nums`）。 */
function n(v: unknown): unknown {
	if (typeof v === "number" && Number.isInteger(v)) return v;
	return v;
}

/**
 * Python `repr(float)` 的等价形态。
 *
 * 两端对普通浮点本来就一致（同一套 IEEE754 + 最短往返表示），**只差科学计数法的阈值**：
 * Python 在 |x| < 1e-4 转指数（`1e-05`），JS 要到 < 1e-6（`0.00001`）。
 * 这一档不对齐的话，一个足够小的 `each` 或 `dur` 就会让两端分叉。
 */
function pyNum(v: number): string {
	if (Number.isInteger(v)) return String(v);
	const a = Math.abs(v);
	if (a !== 0 && a < 1e-4) {
		// Python 形态：`1e-05` / `1.5e-05`（指数两位、无 `+`）
		const s = v.toExponential();
		const [m, e] = s.split("e");
		const exp = Number(e);
		const sign = exp < 0 ? "-" : "+";
		const abs = String(Math.abs(exp)).padStart(2, "0");
		return `${m}e${sign}${abs}`;
	}
	return String(v);
}

/** `json.dumps(v, ensure_ascii=False)` 的等价形态（数值走 `pyNum`）。 */
function pyJson(v: Json): string {
	if (v === null) return "null";
	if (typeof v === "boolean") return v ? "true" : "false";
	if (typeof v === "number") return pyNum(v);
	if (typeof v === "string") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
	if (typeof v === "object") {
		const o = v as Dict;
		return `{${Object.keys(o)
			.map((k) => `${JSON.stringify(k)}: ${pyJson(o[k])}`)
			.join(", ")}}`;
	}
	return "null";
}

/**
 * canonical JSON：键排序、无空白、保留中文、整数值的浮点归整。
 * 与正本 `identity.canonical_json` 逐字节等价——`ir_sha256` 与内嵌块都按它算。
 */
export function canonicalJson(ir: Json): string {
	const enc = (v: Json): string => {
		if (v === null) return "null";
		if (typeof v === "boolean") return v ? "true" : "false";
		if (typeof v === "number") return pyNum(v);
		if (typeof v === "string") return JSON.stringify(v);
		if (Array.isArray(v)) return `[${v.map(enc).join(",")}]`;
		if (typeof v === "object") {
			const o = v as Dict;
			return `{${Object.keys(o)
				.sort()
				.map((k) => `${JSON.stringify(k)}:${enc(o[k])}`)
				.join(",")}}`;
		}
		return "null";
	};
	return enc(ir);
}

// ── 小工具（逐个对齐正本）──────────────────────────────────────────────

/** Python `html.escape(s)`（quote=True）。顺序要紧：`&` 必须先换。 */
function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#x27;");
}

/** 对齐正本的 `round(x, 6)`。时刻全按绝对秒算，两端必须同一个取整。 */
function round6(x: number): number {
	return Math.round(x * 1e6) / 1e6;
}

function isNum(v: unknown): boolean {
	return typeof v === "number" && Number.isFinite(v);
}

/** `$name` 颜色引用 → 字面值（铁律 6：运行时禁 CSS `var()`）。 */
function res(ir: Dict, v: unknown): unknown {
	if (typeof v === "string" && v.startsWith("$")) {
		const c = (ir.colors ?? {})[v.slice(1)];
		if (!c) throw new TextIrCompileError(`未定义颜色引用 ${v}`);
		return c;
	}
	return v;
}

/** 逐字出场次序。scramble 用确定性置换（黄金角跳步），不用随机数。 */
function perm(count: number, order: string): number[] {
	if (order === "reverse") {
		const out: number[] = [];
		for (let i = count - 1; i >= 0; i--) out.push(i);
		return out;
	}
	if (order === "center") {
		const mid = (count - 1) / 2;
		// Python `sorted` 稳定，JS `sort` 自 ES2019 起也稳定 —— 同名次时保持原序
		return Array.from({ length: count }, (_, i) => i).sort(
			(a, b) => Math.abs(a - mid) - Math.abs(b - mid),
		);
	}
	if (order === "scramble") {
		const out: number[] = [];
		const seen = new Set<number>();
		let i = 0;
		const step = Math.max(1, Math.trunc(count * 0.618)) | 1;
		while (out.length < count) {
			while (seen.has(i)) i = (i + 1) % count;
			out.push(i);
			seen.add(i);
			i = (i + step) % count;
		}
		return out;
	}
	return Array.from({ length: count }, (_, i) => i);
}

function splitUnits(txt: string, unit: string): string[] {
	if (unit === "word") return txt.match(/\S+|\s+/g) ?? [];
	if (unit === "line") return txt.split("\n");
	// Python `list(str)` 按码位切；`Array.from` 同样走迭代器，代理对不会被拆开
	return Array.from(txt);
}

function cursorConf(st: Dict): Dict | null {
	const cw = st.cursor;
	if (!cw) return null;
	return typeof cw === "object" ? (cw as Dict) : {};
}

function cursorEnabled(st: Dict): boolean {
	return (
		cursorConf(st) !== null &&
		(st.unit ?? "char") !== "line" &&
		["forward", "reverse"].includes(st.order ?? "forward")
	);
}

// ── 样式与 DOM ────────────────────────────────────────────────────────

function textContentStyle(ir: Dict, L: Dict): string[] {
	const s: string[] = [];
	const f: Dict = L.font ?? {};
	s.push(`font-family:'${f.family ?? DEFAULT_FONT}',sans-serif`);
	s.push(`font-weight:${pyNum(f.weight ?? 700)}`);
	s.push(`font-size:${pyNum(f.size ?? 64)}px`);
	if ("ls" in f) s.push(`letter-spacing:${pyNum(f.ls)}px`);
	s.push(`line-height:${pyNum(f.lh ?? 1.25)}`);
	s.push(`color:${res(ir, L.color ?? "#ffffff")}`);
	s.push(`text-align:${L.align ?? "center"}`);
	if (L.vertical) s.push("writing-mode:vertical-rl;text-orientation:upright");
	// ⚠️ `width:max-content` 不能省。`.ct` 是 `position:absolute` 且只给了 `left`，
	// 「收缩到适应」的可用宽因此是**包含块宽 − left**（`.ly` 是 inset:0，即画布宽）：
	// 居中层 left=960 ⇒ 只有 960px。`nowrap` 时不显形（溢出再靠 translate 拉回来居中），
	// 一切成 `normal` 它就变成真约束，maxWidth 写多大都没用。
	// `max-content` 把用过的宽钉成「不换行时的 preferred 宽」再由 max-width 封顶。
	if (L.maxWidth)
		s.push(
			`width:max-content;max-width:${pyNum(L.maxWidth)}px;` +
				`white-space:normal;word-break:break-all`,
		);

	const b: Dict | undefined = L.box;
	if (b) {
		const pad = b.pad ?? [24, 12];
		s.push(`padding:${pyNum(pad[1])}px ${pyNum(pad[0])}px`);
		if (b.fill) s.push(`background:${res(ir, b.fill)}`);
		if (b.radius) s.push(`border-radius:${pyNum(b.radius)}px`);
		if (b.stroke) s.push(`border:${pyNum(b.strokeWidth ?? 3)}px solid ${res(ir, b.stroke)}`);
		s.push("box-sizing:border-box");
	}

	// glow 与 shadow 共用 text-shadow 通道，按「先辉光后投影」叠。
	const g: Dict | undefined = L.glow;
	const sd: Dict | undefined = L.shadow;
	const shadows: string[] = [];
	if (g) shadows.push(`0 0 ${pyNum(g.blur ?? 24)}px ${res(ir, g.color ?? "#ffffff")}`);
	if (sd) {
		shadows.push(
			`${pyNum(sd.dx ?? 0)}px ${pyNum(sd.dy ?? 4)}px ${pyNum(sd.blur ?? 8)}px ${res(ir, sd.color ?? "#000000")}`,
		);
	}
	if (shadows.length) s.push(`text-shadow:${shadows.join(",")}`);

	const stk: Dict | undefined = L.stroke;
	if (stk) {
		s.push(
			`-webkit-text-stroke:${pyNum(stk.width ?? 2)}px ${res(ir, stk.color ?? "#000000")};paint-order:stroke fill`,
		);
	}
	// 逐字 3D 翻转要在内容层建透视，否则每个字各自透视、看着是平的
	if (L.sweep) s.push(sweepStyle(ir, L.sweep));
	if (["rotX", "rotY"].includes((L.stagger ?? {}).prop)) s.push("perspective:900px");
	return s;
}

/** v0.2：片段文字可来自槽位（`slot`）而不是字面量（`t`）。二者互斥（校验器保证）。 */
function runText(ir: Dict, r: Dict): string {
	if ("slot" in r) return (ir.slots ?? {})[r.slot] ?? "";
	return r.t ?? "";
}

function textInner(ir: Dict, L: Dict, txt: string): string {
	const runs: Dict[] | undefined = L.runs;
	if (runs) {
		return runs
			.map(
				(r, k) =>
					`<span class="rn" data-r="${k}" style="display:inline-block;` +
					`color:${res(ir, r.c ?? L.color ?? "#ffffff")}">` +
					`${esc(runText(ir, r))}</span>`,
			)
			.join("");
	}

	if (L.charRoll) return charRollInner(L, txt);

	const st: Dict | undefined = L.stagger;
	if (!st) return esc(txt).replace(/\n/g, "<br>");

	const unit = st.unit ?? "char";
	const parts = splitUnits(txt, unit);
	const useCr = cursorEnabled(st);
	let crStyle = "";
	let preStyle = "";
	if (useCr) {
		const cw = cursorConf(st) as Dict;
		const forward = (st.order ?? "forward") !== "reverse";
		const after = forward ? "left:100%;margin-left:0.1em" : "right:100%;margin-right:0.1em";
		const before = forward ? "right:100%;margin-right:0.1em" : "left:100%;margin-left:0.1em";
		const box =
			`width:${pyNum(cw.w ?? 0.06)}em;height:${pyNum(cw.h ?? 0.9)}em;` +
			`background:${res(ir, cw.color ?? L.color ?? "#ffffff")}`;
		crStyle = `style="${after};${box}"`;
		preStyle = `style="${before};${box}"`;
	}

	const spans: string[] = [];
	parts.forEach((p, k) => {
		if (unit === "line") {
			// 逐行单元必须 block：.ch 缺省 inline-block 会把多行挤成一行
			spans.push(`<div class="ch ln" data-k="${k}" style="display:block">${esc(p)}</div>`);
			return;
		}
		const cr = useCr ? `<span class="cr" data-c="${k}" ${crStyle}></span>` : "";
		const pre = useCr && k === 0 ? `<span class="cr" data-c="pre" ${preStyle}></span>` : "";
		spans.push(`<span class="ch" data-k="${k}">${esc(p)}${pre}${cr}</span>`);
	});
	return spans.join("");
}

/** 镜头感十字星芒：亮核 + 两条主光芒 + 两条弱对角，全部 CSS 渐变，零滤镜。 */
function star4Inner(ir: Dict, shape: Dict): string {
	const col = res(ir, shape.fill ?? "#ffffff");
	const ln = shape.rayLen ?? 600;
	const w = shape.rayWidth ?? 16;
	const core = shape.core ?? 100;
	const diag = shape.diag ?? 0.45;

	// 四个都过 `pyNum`：rw/rh 是 `ln*diag` / `w*0.6` 这类算术结果，恒为浮点
	const ray = (rw: number, rh: number, rot: number, op: number) =>
		`<div style="position:absolute;left:50%;top:50%;width:${pyNum(rw)}px;height:${pyNum(rh)}px;` +
		`transform:translate(-50%,-50%) rotate(${pyNum(rot)}deg);opacity:${pyNum(op)};` +
		`background:linear-gradient(90deg,transparent 0%,${col}99 30%,${col} 50%,` +
		`${col}99 70%,transparent 100%);` +
		`clip-path:polygon(0 50%,50% 0,100% 50%,50% 100%)"></div>`;

	return (
		`<div class="sh" style="position:relative;width:${pyNum(ln)}px;height:${pyNum(ln)}px">` +
		ray(ln, w, 0, 1) +
		ray(ln, w, 90, 1) +
		ray(ln * diag, w * 0.6, 45, 0.55) +
		ray(ln * diag, w * 0.6, -45, 0.55) +
		`<div style="position:absolute;left:50%;top:50%;width:${pyNum(core)}px;height:${pyNum(core)}px;` +
		`transform:translate(-50%,-50%);border-radius:50%;` +
		`background:radial-gradient(circle,#ffffff 0%,${col} 16%,${col}99 36%,` +
		`${col}33 55%,transparent 72%)"></div></div>`
	);
}

/** v0.2 扫光：渐变裁到字形，动 `background-position`（区间 0%–100%，校验器有闸）。 */
function sweepStyle(ir: Dict, sw: Dict): string {
	const base = res(ir, sw.base ?? "#ffffff");
	const hi = res(ir, sw.hi ?? "#ffffff");
	const grad = `linear-gradient(100deg,${base} 40%,${hi} 50%,${base} 60%)`;
	return (
		`background-image:${grad};background-size:300% 100%;background-repeat:no-repeat;` +
		`background-position:0% 0;-webkit-background-clip:text;background-clip:text;` +
		`color:transparent;-webkit-text-fill-color:transparent`
	);
}

/** v0.2：形状发光走 `box-shadow`（合成期操作，不是真滤镜）。 */
function shapeGlow(ir: Dict, L: Dict): string {
	const g: Dict = (L.shape ?? {}).glow ?? {};
	return `box-shadow:0 0 ${pyNum(g.blur ?? 12)}px ${res(ir, g.color ?? "#ffffff")}`;
}

/** 缺省候选字集。**不含空白**——空白位轮换会冒出实体字、把排版撑歪。 */
const ROLL_POOL = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** v0.2 charRoll 的内容 DOM：每字一枚 `.ch`，里面堆候选字形兄弟元素。 */
function charRollInner(L: Dict, txt: string): string {
	const cr: Dict = L.charRoll;
	const pool: string = cr.pool || ROLL_POOL;
	const steps = Math.trunc(cr.steps ?? 4);
	const dim = cr.dim;
	const out: string[] = [];
	Array.from(txt).forEach((ch, k) => {
		if (ch === "\n") {
			out.push("<br>");
			return;
		}
		if (!ch.trim()) {
			out.push(`<span class="ch">${esc(ch)}</span>`);
			return;
		}
		let cands = "";
		for (let j = 0; j < steps; j++) {
			const style = dim === undefined || dim === null ? "" : `;opacity:${pyNum(dim)}`;
			cands +=
				`<span class="cr" style="display:none${style}">` +
				`${esc(pool[(k * 7 + j * 13) % pool.length])}</span>`;
		}
		out.push(
			`<span class="ch" data-c="${k}">${cands}` +
				`<span class="rl" style="display:none">${esc(ch)}</span></span>`,
		);
	});
	return out.join("");
}

function shapeInner(ir: Dict, shape: Dict): string {
	const kind = shape.kind ?? "rect";
	if (kind === "star4") return star4Inner(ir, shape);
	const sh = [`width:${pyNum(shape.w)}px`, `height:${pyNum(shape.h)}px`, "box-sizing:border-box"];
	if (shape.fill) sh.push(`background:${res(ir, shape.fill)}`);
	if (shape.stroke) sh.push(`border:${pyNum(shape.strokeWidth ?? 3)}px solid ${res(ir, shape.stroke)}`);
	if (kind === "ellipse") sh.push("border-radius:50%");
	else if (shape.radius) sh.push(`border-radius:${pyNum(shape.radius)}px`);
	return `<div class="sh" style="${sh.join(";")}"></div>`;
}

/** v0.2：`mask` 可为数组（多条并存）。单对象老写法保持兼容——93 份金样在用。 */
function maskStyles(m: Dict | Dict[], w: number, h: number): string[] {
	const items = Array.isArray(m) ? m : [m];
	return items.map((one) => maskStyle(one, w, h));
}

function maskStyle(m: Dict, w: number, h: number): string {
	if (m.type === "feather-band") {
		const f = m.feather;
		// v0.2：`feather` 可为 [上端, 下端]（不等量）。单值语义不变（两端同量）。
		const f0: number = Array.isArray(f) ? f[0] : f;
		const f1: number = Array.isArray(f) ? f[1] : f;
		const y0 = m.y;
		const bh = m.h;
		const grad =
			`linear-gradient(to bottom,transparent 0%,#000 ${(f0 * 100).toFixed(1)}%,` +
			`#000 ${(100 - f1 * 100).toFixed(1)}%,transparent 100%)`;
		return (
			`-webkit-mask-image:${grad};mask-image:${grad};` +
			`-webkit-mask-size:${pyNum(w)}px ${pyNum(bh)}px;mask-size:${pyNum(w)}px ${pyNum(bh)}px;` +
			`-webkit-mask-position:0 ${pyNum(y0)}px;mask-position:0 ${pyNum(y0)}px;` +
			`-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat`
		);
	}
	return `clip-path:inset(${pyNum(m.y)}px ${pyNum(w - m.x - m.w)}px ${pyNum(h - m.y - m.h)}px ${pyNum(m.x)}px)`;
}

// ── JS 段 ─────────────────────────────────────────────────────────────

function emitAnim(el: string, L: Dict, idx: number, js: string[]): void {
	const anim: Dict = L.anim ?? {};
	const channels = ANIM_CHANNELS.filter((ch) => ch in anim);
	const lp: Dict | undefined = L.loop;

	const init: Dict = {};
	for (const ch of channels) {
		const prop = CH[ch];
		const kfs: Dict[] = anim[ch];
		init[prop] = prop === "letterSpacing" ? `${pyNum(kfs[0].v)}px` : kfs[0].v;
	}
	if (Object.keys(init).length) js.push(`gsap.set(${el},${pyJson(init)});`);

	let seg: string | null = null;
	if (lp) {
		seg = `seg_${idx}`;
		js.push(`var ${seg}=gsap.timeline({repeat:${Math.trunc(lp.count) - 1}});`);
	}

	for (const ch of channels) {
		const prop = CH[ch];
		const kfs: Dict[] = anim[ch];
		for (let i = 0; i + 1 < kfs.length; i++) {
			const a = kfs[i];
			const b = kfs[i + 1];
			const d = n(b.t - a.t);
			const va = prop === "letterSpacing" ? `${pyNum(a.v)}px` : a.v;
			const vb = prop === "letterSpacing" ? `${pyNum(b.v)}px` : b.v;
			const ease = b.e ?? "power2.out";
			const tween =
				`fromTo(${el},{${prop}:${pyJson(va)}},{${prop}:${pyJson(vb)},duration:${pyNum(d as number)},` +
				`ease:${pyJson(ease)},immediateRender:false}`;
			if (lp && lp.from - EPS <= a.t && b.t <= lp.to + EPS) {
				js.push(`${seg}.${tween},${pyNum(n(a.t - lp.from) as number)});`);
			} else {
				js.push(`tl.${tween},${pyNum(n(a.t) as number)});`);
			}
		}
	}

	if (lp) js.push(`tl.add(${seg},${pyNum(n(lp.from) as number)});`);
}

function emitRuns(el: string, L: Dict, js: string[]): void {
	(L.runs as Dict[]).forEach((r, k) => {
		const pp: Dict | undefined = r.pop;
		if (!pp) return;
		js.push(
			`tl.fromTo(${el}.querySelector('.rn[data-r="${k}"]'),{scale:1},` +
				`{scale:${pyNum(pp.scale ?? 1.2)},duration:${pyNum(pp.dur ?? 0.16)},` +
				`ease:${pyJson(pp.e ?? "back.out(2)")},yoyo:true,repeat:1,` +
				`immediateRender:false},${pyNum(pp.t)});`,
		);
	});
}

function emitCharRoll(el: string, L: Dict, idx: number, txt: string, js: string[]): void {
	const cr: Dict = L.charRoll;
	const start = Number(cr.start ?? 0);
	const each = Number(cr.each ?? 0.06);
	const step = Number(cr.step ?? 0.05);
	const steps = Math.trunc(cr.steps ?? 4);
	const order: string = cr.order ?? "forward";
	const chars = Array.from(txt);
	const units: number[] = [];
	chars.forEach((ch, k) => {
		if (ch !== "\n" && ch.trim()) units.push(k);
	});
	const pm = perm(units.length, order);
	const rank = new Map<number, number>();
	pm.forEach((posIdx, r) => rank.set(posIdx, r));
	units.forEach((k, pos) => {
		const t0 = start + (rank.get(pos) ?? 0) * each;
		js.push(`var u_${idx}_${pos}=${el}.querySelector('[data-c="${k}"]');`);
		for (let j = 0; j < steps; j++) {
			js.push(
				`tl.set(u_${idx}_${pos}.children[${j}],{display:'inline-block'},${pyNum(round6(t0 + j * step))});`,
			);
			js.push(
				`tl.set(u_${idx}_${pos}.children[${j}],{display:'none'},${pyNum(round6(t0 + (j + 1) * step))});`,
			);
		}
		const t1 = round6(t0 + steps * step);
		js.push(`tl.set(u_${idx}_${pos}.children[${steps}],{display:'inline-block'},${pyNum(t1)});`);
		const pop: Dict | undefined = cr.pop;
		if (pop) {
			js.push(
				`tl.fromTo(u_${idx}_${pos}.children[${steps}],{scale:${pyNum(pop.scale ?? 1.3)}},` +
					`{scale:1,duration:${pyNum(pop.dur ?? 0.18)},ease:${pyJson(pop.e ?? "power2.out")}},${pyNum(t1)});`,
			);
		}
	});
}

function emitSweep(el: string, L: Dict, js: string[]): void {
	const sw: Dict = L.sweep;
	const start = Number(sw.start ?? 0);
	const dur = Number(sw.dur ?? 1.2);
	const repeat = Math.trunc(sw.repeat ?? 0);
	const gap = Number(sw.gap ?? 0);
	const tgt = `${el}.querySelector('.ct')`;
	const extra = repeat ? `,repeat:${pyNum(repeat)},repeatDelay:${pyNum(gap)}` : "";
	js.push(
		`tl.fromTo(${tgt},{backgroundPosition:'100% 0'},` +
			`{backgroundPosition:'0% 0',duration:${pyNum(dur)},ease:'none'${extra}},${pyNum(start)});`,
	);
}

function emitStagger(el: string, L: Dict, idx: number, txt: string, js: string[]): void {
	const st: Dict = L.stagger;
	const prop = CH[st.prop ?? "opacity"];
	const count = splitUnits(txt, st.unit ?? "char").length;
	const pm = perm(count, st.order ?? "forward");
	const each = st.each ?? 0.08;
	const dur = st.dur ?? 0.02;

	js.push(
		`var ch_${idx}=gsap.utils.toArray(${el}.querySelectorAll('.ch'));var pm_${idx}=${pyJson(pm)};`,
	);
	// 每个字的延迟 = 它在置换序列里的名次 × each（确定性，不依赖 GSAP 的 stagger.from）
	js.push(`var dl_${idx}=[];pm_${idx}.forEach(function(k,r){dl_${idx}[k]=r*${pyNum(n(each) as number)};});`);

	// ★ 起始态在构建期置好。immediateRender:false 的 fromTo 在 tween 开始前不应用 from 值，
	//   少了这一行，抽帧会看到「0.15s 整句已亮」。
	const fv0 = st.from ?? 0;
	const fv = prop === "letterSpacing" ? `${pyNum(fv0)}px` : fv0;
	js.push(`gsap.set(ch_${idx},{${prop}:${pyJson(fv)}${st.fade ? ",opacity:0" : ""}});`);

	let extra = "";
	if (st.repeat) extra += `,repeat:${Math.trunc(st.repeat)}`;
	if (st.yoyo) extra += ",yoyo:true";
	let fromv = st.from ?? 0;
	let tov = st.to ?? 1;
	if (prop === "letterSpacing") {
		fromv = `${pyNum(fromv)}px`;
		tov = `${pyNum(tov)}px`;
	}
	const fadeFrom = st.fade ? ",opacity:0" : "";
	const fadeTo = st.fade ? ",opacity:1" : "";
	js.push(
		`tl.fromTo(ch_${idx},{${prop}:${pyJson(fromv)}${fadeFrom}},` +
			`{${prop}:${pyJson(tov)}${fadeTo},duration:${pyNum(dur)},ease:${pyJson(st.e ?? "none")},` +
			`immediateRender:false${extra},stagger:function(idx){return dl_${idx}[idx];}},` +
			`${pyNum(n(st.start) as number)});`,
	);

	if (!cursorEnabled(st)) return;

	const cw = cursorConf(st) as Dict;
	const end = n(st.start + (count - 1) * each + dur) as number;
	const blink = cw.blink ?? 0.3;
	const hold = cw.hold ?? 1.2;
	const total = end + hold - st.start;
	js.push(
		`var crs_${idx}=gsap.utils.toArray(${el}.querySelectorAll('.cr'));` +
			`var pre_${idx}=${el}.querySelector('.cr[data-c="pre"]');`,
	);
	// ★ 光标接力：起始只显示首字之前那枚；每个字打出的瞬间，把光标切到它后面那枚。
	//   靠 display 接力，不测字宽——字体异步加载时测量必错。
	js.push(`gsap.set(pre_${idx},{display:'inline-block'});`);
	js.push(
		`pm_${idx}.forEach(function(k,r){var t=${pyNum(n(st.start) as number)}+r*${pyNum(n(each) as number)}+${pyNum(n(dur) as number)};` +
			`var prev=r===0?pre_${idx}:${el}.querySelector('.cr[data-c="'+pm_${idx}[r-1]+'"]');` +
			`tl.set(prev,{display:'none'},t);` +
			`tl.set(${el}.querySelector('.cr[data-c="'+k+'"]'),{display:'inline-block'},t);});`,
	);
	// 所有光标同步闪烁（有限次，不用 setInterval——铁律 3 禁运行时定时器），末尾统一退场
	js.push(
		`var cb_${idx}=gsap.timeline({repeat:${Math.max(0, Math.trunc(total / (2 * blink)))}});` +
			`cb_${idx}.to(crs_${idx},{opacity:0,duration:${pyNum(blink)},ease:'none'})` +
			`.to(crs_${idx},{opacity:1,duration:${pyNum(blink)},ease:'none'});`,
	);
	js.push(
		`tl.add(cb_${idx},${pyNum(n(st.start) as number)});` +
			`tl.set(crs_${idx},{display:'none'},${pyNum(n(end + hold) as number)});`,
	);
}

// ── 入口 ──────────────────────────────────────────────────────────────

/** 整数值的浮点 → 整数，深度遍历（对齐正本 `canon_nums`）。 */
function canonNums<T>(o: T): T {
	if (Array.isArray(o)) return o.map(canonNums) as unknown as T;
	if (o && typeof o === "object") {
		const out: Dict = {};
		for (const [k, v] of Object.entries(o as Dict)) out[k] = canonNums(v);
		return out as unknown as T;
	}
	return o;
}

/**
 * IR → 颗粒 HTML 正文（不含首行哈希声明）。
 *
 * 首行声明要算 sha256，而两个消费方的哈希能力不同（CLI 走 `node:crypto` 同步、
 * 客户端走 WebCrypto 异步），所以**哈希不在本函数里做**——由调用方用 `stamp()` 盖。
 */
export function compileIrBody(irInput: Dict): string {
	const ir = canonNums(irInput);
	const cid: string = ir.id;
	const w: number = ir.canvas.w;
	const h: number = ir.canvas.h;
	const duration = Number(ir.canvas.duration);
	const slots: Dict = ir.slots ?? {};
	const layers: Dict[] = ir.layers;

	const need3d =
		layers.some((L) => Object.keys(L.anim ?? {}).some((ch) => ch === "rotX" || ch === "rotY")) ||
		layers.some((L) => ["rotX", "rotY"].includes((L.stagger ?? {}).prop));

	const root = `[data-composition-id="${cid}"]`;
	const css = [
		`${root} .ly{position:absolute;inset:0;pointer-events:none;will-change:transform,opacity}`,
		`${root} .ct{position:absolute;white-space:nowrap}`,
		`${root} .ch{display:inline-block;white-space:pre;transform-origin:50% 100%}`,
		`${root} .ch{position:relative}`,
		`${root} .cr{display:none;position:absolute;top:50%;transform:translateY(-50%)}`,
	];
	// 有没有 inner 层：决定要不要建 `.mv` 元素表
	const needMv = layers.some((L: Dict) => L.animTarget === "inner");
	const body: string[] = [];
	const js: string[] = [];

	layers.forEach((L, i) => {
		const lid: string = L.id;
		const [px, py] = L.pos;
		const [ax, ay] = L.anchor ?? [0.5, 0.5];

		const wrapStyle = [`transform-origin:${pyNum(px)}px ${pyNum(py)}px`];
		if ((L.in ?? 0) > 0) wrapStyle.push("visibility:hidden");
		if ("opacity" in L && isNum(L.opacity)) wrapStyle.push(`opacity:${pyNum(L.opacity)}`);
		if (L.mask) wrapStyle.push(...maskStyles(L.mask, w, h));

		const ctStyle = [
			`left:${pyNum(px)}px`,
			`top:${pyNum(py)}px`,
			`transform:translate(${(-ax * 100).toFixed(1)}%,${(-ay * 100).toFixed(1)}%)`,
		];

		let txt = "";
		let inner: string;
		if (L.type === "text") {
			txt = "slot" in L ? slots[L.slot] : (L.text ?? "");
			// v0.2 repeatText：滚动窗要同词多份做无缝回跳，而槽位仍只有一份——
			// 在**取到槽位值之后**复制，用户改一次字 N 份一起变。
			const rpt = L.repeatText;
			if (typeof rpt === "number" && Number.isInteger(rpt) && rpt > 1) {
				txt = Array(rpt).fill(txt).join("\n");
			}
			ctStyle.push(...textContentStyle(ir, L));
			inner = textInner(ir, L, txt);
		} else {
			inner = shapeInner(ir, L.shape);
		}

		if (L.type === "shape" && (L.shape ?? {}).glow) ctStyle.push(shapeGlow(ir, L));

		// v0.2 animTarget:"inner"：`.ly` 与 `.ct` 之间插一层 `.mv`，anim 打在 `.mv` 上。
		// 蒙版留在 `.ly` 钉死在画布坐标，内容在蒙版后面滚。缺省 layer 分支一个字节不动。
		if (L.animTarget === "inner") {
			body.push(
				`<div class="ly" data-l="${esc(lid)}" style="${wrapStyle.join(";")}">` +
					`<div class="mv" data-m="${esc(lid)}">` +
					`<div class="ct" style="${ctStyle.join(";")}">${inner}</div></div></div>`,
			);
		} else {
			body.push(
				`<div class="ly" data-l="${esc(lid)}" style="${wrapStyle.join(";")}">` +
					`<div class="ct" style="${ctStyle.join(";")}">${inner}</div></div>`,
			);
		}

		const el = L.animTarget === "inner" ? `M[${pyJson(lid)}]` : `L[${pyJson(lid)}]`;
		if ((L.in ?? 0) > 0) js.push(`tl.set(${el},{visibility:'visible'},${pyNum(L.in)});`);
		if ((L.out ?? duration) < duration - EPS) {
			js.push(`tl.set(${el},{visibility:'hidden'},${pyNum(L.out)});`);
		}

		emitAnim(el, L, i, js);
		if (L.type === "text" && L.runs) emitRuns(el, L, js);
		else if (L.type === "text" && L.charRoll) emitCharRoll(el, L, i, txt, js);
		else if (L.type === "text" && L.stagger) emitStagger(el, L, i, txt, js);
		if (L.type === "text" && L.sweep) emitSweep(el, L, js);
	});

	let rootStyle =
		"position:absolute;inset:0;background:transparent;overflow:hidden;" +
		`font-family:'${DEFAULT_FONT}',sans-serif;`;
	if (need3d) rootStyle += "perspective:1200px;";

	const nl = "\n";
	return (
		`<template id="p">${nl}` +
		`<!-- 由 IR 文字子集 v0.1 编译（id=${cid}）。铁律4：根零视觉、透明显式；` +
		`铁律7：总长钉到 canvas.duration 定格驻留 -->${nl}` +
		`<div data-composition-id="${cid}" data-width="${pyNum(w)}" data-height="${pyNum(h)}" ` +
		`style="${rootStyle}">${nl}` +
		`  <style>${css.join(nl)}</style>${nl}` +
		`  ${body.join(nl)}${nl}` +
		`  <script src="${CDN}"></script>${nl}` +
		`  <script>(function(){${nl}` +
		`    var ROOT=document.querySelector('[data-composition-id="${cid}"]');${nl}` +
		`    var L={};ROOT.querySelectorAll('.ly').forEach(` +
		`function(e){L[e.getAttribute('data-l')]=e;});${nl}` +
		// `.mv` 元素表**只在真有 inner 层时才建**：恒建会给每一份产物多两行，
		// 而「默认分支逐字节不变」是硬门（正本同注，那边我第一版正是这么判红的）。
		(needMv
			? `    var M={};ROOT.querySelectorAll('.mv').forEach(` +
				`function(e){M[e.getAttribute('data-m')]=e;});${nl}`
			: "") +
		`    var tl=gsap.timeline({paused:true});${nl}` +
		js.map((s) => `    ${s}`).join(nl) +
		nl +
		// 钉总长：末尾放一条空 tween 到 duration，让定格驻留不被裁掉（铁律 7）
		`    tl.to({v:0},{v:1,duration:0.001},${pyNum(n(duration - 0.001) as number)});${nl}` +
		`    window.__timelines=window.__timelines||{};${nl}` +
		`    window.__timelines[${pyJson(cid)}]=tl;${nl}` +
		`  })();</script>${nl}` +
		// 内嵌 IR 收在两个 <script> **之后**：载体是 <template> 而非 <script>（前者不会让
		// 渲染引擎产静帧），位置在脚本后则不触发 lint 铁律 1b 的「第一个 </template>」朴素切法。
		`  ${irCarrierBlock(ir)}${nl}` +
		`</div>${nl}` +
		`</template>${nl}`
	);
}

/** 首行声明。`body` MUST 已含内嵌 IR 块。 */
export function stamp(body: string, ir: Dict, sha256: (s: string) => string): string {
	const irSha = sha256(canonicalJson(canonNums(ir)));
	return `<!-- gtrk-ir-sha256=${irSha} gtrk-html-sha256=${sha256(body)} -->\n${body}`;
}

/** IR → 完整颗粒 HTML（含首行声明）。`sha256` 由调用方注入。 */
export function compileIr(ir: Dict, sha256: (s: string) => string): string {
	return stamp(compileIrBody(ir), ir, sha256);
}
