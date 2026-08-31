/**
 * B-roll 本地素材编排 —— 下行应用层（change: add-broll-arrange-atom P2.2）。
 *
 * 把 `POST /task/cli/broll_arrange` 的响应还原成与本地 `planBeatFills` **同形**的产物，
 * 使下游落轨代码（`matrix.ts` 的候选下载 → `layBrollTracks`）一行不用改。
 *
 * ## 为什么必须同形，而不是「下游适配一下」
 *
 * 本 change 的迁移节奏是**三步影子**（design §7）：shadow 期本地照跑照落轨、服务端产物只
 * diff 上报；切流后才换源。两条路要在同一个下游上反复切换——若两边产物形态不同，
 * 下游就会长出 `if (来自云端)` 分支，而**每一个这样的分支都是一处只在一条路上被测到的代码**。
 * 同形则让「换源」退化成换一个变量的赋值，回滚同理。
 *
 * ## 三条硬约束（design §2 出参）
 *
 * 1. **反序列化对象必须可写**。图片运镜是本地后置补丁，会**就地改写槽位两次**
 *    （注入 `material_id`、改写窗口）。`JSON.parse` 的产物天然可写，但 MUST NOT 在此
 *    `Object.freeze` 或返回只读视图——那会让运镜在切流后静默失效（不报错，只是没运镜）。
 * 2. **空轨占位必须保留**。`track_index` 由**数组位置**决定，不是由字段给的。
 *    压掉一条空轨，后面所有轨的编号整体前移一位，落轨落到错的轨上而字节照样合法。
 * 3. **槽位 MUST NOT 含 `material_id`**。它是本地事实（材料实体由 `layBrollTracks` 的
 *    `injectedMaterials` 登记），服务端给不出也不该给。若响应里带了它，
 *    说明服务端越界或响应被污染——**大声拒绝**，MUST NOT 静默采纳。
 *
 * ## 校验的姿态：结构完整性，不做原件比对
 *
 * 沿用 plan 可编辑通路的既有立场（`matrix.ts` 的 `validatePlanResultForLay`）：
 * 我们从不拿「与本地算出来的不一致」当拒绝理由——那正是服务端存在的意义。
 * 拒绝面只有**结构性违约**：形态不对、必填缺失、越界、出现了不该出现的键。
 */

import type { AnchorOutcome, FillSlot, FillStats, GapFillEntry } from "./matrix-lay";

/** 服务端响应的 data 段（形态与 golden fixture 的 `expected` 逐字段同构）。 */
export interface ArrangeResponse {
	fills: Record<string, FillSlot[][]>;
	clip_ids?: string[];
	stats: FillStats;
	pinned: { requested: string[]; yielded: string[] };
	mark_stats: { hit: number; neutral: number; hlHit: number; hlNeutral: number };
	anchors: AnchorOutcome[];
	/** 条件键：吸附未激活时**整键缺席**（MUST NOT 补 null）。 */
	cut_align?: { target: number; starts_total: number; aligned: number; ratio: number };
	gap_fills?: GapFillEntry[];
	/** 计费回显（服务端复算值）。 */
	units?: number;
	task_id?: string;
	idempotent_replay?: boolean;
	/** false = 幂等登记未写成，本次调用不受幂等保护（重发会重算并重新计费）。 */
	idempotency_recorded?: boolean;
}

/** 与 `planBeatFills` 返回值同形。 */
export interface ArrangeOutcome {
	fills: Map<string, FillSlot[][]>;
	clipIds: Set<string>;
	stats: FillStats;
	pinnedOutcome: { requested: string[]; yielded: string[] };
	markStats: { hit: number; neutral: number; hlHit: number; hlNeutral: number };
	anchors: AnchorOutcome[];
	cutAlign?: { target: number; starts_total: number; aligned: number; ratio: number };
	gapFills?: GapFillEntry[];
}

/** 结构性违约 —— 拒绝而非降级。 */
export class ArrangeResponseInvalid extends Error {
	constructor(public readonly problems: string[]) {
		super(
			`服务端编排产物结构违约（${problems.length} 处），本轮不落轨：\n  ${problems.join("\n  ")}\n` +
				"这不是「与本地算得不一致」——那不是拒绝理由；这是产物形态本身不合契约。",
		);
		this.name = "ArrangeResponseInvalid";
	}
}

const FINITE = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 槽位必填七键；`material_id` 在**禁止**名单上（本地事实，服务端给不出）。 */
const SLOT_REQUIRED = ["clip_id", "query", "score", "clip_st", "clip_ed", "track_st", "track_ed"] as const;

