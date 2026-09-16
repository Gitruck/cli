/**
 * `text-v0` IR 校验器 —— **Python 正本 `schema.py:validate()` 的第二实现**
 * （change: fix-local-ir-compile-skips-validation）。
 *
 * ## 为什么非要有这一份
 *
 * `gtrk mg compile` 默认走本地编译（`move-text-ir-compiler-to-client` 之后的常态），
 * 而本地这条路**此前零校验**：
 *
 * | 喂进去的 IR | 本地 | 服务端 |
 * |---|---|---|
 * | `transparent: false`（无 `canvas.bg`） | **exit 0，落盘** | `code=6016` 拒 |
 * | `canvas: 1280×720@60fps` | **exit 0，落盘** | 拒 |
 *
 * 于是「本地能编出来」不再蕴含「这份 IR 合法」。2026-09-15 实测：t07 工程里三颗颗粒
 * 带着 `transparent:false` 的内嵌 IR 落进了 `.gtrk`——**就是从这个口子溜进来的**。
 *
 * ## 为什么是「第二实现」而不是「规则表同源」
 *
 * propose 时我写的是「把 `schema.py` 的规则导出成 JSON、两侧共读」。实施时改了主意，
 * 理由是**规则里大半是逻辑不是数据**：`transparent` ↔ `canvas.bg` 的自洽、
 * 「最晚层的 `out` 须等于 `canvas.duration`」、满幅实心块的「首尾透明才算闪白」、
 * `sweep` 与逐单元互斥……这些表达不成表，硬塞进 JSON 只会变成一个畸形的 DSL。
 *
 * 而本仓已经有一条**验证过的**路：`compile.ts` 就是 `compile.py` 的第二实现，
 * 靠**逐字节等价闸**钉住，103 份金样跑了几十轮没漂过。
 *
 * ⇒ **原则不是「不许有两份实现」，是「不许有两份实现而没有会响的闸」。**
 * 本文件因此走同一条路：第二实现 + 闸。闸的射程从「合法面逐字节相同」扩到
 * **「拒绝面同判」**——非法样本两侧都必须拒、且**拒的条数与首条消息一致**
 * （`scripts/text-ir-parity.mjs` 的 ② 段）。
 *
 * ⚠️ 这也正是原来那道闸的缺口：它**只喂合法金样**，两份实现的快乐路径逐字节等价、
 * 拒绝面各走各的 —— **闸是绿的、绿得也对，只是它量的不是这件事。**
 *
 * ## 移植纪律
 *
 * - **消息逐字照抄正本**。拒绝面对拍比的就是消息；改一个字都会让闸红，那是对的。
 * - **检查次序照抄正本**。错误是按序 append 的，次序不同 ⇒ 首条消息不同 ⇒ 闸红。
 * - **常量照抄正本**，MUST NOT 另立。词表变更时两边同批改，闸会当场抓住只改一边。
 * - Python 的 `isinstance(x, int) and not isinstance(x, bool)` 在 TS 里是
 *   `Number.isInteger(x)`（TS 的 boolean 不是 number，天然不混）。
 * - Python 的 `dict` 迭代序 = 插入序；JS 的字符串键同样是插入序 ⇒ `未定义键` 的
 *   报告次序一致。
 */

import { POS_ANCHORS, normalizeIr } from "./layout";

// ── 常量（逐条对应 schema.py）──────────────────────────────────────────────
const COLOR_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const EASE_RE = /^[a-zA-Z0-9.(),]+$/;



export const VERSION = "text-v0";
const CANVAS_W = 1920;
const CANVAS_H = 1080;
const CANVAS_FPS = 30;
const DURATION_MIN = 0.5;
const DURATION_MAX = 60.0;

const ANIM_CHANNELS = [
	"x", "y", "scale", "sx", "sy", "rot", "rotX", "rotY", "opacity", "ls",
	"blur", "skx", "sky",
] as const;
const STAGGER_PROPS: readonly string[] = ANIM_CHANNELS;
const STAGGER_ORDERS = ["forward", "reverse", "center", "scramble"] as const;
const STAGGER_UNITS = ["char", "word", "line"] as const;
const SHAPE_KINDS = ["rect", "ellipse", "line", "star4"] as const;
const MASK_TYPES = ["feather-band", "clip-rect"] as const;
const ALIGNS = ["left", "center", "right"] as const;

const TOP_KEYS = ["v", "id", "title", "family", "canvas", "transparent", "hold",
	"colors", "slots", "layers", "envelope", "note"] as const;
