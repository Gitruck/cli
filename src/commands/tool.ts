/**
 * gtrk tool —— 单点工具族命令（add-tool-command-family D1）。
 *
 * 命令形态铁律（oralcut-result D2 教训、split.ts 头注释）：顶层命令 + 首个 positional 词内部分派，
 * **不用 commander 父子命令**（防吞选项）。`gtrk tool <name> [input]` 分派到注册表 descriptor 跑共享 runner；
 * `gtrk tool list` 为发现子模式（人读表格 + --json 机读，无 Key 也能匿名查实时价格）。
 *
 * 各 descriptor 的工具专属 options 在注册时统一挂 commander（去重按 flag）。
 * gated 工具（enabled=false）直调即报错「能力未开放」+ disabledReason、进程非 0、零上传零提交。
 */
import type { Command } from "commander";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../lib/config";
import { submitTask, getTaskResult } from "../lib/cloud";
import { uploadCached, invalidateUpload } from "../lib/upload-cache";
import { probeDuration } from "../lib/media";
import { log, routeLogsToStderr } from "../lib/log";
import {
	TOOL_REGISTRY,
	MULTI_INPUT_KINDS,
	defaultExtsFor,
	findTool,
	validateRegistry,
	type ToolDescriptor,
} from "../lib/tool-descriptors";
import { runCloudTool, downloadStream, resolveOutDir, type RunToolResult, type CloudToolDeps } from "../lib/tool-runner";
import {
	DEFAULT_JOBS_CLOUD,
	DEFAULT_JOBS_LOCAL,
	batchBilling,
	clampJobs,
	defaultJobsFor,
	manifestLine,
	planBatch,
	runPool,
	summarize,
} from "../lib/tool-batch";
import { runMad, runMadSearch, type MadOpts } from "../lib/mad/mad";
import { currentVersion } from "../lib/version";
import { isTaskTypeOffline, primeCatalog } from "../lib/enum-catalog";
import {
	fetchToolPrices,
	resolveToolPricing,
	resolveToolPricingFromMap,
	type ToolPriceMap,
} from "../lib/tool-pricing";

interface ToolOpts {
	out?: string;
	param?: string[];
	paramsJson?: string;
	ffmpegPath?: string;
	reupload?: boolean;
	json?: boolean;
	[k: string]: unknown;
}

/** --param 收集器（重复出现即累积）。 */
const collectParam = (v: string, acc: string[]): string[] => {
	acc.push(v);
	return acc;
};

/** 给 tool 顶层命令挂通用选项 + 各 descriptor 的工具专属选项（去重），并接上 action。导出供测试。 */
export function configureToolCommand(cmd: Command, registry: ToolDescriptor[] = TOOL_REGISTRY): Command {
	cmd
		.description("单点工具族：`gtrk tool <name> [输入...]` 跑单个能力（多文件工具可传多个输入，顺序即拼装顺序）；`gtrk tool list` 查全部（含输入/产物/计费/状态）")
		.option(
			"-o, --out <dir>",
			"产物目录（缺省 = <输入名>-<tool>/；input=none 落 cwd 下 <tool>-<时间戳>/，该名撞上时自动带 -2/-3 序号后缀，最终落点以回执 outDir 为准）",
		)
		.option("--param <k=v>", "透传任意云端参数（标量、可重复；如 --param width=1080）", collectParam, [])
		.option("--params-json <json>", "透传任意云端参数（JSON 对象）")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录（缺省 ~/.gitruck/ffmpeg → 系统 PATH）")
		.option("--reupload", "强制重新上传，忽略本地上传缓存")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON（给 agent/脚本解析）")
		// 批次外壳（add-tool-batch-runner）：**缺席时单次路径一字不变**
		.option("--batch <dir|清单>", "批量跑：目录（按本工具的输入类别认扩展名）/ .txt 一行一路径 / .json 字符串数组")
		.option("--jobs <n>", `[batch] 并发数（云端缺省 ${DEFAULT_JOBS_CLOUD}，本地引擎类缺省 ${DEFAULT_JOBS_LOCAL}）`)
		.option("--skip-existing", "[batch] 已有产物的条目直接跳过（断点续跑，不重复计费）")
		.option("--manifest <out.jsonl>", "[batch] 逐条落 jsonl：输入、产物、耗时、结果、失败原因")
		.option("--dry-run", "[batch] 只列清单，零提交零计费")
		.option("--yes", "[batch] 跳过计费确认");
	// 各 descriptor 的工具专属选项统一挂上（去重按 flag，防同名重复注册报错）
	const seen = new Set<string>();
	for (const d of registry) {
		for (const o of d.options ?? []) {
			if (seen.has(o.flag)) continue;
			seen.add(o.flag);
			if (o.repeatable) cmd.option(o.flag, o.desc, collectParam, []);
			else cmd.option(o.flag, o.desc);
		}
		// 附加输入文件的 flag（link-video-translate-dub-cli D3）：同一命名空间、同一去重规则
		for (const x of d.extraInputs ?? []) {
			if (seen.has(x.flag)) continue;
			seen.add(x.flag);
			cmd.option(x.flag, x.desc);
		}
	}
	cmd.action(async (words: string[] | undefined, opts: ToolOpts) => {
		await runToolCommand(words ?? [], opts, registry);
	});
	return cmd;
}

