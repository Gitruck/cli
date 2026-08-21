/**
 * gtrk long2short —— 长剪短闭环（CLI 特例 video_long2short_for_cli，infra id 47）：
 *   agent 发起 → CLI 本地预处理（探几何 + 抽 16k 音频 / 压 720p 代理〔--split-screen〕）→ 只传抽出物
 *   （毛片永不上传）→ 云端选段/跳剪（+720p 代理分屏）逐 clip 出 gtrk/剪映/PR 工程 + 选段报告
 *   → 拉回：分屏素材按 expected_path 落毛片旁 split_screen/、逐 clip 产物落 clip{i}/ 子目录。
 *
 * 与 oralcut 同一心智模型（毛片不出本地 / 几何三件套回传 / 三方工程 / 面包屑可恢复），
 * 差异仅「多 clip 嵌套产物」：一次任务出 N 条高光短片，各自一份工程组。
 * 成片条数由内容语义决定（纯语义选段），不可指定条数；成片时长偏好经 --duration-pref / --max-clip-sec。
 */
import { Command } from "commander";
import { resolve, join, dirname, basename, extname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadConfig } from "../lib/config";
import { download, type OralCutOutput } from "../lib/cloud";
import { uploadAndSubmitTask } from "../lib/upload-submit";
import { uploadCached } from "../lib/upload-cache";
import { copyJianyingDraft, resolveJianyingDraftDir } from "../lib/jianying";
import { probeGeometry, extractAudio, compress720p, assertDurationConsistent } from "../lib/media";
import { materializeResult, type MaterializeResult } from "../lib/materialize";
import { renderClipBrief, renderClipsOverview } from "../lib/clip-brief";
import { pollToolTask, parseExtraParams, mergeParams } from "../lib/tool-runner";
import { openFolder } from "../lib/open";
import { log, routeLogsToStderr } from "../lib/log";

// cli 域特例：cloud.ts 的 /task/${taskType} 模板天然拼出 /task/cli/video_long2short_for_cli
const TASK_TYPE = "cli/video_long2short_for_cli";
// 长片 ASR+LLM 选段耗时随片长涨：墙钟放宽到 60min（先例 video_matting）；面包屑保证超时可恢复
const POLL_TIMEOUT_MS = 60 * 60 * 1000;

export interface Long2ShortOpts {
	language?: string;
	splitScreen?: boolean;
	splitOrientation?: string;
	mainTopic?: string;
	durationPref?: string;
	maxClipSec?: string;
	jumpCut?: boolean; // commander --no-jump-cut：默认 true，传了才 false
	outputSize?: string;
	formats: string;
	jianyingDraftDir?: string;
	/** 现成单语字幕文件（.srt/.ass）作转写来源：上传后经 subtitle_file_id 替代云端 ASR（与 stt 互斥）。 */
	subtitleFile?: string;
	/** 逐 clip 另产单语 .srt（outputs 并入 subtitle；落 clip{i}/srt/clip{i}.srt）。 */
	subtitleOut?: boolean;
	/** 字幕保留全部标点（缺省服务端 B 案：逗号句号→空格、其余保留）→ subtitle.strip_punctuation=false。 */
	keepPunctuation?: boolean;
	out?: string;
	ffmpegPath?: string;
	param: string[];
	paramsJson?: string;
	reupload?: boolean;
	open?: boolean;
	json?: boolean;
}

/** 云端逐 clip 出参（选段元信息 + files[] 工程组）。 */
interface CloudClip {
	title?: string;
	score?: number;
	files?: Array<{ type: string; format: string; download_url: string; filename: string }>;
	[k: string]: unknown;
}

interface SplitManifestItem {
	clip_index?: number;
	file_id?: string;
	download_url?: string;
	expected_path?: string;
	[k: string]: unknown;
}

const collectParam = (v: string, acc: string[]): string[] => {
	acc.push(v);
	return acc;
};

