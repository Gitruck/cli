/**
 * 素材理解零件（add-matrix-describe-and-window · matrix-describe spec）。
 *
 * 服务端契约（infra add-material-describe-api，2026-08-12 原地修订为**异步任务**）：
 *   - 提交：`POST <url>`，body `{input:[{image:<base64>}...]}`——理解口**只吃图**（text 形态服务端拒绝，
 *     客户端根本不产生）；响应 `{code:200, msg, data:{task_id, status:"queued"}}`（兼容裸 `{task_id}` 形态）；
 *   - 轮询：`GET <url>/<task_id>`，同 headers；响应 `{code:200, data:{status, progress, output_result}}`
 *     （兼容裸形态）；status 终态 completed/failed/cancelled；completed 时 output_result 即原同步版结果体
 *     `{data:[{index?, desc, tags, mark, usable_flags}...], usage}`——**结果契约逐字段不变**，
 *     逐图对位（带 index 按 index 排，缺 index 按原序）；
 *   - 鉴权沿 cloud-link 口径：`Authorization: <apikey>`（**非 Bearer**）；
 *   - 批 ≤32/请求（异步化后批上限 8→32）；
 *   - 提交阶段传输失败/5xx/429 指数退避重试 3 次后硬失败（机读 code `describe_endpoint_unreachable`）；
 *     业务拒绝（4xx 业务码：6030 超批 / 6201·6202 积分不足等）立抛 DescribeRejectedError 不进退避；
 *   - 轮询阶段照 cloud.ts pollTask 范式：5s 间隔、30min 墙钟、网络瞬断 continue 不计入重试；
 *     failed/cancelled 抛 DescribeError（带服务端 error 文案；上游失败服务端已自动退款，客户端只报错）；
 *   - 单请求超时 120s（AbortSignal 对提交/轮询的每次 fetch 各自生效）。
 *
 * 计费（infra 拍板 2026-08-12，异步化修订）：**1 积分/张、异步任务计费**（提交预扣→完成结算，失败自动退款；
 * 无会话机制，与 embed 的会话计量不同）；同合云内部成员（gc_member_type=internal）豁免。CLI 侧护栏：
 * 单次将调用 >20 张时提示预估积分并确认（--yes 跳过；internal 豁免免确认仅提示——豁免探测复用 probeGcMemberType）。
 *
 * 缓存（design D1）：理解产物写本地索引库 describes 表，键=(材料 id, ts_ms)——同帧免重复调用
 * （VLM 1 积分/张，缓存就是钱）；素材 size:mtime 指纹变化按材料级联清除（local-index 编排负责）；
 * --rebuild 不清（理解产物与向量生命周期独立）。
 *
 * 端点 URL 决议：env GITRUCK_DESCRIBE_URL > ~/.gitruck config.describeUrl >
 * `<apiBase>/task/cli/material_describe`。
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readUserConfig } from "./user-config";
import type { MaterialDescribeMeta } from "./matrix";
import type { SqlDb } from "./local-index";

export const DESCRIBE_UNREACHABLE_CODE = "describe_endpoint_unreachable";
/** 计费单价（infra 拍板）：1 积分/张，异步任务计费（提交预扣→完成结算，失败自动退款；无会话）。 */
export const DESCRIBE_CREDITS_PER_IMAGE = 1;
/** 单请求批上限（infra 异步化修订：8→32）。 */
export const DESCRIBE_BATCH_MAX = 32;
/** 确认护栏阈值：单次**将实际调用**（缓存命中不计）超过此张数才提示确认。 */
export const DESCRIBE_CONFIRM_THRESHOLD = 20;
/** 单次 HTTP 请求超时（对提交 POST 与轮询 GET 的每次 fetch 各自生效）。 */
export const DESCRIBE_TIMEOUT_MS = 120_000;
/** 指数退避重试次数（同 embed：1 次首发 + 3 次重试后硬失败；仅作用于提交阶段）。 */
export const DESCRIBE_RETRIES = 3;
/** 轮询间隔（照 cloud.ts pollTask 范式）。 */
export const DESCRIBE_POLL_INTERVAL_MS = 5000;
/** 轮询墙钟上限（30 分钟兜底，照 pollTask 范式）。 */
export const DESCRIBE_POLL_TIMEOUT_MS = 30 * 60 * 1000;
const BACKOFF_BASE_MS = 1000;

