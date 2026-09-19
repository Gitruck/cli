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
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { CloudConfig } from "../lib/config";
import { loadConfig } from "../lib/config";
import { resolveAsrOutput, submitTask } from "../lib/cloud";
import { log, routeLogsToStderr } from "../lib/log";
import { assertDurationConsistent, extractAudio, probeGeometry } from "../lib/media";
import { defaultExtsFor } from "../lib/tool-descriptors";
import { pollToolTask } from "../lib/tool-runner";
import { resolveToolPricing, type ResolvedToolPricing } from "../lib/tool-pricing";
import { invalidateUpload, uploadCached } from "../lib/upload-cache";
import { uploadAndSubmitTask } from "../lib/upload-submit";
import { normalizeAsrOutput, renderTranscriptMarkdown } from "../lib/transcript";
import { r3 } from "../lib/frame-domain";

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

/** 占用类失败：目标文件正被别的进程持着。Windows 上编辑器 / 网盘同步 / 杀软 / 索引器都会造成它。 */
const RENAME_BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/**
 * 退避梯度（ms）：共 5 次尝试、约 750 ms 窗口。
 * **不做无上限重试**——编辑器开着那个文件可以开一整天，无上限只会把「报错」换成「卡死」。
 */
const RENAME_BACKOFF_MS = [50, 100, 200, 400];
/** 残骸清理的年龄闸：正常写入以毫秒计，一小时留得足够宽，不会踩到并发进程正在写的那份。 */
const STALE_TEMP_MS = 60 * 60 * 1000;

/** 单测注入旋钮（形制同 `crash-report.ts` 的 `__crashReportIo`）。**生产恒 `null`**。 */
export const __atomicWriteIo: {
	impl: null | {
		writeFile?: typeof writeFile;
		rename?: typeof rename;
		sleep?: (ms: number) => Promise<void>;
	};
} = { impl: null };

function atomicIo() {
	const i = __atomicWriteIo.impl ?? {};
	return {
		writeFile: i.writeFile ?? writeFile,
		rename: i.rename ?? rename,
		sleep: i.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
	};
}

/** 写成功后顺手清同目标的历史 temp 残骸。只清够老的——免得踩到并发进程正在写的那一份。 */
async function sweepStaleTemps(path: string): Promise<void> {
	try {
		const dir = dirname(path);
		const prefix = `${basename(path)}.`;
		const now = Date.now();
		for (const name of await readdir(dir)) {
			if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
			const p = join(dir, name);
			const st = await stat(p).catch(() => null);
			if (st && now - st.mtimeMs > STALE_TEMP_MS) await rm(p, { force: true });
		}
	} catch {
		/* 清残骸失败不值得打断一次已经成功的写入 */
	}
}

/** rename 阶段失败的人话文案。按错误码分路——「被占用」这句对 EXDEV / ENOSPC 是错的，不能一句话糊过去。 */
function describeRenameFailure(path: string, temp: string, cause: unknown): string {
	const rawCode = (cause as { code?: unknown } | null)?.code;
	const code = typeof rawCode === "string" ? rawCode : "";
	const raw = cause instanceof Error ? cause.message : String(cause);
	const head = `写不进 ${path} —— 内容是完整的，已经留在：${temp}`;
	let why: string;
	if (RENAME_BUSY_CODES.has(code)) {
		why =
			"目标文件多半正被别的程序占着（编辑器开着它、网盘在同步、杀软或索引器在扫）。\n" +
			"关掉占用它的程序后重跑，或用 --out 换个落点；也可以直接把上面那份 .tmp 改名收走。";
	} else if (code === "EXDEV") {
		why = "临时文件与目标不在同一个卷上，改不了名。用 --out 把落点换到与源同一个盘。";
	} else if (code === "ENOSPC") {
		why = "磁盘没空间了。腾出空间后把上面那份 .tmp 改名收走即可，不用重跑。";
	} else {
		why = "用 --out 换个落点重试；上面那份 .tmp 是完整内容，可以直接改名收走。";
	}
	return `${head}\n${why}\n原始系统报错：${raw}`;
}

