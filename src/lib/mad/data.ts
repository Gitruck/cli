/**
 * MAD 数据获取层（add-tool-mad D3，tool-mad spec「技法池数据云端获取与本地缓存」）。
 *
 * manifest 免鉴权拉取（HTTPS、短超时）→ 版本比对 → 增量下载（临时文件+原子改名、sha256 校验、
 * stderr 进度）→ ~/.gitruck/mad-cache/{version}/ 版本目录 + 旧版本清理 → 损坏自愈 → 断网回退缓存 →
 * 断网且无缓存人话报错 → --refresh 强制刷新。零新增运行时依赖（fetch/zlib/crypto 内建）。
 *
 * 无 Key 承诺（D10）：全程只走免鉴权公开只读面（manifest + dataset + 静态资产），不带 Authorization。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homeFile } from "../paths";
import type { MadManifest, PoolEntry } from "./types";

/** MAD 本地缓存根目录 ~/.gitruck/mad-cache。 */
export function madCacheDir(): string {
	return homeFile("mad-cache");
}

/** content API 域公开基址（免鉴权 manifest/dataset；HTTPS 硬要求）。可经 env 覆盖（真机/联调）。
 * 注意：这是 flask API 域（:10000，manifest/dataset 接口所在），非静态资产域（:9000）——
 * 静态重资产的 base 由 manifest.assets_base 给出（指 :9000），不走这里。 */
export function madContentBase(): string {
	return (process.env.GITRUCK_MAD_BASE ?? "https://api.ai-mcn.tv:10000").replace(/\/+$/, "");
}

/** manifest 接口 URL（对外路径 /task/mad，2026-07-18 主理人定稿归入 /task 域；dataset 同前缀 /task/mad/dataset/<key>）。 */
export function manifestUrl(): string {
	return `${madContentBase()}/task/mad/manifest`;
}

export interface DataDeps {
	/** fetch 实现（默认全局 fetch；测试注入）。 */
	fetchFn: typeof fetch;
	/** 缓存根目录（默认 madCacheDir()；测试注入临时目录）。 */
	cacheRoot: string;
	/** manifest URL（默认 manifestUrl()；测试注入）。 */
	manifestUrl?: string;
	/** 人读提示（stderr，进度/warning）。 */
	warn: (msg: string) => void;
	/** manifest 拉取短超时（毫秒，默认 8000）。 */
	manifestTimeoutMs?: number;
}

export interface MadData {
	version: number;
	assetsBase: string;
	pool: PoolEntry[];
	/** 当前版本缓存目录（IR 分片按需落此）。 */
	verDir: string;
	/** 本次是否在线（manifest 拉取成功）；离线时 IR 分片只能吃缓存、选窗须限已缓存分片。 */
	online: boolean;
}

const REQUIRED_KEYS = ["mad_pool"] as const;

function sha256Hex(buf: Uint8Array): string {
	return createHash("sha256").update(buf).digest("hex");
}

/** 短超时 fetch（AbortController）。抛错=网络不可达/超时。 */
async function fetchWithTimeout(fetchFn: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		return await fetchFn(url, { signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
	}
}

/** 原子写：临时文件 + rename。 */
async function atomicWrite(dest: string, data: Uint8Array): Promise<void> {
	const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, data);
	await rename(tmp, dest);
}

/** 校验缓存文件 sha256；不存在或不符返回 false。 */
async function verifyFile(path: string, sha256: string): Promise<boolean> {
	if (!existsSync(path)) return false;
	try {
		const buf = await readFile(path);
		return sha256Hex(buf) === sha256;
	} catch {
		return false;
	}
}

/** 校验并解析结构：必须含 version(number)、datasets(obj)、assets_base(HTTPS)。 */
function validateManifest(obj: unknown): MadManifest {
	if (!obj || typeof obj !== "object") throw new Error("manifest 结构非法");
	const m = obj as Record<string, unknown>;
	if (typeof m.version !== "number") throw new Error("manifest 缺 version");
	if (!m.datasets || typeof m.datasets !== "object") throw new Error("manifest 缺 datasets");
	if (typeof m.assets_base !== "string" || !/^https:\/\//i.test(m.assets_base)) {
		throw new Error("manifest 缺 assets_base（须 HTTPS）");
	}
	return m as unknown as MadManifest;
}

/** 清理非当前版本的 v{n}/ 目录。 */
async function cleanupOldVersions(cacheRoot: string, keepVersion: number, warn: (m: string) => void): Promise<void> {
	try {
		const entries = await readdir(cacheRoot);
		for (const e of entries) {
			const m = /^v(\d+)$/.exec(e);
			if (m && Number(m[1]) !== keepVersion) {
				await rm(join(cacheRoot, e), { recursive: true, force: true }).catch(() => {});
			}
		}
	} catch {
		/* 清理失败不阻断 */
	}
	void warn;
}