function checkSlot(s: unknown, where: string, problems: string[]): void {
	if (!s || typeof s !== "object" || Array.isArray(s)) {
		problems.push(`${where}：槽位不是对象`);
		return;
	}
	const o = s as Record<string, unknown>;
	for (const k of SLOT_REQUIRED) {
		if (!(k in o)) {
			problems.push(`${where}：缺必填键 ${k}`);
			return;
		}
	}
	if (typeof o.clip_id !== "string" || !o.clip_id) problems.push(`${where}：clip_id 须为非空字符串`);
	if (typeof o.query !== "string") problems.push(`${where}：query 须为字符串（红线 1：原文，不是下标）`);
	for (const k of ["score", "clip_st", "clip_ed", "track_st", "track_ed"] as const) {
		if (!FINITE(o[k])) problems.push(`${where}：${k} 须为有限数字`);
	}
	if (FINITE(o.clip_st) && FINITE(o.clip_ed) && !(o.clip_ed > o.clip_st)) {
		problems.push(`${where}：素材窗口非正长（${o.clip_st}–${o.clip_ed}）`);
	}
	if (FINITE(o.track_st) && FINITE(o.track_ed) && !(o.track_ed > o.track_st)) {
		problems.push(`${where}：时间线窗口非正长（${o.track_st}–${o.track_ed}）`);
	}
	// ★ 越界键：material_id 是本地后置补丁注入的材料 id，服务端给出即越界
	if ("material_id" in o) {
		problems.push(`${where}：槽位带了 material_id —— 那是本地事实（图片运镜后置补丁注入），服务端 MUST NOT 给`);
	}
	if ("gap_fill" in o && o.gap_fill !== true) {
		problems.push(`${where}：gap_fill 只允许取 true（非填充槽位应整键缺席，不是 false）`);
	}
}

/**
 * 响应 → 本地产物。**结构违约即抛**（`ArrangeResponseInvalid`），MUST NOT 静默降级：
 * 一份形态不对的产物落进时间线，症状是画面错位而不是报错，事后极难归因。
 *
 * @param expectedLay 本地请求的轨数——用来验空轨占位没被压掉（见 §硬约束 2）。
 */