/**
 * 临时文件写完后原子替换。
 *
 * 两个阶段的失败后果不同，处置也必须不同（change `fix-local-io-environment-failures` · design D4/D5）：
 *
 * | 阶段 | 内容完整？ | 处置 |
 * |---|---|---|
 * | 写 temp | 否 | 删 temp、原样抛 —— 不留半截 Markdown（本函数原有语义，一字不动） |
 * | 替换目标 | **是** | 占用类码退避重试；仍失败则**保留 temp** + 人话 `Error` |
 *
 * ⚠️ **替换阶段失败 MUST NOT 删 temp。** 生产报错 `base_error#176`：用户的转写在云端跑完、
 * 计过费、内容完整写进了 temp，然后被这里原来那个无差别的 `finally { rm(temp) }` 删掉——
 * 十分钟里连丢三次。原注释「失败时不留下半截 Markdown」的射程只到写 temp 阶段，
 * 替换阶段的 temp 不是半截，是**全部**。
 */
export async function writeMarkdownAtomic(path: string, markdown: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	const io = atomicIo();

	// ① 写 temp：失败 ⇒ 内容本来就不全，删掉、原样抛
	try {
		await io.writeFile(temp, markdown, "utf8");
	} catch (e) {
		await rm(temp, { force: true });
		throw e;
	}

	// ② 替换目标：内容已完整，占用类失败值得等一等（非占用类码一次都不重试，等也没用）
	let last: unknown;
	for (let attempt = 0; attempt <= RENAME_BACKOFF_MS.length; attempt++) {
		try {
			await io.rename(temp, path);
			await sweepStaleTemps(path);
			return;
		} catch (e) {
			last = e;
			const code = (e as { code?: unknown }).code;
			if (typeof code !== "string" || !RENAME_BUSY_CODES.has(code)) break;
			if (attempt === RENAME_BACKOFF_MS.length) break;
			await io.sleep(RENAME_BACKOFF_MS[attempt]);
		}
	}
	throw new Error(describeRenameFailure(path, temp, last));
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
	// `word_level` 决定的是**引擎**，不是一个参数（change: switch-transcript-to-selfhosted-asr）。
	// 服务端按它选腿：要字级 ⇒ 外部厂商 ASR；不要 ⇒ 自部署引擎 + 服务端纠错。
	//
	// 这里恒传 `false`，判据是**产物**而不是成本：本命令的两个产物都只承载句级 ——
	// Markdown 只渲染句子，`--json` 的 `utterances[]` 只有 `id/text/st/ed`（见 `:323` 起），
	// 结构上没有任何字段放得下字级时码。索取一份产物容不下的东西，是为不可见的差异付费。
	//
	// 🔴 口径 MUST 对所有语种一致，**MUST NOT** 在这里按语种挑不同的值：
	//    那要在 CLI 手抄一份「哪些码厂商引擎更好」的表，而正本在服务端引擎表里，
	//    手抄的那份不会报错，只会在某天与引擎表悄悄分叉。粤语（`zh-HK`）确有质量代价，
	//    它由**服务端**的语种白名单承接（infra `route-cantonese-asr-to-vendor-leg`），
	//    CLI 一行都不必知道引擎的事。守卫见 `test/transcript-engine-routing.test.mjs`。
	const payload = (fileId: string) => ({ file_id: fileId, language, word_level: false });
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
	// slim 形态（infra fix-task-output-result-offload）→ 先按引用拉回全量转写再归一；旧内联直通
	const asr = normalizeAsrOutput(await resolveAsrOutput(raw));
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
		.option("--lang <code>", "识别语言代码（zh-CN 普通话 / zh-HK 粤语 / en-US / ja-JP…，默认 zh-CN）", "zh-CN")
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
