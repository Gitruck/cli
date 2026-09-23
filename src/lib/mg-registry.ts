/**
 * Hyperframes registry 快照读取 / 检索 / 三源取块（change add-mg-registry-neutral-source · design D1 / D3）。
 *
 * - 快照随包（`src/data/mg-registry-catalog.json`，发版期脚本 `scripts/mg-registry-snapshot.mjs` 产），钉死来源 commit；
 *   候选态**离线可用**，只有取块态需要网络。
 * - 取块三源顺序 = 我方镜像（大陆可达）→ jsdelivr GitHub 镜像 → GitHub raw；每源超时 5 s、失败即下一源；
 *   任一源返回的字节 MUST 过 sha256（与快照一致）——版本错位 / 篡改在这里被拒。
 * - **不引 hyperframes CLI**：端点是静态文件，Node 内置 fetch 足够（33 MB + 原生二进制 + Node ≥22 的用户侧负担省掉）。
 * - `GITRUCK_MG_REGISTRY_BASE` 整体覆盖取块前缀（自建端点 / 内网），与 runtime-assets 的 env 覆盖同形。
 */
import { createHash } from "node:crypto";
import snapshot from "../data/mg-registry-catalog.json";
import type { Compat } from "./mg-adopt";

export const MIRROR_ROOT = "https://api.ai-mcn.tv:9000/broadcast/mg-registry";
export const SOURCE_TIMEOUT_MS = 5000;

export interface SnapshotFile {
	path: string;
	sha256: string;
	bytes: number;
}
export interface SnapshotItem {
	name: string;
	title: string;
	description: string;
	tags: string[];
	width: number;
	height: number;
	duration: number | null;
	stability?: string;
	preview: { poster?: string; video?: string };
	params?: unknown[];
	files: SnapshotFile[];
	compat: Compat;
	compat_reasons: string[];
}
export interface SnapshotMirror {
	id: string;
	base: string;
}
export interface RegistrySnapshot {
	schema: number;
	source: { repo: string; commit: string; snapshot_date: string; registry_path: string };
	mirrors: SnapshotMirror[];
	items: SnapshotItem[];
}

export function loadSnapshot(): RegistrySnapshot {
	return snapshot as RegistrySnapshot;
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 中文检索词 → registry 英文 tag / 标题词的小同义表（检索打分用，不求全）。 */
const ZH_SYNONYMS: Record<string, string[]> = {
	数据: ["data", "chart", "statistics", "graph"],
	图表: ["chart", "graph", "bar", "line"],
	统计: ["statistics", "data", "chart"],
	排行: ["race", "ranking", "leaderboard", "bar"],
	标题: ["title", "headline", "intro"],
	字幕: ["caption", "subtitle", "captions"],
	字条: ["lower-third", "lower", "third"],
	转场: ["transition", "transitions", "wipe"],
	通知: ["notification", "toast", "alert"],
	聊天: ["chat", "message", "thread"],
	消息: ["message", "chat", "thread"],
	代码: ["code", "terminal", "snippet"],
	终端: ["terminal", "code"],
	地图: ["map", "route", "flight"],
	路线: ["route", "map", "flight"],
	手写: ["handwriting", "hw", "scribble", "write"],
	手绘: ["handwriting", "hw", "scribble", "sketch"],
	卡片: ["card", "post"],
	社交: ["social", "instagram", "tiktok", "x", "youtube", "reddit"],
	倒计时: ["countdown", "timer"],
	进度: ["progress", "stat", "loading"],
	背景: ["background", "backdrop", "gradient"],
	粒子: ["particle", "particles"],
	光: ["light", "glow", "leak", "flare"],
	故障: ["glitch", "distortion"],
	玻璃: ["glass", "liquid"],
	流程: ["flowchart", "pipeline", "diagram", "flow"],
	图解: ["diagram", "flowchart", "pipeline"],
	新闻: ["news", "ticker", "editorial"],
	引用: ["quote", "callout"],
	列表: ["list", "specs", "stack"],
	相册: ["gallery", "carousel", "photo"],
	轮播: ["carousel", "gallery"],
	设备: ["device", "iphone", "macos", "ios"],
	品牌: ["logo", "brand", "intro", "outro"],
	片头: ["intro", "logo", "title"],
	片尾: ["outro", "logo"],
	数字: ["count", "counter", "stat", "number"],
	价格: ["money", "price", "count"],
	三维: ["3d", "extrude", "orbit"],
	科幻: ["shader", "sci-fi", "warp", "space"],
	星空: ["space", "galaxy", "stars", "cosmic"],
};

function tokens(q: string): string[] {
	const raw = q.toLowerCase().split(/[\s,，、/|]+/).filter(Boolean);
	const out = new Set<string>();
	for (const t of raw) {
		out.add(t);
		for (const [zh, en] of Object.entries(ZH_SYNONYMS)) {
			if (t.includes(zh)) for (const e of en) out.add(e);
		}
	}
	return [...out];
}

export interface ScoredBlock {
	item: SnapshotItem;
	score: number;
	hits: string[];
}

/**
 * 候选检索：name 精确 > tag 精确 > 标题词 > 描述词。缺省只列 `ok / review`；`excluded` 不进候选。
 * 零网络（快照足够）。
 */
export function searchBlocks(query: string, snap: RegistrySnapshot = loadSnapshot(), opts: { top?: number; includeExcluded?: boolean } = {}): ScoredBlock[] {
	const top = opts.top ?? 3;
	const ts = tokens(query);
	if (ts.length === 0) return [];
	const scored: ScoredBlock[] = [];
	for (const item of snap.items) {
		if (!opts.includeExcluded && item.compat === "excluded") continue;
		let score = 0;
		const hits: string[] = [];
		const name = item.name.toLowerCase();
		const tags = item.tags.map((t) => t.toLowerCase());
		const title = item.title.toLowerCase();
		const desc = item.description.toLowerCase();
		for (const t of ts) {
			if (name === t) {
				score += 100;
				hits.push(`name=${t}`);
			} else if (name.includes(t)) {
				score += 20;
				hits.push(`name~${t}`);
			}
			if (tags.includes(t)) {
				score += 10;
				hits.push(`tag:${t}`);
			}
			if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(title)) {
				score += 5;
				hits.push(`title:${t}`);
			}
			if (desc.includes(t)) {
				score += 2;
				hits.push(`desc:${t}`);
			}
		}
		if (score > 0) scored.push({ item, score, hits });
	}
	scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
	return scored.slice(0, top);
}