export function registerTool(program: Command, registry: ToolDescriptor[] = TOOL_REGISTRY): void {
	validateRegistry(registry); // 启动即校验：坏注册表 fail-fast（发版门）
	const cmd = program.command("tool [words...]");
	configureToolCommand(cmd, registry);
}

/** 命令分派（导出供测试直调）：`list` → 发现；`<name> [input]` → 跑工具；空/未知 → 报错。 */
export async function runToolCommand(
	words: string[],
	opts: ToolOpts,
	registry: ToolDescriptor[] = TOOL_REGISTRY,
	deps?: Partial<CloudToolDeps>,
): Promise<RunToolResult | undefined> {
	if (opts.json) routeLogsToStderr();
	const name = words[0];
	if (!name) {
		throw new Error("用法：`gtrk tool <name> [输入...]` 跑工具（多文件工具可传多个输入）；`gtrk tool list` 查全部工具");
	}
	if (name === "list") {
		await runList(opts, registry);
		return undefined;
	}
	const descriptor = findTool(name, registry);
	if (!descriptor) {
		const names = registry.map((d) => d.name).join(", ");
		throw new Error(`未知工具「${name}」。可用工具：${names || "（空）"}（用 gtrk tool list 查看详情）`);
	}
	// 批次外壳（add-tool-batch-runner）：`--batch` **在这里分岔**，下面单次路径一字未动。
	// ⚠️ 多文件类别（images/videos）的单次调用本身就吃多个输入，「一条输入 = 一次调用」
	//    这个前提不成立，故不支持批次——报清楚比按「每个文件跑一次」猜一个语义强。
	const bOpts = opts as ToolBatchOpts;
	if (bOpts.batch) {
		if (MULTI_INPUT_KINDS.has(descriptor.input.kind)) {
			throw new Error(
				`「${descriptor.name}」的输入是 ${descriptor.input.kind}（一次调用吃多个文件），` +
					"「一条输入 = 一次调用」不成立，故不支持 --batch。要批量请自己分组后多次调用。",
			);
		}
		if (descriptor.input.kind === "none") {
			throw new Error(`「${descriptor.name}」不吃输入文件，没有可批的东西。`);
		}
		await runToolBatch(descriptor, bOpts, deps);
		return undefined;
	}
	const inputArg = MULTI_INPUT_KINDS.has(descriptor.input.kind) ? words.slice(1) : words[1];
	return runTool(descriptor, inputArg, opts, deps);
}

