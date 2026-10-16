/** 私有外网素材任务传输；复用普通 CLI 鉴权与持久任务查询。 */
import type { CloudConfig } from "./config";
import { randomUUID } from "node:crypto";
import { CloudError, cloudErrorCode, pollTask, submitTask } from "./cloud";
import type { PlanResult } from "./matrix";
import { LEGACY_ONLINE_PLATFORMS, parseOnlineOrigin, type OnlinePlatform } from "./online-broll-contract";

export interface OnlineSearchRequest {
	need?: import("./online-broll-needs").OnlineMaterialNeed;
	query: string;
	platforms?: OnlinePlatform[];
	discovery_queries?: string[];
	max_videos?: number;
	top_k?: number;
}

export interface OnlineSearchResult {
	diagnostics?: Record<string, unknown>;
	results: PlanResult[];
	platforms: Record<string, unknown>[];
	failures: Record<string, unknown>[];
	manifest: { url: string; file_id: string };
}

export interface SourceImportRequest { source_urls: string[] }
export type OnlineRequest = OnlineSearchRequest | SourceImportRequest;

export interface OnlineSearchSubmission {
	requestId: string;
 request: OnlineRequest;
}

export function onlineSearchOutcome(value: Pick<OnlineSearchResult, "results" | "platforms" | "failures">): "ready" | "partial" | "empty" | "unavailable" {
	// 服务端未开启的平台（目前只有 pexels 会报 disabled）只是提示，不参与降级判定
	const active = value.platforms.filter(p => p.status !== "disabled");
	const degraded = value.failures.length > 0
		|| active.some(p => p.status === "unavailable" || p.status === "partial");
	return value.results.length > 0 ? (degraded ? "partial" : "ready") : (degraded ? "unavailable" : "empty");
}

export function searchPayload(request: OnlineRequest): OnlineRequest {
 if ("source_urls" in request) return { source_urls: [...request.source_urls] };
	// 固定字段顺序并复制数组；恢复必须使用首次保存的完整参数。
	return { query: request.query,
		...(request.need ? { need: structuredClone(request.need) } : {}),
		...(request.platforms !== undefined ? { platforms: [...request.platforms] } : {}),
		...(request.discovery_queries !== undefined ? { discovery_queries: [...request.discovery_queries] } : {}),
		...(request.max_videos !== undefined ? { max_videos: request.max_videos } : {}),
		...(request.top_k !== undefined ? { top_k: request.top_k } : {}) };
}

/** 署名对象（Pexels 等）：provider / text / https url 三项齐全才保留，坏项丢弃。 */
function parseAttributions(raw: unknown): { provider: string; text: string; url: string }[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item: unknown) => {
		if (!item || typeof item !== "object") return [];
		const a = item as Record<string, unknown>;
		if (typeof a.provider !== "string" || !a.provider || typeof a.text !== "string" || !a.text
			|| typeof a.url !== "string" || !a.url.startsWith("https://")) return [];
		return [{ provider: a.provider, text: a.text, url: a.url }];
	});
}

