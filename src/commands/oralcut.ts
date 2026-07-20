/**
 * gtrk oralcut —— 智能口播剪辑闭环（CLI 特例 video_oral_cut_for_cli）：
 *   agent 发起 → CLI 本地预处理（探几何 + 抽 16k 单声道 mp3 / 压 720p）→ 只传抽出物（毛片永不上传）
 *   → 云端 cli/video_oral_cut_for_cli 出 gtrk EDL + 三方工程文件 → 拉回 →（可选）本地 ffmpeg 渲染成片。
 *
 * 毛片永不出本地：只传几十 MB 抽出物；source_path 把毛片本地绝对路径写进 gtrk materials[].path，
 * 本地打开/渲染直接认素材。几何三件套（video_size/video_rate/video_duration）由客户端探得回传，
 * 保证云端工程画布/帧率正确并做计费宽松校验。成片由本地 ffmpeg 按 gtrk EDL 渲染，云端不产成片。
 */
import { Command } from "commander";
import { resolve, join, dirname, basename, extname } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadConfig } from "../lib/config";
import { pollTask } from "../lib/cloud";
import { uploadAndSubmitTask } from "../lib/upload-submit";
import { resolveJianyingDraftDir } from "../lib/jianying";
import { probeGeometry, extractAudio, compress720p, assertDurationConsistent } from "../lib/media";
import { materializeResult } from "../lib/materialize";
import { log, routeLogsToStderr } from "../lib/log";

// cli 域特例：taskType 含 /cli 前缀，cloud.ts 的 /task/${taskType} 模板天然拼出 /task/cli/video_oral_cut_for_cli
const TASK_TYPE = "cli/video_oral_cut_for_cli";

/** 本地时间戳 YYMMDD-HHMMSS（如 260629-191530），用于产物目录名区分每一次剪辑。 */
function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface OralCutOpts {
	script?: string;
	preset: string;
	out?: string;
	formats: string;
	jianyingDraftDir?: string;
	lang?: string;
	visualAssist?: boolean;
	adaptiveRhythm?: boolean; // commander --no-adaptive-rhythm：默认 true，传了才 false
	render?: boolean; // 本地渲染成片（ffmpeg，按 gtrk EDL）
	crf?: string;
	codec?: string;
	ffmpegPath?: string;
	param: string[]; // --param k=v（可重复）
	paramsJson?: string;
	open?: boolean;
	reupload?: boolean;
	json?: boolean;
}

/** --param 收集器（重复出现即累积）。 */
const collectParam = (v: string, acc: string[]): string[] => {
	acc.push(v);
	return acc;
};

