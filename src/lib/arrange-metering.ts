/**
 * 编排量计量（add-broll-arrange-atom · design §6′ 的可执行正本）。
 *
 * 定位：`broll_arrange` 原子的**计费单位**。本文件是**双端同源公式的 CLI 侧一份**，
 * 服务端（gitruck-infra `add-broll-arrange-api`）实现另一份，两份 MUST 逐值一致
 * ——一致性不靠自觉，靠 golden fixture 对拍（`test/fixtures/broll-arrange/metering.json`）
 * 与运行时的**双端复算校验**（CLI 把自己算的值随请求上行，服务端复算，不一致即拒绝执行、零计费）。
 *
 * ## ⚠️ 本文件算出的数**不是计费依据**
 *
 * 它有且只有两个用途：**①跑前给用户看的预估**；**②上行给服务端做一致性对照**。
 * 真正的计费金额**恒由服务端独立复算**——本体系历史上发生过**客户端欺骗服务端**的事件
 * （主理人 2026-08-29 指出），故服务端把客户端提交的一切数值视为不可信输入，
 * 包括这个预估值。两值不一致时服务端**拒绝执行、零计费**并指名「公式漂移」。
 *
 * 这条对本文件的实际约束是：**本文件的正确性只影响用户体验（预估准不准）与请求能否通过校验，
 * 不影响用户被扣多少**。所以这里出错的表现是「明明该能跑却被拒」，而不是「算少了少扣钱」
 * ——后者在服务端那一侧被结构性地挡住了。
 *
 * ## 为什么全是整数
 *
 * 计量链上**一个浮点都不出现**：入参全是计数（beat 数 / 段数 / 轨数 / 标定遍数），
 * 运算只有整数乘加与向上取整（用 `(x + d - 1) / d` 的整数写法，不用 `Math.ceil` 除法）。
 * 这不是洁癖——跨语言浮点舍入分叉是本件的头号风险面（见 design §5 的六个坑），
 * 把计费公式设计成纯整数，等于让这条链**结构上不可能**踩那些坑。
 * ⚠️ 后来者若要引入「按秒计」「按比例折扣」一类小数项，MUST 先把它折算成整数计数再进公式。
 *
 * ## 口径
 *
 *   U = ⌈ (BEAT_WEIGHT × beat数 + 候选段数) × 轨数 × 标定遍数 / UNITS_DIVISOR ⌉ + QC 项
 *
 * - **beat 数**与**候选段数**是两条正交的复杂度轴：前者是片子有多少段落要铺，
 *   后者是每段有多少候选可挑（检索深度）。`BEAT_WEIGHT` 把两者拉到同一量级
 *   （真实工程实测：beat 数中位 7、段数中位 28，差约一个量级）。
 * - **轨数**（`lay`）线性计入：铺 N 条候选轨就是把整套决策跑 N 遍。
 * - **标定遍数**：句界吸附在 `0 < ratio < 1` 时要先跑一遍**满吸标定**求可达覆盖率，
 *   再跑正式遍 ⇒ 决策工作量恰好翻倍（见 matrix-lay 的两遍法）。
 * - **QC 项**：编排期 QC（L2 画音对齐闭环）的判定帧开销。**本版恒 0**——QC 尚未落地；
 *   字段先立在这里，落地时按 `MAX_QC_ROUNDS` 取满计入（预估恒 ≥ 实耗）。
 *
 * ## 常量与版本
 *
 * 常量表随 `METERING_ALGO_PIN` 走。**改任何一个常量 MUST bump pin**——否则同一份 plan
 * 在新旧两端会算出不同的价，而双端复算校验会把它报成「公式漂移」（那是对的，但报错信息
 * 会指向错误的方向）。
 */

/** 计量口径版本。改任何常量或公式形态 MUST bump 它（服务端按 pin 选常量表）。 */
export const METERING_ALGO_PIN = "arrange-metering@v1";

/** beat 权重：把「段落数」与「候选段数」两条轴拉到同一量级（真实工程实测标定）。 */
export const BEAT_WEIGHT = 8;

