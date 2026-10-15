/**
 * 合成层候选窗口（change add-composite-layer，design D1 / D1a / D1b）：三种入口 + 审定，产 `struct_meta.composite`。
 *
 * 与 `gtrk split` 写 `struct_meta.split` 同一套做法：命令写一个键，客户端在大纲那一行只读呈现（这里是 CP 行）。
 * 本模块纯函数、零 I/O：输入是投影好的句子（`projectTranscript` 的产物）与工程里算好的几样事实，
 * 输出是整份新的 `struct_meta.composite` 与人读审稿稿。
 *
 * - full：整片首尾相接铺满；单窗 5–25 秒、在句界断开（有拆分派单时优先在 beat 边界断开）。
 * - auto：按信号打分挑窗口，总时长不超过密度上限；超出的记 `trimmed` 并列出，不静默丢。
 * - ranges：用户给区间（时间或句 id），吸附到句界、投影到帧格，吸附量逐条写明；直接记为 `approved`。
 * - 重跑：`built` 原样保留、`rejected` 保留且该区间不再提；其余整键替换。
 */
import { r3, sec2ms } from "./frame-domain";
import { snapSec } from "./composite-scene";

export const COMPOSITE_PLAN_CONTRACT = "v1";
export const COMPOSITE_DENSITY_DEFAULT = 0.25;
export const WINDOW_MIN_SEC = 5;
export const WINDOW_MAX_SEC = 25;
const WINDOW_TARGET_SEC = 12;
const AUTO_MIN_SEC = 2;

export type WindowState = "proposed" | "approved" | "rejected" | "built" | "trimmed";
export type PlanMode = "full" | "auto" | "ranges";

export interface PlanWindow {
	id: string;
	state: WindowState;
	track_st: number;
	track_ed: number;
	span: { from: string; to: string };
	source_ranges: Array<{ st: number; ed: number }>;
	reason: string;
	signals?: string[];
	score?: number;
	layout_hint?: { pictures: "single" | "sequence" | "pair" | "row"; why: string };
	composition_id?: string;
}

export interface CompositePlanMeta {
	contract_version: string;
	transcript_hash: string;
	projected_at: string;
	material_id?: string;
	mode: PlanMode;
	density?: number;
	windows: PlanWindow[];
}

/** 时间线上保留下来的一句（投影后）。 */
export interface PlanUtterance {
	id: string;
	text: string;
	st: number;
	ed: number;
	/** 源时基包络（秒）。 */
	src_st: number;
	src_ed: number;
}

export interface PlanInput {
	rate: number;
	/** 已按时间线起点升序、只含保留句。 */
	utterances: PlanUtterance[];
	/** 片尾（口播主轨最后一段的终点）。 */
	end: number;
	/** 各条 B-roll 候选轨上片段的起点（秒）。 */
	brollStarts: number[][];
	/** 已在工程里的不透明满屏颗粒（非合成）区间。 */
	opaqueParticles: Array<{ id: string; st: number; ed: number }>;
	/** 拆分派单的 beat（用句 id 区间），有则 full / auto 优先按它断开。 */
	splitBeats?: Array<{ id: string; from: string; to: string }>;
	/** 转写里全部句 id 的原始顺序（含已剪掉的句）；beat 区间按它定位。缺省按 `utterances` 顺序。 */
	allIds?: string[];
	existing?: CompositePlanMeta | null;
	transcriptHash: string;
	materialId?: string;
	now: string;
}

// ------------------------------------------------------------------ 工具

const overlap = (a: { st: number; ed: number }, b: { st: number; ed: number }) => Math.max(0, Math.min(a.ed, b.ed) - Math.max(a.st, b.st));
const winOf = (w: PlanWindow) => ({ st: w.track_st, ed: w.track_ed });

/** 句的序号区间 [i, j] → 窗口骨架（起止取句界，吸附帧格）。 */
function windowFromUtterances(inp: PlanInput, i: number, j: number, st?: number, ed?: number): Omit<PlanWindow, "id" | "state" | "reason"> {
	const U = inp.utterances;
	return {
		track_st: snapSec(st ?? U[i].st, inp.rate),
		track_ed: snapSec(ed ?? U[j].ed, inp.rate),
		span: { from: U[i].id, to: U[j].id },
		source_ranges: [{ st: r3(U[i].src_st), ed: r3(U[j].src_ed) }],
	};
}

