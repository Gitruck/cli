/**
 * 合成颗粒接入出口（change add-composite-bake，design D9；规格 local-ffmpeg-render「合成颗粒不按普通颗粒预渲」）。
 *
 * `gtrk render`（经 `prepareParticlesForRender`）与 `gtrk project export` 在颗粒计划**之前**调本模块：
 * - 先烘焙工程里的合成颗粒（命中缓存即复用；纯本地、零计费）；
 * - 烘焙成功的那颗以产物视频进 `paths[clipId]`，沿用颗粒的放置链路（层位不变，产物不透明）；
 * - 时段**整段**落在某颗烘焙成功的合成窗口内的普通颗粒不进颗粒计划（不算键、不计费、不提交）；
 * - 烘焙失败的合成按设计跳过：该段按粗剪出画，它下面的普通颗粒照常预渲；失败带 `composite` 标记，
 *   `gtrk project` 的「有 skipped 即拒导」不认它。
 */
import { readFileSync } from "node:fs";
import { bakeComposites, type BakeEvent, type BakeOptions, type BakeResult } from "./composite-bake";
import { planBake } from "./composite-bake-plan";
import { log } from "./log";
import type { BeatLike, ParticleSkip } from "./particle-qtrle";

export interface CompositeTakeover {
	/** clipId → 烘焙产物（本次烤出或命中缓存）。 */
	paths: Record<string, string>;
	baked: Array<{ clipId: string; compositionId: string; path: string; cached: boolean }>;
	/** 烘焙失败（含环境不可用）的合成：按设计跳过，带 `composite` 标记。 */
	failed: ParticleSkip[];
	/** 被烘焙成功的合成整段盖住、不进颗粒计划的普通颗粒。 */
	covered: Array<{ clipId: string; compositionId: string }>;
	/** 交给颗粒计划的其余颗粒（去掉全部合成与被盖住的）。 */
	beats: { beat: BeatLike; trackIndex: number }[];
}

export interface TakeoverDeps {
	bake?: (opts: BakeOptions) => Promise<BakeResult>;
	onEvent?: (ev: BakeEvent) => void;
}

const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clipIdOf = (b: BeatLike) => (typeof b.clip_id === "string" && b.clip_id ? b.clip_id : String(b.material ?? "?"));

/**
 * 整段覆盖判定：每个普通颗粒若时段整段落在**某一颗**合成窗口内（`[st, ed] ⊆ 窗口`），返回那颗合成的 id。
 * 在帧格上比（与铺轨、渲染同一 `round(秒 × 帧率)`），浮点残渣不影响结论；只认单颗窗口——跨两颗相邻
 * 合成的颗粒不算覆盖（两颗之间的接缝不由任何一颗负责）。客户端 `link-composite-export` 同口径，
 * 共用样例 `test/fixtures/composite-coverage-cases.json`。
 */
export function coveringWindows(
	items: ReadonlyArray<{ id: string; st: number; ed: number }>,
	windows: ReadonlyArray<{ id: string; st: number; ed: number }>,
	rate: number,
): Map<string, string> {
	const f = (sec: number) => Math.round(sec * rate);
	const wins = windows.map((w) => ({ id: w.id, st: f(w.st), ed: f(w.ed) }));
	const out = new Map<string, string>();
	for (const it of items) {
		const st = f(it.st);
		const ed = f(it.ed);
		const w = wins.find((w) => st >= w.st && ed <= w.ed);
		if (w) out.set(it.id, w.id);
	}
	return out;
}

/** 人读日志：烘焙进度与结果（`gtrk composite bake` 与出口共用）。 */
export function logBakeEvent(ev: BakeEvent): void {
	if (ev.type === "browser" && ev.phase === "resolved")
		log.step(`浏览器：${ev.source === "pinned" ? "chrome-headless-shell（钉定版本）" : ev.source === "env" ? `GTRK_CHROME ${ev.exe}` : `系统浏览器 ${ev.exe}`}${ev.mode === "beginframe" ? "，确定性出帧" : "，截图模式"}`);
	if (ev.type === "browser" && ev.note) log.warn(ev.note);
	if (ev.type === "start") log.step(`烘焙 ${ev.composites} 颗合成（${ev.frames} 帧待渲染，${ev.cached} 颗命中缓存）`);
	if (ev.type === "prep") log.tick(`预处理素材 ${ev.done}/${ev.total}`);
	if (ev.type === "progress") log.tick(`渲染 ${ev.done}/${ev.total} 帧（${ev.fps} 帧/秒）`);
	if (ev.type === "composite") {
		log.tickEnd();
		if (ev.state === "failed") log.err(`${ev.id}：失败——${ev.reason}`);
		else log.ok(`${ev.id}：${ev.state === "cached" ? "命中缓存" : "完成"}（${ev.frames} 帧）→ ${ev.path}`);
	}
}

