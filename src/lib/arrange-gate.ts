/**
 * 编排取数路选择 + 四层回滚（change: add-broll-arrange-atom P3.1）。
 *
 * 三步影子的执行面（design §7）：`local` → `shadow` → `cloud`。
 *
 * ## 适用面（主理人 2026-08-29 终裁）
 *
 * **只作用于本地素材上轨铺排。** 素材矩阵路（素材库检索 → 客户端挑选 → 确认 /
 * 快速模式铺到位）的编排决策继续在本地跑、逐字不动——按业务线切，不按算法切。
 * 判据在 `plan.member_type === "local"`，见 `isLocalArrangeScope`。
 *
 * ## 回滚四层（design §7）
 *
 * | 层 | 触发 | 位置 |
 * |---|---|---|
 * | ① 客户端总闸 | `GITRUCK_ARRANGE=off` | 本文件 `resolveArrangeMode` |
 * | ② 服务端熔断 | 端点不可达 / 5xx 重试用尽 | `requestArrange` 抛 `ArrangeError` → 本文件接住回落 |
 * | ③ algo_pin | 口径版本不认识（6212）/ 双端复算不一致（6210） | 服务端拒绝 → 本文件接住回落 |
 * | ④ 版本回退 | npm 版本回滚 | 代码外 |
 *
 * ⟲ **2026-08-31 抽芯后，四层语义按「谁做的决定」一分为二**（主理人两次拍板：
 * 「本地素材全部走云端、不维护两套」→「把本地编排完全丢掉，只能走我们云端编排」）：
 *
 * - **系统故障**（②③ 与产物违约）在本地素材路上 **报错中断**，不再回落。
 *   回落产出的是另一套算法的结果，而用户以为拿到的是云端那套——静默换引擎比报错更坏。
 * - **总闸（①）** 仍回落：它是**我们**的止血阀，不是用户的逃生舱。云端编排真出故障时，
 *   没有它就只能眼看所有人停工。它是 env 开关、不进用户文档，触发时大声说明换了引擎。
 * - **版本回退（④）** 在代码外。
 *
 * 原文存档：「四层的共同语义是『回落本地，工程照做完』，不是『报错中断』——
 * 用户在跑的是自己的片子，我们的迁移节奏不该成为他交不了片的理由。」
 * 那句话在**双引擎并存期**成立；抽芯后本地素材路已无第二个引擎可退，它就不再是保护、
 * 而是「悄悄给你一份不一样的东西」。
 *
 * ## ★ 一处诚实性要求
 *
 * 自校验失败（服务端产物与本地复算不一致）时，**费已经计过了**——服务端是在成功返回
 * 之后才登记的，我们却把它的产物扔了。这件事 MUST 大声告诉用户：
 * 悄悄回落等于让他为一份被丢弃的产物付了钱而不知情。
 * 其余三层不存在这个问题（都是零执行零计费的前置拒绝或根本没到服务端）。
 */

import type { BrollPlan } from "./matrix";
import type { ArrangeOutcome } from "./arrange-apply";
import { applyArrangeResponse, diffArrangeOutcome } from "./arrange-apply";
import { type LocalArrangeOpts, projectArrangeRequest } from "./arrange-wire";
import { type ArrangeDeps, type ArrangeEndpoint, requestArrange } from "./arrange-client";

/** `local`=只本地（现状）；`shadow`=本地落轨 + 云端只对拍不采纳；`cloud`=采纳云端产物。 */
export type ArrangeMode = "local" | "shadow" | "cloud";

/** ① 客户端总闸：任何取值都只会让路径**更保守**，MUST NOT 有「env 打开更激进」的口子。 */
export const ARRANGE_KILL_SWITCH = "GITRUCK_ARRANGE";

