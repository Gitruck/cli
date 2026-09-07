/**
 * `.gtrk` 元素级编辑的纯函数层（`gtrk patch` 落地专用，openspec: add-patch-command）。
 *
 * **零 IO**：读写由 `gtrk-writeback.ts` 负责，本模块只做「入档对象 → 出档对象」的纯变换与校验，
 * 便于逐条单测。
 *
 * ## 唯一权威域 = 帧域，毫秒是帧号的单向投影
 *
 * 因为**取整不可加**（`f2ms(a+b) ≠ f2ms(a)+f2ms(b)`），「两端各自取整到毫秒」与
 * 「时长由帧差单独换算」**不可同时成立**。护栏例（`rate=30`）：`st_frame=1`、`ed_frame=2` 时
 * `f2ms` 两端得 33 / 67 ms，差 **34ms**，而帧差换算 `f2ms(1)=33ms` —— `34 ≠ 33`。
 *
 * 故自由变量只有三个（`st_frame` / `dur_frames` / `clip_st`），其余全是**导出量**，
 * 且导出顺序固定（delta「帧对齐」Requirement 的权威表）：
 *
 * | 量 | 域 | 身份 | 算法 |
 * |---|---|---|---|
 * | `st_frame`   | 帧   | 自由        | 主输入取一次 `sec2frame` |
 * | `dur_frames` | 帧   | 自由（≥1）  | 主输入，或沿用原值 |
 * | `ed_frame`   | 帧   | 导出 ①      | `st_frame + dur_frames` |
 * | `track_st`   | 毫秒 | 导出 ②      | `f2ms(st_frame)` |
 * | `track_ed`   | 毫秒 | 导出 ③      | `f2ms(ed_frame)` |
 * | `duration`   | 毫秒 | 导出 ④      | **`track_ed − track_st`** |
 * | `clip_st`    | 毫秒 | 自由（只量化，不帧吸附） | `round(sec × 1000)` |
 * | `clip_ed`    | 毫秒 | 导出 ⑤      | `clip_st + duration` |
 *
 * ⚠️ **代码层禁止出现 `f2ms(dur_frames)` 充当 `duration`** —— 那正是「取整不可加」会咬人的写法。
 *
 * ## 帧对齐只作用于轨道时基
 *
 * `clip_st`/`clip_ed` **MUST NOT 帧吸附**：源侧寻址域是源容器**播放钟**，非零 `start_time` 的源真实存在，
 * 而 `.gtrk` 不携带源容器 `start_time` ⇒ 凭单文件算不准源侧帧边界，硬吸附会把契约里
 * 「落点差 ≤1 帧」的既有容差变成系统性错位。源侧只做毫秒量化，长度由 E1 从轨道侧推得。
 */

/** 轨类。`beat` = 颗粒轨（`beat_track`），整段播放、无源裁剪。 */
export type TrackKind = "video" | "audio" | "beat";

/** 元素在文件中的物理位置（供写回时定位，不对外暴露为寻址口径）。 */
export interface ElementRef {
	kind: TrackKind;
	/** 轨对象在 `<kind>_track` 数组中的下标。⚠️ 仅内部定位用；对外 MUST NOT 提供下标寻址。 */
	trackArrayIndex: number;
	/** 元素在 `track_timeline` 中的下标。同上，仅内部定位。 */
	clipArrayIndex: number;
	/** 契约的 `track_index`（z-order），回执与人读用。 */
	trackIndex: number;
}

/** 回执里的定位三元组：调用方下轮据此复核「所指是否仍是同一元素」。 */
export interface Locator {
	/** 形如 `video:0`，用 `track_index` 而非数组下标。 */
	track: string;
	clip_id: string;
	track_st: number;
}

