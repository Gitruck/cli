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
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { requireFfmpeg } from "../lib/ffmpeg";
import { probeGeometry } from "../lib/media";
import { assertGtrkV1, readGtrk, writeStructMetaKey } from "../lib/gtrk-writeback";
import { log, routeLogsToStderr } from "../lib/log";
import { packageRoot } from "../lib/paths";
import { transcriptCandidates } from "../lib/reproject";
import { collectProjectionClips, projectTranscript, type GtrkProject, type Transcript } from "../lib/projection";
import { evaluateComposite, type ResolveGtrk } from "../lib/composite-resolve";
import { buildParticle, COMPOSITE_PRODUCER, CompositeSceneError, parseScene, type CompositeKit } from "../lib/composite-scene";
import { contactSheetArgs, cropDetectArgs, parseCropDetect, parseSceneCuts, sceneCutArgs, shotsRange } from "../lib/composite-shots";
import {
	COMPOSITE_DENSITY_DEFAULT,
	parseRange,
	planAuto,
	planFull,
	planRanges,
	renderPlanMd,
	reviewPlan,
	type CompositePlanMeta,
	type PlanInput,
	type PlanMode,
	type PlanUtterance,
	type PlanWindow,
	type ReviewOps,
} from "../lib/composite-plan";

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

// ------------------------------------------------------------------ plan / review / scaffold

/** 由工程与转写算出规划输入（句投影、片尾、B-roll 起点、不透明颗粒、拆分 beat、已有候选）。 */
export function planInputOf(ctx: CompositeContext, now = new Date().toISOString()): PlanInput {
	if (!ctx.transcript) throw new Error("找不到 transcript.json：合成层按句定窗口，需要口播转写（用新版本 gtrk oralcut 跑出的工程恒带它；也可 --transcript 指定）");
	const t = ctx.transcript;
	const g = ctx.gtrk as unknown as GtrkProject & { video_rate: number; beat_track?: Array<{ track_timeline?: Array<Record<string, unknown>> }> };
	const view = projectTranscript(t, g);
	const src = new Map(t.utterances.map((u) => [u.id, u]));
	const seen = new Set<string>();
	const utterances: PlanUtterance[] = [];
	for (const u of [...view.utterances].filter((x) => !x.dropped).sort((a, b) => (a.track_st ?? 0) - (b.track_st ?? 0))) {
		if (seen.has(u.id)) continue;
		seen.add(u.id);
		const s = src.get(u.id);
		utterances.push({ id: u.id, text: u.text, st: u.track_st as number, ed: u.track_ed as number, src_st: s?.st ?? 0, src_ed: s?.ed ?? 0 });
	}
	const main = collectProjectionClips(g, String(t.material_id));
	const end = Math.max(0, ...main.clips.map((c) => Number(c.track_ed ?? Number(c.track_st ?? 0) + Number(c.duration ?? 0))));
	const brollStarts = (g.video_track ?? [])
		.filter((tr) => tr.track_index !== main.track_index || main.source !== "video")
		.map((tr) => (tr.track_timeline ?? []).filter((c) => c.material != null && !String(c.material).startsWith("ex-solid-")).map((c) => Number(c.track_st ?? 0)))
		.filter((xs) => xs.length);
	const opaqueParticles: PlanInput["opaqueParticles"] = [];
	for (const tr of g.beat_track ?? []) {
		for (const c of tr.track_timeline ?? []) {
			const isComposite = String(c.html_material ?? "").startsWith("composite-") || (c.producer as { by?: string } | undefined)?.by === COMPOSITE_PRODUCER;
			if (c.opaque === true && !isComposite) opaqueParticles.push({ id: String(c.clip_id ?? ""), st: Number(c.track_st), ed: Number(c.track_ed) });
		}
	}
	const sm = (ctx.gtrk.struct_meta ?? {}) as Record<string, unknown>;
	const split = sm.split as { beats?: Array<{ id?: string; span?: { from?: string; to?: string } }> } | undefined;
	const splitBeats = (split?.beats ?? [])
		.filter((b) => b.span?.from && b.span?.to)
		.map((b) => ({ id: String(b.id ?? ""), from: String(b.span?.from), to: String(b.span?.to) }));
	const existing = (sm.composite as CompositePlanMeta | undefined) ?? null;
	return {
		rate: Number(g.video_rate),
		utterances,
		end,
		brollStarts,
		opaqueParticles,
		splitBeats,
		allIds: t.utterances.map((u) => u.id),
		existing: existing && Array.isArray(existing.windows) ? existing : null,
		transcriptHash: String(t.text_hash ?? ""),
		materialId: String(t.material_id ?? ""),
		now,
	};
}

