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
import { readGtrk, assertGtrkV1, writeGtrkAtomic } from "../lib/gtrk-writeback";
import {
	BROLL_PREVIEW_DIR,
	layBrollTracks,
	mergedCandidates,
	previewUrlFor,
	type DownloadedProxy,
} from "../lib/matrix-lay";
import type { Dispatch, FilmDispatch } from "../lib/splitdoc";
import {
	buildPlan,
	buildPlanBeat,
	buildSearchBody,
	probeMemberType,
	searchOnce,
	type BrollPlan,
	type QueryOutcome,
	type Tier,
} from "../lib/matrix";
import type { PlanResult } from "../lib/matrix";
import { log, routeLogsToStderr } from "../lib/log";

interface MatrixOpts {
	project?: string;
	dispatch?: string;
	column?: string;
	topK?: string;
	materialClass?: string;
	lay?: string;
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
		.option("--lay <n>", "候选铺轨数：下载 preview 代理并在工程里铺 N 条 B-roll 候选轨（默认 1；0=只出 plan 不铺轨）", "1")
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
	log.info("清单只含引用不含素材：cover_url 可直接预览；url 带签名默认 24h 过期，过期重跑本命令即重签。");

	// ⑤ 候选铺轨（add-matrix-lay-tracks）：下载 preview 代理落地 → 幂等替换自产轨 → 原子写回。
	//    工程缺失/非 v1 = 告警跳过（plan 已产，铺轨是增值不是门槛）。
	const layN = parseLay(opts.lay);
	let laySummary: Record<string, unknown> | undefined;
	if (layN > 0) {
		laySummary = await layIntoProject(baseDir, plan, layN);
	}

	const result: MatrixResult = {
		ok: true,
		mode: "plan",
		memberType: tier,
		...(columnId ? { columnId } : {}),
		planPath,
		...(laySummary ? { lay: laySummary } : {}),
		counts: { beats: beats.length, queries: totalQueries, results: resultCount, errors: errCount },
	};
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

/** 定位工程文件（沿 split 候选链）。 */
function locateGtrk(baseDir: string): string | undefined {
	const cands = [join(baseDir, "gtrk", "project.gtrk"), join(baseDir, "project.gtrk")];
	return cands.find((p) => existsSync(p));
}

/**
 * 候选铺轨：对每个 beat 的 top-N 候选下载代理（preview 优先 → 推导 → 404 回落 raw）→ layBrollTracks → 原子写回。
 * 任何整体性失败（工程缺失/非 v1/mtime 冲突）都不影响已产出的 plan。
 */
async function layIntoProject(baseDir: string, plan: BrollPlan, layN: number): Promise<Record<string, unknown> | undefined> {
	const gtrkPath = locateGtrk(baseDir);
	if (!gtrkPath) {
		log.warn(`未找到工程文件（${join(baseDir, "gtrk", "project.gtrk")}），跳过铺轨——plan 已产出，可后续在有工程的目录重跑`);
		return undefined;
	}
	const { gtrk, mtimeMs } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);

	log.step(`▶ 候选铺轨（${layN} 轨，preview 代理）…`);
	const gtrkDir = dirname(gtrkPath);
	const previewDir = join(gtrkDir, ...BROLL_PREVIEW_DIR.split("/"));
	await mkdir(previewDir, { recursive: true });

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

	// 下载 laid 候选的代理（每 beat top-N；按 clip_id 幂等复用）
	const downloads = new Map<string, DownloadedProxy>();
	const dlStats = { preview: 0, raw: 0, reused: 0, failed: 0 };
	for (const beat of plan.beats) {
		for (const cand of mergedCandidates(beat).slice(0, layN)) {
			if (downloads.has(cand.clip_id)) continue;
			const rel = `${BROLL_PREVIEW_DIR}/${cand.clip_id}.mp4`;
			const abs = join(gtrkDir, ...rel.split("/"));
			if (existsSync(abs)) {
				const prev = prevSource.get(cand.clip_id);
				if (prev !== "raw") {
					downloads.set(cand.clip_id, { rel, source: prev ?? "preview" });
					dlStats.reused++;
					continue;
				}
				// 上次是 raw 回落:重试 preview(backfill 可能已补产),成功即覆盖换代理;失败沿用本地 raw
				const retried = await downloadProxy(cand, abs, { previewOnly: true });
				if (retried === "preview") {
					downloads.set(cand.clip_id, { rel, source: "preview" });
					dlStats.preview++;
					log.info(`clip ${cand.clip_id} 代理已补产,已从原片回落态换回 preview`);
				} else {
					downloads.set(cand.clip_id, { rel, source: "raw" });
					dlStats.reused++;
				}
				continue;
			}
			const got = await downloadProxy(cand, abs);
			if (got) {
				downloads.set(cand.clip_id, { rel, source: got });
				dlStats[got]++;
			} else {
				dlStats.failed++;
			}
		}
	}

	const { next, summary } = layBrollTracks({
		gtrk,
		plan,
		lay: layN,
		downloads,
		generatedAt: new Date().toISOString(),
		planPath: "split/broll-plan.json",
	});
	writeGtrkAtomic(gtrkPath, next, mtimeMs);
	log.ok(
		`铺轨完成：${summary.laidTracks.length} 条候选轨（track_index ${summary.laidTracks.join("/") || "-"}）· ${summary.laidClips} 个候选颗粒` +
			`（代理 ${dlStats.preview} · 原片回落 ${dlStats.raw} · 复用 ${dlStats.reused}${dlStats.failed ? ` · 失败 ${dlStats.failed}` : ""}）`,
	);
	log.info("opencut 打开工程即见候选轨：轨道头小眼睛可开关对比；确认下载原片属挑选 UI（E-P1）。");
	if (dlStats.raw > 0) {
		log.warn("部分候选无 preview 代理已回落原片（体积较大）——服务端 backfill 后重跑本命令可换回代理。");
	}
	return { laidTracks: summary.laidTracks, laidClips: summary.laidClips, downloads: dlStats };
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
	const raw = await tryFetch(cand.url);
	if (raw) {
		await writeFile(absPath, raw);
		log.warn(`clip ${cand.clip_id} 无 preview 代理，已回落原片（${(raw.length / 1048576).toFixed(1)}MB）`);
		return "raw";
	}
	log.warn(`clip ${cand.clip_id} 代理与原片均下载失败，该候选槽位跳过`);
	return null;
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
