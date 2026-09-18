/**
 * BGM 选曲历史（adjust-bgm-selection-freshness）——治「无论什么题材都来回那几首」。
 *
 * 机制而非纪律：**`gtrk audio lay` 落轨即记账**（那才是「真的用了」的时刻，不靠 agent 记得写），
 * `gtrk matrix material --scope audio --exclude-recent` 读账自动避让近期用过的曲子。
 *
 * 身份口径=**标题归一化键**（而非矩阵 id）：落轨侧只有本地文件名（`bgm-StartsToday-伴奏.mp3`）、
 * 检索侧只有 title（`Starts Today`），两边都能归一到 `startstoday`；矩阵 id 若在场一并记，
 * 供将来精确匹配。归一化=转小写 + 去扩展名 + 剥 `bgm-` 前缀与伴奏/instrumental/off-vocal 等
 * 版本后缀 + 去非字母数字（中文按原样保留，日文/中文曲名同样可比）。
 *
 * 失败一律降级：历史文件读写失败绝不影响铺轨或检索（选曲新鲜度是锦上添花，不是硬门禁）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import { readJsonSync } from "./read-json";

export interface BgmUseEntry {
	/** 归一化标题键（去重主键）。 */
	key: string;
	/** 原始标题/文件名（人读）。 */
	title: string;
	/** 矩阵素材 id（有则记，供精确匹配）。 */
	id?: string;
	/** 使用时刻 ISO。 */
	at: string;
	/** 使用它的工程（人读定位，可空）。 */
	project?: string;
}

/** 历史保留条数上限（滚动淘汰最旧）。 */
const HISTORY_MAX = 100;
/** `--exclude-recent` 缺省避让条数。 */
export const EXCLUDE_RECENT_DEFAULT = 12;

/** 版本后缀（伴奏/纯音乐版等）：同一首歌的不同版本视为同一首，避免「换个伴奏版当新曲」。 */
const VERSION_SUFFIX = /(伴奏|off[-_ ]?vocal|instrumental|inst|karaoke|piano[-_ ]?version|light[-_ ]?ver|acoustic)/gi;

/** 标题/文件名 → 归一化去重键。 */
export function bgmKeyOf(raw: string): string {
	let s = raw.trim();
	if (/\.[a-z0-9]{2,4}$/i.test(s)) s = s.slice(0, s.length - extname(s).length);
	s = s.replace(/^bgm[-_ ]*/i, "");
	s = s.replace(VERSION_SUFFIX, "");
	// 括注版本信息（Light Ver.）与分隔符一并抹平；中日文字符保留（同名曲可比）
	s = s.replace(/[（(][^）)]*[）)]/g, "");
	return s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

function historyPath(): string {
	return join(homedir(), ".gitruck", "bgm-history.json");
}

export function readBgmHistory(path = historyPath()): BgmUseEntry[] {
	try {
		if (!existsSync(path)) return [];
		const raw = readJsonSync<{ entries?: unknown }>(path);
		if (!Array.isArray(raw.entries)) return [];
		return raw.entries.filter(
			(e): e is BgmUseEntry =>
				!!e && typeof (e as BgmUseEntry).key === "string" && typeof (e as BgmUseEntry).at === "string",
		);
	} catch {
		return []; // 损坏当空历史（下次写入自愈覆盖）——绝不因历史文件坏了挡住铺轨/检索
	}
}

/** 记一次使用（落轨侧调用）。同 key 复用时更新时刻并前置，不重复堆积。 */
export function recordBgmUse(
	args: { title: string; id?: string; project?: string },
	path = historyPath(),
): void {
	try {
		const key = bgmKeyOf(args.title);
		if (!key) return;
		const rest = readBgmHistory(path).filter((e) => e.key !== key);
		const entries = [
			{ key, title: args.title, ...(args.id ? { id: args.id } : {}), at: new Date().toISOString(), ...(args.project ? { project: args.project } : {}) },
			...rest,
		].slice(0, HISTORY_MAX);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ entries }, null, 1)}\n`, "utf-8");
	} catch {
		/* 记账失败静默：不影响本次铺轨（良性降级） */
	}
}

/** 从落轨文件路径记账（audio lay 用；basename 即标题线索）。 */
export function recordBgmUseFromFile(filePath: string, project?: string, path = historyPath()): void {
	recordBgmUse({ title: basename(filePath), project }, path);
}

/** 近期用过的键集合（检索侧避让用）。 */
export function recentBgmKeys(n: number = EXCLUDE_RECENT_DEFAULT, path = historyPath()): Set<string> {
	return new Set(readBgmHistory(path).slice(0, Math.max(0, n)).map((e) => e.key));
}

/**
 * 结果避让过滤（纯函数，可单测）：滤掉近期用过的曲子。
 * **宁可少滤不可滤空**：若过滤后一条不剩，返回原结果并置 `exhausted`，由调用方打提示——
 * 曲库小/避让窗过大时不能让用户拿到空手（选曲新鲜度让位于「有得选」）。
 */
export function filterRecentlyUsed<T extends { title?: string; id?: string }>(
	results: T[],
	recent: Set<string>,
): { kept: T[]; skipped: number; exhausted: boolean } {
	if (recent.size === 0 || results.length === 0) return { kept: results, skipped: 0, exhausted: false };
	const kept = results.filter((r) => !recent.has(bgmKeyOf(String(r.title ?? r.id ?? ""))));
	if (kept.length === 0) return { kept: results, skipped: 0, exhausted: true };
	return { kept, skipped: results.length - kept.length, exhausted: false };
}