// ⚠️ `w`/`h` 已移出（add-text-ir-aspect-agnostic-layout）：画幅是**编译入参**，不是 IR 字段。
const CANVAS_KEYS = ["fps", "duration", "bg", "scrim"] as const;
/** `scrim` 的子键（add-text-ir-scrim）。`rect` 缺省 = 满屏。 */
const SCRIM_KEYS = ["fill", "rect", "radius"] as const;
const LAYER_KEYS = ["id", "type", "slot", "text", "font", "color", "opacity", "pos", "anchor",
	"in", "out", "anim", "loop", "mask", "stagger", "shape",
	"align", "vertical", "maxWidth", "box", "glow", "stroke", "shadow", "runs",
	"animTarget", "repeatText", "charRoll", "sweep"] as const;
const CHARROLL_KEYS = ["pool", "start", "each", "step", "steps", "dim", "order", "pop"] as const;
const SWEEP_KEYS = ["base", "hi", "start", "dur", "repeat", "gap"] as const;
const ANIM_TARGETS = ["layer", "inner"] as const;
const FONT_KEYS = ["family", "weight", "size", "ls", "lh"] as const;
const STAGGER_KEYS = ["unit", "prop", "from", "to", "each", "dur", "start", "e",
	"order", "repeat", "yoyo", "cursor", "fade"] as const;
const CURSOR_KEYS = ["w", "h", "color", "blink", "hold"] as const;
const BOX_KEYS = ["pad", "fill", "radius", "stroke", "strokeWidth"] as const;
const GLOW_KEYS = ["color", "blur"] as const;
const STROKE_KEYS = ["color", "width"] as const;
const SHADOW_KEYS = ["color", "dx", "dy", "blur"] as const;
const RUN_KEYS = ["t", "c", "pop", "slot"] as const;
const POP_KEYS = ["t", "scale", "dur", "e"] as const;
const SHAPE_KEYS = ["kind", "w", "h", "fill", "stroke", "strokeWidth", "radius",
	"rayLen", "rayWidth", "core", "diag", "glow"] as const;

const SOLID_COVER_RATIO = 0.9;

/** 可读性四选一。透明颗粒叠在任意画面上，裸字在亮底或杂乱底上不可读。 */
const READABILITY_GUARDS = ["stroke", "shadow", "glow", "box"] as const;

type Dict = Record<string, unknown>;

// ── 助手（逐条对应 schema.py 的 `_num` / `_extra_keys` / `_check_color` …）────
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
/** Python 的 `isinstance(x, int) and not isinstance(x, bool)`。 */
const isInt = (v: unknown): v is number => Number.isInteger(v as number);

function extraKeys(obj: Dict, allowed: readonly string[], path: string, E: string[]): void {
	for (const k of Object.keys(obj)) if (!allowed.includes(k)) E.push(`${path} 未定义键 ${k}`);
}

function checkColor(v: unknown, path: string, colors: Dict, E: string[]): void {
	if (typeof v !== "string") {
		E.push(`${path} 须为颜色字符串`);
		return;
	}
	if (v.startsWith("$")) {
		if (!(v.slice(1) in colors)) E.push(`${path} 引用了未定义颜色 ${v}`);
	} else if (!COLOR_RE.test(v)) {
		E.push(`${path} 须为 #RRGGBB / #RRGGBBAA 或 $name`);
	}
}

function checkEase(v: unknown, path: string, E: string[]): void {
	if (v === undefined || v === null) return;
	if (typeof v !== "string" || !EASE_RE.test(v)) E.push(`${path} 缓动名非法`);
}

function checkSub(obj: unknown, allowed: readonly string[], path: string, E: string[]): Dict {
	if (!isDict(obj)) {
		E.push(`${path} 非对象`);
		return {};
	}
	extraKeys(obj, allowed, path, E);
	return obj;
}

/** Python 的 `f"{x!r}"` 对字符串：单引号包裹。拒绝面对拍要逐字相同，故显式复刻。 */
const pyRepr = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * 校验 IR；返回错误消息数组（空 = 通过）。**消息与次序逐条对齐 Python 正本**。
 */
