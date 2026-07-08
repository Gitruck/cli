/**
 * 时间线投影器（纯函数）——把 transcript 的**源素材时基**投影到当刻 `.gtrk` 的**轨道时基**。
 *
 * 契约（timeline-projection spec）：
 *   - 只扫 `track_index` 最小的 main video_track；只认 `material === transcript.material_id` 的 clip；
 *     overlay 轨与非命中 material 的 clip 不参与。
 *   - 以 word 为最小单元：word 区间 `[st,ed]` 与 `[clip_st,clip_ed]` 相交 → 映射
 *     `track_t = track_st + (t - clip_st)`（越界部分按 clip 边界夹逼，保证落在 `[track_st,track_ed]` 内）。
 *   - utterance 投影 = 其存活 words 的包络；无任何 word 存活 = dropped。
 *   - 同一 utterance 被多个 clip 覆盖（用户复制片段 / 中途切断）→ 产多个投影实例，按 `track_st` 排序全部列出。
 *   - 「拖入已剪好成片」= 单 clip 全长恒等引用 → 逐字相等（恒等投影）。
 *
 * 纯函数：同 (transcript, gtrk) 恒同视图（`projected_at` 可注入以保证可复现）。字级明细缺省不出，`words` 开启。
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

/** 取 main 底轨 = `track_index` 最小的 video_track（缺 track_index 视作 0）。无 video_track → undefined。 */
function pickMainVideoTrack(gtrk: GtrkProject): GtrkTrack | undefined {
	const tracks = gtrk.video_track ?? [];
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
	const mainTrack = pickMainVideoTrack(gtrk);
	const clips = (mainTrack?.track_timeline ?? [])
		.filter((c) => c.material != null && String(c.material) === materialId)
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
