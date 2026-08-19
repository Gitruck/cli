/**
 * 本地渲染：gtrk v1（EDL）→ ffmpeg filter_complex → 成片 mp4。
 *
 * 忠实移植后端 `video_timeline_render.build_filter_graph` 语义（视频 trim+setpts+fps+scale+pad+setsar+
 * format+concat；音频 atrim+asetpts+aresample+aformat+afade+concat/amix；libx264 -preset medium -crf 18
 * -c:a aac -b:a 192k -movflags +faststart）。material 输入取 gtrk materials[].path（= source_path，
 * 客户端原片本地绝对路径）；云端不产成片，成片在此本地出。
 *
 * 验收口径：观感等价（时长/切点/画布/音画同步/编码参数一致），不承诺与云端逐字节一致（libx264 跨版本/平台）。
 * filter_complex 生成须与后端黄金用例对拍（change tasks §8.4，待后端导出向量）。
 */
import { writeFile, unlink, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireFfmpeg, runFfmpeg } from "./ffmpeg";

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_LAYOUT = "stereo";
const DEFAULT_CRF = 18;
const DEFAULT_AUDIO_CROSSFADE_MS = 8;
const MAX_CLIPS = 500;

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
}
interface Track {
	track_index?: number;
	track_timeline: Clip[];
	/** 轨级默认音量（契约：clip 级缺省时生效）。 */
	volume?: number;
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

type Element =
	| { kind: "clip"; material: string | number; clip_st: number; duration: number; volume?: number }
	| { kind: "gap"; duration: number };

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

/** track_timeline → 连续 clip/gap 元素序列（铺满、无重叠），返回 [elements, cursor]。 */
function normalizeTrack(trackTimeline: Clip[], trackVolume?: number): [Element[], number] {
	const items = [...trackTimeline].sort((a, b) => Number(a.track_st) - Number(b.track_st));
	const elements: Element[] = [];
	let cursor = 0;
	for (const clip of items) {
		const trackSt = Number(clip.track_st);
		const duration = Number(clip.duration);
		if (duration <= 0) throw new Error(`clip duration 非法: ${JSON.stringify(clip)}`);
		if (trackSt < cursor - 1e-6) {
			throw new Error(`track_timeline 时间重叠: track_st=${trackSt} < cursor=${cursor.toFixed(6)}`);
		}
		if (trackSt > cursor + 1e-6) elements.push({ kind: "gap", duration: trackSt - cursor });
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
				...(typeof vol === "number" && vol !== 1 ? { volume: vol } : {}),
			});
		} else {
			elements.push({ kind: "gap", duration });
		}
		cursor = trackSt + duration;
	}
	return [elements, cursor];
}

export interface RenderParams {
	crf?: number;
	codec?: string;
	audio_crossfade_ms?: number;
}

/**
 * 视频元素序列 → 逐元素输出帧数（fix-render-frame-drift D1：累计取整）。
 *
 * 现行 `trim`+`fps` 链每段产出 `ceil(d × rate)` 帧——`fps` 在 t=0,1/rate,2/rate… 逐槽取帧，
 * 只要 `d × rate` 非整数就多出不足一帧的尾巴且**从不向下取整**，`concat` 逐段累加 →
 * 画面对配音渐进失步（旅拍打样实测：视频流比音频流长 0.279s，切点漂移 0.028s→0.256s 单调增长）。
 * 该行为与 VFR 无关，纯 CFR 源同样发生（合成源实测 2.010s→61 帧、2.510s→76 帧）。
 *
 * 累计取整：第 i 段帧数 = `round(cumEnd_i × rate) − round(cumStart_i × rate)`，
 * 每段的取整误差被下一段起点吸收，全片总帧数恒 `round(total × rate)`，不随段序累加。
 * 各段时长均为帧长整数倍时退化为原值（零回归）。导出供单测与跨仓对拍。
 */
export function allocateFrames(elements: { duration: number }[], rate: number): number[] {
	const out: number[] = [];
	let cum = 0;
	let prevFrame = 0;
	for (const el of elements) {
		cum += el.duration;
		const edge = Math.round(cum * rate);
		out.push(edge - prevFrame);
		prevFrame = edge;
	}
	return out;
}

