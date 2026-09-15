/**
 * 技法点名与目录检索（add-mad-technique-whitelist）。
 *
 * 分工：**语义匹配在 Agent 那头**，本模块只做纯字符串活——把用户/Agent 给的技法名、别名或 pid
 * 解析成 pid 集合（`resolveTechniques`），以及按关键词在名/别名/类目上做包含匹配（`searchTechniques`）。
 * MUST NOT 引入分词、向量或任何模型：tool-mad spec 的红线是「选择器是纯规则、零云端智能」，
 * 把「屏幕震一下」翻成「切点震屏冲击」是 Agent 的活。
 */
import type { CatalogPattern } from "./types";

/** 归一化：去首尾空白、全角空格转半角、拉丁字母小写。CJK 不做任何变换。 */
export function norm(s: string): string {
	return s.replace(/　/g, " ").trim().toLowerCase();
}

/** 拆分用户输入的技法列表（半角/全角逗号皆可，去空项）。 */
export function parseTechniqueList(raw: string): string[] {
	return raw
		.split(/[,，]/)
		.map((x) => x.trim())
		.filter((x) => x.length > 0);
}

export interface TechniqueMiss {
	/** 用户原样输入。 */
	input: string;
	/** 候选（≤10，按 n_seen 降序）。 */
	candidates: CatalogPattern[];
}

export interface ResolveResult {
	resolved: CatalogPattern[];
	/** 一项命中多个（歧义）。 */
	ambiguous: TechniqueMiss[];
	/** 一项一个都没命中。 */
	missing: TechniqueMiss[];
}

const MAX_CANDIDATES = 10;

function byNSeenDesc(a: CatalogPattern, b: CatalogPattern): number {
	return b.n_seen - a.n_seen;
}

/** 该条目的全部可匹配字面（技法名 + 别名），已归一。 */
function surfaces(p: CatalogPattern): string[] {
	return [p.pattern, ...p.aliases].map(norm).filter((x) => x);
}

/**
 * 近似候选：按「输入里的字符在候选字面中出现了几个」打分（CJK 上比编辑距离省事且够用），
 * 同分按 n_seen。一个字符都不沾边时退回频次榜——总比让用户对着空清单猜强。
 */
function nearest(patterns: CatalogPattern[], input: string): CatalogPattern[] {
	const chars = [...new Set(norm(input).split(""))].filter((c) => c.trim());
	const scored = patterns.map((p) => {
		const hay = surfaces(p).join(" ");
		const hit = chars.reduce((n, c) => n + (hay.includes(c) ? 1 : 0), 0);
		return { p, score: chars.length ? hit / chars.length : 0 };
	});
	const good = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || byNSeenDesc(a.p, b.p));
	if (good.length > 0) return good.slice(0, MAX_CANDIDATES).map((s) => s.p);
	return [...patterns].sort(byNSeenDesc).slice(0, MAX_CANDIDATES);
}

/**
 * 解析一批技法输入。解析次序：数字 pid → 精确技法名 → 精确别名 → 名/别名上的唯一子串。
 *
 * 歧义（子串命中多条）与未命中都**不自行挑一个**：挑了会出一条用户以为是别的东西的片，且不报错
 * ——静默兜底禁令。调用方拿到 ambiguous/missing 非空就该报错退出、零落盘。
 */
export function resolveTechniques(patterns: CatalogPattern[], inputs: string[]): ResolveResult {
	const resolved: CatalogPattern[] = [];
	const ambiguous: TechniqueMiss[] = [];
	const missing: TechniqueMiss[] = [];
	const seen = new Set<string>();

	const push = (p: CatalogPattern) => {
		if (seen.has(p.pid)) return; // 同一技法写两遍不算错，去重即可
		seen.add(p.pid);
		resolved.push(p);
	};

	for (const raw of inputs) {
		const q = norm(raw);
		if (!q) continue;

		if (/^\d+$/.test(q)) {
			const hit = patterns.find((p) => p.pid === String(Number(q)));
			if (hit) push(hit);
			else missing.push({ input: raw, candidates: [...patterns].sort(byNSeenDesc).slice(0, MAX_CANDIDATES) });
			continue;
		}

		const exactName = patterns.filter((p) => norm(p.pattern) === q);
		if (exactName.length === 1) {
			push(exactName[0]);
			continue;
		}
		if (exactName.length > 1) {
			ambiguous.push({ input: raw, candidates: exactName.sort(byNSeenDesc).slice(0, MAX_CANDIDATES) });
			continue;
		}

		const exactAlias = patterns.filter((p) => p.aliases.some((a) => norm(a) === q));
		if (exactAlias.length === 1) {
			push(exactAlias[0]);
			continue;
		}
		if (exactAlias.length > 1) {
			ambiguous.push({ input: raw, candidates: exactAlias.sort(byNSeenDesc).slice(0, MAX_CANDIDATES) });
			continue;
		}

		const sub = patterns.filter((p) => surfaces(p).some((s) => s.includes(q)));
		if (sub.length === 1) push(sub[0]);
		else if (sub.length > 1) ambiguous.push({ input: raw, candidates: sub.sort(byNSeenDesc).slice(0, MAX_CANDIDATES) });
		else missing.push({ input: raw, candidates: nearest(patterns, raw) });
	}

	return { resolved, ambiguous, missing };
}

export interface SearchHit {
	pattern: CatalogPattern;
	/** 该技法在当前技法池里的窗口数；0 = 不可点名（被池的过滤口径筛掉）。 */
	windows: number;
}

/**
 * 关键词检索：技法名 / 别名 / 类目三处任一包含即算命中，按 n_seen 降序。
 * 纯字符串包含，无分词无模型（见文件头）。
 */
export function searchTechniques(
	patterns: CatalogPattern[],
	keyword: string,
	windowCounts: Map<string, number>,
): SearchHit[] {
	const q = norm(keyword);
	if (!q) return [];
	return patterns
		.filter((p) => surfaces(p).some((s) => s.includes(q)) || norm(p.cat).includes(q))
		.sort(byNSeenDesc)
		.map((p) => ({ pattern: p, windows: windowCounts.get(p.pid) ?? 0 }));
}

/** 池里每个 pid 的窗口数（检索与「点名了但池内没有」的判据）。 */
export function poolWindowCounts(pool: { pid: string }[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const e of pool) {
		const k = String(e.pid);
		m.set(k, (m.get(k) ?? 0) + 1);
	}
	return m;
}

/** 候选清单的人读一行（报错与检索共用，口径一致）。 */
export function formatCandidate(p: CatalogPattern, windows?: number): string {
	const tail = windows == null ? "" : windows > 0 ? ` · 池内 ${windows} 个窗口` : " · 池内无窗口（不可点名）";
	return `${p.pattern}（${p.cat} · pid ${p.pid} · 收录 ${p.n_seen} 次${tail}）`;
}
