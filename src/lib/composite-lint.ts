/**
 * 合成颗粒机检（change add-composite-layer，design D5）——纯函数部分：静态校验与逐帧结果归并。
 *
 * 逐帧排版在浏览器里由工具箱的 `lint()` 判（下层画面的 front 描边压上层画面、front 线条穿过画面、画面越出舞台），
 * 驱动在 `composite-browser.ts`；这里只把每个采样帧的结果按「同一个问题」归并成帧区间，便于人读。
 */
import { validateCompositeBlock } from "./composite-profile";
import { evaluateComposite, type ResolveGtrk } from "./composite-resolve";
import { snapSec } from "./composite-scene";
import { detectComposite } from "./composite-particle";

export interface LintIssue {
	/** static：静态问题；layout：逐帧排版问题。 */
	kind: "static" | "layout";
	/** 判据：profile / forbidden-api / unregistered-material / off-grid / stale / border-over-slot / stroke-through-slot / slot-out-of-stage / same-z-overlap / impure-frame */
	rule: string;
	message: string;
	/** 逐帧问题出现的帧区间与采样次数。 */
	frames?: [number, number];
	samples?: number;
}

/** 场景脚本里不得出现的 API（逐帧纯函数：同一帧号永远画出同一画面）。 */
const FORBIDDEN: Array<[RegExp, string]> = [
	[/\bDate\s*\.\s*now\b|\bnew\s+Date\b/, "Date（时间不由帧号决定）"],
	[/\bMath\s*\.\s*random\b/, "Math.random（每次画面不同）"],
	[/\brequestAnimationFrame\b/, "requestAnimationFrame（自有时钟，不被 seek 驱动）"],
	[/\bsetInterval\b/, "setInterval（自有时钟，不被 seek 驱动）"],
	[/\bsetTimeout\b/, "setTimeout（自有时钟，不被 seek 驱动）"],
];

/** 去掉 JS 注释（粗略：够判禁用项，不追求完整词法）。 */
function stripComments(js: string): string {
	return js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
}

/** 颗粒 HTML 里最后一段无类型 `<script>`（构建时场景脚本排在工具箱之后）。 */
export function sceneScriptOf(html: string): string {
	const all = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	return all.length ? all[all.length - 1] : "";
}

export function forbiddenApis(js: string): string[] {
	const code = stripComments(js);
	return FORBIDDEN.filter(([re]) => re.test(code)).map(([, why]) => why);
}

/** 一颗颗粒的静态校验：profile、禁用项、own 素材登记、窗口帧格、是否仍新鲜。 */
export function staticLint(
	html: string,
	window: [number, number],
	gtrk: ResolveGtrk,
	{ extraMaterialIds = [] as string[] } = {},
): LintIssue[] {
	const out: LintIssue[] = [];
	const d = detectComposite(html);
	if (d.kind !== "composite" || !d.block) {
		return [{ kind: "static", rule: "profile", message: `不是合法的合成颗粒：${d.reason ?? d.kind}` }];
	}
	const block = d.block;
	for (const e of validateCompositeBlock(block, html)) out.push({ kind: "static", rule: "profile", message: e });
	for (const why of forbiddenApis(sceneScriptOf(html))) out.push({ kind: "static", rule: "forbidden-api", message: `场景脚本用了 ${why}` });
	const registered = new Set([...(gtrk.materials ?? []).map((m) => String(m?.id)), ...extraMaterialIds]);
	for (const [sid, b] of Object.entries((block.resolved?.bindings ?? {}) as Record<string, { kind?: string; material?: unknown }>)) {
		if (b.kind === "own" && typeof b.material === "string" && !registered.has(b.material)) {
			out.push({ kind: "static", rule: "unregistered-material", message: `槽位 ${sid} 的素材 ${b.material} 未登记（不在工程素材表、也不在同批素材清单里）` });
		}
	}
	const rate = Number(gtrk.video_rate);
	for (const [i, s] of window.entries()) {
		if (Math.abs(snapSec(s, rate) - s) > 1e-9) out.push({ kind: "static", rule: "off-grid", message: `窗口${i ? "终点" : "起点"} ${s} 不在帧格上（应为 ${snapSec(s, rate)}），重跑 build` });
	}
	const withExtra = { ...gtrk, materials: [...(gtrk.materials ?? []), ...extraMaterialIds.map((id) => ({ id }))] };
	const ev = evaluateComposite(withExtra, { track_st: window[0], track_ed: window[1] }, block);
	if (ev.state !== "fresh") out.push({ kind: "static", rule: "stale", message: `按当前工程判为「${ev.state === "rerender" ? "需重渲" : "未解析"}」（上游改过），重跑 build` });
	for (const [sid, st] of Object.entries(ev.slots)) {
		if (st === "missing") out.push({ kind: "static", rule: "stale", message: `槽位 ${sid}「需重新选择」：引用的片段 / 素材已不在工程里` });
	}
	return out;
}