export function validateIr(irInput: unknown): string[] {
	const E: string[] = [];
	if (!isDict(irInput)) return ["顶层不是对象"];
	// ⚠️ **先归一化再校验**：老 IR 的 pos:[x,y] 与 canvas.w/h 在这里一次性升级掉再判。
	// 次序反了就是「存量工程打开就废」——compileTextIr 里 assertValidIr 先跑，
	// 老写法直接判非法，用户的属性面板当场改不了字。归一化在副本上做，不改入参。
	const ir = normalizeIr(irInput) as Dict;
	extraKeys(ir, TOP_KEYS, "顶层", E);
	for (const k of ["v", "id", "canvas", "transparent", "hold", "layers"]) {
		if (!(k in ir)) E.push(`缺必填 ${k}`);
	}
	if (E.length) return E;

	if (ir.v !== VERSION) E.push(`v 必须为 ${VERSION}`);
	if (typeof ir.id !== "string" || !ir.id) E.push("id 须非空字符串");
	for (const k of ["title", "family", "note"]) {
		if (k in ir && typeof ir[k] !== "string") E.push(`${k} 须为字符串`);
	}

	const c = checkSub(ir.canvas, CANVAS_KEYS, "canvas", E);
	// 画幅已不在 IR 里；老 IR 的 w/h 由 normalizeIr 在校验前摘掉（不报错，那是升级不是违规）。
	if (c.fps !== CANVAS_FPS) E.push(`fps 必须 ${CANVAS_FPS}`);
	let dur: number | null = null;
	if (!isNum(c.duration) || !(DURATION_MIN <= c.duration && c.duration <= DURATION_MAX)) {
		// ⚠️ Python 的 f-string 把 60.0 渲染成 "60.0"；JS 的 60 渲染成 "60"。
		//    拒绝面逐字对拍，故这里显式写死正本的字面。
		E.push("duration 须为 0.5–60.0 的数");
	} else {
		dur = c.duration;
	}

	if (ir.hold !== true) E.push("hold 必须 true");

	let colors: Dict = isDict(ir.colors) ? ir.colors : {};
	const colorsBad =
		("colors" in ir && ir.colors !== null && ir.colors !== undefined && !isDict(ir.colors)) ||
		Object.entries(colors).some(([k, v]) => typeof k !== "string" || typeof v !== "string" || !COLOR_RE.test(v));
	if (colorsBad) {
		E.push("colors 须为 name→#RRGGBB 对象");
		colors = {};
	}

	// transparent 与 canvas.bg 必须自洽（add-text-ir-canvas-bg）。放在 colors 之后：
	// bg 允许 `$name` 引用，判它要先知道 colors 有哪些名字。
	const bg = c.bg;
	if (bg !== undefined && bg !== null) {
		checkColor(bg, "canvas.bg", colors, E);
		if (ir.transparent !== false) E.push("canvas.bg 在场时 transparent 必须 false（满幅实心底不是透明叠加）");
	} else if (ir.transparent !== true) {
		E.push("transparent 必须 true（要满幅实心底请写 canvas.bg）");
	}

	// canvas.scrim：可调透明度的压板（add-text-ir-scrim）。与 bg 分键而不是放宽 bg——
	// bg 的 `transparent:false` 是下游判据（deriveOpaque / 满屏槽位闸拿它认「能不能当实心底」），
	// 让它再收 alpha 等于让「实心底」同时指两种东西，闸就没意义了。
	if (c.scrim !== undefined && c.scrim !== null) {
		const s = checkSub(c.scrim, SCRIM_KEYS, "canvas.scrim", E);
		if (bg !== undefined && bg !== null) {
			E.push("canvas.scrim 与 canvas.bg 互斥（要满幅实心底用 bg，要压暗用 scrim）");
		}
		if (ir.transparent !== true) {
			E.push(
				"canvas.scrim 在场时 transparent 仍须 true —— 压板是半透明的，" +
					"颗粒依然是透明叠加；把它写成 false 会让满屏槽位的闸放行一块压板",
			);
		}
		const fill = s.fill;
		if (fill === undefined || fill === null) {
			E.push("canvas.scrim.fill 必填");
		} else {
			checkColor(fill, "canvas.scrim.fill", colors, E);
			const lit = typeof fill === "string" && fill.startsWith("$") ? colors[fill.slice(1)] : fill;
			// ⚠️ alpha 就是 scrim 存在的理由，不带 alpha 的一律拒并指路。
			if (typeof lit === "string" && lit.length === 7) {
				E.push(
					"canvas.scrim.fill 须带 alpha（#RRGGBBAA）——" +
						"要满幅实心底用 canvas.bg，要局部实心衬板用 shape 层或层的 box",
				);
			} else if (typeof lit === "string" && lit.length === 9 && lit.slice(7).toLowerCase() === "ff") {
				E.push(
					"canvas.scrim.fill 的 alpha 是 FF（全不透明），那不是压板：" +
						"满屏用 canvas.bg，局部用 shape 层或层的 box",
				);
			}
		}
		const rect = s.rect;
		if (rect !== undefined && rect !== null) {
			if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((x) => isNum(x))) {
				E.push("canvas.scrim.rect 须为 [x, y, w, h] 四个数");
			} else if ((rect[2] as number) <= 0 || (rect[3] as number) <= 0) {
				E.push("canvas.scrim.rect 的 w/h 须为正数");
			}
		}
		const radius = s.radius;
		if (radius !== undefined && radius !== null && (!isNum(radius) || (radius as number) < 0)) {
			E.push("canvas.scrim.radius 须为非负数");
		}
	}

	let slots: Dict = isDict(ir.slots) ? ir.slots : {};
	const slotsBad =
		("slots" in ir && ir.slots !== null && ir.slots !== undefined && !isDict(ir.slots)) ||
		Object.entries(slots).some(([k, v]) => typeof k !== "string" || typeof v !== "string");
	if (slotsBad) {
		E.push("slots 须为 string→string 对象");
		slots = {};
	}

	if (ir.envelope !== undefined && ir.envelope !== null) {
		const env = checkSub(ir.envelope, ["editable", "ranges"], "envelope", E);
		if ("editable" in env && !Array.isArray(env.editable)) E.push("envelope.editable 须为数组");
		if ("ranges" in env && !isDict(env.ranges)) E.push("envelope.ranges 须为对象");
	}

	const layers = ir.layers;
	if (!Array.isArray(layers) || !layers.length) {
		E.push("layers 须为非空数组");
		return E;
	}

	const ids = new Set<string>();
	let maxOut: number | null = null;
	layers.forEach((L: unknown, i: number) => {
		const p = `layers[${i}]`;
		if (!isDict(L)) {
			E.push(`${p} 非对象`);
			return;
		}
		extraKeys(L, LAYER_KEYS, p, E);
		for (const k of ["id", "type", "pos", "in", "out"]) {
			if (!(k in L)) E.push(`${p} 缺必填 ${k}`);
		}

		const lid = L.id;
		if (typeof lid === "string") {
			if (ids.has(lid)) E.push(`${p} id 重复 ${lid}`);
			ids.add(lid);
		} else {
			E.push(`${p}.id 须为字符串`);
		}

		const t = L.type;
		if (t !== "text" && t !== "shape") E.push(`${p}.type 须为 text|shape`);

		validateGeometry(L, p, dur, E);
		if (isNum(L.out)) maxOut = maxOut === null ? L.out : Math.max(maxOut, L.out);

		if (t === "text") validateTextLayer(L, p, slots, colors, E);
		else if (t === "shape") validateShapeLayer(L, p, colors, E);

		if ("color" in L) checkColor(L.color, `${p}.color`, colors, E);
		if ("opacity" in L && !(isNum(L.opacity) && 0 <= L.opacity && L.opacity <= 1)) {
			E.push(`${p}.opacity 须 0–1`);
		}

		validateAnim(L, p, E);
		validateLoop(L, p, E);
		validateMask(L, p, E);
		validateStagger(L, p, typeof t === "string" ? t : "", colors, E);
	});

	// 定格驻留不变量：最晚的层必须活到 duration，否则末尾会出现空帧。
	if (dur !== null && maxOut !== null && Math.abs((maxOut as number) - dur) > 1e-6) {
		E.push(`最晚层的 out=${numRepr(maxOut)} 须等于 canvas.duration=${numRepr(dur)}（定格驻留）`);
	}
	return E;
}

