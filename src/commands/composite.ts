/**
 * gtrk composite —— 合成层（change add-composite-layer）：粗剪之上，把选定时间窗做成合成颗粒并铺进工程。
 *
 *   plan    三种入口产候选窗口，写 struct_meta.composite + composite/plan.md（客户端大纲 CP 行画提案块）
 *   review  审定写回（采纳 / 不要 / 调起止 / 补窗口）
 *   scaffold 为已采纳窗口落场景骨架
 *   build   场景 → 自包含颗粒 HTML（infra 规则解析 + profile 校验 + inputs_hash）
 *   lint    静态校验 + 逐帧排版机检（本机 Chrome / Edge），可出静帧
 *   lay     幂等铺进 beat_track 最上层，窗口记为 built
 *   shots   素材观察：联系表 + 镜头切点 + 黑边实测（给选片用，不替你选）
 *
 * 全部本地、零计费。规则在 lib/composite-*.ts（纯函数）；本文件只做定位、读写盘与回执。
 */
import type { Command } from "commander";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { assertGtrkV1, readGtrk } from "../lib/gtrk-writeback";
import { log, routeLogsToStderr } from "../lib/log";
import { packageRoot } from "../lib/paths";
import { transcriptCandidates } from "../lib/reproject";
import type { Transcript } from "../lib/projection";
import { evaluateComposite, type ResolveGtrk } from "../lib/composite-resolve";
import { buildParticle, CompositeSceneError, parseScene, type CompositeKit } from "../lib/composite-scene";

export interface CompositeOpts {
	project?: string;
	gtrk?: string;
	transcript?: string;
	scenes?: string;
	theme?: string;
	materials?: string;
	out?: string;
	only?: string;
	json?: boolean;
}

// ------------------------------------------------------------------ 定位与读盘

export interface CompositeContext {
	/** 工程目录（`--project`；只给 `--gtrk` 时取 .gtrk 所在目录的上一级）。 */
	projectDir: string;
	gtrkPath: string;
	gtrkDir: string;
	gtrk: Record<string, unknown>;
	revision: string;
	transcript: Transcript | null;
	transcriptPath: string | null;
}

export function loadCompositeContext(opts: CompositeOpts): CompositeContext {
	let gtrkPath: string;
	let projectDir: string;
	if (opts.gtrk) {
		gtrkPath = resolve(opts.gtrk);
		if (!existsSync(gtrkPath)) throw new Error(`工程文件不存在：${gtrkPath}`);
		projectDir = opts.project ? resolve(opts.project) : dirname(dirname(gtrkPath));
	} else {
		if (!opts.project) throw new Error("需 --project <工程目录>（自动定位 gtrk/project.gtrk）或 --gtrk <path>");
		projectDir = resolve(opts.project);
		const found = [join(projectDir, "gtrk", "project.gtrk"), join(projectDir, "project.gtrk")].find((p) => existsSync(p));
		if (!found) throw new Error(`未找到工程文件（${join(projectDir, "gtrk", "project.gtrk")}）`);
		gtrkPath = found;
	}
	const { gtrk, revision } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);
	const tPath = opts.transcript ? resolve(opts.transcript) : (transcriptCandidates(projectDir).find((p) => existsSync(p)) ?? null);
	let transcript: Transcript | null = null;
	if (tPath) {
		if (!existsSync(tPath)) throw new Error(`transcript 不存在：${tPath}`);
		transcript = JSON.parse(readFileSync(tPath, "utf8")) as Transcript;
	}
	return { projectDir, gtrkPath, gtrkDir: dirname(gtrkPath), gtrk, revision, transcript, transcriptPath: tPath };
}

