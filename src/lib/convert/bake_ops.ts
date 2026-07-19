/**
 * 时序算子烘焙（MAD add-tool-mad D7 / ir-convert-library「时序算子烘焙」requirement）。
 *
 * 语义真相源 = gitruck-creation/tools/ops_runtime.py::procedural_ops（+ flicker 在同文件的 css 段）。
 * 本模块把 shake/pulsate/oscillate/zoom/flicker 的参数轨**复现参考实现的采样时刻序列**烘成绝对关键帧，
 * 供 ir_to_jsx 用 setValuesAtTimes 批量写入。纯函数、无副作用，便于逐点数值对拍（tasks 4.5）。
 *
 * 采样规则（照抄参考实现，不按合成 fps 重采样）：
 *   shake      n=min(max(2, ⌊(t1−t0)·freq⌋), 160)          freq∈[1,40] 默认 20
 *   oscillate  rot 档 ×4 帽 120 / 位移档 ×4 帽 160           freq rot∈[0.2,20] 位移∈[0.2,30]
 *   pulsate    ×4 帽 160                                     freq∈[0.2,20] 默认 2
 *   flicker    ×2 帽 160，freq<0.5 时 freq×30 归一            freq clamp[0.5,20] 默认 8
 *   zoom       参数轨回放（无 freq），tracks.scale 逐段回放
 *
 * 与基轨合成（绝对值）：采样时刻先求基轨插值，再叠算子偏移——
 *   shake/oscillate 位移 = 加法；pulsate/zoom 缩放 = 乘法（deliberate deviation ①，保基轨形状）。
 *   shake 按 off(t)−off(t0) 归零（deliberate deviation ②，消除 y 通道 cos(0)=1 的常量偏移）。
 * 生效窗 [t0,t1] 外不写帧；窗内基轨帧由 ir_to_jsx 抑制、窗界补基轨锚点（见 ir_to_jsx 合并逻辑）。
 */
import type { IRAnim, IRFx, IRKeyframe, IRLayer } from "./types";
import { num } from "./types";

/** 时序算子集（烘焙目标）；zoom/stretch 为参数轨回放语义、其余为采样烘焙。 */
export const TIME_DOMAIN_OPS = new Set(["shake", "pulsate", "oscillate", "flicker", "zoom"]);

/** 参考实现 _sample：单参数轨线性采样（振幅调制用）。track 为空→default。 */
export function sampleTrack(track: IRKeyframe[] | undefined, t: number, def: number): number {
	if (!track || track.length === 0) return def;
	if (t <= track[0].t) return num(track[0].v, def);
	for (let i = 1; i < track.length; i++) {
		const a = track[i - 1];
		const b = track[i];
		if (t <= b.t) {
			const span = Math.max(b.t - a.t, 1e-6);
			const k = (t - a.t) / span;
			return num(a.v, def) + (num(b.v, def) - num(a.v, def)) * k;
		}
	}
	return num(track[track.length - 1].v, def);
}

/** 参考实现 _phase_pair(i)：确定性伪随机相位对（无真随机）。 */
function phasePair(i: number): [number, number] {
	return [Math.sin(i * 2.399), Math.cos(i * 3.11)];
}

const round = (v: number, p: number): number => {
	const k = 10 ** p;
	return Math.round(v * k) / k;
};
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** 参考实现 _dn（DENSITY=1）：max(2, ⌊n⌋)。 */
const dn = (n: number): number => Math.max(2, Math.floor(n));

// ---------------------------------------------------------------- 基轨采样

/** 层基轨在时刻 t 的位置插值（x/y 独立通道，缺省=home pos）。 */
function basePos(anim: IRAnim, pos: [number, number], t: number): [number, number] {
	return [sampleTrack(anim.x, t, pos[0]), sampleTrack(anim.y, t, pos[1])];
}

/** 层基轨在时刻 t 的缩放倍数插值（scale 单轨 / sx,sy 双轨，缺省=1）。 */
function baseScale(anim: IRAnim, t: number): [number, number] {
	if (anim.scale?.length) {
		const s = sampleTrack(anim.scale, t, 1);
		return [s, s];
	}
	if (anim.sx?.length || anim.sy?.length) {
		return [sampleTrack(anim.sx, t, 1), sampleTrack(anim.sy, t, 1)];
	}
	return [1, 1];
}

/** 层基轨在时刻 t 的旋转插值（度，缺省 0）。 */
function baseRot(anim: IRAnim, t: number): number {
	return sampleTrack(anim.rot, t, 0);
}

// ---------------------------------------------------------------- 烘焙产物

export type BakeProp = "position" | "scale" | "rotation" | "brightness";