/**
 * Python 把 `2.0` 渲染成 `"2.0"`、把 `2` 渲染成 `"2"`；JS 两者都是 `"2"`。
 * 只有这一处消息把数值插进去，故就地补齐——拒绝面逐字对拍，差一个 `.0` 也会红。
 */
function numRepr(v: number): string {
	return Number.isInteger(v) ? `${v}.0` : String(v);
}

function validateGeometry(L: Dict, p: string, dur: number | null, E: string[]): void {
	// `pos` 是**锚点式**：老的 [x,y] 由 normalizeIr 在校验之前一次性升级掉，
	// 走到这里时只该有一种形态。词表里只有锚点式一种**合法**写法。
	const pos = L.pos;
	if (!isDict(pos)) {
		E.push(`${p}.pos 须为 {at, off}（九宫锚点 + 偏移）；老的 [x,y] 由解析器升级，别手写`);
	} else {
		for (const k of Object.keys(pos)) {
			if (k !== "at" && k !== "off") E.push(`${p}.pos 未定义键 ${k}`);
		}
		if (!(POS_ANCHORS as readonly string[]).includes(pos.at as string)) {
			E.push(`${p}.pos.at 须为九宫之一：${POS_ANCHORS.join("/")}`);
		}
		const off = pos.off;
		if (!(Array.isArray(off) && off.length === 2 && off.every(isNum))) {
			E.push(`${p}.pos.off 须 [数,数]`);
		}
	}
	if ("anchor" in L && !(Array.isArray(L.anchor) && (L.anchor as unknown[]).length === 2 && (L.anchor as unknown[]).every(isNum))) {
		E.push(`${p}.anchor 须 [数,数]`);
	}
	const i = L.in;
	const o = L.out;
	if (!isNum(i) || !isNum(o)) {
		if ("in" in L || "out" in L) E.push(`${p}.in/out 须为数`);
		return;
	}
	if (i < 0 || o < i) E.push(`${p} in/out 须 0 ≤ in ≤ out`);
	if (dur !== null && o > dur + 1e-6) E.push(`${p}.out 超过 canvas.duration`);
}

