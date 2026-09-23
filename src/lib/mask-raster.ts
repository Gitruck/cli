/**
 * 叠加层几何与形状蒙版光栅（link-clip-mask-contract-render）。
 *
 * 契约正本：gitruck-infra `gtrk-contract`「video clip 圆角 border_radius」「video clip 形状蒙版 clip_mask」
 * + 既有 `clip_transform`（`docs/composition-contract-v1.md` §3 / §3.4）。本模块是**纯函数**：
 * 把 clip 上的三字段换成 ffmpeg 叠加链需要的数——元素显示尺寸 / 落点 / 翻转 / 旋转 / 透明度，
 * 以及一张 8-bit 灰度蒙版 PNG（五形状 + 圆角 + 反相 + 旋转 + 羽化 sigma）。不碰磁盘、不起子进程；
 * 落盘与缓存在 `render.ts` 的编排层。
 *
 * 为什么光栅在 JS、滤波在 ffmpeg（proposal 设计要点 D1）：五形状 + 旋转 + 反相 + 圆角都是闭合区域的
 * 覆盖率问题，扫描线 + 超采样即可，**不引入 canvas / sharp / resvg 等原生依赖**（`ffmpeg-runtime` 只保证
 * ffmpeg 在位，多一个原生依赖就多一条安装故障面）；羽化用 ffmpeg `gblur` 做高斯近似，与客户端距离场羽化
 * 只求观感等价（spec 明文）。同参数同尺寸 ⇒ 同字节（确定性，供内容寻址缓存与字节级金样）。
 *
 * 坐标口径（契约 §3.4，2026-09-11 订正为中心原点）：`center_x/y` 元素归一化、中心原点（0=元素中心、
 * ±0.5=元素边界、+x 右 / +y 下）；`width/height` 元素归一化；`rotation` deg 顺时针绕蒙版中心；
 * `corner_radius` 0..1 = 半径占蒙版短边一半的比例（仅 rectangle）；`feather` 0..100 = 羽化带宽占蒙版短边百分比；
 * `border_radius` 画布像素、作用于元素显示矩形（缩放后、旋转前）四角。
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { r3 } from "./frame-domain";
import { PNG_SIGNATURE, pngChunk } from "./solid-png";

/** 契约 `clip_transform`（神经中立单位：画布像素中心原点 / 比例（负=翻转）/ deg 顺时针 / 0..1）。 */
export interface ClipTransform {
	position_x?: unknown;
	position_y?: unknown;
	scale_x?: unknown;
	scale_y?: unknown;
	rotation?: unknown;
	alpha?: unknown;
}

/** 契约 `clip_mask`（封闭对象；形状封闭枚举 v1）。 */
export interface ClipMask {
	shape?: unknown;
	center_x?: unknown;
	center_y?: unknown;
	width?: unknown;
	height?: unknown;
	rotation?: unknown;
	corner_radius?: unknown;
	feather?: unknown;
	invert?: unknown;
}

/** 契约形状封闭枚举 v1（与 infra `gtrk_clip_mask_validate.MASK_SHAPES` 一字不差；扩员走 change）。 */
export const MASK_SHAPES = ["rectangle", "ellipse", "heart", "diamond", "star"] as const;
export type MaskShape = (typeof MASK_SHAPES)[number];

/** 蒙版缓存目录（相对 `.gtrk` 所在目录），与颗粒缓存 `.tonghe-cache/particles` 同规约。 */
export const MASK_CACHE_DIR = ".tonghe-cache/masks";

/** 光栅规格（内容寻址键的全部输入；字段顺序即序列化顺序，MUST 稳定）。 */
export interface MaskRasterSpec {
	/** 规格版本位——光栅算法一旦改动（边数 / 超采样 / 心形曲线），bump 它令旧缓存失效。 */
	v: 1;
	/** 元素显示尺寸（画布像素，整数）。 */
	dw: number;
	dh: number;
	/** 元素圆角半径（画布像素，已钳 ≤ 短边一半；0 = 无）。 */
	borderRadius: number;
	/** 形状窗；无则 null（仅圆角）。 */
	mask: {
		shape: MaskShape;
		cx: number;
		cy: number;
		w: number;
		h: number;
		rotation: number;
		cornerRadius: number;
		invert: boolean;
	} | null;
}

