/**
 * gtrk qc —— 成片质量扫描（add-qc-scan · qc-command spec）。
 * 单趟解码扫全片：闪帧/段内跳切/黑帧/冻结/爆音/静音/音画规整，产人读报告 + 机读 qc-report v1，
 * 退出码按 `--fail-on` 门控供管线消费。
 */
import { Command } from "commander";
import { resolve, dirname, join, basename, extname } from "node:path";
import { existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fmtTime, scanFinalCut, shouldFail, type QcItem, type QcReport, type QcSeverity } from "../lib/qc";
import { openLocalIndexDb, recordConfirmedCuts } from "../lib/local-index";
import { log, routeLogsToStderr } from "../lib/log";
import { runAlignmentQc, tryOpenIndexDb } from "../lib/alignment-qc";
import { resolveDescribeUrl } from "../lib/describe";
import { loadConfig } from "../lib/config";
import { requireFfmpeg } from "../lib/ffmpeg";

interface QcOpts {
	gtrk?: string;
	json?: string;
	failOn?: string;
	ffmpegPath?: string;
	feedbackCuts?: boolean;
	alignment?: boolean;
	project?: string;
	yes?: boolean;
}

const SEVERITY_LABEL: Record<QcSeverity, string> = { error: "严重", warn: "提示", info: "备注" };
const TYPE_LABEL: Record<string, string> = {
	flash: "过短镜头/节奏断裂",
	intra_cut: "段内跳切",
	black: "黑帧/黑段",
	freeze: "冻结画面",
	clip: "音频削波",
	silence: "静音段",
	av_drift: "音画时长不一致",
	vfr: "成片非固定帧率",
};

/** 机读报告缺省落点：`<成片同目录>/<成片名>.qc.json`（固定名会被多成片互踩）。 */
export function defaultReportPath(input: string): string {
	return join(dirname(input), `${basename(input, extname(input))}.qc.json`);
}

/** 人读报告（按严重级分组，每条带时码/时长/证据）。 */
export function formatReport(report: QcReport): string[] {
	const lines: string[] = [];
	const groups: QcSeverity[] = ["error", "warn", "info"];
	for (const sev of groups) {
		const items = report.items.filter((i) => i.severity === sev);
		if (!items.length) continue;
		lines.push(`【${SEVERITY_LABEL[sev]}】${items.length} 条`);
		for (const it of items) lines.push(`  ${formatItem(it)}`);
	}
	if (!lines.length) lines.push("未检出缺陷");
	return lines;
}

function formatItem(it: QcItem): string {
	const span = it.ed > it.st ? `${fmtTime(it.st)} – ${fmtTime(it.ed)}（${(it.ed - it.st).toFixed(3)}s）` : fmtTime(it.st);
	const ev = Object.entries(it.evidence)
		.filter(([k]) => k !== "note")
		.map(([k, v]) => `${k}=${typeof v === "number" ? v : JSON.stringify(v)}`)
		.join(" ");
	const note = typeof it.evidence.note === "string" ? `　${it.evidence.note}` : "";
	return `${TYPE_LABEL[it.type] ?? it.type}　${span}${ev ? `　${ev}` : ""}${note}`;
}

export function registerQc(program: Command): void {
	program
		.command("qc [成片]")
		.description("成片质量扫描：闪帧/段内跳切/黑帧/冻结/爆音/静音/音画规整，产报告与时码定位")
		.option("--gtrk <path>", "工程感知模式：对表 clip 拼接边界，识别段内跳切、已知黑底空洞降级")
		.option("--json <path>", "机读报告落点（缺省 = <成片同目录>/<成片名>.qc.json）")
		.option("--fail-on <level>", "退出码门控：error（默认）| warn | never", "error")
		.option(
			"--feedback-cuts",
			"把段内跳切映射回源时码并补录进本地索引（标 qc_confirmed，治检测阈值漏网）——须配 --gtrk；不带本开关时常规扫描零写库",
		)
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录（缺省 ~/.gitruck/ffmpeg → 系统）")
		.option("--alignment", "对齐质检：逐叙述句判定已铺画面是否给到稿句所说（须配 --project；引用段按结构校验跳过；计费=1 积分/句帧）")
		.option("--project <dir>", "[alignment] 工程产物目录（定位 gtrk/transcript/split 三件）")
		.option("--yes", "[alignment] 跳过计费确认")
		.action(async (input: string | undefined, opts: QcOpts) => {
			if (opts.alignment) {
				await runAlignmentMode(input, opts);
				return;
			}
			if (!input) throw new Error("缺少成片路径（常规质检模式必填；对齐质检走 --alignment --project）");
			const failOn = opts.failOn === "warn" || opts.failOn === "never" ? opts.failOn : "error";
			const inputAbs = resolve(input);
			if (!existsSync(inputAbs)) throw new Error(`成片不存在：${inputAbs}`);

			let gtrk: unknown;
			if (opts.gtrk) {
				const gtrkAbs = resolve(opts.gtrk);
				if (!existsSync(gtrkAbs)) throw new Error(`gtrk 工程不存在：${gtrkAbs}`);
				gtrk = JSON.parse(await readFile(gtrkAbs, "utf8"));
			}

			log.step(`▶ 成片质检：${basename(inputAbs)}${gtrk ? "（工程感知）" : ""}`);
			const report = await scanFinalCut(inputAbs, {
				gtrk,
				ffmpegPath: opts.ffmpegPath,
				onProgress: (l) => log.info(l),
			});

			for (const line of formatReport(report)) log.info(line);

			// 确认切点回流（显式动作；常规扫描零写库——QC 是只读诊断工具，静默改索引会让
			// 「重扫一次结果就变了」）。按 clip_id → 材料 id（消费方既有拼接 broll-+clip_id）分组补录。
			if (opts.feedbackCuts) {
				if (!gtrk) throw new Error("--feedback-cuts 须配 --gtrk（无工程坐标无从映射回源时码）");
				const byMaterial = new Map<string, number[]>();
				let skipped = 0;
				for (const it of report.items) {
					if (it.type !== "intra_cut") continue;
					const clipId = it.evidence.clip_id;
					const src = it.evidence.source_time;
					if (typeof clipId !== "string" || typeof src !== "number") {
						skipped++;
						continue;
					}
					const materialId = clipId.startsWith("broll-") ? clipId : `broll-${clipId}`;
					const list = byMaterial.get(materialId) ?? [];
					list.push(Math.round(src * 1000));
					byMaterial.set(materialId, list);
				}
				const db = await openLocalIndexDb();
				try {
					let added = 0;
					for (const [materialId, tsMs] of byMaterial) added += recordConfirmedCuts(db, materialId, tsMs);
					log.ok(`确认切点已回流索引：新增 ${added} 条（跳过 ${skipped} 条无法唯一映射）`);
				} finally {
					db.close();
				}
			}

			const reportPath = resolve(opts.json ?? defaultReportPath(inputAbs));
			await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
			log.ok(
				`质检完成：严重 ${report.summary.error} · 提示 ${report.summary.warn} · 备注 ${report.summary.info} → ${reportPath}`,
			);

			if (shouldFail(report, failOn)) process.exitCode = 1;
		});
}

