/**
 * 合成颗粒元数据块校验（change add-composite-layer，design D3 / D5 静态部分）。
 *
 * 规则正本是 infra capability `composite-particle-profile` 的参考实现
 * `gitruck-infra/utils/process/media/vision/composite_particle/profile.py`（`validate(block, html)`），本模块逐条移植：
 * 每条错误指名路径，未知键一律报错（静默忽略未知键等于让拼错的字段悄悄失效）。
 *
 * HTML 结构事实（舞台根 id、`data-slot` 计数、`<audio>/<video>`）用一个小扫描器取：跳过注释，
 * `<script>` / `<style>` 正文按原始文本跳过（与 Python `HTMLParser` 的 CDATA 元素一致）。
 *
 * 纯函数、零 I/O。
 */

export const COMPOSITE_PROFILE = "gtrk-composite@1";
export const COMPOSITE_TAKEOVER = ["subtitles", "overlay"] as const;

const TOP_KEYS = new Set(["profile", "engine", "composition_id", "stage", "slots", "anchors", "takeover", "resolved"]);
const SLOT_KEYS = new Set(["bind", "label"]);
const BIND_KINDS = ["ref", "ref-lane", "own", "text"] as const;
const BIND_DECL_KEYS: Record<string, Set<string>> = {
	ref: new Set(["kind", "role"]),
	"ref-lane": new Set(["kind", "role"]),
	own: new Set(["kind", "facet", "starts_at"]),
	text: new Set(["kind", "source"]),
};
const RESOLVED_KEYS = new Set(["video_rate", "window", "bindings", "anchors_f", "inputs_hash"]);
const OVERRIDES = ["fit", "framing"];
const RESOLVED_BIND_KEYS: Record<string, Set<string>> = {
	ref: new Set(["kind", "clip_id", ...OVERRIDES]),
	"ref-lane": new Set(["kind", "lane_clip_id", "track_index", ...OVERRIDES]),
	own: new Set(["kind", "material", "src_in_ms", "dur_f", "starts_at_f", ...OVERRIDES]),
	text: new Set(["kind"]),
};
const SLOT_ID = /^[A-Za-z0-9_-]+$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isPosInt = (v: unknown): v is number => isInt(v) && v > 0;
const sameKeys = (o: Obj, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);
// 键序按码点升序报错，与 Python sorted 一致
const sortedStr = (xs: string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const unknown = (o: Obj, allowed: Set<string>, path: string) => sortedStr(Object.keys(o).filter((k) => !allowed.has(k))).map((k) => `${path}.${k}：未知键`);

function checkDecl(block: Obj): string[] {
	const errs = unknown(block, TOP_KEYS, "$");
	if (block.profile !== COMPOSITE_PROFILE) errs.push(`$.profile：必须为 "${COMPOSITE_PROFILE}"`);
	const eng = block.engine;
	if (!(isObj(eng) && eng.name === "html" && eng.version === 1 && sameKeys(eng, ["name", "version"]))) {
		errs.push('$.engine：本期只支持 { "name": "html", "version": 1 }');
	}
	if (!(typeof block.composition_id === "string" && block.composition_id)) errs.push("$.composition_id：必须为非空字符串");
	const st = block.stage;
	if (!(isObj(st) && sameKeys(st, ["width", "height"]) && isPosInt(st.width) && isPosInt(st.height))) {
		errs.push("$.stage：必须为 { width, height } 正整数");
	}
	let slots = block.slots;
	if (!(isObj(slots) && Object.keys(slots).length)) {
		errs.push("$.slots：必须为非空对象");
		slots = {};
	}
	for (const [sid, spec] of Object.entries(slots as Obj)) {
		const path = `$.slots.${sid}`;
		if (!SLOT_ID.test(sid)) errs.push(`${path}：槽位 id 只允许 ASCII 字母、数字、- 与 _`);
		if (!isObj(spec)) {
			errs.push(`${path}：必须为对象`);
			continue;
		}
		errs.push(...unknown(spec, SLOT_KEYS, path));
		if ("label" in spec && typeof spec.label !== "string") errs.push(`${path}.label：必须为字符串`);
		const bind = spec.bind;
		if (!(isObj(bind) && (BIND_KINDS as readonly unknown[]).includes(bind.kind))) {
			errs.push(`${path}.bind.kind：必须为 ref / ref-lane / own / text 之一`);
			continue;
		}
		const allowed = BIND_DECL_KEYS[bind.kind as string];
		errs.push(...unknown(bind, allowed, `${path}.bind`));
		for (const k of sortedStr([...allowed].filter((k) => k !== "kind"))) {
			if (k in bind && typeof bind[k] !== "string") errs.push(`${path}.bind.${k}：必须为字符串`);
		}
		if (bind.kind === "text" && bind.source !== "subtitles") errs.push(`${path}.bind.source：本期只支持 "subtitles"`);
	}
	const anchors = block.anchors;
	if (!(Array.isArray(anchors) && anchors.every((a) => typeof a === "string" && a))) {
		errs.push("$.anchors：必须为字符串数组，且每个元素非空");
	}
	if ("takeover" in block) {
		const tk = block.takeover;
		if (!(Array.isArray(tk) && tk.every((x) => typeof x === "string"))) {
			errs.push("$.takeover：必须为字符串数组");
		} else {
			const bad = tk.filter((x) => !(COMPOSITE_TAKEOVER as readonly string[]).includes(x));
			if (bad.length) errs.push(`$.takeover：只允许 subtitles / overlay，发现 ${JSON.stringify(bad)}`);
			if (new Set(tk).size !== tk.length) errs.push("$.takeover：取值不得重复");
		}
	}
	return errs;
}

function checkOverrides(b: Obj, path: string): string[] {
	const errs: string[] = [];
	if ("fit" in b && b.fit !== "cover" && b.fit !== "contain") errs.push(`${path}.fit：必须为 cover / contain`);
	if ("framing" in b) {
		const fr = b.framing;
		if (!(isObj(fr) && sameKeys(fr, ["scale_pm", "x_pm", "y_pm"]) && isInt(fr.scale_pm) && isInt(fr.x_pm) && isInt(fr.y_pm))) {
			errs.push(`${path}.framing：必须为 { scale_pm, x_pm, y_pm } 整数`);
		} else if ((fr.scale_pm as number) < 1000) {
			errs.push(`${path}.framing.scale_pm：不得小于 1000`);
		}
	}
	return errs;
}

function checkResolved(block: Obj): string[] {
	const res = block.resolved;
	if (res === undefined) return [];
	if (!isObj(res)) return ["$.resolved：必须为对象"];
	const errs = unknown(res, RESOLVED_KEYS, "$.resolved");
	if (!isPosInt(res.video_rate)) errs.push("$.resolved.video_rate：必须为正整数");
	const win = res.window;
	if (!(isObj(win) && sameKeys(win, ["track_st_f", "track_ed_f"]) && isInt(win.track_st_f) && isInt(win.track_ed_f) && 0 <= win.track_st_f && win.track_st_f < win.track_ed_f)) {
		errs.push("$.resolved.window：必须为 { track_st_f, track_ed_f } 整数且起点小于终点");
	}
	if (!(typeof res.inputs_hash === "string" && HASH.test(res.inputs_hash))) errs.push('$.resolved.inputs_hash：必须为 "sha256:" + 64 位小写十六进制');
	const anchorsF = res.anchors_f;
	if (!(isObj(anchorsF) && Object.values(anchorsF).every((v) => isInt(v) && v >= 0))) {
		errs.push("$.resolved.anchors_f：必须为 锚点文字 → 非负整数帧 的对象");
	}
	const slots = isObj(block.slots) ? block.slots : {};
	const bindings = res.bindings;
	if (!isObj(bindings)) return [...errs, "$.resolved.bindings：必须为对象"];
	for (const [sid, b] of Object.entries(bindings)) {
		const path = `$.resolved.bindings.${sid}`;
		const decl = slots[sid];
		if (!isObj(decl)) {
			errs.push(`${path}：作者声明段里没有这个槽位`);
			continue;
		}
		const kind = isObj(decl.bind) ? (decl.bind.kind as string) : undefined;
		if (!(isObj(b) && b.kind === kind) || !kind || !RESOLVED_BIND_KEYS[kind]) {
			errs.push(`${path}.kind：必须与声明的绑定种类 ${kind} 一致`);
			continue;
		}
		errs.push(...unknown(b, RESOLVED_BIND_KEYS[kind], path), ...checkOverrides(b, path));
		if (kind === "ref" && !(typeof b.clip_id === "string" && b.clip_id)) errs.push(`${path}.clip_id：必须为非空字符串`);
		if (kind === "ref-lane") {
			if (!(typeof b.lane_clip_id === "string" && b.lane_clip_id)) errs.push(`${path}.lane_clip_id：必须为非空字符串（该轨在窗口内第一个片段的 clip_id）`);
			if ("track_index" in b && !isInt(b.track_index)) errs.push(`${path}.track_index：必须为整数`);
		}
		if (kind === "own") {
			const mat = b.material;
			if (mat !== null && mat !== undefined && !(typeof mat === "string" && mat)) errs.push(`${path}.material：必须为非空字符串或 null（待填充）`);
			if (mat !== null && mat !== undefined) {
				for (const k of ["src_in_ms", "dur_f", "starts_at_f"]) {
					if (!(isInt(b[k]) && (b[k] as number) >= 0)) errs.push(`${path}.${k}：已填槽位必须给出非负整数`);
				}
				if (b.dur_f === 0) errs.push(`${path}.dur_f：必须大于 0`);
			}
		}
	}
	if (isObj(anchorsF) && Array.isArray(block.anchors)) {
		const missing = block.anchors.filter((a) => typeof a === "string" && !(a in anchorsF));
		if (missing.length) errs.push(`$.resolved.anchors_f：缺少锚点 ${JSON.stringify(missing)}`);
	}
	return errs;
}

// ------------------------------------------------------------------ HTML 结构事实

export interface CompositeHtmlFacts {
	stageIds: string[];
	slotCounts: Map<string, number>;
	mediaTags: string[];
}

const ATTR_RE = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
		const k = e.toLowerCase();
		if (k === "amp") return "&";
		if (k === "lt") return "<";
		if (k === "gt") return ">";
		if (k === "quot") return '"';
		if (k === "apos") return "'";
		const n = k.startsWith("#x") ? Number.parseInt(k.slice(2), 16) : Number.parseInt(k.slice(1), 10);
		return Number.isFinite(n) ? String.fromCodePoint(n) : m;
	});
}

