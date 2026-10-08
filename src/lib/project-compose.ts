/** 本地分段编排：只组装已存在的媒体，不执行识别、选段或 TTS。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { stat, mkdir, writeFile, link, unlink } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { probeGeometry, probeAudioChannel, probeDuration } from "./media";
import { deliveryRate, sec2ms, sec2frame, f2ms, ms2sec } from "./frame-domain";
import { assertGtrkWriteInvariants } from "./gtrk-invariants";
import { ensureLandingWritable } from "./landing-wait";
import { readJson } from "./read-json";

type Obj = Record<string, unknown>;
export interface ComposeSegment {
	kind: "live" | "image" | "narration";
	source: string;
	in?: number;
	out?: number;
	duration?: number;
	/** live 默认保留原声；显式 false 才去掉。 */
	keep_audio?: boolean;
	/** 源时基 utterances；只投影完整落在所选源窗内的句子。 */
	transcript?: string;
}
export interface ComposeList {
	version: 1;
	segments: ComposeSegment[];
}
export interface ComposeMedia {
	path: string;
	duration: number;
	width?: number;
	height?: number;
	fps?: number;
	audio_channel?: string;
}
export interface ComposeUtterance { st: number; ed: number; text: string; words?: Array<{ w: string; st: number; ed: number }> }