/**
 * 拼云端 payload（导出供离线测试）：几何三件套 + source_path 恒回传；选段/分屏参数缺省省略；
 * --param/--params-json 最终字段级覆盖。
 */
export function buildLong2ShortPayload(
	fileId: string,
	opts: Long2ShortOpts,
	geo: { width: number; height: number; fps: number; duration: number },
	inputAbs: string,
	formats: string[],
	draftTarget?: string,
	subtitleFileId?: string,
): Record<string, unknown> {
	if (!opts.language || !opts.language.trim()) {
		throw new Error("--language 必填（源语种，如 zh-CN；取值以服务端支持列表为准）");
	}
	const p: Record<string, unknown> = {
		file_id: fileId,
		language: opts.language,
		project_formats: formats,
		source_path: inputAbs, // 毛片本地绝对路径 → gtrk materials[].path；分屏素材 expected_path 也据此推
		video_size: [geo.width, geo.height],
		video_rate: geo.fps,
		video_duration: geo.duration,
	};
	if (opts.mainTopic) p.main_topic = opts.mainTopic;
	if (opts.outputSize) p.output_size = opts.outputSize;
	if (opts.jumpCut === false) p.jump_cut = false;
	// 字幕三参（link-long2short-subtitle-input-cli）：来源 / 产出 / 标点各自独立可组合
	if (subtitleFileId) p.subtitle_file_id = subtitleFileId;
	if (opts.subtitleOut) p.outputs = ["project", "report", "subtitle"];
	if (opts.keepPunctuation) p.subtitle = { strip_punctuation: false };
	const duration: Record<string, unknown> = {};
	if (opts.durationPref) duration.pref = opts.durationPref;
	if (opts.maxClipSec != null) {
		const n = Number(opts.maxClipSec);
		if (!Number.isFinite(n)) throw new Error(`--max-clip-sec 需要有限数值，拿到「${opts.maxClipSec}」`);
		duration.max_clip_sec = n;
	}
	if (Object.keys(duration).length) p.duration = duration;
	if (opts.splitScreen) {
		const ss: Record<string, unknown> = { enable: true };
		if (opts.splitOrientation) ss.orientation = opts.splitOrientation;
		p.split_screen = ss;
	}
	if (draftTarget) p.struct_meta = { nle_draft_dir: draftTarget };
	mergeParams(p, parseExtraParams(opts.param ?? [], opts.paramsJson));
	return p;
}

/**
 * 逐 clip 把剪映草稿拷进草稿根（导出供离线测试：`runLong2Short` 带上传/轮询，测不了这一段）。
 * 目标目录名对齐服务端 `nle_draft_dir` 的 `_clip{i}` 后缀约定；文件名按命名律落成剪映固定两件套
 * （源侧 `clip{i}_` 前缀只在这一跳剥掉，产物目录 `clip{i}/jianying/` 里的归档原名不动）。
 * 两件套不全 = 剪映列表里不会显示，故就地记 `errors`、不静默通过。
 */
export async function copyClipDraftsToRoot(
	clipDirs: string[],
	draftTarget: string,
	errors: Record<string, string>,
): Promise<{ paths: Array<string | null>; complete: number; attempted: number }> {
	const paths: Array<string | null> = [];
	let complete = 0;
	let attempted = 0;
	for (const [i, dir] of clipDirs.entries()) {
		const src = join(dir, "jianying");
		if (!existsSync(src)) {
			paths.push(null);
			continue;
		}
		attempted++;
		const dest = `${draftTarget}_clip${i}`;
		try {
			const landing = await copyJianyingDraft(src, dest);
			if (landing.complete) {
				complete++;
				paths.push(dest);
			} else {
				paths.push(null);
				errors[`clip${i}:jianying:draft`] = `草稿两件套不全（缺 ${landing.missing.join("、")}），剪映列表里不会显示：${dest}`;
			}
		} catch (e) {
			paths.push(null);
			errors[`clip${i}:jianying:draft`] = e instanceof Error ? e.message : String(e);
		}
	}
	return { paths, complete, attempted };
}

