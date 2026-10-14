/**
 * `clip_keyframes` 维护叶子（change link-long2short-for-cli-camera-move，design D1）。
 *
 * 契约正本：gtrk-contract「clip_keyframes 关键帧通道」——相邻 key 线性插值、端外 hold、`t` 为**轨上秒**
 * （相对 clip 在场起点，不随速度换算）、`0 ≤ t ≤ duration`、同通道严格递增、finite；以及写方义务
 * 「改时序时维持合法」：入点后移 Δ 时全体 `t` 减 Δ，越出 `[0, duration]` 的 key 删除并在被截断的端点
 * 按线性插值补一个 key，切分时两段各自补切点 key、后段平移到自身起点。
 *
 * 纯函数、零依赖、不改入参。客户端联动件对同一组共享向量（`test/fixtures/clip-keyframes-vectors.json`）
 * 各自单测，口径以契约条文为准。
 */

export interface Keyframe {
	t: number;
	v: number;
}

export type ClipKeyframes = Record<string, Keyframe[]>;

/** 契约白名单（封闭集合）：video 七通道、audio 仅 volume。 */
export const VIDEO_KEYFRAME_CHANNELS = ["position_x", "position_y", "scale_x", "scale_y", "rotation", "alpha", "volume"] as const;
export const AUDIO_KEYFRAME_CHANNELS = ["volume"] as const;

/** 补插值 key 与平移后的时间、取值统一保留到 1e-6（微秒 / 百万分之一），免浮点尾差（2.9999999999999996）。 */
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** 线性插值取值；首 key 前 / 末 key 后取端值（hold）。 */
export function valueAt(channel: readonly Keyframe[], t: number): number {
	if (channel.length === 0) throw new Error("空关键帧通道无法取值");
	if (t <= channel[0]!.t) return channel[0]!.v;
	const last = channel[channel.length - 1]!;
	if (t >= last.t) return last.v;
	for (let i = 1; i < channel.length; i++) {
		const a = channel[i - 1]!;
		const b = channel[i]!;
		if (t <= b.t) return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
	}
	return last.v;
}

function retimeChannel(channel: readonly Keyframe[], shift: number, duration: number): Keyframe[] {
	const moved = channel.map((k) => ({ t: round6(k.t - shift), v: k.v }));
	const kept = moved.filter((k) => k.t >= 0 && k.t <= duration);
	if (moved.some((k) => k.t < 0) && !kept.some((k) => k.t === 0)) {
		kept.unshift({ t: 0, v: round6(valueAt(channel, shift)) });
	}
	if (moved.some((k) => k.t > duration) && !kept.some((k) => k.t === duration)) {
		kept.push({ t: round6(duration), v: round6(valueAt(channel, shift + duration)) });
	}
	return kept;
}

/**
 * 改时序：全体 `t − shift`，裁进 `[0, duration]`，被截断的端点补线性插值 key。
 * `shift < 0`（入点前移、片段向前延长）与 `duration` 变长时不截断、key 只平移，端外按端值保持。
 */
export function retime(kf: ClipKeyframes, opts: { shift: number; duration: number }): ClipKeyframes {
	const out: ClipKeyframes = {};
	for (const [prop, channel] of Object.entries(kf)) {
		if (!Array.isArray(channel) || channel.length === 0) continue;
		const next = retimeChannel(channel, opts.shift, opts.duration);
		if (next.length > 0) out[prop] = next;
	}
	return out;
}

/** 切分：切点 `at` 为相对 clip 在场起点的轨上秒；前段 `[0, at]`，后段 `[at, duration]` 平移到自身起点。 */
export function split(kf: ClipKeyframes, at: number, duration: number): [ClipKeyframes, ClipKeyframes] {
	return [retime(kf, { shift: 0, duration: at }), retime(kf, { shift: at, duration: round6(duration - at) })];
}

export interface KeyframeViolation {
	channel: string;
	reason: string;
}

/** 契约合法性：白名单、非空、t/v finite、`0 ≤ t ≤ duration`、严格递增、`alpha ∈ [0,1]`、`volume ≥ 0`。 */
export function validate(kf: unknown, duration: number, kind: "video" | "audio"): KeyframeViolation[] {
	if (kf === undefined) return [];
	if (typeof kf !== "object" || kf === null || Array.isArray(kf)) {
		return [{ channel: "*", reason: "clip_keyframes 必须为对象" }];
	}
	const allowed: readonly string[] = kind === "audio" ? AUDIO_KEYFRAME_CHANNELS : VIDEO_KEYFRAME_CHANNELS;
	const out: KeyframeViolation[] = [];
	for (const [prop, channel] of Object.entries(kf as Record<string, unknown>)) {
		if (!allowed.includes(prop)) {
			out.push({ channel: prop, reason: `不在${kind === "audio" ? "音频" : "视频"}片段白名单 ${allowed.join("/")}` });
			continue;
		}
		if (!Array.isArray(channel) || channel.length === 0) {
			out.push({ channel: prop, reason: "必须为非空数组" });
			continue;
		}
		let prev = -Infinity;
		for (const [i, key] of channel.entries()) {
			const t = (key as Keyframe | null)?.t;
			const v = (key as Keyframe | null)?.v;
			if (typeof t !== "number" || typeof v !== "number" || !Number.isFinite(t) || !Number.isFinite(v)) {
				out.push({ channel: prop, reason: `第 ${i} 个 key 的 t/v 不是有限数` });
				break;
			}
			if (t < 0 || t > duration + 1e-9) {
				out.push({ channel: prop, reason: `第 ${i} 个 key 的 t=${t} 越出 [0, ${duration}]` });
				break;
			}
			if (t <= prev) {
				out.push({ channel: prop, reason: `第 ${i} 个 key 的 t=${t} 未严格递增` });
				break;
			}
			if (prop === "alpha" && (v < 0 || v > 1)) {
				out.push({ channel: prop, reason: `第 ${i} 个 key 的 alpha=${v} 越出 [0, 1]` });
				break;
			}
			if (prop === "volume" && v < 0) {
				out.push({ channel: prop, reason: `第 ${i} 个 key 的 volume=${v} 为负` });
				break;
			}
			prev = t;
		}
	}
	return out;
}

/**
 * 对一个 clip 原地维护关键帧：`shift` / `duration` 语义同 `retime`；结果为空时删 `clip_keyframes` 键。
 * clip 不带关键帧时不碰（零回归：无关键帧的工程逐字节不变）。
 */
export function retimeClipKeyframes(clip: Record<string, unknown>, shift: number, duration: number): void {
	const kf = clip.clip_keyframes as ClipKeyframes | undefined;
	if (kf === undefined) return;
	const next = retime(kf, { shift, duration });
	if (Object.keys(next).length > 0) clip.clip_keyframes = next;
	else delete clip.clip_keyframes;
}

export function hasClipKeyframes(clip: Record<string, unknown>): boolean {
	return clip.clip_keyframes !== undefined;
}
