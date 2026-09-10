/**
 * 对外物料枚举清单的本地快照（change `link-enum-catalog-cli`）。
 *
 * 上游：gitruck-infra `add-enum-catalog-api` 的 `GET /catalog`
 * （公开匿名只读、ETag/304、内容派生版本；2026-09-10 上线）。
 *
 * ## 这个模块要解决的问题
 *
 * 服务端加一种字幕样式，CLI 不发版就当场拒绝那个**合法值**——因为校验清单被抄在了本地常量里。
 * 反过来服务端下架一个 task_type，CLI 还在往外发。两种都**不报错**，只是行为不对。
 *
 * ⇒ 校验清单改成「拉下来 + 落本地快照」。但这带来三条必须守住的性质：
 *
 * ① **拉不到 MUST NOT 让命令失败。** 枚举校验发生在**上传之前**，而纯本地命令
 *    （`gtrk patch` / `gtrk render` / `--help`）根本不该因为拉不到清单而变慢或变哑。
 *    ⇒ 任何失败分支都返回 `null`，调用方 `null` 即**放行**，交服务端白名单裁决。
 * ② **`--help` 路径 MUST 零网络。** 命令注册发生在**每次进程启动**，
 *    在那里发请求等于给每一条命令加一次往返。⇒ 注册期只读快照文件（{@link readSnapshotSync}）。
 * ③ **服务端白名单恒为唯一真相源。** 本地校验只是「早点告诉用户」，
 *    MUST NOT 反过来变成第二个判据 —— 所以无快照就放行，而不是拒绝。
 *
 * ## 三级取数策略（{@link getCatalog}）
 *
 * ```
 * 快照在且新鲜（<24h） ─────────────► 直接用，零网络
 * 快照在但过期 ── 条件请求（If-None-Match）
 *                    ├ 304 ─────────► 用旧快照，只更新 fetched_at
 *                    ├ 200 ─────────► 整体替换快照
 *                    └ 失败 ────────► 用旧快照 + 一行降级提示（进程内只打一次）
 * 无快照 ── 无条件请求
 *                    ├ 200 ─────────► 落快照
 *                    └ 失败 ────────► 返回 null（调用方放行）
 * ```
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveApiBase } from "./config";
import { homeFile } from "./paths";

/** 上游只读口。⚠️ 拼在 {@link resolveApiBase} 之后。**MUST NOT 带 `Authorization`** —— 它是公开口。 */
export const CATALOG_PATH = "/catalog";

/** 快照落点。与 config / 缓存 / ffmpeg 同住 `~/.gitruck/`。 */
export function catalogSnapshotPath(): string {
	return homeFile("catalog.json");
}

/**
 * 新鲜期。枚举变动是「发版频率」量级的事，24 h 足够；
 * 要立刻拿新的走 `gtrk doctor --refresh-catalog`。
 */
export const FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * 拉取超时。⚠️ **短**是刻意的：这条请求挂在**云端命令的开头**，
 * 拉不到本来就放行，为它多等一秒都是白等。
 */
export const FETCH_TIMEOUT_MS = 3000;

/** 本模块认得的载荷结构版本。服务端 `schema` 与之不等 ⇒ 当作「读不懂」，按无快照处理。 */
export const SUPPORTED_SCHEMA = 1;

/** 本地快照文件的形态。 */
export interface CatalogSnapshot {
	/** 服务端载荷结构版本。 */
	schema: number;
	/** 拉取时用的 API 根地址。⚠️ **换 base 即作废**，见 {@link readSnapshot}。 */
	base: string;
	/** 上次响应的 `ETag`，用于条件请求。 */
	etag: string;
	/** 内容摘要，用于「有没有变」的人读判断。 */
	catalog_version: string;
	/** 上次**成功拿到确认**（200 或 304）的时刻，毫秒。 */
	fetched_at: number;
	/** `data.sections` 原样。 */
	data: Record<string, unknown>;
}

