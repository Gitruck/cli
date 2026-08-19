/**
 * 成片质量扫描（add-qc-scan · qc-command spec）。
 *
 * 链路：视频一趟解码（`select='gte(scene,0)',metadata=print` + `blackdetect` + `freezedetect`
 * 滤镜并联，逐帧解码一次共用）+ 音频一趟（`silencedetect` + `astats` + `ebur128`）
 * → 解析各滤镜 stderr → 判定项聚合 → 报告（人读交命令层格式化，机读 qc-report v1）。
 * MUST NOT 逐检测项重复解码。
 *
 * 工程感知（`--gtrk`）：视觉跳变与工程主视频轨 clip 拼接边界有序对表，落边界者=正常剪切不报，
 * 不落者=段内跳切（warn）。对表按**有序单调匹配**而非就近匹配——本地渲染的成片切点相对 EDL
 * 存在随时间累积的漂移（旅拍打样实测 0.028s→0.256s，`trim`+`fps` 在 VFR 源上逐段取整出帧、
 * concat 累加所致；该漂移本身由 `av_drift` 项独立报告），就近匹配会把漂移后的正常剪切误判成段内跳切。
 */
import { spawn } from "node:child_process";
import { requireFfmpeg, ffprobeJson } from "./ffmpeg";
import { parseSceneScores } from "./local-index";

// ── 阈值基线（v1 标定值；标定批次调参只改这一处）─────────────────────────
export const QC_THRESHOLDS = {
	/** 视觉跳变判定阈值（成片恒 CFR，无帧率归一问题；与索引场景检测同源取值）。 */
	sceneScore: 0.3,
	/** 过短镜头判定：相邻两跳变间隔 ≤ 此值即判过短（tune-shot-rhythm-thresholds，主理人 2026-08-19
	 * 走查裁定 1.0s）。判据是**节奏断裂**而非「闪」——长镜头之间突然插入半拍短镜头最难受。
	 * 与铺轨的 SLIVER_MIN_SEC 同为 1.0s：防与查同一条感知线。
	 * 严重级 MUST 按端点来源分级（见 scanFinalCut）——一刀切会把素材自身的快剪蒙太奇误报成缺陷。 */
	flashMaxSec: 1.0,
	/** 段内跳切对表容差（秒）：跳变与漂移修正后的 clip 边界之差在此内算正常剪切。 */
	cutMatchTolSec: 0.12,
	/** blackdetect：最短黑段/像素黑判据/单像素黑阈值。 */
	blackMinDurSec: 0.1,
	blackPicTh: 0.98,
	blackPixTh: 0.1,
	/** freezedetect：噪声容限与最短冻结时长。 */
	freezeNoise: 0.003,
	freezeMinDurSec: 2,
	/** silencedetect：静音判据（dB）与最短静音时长。 */
	silenceNoiseDb: -50,
	silenceMinDurSec: 2,
	/** true peak 上限（dBTP，ebur128）——超过即判削波风险。 */
	truePeakDbtp: -1,
	/** 视频/音频流时长差上限（秒）——超过即判音画不同步（渲染帧数漂移的机读证据）。 */
	avDurationDiffSec: 0.1,
} as const;

export type QcSeverity = "error" | "warn" | "info";
export type QcType =
	| "flash"
	| "intra_cut"
	| "black"
	| "freeze"
	| "clip"
	| "silence"
	| "av_drift"
	| "vfr";

export interface QcItem {
	type: QcType;
	severity: QcSeverity;
	/** 缺陷区间（秒，成片时基）。点状缺陷 st===ed。 */
	st: number;
	ed: number;
	/** 各检测项自由证据键值（外层契约锁定，证据留演进余地）。 */
	evidence: Record<string, unknown>;
}

export interface QcReport {
	qc_version: "v1";
	input: string;
	generated_at: string;
	summary: { error: number; warn: number; info: number };
	items: QcItem[];
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** 跑 ffmpeg 抓全量 stderr（分析滤镜输出体量 O(帧数)，runFfmpeg 只留尾 4000 字会截断）。 */
function captureStderr(bin: string, args: string[]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const p = spawn(bin, args, { env: process.env });
		let err = "";
		p.stderr.on("data", (b: Buffer) => {
			err += b.toString("utf8");
		});
		p.on("error", (e) => reject(e));
		p.on("close", () => resolvePromise(err));
	});
}

