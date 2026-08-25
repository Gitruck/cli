/**
 * `gtrk patch <move|trim|split|set>` —— `.gtrk` 元素级结构化编辑的唯一入口
 * （openspec: add-patch-command）。
 *
 * 治的病是 N3：`.gtrk` 一个片段有**两套时码**（`clip_st+clip_ed` 与 `clip_st+duration`），
 * 客户端 importer 优先读 `clip_ed`，而后端 Profile A 反而**不强校验**它 ⇒ 改一份不改另一份
 * 就是**静默失败**（命令报成功、导入用陈旧出点）。故 agent MUST NOT 裸手改 JSON。
 *
 * 形态铁律（沿 `tool` 族 D1 / `oralcut-result` D2 教训）：**顶层命令 + 首个 positional 词内部分派**，
 * MUST NOT 用 commander 父子命令 —— 那会吞选项。
 *
 * 算与校验全在 `../lib/gtrk-patch`（纯函数、零 IO）；读写复用 `../lib/gtrk-writeback`。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import { routeLogsToStderr, log } from "../lib/log";
import { readGtrk, assertGtrkV1, writeGtrkAtomic } from "../lib/gtrk-writeback";
import {
	type ActionKind,
	type Element,
	type TrackKind,
	type Violation,
	applyMove,
	applySplit,
	applyTrim,
	classOf,
	collectElements,
	decideSetForm,
	derive,
	diffViolations,
	insertElement,
	isTimecodeAction,
	locatorOf,
	maxTrackEdMs,
	ms2sec,
	nextSplitId,
	parseTimeArg,
	replaceElement,
	resolveByClipId,
	resolveByTrackAt,
	sec2ms,
	f2ms,
	validateAll,
	videoRateOf,
	viewOf,
	writeDerived,
} from "../lib/gtrk-patch";

const ACTIONS: ActionKind[] = ["move", "trim", "split", "set"];
/** 保留字：MUST NOT 用作动作名（沿 `tool` 族 D1 的保留字先例）。 */
const RESERVED = new Set(["list", "help"]);

export interface PatchOpts {
	project?: string;
	gtrk?: string;
	clip?: string;
	track?: string;
	at?: string;
	/** split 的切点。⚠️ 独立于 `--at`（寻址用）—— 见 design D10：一个 flag 只能有一个意思。 */
	cut?: string;
	to?: string;
	in?: string;
	out?: string;
	setIn?: string;
	setOut?: string;
	slip?: string;
	// set 的参数面（元素级）
	muted?: boolean;
	volume?: string;
	opaque?: boolean;
	// set 的工程级 op
	total?: string;
	ops?: string;
	dryRun?: boolean;
	json?: boolean;
}

/** 回执里一条 op 的结果。 */
interface OpReceipt {
	action: ActionKind;
	scope: "element" | "project";
	/** 工程级 op（`--total`）恒为 null；元素级 op 回**每个**被改元素的定位三元组。 */
	resolved: Array<{ track: string; clip_id: string; track_st: number }> | null;
	before?: Record<string, number | null>;
	after?: Record<string, number | null>;
	note?: string;
}

interface Receipt {
	applied: boolean;
	gtrk: string;
	video_rate: number;
	ops: OpReceipt[];
	warnings: Array<Record<string, unknown>>;
	preexisting: Violation[];
}

class PatchError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
	}
}

function fail(code: string, message: string): never {
	throw new PatchError(message, code);
}

// ────────────────────────────── 路径定位（沿 split 的候选序） ──────────────────────────────

function resolveGtrkPath(opts: PatchOpts): string {
	const project = opts.project ? resolve(opts.project) : undefined;
	let p: string;
	if (opts.gtrk) p = resolve(opts.gtrk);
	else if (project) {
		const cands = [join(project, "gtrk", "project.gtrk"), join(project, "project.gtrk")];
		p = cands.find((c) => existsSync(c)) ?? cands[0];
	} else fail("no_project", "需 --project <目录> 或显式 --gtrk <path>");
	if (!existsSync(p)) fail("gtrk_not_found", `找不到工程文件：${p}`);
	return p;
}

// ────────────────────────────── 寻址 ──────────────────────────────

function parseTrackSpec(spec: string): { kind: TrackKind; index: number } {
	const m = /^(video|audio|beat):(\d+)$/.exec(spec.trim());
	if (!m) fail("bad_track_spec", `--track 形如 video:0 / audio:1 / beat:100，读到「${spec}」`);
	return { kind: m[1] as TrackKind, index: Number(m[2]) };
}