/** 单测注入旋钮。**生产恒 `null`**。 */
export const __enumCatalogIo: {
	impl: null | {
		fetch: typeof fetch;
		apiBase(): string;
		now(): number;
		readFile(path: string): string | null;
		writeFile(path: string, body: string): void;
		stderr(chunk: string): void;
	};
} = { impl: null };

function io() {
	const i = __enumCatalogIo.impl;
	return {
		fetch: i?.fetch ?? fetch,
		apiBase: i?.apiBase ?? resolveApiBase,
		now: i?.now ?? (() => Date.now()),
		readFile:
			i?.readFile ??
			((p: string) => {
				try {
					return existsSync(p) ? readFileSync(p, "utf8") : null;
				} catch {
					return null;
				}
			}),
		writeFile:
			i?.writeFile ??
			((p: string, body: string) => {
				mkdirSync(dirname(p), { recursive: true });
				writeFileSync(p, body);
			}),
		stderr: i?.stderr ?? ((chunk: string) => void process.stderr.write(chunk)),
	};
}

// ---------------------------------------------------------------------------
// 快照读写
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 读快照。**任何不对劲一律当作没有快照**（返回 `null`），MUST NOT 抛。
 *
 * ⚠️ **`base` 不一致视为无快照**：换了根地址（切生产/预发、或改了 `GITRUCK_API_BASE`）
 * 之后还拿旧环境的枚举去校验，会拒掉新环境的合法值——而用户完全看不出为什么。
 * 宁可重拉一次。
 */
export function readSnapshot(): CatalogSnapshot | null {
	const d = io();
	const raw = d.readFile(catalogSnapshotPath());
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null; // 损坏当没有，下次重拉
	}
	if (!isPlainObject(parsed)) return null;
	const s = parsed as Partial<CatalogSnapshot>;
	if (s.schema !== SUPPORTED_SCHEMA) return null;
	if (typeof s.base !== "string" || s.base !== d.apiBase()) return null;
	if (typeof s.fetched_at !== "number" || !isPlainObject(s.data)) return null;
	return {
		schema: s.schema,
		base: s.base,
		etag: typeof s.etag === "string" ? s.etag : "",
		catalog_version: typeof s.catalog_version === "string" ? s.catalog_version : "",
		fetched_at: s.fetched_at,
		data: s.data,
	};
}

/** 写快照。写失败静默——快照写不上只意味着「下次再拉一遍」，不构成执行障碍。 */
export function writeSnapshot(snap: CatalogSnapshot): void {
	try {
		io().writeFile(catalogSnapshotPath(), JSON.stringify(snap, null, 2));
	} catch {
		/* 良性降级 */
	}
}

// ---------------------------------------------------------------------------
// 拉取
// ---------------------------------------------------------------------------

export type FetchOutcome =
	| { kind: "fresh"; snapshot: CatalogSnapshot }
	| { kind: "not-modified" }
	| { kind: "failed"; reason: string };

/**
 * 把传输层异常翻成人话。
 *
 * ⚠️ 这不是「美化」，是**降级提示的可读性纪律**：本件的降级是**已知根因**的良性降级
 * （拉不到清单 ⇒ 沿用旧快照 / 放行），提示里就不该原样抛 runtime 的英文天书。
 * 真机实测：3 s 超时在 bun 下抛的是 `The operation was aborted.`，
 * 印在中文降级句里既看不懂、又拼出「aborted.。」这种双句号。
 * 未知形态**仍原样带出**（保留可排障性），只做尾部标点归一。
 */
function humanFetchReason(e: unknown): string {
	const name = e instanceof Error ? e.name : "";
	const raw = e instanceof Error ? e.message : String(e);
	if (name === "AbortError" || raw === "The operation was aborted." || /\babort/i.test(raw)) {
		return `超时（${FETCH_TIMEOUT_MS / 1000}s 未响应）`;
	}
	return raw.replace(/[.。\s]+$/, "") || "网络不可达";
}

/**
 * 条件 GET。**不带 `Authorization`**（公开口），带可清除的超时定时器。
 * **绝不抛** —— 所有失败收口成 `failed`。
 */
