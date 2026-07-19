/**
 * MAD 素材文件夹扫描（add-tool-mad，tool-mad spec「素材文件夹扫描与母合成画布推导」）。
 * glob 视频扩展 → 逐个 ffprobe 几何（复用 media.probeGeometry）→ 横竖屏分桶 → 多数决母合成朝向。
 * 探测失败单个文件跳过 + warning，不中断。
 */
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { probeGeometry } from "../media";
import { defaultExtsFor } from "../tool-descriptors";
import type { Orientation, UserVideo } from "./types";

const VIDEO_EXTS = new Set(defaultExtsFor("video") ?? []);

export interface ScanResult {
	videos: UserVideo[];
	orientation: Orientation;
	/** 探测失败被跳过的文件名。 */
	skipped: string[];
}

/** 探测函数签名（默认 probeGeometry，测试可注入）。 */
export type ProbeFn = (path: string, ffmpegPath?: string) => { width: number; height: number; fps: number; duration: number };

/**
 * 扫描文件夹（一层，不递归歧义目录）→ UserVideo[] + 多数决朝向。
 * 无可探测视频 → 抛人话错误（列支持扩展名）。
 */
export function scanFolder(
	dirAbs: string,
	opts: { ffmpegPath?: string; probe?: ProbeFn; warn?: (m: string) => void } = {},
): ScanResult {
	const probe = opts.probe ?? probeGeometry;
	const warn = opts.warn ?? (() => {});
	let entries: string[];
	try {
		entries = readdirSync(dirAbs);
	} catch {
		throw new Error(`素材文件夹不存在或无法读取：${dirAbs}`);
	}
	const files = entries
		.filter((n) => VIDEO_EXTS.has(extname(n).toLowerCase()))
		.map((n) => join(dirAbs, n))
		.filter((p) => {
			try {
				return statSync(p).isFile();
			} catch {
				return false;
			}
		})
		.sort(); // 稳定序（复现）

	const videos: UserVideo[] = [];
	const skipped: string[] = [];
	for (const p of files) {
		try {
			const g = probe(p, opts.ffmpegPath);
			if (!(g.width > 0) || !(g.height > 0)) {
				skipped.push(p);
				warn(`跳过无法探测几何的文件：${p}`);
				continue;
			}
			videos.push({ path: p, width: g.width, height: g.height, duration: g.duration || 0 });
		} catch {
			skipped.push(p);
			warn(`跳过 ffprobe 失败的文件：${p}`);
		}
	}

	if (videos.length === 0) {
		throw new Error(
			`未在「${dirAbs}」发现可用素材视频。支持的扩展名：${[...VIDEO_EXTS].join(" ")}。请确认文件夹内含 3~10 条视频。`,
		);
	}

	const portrait = videos.filter((v) => v.height > v.width).length;
	const orientation: Orientation = portrait > videos.length / 2 ? "portrait" : "landscape";
	return { videos, orientation, skipped };
}

/** 朝向 → 母合成画布（横 1920×1080@30 / 竖 1080×1920@30）。 */
export function masterCanvas(orientation: Orientation): { w: number; h: number; fps: number } {
	return orientation === "portrait" ? { w: 1080, h: 1920, fps: 30 } : { w: 1920, h: 1080, fps: 30 };
}