export function applyArrangeResponse(resp: ArrangeResponse, expectedLay: number): ArrangeOutcome {
	const problems: string[] = [];

	if (!resp || typeof resp !== "object") throw new ArrangeResponseInvalid(["响应不是对象"]);
	if (!resp.fills || typeof resp.fills !== "object" || Array.isArray(resp.fills)) {
		throw new ArrangeResponseInvalid(["响应缺 fills 或形态不对"]);
	}

	const fills = new Map<string, FillSlot[][]>();
	const clipIds = new Set<string>();
	for (const [beat, tracks] of Object.entries(resp.fills)) {
		if (!Array.isArray(tracks)) {
			problems.push(`beat「${beat}」：轨列表不是数组`);
			continue;
		}
		// ★ 空轨占位：track_index 由数组位置决定，压掉一条后面全体前移一位，
		//   落轨落到错的轨上而字节照样合法。故轨数必须**恰好**等于请求的 lay。
		if (tracks.length !== expectedLay) {
			problems.push(
				`beat「${beat}」：轨数 ${tracks.length} ≠ 请求的 ${expectedLay} —— ` +
					"空轨占位必须保留（track_index 按数组位置定，压一条后面全体错位)",
			);
		}
		const outTracks: FillSlot[][] = [];
		tracks.forEach((slots, ti) => {
			if (!Array.isArray(slots)) {
				problems.push(`beat「${beat}」轨 ${ti}：槽位列表不是数组`);
				outTracks.push([]);
				return;
			}
			slots.forEach((s, si) => checkSlot(s, `beat「${beat}」轨 ${ti} 槽 ${si}`, problems));
			// 浅拷贝成**可写**对象：图片运镜后置补丁会就地改写它们两次
			const copied = slots.map((s) => ({ ...s }) as FillSlot);
			for (const s of copied) if (typeof s.clip_id === "string") clipIds.add(s.clip_id);
			outTracks.push(copied);
		});
		fills.set(beat, outTracks);
	}

	// 服务端回显的 clip_ids 只作**交叉校验**，不作真值：真值是槽位里实际出现的那些。
	// 两者不一致说明产物内部自相矛盾，属结构违约。
	if (Array.isArray(resp.clip_ids)) {
		const echoed = new Set(resp.clip_ids);
		const missing = [...clipIds].filter((id) => !echoed.has(id));
		const extra = [...echoed].filter((id) => !clipIds.has(id));
		if (missing.length || extra.length) {
			problems.push(
				`clip_ids 回显与槽位实际取用不一致（槽位有而回显缺：${missing.join(",") || "无"}；` +
					`回显有而槽位无：${extra.join(",") || "无"}）`,
			);
		}
	}

	const stats = resp.stats;
	if (!stats || typeof stats !== "object") {
		problems.push("缺 stats");
	} else {
		for (const k of [
			"emptySlots",
			"adjacentWaived",
			"pinnedPlaced",
			"emptySlotsByRefine",
			"hotSlotsPlaced",
			"blurrySlotsPlaced",
			"pinnedYielded",
		] as const) {
			if (!FINITE(stats[k])) problems.push(`stats.${k} 缺失或不是数字`);
		}
	}

	if (!resp.pinned || !Array.isArray(resp.pinned.requested) || !Array.isArray(resp.pinned.yielded)) {
		problems.push("缺 pinned.requested / pinned.yielded（让位名单要指名，MUST NOT 只给计数）");
	}
	if (!Array.isArray(resp.anchors)) problems.push("缺 anchors 数组（无锚时应为空数组，不是缺席）");
	// 降级 MUST NOT 静默：degraded 锚必须带 reason（人读告警与机读诊断共用同一份）
	for (const a of resp.anchors ?? []) {
		if (a?.status === "degraded" && !a.reason) {
			problems.push(`锚「${a.keyword}」降级但没给 reason —— 降级 MUST NOT 静默`);
		}
	}
	// 条件键：在册就必须形态完整（缺席是合法的，半截不是）
	if (resp.cut_align !== undefined) {
		for (const k of ["target", "starts_total", "aligned", "ratio"] as const) {
			if (!FINITE(resp.cut_align[k])) problems.push(`cut_align.${k} 缺失或不是数字`);
		}
	}

	if (problems.length) throw new ArrangeResponseInvalid(problems);

	return {
		fills,
		clipIds,
		stats: { ...stats },
		pinnedOutcome: { requested: [...resp.pinned.requested], yielded: [...resp.pinned.yielded] },
		markStats: { ...resp.mark_stats },
		anchors: resp.anchors.map((a) => ({ ...a })),
		...(resp.cut_align ? { cutAlign: { ...resp.cut_align } } : {}),
		...(resp.gap_fills ? { gapFills: resp.gap_fills.map((g) => ({ ...g })) } : {}),
	};
}

/**
 * shadow 期对拍（P2.3）：本地产物 vs 服务端产物，**只 diff 上报不切流**。
 *
 * 返回逐条差异描述（空数组 = 逐字节一致）。比的是**槽位时码**——那是唯一真决策产物，
 * 也是「跨语言静默不等价」唯一会显形的地方（不崩、不报错，只是切点全变）。
 */
export function diffArrangeOutcome(local: ArrangeOutcome, remote: ArrangeOutcome): string[] {
	const diffs: string[] = [];
	const lb = [...local.fills.keys()];
	const rb = [...remote.fills.keys()];
	if (JSON.stringify(lb) !== JSON.stringify(rb)) {
		diffs.push(`beat 集合/顺序不同：本地 [${lb.join(",")}] vs 服务端 [${rb.join(",")}]`);
		return diffs; // beat 对不上，逐槽比没有意义
	}
	for (const beat of lb) {
		const lt = local.fills.get(beat) ?? [];
		const rt = remote.fills.get(beat) ?? [];
		if (lt.length !== rt.length) {
			diffs.push(`beat「${beat}」轨数不同：本地 ${lt.length} vs 服务端 ${rt.length}`);
			continue;
		}
		for (let ti = 0; ti < lt.length; ti++) {
			const a = lt[ti] ?? [];
			const b = rt[ti] ?? [];
			if (a.length !== b.length) {
				diffs.push(`beat「${beat}」轨 ${ti} 槽位数不同：本地 ${a.length} vs 服务端 ${b.length}`);
				continue;
			}
			for (let si = 0; si < a.length; si++) {
				const x = JSON.stringify(a[si]);
				const y = JSON.stringify(b[si]);
				if (x !== y) diffs.push(`beat「${beat}」轨 ${ti} 槽 ${si}：\n    本地 ${x}\n    服务 ${y}`);
			}
		}
	}
	if (local.stats.emptySlots !== remote.stats.emptySlots) {
		diffs.push(`留空槽位数不同：本地 ${local.stats.emptySlots} vs 服务端 ${remote.stats.emptySlots}`);
	}
	return diffs;
}