export async function fetchCatalog(etag?: string): Promise<FetchOutcome> {
	// 离线闸：置 `GITRUCK_CATALOG_OFFLINE=1` 即**永不发请求**。
	// ⚠️ 存在的理由是**测试 hermetic**：`test/helpers/test-home.mjs` 会设它，
	// 于是整套测试永远不会因为「枚举清单」这件事去打生产。
	// 用户也可以用它把本地枚举校验彻底关掉（只用盘上快照、或干脆放行）。
	// ⚠️ 注入了传输（`__enumCatalogIo.impl`）就**不受本闸约束**：那说明调用方在自己控制
	//    这条路（单测的假 fetch），本来就不会真出网。本闸守的是**真实传输**。
	//    不加这个判别的话，测拉取逻辑的用例会全部退化成「离线」，等于没测。
	if (!__enumCatalogIo.impl && process.env.GITRUCK_CATALOG_OFFLINE === "1") {
		return { kind: "failed", reason: "GITRUCK_CATALOG_OFFLINE=1（不发请求）" };
	}
	const d = io();
	const base = d.apiBase();
	const headers: Record<string, string> = { accept: "application/json" };
	if (etag) headers["If-None-Match"] = etag;

	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
	let res: Response;
	try {
		res = await d.fetch(`${base}${CATALOG_PATH}`, { headers, signal: ctl.signal });
	} catch (e) {
		return { kind: "failed", reason: humanFetchReason(e) };
	} finally {
		// 成功与抛错两条路都要清（同摩擦/崩溃上报口的口径）
		clearTimeout(timer);
	}

	if (res.status === 304) return { kind: "not-modified" };
	if (!res.ok) return { kind: "failed", reason: `HTTP ${res.status}` };

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		// SPA 回退成 HTML 之类：2xx 但不是 JSON
		return { kind: "failed", reason: "响应不是 JSON" };
	}
	if (!isPlainObject(body)) return { kind: "failed", reason: "响应形态异常" };
	const data = (body as { data?: unknown }).data;
	if (!isPlainObject(data)) return { kind: "failed", reason: "响应缺 data" };
	const schema = (data as { schema?: unknown }).schema;
	if (schema !== SUPPORTED_SCHEMA) {
		// ⚠️ 结构版本对不上**不是错误**，是「这版 CLI 读不懂新结构」。
		// 当作拿不到处理（放行 + 用旧快照），MUST NOT 强解析。
		return { kind: "failed", reason: `schema ${String(schema)} 超出本版 CLI 支持（${SUPPORTED_SCHEMA}）` };
	}
	const sections = (data as { sections?: unknown }).sections;
	if (!isPlainObject(sections)) return { kind: "failed", reason: "响应缺 sections" };

	return {
		kind: "fresh",
		snapshot: {
			schema: SUPPORTED_SCHEMA,
			base,
			etag: res.headers.get("etag") ?? "",
			catalog_version: String((data as { catalog_version?: unknown }).catalog_version ?? ""),
			fetched_at: d.now(),
			data: sections,
		},
	};
}

// ---------------------------------------------------------------------------
// 降级提示（进程内只打一次）
// ---------------------------------------------------------------------------

let degradeNoticed = false;

/** 仅供单测重置（生产不调）。 */
export function resetEnumCatalogState(): void {
	degradeNoticed = false;
	cachedSections = undefined;
	cachedFresh = false;
}

function humanAge(ms: number): string {
	const h = Math.floor(ms / 3_600_000);
	if (h < 1) return "不到 1 小时";
	if (h < 48) return `${h} 小时`;
	return `${Math.floor(h / 24)} 天`;
}

/**
 * 一行降级提示。**恒 stderr、进程内只打一次。**
 *
 * ⚠️ 走 `process.stderr` 而不是 `log.*`：`log.info` 默认写 stdout，
 * 「stdout 干净」依赖调用方记得 `routeLogsToStderr()`，是个会漏的保证
 * （同 `compliance-notice` 的既有口径）。
 */
