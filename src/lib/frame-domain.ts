/**
 * 时间域换算的唯一正本（openspec: link-time-domain-discipline，capability `time-domain-discipline` T3
 * 「换算函数每语言一份，取整方向具名，投影方向与消费方同源」）。
 *
 * **零 IO、零依赖**：本仓所有秒 ↔ 毫秒 ↔ 帧换算 SHALL 只经此模块，MUST NOT 在他处复刻
 * （机械判据：`Math.round(x × 1000) / 1000` 全仓只在本文件出现）。
 *
 * 本文件由 `gtrk-patch.ts` 的帧域三件套原样搬出（`sec2frame / f2ms / derive` 与配套 `sec2ms / ms2sec / readMs`）；
 * 搬出时取整方向一字未改，其后 `fix-matrix-lay-frame-grid`（D5）把 `f2ms` 由就近改为**向下**（见其头注）。
 * 帧域法（导出链 ①→⑤、唯一 1ms 容差）的正本仍是 `patch-command`「帧对齐」Requirement，
 * `gtrk-patch.ts` 模块头有整段推导。`gtrk-patch.ts` 对本模块 re-export，既有 import 路径不变。
 * 写方两家（`gtrk patch`、`matrix lay`）共用本模块，MUST NOT 在铺轨侧复刻第二份取整。
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
 * 帧 → 整毫秒，**向下**投影（fix-matrix-lay-frame-grid D5，改自就近）。
 *
 * 为什么是向下：消费侧有**两种**帧化口径——客户端合成器按「`startTime ≤ t < end`、帧起点采样」判在场
 * （有效帧 = 第一个 ≥ 投影值的采样帧，即**向上**），`gtrk render` 按累计**就近**取整分配帧数。
 * 向下的投影值 ≤ 帧时刻 ⇒ 客户端恰得 `n`；残差 <1ms ≤ 0.06 帧 ⇒ 就近仍得 `n`。
 * 就近投影会让 30/24/60fps 下三分之一的帧位（`n·1000/rate` 小数部分 > .5）在客户端晚一帧显示，MUST NOT 回退。
 *
 * 标准帧率下往返可逆：`sec2frame(f2ms(n)/1000, rate) === n`——证明：`f2ms(n)/1000 ≥ n/rate − 1/1000`，
 * 于是 `f2ms(n)/1000·rate + 0.5 ≥ n − rate/1000 + 0.5`，而 `rate ≤ 60` 时 `rate/1000 ≤ 0.06 < 0.5`，
 * 向下取整恒得 `n`（上界 `≤ n + 0.5` 显然）。
 *
 * ⚠️ **不可加**：存在 a/b 使 `f2ms(a+b) ≠ f2ms(a)+f2ms(b)`（rate=30 时 f2ms(2)+f2ms(1)=66+33=99
 * 而 f2ms(3)=100）。所以它 MUST NOT 被用来单独换算时长——见 `gtrk-patch.ts` 模块头。
 */