/** list 发现子模式：无 Key可用；每次最多匿名查一次实时价格，失败仍列完整清单。 */
export async function runList(
	opts: ToolOpts,
	registry: ToolDescriptor[] = TOOL_REGISTRY,
	loadPrices: () => Promise<ToolPriceMap> = fetchToolPrices,
): Promise<void> {
	let prices: ToolPriceMap | undefined;
	try {
		prices = await loadPrices();
	} catch {
		prices = undefined;
	}
	// 枚举清单（link-enum-catalog-cli §2.4）：把服务端的**临时下架**状态叠上来。
	// ⚠️ 只降不升——清单说下架就标暂停；清单没说、或压根没清单，一律沿用 descriptor.enabled。
	// list 本来就是联网子模式（上面刚查过实时价格），这里顺带刷清单不新增往返性质。
	await primeCatalog();
	const rows = registry.map((d) => {
		const resolved = resolveToolPricingFromMap(d.priceKey ?? d.name, prices, d.pricingContext);
		const offline = !!d.taskType && isTaskTypeOffline(d.taskType);
		return {
		name: d.name,
		title: d.title,
		input: d.input.kind,
		output: d.outputHint,
		billingHint: resolved.billingHint,
		pricing: resolved.pricing,
		enabled: d.enabled && !offline,
		...(offline ? { offline: true as const } : {}),
		...(offline
			? { disabledReason: "服务端已临时下架（枚举清单 task_availability.offline）" }
			: d.disabledReason
				? { disabledReason: d.disabledReason }
				: {}),
		};
	});
	if (opts.json) {
		console.log(JSON.stringify(rows));
		return;
	}
	log.step("▶ gtrk 工具族（gtrk tool <name> [input]）：");
	for (const r of rows) {
		const status = r.enabled
			? "已上线"
			: "offline" in r && r.offline
				? "暂停服务（服务端下架）"
				: `未开放（${r.disabledReason ?? "无原因"}）`;
		log.info(`${r.name} — ${r.title}｜输入 ${r.input}｜产物 ${r.output}｜${r.billingHint}｜${status}`);
	}
	log.info("agent 一律带 --json；缺 API Key 先跑 `gtrk init`；跑前把计费提示转述给用户。");
}

/** 分派到单个工具执行。 */
async function runTool(
	descriptor: ToolDescriptor,
	inputArg: string | string[] | undefined,
	opts: ToolOpts,
	depsOverride?: Partial<CloudToolDeps>,
): Promise<RunToolResult> {
	// gated 门：直调即报错，零上传零提交零网络（先于 loadConfig）
	if (!descriptor.enabled) {
		throw new Error(`能力未开放：${descriptor.disabledReason ?? "（未提供原因）"}（用 gtrk tool list 查看全部工具）`);
	}
	// 枚举清单预热（link-enum-catalog-cli §1.2 / §2.4）：**只对云端工具**做，本地工具零网络。
	// 预热之后：① 下面的下架门读到的是本次结果而非陈旧快照；
	//           ② buildPayload（同步函数，没法 await）里的 assertEnum 读进程内缓存。
	// 拉不到不阻断——getCatalog 任何分支都不抛，拿不到就放行交服务端裁决。
	if (descriptor.kind !== "local") await primeCatalog();
	// 服务端临时下架门（link-enum-catalog-cli §2.4）：**上传之前**拒，并给出服务端侧的理由。
	// ⚠️ 与上面那道 `enabled` 门是两件事：那道是「本版 CLI 认不认识」，这道是「服务端此刻收不收」。
	// 只降不升，且只在快照新鲜时生效（陈旧快照拦一个早已恢复的类型，比不拦更糟）。
	if (descriptor.kind !== "local" && descriptor.taskType && isTaskTypeOffline(descriptor.taskType)) {
		throw new Error(
			`「${descriptor.title}」已被服务端临时下架，现在提交会拿 6029。` +
				"恢复上架后 `gtrk doctor --refresh-catalog` 刷一次清单即可（无需升级 CLI）。",
		);
	}
	if (descriptor.kind === "local") {
		// local 型分派到工具自己的 handler（add-tool-mad D8 认可的族扩展：mad = 族内复杂度上限标尺）
		if (descriptor.name === "mad") return runMadInTool(typeof inputArg === "string" ? inputArg : undefined, opts);
		throw new Error(`local 型工具「${descriptor.name}」由后续 change 实现，暂不可用`);
	}
	// cloud 型：缺 Key → loadConfig 抛错引导 gtrk init（零网络）
	const cfg = loadConfig();
	const deps: CloudToolDeps = {
		cfg,
		uploadCached,
		invalidateUpload,
		submitTask,
		getTaskResult,
		downloadStream,
		probeDurationSec: (p, ff) => probeDuration(p, ff),
		...depsOverride,
	};
	log.step(`▶ ${descriptor.title}（${descriptor.name}）…`);
	const result = await runCloudTool(descriptor, inputArg, opts, deps);
	if (opts.json) console.log(JSON.stringify(result));
	if (result.ok) log.ok(`完成。产物目录：${result.outDir}`);
	else {
		log.err(`部分产物未落地（任务已完成、积分可能已扣）。task.json 已保留，可凭 task_id 恢复：${result.taskId}`);
		process.exitCode = 1;
	}
	return result;
}