function noticeDegrade(reason: string, ageMs: number | null): void {
	if (degradeNoticed) return;
	degradeNoticed = true;
	const tail = ageMs == null ? "本地无快照，本次跳过枚举校验（服务端仍会裁决）" : `沿用 ${humanAge(ageMs)}前的快照`;
	io().stderr(`\x1b[2m   （枚举清单未能刷新：${reason}。${tail}）\x1b[0m\n`);
}

// ---------------------------------------------------------------------------
// 三级策略
// ---------------------------------------------------------------------------

let cachedSections: Record<string, unknown> | undefined;

/**
 * 缓存里那份数据**是不是新鲜的**（在 `FRESH_MS` 窗口内）。
 *
 * ⚠️ 单独记一个位、而不是回头去看盘上快照的 `fetched_at`，是因为 304 那条路
 * 会把盘上时刻推到现在——两者在「刚续期过」这一刻是一致的，但降级那条路不是：
 * 降级时缓存里装的是**陈旧**快照，盘上时刻也确实陈旧，可 `cachedSections`
 * 一旦有值就代表「本进程已定夺」，光看有没有缓存分不出这两种来源。
 * 任务可用性覆盖（`isTaskTypeOffline`）是**唯一**吃新鲜度的消费者：
 * 枚举白名单陈旧了照用（服务端仍会裁决），但拿一份不知道多久以前的
 * offline 集合去拦用户，会把一个早就恢复上架的能力一直挡在门外。
 */
let cachedFresh = false;

export interface GetCatalogOptions {
	/** 无视新鲜期强制刷新（`gtrk doctor --refresh-catalog`）。 */
	refresh?: boolean;
}

/**
 * 取枚举清单的分节数据。**任何分支都不抛**；拿不到返回 `null`（调用方放行）。
 *
 * 进程内缓存一次结果：一条命令里可能有多处校验，不该拉两遍、也不该读两遍盘。
 */
export async function getCatalog(opts: GetCatalogOptions = {}): Promise<Record<string, unknown> | null> {
	if (cachedSections !== undefined && !opts.refresh) return cachedSections;
	const d = io();
	const snap = readSnapshot();

	if (snap && !opts.refresh && d.now() - snap.fetched_at < FRESH_MS) {
		cachedSections = snap.data;
		cachedFresh = true;
		return snap.data;
	}

	const outcome = await fetchCatalog(snap?.etag);
	if (outcome.kind === "fresh") {
		writeSnapshot(outcome.snapshot);
		cachedSections = outcome.snapshot.data;
		cachedFresh = true;
		return outcome.snapshot.data;
	}
	if (outcome.kind === "not-modified" && snap) {
		// 内容没变，只把「上次确认时刻」推到现在——否则每条命令都会重发一次条件请求。
		writeSnapshot({ ...snap, fetched_at: d.now() });
		cachedSections = snap.data;
		cachedFresh = true;
		return snap.data;
	}
	if (snap) {
		noticeDegrade(outcome.kind === "failed" ? outcome.reason : "未知", d.now() - snap.fetched_at);
		cachedSections = snap.data;
		cachedFresh = d.now() - snap.fetched_at < FRESH_MS; // 降级：多半陈旧，可用性覆盖随之失效
		return snap.data;
	}
	noticeDegrade(outcome.kind === "failed" ? outcome.reason : "未知", null);
	cachedSections = null as unknown as Record<string, unknown>;
	cachedFresh = false;
	return null;
}

// ---------------------------------------------------------------------------
// 分节形态校验 + 白名单读取
// ---------------------------------------------------------------------------

/**
 * 分节路径 → 期望形态。**逐节校验、不合者置缺失**（而不是整份作废）：
 * 服务端某个分节改了形态，不该把其它九个分节一起废掉。
 *
 * ⚠️ 路径与形态按 2026-09-10 生产真实响应钉死（夹具
 * `test/fixtures/enum-catalog/catalog.sample.json`）。
 */
