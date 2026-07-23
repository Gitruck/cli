/**
 * gtrk tool 工具族 —— 共享 runner（add-tool-command-family D3/D4/D5/D10）。
 *
 * cloud 型统一流水线：输入校验 → (10min 硬上限前置) → 可选 preprocess →
 * 匿名查询并打印实时价格（stderr）→ uploadAndSubmitTask（6004 可见性/缓存失效恢复）→ 自循环轮询（复用 getTaskResult，
 * 墙钟 per-tool 可覆盖）→ mapOutputs 流式下载落地 → task.json/result.json 面包屑。
 *
 * runner 只依赖 descriptor 契约字段，无任何工具名特判。沉淀 lib 零改动：
 *   - 上传/6004 恢复复用 upload-submit 共享边界；
 *   - 轮询自循环住此（不改 cloud.ts 的 pollTask，逐行对齐其语义）；
 *   - 产物走**流式下载**（fetch body pipe 到 createWriteStream，GB 级 alpha 不过内存），
 *     不复用 cloud.ts 全内存 download（cloud.ts 保持零改动）。
 */
import { resolve, join, dirname, basename, extname } from "node:path";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CloudConfig } from "./config";
import { submitTask, getTaskResult, type OralCutOutput } from "./cloud";
import { uploadCached, invalidateUpload } from "./upload-cache";
import { uploadAndSubmitTask } from "./upload-submit";
import { probeDuration } from "./media";
import { resolveToolPricing, type PriceResolver } from "./tool-pricing";
import {
	type ToolDescriptor,
	type ToolContext,
	type DownloadItem,
	type OutputResult,
	defaultExtsFor,
} from "./tool-descriptors";

const DEFAULT_POLL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5000;

// ---------------------------------------------------------------- 结果契约

export interface RunToolResult {
	ok: boolean;
	tool: string;
	taskType?: string;
	taskId?: string;
	fileId?: string;
	outDir: string;
	/** 已落地产物本地绝对路径。 */
	files: string[];
	/** 结构化结果落盘文件路径（descriptor 声明 mapResult 时落 result-output.json）。 */
	resultFile?: string;
	/** 产物下载失败明细（有则 ok=false、进程非 0）。 */
	errors?: Record<string, string>;
}

/** 可注入依赖（默认=真实实现；测试注入假实现，免 FS 缓存/网络副作用）。 */
export interface CloudToolDeps {
	cfg: CloudConfig;
	uploadCached: typeof uploadCached;
	invalidateUpload: typeof invalidateUpload;
	submitTask: typeof submitTask;
	getTaskResult: typeof getTaskResult;
	downloadStream: (url: string, dest: string) => Promise<void>;
	/** 视频硬上限探时长（秒）；默认走 ffprobe。 */
	probeDurationSec?: (path: string, ffmpegPath?: string) => number;
	pollIntervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** 实时价格解析；默认匿名请求官网价格表，测试可注入。 */
	resolvePricing?: PriceResolver;
}

// ---------------------------------------------------------------- 透传参数（--param / --params-json）

/** k=v 的 value 智能转型：true/false→bool、纯数字→number、否则原样字符串（对齐 oralcut）。 */
export function coerceValue(v: string): unknown {
	if (v === "true") return true;
	if (v === "false") return false;
	if (v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
	return v;
}

/** 解析 --param k=v[] + --params-json，合成透传对象（params-json 覆盖同名 --param）。 */
export function parseExtraParams(pairs: string[], jsonStr?: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const pair of pairs) {
		const i = pair.indexOf("=");
		if (i < 0) throw new Error(`--param 需要 key=value 格式：「${pair}」`);
		out[pair.slice(0, i).trim()] = coerceValue(pair.slice(i + 1));
	}
	if (jsonStr) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonStr);
		} catch {
			throw new Error(`--params-json 不是合法 JSON：${jsonStr}`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("--params-json 必须是一个 JSON 对象");
		}
		Object.assign(out, parsed as Record<string, unknown>);
	}
	return out;
}

