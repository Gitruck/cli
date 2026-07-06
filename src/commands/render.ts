/**
 * gtrk render —— 本地渲染：把 gtrk 工程（EDL）用本地 ffmpeg 渲染成片 mp4。
 * 素材取 gtrk materials[].path（原片本地绝对路径）；云端不产成片，成片在本地出。
 */
import { Command } from "commander";
import { resolve, dirname, join, basename, extname } from "node:path";
import { existsSync } from "node:fs";
import { readGtrkFile, renderGtrk } from "../lib/render";
import { openFolder } from "../lib/open";
import { log, routeLogsToStderr } from "../lib/log";

interface RenderOpts {
	out?: string;
	crf?: string;
	codec?: string;
	ffmpegPath?: string;
	open?: boolean;
	json?: boolean;
}

export function registerRender(program: Command): void {
	program
		.command("render <gtrk>")
		.description("本地渲染：gtrk 工程按 EDL 用本地 ffmpeg 渲染成片 mp4（素材取原片本地路径）")
		.option("-o, --out <file>", "输出 mp4 路径（缺省 = <gtrk 同目录>/<gtrk 名>.mp4）")
		.option("--crf <n>", "视频质量 CRF 14-28（越小越清晰/文件越大，默认 18）")
		.option("--codec <c>", "视频编码（默认 h264）")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录（缺省 ~/.gitruck/ffmpeg → 系统）")
		.option("--no-open", "完成后不自动打开产物目录")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (gtrk: string, opts: RenderOpts) => {
			if (opts.json) routeLogsToStderr();
			const gtrkAbs = resolve(gtrk);
			if (!existsSync(gtrkAbs)) throw new Error(`gtrk 工程不存在：${gtrkAbs}`);
			const outMp4 = resolve(opts.out ?? join(dirname(gtrkAbs), `${basename(gtrkAbs, extname(gtrkAbs))}.mp4`));

			log.step(`▶ 本地渲染：${basename(gtrkAbs)} → ${basename(outMp4)}`);
			const project = await readGtrkFile(gtrkAbs);
			const result = await renderGtrk(project, outMp4, {
				crf: opts.crf != null ? Number(opts.crf) : undefined,
				codec: opts.codec,
				ffmpegPath: opts.ffmpegPath,
				onLine: (l) => {
					const m = l.match(/time=(\S+)/);
					if (m) log.tick(`渲染中 ${m[1]}`);
				},
			});
			log.tickEnd();
			log.ok(`渲染完成：${outMp4}（${result.duration.toFixed(1)}s）`);

			if (opts.open) openFolder(dirname(outMp4));
			if (opts.json) {
				console.log(JSON.stringify({ ok: true, output: outMp4, duration: result.duration }));
			}
		});
}
