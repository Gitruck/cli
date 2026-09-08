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
import { resolve } from "node:path";
import { loadConfig } from "../lib/config";
import { getTaskResult, CloudError, type OralCutOutput } from "../lib/cloud";
import { resolveJianyingDraftDir } from "../lib/jianying";
import { materializeResult } from "../lib/materialize";
import { ensureLandingWritable } from "../lib/landing-wait";
import type { LandingWaitDeps } from "../lib/landing-wait";
import { log, routeLogsToStderr } from "../lib/log";

// 与 oralcut 主命令同一 cli 域任务类型
const TASK_TYPE = "cli/video_oral_cut_for_cli";

/** 可注入依赖（形态照 `src/commands/oralcut.ts:71` 的 OralCutDeps）。单测据此断言「零网络往返」。 */
export interface OralCutResultDeps {
	loadConfig: typeof loadConfig;
	getTaskResult: typeof getTaskResult;
	materialize: typeof materializeResult;
	/** 落点闸的交互依赖；Gate A 与 Gate B 共用同一份，MUST NOT 各自实现。 */
	landingWait: Partial<LandingWaitDeps>;
}

function buildDeps(o: Partial<OralCutResultDeps> = {}): OralCutResultDeps {
	return {
		loadConfig: o.loadConfig ?? loadConfig,
		getTaskResult: o.getTaskResult ?? getTaskResult,
		materialize: o.materialize ?? materializeResult,
		landingWait: o.landingWait ?? {},
	};
}

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

/** 注册顶层命令 `gtrk oralcut-result <taskId>`。 */
export function registerOralCutResult(program: Command): void {
	program
		.command("oralcut-result <taskId>")
		.description("按 task_id 取回已完成任务的报告 + 三方工程产物（可选 --render），不重跑云端")
		.option("-o, --out <dir>", "产物目录（**必填**；`.` = 当前目录本身。2026-09-08 起不再有 cwd 缺省）")
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

export async function runOralCutResult(
	taskId: string,
	opts: OralCutResultOpts,
	overrides: Partial<OralCutResultDeps> = {},
): Promise<void> {
	if (opts.json) routeLogsToStderr(); // 机读模式：人读日志转 stderr，stdout 只留结果 JSON
	const deps = buildDeps(overrides);
	const cfg = deps.loadConfig();

	// ══ Gate A（D3 + artifact-landing-gate 第一条）：任何网络往返之前 ══
	// `--out` 自 2026-09-08 起必填。旧缺省会把整套工程静默写进「敲命令时恰好所在的目录」，
	// 那是 CLI 替用户选了落点——正是本轮裁决要消除的形态，故当场硬拒，MUST NOT 降级成 WARN。
	// ⚠️ 本段 MUST 排在 getTaskResult 之前：零网络往返是本条的判据本身（tasks §3.6）。
	if (!opts.out) {
		throw new Error(
			`缺少必填参数 --out <目录>：gtrk oralcut-result 不会替你选产物落点。\n` +
				`  · 落到当前目录：      gtrk oralcut-result ${taskId} --out .\n` +
				`  · 落到具名子目录：    gtrk oralcut-result ${taskId} --out ./${taskId}-video-project\n` +
				`（旧版缺省是「当前目录下的一个带时间戳子目录」，但那个目录纯属偶然；` +
				`产物落错地方而用户收不到硬信号，是 2026-09-07 事故的形态之一。）`,
		);
	}
	// `--out` 保持字面目标目录语义（同全仓 `--out`）：`.` 就是当前目录本身，不再套一层子目录。
	const outDir = resolve(opts.out);
	await ensureLandingWritable(outDir, "产物目录", { json: opts.json, deps: deps.landingWait });

	// 剪映草稿根的解析不依赖网络，故一并提前；但**是否真会产剪映产物**要等取回结果才知道
	// （materialize.ts 里 `if (byFormat.jianying && opts.draftDir)`）。
	// 因此只有用户**显式**给了 --jianying-draft-dir（= 明示要落到那儿）才在此刻探；
	// 未显式指定时草稿根的可写性交给 Gate B 兜底，避免为一个可能用不上的落点阻塞用户。
	const draftDir = resolveJianyingDraftDir(opts.jianyingDraftDir);
	if (opts.jianyingDraftDir && draftDir)
		await ensureLandingWritable(draftDir, "剪映草稿根", { json: opts.json, deps: deps.landingWait });

	log.step(`▶ 按 task_id 取回口播剪辑结果：${taskId}`);
	let got: { status: string; progress?: number; output: OralCutOutput };
	try {
		got = await deps.getTaskResult(cfg, TASK_TYPE, taskId);
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

	// outDir / draftDir 已在 Gate A（本函数顶部、任何网络往返之前）解析并探过可写性。

	const mat = await deps.materialize({
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
		landingWait: deps.landingWait,
	});

	// 4.5 未消解的本地写入失败 ⇒ 非零退出（形态照 long2short.ts:490-494：设 exitCode 后 return，
	//     MUST NOT 调 process.exit）。云端 404 过期**不**改退出码——过期时仍能取回报告是本命令的价值。
	if (mat.localWriteFailed) {
		log.err(
			"存在未消解的本地写入失败：产物没有全部落到你指定的目录。" +
				`报告与 task.json 已保留，修好写入权限后可用：gtrk oralcut-result ${taskId} --out <目录>（不重跑、不二次计费）。`,
		);
		process.exitCode = 1;
		return;
	}
	log.ok(`已取回。产物目录：${outDir}`);
}
