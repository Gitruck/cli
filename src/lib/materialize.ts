/**
 * 三方产物落地共享逻辑：按 baseFormat 分组下载 + 剪映草稿拷贝 +（可选）本地渲染 + result.json 两段写 +
 * 人读打开提示 / --json 输出。供 `oralcut`（跑批 ⑤⑥⑦）与 `oralcut result`（按 task_id 恢复）复用。
 *
 * result.json 恒落盘（不受 --json 约束）：下载前先写一版基础清单（含 report/taskId），
 * 使报告能扛住其后的下载/渲染失败；下载渲染完成后再补写解析出的本地路径。
 * 下载遇 404（产物过期被 GC）不整体中止：记入 errors、仍完成报告落盘与输出。
 */
import { join, basename, dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { collectWriteViolations, type WriteViolation } from "./gtrk-invariants";
import { download as realDownload, type OralCutOutput } from "./cloud";
import { copyJianyingDraft } from "./jianying";
import { renderGtrk, readGtrkFile, type GtrkV1 } from "./render";
import type { SourceRateInfo } from "./media";
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
	/** 静默模式：跳过 stdout 输出（三方打开提示与 --json 结果行），由调用方自行汇总输出。
	 * 供多工程循环调用（long2short 逐 clip）——stdout 机读契约归根级调用方所有。 */
	quiet?: boolean;
	/** 可注入下载实现（测试用）；缺省真 download。 */
	download?: (url: string, dest: string) => Promise<void>;
	/**
	 * 云端产物落地复核（add-cross-clock-adapter D5，spec `clock-adapter`「云端产物落地 SHALL 复核不变量，只报告不改写」）：
	 * 以**本地原片实测时长**为墙（上传前 `probeGeometry` 的 `geo.duration`，`source_container` 钟）替换 gtrk 里同路径 material 的
	 * 自述时长，跑 `collectWriteViolations` 报告模式。给了才复核（跑批路）；恢复命令（`oralcut result`）无原片几何 ⇒ 缺席不复核。
	 */
	landingWall?: LandingWall;
	/**
	 * 源片帧率账面（add-frame-rate-table-vfr-detect D4）：上传前 `probeGeometry` 的 `r / avg / vfr` 三值，原样进 `--json source`
	 * 与 result.json（`vfr` 三态；VFR 的人读 WARN 已在上传前打过，这里只是机读对应物）。跑批路给；恢复命令无原片几何 ⇒ 缺席。
	 */
	source?: SourceRateInfo;
}

/** 落地复核之墙：`sourcePath` = 上传前的毛片绝对路径（云端把它原样写进 `materials[].path`），`durationSec` = 本地 ffprobe 实测。 */
export interface LandingWall {
	sourcePath: string;
	durationSec: number;
}

/** 落地复核报告（`--json landing_check` / result.json）：只报告，MUST NOT 改写产物、MUST NOT 非 0 退出。 */
export interface LandingCheck {
	gtrk: string;
	wall: { source_path: string; duration_sec: number; clock: "source_container" };
	/** 被本地实测时长替换了自述的 material 数（0 = 产物里没有同路径 material，此时按产物自述跑）。 */
	materials_walled: number;
	violations: WriteViolation[];
	/** 读不到 / 解析不了产物时的原因（此时 `violations` 为空，不代表合规）。 */
	error?: string;
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
	/** 仅给了 `landingWall` 且 gtrk 已落盘时出现。 */
	landing_check?: LandingCheck;
	/** 仅跑批路（给了 `source`）出现：源片 `fps / avg_fps / vfr`。 */
	source?: SourceRateInfo;
}

const isExpired404 = (msg: string): boolean => /HTTP 404/.test(msg);

const wallLabel = (w: LandingWall): string => `${basename(w.sourcePath)} ${w.durationSec.toFixed(3)}s · source_container`;

/** 路径同一性（Windows 反斜杠 / 大小写）：云端把 `source_path` 原样写回，这里只消反斜杠与 `/` 的差。 */
const normSlash = (p: string): string => p.split("\\").join("/").toLowerCase();
const samePath = (a: unknown, b: string): boolean => typeof a === "string" && normSlash(a) === normSlash(b);