// ────────────────────────────── 帧域换算（正本已迁 frame-domain.ts） ──────────────────────────────
//
// [link-time-domain-discipline] 帧域三件套（`sec2frame / f2ms / derive`）与配套 `sec2ms / ms2sec / readMs`、
// `FrameView / DerivedMs` 原样搬到 `./frame-domain`（零 IO、零依赖，供 lay 模块直接接、不再反向依赖本文件）；
// 此处 re-export 保既有 import 路径不变。取整方向一字未改。
import { sec2frame, f2ms, sec2ms, ms2sec, readMs, derive } from "./frame-domain";
import type { FrameView, DerivedMs } from "./frame-domain";
export { sec2frame, f2ms, sec2ms, ms2sec, readMs, derive } from "./frame-domain";
export type { FrameView, DerivedMs } from "./frame-domain";

// ────────────────────────────── 元素收集与寻址 ──────────────────────────────

/** 三条轨类在 gtrk 顶层的键名。 */
const TRACK_KEYS: Record<TrackKind, string> = {
	video: "video_track",
	audio: "audio_track",
	beat: "beat_track",
};

type Obj = Record<string, unknown>;

/** 一个被收集到的元素：物理位置 + 原始对象引用。 */
export interface Element {
	ref: ElementRef;
	clip: Obj;
	clipId: string;
	/** gap（`clip_id === ""`）。契约 E1 让多个 gap 合法共享该取值 ⇒ 它不构成地址。 */
	isGap: boolean;
}

