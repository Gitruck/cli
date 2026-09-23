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
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import type { Command } from "commander";
import { routeLogsToStderr, log } from "../lib/log";
import { requireFfmpeg, runFfmpeg } from "../lib/ffmpeg";
import { audioCacheDir } from "../lib/paths";
import { buildEnvelope, planSnap, median } from "../lib/cut-snap";
import { materialsByIdOf } from "../lib/gtrk-invariants";
import { readGtrk, assertGtrkV1, writeGtrkAtomic, GtrkWritebackConflictError } from "../lib/gtrk-writeback";
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
	/** `seal` 专用：超过此秒数的空隙只报不补（缺省 0.5）。 */
	maxGap?: string | number;
	/** `snap` 专用：口播音频路径（缺省取工程 audio 轨的素材）。 */
	audio?: string;
	/** `snap` 专用：单侧搜索窗（秒，缺省 0.4）。 */
	window?: string | number;
	/** `snap` 专用：落在语音开口之前这么多秒（缺省 0.03；实测手调口径）。 */
	lead?: string | number;
	/** ffmpeg 目录（`snap` 抽 PCM 用）。 */
	ffmpegPath?: string;
	ops?: string;
	dryRun?: boolean;
	json?: boolean;
	/**
	 * 跨命令写回断言（`gtrk-writeback-contract` R4）：上一次回执里的 `revision`。
	 * 给定则以它作 expected 参与写回双重校验；缺省取本次读取时的 revision（≡ 仅护进程内窗口）。
	 */
	expectedRevision?: string;
}

/** 回执里一条 op 的结果。 */
interface OpReceipt {
	action: ActionKind;
	scope: "element" | "project";
	/** 工程级 op（`--total`）恒为 null；元素级 op 回**每个**被改元素的定位三元组。 */
	resolved: Array<{ track: string; clip_id: string; track_st: number }> | null;
	before?: Record<string, number | null>;
	after?: Record<string, number | null>;
	/**
	 * 帧域回读。工程级 op（顶层 `duration`）不被帧吸附、无帧号可回，故恒为 `null`——
	 * 显式回 `null` 而非缺键，调用方才能只按 `scope` 分派解析。
	 */
	frames?: { st: number; ed: number; dur: number } | null;
	/** 参数面。工程级 `set --total` 回一条 `{key:"total", literal, effective}`。 */
	params?: Array<Record<string, unknown>>;
	note?: string;
}

