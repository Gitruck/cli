/**
 * 合成颗粒解析规则（change add-composite-layer，design D3）：输入快照、受限规范化 JSON、`inputs_hash` 与状态判定。
 *
 * 规则正本是 infra capability `composite-particle-profile`，参考实现
 * `gitruck-infra/utils/process/media/vision/composite_particle/snapshot.py` / `state.py`；
 * 客户端同款在 `gitruck-opencut-rewrite/apps/web/src/tonghe/composite-particle.ts`。三端对同一组金样
 * （infra `utils/test/fixtures/composite_particle/vectors/`），本模块 MUST 与之逐字节一致。
 *
 * - 时间值全为整数：时间线位置用帧（`sec2frame`，就近、半帧进一），源钟入点用整毫秒（就近、半毫秒进一）；
 * - 规范化是受限子集：键按码点升序、无空白，只收整数 / 无控制字符的字符串 / 数组 / 对象，其余直接抛错；
 * - 字幕文本输入读 `struct_meta.client_visual_elements`（保存态 tick，基数由调用方给）。
 *
 * 纯函数、零 I/O（哈希用 node:crypto 同步算）。
 */
import { createHash } from "node:crypto";
import { sec2frame } from "./frame-domain";
import type { CompositeBinding, CompositeBlock } from "./composite-particle";

/** 客户端 MediaTime 的 tick 基数（镜像保存态时间单位；契约不登记，与 subtitle-lay 同值）。 */
export const COMPOSITE_TICKS_PER_SECOND = 120000;

export class CanonicalError extends TypeError {}

function encodeStr(s: string): string {
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0;
		if (c < 0x20 || c === 0x7f) throw new CanonicalError(`字符串含控制字符 U+${c.toString(16).padStart(4, "0").toUpperCase()}`);
	}
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function encode(v: unknown): string {
	if (typeof v === "number") {
		if (!Number.isInteger(v)) throw new CanonicalError(`规范化只允许整数，遇到 ${v}`);
		return String(v);
	}
	if (typeof v === "string") return encodeStr(v);
	if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
	if (v && typeof v === "object") {
		const obj = v as Record<string, unknown>;
		const keys = Object.keys(obj);
		for (const k of keys) {
			if (![...k].every((ch) => (ch.codePointAt(0) ?? 0) < 0x80)) throw new CanonicalError(`对象键必须为 ASCII 字符串：${k}`);
		}
		// 码点升序（ASCII 键下与 Python sorted 一致）
		keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${keys.map((k) => `${encodeStr(k)}:${encode(obj[k])}`).join(",")}}`;
	}
	throw new CanonicalError(`规范化只允许整数 / 字符串 / 数组 / 对象，遇到 ${v === null ? "null" : typeof v}`);
}

/** 受限规范化 JSON 的 UTF-8 字节串（非 ASCII 字符原样输出、不转义）。 */
export function canonicalBytes(obj: unknown): Buffer {
	return Buffer.from(encode(obj), "utf8");
}

export function inputsHash(snapshot: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalBytes(snapshot)).digest("hex")}`;
}

// ------------------------------------------------------------------ 工程查询

export interface ResolveClip {
	clip_id?: string;
	material?: string | number | null;
	clip_st?: number;
	track_st: number;
	track_ed: number;
	duration?: number;
}
export interface ResolveGtrk {
	video_rate: number;
	materials?: Array<{ id?: unknown }>;
	video_track?: Array<{ track_index?: number; track_timeline?: ResolveClip[] }>;
	audio_track?: Array<{ track_index?: number; track_timeline?: ResolveClip[] }>;
	struct_meta?: Record<string, unknown>;
}

export interface ClipFields {
	clip_id: string;
	material: string;
	clip_st_ms: number;
	track_st_f: number;
	track_ed_f: number;
}

export interface CompositeCue {
	text: string;
	f0: number;
	f1: number;
}

/** 秒 → 整毫秒，就近、半毫秒进一（infra `sec_to_ms_round`）。 */
const msHalfUp = (sec: number): number => Math.floor(sec * 1000 + 0.5);

/** 合成颗粒 beat clip 落位 → 时间线帧格 `[起点帧, 终点帧)`。 */
export function windowFrames(beat: { track_st: number; track_ed: number }, videoRate: number): [number, number] {
	return [sec2frame(Number(beat.track_st), videoRate), sec2frame(Number(beat.track_ed), videoRate)];
}

/** 锚点局部帧 = 该时刻的时间线帧号 − 窗口起点帧（MUST NOT 先算局部秒再单独帧化）。 */
export function localFrame(globalSec: number, windowStF: number, videoRate: number): number {
	return sec2frame(Number(globalSec), videoRate) - windowStF;
}

const nonGap = (c: ResolveClip): boolean => Boolean(c.material);

