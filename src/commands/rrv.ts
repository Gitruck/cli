/**
 * gtrk rrv —— RRV_MG 颗粒生产铺轨（add-rrv-lay）。
 *
 * 脑手分工：real-roam-viz skill=脑（产 GSAP 颗粒 HTML），本命令=手（lint / 铺轨 / 看板）。
 * **不云渲、不下载 webm**——渲染是客户端出片期的事（客户端有内容 key 缓存）。
 *
 * 三模式（沿 matrix/split 的「顶层命令 + 可选 positional」范式）：
 *   gtrk rrv --project <dir>        消费 dispatch.rrv_mg → 定位颗粒 HTML → lint → 铺 html-particle 到 beat_track
 *   gtrk rrv lint <particle.html>   单文件纯本地静态 lint（六铁律静态子集）
 *   gtrk rrv status --project <dir> 编排看板（几 beat / 几已产 / 几已铺）
 */
import type { Command } from "commander";
import { resolve, join, dirname, basename } from "node:path";
import { existsSync } from "node:fs";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { readGtrk, assertGtrkV1, writeGtrkAtomic } from "../lib/gtrk-writeback";
import { lintParticle } from "../lib/rrv-lint";
import { layRrvTracks, type RrvLayItem, type StructMetaRrv } from "../lib/rrv-lay";
import type { Dispatch, RrvDispatch } from "../lib/splitdoc";
import { log, routeLogsToStderr } from "../lib/log";

const RRV_SRC_DIR = "rrv"; // <project>/rrv/<composition_id>.html （agent 产出源）
const RRV_ASSET_DIR = "assets/rrv"; // <gtrk-dir>/assets/rrv/<composition_id>.html （工程自包含落地）

interface RrvOpts {
	project?: string;
	dispatch?: string;
	only?: string;
	lintOnly?: boolean;
	json?: boolean;
}

export function registerRrv(program: Command): void {
	program
		.command("rrv [words...]")
		.description(
			"RRV_MG 颗粒铺轨：无 positional=消费 dispatch.rrv_mg 铺 html-particle；`rrv lint <file>`=单文件 lint；`rrv status`=看板",
		)
		.option("--project <dir>", "oralcut 产物目录（定位 split/dispatch.json 与工程）")
		.option("--dispatch <path>", "显式指定 dispatch.json（非标准布局兜底）")
		.option("--only <beat>", "只跑单 beat")
		.option("--lint-only", "只 lint 校验，不铺轨不写回")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[] | undefined, opts: RrvOpts) => {
			await runRrv(words ?? [], opts);
		});
}

/** 命令分派（导出供测试直调）：空=铺轨 / `lint <file>` / `status`。 */
export async function runRrv(words: string[], opts: RrvOpts): Promise<RrvResult> {
	if (opts.json) routeLogsToStderr();
	const sub = words[0];
	if (sub === "lint") return runLint(words.slice(1), opts);
	if (sub === "status") return runStatus(opts);
	if (sub) throw new Error(`未知子命令「${sub}」——铺轨：gtrk rrv --project <dir>；lint：gtrk rrv lint <file>；看板：gtrk rrv status`);
	return runLay(opts);
}

/** 定位 dispatch + baseDir（同 matrix）。 */
function resolveDispatch(opts: RrvOpts): { dispatchPath: string; baseDir: string } {
	if (opts.dispatch) {
		const dispatchPath = resolve(opts.dispatch);
		return { dispatchPath, baseDir: dirname(dirname(dispatchPath)) };
	}
	if (opts.project) {
		const baseDir = resolve(opts.project);
		return { dispatchPath: join(baseDir, "split", "dispatch.json"), baseDir };
	}
	throw new Error("需 --project <目录> 或显式 --dispatch <path>");
}

function locateGtrk(baseDir: string): string | undefined {
	return [join(baseDir, "gtrk", "project.gtrk"), join(baseDir, "project.gtrk")].find((p) => existsSync(p));
}

async function readRrvQueue(dispatchPath: string): Promise<RrvDispatch[]> {
	if (!existsSync(dispatchPath)) throw new Error(`找不到派单清单：${dispatchPath}（先跑 gtrk split 落地派单）`);
	const dispatch = JSON.parse(await readFile(dispatchPath, "utf8")) as Dispatch;
	return Array.isArray(dispatch.rrv_mg) ? dispatch.rrv_mg : [];
}

interface RrvResult {
	ok: boolean;
	mode: "lay" | "lint" | "status";
	[k: string]: unknown;
}

