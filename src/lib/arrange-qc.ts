/**
 * 编排期 QC —— L2 lead 句画音对齐闭环（change: add-broll-arrange-atom P3.2）。
 *
 * 主理人 2026-08-29 拍板「渲后 QC 太重，收敛前移」：把「铺完 → 渲 → 看 → 重铺 → 再渲」
 * 那个两轮环，收成**落轨之前**的一个闭环。全程零渲染。
 *
 * 判什么：只查 **lead 句**（七三开的卡点句 = 各 beat 的 `span.from`）。跟随句是抽象/数字/
 * 修辞句，蹭领衔镜头保节奏自然，其 partial/mismatch 属设计非缺陷——判它们只是烧钱。
 *
 * 怎么修：mismatch ⇒ 把那个 (clip, segment) 对**从 plan 里删掉**再重编排一次。
 * 这不是新机制：`segments` 删段本来就在 plan 可编辑通路的白名单里
 * （见 `matrix.ts` 的「plan 可编辑面」注释）。所以「重铺」= 做一次合法的 plan 编辑再跑一遍，
 * 决策层一个字节都不用改。
 *
 * ## ★ 轮数硬上限（主理人 260829 拍板：打回重做必须有上限，不得死循环）
 *
 * `MAX_QC_ROUNDS = 2`。到限即**交付 + 残余 mismatch 如实登记**——不硬卡（用户还要交片）、
 * 不静默（他有权知道哪几句没对上）。测试里锁死「循环不可达」：即使每一轮都判 mismatch，
 * 判定次数也恒 ≤ 上限。
 *
 * ## ★ 架构：判定在客户端编排，不塞进 broll_arrange 原子
 *
 * design §4 的传输**建议**（原文是「拍板建议（v1）」，不在 §8 已拍板台账里）是单往返：
 * 客户端预抽 lead beat top-3 候选帧随请求上行，服务端内部完成铺→判→重铺。
 * 落地时改成**客户端编排两个既有端点**（`broll_arrange` 铺 + `material_describe` 判），
 * 三条理由：
 *
 * 1. **保住原子的纯粹性**。`utils/.../broll_arrange` 是纯 stdlib、零 IO、26 份金样跨语言
 *    逐字节对拍的包。把 VLM 往返塞进去，零 IO 没了，而 QC 那一支因为 VLM 不确定性
 *    **再也无法被金样覆盖**——等于用一个不可对拍的分支污染一个可对拍的包。
 * 2. **用户少花钱**。单往返要为 top-3 候选**全部**预抽预判，而其中至少两个永远不会被选中；
 *    describe 是**按张计费**的。客户端编排只判真正落在时间线上的那一帧。
 * 3. **没有新协议**。两个端点都已存在、都已计费、都已上线口径明确。design 担心的
 *    「多轮往返协议复杂」在这里不成立——复杂度全在客户端的一个 for 循环里。
 *
 * 代价是多几个来回的延迟（每轮 arrange + describe 两跳）。相对抽帧与 VLM 本身的耗时可忽略。
 */

import { createHash } from "node:crypto";

/** 轮数硬上限。**MUST NOT 提高它来「多修几轮」**——上限的意义是「一定会停」，不是「够用」。 */
export const MAX_QC_ROUNDS = 2;

/** 判定结论（与既有 alignment-qc 同一套词表，人读文案与报表可直接复用）。 */
export type QcVerdict = "match" | "partial" | "mismatch";

/** lead 句：卡点句（beat 领衔句，画面为它而挑）。 */
export interface LeadSentence {
	/** utterance id（= 该 beat 的 `span.from`）。 */
	id: string;
	/** 稿句原文——判定的 claim 本体。 */
	text: string;
	/** 成片轴上的句中点（秒）：据它找覆盖它的槽位。 */
	track_mid: number;
	/** 所属 beat（诊断用；一个 beat 一句 lead）。 */
	beat: string;
}

/** 一次判定请求（抽帧位已由槽位换算好）。 */
export interface QcProbe {
	beat: string;
	sentenceId: string;
	sentence: string;
	clipId: string;
	/** 素材内抽帧时刻（秒）。 */
	sourceSec: number;
	/** 该槽位取用的段起点——重编排时要删的就是这一段（不是整条素材）。 */
	segStart: number;
}

export interface QcJudgement {
	verdict: QcVerdict;
	reason?: string;
	frame_desc?: string;
}

/** 判定缓存（键 = material_id + ts_ms + claim 哈希）。注入以便测试与换实现。 */
export interface QcCache {
	get(clipId: string, tsMs: number, claimHash: string): QcJudgement | undefined;
	put(clipId: string, tsMs: number, claimHash: string, j: QcJudgement): void;
}

