/**
 * gtrk render —— 本地渲染：把 gtrk 工程（EDL）用本地 ffmpeg 渲染成片 mp4。
 * 素材取 gtrk materials[].path（原片本地绝对路径）；云端不产成片，成片在本地出。
 *
 * ★ add-render-overlay-compositing：本命令**不再是纯零计费**。工程含 `beat_track`（MG 颗粒）时，
 * 未命中本地缓存的颗粒要走 `html_render_simple` 云渲（按分钟计费）——故有确认闸与 `--no-particles`
 * 逃生舱。命中缓存的不重烤不计费；客户端导出剪映时烤过的颗粒 CLI 直接命中（键与落点同构）。
 * overlay `video_track`（B-roll 候选等）的合成**零计费、纯本地**，不受 `--no-particles` 影响。
 */
import { Command } from "commander";
import { resolve, dirname, join, basename, extname } from "node:path";
import { existsSync } from "node:fs";
import { readGtrkFile, renderGtrk } from "../lib/render";
import {
	prepareParticlesForRender,
	DEFAULT_PARTICLE_CONCURRENCY,
	MIN_PARTICLE_CONCURRENCY,
	MAX_PARTICLE_CONCURRENCY,
} from "../lib/particle-qtrle";
import { runPostRenderQc } from "./qc";
import { openFolder } from "../lib/open";
import { log, routeLogsToStderr } from "../lib/log";

interface RenderOpts {
	out?: string;
	crf?: string;
	codec?: string;
	ffmpegPath?: string;
	open?: boolean;
	json?: boolean;
	qc?: boolean;
	particles?: boolean;
	particleConcurrency?: string;
	yes?: boolean;
}

/** `--particle-concurrency` 解析（纯函数，导出供单测）：非法值报错而非静默吸附。 */
export function parseParticleConcurrency(raw?: string): number | undefined {
	if (raw == null) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < MIN_PARTICLE_CONCURRENCY || n > MAX_PARTICLE_CONCURRENCY) {
		throw new Error(
			`--particle-concurrency 需为 ${MIN_PARTICLE_CONCURRENCY}–${MAX_PARTICLE_CONCURRENCY} 的整数（收到「${raw}」）`,
		);
	}
	return n;
}

export function registerRender(program: Command): void {
	program
		.command("render <gtrk>")
		.description(
			"本地渲染：gtrk 工程按 EDL 用本地 ffmpeg 渲染成片 mp4（素材取原片本地路径）；" +
				"按契约 z 序合成全部可见叠加层（B-roll 等 overlay 轨 + MG 颗粒）。" +
				"⚠️ 未命中缓存的颗粒要云渲**计费**（先预估要确认，--no-particles 可零计费出无颗粒版）",
		)
		.option("-o, --out <file>", "输出 mp4 路径（缺省 = <gtrk 同目录>/<gtrk 名>.mp4）")
		.option("--crf <n>", "视频质量 CRF 14-28（越小越清晰/文件越大，默认 18）")
		.option("--codec <c>", "视频编码（默认 h264）")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录（缺省 ~/.gitruck/ffmpeg → 系统）")
		.option("--no-open", "完成后不自动打开产物目录")
		.option("--no-qc", "跳过渲染后质检（缺省渲完自动扫一遍闪帧/黑帧/爆音等并落 .qc.json）")
		.option("--no-particles", "跳过 MG 颗粒云渲与叠加（零计费出无颗粒版；overlay 视频轨照常合成）")
		.option(
			"--particle-concurrency <n>",
			`颗粒云渲并发 ${MIN_PARTICLE_CONCURRENCY}-${MAX_PARTICLE_CONCURRENCY}（默认 ${DEFAULT_PARTICLE_CONCURRENCY}）`,
		)
		.option("-y, --yes", "跳过颗粒云渲的计费确认")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (gtrk: string, opts: RenderOpts) => {
			if (opts.json) routeLogsToStderr();
			const gtrkAbs = resolve(gtrk);
			if (!existsSync(gtrkAbs)) throw new Error(`gtrk 工程不存在：${gtrkAbs}`);
			const concurrency = parseParticleConcurrency(opts.particleConcurrency);
			const outMp4 = resolve(opts.out ?? join(dirname(gtrkAbs), `${basename(gtrkAbs, extname(gtrkAbs))}.mp4`));

			log.step(`▶ 本地渲染：${basename(gtrkAbs)} → ${basename(outMp4)}`);
			const project = await readGtrkFile(gtrkAbs);

			// ── 颗粒预渲（计费闸在此，**先于任何 ffmpeg 动作**）────────────────────────
			// 拒绝确认 ⇒ 零副作用退出：MUST NOT 已经写了半个 mp4 才问用户要不要花钱。
			const particles = await prepareParticlesForRender(
				project,
				dirname(gtrkAbs),
				{
					noParticles: opts.particles === false,
					...(concurrency != null ? { concurrency } : {}),
					...(opts.yes ? { yes: true } : {}),
					...(opts.json ? { json: true } : {}),
				},
			);
			if (particles.declined) {
				log.warn("已取消渲染（颗粒计费未确认）。要出无颗粒版：加 --no-particles。");
				process.exitCode = 1;
				return;
			}

			const result = await renderGtrk(project, outMp4, {
				crf: opts.crf != null ? Number(opts.crf) : undefined,
				codec: opts.codec,
				ffmpegPath: opts.ffmpegPath,
				gtrkDir: dirname(gtrkAbs),
				particlePaths: particles.paths,
				onLine: (l) => {
					const m = l.match(/time=(\S+)/);
					if (m) log.tick(`渲染中 ${m[1]}`);
				},
			});
			log.tickEnd();
			log.ok(`渲染完成：${outMp4}（${result.duration.toFixed(1)}s）`);

			// 渲后质检（local-ffmpeg-render delta）：同进程复用扫描零件、透传已解析工程做工程感知；
			// 结果只呈现不改变渲染退出语义（硬门控走独立 gtrk qc --fail-on）
			const qc = opts.qc === false ? null : await runPostRenderQc(outMp4, project, { ffmpegPath: opts.ffmpegPath });

			if (opts.open) openFolder(dirname(outMp4));
			if (opts.json) {
				console.log(
					JSON.stringify({
						ok: true,
						output: outMp4,
						duration: result.duration,
						// 音源盘点（fix-render-bundled-clip-audio）：lanes/embeddedClips/audioTrackClips/silent。
						// 「零音源不静默」的机读通路——无声成片 MUST NOT 只在 stderr 留一行 INFO。
						audio: result.audio,
						// 叠加面盘点（add-render-overlay-compositing）：同一条纪律的视觉侧——
						// 「铺了颗粒却没叠进去」MUST 有机读通路，不能只靠人读日志。
						particles: particles.summary,
						overlay: result.overlay,
						...(qc ? { qc: qc.summary } : {}),
					}),
				);
			}
		});
}
