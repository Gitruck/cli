/**
 * 纯色 PNG 编码叶子（add-matrix-black-bed-track）。
 *
 * 为什么要有它：matrix 铺 B-roll 时要在候选轨之下垫一条纯黑底轨遮住口播 A-roll，而 `.gtrk` 契约里
 * 没有「纯色/黑场」这类合成素材类型（materials 条目连 type 字段都没有），素材只能是真实文件。
 * 客户端有一等实现（内置示例素材：canvas 现画 PNG 落 `assets/builtin/`），本叶子是它在 CLI 侧的对偶。
 *
 * **id 与路径式 MUST 与客户端逐字符同源**（opencut `apps/web/src/tonghe/example-media-paths.ts:32-55`）：
 * 客户端导入侧按 `SOLID_ID_RE`（同文件 :61）反解 id 重建像素，id 一旦不合它的正则就回落成灰色占位图。
 * 反过来这也是本方案的兜底——即使盘上 PNG 丢了，客户端仍能凭 id 现画出正确的黑底。
 *
 * 为什么自己编码 PNG 而不调 ffmpeg：ffmpeg 在本仓是**可选依赖**（仅 render/tool 链路要求），
 * 铺轨不该因为没装 ffmpeg 就出不了黑底。纯色图的 PNG 编码只需 zlib，零外部依赖、零子进程。
 */
import { deflateSync } from "node:zlib";

/** 黑底色（六位小写十六进制，不带 `#`）。 */
export const BLACK_BED_HEX = "000000";
/** 纯色素材 id 前缀——与客户端内置示例素材同命名空间。 */
export const SOLID_MATERIAL_PREFIX = "ex-solid-";
/** 纯色落地目录（相对 gtrk 目录），对齐客户端 `exampleRelPath` 的 `assets/builtin/` 布局。 */
export const BUILTIN_ASSET_DIR = "assets/builtin";
/**
 * 单边像素上限。比客户端 `MAX_SOLID_DIM`(16384) 更严：id 直接决定缓冲分配，
 * 8192×8192 已是 ~192MiB 原始字节，铺轨没有任何理由走到这个量级。
 */
export const MAX_BED_DIM = 8192;

/** PNG 签名（固定 8 字节）。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * CRC-32(IEEE 802.3) 查表。**不用 `zlib.crc32`**：那是 node ≥20.15 才有的 API，
 * 而本仓 engines 允许到 20.6，用了会在低版本 node 上运行时炸。
 */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
	return (c ^ 0xffffffff) >>> 0;
}

/** 组一个 PNG chunk：len(4) + type(4) + data + crc(4)，CRC 覆盖 type+data。 */
function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}

/** 归一化 hex：剥 `#`、转小写。非六位十六进制返回 null（调用方按不合法处理）。 */
function normalizeHex(hex: string): string | null {
	const h = hex.replace(/^#/, "").toLowerCase();
	return /^[0-9a-f]{6}$/.test(h) ? h : null;
}

/**
 * 稳定确定性素材 id：同色 + 同画布尺寸恒等 → 幂等复用、跨会话一致、与客户端 bindings 恒等。
 * 产物 MUST 落在客户端 `SOLID_ID_RE`(`^ex-solid-([0-9a-f]{6})-([1-9][0-9]*)x([1-9][0-9]*)$`) 内。
 */
export function solidMaterialId({
	hex,
	width,
	height,
}: {
	hex: string;
	width: number;
	height: number;
}): string {
	const h = normalizeHex(hex);
	if (!h) throw new Error(`非法纯色 hex：${hex}`);
	return `${SOLID_MATERIAL_PREFIX}${h}-${width}x${height}`;
}

/** 落地相对路径（相对 gtrk 目录），与客户端 `exampleRelPath` 同式。 */
export function solidRelPath({
	hex,
	width,
	height,
}: {
	hex: string;
	width: number;
	height: number;
}): string {
	const h = normalizeHex(hex);
	if (!h) throw new Error(`非法纯色 hex：${hex}`);
	return `${BUILTIN_ASSET_DIR}/solid-${h}-${width}x${height}.png`;
}

/**
 * 画布是否可用于垫轨：两边都是有限正整数且 ≤ `MAX_BED_DIM`。
 * 不合法时调用方 SHALL 跳过铺黑轨并告警（`.gtrk` 的 video_size 是外部输入，不可信）。
 */
export function isLayoutableCanvas(canvas: unknown): canvas is [number, number] {
	if (!Array.isArray(canvas) || canvas.length !== 2) return false;
	return canvas.every(
		(v) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_BED_DIM,
	);
}

/**
 * 编码一张纯色 PNG（8-bit truecolor / color type 2 / 无隔行）。
 * 确定性：同 hex + 同尺寸 → 逐字节同结果（deflate 固定 level 9，无时间戳/无随机源）。
 */
export function encodeSolidPng({
	hex,
	width,
	height,
}: {
	hex: string;
	width: number;
	height: number;
}): Buffer {
	const h = normalizeHex(hex);
	if (!h) throw new Error(`非法纯色 hex：${hex}`);
	if (!isLayoutableCanvas([width, height])) {
		throw new Error(`纯色画布尺寸非法或超上限（${width}x${height}，上限 ${MAX_BED_DIM}）`);
	}
	const r = Number.parseInt(h.slice(0, 2), 16);
	const g = Number.parseInt(h.slice(2, 4), 16);
	const b = Number.parseInt(h.slice(4, 6), 16);

	// IHDR：width/height/bitDepth=8/colorType=2(RGB)/compression=0/filter=0/interlace=0
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	// 扫描行：filter byte(0=None) + width×RGB。纯色图逐行相同 → 先做一行再整体复制。
	const stride = 1 + width * 3;
	const row = Buffer.alloc(stride);
	row[0] = 0;
	for (let x = 0; x < width; x++) {
		const off = 1 + x * 3;
		row[off] = r;
		row[off + 1] = g;
		row[off + 2] = b;
	}
	const raw = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) row.copy(raw, y * stride);

	return Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