export function findBlock(name: string, snap: RegistrySnapshot = loadSnapshot()): SnapshotItem | undefined {
	const key = name.trim().toLowerCase();
	return snap.items.find((i) => i.name.toLowerCase() === key);
}

/** 某文件的候选 URL（按镜像顺序）；`GITRUCK_MG_REGISTRY_BASE` 设了则只用它。 */
export function blockFileUrls(snap: RegistrySnapshot, item: SnapshotItem, file: SnapshotFile, env: NodeJS.ProcessEnv = process.env): { id: string; url: string }[] {
	const rel = `blocks/${item.name}/${file.path}`;
	const override = env.GITRUCK_MG_REGISTRY_BASE?.trim();
	if (override) return [{ id: "override", url: `${override.replace(/\/+$/, "")}/${rel}` }];
	return snap.mirrors.map((m) => ({ id: m.id, url: `${m.base.replace(/\/+$/, "")}/${rel}` }));
}

export interface FetchAttempt {
	id: string;
	url: string;
	ok: boolean;
	reason?: string;
	ms: number;
}
export interface FetchBlockResult {
	html: string;
	source: string;
	url: string;
	attempts: FetchAttempt[];
}
export interface FetchDeps {
	fetch?: typeof fetch;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

/**
 * 三源取块 + sha256 强校验。三源全失败 ⇒ 抛错并逐源列原因（调用方 MUST NOT 落半成品）。
 */
export async function fetchBlockFile(snap: RegistrySnapshot, item: SnapshotItem, file: SnapshotFile, deps: FetchDeps = {}): Promise<FetchBlockResult> {
	const f = deps.fetch ?? fetch;
	const timeoutMs = deps.timeoutMs ?? SOURCE_TIMEOUT_MS;
	const attempts: FetchAttempt[] = [];
	for (const { id, url } of blockFileUrls(snap, item, file, deps.env)) {
		const t0 = Date.now();
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		try {
			const r = await f(url, { signal: ac.signal });
			if (!r.ok) {
				attempts.push({ id, url, ok: false, reason: `HTTP ${r.status}`, ms: Date.now() - t0 });
				continue;
			}
			const html = await r.text();
			const got = sha256Hex(html);
			if (got !== file.sha256) {
				attempts.push({ id, url, ok: false, reason: `sha256 不符（期望 ${file.sha256.slice(0, 12)}… 实得 ${got.slice(0, 12)}…）`, ms: Date.now() - t0 });
				continue;
			}
			attempts.push({ id, url, ok: true, ms: Date.now() - t0 });
			return { html, source: id, url, attempts };
		} catch (e) {
			const msg = e instanceof Error ? (e.name === "AbortError" ? `超时 ${timeoutMs}ms` : e.message) : String(e);
			attempts.push({ id, url, ok: false, reason: msg, ms: Date.now() - t0 });
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error(
		`取块失败（${item.name}/${file.path}），三源皆不可用：\n${attempts.map((a) => `  - [${a.id}] ${a.url} → ${a.reason ?? "?"}（${a.ms}ms）`).join("\n")}`,
	);
}

/** 取块的主 HTML 文件（块 MUST 单文件，预筛已保证；取第一个 .html）。 */
export function primaryFile(item: SnapshotItem): SnapshotFile {
	const f = item.files.find((x) => /\.html?$/i.test(x.path)) ?? item.files[0];
	if (!f) throw new Error(`快照条目 ${item.name} 无文件`);
	return f;
}