// ── 解析器（各滤镜 stderr → 结构化事实）──────────────────────────────────

/** blackdetect：`black_start:12.5 black_end:13.1 black_duration:0.6`。 */
export function parseBlackDetect(stderr: string): { st: number; ed: number }[] {
	const out: { st: number; ed: number }[] = [];
	for (const m of stderr.matchAll(/black_start:([0-9.]+)\s+black_end:([0-9.]+)/g)) {
		out.push({ st: Number(m[1]), ed: Number(m[2]) });
	}
	return out;
}

/** freezedetect：`lavfi.freezedetect.freeze_start: 4.2` / `...freeze_duration` / `...freeze_end`。 */
export function parseFreezeDetect(stderr: string): { st: number; ed: number }[] {
	const out: { st: number; ed: number }[] = [];
	let st: number | undefined;
	for (const line of stderr.split(/\r?\n/)) {
		const s = line.match(/freeze_start:\s*([0-9.]+)/);
		if (s) {
			st = Number(s[1]);
			continue;
		}
		const e = line.match(/freeze_end:\s*([0-9.]+)/);
		if (e && st !== undefined) {
			out.push({ st, ed: Number(e[1]) });
			st = undefined;
		}
	}
	return out;
}

/** silencedetect：`silence_start: 10.2` … `silence_end: 13.4 | silence_duration: 3.2`。 */
export function parseSilenceDetect(stderr: string): { st: number; ed: number }[] {
	const out: { st: number; ed: number }[] = [];
	let st: number | undefined;
	for (const line of stderr.split(/\r?\n/)) {
		const s = line.match(/silence_start:\s*(-?[0-9.]+)/);
		if (s) {
			st = Math.max(0, Number(s[1]));
			continue;
		}
		const e = line.match(/silence_end:\s*([0-9.]+)/);
		if (e && st !== undefined) {
			out.push({ st, ed: Number(e[1]) });
			st = undefined;
		}
	}
	return out;
}

/** astats/ebur128：全片削波样本数与 true peak（dBTP）。 */
export function parseAudioStats(stderr: string): { clipCount: number; truePeakDbtp: number | null } {
	let clipCount = 0;
	for (const m of stderr.matchAll(/Number of clipped samples:\s*(\d+)/g)) clipCount += Number(m[1]);
	let truePeak: number | null = null;
	// ebur128 summary 段：`Peak:` 之后的 `True peak: -0.3 dBFS`；逐个取最大
	for (const m of stderr.matchAll(/True peak:\s*(-?[0-9.]+|-inf)/g)) {
		const v = m[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]);
		if (truePeak === null || v > truePeak) truePeak = v;
	}
	return { clipCount, truePeakDbtp: truePeak };
}

// ── 判定（纯函数，供单测直调）────────────────────────────────────────────

/** 过短镜头：相邻跳变间隔 ≤ flashMaxSec 者（区间 = 两跳变之间）。纯阈值，**不判严重级**——
 * 定级要看端点来源（拼接切 vs 段内跳切），那是 scanFinalCut 在工程对表之后做的事。 */
export function detectFlashes(
	cuts: number[],
	maxSec: number = QC_THRESHOLDS.flashMaxSec,
): { st: number; ed: number; sec: number }[] {
	const out: { st: number; ed: number; sec: number }[] = [];
	for (let i = 1; i < cuts.length; i++) {
		const sec = cuts[i]! - cuts[i - 1]!;
		if (sec > 0 && sec <= maxSec) out.push({ st: r3(cuts[i - 1]!), ed: r3(cuts[i]!), sec: r3(sec) });
	}
	return out;
}

/**
 * 过短镜头 → 报告条目，**按两端来源定级**（tune-shot-rhythm-thresholds · spec「闪现判定按端点来源分级」）：
 *
 *   · 至少一端是 clip 拼接切 → `error`：我方剪辑造成的节奏断裂。铺轨的槽长地板（MIN_SHOT_SEC=1.2s）
 *     保证我方从不排出更短的槽，故这类短镜头必然是「颗粒窗口跨过源切点、且切点贴近拼接处」的产物，
 *     属可修缺陷（铺轨的 SLIVER_MIN_SEC 负责预防）。
 *   · 两端皆段内跳切 → `info`：整段落在同一颗粒内部，是**源素材自身的快剪语言**（打样实锤：源
 *     550.567–553.017s 的真蒙太奇，7 刀 0.267–0.467s，成片曾整段采用）。一刀切会把它误报成 6 条
 *     error，与「除非素材颗粒内部本来就高频」的例外条款直接冲突。
 *   · `spliceCuts === null`（未开工程感知）→ 来源不可判，退回不分级的 `warn` 并标注口径受限。
 *
 * 纯函数，供单测直调 spec 的三条 Scenario。
 */