/** 一条烘焙轨：绝对关键帧序列 + 生效窗（供 ir_to_jsx 抑制窗内基轨帧、补窗界锚点）。 */
export interface BakedTrack {
	prop: BakeProp;
	/** 采样时刻（颗粒绝对秒，升序）。 */
	times: number[];
	/** position→[x,y]（画布 px）；scale→[sx,sy]（AE 百分数）；rotation→度；brightness→亮度滑杆值。 */
	values: number[][];
	/** 生效窗 [t0,t1]（秒）。 */
	window: [number, number];
	/** zoom/stretch 参数轨回放：段间 ease（power2.out 近似）；采样烘焙轨为 undefined（线性）。 */
	ease?: "power2.out";
}

export interface BakeResult {
	tracks: BakedTrack[];
	warnings: string[];
}

/** 解析算子生效窗（fx.t0/t1 缺省用层在场区间）。 */
function opWindow(fx: IRFx, ly: IRLayer): [number, number] {
	const t0 = num(fx.t0, num(ly.in, 0));
	const t1 = num(fx.t1, num(ly.out, t0 + 1));
	return [t0, t1];
}

/**
 * 烘焙一层的全部时序算子 → 绝对关键帧轨集合。
 * 每个算子生效窗独立成轨；同属性多算子由 ir_to_jsx 合并时按窗处理（本模块不跨窗合并）。
 */
