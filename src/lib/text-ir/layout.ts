/**
 * 跨画幅布局：九宫锚点 + 单一缩放因子（change: add-text-ir-aspect-agnostic-layout）。
 *
 * **Python 正本是 `utils/process/media/vision/text_ir/layout.py`**，本文件是第二实现。
 * 两份由 `scripts/text-ir-sync.mjs` 同步、由 `scripts/text-ir-parity.mjs` 的逐字节等价闸钉住。
 * 正本里那几段长注释（为什么要这一层 / 像素量清单为什么是全部风险 / 横向锚点是空操作）
 * 不在这里重复，改动 MUST 先改 Python 那份。
 *
 * 只留两条必须在这里说清楚的：
 *
 * ① **IR 恒住在 1920 宽的参考系里**，投影只发生在编译期 ⇒ 同一份 IR 在横屏与竖屏工程里
 *    是同一份 IR（`ir_sha256` 不随画幅漂）。
 * ② **像素量清单漏一项，那一项就不跟着缩**，而且不报任何错、只是难看。
 *    下面四张表逐条对着 `validate.ts` 的键表列，新增像素键 MUST 同批加进来。
 */

export const POS_ANCHORS = [
	"top-left", "top", "top-right",
	"left", "center", "right",
	"bottom-left", "bottom", "bottom-right",
] as const;

export type PosAnchor = (typeof POS_ANCHORS)[number];

/** 缩放基准宽。钉死不写进 IR（主理人 2026-09-15 拍板 2）。 */
export const REF_W = 1920;
/** 参考画幅的高。只在「老的绝对坐标 → 锚点式」的一次性迁移里用到。 */
export const REF_H = 1080;

// biome-ignore lint/suspicious/noExplicitAny: IR 是开放形状的字典，正本也是 dict；
// 用 unknown 会让 compile.ts 那边（它的 Dict 是 any）在每个字段上都要断言一次。
type Dict = Record<string, any>;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

export function anchorXY(at: string, w: number, h: number): [number, number] {
	if (!(POS_ANCHORS as readonly string[]).includes(at)) {
		throw new Error(`未知锚点 ${JSON.stringify(at)}；只收 ${POS_ANCHORS.join("/")}`);
	}
	const i = at.lastIndexOf("-");
	let vy = i < 0 ? "" : at.slice(0, i);
	let vx = i < 0 ? "" : at.slice(i + 1);
	if (!vy) {
		if (at === "top" || at === "bottom") { vy = at; vx = "center"; }
		else { vy = "center"; vx = at; }
	}
	const x = vx === "left" ? 0 : vx === "right" ? w : w / 2;
	const y = vy === "top" ? 0 : vy === "bottom" ? h : h / 2;
	return [x, y];
}

/** 老的绝对坐标 → 九宫锚点（**只在迁移期跑一次，不是运行时行为**）。 */
export function inferAnchor(x: number, y: number, w = REF_W, h = REF_H): PosAnchor {
	const vy = y < h / 3 ? "top" : y > (h * 2) / 3 ? "bottom" : "center";
	const vx = x < w / 3 ? "left" : x > (w * 2) / 3 ? "right" : "center";
	if (vy === "center" && vx === "center") return "center";
	if (vy === "center") return vx as PosAnchor;
	if (vx === "center") return vy as PosAnchor;
	return `${vy}-${vx}` as PosAnchor;
}

/** 整份模板取**一个**锚点（迁移期用），判据 = 全部层 `pos` 的质心。理由见 Python 正本。 */
export function inferIrAnchor(ir: Dict): PosAnchor | null {
	const ys: number[] = [];
	for (const L of (ir.layers as Dict[]) ?? []) {
		const p = L.pos;
		if (Array.isArray(p) && p.length === 2 && isNum(p[1])) ys.push(p[1]);
	}
	if (!ys.length) return null;
	return inferAnchor(REF_W / 2, ys.reduce((a, b) => a + b, 0) / ys.length);
}

export function normalizePos(pos: unknown, at?: PosAnchor | null): unknown {
	if (isDict(pos)) return pos;
	if (Array.isArray(pos) && pos.length === 2 && isNum(pos[0]) && isNum(pos[1])) {
		const [x, y] = pos as [number, number];
		const a = at ?? inferAnchor(x, y);
		const [ax, ay] = anchorXY(a, REF_W, REF_H);
		return { at: a, off: [x - ax, y - ay] };
	}
	return pos;
}