/** gtrk v1 → (输入文件列表, filter_complex 文本, 总时长)。纯函数，供黄金用例对拍。 */
export function buildFilterGraph(
	gtrk: GtrkV1,
	materialPaths: Record<string, string>,
	params: RenderParams = {},
): { inputs: string[]; graph: string; total: number } {
	const fadeMs = Math.trunc(params.audio_crossfade_ms ?? DEFAULT_AUDIO_CROSSFADE_MS);
	const fade = Math.max(fadeMs, 0) / 1000;

	const sortedV = sortedTracks(gtrk.video_track || []);
	if (sortedV.length === 0) throw new Error("gtrk v1 缺少 video_track");
	const mainVideoTrack = pickPreviewMainTrack(gtrk, sortedV);
	const audioTracks = sortedTracks(gtrk.audio_track || []);

	const totalClips = [mainVideoTrack, ...audioTracks].reduce(
		(n, t) => n + (t.track_timeline?.length || 0),
		0,
	);
	if (totalClips > MAX_CLIPS) throw new Error(`clip 总数 ${totalClips} 超过上限 ${MAX_CLIPS}`);

	const width = Math.trunc(gtrk.video_size[0]);
	const height = Math.trunc(gtrk.video_size[1]);
	const rate = Number(gtrk.video_rate);

	const inputs: string[] = [];
	const inputIdx: Record<string, number> = {};
	const inputOf = (materialId: string | number): number => {
		const path = materialPaths[String(materialId)];
		if (path === undefined) throw new Error(`gtrk 引用素材 ${materialId} 缺本地路径`);
		if (!(path in inputIdx)) {
			inputIdx[path] = inputs.length;
			inputs.push(path);
		}
		return inputIdx[path];
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
	const total = aLens.length ? Math.max(vEnd, ...aLens) : vEnd;
	if (total <= 0) throw new Error("时间线总时长为 0");
	if (total > vEnd + 1e-6) vElements.push({ kind: "gap", duration: total - vEnd });

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
			// fps 之后按**输出帧号**截到裁定值（trim=end_frame 与源时基解耦，VFR 源同样成立）；
			// 源尾不足时 fps 本就重复末帧补齐，截断只截不补，故不会引入黑帧/卡帧
			chains.push(
				`[${idx}:v]trim=start=${f6(st)}:end=${f6(ed)},setpts=PTS-STARTPTS,` +
					`fps=${g(rate)},trim=end_frame=${frames},setpts=PTS-STARTPTS,` +
					`scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
					`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[${lab}]`,
			);
		} else {
			// color 源的 d 同样按时长向上取整，故同改按帧裁
			chains.push(
				`color=black:s=${width}x${height}:r=${g(rate)}:d=${f6(el.duration)},` +
					`trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[${lab}]`,
			);
		}
		vLabels.push(lab);
	});
	chains.push(vLabels.map((x) => `[${x}]`).join("") + `concat=n=${vLabels.length}:v=1:a=0[vout]`);

	// 音频轨（0..N）
	const trackLabels: string[] = [];
	for (let ti = 0; ti < normTracks.length; ti++) {
		const els = normTracks[ti];
		const end = aLens[ti];
		if (total > end + 1e-6) els.push({ kind: "gap", duration: total - end });
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
		trackLabels.push(lab);
	}

	if (trackLabels.length === 0) {
		chains.push(`anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=${AUDIO_LAYOUT},atrim=end=${f6(total)}[aout]`);
	} else if (trackLabels.length === 1) {
		chains.push(`[${trackLabels[0]}]anull[aout]`);
	} else {
		chains.push(
			trackLabels.map((x) => `[${x}]`).join("") +
				`amix=inputs=${trackLabels.length}:duration=longest:normalize=0[aout]`,
		);
	}

	return { inputs, graph: chains.join(";"), total };
}

/** 从 gtrk.materials 建 {id: 本地绝对路径}。
 * 校验范围收窄为**被渲染实际消费的素材**（主视频轨 + 全部音频轨引用；add-matrix-lay-tracks）：
 * 本地渲染不合成 overlay，未被消费的素材（如 B-roll 候选代理）缺失不应阻断与它无关的渲染。
 * 被消费素材缺 path/文件缺失仍硬拒（行为不变）。导出供单测。 */
export function materialPathsFromGtrk(gtrk: GtrkV1): Record<string, string> {
	const used = new Set<string>();
	const sortedV = sortedTracks(gtrk.video_track || []);
	// 与快照渲染同一主轨口径（跳过黑底垫轨——fix-broll-zorder-contract-drift 连锁）
	const consumers = sortedV.length ? [pickPreviewMainTrack(gtrk, sortedV), ...(gtrk.audio_track || [])] : [...(gtrk.audio_track || [])];
	for (const t of consumers) {
		if (!t) continue;
		for (const c of t.track_timeline || []) {
			const m = (c as { material?: unknown }).material;
			if (m != null) used.add(String(m));
		}
	}
	const map: Record<string, string> = {};
	for (const m of gtrk.materials || []) {
		if (!used.has(String(m.id))) continue; // 未被主轨/音轨消费：不校验不入表
		if (!m.path) throw new Error(`gtrk 素材 ${m.id} 缺 path（source_path），无法本地渲染`);
		if (!existsSync(m.path)) throw new Error(`gtrk 素材文件不存在：${m.path}`);
		map[String(m.id)] = m.path;
	}
	return map;
}

/** 渲染 gtrk 工程为成片 mp4。返回 {outputPath, duration}。 */
export async function renderGtrk(
	gtrk: GtrkV1,
	outputPath: string,
	opts: { crf?: number; codec?: string; ffmpegPath?: string; onLine?: (l: string) => void } = {},
): Promise<{ outputPath: string; duration: number }> {
	const codec = opts.codec ?? "h264";
	if (codec !== "h264") throw new Error(`v1 仅支持 h264，实际 ${codec}`);
	const crf = opts.crf ?? DEFAULT_CRF;

	const { ffmpeg } = requireFfmpeg(opts.ffmpegPath);
	const materialPaths = materialPathsFromGtrk(gtrk);
	const { inputs, graph, total } = buildFilterGraph(gtrk, materialPaths, { crf });

	const filterFile = join(tmpdir(), `gtrk-filter-${process.pid}-${inputs.length}.txt`);
	await writeFile(filterFile, graph, "utf8");
	try {
		const args = ["-y"];
		for (const p of inputs) args.push("-i", p);
		args.push(
			"-filter_complex_script", filterFile,
			"-map", "[vout]", "-map", "[aout]",
			"-c:v", "libx264", "-preset", "medium", "-crf", String(crf),
			"-c:a", "aac", "-b:a", "192k",
			"-movflags", "+faststart",
			outputPath,
		);
		await runFfmpeg(ffmpeg, args, opts.onLine);
		return { outputPath, duration: total };
	} finally {
		await unlink(filterFile).catch(() => {});
	}
}

/** 读取 .gtrk 文件（JSON）→ GtrkV1。 */
export async function readGtrkFile(gtrkPath: string): Promise<GtrkV1> {
	return JSON.parse(await readFile(gtrkPath, "utf8")) as GtrkV1;
}
