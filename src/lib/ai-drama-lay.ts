/**
 * AI Drama Desk return-v1 回填纯逻辑。
 *
 * 生成是非确定性的创作过程；本模块只做确定性的「导出包 → 独立 video_track」写回：
 * - 所有包共用一条 AI 轨；
 * - 每个 beat 从当刻窗口起点顺排，最后一镜**尽量**吸收到窗口终点——但单 clip 恒不超过素材实测
 *   时长 `measuredSec`：**素材短于窗口时窗口尾部留空档**（露出底下的轨），
 *   MUST NOT 拉伸 / 循环 / 补帧去填满。这是正确行为不是缺陷（凭空造帧才是），
 *   条文见 `ai-drama-lay-command` 的「素材短于窗口时留空档而非拉伸」Scenario；
 * - 只剥 `struct_meta.ai_drama.lay_tracks` 登记过的自产轨/素材，其他轨零连带；
 * - 不生成媒体、不调用云端、不计费。
 */

export const AI_DRAMA_MATERIAL_PREFIX = "ai-drama-";
export const AI_DRAMA_PRODUCER_BY = "gtrk:ai-drama@1";

import { r3 } from "./frame-domain";
import { assertGtrkWriteInvariants } from "./gtrk-invariants";

export interface AiDramaLayItem {
	shotIndex: number;
	file: string;
	relPath: string;
	suggestedSec: number;
	measuredSec: number;
	width?: number;
	height?: number;
	fps?: number;
}

export interface AiDramaLayPackage {
	slug: string;
	beatId: string;
	manifestPath: string;
	trackSt: number;
	trackEd: number;
	items: AiDramaLayItem[];
}

interface LooseTrack {
	track_index?: unknown;
	track_timeline?: Record<string, unknown>[];
	[k: string]: unknown;
}

interface LooseMaterial {
	id?: unknown;
	[k: string]: unknown;
}

export interface AiDramaMetaClip {
	clip_id: string;
	material_id: string;
	shot_index: number;
	track_st: number;
	track_ed: number;
	duration: number;
}

export interface StructMetaAiDrama {
	contract_version: "v1";
	generated_at: string;
	lay_tracks: number[];
	material_ids: string[];
	packages: Array<{
		slug: string;
		beat: string;
		manifest_path: string;
		track_st: number;
		track_ed: number;
		clips: AiDramaMetaClip[];
	}>;
	timecode_source?: "reprojected" | "dispatch_snapshot";
	reprojected_at?: string;
	timecode_degrade_reason?: string;
}

export interface AiDramaLayResult {
	next: Record<string, unknown>;
	meta: StructMetaAiDrama;
	summary: { laidTrack: number | null; laidClips: number; beats: number; removedTracks: number[] };
}

export function aiDramaProducerTag(run: string): string {
	return JSON.stringify({ by: AI_DRAMA_PRODUCER_BY, run });
}

function previousMeta(gtrk: Record<string, unknown>): Partial<StructMetaAiDrama> | undefined {
	const structMeta = gtrk.struct_meta as Record<string, unknown> | undefined;
	const value = structMeta?.ai_drama;
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Partial<StructMetaAiDrama>)
		: undefined;
}

/** 已登记 AI 轨是否在客户端被改过。判不准时宁可拒绝覆盖。 */
export function aiDramaTracksEdited(gtrk: Record<string, unknown>): boolean {
	const prev = previousMeta(gtrk);
	const indices = Array.isArray(prev?.lay_tracks) ? prev.lay_tracks.filter((n): n is number => typeof n === "number") : [];
	if (!indices.length) return false;
	const tracks = (Array.isArray(gtrk.video_track) ? gtrk.video_track : []) as LooseTrack[];
	const expected = (Array.isArray(prev?.packages) ? prev.packages : []).flatMap((p) => (Array.isArray(p.clips) ? p.clips : []));
	const actual = tracks
		.filter((t) => typeof t.track_index === "number" && indices.includes(t.track_index))
		.flatMap((t) => (Array.isArray(t.track_timeline) ? t.track_timeline : []));
	if (actual.length !== expected.length) return true;
	const byId = new Map(expected.map((c) => [c.clip_id, c]));
	return actual.some((c) => {
		const id = typeof c.clip_id === "string" ? c.clip_id : "";
		const e = byId.get(id);
		if (!e) return true;
		return ["track_st", "track_ed", "duration"].some((k) => r3(Number(c[k])) !== r3(Number(e[k as keyof AiDramaMetaClip])));
	});
}