/** 把一串句（序号区间）按目标时长切成若干组，返回每组的 [首, 尾] 序号。 */
function groupUtterances(U: PlanUtterance[], lo: number, hi: number, target = WINDOW_TARGET_SEC): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	let a = lo;
	while (a <= hi) {
		let b = a;
		while (b < hi && U[b].ed - U[a].st < target && U[b + 1].ed - U[a].st <= WINDOW_MAX_SEC) b++;
		out.push([a, b]);
		a = b + 1;
	}
	// 末组太短就并进前一组（并完不超上限时）
	if (out.length > 1) {
		const [la, lb] = out[out.length - 1];
		const [pa] = out[out.length - 2];
		if (U[lb].ed - U[la].st < WINDOW_MIN_SEC && U[lb].ed - U[pa].st <= WINDOW_MAX_SEC + WINDOW_MIN_SEC) {
			out.splice(out.length - 2, 2, [pa, lb]);
		}
	}
	return out;
}

/** 切分单元：有拆分派单时按 beat，再把过长的 beat 在句界切开、过短的并进邻居；否则按句分组。 */
function units(inp: PlanInput, lo: number, hi: number, target = WINDOW_TARGET_SEC): Array<[number, number]> {
	const U = inp.utterances;
	const order = new Map((inp.allIds ?? U.map((u) => u.id)).map((id, i) => [id, i]));
	const pos = U.map((u) => order.get(u.id) ?? -1);
	const beats = (inp.splitBeats ?? [])
		.map((b) => {
			// beat 的句可能部分被剪：取区间内仍保留的首尾句
			const lo = order.get(b.from);
			const hi = order.get(b.to);
			if (lo === undefined || hi === undefined) return null;
			const fromAt = pos.findIndex((p) => p >= lo);
			let toAt = -1;
			for (let k = pos.length - 1; k >= 0; k--) if (pos[k] >= 0 && pos[k] <= hi) { toAt = k; break; }
			return fromAt >= 0 && toAt >= fromAt ? ([fromAt, toAt] as [number, number]) : null;
		})
		.filter((x): x is [number, number] => x !== null && x[0] >= lo && x[1] <= hi)
		.sort((x, y) => x[0] - y[0]);
	if (!beats.length) return groupUtterances(U, lo, hi, target);
	// beat 之间的空隙（没被任何 beat 覆盖的句）各自成组
	const cover: Array<[number, number]> = [];
	let cur = lo;
	for (const [a, b] of beats) {
		if (a > cur) cover.push(...groupUtterances(U, cur, a - 1, target));
		if (a >= cur) {
			cover.push(...(U[b].ed - U[a].st > WINDOW_MAX_SEC ? groupUtterances(U, a, b, target) : [[a, b] as [number, number]]));
			cur = b + 1;
		}
	}
	if (cur <= hi) cover.push(...groupUtterances(U, cur, hi, target));
	// 过短的单元并进下一个（并完不超上限时）
	const merged: Array<[number, number]> = [];
	for (const u of cover) {
		const prev = merged[merged.length - 1];
		if (prev && U[prev[1]].ed - U[prev[0]].st < WINDOW_MIN_SEC && U[u[1]].ed - U[prev[0]].st <= WINDOW_MAX_SEC) prev[1] = u[1];
		else merged.push([u[0], u[1]]);
	}
	return merged;
}

/** 固定块（built / rejected）之外的空闲区间里的句序号范围。 */
function freeRanges(inp: PlanInput, fixed: Array<{ st: number; ed: number }>): Array<{ lo: number; hi: number; st: number; ed: number }> {
	const U = inp.utterances;
	const blocks = [...fixed].sort((a, b) => a.st - b.st);
	const gaps: Array<{ st: number; ed: number }> = [];
	let t = 0;
	for (const b of blocks) {
		if (b.st > t) gaps.push({ st: t, ed: b.st });
		t = Math.max(t, b.ed);
	}
	if (inp.end > t) gaps.push({ st: t, ed: inp.end });
	const out: Array<{ lo: number; hi: number; st: number; ed: number }> = [];
	for (const g of gaps) {
		const inside = U.map((u, i) => ({ u, i })).filter(({ u }) => (u.st + u.ed) / 2 >= g.st && (u.st + u.ed) / 2 < g.ed);
		if (inside.length) out.push({ lo: inside[0].i, hi: inside[inside.length - 1].i, st: g.st, ed: g.ed });
	}
	return out;
}