export function shortShotItems(cuts: number[], spliceCuts: Set<number> | null): QcItem[] {
	const isSplice = (t: number): boolean => spliceCuts !== null && spliceCuts.has(r3(t));
	return detectFlashes(cuts).map((f) => {
		if (spliceCuts === null) {
			return {
				type: "flash" as const,
				severity: "warn" as const,
				st: f.st,
				ed: f.ed,
				evidence: { shot_sec: f.sec, note: "镜头过短；未开工程感知（--gtrk），来源不可判、未分级" },
			};
		}
		const ours = isSplice(f.st) || isSplice(f.ed);
		return {
			type: "flash" as const,
			severity: (ours ? "error" : "info") as QcSeverity,
			st: f.st,
			ed: f.ed,
			evidence: {
				shot_sec: f.sec,
				endpoints: `${isSplice(f.st) ? "拼接切" : "段内跳切"}→${isSplice(f.ed) ? "拼接切" : "段内跳切"}`,
				note: ours
					? "镜头过短且至少一端是 clip 拼接处：颗粒窗口跨过源切点造成的节奏断裂，可重铺修复"
					: "镜头过短但两端都在同一颗粒内部：源素材自身的快剪节奏，非缺陷",
			},
		};
	});
}

/**
 * 跳变 ↔ clip 边界有序对表（单调匹配，见文件头「工程感知」注记）：每个边界认领其后**首个**
 * 落在 [−tol, maxDriftSec] 内的跳变；认领不到即记 missing（该剪切点在成片里没形成可见跳变，
 * 多为相邻两颗粒画面本就相近，不报缺陷只作诊断）。未被认领的跳变 = 段内跳切。
 */
export function matchCutsToBoundaries(
	cuts: number[],
	boundaries: number[],
	opts: { tolSec?: number; maxDriftSec?: number } = {},
): { matched: { boundary: number; cut: number; drift: number }[]; intra: number[]; missing: number[] } {
	const tol = opts.tolSec ?? QC_THRESHOLDS.cutMatchTolSec;
	const maxDrift = opts.maxDriftSec ?? 1.0;
	const matched: { boundary: number; cut: number; drift: number }[] = [];
	const missing: number[] = [];
	const claimed = new Set<number>();
	let j = 0;
	for (const b of boundaries) {
		while (j < cuts.length && cuts[j]! < b - tol) j++;
		if (j < cuts.length && cuts[j]! - b <= maxDrift) {
			matched.push({ boundary: r3(b), cut: r3(cuts[j]!), drift: r3(cuts[j]! - b) });
			claimed.add(j);
			j++;
		} else {
			missing.push(r3(b));
		}
	}
	const intra = cuts.filter((_, i) => !claimed.has(i)).map(r3);
	return { matched, intra, missing };
}

/** 工程槽位登记（add-material-motion-signal · qc-command「缺陷带工程坐标」）：从
 * `struct_meta.broll.beats[].laid[].slots[]` 反查，把成片时码映射回 (beat, 槽位, clip, 源窗)。 */
export interface SlotRef {
	beat: string;
	slotIndex: number;
	clipId: string;
	trackSt: number;
	trackEd: number;
	clipSt: number;
	clipEd: number;
}

/** 同 beat 的候选段（备选建议用）。 */
export interface CandidateRef {
	clipId: string;
	start: number;
	end: number;
	score: number;
	/** 去重后帧间分 p50（越低越稳）；索引无信号时 undefined。 */
	motionP50?: number;
	/** 段内已知切点数（越少越好）。 */
	cutCount?: number;
}

