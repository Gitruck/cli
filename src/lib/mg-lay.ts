/**
 * MG 颗粒铺轨（add-rrv-lay，去品牌化前 rrv-lay）——把 live html-particle 铺进 .gtrk 的 **beat_track**（不是 video_track）。
 *
 * 与 broll 铺轨（matrix-lay）三处本质差异（fork 红线）：
 *   ① 操作 gtrk.beat_track（颗粒只能落这里；误落 video_track 会被 importer 静默丢弃）；
 *   ② 素材剥离面按**自产身份 × 零引用**判（不是 broll 的 clip.material），详见下「素材剥离键」；
 *   ③ 一对一（一 beat=一颗粒），无平铺/score/候选/下载——渲染是客户端出片期的事，CLI 不云渲。
 *
 * 幂等：struct_meta.mg.lay_tracks 登记自产 beat 轨，重铺先剥旧自产物再 append；用户手加轨零连带。
 * 读旧写新：登记键读并集 mg ∪ rrv（既有工程零迁移），写 mg 且 delete 旧 rrv 键防孤儿。
 *
 * **剥离面 ≠ 登记轨全集**（fix-mg-lay-strip-scope 阶段 A）：本层收可选入参 `keep`（保留集），
 * 命中的既有颗粒从被剥轨里**原样搬运**到新轨、不重建；`keep` 缺省不传时输出与该 change 之前逐字节一致。
 * **该保留谁由命令层算**（判据 = 「登记里已铺、但本次 items 未覆盖」的 composition_id），
 * 本层只负责照单搬运合并，MUST NOT 自行推断、MUST NOT 在此设守门（守门恒在命令层）。
 *
 * **素材剥离键 = 身份 × 引用，不是 `clip.html_material` 前缀**（fix-mg-material-strip-key）：
 * `html_material` 是**客户端可改写**的字段（opencut 编辑后实测被改成 `html-<短码>`），拿它的前缀当剥离键
 * 会让旧素材匹配不上、剥不掉，新的又 append —— 每过一轮「客户端编辑 → 重铺」就囤一批重复 / 孤儿素材。
 * 改判两问：**谁的**（写侧 id 前缀 ∪ 写侧落点 `assets/mg/<composition_id>.html` × 自产 composition_id 账本）
 * × **还有人用吗**（写回后仍在轨上的 clip 才算引用）。判不准一律保留，绝不误删用户素材。
 */

const MG_MATERIAL_PREFIX = "mg-";
/** 遗留素材前缀（去品牌化读旧）：剥离自产物时与 mg- 取并集，剥净既有工程的旧素材。 */
const LEGACY_MATERIAL_PREFIX = "rrv-";
/** 自产素材 **id 形态**判定 = 双名前缀并集（写侧只用 mg-，读侧同认 rrv-）。 */
const isOwnMaterialId = (id: string): boolean =>
	id.startsWith(MG_MATERIAL_PREFIX) || id.startsWith(LEGACY_MATERIAL_PREFIX);

/**
 * CLI 独占的颗粒素材落点（fix-mg-material-strip-key）：命令层把源 HTML 复制进
 * `<gtrk-dir>/assets/mg/<composition_id>.html`（去品牌化前 `assets/rrv/`）。
 * **客户端会改写 material 的 id**（真机实测把 `mg-<cid>` 改写成 `html-<短码>`，clip 的 `html_material` 同步改），
 * 但**不搬 path** —— 故「路径 + 文件名」是比 id 前缀**更稳的身份**。
 */
const OWN_ASSET_DIRS = ["assets/mg/", "assets/rrv/"] as const;
/** 路径归一（客户端可能写反斜杠或 `./` 前缀），只做形态归一、不解析文件系统。 */
const normalizeRel = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
/**
 * 从 materials.path 反查它承载的 composition_id —— 命中 CLI 独占目录才算数，
 * 否则返回 undefined（= 这条素材不是本层认得出的自产物，**判不准一律不动**）。
 */
function ownAssetCompositionId(p: unknown): string | undefined {
	if (typeof p !== "string") return undefined;
	const rel = normalizeRel(p);
	for (const d of OWN_ASSET_DIRS) {
		if (!rel.startsWith(d)) continue;
		const name = rel.slice(d.length);
		if (name.includes("/")) return undefined; // 子目录不是写侧形态
		return name.replace(/\.html?$/i, "");
	}
	return undefined;
}
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * 槽位包络（秒）= 落轨 clip 的唯一时长来源（铁律⑦「颗粒占满坑位 + 终态驻留」）。
 * MUST NOT 回退到 dispatch.mg[].duration —— 那是给栏目 MG 生产 skill 的动画节奏参考（duration_hint），
 * 不是坑位长度；混用会让 clip 提前结束、颗粒突兀消失（2026-07-24 回声定位事故）。
 */
