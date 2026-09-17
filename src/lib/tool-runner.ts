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
import { DEFAULT_VISIBILITY_BACKOFF_MS } from "./upload-submit";
import { probeDuration } from "./media";
import { resolveToolPricing, type PriceResolver } from "./tool-pricing";
import {
	MULTI_INPUT_KINDS,
	type ToolDescriptor,
	type ToolContext,
	type DownloadItem,
	type ExtraInputSpec,
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
	/** 多文件类别（images/videos）输入时的全量 file_id（与输入同序；此时 fileId=首个）。 */
	fileIds?: string[];
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
	/** opts.exclusive=true 时以 O_CREAT|O_EXCL 落地（已存在即 EEXIST，由调用方改名重试）。 */
	downloadStream: (url: string, dest: string, opts?: { exclusive?: boolean }) => Promise<void>;
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
				`${descriptor.name} 需要 ${spec.kind} 输入，但拿到「${e || "无扩展名"}」（支持：${exts.join(" ")}）` +
					(spec.rejectHint ? `。${spec.rejectHint}` : ""),
			);
		}
	}
}

/** 多文件输入校验：≥1、逐个存在性 + 对应类别扩展名白名单；任一非法整单拒绝（零上传）。 */
export function validateToolInputs(descriptor: ToolDescriptor, inputAbsList: string[]): void {
	if (!inputAbsList.length) throw new Error(`${descriptor.name} 需要至少一个输入文件（可传多个，顺序即拼装顺序）`);
	const exts = descriptor.input.exts ?? defaultExtsFor(descriptor.input.kind);
	for (const p of inputAbsList) {
		if (!existsSync(p)) throw new Error(`输入不存在：${p}`);
		if (exts && exts.length) {
			const e = extname(p).toLowerCase();
			if (!exts.includes(e)) {
				const noun = descriptor.input.kind === "videos" ? "视频" : "图片";
				throw new Error(`${descriptor.name} 需要${noun}输入，但「${basename(p)}」是「${e || "无扩展名"}」（支持：${exts.join(" ")}）`);
			}
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
		throw new Error(`输入时长超过 ${Math.round(max / 60)} 分钟上限，请先裁剪或分段后再提交`);
	}
}

// ---------------------------------------------------------------- 附加输入文件（link-video-translate-dub-cli D3）

/** 本次实际要上传的附加输入：给了值、未被 ignoreReason 放弃、且已过本地校验。 */
export interface ActiveExtraInput {
	spec: ExtraInputSpec;
	abs: string;
}

/**
 * 附加输入的本地校验（纯本地、零网络）：逐个解析绝对路径、校验存在性与扩展名，不过即抛——
 * 调用点在**任何上传之前**，所以坏参数零上传零提交零计费。
 * 未给值的附加输入不出现在返回值里（⇒ payload 不写键、面包屑不记）；
 * 声明了 ignoreReason 且本次用不上的，经 ctx.warn 提示一次后同样跳过。
 */
export function resolveExtraInputs(descriptor: ToolDescriptor, ctx: ToolContext): ActiveExtraInput[] {
	const active: ActiveExtraInput[] = [];
	for (const spec of descriptor.extraInputs ?? []) {
		const raw = ctx.opts[spec.optKey];
		if (raw == null || String(raw).trim() === "") continue;
		const reason = spec.ignoreReason?.(ctx);
		if (reason) {
			ctx.warn(reason);
			continue;
		}
		const flagName = spec.flag.split(/\s/)[0];
		const abs = resolve(String(raw));
		if (!existsSync(abs)) throw new Error(`${flagName} 指定的文件不存在：${abs}`);
		const e = extname(abs).toLowerCase();
		if (!spec.exts.includes(e)) {
			throw new Error(`${flagName} 不支持「${e || "无扩展名"}」文件（支持：${spec.exts.join(" ")}）`);
		}
		active.push({ spec, abs });
	}
	return active;
}

/** 把附加输入的 file_id 写进 payload（与 extras 同序；覆盖 descriptor 返回值中的同名键）。 */
function applyExtraFileIds(payload: Record<string, unknown>, extras: ActiveExtraInput[], fileIds: string[]): void {
	extras.forEach((x, i) => {
		payload[x.spec.payloadKey] = fileIds[i];
	});
}

// ---------------------------------------------------------------- 流式下载

/**
 * 流式下载 URL → dest：fetch body pipe 到 createWriteStream，产物不整体进内存。
 *
 * `exclusive: true` 走 flags `"wx"`（`O_CREAT|O_EXCL`）：目标已存在时内核抛 EEXIST，
 * **原子**地把「谁占住这个文件名」这件事仲裁掉，调用方据此改名重试
 * （fix-tool-outdir-collision 第二层；MUST NOT 换成 existsSync 先探后写，那是 TOCTOU）。
 * 缺省仍是 `"w"`（截断），有输入文件的工具幂等重跑逐字节不变。
 */
export async function downloadStream(url: string, dest: string, opts?: { exclusive?: boolean }): Promise<void> {
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
	// node:stream/web 与 DOM lib 的 ReadableStream 声明打架；运行时同一实现（对齐 cloud.ts 的 toWeb 处理）
	await pipeline(
		Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
		createWriteStream(dest, opts?.exclusive ? { flags: "wx" } : undefined),
	);
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

// ---------------------------------------------------------------- 单文件 cloud 任务执行核（add-matrix-local-image-broll D4 抽取）

/** runCloudFileTask 的依赖面（CloudToolDeps 的子集——tool 命令与铺轨运镜联动都能直接喂）。 */
export interface CloudFileTaskDeps {
	cfg: CloudConfig;
	uploadCached: typeof uploadCached;
	invalidateUpload: typeof invalidateUpload;
	submitTask: typeof submitTask;
	getTaskResult: typeof getTaskResult;
	sleep?: (ms: number) => Promise<void>;
	pollIntervalMs?: number;
	now?: () => number;
}

/**
 * 单文件 cloud 任务执行核：上传（缓存/6004 失效恢复）→ 提交 → 轮询到完成，返回 output_result。
 * 从 `gtrk tool` 执行链抽取（add-matrix-local-image-broll 3.1）：tool 命令（runCloudTool 单文件分支）
 * 与铺轨图片运镜联动（image-move.ts）共用本函数，MUST NOT 各自复制「上传→提交→轮询」链。
 * `onSubmitted` 在提交成功、轮询开始之前回调（tool 命令在此落 task.json 面包屑——崩溃可凭 task_id 恢复）。
 */
export async function runCloudFileTask(opts: {
	deps: CloudFileTaskDeps;
	uploadPath: string;
	taskType: string;
	buildPayload: (fileId: string) => Record<string, unknown>;
	forceReupload?: boolean;
	pollTimeoutMs?: number;
	onSubmitted?: (info: { taskId: string; fileId: string }) => Promise<void> | void;
	onTick?: (status: string, progress?: number) => void;
}): Promise<{ taskId: string; fileId: string; output: OralCutOutput }> {
	const d = opts.deps;
	const submitted = await uploadAndSubmitTask(
		d.cfg,
		opts.uploadPath,
		opts.taskType,
		opts.buildPayload,
		{ force: opts.forceReupload },
		{
			uploadCached: d.uploadCached,
			invalidateUpload: d.invalidateUpload,
			submitTask: d.submitTask,
			sleep: d.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
		},
	);
	await opts.onSubmitted?.(submitted);
	const output = await pollToolTask(d.cfg, opts.taskType, submitted.taskId, {
		timeoutMs: opts.pollTimeoutMs,
		intervalMs: d.pollIntervalMs,
		getResult: d.getTaskResult,
		sleep: d.sleep,
		now: d.now,
		onTick: opts.onTick,
	});
	return { taskId: submitted.taskId, fileId: submitted.fileId, output };
}

// ---------------------------------------------------------------- 多文件上传 + 提交（add-tool-multifile-images / add-tool-video-split-screen）

/** 与 upload-submit 同义的服务端错误码：素材暂不可见/已失效。 */
const MATERIAL_NOT_FOUND = 6004;

/** 提交并对 6004 按可见性退避表重试（fresh=false 时零退避、首错即抛，对齐单文件语义）。 */
async function submitWithVisibilityBackoff(
	trySubmit: () => Promise<string>,
	fresh: boolean,
	sleep: (ms: number) => Promise<void>,
): Promise<string> {
	const backoff = fresh ? DEFAULT_VISIBILITY_BACKOFF_MS : [];
	for (let attempt = 0; ; attempt++) {
		try {
			return await trySubmit();
		} catch (e) {
			if (isCloudErrorCode(e) !== MATERIAL_NOT_FOUND || attempt >= backoff.length) throw e;
			await sleep(backoff[attempt]!);
		}
	}
}

/**
 * 多文件版上传+提交编排（等效拆装 uploadAndSubmitTask 语义，不降级恢复保证）：
 * 逐文件缓存上传（顺序=传入顺序）→ 一次提交；6004 时把全部缓存条目失效并强制重传一次，
 * 再按新 file_id 可见性退避重提。含任一 fresh 上传的首轮提交也走退避（新 ID 延迟可见）。
 */
async function uploadManyAndSubmit(
	deps: CloudToolDeps,
	paths: string[],
	taskType: string,
	buildPayload: (fileIds: string[]) => unknown,
	force: boolean,
): Promise<{ taskId: string; fileIds: string[]; cached: boolean }> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	// 合规告知不在此挂载：已下沉到 uploadCached（文件上传的唯一咽喉），本编排经其转发即被覆盖。
	const uploads: Array<{ fileId: string; cached: boolean }> = [];
	for (const p of paths) uploads.push(await deps.uploadCached(deps.cfg, p, { force }));
	const trySubmit = () => deps.submitTask(deps.cfg, taskType, buildPayload(uploads.map((u) => u.fileId)));
	const anyFresh = uploads.some((u) => !u.cached);
	try {
		const taskId = await submitWithVisibilityBackoff(trySubmit, anyFresh, sleep);
		return { taskId, fileIds: uploads.map((u) => u.fileId), cached: !anyFresh };
	} catch (e) {
		if (isCloudErrorCode(e) !== MATERIAL_NOT_FOUND || !uploads.some((u) => u.cached)) throw e;
		// 缓存 file_id 可能已失效：全部缓存条目失效并强制重传一次，再按新 ID 退避重提
		for (let i = 0; i < paths.length; i++) {
			if (uploads[i]!.cached) {
				await deps.invalidateUpload(paths[i]!);
				uploads[i] = await deps.uploadCached(deps.cfg, paths[i]!, { force: true });
			}
		}
		const taskId = await submitWithVisibilityBackoff(trySubmit, true, sleep);
		return { taskId, fileIds: uploads.map((u) => u.fileId), cached: false };
	}
}

// ---------------------------------------------------------------- 面包屑目录名

/** 本地时间戳 YYMMDD-HHMMSS（input=none 的工具产物目录用）。 */
/**
 * 产物目录用的秒级时间戳 `YYMMDD-HHMMSS`（本地时区）。
 * ⚠️ **全仓唯一实现**：`src/lib/mad/mad.ts` 曾另写过一份逐字等价的（2026-09-16 已收敛到这里）。
 * 秒级粒度本身撞得上——防撞靠 {@link createOutDir} 的原子探路，不靠加长时间戳。
 */
export function timestamp(now: Date = new Date()): string {
	const d = now;
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

/** 撞名消解的序号上界（撞满即报错；MUST NOT 无限重试）。 */
const MAX_OUTDIR_CANDIDATES = 99;

/**
 * 固定名面包屑清单（`task.json` 提交即落、`result.json` 收尾落、`result-output.json` 结构化结果）。
 * 三者**按固定名被消费**，故撞名时 MUST NOT 改名、只 WARN —— 口径见
 * `fix-tool-outdir-collision` Open Question ① 的 2026-09-16 拍板。
 */
const BREADCRUMB_NAMES = ["task.json", "result.json", "result-output.json"] as const;

/** 取 fs 错误码（EEXIST/ENOENT…）；非 fs 错误返回 undefined。 */
function fsErrCode(e: unknown): string | undefined {
	const c = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
	return typeof c === "string" ? c : undefined;
}

/**
 * 建产物目录，返回**真正建成**的绝对路径（fix-tool-outdir-collision 第一层）。
 *
 * `antiCollision=true`（= 无输入文件、无 `--out` 的时间戳候选名那一支）走**非 recursive** `mkdir` 探路：
 * 目录已存在时内核抛 EEXIST，这是操作系统给的**原子**仲裁；捕获即把候选名换成
 * `<候选名>-2`、`-3`… 依次重试，直到建成为止。
 *
 * ⚠️ MUST NOT 改成 `existsSync(dir)` 先探再建 —— 那是 TOCTOU：两个进程会同时判「不存在」
 * 然后双双 mkdir 成功，正好还原 2026-09-02 那次真机事故（两条 audio_tts_clone 同秒起、
 * 两份 --json 回执的 outDir 逐字符相同，先提交那条的 9,561,644 字节 wav 与它的 task.json
 * 被后提交那条整体抹掉，回执却一切正常）。仲裁只能靠 mkdir 本身的失败。
 *
 * `antiCollision=false` 保持 `mkdir(recursive:true)`，两支行为逐字节不变：
 * `<输入名>-<tool>/` 重跑同一输入本就该落回同一目录（幂等重跑是设计如此）；
 * `--out` 是用户明示的落点，替他改名反而是惊吓（skill 里「落进工程目录」的用法全靠这条）。
 */
export async function createOutDir(candidate: string, antiCollision: boolean): Promise<string> {
	if (!antiCollision) {
		await mkdir(candidate, { recursive: true });
		return candidate;
	}
	for (let n = 1; n <= MAX_OUTDIR_CANDIDATES; n++) {
		const dir = n === 1 ? candidate : `${candidate}-${n}`;
		try {
			await mkdir(dir); // 非 recursive：已存在即 EEXIST（唯一仲裁点）
			if (n > 1) {
				emitWarn(`产物目录「${basename(candidate)}」已被占用，本次改落「${basename(dir)}」（既有目录原样保留）`);
			}
			return dir;
		} catch (e) {
			if (fsErrCode(e) !== "EEXIST") throw e; // 权限/父目录缺失等真错误照抛，不吞
		}
	}
	throw new Error(
		`产物目录「${candidate}」及其 -2…-${MAX_OUTDIR_CANDIDATES} 序号变体均已被占用，无法确定落点。` +
			`请清理旧产物或用 --out 显式指定目录。`,
	);
}

/**
 * 产物撞名消解名：`<基名>-<taskId 后 6 位><扩展名>`。
 * 用 taskId 而非随机后缀 —— 本仓对产物命名有确定性硬要求，taskId 天然唯一且可回溯到那次提交。
 */
export function collisionName(filename: string, taskId: string): string {
	const ext = extname(filename);
	const stem = filename.slice(0, filename.length - ext.length);
	return `${stem}-${taskId.slice(-6) || "dup"}${ext}`; // taskId 恒非空（下载时早已赋值），"dup" 只是兜底
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

/**
 * 落点告警（目录改名 / 产物改名 / 产物将被覆盖）：与计费提示同口径，**一律直写 stderr**。
 * 不走 log.warn —— 那条非 --json 时落 stdout；这里的三条 WARN 必须在任何模式下都不污染
 * `--json` 的 stdout 单行契约。「回执没变、路径没变、内容换人」是本 change 立案的真机形态，
 * 所以改名与覆盖 MUST NOT 静默。
 */
function emitWarn(msg: string): void {
	process.stderr.write(`\x1b[33m⚠️  ${msg}\x1b[0m\n`);
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
	inputArg: string | string[] | undefined,
	opts: CommonOpts,
	deps: CloudToolDeps,
): Promise<RunToolResult> {
	const isMulti = MULTI_INPUT_KINDS.has(descriptor.input.kind);
	const inputList = isMulti
		? (Array.isArray(inputArg) ? inputArg : inputArg != null ? [inputArg] : []).map((p) => resolve(p))
		: undefined;
	const inputAbs = isMulti ? inputList![0] : typeof inputArg === "string" ? resolve(inputArg) : undefined;
	const baseName = inputAbs ? basename(inputAbs, extname(inputAbs)) : descriptor.name;

	// ① 输入校验（扩展名/存在性）+ 视频硬上限前置（上传前拒绝，零上传零提交）
	if (isMulti) {
		validateToolInputs(descriptor, inputList!);
	} else {
		validateToolInput(descriptor, inputAbs);
		const probe = deps.probeDurationSec ?? probeDuration;
		guardDuration(descriptor, inputAbs, probe, opts.ffmpegPath);
	}

	const extraParams = parseExtraParams(opts.param ?? [], opts.paramsJson);
	// 落点：resolveOutDir 只产**候选名**（它在这一刻执行、真正建目录在 submit 之后的 writeBreadcrumb），
	// 最终名由 createOutDir 在建目录那一刻回填（防撞可能追加 -2/-3…）。下游全部读回填后的 outDir。
	const outDirCandidate = resolveOutDir(descriptor, inputAbs, opts.out);
	const ctx: ToolContext = {
		inputAbs,
		...(inputList ? { inputAbsList: inputList } : {}),
		baseName,
		ffmpegPath: opts.ffmpegPath,
		opts,
		extraParams,
		outDir: outDirCandidate,
		warn: (m) => process.stderr.write(`\x1b[2m   ${m}\x1b[0m\n`),
	};
	let outDir = outDirCandidate;
	// 防撞射程与 resolveOutDir 的三支一一对应：只有「无输入文件 + 无 --out」那支是秒级时间戳候选名。
	const antiCollision = !opts.out && !inputAbs;

	// ①b 必填参数与枚举校验的**前置干跑**：payload 是纯函数，拿占位 id 先跑一遍，
	// 缺参（如 --main-title）与传错枚举（--subtitle-type…）在**上传之前**就报错。
	// ⟲ 单输入那支是 link-enum-catalog-cli §2.1 补的：此前只有多文件干跑，
	//    而单输入工具的 buildPayload 跑在 submit 里、也就是**上传之后** ——
	//    传错一个字幕样式要等几百 MB 传完才失败，正是本 change 要治的体验。
	if (isMulti) {
		descriptor.buildPayloadMulti!(inputList!.map(() => "__dry_run__"), ctx);
	} else if (descriptor.kind === "cloud" && descriptor.buildPayload) {
		descriptor.buildPayload("__dry_run__", ctx);
	}

	// ①c 附加输入的本地校验（link-video-translate-dub-cli D3）：排在必填干跑之后（ignoreReason 可能要读必填参数）、
	// 任何上传之前（坏扩展名 / 文件不存在零上传零提交）。真正上传排在主输入之后，见下方两条上传分支。
	const extraInputs = resolveExtraInputs(descriptor, ctx);

	// ②b 零上传直提交（none + buildPayloadNone，add-tool-audio-tts-clone）：纯参数任务无上传物
	const isNoneDirect = descriptor.input.kind === "none" && !!descriptor.buildPayloadNone;

	// ② 可选本地预处理（缺省=原文件直传；多文件类别不支持 preprocess，注册表已拒）
	let uploadPath = inputAbs;
	if (!isMulti && descriptor.preprocess) uploadPath = await descriptor.preprocess(ctx);
	if (!uploadPath && !isNoneDirect) {
		throw new Error(`${descriptor.name} 缺上传物（input=none 的 cloud 型工具需 preprocess 产上传物或声明 buildPayloadNone）`);
	}

	// ③ 提交前匿名查询实时价格并提示 → 上传（失败仅提示 unavailable，不阻断能力）
	let billingHint: string;
	try {
		billingHint = (await (deps.resolvePricing ?? resolveToolPricing)(descriptor.priceKey!, descriptor.pricingContext)).billingHint;
	} catch {
		billingHint = "实时价格暂不可用，以服务端结算为准";
	}
	emitBilling(billingHint);

	// ④–⑥ 上传并提交 → 面包屑 → 轮询。新 file_id 延迟可见短退避，缓存 file_id 失效则强制重传一次；
	// 零上传路径：跳过上传/6004 恢复（无上传物无失效面），payload 直提交。
	// 面包屑口径不变：submit 一成功就落盘 task.json（目录延后到此刻才建、轮询之前），崩溃可凭 task_id 恢复。
	// 多文件类别输入时 source/fingerprint 为与输入同序的数组；单输入维持字符串形态逐字节不变。
	const taskType = descriptor.taskType!;
	let taskId = "";
	let fileId: string | undefined;
	let fileIds: string[] | undefined;
	let outDirReady = false;
	const writeBreadcrumb = async (): Promise<void> => {
		if (!outDirReady) {
			try {
				outDir = await createOutDir(outDirCandidate, antiCollision);
			} catch (e) {
				// 走到这一步任务**已提交**（可能已计费）。别让它连个恢复凭据都没有：把 task_id 带进错误。
				throw new Error(
					`${e instanceof Error ? e.message : String(e)}（任务已提交，task_id=${taskId}，可凭其在云端取回产物）`,
				);
			}
			// 固定名面包屑的覆盖告警（fix-tool-outdir-collision 0.2 拍板：补 WARN、不改名）。
			// 射程 = **显式 `--out`**：那是 proposal Open Question ① 点名的唯一残口。
			//   · 无 `--out` 且无输入文件 ⇒ 时间戳目录，第一层已原子防撞，撞不上；
			//   · 有输入文件 ⇒ `<输入名>-<tool>/` 幂等重跑本就该落回同一目录（设计如此），
			//     每次都喊会变噪音，故**刻意不报**。
			// 不改名的理由：三者按固定名被消费（`oralcut-result` / skill / agent 都按名读），改名会污染既有约定
			// —— 产物文件那一侧才走改名（见 resolveCollisionFreeName）。
			// 只在第一次建目录时判：writeBreadcrumb 会重入，放块外会把自己刚写的 task.json 当成旧的误报。
			if (opts.out) {
				const stale = BREADCRUMB_NAMES.filter((f) => existsSync(join(outDir, f)));
				if (stale.length > 0) {
					emitWarn(
						`「${outDir}」下已有上一次任务的面包屑（${stale.join("、")}），本次将覆盖它们——` +
							`固定名不参与改名，上一次的 task_id 与产物清单将不可回溯。` +
							`产物文件本身不受影响（撞名会自动改名保留）。要并行跑多条，给每条一个独立的 --out。`,
					);
				}
			}
			outDirReady = true; // 一次运行只建一次目录：重入不会再派生 -2
			ctx.outDir = outDir; // 防撞改名时回填（只有「无输入文件 + 无 --out」那支会改名）
		}
		const fingerprint = inputList
			? await Promise.all(inputList.map((p) => safeFingerprint(p)))
			: inputAbs
				? await safeFingerprint(inputAbs)
				: undefined;
		// 附加输入只在确有上传时记键：未声明 / 未给值的工具 task.json 逐字节不变
		const extraCrumb: Record<string, { source: string; fingerprint: string | undefined }> = {};
		for (const x of extraInputs) {
			extraCrumb[x.spec.payloadKey] = { source: x.abs, fingerprint: await safeFingerprint(x.abs) };
		}
		await writeFile(
			join(outDir, "task.json"),
			JSON.stringify(
				{
					tool: descriptor.name,
					taskType,
					taskId,
					fileId,
					...(fileIds ? { fileIds } : {}),
					source: inputList ?? inputAbs,
					fingerprint,
					...(extraInputs.length ? { extraInputs: extraCrumb } : {}),
					createdAt: new Date().toISOString(),
				},
				null,
				2,
			),
		);
	};
	const pollOpts = {
		timeoutMs: descriptor.pollTimeoutMs,
		intervalMs: deps.pollIntervalMs,
		getResult: deps.getTaskResult,
		sleep: deps.sleep,
		now: deps.now,
	};
	let output: OralCutOutput;
	if (isNoneDirect) {
		const p = descriptor.buildPayloadNone!(ctx);
		mergeParams(p, extraParams);
		taskId = await deps.submitTask(deps.cfg, taskType, p);
		await writeBreadcrumb();
		output = await pollToolTask(deps.cfg, taskType, taskId, pollOpts);
	} else if (isMulti) {
		// 附加输入追加在主输入之后一起上传（顺序即上传顺序）；无附加输入时 paths / fileIds 与从前逐项相同
		const n = inputList!.length;
		const buildMulti = (fids: string[]): unknown => {
			const p = descriptor.buildPayloadMulti!(fids.slice(0, n), ctx);
			applyExtraFileIds(p, extraInputs, fids.slice(n));
			// 通用透传优先级最高：agent 永远能强制覆盖 descriptor 拼装的任意字段
			mergeParams(p, extraParams);
			return p;
		};
		const paths = [...inputList!, ...extraInputs.map((x) => x.abs)];
		const submitted = await uploadManyAndSubmit(deps, paths, taskType, buildMulti, !!opts.reupload);
		taskId = submitted.taskId;
		fileIds = submitted.fileIds.slice(0, n);
		fileId = submitted.fileIds[0]!;
		await writeBreadcrumb();
		output = await pollToolTask(deps.cfg, taskType, taskId, pollOpts);
	} else if (extraInputs.length) {
		// 单输入 + 附加输入（link-video-translate-dub-cli D3）：主输入先传、附加输入后传，走与多文件同一套
		// 「逐个缓存上传 → 一次提交 → 6004 时全部缓存条目失效强制重传」编排——附加输入的缓存 file_id 过期
		// 同样能自愈（只收编主输入的 uploadAndSubmitTask 做不到这一点）。无附加输入的工具不进这支，行为逐字节不变。
		const buildWithExtras = (fids: string[]): Record<string, unknown> => {
			const p = descriptor.buildPayload ? descriptor.buildPayload(fids[0]!, ctx) : { file_id: fids[0] };
			applyExtraFileIds(p, extraInputs, fids.slice(1));
			mergeParams(p, extraParams);
			return p;
		};
		const paths = [uploadPath!, ...extraInputs.map((x) => x.abs)];
		const submitted = await uploadManyAndSubmit(deps, paths, taskType, buildWithExtras, opts.reupload === true);
		taskId = submitted.taskId;
		fileId = submitted.fileIds[0]!;
		await writeBreadcrumb();
		output = await pollToolTask(deps.cfg, taskType, taskId, pollOpts);
	} else {
		// 单文件分支委托共享执行核（add-matrix-local-image-broll 3.1 抽取；行为逐步等价：
		// 上传/6004 恢复 → onSubmitted 落面包屑 → 轮询，poll 选项与旧实现逐字段一致）
		const buildPayload = (fid: string): Record<string, unknown> => {
			const p = descriptor.buildPayload ? descriptor.buildPayload(fid, ctx) : { file_id: fid };
			// 通用透传优先级最高：agent 永远能强制覆盖 descriptor 拼装的任意字段
			mergeParams(p, extraParams);
			return p;
		};
		const run = await runCloudFileTask({
			deps,
			uploadPath: uploadPath!, // 非 isNoneDirect 分支：上方守卫已保证有上传物
			taskType,
			buildPayload,
			forceReupload: opts.reupload === true,
			pollTimeoutMs: descriptor.pollTimeoutMs,
			onSubmitted: async (s) => {
				taskId = s.taskId;
				fileId = s.fileId;
				await writeBreadcrumb();
			},
		});
		taskId = run.taskId;
		fileId = run.fileId;
		output = run.output;
	}

	// ⑦ 产物落地（两条独立路径，均由 descriptor 声明驱动）+ result.json 恒落盘（不受 --json 约束）
	const outputResult = output as unknown as OutputResult;
	const files: string[] = [];
	const errors: Record<string, string> = {};

	// (a) 文件下载路径：mapOutputs 收敛下载清单，流式落地。
	const items: DownloadItem[] = descriptor.mapOutputs ? descriptor.mapOutputs(outputResult, ctx) : [];
	const isNoneInput = descriptor.input.kind === "none";
	for (const it of items) {
		let dest = join(outDir, it.filename);
		try {
			// 文件名带子目录（如 `jianying/draft_content.json`）时先建父目录（link-video-translate-dub-cli D4）；
			// 平铺文件名不进这支，既有工具行为逐字节不变。
			if (/[\\/]/.test(it.filename)) await mkdir(dirname(dest), { recursive: true });
			if (isNoneInput) {
				// input=none 的产物名不携带任何输入身份（`tts-<speaker>` 只有音色、与被合成的文本无关）
				// ⇒ 同一目录内的两次调用极可能是两份不同产物，静默截断就是数据丢失（解说装配兜底路
				// 「多段 TTS 同 --speaker 落同一 --out」会逐段互相盖，全链无一处报错）。
				// O_EXCL 原子占位，真撞上才改名一次；没撞则文件名逐字节不变。
				try {
					await deps.downloadStream(it.url, dest, { exclusive: true });
				} catch (e) {
					if (fsErrCode(e) !== "EEXIST") throw e;
					dest = join(outDir, collisionName(it.filename, taskId));
					emitWarn(`产物「${it.filename}」已存在，本次改落「${basename(dest)}」（既有文件原样保留）`);
					await deps.downloadStream(it.url, dest, { exclusive: true }); // 再撞即记 errors，不无限重试
				}
			} else {
				// 有输入文件的工具：目录名已携带输入身份 ⇒ 同目录内重跑必是同一输入，覆盖才是对的（幂等重跑）。
				// 这里的 existsSync 只用来「说话」，不参与任何仲裁——竞态最多让 WARN 少打一条，
				// 落哪份字节与它无关（TOCTOU 禁令针对的是防撞仲裁，不是提示）。
				if (existsSync(dest)) emitWarn(`产物已存在，将被本次重跑覆盖：${dest}`);
				await deps.downloadStream(it.url, dest);
			}
			files.push(dest); // 记改名后的真实落点
		} catch (e) {
			errors[it.filename] = e instanceof Error ? e.message : String(e);
		}
	}

	// (a2) 本地加工路径：postprocess 在下载落地后跑（如本地烧录字幕）。失败只记 errors，
	// 云端已落地产物一律保留——付过费的东西不能因本地一步失手而丢。
	if (descriptor.postprocess) {
		try {
			const extra = await descriptor.postprocess(ctx, [...files], outputResult);
			if (Array.isArray(extra)) files.push(...extra);
		} catch (e) {
			errors[`${descriptor.name}:postprocess`] = e instanceof Error ? e.message : String(e);
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
		fileId,
		...(fileIds ? { fileIds } : {}),
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