function candidateLines(els: Element[], rate: number): string {
	return els
		.map((e) => {
			const l = locatorOf(e, rate);
			const dur = e.clip.duration;
			return `  · ${l.track}  clip_id=${l.clip_id || '""'}  track_st=${l.track_st}s  duration=${String(dur)}s`;
		})
		.join("\n");
}

/**
 * 解析寻址，按 P8 分流。
 * @param action 用于判「时码类 vs 参数类」——镜像对上参数类 MUST 硬拒消歧。
 */
function resolveTargets(gtrk: Record<string, unknown>, opts: PatchOpts, action: ActionKind, rate: number): Element[] {
	const hasClip = opts.clip !== undefined;
	const hasTrackAt = opts.track !== undefined || opts.at !== undefined;
	if (hasClip && hasTrackAt) fail("addr_conflict", "--clip 与 --track/--at 互斥，二选一");
	if (!hasClip && !hasTrackAt) fail("addr_missing", "需 --clip <clip_id> 或 --track <kind:index> --at <sec>");

	if (hasClip) {
		const r = resolveByClipId(gtrk, opts.clip!);
		switch (r.kind) {
			case "gap-not-addressable":
				fail(
					"gap_not_addressable",
					'空档（gap）不可经 --clip 寻址（契约让多个 gap 合法共享 clip_id=""，它不构成地址）——请用 --track <kind:index> --at <sec>',
				);
			case "none":
				fail("clip_not_found", `工程里没有 clip_id=${opts.clip} 的元素（零副作用，文件未变）`);
			case "single":
				return [...r.elements];
			case "mirror-pair":
				if (isTimecodeAction(action)) return [...r.elements];
				fail(
					"mirror_pair_needs_disambiguation",
					`clip_id=${opts.clip} 命中 video/audio 两个投影（契约允许的镜像复用）。` +
						`参数是**投影私有**的，不能替你猜改哪个——请用 --track <video|audio>:<index> --at <sec> 指明：\n` +
						candidateLines([...r.elements], rate),
				);
			case "ambiguous":
				fail(
					"clip_id_ambiguous",
					`clip_id=${opts.clip} 命中 ${r.elements.length} 个元素（同轨重复 id 属存量违规，已容忍不崩但无法据此寻址）。` +
						`请改用 --track/--at：\n${candidateLines(r.elements, rate)}`,
				);
		}
	}

	if (opts.track !== undefined && opts.at === undefined) {
		// 2.14 轨级参数出射程：只给 --track 不给 --at，读起来像「改这条轨」。
		// v1 射程是**元素级**，MUST NOT 写任何轨对象上的键（轨级 muted/volume/hidden）。
		fail(
			"track_level_out_of_scope",
			"--track 单给读起来像「改这整条轨」，但 v1 `patch` 的射程是**元素级**——" +
				"MUST NOT 写轨对象上的键（轨级 muted / volume / hidden 均不在射程内）。" +
				"要改某个元素请补 --at <sec> 指明是轨上哪一个（零副作用，文件未变）",
		);
	}
	if (opts.at === undefined || opts.track === undefined) {
		fail("addr_incomplete", "--track 与 --at 须同时给出");
	}
	const { kind, index } = parseTrackSpec(opts.track);
	const at = parseTimeArg(opts.at);
	if (!at || at.sec === null) fail("bad_at", `--at 须是秒（如 5.0），读到「${opts.at}」`);
	const hits = resolveByTrackAt(gtrk, kind, index, at.sec);
	if (hits.length === 0) fail("track_at_not_found", `${kind}:${index} 在 ${at.sec}s 处没有元素（零副作用）`);
	if (hits.length > 1) {
		fail("track_at_ambiguous", `${kind}:${index} 在 ${at.sec}s 处命中 ${hits.length} 个元素（重叠存量数据）：\n${candidateLines(hits, rate)}`);
	}
	return hits;
}

// ────────────────────────────── 动作执行 ──────────────────────────────

const TIMECODE_KEYS = ["track_st", "track_ed", "duration", "clip_st", "clip_ed"] as const;

