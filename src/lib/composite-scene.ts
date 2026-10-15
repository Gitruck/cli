/**
 * 合成颗粒场景文件 → 颗粒 HTML（change add-composite-layer，design D2 / D3 / D4）。
 *
 * 场景文件 = 四段：
 *   <script type="application/x-cp-spec">{ id, window, takeover?, slots{bind,label?,pin?}, anchors? }</script>
 *   <style>…</style>                 场景样式（可多段）
 *   标记                              舞台 #stage 的子元素
 *   <script>CP.render = …</script>   场景脚本（恰一段）
 *
 * 解析（窗口帧、`lane_clip_id`、锚点局部帧、`own` 局部帧、`inputs_hash`）一律走 `composite-resolve.ts`
 * 的 infra 规则；本模块只管「场景写法 → 元数据块」的翻译、拼装与收尾。原型是测试工程
 * `合成颗粒-261014/project/composite-src/build.py`，元数据块逐字节对齐它（键序、缩进、`</` 转义）。
 *
 * 纯函数、零 I/O：读文件、写文件、取工具箱都在命令层。
 */
import { f2ms, sec2frame, sec2ms } from "./frame-domain";
import { collectProjectionClips, normClip, type GtrkProject, type Transcript } from "./projection";
import type { CompositeBlock } from "./composite-particle";
import {
	buildSnapshot,
	COMPOSITE_TICKS_PER_SECOND,
	findRefClip,
	inputsHash,
	laneClips,
	localFrame,
	windowFrames,
	type ResolveGtrk,
} from "./composite-resolve";
import { validateCompositeBlock } from "./composite-profile";

export const COMPOSITE_KIT_VERSION = "composite-kit@1";
/** 自产合成轨 / 片段的身份（`producer.by`），铺轨按它认领，不按轨号。 */
export const COMPOSITE_PRODUCER = "gtrk:composite@1";
/** 颗粒 HTML 体积上限（与 mg lint `4-html-size` 同源：客户端颗粒运行时的加载上限）。 */
export const COMPOSITE_HTML_MAX_CHARS = 2_000_000;

const SPEC_RE = /<script type="application\/x-cp-spec">([\s\S]*?)<\/script>/;
const STYLE_RE = /<style>([\s\S]*?)<\/style>/g;
const SCRIPT_RE = /<script>([\s\S]*?)<\/script>/g;

export interface ScenePin {
	track?: number;
	clip_id?: string;
	material?: string;
	src_in_ms?: number;
	dur_f?: number;
	dur_t?: number;
	starts_at_f?: number | string;
	starts_at_t?: number;
	fit?: string;
	framing?: { scale_pm: number; x_pm: number; y_pm: number };
}

export interface SceneSpec {
	id: string;
	window: [number, number];
	takeover?: string[];
	slots: Record<string, { bind: Record<string, unknown>; label?: string; pin?: ScenePin }>;
	/** 锚点名 → [句 id, 关键词, 第几处（0 起，缺省 0）] */
	anchors?: Record<string, [string, string, number?]>;
}

export interface Scene {
	spec: SceneSpec;
	css: string;
	js: string;
	markup: string;
}

/** 场景 / 颗粒构建失败：逐条点名颗粒与槽位。 */
export class CompositeSceneError extends Error {
	constructor(
		readonly compositionId: string,
		readonly problems: string[],
	) {
		super(`${compositionId}：\n  ${problems.join("\n  ")}`);
	}
}

/** 拆场景文件的四段；缺规格段、规格不是 JSON、脚本段不是恰一段都抛错。 */
export function parseScene(src: string, file = "<scene>"): Scene {
	const m = SPEC_RE.exec(src);
	if (!m) throw new CompositeSceneError(file, ['缺少规格段 <script type="application/x-cp-spec">']);
	let spec: SceneSpec;
	try {
		spec = JSON.parse(m[1]) as SceneSpec;
	} catch (e) {
		throw new CompositeSceneError(file, [`规格段不是合法 JSON：${(e as Error).message}`]);
	}
	const css = [...src.matchAll(STYLE_RE)].map((x) => x[1]).join("\n");
	const js = [...src.matchAll(SCRIPT_RE)].map((x) => x[1]);
	if (js.length !== 1) throw new CompositeSceneError(spec?.id ?? file, [`场景脚本应恰有一段 <script>，实际 ${js.length} 段`]);
	const markup = src.replace(SPEC_RE, "").replace(STYLE_RE, "").replace(SCRIPT_RE, "").trim();
	return { spec, css, js: js[0], markup };
}