export interface FrameIssue {
	kind: string;
	[k: string]: unknown;
}

const RULE_TEXT: Record<string, (x: FrameIssue) => string> = {
	"border-over-slot": (x) => `画面 ${x.lower} 的前景描边压在画面 ${x.upper} 上（下层画面不该有 front 描边，或两画别重叠）`,
	"same-z-overlap": (x) => `画面 ${x.a} 与 ${x.b} 同层重叠且有前景描边（谁在上不确定）`,
	"stroke-through-slot": (x) => `前景线条 ${x.stroke} 穿过画面 ${x.slot}`,
	"slot-out-of-stage": (x) => `画面 ${x.slot} 越出舞台`,
};

/** 逐帧结果 → 按问题归并成帧区间（首帧、末帧、采样次数），保持首次出现的顺序。 */
export function mergeFrameIssues(samples: Array<{ f: number; issues: FrameIssue[] }>): LintIssue[] {
	const runs = new Map<string, { issue: FrameIssue; a: number; b: number; n: number }>();
	for (const s of samples) {
		for (const it of s.issues) {
			const key = JSON.stringify(it);
			const r = runs.get(key);
			if (r) {
				r.b = s.f;
				r.n++;
			} else runs.set(key, { issue: it, a: s.f, b: s.f, n: 1 });
		}
	}
	return [...runs.values()].map((r) => ({
		kind: "layout" as const,
		rule: r.issue.kind,
		message: (RULE_TEXT[r.issue.kind] ?? ((x: FrameIssue) => JSON.stringify(x)))(r.issue),
		frames: [r.a, r.b] as [number, number],
		samples: r.n,
	}));
}

/** 帧纯度机检的一处差异（design D10）：某元素 / 槽位的某个几何量，在连续顺序与跳跃顺序下不同。 */
export interface PurityDiff {
	target: string;
	prop: string;
	/** 连续顺序（先渲前一帧）下的值。 */
	a: number;
	/** 跳跃顺序（先渲远处一帧）下的值。 */
	b: number;
}

const PROP_TEXT: Record<string, string> = { left: "left", top: "top", width: "宽度", height: "高度", opacity: "不透明度" };
const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * 帧纯度结果 → 每个「元素 × 几何量」一条违规：帧区间、采样次数、最大差值与首个差异帧的两种取值。
 * 同一帧号画出不同画面时，烘焙的段首帧、预览跳转后的首帧都会与连续播放不同。
 */
export function mergePurityIssues(samples: Array<{ f: number; diffs: PurityDiff[] }>): LintIssue[] {
	const runs = new Map<string, { d: PurityDiff; f0: number; a: number; b: number; n: number; max: number }>();
	for (const s of samples) {
		for (const d of s.diffs) {
			const key = `${d.target}\u0000${d.prop}`;
			const delta = Math.abs(d.a - d.b);
			const r = runs.get(key);
			if (r) {
				r.b = s.f;
				r.n++;
				r.max = Math.max(r.max, delta);
			} else runs.set(key, { d, f0: s.f, a: s.f, b: s.f, n: 1, max: delta });
		}
	}
	return [...runs.values()].map((r) => ({
		kind: "layout" as const,
		rule: "impure-frame",
		message:
			`帧纯度：${r.d.target} 的${PROP_TEXT[r.d.prop] ?? r.d.prop}随渲染顺序变化（第 ${r.f0} 帧：连续渲染 ${r1(r.d.a)}、跳着渲染 ${r1(r.d.b)}；最大差 ${r1(r.max)}）` +
			"——同一帧号必须画出同一画面。常见成因：读取了带变换元素的渲染后几何（如对正在缩放的元素用 getBoundingClientRect 量宽度），改读 offsetWidth / offsetLeft 等不含变换的布局值",
		frames: [r.a, r.b] as [number, number],
		samples: r.n,
	}));
}

/** 采样帧：窗口内每 `step` 帧一帧，末帧必采。 */
export function sampleFrames(span: number, step = 10): number[] {
	const out: number[] = [];
	for (let f = 0; f < span; f += step) out.push(f);
	if (span > 0 && out[out.length - 1] !== span - 1) out.push(span - 1);
	return out;
}