/**
 * 备好技法池数据：manifest → 缓存 → 返回 { version, assetsBase, pool, verDir }。
 * 覆盖 scenarios：首拉冷启动 / 版本升级增量 / 离线缓存命中 / 离线无缓存报错 / 损坏自愈 / --refresh /
 * manifest 缺必需 key 人话报错。
 */
export async function ensureMadData(opts: { refresh?: boolean }, deps: DataDeps): Promise<MadData> {
	const { cacheRoot, warn } = deps;
	const timeout = deps.manifestTimeoutMs ?? 8000;
	const mfUrl = deps.manifestUrl ?? manifestUrl();
	const snapshotPath = join(cacheRoot, "manifest.json");

	// ① 试拉 manifest（免鉴权、短超时）
	let manifest: MadManifest | null = null;
	let online = false;
	try {
		if (!/^https:\/\//i.test(mfUrl)) throw new Error("manifest 必须 HTTPS");
		const res = await fetchWithTimeout(deps.fetchFn, mfUrl, timeout);
		if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
		manifest = validateManifest(await res.json());
		online = true;
	} catch (e) {
		// 拉取失败/断网 → 静默回退本地最新缓存
		warn(`manifest 拉取失败（${e instanceof Error ? e.message : String(e)}），回退本地缓存`);
	}

	// 断网：回退缓存快照
	if (!manifest) {
		if (!existsSync(snapshotPath)) {
			throw new Error(
				"首次使用需联网下载技法数据。请连网后重跑 `gtrk tool mad`（数据会缓存到本地，之后可离线出片）。",
			);
		}
		try {
			manifest = validateManifest(JSON.parse(await readFile(snapshotPath, "utf8")));
		} catch {
			throw new Error("本地 manifest 缓存损坏且当前离线。请连网重跑，或加 --refresh 强制重新下载。");
		}
	}

	// ② manifest 缺必需 key（如 mad_pool 未补灌）→ 人话报错（与断网无缓存同级）
	for (const k of REQUIRED_KEYS) {
		if (!manifest.datasets[k]) {
			throw new Error("技法数据尚未就绪，请稍后再试。");
		}
	}

	const version = manifest.version;
	const verDir = join(cacheRoot, `v${version}`);
	const poolPath = join(verDir, "mad_pool.json");
	const poolMeta = manifest.datasets.mad_pool;

	// ③ 是否需要下载 mad_pool（--refresh / 缺失 / 校验不过）
	const cacheValid = await verifyFile(poolPath, poolMeta.sha256);
	const needDownload = !!opts.refresh || !cacheValid;

	if (needDownload) {
		if (!online) {
			// 离线且缓存无效 → 损坏自愈的离线分支：明确报错
			if (existsSync(poolPath)) {
				throw new Error("本地技法数据缓存损坏且当前离线。请连网重跑，或加 --refresh 强制重新下载。");
			}
			throw new Error(
				"首次使用需联网下载技法数据。请连网后重跑 `gtrk tool mad`（数据会缓存到本地，之后可离线出片）。",
			);
		}
		await mkdir(verDir, { recursive: true });
		warn(`下载技法池数据 mad_pool（版本 v${version}，约 ${Math.round(poolMeta.size / 1024)} KB）…`);
		const res = await deps.fetchFn(poolMeta.url);
		if (!res.ok) throw new Error(`mad_pool 下载失败 HTTP ${res.status}`);
		const buf = new Uint8Array(await res.arrayBuffer());
		if (sha256Hex(buf) !== poolMeta.sha256) {
			throw new Error("mad_pool 下载校验不通过（sha256 不符），请重试或 --refresh。");
		}
		await atomicWrite(poolPath, buf);
		warn(`技法池数据就绪（v${version}）`);
	}

	// ④ manifest 快照落盘 + 旧版本清理
	if (online) {
		await mkdir(cacheRoot, { recursive: true });
		await atomicWrite(snapshotPath, new Uint8Array(Buffer.from(JSON.stringify(manifest), "utf8")));
		await cleanupOldVersions(cacheRoot, version, warn);
	}

	// ⑤ 装载池
	let pool: PoolEntry[];
	try {
		pool = JSON.parse(await readFile(poolPath, "utf8"));
		if (!Array.isArray(pool)) throw new Error("mad_pool 非数组");
	} catch (e) {
		throw new Error(`技法池数据装载失败：${e instanceof Error ? e.message : String(e)}（可加 --refresh 重拉）`);
	}

	return { version, assetsBase: manifest.assets_base, pool, verDir, online };
}

/** 供 pool.ts 复用的 sha256/原子写（避免重复实现）。 */
export { sha256Hex, atomicWrite };
