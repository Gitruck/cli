/**
 * gtrk matrix —— B-roll 检索（Wave2 Change C + add-matrix-local-search 第三路）。
 *
 * 三模式（沿 split 的「顶层命令 + 可选 positional」范式，避免父子命令吞选项）：
 *   - `gtrk matrix --project <dir>`        派单消费：读 split/dispatch.json 的 film_broll 队列 → split/broll-plan.json
 *   - `gtrk matrix search "<query>"`       ad-hoc 检索：同路由同注入，--out 落文件 / 缺省 stdout
 *   - `gtrk matrix index --dirs <a,b,...>` 本地素材免切片索引（场景边界 → 自适应抽帧 → 自建端点 embed → SQLite）
 *
 * 云端双口：身份路由每次运行探一次（不缓存不降级）；栏目配置只在 internal 口注入；单 query 失败局部化。
 * 本地第三路（--local）：显式开关 + 必带 --dirs；**跳过身份探针**、不触任何云端检索端点；
 * 检索域用户可见、本地与云端结果绝不静默混合；与仅云端语义的参数（--column/--material-class）互斥。
 */
import type { Command } from "commander";
import { resolve, join, dirname, basename } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../lib/config";
import { readUserConfig } from "../lib/user-config";
import { resolveColumnConfig } from "../lib/column-config";
import { readGtrk, assertGtrkV1, writeGtrkAtomic } from "../lib/gtrk-writeback";
import {
	BROLL_COVER_DIR,
	BROLL_META_CANDIDATE_CAP,
	BROLL_PREVIEW_DIR,
	CUT_ALIGN_DEFAULT,
	SCORE_FLOOR_DEFAULT,
	brollMaterialIdFor,
	layBrollTracks,
	mergedCandidates,
	planBeatFills,
	previewUrlFor,
	projectHasShieldTrack,
	type DedupScope,
	type DownloadedProxy,
	type FillSlot,
	type GapFillMode,
	type MarkLookup,
	type SourceLayer,
} from "../lib/matrix-lay";
import {
	BROLL_MOVE_DIR,
	IMAGE_MOVE_CONCURRENCY,
	IMAGE_MOVE_CREDITS_PER_IMAGE,
	generateImageMoveAsset,
	imageHash16FromClipId,
	imageMoveDurationForSlot,
	imageMoveMaterialId,
	imageMoveParamFingerprint,
	imageMoveRelPath,
	imageStaticMaterialId,
	type ImageMoveParams,
} from "../lib/image-move";
import { probeGeometry } from "../lib/media";
import { uploadCached, invalidateUpload } from "../lib/upload-cache";
import { submitTask, getTaskResult } from "../lib/cloud";
import type { CloudFileTaskDeps } from "../lib/tool-runner";
import { BLACK_BED_HEX, encodeSolidPng, solidRelPath } from "../lib/solid-png";
import {
	reportMaterialIntegrity,
	safeCheckMaterialIntegrity,
	type IntegrityReport,
} from "../lib/material-integrity";
import type { Dispatch, FilmDispatch } from "../lib/splitdoc";
import {
	reportReprojection,
	reprojectDispatchWindows,
	withTimecodeSource,
	type ReprojectResult,
} from "../lib/reproject";
import {
	anchorAtSec,
	buildPlan,
	buildPlanBeat,
	buildSearchBody,
	isLocalPlanResult,
	probeGcMemberType,
	probeMemberType,
	searchOnce,
	validatePlanForLay,
	type BrollPlan,
	type PlanAnchor,
	type QueryOutcome,
	type SearchRespData,
	type Tier,
} from "../lib/matrix";
import type { PlanResult } from "../lib/matrix";
import {
	describeImages,
	getNearestCachedMark,
	resolveDescribeUrl,
	runDescribeItems,
	toDescribeMeta,
	type DescribeWorkItem,
	type MaterialDescribe,
} from "../lib/describe";
import { tmpDir } from "../lib/paths";
import {
	BALANCE_INSUFFICIENT_CODE,
	EMBED_CREDITS_PER_IMAGE,
	EMBED_UNREACHABLE_CODE,
	QUOTA_INSUFFICIENT_CODE,
	closeEmbedSession,
	embedInputs,
	openEmbedSession,
	resolveEmbedUrl,
	type EmbedEndpoint,
} from "../lib/embed-client";
import { CloudError, cloudErrorCode } from "../lib/cloud";
import {
	SCENE_THRESHOLD_DEFAULT,
	STABILITY_THRESHOLD_DEFAULT,
	brollLocalIdForFile,
	detectScenes,
	extractFrameJpg,
	indexLocalMaterials,
	localIndexDbPath,
	materialKindForPath,
	openLocalIndexDb,
	type IndexRunResult,
	type IndexSessionHooks,
} from "../lib/local-index";
import { loadLocalIndex, searchLoadedIndex, type LoadedIndex } from "../lib/local-search";
import { requireFfmpeg, resolveFfmpeg } from "../lib/ffmpeg";
import { log, routeLogsToStderr } from "../lib/log";

interface MatrixOpts {
	project?: string;
	dispatch?: string;
	column?: string;
	topK?: string;
	materialClass?: string;
	lay?: string;
	scoreFloor?: string;
	out?: string;
	json?: boolean;
	/** commander `--no-black-bed` → 缺省 true，传参即 false。 */
	blackBed?: boolean;
	/** `--force-relay`：候选轨已被用户编辑时仍强制剥离重铺（②-B 拒铺的逃生门）。 */
	forceRelay?: boolean;
	// ── 本地第三路（add-matrix-local-search）──
	/** `--local`：本地索引检索模式（显式开关，跳过身份探针，不触任何云端检索端点）。 */
	local?: boolean;
	/** `--dirs a,b`：本地素材文件夹（index 的索引范围 / --local 的检索域）。 */
	dirs?: string;
	/** `--scene-threshold`：matrix index 场景检测阈值（默认 0.3）。 */
	sceneThreshold?: string;
	/** `--stability-threshold`：matrix index 场景稳定性判定阈值（默认 0.05，保守值待标定）。 */
	stabilityThreshold?: string;
	/** `--rebuild`：matrix index 忽略指纹强制全量重建。 */
	rebuild?: boolean;
	// ── 图片候选（add-matrix-local-image-broll）──
	/** commander `--no-image-broll` → 缺省 true，传参即 false：检索与铺轨完全排除图片候选（零图片上云）。 */
	imageBroll?: boolean;
	/** `--yes`：跳过图片运镜生成前的积分预估确认。 */
	yes?: boolean;
	// ── 去重（add-broll-dedup-and-layering）──
	/** `--dedup-scope scene|material`：铺轨去重粒度（缺省 scene）。 */
	dedupScope?: string;
	// ── describe / 时间窗 / plan 编辑通路（add-matrix-describe-and-window）──
	/** `--plan <path>`：matrix describe 的注入目标 plan / matrix lay 显式指定要消费的 plan 文件。 */
	plan?: string;
	/** `--materials <a,b,...>`：matrix describe 直接理解素材文件（视频按场景抽帧、图片直传）。 */
	materials?: string;
	/** `--source-window <start,end>`：--local 检索源时间窗过滤（秒；段级交集）。 */
	sourceWindow?: string;
	// ── 美观度权重（add-audio-project-atoms，仅 matrix lay）──
	/** `--mark-weight <0..1>`：融合分 = sim×(1-w)+(mark/100)×w；默认 0 零回归。 */
	markWeight?: string;
	// ── 句界吸附（adjust-shot-cut-sentence-align）──
	/** `--cut-align <ratio>`：字幕句起点吸附目标比例（默认 0.7；0=关闭回旧节奏切槽）。 */
	cutAlign?: string;
	// ── 主轨 gap 填充（adjust-main-track-gap-fill）──
	/** `--gap-fill <fast|solid|none>`：音频驱动工程主轨空洞填充（缺省 solid）。 */
	gapFill?: string;
}

/** 测试注入面（MUST NOT 真调云端）：图片运镜生成与计费确认；缺省 = 真实云链 / stdin 确认。
 * describe 注入面（add-matrix-describe-and-window）：服务端批调用 / 抽帧 / 豁免探测 / 视频场景抽帧计划。 */
export interface MatrixRunDeps {
	generateImageMove?: (args: { imageAbs: string; destAbs: string; params: ImageMoveParams }) => Promise<void>;
	confirm?: (msg: string) => Promise<boolean>;
	/** describe 服务端批调用替身（缺省 = describeImages 真端点）。 */
	describeBatch?: (imagesBase64: string[]) => Promise<MaterialDescribe[]>;
	/** 抽帧替身（缺省 = requireFfmpeg + extractFrameJpg）。 */
	extractFrame?: (src: string, tsSec: number, outJpg: string) => Promise<boolean>;
	/** internal 豁免探测替身（缺省 = probeGcMemberType，失败按非豁免）。 */
	probeExempt?: () => Promise<boolean>;
	/** --materials 视频形态的场景抽帧计划替身（缺省 = probeGeometry + detectScenes 场景中点）。 */
	videoSceneFrames?: (path: string) => Promise<{ materialId: string; frameTsSec: number[] }>;
}

export function registerMatrix(program: Command): void {
	program
		.command("matrix [words...]")
		.description(
			"B-roll 检索：无 positional=消费 split/dispatch.json 的 film_broll 队列产候选清单；`matrix search \"<query>\"`=单条 ad-hoc 检索；`matrix index --dirs <a,b>`=本地素材索引；`matrix describe`=按需理解零件（plan 注入/素材文件）；`matrix lay`=消费（agent 编辑后的）plan 文件铺轨",
		)
		.option("--project <dir>", "oralcut 产物目录（定位 split/dispatch.json 与产物落点）")
		.option("--dispatch <path>", "显式指定 dispatch.json（非标准布局兜底）")
		.option("--column <id>", "栏目配置 id（缺省取 config defaultColumn，再缺省内置默认栏目；仅云端模式）")
		.option("--top-k <n>", "每 query 候选数上限（覆盖派单 shots 翻译；云端服务端上限 50）")
		.option("--material-class <c>", "素材类型 real_shot|concept（仅矩阵成员口；覆盖栏目 material_class_policy）")
		.option("--local", "本地检索模式：走本地素材索引检索（须配 --dirs；跳过身份探针，不触任何云端检索端点）")
		.option("--dirs <a,b,...>", "本地素材文件夹（逗号分隔）——matrix index 的索引范围 / --local 的检索域")
		.option("--scene-threshold <f>", "matrix index：场景切换检测阈值（ffmpeg select gt(scene,X)，默认 0.3）")
		.option(
			"--stability-threshold <f>",
			"matrix index：场景稳定性判定阈值——场景内最大帧间 scene score 低于此值判 stable（固定机位），抽帧收敛为中点 1 帧（默认 0.05，保守值待标定；误判 stable 丢检索粒度、误判 unstable 只是不省钱，宁严勿松）",
		)
		.option("--rebuild", "matrix index：忽略 size:mtime 指纹，强制全量重建索引")
		.option(
			"--plan <path>",
			"matrix describe：理解该 plan 的 top 候选并把产物写回 result.describe；matrix lay：显式指定要消费的 plan 文件（缺省 <project>/split/broll-plan.json）",
		)
		.option("--materials <a,b,...>", "matrix describe：直接理解素材文件（逗号分隔；视频按场景抽帧、图片直传）")
		.option(
			"--source-window <start,end>",
			"--local 检索：只返回与源时间窗（秒）有交集的命中段（段边界不裁剪；图片候选不参与；窗口无命中返回空结果非错误）",
		)
		.option(
			"--no-image-broll",
			"--local 模式：完全排除图片候选（不出检索结果、不进铺轨候选池、零图片上云）——图片候选默认参与，被选中时经云端 image_move 转运镜视频入轨（图片本体会上云做运镜）",
		)
		.option("--yes", "跳过交互确认（当前用于：图片运镜生成前的积分预估确认）")
		.option(
			"--dedup-scope <scope>",
			"铺轨去重粒度：scene=场景级（默认；同素材不同场景可分配，相邻槽位按跳剪豁免避让）| material=严格档（同一素材文件整轮只用一次）",
		)
		.option(
			"--mark-weight <w>",
			"仅 matrix lay：美观度权重 0..1（默认 0 关闭零回归）——候选融合分 = sim×(1-w)+(mark/100)×w，mark 取 describe 理解缓存（素材内就近帧）；无缓存候选按中性处理（融合分=sim，不惩罚不加分）",
		)
		.option(
			"--cut-align <ratio>",
			"句界吸附目标比例 0..1（默认 0.7）：约七成字幕句起点恰逢镜头切点、三成有意错开（全对齐会机械）；0=关闭回旧节奏切槽。" +
				"句级时码取 transcript 现场重投影（与关键词锚同源），重投影降级时自动回旧行为并告警",
		)
		.option(
			"--gap-fill <mode>",
			"音频驱动工程主轨空洞填充 fast|solid|none（缺省 solid）：fast=放宽 score 地板从候选池随便填、耗尽延长相邻颗粒、再不够垫黑片；" +
				"solid=黑片垫齐（精修时一眼看出「这里没匹配到」）；none=留 gap（客户端主轨磁吸开启时 gap 会被吸除、后续画面整体前移与配音错位，慎用）。" +
				"口播工程主轨为 A-roll，本参数不适用（照旧留空语义）",
		)
		.option("--lay <n>", "候选铺轨数：下载 preview 代理并在工程里平铺 N 条 B-roll 候选轨（默认 1；0=只出 plan 不铺轨）", "1")
		.option(
			"--score-floor <f>",
			"填充置信度地板：segment score 低于此值不采纳，槽位留空——黑底垫轨默认开，留空处露的是黑底（要露主轨口播画面得配 --no-black-bed）。" +
				"调高会收缩取材池、可能整段无槽位铺成纯黑，调完先看铺轨输出的空洞告警（默认 0.2；--local 模式同为该段的候选池准入地板）",
		)
		.option("--no-black-bed", "不铺纯黑底垫轨（默认铺一条，垫在候选轨之下、口播主轨之上，用于 B-roll 期间遮住口播画面）")
		.option(
			"--force-relay",
			"候选轨已被你在客户端编辑过（改过 clip / 确认过原片）时仍强制剥离重铺：缺省会拒铺并保留那条轨，本开关是逃生门——" +
				"会删除已确认原片的 broll-raw-* 素材登记，盘上已下载的原片文件就地成孤儿，且那条轨上的编辑不可恢复",
		)
		.option("--out <file>", "ad-hoc 模式：结果落文件（缺省输出 stdout）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[] | undefined, opts: MatrixOpts) => {
			await runMatrix(parseMatrixPositional(words), opts);
		});
}

