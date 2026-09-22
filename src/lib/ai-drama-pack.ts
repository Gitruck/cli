/**
 * 自出图自运镜这条路径的**进出口**（纯函数层，零 IO）——openspec: add-ai-drama-pack-and-swap。
 *
 * ## 立题
 *
 * `gtrk ai-drama lay --package` 消费 return-v1 包，但 CLI **没有产这个包的命令**。
 * 工作台导出的能直接用；自己出图、自己运镜的用户无路可走——2026-09-20 那条片子 232 镜
 * 全部如此，只能手搓 manifest（遍历产物、ffprobe 量真实几何、从派单回算建议时长、拼窗口）。
 * 那份手搓脚本约 150 行，其中**只有「哪个镜用哪张图」是项目特有的**，其余全通用。
 *
 * 第二件同源：修图之后**不能重跑 `lay`**（会冲掉已补的缝与切点调整），正解是拿
 * 同名同时长的新文件覆盖 `assets/` 里的素材。当时是直接 `cp`，**零校验**——
 * 时长不一致会静默破坏时间线，而这种破坏要到出片才看得见。
 *
 * ## 射程
 *
 * 本文件**只放判据与计算**：文件名解析、窗口切分、几何比对。
 * ffprobe、读写盘、备份都在命令层（`commands/ai-drama.ts`）——
 * 这样「哪个镜配哪个文件」「新旧差多少」能在无 ffmpeg、无素材的环境里被证明。
 */

import { r3, sec2ms } from "./frame-domain";

/** 命名约定的占位符。`{beat}` 恒小写（与 `lay` 写出的 clip_id 同形：`coach-b03-s1`）。 */
export const NAMING_PLACEHOLDERS = ["{slug}", "{beat}", "{shot}", "{ext}"] as const;

/** 缺省命名约定：与 2026-09-20 真机手搓包逐字同形。 */
export const NAMING_DEFAULT = "{slug}-{beat}-s{shot}.{ext}";

export interface ShotSpec {
	shotIndex: number;
	file: string;
	/** 显式建议时长（秒）。缺省时由窗口均分（见 `splitWindow`）。 */
	suggestedSec?: number;
}

/**
 * 按命名约定解析镜号 → 文件名。
 *
 * ⚠️ **MUST NOT 扫盘猜**：镜号集合由派单的 `shot_count` 给定（1..n），
 * 本函数只做「按规则拼名字」，不列目录、不按后缀找相似文件。
 * 拼出来的文件不存在由调用方报错——报「B03 s2 缺 coach-b03-s2.mp4」，
 * 而不是悄悄拿目录里另一个文件顶上。
 */
export function resolveShotFiles(opts: {
	naming?: string;
	slug: string;
	beatId: string;
	shotCount: number;
	ext?: string;
}): ShotSpec[] {
	const naming = opts.naming || NAMING_DEFAULT;
	const ext = (opts.ext || "mp4").replace(/^\./, "");
	const out: ShotSpec[] = [];
	for (let i = 1; i <= opts.shotCount; i++) {
		const file = naming
			.replaceAll("{slug}", opts.slug)
			.replaceAll("{beat}", opts.beatId.toLowerCase())
			.replaceAll("{BEAT}", opts.beatId.toUpperCase())
			.replaceAll("{shot}", String(i))
			.replaceAll("{ext}", ext);
		out.push({ shotIndex: i, file });
	}
	return out;
}

/**
 * 把 beat 窗口均分给 n 个镜。
 *
 * 为什么是均分：`lay` 里**末镜恒吃满剩余窗口**（`i === items.length - 1 ? remaining : …`），
 * `suggestedSec` 只决定前 n-1 镜各占多长。在没有分镜稿逐镜时长的情况下，
 * 均分是唯一**确定性**且不偏袒任何一镜的切法。要逐镜控时长请用 `--map` 显式给。
 */
export function splitWindow(trackSt: number, trackEd: number, n: number): number[] {
	const span = trackEd - trackSt;
	if (!(span > 0) || n <= 0) return [];
	const each = r3(span / n);
	return Array.from({ length: n }, () => each);
}

export interface PackProbe {
	width: number;
	height: number;
	fps: number;
	duration: number;
}

export interface ManifestItem {
	shotIndex: number;
	file: string;
	suggestedSec: number;
	measuredSec: number;
	width?: number;
	height?: number;
	fps?: number;
}

export interface ReturnManifestV1 {
	slug: string;
	beatId: string;
	trackSt: number;
	trackEd: number;
	items: ManifestItem[];
	skipped: never[];
}

/**
 * 拼 return-v1 清单。
 *
 * `measuredSec` **恒取实测**（MUST NOT 用声明值）——`lay` 的越素材判据
 * （`durMs > measuredMs` ⇒ 宁短一帧）建在它上面，声明值偏大会让那道闸失效。
 */