function snapshot(clip: Record<string, unknown>): Record<string, number | null> {
	const o: Record<string, number | null> = {};
	for (const k of TIMECODE_KEYS) {
		if (k in clip) o[k] = typeof clip[k] === "number" ? (clip[k] as number) : null;
	}
	return o;
}

function trimArgsOf(opts: PatchOpts) {
	const given = (["in", "out", "setIn", "setOut", "slip"] as const).filter((k) => opts[k] !== undefined);
	if (given.length === 0) fail("trim_no_args", "trim 需给 --in/--out（相对增量）、--set-in/--set-out（绝对时码）或 --slip（只换源窗）之一");
	if (opts.slip !== undefined && given.length > 1) fail("trim_slip_exclusive", "--slip 只换源窗，不能与其它 trim 参数同给");
	if (opts.in !== undefined && opts.setIn !== undefined) fail("trim_in_conflict", "--in 与 --set-in 互斥");
	if (opts.out !== undefined && opts.setOut !== undefined) fail("trim_out_conflict", "--out 与 --set-out 互斥");
	const pick = (raw?: string, name?: string) => {
		if (raw === undefined) return undefined;
		const t = parseTimeArg(raw);
		if (!t) fail("bad_time_arg", `${name} 的时码字面非法：「${raw}」（用 3.5 / 3.5s / 105f）`);
		return t;
	};
	return {
		in: pick(opts.in, "--in"),
		out: pick(opts.out, "--out"),
		setIn: pick(opts.setIn, "--set-in"),
		setOut: pick(opts.setOut, "--set-out"),
		slip: pick(opts.slip, "--slip"),
	};
}

/** 对单个元素跑一个时码类动作，返回改完的整份 gtrk（不改入参）。 */
function applyTimecodeToElement(
	gtrk: Record<string, unknown>,
	el: Element,
	action: ActionKind,
	opts: PatchOpts,
	rate: number,
): { next: Record<string, unknown>; receiptFor: Element } {
	const view = viewOf(el, rate);
	const cls = classOf(el);

	if (action === "move") {
		if (opts.to === undefined) fail("move_no_to", "move 需 --to <sec|Nf> 指定落点");
		const to = parseTimeArg(opts.to);
		if (!to) fail("bad_time_arg", `--to 的时码字面非法：「${opts.to}」`);
		const r = applyMove(view, to, rate);
		if (!r.ok) fail(r.error.code, r.error.message);
		return { next: replaceElement(gtrk, el.ref, writeDerived(el.clip, cls, derive(r.view, rate))), receiptFor: el };
	}

	if (action === "trim") {
		const r = applyTrim(view, trimArgsOf(opts), rate);
		if (!r.ok) fail(r.error.code, r.error.message);
		return { next: replaceElement(gtrk, el.ref, writeDerived(el.clip, cls, derive(r.view, rate))), receiptFor: el };
	}

	// split。⚠️ 切点用 `--cut` 不是 `--at`（design D10）：`--at` 恒为寻址参数，
	// 复用会让 `patch split --track video:0 --at 5.5` 的 5.5 既像地址又像切点。
	if (opts.cut === undefined) fail("split_no_cut", "split 需 --cut <sec|Nf> 指定切点（--at 是寻址参数，不是切点）");
	const at = parseTimeArg(opts.cut);
	if (!at) fail("bad_time_arg", `--cut 的时码字面非法：「${opts.cut}」`);
	const r = applySplit(view, at, rate);
	if (!r.ok) fail(r.error.code, r.error.message);
	const taken = new Set(collectElements(gtrk).map((e) => e.clipId).filter((s) => s !== ""));
	const newId = el.clipId === "" ? "" : nextSplitId(el.clipId, taken, () => randomBytes(2).toString("hex"));
	const firstClip = writeDerived(el.clip, cls, derive(r.result.first, rate));
	const secondClip = { ...writeDerived(el.clip, cls, derive(r.result.second, rate)), clip_id: newId };
	let next = replaceElement(gtrk, el.ref, firstClip);
	next = insertElement(next, el.ref, el.ref.clipArrayIndex + 1, secondClip);
	return { next, receiptFor: el };
}

/** 契约缺省值表（`set` 的三段取值优先级用）。 */
const CONTRACT_DEFAULTS: Record<string, unknown> = { muted: false, volume: 1.0, opaque: false };