interface Receipt {
	/**
	 * 本次调用是否成功——**与退出码同源**（失败路径走 throw，不走回执）。
	 *
	 * 它与 `applied` 答的是不同问题：`ok` 说「这条命令有没有出错」，
	 * `applied` 说「有没有真的写盘」。干跑是 `ok:true, applied:false`。
	 * 本仓通行的 agent 判成败写法读的就是 `ok`（`gtrk mg` 等命令都给），
	 * 此前 patch 独缺，导致 2026-09-20 真机上六次成功被判成六次失败。
	 */
	ok: boolean;
	applied: boolean;
	/** 是否为干跑。与 `applied` 互补：干跑恒 `applied:false`，但非干跑失败也是 false。 */
	dry_run: boolean;
	/** 工程 `.gtrk` 路径。`gtrk` 是同值别名，为不断裂既有调用方而保留。 */
	project: string;
	gtrk: string;
	/**
	 * 当前内容 revision（`gtrk-writeback-contract` R4）：写入成功=**落盘后的新值**、
	 * 干跑/冲突=读取时的值。调用方可直接把它用作下一次的 `--expected-revision`。
	 */
	revision: string;
	video_rate: number;
	ops: OpReceipt[];
	warnings: Array<Record<string, unknown>>;
	/**
	 * 不变量校验结果。`violations` 是**本次改动引入**的（非空时命令已在此前硬拒，
	 * 故能走到回执的恒为空）；`preexisting` 是工程里本来就有的存量违例。
	 */
	invariants: { ok: boolean; violations: Violation[]; preexisting: Violation[] };
	/** 扁平别名，为不断裂既有调用方而保留；与 `invariants.preexisting` 同值。 */
	preexisting: Violation[];
	/** 仅写回冲突时出现（R3）：双 revision + 见错误文案的下一步指示。 */
	conflict?: { expected_revision: string; actual_revision: string };
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

/** revision 形态：64 位小写 hex（sha256）。 */
const REVISION_RE = /^[0-9a-f]{64}$/;

/**
 * 定写回的 expected revision（`gtrk-writeback-contract` R4）：
 * 显式 `--expected-revision` 优先（跨命令断言），否则取本次读取值（≡ 仅护进程内读→改→写窗口）。
 * ⚠️ 格式非法 **fail-fast**，MUST NOT 静默回落缺省——那会让调用方以为有保护、其实没有。
 */
function resolveExpectedRevision(opts: PatchOpts, readRevision: string): string {
	const given = opts.expectedRevision;
	if (given === undefined) return readRevision;
	if (!REVISION_RE.test(given)) {
		fail("bad_expected_revision", `--expected-revision 需 64 位小写 hex（sha256），实得：${JSON.stringify(given)}`);
	}
	return given;
}

/**
 * 写回；冲突转结构化回执（`gtrk-writeback-contract` R3）。
 * `--json` 下先把带 `conflict` 的回执吐到 stdout，再按错误路径退出（stderr 出人读文案 + exit 1）。
 * @returns 落盘后的新 revision
 */
function commitWithConflictReceipt(
	gtrkPath: string,
	next: Record<string, unknown>,
	expected: string,
	receipt: Receipt,
	opts: PatchOpts,
): string {
	try {
		return writeGtrkAtomic(gtrkPath, next, expected, "patch");
	} catch (e) {
		if (e instanceof GtrkWritebackConflictError) {
			if (opts.json) {
				const r: Receipt = {
					...receipt,
					// 写回冲突 = 命令确实失败了（下面按错误路径退出），故 ok:false。
					ok: false,
					applied: false,
					revision: e.expectedRevision,
					conflict: { expected_revision: e.expectedRevision, actual_revision: e.actualRevision },
				};
				process.stdout.write(`${JSON.stringify(r)}\n`);
			}
			fail(
				"writeback_conflict",
				`${e.message}\n下一步：重新读取工程后重试；agent 可拿回执里的 revision 作 --expected-revision 断言（本次 expected=${e.expectedRevision.slice(0, 12)}… actual=${e.actualRevision.slice(0, 12)}…）。`,
			);
		}
		throw e;
	}
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
/**
 * 取顶层 duration。`--total` 已在 applyTotal 里对「键不在场」硬拒，
 * 故回执里的 `before.duration` 恒为数——这是规格写明的承诺。
 */
function topDurationOf(gtrk: Record<string, unknown>): number {
	const d = gtrk.duration;
	return typeof d === "number" ? d : 0;
}

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
		return {
			next: r.next,
			receipt: {
				action,
				scope: "project",
				resolved: null,
				frames: null,
				before: { duration: topDurationOf(gtrk) },
				after: { duration: r.value },
				params: [{ key: "total", literal: opts.total, effective: r.value }],
			},
		};
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
/**
 * `gtrk patch seal --track <kind:index>` —— 补平该轨上**不超过阈值**的空隙（add-patch-seal）。
 *
 * 立题：按段落位的铺轨（`ai-drama lay` 按每拍 trackSt/trackEd）会在拍界留下口播自然停顿
 * 造成的缝。真机 232 镜 / 231 处接缝里 21 处有 0.05–0.31s 的缝，成片里会闪黑。
 *
 * 设计要点：
 *  - **不新增写出语义**。它把自己编译成一串 `trim --set-out`，走既有多 op 流水线，
 *    恒等式同步 / 帧对齐 / 原子写回与 revision 守卫全部复用。
 *  - **超阈值只报不动**：长空隙可能是有意留白，命令 MUST NOT 替用户决定。
 *  - **重叠只报不动**：负缝牵扯遮挡语义，不在本动作射程内。
 *  - **补缝 ≠ 卡点**：它只保证衔接无黑场，不改变切点相对音频的位置。
 */
const SEAL_DEFAULT_MAX_GAP = 0.5;

async function runSeal(opts: PatchOpts): Promise<Receipt> {
	if (opts.track === undefined) {
		fail("seal_track_required", "seal 需 --track <kind:index>（MUST NOT 提供「补全部轨」的默认——那会动到别人的轨）");
	}
	const { kind, index } = parseTrackSpec(opts.track);
	const maxGap = opts.maxGap === undefined ? SEAL_DEFAULT_MAX_GAP : Number(opts.maxGap);
	if (!Number.isFinite(maxGap) || maxGap < 0) fail("bad_max_gap", `--max-gap 须是非负秒数，读到「${opts.maxGap}」`);

	const gtrkPath = resolveGtrkPath(opts);
	const { gtrk: before } = readGtrk(gtrkPath);
	assertGtrkV1(before);

	const rate = videoRateOf(before);
	const els = collectElements(before)
		.filter((e) => e.ref.kind === kind && e.ref.trackIndex === index)
		.sort((a, b) => Number(a.clip.track_st ?? 0) - Number(b.clip.track_st ?? 0));
	if (els.length < 2) {
		fail("seal_track_too_short", `轨 ${opts.track} 上只有 ${els.length} 个元素，没有接缝可补`);
	}

	const ops: OpSpec[] = [];
	const tooWide: Array<{ at: number; gap: number }> = [];
	const overlaps: Array<{ at: number; overlap: number }> = [];
	for (let i = 0; i < els.length - 1; i++) {
		const a = els[i];
		const b = els[i + 1];
		const aEd = Number(a.clip.track_ed ?? 0);
		const bSt = Number(b.clip.track_st ?? 0);
		// 全程在**整毫秒域**比较（时间量的秒↔毫秒换算一律走 frame-domain 的 sec2ms/ms2sec，
		// 手搓 `Math.round(x*1000)` 会被 time-tolerance-whitelist 守卫拦住——那道闸是对的）。
		const aEdMs = sec2ms(aEd);
		const bStMs = sec2ms(bSt);
		const gapMs = bStMs - aEdMs;
		if (Math.abs(gapMs) <= 2) continue; // 已严丝合缝（2ms 容差）
		if (gapMs < 0) {
			overlaps.push({ at: aEd, overlap: ms2sec(-gapMs) });
			continue;
		}
		if (gapMs > sec2ms(maxGap)) {
			tooWide.push({ at: aEd, gap: ms2sec(gapMs) });
			continue;
		}
		// ⚠️ 目标取**帧下取整**，不是秒字面。
		// `trim --set-out` 会把轨道时基吸到帧格，而 `sec2frame` 是**就近**取整——
		// 下一个入点不在帧格上时（非本命令产出的工程完全可能），就近会把出点推过它、造成重叠，
		// 被不变量校验硬拒（真机 fixture 上 6.36s@30fps 被吸到 6.366s）。
		// 用 floor 保证「只补到下一个入点之前的最后一帧」，宁可留 <1 帧的残缝也 MUST NOT 造重叠。
		// 先就近取整（与 `sec2frame` 同口径，保证入点本就在帧格上时**精确命中**——
		// 帧格上的秒值是 `f2ms` 向下投影来的，直接 floor 会少补一帧），
		// 再检查落回毫秒后有没有越过下一个入点；越了才退一帧。
		let targetFrame = Math.floor(bSt * rate + 0.5);
		if (f2ms(targetFrame, rate) > bStMs) targetFrame -= 1;
		const aEdFrame = Math.floor(aEd * rate + 0.5);
		if (targetFrame <= aEdFrame) continue; // 不足一帧，补不动
		const setOut = `${targetFrame}f`;
		if (a.isGap) {
			// gap 元素不可经 --clip 寻址（契约 E1），用 track/at 定位
			ops.push({ action: "trim", track: opts.track, at: String(Number(a.clip.track_st ?? 0)), setOut });
		} else {
			ops.push({ action: "trim", clip: a.clipId, setOut });
		}
	}

	const summary = {
		code: "seal_summary",
		track: opts.track,
		sealed: ops.length,
		too_wide: tooWide,
		overlaps,
		max_gap: maxGap,
	};

	// 无缝可补：直接回一份零写回执（**幂等**——连跑两次第二次走这里）。
	// MUST NOT 落到 runBatch 的 `ops_empty` 硬拒上：没有缝不是用法错误。
	if (ops.length === 0) {
		const { revision } = readGtrk(gtrkPath);
		const receipt: Receipt = {
			ok: true,
			applied: false,
			dry_run: Boolean(opts.dryRun),
			project: gtrkPath,
			gtrk: gtrkPath,
			revision,
			video_rate: rate,
			ops: [],
			warnings: [summary],
			invariants: { ok: true, violations: [], preexisting: [] },
			preexisting: [],
		};
		emit(receipt, opts);
		return receipt;
	}

	const sealed = ops.length;
	const receipt = await runOps(ops, opts, [{ ...summary, sealed }]);
	if (!opts.json) {
		log.step(`补缝完成：已补 ${sealed} 处` + (tooWide.length ? `，超阈值未补 ${tooWide.length} 处` : "") + (overlaps.length ? `，重叠未动 ${overlaps.length} 处` : ""));
	}
	return receipt;
}

/**
 * `gtrk patch snap --track <kind:index>` —— 把轨上的切点吸附到口播的停顿里
 * （openspec: add-cut-point-audio-snap）。
 *
 * 立题见 `../lib/cut-snap` 头注：按句界铺出来的切点，谷深中位 0.254，
 * 与随机撒点（0.247）**无统计差异**；主理人手调后是 0.0037。
 *
 * 实现要点：
 *  - 一个切点 = 相邻两元素的公共边界 ⇒ 一次「滚动编辑」= 前者 `trim --set-out` + 后者 `trim --set-in`。
 *    两条都是既有动作，恒等式/帧对齐/写回守卫全部复用，**不新增写出语义**。
 *  - 音频是**只读定位输入**（射程边界条款的只读豁免）。
 *  - 吸附失败 MUST NOT 静默移动：保持原位并在回执逐条列出。
 *  - **MUST NOT 兼做补缝**：吸附可能产生新的缝，回执报出交给 `seal`。
 */
async function runSnap(opts: PatchOpts, deps: PatchDeps = {}): Promise<Receipt> {
	if (opts.track === undefined) fail("snap_track_required", "snap 需 --track <kind:index>");
	const { kind, index } = parseTrackSpec(opts.track);
	const gtrkPath = resolveGtrkPath(opts);
	const { gtrk: before } = readGtrk(gtrkPath);
	assertGtrkV1(before);
	const rate = videoRateOf(before);

	const els = collectElements(before)
		.filter((e) => e.ref.kind === kind && e.ref.trackIndex === index)
		.sort((a, b) => Number(a.clip.track_st ?? 0) - Number(b.clip.track_st ?? 0));
	if (els.length < 2) fail("snap_track_too_short", `轨 ${opts.track} 上只有 ${els.length} 个元素，没有切点可吸附`);

	const audioPath = resolveSnapAudio(before, opts);
	const env = deps.loadEnvelope ? await deps.loadEnvelope(audioPath) : await loadSnapEnvelope(audioPath, opts.ffmpegPath);

	// 切点 = 相邻两元素的边界（取后者入点；前者出点与之相等或有缝，缝由 seal 管）。
	//
	// 可移动区间有**两重**约束，真机 2026-09-20 才暴露第二重：
	//  ① 轨上：不得越过前一个元素的入点 / 后一个元素的出点，每边至少留一帧；
	//  ② 源窗：切点左移 ⇒ 后者要在源里**往前**取，可移量 ≤ 它的 `clip_st`；
	//     切点右移 ⇒ 前者要在源里**往后**取，可移量 ≤ 素材时长 − 它的 `clip_ed`。
	//     ② 缺了就会撞上「裁剪后源窗入点为负」——AI 片段的 `clip_st` 恒为 0，源头一点余量都没有。
	const mats = materialsByIdOf(before.materials);
	const srcDurOf = (el: Element): number => {
		const m = mats.get(String(el.clip.material));
		const d = m?.duration;
		return typeof d === "number" && Number.isFinite(d) ? d : Number.POSITIVE_INFINITY;
	};
	const cuts: number[] = [];
	const bounds: Array<{ lo: number; hi: number }> = [];
	for (let i = 0; i < els.length - 1; i++) {
		const a = els[i];
		const b = els[i + 1];
		const cut = Number(b.clip.track_st ?? 0);
		cuts.push(cut);
		const minLen = 1 / Math.max(1, rate);
		// 右移：前者在源里**往后**取 ⇒ 受它的源尾余量限。
		const tailRoom = srcDurOf(a) - Number(a.clip.clip_ed ?? 0);
		// 左移：后者变长。
		//   ⚠️ **MUST NOT** 用 `trim --set-in` 往前扩它的源头——AI 片段 `clip_st` 恒为 0，
		//   源头一点余量没有，那条路 136/231 个切点全被「裁剪后源窗入点为负」挡死（真机实测）。
		//   正解是**整体左移 + 尾部延长**：`move --to` 把它挪到新切点（源窗不动），
		//   再 `trim --set-out` 把出点拉回原处（源窗从**尾部**补足）。
		//   于是左移余量 = 后者的源尾余量，而不是它的源头余量。
		const growRoom = srcDurOf(b) - Number(b.clip.clip_ed ?? 0);
		bounds.push({
			lo: Math.max(Number(a.clip.track_st ?? 0) + minLen, cut - growRoom),
			hi: Math.min(Number(b.clip.track_ed ?? 0) - minLen, cut + tailRoom),
		});
	}

	const plan = planSnap(cuts, bounds, env, {
		window: opts.window === undefined ? undefined : Number(opts.window),
		lead: opts.lead === undefined ? undefined : Number(opts.lead),
	});

	const ops: OpSpec[] = [];
	for (const [i, d] of plan.entries()) {
		if (!d.moved) continue;
		const a = els[i];
		const b = els[i + 1];
		// 帧目标：与 seal 同一条口径（就近取整 + 越界退一帧），保证落在帧格上且不越过可动区间。
		let frame = Math.floor(d.to * rate + 0.5);
		if (f2ms(frame, rate) > sec2ms(bounds[i].hi)) frame -= 1;
		if (f2ms(frame, rate) < sec2ms(bounds[i].lo)) frame += 1;
		const at = `${frame}f`;
		const cut = cuts[i];
		const bEd = Number(b.clip.track_ed ?? 0);
		// 滚动编辑：前者出点与后者入点同时落到新切点。
		// 两个方向走**不同**的 op 组合（见上方 bounds 处的注释）：
		//  · 右移：后者从头部缩短 ⇒ `trim --set-in`（源窗入点后移，`clip_st` 由 0 变正，恒可行）
		//  · 左移：后者变长 ⇒ `move --to` 挪位 + `trim --set-out` 把出点拉回（源窗从尾部补）
		// 后者先动、前者后动：中途的重叠/空隙是瞬态，校验在全部 op 之后一次性做。
		if (!b.isGap) {
			if (d.to > cut) {
				ops.push({ action: "trim", clip: b.clipId, setIn: at });
			} else {
				ops.push({ action: "move", clip: b.clipId, to: at });
				ops.push({ action: "trim", clip: b.clipId, setOut: String(bEd) });
			}
		}
		if (!a.isGap) ops.push({ action: "trim", clip: a.clipId, setOut: at });
	}

	const moved = plan.filter((d) => d.moved).length;
	const summary = {
		code: "snap_summary",
		track: opts.track,
		audio: audioPath,
		moved,
		skipped: plan
			.filter((d) => d.skip && d.skip !== "already_aligned")
			.map((d) => ({ at: d.from, why: d.skip })),
		already_aligned: plan.filter((d) => d.skip === "already_aligned").length,
		dip_median_before: median(plan.map((d) => d.dipBefore)),
		dip_median_after: median(plan.map((d) => d.dipAfter)),
	};

	if (ops.length === 0) {
		const { revision } = readGtrk(gtrkPath);
		const receipt: Receipt = {
			ok: true, applied: false, dry_run: Boolean(opts.dryRun), project: gtrkPath, gtrk: gtrkPath,
			revision, video_rate: rate, ops: [], warnings: [summary],
			invariants: { ok: true, violations: [], preexisting: [] }, preexisting: [],
		};
		emit(receipt, opts);
		return receipt;
	}

	const receipt = await runOps(ops, opts, [summary, ...snapSeamWarnings(gtrkPath, kind, index, opts)]);
	if (!opts.json) {
		log.step(
			`吸附完成：已移动 ${moved} 个切点；谷深中位 ${summary.dip_median_before.toFixed(3)} → ${summary.dip_median_after.toFixed(3)}` +
				(summary.skipped.length ? `；未吸附 ${summary.skipped.length} 个` : ""),
		);
	}
	return receipt;
}

/** 吸附后可能产生新缝——**只报，不补**（补缝是 `seal` 的事，两件事分开验收）。 */
function snapSeamWarnings(gtrkPath: string, kind: TrackKind, index: number, opts: PatchOpts): Array<Record<string, unknown>> {
	if (opts.dryRun) return [];
	const { gtrk } = readGtrk(gtrkPath);
	const els = collectElements(gtrk)
		.filter((e) => e.ref.kind === kind && e.ref.trackIndex === index)
		.sort((a, b) => Number(a.clip.track_st ?? 0) - Number(b.clip.track_st ?? 0));
	const seams: Array<{ at: number; gap: number }> = [];
	for (let i = 0; i < els.length - 1; i++) {
		const aEdMs = sec2ms(Number(els[i].clip.track_ed ?? 0));
		const bStMs = sec2ms(Number(els[i + 1].clip.track_st ?? 0));
		if (bStMs - aEdMs > 2) seams.push({ at: ms2sec(aEdMs), gap: ms2sec(bStMs - aEdMs) });
	}
	return seams.length ? [{ code: "snap_new_seams", count: seams.length, seams, hint: "跑 `gtrk patch seal --track …` 补平（snap MUST NOT 兼做补缝）" }] : [];
}

/** 定位口播音频：显式 `--audio` 优先，否则取承载口播那条轨的素材。 */
function resolveSnapAudio(gtrk: Record<string, unknown>, opts: PatchOpts): string {
	if (opts.audio) {
		const p = resolve(opts.audio);
		if (!existsSync(p)) fail("snap_audio_not_found", `--audio 指向的文件不存在：${p}`);
		return p;
	}
	const mats = Array.isArray(gtrk.materials) ? (gtrk.materials as Array<Record<string, unknown>>) : [];
	const audioTracks = Array.isArray(gtrk.audio_track) ? (gtrk.audio_track as Array<Record<string, unknown>>) : [];
	for (const t of audioTracks) {
		const tl = Array.isArray(t.track_timeline) ? (t.track_timeline as Array<Record<string, unknown>>) : [];
		for (const c of tl) {
			const m = mats.find((x) => String(x.id) === String(c.material));
			const p = m?.path === undefined ? undefined : String(m.path);
			if (p && existsSync(p)) return p;
		}
	}
	fail(
		"snap_audio_unresolved",
		"定位不到口播音频。工程 audio 轨上没有可读素材时，请显式给 --audio <口播音频路径>",
	);
}

/**
 * 可注入依赖（测试替身，离线）。
 *
 * 立题：`snap` 的命令层此前**一个用例都没有**——`cut-snap.test.mjs` 只证到纯函数层，
 * 而 2026-09-20 发现命令层那两句「帧目标夹回可动区间」因漏传 rate 恒取 NaN、**从未通电**。
 * 唯一挡在测试外面的是 ffmpeg 抽 PCM 这一步，于是把它做成可替换的一道缝：
 * 替身只替「音频从哪来」，**判据、帧口径、op 编译一律走真路**。
 */
export interface PatchDeps {
	/** 返回已建好的包络（替代 ffmpeg 抽 PCM）。 */
	loadEnvelope?: (audioPath: string) => Promise<ReturnType<typeof buildEnvelope>> | ReturnType<typeof buildEnvelope>;
}

/** 抽 PCM 建包络。缓存落 `audioCacheDir()`，与 `audio tighten` 同一约定。 */
async function loadSnapEnvelope(audioPath: string, ffmpegPath?: string) {
	const { ffmpeg } = requireFfmpeg(ffmpegPath);
	const work = audioCacheDir();
	mkdirSync(work, { recursive: true });
	const pcmPath = join(work, `snap-${createHash("sha256").update(audioPath).digest("hex").slice(0, 12)}.pcm`);
	await runFfmpeg(ffmpeg, [
		"-y", "-v", "error", "-i", audioPath,
		"-vn", "-ac", "1", "-ar", String(SNAP_PCM_RATE), "-f", "s16le", "-c:a", "pcm_s16le",
		pcmPath,
	]);
	const buf = readFileSync(pcmPath);
	const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
	return buildEnvelope(pcm, SNAP_PCM_RATE);
}

/** 吸附用的 PCM 采样率。4kHz 足以承载 20ms 窗的能量判据，且解码快。 */
const SNAP_PCM_RATE = 4000;

async function runBatch(words: string[], opts: PatchOpts): Promise<Receipt> {
	if (words.length > 0) {
		fail("ops_with_action", `--ops 自带每条 op 的 action，不该再给动作词「${words[0]}」`);
	}
	const specs = await readOpsFile(opts.ops!);
	if (specs.length === 0) fail("ops_empty", "--ops 是空数组，没有可执行的操作");
	return runOps(specs, opts);
}

/**
 * 执行一串已就绪的 op。`--ops`（读文件后）与 `seal`（自己编译出 op 串）共用本函数——
 * 两条路走同一段逻辑，避免长出两份口径。
 */
async function runOps(
	specs: OpSpec[],
	opts: PatchOpts,
	/** seal / snap 的摘要。MUST 在 emit **之前**并进去——否则 `--json` 的 stdout 里没有它。 */
	extraWarnings: Array<Record<string, unknown>> = [],
): Promise<Receipt> {
	const gtrkPath = resolveGtrkPath(opts);
	const { gtrk: before, revision } = readGtrk(gtrkPath);
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

	const warnings = [...topDurationWarnings(next), ...extraWarnings];
	// expected 在 dryRun 分支**之前**解析：`--expected-revision` 格式非法时干跑也要 fail-fast
	const expected = resolveExpectedRevision(opts, revision);
	const receipt: Receipt = {
		ok: true,
		applied: false,
		dry_run: Boolean(opts.dryRun),
		project: gtrkPath,
		gtrk: gtrkPath,
		revision,
		video_rate: rate,
		ops: receipts,
		warnings,
		// 同单发路径：走到这里说明本批没有引入违例（引入了的话上面已 fail）。
		invariants: { ok: true, violations: [], preexisting },
		preexisting,
	};
	if (opts.dryRun) {
		emit(receipt, opts);
		return receipt;
	}
	receipt.revision = commitWithConflictReceipt(gtrkPath, next, expected, receipt, opts);
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

export async function runPatchCommand(words: string[], opts: PatchOpts, deps: PatchDeps = {}): Promise<Receipt> {
	if (opts.json) routeLogsToStderr();
	// `seal` 是**轨级**动作，但它不新增任何写出语义——编译成一串 `trim --set-out` 后
	// 走既有多 op 流水线，恒等式/帧对齐/写回守卫全部复用（见 add-patch-seal）。
	if (words[0] === "seal") return runSeal(opts);
	if (words[0] === "snap") return runSnap(opts, deps);
	if (opts.ops !== undefined) return runBatch(words, opts);
	const action = words[0] as ActionKind | undefined;
	if (!action) {
		fail("no_action", `用法：gtrk patch <${ACTIONS.join("|")}> …（元素级编辑；agent MUST NOT 裸手改 .gtrk JSON）`);
	}
	if (RESERVED.has(action)) fail("reserved_action", `「${action}」是保留字，不能作动作名。合法动作：${ACTIONS.join(" / ")}`);
	if (!ACTIONS.includes(action)) fail("unknown_action", `未知动作「${action}」。合法动作：${ACTIONS.join(" / ")}`);

	const gtrkPath = resolveGtrkPath(opts);
	const { gtrk: before, revision } = readGtrk(gtrkPath);
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
		ops.push({
			action,
			scope: "project",
			resolved: null,
			frames: null,
			before: { duration: topDurationOf(before) },
			after: { duration: r.value },
			params: [{ key: "total", literal: opts.total, effective: r.value }],
		});
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

	// expected 在 dryRun 分支**之前**解析：`--expected-revision` 格式非法时干跑也要 fail-fast
	const expected = resolveExpectedRevision(opts, revision);
	const receipt: Receipt = {
		ok: true,
		applied: false,
		dry_run: Boolean(opts.dryRun),
		project: gtrkPath,
		gtrk: gtrkPath,
		revision,
		video_rate: rate,
		ops,
		warnings,
		// 走到这里说明本次改动没有引入违例（引入了的话上面已 fail），故 violations 恒空。
		invariants: { ok: true, violations: [], preexisting },
		preexisting,
	};
	if (opts.dryRun) {
		emit(receipt, opts);
		return receipt;
	}
	receipt.revision = commitWithConflictReceipt(gtrkPath, next, expected, receipt, opts);
	receipt.applied = true;
	emit(receipt, opts);
	return receipt;
}

function emit(r: Receipt, opts: PatchOpts): void {
	if (opts.json) {
		// 单行：机读契约要求 stdout 只出一行结果 JSON（人读日志在 stderr）。
		process.stdout.write(`${JSON.stringify(r)}\n`);
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
		.description(
			"元素级编辑 .gtrk 工程：move / trim / split / set（恒等式同步 + 帧对齐，agent 勿裸手改 JSON）；" +
				"`patch seal --track <kind:index>`=补平该轨小缝（超 --max-gap 的只报不动）；" +
				"`patch snap --track <kind:index>`=把切点吸附到口播停顿（锚在下一段语音开口之前）",
		)
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
		.option("--max-gap <sec>", "seal：超过此秒数的空隙只报不补（缺省 0.5；长空隙可能是有意留白）")
		.option("--audio <path>", "snap：口播音频路径（缺省取工程 audio 轨的素材）")
		.option("--window <sec>", "snap：单侧搜索窗（缺省 0.4）")
		.option("--lead <sec>", "snap：落在语音开口之前这么多秒（缺省 0.03；实测手调口径）")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg 所在目录（snap 抽 PCM 用）")
		.option("--slip <delta>", "trim：只换源窗（轨上落点与时长都不动）")
		.option("--muted", "set：静音")
		.option("--no-muted", "set：取消静音")
		.option("--volume <gain>", "set：线性增益（不是 dB）")
		.option("--opaque", "set：不透明")
		.option("--total <sec|Nf|max>", "set：改顶层 duration（工程级 op，与元素寻址互斥）")
		.option("--dry-run", "只算与校验、不写文件")
		.option("--expected-revision <sha256>", "跨命令写回断言：上次回执里的 revision，与盘上内容不符即拒写（agent 用；缺省只护本次读→改→写窗口）")
		.option("--json", "机器可读回执到 stdout（日志转 stderr）")
		.action(async (words: string[], opts: PatchOpts) => {
			await runPatchCommand(words ?? [], opts);
		});
}
