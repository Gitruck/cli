/**
 * 时间域换算的唯一正本（openspec: link-time-domain-discipline，capability `time-domain-discipline` T3
 * 「换算函数每语言一份，取整方向具名，投影方向与消费方同源」）。
 *
 * **零 IO、零依赖**：本仓所有秒 ↔ 毫秒 ↔ 帧换算 SHALL 只经此模块，MUST NOT 在他处复刻
 * （机械判据：`Math.round(x × 1000) / 1000` 全仓只在本文件出现）。
 *
 * 本文件由 `gtrk-patch.ts` 的帧域三件套原样搬出（`sec2frame / f2ms / derive` 与配套 `sec2ms / ms2sec / readMs`），
 * 取整方向一字未改；帧域法（导出链 ①→⑤、唯一 1ms 容差）的正本仍是 `patch-command`「帧对齐」Requirement，
 * `gtrk-patch.ts` 模块头有整段推导。`gtrk-patch.ts` 对本模块 re-export，既有 import 路径不变。
 */

/** 元素的帧域视图（自由变量 + 源侧毫秒），是所有动作的运算对象。 */
export interface FrameView {
	stFrame: number;
	durFrames: number;
	/** 源侧入点（整毫秒）。gap 与 beat 恒为 `null`（契约禁写 `clip_st`/`clip_ed`）。 */
	clipStMs: number | null;
}

// ────────────────────────────── 表示层换算 ──────────────────────────────

/**
 * 秒 → 帧，**半帧进一**。
 *
 * MUST NOT 用 `int()` 截断（会系统性掉一帧：帧 130 @30fps = 4333.33ms，ms 量化成 4.333s 后
 * ×30 = 129.99 帧，截断即 129）；MUST NOT 用裸 `round()`（银行家舍入把恰好半帧取偶，
 * 20ms@25fps ⇒ 0 帧 ⇒ 零时长元素）。须与消费侧帧化口径同源。
 */
export function sec2frame(sec: number, rate: number): number {
	return Math.floor(sec * rate + 0.5);
}

/**
 * 帧 → 整毫秒。标准帧率下往返可逆：`sec2frame(f2ms(n)/1000, rate) === n`
 * （帧域偏差 ≤0.03 帧 ≪ 0.5 帧）。
 *
 * ⚠️ **不可加**：存在 a/b 使 `f2ms(a+b) ≠ f2ms(a)+f2ms(b)`（rate=30 时 f2ms(1)+f2ms(1)=66
 * 而 f2ms(2)=67）。所以它 MUST NOT 被用来单独换算时长——见 `gtrk-patch.ts` 模块头。
 */
export function f2ms(frame: number, rate: number): number {
	return Math.round((frame * 1000) / rate);
}

/** 秒 → 整毫秒（源侧量化用；不涉帧）。 */
export function sec2ms(sec: number): number {
	return Math.round(sec * 1000);
}

/** 整毫秒 → 秒字面（3 位小数，与既有 `r3` 口径同一）。 */
export function ms2sec(ms: number): number {
	return ms / 1000;
}

/**
 * 秒值 → 3 位小数（毫秒就近）的**表示层**工具：用于写 JSON 字段值 / 人读输出时消除浮点尾差。
 *
 * ⚠️ `Math.round` 是**半上入**（含 `Math.round(-0.5) === -0`），与 Python `round()` 的半偶入**不同**
 * ——移植 MUST 用 `math.floor(x*1000+0.5)/1000`。
 *
 * ⚠️ **MUST NOT 用于帧投影**：帧号 → 毫秒是 `f2ms`（方向由 `patch-command`「帧对齐」规定），
 * `r3` 只是把一个已经在秒域的数打到毫秒格，不知道帧率、不做帧吸附。
 * 全仓唯一定义（T3）；新代码 MUST `import { r3 } from "…/lib/frame-domain"`，MUST NOT 私有复刻。
 */
export const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** 读入的秒值 → 整毫秒；非有限数按 `NaN` 透出，由调用方判非法。 */
export function readMs(v: unknown): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? sec2ms(n) : Number.NaN;
}

// ────────────────────────────── 导出链 ──────────────────────────────

/** 一个元素经导出链算出的全部写出值（整毫秒域，写文件前再 `ms2sec`）。 */
export interface DerivedMs {
	trackStMs: number;
	trackEdMs: number;
	durationMs: number;
	clipStMs: number | null;
	clipEdMs: number | null;
	/** 帧数，供「时长是几帧」类判断与回执用。 */
	durFrames: number;
}

/**
 * 导出链：由三个自由变量算出全部写出值。**这是本仓唯一允许产出轨道时码的路径。**
 *
 * ⚠️ `durationMs` 恒取 `trackEdMs − trackStMs`（导出 ④），
 * MUST NOT 写成 `f2ms(durFrames, rate)`——两者不是同一个数。
 */
export function derive(view: FrameView, rate: number): DerivedMs {
	const edFrame = view.stFrame + view.durFrames; // 导出 ①
	const trackStMs = f2ms(view.stFrame, rate); // 导出 ②
	const trackEdMs = f2ms(edFrame, rate); // 导出 ③
	const durationMs = trackEdMs - trackStMs; // 导出 ④ —— 恒是两端之差
	const clipStMs = view.clipStMs;
	const clipEdMs = clipStMs === null ? null : clipStMs + durationMs; // 导出 ⑤
	return { trackStMs, trackEdMs, durationMs, clipStMs, clipEdMs, durFrames: view.durFrames };
}