const slotEnvelope = (it: { track_st: number; track_ed: number }): number =>
	r3(it.track_ed - it.track_st);

/** 一个已就绪颗粒（命令侧已定位 HTML、lint、推导 opaque、复制进 assets/mg/）。 */
export interface MgLayItem {
	beat: string;
	composition_id: string;
	track_st: number;
	track_ed: number;
	/** 从颗粒 HTML 根 background 推导（非 dispatch.bg）：满屏盖底=true / 透明叠加=false */
	opaque: boolean;
	/** 相对 gtrk 目录的 .html 路径（assets/mg/<composition_id>.html） */
	html_rel: string;
	/** 品类子类型（裁决⑩，可选）：overlay/fullscreen…；供 opencut 色带分层 */
	category?: string;
}

export interface MgMetaBeat {
	beat: string;
	composition_id: string;
	track_st: number;
	track_ed: number;
	/** 落轨包络事实 = r3(track_ed − track_st)，**不是** dispatch 的 duration_hint。 */
	duration: number;
	html_path: string;
	category?: string;
	laid: { track_index: number } | null;
}
export interface StructMetaMg {
	contract_version: "v1";
	generated_at: string;
	lay_tracks: number[];
	beats: MgMetaBeat[];
}
export interface MgLayResult {
	next: Record<string, unknown>;
	/** laidParticles = **本次**新铺数（语义不变）；keptParticles = 从被剥轨原样搬运回来的既有颗粒数。 */
	summary: { laidTrack: number | null; laidParticles: number; keptParticles: number };
	mg: StructMetaMg;
}

type LooseClip = Record<string, unknown>;
interface LooseTrack {
	track_index?: number;
	track_timeline?: LooseClip[];
	[k: string]: unknown;
}
interface LooseMaterial {
	id?: unknown;
	[k: string]: unknown;
}
/** struct_meta 的某个登记键（mg / rrv）——只取本层用得到的两个字段，其余原样不碰。 */
type PrevMeta = { lay_tracks?: unknown; beats?: unknown } | undefined;

/** 从 struct_meta 某登记键抽 lay_tracks（宁留勿删；非数组/缺失=空）。 */
function layTracksOf(prev: PrevMeta): number[] {
	return Array.isArray(prev?.lay_tracks)
		? (prev!.lay_tracks as unknown[]).filter((x): x is number => typeof x === "number")
		: [];
}

/** 从 struct_meta 某登记键抽 beats（形状不对的条目直接忽略，宁少勿造）。 */
function beatsOf(prev: PrevMeta): MgMetaBeat[] {
	return Array.isArray(prev?.beats)
		? (prev!.beats as unknown[]).filter(
				(b): b is MgMetaBeat => !!b && typeof (b as MgMetaBeat).composition_id === "string",
			)
		: [];
}

/**
 * 从一条既有 beat_track clip 反查 composition_id —— 保留集**搬运时的定位键**。
 * 三级回退：`html_material` 去自产前缀（写侧恒 `mg-<composition_id>`、读旧 `rrv-`）→ `material`
 * （落轨时 = composition_id）→ `clip_id`（更老的档里 clip_id 曾是 beat id，聊胜于无）。
 */
function clipCompositionId(c: LooseClip): string | undefined {
	const hm = c.html_material;
	if (typeof hm === "string") {
		if (hm.startsWith(MG_MATERIAL_PREFIX)) return hm.slice(MG_MATERIAL_PREFIX.length);
		if (hm.startsWith(LEGACY_MATERIAL_PREFIX)) return hm.slice(LEGACY_MATERIAL_PREFIX.length);
	}
	if (typeof c.material === "string") return c.material;
	return typeof c.clip_id === "string" ? c.clip_id : undefined;
}

const stOf = (c: LooseClip): number => (typeof c.track_st === "number" ? c.track_st : 0);

/** 一条 clip 引用到的 materials id（两处：`material` 与 `html_material`）。 */
function collectClipRefs(c: LooseClip, into: Set<string>): void {
	for (const k of ["material", "html_material"] as const) {
		const v = c[k];
		if (typeof v === "string") into.add(v);
	}
}

