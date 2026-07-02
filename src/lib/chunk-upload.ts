/**
 * 分片上传（断点续传）客户端 —— 消费云端 /base/file/upload/chunk/* 五接口。
 * （change add-chunked-upload-client，服务端契约见 gitruck-infra change add-chunked-resumable-upload）
 *
 * 流程：init（可秒传）→ 并行 part（幂等、乱序安全）→ complete（与单发上传同构 FileResponse）。
 * 断点：会话经 SessionStore 持久化，重跑先 GET status 拿缺片列表只补缺片；
 *       会话失效（6024）自动重建一次。单片网络/校验失败退避重试，业务拒绝立即失败。
 * 超时：每片 32MiB 秒级请求，undici 默认超时天然够用 —— 无需任何 timeout 调整。
 */
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { createBLAKE3 } from "hash-wasm";
import { parseJson } from "./cloud";
import type { CloudConfig } from "./config";
import { log } from "./log";

/** 达到该大小走分片（其下维持单发流式，行为不变）。 */
export const CHUNK_THRESHOLD = 256 * 1024 * 1024;
/** 分片并行度（峰值内存 ≈ 并行度 × part_size ≈ 96MiB）。 */
const CONCURRENCY = 3;
/** 单片重试预算与退避（网络层 / 校验类）。 */
const PART_RETRIES = 3;
const BACKOFF_MS = [2000, 4000, 8000];
/** complete 遇 CHUNK_INCOMPLETE 的补片轮数上限。 */
const INCOMPLETE_ROUNDS = 2;
/** 会话失效（6024）的整体重建次数上限（防云端异常死循环）。 */
const MAX_REBUILDS = 1;

// 服务端错误码（gitruck-infra error_codes.py，两侧 spec 互锁）
const CODE_SESSION_NOT_FOUND = 6024;
const CODE_PART_INVALID = 6025;
const CODE_CHECKSUM_MISMATCH = 6026;
const CODE_INCOMPLETE = 6027;

// 服务端 fast_mode 指纹口径（utils/base/fingerprint.py，必须逐字节复刻）：
// 按 8192/块顺序读，每块计数 +8192，计数 ≥64MiB 立即停且该块不入哈希
// —— 即大文件实际哈希前 67,100,672 字节（64MiB − 8KiB），小文件哈希全文。
const FP_BUFFER = 8192;
const FP_SKIP = 64 * 1024 * 1024;

/** 进行中的分片会话（SessionStore 持久化条目）。 */
export interface ChunkSessionRecord {
	uploadId: string;
	partSize: number;
	totalParts: number;
	size: number;
	path: string;
	createdAt: number;
}

/** 会话持久化接口（生产 = ~/.gtrk-cli/upload-sessions.json，测试可注入内存版）。 */
export interface SessionStore {
	load(fp: string): Promise<ChunkSessionRecord | undefined>;
	save(fp: string, rec: ChunkSessionRecord): Promise<void>;
	clear(fp: string): Promise<void>;
}

/** 计算与服务端 get_raw_file_blake3(fast_mode=True) 逐字节一致的秒传指纹；失败降级 undefined。 */
export async function fastBlake3(path: string): Promise<string | undefined> {
	try {
		const hasher = await createBLAKE3();
		hasher.init();
		const fh = await open(path, "r");
		try {
			const buf = Buffer.alloc(FP_BUFFER);
			let count = 0;
			let pos = 0;
			for (;;) {
				const { bytesRead } = await fh.read(buf, 0, FP_BUFFER, pos);
				if (bytesRead === 0) break;
				count += FP_BUFFER; // 服务端按整块计数（与实读字节数无关），照抄
				if (count >= FP_SKIP) break; // 阈值块不入哈希 —— fast_mode 怪癖，必须复刻
				hasher.update(buf.subarray(0, bytesRead));
				pos += bytesRead;
			}
			return hasher.digest("hex") as string;
		} finally {
			await fh.close();
		}
	} catch {
		return undefined; // 指纹只是秒传优化，算不出来就实传，不阻断
	}
}

/** 整片 Blake3（part 的 ?blake3= 校验参数）。 */
async function partBlake3(view: Uint8Array): Promise<string> {
	const hasher = await createBLAKE3();
	hasher.init();
	hasher.update(view);
	return hasher.digest("hex") as string;
}

/** 会话失效信号（触发整体重建一次）。 */
class SessionGoneError extends Error {
	constructor() {
		super("分片会话已失效");
		this.name = "SessionGoneError";
	}
}