/** 理解产物（服务端契约 D1 裁剪版）：flags 缺失键按 false 语义消费（宁放行勿误杀）。 */
export interface MaterialDescribe {
	desc: string;
	tags: string[];
	mark: number;
	usable_flags: Record<string, boolean>;
}

/** describe 端点硬失败（机读 code 固定 `describe_endpoint_unreachable`）。 */
export class DescribeError extends Error {
	readonly code = DESCRIBE_UNREACHABLE_CODE;
	constructor(msg: string) {
		super(msg);
		this.name = "DescribeError";
	}
}

/** 端点业务拒绝（服务端 4xx 业务码）：重试无意义立抛。跨 bundle 判别用 rejected === true（同 embed 口径）。 */
export class DescribeRejectedError extends Error {
	readonly rejected = true;
	constructor(
		readonly code: number,
		msg: string,
	) {
		super(`素材理解端点拒绝了请求（code=${code}）：${msg}`);
		this.name = "DescribeRejectedError";
	}
}

export interface DescribeEndpoint {
	url: string;
	apiKey: string;
}

/** 端点 URL 决议（env > ~/.gitruck 配置 > apiBase 推导默认——infra 落点 cli 域）。 */
export function resolveDescribeUrl(apiBase: string): string {
	const env = process.env.GITRUCK_DESCRIBE_URL?.trim();
	if (env) return env;
	const cfg = readUserConfig().describeUrl?.trim();
	if (cfg) return cfg;
	return `${apiBase.replace(/\/+$/, "")}/task/cli/material_describe`;
}

/** 测试注入面 + 请求选项（mock 端点夹具走 fetchFn；生产零注入）。 */
export interface DescribeDeps {
	fetchFn?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	backoffBaseMs?: number;
	timeoutMs?: number;
	/** 轮询间隔（默认 5000ms；测试注入假 sleep 秒过）。 */
	pollIntervalMs?: number;
	/** 轮询墙钟上限（默认 30 分钟）。 */
	pollTimeoutMs?: number;
	/** 时钟（轮询墙钟判定用；测试注入假 now）。 */
	now?: () => number;
}

/** 4xx 业务拒绝判据（同 embed 口径）：429/5xx 属传输面走重试，其余 4xx 携业务码即拒绝。 */
function parseBusinessRejection(status: number, text: string): DescribeRejectedError | null {
	if (status === 429 || status >= 500) return null;
	try {
		const j = JSON.parse(text) as { code?: unknown; msg?: unknown };
		if (typeof j.code === "number" && j.code !== 200) {
			return new DescribeRejectedError(j.code, typeof j.msg === "string" && j.msg ? j.msg : `HTTP ${status}`);
		}
	} catch {
		/* 非 JSON 响应体：按传输面处理（走重试） */
	}
	return null;
}

/** 单行产物宽松解析：desc/tags/mark/usable_flags 逐键容错（flags 值全部钳成布尔）。 */
function parseDescribeRow(raw: unknown): MaterialDescribe {
	const r = (raw ?? {}) as Record<string, unknown>;
	const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [];
	const flags: Record<string, boolean> = {};
	if (r.usable_flags && typeof r.usable_flags === "object" && !Array.isArray(r.usable_flags)) {
		for (const [k, v] of Object.entries(r.usable_flags as Record<string, unknown>)) flags[k] = v === true;
	}
	return {
		desc: typeof r.desc === "string" ? r.desc : "",
		tags,
		mark: typeof r.mark === "number" && Number.isFinite(r.mark) ? r.mark : 0,
		usable_flags: flags, // 缺失键=false 语义（infra D1「宁放行勿误杀」，agent 可复核）
	};
}

/** 公共请求头（提交与轮询同口径）：裸 apikey，非 Bearer（cloud-link 口径）。 */
function authHeaders(endpoint: DescribeEndpoint): Record<string, string> {
	return {
		accept: "application/json",
		Authorization: endpoint.apiKey, // 裸 apikey，非 Bearer（cloud-link 口径）
	};
}

/**
 * completed 产物解析：output_result 即原同步版结果体（结果契约逐字段不变）。
 * 双形态容错沿旧口径（{data:[…]} 或再套一层 {data:{data:[…]}}）；带 index 按 index 对位（服务端可乱序），
 * 缺 index 按原序。契约破坏（缺 data 数组/条数不符）在任务已 completed 后发生，重试无意义 → 直接 DescribeError。
 */
