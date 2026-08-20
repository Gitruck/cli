/**
 * 时间线投影器（纯函数）——把 transcript 的**源素材时基**投影到当刻 `.gtrk` 的**轨道时基**。
 *
 * 契约（timeline-projection spec）：
 *   - 只扫**投影主轨**（口径见 `collectProjectionClips`）；只认 `material === transcript.material_id` 的 clip；
 *     overlay 轨与非命中 material 的 clip 不参与。
 *   - 以 word 为最小单元：word 区间 `[st,ed]` 与 `[clip_st,clip_ed]` 相交 → 映射
 *     `track_t = track_st + (t - clip_st)`（越界部分按 clip 边界夹逼，保证落在 `[track_st,track_ed]` 内）。
 *   - utterance 投影 = 其存活 words 的包络；无任何 word 存活 = dropped。
 *   - 同一 utterance 被多个 clip 覆盖（用户复制片段 / 中途切断）→ 产多个投影实例，按 `track_st` 排序全部列出。
 *   - 「拖入已剪好成片」= 单 clip 全长恒等引用 → 逐字相等（恒等投影）。
 *
 * 纯函数：同 (transcript, gtrk) 恒同视图（`projected_at` 可注入以保证可复现）。字级明细缺省不出，`words` 开启。
 *
 * ★「主轨」是个被过载的词——本仓有三个，答的是**不同问题**，MUST NOT 合并
 * （fix-projection-main-track-black-bed design D4；同家族「最小号=主轨」盲区已反复出现五次）：
 *
 * | 问题 | 实现 | 旅拍工程（配音驱动 + 铺过 B-roll）上的正解 |
 * |---|---|---|
 * | 口播在哪条轨？（投影） | 本文件 `collectProjectionClips` | `audio_track[0]`（TTS 配音） |
 * | 渲哪条画面轨？（渲染快照） | `render.ts` `pickPreviewMainTrack` | `video_track[1]`（B-roll 轨） |
 * | 扫哪条轨的拼接切点？（QC） | `qc.ts` `boundariesFromGtrk` | `video_track[1]` |
 *
 * 三者今天各自正确。改本文件的口径时 **MUST NOT** 顺手去「统一」另外两处。
 */

export interface TranscriptWord {
	w: string;
	st: number;
	ed: number;
}

export interface TranscriptUtterance {
	id: string;
	st: number;
	ed: number;
	text: string;
	kept?: boolean;
	words: TranscriptWord[];
}

export interface Transcript {
	version?: string;
	source?: string;
	script_source?: string;
	material_id: string;
	text_hash: string;
	duration?: number;
	utterances: TranscriptUtterance[];
}

/** gtrk clip（投影只用时码字段；其余键随工程透传、投影不读）。 */
export interface GtrkClip {
	clip_id?: string;
	material?: string | number | null;
	clip_st?: number;
	clip_ed?: number;
	track_st?: number;
	track_ed?: number;
	duration?: number;
}

export interface GtrkTrack {
	track_index?: number;
	track_timeline?: GtrkClip[];
}

export interface GtrkProject {
	version?: string;
	video_track?: GtrkTrack[];
	audio_track?: GtrkTrack[];
	[k: string]: unknown;
}

export interface ViewWord {
	w: string;
	track_st: number;
	track_ed: number;
}

export interface ViewUtterance {
	id: string;
	text: string;
	/** 轨道时基入点（秒）；dropped 时为 null。 */
	track_st: number | null;
	/** 轨道时基出点（秒）；dropped 时为 null。 */
	track_ed: number | null;
	dropped: boolean;
	kept_words: number;
	total_words: number;
	/** 字级明细（仅 `words:true` 时出现）。 */
	words?: ViewWord[];
}

export interface ProjectionView {
	transcript_hash: string;
	projected_at: string;
	utterances: ViewUtterance[];
}

/** 3 位小数（对齐 transcript / gtrk 秒值精度），消除浮点尾差。 */
function r3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

/** 归一化 clip 时码：缺 clip_ed/track_ed 时由 clip_st/track_st + duration 推。 */
function normClip(c: GtrkClip): { clip_st: number; clip_ed: number; track_st: number } {
	const clip_st = c.clip_st ?? 0;
	const track_st = c.track_st ?? 0;
	const dur = c.duration ?? (c.clip_ed != null ? c.clip_ed - clip_st : 0);
	const clip_ed = c.clip_ed ?? clip_st + dur;
	return { clip_st, clip_ed, track_st };
}

