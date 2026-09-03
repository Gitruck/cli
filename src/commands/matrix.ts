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
import { resolve, join, dirname, basename, isAbsolute } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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
	SIGNAL_COVERAGE_LOW,
	brollMaterialIdFor,
	layBrollTracks,
	mergedCandidates,
	planBeatFills,
	previewUrlFor,
	projectHasShieldTrack,
	r3,
	type DedupScope,
	type DownloadedProxy,
	type FillSlot,
	type GapFillEntry,
	type GapFillMode,
	type MarkLookup,
	type SourceLayer,
	wouldRefuseLay,
} from "../lib/matrix-lay";
import { type ArrangeEndpoint, estimateGate, resolveArrangeUrl } from "../lib/arrange-client";
import { type ArrangeMode, isLocalArrangeScope, resolveArrangeMode, runArrangeWithFallback } from "../lib/arrange-gate";
import {
	classifyCutsProbe,
	emptyNotApplicable,
	type CutsProbeSlot, MAX_QC_ROUNDS, flashRiskNotice, flashRiskOf, runArrangeQc,
	type FlashRiskNotApplicable,
} from "../lib/arrange-qc";
import { leadSentencesFrom, makeJudge, sqliteQcCache } from "../lib/arrange-qc-bind";
import { arrangeUnits, scaleOfRequest } from "../lib/arrange-metering";
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
import { fetchMaterials, type MatrixFetchDeps } from "../lib/matrix-fetch";
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
	TOP_K_DEFAULT,
	validatePlanForLay,
	type BrollPlan,
	type PlanAnchor,
	type QueryOutcome,
	type SearchRespData,
	type Tier,
} from "../lib/matrix";
import type { PlanResult } from "../lib/matrix";
import {
	MATERIAL_BILLING_NOTE,
	MATERIAL_SCOPE_DEFAULT,
	MATERIAL_TOP_K_DEFAULT,
	buildMaterialSearchBody,
	decideLayUpsell,
	decideMaterialUpsell,
	deriveCopyrightLabel,
	filterMaterialsByDuration,
	materialEndpointFor,
	parseMaterialDurationBounds,
	parseMaterialScope,
	parseMaterialTopK,
	searchMaterialOnce,
	type MaterialResult,
	type MaterialScope,
	type MaterialUpsell,
} from "../lib/matrix-material";
import {
	describeImages,
	flagDescMismatchNote,
	getNearestCachedMark,
	getNearestCachedHighlight,
	resolveDescribeUrl,
	runDescribeItems,
	summarizeFlagDescMismatch,
	summarizeDescribeCoverage,
	describeCoverageNote,
	type DescribeCoverage,
	type DescribeEndpoint,
	toDescribeMeta,
	type DescribeWorkItem,
	type MaterialDescribe,
	type OverlayFlagDim,
} from "../lib/describe";
import { tmpDir } from "../lib/paths";
import {
	BALANCE_INSUFFICIENT_CODE,
	EMBED_CREDITS_PER_IMAGE,
	EMBED_DIM,
	EMBED_MODEL_ID,
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
	embedSpaceId,
	extractFrameJpg,
	getCachedQueryVec,
	indexLocalMaterials,
	listMaterialFiles,
	localIndexDbPath,
	materialKindForPath,
	openLocalIndexDb,
	putCachedQueryVec,
	type IndexRunResult,
	type IndexSessionHooks,
} from "../lib/local-index";
import { loadLocalIndex, pathInDirs, searchLoadedIndex, type LoadedIndex } from "../lib/local-search";
import { requireFfmpeg, resolveFfmpeg } from "../lib/ffmpeg";
import { EXCLUDE_RECENT_DEFAULT, filterRecentlyUsed, recentBgmKeys } from "../lib/bgm-history";
import { log, routeLogsToStderr } from "../lib/log";

interface MatrixOpts {
	/** matrix index：解码路径（speedup-matrix-index-proxy-decode）。 */
	decodePath?: string;
	proxyWidth?: string;
	proxyScaler?: string;
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
	/** `--dirs a,b`：本地素材**文件夹或单个素材文件**（index 的索引范围 / --local 的检索域）。
	 *  传文件即把域收窄到该素材——解说链一稿对一片时 MUST 这么传，否则邻片候选会抢占。
	 *
	 *  ⚠️ 类型是 `string | string[]`：commander 挂了 `collectPathArg`，**重复传即累加**，
	 *  于是真实运行时恒为数组；单串形态保留是为了内部调用与既有测试（`{ dirs: "D:/x" }`）逐字兼容。
	 *  MUST NOT 拿 `!!opts.dirs` 判「有没有传」——collect 无默认值，未传时仍是 `undefined`，
	 *  但一旦有默认值 `[]` 就会恒真（本仓统一用 `parseDirsOption(...).length` 判，见 assertModeOptions）。 */
	dirs?: string | string[];
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
	/** `--materials <a,b,...>`：matrix describe 直接理解素材文件（视频按场景抽帧、图片直传）。
	 *  与 `--dirs` 同口径（同一个 `collectPathArg` + `parseDirsOption`），可重复传累加。 */
	materials?: string | string[];
	/** `--source-window <start,end>`：--local 检索源时间窗过滤（秒；段级交集）。 */
	sourceWindow?: string;
	// ── 美观度权重（add-audio-project-atoms，仅 matrix lay）──
	/** `--mark-weight <0..1>`：融合分 = sim×(1-w)+(mark/100)×w；默认 0 零回归。 */
	markWeight?: string;
	/** `--highlight-weight <0..1>`：看点权重（与 mark 正交）；默认 0 零回归。 */
	highlightWeight?: string;
	// ── 句界吸附（adjust-shot-cut-sentence-align）──
	/** `--cut-align <ratio>`：字幕句起点吸附目标比例（默认 0.7；0=关闭回旧节奏切槽）。 */
	cutAlign?: string;
	// ── 主轨 gap 填充（adjust-main-track-gap-fill）──
	/** `--gap-fill <fast|solid|none>`：音频驱动工程主轨空洞填充（缺省 solid）。 */
	gapFill?: string;
	// ── 云端编排（add-broll-arrange-atom P3.1）──
	/** `--arrange <local|shadow|cloud>`：编排取数路（缺省 local = 行为不变）。 */
	arrange?: string;
	/** `--arrange-cost-cap <n>`：云端编排本次编排量硬上限。 */
	arrangeCostCap?: string;
	/** `--arrange-qc`：编排期 QC（L2 卡点句画音对齐闭环，落轨前收敛，零渲染）。缺省关。 */
	arrangeQc?: boolean;
	/** `--arrange-estimate-only`：只报编排量，走到计价确认那一步就停（零云端调用、工程零改动）。 */
	arrangeEstimateOnly?: boolean;
	// ── 通用三态素材检索（add-matrix-material-search，仅 matrix material）──
	/** `--scope clip|image|audio`：素材形态（缺省 audio）。 */
	scope?: string;
	/** `--commercial-only`：仅可商用（internal 档传 copyright_scope=commercial；external 公开口本就只含可商用）。 */
	commercialOnly?: boolean;
	/** `--min-duration <秒>` / `--max-duration <秒>`：时长区间（BGM 按成片时长挑）。 */
	minDuration?: string;
	maxDuration?: string;
	/** `--diversity`：去同质化（避免返回雷同素材）。 */
	diversity?: boolean;
	/** `--exclude-recent <n>` / `--no-exclude-recent`：BGM 选曲避让窗口（scope=audio）。 */
	excludeRecent?: string | false;
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
	/** matrix fetch 注入面（add-matrix-raw-fetch）：resign/下载替身透传给 lib 层（缺省 = 真实云链）。 */
	matrixFetch?: MatrixFetchDeps;
	/** matrix index 整轮替身（缺省 = 真实 indexLocalMaterials）。
	 *  ⚠️ 只替换「索引这一轮」，命令层的域解析/枚举分项/诊断/退出码判定照常真跑 ——
	 *  没有它，零枚举以外的结局（部分为空、断链上报）在单测里根本走不到：
	 *  真索引一个素材必然要 ffprobe + 云端 embed，而单测两样都不许有。 */
	indexRun?: typeof indexLocalMaterials;
}

export function registerMatrix(program: Command): void {
	program
		.command("matrix [words...]")
		.description(
			"B-roll 检索：无 positional=消费 split/dispatch.json 的 film_broll 队列产候选清单；`matrix search \"<query>\"`=单条 ad-hoc 剪辑向检索；`matrix material \"<query>\"`=通用三态素材检索（下载向，clip/image/audio，BGM 主场）；`matrix fetch <clip_id...>`=精剪期拉原片（对已授予素材免费重签+下载落盘）；`matrix index --dirs <a,b>`=本地素材索引；`matrix describe`=按需理解零件（plan 注入/素材文件）；`matrix lay`=消费（agent 编辑后的）plan 文件铺轨",
		)
		.option("--project <dir>", "oralcut 产物目录（定位 split/dispatch.json 与产物落点）")
		.option("--dispatch <path>", "显式指定 dispatch.json（非标准布局兜底）")
		.option("--column <id>", "栏目配置 id（缺省取 config defaultColumn，再缺省内置默认栏目；仅云端模式）")
		.option("--top-k <n>", `每 query 候选数上限（覆盖派单 shots 翻译；云端服务端上限 50；matrix material 缺省 ${MATERIAL_TOP_K_DEFAULT}）`)
		.option("--material-class <c>", "素材类型 real_shot|concept（仅矩阵成员口；覆盖栏目 material_class_policy）")
		.option("--local", "本地检索模式：走本地素材索引检索（须配 --dirs；跳过身份探针，不触任何云端检索端点）")
		.option(
			"--dirs <a,b,...>",
			"本地素材文件夹**或单个素材文件**（逗号分隔，或**重复传** --dirs 累加）——matrix index 的索引范围 / --local 的检索域；" +
				"传文件即把检索域收窄到该素材。**路径里有英文半角逗号时用重复传**（整串在盘上存在时也会自动不拆；中文全角「，」从不参与拆分）",
			collectPathArg,
		)
		.option("--scene-threshold <f>", "matrix index：场景切换检测阈值（ffmpeg select gt(scene,X)，默认 0.3）")
		.option(
			"--stability-threshold <f>",
			"matrix index：场景稳定性判定阈值——场景内最大帧间 scene score 低于此值判 stable（固定机位），抽帧收敛为中点 1 帧（默认 0.05，保守值待标定；误判 stable 丢检索粒度、误判 unstable 只是不省钱，宁严勿松）",
		)
		.option("--rebuild", "matrix index：忽略 size:mtime 指纹，强制全量重建索引")
		.option(
			"--decode-path <mode>",
			"matrix index：场景检测的解码路径 auto|gpu|cpu|full——auto 自动探测硬解并逐素材降级（推荐），gpu/cpu/full 钉死某档且失败不降级（对照与排障用；默认 full = 旧行为）",
		)
		.option("--proxy-width <n>", "matrix index：代理解码宽度（默认 384；再往下保真度明显劣化，勿随手调小）")
		.option(
			"--proxy-scaler <name>",
			"matrix index：代理缩放算法（默认 neighbor——点采样不滤波，实测比默认 bicubic 又快又准；改这个基本只有做对照实验才需要）",
		)
		.option(
			"--plan <path>",
			"matrix describe：理解该 plan 的 top 候选并把产物写回 result.describe；matrix lay：显式指定要消费的 plan 文件（缺省 <project>/split/broll-plan.json）",
		)
		.option(
			"--materials <a,b,...>",
			"matrix describe：直接理解素材文件（逗号分隔，或**重复传** --materials 累加；视频按场景抽帧、图片直传）。" +
				"**路径里有英文半角逗号时用重复传**（与 --dirs 共用同一解析口径）",
			collectPathArg,
		)
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
			"--highlight-weight <w>",
			"仅 matrix lay：看点权重 0..1（默认 0 关闭零回归）——与 --mark-weight 正交（mark=画面好不好看，highlight=有没有看点：信息量/戏剧性/情绪强度/稀缺性）；两权之和钳到 1，看点分取 describe 理解缓存，无缓存候选中性（权重回吐给 sim）",
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
			"音频驱动工程主轨空洞填充 fast|solid|none（缺省 solid）：fast=放宽 score 地板从候选池随便填、耗尽延长相邻颗粒、" +
				"再耗尽跨 beat 借候选、剩下短于最小镜头长的残洞也补真画面（补不满整段才垫黑片）——**尽量不留黑**；" +
				"solid=黑片垫齐（精修时一眼看出「这里没匹配到」）；none=留 gap（客户端主轨磁吸开启时 gap 会被吸除、后续画面整体前移与配音错位，慎用）。" +
				"口播工程主轨为 A-roll，本参数不适用（照旧留空语义）",
		)
		.option(
			"--arrange <mode>",
			"B-roll 编排取数路 local|shadow|cloud，**按素材来源自动定档，一般不用传**：" +
				"铺你自己电脑里的素材=cloud（编排在云端做，算法只在服务端迭代，按「编排量」计费，" +
				"跑前报预估并征求确认、--yes 跳过）；铺素材矩阵的素材=local（编排仍在本机、不计费，逐字不动）。" +
				"shadow=本机照跑照铺轨、云端只对拍不采纳；cloud=采纳云端产物，自校验不一致时回落本机并大声告知。" +
				"⚠️ 本地素材路上 --arrange local **已不受理**（编排只在服务端迭代，留旧路等于让你在不知情时拿到另一套算法的结果），" +
				"且云端拿不到产物时**直接报错**、不会悄悄换算法把活干完。" +
				"它也不是省钱开关——用素材矩阵的素材同样要付检索费，两条路都要花钱、只是花在不同环节",
		)
		.option(
			"--arrange-cost-cap <n>",
			"云端编排单次编排量上限：超限服务端**前置拒绝**、零执行零计费（不是跑到一半掐断）。只在 --arrange shadow|cloud 时有意义",
		)
		.option(
			"--arrange-qc",
			"编排期质检（缺省关）：**落轨之前**就查每个 beat 的卡点句「画面有没有给到稿子说的东西」，" +
				`没给到就换候选重排，最多 ${MAX_QC_ROUNDS} 轮，到限即交付并如实登记还差哪几句。全程零渲染——` +
				"替代「铺完→渲→看→重铺→再渲」那两轮。⚠️ 判定走素材理解口，**按帧计费**（每个卡点句 1 帧/轮），" +
				"跑前会报预估并征求确认（--yes 跳过）",
		)
		.option(
			"--arrange-estimate-only",
			"只要预估不要执行：走到云端编排的计价确认那一步就停，报出编排量后成功返回——**零云端调用、工程文件零改动**。" +
				"⚠️ 它省的是**云端那一次调用与其计费**（以及其后的候选下载与落轨），不是整条链：" +
				"编排量的分母（beat 数/候选段数/轨数/标定遍数）本来就要读工程、读 plan、做重投影才算得出，该走的还得走。" +
				"与 --yes 同时给时以本开关为准（--yes 的意思是「别问我」，不是「无论如何都跑」）",
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
		.option(
			"--scope <s>",
			`matrix material：素材形态 clip|image|audio（缺省 ${MATERIAL_SCOPE_DEFAULT}——本零件第一场景是 BGM；要剪辑向 segments 请用 matrix search）`,
		)
		.option(
			"--commercial-only",
			"matrix material：只搜可商用素材（矩阵成员口传 copyright_scope=commercial；缺省搜全库含非商用）——公开口本就只含可商用素材，该档位会显式提示",
		)
		.option("--min-duration <sec>", "matrix material：最短时长（秒）——BGM 按成片时长挑")
		.option("--max-duration <sec>", "matrix material：最长时长（秒）")
		.option("--diversity", "matrix material：去同质化，避免返回雷同素材")
		.option(
			"--exclude-recent <n>",
			`matrix material --scope audio：避让最近 n 首用过的 BGM（缺省 ${EXCLUDE_RECENT_DEFAULT}；历史由 audio lay 落轨自动记账）`,
		)
		.option("--no-exclude-recent", "matrix material --scope audio：关闭选曲避让（允许复用近期曲目）")
		.option("--out <file>", "ad-hoc 模式：结果落文件（缺省输出 stdout）；matrix fetch：原片落盘目录（缺省 ./matrix-fetch/；绝不写剪映草稿目录）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[] | undefined, opts: MatrixOpts) => {
			await runMatrix(parseMatrixPositional(words), opts);
		});
}

