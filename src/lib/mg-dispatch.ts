/**
 * MG 派单读取（change `fix-mg-fetch-text-slot-identity` 从 `src/commands/mg.ts` 原样抽出）。
 *
 * 抽出来的唯一理由：**两条取块路要用同一份口径**。registry 中性块路一直是对的
 * （按 beat 或 composition_id 命中派单条目，取 `composition_id` / `r3(track_ed − track_st)` 包络 /
 * `category`），文字模板路则各写了一份、把 `--slot` 的值直接当 composition_id 用——
 * 于是派单模式必然 `1-cid-expect` 致命。让两条路共用本文件，这类分家不会再发生。
 *
 * 本文件是**纯搬运**：`resolveDispatch` / `readMgQueue` 的行为与原实现逐字相同。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { r3 } from "./frame-domain";
import type { Dispatch, MgDispatch } from "./splitdoc";

export interface DispatchLocator {
	/** `--dispatch <path>` 显式路径；优先于 `--project`。 */
	dispatch?: string;
	/** `--project <dir>` 工程产物目录。 */
	project?: string;
}

/**
 * 定位派单清单与工程产物根。
 *
 * `--dispatch` 给的是 `<baseDir>/split/dispatch.json`，故工程根 = 它的**祖父**目录。
 */
export function resolveDispatch(opts: DispatchLocator): { dispatchPath: string; baseDir: string } {
	if (opts.dispatch) {
		const dispatchPath = resolve(opts.dispatch);
		return { dispatchPath, baseDir: dirname(dirname(dispatchPath)) };
	}
	if (opts.project) {
		const baseDir = resolve(opts.project);
		return { dispatchPath: join(baseDir, "split", "dispatch.json"), baseDir };
	}
	throw new Error("需 --project <目录> 或显式 --dispatch <path>");
}

/** 读 MG 队列。dispatch 桶读旧兼容：新键 `mg`，遗留键 `rrv_mg`（既有 dispatch.json 零迁移）。 */
export async function readMgQueue(dispatchPath: string): Promise<MgDispatch[]> {
	if (!existsSync(dispatchPath)) throw new Error(`找不到派单清单：${dispatchPath}（先跑 gtrk split 落地派单）`);
	const dispatch = JSON.parse(await readFile(dispatchPath, "utf8")) as Dispatch & { rrv_mg?: MgDispatch[] };
	const queue = dispatch.mg ?? dispatch.rrv_mg;
	return Array.isArray(queue) ? queue : [];
}

export interface SlotHit {
	/** 派单条目的 composition_id —— 落点与期望 id 的**唯一**来源，MUST NOT 用 `--slot` 的值代替。 */
	compositionId: string;
	/** 坑位包络 r3(track_ed − track_st)（铁律⑦的坑位长度，与 `duration_hint` 的节奏语义解耦）。 */
	slotSec: number;
	/** 该条派单的 category（只在取值合法时给出）。 */
	category?: "overlay" | "fullscreen";
	item: MgDispatch;
}

/**
 * 按 `--slot`（beat id 或 composition_id）在队列里命中一条，并算出落点三要素。
 *
 * 命不中 SHALL 抛错并列出现有 beat —— 打一句「没有该 beat」而不告诉用户有哪些，
 * 等于让他去翻 JSON。
 */
export function matchSlot(queue: MgDispatch[], slot: string): SlotHit {
	const q = queue.find((x) => x.beat === slot || x.composition_id === slot);
	if (!q) {
		throw new Error(`派单里没有 beat「${slot}」；现有：${[...new Set(queue.map((x) => x.beat))].slice(0, 12).join("、") || "（空）"}`);
	}
	const slotSec = r3(q.track_ed - q.track_st);
	if (!(slotSec > 0)) throw new Error(`派单条目 ${q.composition_id} 的坑位包络非正（track_st=${q.track_st} track_ed=${q.track_ed}）`);
	const category = q.category === "overlay" || q.category === "fullscreen" ? q.category : undefined;
	return { compositionId: q.composition_id, slotSec, ...(category ? { category } : {}), item: q };
}