/** positional 解析结果：plan（派单消费）/ search（ad-hoc）/ index（本地索引）/ describe（理解零件）/ lay（消费编辑后 plan）。 */
export type MatrixPositional =
	| { kind: "plan" }
	| { kind: "search"; query: string }
	| { kind: "index" }
	| { kind: "describe" }
	| { kind: "lay" };

/** positional 解析：空 = 派单消费；`search <query…>`；`index`；`describe`；`lay`；其他开头 = 报错给正确用法。 */
export function parseMatrixPositional(words: string[] | undefined): MatrixPositional {
	if (!words || words.length === 0) return { kind: "plan" };
	if (words[0] === "index") {
		if (words.length > 1) throw new Error(`matrix index 不接受多余参数「${words.slice(1).join(" ")}」——用法：gtrk matrix index --dirs <a,b,...>`);
		return { kind: "index" };
	}
	if (words[0] === "describe") {
		if (words.length > 1) {
			throw new Error(`matrix describe 不接受多余参数「${words.slice(1).join(" ")}」——用法：gtrk matrix describe --plan <path> | --materials <a,b,...>`);
		}
		return { kind: "describe" };
	}
	if (words[0] === "lay") {
		if (words.length > 1) {
			throw new Error(`matrix lay 不接受多余参数「${words.slice(1).join(" ")}」——用法：gtrk matrix lay --project <dir> [--plan <path>]`);
		}
		return { kind: "lay" };
	}
	if (words[0] !== "search") {
		throw new Error(
			`未知子命令「${words[0]}」——ad-hoc 检索：gtrk matrix search "<query>"；派单消费：gtrk matrix --project <dir>；本地索引：gtrk matrix index --dirs <a,b,...>；理解零件：gtrk matrix describe；消费编辑后 plan：gtrk matrix lay`,
		);
	}
	const query = words.slice(1).join(" ").trim();
	if (!query) throw new Error('检索词不能为空：gtrk matrix search "<query>"');
	return { kind: "search", query };
}

/** `--dirs a,b` 解析（去空、resolve 绝对化）。 */
export function parseDirsOption(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => resolve(s));
}

/**
 * 多路参数互斥校验（spec「互斥参数」：参数错误退出并明示原因，不做静默忽略）。
 *   - index / --local 必带 --dirs；
 *   - --local 与仅云端语义参数（--column / --material-class）互斥；
 *   - 云端模式反向拒绝本地专属参数（--dirs / --scene-threshold / --rebuild / --source-window）；
 *   - describe：--plan xor --materials；lay：需 --project 或 --plan；
 *   - --plan / --materials / --source-window 出现在不适用模式一律参数错误。
 */
export function assertModeOptions(pos: MatrixPositional, opts: MatrixOpts): void {
	const dirs = parseDirsOption(opts.dirs);
	// --mark-weight 仅 lay 模式（spec 只对 matrix lay 立法；不做静默忽略）
	if (opts.markWeight !== undefined && pos.kind !== "lay") {
		throw new Error("--mark-weight 仅用于 matrix lay（融合排序只在消费 plan 铺轨这一步生效，不做静默忽略）");
	}
	if (pos.kind === "describe") {
		if (!!opts.plan === !!opts.materials) {
			throw new Error("matrix describe 需要 --plan <path> 或 --materials <a,b,...> 之一（两者互斥；理解目标永远显式可见）");
		}
		if (opts.local || dirs.length) throw new Error("matrix describe 不接受 --local/--dirs（理解目标由 --plan/--materials 显式给出）");
		if (opts.sourceWindow !== undefined) throw new Error("--source-window 仅用于 --local 检索（不做静默忽略）");
		return;
	}
	if (pos.kind === "lay") {
		if (!opts.project && !opts.plan) throw new Error("matrix lay 需要 --project <目录>（或 --plan <path> 显式指定 plan 文件）");
		if (opts.local || dirs.length) throw new Error("matrix lay 不接受 --local/--dirs（lay 只消费 plan 现值，不检索）");
		if (opts.sourceWindow !== undefined) throw new Error("--source-window 仅用于 --local 检索（不做静默忽略）");
		if (opts.materials) throw new Error("--materials 仅用于 matrix describe（不做静默忽略）");
		return;
	}
	if (opts.plan) throw new Error("--plan 仅用于 matrix describe / matrix lay（不做静默忽略）");
	if (opts.materials) throw new Error("--materials 仅用于 matrix describe（不做静默忽略）");
	if (pos.kind === "index") {
		if (!dirs.length) throw new Error("matrix index 需要 --dirs <a,b,...> 指定素材文件夹（索引范围永远显式可见）");
		if (opts.sourceWindow !== undefined) throw new Error("--source-window 仅用于 --local 检索（不做静默忽略）");
		return;
	}
	if (opts.local) {
		if (!dirs.length) throw new Error("--local 需要 --dirs <a,b,...> 圈定检索域（检索域永远用户可见，不静默复用）");
		if (opts.column) throw new Error("--local 与 --column 互斥：栏目检索偏好（column_tag_ids/facets）是云端语义，本地索引不适用");
		if (opts.materialClass) throw new Error("--local 与 --material-class 互斥：素材类型过滤是云端素材库语义，本地索引不适用");
		return;
	}
	if (dirs.length) throw new Error("--dirs 仅用于 --local 检索或 matrix index（云端检索不接受该参数，不做静默忽略）");
	if (opts.sceneThreshold !== undefined) throw new Error("--scene-threshold 仅用于 matrix index（不做静默忽略）");
	if (opts.stabilityThreshold !== undefined) throw new Error("--stability-threshold 仅用于 matrix index（不做静默忽略）");
	if (opts.rebuild) throw new Error("--rebuild 仅用于 matrix index（不做静默忽略）");
	if (opts.sourceWindow !== undefined) {
		throw new Error("--source-window 仅用于 --local 检索（云端检索无源时间窗语义，不做静默忽略）");
	}
	if (opts.imageBroll === false) {
		throw new Error("--no-image-broll 仅用于 --local 检索/铺轨（云端检索结果恒为视频切片，不做静默忽略）");
	}
}

/** `--source-window <start,end>` 解析（秒）：两段逗号分隔非负数且 start < end；非法即参数错误（无合理默认可回落）。 */
export function parseSourceWindow(raw: string | undefined): [number, number] | undefined {
	if (raw === undefined) return undefined;
	const parts = raw.split(",").map((s) => Number(s.trim()));
	if (parts.length !== 2 || !parts.every((n) => Number.isFinite(n) && n >= 0) || parts[0]! >= parts[1]!) {
		throw new Error(`--source-window 取值非法（${raw}）——格式 <start,end>（秒），且 0 ≤ start < end`);
	}
	return [parts[0]!, parts[1]!];
}

export interface MatrixResult {
	ok: boolean;
	mode: "plan" | "search" | "lay";
	memberType: Tier | "local";
	columnId?: string;
	planPath?: string;
	results?: PlanResult[];
	counts: { beats: number; queries: number; results: number; errors: number };
	[k: string]: unknown;
}

/** 计量会话账面（--json 机读；infra 计费细案第 6 条：0.1 积分/张、文本免费、同合云内部成员豁免、预扣-实结）。 */
export interface MatrixIndexBilling {
	/** 同合云内部成员（gc_member_type=internal）豁免：true 时零计费无会话（其余积分字段缺席）。 */
	exempt: boolean;
	/** 本轮抽帧计划总数（= 会话 planned_units；0 = 纯增量跳过零新帧，未开会话）。 */
	planned_units: number;
	pre_deducted_credits?: number;
	used_units?: number;
	settled_credits?: number;
	refunded_credits?: number;
	/** 会话 close 调用失败：结算由服务端 /internal/quota/reconcile 15min cron 兜底。 */
	reconcile_pending?: boolean;
}

export interface MatrixIndexResult {
	ok: boolean;
	mode: "index";
	dirs: string[];
	dbPath: string;
	materials: { total: number; indexed: number; skipped: number; rebuilt: number; failed: number };
	/** kind 分列计数（add-matrix-local-image-broll：图片/视频各自 total/indexed）。 */
	kinds: { video: { total: number; indexed: number }; image: { total: number; indexed: number } };
	scenes: number;
	frames: number;
	/** 稳定性收敛账面（add-index-stability-sampling：分列 stable/unstable 场景数与收敛省帧数；
	 * 图片不参与，只计本轮实际入库的视频素材）。 */
	stability: { stable_scenes: number; unstable_scenes: number; frames_saved: number };
	billing: MatrixIndexBilling;
	elapsedSec: number;
	[k: string]: unknown;
}

/** 检索上下文：plan/adhoc 两模式共用的「一 query 一答」抽象（云端=双口 HTTP；本地=索引点积）。 */
interface SearchCtx {
	memberType: Tier | "local";
	columnId?: string;
	/** 本轮铺轨来源层（add-broll-dedup-and-layering D2）：--local → local；
	 * 云端按检索口判——internal 且 material_class=concept → concept，其余云端 → common。 */
	sourceLayer: SourceLayer;
	search: (query: string, entry?: FilmDispatch) => Promise<SearchRespData>;
}

export async function runMatrix(
	pos: MatrixPositional,
	opts: MatrixOpts,
	deps: MatrixRunDeps = {},
): Promise<MatrixResult | MatrixIndexResult | MatrixDescribeResult> {
	if (opts.json) routeLogsToStderr();
	assertModeOptions(pos, opts);
	const cfg = loadConfig();

	// ── 本地索引模式（matrix index）──
	if (pos.kind === "index") return withEmbedJsonGuard("index", opts, () => runIndexMode(cfg, opts));

	// ── 理解零件（matrix describe：--plan 注入 / --materials 直接理解）──
	if (pos.kind === "describe") return withEmbedJsonGuard("describe", opts, () => runDescribeMode(cfg, opts, deps));

	// ── 消费编辑后 plan（matrix lay：plan 可编辑通路的落轨腿）──
	if (pos.kind === "lay") return withEmbedJsonGuard("lay", opts, () => runLayMode(opts, deps));

	// ── 本地检索模式（--local）：跳过身份探针，不触任何云端检索端点 ──
	if (opts.local) {
		return withEmbedJsonGuard(pos.kind, opts, async () => {
			const ctx = await buildLocalSearchCtx(cfg, opts);
			return pos.kind === "search" ? runAdhoc(pos.query, ctx, opts) : runPlanMode(ctx, opts, deps);
		});
	}

	// ── 云端双口（行为与 add-matrix-local-search 之前逐字节一致）──
	// ① 身份探针（每次运行探一次，不缓存；探针失败=整体失败）
	log.step("▶ 身份探针（matrix_member_type）…");
	const tier = await probeMemberType(cfg);
	log.info(`档位：${tier}${tier === "internal" ? "（矩阵成员口 /task/custom/video_clip_search）" : "（通用口 /task/video_clip_search）"}`);

	// ② 栏目配置（成片层显式消费；external 不注入只提示）
	const columnId = opts.column ?? readUserConfig().defaultColumn;
	const resolved = resolveColumnConfig({ columnId });
	for (const w of resolved.warnings) log.warn(w);
	const broll = resolved.config.broll;
	const effectiveColumnId = columnId ?? resolved.config.meta?.id;

	if (tier === "external") {
		// 死角要明示，绝不静默吞：显式要 concept = 报错退出；real_shot = 警告继续
		if (opts.materialClass === "concept") {
			throw new Error("external 档位服务端固定 real_shot+有版权素材，concept 不可用（--material-class concept 无法满足）");
		}
		if (opts.materialClass) {
			log.warn("external 档位服务端固定 real_shot+有版权素材，--material-class 参数不适用（已忽略）");
		}
		if (broll && (broll.column_tag_ids?.length || broll.material_class_policy || broll.facet_defaults)) {
			log.warn("当前身份为 external，栏目检索偏好（column_tag_ids/material_class/facets）不适用");
		}
	}

	const topK = opts.topK ? Number(opts.topK) : undefined;
	const overrides = { topK, materialClass: opts.materialClass };
	const brollForTier = tier === "internal" ? broll : undefined;
	// 来源层判定（add-broll-dedup-and-layering D2）：custom 口 + concept → concept 层；其余云端 → common 层
	const effectiveMc = tier === "internal" ? (opts.materialClass ?? broll?.material_class_policy) : undefined;
	const ctx: SearchCtx = {
		memberType: tier,
		columnId: effectiveColumnId,
		sourceLayer: tier === "internal" && effectiveMc === "concept" ? "concept" : "common",
		search: (q, entry) => searchOnce(cfg, tier, buildSearchBody(tier, q, entry, brollForTier, overrides)),
	};
	return pos.kind === "search" ? runAdhoc(pos.query, ctx, opts) : runPlanMode(ctx, opts, deps);
}

/** 带机读 code 错误的 --json 统一出口（embed_endpoint_unreachable / 6033 会话拒绝 /
 * 6201·6202 积分不足等一律 `{ok:false, code, msg}`；退出码非 0 由顶层 catch 收口）。 */