/**
 * 取数路决议。总闸是**单向**的：只能把云端关小，不能把它开大。
 *
 * 这条不对称是刻意的——总闸的用途是出事时止血，而止血阀不该同时是油门。
 * 若 env 也能把 `local` 抬成 `cloud`，一次误设的环境变量就能让整台机器
 * 在没人知情的情况下开始花钱。
 */
export function resolveArrangeMode(requested: ArrangeMode, env: NodeJS.ProcessEnv = process.env): ArrangeMode {
	const sw = env[ARRANGE_KILL_SWITCH]?.trim().toLowerCase();
	if (sw === "off" || sw === "0" || sw === "local") return "local";
	if (sw === "shadow") return requested === "local" ? "local" : "shadow"; // 只降不升
	return requested;
}

/**
 * 适用面判据：**只有本地素材路**走云端编排。
 *
 * 素材矩阵路的 plan `member_type` 是 `internal`/`external`，一律留在本地跑——
 * 这不是性能取舍，是主理人 260829 的终裁：按业务线切，不按算法切。
 */
export function isLocalArrangeScope(plan: Pick<BrollPlan, "member_type">): boolean {
	return plan.member_type === "local";
}

/** 回落归因（人读告警 + 机读诊断共用；MUST NOT 静默）。 */
export type FallbackReason =
	| "kill_switch" // ① 总闸
	| "out_of_scope" // 素材矩阵路——不是回滚，是本来就不该走云端
	| "unreachable" // ② 服务端熔断
	| "rejected" // ③ 服务端业务拒绝（含 algo_pin 与双端复算不一致）
	| "malformed" // 产物结构违约
	| "self_check_failed"; // 本地复算自校验不一致 ★ 已计费

export interface ArrangeGateResult {
	outcome: ArrangeOutcome;
	/** 产物实际来自哪一侧。 */
	source: "local" | "cloud";
	mode: ArrangeMode;
	fallback?: FallbackReason;
	/** shadow / 自校验的逐条差异（空数组 = 逐字节一致；未对拍时缺席）。 */
	diffs?: string[];
	/** 服务端复算的编排量（计过费的那个数）；未走到服务端时缺席。 */
	units?: number;
	/** false = 服务端幂等登记未写成，本次调用不受幂等保护。 */
	idempotencyRecorded?: boolean;
}

export interface ArrangeGateDeps {
	/** 本地决策（注入 `planBeatFills` 的包装；此处不直接依赖它以免把决策层拖进本模块）。 */
	runLocal: () => ArrangeOutcome;
	endpoint?: ArrangeEndpoint;
	request?: typeof requestArrange;
	clientDeps?: ArrangeDeps;
	log?: { info: (m: string) => void; warn: (m: string) => void };
	costCap?: number;
	/**
	 * `cloud` 档是否做本地复算自校验。**恒开**——包括抽芯之后。
	 *
	 * ★ 订正一处早先的预判：本字段原注释写「P4 抽芯后本地无从复算，届时关闭」。
	 * 那句话预设了抽芯会把 `planBeatFills` 抽出分发物，而 design §8′ 终裁后它抽不掉
	 * ——素材矩阵路仍要在本地跑同一份决策。既然它还在，复算就做得到，
	 * 这层白送的安全网没有理由关。
	 */
	selfCheck?: boolean;
	/**
	 * 抽芯档（P4.1，主理人 2026-08-31 裁定「本地素材全部走云端，不需要维护两套」）：
	 * **本地素材路不再自动回落本地**。
	 *
	 * 开启后 `unreachable` / `rejected` / `malformed` 三种情形 SHALL **抛错**而非回落。
	 * 理由是诚实性：回落产出的是**另一套算法**的结果，而用户以为拿到的是云端那套；
	 * 悄悄换引擎比直接报错更坏——报错他知道该重试或换档，静默换算法他连问题存在都不知道。
	 *
	 * **两个例外仍回落，不受本开关影响**：
	 * - **总闸**（`GITRUCK_ARRANGE=off`）：止血阀必须真能止血，否则它就不是阀门。
	 *   它走 `mode === "local"` 的提前返回，根本到不了这里。
	 * - **自校验不一致**：那一路本地产物**已经算出来了**、服务端也已计费，
	 *   扔掉一个手上就有的可用产物对用户没有任何好处。照旧回落 + 大声告知。
	 */
	strictCloud?: boolean;
}

