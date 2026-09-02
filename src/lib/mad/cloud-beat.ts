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

/**
 * 从 output_result 提取 beats/downbeats/bpm/highlight（宽容读取）。
 *
 * `highlight`（redesign-beat-align-climax-anchor）：服务端 `audio_music_analyze` 早就返回
 * `{"highlight": {"time": float} | None}`，全链无过滤无截断（handler `return result` →
 * `mq/consumer.py:324-325` 原样回传 → `internal_task_services.py:153` 整体序列化、体积护栏只告警
 * 不截断 → `task_services.py:229/249` 整体回吐 → `src/lib/cloud.ts:166` `output_result` 整体透传），
 * 唯独**在本函数的返回字面量里被丢掉**。2026-09-02 抽查 `audio_music_analyze.py:100/114` 与
 * `cloud.ts:166` 两跳在位，确认缺口 100% 在 CLI 侧 ⇒ 这里读回来即可，infra 零改动。
 *
 * ⚠️ 缺失即 `undefined`，**MUST NOT** 因为缺它而抛错：音频 < 10s 时服务端合法返回 `None`。
 */
export function extractAnalysis(output: unknown): BeatAnalysis {
	const o = (output ?? {}) as Record<string, unknown>;
	const arr = (v: unknown): number[] =>
		Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : [];
	// 宽容读法照抄 arr()：对象 + 有限数才取，其余（null / 字符串 / 缺键）一律 undefined。
	const hl = o.highlight;
	const hlTime =
		hl && typeof hl === "object" ? (hl as Record<string, unknown>).time : undefined;
	return {
		bpm: typeof o.bpm === "number" ? o.bpm : undefined,
		beats: arr(o.beats),
		downbeats: arr(o.downbeats),
		highlightSec: typeof hlTime === "number" && Number.isFinite(hlTime) ? hlTime : undefined,
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