export function f2ms(frame: number, rate: number): number {
	return Math.floor((frame * 1000) / rate);
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

// ────────────────────────────── 标准帧率表（T6） ──────────────────────────────
//
// add-frame-rate-table-vfr-detect：本仓**唯一**帧率表，两个视图、皆无洞：
//   · 源真值视图 `snapRationalRate`——把 ffprobe 求值出的 `29.970029…` 认回 `30000/1001`（相对差 ≤ 0.2% 才吸附，
//     否则原值；90 / 27.5 这类非标值照原样透出，不硬套）。用于「这条源到底是什么帧率」的判读与人读呈现。
//   · 交付视图 `deliveryRate`——本仓写顶层 `video_rate` 的模块（`audio align` 兜底工程等）SHALL 经它取**正整数**：
//     NLE 表 `[23.976, 24, 25, 29.97, 30, 50, 59.94, 60]` 最近邻后 `round`，与客户端 `floatToFrameRate + Math.round`
//     同口径（封顶 60：`90 → 60`、`120 → 60`）。最近邻构造保证 `(0, ∞)` 每个实数恰得一个正整数（无洞）。
// ⚠️ MUST NOT 套云端交付桶（infra `(0,45]→30` 之类）：那是云端归一化闸门，25fps 源在本地工程从来不会变 30 时间线，
//    客户端也不这么干。MUST NOT 在他处各自 `Math.round(fps)`（T6 逐字点名 `audio-align.ts` 旧写法）。
// 读侧判据是 `gtrk-patch.ts videoRateOf`（正整数即收，不再吸附）；写侧吸附函数只有这里的 `deliveryRate`。

/** 有理帧率 `{num, den}`（`30000/1001` 这类 NTSC 值保精确分子分母，不落成浮点）。 */
export interface RationalRate {
	num: number;
	den: number;
}

/** 标准有理帧率表：`[24000/1001, 24, 25, 30000/1001, 30, 50, 60000/1001, 60, 120]`（120 只在素材平面，交付视图封顶 60）。 */
export const STANDARD_RATES: readonly RationalRate[] = Object.freeze([
	{ num: 24000, den: 1001 },
	{ num: 24, den: 1 },
	{ num: 25, den: 1 },
	{ num: 30000, den: 1001 },
	{ num: 30, den: 1 },
	{ num: 50, den: 1 },
	{ num: 60000, den: 1001 },
	{ num: 60, den: 1 },
	{ num: 120, den: 1 },
]);

/** `snapRationalRate` 的吸附半径（相对差）：`29.97 / 23.98 / 59.94` 这类 ffprobe 求值与四舍五入写法全在 0.2% 内，
 *  而 `30 ↔ 29.97` 差 0.1% 也在半径内——故按**最近邻**先选再判半径（30 恰落 30，不会被 NTSC 邻居抢走）。 */
const RATIONAL_SNAP_TOLERANCE = 0.002;

/** 交付视图的 NLE 帧率表（客户端 `floatToFrameRate` 同表；封顶 60）。 */
const DELIVERY_TABLE: readonly number[] = Object.freeze([23.976, 24, 25, 29.97, 30, 50, 59.94, 60]);

/**
 * 源真值视图：与 `STANDARD_RATES` 最近项相对差 ≤ 0.2% 时吸附为该有理值，否则原值（`{num: fps, den: 1}`）。
 * 非有限 / 非正输入不吸附、原样透出（`den: 1`），由调用方按 T6「缺失即错」处置。
 */
export function snapRationalRate(fps: number): RationalRate {
	if (!Number.isFinite(fps) || fps <= 0) return { num: fps, den: 1 };
	let best: RationalRate | null = null;
	let bestDiff = Number.POSITIVE_INFINITY;
	for (const r of STANDARD_RATES) {
		const diff = Math.abs(fps - r.num / r.den);
		if (diff < bestDiff) {
			bestDiff = diff;
			best = r;
		}
	}
	if (best && bestDiff / (best.num / best.den) <= RATIONAL_SNAP_TOLERANCE) return { num: best.num, den: best.den };
	return { num: fps, den: 1 };
}

/**
 * 交付视图：NLE 表最近邻后 `Math.round` ⇒ 顶层 `video_rate` 用的正整数（`29.97 → 30`、`23.98 → 24`、`120 → 60`）。
 * 非有限 / 非正输入抛错——T6「帧率缺失 MUST 报错，MUST NOT 默认」：这里 MUST NOT 以 25 / 30 兜底。
 */
export function deliveryRate(fps: number): number {
	if (!Number.isFinite(fps) || fps <= 0) {
		throw new Error(`源文件帧率不可解析（读到 ${String(fps)}），不以标准帧率兜底——请检查源文件的 r_frame_rate`);
	}
	let best = DELIVERY_TABLE[0]!;
	let bestDiff = Math.abs(fps - best);
	for (const v of DELIVERY_TABLE) {
		const diff = Math.abs(fps - v);
		if (diff < bestDiff) {
			bestDiff = diff;
			best = v;
		}
	}
	return Math.round(best);
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
