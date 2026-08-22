/**
 * gtrk project —— 音频驱动工程族（add-audio-project-atoms）。
 *
 * `gtrk project init`：从配音起盘建 `.gtrk` 工程。★ 甲方案（主理人拍板）：工程 JSON 由服务端
 * producer（infra add-audio-project-producer 的 `POST /task/cli/audio_project_struct` **同步口**）生成
 * ——emit 链纯函数（gtrk_emit/transcript_emit）是全宇宙唯一权威源，CLI MUST NOT 本地复刻工程生成逻辑。
 *
 * 两条入路（互斥）：
 *   - 主路 `--tts-task <task_id>`：引用已完成的 audio_tts_clone 任务（产物自带句级 segments，零 ASR）；
 *     服务端取产物拼装，CLI 落地时把 TTS 产物音频下载进产物目录并改写 materials[].path 指向它。
 *   - 兜底 `--audio <本地配音> --transcript <transcript.json>`：自备配音场景（transcript 经
 *     `gtrk transcript <音频> --json` 产出）；CLI 先走既有上传基建（uploadCached，6004 共享恢复口径）
 *     归一到 {file_id, utterances, duration} 形态；落地时 materials[].path 改写为本地音频绝对路径。
 *
 * 服务端产的 transcript 已按画布档位拆成可直接落轨的字幕行，行文本**缺省去掉中英逗号句号**
 * （2026-08-22 全线统一口径）；`--keep-punctuation` 逐字保留标点（要带标点的文稿版本用它），
 * 语义与 `gtrk subtitle lay` / `gtrk long2short` 的同名 flag 一致，且只影响文稿文本、不动工程结构。
 *
 * 产物目录对齐 oralcut 惯例：`<名>-video-project-<YYMMDD-HHMMSS>/` 含 gtrk/project.gtrk +
 * transcript/transcript.json + result.json；完成话术含客户端 openHint 并默认自动打开。
 * 计费：本接口 0 积分不计费（infra 契约）。
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { CloudConfig } from "../lib/config";
import { loadConfig } from "../lib/config";
import { CloudError, cloudErrorCode, download as realDownload, getTaskResult, parseJson } from "../lib/cloud";
import { invalidateUpload, uploadCached } from "../lib/upload-cache";
import { DEFAULT_VISIBILITY_BACKOFF_MS } from "../lib/upload-submit";
import { defaultExtsFor, extFromUrl, pickUrl } from "../lib/tool-descriptors";
import { FORMAT_META } from "../lib/materialize";
import { openFolder } from "../lib/open";
import { log, routeLogsToStderr } from "../lib/log";

// cli 域同步轻接口（SYNC_INLINE 家族）：cloud.ts 的 /task/${taskType} 模板天然拼出该路径
const TASK_TYPE = "cli/audio_project_struct";
/** TTS 任务类型（主路取产物 download_url 用，口径对齐 tool-descriptors 的 audio_tts_clone）。 */
const TTS_TASK_TYPE = "audio_tts_clone";
/** 画布默认值（竖版 1080x1920，服务端契约同默认）。 */
export const DEFAULT_CANVAS: [number, number] = [1080, 1920];

/** 本地时间戳 YYMMDD-HHMMSS（与 oralcut 同式），产物目录命名用。 */
function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** positional 解析：仅支持 `init`（后续族命令在此扩展）。 */
export function parseProjectPositional(words: string[] | undefined): "init" {
	if (!words || words.length === 0) {
		throw new Error("缺少子命令——用法：gtrk project init --tts-task <task_id> | --audio <配音> --transcript <json>");
	}
	if (words[0] !== "init" || words.length > 1) {
		throw new Error(`未知子命令「${words.join(" ")}」——当前仅支持：gtrk project init`);
	}
	return "init";
}

/** `--canvas WxH` 解析：缺省 1080x1920；非法即参数错误（不做静默忽略）。 */
export function parseCanvas(raw: string | undefined): [number, number] {
	if (raw === undefined) return [...DEFAULT_CANVAS];
	const m = /^(\d{2,5})[xX](\d{2,5})$/.exec(raw.trim());
	if (!m) throw new Error(`--canvas 取值非法（${raw}）——格式 WxH（如 1080x1920）`);
	const w = Number(m[1]);
	const h = Number(m[2]);
	if (!(w > 0 && h > 0)) throw new Error(`--canvas 取值非法（${raw}）——宽高必须为正整数`);
	return [w, h];
}