/** 一个叠加 clip 的几何结论（喂给 ffmpeg 叠加链）。`null` = identity（走既有满幅链，零回归门）。 */
export interface OverlayGeometry {
	/** 元素显示尺寸（画布像素，≥1 整数）：contain-fit × |scale|。 */
	dw: number;
	dh: number;
	/** 落点偏移（画布像素，中心原点，+y 下）。 */
	px: number;
	py: number;
	/** deg 顺时针；0 = 不旋转。 */
	rotation: number;
	/** 0..1；1 = 不透明。 */
	alpha: number;
	flipH: boolean;
	flipV: boolean;
	/** `clip_transform` 是否非 identity（计入 `overlay.transformed`）。 */
	transformed: boolean;
	/** 需要蒙版纹理时的规格与内容寻址键；无圆角无形状窗则 null。 */
	spec: MaskRasterSpec | null;
	key: string | null;
	/** ffmpeg `gblur` 的 sigma（像素）；0 = 不羽化。 */
	sigma: number;
}

const num = (v: unknown, fallback: number): number =>
	typeof v === "number" && Number.isFinite(v) ? v : fallback;

// `r3`（三位小数投影）取自 `frame-domain.ts`——仓内 `Math.round(x × 1000)` 只允许住在那一处（守卫测试钉死），
// 本模块 MUST NOT 内联第二份（键与几何的尾差口径要与写方 / 客户端同源）。

/** 契约 `clip_transform` 是否 identity（缺席 / 全默认）。 */
export function isIdentityTransform(ct: ClipTransform | undefined): boolean {
	if (!ct) return true;
	return (
		num(ct.position_x, 0) === 0 &&
		num(ct.position_y, 0) === 0 &&
		num(ct.scale_x, 1) === 1 &&
		num(ct.scale_y, 1) === 1 &&
		num(ct.rotation, 0) === 0 &&
		num(ct.alpha, 1) === 1
	);
}

/** `clip_mask` 是否可消费：对象、形状在枚举内。不在枚举 ⇒ 视为无蒙版（消费侧忽略；API 侧本就拒）。 */
export function usableMask(cm: ClipMask | undefined): cm is ClipMask & { shape: MaskShape } {
	return !!cm && typeof cm === "object" && (MASK_SHAPES as readonly unknown[]).includes(cm.shape);
}

/**
 * 元素显示尺寸单点（design D2：几何段与遮罩段 MUST 共用，两处各算会出「蒙版比元素大一像素」的接缝）。
 * contain-fit 到画布后再乘 |scale|（与客户端「先 contain 再乘 scale」、剪映 `scale=1.0` 即 contain-fit 同口径）。
 * 素材尺寸未知时按画布尺寸（fit = 1）——与既有满幅链对齐的保守缺省。
 */
export function displaySize(
	canvas: [number, number],
	materialSize: [number, number] | undefined,
	transform: ClipTransform | undefined,
): { dw: number; dh: number } {
	const [W, H] = canvas;
	const mw = materialSize && materialSize[0] > 0 ? materialSize[0] : W;
	const mh = materialSize && materialSize[1] > 0 ? materialSize[1] : H;
	const fit = Math.min(W / mw, H / mh);
	const sx = Math.abs(num(transform?.scale_x, 1)) || 1;
	const sy = Math.abs(num(transform?.scale_y, 1)) || 1;
	return {
		dw: Math.max(1, Math.round(mw * fit * sx)),
		dh: Math.max(1, Math.round(mh * fit * sy)),
	};
}

/** 契约 `feather`（0..100，占蒙版短边百分比）→ 高斯 sigma（像素）：`feather/100 × 短边 / 2`。 */
export function featherSigmaPx(feather: number, maskW: number, maskH: number): number {
	const f = Math.min(100, Math.max(0, num(feather, 0)));
	if (f <= 0) return 0;
	return r3((f / 100) * Math.min(maskW, maskH) / 2);
}

/**
 * 叠加 clip 的几何结论。`null` = 三字段全缺省（identity 变换、无圆角、无可消费蒙版）——调用方 MUST 走既有满幅链。
 */