/** [add-shot-cards-and-alignment-qc 1.4] 对齐质检模式（CLI 专属，勿入对外文档）。
 * positional 在本模式下兼作工程目录兜底（`gtrk qc --alignment <工程>` 与 `--project` 等价）。 */
async function runAlignmentMode(input: string | undefined, opts: QcOpts): Promise<void> {
	const target = opts.project ?? input;
	if (!target) throw new Error("对齐质检缺工程目录：--project <dir>（或 positional 兜底）");
	const projectDir = resolve(target);
	if (!existsSync(projectDir)) throw new Error(`工程目录不存在：${projectDir}`);
	const cfg = loadConfig();
	const endpoint = { url: resolveDescribeUrl(cfg.base), apiKey: cfg.apiKey };
	const ffmpeg = requireFfmpeg(opts.ffmpegPath).ffmpeg;
	log.step(`▶ 对齐质检：${projectDir}`);
	const db = await tryOpenIndexDb();
	try {
		const report = await runAlignmentQc(projectDir, {
			endpoint,
			ffmpeg,
			yes: opts.yes === true,
			confirm: async (q) => {
				const rl = createInterface({ input: process.stdin, output: process.stderr });
				try {
					const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
					return a === "y" || a === "yes";
				} finally {
					rl.close();
				}
			},
			onLog: (m) => log.info(m),
			db,
		});
		const s = report.summary;
		if (report.degraded) {
			log.warn(
				`对齐质检（降级形态）：${s.audited} 句已产帧描述，逐句裁定交 agent 文本判读 → qc/alignment-audit.{json,md}`,
			);
		} else {
			log.ok(
				`对齐率 ${s.rate}%：match ${s.match} · partial ${s.partial} · mismatch ${s.mismatch}（n=${s.audited}，引用段等跳过 ${s.skipped}）→ qc/alignment-audit.{json,md}`,
			);
			for (const it of report.items) {
				if (it.verdict === "mismatch") log.warn(`  mismatch ${it.id} @${fmtTime(it.track_mid)}：${it.sentence.slice(0, 24)}… — ${it.reason ?? ""}`);
			}
		}
	} finally {
		db?.close();
	}
}

/** 渲染尾随质检（add-qc-scan · local-ffmpeg-render delta）：同进程复用，异常降级不阻断出片。 */
export async function runPostRenderQc(
	outputPath: string,
	gtrk: unknown,
	opts: { ffmpegPath?: string } = {},
): Promise<QcReport | null> {
	try {
		const report = await scanFinalCut(outputPath, { gtrk, ffmpegPath: opts.ffmpegPath });
		const reportPath = defaultReportPath(outputPath);
		await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		const { error, warn, info } = report.summary;
		if (error + warn + info === 0) {
			log.ok(`质检通过：未检出缺陷 → ${reportPath}`);
		} else {
			log.info(`质检：严重 ${error} · 提示 ${warn} · 备注 ${info} → ${reportPath}`);
			for (const it of report.items.filter((i) => i.severity === "error")) log.info(`  ${formatItem(it)}`);
		}
		return report;
	} catch (e) {
		// 渲染成功即成功：质检自身故障只告警（spec「QC 故障不阻断出片」）
		log.warn(`渲染后质检未完成（${e instanceof Error ? e.message : String(e)}）——成片已出，可稍后手动跑 gtrk qc`);
		return null;
	}
}
