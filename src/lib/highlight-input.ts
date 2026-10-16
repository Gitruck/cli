/** 高光分析代理直落工程目录并复用；原视频不上传。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { requireFfmpeg, ffprobeJson, runFfmpeg } from "./ffmpeg";
import { probeGeometry } from "./media";

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export interface HighlightInput {
	artifact: string; duration: number; sourceFingerprint: string; proxySha256: string; proxySpec: string; audio: boolean;
}

/**
 * v2 分析代理（link-video-highlight-analysis-proxy-cli）：短边 448、4fps、libx264 veryfast CRF 28，
 * 可带一路单声道 AAC。编码器与 CRF 同属规格——自研打分对有损压缩敏感（主件 design §3）。
 * 2026-10-16 主理人由 CRF 22 改定 28（上传体积约减半，全量 top1 仍 18/18 落在 top3，top1 同窗 15→10，
 * 实测见主件 design 附录 C），再调整须先按主件实验重测。下列判定条件与服务端 `classify_proxy` 逐项对表。
 */
export const HIGHLIGHT_PROXY_SPEC = "v2";
const SHORT_SIDE = 448, LONG_SIDE_MAX = 4096, FPS = 4, CRF = "28";
const AUDIO_RATE = 16000, AUDIO_RATE_RANGE = [16000, 48000], AUDIO_MAX_BIT_RATE = 64000, DURATION_TOLERANCE = .26;

interface ProbeStream { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string;
	channels?: number; sample_rate?: string; bit_rate?: string }
export interface ProxyProbe { streams?: ProbeStream[]; format?: { duration?: string; start_time?: string } }

const ratio = (text?: string) => {
	const [num, den = "1"] = String(text ?? "").split("/");
	return Number(num) / Number(den);
};

/** 返回不合规原因，合规返回 null；上传前自检，不合规就不传。 */
export function checkHighlightProxy(probe: ProxyProbe, duration: number): string | null {
	const streams = probe.streams ?? [];
	const videos = streams.filter(s => s.codec_type === "video"), audios = streams.filter(s => s.codec_type === "audio");
	if (videos.length !== 1) return "须恰有一路视频";
	const [video] = videos, width = video!.width ?? 0, height = video!.height ?? 0;
	if (Math.min(width, height) !== SHORT_SIDE || Math.max(width, height) > LONG_SIDE_MAX) return `短边须为${SHORT_SIDE}像素`;
	if (video!.codec_name !== "h264") return "须为 H.264";
	if (!(Math.abs(ratio(video!.avg_frame_rate) - FPS) <= .001)) return `须为${FPS}fps`;
	if (!(Math.abs(Number(probe.format?.start_time ?? 0)) <= .001)) return "时间须从零开始";
	if (!(Math.abs(Number(probe.format?.duration) - duration) <= DURATION_TOLERANCE)) return "时长与源片不符";
	if (audios.length > 1) return "最多一路音频";
	const audio = audios[0];
	if (audio) {
		const rate = Number(audio.sample_rate), bitRate = Number(audio.bit_rate);
		if (audio.codec_name !== "aac" || audio.channels !== 1) return "音频须为单声道 AAC";
		if (!(rate >= AUDIO_RATE_RANGE[0]! && rate <= AUDIO_RATE_RANGE[1]!) || !(bitRate > 0 && bitRate <= AUDIO_MAX_BIT_RATE)) {
			return "音频须为16–48 kHz、码率不超过64 kbps";
		}
	}
	return null;
}

export async function prepareHighlightInput(input: string, out: string, ffmpegPath?: string,
	{ audio = true }: { audio?: boolean } = {}): Promise<HighlightInput> {
	const source = resolve(input), stat = statSync(source);
	// 编码参数整串进指纹：CRF 等任一参数改动都让旧代理失效、重新生成
	// （2026-10-16 CRF 22 → 28 时发现：只认规格名会让旧 CRF 的缓存代理继续被上传）。
	const encodeParams = highlightProxyArgs("<source>", "<output>", audio).join(" ");
	const sourceFingerprint = sha(JSON.stringify([source, stat.size, stat.mtimeMs, `highlight-proxy-${HIGHLIGHT_PROXY_SPEC}`, audio, encodeParams]));
	const dir = join(out, ".highlight-analysis");
	await mkdir(dir, { recursive: true });
	const artifact = join(dir, `${sourceFingerprint}.mp4`), manifest = join(dir, `${sourceFingerprint}.json`);
	if (existsSync(artifact) && existsSync(manifest)) {
		const old = JSON.parse(readFileSync(manifest, "utf8")) as HighlightInput;
		if (old.sourceFingerprint === sourceFingerprint && old.proxySpec === HIGHLIGHT_PROXY_SPEC
			&& old.proxySha256 === sha(readFileSync(artifact))) return { ...old, artifact };
	}
	const ff = requireFfmpeg(ffmpegPath), geo = probeGeometry(source, ffmpegPath);
	if (!Number.isFinite(geo.duration) || geo.duration <= 3 || geo.duration > 1800) throw new Error("高光分析视频须大于三秒且不超过三十分钟");
	const meta = ffprobeJson(ff.ffprobe, ["-v", "error", "-show_entries", "format=start_time", "-of", "json", source]) as { format?: { start_time?: string } };
	const origin = Number(meta.format?.start_time ?? 0);
	if (!Number.isFinite(origin) || Math.abs(origin) > .001) throw new Error("高光分析暂不接受非零时间原点素材；请沿用语义理解路径");
	const temporary = `${artifact}.${randomUUID()}.tmp.mp4`;
	try {
		// 固定 libx264：本仓没有硬件编码路径，日后加也不得用于此代理（同名参数下画质不可比）。
		// `0:a:0?` 让无音轨源片自然产出无声代理，不必先探测。
		await runFfmpeg(ff.ffmpeg, highlightProxyArgs(source, temporary, audio));
		const after = statSync(source);
		if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("生成高光代理时源素材改变，请重试");
		const probe = ffprobeJson(ff.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", temporary]) as ProxyProbe;
		const problem = checkHighlightProxy(probe, geo.duration);
		if (problem) throw new Error(`本地生成的高光分析代理不合规（${problem}），未上传`);
		const prepared = { artifact, duration: geo.duration, sourceFingerprint, proxySha256: sha(readFileSync(temporary)),
			proxySpec: HIGHLIGHT_PROXY_SPEC, audio: (probe.streams ?? []).some(s => s.codec_type === "audio") };
		await rename(temporary, artifact);
		await writeFile(manifest, JSON.stringify(prepared, null, 2));
		return prepared;
	} finally { await rm(temporary, { force: true }); }
}

/** v2 代理的 ffmpeg 参数（导出供测试断言编码器与 CRF）。 */
export function highlightProxyArgs(source: string, output: string, audio: boolean): string[] {
	return ["-v", "error", "-y", "-i", source, "-map", "0:v:0",
		"-vf", `setpts=PTS-STARTPTS,fps=${FPS}:round=up,scale='if(gt(iw,ih),-2,${SHORT_SIDE})':'if(gt(iw,ih),${SHORT_SIDE},-2)':flags=lanczos`,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", CRF, "-pix_fmt", "yuv420p",
		...(audio ? ["-map", "0:a:0?", "-c:a", "aac", "-ac", "1", "-ar", String(AUDIO_RATE), "-b:a", "32k"] : ["-an"]),
		"-map_metadata", "-1", "-movflags", "+faststart", output];
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
