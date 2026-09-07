/**
 * gtrk audio —— 音频轨零件族（add-audio-project-atoms）。
 *
 * `gtrk audio lay --project <dir> --file <音频> [--volume 0..1] [--offset ms] [--beat-align]`：
 * 往 `.gtrk` 追加一条 audio_track（BGM 上轨，纯本地）。
 *   - track_index 取现有音轨最大 +1；契约冗余时码齐全（clip_st/clip_ed/track_st/track_ed/duration）；
 *     MUST NOT 写 hidden（gtrk v1 契约：audio_track 结构上不可隐藏，该键对音轨恒无效且误导读方）。
 *   - 写回复用既有原子写回口径（writeGtrkAtomic：临时文件+rename，内容 revision 冲突拒写 + rename 前重检）。
 *   - 同源幂等：同一音频文件（同绝对路径）对同一工程重复 lay = 替换既有同源轨，不叠加第二条。
 *   - `--beat-align` 复用 mad 的 cloud-beat 基建（audio_music_analyze，按官网价格表计费、如实提示）：
 *     **把 BGM 的情绪峰值对齐到成片的高潮点，锚点前后按小节线平铺补齐**（判据链 + 几何见下）。
 *     无 Key / 分析失败 / 缺高潮点一律降级为不对齐 + 如实提示，MUST NOT 失败整命令；
 *     无 `--beat-align` 零云端零计费。
 *
 * ⚠️ **行为变更（redesign-beat-align-climax-anchor，主理人 2026-09-02 拍板）**：
 * `--beat-align` 的旧实现是「把整条 BGM 后推 firstDownbeat 秒」——分析对象是 **BGM 自时间轴**，
 * 工程时间轴里根本不存在它的消费方，净效果只是付一次云端分析的钱换来片头等长静音（净损失）。
 * 本次整套替换为「成片高潮点 ↔ BGM 高潮点对齐 + 前后 loop 补齐」。
 * ⇒ **开了 `--beat-align` 的旧产物不再逐字节可复现**；未开该 flag 的缺省路径产物字节零变化。
 *
 * 语义（正本＝ openspec 主规格 `audio-driven-project :: BGM 高潮点锚定（--beat-align）`）：
 *   ① 成片高潮点 `A`：判据链 ⑤--climax → ①reversal-elevation 最后一个 → ②container flip/rupture
 *      最后一个 → ③callback-closure 第一个 → ④0.75×全片（兜底，是猜的，MUST 明示）；命中即停，
 *      CLI MUST 如实报出用了哪一档。数据源是 `struct_meta.split.beats[]`（gtrk split 的投影快照）。
 *   ② BGM 情绪峰值 `H` = `output_result.highlight.time`（服务端既有字段，同一次分析、不额外计费）。
 *   ③ 锚定映射恒为 `轨秒 = A + (BGM 秒 − H)`；两侧不够长才平铺，**够长就零平铺**（恰好 1 个 clip）。
 *   ④ 平铺接缝吸附 downbeat（平铺体播 `[首个 downbeat, 末个 downbeat]`）——这才是 beats/downbeats
 *      在本命令里的唯一用途；轨的两个硬边界（`--offset` 与工程末尾）处的截断不吸附。
 */
import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import type { CloudConfig } from "../lib/config";
import { loadConfig } from "../lib/config";
import { assertGtrkV1, readGtrk, writeGtrkAtomic } from "../lib/gtrk-writeback";
import { assertGtrkWriteInvariants } from "../lib/gtrk-invariants";
import { probeDuration, probeAudioChannel, probeGeometry } from "../lib/media";
import {
	DEFAULT_ALIGN_THRESHOLD,
	alignOutputPath,
	alignProjectPath,
	buildAlignProject,
	detectOffset,
	muxExternalAudio,
	readAlignOffset,
	writeAlignProject,
} from "../lib/audio-align";
import { mkdir } from "node:fs/promises";
import { audioCacheDir } from "../lib/paths";
import { defaultExtsFor } from "../lib/tool-descriptors";
import { analyzeBgm } from "../lib/mad/cloud-beat";
import type { BeatAnalysis } from "../lib/mad/beat";
import { uploadCached, invalidateUpload } from "../lib/upload-cache";
import { submitTask } from "../lib/cloud";
import { pollToolTask } from "../lib/tool-runner";
import { recordBgmUseFromFile } from "../lib/bgm-history";
import { log, routeLogsToStderr } from "../lib/log";
import { requireFfmpeg, runFfmpeg } from "../lib/ffmpeg";
import {
	CVE_TICKS_PER_SEC,
	SILENCE_REL_THRESHOLD,
	SILENCE_WIN_SEC,
	TIGHTEN_BOUNDARY_TOL_DEFAULT,
	TIGHTEN_KEEP_DEFAULT,
	TIGHTEN_MIN_SILENCE_DEFAULT,
	detectSilenceRuns,
	keepIntervals,
	makeTightenMapper,
	planTightenCuts,
	splitIntervalsAt,
} from "../lib/audio-tighten";
import { r3 } from "../lib/frame-domain";

/** BGM 垫底音量默认值（clip 级 volume，客户端契约：clip 级优先于轨级）。 */
// ★ 主理人 2026-08-19 拍板:BGM 垫底口径 -20dB=线性 0.10(契约 volume 只写线性,MUST NOT 写 dB——composition-contract-v1 §4)
export const AUDIO_LAY_VOLUME_DEFAULT = 0.1;
/** 自产音轨素材 id 前缀（同源幂等的身份锚在素材 path，不在 id 前缀）。 */
export const AUDIO_LAY_MATERIAL_PREFIX = "audio-lay-";
/** 上轨最短可用长度（秒）：低于此长度视为无处可放。 */
const MIN_LAY_SEC = 0.05;

/** positional 解析：`lay` 或 `align [<视频> <外录>]`。 */
export function parseAudioPositional(
	words: string[] | undefined,
): { sub: "lay" } | { sub: "align"; video?: string; extAudio?: string } | { sub: "tighten" } {
	if (!words || words.length === 0) {
		throw new Error(
			"缺少子命令——用法：gtrk audio lay --project <目录> --file <音频>；gtrk audio align <视频> <外录音频>；或 gtrk audio tighten --project <目录>",
		);
	}
	if (words[0] === "lay") {
		if (words.length > 1) throw new Error(`未知参数「${words.slice(1).join(" ")}」——lay 不收 positional`);
		return { sub: "lay" };
	}
	if (words[0] === "align") {
		if (words.length > 3) throw new Error("align 最多收两个 positional：<视频毛片> <外录音频>");
		return { sub: "align", video: words[1], extAudio: words[2] };
	}
	if (words[0] === "tighten") {
		if (words.length > 1) throw new Error(`未知参数「${words.slice(1).join(" ")}」——tighten 不收 positional`);
		return { sub: "tighten" };
	}
	throw new Error(`未知子命令「${words.join(" ")}」——支持：gtrk audio lay / gtrk audio align / gtrk audio tighten`);
}

/** 素材 id：audio-lay-<sha256(音频绝对路径) 前 16 hex>——同源（同路径）恒同 id，幂等替换天然对齐。 */
export function audioLayMaterialId(audioAbs: string): string {
	return `${AUDIO_LAY_MATERIAL_PREFIX}${createHash("sha256").update(audioAbs, "utf8").digest("hex").slice(0, 16)}`;
}

/** 工程末尾（秒）：gtrk.duration 优先，缺失从 video_track 全部 clip 的 track_ed 包络推；推不出 undefined。 */
export function projectEndSec(gtrk: Record<string, unknown>): number | undefined {
	const declared = Number(gtrk.duration);
	if (Number.isFinite(declared) && declared > 0) return declared;
	let end = 0;
	for (const t of Array.isArray(gtrk.video_track) ? (gtrk.video_track as Record<string, unknown>[]) : []) {
		for (const c of Array.isArray(t.track_timeline) ? (t.track_timeline as Record<string, unknown>[]) : []) {
			const ed = Number(c.track_ed);
			if (Number.isFinite(ed) && ed > end) end = ed;
			else {
				const st = Number(c.track_st);
				const dur = Number(c.duration);
				if (Number.isFinite(st) && Number.isFinite(dur) && st + dur > end) end = st + dur;
			}
		}
	}
	return end > 0 ? end : undefined;
}

// ── 成片高潮点：判据链 ①–⑤（纯函数，喂假 gtrk 可单测、不触云端不读盘）──────────────
//
// ⚠️ 旧的 `snapToGrid(offsetSec, grid)` 已随本次语义替换删除（redesign-beat-align-climax-anchor
// tasks 3.11）：它把 **BGM 自时间轴**的 downbeat 当成工程时间轴的落点，是旧口径的实现核心，
// 换语义后全仓零调用。档④的「吸附到最近**派单 beat** 边界」是**另一个网格**（工程轴 vs BGM 轴），
// 语义不同 ⇒ MUST NOT 复用那个函数名去承载它，故本文件内不再有任何叫 `snapToGrid` 的东西。

/** 成片高潮点的来源档位（CLI MUST 如实报出用了哪一档）。 */
export type ClimaxSource =
	| "explicit"
	| "reversal-elevation"
	| "container-flip"
	| "container-rupture"
	| "callback-closure"
	| "three-act-guess";

export interface ClimaxPick {
	/** 成片高潮点（**轨**秒）。 */
	sec: number;
	source: ClimaxSource;
	/** 仅档④有意义：是否吸附到了**派单 beat** 边界（无 `split.beats` 时 false）。 */
	snapped: boolean;
	/** 命中的派单 beat id（档④吸附上时是被吸附到的那个边界所属 beat）；无则 undefined。 */
	beatId?: string;
}

