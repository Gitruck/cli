/**
 * 云端 API 薄客户端：上传 / 提交任务 / 轮询 / 下载。
 * 口径对齐客户端 opencut-rewrite 的 cloud-render.ts（同一 {code,msg,data} 包装、同一鉴权 Header）。
 */
import { basename } from "node:path";
import { writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import type { CloudConfig } from "./config";

export interface ApiResp<T> {
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

/** 跨 bundle 稳定读取 CloudError 业务码；网络/解析错误返回 undefined。 */
export function cloudErrorCode(error: unknown): number | undefined {
	const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
	return typeof code === "number" ? code : undefined;
}

export async function parseJson<T>(res: Response): Promise<ApiResp<T>> {
	try {
		return (await res.json()) as ApiResp<T>;
	} catch {
		throw new Error(`服务响应解析失败 (HTTP ${res.status})`);
	}
}

/**
 * 上传本地文件 → file_id。POST /base/file/upload（multipart，字段 file，最大 20GB）。
 *
 * Bun：FormData + Bun.file，避开 HTTPS CONNECT 代理下 ReadableStream 请求体异常断连。
 * Node：流式手拼 multipart（createReadStream + 精确 Content-Length），保持恒定内存。
 * ≥256MiB 文件由 uploadCached 前置路由到分片上传，不会进入本函数的 Bun FormData 分支。
 */
export interface UploadFileRuntime {
	/** 测试覆盖；生产缺省按 globalThis.Bun 自动识别。 */
	runtime?: "bun" | "node";
	fetchFn?: typeof fetch;
	bunFile?: (path: string) => Blob;
}

function globalBunFile(): ((path: string) => Blob) | undefined {
	const bun = (globalThis as typeof globalThis & { Bun?: { file(path: string): Blob } }).Bun;
	return bun ? bun.file.bind(bun) : undefined;
}

export async function uploadFile(cfg: CloudConfig, path: string, runtime: UploadFileRuntime = {}): Promise<string> {
	const fetchFn = runtime.fetchFn ?? fetch;
	const bunFile = runtime.bunFile ?? globalBunFile();
	const useBun = runtime.runtime ? runtime.runtime === "bun" : bunFile != null;

	let res: Response;
	if (useBun) {
		if (!bunFile) throw new Error("Bun 上传运行时缺少 Bun.file");
		const form = new FormData();
		form.append("file", bunFile(path), basename(path));
		res = await fetchFn(`${cfg.base}/base/file/upload`, {
			method: "POST",
			headers: { Authorization: cfg.apiKey },
			body: form,
		});
	} else {
		const size = (await stat(path)).size;
		const boundary = `----gtrkFormBoundary${randomBytes(16).toString("hex")}`;
		const head = Buffer.from(
			`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="file"; filename="${basename(path)}"\r\n` +
				`Content-Type: application/octet-stream\r\n\r\n`,
			"utf8",
		);
		const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

		async function* multipart() {
			yield head;
			for await (const chunk of createReadStream(path)) yield chunk as Buffer;
			yield tail;
		}

		res = await fetchFn(`${cfg.base}/base/file/upload`, {
			method: "POST",
			headers: {
				Authorization: cfg.apiKey,
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
				"Content-Length": String(head.length + size + tail.length),
			},
			// node:stream/web 与 DOM lib 的 ReadableStream 声明打架；运行时同一实现
			body: Readable.toWeb(Readable.from(multipart())) as unknown as BodyInit,
			// @ts-expect-error undici 专有：流式请求体需声明半双工
			duplex: "half",
		});
	}
	const r = await parseJson<{ file_id?: string; id?: string }>(res);
	const fid = r.data?.file_id ?? r.data?.id;
	if (r.code === 200 && fid) return String(fid);
	throw new CloudError(r.code, `上传失败 (code=${r.code ?? "?"})：${r.msg ?? "未知错误"}`);
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
	throw new CloudError(r.code, `提交失败 (code=${r.code ?? "?"})：${r.msg ?? "未知错误"}`);
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

/**
 * 单发查一次任务结果：GET /task/<taskType>/<taskId>，返回完整 {status, progress?, output}。
 * 供 pollTask 复用，也供「按 task_id 取结果」直接取已完成任务的 output_result（含 report/files[]）。
 * 真实错误码（异账号/不存在等）抛 CloudError；网络/解析异常按原样抛（调用方按需重试）。
 */
export async function getTaskResult(
	cfg: CloudConfig,
	taskType: string,
	taskId: string,
): Promise<{ status: string; progress?: number; output: OralCutOutput }> {
	const res = await fetch(`${cfg.base}/task/${taskType}/${taskId}`, {
		headers: { Authorization: cfg.apiKey },
	});
	const r = await parseJson<Record<string, unknown>>(res);
	if (r.code != null && r.code !== 200) {
		throw new CloudError(r.code, `任务查询失败 (code=${r.code})：${r.msg ?? ""}`);
	}
	const data = r.data ?? {};
	return {
		status: String(data.status ?? ""),
		progress: typeof data.progress === "number" ? (data.progress as number) : undefined,
		output: (data.output_result ?? {}) as OralCutOutput,
	};
}

/** 轮询任务到 completed，返回 output_result。每 5s 一次、30min 墙钟上限。复用 getTaskResult。 */
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
		let got: { status: string; progress?: number; output: OralCutOutput };
		try {
			got = await getTaskResult(cfg, taskType, taskId);
		} catch (e) {
			if (e instanceof CloudError) throw e; // 真错误码：透传（对齐旧行为）
			continue; // 瞬断/解析失败不致命，下次再试（有墙钟上限兜底）
		}
		if (got.status === "completed") return got.output;
		if (got.status === "failed" || got.status === "cancelled") {
			const out = got.output as { error?: string };
			throw new Error(out?.error ?? (got.status === "failed" ? "任务失败" : "任务已取消"));
		}
		onTick?.(got.status || "处理中", got.progress);
	}
}

/** 下载 download_url → 写到 dest（CLI 无浏览器 CORS 限制，直接 fetch）。 */
export async function download(url: string, dest: string): Promise<void> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
	const buf = Buffer.from(await res.arrayBuffer());
	await writeFile(dest, buf);
}