function validateTextLayer(L: Dict, p: string, slots: Dict, colors: Dict, E: string[]): void {
	// 可读性保障：四样一个都没有就拒。这条不是洁癖——2026-09-15 主理人第一次拿模板库
	// 做真项目就撞上：实扫 245 个文字层里有描边的 3 个、有阴影的 0 个。
	if (!READABILITY_GUARDS.some((k) => L[k])) {
		E.push(
			`${p} 文字层至少要有 ${READABILITY_GUARDS.join(" / ")} 之一` +
				"（透明颗粒叠在任意画面上，裸字在亮底或杂乱底上不可读）",
		);
	}

	if ("slot" in L) {
		if (!(typeof L.slot === "string" && L.slot in slots)) {
			E.push(`${p}.slot ${pyRepr(String(L.slot))} 不在 slots 里`);
		}
	} else if (typeof L.text !== "string" && !("runs" in L)) {
		E.push(`${p} text 层须给 slot、text 或 runs`);
	}

	if ("font" in L) {
		const f = checkSub(L.font, FONT_KEYS, `${p}.font`, E);
		if ("weight" in f && !(isInt(f.weight) && 100 <= (f.weight as number) && (f.weight as number) <= 900)) {
			E.push(`${p}.font.weight 须 100–900 整数`);
		}
		if ("size" in f && !(isNum(f.size) && 8 <= f.size && f.size <= 600)) E.push(`${p}.font.size 须 8–600`);
		if ("family" in f && typeof f.family !== "string") E.push(`${p}.font.family 须字符串`);
		for (const k of ["ls", "lh"]) if (k in f && !isNum(f[k])) E.push(`${p}.font.${k} 须为数`);
	}

	if ("align" in L && !ALIGNS.includes(L.align as never)) E.push(`${p}.align 须为 ${ALIGNS.join("|")}`);
	if ("vertical" in L && typeof L.vertical !== "boolean") E.push(`${p}.vertical 须为布尔`);
	if ("maxWidth" in L && !(isNum(L.maxWidth) && L.maxWidth > 0)) E.push(`${p}.maxWidth 须为正数`);

	if ("box" in L) {
		const b = checkSub(L.box, BOX_KEYS, `${p}.box`, E);
		if ("pad" in b && !(Array.isArray(b.pad) && (b.pad as unknown[]).length === 2 && (b.pad as unknown[]).every(isNum))) {
			E.push(`${p}.box.pad 须 [x,y]`);
		}
		for (const k of ["fill", "stroke"]) if (k in b) checkColor(b[k], `${p}.box.${k}`, colors, E);
		for (const k of ["radius", "strokeWidth"]) if (k in b && !isNum(b[k])) E.push(`${p}.box.${k} 须为数`);
	}

	if ("glow" in L) {
		const g = checkSub(L.glow, GLOW_KEYS, `${p}.glow`, E);
		if ("color" in g) checkColor(g.color, `${p}.glow.color`, colors, E);
		if ("blur" in g && !isNum(g.blur)) E.push(`${p}.glow.blur 须为数`);
	}

	if ("stroke" in L) {
		const s = checkSub(L.stroke, STROKE_KEYS, `${p}.stroke`, E);
		if ("color" in s) checkColor(s.color, `${p}.stroke.color`, colors, E);
		if ("width" in s && !(isNum(s.width) && s.width >= 0)) E.push(`${p}.stroke.width 须 ≥0`);
	}

	if ("shadow" in L) {
		const s = checkSub(L.shadow, SHADOW_KEYS, `${p}.shadow`, E);
		if ("color" in s) checkColor(s.color, `${p}.shadow.color`, colors, E);
		for (const k of ["dx", "dy", "blur"]) if (k in s && !isNum(s[k])) E.push(`${p}.shadow.${k} 须为数`);
	}

	if ("animTarget" in L && !ANIM_TARGETS.includes(L.animTarget as never)) {
		E.push(`${p}.animTarget 须为 ${ANIM_TARGETS.join("|")}`);
	}

	if ("repeatText" in L && !(isInt(L.repeatText) && (L.repeatText as number) >= 1)) {
		E.push(`${p}.repeatText 须为 ≥1 的整数`);
	}

	if ("charRoll" in L) {
		const cr = checkSub(L.charRoll, CHARROLL_KEYS, `${p}.charRoll`, E);
		for (const k of ["start", "each", "step"]) if (k in cr && !isNum(cr[k])) E.push(`${p}.charRoll.${k} 须为数`);
		if ("steps" in cr && !(isInt(cr.steps) && (cr.steps as number) >= 1)) E.push(`${p}.charRoll.steps 须为 ≥1 的整数`);
		if ("pool" in cr && !(typeof cr.pool === "string" && cr.pool)) E.push(`${p}.charRoll.pool 须为非空字符串`);
		if ("order" in cr && !STAGGER_ORDERS.includes(cr.order as never)) {
			E.push(`${p}.charRoll.order 须为 ${STAGGER_ORDERS.join("|")}`);
		}
	}

	if ("sweep" in L) {
		const sw = checkSub(L.sweep, SWEEP_KEYS, `${p}.sweep`, E);
		for (const k of ["base", "hi"]) if (k in sw) checkColor(sw[k], `${p}.sweep.${k}`, colors, E);
		for (const k of ["start", "dur", "gap"]) if (k in sw && !isNum(sw[k])) E.push(`${p}.sweep.${k} 须为数`);
		if ("repeat" in sw && !isInt(sw.repeat)) E.push(`${p}.sweep.repeat 须为整数`);
		// 硬闸：扫光与逐字/逐片段互斥。逐单元会把文本拆成带 transform 的子元素、各自建栈
		// 上下文，`background-clip:text` 不再把它们的字形算进裁切区 ⇒ 字被掏空、整层不可见。
		for (const other of ["stagger", "runs", "charRoll"]) {
			if (other in L) E.push(`${p} sweep 与 ${other} 互斥（逐单元会让 background-clip:text 掏空字形）`);
		}
	}

	if ("runs" in L) {
		const runs = L.runs;
		if (!Array.isArray(runs) || !runs.length) {
			E.push(`${p}.runs 须为非空数组`);
		} else {
			if ("stagger" in L) E.push(`${p} runs 与 stagger 互斥（富文本片段不逐字）`);
			runs.forEach((r0: unknown, j: number) => {
				const q = `${p}.runs[${j}]`;
				const r = checkSub(r0, RUN_KEYS, q, E);
				const hasT = typeof r.t === "string";
				const hasSlot = typeof r.slot === "string";
				if (hasT && hasSlot) E.push(`${q} t 与 slot 互斥（片段文字只能来自一处）`);
				else if (hasSlot) {
					if (!((r.slot as string) in slots)) E.push(`${q}.slot ${pyRepr(r.slot as string)} 不在 slots 里`);
				} else if (!hasT) E.push(`${q} 须给 t 或 slot`);
				if ("c" in r) checkColor(r.c, `${q}.c`, colors, E);
				if ("pop" in r) {
					const pop = checkSub(r.pop, POP_KEYS, `${q}.pop`, E);
					if (!isNum(pop.t)) E.push(`${q}.pop.t 须为数`);
					for (const k of ["scale", "dur"]) if (k in pop && !isNum(pop[k])) E.push(`${q}.pop.${k} 须为数`);
					checkEase(pop.e, `${q}.pop.e`, E);
				}
			});
		}
	}
}

