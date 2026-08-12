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
import { loadConfig } from "../lib/config";
import { readUserConfig } from "../lib/user-config";
import { resolveColumnConfig } from "../lib/column-config";
import { readGtrk, assertGtrkV1, writeGtrkAtomic } from "../lib/gtrk-writeback";
import {
	BROLL_COVER_DIR,
	BROLL_META_CANDIDATE_CAP,
	BROLL_PREVIEW_DIR,
	SCORE_FLOOR_DEFAULT,
	brollMaterialIdFor,
	layBrollTracks,
	mergedCandidates,
	planBeatFills,
	previewUrlFor,
	type DownloadedProxy,
} from "../lib/matrix-lay";
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
	buildPlan,
	buildPlanBeat,
	buildSearchBody,
	isLocalPlanResult,
	probeGcMemberType,
	probeMemberType,
	searchOnce,
	type BrollPlan,
	type QueryOutcome,
	type SearchRespData,
	type Tier,
} from "../lib/matrix";
import type { PlanResult } from "../lib/matrix";
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
	extractFrameJpg,
	indexLocalMaterials,
	localIndexDbPath,
	openLocalIndexDb,
	type IndexRunResult,
	type IndexSessionHooks,
} from "../lib/local-index";
import { loadLocalIndex, searchLoadedIndex, type LoadedIndex } from "../lib/local-search";
import { resolveFfmpeg } from "../lib/ffmpeg";
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
	/** `--rebuild`：matrix index 忽略指纹强制全量重建。 */
	rebuild?: boolean;
}