/** 秒 → 帧格投影秒（帧号换算到整毫秒、向下取整）。写方 MUST 只写这种秒值（R14）。 */
export function snapSec(sec: number, rate: number): number {
	return f2ms(sec2frame(sec, rate), rate) / 1000;
}

/**
 * 源时间 → 时间线秒：落在某个保留片段里按片段换算；落在被剪掉的部分取其后第一个保留片段的起点。
 * 片段取投影主轨上命中口播素材的那些（与 `gtrk split` 同一口径）。
 */
export function sourceToTimeline(gtrk: GtrkProject, materialId: string, src: number): number {
	const clips = collectProjectionClips(gtrk, materialId)
		.clips.filter((c) => c.material != null && String(c.material) === materialId)
		.map(normClip);
	for (const c of clips) {
		if (c.clip_st - 1e-6 <= src && src < c.clip_ed) return c.track_st + (src - c.clip_st) / c.speed;
	}
	const later = clips.filter((c) => c.clip_st > src).sort((a, b) => a.clip_st - b.clip_st);
	if (!later.length) throw new Error(`源时间 ${src} 之后没有保留片段`);
	return later[0].track_st;
}

/** 句 id + 关键词（第 nth 处）→ 关键词首字在时间线上的时刻；关键词所在的字被剪掉时取其后第一个保留的字。 */
export function anchorTime(transcript: Transcript, gtrk: GtrkProject, uid: string, keyword: string, nth = 0): number {
	const u = transcript.utterances.find((x) => x.id === uid);
	if (!u) throw new Error(`转写里没有句 ${uid}`);
	const chars = (u.words ?? []).map((w) => w.w).join("");
	let idx = -1;
	for (let k = 0; k <= nth; k++) {
		idx = chars.indexOf(keyword, idx + 1);
		if (idx < 0) throw new Error(`${uid} 里找不到「${keyword}」（第 ${nth + 1} 处）：${chars}`);
	}
	let pos = 0;
	for (const w of u.words) {
		if (pos + w.w.length > idx) return sourceToTimeline(gtrk, String(u.material_id ?? transcript.material_id), w.st);
		pos += w.w.length;
	}
	throw new Error(`${uid}「${keyword}」：字下标越界`);
}

export interface ResolvedScene {
	block: CompositeBlock & Record<string, unknown>;
	beat: { clip_id: string; track_st: number; track_ed: number };
	/** 窗口两端被吸附到帧格时的挪动量（毫秒，正 = 往后）。 */
	windowShiftMs: [number, number];
}

/**
 * 规格 → 元数据块（`resolved.inputs_hash` 先占位，`finalizeParticle` 再填）。
 * 失败逐条收齐后一次抛出：未登记的 `own` 素材、窗口内没片段的轨、找不到的 `ref` 片段、越窗锚点。
 */
