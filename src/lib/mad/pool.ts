/**
 * MAD 池装载器 / IR 按需拉取（add-tool-mad D3，tasks 3.4）。
 * 从 mad-cache 版本目录按 uid 取工程 IR：IR 分片（.json.gz）在线按需拉取落缓存、node:zlib 解压；
 * 离线只供给已缓存分片覆盖的池条目；缺失/损坏走自愈或明确报错（指引 --refresh/联网重跑）。
 */
import { gunzipSync } from "node:zlib";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./data";
import type { PoolEntry } from "./types";

/** 迁入的 IR 工程类型（结构与 convert IRProject 同构，此处宽松声明避免跨模块耦合）。 */
export type IRProject = Record<string, unknown> & {
	v: number;
	id: string;
	canvas: { w: number; h: number; fps: number; duration: number; [k: string]: unknown };
	layers: unknown[];
};

/** 一个 IR 分片 = { [uid]: IRProject }。 */
type IrShard = Record<string, IRProject>;

export interface IrLoaderDeps {
	fetchFn: typeof fetch;
	warn: (msg: string) => void;
}

export interface IrLoader {
	/** 取某池条目的工程 IR（分片在线按需拉取落缓存；离线无缓存分片抛错）。 */
	getIr(entry: Pick<PoolEntry, "ir" | "shard">): Promise<IRProject>;
	/** 该条目的 IR 是否已可用（已缓存分片或在线）——离线选窗过滤用。 */
	shardCached(shard: string): boolean;
}

/** 分片缓存路径。 */
function shardPath(verDir: string, shard: string): string {
	return join(verDir, "ir", `${shard}.json.gz`);
}

/** 从 gzip 缓冲解出 IR 分片对象。 */
function decodeShard(gz: Uint8Array): IrShard {
	const json = gunzipSync(gz).toString("utf8");
	const obj = JSON.parse(json);
	if (!obj || typeof obj !== "object") throw new Error("IR 分片结构非法");
	return obj as IrShard;
}

/**
 * 建 IR 装载器。assetsBase = manifest.assets_base（.../mad_wiki/v{n}），IR 分片在 `${assetsBase}/ir/{shard}.json.gz`。
 */
export function makeIrLoader(
	assetsBase: string,
	verDir: string,
	online: boolean,
	deps: IrLoaderDeps,
): IrLoader {
	const memo = new Map<string, IrShard>();
	const base = assetsBase.replace(/\/+$/, "");

	async function loadShard(shard: string): Promise<IrShard> {
		const cached = memo.get(shard);
		if (cached) return cached;
		const path = shardPath(verDir, shard);
		// 缓存命中 → 直接解压
		if (existsSync(path)) {
			try {
				const s = decodeShard(await readFile(path));
				memo.set(shard, s);
				return s;
			} catch {
				deps.warn(`IR 分片缓存损坏（${shard}），尝试重拉`);
				// 落到在线重拉
			}
		}
		if (!online) {
			throw new Error(`离线且 IR 分片「${shard}」无缓存。请连网重跑，或加 --refresh 预热数据。`);
		}
		const url = `${base}/ir/${shard}.json.gz`;
		const res = await deps.fetchFn(url); // 免鉴权、immutable 长缓存
		if (!res.ok) throw new Error(`IR 分片下载失败 HTTP ${res.status}：${url}`);
		const buf = new Uint8Array(await res.arrayBuffer());
		const s = decodeShard(buf); // 先验证可解，再落盘
		await mkdir(join(verDir, "ir"), { recursive: true });
		await atomicWrite(path, buf);
		memo.set(shard, s);
		return s;
	}

	return {
		async getIr(entry) {
			const shard = await loadShard(entry.shard);
			const ir = shard[entry.ir];
			if (!ir) throw new Error(`IR 分片「${entry.shard}」中缺工程 ir=${entry.ir}`);
			return ir;
		},
		shardCached(shard) {
			return memo.has(shard) || existsSync(shardPath(verDir, shard));
		},
	};
}
