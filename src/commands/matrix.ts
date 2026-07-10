/**
 * gtrk matrix —— B-roll 双口检索（Wave2 Change C）。
 *
 * 双模式（沿 split 的「顶层命令 + 可选 positional」范式，避免父子命令吞选项）：
 *   - `gtrk matrix --project <dir>`      派单消费：读 split/dispatch.json 的 film_broll 队列 → split/broll-plan.json
 *   - `gtrk matrix search "<query>"`     ad-hoc 通用检索：同路由同注入，--out 落文件 / 缺省 stdout
 *
 * 身份路由每次运行探一次（不缓存不降级）；栏目配置（--column / defaultColumn）只在 internal 口注入；
 * v1 只出候选清单不下载（cover_url 预览，url 24h 过期重跑重签）；单 query 失败局部化。
 */
import type { Command } from "commander";
import { resolve, join, dirname, basename } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadConfig } from "../lib/config";
import { readUserConfig } from "../lib/user-config";
import { resolveColumnConfig } from "../lib/column-config";
import type { Dispatch, FilmDispatch } from "../lib/splitdoc";
import {
	buildPlan,
	buildPlanBeat,
	buildSearchBody,
	probeMemberType,
	searchOnce,
	type BrollPlan,
	type PlanResult,
	type QueryOutcome,
	type Tier,
} from "../lib/matrix";
import { log, routeLogsToStderr } from "../lib/log";

interface MatrixOpts {
	project?: string;
	dispatch?: string;
	column?: string;
	topK?: string;
	materialClass?: string;
	out?: string;
	json?: boolean;
}

export function registerMatrix(program: Command): void {
	program
		.command("matrix [words...]")
		.description(
			"B-roll 检索：无 positional=消费 split/dispatch.json 的 film_broll 队列产候选清单；`matrix search \"<query>\"`=单条 ad-hoc 检索",
		)
		.option("--project <dir>", "oralcut 产物目录（定位 split/dispatch.json 与产物落点）")
		.option("--dispatch <path>", "显式指定 dispatch.json（非标准布局兜底）")
		.option("--column <id>", "栏目配置 id（缺省取 config defaultColumn，再缺省内置默认栏目）")
		.option("--top-k <n>", "每 query 候选数上限（覆盖派单 shots 翻译；服务端上限 50）")
		.option("--material-class <c>", "素材类型 real_shot|concept（仅矩阵成员口；覆盖栏目 material_class_policy）")
		.option("--out <file>", "ad-hoc 模式：结果落文件（缺省输出 stdout）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[] | undefined, opts: MatrixOpts) => {
			await runMatrix(parseAdhocQuery(words), opts);
		});
}

/** positional 解析：空 = 派单消费模式；`search <query…>` = ad-hoc；其他开头 = 报错给正确用法。 */
export function parseAdhocQuery(words: string[] | undefined): string | undefined {
	if (!words || words.length === 0) return undefined;
	if (words[0] !== "search") {
		throw new Error(`未知子命令「${words[0]}」——ad-hoc 检索用法：gtrk matrix search "<query>"；派单消费用法：gtrk matrix --project <dir>`);
	}
	const query = words.slice(1).join(" ").trim();
	if (!query) throw new Error('检索词不能为空：gtrk matrix search "<query>"');
	return query;
}

export interface MatrixResult {
	ok: boolean;
	mode: "plan" | "search";
	memberType: Tier;
	columnId?: string;
	planPath?: string;
	results?: PlanResult[];
	counts: { beats: number; queries: number; results: number; errors: number };
	[k: string]: unknown;
}

export async function runMatrix(searchQuery: string | undefined, opts: MatrixOpts): Promise<MatrixResult> {
	if (opts.json) routeLogsToStderr();
	const cfg = loadConfig();

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

	return searchQuery !== undefined
		? runAdhoc(searchQuery, cfg, tier, brollForTier, overrides, effectiveColumnId, opts)
		: runPlanMode(cfg, tier, brollForTier, overrides, effectiveColumnId, opts);
}

