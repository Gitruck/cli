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
import { mkdir, readdir, rmdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadConfig } from "../lib/config";
import { download, type OralCutOutput } from "../lib/cloud";
import { uploadAndSubmitTask } from "../lib/upload-submit";
import { uploadCached } from "../lib/upload-cache";
import { claimRecordedDraft, copyJianyingDraft, resolveJianyingDraftDir, samePath } from "../lib/jianying";
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
import { materializeResult, type LandingCheck, type MaterializeResult } from "../lib/materialize";
import { renderClipBrief, renderClipsOverview } from "../lib/clip-brief";
import { pollToolTask, parseExtraParams, mergeParams, createOutDir } from "../lib/tool-runner";
import { openFolder } from "../lib/open";
import { log, routeLogsToStderr } from "../lib/log";
import { emitBillingHint, resolveDurationPricing, resolveToolPricing, type PriceResolver } from "../lib/tool-pricing";

// cli 域特例：cloud.ts 的 /task/${taskType} 模板天然拼出 /task/cli/video_long2short_for_cli
const TASK_TYPE = "cli/video_long2short_for_cli";
// 价格表 key 取产品主条（fix-oralcut-long2short-price-line D1）：CLI 渠道分账条 video_long2short_for_cli
// （gc_task_type id 47）show_in_price_list=0、不在公开价格表里；扣费按渠道条自身那一行，
// 二者同价靠 infra「同产品同计费」的约定维持，没有机制保证——价格行恒带「以服务端结算为准」。
const PRICE_KEY = "video_long2short";
const PRICING_CONTEXT = "长剪短（按上传物时长）";
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
	/** 整体调速倍率（link-long2short-for-cli-speed）：0.5–2.0、保音高，云端写进逐 clip 工程、不渲染。 */
	speedFactor?: string;
	/** 运镜（link-long2short-for-cli-camera-move）：云端把推 / 拉镜头写成主轨片段的缩放关键帧；细项走 --params-json。 */
	cameraMove?: boolean;
	out?: string;
	ffmpegPath?: string;
	param: string[];
	paramsJson?: string;
	reupload?: boolean;
	open?: boolean;
	json?: boolean;
	dryRun?: boolean;
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
 * 可注入的前置区依赖（缺省 = 真实实现），形状对齐 `transcript.ts` 的 `TranscriptDeps` 惯例。
 *
 * 只覆盖「读配置 → 探几何 → 抽取 → 字幕上传」这一段：零成本前置校验区一旦拦下，后面的云端交互
 * 根本不会发生，故离线测试只需替换这几个，就能把「零抽取零上传」证成**调用次数为 0**，
 * 而不是只证「抛了个错」（add-pre-upload-duration-gate tasks §2.3）。
 */
export interface Long2ShortDeps {
	loadConfig: typeof loadConfig;
	probe: typeof probeGeometry;
	extract: typeof extractAudio;
	compress: typeof compress720p;
	uploadSubtitle: typeof uploadCached;
	/** 上传提交与轮询（fix-long2short-dub-export-draft-collision 2.1）：离线测试据此走过提交，验草稿占位与面包屑。 */
	uploadAndSubmit: typeof uploadAndSubmitTask;
	poll: typeof pollToolTask;
	/** 实时价格解析（缺省真 `resolveToolPricing`，匿名查公开价格表）。离线测试注入它，单测才不会真打线上接口。 */
	resolvePricing: PriceResolver;
}

function buildDeps(o: Partial<Long2ShortDeps> = {}): Long2ShortDeps {
	return {
		loadConfig: o.loadConfig ?? loadConfig,
		probe: o.probe ?? probeGeometry,
		extract: o.extract ?? extractAudio,
		compress: o.compress ?? compress720p,
		uploadSubtitle: o.uploadSubtitle ?? uploadCached,
		uploadAndSubmit: o.uploadAndSubmit ?? uploadAndSubmitTask,
		poll: o.poll ?? pollToolTask,
		resolvePricing: o.resolvePricing ?? resolveToolPricing,
	};
}

/** 草稿组锚点：服务端给基名逐 clip 拼 `_clip{i}`，`_clip0` 是每次运行一定有的那一条（clips 为空直接报错）。 */
const CLIP_ANCHOR = "_clip0";