/** 网络层瞬态错误判定（fetch 抛错 / 5xx 解析失败），可退避重试。 */
function isTransient(e: unknown): boolean {
	const msg = String((e as Error)?.message ?? e);
	return /fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR|服务响应解析失败 \(HTTP 5/i.test(msg);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

interface InitData {
	upload_id?: string | number;
	part_size?: number;
	total_parts?: number;
	file_id?: string | number;
	instant?: boolean;
}

interface StatusData {
	part_size: number;
	total_parts: number;
	missing: number[];
}

/**
 * 分片上传主入口：返回云端 file_id。
 * 断点续传依赖 opts.store 持久化会话；opts.force（--reupload）跳过会话续传与秒传指纹。
 */
export async function uploadChunked(
	cfg: CloudConfig,
	path: string,
	opts: { fingerprint: string; store: SessionStore; force?: boolean },
): Promise<string> {
	const size = (await stat(path)).size;
	const name = basename(path);

	for (let rebuilds = 0; ; rebuilds++) {
		try {
			return await attemptOnce(cfg, path, name, size, opts);
		} catch (e) {
			if (e instanceof SessionGoneError && rebuilds < MAX_REBUILDS) {
				await opts.store.clear(opts.fingerprint);
				log.warn("云端分片会话已失效，自动重建整传一次");
				continue;
			}
			throw e;
		}
	}
}

/** 一轮完整尝试：恢复或新建会话 → 补缺片 → complete（补片至多 INCOMPLETE_ROUNDS 轮）。 */
async function attemptOnce(
	cfg: CloudConfig,
	path: string,
	name: string,
	size: number,
	opts: { fingerprint: string; store: SessionStore; force?: boolean },
): Promise<string> {
	const { fingerprint, store, force } = opts;

	// ---- 恢复已有会话（--reupload 跳过） ----
	let session = force ? undefined : await store.load(fingerprint);
	let missing: number[] | undefined;
	if (session) {
		const st = await chunkStatus(cfg, session.uploadId);
		if (st === undefined) {
			await store.clear(fingerprint); // 云端会话已消亡，本地记录作废
			session = undefined;
		} else {
			// 以云端为准刷新分片参数
			session = { ...session, partSize: st.part_size, totalParts: st.total_parts };
			missing = st.missing;
			if (missing.length < session.totalParts) {
				log.info(
					`断点续传：云端已有 ${session.totalParts - missing.length}/${session.totalParts} 片，补 ${missing.length} 片`,
				);
			}
		}
	}

	// ---- 新建会话（可秒传） ----
	if (!session) {
		const blake3Id = force ? undefined : await fastBlake3(path);
		const body: Record<string, unknown> = { filename: name, size };
		if (blake3Id) body.blake3_id = blake3Id;
		const res = await fetch(`${cfg.base}/base/file/upload/chunk/init`, {
			method: "POST",
			headers: { Authorization: cfg.apiKey, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const r = await parseJson<InitData>(res);
		if (r.code !== 200) {
			throw new Error(`分片上传 init 失败 (code=${r.code ?? "?"})：${r.msg ?? "未知错误"}`);
		}
		if (r.data?.file_id != null) {
			log.info("秒传命中：云端已有同内容文件，零字节上传");
			return String(r.data.file_id); // instant 秒传
		}
		if (r.data?.upload_id == null || !r.data.part_size || !r.data.total_parts) {
			throw new Error("分片上传 init 响应缺字段（upload_id/part_size/total_parts）");
		}
		session = {
			uploadId: String(r.data.upload_id),
			partSize: r.data.part_size,
			totalParts: r.data.total_parts,
			size,
			path,
			createdAt: Date.now(),
		};
		await store.save(fingerprint, session);
		missing = undefined; // 全新会话：全部要传
	}

	if (missing === undefined) {
		missing = Array.from({ length: session.totalParts }, (_, i) => i);
	}

	// ---- 并行补缺片 ----
	await uploadParts(cfg, path, session, missing);

	// ---- complete（缺片自愈至多 INCOMPLETE_ROUNDS 轮） ----
	for (let round = 0; ; round++) {
		const res = await fetch(
			`${cfg.base}/base/file/upload/chunk/${session.uploadId}/complete`,
			{ method: "POST", headers: { Authorization: cfg.apiKey } },
		);
		const r = await parseJson<{ file_id?: string | number }>(res);
		if (r.code === 200 && r.data?.file_id != null) {
			await store.clear(fingerprint);
			return String(r.data.file_id);
		}
		if (r.code === CODE_SESSION_NOT_FOUND) throw new SessionGoneError();
		if (r.code === CODE_INCOMPLETE && round < INCOMPLETE_ROUNDS) {
			const st = await chunkStatus(cfg, session.uploadId);
			if (st === undefined) throw new SessionGoneError();
			await uploadParts(cfg, path, session, st.missing);
			continue;
		}
		throw new Error(`分片上传 complete 失败 (code=${r.code ?? "?"})：${r.msg ?? "未知错误"}`);
	}
}

/** GET status；会话不存在（6024）返回 undefined，其余错误抛出。 */
async function chunkStatus(cfg: CloudConfig, uploadId: string): Promise<StatusData | undefined> {
	const res = await fetch(`${cfg.base}/base/file/upload/chunk/${uploadId}`, {
		headers: { Authorization: cfg.apiKey },
	});
	const r = await parseJson<StatusData>(res);
	if (r.code === CODE_SESSION_NOT_FOUND) return undefined;
	if (r.code !== 200 || !r.data) {
		throw new Error(`分片会话查询失败 (code=${r.code ?? "?"})：${r.msg ?? "未知错误"}`);
	}
	return r.data;
}

/** 并行度 CONCURRENCY 的分片池：每片定长切片读取 + 整片 blake3 校验 + 分类重试。 */
async function uploadParts(
	cfg: CloudConfig,
	path: string,
	session: ChunkSessionRecord,
	indexes: number[],
): Promise<void> {
	if (indexes.length === 0) return;
	const { uploadId, partSize, totalParts, size } = session;
	let done = totalParts - indexes.length;
	const fh = await open(path, "r"); // 单句柄共享：显式 offset 定位读，并行安全
	try {
		const queue = [...indexes];
		const worker = async () => {
			const buf = Buffer.alloc(partSize);
			for (;;) {
				const idx = queue.shift();
				if (idx === undefined) return;
				const offset = idx * partSize;
				const len = idx === totalParts - 1 ? size - offset : partSize;
				const { bytesRead } = await fh.read(buf, 0, len, offset);
				if (bytesRead !== len) {
					throw new Error(`本地文件读取不足（第${idx}片期望${len}字节实读${bytesRead}）——文件被改动？`);
				}
				const view = buf.subarray(0, len);
				await putPart(cfg, uploadId, idx, view);
				done++;
				log.tick(`分片上传 ${done}/${totalParts}（${Math.round((done / totalParts) * 100)}%）`);
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, indexes.length) }, worker));
	} finally {
		log.tickEnd();
		await fh.close();
	}
}

/** PUT 单片：网络层/校验类退避重试，6024 抛会话失效，其余业务码立即失败。 */
async function putPart(
	cfg: CloudConfig,
	uploadId: string,
	idx: number,
	view: Uint8Array,
): Promise<void> {
	const b3 = await partBlake3(view);
	let lastErr: unknown;
	for (let attempt = 0; attempt <= PART_RETRIES; attempt++) {
		if (attempt > 0) await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
		try {
			const res = await fetch(
				`${cfg.base}/base/file/upload/chunk/${uploadId}/${idx}?blake3=${b3}`,
				{
					method: "PUT",
					headers: { Authorization: cfg.apiKey, "Content-Type": "application/octet-stream" },
					// bun-types 与 undici 的 BodyInit 声明打架；运行时 Uint8Array 是合法 body
					body: view as unknown as BodyInit,
				},
			);
			const r = await parseJson<unknown>(res);
			if (r.code === 200) return;
			if (r.code === CODE_SESSION_NOT_FOUND) throw new SessionGoneError();
			if (r.code === CODE_CHECKSUM_MISMATCH || r.code === CODE_PART_INVALID) {
				lastErr = new Error(`第${idx}片被拒 (code=${r.code})：${r.msg ?? ""}`);
				continue; // 校验类：立即重传（计入同一预算）
			}
			throw new Error(`第${idx}片上传失败 (code=${r.code ?? "?"})：${r.msg ?? "未知错误"}`);
		} catch (e) {
			if (e instanceof SessionGoneError) throw e;
			if (!isTransient(e)) throw e;
			lastErr = e; // 网络瞬态：退避后重试
		}
	}
	throw lastErr instanceof Error
		? lastErr
		: new Error(`第${idx}片重试${PART_RETRIES}次仍失败`);
}