function clipFields(c: ResolveClip, videoRate: number): ClipFields {
	return {
		clip_id: c.clip_id || "",
		material: String(c.material),
		clip_st_ms: msHalfUp(Number(c.clip_st || 0)),
		track_st_f: sec2frame(Number(c.track_st), videoRate),
		track_ed_f: sec2frame(Number(c.track_ed), videoRate),
	};
}

/** 按 clip_id 唯一寻址；video ↔ 镜像 audio（track_st / duration / clip_st 全等）算同一编辑单元，取 video。 */
export function findRefClip(gtrk: ResolveGtrk, clipId: string): ResolveClip | null {
	const videos: ResolveClip[] = [];
	const audios: ResolveClip[] = [];
	for (const t of gtrk.video_track ?? []) for (const c of t.track_timeline ?? []) if (nonGap(c) && c.clip_id === clipId) videos.push(c);
	for (const t of gtrk.audio_track ?? []) for (const c of t.track_timeline ?? []) if (nonGap(c) && c.clip_id === clipId) audios.push(c);
	const total = videos.length + audios.length;
	if (total === 0) return null;
	if (total === 1) return videos[0] ?? audios[0];
	if (videos.length === 1 && audios.length === 1) {
		const [v, a] = [videos[0], audios[0]];
		if (v.track_st === a.track_st && v.duration === a.duration && v.clip_st === a.clip_st) return v;
	}
	return null;
}

/** 该轨与窗口相交的全部非空档片段（按起点帧、clip_id 升序）；轨不存在返回 null。 */
export function laneClips(gtrk: ResolveGtrk, trackIndex: number, window: [number, number], videoRate: number): ClipFields[] | null {
	const track = (gtrk.video_track ?? []).find((t) => t.track_index === trackIndex);
	if (!track) return null;
	return (track.track_timeline ?? [])
		.filter(nonGap)
		.map((c) => clipFields(c, videoRate))
		.filter((f) => f.track_st_f < window[1] && f.track_ed_f > window[0])
		.sort((a, b) => a.track_st_f - b.track_st_f || (a.clip_id < b.clip_id ? -1 : a.clip_id > b.clip_id ? 1 : 0));
}

/** 当前包含 `laneClipId`（非空档片段）的 video 轨号；找不到或出现在多条轨上返回 null。 */
export function findLaneTrack(gtrk: ResolveGtrk, laneClipId: string): number | null {
	const hits = new Set<number | undefined>();
	for (const t of gtrk.video_track ?? []) for (const c of t.track_timeline ?? []) if (nonGap(c) && c.clip_id === laneClipId) hits.add(t.track_index);
	if (hits.size !== 1) return null;
	const [ti] = [...hits];
	return typeof ti === "number" ? ti : null;
}

/** 整数 tick → 时间线帧号，就近、半帧进一（与 infra `_tick_frame` 逐位一致）。 */
function tickFrame(tick: number, videoRate: number, tps: number): number {
	return Math.floor((2 * tick * videoRate + tps) / (2 * tps));
}

// 规范化拒收控制字符；字幕里的换行（及其它控制字符）转空格，别让一条字幕把整颗颗粒判坏。
const cueText = (s: string): string => [...s].map((ch) => ((ch.codePointAt(0) ?? 0) < 0x20 || ch === "\x7f" ? " " : ch)).join("");

/**
 * 窗口内的字幕条目：裁到窗口、换算成局部帧 `[f0, f1)`，按 `(f0, f1)` 稳定升序。
 * 字幕 = 镜像 text 车道上 `params.subtitleCue === true` 的 text 元素；隐藏车道 / 隐藏元素不算。
 */
export function textCues(
	gtrk: ResolveGtrk,
	window: [number, number],
	videoRate: number,
	ticksPerSecond: number = COMPOSITE_TICKS_PER_SECOND,
): CompositeCue[] {
	const cve = ((gtrk.struct_meta ?? {}).client_visual_elements ?? {}) as {
		time_unit?: string;
		lanes?: Array<{ type?: string; hidden?: boolean; elements?: unknown[] }>;
	};
	const unit = cve.time_unit || "tick";
	const [st, ed] = window;
	const span = ed - st;
	const out: CompositeCue[] = [];
	for (const lane of Array.isArray(cve.lanes) ? cve.lanes : []) {
		if (!lane || lane.type !== "text" || lane.hidden === true) continue;
		for (const raw of Array.isArray(lane.elements) ? lane.elements : []) {
			const el = raw as { type?: string; hidden?: boolean; startTime?: number; duration?: number; params?: Record<string, unknown> };
			const params = el?.params;
			if (!params || el.type !== "text" || params.subtitleCue !== true) continue;
			if (el.hidden === true || typeof params.content !== "string") continue;
			const start = Number(el.startTime);
			const end = start + Number(el.duration);
			const a = unit === "tick" ? tickFrame(start, videoRate, ticksPerSecond) : sec2frame(start, videoRate);
			const b = unit === "tick" ? tickFrame(end, videoRate, ticksPerSecond) : sec2frame(end, videoRate);
			const f0 = Math.max(a - st, 0);
			const f1 = Math.min(b - st, span);
			if (f1 > f0) out.push({ text: cueText(params.content), f0, f1 });
		}
	}
	return out.sort((x, y) => x.f0 - y.f0 || x.f1 - y.f1); // 稳定排序：同起止保持文档顺序
}

