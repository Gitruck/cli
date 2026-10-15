/**
 * 合成颗粒铺轨（change add-composite-layer，design D6）——纯函数：给定工程与要铺的颗粒，产出新工程。
 *
 * - 认领按自产身份：`producer.by == "gtrk:composite@1"`；原型时期铺的（无 producer、`html_material` 以 `composite-` 开头）
 *   也认作自产（测试工程那 13 颗就是这样铺的）。不按轨号认——客户端保存会重编轨号（同 fix-mg-lay-track-identity）。
 *   用户在客户端动过的颗粒会被清掉 producer，此后按用户的东西对待、不碰。
 * - 全量铺 = 剥掉全部自产合成颗粒再铺；`only` = 只替换命中的那几颗，其余原样保留。
 * - 新轨号 = max(9, 现存全部轨号) + 1：在全部 beat 轨之上（客户端还会把合成车道置顶）。
 * - 时码帧格化：两端各取一次帧号、毫秒是帧号的向下投影，duration 由两端投影之差导出（与 mg lay 同一写法）。
 * - 素材：登记 `composite-<id>` → 颗粒 HTML、补登记 own 槽位的同批素材；剥离只剥「被剥掉的自产颗粒引用、且已无人引用」的条目，
 *   own 素材一律不剥（它们只在颗粒 HTML 里被引用）。
 */
import { f2ms, sec2frame } from "./frame-domain";
import { COMPOSITE_PRODUCER } from "./composite-scene";

type Obj = Record<string, unknown>;
type Track = { track_index?: number; track_timeline?: Obj[] };

export const COMPOSITE_MATERIAL_PREFIX = "composite-";

export interface LayItem {
	id: string;
	/** 颗粒 HTML，相对 .gtrk 所在目录。 */
	html_rel: string;
	track_st: number;
	track_ed: number;
}

export interface LayResult {
	next: Obj;
	laid: string[];
	kept: string[];
	removed: string[];
	trackIndex: number | null;
	materialsAdded: string[];
	materialsRemoved: string[];
	/** 被认作用户东西、原样保留的合成颗粒（producer 被清掉的）。 */
	foreign: Array<{ track_index: number | null; clip_id: string }>;
	/** 没铺的颗粒：时间线上已有同 id、但已不是自产的片段（用户在客户端改过）——不覆盖、不撞 id。 */
	skipped: Array<{ id: string; why: string }>;
	/** 实际落轨的帧格时码（可能与清单秒值差不到 1 毫秒）。 */
	timings: Record<string, { track_st: number; track_ed: number }>;
}

export function isOwnComposite(c: Obj): boolean {
	const by = (c.producer as { by?: unknown } | undefined)?.by;
	if (by !== undefined) return by === COMPOSITE_PRODUCER;
	return String(c.html_material ?? "").startsWith(COMPOSITE_MATERIAL_PREFIX) && c.clip_id === c.material;
}

const looksComposite = (c: Obj) => String(c.html_material ?? "").startsWith(COMPOSITE_MATERIAL_PREFIX);

