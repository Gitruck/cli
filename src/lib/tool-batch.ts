/**
 * 工具族批次外壳（纯函数，零 IO）——openspec: add-tool-batch-runner。
 *
 * ## 立题
 *
 * `gtrk tool <name>` 一次处理一个输入。镜头量级上百之后，调用方必须自己实现：
 * 并发控制、断点续跑（已有产物跳过）、失败归类、进度与计费对账。
 * 2026-09-20 一次 232 镜的运镜，为此写了百余行一次性脚本——**其中批次骨架完全与工具无关**。
 *
 * 计费口径也要批次化：既有的「提交前计费提示」是**按单次**设计的，
 * 批量时逐条提示既无意义，也无法让人在开跑前看清总额。
 *
 * ## 射程：只排队与记账，不碰任何工具的实现
 *
 * 本文件不知道 `image_move` 和 `video_purify` 有什么区别，也不该知道。
 * 它只回答四件事：**跑哪些、跳哪些、几条并发、最后怎么记账**。
 * 单条怎么跑由命令层把既有 `runTool` 当黑盒传进来——
 * 这样「`--batch` 缺席时单次路径逐字不变」是**结构性**保证，不靠自觉。
 */

/** 云端工具缺省并发。保守是有理由的：打爆云端的代价由主理人的账号承担。 */
export const DEFAULT_JOBS_CLOUD = 4;

/**
 * 本地引擎工具缺省并发 **恒为 1**。
 *
 * 不是保守，是**已知会挂**：本地 ComfyUI 那条线实测过，并发提交会把显存打满、
 * 触发 WDDM 驱动复位（系统日志 `nvlddmkm` + 无 python APPCRASH）。
 * 本地引擎类 `--jobs>1` MUST 告警——让人知道他在越过一条踩出来的线。
 */
export const DEFAULT_JOBS_LOCAL = 1;

/** 并发上限。再高也只是把排队从云端挪到本机，还放大了限流的概率。 */
export const MAX_JOBS = 16;

export type BatchItemStatus = "pending" | "skipped" | "ok" | "failed";

export interface BatchItem {
	/** 输入绝对路径。 */
	input: string;
	/** 该条的产物目录（由命令层按既有 `resolveOutDir` 算，本文件不自己拼）。 */
	outDir: string;
	status: BatchItemStatus;
	/** 跳过原因 / 失败原因。 */
	reason?: string;
	/** 产物文件（成功时）。 */
	files?: string[];
	/** 耗时毫秒。 */
	ms?: number;
	/** 云端任务 id（有就带，出事能凭它找回）。 */
	taskId?: string;
}

export function clampJobs(requested: unknown, fallback: number): number {
	const n = Math.trunc(Number(requested));
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.max(1, Math.min(MAX_JOBS, n));
}

/** 按工具类别定缺省并发（tasks 0.1 拍板：按描述符分档，不设全局一个默认）。 */
export function defaultJobsFor(kind: string): number {
	return kind === "local" ? DEFAULT_JOBS_LOCAL : DEFAULT_JOBS_CLOUD;
}

/**
 * 排队：哪些真跑、哪些跳。
 *
 * `--skip-existing` 的判据由调用方以 `hasOutput` 注入（它要看盘）。
 * 判据本身写在这里的理由：**「已有产物」不等于「目录存在」**——
 * 目录可能是上次跑到一半留下的空壳，按目录存在跳过会把半成品当成品交付。
 * 故判据是「产物目录里**有产物**」，空目录 MUST NOT 算已完成。
 */
export function planBatch(
	inputs: ReadonlyArray<{ input: string; outDir: string }>,
	opts: { skipExisting?: boolean; hasOutput?: (outDir: string) => boolean } = {},
): BatchItem[] {
	return inputs.map((it) => {
		if (opts.skipExisting && opts.hasOutput?.(it.outDir)) {
			return { ...it, status: "skipped" as const, reason: "已有产物（--skip-existing）" };
		}
		return { ...it, status: "pending" as const };
	});
}

