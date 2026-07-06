/**
 * 三方产物落地共享逻辑：按 baseFormat 分组下载 + 剪映草稿拷贝 +（可选）本地渲染 + result.json 两段写 +
 * 人读打开提示 / --json 输出。供 `oralcut`（跑批 ⑤⑥⑦）与 `oralcut result`（按 task_id 恢复）复用。
 *
 * result.json 恒落盘（不受 --json 约束）：下载前先写一版基础清单（含 report/taskId），
 * 使报告能扛住其后的下载/渲染失败；下载渲染完成后再补写解析出的本地路径。
 * 下载遇 404（产物过期被 GC）不整体中止：记入 errors、仍完成报告落盘与输出。
 */
import { join, basename } from "node:path";
import { mkdir, cp, writeFile } from "node:fs/promises";
import { download as realDownload, type OralCutOutput } from "./cloud";
import { renderGtrk, readGtrkFile, type GtrkV1 } from "./render";
import { openFolder } from "./open";
import { log } from "./log";

/** 把云端返回的细分格式名归一化到基础格式（jianying_draft/jianying_meta → jianying）。 */
export function baseFormat(fmt: string): string {
	if (fmt.startsWith("jianying")) return "jianying";
	if (fmt.startsWith("capcut")) return "capcut";
	return fmt;
}

/** 基础格式 → 标签 + 打开提示。 */
export const FORMAT_META: Record<string, { label: string; openHint: (p: string) => string }> = {
	gtrk: { label: "客户端 (gtrk)", openHint: (p) => `客户端里「打开工程」选 ${p}` },
	jianying: { label: "剪映 (jianying)", openHint: (p) => `剪映里打开即见草稿（目录 ${p}）` },
	capcut: { label: "CapCut", openHint: (p) => `CapCut 里打开即见草稿（目录 ${p}）` },
	xml: { label: "PR/FCP (Premiere XML)", openHint: (p) => `Premiere Pro：文件 > 导入 ${p}` },
	fcpxml: { label: "Final Cut (fcpxml)", openHint: (p) => `Final Cut Pro：导入 ${p}` },
	otio: { label: "OpenTimelineIO", openHint: (p) => `用支持 OTIO 的工具打开 ${p}` },
};

export interface MaterializeOpts {
	outDir: string;
	/** 云端 output_result：{report, files[], errors}。 */
	output: OralCutOutput;
	taskId: string;
	/** 上传物 file_id（主跑批有；恢复命令无）。 */
	fileId?: string | null;
	/** 剪映草稿根目录（有则把草稿拷进去）。 */
	draftDir?: string;
	render?: boolean;
	crf?: string;
	codec?: string;
	ffmpegPath?: string;
	/** 成片命名 basis；缺省从 gtrk 素材名推、再退化 taskId。 */
	projName?: string;
	json?: boolean;
	open?: boolean;
	/** 可注入下载实现（测试用）；缺省真 download。 */
	download?: (url: string, dest: string) => Promise<void>;
}

export interface MaterializeResult {
	ok: boolean;
	outDir: string;
	files: Record<string, string[]>;
	jianyingDraftPath: string | null;
	rendered: string | null;
	report: unknown;
	errors: Record<string, string>;
	taskId: string;
	fileId: string | null;
}

const isExpired404 = (msg: string): boolean => /HTTP 404/.test(msg);

/** 从 gtrk materials[0].path 推毛片基名（供成片命名）。 */
function gtrkSourceName(gtrk: GtrkV1): string | undefined {
	const p = gtrk.materials?.[0]?.path;
	if (!p) return undefined;
	const b = basename(p);
	const dot = b.lastIndexOf(".");
	return dot > 0 ? b.slice(0, dot) : b;
}

