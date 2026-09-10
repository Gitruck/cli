/**
 * 本地渲染：gtrk v1（EDL）→ ffmpeg filter_complex → 成片 mp4。
 *
 * 忠实移植后端 `video_timeline_render.build_filter_graph` 语义（视频 trim+setpts+fps+scale+pad+setsar+
 * format+concat；音频 atrim+asetpts+aresample+aformat+afade+concat/amix；libx264 -preset medium -crf 18
 * -c:a aac -b:a 192k -movflags +faststart）。material 输入取 gtrk materials[].path（= source_path，
 * 客户端原片本地绝对路径）；云端不产成片，成片在此本地出。
 *
 * 音源覆盖面（★ fix-render-bundled-clip-audio，2026-09-04 真机事故修）：混音取**两类** lane——
 * lane A = 全部 `video_track` 的 clip 内嵌音轨（口播人声正是跟着视频素材走的；此前从不遍历，
 * 成片实测 −70.0 LUFS 数字静音），lane B = 既有 `audio_track`。lane A 的取用判据
 * （`track.muted` / `clip.muted` / `element_state.isSourceAudioEnabled`）与客户端同一套，
 * 收口母带与客户端同口径。
 *
 * 视觉覆盖面（★ add-render-overlay-compositing，2026-09-09）：底轨 `concat` 之后**逐层叠加**
 * 全部**可见**叠加层——非主 `video_track`（B-roll 候选 / AI 再现）与 `beat_track`（MG 颗粒）。
 * 层序按 `track_index` 升序（契约 z 序：最小=底轨 main，越大越靠前），可见性只读轨级 `hidden`
 * 字段，MUST NOT 按轨序/车道名自行猜——与音频侧「只认 `muted`」是同一条纪律。
 * 颗粒像素权威在服务端 Hyperframes：CLI 经 `html_render_simple` 取回 qtrle alpha MOV 再叠
 * （编排与跨端缓存在 `particle-qtrle.ts`，本模块**只消费路径不编排**）。
 *
 * 验收口径：观感等价（时长/切点/画布/音画同步/编码参数一致），不承诺与云端逐字节一致（libx264 跨版本/平台）。
 * 对拍分两段（add-render-overlay-compositing D4）：**底轨 + 音频链**与后端
 * `video_timeline_render.build_filter_graph` 逐文本对拍；**叠加层段是 CLI 独有扩展**，
 * 后端那条链结构性不合成叠加层（明文「只渲 track_index 最小的一条 video_track」「beat_track 忽略」），
 * **不存在**可对拍的后端向量 ⇒ MUST NOT 声称同源，改以 CLI 自有黄金向量对拍。
 */
