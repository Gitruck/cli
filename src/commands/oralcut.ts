/**
 * gtrk oralcut —— 智能口播剪辑最小闭环：
 *   agent 发起 → CLI 自主执行（上传毛片 → 云端 video_oral_cut → 轮询 → 拉回三方工程文件）→ 客户端/剪映/PR 打开。
 *
 * 云端零改动：全用现成 video_oral_cut，一次任务产 gtrk(客户端)+jianying(剪映)+xml(PR/FCP) 三方工程文件。
 * source_path 把毛片本地绝对路径写进 gtrk materials[].path → 本地打开直接认素材（本地素材不出本地）。
 */
import { Command } from "commander";
import { resolve, join, dirname, basename, extname } from "node:path";
import { mkdir, cp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadConfig } from "../lib/config";
import { submitTask, pollTask, download, CloudError } from "../lib/cloud";
import { uploadCached, invalidateUpload } from "../lib/upload-cache";
import { resolveJianyingDraftDir } from "../lib/jianying";
import { openFolder } from "../lib/open";
import { log, routeLogsToStderr } from "../lib/log";

const TASK_TYPE = "video_oral_cut";

/** 本地时间戳 YYMMDD-HHMMSS（如 260629-191530），用于产物目录名区分每一次剪辑。 */
function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 把云端返回的细分格式名归一化到基础格式（jianying_draft/jianying_meta → jianying）。 */
function baseFormat(fmt: string): string {
	if (fmt.startsWith("jianying")) return "jianying";
	if (fmt.startsWith("capcut")) return "capcut";
	return fmt;
}

/** 基础格式 → 标签 + 打开提示。 */
const FORMAT_META: Record<string, { label: string; openHint: (p: string) => string }> = {
	gtrk: { label: "客户端 (gtrk)", openHint: (p) => `客户端里「打开工程」选 ${p}` },
	jianying: { label: "剪映 (jianying)", openHint: (p) => `剪映里打开即见草稿（目录 ${p}）` },
	capcut: { label: "CapCut", openHint: (p) => `CapCut 里打开即见草稿（目录 ${p}）` },
	xml: { label: "PR/FCP (Premiere XML)", openHint: (p) => `Premiere Pro：文件 > 导入 ${p}` },
	fcpxml: { label: "Final Cut (fcpxml)", openHint: (p) => `Final Cut Pro：导入 ${p}` },
	otio: { label: "OpenTimelineIO", openHint: (p) => `用支持 OTIO 的工具打开 ${p}` },
};

interface OralCutOpts {
	script?: string;
	preset: string;
	out?: string;
	formats: string;
	jianyingDraftDir?: string;
	open?: boolean;
	reupload?: boolean;
	json?: boolean;
}

export function registerOralCut(program: Command): void {
	program
		.command("oralcut <input>")
		.description("智能口播剪辑闭环：上传毛片 → 云端剪辑 → 拉回 gtrk/剪映/PR 工程文件 → 打开")
		.option("-s, --script <file>", "文稿 txt 路径（缺省走无稿智能重建）")
		.option("-p, --preset <preset>", "节奏预设 steady|concise|compact", "concise")
		.option("-o, --out <dir>", "工程产物目录（缺省 = <毛片同目录>/<毛片名>-video-project-<YYMMDD-HHMMSS>）")
		.option("-f, --formats <list>", "三方格式（逗号分隔）", "gtrk,jianying,xml")
		.option("--jianying-draft-dir <dir>", "剪映草稿根目录；传路径或 auto（默认读 gtrk init 配置 / 自动探测）")
		.option("--reupload", "强制重新上传，忽略本地上传缓存（毛片改了但指纹意外没变时用）")
		.option("--no-open", "完成后不自动打开产物目录（默认会自动打开，省得你找文件去哪了）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON（给 agent/脚本解析）")
		.action(async (input: string, opts: OralCutOpts) => {
			await runOralCut(input, opts);
		});
}