/** 归一分母：决定 1 编排量对应多大的工作量。真实工程实测落在 1–39 区间、中位 4。 */
export const UNITS_DIVISOR = 32;

/** 规模三元（全整数，全部可由请求体直接数出来——服务端零状态即可复算）。 */
export interface ArrangeScale {
	/** plan 的 beat 数。 */
	beats: number;
	/** 全 plan 候选段数（Σ beats Σ queries Σ results segments）。 */
	segments: number;
	/** 请求的候选轨数 `lay`。 */
	lay: number;
	/** 标定遍数：句界吸附 `0 < ratio < 1` 且有句起点时为 2，否则 1。 */
	calibrationPasses: 1 | 2;
	/** 编排期 QC 的判定帧数。**本版恒 0**（QC 未落地）。 */
	qcFrames: number;
}

/** 最小 plan 形状（只取计量用得到的三层计数，MUST NOT 依赖决策层类型）。 */
interface CountablePlan {
	beats?: {
		queries?: { results?: { segments?: unknown[] }[] }[];
	}[];
}

/**
 * 从请求体数出规模三元。**只数不判**——不做地板过滤、不看 pinned、不管 noImage：
 * 计的是「你让服务端过一遍多大的盘子」，不是「最后用上了几个」。
 * 这条口径是刻意的：过滤发生在决策内部，若计量跟着过滤走，同一份请求在不同 score_floor
 * 下就会算出不同的价，而 score_floor 是用户随手调的旋钮——那会变成「调参要钱」。
 */
export function scaleOfRequest(
	plan: CountablePlan,
	lay: number,
	opts: { cutAlign?: { ratio: number; starts: number[] } } = {},
): ArrangeScale {
	const beats = plan.beats?.length ?? 0;
	let segments = 0;
	for (const b of plan.beats ?? []) {
		for (const q of b.queries ?? []) {
			for (const r of q.results ?? []) segments += r.segments?.length ?? 0;
		}
	}
	const ca = opts.cutAlign;
	// 两遍标定的触发条件与 planBeatFills 内的判据逐字一致：激活 ∧ ratio<1
	// （ratio≥1 是「全吸」，不需要标定遍）。判据漂移会让预估与实耗分家。
	const calibrated = !!ca && ca.ratio > 0 && ca.ratio < 1 && (ca.starts?.length ?? 0) > 0;
	return { beats, segments, lay, calibrationPasses: calibrated ? 2 : 1, qcFrames: 0 };
}

/**
 * 规模三元 → 编排量（整数）。
 *
 * ⚠️ 向上取整用整数写法 `(num + d - 1) / d` 后取整，**MUST NOT** 写成 `Math.ceil(num / d)`
 * ——后者先做浮点除法，跨语言在边界值上可能分叉（Python 的 `math.ceil(a/b)` 同理有此风险，
 * 正确写法是 `-(-num // d)` 或 `(num + d - 1) // d`）。
 */
export function arrangeUnits(scale: ArrangeScale): number {
	if (scale.beats <= 0 || scale.lay <= 0) return 0; // 空 plan / 零轨：无可编排（调用方应前置拒绝）
	const num = (BEAT_WEIGHT * scale.beats + scale.segments) * scale.lay * scale.calibrationPasses;
	const decision = Math.floor((num + UNITS_DIVISOR - 1) / UNITS_DIVISOR);
	// U ≥ 1 由构造保证（beats ≥ 1 ⇒ num ≥ BEAT_WEIGHT ⇒ decision ≥ 1）。
	// 这条不是装饰：服务端配额层对「单位 ≤ 0」有兜底（会当 1 或 0.01 处理），
	// 恒 ≥1 让我们永远走不到那个兜底分支，账面语义因此是确定的。
	return decision + scale.qcFrames;
}

/** 一步到位：请求体 → 编排量。CLI 与服务端调的是同一条路径。 */
export function estimateArrangeUnits(
	plan: CountablePlan,
	lay: number,
	opts: { cutAlign?: { ratio: number; starts: number[] } } = {},
): number {
	return arrangeUnits(scaleOfRequest(plan, lay, opts));
}