export function parseOnlineSearchResult(raw: unknown): OnlineSearchResult {
	if (!raw || typeof raw !== "object") throw new Error("外网检索结果不是对象");
	const value = raw as Record<string, unknown>;
	if (!Array.isArray(value.results) || !Array.isArray(value.platforms) || !Array.isArray(value.failures))
		throw new Error("外网检索结果缺少候选或平台状态");
	if (value.review_candidates !== undefined && !Array.isArray(value.review_candidates)) throw new Error("外网待核候选格式错误");
	const results = [...value.results, ...(value.review_candidates as unknown[] ?? [])].map((item: unknown): PlanResult => {
		if (!item || typeof item !== "object") throw new Error("外网候选格式错误");
		const candidate = item as Record<string, unknown>;
		if (candidate.score_model !== undefined && candidate.score_model !== "qwen-vl-reranker" && candidate.score_model !== "jina-clip-cosine")
			throw new Error("外网候选评分模型不支持");
		if (candidate.vector_score !== undefined && (typeof candidate.vector_score !== "number" || !Number.isFinite(candidate.vector_score)
			|| candidate.vector_score < -1 || candidate.vector_score > 1)) throw new Error("外网候选向量评分无效");
		const origin = parseOnlineOrigin(candidate.origin);
		if (!origin || typeof candidate.clip_id !== "string" || !/^online-[0-9a-f]{24}$/.test(candidate.clip_id)
			|| typeof candidate.score !== "number" || !Number.isFinite(candidate.score))
			throw new Error("外网候选来源、标识或评分无效");
		for (const key of ["duration", "width", "height", "fps"])
			if (typeof candidate[key] !== "number" || !Number.isFinite(candidate[key]) || (candidate[key] as number) <= 0)
				throw new Error(`外网候选 ${key} 无效`);
		if (!Array.isArray(candidate.segments) || candidate.segments.length !== 1)
			throw new Error("外网候选必须对应一个镜头");
		const segment = candidate.segments[0] as Record<string, unknown> | null;
		if (!segment || segment.start !== origin.source_start || segment.end !== origin.source_end
			|| typeof segment.best !== "number" || !Number.isFinite(segment.best)
			|| segment.best < origin.source_start || segment.best >= origin.source_end)
			throw new Error("外网镜头时间窗不一致");
		return { ...candidate, origin } as unknown as PlanResult;
	});
	const manifest = value.manifest as Record<string, unknown> | null;
	if (!manifest || typeof manifest.url !== "string" || !manifest.url.startsWith("https://")
		|| typeof manifest.file_id !== "string" || !/^\d+$/.test(manifest.file_id))
		throw new Error("外网检索缺少完整镜头清单引用");
	const attributions = parseAttributions(value.attributions);
	return { results, platforms: value.platforms, failures: value.failures,
		diagnostics: {
			...Object.fromEntries(["need", "budget", "stop_reason", "source_screening", "discovery_queries", "score_model", "degraded_reason", "cache"].filter(k => value[k] !== undefined).map(k => [k, value[k]])),
			...(attributions.length ? { attributions } : {}),
		},
		manifest: { url: manifest.url, file_id: manifest.file_id } };
}

export async function searchOnlineBroll(
	cfg: CloudConfig, request: OnlineSearchRequest,
	hooks: {
		submission?: OnlineSearchSubmission;
		onSubmitting?: (submission: OnlineSearchSubmission) => void | Promise<void>;
		onSubmitted?: (taskId: string) => void | Promise<void>;
		onTick?: (status: string, progress?: number) => void;
	} = {},
): Promise<OnlineSearchResult & { task_id: string }> {
	const payload = searchPayload(request);
	const submission = hooks.submission ?? { requestId: randomUUID(), request: payload };
	if (!/^[A-Za-z0-9_-]{16,128}$/.test(submission.requestId)
		|| JSON.stringify(searchPayload(submission.request)) !== JSON.stringify(payload))
		throw new Error("外网检索恢复记录与本次请求不一致");
	const body = { ...payload, request_id: submission.requestId };
	// 先保存再发 POST；响应丢失也能按同一身份查回，保存失败不得建单。
	await hooks.onSubmitting?.(structuredClone(submission));
	let taskId: string;
	try {
		taskId = await submitTask(cfg, "cli/online_broll_search", body);
	} catch (error) {
		// 旧服务端不认 pexels：给出可执行的提示。不自动去掉 pexels 重试——改平台即改请求身份，
		// 会绕开续跑记录、多扣一笔
		if (cloudErrorCode(error) === 6016 && error instanceof Error && error.message.includes("platforms")
			&& request.platforms?.includes("pexels"))
			throw new CloudError(6016, `${error.message}。服务端尚未支持 Pexels；可加 --platforms ${LEGACY_ONLINE_PLATFORMS.join(",")} 继续`);
		throw error;
	}
	await hooks.onSubmitted?.(taskId);
	return { ...await resumeOnlineBroll(cfg, taskId, hooks.onTick), task_id: taskId };
}

export async function resumeOnlineBroll(
	cfg: CloudConfig, taskId: string, onTick?: (status: string, progress?: number) => void,
): Promise<OnlineSearchResult> {
	if (!/^\d+$/.test(taskId)) throw new Error("外网检索任务 ID 无效");
	return parseOnlineSearchResult(await pollTask(cfg, "cli/online_broll_search", taskId, onTick));
}