/**
 * 定下本次的剪映草稿组基名（fix-long2short-dub-export-draft-collision D1/D2，导出供离线测试）。
 *
 * 草稿根是所有毛片共用的一层目录，`<产物根名>` 不带毛片所在目录、也没有时间戳——不同目录的同名毛片先后跑就会撞，
 * 后跑的整组覆盖先跑的，两次条数不同时还会剩下一组两条毛片混在一起的 `_clip{i}`。但同一毛片重跑覆盖是幂等设计，要保留：
 * - 认领：产物根上一次的 task.json 的 `source` 就是本毛片、`jianyingDraftBase` 在本次草稿根下 ⇒ 沿用，照旧覆盖；
 * - 否则以 `<基名>_clip0` 为整组锚点原子仲裁（createOutDir 非递归 mkdir，撞名 `<产物根名>-2`…），
 *   锚点建成后草稿根里还有同基名的 `_clip{k≥1}` 残留就放掉、换下一个（并发对手要先拿到同一锚点才可能写这一组，故扫描不需要原子）。
 * 名字必须在提交前定下：它就是 `nle_draft_dir`，服务端据此写各 clip 草稿 meta。
 * `created` = 锚点是本次新建的（提交前失败、或 clip0 最终没落成草稿时只删这种）。
 */
export async function settleClipDraftBase(
	draftRoot: string,
	outDir: string,
	inputAbs: string,
): Promise<{ base: string; created: boolean }> {
	// 显式 --jianying-draft-dir 可以指向尚不存在的目录（原先由落地时的 recursive mkdir 顺手建出），非递归仲裁前先补上
	await mkdir(draftRoot, { recursive: true });
	const claimed = await claimRecordedDraft({
		outDir,
		draftRoot,
		key: "jianyingDraftBase",
		match: (crumb) => typeof crumb.source === "string" && samePath(crumb.source, inputAbs),
		suffix: CLIP_ANCHOR,
	});
	if (claimed) return { base: claimed.path, created: claimed.created };
	const anchor = await createOutDir(join(draftRoot, basename(outDir)), true, "剪映草稿组", {
		suffix: CLIP_ANCHOR,
		shown: "_clip*",
		accept: async (base) => !(await hasStrayClipDrafts(draftRoot, basename(base))),
	});
	return { base: anchor.slice(0, -CLIP_ANCHOR.length), created: true };
}

/** 草稿根里是否还有 `<基名>_clip{k}`（k ≥ 1）残留——锚点空着而组员还在（如用户在剪映里只删了第一条）。 */
async function hasStrayClipDrafts(draftRoot: string, baseName: string): Promise<boolean> {
	const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
	const want = fold(baseName);
	for (const name of await readdir(draftRoot)) {
		const m = /^(.*)_clip(\d+)$/.exec(name);
		if (m && fold(m[1]!) === want && Number(m[2]) !== 0) return true;
	}
	return false;
}

/** 调速倍率取值范围：与 infra `video_long2short/polish.py` 的 `SPEED_FACTOR_RANGE`、精剪 `speed.factor` 同值。 */
export const SPEED_FACTOR_RANGE = [0.5, 2.0] as const;

/** 超限报错的尾句：分段之后该干什么（长剪短侧 = 各段 clip 汇总成一张选题清单）。 */
const DURATION_LIMIT_HINT = {
	command: "long2short",
	afterward: "各段产出的 clip 可事后汇总成一张选题清单（分段是常态动作，不是降级方案）。",
} as const;

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
	// 调速（link-long2short-for-cli-speed）：缺省 / 传 1 时零注入（payload 不含 speed 键）
	if (opts.speedFactor != null) {
		const n = Number(opts.speedFactor);
		const [lo, hi] = SPEED_FACTOR_RANGE;
		if (!Number.isFinite(n) || n < lo || n > hi) {
			throw new Error(`--speed-factor 取值 ${lo}–${hi}（保音高，写进工程），拿到「${opts.speedFactor}」；更高倍率请在客户端对具体片段拖边变速`);
		}
		if (n !== 1) p.speed = { factor: n };
	}
	// 运镜：只传开关，不传即零注入（payload 不含 camera_move 键）；细项（概率 / 幅度 …）经 --params-json 覆盖
	if (opts.cameraMove) p.camera_move = { enable: true };
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