/** track_index 最小的一条（缺 track_index 视作 0）；空列表 → undefined。 */
function pickLowestIndexTrack(tracks: GtrkTrack[]): GtrkTrack | undefined {
	if (!tracks.length) return undefined;
	let best = tracks[0];
	let bestIdx = best.track_index ?? 0;
	for (const t of tracks) {
		const idx = t.track_index ?? 0;
		if (idx < bestIdx) {
			best = t;
			bestIdx = idx;
		}
	}
	return best;
}

/**
 * 纯色垫片素材 id（与客户端 `SOLID_ID_RE` / 本仓 `solid-png.ts` 同一口径）。
 *
 * ⚠️ 射程**只到**「这条 clip 不承载口播、不能拿来投影」。契约 composition-contract-v1 §6.1 明文：
 * 判断「这条轨是不是 CLI **自产**黑底」MUST 以 `struct_meta.broll.black_track` 为准，
 * **不得靠扫 `ex-solid-` 素材反推**（反推会把用户手加的垫片误判成自产物、重铺时误删）。
 * 故本正则 **MUST NOT** 被任何剥离 / 删除 / 改写路径复用。
 */
const SOLID_MATERIAL_RE = /^ex-solid-[0-9a-f]{6}-[1-9][0-9]*x[1-9][0-9]*$/;

/**
 * CLI 自产 B-roll 候选片的素材前缀（同上，射程只到「不承载口播」）。
 *
 * 正本常量：`matrix-lay.ts` 的 `BROLL_MATERIAL_PREFIX` / `solid-png.ts` 的 `SOLID_MATERIAL_PREFIX`
 * （那里的定义是「自产素材 = `broll-` 前缀（候选片）∪ `ex-solid-` 前缀（黑底垫片）」）。
 * 本文件是**零依赖纯叶子**（投影不碰 IO、不 import 重模块），故按字面复制一份，
 * 由 `projection.test.mjs` 的一条对拍用例锁住两边不漂移。
 */
const BROLL_MATERIAL_PREFIX = "broll-";

/** 旁证用的自产素材命名空间（导出仅供对拍测试锁定，别在别处当业务判据用）。 */
export const SELF_LAID_MATERIAL_PREFIXES = ["ex-solid-", BROLL_MATERIAL_PREFIX] as const;

/**
 * 自产轨登记（`struct_meta.broll`）：`lay_tracks` = 候选轨 ∪ 黑底垫轨，`black_track` 单列。
 * 缺键按空兜底，**MUST NOT 把缺键当成 `track_index = 0`**（契约明文；0 号常常正是口播主轨）。
 */
function laidTrackRegistry(gtrk: GtrkProject): { laid: Set<number>; black: number | null } {
	const broll = (gtrk.struct_meta as { broll?: { lay_tracks?: unknown; black_track?: unknown } } | undefined)?.broll;
	const laid = new Set<number>();
	for (const v of Array.isArray(broll?.lay_tracks) ? (broll.lay_tracks as unknown[]) : []) {
		if (typeof v === "number" && Number.isFinite(v)) laid.add(v);
	}
	const black = typeof broll?.black_track === "number" ? broll.black_track : null;
	if (black != null) laid.add(black);
	return { laid, black };
}

/**
 * 该轨的全部 clip 都是 CLI 自产素材（纯色垫片 / B-roll 候选片）⇒ 该轨不承载口播。
 * 空轨不算（空轨走「主轨没有可投影 clip」的常规回退）；只要有一条非自产 clip 就 **MUST NOT** 认定
 * （契约 §6.1 的真机反例：黑片与用户 import clip 混在同一轨——宁可不认，不放水）。
 */
function isSelfLaidTrackByMaterial(t: GtrkTrack): boolean {
	const tl = t.track_timeline ?? [];
	if (!tl.length) return false;
	return tl.every((c) => {
		if (c.material == null) return false;
		const m = String(c.material);
		return SOLID_MATERIAL_RE.test(m) || m.startsWith(BROLL_MATERIAL_PREFIX);
	});
}

/** 投影源桶。 */
export type ProjectionSource = "video" | "audio" | "none";

/** 被排除在主轨候选之外的 video 轨及原因。 */
export interface SkippedTrack {
	track_index: number;
	why: "black_bed" | "self_laid" | "self_laid_guess";
}

export interface ProjectionClips {
	clips: GtrkClip[];
	source: ProjectionSource;
	/** 选中轨的 track_index（audio 回退时 = 有 clip 的最小号 audio 轨）；无可用主轨时 null。 */
	track_index: number | null;
	skipped: SkippedTrack[];
}