/** 在 payload 上逐字段合并覆盖 extraParams（对象字段做一层合并、免整体覆盖丢字段；对齐 oralcut）。 */
export function mergeParams(payload: Record<string, unknown>, extra: Record<string, unknown>): void {
	for (const [k, v] of Object.entries(extra)) {
		const cur = payload[k];
		const bothObj =
			!!cur && !!v && typeof cur === "object" && typeof v === "object" && !Array.isArray(cur) && !Array.isArray(v);
		payload[k] = bothObj
			? { ...(cur as Record<string, unknown>), ...(v as Record<string, unknown>) }
			: v;
	}
}

// ---------------------------------------------------------------- 输入校验 + 时长硬门

/** 输入扩展名 / 存在性校验（无 ffmpeg 依赖）。 */
export function validateToolInput(descriptor: ToolDescriptor, inputAbs: string | undefined): void {
	const spec = descriptor.input;
	if (spec.kind === "none") return;
	if (!inputAbs) throw new Error(`${descriptor.name} 需要输入${spec.kind === "directory" ? "目录" : "文件"}`);
	if (!existsSync(inputAbs)) throw new Error(`输入不存在：${inputAbs}`);
	if (spec.kind === "directory") return;
	const exts = spec.exts ?? defaultExtsFor(spec.kind);
	if (exts && exts.length) {
		const e = extname(inputAbs).toLowerCase();
		if (!exts.includes(e)) {
			throw new Error(
				`${descriptor.name} 需要 ${spec.kind} 输入，但拿到「${e || "无扩展名"}」（支持：${exts.join(" ")}）`,
			);
		}
	}
}

/** 视频硬上限前置（上传前）：> maxDurationSec 直接拒绝（不上传不提交、人话报错）。 */
export function guardDuration(
	descriptor: ToolDescriptor,
	inputAbs: string | undefined,
	probe: (path: string, ffmpegPath?: string) => number,
	ffmpegPath?: string,
): void {
	const max = descriptor.input.maxDurationSec;
	if (max == null || !inputAbs) return;
	const sec = probe(inputAbs, ffmpegPath);
	if (sec > max) {
		throw new Error(`视频超过 ${Math.round(max / 60)} 分钟上限，请先裁剪`);
	}
}

// ---------------------------------------------------------------- 流式下载

/** 流式下载 URL → dest：fetch body pipe 到 createWriteStream，产物不整体进内存。 */
export async function downloadStream(url: string, dest: string): Promise<void> {
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
	// node:stream/web 与 DOM lib 的 ReadableStream 声明打架；运行时同一实现（对齐 cloud.ts 的 toWeb 处理）
	await pipeline(Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}

// ---------------------------------------------------------------- 轮询（自循环复用 getTaskResult，对齐 pollTask 语义）

export interface PollOpts {
	timeoutMs?: number;
	intervalMs?: number;
	getResult?: (cfg: CloudConfig, taskType: string, taskId: string) => Promise<{
		status: string;
		progress?: number;
		output: OralCutOutput;
	}>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	onTick?: (status: string, progress?: number) => void;
}

/**
 * 轮询任务到 completed，返回 output_result。逐行对齐 cloud.ts 的 pollTask：
 * 循环内先查墙钟 → sleep(interval) → getResult（瞬断/解析失败容忍继续；CloudError 透传）→
 * completed 返回 / failed·cancelled 按云端 error 报错 / 其余 onTick 续轮。
 * 墙钟默认 30min，descriptor 的 pollTimeoutMs 经此覆盖。sleep/now 可注入（离线测试用）。
 *
 * CloudError 采用鸭子判定（`.code` 为数字即视为真错误码）而非 instanceof——esbuild 逐文件打包时
 * 各 bundle 的 CloudError 类身份不同，鸭子判定跨 bundle 稳、且与 pollTask 行为等价（网络/解析异常无 code）。
 */
export async function pollToolTask(
	cfg: CloudConfig,
	taskType: string,
	taskId: string,
	opts: PollOpts = {},
): Promise<OralCutOutput> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
	const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const getResult = opts.getResult ?? getTaskResult;
	const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = opts.now ?? Date.now;
	const start = now();
	for (;;) {
		if (now() - start > timeoutMs) {
			throw new Error(
				`任务超时（超过 ${Math.round(timeoutMs / 60000)} 分钟）。可稍后凭 task_id（${taskId}）在云端查询或重试。`,
			);
		}
		await sleep(intervalMs);
		let got: { status: string; progress?: number; output: OralCutOutput };
		try {
			got = await getResult(cfg, taskType, taskId);
		} catch (e) {
			if (isCloudErrorCode(e) != null) throw e; // 真错误码：透传（对齐 pollTask）
			continue; // 瞬断/解析失败不致命，下次再试（墙钟兜底）
		}
		if (got.status === "completed") return got.output;
		if (got.status === "failed" || got.status === "cancelled") {
			const out = got.output as { error?: string };
			throw new Error(out?.error ?? (got.status === "failed" ? "任务失败" : "任务已取消"));
		}
		opts.onTick?.(got.status || "处理中", got.progress);
	}
}