/** positional 解析结果：plan（派单消费）/ search（剪辑向 ad-hoc）/ material（通用三态素材）/ fetch（精剪期拉原片）/ index（本地索引）/ describe（理解零件）/ lay（消费编辑后 plan）。 */
export type MatrixPositional =
	| { kind: "plan" }
	| { kind: "search"; query: string }
	| { kind: "material"; query: string }
	| { kind: "fetch"; clipIds: string[] }
	| { kind: "index" }
	| { kind: "describe" }
	| { kind: "lay" };

/** positional 解析：空 = 派单消费；`search <query…>`；`material <query…>`；`index`；`describe`；`lay`；其他开头 = 报错给正确用法。 */
export function parseMatrixPositional(words: string[] | undefined): MatrixPositional {
	if (!words || words.length === 0) return { kind: "plan" };
	if (words[0] === "material") {
		const q = words.slice(1).join(" ").trim();
		if (!q) throw new Error('检索词不能为空：gtrk matrix material "<query>"');
		return { kind: "material", query: q };
	}
	if (words[0] === "fetch") {
		const clipIds = words.slice(1);
		if (!clipIds.length) {
			throw new Error('用法：gtrk matrix fetch <clip_id...> [--out <dir>]——clip_id 来自 matrix search 的候选结果（两段式：先 search 挑定、再 fetch 拉原片）');
		}
		return { kind: "fetch", clipIds };
	}
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
			`未知子命令「${words[0]}」——ad-hoc 剪辑向检索：gtrk matrix search "<query>"；通用三态素材检索：gtrk matrix material "<query>"；精剪期拉原片：gtrk matrix fetch <clip_id...>；派单消费：gtrk matrix --project <dir>；本地索引：gtrk matrix index --dirs <a,b,...>；理解零件：gtrk matrix describe；消费编辑后 plan：gtrk matrix lay`,
		);
	}
	const query = words.slice(1).join(" ").trim();
	if (!query) throw new Error('检索词不能为空：gtrk matrix search "<query>"');
	return { kind: "search", query };
}

/**
 * 路径类参数的 commander 累加器（`--dirs` / `--materials`）。
 *
 * ⚠️ **无初值**：`prev` 首次为 `undefined`，未传时 `opts.dirs` 保持 `undefined`。
 * MUST NOT 给它挂 `[]` 默认值——`assertModeOptions` 里 `!!opts.materials` 那几条互斥判据
 * 会因为空数组恒真而全线误报（`--materials` 明明没传，describe 的 xor 却判「两个都给了」）。
 *
 * 修的另一个独立小坑：此前重复传 `--dirs "A" --dirs "B"` 是**后者静默覆盖前者**，
 * A 无声消失。静默丢弃用户显式传入的参数值在任何情况下都不该发生。
 */
export function collectPathArg(v: string, prev: string[] | undefined): string[] {
	return prev === undefined ? [v] : [...prev, v];
}

/** 一段 `--dirs` 原串的切分诊断（供零枚举时点名真因，见 runIndexMode）。 */
export interface DirsArgSegment {
	/** 切出来的原文（已 trim）。 */
	text: string;
	/** resolve 后的绝对路径（不存在的那些正是被凭空捏造出来的）。 */
	abs: string;
	exists: boolean;
	/** 原文不是绝对路径 ⇒ 它被按 cwd 拼成了一条根本没人传过的路径。 */
	relativeToCwd: boolean;
}

/** `--dirs` / `--materials` 的解析结果 + 切分诊断。 */
export interface DirsArgAnalysis {
	/** 原样收到的参数串（重复传即多条）。 */
	raws: string[];
	/** 解析后的绝对路径项（`parseDirsOption` 的返回值即此字段）。 */
	dirs: string[];
	/**
	 * 可疑切分：原串含英文半角逗号、拆出 ≥2 段、且**至少一段不存在**。
	 * 三个条件缺一不可——「检测到才说、说就点名」，MUST NOT 见逗号就喊
	 * （`--dirs "X:/夹A,X:/夹B"` 两段都在盘上时是完全正常的旧写法）。
	 */
	commaSplits: { raw: string; segments: DirsArgSegment[] }[];
}

/**
 * `--dirs a,b` / 重复传 解析（去空、resolve 绝对化）+ 切分诊断。
 *
 * ## 为什么要有「整串存在就不拆」这条前置短路
 *
 * 真机（2026-09-02 旅拍解说批）：一条 YouTube 下载的 B-roll 文件名带英文半角逗号
 * （`Visit Ketchikan Alaska - Bears, Salmon and Adventure….mp4`），裸 `split(",")`
 * 把它劈成两半、后半按 cwd resolve 成一条凭空捏造的相对路径，两半都不存在 ⇒
 * `listFilesMatching` 逐项软失败跳过 ⇒ 枚举 0 个 ⇒ 打「✅ 索引完成 0/0」⇒ **退出码 0**
 * （求证者单条命令、无管道、`rc=$?` 独立取值实测 `EXIT_CODE_IS=0`）。
 * 同一轮里另一条片的文件名带的是**全角**「，」(U+FF0C)，`split(",")` 打不中、索引成功
 * —— 用户凭直觉会觉得「逗号没事，我上一条就带逗号」，这条不对称对中文优先的工具尤其阴。
 *
 * 判据是「**一个真实存在的路径 > 一个假想的分隔语义**」。同仓已有先例：
 * `local-index.ts` 的 `realBasenamePath` 就是「宁可多做一次 readdir 也不丢掉这个文件」。
 *
 * ## 兼容性（逐条钉死）
 *
 * - `--dirs a,b` 旧写法逐字兼容（整串 `a,b` 不存在 ⇒ 照旧拆）；
 * - `--dirs "<夹>,<夹>/A.mp4"`（add-local-search-material-scope 立的用法）行为不变；
 * - 唯一的行为变化是「整串恰为一个真实存在的路径」——该情形在本条落地前**必然**产出
 *   零素材，没有可回归的正确行为。
 *
 * ## MUST NOT（proposal 已逐条判死，别复活）
 *
 * - MUST NOT 引入 `\,` 转义（Windows 优先的工具，`\` 就是路径分隔符，`C:\dir\,name` 是新歧义）；
 * - MUST NOT 换分隔符为 `;` / `|`（前者在 Windows 路径里同样合法，后者要额外引用）；
 * - MUST NOT 做「拆开后把不存在的相邻片段拼回去试」的贪心重组（可重复传已是无歧义解，
 *   重组只会制造第二套隐式语义）。
 */
export function analyzeDirsOption(raw: string | string[] | undefined): DirsArgAnalysis {
	const raws = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
	const dirs: string[] = [];
	const commaSplits: DirsArgAnalysis["commaSplits"] = [];
	for (const one of raws) {
		const whole = one.trim();
		// ① 自愈短路：整串原样就是盘上一条真实路径 ⇒ 不拆
		if (whole && existsSync(whole)) {
			dirs.push(resolve(whole));
			continue;
		}
		// ② 旧口径：逗号拆分（去空、trim、resolve）
		const texts = one
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const segments: DirsArgSegment[] = texts.map((text) => ({
			text,
			abs: resolve(text),
			exists: existsSync(text),
			relativeToCwd: !isAbsolute(text),
		}));
		if (one.includes(",") && segments.length >= 2 && segments.some((s) => !s.exists)) {
			commaSplits.push({ raw: one, segments });
		}
		for (const s of segments) dirs.push(s.abs);
	}
	return { raws, dirs, commaSplits };
}

/** `--dirs a,b` / 重复传 解析（去空、resolve 绝对化）。诊断面见 `analyzeDirsOption`。 */
export function parseDirsOption(raw: string | string[] | undefined): string[] {
	return analyzeDirsOption(raw).dirs;
}

/**
 * 多路参数互斥校验（spec「互斥参数」：参数错误退出并明示原因，不做静默忽略）。
 *   - index / --local 必带 --dirs；
 *   - --local 与仅云端语义参数（--column / --material-class）互斥；
 *   - 云端模式反向拒绝本地专属参数（--dirs / --scene-threshold / --rebuild / --source-window）；
 *   - describe：--plan xor --materials；lay：需 --project 或 --plan；
 *   - material：仅云端通用素材线，拒本地/派单/剪辑向专属参数；
 *   - --plan / --materials / --source-window 出现在不适用模式一律参数错误。
 */
