/**
 * gtrk oralcut-result <taskId> —— 按 task_id 取回一个已完成口播剪辑任务的报告与三方工程产物
 * （可选本地渲染成片），全程不重跑云端流水线（跳过预处理/上传/提交/轮询）。
 *
 * 顶层命令而非 `oralcut` 子命令：`oralcut <input>` 与 `oralcut result` 的同名选项（--out/--json/
 * --render…）在 commander 里会被父命令吞掉，故取平级命令名，避免选项绑定歧义（见 change design D2）。
 *
 * 复用 materializeResult 落地。报告存于任务记录，即使底层产物文件已过保留期（~60天GC、下载 404）
 * 仍会打印/落盘报告。取结果需用「提交该任务的同一账号」的 API Key；异账号/已删任务报 TASK_NOT_FOUND。
 */
import { Command } from "commander";
import { resolve, join } from "node:path";
import { loadConfig } from "../lib/config";
import { getTaskResult, CloudError, type OralCutOutput } from "../lib/cloud";
import { resolveJianyingDraftDir } from "../lib/jianying";
import { materializeResult } from "../lib/materialize";
import { log, routeLogsToStderr } from "../lib/log";

// 与 oralcut 主命令同一 cli 域任务类型
const TASK_TYPE = "cli/video_oral_cut_for_cli";

interface OralCutResultOpts {
	out?: string;
	render?: boolean;
	crf?: string;
	codec?: string;
	ffmpegPath?: string;
	jianyingDraftDir?: string;
	open?: boolean;
	json?: boolean;
}

/** 本地时间戳 YYMMDD-HHMMSS（产物目录名区分每一次取回）。 */
function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 注册顶层命令 `gtrk oralcut-result <taskId>`。 */
export function registerOralCutResult(program: Command): void {
	program
		.command("oralcut-result <taskId>")
		.description("按 task_id 取回已完成任务的报告 + 三方工程产物（可选 --render），不重跑云端")
		.option("-o, --out <dir>", "产物目录（缺省 = <当前目录>/<taskId>-video-project-<时间戳>）")
		.option("--render", "额外本地渲染成片（需原毛片仍在 gtrk 内嵌路径 + ffmpeg）")
		.option("--crf <n>", "本地渲染 CRF 14-28（默认 18；需配 --render）")
		.option("--codec <c>", "本地渲染编码（默认 h264；需配 --render）")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 目录（缺省 ~/.gitruck/ffmpeg → 系统）")
		.option("--jianying-draft-dir <dir>", "剪映草稿根目录；传路径或 auto（默认读配置 / 自动探测）")
		.option("--no-open", "完成后不自动打开产物目录（默认会自动打开）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON（给 agent/脚本解析）")
		.action(async (taskId: string, opts: OralCutResultOpts) => {
			await runOralCutResult(taskId, opts);
		});
}

async function runOralCutResult(taskId: string, opts: OralCutResultOpts): Promise<void> {
	if (opts.json) routeLogsToStderr(); // 机读模式：人读日志转 stderr，stdout 只留结果 JSON
	const cfg = loadConfig();

	log.step(`▶ 按 task_id 取回口播剪辑结果：${taskId}`);
	let got: { status: string; progress?: number; output: OralCutOutput };
	try {
		got = await getTaskResult(cfg, TASK_TYPE, taskId);
	} catch (e) {
		if (e instanceof CloudError) {
			throw new Error(
				`取任务结果失败（code=${e.code}）：${e.message}。` +
					`注意：取结果需用「提交该任务的同一账号」的 API Key；异账号或已删任务会报 TASK_NOT_FOUND。`,
			);
		}
		throw e;
	}

	if (got.status !== "completed") {
		if (got.status === "failed" || got.status === "cancelled") {
			const out = got.output as { error?: string };
			throw new Error(`任务未成功（${got.status}）：${out?.error ?? "无产物可取回"}`);
		}
		const pct = got.progress != null ? ` ${Math.round(got.progress)}%` : "";
		throw new Error(`任务尚未完成（当前 ${got.status || "未知"}${pct}），暂无法取回结果；请稍后再试。`);
	}

	// 恢复命令没有毛片名，缺省用 <当前目录>/<taskId>-video-project-<时间戳>
	const outDir = resolve(opts.out ?? join(process.cwd(), `${taskId}-video-project-${timestamp()}`));
	const draftDir = resolveJianyingDraftDir(opts.jianyingDraftDir);

	await materializeResult({
		outDir,
		output: got.output,
		taskId,
		draftDir,
		render: opts.render,
		crf: opts.crf,
		codec: opts.codec,
		ffmpegPath: opts.ffmpegPath,
		json: opts.json,
		open: opts.open,
	});

	log.ok(`已取回。产物目录：${outDir}`);
}