function keptFromExisting(existing: CompositePlanMeta | null | undefined): PlanWindow[] {
	return (existing?.windows ?? []).filter((w) => w.state === "built" || w.state === "rejected");
}

function assignIds(fixed: PlanWindow[], fresh: Array<Omit<PlanWindow, "id">>): PlanWindow[] {
	const used = new Set(fixed.map((w) => w.id));
	let n = 0;
	const next = () => {
		do n++;
		while (used.has(`W${String(n).padStart(2, "0")}`));
		const id = `W${String(n).padStart(2, "0")}`;
		used.add(id);
		return id;
	};
	const all = [...fixed, ...fresh.sort((a, b) => a.track_st - b.track_st).map((w) => ({ id: next(), ...w }) as PlanWindow)];
	return all.sort((a, b) => a.track_st - b.track_st || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------ 信号（auto）

const RE_LIST_MARK = /(第[一二三四五六七八九十\d]+[个点条是]?|首先|其次|再次|最后|一是|二是|三是|一方面|另一方面|包括|还有)/g;
const RE_CONTRAST = /(但是|可是|然而|而是|不是|相比|反而|对比|反过来|却|一边|如果)/g;
// 单个「一」（一个女生、一种感觉）是口语，不算「具体的量」
const RE_NUMBER = /(\d+|[两三四五六七八九十百千万]|[一二两三四五六七八九十百千万]{2,})(个|种|步|条|点|年|岁|倍|成|%|万|亿|次|分钟|小时|天|句)/;
const RE_STEP = /(第[一二三四五六七八九十\d]+步|接下来|第一步|最后一步)/;

interface Scored {
	lo: number;
	hi: number;
	score: number;
	signals: string[];
	reasons: string[];
	hint: PlanWindow["layout_hint"];
}

function maxStartsIn(starts: number[], st: number, ed: number, span = 6): number {
	const xs = starts.filter((x) => x >= st && x < ed).sort((a, b) => a - b);
	let best = 0;
	for (let i = 0, j = 0; i < xs.length; i++) {
		while (xs[i] - xs[j] >= span) j++;
		best = Math.max(best, i - j + 1);
	}
	return best;
}

function scoreChunk(inp: PlanInput, lo: number, hi: number, isFirst: boolean, isLast: boolean): Scored {
	const U = inp.utterances;
	const text = U.slice(lo, hi + 1).map((u) => u.text).join("，");
	const st = U[lo].st;
	const ed = U[hi].ed;
	const signals: string[] = [];
	const reasons: string[] = [];
	let score = 0;
	let hint: PlanWindow["layout_hint"] = { pictures: "single", why: "没有对照或并列，一画即可" };
	const broll = Math.max(0, ...inp.brollStarts.map((s) => maxStartsIn(s, st, ed)));
	if (broll >= 3) {
		// 几秒内连着多个短镜头是合成的头号场景（explore §16.2），权重高于单个文字信号
		score += broll >= 4 ? 0.55 : 0.45;
		signals.push("broll-dense");
		reasons.push(`6 秒内有 ${broll} 个 B-roll 短镜头`);
		hint = { pictures: "sequence", why: "逐句换成这句说到的画面；不按粗剪轨数并排" };
	}
	const listMarks = text.match(RE_LIST_MARK)?.length ?? 0;
	const enumItems = (text.match(/[^，。！？、\s]{1,8}、[^，。！？、\s]{1,8}(、[^，。！？、\s]{1,8})*/g) ?? []).reduce((n, s) => Math.max(n, s.split("、").length), 0);
	if (listMarks >= 2 || enumItems >= 3) {
		score += 0.3;
		signals.push("list");
		reasons.push(enumItems >= 3 ? `列举了 ${enumItems} 项` : "有列举 / 分点");
		hint = { pictures: "row", why: "并列的几件事，说到哪件亮哪张" };
	}
	const contrast = text.match(RE_CONTRAST)?.length ?? 0;
	if (contrast >= 1) {
		score += 0.25;
		signals.push("contrast");
		reasons.push("有对照 / 转折");
		if (hint.pictures !== "row") hint = { pictures: "pair", why: "说到对照的那一刻再拆成两画，此前一画" };
	}
	if (RE_NUMBER.test(text)) {
		score += 0.15;
		signals.push("number");
		reasons.push("有具体数字或量");
	}
	if (RE_STEP.test(text)) {
		score += 0.15;
		signals.push("step");
		reasons.push("章节 / 步骤转折");
	}
	if (isFirst) {
		score += 0.2;
		signals.push("opening");
		reasons.push("开场");
	}
	if (isLast) {
		score += 0.15;
		signals.push("closing");
		reasons.push("收尾");
	}
	return { lo, hi, score: Math.round(score * 100) / 100, signals, reasons, hint };
}

// ------------------------------------------------------------------ 三种入口

export function planFull(inp: PlanInput): CompositePlanMeta {
	const fixed = keptFromExisting(inp.existing);
	const fresh: Array<Omit<PlanWindow, "id">> = [];
	for (const g of freeRanges(inp, fixed.map(winOf))) {
		const us = units(inp, g.lo, g.hi);
		us.forEach(([a, b], k) => {
			// 首尾相接：窗口起点 = 本组首句起点（第一组取空闲区间起点），终点 = 下一组首句起点（末组取空闲区间终点）
			const st = k === 0 ? g.st : inp.utterances[a].st;
			const ed = k === us.length - 1 ? g.ed : inp.utterances[us[k + 1][0]].st;
			const sc = scoreChunk(inp, a, b, false, false);
			fresh.push({
				state: "proposed",
				...windowFromUtterances(inp, a, b, st, ed),
				reason: sc.reasons.length ? `整片铺满；${sc.reasons.join("，")}` : "整片铺满",
				signals: sc.signals,
				layout_hint: sc.hint,
			});
		});
	}
	return meta(inp, "full", assignIds(fixed, fresh));
}

export function planAuto(inp: PlanInput, density = COMPOSITE_DENSITY_DEFAULT): CompositePlanMeta {
	const fixed = keptFromExisting(inp.existing);
	const rejected = fixed.filter((w) => w.state === "rejected").map(winOf);
	const built = fixed.filter((w) => w.state === "built").map(winOf);
	const U = inp.utterances;
	const cands: Scored[] = [];
	const all = U.length ? units(inp, 0, U.length - 1, 10) : [];
	all.forEach(([a, b], k) => {
		const w = { st: U[a].st, ed: U[b].ed };
		if (w.ed - w.st < AUTO_MIN_SEC) return;
		if (built.some((x) => overlap(x, w) > 0)) return;
		if (rejected.some((x) => overlap(x, w) > 0.5 * (w.ed - w.st))) return;
		if (inp.opaqueParticles.some((p) => overlap(p, w) > 0.5 * (w.ed - w.st))) return;
		const sc = scoreChunk(inp, a, b, k === 0, k === all.length - 1);
		if (sc.score > 0) cands.push(sc);
	});
	const budget = density * inp.end - built.reduce((n, w) => n + (w.ed - w.st), 0);
	let used = 0;
	const fresh: Array<Omit<PlanWindow, "id">> = [];
	for (const c of [...cands].sort((x, y) => y.score - x.score || U[x.lo].st - U[y.lo].st)) {
		const len = U[c.hi].ed - U[c.lo].st;
		const fits = used + len <= budget + 1e-6;
		if (fits) used += len;
		fresh.push({
			state: fits ? "proposed" : "trimmed",
			...windowFromUtterances(inp, c.lo, c.hi),
			reason: fits ? c.reasons.join("，") : `${c.reasons.join("，")}（超出密度上限 ${Math.round(density * 100)}%，被截掉）`,
			signals: c.signals,
			score: c.score,
			layout_hint: c.hint,
		});
	}
	return { ...meta(inp, "auto", assignIds(fixed, fresh)), density };
}

export interface RangeSpec {
	/** 原样记下用户给的写法（回执用）。 */
	raw: string;
	st?: number;
	ed?: number;
	from?: string;
	to?: string;
}

/** `11.2,32` / `11.2-32`（秒）或 `u0004-u0009` / `u0004`（句 id）。 */
export function parseRange(raw: string): RangeSpec {
	const s = raw.trim();
	const ids = /^(u\d+)(?:\s*[-~]\s*(u\d+))?$/i.exec(s);
	if (ids) return { raw, from: ids[1], to: ids[2] ?? ids[1] };
	const secs = /^(\d+(?:\.\d+)?)\s*[,，~-]\s*(\d+(?:\.\d+)?)$/.exec(s);
	if (secs) {
		const st = Number(secs[1]);
		const ed = Number(secs[2]);
		if (!(ed > st)) throw new Error(`区间 ${raw}：终点要大于起点`);
		return { raw, st, ed };
	}
	throw new Error(`看不懂的区间「${raw}」：写成 起秒,止秒（如 11.2,32）或 句 id 区间（如 u0004-u0009）`);
}

export interface RangeSnap {
	window: Omit<PlanWindow, "id" | "state" | "reason">;
	shiftMs: [number, number];
}

/** 区间吸附到句界：起点吸到最近的句首，终点吸到最近的句尾；再投影到帧格。 */
export function snapRange(inp: PlanInput, r: RangeSpec): RangeSnap {
	const U = inp.utterances;
	if (!U.length) throw new Error("没有可用的句子（transcript 投影为空）");
	if (r.from) {
		const a = U.findIndex((u) => u.id === r.from);
		const b = U.findIndex((u) => u.id === r.to);
		if (a < 0) throw new Error(`句 ${r.from} 不在时间线上（不存在或已被剪掉）`);
		if (b < 0) throw new Error(`句 ${r.to} 不在时间线上（不存在或已被剪掉）`);
		if (b < a) throw new Error(`区间 ${r.raw}：句序倒置`);
		return { window: windowFromUtterances(inp, a, b), shiftMs: [0, 0] };
	}
	const st = r.st as number;
	const ed = r.ed as number;
	let a = 0;
	for (let i = 0; i < U.length; i++) if (Math.abs(U[i].st - st) < Math.abs(U[a].st - st)) a = i;
	let b = U.length - 1;
	for (let i = 0; i < U.length; i++) if (Math.abs(U[i].ed - ed) < Math.abs(U[b].ed - ed)) b = i;
	if (b < a) b = a;
	const w = windowFromUtterances(inp, a, b);
	return { window: w, shiftMs: [sec2ms(w.track_st - st), sec2ms(w.track_ed - ed)] };
}

export function planRanges(inp: PlanInput, ranges: RangeSpec[]): { plan: CompositePlanMeta; shifts: Array<{ raw: string; id: string; shiftMs: [number, number] }> } {
	const fixed = keptFromExisting(inp.existing);
	const fresh: Array<Omit<PlanWindow, "id"> & { _raw: string; _shift: [number, number] }> = [];
	for (const r of ranges) {
		const s = snapRange(inp, r);
		const clash = [...fixed.filter((w) => w.state === "built"), ...fresh.map((f) => ({ ...f, id: f._raw }) as PlanWindow)].find(
			(w) => overlap(winOf(w), { st: s.window.track_st, ed: s.window.track_ed }) > 0,
		);
		if (clash) throw new Error(`区间 ${r.raw} 与 ${clash.id} 重叠`);
		fresh.push({ state: "approved", ...s.window, reason: `用户指定（${r.raw}）`, _raw: r.raw, _shift: s.shiftMs });
	}
	const windows = assignIds(
		fixed,
		fresh.map(({ _raw, _shift, ...w }) => w),
	);
	const shifts = fresh.map((f) => ({
		raw: f._raw,
		id: windows.find((w) => w.track_st === f.track_st && w.track_ed === f.track_ed)?.id ?? "?",
		shiftMs: f._shift,
	}));
	return { plan: meta(inp, "ranges", windows), shifts };
}

function meta(inp: PlanInput, mode: PlanMode, windows: PlanWindow[]): CompositePlanMeta {
	return {
		contract_version: COMPOSITE_PLAN_CONTRACT,
		transcript_hash: inp.transcriptHash,
		projected_at: inp.now,
		...(inp.materialId ? { material_id: inp.materialId } : {}),
		mode,
		windows,
	};
}

// ------------------------------------------------------------------ 审定

export interface ReviewOps {
	approve?: string[];
	reject?: string[];
	approveAll?: boolean;
	/** `W02=80,90.9` */
	adjust?: string[];
	/** `80,90.9` / `u0012-u0015`：补一个窗口（直接 approved） */
	add?: string[];
}

export interface ReviewChange {
	id: string;
	action: "approve" | "reject" | "adjust" | "add";
	from?: WindowState;
	shiftMs?: [number, number];
}

/** 改状态 / 调起止 / 补窗口；未知 id 抛错（调用方零写入）。 */
export function reviewPlan(inp: PlanInput, plan: CompositePlanMeta, ops: ReviewOps): { plan: CompositePlanMeta; changes: ReviewChange[] } {
	const windows = plan.windows.map((w) => ({ ...w }));
	const byId = new Map(windows.map((w) => [w.id, w]));
	const known = () => [...byId.keys()].join(", ") || "（无）";
	const need = (id: string) => {
		const w = byId.get(id);
		if (!w) throw new Error(`没有窗口 ${id}；现有：${known()}`);
		return w;
	};
	const changes: ReviewChange[] = [];
	for (const id of ops.reject ?? []) {
		const w = need(id);
		if (w.state === "built") throw new Error(`${id} 已经做成颗粒铺进工程了；不要它就在客户端删掉那颗合成，再重跑 plan`);
		changes.push({ id, action: "reject", from: w.state });
		w.state = "rejected";
	}
	for (const id of ops.approve ?? []) {
		const w = need(id);
		if (w.state === "built") continue;
		changes.push({ id, action: "approve", from: w.state });
		w.state = "approved";
	}
	if (ops.approveAll) {
		for (const w of windows) {
			if (w.state === "proposed") {
				changes.push({ id: w.id, action: "approve", from: w.state });
				w.state = "approved";
			}
		}
	}
	for (const a of ops.adjust ?? []) {
		const m = /^\s*(W\d+)\s*=\s*(.+)$/i.exec(a);
		if (!m) throw new Error(`--adjust 写成 W02=起秒,止秒（或 W02=u0012-u0015），拿到「${a}」`);
		const w = need(m[1].toUpperCase());
		if (w.state === "built") throw new Error(`${w.id} 已经做成颗粒了，调起止要先在客户端删掉那颗合成`);
		const s = snapRange(inp, parseRange(m[2]));
		const clash = windows.find((x) => x !== w && x.state !== "rejected" && x.state !== "trimmed" && overlap(winOf(x), { st: s.window.track_st, ed: s.window.track_ed }) > 0);
		if (clash) throw new Error(`${w.id} 调到 ${m[2]} 会与 ${clash.id} 重叠`);
		Object.assign(w, s.window, { state: "approved" as WindowState, reason: `${w.reason}；用户调整为 ${m[2]}` });
		changes.push({ id: w.id, action: "adjust", shiftMs: s.shiftMs });
	}
	for (const raw of ops.add ?? []) {
		const s = snapRange(inp, parseRange(raw));
		const clash = windows.find((x) => x.state !== "rejected" && x.state !== "trimmed" && overlap(winOf(x), { st: s.window.track_st, ed: s.window.track_ed }) > 0);
		if (clash) throw new Error(`补的区间 ${raw} 与 ${clash.id} 重叠`);
		const used = new Set(windows.map((w) => w.id));
		let n = windows.length + 1;
		while (used.has(`W${String(n).padStart(2, "0")}`)) n++;
		const nw: PlanWindow = { id: `W${String(n).padStart(2, "0")}`, state: "approved", ...s.window, reason: `用户补充（${raw}）` };
		windows.push(nw);
		byId.set(nw.id, nw);
		changes.push({ id: nw.id, action: "add", shiftMs: s.shiftMs });
	}
	windows.sort((a, b) => a.track_st - b.track_st || a.id.localeCompare(b.id));
	return { plan: { ...plan, windows }, changes };
}

// ------------------------------------------------------------------ 铺轨后登记

/** 窗口 → 合成颗粒 id（同一工程内唯一、ASCII）。scaffold 用它起场景名，lay 用它认窗口。 */
export const compositionIdOf = (windowId: string): string => `cp-${windowId.toLowerCase()}`;

/** 一段时间线区间里的句（有交集的）→ 句 id 区间与源包络；没有句时返回 null。 */
function spanOf(inp: PlanInput, st: number, ed: number): Pick<PlanWindow, "span" | "source_ranges"> | null {
	const hit = inp.utterances.filter((u) => u.ed > st && u.st < ed);
	if (!hit.length) return null;
	const a = hit[0];
	const b = hit[hit.length - 1];
	return { span: { from: a.id, to: b.id }, source_ranges: [{ st: r3(a.src_st), ed: r3(b.src_ed) }] };
}

/**
 * 铺轨后的登记：铺上的颗粒对应的窗口记 `built` 并挂 `composition_id`（起止以颗粒为准）；
 * 不经 plan 直接构建的颗粒补一个 `built` 窗口；之前 `built`、这次已不在轨上的窗口退回 `approved`。
 * 没有现成候选、也没有转写（算不出句区间）时返回 null（调用方不写这个键）。
 */
export function markBuilt(
	inp: PlanInput | null,
	plan: CompositePlanMeta | null,
	laid: Array<{ id: string; track_st: number; track_ed: number }>,
	live: Set<string>,
	meta: { transcriptHash: string; materialId?: string; now: string },
): CompositePlanMeta | null {
	if (!plan && !inp) return null;
	const base: CompositePlanMeta = plan ?? {
		contract_version: COMPOSITE_PLAN_CONTRACT,
		transcript_hash: meta.transcriptHash,
		projected_at: meta.now,
		...(meta.materialId ? { material_id: meta.materialId } : {}),
		mode: "ranges",
		windows: [],
	};
	const windows = base.windows.map((w) => ({ ...w }));
	for (const it of laid) {
		const w = windows.find((x) => x.composition_id === it.id) ?? windows.find((x) => compositionIdOf(x.id) === it.id);
		if (w) {
			w.state = "built";
			w.composition_id = it.id;
			if (Math.abs(w.track_st - it.track_st) > 5e-4 || Math.abs(w.track_ed - it.track_ed) > 5e-4) {
				w.track_st = it.track_st;
				w.track_ed = it.track_ed;
				const s = inp ? spanOf(inp, it.track_st, it.track_ed) : null;
				if (s) Object.assign(w, s);
			}
			continue;
		}
		const s = inp ? spanOf(inp, it.track_st, it.track_ed) : null;
		if (!s) continue;
		const used = new Set(windows.map((x) => x.id));
		let n = windows.length + 1;
		while (used.has(`W${String(n).padStart(2, "0")}`)) n++;
		windows.push({ id: `W${String(n).padStart(2, "0")}`, state: "built", track_st: it.track_st, track_ed: it.track_ed, ...s, reason: "直接构建（不经 plan）", composition_id: it.id });
	}
	for (const w of windows) {
		if (w.state === "built" && !(w.composition_id && live.has(w.composition_id))) {
			w.state = "approved";
			delete w.composition_id;
		}
	}
	windows.sort((a, b) => a.track_st - b.track_st || a.id.localeCompare(b.id));
	return { ...base, windows };
}

// ------------------------------------------------------------------ 写方契约自检

const STATES: readonly string[] = ["proposed", "approved", "rejected", "built", "trimmed"];
const PICTURES: readonly string[] = ["single", "sequence", "pair", "row"];

/** 单个窗口是否合乎写方契约（composite-command「struct_meta.composite 的写方契约」）；返回问题清单。 */
export function checkPlanWindow(w: unknown): string[] {
	const e: string[] = [];
	if (!w || typeof w !== "object") return ["窗口必须为对象"];
	const x = w as Record<string, unknown>;
	const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
	if (!(typeof x.id === "string" && x.id)) e.push("id 必须为非空字符串");
	if (!STATES.includes(x.state as string)) e.push(`state 必须为 ${STATES.join(" / ")}`);
	if (!(num(x.track_st) && num(x.track_ed) && (x.track_st as number) >= 0 && (x.track_ed as number) > (x.track_st as number))) e.push("track_st / track_ed 必须为数字且起点小于终点");
	const sp = x.span as Record<string, unknown> | undefined;
	if (!(sp && typeof sp.from === "string" && typeof sp.to === "string")) e.push("span 必须为 { from, to } 句 id");
	const sr = x.source_ranges;
	if (!(Array.isArray(sr) && sr.length && sr.every((r) => r && num(r.st) && num(r.ed) && r.ed > r.st))) e.push("source_ranges 必须为非空 { st, ed }[] 且 ed > st");
	if (typeof x.reason !== "string") e.push("reason 必须为字符串");
	if (x.signals !== undefined && !(Array.isArray(x.signals) && x.signals.every((s) => typeof s === "string"))) e.push("signals 必须为字符串数组");
	if (x.score !== undefined && !num(x.score)) e.push("score 必须为数字");
	if (x.layout_hint !== undefined) {
		const h = x.layout_hint as Record<string, unknown>;
		if (!(h && PICTURES.includes(h.pictures as string) && typeof h.why === "string")) e.push(`layout_hint 必须为 { pictures: ${PICTURES.join(" | ")}, why }`);
	}
	if (x.state === "built" && !(typeof x.composition_id === "string" && x.composition_id)) e.push("built 窗口必须带 composition_id");
	return e;
}

/** 整份 `struct_meta.composite` 的顶层检查 + 逐窗口检查。 */
export function checkPlanMeta(m: unknown): { top: string[]; windows: Record<string, string[]> } {
	const top: string[] = [];
	const windows: Record<string, string[]> = {};
	if (!m || typeof m !== "object") return { top: ["必须为对象"], windows };
	const x = m as Record<string, unknown>;
	if (x.contract_version !== COMPOSITE_PLAN_CONTRACT) top.push(`contract_version 必须为 "${COMPOSITE_PLAN_CONTRACT}"`);
	if (typeof x.transcript_hash !== "string") top.push("transcript_hash 必须为字符串");
	if (typeof x.projected_at !== "string") top.push("projected_at 必须为字符串");
	if (!["full", "auto", "ranges"].includes(x.mode as string)) top.push("mode 必须为 full / auto / ranges");
	if (!Array.isArray(x.windows)) top.push("windows 必须为数组");
	else
		x.windows.forEach((w, i) => {
			const errs = checkPlanWindow(w);
			if (errs.length) windows[String((w as { id?: unknown })?.id ?? `#${i}`)] = errs;
		});
	return { top, windows };
}

// ------------------------------------------------------------------ 审稿稿

const STATE_TEXT: Record<WindowState, string> = {
	proposed: "待审",
	approved: "已采纳",
	rejected: "不要",
	built: "已做",
	trimmed: "超出上限",
};
const PICTURES_TEXT: Record<string, string> = { single: "一画", sequence: "逐句换画面", pair: "并排两画", row: "并列几张" };
const MODE_TEXT: Record<PlanMode, string> = { full: "整片铺满", auto: "AI 判定", ranges: "用户指定区间" };

const clock = (s: number) => {
	const m = Math.floor(s / 60);
	return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
};

/** 由 `struct_meta.composite` 单向渲染的审稿稿（不回读）。 */
export function renderPlanMd(plan: CompositePlanMeta, inp: Pick<PlanInput, "utterances" | "end">): string {
	const U = inp.utterances;
	const textOf = (w: PlanWindow) => {
		const a = U.findIndex((u) => u.id === w.span.from);
		const b = U.findIndex((u) => u.id === w.span.to);
		const t = a >= 0 && b >= a ? U.slice(a, b + 1).map((u) => u.text).join("，") : "";
		return t.length > 80 ? `${t.slice(0, 80)}…` : t;
	};
	const live = plan.windows.filter((w) => w.state !== "trimmed" && w.state !== "rejected");
	const covered = live.reduce((n, w) => n + (w.track_ed - w.track_st), 0);
	const lines = [
		"# 合成层候选窗口",
		"",
		`- 入口：${MODE_TEXT[plan.mode]}${plan.density !== undefined ? `（密度上限 ${Math.round(plan.density * 100)}%）` : ""}`,
		`- 生成时刻：${plan.projected_at}`,
		`- 覆盖：${covered.toFixed(1)} 秒 / 全片 ${inp.end.toFixed(1)} 秒（${inp.end > 0 ? Math.round((covered / inp.end) * 100) : 0}%）`,
		"- 在客户端大纲的 CP 行能看到这些窗口（虚线框 = 待审，加浅底 = 已采纳）。在对话里说「W01、W03 要，W02 不要，W04 改到 80 到 90.9 秒」即可。",
		"",
		"| 窗口 | 起止 | 状态 | 为什么 | 建议画面 | 这段在说什么 |",
		"|---|---|---|---|---|---|",
	];
	for (const w of plan.windows.filter((w) => w.state !== "trimmed")) {
		const hint = w.layout_hint ? `${PICTURES_TEXT[w.layout_hint.pictures] ?? w.layout_hint.pictures}：${w.layout_hint.why}` : "—";
		lines.push(`| ${w.id} | ${clock(w.track_st)}–${clock(w.track_ed)} | ${STATE_TEXT[w.state]}${w.composition_id ? `（${w.composition_id}）` : ""} | ${w.reason} | ${hint} | ${textOf(w)} |`);
	}
	const trimmed = plan.windows.filter((w) => w.state === "trimmed");
	if (trimmed.length) {
		lines.push("", "## 超出密度上限被截掉的候选", "", "想要哪个就说「把 W07 也加上」。", "", "| 窗口 | 起止 | 分数 | 为什么 | 这段在说什么 |", "|---|---|---|---|---|");
		for (const w of trimmed) lines.push(`| ${w.id} | ${clock(w.track_st)}–${clock(w.track_ed)} | ${w.score ?? "—"} | ${w.reason} | ${textOf(w)} |`);
	}
	return `${lines.join("\n")}\n`;
}
