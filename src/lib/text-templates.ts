/**
 * 文字特效模板库：目录解析 / 检索 / 三源取块（change add-text-template-source）。
 *
 * 与中性块 registry（`mg-registry.ts`）是**两个来源**，共用取块与 sha256 校验的形状，
 * 但有两处刻意不同：
 *
 * 1. **不做机械改写**。中性块来自第三方、要改字体与色板才合规；文字模板是我方
 *    clean-room 重写的，改 HTML 反而会把它变成 `detached`（云端调不动）。
 * 2. **目录不钉死在包里**。主理人 2026-09-14 拍板：目录走三源镜像、按 `version` 择新，
 *    随包那份降级为**离线兜底**。第一批 38 颗只是开头，后续每追加一批都要 CLI 与
 *    客户端各发一次版才能看到，是不合理的耦合——扩批本身是零代码的纯写 IR 轮次。
 *
 * 信任边界仍然落在**每件的块 sha256** 上，MUST NOT 给目录再加一层签名：目录被换最多
 * 导致条目多几条少几条，正文一旦对不上 sha256 就拒，成本与收益不对等。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import packagedCatalog from "../data/text-template-catalog.json";
import { gitruckHome } from "./paths";
import { sha256Hex } from "./particle-identity";

export const MIRROR_ROOT = "https://api.ai-mcn.tv:9000/broadcast/text-templates";
export const SOURCE_TIMEOUT_MS = 5000;
/** 目录缓存有效期。面板/命令每次都打网没必要——模板批次是按天推的，不是按秒。 */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export interface TemplateFile {
	path: string;
	sha256: string;
	bytes: number;
}
export interface TextTemplateItem {
	/** composition_id，同时是块目录名。 */
	id: string;
	title: string;
	/** 家族号，如 F02。 */
	family: string;
	tags: string[];
	duration: number;
	/** 槽位键（用户可改的文字位）。 */
	slots: string[];
	poster?: string;
	file: TemplateFile;
	/** 内嵌 IR 的哈希，原样带出供比对，不重算（见 particle-identity 模块头注）。 */
	ir_sha256: string;
}
export interface CatalogMirror {
	id: string;
	base: string;
}
export interface TextTemplateCatalog {
	schema: number;
	/** 形如 `2026-09-14.1`。择新按数字段比较，不按字符串。 */
	version: string;
	generated_at: string;
	mirrors: CatalogMirror[];
	items: TextTemplateItem[];
}

/** 目录的来源，供 UI/CLI 明示「这是哪一版、从哪来的」。 */
export type CatalogOrigin = "remote" | "cache" | "packaged";

export interface ResolvedCatalog {
	catalog: TextTemplateCatalog;
	origin: CatalogOrigin;
	/** 非 remote 时说明为什么没拿到远端（断网 / 三源全挂 / 远端不比随包新）。 */
	reason?: string;
}

export function packaged(): TextTemplateCatalog {
	return packagedCatalog as TextTemplateCatalog;
}

function cachePath(): string {
	return join(gitruckHome(), "text-templates", "catalog.json");
}

/**
 * 版本比较：按数字段。`2026-09-14.10` MUST 比 `2026-09-14.9` 新——
 * 字符串比较在这里会判反，而判反的后果是新批次永远不被采用、还不报错。
 */
export function isNewer(a: string, b: string): boolean {
	const seg = (v: string) => v.split(/[^0-9]+/).filter(Boolean).map(Number);
	const xs = seg(a);
	const ys = seg(b);
	for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
		const x = xs[i] ?? 0;
		const y = ys[i] ?? 0;
		if (x !== y) return x > y;
	}
	return false;
}

function catalogUrls(env: NodeJS.ProcessEnv): { id: string; url: string }[] {
	const override = env.GITRUCK_TEXT_TEMPLATE_BASE?.trim();
	const bases = override
		? [{ id: "override", base: override }]
		: packaged().mirrors.map((m) => ({ id: m.id, base: m.base }));
	return bases.map(({ id, base }) => ({ id, url: `${base.replace(/\/+$/, "")}/catalog.json` }));
}

function isCatalog(value: unknown): value is TextTemplateCatalog {
	if (!value || typeof value !== "object") return false;
	const c = value as Partial<TextTemplateCatalog>;
	return typeof c.version === "string" && Array.isArray(c.items) && Array.isArray(c.mirrors);
}