async function runOralCut(input: string, opts: OralCutOpts): Promise<void> {
	if (opts.json) routeLogsToStderr(); // 机读模式：人读日志转 stderr，stdout 只留结果 JSON
	const cfg = loadConfig();
	const inputAbs = resolve(input);
	if (!existsSync(inputAbs)) throw new Error(`毛片不存在：${inputAbs}`);

	const projName = basename(inputAbs, extname(inputAbs));
	const formats = opts.formats.split(",").map((s) => s.trim()).filter(Boolean);
	const wantJianying = formats.some((f) => f === "jianying" || f === "capcut");
	// 缺省产物目录与毛片同目录，名为 <毛片名>-video-project-<时间戳>：靠文件名+时间一眼认出是哪一次剪辑
	const outDir = resolve(opts.out ?? join(dirname(inputAbs), `${projName}-video-project-${timestamp()}`));
	await mkdir(outDir, { recursive: true });

	// 文稿：显式 --script 优先；没给则探毛片同目录同名 .txt，有就当文稿（按有稿剪、更准）
	let scriptPath = opts.script ? resolve(opts.script) : undefined;
	if (!scriptPath) {
		const sibling = join(dirname(inputAbs), `${projName}.txt`);
		if (existsSync(sibling)) {
			scriptPath = sibling;
			log.info(`自动识别到同名文稿：${sibling}（按有稿剪辑；不想用就改名或显式 --script）`);
		}
	}
	const script = scriptPath ? await readFile(scriptPath, "utf8") : undefined;

	// 剪映草稿目录：提交前先解析（draft_meta_info.json 必须由云端在提交时按此目录产）。
	let draftDir: string | undefined;
	if (wantJianying) {
		draftDir = resolveJianyingDraftDir(opts.jianyingDraftDir);
		if (draftDir) log.info(`剪映草稿目录：${draftDir}`);
		else log.warn("没找到剪映草稿目录（剪映/CapCut 未装在标准位置）→ 将只产 draft_content.json、缺 meta，剪映无法直接打开。可加 --jianying-draft-dir <你的草稿目录> 重跑。");
	}

	log.step(`▶ 智能口播剪辑：${basename(inputAbs)}（预设 ${opts.preset}，格式 ${formats.join("/")}）`);

	// ① 上传毛片 → file_id（本地指纹缓存：同一文件命中则复用 file_id，免二次上传）
	log.step("① 上传毛片到云端…");
	let up = await uploadCached(cfg, inputAbs, { force: opts.reupload });
	log.info(up.cached ? `命中上传缓存，复用 file_id = ${up.fileId}（免二次上传）` : `file_id = ${up.fileId}`);

	// 用当前 file_id 拼提交体（缓存失效要重拼，故抽成函数）
	const buildPayload = (fid: string): Record<string, unknown> => {
		const p: Record<string, unknown> = {
			file_id: fid,
			la: "zh-CN",
			outputs: ["project"],
			project_formats: formats,
			source_path: inputAbs, // 本地绝对路径写进 gtrk materials[].path → 本地打开认素材
			rhythm_preset: opts.preset,
		};
		if (script) p.script = script;
		if (draftDir) p.struct_meta = { nle_draft_dir: draftDir };
		return p;
	};

	// ② 提交 video_oral_cut（一次出三方工程文件）；缓存的 file_id 若在云端已失效（6004），重传重试一次
	log.step("② 提交智能口播剪辑任务…");
	let taskId: string;
	try {
		taskId = await submitTask(cfg, TASK_TYPE, buildPayload(up.fileId));
	} catch (e) {
		if (up.cached && e instanceof CloudError && e.code === 6004) {
			log.warn("缓存的 file_id 在云端已失效，重新上传后重试…");
			await invalidateUpload(inputAbs);
			up = await uploadCached(cfg, inputAbs, { force: true });
			taskId = await submitTask(cfg, TASK_TYPE, buildPayload(up.fileId));
		} else throw e;
	}
	log.info(`task_id = ${taskId}`);

	// ③ 轮询到完成
	log.step("③ 云端处理中（每 5s 轮询）…");
	const result = await pollTask(cfg, TASK_TYPE, taskId, (status, progress) => {
		log.tick(`${status}${progress != null ? ` ${Math.round(progress)}%` : ""}`);
	});
	log.tickEnd();

	// ④ 拉回三方工程文件（按基础格式分组到 <out>/<基础格式>/）
	const files = result.files ?? [];
	if (!files.length) throw new Error("任务完成但无工程文件产物（检查 project_formats）");
	log.step(`④ 拉回 ${files.length} 个产物到本地…`);
	const byFormat: Record<string, string[]> = {};
	for (const f of files) {
		const base = baseFormat(f.format);
		const fmtDir = join(outDir, base);
		await mkdir(fmtDir, { recursive: true });
		const dest = join(fmtDir, f.filename);
		await download(f.download_url, dest);
		(byFormat[base] ??= []).push(dest);
		log.info(`${FORMAT_META[base]?.label ?? f.format} ← ${f.filename}`);
	}
	if (result.errors && Object.keys(result.errors).length) {
		log.warn(`部分产物失败：${JSON.stringify(result.errors)}`);
	}

	// 剪映：把草稿（draft_content.json + draft_meta_info.json）拷进 <草稿目录>/<产物目录同名>/
	// 与产物目录同名（含时间戳）→ 剪映项目列表里每次剪辑各为独立条目、认得出哪一次，不互相覆盖
	let jianyingDraftPath: string | undefined;
	if (byFormat.jianying && draftDir) {
		jianyingDraftPath = join(draftDir, basename(outDir));
		await mkdir(jianyingDraftPath, { recursive: true });
		await cp(join(outDir, "jianying"), jianyingDraftPath, { recursive: true });
		log.info(`剪映草稿已落到：${jianyingDraftPath}`);
	}

	// ⑤ 三方打开提示（人读；--json 模式整段跳过，避免这些 console.log 污染 stdout 的机读 JSON）
	if (!opts.json) {
		log.step("⑤ 三方打开（产物已就位，按需自取）：");
		for (const base of Object.keys(byFormat)) {
			const meta = FORMAT_META[base];
			const target =
				base === "jianying" ? (jianyingDraftPath ?? join(outDir, "jianying")) : byFormat[base][0];
			console.log(`   • ${meta?.label ?? base}：${meta?.openHint(target) ?? target}`);
		}
	}

	// 默认自动打开产物目录（--no-open 关）：用户常不知道文件落哪了，直接帮他打开、自己决定后续
	if (opts.open) {
		openFolder(outDir);
		log.info("已打开产物目录文件夹");
	}

	log.ok(`闭环完成。产物目录：${outDir}`);

	// 机读输出：stdout 只此一行 JSON，供 agent/脚本解析（人读日志已转 stderr）
	if (opts.json) {
		const errors = result.errors ?? {};
		console.log(
			JSON.stringify({
				ok: Object.keys(errors).length === 0,
				outDir,
				files: byFormat,
				jianyingDraftPath: jianyingDraftPath ?? null,
				errors,
				taskId,
				fileId: up.fileId,
			}),
		);
	}
}
