/**
 * RRV 颗粒铺轨（add-rrv-lay）——把 live html-particle 铺进 .gtrk 的 **beat_track**（不是 video_track）。
 *
 * 与 broll 铺轨（matrix-lay）三处本质差异（fork 红线）：
 *   ① 操作 gtrk.beat_track（颗粒只能落这里；误落 video_track 会被 importer 静默丢弃）；
 *   ② 素材剥离按 clip.html_material 的 rrv- 前缀（不是 broll 的 clip.material）；
 *   ③ 一对一（一 beat=一颗粒），无平铺/score/候选/下载——渲染是客户端出片期的事，CLI 不云渲。
 *
 * 幂等：struct_meta.rrv.lay_tracks 登记自产 beat 轨，重铺先剥旧自产物再 append；用户手加轨零连带。
 */

const RRV_MATERIAL_PREFIX = "rrv-";
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** 一个已就绪颗粒（命令侧已定位 HTML、lint、推导 opaque、复制进 assets/rrv/）。 */
export interface RrvLayItem {
	beat: string;
	composition_id: string;
	track_st: number;
	track_ed: number;
	duration: number;
	/** 从颗粒 HTML 根 background 推导（非 dispatch.bg）：满屏盖底=true / 透明叠加=false */
	opaque: boolean;
	/** 相对 gtrk 目录的 .html 路径（assets/rrv/<composition_id>.html） */
	html_rel: string;
	/** 品类子类型（裁决⑩，可选）：rrv-overlay/mg-fullscreen…；供 opencut 色带分层 */
	category?: string;
}

export interface RrvMetaBeat {
	beat: string;
	composition_id: string;
	track_st: number;
	track_ed: number;
	duration: number;
	html_path: string;
	category?: string;
	laid: { track_index: number } | null;
}
export interface StructMetaRrv {
	contract_version: "v1";
	generated_at: string;
	lay_tracks: number[];
	beats: RrvMetaBeat[];
}
export interface RrvLayResult {
	next: Record<string, unknown>;
	summary: { laidTrack: number | null; laidParticles: number };
	rrv: StructMetaRrv;
}

interface LooseTrack {
	track_index?: number;
	track_timeline?: { html_material?: unknown }[];
	[k: string]: unknown;
}
interface LooseMaterial {
	id?: unknown;
	[k: string]: unknown;
}

/**
 * 铺轨主函数（纯函数，不做 IO）。items 为空 = 只剥旧自产物（清空 RRV 轨）。
 */
export function layRrvTracks(opts: {
	gtrk: Record<string, unknown>;
	items: RrvLayItem[];
	generatedAt: string;
}): RrvLayResult {
	const { gtrk, items, generatedAt } = opts;
	const beatTracks = [...((gtrk.beat_track as LooseTrack[] | undefined) ?? [])];
	const materials = [...((gtrk.materials as LooseMaterial[] | undefined) ?? [])];
	const structMeta = { ...((gtrk.struct_meta as Record<string, unknown> | undefined) ?? {}) };

	// ── 剥离自产物（幂等；登记缺失宁留勿删）──
	const prevRrv = structMeta.rrv as { lay_tracks?: unknown } | undefined;
	const prevIndices = new Set<number>(
		Array.isArray(prevRrv?.lay_tracks)
			? (prevRrv!.lay_tracks as unknown[]).filter((x): x is number => typeof x === "number")
			: [],
	);
	const removedTracks = beatTracks.filter((t) => typeof t.track_index === "number" && prevIndices.has(t.track_index));
	const keptTracks = beatTracks.filter((t) => !(typeof t.track_index === "number" && prevIndices.has(t.track_index)));
	// 素材剥离键 = clip.html_material 的 rrv- 前缀（不是 broll 的 clip.material）
	const removedMaterialIds = new Set<string>();
	for (const t of removedTracks) {
		for (const c of t.track_timeline ?? []) {
			const hm = c.html_material;
			if (typeof hm === "string" && hm.startsWith(RRV_MATERIAL_PREFIX)) removedMaterialIds.add(hm);
		}
	}
	const keptMaterials = materials.filter((m) => !(typeof m.id === "string" && removedMaterialIds.has(m.id)));

	// ── append：所有颗粒落一条新 beat_track（一对一、按时间不重叠，共用一轨）──
	const newMaterials: LooseMaterial[] = [];
	const clips: Record<string, unknown>[] = [];
	const metaBeats: RrvMetaBeat[] = [];
	// 新 beat 轨序：max(9, 所有现存 track_index) + 1，保证 ≥10（beat_track 惯例）且不撞任何轨
	const allIndices = [
		...keptTracks,
		...((gtrk.video_track as LooseTrack[] | undefined) ?? []),
		...((gtrk.audio_track as LooseTrack[] | undefined) ?? []),
	].map((t) => (typeof t.track_index === "number" ? t.track_index : 0));
	const newIndex = Math.max(9, ...allIndices) + 1;

	for (const it of items) {
		if (!(it.duration > 0)) {
			metaBeats.push({ ...toMetaBeat(it), laid: null });
			continue;
		}
		const materialId = `${RRV_MATERIAL_PREFIX}${it.composition_id}`;
		newMaterials.push({ id: materialId, path: it.html_rel });
		clips.push({
			clip_id: it.beat,
			material: it.composition_id, // = data-composition-id
			html_material: materialId,
			opaque: it.opaque,
			track_st: it.track_st,
			duration: it.duration,
		});
		metaBeats.push({ ...toMetaBeat(it), laid: { track_index: newIndex } });
	}

	const createdTracks =
		clips.length > 0
			? [
					{
						track_index: newIndex,
						track_timeline: clips.sort((a, b) => (a.track_st as number) - (b.track_st as number)),
					},
				]
			: [];

	const rrv: StructMetaRrv = {
		contract_version: "v1",
		generated_at: generatedAt,
		lay_tracks: createdTracks.map((t) => t.track_index),
		beats: metaBeats,
	};

	const next: Record<string, unknown> = {
		...gtrk,
		materials: [...keptMaterials, ...newMaterials],
		beat_track: [...keptTracks, ...createdTracks],
		struct_meta: { ...structMeta, rrv },
	};
	return {
		next,
		summary: { laidTrack: createdTracks[0]?.track_index ?? null, laidParticles: clips.length },
		rrv,
	};
}

function toMetaBeat(it: RrvLayItem): Omit<RrvMetaBeat, "laid"> {
	return {
		beat: it.beat,
		composition_id: it.composition_id,
		track_st: it.track_st,
		track_ed: r3(it.track_ed),
		duration: it.duration,
		html_path: it.html_rel,
		...(it.category ? { category: it.category } : {}),
	};
}