/**
 * 老 IR → 唯一合法形态：`pos` 升级成锚点式、摘掉 `canvas.w/h`。**不改入参。**
 *
 * ⚠️ MUST 跑在校验之前。`compileTextIr` 里 `assertValidIr` 先跑，
 * 老写法一旦被直接判非法，**存量工程的属性面板当场改不了字**。
 */
export function normalizeIr(ir: Dict): Dict {
	const out = JSON.parse(JSON.stringify(ir)) as Dict;
	const at = inferIrAnchor(out);
	for (const L of (out.layers as Dict[]) ?? []) {
		if ("pos" in L) L.pos = normalizePos(L.pos, at);
	}
	const c = out.canvas;
	if (isDict(c)) { delete c.w; delete c.h; }
	return out;
}

// ── 像素量投影 ──────────────────────────────────────────────────────────────
// 只列像素量：比例（opacity/scale/font.lh/mask.feather）、角度（rot/skx）、
// 时间（in/out/sweep.gap）、次数一律不缩。

const LAYER_PX = ["maxWidth"] as const;
const SUB_PX: Record<string, readonly string[]> = {
	font: ["size", "ls"],                                  // lh 是行高倍数，不是像素
	stroke: ["width"],
	shadow: ["dx", "dy", "blur"],
	glow: ["blur"],
	box: ["pad", "radius", "strokeWidth"],                 // pad 可为数或数组
	shape: ["w", "h", "radius", "strokeWidth", "rayLen", "rayWidth", "core"],
};
const PX_CHANNELS = ["x", "y", "ls"] as const;
const MASK_PX: Record<string, readonly string[]> = {
	"feather-band": ["y", "h"],                            // feather 是比例，不缩
	"clip-rect": ["x", "y", "w", "h"],
};

/** 缩一个像素量。数组逐项缩；`k === 1` 时**原值返回**（零回归的保证，见 Python 正本）。 */
function px(v: unknown, k: number): unknown {
	if (k === 1) return v;
	if (v === null || typeof v === "boolean") return v;
	if (Array.isArray(v)) return v.map((x) => px(x, k));
	if (isNum(v)) return v * k;
	return v;
}

function scaleSub(obj: unknown, keys: readonly string[], k: number): void {
	if (!isDict(obj)) return;
	for (const key of keys) if (key in obj) obj[key] = px(obj[key], k);
}

/**
 * 把 1920 参考系的 IR 投影到目标画幅。**纯函数，不改入参。**
 *
 * 返回的 IR 里 `pos` 已解析成绝对像素 `[x, y]`，所有像素量已乘 `k`。
 */
export function project(ir: Dict, canvas: [number, number]): Dict {
	const [w, h] = canvas;
	if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
		// MUST NOT 回落缺省：静默按 1920×1080 编 = 在竖屏工程里悄悄产一颗横屏颗粒，
		// 而挂载是非等比缩放 ⇒ 拉伸变形，两边都不报错。
		throw new Error(`编译画幅须为正整数 (w, h)，收到 ${JSON.stringify(canvas)}`);
	}
	const k = w / REF_W;
	const out = JSON.parse(JSON.stringify(ir)) as Dict;

	for (const L of (out.layers as Dict[]) ?? []) {
		const pos = normalizePos(L.pos);
		if (isDict(pos) && "at" in pos) {
			const [ax, ay] = anchorXY(pos.at as string, w, h);
			const off = (pos.off as number[]) ?? [0, 0];
			L.pos = [ax + (off[0] ?? 0) * k, ay + (off[1] ?? 0) * k];
		}

		scaleSub(L, LAYER_PX, k);
		for (const [sub, keys] of Object.entries(SUB_PX)) scaleSub(L[sub], keys, k);
		scaleSub((L.shape as Dict | undefined)?.glow, ["blur"], k);

		for (const ch of PX_CHANNELS) {
			for (const kf of ((L.anim as Dict | undefined)?.[ch] as Dict[]) ?? []) {
				if (isDict(kf) && "v" in kf) kf.v = px(kf.v, k);
			}
		}

		const st = L.stagger;
		if (isDict(st)) {
			if (PX_CHANNELS.includes(st.prop as never)) scaleSub(st, ["from", "to"], k);
			scaleSub(st.cursor, ["w", "h"], k);
		}

		const mask = L.mask;
		const masks = Array.isArray(mask) ? mask : mask ? [mask] : [];
		for (const m of masks) {
			if (isDict(m)) scaleSub(m, MASK_PX[m.type as string] ?? [], k);
		}
	}

	const sc = (out.canvas as Dict | undefined)?.scrim;
	if (isDict(sc)) scaleSub(sc, ["rect", "radius"], k);

	return out;
}
