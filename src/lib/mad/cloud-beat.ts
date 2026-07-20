/**
 * MAD BGM 云端节拍分析（add-tool-mad D8）：复用公共任务 audio_music_analyze（infra 零改动）。
 *
 * 复用族 runner 的 pollToolTask（轮询语义对齐 pollTask）与 uploadAndSubmitTask（6004 共享恢复）。
 */
import type { CloudConfig } from "../config";
import { submitTask } from "../cloud";
import { uploadCached, invalidateUpload } from "../upload-cache";
import { uploadAndSubmitTask } from "../upload-submit";
import { pollToolTask } from "../tool-runner";
import type { BeatAnalysis } from "./beat";

const ANALYZE_TASK = "audio_music_analyze";

export interface BeatCloudDeps {
	uploadCached: typeof uploadCached;
	invalidateUpload: typeof invalidateUpload;
	submitTask: typeof submitTask;
	pollToolTask: typeof pollToolTask;
	sleep?: (ms: number) => Promise<void>;
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
	const payload = (fid: string) => ({ file_id: fid });
	const submitted = await uploadAndSubmitTask(cfg, bgmAbs, ANALYZE_TASK, payload, {}, {
		uploadCached: deps.uploadCached,
		invalidateUpload: deps.invalidateUpload,
		submitTask: deps.submitTask,
		sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
	});
	const { taskId } = submitted;
	const output = await deps.pollToolTask(cfg, ANALYZE_TASK, taskId, {});
	return extractAnalysis(output);
}