function applySetParams(
	gtrk: Record<string, unknown>,
	el: Element,
	opts: PatchOpts,
): { next: Record<string, unknown>; forms: Record<string, string> } {
	const track = (gtrk[`${el.ref.kind}_track`] as Record<string, unknown>[])[el.ref.trackArrayIndex];
	const nextClip = { ...el.clip };
	const forms: Record<string, string> = {};
	const setOne = (key: string, target: unknown) => {
		const form = decideSetForm(target, { trackLevel: track[key], contractDefault: CONTRACT_DEFAULTS[key] });
		if (form === "deleted_key") delete nextClip[key];
		else nextClip[key] = target;
		forms[key] = form;
	};
	if (opts.muted !== undefined) setOne("muted", opts.muted);
	if (opts.opaque !== undefined) setOne("opaque", opts.opaque);
	if (opts.volume !== undefined) {
		const v = Number(opts.volume);
		if (!Number.isFinite(v) || v < 0) fail("bad_volume", `--volume 须是 ≥0 的数（线性增益，不是 dB），读到「${opts.volume}」`);
		setOne("volume", v);
	}
	if (Object.keys(forms).length === 0) fail("set_no_params", "set 需给 --muted / --volume / --opaque 之一，或用 --total 改工程总长");
	return { next: replaceElement(gtrk, el.ref, nextClip), forms };
}

/** `set --total`：唯一的工程级 op。 */
function applyTotal(gtrk: Record<string, unknown>, raw: string, rate: number): { next: Record<string, unknown>; value: number } {
	if (!("duration" in gtrk)) {
		fail(
			"top_duration_absent",
			"顶层 duration 键不在场——缺席即按全轨末端机械算出；新增该键会改变消费与计费口径，故 --total 硬拒。",
		);
	}
	let ms: number;
	if (raw.trim() === "max") ms = maxTrackEdMs(gtrk);
	else {
		const t = parseTimeArg(raw);
		if (!t) fail("bad_time_arg", `--total 须是秒、Nf 或 max，读到「${raw}」`);
		// ⚠️ 顶层 duration MUST NOT 被帧吸附（它不是轨道时基端点）：秒只做毫秒量化、Nf 取 f2ms。
		ms = t.frames !== null ? f2ms(t.frames, rate) : sec2ms(t.sec ?? 0);
	}
	const next = structuredClone(gtrk) as Record<string, unknown>;
	next.duration = ms2sec(ms);
	return { next, value: ms2sec(ms) };
}

// ────────────────────────────── 主流程 ──────────────────────────────

/** `--ops` 的一条 op：与逐个 flag 等价的 JSON 形态。 */
interface OpSpec extends PatchOpts {
	action: ActionKind;
}

/** 读 `--ops <file|->`：`-` 读 stdin。 */
async function readOpsFile(spec: string): Promise<OpSpec[]> {
	const raw =
		spec === "-"
			? await new Promise<string>((res, rej) => {
					let buf = "";
					process.stdin.setEncoding("utf8");
					process.stdin.on("data", (c) => { buf += c; });
					process.stdin.on("end", () => res(buf));
					process.stdin.on("error", rej);
				})
			: readFileSync(resolve(spec), "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		fail("bad_ops_json", `--ops 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
	}
	const arr = Array.isArray(parsed) ? parsed : (parsed as { ops?: unknown })?.ops;
	if (!Array.isArray(arr)) fail("bad_ops_shape", "--ops 须是 op 数组，或 { ops: [...] }");
	arr.forEach((o, i) => {
		const a = (o as OpSpec)?.action;
		if (!ACTIONS.includes(a)) fail("bad_ops_action", `--ops 第 ${i + 1} 条的 action 非法：${JSON.stringify(a)}（合法：${ACTIONS.join(" / ")}）`);
	});
	return arr as OpSpec[];
}

/**
 * 对一份 gtrk 应用**一条** op，返回新 gtrk 与该 op 的回执。
 * 单发与 `--ops` 批量共用本函数 —— 两条路走同一段逻辑，避免长出两份口径。
 */