function asArray(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

/** 遍历全档元素（video / audio / beat 三轨类）。顺序：video → audio → beat，各自按数组序。 */
export function collectElements(gtrk: Obj): Element[] {
	const out: Element[] = [];
	for (const kind of ["video", "audio", "beat"] as TrackKind[]) {
		const tracks = asArray(gtrk[TRACK_KEYS[kind]]);
		tracks.forEach((t, ti) => {
			if (typeof t !== "object" || t === null) return;
			const track = t as Obj;
			const trackIndex = typeof track.track_index === "number" ? track.track_index : ti;
			asArray(track.track_timeline).forEach((c, ci) => {
				if (typeof c !== "object" || c === null) return;
				const clip = c as Obj;
				const clipId = typeof clip.clip_id === "string" ? clip.clip_id : "";
				out.push({
					ref: { kind, trackArrayIndex: ti, clipArrayIndex: ci, trackIndex },
					clip,
					clipId,
					// ⚠️ 空档判据：本仓按 `clip_id === ""` 判（契约明文枚举的保留取值，全等比较）。
					// 契约 §3「空档（gap）」条 ③a 记有「文档判 clip_id、实现判 material 为空」两套判据并行的
					// 已知分歧 —— 本模块取契约文档口径，并在校验器里额外把「无 material」也当 gap 对待，
					// 使两套判据的交集与并集都不会漏判（见 classifyForValidation）。
					isGap: clipId === "",
				});
			});
		});
	}
	return out;
}

export function locatorOf(el: Element, rate: number): Locator {
	const stMs = readMs(el.clip.track_st);
	return {
		track: `${el.ref.kind}:${el.ref.trackIndex}`,
		clip_id: el.clipId,
		track_st: Number.isFinite(stMs) ? ms2sec(stMs) : Number.NaN,
	};
}

/** `--clip` 的解析结果，按契约 U1/U2/E1/E2 分流（delta「寻址」Requirement + design D5′）。 */
export type ClipResolution =
	| { kind: "none" }
	| { kind: "gap-not-addressable" }
	| { kind: "single"; elements: [Element] }
	/** U2 镜像对：同一编辑单元的 video ↔ 镜像 audio 两个投影。 */
	| { kind: "mirror-pair"; elements: [Element, Element] }
	/** 真撞名（同轨重复 id 等违反 U1 的存量档）。 */
	| { kind: "ambiguous"; elements: Element[] };

/**
 * 判两条命中是否构成 **U2 镜像对**。
 *
 * ⚠️ **MUST NOT 以「只有两条」为判据**：两条同在 `video_track` 是 U1 违规的存量档，
 * 走真撞名分支；三条以上一律走真撞名分支（一个编辑单元最多两个投影）。
 */
function isMirrorPair(a: Element, b: Element): boolean {
	const kinds = new Set([a.ref.kind, b.ref.kind]);
	if (!(kinds.has("video") && kinds.has("audio"))) return false;
	const stA = readMs(a.clip.track_st);
	const stB = readMs(b.clip.track_st);
	const dA = readMs(a.clip.duration);
	const dB = readMs(b.clip.duration);
	if (!Number.isFinite(stA) || !Number.isFinite(dA)) return false;
	return stA === stB && dA === dB;
}

export function resolveByClipId(gtrk: Obj, clipId: string): ClipResolution {
	// 契约 E1：多个 gap 合法共享 `""` ⇒ `""` 天然不构成地址。
	if (clipId === "") return { kind: "gap-not-addressable" };
	const hits = collectElements(gtrk).filter((e) => e.clipId === clipId);
	if (hits.length === 0) return { kind: "none" };
	if (hits.length === 1) return { kind: "single", elements: [hits[0]] };
	if (hits.length === 2 && isMirrorPair(hits[0], hits[1])) {
		return { kind: "mirror-pair", elements: [hits[0], hits[1]] };
	}
	return { kind: "ambiguous", elements: hits };
}

/**
 * `--track <kind>:<track_index> --at <sec>` 寻址。
 * 命中条件按契约「元素摆位仅由 `track_st` 决定」：`track_st ≤ t < track_ed`。
 */
export function resolveByTrackAt(
	gtrk: Obj,
	kind: TrackKind,
	trackIndex: number,
	atSec: number,
): Element[] {
	const tMs = sec2ms(atSec);
	return collectElements(gtrk).filter((e) => {
		if (e.ref.kind !== kind || e.ref.trackIndex !== trackIndex) return false;
		const st = readMs(e.clip.track_st);
		const ed = readMs(e.clip.track_ed);
		if (!Number.isFinite(st)) return false;
		const edMs = Number.isFinite(ed) ? ed : st + readMs(e.clip.duration);
		return tMs >= st && tMs < edMs;
	});
}

/** 时码类动作（作用于编辑单元）vs 参数类动作（作用于单个投影）。P8 的分界线。 */
export type ActionKind = "move" | "trim" | "split" | "set";
export function isTimecodeAction(a: ActionKind): boolean {
	return a === "move" || a === "trim" || a === "split";
}

// ────────────────────────────── 全档不变量校验器（E1–E11） ──────────────────────────────

/**
 * 一条不变量违规。`key` 是**位置无关的稳定标识**，用于「出档集合 \ 入档集合」求差
 * ——这是区分「本次造成」与「入档既存」的唯一实现形态（design D4）。
 *
 * ⚠️ MUST NOT 让判据依赖「这一格被哪个动作碰过」：那样会漏掉「动作 A 顺带把无关元素弄坏」的情形。
 */
export interface Violation {
	key: string;
	code: string;
	message: string;
}

/** 校验时的元素分类。取契约文档口径与实现口径的**并集**，避免两套判据并行导致漏判。 */
function classifyForValidation(el: Element): "gap" | "beat" | "clip" {
	if (el.ref.kind === "beat") return "beat";
	// 契约 §3「空档（gap）」条 ③a：文档判 `clip_id===""`、实现判 `material` 为空，两套并行。
	// 取并集判 gap ⇒ 任一口径认为是 gap 的，都不要求它带源裁剪字段（宽进），
	// 而「gap 不得写 clip_st/clip_ed」按同一并集判（严出）。
	const noMaterial =
		el.clip.material === undefined || el.clip.material === null || el.clip.material === "";
	return el.isGap || noMaterial ? "gap" : "clip";
}

/** `materials` 里 id → duration（秒）。缺 `duration` 的（黑底三件套/静图）记 `null`。 */
function materialDurations(gtrk: Obj): Map<string, number | null> {
	const m = new Map<string, number | null>();
	for (const raw of asArray(gtrk.materials)) {
		if (typeof raw !== "object" || raw === null) continue;
		const mat = raw as Obj;
		const id = typeof mat.id === "string" ? mat.id : String(mat.id ?? "");
		if (!id) continue;
		const d = readMs(mat.duration);
		m.set(id, Number.isFinite(d) ? d : null);
	}
	return m;
}

/**
 * 对**整份文件**跑一遍不变量，返回违规集合。
 *
 * ⚠️ **顶层 `duration` ≠ `max(全轨 track_ed)` MUST NOT 入本集合**（既不入 violations 也不入
 * preexisting）——契约从未要求二者相等，判死它就是给契约加它没有的约束。越界只在回执出 warning。
 */
export function validateAll(gtrk: Obj): Violation[] {
	const out: Violation[] = [];
	const mats = materialDurations(gtrk);
	const els = collectElements(gtrk);

	for (const el of els) {
		const cls = classifyForValidation(el);
		const id = el.clipId || "(gap)";
		// `where` 只进人读 message（带数组序号，方便定位）；`ident` 才进集合差用的 key。
		// ⚠️ 数组序号 MUST NOT 入 key：`insertElement`（split 后半）会让插入点之后的元素全部换号，
		//    序号入 key 就把入档既存的违规判成「本次造成」而硬拒（真机实证：切在既存 E1 之前的 split 被拒、
		//    且文案指向与改动无关的 clip）。key = 元素身份 + 违规码 + 该违规自身的证据数值：未触碰元素的
		//    数值一字不变 ⇒ key 位置无关；被触碰元素只有当编辑真改了该违规涉及的数值时才会重判为本次。
		const where = `${el.ref.kind}:${el.ref.trackIndex}#${el.ref.clipArrayIndex}`;
		const ident = `${el.ref.kind}:${el.ref.trackIndex}:${id}`;
		const stMs = readMs(el.clip.track_st);
		const durMs = readMs(el.clip.duration);
		const edMs = readMs(el.clip.track_ed);

		if (!Number.isFinite(stMs) || !Number.isFinite(durMs)) {
			out.push({ key: `${ident}/required`, code: "missing_required_timecode",
				message: `${where}（${id}）缺 track_st 或 duration` });
			continue;
		}
		// E6：duration > 0
		if (durMs <= 0) {
			out.push({ key: `${ident}/dur_positive/${durMs}`, code: "duration_not_positive",
				message: `${where}（${id}）duration=${ms2sec(durMs)}s，须 > 0` });
		}
		// E2：track_ed − track_st = duration（整毫秒域，零容差）
		if (Number.isFinite(edMs) && edMs - stMs !== durMs) {
			out.push({ key: `${ident}/E2/${edMs - stMs}!=${durMs}`, code: "track_identity_broken",
				message: `${where}（${id}）track_ed − track_st = ${edMs - stMs}ms ≠ duration ${durMs}ms` });
		}

		if (cls === "gap" || cls === "beat") {
			// E7 / E8：gap 与 beat MUST NOT 写 clip_st / clip_ed
			if (el.clip.clip_st !== undefined || el.clip.clip_ed !== undefined) {
				out.push({ key: `${ident}/no_src_range`, code: "src_range_on_non_clip",
					message: `${where}（${id}）是 ${cls}，MUST NOT 含 clip_st/clip_ed` });
			}
			continue;
		}

		// —— 以下只对非空档 clip ——
		const cstMs = readMs(el.clip.clip_st);
		const cedMs = readMs(el.clip.clip_ed);
		// E1：clip_ed − clip_st = duration（整毫秒域，零容差）
		if (Number.isFinite(cstMs) && Number.isFinite(cedMs) && cedMs - cstMs !== durMs) {
			out.push({ key: `${ident}/E1/${cedMs - cstMs}!=${durMs}`, code: "clip_identity_broken",
				message: `${where}（${id}）clip_ed − clip_st = ${cedMs - cstMs}ms ≠ duration ${durMs}ms` });
		}
		// E4：material 须在 materials 中
		const matId = typeof el.clip.material === "string" ? el.clip.material : String(el.clip.material ?? "");
		if (matId && !mats.has(matId)) {
			out.push({ key: `${ident}/E4/${matId}`, code: "material_not_found",
				message: `${where}（${id}）material=${matId} 不在 materials 中` });
		}
		// E5 源界。⚠️ 上界那个 1ms 是全档校验器里**唯一**的容差，且恒为 1ms：
		//    clip_ed 是帧域导出量、f2ms 不可加的残差恒 ≤1ms ⇒ 贴素材尾部的 clip 被纯 move 后会溢出 1ms。
		//    容差 MUST NOT 扩大到下界、MUST NOT 扩大到 clip_st < clip_ed、MUST NOT 用于任何恒等式。
		if (Number.isFinite(cstMs)) {
			if (cstMs < 0) {
				out.push({ key: `${ident}/E5_lower/${cstMs}`, code: "src_out_of_range",
					message: `${where}（${id}）clip_st=${ms2sec(cstMs)}s < 0` });
			}
			if (Number.isFinite(cedMs) && cstMs >= cedMs) {
				out.push({ key: `${ident}/E5_order/${cstMs}>=${cedMs}`, code: "src_range_not_increasing",
					message: `${where}（${id}）clip_st 须 < clip_ed` });
			}
			const matDur = mats.get(matId);
			if (matDur !== null && matDur !== undefined && Number.isFinite(cedMs) && cedMs > matDur + 1) {
				out.push({ key: `${ident}/E5_upper/${cedMs}>${matDur}`, code: "src_exceeds_material",
					message: `${where}（${id}）clip_ed=${ms2sec(cedMs)}s 超出素材时长 ${ms2sec(matDur)}s（容差 1ms）` });
			}
		}
	}

	// E9 同轨不重叠（按 track_st 排序后逐对比）
	const byTrack = new Map<string, Element[]>();
	for (const el of els) {
		const k = `${el.ref.kind}:${el.ref.trackIndex}`;
		(byTrack.get(k) ?? byTrack.set(k, []).get(k)!).push(el);
	}
	for (const [track, list] of byTrack) {
		const sorted = [...list]
			.map((e) => ({ e, st: readMs(e.clip.track_st), dur: readMs(e.clip.duration) }))
			.filter((x) => Number.isFinite(x.st) && Number.isFinite(x.dur))
			.sort((a, b) => a.st - b.st);
		for (let i = 1; i < sorted.length; i++) {
			const prev = sorted[i - 1];
			const cur = sorted[i];
			if (cur.st < prev.st + prev.dur) {
				// key 用两个 clip_id + 起点，位置无关（数组序无契约含义，不能进 key）
				out.push({
					key: `${track}/overlap/${prev.e.clipId}|${cur.e.clipId}@${prev.st}-${cur.st}`,
					code: "same_track_overlap",
					message: `${track} 上「${prev.e.clipId || "(gap)"}」与「${cur.e.clipId || "(gap)"}」时间重叠`,
				});
			}
		}
	}
	return out;
}

/**
 * 「本次造成」与「入档既存」的分离：出档集合 \ 入档集合。
 *
 * ⚠️ 这是纯粹的**集合差**，MUST NOT 改成「只校验被碰过的元素」——
 * 后者漏得掉「动作顺带把无关元素弄坏」这一类。
 */
export function diffViolations(before: Violation[], after: Violation[]): {
	violations: Violation[];
	preexisting: Violation[];
} {
	const beforeKeys = new Set(before.map((v) => v.key));
	return {
		violations: after.filter((v) => !beforeKeys.has(v.key)),
		preexisting: after.filter((v) => beforeKeys.has(v.key)),
	};
}

/** 全轨末端最大值（整毫秒）。顶层 `duration` 缺席时的机械算法，也是 `--total max` 的取值。 */
export function maxTrackEdMs(gtrk: Obj): number {
	let max = 0;
	for (const el of collectElements(gtrk)) {
		const st = readMs(el.clip.track_st);
		const dur = readMs(el.clip.duration);
		if (Number.isFinite(st) && Number.isFinite(dur)) max = Math.max(max, st + dur);
	}
	return max;
}

// ────────────────────────────── 四动作（纯变换 FrameView → FrameView） ──────────────────────────────

/** 从入档元素读出帧域视图。`clipStMs` 对 gap/beat 恒为 null（契约禁写源裁剪字段）。 */
export function viewOf(el: Element, rate: number): FrameView {
	const stMs = readMs(el.clip.track_st);
	const durMs = readMs(el.clip.duration);
	const stFrame = sec2frame(ms2sec(stMs), rate);
	// dur_frames 按 delta 的口径：帧(起点+时长) − 帧(起点)，MUST NOT 是 sec2frame(时长)
	const durFrames = sec2frame(ms2sec(stMs + durMs), rate) - stFrame;
	const cls = classifyForValidation(el);
	const cstMs = readMs(el.clip.clip_st);
	return {
		stFrame,
		durFrames,
		clipStMs: cls === "clip" && Number.isFinite(cstMs) ? cstMs : null,
	};
}

/** 时码量的两种字面：秒（`5.0` / `5s`）或帧（`30f`）。相对量允许带正负号。 */
export interface TimeArg {
	/** 帧数（`Nf` 形态）或 null。 */
	frames: number | null;
	/** 秒（其余形态）或 null。 */
	sec: number | null;
}

/** 解析 `5` / `5s` / `-1s` / `30f` / `-2f`。非法返回 null。 */
export function parseTimeArg(raw: string): TimeArg | null {
	const s = raw.trim();
	const mF = /^([+-]?\d+(?:\.\d+)?)f$/i.exec(s);
	if (mF) {
		const n = Number(mF[1]);
		return Number.isInteger(n) ? { frames: n, sec: null } : null;
	}
	const mS = /^([+-]?\d+(?:\.\d+)?)s?$/i.exec(s);
	if (mS) {
		const n = Number(mS[1]);
		return Number.isFinite(n) ? { frames: null, sec: n } : null;
	}
	return null;
}

/** 时码量 → 帧数（相对量用；`sec` 形态经 `sec2frame` 一次取整）。 */
function argToFrames(a: TimeArg, rate: number): number {
	return a.frames !== null ? a.frames : sec2frame(a.sec ?? 0, rate);
}

/** 时码量 → 整毫秒（源侧用；不涉帧吸附）。 */
function argToMs(a: TimeArg, rate: number): number {
	return a.frames !== null ? f2ms(a.frames, rate) : sec2ms(a.sec ?? 0);
}

export interface ActionError {
	code: string;
	message: string;
}

export type ActionResult = { ok: true; view: FrameView } | { ok: false; error: ActionError };

/**
 * `move`：只改落点，`dur_frames` 与 `clip_st` 都不动。
 * @param to 绝对落点（`--to`）
 */
export function applyMove(view: FrameView, to: TimeArg, rate: number): ActionResult {
	const stFrame = to.frames !== null ? to.frames : sec2frame(to.sec ?? 0, rate);
	if (stFrame < 0) return { ok: false, error: { code: "negative_start", message: "落点不能为负" } };
	return { ok: true, view: { ...view, stFrame } };
}

/** `trim` 的五种入参，互斥性由调用方校验（本函数只接已定好的一种）。 */
export interface TrimArgs {
	/** 相对增量：入点。正=往后（缩短），负=往前（拉长）。源窗与轨上入点**同动**。 */
	in?: TimeArg;
	/** 相对增量：出点。正=往后（拉长），负=往前（缩短）。 */
	out?: TimeArg;
	/** 绝对时码：入点。 */
	setIn?: TimeArg;
	/** 绝对时码：出点。 */
	setOut?: TimeArg;
	/** 只换源窗：轨上落点与时长都不动，只平移 `clip_st`。 */
	slip?: TimeArg;
}

/**
 * `trim`：三件全给（P4 推荐案）。
 *
 * ⚠️ **trim-in 有两种业界语义，猜哪一种都会错** ⇒ 由调用方显式选：
 * `--in/--set-in` = 标准 trim（源窗与轨上入点同动，时长变）；`--slip` = 只换源窗（时长与落点都不变）。
 */
export function applyTrim(view: FrameView, args: TrimArgs, rate: number): ActionResult {
	let { stFrame, durFrames, clipStMs } = view;

	if (args.slip !== undefined) {
		if (clipStMs === null) {
			return { ok: false, error: { code: "slip_on_non_clip", message: "gap / beat 没有源窗，--slip 不适用" } };
		}
		return { ok: true, view: { stFrame, durFrames, clipStMs: clipStMs + argToMs(args.slip, rate) } };
	}

	// 入点（相对或绝对）：轨上入点动多少，源窗入点同动多少 —— 出点不动 ⇒ 时长反向变化。
	if (args.in !== undefined || args.setIn !== undefined) {
		const newSt =
			args.setIn !== undefined
				? (args.setIn.frames !== null ? args.setIn.frames : sec2frame(args.setIn.sec ?? 0, rate))
				: stFrame + argToFrames(args.in!, rate);
		const deltaFrames = newSt - stFrame;
		stFrame = newSt;
		durFrames -= deltaFrames;
		if (clipStMs !== null) {
			// 源侧同动。⚠️ 用两端毫秒之差算位移，MUST NOT 用 f2ms(deltaFrames)（取整不可加）。
			clipStMs += f2ms(newSt, rate) - f2ms(newSt - deltaFrames, rate);
		}
	}

	// 出点（相对或绝对）：只改时长，落点与源窗入点都不动。
	if (args.out !== undefined || args.setOut !== undefined) {
		durFrames =
			args.setOut !== undefined
				? (args.setOut.frames !== null ? args.setOut.frames : sec2frame(args.setOut.sec ?? 0, rate)) - stFrame
				: durFrames + argToFrames(args.out!, rate);
	}

	if (stFrame < 0) return { ok: false, error: { code: "negative_start", message: "裁剪后落点为负" } };
	if (durFrames < 1) {
		return { ok: false, error: { code: "duration_below_one_frame", message: "裁剪后时长不足 1 帧" } };
	}
	if (clipStMs !== null && clipStMs < 0) {
		return { ok: false, error: { code: "negative_src_in", message: "裁剪后源窗入点为负" } };
	}
	return { ok: true, view: { stFrame, durFrames, clipStMs } };
}

/** `split` 的产物：原地留下前半，另产后半。 */
export interface SplitResult {
	first: FrameView;
	second: FrameView;
}

/**
 * `split`：在 `at`（绝对轨上时刻）切成两段。两段各自 ≥1 帧，否则硬拒。
 * 后半的源窗入点 = 前半源窗入点 + 前半时长（毫秒域，走导出链的 duration）。
 */
export function applySplit(
	view: FrameView,
	at: TimeArg,
	rate: number,
): { ok: true; result: SplitResult } | { ok: false; error: ActionError } {
	const cutFrame = at.frames !== null ? at.frames : sec2frame(at.sec ?? 0, rate);
	const firstFrames = cutFrame - view.stFrame;
	const secondFrames = view.durFrames - firstFrames;
	if (firstFrames < 1 || secondFrames < 1) {
		return {
			ok: false,
			error: { code: "split_point_out_of_range", message: "切点须落在元素内部且两段各 ≥1 帧" },
		};
	}
	const first: FrameView = { ...view, durFrames: firstFrames };
	const firstDurMs = derive(first, rate).durationMs;
	return {
		ok: true,
		result: {
			first,
			second: {
				stFrame: cutFrame,
				durFrames: secondFrames,
				clipStMs: view.clipStMs === null ? null : view.clipStMs + firstDurMs,
			},
		},
	};
}

/**
 * `split` 新片段 id（P5 推荐案）：`<orig>-2` 递增，撞名再加 hex 后缀。
 * @param taken 全档已用 id 集合
 */
export function nextSplitId(orig: string, taken: Set<string>, hex: () => string): string {
	for (let n = 2; n <= 999; n++) {
		const cand = `${orig}-${n}`;
		if (!taken.has(cand)) return cand;
	}
	let cand = `${orig}-${hex()}`;
	while (taken.has(cand)) cand = `${orig}-${hex()}`;
	return cand;
}

// ────────────────────────────── set：承诺「有效值」 ──────────────────────────────

/** 契约的取值优先级是**三段**：clip 级 → 轨级 → 契约缺省。 */
export interface EffectiveValueCtx {
	/** 同名轨级键的值；不在场为 `undefined`。 */
	trackLevel: unknown;
	/** 契约缺省值。 */
	contractDefault: unknown;
}

export type SetForm = "deleted_key" | "explicit_value";

/**
 * 判 `set <key> <target>` 该删键还是显式写值（design D9）。
 *
 * ⚠️ **上一轮起草把「显式设为契约缺省值 ⇒ 删键」写成无条件规则，漏了中间那段**：
 * 删 clip 级键回落的是**轨级**值，不是契约缺省。轨级 `volume=0.5` 时 `set --volume 1.0` 若删键，
 * 有效值仍是 0.5 —— 命令报成功、调用方要的值没落地，**这是静默失败**（比拒写坏，也比多一个显式键坏）。
 *
 * 判定式：`trackLevel` 不在场且 `target === 契约缺省` ⇒ 删键；`trackLevel === target` ⇒ 删键
 * （回落轨级同样命中 target）；其余 ⇒ 显式写 `target`。
 */
export function decideSetForm(target: unknown, ctx: EffectiveValueCtx): SetForm {
	if (ctx.trackLevel === undefined) {
		return target === ctx.contractDefault ? "deleted_key" : "explicit_value";
	}
	return ctx.trackLevel === target ? "deleted_key" : "explicit_value";
}

// ────────────────────────────── 写出层 ──────────────────────────────

/**
 * 把导出值写回一个元素对象，**逐字节最小 diff**：
 * 只改本来就在场的时码键 + 按类别该在场的键；MUST NOT 顺手补出原本不在场的键
 * （尤其 gap/beat 的 `clip_st`/`clip_ed`，契约禁写）。
 *
 * @returns 新的 clip 对象（不改原对象，便于「入档跑一遍 / 出档跑一遍」求违规差）
 */
export function writeDerived(clip: Obj, cls: "clip" | "gap" | "beat", d: DerivedMs): Obj {
	const next: Obj = { ...clip };
	next.track_st = ms2sec(d.trackStMs);
	next.duration = ms2sec(d.durationMs);
	// track_ed 是契约标注的冗余字段：**只在原本在场时才更新**，不在场不新增。
	if ("track_ed" in clip) next.track_ed = ms2sec(d.trackEdMs);
	if (cls === "clip" && d.clipStMs !== null && d.clipEdMs !== null) {
		next.clip_st = ms2sec(d.clipStMs);
		if ("clip_ed" in clip) next.clip_ed = ms2sec(d.clipEdMs);
	}
	return next;
}

/** 按 `ElementRef` 把新 clip 对象放回一份**深拷贝**的 gtrk（原对象不动）。 */
export function replaceElement(gtrk: Obj, ref: ElementRef, nextClip: Obj): Obj {
	const next = structuredClone(gtrk) as Obj;
	const tracks = next[TRACK_KEYS[ref.kind]] as unknown[];
	const track = tracks[ref.trackArrayIndex] as Obj;
	(track.track_timeline as unknown[])[ref.clipArrayIndex] = nextClip;
	return next;
}

/** 在同一条轨的 `track_timeline` 里插入一个新元素（`split` 的后半用）。 */
export function insertElement(gtrk: Obj, ref: ElementRef, atArrayIndex: number, clip: Obj): Obj {
	const next = structuredClone(gtrk) as Obj;
	const tracks = next[TRACK_KEYS[ref.kind]] as unknown[];
	const track = tracks[ref.trackArrayIndex] as Obj;
	(track.track_timeline as unknown[]).splice(atArrayIndex, 0, clip);
	return next;
}

/** 元素类别（对外复用校验器口径）。 */
export function classOf(el: Element): "clip" | "gap" | "beat" {
	return classifyForValidation(el);
}

/** 顶层 `video_rate`。契约保证恒为正整数且已吸附标准帧率表；缺失或非正 ⇒ 抛。 */
export function videoRateOf(gtrk: Obj): number {
	const r = gtrk.video_rate;
	if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) {
		throw new Error(`工程缺少合法的 video_rate（读到 ${JSON.stringify(r)}）——帧对齐无从谈起`);
	}
	return r;
}