function finite(value: unknown, label: string, positive = false): number {
	if (typeof value !== "number" || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
		throw new Error(`${label} 必须是${positive ? "正" : "非负"}有限数值`);
	}
	return value;
}
export function parseComposeList(raw: unknown): ComposeList {
	if (!raw || typeof raw !== "object") throw new Error("分段清单必须是 JSON 对象");
	const list = raw as ComposeList;
	if (list.version !== 1 || !Array.isArray(list.segments) || !list.segments.length) throw new Error("分段清单须含 version:1 与非空 segments");
	for (const [i, s] of list.segments.entries()) {
		if (!s || !["live", "image", "narration"].includes(s.kind) || typeof s.source !== "string" || !s.source.trim()) throw new Error(`第 ${i + 1} 段须有 kind 与本地 source`);
		for (const key of Object.keys(s)) if (!["kind", "source", "in", "out", "duration", "keep_audio", "transcript"].includes(key)) throw new Error(`第 ${i + 1} 段不支持字段 ${key}`);
		if (/^[a-z]+:\/\//i.test(s.source)) throw new Error("compose 只引用本地文件；请先下载媒体");
		if (s.keep_audio !== undefined && typeof s.keep_audio !== "boolean") throw new Error("keep_audio 必须是布尔值");
		if (s.transcript !== undefined && (typeof s.transcript !== "string" || !s.transcript)) throw new Error("transcript 必须是文件路径");
		if (s.kind === "image") {
			finite(s.duration, `第 ${i + 1} 段 duration`, true);
			if (s.in !== undefined || s.out !== undefined || s.transcript !== undefined) throw new Error("图片段使用 duration，不接受 in/out/transcript");
		} else {
			if (s.duration !== undefined) throw new Error("视频/旁白段使用 in/out，不接受 duration");
			if (s.in !== undefined) finite(s.in, "in");
			if (s.out !== undefined && finite(s.out, "out", true) <= (s.in ?? 0)) throw new Error("out 必须大于 in");
		}
	}
	return list;
}

/** 编排纯函数；源时钟保留毫秒，轨道累计终点一次投影到工程帧域。 */
export function buildComposedProject(list: ComposeList, media: ComposeMedia[], canvas: [number, number], rate: number, transcripts: ComposeUtterance[][] = []) {
	parseComposeList(list);
	if (media.length !== list.segments.length) throw new Error("素材探测数与分段数不一致");
	if (!Number.isInteger(rate) || rate <= 0 || rate > 60) throw new Error("工程帧率须为 1–60 正整数");
	if (canvas.length !== 2 || canvas.some(v => !Number.isInteger(v) || v <= 0 || v % 2)) throw new Error("画布宽高须为正偶数");
	const materials = new Map<string, Obj>();
	const video: Obj[] = [], audio: Obj[] = [], mapping: Obj[] = [], utterances: Obj[] = [], warnings: string[] = [];
	const utteranceKeys = new Set<string>();
	let requestedMs = 0, frame = 0, adjustment = 0;
	for (const [i, s] of list.segments.entries()) {
		const m = media[i]!;
		if (!m.path) throw new Error("素材缺本地路径");
		if (s.kind !== "image") finite(m.duration, "素材时长", true);
		if (s.kind !== "narration" && (!(m.width! > 0) || !(m.height! > 0))) throw new Error("视觉素材缺有效几何");
		if (s.kind === "live") deliveryRate(m.fps!);
		if (s.kind === "narration" && !m.audio_channel) throw new Error("旁白素材没有音轨");
		const inMs = sec2ms(s.in ?? 0);
		const outMs = s.kind === "image" ? sec2ms(s.duration!) : sec2ms(s.out ?? m.duration);
		if (outMs <= inMs || (s.kind !== "image" && outMs > sec2ms(m.duration))) throw new Error(`第 ${i + 1} 段源窗越界或为空`);
		requestedMs += outMs - inMs;
		let endFrame = sec2frame(ms2sec(requestedMs), rate) + adjustment;
		const startMs = f2ms(frame, rate);
		const limitMs = s.kind === "image" ? Infinity : outMs - inMs;
		while (endFrame > frame && f2ms(endFrame, rate) - startMs > limitMs) { endFrame--; adjustment--; }
		if (endFrame <= frame) throw new Error(`第 ${i + 1} 段不足一帧`);
		const endMs = f2ms(endFrame, rate), durationMs = endMs - startMs;
		const id = `compose-material-${createHash("sha256").update(m.path).digest("hex").slice(0, 20)}`;
		if (!materials.has(id)) materials.set(id, {
			id, path: m.path.replace(/\\/g, "/"), duration: s.kind === "image" ? 0 : m.duration,
			...(s.kind !== "narration" ? { video_size: [m.width, m.height], ...(s.kind === "live" ? { video_rate: m.fps } : {}) } : {}),
			...(m.audio_channel ? { audio_channel: m.audio_channel } : {}),
		});
		const clip = { clip_id: `compose-${i + 1}`, material: id, clip_st: ms2sec(inMs), clip_ed: ms2sec(inMs + durationMs), track_st: ms2sec(startMs), track_ed: ms2sec(endMs), duration: ms2sec(durationMs) };
		if (s.kind === "narration") {
			audio.push(clip);
			video.push({ clip_id: `compose-gap-${i + 1}`, track_st: clip.track_st, track_ed: clip.track_ed, duration: clip.duration });
		} else {
			video.push({ ...clip, muted: true });
			// 同期声独立可编辑；视频元素禁声，防客户端把嵌入声与独立音轨叠播。
			if (s.kind === "live" && s.keep_audio !== false && m.audio_channel) audio.push({ ...clip, clip_id: `compose-audio-${i + 1}` });
		}
		let omitted = 0;
		for (const u of transcripts[i] ?? []) {
			finite(u.st, "utterance.st"); finite(u.ed, "utterance.ed", true);
			if (u.ed <= u.st || typeof u.text !== "string" || !u.text.trim()) throw new Error("无效 utterance");
			const us = sec2ms(u.st), ue = sec2ms(u.ed);
			if (ue <= inMs || us >= inMs + durationMs) continue;
			if (us < inMs || ue > inMs + durationMs) { omitted++; continue; }
			const key = JSON.stringify([id, us, ue, u.text]);
			if (!utteranceKeys.has(key)) {
				utteranceKeys.add(key);
				// 文稿保留源时基并携带素材身份；后续剪动由既有投影器重投，不冻结轨道秒。
				const words = u.words ?? [];
				if (!Array.isArray(words)) throw new Error("utterance.words 必须是数组");
				for (const w of words) {
					finite(w.st, "word.st"); finite(w.ed, "word.ed", true);
					if (typeof w.w !== "string" || !w.w || w.ed <= w.st || w.st < u.st || w.ed > u.ed) throw new Error("字级时码越出句子或格式错误");
				}
				utterances.push({ id: `u${utterances.length + 1}`, material_id: id, require_full_span: true, st: ms2sec(us), ed: ms2sec(ue), text: u.text, words });
			}
		}
		if (omitted) warnings.push(`第 ${i + 1} 段有 ${omitted} 句跨越切点，未伪造整句字幕，请核听补字`);
		mapping.push({ segment: i + 1, kind: s.kind, source: m.path, ...clip, requested_out: ms2sec(outMs) });
		frame = endFrame;
	}
	const gtrk = { version: "v1", video_size: canvas, video_rate: rate, duration: ms2sec(f2ms(frame, rate)), materials: [...materials.values()], video_track: [{ track_index: 0, track_size: canvas, track_timeline: video }], audio_track: audio.length ? [{ track_index: 0, track_timeline: audio }] : [], beat_track: [] };
	assertGtrkWriteInvariants(gtrk, "project compose");
	const text_hash = createHash("sha256").update(utterances.map(u => u.text).join("\n")).digest("hex");
	return { gtrk, mapping, transcript: { version: "v1", source: "project_compose", material_id: "compose-multiple-sources", text_hash, duration: gtrk.duration, utterances }, warnings };
}

export async function composeProject(opts: { list: string; out: string; canvas: [number, number]; ffmpegPath?: string }) {
	const listPath = resolve(opts.list), base = dirname(listPath), out = resolve(opts.out);
	if (existsSync(out)) throw new Error(`工程目录已存在，compose 不覆盖既有工程：${out}`);
	const list = parseComposeList(await readJson(listPath, "分段清单"));
	const media: ComposeMedia[] = [], transcripts: ComposeUtterance[][] = [], fingerprints = new Map<string, { size: number; mtimeMs: number }>();
	const cache = new Map<string, ComposeMedia>();
	for (const s of list.segments) {
		const source = resolve(base, s.source), key = `${s.kind}:${source}`;
		const st = await stat(source);
		if (!st.isFile()) throw new Error(`素材不是文件：${source}`);
		fingerprints.set(source, { size: st.size, mtimeMs: st.mtimeMs });
		let m = cache.get(key);
		if (!m) {
			const audio_channel = s.kind === "image" ? undefined : probeAudioChannel(source, opts.ffmpegPath);
			m = s.kind === "narration" ? { path: source, duration: probeDuration(source, opts.ffmpegPath), audio_channel } : { path: source, ...probeGeometry(source, opts.ffmpegPath), audio_channel };
			cache.set(key, m);
		}
		media.push(m);
		const tr = s.transcript ? await readJson<{ utterances: ComposeUtterance[] }>(resolve(base, s.transcript), "源文稿") : { utterances: [] };
		if (!Array.isArray(tr.utterances)) throw new Error("transcript 须含源时基 utterances 数组");
		transcripts.push(tr.utterances);
	}
	const firstVideo = media.find((_, i) => list.segments[i]!.kind === "live");
	// 无视频源时采用既有配音工程的 30fps 画布；有视频时从实测帧率取交付视图。
	const rate = firstVideo ? deliveryRate(firstVideo.fps!) : 30;
	const built = buildComposedProject(list, media, opts.canvas, rate, transcripts);
	for (const [source, before] of fingerprints) {
		const after = await stat(source);
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`编排期间素材已变化：${source}`);
	}
	await ensureLandingWritable(out, "分段工程目录");
	await mkdir(dirname(out), { recursive: true });
	try { await mkdir(out); } catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`工程目录已被占用，未覆盖：${out}`);
		throw e;
	}
	await mkdir(join(out, "gtrk")); await mkdir(join(out, "transcript"));
	const gtrkPath = join(out, "gtrk", "project.gtrk");
	const result = { command: "project compose", out_dir: out, gtrk: gtrkPath, transcript: join(out, "transcript", "transcript.json"), duration: built.gtrk.duration, segments: list.segments.length, warnings: built.warnings };
	await writeFile(join(out, "compose-map.json"), JSON.stringify({ version: 1, segments: built.mapping, sources: [...fingerprints].map(([path, fingerprint]) => ({ path, ...fingerprint })) }, null, 2), { flag: "wx" });
	await writeFile(result.transcript, JSON.stringify(built.transcript, null, 2), { flag: "wx" });
	await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2), { flag: "wx" });
	const pending = join(out, "gtrk", `.compose-${randomUUID()}.tmp`);
	try {
		await writeFile(pending, JSON.stringify(built.gtrk, null, 2), { flag: "wx" });
		await link(pending, gtrkPath); // 原子发布且不覆盖；失败时不留下半份 .gtrk。
	} finally { await unlink(pending).catch(() => {}); }
	return result;
}