export interface BatchBilling {
	/** 真要跑的条数（跳过的不计费）。 */
	billable: number;
	/** 单条计费提示（来自既有定价解析，本文件不自己算价）。 */
	unitHint: string;
	/** 一次性总额提示行。 */
	line: string;
}

/**
 * 批次计费提示。
 *
 * ⚠️ **MUST NOT 退化成逐条提示**：跑 232 条就刷 232 行，人既看不清总额也会直接划过去。
 * 一次性给「多少条 × 单价」，在**开跑之前**。
 * 跳过的条目不进分母——断点续跑的全部意义就是不重复计费。
 */
export function batchBilling(items: ReadonlyArray<BatchItem>, unitHint: string): BatchBilling {
	const billable = items.filter((i) => i.status === "pending").length;
	const skipped = items.length - billable;
	return {
		billable,
		unitHint,
		line:
			`本批 ${items.length} 条` +
			(skipped ? `，其中 ${skipped} 条已有产物将跳过（不计费）` : "") +
			`，实际提交 ${billable} 条。单条计费：${unitHint}`,
	};
}

export interface BatchSummary {
	total: number;
	ok: number;
	failed: number;
	skipped: number;
	/** 失败明细（逐条报因，MUST NOT 只给个数）。 */
	failures: Array<{ input: string; reason: string }>;
	ms: number;
}

export function summarize(items: ReadonlyArray<BatchItem>, ms: number): BatchSummary {
	return {
		total: items.length,
		ok: items.filter((i) => i.status === "ok").length,
		failed: items.filter((i) => i.status === "failed").length,
		skipped: items.filter((i) => i.status === "skipped").length,
		failures: items
			.filter((i) => i.status === "failed")
			.map((i) => ({ input: i.input, reason: i.reason ?? "（未给原因）" })),
		ms,
	};
}

/**
 * 有界并发跑队列。固定 N 条工人流水线轮取——与 `particle-qtrle` 的同一形态。
 *
 * 失败策略 = **continue**（tasks 0.2 拍板）：一条坏输入不该毁掉整批。
 * 失败**记名**落回 item，由命令层如实汇总，MUST NOT 静默。
 *
 * ⚠️ `runOne` 抛出的异常在这里被吞并转成 `failed`——这是**唯一**允许吞的地方，
 * 因为吞完立刻记名并计入退出码。别把这个模式抄去别处。
 */
export async function runPool(
	items: BatchItem[],
	jobs: number,
	runOne: (item: BatchItem) => Promise<{ files: string[]; taskId?: string }>,
	onTick?: (done: number, total: number, item: BatchItem) => void,
): Promise<void> {
	const queue = items.filter((i) => i.status === "pending");
	let cursor = 0;
	let done = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = cursor++;
			if (i >= queue.length) return;
			const item = queue[i]!;
			const t0 = Date.now();
			try {
				const r = await runOne(item);
				item.status = "ok";
				item.files = r.files;
				if (r.taskId) item.taskId = r.taskId;
			} catch (e) {
				item.status = "failed";
				item.reason = e instanceof Error ? e.message : String(e);
			} finally {
				item.ms = Date.now() - t0;
				done++;
				onTick?.(done, queue.length, item);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(1, jobs), queue.length) }, () => worker()));
}

/** 逐条 jsonl 的一行（对账用：输入、产物、耗时、结果、失败原因都在）。 */
export function manifestLine(item: BatchItem, tool: string): string {
	return JSON.stringify({
		tool,
		input: item.input,
		out_dir: item.outDir,
		status: item.status,
		...(item.files ? { files: item.files } : {}),
		...(item.taskId ? { task_id: item.taskId } : {}),
		...(item.reason ? { reason: item.reason } : {}),
		...(item.ms !== undefined ? { ms: item.ms } : {}),
		at: new Date().toISOString(),
	});
}
