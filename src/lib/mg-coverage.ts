/**
 * MG 覆盖读数（纯函数，零 IO）——报「派了多少、空了多少」（openspec: add-mg-coverage-report）。
 *
 * ## 立题
 *
 * 2026-09-20 实测：一条 **537 秒**的片子，`split` 的 mg 队列只派了 **4 个、全在前 34 秒**，
 * 后面 **500 秒一个都没有**。照单全收就会交付一条「只有开头有 MG」的片子。
 *
 * 这**未必是 bug**——拆分可能有意只在强结构处派单。但此前**没有任何提示**说后段没覆盖，
 * 调用方（尤其自动接力的 agent）拿到队列就铺、铺完报「N 颗全部成功」，空档无人知晓。
 *
 * ## 射程：只给事实，MUST NOT 判定
 *
 * 本模块**不设阈值、不做好坏判断、不影响退出码**。它只回答「覆盖了哪些区间、空了哪些」，
 * 要不要补由人或 agent 决定。设阈值就会变成又一个要调参的告警源。
 */

import { r3 } from "./frame-domain";

export interface CoverageSpan {
	st: number;
	ed: number;
}

export interface CoverageReport {
	/** 全片时长（秒）。 */
	total_sec: number;
	/** 被 MG 覆盖的总时长（重叠已合并，不重复计）。 */
	covered_sec: number;
	/** 覆盖占比 0..1。 */
	ratio: number;
	/** 合并后的覆盖区间。 */
	spans: CoverageSpan[];
	/** 空档（未被覆盖的区间）。 */
	gaps: CoverageSpan[];
	/** 最长的那个空档；全覆盖时为 null。 */
	max_gap: CoverageSpan | null;
}

/** 忽略这么短的空档（秒）：颗粒之间的毫秒级缝隙不是「没覆盖」。 */
const MIN_GAP_SEC = 0.5;

/**
 * 算覆盖。
 *
 * @param items 条目的轨上区间。**重叠会被合并**——aux 派生颗粒与主 beat 常有重叠，
 *   不合并会把覆盖率算过 100%。
 * @param totalSec 全片时长。≤0 时返回零覆盖（无从计算占比，MUST NOT 编一个）。
 */
export function mgCoverage(
	items: ReadonlyArray<{ track_st?: number; track_ed?: number }>,
	totalSec: number,
): CoverageReport {
	const empty: CoverageReport = {
		total_sec: r3(Math.max(0, totalSec)),
		covered_sec: 0,
		ratio: 0,
		spans: [],
		gaps: totalSec > 0 ? [{ st: 0, ed: r3(totalSec) }] : [],
		max_gap: totalSec > 0 ? { st: 0, ed: r3(totalSec) } : null,
	};
	if (!(totalSec > 0)) return empty;

	const raw = items
		.map((it) => ({ st: Number(it.track_st ?? 0), ed: Number(it.track_ed ?? 0) }))
		.filter((s) => Number.isFinite(s.st) && Number.isFinite(s.ed) && s.ed > s.st)
		.sort((a, b) => a.st - b.st);
	if (!raw.length) return empty;

	// 合并重叠/相接的区间
	const spans: CoverageSpan[] = [];
	let cur = { st: raw[0].st, ed: raw[0].ed };
	for (const s of raw.slice(1)) {
		if (s.st <= cur.ed) cur.ed = Math.max(cur.ed, s.ed);
		else {
			spans.push({ st: r3(cur.st), ed: r3(cur.ed) });
			cur = { st: s.st, ed: s.ed };
		}
	}
	spans.push({ st: r3(cur.st), ed: r3(cur.ed) });

	const covered = spans.reduce((acc, s) => acc + (s.ed - s.st), 0);

	// 空档：片头、区间之间、片尾
	const gaps: CoverageSpan[] = [];
	const push = (st: number, ed: number) => {
		if (ed - st >= MIN_GAP_SEC) gaps.push({ st: r3(st), ed: r3(ed) });
	};
	push(0, spans[0].st);
	for (let i = 0; i < spans.length - 1; i++) push(spans[i].ed, spans[i + 1].st);
	push(spans[spans.length - 1].ed, totalSec);

	let maxGap: CoverageSpan | null = null;
	for (const g of gaps) if (!maxGap || g.ed - g.st > maxGap.ed - maxGap.st) maxGap = g;

	return {
		total_sec: r3(totalSec),
		covered_sec: r3(covered),
		ratio: r3(covered / totalSec),
		spans,
		gaps,
		max_gap: maxGap,
	};
}

/**
 * 说不说话的判据：**最长空档占全片的比例**，不是覆盖率。
 *
 * ⚠️ 这一条是实测定的，别改回覆盖率：MG 颗粒天生稀疏（每颗 2–3 秒），
 * 12 颗均匀铺满一条 543 秒的片子也只有 **6%** 覆盖率——
 * 按覆盖率说话会**恒为真**，变成噪声而不是信号。
 * 而「最长空档」分得开两种形态：派歪了（全挤前 34 秒）是 **94%**，铺匀了是 **22%**。
 */
const LOUD_MAX_GAP_RATIO = 0.35;

/**
 * 人读一行。**空档不长时返回 null**（MUST NOT 刷屏）。
 *
 * 阈值只用于「说不说话」，**不用于判定好坏**——它不改退出码、不升级为告警、不拦截。
 * 完整读数恒在 `--json` 回执里，agent 自行决定要不要补。
 */
export function coverageLine(c: CoverageReport, loudMaxGapRatio = LOUD_MAX_GAP_RATIO): string | null {
	const g = c.max_gap;
	if (!g || !(c.total_sec > 0)) return null;
	const gapLen = g.ed - g.st;
	if (gapLen / c.total_sec < loudMaxGapRatio) return null;
	const pct = ((gapLen / c.total_sec) * 100).toFixed(0);
	return (
		`MG 有一段 ${r3(gapLen)}s 没有覆盖（${g.st}–${g.ed}s，占全片 ${pct}%）` +
		`；全片 ${c.total_sec}s、已派 ${c.spans.length} 段` +
		(c.gaps.length > 1 ? `、另有 ${c.gaps.length - 1} 处较短空档` : "")
	);
}