export function resolveScene(
	scene: Scene,
	gtrk: GtrkProject & ResolveGtrk,
	transcript: Transcript | null,
	{ extraMaterialIds = [] as string[] } = {},
): ResolvedScene {
	const spec = scene.spec;
	const id = String(spec.id || "");
	const problems: string[] = [];
	if (!id) throw new CompositeSceneError("<scene>", ["规格缺 id"]);
	if (!Array.isArray(spec.window) || spec.window.length !== 2) throw new CompositeSceneError(id, ["规格缺 window: [起, 止]（时间线秒）"]);
	const rate = Number(gtrk.video_rate);
	const [st, ed] = spec.window.map((x) => snapSec(Number(x), rate));
	const shift: [number, number] = [sec2ms(st - spec.window[0]), sec2ms(ed - spec.window[1])];
	if (!(ed > st)) throw new CompositeSceneError(id, [`窗口为空或倒置：${spec.window.join("–")}`]);
	const beat = { clip_id: id, track_st: st, track_ed: ed };
	const win = windowFrames(beat, rate);
	const span = win[1] - win[0];

	const anchorsF: Record<string, number> = {};
	for (const [name, a] of Object.entries(spec.anchors ?? {})) {
		if (!transcript) {
			problems.push(`锚点「${name}」：找不到 transcript.json，无法解析锚点`);
			continue;
		}
		try {
			const f = localFrame(anchorTime(transcript, gtrk, a[0], a[1], a[2] ?? 0), win[0], rate);
			if (f < 0 || f >= span) problems.push(`锚点「${name}」落在窗口外（局部帧 ${f}，窗口 ${span} 帧）`);
			else anchorsF[name] = f;
		} catch (e) {
			problems.push(`锚点「${name}」：${(e as Error).message}`);
		}
	}

	const registered = new Set([...(gtrk.materials ?? []).map((m) => String(m?.id)), ...extraMaterialIds]);
	const slots: Record<string, unknown> = {};
	const bindings: Record<string, Record<string, unknown>> = {};
	for (const [sid, s] of Object.entries(spec.slots ?? {})) {
		slots[sid] = { bind: s.bind, ...(s.label !== undefined ? { label: s.label } : {}) };
		const kind = s.bind?.kind;
		const pin = s.pin ?? {};
		const where = `槽位 ${sid}`;
		if (kind === "ref-lane") {
			if (typeof pin.track !== "number") {
				problems.push(`${where}：ref-lane 需要 pin.track（轨号）`);
				continue;
			}
			const lane = laneClips(gtrk, pin.track, win, rate);
			if (!lane || !lane.length) {
				problems.push(`${where}：轨 ${pin.track} 在窗口内没有片段`);
				continue;
			}
			bindings[sid] = { kind, lane_clip_id: lane[0].clip_id, track_index: pin.track };
		} else if (kind === "ref") {
			if (!pin.clip_id) {
				problems.push(`${where}：ref 需要 pin.clip_id`);
				continue;
			}
			if (!findRefClip(gtrk, pin.clip_id)) problems.push(`${where}：工程里找不到片段 ${pin.clip_id}（或不唯一）`);
			bindings[sid] = { kind, clip_id: pin.clip_id };
		} else if (kind === "own") {
			const mat = pin.material;
			if (!mat) {
				problems.push(`${where}：own 需要 pin.material`);
				continue;
			}
			if (!registered.has(mat)) problems.push(`${where}：素材 ${mat} 未登记（不在工程素材表、也不在同批素材清单里）`);
			let sa: number | undefined;
			if (typeof pin.starts_at_t === "number") sa = localFrame(pin.starts_at_t, win[0], rate);
			else if (typeof pin.starts_at_f === "string") {
				sa = anchorsF[pin.starts_at_f];
				if (sa === undefined) problems.push(`${where}：starts_at 引用的锚点「${pin.starts_at_f}」未解析`);
			} else sa = typeof pin.starts_at_f === "number" ? pin.starts_at_f : 0;
			const durF = typeof pin.dur_t === "number" ? Math.max(1, sec2frame(pin.dur_t, rate)) : pin.dur_f;
			if (!(typeof durF === "number" && Number.isInteger(durF) && durF > 0)) problems.push(`${where}：需要 pin.dur_t（秒）或 pin.dur_f（帧）`);
			if (sa !== undefined && (sa < 0 || sa >= span)) problems.push(`${where}：起始帧 ${sa} 落在窗口外`);
			bindings[sid] = { kind, material: mat, src_in_ms: pin.src_in_ms ?? 0, dur_f: durF, starts_at_f: sa };
		} else if (kind === "text") {
			bindings[sid] = { kind: "text" };
		} else {
			problems.push(`${where}：未知绑定种类 ${String(kind)}`);
			continue;
		}
		for (const k of ["fit", "framing"] as const) if (k in pin) bindings[sid][k] = pin[k];
	}
	if (problems.length) throw new CompositeSceneError(id, problems);

	const block = {
		profile: "gtrk-composite@1",
		engine: { name: "html", version: 1 },
		composition_id: id,
		stage: { width: 1920, height: 1080 },
		slots,
		anchors: Object.keys(anchorsF),
		...(spec.takeover?.length ? { takeover: spec.takeover } : {}),
		resolved: {
			video_rate: rate,
			window: { track_st_f: win[0], track_ed_f: win[1] },
			bindings,
			anchors_f: anchorsF,
			inputs_hash: `sha256:${"0".repeat(64)}`,
		},
	} as unknown as ResolvedScene["block"];
	return { block, beat, windowShiftMs: shift };
}

