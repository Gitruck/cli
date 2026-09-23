/**
 * 本地上传缓存：文件指纹 → 云端 file_id，避免同一文件二次上传（大毛片重传一次十几秒）。
 * 指纹 = size:mtimeMs（stat-only、不读内容，对大视频毫秒级）；编辑视频必改 size 或 mtime，足够稳。
 * 缓存落 ~/.gitruck/upload-cache.json（用户级、跨工程共享）。供任何要上传的命令复用。
 */
import { join } from "node:path";
import { gitruckHome } from "./paths";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
	CHUNK_THRESHOLD,
	uploadChunked,
	type ChunkSessionRecord,
	type SessionStore,
} from "./chunk-upload";
import { uploadFile } from "./cloud";
import { noticeOnce } from "./compliance-notice";
import { crashReportNoticeOnce } from "./crash-report";
import type { CloudConfig } from "./config";
import { readJson } from "./read-json";
import { writeSidecar } from "./sidecar-write";

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
	/**
	 * 旁路记账的写。⚠️ **实现 MUST NOT 抛**（spec local-io-resilience）——
	 * 调用点 uploadCached 是在文件已经传完之后调它的，抛一次就把 fileId 一起弄丢
	 * （base_error#202 就是这么来的）。自备实现时照此办理。
	 */
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
		return await readJson<UploadCacheState>(CACHE_FILE);
	} catch {
		return {}; // 缓存损坏不致命，当空处理
	}
}

async function save(cache: UploadCacheState): Promise<void> {
	// 旁路记账：写不进去 MUST NOT 吃掉已经传完的 fileId（base_error#202）。
	await writeSidecar(CACHE_FILE, JSON.stringify(cache, null, 2), {
		label: "上传记账",
		consequence: "下次同一个文件会重新上传",
	});
}

/**
 * 生产用的 deps。**导出是给单测组合用的**：要证「记账写不进去也不吃掉 fileId」，
 * 就 MUST 让用例走**真的** cacheStore、只在 fs 那一层注入失败 ——
 * 若改成注入一个会抛的 cacheStore.save，那绕过的正是本件要证的那段代码。
 */
export const defaultUploadCacheDeps: UploadCacheDeps = {
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
		return await readJson<Sessions>(SESSION_FILE);
	} catch {
		return {}; // 会话文件损坏不致命：丢的只是断点线索，重传即可
	}
}

async function saveSessions(sessions: Sessions): Promise<void> {
	// 旁路记账，且它是在**上传进行中**被调的：写不进去 MUST NOT 把传输拦腰打断。
	await writeSidecar(SESSION_FILE, JSON.stringify(sessions, null, 2), {
		label: "分片续传断点",
		consequence: "断线后续不上，得从头传",
	});
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
	// 合规告知（add-compliance-notice 2.1）：本函数是**文件上传的唯一咽喉**——uploadChunked 只被这里调用，
	// 三个调用方（uploadAndSubmitTask / uploadManyAndSubmit / music-visualizer 的背景封面直调）全数经过。
	// 挂在这里而非各调用方，是为守住 spec「MUST NOT 由各命令各自复制告知逻辑」；
	// 位置在 stat 与缓存判定**之前**，确保任何情况下告知都早于内容离机。
	// 幂等靠留痕，已告知过即静默返回；只告知不设闸——不阻断、不等输入、不改退出码（恒走 stderr）。
	noticeOnce();
	crashReportNoticeOnce();
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