function validateShapeLayer(L: Dict, p: string, colors: Dict, E: string[]): void {
	const s = L.shape;
	if (!isDict(s)) {
		E.push(`${p}.shape 须为对象`);
		return;
	}
	extraKeys(s, SHAPE_KEYS, `${p}.shape`, E);
	const kind = s.kind === undefined ? "rect" : s.kind;
	if (!SHAPE_KINDS.includes(kind as never)) E.push(`${p}.shape.kind 须为 ${SHAPE_KINDS.join("|")}`);
	if (kind === "star4") {
		for (const k of ["rayLen", "rayWidth", "core", "diag"]) {
			if (k in s && !isNum(s[k])) E.push(`${p}.shape.${k} 须为数`);
		}
	} else if (!isNum(s.w) || !isNum(s.h)) {
		E.push(`${p}.shape 须给 w/h`);
	} else if (s.w * s.h >= SOLID_COVER_RATIO * CANVAS_W * CANVAS_H && s.fill) {
		// 满幅实心块唯一的合法用法是「闪一下」：opacity 由动画驱动且首尾都为 0。
		if (!isFlash(L)) {
			E.push(
				`${p} shape 覆盖 ≥${Math.trunc(SOLID_COVER_RATIO * 100)}% 画布且常驻，` +
					"违反透明叠加不变量（满幅实心块只许做首尾透明的瞬时闪白）",
			);
		}
	}
	for (const k of ["fill", "stroke"]) if (k in s) checkColor(s[k], `${p}.shape.${k}`, colors, E);
	for (const k of ["strokeWidth", "radius"]) if (k in s && !isNum(s[k])) E.push(`${p}.shape.${k} 须为数`);
	if ("stagger" in L) E.push(`${p} stagger 只允许 text 层`);
}