/**
 * 根级 `files[]` 中的 transcript 条目 → `<outDir>/json/transcript.json`（导出供离线测试）。
 * 返回落地路径；没有条目返回 undefined（老服务端），下载失败记 `errors.transcript` 并返回 undefined。
 */
export async function landTranscript(
	files: Array<{ type?: string; download_url?: string }>,
	outDir: string,
	errors: Record<string, string>,
	dl: (url: string, dest: string) => Promise<unknown> = download,
): Promise<string | undefined> {
	const item = files.find((f) => f.type === "transcript" && f.download_url);
	if (!item?.download_url) {
		log.info("本次服务端没有返回整片 transcript，无法自动上字幕（需要新版服务端）");
		return undefined;
	}
	const dest = join(outDir, "json", "transcript.json");
	try {
		await mkdir(dirname(dest), { recursive: true });
		await dl(item.download_url, dest);
		log.info(`整片 transcript 已落：json/transcript.json（上字幕用 gtrk subtitle lay --transcript）`);
		return dest;
	} catch (e) {
		errors.transcript = e instanceof Error ? e.message : String(e);
		log.warn(`整片 transcript 下载失败：${errors.transcript}`);
		return undefined;
	}
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
		.option("--speed-factor <n>", "整体调速倍率 0.5–2.0（保音高；倍率写进逐 clip 工程、云端不渲染、不加价；缺省不调速）")
		.option("--camera-move", "运镜：云端按概率给主轨片段写推 / 拉镜头关键帧（客户端 / 剪映可见可改，本地渲染与 PR 不呈现；缺省不加）")
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
		.option("--dry-run", "只探测并报价（实时价格 + 本次预估）：零抽取、零上传、零计费，不建任何目录")
		.action(async (input: string, opts: Long2ShortOpts) => {
			await runLong2Short(input, opts);
		});
}