/** local 型 mad 分派：runMad 编排 → 适配为 RunToolResult（--json 输出 mad 富结果）。 */
async function runMadInTool(inputArg: string | undefined, opts: ToolOpts): Promise<RunToolResult> {
	const technique = typeof opts.technique === "string" ? opts.technique : undefined;
	const search = typeof opts.search === "string" ? opts.search : undefined;
	// 出片态与查询态互斥：一个要素材、一个不要，混在一起只会让人猜命令到底干了什么。
	if (technique && search) {
		throw new Error("`--technique` 是按名单出片、`--search` 是查技法目录，两件事分两次跑。");
	}
	const madOpts: MadOpts = {
		bgm: typeof opts.bgm === "string" ? opts.bgm : undefined,
		duration: opts.duration != null ? Number(opts.duration) : undefined,
		seed: opts.seed != null ? Number(opts.seed) : undefined,
		refresh: !!opts.refresh,
		out: opts.out,
		ffmpegPath: opts.ffmpegPath,
		json: !!opts.json,
		technique,
		search,
	};
	if (search) {
		log.step("▶ 查技法目录（mad --search）…");
		const s = await runMadSearch(search, madOpts);
		if (opts.json) console.log(JSON.stringify(s));
		return { ok: true, tool: "mad", outDir: "", files: [] };
	}
	log.step("▶ 一键剪 MAD（mad）…");
	const r = await runMad(inputArg, madOpts, { cliVersion: currentVersion() });
	if (opts.json) console.log(JSON.stringify(r));
	if (r.ok) log.ok(`完成。产物目录：${r.outDir}`);
	return { ok: r.ok, tool: r.tool, outDir: r.outDir, files: r.files };
}

// ───────────────────────── 批次外壳（add-tool-batch-runner）─────────────────────────

/**
 * 枚举批次输入。三种形态，**都不猜**：
 *  · 目录 → 按该工具的 `input.kind` 认扩展名（`defaultExtsFor`，与单次路径同一份）
 *  · `.txt` → 一行一个路径（`#` 开头与空行忽略）
 *  · `.json` → 字符串数组
 */