/** 顺序扫描开始标签：跳过注释、`<!doctype>` 与结束标签；`<script>` / `<style>` 正文原样跳过。 */
export function scanCompositeHtml(html: string): CompositeHtmlFacts {
	const facts: CompositeHtmlFacts = { stageIds: [], slotCounts: new Map(), mediaTags: [] };
	const lower = html.toLowerCase();
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt < 0) break;
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			i = end < 0 ? html.length : end + 3;
			continue;
		}
		const m = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(lt, lt + 64));
		if (!m) {
			i = lt + 1;
			continue;
		}
		const gt = html.indexOf(">", lt);
		if (gt < 0) break;
		const tag = m[1].toLowerCase();
		const attrs = new Map<string, string>();
		for (const a of html.slice(lt + m[0].length, gt).matchAll(ATTR_RE)) {
			const name = a[1].toLowerCase();
			if (!attrs.has(name)) attrs.set(name, decodeEntities(a[2] ?? a[3] ?? a[4] ?? ""));
		}
		if (tag === "audio" || tag === "video") facts.mediaTags.push(tag);
		if (tag !== "script" && attrs.has("data-composition-id")) facts.stageIds.push(attrs.get("data-composition-id") ?? "");
		if (attrs.has("data-slot")) {
			const sid = attrs.get("data-slot") ?? "";
			facts.slotCounts.set(sid, (facts.slotCounts.get(sid) ?? 0) + 1);
		}
		i = gt + 1;
		if (tag === "script" || tag === "style") {
			const close = lower.indexOf(`</${tag}`, i);
			i = close < 0 ? html.length : close;
		}
	}
	return facts;
}