/** 提交给服务端的句级 utterance（transcript.json 归一形态）。 */
export interface SubmitUtterance {
	id: string;
	text: string;
	st: number;
	ed: number;
}

/**
 * 兜底路 transcript.json 归一：结构门与 `gtrk split` 的 loadTranscript 同族（utterances 数组 +
 * 逐条 text/st/ed），读出 {utterances, duration} 供提交体。id 缺省按序补 `u<N>`；
 * duration 缺省取末句 ed 包络（服务端契约要求显式传 duration）。
 */
export function normalizeTranscriptForSubmit(
	raw: unknown,
	path: string,
): { utterances: SubmitUtterance[]; duration: number } {
	const t = raw as { utterances?: unknown; duration?: unknown } | null;
	if (!t || typeof t !== "object" || !Array.isArray(t.utterances) || t.utterances.length === 0) {
		throw new Error(`transcript.json 结构异常（缺 utterances 数组或为空）：${path}——请用 gtrk transcript <配音音频> --json 产出`);
	}
	const utterances: SubmitUtterance[] = t.utterances.map((u, i) => {
		const item = (u ?? {}) as Record<string, unknown>;
		const text = typeof item.text === "string" ? item.text : "";
		const st = Number(item.st);
		const ed = Number(item.ed);
		if (!text || !Number.isFinite(st) || !Number.isFinite(ed) || ed < st || st < 0) {
			throw new Error(`transcript.json 第 ${i + 1} 条 utterance 非法（需 text 非空、0 ≤ st ≤ ed）：${path}`);
		}
		return { id: typeof item.id === "string" && item.id ? item.id : `u${i + 1}`, text, st: r3(st), ed: r3(ed) };
	});
	const declared = Number(t.duration);
	const envelope = utterances.reduce((mx, u) => Math.max(mx, u.ed), 0);
	const duration = Number.isFinite(declared) && declared > 0 ? r3(declared) : r3(envelope);
	if (!(duration > 0)) throw new Error(`transcript.json 推不出有效时长（duration 缺失且句级时码全 0）：${path}`);
	return { utterances, duration };
}

/**
 * materialize 路径改写（oralcut source_path 同款口径）：服务端返回的 gtrk 里配音素材 path 是服务端视角，
 * 落地时改写为本地音频绝对路径——优先按 transcript.material_id 精确命中；命不中（契约漂移兜底）按
 * 单源工程语义改写全部素材。返回改写条数（0 = 工程无 materials，属契约异常但不在此硬拒）。
 */
export function rewriteVoiceMaterialPaths(
	gtrk: Record<string, unknown>,
	transcript: Record<string, unknown>,
	localAudioAbs: string,
): number {
	const materials = Array.isArray(gtrk.materials) ? (gtrk.materials as Record<string, unknown>[]) : [];
	const targetId = typeof transcript.material_id === "string" ? transcript.material_id : undefined;
	let targets = targetId ? materials.filter((m) => m.id === targetId) : [];
	if (targets.length === 0) targets = materials; // 单源工程兜底：全部素材即配音
	for (const m of targets) m.path = localAudioAbs;
	return targets.length;
}

/** 同步口响应体（infra 契约：{code:200, data:{gtrk, transcript, task_id}}，包络与既有接口一致）。 */
export interface AudioProjectStructResp {
	gtrk: Record<string, unknown>;
	transcript: Record<string, unknown>;
	taskId: string | null;
}

