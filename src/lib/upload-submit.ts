/**
 * 上传并提交云任务的共享恢复边界。
 *
 * 只对服务端明确返回的 6004（素材暂不可见/已失效）重提：
 * - 新上传 file_id：短退避后复用同一 ID，不重复上传；
 * - 缓存 file_id：首次 6004 即失效缓存、强制重传一次，再按新 ID 退避。
 * 网络断连/解析失败无业务 code，绝不自动重提计费任务。
 */
import type { CloudConfig } from "./config";
import { cloudErrorCode, submitTask } from "./cloud";
import { invalidateUpload, uploadCached } from "./upload-cache";

const MATERIAL_NOT_FOUND = 6004;
export const DEFAULT_VISIBILITY_BACKOFF_MS = [250, 750, 1500, 3000] as const;

export interface UploadSubmitDeps {
	uploadCached: typeof uploadCached;
	invalidateUpload: typeof invalidateUpload;
	submitTask: typeof submitTask;
	sleep: (ms: number) => Promise<void>;
}

export interface UploadSubmitOptions {
	force?: boolean;
	visibilityBackoffMs?: readonly number[];
	onUploaded?: (uploaded: { fileId: string; cached: boolean }) => void;
	onCacheInvalid?: () => void;
}

export interface UploadSubmitResult {
	taskId: string;
	fileId: string;
	cached: boolean;
}

const defaultDeps: UploadSubmitDeps = {
	uploadCached,
	invalidateUpload,
	submitTask,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function submitFreshFile(
	cfg: CloudConfig,
	taskType: string,
	fileId: string,
	buildPayload: (fileId: string) => unknown,
	backoffMs: readonly number[],
	deps: UploadSubmitDeps,
): Promise<string> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await deps.submitTask(cfg, taskType, buildPayload(fileId));
		} catch (error) {
			if (cloudErrorCode(error) !== MATERIAL_NOT_FOUND || attempt >= backoffMs.length) throw error;
			await deps.sleep(backoffMs[attempt]!);
		}
	}
}

export async function uploadAndSubmitTask(
	cfg: CloudConfig,
	path: string,
	taskType: string,
	buildPayload: (fileId: string) => unknown,
	options: UploadSubmitOptions = {},
	deps: UploadSubmitDeps = defaultDeps,
): Promise<UploadSubmitResult> {
	let uploaded = await deps.uploadCached(cfg, path, { force: options.force });
	options.onUploaded?.(uploaded);
	const backoffMs = options.visibilityBackoffMs ?? DEFAULT_VISIBILITY_BACKOFF_MS;

	if (uploaded.cached) {
		try {
			const taskId = await deps.submitTask(cfg, taskType, buildPayload(uploaded.fileId));
			return { taskId, fileId: uploaded.fileId, cached: true };
		} catch (error) {
			if (cloudErrorCode(error) !== MATERIAL_NOT_FOUND) throw error;
			options.onCacheInvalid?.();
			await deps.invalidateUpload(path);
			uploaded = await deps.uploadCached(cfg, path, { force: true });
		}
	}

	const taskId = await submitFreshFile(cfg, taskType, uploaded.fileId, buildPayload, backoffMs, deps);
	return { taskId, fileId: uploaded.fileId, cached: false };
}
