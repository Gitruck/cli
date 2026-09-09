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
import { noticeOnce } from "./compliance-notice";
import { log } from "./log";
import { nextRateLimitWaitMs, rateLimitWaitNotice } from "./rate-limit-wait";
import { readUserConfig } from "./user-config";
import { RUBRIC_DEFAULT_BUCKET } from "./highlight-rubric";
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
/** 服务端限流阈值（次/分钟，固定窗口）：`describe_gateway_services.py:76`。
 *  ⚠️ 是 **30** 不是 embed 的 60——两个端点各有各的池，抄错了告知文案就是假话。 */
export const DESCRIBE_RATE_LIMIT_PER_MIN = 30;
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
	// [add-shot-cards-and-alignment-qc] 镜头卡片维度（服务端 upgrade-material-describe-shot-cards
	// 宽松超集；旧服务端缺失时按 ""/null 兜底，消费侧中性处理）。
	subject: string;
	action: string;
	shot_size: string | null;
	highlight: number | null;
	// claims 对齐判定三字段：仅带 claim 提交的图才有（CLI 条专属，勿在任何对外文档提及）。
	claim_aligned?: number;
	claim_verdict?: "match" | "partial" | "mismatch";
	claim_reason?: string;
}

/** [add-shot-cards-and-alignment-qc] describe 请求扩参（仅 CLI 条服务端解析；见 infra 联动件）。 */
export interface DescribeShotCardOpts {
	/** highlight 评分准则文本（≤2000 字；缺省=服务端 L0 领域无关准则）。 */
	highlightRubric?: string;
	/** 与 images 等长的逐图稿句（null=该图不做对齐判定）。 */
	claims?: (string | null)[];
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
	/** 限流（429）等待值（毫秒）：断言用 + 测试留门；生产恒走 `nextRateLimitWaitMs()`。 */
	rateLimitWaitMs?: number;
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

/** 单行产物宽松解析：desc/tags/mark/usable_flags + 镜头卡片/claims 逐键容错（缺失兜底不炸）。 */
function parseDescribeRow(raw: unknown): MaterialDescribe {
	const r = (raw ?? {}) as Record<string, unknown>;
	const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [];
	const flags: Record<string, boolean> = {};
	if (r.usable_flags && typeof r.usable_flags === "object" && !Array.isArray(r.usable_flags)) {
		for (const [k, v] of Object.entries(r.usable_flags as Record<string, unknown>)) flags[k] = v === true;
	}
	const num = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;
	const row: MaterialDescribe = {
		desc: typeof r.desc === "string" ? r.desc : "",
		tags,
		mark: typeof r.mark === "number" && Number.isFinite(r.mark) ? r.mark : 0,
		usable_flags: flags, // 缺失键=false 语义（infra D1「宁放行勿误杀」，agent 可复核）
		subject: typeof r.subject === "string" ? r.subject : "",
		action: typeof r.action === "string" ? r.action : "",
		shot_size: typeof r.shot_size === "string" && r.shot_size ? r.shot_size : null,
		highlight: num(r.highlight),
	};
	const aligned = num(r.claim_aligned);
	if (aligned !== null) {
		row.claim_aligned = aligned;
		row.claim_verdict =
			r.claim_verdict === "match" || r.claim_verdict === "mismatch" ? r.claim_verdict : "partial";
		row.claim_reason = typeof r.claim_reason === "string" ? r.claim_reason : "";
	}
	return row;
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
	shotCard?: DescribeShotCardOpts,
): Promise<string> {
	const reqBody: Record<string, unknown> = { input: imagesBase64.map((image) => ({ image })) };
	// [add-shot-cards-and-alignment-qc] 扩参仅 CLI 条服务端解析；旧服务端未升级时会整段忽略
	// （宽松超集），claims 判定字段缺席由调用方降级路兜底。
	if (shotCard?.highlightRubric?.trim()) reqBody.highlight_rubric = shotCard.highlightRubric.trim();
	if (shotCard?.claims?.some((c) => c !== null && c !== undefined && c.trim() !== "")) {
		reqBody.claims = shotCard.claims.map((c) => (c && c.trim() ? c.trim() : null));
	}
	const res = await deps.fetchFn(endpoint.url, {
		method: "POST",
		headers: { ...authHeaders(endpoint), "Content-Type": "application/json" },
		body: JSON.stringify(reqBody),
		signal: AbortSignal.timeout(deps.timeoutMs),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		const rejected = parseBusinessRejection(res.status, text);
		if (rejected) throw rejected;
		const err = new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
		// 限流打标（fix-embed-ratelimit-backoff §3）：429 与 5xx 同属传输面，但等法不同
		if (res.status === 429) (err as { rateLimited?: boolean }).rateLimited = true;
		throw err;
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
	shotCard?: DescribeShotCardOpts,
): Promise<MaterialDescribe[]> {
	if (imagesBase64.length === 0) return [];
	// 合规告知（add-compliance-notice 2.2）：素材理解的抽帧由此离机（matrix describe），
	// 同挂同一个幂等入口，提交发生前告知。零输入不算出口，故在早退之后。
	noticeOnce();
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
		// claims 与 images 逐图对位 → 随批切片（rubric 全批同一份）
		const batchShotCard: DescribeShotCardOpts | undefined = shotCard
			? { ...shotCard, claims: shotCard.claims?.slice(off, off + DESCRIBE_BATCH_MAX) }
			: undefined;
		// ── 提交阶段：指数退避重试（1s → 2s → 4s；仅传输面，业务拒绝短路）──
		let taskId: string | undefined;
		let lastErr = "";
		let lastRateLimited = false;
		for (let attempt = 0; attempt <= DESCRIBE_RETRIES; attempt++) {
			if (attempt > 0) {
				// 限流走窗口等待，其余仍 1s → 2s → 4s（与 embed 同款，见 rate-limit-wait.ts）。
				// ⚠️ 限值取 **30**（`describe_gateway_services.py:76`），不是 embed 的 60。
				const waitMs = lastRateLimited ? (deps.rateLimitWaitMs ?? nextRateLimitWaitMs()) : backoffBase * 2 ** (attempt - 1);
				if (lastRateLimited) log.warn(rateLimitWaitNotice(DESCRIBE_RATE_LIMIT_PER_MIN, waitMs, attempt, DESCRIBE_RETRIES));
				await sleep(waitMs);
			}
			try {
				taskId = await submitDescribeTask(endpoint, batch, { fetchFn, timeoutMs }, batchShotCard);
				break;
			} catch (e) {
				if ((e as { rejected?: unknown } | null)?.rejected === true) throw e; // 业务拒绝：重试无意义
				lastRateLimited = (e as { rateLimited?: unknown } | null)?.rateLimited === true;
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

/** 客观层行（[fix-highlight-rubric-wiring] 起不含 highlight——看点层已迁 describe_highlights）。 */
interface DescribeRow {
	desc_text: string;
	tags_json: string;
	mark: number | null;
	flags_json: string;
	subject: string | null;
	action: string | null;
	shot_size: string | null;
}

/**
 * 缓存读取（[fix-highlight-rubric-wiring] 两层）。
 *
 * **命中判据随准则分岔，这是零回归的关键**：
 * - **缺省桶**（`rubricHash` 缺省或 `L0`）：命中判据 = 客观层行存在，**与本件之前逐字节一致**。
 *   看点分取缺省桶，取不到就 null——本件之前那些 `highlight IS NULL` 的旧行本就走这一路。
 * - **非缺省桶**（显式传了准则）：命中判据 = 客观层行存在 **且** 该桶有看点分。
 *   客观层有、桶里没有 = 未命中 ⇒ 上层会重新调用看片通道。这不是浪费，是「换准则要重新打分」
 *   的必然代价（免看片的文本级重打分要服务端轻通道，尚未上线）。
 */
export function getCachedDescribe(
	db: SqlDb,
	materialId: string,
	tsMs: number,
	rubricHash: string = RUBRIC_DEFAULT_BUCKET,
): MaterialDescribe | undefined {
	const row = db.get<DescribeRow>(
		"SELECT desc_text, tags_json, mark, flags_json, subject, action, shot_size FROM describes WHERE material_id = ? AND ts_ms = ?",
		[materialId, tsMs],
	);
	if (!row) return undefined;
	const hl = db.get<{ highlight: number | null }>(
		"SELECT highlight FROM describe_highlights WHERE material_id = ? AND ts_ms = ? AND rubric_hash = ?",
		[materialId, tsMs, rubricHash],
	);
	// 非缺省桶且本桶无分 ⇒ 未命中（须按新准则重新打分）。缺省桶不受此限，见函数注释。
	if (!hl && rubricHash !== RUBRIC_DEFAULT_BUCKET) return undefined;
	try {
		return {
			desc: row.desc_text,
			tags: JSON.parse(row.tags_json) as string[],
			mark: row.mark ?? 0,
			usable_flags: JSON.parse(row.flags_json) as Record<string, boolean>,
			subject: row.subject ?? "",
			action: row.action ?? "",
			shot_size: row.shot_size ?? null,
			highlight: hl?.highlight ?? null,
		};
	} catch {
		return undefined; // 缓存行损坏当未命中（重新理解即自愈覆盖）
	}
}

/**
 * [fix-describe-cache-locality] 就近命中的时间距离上限（毫秒）。
 *
 * 判据不是「多远算远」而是「**多远还算同一个镜头**」——理解抽帧密度是「每 (beat, query, result)
 * 一帧」（只取 `segments[0]` 的 best），同一 result 的次级段与跨 beat 复用都会去够别的镜头的分。
 * 260828 走查实测：同素材相邻描述帧间隔中位 2–6s、**最大 191s**，无上限时分打给错镜头不是理论风险。
 *
 * 取 15s = 典型场景长度（密着长片实测 3–6s、段宽下限 1.5s、槽长区间 [1.5,8]s）的 2–5 倍：
 * 同镜头/同机位连拍的邻帧照常命中不误杀，跨场景串味被切断。**MUST NOT 取更严**（如 3s）——
 * describe 密度本就稀疏，过严会让绝大多数候选变中性，等于把权重关掉；本常量的目的是
 * **让权重打准，不是把它关掉**。超限恒走「中性」而非「零分」（不惩罚不加分）。
 */
export const DESCRIBE_NEAREST_MAX_GAP_MS = 15_000;

/**
 * mark 就近命中（add-audio-project-atoms mark-weight）：同素材内 |ts_ms 差| 最小的缓存条目的 mark。
 * 无任何缓存条目返回 undefined（消费方按中性处理，MUST NOT 变成变相剔除）；mark 列 NULL 按 0。
 * [fix-describe-cache-locality] 距离超 `DESCRIBE_NEAREST_MAX_GAP_MS` 一并按未命中处置。
 */
export function getNearestCachedMark(db: SqlDb, materialId: string, tsMs: number): number | undefined {
	const row = db.get<{ mark: number | null; ts_ms: number }>(
		"SELECT mark, ts_ms FROM describes WHERE material_id = ? ORDER BY ABS(ts_ms - ?) ASC LIMIT 1",
		[materialId, tsMs],
	);
	if (!row) return undefined;
	if (Math.abs(row.ts_ms - tsMs) > DESCRIBE_NEAREST_MAX_GAP_MS) return undefined; // 太远 = 别的镜头
	return row.mark ?? 0;
}

/**
 * [add-shot-cards-and-alignment-qc] highlight 就近命中（同 mark 家族）。
 * **与 mark 的关键差别**：mark 列 NULL 按 0 消费（旧行为），highlight 列 NULL 返回 undefined
 * ——旧缓存行没有这一维，当 0 会把老素材全部打成「零看点」静默沉底。
 * [fix-describe-cache-locality] 距离上限与 mark 同口径。
 */
export function getNearestCachedHighlight(
	db: SqlDb,
	materialId: string,
	tsMs: number,
	rubricHash: string = RUBRIC_DEFAULT_BUCKET,
): number | undefined {
	// [fix-highlight-rubric-wiring] 看点层改查 describe_highlights 并**按桶过滤**：
	// 甲准则打的分 MUST NOT 服务乙准则的排序（那是拿「判奇观地貌」的分去挑「大分量怼脸」的镜头）。
	// 15s 就近窗口语义一字不改。
	const row = db.get<{ highlight: number | null; ts_ms: number }>(
		"SELECT highlight, ts_ms FROM describe_highlights WHERE material_id = ? AND rubric_hash = ? AND highlight IS NOT NULL ORDER BY ABS(ts_ms - ?) ASC LIMIT 1",
		[materialId, rubricHash, tsMs],
	);
	if (!row) return undefined;
	if (Math.abs(row.ts_ms - tsMs) > DESCRIBE_NEAREST_MAX_GAP_MS) return undefined;
	return row.highlight ?? undefined;
}

/**
 * 缓存写入（[fix-highlight-rubric-wiring] 分层落库）。
 *
 * 客观层进 `describes`（一帧一份，换准则重跑会原样覆盖成同样的内容——无害）；
 * 看点分进 `describe_highlights` 的 `rubricHash` 桶（一帧 × N 套准则 N 份，互不覆盖）。
 * ⚠️ `describes.highlight` / `describes.rubric_hash` **不再写**（冻结列，理由见 local-index 迁移块）。
 */
export function putCachedDescribe(
	db: SqlDb,
	materialId: string,
	tsMs: number,
	d: MaterialDescribe,
	rubricHash: string = RUBRIC_DEFAULT_BUCKET,
): void {
	const now = new Date().toISOString();
	// 客观层 **OR IGNORE 而非 OR REPLACE**：spec「换准则 MUST NOT 覆盖或失效客观层」。
	// ⚠️ 这也正是本件之前的实际语义——那时客观层只在 `getCachedDescribe` 未命中（即行不存在）时才写，
	//    REPLACE 从来没真的覆盖过任何一行。本件新增了「客观层在、看点桶不在 ⇒ 重新调用」这条路径，
	//    继续用 REPLACE 就会让 VLM 每次的措辞漂移悄悄改写已落库的 desc（下游 at_sec / 叠加物交叉校验
	//    读的都是它）。客观层的刷新口径不变：仍只由素材指纹变化的级联清除触发。
	db.run(
		"INSERT OR IGNORE INTO describes(material_id, ts_ms, desc_text, tags_json, mark, flags_json, subject, action, shot_size, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
		[
			materialId,
			tsMs,
			d.desc,
			JSON.stringify(d.tags),
			d.mark,
			JSON.stringify(d.usable_flags),
			d.subject || null,
			d.action || null,
			d.shot_size,
			now,
		],
	);
	// 看点分缺席（旧服务端不给这一维）时不落桶——落一行 NULL 会让「本桶已打过分」与
	// 「本桶没有分」不可分辨，正是 getCachedDescribe 的命中判据要区分的那件事。
	if (d.highlight !== null && d.highlight !== undefined) {
		db.run(
			"INSERT OR REPLACE INTO describe_highlights(material_id, ts_ms, rubric_hash, highlight, created_at) VALUES (?,?,?,?,?)",
			[materialId, tsMs, rubricHash, d.highlight, now],
		);
	}
}

// ── 叠加物交叉校验（add-describe-flag-desc-crosscheck）─────────────────────────────
//
// 起因（真机硬证据，260902）：本地索引库 `describes` 表里
// `broll-local-e28be73e24d82c35 @111117ms` 一条，
//   flags_json = {"black_border":false,"blurry":false,"text_overlay":false,"watermark":false}
//   desc_text  = 「…画面左上角有'REC'等视频录制界面元素，似拍摄中的一帧。」
// **模型在自己的 desc 里已经写出了取景器 HUD，`text_overlay` 仍判 false。**
// 起草期一度怀疑是 CLI 只喂 512px 缩略帧「把字打瞎」，已被证伪：按 CLI 现行 512px 口径
// 把该帧重抽出来目视核对，REC / RAW 16:9 / Menu / 时码 00:16:30:26 / 电量与 2 min 全部清晰可读
// ⇒ 是「看见了却不打标」，不是「看不见」。真根因在服务端提示词的保守偏置
// （`material_describe_handler.py:127` "when uncertain, use false"），由 infra 侧另件承接。
//
// 本零件做的是**纯本地、零计费、零额外调用**的兜底：desc 说了、flag 没打，就如实报一条。
// 它独立于服务端提示词 —— 即使将来 prompt 回归，这条判据仍在。
//
// ⚠️ MUST NOT 据此覆写 flag。既有条款「CLI MUST NOT 依据 flags 自动剔除候选（信号归裁定层，
//    零件不裁定）」同理适用于反向：CLI 报差异，裁定权仍在人/agent 手里。

/** 交叉校验覆盖的三维「叠加物」信号（`blurry` 不是叠加物，不在射程内）。 */
export type OverlayFlagDim = "text_overlay" | "watermark" | "black_border";

/**
 * desc 文本里的**叠加物特征词**。
 *
 * 词表是拿本机 341 条真实 describe 反复收敛出来的，**收紧是刻意的**——
 * 判据要的是精确率不是召回率：报错一次，用户下次就不信这条提示了。
 * 实测（341 条全库跑）：命中 2 条，其中 1 条 flag 已为 true（不报），
 * 1 条正是上面那条 REC 漏判，**零误报**。
 *
 * 明确**排除**的高频陷阱词（各带全库实测计数，别再往回加）：
 *   - `贴纸`：4 条命中全是**画面内**贴纸（自动售货机机身贴纸 ×2、木墙贴纸、门上卡通贴纸），
 *     不是叠加层；
 *   - `标识 / logo / 标志 / 招牌`：10 条命中全是**画面内**招牌（VENDOR 售货机、KIRIN 店招、
 *     禁停标志、日文商品包装），不是台标水印；
 *   - 光秃秃的 `文字 / 文本`：中日文街景里画面内文字遍地都是，单独当判据必然刷屏。
 * ⇒ 只有**叠加语义自带**的词才进表（`叠加`/`字幕`/`时码`/`录制界面`/`水印`/`台标`/`黑边`…）。
 */
export const OVERLAY_DESC_CUES: Record<OverlayFlagDim, RegExp[]> = {
	text_overlay: [
		/字幕/,
		/叠加(?:文字|文本|字幕|层)?/,
		/时间码/,
		/时码/,
		/录制界面/,
		/界面元素/,
		/取景器/,
		/花字/,
		/弹幕/,
		/标题卡/,
		/\bHUD\b/i,
		/\bREC\b/, // 大小写敏感：录制指示灯恒为大写 REC，小写 rec 多半是 record 的词根
		/\bsubtitle/i,
		/\btimecode\b/i,
		/\bviewfinder\b/i,
		/\boverlaid?\s+text\b/i,
		/\btext\s+overlay\b/i,
	],
	watermark: [/水印/, /台标/, /频道标/, /角标/, /\bwatermark\b/i],
	black_border: [/黑边/, /信箱式?画幅/, /上下(?:有|是)?黑(?:色)?(?:边|条|块|带)/, /左右(?:有|是)?黑(?:色)?(?:边|条|块|带)/, /\bletterbox/i, /\bpillarbox/i],
};

/**
 * 单条产物的交叉校验：返回「desc 里提到了、flag 却是 false」的维度。
 * 纯函数、零 IO。flag 已为 true 的维度不报（本来就打对了）。
 */
export function crossCheckFlagsAgainstDesc(d: Pick<MaterialDescribe, "desc" | "usable_flags">): OverlayFlagDim[] {
	const text = d.desc ?? "";
	if (!text) return [];
	const out: OverlayFlagDim[] = [];
	for (const dim of Object.keys(OVERLAY_DESC_CUES) as OverlayFlagDim[]) {
		if (d.usable_flags?.[dim] === true) continue; // 已打标，无差异可报
		if (OVERLAY_DESC_CUES[dim].some((re) => re.test(text))) out.push(dim);
	}
	return out;
}

export interface FlagDescMismatchItem {
	materialId: string;
	tsMs: number;
	dims: OverlayFlagDim[];
	/** desc 摘录（截断，只为让人认出是哪一帧）。 */
	excerpt: string;
}

export interface FlagDescMismatchSummary {
	/** 有差异的条目数（不是维度数）。 */
	count: number;
	/** 逐维计数（同一条可同时命中多维，各计各的）。 */
	byDim: Partial<Record<OverlayFlagDim, number>>;
	/** 逐条明细（全量，文案侧自行截断）。 */
	items: FlagDescMismatchItem[];
}

/** 样本行在提示文案里的展示上限（多了刷屏，机读侧读 `items` 拿全量）。 */
const MISMATCH_SAMPLE_LIMIT = 5;

/**
 * 批量汇总：对一轮 describe 的产物（**含缓存命中项**——缓存里的旧条目同样受检，
 * 且这一路零调用零计费）逐条交叉校验。无差异返回 null（不打扰）。
 */
export function summarizeFlagDescMismatch(
	rows: Array<{ materialId: string; tsMs: number; describe: MaterialDescribe | null }>,
): FlagDescMismatchSummary | null {
	const items: FlagDescMismatchItem[] = [];
	const byDim: Partial<Record<OverlayFlagDim, number>> = {};
	const seen = new Set<string>();
	for (const r of rows) {
		if (!r.describe) continue;
		const key = `${r.materialId}@${r.tsMs}`;
		if (seen.has(key)) continue; // 同帧多引用只报一次（与 describe 的唯一键去重同口径）
		seen.add(key);
		const dims = crossCheckFlagsAgainstDesc(r.describe);
		if (dims.length === 0) continue;
		for (const d of dims) byDim[d] = (byDim[d] ?? 0) + 1;
		items.push({ materialId: r.materialId, tsMs: r.tsMs, dims, excerpt: r.describe.desc.slice(0, 60) });
	}
	if (items.length === 0) return null;
	return { count: items.length, byDim, items };
}

/**
 * 提示文案（良性降级打可读 INFO：这是「信号可能不全」的告知，不是失败，
 * MUST NOT 抛成 warn/error 去吓人，也 MUST NOT 静默吞掉）。
 */
export function flagDescMismatchNote(s: FlagDescMismatchSummary): string {
	const dimNote = (Object.keys(s.byDim) as OverlayFlagDim[]).map((d) => `${d} ${s.byDim[d]}`).join(" · ");
	const lines = s.items
		.slice(0, MISMATCH_SAMPLE_LIMIT)
		.map((it) => `     · ${it.materialId} @${(it.tsMs / 1000).toFixed(1)}s [${it.dims.join("/")}] ${it.excerpt}`);
	const more = s.items.length > MISMATCH_SAMPLE_LIMIT ? `\n     · …另 ${s.items.length - MISMATCH_SAMPLE_LIMIT} 条（--json 读 flag_desc_mismatch.items 拿全量）` : "";
	return (
		`叠加物交叉校验：${s.count} 项的 desc 自己描述了叠加元素、对应 usable_flags 仍为 false（${dimNote}）。\n` +
		`   这是模型「看见了却没打标」的形态（真机 260902 已实证），⇒ MUST NOT 把 flag=false 当作「画面没有叠加元素」的证明，这几帧请人工复核：\n` +
		`${lines.join("\n")}${more}\n` +
		`   CLI 只报差异、不改写 flag（信号归裁定层，零件不裁定）。`
	);
}

/**
 * 注入 plan result 的裁剪形态（describe 字段随 plan 流转，broll-plan-contract delta）。
 *
 * `atSec`（fix-describe-window-coverage）：本条产物出自的帧时刻（素材时基秒），写成 `at_sec`。
 * ⚠️ **图片候选 MUST 不传**（缓存键 ts=0 是缓存键、不是时刻，写 0 就是误导性锚点：
 * 会让下游以为「这条判决只代表第 0 秒那一段」，而图片的射程本就是整条素材）。
 * 缺省时下游按 `segments[0]` 推定并标注为「推定」——见 `matrix.ts` 的 `describeScopeOf`。
 */
export function toDescribeMeta(d: MaterialDescribe, atSec?: number): MaterialDescribeMeta {
	return {
		desc: d.desc,
		tags: d.tags,
		mark: d.mark,
		usable_flags: d.usable_flags,
		...(d.subject ? { subject: d.subject } : {}),
		...(d.action ? { action: d.action } : {}),
		...(d.shot_size ? { shot_size: d.shot_size } : {}),
		...(d.highlight !== null && d.highlight !== undefined ? { highlight: d.highlight } : {}),
		...(typeof atSec === "number" && Number.isFinite(atSec) ? { at_sec: atSec } : {}),
	};
}

// ── 理解覆盖率（fix-describe-window-coverage：一帧的判决能代表多长的时间）─────────────

/** 一轮 `--plan` 理解的**段覆盖率**账面。 */
export interface DescribeCoverage {
	/** 被理解的帧数（当前口径每候选恰一帧，恒 = 被注入的视频候选数）。 */
	frames: number;
	/** 这些候选携带的 segment 总数 —— 分母。**不是候选数**。 */
	segments: number;
	/** frames / segments；分母为 0 时为 1（没有段可覆盖 ⇒ 不报 0% 吓人）。 */
	ratio: number;
	/** 图片候选数：无时间轴、射程天然是整条素材 ⇒ **不进分子也不进分母**（matrix-describe spec）。 */
	imageCandidates: number;
}

/**
 * 段覆盖率统计（纯函数，零 IO）。
 *
 * 为什么这个数必须报出来：此前回写摘要只说「注入 N 条 result.describe」，**N 是候选数不是段数**，
 * 读者（人与 agent）会读成「这 N 条候选都被看过了」。真机 260902 两份 plan 的真值是
 * **32 帧 / 843 段 = 3.8%** —— 96.2% 的段一眼都没被看过。
 * 走**非致命 INFO** 档（良性降级打可读 INFO）：它是「信号只覆盖了这么点」的告知，不是失败。
 */
export function summarizeDescribeCoverage(rows: Array<{ image: boolean; segments: number }>): DescribeCoverage {
	let frames = 0;
	let segments = 0;
	let imageCandidates = 0;
	for (const r of rows) {
		if (r.image) {
			imageCandidates++;
			continue;
		}
		frames++;
		// 无 segments 的退化候选按 1 段计：铺轨侧 segmentsOf 会给它合成一个整片伪段，
		// 那一段确实被这一帧代表了 ⇒ 计 1/1，MUST NOT 计 0（0 会把分母做小、把覆盖率吹高）。
		segments += Math.max(1, r.segments);
	}
	return { frames, segments, ratio: segments > 0 ? frames / segments : 1, imageCandidates };
}

/** 覆盖率人读文案（INFO 档）。措辞 MUST NOT 把 flags 说成候选级 / 素材级结论。 */
export function describeCoverageNote(c: DescribeCoverage): string {
	const pct = (c.ratio * 100).toFixed(1);
	const img = c.imageCandidates > 0 ? `（另有 ${c.imageCandidates} 个图片候选：无时间轴，射程即整条素材，不进本比值）` : "";
	return (
		`理解覆盖率：${c.frames} 帧 / ${c.segments} 段 = ${pct}%${img}。\n` +
		`   --plan 每个候选只抽 segments[0] 的 best **一帧** ⇒ 本条 describe（desc/tags/mark/usable_flags）` +
		`只代表**该帧所属的那一段**，MUST NOT 读成候选级或素材级结论；其余段一眼都没被看过。\n` +
		`   射程锚点已写进 result.describe.at_sec（素材时基秒），铺轨据此把 flags 收窄到射程内的段。`
	);
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
	/** 计费身份豁免探测（复用 probeGcMemberType，**gc_member_type** 不是 matrix_member_type）。
	 * [fix-describe-billing-report-honesty] 触发条件已由「护栏触发」改成「本次有实际调用」——
	 * 护栏只消费结果，不再兼任探测开关；`pending` 为空（全缓存命中）时仍不调，保持零云端请求。
	 * 单次 runDescribeItems 至多调一次（下方只有一个调用点）。 */
	probeExempt: () => Promise<boolean>;
	yes: boolean;
	/** 抽帧临时目录（即传即弃，整目录清理兜底）。 */
	frameDir: string;
	onLog?: (line: string) => void;
	/** 测试注入：direct 直传的文件读取。 */
	readFileBase64?: (path: string) => string;
	/** [fix-highlight-rubric-wiring] 本轮生效的看点准则分桶键（缺省 `L0`）。
	 * 只影响缓存命中判据与落桶；**准则正文的上行归 `describeBatch` 闭包**（命令层组装），
	 * 本函数不碰网络参数——否则同一件事会有两个真相来源。 */
	rubricHash?: string;
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
	/** 预估积分——**实耗口径**（fix-describe-billing-report-honesty）：豁免时恒 0。
	 * 服务端 `skip_quota_check=is_internal_member(user_id)` 时预扣整段短路（record_id 恒 null，
	 * 结算侧 `if record_id:` 二重兜底），豁免账号真扣 0；报原价就是报了一个不会发生的数。
	 * 要原价读 `creditsWouldBe`。 */
	estimatedCredits: number;
	/** 原价（= pending × 单价），恒出——供解释「省了多少」。 */
	creditsWouldBe: number;
	/** 计费身份豁免（`gc_member_type=internal`）。**有实际调用时恒出**；
	 * pending 为空（全缓存命中、无扣费可报）时缺席。 */
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
	const rubricHash = deps.rubricHash ?? RUBRIC_DEFAULT_BUCKET;
	const resolved = new Map<string, MaterialDescribe | null>();
	// ── 缓存短路：唯一键逐个查 describes（同素材同帧免重复调用——缓存即钱）──
	// [fix-highlight-rubric-wiring] 命中判据带桶：缺省桶与本件之前逐字节一致；
	// 非缺省桶要求该桶已有看点分，否则按未命中重新打分（换准则的必然代价，见 getCachedDescribe）。
	const pending: DescribeWorkItem[] = [];
	for (const it of items) {
		const key = keyOf(it);
		if (resolved.has(key)) continue;
		const hit = getCachedDescribe(deps.db, it.materialId, it.tsMs, rubricHash);
		if (hit) resolved.set(key, hit);
		else {
			resolved.set(key, null); // 占位（防同键重复进 pending）
			pending.push(it);
		}
	}
	const cached = resolved.size - pending.length;
	const creditsWouldBe = pending.length * DESCRIBE_CREDITS_PER_IMAGE;

	// ── 计费身份探测（fix-describe-billing-report-honesty）──────────────────────────────
	// 此前这一句焊死在下方 `pending > 20` 的护栏内部 ⇒ **≤20 张的运行从不探身份**，
	// `exempt` 恒 undefined、报数恒落非豁免分支按原价走。真机 260902 三条旅拍片
	// 单次 pending 分别是 6 / 13 / 8 张，三次全落在这个洞里，执行方把相加得来的
	// 「≈27 积分」当实耗转述给了用户——豁免账号被误告知要花钱，非豁免账号只是碰巧蒙对。
	// 现在判据改成「本次有没有实际调用」：有调用就探一次（护栏只消费结果，不再兼任探测开关）。
	// ⚠️ `pending` 为空（全缓存命中）SHALL NOT 探——那次运行既无扣费也无数可报，
	//    MUST NOT 为了拿身份给零调用的运行白加一次云端请求。
	// ⚠️ 全函数只有这一个探测点 ⇒ 单次运行至多一次 get_user_info（别在护栏里再探一次）。
	let exempt: boolean | undefined;
	if (pending.length > 0) exempt = await deps.probeExempt();
	const estimatedCredits = exempt ? 0 : creditsWouldBe;

	// ── 确认护栏（spec：单次将调用 >20 张时提示预估积分并确认）──
	// ⚠️ 阈值 20 一字不动：本件只解耦探测，MUST NOT 顺手改护栏本身的触发条件。
	if (pending.length > DESCRIBE_CONFIRM_THRESHOLD) {
		const hint = exempt
			? `本次将实际调用素材理解 ${pending.length} 张（另 ${cached} 张缓存命中零计费），` +
				`原价 ${creditsWouldBe} 积分，本次实耗 0`
			: `本次将实际调用素材理解 ${pending.length} 张（另 ${cached} 张缓存命中零计费），` +
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
					creditsWouldBe,
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
					putCachedDescribe(deps.db, r.item.materialId, r.item.tsMs, d, rubricHash);
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
		creditsWouldBe,
		...(exempt !== undefined ? { exempt } : {}),
		results,
	};
}