/** 抽芯档下不再回落的那三种情形共用的错误。
 *
 * ★ 2026-08-31 主理人二次拍板「把本地编排完全丢掉，只能走我们云端编排」后，
 * 本错误**不再给 `--arrange local` 逃生舱**——那条路已被 `resolveAutoArrangeMode` 关死，
 * 指过去只会让用户再撞一次参数错误。**报错仍必须给出路**，只是出路变成「重试 / 反馈」。 */
export class ArrangeUnavailableError extends Error {
	/** 鸭子标记：同 `ArrangeError`，多 bundle 下 instanceof 不可靠。 */
	readonly arrangeUnavailable = true;
	constructor(
		readonly reason: FallbackReason,
		detail: string,
	) {
		super(
			`本地素材的 B-roll 编排在云端完成，本轮没能拿到云端产物：${detail}\n` +
				"本地素材的编排只在服务端跑（算法只在那里迭代），所以这里**不会**改用别的算法把活干完" +
				"——那会给你一份和云端不同的结果而你并不知情。\n" +
				"出路：先排查网络与凭据后重试；若持续失败请把这条报错发给我们——" +
				"这说明是我们这边的问题，不该由你来绕过。\n" +
				"（素材矩阵那条路的**编排**不受影响，本来就在你机器上跑、也不计费；它的检索照旧按次计费。）",
		);
		this.name = "ArrangeUnavailableError";
	}
}

const NOOP_LOG = { info: () => {}, warn: () => {} };

/**
 * 按取数路执行编排，任何一层触发即回落本地并**指名归因**。
 *
 * `shadow` 与 `cloud` 的差别只有一处：谁的产物被采纳。两档都跑本地、都对拍——
 * 这让「切流」退化成改一个字符串，回滚同理。
 */