function parseDescribeRows(outputResult: unknown, expectedCount: number): MaterialDescribe[] {
	let rows: unknown = (outputResult as { data?: unknown } | null | undefined)?.data;
	if (rows && typeof rows === "object" && !Array.isArray(rows)) rows = (rows as { data?: unknown }).data;
	if (!Array.isArray(rows)) throw new DescribeError("任务完成但 output_result 缺 data 数组（非 material_describe 契约响应）");
	if (rows.length !== expectedCount) {
		throw new DescribeError(`任务完成但结果条数 ${rows.length} 与输入 ${expectedCount} 不符`);
	}
	const indexed = rows.every((r) => typeof (r as { index?: unknown })?.index === "number")
		? [...rows].sort((a, b) => (a as { index: number }).index - (b as { index: number }).index)
		: rows;
	return indexed.map(parseDescribeRow);
}

/** 提交阶段单发（不重试）：POST 提交批任务解析出 task_id；业务拒绝抛 DescribeRejectedError，其余异常抛给上层重试逻辑。 */
async function submitDescribeTask(
	endpoint: DescribeEndpoint,
	imagesBase64: string[],
	deps: Required<Pick<DescribeDeps, "fetchFn" | "timeoutMs">>,
): Promise<string> {
	const res = await deps.fetchFn(endpoint.url, {
		method: "POST",
		headers: { ...authHeaders(endpoint), "Content-Type": "application/json" },
		body: JSON.stringify({ input: imagesBase64.map((image) => ({ image })) }),
		signal: AbortSignal.timeout(deps.timeoutMs),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		const rejected = parseBusinessRejection(res.status, text);
		if (rejected) throw rejected;
		throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
	}
	const body = (await res.json()) as { code?: unknown; msg?: unknown; data?: unknown };
	if (typeof body.code === "number" && body.code !== 200) {
		throw new DescribeRejectedError(body.code, typeof body.msg === "string" ? body.msg : `code=${body.code}`);
	}
	// 双形态兼容：infra 包络 {code,msg,data:{task_id}} 或裸 {task_id}
	const data =
		body.data && typeof body.data === "object" && !Array.isArray(body.data)
			? (body.data as { task_id?: unknown })
			: (body as { task_id?: unknown });
	const taskId = data.task_id;
	if (typeof taskId !== "string" || !taskId) {
		throw new Error("提交响应缺 task_id（非 material_describe 异步任务契约响应）");
	}
	return taskId;
}

/**
 * 轮询阶段（照 cloud.ts pollTask 范式）：先查墙钟 → sleep(间隔) → GET `<url>/<task_id>`；
 * 网络瞬断/5xx/解析失败 continue 不计入重试（墙钟兜底）；真业务码（异账号/任务不存在等）鸭子透传；
 * completed 解析 output_result 返回；failed/cancelled 抛 DescribeError（带服务端 error 文案）；
 * 墙钟超时抛 DescribeError（文案含 task_id，提示可稍后再查）。
 */
async function pollDescribeTask(
	endpoint: DescribeEndpoint,
	taskId: string,
	expectedCount: number,
	deps: Required<Pick<DescribeDeps, "fetchFn" | "timeoutMs" | "sleep" | "pollIntervalMs" | "pollTimeoutMs" | "now">>,
): Promise<MaterialDescribe[]> {
	const pollUrl = `${endpoint.url.replace(/\/+$/, "")}/${taskId}`;
	const start = deps.now();
	for (;;) {
		if (deps.now() - start > deps.pollTimeoutMs) {
			throw new DescribeError(
				`素材理解任务轮询超时（超过 ${Math.round(deps.pollTimeoutMs / 60000)} 分钟，task_id=${taskId}）。` +
					`任务可能仍在云端执行，可稍后重跑查询——未落缓存的帧会重新提交，已完成帧走缓存零重复计费`,
			);
		}
		await deps.sleep(deps.pollIntervalMs);
		let body: { code?: unknown; msg?: unknown; data?: unknown };
		try {
			const res = await deps.fetchFn(pollUrl, {
				headers: authHeaders(endpoint),
				signal: AbortSignal.timeout(deps.timeoutMs),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				const rejected = parseBusinessRejection(res.status, text);
				if (rejected) throw rejected;
				continue; // 5xx/429 传输面：瞬断容忍续轮（墙钟兜底）
			}
			body = (await res.json()) as { code?: unknown; msg?: unknown; data?: unknown };
		} catch (e) {
			if ((e as { rejected?: unknown } | null)?.rejected === true) throw e; // 业务拒绝（跨 bundle 鸭子判定）：透传
			continue; // 网络瞬断/解析失败不致命也不计入重试，下次再试（照 pollTask 范式）
		}
		if (typeof body.code === "number" && body.code !== 200) {
			// 真错误码（异账号/任务不存在等）：透传不续轮（照 pollTask 对 CloudError 的口径）
			throw new DescribeRejectedError(body.code, typeof body.msg === "string" && body.msg ? body.msg : `code=${body.code}`);
		}
		// 双形态兼容：infra 包络 {code,data:{status,…}} 或裸 {status,…}
		const data =
			body.data && typeof body.data === "object" && !Array.isArray(body.data)
				? (body.data as Record<string, unknown>)
				: (body as Record<string, unknown>);
		const status = String(data.status ?? "");
		if (status === "completed") return parseDescribeRows(data.output_result, expectedCount);
		if (status === "failed" || status === "cancelled") {
			const out = data.output_result as { error?: unknown } | null | undefined;
			const serverErr = out && typeof out.error === "string" && out.error ? `：${out.error}` : "";
			throw new DescribeError(
				status === "failed"
					? `素材理解任务失败（task_id=${taskId}）${serverErr}——预扣积分已由服务端自动退款`
					: `素材理解任务已取消（task_id=${taskId}）${serverErr}`,
			);
		}
		// queued / processing 等非终态：续轮
	}
}

/**
 * 批量理解（异步任务形态）：按 ≤32/请求切批；每批「提交 + 轮询」——提交阶段指数退避重试
 * （仅网络/5xx/429；业务拒绝短路），任一批 3 次重试仍提交失败 → DescribeError 整体硬失败；
 * 轮询阶段不进退避重试（瞬断续轮、墙钟兜底，终态失败直接上抛——预扣已由服务端退款，重试=重复扣费）。
 * 返回与 imagesBase64 一一对位。
 */
export async function describeImages(
	endpoint: DescribeEndpoint,
	imagesBase64: string[],
	deps: DescribeDeps = {},
): Promise<MaterialDescribe[]> {
	if (imagesBase64.length === 0) return [];
	const fetchFn = deps.fetchFn ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const backoffBase = deps.backoffBaseMs ?? BACKOFF_BASE_MS;
	const timeoutMs = deps.timeoutMs ?? DESCRIBE_TIMEOUT_MS;
	const pollDeps = {
		fetchFn,
		sleep,
		timeoutMs,
		pollIntervalMs: deps.pollIntervalMs ?? DESCRIBE_POLL_INTERVAL_MS,
		pollTimeoutMs: deps.pollTimeoutMs ?? DESCRIBE_POLL_TIMEOUT_MS,
		now: deps.now ?? Date.now,
	};

	const out: MaterialDescribe[] = [];
	for (let off = 0; off < imagesBase64.length; off += DESCRIBE_BATCH_MAX) {
		const batch = imagesBase64.slice(off, off + DESCRIBE_BATCH_MAX);
		// ── 提交阶段：指数退避重试（1s → 2s → 4s；仅传输面，业务拒绝短路）──
		let taskId: string | undefined;
		let lastErr = "";
		for (let attempt = 0; attempt <= DESCRIBE_RETRIES; attempt++) {
			if (attempt > 0) await sleep(backoffBase * 2 ** (attempt - 1)); // 1s → 2s → 4s
			try {
				taskId = await submitDescribeTask(endpoint, batch, { fetchFn, timeoutMs });
				break;
			} catch (e) {
				if ((e as { rejected?: unknown } | null)?.rejected === true) throw e; // 业务拒绝：重试无意义
				lastErr = e instanceof Error ? e.message : String(e);
			}
		}
		if (taskId === undefined) {
			throw new DescribeError(
				`素材理解端点不可达或响应异常（${endpoint.url}）：${lastErr}——已指数退避重试 ${DESCRIBE_RETRIES} 次。` +
					`请确认同合云 material_describe API 已上线、~/.gitruck 配置 describeUrl / 环境变量 GITRUCK_DESCRIBE_URL 指向正确`,
			);
		}
		// ── 轮询阶段：不进退避重试（瞬断续轮由 pollDescribeTask 内部兜底；终态失败/墙钟超时直接上抛）──
		out.push(...(await pollDescribeTask(endpoint, taskId, batch.length, pollDeps)));
	}
	return out;
}

// ── 索引库 describes 缓存（D1：键=(材料 id, ts_ms)，同帧免重复调用）──────────

interface DescribeRow {
	desc_text: string;
	tags_json: string;
	mark: number | null;
	flags_json: string;
}

export function getCachedDescribe(db: SqlDb, materialId: string, tsMs: number): MaterialDescribe | undefined {
	const row = db.get<DescribeRow>(
		"SELECT desc_text, tags_json, mark, flags_json FROM describes WHERE material_id = ? AND ts_ms = ?",
		[materialId, tsMs],
	);
	if (!row) return undefined;
	try {
		return {
			desc: row.desc_text,
			tags: JSON.parse(row.tags_json) as string[],
			mark: row.mark ?? 0,
			usable_flags: JSON.parse(row.flags_json) as Record<string, boolean>,
		};
	} catch {
		return undefined; // 缓存行损坏当未命中（重新理解即自愈覆盖）
	}
}

export function putCachedDescribe(db: SqlDb, materialId: string, tsMs: number, d: MaterialDescribe): void {
	db.run(
		"INSERT OR REPLACE INTO describes(material_id, ts_ms, desc_text, tags_json, mark, flags_json, created_at) VALUES (?,?,?,?,?,?,?)",
		[materialId, tsMs, d.desc, JSON.stringify(d.tags), d.mark, JSON.stringify(d.usable_flags), new Date().toISOString()],
	);
}

/** 注入 plan result 的裁剪形态（describe 字段随 plan 流转，broll-plan-contract delta）。 */
export function toDescribeMeta(d: MaterialDescribe): MaterialDescribeMeta {
	return { desc: d.desc, tags: d.tags, mark: d.mark, usable_flags: d.usable_flags };
}

// ── 理解编排（三输入形态共用：缓存短路 → 确认护栏 → 抽帧/直读 → 批调用 → 写缓存）──

/** 单个待理解项：缓存键 + 帧来源（direct=图片文件直传；frame=经 ffmpeg 从素材/URL 抽帧）。 */
export interface DescribeWorkItem {
	materialId: string;
	tsMs: number;
	source: { kind: "direct"; path: string } | { kind: "frame"; src: string; tsSec: number };
}

export interface DescribeRunDeps {
	/** 索引库连接（describes 缓存宿主；openLocalIndexDb 产物）。 */
	db: SqlDb;
	/** 服务端批调用（≤32/批的切批与提交+轮询在 describeImages 内部；测试注入假端点/mock）。 */
	describeBatch: (imagesBase64: string[]) => Promise<MaterialDescribe[]>;
	/** 抽帧（复用 local-index 的 ffmpeg 链 extractFrameJpg；测试注入替身免 ffmpeg）。 */
	extractFrame: (src: string, tsSec: number, outJpg: string) => Promise<boolean>;
	/** 计费确认（--yes 跳过；测试注入）。 */
	confirm: (msg: string) => Promise<boolean>;
	/** internal 豁免探测（复用 probeGcMemberType；仅护栏触发时才探测——零多余云端调用）。 */
	probeExempt: () => Promise<boolean>;
	yes: boolean;
	/** 抽帧临时目录（即传即弃，整目录清理兜底）。 */
	frameDir: string;
	onLog?: (line: string) => void;
	/** 测试注入：direct 直传的文件读取。 */
	readFileBase64?: (path: string) => string;
}

export interface DescribeRunResult {
	ok: boolean;
	/** 计费确认被拒：零服务端调用中止。 */
	declined?: boolean;
	/** 拿到理解产物的条目数（缓存命中 + 实际调用）。 */
	described: number;
	/** 缓存命中数（零调用零计费）。 */
	cached: number;
	/** 实际调服务端张数（= 计费张数口径）。 */
	called: number;
	/** 抽帧/读文件失败数（局部化：单帧失败不拖垮整轮）。 */
	failed: number;
	/** 预估积分（= called 计划值 × 单价；护栏与账面同源）。 */
	estimatedCredits: number;
	/** internal 豁免（仅护栏触发探测过时出现）。 */
	exempt?: boolean;
	/** 与入参 items 一一对位（null=该项失败/被跳过）。 */
	results: (MaterialDescribe | null)[];
}

const keyOf = (it: DescribeWorkItem): string => `${it.materialId}@${it.tsMs}`;

/**
 * 理解编排主函数：缓存命中零调用（spec Scenario）；唯一键去重（同帧多引用只算一张）；
 * >20 张确认护栏（--yes 跳过、internal 豁免免确认仅提示）；抽帧图即传即弃。
 * 端点级失败（DescribeError/DescribeRejectedError）原样上抛由命令层收口。
 */
export async function runDescribeItems(items: DescribeWorkItem[], deps: DescribeRunDeps): Promise<DescribeRunResult> {
	const log = deps.onLog ?? (() => {});
	const resolved = new Map<string, MaterialDescribe | null>();
	// ── 缓存短路：唯一键逐个查 describes（同素材同帧免重复调用——缓存即钱）──
	const pending: DescribeWorkItem[] = [];
	for (const it of items) {
		const key = keyOf(it);
		if (resolved.has(key)) continue;
		const hit = getCachedDescribe(deps.db, it.materialId, it.tsMs);
		if (hit) resolved.set(key, hit);
		else {
			resolved.set(key, null); // 占位（防同键重复进 pending）
			pending.push(it);
		}
	}
	const cached = resolved.size - pending.length;
	const estimatedCredits = pending.length * DESCRIBE_CREDITS_PER_IMAGE;

	// ── 确认护栏（spec：单次将调用 >20 张时提示预估积分并确认）──
	let exempt: boolean | undefined;
	if (pending.length > DESCRIBE_CONFIRM_THRESHOLD) {
		exempt = await deps.probeExempt();
		const hint =
			`本次将实际调用素材理解 ${pending.length} 张（另 ${cached} 张缓存命中零计费），` +
			`预估 ${estimatedCredits} 积分（${DESCRIBE_CREDITS_PER_IMAGE} 积分/张，异步任务计费：提交预扣→完成结算，失败自动退款）`;
		if (exempt) {
			log(`${hint}——同合云内部成员（gc_member_type=internal）计费豁免，免确认继续`);
		} else if (deps.yes) {
			log(`${hint}——已按 --yes 跳过确认`);
		} else {
			log(hint);
			const go = await deps.confirm(`确认继续理解 ${pending.length} 张（约 ${estimatedCredits} 积分）？`);
			if (!go) {
				return {
					ok: false,
					declined: true,
					described: cached,
					cached,
					called: 0,
					failed: 0,
					estimatedCredits,
					...(exempt !== undefined ? { exempt } : {}),
					results: items.map((it) => resolved.get(keyOf(it)) ?? null),
				};
			}
		}
	}

	// ── 抽帧/直读（局部化：单帧失败跳过不拖垮整轮）→ 批调用 → 写缓存 ──
	let failed = 0;
	let called = 0;
	if (pending.length) {
		mkdirSync(deps.frameDir, { recursive: true });
		const readB64 = deps.readFileBase64 ?? ((p: string) => readFileSync(p).toString("base64"));
		try {
			const ready: { item: DescribeWorkItem; b64: string }[] = [];
			for (const it of pending) {
				try {
					if (it.source.kind === "direct") {
						ready.push({ item: it, b64: readB64(it.source.path) });
					} else {
						const jpg = join(deps.frameDir, `${it.materialId}_${it.tsMs}.jpg`);
						if (!(await deps.extractFrame(it.source.src, it.source.tsSec, jpg))) {
							throw new Error("抽帧失败（源不可读或 ffmpeg 不支持该格式）");
						}
						ready.push({ item: it, b64: readB64(jpg) });
					}
				} catch (e) {
					failed++;
					log(`[${it.materialId} @${(it.tsMs / 1000).toFixed(1)}s] 取帧失败：${e instanceof Error ? e.message : String(e)}（跳过）`);
				}
			}
			if (ready.length) {
				const outs = await deps.describeBatch(ready.map((r) => r.b64)); // 端点级失败原样上抛
				called = ready.length;
				ready.forEach((r, i) => {
					const d = outs[i]!;
					putCachedDescribe(deps.db, r.item.materialId, r.item.tsMs, d);
					resolved.set(keyOf(r.item), d);
				});
			}
		} finally {
			rmSync(deps.frameDir, { recursive: true, force: true }); // 抽帧图即传即弃兜底
		}
	}

	const results = items.map((it) => resolved.get(keyOf(it)) ?? null);
	return {
		ok: true,
		described: cached + called,
		cached,
		called,
		failed,
		estimatedCredits,
		...(exempt !== undefined ? { exempt } : {}),
		results,
	};
}