export function bakeLayerOps(ly: IRLayer): BakeResult {
	const anim = ly.anim ?? {};
	const pos: [number, number] = [num(ly.pos?.[0], 0), num(ly.pos?.[1], 0)];
	const tracks: BakedTrack[] = [];
	const warnings: string[] = [];

	for (const fx of ly.fx ?? []) {
		const op = fx.op;
		if (!TIME_DOMAIN_OPS.has(op)) continue;

		if (op === "zoom") {
			const tr = fx.tracks?.scale;
			if (!tr || tr.length < 1) {
				warnings.push(`bake: zoom 无 scale 参数轨，跳过（layer ${ly.id}）`);
				continue;
			}
			// 参数轨回放：在轨关键帧时刻烘焙 scale% = 基轨缩放 × 轨值 × 100（乘法合成 deviation ①）
			const times: number[] = [];
			const values: number[][] = [];
			for (const k of tr) {
				const t = num(k.t, 0);
				const v = num(k.v, 1);
				const [bx, by] = baseScale(anim, t);
				times.push(round(t, 3));
				values.push([round(bx * v * 100, 3), round(by * v * 100, 3)]);
			}
			const w: [number, number] = [times[0], times[times.length - 1]];
			tracks.push({ prop: "scale", times, values, window: w, ease: "power2.out" });
			continue;
		}

		const [t0, t1] = opWindow(fx, ly);
		if (op === "flicker") {
			// flicker 生效窗判据：t1−t0 ≥ 0.05（参考实现 css 段）
			if (t1 - t0 < 0.05) continue;
			let freq = num(fx.freq, 8);
			freq = clamp(freq >= 0.5 ? freq : freq * 30, 0.5, 20);
			const mag = clamp(num(fx.mag, 0.6), 0.05, 1.0);
			const hi = 1 + mag * 0.8;
			const lo = Math.max(0.3, 1 - mag * 0.6);
			const n = Math.min(dn(Math.max(2, Math.floor((t1 - t0) * freq * 2))), 160);
			const times: number[] = [round(t0, 3)];
			const values: number[][] = [[0]]; // t0：brightness 0（v=1）
			for (let j = 1; j <= n; j++) {
				const tt = t0 + ((t1 - t0) * j) / n;
				const v = j % 2 ? hi : lo; // 参考实现：j 奇=hi、偶=lo
				// 乘性亮度系数 v → AE 加性亮度滑杆：Brightness ≈ (v−1)×100，截 ±100
				const b = clamp((v - 1) * 100, -100, 100);
				times.push(round(tt, 3));
				values.push([round(b, 3)]);
			}
			tracks.push({ prop: "brightness", times, values, window: [t0, t1] });
			continue;
		}

		if (t1 - t0 < 0.05) continue;

		if (op === "shake") {
			const amp0 = num(fx.mag ?? fx.amp, 18);
			const freq = clamp(num(fx.freq, 20), 1, 40);
			const n = Math.min(dn(Math.max(2, Math.floor((t1 - t0) * freq))), 160);
			const tr = fx.tracks?.mag;
			// 先按参考实现算 seq（round(a·px,1)），再 off(t)−off(t0) 归零（deviation ②）
			const seqX: number[] = [];
			const seqY: number[] = [];
			const ttArr: number[] = [];
			for (let i = 0; i <= n; i++) {
				const tt = t0 + ((t1 - t0) * i) / n;
				let a = sampleTrack(tr, tt, amp0);
				if (fx.decay) a *= 1 - i / n;
				const [px, py] = phasePair(i);
				seqX.push(round(a * px, 1));
				seqY.push(round(a * py, 1));
				ttArr.push(round(tt, 3));
			}
			const off0x = seqX[0];
			const off0y = seqY[0];
			const times: number[] = [];
			const values: number[][] = [];
			for (let i = 0; i <= n; i++) {
				const [bx, by] = basePos(anim, pos, ttArr[i]);
				times.push(ttArr[i]);
				values.push([round(bx + (seqX[i] - off0x), 3), round(by + (seqY[i] - off0y), 3)]);
			}
			tracks.push({ prop: "position", times, values, window: [t0, t1] });
			continue;
		}

		if (op === "oscillate") {
			if (fx.rot === true) {
				const a1 = num(fx.a1, -3);
				const a2 = num(fx.a2, 3);
				const freq = clamp(num(fx.freq, 2), 0.2, 20);
				const n = Math.min(dn(Math.max(4, Math.floor((t1 - t0) * freq * 4))), 120);
				const times: number[] = [round(t0, 3)];
				const values: number[][] = [[round(baseRot(anim, t0), 3)]]; // 窗界基轨锚点
				let prev = 0;
				let acc = 0;
				for (let i = 1; i <= n; i++) {
					const tt = t0 + ((t1 - t0) * i) / n;
					const ph = Math.sin(2 * Math.PI * freq * (tt - t0));
					const cur = (a1 + a2) / 2 + ((a2 - a1) / 2) * ph;
					acc += round(cur - prev, 2); // 参考实现累积（prev=cur 未舍入）
					prev = cur;
					times.push(round(tt, 3));
					values.push([round(baseRot(anim, tt) + acc, 3)]);
				}
				tracks.push({ prop: "rotation", times, values, window: [t0, t1] });
			} else {
				const mag0 = num(fx.mag, 40);
				const ang = (num(fx.angle, 90) * Math.PI) / 180;
				const freq = clamp(num(fx.freq, 4), 0.2, 30);
				const n = Math.min(dn(Math.max(4, Math.floor((t1 - t0) * freq * 4))), 160);
				const tr = fx.tracks?.mag;
				const times: number[] = [round(t0, 3)];
				const [b0x, b0y] = basePos(anim, pos, t0);
				const values: number[][] = [[round(b0x, 3), round(b0y, 3)]]; // 窗界基轨锚点
				let prevX = 0;
				let prevY = 0;
				let accX = 0;
				let accY = 0;
				for (let i = 1; i <= n; i++) {
					const tt = t0 + ((t1 - t0) * i) / n;
					const a = sampleTrack(tr, tt, mag0);
					const ph = Math.sin(2 * Math.PI * freq * (tt - t0));
					const curX = a * ph * Math.cos(ang);
					const curY = a * ph * Math.sin(ang);
					accX += round(curX - prevX, 2);
					accY += round(curY - prevY, 2);
					prevX = curX;
					prevY = curY;
					const [bx, by] = basePos(anim, pos, tt);
					times.push(round(tt, 3));
					values.push([round(bx + accX, 3), round(by + accY, 3)]);
				}
				tracks.push({ prop: "position", times, values, window: [t0, t1] });
			}
			continue;
		}

		if (op === "pulsate") {
			let lo: number;
			let hi: number;
			if (fx.amp != null) {
				lo = 1 - num(fx.amp, 0);
				hi = 1 + num(fx.amp, 0);
			} else {
				lo = num(fx.min, 1);
				hi = num(fx.max, 1.06);
			}
			const freq = clamp(num(fx.freq, 2), 0.2, 20);
			const n = Math.min(dn(Math.max(4, Math.floor((t1 - t0) * freq * 4))), 160);
			const tr = fx.tracks?.max;
			const times: number[] = [round(t0, 3)];
			const [bs0x, bs0y] = baseScale(anim, t0);
			const values: number[][] = [[round(bs0x * 100, 3), round(bs0y * 100, 3)]]; // 窗界基轨锚点（乘子=lo 起点近似基轨）
			for (let i = 1; i <= n; i++) {
				const tt = t0 + ((t1 - t0) * i) / n;
				const h = sampleTrack(tr, tt, hi);
				const ph = (Math.sin(2 * Math.PI * freq * (tt - t0)) + 1) / 2;
				const s = round(lo + (Math.max(h, lo) - lo) * ph, 3); // 参考实现 scale 乘子
				const [bx, by] = baseScale(anim, tt);
				times.push(round(tt, 3));
				values.push([round(bx * s * 100, 3), round(by * s * 100, 3)]); // 乘法合成 deviation ①
			}
			tracks.push({ prop: "scale", times, values, window: [t0, t1] });
			continue;
		}
	}
	return { tracks, warnings };
}