function applyOneOp(
	gtrk: Record<string, unknown>,
	action: ActionKind,
	opts: PatchOpts,
	rate: number,
): { next: Record<string, unknown>; receipt: OpReceipt } {
	const elementAddrGiven = opts.clip !== undefined || opts.track !== undefined || opts.at !== undefined;
	const elementParamGiven = opts.muted !== undefined || opts.volume !== undefined || opts.opaque !== undefined;

	if (opts.total !== undefined) {
		if (action !== "set") fail("total_wrong_action", "--total 只属 `patch set`");
		if (elementAddrGiven || elementParamGiven) {
			fail(
				"total_not_element_scoped",
				"--total 是工程级 op、不带元素地址；元素级改动请另起一个 op（用 --ops 写成两条有序 op，或分两次调用）",
			);
		}
		const r = applyTotal(gtrk, opts.total, rate);
		return { next: r.next, receipt: { action, scope: "project", resolved: null, after: { duration: r.value } } };
	}

	const targets = resolveTargets(gtrk, opts, action, rate);
	const befores = targets.map((t) => snapshot(t.clip));

	if (action === "set") {
		// 参数类：镜像对已在寻址处硬拒 ⇒ 此处 targets 恒为单元素
		const r = applySetParams(gtrk, targets[0], opts);
		return {
			next: r.next,
			receipt: {
				action,
				scope: "element",
				resolved: [locatorOf(targets[0], rate)],
				note: Object.entries(r.forms).map(([k, f]) => `${k}:${f}`).join(", "),
			},
		};
	}

	// 时码类：镜像对两个投影**同步改**（P8）。逐个应用，每次基于上一步产物重新定位。
	let next = gtrk;
	const resolved: Array<{ track: string; clip_id: string; track_st: number }> = [];
	const relocate = (t: Element) =>
		collectElements(next).find(
			(e) =>
				e.ref.kind === t.ref.kind &&
				e.ref.trackArrayIndex === t.ref.trackArrayIndex &&
				e.ref.clipArrayIndex === t.ref.clipArrayIndex,
		);
	for (const t of targets) {
		resolved.push(locatorOf(t, rate));
		const cur = relocate(t);
		if (!cur) fail("internal_relocate_failed", "内部错误：应用动作后无法重新定位元素");
		next = applyTimecodeToElement(next, cur, action, opts, rate).next;
	}
	const afters = targets.map((t) => {
		const cur = relocate(t);
		return cur ? snapshot(cur.clip) : {};
	});
	return { next, receipt: { action, scope: "element", resolved, before: befores[0], after: afters[0] } };
}

/**
 * `--ops <file|->` 批量事务（P3 推荐案）：**一次读、全算、全校验、一次写**。
 * 任一 op 失败 ⇒ 零写 + 非 0 + 报出**第几条**为何失败。
 */
async function runBatch(words: string[], opts: PatchOpts): Promise<Receipt> {
	if (words.length > 0) {
		fail("ops_with_action", `--ops 自带每条 op 的 action，不该再给动作词「${words[0]}」`);
	}
	const specs = await readOpsFile(opts.ops!);
	if (specs.length === 0) fail("ops_empty", "--ops 是空数组，没有可执行的操作");

	const gtrkPath = resolveGtrkPath(opts);
	const { gtrk: before, mtimeMs } = readGtrk(gtrkPath);
	assertGtrkV1(before);
	const rate = videoRateOf(before);

	let next = before;
	const receipts: OpReceipt[] = [];
	for (const [i, spec] of specs.entries()) {
		try {
			// 每条 op 的 flag 以 spec 为准，路径类选项沿用外层（一次读一次写，路径必须同一份）
			const r = applyOneOp(next, spec.action, { ...spec, gtrk: undefined, project: undefined, ops: undefined }, rate);
			next = r.next;
			receipts.push(r.receipt);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const code = e instanceof PatchError ? e.code : "op_failed";
			fail(code, `--ops 第 ${i + 1} 条（${spec.action}）失败，已零写（文件逐字节未变）：\n${msg}`);
		}
	}

	const { violations, preexisting } = diffViolations(validateAll(before), validateAll(next));
	if (violations.length > 0) {
		const lines = violations.map((v) => `  · [${v.code}] ${v.message}`).join("\n");
		fail("invariant_violated", `批量改动会破坏时码不变量，已拒绝写入（文件逐字节未变）：\n${lines}`);
	}

	const warnings = topDurationWarnings(next);
	const receipt: Receipt = { applied: false, gtrk: gtrkPath, video_rate: rate, ops: receipts, warnings, preexisting };
	if (opts.dryRun) {
		emit(receipt, opts);
		return receipt;
	}
	writeGtrkAtomic(gtrkPath, next, mtimeMs, "patch");
	receipt.applied = true;
	emit(receipt, opts);
	return receipt;
}

