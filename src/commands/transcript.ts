/**
 * gtrk transcript <本地视频> —— 本地抽音频 → 云端 ASR → 单个妙记式 Markdown。
 *
 * 合规边界：只接受本地视频文件；原视频永不上传，也没有 URL 下载入口。
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { CloudConfig } from "../lib/config";
import { loadConfig } from "../lib/config";
import { submitTask } from "../lib/cloud";
import { log, routeLogsToStderr } from "../lib/log";
import { assertDurationConsistent, extractAudio, probeGeometry } from "../lib/media";
import { defaultExtsFor } from "../lib/tool-descriptors";
import { pollToolTask } from "../lib/tool-runner";
import { resolveToolPricing, type ResolvedToolPricing } from "../lib/tool-pricing";
import { invalidateUpload, uploadCached } from "../lib/upload-cache";
import { uploadAndSubmitTask } from "../lib/upload-submit";
import { normalizeAsrOutput, renderTranscriptMarkdown } from "../lib/transcript";

const TASK_TYPE = "asr";
const PRICE_KEY = "asr";

export interface TranscriptOpts {
	out?: string;
	lang?: string;
	ffmpegPath?: string;
	reupload?: boolean;
	json?: boolean;
}

export interface TranscriptResult {
	ok: true;
	taskId: string;
	fileId: string;
	output: string;
	summaryPending: true;
}

interface UploadResult {
	fileId: string;
	cached: boolean;
}

export interface TranscriptDeps {
	cfg: CloudConfig;
	probe: typeof probeGeometry;
	extract: typeof extractAudio;
	assertDuration: typeof assertDurationConsistent;
	resolvePricing: (priceKey: string) => Promise<ResolvedToolPricing>;
	upload: (cfg: CloudConfig, path: string, opts?: { force?: boolean }) => Promise<UploadResult>;
	invalidate: (path: string) => Promise<void>;
	submit: (cfg: CloudConfig, taskType: string, payload: unknown) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	poll: (
		cfg: CloudConfig,
		taskType: string,
		taskId: string,
		onTick?: (status: string, progress?: number) => void,
	) => Promise<Record<string, unknown>>;
	writeMarkdown: (path: string, markdown: string) => Promise<void>;
	now: () => Date;
}

function buildDeps(overrides: Partial<TranscriptDeps> = {}): TranscriptDeps {
	return {
		cfg: overrides.cfg ?? loadConfig(),
		probe: overrides.probe ?? probeGeometry,
		extract: overrides.extract ?? extractAudio,
		assertDuration: overrides.assertDuration ?? assertDurationConsistent,
		resolvePricing: overrides.resolvePricing ?? ((key) => resolveToolPricing(key)),
		upload: overrides.upload ?? uploadCached,
		invalidate: overrides.invalidate ?? invalidateUpload,
		submit: overrides.submit ?? submitTask,
		sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
		poll: overrides.poll ?? (async (cfg, taskType, taskId, onTick) =>
			(await pollToolTask(cfg, taskType, taskId, { onTick })) as unknown as Record<string, unknown>),
		writeMarkdown: overrides.writeMarkdown ?? writeMarkdownAtomic,
		now: overrides.now ?? (() => new Date()),
	};
}

function looksLikeRemote(value: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
}

/** 协议式输入在任何联网动作前硬拒；随后校验本地文件与视频扩展名。 */
export async function validateTranscriptInput(input: string): Promise<string> {
	if (!input.trim()) throw new Error("缺少本地视频路径。用法：gtrk transcript <本地视频>");
	if (looksLikeRemote(input)) {
		throw new Error("视频转文字稿仅支持本地视频文件，不支持 URL、平台视频地址或远端下载");
	}
	const inputAbs = resolve(input);
	if (!existsSync(inputAbs)) throw new Error(`本地视频不存在：${inputAbs}`);
	const info = await stat(inputAbs);
	if (!info.isFile()) throw new Error(`输入不是文件：${inputAbs}`);
	const extension = extname(inputAbs).toLowerCase();
	if (!(defaultExtsFor("video") ?? []).includes(extension)) {
		throw new Error(`不支持的视频格式「${extension || "无扩展名"}」；请输入本地视频文件`);
	}
	return inputAbs;
}

/** --out 是单个 .md 文件；缺省与源视频同目录。 */
export function resolveTranscriptOutput(inputAbs: string, out?: string): string {
	const base = basename(inputAbs, extname(inputAbs));
	const output = out ? resolve(out) : join(dirname(inputAbs), `${base}-transcript.md`);
	if (extname(output).toLowerCase() !== ".md") throw new Error("--out 必须指向一个 .md 文件");
	return output;
}

