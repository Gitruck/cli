/**
 * gtrk split —— 视觉拆分派单器（纯本地、同步、无云端任务）。
 *
 * 双模式（沿 oralcut-result D2 教训：顶层命令 + 可选 positional，避免父子命令吞选项）：
 *   - `gtrk split --project <dir>`            投影视图导出：transcript × 当刻 .gtrk → split/view.json（skill 的创作输入）
 *   - `gtrk split <拆分稿.json> --project <dir>` 校验落地：v1 门 → 校验链 → 现场投影 → 三件产物
 *       ① .gtrk 的 struct_meta.split 原子写回（只改该键、mtime 冲突拒写）
 *       ② split/dispatch.json 派单清单（composition_id = <工程slug>-<beatId>）
 *       ③ --md 时的 split/visual-split.md 人读稿（单向渲染）
 *
 * --json 沿 routeLogsToStderr 契约（stdout 只留一行结果 JSON）；任一校验/冲突失败非 0 退出且零副作用。
 * 时码恒挂源时基、每次发起现场投影；「拖入已剪好成片」= 恒等投影，同一套逻辑。
 */
import type { Command } from "commander";
import { resolve, join, dirname, basename } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { projectTranscript, type Transcript, type ProjectionView } from "../lib/projection";
import { validateSplitDoc, buildLanding, renderSplitMarkdown, type SplitDoc } from "../lib/splitdoc";
import { readGtrk, assertGtrkV1, writeStructMetaSplit } from "../lib/gtrk-writeback";
import { log, routeLogsToStderr } from "../lib/log";

interface SplitOpts {
	project?: string;
	gtrk?: string;
	transcript?: string;
	md?: boolean;
	words?: boolean;
	json?: boolean;
}

const TRANSCRIPT_MISSING =
	"工程目录内找不到 transcript.json（可能是旧任务产物）：请用新版本重跑 gtrk oralcut（恒出 transcript），" +
	"或（规划中）用 transcribe 生成后再拆分；本命令不做降级猜测。";

/** 注册顶层命令 `gtrk split [拆分稿]`。 */
export function registerSplit(program: Command): void {
	program
		.command("split [splitdoc]")
		.description("视觉拆分派单器：无 positional=导出投影视图；带拆分稿=校验落地（写回 struct_meta.split + dispatch）")
		.option("--project <dir>", "oralcut 产物目录（自动定位 gtrk/project.gtrk 与 transcript/transcript.json）")
		.option("--gtrk <path>", "显式指定 .gtrk 工程文件（非标准布局兜底）")
		.option("--transcript <path>", "显式指定 transcript.json（非标准布局兜底）")
		.option("--md", "落地时额外渲染人读稿 split/visual-split.md")
		.option("--words", "视图模式附字级明细（缺省只出句级）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (splitdoc: string | undefined, opts: SplitOpts) => {
			await runSplit(splitdoc, opts);
		});
}

/** 第一个存在的候选路径（都不存在返回 undefined）。 */
function firstExisting(cands: string[]): string | undefined {
	return cands.find((p) => existsSync(p));
}

/** 定位 .gtrk / transcript / 输出基目录。 */
function resolvePaths(opts: SplitOpts): { baseDir: string; gtrkPath: string; transcriptPath?: string } {
	const project = opts.project ? resolve(opts.project) : undefined;

	let gtrkPath: string;
	if (opts.gtrk) {
		gtrkPath = resolve(opts.gtrk);
	} else if (project) {
		gtrkPath = firstExisting([join(project, "gtrk", "project.gtrk"), join(project, "project.gtrk")]) ?? join(project, "gtrk", "project.gtrk");
	} else {
		throw new Error("需 --project <目录> 或显式 --gtrk <path>");
	}
	if (!existsSync(gtrkPath)) throw new Error(`找不到工程文件：${gtrkPath}`);

	let transcriptPath: string | undefined;
	if (opts.transcript) transcriptPath = resolve(opts.transcript);
	else if (project)
		transcriptPath = firstExisting([
			join(project, "transcript", "transcript.json"),
			join(project, "json", "transcript.json"),
			join(project, "transcript.json"),
		]);

	const baseDir = project ?? dirname(gtrkPath);
	return { baseDir, gtrkPath, transcriptPath };
}

/** 工程 slug：目录名归一（保留 CJK 字符，分隔符折叠为 -，去首尾 -）。 */
function slugify(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	return s || "project";
}

async function loadTranscript(path: string): Promise<Transcript> {
	const t = JSON.parse(await readFile(path, "utf8")) as Transcript;
	if (!t || !Array.isArray(t.utterances) || typeof t.material_id !== "string" || typeof t.text_hash !== "string") {
		throw new Error(`transcript.json 结构异常（缺 utterances/material_id/text_hash）：${path}`);
	}
	// 错版硬拒（split-doc-contract spec MUST）：以当前 transcript **内容** 重算 text_hash，覆盖存储的自述字段——
	// 防「篡改 utterance 文本却留旧 text_hash」漏过。须与 infra transcript_emit 逐字节一致：sha256(utterances[].text 以 \n 连接, UTF-8)。
	// 覆盖后，视图透传与落地比对都锚定内容而非字段自述（单点收敛）。
	t.text_hash = createHash("sha256")
		.update(t.utterances.map((u) => u.text ?? "").join("\n"), "utf8")
		.digest("hex");
	return t;
}

export interface SplitResult {
	ok: boolean;
	mode: "view" | "land";
	[k: string]: unknown;
}