export const CATALOG_ENUMS = {
	"tts.voices": "objectIdList",
	"tts.output_formats": "stringList",
	"tts.split_methods": "stringList",
	"tts.subtitle_formats": "stringList",
	"music_visualizer.templates": "stringList",
	"subtitle.languages": "stringValueMap",
	"subtitle.styles": "stringList",
	"subtitle.colors": "stringList",
	"task_availability.offline": "stringList",
	"matting.video.target_modes": "stringList",
	"matting.video.output_formats": "stringList",
	"matting.image.output_formats": "stringList",
	"audio_separation.modes": "stringList",
	"oral_cut.rhythm_presets": "stringList",
	"project_formats.public": "stringList",
	"project_formats.aliases": "stringList",
	"video_ai_segment.modes": "stringList",
	"video_interpolate.multipliers": "numberList",
} as const;

export type CatalogEnumKey = keyof typeof CATALOG_ENUMS;

function dig(root: Record<string, unknown>, path: string): unknown {
	let cur: unknown = root;
	for (const seg of path.split(".")) {
		if (!isPlainObject(cur)) return undefined;
		cur = cur[seg];
	}
	return cur;
}

/**
 * 读一个分节的合法值集合。**形态不合 ⇒ 返回 `null`（视同缺失 ⇒ 调用方放行）**，
 * MUST NOT 半信半疑地用一半。
 *
 * `tts.voices` 是对象数组，取其 `id`；`subtitle.languages` 是 `{中文名: 语言码}`，
 * 取其**值**（校验点比的是语言码）。
 */
export function catalogEnum(sections: Record<string, unknown> | null, key: CatalogEnumKey): string[] | null {
	if (!sections) return null;
	const shape = CATALOG_ENUMS[key];
	const v = dig(sections, key);
	if (shape === "stringList") {
		return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
	}
	if (shape === "numberList") {
		return Array.isArray(v) && v.every((x) => typeof x === "number") ? v.map(String) : null;
	}
	if (shape === "stringValueMap") {
		if (!isPlainObject(v)) return null;
		const vals = Object.values(v);
		return vals.every((x) => typeof x === "string") ? (vals as string[]) : null;
	}
	// objectIdList
	if (!Array.isArray(v)) return null;
	const ids = v.map((x) => (isPlainObject(x) ? x.id : undefined));
	return ids.every((x) => typeof x === "string") ? (ids as string[]) : null;
}

/**
 * 注册期用的**同步**读取：只读快照文件，**零网络**（红线②）。
 * 帮助文案渲染走这条；拿不到就让调用方用「取值以服务端为准」那句兜底文案。
 */
export function readSnapshotSync(): Record<string, unknown> | null {
	return readSnapshot()?.data ?? null;
}

/** 同步版白名单读取（注册期专用，同样零网络）。 */
export function catalogEnumSync(key: CatalogEnumKey): string[] | null {
	return catalogEnum(readSnapshotSync(), key);
}

// ---------------------------------------------------------------------------
// 校验点用的三个薄包装
// ---------------------------------------------------------------------------

/**
 * 云端命令入口处调一次，把清单预热进进程内缓存。**绝不抛、不阻断**。
 *
 * ⚠️ 为什么要有它：真正的校验发生在 `buildPayload`（**同步**函数）里，
 * 那里没法 `await`。预热之后 {@link catalogEnumNow} 读的就是这一次的结果，
 * 而不是一份可能已经过期的盘上快照。
 * ⚠️ MUST NOT 挂在命令注册期 —— 那是每次进程启动都会跑的路径（红线②）。
 */
export async function primeCatalog(opts: GetCatalogOptions = {}): Promise<void> {
	await getCatalog(opts);
}

/**
 * 同步取白名单：**先读进程内缓存**（{@link primeCatalog} 预热过的），没有再退回盘上快照。
 * 两者都没有 ⇒ `null` ⇒ 调用方**放行**。
 */
export function catalogEnumNow(key: CatalogEnumKey): string[] | null {
	if (cachedSections !== undefined) return catalogEnum(cachedSections, key);
	return catalogEnumSync(key);
}

/**
 * 校验一个 flag 的取值。**拿不到清单就放行** —— 服务端白名单恒为唯一真相源，
 * 本地校验只是「早点告诉用户」，MUST NOT 变成第二个判据。
 *
 * ⚠️ 报错文案里**列出可用集**：只说「不支持」而不说「支持什么」，
 * 用户下一步只能去翻文档，等于把问题推回去。
 */