/** 工具箱 + 风格（`--theme`，缺省 `<工程>/composite/theme.css`，没有就不加）。 */
export function loadKit(ctx: CompositeContext, themePath?: string): CompositeKit & { themePath: string | null } {
	const dir = join(packageRoot(), "assets", "composite-kit");
	const theme = themePath ? resolve(themePath) : join(ctx.projectDir, "composite", "theme.css");
	if (themePath && !existsSync(theme)) throw new Error(`风格文件不存在：${theme}`);
	const has = existsSync(theme);
	return {
		js: readFileSync(join(dir, "kit.js"), "utf8"),
		css: readFileSync(join(dir, "kit.css"), "utf8"),
		themeCss: has ? readFileSync(theme, "utf8") : "",
		themePath: has ? theme : null,
	};
}

/** 同批素材清单（铺轨时登记）：`--materials`，缺省 `<工程>/composite/materials.json`；条目至少要有 id 与 path。 */
export function loadExtraMaterials(ctx: CompositeContext, path?: string): Array<Record<string, unknown>> {
	const p = path ? resolve(path) : join(ctx.projectDir, "composite", "materials.json");
	if (path && !existsSync(p)) throw new Error(`素材清单不存在：${p}`);
	if (!existsSync(p)) return [];
	const list = JSON.parse(readFileSync(p, "utf8")) as unknown;
	if (!Array.isArray(list) || !list.every((m) => m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string")) {
		throw new Error(`素材清单应为 [{ id, path, … }] 数组：${p}`);
	}
	return list as Array<Record<string, unknown>>;
}

const onlyList = (s?: string): string[] => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

// ------------------------------------------------------------------ build

export interface BuildManifestEntry {
	id: string;
	/** 颗粒 HTML，相对 .gtrk 所在目录（铺轨时登记成素材 path）。 */
	html: string;
	window: [number, number];
	window_f: [number, number];
	anchors_f: Record<string, number>;
	texts: Record<string, Array<{ text: string; f0: number; f1: number }>>;
	bindings: Record<string, unknown>;
	inputs_hash: string;
	scene: string;
}

export interface BuildResult {
	ok: boolean;
	built: Array<{ id: string; html: string; window: [number, number]; state: string; slots: Record<string, string>; chars: number; window_shift_ms: [number, number] }>;
	failed: Array<{ id: string; scene: string; problems: string[] }>;
	manifest?: string;
	theme?: string | null;
}

export function runCompositeBuild(opts: CompositeOpts): BuildResult {
	if (opts.json) routeLogsToStderr();
	const ctx = loadCompositeContext(opts);
	const kit = loadKit(ctx, opts.theme);
	const extra = loadExtraMaterials(ctx, opts.materials);
	const extraIds = extra.map((m) => String(m.id));
	const scenesDir = opts.scenes ? resolve(opts.scenes) : join(ctx.projectDir, "composite", "scenes");
	if (!existsSync(scenesDir)) throw new Error(`场景目录不存在：${scenesDir}（先跑 gtrk composite scaffold，或用 --scenes 指定）`);
	const outDir = opts.out ? resolve(opts.out) : join(ctx.gtrkDir, "assets", "composite");
	mkdirSync(outDir, { recursive: true });
	const only = onlyList(opts.only);
	const files = readdirSync(scenesDir).filter((f) => f.endsWith(".html")).sort();
	const result: BuildResult = { ok: true, built: [], failed: [], theme: kit.themePath };
	const manifestPath = join(ctx.projectDir, "composite", "build.json");
	const manifest: BuildManifestEntry[] = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as BuildManifestEntry[]) : [];
	const gtrk = ctx.gtrk as unknown as ResolveGtrk & Record<string, unknown>;
	log.step(`① 构建合成颗粒（${files.length} 个场景${only.length ? `，只做 ${only.join(", ")}` : ""}）`);
	for (const f of files) {
		const scenePath = join(scenesDir, f);
		let id = basename(f, ".html");
		try {
			const scene = parseScene(readFileSync(scenePath, "utf8"), f);
			id = scene.spec.id || id;
			if (only.length && !only.some((o) => id.includes(o) || f.includes(o))) continue;
			const p = buildParticle(scene, gtrk as never, ctx.transcript, kit, { extraMaterialIds: extraIds });
			const htmlPath = join(outDir, `${p.id}.html`);
			writeFileSync(htmlPath, p.html, "utf8");
			const withExtra = { ...gtrk, materials: [...((gtrk.materials as unknown[]) ?? []), ...extraIds.map((m) => ({ id: m }))] } as ResolveGtrk;
			const ev = evaluateComposite(withExtra, p.beat, p.block);
			const rel = relative(ctx.gtrkDir, htmlPath).replace(/\\/g, "/");
			const res = p.block.resolved as { window: { track_st_f: number; track_ed_f: number }; anchors_f: Record<string, number>; bindings: Record<string, unknown> };
			const entry: BuildManifestEntry = {
				id: p.id,
				html: rel,
				window: [p.beat.track_st, p.beat.track_ed],
				window_f: [res.window.track_st_f, res.window.track_ed_f],
				anchors_f: res.anchors_f,
				texts: p.texts,
				bindings: res.bindings,
				inputs_hash: p.inputsHash,
				scene: relative(ctx.projectDir, scenePath).replace(/\\/g, "/"),
			};
			const at = manifest.findIndex((m) => m.id === p.id);
			if (at >= 0) manifest[at] = entry;
			else manifest.push(entry);
			result.built.push({ id: p.id, html: rel, window: entry.window, state: ev.state, slots: ev.slots, chars: p.html.length, window_shift_ms: p.windowShiftMs });
			const shift = p.windowShiftMs.some((x) => x !== 0) ? `（窗口吸附到帧格：${p.windowShiftMs.join(" / ")} ms）` : "";
			log.ok(`${p.id}  ${entry.window[0]}–${entry.window[1]}s  ${ev.state}  ${p.html.length} 字符${shift}`);
		} catch (e) {
			const problems = e instanceof CompositeSceneError ? e.problems : [(e as Error).message];
			result.failed.push({ id, scene: f, problems });
			result.ok = false;
			log.err(`${id}：\n   ${problems.join("\n   ")}`);
		}
	}
	manifest.sort((a, b) => a.window[0] - b.window[0]);
	mkdirSync(dirname(manifestPath), { recursive: true });
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	result.manifest = manifestPath;
	log.info(`构建清单：${manifestPath}（${manifest.length} 颗）`);
	if (opts.json) console.log(JSON.stringify(result));
	if (!result.ok) process.exitCode = 1;
	return result;
}