export async function materializeResult(opts: MaterializeOpts): Promise<MaterializeResult> {
	const { outDir, output, taskId } = opts;
	const dl = opts.download ?? realDownload;
	const files = output.files ?? [];
	if (!files.length) throw new Error("任务无工程文件产物（检查 project_formats / 任务是否产出）");
	const errors: Record<string, string> = { ...(output.errors ?? {}) };

	// 结果清单：下载前先落盘基础版，报告即刻持久（扛住其后下载/渲染失败）；末尾再补写解析路径
	await mkdir(outDir, { recursive: true });
	const resultPath = join(outDir, "result.json");
	const writeResult = async (extra: Partial<MaterializeResult>): Promise<MaterializeResult> => {
		const r: MaterializeResult = {
			ok: Object.keys(errors).length === 0,
			outDir,
			files: {},
			jianyingDraftPath: null,
			rendered: null,
			report: output.report ?? null,
			errors,
			taskId,
			fileId: opts.fileId ?? null,
			...extra,
		};
		await writeFile(resultPath, JSON.stringify(r, null, 2));
		return r;
	};
	await writeResult({});

	// 拉回三方产物（按基础格式分组到 <out>/<格式>/）；下载 404=产物过期，记错不整体中止
	log.step("拉回产物到本地…");
	const byFormat: Record<string, string[]> = {};
	for (const f of files) {
		const base = baseFormat(f.format);
		const fmtDir = join(outDir, base);
		await mkdir(fmtDir, { recursive: true });
		const dest = join(fmtDir, f.filename);
		try {
			await dl(f.download_url, dest);
			(byFormat[base] ??= []).push(dest);
			log.info(`${FORMAT_META[base]?.label ?? f.format} ← ${f.filename}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			errors[`${f.format}:${f.filename}`] = msg;
			if (isExpired404(msg)) log.warn(`产物已过期（${f.filename}）：文件已被清理，报告仍可用`);
			else log.warn(`产物下载失败（${f.filename}）：${msg}`);
		}
	}

	// 剪映：把草稿拷进 <草稿目录>/<产物目录同名>/（尽力而为，失败记错不中止）
	let jianyingDraftPath: string | null = null;
	if (byFormat.jianying && opts.draftDir) {
		try {
			jianyingDraftPath = join(opts.draftDir, basename(outDir));
			await mkdir(jianyingDraftPath, { recursive: true });
			await cp(join(outDir, "jianying"), jianyingDraftPath, { recursive: true });
			log.info(`剪映草稿已落到：${jianyingDraftPath}`);
		} catch (e) {
			jianyingDraftPath = null;
			errors["jianying:draft"] = e instanceof Error ? e.message : String(e);
			log.warn(`剪映草稿落盘失败：${errors["jianying:draft"]}`);
		}
	}

	// 本地渲染成片（--render）：需 gtrk 已成功下载；gtrk 缺失（未选/已过期）则告警跳过、不阻断报告
	let rendered: string | null = null;
	if (opts.render) {
		const gtrkPath = (byFormat.gtrk ?? [])[0];
		if (!gtrkPath) {
			log.warn("已请求 --render，但无可用 gtrk 工程（未产出或已过期），跳过渲染；报告仍已落盘");
		} else {
			log.step("本地渲染成片（ffmpeg）…");
			const project = await readGtrkFile(gtrkPath);
			const name = opts.projName ?? gtrkSourceName(project) ?? taskId;
			const outMp4 = join(outDir, `${name}.mp4`);
			const r = await renderGtrk(project, outMp4, {
				crf: opts.crf != null ? Number(opts.crf) : undefined,
				codec: opts.codec,
				ffmpegPath: opts.ffmpegPath,
				onLine: (l) => {
					const m = l.match(/time=(\S+)/);
					if (m) log.tick(`渲染中 ${m[1]}`);
				},
			});
			log.tickEnd();
			rendered = r.outputPath;
			log.info(`成片：${rendered}（${r.duration.toFixed(1)}s）`);
		}
	}

	// result.json 补写解析出的本地路径
	const result = await writeResult({ files: byFormat, jianyingDraftPath, rendered });

	// 三方打开提示（人读；--json 跳过，避免污染 stdout 机读 JSON）
	if (!opts.json) {
		if (Object.keys(byFormat).length) log.step("三方打开（产物已就位，按需自取）：");
		for (const base of Object.keys(byFormat)) {
			const meta = FORMAT_META[base];
			const target =
				base === "jianying" ? (jianyingDraftPath ?? join(outDir, "jianying")) : byFormat[base][0];
			console.log(`   • ${meta?.label ?? base}：${meta?.openHint(target) ?? target}`);
		}
		if (rendered) console.log(`   • 成片 (mp4)：${rendered}`);
		console.log(`   • 结果清单：${resultPath}`);
	}
	if (opts.open) {
		openFolder(outDir);
		log.info("已打开产物目录文件夹");
	}
	if (opts.json) console.log(JSON.stringify(result));

	return result;
}
