/**
 * MAD BGM 云端节拍分析（add-tool-mad D8）：复用公共任务 audio_music_analyze（infra 零改动）。
 *
 * 复用族 runner 的 pollToolTask（轮询语义对齐 pollTask）+ cloud.submitTask + upload-cache。
 * 6004 失效重传：族 runner 的收编逻辑内嵌在 runCloudTool（未导出独立 helper），mad 的音频分析走独立
 * 上传/提交（非 runCloudTool 全链），故在此以同一口径（invalidateUpload + force 重传 + 重提交一次）内联
 * 一次——对齐 oralcut/runner 既有行为，不改沉淀 lib（红线）。
 */
import type { CloudConfig } from "../config";
import { submitTask } from "../cloud";
import { uploadCached, invalidateUpload } from "../upload-cache";
import { pollToolTask } from "../tool-runner";
import type { BeatAnalysis } from "./beat";

const ANALYZE_TASK = "audio_music_analyze";

/** 鸭子判定 CloudError 6004（跨 bundle 稳，与 runner 同口径）。 */
function isCode(e: unknown, code: number): boolean {
	return !!e && typeof e === "object" && (e as { code?: unknown }).code === code;
}

export interface BeatCloudDeps {
	uploadCached: typeof uploadCached;
	invalidateUpload: typeof invalidateUpload;
	submitTask: typeof submitTask;
	pollToolTask: typeof pollToolTask;
}

/** 从 output_result 提取 beats/downbeats/bpm（宽容读取）。 */
export function extractAnalysis(output: unknown): BeatAnalysis {
	const o = (output ?? {}) as Record<string, unknown>;
	const arr = (v: unknown): number[] =>
		Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : [];
	return {
		bpm: typeof o.bpm === "number" ? o.bpm : undefined,
		beats: arr(o.beats),
		downbeats: arr(o.downbeats),
	};
}

/**
 * 上传 BGM → 提交 audio_music_analyze（6004 失效重传一次）→ 轮询 → 提取节拍。
 * 抛错交上层降级（不在此吞）。
 */
export async function analyzeBgm(
	cfg: CloudConfig,
	bgmAbs: string,
	deps: BeatCloudDeps,
): Promise<BeatAnalysis> {
	let up = await deps.uploadCached(cfg, bgmAbs, {});
	const payload = (fid: string) => ({ file_id: fid });
	let taskId: string;
	try {
		taskId = await deps.submitTask(cfg, ANALYZE_TASK, payload(up.fileId));
	} catch (e) {
		if (up.cached && isCode(e, 6004)) {
			await deps.invalidateUpload(bgmAbs);
			up = await deps.uploadCached(cfg, bgmAbs, { force: true });
			taskId = await deps.submitTask(cfg, ANALYZE_TASK, payload(up.fileId));
		} else throw e;
	}
	const output = await deps.pollToolTask(cfg, ANALYZE_TASK, taskId, {});
	return extractAnalysis(output);
}