export function layComposites(
	gtrk: Obj,
	items: LayItem[],
	{ only = [] as string[], extraMaterials = [] as Obj[], run = "", rate = Number(gtrk.video_rate) } = {},
): LayResult {
	const beat = ((gtrk.beat_track as Track[] | undefined) ?? []).map((t) => ({ ...t, track_timeline: [...(t.track_timeline ?? [])] }));
	const onlySet = new Set(only);
	const prevOwn: Obj[] = [];
	const foreign: LayResult["foreign"] = [];
	for (const t of beat) {
		for (const c of t.track_timeline) {
			if (isOwnComposite(c)) prevOwn.push(c);
			else if (looksComposite(c)) foreign.push({ track_index: typeof t.track_index === "number" ? t.track_index : null, clip_id: String(c.clip_id ?? "") });
		}
	}
	// 时间线上已有同 id 的非自产片段（用户在客户端改过的那颗）：不铺这颗，免得 clip_id 重复、也不覆盖用户的改动
	const foreignIds = new Set<string>();
	for (const kind of ["video_track", "audio_track", "beat_track"]) {
		for (const t of ((gtrk[kind] as Track[] | undefined) ?? [])) for (const c of t.track_timeline ?? []) if (!isOwnComposite(c)) foreignIds.add(String(c.clip_id ?? ""));
	}
	const skipped: LayResult["skipped"] = [];
	const wanted = onlySet.size ? items.filter((it) => onlySet.has(it.id)) : items;
	const laidItems = wanted.filter((it) => {
		if (!foreignIds.has(it.id)) return true;
		skipped.push({ id: it.id, why: "时间线上已有同 id 的片段且已不是自产（在客户端改过）；要重铺先在客户端删掉它" });
		return false;
	});
	const laidIds = new Set(laidItems.map((it) => it.id));
	const carried = onlySet.size ? prevOwn.filter((c) => !laidIds.has(String(c.clip_id))) : [];
	const carriedSet = new Set(carried);
	const removedClips = prevOwn.filter((c) => !carriedSet.has(c));

	// 剥掉自产颗粒；因此变空的轨删掉（原本就空的轨不动）
	const keptTracks = beat
		.map((t) => ({ t, had: t.track_timeline.some(isOwnComposite) }))
		.map(({ t, had }) => ({ t: { ...t, track_timeline: t.track_timeline.filter((c) => !isOwnComposite(c)) }, had }))
		.filter(({ t, had }) => !(had && t.track_timeline.length === 0))
		.map(({ t }) => t);

	const newClips: Obj[] = [];
	const timings: LayResult["timings"] = {};
	for (const it of laidItems) {
		const stMs = f2ms(sec2frame(it.track_st, rate), rate);
		const edMs = f2ms(sec2frame(it.track_ed, rate), rate);
		if (!(edMs > stMs)) throw new Error(`颗粒 ${it.id} 的窗口投影后不足一帧（${it.track_st}–${it.track_ed}）`);
		const timing = { track_st: stMs / 1000, track_ed: edMs / 1000, duration: (edMs - stMs) / 1000 };
		timings[it.id] = { track_st: timing.track_st, track_ed: timing.track_ed };
		newClips.push({
			clip_id: it.id,
			material: it.id, // = data-composition-id
			html_material: `${COMPOSITE_MATERIAL_PREFIX}${it.id}`,
			opaque: true,
			...timing,
			producer: { by: COMPOSITE_PRODUCER, ...(run ? { run } : {}) },
		});
	}
	const merged = [...carried, ...newClips].sort((a, b) => Number(a.track_st) - Number(b.track_st));
	const allIdx = [...keptTracks, ...((gtrk.video_track as Track[] | undefined) ?? []), ...((gtrk.audio_track as Track[] | undefined) ?? [])].map((t) =>
		typeof t.track_index === "number" ? t.track_index : 0,
	);
	const trackIndex = merged.length ? Math.max(9, ...allIdx) + 1 : null;
	const nextBeat = trackIndex === null ? keptTracks : [...keptTracks, { track_index: trackIndex, track_timeline: merged }];

	// 素材：先登记新的（同 id 覆盖 path），再补同批素材，最后剥「被剥颗粒引用、且已无人引用」的
	const materials = [...((gtrk.materials as Obj[] | undefined) ?? [])].map((m) => ({ ...m }));
	const byId = new Map(materials.map((m) => [String(m.id), m]));
	const materialsAdded: string[] = [];
	for (const it of laidItems) {
		const id = `${COMPOSITE_MATERIAL_PREFIX}${it.id}`;
		const m = byId.get(id);
		if (m) m.path = it.html_rel;
		else {
			const nm = { id, path: it.html_rel };
			materials.push(nm);
			byId.set(id, nm);
			materialsAdded.push(id);
		}
	}
	for (const m of extraMaterials) {
		const id = String(m.id);
		if (!byId.has(id)) {
			materials.push({ ...m });
			byId.set(id, m);
			materialsAdded.push(id);
		}
	}
	const next: Obj = { ...gtrk, beat_track: nextBeat };
	const referenced = new Set<string>();
	for (const kind of ["video_track", "audio_track", "beat_track"]) {
		for (const t of ((next[kind] as Track[] | undefined) ?? [])) {
			for (const c of t.track_timeline ?? []) for (const k of ["material", "html_material"]) if (c[k] != null) referenced.add(String(c[k]));
		}
	}
	const candidates = new Set(removedClips.flatMap((c) => [c.html_material, c.material].filter((x) => x != null).map(String)));
	const materialsRemoved = materials.filter((m) => candidates.has(String(m.id)) && !referenced.has(String(m.id))).map((m) => String(m.id));
	const drop = new Set(materialsRemoved);
	next.materials = materials.filter((m) => !drop.has(String(m.id)));

	return {
		next,
		laid: laidItems.map((it) => it.id),
		kept: carried.map((c) => String(c.clip_id)),
		removed: removedClips.map((c) => String(c.clip_id)).filter((id) => !laidIds.has(id)),
		trackIndex,
		materialsAdded,
		materialsRemoved,
		foreign,
		skipped,
		timings,
	};
}