/** 导出包 → 一条独立 AI video_track。纯函数，不做文件复制或写盘。 */
export function layAiDramaTracks(opts: {
	gtrk: Record<string, unknown>;
	packages: AiDramaLayPackage[];
	generatedAt: string;
	/** 写方自检里**存量**违例的 WARN 出口（gtrk-writer-invariants D2′）；命令层接 `log.warn`，纯函数单测可不传。 */
	warn?: (message: string) => void;
}): AiDramaLayResult {
	const { gtrk, generatedAt } = opts;
	const packages = [...opts.packages].sort((a, b) => a.trackSt - b.trackSt || a.beatId.localeCompare(b.beatId));
	const prev = previousMeta(gtrk);
	const oldIndices = new Set(Array.isArray(prev?.lay_tracks) ? prev.lay_tracks.filter((n): n is number => typeof n === "number") : []);
	const oldMaterialIds = new Set(Array.isArray(prev?.material_ids) ? prev.material_ids.filter((s): s is string => typeof s === "string") : []);
	const tracks = (Array.isArray(gtrk.video_track) ? gtrk.video_track : []) as LooseTrack[];
	const keptTracks = tracks.filter((t) => !(typeof t.track_index === "number" && oldIndices.has(t.track_index)));
	const materials = (Array.isArray(gtrk.materials) ? gtrk.materials : []) as LooseMaterial[];
	const keptMaterials = materials.filter((m) => !(typeof m.id === "string" && oldMaterialIds.has(m.id)));

	const newIndex = Math.max(-1, ...keptTracks.map((t) => (typeof t.track_index === "number" ? t.track_index : -1))) + 1;
	const producer = aiDramaProducerTag(generatedAt);
	const clips: Record<string, unknown>[] = [];
	const newMaterials: LooseMaterial[] = [];
	const materialIds: string[] = [];
	const metaPackages: StructMetaAiDrama["packages"] = [];

	for (const pkg of packages) {
		let cursor = r3(pkg.trackSt);
		const beatClips: AiDramaMetaClip[] = [];
		const items = [...pkg.items].sort((a, b) => a.shotIndex - b.shotIndex);
		for (let i = 0; i < items.length; i++) {
			const item = items[i]!;
			const remaining = r3(pkg.trackEd - cursor);
			if (!(remaining > 0)) break;
			const desired = i === items.length - 1 ? remaining : Math.min(item.suggestedSec, remaining);
			const duration = r3(Math.min(desired, item.measuredSec));
			if (!(duration > 0)) continue;
			const materialId = `${AI_DRAMA_MATERIAL_PREFIX}${pkg.slug}-${pkg.beatId.toLowerCase()}-s${item.shotIndex}`;
			const clipId = `${pkg.slug}-${pkg.beatId.toLowerCase()}-s${item.shotIndex}`;
			const trackEd = r3(cursor + duration);
			newMaterials.push({
				id: materialId,
				path: item.relPath,
				duration: r3(item.measuredSec),
				...(item.width && item.height ? { video_size: [item.width, item.height] } : {}),
				...(item.fps ? { fps: item.fps } : {}),
			});
			materialIds.push(materialId);
			clips.push({
				clip_id: clipId,
				material: materialId,
				clip_st: 0,
				clip_ed: duration,
				track_st: cursor,
				track_ed: trackEd,
				duration,
				producer,
				beat: pkg.beatId,
				shot_index: item.shotIndex,
			});
			beatClips.push({ clip_id: clipId, material_id: materialId, shot_index: item.shotIndex, track_st: cursor, track_ed: trackEd, duration });
			cursor = trackEd;
		}
		metaPackages.push({
			slug: pkg.slug,
			beat: pkg.beatId,
			manifest_path: pkg.manifestPath,
			track_st: r3(pkg.trackSt),
			track_ed: r3(pkg.trackEd),
			clips: beatClips,
		});
	}

	const sortedClips = clips.sort((a, b) => Number(a.track_st) - Number(b.track_st));
	const createdTracks = sortedClips.length
		? [{ track_index: newIndex, track_size: gtrk.video_size, muted: true, source_layer: "ai_drama", track_timeline: sortedClips }]
		: [];
	const meta: StructMetaAiDrama = {
		contract_version: "v1",
		generated_at: generatedAt,
		lay_tracks: createdTracks.map((t) => t.track_index),
		material_ids: materialIds,
		packages: metaPackages,
	};
	const structMeta = { ...((gtrk.struct_meta as Record<string, unknown> | undefined) ?? {}), ai_drama: meta };
	const next: Record<string, unknown> = { ...gtrk, materials: [...keptMaterials, ...newMaterials], video_track: [...keptTracks, ...createdTracks], struct_meta: structMeta };
	// 写方自检（gtrk-writer-invariants，写回前唯一出口）：本次写出的 AI clip 查恒等式 / 素材上界 / 与同轨邻居零重叠，
	// 违约即抛、命令层还没走到 writeGtrkAtomic ⇒ 工程文件逐字节不变。保留轨里的存量违例只 WARN（D2′）。
	// 三次 r3 一条链的恒等式今天靠「所有量都在毫秒格上」成立，这里是它的证明而不是修补；判据 MUST NOT 在本文件复刻。
	assertGtrkWriteInvariants(next, "ai-drama lay", {
		ownClipIds: new Set(sortedClips.map((c) => c.clip_id as string)),
		warn: opts.warn,
	});
	return {
		next,
		meta,
		summary: {
			laidTrack: createdTracks[0]?.track_index ?? null,
			laidClips: sortedClips.length,
			beats: metaPackages.filter((p) => p.clips.length > 0).length,
			removedTracks: [...oldIndices].sort((a, b) => a - b),
		},
	};
}