/** 派单消费模式：dispatch.film_broll → split/broll-plan.json。 */
async function runPlanMode(
	cfg: ReturnType<typeof loadConfig>,
	tier: Tier,
	broll: Parameters<typeof buildSearchBody>[3],
	overrides: { topK?: number; materialClass?: string },
	columnId: string | undefined,
	opts: MatrixOpts,
): Promise<MatrixResult> {
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
	const queue: FilmDispatch[] = Array.isArray(dispatch.film_broll) ? dispatch.film_broll : [];
	log.step(`▶ B-roll 检索：${queue.length} 个 beat（${tier} 口）…`);

	const beats = [];
	let okCount = 0;
	let errCount = 0;
	let resultCount = 0;
	for (const entry of queue) {
		const outcomes: QueryOutcome[] = [];
		for (const q of entry.queries) {
			try {
				const body = buildSearchBody(tier, q, entry, broll, overrides);
				const data = await searchOnce(cfg, tier, body);
				outcomes.push({ query: q, data });
				okCount++;
				resultCount += data.results?.length ?? 0;
				log.info(`${entry.beat}「${q}」→ ${data.results?.length ?? 0} 条候选（召回 ${data.recalled ?? "?"}）`);
			} catch (e) {
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
	if (queue.length === 0) log.warn("无 B-roll 派单（film_broll 队列为空）——照常写出空 plan");
	if (totalQueries > 0 && okCount === 0) {
		throw new Error(`全部 ${totalQueries} 个 query 检索失败，未写入 plan（逐条原因见上方日志）`);
	}

	const projectSlug = slugify(basename(baseDir));
	const plan = buildPlan({
		generatedAt: new Date().toISOString(),
		memberType: tier,
		projectSlug,
		columnId,
		beats,
	});
	const splitDir = join(baseDir, "split");
	await mkdir(splitDir, { recursive: true });
	const planPath = join(splitDir, "broll-plan.json");
	await writeFile(planPath, JSON.stringify(plan, null, 2));
	log.ok(`候选清单已生成：${planPath}（${beats.length} beat · ${okCount}/${totalQueries} query 成功 · ${resultCount} 条候选）`);
	log.info("v1 只出清单不下载：cover_url 可直接预览；url 带签名默认 24h 过期，过期重跑本命令即重签。");

	const result: MatrixResult = {
		ok: true,
		mode: "plan",
		memberType: tier,
		...(columnId ? { columnId } : {}),
		planPath,
		counts: { beats: beats.length, queries: totalQueries, results: resultCount, errors: errCount },
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

/** ad-hoc 模式：单 query，--out 落文件 / 缺省 stdout。 */
async function runAdhoc(
	query: string,
	cfg: ReturnType<typeof loadConfig>,
	tier: Tier,
	broll: Parameters<typeof buildSearchBody>[3],
	overrides: { topK?: number; materialClass?: string },
	columnId: string | undefined,
	opts: MatrixOpts,
): Promise<MatrixResult> {
	log.step(`▶ ad-hoc 检索「${query}」（${tier} 口）…`);
	const body = buildSearchBody(tier, query, undefined, broll, overrides);
	const data = await searchOnce(cfg, tier, body);
	const results = data.results ?? [];
	log.ok(`${results.length} 条候选（召回 ${data.recalled ?? "?"}）`);

	const result: MatrixResult = {
		ok: true,
		mode: "search",
		memberType: tier,
		...(columnId ? { columnId } : {}),
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
			log.info(`clip ${r.clip_id} · score ${r.score}${seg ? ` · 最佳段 ${seg.start}s–${seg.end}s（锚点 ${seg.best}s）` : ""}${r.note ? ` · ${String(r.note).slice(0, 40)}` : ""}`);
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