/**
 * `--climax <sec>` 的数值解析：非数 ⇒ 抛错。
 *
 * MUST NOT 静默回落到判据链——逃生门被静默忽略就不是逃生门了（口径对齐 `--offset` 越界抛错；
 * `--volume` 那种「非法回落 + 告警」是给取值域笔误留的，不适用于「用户明确指定了一个位置」）。
 */
export function parseClimaxOpt(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n)) throw new Error(`--climax 需要秒数（成片高潮点在轨上的时刻），拿到「${raw}」`);
	return n;
}

/**
 * 判据链 ⑤①②③④，命中即停。纯函数：喂假 gtrk 即可单测。
 *
 * 三条实现纪律（design §一）：
 *  1. 扫描前 MUST 按 `track_st` 显式升序排序 —— 盘上本来有序，但 MUST NOT 依赖盘上顺序；
 *  2. 字段缺失容忍 —— `-aux<n>` 叠层 beat 盘上实测**没有** `narrative` / `container_stage` 两个键
 *     （2026-09-02 复核 `D:/file/tmp/travel-260902/P1/gtrk/project.gtrk` 的 `B03-aux1`：
 *     keys 只有 id/lane/span/track_st/track_ed/category/source_ranges）。比较前 MUST
 *     `typeof === "string"` 过滤，MUST NOT 让 `undefined` 参与比较后误命中；
 *  3. 档④的「beat 边界」= **派单 beat** 的 `track_st` / `track_ed` 全集，**不是** BGM 的 `beats`
 *     （本仓这个词一词两义，变量名与日志 MUST 写全称消歧）。无 `split.beats` 时不吸附。
 *
 * ⚠️ 越界处置分两路：`--climax` 越界 ⇒ **抛错**；①–④ 自己算出的值越界（如 split 时码陈旧）⇒
 * 由调用方降级为不锚定，本函数照常返回（合法域判定不在这里做，因为「返回什么」与「怎么降级」是两件事）。
 */
export function pickClimaxSec(
	gtrk: Record<string, unknown>,
	o: { climaxOpt?: string; projEnd: number; offsetSec: number },
): ClimaxPick {
	// ⑤ 逃生门：一律覆盖 ①–④
	const explicit = parseClimaxOpt(o.climaxOpt);
	if (explicit !== undefined) {
		if (explicit <= o.offsetSec || explicit >= o.projEnd) {
			throw new Error(
				`--climax ${explicit}s 越界：须落在 (${r3(o.offsetSec)}s, ${r3(o.projEnd)}s) 之内` +
					`（左界是 --offset、右界是工程末尾）`,
			);
		}
		return { sec: r3(explicit), source: "explicit", snapped: false };
	}

	const split = ((gtrk.struct_meta as Record<string, unknown> | undefined)?.split ?? {}) as {
		beats?: unknown;
	};
	const dispatchBeats = (Array.isArray(split.beats) ? (split.beats as Record<string, unknown>[]) : [])
		.filter((b) => b && typeof b === "object" && Number.isFinite(Number(b.track_st)))
		.sort((a, b) => Number(a.track_st) - Number(b.track_st));

	const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
	const idOf = (b: Record<string, unknown>): string | undefined => str(b.id);
	const lastWith = (pred: (b: Record<string, unknown>) => boolean): Record<string, unknown> | undefined => {
		for (let i = dispatchBeats.length - 1; i >= 0; i--) if (pred(dispatchBeats[i]!)) return dispatchBeats[i];
		return undefined;
	};
	const firstWith = (pred: (b: Record<string, unknown>) => boolean): Record<string, unknown> | undefined =>
		dispatchBeats.find(pred);

	// ① 升华段（reversal-elevation）——分多段是递进的，顶点在**最后一次**的起点
	const elev = lastWith((b) => str(b.narrative) === "reversal-elevation");
	if (elev) return { sec: r3(Number(elev.track_st)), source: "reversal-elevation", snapped: false, beatId: idOf(elev) };

	// ② 容器语言里的转折点：flip 优先于 rupture，各取最后一个
	const flip = lastWith((b) => str(b.container_stage) === "flip");
	if (flip) return { sec: r3(Number(flip.track_st)), source: "container-flip", snapped: false, beatId: idOf(flip) };
	const rupture = lastWith((b) => str(b.container_stage) === "rupture");
	if (rupture) {
		return { sec: r3(Number(rupture.track_st)), source: "container-rupture", snapped: false, beatId: idOf(rupture) };
	}

	// ③ 回扣之前即高潮：取回扣段**第一个**的起点＝「高潮刚过」，偏晚但仍在段落边界上
	const cb = firstWith((b) => str(b.narrative) === "callback-closure");
	if (cb) return { sec: r3(Number(cb.track_st)), source: "callback-closure", snapped: false, beatId: idOf(cb) };

	// ④ 兜底：三幕结构第三幕的常规位置，吸附到最近的**派单 beat** 边界（不是 BGM 的 beats）
	const guess = 0.75 * o.projEnd;
	let bestSec: number | undefined;
	let bestId: string | undefined;
	for (const b of dispatchBeats) {
		for (const key of ["track_st", "track_ed"] as const) {
			const t = Number(b[key]);
			if (!Number.isFinite(t)) continue;
			if (bestSec === undefined || Math.abs(t - guess) < Math.abs(bestSec - guess)) {
				bestSec = t;
				bestId = idOf(b);
			}
		}
	}
	if (bestSec === undefined) return { sec: r3(guess), source: "three-act-guess", snapped: false };
	return { sec: r3(bestSec), source: "three-act-guess", snapped: true, beatId: bestId };
}

// ── 锚定 + 平铺几何（纯函数）────────────────────────────────────────────────
//
// ⚠️ 全程走**整毫秒整数**运算，不是「各自 r3() 后相减」。
// 理由：契约要求相邻段零 gap（U1 邻段）与末段 track_ed 严丝合缝对齐工程末尾，而浮点秒各自
// 四舍五入后相减会开出亚毫秒缝（同类坑见 change `fix-gapfill-subframe-residue`）。
// 整数 ms 让「上一段的端点」与「下一段的起点」是**同一个整数**，零 gap 是构造性的、不是断言出来的。

const MS = 1000;
const toMs = (s: number): number => Math.round(s * MS);
const secOf = (m: number): number => m / MS;

export interface AnchoredPiece {
	clip_st: number;
	clip_ed: number;
	track_st: number;
	track_ed: number;
	duration: number;
}

export type AnchoredPlan =
	| {
			ok: true;
			pieces: AnchoredPiece[];
			headTiles: number;
			tailTiles: number;
			/** 平铺接缝是否落在小节线上（网格不可用 / 退化时 false）。无接缝时无意义。 */
			seamSnapped: boolean;
			/** `--no-loop` 时头 / 尾的留白秒数（缺省口径下恒 0）。 */
			headGapSec: number;
			tailGapSec: number;
			/** 需如实告知的退化说明（MUST NOT 静默）。 */
			notes: string[];
	  }
	| { ok: false; reason: string };

/**
 * 在锚定映射 `轨秒 = A + (BGM 秒 − H)` 上，把 `[O, T]` 这段轨铺满。
 *
 * 几何（design §二/§三）：
 *   headNeed = A − O、headHave = H；tailNeed = T − A、tailHave = D − H
 *   两侧「够长」⇒ 核心段直接顶到轨边界，**零平铺、恰好 1 个 clip**（产品承诺，不是优化）；
 *   不够长 ⇒ 该侧核心端点裁到 downbeat（`bodySt` / `bodyEd`），再拿平铺体 `[bodySt, bodyEd]` 补齐。
 *
 * **关键性质：把核心段的头/尾裁到 downbeat 上不会移动锚点。** 锚点由映射式钉死，裁剪只改
 * 「这段轨由哪个 clip 覆盖」，不改「H 落在 A」⇒ 「接缝吸附」与「锚点精确」不冲突。
 *
 * 边界残渣不设 MIN_LAY 地板：最左 / 最右那段直接截到 `O` / `T`，哪怕只剩几毫秒也照铺。
 * 因为「末段 track_ed 对齐工程末尾」「头部铺满至 offset」是硬口径，留个 <50ms 的空洞就是违约；
 * 而多出一个几毫秒的 clip 无害（渲染侧照读）。
 */