/**
 * 取投影候选 clips（**唯一口径**；与客户端 `subtitle-actions.ts` 的同名函数是同一条规则）：
 *
 * > **投影主轨 = 承载口播的那条轨**：先看 `video_track` 里最小号的**非 CLI 自产轨**
 * > （自产 = `struct_meta.broll.lay_tracks` 登记的 B-roll 候选轨与黑底垫轨）；
 * > **它不存在、或它上面没有可投影的 clip → 回退扫全部 `audio_track`**。
 *
 * 客户端那半句同形：main 轨没有 video 元素（黑片是 image 元素、天然不计）→ 回退扫 audio 轨。
 *
 * 判据修正史（每收一次都是被真机拍出来的）：
 *   - add-audio-project-atoms：`video_track` **为空**才回退——配音驱动工程起盘态成立；
 *   - fix-projection-main-track-black-bed：`gtrk matrix` 给这类工程铺黑底垫轨后 `video_track` 非空，
 *     且按 fix-broll-zorder-contract-drift 的层序黑底**恒取最小号** ⇒ 旧判据选中纯黑轨、与
 *     `material_id` 零命中（真机 27/27 句误判 dropped）。故判据改成「**主轨上有没有可投影的 clip**」。
 *   - 同件：只剔黑片不够——`--no-black-bed` 时最小号是 B-roll **候选轨**（真实素材、同样不承载口播），
 *     所以判据认的是「非自产轨」而不是「非黑片」。
 *
 * 回退扫**全部** audio 轨（而非最小号那条）：口播配音轨未必最小号（`gtrk audio lay` 的 BGM 落最大号 +1，
 * 但用户删轨重排后顺序会翻）；投影本就按 `material_id` 过滤，BGM / 音效轨天然不参与。
 */
export function collectProjectionClips(gtrk: GtrkProject): ProjectionClips {
	const { laid, black } = laidTrackRegistry(gtrk);
	const skipped: SkippedTrack[] = [];
	const candidates: GtrkTrack[] = [];
	for (const t of gtrk.video_track ?? []) {
		const idx = t.track_index ?? 0;
		if (laid.has(idx)) {
			skipped.push({ track_index: idx, why: idx === black ? "black_bed" : "self_laid" });
			continue;
		}
		// 旁证只在**登记整体缺席**时启用（0.2.14 前存量档 / 经后端 video_project_struct 往返被裁 / 手工垫轨）。
		// ★ 真机 5.3 订正：旁证不能只认纯色垫片——真机工程是「黑底 0 + B-roll 候选 1」两条轨，
		//   只剔黑片会让 B-roll 候选轨（54 条真实素材 clip）顶上来当主轨，照样零命中。
		if (laid.size === 0 && isSelfLaidTrackByMaterial(t)) {
			skipped.push({ track_index: idx, why: "self_laid_guess" });
			continue;
		}
		candidates.push(t);
	}
	const main = pickLowestIndexTrack(candidates);
	const mainClips = main?.track_timeline ?? [];
	if (mainClips.length) {
		return { clips: [...mainClips], source: "video", track_index: main?.track_index ?? 0, skipped };
	}
	const audioTracks = (gtrk.audio_track ?? []).filter((t) => (t.track_timeline ?? []).length > 0);
	if (audioTracks.length) {
		return {
			clips: audioTracks.flatMap((t) => t.track_timeline ?? []),
			source: "audio",
			track_index: pickLowestIndexTrack(audioTracks)?.track_index ?? 0,
			skipped,
		};
	}
	return { clips: [], source: "none", track_index: null, skipped };
}

/** 逐轨命中明细（诊断用）。 */
export interface TrackMatchDetail {
	bucket: "video" | "audio";
	track_index: number;
	clips: number;
	matched: number;
	skipped?: SkippedTrack["why"];
}

/** 投影源诊断（人读 + 机读同源；`gtrk split` 与消费侧重投影**共用这一份话术**，别写两遍）。 */
export interface ProjectionSourceReport {
	source: ProjectionSource;
	track_index: number | null;
	material_id: string;
	total_clips: number;
	matched_clips: number;
	skipped: SkippedTrack[];
	tracks: TrackMatchDetail[];
	/** 人读诊断（多行，行首已带 `· `）。 */
	text: string;
	/** 可直接照做的复原路径。 */
	hint: string;
}

/** 「主轨零命中口播素材」的复原路径（**唯一一份**：投影诊断与消费侧降级告警共用，别写两遍）。 */
export const PROJECTION_SOURCE_HINT =
	"复原：① 配音驱动工程的口播在 audio 轨——确认配音轨还在、其 material 与 transcript.material_id 一致；" +
	"② 铺过 B-roll / 黑底垫轨的工程，确认 .gtrk 的 struct_meta.broll 登记还在" +
	"（经后端 video_project_struct 往返会被裁掉）；③ 拿另一个工程的 transcript / dispatch 来跑也会命中本情形。";