export interface ResolveDeps {
	fetch?: typeof fetch;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/** 测试注入：缓存文件路径。 */
	cacheFile?: string;
	/** 跳过网络（候选态离线路径 / `--offline`）。 */
	offline?: boolean;
}

function readCache(file: string): { catalog: TextTemplateCatalog; fetched_at: number } | undefined {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (isCatalog(raw?.catalog) && typeof raw?.fetched_at === "number") return raw;
	} catch {
		/* 缓存坏了当没有——它是加速器不是真相源 */
	}
	return undefined;
}

function writeCache(file: string, catalog: TextTemplateCatalog, now: number): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ fetched_at: now, catalog }, null, 0), "utf8");
	} catch {
		/* 缓存写不进去不该让命令失败 */
	}
}

/**
 * 解析当前生效的目录：远端择新 → 缓存 → 随包兜底。
 *
 * **任何一步失败都不抛**：候选态要离线可用（spec「候选离线可列」），网络问题最多
 * 让用户用到一份旧目录，不该让 `gtrk mg fetch` 报错。拿不到远端时 `reason` 会说明
 * 原因，调用方 SHALL 明示给用户——静默用旧目录，用户会以为新模板没发布。
 */
export async function resolveCatalog(deps: ResolveDeps = {}): Promise<ResolvedCatalog> {
	const env = deps.env ?? process.env;
	const now = (deps.now ?? Date.now)();
	const file = deps.cacheFile ?? cachePath();
	const base = packaged();
	const cached = readCache(file);

	const best = (extra?: ResolvedCatalog): ResolvedCatalog => {
		const candidates: ResolvedCatalog[] = [{ catalog: base, origin: "packaged" }];
		if (cached && isNewer(cached.catalog.version, base.version)) {
			candidates.push({ catalog: cached.catalog, origin: "cache" });
		}
		if (extra) candidates.push(extra);
		let picked = candidates[0];
		for (const c of candidates.slice(1)) if (isNewer(c.catalog.version, picked.catalog.version)) picked = c;
		return picked;
	};

	if (deps.offline) {
		return { ...best(), reason: "离线模式，未尝试更新模板目录" };
	}
	// 缓存新鲜就直接用，别每条命令都打网
	if (cached && now - cached.fetched_at < CATALOG_TTL_MS) {
		return best();
	}

	const f = deps.fetch ?? fetch;
	const timeoutMs = deps.timeoutMs ?? SOURCE_TIMEOUT_MS;
	const failures: string[] = [];
	for (const { id, url } of catalogUrls(env)) {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		try {
			const r = await f(url, { signal: ac.signal });
			if (!r.ok) {
				failures.push(`[${id}] HTTP ${r.status}`);
				continue;
			}
			const remote = await r.json();
			if (!isCatalog(remote)) {
				failures.push(`[${id}] 目录结构不认识`);
				continue;
			}
			writeCache(file, remote, now);
			const picked = best({ catalog: remote, origin: "remote" });
			return picked.origin === "remote"
				? picked
				: { ...picked, reason: `远端目录 ${remote.version} 不比本地 ${picked.catalog.version} 新` };
		} catch (e) {
			const msg = e instanceof Error ? (e.name === "AbortError" ? `超时 ${timeoutMs}ms` : e.message) : String(e);
			failures.push(`[${id}] ${msg}`);
		} finally {
			clearTimeout(timer);
		}
	}
	return { ...best(), reason: `模板目录未能更新（三源皆不可达：${failures.join("；")}）` };
}

/** 一句话交代目录来源，命令与面板共用，口径只写一处。 */
export function describeCatalog(resolved: ResolvedCatalog): string {
	const { catalog, origin, reason } = resolved;
	const where = origin === "remote" ? "远端" : origin === "cache" ? "本地缓存" : "随包兜底";
	return `模板目录 v${catalog.version}（${where}，${catalog.items.length} 件）${reason ? ` · ${reason}` : ""}`;
}

// ---- 检索 ----

/** 中文检索词 → 家族 / 标签的小同义表（打分用，不求全）。 */
const ZH_SYNONYMS: Record<string, string[]> = {
	开场: ["opening", "hook", "title"],
	字卡: ["title", "card", "caption"],
	标题: ["title", "heading"],
	字幕: ["caption", "subtitle"],
	强调: ["highlight", "emphasis", "keyword"],
	打字机: ["typewriter", "type"],
	字条: ["lowerthird", "bar"],
	引用: ["quote"],
	气泡: ["bubble", "chat"],
	故障: ["glitch", "rgb"],
	竖排: ["vertical", "cjk"],
	闪光: ["sparkle", "star", "flash"],
	清单: ["checklist", "list"],
	计数: ["counter", "number"],
};