async function withEmbedJsonGuard<T>(mode: string, opts: MatrixOpts, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		const code = (e as { code?: unknown } | null)?.code;
		if (opts.json && (typeof code === "string" || typeof code === "number")) {
			console.log(JSON.stringify({ ok: false, mode, code, msg: (e as Error).message }));
		}
		throw e;
	}
}

/** 自建 embed 端点（Authorization 直传 apikey，非 Bearer）。 */
function embedEndpointFor(cfg: ReturnType<typeof loadConfig>): EmbedEndpoint {
	return { url: resolveEmbedUrl(cfg.base), apiKey: cfg.apiKey };
}

/** 同合云内部成员计费豁免探测（add-gc-user-member-type D5：读 gc_member_type，MUST NOT 复用 matrix_member_type——
 * 素材矩阵成员身份只影响云端检索路由，与本地索引计费无关）。旧服务端无该字段按 external 兜底（probeGcMemberType 内建）。
 * 探针失败按非豁免继续——真正的失败面留给会话 open/embed（有明确机读 code）。
 * 注：这是 `matrix index` 的行为；`--local` 检索的「零身份探针」承诺不受影响（检索文本 embed 免费免会话）。 */
async function probeIndexBillingExempt(cfg: ReturnType<typeof loadConfig>): Promise<boolean> {
	try {
		return (await probeGcMemberType(cfg)) === "internal";
	} catch (e) {
		log.warn(
			`身份探测失败（${e instanceof Error ? e.message : String(e)}）——按非豁免（计量会话计费）继续；同合云内部成员（gc_member_type=internal）本可免会话零计费`,
		);
		return false;
	}
}

/** 计量会话钩子（回显预扣、积分不足补「所需积分」文案后上抛）。 */
export function buildIndexSessionHooks(endpoint: EmbedEndpoint): IndexSessionHooks {
	return {
		open: async (plannedUnits) => {
			const need = Math.ceil(plannedUnits * EMBED_CREDITS_PER_IMAGE);
			log.step(
				`▶ 计量会话预扣：计划 ${plannedUnits} 帧 → 预扣 ${need} 积分（${EMBED_CREDITS_PER_IMAGE} 积分/张、文本免费；结算按实际用量多退少不补）…`,
			);
			try {
				return await openEmbedSession(endpoint, plannedUnits);
			} catch (e) {
				const code = cloudErrorCode(e);
				if (code === QUOTA_INSUFFICIENT_CODE || code === BALANCE_INSUFFICIENT_CODE) {
					// 余额不足：明示所需积分退出（统一 ok:false + 非 0 退出码口径，withEmbedJsonGuard 出机读 JSON）
					throw new CloudError(
						code,
						`积分不足，计量会话未开：本次索引计划 ${plannedUnits} 帧，需预扣 ${need} 积分（${EMBED_CREDITS_PER_IMAGE} 积分/张）——` +
							`${e instanceof Error ? e.message : String(e)}。充值后重跑本命令即可（指纹增量：已索引素材零重算）`,
					);
				}
				throw e;
			}
		},
		close: (token) => closeEmbedSession(endpoint, token),
	};
}

/** 编排账面 → --json billing 字段（snake_case 机读口径）。 */
export function composeIndexBilling(exempt: boolean, run: Pick<IndexRunResult, "plannedFrames" | "billing">): MatrixIndexBilling {
	if (exempt) return { exempt: true, planned_units: run.plannedFrames };
	const b = run.billing;
	if (!b) return { exempt: false, planned_units: run.plannedFrames }; // 零新帧：未开会话零计费
	return {
		exempt: false,
		planned_units: b.plannedUnits,
		pre_deducted_credits: b.preDeductedCredits,
		...(b.usedUnits !== undefined ? { used_units: b.usedUnits } : {}),
		...(b.settledCredits !== undefined ? { settled_credits: b.settledCredits } : {}),
		...(b.refundedCredits !== undefined ? { refunded_credits: b.refundedCredits } : {}),
		...(b.reconcilePending ? { reconcile_pending: true } : {}),
	};
}

