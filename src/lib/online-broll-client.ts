/** 私有外网素材任务传输；复用普通 CLI 鉴权与持久任务查询。 */
import type { CloudConfig } from "./config";
import { randomUUID } from "node:crypto";
import { pollTask, submitTask } from "./cloud";
import type { PlanResult } from "./matrix";
import { parseOnlineOrigin, type OnlinePlatform } from "./online-broll-contract";

export interface OnlineSearchRequest {
	query: string;
	platforms?: OnlinePlatform[];
	discovery_queries?: string[];
	max_videos?: number;
	top_k?: number;
}

export interface OnlineSearchResult {
	results: PlanResult[];
	platforms: Record<string, unknown>[];
	failures: Record<string, unknown>[];
	manifest: { url: string; file_id: string };
}

export interface OnlineSearchSubmission {
	requestId: string;
	request: OnlineSearchRequest;
}

export function onlineSearchOutcome(value: Pick<OnlineSearchResult, "results" | "platforms" | "failures">): "ready" | "partial" | "empty" | "unavailable" {
	const degraded = value.failures.length > 0
		|| value.platforms.some(p => p.status === "unavailable" || p.status === "partial");
	return value.results.length > 0 ? (degraded ? "partial" : "ready") : (degraded ? "unavailable" : "empty");
}

function searchPayload(request: OnlineSearchRequest): OnlineSearchRequest {
	// 固定字段顺序并复制数组；恢复必须使用首次保存的完整参数。
	return { query: request.query,
		...(request.platforms !== undefined ? { platforms: [...request.platforms] } : {}),
		...(request.discovery_queries !== undefined ? { discovery_queries: [...request.discovery_queries] } : {}),
		...(request.max_videos !== undefined ? { max_videos: request.max_videos } : {}),
		...(request.top_k !== undefined ? { top_k: request.top_k } : {}) };
}

export function parseOnlineSearchResult(raw: unknown): OnlineSearchResult {
	if (!raw || typeof raw !== "object") throw new Error("外网检索结果不是对象");
	const value = raw as Record<string, unknown>;
	if (!Array.isArray(value.results) || !Array.isArray(value.platforms) || !Array.isArray(value.failures))
		throw new Error("外网检索结果缺少候选或平台状态");
	const results = value.results.map((item: unknown): PlanResult => {
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
	return { results, platforms: value.platforms, failures: value.failures,
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
	const taskId = await submitTask(cfg, "cli/online_broll_search", body);
	await hooks.onSubmitted?.(taskId);
	return { ...await resumeOnlineBroll(cfg, taskId, hooks.onTick), task_id: taskId };
}

export async function resumeOnlineBroll(
	cfg: CloudConfig, taskId: string, onTick?: (status: string, progress?: number) => void,
): Promise<OnlineSearchResult> {
	if (!/^\d+$/.test(taskId)) throw new Error("外网检索任务 ID 无效");
	return parseOnlineSearchResult(await pollTask(cfg, "cli/online_broll_search", taskId, onTick));
}