/** 从工程 struct_meta.broll 抽出全部落成槽位（按 track_st 升序）。 */
export function slotsFromGtrk(gtrk: unknown): SlotRef[] {
	const beats = (gtrk as { struct_meta?: { broll?: { beats?: unknown[] } } })?.struct_meta?.broll?.beats;
	if (!Array.isArray(beats)) return [];
	const out: SlotRef[] = [];
	for (const b of beats as { beat?: string; laid?: { slots?: Record<string, number | string>[] }[] }[]) {
		for (const l of b.laid ?? []) {
			(l.slots ?? []).forEach((s, i) => {
				const num = (v: unknown): number => (typeof v === "number" ? v : Number.NaN);
				const trackSt = num(s.track_st);
				if (!Number.isFinite(trackSt)) return;
				out.push({
					beat: String(b.beat ?? ""),
					slotIndex: i,
					clipId: String(s.clip_id ?? ""),
					trackSt,
					trackEd: num(s.track_ed),
					clipSt: num(s.clip_st),
					clipEd: num(s.clip_ed),
				});
			});
		}
	}
	return out.sort((a, b) => a.trackSt - b.trackSt);
}

/** 成片时码 → 所属槽位（扣渲染漂移：容差按帧级给，命中不唯一时返回 null）。 */
export function slotAt(slots: SlotRef[], t: number, tolSec = 0.1): SlotRef | null {
	const hit = slots.filter((s) => t >= s.trackSt - tolSec && t < s.trackEd + tolSec);
	return hit.length === 1 ? hit[0]! : null;
}

/** 成片时码 → 源素材时码（经所属槽位换算；槽位不唯一时 null）。 */
export function toSourceTime(slots: SlotRef[], t: number, tolSec = 0.1): { slot: SlotRef; src: number } | null {
	const slot = slotAt(slots, t, tolSec);
	if (!slot) return null;
	return { slot, src: r3(slot.clipSt + (t - slot.trackSt)) };
}

/** 同 beat 未被采用的候选段，按「稳」排序：运动量升序 → 段内切点数升序 → score 降序。
 * 索引无运动信号时退回单维（切点数）排序，调用方据 `ranked_by` 标注口径受限。 */
export function rankAlternatives(candidates: CandidateRef[], usedClipIds: Set<string>): CandidateRef[] {
	return candidates
		.filter((c) => !usedClipIds.has(c.clipId))
		.sort(
			(a, b) =>
				(a.motionP50 ?? Number.POSITIVE_INFINITY) - (b.motionP50 ?? Number.POSITIVE_INFINITY) ||
				(a.cutCount ?? 0) - (b.cutCount ?? 0) ||
				b.score - a.score,
		);
}

/** gtrk 工程 → 主视频轨 clip 拼接边界（秒，升序；首 clip 起点不算切点）。
 * 主轨口径与渲染一致：track_index 最小的**非黑底垫轨**（struct_meta.broll.black_track 登记）。 */
export function boundariesFromGtrk(gtrk: unknown): number[] {
	const g = gtrk as {
		video_track?: { track_index?: number; track_timeline?: { track_st?: number; duration?: number; material?: unknown }[] }[];
		struct_meta?: { broll?: { black_track?: number | null } };
	};
	const tracks = [...(g.video_track ?? [])]
		.map((t, i) => ({ key: typeof t.track_index === "number" ? t.track_index : i, t }))
		.sort((a, b) => a.key - b.key);
	if (!tracks.length) return [];
	const black = g.struct_meta?.broll?.black_track ?? null;
	const main = (typeof black === "number" ? tracks.filter((x) => x.key !== black) : tracks)[0] ?? tracks[0];
	const timeline = [...(main!.t.track_timeline ?? [])].sort((a, b) => Number(a.track_st) - Number(b.track_st));
	return timeline
		.map((c) => Number(c.track_st))
		.filter((t) => Number.isFinite(t))
		.slice(1);
}

/** 黑段是否命中工程登记的黑底空洞（命中即降级 info——预期内产物）。 */
export function isKnownBlackHole(gtrk: unknown, st: number, ed: number): boolean {
	const holes = (gtrk as { struct_meta?: { broll?: { holes?: { track_st: number; track_ed: number }[] } } })
		?.struct_meta?.broll?.holes;
	if (!Array.isArray(holes)) return false;
	return holes.some((h) => ed >= Number(h.track_st) - 0.25 && st <= Number(h.track_ed) + 0.25);
}

// ── 扫描编排 ─────────────────────────────────────────────────────────────