/** 满幅实心块是否为「瞬时闪白」：有 opacity 动画且首尾关键帧都是全透明。 */
function isFlash(L: Dict): boolean {
	const anim = isDict(L.anim) ? L.anim : {};
	const kfs = anim.opacity;
	if (!Array.isArray(kfs) || kfs.length < 2) return false;
	const head = isDict(kfs[0]) ? kfs[0].v : undefined;
	const tail = isDict(kfs[kfs.length - 1]) ? (kfs[kfs.length - 1] as Dict).v : undefined;
	return isNum(head) && isNum(tail) && head === 0 && tail === 0;
}

function validateAnim(L: Dict, p: string, E: string[]): void {
	const a = L.anim;
	if (a === undefined || a === null) return;
	if (!isDict(a)) {
		E.push(`${p}.anim 非对象`);
		return;
	}
	const i = L.in;
	const o = L.out;
	for (const [ch, kfs] of Object.entries(a)) {
		if (!ANIM_CHANNELS.includes(ch as never)) {
			E.push(`${p}.anim 未定义通道 ${ch}`);
			continue;
		}
		// 单关键帧 = 静态置位（金样 tfx-bubble-speech 用 rot 单帧把气泡尾巴摆正），合法
		if (!Array.isArray(kfs) || !kfs.length) {
			E.push(`${p}.anim.${ch} 须为非空数组`);
			continue;
		}
		let last: number | null = null;
		kfs.forEach((kf0: unknown, j: number) => {
			const q = `${p}.anim.${ch}[${j}]`;
			const kf = checkSub(kf0, ["t", "v", "e"], q, E);
			if (!isNum(kf.t) || !isNum(kf.v)) {
				E.push(`${q} t/v 须为数`);
				return;
			}
			checkEase(kf.e, `${q}.e`, E);
			if (last !== null && kf.t <= last) E.push(`${q} t 须严格递增`);
			last = kf.t;
			if (isNum(i) && isNum(o) && !(i - 1e-6 <= kf.t && kf.t <= o + 1e-6)) E.push(`${q} t 越出层的 in/out`);
			if (ch === "opacity" && !(0 <= kf.v && kf.v <= 1)) E.push(`${q} opacity v 须 0–1`);
		});
	}
}

function validateLoop(L: Dict, p: string, E: string[]): void {
	if (L.loop === undefined || L.loop === null) return;
	const lp = checkSub(L.loop, ["from", "to", "count"], `${p}.loop`, E);
	if (!isNum(lp.from) || !isNum(lp.to)) {
		E.push(`${p}.loop.from/to 须为数`);
		return;
	}
	if (lp.from >= lp.to) E.push(`${p}.loop 须 from < to`);
	if (!(isInt(lp.count) && (lp.count as number) >= 1)) E.push(`${p}.loop.count 须为 ≥1 的整数`);
}