async function enumerateBatchInputs(descriptor: ToolDescriptor, batch: string): Promise<string[]> {
	const abs = resolve(batch);
	if (!existsSync(abs)) throw new Error(`--batch 指向的路径不存在：${abs}`);
	if (statSync(abs).isDirectory()) {
		const exts = descriptor.input.exts ?? defaultExtsFor(descriptor.input.kind);
		if (!exts?.length) {
			throw new Error(
				`「${descriptor.name}」的输入类别是 ${descriptor.input.kind}，没有扩展名可认，目录形态无从枚举——` +
					"请给 .txt（一行一个路径）或 .json（字符串数组）清单",
			);
		}
		const set = new Set(exts.map((e: string) => (e.startsWith(".") ? e : `.${e}`).toLowerCase()));
		const files = readdirSync(abs)
			.filter((f) => set.has(extname(f).toLowerCase()))
			.sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
			.map((f) => join(abs, f));
		if (!files.length) throw new Error(`${abs} 里没有 ${[...set].join(" / ")} 文件`);
		return files;
	}
	const raw = readFileSync(abs, "utf8");
	if (abs.toLowerCase().endsWith(".json")) {
		const arr = JSON.parse(raw) as unknown;
		if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string")) {
			throw new Error(`${abs}：JSON 清单必须是字符串数组`);
		}
		return (arr as string[]).map((p) => resolve(dirname(abs), p));
	}
	const lines = raw
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"));
	if (!lines.length) throw new Error(`${abs}：清单是空的`);
	return lines.map((p) => resolve(dirname(abs), p));
}

/**
 * 「这个产物目录里有产物吗」。
 *
 * ⚠️ 判据 MUST NOT 是「目录存在」：上次跑到一半留下的空壳目录也存在，
 * 按目录存在跳过会把半成品当成品交付。判据是**目录里有非面包屑文件**——
 * 只剩 `task.json` 的目录是「提交了但没落产物」，那正是要重跑的那种。
 */
function hasBatchOutput(outDir: string): boolean {
	if (!existsSync(outDir)) return false;
	try {
		return readdirSync(outDir).some((f) => !BATCH_BREADCRUMBS.has(f));
	} catch {
		return false; // 读不了当没有：宁可重跑一次，也别把没产物的当成已完成
	}
}

const BATCH_BREADCRUMBS = new Set(["task.json", "result.json", "result-output.json"]);

export interface ToolBatchOpts extends ToolOpts {
	batch?: string;
	jobs?: string | number;
	skipExisting?: boolean;
	manifest?: string;
	dryRun?: boolean;
	yes?: boolean;
}

