/**
 * 第三方 skill 推荐目录（change add-third-party-skill-catalog · third-party-skill-catalog spec）。
 *
 * 定位：**只登记引用，不分发第三方内容**；推荐是建议，安装是用户自己的行为。
 * 目录随包分发（`src/data/third-party-skill-catalog.json`，esbuild / bun 内联），顶层带 `snapshot_date`；
 * 本模块**零 I/O、零网络、零留痕**——「同场景同会话只推一次」是图纸层纪律，不是 CLI 状态。
 *
 * 场景闭集与触发词都住目录：图纸正文 MUST NOT 硬编任何仓名（skill-artifact-discipline「供应商中立」同理），
 * 目录变了守卫测试自动跟。
 *
 * 一方条目（change add-first-party-technique-catalog-entry）：`origin: "first-party"`（缺省即第三方；仓主 MUST 为 Gitruck）。
 * 技法族住场景 `technique`：`produces` 恒 `none`、不当车道生产者，由 agent 在 MG 步按槽位取用；人读输出对一方条目不印 star。
 */
import catalog from "../data/third-party-skill-catalog.json";

export type CatalogProduces = "MG" | "AI_DRAMA" | "FILM_BROLL" | "A_ROLL" | "script" | "none";
export type CatalogOutput = "hyperframes" | "html-gsap" | "mp4" | "lottie" | "gif" | "text";
export type CatalogAdapter = "none" | "gsap-emit" | "mp4-clip";
export type CatalogTier = "T1" | "T2";

export interface CatalogEntry {
	id: string;
	repo: string;
	/** 一方条目标记；缺省即第三方。 */
	origin?: "first-party";
	install: string;
	skills?: string[];
	scenes: string[];
	produces: CatalogProduces;
	output: CatalogOutput;
	deps: "local" | string[];
	license: string;
	license_note?: string;
	adapter: CatalogAdapter;
	tier: CatalogTier;
	lang: string[];
	stars_snapshot: number;
	note: string;
}

export interface CatalogScene {
	label: string;
	triggers: string[];
}

export interface Catalog {
	schema: number;
	snapshot_date: string;
	notes: string[];
	scenes: Record<string, CatalogScene>;
	entries: CatalogEntry[];
}

/** 许可允许集（spec「推荐目录 SHALL 随包分发且每条可核」）。不在集内的一律进不了目录。 */
export const LICENSE_ALLOWLIST: readonly string[] = [
	"MIT",
	"MIT-0",
	"Apache-2.0",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"CC-BY-4.0",
	"ISC",
	"Unlicense",
];

/** 雷区关键字：出现在 license / license_note / repo / install 里即红（守卫测试用）。 */
export const LICENSE_RED_FLAGS: readonly RegExp[] = [/AGPL/i, /\bGPL\b/i, /PolyForm/i, /noncommercial/i, /无许可/i, /\bmcp\b/i];

/** 安装命令允许的开头（守卫测试用）：三种形态都是用户自己在终端或 agent 里能原样执行的。 */
export const INSTALL_PREFIXES: readonly RegExp[] = [/^npx /, /^git clone /, /^\/plugin /];

/** 目录快照的允许陈旧天数：超过即守卫红，提醒发版前刷目录。 */
export const SNAPSHOT_MAX_AGE_DAYS = 90;

/** 技法族场景 id：挂在此场景的条目 `produces` 恒 `none`，由 agent 在 MG 步按槽位取用，不当车道生产者。 */
export const TECHNIQUE_SCENE = "technique";

/** 一方条目的仓主：`origin: "first-party"` 的条目 `repo` MUST 以它开头（守卫测试用）。 */
export const FIRST_PARTY_OWNER = "Gitruck";

export function isFirstParty(entry: CatalogEntry): boolean {
	return entry.origin === "first-party";
}

/** 技法族条目：不绑车道、按槽位取用（skills add 的提示与守卫测试共用同一判据）。 */
export function isTechniqueEntry(entry: CatalogEntry): boolean {
	return entry.scenes.includes(TECHNIQUE_SCENE);
}

const TIER_ORDER: Record<CatalogTier, number> = { T1: 0, T2: 1 };

/** 读目录（内联 JSON，零 I/O）。返回的是模块级单例，调用方 MUST NOT 就地改写。 */
export function loadCatalog(): Catalog {
	return catalog as Catalog;
}

export function catalogSnapshotDate(): string {
	return loadCatalog().snapshot_date;
}