/** k=v 的 value 智能转型：true/false→bool、纯数字→number、否则原样字符串。 */
function coerceValue(v: string): unknown {
	if (v === "true") return true;
	if (v === "false") return false;
	if (v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
	return v;
}

/** 解析 --param k=v[] + --params-json，合成透传参数对象（params-json 覆盖同名 --param）。 */
function parseExtraParams(pairs: string[], jsonStr?: string): Record<string, unknown> {
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

export function registerOralCut(program: Command): void {
	program
		.command("oralcut <input>")
		.description("智能口播剪辑闭环：本地抽音频/720p → 只传抽出物 → 云端剪辑 → 拉回 gtrk/剪映/PR →（可选）本地渲染")
		.option("-s, --script <file>", "文稿 txt 路径（缺省走无稿智能重建）")
		.option("-p, --preset <preset>", "节奏预设 steady|concise|compact", "concise")
		.option("-o, --out <dir>", "工程产物目录（缺省 = <毛片同目录>/<毛片名>-video-project-<YYMMDD-HHMMSS>）")
		.option("-f, --formats <list>", "三方格式（逗号分隔）", "gtrk,jianying,xml")
		.option("--jianying-draft-dir <dir>", "剪映草稿根目录；传路径或 auto（默认读 gtrk init 配置 / 自动探测）")
		.option("--lang <code>", "语言代码（默认 zh-CN；如 en-US / ja-JP）")
		.option("--visual-assist", "视觉兜底：本地改传 720p 代理，云端用人脸/说话检测保护并重识别（剪不准/怕剪掉真内容时开）")
		.option("--no-adaptive-rhythm", "关闭自适应节奏（默认开；关了改用固定标点停顿表）")
		.option("--render", "额外本地渲染成片（ffmpeg 按 gtrk EDL 出 mp4；毛片仍不出本地）")
		.option("--crf <n>", "本地渲染视频质量 CRF 14-28（越小越清晰/文件越大，默认 18；需配 --render）")
		.option("--codec <c>", "本地渲染视频编码（默认 h264；需配 --render）")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录（缺省 ~/.gitruck/ffmpeg → 系统 PATH）")
		.option("--param <k=v>", "透传任意云端参数（标量、可重复；如 --param intra_gap_max=0.4）", collectParam, [])
		.option("--params-json <json>", "透传任意云端参数（JSON 对象、支持嵌套；如 '{\"punctuation_breaks\":{\"。\":0.3}}'）")
		.option("--reupload", "强制重新上传，忽略本地上传缓存")
		.option("--no-open", "完成后不自动打开产物目录（默认会自动打开）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON（给 agent/脚本解析）")
		.action(async (input: string, opts: OralCutOpts) => {
			await runOralCut(input, opts);
		});
}

async function runOralCut(input: string, opts: OralCutOpts): Promise<void> {
	if (opts.json) routeLogsToStderr(); // 机读模式：人读日志转 stderr，stdout 只留结果 JSON
	const cfg = loadConfig();
	const inputAbs = resolve(input);
	if (!existsSync(inputAbs)) throw new Error(`毛片不存在：${inputAbs}`);

	const projName = basename(inputAbs, extname(inputAbs));
	const formats = opts.formats.split(",").map((s) => s.trim()).filter(Boolean);
	// 本地渲染需要 gtrk EDL；用户没显式要 gtrk 也补上（否则无从渲染）
	if (opts.render && !formats.includes("gtrk")) formats.push("gtrk");
	const wantJianying = formats.some((f) => f === "jianying" || f === "capcut");
	// 缺省产物目录与毛片同目录，名为 <毛片名>-video-project-<时间戳>
	// 目录延后到首次真正写入（task.json / 产物 / result.json）才建，提交前失败不留空壳
	const outDir = resolve(opts.out ?? join(dirname(inputAbs), `${projName}-video-project-${timestamp()}`));

	// 文稿：显式 --script 优先；没给则探毛片同目录同名 .txt
	let scriptPath = opts.script ? resolve(opts.script) : undefined;
	if (!scriptPath) {
		const sibling = join(dirname(inputAbs), `${projName}.txt`);
		if (existsSync(sibling)) {
			scriptPath = sibling;
			log.info(`自动识别到同名文稿：${sibling}（按有稿剪辑；不想用就改名或显式 --script）`);
		}
	}
	const script = scriptPath ? await readFile(scriptPath, "utf8") : undefined;

	// 剪映草稿目录：提交前先解析
	let draftDir: string | undefined;
	if (wantJianying) {
		draftDir = resolveJianyingDraftDir(opts.jianyingDraftDir);
		if (draftDir) log.info(`剪映草稿目录：${draftDir}`);
		else log.warn("没找到剪映草稿目录 → 将只产 draft_content.json、缺 meta。可加 --jianying-draft-dir <你的草稿目录> 重跑。");
	}

	log.step(
		`▶ 智能口播剪辑：${basename(inputAbs)}（预设 ${opts.preset}${opts.visualAssist ? " · 视觉兜底(720p)" : ""}，格式 ${formats.join("/")}${opts.render ? " · 本地渲染" : ""}）`,
	);

	const extraParams = parseExtraParams(opts.param, opts.paramsJson);

	// ① 本地预处理：探原片几何 + 抽音频(默认) / 压 720p(视觉兜底)。毛片永不上传。
	log.step("① 本地预处理（探几何 + 抽音频/720p）…");
	const geo = probeGeometry(inputAbs, opts.ffmpegPath);
	log.info(`原片几何 ${geo.width}x${geo.height} @ ${geo.fps.toFixed(2)}fps · ${geo.duration.toFixed(1)}s`);
	const artifact = opts.visualAssist
		? await compress720p(inputAbs, opts.ffmpegPath)
		: await extractAudio(inputAbs, opts.ffmpegPath);
	assertDurationConsistent(geo.duration, artifact, opts.ffmpegPath);
	log.info(
		opts.visualAssist ? `已压 720p 代理（上传物）：${basename(artifact)}` : `已抽 16k 单声道 mp3（上传物）：${basename(artifact)}`,
	);

	// ② 上传抽出物 → file_id（毛片不出本地；指纹缓存复用免二次上传）
	log.step("② 上传抽出物到云端…");

	// 用当前 file_id 拼提交体（缓存失效/延迟可见时要重拼，故抽成函数）
	const buildPayload = (fid: string): Record<string, unknown> => {
		const p: Record<string, unknown> = {
			file_id: fid,
			la: opts.lang ?? "zh-CN",
			project_formats: formats,
			source_path: inputAbs, // 毛片本地绝对路径 → gtrk materials[].path，本地渲染/打开认素材
			video_size: [geo.width, geo.height], // 原片真实几何（客户端探得），云端工程画布 + 计费校验
			video_rate: geo.fps,
			video_duration: geo.duration,
			rhythm_preset: opts.preset,
		};
		if (script) p.script = script;
		if (draftDir) p.struct_meta = { nle_draft_dir: draftDir };
		if (opts.visualAssist) p.visual_assist = true; // 720p 输入下云端做说话检测
		if (opts.adaptiveRhythm === false) p.adaptive_rhythm = false;
		// 通用透传优先级最高：agent 永远能强制覆盖上面任何字段（对象字段做逐字段合并，免整体覆盖丢字段）
		for (const [k, v] of Object.entries(extraParams)) {
			const cur = p[k];
			const bothObj =
				!!cur && !!v && typeof cur === "object" && typeof v === "object" && !Array.isArray(cur) && !Array.isArray(v);
			p[k] = bothObj
				? { ...(cur as Record<string, unknown>), ...(v as Record<string, unknown>) }
				: v;
		}
		return p;
	};

	// ③ 提交 cli/video_oral_cut_for_cli；共享恢复边界收编新 ID 可见性与缓存失效
	const submitted = await uploadAndSubmitTask(cfg, artifact, TASK_TYPE, buildPayload, {
		force: opts.reupload,
		onUploaded: (uploaded) => {
			log.info(
				uploaded.cached
					? `命中上传缓存，复用 file_id = ${uploaded.fileId}（免二次上传）`
					: `file_id = ${uploaded.fileId}`,
			);
			log.step("③ 提交智能口播剪辑任务…");
		},
		onCacheInvalid: () => log.warn("缓存的 file_id 在云端已失效，重新上传后重试…"),
	});
	const { taskId } = submitted;
	const up = { fileId: submitted.fileId, cached: submitted.cached };
	log.info(`task_id = ${taskId}`);
	// 面包屑：submit 一成功就落盘 task.json（按需建 outDir），任何后续崩溃都能据此按 task_id 恢复
	await mkdir(outDir, { recursive: true });
	await writeFile(
		join(outDir, "task.json"),
		JSON.stringify(
			{ taskId, taskType: TASK_TYPE, fileId: up.fileId, source: inputAbs, formats, createdAt: new Date().toISOString() },
			null,
			2,
		),
	);

	// ④ 轮询到完成
	log.step("④ 云端处理中（每 5s 轮询）…");
	const result = await pollTask(cfg, TASK_TYPE, taskId, (status, progress) => {
		log.tick(`${status}${progress != null ? ` ${Math.round(progress)}%` : ""}`);
	});
	log.tickEnd();

	// ⑤⑥⑦ 拉回产物 / 剪映草稿 / 可选渲染 / result.json 两段写 / 输出（共享落地逻辑）
	await materializeResult({
		outDir,
		output: result,
		taskId,
		fileId: up.fileId,
		draftDir,
		render: opts.render,
		crf: opts.crf,
		codec: opts.codec,
		ffmpegPath: opts.ffmpegPath,
		projName,
		json: opts.json,
		open: opts.open,
	});

	log.ok(`闭环完成。产物目录：${outDir}`);
}