export function assertModeOptions(pos: MatrixPositional, opts: MatrixOpts): void {
	const dirs = parseDirsOption(opts.dirs);
	// 通用素材检索专属参数（add-matrix-material-search）：出现在别的模式一律参数错误（不静默忽略）
	if (pos.kind !== "material") {
		const materialOnly: [unknown, string][] = [
			[opts.scope, "--scope"],
			[opts.commercialOnly, "--commercial-only"],
			[opts.minDuration, "--min-duration"],
			[opts.maxDuration, "--max-duration"],
			[opts.diversity, "--diversity"],
		];
		for (const [v, flag] of materialOnly) {
			if (v !== undefined && v !== false) {
				throw new Error(`${flag} 仅用于 gtrk matrix material（通用三态素材检索），不做静默忽略`);
			}
		}
	}
	// --mark-weight 仅 lay 模式（spec 只对 matrix lay 立法；不做静默忽略）
	if (opts.highlightWeight !== undefined && pos.kind !== "lay") {
		throw new Error("--highlight-weight 仅用于 matrix lay（融合排序只在消费 plan 铺轨这一步生效，不做静默忽略）");
	}
	if (opts.markWeight !== undefined && pos.kind !== "lay") {
		throw new Error("--mark-weight 仅用于 matrix lay（融合排序只在消费 plan 铺轨这一步生效，不做静默忽略）");
	}
	if (pos.kind === "material") {
		if (opts.local || dirs.length) {
			throw new Error(
				"matrix material 不接受 --local/--dirs：本零件是素材矩阵检索（本地索引无音频语义面）；本地素材检索走 gtrk matrix --local --dirs",
			);
		}
		if (opts.plan || opts.materials) throw new Error("--plan/--materials 仅用于 matrix describe / matrix lay（不做静默忽略）");
		if (opts.sourceWindow !== undefined) throw new Error("--source-window 仅用于 --local 检索（不做静默忽略）");
		if (opts.column) throw new Error("matrix material 不接受 --column：栏目检索偏好（column_tag_ids/facets）是剪辑向语义，通用素材口不适用");
		if (opts.materialClass) {
			throw new Error("matrix material 不接受 --material-class：素材形态用 --scope clip|image|audio；概念/实拍分层是剪辑向语义");
		}
		if (opts.project || opts.dispatch) throw new Error("matrix material 不接受 --project/--dispatch：本零件是 ad-hoc 检索，不消费派单也不铺轨");
		return;
	}
	if (pos.kind === "fetch") {
		// fetch 只认 --out / --json：拉原片是 resign 消费口，不检索不铺轨不进工程（不做静默忽略）
		if (opts.local || dirs.length) throw new Error("matrix fetch 不接受 --local/--dirs：本地素材本就绝对路径直引、无需拉取（search --local 出路径、直接拖）");
		if (opts.plan || opts.materials) throw new Error("--plan/--materials 仅用于 matrix describe / matrix lay（不做静默忽略）");
		if (opts.sourceWindow !== undefined) throw new Error("--source-window 仅用于 --local 检索（不做静默忽略）");
		if (opts.column || opts.materialClass) throw new Error("matrix fetch 不接受 --column/--material-class：拉原片不是检索，无语义过滤面");
		if (opts.project || opts.dispatch) throw new Error("matrix fetch 不接受 --project/--dispatch：产物落普通目录、不进工程（进工程的原片走铺轨「确认原片」链路）");
		return;
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
		if (!dirs.length) throw new Error("matrix index 需要 --dirs <a,b,...> 指定素材文件夹**或单个素材文件**（索引范围永远显式可见）");
		if (opts.sourceWindow !== undefined) throw new Error("--source-window 仅用于 --local 检索（不做静默忽略）");
		return;
	}
	if (opts.local) {
		if (!dirs.length) throw new Error("--local 需要 --dirs <a,b,...> 圈定检索域（检索域永远用户可见，不静默复用）");
		if (opts.column) throw new Error("--local 与 --column 互斥：栏目检索偏好（column_tag_ids/facets）是云端语义，本地索引不适用");
		if (opts.materialClass) throw new Error("--local 与 --material-class 互斥：素材类型过滤是素材矩阵语义，本地索引不适用");
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
	counts: {
		beats: number;
		queries: number;
		/** ⚠️ **去重前**逐 query 累加的检索响应条数（既有口径，MUST NOT 改）——
		 * 15 条 query 各命中同一条素材时这里是 15，而 plan 落盘可能只有 8 行、只对应 1 个素材
		 * （真机 P1 260902 实测）。要判「到底有多少料」读 `plan_results` / `distinct_clips`。 */
		results: number;
		errors: number;
		// ⚠️ 以下三键 [add-broll-plan-summary-honesty] 只在**派单消费模式**（本命令产 plan 那一路）出现。
		// ad-hoc `matrix search` 与 `matrix lay` 的 counts 逐字节不变（本件只动产 plan 这一路，
		// 给它们补 0 等于把「没这个概念」和「测出来是 0」抹平成同一个数）。
		/** 真·零产出的 query 条数：判据取**检索响应** `data.results.length === 0`，
		 * MUST NOT 事后扫 plan 的 `results: []`（beat 内去重会把命中折进同 beat 兄弟 query，折叠 ≠ 零产出）。 */
		zero_yield?: number;
		/** plan **落盘后**实际 result 行数（去重后）。 */
		plan_results?: number;
		/** plan 内 distinct `clip_id` 数——「8 行 result 其实只有 1 条素材」这件事只有它说得出来。 */
		distinct_clips?: number;
	};
	[k: string]: unknown;
}

/** 通用三态素材检索出参（add-matrix-material-search；`mode:"material"`，与剪辑向契约独立）。
 * `upsell` 是**独立顶层字段**：MUST NOT 混进 `results` 或改写任何候选（防污染 agent 的候选判断）。 */
export interface MatrixMaterialResult {
	ok: boolean;
	mode: "material";
	memberType: Tier;
	endpoint: string;
	scope: MaterialScope;
	query: string;
	top_k: number;
	/** 计费口径（公开口 1 积分/次、custom 口 0 元）。 */
	billing: string;
	results: MaterialResult[];
	counts: { results: number };
	upsell?: MaterialUpsell;
	outPath?: string;
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
	/**
	 * ⚠️ **机读契约变更**（fix-material-intake-path-and-enumeration §3）：
	 * 此前恒为硬编码 `true`，现在**全域零枚举**（`materials.total === 0`）时为 `false`，
	 * 退出码随之非 0。凡用 `--json` 的 `ok` 或退出码消费 `matrix index` 的脚本/skill 都看得见差别；
	 * 但此前为 `true` 的那些场景全部是「什么都没索引到」，没有正确行为被打破。
	 * 触发面 MUST 收窄到「全域」——多项 `--dirs` 里只有部分为空时仍为 `true`（那一轮确实干了活）。
	 */
	ok: boolean;
	mode: "index";
	dirs: string[];
	/** 逐项交代（同上）：`--dirs` 每一项各自枚举到的素材数，供 agent 判「哪一句祈使句没兑现」。 */
	per_dir: { dir: string; materials: number }[];
	dbPath: string;
	materials: { total: number; indexed: number; skipped: number; rebuilt: number; failed: number };
	/** kind 分列计数（add-matrix-local-image-broll：图片/视频各自 total/indexed）。 */
	kinds: { video: { total: number; indexed: number }; image: { total: number; indexed: number } };
	scenes: number;
	frames: number;
	/** 稳定性收敛账面（add-index-stability-sampling：分列 stable/unstable 场景数与收敛省帧数；
	 * 图片不参与，只计本轮实际入库的视频素材）。
	 * `black_veto_*`（fix-index-gradual-transition-blindness）：因**含黑段**被否决 stable 的场景数，
	 * 与该否决带来的**新增**抽帧数。⚠️ 与 `frames_saved` **分列不相抵**——一笔是省、一笔是增，
	 * 合并成净值会把「成本为什么涨了」藏起来。旧库/未扫黑段的素材两键恒为 0（不是缺席）。 */
	stability: { stable_scenes: number; unstable_scenes: number; frames_saved: number; black_veto_scenes: number; black_veto_frames: number };
	billing: MatrixIndexBilling;
	elapsedSec: number;
	[k: string]: unknown;
}

/** 检索上下文：plan/adhoc 两模式共用的「一 query 一答」抽象（云端=双口 HTTP；本地=索引点积）。 */
interface SearchCtx {
	/** 云端凭据（云端编排端点由 base 推导；`--arrange local` 时不读它）。 */
	cfg: { base: string; apiKey: string };
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
): Promise<MatrixResult | MatrixIndexResult | MatrixDescribeResult | MatrixMaterialResult> {
	if (opts.json) routeLogsToStderr();
	assertModeOptions(pos, opts);
	const cfg = loadConfig();

	// ── 本地索引模式（matrix index）──
	if (pos.kind === "index") return withEmbedJsonGuard("index", opts, () => runIndexMode(cfg, opts, deps));

	// ── 理解零件（matrix describe：--plan 注入 / --materials 直接理解）──
	if (pos.kind === "describe") return withEmbedJsonGuard("describe", opts, () => runDescribeMode(cfg, opts, deps));

	// ── 消费编辑后 plan（matrix lay：plan 可编辑通路的落轨腿）──
	if (pos.kind === "lay") return withEmbedJsonGuard("lay", opts, () => runLayMode(opts, deps));

	// ── 通用三态素材检索（matrix material：2×2 路由下半行，下载向出参）──
	if (pos.kind === "material") return withEmbedJsonGuard("material", opts, () => runMaterialMode(pos.query, cfg, opts));

	// ── 精剪期拉原片（matrix fetch：resign 消费口，两段式第二段；零计费无确认闸）──
	if (pos.kind === "fetch") {
		return withEmbedJsonGuard("fetch", opts, async () => {
			const result = await fetchMaterials({ clipIds: pos.clipIds, ...(opts.out ? { out: opts.out } : {}) }, deps.matrixFetch ?? { loadCfg: () => cfg });
			if (!result.ok) process.exitCode = 1;
			if (opts.json) console.log(JSON.stringify(result));
			return result as unknown as MatrixResult;
		});
	}

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
			throw new Error("external 档位服务端固定 real_shot + 可商用素材，concept 不可用（--material-class concept 无法满足）");
		}
		if (opts.materialClass) {
			log.warn("external 档位服务端固定 real_shot + 可商用素材，--material-class 参数不适用（已忽略）");
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
		cfg,
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
/** `--decode-path` 取值校验。不认的值必须报错——静默当成缺省会让「我明明指定了 gpu」
 * 变成一次无声的空跑，用户拿不到任何反馈就以为硬解开了。 */
export function parseDecodePath(v: unknown): "auto" | "gpu" | "cpu" | "full" | undefined {
	if (v === undefined || v === null || v === "") return undefined;
	const s = String(v).toLowerCase();
	if (s === "auto" || s === "gpu" || s === "cpu" || s === "full") return s;
	throw new Error(`--decode-path 只认 auto|gpu|cpu|full，收到「${String(v)}」`);
}

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
async function runIndexMode(cfg: ReturnType<typeof loadConfig>, opts: MatrixOpts, deps: MatrixRunDeps = {}): Promise<MatrixIndexResult> {
	const indexRun = deps.indexRun ?? indexLocalMaterials;
	const analysis = analyzeDirsOption(opts.dirs);
	const dirs = analysis.dirs;
	const threshold = parseSceneThreshold(opts.sceneThreshold);
	const stabilityThreshold = parseStabilityThreshold(opts.stabilityThreshold);
	const endpoint = embedEndpointFor(cfg);
	log.step(
		`▶ 本地素材索引：${formatDirsEcho(dirs)}（场景阈值 ${threshold} · 稳定阈值 ${stabilityThreshold}${opts.rebuild ? " · 强制全量重建" : ""}）…`,
	);
	log.info("免切片：只记场景时间戳，不产生任何切片文件；抽帧图 embed 后即删（素材本体不上云）。");
	// 同合云内部成员（gc_member_type=internal）豁免：无 token 也放行图像且零计费 → 直接不开会话
	const exempt = await probeIndexBillingExempt(cfg);
	if (exempt) log.info("同合云内部成员（gc_member_type=internal）：图像 embed 计费豁免（免会话零积分；文本 embed 本就免费）。");
	const decodePath = parseDecodePath(opts.decodePath);
	const proxyWidth = opts.proxyWidth === undefined ? undefined : Number(opts.proxyWidth);
	if (proxyWidth !== undefined && (!Number.isFinite(proxyWidth) || proxyWidth < 64)) {
		throw new Error("--proxy-width 需为 ≥64 的数字");
	}
	// 逐项交代（§3）：枚举一次、按项归属，再把这份清单**原样**交给 indexLocalMaterials
	// （`listFiles` 注入面），全程只走一遍文件系统 —— MUST NOT 为了分项计数再枚举 N 遍，
	// X 盘素材大本营那种上万文件的库会当场变慢 N 倍。
	// ⚠️ 这里钉的是 `listMaterialFiles`（= indexLocalMaterials 的缺省枚举口，local-index.ts
	//    `(opts.listFiles ?? listMaterialFiles)(opts.dirs)`）。两边 MUST 保持同一个函数：
	//    枚举语义（单文件收窄 / 白名单 / 符号链接跟随）的任何演进都在它内部，命令层不复刻。
	const enumerated = listMaterialFiles(dirs);
	const perDir = dirs.map((dir) => ({ dir, materials: enumerated.filter((f) => pathInDirs(f, [dir])).length }));
	const emptyDirs = perDir.filter((p) => p.materials === 0);
	// 逐项报数**在开跑之前**说：这是枚举阶段的事实，用户不该等完一轮长跑才知道有一项是空的。
	if (perDir.length > 1) {
		log.info(`枚举分项：\n${perDir.map((p) => `     ${String(p.materials).padStart(5)} 个 · ${p.dir}`).join("\n")}`);
	}
	// 部分静默：今天只要 total>0 就一声不吭 ——`A.mp4` 成功 + 含逗号的 `B` 被劈丢时输出毫无异样。
	// 用户显式传入的每一项都是一句祈使句，其中任何一句没兑现都要说出来。
	// ⚠️ **只告警、MUST NOT 动退出码**：本轮确实干了活。硬失败的触发面 MUST 收窄到「全域零枚举」，
	// 扩到「任何一项为空」会把「传一个空素材夹」这类正当场景一起判死（proposal §五已定夺）。
	if (emptyDirs.length && emptyDirs.length < perDir.length) {
		log.warn(
			`以下 ${emptyDirs.length} 项一个素材都没枚举到（本轮其余项有产出，退出码仍 0）：\n` +
				emptyDirs.map((p) => `  ${p.dir}`).join("\n") +
				commaCulpritLines(analysis),
		);
	}
	const run = await indexRun({
		dirs,
		listFiles: () => enumerated,
		sceneThreshold: threshold,
		stabilityThreshold,
		rebuild: opts.rebuild === true,
		decodePath,
		proxyWidth,
		proxyScaler: opts.proxyScaler,
		embed: (inputs, sessionToken) => embedInputs(endpoint, inputs, { sessionToken }),
		session: exempt ? undefined : buildIndexSessionHooks(endpoint),
		onProgress: (line) => log.info(line),
		// 长跑心跳（add-matrix-index-phase-progress）：本仓既有的 tick/tickEnd 口径（render / oralcut /
		// transcript / long2short / music-visualizer / chunk-upload 六处在用），index 是唯一漏掉的长跑命令。
		// 收口纪律在编排层：任何 onProgress 之前先 tickEnd，命令层这里只做直连、MUST NOT 自己再判。
		// `--json` 下 routeLogsToStderr() 已把 humanOut 整体搬到 stderr ⇒ 心跳同走 stderr，stdout 仍纯 JSON。
		onTick: (line) => log.tick(line),
		onTickEnd: () => log.tickEnd(),
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
	// 黑段否决 stable 的账（fix-index-gradual-transition-blindness）：库侧早就分好了两笔，
	// 这里是它们第一次出现在人读行与 --json 上。
	// ⚠️ **两笔 MUST 分列、MUST NOT 相抵**：`framesSaved` 是**省**（stable 收敛少抽的帧），
	// `blackVetoFrames` 是**增**（因含黑段被否决 stable 而多抽的帧，直接进 embed 计费，
	// 真机那条 18.034s 场景由 1 帧 → 9 帧）。合成一个净值就把「成本为什么涨了」这件事藏起来了——
	// 净值恰好为 0 的那一轮读者会以为「本轮没有任何成本变化」，而实际是省的和增的各发生了一批。
	const blackNote = stab.blackVetoScenes > 0 ? `（含黑段否决 stable ${stab.blackVetoScenes} 段 · 增 ${stab.blackVetoFrames} 帧）` : "";
	const stabNote =
		stab.stableScenes + stab.unstableScenes > 0
			? ` · stable 场景 ${stab.stableScenes} / unstable ${stab.unstableScenes}${stab.framesSaved ? `（收敛省 ${stab.framesSaved} 帧）` : ""}${blackNote}`
			: "";
	// ── 全域零枚举硬失败（fix-material-intake-path-and-enumeration §3）──
	//
	// 此前：零枚举只 log.warn，`ok` 硬编码 true、退出码 0 —— 一条「什么都没索引到」的命令
	// 报成功。真机 2026-09-02 的失败链条正断在这里：index「成功」⇒ agent 接着往下跑 ⇒
	// 空候选一路流到成片，用户看到的第一个异常离病灶隔了三四步。
	// **告警不是契约，退出码才是**：本命令的主要驱动者是 agent 与 `index … && describe …`
	// 这样的 shell 串（skills/gtrk-travel-recap:211 就是这么写的），它们读退出码与 `ok`，
	// 不读 stderr 上的中文段落。改成硬失败，那个 `&&` 会在正确的地方停住。
	// MUST NOT 加 `--allow-empty` 之类让零枚举重新变成成功的逃生门。
	const zeroAll = run.materials.total === 0;
	if (zeroAll) log.warn(zeroEnumerationDiagnosis(analysis, dirs, readBrokenLinks(run)));
	const summary =
		`${m.indexed}/${m.total} 个素材${kindNote}（跳过 ${m.skipped} · 重建 ${m.rebuilt}${m.failed ? ` · 失败 ${m.failed}` : ""}）· ` +
		`场景 ${run.scenes} · 帧 ${run.frames}${stabNote} · 耗时 ${(run.elapsedMs / 1000).toFixed(1)}s${billNote}`;
	// MUST NOT 打出与正常完成无差别的成功行（真机就是被那句「✅ 索引完成：0/0」骗过去的）
	if (zeroAll) log.err(`索引未产出任何素材：${summary}\n   判失败（退出码 1 · --json 的 ok=false）——「让这批素材可检索」这句祈使句没兑现。`);
	else log.ok(`索引完成：${summary}`);
	log.info(`索引落点：${run.dbPath}（绝对路径为键，跨机不可移植；属本机缓存，可随时重建）`);
	const result: MatrixIndexResult = {
		ok: !zeroAll,
		mode: "index",
		dirs: run.dirs,
		per_dir: perDir,
		dbPath: run.dbPath,
		materials: run.materials,
		kinds: run.kinds,
		scenes: run.scenes,
		frames: run.frames,
		stability: {
			stable_scenes: stab.stableScenes,
			unstable_scenes: stab.unstableScenes,
			frames_saved: stab.framesSaved,
			// 与 frames_saved **并列独立成键**（见上方 blackNote 处的理由）：机读面同样不许相抵。
			black_veto_scenes: stab.blackVetoScenes,
			black_veto_frames: stab.blackVetoFrames,
		},
		billing,
		elapsedSec: Math.round(run.elapsedMs / 100) / 10,
	};
	// 退出码对齐本仓既有写法（fetch / runPlanMode / runLayMode 三处同款）：ok:false ⇒ 非 0。
	// 放在 result 构造之后、--json 打印之前，机读面与退出码 MUST NOT 互相矛盾。
	if (!result.ok) process.exitCode = 1;
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

/**
 * 域回显：多项时每项独占一行。
 *
 * MUST NOT 用「、」拼接 —— 真机那一行 `域：X:\…Bears、D:\file\tmp\…\Salmon and…` 里，
 * 被英文逗号劈开的后半段长得像一条正常路径，**肉眼极难认出是同一个文件被切开**。
 * 那是当时唯一的线索，而它实际不可读。
 */
function formatDirsEcho(dirs: string[]): string {
	if (dirs.length === 0) return "(空)";
	if (dirs.length === 1) return dirs[0]!;
	return `${dirs.length} 项\n${dirs.map((d, i) => `   [${i + 1}] ${d}`).join("\n")}`;
}

/**
 * 把检索域回抄成一条**可直接粘贴**的命令片段：每项各一次 `--dirs`。
 *
 * 此前是 `--dirs "a","b"`（JSON.stringify 后用逗号拼），两处都错：
 *   · 逗号拼 —— 那形态在 shell 里会被并成一个参数值 `a,b` 再被逗号拆回来，纯属巧合可用；
 *     一旦路径本身含英文逗号就当场错。重复传才是「路径里可能有任何字符」的唯一无歧义解；
 *   · `JSON.stringify` —— Windows 路径会被转义成 `"C:\\Users\\x"`，**cmd.exe 里粘贴即错**
 *     （它不认 `\\` 转义，会当成两个分隔符）。回抄的是给人粘的命令，用裸双引号即可
 *     （Windows 文件名本就不允许 `"`）。
 */
function dirsAsRepeatedFlag(dirs: string[]): string {
	if (dirs.length === 0) return "--dirs <素材夹或素材文件>";
	return dirs.map((d) => `--dirs "${d}"`).join(" ");
}

/**
 * 定向检测①：英文半角逗号切分。**检测到才说、说就点名**；没命中返回空串。
 *
 * MUST NOT 退化成「泛泛补一条『会不会是逗号』」——罗列可能原因不能代替检测。
 */
function commaCulpritLines(analysis: DirsArgAnalysis): string {
	if (analysis.commaSplits.length === 0) return "";
	const out: string[] = [];
	for (const { raw, segments } of analysis.commaSplits) {
		// ⚠️ 用「」包而不是 JSON.stringify：后者会把 Windows 路径的 `\` 全转义成 `\\`，
		// 一条本来就难读的路径变成两倍难读——而这段文字的唯一职责就是让人**一眼看懂被切在哪**。
		out.push(`  ❗ 这一串被英文半角逗号「,」切成了 ${segments.length} 段：「${raw}」`);
		segments.forEach((s, i) => {
			const rel = s.relativeToCwd ? `（不是绝对路径 ⇒ 被当成相对路径拼到了当前目录下：${s.abs}）` : "";
			out.push(`     第 ${i + 1} 段「${s.text}」→ ${s.exists ? "存在" : "不存在"}${rel}`);
		});
	}
	out.push("  若它本来就是**一条**含逗号的路径：改用重复传，每条各一次 —— 例如");
	out.push('     gtrk matrix index --dirs "<路径一>" --dirs "<路径二>"');
	out.push("  （中文全角「，」U+FF0C 从不参与拆分：同一轮里全角那条片索引成功、半角这条 0/0，就是这个不对称。）");
	return `\n${out.join("\n")}`;
}

/**
 * 断链上报的读取口（seam）。
 *
 * 跟随符号链接与 `brokenLinks` 计数在 `src/lib/local-index.ts` 落地（本 change §2），
 * 由它把**断链的链接路径**上抛到 `IndexRunResult.brokenLinks`。这里按 duck-typing 读、
 * 形状不符即退化为空数组：诊断段宁可少说一句，也 MUST NOT 因为上游形状变了就把整条命令带崩。
 */
function readBrokenLinks(run: IndexRunResult): string[] {
	const v = (run as { brokenLinks?: unknown }).brokenLinks;
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * 零枚举诊断：**先报已检出的真因，再报未能检出时的可能原因**。
 *
 * 此前只有后者，且被自称穷举成「三种可能」。真机两次零枚举命中的都不在那三条里：
 * 逗号场景下路径没拼错、扩展名 `.mp4` 在白名单、传的不是文件夹 —— 三条全为假，
 * 且会把人往错误方向带；symlink 场景下用户读到「里面没有素材文件」，而 `ls -la` 明明列着一个 .mp4。
 * 所以措辞里 MUST NOT 再出现「三种可能」这类穷举自称（本轮命中的是第四、第五种）。
 */
function zeroEnumerationDiagnosis(analysis: DirsArgAnalysis, dirs: string[], brokenLinks: string[]): string {
	const parts: string[] = [`一个素材都没枚举到（域：${formatDirsEcho(dirs)}）。`];
	const comma = commaCulpritLines(analysis);
	if (comma) parts.push(`已检出的真因：${comma}`);
	// 定向检测②：断链符号链接 —— 遍历已跟随链接之后，断链仍会导致零枚举
	if (brokenLinks.length) {
		const head = comma ? "另一条已检出的真因：" : "已检出的真因：";
		parts.push(
			`${head}\n  ❗ ${brokenLinks.length} 条符号链接的目标不可达（链接在、真身没了）：\n` +
				brokenLinks.slice(0, 10).map((p) => `     ${p}`).join("\n") +
				(brokenLinks.length > 10 ? `\n     …（其余 ${brokenLinks.length - 10} 条略）` : ""),
		);
	}
	if (!comma && brokenLinks.length === 0) {
		parts.push(
			"没检出确定的真因。以下是常见原因，逐条排查：\n" +
				"  · `--dirs` 指的路径不存在或拼错了；\n" +
				"  · 传的是文件，但扩展名不在素材白名单里（图片/视频之外的一律不收）；\n" +
				"  · 传的是文件夹，但里面（含 4 层子目录内）没有素材文件；\n" +
				"  · 素材在可移动盘/网络盘上，而那个盘当前没挂上。",
		);
	}
	return parts.join("\n");
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
	/** 实际调服务端张数（计费口径：1 积分/张，异步任务计费——提交预扣→完成结算，失败自动退款）。 */
	called: number;
	/** 取帧失败被跳过数（局部化，不拖垮整轮）。 */
	failed: number;
	/** **实耗口径**（fix-describe-billing-report-honesty）：豁免时为 0。原价读 `credits_would_be`。
	 * ⚠️ 下游若原先按原价读本键，改读 `credits_would_be`。 */
	credits_estimated: number;
	/** 原价（= 实际调用张数 × 1 积分），恒与 `credits_estimated` 成对出现。 */
	credits_would_be: number;
	/** 计费身份豁免（`gc_member_type=internal`）：**有实际调用时恒出**；
	 * 零调用（全缓存命中）时缺席——没扣费就没有计费可报。
	 * ⚠️ 与 `matrix material` 的 `memberType`（matrix_member_type，矩阵检索维度）是两条正交的身份轴。 */
	exempt?: boolean;
	/** 计费身份探针失败：按非豁免继续报数，但「探不到」MUST NOT 呈现成「确定不豁免」。 */
	exempt_probe?: "failed";
	/** [add-describe-flag-desc-crosscheck] 叠加物交叉校验：desc 自述有叠加元素、对应 flag 仍为 false 的条目。
	 * 纯本地判据（零调用零计费），**缓存命中项一并受检**。缺席 = 本轮零差异。
	 * ⚠️ 只报差异，`usable_flags` 一字未改（信号归裁定层，零件不裁定）。 */
	flag_desc_mismatch?: {
		count: number;
		by_dim: Partial<Record<OverlayFlagDim, number>>;
		items: { material_id: string; ts_ms: number; dims: OverlayFlagDim[]; desc_excerpt: string }[];
	};
	/** [fix-describe-window-coverage] 段覆盖率（仅 `--plan` 形态）：`frames` 是**理解帧数**、
	 * `segments` 是被理解候选携带的**段总数**——分母不是候选数。真机 260902 实测 32/843 = 3.8%。
	 * ⚠️ 与 `injected`（候选数）是两个数：只读 `injected` 会以为「这些候选都被看过了」。
	 * 图片候选无时间轴、射程即整条素材，单列 `image_candidates`，不进分子也不进分母。 */
	describe_coverage?: { frames: number; segments: number; ratio: number; image_candidates: number };
	/** 计费确认被拒：零服务端调用中止（ok:false + 非 0 退出码）。 */
	reason?: string;
	/** --materials 模式明细（--plan 模式产物在 plan 文件里）。 */
	items?: { material_id: string; ts_ms: number; source: string; describe: MaterialDescribe | null }[];
	[k: string]: unknown;
}

/**
 * [add-broll-plan-summary-honesty] plan **落盘态**的候选账面（纯只读统计：零 IO、零检索、零计费）。
 * 摘要行与 describe 的掏空风险清单共用这一份口径——两处各算各的迟早会对不上。
 *
 * ⚠️ 只回答「这个 beat 现在还剩几条候选」，**MUST NOT** 拿 `count === 0` 反推「那条 query 零产出」：
 * beat 内去重（`dedupeBeatQueries`）会把某条 query 的命中折进同 beat 兄弟 query 的
 * `also_matched_queries`，使它的 `results` 变空，而该 beat 的候选池（beat 级并集）一条都不少
 * ——真机 260902 三份 plan 里 25 条 `results:[]` 全是这种折叠，genuine 零产出为 0。
 * 零产出判据在检索响应侧（见 `runPlanMode` 的 `zeroYieldQueries`），两者 MUST NOT 互相顶替。
 */
export function summarizePlanCandidates(plan: BrollPlan): {
	planResults: number;
	distinctClips: number;
	beatCandidateCounts: Array<{ beat: string; count: number }>;
} {
	let planResults = 0;
	const clips = new Set<string>();
	const beatCandidateCounts: Array<{ beat: string; count: number }> = [];
	for (const beat of plan.beats ?? []) {
		let count = 0;
		for (const q of beat.queries ?? []) {
			for (const r of q.results ?? []) {
				planResults++;
				count++;
				if (typeof r.clip_id === "string" && r.clip_id) clips.add(r.clip_id);
			}
		}
		beatCandidateCounts.push({ beat: beat.beat, count });
	}
	return { planResults, distinctClips: clips.size, beatCandidateCounts };
}

/** [add-broll-plan-summary-honesty] 掏空风险清单文案（候选数 ≤1 的 beat 逐个点名）。
 * 纯函数：给定账面即出文案，`null` = 全 beat 候选 ≥2（不打扰）。
 * **只补判据不夺裁定权**：CLI MUST NOT 依据本清单剔除/保留/改写任何 result 条目
 * （`matrix.ts` 那句「剔除与否由你裁定」是设计意图，不是疏漏）。 */
export function emptyRiskNote(counts: Array<{ beat: string; count: number }>): string | null {
	const risky = counts.filter((c) => c.count <= 1);
	if (risky.length === 0) return null;
	const head = risky
		.slice(0, 12)
		.map((c) => `${c.beat}（${c.count === 0 ? "当前已零候选" : "仅 1 条，删掉即零候选"}）`)
		.join("、");
	return (
		`剔除风险：${risky.length} 个 beat 的候选总数 ≤1 —— ${head}${risky.length > 12 ? ` 等 ${risky.length} 个` : ""}。\n` +
		// 归宿两种都写：describe 这一路刻意不读工程（形态信息在 .gtrk 的 struct_meta.broll.black_track 里），
		// 为一句提示去开工程等于给「只读统计」加 IO——本件明令 MUST NOT。宁可两种都说，让用户自己对号入座。
		"掏空后的归宿看工程形态：音频驱动工程 ⇒ 该段整段黑屏，或由主轨 gap 填充从别的 beat 借画面（相关性更弱）；\n" +
		"口播工程 ⇒ 该段露出主轨 A-roll。想留余地就先补素材重跑 `gtrk matrix`，别先删。"
	);
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
	// 计费身份探针（fix-describe-billing-report-honesty）：
	// ① memo 一次——runDescribeItems 里只有一个调用点，这层再兜一道，防日后有人加第二个探测点；
	// ② 失败置位 `probeFailed`——「探不到所以按非豁免」与「探到了、确实不豁免」是两件事，
	//    报成同一件就是拿不确定冒充确定（机读侧靠 `exempt_probe:"failed"` 区分）。
	let probeFailed = false;
	let probedExempt: boolean | undefined;
	const probeExempt =
		deps.probeExempt ??
		(async () => {
			if (probedExempt !== undefined) return probedExempt;
			try {
				probedExempt = (await probeGcMemberType(cfg)) === "internal";
			} catch (e) {
				log.warn(
					`身份探测失败（${e instanceof Error ? e.message : String(e)}）——按非豁免（1 积分/张，异步任务计费：提交预扣→完成结算，失败自动退款）继续`,
				);
				probeFailed = true;
				probedExempt = false;
			}
			return probedExempt;
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
			credits_would_be: run.creditsWouldBe,
			...(run.exempt !== undefined ? { exempt: run.exempt } : {}),
			...(probeFailed ? { exempt_probe: "failed" as const } : {}),
			reason: "describe_billing_declined",
		};
		process.exitCode = 1;
		if (opts.json) console.log(JSON.stringify(result));
		return result;
	}

	// ── --plan 注入回写（result.describe 字段随 plan 流转；MUST NOT 依据 flags 剔除任何候选）──
	let injected = 0;
	let coverage: DescribeCoverage | undefined;
	if (planObj && planPath && targets) {
		// 射程锚点（fix-describe-window-coverage）：写出这一条 describe 出自的**帧时刻**。
		// 取值来源恒是 `items[i]` 本身——那是这一轮真的送去理解的那一帧，不是重算出来的猜测
		// （`items` / `targets` / `run.results` 三条数组由 collectPlanDescribeItems 逐条同序推入）。
		// ⚠️ 抽帧口径**一字未动**：仍是每候选一帧、仍取 `segments[0].best`，服务端调用张数与计费零变化。
		// 图片候选走 `direct`（缓存键 ts=0 是缓存键不是时刻）⇒ anchor 恒 undefined，不写误导性锚点。
		const covRows: { image: boolean; segments: number }[] = [];
		targets.forEach((r, i) => {
			const d = run.results[i];
			if (d) {
				const src = items[i]?.source;
				r.describe = toDescribeMeta(d, src && src.kind === "frame" ? src.tsSec : undefined);
				injected++;
				covRows.push({ image: r.kind === "image", segments: r.segments?.length ?? 0 });
			}
		});
		coverage = summarizeDescribeCoverage(covRows);
		await writeFile(planPath, JSON.stringify(planObj, null, 2));
		log.ok(
			`理解完成并回写 plan：注入 ${injected} 条 result.describe（缓存命中 ${run.cached} · 实际调用 ${run.called} 张${run.failed ? ` · 取帧失败 ${run.failed}` : ""}${skipped ? ` · 无源跳过 ${skipped}` : ""}）→ ${planPath}`,
		);
		// ⚠️ 覆盖率必须紧跟在上面那句「注入 N 条」后面：N 是**候选数**，单独出现会被读成
		// 「这 N 条候选都被看过了」。真机 260902 两份 plan 的真值是 32 帧 / 843 段 = 3.8%。
		// 非致命 INFO 档：这是「信号只覆盖了这么点」的告知，MUST NOT 抛 warn/error，也 MUST NOT
		// 因此跳过或改变回写。
		log.info(describeCoverageNote(coverage));
		log.info("usable_flags 只是给你的信号：剔除与否由你编辑 plan 裁定（删 result 条目后 gtrk matrix lay），CLI 不会替你剔。");
		// [add-broll-plan-summary-honesty] 把裁定权交出去的同时得给判据：候选数 ≤1 的 beat 逐个点名。
		// 真机 260902 P3 八个 beat 里七个全 beat 只有 1 条候选——按 text_overlay 信号删掉那一条，
		// 该 beat 立刻零候选，而此前 CLI 全程没点过一次名（gap 填充 INFO 是事后、间接、不点 beat 名的聚合信号）。
		// 数据顺着 planObj 遍历就有：零额外 IO、零额外检索、零额外计费。
		const risk = emptyRiskNote(summarizePlanCandidates(planObj).beatCandidateCounts);
		if (risk) log.warn(risk);
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
	// ── [add-describe-flag-desc-crosscheck] 叠加物交叉校验（纯本地、零调用、零计费）──────
	// 真机 260902 硬证据：`broll-local-e28be73e24d82c35 @111117ms` 的 desc 亲口写了
	// 「左上角有'REC'等视频录制界面元素」，`text_overlay` 仍是 false。那一帧按 CLI 现行 512px
	// 口径重抽出来目视核对，HUD 文字清晰可读 ⇒ 模型是**看见了却没打标**，不是看不见
	// （最初「提高抽帧分辨率」的假设据此被推翻，改判到服务端提示词偏置，由 infra 侧另件承接）。
	// 本条只做「模型自己都说了、flag 却没打」的差异告知：
	//   ① 独立于服务端提示词——将来 prompt 回归了这条判据仍在；
	//   ② **缓存命中项一并受检**（读的是缓存里的 desc_text），既有旧条目零成本受益；
	//   ③ 只报差异 MUST NOT 覆写 flag——覆写就是 CLI 越权裁定，与「零件不裁定」直接冲突。
	// 放在计费文案之前、两种输入形态之后 ⇒ --plan 与 --materials 两路共用一份文案（不各写一份）。
	const mismatch = summarizeFlagDescMismatch(
		items.map((it, i) => ({ materialId: it.materialId, tsMs: it.tsMs, describe: run.results[i] ?? null })),
	);
	if (mismatch) log.info(flagDescMismatchNote(mismatch));

	// 计费文案（fix-describe-billing-report-honesty）：报的必须是**服务端本次真会扣多少**。
	// 豁免那一档此前只在 >20 张的运行里才可能出现（探测被焊在护栏里），≤20 张恒落非豁免分支
	// 言之凿凿地告诉豁免账号「≈N 积分」。正面范例在同一个文件里：`matrix material` 的 internal 档
	// 写的是「0 积分（矩阵成员免费…）」——describe 是掉队的那个。
	// 口径统一为**异步**：describe 自 2026-08-12 已改异步任务计费（提交预扣→完成结算，失败自动退款），
	// 而命令层三处措辞还停在「同步」那套旧说法，同一条命令两套说法本身就是报数不诚实的一种。
	// （防回潮：全仓 grep 这四个字应零命中，故此处也不复述那个词。）
	const billNote = run.exempt
		? `计费豁免（同合云内部成员，gc_member_type=internal）——原价 ${run.creditsWouldBe} 积分，本次实耗 0`
		: run.called > 0
			// ⚠️ 这里刻意仍用 `called * 1` 而非 `creditsWouldBe`（= pending × 1）：取帧失败的帧不上送也不扣费，
			// 非豁免档的**数字**要与本件落地前逐字一致（本件只订正措辞与豁免档，不改这一档的算法）。
			? `实际调用 ${run.called} 张 ≈ ${run.called * 1} 积分（1 积分/张，异步任务计费：提交预扣→完成结算，失败自动退款）` +
				(probeFailed ? "；⚠️ 计费身份没探到，这里按**非豁免**保守报数，实际可能不扣" : "")
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
		credits_would_be: run.creditsWouldBe,
		...(run.exempt !== undefined ? { exempt: run.exempt } : {}),
		...(probeFailed ? { exempt_probe: "failed" as const } : {}),
		...(coverage
			? {
					describe_coverage: {
						frames: coverage.frames,
						segments: coverage.segments,
						ratio: Math.round(coverage.ratio * 10000) / 10000,
						image_candidates: coverage.imageCandidates,
					},
				}
			: {}),
		...(mismatch
			? {
					flag_desc_mismatch: {
						count: mismatch.count,
						by_dim: mismatch.byDim,
						items: mismatch.items.map((m) => ({
							material_id: m.materialId,
							ts_ms: m.tsMs,
							dims: m.dims,
							desc_excerpt: m.excerpt,
						})),
					},
				}
			: {}),
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
	// 云端编排端点凭据（`--arrange local` 时 arrangeWiring 不会去用它——那一档一个网络字节都不动）
	const cfg = loadConfig();
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

	// ── 看点权重（add-shot-cards-and-alignment-qc）：与 mark 同一缓存库、正交维度 ──
	// mark=画面好不好看（美学），highlight=有没有看点（信息量/戏剧性/情绪/稀缺）。
	// 两权之和 >1 时由 lay 层钳制（sim 权重不为负）；无缓存候选中性，权重回吐给 sim。
	const highlightWeight = parseMarkWeight(opts.highlightWeight);
	let highlightLookup: MarkLookup | undefined;
	if (highlightWeight > 0) {
		if (markDb) {
			const db = markDb;
			const cache = new Map<string, number | undefined>();
			highlightLookup = (clipId, tsMs) => {
				const key = `${clipId}@${tsMs}`;
				if (cache.has(key)) return cache.get(key);
				const v = getNearestCachedHighlight(db, brollMaterialIdFor(clipId), tsMs);
				cache.set(key, v);
				return v;
			};
		} else {
			const dbPath2 = localIndexDbPath();
			if (existsSync(dbPath2)) {
				markDb = await openLocalIndexDb(dbPath2);
				const db = markDb;
				const cache = new Map<string, number | undefined>();
				highlightLookup = (clipId, tsMs) => {
					const key = `${clipId}@${tsMs}`;
					if (cache.has(key)) return cache.get(key);
					const v = getNearestCachedHighlight(db, brollMaterialIdFor(clipId), tsMs);
					cache.set(key, v);
					return v;
				};
			} else {
				log.warn(
					`--highlight-weight ${highlightWeight}：本地索引库不存在（${dbPath2}），无任何理解缓存——全部候选按中性处理。先跑 gtrk matrix describe 产看点分再开权重才有效`,
				);
			}
		}
		if (highlightLookup) {
			log.info(
				`看点权重开启（wh=${highlightWeight}）：融合分 = sim×${Math.max(0, 1 - markWeight - highlightWeight)}+(mark/100)×${markWeight}+(highlight/100)×${highlightWeight}；看点分取 describe 理解缓存（素材内就近帧），无缓存候选按中性处理（权重回吐给 sim）`,
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
			highlightWeight,
			highlightLookup,
			cutAlign: parseCutAlign(opts.cutAlign),
			gapFill: parseGapFill(opts.gapFill),
			gapFillExplicit: opts.gapFill !== undefined,
			...arrangeWiring(opts, cfg),
		});
	} finally {
		markDb?.close();
	}
	const laySummary = laid?.lay;
	const refused = laySummary?.refused === true ? (laySummary.keptEditedTracks as number[]) : undefined;
	const declined = laid?.declined === true;
	let resultCount = 0;
	for (const b of effPlan.beats) for (const q of b.queries) resultCount += q.results?.length ?? 0;
	// 卡脖子 upsell（extend-upsell-to-clip-search）：external 档留了空槽才提示——
	// 空槽落到成片就是黑底空洞，是 B-roll 主链路上最直观的「素材池不够」信号。
	// 独立顶层字段，lay 账面一字不改；internal 与本地模式恒不提示。
	const layUpsell = decideLayUpsell(
		plan.member_type,
		Number((laySummary as { dedup?: { emptySlots?: number } } | undefined)?.dedup?.emptySlots ?? 0),
	);

	const result: MatrixResult = {
		ok: refused === undefined && !declined,
		mode: "lay",
		memberType: plan.member_type,
		planPath,
		...(refused ? { refused, reason: "tracks_edited", planReusable: true } : {}),
		...(declined ? { reason: "image_move_billing_declined", planReusable: true } : {}),
		// 只预估不执行（add-arrange-estimate-only）：**成功**结局，与 declined 互斥且形态不同
		...(laid?.estimateOnly ? { estimateOnly: true, planReusable: true } : {}),
		...(laid?.imageBilling ? { image_move_billing: laid.imageBilling } : {}),
		...(laySummary ? { lay: laySummary } : {}),
		...(laid?.integrity ? { integrity: laid.integrity } : {}),
		...(layUpsell ? { upsell: layUpsell } : {}),
		reprojection: reproj.summary,
		counts: { beats: beats.length, queries: 0, results: resultCount, errors: 0 },
	};
	if (!result.ok) process.exitCode = 1;
	if (layUpsell && !opts.json) log.warn(layUpsell.message);
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

/** 构建本地检索上下文：载入索引（--dirs 圈定 + 消失文件过滤）+ 查询 embed（去重缓存）→ 点积检索闭包。 */
async function buildLocalSearchCtx(cfg: ReturnType<typeof loadConfig>, opts: MatrixOpts): Promise<SearchCtx> {
	const dirs = parseDirsOption(opts.dirs);
	const endpoint = embedEndpointFor(cfg);
	const dbPath = localIndexDbPath();
	if (!existsSync(dbPath)) {
		// 点名用户实际传的路径：MUST NOT 给出一条会枚举到零素材的命令形态
		// （`--dirs` 现在既吃文件夹也吃单个素材文件，照抄回去至少是可跑的那一条）
		throw new Error(
			`本地索引不存在（${dbPath}）——先建索引：gtrk matrix index ${dirsAsRepeatedFlag(dirs)}\n` +
				"（--dirs 可传素材文件夹，也可直接传单个素材文件——一稿对一片时钉到那一部片，邻片候选就抢不走了）",
		);
	}
	log.step(`▶ 本地检索模式：载入索引（域：${formatDirsEcho(dirs)}）…`);
	const db = await openLocalIndexDb(dbPath);
	let index: LoadedIndex;
	try {
		index = loadLocalIndex(db, dirs);
	} finally {
		db.close();
	}
	if (index.frames.length === 0) {
		throw new Error(
			`索引里没有该检索域的素材帧（域：${formatDirsEcho(dirs)}）——这些路径未索引过。\n` +
				`对它们本身、或它们所在的文件夹跑：gtrk matrix index ${dirsAsRepeatedFlag(dirs)}\n` +
				"（文件消失 / 扩展名不在素材白名单 / 从没索引过，三者都会走到这里）",
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
	// 查询向量三级缓存（fix-embed-ratelimit-backoff §4）：进程内 Map → 索引库 → 端点。
	// 取到即**两级回填**。进程内那层一退出就没了，于是每次重跑都从头烧一遍、还把限流窗口撑爆——
	// 库这一层就是为了让「重跑同一条片」变成零请求。
	const qvecCache = new Map<string, Float32Array>();
	const qvecSpace = embedSpaceId(EMBED_MODEL_ID, EMBED_DIM, endpoint.url);
	return {
		cfg,
		memberType: "local",
		sourceLayer: "local",
		search: async (query) => {
			// ⚠️ query 原样做键，MUST NOT 归一化大小写/空格——那是不同的 query，合并等于偷改语义
			let vec = qvecCache.get(query);
			if (!vec) {
				// ★ 库这一级用**短连接**：上面的 `db` 在载入索引后就 close 了，那条生命周期纪律
				//   不为缓存破例。开一次 SQLite 实测 6–8ms（不是「约 1ms」——那是初稿拍的数），
				//   相对它省掉的一次 embed 往返（百毫秒~秒级）仍可忽略。
				//   缓存读写失败一律降级走端点，MUST NOT 让「缓存坏了」变成「检索炸了」。
				try {
					const cdb = await openLocalIndexDb(dbPath);
					try {
						vec = getCachedQueryVec(cdb, query, qvecSpace);
					} finally {
						cdb.close();
					}
					if (vec) qvecCache.set(query, vec);
				} catch (e) {
					log.warn(`查询向量缓存读取失败，降级走端点：${e instanceof Error ? e.message : String(e)}`);
				}
			}
			if (!vec) {
				[vec] = await embedInputs(endpoint, [{ text: query }]); // 除此一请求外零网络
				qvecCache.set(query, vec!);
				try {
					const cdb = await openLocalIndexDb(dbPath);
					try {
						putCachedQueryVec(cdb, query, qvecSpace, vec!);
					} finally {
						cdb.close();
					}
				} catch (e) {
					log.warn(`查询向量缓存写入失败（不影响本次检索）：${e instanceof Error ? e.message : String(e)}`);
				}
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
	// [add-broll-plan-summary-honesty] 真·零产出名单。判据 MUST 取**检索响应**的 results 长度，
	// 且 MUST 在这里（`buildPlanBeat` 去重之前）落账——去重之后再扫 plan 会把 beat 内折叠
	// （命中被折进兄弟 query 的 also_matched_queries）误算成零产出，那是完全不同的两件事。
	const zeroYieldQueries: string[] = [];
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
				// ⚠️ `okCount` 的判据是「`ctx.search` 没抛异常」= **执行**成功，与有没有产出无关。
				// 这条语义此前被摘要行的「N/N query 成功」四个字含混掉了，故下面单独记零产出。
				okCount++;
				resultCount += data.results?.length ?? 0;
				if ((data.results?.length ?? 0) === 0) zeroYieldQueries.push(q);
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
	// [add-broll-plan-summary-honesty] 摘要行三段数：「执行成功」「有产出」「落盘还剩多少」是三件事。
	// 真机 P1 260902：`resultCount` 报 15 条候选，plan 里只有 8 行 result、且全指向 **1 条**素材
	// ——只看那一个数会让调用方判「料够了」，而实际上这个 beat 一删就空。
	const planStats = summarizePlanCandidates(plan);
	log.ok(
		`候选清单已生成：${planPath}（${beats.length} beat · ${okCount}/${totalQueries} query **执行**成功` +
			` · 其中 ${zeroYieldQueries.length} 条零候选 · plan 落盘 ${planStats.planResults} 行 / ${planStats.distinctClips} 个素材` +
			`；逐条日志里的 ${resultCount} 条候选是**去重前**口径）`,
	);
	// 零产出点名（非致命）：此前调用方只能去 57 行 dim 灰 info 里自己扒 `→ 0 条候选`。
	// ⚠️ 这条 warn MUST NOT 改退出码、MUST NOT 触发任何补检索——只是把已知事实说出来。
	// `--lay 0`（只出 plan 不铺轨）下同样会走到这里：lay 侧的 emptySlots / upsell 通道那时整段不执行，
	// 本条是该场景下唯一的告警通道。
	if (zeroYieldQueries.length > 0) {
		const head = zeroYieldQueries.slice(0, 5).map((q) => `「${q}」`).join("、");
		log.warn(
			`${zeroYieldQueries.length} 条 query 执行成功但**零候选**：${head}${zeroYieldQueries.length > 5 ? ` 等 ${zeroYieldQueries.length} 条` : ""}。\n` +
				"这些词在索引域里一条都没检出（≠ 被 beat 内去重折叠——折叠的那种仍在同 beat 兄弟 query 名下，池子不少料）。\n" +
				"想补：换更具象的检索词，或给这些 beat 补素材后重跑。",
		);
	}
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
				...arrangeWiring(opts, ctx.cfg),
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
	// 卡脖子 upsell（extend-upsell-to-clip-search）：external 档留了空槽才提示——
	// 空槽落到成片就是黑底空洞。独立顶层字段，lay 账面一字不改；internal 与本地模式恒不提示。
	const layUpsell = decideLayUpsell(
		ctx.memberType,
		Number((laySummary as { dedup?: { emptySlots?: number } } | undefined)?.dedup?.emptySlots ?? 0),
	);
	const result: MatrixResult = {
		ok: refused === undefined && !declined,
		mode: "plan",
		memberType: ctx.memberType,
		...(ctx.columnId ? { columnId: ctx.columnId } : {}),
		planPath,
		...(refused ? { refused, reason: "tracks_edited", planReusable: true } : {}),
		...(declined ? { reason: "image_move_billing_declined", planReusable: true } : {}),
		// 只预估不执行（add-arrange-estimate-only）：**成功**结局，与 declined 互斥且形态不同
		...(laid?.estimateOnly ? { estimateOnly: true, planReusable: true } : {}),
		// 图片运镜计费账面（仅本轮真有图片候选参与时出现；纯视频候选行为与图片能力引入前一致）
		...(laid?.imageBilling ? { image_move_billing: laid.imageBilling } : {}),
		...(laySummary ? { lay: laySummary } : {}),
		// 素材落盘自检（material-integrity-check）：只在**真写回过**的路径上出现。
		// 字段缺席 = 「本次没查」，MUST NOT 用空结果冒充「查过且干净」；与 `gtrk mg` 同名同形。
		...(laid?.integrity ? { integrity: laid.integrity } : {}),
		...(layUpsell ? { upsell: layUpsell } : {}),
		reprojection: reproj.summary,
		counts: {
			beats: beats.length,
			queries: totalQueries,
			results: resultCount,
			errors: errCount,
			// [add-broll-plan-summary-honesty] 新增三键纯增量：既有四键取值与语义一字不改
			zero_yield: zeroYieldQueries.length,
			plan_results: planStats.planResults,
			distinct_clips: planStats.distinctClips,
		},
	};
	if (!result.ok) process.exitCode = 1;
	if (layUpsell && !opts.json) log.warn(layUpsell.message);
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

/**
 * 编排期 QC 执行体（P3.2）：预估 → 确认 → 跑闭环。
 *
 * 抽出来是因为 `layIntoProject` 已经很长，而这段有完整的「先问再花钱」动线。
 * 拿不到 lead 句（无 dispatch / 重投影降级）时**如实说明并跳过**——
 * MUST NOT 当成「查过了都没问题」，那是把没做的事说成做过了。
 */
async function runArrangeQcHere(
	plan: BrollPlan,
	baseDir: string,
	reproj: ReprojectResult,
	arrangeOnce: (p: BrollPlan) => Promise<Awaited<ReturnType<typeof runArrangeWithFallback>>>,
	/** 首轮编排产物：QC 被跳过 / 被取消时原样交回（那些路径不该重跑一次编排）。 */
	first: Awaited<ReturnType<typeof runArrangeWithFallback>>,
	layOpts: { yes: boolean; deps: MatrixRunDeps; describeEndpoint?: DescribeEndpoint },
	log: { info: (m: string) => void; warn: (m: string) => void },
): Promise<{
	res: Awaited<ReturnType<typeof runArrangeWithFallback>>;
	plan: BrollPlan;
	residual: Array<{ beat: string; sentence: string }>;
}> {
	const dispatchPath = join(baseDir, "split", "dispatch.json");
	const dispatch = existsSync(dispatchPath)
		? (JSON.parse(readFileSync(dispatchPath, "utf8")) as { film_broll?: Array<{ beat?: string; span?: { from?: string } }> })
		: undefined;
	const leads = leadSentencesFrom(dispatch, reproj.utteranceIndex);
	if (leads.length === 0) {
		log.warn(
			"编排期质检跳过：拿不到卡点句（没有 dispatch，或口播轨重投影降级）——" +
				"**这不等于查过了没问题**，本轮的画音对齐没有被检查。",
		);
		return { res: first, plan, residual: [] };
	}
	if (!layOpts.describeEndpoint) {
		log.warn("编排期质检跳过：未配置素材理解端点。");
		return { res: first, plan, residual: [] };
	}

	// 预估 + 确认：判定按帧计费（每个卡点句 1 帧/轮，上限 MAX_QC_ROUNDS 轮）
    const maxFrames = leads.length * MAX_QC_ROUNDS;
	log.info(
		`编排期质检：${leads.length} 个卡点句，最多判 ${maxFrames} 帧` +
			`（每句 1 帧 × 最多 ${MAX_QC_ROUNDS} 轮；命中判定缓存的不重复计费）。`,
	);
	if (!layOpts.yes) {
		const go = await (layOpts.deps.confirm ?? confirmViaStdin)(`确认发起编排期质检（最多 ${maxFrames} 帧判定）？`);
		if (!go) {
			log.info("已取消编排期质检——零判定零计费，本轮按未质检的编排产物落轨。");
			return { res: first, plan, residual: [] };
		}
	}

	const sources = new Map<string, string>();
	for (const b of plan.beats) {
		for (const q of b.queries) {
			for (const r of q.results ?? []) if (typeof r.local_path === "string") sources.set(r.clip_id, r.local_path);
		}
	}
	// ffmpeg 缺失不炸整命令：抽不到帧的探针一律回 partial（判不了 ≠ 判不对，见 arrange-qc-bind）
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) log.warn("未找到 ffmpeg，编排期质检抽不到帧——本轮各句按「跳过判定」处理，不当作画面不对。");
	const judge = makeJudge({
		endpoint: layOpts.describeEndpoint,
		ffmpeg: ffmpeg?.ffmpeg ?? "ffmpeg",
		sourcePathFor: (id) => sources.get(id),
		log,
	});

	let db: Awaited<ReturnType<typeof openLocalIndexDb>> | undefined;
	try {
		try {
			if (existsSync(localIndexDbPath())) db = await openLocalIndexDb(localIndexDbPath());
		} catch (e) {
			// 判定缓存打不开只是「这轮多花点钱」，不该让质检整个做不成
			log.warn(`判定缓存不可用（${(e as Error).message}）——本轮照跑，只是重跑时不能复用判定。`);
		}
		const out = await runArrangeQc(plan, leads, {
			arrange: (p) => arrangeOnce(p as BrollPlan),
			// ★ 取**全部 beat 的首轨**槽位：lead 句跨多个 beat，只取第一个 beat 会让后面的句
			//   全部落进「没铺到东西」而被静默跳过——看起来通过了，其实一句都没查。
			//   首轨（trackOrder 0）是默认可见的主候选轨，用户看到的就是它。
			slotsOf: (o) => [...o.outcome.fills.values()].flatMap((tracks) => tracks[0] ?? []),
			judge,
			...(db ? { cache: sqliteQcCache(db, brollMaterialIdFor) } : {}),
			log,
		});
		return {
			res: out.outcome,
			plan: out.plan as BrollPlan,
			residual: out.residual.map((p) => ({ beat: p.beat, sentence: p.sentence })),
		};
	} finally {
		db?.close();
	}
}

/** 云端编排接线（两处 caller 共用一份，避免两边漂移）。
 *
 * 端点在 `local` 档**不解析**：那一档一个网络字节都不该动，连凭据都不必读。 */
function arrangeWiring(
	opts: MatrixOpts,
	cfg: { base: string; apiKey: string } | undefined,
): { arrangeMode?: ArrangeMode; arrangeCostCap?: number; arrangeEndpoint?: ArrangeEndpoint; arrangeEstimateOnly?: boolean } {
	const arrangeMode = parseArrangeMode(opts.arrange);
	const costCap = parseArrangeCostCap(opts.arrangeCostCap);
	const qc = opts.arrangeQc === true;
	return {
		...(arrangeMode !== undefined ? { arrangeMode } : {}),
		...(costCap !== undefined ? { arrangeCostCap: costCap } : {}),
		// ★ 端点只在**显式 local** 时不解析。抽芯后不传 `--arrange` 是 auto，
		//   本地素材路会定档 cloud —— 那时端点必须已经在手，否则 auto 永远走不到云端。
		...(arrangeMode !== "local" && cfg ? { arrangeEndpoint: { url: resolveArrangeUrl(cfg.base), apiKey: cfg.apiKey } } : {}),
		...(qc ? { arrangeQc: true } : {}),
		...(opts.arrangeEstimateOnly === true ? { arrangeEstimateOnly: true } : {}),
		// 判定端点只在真要判时解析（不开 QC 的那条路一个网络字节都不该动）
		...(qc && cfg ? { describeEndpoint: { url: resolveDescribeUrl(cfg.base), apiKey: cfg.apiKey } } : {}),
	};
}

/** --arrange 解析：local|shadow|cloud；**不传 = auto**（返回 undefined，定档推迟到拿到 plan）。
 *
 * ★ 2026-08-31 抽芯（P4.1，主理人裁定「本地素材全部走云端」）：缺省从写死的 `local`
 * 改为**按业务线分流**（见 `resolveAutoArrangeMode`）。分流依赖 `plan.member_type`，
 * 而它要读完工程才知道 —— 所以这里只能返回「没指定」。
 *
 * 越界仍即参数错误，MUST NOT 静默忽略：把 `--arrange cloub` 的笔误当成缺省跑掉，
 * 用户会以为自己指定的那一档生效了。 */
function parseArrangeMode(raw: string | undefined): ArrangeMode | undefined {
	if (raw === undefined) return undefined;
	if (raw === "local" || raw === "shadow" || raw === "cloud") return raw;
	throw new Error(`--arrange 只支持 local、shadow 或 cloud（得到「${raw}」）`);
}

/** 档位定案（P4.1 抽芯）：**本地素材路只能走云端**，素材矩阵路逐字不动。
 *
 * 「按业务线切，不按算法切」落到档位上的执行面（design §8′ 终裁 + 主理人 2026-08-31
 * 两次拍板：「以后涉及本地素材的，就全部走云端了，不需要维护两套」→
 * 「我想要把本地编排完全丢掉，只能走我们云端编排」）。
 *
 * 于是本地素材路上：不传 = `cloud`；**显式传 `local` 直接报参数错**。
 * 留一个「用旧引擎」的口子等于两套引擎都得维护，而用户还会在不知情时拿到冻结那套的产物
 * ——那正是这次要消灭的东西。
 *
 * ⚠️ 「完全丢掉」是**用户面**的，不是代码面：`planBeatFills` **删不掉**，
 * 素材矩阵路仍要在本地跑同一份（§8′ 明载「两条路共用的算法仍将随包公开——矩阵路需要它」）。
 * 本函数关的是本地素材路通往它的那扇门。
 *
 * ★ 唯一的例外是 `GITRUCK_ARRANGE` 总闸，它在本函数**之后**生效（见 `resolveArrangeMode`）：
 * 那是**我们**的止血阀不是用户的逃生舱——云端编排真出故障时，没有它就只能眼看所有人停工。 */
function resolveAutoArrangeMode(explicit: ArrangeMode | undefined, plan: BrollPlan): ArrangeMode {
	if (!isLocalArrangeScope(plan)) return explicit ?? "local";
	if (explicit === "local") {
		throw new Error(
			"本地素材的 B-roll 编排只能走云端，`--arrange local` 已不再受理。\n" +
				"编排算法自 2026-08-31 起只在服务端迭代；再留一条本机旧路，等于让你在不知情时拿到另一套算法的结果。\n" +
				"⚠️ 它**不是**一个「省钱」开关——用素材矩阵的素材同样要付检索费。两条路都要花钱，只是花在不同环节。\n" +
				"（素材矩阵那条路的**编排**不受影响、仍在本机跑且不计费；它的**检索**照旧按次计费。）",
		);
	}
	return explicit ?? "cloud";
}

/** --arrange-cost-cap 解析：正整数；越界即参数错误。 */
function parseArrangeCostCap(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) throw new Error(`--arrange-cost-cap 须为正整数（得到「${raw}」）`);
	return n;
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
	/** 只预估不执行（add-arrange-estimate-only）：**成功**结局，MUST NOT 与 declined 混用。 */
	estimateOnly?: boolean;
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
 * 拒铺报因三件套（缺一不可）：① 是哪条轨 ② 判定证据 ③ 下一步与逃生门用法。
 * **计费前预判**与**落轨定案**两处共用本函数（文案 MUST NOT 各写一份——分家后两条路会报出不同的话，
 * 而用户根本分不清自己撞的是哪一条）。
 */
function reportLayRefusal(keptEditedTracks: number[], warnings: string[]): void {
	log.err(
		`拒绝铺轨：${keptEditedTracks.length} 条候选轨已被你在客户端编辑过（track_index ${keptEditedTracks.join("/") || "-"}）——` +
			"本次不剥它们、也不铺新轨，工程文件零改动。",
	);
	for (const w of warnings) log.warn(w); // 逐轨证据：clip 数 vs 登记条数 / material 是否已变 broll-raw-*
	log.warn(
		"下一步二选一：① 在客户端处置那条轨（删掉 / 移走 / 改用别的轨）后重跑本命令；" +
			"② 确知要丢弃那条轨上的编辑 → 加 --force-relay 强制剥离重铺" +
			"（会删掉已确认原片的 broll-raw-* 素材登记，盘上原片文件成孤儿，不可恢复）。",
	);
	log.warn("已产出的 broll-plan.json 与已落盘的 preview 代理照常可用——拒的只是「改工程」这一步。");
}

/**
 * 候选铺轨：先平铺定颗粒（planBeatFills）→ 对全部槽位 clip 备好素材引用（云端候选下载代理：
 * preview 优先 → 推导 → 404 回落 raw；本地候选免下载，downloads 注入 rel=素材绝对路径）
 * → layBrollTracks → 原子写回 → 素材落盘自检（只读）。
 * 任何整体性失败（工程缺失/非 v1/revision 冲突）都不影响已产出的 plan。
 */
async function layIntoProject(
	baseDir: string,
	/** ⚠️ 可重赋值：编排期 QC 换候选时会把它换成「删过段的 plan」。 */
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
		/** [add-shot-cards-and-alignment-qc] 看点权重（与 mark 正交）：0..1，缺省 0 零回归。 */
		highlightWeight?: number;
		/** highlight 查询闭包（runLayMode 供给；缺省=全部中性）。 */
		highlightLookup?: MarkLookup;
		/** 句界吸附目标比例（adjust-shot-cut-sentence-align）：缺省 CUT_ALIGN_DEFAULT；0=关闭。 */
		cutAlign?: number;
		/** 主轨 gap 填充模式（adjust-main-track-gap-fill）：缺省 solid；仅音频驱动工程主轨生效。 */
		gapFill?: GapFillMode;
		/** 用户是否显式传了 --gap-fill（口播工程「不适用」提示只对显式传参出，缺省态不制造噪音）。 */
		gapFillExplicit?: boolean;
		/** 编排取数路（add-broll-arrange-atom P3.1）：缺省 `local` = **行为逐字节与本 change 之前一致**。
		 * `shadow` 本地照跑 + 云端只对拍不采纳；`cloud` 采纳云端产物（自校验不过即回落本地）。
		 * 总闸 `GITRUCK_ARRANGE=off` 可单向压回 local。 */
		arrangeMode?: ArrangeMode;
		/** 云端编排的本次编排量硬上限（超限服务端前置拒绝、零执行零计费）。 */
		arrangeCostCap?: number;
		/** 云端编排端点（缺省由 apiBase 推导；缺凭据 ⇒ 回落本地）。 */
		arrangeEndpoint?: ArrangeEndpoint;
		/** 编排期 QC（P3.2）：缺省关 = 行为逐字节与开工前一致。 */
		arrangeQc?: boolean;
		/** 只预估不执行（add-arrange-estimate-only）：走到计价确认那一步即停。 */
		arrangeEstimateOnly?: boolean;
		/** 素材理解端点（QC 判定用；缺省由 apiBase 推导）。 */
		describeEndpoint?: DescribeEndpoint;
	} = { imageBroll: true, yes: false, deps: {} },
): Promise<LayOutcome | undefined> {
	const imageOpts = layOpts;
	const gtrkPath = locateGtrk(baseDir);
	if (!gtrkPath) {
		log.warn(`未找到工程文件（${join(baseDir, "gtrk", "project.gtrk")}），跳过铺轨——plan 已产出，可后续在有工程的目录重跑`);
		return undefined;
	}
	// ── 工程读取①（规划用）：此处**不持有 revision** ──
	// revision 改在全部耗时动作完成之后取（见下方「写回前重读」）：把冲突窗口从「跨越整个下载期」
	// 的秒~分钟级收回毫秒级（fix-lay-refuse-order-and-qc-holes 1.2；也是 broll_arrange 网络往返的地基）。
	const { gtrk, revision: planningRevision } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);

	// ── ②-B 拒铺**前置**（fix-lay-refuse-order-and-qc-holes 1.1）─────────────────────────
	// 公约「计费动作恒在停点之后」：能不能铺是本命令的停点，而运镜生成是真计费动作
	// （image_move 2 积分/张）。此前裁定只在 layBrollTracks 内部跑、位置在运镜计费**之后**
	// ⇒ 判拒铺时积分已扣、工程零改动、运镜产物成孤儿（用户为一次没发生的铺轨付了钱）。
	// 现把同一份裁定（wouldRefuseLay，与落轨定案同源）提到一切计费/下载/落盘动作之前，
	// 拒铺即短路：零云端调用、零下载、零改动。
	// 定案权威仍在 layBrollTracks（以写回前重读的当刻工程再判一次）——预判只负责挡住
	// 「开跑前就已被编辑」这个常见情形，MUST NOT 取代定案。
	const pre = wouldRefuseLay(gtrk, forceRelay);
	if (pre.refused) {
		reportLayRefusal(pre.keptEditedTracks, pre.warnings);
		return {
			lay: {
				refused: true,
				keptEditedTracks: pre.keptEditedTracks,
				laidTracks: [],
				laidClips: 0,
				removedTracks: [],
				blackTrack: null,
				blackBedHoleSec: 0,
				blackBedHoles: [],
				// 预判发生在下载之前：本轮一个字节都没下（`imageBilling` 一并缺席 = 本轮零计费）
				downloads: { preview: 0, raw: 0, reused: 0, failed: 0, local: 0 },
			},
		};
	}

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
	const decisionOpts = {
		noImage: !layOpts.imageBroll,
		dedupScope: layOpts.dedupScope,
		markWeight: layOpts.markWeight,
		markLookup: layOpts.markLookup,
		highlightWeight: layOpts.highlightWeight,
		highlightLookup: layOpts.highlightLookup,
		...(cutStarts ? { cutAlign: { ratio: cutRatio, starts: cutStarts } } : {}),
		...(gapModeEff !== "none" ? { gapFill: gapModeEff } : {}),
	};
	// 编排取数路（P3.1 → P4.1 抽芯）：**不传 `--arrange` 时按业务线定档**——
	// 本地素材路走 cloud，素材矩阵路走 local（逐字不动）。显式档位恒优先。
	// 云端档只承担本地素材上轨铺排；素材矩阵路由 isLocalArrangeScope 挡在门外，
	// 那不是回滚，是终裁「按业务线切，不按算法切」的执行面。
	let arrangeMode = resolveArrangeMode(resolveAutoArrangeMode(layOpts.arrangeMode, plan));
	// ★ 抽芯的实质：本地素材路**不再自动回落本地**。
	//   端点不可达 / 服务端业务拒绝 / 产物结构违约 ⇒ 明确报错，而不是悄悄换一套算法把活干完。
	//   理由是诚实性：回落产出的是**另一套算法**的结果，用户以为自己拿到的是云端那套。
	//   保留两个例外，见 arrange-gate 的 `strictCloud` 注释（总闸 / 自校验）。
	//
	// 曾想再补一条「没配凭据 ⇒ 回落而非报错」，实测后**撤掉了**：`runLayMode` 开头就
	// 无条件 `loadConfig()`，缺 Key 在这之前几百行就已经明确报错了 —— 那个分支不可达。
	// 不可达的兜底 + 跑不起来的测试，比没有更糟（它会让人以为这条路被守住了）。
	const strictCloud = isLocalArrangeScope(plan);
	// ── 只预估不执行（add-arrange-estimate-only）：停在**计价确认之前**，与确认门同一处取值 ──
	//    MUST NOT 另算一份编排量——两处各算一遍，预估与实收迟早会漂，而漂了没人会发现。
	//    结局是**成功**：「我在做决定」不是「我拒绝了」，压成同一个 declined 会让调用方分不清。
	if (layOpts.arrangeEstimateOnly) {
		const applicable = arrangeMode !== "local" && isLocalArrangeScope(plan);
		if (!applicable) {
			// 素材矩阵路 / 总闸压回 local：那条路的编排在本机跑、不计编排量。
			// **MUST NOT 报 0** —— 0 会被读成「云端跑但免费」，与「根本不走云端」是两回事。
			log.info("本轮不走云端编排（素材矩阵路或总闸已压回本机），无编排量可估——本机编排不计费。");
			return { estimateOnly: true, lay: { estimateOnly: true, arrange: { applicable: false } } };
		}
		const scale = scaleOfRequest(plan, layN, decisionOpts);
		const units = arrangeUnits(scale);
		log.info(
			`本次云端编排的**编排量**预估为 ${units}` +
				`${layOpts.arrangeCostCap !== undefined ? `（本次上限 ${layOpts.arrangeCostCap}）` : ""}。` +
				"只预估未执行：零云端调用、工程文件零改动。去掉 --arrange-estimate-only 即可真跑。",
		);
		return {
			estimateOnly: true,
			lay: {
				estimateOnly: true,
				arrange: {
					applicable: true,
					units,
					...(layOpts.arrangeCostCap !== undefined ? { costCap: layOpts.arrangeCostCap } : {}),
					scale,
				},
			},
		};
	}
	// 预估确认门（P2.2b）：云端档跑前报编排量并征求确认。**只在真会发请求时问**——
	// 素材矩阵路与总闸压回的 local 档都不该弹一个用户答了也不会发生的问题。
	if (arrangeMode !== "local" && isLocalArrangeScope(plan)) {
		const confirmFn = layOpts.deps.confirm ?? (process.stdin.isTTY ? confirmViaStdin : undefined);
		const gate = await estimateGate(arrangeUnits(scaleOfRequest(plan, layN, decisionOpts)), {
			assumeYes: layOpts.yes,
			...(layOpts.arrangeCostCap !== undefined ? { costCap: layOpts.arrangeCostCap } : {}),
			// ★ 无 TTY 时**不传 confirm**，让 estimateGate 的 `no_tty` 分支真正可达。
			//   那条分支一直存在却从来跑不到（调用方永远传了 confirm），翻面前不暴露是因为
			//   云端档是 opt-in；缺省翻成 cloud 后它落到主路上，`confirmViaStdin` 会在
			//   agent 驱动 / CI 这类无 stdin 的场景**永久阻塞**。这是抽芯当天实测撞到的。
			...(confirmFn ? { confirm: confirmFn } : {}),
			log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
		});
		// 拒绝/无从确认 ⇒ **整轮铺轨中止**，工程零改动、零云端调用。
		//
		// ⟲ 2026-08-31 二次拍板前，这里是「回落本地编排、工程照常完成」。那条依赖
		//   「本地还有第二个引擎可退」这个前提；主理人裁定「把本地编排完全丢掉」后前提没了，
		//   再回落就是拿素材矩阵路那份**不再更新**的算法冒充云端产物交给他。
		//   ⇒ 改成中止，姿势对齐同命令里既有的 `image_move_billing_declined`：
		//   不花钱就不给货，但**plan 照常可用**、工程一个字节没动，他随时可以改主意重跑。
		if (!gate.proceed) {
			log.err(
				"已取消：本地素材的 B-roll 编排计费确认被拒绝——本轮铺轨中止，工程文件零改动、零云端调用" +
					"（broll-plan.json 照常可用，随时可重跑）。\n" +
					"这一步只在云端跑，没有本机备用算法可退——不确认就没有编排结果。\n" +
					"可用 --yes 跳过确认，或 --arrange-cost-cap 先设个上限再跑。",
			);
			return {
				declined: true,
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
	}
	const gateLog = { info: (m: string) => log.info(m), warn: (m: string) => log.warn(m) };
	const arrangeOnce = (p: BrollPlan) =>
		runArrangeWithFallback(p, layN, scoreFloor, decisionOpts, arrangeMode, {
			runLocal: () => planBeatFills(p, layN, scoreFloor, decisionOpts),
			...(layOpts.arrangeEndpoint ? { endpoint: layOpts.arrangeEndpoint } : {}),
			...(layOpts.arrangeCostCap !== undefined ? { costCap: layOpts.arrangeCostCap } : {}),
			...(strictCloud ? { strictCloud: true } : {}),
			log: gateLog,
		});

	// 编排期 QC（P3.2）：缺省关 ⇒ 与开工前逐字节一致。开启时把「铺完→渲→看→重铺→再渲」
	// 那两轮收成落轨前的一个闭环，全程零渲染。它对本地档与云端档**一样成立**——
	// 闭环只调 arrangeOnce，不关心产物来自哪一侧。
	let arrangeRes = await arrangeOnce(plan);
	let qcResidual: Array<{ beat: string; sentence: string }> = [];
	if (layOpts.arrangeQc) {
		const qcOut = await runArrangeQcHere(plan, baseDir, reproj, arrangeOnce, arrangeRes, layOpts, gateLog);
		arrangeRes = qcOut.res;
		plan = qcOut.plan;
		qcResidual = qcOut.residual;
	}
	const { fills, clipIds, stats: fillStats, pinnedOutcome, markStats, anchors: anchorOutcomes, cutAlign: cutAlignStats, gapFills, direct: directOutcomes } = arrangeRes.outcome;
	if (arrangeRes.source === "cloud") {
		log.info(`本轮 B-roll 编排由云端产出（编排量 ${arrangeRes.units ?? "?"}）——本地复算自校验一致。`);
	}
	void qcResidual;

	// ── L1 结构自检（P3.3）：闪帧风险前置声明。**零成本恒开**——只看已有数据，不抽帧不调模型。
	//    风险要在落轨前说出来，不等渲完了才发现。⚠️ `cuts` 缺省（没扫过，不可判）与 `cuts: []`
	//    （扫过且无切点，可判且无风险）是两件事，混为一谈会让「不可判」被静默说成「安全」。
	{
		// ★ 三态化（fix-cut-scan-warning-semantics §2）：MUST NOT 再让一个 `undefined` 兼四义。
		//   旧写法把「云端候选」「图片伪段」「整个没有 segments 数组」「plan 里找不到候选」
		//   四种**不适用**，和唯一真正的「没扫过切点」全都回成 `undefined`，
		//   于是分母虚高、还给它们开出「重跑索引」这条永远无效的处方。
		const probes: CutsProbeSlot[] = [];
		const na = emptyNotApplicable();
		for (const [beat, tracks] of fills) {
			for (const slot of tracks[0] ?? []) {
				const got = classifyCutsProbe(plan, slot.clip_id, slot.clip_st);
				if (got.kind === "na") na[got.why]++;
				else probes.push({ beat, clipId: slot.clip_id, cuts: got.cuts });
			}
		}
		// 判据成立数为 0 时静默——分母为 0 的告警说不出任何事实
		const notice = probes.length ? flashRiskNotice(flashRiskOf(probes), na) : null;
		if (notice) log.warn(notice);
	}
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
	// 高档直排落位回报（add-arrange-direct-tier）：spec 要求「诚实边界 SHALL 可被用户知晓」，
	// 而回执产出来没人消费就等于没有。三类必须出声，其余逐槽 info。
	//
	// ★ 文案**按机读 `code` 现渲染**，MUST NOT 直接印服务端送来的 `reason`：
	// 那个字段内嵌数值，刻意不在跨语言契约面上（JS 出 "1"、Python 出 "1.0"），
	// 服务端本就不送。现渲染让本地路与云端路说同一句话，也断掉文案漂移。
	const directWhy = (d: { code?: string; starved_sec?: number }): string => {
		switch (d.code) {
			case "sliver":
				return `精修后短于最小可用镜头长——已按指令照落，成片上会是一个很短的镜头`;
			case "overlap":
				return "指定的时间线位置与另一直排槽重叠（位置是硬约束，不做静默移位）";
			case "out_of_beat":
				return "指定的时间线位置越出 beat 窗口";
			case "no_room":
				return "beat 内已无足够空隙容纳该直排槽";
			case "beat_no_span":
				return "beat 窗口无长度";
			default:
				return "未知原因";
		}
	};
	if (directOutcomes?.length) {
		const cnt = { planned: 0, sliver: 0, rejected: 0 };
		for (const d of directOutcomes) {
			cnt[d.status]++;
			if (d.status === "rejected") {
				log.warn(`${d.beat} 直排槽 clip ${d.clip_id} 未落位：${directWhy(d)}——该段没有画面，MUST NOT 当成已铺`);
				continue;
			}
			if (d.status === "sliver") log.warn(`${d.beat} 直排槽 clip ${d.clip_id}：${directWhy(d)}`);
			// ★ 诚实边界一：查不到帧率 ⇒ 帧网格吸附整步没生效。MUST NOT 让用户以为「直排就不闪帧」。
			if (d.fps === null) {
				log.warn(
					`${d.beat} 直排槽 clip ${d.clip_id}：全 plan 都查不到这条素材的帧率，**帧网格吸附未生效**——` +
						`端点可能落在非整帧上，不同播放器/渲染器会各自取整。把这条素材过一遍索引即可消除。`,
				);
			}
			// ★ 诚实边界二：源窗供不满承诺轨长 ⇒ 末帧会驻留（超过一帧才报，亚帧渲染侧不可见）
			if (typeof d.starved_sec === "number") {
				log.warn(
					`${d.beat} 直排槽 clip ${d.clip_id}：源窗比你给的时间线窗短 ${d.starved_sec}s，` +
						`成片上这一段的最后一帧会静止这么久。要么把源窗给长一点，要么把时间线窗收短。`,
				);
			}
			if (d.status === "planned" && d.fps !== null) {
				// 「按你的要求没动端点」与「素材没索引所以动不了」是两种处置，措辞必须分开
				const snap =
					d.cut_snap === "skipped_quote"
						? " · 引用段：按你的标注**不动端点**，端点残片保留"
						: d.cut_snap === "no_data"
							? " · 无切点数据，仅帧网格吸附"
							: "";
				log.info(`${d.beat} 直排槽 clip ${d.clip_id} 钉 ${d.track_st}s（精修${d.refined ? "已生效" : "未改动端点"}${snap}）`);
			}
		}
		log.info(`高档直排：落位 ${cnt.planned} · 过短照落 ${cnt.sliver} · 未落位 ${cnt.rejected}（共 ${directOutcomes.length} 槽）`);
	}
	const markOn = typeof layOpts.markWeight === "number" && layOpts.markWeight > 0;
	const hlOn = typeof layOpts.highlightWeight === "number" && layOpts.highlightWeight > 0;
	// 信号覆盖率（add-signal-coverage-reporting）：分母是**参与融合的候选段总数**——
	// 靠 fix-arrange-diagnostics-granularity 把 markStats 换成段粒度之后这个数才算得准
	// （此前是 Set<clip_id>，二创单素材场景下恒 1/1）。
	const covOf = (hit: number, neutral: number): number | undefined => (hit + neutral > 0 ? r3num(hit / (hit + neutral)) : undefined);
	const markCov = markOn ? covOf(markStats.hit, markStats.neutral) : undefined;
	const hlCov = hlOn ? covOf(markStats.hlHit, markStats.hlNeutral) : undefined;
	const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`;
	if (markOn) {
		log.info(
			`美观度权重（w=${layOpts.markWeight}）：mark 缓存命中 ${markStats.hit} 段 / 共 ${markStats.hit + markStats.neutral} 段` +
				`${markCov === undefined ? "" : `（覆盖率 ${pct(markCov)}）`}`,
		);
	}
	if (hlOn) {
		log.info(
			`看点权重（w=${layOpts.highlightWeight}）：highlight 缓存命中 ${markStats.hlHit} 段 / 共 ${markStats.hlHit + markStats.hlNeutral} 段` +
				`${hlCov === undefined ? "" : `（覆盖率 ${pct(hlCov)}）`}`,
		);
	}
	// 覆盖率告警分两档（add-signal-coverage-reporting）。合并成一句是错的：
	// **零覆盖**是「权重完全没起作用」，根因通常是本片没 describe 过；
	// **低覆盖**是「只对少数段起作用」，那时往往**已经 describe 过了**，真因是素材长而描述帧稀疏
	// （超出就近命中上限的段拿不到信号）——对这一档说「先跑 describe」是条错建议。
	// 旧判据只认 hit===0，走查实测 6.3% 覆盖率完全不触发，用户以为加权在跑。
	const dims: { name: string; flag: string; cov: number | undefined }[] = [
		...(markOn ? [{ name: "美观度", flag: `--mark-weight ${layOpts.markWeight}`, cov: markCov }] : []),
		...(hlOn ? [{ name: "看点", flag: `--highlight-weight ${layOpts.highlightWeight}`, cov: hlCov }] : []),
	];
	const zeroCov = dims.filter((d) => d.cov === 0).map((d) => `${d.name}（${d.flag}）`);
	const lowCov = dims.filter((d) => d.cov !== undefined && d.cov > 0 && d.cov < SIGNAL_COVERAGE_LOW);
	if (zeroCov.length) {
		log.warn(
			`${zeroCov.join(" 与 ")}权重开了但**本片零缓存覆盖**：全部候选按中性处理，排序与不开权重完全一致（权重已回吐给语义分）。` +
				`根因通常是本 plan 未经理解——先跑 gtrk matrix describe --plan <plan 路径> 再重跑 lay 才有效；` +
				`手写 plan（免索引直排）也走这条路，此时美观度/看点/模糊降权三条信号一并不生效`,
		);
	}
	if (lowCov.length) {
		log.warn(
			`${lowCov.map((d) => `${d.name}（${d.flag}）覆盖率仅 ${pct(d.cov as number)}`).join("；")}` +
				`——只有这些候选段拿到了信号分，其余按中性处理，排序主要仍由语义分决定。` +
				`这一档通常**不是没 describe 过**，而是素材长、描述帧稀疏：一个素材往往只有一个时间点有描述行，` +
				`离它太远的段就近命中不上。要提高覆盖率得让描述帧更密，重跑一次 describe 不会改善`,
		);
	}
	// pinned 让位必须明示（matrix-command spec：冲突后到让位并 summary 明示，MUST NOT 静默）
	if (pinnedOutcome.yielded.length) {
		// 名单是**段键** `<clip_id>@<毫秒>`（fix-arrange-diagnostics-granularity）——整片单素材的工程
		// 里「哪一段没落上」正是用户唯一需要的信息，只报 clip_id 等于什么都没说
		log.warn(
			`钉选段未能全部入选（${pinnedOutcome.yielded.length}/${pinnedOutcome.requested.length} 段让位）：` +
				`${pinnedOutcome.yielded.join("、")}（钉选间冲突后到让位/供长不足/被排除）——` +
				`名单是「素材@段内锚点毫秒」；其余钉选段已优先满足；` +
				`要强保它们可减少同 beat 的钉选段数或放宽槽位（--lay/--top-k）后重跑`,
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

	// ── 工程读取②（写回用）：耗时动作全部完成后才取 revision ─────────────────────────────
	// 运镜生成 / 封面抽帧 / 代理下载是秒~分钟级动作；持有跨越它们的 revision，用户在此期间
	// 在客户端存一次工程，本轮就整体白跑（写回冲突、下载与运镜全部作废）。此刻重读后冲突窗口
	// = 重读到 rename 的毫秒级，且 writeGtrkAtomic 的 rename 前重检照旧兜底（那条 MUST NOT 删）。
	// 落轨据此对**当刻**工程判定与写回：剥旧裁定在此再跑一次（权威定案），预判只是它的前哨。
	const { gtrk: freshGtrk, revision } = readGtrk(gtrkPath);
	assertGtrkV1(freshGtrk);
	// 基底漂移 MUST NOT 静默：窗口内工程真被改过时，本轮 fills（切槽/句界吸附/gap 规划）算的是
	// 读①那份工程，却要铺到读②这份上。收紧前这种情形直接报写回冲突（整轮作废）；现在能铺完，
	// 但用户有权知道自己那次保存与本轮铺轨发生了交叠——差异大到影响观感时重跑一次即可。
	if (revision !== planningRevision) {
		log.warn(
			"工程在本轮铺轨期间被改动过（下载/运镜进行中你在客户端存了一次）：已按**改后**的工程落轨写回，" +
				"你那次保存不会被覆盖；但本轮槽位是按改动前的时间线切的，若改的是口播时间线，B-roll 位置可能与新时间线对不齐——" +
				"觉得不对就直接重跑一次本命令（plan 与已落盘代理都可复用，重跑很快）。",
		);
	}

	let { next, summary, warnings } = layBrollTracks({
		gtrk: freshGtrk,
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

	// ── ②-B 拒铺定案：存在「自产内容但已被你编辑」的轨且未开逃生门 → 一个字节都不动工程 ──
	// 常见情形已被计费前预判挡在花钱之前；能走到这里的只剩一种：**耗时动作期间**工程被改成了
	// 已编辑态（预判那刻还没有）。此时运镜可能已生成，账面如实报（下方 imageBilling）。
	if (summary.refused) {
		const list = summary.keptEditedTracks;
		reportLayRefusal(list, warnings);
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
		const canvas = freshGtrk.video_size as number[];
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
				gtrk: freshGtrk,
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
	writeGtrkAtomic(gtrkPath, written, revision);
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
		// ⚠️ 这份计数器 MUST 覆盖 `GapFillEntry["kind"]` 的**全部**取值——
		//    漏一个取值 tsc 会红（本次新增 `borrowed` 即由它抓到），别改成 Record<string, number> 绕过去
		const cnt: Record<GapFillEntry["kind"], number> = { candidate: 0, extend: 0, solid: 0, borrowed: 0, subfloor: 0 };
		for (const f of gf.fills) cnt[f.kind]++;
		log.info(
			gf.fills.length
				? `主轨 gap 填充（${gf.mode}）：${gf.fills.length} 处共 ${gf.filledSec}s（候选 ${cnt.candidate} · 延长 ${cnt.extend}` +
						`${cnt.borrowed ? ` · 跨 beat 借 ${cnt.borrowed}` : ""}${cnt.subfloor ? ` · 次地板补画面 ${cnt.subfloor}` : ""}` +
						` · 黑片 ${cnt.solid}）——主轨零 gap，客户端主轨磁吸安全`
				: `主轨 gap 填充（${gf.mode}）已开启：本轮无洞可填（主轨本就零 gap）`,
		);
		// 跨 beat 借候选如实告知（relax-gapfill-cross-beat-borrow）：MUST NOT 静默——
		// 借来的画面取自**别的 beat 的检索词**，与本段稿子的相关性天然弱于本 beat 自己的候选，
		// 那是本件的真实代价，用户有权知道并据此决定要不要去补素材。
		if (cnt.borrowed) {
			const items = gf.fills.filter((f) => f.kind === "borrowed");
			const head = items.slice(0, 5).map((f) => `${f.beat}=${f.sec}s`).join("、");
			log.warn(
				`有 ${cnt.borrowed} 处画面是**跨 beat 借**来的（合计 ${r3(items.reduce((n, f) => n + f.sec, 0))}s）：` +
					`${head}${items.length > 5 ? ` 等 ${items.length} 处` : ""}。\n` +
					"这些段自己的候选被别的 beat 先用掉了，为避免整段黑屏而从全片其它检索结果里取了料——\n" +
					"**画面与这几句稿子的相关性会弱一些**。想消掉：给这些 beat 补更贴的素材后重跑 `matrix search`。",
			);
		}
		// 次地板补画面如实告知（relax-gapfill-subfloor-picture）：这些槽**短于最小镜头长**，
		// 是快切。它们本来会是同样长的黑闪——换成画面是改善，但用户仍有权知道自己的成片里
		// 有几处不到 1.2s 的快切，以及它们在哪。
		if (cnt.subfloor) {
			const items = gf.fills.filter((f) => f.kind === "subfloor");
			const head = items.slice(0, 5).map((f) => `${f.beat}=${f.sec}s`).join("、");
			log.info(
				`有 ${cnt.subfloor} 处残洞短于最小镜头长（合计 ${r3(items.reduce((n, f) => n + f.sec, 0))}s），` +
					`已填**真画面**而非黑片：${head}${items.length > 5 ? ` 等 ${items.length} 处` : ""}。\n` +
					"这些是快切（不到 1.2s）——它们本来会是同样长的黑闪。槽长与切点未变，只换了内容。",
			);
		}
	}
	// ── [add-broll-plan-summary-honesty] 零候选 beat 出口 ─────────────────────────────
	// 决策层早就在 `matrix-lay.ts` 里算了 `beatsWithCandidates`（进了 LayResult.summary），
	// 但命令层这段是**逐键重投影**，没人把它投出去 ⇒ 事实上的死指标。名单侧同理：
	// 唯一会喊「这段底下没画面」的黑底空洞告警，恰好把「整 beat 零候选」显式豁免掉了
	// （matrix-lay-tracks spec:526 的沉默条件 + `metaBeats.filter((b) => b.laid.length > 0)`）。
	// ⚠️ 纯只读统计：本段 MUST NOT 参与任何铺轨决策，写回的 .gtrk 逐字节不受影响。
	// ⚠️ 名单口径 MUST 与 `summary.beatsWithCandidates` 同源（都走 `mergedCandidates` 的 beat 级并集），
	//    否则 `beatsWithCandidates + emptyBeats.length === plan.beats.length` 这条自洽式会破。
	const emptyBeats = plan.beats.filter((b) => mergedCandidates(b).length === 0).map((b) => b.beat);
	if (emptyBeats.length > 0) {
		// 归宿判据与 `matrix-lay.ts` 的 `gapFillOn` 同源：summary.gapFill 有键 ⟺ 填充真开着
		// （`gapFillOn && gapFillReq` 才写这个键），不必在命令层重算一遍那五个条件。
		const gapFillOn = summary.gapFill !== undefined;
		log.warn(
			`${emptyBeats.length} 个 beat **零候选**（整段没有任何可铺的画面）：${emptyBeats.slice(0, 12).join("、")}` +
				`${emptyBeats.length > 12 ? ` 等 ${emptyBeats.length} 个` : ""}。\n` +
				(gapFillOn
					? "已开主轨 gap 填充：这些段最终会是黑片，或从别的 beat 借来的画面（相关性天然更弱，逐条明细见 lay.gap_fill.fills）。"
					: "未开 gap 填充：这些段会露出主轨 A-roll（音频驱动工程跳铺黑底时则是画布底色）。") +
				"\n给这些 beat 补素材或换检索词后重跑 `gtrk matrix` 即可消掉。",
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
				// 同款：取用了 describe 判模糊候选的槽位数（fix-describe-cache-locality）
				blurrySlotsPlaced: fillStats.blurrySlotsPlaced,
				adjacentWaived: fillStats.adjacentWaived,
			},
			// mark 融合账面（add-audio-project-atoms）：仅开启时出现（默认 0 时 lay JSON 逐字节不变）
			...(markOn ? { mark_weight: layOpts.markWeight, mark_hit: markStats.hit, mark_neutral: markStats.neutral } : {}),
			// 看点维度同款账面（fix-describe-cache-locality）：仅开启时出现（关闭时 lay JSON 逐字节不变）
			...(hlOn
				? { highlight_weight: layOpts.highlightWeight, highlight_hit: markStats.hlHit, highlight_neutral: markStats.hlNeutral }
				: {}),
			// 信号覆盖率（add-signal-coverage-reporting）：逐维度给出比例，省得消费方自己除。
			// ⚠️ **权重为 0 的维度整键缺席，MUST NOT 补 0**——「没开这一维」与「开了但零覆盖」
			// 是两件事，补 0 会把它们抹平成同一个数，而那两件事的处置完全不同。
			// `coverage: null` 是第三档：开了、但一个候选段都没有（分母为 0，不可判）——同样 MUST NOT 写 0。
			...(markOn || hlOn
				? {
						signal_coverage: {
							...(markOn ? { mark: { hit: markStats.hit, neutral: markStats.neutral, coverage: markCov ?? null } } : {}),
							...(hlOn ? { highlight: { hit: markStats.hlHit, neutral: markStats.hlNeutral, coverage: hlCov ?? null } } : {}),
						},
					}
				: {}),
			// pinned 裁定账面（plan 可编辑契约）：plan 里有钉选才出现（无 pinned 时 lay JSON 逐字节不变）。
			// 三个数**同分母、按段计**（fix-arrange-diagnostics-granularity）：requested = placed + yielded 恒成立。
			...(pinnedOutcome.requested.length
				? {
						pinned: {
							requested: pinnedOutcome.requested.length,
							placed: fillStats.pinnedPlaced,
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
			// 高档直排账面（add-arrange-direct-tier）：plan 里有直排槽才出现（无则 lay JSON 逐字节不变）。
			// `fps: null` 与 `starved_sec` 是两条诚实边界，机读侧也要拿得到，MUST NOT 只打日志。
			...(directOutcomes?.length
				? {
						direct: {
							planned: directOutcomes.filter((d) => d.status === "planned").length,
							sliver: directOutcomes.filter((d) => d.status === "sliver").length,
							rejected: directOutcomes.filter((d) => d.status === "rejected").length,
							no_fps: directOutcomes.filter((d) => d.fps === null).length,
							cut_snap_skipped_quote: directOutcomes.filter((d) => d.cut_snap === "skipped_quote").length,
							cut_snap_no_data: directOutcomes.filter((d) => d.cut_snap === "no_data").length,
							starved: directOutcomes.filter((d) => typeof d.starved_sec === "number").length,
						},
						direct_details: directOutcomes.map((d) => ({
							beat: d.beat,
							clip_id: d.clip_id,
							track_st: d.track_st,
							status: d.status,
							refined: d.refined,
							has_cuts: d.has_cuts,
							cut_snap: d.cut_snap,
							fps: d.fps,
							...(d.code ? { code: d.code } : {}),
							...(d.code ? { why: directWhy(d) } : {}),
							...(typeof d.starved_sec === "number" ? { starved_sec: d.starved_sec } : {}),
						})),
					}
				: {}),
			laidTracks: summary.laidTracks,
			laidClips: summary.laidClips,
			// [add-broll-plan-summary-honesty] 候选覆盖账面：`beatsWithCandidates` 决策层早就算了，
			// 但一直没人在这段逐键重投影里补它 ⇒ 到不了产物。两键恒满足
			// `beatsWithCandidates + emptyBeats.length === plan.beats.length`（同源于 mergedCandidates）。
			beatsWithCandidates: summary.beatsWithCandidates,
			emptyBeats,
			removedTracks: summary.removedTracks,
			keptEditedTracks: summary.keptEditedTracks,
			blackTrack: summary.blackTrack,
			// 音频驱动跳铺明示（adjust-black-bed-audio-driven-skip）：仅跳铺时出现该键——
			// 口播 / --no-black-bed 路径的 lay JSON 逐字节零新键
			...(summary.blackBedSkipped ? { blackBedSkipped: summary.blackBedSkipped } : {}),
			// 主轨 gap 填充账面（adjust-main-track-gap-fill）：仅音频驱动形态且 mode ≠ none 时出现
			// ⚠️ 这里是**逐键重投影**，不是整个对象透传：决策层往 summary.gapFill 上加的新键
			// 若不在这里补一行，就永远到不了产物——机读那一半会变成死代码而无人察觉。
			...(summary.gapFill
				? {
						gap_fill: {
							mode: summary.gapFill.mode,
							filled_sec: summary.gapFill.filledSec,
							fills: summary.gapFill.fills,
							// 过短黑片账面（add-short-black-fill-warning）：条件键，无则整键缺席
							...(summary.gapFill.short_solid ? { short_solid: summary.gapFill.short_solid } : {}),
						},
					}
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

	// 卡脖子 upsell（extend-upsell-to-clip-search）：external 档搜不到才提示；
	// 本地索引模式（memberType==="local"）恒不提示——本地素材与矩阵无关，提了驴唇不对马嘴。
	// `--top-k` 缺省时按服务端默认值计，口径与 matrix material 完全一致。
	const adhocUpsell =
		ctx.memberType === "local"
			? undefined
			: decideMaterialUpsell(ctx.memberType, results.length, opts.topK ? Number(opts.topK) : TOP_K_DEFAULT);

	const result: MatrixResult = {
		ok: true,
		mode: "search",
		memberType: ctx.memberType,
		...(ctx.columnId ? { columnId: ctx.columnId } : {}),
		results,
		counts: { beats: 0, queries: 1, results: results.length, errors: 0 },
		// 独立顶层字段：MUST NOT 混进 results（agent 拿 results 当候选消费）
		...(adhocUpsell ? { upsell: adhocUpsell } : {}),
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
	if (adhocUpsell && !opts.json) log.warn(adhocUpsell.message);
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

// ── matrix material（通用三态素材检索：2×2 路由下半行）────────────────────

/** 单条人读摘要（下载向：BGM 场景要能直接点开试听，故直链恒出）。 */
function materialLines(r: MaterialResult, idx: number, scope: MaterialScope): string[] {
	const title = typeof r.title === "string" && r.title ? r.title : typeof r.note === "string" && r.note ? r.note.slice(0, 40) : String(r.id);
	const bits = [`${idx + 1}. ${title}`];
	if (typeof r.author === "string" && r.author) bits.push(String(r.author));
	if (typeof r.duration === "number") bits.push(`${Math.round(r.duration)}s`);
	if (r.audio_type) bits.push(r.audio_type === "song" ? "song（歌曲）" : r.audio_type === "pure" ? "pure（纯音乐）" : String(r.audio_type));
	if (typeof r.score === "number") bits.push(`score ${r.score}`);
	// external 档没有 is_copyright 字段——如实不显示（MUST NOT 补假值当「不可商用」讲）
	// [align-copyright-semantics-cli handoff 4.1] 复用词表正本常量：同一个位此前有两套词
	// （人读「非商用」/ 机读 `copyright_label` 的「不可商用」），转述的人会以为是两件事。
	if (typeof r.is_copyright === "boolean") bits.push(deriveCopyrightLabel(r.is_copyright) ?? "");
	if (typeof r.material_class === "string") bits.push(r.material_class);
	const lines = [`${bits.join(" · ")}（id ${r.id}）`];
	if (typeof r.download_url === "string" && r.download_url) lines.push(`   ${scope === "audio" ? "试听/下载" : "下载"}：${r.download_url}`);
	if (typeof r.accompaniment_url === "string" && r.accompaniment_url) lines.push(`   伴奏直链（off-vocal，song 类现成）：${r.accompaniment_url}`);
	if (Array.isArray(r.tags) && r.tags.length) lines.push(`   标签：${r.tags.slice(0, 8).join(" / ")}`);
	return lines;
}

/**
 * 通用素材检索：身份路由（复用 probeMemberType→decideRoute 同一判据）→ 请求构建 → 归一 → upsell 判定。
 * 与剪辑向 `matrix search` 两条线出参契约独立（下载向 vs segments），MUST NOT 互相影响。
 */
async function runMaterialMode(query: string, cfg: ReturnType<typeof loadConfig>, opts: MatrixOpts): Promise<MatrixMaterialResult> {
	// ① 参数（非法值参数错误拒绝，零网络零计费）
	const scope = parseMaterialScope(opts.scope);
	const topK = parseMaterialTopK(opts.topK);
	const bounds = parseMaterialDurationBounds(opts.minDuration, opts.maxDuration);

	// ② 身份探针（每次运行探一次，不缓存不降级——与剪辑向同一条获取路径）
	log.step("▶ 身份探针（matrix_member_type）…");
	const tier = await probeMemberType(cfg);
	const endpoint = materialEndpointFor(tier);
	log.info(
		`档位：${tier}（${tier === "internal" ? "矩阵成员口" : "通用口"} ${endpoint}）· 计费 ${MATERIAL_BILLING_NOTE[tier]}` +
			`${tier === "internal" ? "（搜全库，含非商用/概念素材）" : "（服务端固定只含可商用实拍素材）"}`,
	);

	// ③ 两档入参差异显式提示（公开口服务端入参白名单只有 scope/query/top_k/diversity，不静默忽略）
	if (opts.commercialOnly && tier === "external") {
		log.warn("--commercial-only 在公开口无区别：公开口本就只含可商用素材（服务端固定 is_copyright=true），该参数未随请求发出");
	}
	if (tier === "external" && (bounds.min !== undefined || bounds.max !== undefined)) {
		log.warn("公开口入参不含时长过滤（服务端只收 scope/query/top_k/diversity）——--min-duration/--max-duration 改由 CLI 按结果 duration 本地过滤后再出参");
	}

	const body = buildMaterialSearchBody(tier, {
		scope,
		query,
		topK,
		diversity: opts.diversity === true,
		commercialOnly: opts.commercialOnly === true,
		...(bounds.min !== undefined ? { minDuration: bounds.min } : {}),
		...(bounds.max !== undefined ? { maxDuration: bounds.max } : {}),
	});
	const range =
		bounds.min !== undefined || bounds.max !== undefined ? ` · 时长 ${bounds.min ?? 0}s–${bounds.max !== undefined ? `${bounds.max}s` : "不限"}` : "";
	log.step(`▶ 通用素材检索「${query}」（scope=${scope} · top_k=${topK}${range}${opts.commercialOnly ? " · 仅可商用" : ""}）…`);

	const data = await searchMaterialOnce(cfg, tier, body);
	// 公开口没有 filters 入参 → 本地按 duration 兜底过滤（已在上面显式提示，不静默）
	const durationFiltered = tier === "external" ? filterMaterialsByDuration(data.results, bounds) : data.results;
	// [adjust-bgm-selection-freshness] BGM 选曲新鲜度：scope=audio 时默认避让近期用过的曲子
	// （历史由 audio lay 落轨自动记账）。--no-exclude-recent 关闭；--exclude-recent <n> 调窗口。
	// 宁可少滤不可滤空：过滤后一条不剩则回退原结果并明示（曲库小/窗口过大时不让用户空手）。
	let results = durationFiltered;
	if (scope === "audio" && opts.excludeRecent !== false) {
		const n = typeof opts.excludeRecent === "string" ? Number(opts.excludeRecent) : EXCLUDE_RECENT_DEFAULT;
		const window = Number.isFinite(n) && n >= 0 ? n : EXCLUDE_RECENT_DEFAULT;
		const avoided = filterRecentlyUsed(durationFiltered, recentBgmKeys(window));
		results = avoided.kept;
		if (avoided.skipped > 0)
			log.info(`选曲新鲜度：已避让近期用过的 ${avoided.skipped} 首（窗口 ${window} 条；--no-exclude-recent 可关）`);
		if (avoided.exhausted)
			log.warn(`选曲新鲜度：本次候选全部是近期用过的曲子——已按原结果返回（避免空手）。建议换检索词或缩小窗口（--exclude-recent <n>）`);
	}
	log.ok(`${results.length} 条候选${typeof data.total === "number" && data.total !== results.length ? `（服务端返回 ${data.total}）` : ""}`);

	// ④ upsell（仅 external 档 且 结果不足；独立字段不进 results）
	const upsell = decideMaterialUpsell(tier, results.length, topK);

	const result: MatrixMaterialResult = {
		ok: true,
		mode: "material",
		memberType: tier,
		endpoint,
		scope,
		query,
		top_k: topK,
		billing: MATERIAL_BILLING_NOTE[tier],
		results,
		counts: { results: results.length },
		...(data.task_id ? { task_id: data.task_id } : {}),
		...(upsell ? { upsell } : {}),
	};

	if (opts.out) {
		const outPath = resolve(opts.out);
		await writeFile(
			outPath,
			JSON.stringify({ query, scope, top_k: topK, member_type: tier, results, ...(upsell ? { upsell } : {}) }, null, 2),
		);
		log.ok(`结果已落盘：${outPath}`);
		result.outPath = outPath;
	} else if (!opts.json) {
		for (const [i, r] of results.entries()) for (const line of materialLines(r, i, scope)) log.info(line);
	}
	// 人类可读一行（--json 下承载于独立顶层字段，不重复打扰 stdout）
	if (upsell) log.warn(upsell.message);
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