export function buildReturnManifest(input: {
	slug: string;
	beatId: string;
	trackSt: number;
	trackEd: number;
	shots: ShotSpec[];
	probes: Map<number, PackProbe>;
}): ReturnManifestV1 {
	const shots = [...input.shots].sort((a, b) => a.shotIndex - b.shotIndex);
	const evenly = splitWindow(input.trackSt, input.trackEd, shots.length);
	const items: ManifestItem[] = shots.map((s, i) => {
		const p = input.probes.get(s.shotIndex);
		if (!p) throw new Error(`${input.beatId} s${s.shotIndex}：缺实测几何（${s.file}）`);
		return {
			shotIndex: s.shotIndex,
			file: s.file,
			suggestedSec: r3(s.suggestedSec ?? evenly[i] ?? 0),
			measuredSec: r3(p.duration),
			...(p.width > 0 ? { width: p.width } : {}),
			...(p.height > 0 ? { height: p.height } : {}),
			...(p.fps > 0 ? { fps: p.fps } : {}),
		};
	});
	return {
		slug: input.slug,
		beatId: input.beatId.toUpperCase(),
		trackSt: r3(input.trackSt),
		trackEd: r3(input.trackEd),
		items,
		skipped: [],
	};
}

// ───────────────────────── swap：结构等价断言 ─────────────────────────

/** 时长容差（毫秒）。与 `clock-adapter` 对外部 manifest 的容差同值：无帧率可谈时退整毫秒。 */
export const SWAP_DUR_TOL_MS = 1;

/**
 * 帧率容差（相对差）。
 *
 * 只用来吸收**同一个帧率**求值出来的浮点噪声（`30000/1001` 两次求值的末位差），
 * **MUST NOT 放宽到能把 29.97 和 30 当成一回事**——那两个是真不同的帧率，
 * 相对差 0.1%，8 秒片上就差了约 1 帧。故阈值取 0.05%：噪声进得来，NTSC 与整数帧进不来。
 */
export const SWAP_FPS_TOL_RATIO = 0.0005;

export interface SwapDiff {
	field: "duration" | "width" | "height" | "fps";
	from: number;
	to: number;
	/** 人读差值描述，例如「长 0.5s」。 */
	delta: string;
}

/**
 * 新旧素材是否**结构等价**。
 *
 * 断三项（时长 / 分辨率 / 帧率），不断内容——换成完全不同的画面是允许的，
 * 这正是 `swap` 的用途；命令只保证**换完时间线不动**。
 *
 * ⚠️ MUST NOT 在这里做任何「差一点就放过」的宽容：时长差 40ms 在 30fps 上就是 1 帧，
 * 而 `.gtrk` 的 `materials[].duration` 不会跟着改 ⇒ 末镜越素材，出片才看得见。
 */
export function compareSwapGeometry(from: PackProbe, to: PackProbe): SwapDiff[] {
	const diffs: SwapDiff[] = [];
	const dMs = sec2ms(to.duration) - sec2ms(from.duration);
	if (Math.abs(dMs) > SWAP_DUR_TOL_MS) {
		diffs.push({
			field: "duration",
			from: r3(from.duration),
			to: r3(to.duration),
			delta: `${dMs > 0 ? "长" : "短"} ${r3(Math.abs(dMs) / 1000)}s`,
		});
	}
	if (from.width !== to.width) diffs.push({ field: "width", from: from.width, to: to.width, delta: `${from.width} → ${to.width}` });
	if (from.height !== to.height) diffs.push({ field: "height", from: from.height, to: to.height, delta: `${from.height} → ${to.height}` });
	const fpsBase = from.fps || to.fps;
	if (fpsBase > 0 && Math.abs(to.fps - from.fps) / fpsBase > SWAP_FPS_TOL_RATIO) {
		diffs.push({ field: "fps", from: r3(from.fps), to: r3(to.fps), delta: `${r3(from.fps)} → ${r3(to.fps)}` });
	}
	return diffs;
}

/** 拒绝时的人读原因（每项差多少都说清，MUST NOT 只说「不一致」）。 */
export function swapRejectReason(clipId: string, diffs: ReadonlyArray<SwapDiff>): string {
	const parts = diffs.map((d) => `${d.field} ${d.delta}`);
	return (
		`拒绝替换 ${clipId}：新文件与原素材结构不等价（${parts.join("；")}）。` +
		`时间线上这一镜的时码不会跟着改，强行替换会在出片时越素材或错帧。` +
		`请把新文件导成与原素材同时长同几何，或重跑 ai-drama lay（注意会冲掉该 AI 轨上的手调）。`
	);
}
