/**
 * gtrk deps —— 运行时资产（ffmpeg/ffprobe、渲染字体）的查看与显式安装。
 *
 * **不做静默自动下载**：任何缺失路径只报错 + 指引到本命令（86 MB 的意外下载是坏 UX，
 * 且分发物涉及授权，须由用户/agent 显式触发）。沿用「agent 替用户跑 CLI」范式。
 */
import { Command } from "commander";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "../lib/log";
import { ffmpegDir, fontsDir } from "../lib/paths";
import { resolveFfmpeg, probeCapabilities } from "../lib/ffmpeg";
import {
	fetchManifest,
	installFfmpeg,
	installFont,
	resolvePlatformKey,
	MANIFEST_URL,
	type AssetManifest,
} from "../lib/runtime-assets";

export function registerDeps(program: Command): void {
	const deps = program
		.command("deps")
		.description("运行时资产：查看状态 / 显式安装 ffmpeg 与渲染字体");

	deps
		.command("status")
		.description("查看 ffmpeg / 字体的当前来源、版本与授权信息")
		.option("--ffmpeg-path <dir>", "显式 ffmpeg/ffprobe 目录")
		.action(async (opts: { ffmpegPath?: string }) => {
			await runStatus(opts.ffmpegPath);
		});

	deps
		.command("install")
		.description("从同合云镜像安装运行时资产（已存在则跳过）")
		.option("--ffmpeg", "只装 ffmpeg/ffprobe")
		.option("--font", "只装渲染字体")
		.option("--force", "已存在也覆盖重装")
		.action(async (opts: { ffmpeg?: boolean; font?: boolean; force?: boolean }) => {
			await runInstall(opts);
		});
}

function fmtMB(n: number): string {
	return `${(n / 1048576).toFixed(1)} MB`;
}

export async function runStatus(ffmpegPath?: string): Promise<void> {
	log.step("① ffmpeg / ffprobe");
	const res = resolveFfmpeg(ffmpegPath);
	if (res) {
		log.ok(`来源：${res.source}`);
		try {
			const cap = probeCapabilities(res);
			log.info(cap.version);
			log.info(`libx264 ${cap.hasLibx264 ? "✅" : "❌"}   ass 滤镜 ${cap.filters.has("ass") ? "✅" : "❌"}`);
		} catch {
			log.warn("二进制存在但探测能力失败");
		}
	} else {
		log.warn(`未找到。装它：gtrk deps install --ffmpeg`);
	}

	log.step("② 渲染字体");
	const fdir = fontsDir();
	const fonts = existsSync(fdir)
		? readdirSync(fdir).filter((f) => /\.(otf|ttf|ttc|otc)$/i.test(f))
		: [];
	if (fonts.length) {
		log.ok(`${fdir}（${fonts.length} 个）`);
		for (const f of fonts) log.info(`${f}  ${fmtMB(statSync(join(fdir, f)).size)}`);
		log.info("经 ass 滤镜 fontsdir 供给 libass，未安装进系统字体表");
	} else {
		log.warn(`${fdir} 无字体。装它：gtrk deps install --font`);
		log.info("（系统已装所需字体时也可直接用，两处任一命中即可）");
	}

	log.step("③ 分发物授权与源码");
	let m: AssetManifest | null = null;
	try {
		m = await fetchManifest();
	} catch (e) {
		log.warn(`取 manifest 失败：${e instanceof Error ? e.message : String(e)}`);
	}
	if (m) {
		let key = "";
		try {
			key = resolvePlatformKey();
		} catch {
			/* 平台不受支持，下面按整表展示 */
		}
		for (const [k, v] of Object.entries(m.ffmpeg)) {
			const mark = k === key ? "→" : " ";
			log.info(`${mark} ${k.padEnd(10)} ${v.version.padEnd(20)} ${v.license}  源码 ${v.source}`);
		}
		for (const [name, v] of Object.entries(m.font)) {
			log.info(`  字体 ${name}  ${v.license}`);
		}
		log.info(`合规说明：${m.base}/SOURCE.md`);
		log.info("分发不附加任何使用限制（不限 gtrk 用户、不禁转发）");
	}
}

export async function runInstall(opts: {
	ffmpeg?: boolean;
	font?: boolean;
	force?: boolean;
}): Promise<void> {
	// 都没指定 = 两样都装
	const doFfmpeg = opts.ffmpeg || !opts.font;
	const doFont = opts.font || !opts.ffmpeg;

	log.step(`读 manifest：${MANIFEST_URL}`);
	const m = await fetchManifest();
	log.info(`schema ${m.schema}，生成于 ${m.generated}`);

	// 进度节流：\r 原地刷新只在 TTY 有效；被管道/agent 捕获时每个 chunk 一行会刷屏
	// （86 MB 的包能刷出上千行）。故按「≥5% 或 ≥2s」才更新一次。
	let lastPct = -1;
	let lastAt = 0;
	const onProgress = (got: number, total: number) => {
		if (total <= 0) return;
		const pct = Math.floor((got / total) * 100);
		const now = Date.now();
		if (pct < 100 && pct - lastPct < 5 && now - lastAt < 2000) return;
		lastPct = pct;
		lastAt = now;
		log.tick(`下载 ${fmtMB(got)} / ${fmtMB(total)}（${pct}%）`);
	};

	if (doFfmpeg) {
		const key = resolvePlatformKey();
		log.step(`① ffmpeg（${key}）`);
		const r = await installFfmpeg(m, { force: opts.force, onProgress });
		log.tickEnd();
		if (r.installed) log.ok(`已安装 ${r.detail}`);
		else log.info(`跳过（${r.reason}）：${r.detail}`);
	}

	if (doFont) {
		log.step("② 渲染字体");
		const rs = await installFont(m, { force: opts.force, onProgress });
		log.tickEnd();
		for (const r of rs) {
			if (r.installed) log.ok(`已安装 ${r.detail}`);
			else log.info(`跳过（${r.reason}）：${r.detail}`);
		}
		log.info("未写系统字体表、未改注册表——烧录时经 ass 滤镜 fontsdir 供给");
	}

	log.ok(`完成。二进制在 ${ffmpegDir()}，字体在 ${fontsDir()}`);
}
