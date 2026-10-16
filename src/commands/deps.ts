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
import { resolveBakeBrowser } from "../lib/composite-browser";
import {
	BROWSER_MANIFEST_URL,
	fetchBrowserManifest,
	fetchManifest,
	fetchFontManifest,
	headlessShellDir,
	installBrowser,
	PINNED_HEADLESS_SHELL,
	platformKeyOf,
	installFfmpeg,
	installFont,
	resolvePlatformKey,
	MANIFEST_URL,
	FONT_MANIFEST_URL,
	SUBTITLE_FONT_FILE,
	type AssetManifest,
	type CloudFontManifest,
} from "../lib/runtime-assets";

export function registerDeps(program: Command): void {
	const deps = program
		.command("deps")
		.description("运行时资产：查看状态 / 显式安装 ffmpeg、渲染字体与合成烘焙用的无头浏览器");

	deps
		.command("status")
		.description("查看 ffmpeg / 字体 / 无头浏览器的当前来源、版本与授权信息")
		.option("--ffmpeg-path <dir>", "显式 ffmpeg/ffprobe 目录")
		.action(async (opts: { ffmpegPath?: string }) => {
			await runStatus(opts.ffmpegPath);
		});

	deps
		.command("install")
		.description("从同合云镜像安装运行时资产（已存在则跳过）")
		.option("--ffmpeg", "只装 ffmpeg/ffprobe")
		.option("--font", "只装渲染字体")
		.option("--browser", `只装合成烘焙用的无头浏览器（chrome-headless-shell ${PINNED_HEADLESS_SHELL}，约 110 MB）；不带任何开关的 deps install 不含它`)
		// ⚠️ 占位符 MUST 用 ASCII：commander 判 variadic 的正则是 `/\w\.\.\.[>\]]$/`，
		// `\w` 不含中文 ⇒ 写成 `<族名...>` 会被当成普通单值选项，回调里拿到字符串而非数组，
		// 表现是 `families.map is not a function`（2026-09-16 真机撞到）。
		.option(
			"--font-family <family...>",
			"指定要装的字体族（font_id / 中英族名任一，可多个）；缺省只装字幕字体",
		)
		.option("--force", "已存在也覆盖重装")
		.action(
			async (opts: {
				ffmpeg?: boolean;
				font?: boolean;
				browser?: boolean;
				fontFamily?: string[];
				force?: boolean;
			}) => {
				await runInstall(opts);
			},
		);
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
		log.info(`合规说明：${m.base}/SOURCE.md`);
		log.info("分发不附加任何使用限制（不限 gtrk 用户、不禁转发）");
	}

	// 字体清单是**另一条链路**（同合云字体库），与 ffmpeg 分发 manifest 各拉各的。
	// 取不到只降级为少列一段，不影响上面的 ffmpeg 信息——两者没有依赖关系。
	let fm: CloudFontManifest | null = null;
	try {
		fm = await fetchFontManifest();
	} catch (e) {
		log.warn(`取字体清单失败：${e instanceof Error ? e.message : String(e)}`);
	}
	if (fm) {
		log.info(
			`  字体库 ${FONT_MANIFEST_URL}（schema ${fm.schema}，${fm.family_count} 族 / ${fm.file_count} 款，生成于 ${fm.generated}）`,
		);
		log.info(`  缺省字幕字体 ${SUBTITLE_FONT_FILE}；其余按需：gtrk deps install --font-family <族名>`);
		log.info("  与客户端同源（同一份服务端投影），故共享目录内同款字体只存一份");
	}

	await browserStatus();
}

export async function runInstall(opts: {
	ffmpeg?: boolean;
	font?: boolean;
	browser?: boolean;
	fontFamily?: string[];
	force?: boolean;
}): Promise<void> {
	// 都没指定 = ffmpeg + 字体（浏览器体积大、只有合成出片才用，必须显式 --browser）
	const none = !opts.ffmpeg && !opts.font && !opts.browser;
	const doFfmpeg = opts.ffmpeg || none;
	const doFont = opts.font || none;
	const doBrowser = !!opts.browser;

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
		log.step(`读 manifest：${MANIFEST_URL}`);
		const m = await fetchManifest();
		log.info(`schema ${m.schema}，生成于 ${m.generated}`);
		const key = resolvePlatformKey();
		log.step(`① ffmpeg（${key}）`);
		const r = await installFfmpeg(m, { force: opts.force, onProgress });
		log.tickEnd();
		if (r.installed) log.ok(`已安装 ${r.detail}`);
		else log.info(`跳过（${r.reason}）：${r.detail}`);
	}

	if (doFont) {
		log.step("② 渲染字体");
		const fm = await fetchFontManifest();
		log.info(
			`字体库 schema ${fm.schema}，${fm.family_count} 族 / ${fm.file_count} 款，生成于 ${fm.generated}`,
		);
		const rs = await installFont(fm, {
			force: opts.force,
			families: opts.fontFamily,
			onProgress,
		});
		log.tickEnd();
		for (const r of rs) {
			if (r.installed) log.ok(`已安装 ${r.detail}`);
			else log.info(`跳过（${r.reason}）：${r.detail}`);
		}
		log.info("未写系统字体表、未改注册表——烧录时经 ass 滤镜 fontsdir 供给");
	}

	if (doBrowser) {
		log.step(`③ 无头浏览器（chrome-headless-shell ${PINNED_HEADLESS_SHELL}）`);
		const bm = await fetchBrowserManifest();
		const r = await installBrowser(bm, { force: opts.force, onProgress });
		log.tickEnd();
		if (r.installed) log.ok(`已安装 ${r.detail}`);
		else log.info(`跳过（${r.reason}）：${r.detail}`);
	}

	if (doFfmpeg || doFont) log.ok(`完成。二进制在 ${ffmpegDir()}，字体在 ${fontsDir()}`);
	else log.ok("完成");
}

/** `deps status` 的浏览器一节：烘焙此刻会用哪一个、钉定版本装没装、分发物授权。 */
async function browserStatus(): Promise<void> {
	log.step("④ 合成烘焙用的无头浏览器");
	const b = resolveBakeBrowser();
	if (!b) log.warn(`未找到可用浏览器。装钉定版本：gtrk deps install --browser`);
	else if (b.source === "env") log.ok(`来源：GTRK_CHROME（${b.exe}，${b.mode === "beginframe" ? "确定性出帧" : "截图模式"}）`);
	else if (b.source === "pinned") log.ok(`来源：~/.gitruck（chrome-headless-shell ${PINNED_HEADLESS_SHELL}，${headlessShellDir()}）`);
	else {
		log.warn(`来源：系统浏览器退路（${b.exe}）——截图模式、更慢、并发降档`);
		log.info(`装钉定版本可提速并确定性出帧：gtrk deps install --browser`);
	}
	try {
		const bm = await fetchBrowserManifest();
		const key = platformKeyOf();
		const byPlatform = bm.browser[PINNED_HEADLESS_SHELL] ?? {};
		for (const [k, v] of Object.entries(byPlatform)) {
			log.info(`${k === key ? "→" : " "} ${k.padEnd(10)} ${v.version.padEnd(16)} ${v.license}  源码 ${v.source}`);
		}
		if (!Object.keys(byPlatform).length) log.warn(`镜像上暂无钉定版本 ${PINNED_HEADLESS_SHELL}`);
		log.info(`合规说明：${bm.base}/SOURCE.md`);
	} catch (e) {
		log.warn(`取浏览器清单失败（${BROWSER_MANIFEST_URL}）：${e instanceof Error ? e.message : String(e)}`);
	}
}