/** 鸭子判定 CloudError 错误码：错误对象带数字 `.code` 即返回之，否则 undefined。 */
function isCloudErrorCode(e: unknown): number | undefined {
	const c = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
	return typeof c === "number" ? c : undefined;
}

// ---------------------------------------------------------------- 面包屑目录名

/** 本地时间戳 YYMMDD-HHMMSS（input=none 的工具产物目录用）。 */
function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 产物目录：<输入名去扩展>-<name>/（无输入落 cwd 下 <name>-<时间戳>/）；--out 覆盖。 */
export function resolveOutDir(descriptor: ToolDescriptor, inputAbs: string | undefined, out?: string): string {
	if (out) return resolve(out);
	if (inputAbs) {
		const base = basename(inputAbs, extname(inputAbs));
		return join(dirname(inputAbs), `${base}-${descriptor.name}`);
	}
	return join(process.cwd(), `${descriptor.name}-${timestamp()}`);
}

/** 输入指纹 size:mtime（best-effort，写进 task.json 供人工恢复对照）。 */
async function safeFingerprint(inputAbs: string): Promise<string | undefined> {
	try {
		const s = await stat(inputAbs);
		return `${s.size}:${Math.round(s.mtimeMs)}`;
	} catch {
		return undefined;
	}
}

/** 提交前计费提示：一律走 stderr（人读；--json 下不污染 stdout 机读契约）。 */
function emitBilling(hint: string): void {
	process.stderr.write(`\x1b[33m⚠️  计费提示：${hint}\x1b[0m\n`);
}

// ---------------------------------------------------------------- cloud 型编排

interface CommonOpts {
	out?: string;
	param?: string[];
	paramsJson?: string;
	ffmpegPath?: string;
	reupload?: boolean;
	[k: string]: unknown;
}

/**
 * cloud 型工具执行主链路。deps 缺省=真实实现；测试注入假实现。
 * 产物下载失败（含 404 过期）不抛：记 result.json errors、ok=false、保留 task.json 供人工恢复。
 */