/** 顶层 duration 短于全轨末端 ⇒ 出 warning。MUST NOT 自动改写。 */
function topDurationWarnings(gtrk: Record<string, unknown>): Array<Record<string, unknown>> {
	const top = gtrk.duration;
	if (typeof top !== "number") return [];
	const maxEd = ms2sec(maxTrackEdMs(gtrk));
	return maxEd > top ? [{ code: "top_duration_shorter_than_tracks", top_duration: top, max_track_ed: maxEd }] : [];
}

export async function runPatchCommand(words: string[], opts: PatchOpts): Promise<Receipt> {
	if (opts.json) routeLogsToStderr();
	if (opts.ops !== undefined) return runBatch(words, opts);
	const action = words[0] as ActionKind | undefined;
	if (!action) {
		fail("no_action", `用法：gtrk patch <${ACTIONS.join("|")}> …（元素级编辑；agent MUST NOT 裸手改 .gtrk JSON）`);
	}
	if (RESERVED.has(action)) fail("reserved_action", `「${action}」是保留字，不能作动作名。合法动作：${ACTIONS.join(" / ")}`);
	if (!ACTIONS.includes(action)) fail("unknown_action", `未知动作「${action}」。合法动作：${ACTIONS.join(" / ")}`);

	const gtrkPath = resolveGtrkPath(opts);
	const { gtrk: before, mtimeMs } = readGtrk(gtrkPath);
	assertGtrkV1(before);
	const rate = videoRateOf(before);

	// `--total` 是工程级 op，与元素寻址互斥（delta「寻址」Requirement）
	const elementAddrGiven = opts.clip !== undefined || opts.track !== undefined || opts.at !== undefined;
	const elementParamGiven = opts.muted !== undefined || opts.volume !== undefined || opts.opaque !== undefined;
	if (opts.total !== undefined) {
		if (action !== "set") fail("total_wrong_action", "--total 只属 `patch set`");
		if (elementAddrGiven || elementParamGiven) {
			fail(
				"total_not_element_scoped",
				"--total 是工程级 op、不带元素地址；元素级改动请另起一个 op（用 --ops 写成两条有序 op，或分两次调用）",
			);
		}
	}

	const ops: OpReceipt[] = [];
	let next = before;

	if (opts.total !== undefined) {
		const r = applyTotal(next, opts.total, rate);
		next = r.next;
		ops.push({ action, scope: "project", resolved: null, after: { duration: r.value } });
	} else {
		const targets = resolveTargets(next, opts, action, rate);
		const befores = targets.map((t) => snapshot(t.clip));
		if (action === "set") {
			// 参数类：镜像对已在寻址处硬拒 ⇒ 此处 targets 恒为单元素
			const r = applySetParams(next, targets[0], opts);
			next = r.next;
			ops.push({
				action,
				scope: "element",
				resolved: [locatorOf(targets[0], rate)],
				note: Object.entries(r.forms).map(([k, f]) => `${k}:${f}`).join(", "),
			});
		} else {
			// 时码类：镜像对两个投影**同步改**（P8）。逐个应用，每次基于上一步产物重新定位。
			const resolved: Array<{ track: string; clip_id: string; track_st: number }> = [];
			for (const t of targets) {
				resolved.push(locatorOf(t, rate));
				// 重新从当前 next 里取同位置元素（前一次 replaceElement 已深拷贝）
				const cur = collectElements(next).find(
					(e) =>
						e.ref.kind === t.ref.kind &&
						e.ref.trackArrayIndex === t.ref.trackArrayIndex &&
						e.ref.clipArrayIndex === t.ref.clipArrayIndex,
				);
				if (!cur) fail("internal_relocate_failed", "内部错误：应用动作后无法重新定位元素");
				next = applyTimecodeToElement(next, cur, action, opts, rate).next;
			}
			const afters = targets.map((t) => {
				const cur = collectElements(next).find(
					(e) =>
						e.ref.kind === t.ref.kind &&
						e.ref.trackArrayIndex === t.ref.trackArrayIndex &&
						e.ref.clipArrayIndex === t.ref.clipArrayIndex,
				);
				return cur ? snapshot(cur.clip) : {};
			});
			ops.push({ action, scope: "element", resolved, before: befores[0], after: afters[0] });
		}
	}

	// 全档校验：出档集合 \ 入档集合
	const { violations, preexisting } = diffViolations(validateAll(before), validateAll(next));
	if (violations.length > 0) {
		const lines = violations.map((v) => `  · [${v.code}] ${v.message}`).join("\n");
		fail("invariant_violated", `本次改动会破坏时码不变量，已拒绝写入（文件逐字节未变）：\n${lines}`);
	}

	// 顶层 duration 越界只报 warning，MUST NOT 自动改写
	const warnings: Array<Record<string, unknown>> = [];
	const top = next.duration;
	if (typeof top === "number") {
		const maxEd = ms2sec(maxTrackEdMs(next));
		if (maxEd > top) {
			warnings.push({ code: "top_duration_shorter_than_tracks", top_duration: top, max_track_ed: maxEd });
		}
	}

	const receipt: Receipt = { applied: false, gtrk: gtrkPath, video_rate: rate, ops, warnings, preexisting };
	if (opts.dryRun) {
		emit(receipt, opts);
		return receipt;
	}
	writeGtrkAtomic(gtrkPath, next, mtimeMs, "patch");
	receipt.applied = true;
	emit(receipt, opts);
	return receipt;
}

