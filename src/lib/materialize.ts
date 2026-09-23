/**
 * 三方产物落地共享逻辑：按 baseFormat 分组下载 + 剪映草稿拷贝 +（可选）本地渲染 + result.json 两段写 +
 * 人读打开提示 / --json 输出。供 `oralcut`（跑批 ⑤⑥⑦）与 `oralcut result`（按 task_id 恢复）复用。
 *
 * result.json 恒落盘（不受 --json 约束）：下载前先写一版基础清单（含 report/taskId），
 * 使报告能扛住其后的下载/渲染失败；下载渲染完成后再补写解析出的本地路径。
 * 下载遇 404（产物过期被 GC）不整体中止：记入 errors、仍完成报告落盘与输出。
 */
import { join, basename, dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { collectWriteViolations, type WriteViolation } from "./gtrk-invariants";
import { download as realDownload, type OralCutOutput } from "./cloud";
import { copyJianyingDraft } from "./jianying";
import { renderGtrk, readGtrkFile, type GtrkV1 } from "./render";
import { prepareParticlesForRender } from "./particle-qtrle";
import type { SourceRateInfo } from "./media";
import { openFolder } from "./open";
import { log } from "./log";
import { ensureLandingWritable, type LandingWaitDeps } from "./landing-wait";
import { readJson } from "./read-json";

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
	/**
	 * Gate B（落点闸的兜底面，add-artifact-landing-gate §4.4a）。
	 * `materializeResult` 是 `gtrk oralcut` 与 `gtrk oralcut-result` **共用的**唯一落地入口，
	 * 故两条命令的 Gate B MUST 经由这里的同一个等待器，MUST NOT 各自实现。
	 * ⚠️ 不注入**不等于**放行：缺等待器时按非交互形态硬失败（更严，不是旁路）——
	 * 本地写入失败在任何情况下都 MUST NOT 退化成 `log.warn` + 继续 + 退出码 0。
	 */
	landingWait?: Partial<LandingWaitDeps>;
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
	/**
	 * 存在**未消解的本地写入失败**时为 true（机读位，供调用方置非零退出码）。
	 * 与 `ok` 正交且不改 `ok` 的语义（`errors` 非空即 false，逐字不动）：
	 * 它回答的是「这次失败是本地还是云端」——云端 404 过期 MUST NOT 置本位。
	 */
	localWriteFailed?: true;
}

const isExpired404 = (msg: string): boolean => /HTTP 404/.test(msg);

/** 本地写入失败 errno（与 `outdir-guard.LOCAL_WRITE_ERRNOS` 同表）。 */
const LOCAL_WRITE_ERRNOS = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC", "ENAMETOOLONG"]);

/**
 * 本地写入失败判据（4.1）。今日 `EACCES` 与网络 404 共用一条 catch，`isExpired404` 不命中
 * 就一律报「产物下载失败」——用户照着网络问题排查，永远修不好一个权限问题。
 * 判 `e.code` 而非文案：文案会随 Node / 上游库版本漂移。
 */