export interface QcScanOptions {
	ffmpegPath?: string;
	/** 工程感知模式：已解析的 gtrk 对象（命令层读文件/render 直接透传）。 */
	gtrk?: unknown;
	onProgress?: (line: string) => void;
}

/** 扫描成片，产 qc-report v1（不落盘——落盘与人读格式化归命令层）。 */
export async function scanFinalCut(input: string, opts: QcScanOptions = {}): Promise<QcReport> {
	const ff = requireFfmpeg(opts.ffmpegPath);
	const T = QC_THRESHOLDS;
	const items: QcItem[] = [];

	// ── 流级事实（ffprobe，零解码）：时长差与 CFR ──
	const probe = ffprobeJson(ff.ffprobe, [
		"-v", "error",
		"-show_entries", "stream=codec_type,duration,nb_frames,r_frame_rate,avg_frame_rate",
		"-of", "json",
		input,
	]) as { streams?: { codec_type?: string; duration?: string; nb_frames?: string; r_frame_rate?: string; avg_frame_rate?: string }[] };
	const streams = probe.streams ?? [];
	const v = streams.find((s) => s.codec_type === "video");
	const a = streams.find((s) => s.codec_type === "audio");
	const vDur = v?.duration != null ? Number(v.duration) : null;
	const aDur = a?.duration != null ? Number(a.duration) : null;
	if (vDur !== null && aDur !== null) {
		const diff = vDur - aDur;
		if (Math.abs(diff) > T.avDurationDiffSec) {
			items.push({
				type: "av_drift",
				severity: "error",
				st: r3(Math.min(vDur, aDur)),
				ed: r3(Math.max(vDur, aDur)),
				evidence: {
					video_duration: r3(vDur),
					audio_duration: r3(aDur),
					diff_sec: r3(diff),
					note: "画面与音频总长不一致：画面对口播渐进失步（成片切点相对工程时间线累积漂移）",
				},
			});
		}
	}
	const rateOf = (s?: string): number | null => {
		if (!s) return null;
		const [n, d] = s.split("/").map(Number);
		return d ? n! / d : (n ?? null);
	};
	const rFps = rateOf(v?.r_frame_rate);
	const aFps = rateOf(v?.avg_frame_rate);
	if (rFps && aFps && Math.abs(rFps - aFps) / rFps > 0.01) {
		items.push({
			type: "vfr",
			severity: "error",
			st: 0,
			ed: r3(vDur ?? 0),
			evidence: { r_frame_rate: r3(rFps), avg_frame_rate: r3(aFps), note: "成片非 CFR（渲染产物应恒为固定帧率）" },
		});
	}

	// ── 视频趟：scene score + blackdetect + freezedetect 并联（一次解码）──
	opts.onProgress?.("视频趟：逐帧跳变 + 黑帧 + 冻结检测…");
	const vFilter = [
		"select='gte(scene,0)'",
		"metadata=print",
		`blackdetect=d=${T.blackMinDurSec}:pic_th=${T.blackPicTh}:pix_th=${T.blackPixTh}`,
		`freezedetect=n=${T.freezeNoise}:d=${T.freezeMinDurSec}`,
	].join(",");
	const vErr = await captureStderr(ff.ffmpeg, ["-i", input, "-vf", vFilter, "-f", "null", "-"]);

	const frames = parseSceneScores(vErr);
	const cuts = frames.filter((f) => f.score > T.sceneScore).map((f) => f.ts);

	// 闪现判定放在**工程对表之后**（tune-shot-rhythm-thresholds D1）：严重级要按端点来源裁定，
	// 而来源只有对表才知道。无工程时退回不分级的纯阈值报告。
	let spliceCuts: Set<number> | null = null;

	if (opts.gtrk) {
		const bounds = boundariesFromGtrk(opts.gtrk);
		const { matched, intra } = matchCutsToBoundaries(cuts, bounds);
		const drifts = matched.map((m) => m.drift);
		spliceCuts = new Set(matched.map((m) => m.cut));
		// 工程坐标（add-material-motion-signal）：把成片时码映射回 (beat, 槽位, clip, 源窗)
		const slots = slotsFromGtrk(opts.gtrk);
		for (const t of intra) {
			// 定位到「跳变发生在哪一颗粒内部」：取该跳变之前最后一个已对齐的拼接切点（成片时基，
			// 已含漂移），人跳时码复核时对得上画面；片头颗粒无前序切点则给 null
			const prior = matched.filter((m) => m.cut <= t);
			const clipStart = prior.length ? prior[prior.length - 1]!.cut : null;
			const mapped = toSourceTime(slots, t);
			items.push({
				type: "intra_cut",
				severity: "warn",
				st: t,
				ed: t,
				evidence: {
					note: "跳变不落在任何 clip 拼接边界上：颗粒窗口内部越过了源素材的镜头切点",
					clip_started_at: clipStart,
					...(clipStart !== null ? { into_clip_sec: r3(t - clipStart) } : {}),
					// 工程坐标：定位到 beat / 槽位 / 素材 / 源窗，供直接改 plan 换段
					...(mapped
						? {
								beat: mapped.slot.beat,
								slot_index: mapped.slot.slotIndex,
								clip_id: mapped.slot.clipId,
								source_window: [mapped.slot.clipSt, mapped.slot.clipEd],
								source_time: mapped.src,
							}
						: { coord_note: "跳变落在槽位边界容差内或工程无槽位登记，无法唯一定位" }),
				},
			});
		}
		if (drifts.length) {
			opts.onProgress?.(
				`工程对表：${matched.length}/${bounds.length} 个剪切点对齐（漂移 ${r3(drifts[0]!)}s→${r3(drifts[drifts.length - 1]!)}s）· 段内跳切 ${intra.length}`,
			);
		}
	}

	items.push(...shortShotItems(cuts, spliceCuts));

	for (const b of parseBlackDetect(vErr)) {
		const known = opts.gtrk ? isKnownBlackHole(opts.gtrk, b.st, b.ed) : false;
		items.push({
			type: "black",
			severity: known ? "info" : "warn",
			st: r3(b.st),
			ed: r3(b.ed),
			evidence: { sec: r3(b.ed - b.st), ...(known ? { known_black_bed_hole: true } : {}) },
		});
	}
	for (const f of parseFreezeDetect(vErr)) {
		items.push({ type: "freeze", severity: "warn", st: r3(f.st), ed: r3(f.ed), evidence: { sec: r3(f.ed - f.st) } });
	}

	// ── 音频趟：silencedetect + astats + ebur128 并联（一次解码）──
	if (a) {
		opts.onProgress?.("音频趟：静音 + 削波 + true peak 检测…");
		const aFilter = [
			`silencedetect=n=${T.silenceNoiseDb}dB:d=${T.silenceMinDurSec}`,
			"astats=metadata=1",
			"ebur128=peak=true",
		].join(",");
		const aErr = await captureStderr(ff.ffmpeg, ["-i", input, "-af", aFilter, "-f", "null", "-"]);
		for (const s of parseSilenceDetect(aErr)) {
			items.push({ type: "silence", severity: "warn", st: r3(s.st), ed: r3(s.ed), evidence: { sec: r3(s.ed - s.st) } });
		}
		const { clipCount, truePeakDbtp } = parseAudioStats(aErr);
		const overPeak = truePeakDbtp !== null && truePeakDbtp > T.truePeakDbtp;
		if (clipCount > 0 || overPeak) {
			items.push({
				type: "clip",
				severity: "error",
				st: 0,
				ed: r3(aDur ?? 0),
				evidence: {
					clipped_samples: clipCount,
					true_peak_dbtp: truePeakDbtp,
					note: "音频触顶（削波样本 / true peak 越限），成片过响易爆音",
				},
			});
		}
	}

	items.sort((x, y) => x.st - y.st || x.ed - y.ed);
	const summary = { error: 0, warn: 0, info: 0 };
	for (const it of items) summary[it.severity]++;
	return { qc_version: "v1", input, generated_at: new Date().toISOString(), summary, items };
}

/** 报告 → 退出码门控（`--fail-on`）。 */
export function shouldFail(report: QcReport, failOn: "error" | "warn" | "never"): boolean {
	if (failOn === "never") return false;
	if (failOn === "warn") return report.summary.error > 0 || report.summary.warn > 0;
	return report.summary.error > 0;
}

/** 秒 → `HH:MM:SS.mmm`（人读报告时码）。 */
export function fmtTime(sec: number): string {
	const s = Math.max(0, sec);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = s % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${ss.toFixed(3).padStart(6, "0")}`;
}