export function assertEnum(key: CatalogEnumKey, flag: string, value: string): void {
	assertEnumIn([key], flag, value);
}

/**
 * 多分节并集版。目前只有一个用处，但它是**必须的**：
 * `project_formats` 对外枚举是 `public`（6 个），而服务端**同时仍接受** `aliases`
 * 里那 8 个旧细粒度值（`jianying_draft` 等，兼容口）。
 * 只按 `public` 校验会**误拒服务端接受的合法值** —— 那正是本 change 要消灭的病灶，
 * 换个方向再犯一次就说不过去了。
 *
 * ⚠️ 报错文案只列**第一个**分节（对外枚举），不把兼容别名也倒给用户 ——
 * 兼容值能用但不推荐，列出来等于在推荐它。
 */
export function assertEnumIn(keys: readonly CatalogEnumKey[], flag: string, value: string): void {
	const lists = keys.map((k) => catalogEnumNow(k));
	// 任一分节缺失 ⇒ 放行。半份白名单比没有更危险：它会拒掉恰好落在缺失那半里的合法值。
	if (lists.some((l) => l == null)) return;
	const all = lists.flat() as string[];
	if (all.includes(value)) return;
	throw notListed(flag, lists[0] as string[]);
}

/** 「只支持…」报错的唯一句式。两个校验入口共用，免得文案分头漂。 */
function notListed(flag: string, shown: readonly string[]): Error {
	return new Error(
		`${flag} 只支持 ${shown.join("、")}（取值来自服务端枚举清单；` +
			`\`gtrk doctor\` 可查清单版本，\`--refresh-catalog\` 立刻刷新；\`--param\` 可绕过本地校验）`,
	);
}

// ---------------------------------------------------------------------------
// 识别源语种：按 task_type 分档（⟲ 2026-09-10 由 infra add-enum-catalog-api 6.8 转入）
// ---------------------------------------------------------------------------

/**
 * 识别源语种分档的路径（infra `add-enum-catalog-api` §6.2 取 (a)；2026-09-10 以**加法**下发，schema 仍为 1）。
 *
 * ## 为什么识别源语种不能再拿 `subtitle.languages` 校验
 *
 * `subtitle.languages`（11 项）是字幕类任务**共同的语种范围**：服务端入口两道闸里的**第一道**，
 * 同时是翻译目标语（`translate_language` / `output_language`）的全部可用集。
 * 识别源语种（`language` / `la`）在入口还要过**第二道闸**：按 task_type 实算的可用面，
 * 切点三线（`video_oral_cut` / `video_long2short` / `video_long2short_pro`）只剩 7 项。
 * ⇒ 拿 11 项去校验切点线的识别源语种，`es-ES` / `pt-PT` / `ru-RU` / `vi-VN` 会**通过本地校验、
 *    再被服务端 6015 拒**（计费前被拒、无实损，但用户白等了一次抽取与上传）。
 *    这是本模块「同源铁律」要治的病的**镜像形态**：铁律防的是把合法值拒在本地，这里是把非法值放行出去。
 *
 * ## 退回语义（「只降不升」不变）
 *
 * 新键缺失（老服务端 / 快照拉取于该键上线之前）、该 task_type 无档、或形态不合 ⇒
 * **退回** `subtitle.languages`。退回是安全的：服务端守卫钉住「各档 ⊆ 共同范围」，
 * 退回只会**少拦**、不会多拦；共同范围也拿不到 ⇒ `null` ⇒ 放行交服务端。
 *
 * ⚠️ **翻译目标语 MUST NOT 走这里**：它在各入口只过第一道闸，拿识别源语种的分档去校验它，
 *    会把合法的译文语种（如 `es-ES`）拒在本地。键名里带 `source` 就是服务端刻意挡这件事的。
 */
export const SOURCE_LANGUAGES_PATH = "subtitle.source_languages";

