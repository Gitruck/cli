/**
 * 本地上传缓存：文件指纹 → 云端 file_id，避免同一文件二次上传（大毛片重传一次十几秒）。
 * 指纹 = size:mtimeMs（stat-only、不读内容，对大视频毫秒级）；编辑视频必改 size 或 mtime，足够稳。
 * 缓存落 ~/.gitruck/upload-cache.json（用户级、跨工程共享）。供任何要上传的命令复用。
 */
import { join } from "node:path";
import { gitruckHome } from "./paths";
import { stat, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
	CHUNK_THRESHOLD,
	uploadChunked,
	type ChunkSessionRecord,
	type SessionStore,
} from "./chunk-upload";
import { uploadFile } from "./cloud";
import type { CloudConfig } from "./config";

const CACHE_DIR = gitruckHome();
const CACHE_FILE = join(CACHE_DIR, "upload-cache.json");
// 进行中的分片会话（易失状态）单独落盘，不与"已完成上传"的稳定缓存混一个文件（design D3）
const SESSION_FILE = join(CACHE_DIR, "upload-sessions.json");

export interface CacheEntry {
	fileId: string;
	size: number;
	mtimeMs: number;
	path: string;
	uploadedAt: number;
}
export type UploadCacheState = Record<string, CacheEntry>;

export interface UploadCacheStore {
	load(): Promise<UploadCacheState>;
	save(cache: UploadCacheState): Promise<void>;
}

export interface UploadCacheDeps {
	stat: typeof stat;
	uploadFile: typeof uploadFile;
	uploadChunked: typeof uploadChunked;
	cacheStore: UploadCacheStore;
}

function fingerprintFromStat(s: { size: number; mtimeMs: number }): string {
	return `${s.size}:${Math.round(s.mtimeMs)}`;
}

async function fingerprint(path: string): Promise<string> {
	return fingerprintFromStat(await stat(path));
}

async function load(): Promise<UploadCacheState> {
	if (!existsSync(CACHE_FILE)) return {};
	try {
		return JSON.parse(await readFile(CACHE_FILE, "utf8")) as UploadCacheState;
	} catch {
		return {}; // 缓存损坏不致命，当空处理
	}
}

async function save(cache: UploadCacheState): Promise<void> {
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

const defaultUploadCacheDeps: UploadCacheDeps = {
	stat,
	uploadFile,
	uploadChunked,
	cacheStore: { load, save },
};

/** 删掉某文件的缓存条目（云端 file_id 失效时调）。 */
export async function invalidateUpload(path: string): Promise<void> {
	const fp = await fingerprint(path);
	const cache = await load();
	if (cache[fp]) {
		delete cache[fp];
		await save(cache);
	}
}

// ---------------------------------------------------------------- sessions

type Sessions = Record<string, ChunkSessionRecord>;

async function loadSessions(): Promise<Sessions> {
	if (!existsSync(SESSION_FILE)) return {};
	try {
		return JSON.parse(await readFile(SESSION_FILE, "utf8")) as Sessions;
	} catch {
		return {}; // 会话文件损坏不致命：丢的只是断点线索，重传即可
	}
}

async function saveSessions(sessions: Sessions): Promise<void> {
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(SESSION_FILE, JSON.stringify(sessions, null, 2));
}

/** 文件版会话存取（~/.gtrk-cli/upload-sessions.json），供分片上传断点续传。 */
export const fileSessionStore: SessionStore = {
	async load(fp) {
		return (await loadSessions())[fp];
	},
	async save(fp, rec) {
		const sessions = await loadSessions();
		sessions[fp] = rec;
		await saveSessions(sessions);
	},
	async clear(fp) {
		const sessions = await loadSessions();
		if (sessions[fp]) {
			delete sessions[fp];
			await saveSessions(sessions);
		}
	},
};

/** 带缓存上传：指纹命中则复用 file_id（免二次上传），否则真上传并记缓存。
 * 大文件（≥256MiB）自动走分片断点续传，小文件维持单发流式 —— 对调用方透明。 */
export async function uploadCached(
	cfg: CloudConfig,
	path: string,
	opts?: { force?: boolean },
	deps: UploadCacheDeps = defaultUploadCacheDeps,
): Promise<{ fileId: string; cached: boolean }> {
	const s0 = await deps.stat(path);
	const fp = fingerprintFromStat(s0);
	const cache = await deps.cacheStore.load();
	const hit = cache[fp]?.fileId;
	if (!opts?.force && hit) return { fileId: hit, cached: true };

	const fileId =
		s0.size >= CHUNK_THRESHOLD
			? await deps.uploadChunked(cfg, path, {
					fingerprint: fp,
					store: fileSessionStore,
					force: opts?.force,
				})
			: await deps.uploadFile(cfg, path);
	const s = await deps.stat(path);
	if (s.size !== s0.size || Math.round(s.mtimeMs) !== Math.round(s0.mtimeMs)) {
		throw new Error("上传过程中输入文件发生变化，请等待文件写入完成后重试");
	}
	cache[fp] = {
		fileId,
		size: s.size,
		mtimeMs: Math.round(s.mtimeMs),
		path,
		uploadedAt: Date.now(),
	};
	await deps.cacheStore.save(cache);
	return { fileId, cached: false };
}