/** 稿句 → claim 哈希。改稿即失效；同一份稿重跑一次判定都不烧。 */
export function claimHash(sentence: string): string {
	return createHash("sha256").update(sentence.normalize("NFC")).digest("hex").slice(0, 32);
}

/** 槽位形态（只取本模块要读的字段，避免把决策层类型拖进来）。 */
export interface QcSlot {
	clip_id: string;
	clip_st: number;
	clip_ed: number;
	track_st: number;
	track_ed: number;
}

/**
 * 给一句 lead 找它落在哪个槽位上，并换算抽帧位。
 *
 * 抽帧位 = `clip_st + (句中点 − track_st)` —— 也就是**这句话说到一半时，观众正看到源片的哪一帧**。
 * 只看首轨（trackOrder 0）：那是默认可见的主候选轨，用户看到的就是它。
 */
export function probeFor(lead: LeadSentence, slots: QcSlot[]): QcProbe | null {
	const s = slots.find((x) => x.track_st <= lead.track_mid && lead.track_mid < x.track_ed);
	if (!s) return null; // 该句区间没铺到东西（留空/黑底）——不是 mismatch，是没得判
	return {
		beat: lead.beat,
		sentenceId: lead.id,
		sentence: lead.text,
		clipId: s.clip_id,
		sourceSec: Math.round((s.clip_st + (lead.track_mid - s.track_st)) * 1000) / 1000,
		segStart: s.clip_st,
	};
}

/** plan 的最小可写形态（本模块只删段，不碰别的）。 */
interface QcPlanLike {
	beats: Array<{
		beat: string;
		queries?: Array<{ results?: Array<{ clip_id: string; segments?: Array<{ start: number; end: number }> }> }>;
	}>;
}

/**
 * 从 plan 里删掉一个 (clip, 覆盖 sourceSec 的段) 对 —— 「重铺」的全部实现。
 *
 * ⚠️ 删的是**段**不是整条素材：同一条素材的别的段可能完全对得上，
 * 整条踢掉会把好料一起扔了，而候选稀疏的工程本来就没多少料可用。
 *
 * 返回是否真的删到了东西——删不到就别再跑一轮（否则会拿同一份 plan 铺出同一个结果，
 * 白烧一轮判定，且循环会「看起来在推进」实际原地踏步）。
 */
export function dropSegment<T extends QcPlanLike>(plan: T, clipId: string, sourceSec: number): { plan: T; dropped: boolean } {
	const next = JSON.parse(JSON.stringify(plan)) as T;
	let dropped = false;
	for (const b of next.beats) {
		for (const q of b.queries ?? []) {
			for (const r of q.results ?? []) {
				if (r.clip_id !== clipId || !Array.isArray(r.segments)) continue;
				const before = r.segments.length;
				r.segments = r.segments.filter((sg) => !(sg.start <= sourceSec && sourceSec <= sg.end));
				if (r.segments.length !== before) dropped = true;
			}
		}
	}
	return { plan: next, dropped };
}

export interface QcRoundRecord {
	round: number;
	judged: number;
	/** 本轮被判 mismatch 的探针（已按 beat 去重：一个 beat 一句 lead）。 */
	mismatched: QcProbe[];
	/** 本轮判定里有多少条是缓存命中（没烧钱的那些）。 */
	cacheHits: number;
}

export interface QcOutcome<O> {
	/** 最终采纳的编排产物。 */
	outcome: O;
	/** 最终采纳的 plan（可能已被删过段——它是「为什么长这样」的证据，MUST 随产物一起交出去）。 */
	plan: unknown;
	/** 实跑轮数（0 = 首轮就全过，没进过修复循环）。 */
	rounds: number;
	roundRecords: QcRoundRecord[];
	/** ★ 到限仍未修好的残余 —— **如实登记，不硬卡不静默**。 */
	residual: QcProbe[];
	/** 触到轮数上限（残余非空且是因为到限才停的）。 */
	hitRoundCap: boolean;
}

export interface QcDeps<O> {
	/** 跑一次编排（本地或云端都行——本模块不关心，闭环对两条路一样成立）。 */
	arrange: (plan: unknown) => Promise<O>;
	/** 从产物里取首轨槽位（不同产物形态由调用方适配）。 */
	slotsOf: (outcome: O) => QcSlot[];
	/** 批量判定（抽帧 + VLM claims）。返回顺序与入参一一对位。 */
	judge: (probes: QcProbe[]) => Promise<QcJudgement[]>;
	cache?: QcCache;
	log?: { info: (m: string) => void; warn: (m: string) => void };
}