/** 场景闭集（目录顶层声明的键序）。 */
export function listScenes(cat: Catalog = loadCatalog()): { id: string; label: string; count: number }[] {
	return Object.entries(cat.scenes).map(([id, s]) => ({
		id,
		label: s.label,
		count: cat.entries.filter((e) => e.scenes.includes(id)).length,
	}));
}

export function isScene(scene: string, cat: Catalog = loadCatalog()): boolean {
	return Object.prototype.hasOwnProperty.call(cat.scenes, scene);
}

/** 按场景取条目，tier 升序（T1 在前）、同 tier 按目录原序。未知场景返回空数组（调用方自己报错）。 */
export function recommend(scene: string, cat: Catalog = loadCatalog()): CatalogEntry[] {
	if (!isScene(scene, cat)) return [];
	return cat.entries
		.map((e, i) => ({ e, i }))
		.filter(({ e }) => e.scenes.includes(scene))
		.sort((a, b) => TIER_ORDER[a.e.tier] - TIER_ORDER[b.e.tier] || a.i - b.i)
		.map(({ e }) => e);
}

/** 按仓名（`owner/repo`，大小写不敏感）查目录条目。 */
export function lookupByRepo(repo: string, cat: Catalog = loadCatalog()): CatalogEntry | undefined {
	const key = repo.trim().toLowerCase();
	return cat.entries.find((e) => e.repo.toLowerCase() === key);
}

/**
 * 用文本命中场景：任一触发词出现即命中。返回命中场景 id 列表（按目录场景顺序）。
 * 供 agent 判「高度匹配」用的机械底座；判定阈值（几处命中算高度匹配）归图纸层。
 */
export function matchScenes(text: string, cat: Catalog = loadCatalog()): string[] {
	const t = text.toLowerCase();
	return Object.entries(cat.scenes)
		.filter(([, s]) => s.triggers.some((w) => t.includes(w.toLowerCase())))
		.map(([id]) => id);
}

/** 登记命令：装完把条目追加进栏目配置 `style.skills` 的那条命令。 */
export function registerCommandFor(entry: CatalogEntry): string {
	const skills = entry.skills?.length ? entry.skills.map((s) => ` --skill ${s}`).join("") : "";
	return `gtrk skills add ${entry.repo}${skills} --produces ${entry.produces}`;
}

function depsLine(entry: CatalogEntry): string {
	if (entry.deps === "local") return "本地可跑";
	return `付费依赖：${entry.deps.map((d) => d.replace(/^paid:/, "")).join("；")}`;
}

function registrationNote(entry: CatalogEntry): string {
	if (isTechniqueEntry(entry)) return "（技法族：不绑车道（routing:none），MG 步按槽位取用）";
	if (entry.produces === "script" || entry.produces === "none") return "（管线外，登记为 routing:none）";
	return "";
}

/** 人读格式（走 stderr）。每条：用途 / 安装 / 许可与依赖 / 登记。 */
export function formatHuman(entries: CatalogEntry[], cat: Catalog = loadCatalog()): string {
	const lines: string[] = [];
	for (const e of entries) {
		lines.push(
			isFirstParty(e)
				? `◆ ${e.repo}（一方维护 · ${e.tier} · 快照 ${cat.snapshot_date}）`
				: `◆ ${e.repo}（${e.tier} · ${e.stars_snapshot}★ 于 ${cat.snapshot_date}，以仓库页为准）`,
		);
		lines.push(`   用途：${e.note}`);
		lines.push(`   安装：${e.install}`);
		lines.push(`   许可：${e.license}${e.license_note ? `（${e.license_note}）` : ""}；${depsLine(e)}`);
		lines.push(`   登记：${registerCommandFor(e)}${registrationNote(e)}`);
	}
	return lines.join("\n");
}

/** 机读格式（`--json` 走 stdout）。 */
export function toJson(entries: CatalogEntry[], cat: Catalog = loadCatalog()): Record<string, unknown>[] {
	return entries.map((e) => ({
		id: e.id,
		repo: e.repo,
		origin: e.origin ?? null,
		tier: e.tier,
		scenes: e.scenes,
		summary: e.note,
		install: e.install,
		skills: e.skills ?? [],
		produces: e.produces,
		output: e.output,
		adapter: e.adapter,
		deps: e.deps,
		license: e.license,
		license_note: e.license_note ?? null,
		lang: e.lang,
		stars_snapshot: e.stars_snapshot,
		snapshot_date: cat.snapshot_date,
		register_cmd: registerCommandFor(e),
	}));
}