function writePlan(ctx: CompositeContext, plan: CompositePlanMeta, inp: PlanInput, operation: string): { revision: string; md: string } {
	const revision = writeStructMetaKey(ctx.gtrkPath, ctx.gtrk, "composite", plan, ctx.revision, operation);
	const md = join(ctx.projectDir, "composite", "plan.md");
	mkdirSync(dirname(md), { recursive: true });
	writeFileSync(md, renderPlanMd(plan, inp), "utf8");
	return { revision, md };
}

const countStates = (plan: CompositePlanMeta) => {
	const out: Record<string, number> = {};
	for (const w of plan.windows) out[w.state] = (out[w.state] ?? 0) + 1;
	return out;
};

const windowSummary = (w: PlanWindow) => ({ id: w.id, state: w.state, track_st: w.track_st, track_ed: w.track_ed, reason: w.reason, layout_hint: w.layout_hint?.pictures });

export interface PlanCmdOpts extends CompositeOpts {
	mode?: string;
	range?: string[];
	density?: string;
}

export function runCompositePlan(opts: PlanCmdOpts) {
	if (opts.json) routeLogsToStderr();
	const ctx = loadCompositeContext(opts);
	const inp = planInputOf(ctx);
	const mode = (opts.mode ?? (opts.range?.length ? "ranges" : "auto")) as PlanMode;
	if (!["full", "auto", "ranges"].includes(mode)) throw new Error(`--mode 取值 full|auto|ranges，拿到「${mode}」`);
	let plan: CompositePlanMeta;
	let shifts: Array<{ raw: string; id: string; shiftMs: [number, number] }> = [];
	if (mode === "full") plan = planFull(inp);
	else if (mode === "auto") {
		const density = opts.density === undefined ? COMPOSITE_DENSITY_DEFAULT : Number(opts.density);
		if (!(density > 0 && density <= 1)) throw new Error(`--density 取 (0, 1]，拿到「${opts.density}」`);
		plan = planAuto(inp, density);
	} else {
		if (!opts.range?.length) throw new Error("ranges 模式需要至少一个 --range（如 --range 11.2,32 或 --range u0004-u0009）");
		const r = planRanges(inp, opts.range.map(parseRange));
		plan = r.plan;
		shifts = r.shifts;
	}
	const { revision, md } = writePlan(ctx, plan, inp, "composite plan");
	const counts = countStates(plan);
	log.step(`① 合成层候选（${mode}）：${plan.windows.length} 个窗口 ${JSON.stringify(counts)}`);
	for (const w of plan.windows.filter((x) => x.state !== "trimmed")) log.info(`${w.id} ${w.track_st}–${w.track_ed}s  ${w.state}  ${w.reason}`);
	for (const s of shifts) if (s.shiftMs[0] || s.shiftMs[1]) log.info(`${s.raw} → ${s.id}：起点挪 ${s.shiftMs[0]} ms、终点挪 ${s.shiftMs[1]} ms（吸附到句界与帧格）`);
	log.ok(`已写回 struct_meta.composite（客户端外部重载后大纲 CP 行显示提案块）；审稿稿 ${md}`);
	const result = { ok: true, mode, counts, windows: plan.windows.map(windowSummary), shifts, plan_md: md, revision };
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

export interface ReviewCmdOpts extends CompositeOpts {
	approve?: string[];
	reject?: string[];
	approveAll?: boolean;
	adjust?: string[];
	add?: string[];
}

const idList = (xs?: string[]) => (xs ?? []).flatMap((x) => x.split(",")).map((x) => x.trim().toUpperCase()).filter(Boolean);

export function runCompositeReview(opts: ReviewCmdOpts) {
	if (opts.json) routeLogsToStderr();
	const ctx = loadCompositeContext(opts);
	const inp = planInputOf(ctx);
	const plan = inp.existing;
	if (!plan) throw new Error("工程里还没有 struct_meta.composite：先跑 gtrk composite plan");
	const ops: ReviewOps = { approve: idList(opts.approve), reject: idList(opts.reject), approveAll: Boolean(opts.approveAll), adjust: opts.adjust ?? [], add: opts.add ?? [] };
	if (!ops.approve?.length && !ops.reject?.length && !ops.approveAll && !ops.adjust?.length && !ops.add?.length) {
		throw new Error("review 需要 --approve / --reject / --approve-all / --adjust / --add 至少一个");
	}
	const r = reviewPlan(inp, plan, ops);
	const { revision, md } = writePlan(ctx, r.plan, inp, "composite review");
	for (const c of r.changes) log.info(`${c.id} ${c.action}${c.from ? `（原 ${c.from}）` : ""}${c.shiftMs && (c.shiftMs[0] || c.shiftMs[1]) ? `  吸附 ${c.shiftMs.join(" / ")} ms` : ""}`);
	log.ok(`已写回 struct_meta.composite：${JSON.stringify(countStates(r.plan))}`);
	const result = { ok: true, changes: r.changes, counts: countStates(r.plan), windows: r.plan.windows.map(windowSummary), plan_md: md, revision };
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

export interface ScaffoldCmdOpts extends CompositeOpts {
	force?: boolean;
}

/** 窗口 → 合成颗粒 id（同一工程内唯一、ASCII）。 */
export const compositionIdOf = (windowId: string) => `cp-${windowId.toLowerCase()}`;

function scaffoldScene(id: string, w: PlanWindow, presenterTrack: number | null): string {
	const slots: Record<string, unknown> = {};
	if (presenterTrack !== null) slots.presenter = { bind: { kind: "ref-lane", role: "a-roll" }, label: "讲者", pin: { track: presenterTrack } };
	slots.subs = { bind: { kind: "text", source: "subtitles" }, label: "字幕" };
	const spec = { id, window: [w.track_st, w.track_ed], takeover: ["subtitles", "overlay"], slots, anchors: {} };
	const presenter =
		presenterTrack === null
			? ""
			: `<div class="shadow round" data-for="presenter"></div>
<div data-slot="presenter" data-z="10" data-fit="cover" data-shape="circle"></div>
<div class="ring" data-for="presenter" data-pad="4" data-layer="front"></div>
`;
	return `<script type="application/x-cp-spec">
${JSON.stringify(spec, null, 2)}
</script>
<style>
  /* 这颗的版式。配色、字体走工具箱变量（--bg / --ink / --accent …），栏目风格在 composite/theme.css */
</style>
<div class="bed"></div>
${presenter}<div id="cap" class="cap" data-layer="front"></div>
<script>
// 先读同名 .context.md（这段在说什么、窗口内有哪些片段与素材、编排规则），写好设计说明再改这里。
const { A, prog, at, reveal, caption, ease } = CP;
CP.render = (t) => {
${presenterTrack === null ? "" : "  at(\"presenter\", [840, 300, 240, 240], prog(t, 0, 0.5, ease.back));\n"}  caption("cap", "subs", t, []);
};
</script>
`;
}

function scaffoldContext(ctx: CompositeContext, inp: PlanInput, w: PlanWindow, id: string): string {
	const g = ctx.gtrk as unknown as GtrkProject & { materials?: Array<Record<string, unknown>> };
	const U = inp.utterances.filter((u) => u.ed > w.track_st && u.st < w.track_ed);
	const lines = [
		`# ${id}（窗口 ${w.id}）`,
		"",
		`- 起止：${w.track_st}–${w.track_ed} 秒（${(w.track_ed - w.track_st).toFixed(2)} 秒）`,
		`- 为什么选这里：${w.reason}`,
		w.layout_hint ? `- 建议：${w.layout_hint.pictures}——${w.layout_hint.why}` : "",
		"",
		"## 这段在说什么（时间线秒）",
		"",
		...U.map((u) => `- \`${u.id}\` ${u.st.toFixed(3)}–${u.ed.toFixed(3)}  ${u.text}`),
		"",
		"锚点写法：`\"anchors\": { \"名字\": [\"句 id\", \"关键词\", 第几处(0 起，可省)] }`，场景里用 `A(\"名字\")` 取局部秒。",
		"",
		"## 窗口内各轨片段",
		"",
	];
	for (const tr of g.video_track ?? []) {
		const cs = (tr.track_timeline ?? []).filter((c) => c.material != null && Number(c.track_st) < w.track_ed && Number(c.track_ed) > w.track_st);
		if (!cs.length) continue;
		lines.push(`- 轨 ${tr.track_index}：`);
		for (const c of cs) lines.push(`  - \`${c.clip_id}\` 素材 \`${c.material}\` 时间线 ${c.track_st}–${c.track_ed}，源 ${c.clip_st ?? 0}–${c.clip_ed ?? ""}`);
	}
	lines.push(
		"",
		"## 已登记的视频 / 图片素材（own 槽位可用；选片先跑 gtrk composite shots 看联系表与切点）",
		"",
		...(g.materials ?? [])
			.filter((m) => typeof m.path === "string" && /\.(mp4|mov|mkv|webm|m4v|jpg|jpeg|png|webp)$/i.test(String(m.path)))
			.map((m) => `- \`${m.id}\` ${m.path}${m.duration ? `（${m.duration} 秒）` : ""}`),
		"",
		"## 编排规则（详见 /gtrk-composite）",
		"",
		"1. 画面数由内容定：说到什么换成什么；只有关系 / 对照 / 并列才同时放多画；不照搬粗剪的轨数。",
		"2. 任一时刻画面互不重叠；同一位置交替时等前一张的框到位再换；讲者不同时出现两次。",
		"3. 裁掉信箱黑边与烧录字幕（data-crop 上右下左，按 shots 实测取值）。",
		"4. 人脸：眼睛落上三分线、头顶留约一成余量。",
		"5. own 的取用段落在单个镜头内，不跨切点。",
		"6. 没有具体可看的，让讲者占画框或纯排版。",
		"",
	);
	return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

export function runCompositeScaffold(opts: ScaffoldCmdOpts) {
	if (opts.json) routeLogsToStderr();
	const ctx = loadCompositeContext(opts);
	const inp = planInputOf(ctx);
	const plan = inp.existing;
	if (!plan) throw new Error("工程里还没有 struct_meta.composite：先跑 gtrk composite plan，再 review 采纳窗口");
	const only = onlyList(opts.only).map((x) => x.toUpperCase());
	const targets = plan.windows.filter((w) => w.state === "approved" && (!only.length || only.includes(w.id)));
	if (!targets.length) throw new Error("没有已采纳（approved）的窗口：先用 gtrk composite review --approve 采纳");
	const dir = opts.scenes ? resolve(opts.scenes) : join(ctx.projectDir, "composite", "scenes");
	mkdirSync(dir, { recursive: true });
	const main = collectProjectionClips(ctx.gtrk as unknown as GtrkProject, String(ctx.transcript?.material_id ?? ""));
	const presenterTrack = main.source === "video" ? main.track_index : null;
	const written: string[] = [];
	const kept: string[] = [];
	for (const w of targets) {
		const id = compositionIdOf(w.id);
		const scene = join(dir, `${id}.html`);
		writeFileSync(join(dir, `${id}.context.md`), scaffoldContext(ctx, inp, w, id), "utf8");
		if (existsSync(scene) && !opts.force) {
			kept.push(scene);
			log.info(`${id}：场景已存在，保留（--force 覆盖）；上下文已刷新`);
			continue;
		}
		writeFileSync(scene, scaffoldScene(id, w, presenterTrack), "utf8");
		written.push(scene);
		log.ok(`${id}：${scene}`);
	}
	const result = { ok: true, scenes_dir: dir, written, kept };
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

// ------------------------------------------------------------------ shots

export interface ShotsCmdOpts extends CompositeOpts {
	material?: string;
	from?: string;
	to?: string;
	around?: string;
	span?: string;
	every?: string;
	ffmpegPath?: string;
}

/** 素材 id（工程素材表）或文件路径 → 绝对路径。 */
function materialFile(ctx: CompositeContext | null, ref: string): { path: string; id: string | null } {
	if (ctx) {
		const m = ((ctx.gtrk.materials as Array<Record<string, unknown>>) ?? []).find((x) => x.id === ref);
		if (m && typeof m.path === "string") {
			const p = isAbsolute(m.path) ? m.path : resolve(ctx.gtrkDir, m.path);
			if (!existsSync(p)) throw new Error(`素材 ${ref} 的文件不在盘上：${p}`);
			return { path: p, id: ref };
		}
	}
	const p = resolve(ref);
	if (!existsSync(p)) throw new Error(`找不到素材「${ref}」：既不是工程素材表里的 id，也不是存在的文件`);
	return { path: p, id: null };
}

const ffStderr = (ffmpeg: string, args: string[]) => {
	const r = spawnSync(ffmpeg, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`ffmpeg 失败（code=${r.status}）：${(r.stderr || "").slice(-400)}`);
	return r.stderr || "";
};

export function runCompositeShots(opts: ShotsCmdOpts) {
	if (opts.json) routeLogsToStderr();
	if (!opts.material) throw new Error("需 --material <素材 id 或文件路径>");
	const num = (v: string | undefined, name: string) => {
		if (v === undefined) return undefined;
		const n = Number(v);
		if (!Number.isFinite(n)) throw new Error(`${name} 需要数字，拿到「${v}」`);
		return n;
	};
	const ctx = opts.project || opts.gtrk ? loadCompositeContext(opts) : null;
	const { path, id } = materialFile(ctx, opts.material);
	const ff = requireFfmpeg(opts.ffmpegPath);
	const geo = probeGeometry(path, opts.ffmpegPath);
	const duration = geo.duration;
	const range = shotsRange(duration, { from: num(opts.from, "--from"), to: num(opts.to, "--to"), around: num(opts.around, "--around"), span: num(opts.span, "--span") });
	const dur = Math.round((range.to - range.from) * 1000) / 1000;
	const every = num(opts.every, "--every") ?? Math.max(0.5, Math.round((dur / 60) * 10) / 10);
	const outDir = opts.out ? resolve(opts.out) : join(ctx ? ctx.projectDir : dirname(path), "composite", "shots");
	mkdirSync(outDir, { recursive: true });
	const stem = `${(id ?? basename(path).replace(/\.[^.]+$/, "")).replace(/[^\w.-]+/g, "_")}-${range.from.toFixed(1)}-${range.to.toFixed(1)}`;
	log.step(`① 观察 ${basename(path)} ${range.from.toFixed(2)}–${range.to.toFixed(2)} 秒${range.clipped ? "（素材太长，只看前 10 分钟；用 --from/--to 或 --around 指定）" : ""}`);
	const cuts = parseSceneCuts(ffStderr(ff.ffmpeg, sceneCutArgs(path, range.from, dur)), range.from);
	const crop = parseCropDetect(ffStderr(ff.ffmpeg, cropDetectArgs(path, range.from + dur / 2, Math.min(3, dur))), geo.width, geo.height);
	const pattern = join(outDir, `${stem}-p%02d.png`);
	ffStderr(ff.ffmpeg, contactSheetArgs(path, range.from, dur, every, pattern));
	const sheets = readdirSync(outDir).filter((f) => f.startsWith(`${stem}-p`) && f.endsWith(".png")).sort().map((f) => join(outDir, f));
	// 镜头 = 相邻切点之间（含范围两端）
	const bounds = [range.from, ...cuts.filter((c) => c > range.from && c < range.to), range.to];
	const shots = bounds.slice(0, -1).map((st, i) => ({ st, ed: bounds[i + 1], dur: Math.round((bounds[i + 1] - st) * 1000) / 1000 }));
	log.info(`切点 ${cuts.length} 个：${cuts.join(" / ") || "（无）"}`);
	log.info(crop.bars ? `黑边：data-crop="${crop.crop.join(",")}"（上右下左；ffmpeg ${crop.raw}）` : "黑边：无");
	for (const s of sheets) log.ok(`联系表 ${s}（每格左上是源时间码，间隔 ${every} 秒）`);
	const result = { ok: true, material: id ?? path, path, size: [geo.width, geo.height], duration, range, cuts, shots, crop, every, sheets };
	writeFileSync(join(outDir, `${stem}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

// ------------------------------------------------------------------ 注册

const collect = (v: string, acc: string[]) => [...acc, v];

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
		.option("--mode <m>", "[plan] full（整片铺满）| auto（AI 判定，缺省）| ranges（用户指定区间；给了 --range 时缺省即它）")
		.option("--range <r>", "[plan] 区间：起秒,止秒（如 11.2,32）或句 id 区间（如 u0004-u0009）；可重复", collect, [])
		.option("--density <0..1>", `[plan] auto 模式下合成占全片时长的上限（缺省 ${COMPOSITE_DENSITY_DEFAULT}）`)
		.option("--approve <ids>", "[review] 采纳这些窗口（如 W01,W03）；可重复", collect, [])
		.option("--reject <ids>", "[review] 不要这些窗口；可重复", collect, [])
		.option("--approve-all", "[review] 采纳全部待审窗口")
		.option("--adjust <id=范围>", "[review] 调起止（如 W02=80,90.9 或 W02=u0012-u0015），调完即采纳；可重复", collect, [])
		.option("--add <范围>", "[review] 补一个窗口（直接采纳）；可重复", collect, [])
		.option("--force", "[scaffold] 覆盖已有场景文件")
		.option("--material <id|path>", "[shots] 素材 id（工程素材表）或文件路径")
		.option("--from <sec>", "[shots] 观察起点（源时间秒）")
		.option("--to <sec>", "[shots] 观察终点（源时间秒）")
		.option("--around <sec>", "[shots] 以此源时间为中心观察（配 --span，缺省 15 秒）")
		.option("--span <sec>", "[shots] --around 的观察跨度")
		.option("--every <sec>", "[shots] 联系表取帧间隔（缺省按范围算到约 60 格）")
		.option("--ffmpeg-path <dir>", "[shots] 指定 ffmpeg/ffprobe 所在目录")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[], opts: CompositeOpts) => {
			const sub = (words ?? [])[0];
			if (sub === "plan") return void runCompositePlan(opts as PlanCmdOpts);
			if (sub === "review") return void runCompositeReview(opts as ReviewCmdOpts);
			if (sub === "scaffold") return void runCompositeScaffold(opts as ScaffoldCmdOpts);
			if (sub === "build") return void runCompositeBuild(opts);
			if (sub === "shots") return void runCompositeShots(opts as ShotsCmdOpts);
			throw new Error(USAGE);
		});
}