/** 铺轨模式。 */
async function runLay(opts: RrvOpts): Promise<RrvResult> {
	const { dispatchPath, baseDir } = resolveDispatch(opts);
	let queue = await readRrvQueue(dispatchPath);
	if (opts.only) queue = queue.filter((q) => q.beat === opts.only);
	log.step(`▶ RRV 颗粒铺轨：${queue.length} 个 beat…`);

	const dispatchIds = queue.map((q) => q.composition_id);
	const items: RrvLayItem[] = [];
	const srcByComp = new Map<string, string>(); // composition_id → 源 HTML 绝对路径（供复制）
	const skipped: { beat: string; reason: string }[] = [];

	for (const q of queue) {
		const srcPath = join(baseDir, RRV_SRC_DIR, `${q.composition_id}.html`);
		if (!existsSync(srcPath)) {
			skipped.push({ beat: q.beat, reason: "缺颗粒 HTML（未产出）" });
			log.warn(`${q.beat}：缺 ${srcPath}，跳过`);
			continue;
		}
		const html = await readFile(srcPath, "utf8");
		const category = typeof q.category === "string" ? q.category : undefined;
		const lint = lintParticle(html, { compositionId: q.composition_id, dispatchIds, category });
		for (const vv of lint.violations) (vv.fatal ? log.warn : log.info)(`${q.beat} lint ${vv.fatal ? "✗" : "·"} ${vv.law}: ${vv.msg}`);
		if (!lint.ok) {
			skipped.push({ beat: q.beat, reason: "lint 未过" });
			log.warn(`${q.beat}：lint 未过，跳过`);
			continue;
		}
		if (typeof q.duration !== "number" || !(q.duration > 0)) {
			skipped.push({ beat: q.beat, reason: "duration 非正数" });
			continue;
		}
		srcByComp.set(q.composition_id, srcPath);
		items.push({
			beat: q.beat,
			composition_id: q.composition_id,
			track_st: q.track_st,
			track_ed: q.track_ed,
			duration: q.duration,
			opaque: lint.opaque,
			html_rel: `${RRV_ASSET_DIR}/${q.composition_id}.html`,
			...(category ? { category } : {}),
		});
	}

	if (opts.lintOnly) {
		log.ok(`lint-only：${items.length}/${queue.length} 通过，${skipped.length} 跳过（不铺轨）`);
		return done(opts, { ok: skipped.length === 0, mode: "lay", lintOnly: true, passed: items.length, skipped });
	}

	// 工程缺失/非 v1 = 告警跳过（铺轨是增值不是门槛）
	const gtrkPath = locateGtrk(baseDir);
	if (!gtrkPath) {
		log.warn(`未找到工程文件（${join(baseDir, "gtrk", "project.gtrk")}），跳过铺轨——lint 已完成`);
		return done(opts, { ok: true, mode: "lay", laid: 0, skipped, note: "工程缺失，未铺轨" });
	}
	const { gtrk, mtimeMs } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);
	const gtrkDir = dirname(gtrkPath);

	// 复制颗粒 HTML 进工程 assets/rrv/（自包含）
	await mkdir(join(gtrkDir, ...RRV_ASSET_DIR.split("/")), { recursive: true });
	for (const it of items) {
		await copyFile(srcByComp.get(it.composition_id)!, join(gtrkDir, ...it.html_rel.split("/")));
	}

	const { next, summary } = layRrvTracks({ gtrk, items, generatedAt: new Date().toISOString() });
	writeGtrkAtomic(gtrkPath, next, mtimeMs);
	log.ok(
		`铺轨完成：${summary.laidParticles} 颗粒 → beat_track ${summary.laidTrack ?? "-"}` +
			`${skipped.length ? `（${skipped.length} beat 跳过）` : ""}`,
	);
	log.info("opencut 打开工程即见 RRV overlay 轨（预览需 add-particle-project-folder-preview 上线）；出片时客户端云渲。");
	return done(opts, {
		ok: true,
		mode: "lay",
		laid: summary.laidParticles,
		laidTrack: summary.laidTrack,
		skipped,
	});
}

/** 单文件 lint 模式。 */
async function runLint(args: string[], opts: RrvOpts): Promise<RrvResult> {
	const file = args[0];
	if (!file) throw new Error('用法：gtrk rrv lint <particle.html> [--dispatch <path>]');
	const html = await readFile(resolve(file), "utf8");
	let dispatchIds: string[] | undefined;
	if (opts.dispatch && existsSync(resolve(opts.dispatch))) {
		dispatchIds = (await readRrvQueue(resolve(opts.dispatch))).map((q) => q.composition_id);
	}
	const lint = lintParticle(html, { dispatchIds });
	for (const vv of lint.violations) (vv.fatal ? log.err : log.warn)(`${vv.fatal ? "✗" : "·"} ${vv.law}: ${vv.msg}`);
	if (lint.ok) log.ok(`lint 通过（${basename(file)}；opaque=${lint.opaque}）`);
	else log.err(`lint 未过（${lint.violations.filter((v) => v.fatal).length} 项致命）`);
	const result: RrvResult = { mode: "lint", ...lint, ok: lint.ok };
	if (opts.json) console.log(JSON.stringify(result));
	if (!lint.ok) process.exitCode = 1;
	return result;
}

/** 编排看板模式。 */
async function runStatus(opts: RrvOpts): Promise<RrvResult> {
	const { dispatchPath, baseDir } = resolveDispatch(opts);
	const queue = await readRrvQueue(dispatchPath);
	const gtrkPath = locateGtrk(baseDir);
	let laidIds = new Set<string>();
	if (gtrkPath) {
		const { gtrk } = readGtrk(gtrkPath);
		const rrv = (gtrk.struct_meta as { rrv?: StructMetaRrv } | undefined)?.rrv;
		laidIds = new Set((rrv?.beats ?? []).filter((b) => b.laid).map((b) => b.composition_id));
	}
	const rows = queue.map((q) => {
		const authored = existsSync(join(baseDir, RRV_SRC_DIR, `${q.composition_id}.html`));
		const laid = laidIds.has(q.composition_id);
		return { beat: q.beat, composition_id: q.composition_id, authored, laid, state: laid ? "已铺" : authored ? "已产未铺" : "缺 HTML" };
	});
	const authored = rows.filter((r) => r.authored).length;
	const laid = rows.filter((r) => r.laid).length;
	log.step(`▶ RRV 看板：${queue.length} beat · ${authored} 已产 · ${laid} 已铺`);
	for (const r of rows) log.info(`${r.beat}（${r.composition_id}）→ ${r.state}`);
	return done(opts, { ok: true, mode: "status", total: queue.length, authored, laid, rows });
}

function done(opts: RrvOpts, result: RrvResult): RrvResult {
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}