export async function runArrangeWithFallback(
	plan: BrollPlan,
	lay: number,
	scoreFloor: number,
	opts: LocalArrangeOpts,
	requestedMode: ArrangeMode,
	deps: ArrangeGateDeps,
): Promise<ArrangeGateResult> {
	const log = deps.log ?? NOOP_LOG;
	const mode = resolveArrangeMode(requestedMode);

	if (mode === "local") {
		return { outcome: deps.runLocal(), source: "local", mode, ...(requestedMode !== "local" ? { fallback: "kill_switch" as const } : {}) };
	}
	if (!isLocalArrangeScope(plan)) {
		// 不是回滚——素材矩阵路本来就不该走云端编排（终裁：按业务线切）
		log.info("本轮是素材矩阵路（member_type 非 local），编排继续在本地跑——云端编排只承担本地素材上轨铺排。");
		return { outcome: deps.runLocal(), source: "local", mode, fallback: "out_of_scope" };
	}

	// 本地照跑：shadow 期它是产物，cloud 期它是自校验的对照。
	// ★ 抽芯档下 shadow 仍需要它（对拍），cloud 也仍需要它（自校验）——所以这一行不能省。
	const local = deps.runLocal();
	//: 抽芯只作用于 **cloud 档**：shadow 的全部意义就是「本地落轨 + 云端只对拍」，
	//: 在那一档上抛错等于把一个纯观测档变成了硬依赖。
	const strict = deps.strictCloud === true && mode === "cloud";
	const fallback = (reason: FallbackReason, msg: string): ArrangeGateResult => {
		if (strict) throw new ArrangeUnavailableError(reason, msg);
		log.warn(`${msg}——本轮回落本地编排，工程照常完成。`);
		return { outcome: local, source: "local", mode, fallback: reason };
	};

	if (!deps.endpoint) return fallback("unreachable", "未配置编排端点");

	const req = projectArrangeRequest(plan, lay, scoreFloor, opts, deps.costCap !== undefined ? { costCap: deps.costCap } : {});
	let resp;
	try {
		resp = await (deps.request ?? requestArrange)(deps.endpoint, req, deps.clientDeps ?? {});
	} catch (e) {
		// ③ 业务拒绝（含 algo_pin 6212 与双端复算不一致 6210）：零执行零计费
		// ★ 判别用**鸭子标记**不用 instanceof：多 bundle 下类身份不唯一（本仓 EmbedRejectedError
		//   已有明文先例）。认错的代价是把一个本可回落的故障当成真 bug 抛到用户脸上。
		if ((e as { rejected?: unknown } | null)?.rejected === true) {
			return fallback("rejected", `服务端拒绝了本轮云端编排：${(e as Error).message}`);
		}
		// ② 服务端熔断 / 端点不可达
		if ((e as { unreachable?: unknown } | null)?.unreachable === true) return fallback("unreachable", (e as Error).message);
		throw e; // 非本层的异常不吞——吞了会把真 bug 伪装成「网络不好」
	}

	let remote: ArrangeOutcome;
	try {
		remote = applyArrangeResponse(resp, lay);
	} catch (e) {
		// 产物结构违约：**已计费**（服务端成功返回过），如实说
		const billed =
			`⚠️ 本次调用服务端已执行并计费（编排量 ${resp.units ?? "?"}），而产物被我们丢弃了。` +
			"请把这条连同上面的违约明细反馈给我们。";
		if (strict) throw new ArrangeUnavailableError("malformed", `服务端编排产物结构违约：${(e as Error).message}\n${billed}`);
		log.warn(`服务端编排产物结构违约，本轮弃用：${(e as Error).message}\n${billed}`);
		return { outcome: local, source: "local", mode, fallback: "malformed", ...(resp.units !== undefined ? { units: resp.units } : {}) };
	}

	const diffs = diffArrangeOutcome(local, remote);
	const common = {
		mode,
		diffs,
		...(resp.units !== undefined ? { units: resp.units } : {}),
		...(resp.idempotency_recorded !== undefined ? { idempotencyRecorded: resp.idempotency_recorded } : {}),
	};

	if (resp.idempotency_recorded === false) {
		log.warn("服务端幂等登记未写成：本次调用不受幂等保护——字节相同的重发会真的重算并重新计费。");
	}

	if (mode === "shadow") {
		if (diffs.length) {
			log.warn(
				`shadow 对拍发现 ${diffs.length} 处差异（**不切流，本轮仍用本地产物**）：\n  ${diffs.slice(0, 5).join("\n  ")}` +
					(diffs.length > 5 ? `\n  …另有 ${diffs.length - 5} 处` : ""),
			);
		} else {
			log.info("shadow 对拍：服务端产物与本地逐字节一致。");
		}
		return { outcome: local, source: "local", ...common };
	}

	// cloud 档
	if (deps.selfCheck !== false && diffs.length) {
		// ★ 已计费却弃用产物——这是四层里唯一一处「用户付了钱、我们扔了东西」，MUST 大声说
		log.warn(
			`本地复算自校验不一致（${diffs.length} 处），本轮弃用服务端产物、改用本地编排：\n  ${diffs.slice(0, 5).join("\n  ")}` +
				(diffs.length > 5 ? `\n  …另有 ${diffs.length - 5} 处` : "") +
				`\n⚠️ 本次调用服务端已执行并计费（编排量 ${resp.units ?? "?"}），而产物被我们丢弃了。` +
				"成片不受影响，但这笔账你花得不明不白——请把这条反馈给我们。",
		);
		return { outcome: local, source: "local", fallback: "self_check_failed", ...common };
	}
	return { outcome: remote, source: "cloud", ...common };
}