import { writeFile, unlink, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { requireFfmpeg, runFfmpeg, ffprobeJson } from "./ffmpeg";
import { videoRateOf } from "./gtrk-patch";
import { ms2sec, sec2frame, sec2ms } from "./frame-domain";
import { log } from "./log";

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_LAYOUT = "stereo";
const DEFAULT_CRF = 18;
const DEFAULT_AUDIO_CROSSFADE_MS = 8;
const MAX_CLIPS = 500;
/** 母带收口（★ fix-render-bundled-clip-audio；口径原样取自客户端
 *  `gitruck-opencut-rewrite/.../audio-mastering.ts:1-6`——CLI 与客户端出同一工程须同响度，
 *  两套母带口径会让同一工程出两种听感）：−1 dBFS 限幅 + 2% 余量的总音量。
 *  施加在 `amix` **之后**；`amix` 的 `normalize=0`（fix-render-audio-volume 成果）MUST 保持。 */
const MASTER_CHAIN = "alimiter=limit=0.891:attack=1:release=120,volume=0.98";
/** 帧对齐补齐余量（帧，fix-render-frame-drift）：截到裁定帧数前先备出的富余帧数。
 * 2 帧足够覆盖 `fps` 出帧数随 trim 起点相位的 ±1 摆动；富余帧够用时被 end_frame 原样截掉。 */
const PAD_FRAMES = 2;

/** Python %g 近似：6 位有效数字并去尾零（fps 格式化对齐后端）。 */
const g = (n: number): string => String(Number(n.toPrecision(6)));
const f6 = (n: number): string => n.toFixed(6);
const f3 = (n: number): string => n.toFixed(3);

interface Clip {
	material?: string | number | null;
	clip_st?: number;
	track_st: number;
	duration: number;
	/** clip 级音量（契约双层语义：覆盖轨级；★ fix-render-audio-volume——此前渲染混音全然不消费）。 */
	volume?: number;
	/** clip 级静音（契约既有字段，`gtrk patch set --muted` 写的就是它；
	 *  ★ fix-render-bundled-clip-audio——CLI 首次消费）。 */
	muted?: boolean;
	/** 客户端元素状态。`isSourceAudioEnabled === false` = 用户在客户端关掉了这条 clip 的**源声**
	 *  （与 `muted` 是两个开关，任一为关即不发声）。缺省（缺键/undefined）视为「开」。 */
	element_state?: { isSourceAudioEnabled?: boolean };
}
interface Track {
	track_index?: number;
	track_timeline: Clip[];
	/** 轨级默认音量（契约：clip 级缺省时生效）。 */
	volume?: number;
	/** 轨级静音（客户端喇叭图标；`gtrk matrix` / `gtrk mg` 落 B-roll、颗粒、黑底垫轨时恒写 true）。
	 *  ★ fix-render-bundled-clip-audio——CLI 首次消费；渲染器**只认这个字段**，
	 *  MUST NOT 按轨序/车道名自行猜某条轨该不该发声。 */
	muted?: boolean;
	/** 轨级隐藏（客户端「小眼睛」，opencut change `add-gtrk-track-hidden` 稀疏写：只在 true 时写键）。
	 *  ★ add-render-overlay-compositing——CLI 首次消费，**只作用于视觉叠加面**。
	 *  🔴 严格布尔：非布尔值 MUST 按键缺席处理（视为可见），MUST NOT 报错——`.gtrk` 是外部可写的
	 *  不可信输入，与契约里 `hidden`「严格布尔、非法即当缺席」同一口径。
	 *  ⚠️ **不动音频面**：lane A 的取用判据仍只认 `muted` 三件套（隐藏 ≠ 静音，客户端小眼睛与喇叭
	 *  是两个开关）。把 hidden 接进混音是另一次裁定，本件 MUST NOT 顺手改。 */
	hidden?: boolean;
}

/** `beat_track` 的一颗颗粒（契约：**整段播、无源裁剪**，MUST NOT 含 clip_st/clip_ed）。 */
interface Beat {
	clip_id?: string;
	/** ⚠️ = 颗粒 composition-id，**不是**素材引用键。MUST NOT 拿它去 materials 查表。 */
	material?: unknown;
	html_material?: unknown;
	/** 全屏不透明标注。qtrle 产物里 opaque 的透明区**仍然透明**（服务端 opaque_cover 对
	 *  webm/qtrle 生产链恒 False），故满屏盖底由本渲染器补黑背板兑现。 */
	opaque?: boolean;
	track_st?: unknown;
	track_ed?: unknown;
	duration?: unknown;
}
interface BeatTrack {
	track_index?: number;
	track_timeline?: Beat[];
	hidden?: boolean;
}
interface GtrkMaterial {
	id: string | number;
	path?: string;
}
export interface GtrkV1 {
	video_size: [number, number];
	video_rate: number;
	materials?: GtrkMaterial[];
	video_track?: Track[];
	audio_track?: Track[];
	/** HTML 颗粒叠加层（★ add-render-overlay-compositing——CLI 渲染器首次消费）。 */
	beat_track?: BeatTrack[];
	struct_meta?: { broll?: { black_track?: number | null } };
}

/** 快照预览的主轨选择：track_index 最小的**非黑底垫轨**。
 * ★ fix-broll-zorder-contract-drift 连锁：层序修正后黑底=最小号（契约底层），
 * 原「sortedV[0]=主轨」会渲出纯黑垫轨。黑底判据=struct_meta.broll.black_track 登记
 * （契约字段；缺键 ?? null 兜底，MUST NOT 当 0——composition-contract-v1 §broll 明文）。 */
function pickPreviewMainTrack(gtrk: GtrkV1, sortedV: Track[]): Track {
	const black = gtrk.struct_meta?.broll?.black_track ?? null;
	if (typeof black === "number") {
		const nonBlack = sortedV.filter((t) => t.track_index !== black);
		if (nonBlack.length > 0) return nonBlack[0];
	}
	return sortedV[0];
}

/** 轨是否可见（★ add-render-overlay-compositing）。严格布尔：只有字面 `true` 才算隐藏。 */
const isHiddenTrack = (t: { hidden?: unknown }): boolean => t.hidden === true;

/** 一层待叠加的视觉元素（overlay `video_track` 的 clip，或 `beat_track` 的颗粒）。 */
export type OverlayLayer =
	| {
			kind: "clip";
			trackIndex: number;
			trackSt: number;
			duration: number;
			material: string | number;
			clipSt: number;
	  }
	| {
			kind: "particle";
			trackIndex: number;
			trackSt: number;
			duration: number;
			clipId: string;
			opaque: boolean;
	  };

/**
 * 收集**全部可见叠加层**并定序（★ add-render-overlay-compositing，纯函数，导出供单测与黄金向量）。
 *
 * **层序即契约**（infra `gtrk-contract`：`track_index` 最小者为底轨 main，越大越靠前）：
 * 按 `track_index` **升序**由底向上叠。MUST NOT 按数组下标、车道名、素材前缀自行判定层序。
 * ⚠️ 仓内有两处**过时注释**说反了（`src/lib/matrix-lay.ts:3955-3956` 写「黑底=最大号/越大越靠下」，
 * 其正下方代码却是 `blackTrack = baseIndex` 最小号——`fix-broll-zorder-contract-drift` 改过、注释没跟）。
 * 以契约与该文件 `:278` / `:3562` 的现行口径为准。
 *
 * **可见性只读 `hidden` 字段**：`hidden === true` 的轨整条跳过。渲染器 MUST NOT 因为
 * 「它是候选轨 / 它是第几条」自行决定叠不叠——与既有铁律「叠加轨默认不发声由铺轨方经 `muted`
 * 表达，MUST NOT 由渲染器另行猜测」是同一条纪律的视觉侧对应物。
 *
 * `video_track` 与 `beat_track` 共用同一个 `track_index` z 空间（`mg-lay` 落轨时取
 * `max(9, 全部 video/audio/beat 轨号) + 1`，构造上不撞号）。真撞号时**视频在下、颗粒在上**——
 * 颗粒是成片 SOP 的最后一层（⑤ 最后叠上），这个 tie-break 与制片定序一致。
 */
export function collectOverlayLayers(
	gtrk: GtrkV1,
	mainVideoTrack: Track,
): { layers: OverlayLayer[]; hiddenSkipped: number } {
	const layers: OverlayLayer[] = [];
	let hiddenSkipped = 0;

	for (const t of gtrk.video_track || []) {
		if (t === mainVideoTrack) continue;
		if (isHiddenTrack(t)) {
			hiddenSkipped++;
			continue;
		}
		const ti = typeof t.track_index === "number" ? t.track_index : 0;
		for (const c of t.track_timeline || []) {
			if (isGap(c)) continue;
			const duration = Number(c.duration);
			if (!(duration > 0)) continue;
			layers.push({
				kind: "clip",
				trackIndex: ti,
				trackSt: Number(c.track_st),
				duration,
				material: c.material as string | number,
				clipSt: Number(c.clip_st) || 0,
			});
		}
	}

	for (const t of gtrk.beat_track || []) {
		if (isHiddenTrack(t)) {
			hiddenSkipped++;
			continue;
		}
		const ti = typeof t.track_index === "number" ? t.track_index : 0;
		for (const b of t.track_timeline || []) {
			const trackSt = Number(b.track_st);
			const duration = Number(b.duration) || Number(b.track_ed) - trackSt;
			if (!Number.isFinite(trackSt) || !(duration > 0)) continue;
			const clipId = typeof b.clip_id === "string" && b.clip_id ? b.clip_id : String(b.material ?? "");
			if (!clipId) continue;
			layers.push({ kind: "particle", trackIndex: ti, trackSt, duration, clipId, opaque: b.opaque === true });
		}
	}

	// (track_index 升序, 同号视频在下颗粒在上, 轨内按 track_st 升序)
	const kindRank = (l: OverlayLayer): number => (l.kind === "clip" ? 0 : 1);
	layers.sort(
		(a, b) => a.trackIndex - b.trackIndex || kindRank(a) - kindRank(b) || a.trackSt - b.trackSt,
	);
	return { layers, hiddenSkipped };
}

/** 时间线元素。`duration` 是源侧秒值（`trim` / `atrim` 寻址与 afade 用，不动）；`lineMs` 是它在成片时间线上
 *  占的**整毫秒数**（接缝判据与帧数分配的累计量，unify-time-consumers-and-tolerance D1）。三位小数工程两者同值。 */
type Element =
	| { kind: "clip"; material: string | number; clip_st: number; duration: number; lineMs: number; volume?: number }
	| { kind: "gap"; duration: number; lineMs: number };

const isGap = (clip: Clip): boolean => clip.material === null || clip.material === undefined;

function sortedTracks(tracks: Track[]): Track[] {
	return tracks
		.map((t, i) => ({ key: t.track_index != null ? t.track_index : i, t }))
		.sort((a, b) => a.key - b.key)
		.map((x) => x.t);
}

/** ★ fix-render-audio-volume 存量兼容（与客户端 opencut-rewrite `fix-gtrk-volume-consumption`
 *  同款取值域启发式，两侧口径 MUST 一致）：旧客户端曾把编辑器 dB 原值直写 `volume`
 *  （稠密缺省 `0` = 全音量、调低为负值）——按线性硬读会把这些存档渲成全静音/反相。分流：
 *   · v < 0  → 旧 dB（线性域无负值，构造性无歧义）→ 10^(clamp(v,−60,20)/20) 换线性；
 *   · v === 0 → 旧稠密缺省（写方本意 0dB 全音量）→ 视为缺省不产滤镜——
 *              MUST NOT 读成线性 0 全静音；显式静音走 `muted` 表达；
 *   · v > 0  → 契约线性（CLI/后端主链路）原样。 */
function normalizeVolume(v: number): number | undefined {
	if (!Number.isFinite(v)) return undefined;
	if (v < 0) return 10 ** (Math.max(-60, Math.min(20, v)) / 20);
	if (v === 0) return undefined;
	return v;
}

/**
 * track_timeline → 连续 clip/gap 元素序列（铺满、无重叠），返回 [elements, cursor（秒，恒落整毫秒格）]。
 *
 * 接缝判据在**整毫秒格**上（unify-time-consumers-and-tolerance D1；spec `local-ffmpeg-render`「铺轨判据与帧化 SHALL 与
 * `gtrk patch` 校验器同源」）：`sec2ms(track_st)` 与整毫秒游标直接比较——小于即重叠（硬拒，与 E9 `same_track_overlap`
 * 同判）、大于即缝（补 gap）、相等即相邻。MUST NOT 用 `±1e-6` 浮点秒（T4 禁止的匿名 ε）。
 * 游标 = `sec2ms(track_st + duration)`：终点由未舍入的和**一次取整**，与 `slotTimes` / `assertTrackContinuity` 的
 * `sec2ms(track_ed)` 同口径（客户端按帧写出的 `n/rate` 浮点时码若逐项取整再相加，会因 `f2ms` 不可加漂 1ms 而误判重叠——
 * 真机工程副本实测 9 对）。三位小数工程上与 E9 的 `readMs(st) + readMs(duration)` 逐值同。
 */
function normalizeTrack(trackTimeline: Clip[], trackVolume?: number): [Element[], number] {
	const items = [...trackTimeline].sort((a, b) => Number(a.track_st) - Number(b.track_st));
	const elements: Element[] = [];
	let cursorMs = 0;
	for (const clip of items) {
		const trackSt = Number(clip.track_st);
		const duration = Number(clip.duration);
		if (duration <= 0) throw new Error(`clip duration 非法: ${JSON.stringify(clip)}`);
		const stMs = sec2ms(trackSt);
		if (stMs < cursorMs) {
			throw new Error(
				`track_timeline 时间重叠: track_st=${trackSt} 早于前一元素终点 ${ms2sec(cursorMs)}` +
					`（重叠 ${cursorMs - stMs}ms；整毫秒格零容差，与 gtrk patch 校验器同判）` +
					"——修复：用 `gtrk patch` 校验并修正该轨，或用客户端打开工程重存一次后再渲染",
			);
		}
		if (stMs > cursorMs) elements.push({ kind: "gap", duration: ms2sec(stMs - cursorMs), lineMs: stMs - cursorMs });
		const edMs = sec2ms(trackSt + duration);
		const lineMs = edMs - stMs;
		if (!isGap(clip)) {
			// 契约双层音量：clip 级覆盖轨级，均缺省=1（不产生 volume 滤镜）；
			// 折叠后的原始值再过存量启发式（normalizeVolume）换成可消费线性。
			const raw = typeof clip.volume === "number" ? clip.volume : trackVolume;
			const vol = typeof raw === "number" ? normalizeVolume(raw) : undefined;
			elements.push({
				kind: "clip",
				material: clip.material as string | number,
				clip_st: Number(clip.clip_st),
				duration,
				lineMs,
				...(typeof vol === "number" && vol !== 1 ? { volume: vol } : {}),
			});
		} else {
			elements.push({ kind: "gap", duration, lineMs });
		}
		cursorMs = edMs;
	}
	return [elements, ms2sec(cursorMs)];
}

/**
 * ★ fix-render-bundled-clip-audio —— lane A（视频 clip 内嵌音轨）的取用判据。
 *
 * 某 clip 的内嵌音轨进混音，**当且仅当**三个开关全开：
 * `track.muted !== true` 且 `clip.muted !== true` 且 `element_state.isSourceAudioEnabled !== false`。
 * 三者任一为「关」即跳过（该时段由静音源补齐，MUST NOT 塌缩时间轴）。
 *
 * 判据与客户端逐字一致，MUST NOT 引入 CLI 独有的第二套缺省口径：
 * 轨级 `muted` 是主开关（NLE 通例，clip 级不能反向撬开），故三者取**与**而非「clip 覆盖轨」。
 * 「B-roll / AI 再现轨默认不发声」由铺轨方落轨时写 `track.muted = true` 表达（现状即如此），
 * 「解说链特意保留原片原声」由铺轨方置 `false` 表达——渲染器只忠实读字段。
 */
function clipSourceAudioOn(track: Track, clip: Clip): boolean {
	if (track.muted === true) return false;
	if (clip.muted === true) return false;
	if (clip.element_state?.isSourceAudioEnabled === false) return false;
	return true;
}

/** lane A 会取用的素材 id 集合（遍历**全部** `video_track` × 判据过关的 clip）。
 *  供素材校验面（materialPathsFromGtrk）与内嵌音轨探测（probeEmbeddedAudio）共用同一口径。 */
function audioSourceMaterialIds(gtrk: GtrkV1): Set<string> {
	const out = new Set<string>();
	for (const t of gtrk.video_track || []) {
		for (const c of t.track_timeline || []) {
			if (isGap(c)) continue;
			if (!clipSourceAudioOn(t, c)) continue;
			out.add(String(c.material));
		}
	}
	return out;
}

/** 视频轨 → lane A 的输入时间线：判据不过、或素材本身不带音轨的 clip **就地降级为等长 gap**
 *  （静音补齐，时间轴不塌缩）。返回降级后的时间线与其中真正可发声的 clip 段数。 */
function laneATimeline(
	track: Track,
	hasAudio: (materialId: string | number) => boolean,
): { timeline: Clip[]; audible: number } {
	let audible = 0;
	const timeline = (track.track_timeline || []).map((clip) => {
		if (isGap(clip)) return clip;
		if (!clipSourceAudioOn(track, clip) || !hasAudio(clip.material as string | number)) {
			return { ...clip, material: null };
		}
		audible++;
		return clip;
	});
	return { timeline, audible };
}

export interface RenderParams {
	crf?: number;
	codec?: string;
	audio_crossfade_ms?: number;
	/**
	 * 素材是否带**内嵌音轨**（★ fix-render-bundled-clip-audio）。
	 * `[i:a]` 打在无音轨输入上会让整条 filter graph 直接失败，故 lane A 必须先知道这件事——
	 * 由 `renderGtrk` 用 ffprobe 探测后注入（纯函数本身不碰磁盘，保持可单测/可与后端对拍）。
	 * 缺省（不注入）视为「都带音轨」：只影响直接调 `buildFilterGraph` 的调用方（单测/对拍向量），
	 * 生产路径恒经 `renderGtrk` 注入真值。
	 */
	materialHasAudio?: (materialId: string | number) => boolean;
	/**
	 * 颗粒 qtrle MOV 的本机绝对路径表（clip_id → path）。★ add-render-overlay-compositing。
	 * 由 `renderGtrk` 在预渲之后注入（纯函数本身不碰网络/磁盘，保持可单测/可对拍）。
	 * 缺省（不注入）= 一颗颗粒都不叠——`--no-particles` 与「预渲整体失败」共用这条路径；
	 * 表里没有的 clip_id 同样只是不叠（该颗粒已在预渲阶段被点名，此处 MUST NOT 二次报错刷屏）。
	 */
	particlePaths?: Record<string, string>;
}

/** 成片音源覆盖面的实况（★ fix-render-bundled-clip-audio：零音源 MUST NOT 静默）。 */
export interface RenderAudioInfo {
	/** 进 amix 的发声 lane 数（视频内嵌音轨 lane + audio_track lane）。 */
	lanes: number;
	/** 视频内嵌音轨（lane A）贡献的可发声 clip 段数。 */
	embeddedClips: number;
	/** audio_track 贡献的 clip 段数。 */
	audioTrackClips: number;
	/** 工程零音源 ⇒ 成片无声。命令层 SHALL 打 INFO 并在 `--json` 标明。 */
	silent: boolean;
}

/** 叠加层合成的实况（★ add-render-overlay-compositing：跳过了什么 MUST 说出来）。 */
export interface RenderOverlayInfo {
	/** 实际叠进成片的叠加元素数（clip + 颗粒）。 */
	layers: number;
	/** 其中颗粒数。 */
	particles: number;
	/** 因 `hidden: true` 整条跳过的轨数。 */
	hiddenSkipped: number;
	/** 因素材缺 path / 文件不存在而未叠的 clip 数（软消费：只降级不阻断）。 */
	missingMaterialSkipped: number;
	/** 因没有 qtrle 产物而未叠的颗粒数（`--no-particles` 或该颗预渲失败）。 */
	particleUnavailable: number;
}

/**
 * 视频元素序列 → 逐元素输出帧数（fix-render-frame-drift D1：累计取整）。
 *
 * 现行 `trim`+`fps` 链每段产出 `ceil(d × rate)` 帧——`fps` 在 t=0,1/rate,2/rate… 逐槽取帧，
 * 只要 `d × rate` 非整数就多出不足一帧的尾巴且**从不向下取整**，`concat` 逐段累加 →
 * 画面对配音渐进失步（旅拍打样实测：视频流比音频流长 0.279s，切点漂移 0.028s→0.256s 单调增长）。
 * 该行为与 VFR 无关，纯 CFR 源同样发生（合成源实测 2.010s→61 帧、2.510s→76 帧）。
 *
 * 累计取整：第 i 段帧数 = `sec2frame(cumEnd_i) − sec2frame(cumStart_i)`（半帧进一，与写方同一口径），
 * 每段的取整误差被下一段起点吸收，全片总帧数恒 `sec2frame(total)`，不随段序累加。
 * 各段时长均为帧长整数倍时退化为原值（零回归）。导出供单测与跨仓对拍。
 *
 * 累计量是**整毫秒和**（各元素 `lineMs`，unify-time-consumers-and-tolerance D1）：它逐项等于成片时间线上的元素终点
 * （`normalizeTrack` 的游标序列），不再是浮点 `duration` 的加法链；帧化只经 `sec2frame`，MUST NOT 内联 `Math.round(x × rate)`。
 * 正数域上 `sec2frame` 与此前的 `Math.round` 逐值同，三位小数工程的裁定帧数逐字节不变。
 */
export function allocateFrames(elements: { lineMs: number }[], rate: number): number[] {
	const out: number[] = [];
	let cumMs = 0;
	let prevFrame = 0;
	for (const el of elements) {
		cumMs += el.lineMs;
		const edge = sec2frame(ms2sec(cumMs), rate);
		out.push(edge - prevFrame);
		prevFrame = edge;
	}
	return out;
}

/** gtrk v1 → (输入文件列表, filter_complex 文本, 总时长, 音源实况)。纯函数，供黄金用例对拍。 */
export function buildFilterGraph(
	gtrk: GtrkV1,
	materialPaths: Record<string, string>,
	params: RenderParams = {},
): {
	inputs: string[];
	graph: string;
	total: number;
	audio: RenderAudioInfo;
	overlay: RenderOverlayInfo;
	/** 成片视频流的最终标签：无叠加层时恒 `"vout"`（零回归），有叠加层时是收口后的新标签。 */
	videoLabel: string;
} {
	const fadeMs = Math.trunc(params.audio_crossfade_ms ?? DEFAULT_AUDIO_CROSSFADE_MS);
	const fade = Math.max(fadeMs, 0) / 1000;
	const hasAudio = params.materialHasAudio ?? ((): boolean => true);

	const sortedV = sortedTracks(gtrk.video_track || []);
	if (sortedV.length === 0) throw new Error("gtrk v1 缺少 video_track");
	const mainVideoTrack = pickPreviewMainTrack(gtrk, sortedV);
	const audioTracks = sortedTracks(gtrk.audio_track || []);

	// ★ fix-render-bundled-clip-audio：lane A 的输入时间线（遍历**全部** video_track，不只投影主轨——
	// pickPreviewMainTrack 是**视觉**主轨选择器，与音源覆盖面无关）。判据不过 / 素材无音轨 /
	// 素材本地缺席的 clip 已在 laneATimeline 里降级成等长 gap；整轨一段都不发声
	// （如 muted 的 B-roll、颗粒、黑底垫轨）则**不建 lane**。
	// ⚠️ 素材缺席只降级不抛：`local-ffmpeg-render` 既有条款「overlay-only 素材缺失不阻断渲染」
	// （add-matrix-lay-tracks）在本件里 MUST 保持——主轨素材缺席仍由视频链照旧硬拒。
	const usableSource = (id: string | number): boolean =>
		materialPaths[String(id)] !== undefined && hasAudio(id);
	const laneAInputs = sortedV
		.map((t, i) => ({ t, i, ...laneATimeline(t, usableSource) }))
		.filter((x) => x.audible > 0);

	const totalClips =
		[mainVideoTrack, ...audioTracks].reduce((n, t) => n + (t.track_timeline?.length || 0), 0) +
		// lane A 里**非主轨**那部分是新增的图规模（主轨的 clip 已在上面数过一遍）
		laneAInputs.reduce((n, x) => n + (x.t === mainVideoTrack ? 0 : x.audible), 0);
	if (totalClips > MAX_CLIPS) throw new Error(`clip 总数 ${totalClips} 超过上限 ${MAX_CLIPS}`);

	const width = Math.trunc(gtrk.video_size[0]);
	const height = Math.trunc(gtrk.video_size[1]);
	// 帧率判据与 `matrix lay` / `gtrk patch` 同源（add-frame-rate-table-vfr-detect D3）：顶层 `video_rate` 缺席 / 非正 / 非整数
	// ⇒ 同一条话术报错（含修复指引）。此前 `Number(gtrk.video_rate)` 裸取——同一份 29.97 工程 `matrix lay` 拒、`render` 收，
	// 且 29.97 直接进 `allocateFrames` 与 `fps=` 滤镜。MUST NOT 静默吸附后渲染：按 29.97 与按 30 分配的帧数不同，吸附即第二个权威。
	const rate = videoRateOf(gtrk as unknown as Record<string, unknown>);

	const inputs: string[] = [];
	const inputIdx: Record<string, number> = {};
	/** 按**路径**去重的输入登记（同一素材多 clip 只占一个 `-i`；ffmpeg 对同一输入被多条链引用会自动 split）。 */
	const inputOfPath = (path: string): number => {
		if (!(path in inputIdx)) {
			inputIdx[path] = inputs.length;
			inputs.push(path);
		}
		return inputIdx[path];
	};
	const inputOf = (materialId: string | number): number => {
		const path = materialPaths[String(materialId)];
		if (path === undefined) throw new Error(`gtrk 引用素材 ${materialId} 缺本地路径`);
		return inputOfPath(path);
	};

	const chains: string[] = [];
	let labelN = 0;
	const label = (): string => `s${++labelN}`;

	// 视频轨（main）
	const [vElements, vEnd] = normalizeTrack(mainVideoTrack.track_timeline);
	const normTracks: Element[][] = [];
	const aLens: number[] = [];
	for (const t of audioTracks) {
		const [els, end] = normalizeTrack(t.track_timeline, typeof t.volume === "number" ? t.volume : undefined);
		normTracks.push(els);
		aLens.push(end);
	}
	// lane A 归一（音量走契约双层折叠 clip.volume ?? track.volume + 取值域启发式，与 audio_track 同一套零件）
	const laneA: { els: Element[]; end: number; clips: number }[] = [];
	for (const x of laneAInputs) {
		let els: Element[];
		let end: number;
		try {
			[els, end] = normalizeTrack(x.timeline, typeof x.t.volume === "number" ? x.t.volume : undefined);
		} catch (e) {
			throw new Error(`video_track[${x.t.track_index ?? x.i}] 内嵌音轨 lane 构建失败：${(e as Error).message}`);
		}
		laneA.push({ els, end, clips: x.audible });
	}
	const total = Math.max(vEnd, ...aLens, ...laneA.map((l) => l.end));
	if (total <= 0) throw new Error("时间线总时长为 0");
	// 尾补 gap 同样在整毫秒格上判（各 lane 终点本就是 normalizeTrack 的整毫秒游标）
	const totalMs = sec2ms(total);
	if (totalMs > sec2ms(vEnd)) vElements.push({ kind: "gap", duration: ms2sec(totalMs - sec2ms(vEnd)), lineMs: totalMs - sec2ms(vEnd) });

	// 逐元素输出帧数：按成片时间线**累计取整**裁定（fix-render-frame-drift D1）——
	// 取整误差被下一段起点吸收，全片总帧数恒 round(total×rate)，MUST NOT 逐段累加
	const frameCounts = allocateFrames(vElements, rate);

	const vLabels: string[] = [];
	vElements.forEach((el, i) => {
		const lab = label();
		const frames = frameCounts[i]!;
		if (el.kind === "clip") {
			const idx = inputOf(el.material);
			const st = el.clip_st;
			const ed = el.clip_st + el.duration;
			// fps 之后按**输出帧号**截到裁定值（trim=end_frame 与源时基解耦，VFR 源同样成立）。
			// 截断前先 tpad 克隆末帧补足 PAD_FRAMES 帧：`fps` 的实际出帧数随 trim 起点相对源帧的
			// **相位**在 floor/ceil 之间摆动（合成源实测：同为 d=2.010s，start=5.000 出 61 帧、
			// start=5.008 出 60 帧），只截不补会在裁定值恰好取到高位时少一帧、逐段累成短片
			// （打样实测 5100 vs 应有 5103）。补出来的帧在够用时被 end_frame 原样截掉；
			// 真不够时最多多驻留一帧末帧（不可见），MUST NOT 靠外扩源窗补——那会把邻场景帧截进来。
			chains.push(
				`[${idx}:v]trim=start=${f6(st)}:end=${f6(ed)},setpts=PTS-STARTPTS,` +
					`fps=${g(rate)},tpad=stop_mode=clone:stop_duration=${f6(PAD_FRAMES / rate)},` +
					`trim=end_frame=${frames},setpts=PTS-STARTPTS,` +
					`scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
					`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[${lab}]`,
			);
		} else {
			// gap 是合成黑场，给足 d（裁定帧数 + 余量）再按帧截即可，无需 tpad
			chains.push(
				`color=black:s=${width}x${height}:r=${g(rate)}:d=${f6((frames + PAD_FRAMES) / rate)},` +
					`trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[${lab}]`,
			);
		}
		vLabels.push(lab);
	});
	chains.push(vLabels.map((x) => `[${x}]`).join("") + `concat=n=${vLabels.length}:v=1:a=0[vout]`);

	// ══ 叠加层合成（★ add-render-overlay-compositing）══════════════════════════════
	//
	// 🔴 **零回归门**：没有任何可叠元素时，本段**一个字节都不产**，`videoLabel` 仍是 `[vout]`
	//    ——不含 beat_track 且只有一条 video_track 的工程，filter_complex 与本 change 之前逐字节一致。
	//
	// 🔴 **底轨 MUST NOT 被追加任何 pts 平移或起点归零**（design D4 · 后端「播放钟契约」同守）：
	//    下面只对**叠加输入**做 `setpts` 偏移，`[vout]` 原样进 overlay 的第一路。
	//
	// 对拍口径：本段是 **CLI 独有扩展**，后端 `video_timeline_render.build_filter_graph` 结构性
	// 不合成叠加层（明文「只渲 track_index 最小的一条 video_track」「beat_track 时间线渲染忽略」），
	// **不存在**可对拍的后端向量；语义参照后端另一条链 `html_animate_render._ffmpeg_overlay`
	// （`overlay=format=auto` 合成 alpha）。以 CLI 自有黄金向量对拍。
	const particlePaths = params.particlePaths ?? {};
	const { layers: allLayers, hiddenSkipped } = collectOverlayLayers(gtrk, mainVideoTrack);
	let missingMaterialSkipped = 0;
	let particleUnavailable = 0;
	const layers = allLayers.filter((L) => {
		if (L.kind === "particle") {
			if (particlePaths[L.clipId] === undefined) {
				particleUnavailable++;
				return false;
			}
			return true;
		}
		// 软消费：overlay 素材缺 path / 文件缺失只降级不硬拒（既有条款「overlay-only 素材缺失
		// 不阻断渲染」在本件 MUST 保持——B-roll 代理没下全，不该让一条 45 分钟的片子出不来）
		if (materialPaths[String(L.material)] === undefined) {
			missingMaterialSkipped++;
			return false;
		}
		return true;
	});

	let videoLabel = "vout";
	if (layers.length > 0) {
		/** 叠加输入的公共几何链：**保 alpha**。
		 *  · `format=rgba` 前置——qtrle 解码出的像素格式随源而异，不显式转就可能拿不到 alpha 通道；
		 *    且 `pad` 要填**透明**必须先有 alpha。
		 *  · `pad` 用 `color=black@0`（透明）**而非** `black`：叠加层按 contain-fit 缩放后，
		 *    黑边区域必须露出底下的层。填不透明黑 = 给整片加黑边，是 NLE 语义的反面。
		 *  · 🔴 链上 MUST NOT 提前 `format=yuv420p`（会把 alpha 直接压掉）；像素格式统一收口在末尾。 */
		const fitAlpha =
			`format=rgba,scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
			`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1`;
		/** 落位 + 在场窗口都钉在**帧网格**上（与 `matrix lay` / `gtrk patch` 同一 `sec2frame`，
		 *  MUST NOT 用裸秒——裸秒会让叠加层的起点落在两帧之间）。
		 *  `enable` 取 `[st, ed)` 半开区间（`gte*lt`，非 `between` 的闭区间）：clip 占的就是半开区间，
		 *  闭区间会让终点那一帧多显一帧。表达式含逗号，MUST 单引号包住，否则被当成滤镜参数分隔符。 */
		const window = (trackSt: number, duration: number) => {
			const stF = sec2frame(trackSt, rate);
			const edF = sec2frame(trackSt + duration, rate);
			return { stF, edF, st: stF / rate, ed: edF / rate, frames: edF - stF };
		};

		for (const L of layers) {
			const w = window(L.trackSt, L.duration);
			if (w.frames <= 0) continue;
			const enable = `enable='gte(t\\,${f6(w.st)})*lt(t\\,${f6(w.ed)})'`;

			// opaque 颗粒的黑背板：服务端 qtrle 生产链 `opaque_cover` 恒 False ⇒ 拿回的 qtrle 里
			// opaque 颗粒的透明区**仍然透明**。不补即渲出「本该满屏盖住底轨却露着底轨」的成片。
			if (L.kind === "particle" && L.opaque) {
				const bg = label();
				chains.push(
					`color=black:s=${width}x${height}:r=${g(rate)}:d=${f6(w.frames / rate)},` +
						`trim=end_frame=${w.frames},setpts=PTS-STARTPTS+${f6(w.st)}/TB,format=rgba[${bg}]`,
				);
				const mid = label();
				chains.push(`[${videoLabel}][${bg}]overlay=x=0:y=0:eof_action=pass:format=auto:${enable}[${mid}]`);
				videoLabel = mid;
			}

			const lab = label();
			if (L.kind === "particle") {
				// 契约：颗粒**整段播、无源裁剪**（beat MUST NOT 含 clip_st/clip_ed）⇒ 不做 trim 源窗，
				// 只落位 + 缩放；在场窗口由 `enable` 钳、尾部由 `eof_action=pass` 兜。
				const idx = inputOfPath(particlePaths[L.clipId]!);
				chains.push(`[${idx}:v]${fitAlpha},setpts=PTS-STARTPTS+${f6(w.st)}/TB[${lab}]`);
			} else {
				// overlay 视频 clip：与主轨**同一套** trim/fps/tpad/截帧语义（含 PAD_FRAMES 补帧——
				// `fps` 出帧数随 trim 起点相位摆动，只截不补会少帧），只是 pad 透明且不转 yuv420p。
				const idx = inputOf(L.material);
				const st = L.clipSt;
				const ed = L.clipSt + L.duration;
				chains.push(
					`[${idx}:v]trim=start=${f6(st)}:end=${f6(ed)},setpts=PTS-STARTPTS,` +
						`fps=${g(rate)},tpad=stop_mode=clone:stop_duration=${f6(PAD_FRAMES / rate)},` +
						`trim=end_frame=${w.frames},${fitAlpha},setpts=PTS-STARTPTS+${f6(w.st)}/TB[${lab}]`,
				);
			}
			const next = label();
			chains.push(`[${videoLabel}][${lab}]overlay=x=0:y=0:eof_action=pass:format=auto:${enable}[${next}]`);
			videoLabel = next;
		}
		// 像素格式在此统一收口（前面全程保 alpha）：libx264 要 yuv420p
		const outLab = label();
		chains.push(`[${videoLabel}]format=yuv420p[${outLab}]`);
		videoLabel = outLab;
	}

	const overlay: RenderOverlayInfo = {
		layers: layers.length,
		particles: layers.filter((L) => L.kind === "particle").length,
		hiddenSkipped,
		missingMaterialSkipped,
		particleUnavailable,
	};

	/** 一条音频 lane：逐元素 atrim/asetpts/aresample/aformat/[volume]/afade（空档 anullsrc），
	 *  尾部补齐到 total 后 concat 成与时间线等长的连续 lane。lane A 与 audio_track 共用**同一套**
	 *  滤镜语义（主规格钉死的音频链，本件逐字不改，只是把输入从哪来这一面补上）。 */
	const emitLane = (els: Element[], end: number): string => {
		const endMs = sec2ms(end);
		if (totalMs > endMs) els.push({ kind: "gap", duration: ms2sec(totalMs - endMs), lineMs: totalMs - endMs });
		const segLabels: string[] = [];
		for (const el of els) {
			const lab = label();
			if (el.kind === "clip") {
				const idx = inputOf(el.material);
				const st = el.clip_st;
				const ed = el.clip_st + el.duration;
				const steps = [
					`[${idx}:a]atrim=start=${f6(st)}:end=${f6(ed)}`,
					"asetpts=PTS-STARTPTS",
					`aresample=${AUDIO_SAMPLE_RATE}`,
					`aformat=sample_fmts=fltp:channel_layouts=${AUDIO_LAYOUT}`,
				];
				// ★ fix-render-audio-volume：消费契约双层音量（此前 amix 等权、volume 全然未消费——
				// BGM 压不下去的打样实锤根因之一）
				if (typeof el.volume === "number") steps.push(`volume=${f3(el.volume)}`);
				if (fade > 0) {
					steps.push(`afade=t=in:d=${f3(fade)}`);
					steps.push(`afade=t=out:st=${f6(Math.max(el.duration - fade, 0))}:d=${f3(fade)}`);
				}
				chains.push(steps.join(",") + `[${lab}]`);
			} else {
				chains.push(
					`anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=${AUDIO_LAYOUT},atrim=end=${f6(el.duration)}[${lab}]`,
				);
			}
			segLabels.push(lab);
		}
		const lab = label();
		chains.push(segLabels.map((x) => `[${x}]`).join("") + `concat=n=${segLabels.length}:v=0:a=1[${lab}]`);
		return lab;
	};

	// lane A（视频 clip 内嵌音轨，按 track_index 序）→ 再接既有 audio_track lanes（0..N），并列进 amix
	const trackLabels: string[] = [];
	for (const l of laneA) trackLabels.push(emitLane(l.els, l.end));
	for (let ti = 0; ti < normTracks.length; ti++) trackLabels.push(emitLane(normTracks[ti], aLens[ti]));

	const audio: RenderAudioInfo = {
		lanes: trackLabels.length,
		embeddedClips: laneA.reduce((n, l) => n + l.clips, 0),
		audioTrackClips: normTracks.reduce((n, els) => n + els.filter((e) => e.kind === "clip").length, 0),
		silent: trackLabels.length === 0,
	};

	if (trackLabels.length === 0) {
		// 零音源：出真静音轨（没有可收的东西，不施母带）。诚实告知由 renderGtrk / 命令层负责，
		// MUST NOT 静默出无声片——2026-09-04 事故的行为形态就是这个。
		chains.push(`anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=${AUDIO_LAYOUT},atrim=end=${f6(total)}[aout]`);
	} else if (trackLabels.length === 1) {
		// 单 lane 也走母带（口径与客户端一致：单人声无 BGM 的工程不能出另一种听感）
		chains.push(`[${trackLabels[0]}]${MASTER_CHAIN}[aout]`);
	} else {
		chains.push(
			trackLabels.map((x) => `[${x}]`).join("") +
				`amix=inputs=${trackLabels.length}:duration=longest:normalize=0,${MASTER_CHAIN}[aout]`,
		);
	}

	return { inputs, graph: chains.join(";"), total, audio, overlay, videoLabel };
}

/** 从 gtrk.materials 建 {id: 本地绝对路径}。
 * 校验范围收窄为**被渲染实际消费的素材**（主视频轨 + 全部音频轨引用；add-matrix-lay-tracks）：
 * 本地渲染不合成 overlay，未被消费的素材（如 B-roll 候选代理）缺失不应阻断与它无关的渲染。
 * 被消费素材缺 path/文件缺失仍硬拒（行为不变）。
 *
 * ★ fix-render-bundled-clip-audio 追加**软消费**一档：未静音的非主轨 `video_track`，其 clip 的
 * 内嵌音轨会进混音（lane A），故素材同样要落进本表——但缺席时**只降级 + WARN 不硬拒**：
 * 上面那条既有条款（overlay-only 素材缺失不阻断渲染）在本件里 MUST 保持，
 * 而「拿不到可读诊断」的洞由这条 WARN 补上（不再等到 ffmpeg 层才炸）。导出供单测。 */
export function materialPathsFromGtrk(
	gtrk: GtrkV1,
	opts: { gtrkDir?: string } = {},
): Record<string, string> {
	/** 硬消费：视觉主轨 + 全部音频轨 —— 缺席即硬拒（行为不变）。 */
	const hard = new Set<string>();
	const sortedV = sortedTracks(gtrk.video_track || []);
	// 与快照渲染同一主轨口径（跳过黑底垫轨——fix-broll-zorder-contract-drift 连锁）
	const consumers = sortedV.length ? [pickPreviewMainTrack(gtrk, sortedV), ...(gtrk.audio_track || [])] : [...(gtrk.audio_track || [])];
	for (const t of consumers) {
		if (!t) continue;
		for (const c of t.track_timeline || []) {
			const m = (c as { material?: unknown }).material;
			if (m != null) hard.add(String(m));
		}
	}
	/** 软消费：叠加面用到的素材 —— 缺席只降级（★ add-render-overlay-compositing 起含**视觉**叠加）。
	 *  两支：① lane A（叠加轨内嵌音轨，缺席即该轨原声不进混音）；② 可见 overlay `video_track` 的画面
	 *  （缺席即该 clip 不叠）。🔴 `hidden: true` 的轨**两支都不进** —— 它不进成片，也就不该被校验，
	 *  与 spec 的「未消费素材缺失不阻断」同一条。 */
	const soft = new Set<string>();
	for (const id of audioSourceMaterialIds(gtrk)) if (!hard.has(id)) soft.add(id);
	if (sortedV.length) {
		for (const L of collectOverlayLayers(gtrk, pickPreviewMainTrack(gtrk, sortedV)).layers) {
			if (L.kind !== "clip") continue;
			const id = String(L.material);
			if (!hard.has(id)) soft.add(id);
		}
	}

	const map: Record<string, string> = {};
	for (const m of gtrk.materials || []) {
		const id = String(m.id);
		const isHard = hard.has(id);
		if (!isHard && !soft.has(id)) continue; // 谁都没消费：不校验不入表
		if (!m.path) {
			if (isHard) throw new Error(`gtrk 素材 ${m.id} 缺 path（source_path），无法本地渲染`);
			log.warn(`叠加轨素材 ${id} 缺 path：该 clip 不叠、其原声不进混音（渲染继续）`);
			continue;
		}
		// 相对路径恒以 .gtrk 所在目录为基准（与 material-integrity 同一口径；按 CWD 裸测是历史坑，
		// 黑片 assets/builtin/ 等相对素材在任意 CWD 下渲染都会被误判缺失）
		const abs = !isAbsolute(m.path) && opts.gtrkDir ? resolve(opts.gtrkDir, m.path) : m.path;
		if (!existsSync(abs)) {
			if (isHard) throw new Error(`gtrk 素材文件不存在：${m.path}`);
			log.warn(`叠加轨素材 ${id} 的文件不存在（${m.path}）：该 clip 不叠、其原声不进混音（渲染继续）`);
			continue;
		}
		map[id] = abs;
	}
	return map;
}

/** 探测 lane A 候选素材是否真的带内嵌音轨。
 *
 * 必要性：`[i:a]` 打在无音轨输入（黑底 png、静音空镜…）上会让**整条** filter graph 直接失败。
 * 探不动时按「无音轨」降级 + 打 WARN——宁可这一段静音，也不让整片渲染硬炸（良性降级要可读）。
 * 按**路径**缓存，同一素材多 clip 只探一次。 */
function probeEmbeddedAudio(
	ffprobe: string,
	gtrk: GtrkV1,
	materialPaths: Record<string, string>,
): (materialId: string | number) => boolean {
	const byId = new Map<string, boolean>();
	const byPath = new Map<string, boolean>();
	for (const id of audioSourceMaterialIds(gtrk)) {
		const path = materialPaths[id];
		if (path === undefined) {
			byId.set(id, false);
			continue;
		}
		if (!byPath.has(path)) {
			try {
				const j = ffprobeJson(ffprobe, [
					"-v", "error",
					"-select_streams", "a",
					"-show_entries", "stream=index",
					"-of", "json",
					path,
				]) as { streams?: unknown[] };
				byPath.set(path, Array.isArray(j.streams) && j.streams.length > 0);
			} catch (e) {
				log.warn(`素材 ${id} 的音轨探测失败，按「无内嵌音轨」处理（该段成片将静音）：${(e as Error).message}`);
				byPath.set(path, false);
			}
		}
		byId.set(id, byPath.get(path) === true);
	}
	return (id) => byId.get(String(id)) === true;
}

/** 渲染 gtrk 工程为成片 mp4。返回 {outputPath, duration, audio}。 */
export async function renderGtrk(
	gtrk: GtrkV1,
	outputPath: string,
	opts: {
		crf?: number;
		codec?: string;
		ffmpegPath?: string;
		gtrkDir?: string;
		onLine?: (l: string) => void;
		/** 颗粒 qtrle 本机路径表（clip_id → path）。★ add-render-overlay-compositing：
		 *  由命令层经 `prepareParticlesForRender` 备齐后注入——预渲的计费闸必须发生在
		 *  渲染之前、且由命令层持有交互面，故本函数**只消费不编排**。 */
		particlePaths?: Record<string, string>;
	} = {},
): Promise<{
	outputPath: string;
	duration: number;
	audio: RenderAudioInfo;
	overlay: RenderOverlayInfo;
}> {
	const codec = opts.codec ?? "h264";
	if (codec !== "h264") throw new Error(`v1 仅支持 h264，实际 ${codec}`);
	const crf = opts.crf ?? DEFAULT_CRF;
	// 帧率门前置到任何进程 / 文件系统动作之前（D3「报错退出零副作用」）：`buildFilterGraph` 里那次是取值处的同源判据，
	// 这里再判一次是为了不先解析 ffmpeg、不先 ffprobe 素材、不先写临时滤镜文件——非法工程在此即止。
	videoRateOf(gtrk as unknown as Record<string, unknown>);

	const { ffmpeg, ffprobe } = requireFfmpeg(opts.ffmpegPath);
	const materialPaths = materialPathsFromGtrk(gtrk, { gtrkDir: opts.gtrkDir });
	const materialHasAudio = probeEmbeddedAudio(ffprobe, gtrk, materialPaths);
	const { inputs, graph, total, audio, overlay, videoLabel } = buildFilterGraph(gtrk, materialPaths, {
		crf,
		materialHasAudio,
		...(opts.particlePaths ? { particlePaths: opts.particlePaths } : {}),
	});

	// ★ fix-render-bundled-clip-audio：音源覆盖面**开口说话**——2026-09-04 事故正是
	// 「人声整条没进混音，却一声不吭出了 −70 LUFS 的数字静音成片」。
	if (audio.silent) {
		log.info(
			"本片无音源（既无带音轨的视频 clip、也无 audio_track），将出**无声成片**——" +
				"若这不是你要的，检查轨/clip 的 muted 开关与音频轨是否铺上。",
		);
	} else {
		log.info(
			`音源：${audio.lanes} 条发声轨（视频内嵌音轨 ${audio.embeddedClips} 段 / 音频轨 ${audio.audioTrackClips} 段）`,
		);
	}

	// ★ add-render-overlay-compositing：叠加面同样**开口说话**——铺了 65 颗颗粒却一颗没叠、
	// 退出码 0、QC 全绿，正是本件要根治的形态。跳过了什么 MUST 逐类点名。
	if (overlay.layers > 0) {
		log.info(`叠加层：${overlay.layers} 段进片（其中颗粒 ${overlay.particles} 颗）`);
	}
	if (overlay.hiddenSkipped > 0) {
		log.info(`叠加层：${overlay.hiddenSkipped} 条轨因在客户端被隐藏（hidden）整条未叠`);
	}
	if (overlay.missingMaterialSkipped > 0) {
		log.warn(`叠加层：${overlay.missingMaterialSkipped} 段因素材本地缺失未叠（渲染继续，见上方逐条告警）`);
	}
	if (overlay.particleUnavailable > 0) {
		log.warn(`叠加层：${overlay.particleUnavailable} 颗颗粒无 qtrle 产物未叠（--no-particles 或该颗预渲失败）`);
	}

	const filterFile = join(tmpdir(), `gtrk-filter-${process.pid}-${inputs.length}.txt`);
	await writeFile(filterFile, graph, "utf8");
	try {
		const args = ["-y"];
		for (const p of inputs) args.push("-i", p);
		args.push(
			"-filter_complex_script", filterFile,
			// 无叠加层时 videoLabel 恒 "vout"（零回归：argv 与本 change 之前逐字节一致）
			"-map", `[${videoLabel}]`, "-map", "[aout]",
			"-c:v", "libx264", "-preset", "medium", "-crf", String(crf),
			"-c:a", "aac", "-b:a", "192k",
			"-movflags", "+faststart",
			outputPath,
		);
		await runFfmpeg(ffmpeg, args, opts.onLine);
		// 零音源同样照常产出、退出码 0（成片不因无声而失败）——诚实体现在上面的 INFO 与 audio.silent 上
		return { outputPath, duration: total, audio, overlay };
	} finally {
		await unlink(filterFile).catch(() => {});
	}
}

/** 读取 .gtrk 文件（JSON）→ GtrkV1。 */
export async function readGtrkFile(gtrkPath: string): Promise<GtrkV1> {
	return JSON.parse(await readFile(gtrkPath, "utf8")) as GtrkV1;
}