function emit(r: Receipt, opts: PatchOpts): void {
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
		return;
	}
	const verb = r.applied ? "已写入" : "干跑（未写入）";
	log.step(`${verb}：${r.gtrk}（video_rate=${r.video_rate}）`);
	for (const op of r.ops) {
		if (op.scope === "project") {
			log.info(`${op.action} --total → duration=${op.after?.duration}s`);
			continue;
		}
		for (const l of op.resolved ?? []) log.info(`${op.action} @ ${l.track} clip_id=${l.clip_id || '""'} track_st=${l.track_st}s`);
		if (op.before && op.after) {
			const keys = Object.keys(op.after);
			log.info(`  ${keys.map((k) => `${k}: ${op.before?.[k]} → ${op.after?.[k]}`).join("  ")}`);
		}
		if (op.note) log.info(`  ${op.note}`);
	}
	for (const w of r.warnings) log.warn(`${w.code}：顶层 duration=${w.top_duration}s 短于全轨末端 ${w.max_track_ed}s（产物与计费会按顶层截断；要改走 patch set --total）`);
	if (r.preexisting.length > 0) {
		log.info(`ℹ️ 入档既存不变量问题 ${r.preexisting.length} 条（非本次造成，未阻断）：`);
		for (const v of r.preexisting.slice(0, 5)) log.info(`  · [${v.code}] ${v.message}`);
		if (r.preexisting.length > 5) log.info(`  · …另 ${r.preexisting.length - 5} 条`);
	}
}

export function registerPatch(program: Command): void {
	program
		.command("patch [words...]")
		.description("元素级编辑 .gtrk 工程：move / trim / split / set（恒等式同步 + 帧对齐，agent 勿裸手改 JSON）")
		.option("--project <dir>", "工程目录（自动定位 gtrk/project.gtrk）")
		.option("--gtrk <path>", "直接指定 .gtrk 路径")
		.option("--clip <clip_id>", "按 clip_id 寻址")
		.option("--track <kind:index>", "按轨寻址，形如 video:0 / audio:1 / beat:100")
		.option("--at <sec>", "配合 --track 的寻址时刻")
		.option("--cut <sec|Nf>", "split 的切点（与 --at 分开：--at 是地址、--cut 是切点）")
		.option("--to <sec|Nf>", "move 的落点")
		.option("--in <delta>", "trim：入点相对增量（源窗与轨上入点同动）")
		.option("--out <delta>", "trim：出点相对增量")
		.option("--set-in <abs>", "trim：入点绝对时码")
		.option("--set-out <abs>", "trim：出点绝对时码")
		.option("--slip <delta>", "trim：只换源窗（轨上落点与时长都不动）")
		.option("--muted", "set：静音")
		.option("--no-muted", "set：取消静音")
		.option("--volume <gain>", "set：线性增益（不是 dB）")
		.option("--opaque", "set：不透明")
		.option("--total <sec|Nf|max>", "set：改顶层 duration（工程级 op，与元素寻址互斥）")
		.option("--dry-run", "只算与校验、不写文件")
		.option("--json", "机器可读回执到 stdout（日志转 stderr）")
		.action(async (words: string[], opts: PatchOpts) => {
			await runPatchCommand(words ?? [], opts);
		});
}