export function planAnchoredClips(p: {
	/** A：成片高潮点（轨秒）。 */
	climaxSec: number;
	/** H：BGM 情绪峰值（BGM 秒）。 */
	peakSec: number;
	/** O：`--offset`（轨秒，BGM 床的左边界）。 */
	offsetSec: number;
	/** T：工程末尾（轨秒）。 */
	projEnd: number;
	/** D：BGM 全长（秒）。 */
	audioDur: number;
	/** 节拍网格（downbeats 优先、缺失回退 beats；BGM 自时间轴秒）。 */
	grid: number[];
	/** `--no-loop`：不为锚定补齐，只放核心段、头尾留白。 */
	noLoop: boolean;
}): AnchoredPlan {
	const A = toMs(p.climaxSec);
	const H = toMs(p.peakSec);
	const O = toMs(p.offsetSec);
	const T = toMs(p.projEnd);
	const D = toMs(p.audioDur);
	const MIN = toMs(MIN_LAY_SEC);
	const notes: string[] = [];

	// 平铺体 [bodySt, bodyEd]：缺省整条 [0, D]；网格可用则收到 [首个 downbeat, 末个 downbeat]，
	// 让每个接缝都是「小节线 → 小节线」。两条退化守卫按 design §二 各如实报一次。
	let bodySt = 0;
	let bodyEd = D;
	let seamSnapped = false;
	const grid = p.grid
		.filter((t) => Number.isFinite(t) && t >= 0)
		.map(toMs)
		.filter((t) => t <= D)
		.sort((a, b) => a - b);
	if (grid.length >= 2) {
		const gFirst = grid[0]!;
		const gLast = grid[grid.length - 1]!;
		const headOk = gFirst < H;
		const tailOk = gLast > H;
		if (!headOk) {
			notes.push(
				`首个 downbeat（${secOf(gFirst)}s）不早于 BGM 峰值（${secOf(H)}s）——头侧退化为曲子开头 0s，该接缝未吸附小节线`,
			);
		}
		if (!tailOk) {
			notes.push(
				`末个 downbeat（${secOf(gLast)}s）不晚于 BGM 峰值（${secOf(H)}s）——尾侧退化为曲子末尾 ${secOf(D)}s，该接缝未吸附小节线`,
			);
		}
		const bs = headOk ? gFirst : 0;
		const be = tailOk ? gLast : D;
		if (be - bs >= MIN) {
			bodySt = bs;
			bodyEd = be;
			seamSnapped = headOk && tailOk;
		} else {
			notes.push(`节拍网格首末间距不足 ${MIN_LAY_SEC}s——平铺体退化为整条 [0, ${secOf(D)}s]，接缝未吸附小节线`);
		}
	} else {
		notes.push("云端未返回可用节拍网格（无节拍音乐？）——平铺体退化为整条曲子，接缝未吸附小节线");
	}
	const L = bodyEd - bodySt;

	const headNeed = A - O;
	const tailNeed = T - A;
	const headEnough = H >= headNeed;
	const tailEnough = D - H >= tailNeed;
	const needTile = (!headEnough || !tailEnough) && !p.noLoop;
	if (needTile && L < MIN) {
		return { ok: false, reason: `平铺体长度不足 ${MIN_LAY_SEC}s（BGM 全长 ${secOf(D)}s）——无从补齐` };
	}

	// 核心段（锚点所在的那一段）
	let coreClipSt: number;
	let coreTrackSt: number;
	if (headEnough) {
		coreClipSt = H - headNeed;
		coreTrackSt = O;
	} else if (p.noLoop) {
		coreClipSt = 0; // 「能给多少给多少」，剩下的留白
		coreTrackSt = A - H;
	} else {
		coreClipSt = bodySt;
		coreTrackSt = A - (H - coreClipSt);
	}
	let coreClipEd: number;
	let coreTrackEd: number;
	if (tailEnough) {
		coreClipEd = H + tailNeed;
		coreTrackEd = T;
	} else if (p.noLoop) {
		coreClipEd = D;
		coreTrackEd = A + (D - H);
	} else {
		coreClipEd = bodyEd;
		coreTrackEd = A + (coreClipEd - H);
	}
	if (coreTrackEd - coreTrackSt < MIN) {
		return {
			ok: false,
			reason: `锚定后核心段可用长度不足 ${MIN_LAY_SEC}s（${secOf(coreTrackEd - coreTrackSt)}s）——无处可放`,
		};
	}

	const mk = (clipSt: number, clipEd: number, trackSt: number, trackEd: number): AnchoredPiece => ({
		clip_st: secOf(clipSt),
		clip_ed: secOf(clipEd),
		track_st: secOf(trackSt),
		track_ed: secOf(trackEd),
		duration: secOf(trackEd - trackSt),
	});

	// 头部平铺（向左）：每段**右对齐** bodyEd，于是它的右端与下一段的左端（bodySt）构成
	// 「末个 downbeat → 首个 downbeat」的接缝。最左那段被 O 截在**左端**——那是整条轨的最开头，
	// 本来就是弱起位置，音乐上是自然的 anacrusis。
	const head: AnchoredPiece[] = [];
	let leftMost = coreTrackSt;
	while (!p.noLoop && leftMost > O) {
		const pieceLen = Math.min(L, leftMost - O);
		head.push(mk(bodyEd - pieceLen, bodyEd, leftMost - pieceLen, leftMost));
		leftMost -= pieceLen; // 下一段的右端直接取本段左端 ⇒ 零 gap 是构造性的
	}
	head.reverse(); // 头部段是倒着算出来的，MUST 反转后再拼（最终 clips 按 track_st 升序）

	// 尾部平铺（向右）：每段**左对齐** bodySt；最右那段被 T 截在**右端**。
	const tail: AnchoredPiece[] = [];
	let rightMost = coreTrackEd;
	while (!p.noLoop && rightMost < T) {
		const pieceLen = Math.min(L, T - rightMost);
		tail.push(mk(bodySt, bodySt + pieceLen, rightMost, rightMost + pieceLen));
		rightMost += pieceLen;
	}

	return {
		ok: true,
		pieces: [...head, mk(coreClipSt, coreClipEd, coreTrackSt, coreTrackEd), ...tail],
		headTiles: head.length,
		tailTiles: tail.length,
		seamSnapped,
		// 留白只可能出现在 --no-loop 下（缺省口径两侧一律铺满到 O / T）。
		headGapSec: secOf(Math.max(0, leftMost - O)),
		tailGapSec: secOf(Math.max(0, T - rightMost)),
		notes,
	};
}

interface LooseTrack {
	track_index?: number;
	track_timeline?: { material?: unknown }[];
	[k: string]: unknown;
}
interface LooseMaterial {
	id?: unknown;
	path?: unknown;
	[k: string]: unknown;
}

export interface AudioLayOpts {
	project?: string;
	file?: string;
	volume?: string;
	offset?: string;
	beatAlign?: boolean;
	/** `--climax <sec>`：成片高潮点逃生门（轨秒），一律覆盖判据链 ①–④。 */
	climax?: string;
	/**
	 * 关闭平铺补齐。
	 * - 未开 `--beat-align`：保留单次（不循环叠满至工程末尾）——旧口径不变；
	 * - 开了 `--beat-align`：只放锚点那一段，头尾留白（留白秒数如实报出）。
	 *
	 * ⚠️ **两个键都要收**：commander 把 `--no-loop` 解析成 `opts.loop`（给了 = `false`、
	 * 缺省 = `true`），**不会**产生 `opts.noLoop`。既有代码只读 `noLoop` ⇒ 从 CLI 传
	 * `--no-loop` 一直是**哑火**的（单测直接传 `{ noLoop: true }` 所以从未暴露）。
	 * 见 `noLoopOf()`。
	 */
	noLoop?: boolean;
	/** commander 对 `--no-loop` 的真实落点（给了 = false）。 */
	loop?: boolean;
	json?: boolean;
}

/**
 * `--no-loop` 的取值归一。
 *
 * ⚠️ 2026-09-02 实测（commander v12，`new Command().command("audio [w...]").option("--no-loop")`）：
 * 传 `--no-loop` ⇒ `{ loop: false }`；不传 ⇒ `{ loop: true }`。**`noLoop` 恒 undefined。**
 * 而实现一直只看 `opts.noLoop !== true` ⇒ **CLI 上的 `--no-loop` 从来没生效过**，
 * 尽管 README 与 `skills/gtrk-travel-recap/SKILL.md:192` 都写着「要单次铺请显式传 `--no-loop`」。
 * 这里同时认两个键：`loop === false` 是 CLI 真实入口，`noLoop === true` 是单测/程序调用的形状。
 */
export function noLoopOf(opts: { noLoop?: boolean; loop?: boolean }): boolean {
	return opts.noLoop === true || opts.loop === false;
}

/** 测试注入面（MUST NOT 真调云端）；缺省 = ffprobe / 真云端节拍分析。 */
export interface AudioLayDeps {
	probeDur?: (path: string) => number;
	probeChannel?: (path: string) => string | undefined;
	loadCfg?: () => CloudConfig;
	analyze?: (cfg: CloudConfig, bgmAbs: string) => Promise<BeatAnalysis>;
}

export interface AudioLayResult {
	ok: true;
	mode: "audio-lay";
	gtrkPath: string;
	trackIndex: number;
	/** 同源幂等替换掉的既有音轨条数。 */
	replacedTracks: number;
	materialId: string;
	volume: number;
	offsetMs: number;
	clip: { clip_st: number; clip_ed: number; track_st: number; track_ed: number; duration: number };
	/** loop 铺满 / 锚点平铺时的总段数（零平铺=1）。 */
	loopCount: number;
	/** 仅 --beat-align 时出现：锚定成败、落位与降级原因（降级不失败整命令）。 */
	beatAlign?: {
		aligned: boolean;
		grid: "downbeats" | "beats" | null;
		/** 成片高潮点（轨秒）与它的来源档位。 */
		climaxSec?: number;
		climaxSource?: ClimaxSource;
		/** 仅档④：是否吸附到了**派单 beat** 边界（无 `split.beats` 时 false）。 */
		climaxSnapped?: boolean;
		/** 命中的派单 beat id（无则缺省）。 */
		climaxBeatId?: string;
		/** BGM 情绪峰值（BGM 秒）= `output_result.highlight.time`。 */
		bgmPeakSec?: number;
		/** 接缝是否吸附到 downbeat；零平铺（无接缝）时缺省。 */
		seamSnapped?: boolean;
		headTiles: number;
		tailTiles: number;
		/** `--no-loop` 时头 / 尾留白秒数（>0 才出现）。 */
		headGapSec?: number;
		tailGapSec?: number;
		degradedReason?: string;
	};
}

/** --volume 解析：[0,1] 浮点，非法值按默认（告警，口径同 --score-floor）。 */
function parseVolume(raw: string | undefined): number {
	if (raw === undefined) return AUDIO_LAY_VOLUME_DEFAULT;
	const n = Number(raw);
	if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
	log.warn(`--volume 取值非法（${raw}），按默认 ${AUDIO_LAY_VOLUME_DEFAULT} 处理`);
	return AUDIO_LAY_VOLUME_DEFAULT;
}