/**
 * 收集**写回后仍存活**的 clip 对 materials 的全部引用（fix-mg-material-strip-key）。
 *
 * 泛化收集：顶层任何「元素带 `track_timeline` 的数组」都算一条轨道桶（video/audio/beat…），
 * 日后新增轨类型自动被罩住，不必再改这一处。
 * **MUST NOT 把本次新铺的 clip 算进来**——它们的素材由 `newMaterials` 新造，
 * 若把旧的同 id 条目当成「仍被引用」而留下，就会与新造那条并存成重复条目（正是本 change 要治的囤积）。
 */
function collectSurvivingRefs(doc: Record<string, unknown>, extraClips: LooseClip[]): Set<string> {
	const refs = new Set<string>();
	for (const bucket of Object.values(doc)) {
		if (!Array.isArray(bucket)) continue;
		for (const t of bucket as LooseTrack[]) {
			if (!t || !Array.isArray(t.track_timeline)) continue;
			for (const c of t.track_timeline) collectClipRefs(c, refs);
		}
	}
	for (const c of extraClips) collectClipRefs(c, refs);
	return refs;
}

/**
 * 铺轨主函数（纯函数，不做 IO）。items 为空 = 只剥旧自产物（清空 MG 轨）。
 */
export function layMgTracks(opts: {
	gtrk: Record<string, unknown>;
	items: MgLayItem[];
	generatedAt: string;
	/**
	 * 保留集（fix-mg-lay-strip-scope 阶段 A）= 本次剥离面**之外**、需**原样搬运**到新轨的既有颗粒 composition_id。
	 *
	 * **缺省不传 = 全量替换，输出与本 change 之前逐字节一致**——既有单测「幂等重铺剥旧」与「items 为空 = 清空
	 * MG 轨」固化的正是这条纯函数语义，MUST NOT 因阶段 A 而改红。该保留谁**由命令层判定**（判据见 mg.ts
	 * `laidCompositionIds` + orphans），本层不推断、不设守门。
	 */
	keep?: string[];
}): MgLayResult {
	const { gtrk, items, generatedAt } = opts;
	const beatTracks = [...((gtrk.beat_track as LooseTrack[] | undefined) ?? [])];
	const materials = [...((gtrk.materials as LooseMaterial[] | undefined) ?? [])];
	const structMeta = { ...((gtrk.struct_meta as Record<string, unknown> | undefined) ?? {}) };

	// ── 剥离自产物（幂等；登记缺失宁留勿删）；登记键读并集 mg ∪ rrv（读旧兼容）──
	const prevMg = structMeta.mg as PrevMeta;
	const prevRrv = structMeta.rrv as PrevMeta;
	const prevIndices = new Set<number>([...layTracksOf(prevMg), ...layTracksOf(prevRrv)]);
	const removedTracks = beatTracks.filter((t) => typeof t.track_index === "number" && prevIndices.has(t.track_index));
	const keptTracks = beatTracks.filter((t) => !(typeof t.track_index === "number" && prevIndices.has(t.track_index)));

	// ── 自产颗粒的 composition_id 全集（fix-mg-material-strip-key，素材身份判据之二的定语）─────
	// 三路取并集，都是**本层自己的账本**、与客户端改不改 id 无关：
	//   ① 上一轮登记 struct_meta.mg ∪ rrv 的 beats[].composition_id（主来源）；
	//   ② 被剥轨上 clip 反查（登记 beats 缺条时的兜底，如遗留档 beats:[] 但轨上有 clip）；
	//   ③ 本次 items（登记整个丢失时仍认得出自己刚要铺的那些）。
	// 用途：把「path 落在 assets/mg/ 下」这条身份信号**再收紧一格**——只有文件名恰好是账本里的
	// composition_id 才算自产物。用户往该目录塞的自有 html（文件名不在账本里）因此永远不进剥离面。
	const ownCompositionIds = new Set<string>([
		...beatsOf(prevMg).map((b) => b.composition_id),
		...beatsOf(prevRrv).map((b) => b.composition_id),
		...items.map((it) => it.composition_id),
	]);
	for (const t of removedTracks) {
		for (const c of t.track_timeline ?? []) {
			const cid = clipCompositionId(c);
			if (cid !== undefined) ownCompositionIds.add(cid);
		}
	}
	/**
	 * 一条 materials 条目是否为 **MG 自产物**（身份判据，双信号取并集，两条都是**写侧事实**）：
	 *   ① `id` 前缀 `mg-` / `rrv-`（CLI 写侧 id 形态）；
	 *   ② `path` = `assets/mg/<composition_id>.html`（读旧 `assets/rrv/`）且该 composition_id 在账本里
	 *      —— **客户端把 id 改写成 `html-<短码>` 之后唯一还认得出的信号**（真机 2026-07-26 实测形态）。
	 * 两条都不命中 = **判不准 → 一律当用户素材保留**（`broll-` / `ex-solid-` / 用户自加从不被命中）。
	 */
	const isOwnMaterial = (m: LooseMaterial): boolean => {
		if (typeof m.id === "string" && isOwnMaterialId(m.id)) return true;
		const cid = ownAssetCompositionId(m.path);
		return cid !== undefined && ownCompositionIds.has(cid);
	};

	// ── 保留集搬运（阶段 A）：按 composition_id 从**被剥轨**里捞回整条 clip，逐字段原样搬到新轨 ──
	// ★ ⑤ 2026-07-26 拍板「原样搬运」：MUST NOT 从 struct_meta.mg.beats 重建 —— MgMetaBeat 没有 opaque
	// 字段（透明叠加会被重建成满屏不透明、直接盖住 B-roll），且 clip 是权威事实、struct_meta 是派生登记，
	// 从派生物重建权威事实方向是反的。搬运顺带把用户在 opencut 的手调一起保住。
	const itemIds = new Set(items.map((it) => it.composition_id));
	// 同 id 同时在保留集与本次 items 里 → **本次自产为准**（重铺该颗 = 用新的），保留集让位。
	const keepIds = new Set((opts.keep ?? []).filter((id) => !itemIds.has(id)));
	const carriedClips: LooseClip[] = [];
	const carriedIds = new Set<string>();
	for (const t of removedTracks) {
		for (const c of t.track_timeline ?? []) {
			const cid = clipCompositionId(c);
			if (cid === undefined || !keepIds.has(cid) || carriedIds.has(cid)) continue;
			carriedIds.add(cid);
			carriedClips.push({ ...c }); // 浅拷贝即原样：opaque / html_material / track_st / duration 一字不改
			// 保留条目的素材条目**原样留在 materials 里**（不重建）：老工程的 rrv- 前缀素材因此原样存活。
			// 兑现方式 = 下面的「零引用才剥」——搬回来的 clip 仍引用着它，它就不会被剥（不必再单独记账）。
		}
	}

	// ── append：所有颗粒落一条新 beat_track（一对一、按时间不重叠，共用一轨）──
	const newMaterials: LooseMaterial[] = [];
	const clips: Record<string, unknown>[] = [];
	const metaBeats: MgMetaBeat[] = [];
	// 新 beat 轨序：max(9, 所有现存 track_index) + 1，保证 ≥10（beat_track 惯例）且不撞任何轨
	const allIndices = [
		...keptTracks,
		...((gtrk.video_track as LooseTrack[] | undefined) ?? []),
		...((gtrk.audio_track as LooseTrack[] | undefined) ?? []),
	].map((t) => (typeof t.track_index === "number" ? t.track_index : 0));
	const newIndex = Math.max(9, ...allIndices) + 1;

	for (const it of items) {
		// 铁律⑦：clip 寿命只由槽位包络决定，与 dispatch.mg[].duration 彻底解耦。
		// 包络非正数才跳过（旧实现判 it.duration，那正是「颗粒填不满坑位」的病根）。
		const envelope = slotEnvelope(it);
		if (!(envelope > 0)) {
			metaBeats.push({ ...toMetaBeat(it), laid: null });
			continue;
		}
		const materialId = `${MG_MATERIAL_PREFIX}${it.composition_id}`;
		newMaterials.push({ id: materialId, path: it.html_rel });
		clips.push({
			// clip_id 取 composition_id（非 beat）：一 beat 可派生主 + N 个 -aux<n> 颗粒，
			// 用 beat 会撞 clip_id；composition_id 全局唯一（add-aux-rrv-overlay-particle）。
			clip_id: it.composition_id,
			material: it.composition_id, // = data-composition-id
			html_material: materialId,
			opaque: it.opaque,
			track_st: it.track_st,
			duration: envelope,
		});
		metaBeats.push({ ...toMetaBeat(it), laid: { track_index: newIndex } });
	}

	// 保留 + 本次合并落**一条**新轨，按 track_st 升序（保留 clip 带的是上一轮时码，混排照常排序）
	const mergedClips = [...carriedClips, ...clips].sort((a, b) => stOf(a) - stOf(b));
	const createdTracks =
		mergedClips.length > 0 ? [{ track_index: newIndex, track_timeline: mergedClips }] : [];

	// ── 素材剥离（fix-mg-material-strip-key）：判据 = 「自产物」∧「写回后零引用」──────────────
	// **不再拿 clip.html_material 的前缀当剥离键**——那是**客户端可改写的**字段（真机实测：用户在 opencut
	// 编辑后 clip 的 `html_material` 被改写成 `html-<短码>`），前缀一旦对不上，旧素材就剥不掉、新的又 append，
	// 于是每过一轮「客户端编辑 → 重铺」就囤积一批重复 / 孤儿素材（2026-07-26 真机：42 条 mg- = 21 组重复 + 21 条 html- 孤儿）。
	// 改判「身份 + 引用」两问：**谁的**（isOwnMaterial：写侧 id 前缀 ∪ 写侧落点路径 × 自产 composition_id 账本）
	// 与**还有人用吗**（survivingRefs：写回后仍在轨上的 clip 才算引用，本次新铺的不算）。
	// 三条不变量：① 非自产（broll- / ex-solid- / 用户自加）**一条都不碰**；② 仍被存活 clip 引用的自产素材**不剥**
	// （保留集搬运、用户手加轨引用自产素材，都靠这条活下来）；③ 判不准（id 非字符串 / 路径认不出）**一律留**。
	const survivingRefs = collectSurvivingRefs({ ...gtrk, beat_track: keptTracks }, carriedClips);
	const newMaterialIds = new Set(newMaterials.map((m) => String(m.id)));
	const keptMaterials = materials.filter((m) => {
		if (typeof m.id !== "string") return true; // ③ 形状不对 = 判不准 → 留
		// 本次自产同 id 覆盖：旧条目让位给刚 push 的新条目，否则同 id 两条并存 = 重复囤积
		if (newMaterialIds.has(m.id)) return false;
		if (!isOwnMaterial(m)) return true; // ① 非自产零连带
		return survivingRefs.has(m.id); // ② 自产：仅当仍被存活 clip 引用才留
	});

	// 保留条目的登记：同样原样搬运（读并集 mg ∪ rrv），只把 laid.track_index 改写为新轨号——
	// 全部 MG clip 恒合并落一条新轨，旧轨号已不存在。
	const carriedBeats: MgMetaBeat[] = [];
	const seenCarriedBeat = new Set<string>();
	for (const b of [...beatsOf(prevMg), ...beatsOf(prevRrv)]) {
		if (!keepIds.has(b.composition_id) || seenCarriedBeat.has(b.composition_id)) continue;
		seenCarriedBeat.add(b.composition_id);
		// 登记说已铺、轨上却捞不到 clip（用户在客户端删过）→ 登记原样留着但 laid 降级 null，如实记「已产未铺」。
		// MUST NOT 凭登记凭空造一条 clip（同「clip 是权威事实」）。
		carriedBeats.push({ ...b, laid: carriedIds.has(b.composition_id) ? { track_index: newIndex } : null });
	}

	const mg: StructMetaMg = {
		contract_version: "v1",
		generated_at: generatedAt,
		lay_tracks: createdTracks.map((t) => t.track_index),
		beats: [...carriedBeats, ...metaBeats],
	};

	// 写 mg + delete 旧 rrv 键（防孤儿：既有工程升级后不留双份登记）
	const nextStructMeta: Record<string, unknown> = { ...structMeta, mg };
	delete nextStructMeta.rrv;

	const next: Record<string, unknown> = {
		...gtrk,
		materials: [...keptMaterials, ...newMaterials],
		beat_track: [...keptTracks, ...createdTracks],
		struct_meta: nextStructMeta,
	};
	return {
		next,
		summary: {
			laidTrack: createdTracks[0]?.track_index ?? null,
			laidParticles: clips.length, // 语义不变 = **本次**新铺数（MUST NOT 混进保留数）
			keptParticles: carriedClips.length,
		},
		mg,
	};
}

function toMetaBeat(it: MgLayItem): Omit<MgMetaBeat, "laid"> {
	return {
		beat: it.beat,
		composition_id: it.composition_id,
		track_st: it.track_st,
		track_ed: r3(it.track_ed),
		duration: slotEnvelope(it),
		html_path: it.html_rel,
		...(it.category ? { category: it.category } : {}),
	};
}
