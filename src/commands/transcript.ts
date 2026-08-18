/**
 * gtrk transcript <本地视频|配音音频> —— 本地抽/转 16k 音频 → 云端 ASR → 单个妙记式 Markdown。
 *
 * 合规边界：只接受本地文件；原视频/音频永不上传原件，也没有 URL 下载入口。
 *
 * 音频输入（add-audio-project-atoms，自备配音时码化兜底）：扩展名白名单放开音频
 * （defaultExtsFor("audio")：wav/mp3/flac/m4a/aac/ogg 等）；音频输入无「抽音频」语义——已是音频，
 * 仍经同一 ffmpeg 链转 16k 单声道后上传，原文件不动。定位注记：TTS 主路 MUST NOT 走本零件
 * （audio_tts_clone 产物自带句级 segments，`gtrk project init --tts-task` 直取零成本），
 * 本零件只服务自备配音等无时码音频场景。
 *
 * `--json` 附加产物：机读模式下额外产 `<名>-transcript.json`（utterances[]{id,text,st,ed} +
 * material_id + text_hash + duration，与 `gtrk split` loadTranscript 结构门逐字段对齐），
 * 可直接被 `gtrk project init --transcript` 兜底路消费。缺省（无 --json）行为零变化（仍只产 .md）。
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
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
	/** 仅 --json 时出现：transcript.json 产物路径（project init 兜底路 / split 消费）。 */
	transcriptJson?: string;
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

/** 输入是否为音频文件（白名单判定；决定探测/日志口径与 Markdown 头部标签）。 */
export function isAudioTranscriptInput(inputAbs: string): boolean {
	return (defaultExtsFor("audio") ?? []).includes(extname(inputAbs).toLowerCase());
}

/** 协议式输入在任何联网动作前硬拒；随后校验本地文件与视频/音频扩展名白名单。 */
export async function validateTranscriptInput(input: string): Promise<string> {
	if (!input.trim()) throw new Error("缺少本地文件路径。用法：gtrk transcript <本地视频|配音音频>");
	if (looksLikeRemote(input)) {
		throw new Error("转文字稿仅支持本地视频/音频文件，不支持 URL、平台地址或远端下载");
	}
	const inputAbs = resolve(input);
	if (!existsSync(inputAbs)) throw new Error(`本地文件不存在：${inputAbs}`);
	const info = await stat(inputAbs);
	if (!info.isFile()) throw new Error(`输入不是文件：${inputAbs}`);
	const extension = extname(inputAbs).toLowerCase();
	const allowed = [...(defaultExtsFor("video") ?? []), ...(defaultExtsFor("audio") ?? [])];
	if (!allowed.includes(extension)) {
		throw new Error(`不支持的媒体格式「${extension || "无扩展名"}」；请输入本地视频或音频文件（音频支持 wav/mp3/flac/m4a/aac/ogg 等）`);
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
	const isAudio = isAudioTranscriptInput(inputAbs);
	const kindLabel = isAudio ? "音频" : "视频";

	log.step(`▶ ${kindLabel}转文字稿：${sourceName}`);
	log.step(`① 本地探测${kindLabel}…`);
	// probeGeometry 对音频同样可用：format=duration 与流选择无关（音频无视频流时 width/height/fps 为 0）
	const geometry = deps.probe(inputAbs, opts.ffmpegPath);
	if (!(geometry.duration > 0)) throw new Error(`未探测到有效${kindLabel}时长，无法转写`);
	log.info(`${kindLabel}时长 ${geometry.duration.toFixed(1)}s`);

	const pricing = await deps.resolvePricing(PRICE_KEY);
	log.info(`实时计费：${pricing.billingHint}`);

	// 音频输入跳过「抽音频」语义：已是音频，仍经同一 ffmpeg 链转 16k 单声道再上传（原文件不动）
	log.step(isAudio ? "② 本地转码 16k 单声道音频（原音频文件不动，只传转码衍生物）…" : "② 本地抽取 16k 单声道音频（原视频不上传）…");
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
		...(isAudio ? { sourceKind: "audio" as const } : {}),
	});
	await deps.writeMarkdown(output, markdown);

	// --json 附加产物：transcript.json（结构门与 split loadTranscript 逐字段对齐：
	// utterances[]{id,text,st,ed} + material_id + text_hash + duration；text_hash 口径 =
	// sha256(utterances[].text join "\n")，与 infra transcript_emit / split 复算逐字节一致）
	let transcriptJson: string | undefined;
	if (opts.json) {
		const r3 = (n: number) => Math.round(n * 1000) / 1000;
		const utterances = asr.sentences.map((s, i) => ({
			id: `u${i + 1}`,
			text: s.text,
			st: r3(s.start),
			ed: r3(Math.max(s.start, s.end)),
		}));
		const doc = {
			version: "v1",
			source: sourceName,
			material_id: uploaded.fileId,
			text_hash: createHash("sha256").update(utterances.map((u) => u.text).join("\n"), "utf8").digest("hex"),
			duration: r3(geometry.duration),
			utterances,
		};
		transcriptJson = output.replace(/\.md$/i, ".json");
		await deps.writeMarkdown(transcriptJson, JSON.stringify(doc, null, 2));
		log.info(`transcript.json 已生成：${transcriptJson}（可直接被 gtrk project init --transcript 兜底路消费）`);
	}
	return {
		ok: true,
		taskId,
		fileId: uploaded.fileId,
		output,
		...(transcriptJson ? { transcriptJson } : {}),
		summaryPending: true,
	};
}

/** 给命令挂参数与 action；deps 注入仅供离线测试。 */
export function configureTranscriptCommand(cmd: Command, deps?: Partial<TranscriptDeps>): Command {
	return cmd
		.description(
			"本地视频/配音音频转文字稿：原文件不上传，只上传 16k 音频衍生物，生成单个待 Agent 补总结的 Markdown（--json 时另产 transcript.json 供 project init 兜底路）",
		)
		.option("-o, --out <file>", "输出 Markdown 文件（缺省 <源文件同目录>/<源文件名>-transcript.md）")
		.option("--lang <code>", "识别语言代码（默认 zh-CN）", "zh-CN")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录")
		.option("--reupload", "强制重新上传抽取音频，忽略上传缓存")
		.option("--json", "机读模式：stdout 只输出最终结果 JSON；并额外产出 <名>-transcript.json（句级时码，供 project init/split 消费）")
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