/** --offset 解析：非负毫秒整数，非法值按 0（告警）。 */
function parseOffsetMs(raw: string | undefined): number {
	if (raw === undefined) return 0;
	const n = Number(raw);
	if (Number.isFinite(n) && n >= 0) return Math.round(n);
	log.warn(`--offset 取值非法（${raw}），按 0 处理`);
	return 0;
}

/** 定位工程文件（沿 split/matrix 候选链）。 */
function locateGtrk(baseDir: string): string {
	const cands = [join(baseDir, "gtrk", "project.gtrk"), join(baseDir, "project.gtrk")];
	const hit = cands.find((p) => existsSync(p));
	if (!hit) throw new Error(`未找到工程文件（${cands[0]}）——需要 oralcut / project init 产物目录`);
	return hit;
}

/**
 * 「如实告知」的人读一行（spec：落轨后 SHALL 报出「哪一档判据 / 成片第几秒 / BGM 峰值第几秒 /
 * 头尾各平铺了几次」；零平铺 MUST 明说「未平铺」；档④ MUST 自带「兜底、是猜的」免责）。
 *
 * 档④走 `log.warn` 而不是 `log.info`：真机反事实实测它与档①在三条旅拍上差 +8.68 / −29.68 / +16.20 秒
 * ——它不是档①的近似值，是**另一个点**，用户有权一眼看见这是猜的。
 */
function logClimaxAlign(
	ba: NonNullable<AudioLayResult["beatAlign"]>,
	plan: Extract<AnchoredPlan, { ok: true }>,
	pick: ClimaxPick,
	noLoop: boolean,
): void {
	const idSuffix = pick.beatId ? `${pick.beatId} 起点` : "";
	const label =
		pick.source === "explicit"
			? "档⑤·--climax 显式指定"
			: pick.source === "reversal-elevation"
				? `档①·升华段 ${idSuffix}`
				: pick.source === "container-flip"
					? `档②·容器转折 flip ${idSuffix}`
					: pick.source === "container-rupture"
						? `档②·容器转折 rupture ${idSuffix}`
						: pick.source === "callback-closure"
							? `档③·回扣段 ${idSuffix}（取回扣起点＝高潮刚过）`
							: `档④·兜底猜的＝0.75×全片，${
									pick.snapped ? `已吸附到派单 beat 边界（${idSuffix}）` : "工程无 split 派单可吸附、未吸附"
								}`;
	const tiles = plan.headTiles + plan.tailTiles;
	const entry = plan.pieces[plan.headTiles]?.clip_st ?? plan.pieces[0]!.clip_st;
	const tileText =
		tiles > 0
			? `头 ${plan.headTiles} 次 / 尾 ${plan.tailTiles} 次平铺（接缝${plan.seamSnapped ? "已" : "未"}吸附小节线）`
			: noLoop
				? "头 0 次 / 尾 0 次平铺（未平铺 —— 你给了 --no-loop，不为锚定补齐）"
				: "头 0 次 / 尾 0 次平铺（未平铺 —— 曲子两侧都够长，同一条曲子首尾相接会听感重复，能不铺就不铺）";
	const line =
		`高潮点对齐：成片高潮 ${ba.climaxSec}s（${label}）↔ BGM 峰值 ${ba.bgmPeakSec}s；` +
		`入点 ${entry}s；${tileText}`;
	if (pick.source === "three-act-guess") log.warn(`${line}　⚠️ 本档是兜底，位置是**猜**的，不是从派单读出来的`);
	else log.info(line);
	if (plan.headGapSec > 0 || plan.tailGapSec > 0) {
		const gaps = [
			...(plan.headGapSec > 0 ? [`头部留白 ${plan.headGapSec}s`] : []),
			...(plan.tailGapSec > 0 ? [`尾部留白 ${plan.tailGapSec}s`] : []),
		];
		log.info(`--no-loop：不为锚定补齐，${gaps.join(" / ")}（这些段没有 BGM）`);
	}
	if (tiles > 0 && plan.seamSnapped) {
		log.info(
			"接缝已落在小节线上（downbeat → downbeat）；但 downbeat 保证的是节拍对齐、**不是乐句完整**，" +
				"乐句被拦腰截断仍可能听得出——这是平铺的真实代价，验收时请逐个接缝听一遍。",
		);
	}
}