const NOOP_LOG = { info: () => {}, warn: () => {} };

/**
 * 跑编排期 QC 闭环。
 *
 * 循环结构上不可能超过 `MAX_QC_ROUNDS`：`for` 的上界是常量、体内无 `continue` 回退、
 * 唯一的提前退出是「全过」或「没段可删」。这条**由测试锁死**——就算每轮都判 mismatch，
 * 判定调用次数也恒 ≤ 上限。
 */
export async function runArrangeQc<O>(
	plan: unknown,
	leads: LeadSentence[],
	deps: QcDeps<O>,
): Promise<QcOutcome<O>> {
	const log = deps.log ?? NOOP_LOG;
	let curPlan = plan;
	let outcome = await deps.arrange(curPlan);
	const roundRecords: QcRoundRecord[] = [];
	let residual: QcProbe[] = [];
	let hitRoundCap = false;

	if (leads.length === 0) {
		// 没有 lead 句（无 dispatch / 全是引用段）——不是「过了」，是没得判。如实回 0 轮。
		return { outcome, plan: curPlan, rounds: 0, roundRecords, residual, hitRoundCap };
	}

	for (let round = 0; round < MAX_QC_ROUNDS; round++) {
		const slots = deps.slotsOf(outcome);
		const probes = leads.map((l) => probeFor(l, slots)).filter((p): p is QcProbe => p !== null);
		if (probes.length === 0) {
			// lead 句区间一颗都没铺到（全留空/黑底）——没得判，不是通过
			log.info("编排期 QC：卡点句区间没有已铺槽位，本轮无可判定项。");
			break;
		}

		// 缓存先行：命中的不烧钱、不发请求
		const cached = probes.map((p) => deps.cache?.get(p.clipId, Math.round(p.sourceSec * 1000), claimHash(p.sentence)));
		const need = probes.filter((_, i) => cached[i] === undefined);
		const fresh = need.length ? await deps.judge(need) : [];
		if (fresh.length !== need.length) {
			throw new Error(`编排期 QC 判定条数不对位（要判 ${need.length} 条，回了 ${fresh.length} 条）`);
		}
		let k = 0;
		const judgements = probes.map((p, i) => {
			const hit = cached[i];
			if (hit) return hit;
			const j = fresh[k++]!;
			deps.cache?.put(p.clipId, Math.round(p.sourceSec * 1000), claimHash(p.sentence), j);
			return j;
		});

		const mismatched = probes.filter((_, i) => judgements[i]!.verdict === "mismatch");
		roundRecords.push({
			round,
			judged: probes.length,
			mismatched,
			cacheHits: cached.filter((c) => c !== undefined).length,
		});

		if (mismatched.length === 0) {
			log.info(`编排期 QC：卡点句 ${probes.length} 句全部对得上（第 ${round + 1} 轮，零渲染）。`);
			residual = [];
			break;
		}

		// 到限：交付 + 残余如实登记（不硬卡：用户还要交片；不静默：他有权知道哪几句没对上）
		if (round === MAX_QC_ROUNDS - 1) {
			residual = mismatched;
			hitRoundCap = true;
			break;
		}

		// 删段重铺。删不到就停——否则会拿同一份 plan 铺出同一个结果，白烧一轮判定
		let nextPlan = curPlan;
		let anyDropped = false;
		for (const m of mismatched) {
			const r = dropSegment(nextPlan as QcPlanLike, m.clipId, m.sourceSec);
			nextPlan = r.plan;
			anyDropped = anyDropped || r.dropped;
		}
		if (!anyDropped) {
			log.warn(`编排期 QC：${mismatched.length} 句没对上，但对应的候选段在 plan 里找不到、无从替换——本轮如实登记，不再空转。`);
			residual = mismatched;
			break;
		}
		log.info(`编排期 QC：${mismatched.length} 句没对上，换候选重排（第 ${round + 2} 轮 / 上限 ${MAX_QC_ROUNDS}）。`);
		curPlan = nextPlan;
		outcome = await deps.arrange(curPlan);
	}

	if (residual.length) {
		const detail = residual.map((p) => `「${p.sentence}」(${p.beat})`).join("、");
		log.warn(
			`编排期 QC：${residual.length} 句卡点句到${hitRoundCap ? `轮数上限（${MAX_QC_ROUNDS} 轮）` : "可换候选用尽时"}仍未对上，` +
				`已如实登记、工程照常交付：${detail}\n` +
				"——这几句的画面没给到稿子说的东西。可换个检索词重跑，或在 plan 里手动挑一条候选。",
		);
	}

	return { outcome, plan: curPlan, rounds: roundRecords.length, roundRecords, residual, hitRoundCap };
}
