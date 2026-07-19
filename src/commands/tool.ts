/**
 * gtrk tool —— 单点工具族命令（add-tool-command-family D1）。
 *
 * 命令形态铁律（oralcut-result D2 教训、split.ts 头注释）：顶层命令 + 首个 positional 词内部分派，
 * **不用 commander 父子命令**（防吞选项）。`gtrk tool <name> [input]` 分派到注册表 descriptor 跑共享 runner；
 * `gtrk tool list` 为发现子模式（人读表格 + --json 机读，无 Key 也能跑、零网络）。
 *
 * 各 descriptor 的工具专属 options 在注册时统一挂 commander（去重按 flag）。
 * gated 工具（enabled=false）直调即报错「能力未开放」+ disabledReason、进程非 0、零上传零提交。
 */
import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import { submitTask, getTaskResult } from "../lib/cloud";
import { uploadCached, invalidateUpload } from "../lib/upload-cache";
import { probeDuration } from "../lib/media";
import { log, routeLogsToStderr } from "../lib/log";
import {
	TOOL_REGISTRY,
	findTool,
	validateRegistry,
	type ToolDescriptor,
} from "../lib/tool-descriptors";
import { runCloudTool, downloadStream, type RunToolResult, type CloudToolDeps } from "../lib/tool-runner";
import { runMad, type MadOpts } from "../lib/mad/mad";
import { currentVersion } from "../lib/version";

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
		.description("单点工具族：`gtrk tool <name> [input]` 跑单个能力；`gtrk tool list` 查全部（含输入/产物/计费/状态）")
		.option("-o, --out <dir>", "产物目录（缺省 = <输入名>-<tool>/；input=none 落 cwd 下 <tool>-<时间戳>/）")
		.option("--param <k=v>", "透传任意云端参数（标量、可重复；如 --param width=1080）", collectParam, [])
		.option("--params-json <json>", "透传任意云端参数（JSON 对象）")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录（缺省 ~/.gitruck/ffmpeg → 系统 PATH）")
		.option("--reupload", "强制重新上传，忽略本地上传缓存")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON（给 agent/脚本解析）");
	// 各 descriptor 的工具专属选项统一挂上（去重按 flag，防同名重复注册报错）
	const seen = new Set<string>();
	for (const d of registry) {
		for (const o of d.options ?? []) {
			if (seen.has(o.flag)) continue;
			seen.add(o.flag);
			cmd.option(o.flag, o.desc);
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
		throw new Error("用法：`gtrk tool <name> [input]` 跑工具；`gtrk tool list` 查全部工具");
	}
	if (name === "list") {
		runList(opts, registry);
		return undefined;
	}
	const descriptor = findTool(name, registry);
	if (!descriptor) {
		const names = registry.map((d) => d.name).join(", ");
		throw new Error(`未知工具「${name}」。可用工具：${names || "（空）"}（用 gtrk tool list 查看详情）`);
	}
	return runTool(descriptor, words[1], opts, deps);
}

/** list 发现子模式：人读表格 + --json 单行机读数组（无 Key 照常可用、零网络）。 */
export function runList(opts: ToolOpts, registry: ToolDescriptor[] = TOOL_REGISTRY): void {
	const rows = registry.map((d) => ({
		name: d.name,
		title: d.title,
		input: d.input.kind,
		output: d.outputHint,
		billingHint: d.billingHint,
		enabled: d.enabled,
		...(d.disabledReason ? { disabledReason: d.disabledReason } : {}),
	}));
	if (opts.json) {
		console.log(JSON.stringify(rows));
		return;
	}
	log.step("▶ gtrk 工具族（gtrk tool <name> [input]）：");
	for (const r of rows) {
		const status = r.enabled ? "已上线" : `未开放（${r.disabledReason ?? "无原因"}）`;
		log.info(`${r.name} — ${r.title}｜输入 ${r.input}｜产物 ${r.output}｜${r.billingHint}｜${status}`);
	}
	log.info("agent 一律带 --json；缺 API Key 先跑 `gtrk init`；跑前把计费提示转述给用户。");
}

/** 分派到单个工具执行。 */
async function runTool(
	descriptor: ToolDescriptor,
	inputArg: string | undefined,
	opts: ToolOpts,
	depsOverride?: Partial<CloudToolDeps>,
): Promise<RunToolResult> {
	// gated 门：直调即报错，零上传零提交零网络（先于 loadConfig）
	if (!descriptor.enabled) {
		throw new Error(`能力未开放：${descriptor.disabledReason ?? "（未提供原因）"}（用 gtrk tool list 查看全部工具）`);
	}
	if (descriptor.kind === "local") {
		// local 型分派到工具自己的 handler（add-tool-mad D8 认可的族扩展：mad = 族内复杂度上限标尺）
		if (descriptor.name === "mad") return runMadInTool(inputArg, opts);
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
	log.step("▶ 一键剪 MAD（mad）…");
	const madOpts: MadOpts = {
		bgm: typeof opts.bgm === "string" ? opts.bgm : undefined,
		duration: opts.duration != null ? Number(opts.duration) : undefined,
		seed: opts.seed != null ? Number(opts.seed) : undefined,
		refresh: !!opts.refresh,
		out: opts.out,
		ffmpegPath: opts.ffmpegPath,
		json: !!opts.json,
	};
	const r = await runMad(inputArg, madOpts, { cliVersion: currentVersion() });
	if (opts.json) console.log(JSON.stringify(r));
	if (r.ok) log.ok(`完成。产物目录：${r.outDir}`);
	return { ok: r.ok, tool: r.tool, outDir: r.outDir, files: r.files };
}