/**
 * 落地复核（D5）：读产物 → 同路径 material 的 `duration` 换成本地实测 → `collectWriteViolations`（与写方自检**同一套断言、同一遍历**）。
 * 纯报告：产物文件一个字节不碰（改的是内存里的副本），任何异常都收进 `error` 而不是抛。
 */
export async function landingCheckGtrk(gtrkPath: string, wall: LandingWall): Promise<LandingCheck> {
	const report: LandingCheck = {
		gtrk: gtrkPath,
		wall: { source_path: wall.sourcePath, duration_sec: wall.durationSec, clock: "source_container" },
		materials_walled: 0,
		violations: [],
	};
	try {
		const gtrk = JSON.parse(await readFile(gtrkPath, "utf8")) as Record<string, unknown>;
		const materials = Array.isArray(gtrk.materials) ? (gtrk.materials as unknown[]) : [];
		const walled = materials.map((m) => {
			if (typeof m !== "object" || m === null || !samePath((m as { path?: unknown }).path, wall.sourcePath)) return m;
			report.materials_walled += 1;
			return { ...(m as Record<string, unknown>), duration: wall.durationSec };
		});
		report.violations = collectWriteViolations({ ...gtrk, materials: walled }, "landing");
	} catch (e) {
		report.error = e instanceof Error ? e.message : String(e);
	}
	return report;
}

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
			...(opts.source ? { source: opts.source } : {}),
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

	// 剪映：把草稿拷进 <草稿目录>/<产物目录同名>/（尽力而为，失败记错不中止）。
	// 文件名走命名律落地器：云端 oralcut 今日产的就是固定两件套名，此处逐字节 no-op——
	// 换的是防线，「带前缀名剪映扫不到」那枚 bug 不该有第二条实现路径（见 long2short ⑦）。
	let jianyingDraftPath: string | null = null;
	if (byFormat.jianying && opts.draftDir) {
		const dest = join(opts.draftDir, basename(outDir));
		try {
			const landing = await copyJianyingDraft(join(outDir, "jianying"), dest);
			if (landing.complete) {
				jianyingDraftPath = dest;
				log.info(`剪映草稿已落到：${dest}`);
			} else {
				errors["jianying:draft"] = `草稿两件套不全（缺 ${landing.missing.join("、")}），剪映列表里不会显示：${dest}`;
				log.warn(errors["jianying:draft"]);
			}
		} catch (e) {
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
				gtrkDir: dirname(gtrkPath),
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

	// 云端产物落地复核（D5）：gtrk 已落盘且给了墙才跑；WARN 逐条 + 机读 landing_check，产物逐字节不改、退出码不变
	let landing_check: LandingCheck | undefined;
	const landedGtrk = (byFormat.gtrk ?? [])[0];
	if (opts.landingWall && landedGtrk) {
		landing_check = await landingCheckGtrk(landedGtrk, opts.landingWall);
		if (landing_check.error) {
			log.warn(`落地复核未能进行（${basename(landedGtrk)}）：${landing_check.error}——产物已落盘、未改动`);
		} else if (landing_check.violations.length) {
			log.warn(
				`落地复核：云端工程 ${basename(landedGtrk)} 对本地原片实测时长（${wallLabel(opts.landingWall)}）有 ${landing_check.violations.length} 条不变量违例` +
					"（只报告、产物未改；客户端打开后重存或 `gtrk patch` 可修）：",
			);
			for (const v of landing_check.violations) log.warn(`  · [${v.kind}] ${v.message}`);
		} else {
			log.info(`落地复核：云端工程对本地原片实测时长（${wallLabel(opts.landingWall)}）零违例（${landing_check.materials_walled} 条 material 按实测复核）`);
		}
	}

	// result.json 补写解析出的本地路径
	const result = await writeResult({ files: byFormat, jianyingDraftPath, rendered, ...(landing_check ? { landing_check } : {}) });

	// 三方打开提示（人读；--json / quiet 跳过，避免污染 stdout 机读 JSON）
	if (!opts.json && !opts.quiet) {
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
	if (opts.json && !opts.quiet) console.log(JSON.stringify(result));

	return result;
}