export function registerLong2Short(program: Command): void {
	program
		.command("long2short <input>")
		.description("长剪短闭环：本地抽音频/720p 代理 → 只传抽出物 → 云端选段跳剪（可选分屏）→ 逐 clip 拉回 gtrk/剪映/PR 三方工程")
		.option("--language <code>", "源语种（必填，如 zh-CN；取值以服务端支持列表为准）")
		.option("--split-screen", "开启智能分屏：本地改传 720p 代理，云端在代理上检测多人同框并烤 720p 分屏素材（素材落毛片旁 split_screen/）")
		.option("--split-orientation <o>", "分屏方向 auto|lr|tb（缺省服务端 auto=按内容随机）")
		.option("--main-topic <text>", "主题引导（影响选段偏好）")
		.option("--duration-pref <p>", "成片时长偏好（缺省服务端 auto；成片条数由内容语义决定、不可指定）")
		.option("--max-clip-sec <n>", "单条成片时长安全上限（秒；缺省服务端默认）")
		.option("--no-jump-cut", "关闭跳剪（默认开：片内去水词/冗余，只删不重排）")
		.option("--subtitle-file <path>", "现成单语字幕文件（.srt/.ass）作转写来源，替代云端 ASR（切点=字幕行边界；双语/多层 .ass 会被拒）")
		.option("--subtitle-out", "逐 clip 另产单语 .srt 字幕（按目标画布档位智能拆行，落 clip{i}/srt/）")
		.option("--keep-punctuation", "字幕保留全部标点（缺省按统一口径去逗号句号、保留？！等）")
		.option("--output-size <s>", "输出画布 9:16|16:9|1:1 或自定义 WxH（缺省服务端 9:16）")
		.option("-f, --formats <list>", "三方格式（逗号分隔，云端逐 clip 直产）", "gtrk,jianying,xml")
		.option("--jianying-draft-dir <dir>", "剪映草稿根目录；传路径或 auto（默认读 gtrk init 配置 / 自动探测）")
		.option("-o, --out <dir>", "产物根目录（缺省 = <毛片同目录>/<毛片名>-long2short）")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录（缺省 ~/.gitruck/ffmpeg → 系统 PATH）")
		.option("--param <k=v>", "透传任意云端参数（标量、可重复）", collectParam, [])
		.option("--params-json <json>", "透传任意云端参数（JSON 对象、支持嵌套；如 '{\"split_screen\":{\"prefer_mode\":\"...\"}}'）")
		.option("--reupload", "强制重新上传，忽略本地上传缓存")
		.option("--no-open", "完成后不自动打开产物根目录（默认会自动打开一次）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出根级结果 JSON")
		.action(async (input: string, opts: Long2ShortOpts) => {
			await runLong2Short(input, opts);
		});
}