/** v0.2：`mask` 可为**数组**（多条并存）。单个对象的老写法保持兼容。 */
function validateMask(L: Dict, p: string, E: string[]): void {
	const m = L.mask;
	if (m === undefined || m === null) return;
	if (Array.isArray(m)) {
		if (!m.length) {
			E.push(`${p}.mask 数组不得为空`);
			return;
		}
		m.forEach((one, i) => validateOneMask(one, `${p}.mask[${i}]`, E));
		return;
	}
	validateOneMask(m, p, E);
}

function validateOneMask(m: unknown, p: string, E: string[]): void {
	if (!isDict(m)) {
		E.push(`${p} 非对象`);
		return;
	}
	if (m.type === "feather-band") {
		extraKeys(m, ["type", "y", "h", "feather"], p, E);
		const f = m.feather;
		// v0.2：`feather` 可为 [上端, 下端]（不等量羽化）。**单值语义不变**。
		const fs = Array.isArray(f) ? f : [f];
		if (!["y", "h"].every((k) => isNum(m[k])) || !fs.length || !fs.every(isNum)) {
			E.push(`${p} feather-band 须 y/h/feather 皆为数`);
		} else if (Array.isArray(f) && fs.length !== 2) {
			E.push(`${p}.feather 数组须恰为两元（上端、下端）`);
		} else if (!fs.every((x) => 0 <= (x as number) && (x as number) <= 0.5)) {
			E.push(`${p}.feather 须 0–0.5`);
		}
	} else if (m.type === "clip-rect") {
		extraKeys(m, ["type", "x", "y", "w", "h"], p, E);
		if (!["x", "y", "w", "h"].every((k) => isNum(m[k]))) E.push(`${p} clip-rect 须 x/y/w/h 皆为数`);
	} else {
		E.push(`${p}.mask.type 须为 ${MASK_TYPES.join("|")}`);
	}
}

function validateStagger(L: Dict, p: string, layerType: string, colors: Dict, E: string[]): void {
	const st0 = L.stagger;
	if (st0 === undefined || st0 === null) return;
	if (layerType !== "text") {
		// shape 分支已在 validateShapeLayer 报过一次；这里只兜 type 非法的情形
		if (layerType !== "shape") E.push(`${p} stagger 只允许 text 层`);
		return;
	}
	const st = checkSub(st0, STAGGER_KEYS, `${p}.stagger`, E);
	if (!STAGGER_UNITS.includes(st.unit as never)) E.push(`${p}.stagger.unit 须为 ${STAGGER_UNITS.join("|")}`);
	if (!STAGGER_PROPS.includes(st.prop as string)) E.push(`${p}.stagger.prop 须为 anim 通道之一`);
	for (const k of ["from", "to", "each", "start"]) if (!isNum(st[k])) E.push(`${p}.stagger.${k} 须为数`);
	if ("dur" in st && !isNum(st.dur)) E.push(`${p}.stagger.dur 须为数`);
	if (isNum(st.each) && st.each < 0) E.push(`${p}.stagger.each 须 ≥0`);
	checkEase(st.e, `${p}.stagger.e`, E);
	if ("order" in st && !STAGGER_ORDERS.includes(st.order as never)) {
		E.push(`${p}.stagger.order 须为 ${STAGGER_ORDERS.join("|")}`);
	}
	if ("repeat" in st && !(isInt(st.repeat) && (st.repeat as number) >= 0)) {
		E.push(`${p}.stagger.repeat 须为 ≥0 的整数`);
	}
	for (const k of ["yoyo", "fade"]) if (k in st && typeof st[k] !== "boolean") E.push(`${p}.stagger.${k} 须为布尔`);
	if ("cursor" in st) {
		const cur = checkSub(st.cursor, CURSOR_KEYS, `${p}.stagger.cursor`, E);
		if ("color" in cur) checkColor(cur.color, `${p}.stagger.cursor.color`, colors, E);
		for (const k of ["w", "h", "blink", "hold"]) if (k in cur && !isNum(cur[k])) E.push(`${p}.stagger.${k} 须为数`);
	}
}

/** 校验失败时抛的异常：消息指名到路径，MUST NOT 只说「IR 非法」。 */
export class TextIrValidationError extends Error {
	readonly errors: string[];
	constructor(errors: string[]) {
		super(`IR 校验未通过（${errors.length} 条）：\n  - ${errors.join("\n  - ")}`);
		this.name = "TextIrValidationError";
		this.errors = errors;
	}
}

/** 校验并在失败时抛。编译入口用它——**本地编出来 ≠ 这份 IR 合法**，此前正是这样。 */
export function assertValidIr(ir: unknown): void {
	const errors = validateIr(ir);
	if (errors.length) throw new TextIrValidationError(errors);
}