export function registerMatrix(program: Command): void {
	program
		.command("matrix [words...]")
		.description(
			"B-roll 检索：无 positional=消费 split/dispatch.json 的 film_broll 队列产候选清单；`matrix search \"<query>\"`=单条 ad-hoc 检索；`matrix index --dirs <a,b>`=本地素材索引",
		)
		.option("--project <dir>", "oralcut 产物目录（定位 split/dispatch.json 与产物落点）")
		.option("--dispatch <path>", "显式指定 dispatch.json（非标准布局兜底）")
		.option("--column <id>", "栏目配置 id（缺省取 config defaultColumn，再缺省内置默认栏目；仅云端模式）")
		.option("--top-k <n>", "每 query 候选数上限（覆盖派单 shots 翻译；云端服务端上限 50）")
		.option("--material-class <c>", "素材类型 real_shot|concept（仅矩阵成员口；覆盖栏目 material_class_policy）")
		.option("--local", "本地检索模式：走本地素材索引检索（须配 --dirs；跳过身份探针，不触任何云端检索端点）")
		.option("--dirs <a,b,...>", "本地素材文件夹（逗号分隔）——matrix index 的索引范围 / --local 的检索域")
		.option("--scene-threshold <f>", "matrix index：场景切换检测阈值（ffmpeg select gt(scene,X)，默认 0.3）")
		.option("--rebuild", "matrix index：忽略 size:mtime 指纹，强制全量重建索引")
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

/** positional 解析结果：plan（派单消费）/ search（ad-hoc）/ index（本地索引）。 */
export type MatrixPositional = { kind: "plan" } | { kind: "search"; query: string } | { kind: "index" };

/** positional 解析：空 = 派单消费；`search <query…>`；`index`；其他开头 = 报错给正确用法。 */
export function parseMatrixPositional(words: string[] | undefined): MatrixPositional {
	if (!words || words.length === 0) return { kind: "plan" };
	if (words[0] === "index") {
		if (words.length > 1) throw new Error(`matrix index 不接受多余参数「${words.slice(1).join(" ")}」——用法：gtrk matrix index --dirs <a,b,...>`);
		return { kind: "index" };
	}
	if (words[0] !== "search") {
		throw new Error(
			`未知子命令「${words[0]}」——ad-hoc 检索：gtrk matrix search "<query>"；派单消费：gtrk matrix --project <dir>；本地索引：gtrk matrix index --dirs <a,b,...>`,
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
 * 三路参数互斥校验（spec「互斥参数」：参数错误退出并明示原因，不做静默忽略）。
 *   - index / --local 必带 --dirs；
 *   - --local 与仅云端语义参数（--column / --material-class）互斥；
 *   - 云端模式反向拒绝本地专属参数（--dirs / --scene-threshold / --rebuild）。
 */
export function assertModeOptions(pos: MatrixPositional, opts: MatrixOpts): void {
	const dirs = parseDirsOption(opts.dirs);
	if (pos.kind === "index") {
		if (!dirs.length) throw new Error("matrix index 需要 --dirs <a,b,...> 指定素材文件夹（索引范围永远显式可见）");
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
	if (opts.rebuild) throw new Error("--rebuild 仅用于 matrix index（不做静默忽略）");
}

export interface MatrixResult {
	ok: boolean;
	mode: "plan" | "search";
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
	scenes: number;
	frames: number;
	billing: MatrixIndexBilling;
	elapsedSec: number;
	[k: string]: unknown;
}

/** 检索上下文：plan/adhoc 两模式共用的「一 query 一答」抽象（云端=双口 HTTP；本地=索引点积）。 */
interface SearchCtx {
	memberType: Tier | "local";
	columnId?: string;
	search: (query: string, entry?: FilmDispatch) => Promise<SearchRespData>;
}

export async function runMatrix(pos: MatrixPositional, opts: MatrixOpts): Promise<MatrixResult | MatrixIndexResult> {
	if (opts.json) routeLogsToStderr();
	assertModeOptions(pos, opts);
	const cfg = loadConfig();

	// ── 本地索引模式（matrix index）──
	if (pos.kind === "index") return withEmbedJsonGuard("index", opts, () => runIndexMode(cfg, opts));

	// ── 本地检索模式（--local）：跳过身份探针，不触任何云端检索端点 ──
	if (opts.local) {
		return withEmbedJsonGuard(pos.kind, opts, async () => {
			const ctx = await buildLocalSearchCtx(cfg, opts);
			return pos.kind === "search" ? runAdhoc(pos.query, ctx, opts) : runPlanMode(ctx, opts);
		});
	}

	// ── 云端双口（行为与 add-matrix-local-search 之前逐字节一致）──
	// ① 身份探针（每次运行探一次，不缓存；探针失败=整体失败）
	log.step("▶ 身份探针（matrix_member_type）…");
	const tier = await probeMemberType(cfg);
	log.info(`档位：${tier}${tier === "internal" ? "（矩阵成员口 /task/custom/search）" : "（通用口 /task/video_clip_search）"}`);

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
	const ctx: SearchCtx = {
		memberType: tier,
		columnId: effectiveColumnId,
		search: (q, entry) => searchOnce(cfg, tier, buildSearchBody(tier, q, entry, brollForTier, overrides)),
	};
	return pos.kind === "search" ? runAdhoc(pos.query, ctx, opts) : runPlanMode(ctx, opts);
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
	const endpoint = embedEndpointFor(cfg);
	log.step(`▶ 本地素材索引：${dirs.join("、")}（场景阈值 ${threshold}${opts.rebuild ? " · 强制全量重建" : ""}）…`);
	log.info("免切片：只记场景时间戳，不产生任何切片文件；抽帧图 embed 后即删（素材本体不上云）。");
	// 同合云内部成员（gc_member_type=internal）豁免：无 token 也放行图像且零计费 → 直接不开会话
	const exempt = await probeIndexBillingExempt(cfg);
	if (exempt) log.info("同合云内部成员（gc_member_type=internal）：图像 embed 计费豁免（免会话零积分；文本 embed 本就免费）。");
	const run = await indexLocalMaterials({
		dirs,
		sceneThreshold: threshold,
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
	log.ok(
		`索引完成：${m.indexed}/${m.total} 个素材（跳过 ${m.skipped} · 重建 ${m.rebuilt}${m.failed ? ` · 失败 ${m.failed}` : ""}）· ` +
			`场景 ${run.scenes} · 帧 ${run.frames} · 耗时 ${(run.elapsedMs / 1000).toFixed(1)}s${billNote}`,
	);
	log.info(`索引落点：${run.dbPath}（绝对路径为键，跨机不可移植；属本机缓存，可随时重建）`);
	const result: MatrixIndexResult = {
		ok: true,
		mode: "index",
		dirs: run.dirs,
		dbPath: run.dbPath,
		materials: run.materials,
		scenes: run.scenes,
		frames: run.frames,
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
	const qvecCache = new Map<string, Float32Array>();
	return {
		memberType: "local",
		search: async (query) => {
			let vec = qvecCache.get(query);
			if (!vec) {
				[vec] = await embedInputs(endpoint, [{ text: query }]); // 除此一请求外零网络
				qvecCache.set(query, vec!);
			}
			const { recalled, results } = searchLoadedIndex(index, vec!, { scoreFloor: floor });
			return { recalled, results: topK && topK > 0 ? results.slice(0, topK) : results };
		},
	};
}

/** 派单消费模式：dispatch.film_broll → split/broll-plan.json。 */
async function runPlanMode(ctx: SearchCtx, opts: MatrixOpts): Promise<MatrixResult> {
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
		for (const q of entry.queries) {
			try {
				const data = await ctx.search(q, entry);
				outcomes.push({ query: q, data });
				okCount++;
				resultCount += data.results?.length ?? 0;
				log.info(`${entry.beat}「${q}」→ ${data.results?.length ?? 0} 条候选（召回 ${data.recalled ?? "?"}）`);
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
		beats.push(buildPlanBeat(entry, outcomes));
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
		);
	}
	const laySummary = laid?.lay;

	// ②-B 拒铺（fix-matrix-strip-identity）：候选轨已被用户编辑 → 工程零改动。
	// 退出码口径已拍板取**非 0**（`ok:false` 一律连带非 0 退出码，与 `gtrk mg` 的 done() 同调）——
	// 本 CLI 的主要消费者是 agent，「ok:false + 退出码 0」是静默错判的源头。plan 仍已产出、可复用。
	const refused = laySummary?.refused === true ? (laySummary.keptEditedTracks as number[]) : undefined;
	const result: MatrixResult = {
		ok: refused === undefined,
		mode: "plan",
		memberType: ctx.memberType,
		...(ctx.columnId ? { columnId: ctx.columnId } : {}),
		planPath,
		...(refused ? { refused, reason: "tracks_edited", planReusable: true } : {}),
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

/** 铺轨返回：`lay` = 既有铺轨摘要（进 `--json` 的 `lay`）；`integrity` 仅在真写回过时才有。 */
interface LayOutcome {
	lay: Record<string, unknown>;
	integrity?: IntegrityReport;
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
): Promise<LayOutcome | undefined> {
	const gtrkPath = locateGtrk(baseDir);
	if (!gtrkPath) {
		log.warn(`未找到工程文件（${join(baseDir, "gtrk", "project.gtrk")}），跳过铺轨——plan 已产出，可后续在有工程的目录重跑`);
		return undefined;
	}
	const { gtrk, mtimeMs } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);

	// 先定「填哪些颗粒」（纯逻辑），下载集 = 全部槽位 clip 去重
	const { fills, clipIds } = planBeatFills(plan, layN, scoreFloor);
	const slotCount = [...fills.values()].flat().reduce((n, s) => n + s.length, 0);
	log.step(`▶ 候选铺轨（${layN} 轨 · 平铺 ${slotCount} 槽位 · ${clipIds.size} 个 clip）…`);
	const gtrkDir = dirname(gtrkPath);
	const previewDir = join(gtrkDir, ...BROLL_PREVIEW_DIR.split("/"));
	await mkdir(previewDir, { recursive: true });

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
	const candById = new Map<string, PlanResult>();
	for (const beat of plan.beats) for (const c of mergedCandidates(beat)) if (!candById.has(c.clip_id)) candById.set(c.clip_id, c);
	const downloads = new Map<string, DownloadedProxy>();
	const dlStats = { preview: 0, raw: 0, reused: 0, failed: 0, local: 0 };
	for (const clipId of clipIds) {
		const cand = candById.get(clipId);
		if (!cand) continue;
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
		generatedAt: new Date().toISOString(),
		planPath: "split/broll-plan.json",
		blackBed,
		forceRelay,
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
		};
	}

	// 黑底 PNG 落盘：客户端能凭 id 现画重建，但剪映导出/云渲/第三方读的是盘上的文件，故必须真写字节。
	// 落盘失败 → 撤掉黑轨重铺（宁可无黑底，也不留「.gtrk 说有、盘上没有」）。
	if (summary.blackTrack !== null) {
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
			log.warn(`纯黑底 PNG 落盘失败（${rel}）：${(e as Error).message} —— 本次不铺黑底垫轨，候选轨照常。`);
			({ next, summary, warnings } = layBrollTracks({
				gtrk,
				plan,
				lay: layN,
				fills,
				downloads,
				covers,
				generatedAt: new Date().toISOString(),
				planPath: "split/broll-plan.json",
				blackBed: false,
				// 重跑必须原样带上 forceRelay：漏传会让「已授权强剥」的这次退回拒铺态（半截行为）
				forceRelay,
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
	log.ok(
		`铺轨完成：${stripNote}${summary.laidTracks.length} 条候选轨（track_index ${summary.laidTracks.join("/") || "-"}）· 平铺 ${summary.laidClips} 个颗粒 / ${clipIds.size} 个 clip` +
			`（代理 ${dlStats.preview} · 原片回落 ${dlStats.raw} · 复用 ${dlStats.reused}${dlStats.local ? ` · 本地直引 ${dlStats.local}` : ""}${dlStats.failed ? ` · 失败 ${dlStats.failed}` : ""}）${bedNote}${keptNote}`,
	);
	log.info("opencut 打开工程即见候选轨：轨道头小眼睛可开关对比；确认下载原片属挑选 UI（E-P1）。");
	for (const w of warnings) log.warn(w);
	if (dlStats.raw > 0) {
		log.warn("部分候选无 preview 代理已回落原片（体积较大）——服务端 backfill 后重跑本命令可换回代理。");
	}
	if (integrity) reportMaterialIntegrity(integrity, log);
	return {
		lay: {
			refused: false,
			laidTracks: summary.laidTracks,
			laidClips: summary.laidClips,
			removedTracks: summary.removedTracks,
			keptEditedTracks: summary.keptEditedTracks,
			blackTrack: summary.blackTrack,
			// 空洞是「告知」不是「阻断」：人读走上面的 warnings 通道单独成行，机读全量出这两个字段，
			// agent 无需真机看片即可回报哪几段是纯黑（MUST NOT 按告警阈值过滤）。
			blackBedHoleSec: summary.blackBedHoleSec,
			blackBedHoles: summary.blackBedHoles,
			downloads: dlStats,
		},
		...(integrity ? { integrity } : {}),
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
