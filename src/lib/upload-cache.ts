/**
 * 本地上传缓存：文件指纹 → 云端 file_id，避免同一文件二次上传（大毛片重传一次十几秒）。
 * 指纹 = size:mtimeMs（stat-only、不读内容，对大视频毫秒级）；编辑视频必改 size 或 mtime，足够稳。
 * 缓存落 ~/.gtrk-cli/upload-cache.json（用户级、跨工程共享）。供任何要上传的命令复用。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { stat, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { uploadFile } from "./cloud";
import type { CloudConfig } from "./config";

const CACHE_DIR = join(homedir(), ".gtrk-cli");
const CACHE_FILE = join(CACHE_DIR, "upload-cache.json");

interface CacheEntry {
	fileId: string;
	size: number;
	mtimeMs: number;
	path: string;
	uploadedAt: number;
}
type Cache = Record<string, CacheEntry>;

async function fingerprint(path: string): Promise<string> {
	const s = await stat(path);
	return `${s.size}:${Math.round(s.mtimeMs)}`;
}

async function load(): Promise<Cache> {
	if (!existsSync(CACHE_FILE)) return {};
	try {
		return JSON.parse(await readFile(CACHE_FILE, "utf8")) as Cache;
	} catch {
		return {}; // 缓存损坏不致命，当空处理
	}
}

async function save(cache: Cache): Promise<void> {
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/** 删掉某文件的缓存条目（云端 file_id 失效时调）。 */
export async function invalidateUpload(path: string): Promise<void> {
	const fp = await fingerprint(path);
	const cache = await load();
	if (cache[fp]) {
		delete cache[fp];
		await save(cache);
	}
}

/** 带缓存上传：指纹命中则复用 file_id（免二次上传），否则真上传并记缓存。 */
export async function uploadCached(
	cfg: CloudConfig,
	path: string,
	opts?: { force?: boolean },
): Promise<{ fileId: string; cached: boolean }> {
	const fp = await fingerprint(path);
	const cache = await load();
	const hit = cache[fp]?.fileId;
	if (!opts?.force && hit) return { fileId: hit, cached: true };

	const fileId = await uploadFile(cfg, path);
	const s = await stat(path);
	cache[fp] = {
		fileId,
		size: s.size,
		mtimeMs: Math.round(s.mtimeMs),
		path,
		uploadedAt: Date.now(),
	};
	await save(cache);
	return { fileId, cached: false };
}
