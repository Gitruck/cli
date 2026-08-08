/**
 * ffmpeg/ffprobe 运行时：定位 + 调用 + 能力探测。
 *
 * 定位优先级：--ffmpeg-path 显式覆盖 → ~/.gitruck/ffmpeg/{ffmpeg,ffprobe}[.exe] → 系统 PATH。
 * 一律**绝对路径** spawn（系统档除外，用裸名依赖既有 PATH）；**绝不修改用户系统环境变量/PATH**——
 * 尊重用户自装的 ffmpeg。
 *
 * 供给方式（change: add-runtime-asset-mirror，2026-08-08 推翻旧「不自分发」口径）：
 * 可经 `gtrk deps install --ffmpeg` 从同合云自建镜像拉取，落 ~/.gitruck/ffmpeg——
 * **只填第二格，不改变上面的优先级、不越过用户自装的 ffmpeg**。
 * 仍**禁止静默自动下载**：缺失时只报错 + 指引，不自行开始下载。
 * GPL 射程见分发点 SOURCE.md：义务只覆盖被分发的二进制本身，绝对路径 spawn 独立子进程不构成衍生作品。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ffmpegDir } from "./paths";

export interface FfmpegResolution {
	ffmpeg: string;
	ffprobe: string;
	/** 来源：~/.gitruck/ffmpeg | system | <显式 dir> */
	source: string;
}

const isWin = process.platform === "win32";
const bin = (base: string) => (isWin ? `${base}.exe` : base);

/** ffmpeg 缺失时的可执行指引（对用户/agent 展示）。**不自动下载**，指向显式安装入口。 */
export const FFMPEG_INSTALL_HINT =
	`未找到 ffmpeg/ffprobe。装它：gtrk deps install --ffmpeg` +
	`（从同合云镜像拉，自动过 sha256 校验，落 ${ffmpegDir()}；agent 可代办）。\n` +
	`  也可自行把 ffmpeg/ffprobe 放到该目录，或用 --ffmpeg-path <目录> 指定已装位置。`;

const _cache = new Map<string, FfmpegResolution | null>();

function onSystemPath(cmd: string): boolean {
	try {
		return spawnSync(cmd, ["-version"], { stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
}

/** 按优先级定位 ffmpeg/ffprobe；找不到返回 null。结果按 ffmpegPath 入参缓存于进程内。 */
export function resolveFfmpeg(ffmpegPath?: string): FfmpegResolution | null {
	const key = ffmpegPath ?? "";
	if (_cache.has(key)) return _cache.get(key) ?? null;

	const dirs: Array<[string, string]> = []; // [dir, sourceLabel]
	if (ffmpegPath) dirs.push([ffmpegPath, ffmpegPath]);
	dirs.push([ffmpegDir(), "~/.gitruck/ffmpeg"]);

	let found: FfmpegResolution | null = null;
	for (const [dir, label] of dirs) {
		const ff = join(dir, bin("ffmpeg"));
		const fp = join(dir, bin("ffprobe"));
		if (existsSync(ff) && existsSync(fp)) {
			found = { ffmpeg: ff, ffprobe: fp, source: label };
			break;
		}
	}
	if (!found && onSystemPath("ffmpeg") && onSystemPath("ffprobe")) {
		found = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", source: "system" };
	}
	_cache.set(key, found);
	return found;
}

/** 定位并断言存在，否则抛带安装指引的错误。 */
export function requireFfmpeg(ffmpegPath?: string): FfmpegResolution {
	const r = resolveFfmpeg(ffmpegPath);
	if (!r) throw new Error(FFMPEG_INSTALL_HINT);
	return r;
}

/** 同步跑 ffprobe 并解析 JSON（探几何/时长用，输出很小）。 */
export function ffprobeJson(ffprobePath: string, args: string[]): unknown {
	const r = spawnSync(ffprobePath, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	if (r.status !== 0) {
		throw new Error(`ffprobe 失败（code=${r.status}）：${(r.stderr || "").slice(-300)}`);
	}
	return JSON.parse(r.stdout || "{}");
}

/** 跑 ffmpeg（异步，流式），非零退出 reject 并带回 stderr 摘要。onLine 可选，喂 stderr 行做进度。
 * env 用 process.env 原样传入——**不注入/不修改** PATH 或任何变量。 */
export function runFfmpeg(
	ffmpegPath: string,
	args: string[],
	onLine?: (line: string) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(ffmpegPath, args, { env: process.env });
		let tail = "";
		p.stderr.on("data", (buf: Buffer) => {
			const s = buf.toString("utf8");
			tail = (tail + s).slice(-4000);
			if (onLine) for (const ln of s.split(/\r?\n/)) if (ln) onLine(ln);
		});
		p.on("error", (e) => reject(e));
		p.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`ffmpeg 退出码 ${code}：${tail.slice(-600)}`));
		});
	});
}

export interface FfmpegCapabilities {
	version: string;
	encoders: Set<string>;
	filters: Set<string>;
	hasLibx264: boolean;
	hasAac: boolean;
	hasAfade: boolean;
	hasAresample: boolean;
}

/** 探测 ffmpeg 能力（渲染前/doctor 用）：版本 + 关键编码器/滤镜是否具备。 */
export function probeCapabilities(res: FfmpegResolution): FfmpegCapabilities {
	const ver = spawnSync(res.ffmpeg, ["-version"], { encoding: "utf8" });
	const version = (ver.stdout || "").split(/\r?\n/)[0]?.trim() || "unknown";
	const enc = spawnSync(res.ffmpeg, ["-hide_banner", "-encoders"], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	const fil = spawnSync(res.ffmpeg, ["-hide_banner", "-filters"], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	const encoders = new Set<string>();
	for (const ln of (enc.stdout || "").split(/\r?\n/)) {
		const m = ln.trim().match(/^\S+\s+(\S+)/);
		if (m) encoders.add(m[1]);
	}
	const filters = new Set<string>();
	for (const ln of (fil.stdout || "").split(/\r?\n/)) {
		const m = ln.trim().match(/^\S+\s+(\S+)/);
		if (m) filters.add(m[1]);
	}
	return {
		version,
		encoders,
		filters,
		hasLibx264: encoders.has("libx264"),
		hasAac: encoders.has("aac"),
		hasAfade: filters.has("afade"),
		hasAresample: filters.has("aresample"),
	};
}