/** 命令主逻辑（导出供测试）。校验/冲突失败抛错（index.ts 顶层捕获 → 非 0 退出），落地前零副作用。 */
export async function runSplit(splitdoc: string | undefined, opts: SplitOpts): Promise<SplitResult> {
	if (opts.json) routeLogsToStderr();
	const { baseDir, gtrkPath, transcriptPath } = resolvePaths(opts);
	return splitdoc
		? runLand(resolve(splitdoc), baseDir, gtrkPath, transcriptPath, opts)
		: runView(baseDir, gtrkPath, transcriptPath, opts);
}

async function runView(
	baseDir: string,
	gtrkPath: string,
	transcriptPath: string | undefined,
	opts: SplitOpts,
): Promise<SplitResult> {
	if (!transcriptPath || !existsSync(transcriptPath)) throw new Error(TRANSCRIPT_MISSING);
	log.step("▶ 导出投影视图（transcript × 当刻 .gtrk）…");
	const transcript = await loadTranscript(transcriptPath);
	const { gtrk } = readGtrk(gtrkPath);
	const view = projectTranscript(transcript, gtrk, { words: opts.words });

	const splitDir = join(baseDir, "split");
	await mkdir(splitDir, { recursive: true });
	const viewPath = join(splitDir, "view.json");
	await writeFile(viewPath, JSON.stringify(view, null, 2));

	const dropped = view.utterances.filter((u) => u.dropped).length;
	log.ok(`投影视图已生成：${viewPath}（${view.utterances.length} 条，其中 ${dropped} 条被剪）`);

	const result: SplitResult = {
		ok: true,
		mode: "view",
		viewPath,
		transcript_hash: view.transcript_hash,
		projected_at: view.projected_at,
		counts: { entries: view.utterances.length, dropped },
		view,
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

async function runLand(
	splitdocPath: string,
	baseDir: string,
	gtrkPath: string,
	transcriptPath: string | undefined,
	opts: SplitOpts,
): Promise<SplitResult> {
	if (!existsSync(splitdocPath)) throw new Error(`找不到拆分稿：${splitdocPath}`);
	if (!transcriptPath || !existsSync(transcriptPath)) throw new Error(TRANSCRIPT_MISSING);

	log.step("▶ 校验拆分稿并落地…");
	const doc = JSON.parse(await readFile(splitdocPath, "utf8")) as SplitDoc;
	const transcript = await loadTranscript(transcriptPath);

	// ① v1 门（读 .gtrk 并记录 mtime，供写回前冲突检测）
	const { gtrk, mtimeMs } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);

	// ② 校验链（结构/枚举 → id 合法 → hash 硬拒），失败零副作用
	const ctx = { utteranceIds: transcript.utterances.map((u) => u.id), transcriptHash: transcript.text_hash };
	const { errors, warnings } = validateSplitDoc(doc, ctx);
	for (const w of warnings) log.warn(w);
	if (errors.length) {
		throw new Error(
			`拆分稿校验失败（${errors.length} 条，未写入任何产物）：\n` + errors.map((e) => `  - ${e}`).join("\n"),
		);
	}

	// ③ 现场投影 + 落地计算（内存）
	const projectedAt = new Date().toISOString();
	const view: ProjectionView = projectTranscript(transcript, gtrk, { projectedAt });
	const projectSlug = slugify(basename(baseDir));
	const landing = buildLanding(doc, view, { utteranceIds: ctx.utteranceIds, projectSlug, projectedAt });

	// ④ 三件产物：struct_meta.split 原子写回（mtime 冲突拒写）→ dispatch.json → --md
	writeStructMetaSplit(gtrkPath, gtrk, landing.split, mtimeMs);
	const splitDir = join(baseDir, "split");
	await mkdir(splitDir, { recursive: true });
	const dispatchPath = join(splitDir, "dispatch.json");
	await writeFile(dispatchPath, JSON.stringify(landing.dispatch, null, 2));
	let mdPath: string | null = null;
	if (opts.md) {
		mdPath = join(splitDir, "visual-split.md");
		await writeFile(mdPath, renderSplitMarkdown(doc, landing, { projectSlug, projectedAt }));
	}

	// 摘要回报
	log.ok(
		`落地完成：${landing.split.beats.length}/${doc.beats.length} beat 落轨` +
			`（RRV_MG ${landing.dispatch.rrv_mg.length} · FILM_BROLL ${landing.dispatch.film_broll.length} · AI_DRAMA ${landing.dispatch.ai_drama.length}）`,
	);
	for (const s of landing.skipped) log.warn(`跳过 ${s.beat}：${s.reason}`);
	for (const s of landing.shrunk) log.warn(`收缩 ${s.beat}：${s.dropped} 句被剪，按存活 ${s.kept} 句包络 → ${s.track_st}s…${s.track_ed}s（建议人工复核）`);

	const result: SplitResult = {
		ok: true,
		mode: "land",
		gtrk: gtrkPath,
		dispatchPath,
		mdPath,
		transcript_hash: doc.transcript_hash,
		projected_at: projectedAt,
		beats: { total: doc.beats.length, landed: landing.split.beats.length, skipped: landing.skipped, shrunk: landing.shrunk },
		queues: {
			rrv_mg: landing.dispatch.rrv_mg.length,
			film_broll: landing.dispatch.film_broll.length,
			ai_drama: landing.dispatch.ai_drama.length,
		},
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}