/** 批次跑。单条仍走 `runTool` 这个黑盒——**单次路径一字未改**是结构性保证，不靠自觉。 */
export async function runToolBatch(
	descriptor: ToolDescriptor,
	opts: ToolBatchOpts,
	deps?: Partial<CloudToolDeps>,
): Promise<Record<string, unknown>> {
	const inputs = await enumerateBatchInputs(descriptor, opts.batch!);
	const items = planBatch(
		inputs.map((input) => ({ input, outDir: resolveOutDir(descriptor, input, undefined) })),
		{ skipExisting: opts.skipExisting, hasOutput: hasBatchOutput },
	);

	// 计费**一次性前置**：MUST NOT 退化成逐条提示（跑 232 条刷 232 行，人会直接划过去）
	let unitHint = "实时价格暂不可用，以服务端结算为准";
	if (descriptor.kind !== "local" && descriptor.priceKey) {
		try {
			unitHint = (await resolveToolPricing(descriptor.priceKey, descriptor.pricingContext)).billingHint;
		} catch {
			/* 查不到价不阻断：单次路径同口径 */
		}
	} else if (descriptor.kind === "local") {
		unitHint = "本地执行，零计费";
	}
	const billing = batchBilling(items, unitHint);

	const jobsDefault = defaultJobsFor(descriptor.kind);
	const jobs = opts.jobs === undefined ? jobsDefault : clampJobs(opts.jobs, jobsDefault);
	if (descriptor.kind === "local" && jobs > 1) {
		log.warn(
			`「${descriptor.name}」是本地引擎类工具，缺省串行。--jobs ${jobs} 会并发压同一块卡——` +
				"实测并发提交会把显存打满并触发驱动复位（本地 ComfyUI 那条线踩过）。确认硬件扛得住再用。",
		);
	}

	log.step(`▶ 批次：${descriptor.title}（${descriptor.name}）｜${items.length} 条｜并发 ${jobs}`);
	log.warn(billing.line);

	if (opts.dryRun) {
		log.ok("[dry-run] 只列清单，零提交零计费。");
		for (const it of items) log.info(`   ${it.status === "skipped" ? "跳过" : "待跑"} ${it.input} → ${it.outDir}`);
		const dryResult = { ok: true, mode: "batch", tool: descriptor.name, dry_run: true, billing, items };
		if (opts.json) console.log(JSON.stringify(dryResult));
		return dryResult;
	}

	// 确认：`--yes` 跳过；`--json`（agent 驱动）也跳过——那条路上没有人在终端前面，
	// 计费总额已经在上面的 stderr 行里给过了，卡住只会变成挂死。
	if (billing.billable > 0 && !opts.yes && !opts.json && process.stdin.isTTY) {
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		const ans = (await rl.question(`确认提交 ${billing.billable} 条？[y/N] `)).trim().toLowerCase();
		rl.close();
		if (ans !== "y" && ans !== "yes") {
			log.info("已取消，零提交。");
			return { ok: true, mode: "batch", tool: descriptor.name, cancelled: true, billing, items };
		}
	}

	const manifestPath = opts.manifest ? resolve(opts.manifest) : null;
	if (manifestPath) mkdirSync(dirname(manifestPath), { recursive: true });

	const t0 = Date.now();
	await runPool(
		items,
		jobs,
		async (item) => {
			// 单条**照走既有单次路径**：--json 关掉（批次的 stdout 只有一行汇总），
			// --out 显式给成本条的产物目录（与 planBatch 算的那个同源，否则续跑判据会与落点脱钩）
			// suppressBillingHint：总额已在开跑前一次性给过，单次再逐条打一遍
			// 就是 spec 明文禁止的「退化成逐条提示」（真机 18 条跑出 18 行）
			const r = await runTool(
				descriptor,
				item.input,
				{ ...opts, batch: undefined, json: false, out: item.outDir, suppressBillingHint: true },
				deps,
			);
			if (!r.ok) throw new Error(`部分产物未落地（task_id=${r.taskId ?? "?"}）`);
			return { files: r.files ?? [], taskId: r.taskId };
		},
		(done, total, item) => {
			const mark = item.status === "ok" ? "✓" : "✗";
			log.info(`   ${mark} ${done}/${total} ${basename(item.input)}${item.reason ? `：${item.reason}` : ""}`);
			if (manifestPath) appendFileSync(manifestPath, `${manifestLine(item, descriptor.name)}\n`, "utf8");
		},
	);
	// 跳过的条目也该进 manifest——对账时「这条为什么没跑」和「这条跑挂了」同样要有记录
	if (manifestPath) {
		for (const it of items.filter((i) => i.status === "skipped")) {
			appendFileSync(manifestPath, `${manifestLine(it, descriptor.name)}\n`, "utf8");
		}
	}

	const summary = summarize(items, Date.now() - t0);
	if (summary.failed) {
		log.err(`批次完成，但有 ${summary.failed} 条失败（其余已落地）：`);
		for (const f of summary.failures.slice(0, 10)) log.err(`   · ${basename(f.input)}：${f.reason}`);
		if (summary.failures.length > 10) log.err(`   …另有 ${summary.failures.length - 10} 条，全量见回执 / --manifest`);
		process.exitCode = 1;
	} else {
		log.ok(`批次完成：${summary.ok} 成功 / ${summary.skipped} 跳过，用时 ${Math.round(summary.ms / 1000)}s`);
	}

	const result = {
		mode: "batch",
		tool: descriptor.name,
		dry_run: false,
		jobs,
		billing,
		...summary,
		// `ok` MUST 排在展开之后：summary 里没有 ok，但展开在前会让将来给 summary 加 ok 时静默覆盖这里
		ok: summary.failed === 0,
		items,
		...(manifestPath ? { manifest: manifestPath } : {}),
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}