/**
 * 服务端登记了识别源语种可用面的 task_type（= infra `language_gated_task_types()`；
 * 2026-09-10 本地 `build_sections()` 实算为这五个）。
 *
 * 做成字面量联合是为了**把拼错挡在编译期**：拼错的 task_type 在快照里查不到档，
 * 会静默退回 11 项共同范围——不报错，只是又把那 4 个码放出去，正是本段要治的病。
 * 服务端将来新增一条线：先在这里登记，再在消费点使用；登记之前那条线照旧退回共同范围（只降不升）。
 */
export const SOURCE_LANGUAGE_TASK_TYPES = [
	"video_oral_cut",
	"video_long2short",
	"video_long2short_pro",
	"video_ai_subtitle",
	"subtitle_translate",
] as const;

export type SourceLanguageTaskType = (typeof SOURCE_LANGUAGE_TASK_TYPES)[number];

/**
 * 读某条线的识别源语种可用集。**该线分档缺失 / 形态不合 ⇒ 退回 `subtitle.languages`**；
 * 两者都拿不到 ⇒ `null`（调用方放行）。
 *
 * ⚠️ 这里传**入口闸查表用的键**：`gtrk oralcut` 提交的是 CLI 特例 `video_oral_cut_for_cli`，
 *    它的入口闸查的却是 `language_support_for("video_oral_cut")`
 *    （infra `api/cli/video_oral_cut_for_cli.py`）⇒ 这里传 `video_oral_cut`。
 */
export function catalogSourceLanguages(
	sections: Record<string, unknown> | null,
	taskType: SourceLanguageTaskType,
): string[] | null {
	if (!sections) return null;
	const tiers = dig(sections, SOURCE_LANGUAGES_PATH);
	const own = isPlainObject(tiers) ? tiers[taskType] : undefined;
	if (Array.isArray(own) && own.every((x) => typeof x === "string")) return own as string[];
	return catalogEnum(sections, "subtitle.languages");
}

/** 同步取某条线的识别源语种可用集：先读进程内缓存、没有再退回盘上快照（口径同 {@link catalogEnumNow}）。 */
export function sourceLanguagesNow(taskType: SourceLanguageTaskType): string[] | null {
	if (cachedSections !== undefined) return catalogSourceLanguages(cachedSections, taskType);
	return catalogSourceLanguages(readSnapshotSync(), taskType);
}

/**
 * 校验一个**识别源语种** flag（`--lang` / `--language`）。拿不到清单就放行；
 * 报错与 {@link assertEnum} 同一句式，列出的是**该线**的可用集。
 */
export function assertSourceLanguage(taskType: SourceLanguageTaskType, flag: string, value: string): void {
	const list = sourceLanguagesNow(taskType);
	if (list == null || list.includes(value)) return;
	throw notListed(flag, list);
}

/**
 * 该 task_type 是否被服务端**临时下架**（`6029` 门）。
 *
 * ⚠️ **只降不升**：清单说下架就拦，清单没说（或压根没清单）就**照常放行** ——
 * 「本地清单说它可用」永远不构成放行理由，服务端才是判据。
 * ⚠️ **只在快照新鲜时生效**：拿一份三天前的快照去拦一个早就恢复上架的类型，
 * 比不拦更糟——用户会以为是 CLI 坏了。
 */
export function isTaskTypeOffline(taskType: string): boolean {
	// ⚠️ 曾经写成 `cachedSections !== undefined || (盘上快照新鲜)`——**那是个真缺陷**，
	// 2026-09-10 真机跑出来的：`primeCatalog()` 在降级路径上也会把**陈旧**快照灌进缓存，
	// 于是「有缓存」被当成了「新鲜」，25 h 前的下架名单照样拦人。
	// 现在缓存的新鲜度**单独记位**（{@link cachedFresh}），没缓存才回落去看盘。
	const fresh =
		cachedSections !== undefined
			? cachedFresh
			: (() => {
					const snap = readSnapshot();
					return snap != null && io().now() - snap.fetched_at < FRESH_MS;
				})();
	if (!fresh) return false;
	const offline = catalogEnumNow("task_availability.offline");
	return offline != null && offline.includes(taskType);
}
