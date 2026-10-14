/**
 * gtrk clip 恒定变速字段的 CLI 侧**唯一**取数入口（openspec: link-gtrk-clip-speed，capability `gtrk-clip-speed`）。
 *
 * 契约正本：gitruck-infra `openspec/specs/gtrk-contract/spec.md`「clip 恒定变速字段（speed / keep_pitch）」，
 * 散文 `docs/composition-contract-v1.md` §3.5。要点：
 *   - `speed` 缺省 ≡ 1，`keep_pitch` 缺省 ≡ false；
 *   - `duration` 是**轨上**时长，源跨度 = `duration × speed`，整毫秒判据
 *     `clip_ed_ms − clip_st_ms === Math.round(duration_ms × speed)`（infra 侧 `js_round` 同义）；
 *   - 有声变速上限 5x：`speed > 5` 的 clip 在本系统渲染方静音（infra `MAX_AUDIBLE_SPEED`、客户端
 *     `MAX_AUDIBLE_RETIME_RATE` 同值）。
 *
 * 自检、patch、pip、projection、render、QC 一律调本模块，MUST NOT 内联 `duration × speed`——
 * 收敛到单一映射函数后，将来曲线变速只改这里。依赖面：只 import `frame-domain`（零 IO 换算叶子）。
 */
import { sec2ms } from "./frame-domain";

export const SPEED_DEFAULT = 1;
/** 有声变速上限：speed > 5 静音，恰为 5 仍有声。三仓同值。 */
export const MAX_AUDIBLE_SPEED = 5;

/** clip 上可能携带变速字段的最小形状（gtrk JSON 是外部可写的不可信输入，取值一律守卫）。 */
export interface SpeedLike {
	speed?: unknown;
	keep_pitch?: unknown;
}

/** clip 的恒定速度；缺席 / 非有限数 / 非正数 ≡ 1（合法性由写方与 infra API 保证，这里只做读侧兜底）。 */
export function clipSpeed(c: SpeedLike): number {
	const s = c.speed;
	return typeof s === "number" && Number.isFinite(s) && s > 0 ? s : SPEED_DEFAULT;
}

/** 变速时是否保持音高：严格 `=== true`。 */
export function clipKeepPitch(c: SpeedLike): boolean {
	return c.keep_pitch === true;
}

/** 是否变速（speed ≠ 1）。不变速的 clip 各处 MUST 走改动前的原路径（零回归）。 */
export function isSpeedChanged(c: SpeedLike): boolean {
	return clipSpeed(c) !== SPEED_DEFAULT;
}

/** 本系统渲染方是否出声：speed ≤ 5。 */
export function isSpeedAudible(c: SpeedLike): boolean {
	return clipSpeed(c) <= MAX_AUDIBLE_SPEED;
}

/** 轨上整数量（ms / 帧）→ 源侧整数量：`Math.round(value × speed)`；不变速原样返回。 */
export function scaleBySpeed(value: number, c: SpeedLike): number {
	return isSpeedChanged(c) ? Math.round(value * clipSpeed(c)) : value;
}

/** 源侧整数量 → 轨上整数量：`Math.round(value ÷ speed)`；不变速原样返回。用于源余量换算到轨上。 */
export function unscaleBySpeed(value: number, c: SpeedLike): number {
	return isSpeedChanged(c) ? Math.round(value / clipSpeed(c)) : value;
}

/** 源跨度（整毫秒）= `Math.round(duration_ms × speed)`；契约源侧恒等式的右侧。 */
export function clipSourceSpanMs(c: SpeedLike & { duration: number }): number {
	return scaleBySpeed(sec2ms(c.duration), c);
}

/**
 * 速度写进 ffmpeg 滤镜串的唯一格式：整数写整数，否则最短往返十进制（`String(n)`）。
 * 与 infra `video_timeline_render.format_speed` 逐字节一致（对拍向量正本：gitruck-infra
 * `openspec/changes/add-gtrk-clip-speed/vectors/clip-speed-filter-vectors.md`）。
 */
export function formatSpeed(speed: number): string {
	return String(speed);
}

/** 保调变速的 `atempo` 级联因子：每级落在 [0.5, 2]，乘积 = speed（除 2 / 乘 2 在二进制下精确）。与 infra 同算法。 */
export function atempoFactors(speed: number): number[] {
	const factors: number[] = [];
	let remaining = speed;
	while (remaining > 2) {
		factors.push(2);
		remaining /= 2;
	}
	while (remaining < 0.5) {
		factors.push(0.5);
		remaining *= 2;
	}
	factors.push(remaining);
	return factors;
}