export interface CompositeKit {
	js: string;
	css: string;
	/** 栏目 / 工程风格（配色、字体、纹理），接在工具箱样式之后；无则空串。 */
	themeCss?: string;
}

const placeholderHash = `"inputs_hash": "sha256:${"0".repeat(64)}"`;

/** 拼成自包含颗粒 HTML（工具箱、风格、场景全部内联）。 */
export function assembleParticle(scene: Scene, block: ResolvedScene["block"], kit: CompositeKit): string {
	const meta = JSON.stringify(block, null, 2).replace(/<\//g, "<\\/");
	const css = [kit.css, kit.themeCss ?? "", scene.css].filter((x) => x).join("\n");
	return (
		'<!doctype html>\n<html lang="zh">\n<head>\n<meta charset="utf-8">\n' +
		`<meta name="generator" content="${COMPOSITE_KIT_VERSION}">\n` +
		`<title>${block.composition_id}</title>\n` +
		`<script type="application/json" data-gtrk-composite>\n${meta}\n</script>\n` +
		`<style>\n${css}\n</style>\n</head>\n<body>\n` +
		`<div id="stage" data-composition-id="${block.composition_id}" data-width="1920" data-height="1080">\n` +
		`${scene.markup}\n</div>\n` +
		`<script>\n${kit.js}\n</script>\n<script>\n${scene.js}\n</script>\n</body>\n</html>\n`
	);
}

export interface BuiltParticle {
	id: string;
	html: string;
	block: ResolvedScene["block"];
	beat: ResolvedScene["beat"];
	inputsHash: string;
	windowShiftMs: [number, number];
	/** 文本输入槽位的字幕条目（局部帧），供预览 / 机检的 init 用。 */
	texts: Record<string, Array<{ text: string; f0: number; f1: number }>>;
}

/**
 * 场景 → 收尾好的颗粒：解析、拼装、过 profile 校验与体积闸、算 `inputs_hash` 并写回元数据块。
 * 哈希按「工程 + 同批素材」算（同批素材在铺轨时登记，快照判 own 是否已登记要按铺好后的样子）。
 */
export function buildParticle(
	scene: Scene,
	gtrk: GtrkProject & ResolveGtrk,
	transcript: Transcript | null,
	kit: CompositeKit,
	{ extraMaterialIds = [] as string[], ticksPerSecond = COMPOSITE_TICKS_PER_SECOND } = {},
): BuiltParticle {
	const r = resolveScene(scene, gtrk, transcript, { extraMaterialIds });
	const id = String(r.block.composition_id);
	let html = assembleParticle(scene, r.block, kit);
	const errs = validateCompositeBlock(r.block, html);
	if (html.length > COMPOSITE_HTML_MAX_CHARS) errs.push(`颗粒 HTML ${html.length} 字符，超过客户端加载上限 ${COMPOSITE_HTML_MAX_CHARS}`);
	if (errs.length) throw new CompositeSceneError(id, errs);
	const withExtra = extraMaterialIds.length
		? { ...gtrk, materials: [...(gtrk.materials ?? []), ...extraMaterialIds.map((m) => ({ id: m }))] }
		: gtrk;
	const snap = buildSnapshot(withExtra, r.beat, r.block, { ticksPerSecond });
	const h = inputsHash(snap);
	if (html.split(placeholderHash).length !== 2) throw new CompositeSceneError(id, ["元数据块里找不到唯一的 inputs_hash 占位"]);
	html = html.replace(placeholderHash, `"inputs_hash": "${h}"`);
	(r.block.resolved as Record<string, unknown>).inputs_hash = h;
	const texts: BuiltParticle["texts"] = {};
	for (const e of snap.slots) if (e.kind === "text") texts[e.slot as string] = (e.cues as BuiltParticle["texts"][string]) ?? [];
	return { id, html, block: r.block, beat: r.beat, inputsHash: h, windowShiftMs: r.windowShiftMs, texts };
}
