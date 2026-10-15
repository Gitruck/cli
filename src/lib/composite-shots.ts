/**
 * 素材观察（change add-composite-layer，design D7）：给 own 槽位选片用——联系表、镜头切点、黑边实测。
 * 只观察、不替调用方选片、不改工程。本文件是纯函数：拼 ffmpeg 参数、解析它的输出。
 *
 * 为什么要切点：own 槽位的取用段 `[src_in, src_in + 在场时长)` 跨过切点，画面中途会换成别的镜头
 * （测试工程走查：服装店那段后面紧跟一个模糊转场）。为什么要黑边：电影源常带信箱黑边，
 * 不裁就在画框里留一道黑带（测试工程 cp05 第一版）。
 */

import { r3 } from "./frame-domain";

/** ffmpeg 场景分阈值（原型实测：综艺 / 电影混剪源 0.25 能分出硬切，又不把运动镜头误判成切点）。 */
export const SCENE_THRESHOLD = 0.25;

export function sceneCutArgs(file: string, from: number, dur: number, threshold = SCENE_THRESHOLD): string[] {
	return ["-hide_banner", "-nostats", "-ss", String(from), "-t", String(dur), "-i", file, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"];
}

/** showinfo 行里的 `pts_time:` → 源时间（加回 `-ss` 起点，三位小数，去重升序）。 */
export function parseSceneCuts(stderr: string, from: number): number[] {
	const out = new Set<number>();
	for (const m of stderr.matchAll(/pts_time:\s*([0-9.]+)/g)) out.add(r3(from + Number(m[1])));
	return [...out].sort((a, b) => a - b);
}

export function cropDetectArgs(file: string, at: number, dur = 3): string[] {
	return ["-hide_banner", "-nostats", "-ss", String(at), "-t", String(dur), "-i", file, "-vf", "cropdetect=24:2:0", "-an", "-f", "null", "-"];
}

export interface CropFinding {
	/** `data-crop` 用的比例：上、右、下、左。 */
	crop: [number, number, number, number];
	/** ffmpeg 原文 `w:h:x:y`。 */
	raw: string;
	/** 有可见黑边（任一边 ≥ 1%）。 */
	bars: boolean;
}

/** cropdetect 的众数结果 → 四边比例；没有输出时视为无黑边。 */
export function parseCropDetect(stderr: string, width: number, height: number): CropFinding {
	const counts = new Map<string, number>();
	for (const m of stderr.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
	if (!counts.size || !(width > 0 && height > 0)) return { crop: [0, 0, 0, 0], raw: "", bars: false };
	const raw = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
	const [w, h, x, y] = raw.split(":").map(Number);
	const r = (v: number) => Math.max(0, r3(v));
	const crop: [number, number, number, number] = [r(y / height), r((width - x - w) / width), r((height - y - h) / height), r(x / width)];
	return { crop, raw, bars: crop.some((v) => v >= 0.01) };
}

/** 联系表：按间隔取帧、每格压上源时间码、六列平铺，每页 60 格（输出用 `%02d` 页码模式）。 */
export function contactSheetArgs(file: string, from: number, dur: number, every: number, outPattern: string, cols = 6, cellWidth = 360): string[] {
	// 行数按帧数算（一页最多 10 行）：固定 10 行时短范围会留下半页空白
	const rows = Math.max(1, Math.min(10, Math.ceil(Math.ceil(dur / every) / cols)));
	const fontSize = Math.max(14, Math.round(cellWidth / 14));
	const vf = [
		`fps=1/${every}`,
		`scale=${cellWidth}:-2`,
		`drawbox=x=0:y=0:w=iw:h=${fontSize + 8}:color=black@0.55:t=fill`,
		// 时间码 = 源时间（-ss 之后 pts 从 0 起，用 hms 偏移加回起点）
		`drawtext=text='%{pts\\:hms\\:${from}}':x=6:y=4:fontsize=${fontSize}:fontcolor=white`,
		`tile=${cols}x${rows}:padding=4:margin=4:color=0x202020`,
	].join(",");
	return ["-hide_banner", "-nostats", "-y", "-ss", String(from), "-t", String(dur), "-i", file, "-vf", vf, "-an", "-vsync", "vfr", outPattern];
}

/** 观察范围：`--from/--to` 优先；否则 `--around ± span/2`；都没给就整条（太长时截到前 10 分钟并提示）。 */
export function shotsRange(duration: number, o: { from?: number; to?: number; around?: number; span?: number }): { from: number; to: number; clipped: boolean } {
	const clampT = (t: number) => Math.min(Math.max(0, t), duration);
	if (o.from !== undefined || o.to !== undefined) {
		const from = clampT(o.from ?? 0);
		const to = clampT(o.to ?? duration);
		if (!(to > from)) throw new Error(`观察范围为空：${from}–${to}`);
		return { from, to, clipped: false };
	}
	if (o.around !== undefined) {
		const half = (o.span ?? 15) / 2;
		return { from: clampT(o.around - half), to: clampT(o.around + half), clipped: false };
	}
	const cap = 600;
	return { from: 0, to: Math.min(duration, cap), clipped: duration > cap };
}