// ------------------------------------------------------------------ 注册

const USAGE =
	"用法：gtrk composite <plan|review|scaffold|build|lint|lay|shots> --project <工程目录> …（见 gtrk composite --help）";

export function registerComposite(program: Command): void {
	program
		.command("composite [words...]")
		.description(
			"合成层：粗剪之上把选定时间窗做成合成颗粒（画中画拼贴、逐句换画面、字幕排版）并铺进工程。plan 产候选（客户端大纲 CP 行显示）→ review 审定 → scaffold → build → lint → lay；纯本地零计费",
		)
		.option("--project <dir>", "工程目录（自动定位 gtrk/project.gtrk 与 transcript）")
		.option("--gtrk <path>", "直接指定 .gtrk 工程文件")
		.option("--transcript <path>", "显式指定 transcript.json（非标准布局兜底）")
		.option("--scenes <dir>", "[build] 场景目录（缺省 <工程>/composite/scenes）")
		.option("--theme <css>", "[build] 栏目 / 工程风格（缺省 <工程>/composite/theme.css，没有就用工具箱中性样式）")
		.option("--materials <json>", "[build|lay] 同批素材清单（缺省 <工程>/composite/materials.json）：own 槽位用到、工程里还没登记的素材")
		.option("--out <dir>", "[build] 颗粒输出目录（缺省 <.gtrk 所在目录>/assets/composite）")
		.option("--only <ids>", "只处理这些颗粒 / 窗口（逗号分隔，按 id 片段匹配）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[], opts: CompositeOpts) => {
			const sub = (words ?? [])[0];
			if (sub === "build") return void runCompositeBuild(opts);
			throw new Error(USAGE);
		});
}