/**
 * 烘焙并接管合成窗口。工程里没有合成颗粒时原样放行、不起任何进程（也不要求 ffmpeg / 浏览器）。
 * 烘焙整体失败（缺 ffmpeg、找不到浏览器等）不抛：全部合成判失败、按粗剪出画，并给出补救提示。
 */
export async function takeOverComposites(
	gtrk: Record<string, unknown>,
	gtrkDir: string,
	beats: { beat: BeatLike; trackIndex: number }[],
	deps: TakeoverDeps = {},
): Promise<CompositeTakeover> {
	const plan = planBake(gtrk, gtrkDir, (p) => readFileSync(p, "utf8"));
	const all = [...plan.entries.map((e) => ({ clipId: e.clipId, id: e.id })), ...plan.failed.map((f) => ({ clipId: f.clipId, id: f.id }))];
	if (!all.length) return { paths: {}, baked: [], failed: [], covered: [], beats };

	const fail = (clipId: string, id: string, why: string): ParticleSkip => ({
		clipId,
		reason: `合成颗粒（${id}）烘焙失败，该段按粗剪输出：${why}`,
		composite: { compositionId: id },
	});
	let result: BakeResult | null = null;
	let envWhy = "";
	try {
		result = await (deps.bake ?? bakeComposites)({ gtrk, baseDir: gtrkDir, onEvent: deps.onEvent ?? logBakeEvent });
	} catch (e) {
		envWhy = (e as Error).message;
		log.tickEnd();
		log.warn(`合成颗粒烘焙未执行：${envWhy}`);
	}

	const paths: Record<string, string> = {};
	const baked: CompositeTakeover["baked"] = [];
	const failed: ParticleSkip[] = [];
	if (!result) for (const c of all) failed.push(fail(c.clipId, c.id, envWhy));
	else {
		for (const it of result.items) {
			if ((it.state === "done" || it.state === "cached") && it.path) {
				paths[it.clipId] = it.path;
				baked.push({ clipId: it.clipId, compositionId: it.id, path: it.path, cached: it.state === "cached" });
			} else failed.push(fail(it.clipId, it.id, it.reason ?? "未知原因"));
		}
		if (result.cancelled) for (const c of all) if (!paths[c.clipId] && !failed.some((f) => f.clipId === c.clipId)) failed.push(fail(c.clipId, c.id, "烘焙被取消"));
	}

	const compositeIds = new Set(all.map((c) => c.clipId));
	const windows = beats
		.filter(({ beat }) => paths[clipIdOf(beat)])
		.map(({ beat }) => ({ id: baked.find((b) => b.clipId === clipIdOf(beat))!.compositionId, st: num(beat.track_st), ed: num(beat.track_ed) }));
	const candidates = beats.filter((x) => !compositeIds.has(clipIdOf(x.beat)));
	const coveredBy = coveringWindows(
		candidates.map((x) => ({ id: clipIdOf(x.beat), st: num(x.beat.track_st), ed: num(x.beat.track_ed) })),
		windows,
		num(gtrk.video_rate, 30),
	);
	const covered: CompositeTakeover["covered"] = [];
	const rest: CompositeTakeover["beats"] = [];
	for (const x of candidates) {
		const by = coveredBy.get(clipIdOf(x.beat));
		if (by) covered.push({ clipId: clipIdOf(x.beat), compositionId: by });
		else rest.push(x);
	}
	for (const c of covered) log.info(`颗粒 ${c.clipId} 整段落在合成 ${c.compositionId} 窗口内：由合成接管，不预渲、不计费`);
	for (const s of failed) log.warn(`颗粒 ${s.clipId} 跳过：${s.reason}`);
	if (!result && failed.length) log.warn("要出合成画面：装钉定版本浏览器（gtrk deps install --browser）后重跑，或先单独跑 gtrk composite bake 看原因。");
	return { paths, baked, failed, covered, beats: rest };
}