function tokenize(words: string[]): string[] {
	const out: string[] = [];
	for (const w of words) {
		const t = w.trim().toLowerCase();
		if (!t) continue;
		out.push(t);
		for (const s of ZH_SYNONYMS[w.trim()] ?? []) out.push(s);
	}
	return out;
}

export interface ScoredTemplate {
	item: TextTemplateItem;
	score: number;
}

export function searchTemplates(words: string[], catalog: TextTemplateCatalog, top = 3): ScoredTemplate[] {
	const terms = tokenize(words);
	const scored = catalog.items.map((item) => {
		const hay = [item.id, item.title, item.family, ...item.tags].join(" ").toLowerCase();
		let score = 0;
		for (const t of terms) if (hay.includes(t)) score += 1;
		return { item, score };
	});
	// 没给检索词时按 id 稳定列前 N，别返回空——用户只是想看看有什么
	const pool = terms.length ? scored.filter((s) => s.score > 0) : scored;
	pool.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
	return pool.slice(0, top);
}

export function findTemplate(id: string, catalog: TextTemplateCatalog): TextTemplateItem | undefined {
	const key = id.trim().toLowerCase();
	return catalog.items.find((i) => i.id.toLowerCase() === key);
}

// ---- 取块 ----

export interface FetchAttempt {
	id: string;
	url: string;
	ok: boolean;
	reason?: string;
	ms: number;
}
export interface FetchTemplateResult {
	html: string;
	source: string;
	url: string;
	attempts: FetchAttempt[];
}

function blockUrls(catalog: TextTemplateCatalog, item: TextTemplateItem, env: NodeJS.ProcessEnv): { id: string; url: string }[] {
	const rel = `blocks/${item.id}/${item.file.path}`;
	const override = env.GITRUCK_TEXT_TEMPLATE_BASE?.trim();
	if (override) return [{ id: "override", url: `${override.replace(/\/+$/, "")}/${rel}` }];
	const mirrors = catalog.mirrors.length ? catalog.mirrors : packaged().mirrors;
	return mirrors.map((m) => ({ id: m.id, url: `${m.base.replace(/\/+$/, "")}/${rel}` }));
}

/**
 * 三源取块 + sha256 强校验。三源全失败 ⇒ 抛错并逐源列原因。
 *
 * 与目录解析的失败口径**刻意相反**：目录拿不到可以退回旧的，正文拿不到只能失败——
 * 落一个半成品颗粒比报错糟得多。
 */
export async function fetchTemplateHtml(
	catalog: TextTemplateCatalog,
	item: TextTemplateItem,
	deps: { fetch?: typeof fetch; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<FetchTemplateResult> {
	const f = deps.fetch ?? fetch;
	const timeoutMs = deps.timeoutMs ?? SOURCE_TIMEOUT_MS;
	const env = deps.env ?? process.env;
	const attempts: FetchAttempt[] = [];
	for (const { id, url } of blockUrls(catalog, item, env)) {
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
			if (got !== item.file.sha256) {
				attempts.push({ id, url, ok: false, reason: `sha256 不符（期望 ${item.file.sha256.slice(0, 12)}… 实得 ${got.slice(0, 12)}…）`, ms: Date.now() - t0 });
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
		`模板正文取回失败（${item.id}），三源皆不可用：\n${attempts.map((a) => `  - [${a.id}] ${a.url} → ${a.reason ?? "?"}（${a.ms}ms）`).join("\n")}`,
	);
}

/** poster 的候选 URL。远端新增的模板没有随包 poster，按同一套镜像取。 */
export function posterUrls(catalog: TextTemplateCatalog, item: TextTemplateItem, env: NodeJS.ProcessEnv = process.env): string[] {
	if (item.poster?.startsWith("http")) return [item.poster];
	const rel = item.poster ?? `posters/${item.id}.webp`;
	const override = env.GITRUCK_TEXT_TEMPLATE_BASE?.trim();
	if (override) return [`${override.replace(/\/+$/, "")}/${rel}`];
	const mirrors = catalog.mirrors.length ? catalog.mirrors : packaged().mirrors;
	return mirrors.map((m) => `${m.base.replace(/\/+$/, "")}/${rel}`);
}

export function existsPackagedCache(): boolean {
	return existsSync(cachePath());
}