function checkHtml(block: Obj, html: string): string[] {
	const facts = scanCompositeHtml(html);
	const errs: string[] = [];
	const cid = block.composition_id;
	if (!facts.stageIds.length) errs.push("html：找不到声明 data-composition-id 的舞台根元素");
	else if (facts.stageIds[0] !== cid) errs.push(`html：舞台根的 data-composition-id 为 ${JSON.stringify(facts.stageIds[0])}，元数据块为 ${JSON.stringify(cid)}`);
	const slots = isObj(block.slots) ? block.slots : {};
	for (const [sid, spec] of Object.entries(slots)) {
		const n = facts.slotCounts.get(sid) ?? 0;
		const kind = isObj(spec) && isObj(spec.bind) ? spec.bind.kind : undefined;
		if (kind === "text") {
			if (n) errs.push(`html：文本输入 ${sid} 没有几何，不得有 data-slot="${sid}" 元素（实际 ${n} 个）`);
		} else if (n !== 1) {
			errs.push(`html：槽位 ${sid} 应恰有 1 个 data-slot="${sid}" 元素，实际 ${n} 个`);
		}
	}
	for (const sid of sortedStr([...facts.slotCounts.keys()].filter((s) => !(s in slots)))) {
		errs.push(`html：data-slot="${sid}" 未在元数据块中声明`);
	}
	if (facts.mediaTags.length) errs.push(`html：html@1 颗粒不得含 <audio> / <video>（发现 ${JSON.stringify(sortedStr([...new Set(facts.mediaTags)]))}）`);
	return errs;
}

/** 校验元数据块；给了颗粒 HTML 时一并校验舞台根、槽位元素与媒体元素。返回错误清单（空 = 合法）。 */
export function validateCompositeBlock(block: unknown, html?: string): string[] {
	if (!isObj(block)) return ["$：元数据块必须为对象"];
	const errs = [...checkDecl(block), ...checkResolved(block)];
	if (html !== undefined) errs.push(...checkHtml(block, html));
	return errs;
}
