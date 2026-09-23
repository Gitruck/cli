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
import {
	probeGeometry,
	extractAudio,
	compress720p,
	assertDurationConsistent,
	assertWithinMediaDurationLimit,
	assertSourceFrameRate,
	vfrNotice,
	sourceRateInfo,
} from "../lib/media";
import { materializeResult } from "../lib/materialize";
import { assertEnum, assertEnumIn, assertSourceLanguage } from "../lib/enum-catalog";
import { log, routeLogsToStderr } from "../lib/log";
import { ensureLandingWritable, type LandingWaitDeps } from "../lib/landing-wait";

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

/**
 * 可注入的前置区依赖（缺省 = 真实实现），与 `long2short.ts` 的 `Long2ShortDeps` 同形状同理由：
 * 前置校验区拦下后云端交互根本不会发生，故离线测试替换这几个即可把「零抽取零上传」证成调用次数 0。
 */
export interface OralCutDeps {
	loadConfig: typeof loadConfig;
	probe: typeof probeGeometry;
	extract: typeof extractAudio;
	compress: typeof compress720p;
	/** 落点闸的交互依赖（isTty / waitForEnter / notify），单测据此闸住非交互硬失败路径。 */
	landingWait: Partial<LandingWaitDeps>;
	/**
	 * 上传 + 提交（= **计费动作本体**）。
	 *
	 * ⚠️ 2026-09-08 审计补：tasks §2.9 的判据原文是「注入的 `extract` / `compress` /
	 * `upload` / `submit` **四个** dep 调用次数全为 0」，但此前 `OralCutDeps` 里
	 * **根本没有 upload / submit 两项** —— 提交走模块级 import 直调，无注入面 ⇒
	 * 那半判据在本仓**写不出来**，实收只断言了前两个，靠「不抽取 ⇒ 没东西可传」的
	 * 传递性成立。传递性是推理不是判据：把 Gate A 挪到抽取**之后**、上传之前，
	 * 前两个断言会红，但「零计费」这句话本身没有任何一条断言直接守着。
	 * 现补上注入点，让 §2.9 的四个数字都能被**字面**断言。
	 */
	uploadAndSubmit: typeof uploadAndSubmitTask;
}

function buildDeps(o: Partial<OralCutDeps> = {}): OralCutDeps {
	return {
		loadConfig: o.loadConfig ?? loadConfig,
		probe: o.probe ?? probeGeometry,
		extract: o.extract ?? extractAudio,
		compress: o.compress ?? compress720p,
		landingWait: o.landingWait ?? {},
		uploadAndSubmit: o.uploadAndSubmit ?? uploadAndSubmitTask,
	};
}

/** 超限报错的尾句：分段之后该干什么（口播侧 = 逐段剪、各段工程独立可精修）。 */
const DURATION_LIMIT_HINT = {
	command: "oralcut",
	afterward: "各段各出一份工程，逐段精修互不影响。",
} as const;

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