/** 调服务端 producer 同步口（裸 apikey Authorization；错误走 CloudError 带业务码，如 6004 归属）。 */
export async function callAudioProjectStruct(
	cfg: CloudConfig,
	payload: Record<string, unknown>,
	fetchFn: typeof fetch = fetch,
): Promise<AudioProjectStructResp> {
	const res = await fetchFn(`${cfg.base}/task/${TASK_TYPE}`, {
		method: "POST",
		headers: { Authorization: cfg.apiKey, "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const r = await parseJson<{ gtrk?: unknown; transcript?: unknown; task_id?: unknown }>(res);
	const data = (r.data ?? {}) as { gtrk?: unknown; transcript?: unknown; task_id?: unknown };
	const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
	if (r.code === 200 && isObj(data.gtrk) && isObj(data.transcript)) {
		return {
			gtrk: data.gtrk,
			transcript: data.transcript,
			taskId: data.task_id != null ? String(data.task_id) : null,
		};
	}
	if (r.code === 200) throw new Error("工程生成响应缺 gtrk/transcript（非 audio_project_struct 契约响应）");
	throw new CloudError(r.code, `工程生成失败 (code=${r.code ?? "?"})：${r.msg ?? "未知错误"}`);
}

export interface ProjectInitOpts {
	ttsTask?: string;
	audio?: string;
	transcript?: string;
	canvas?: string;
	out?: string;
	reupload?: boolean;
	/** 字幕行保留全部标点（缺省服务端 B 案：逗号句号→空格、其余保留）→ strip_punctuation=false。 */
	keepPunctuation?: boolean;
	open?: boolean;
	json?: boolean;
}

/** 测试注入面（MUST NOT 真调云端）；缺省 = 真实现。 */
export interface ProjectInitDeps {
	cfg?: CloudConfig;
	fetchFn?: typeof fetch;
	upload?: typeof uploadCached;
	invalidate?: typeof invalidateUpload;
	/** 主路取 TTS 任务产物（download_url）。 */
	getTtsResult?: typeof getTaskResult;
	download?: (url: string, dest: string) => Promise<void>;
	openFolder?: (dir: string) => void;
	sleep?: (ms: number) => Promise<void>;
}

export interface ProjectInitResult {
	ok: boolean;
	mode: "init";
	outDir: string;
	gtrkPath: string;
	transcriptPath: string;
	/** 落地后的本地配音音频绝对路径（主路=下载产物；兜底路=用户音频原路径；下载失败为 null）。 */
	audioPath: string | null;
	taskId: string | null;
	ttsTaskId?: string;
	fileId?: string;
	canvas: [number, number];
	/** materials[].path 改写条数。 */
	rewritten: number;
	errors: Record<string, string>;
}

/** 兜底路：上传音频 + 调同步口（6004 共享恢复口径对齐 uploadAndSubmitTask：缓存失效重传一次、新 ID 短退避）。 */
async function uploadAndCall(
	cfg: CloudConfig,
	audioAbs: string,
	buildPayload: (fileId: string) => Record<string, unknown>,
	opts: { force?: boolean },
	deps: Required<Pick<ProjectInitDeps, "fetchFn" | "upload" | "invalidate" | "sleep">>,
): Promise<{ resp: AudioProjectStructResp; fileId: string }> {
	const MATERIAL_NOT_FOUND = 6004;
	let uploaded = await deps.upload(cfg, audioAbs, { force: opts.force });
	log.info(
		uploaded.cached ? `命中上传缓存，复用 file_id = ${uploaded.fileId}（免二次上传）` : `file_id = ${uploaded.fileId}`,
	);
	if (uploaded.cached) {
		try {
			return { resp: await callAudioProjectStruct(cfg, buildPayload(uploaded.fileId), deps.fetchFn), fileId: uploaded.fileId };
		} catch (e) {
			if (cloudErrorCode(e) !== MATERIAL_NOT_FOUND) throw e;
			log.warn("缓存的 file_id 在云端已失效，重新上传后重试…");
			await deps.invalidate(audioAbs);
			uploaded = await deps.upload(cfg, audioAbs, { force: true });
		}
	}
	for (let attempt = 0; ; attempt++) {
		try {
			return { resp: await callAudioProjectStruct(cfg, buildPayload(uploaded.fileId), deps.fetchFn), fileId: uploaded.fileId };
		} catch (e) {
			if (cloudErrorCode(e) !== MATERIAL_NOT_FOUND || attempt >= DEFAULT_VISIBILITY_BACKOFF_MS.length) throw e;
			await deps.sleep(DEFAULT_VISIBILITY_BACKOFF_MS[attempt]!);
		}
	}
}

/** 命令主逻辑（导出供测试）。 */
export async function runProjectInit(opts: ProjectInitOpts, depsOverride: ProjectInitDeps = {}): Promise<ProjectInitResult> {
	if (opts.json) routeLogsToStderr();

	// ── 入路互斥校验（参数错误明示，不做静默忽略；先纯本地校验再触配置/网络）──
	const hasTts = !!opts.ttsTask?.trim();
	const hasAudio = !!opts.audio;
	const hasTranscript = !!opts.transcript;
	if (hasTts && (hasAudio || hasTranscript)) {
		throw new Error("--tts-task 与 --audio/--transcript 互斥：主路引用 TTS 任务，兜底路自备配音，二选一");
	}
	if (!hasTts && !(hasAudio && hasTranscript)) {
		throw new Error(
			"需要 --tts-task <task_id>（主路：刚完成的 audio_tts_clone 任务）或 --audio <配音> --transcript <transcript.json> 成对（兜底路：自备配音）",
		);
	}
	const canvas = parseCanvas(opts.canvas);

	// 字幕行标点口径（--keep-punctuation，语义与 `gtrk subtitle lay` / `gtrk long2short` 同名 flag 一致）：
	// 给了才传 `strip_punctuation: false`，**不给不加键**——payload 对老服务端逐字节向后兼容，
	// 缺省口径由服务端持有（2026-08-22 全线统一：缺省去中英逗号句号、其余标点保留）。
	// 只影响 transcript 的字幕行文本；.gtrk 工程结构、时码与行数不受影响。
	const punctuation: Record<string, unknown> = opts.keepPunctuation ? { strip_punctuation: false } : {};

	// 兜底路纯本地前置：文件存在性 + 音频白名单 + transcript 归一（失败零网络零副作用）
	let audioAbs: string | undefined;
	let submitBody: { utterances: SubmitUtterance[]; duration: number } | undefined;
	if (!hasTts) {
		audioAbs = resolve(opts.audio!);
		if (!existsSync(audioAbs)) throw new Error(`配音音频不存在：${audioAbs}`);
		const ext = extname(audioAbs).toLowerCase();
		if (!(defaultExtsFor("audio") ?? []).includes(ext)) {
			throw new Error(`不支持的音频格式「${ext || "无扩展名"}」；请输入本地配音音频文件（wav/mp3/flac/m4a/aac/ogg 等）`);
		}
		const transcriptAbs = resolve(opts.transcript!);
		if (!existsSync(transcriptAbs)) throw new Error(`找不到 transcript.json：${transcriptAbs}`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(transcriptAbs, "utf8"));
		} catch (e) {
			throw new Error(`transcript.json 不是合法 JSON：${transcriptAbs}（${e instanceof Error ? e.message : String(e)}）`);
		}
		submitBody = normalizeTranscriptForSubmit(parsed, transcriptAbs);
	}

	const cfg = depsOverride.cfg ?? loadConfig();
	const deps = {
		fetchFn: depsOverride.fetchFn ?? fetch,
		upload: depsOverride.upload ?? uploadCached,
		invalidate: depsOverride.invalidate ?? invalidateUpload,
		getTtsResult: depsOverride.getTtsResult ?? getTaskResult,
		download: depsOverride.download ?? realDownload,
		openFolder: depsOverride.openFolder ?? openFolder,
		sleep: depsOverride.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
	};

	// 产物目录：兜底路与音频同目录、主路落当前目录（oralcut 惯例 <名>-video-project-<时间戳>）
	const projName = hasTts ? `tts-${opts.ttsTask!.trim()}` : basename(audioAbs!, extname(audioAbs!));
	const baseDir = hasTts ? process.cwd() : dirname(audioAbs!);
	const outDir = resolve(opts.out ?? join(baseDir, `${projName}-video-project-${timestamp()}`));

	log.step(`▶ 音频驱动工程起盘：${hasTts ? `TTS 任务 ${opts.ttsTask}` : basename(audioAbs!)}（画布 ${canvas[0]}x${canvas[1]}）`);
	log.info("工程 JSON 由服务端 producer 同步口生成（emit 链单一权威源）；本接口 0 积分不计费。");
	if (opts.keepPunctuation) log.info("保留原始标点（--keep-punctuation）：transcript 文稿逐字保留逗号句号");

	// ── 调服务端同步口 ──
	let resp: AudioProjectStructResp;
	let fileId: string | undefined;
	if (hasTts) {
		log.step("① 服务端拼装工程（TTS 产物 segments 直出，零 ASR）…");
		resp = await callAudioProjectStruct(cfg, { tts_task_id: opts.ttsTask!.trim(), canvas, ...punctuation }, deps.fetchFn);
	} else {
		log.step("① 上传配音并请求服务端拼装工程…");
		const got = await uploadAndCall(
			cfg,
			audioAbs!,
			(fid) => ({ file_id: fid, utterances: submitBody!.utterances, duration: submitBody!.duration, canvas, ...punctuation }),
			{ force: opts.reupload },
			deps,
		);
		resp = got.resp;
		fileId = got.fileId;
	}
	if (resp.taskId) log.info(`task_id = ${resp.taskId}`);

	// ── 落地 + materialize 路径改写 ──
	log.step("② 落地产物目录（gtrk / transcript / result.json）…");
	const errors: Record<string, string> = {};
	await mkdir(join(outDir, "gtrk"), { recursive: true });
	await mkdir(join(outDir, "transcript"), { recursive: true });

	// 本地配音音频：主路下载 TTS 产物到 <outDir>/audio/；兜底路直指用户音频绝对路径（不做副本）
	let audioPath: string | null = null;
	if (hasTts) {
		try {
			const tts = await deps.getTtsResult(cfg, TTS_TASK_TYPE, opts.ttsTask!.trim());
			const url = pickUrl(tts.output as Record<string, unknown>, ["download_url"]);
			if (!url) throw new Error("TTS 任务产物缺 download_url（任务未完成或产物已过期）");
			await mkdir(join(outDir, "audio"), { recursive: true });
			const dest = join(outDir, "audio", `tts-${opts.ttsTask!.trim()}${extFromUrl(url, ".wav")}`);
			await deps.download(url, dest);
			audioPath = dest;
			log.info(`TTS 配音已下载：${basename(dest)}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			errors["tts_audio:download"] = msg;
			log.warn(`TTS 产物音频下载失败（${msg}）——工程照常落地，但配音素材路径未本地化，客户端打开需手动定位素材`);
		}
	} else {
		audioPath = audioAbs!;
	}

	// materialize 路径改写：配音轨素材引用 → 本地音频绝对路径（oralcut source_path 同款口径）
	let rewritten = 0;
	if (audioPath) {
		rewritten = rewriteVoiceMaterialPaths(resp.gtrk, resp.transcript, audioPath);
		if (rewritten === 0) {
			errors["gtrk:materials"] = "工程 materials 为空，无从改写配音素材路径（服务端契约异常）";
			log.warn(errors["gtrk:materials"]);
		}
	}

	const gtrkPath = join(outDir, "gtrk", "project.gtrk");
	const transcriptPath = join(outDir, "transcript", "transcript.json");
	await writeFile(gtrkPath, JSON.stringify(resp.gtrk, null, 2));
	await writeFile(transcriptPath, JSON.stringify(resp.transcript, null, 2));

	const result: ProjectInitResult = {
		ok: Object.keys(errors).length === 0,
		mode: "init",
		outDir,
		gtrkPath,
		transcriptPath,
		audioPath,
		taskId: resp.taskId,
		...(hasTts ? { ttsTaskId: opts.ttsTask!.trim() } : {}),
		...(fileId ? { fileId } : {}),
		canvas,
		rewritten,
		errors,
	};
	await writeFile(join(outDir, "result.json"), JSON.stringify(result, null, 2));

	// ── 完成话术（客户端 openHint）+ 默认自动打开 ──
	if (!opts.json) {
		log.step("三方打开（产物已就位，按需自取）：");
		console.log(`   • ${FORMAT_META.gtrk.label}：${FORMAT_META.gtrk.openHint(gtrkPath)}`);
		console.log(`   • 结果清单：${join(outDir, "result.json")}`);
	}
	if (opts.open !== false) {
		deps.openFolder(outDir);
		log.info("已打开产物目录文件夹");
	}
	log.ok(`配音打底工程已就绪：${outDir}（可直接 gtrk split --project 投影拆分）`);
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

export function registerProject(program: Command): void {
	program
		.command("project [words...]")
		.description(
			"音频驱动工程族：gtrk project init 从配音起盘建 .gtrk 工程（主路 --tts-task 引用 TTS 任务；兜底 --audio+--transcript 自备配音）",
		)
		.option("--tts-task <task_id>", "主路：引用已完成的 audio_tts_clone 任务（服务端取产物音频+句级 segments，零 ASR）")
		.option("--audio <file>", "兜底路：自备配音音频（与 --transcript 成对使用；CLI 先上传归一）")
		.option("--transcript <file>", "兜底路：transcript.json（gtrk transcript <配音音频> --json 产出）")
		.option("--canvas <WxH>", "画布尺寸（默认 1080x1920）")
		.option("-o, --out <dir>", "产物目录（缺省 = <基目录>/<名>-video-project-<YYMMDD-HHMMSS>）")
		.option("--reupload", "兜底路：强制重新上传配音音频，忽略本地上传缓存")
		.option("--keep-punctuation", "transcript 文稿保留全部标点（缺省按统一口径去逗号句号、保留？！等）")
		.option("--no-open", "完成后不自动打开产物目录（默认会自动打开）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[] | undefined, opts: ProjectInitOpts) => {
			parseProjectPositional(words);
			await runProjectInit(opts);
		});
}