export function computeOverlayGeometry(args: {
	canvas: [number, number];
	materialSize?: [number, number];
	transform?: ClipTransform;
	borderRadius?: unknown;
	mask?: ClipMask;
}): OverlayGeometry | null {
	const { canvas, materialSize, transform } = args;
	const identity = isIdentityTransform(transform);
	const br = Math.max(0, num(args.borderRadius, 0));
	const mask = usableMask(args.mask) ? args.mask : undefined;
	if (identity && br <= 0 && !mask) return null;

	const { dw, dh } = displaySize(canvas, materialSize, transform);
	const sx = num(transform?.scale_x, 1);
	const sy = num(transform?.scale_y, 1);
	const brClamped = r3(Math.min(br, Math.min(dw, dh) / 2));

	let spec: MaskRasterSpec | null = null;
	let sigma = 0;
	if (mask || brClamped > 0) {
		const m = mask
			? {
					shape: mask.shape,
					cx: r3(num(mask.center_x, 0)),
					cy: r3(num(mask.center_y, 0)),
					w: r3(Math.max(1e-6, num(mask.width, 0.5))),
					h: r3(Math.max(1e-6, num(mask.height, 0.5))),
					rotation: r3(num(mask.rotation, 0)),
					cornerRadius: mask.shape === "rectangle" ? r3(Math.min(1, Math.max(0, num(mask.corner_radius, 0)))) : 0,
					invert: mask.invert === true,
				}
			: null;
		spec = { v: 1, dw, dh, borderRadius: brClamped, mask: m };
		if (m) sigma = featherSigmaPx(num(mask!.feather, 0), m.w * dw, m.h * dh);
	}

	return {
		dw,
		dh,
		px: r3(num(transform?.position_x, 0)),
		py: r3(num(transform?.position_y, 0)),
		rotation: r3(num(transform?.rotation, 0)),
		alpha: Math.min(1, Math.max(0, num(transform?.alpha, 1))),
		flipH: sx < 0,
		flipV: sy < 0,
		transformed: !identity,
		spec,
		key: spec ? maskKey(spec) : null,
		sigma,
	};
}

/** 内容寻址键：规格 JSON 的 sha256 hex（字段序由 `MaskRasterSpec` 定义序保证）。 */
export function maskKey(spec: MaskRasterSpec): string {
	return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

/** 缓存落点：`<gtrkDir>/.tonghe-cache/masks/<key>.png`。 */
export function maskCachePath(gtrkDir: string, key: string): string {
	return `${gtrkDir.replace(/[\\/]+$/, "")}/${MASK_CACHE_DIR}/${key}.png`;
}

// ───────────────────────────── 光栅 ─────────────────────────────

/** 正五角星（10 顶点，外接圆半径 1、内半径 = 五角星黄金比 0.381966；顶点朝上，y 向下坐标）。 */
const STAR_INNER = 0.381966;
const STAR_POLY: Array<[number, number]> = (() => {
	const pts: Array<[number, number]> = [];
	for (let i = 0; i < 10; i++) {
		const r = i % 2 === 0 ? 1 : STAR_INNER;
		const ang = -Math.PI / 2 + (i * Math.PI) / 5;
		pts.push([r * Math.cos(ang), r * Math.sin(ang)]);
	}
	return pts;
})();

/** 心形隐式曲线 `(x²+y²−1)³ − x²y³ ≤ 0`（y 向上）的包围盒：x ∈ ±1.139，y ∈ [−1, 1.238]。 */
const HEART_HALF_W = 1.139;
const HEART_TOP = 1.238;
const HEART_BOTTOM = -1.0;

function pointInPolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i]!;
		const [xj, yj] = poly[j]!;
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** 形状窗内判据：`(u, v)` 为相对蒙版中心、已逆旋转的像素坐标；`hw/hh` 为半宽高（像素）。 */
function insideShape(shape: MaskShape, u: number, v: number, hw: number, hh: number, cornerRadius: number): boolean {
	switch (shape) {
		case "rectangle": {
			const au = Math.abs(u);
			const av = Math.abs(v);
			if (au > hw || av > hh) return false;
			const r = cornerRadius * Math.min(hw, hh);
			if (r <= 0) return true;
			const dx = au - (hw - r);
			const dy = av - (hh - r);
			if (dx <= 0 || dy <= 0) return true;
			return dx * dx + dy * dy <= r * r;
		}
		case "ellipse": {
			const a = u / hw;
			const b = v / hh;
			return a * a + b * b <= 1;
		}
		case "diamond":
			return Math.abs(u) / hw + Math.abs(v) / hh <= 1;
		case "star":
			return pointInPolygon(u / hw, v / hh, STAR_POLY);
		case "heart": {
			const x = (u / hw) * HEART_HALF_W;
			// 像素 y 向下（v = −hh 为上边）→ 曲线 y 向上：上边 → HEART_TOP、下边 → HEART_BOTTOM
			const y = HEART_TOP - ((v / hh + 1) / 2) * (HEART_TOP - HEART_BOTTOM);
			const q = x * x + y * y - 1;
			return q * q * q - x * x * y * y * y <= 0;
		}
	}
}