async function runLong2Short(input: string, opts: Long2ShortOpts): Promise<void> {
	if (opts.json) routeLogsToStderr();
	const cfg = loadConfig();
	const inputAbs = resolve(input);
	if (!existsSync(inputAbs)) throw new Error(`毛片不存在：${inputAbs}`);

	const projName = basename(inputAbs, extname(inputAbs));
	const formats = opts.formats.split(",").map((s) => s.trim()).filter(Boolean);
	if (!formats.includes("gtrk")) formats.push("gtrk"); // gtrk 是客户端主产物，恒产
	const wantJianying = formats.some((f) => f === "jianying" || f === "capcut");
	const outDir = resolve(opts.out ?? join(dirname(inputAbs), `${projName}-long2short`));
	const outName = basename(outDir);

	// 剪映草稿根 + 逐 clip 草稿目标：服务端按 struct_meta.nle_draft_dir 逐 clip 加 _clip{i} 后缀，
	// 故传「草稿根/<产物根同名>」为 base → 各 clip 草稿落 <草稿根>/<outName>_clip{i}（可读且不撞）
	let draftRoot: string | undefined;
	if (wantJianying) {
		draftRoot = resolveJianyingDraftDir(opts.jianyingDraftDir);
		if (draftRoot) log.info(`剪映草稿根：${draftRoot}`);
		else log.warn("没找到剪映草稿目录 → 将只产 draft_content.json、缺 meta。可加 --jianying-draft-dir <你的草稿目录> 重跑。");
	}
	const draftTarget = draftRoot ? join(draftRoot, outName) : undefined;

	log.step(
		`▶ 长剪短：${basename(inputAbs)}（${opts.splitScreen ? "720p 代理 · 智能分屏" : "纯选段 · 音频上传"}，格式 ${formats.join("/")}）`,
	);

	// ① 本地预处理：探原片几何 + 抽音频(缺省) / 压 720p 代理(--split-screen)。毛片永不上传。
	log.step("① 本地预处理（探几何 + 抽音频/720p 代理）…");
	const geo = probeGeometry(inputAbs, opts.ffmpegPath);
	log.info(`原片几何 ${geo.width}x${geo.height} @ ${geo.fps.toFixed(2)}fps · ${(geo.duration / 60).toFixed(1)}min`);
	const artifact = opts.splitScreen
		? await compress720p(inputAbs, opts.ffmpegPath)
		: await extractAudio(inputAbs, opts.ffmpegPath);
	assertDurationConsistent(geo.duration, artifact, opts.ffmpegPath);
	log.info(opts.splitScreen ? `已压 720p 代理（上传物）：${basename(artifact)}` : `已抽 16k 单声道 mp3（上传物）：${basename(artifact)}`);

	// ②a 可选：现成字幕作转写来源（先于主上传独立上传；扩展名先在本地拦，省一次白上传）
	let subtitleFileId: string | undefined;
	if (opts.subtitleFile) {
		const subAbs = resolve(opts.subtitleFile);
		if (!existsSync(subAbs)) throw new Error(`字幕文件不存在：${subAbs}`);
		const subExt = extname(subAbs).toLowerCase();
		if (subExt !== ".srt" && subExt !== ".ass") {
			throw new Error(`--subtitle-file 只接受单语 .srt/.ass，拿到「${subExt || "无扩展名"}」`);
		}
		const up = await uploadCached(cfg, subAbs, { force: opts.reupload });
		subtitleFileId = up.fileId;
		log.info(`${up.cached ? "命中上传缓存，复用" : "已上传"}字幕文件（转写来源，跳过云端 ASR）：${basename(subAbs)}`);
	}

	// ② 上传抽出物 → 提交（--language 必填在拼 payload 时前置校验，缺失零上传零提交）
	const payloadProbe = buildLong2ShortPayload("__dry_run__", opts, geo, inputAbs, formats, draftTarget, subtitleFileId);
	void payloadProbe; // 干跑一遍触发必填/数值校验；真实 payload 由下方闭包按 file_id 重拼
	log.step("② 上传抽出物到云端…");
	const submitted = await uploadAndSubmitTask(
		cfg,
		artifact,
		TASK_TYPE,
		(fid) => buildLong2ShortPayload(fid, opts, geo, inputAbs, formats, draftTarget, subtitleFileId),
		{
			force: opts.reupload,
			onUploaded: (uploaded) => {
				log.info(uploaded.cached ? `命中上传缓存，复用 file_id = ${uploaded.fileId}` : `file_id = ${uploaded.fileId}`);
				log.step("③ 提交长剪短任务…");
			},
			onCacheInvalid: () => log.warn("缓存的 file_id 在云端已失效，重新上传后重试…"),
		},
	);
	const { taskId, fileId } = { taskId: submitted.taskId, fileId: submitted.fileId };
	log.info(`task_id = ${taskId}`);
	await mkdir(outDir, { recursive: true });
	await writeFile(
		join(outDir, "task.json"),
		JSON.stringify(
			{ taskId, taskType: TASK_TYPE, fileId, source: inputAbs, formats, createdAt: new Date().toISOString() },
			null,
			2,
		),
	);

	// ④ 轮询到完成（60min 墙钟；超时凭 task.json 的 task_id 恢复）
	log.step("④ 云端处理中（选段/跳剪" + (opts.splitScreen ? "/分屏" : "") + "，每 5s 轮询）…");
	const output = (await pollToolTask(cfg, TASK_TYPE, taskId, {
		timeoutMs: POLL_TIMEOUT_MS,
		onTick: (status, progress) => log.tick(`${status}${progress != null ? ` ${Math.round(progress)}%` : ""}`),
	})) as OralCutOutput & { clips?: CloudClip[]; report?: { split_manifest?: SplitManifestItem[] } };
	log.tickEnd();

	const clips = output.clips ?? [];
	if (!clips.length) throw new Error("云端未产出任何高光短片（clips 为空），请查 report/errors");
	const errors: Record<string, string> = { ...((output.errors as Record<string, string>) ?? {}) };

	// ⑤ 分屏素材按 expected_path 落地（gtrk materials[].path 指向该处，先落素材、工程开箱即用）
	const manifest = output.report?.split_manifest ?? [];
	let splitLanded = 0;
	if (manifest.length) {
		log.step(`⑤ 拉回分屏素材（${manifest.length} 条 → 毛片旁 split_screen/）…`);
		for (const [i, item] of manifest.entries()) {
			let dest = item.expected_path;
			const url = item.download_url;
			if (!dest || !url) {
				errors[`split_manifest[${i}]`] = "缺 expected_path/download_url，已跳过";
				continue;
			}
			// 防御：老服务端曾对 Windows 路径产相对 expected_path（2026-08-06 E2E 实锤，infra 已修）——
			// 相对路径按契约语义落回毛片旁，不落 CWD
			if (!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(dest)) dest = join(dirname(inputAbs), dest);
			try {
				await mkdir(dirname(dest), { recursive: true });
				await download(url, dest);
				splitLanded++;
			} catch (e) {
				errors[`split:${basename(dest)}`] = e instanceof Error ? e.message : String(e);
				log.warn(`分屏素材下载失败（${basename(dest)}），对应工程中该素材将缺席`);
			}
		}
		if (splitLanded) log.info(`分屏素材已落：${splitLanded}/${manifest.length} 条`);
	}

	// ⑥ 逐 clip 落地（clip{i}/ 子目录：下载 gtrk/剪映/PR 工程组）；单 clip 失败记 errors 不连坐
	log.step(`⑥ 逐 clip 拉回三方工程（共 ${clips.length} 条）…`);
	const clipResults: Array<{
		dir: string;
		title?: string;
		files: Record<string, string[]>;
		ok: boolean;
		/** 该 clip 的剪映草稿目录（两件套齐全时为绝对路径，否则 null）——日志的「可见」声明的机读对应物。 */
		jianyingDraftPath?: string | null;
	}> = [];
	for (const [i, clip] of clips.entries()) {
		const clipDir = join(outDir, `clip${i}`);
		const { files: clipFiles, ...clipMeta } = clip;
		try {
			const r: MaterializeResult = await materializeResult({
				outDir: clipDir,
				output: { report: clipMeta, files: clipFiles ?? [], errors: {} } as OralCutOutput,
				taskId,
				fileId,
				projName: `${projName}-clip${i}`,
				json: false,
				open: false,
				quiet: true,
			});
			Object.assign(errors, Object.fromEntries(Object.entries(r.errors).map(([k, v]) => [`clip${i}:${k}`, v])));
			clipResults.push({ dir: clipDir, title: clip.title, files: r.files, ok: r.ok });
			log.info(`clip${i}${clip.title ? `「${clip.title}」` : ""}：${Object.keys(r.files).join("/") || "（无产物）"}`);
		} catch (e) {
			errors[`clip${i}`] = e instanceof Error ? e.message : String(e);
			clipResults.push({ dir: clipDir, title: clip.title, files: {}, ok: false });
			log.warn(`clip${i} 落地失败（不连坐其余）：${errors[`clip${i}`]}`);
		}
	}

	// ⑦ 剪映草稿逐 clip 拷入草稿根（目标名对齐服务端 nle_draft_dir 的 _clip{i} 后缀约定；
	//   文件名落成剪映固定两件套，否则草稿目录建了也扫不到）。日志按实际齐全条数说话——
	//   原实现无条件打「剪映里直接可见」，正是这枚静默失败从真机 E2E 底下溜走的直接原因。
	if (draftRoot && draftTarget) {
		const landing = await copyClipDraftsToRoot(clipResults.map((c) => c.dir), draftTarget, errors);
		landing.paths.forEach((p, i) => {
			clipResults[i].jianyingDraftPath = p;
		});
		const { complete, attempted } = landing;
		if (!attempted) log.warn("没有任何 clip 产出剪映草稿，草稿根未落地");
		else if (complete === attempted)
			log.info(`剪映草稿：<草稿根>/${outName}_clip{i} —— ${complete}/${attempted} 条两件套齐全（剪映里直接可见）`);
		else if (complete) {
			log.info(`剪映草稿：<草稿根>/${outName}_clip{i} —— ${complete}/${attempted} 条两件套齐全（剪映里可见）`);
			log.warn(`另有 ${attempted - complete} 条草稿两件套不全，剪映里不会显示（详见 result.json errors）`);
		} else log.warn(`${attempted} 条草稿两件套均不全，剪映里不会显示（详见 result.json errors）`);
	}

	// ⑧ 人读简报（纯增文件：clip{i}/clip.md + 根 clips.md；机读契约不动）。失败只记 errors 不阻断
	for (const [i, cr] of clipResults.entries()) {
		try {
			await mkdir(cr.dir, { recursive: true });
			await writeFile(join(cr.dir, "clip.md"), renderClipBrief(clips[i], i, cr.files));
		} catch (e) {
			errors[`clip${i}:brief`] = e instanceof Error ? e.message : String(e);
		}
	}
	try {
		await writeFile(
			join(outDir, "clips.md"),
			renderClipsOverview(clips, {
				source: inputAbs,
				jumpCut: opts.jumpCut !== false,
				splitMaterials: { landed: splitLanded, total: manifest.length },
				taskId,
			}),
		);
		log.info(`总览已生成：clips.md（逐条见 clip{i}/clip.md）`);
	} catch (e) {
		errors["clips.md"] = e instanceof Error ? e.message : String(e);
	}

	// ⑨ 根级 report.json + result.json（恒落盘）
	await writeFile(join(outDir, "report.json"), JSON.stringify(output.report ?? {}, null, 2));
	const ok = Object.keys(errors).length === 0 && clipResults.some((c) => c.ok);
	const rootResult = {
		ok,
		tool: "long2short",
		taskType: TASK_TYPE,
		taskId,
		fileId,
		outDir,
		clips: clipResults,
		splitMaterials: { landed: splitLanded, total: manifest.length },
		reportFile: join(outDir, "report.json"),
		...(Object.keys(errors).length ? { errors } : {}),
	};
	await writeFile(join(outDir, "result.json"), JSON.stringify({ ...rootResult, finishedAt: new Date().toISOString() }, null, 2));

	if (opts.json) console.log(JSON.stringify(rootResult));
	if (opts.open) {
		openFolder(outDir);
		log.info("已打开产物根目录");
	}
	if (!ok) {
		log.err("部分产物未落地（任务已完成、积分可能已扣）。task.json 已保留，可凭 task_id 恢复取回。");
		process.exitCode = 1;
		return;
	}
	log.ok(`闭环完成：${clips.length} 条高光短片。产物根：${outDir}`);
}