// ------------------------------------------------------------------ 快照与状态

function slotEntry(
	gtrk: ResolveGtrk,
	slot: string,
	kind: CompositeBinding["kind"] | "text",
	binding: (CompositeBinding & Record<string, unknown>) | undefined,
	window: [number, number],
	videoRate: number,
	tps: number,
): Record<string, unknown> {
	const b = (binding ?? {}) as Record<string, unknown>;
	if (kind === "text") {
		const cues = textCues(gtrk, window, videoRate, tps);
		return cues.length ? { slot, kind, status: "filled", cues } : { slot, kind, status: "empty" };
	}
	const entry: Record<string, unknown> = { slot, kind };
	if (b.fit !== undefined) entry.fit = b.fit;
	if (b.framing !== undefined) entry.framing = b.framing;
	if (kind === "ref") {
		const cid = b.clip_id as string | undefined;
		const clip = cid ? findRefClip(gtrk, cid) : null;
		if (!clip) return { ...entry, status: cid ? "missing" : "empty", ...(cid ? { clip_id: cid } : {}) };
		return { ...entry, status: "filled", ...clipFields(clip, videoRate) };
	}
	if (kind === "ref-lane") {
		const lid = b.lane_clip_id as string | undefined;
		if (!lid) return { ...entry, status: "empty" };
		const ti = findLaneTrack(gtrk, lid);
		const clips = ti === null ? null : laneClips(gtrk, ti, window, videoRate);
		if (!clips || clips.length === 0) return { ...entry, status: "missing", lane_clip_id: lid };
		return { ...entry, status: "filled", lane_clip_id: lid, clips };
	}
	const mat = b.material;
	if (mat === null || mat === undefined) return { ...entry, status: "empty" };
	const ids = new Set((gtrk.materials ?? []).map((m) => m?.id));
	if (!ids.has(mat)) return { ...entry, status: "missing", material: mat };
	return { ...entry, status: "filled", material: mat, src_in_ms: b.src_in_ms, dur_f: b.dur_f, starts_at_f: b.starts_at_f };
}

export interface CompositeSnapshot {
	v: 1;
	video_rate: number;
	window: [number, number];
	slots: Record<string, unknown>[];
}

/** 由当前工程与 `resolved.bindings` 推导输入快照（与 infra `build_snapshot` 逐字段一致）。 */
export function buildSnapshot(
	gtrk: ResolveGtrk,
	beat: { track_st: number; track_ed: number },
	block: CompositeBlock,
	{ ticksPerSecond = COMPOSITE_TICKS_PER_SECOND }: { ticksPerSecond?: number } = {},
): CompositeSnapshot {
	const rate = Number(gtrk.video_rate);
	const window = windowFrames(beat, rate);
	const bindings = (block.resolved?.bindings ?? {}) as Record<string, CompositeBinding & Record<string, unknown>>;
	const slots = Object.keys(block.slots ?? {})
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		.map((sid) => slotEntry(gtrk, sid, block.slots![sid].bind.kind, bindings[sid], window, rate, ticksPerSecond));
	return { v: 1, video_rate: rate, window, slots };
}

export type CompositeState = "unresolved" | "fresh" | "rerender";

export interface CompositeEvaluation {
	state: CompositeState;
	slots: Record<string, string>;
	inputsHash?: string;
}

/** 颗粒整体状态（未解析 / 新鲜 / 需重渲）与各槽位填充状态（filled / empty / missing）。 */
export function evaluateComposite(
	gtrk: ResolveGtrk,
	beat: { track_st: number; track_ed: number },
	block: CompositeBlock,
	opts: { ticksPerSecond?: number } = {},
): CompositeEvaluation {
	if (!block.resolved || typeof block.resolved !== "object") return { state: "unresolved", slots: {} };
	const snap = buildSnapshot(gtrk, beat, block, opts);
	const h = inputsHash(snap);
	const slots: Record<string, string> = {};
	for (const e of snap.slots) slots[e.slot as string] = e.status as string;
	return { state: h === (block.resolved as { inputs_hash?: string }).inputs_hash ? "fresh" : "rerender", slots, inputsHash: h };
}