/** matrix index：本地素材免切片索引（进度行 + 计量会话 + --json 机读 summary）。 */
async function runIndexMode(cfg: ReturnType<typeof loadConfig>, opts: MatrixOpts): Promise<MatrixIndexResult> {
	const dirs = parseDirsOption(opts.dirs);
	const threshold = parseSceneThreshold(opts.sceneThreshold);
	const stabilityThreshold = parseStabilityThreshold(opts.stabilityThreshold);
	const endpoint = embedEndpointFor(cfg);
	log.step(
		`▶ 本地素材索引：${dirs.join("、")}（场景阈值 ${threshold} · 稳定阈值 ${stabilityThreshold}${opts.rebuild ? " · 强制全量重建" : ""}）…`,
	);
	log.info("免切片：只记场景时间戳，不产生任何切片文件；抽帧图 embed 后即删（素材本体不上云）。");
	// 同合云内部成员（gc_member_type=internal）豁免：无 token 也放行图像且零计费 → 直接不开会话
	const exempt = await probeIndexBillingExempt(cfg);
	if (exempt) log.info("同合云内部成员（gc_member_type=internal）：图像 embed 计费豁免（免会话零积分；文本 embed 本就免费）。");
	const run = await indexLocalMaterials({
		dirs,
		sceneThreshold: threshold,
		stabilityThreshold,
		rebuild: opts.rebuild === true,
		embed: (inputs, sessionToken) => embedInputs(endpoint, inputs, { sessionToken }),
		session: exempt ? undefined : buildIndexSessionHooks(endpoint),
		onProgress: (line) => log.info(line),
	});
	const m = run.materials;
	const billing = composeIndexBilling(exempt, run);
	const billNote = exempt
		? " · 计费豁免（同合云内部成员）"
		: billing.settled_credits !== undefined
			? ` · 实结 ${billing.settled_credits} 积分（预扣 ${billing.pre_deducted_credits} · 退还 ${billing.refunded_credits}）`
			: billing.reconcile_pending
				? ` · 计费待服务端对账（预扣 ${billing.pre_deducted_credits} 积分）`
				: billing.planned_units === 0
					? " · 零新帧零计费"
					: "";
	const kindNote = run.kinds.image.total > 0 ? `（视频 ${run.kinds.video.indexed}/${run.kinds.video.total} · 图片 ${run.kinds.image.indexed}/${run.kinds.image.total}）` : "";
	const stab = run.stability;
	const stabNote =
		stab.stableScenes + stab.unstableScenes > 0
			? ` · stable 场景 ${stab.stableScenes} / unstable ${stab.unstableScenes}${stab.framesSaved ? `（收敛省 ${stab.framesSaved} 帧）` : ""}`
			: "";
	log.ok(
		`索引完成：${m.indexed}/${m.total} 个素材${kindNote}（跳过 ${m.skipped} · 重建 ${m.rebuilt}${m.failed ? ` · 失败 ${m.failed}` : ""}）· ` +
			`场景 ${run.scenes} · 帧 ${run.frames}${stabNote} · 耗时 ${(run.elapsedMs / 1000).toFixed(1)}s${billNote}`,
	);
	log.info(`索引落点：${run.dbPath}（绝对路径为键，跨机不可移植；属本机缓存，可随时重建）`);
	const result: MatrixIndexResult = {
		ok: true,
		mode: "index",
		dirs: run.dirs,
		dbPath: run.dbPath,
		materials: run.materials,
		kinds: run.kinds,
		scenes: run.scenes,
		frames: run.frames,
		stability: { stable_scenes: stab.stableScenes, unstable_scenes: stab.unstableScenes, frames_saved: stab.framesSaved },
		billing,
		elapsedSec: Math.round(run.elapsedMs / 100) / 10,
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

/** --scene-threshold 解析：(0,1) 浮点，非法值按默认（告警）。 */
function parseSceneThreshold(raw: string | undefined): number {
	if (raw === undefined) return SCENE_THRESHOLD_DEFAULT;
	const n = Number(raw);
	if (Number.isFinite(n) && n > 0 && n < 1) return n;
	log.warn(`--scene-threshold 取值非法（${raw}），按默认 ${SCENE_THRESHOLD_DEFAULT} 处理`);
	return SCENE_THRESHOLD_DEFAULT;
}

/** --stability-threshold 解析：(0,1) 浮点，非法值按默认（告警；口径与 --scene-threshold 一致）。 */
function parseStabilityThreshold(raw: string | undefined): number {
	if (raw === undefined) return STABILITY_THRESHOLD_DEFAULT;
	const n = Number(raw);
	if (Number.isFinite(n) && n > 0 && n < 1) return n;
	log.warn(`--stability-threshold 取值非法（${raw}），按默认 ${STABILITY_THRESHOLD_DEFAULT} 处理`);
	return STABILITY_THRESHOLD_DEFAULT;
}

// ── matrix describe（add-matrix-describe-and-window · matrix-describe spec）──────────

export interface MatrixDescribeResult {
	ok: boolean;
	mode: "describe";
	/** --plan 模式：被注入回写的 plan 路径。 */
	planPath?: string;
	/** 拿到理解产物的条目数（= cached + called）。 */
	described: number;
	/** 缓存命中数（零调用零计费——缓存即钱）。 */
	cached: number;
	/** 实际调服务端张数（计费口径：1 积分/张同步计费）。 */
	called: number;
	/** 取帧失败被跳过数（局部化，不拖垮整轮）。 */
	failed: number;
	credits_estimated: number;
	/** internal 豁免（仅确认护栏触发过探测时出现）。 */
	exempt?: boolean;
	/** 计费确认被拒：零服务端调用中止（ok:false + 非 0 退出码）。 */
	reason?: string;
	/** --materials 模式明细（--plan 模式产物在 plan 文件里）。 */
	items?: { material_id: string; ts_ms: number; source: string; describe: MaterialDescribe | null }[];
	[k: string]: unknown;
}

/** --plan 模式取件：每 query 前 top-k 候选 → (材料 id, best 帧) 工作项；素材源缺失局部化跳过。 */
function collectPlanDescribeItems(
	plan: BrollPlan,
	topK: number | undefined,
): { items: DescribeWorkItem[]; targets: PlanResult[]; skipped: number } {
	const items: DescribeWorkItem[] = [];
	const targets: PlanResult[] = [];
	let skipped = 0;
	for (const beat of plan.beats ?? []) {
		for (const q of beat.queries ?? []) {
			const results = topK && topK > 0 ? (q.results ?? []).slice(0, topK) : (q.results ?? []);
			for (const r of results) {
				const seg = r.segments?.[0];
				const bestSec = seg ? seg.best : typeof r.duration === "number" ? r.duration / 2 : 0;
				const materialId = brollMaterialIdFor(r.clip_id);
				if (r.kind === "image" && typeof r.local_path === "string") {
					// 图片候选：文件直传（无时间轴，缓存键 ts=0）
					items.push({ materialId, tsMs: 0, source: { kind: "direct", path: r.local_path } });
					targets.push(r);
					continue;
				}
				const src = typeof r.local_path === "string" && r.local_path ? r.local_path : typeof r.url === "string" && r.url ? r.url : undefined;
				if (!src) {
					skipped++;
					log.warn(`clip ${r.clip_id} 无可取帧来源（缺 local_path/url），跳过理解`);
					continue;
				}
				items.push({ materialId, tsMs: Math.round(bestSec * 1000), source: { kind: "frame", src, tsSec: bestSec } });
				targets.push(r);
			}
		}
	}
	return { items, targets, skipped };
}

/** --materials 模式取件：图片直传（ts=0）；视频按场景抽帧（场景中点各一帧，复用 ffmpeg 场景检测链）。 */
async function collectMaterialDescribeItems(
	paths: string[],
	videoSceneFrames: NonNullable<MatrixRunDeps["videoSceneFrames"]>,
): Promise<{ items: DescribeWorkItem[]; skipped: number }> {
	const items: DescribeWorkItem[] = [];
	let skipped = 0;
	for (const p of paths) {
		if (!existsSync(p)) {
			skipped++;
			log.warn(`素材不存在：${p}（跳过）`);
			continue;
		}
		const kind = materialKindForPath(p);
		if (kind === "image") {
			items.push({ materialId: await brollLocalIdForFile(p), tsMs: 0, source: { kind: "direct", path: p } });
			continue;
		}
		if (kind === "video") {
			try {
				const { materialId, frameTsSec } = await videoSceneFrames(p);
				for (const ts of frameTsSec) {
					items.push({ materialId, tsMs: Math.round(ts * 1000), source: { kind: "frame", src: p, tsSec: ts } });
				}
			} catch (e) {
				skipped++;
				log.warn(`[${basename(p)}] 探测/场景检测失败：${e instanceof Error ? e.message : String(e)}（跳过）`);
			}
			continue;
		}
		skipped++;
		log.warn(`不支持的素材类型：${p}（视频/图片白名单外，跳过）`);
	}
	return { items, skipped };
}

/** 缺省视频场景抽帧计划：ffprobe 时长 → 场景边界检测 → 每场景中点一帧（「按场景抽帧」口径，
 * 与索引期加密抽帧不同——理解按场景一帧足量且省钱）。
 * stable 场景联动（add-index-stability-sampling spec）：「对 stable 场景 SHALL 同样仅理解中点帧」
 * 由本口径**天然满足**——describe 对所有场景（stable/unstable 一视同仁）本就恒中点 1 帧，
 * MUST NOT 改成 stable 加帧/unstable 加帧。 */
async function defaultVideoSceneFrames(path: string): Promise<{ materialId: string; frameTsSec: number[] }> {
	const ff = requireFfmpeg();
	const geo = probeGeometry(path);
	if (!(geo.duration > 0)) throw new Error("探测不到有效时长（疑似损坏/非视频文件）");
	const scenes = await detectScenes(ff.ffmpeg, path, geo.duration, SCENE_THRESHOLD_DEFAULT);
	return { materialId: await brollLocalIdForFile(path), frameTsSec: scenes.map((s) => s.st + (s.ed - s.st) / 2) };
}

/** matrix describe：三输入形态（--plan 注入 / --materials 视频按场景抽帧 / 图片直传）+ describes 缓存
 * + >20 张确认护栏（--yes 跳过、internal 豁免免确认仅提示）。 */
async function runDescribeMode(
	cfg: ReturnType<typeof loadConfig>,
	opts: MatrixOpts,
	deps: MatrixRunDeps,
): Promise<MatrixDescribeResult> {
	const endpoint = { url: resolveDescribeUrl(cfg.base), apiKey: cfg.apiKey };
	const describeBatch = deps.describeBatch ?? ((images: string[]) => describeImages(endpoint, images));
	const extractFrame =
		deps.extractFrame ?? (async (src: string, tsSec: number, outJpg: string) => extractFrameJpg(requireFfmpeg().ffmpeg, src, tsSec, outJpg));
	const probeExempt =
		deps.probeExempt ??
		(async () => {
			try {
				return (await probeGcMemberType(cfg)) === "internal";
			} catch (e) {
				log.warn(`身份探测失败（${e instanceof Error ? e.message : String(e)}）——按非豁免（1 积分/张同步计费）继续`);
				return false;
			}
		});
	const topK = opts.topK ? Number(opts.topK) : undefined;

	// ── 取件（三输入形态）──
	let items: DescribeWorkItem[];
	let targets: PlanResult[] | undefined;
	let planObj: BrollPlan | undefined;
	let planPath: string | undefined;
	let skipped = 0;
	if (opts.plan) {
		planPath = resolve(opts.plan);
		if (!existsSync(planPath)) throw new Error(`找不到 plan 文件：${planPath}`);
		planObj = JSON.parse(await readFile(planPath, "utf8")) as BrollPlan;
		const got = collectPlanDescribeItems(planObj, topK);
		items = got.items;
		targets = got.targets;
		skipped = got.skipped;
		log.step(`▶ 理解 plan 候选：${items.length} 项（${planPath}${topK ? ` · 每 query 前 ${topK} 条` : ""}）…`);
	} else {
		const paths = parseDirsOption(opts.materials);
		const got = await collectMaterialDescribeItems(paths, deps.videoSceneFrames ?? defaultVideoSceneFrames);
		items = got.items;
		skipped = got.skipped;
		log.step(`▶ 理解素材文件：${paths.length} 个文件 → ${items.length} 帧（视频按场景中点、图片直传）…`);
	}

	// ── 缓存短路 + 护栏 + 批调用（describes 缓存宿主 = 本地索引库）──
	const db = await openLocalIndexDb();
	let run;
	try {
		run = await runDescribeItems(items, {
			db,
			describeBatch,
			extractFrame,
			confirm: deps.confirm ?? confirmViaStdin,
			probeExempt,
			yes: opts.yes === true,
			frameDir: join(tmpDir(), `describe-${process.pid}`),
			onLog: (line) => log.info(line),
		});
	} finally {
		db.close();
	}

	if (run.declined) {
		log.err(
			"已取消：素材理解计费确认被拒绝——零服务端调用、零计费（缓存命中部分照常可用）。可用 --yes 跳过确认，或 --top-k 缩小理解范围后重跑。",
		);
		const result: MatrixDescribeResult = {
			ok: false,
			mode: "describe",
			...(planPath ? { planPath } : {}),
			described: run.described,
			cached: run.cached,
			called: 0,
			failed: run.failed,
			credits_estimated: run.estimatedCredits,
			...(run.exempt !== undefined ? { exempt: run.exempt } : {}),
			reason: "describe_billing_declined",
		};
		process.exitCode = 1;
		if (opts.json) console.log(JSON.stringify(result));
		return result;
	}

	// ── --plan 注入回写（result.describe 字段随 plan 流转；MUST NOT 依据 flags 剔除任何候选）──
	let injected = 0;
	if (planObj && planPath && targets) {
		targets.forEach((r, i) => {
			const d = run.results[i];
			if (d) {
				r.describe = toDescribeMeta(d);
				injected++;
			}
		});
		await writeFile(planPath, JSON.stringify(planObj, null, 2));
		log.ok(
			`理解完成并回写 plan：注入 ${injected} 条 result.describe（缓存命中 ${run.cached} · 实际调用 ${run.called} 张${run.failed ? ` · 取帧失败 ${run.failed}` : ""}${skipped ? ` · 无源跳过 ${skipped}` : ""}）→ ${planPath}`,
		);
		log.info("usable_flags 只是给你的信号：剔除与否由你编辑 plan 裁定（删 result 条目后 gtrk matrix lay），CLI 不会替你剔。");
	} else {
		log.ok(
			`理解完成：${run.described} 项（缓存命中 ${run.cached} · 实际调用 ${run.called} 张${run.failed ? ` · 取帧失败 ${run.failed}` : ""}${skipped ? ` · 跳过 ${skipped}` : ""}）`,
		);
		// 人读明细（--materials 模式；--json 时走 items 字段）
		if (!opts.json) {
			items.forEach((it, i) => {
				const d = run.results[i];
				if (!d) return;
				const flags = Object.entries(d.usable_flags)
					.filter(([, v]) => v)
					.map(([k]) => k);
				log.info(
					`${it.materialId} @${(it.tsMs / 1000).toFixed(1)}s · mark ${d.mark}${flags.length ? ` · ⚠ ${flags.join("/")}` : ""} · ${d.desc.slice(0, 80)}${d.tags.length ? ` · tags: ${d.tags.join("/")}` : ""}`,
				);
			});
		}
	}
	const billNote = run.exempt
		? "计费豁免（同合云内部成员）"
		: run.called > 0
			? `实际调用 ${run.called} 张 ≈ ${run.called * 1} 积分（1 积分/张同步计费）`
			: "零调用零计费（全部缓存命中）";
	log.info(`计费：${billNote}；理解产物已入本地缓存（同素材同帧下次零调用）。`);

	const result: MatrixDescribeResult = {
		ok: true,
		mode: "describe",
		...(planPath ? { planPath, injected } : {}),
		described: run.described,
		cached: run.cached,
		called: run.called,
		failed: run.failed,
		credits_estimated: run.estimatedCredits,
		...(run.exempt !== undefined ? { exempt: run.exempt } : {}),
		...(planObj
			? {}
			: {
					items: items.map((it, i) => ({
						material_id: it.materialId,
						ts_ms: it.tsMs,
						source: it.source.kind === "direct" ? it.source.path : it.source.src,
						describe: run.results[i] ?? null,
					})),
				}),
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

// ── matrix lay（plan 可编辑通路的落轨腿：agent 编辑 plan 后消费）─────────────────────

/** matrix lay：读（编辑后的）plan 文件 → 白名单校验（坏 plan 明示拒绝）→ 现场重投影 → 铺轨。
 * MUST NOT 因「与原始检索结果不一致」拒绝——lay 按 plan 现值执行（去重消费/层带/幂等照常）。 */
async function runLayMode(opts: MatrixOpts, deps: MatrixRunDeps): Promise<MatrixResult> {
	// 定位 plan 与工程目录（--plan 显式 > <project>/split/broll-plan.json）
	let planPath: string;
	let baseDir: string;
	if (opts.plan) {
		planPath = resolve(opts.plan);
		baseDir = opts.project ? resolve(opts.project) : dirname(dirname(planPath));
	} else {
		baseDir = resolve(opts.project!);
		planPath = join(baseDir, "split", "broll-plan.json");
	}
	if (!existsSync(planPath)) {
		throw new Error(`找不到 plan 文件：${planPath}（先 gtrk matrix --project <目录> --lay 0 产 plan，或用 --plan 显式指定）`);
	}
	const plan = JSON.parse(await readFile(planPath, "utf8")) as BrollPlan;

	// ── 可编辑面白名单校验（matrix-command spec：不可编辑字段改坏即拒并明示；纯结构面）──
	const violations = validatePlanForLay(plan);
	// 不可编辑面之 local_path 路径有效性（Scenario「不可编辑面防线」；IO 检查属命令层）
	for (const beat of plan.beats ?? []) {
		for (const q of beat.queries ?? []) {
			for (const r of q.results ?? []) {
				if (isLocalPlanResult(r) && typeof r.local_path === "string" && r.local_path && !existsSync(r.local_path)) {
					violations.push(
						`beat ${beat.beat}/clip ${r.clip_id}：local_path 不可编辑且路径无效（${r.local_path} 不存在）——本地素材路径由检索产出，请还原该字段或删除该候选条目`,
					);
				}
			}
		}
	}
	if (violations.length) {
		throw new Error(
			`plan 校验未通过（${violations.length} 处）。可编辑面 = results 删条/重排、segments 删段、describe 增删、pinned:true；` +
				`clip_id/local_path/url/几何字段不可编辑：\n  - ${violations.join("\n  - ")}`,
		);
	}

	const layN = parseLay(opts.lay);
	if (layN === 0) throw new Error("matrix lay 的 --lay 不能为 0（lay 就是铺轨这一步；只要 plan 不铺请直接编辑 plan 文件）");
	log.step(`▶ 消费 plan：${planPath}（member_type=${plan.member_type} · ${plan.beats.length} beat）…`);

	// ── 现场重投影（与 plan 模式同规）：plan 无 span → 经 struct_meta.split 回落或逐条沿用 plan 现值窗口 ──
	const earlyGtrkPath = locateGtrk(baseDir);
	let earlyGtrk: Record<string, unknown> | undefined;
	let earlyUnreadable = false;
	if (earlyGtrkPath) {
		try {
			earlyGtrk = readGtrk(earlyGtrkPath).gtrk;
		} catch {
			earlyUnreadable = true;
		}
	}
	const reproj = await reprojectDispatchWindows({
		baseDir,
		gtrk: earlyGtrk,
		gtrkUnreadable: earlyUnreadable,
		entries: plan.beats.map((b) => ({ key: b.beat, beat: b.beat, track_st: b.track_st, track_ed: b.track_ed })),
	});
	reportReprojection(reproj);
	const droppedBeats = new Set(reproj.summary.dropped);
	const beats = plan.beats
		.filter((b) => !droppedBeats.has(b.beat))
		.map((b) => {
			const win = reproj.windows.get(b.beat);
			return win ? { ...b, track_st: win.track_st, track_ed: win.track_ed } : b;
		});
	const effPlan: BrollPlan = { ...plan, beats };

	// 来源层：plan 无层登记，按 member_type 推导（local → local，云端 → common；概念层重铺请走检索命令）
	const sourceLayer: SourceLayer = plan.member_type === "local" ? "local" : "common";

	// ── 美观度权重（add-audio-project-atoms）：w>0 才建 mark 查询闭包（describes 缓存就近命中）──
	const markWeight = parseMarkWeight(opts.markWeight);
	let markDb: Awaited<ReturnType<typeof openLocalIndexDb>> | undefined;
	let markLookup: MarkLookup | undefined;
	if (markWeight > 0) {
		const dbPath = localIndexDbPath();
		if (existsSync(dbPath)) {
			markDb = await openLocalIndexDb(dbPath);
			const db = markDb;
			const cache = new Map<string, number | undefined>(); // 同 (clip, ts) 免重复 SQL
			markLookup = (clipId, tsMs) => {
				const key = `${clipId}@${tsMs}`;
				if (cache.has(key)) return cache.get(key);
				const v = getNearestCachedMark(db, brollMaterialIdFor(clipId), tsMs);
				cache.set(key, v);
				return v;
			};
			log.info(
				`美观度权重开启（w=${markWeight}）：融合分 = sim×${1 - markWeight}+(mark/100)×${markWeight}；mark 取 describe 理解缓存（素材内就近帧），无缓存候选按中性处理`,
			);
		} else {
			log.warn(
				`--mark-weight ${markWeight}：本地索引库不存在（${dbPath}），无任何 describe 缓存——全部候选按中性处理（排序与不开权重一致）。先跑 gtrk matrix describe 产 mark 再开权重才有效`,
			);
		}
	}

	let laid: Awaited<ReturnType<typeof layIntoProject>>;
	try {
		laid = await layIntoProject(baseDir, effPlan, layN, parseScoreFloor(opts.scoreFloor), opts.blackBed ?? true, opts.forceRelay === true, reproj, {
			imageBroll: opts.imageBroll !== false,
			yes: opts.yes === true,
			deps,
			sourceLayer,
			dedupScope: parseDedupScope(opts.dedupScope),
			markWeight,
			markLookup,
			cutAlign: parseCutAlign(opts.cutAlign),
			gapFill: parseGapFill(opts.gapFill),
			gapFillExplicit: opts.gapFill !== undefined,
		});
	} finally {
		markDb?.close();
	}
	const laySummary = laid?.lay;
	const refused = laySummary?.refused === true ? (laySummary.keptEditedTracks as number[]) : undefined;
	const declined = laid?.declined === true;
	let resultCount = 0;
	for (const b of effPlan.beats) for (const q of b.queries) resultCount += q.results?.length ?? 0;
	const result: MatrixResult = {
		ok: refused === undefined && !declined,
		mode: "lay",
		memberType: plan.member_type,
		planPath,
		...(refused ? { refused, reason: "tracks_edited", planReusable: true } : {}),
		...(declined ? { reason: "image_move_billing_declined", planReusable: true } : {}),
		...(laid?.imageBilling ? { image_move_billing: laid.imageBilling } : {}),
		...(laySummary ? { lay: laySummary } : {}),
		...(laid?.integrity ? { integrity: laid.integrity } : {}),
		reprojection: reproj.summary,
		counts: { beats: beats.length, queries: 0, results: resultCount, errors: 0 },
	};
	if (!result.ok) process.exitCode = 1;
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

/** 构建本地检索上下文：载入索引（--dirs 圈定 + 消失文件过滤）+ 查询 embed（去重缓存）→ 点积检索闭包。 */
async function buildLocalSearchCtx(cfg: ReturnType<typeof loadConfig>, opts: MatrixOpts): Promise<SearchCtx> {
	const dirs = parseDirsOption(opts.dirs);
	const endpoint = embedEndpointFor(cfg);
	const dbPath = localIndexDbPath();
	if (!existsSync(dbPath)) {
		throw new Error(`本地索引不存在（${dbPath}）——先跑 gtrk matrix index --dirs ${dirs.join(",")} 建索引`);
	}
	log.step(`▶ 本地检索模式：载入索引（域：${dirs.join("、")}）…`);
	const db = await openLocalIndexDb(dbPath);
	let index: LoadedIndex;
	try {
		index = loadLocalIndex(db, dirs);
	} finally {
		db.close();
	}
	if (index.frames.length === 0) {
		throw new Error(
			`索引里没有该检索域的素材帧（域：${dirs.join("、")}）——先跑 gtrk matrix index --dirs ${dirs.join(",")}（文件消失/未索引的素材不参与检索）`,
		);
	}
	log.info(`索引就绪：${index.materials.length} 个素材 · ${index.frames.length} 帧（消失文件已过滤）`);
	const floor = parseScoreFloor(opts.scoreFloor);
	const topK = opts.topK ? Number(opts.topK) : undefined;
	const includeImages = opts.imageBroll !== false; // --no-image-broll：检索侧完全排除图片候选
	// 源时间窗（search-source-window spec）：段级交集过滤，与其余过滤器 AND 叠加；空窗非错误
	const sourceWindow = parseSourceWindow(opts.sourceWindow);
	if (sourceWindow) {
		log.info(`源时间窗过滤：${sourceWindow[0]}s–${sourceWindow[1]}s（段级交集、段边界不裁剪；图片候选不参与；无命中即空结果，扩窗与否由你裁定）`);
	}
	const qvecCache = new Map<string, Float32Array>();
	return {
		memberType: "local",
		sourceLayer: "local",
		search: async (query) => {
			let vec = qvecCache.get(query);
			if (!vec) {
				[vec] = await embedInputs(endpoint, [{ text: query }]); // 除此一请求外零网络
				qvecCache.set(query, vec!);
			}
			const { recalled, results } = searchLoadedIndex(index, vec!, {
				scoreFloor: floor,
				includeImages,
				...(sourceWindow ? { sourceWindowSec: sourceWindow } : {}),
			});
			return { recalled, results: topK && topK > 0 ? results.slice(0, topK) : results };
		},
	};
}

/** 派单消费模式：dispatch.film_broll → split/broll-plan.json。 */
async function runPlanMode(ctx: SearchCtx, opts: MatrixOpts, deps: MatrixRunDeps = {}): Promise<MatrixResult> {
	const isLocal = ctx.memberType === "local";
	// 定位 dispatch：--dispatch 显式 > <project>/split/dispatch.json
	let dispatchPath: string;
	let baseDir: string;
	if (opts.dispatch) {
		dispatchPath = resolve(opts.dispatch);
		baseDir = dirname(dirname(dispatchPath));
	} else if (opts.project) {
		baseDir = resolve(opts.project);
		dispatchPath = join(baseDir, "split", "dispatch.json");
	} else {
		throw new Error("需 --project <目录> 或显式 --dispatch <path>（ad-hoc 检索用：gtrk matrix search \"<query>\"）");
	}
	if (!existsSync(dispatchPath)) throw new Error(`找不到派单清单：${dispatchPath}（先跑 gtrk split <拆分稿> 落地派单）`);

	const dispatch = JSON.parse(await readFile(dispatchPath, "utf8")) as Dispatch;
	const rawQueue: FilmDispatch[] = Array.isArray(dispatch.film_broll) ? dispatch.film_broll : [];

	// ── 现场重投影（add-consume-side-reprojection 6.1）：在**发起第一次检索之前**完成 ──
	// 窗口长度直接决定检索的镜头切分与时长诉求；用过期窗口检索 = 先烧掉整轮配额再拿错料。
	// 工程读取因此从 layIntoProject 提前到这里；读失败按 D6 ①a **门内吞掉**（既有失败面不挪：
	// assertGtrkV1 仍留在 layIntoProject 里、在 plan 落盘之后 —— 「非 v1 仍能拿到 plan」不变）。
	const earlyGtrkPath = locateGtrk(baseDir);
	let earlyGtrk: Record<string, unknown> | undefined;
	let earlyUnreadable = false;
	if (earlyGtrkPath) {
		try {
			earlyGtrk = readGtrk(earlyGtrkPath).gtrk;
		} catch {
			earlyUnreadable = true; // 报错留给 layIntoProject 的原位置（本处只是「算不出窗口」）
		}
	}
	const reproj = await reprojectDispatchWindows({
		baseDir,
		gtrk: earlyGtrk,
		gtrkUnreadable: earlyUnreadable,
		entries: rawQueue.map((e) => ({ key: e.beat, beat: e.beat, span: e.span, track_st: e.track_st, track_ed: e.track_ed })),
	});
	reportReprojection(reproj);
	// 重投影后**零存活**的 beat：从检索与 plan 中一并跳过（MUST NOT 为它烧配额、也不铺轨）
	const droppedBeats = new Set(reproj.summary.dropped);
	const queue: FilmDispatch[] = rawQueue
		.filter((e) => !droppedBeats.has(e.beat))
		.map((e) => {
			const win = reproj.windows.get(e.beat);
			return win ? { ...e, track_st: win.track_st, track_ed: win.track_ed } : e;
		});
	log.step(`▶ B-roll 检索：${queue.length} 个 beat（${isLocal ? "本地索引" : `${ctx.memberType} 口`}）…`);

	const beats = [];
	let okCount = 0;
	let errCount = 0;
	let resultCount = 0;
	for (const entry of queue) {
		const outcomes: QueryOutcome[] = [];
		// 锚 query 并入同一检索链（add-keyword-anchored-broll）：与普通 queries 同口同参跑；
		// 已在 queries 里的不重发（beat 内 dedupe 与叙事序照旧）。plan 里的归属标注 = beat.anchors[].query。
		const anchorQueries = [
			...new Set(
				(entry.anchors ?? [])
					.map((a) => a.query)
					.filter((q) => typeof q === "string" && q && !entry.queries.includes(q)),
			),
		];
		for (const q of [...entry.queries, ...anchorQueries]) {
			const isAnchorQ = anchorQueries.includes(q);
			try {
				const data = await ctx.search(q, entry);
				outcomes.push({ query: q, data });
				okCount++;
				resultCount += data.results?.length ?? 0;
				log.info(`${entry.beat}「${q}」${isAnchorQ ? "（锚）" : ""}→ ${data.results?.length ?? 0} 条候选（召回 ${data.recalled ?? "?"}）`);
			} catch (e) {
				// embed 端点硬失败绝不局部化吞掉：本地模式没有查询向量=整体不可用（MUST NOT 静默降级）
				if ((e as { code?: unknown } | null)?.code === EMBED_UNREACHABLE_CODE) throw e;
				// 单 query 失败局部化：记 error 继续其余（网络/超时/6401/6402 都不拖垮整个 plan）
				const code = (e as { code?: number }).code;
				const msg = e instanceof Error ? e.message : String(e);
				outcomes.push({ query: q, error: { ...(code != null ? { code } : {}), msg } });
				errCount++;
				log.warn(`${entry.beat}「${q}」失败：${msg}`);
			}
		}
		const planBeat = buildPlanBeat(entry, outcomes);
		// 锚 at_sec 内插（add-keyword-anchored-broll）：句级当刻包络 × 关键词字符偏移比例——
		// 供数来自重投影同一份产物（utteranceIndex）；算不出即 null（lay 按 degraded 处置，不硬锚）
		if (entry.anchors?.length) {
			planBeat.anchors = entry.anchors.map((a): PlanAnchor => {
				const u = reproj.utteranceIndex?.get(a.utterance);
				const at = u ? anchorAtSec(u.text, a.keyword, u.track_st, u.track_ed) : null;
				if (at === null) {
					log.warn(
						u
							? `${entry.beat} 锚「${a.keyword}」：当刻句 ${a.utterance} 文本里找不到该关键词（改稿后文本漂移）——本锚 degraded，铺轨退化普通槽`
							: `${entry.beat} 锚「${a.keyword}」：句 ${a.utterance} 无当刻时码（重投影降级或该句已被剪）——本锚 degraded，铺轨退化普通槽`,
					);
				}
				return { keyword: a.keyword, utterance: a.utterance, at_sec: at, query: a.query };
			});
		}
		beats.push(planBeat);
	}

	const totalQueries = okCount + errCount;
	// 判据用 rawQueue：队列本来就空 ≠ 被重投影全判零存活（后者已由重投影摘要单独报因）
	if (rawQueue.length === 0) log.warn("无 B-roll 派单（film_broll 队列为空）——照常写出空 plan");
	if (totalQueries > 0 && okCount === 0) {
		throw new Error(`全部 ${totalQueries} 个 query 检索失败，未写入 plan（逐条原因见上方日志）`);
	}

	const projectSlug = slugify(basename(baseDir));
	const plan = buildPlan({
		generatedAt: new Date().toISOString(),
		memberType: ctx.memberType,
		projectSlug,
		columnId: ctx.columnId,
		beats,
	});
	const splitDir = join(baseDir, "split");
	await mkdir(splitDir, { recursive: true });
	const planPath = join(splitDir, "broll-plan.json");
	await writeFile(planPath, JSON.stringify(plan, null, 2));
	log.ok(`候选清单已生成：${planPath}（${beats.length} beat · ${okCount}/${totalQueries} query 成功 · ${resultCount} 条候选）`);
	if (isLocal) {
		log.info("清单只含引用不含素材：本地素材以绝对路径直引（local_path，无 url 签名/过期语义）；封面铺轨时现抽。");
	} else {
		log.info("清单只含引用不含素材：cover_url 可直接预览；url 带签名默认 24h 过期，过期重跑本命令即重签。");
	}

	// ⑤ 候选铺轨（add-matrix-lay-tracks）：下载 preview 代理落地（本地素材免下载直引）→
	//    幂等替换自产轨 → 原子写回。工程缺失/非 v1 = 告警跳过（plan 已产，铺轨是增值不是门槛）。
	const layN = parseLay(opts.lay);
	let laid: LayOutcome | undefined;
	if (layN > 0) {
		laid = await layIntoProject(
			baseDir,
			plan,
			layN,
			parseScoreFloor(opts.scoreFloor),
			opts.blackBed ?? true,
			opts.forceRelay === true,
			reproj,
			{
				imageBroll: opts.imageBroll !== false,
				yes: opts.yes === true,
				deps,
				sourceLayer: ctx.sourceLayer,
				dedupScope: parseDedupScope(opts.dedupScope),
				cutAlign: parseCutAlign(opts.cutAlign),
				gapFill: parseGapFill(opts.gapFill),
				gapFillExplicit: opts.gapFill !== undefined,
			},
		);
	}
	const laySummary = laid?.lay;

	// ②-B 拒铺（fix-matrix-strip-identity）：候选轨已被用户编辑 → 工程零改动。
	// 退出码口径已拍板取**非 0**（`ok:false` 一律连带非 0 退出码，与 `gtrk mg` 的 done() 同调）——
	// 本 CLI 的主要消费者是 agent，「ok:false + 退出码 0」是静默错判的源头。plan 仍已产出、可复用。
	const refused = laySummary?.refused === true ? (laySummary.keptEditedTracks as number[]) : undefined;
	// 图片运镜计费确认被拒（add-matrix-local-image-broll D5）：整轮铺轨中止、工程零改动、零云端调用
	const declined = laid?.declined === true;
	const result: MatrixResult = {
		ok: refused === undefined && !declined,
		mode: "plan",
		memberType: ctx.memberType,
		...(ctx.columnId ? { columnId: ctx.columnId } : {}),
		planPath,
		...(refused ? { refused, reason: "tracks_edited", planReusable: true } : {}),
		...(declined ? { reason: "image_move_billing_declined", planReusable: true } : {}),
		// 图片运镜计费账面（仅本轮真有图片候选参与时出现；纯视频候选行为与图片能力引入前一致）
		...(laid?.imageBilling ? { image_move_billing: laid.imageBilling } : {}),
		...(laySummary ? { lay: laySummary } : {}),
		// 素材落盘自检（material-integrity-check）：只在**真写回过**的路径上出现。
		// 字段缺席 = 「本次没查」，MUST NOT 用空结果冒充「查过且干净」；与 `gtrk mg` 同名同形。
		...(laid?.integrity ? { integrity: laid.integrity } : {}),
		reprojection: reproj.summary,
		counts: { beats: beats.length, queries: totalQueries, results: resultCount, errors: errCount },
	};
	if (!result.ok) process.exitCode = 1;
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

/** --lay 解析：非负整数，非法值按默认 1（告警）。 */
function parseLay(raw: string | undefined): number {
	if (raw === undefined) return 1;
	const n = Number(raw);
	if (Number.isInteger(n) && n >= 0) return n;
	log.warn(`--lay 取值非法（${raw}），按默认 1 处理`);
	return 1;
}

/** --dedup-scope 解析：scene（默认）| material；越界即参数错误（不做静默忽略）。 */
export function parseDedupScope(raw: string | undefined): DedupScope {
	if (raw === undefined || raw === "scene") return "scene";
	if (raw === "material") return "material";
	throw new Error(`--dedup-scope 只支持 scene 或 material（得到「${raw}」）`);
}

/** --mark-weight 解析：[0,1] 浮点，缺省/非法按 0（告警；0=关闭零回归）。 */
export function parseMarkWeight(raw: string | undefined): number {
	if (raw === undefined) return 0;
	const n = Number(raw);
	if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
	log.warn(`--mark-weight 取值非法（${raw}），按 0（关闭）处理`);
	return 0;
}

/** --cut-align 解析：[0,1] 浮点，缺省按 CUT_ALIGN_DEFAULT（0.7），非法值按默认（告警）；0=关闭。 */
export function parseCutAlign(raw: string | undefined): number {
	if (raw === undefined) return CUT_ALIGN_DEFAULT;
	const n = Number(raw);
	if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
	log.warn(`--cut-align 取值非法（${raw}），按默认 ${CUT_ALIGN_DEFAULT} 处理`);
	return CUT_ALIGN_DEFAULT;
}

/** --gap-fill 解析：fast|solid|none，缺省 solid（保守：黑片垫齐）；越界即参数错误（不做静默忽略）。 */
export function parseGapFill(raw: string | undefined): GapFillMode {
	if (raw === undefined || raw === "solid") return "solid";
	if (raw === "fast" || raw === "none") return raw;
	throw new Error(`--gap-fill 只支持 fast、solid 或 none（得到「${raw}」）`);
}

/** --score-floor 解析：[0,1] 浮点，非法值按默认（告警）。 */
function parseScoreFloor(raw: string | undefined): number {
	if (raw === undefined) return SCORE_FLOOR_DEFAULT;
	const n = Number(raw);
	if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
	log.warn(`--score-floor 取值非法（${raw}），按默认 ${SCORE_FLOOR_DEFAULT} 处理`);
	return SCORE_FLOOR_DEFAULT;
}

/** 定位工程文件（沿 split 候选链）。 */
function locateGtrk(baseDir: string): string | undefined {
	const cands = [join(baseDir, "gtrk", "project.gtrk"), join(baseDir, "project.gtrk")];
	return cands.find((p) => existsSync(p));
}

/** 铺轨返回：`lay` = 既有铺轨摘要（进 `--json` 的 `lay`）；`integrity` 仅在真写回过时才有；
 * `declined` = 图片运镜计费确认被拒（整轮中止、工程零改动）；`imageBilling` 仅图片候选参与时出现。 */
interface LayOutcome {
	lay: Record<string, unknown>;
	integrity?: IntegrityReport;
	declined?: boolean;
	imageBilling?: { generated: number; reused: number; estimated_credits: number };
}

/** 图片运镜准备产物（3.2/3.3/3.4）。 */
interface ImageMovePrep {
	/** 本轮是否有图片候选进入槽位（false = 纯视频候选，行为与图片能力引入前一致）。 */
	hasImage: boolean;
	/** 计费确认被拒：整轮铺轨中止（零云端调用）。 */
	declined: boolean;
	/** 材料 id → materials 条目（运镜视频 ffprobe 实测 / 静态兜底图片形态）。 */
	injected: Map<string, Record<string, unknown>>;
	billing: { generated: number; reused: number; estimated_credits: number };
	/** 单张运镜失败明细（机读 summary；失败槽位已静态兜底，不阻断整轮）。 */
	failures: { image: string; reason: string }[];
}

/** stdin 计费确认（--yes 跳过；测试经 MatrixRunDeps.confirm 注入）。 */
async function confirmViaStdin(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
		return a === "y" || a === "yes";
	} finally {
		rl.close();
	}
}

/** 真实云链生成器（缺省注入面）：懒构建——纯视频候选/缓存全命中/确认被拒时零 loadConfig 零云端触达。 */
function buildDefaultImageMoveGenerator(): NonNullable<MatrixRunDeps["generateImageMove"]> {
	const cfg = loadConfig();
	const deps: CloudFileTaskDeps = { cfg, uploadCached, invalidateUpload, submitTask, getTaskResult };
	return async ({ imageAbs, destAbs, params }) => {
		await generateImageMoveAsset({ deps, imageAbs, destAbs, params });
	};
}

const r3num = (n: number): number => Math.round(n * 1000) / 1000;

/** 运镜产物材料条目：ffprobe 实测（matrix-lay-tracks spec）；探测失败按生成参数兜底登记。 */
function mvMaterialEntry(
	materialId: string,
	gtrkDir: string,
	fallback: { duration: number; canvas: [number, number] },
): Record<string, unknown> {
	const rel = imageMoveRelPath(materialId);
	let geo: { width: number; height: number; fps: number; duration: number } | undefined;
	try {
		geo = probeGeometry(join(gtrkDir, ...rel.split("/")));
	} catch {
		/* ffprobe 缺失/产物异常：duration=生成档、几何=画布（生成参数即产物参数的兜底登记） */
	}
	return {
		id: materialId,
		path: rel,
		duration: geo && geo.duration > 0 ? r3num(geo.duration) : fallback.duration,
		video_size: geo && geo.width > 0 && geo.height > 0 ? [geo.width, geo.height] : [fallback.canvas[0], fallback.canvas[1]],
		...(geo && geo.fps > 0 ? { video_rate: r3num(geo.fps) } : {}),
	};
}

/** 静态兜底材料条目（D6）：path=图片绝对路径、MUST NOT 带 duration（image 元素按槽长铺，黑底垫片同款口径）。 */
function staticImageMaterialEntry(materialId: string, imageAbs: string): Record<string, unknown> {
	let dims: [number, number] | undefined;
	try {
		const g = probeGeometry(imageAbs);
		if (g.width > 0 && g.height > 0) dims = [g.width, g.height];
	} catch {
		/* best-effort */
	}
	return { id: materialId, path: imageAbs, ...(dims ? { video_size: dims } : {}) };
}

/**
 * 图片运镜准备（3.2/3.3/3.4）：扫描槽位里的图片候选 → 参数推导（duration 统一档 + 工程画布几何）
 * → 缓存查询（工程 assets/broll-move/ 同名即复用，零重复计费）→ 计费预估确认（--yes 跳过、
 * 拒绝零云端调用中止）→ 生成（并发 ≤2、逐张进度）→ 失败静态兜底（改写槽位 material_id、不阻断整轮）。
 * 会就地改写 FillSlot.material_id（运镜材料 id / 静态兜底 id），材料实体收进 injected 供 layBrollTracks 登记。
 */
async function prepareImageMoveAssets(args: {
	fills: Map<string, FillSlot[][]>;
	candById: Map<string, PlanResult>;
	gtrkDir: string;
	canvas: [number, number];
	yes: boolean;
	deps: MatrixRunDeps;
}): Promise<ImageMovePrep> {
	const injected = new Map<string, Record<string, unknown>>();
	const failures: ImageMovePrep["failures"] = [];
	const none: ImageMovePrep = { hasImage: false, declined: false, injected, billing: { generated: 0, reused: 0, estimated_credits: 0 }, failures };

	// ── 归组：材料 id（图hash+参数指纹）→ 槽位集（同图同参多槽复用同一产物）──
	interface Group {
		materialId: string;
		imageAbs: string;
		hash16: string;
		duration: number;
		slots: FillSlot[];
	}
	const groups = new Map<string, Group>();
	for (const perTrack of args.fills.values()) {
		for (const slots of perTrack) {
			for (const s of slots) {
				const cand = args.candById.get(s.clip_id);
				if (cand?.kind !== "image") continue;
				const imageAbs = cand.local_path;
				if (!imageAbs || !existsSync(imageAbs)) {
					log.warn(`图片素材缺失（clip ${s.clip_id}）：${imageAbs ?? "无 local_path"}——该槽位跳过`);
					continue;
				}
				const duration = imageMoveDurationForSlot(s.track_ed - s.track_st);
				const fp = await imageMoveParamFingerprint({ duration, width: args.canvas[0], height: args.canvas[1] });
				const hash16 = imageHash16FromClipId(s.clip_id);
				const materialId = imageMoveMaterialId(hash16, fp);
				s.material_id = materialId;
				const g = groups.get(materialId) ?? { materialId, imageAbs, hash16, duration, slots: [] };
				g.slots.push(s);
				groups.set(materialId, g);
			}
		}
	}
	if (groups.size === 0) return none;

	// ── 缓存查询（D3）：工程内产物存在即复用，MUST NOT 重复调云端 ──
	const pending: Group[] = [];
	let reused = 0;
	for (const g of groups.values()) {
		if (existsSync(join(args.gtrkDir, ...imageMoveRelPath(g.materialId).split("/")))) {
			reused++;
			injected.set(g.materialId, mvMaterialEntry(g.materialId, args.gtrkDir, { duration: g.duration, canvas: args.canvas }));
		} else {
			pending.push(g);
		}
	}
	const estimated = pending.length * IMAGE_MOVE_CREDITS_PER_IMAGE;
	const billing = { generated: 0, reused, estimated_credits: estimated };
	if (pending.length === 0) {
		log.info(`图片运镜：${reused} 张全部缓存命中（工程 assets/broll-move/ 复用，零云端调用零计费）`);
		return { hasImage: true, declined: false, injected, billing, failures };
	}

	// ── 计费预估确认护栏（D5）：N 张 × 2 积分；--yes 跳过；拒绝 = 整轮铺轨中止（零云端调用）──
	const hint =
		`${pending.length} 张图片将生成运镜视频，约 ${estimated} 积分` +
		`（${IMAGE_MOVE_CREDITS_PER_IMAGE} 积分/张${reused ? ` · 另 ${reused} 张缓存命中不计费` : ""}；` +
		`注意：图片本体将上云做运镜——与视频素材「本体不上云」不同，不愿图片上云可用 --no-image-broll 排除）`;
	if (args.yes) {
		log.info(`${hint}——已按 --yes 跳过确认`);
	} else {
		log.warn(hint);
		const go = await (args.deps.confirm ?? confirmViaStdin)("确认继续生成？");
		if (!go) return { hasImage: true, declined: true, injected, billing, failures };
	}

	// ── 生成（D4：并发 ≤2、逐张进度）；单张失败静态兜底（D6，不阻断整轮）──
	await mkdir(join(args.gtrkDir, ...BROLL_MOVE_DIR.split("/")), { recursive: true });
	const gen = args.deps.generateImageMove ?? buildDefaultImageMoveGenerator();
	const queue = [...pending];
	const total = pending.length;
	let done = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const g = queue.shift();
			if (!g) return;
			const destAbs = join(args.gtrkDir, ...imageMoveRelPath(g.materialId).split("/"));
			try {
				await gen({
					imageAbs: g.imageAbs,
					destAbs,
					params: { width: args.canvas[0], height: args.canvas[1], duration: g.duration },
				});
				billing.generated++;
				log.info(
					`[${++done}/${total}] ${basename(g.imageAbs)} 运镜就绪（${g.duration}s · ${args.canvas[0]}x${args.canvas[1]}）`,
				);
				injected.set(g.materialId, mvMaterialEntry(g.materialId, args.gtrkDir, { duration: g.duration, canvas: args.canvas }));
			} catch (e) {
				const reason = e instanceof Error ? e.message : String(e);
				failures.push({ image: g.imageAbs, reason });
				// 失败降级 D6：该槽以图片静态上轨兜底（不换内容不留黑）；重铺时缓存无产物自然重试运镜
				const staticId = imageStaticMaterialId(g.hash16);
				if (!injected.has(staticId)) injected.set(staticId, staticImageMaterialEntry(staticId, g.imageAbs));
				for (const s of g.slots) s.material_id = staticId;
				log.warn(
					`[${++done}/${total}] ${basename(g.imageAbs)} 运镜失败（${reason}）——该图以静态图片上轨兜底，重铺本命令会自动重试运镜`,
				);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(IMAGE_MOVE_CONCURRENCY, queue.length) }, () => worker()));
	return { hasImage: true, declined: false, injected, billing, failures };
}

/**
 * 本地候选封面现抽（add-matrix-local-search 4.2）：对进 struct_meta.broll 的本地候选（每 beat 前
 * BROLL_META_CANDIDATE_CAP 条），ffmpeg 在首段 best 时刻抽一帧落 assets/broll-cover/<id>.jpg
 * （<id> = 材料 id `broll-local-<hash>`，spec D6 口径；clip_id=`local-<hash>` 经既有拼接得出）。
 * 同名已存在即复用（id 随内容，封面天然幂等）；ffmpeg 缺失/抽取失败仅告警（封面是增值不是门槛）。
 */
async function extractLocalCovers(plan: BrollPlan, gtrkDir: string): Promise<Map<string, string>> {
	const covers = new Map<string, string>();
	const locals = new Map<string, PlanResult>();
	for (const beat of plan.beats) {
		for (const c of mergedCandidates(beat).slice(0, BROLL_META_CANDIDATE_CAP)) {
			if (isLocalPlanResult(c) && !locals.has(c.clip_id)) locals.set(c.clip_id, c);
		}
	}
	if (locals.size === 0) return covers;
	const ff = resolveFfmpeg();
	if (!ff) {
		log.warn("未找到 ffmpeg，跳过本地候选封面抽取（gtrk deps install --ffmpeg 后重跑可补）");
		return covers;
	}
	await mkdir(join(gtrkDir, ...BROLL_COVER_DIR.split("/")), { recursive: true });
	for (const [clipId, cand] of locals) {
		const rel = `${BROLL_COVER_DIR}/${brollMaterialIdFor(clipId)}.jpg`;
		const abs = join(gtrkDir, ...rel.split("/"));
		if (existsSync(abs)) {
			covers.set(clipId, rel);
			continue;
		}
		const src = cand.local_path;
		if (!src || !existsSync(src)) continue; // 素材缺失的告警由铺轨注入环节统一发
		const seg = cand.segments?.[0];
		const best = seg ? seg.best : (typeof cand.duration === "number" ? cand.duration / 2 : 0);
		if (await extractFrameJpg(ff.ffmpeg, src, best, abs)) covers.set(clipId, rel);
		else log.warn(`本地候选封面抽取失败（clip ${clipId} @ ${best}s）——候选照常可用，封面留空`);
	}
	return covers;
}

/**
 * 候选铺轨：先平铺定颗粒（planBeatFills）→ 对全部槽位 clip 备好素材引用（云端候选下载代理：
 * preview 优先 → 推导 → 404 回落 raw；本地候选免下载，downloads 注入 rel=素材绝对路径）
 * → layBrollTracks → 原子写回 → 素材落盘自检（只读）。
 * 任何整体性失败（工程缺失/非 v1/mtime 冲突）都不影响已产出的 plan。
 */
async function layIntoProject(
	baseDir: string,
	plan: BrollPlan,
	layN: number,
	scoreFloor: number,
	blackBed: boolean,
	forceRelay: boolean,
	reproj: ReprojectResult,
	layOpts: {
		imageBroll: boolean;
		yes: boolean;
		deps: MatrixRunDeps;
		sourceLayer?: SourceLayer;
		dedupScope?: DedupScope;
		/** 美观度权重（add-audio-project-atoms，matrix lay 专用）：0..1，缺省 0 零回归。 */
		markWeight?: number;
		/** mark 查询闭包（runLayMode 供给；缺省=全部中性）。 */
		markLookup?: MarkLookup;
		/** 句界吸附目标比例（adjust-shot-cut-sentence-align）：缺省 CUT_ALIGN_DEFAULT；0=关闭。 */
		cutAlign?: number;
		/** 主轨 gap 填充模式（adjust-main-track-gap-fill）：缺省 solid；仅音频驱动工程主轨生效。 */
		gapFill?: GapFillMode;
		/** 用户是否显式传了 --gap-fill（口播工程「不适用」提示只对显式传参出，缺省态不制造噪音）。 */
		gapFillExplicit?: boolean;
	} = { imageBroll: true, yes: false, deps: {} },
): Promise<LayOutcome | undefined> {
	const imageOpts = layOpts;
	const gtrkPath = locateGtrk(baseDir);
	if (!gtrkPath) {
		log.warn(`未找到工程文件（${join(baseDir, "gtrk", "project.gtrk")}），跳过铺轨——plan 已产出，可后续在有工程的目录重跑`);
		return undefined;
	}
	const { gtrk, mtimeMs } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);

	// ── 句界吸附供数（adjust-shot-cut-sentence-align）：句起点 = 重投影 utteranceIndex 的句级
	// track 时码（与锚 at_sec 内插同一份投影产物）。降级链无中间档：拿不到就整体回旧行为并告警，
	// MUST NOT 拿派单快照时码硬吸；--cut-align 0 显式关闭时不出该告警（显式意图不制造噪音）。
	const cutRatio = layOpts.cutAlign ?? CUT_ALIGN_DEFAULT;
	let cutStarts: number[] | undefined;
	if (cutRatio > 0) {
		const starts = [...new Set([...(reproj.utteranceIndex?.values() ?? [])].map((u) => Math.round(u.track_st * 1000)))]
			.sort((a, b) => a - b)
			.map((v) => v / 1000);
		if (starts.length) {
			cutStarts = starts;
		} else {
			log.warn(
				`句界吸附不可用（${reproj.summary.mode === "dispatch_snapshot" ? (reproj.summary.reason_text ?? "重投影降级") : "当刻无存活句"}）——本轮按旧节奏切槽（--cut-align 0 可显式关闭本提示对应的功能）`,
			);
		}
	}

	// ── 主轨 gap 填充形态预判（adjust-main-track-gap-fill）：规划段门控——口播工程（任一 video 轨
	// 含非自产前缀 clip）一律不启用（fast 不消费候选、不改槽位，零回归）；权威判定仍在 layBrollTracks
	// 以剥离后终态复核（两处同一 projectHasShieldTrack 判据，剥离只删自产轨、二者在常规路径恒一致）。
	const gapMode = layOpts.gapFill ?? "solid";
	const audioDrivenPre = !projectHasShieldTrack((gtrk.video_track as { track_timeline?: unknown }[] | undefined) ?? []);
	const gapModeEff: GapFillMode = audioDrivenPre ? gapMode : "none";
	if (!audioDrivenPre && gapMode !== "none" && layOpts.gapFillExplicit) {
		log.info(
			"主轨 gap 填充未生效：口播工程的主轨是你的 A-roll（磁吸风险不在 B-roll 候选轨），--gap-fill 只作用于音频驱动工程的最低号 B-roll 主轨——本轮按既有留空语义铺轨。",
		);
	}

	// 先定「填哪些颗粒」（纯逻辑），下载集 = 全部槽位 clip 去重；--no-image-broll 时图片不进池；
	// 全局不二用消费集与跳剪豁免避让在此生效（add-broll-dedup-and-layering D1/D4）
	const { fills, clipIds, stats: fillStats, pinnedOutcome, markStats, anchors: anchorOutcomes, cutAlign: cutAlignStats, gapFills } = planBeatFills(plan, layN, scoreFloor, {
		noImage: !layOpts.imageBroll,
		dedupScope: layOpts.dedupScope,
		markWeight: layOpts.markWeight,
		markLookup: layOpts.markLookup,
		...(cutStarts ? { cutAlign: { ratio: cutRatio, starts: cutStarts } } : {}),
		...(gapModeEff !== "none" ? { gapFill: gapModeEff } : {}),
	});
	// 对齐实测明示（人读；机读走 lay JSON 的 cut_align 条件键）
	if (cutAlignStats) {
		log.info(
			`句界吸附：字幕句起点 ${cutAlignStats.starts_total} · 恰逢镜头切点 ${cutAlignStats.aligned}（实测 ${Math.round(cutAlignStats.ratio * 100)}% · 目标 ${Math.round(cutAlignStats.target * 100)}%——三成错开是拍板内的自然节奏，非缺陷）`,
		);
	}
	// 关键词锚落位回报（add-keyword-anchored-broll）：逐锚明示，degraded MUST NOT 静默
	if (anchorOutcomes.length) {
		const cnt = { planned: 0, pinned: 0, degraded: 0 };
		for (const d of anchorOutcomes) {
			cnt[d.status]++;
			if (d.status === "degraded") {
				log.warn(`${d.beat} 锚「${d.keyword}」降级：${d.reason ?? "未知原因"}——该锚退化普通槽，区间照常序贯填充`);
			} else {
				log.info(
					`${d.beat} 锚「${d.keyword}」@ ${d.at_sec}s → clip ${d.clip_id} 钉 ${d.track_st}s（提前量 0.5s${d.status === "pinned" ? " · 用户钉选候选占锚槽" : ""}）`,
				);
			}
		}
		log.info(`关键词锚：钉位 ${cnt.planned} · 用户钉选 ${cnt.pinned} · 降级 ${cnt.degraded}（共 ${anchorOutcomes.length} 锚）`);
	}
	const markOn = typeof layOpts.markWeight === "number" && layOpts.markWeight > 0;
	if (markOn) {
		log.info(`美观度权重：mark 缓存命中 ${markStats.hit} 候选 · 中性 ${markStats.neutral} 候选（w=${layOpts.markWeight}）`);
	}
	// pinned 让位必须明示（matrix-command spec：冲突后到让位并 summary 明示，MUST NOT 静默）
	if (pinnedOutcome.yielded.length) {
		log.warn(
			`pinned 候选未能全部入选：${pinnedOutcome.yielded.join("、")} 让位（pinned 间冲突后到让位/供长不足/被排除）——` +
				`其余 pinned 已优先满足；要强保它们可减少同 beat 的 pinned 数或放宽槽位（--lay/--top-k）后重跑`,
		);
	}
	const slotCount = [...fills.values()].flat().reduce((n, s) => n + s.length, 0);
	log.step(`▶ 候选铺轨（${layN} 轨 · 平铺 ${slotCount} 槽位 · ${clipIds.size} 个 clip）…`);
	const gtrkDir = dirname(gtrkPath);
	const previewDir = join(gtrkDir, ...BROLL_PREVIEW_DIR.split("/"));
	await mkdir(previewDir, { recursive: true });

	// 候选速查表（图片运镜准备与素材引用共用）
	const candById = new Map<string, PlanResult>();
	for (const beat of plan.beats) for (const c of mergedCandidates(beat)) if (!candById.has(c.clip_id)) candById.set(c.clip_id, c);

	// ── 图片运镜准备（3.2/3.3/3.4）：在**任何云端调用之前**过计费确认门——拒绝 = 整轮中止零调用 ──
	const canvasArr = Array.isArray(gtrk.video_size) ? (gtrk.video_size as number[]) : [1920, 1080];
	const prep = await prepareImageMoveAssets({
		fills,
		candById,
		gtrkDir,
		canvas: [canvasArr[0]!, canvasArr[1]!],
		yes: imageOpts.yes,
		deps: imageOpts.deps,
	});
	if (prep.declined) {
		log.err(
			"已取消：图片运镜计费确认被拒绝——本轮铺轨中止，工程文件零改动、零云端调用（broll-plan.json 照常可用）。" +
				"可用 --yes 跳过确认，或 --no-image-broll 排除图片候选后重跑。",
		);
		return {
			declined: true,
			imageBilling: prep.billing,
			lay: {
				declined: true,
				laidTracks: [],
				laidClips: 0,
				removedTracks: [],
				keptEditedTracks: [],
				blackTrack: null,
				blackBedHoleSec: 0,
				blackBedHoles: [],
			},
		};
	}

	// 本地候选封面现抽（覆盖 struct_meta 候选全集，不只槽位 clip）
	const covers = await extractLocalCovers(plan, gtrkDir);

	// 复用时的 source 继承：旧 broll 记录里该 clip 是 raw 回落的,复用后仍标 raw(内容来源不因复用改变)
	const prevSource = new Map<string, "preview" | "raw">();
	const prevBroll = (gtrk.struct_meta as Record<string, unknown> | undefined)?.broll as
		| { beats?: { candidates?: { clip_id?: unknown; source?: unknown; preview_path?: unknown }[] }[] }
		| undefined;
	for (const b of prevBroll?.beats ?? []) {
		for (const c of b.candidates ?? []) {
			if (typeof c.clip_id === "string" && c.preview_path && (c.source === "preview" || c.source === "raw")) {
				prevSource.set(c.clip_id, c.source);
			}
		}
	}

	// 备好全部槽位 clip 的素材引用（按 clip_id 幂等复用）
	const downloads = new Map<string, DownloadedProxy>();
	const dlStats = { preview: 0, raw: 0, reused: 0, failed: 0, local: 0 };
	for (const clipId of clipIds) {
		const cand = candById.get(clipId);
		if (!cand) continue;
		// ── 图片候选：素材引用由运镜准备阶段备好（injectedMaterials + FillSlot.material_id），此处零动作 ──
		if (cand.kind === "image") continue;
		// ── 本地候选（4.1）：免下载免代理，rel 直指素材绝对路径 ──
		if (isLocalPlanResult(cand)) {
			const src = cand.local_path;
			if (!src || !existsSync(src)) {
				log.warn(`本地素材缺失（clip ${clipId}）：${src ?? "无 local_path"}——该候选槽位跳过（素材可能在未挂载的可移动盘上，重建索引或挂回后重跑）`);
				dlStats.failed++;
				continue;
			}
			downloads.set(clipId, { rel: src, source: "local" });
			dlStats.local++;
			continue;
		}
		const rel = `${BROLL_PREVIEW_DIR}/${clipId}.mp4`;
		const abs = join(gtrkDir, ...rel.split("/"));
		if (existsSync(abs)) {
			const prev = prevSource.get(clipId);
			if (prev !== "raw") {
				downloads.set(clipId, { rel, source: prev ?? "preview" });
				dlStats.reused++;
				continue;
			}
			// 上次是 raw 回落:重试 preview(backfill 可能已补产),成功即覆盖换代理;失败沿用本地 raw
			const retried = await downloadProxy(cand, abs, { previewOnly: true });
			if (retried === "preview") {
				downloads.set(clipId, { rel, source: "preview" });
				dlStats.preview++;
				log.info(`clip ${clipId} 代理已补产,已从原片回落态换回 preview`);
			} else {
				downloads.set(clipId, { rel, source: "raw" });
				dlStats.reused++;
			}
			continue;
		}
		const got = await downloadProxy(cand, abs);
		if (got) {
			downloads.set(clipId, { rel, source: got });
			dlStats[got]++;
		} else {
			dlStats.failed++;
		}
	}

	let { next, summary, warnings } = layBrollTracks({
		gtrk,
		plan,
		lay: layN,
		fills,
		downloads,
		covers,
		injectedMaterials: prep.injected,
		sourceLayer: layOpts.sourceLayer,
		generatedAt: new Date().toISOString(),
		planPath: "split/broll-plan.json",
		blackBed,
		forceRelay,
		...(gapModeEff !== "none" ? { gapFill: { mode: gapModeEff, planned: gapFills ?? [] } } : {}),
	});

	// ── ②-B 拒铺：存在「自产内容但已被你编辑」的轨且未开逃生门 → 一个字节都不动工程 ──
	// 报因三件套（缺一不可）：① 是哪条轨 ② 判定证据 ③ 下一步与逃生门用法。
	if (summary.refused) {
		const list = summary.keptEditedTracks;
		log.err(
			`拒绝铺轨：${list.length} 条候选轨已被你在客户端编辑过（track_index ${list.join("/") || "-"}）——` +
				"本次不剥它们、也不铺新轨，工程文件零改动。",
		);
		for (const w of warnings) log.warn(w); // 逐轨证据：clip 数 vs 登记条数 / material 是否已变 broll-raw-*
		log.warn(
			"下一步二选一：① 在客户端处置那条轨（删掉 / 移走 / 改用别的轨）后重跑本命令；" +
				"② 确知要丢弃那条轨上的编辑 → 加 --force-relay 强制剥离重铺" +
				"（会删掉已确认原片的 broll-raw-* 素材登记，盘上原片文件成孤儿，不可恢复）。",
		);
		log.warn("已产出的 broll-plan.json 与已落盘的 preview 代理照常可用——拒的只是「改工程」这一步。");
		// 拒铺 = 工程零改动 = 本次没写回 → 不做素材自检（`integrity` 字段缺席即「本次没查」）
		return {
			lay: {
				refused: true,
				keptEditedTracks: list,
				laidTracks: [],
				laidClips: 0,
				removedTracks: [],
				blackTrack: null,
				blackBedHoleSec: 0,
				blackBedHoles: [],
				downloads: dlStats,
			},
			// 拒铺前运镜可能已生成（产物留在 assets/broll-move/ 供下轮复用）——账面如实报
			...(prep.hasImage ? { imageBilling: prep.billing } : {}),
		};
	}

	// 黑底/黑片 PNG 落盘：客户端能凭 id 现画重建，但剪映导出/云渲/第三方读的是盘上的文件，故必须真写字节。
	// 落盘失败 → 撤掉黑轨与主轨黑片填充重铺（宁可无黑底/留 gap，也不留「.gtrk 说有、盘上没有」）。
	// gap 填充的 solid 兜底与黑底垫轨共用同一确定性 ex-solid 素材（adjust-main-track-gap-fill）。
	const gapSolidUsed = (summary.gapFill?.fills ?? []).some((f) => f.kind === "solid");
	if (summary.blackTrack !== null || gapSolidUsed) {
		const canvas = gtrk.video_size as number[];
		const spec = { hex: BLACK_BED_HEX, width: canvas[0]!, height: canvas[1]! };
		const rel = solidRelPath(spec);
		const abs = join(gtrkDir, ...rel.split("/"));
		try {
			if (!existsSync(abs)) {
				await mkdir(dirname(abs), { recursive: true });
				// 临时文件 + rename 原子落地：中断不留半包 PNG（半包会被下次「同名即复用」静默命中）
				const tmp = `${abs}.tmp-${process.pid}`;
				await writeFile(tmp, encodeSolidPng(spec));
				await rename(tmp, abs);
			}
		} catch (e) {
			log.warn(
				`纯黑 PNG 落盘失败（${rel}）：${(e as Error).message} —— 本次不铺黑底垫轨${
					gapSolidUsed ? "、主轨黑片填充一并回退（留 gap——客户端若开主轨磁吸请注意与配音错位的风险）" : ""
				}，候选轨照常。`,
			);
			({ next, summary, warnings } = layBrollTracks({
				gtrk,
				plan,
				lay: layN,
				fills,
				downloads,
				covers,
				injectedMaterials: prep.injected,
				sourceLayer: layOpts.sourceLayer,
				generatedAt: new Date().toISOString(),
				planPath: "split/broll-plan.json",
				blackBed: false,
				// 重跑必须原样带上 forceRelay：漏传会让「已授权强剥」的这次退回拒铺态（半截行为）
				forceRelay,
				// PNG 无字节 ⇒ solid 兜底不可用 ⇒ gap 填充整体回退 none（fast 的 candidate 槽位同滤；
				// 半套填充比已知现状更糟——磁吸风险以告警明示）
			}));
		}
	}

	// 时码来源登记（add-consume-side-reprojection 7.2，纯追加可选字段）：本 change 只**登记**，不据此判失效
	const written = withTimecodeSource(next, "broll", reproj);
	writeGtrkAtomic(gtrkPath, written, mtimeMs);
	// 素材落盘自检（material-integrity-check）：对象取**写回后**的那份（报的必须是「用户现在打开工程会遇到什么」）；
	// 只读、非致命——查出悬空 MUST NOT 改 ok / 退出码 / 写回结果。人读输出压在铺轨完成行之后（见下）。
	const integrity = safeCheckMaterialIntegrity({ gtrk: written, gtrkDir, log });
	const bedNote =
		summary.blackTrack !== null
			? ` · 纯黑底垫轨 track_index ${summary.blackTrack}`
			: summary.blackBedSkipped === "audio_driven"
				? " · 黑底垫轨跳过（音频驱动工程无口播保留轨，无遮挡对象——2026-08-21 拍板）"
				: blackBed
					? " · 未铺纯黑底垫轨"
					: " · 纯黑底垫轨已关闭（--no-black-bed）";
	// 剥离/保留如实呈现（ADDED「剥离与保留必须如实呈现」）：今天的完成日志对删除只字不提，是静默铲轨的帮凶
	const stripNote =
		`剥离 ${summary.removedTracks.length} 条旧自产轨` +
		(summary.removedTracks.length ? `（track_index ${summary.removedTracks.join("/")}）` : "") +
		(forceRelay ? "（含 --force-relay 强剥的已编辑轨）" : "") +
		" · ";
	const keptNote = summary.keptEditedTracks.length
		? ` · 保留 ${summary.keptEditedTracks.length} 条已被你编辑的轨（track_index ${summary.keptEditedTracks.join("/")}，本次未剥，因由见下方告警）`
		: "";
	const imageNote = prep.hasImage
		? ` · 图片运镜 生成 ${prep.billing.generated} / 复用 ${prep.billing.reused}${prep.failures.length ? ` / 静态兜底 ${prep.failures.length}` : ""}`
		: "";
	log.ok(
		`铺轨完成：${stripNote}${summary.laidTracks.length} 条候选轨（track_index ${summary.laidTracks.join("/") || "-"}）· 平铺 ${summary.laidClips} 个颗粒 / ${clipIds.size} 个 clip` +
			`（代理 ${dlStats.preview} · 原片回落 ${dlStats.raw} · 复用 ${dlStats.reused}${dlStats.local ? ` · 本地直引 ${dlStats.local}` : ""}${dlStats.failed ? ` · 失败 ${dlStats.failed}` : ""}${imageNote}）${bedNote}${keptNote}`,
	);
	log.info("opencut 打开工程即见候选轨：轨道头小眼睛可开关对比；确认下载原片属挑选 UI（E-P1）。");
	// 主轨 gap 填充明示（adjust-main-track-gap-fill）：生效才出（口播 / none / 不适用零噪音）
	if (summary.gapFill) {
		const gf = summary.gapFill;
		const cnt = { candidate: 0, extend: 0, solid: 0 };
		for (const f of gf.fills) cnt[f.kind]++;
		log.info(
			gf.fills.length
				? `主轨 gap 填充（${gf.mode}）：${gf.fills.length} 处共 ${gf.filledSec}s（候选 ${cnt.candidate} · 延长 ${cnt.extend} · 黑片 ${cnt.solid}）——主轨零 gap，客户端主轨磁吸安全`
				: `主轨 gap 填充（${gf.mode}）已开启：本轮无洞可填（主轨本就零 gap）`,
		);
	}
	for (const w of warnings) log.warn(w);
	if (dlStats.raw > 0) {
		log.warn("部分候选无 preview 代理已回落原片（体积较大）——服务端 backfill 后重跑本命令可换回代理。");
	}
	if (integrity) reportMaterialIntegrity(integrity, log);
	return {
		lay: {
			refused: false,
			sourceLayer: summary.sourceLayer,
			// 全局不二用统计（add-broll-dedup-and-layering）：宁空不重复的空槽事件数 + 跳剪避让枯竭放行数
			dedup: {
				scope: layOpts.dedupScope ?? "scene",
				emptySlots: fillStats.emptySlots,
				// 其中因窗口精修（残片收缩后不足最小槽长）而留空的部分——SLIVER_MIN_SEC 的真实代价
				// 只可能在此显形（候选充足时恒 0，候选稀疏工程才可能非 0）
				emptySlotsByRefine: fillStats.emptySlotsByRefine,
				// 取用了高运动段的槽位数（降权不排除，候选稀疏时仍会取——让「为什么这颗抖」可追溯）
				hotSlotsPlaced: fillStats.hotSlotsPlaced,
				adjacentWaived: fillStats.adjacentWaived,
			},
			// mark 融合账面（add-audio-project-atoms）：仅开启时出现（默认 0 时 lay JSON 逐字节不变）
			...(markOn ? { mark_weight: layOpts.markWeight, mark_hit: markStats.hit, mark_neutral: markStats.neutral } : {}),
			// pinned 裁定账面（plan 可编辑契约）：plan 里有钉选才出现（无 pinned 时 lay JSON 逐字节不变）
			...(pinnedOutcome.requested.length
				? {
						pinned: {
							requested: pinnedOutcome.requested.length,
							placedSlots: fillStats.pinnedPlaced,
							yielded: pinnedOutcome.yielded,
						},
					}
				: {}),
			// 对齐实测账面（adjust-shot-cut-sentence-align）：吸附激活才出现（关闭/降级时 lay JSON 逐字节零新键）
			...(cutAlignStats
				? {
						cut_align: {
							target: cutAlignStats.target,
							starts_total: cutAlignStats.starts_total,
							aligned: cutAlignStats.aligned,
							ratio: cutAlignStats.ratio,
						},
					}
				: {}),
			// 关键词锚账面（add-keyword-anchored-broll）：plan 里有锚才出现（无锚时 lay JSON 逐字节不变）
			...(anchorOutcomes.length
				? {
						anchors: {
							planned: anchorOutcomes.filter((d) => d.status === "planned").length,
							pinned: anchorOutcomes.filter((d) => d.status === "pinned").length,
							degraded: anchorOutcomes.filter((d) => d.status === "degraded").length,
						},
						anchor_details: anchorOutcomes.map((d) => ({
							beat: d.beat,
							keyword: d.keyword,
							at_sec: d.at_sec,
							track_st: d.track_st,
							clip_id: d.clip_id,
							status: d.status,
							...(d.reason ? { reason: d.reason } : {}),
						})),
					}
				: {}),
			laidTracks: summary.laidTracks,
			laidClips: summary.laidClips,
			removedTracks: summary.removedTracks,
			keptEditedTracks: summary.keptEditedTracks,
			blackTrack: summary.blackTrack,
			// 音频驱动跳铺明示（adjust-black-bed-audio-driven-skip）：仅跳铺时出现该键——
			// 口播 / --no-black-bed 路径的 lay JSON 逐字节零新键
			...(summary.blackBedSkipped ? { blackBedSkipped: summary.blackBedSkipped } : {}),
			// 主轨 gap 填充账面（adjust-main-track-gap-fill）：仅音频驱动形态且 mode ≠ none 时出现
			...(summary.gapFill
				? { gap_fill: { mode: summary.gapFill.mode, filled_sec: summary.gapFill.filledSec, fills: summary.gapFill.fills } }
				: {}),
			// 空洞是「告知」不是「阻断」：人读走上面的 warnings 通道单独成行，机读全量出这两个字段，
			// agent 无需真机看片即可回报哪几段是纯黑（MUST NOT 按告警阈值过滤）。
			blackBedHoleSec: summary.blackBedHoleSec,
			blackBedHoles: summary.blackBedHoles,
			downloads: dlStats,
			// 运镜失败明细（D6 机读 summary）：仅图片候选参与本轮时出现；失败槽位已静态兜底
			...(prep.hasImage ? { image_move_failures: prep.failures } : {}),
		},
		...(integrity ? { integrity } : {}),
		...(prep.hasImage ? { imageBilling: prep.billing } : {}),
	};
}

/** 下载代理：preview（直连或推导）→ 404/失败回落 raw → 都失败返回 null（调用方丢槽位）。
 * previewOnly=true 时不回落 raw（raw 回落态的代理重试用,失败即返回 null 沿用旧文件）。 */
async function downloadProxy(
	cand: import("../lib/matrix").PlanResult,
	absPath: string,
	opts: { previewOnly?: boolean } = {},
): Promise<"preview" | "raw" | null> {
	const tryFetch = async (url: string): Promise<Buffer | null> => {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
			if (!res.ok) return null;
			return Buffer.from(await res.arrayBuffer());
		} catch {
			return null;
		}
	};
	const previewUrl = previewUrlFor(cand);
	if (previewUrl) {
		const bytes = await tryFetch(previewUrl);
		if (bytes) {
			await writeFile(absPath, bytes);
			return "preview";
		}
	}
	if (opts.previewOnly) return null;
	if (typeof cand.url === "string" && cand.url) {
		const raw = await tryFetch(cand.url);
		if (raw) {
			await writeFile(absPath, raw);
			log.warn(`clip ${cand.clip_id} 无 preview 代理，已回落原片（${(raw.length / 1048576).toFixed(1)}MB）`);
			return "raw";
		}
	}
	log.warn(`clip ${cand.clip_id} 代理与原片均下载失败，该候选槽位跳过`);
	return null;
}

/** ad-hoc 模式：单 query，--out 落文件 / 缺省 stdout。 */
async function runAdhoc(query: string, ctx: SearchCtx, opts: MatrixOpts): Promise<MatrixResult> {
	log.step(`▶ ad-hoc 检索「${query}」（${ctx.memberType === "local" ? "本地索引" : `${ctx.memberType} 口`}）…`);
	const data = await ctx.search(query);
	const results = data.results ?? [];
	log.ok(`${results.length} 条候选（召回 ${data.recalled ?? "?"}）`);

	const result: MatrixResult = {
		ok: true,
		mode: "search",
		memberType: ctx.memberType,
		...(ctx.columnId ? { columnId: ctx.columnId } : {}),
		results,
		counts: { beats: 0, queries: 1, results: results.length, errors: 0 },
	};
	if (opts.out) {
		const outPath = resolve(opts.out);
		await writeFile(outPath, JSON.stringify({ query, recalled: data.recalled, results }, null, 2));
		log.ok(`结果已落盘：${outPath}`);
		result.outPath = outPath;
	} else if (!opts.json) {
		// 人读模式且未落盘：给精简候选摘要
		for (const r of results.slice(0, 10)) {
			const seg = r.segments?.[0];
			const where = r.local_path ? ` · ${r.local_path}` : "";
			log.info(`clip ${r.clip_id} · score ${r.score}${seg ? ` · 最佳段 ${seg.start}s–${seg.end}s（锚点 ${seg.best}s）` : ""}${where}${r.note ? ` · ${String(r.note).slice(0, 40)}` : ""}`);
		}
	}
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

/** 工程 slug（与 split.ts 同式：保留 CJK，分隔符折叠为 -）。 */
function slugify(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	return s || "project";
}
