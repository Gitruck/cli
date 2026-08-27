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
 *     取 downbeat 网格并把音频起点吸附至工程时间轴最近 downbeat（网格 = BGM 自时间轴 0 起播时的
 *     downbeat 时刻序列；downbeat 缺失回退 beats）。无 Key / 分析失败一律降级为不对齐 + 如实提示，
 *     MUST NOT 失败整命令；无 `--beat-align` 零云端零计费。
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import type { CloudConfig } from "../lib/config";
import { loadConfig } from "../lib/config";
import { assertGtrkV1, readGtrk, writeGtrkAtomic } from "../lib/gtrk-writeback";
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
import { log, routeLogsToStderr } from "../lib/log";

/** BGM 垫底音量默认值（clip 级 volume，客户端契约：clip 级优先于轨级）。 */
// ★ 主理人 2026-08-19 拍板:BGM 垫底口径 -20dB=线性 0.10(契约 volume 只写线性,MUST NOT 写 dB——composition-contract-v1 §4)
export const AUDIO_LAY_VOLUME_DEFAULT = 0.1;
/** 自产音轨素材 id 前缀（同源幂等的身份锚在素材 path，不在 id 前缀）。 */
export const AUDIO_LAY_MATERIAL_PREFIX = "audio-lay-";
/** 上轨最短可用长度（秒）：低于此长度视为无处可放。 */
const MIN_LAY_SEC = 0.05;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** positional 解析：`lay` 或 `align [<视频> <外录>]`。 */
export function parseAudioPositional(
	words: string[] | undefined,
): { sub: "lay" } | { sub: "align"; video?: string; extAudio?: string } {
	if (!words || words.length === 0) {
		throw new Error(
			"缺少子命令——用法：gtrk audio lay --project <目录> --file <音频>；或 gtrk audio align <视频> <外录音频>",
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
	throw new Error(`未知子命令「${words.join(" ")}」——支持：gtrk audio lay / gtrk audio align`);
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

/** 起点吸附：网格点取 |p − offsetSec| 最小者（等距取小）；网格空返回 undefined（由调用方降级）。 */
export function snapToGrid(offsetSec: number, grid: number[]): number | undefined {
	const pts = grid.filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
	if (!pts.length) return undefined;
	let best = pts[0]!;
	for (const p of pts) {
		if (Math.abs(p - offsetSec) < Math.abs(best - offsetSec)) best = p;
	}
	return r3(best);
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
	/** 关闭 loop 铺满（缺省 BGM 循环叠满至工程末尾、尾段裁齐）。 */
	noLoop?: boolean;
	json?: boolean;
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
	/** loop 铺满时的总段数（单次=1）。 */
	loopCount: number;
	/** 仅 --beat-align 时出现：对齐成败与降级原因（降级不失败整命令）。 */
	beatAlign?: { aligned: boolean; grid: "downbeats" | "beats" | null; degradedReason?: string };
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

	const gtrkPath = locateGtrk(resolve(opts.project));
	const { gtrk, revision } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);

	const probeDur = deps.probeDur ?? ((p: string) => probeDuration(p));
	const probeChannel = deps.probeChannel ?? ((p: string) => probeAudioChannel(p));
	const audioDur = probeDur(audioAbs);
	if (!(audioDur > 0)) throw new Error(`探测不到有效音频时长：${audioAbs}`);
	log.step(`▶ 音频上轨：${basename(audioAbs)}（${audioDur.toFixed(1)}s · 音量 ${volume}${opts.beatAlign ? " · beat 对齐" : ""}）`);

	const projEnd = projectEndSec(gtrk);
	let trackSt = r3(offsetMs / 1000);
	if (projEnd !== undefined && trackSt >= projEnd) {
		throw new Error(`--offset ${offsetMs}ms 落在工程末尾（${projEnd.toFixed(2)}s）之外，无处可放`);
	}

	// ── --beat-align：cloud-beat 云端节拍分析（计费如实提示）；失败降级不失败整命令 ──
	let beatAlign: AudioLayResult["beatAlign"];
	if (opts.beatAlign) {
		beatAlign = { aligned: false, grid: null };
		try {
			const cfg = (deps.loadCfg ?? loadConfig)();
			log.info("节拍分析走云端 audio_music_analyze（计费一次，价格以官网价格表为准）…");
			const analyze =
				deps.analyze ??
				((c: CloudConfig, p: string) =>
					analyzeBgm(c, p, { uploadCached, invalidateUpload, submitTask, pollToolTask }));
			const analysis = await analyze(cfg, audioAbs);
			const gridName: "downbeats" | "beats" | null = analysis.downbeats?.length
				? "downbeats"
				: analysis.beats?.length
					? "beats"
					: null;
			const snapped = gridName ? snapToGrid(trackSt, gridName === "downbeats" ? analysis.downbeats! : analysis.beats!) : undefined;
			if (snapped === undefined) {
				beatAlign.degradedReason = "云端分析未返回可用节拍点（无节拍音乐？）——按原始 offset 上轨";
				log.warn(`beat 对齐降级：${beatAlign.degradedReason}`);
			} else if (projEnd !== undefined && snapped >= projEnd) {
				beatAlign.degradedReason = `最近 downbeat（${snapped}s）已在工程末尾之外——按原始 offset 上轨`;
				log.warn(`beat 对齐降级：${beatAlign.degradedReason}`);
			} else {
				if (gridName === "beats") log.info("downbeat 缺失，回退 beats 网格吸附");
				trackSt = snapped;
				beatAlign.aligned = true;
				beatAlign.grid = gridName;
				log.info(`起点已吸附最近 ${gridName === "downbeats" ? "downbeat" : "beat"}：${trackSt}s`);
			}
		} catch (e) {
			beatAlign.degradedReason = `${e instanceof Error ? e.message : String(e)}——BGM 照常上轨（不对齐）`;
			log.warn(`beat 对齐降级：${beatAlign.degradedReason}`);
		}
	}

	// ── clip 窗口：BGM 从头播（clip_st=0），工程末尾裁剪（工程长度未知则整条上）。
	// loop 铺满（adjust-audio-lay-loop-fill，真机挑刺 2026-08-27）：BGM 短于剩余时间线时
	// 缺省循环叠满至工程末尾（多 clip 首尾相接、尾段裁齐）——BGM 铺一半就静音是明显缺陷；
	// --no-loop 保留单次行为。工程长度未知（projEnd undefined）时无「满」可言，恒单次。
	const maxLen = projEnd !== undefined ? Math.max(0, projEnd - trackSt) : audioDur;
	const loop = opts.noLoop !== true && projEnd !== undefined;
	const len = r3(Math.min(audioDur, maxLen));
	if (len < MIN_LAY_SEC) throw new Error(`起点 ${trackSt}s 之后已放不下音频（工程末尾 ${projEnd?.toFixed(2)}s）`);
	if (!loop && len < audioDur - 1e-6) log.info(`音频长于剩余时间线，已在工程末尾裁剪（上轨 ${len}s / 全长 ${r3(audioDur)}s）`);

	// ── 同源幂等替换：同绝对路径素材所在的既有音轨全部剥除（含旧素材，零引用保护后）──
	const materials = [...((gtrk.materials as LooseMaterial[] | undefined) ?? [])];
	const audioTracks = [...((gtrk.audio_track as LooseTrack[] | undefined) ?? [])];
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
		(gtrk.video_track as LooseTrack[] | undefined) ?? [],
		(gtrk.beat_track as LooseTrack[] | undefined) ?? [],
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
	{
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
	if (clips.length > 1) {
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
		...gtrk,
		materials: [...keptMaterials.filter((m) => m.id !== materialId), newMaterial],
		audio_track: [...keptTracks, newTrack].sort(
			(a, b) => ((a.track_index as number) ?? 0) - ((b.track_index as number) ?? 0),
		),
	};
	writeGtrkAtomic(gtrkPath, next, revision);

	log.ok(
		`音轨已写入：track_index ${trackIndex} · ${trackSt}s → ${r3(trackSt + len)}s · 音量 ${volume}` +
			(replacedTracks ? `（替换旧同源轨 ${replacedTracks} 条）` : ""),
	);
	log.info("客户端打开工程即见音轨；本地渲染（gtrk render）混音可闻。");

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

export function registerAudio(program: Command): void {
	program
		.command("audio [words...]")
		.description(
			"音频零件族：gtrk audio lay 往 .gtrk 追加 audio_track（BGM 上轨）；gtrk audio align 外录音轨对轨换声（互相关测偏移+置信度分流，纯本地零计费）",
		)
		.option("--project <dir>", "[lay] 工程产物目录（定位 gtrk/project.gtrk）")
		.option("--file <audio>", "[lay] 要上轨的音频文件（BGM/配乐等）")
		.option("--volume <v>", `[lay] 音量 0..1（默认 ${AUDIO_LAY_VOLUME_DEFAULT}，BGM 垫底音量）`)
		.option("--offset <v>", "[lay] 入点偏移毫秒；[align] 显式偏移秒（跳过检测直接换轨，正=外录晚开录）")
		.option(
			"--beat-align",
			"[lay] 云端节拍分析（audio_music_analyze，计费一次）并把起点吸附最近 downbeat；无 Key/失败自动降级为不对齐，不失败整命令",
		)
		.option("--no-loop", "[lay] 关闭循环铺满（缺省 BGM 短于工程时循环叠满至末尾、尾段裁齐）")
		.option("--resume <gtrk>", "[align] 客户端拖齐保存后的对齐工程，读回偏移完成换轨")
		.option("--threshold <r>", "[align] 置信度阈值（主峰/次峰显著性比；缺省真机标定值）")
		.option("-o, --out <path>", "[align] 产物路径（缺省 <视频名>_extaudio.<ext>；低置信时为对齐工程路径）")
		.option("--force", "[align] 产物已存在时覆盖")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录（缺省 ~/.gitruck/ffmpeg → 系统 PATH）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[] | undefined, opts: AudioLayOpts & AudioAlignOpts) => {
			const parsed = parseAudioPositional(words);
			if (parsed.sub === "lay") {
				await runAudioLay(opts as AudioLayOpts);
				return;
			}
			await runAudioAlign(parsed.video, parsed.extAudio, opts as AudioAlignOpts);
		});
}