/** 圆角矩形（元素显示矩形本身，无旋转、居中）内判据。 */
function insideRoundedRect(x: number, y: number, dw: number, dh: number, r: number): boolean {
	const hw = dw / 2;
	const hh = dh / 2;
	const au = Math.abs(x - hw);
	const av = Math.abs(y - hh);
	if (au > hw || av > hh) return false;
	if (r <= 0) return true;
	const dx = au - (hw - r);
	const dy = av - (hh - r);
	if (dx <= 0 || dy <= 0) return true;
	return dx * dx + dy * dy <= r * r;
}

const SS = 4; // 每轴超采样数（4×4 = 16 采样；先测中心 + 四角，五点一致则不再细采）

/**
 * 光栅蒙版为 8-bit 灰度（长度 dw×dh，行主序；255 = 保留、0 = 遮住）。
 * 形状窗覆盖率（含反相）与元素圆角覆盖率逐像素相乘（design D3：圆角 ∩ 形状窗）。确定性：无随机源、定点采样格。
 */
export function rasterMask(spec: MaskRasterSpec): Uint8Array {
	const { dw, dh } = spec;
	const out = new Uint8Array(dw * dh);
	const m = spec.mask;
	const rot = m ? (m.rotation * Math.PI) / 180 : 0;
	const cos = Math.cos(-rot);
	const sin = Math.sin(-rot);
	const cxPx = m ? dw / 2 + m.cx * dw : 0;
	const cyPx = m ? dh / 2 + m.cy * dh : 0;
	const hw = m ? Math.max(1e-6, (m.w * dw) / 2) : 0;
	const hh = m ? Math.max(1e-6, (m.h * dh) / 2) : 0;
	const br = spec.borderRadius;

	// 形状判据**不含**反相：反相在覆盖率层做精确补（`255 − cov`）。若把反相放进判据，边界像素的超采样
	// 计数 `round(hit×255/16)` 与 `round((16−hit)×255/16)` 会在 hit=8 时各得 128、相加 256——反相不再是补集。
	const shapeAt = (x: number, y: number): boolean => {
		if (!m) return true;
		const dx = x - cxPx;
		const dy = y - cyPx;
		const u = dx * cos - dy * sin;
		const v = dx * sin + dy * cos;
		return insideShape(m.shape, u, v, hw, hh, m.cornerRadius);
	};
	const borderAt = (x: number, y: number): boolean => (br > 0 ? insideRoundedRect(x, y, dw, dh, br) : true);

	const coverage = (px: number, py: number, test: (x: number, y: number) => boolean): number => {
		// 五点预判：中心 + 四角一致 ⇒ 整像素同值（绝大多数像素走此路）
		const c = test(px + 0.5, py + 0.5);
		const eps = 1e-3;
		const corners =
			test(px + eps, py + eps) === c &&
			test(px + 1 - eps, py + eps) === c &&
			test(px + eps, py + 1 - eps) === c &&
			test(px + 1 - eps, py + 1 - eps) === c;
		if (corners) return c ? 255 : 0;
		let hit = 0;
		for (let j = 0; j < SS; j++) {
			for (let i = 0; i < SS; i++) {
				if (test(px + (i + 0.5) / SS, py + (j + 0.5) / SS)) hit++;
			}
		}
		return Math.round((hit * 255) / (SS * SS));
	};

	for (let y = 0; y < dh; y++) {
		for (let x = 0; x < dw; x++) {
			let v = m ? coverage(x, y, shapeAt) : 255;
			if (m && m.invert) v = 255 - v;
			if (br > 0 && v > 0) v = Math.round((v * coverage(x, y, borderAt)) / 255);
			out[y * dw + x] = v;
		}
	}
	return out;
}

/** 8-bit 灰度 PNG（color type 0，无隔行）；deflate level 9、无时间戳 ⇒ 同输入同字节。 */
export function encodeGrayPng(gray: Uint8Array, width: number, height: number): Buffer {
	if (gray.length !== width * height) throw new Error(`灰度缓冲长度 ${gray.length} ≠ ${width}×${height}`);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // color type: grayscale
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	const stride = 1 + width;
	const raw = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		raw[y * stride] = 0; // filter: None
		raw.set(gray.subarray(y * width, (y + 1) * width), y * stride + 1);
	}
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw, { level: 9 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/** 一步到位：规格 → PNG 字节。 */
export function renderMaskPng(spec: MaskRasterSpec): Buffer {
	return encodeGrayPng(rasterMask(spec), spec.dw, spec.dh);
}