/** 临时文件写完后原子替换；失败时不留下半截 Markdown。 */
export async function writeMarkdownAtomic(path: string, markdown: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	try {
		await writeFile(temp, markdown, "utf8");
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true });
	}
}

/** 完整无头工作流；deps 可注入以离线测试，用户侧只写最终 Markdown。 */
export async function runTranscript(
	input: string,
	opts: TranscriptOpts = {},
	depsOverride?: Partial<TranscriptDeps>,
): Promise<TranscriptResult> {
	if (opts.json) routeLogsToStderr();
	// 先做纯本地输入门，再加载配置或查价，保证 URL 零网络拒绝。
	const inputAbs = await validateTranscriptInput(input);
	const output = resolveTranscriptOutput(inputAbs, opts.out);
	const deps = buildDeps(depsOverride);
	const language = opts.lang?.trim() || "zh-CN";
	const sourceName = basename(inputAbs);
	const title = basename(inputAbs, extname(inputAbs));

	log.step(`▶ 视频转文字稿：${sourceName}`);
	log.step("① 本地探测视频…");
	const geometry = deps.probe(inputAbs, opts.ffmpegPath);
	if (!(geometry.duration > 0)) throw new Error("未探测到有效视频时长，无法转写");
	log.info(`视频时长 ${geometry.duration.toFixed(1)}s`);

	const pricing = await deps.resolvePricing(PRICE_KEY);
	log.info(`实时计费：${pricing.billingHint}`);

	log.step("② 本地抽取 16k 单声道音频（原视频不上传）…");
	const audio = await deps.extract(inputAbs, opts.ffmpegPath);
	deps.assertDuration(geometry.duration, audio, opts.ffmpegPath);
	log.info(`上传物：${basename(audio)}（仅音频衍生物）`);

	log.step("③ 上传音频并提交 ASR…");
	const payload = (fileId: string) => ({ file_id: fileId, language, word_level: true });
	const submitted = await uploadAndSubmitTask(
		deps.cfg,
		audio,
		TASK_TYPE,
		payload,
		{
			force: opts.reupload,
			onCacheInvalid: () => log.warn("缓存的 file_id 已失效，重新上传后重试…"),
		},
		{
			uploadCached: deps.upload,
			invalidateUpload: deps.invalidate,
			submitTask: deps.submit,
			sleep: deps.sleep,
		},
	);
	const { taskId } = submitted;
	const uploaded = { fileId: submitted.fileId, cached: submitted.cached };
	log.info(`task_id = ${taskId}`);

	log.step("④ 云端识别中…");
	const raw = await deps.poll(deps.cfg, TASK_TYPE, taskId, (status, progress) => {
		log.tick(`${status}${progress != null ? ` ${Math.round(progress)}%` : ""}`);
	});
	log.tickEnd();
	const asr = normalizeAsrOutput(raw);
	const markdown = renderTranscriptMarkdown({
		title,
		sourceName,
		durationSec: geometry.duration,
		language,
		generatedAt: deps.now(),
		asr,
	});
	await deps.writeMarkdown(output, markdown);
	return { ok: true, taskId, fileId: uploaded.fileId, output, summaryPending: true };
}

/** 给命令挂参数与 action；deps 注入仅供离线测试。 */
export function configureTranscriptCommand(cmd: Command, deps?: Partial<TranscriptDeps>): Command {
	return cmd
		.description("本地视频转文字稿：原视频不上传，只上传抽取音频，生成单个待 Agent 补总结的 Markdown")
		.option("-o, --out <file>", "输出 Markdown 文件（缺省 <视频同目录>/<视频名>-transcript.md）")
		.option("--lang <code>", "识别语言代码（默认 zh-CN）", "zh-CN")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录")
		.option("--reupload", "强制重新上传抽取音频，忽略上传缓存")
		.option("--json", "机读模式：stdout 只输出最终结果 JSON")
		.action(async (video: string, opts: TranscriptOpts) => {
			const result = await runTranscript(video, opts, deps);
			if (opts.json) console.log(JSON.stringify(result));
			else {
				log.ok(`带时码文字稿已生成：${result.output}`);
				log.warn("总结仍待驱动 CLI 的 Agent 阅读全文后写回同一个 Markdown");
			}
		});
}

export function registerTranscript(program: Command): void {
	configureTranscriptCommand(program.command("transcript <video>"));
}
