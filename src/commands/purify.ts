import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { log, routeLogsToStderr } from "../lib/log";
import { appendRegionSpecs, parseRegionSpec, parseRoiSpec, summarizeRegions, validateDocument } from "../lib/purify-contract";
import { startPurify, resumePurify, writeJsonAtomic, type PurifyDeps, type PurifyOpts, type PurifyResult } from "../lib/purify-flow";
import { PURIFY_METHOD_HELP } from "../lib/purify-method";
export { parseRegionSpec, startPurify, resumePurify };
export { checkPurifyProtocol } from "../lib/purify-flow";
export type { PurifyOpts, PurifyDeps, PurifyResult };

const collect = (value: string, acc: string[]) => [...acc, value];
function effectiveOptions(command: Command): PurifyOpts {
	const chain: Command[] = [];
	for (let node: Command | null = command; node; node = node.parent) chain.unshift(node);
	const result: Record<string, unknown> = {};
	for (const node of chain) Object.assign(result, node.opts());
	for (const node of chain) for (const [key, value] of Object.entries(node.opts())) {
		if (node.getOptionValueSource(key) !== "default") result[key] = value;
	}
	return result as PurifyOpts;
}
export async function runPurify(input: string, opts: PurifyOpts = {}, deps: Partial<PurifyDeps> = {}) {
	if (opts.noDetect || opts.detect === false) {
		if (opts.regionsJson) return startPurify("apply", opts.regionsJson, opts, deps);
		if (!opts.watermarkRegion?.length) throw new Error("--no-detect 需要最终清单或人工区域");
		return startPurify("manual", input, opts, deps);
	}
	return startPurify("run", input, opts, deps);
}
function options(command: Command, detect: boolean): Command {
	command.option("-o, --out <dir>", "产物目录（相同请求自动恢复已有任务）")
		.option("--purify-func-type <ffmpeg|raft>", PURIFY_METHOD_HELP + "；处理前必选，无默认值")
		.option("--watermark-region <box>", "追加人工框 x,y,w,h[,start[,end]]，可重复", collect, [])
		.option("--protect-region <box>", "保护框，优先于处理范围，可重复", collect, [])
		.option("--reupload", "首次上传忽略缓存；恢复任务不重传")
		.option("--json", "stdout 只输出结果 JSON");
	if (detect) command.option("--detect-scope <scope>", "明确扫描范围 full_screen|subtitle|custom")
		.option("--detect-roi <box>", "custom 范围 x,y,w,h");
	return command;
}
function print(result: PurifyResult, opts: PurifyOpts) {
	if (opts.json) console.log(JSON.stringify(result));
	else log.ok(result.status === "awaiting_review" ? "检测完成，请编辑后 apply：" + result.finalRegionsJson : "完成：" + result.output);
}
export function registerPurify(program: Command, deps: Partial<PurifyDeps> = {}): void {
	const root = options(program.command("purify [video]").enablePositionalOptions().description("检测、审阅最终清单、处理及任务恢复"), true)
		.option("--no-detect", "兼容入口：只按人工区域或最终清单处理")
		.option("--regions-json <file>", "最终区域文档；与 --no-detect 一起使用")
		.action(async (video: string | undefined, opts: PurifyOpts) => {
			if (!video) throw new Error("请使用 purify detect/apply/run/resume，或提供视频路径");
			if (opts.json) routeLogsToStderr(); print(await runPurify(video, opts, deps), opts);
		});
	for (const mode of ["detect", "run", "apply"] as const) {
		options(root.command(mode + (mode === "apply" ? " <regions-json>" : " <video>")), mode !== "apply")
			.action(async (input: string, _opts: PurifyOpts, command: Command) => {
				const opts = effectiveOptions(command);
				if (opts.json) routeLogsToStderr();
				print(await startPurify(mode, input, mode === "detect" ? { ...opts, detectScope: opts.detectScope ?? "full_screen" } : opts, deps), opts);
			});
	}
	root.command("resume <journal>").description("继续已有任务或下载，不重复建单")
		.option("--purify-func-type <ffmpeg|raft>", "旧记录尚未提交处理任务时，补充用户明确选择的模式；已提交任务不能改模式")
		.option("--json", "输出 JSON").action(async (path: string, _opts: PurifyOpts, command: Command) => {
			const opts = effectiveOptions(command);
			if (opts.json) routeLogsToStderr(); print(await resumePurify(path, deps, opts), opts);
		});
	root.command("edit <regions-json>").description("本地筛选/补框，输出新的最终清单；无云端调用")
		.option("-o, --out <file>", "另存的最终区域文件（必填）")
		.option("--delete-id <id>", "删除区域 ID，可重复", collect, [])
		.option("--select-roi <box>", "只保留与该范围相交的候选，不改变框本身")
		.option("--watermark-region <box>", "追加人工框，可重复", collect, [])
		.option("--protect-region <box>", "追加保护框，可重复", collect, [])
		.action(async (path: string, _opts: unknown, command: Command) => {
			const opts = effectiveOptions(command) as PurifyOpts & { out: string; deleteId: string[]; selectRoi?: string; watermarkRegion: string[]; protectRegion: string[] };
			if (!opts.out) throw new Error("edit 需要 --out 最终区域文件");
			if (resolve(path) === resolve(opts.out)) throw new Error("edit 请另存文件，保留原始检测结果");
			const doc = validateDocument(JSON.parse(await readFile(path, "utf8")));
			const ids = new Set(opts.deleteId);
			for (const id of ids) if (!doc.regions.some(r => r.id === id)) throw new Error("不存在的区域 ID：" + id);
			const roi = opts.selectRoi ? parseRoiSpec(opts.selectRoi) : undefined;
			doc.regions = doc.regions.filter(r => !ids.has(r.id) && (!roi || (r.x < roi.x + roi.w && r.x + r.w > roi.x && r.y < roi.y + roi.h && r.y + r.h > roi.y)));
			doc.regions = appendRegionSpecs(doc.regions, opts.watermarkRegion, doc.video.duration);
			doc.protect_regions = appendRegionSpecs(doc.protect_regions ?? [], opts.protectRegion, doc.video.duration, "protect");
			await writeJsonAtomic(resolve(opts.out), validateDocument(doc));
			console.log(JSON.stringify({ ok: true, finalRegionsJson: resolve(opts.out), summary: summarizeRegions(doc) }));
		});
}