export async function runCloudTool(
	descriptor: ToolDescriptor,
	inputArg: string | undefined,
	opts: CommonOpts,
	deps: CloudToolDeps,
): Promise<RunToolResult> {
	const inputAbs = inputArg ? resolve(inputArg) : undefined;
	const baseName = inputAbs ? basename(inputAbs, extname(inputAbs)) : descriptor.name;

	// ① 输入校验（扩展名/存在性）+ 视频硬上限前置（上传前拒绝，零上传零提交）
	validateToolInput(descriptor, inputAbs);
	const probe = deps.probeDurationSec ?? probeDuration;
	guardDuration(descriptor, inputAbs, probe, opts.ffmpegPath);

	const extraParams = parseExtraParams(opts.param ?? [], opts.paramsJson);
	const ctx: ToolContext = {
		inputAbs,
		baseName,
		ffmpegPath: opts.ffmpegPath,
		opts,
		extraParams,
		warn: (m) => process.stderr.write(`\x1b[2m   ${m}\x1b[0m\n`),
	};
	const outDir = resolveOutDir(descriptor, inputAbs, opts.out);

	// ② 可选本地预处理（缺省=原文件直传）
	let uploadPath = inputAbs;
	if (descriptor.preprocess) uploadPath = await descriptor.preprocess(ctx);
	if (!uploadPath) throw new Error(`${descriptor.name} 缺上传物（input=none 的 cloud 型工具需 preprocess 产上传物）`);

	// ③ 提交前匿名查询实时价格并提示 → 上传（失败仅提示 unavailable，不阻断能力）
	let billingHint: string;
	try {
		billingHint = (await (deps.resolvePricing ?? resolveToolPricing)(descriptor.priceKey!, descriptor.pricingContext)).billingHint;
	} catch {
		billingHint = "实时价格暂不可用，以服务端结算为准";
	}
	emitBilling(billingHint);

	const buildPayload = (fid: string): Record<string, unknown> => {
		const p = descriptor.buildPayload ? descriptor.buildPayload(fid, ctx) : { file_id: fid };
		// 通用透传优先级最高：agent 永远能强制覆盖 descriptor 拼装的任意字段
		mergeParams(p, extraParams);
		return p;
	};

	// ④ 上传并提交；新 file_id 延迟可见短退避，缓存 file_id 失效则强制重传一次
	const taskType = descriptor.taskType!;
	const submitted = await uploadAndSubmitTask(
		deps.cfg,
		uploadPath,
		taskType,
		buildPayload,
		{ force: opts.reupload },
		{
			uploadCached: deps.uploadCached,
			invalidateUpload: deps.invalidateUpload,
			submitTask: deps.submitTask,
			sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
		},
	);
	const { taskId } = submitted;
	const up = { fileId: submitted.fileId, cached: submitted.cached };

	// ⑤ 面包屑：submit 一成功就落盘 task.json（目录延后到此刻才建），后续任何崩溃都能据 task_id 恢复
	await mkdir(outDir, { recursive: true });
	const fingerprint = inputAbs ? await safeFingerprint(inputAbs) : undefined;
	await writeFile(
		join(outDir, "task.json"),
		JSON.stringify(
			{ tool: descriptor.name, taskType, taskId, fileId: up.fileId, source: inputAbs, fingerprint, createdAt: new Date().toISOString() },
			null,
			2,
		),
	);

	// ⑥ 轮询到完成（墙钟 per-tool 可覆盖）
	const output = await pollToolTask(deps.cfg, taskType, taskId, {
		timeoutMs: descriptor.pollTimeoutMs,
		intervalMs: deps.pollIntervalMs,
		getResult: deps.getTaskResult,
		sleep: deps.sleep,
		now: deps.now,
	});

	// ⑦ 产物落地（两条独立路径，均由 descriptor 声明驱动）+ result.json 恒落盘（不受 --json 约束）
	const outputResult = output as unknown as OutputResult;
	const files: string[] = [];
	const errors: Record<string, string> = {};

	// (a) 文件下载路径：mapOutputs 收敛下载清单，流式落地。
	const items: DownloadItem[] = descriptor.mapOutputs ? descriptor.mapOutputs(outputResult, ctx) : [];
	for (const it of items) {
		const dest = join(outDir, it.filename);
		try {
			await deps.downloadStream(it.url, dest);
			files.push(dest);
		} catch (e) {
			errors[it.filename] = e instanceof Error ? e.message : String(e);
		}
	}

	// (b) 结构化结果路径：mapResult 收敛结构对象，落 result-output.json 面包屑。
	let resultFile: string | undefined;
	const structured = descriptor.mapResult ? descriptor.mapResult(outputResult, ctx) : undefined;
	if (structured != null) {
		resultFile = join(outDir, "result-output.json");
		await writeFile(resultFile, JSON.stringify(structured, null, 2));
	}

	// 「既无文件也无结构」才判缺产物；有结构化产出时空下载清单不单独判失败。
	if (items.length === 0 && resultFile == null) {
		errors["output"] = "任务完成但未解析到任何产物（下载链接与结构化结果均为空，output_result 形态异常）";
	}
	const ok = Object.keys(errors).length === 0 && (files.length > 0 || resultFile != null);
	const result: RunToolResult = {
		ok,
		tool: descriptor.name,
		taskType,
		taskId,
		fileId: up.fileId,
		outDir,
		files,
		...(resultFile ? { resultFile } : {}),
		...(Object.keys(errors).length ? { errors } : {}),
	};
	await writeFile(
		join(outDir, "result.json"),
		JSON.stringify({ ...result, finishedAt: new Date().toISOString() }, null, 2),
	);
	return result;
}