export async function runLong2Short(
	input: string,
	opts: Long2ShortOpts,
	overrides: Partial<Long2ShortDeps> = {},
): Promise<void> {
	if (opts.json) routeLogsToStderr();
	const deps = buildDeps(overrides);
	const cfg = deps.loadConfig();
	const inputAbs = resolve(input);
	if (!existsSync(inputAbs)) throw new Error(`毛片不存在：${inputAbs}`);

	const projName = basename(inputAbs, extname(inputAbs));
	const formats = opts.formats.split(",").map((s) => s.trim()).filter(Boolean);
	if (!formats.includes("gtrk")) formats.push("gtrk"); // gtrk 是客户端主产物，恒产
	const wantJianying = formats.some((f) => f === "jianying" || f === "capcut");
	const outDir = resolve(opts.out ?? join(dirname(inputAbs), `${projName}-long2short`));
	const outName = basename(outDir);

	// 剪映草稿根 + 逐 clip 草稿目标：服务端按 struct_meta.nle_draft_dir 逐 clip 加 _clip{i} 后缀，
	// 故传「草稿根/<基名>」→ 各 clip 草稿落 <草稿根>/<基名>_clip{i}。基名缺省 = 产物根名，
	// 在 ①b 定下（同一毛片重跑认领上次的、别的毛片撞名改 -2…）；此处的候选值只供 ①a 必填干跑。
	let draftRoot: string | undefined;
	if (wantJianying) {
		draftRoot = resolveJianyingDraftDir(opts.jianyingDraftDir);
		if (draftRoot) log.info(`剪映草稿根：${draftRoot}`);
		else log.warn("没找到剪映草稿目录 → 将只产 draft_content.json、缺 meta。可加 --jianying-draft-dir <你的草稿目录> 重跑。");
	}
	let draftTarget = draftRoot ? join(draftRoot, outName) : undefined;

	log.step(
		`▶ 长剪短：${basename(inputAbs)}（${opts.splitScreen ? "720p 代理 · 智能分屏" : "纯选段 · 音频上传"}，格式 ${formats.join("/")}）`,
	);

	// ① 本地预处理：探原片几何 → 零成本前置校验区 → 抽音频(缺省) / 压 720p 代理(--split-screen)。
	//    毛片永不上传。
	log.step("① 本地预处理（探几何 + 抽音频/720p 代理）…");
	const geo = deps.probe(inputAbs, opts.ffmpegPath);
	log.info(`原片几何 ${geo.width}x${geo.height} @ ${geo.fps.toFixed(2)}fps · ${(geo.duration / 60).toFixed(1)}min`);
	// ①0 帧率门 + VFR 可见（add-frame-rate-table-vfr-detect D4/D5，与 oralcut 同款）：帧率解析不到 ⇒ 上传前报错退出
	//   （零抽取、零上传、outDir 未建）；VFR ⇒ WARN 一行不阻断，payload 的 video_rate 仍是真实 r_frame_rate，机读见 --json source.vfr。
	assertSourceFrameRate(geo);
	const vfrWarn = vfrNotice(geo);
	if (vfrWarn) log.warn(vfrWarn);

	// ①a 零成本前置校验区（add-pre-upload-duration-gate）——本区 MUST 排在**任何抽取与上传之前**：
	//   区内三项都只花本地几毫秒，而它们要拦的失败在服务端一律是「建单期硬拒」，
	//   排在抽取之后就等于先花几分钟转码、再传几百 MB，然后才知道不行（2026-08-26 真机实证）。
	//   ⚠️ 原实现把必填干跑排在抽取**与字幕上传之后**（`--subtitle-file` 那一跳真会白传一次），
	//      与本命令 spec「缺失在上传前报错、零上传零提交」不符——本次一并归位，别再挪回去。
	//   ① 时长硬闸：服务端全局 2h 上限的本地镜像（判据严格大于，同构服务端）
	assertWithinMediaDurationLimit(geo.duration, DURATION_LIMIT_HINT);
	//   ② 字幕入参的存在性与扩展名（内容合法性归服务端）
	const subAbs = opts.subtitleFile ? resolve(opts.subtitleFile) : undefined;
	if (subAbs) {
		if (!existsSync(subAbs)) throw new Error(`字幕文件不存在：${subAbs}`);
		const subExt = extname(subAbs).toLowerCase();
		if (subExt !== ".srt" && subExt !== ".ass") {
			throw new Error(`--subtitle-file 只接受单语 .srt/.ass，拿到「${subExt || "无扩展名"}」`);
		}
	}
	//   ③ 必填/数值干跑（--language 必填、--max-clip-sec 有限数值、--speed-factor 范围）：拿假 file_id 拼一遍触发校验。
	//      subtitle_file_id 此刻尚未上传得到，传 undefined 不影响这两项校验。
	void buildLong2ShortPayload("__dry_run__", opts, geo, inputAbs, formats, draftTarget, undefined);

	// ①a′ 零计费报价（fix-oralcut-long2short-price-line D5）：校验类的闸跑完就分叉，查价打一行后返回。
	//   不进 ①b（草稿组定名会建锚点目录）、不抽取、不传字幕、不建产物目录——dry-run 的定义就是什么都不写。
	if (opts.dryRun) {
		const quote = await resolveDurationPricing(PRICE_KEY, geo.duration, PRICING_CONTEXT, deps.resolvePricing);
		emitBillingHint(quote.billingHint);
		log.ok("[dry-run] 只探测与报价：零抽取、零上传、零提交、零计费，未建任何目录。");
		if (opts.json) {
			console.log(JSON.stringify({ ok: true, dry_run: true, source: sourceRateInfo(inputAbs, geo), duration: geo.duration, pricing: quote.pricing }));
		}
		return;
	}

	// ①b 定下剪映草稿组基名（fix-long2short-dub-export-draft-collision）——零成本前置区的最后一步、任何抽取之前：
	//   它就是 nle_draft_dir，服务端据此写各 clip 草稿 meta，名字必须在提交前定下；建目录失败（权限等）也在花时间抽取前暴露。
	let anchorCreated = false; // 锚点 <基名>_clip0 是本次新建的：提交前失败、或 clip0 最终没落成草稿时只删这种
	if (draftRoot) {
		const settled = await settleClipDraftBase(draftRoot, outDir, inputAbs);
		draftTarget = settled.base;
		anchorCreated = settled.created;
	}
	const anchor = draftTarget ? `${draftTarget}${CLIP_ANCHOR}` : undefined;

	// ①c 实时价格行（fix-oralcut-long2short-price-line D2）——零成本前置区真正的最后一步、任何抽取与字幕上传之前：
	//   排在所有会拒单的闸之后（被拒的运行不发请求），排在抽取之前（看到价格还来得及 Ctrl-C，零上传零计费）。
	//   查不到 / 超时只降级为「实时价格暂不可用」、永不抛错，不会让 ①b 刚建的锚点成孤儿。
	const quote = await resolveDurationPricing(PRICE_KEY, geo.duration, PRICING_CONTEXT, deps.resolvePricing);
	emitBillingHint(quote.billingHint);

	// 从定名到提交返回的整段：任何一步失败都删掉本次新建的空锚点（非递归，宁留勿误删）再上抛；认领沿用的一律不删
	let submitted: Awaited<ReturnType<typeof uploadAndSubmitTask>>;
	try {
		const artifact = opts.splitScreen
			? await deps.compress(inputAbs, opts.ffmpegPath)
			: await deps.extract(inputAbs, opts.ffmpegPath);
		assertDurationConsistent(geo.duration, artifact, opts.ffmpegPath);
		log.info(opts.splitScreen ? `已压 720p 代理（上传物）：${basename(artifact)}` : `已抽 16k 单声道 mp3（上传物）：${basename(artifact)}`);

		// ②a 可选：现成字幕作转写来源（先于主上传独立上传；存在性/扩展名已在 ①a 拦过，此处只上传）
		let subtitleFileId: string | undefined;
		if (subAbs) {
			const up = await deps.uploadSubtitle(cfg, subAbs, { force: opts.reupload });
			subtitleFileId = up.fileId;
			log.info(`${up.cached ? "命中上传缓存，复用" : "已上传"}字幕文件（转写来源，跳过云端 ASR）：${basename(subAbs)}`);
		}

		// ② 上传抽出物 → 提交（必填/数值校验已在 ①a 前置完成，缺失零抽取零上传零提交）
		log.step("② 上传抽出物到云端…");
		submitted = await deps.uploadAndSubmit(
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
	} catch (e) {
		if (anchorCreated && anchor) await rmdir(anchor).catch(() => undefined);
		throw e;
	}
	const { taskId, fileId } = { taskId: submitted.taskId, fileId: submitted.fileId };
	log.info(`task_id = ${taskId}`);
	await mkdir(outDir, { recursive: true });
	await writeFile(
		join(outDir, "task.json"),
		JSON.stringify(
			{
				taskId,
				taskType: TASK_TYPE,
				fileId,
				source: inputAbs,
				formats,
				// 本次的剪映草稿组基名：同一毛片下次重跑据此认领、照旧覆盖（别的毛片撞名则改 -2…）
				...(draftTarget ? { jianyingDraftBase: draftTarget } : {}),
				createdAt: new Date().toISOString(),
			},
			null,
			2,
		),
	);

	// ④ 轮询到完成（60min 墙钟；超时凭 task.json 的 task_id 恢复）
	log.step("④ 云端处理中（选段/跳剪" + (opts.splitScreen ? "/分屏" : "") + "，每 5s 轮询）…");
	const output = (await deps.poll(cfg, TASK_TYPE, taskId, {
		timeoutMs: POLL_TIMEOUT_MS,
		onTick: (status, progress) => log.tick(`${status}${progress != null ? ` ${Math.round(progress)}%` : ""}`),
	})) as OralCutOutput & {
		clips?: CloudClip[];
		report?: { split_manifest?: SplitManifestItem[]; transcript_word_timing?: string };
	};
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
		/** 落地复核（add-cross-clock-adapter D5）：该 clip 的 gtrk 对本地原片实测时长的不变量报告；gtrk 未落盘时缺席。 */
		landing_check?: LandingCheck;
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
				// 落地复核之墙（D5）：上传前探得的原片实测时长（source_container 钟）；逐 clip 报告、只报告不改产物
				landingWall: { sourcePath: inputAbs, durationSec: geo.duration },
			});
			Object.assign(errors, Object.fromEntries(Object.entries(r.errors).map(([k, v]) => [`clip${i}:${k}`, v])));
			clipResults.push({ dir: clipDir, title: clip.title, files: r.files, ok: r.ok, ...(r.landing_check ? { landing_check: r.landing_check } : {}) });
			log.info(`clip${i}${clip.title ? `「${clip.title}」` : ""}：${Object.keys(r.files).join("/") || "（无产物）"}`);
		} catch (e) {
			errors[`clip${i}`] = e instanceof Error ? e.message : String(e);
			clipResults.push({ dir: clipDir, title: clip.title, files: {}, ok: false });
			log.warn(`clip${i} 落地失败（不连坐其余）：${errors[`clip${i}`]}`);
		}
	}

	// ⑥b 整片源时基 transcript（link-long2short-for-cli-transcript）：落 <产物根>/json/transcript.json
	//    （与 oralcut 物化按格式分组的 json/ 同口径），供 `gtrk subtitle lay --transcript` 给入选 clip 上字幕。
	//    失败记 errors.transcript、不中止；老服务端没给就一行说明，不报错。
	const transcriptFile = await landTranscript(output.files ?? [], outDir, errors);

	// ⑦ 剪映草稿逐 clip 拷入草稿根（目标名对齐服务端 nle_draft_dir 的 _clip{i} 后缀约定；
	//   文件名落成剪映固定两件套，否则草稿目录建了也扫不到）。日志按实际齐全条数说话——
	//   原实现无条件打「剪映里直接可见」，正是这枚静默失败从真机 E2E 底下溜走的直接原因。
	if (draftRoot && draftTarget) {
		const landing = await copyClipDraftsToRoot(clipResults.map((c) => c.dir), draftTarget, errors);
		landing.paths.forEach((p, i) => {
			clipResults[i].jianyingDraftPath = p;
		});
		const { complete, attempted } = landing;
		const draftName = basename(draftTarget);
		if (!attempted) log.warn("没有任何 clip 产出剪映草稿，草稿根未落地");
		else if (complete === attempted)
			log.info(`剪映草稿：<草稿根>/${draftName}_clip{i} —— ${complete}/${attempted} 条两件套齐全（剪映里直接可见）`);
		else if (complete) {
			log.info(`剪映草稿：<草稿根>/${draftName}_clip{i} —— ${complete}/${attempted} 条两件套齐全（剪映里可见）`);
			log.warn(`另有 ${attempted - complete} 条草稿两件套不全，剪映里不会显示（详见 result.json errors）`);
		} else log.warn(`${attempted} 条草稿两件套均不全，剪映里不会显示（详见 result.json errors）`);
		// 本次新建的锚点 _clip0 最终没落成草稿（clip0 没有剪映产物）⇒ 仍为空就删掉，不在草稿根留空壳（非递归，有东西就删不掉）
		if (anchorCreated && anchor && !landing.paths[0]) await rmdir(anchor).catch(() => undefined);
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
				errors,
				transcriptWordTiming: output.report?.transcript_word_timing,
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
		...(transcriptFile ? { transcriptFile } : {}),
		// 源片帧率账面（add-frame-rate-table-vfr-detect D4）：上传前探得的 r / avg / vfr，机读对应上传前那条 VFR WARN
		source: sourceRateInfo(inputAbs, geo),
		// 跑前查到的实时价格与预估（fix-oralcut-long2short-price-line D4）：agent 不读 stderr 也能转述
		pricing: quote.pricing,
		// 落地复核汇总（D5）：逐 clip 明细在 clips[i].landing_check，这里只给一眼能看的总数（不改退出码）
		landing_check: {
			clips_checked: clipResults.filter((c) => c.landing_check && !c.landing_check.error).length,
			violations: clipResults.reduce((n, c) => n + (c.landing_check?.violations.length ?? 0), 0),
		},
		...(Object.keys(errors).length ? { errors } : {}),
	};
	await writeFile(join(outDir, "result.json"), JSON.stringify({ ...rootResult, finishedAt: new Date().toISOString() }, null, 2));

	if (opts.json) console.log(JSON.stringify(rootResult));
	if (opts.open) {
		openFolder(outDir);
	}
	if (!ok) {
		log.err("部分产物未落地（任务已完成、积分可能已扣）。task.json 已保留，可凭 task_id 恢复取回。");
		process.exitCode = 1;
		return;
	}
	log.ok(`闭环完成：${clips.length} 条高光短片。产物根：${outDir}`);
}
