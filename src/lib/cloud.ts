/**
 * 云端 API 薄客户端：上传 / 提交任务 / 轮询 / 下载。
 * 口径对齐客户端 opencut-rewrite 的 cloud-render.ts（同一 {code,msg,data} 包装、同一鉴权 Header）。
 */
import { basename } from "node:path";
import { writeFile } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import type { CloudConfig } from "./config";

interface ApiResp<T> {
	code?: number;
	msg?: string;
	data?: T;
}

/** 带云端错误码的错误（如 6004=素材在云端不存在，供上层判断缓存的 file_id 是否失效）。 */
export class CloudError extends Error {
	constructor(
		public code: number | undefined,
		message: string,
	) {
		super(message);
		this.name = "CloudError";
	}
}

async function parseJson<T>(res: Response): Promise<ApiResp<T>> {
	try {
		return (await res.json()) as ApiResp<T>;
	} catch {
		throw new Error(`服务响应解析失败 (HTTP ${res.status})`);
	}
}

/** 上传本地文件 → file_id。POST /base/file/upload（multipart，字段 file，最大 20GB）。 */
export async function uploadFile(cfg: CloudConfig, path: string): Promise<string> {
	const form = new FormData();
	// openAsBlob 返回惰性读盘的 Blob —— 不把整个大文件读进内存（支持 20GB 毛片）。
	form.append("file", await openAsBlob(path), basename(path));
	const res = await fetch(`${cfg.base}/base/file/upload`, {
		method: "POST",
		headers: { Authorization: cfg.apiKey },
		body: form,
	});
	const r = await parseJson<{ file_id?: string; id?: string }>(res);
	const fid = r.data?.file_id ?? r.data?.id;
	if (r.code === 200 && fid) return String(fid);
	throw new Error(`上传失败 (code=${r.code ?? "?"})：${r.msg ?? "未知错误"}`);
}

/** 提交任务 → task_id。POST /task/<taskType>。 */
export async function submitTask(
	cfg: CloudConfig,
	taskType: string,
	payload: unknown,
): Promise<string> {
	const res = await fetch(`${cfg.base}/task/${taskType}`, {
		method: "POST",
		headers: { Authorization: cfg.apiKey, "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const r = await parseJson<{ task_id?: string }>(res);
	if (r.code === 200 && r.data?.task_id) return String(r.data.task_id);
	throw new Error(`提交失败 (code=${r.code ?? "?"})：${r.msg ?? "未知错误"}`);
}

/** 任务产物文件条目（video_oral_cut 等 outputs 含 project/video 时）。 */
export interface ProductFile {
	type: string; // "project" | "video"
	format: string; // gtrk | jianying | capcut | xml | fcpxml | otio ...
	file_id?: string;
	download_url: string;
	filename: string;
}

/** video_oral_cut 的 output_result：{report, files[], errors}。 */
export interface OralCutOutput {
	report?: unknown;
	files?: ProductFile[];
	errors?: Record<string, string>;
}

/** 轮询任务到 completed，返回 output_result。每 5s 一次、30min 墙钟上限。 */
export async function pollTask(
	cfg: CloudConfig,
	taskType: string,
	taskId: string,
	onTick?: (status: string, progress?: number) => void,
): Promise<OralCutOutput> {
	const start = Date.now();
	const TIMEOUT_MS = 30 * 60 * 1000;
	const INTERVAL_MS = 5000;
	for (;;) {
		if (Date.now() - start > TIMEOUT_MS) {
			throw new Error("任务超时（超过 30 分钟）。可稍后在云端查任务或重试。");
		}
		await new Promise((r) => setTimeout(r, INTERVAL_MS));
		let r: ApiResp<Record<string, unknown>>;
		try {
			const res = await fetch(`${cfg.base}/task/${taskType}/${taskId}`, {
				headers: { Authorization: cfg.apiKey },
			});
			r = await parseJson(res);
		} catch {
			continue; // 瞬断/解析失败不致命，下次再试（有墙钟上限兜底）
		}
		if (r.code != null && r.code !== 200) {
			throw new Error(`任务错误 (code=${r.code})：${r.msg ?? ""}`);
		}
		const data = r.data ?? {};
		const status = String(data.status ?? "");
		if (status === "completed") {
			return (data.output_result ?? {}) as OralCutOutput;
		}
		if (status === "failed" || status === "cancelled") {
			const out = data.output_result as { error?: string } | undefined;
			throw new Error(out?.error ?? (status === "failed" ? "任务失败" : "任务已取消"));
		}
		onTick?.(
			status || "处理中",
			typeof data.progress === "number" ? (data.progress as number) : undefined,
		);
	}
}

/** 下载 download_url → 写到 dest（CLI 无浏览器 CORS 限制，直接 fetch）。 */
export async function download(url: string, dest: string): Promise<void> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
	const buf = Buffer.from(await res.arrayBuffer());
	await writeFile(dest, buf);
}