/** 命令主逻辑（导出供测试）。 */
export async function runAudioLay(opts: AudioLayOpts, deps: AudioLayDeps = {}): Promise<AudioLayResult> {
	if (opts.json) routeLogsToStderr();
	if (!opts.project) throw new Error("需要 --project <目录>（工程产物目录）");
	if (!opts.file) throw new Error("需要 --file <音频>（要上轨的 BGM/音频文件）");

	const audioAbs = resolve(opts.file);
	if (!existsSync(audioAbs)) throw new Error(`音频文件不存在：${audioAbs}`);
	const ext = extname(audioAbs).toLowerCase();
	if (!(defaultExtsFor("audio") ?? []).includes(ext)) {
		throw new Error(`不支持的音频格式「${ext || "无扩展名"}」；请输入本地音频文件（wav/mp3/flac/m4a/aac/ogg 等）`);
	}
	const volume = parseVolume(opts.volume);
	const offsetMs = parseOffsetMs(opts.offset);
	const noLoop = noLoopOf(opts);

	const gtrkPath = locateGtrk(resolve(opts.project));
	// 工程读取①（计算用）：锚点判据链（成片高潮点 / 工程末尾 / 循环铺满段数）按这份算。
	// ⚠️ 它的 revision **不作写回 expected**——下方云端节拍分析是分钟级动作，持有跨越它的
	// revision 会让「客户端自动保存了一次」直接作废整轮（含已计费的云端分析）。见工程读取②。
	const { gtrk, revision: planningRevision } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);

	const probeDur = deps.probeDur ?? ((p: string) => probeDuration(p));
	const probeChannel = deps.probeChannel ?? ((p: string) => probeAudioChannel(p));
	const audioDur = probeDur(audioAbs);
	if (!(audioDur > 0)) throw new Error(`探测不到有效音频时长：${audioAbs}`);
	log.step(`▶ 音频上轨：${basename(audioAbs)}（${audioDur.toFixed(1)}s · 音量 ${volume}${opts.beatAlign ? " · beat 对齐" : ""}）`);

	const projEnd = projectEndSec(gtrk);
	// ⚠️ track_st 的起算恒为 --offset。旧实现在这里把它改写成「最近 downbeat」（净损失：
	// 片头凭空多出等长静音），本件已删除那一刀 —— 见文件头注的行为变更说明。
	const trackSt = r3(offsetMs / 1000);
	if (projEnd !== undefined && trackSt >= projEnd) {
		throw new Error(`--offset ${offsetMs}ms 落在工程末尾（${projEnd.toFixed(2)}s）之外，无处可放`);
	}
	if (opts.climax !== undefined && !opts.beatAlign) {
		// 逃生门只在锚定路径上有落点；静默忽略会让用户以为高潮点被采纳了。
		throw new Error("--climax 只在 --beat-align 下生效（它是成片高潮点判据链的逃生门）——请补上 --beat-align");
	}

	// ── --beat-align：成片高潮点 × BGM 情绪峰值锚定 + 前后平铺补齐 ──────────────
	// 顺序有意为之：**先算成片高潮点（纯本地零计费），算不出就别花钱调云端**。
	// 云端 audio_music_analyze 是计费的，而 A 算不出来时 highlight 拿回来也无处可用。
	let beatAlign: AudioLayResult["beatAlign"];
	let anchored: Extract<AnchoredPlan, { ok: true }> | undefined;
	if (opts.beatAlign) {
		beatAlign = { aligned: false, grid: null, headTiles: 0, tailTiles: 0 };
		// 降级一律**整体重置**而不是只挂一个 reason：否则「先锚定成功、后续步骤再抛错」时
		// 会留下 aligned:true + degradedReason 的自相矛盾出参（哑的，比崩更难发现）。
		const degrade = (reason: string): void => {
			anchored = undefined;
			beatAlign = {
				aligned: false,
				grid: null,
				headTiles: 0,
				tailTiles: 0,
				degradedReason: `${reason}——BGM 照常上轨（不锚定，回到 loop 铺满缺省口径）`,
			};
			log.warn(`高潮点锚定降级：${beatAlign.degradedReason}`);
		};
		// ⑤ 的非数校验必须先跑：projEnd 推不出时也不能把一个笔误静默吃掉。
		parseClimaxOpt(opts.climax);
		let pick: ClimaxPick | undefined;
		if (projEnd === undefined) {
			degrade("工程末尾推不出（无 duration 且 video_track 为空），成片高潮点无从定位");
		} else {
			// ⚠️ pickClimaxSec 对 --climax 越界/非数 **抛错**（逃生门不静默回落），这里不吞。
			const p = pickClimaxSec(gtrk, { climaxOpt: opts.climax, projEnd, offsetSec: trackSt });
			if (!(p.sec > trackSt && p.sec < projEnd)) {
				degrade(
					`判据链算出的成片高潮点 ${p.sec}s（${p.source}）落在 (${trackSt}s, ${r3(projEnd)}s) 之外` +
						`——split 派单时码可能已陈旧`,
				);
			} else {
				pick = p;
			}
		}
		if (pick && projEnd !== undefined) {
			try {
				const cfg = (deps.loadCfg ?? loadConfig)();
				log.info("节拍分析走云端 audio_music_analyze（计费一次，价格以官网价格表为准）…");
				const analyze =
					deps.analyze ??
					((c: CloudConfig, p2: string) =>
						analyzeBgm(c, p2, { uploadCached, invalidateUpload, submitTask, pollToolTask }));
				const analysis = await analyze(cfg, audioAbs);
				const gridName: "downbeats" | "beats" | null = analysis.downbeats?.length
					? "downbeats"
					: analysis.beats?.length
						? "beats"
						: null;
				const grid = gridName === "downbeats" ? analysis.downbeats! : gridName === "beats" ? analysis.beats! : [];
				const peak = analysis.highlightSec;
				if (peak === undefined) {
					// highlight.py:44-45 —— 音频 < 10s 时服务端合法返回 None，这不是错误。
					degrade("云端分析未返回情绪峰值 highlight（音频短于 10s？）");
				} else if (!(peak >= 0 && peak <= audioDur)) {
					degrade(`云端返回的情绪峰值 ${peak}s 不在 [0, ${r3(audioDur)}s] 内（服务端异常值）`);
				} else {
					if (gridName === "beats") log.info("downbeat 缺失，接缝吸附回退 beats 网格");
					const plan = planAnchoredClips({
						climaxSec: pick.sec,
						peakSec: peak,
						offsetSec: trackSt,
						projEnd,
						audioDur,
						grid,
						noLoop,
					});
					if (!plan.ok) {
						degrade(plan.reason);
					} else {
						anchored = plan;
						beatAlign = {
							aligned: true,
							grid: gridName,
							climaxSec: pick.sec,
							climaxSource: pick.source,
							...(pick.source === "three-act-guess" ? { climaxSnapped: pick.snapped } : {}),
							...(pick.beatId ? { climaxBeatId: pick.beatId } : {}),
							bgmPeakSec: r3(peak),
							...(plan.headTiles + plan.tailTiles > 0 ? { seamSnapped: plan.seamSnapped } : {}),
							headTiles: plan.headTiles,
							tailTiles: plan.tailTiles,
							...(plan.headGapSec > 0 ? { headGapSec: plan.headGapSec } : {}),
							...(plan.tailGapSec > 0 ? { tailGapSec: plan.tailGapSec } : {}),
						};
						// 网格退化说明只在**真的平铺了**时才有意义（零平铺无接缝可谈）——不制造迷惑噪音。
						if (plan.headTiles + plan.tailTiles > 0) for (const n of plan.notes) log.info(`高潮点锚定：${n}`);
						logClimaxAlign(beatAlign, plan, pick, noLoop);
					}
				}
			} catch (e) {
				degrade(e instanceof Error ? e.message : String(e));
			}
		}
	}

	// ── clip 窗口：BGM 从头播（clip_st=0），工程末尾裁剪（工程长度未知则整条上）。
	// loop 铺满（adjust-audio-lay-loop-fill，真机挑刺 2026-08-27）：BGM 短于剩余时间线时
	// 缺省循环叠满至工程末尾（多 clip 首尾相接、尾段裁齐）——BGM 铺一半就静音是明显缺陷；
	// --no-loop 保留单次行为。工程长度未知（projEnd undefined）时无「满」可言，恒单次。
	// ⚠️ 锚定成功时本段整体不参与（clip 窗口由 planAnchoredClips 给出）；锚定降级时逐字回到本段口径，
	// 保证「无 --beat-align / 锚定降级」两条路径的产物与本件落地前逐字节一致。
	const maxLen = projEnd !== undefined ? Math.max(0, projEnd - trackSt) : audioDur;
	const loop = !noLoop && projEnd !== undefined;
	const len = r3(Math.min(audioDur, maxLen));
	if (!anchored) {
		if (len < MIN_LAY_SEC) throw new Error(`起点 ${trackSt}s 之后已放不下音频（工程末尾 ${projEnd?.toFixed(2)}s）`);
		if (!loop && len < audioDur - 1e-6) {
			log.info(`音频长于剩余时间线，已在工程末尾裁剪（上轨 ${len}s / 全长 ${r3(audioDur)}s）`);
		}
	}

	// ── 工程读取②（写回用）：耗时动作全部完成后才取 revision ─────────────────────────────
	// 云端 audio_music_analyze 是**分钟级且计费**的动作；持有跨越它的 revision，用户在此期间
	// 在客户端存一次工程（自动保存每 60s 一次，与他有没有未保存改动无关），本轮就整体白跑——
	// 而那次云端分析的钱**已经花了**。此刻重读后冲突窗口 = 重读到 rename 的毫秒级，且
	// writeGtrkAtomic 的 rename 前重检照旧兜底（那条 MUST NOT 删）。
	//
	// ★ MUST 整体迁移基底，MUST NOT 只换 revision：下方 materials / audioTracks / stillReferenced /
	// next 的展开若还从**读①**那份 `gtrk` 出发，就会写出一份不含用户那次保存的整文件——
	// 且因 revision 相符而通过全部校验、无任何告警。那比报冲突坏得多（gtrk-writeback-contract
	// 「只换 revision 不换基底 = 静默覆盖」）。本行以下**一律用 `freshGtrk`**。
	const { gtrk: freshGtrk, revision } = readGtrk(gtrkPath);
	assertGtrkV1(freshGtrk);
	// 基底漂移 MUST NOT 静默：窗口内工程真被改过时，本轮锚点算的是读①那份工程，却要落到读②这份上。
	// 文案贴 BGM 语义（MUST NOT 照抄 matrix 那句——它讲的是 B-roll 槽位对不齐，与节拍锚点不是一回事）。
	if (revision !== planningRevision) {
		log.warn(
			"工程在本轮 BGM 上轨期间被改动过（云端节拍分析进行中，你在客户端保存了工程）：已按**改后**的" +
				"工程落轨写回，你那次保存不会被覆盖；但本轮的成片高潮点、工程末尾与循环铺满段数都是按改动前的" +
				"时间线算的——若你改的正是时间线长度或 split 派单，BGM 锚点可能与新时间线对不齐。" +
				"觉得不对就重跑一次本命令（⚠️ 会重新调用云端节拍分析，**再计费一次**；音频文件本身不会重传）。",
		);
	}

	// ── 同源幂等替换：同绝对路径素材所在的既有音轨全部剥除（含旧素材，零引用保护后）──
	const materials = [...((freshGtrk.materials as LooseMaterial[] | undefined) ?? [])];
	const audioTracks = [...((freshGtrk.audio_track as LooseTrack[] | undefined) ?? [])];
	const materialId = audioLayMaterialId(audioAbs);
	const sameSourceIds = new Set<string>(
		materials.filter((m) => typeof m.id === "string" && m.path === audioAbs).map((m) => m.id as string),
	);
	sameSourceIds.add(materialId);
	const keptTracks = audioTracks.filter(
		(t) => !(t.track_timeline ?? []).some((c) => typeof c.material === "string" && sameSourceIds.has(c.material)),
	);
	const replacedTracks = audioTracks.length - keptTracks.length;
	if (replacedTracks > 0) log.info(`同源幂等：已替换 ${replacedTracks} 条既有同文件音轨（不叠加重复轨）`);

	// 零引用保护：被剥素材若仍被其他轨（video/beat/保留音轨）引用则不删登记
	const stillReferenced = new Set<string>();
	for (const group of [
		(freshGtrk.video_track as LooseTrack[] | undefined) ?? [],
		(freshGtrk.beat_track as LooseTrack[] | undefined) ?? [],
		keptTracks,
	]) {
		for (const t of group) {
			for (const c of t.track_timeline ?? []) {
				if (typeof c.material === "string") stillReferenced.add(c.material);
			}
		}
	}
	const keptMaterials = materials.filter(
		(m) => !(typeof m.id === "string" && sameSourceIds.has(m.id) && !stillReferenced.has(m.id)),
	);

	// ── 新轨落位：track_index 取现有（保留轨）最大 +1；MUST NOT 写 hidden ──
	const trackIndex =
		keptTracks.reduce((mx, t) => Math.max(mx, typeof t.track_index === "number" ? t.track_index : -1), -1) + 1;
	const clips: Array<Record<string, number | string>> = [];
	if (anchored) {
		// 锚定路径：段序已由 planAnchoredClips 保证按 track_st 升序、相邻零 gap、末段对齐工程末尾。
		// clip_id 唯一（契约 U1）沿用同一命名规则。
		anchored.pieces.forEach((p, i) => {
			clips.push({ clip_id: `${materialId}-${i}`, material: materialId, ...p, volume });
		});
	} else {
		let cursor = trackSt;
		let i = 0;
		const end = projEnd !== undefined ? projEnd : trackSt + len;
		do {
			const remain = r3(end - cursor);
			const pieceLen = r3(Math.min(audioDur, remain));
			if (pieceLen < MIN_LAY_SEC) break;
			clips.push({
				clip_id: `${materialId}-${i}`,
				material: materialId,
				clip_st: 0,
				clip_ed: pieceLen,
				track_st: r3(cursor),
				track_ed: r3(cursor + pieceLen),
				duration: pieceLen,
				volume,
			});
			cursor = r3(cursor + pieceLen);
			i += 1;
		} while (loop && cursor < end - MIN_LAY_SEC);
	}
	if (clips.length === 0) throw new Error(`起点 ${trackSt}s 之后已放不下音频（工程末尾 ${projEnd?.toFixed(2)}s）`);
	if (!anchored && clips.length > 1) {
		const lastClip = clips[clips.length - 1];
		log.info(
			`BGM 循环铺满：${clips.length} 段（全长 ${r3(audioDur)}s × ${clips.length - 1} + 尾段 ${lastClip.duration}s，对齐工程末尾）`,
		);
	}
	const clip = clips[0] as { clip_st: number; clip_ed: number; track_st: number; track_ed: number; duration: number };
	const newTrack: LooseTrack = { track_index: trackIndex, muted: false, track_timeline: clips };
	// audio_channel：客户端 materialMediaKind 的音频判据是「无 video_size ∧ 有 audio_channel」的合取，
	// 漏写会让音频素材在素材库里显示成视频（2026-08-22 真机实锤 BGM mp3 显示「视频 4:59」）。
	// 与后端 video_project_struct 写出的音频 material 形态对齐；探不到就不写键（不塞假值）。
	const audioChannel = probeChannel(audioAbs);
	const newMaterial: LooseMaterial = {
		id: materialId,
		path: audioAbs,
		duration: r3(audioDur),
		...(audioChannel ? { audio_channel: audioChannel } : {}),
	};

	const next: Record<string, unknown> = {
		...freshGtrk,
		materials: [...keptMaterials.filter((m) => m.id !== materialId), newMaterial],
		audio_track: [...keptTracks, newTrack].sort(
			(a, b) => ((a.track_index as number) ?? 0) - ((b.track_index as number) ?? 0),
		),
	};
	// 写方自检（gtrk-writer-invariants，add-cross-clock-adapter D6 把射程扩到 audio_track）：本次写出的 BGM clip 查裁剪恒等式 /
	// 素材上界（clip_ed ≤ materials[].duration + 1ms）/ 与同轨邻居零重叠，违约即抛、工程文件逐字节不写；
	// 存量违例（旧客户端重存 / 旧版本产物）只经 log.warn 打一条汇总，MUST NOT 阻断。判据在 gtrk-invariants，这里不复刻。
	assertGtrkWriteInvariants(next, "audio lay", {
		ownClipIds: new Set(clips.map((c) => String(c.clip_id))),
		warn: (m) => log.warn(m),
	});
	writeGtrkAtomic(gtrkPath, next, revision);

	const laidSt = anchored ? (clips[0]!.track_st as number) : trackSt;
	const laidEd = anchored ? (clips[clips.length - 1]!.track_ed as number) : r3(trackSt + len);
	log.ok(
		`音轨已写入：track_index ${trackIndex} · ${laidSt}s → ${laidEd}s · 音量 ${volume}` +
			(replacedTracks ? `（替换旧同源轨 ${replacedTracks} 条）` : ""),
	);
	log.info("客户端打开工程即见音轨；本地渲染（gtrk render）混音可闻。");
	// [adjust-bgm-selection-freshness] 落轨即记账（机制而非纪律）：下次 matrix material
	// --scope audio 自动避让近期用过的曲子，治「无论什么题材都来回那几首」。
	// 记账失败静默降级（bgm-history 内部吞异常），绝不影响铺轨本身。
	recordBgmUseFromFile(audioAbs, opts.project);


	const result: AudioLayResult = {
		ok: true,
		mode: "audio-lay",
		gtrkPath,
		trackIndex,
		replacedTracks,
		materialId,
		volume,
		offsetMs,
		clip: { clip_st: clip.clip_st, clip_ed: clip.clip_ed, track_st: clip.track_st, track_ed: clip.track_ed, duration: clip.duration },
		...(beatAlign ? { beatAlign } : {}),
		loopCount: clips.length,
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

// ---------------------------------------------------------------------------
// audio align（add-audio-align-command）：外录对轨 → 换轨（纯本地零计费）
// ---------------------------------------------------------------------------

export interface AudioAlignOpts {
	out?: string;
	offset?: string;
	threshold?: string;
	resume?: string;
	force?: boolean;
	ffmpegPath?: string;
	json?: boolean;
	/** 测试注入。 */
	_detect?: typeof detectOffset;
	_mux?: typeof muxExternalAudio;
}

export interface AudioAlignResult {
	ok: boolean;
	mode: "auto" | "manual-offset" | "align-project" | "resume";
	offsetSec?: number;
	confidence?: number;
	threshold?: number;
	output?: string;
	alignProject?: string;
}

/** align 主流程：三分支（显式 offset / resume / 自动置信度分流）。 */
export async function runAudioAlign(
	video: string | undefined,
	extAudio: string | undefined,
	opts: AudioAlignOpts,
): Promise<AudioAlignResult> {
	if (opts.json) routeLogsToStderr();
	const detect = opts._detect ?? detectOffset;
	const mux = opts._mux ?? muxExternalAudio;
	const threshold = opts.threshold != null ? Number(opts.threshold) : DEFAULT_ALIGN_THRESHOLD;
	if (!Number.isFinite(threshold) || threshold <= 0) throw new Error(`--threshold 需要正数，拿到「${opts.threshold}」`);

	// ---- 分支：resume（客户端拖齐后读回）
	if (opts.resume) {
		const gtrkPath = resolve(opts.resume);
		if (!existsSync(gtrkPath)) throw new Error(`对齐工程不存在：${gtrkPath}`);
		const info = readAlignOffset(gtrkPath);
		log.info(`对齐工程读回：offset = ${info.offsetSec.toFixed(3)}s（音轨 track_st − 视频轨 track_st）`);
		const out = opts.out ? resolve(opts.out) : alignOutputPath(info.videoAbs);
		assertOutWritable(out, opts.force);
		await mux(info.videoAbs, info.extAudioAbs, info.offsetSec, out, opts.ffmpegPath);
		logAlignDone(out);
		const result: AudioAlignResult = { ok: true, mode: "resume", offsetSec: info.offsetSec, output: out };
		if (opts.json) console.log(JSON.stringify(result));
		return result;
	}

	// ---- 输入校验（两个 positional）
	if (!video || !extAudio) throw new Error("用法：gtrk audio align <视频毛片> <外录音频>（或 --resume <对齐工程>）");
	const videoAbs = resolve(video);
	const extAbs = resolve(extAudio);
	if (!existsSync(videoAbs)) throw new Error(`视频不存在：${videoAbs}`);
	if (!existsSync(extAbs)) throw new Error(`外录音频不存在：${extAbs}`);
	const videoExts = new Set(defaultExtsFor("video"));
	const audioExts = new Set(defaultExtsFor("audio"));
	const vExt = extname(videoAbs).toLowerCase();
	const aExt = extname(extAbs).toLowerCase();
	if (audioExts.has(vExt) && !videoExts.has(vExt)) {
		throw new Error(`第一个参数要视频毛片，拿到音频「${basename(videoAbs)}」——参数顺序是 <视频> <外录音频>`);
	}
	if (videoExts.has(aExt) && !audioExts.has(aExt)) {
		throw new Error(`第二个参数要外录音频，拿到视频「${basename(extAbs)}」——参数顺序是 <视频> <外录音频>`);
	}
	const out = opts.out ? resolve(opts.out) : alignOutputPath(videoAbs);

	// ---- 分支：显式偏移
	if (opts.offset != null) {
		const off = Number(opts.offset);
		if (!Number.isFinite(off)) throw new Error(`--offset 需要秒数，拿到「${opts.offset}」`);
		assertOutWritable(out, opts.force);
		await mux(videoAbs, extAbs, off, out, opts.ffmpegPath);
		logAlignDone(out);
		const result: AudioAlignResult = { ok: true, mode: "manual-offset", offsetSec: off, output: out };
		if (opts.json) console.log(JSON.stringify(result));
		return result;
	}

	// ---- 分支：自动（置信度分流）
	const vDur = probeDuration(videoAbs, opts.ffmpegPath);
	const eDur = probeDuration(extAbs, opts.ffmpegPath);
	if (eDur < vDur - 1) {
		log.warn(`外录（${eDur.toFixed(1)}s）比视频（${vDur.toFixed(1)}s）短——成片尾部将无外录声，请确认给对了文件`);
	}
	log.step("对轨检测（互相关测偏移 + 置信度）…");
	await mkdir(audioCacheDir(), { recursive: true });
	const det = await detect(videoAbs, extAbs, audioCacheDir(), opts.ffmpegPath);
	log.info(`偏移 = ${det.offsetSec.toFixed(3)}s（正=外录晚开录）  置信度 = ${det.confidence}（阈值 ${threshold}）`);

	if (det.confidence >= threshold) {
		assertOutWritable(out, opts.force);
		await mux(videoAbs, extAbs, det.offsetSec, out, opts.ffmpegPath);
		logAlignDone(out);
		const result: AudioAlignResult = {
			ok: true, mode: "auto", offsetSec: det.offsetSec, confidence: det.confidence, threshold, output: out,
		};
		if (opts.json) console.log(JSON.stringify(result));
		return result;
	}

	// 低置信兜底：产对齐工程交客户端
	// -o 只在其扩展名是 .gtrk 时才用作工程路径——换轨产物路径（.mp4/.mov）不能拿来装 JSON，会误导客户端
	const geo = probeGeometry(videoAbs, opts.ffmpegPath);
	const projPath = opts.out && opts.out.toLowerCase().endsWith(".gtrk") ? resolve(opts.out) : alignProjectPath(videoAbs);
	const proj = buildAlignProject(videoAbs, extAbs, det.offsetSec, geo, eDur);
	writeAlignProject(projPath, proj);
	log.warn(`置信度 ${det.confidence} < 阈值 ${threshold}，不自动换轨。`);
	log.info(`已产对齐工程：${projPath}`);
	log.info("请在客户端打开该工程，把音轨拖到与画面对齐后保存，然后跑：");
	log.info(`  gtrk audio align --resume "${projPath}"`);
	const result: AudioAlignResult = {
		ok: true, mode: "align-project", offsetSec: det.offsetSec, confidence: det.confidence, threshold, alignProject: projPath,
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

function assertOutWritable(out: string, force?: boolean): void {
	if (existsSync(out) && !force) {
		throw new Error(`产物已存在：${out}（加 --force 覆盖）`);
	}
}

function logAlignDone(out: string): void {
	log.ok(`换轨完成（视频流零像素改动）：${out}`);
	log.info("⚠️ 该文件是后续工程的素材，请留存——删了工程会素材脱机。原毛片未动（内录保底轨）。");
}

// ── audio tighten（add-audio-tighten-pauses）────────────────────────────────

export interface AudioTightenOpts {
	project?: string;
	keep?: string;
	minSilence?: string;
	boundaryTol?: string;
	dryRun?: boolean;
	ffmpegPath?: string;
	json?: boolean;
}

export interface AudioTightenResult {
	oldDur: number;
	newDur: number;
	removedSec: number;
	cuts: number;
	skippedInterior: number;
	skippedProtected: number;
	voiceClips: number;
	captions: number;
	dryRun: boolean;
}

const numOpt = (v: string | undefined, name: string, dflt: number): number => {
	if (v === undefined) return dflt;
	const n = Number(v);
	if (!Number.isFinite(n) || n < 0) throw new Error(`${name} 需要非负有限数值，拿到「${v}」`);
	return n;
};

/** 16kHz：语音标准率。⚠️ MUST NOT 降到 4k —— 抗混叠滤波会改变低电平包络，
 *  少数静音段会跨过 2% 阈值，同一条音频在不同采样率下压出不同刀数（实测 4k 比 24k 多 1 刀）。 */
const TIGHTEN_PCM_RATE = 16000;

export async function runAudioTighten(opts: AudioTightenOpts): Promise<AudioTightenResult> {
	if (opts.json) routeLogsToStderr();
	if (!opts.project) throw new Error("gtrk audio tighten 需要 --project <工程产物目录>");
	const pdir = resolve(opts.project);
	const gtrkPath = join(pdir, "gtrk", "project.gtrk");
	const planPath = join(pdir, "split", "broll-plan.json");
	const trPath = join(pdir, "transcript", "transcript.json");
	for (const [p, what] of [[gtrkPath, "工程"], [trPath, "文字稿"]] as const) {
		if (!existsSync(p)) throw new Error(`找不到${what}：${p}`);
	}
	const keep = numOpt(opts.keep, "--keep", TIGHTEN_KEEP_DEFAULT);
	const minSilence = numOpt(opts.minSilence, "--min-silence", TIGHTEN_MIN_SILENCE_DEFAULT);
	const boundaryTol = numOpt(opts.boundaryTol, "--boundary-tol", TIGHTEN_BOUNDARY_TOL_DEFAULT);

	// 工程读取①（计算用）：配音素材定位与刀点判据按这份算。
	// ⚠️ revision **不作写回 expected**——下方 ffmpeg 转码是秒~分钟级动作，持有跨越它的 revision
	// 会让「客户端自动保存了一次」直接作废整轮。见下方工程读取②。
	const { gtrk, revision: planningRevision } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);
	const transcript = JSON.parse(readFileSync(trPath, "utf8")) as {
		material_id?: string | number;
		duration?: number;
		utterances: { id: string; st: number; ed: number }[];
	};
	const us = transcript.utterances ?? [];
	if (!us.length) throw new Error("文字稿没有 utterances，无从判断句界");

	// 配音素材 = transcript.material_id 指向的那条（**不是**「第一条音频素材」——BGM 也是音频）
	const materials = (gtrk.materials as Record<string, unknown>[]) ?? [];
	const voiceMat = materials.find((m) => String(m.id) === String(transcript.material_id));
	if (!voiceMat) throw new Error(`工程里找不到文字稿指向的配音素材（material_id=${transcript.material_id}）`);
	const voicePath = String(voiceMat.path);
	if (!existsSync(voicePath)) throw new Error(`配音素材文件不存在：${voicePath}`);

	// ── 静音检测：相对 RMS（MUST NOT 用 silencedetect，见 audio-tighten.ts 头注 ②）──
	const { ffmpeg } = requireFfmpeg(opts.ffmpegPath);
	const work = audioCacheDir();
	await mkdir(work, { recursive: true });
	const pcmPath = join(work, `tighten-${createHash("sha256").update(voicePath).digest("hex").slice(0, 12)}.pcm`);
	await runFfmpeg(ffmpeg, [
		"-y", "-v", "error", "-i", voicePath,
		"-vn", "-ac", "1", "-ar", String(TIGHTEN_PCM_RATE), "-f", "s16le", "-c:a", "pcm_s16le",
		pcmPath,
	]);
	const buf = readFileSync(pcmPath);
	const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
	const oldDur = r3(pcm.length / TIGHTEN_PCM_RATE);
	const win = Math.round(TIGHTEN_PCM_RATE * SILENCE_WIN_SEC);
	const rms: number[] = [];
	for (let i = 0; i + win <= pcm.length; i += win) {
		let s = 0;
		for (let k = i; k < i + win; k++) s += (pcm[k] as number) ** 2;
		rms.push(Math.sqrt(s / win));
	}
	const runs = detectSilenceRuns(rms, SILENCE_WIN_SEC, SILENCE_REL_THRESHOLD);

	// 句界 = 每句 ed（末句除外）+ 片头 0（引导静音也该收）
	const boundaries = [0, ...us.slice(0, -1).map((u) => u.ed)];
	// 豁免 = 引用段（direct_slots）在轨上的区间
	const plan = existsSync(planPath) ? (JSON.parse(readFileSync(planPath, "utf8")) as PlanShape) : undefined;
	const protect: { st: number; ed: number }[] = (plan?.beats ?? []).flatMap((b) =>
		(b.direct_slots ?? []).map((d) => ({ st: d.track_st, ed: d.track_ed })),
	);

	const planned = planTightenCuts(runs, boundaries, protect, { keep, minSilence, boundaryTol });
	const newDur = r3(oldDur - planned.removedSec);
	const m = makeTightenMapper(planned.cuts);
	// 引用段边界再切一刀：让它单独成 clip，用户能单独选中调出入点（仍在配音轨上、仍是同一素材）
	const keeps = splitIntervalsAt(
		keepIntervals(oldDur, planned.cuts),
		protect.flatMap((p) => [p.st, p.ed]),
	);

	const result: AudioTightenResult = {
		oldDur, newDur, removedSec: planned.removedSec, cuts: planned.cuts.length,
		skippedInterior: planned.skippedInterior, skippedProtected: planned.skippedProtected,
		voiceClips: keeps.length, captions: 0, dryRun: opts.dryRun === true,
	};

	log.info(
		`句间停顿收紧：${oldDur}s → ${newDur}s（削 ${planned.removedSec}s / ${planned.cuts.length} 刀）· ` +
			`配音轨 ${keeps.length} 段 · 跳过句内换气 ${planned.skippedInterior} 处 · 豁免引用段 ${planned.skippedProtected} 处`,
	);
	if (planned.skippedInterior > 0) {
		log.info(
			`跳过的是**句内换气**（说话人的呼吸节奏，压了句子会发赶）——只有跨句界的停顿被收紧。`,
		);
	}
	if (opts.dryRun) {
		log.info("--dry-run：未写盘。");
		return result;
	}
	if (!planned.cuts.length) {
		log.info("没有可收紧的句间停顿，工程未改动。");
		return result;
	}

	// ── 工程读取②（写回用）：耗时动作全部完成后才取 revision ─────────────────────────────
	// ffmpeg 转码是秒~分钟级；持有跨越它的 revision，用户在此期间在客户端存一次工程（自动保存
	// 每 60s 一次），本轮就整体白跑。此刻重读后冲突窗口 = 重读到 rename 的毫秒级，且
	// writeGtrkAtomic 的 rename 前重检照旧兜底（那条 MUST NOT 删）。
	//
	// ★ MUST 整体迁移基底：`applyTightenToProject` 是**原地改写**，把它作用到读①那份 `gtrk` 上
	// 再写出，就会覆盖掉用户那次保存且不触发任何校验（revision 是对的）——
	// gtrk-writeback-contract「只换 revision 不换基底 = 静默覆盖」。故改写与写回**一律用 freshGtrk**。
	// 该变换全程按素材 id 定位（voiceMatId / material 引用），作用到新基底上语义正确。
	const { gtrk: freshGtrk, revision } = readGtrk(gtrkPath);
	assertGtrkV1(freshGtrk);
	if (revision !== planningRevision) {
		log.warn(
			"工程在本轮收紧期间被改动过（ffmpeg 转码进行中，你在客户端保存了工程）：已按**改后**的工程" +
				"改写写回，你那次保存不会被覆盖；但刀点与新时长是按改动前的配音轨算的——" +
				"若你改的正是配音轨或时间线，收紧结果可能与新工程对不上，重跑一次本命令即可（纯本地、不计费）。",
		);
	}
	// 已铺过画面就提醒：beat 窗口会变，跑完必须重铺。按**当刻**工程判（读②）才准。
	const laid = ((freshGtrk.video_track as { track_timeline?: unknown[] }[]) ?? []).some(
		(t) => (t.track_timeline ?? []).length > 0,
	);
	applyTightenToProject(freshGtrk, plan, m, newDur, keeps, String(voiceMat.id), oldDur);
	result.captions = countCaptions(freshGtrk);
	writeGtrkAtomic(gtrkPath, freshGtrk, revision, "audio tighten");
	if (plan) writeFileSync(planPath, `${JSON.stringify(plan, null, 1)}\n`, "utf8");

	log.info(`已写回：${gtrkPath}${plan ? ` · ${planPath}` : ""}`);
	if (laid) {
		log.warn(
			"工程里已有铺好的画面轨，而 beat 窗口刚刚变了——**必须重铺**（`gtrk matrix lay --project <目录>`），" +
				"否则画面与配音整体错位。",
		);
	}
	return result;
}

interface PlanShape {
	beats: {
		track_st: number;
		track_ed: number;
		anchors?: { at_sec?: number }[];
		direct_slots?: { clip_st: number; clip_ed: number; track_st: number; track_ed: number }[];
	}[];
}

const countCaptions = (gtrk: Record<string, unknown>): number => {
	const cve = ((gtrk.struct_meta as Record<string, unknown>)?.client_visual_elements ?? {}) as {
		lanes?: { elements?: unknown[] }[];
	};
	return (cve.lanes ?? []).reduce((n, l) => n + (l.elements ?? []).length, 0);
};

/**
 * 把新轴落进工程。
 *
 * ⚠️ **逐字段点名，MUST NOT 递归全量替换时码**：plan 里还有**素材源片**的时码
 * （`results[].segments[].start/end`、`direct_slots[].clip_st/clip_ed`），
 * 映射它们会把工程彻底毁掉**且不报错**——画面取错段落、无任何告警。
 *
 * ⚠️ `transcript` 不在本函数的射程内，也**不该**在：见 `audio-tighten.ts` 头注 ⑤。
 */
function applyTightenToProject(
	gtrk: Record<string, unknown>,
	plan: PlanShape | undefined,
	m: (t: number) => number,
	newDur: number,
	keeps: { st: number; ed: number }[],
	voiceMatId: string,
	oldDur: number,
): void {
	gtrk.duration = newDur;
	// 配音素材时长保持**原件**时长——clip 引用的是源文件，不是压缩产物（判据 ④）
	for (const mt of (gtrk.materials as Record<string, unknown>[]) ?? []) {
		if (String(mt.id) === voiceMatId) mt.duration = oldDur;
	}
	// 配音轨：逐保留区间成 clip
	const tracks = (gtrk.audio_track as { track_index: number; track_timeline: Record<string, unknown>[] }[]) ?? [];
	const voiceTrack = tracks.find((t) => t.track_timeline.some((c) => String(c.material) === voiceMatId));
	if (voiceTrack) {
		const proto = voiceTrack.track_timeline.find((c) => String(c.material) === voiceMatId) ?? {};
		voiceTrack.track_timeline = keeps.map((k) => {
			const { clip_st: _a, clip_ed: _b, track_st: _c, track_ed: _d, duration: _e, ...rest } = proto;
			return { ...rest, material: voiceMatId, clip_st: k.st, clip_ed: k.ed, track_st: m(k.st), track_ed: m(k.ed), duration: r3(m(k.ed) - m(k.st)) };
		});
	}
	// BGM 等其它音轨：按素材时长循环铺满新时长
	// ⚠️ 素材短于成片时本来就是**多段循环**，压成单段会同轨自我重叠（真机踩过）
	const matById = new Map(((gtrk.materials as Record<string, unknown>[]) ?? []).map((x) => [String(x.id), x]));
	for (const t of tracks) {
		if (t === voiceTrack || !t.track_timeline.length) continue;
		const proto = t.track_timeline[0] as Record<string, unknown>;
		const md = Number(matById.get(String(proto.material))?.duration ?? newDur) || newDur;
		const out: Record<string, unknown>[] = [];
		for (let cur = 0; cur < newDur - 1e-6; cur += md) {
			const seg = r3(Math.min(md, newDur - cur));
			out.push({ ...proto, clip_st: 0, clip_ed: seg, track_st: r3(cur), track_ed: r3(cur + seg), duration: seg });
		}
		t.track_timeline = out;
	}
	// MG 轨
	for (const t of (gtrk.beat_track as { track_timeline: Record<string, unknown>[] }[]) ?? []) {
		for (const c of t.track_timeline) {
			const st = m(Number(c.track_st));
			const ed = m(Number(c.track_st) + Number(c.duration));
			c.track_st = st;
			c.duration = r3(Math.min(ed, newDur) - st);
		}
	}
	const sm = (gtrk.struct_meta as Record<string, unknown>) ?? {};
	for (const b of ((sm.split as { beats?: Record<string, unknown>[] })?.beats ?? [])) {
		b.track_st = m(Number(b.track_st));
		b.track_ed = m(Number(b.track_ed));
		for (const r of (b.source_ranges as Record<string, unknown>[]) ?? []) {
			r.st = m(Number(r.st));
			r.ed = m(Number(r.ed));
		}
	}
	for (const b of ((sm.mg as { beats?: Record<string, unknown>[] })?.beats ?? [])) {
		const st = m(Number(b.track_st));
		const ed = m(Number(b.track_ed));
		b.track_st = st;
		b.track_ed = ed;
		b.duration = r3(ed - st);
	}
	// 字幕：tick 单位（120000/秒），MUST 换算后再映射
	for (const lane of ((sm.client_visual_elements as { lanes?: { elements?: Record<string, unknown>[] }[] })?.lanes ?? [])) {
		for (const e of lane.elements ?? []) {
			const s = m(Number(e.startTime) / CVE_TICKS_PER_SEC);
			const t2 = m((Number(e.startTime) + Number(e.duration)) / CVE_TICKS_PER_SEC);
			e.startTime = Math.round(s * CVE_TICKS_PER_SEC);
			e.duration = Math.max(1, Math.round((t2 - s) * CVE_TICKS_PER_SEC));
		}
	}
	// plan：逐字段点名
	for (const b of plan?.beats ?? []) {
		b.track_st = m(b.track_st);
		b.track_ed = m(b.track_ed);
		for (const a of b.anchors ?? []) if (typeof a.at_sec === "number") a.at_sec = m(a.at_sec);
		for (const d of b.direct_slots ?? []) {
			// 引用段轨长 MUST 恒等于源长（它被豁免、内部没有刀）
			const src = d.clip_ed - d.clip_st;
			d.track_st = m(d.track_st);
			d.track_ed = r3(d.track_st + src);
		}
	}
}

export function registerAudio(program: Command): void {
	program
		.command("audio [words...]")
		.description(
			"音频零件族：gtrk audio lay 往 .gtrk 追加 audio_track（BGM 上轨）；gtrk audio align 外录音轨对轨换声；gtrk audio tighten 收紧配音的句间停顿（均纯本地零计费）",
		)
		.option("--project <dir>", "[lay] 工程产物目录（定位 gtrk/project.gtrk）")
		.option("--file <audio>", "[lay] 要上轨的音频文件（BGM/配乐等）")
		.option("--volume <v>", `[lay] 音量 0..1（默认 ${AUDIO_LAY_VOLUME_DEFAULT}，BGM 垫底音量）`)
		.option("--offset <v>", "[lay] 入点偏移毫秒；[align] 显式偏移秒（跳过检测直接换轨，正=外录晚开录）")
		.option(
			"--beat-align",
			"[lay] 高潮点对齐（云端 audio_music_analyze，计费一次）：把 BGM 的情绪峰值压到成片的高潮点上，锚点前后按小节线平铺补齐、两侧都够长时零平铺。成片高潮点取自 struct_meta.split.beats 的判据链（升华段→容器转折→回扣段→0.75×全片兜底，兜底档会明示是猜的），可用 --climax 覆盖。无 Key/分析失败/曲子缺高潮点一律降级为不锚定，不失败整命令",
		)
		.option(
			"--climax <sec>",
			"[lay] 成片高潮点逃生门（轨秒）：一律覆盖 --beat-align 的判据链；越界（≤ --offset 或 ≥ 工程末尾）或非数直接报错，不静默回落。需与 --beat-align 同用",
		)
		.option(
			"--no-loop",
			"[lay] 不平铺补齐：开了 --beat-align 时只放锚点那一段、头尾留白（留白秒数如实报出）；未开时保留单次（不循环叠满至工程末尾）",
		)
		.option("--resume <gtrk>", "[align] 客户端拖齐保存后的对齐工程，读回偏移完成换轨")
		.option("--threshold <r>", "[align] 置信度阈值（主峰/次峰显著性比；缺省真机标定值）")
		.option("-o, --out <path>", "[align] 产物路径（缺省 <视频名>_extaudio.<ext>；低置信时为对齐工程路径）")
		.option("--force", "[align] 产物已存在时覆盖")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录（缺省 ~/.gitruck/ffmpeg → 系统 PATH）")
		.option("--keep <sec>", `[tighten] 收紧后保留的静音秒数（缺省 ${TIGHTEN_KEEP_DEFAULT}；实测认可值，换题材/音色可调）`)
		.option("--min-silence <sec>", `[tighten] 短于此的静音不动（缺省 ${TIGHTEN_MIN_SILENCE_DEFAULT}，那是字词间的自然停顿）`)
		.option("--boundary-tol <sec>", `[tighten] 判「贴着句界」的容差（缺省 ${TIGHTEN_BOUNDARY_TOL_DEFAULT}）`)
		.option("--dry-run", "[tighten] 只报会压几处、共几秒、跳过几处句内换气，不写盘")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[] | undefined, opts: AudioLayOpts & AudioAlignOpts & AudioTightenOpts) => {
			const parsed = parseAudioPositional(words);
			if (parsed.sub === "lay") {
				await runAudioLay(opts as AudioLayOpts);
				return;
			}
			if (parsed.sub === "tighten") {
				const r = await runAudioTighten(opts as AudioTightenOpts);
				if (opts.json) process.stdout.write(`${JSON.stringify(r)}
`);
				return;
			}
			await runAudioAlign(parsed.video, parsed.extAudio, opts as AudioAlignOpts);
		});
}
