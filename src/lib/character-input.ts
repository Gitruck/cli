/** 角色分析的原片时间表；复用索引信号，不复用 B-roll 的短镜头合并。 */
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sec2ms } from "./frame-domain";
import { detectCutsFromScores, runScenePassWithFallback, fileBlake3Hex } from "./local-index";
import { compressCharacterAnalysisProxy, probeGeometry } from "./media";
import { ffprobeJson, requireFfmpeg } from "./ffmpeg";

export interface CharacterManifest {
	version: "character_source.v1";
	asset_id: string;
	duration_ms: number;
	pts_origin_ms: number;
	proxy_origin_ms: number;
	shots: Array<{ id: string; start_ms: number; end_ms: number }>;
	black_ranges: Array<{ start_ms: number; end_ms: number }>;
}

/** 保留强切点，另收局部背景之上的低对比切点；不修改共享索引阈值。 */
export function characterCutsFromScores(frames: Array<{ ts: number; score: number }>): number[] {
	const cuts = new Set(detectCutsFromScores(frames));
	const candidates = new Set(detectCutsFromScores(frames, 0.08));
	let left = 0, right = 0;
	for (let i = 0; i < frames.length; i++) {
		const f = frames[i]!;
		while (left < i && frames[left]!.ts < f.ts - 0.5) left++;
		while (right < frames.length && frames[right]!.ts <= f.ts + 0.5) right++;
		if (cuts.has(f.ts) || !candidates.has(f.ts)) continue;
		const neighbours = frames.slice(left, right).filter((_, j) => left + j !== i).map(v => v.score).sort((a, b) => a - b);
		if (!neighbours.length) continue;
		const middle = Math.floor(neighbours.length / 2);
		const median = neighbours.length % 2 ? neighbours[middle]! : (neighbours[middle - 1]! + neighbours[middle]!) / 2;
		if (f.score >= 4 * Math.max(0.02, median)) cuts.add(f.ts);
	}
	return [...cuts].sort((a, b) => a - b);
}

export function characterManifest(
	asset: string, duration: number, cuts: number[], blacks: Array<{ st: number; ed: number }>, origin = 0,
): CharacterManifest {
	if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法确定原片时长");
	const duration_ms = sec2ms(duration);
	const marks = [...new Set([0, duration_ms, ...cuts.map((t) => sec2ms(t)),
		...blacks.flatMap((b) => [sec2ms(b.st), sec2ms(b.ed)])])]
		.filter((t) => Number.isFinite(t) && t >= 0 && t <= duration_ms).sort((a, b) => a - b);
	return {
		version: "character_source.v1", asset_id: asset, duration_ms, pts_origin_ms: origin, proxy_origin_ms: 0,
		shots: marks.slice(0, -1).map((start_ms, i) => ({ id: `s${String(i + 1).padStart(5, "0")}`, start_ms, end_ms: marks[i + 1]! })),
		black_ranges: blacks.map((b) => ({ start_ms: Math.max(0, sec2ms(b.st)), end_ms: Math.min(duration_ms, sec2ms(b.ed)) })),
	};
}

export async function prepareCharacterInput(input: string, outDir: string, ffmpegPath?: string, onProgress?: (s: string) => void) {
	const { ffmpeg, ffprobe } = requireFfmpeg(ffmpegPath);
	const geo = probeGeometry(input, ffmpegPath);
	const meta = ffprobeJson(ffprobe, ["-v", "error", "-show_entries", "format=start_time,duration", "-of", "json", input]) as { format?: { start_time?: string } };
	const origin = sec2ms(Number(meta.format?.start_time ?? 0));
	if (!Number.isFinite(origin)) throw new Error("无法确定原片时间原点");
	let sourceDuration = geo.duration;
	if (origin !== 0) {
		// 非零 PTS 时，MKV format.duration 可能是终点，MP4 却是时长；不能统一做减法。
		const packets = ffprobeJson(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_packets",
			"-show_entries", "packet=pts_time,duration_time", "-of", "json", input]) as { packets?: Array<{ pts_time?: string; duration_time?: string }> };
		const tail = (packets.packets ?? []).reduce((last, p) => Math.max(last, Number(p.pts_time) + Number(p.duration_time ?? 0)), -Infinity);
		sourceDuration = tail - origin / 1000;
		if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error("非零 PTS 原片无法确定完整播放时长");
	}
	const asset = await fileBlake3Hex(input);
	const dir = join(outDir, ".character-analysis");
	await mkdir(dir, { recursive: true });
	const manifestPath = join(dir, `${asset}.source-v2.json`);
	let manifest: CharacterManifest;
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		if (manifest.version !== "character_source.v1" || manifest.asset_id !== asset || !manifest.shots?.length) throw new Error("角色索引缓存格式错误");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		onProgress?.("建立原片镜头索引…");
		let lastTick = 0;
		const detection = await runScenePassWithFallback(ffmpeg, input, sourceDuration, geo.avgFps ?? geo.fps,
			{ lane: "cpu_proxy", onTick: (message) => {
				if (Date.now() - lastTick >= 2000) { lastTick = Date.now(); onProgress?.(message); }
			} });
		manifest = characterManifest(asset, sourceDuration, characterCutsFromScores(detection.frames), detection.blackSpans, origin);
		const tmp = `${manifestPath}.${randomUUID()}.tmp`;
		try { await writeFile(tmp, JSON.stringify(manifest)); await rename(tmp, manifestPath); }
		finally { await rm(tmp, { force: true }); }
	}
	if (manifest.shots.length > 20000) throw new Error("镜头数超过单任务上限20000，请分段分析");
	onProgress?.(`原片 ${manifest.shots.length} 个镜头；生成分析代理…`);
	const artifact = await compressCharacterAnalysisProxy(input, ffmpegPath, join(dir, `${asset}.proxy-v2.mkv`));
	// AAC priming 在不同 ffprobe 版本下会让容器起点显示为 -64ms；画面时钟以视频流为准。
	const proxy = ffprobeJson(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=start_time:format=duration", "-of", "json", artifact]) as { format?: { duration?: string }; streams?: Array<{ start_time?: string }> };
	manifest.proxy_origin_ms = sec2ms(Number(proxy.streams?.[0]?.start_time));
	const tail = Number(proxy.format?.duration) * 1000;
	if (!Number.isFinite(tail) || !Number.isFinite(manifest.proxy_origin_ms) || Math.abs(tail - manifest.duration_ms) > 1000 || Math.abs(manifest.proxy_origin_ms) > 1) {
		throw new Error("角色分析代理的起点/时长与原片不一致，禁止上传");
	}
	return { artifact, manifest };
}
