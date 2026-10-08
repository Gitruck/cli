/** 高光分析代理直落工程目录并复用；原视频不上传。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { requireFfmpeg, ffprobeJson, runFfmpeg } from "./ffmpeg";
import { probeGeometry } from "./media";

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export interface HighlightInput { artifact: string; duration: number; sourceFingerprint: string; proxySha256: string }

export async function prepareHighlightInput(input: string, out: string, ffmpegPath?: string): Promise<HighlightInput> {
	const source = resolve(input), stat = statSync(source);
	const sourceFingerprint = sha(JSON.stringify([source, stat.size, stat.mtimeMs, "highlight-proxy-v1"]));
	const dir = join(out, ".highlight-analysis");
	await mkdir(dir, { recursive: true });
	const artifact = join(dir, `${sourceFingerprint}.mp4`), manifest = join(dir, `${sourceFingerprint}.json`);
	if (existsSync(artifact) && existsSync(manifest)) {
		const old = JSON.parse(readFileSync(manifest, "utf8")) as HighlightInput;
		if (old.sourceFingerprint === sourceFingerprint && old.proxySha256 === sha(readFileSync(artifact))) return { ...old, artifact };
	}
	const ff = requireFfmpeg(ffmpegPath), geo = probeGeometry(source, ffmpegPath);
	if (!Number.isFinite(geo.duration) || geo.duration <= 3 || geo.duration > 1800) throw new Error("高光分析视频须大于三秒且不超过三十分钟");
	const meta = ffprobeJson(ff.ffprobe, ["-v", "error", "-show_entries", "format=start_time", "-of", "json", source]) as { format?: { start_time?: string } };
	const origin = Number(meta.format?.start_time ?? 0);
	if (!Number.isFinite(origin) || Math.abs(origin) > .001) throw new Error("高光分析暂不接受非零时间原点素材；请沿用语义理解路径");
	const temporary = `${artifact}.${randomUUID()}.tmp.mp4`;
	try {
		await runFfmpeg(ff.ffmpeg, ["-v", "error", "-y", "-i", source, "-map", "0:v:0", "-an",
			"-vf", "setpts=PTS-STARTPTS,fps=4:round=up,scale='if(gt(iw,ih),-2,224)':'if(gt(iw,ih),224,-2)'",
			"-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", "-map_metadata", "-1", "-movflags", "+faststart", temporary]);
		const after = statSync(source);
		if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("生成高光代理时源素材改变，请重试");
		const prepared = { artifact, duration: geo.duration, sourceFingerprint, proxySha256: sha(readFileSync(temporary)) };
		await rename(temporary, artifact);
		await writeFile(manifest, JSON.stringify(prepared, null, 2));
		return prepared;
	} finally { await rm(temporary, { force: true }); }
}

export function highlightRequestId(prepared: HighlightInput, fileId: string): string {
	return sha(JSON.stringify(["video-highlight-v1", prepared.proxySha256, prepared.duration, fileId]));
}

/** 不把空候选、越界时码或旧版跨块混排响应当作成功发现。 */
export function validateHighlightOutput(out: Record<string, any>): void {
	const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
	if (out._meta?.schema_version !== "video-highlight-v1" || out.score_scope !== "per_request"
		|| !finite(out.dur) || out.dur <= 3 || !Array.isArray(out.groups) || !out.groups.length) {
		throw new Error("高光结果版本、时长或分组不匹配，不能用作已验证候选");
	}
	for (const group of out.groups) {
		if (!group || !finite(group.source_start) || !finite(group.source_end) || group.source_start < 0
			|| group.source_end > out.dur + 1e-6 || group.source_end <= group.source_start
			|| !Array.isArray(group.candidates) || !group.candidates.length || !Array.isArray(group.top3) || !group.top3.length) {
			throw new Error("高光候选为空或分组范围非法，请沿用素材理解结果");
		}
		for (const candidate of [...group.candidates, ...group.top3]) {
			if (!candidate || !finite(candidate.start) || !finite(candidate.end) || !finite(candidate.score)
				|| candidate.start < group.source_start || candidate.end > group.source_end + 1e-6
				|| Math.abs(candidate.end - candidate.start - 3) > 1e-6) {
				throw new Error("高光候选时码或分数非法，请沿用素材理解结果");
			}
		}
	}
}