const SKIP_TEXT: Record<SkippedTrack["why"], string> = {
	black_bed: "CLI 自产黑底垫轨（struct_meta.broll.black_track 登记）",
	self_laid: "CLI 自产 B-roll 候选轨（struct_meta.broll.lay_tracks 登记）",
	self_laid_guess: "疑似 CLI 自产轨（全轨都是 ex-solid-* / broll-* 素材；struct_meta.broll 无登记）",
};

/**
 * 投影源诊断：**选中了哪条轨、为什么跳过别的轨、各轨命中几条**。
 *
 * 立题（fix-projection-main-track-black-bed）：主轨零命中时 `projectTranscript` 只会把所有 utterance
 * 判 dropped，与「整段真被剪光」在视图里**同形**；而降级告警若只列举「口播主轨被删 / relink 换了 id」，
 * 会把用户支去排查一个不存在的问题——真因可能是 CLI 自己铺的垫轨。故诊断 MUST 指向真因。
 */
export function describeProjectionSource(gtrk: GtrkProject, materialId: string): ProjectionSourceReport {
	const id = String(materialId);
	const picked = collectProjectionClips(gtrk);
	const skipWhy = new Map(picked.skipped.map((s) => [s.track_index, s.why]));
	const matchedIn = (t: GtrkTrack) =>
		(t.track_timeline ?? []).filter((c) => c.material != null && String(c.material) === id).length;

	const tracks: TrackMatchDetail[] = [];
	for (const t of gtrk.video_track ?? []) {
		const idx = t.track_index ?? 0;
		tracks.push({
			bucket: "video",
			track_index: idx,
			clips: (t.track_timeline ?? []).length,
			matched: matchedIn(t),
			...(skipWhy.has(idx) ? { skipped: skipWhy.get(idx) } : {}),
		});
	}
	for (const t of gtrk.audio_track ?? []) {
		tracks.push({
			bucket: "audio",
			track_index: t.track_index ?? 0,
			clips: (t.track_timeline ?? []).length,
			matched: matchedIn(t),
		});
	}
	const matched = picked.clips.filter((c) => c.material != null && String(c.material) === id).length;

	const audioWithClips = (gtrk.audio_track ?? []).filter((t) => (t.track_timeline ?? []).length > 0).length;
	const where =
		picked.source === "none"
			? "无可用主轨（video / audio 轨上都没有 clip）"
			: picked.source === "video"
				? `video 轨 #${picked.track_index}`
				: `audio 轨（回退扫全部 ${audioWithClips} 条，最小号 #${picked.track_index}）`;
	const lines = [`· 选中的投影主轨：${where}——命中口播素材（material_id=${id}）${matched} 条 clip`];
	if (picked.skipped.length) {
		lines.push(`· 跳过的 video 轨：${picked.skipped.map((s) => `#${s.track_index}（${SKIP_TEXT[s.why]}）`).join("、")}`);
	}
	if (tracks.length) {
		lines.push(`· 各轨命中/总数：${tracks.map((t) => `${t.bucket}#${t.track_index} ${t.matched}/${t.clips}`).join(" · ")}`);
	}

	return {
		source: picked.source,
		track_index: picked.track_index,
		material_id: id,
		total_clips: picked.clips.length,
		matched_clips: matched,
		skipped: picked.skipped,
		tracks,
		text: lines.join("\n"),
		hint: PROJECTION_SOURCE_HINT,
	};
}

/**
 * 主轨上命中该 material_id 的 clip 条数（只读判据，add-consume-side-reprojection）。
 *
 * **投影算法零改动**：本函数不投影、不读 transcript，只复用同一个「谁是主轨」口径
 * （`collectProjectionClips`）回答一个判据问题——消费侧重投影的降级矩阵里
 * 「当刻主轨查不到命中 `material_id` 的 clip」需要它，而 `projectTranscript` 在这种情形下
 * 只会把所有 utterance 判 dropped，与「整段都被剪掉」不可分辨。
 *
 * 之所以放在本文件而不是复制进重投影叶子：主轨口径一旦两处各写一遍就会分叉，
 * 而「口径同源」正是消费侧重投影这条路线的立身之本。
 */
export function countMainTrackMaterialClips(gtrk: GtrkProject, materialId: string): number {
	const id = String(materialId);
	return collectProjectionClips(gtrk).clips.filter((c) => c.material != null && String(c.material) === id).length;
}

interface Instance {
	track_st: number;
	track_ed: number;
	kept_words: number;
	words: ViewWord[];
}

interface Entry {
	id: string;
	text: string;
	dropped: boolean;
	sourceIndex: number;
	instIndex: number;
	track_st: number | null;
	track_ed: number | null;
	kept_words: number;
	total_words: number;
	words: ViewWord[];
	sortKey: number;
}

/**
 * 把 transcript 投影到 gtrk 的轨道时基，产句级视图。
 * @param opts.words 是否附字级明细；opts.projectedAt 注入时间戳（缺省 now，供测试可复现）。
 */
export function projectTranscript(
	transcript: Transcript,
	gtrk: GtrkProject,
	opts: { words?: boolean; projectedAt?: string } = {},
): ProjectionView {
	const materialId = String(transcript.material_id);
	const clips = collectProjectionClips(gtrk)
		.clips.filter((c) => c.material != null && String(c.material) === materialId)
		.map(normClip);

	const entries: Entry[] = [];
	transcript.utterances.forEach((utt, sourceIndex) => {
		const totalWords = utt.words?.length ?? 0;
		const instances: Instance[] = [];
		for (const clip of clips) {
			const surviving: ViewWord[] = [];
			for (const word of utt.words ?? []) {
				// 与 clip 源区间夹逼后相交（严格重叠，零长不算存活）
				const s = Math.max(word.st, clip.clip_st);
				const e = Math.min(word.ed, clip.clip_ed);
				if (e > s) {
					surviving.push({
						w: word.w,
						track_st: r3(clip.track_st + (s - clip.clip_st)),
						track_ed: r3(clip.track_st + (e - clip.clip_st)),
					});
				}
			}
			if (surviving.length) {
				instances.push({
					track_st: Math.min(...surviving.map((x) => x.track_st)),
					track_ed: Math.max(...surviving.map((x) => x.track_ed)),
					kept_words: surviving.length,
					words: surviving,
				});
			} else if (totalWords === 0) {
				// 无词级时码的 transcript（TTS 产物 words 恒空，add-audio-project-atoms）：
				// 按句级时码 [st, ed] 与 clip 源区间夹逼判存活——否则空词循环把整句误判 dropped。
				// kept_words 保持 0（total_words 亦 0，语义如实：无词级明细，句级在轨）。
				const s = Math.max(utt.st, clip.clip_st);
				const e = Math.min(utt.ed, clip.clip_ed);
				if (e > s) {
					instances.push({
						track_st: r3(clip.track_st + (s - clip.clip_st)),
						track_ed: r3(clip.track_st + (e - clip.clip_st)),
						kept_words: 0,
						words: [],
					});
				}
			}
		}
		if (!instances.length) {
			entries.push({
				id: utt.id,
				text: utt.text,
				dropped: true,
				sourceIndex,
				instIndex: 0,
				track_st: null,
				track_ed: null,
				kept_words: 0,
				total_words: totalWords,
				words: [],
				sortKey: 0,
			});
		} else {
			instances.sort((a, b) => a.track_st - b.track_st);
			instances.forEach((inst, instIndex) => {
				entries.push({
					id: utt.id,
					text: utt.text,
					dropped: false,
					sourceIndex,
					instIndex,
					track_st: inst.track_st,
					track_ed: inst.track_ed,
					kept_words: inst.kept_words,
					total_words: totalWords,
					words: inst.words,
					sortKey: inst.track_st,
				});
			});
		}
	});

	// 排序：存活条目按 track_st；dropped 条目按源序插位（挂到前序存活内容之后）。
	let maxEd = 0;
	for (const e of entries) {
		if (e.dropped) e.sortKey = maxEd;
		else maxEd = Math.max(maxEd, e.track_ed ?? maxEd);
	}
	entries.sort(
		(a, b) => a.sortKey - b.sortKey || a.sourceIndex - b.sourceIndex || a.instIndex - b.instIndex,
	);

	const utterances: ViewUtterance[] = entries.map((e) => {
		const u: ViewUtterance = {
			id: e.id,
			text: e.text,
			track_st: e.track_st,
			track_ed: e.track_ed,
			dropped: e.dropped,
			kept_words: e.kept_words,
			total_words: e.total_words,
		};
		if (opts.words) u.words = e.words;
		return u;
	});

	return {
		transcript_hash: transcript.text_hash,
		projected_at: opts.projectedAt ?? new Date().toISOString(),
		utterances,
	};
}