export async function runOralCut(
	input: string,
	opts: OralCutOpts,
	overrides: Partial<OralCutDeps> = {},
): Promise<void> {
	if (opts.json) routeLogsToStderr(); // 机读模式：人读日志转 stderr，stdout 只留结果 JSON
	const deps = buildDeps(overrides);
	const cfg = deps.loadConfig();
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

	// ① 本地预处理：探原片几何 → 时长硬闸 → 抽音频(默认) / 压 720p(视觉兜底)。毛片永不上传。
	log.step("① 本地预处理（探几何 + 抽音频/720p）…");
	const geo = deps.probe(inputAbs, opts.ffmpegPath);
	log.info(`原片几何 ${geo.width}x${geo.height} @ ${geo.fps.toFixed(2)}fps · ${geo.duration.toFixed(1)}s`);
	// ①0 帧率门 + VFR 可见（add-frame-rate-table-vfr-detect D4/D5）——与时长硬闸同属零成本前置区：
	//   帧率解析不到 ⇒ 报错退出（零抽取、零上传；outDir 此刻尚未建，不留空壳）；VFR ⇒ 只 WARN 一行不阻断，
	//   几何仍按真实 r_frame_rate 回传（下方 payload 的 video_rate 不吸附），机读对应物是 --json source.vfr。
	assertSourceFrameRate(geo);
	const vfrWarn = vfrNotice(geo);
	if (vfrWarn) log.warn(vfrWarn);

	// ①a 上传前时长硬闸（add-pre-upload-duration-gate）——MUST 排在抽取之前：
	//   本任务类型 `video_oral_cut_for_cli` 在服务端是按时长计费的（gc_task_type id 43，
	//   modal_type=audio），建单前一律过公共媒体探测层，超 2h 直接 6019 硬拒。
	//   本地此刻已经知道时长，没有理由先花几分钟转码、再传几百 MB 才让服务端说不行。
	assertWithinMediaDurationLimit(geo.duration, DURATION_LIMIT_HINT);

	// ①b 枚举清单校验（link-enum-catalog-cli §2.3）——MUST 排在抽取/上传/提交之前：
	//   别让用户压完 720p、传完几百 MB，才被服务端告知 `--preset` 是个拼写错误。
	//
	// ⚠️ **排在落点闸之前是刻意的**：落点闸是**交互式**的（写不进去就阻塞、拉用户去改目录），
	//   而本处三行是纯本地、零成本、微秒级。先让用户改完目录、再告诉他参数拼错了，是更差的顺序。
	//   两者都在抽取/上传之前，所以谁先谁后不产生任何实际开销差——只差在打扰用户的次数。
	// ⚠️ **本处不 `primeCatalog`（不联网）**：oralcut 的失败路径 MUST NOT 依赖网络。
	//   校验读的是盘上快照——它由 `gtrk doctor`（`gtrk init` 末尾就会跑一次）与
	//   任一 `gtrk tool` 顺带刷新。没有快照 ⇒ 放行，交服务端裁决（fail-open 是本件的既定口径）。
	// ⚠️ `--formats` 的**默认值** `gtrk,jianying,xml` 是产品决定不是枚举，本处不动它，只校验取值。
	// ⟲ 2026-09-10（infra add-enum-catalog-api 6.8 转入）：`--lang` 是**识别源语种**，按本线分档校验。
	//   原先拿 `subtitle.languages`（11 项共同范围）校验，会放行 es-ES / pt-PT / ru-RU / vi-VN，
	//   让它们抽完、传完再被服务端 6015 拒。键是 `video_oral_cut`：CLI 特例 `…_for_cli` 的入口闸查的就是它。
	//   新键缺失（老服务端 / 旧快照）时自动退回共同范围，「只降不升」不变。
	if (opts.lang != null) assertSourceLanguage("video_oral_cut", "--lang", String(opts.lang).trim());
	assertEnum("oral_cut.rhythm_presets", "--preset", String(opts.preset));
	// 并集校验：服务端**同时接受** aliases 里的旧细粒度值（jianying_draft 等），只按 public 判会误拒。
	for (const f of formats) assertEnumIn(["project_formats.public", "project_formats.aliases"], "--formats", f);

	// ①c 落点可写性闸 Gate A（add-artifact-landing-gate · 裁决 D5）——MUST 排在抽取/上传/提交之前：
	//   此刻 outDir 与 draftDir 都已解析，且零抽取、零上传、零提交、零计费。
	//   排在时长硬闸**之后**，是为了不让一个注定被 2h 上限拒掉的跑批先去打扰用户等待。
	//   写不进去 ⇒ 阻塞拉用户处理到可写为止（非交互当场硬失败），MUST NOT 静默改投别的目录。
	await ensureLandingWritable(outDir, "产物目录", {
		json: opts.json,
		deps: overrides.landingWait,
	});
	if (wantJianying && draftDir) {
		// 草稿根「探不到」维持既有 WARN 语义（上方已 warn 并继续）；此处只管「探得到但写不进」。
		await ensureLandingWritable(draftDir, "剪映草稿根", { json: opts.json, deps: overrides.landingWait });
	}

	const artifact = opts.visualAssist
		? await deps.compress(inputAbs, opts.ffmpegPath)
		: await deps.extract(inputAbs, opts.ffmpegPath);
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
	const submitted = await deps.uploadAndSubmit(cfg, artifact, TASK_TYPE, buildPayload, {
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
	const mat = await materializeResult({
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
		// 落地复核之墙（add-cross-clock-adapter D5）：上传前探得的原片实测时长（source_container 钟），只报告不改产物
		landingWall: { sourcePath: inputAbs, durationSec: geo.duration },
		// 源片帧率账面（add-frame-rate-table-vfr-detect D4）：r / avg / vfr 三值进 --json source 与 result.json
		source: sourceRateInfo(inputAbs, geo),
		landingWait: overrides.landingWait,
	});

	// 4.5 未消解的本地写入失败 ⇒ 非零退出（形态照 long2short.ts:490-494：设 exitCode 后 return，
	//     MUST NOT 调 process.exit）。云端 404 过期**不**改退出码——过期时仍能取回报告是本命令的价值。
	if (mat.localWriteFailed) {
		log.err(
			"存在未消解的本地写入失败：产物没有全部落到你指定的目录。" +
				`报告与 task.json 已保留，修好写入权限后可用：gtrk oralcut-result ${taskId} --out <目录>（不重跑、不二次计费）。`,
		);
		process.exitCode = 1;
		return;
	}
	log.ok(`闭环完成。产物目录：${outDir}`);
}