function isLocalWriteError(e: unknown): boolean {
	const code = (e as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" && LOCAL_WRITE_ERRNOS.has(code);
}

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
		const gtrk = await readJson(gtrkPath, ".gtrk 工程") as Record<string, unknown>;
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

	// ══ Gate B（add-artifact-landing-gate §4.4a）══
	// 本地写入失败 ⇒ 阻塞重探到可写为止，然后**只重跑这一段**（下载/拷贝），
	// MUST NOT 重新提交任务、MUST NOT 二次计费。非交互当场硬失败。
	// 未消解则置 localWriteFailed，由调用方转非零退出码——MUST NOT 退化成 warn + 继续 + 退 0。
	let localWriteFailed = false;
	const gateB = async (target: string, label: string): Promise<boolean> => {
		try {
			await ensureLandingWritable(target, label, {
				json: opts.json,
				deps: opts.landingWait,
				recoveryHint: `修好后可用：gtrk oralcut-result ${taskId} --out <目录>（按 task_id 取回，不重跑、不二次计费）`,
			});
			return true;
		} catch {
			localWriteFailed = true;
			return false;
		}
	};

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
			// ── 本地写入失败：与云端失败分开呈现，MUST NOT 报成「产物下载失败」 ──
			if (isLocalWriteError(e)) {
				log.warn(`本地写入失败（${f.filename}）：写不进 ${fmtDir} —— ${msg}`);
				if (await gateB(fmtDir, "产物目录")) {
					try {
						await dl(f.download_url, dest); // 只重跑这一段
						(byFormat[base] ??= []).push(dest);
						log.info(`${FORMAT_META[base]?.label ?? f.format} ← ${f.filename}（重试成功）`);
						continue;
					} catch (e2) {
						const m2 = e2 instanceof Error ? e2.message : String(e2);
						// ⚠️ 重试是**完整重新拉网**（→ cloud.ts 的 fetch + writeFile），第二次的失败
						// 完全可能是网络/过期而不是权限。用 e2 自己的来源判据分流，
						// MUST NOT 一律贴「本地写入失败」——那和改前把权限问题谎报成网络问题是同一种病，
						// 只是方向反了（2026-09-08 审计订正）。
						const localAgain = isLocalWriteError(e2);
						errors[`${f.format}:${f.filename}`] = localAgain
							? `本地写入失败（重试后仍失败）：${fmtDir} —— ${m2}`
							: isExpired404(m2)
								? `产物已过期（重试时）：${f.filename} 已被清理 —— ${m2}`
								: `产物下载失败（重试时）：${m2}`;
						if (localAgain) localWriteFailed = true;
						log.warn(errors[`${f.format}:${f.filename}`]);
						continue;
					}
				}
				errors[`${f.format}:${f.filename}`] = `本地写入失败：${fmtDir} —— ${msg}`;
				continue;
			}
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
			const msg = e instanceof Error ? e.message : String(e);
			// 本地写入失败与「两件套不全」是两回事：后者的记 errors 与告警义务归
			// `jianying-draft-landing` 管辖（上面那支，逐字不动），此处只分类本地写失败。
			if (isLocalWriteError(e)) {
				log.warn(`本地写入失败：剪映草稿写不进 ${dest} —— ${msg}`);
				if (await gateB(opts.draftDir, "剪映草稿根")) {
					try {
						const again = await copyJianyingDraft(join(outDir, "jianying"), dest);
						if (again.complete) {
							jianyingDraftPath = dest;
							log.info(`剪映草稿已落到：${dest}（重试成功）`);
						} else {
							errors["jianying:draft"] = `草稿两件套不全（缺 ${again.missing.join("、")}），剪映列表里不会显示：${dest}`;
							log.warn(errors["jianying:draft"]);
						}
					} catch (e2) {
						const m2 = e2 instanceof Error ? e2.message : String(e2);
						// 同上：第二次失败按 e2 自己的来源分流，MUST NOT 一律贴「本地写入失败」。
						const localAgain = isLocalWriteError(e2);
						errors["jianying:draft"] = localAgain
							? `本地写入失败（重试后仍失败）：${dest} —— ${m2}`
							: `剪映草稿落盘失败（重试时）：${m2}`;
						if (localAgain) localWriteFailed = true;
						log.warn(errors["jianying:draft"]);
					}
				} else {
					errors["jianying:draft"] = `本地写入失败：${dest} —— ${msg}`;
				}
			} else {
				errors["jianying:draft"] = msg;
				log.warn(`剪映草稿落盘失败：${errors["jianying:draft"]}`);
			}
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
			// ★ add-render-overlay-compositing：与 `gtrk render` **共用同一条**颗粒编排（含计费闸），
			// MUST NOT 分叉出第二套。本路径是**起盘态**落地（oralcut / long2short 刚出的工程），
			// 结构上还没有 `beat_track` ⇒ 实际是零动作、零计费；此处接线是为了将来精修态复用
			// 这条落地入口时不至于静默丢颗粒。`--json` 透传保证机读模式下缺 `--yes` 是硬拒而非挂起。
			const particles = await prepareParticlesForRender(project, dirname(gtrkPath), {
				...(opts.json ? { json: true } : {}),
			});
			const r = await renderGtrk(project, outMp4, {
				crf: opts.crf != null ? Number(opts.crf) : undefined,
				codec: opts.codec,
				ffmpegPath: opts.ffmpegPath,
				gtrkDir: dirname(gtrkPath),
				particlePaths: particles.paths,
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
	const result = await writeResult({
		files: byFormat,
		jianyingDraftPath,
		rendered,
		...(landing_check ? { landing_check } : {}),
		// 未消解的本地写入失败：机读位，调用方据此置非零退出码。
		// 云端 404 过期 MUST NOT 置本位（过期时仍能取回报告，是本命令的主要价值）。
		...(localWriteFailed ? { localWriteFailed: true as const } : {}),
	});

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
