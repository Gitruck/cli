/**
 * gtrk subtitle —— 字幕零件族（add-subtitle-lay-command，★ 主理人 2026-08-21 口头拍板）。
 *
 * `gtrk subtitle lay --project <dir> [--style <7 选 1>] [--color <11 选 1>] [--json]`：
 * 读工程 transcript（行粒度 utterances）→ 既有投影器（与 split/matrix 同一口径）投到轨道时基 →
 * 逐句转客户端契约形态的 text 元素 → 写进 `.gtrk` 的 `struct_meta.client_visual_elements` text lane。
 * 快速成片模式产出的工程由此直接带好字幕——客户端打开即见、字幕面板认得、可整轨换样式。
 *
 *   - 纯本地零云端零计费；写回复用原子写回口径（writeGtrkAtomic：临时文件+rename，mtime 冲突拒写）；
 *     除 `struct_meta.client_visual_elements` 外 MUST NOT 改 `.gtrk` 任何其他键。
 *   - 幂等：重跑替换既有字幕 lane（判据 = text lane 全员 `params.subtitleCue === true`，
 *     与客户端字幕身份判据同源）；用户手加的 text 元素所在 lane 恒不动。
 *   - 与客户端 D8「打开工程恒不自动加字幕」不冲突：D8 管客户端**打开行为**，本命令在**产出时写入**
 *     工程内容——打开时字幕已在轨上，客户端无任何自动添加动作。
 *   - 投影零命中 = 报错退出零副作用，错误附投影源诊断（describeProjectionSource，与 split 同一份话术）。
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	describeProjectionSource,
	projectTranscript,
	type GtrkProject,
	type Transcript,
} from "../lib/projection";
import { assertGtrkV1, readGtrk, writeGtrkAtomic } from "../lib/gtrk-writeback";
import {
	buildCaptionElement,
	captionsFromProjection,
	parseColorId,
	parsePresetId,
	orientationOf,
	replaceSubtitleLane,
	MIN_CAPTION_SEC,
	SUBTITLE_FONT_FAMILY,
	type SubtitleOrientation,
} from "../lib/subtitle-lay";
import { log, routeLogsToStderr } from "../lib/log";

/** positional 解析：仅支持 `lay`（口径同 gtrk audio）。 */
export function parseSubtitlePositional(words: string[] | undefined): "lay" {
	if (!words || words.length === 0) {
		throw new Error("缺少子命令——用法：gtrk subtitle lay --project <目录>");
	}
	if (words[0] !== "lay" || words.length > 1) {
		throw new Error(`未知子命令「${words.join(" ")}」——当前仅支持：gtrk subtitle lay`);
	}
	return "lay";
}

export interface SubtitleLayOpts {
	project?: string;
	gtrk?: string;
	transcript?: string;
	style?: string;
	color?: string;
	json?: boolean;
}

export interface SubtitleLayResult {
	ok: true;
	mode: "subtitle-lay";
	gtrkPath: string;
	/** 落轨字幕元素条数。 */
	laneElements: number;
	/** 幂等替换掉的既有字幕 lane 条数。 */
	replacedLanes: number;
	/** 短于最小可读时长（0.8s，客户端同标尺）被丢弃的投影实例数。 */
	droppedShort: number;
	style: string;
	color: string;
	canvas: [number, number];
	orientation: SubtitleOrientation;
	fontFamily: string;
}

/** 第一个存在的候选路径（都不存在返回 undefined）。 */
function firstExisting(cands: string[]): string | undefined {
	return cands.find((p) => existsSync(p));
}

/** 定位工程文件与 transcript（候选链同 split）。 */
function resolvePaths(opts: SubtitleLayOpts): { gtrkPath: string; transcriptPath: string } {
	const project = opts.project ? resolve(opts.project) : undefined;

	let gtrkPath: string;
	if (opts.gtrk) {
		gtrkPath = resolve(opts.gtrk);
	} else if (project) {
		gtrkPath =
			firstExisting([join(project, "gtrk", "project.gtrk"), join(project, "project.gtrk")]) ??
			join(project, "gtrk", "project.gtrk");
	} else {
		throw new Error("需要 --project <目录> 或显式 --gtrk <path>");
	}
	if (!existsSync(gtrkPath)) throw new Error(`找不到工程文件：${gtrkPath}`);

	let transcriptPath: string | undefined;
	if (opts.transcript) transcriptPath = resolve(opts.transcript);
	else if (project)
		transcriptPath = firstExisting([
			join(project, "transcript", "transcript.json"),
			join(project, "json", "transcript.json"),
			join(project, "transcript.json"),
		]);
	if (!transcriptPath || !existsSync(transcriptPath)) {
		throw new Error(
			"工程目录内找不到 transcript.json——字幕以句级时码为源：请用产 transcript 的链路（oralcut / project init）重产，或显式 --transcript 指定",
		);
	}
	return { gtrkPath, transcriptPath };
}

/** transcript 结构门（消费面：只需 utterances + material_id；text_hash 缺失按空串透传）。 */
function loadTranscript(path: string): Transcript {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new Error(`transcript.json 不是合法 JSON：${path}（${e instanceof Error ? e.message : String(e)}）`);
	}
	const t = raw as Transcript;
	if (!t || !Array.isArray(t.utterances) || t.utterances.length === 0 || typeof t.material_id !== "string") {
		throw new Error(`transcript.json 结构异常（缺 utterances/material_id）：${path}`);
	}
	if (typeof t.text_hash !== "string") t.text_hash = "";
	return t;
}

/** `.gtrk` 画布：video_size=[w,h] 两正数（缺失/非法硬拒——字号安全区全依赖它）。 */
function canvasOf(gtrk: Record<string, unknown>): { width: number; height: number } {
	const size = gtrk.video_size;
	if (
		Array.isArray(size) &&
		size.length === 2 &&
		Number.isFinite(Number(size[0])) &&
		Number.isFinite(Number(size[1])) &&
		Number(size[0]) > 0 &&
		Number(size[1]) > 0
	) {
		return { width: Number(size[0]), height: Number(size[1]) };
	}
	throw new Error(`工程文件缺有效 video_size（读到 ${JSON.stringify(size)}）——字幕几何依赖画布尺寸，无法上轨`);
}

/** 命令主逻辑（导出供测试）。任一校验失败抛错且零副作用。 */
export function runSubtitleLay(opts: SubtitleLayOpts): SubtitleLayResult {
	if (opts.json) routeLogsToStderr();
	const presetId = parsePresetId(opts.style);
	const colorId = parseColorId(opts.color);
	const { gtrkPath, transcriptPath } = resolvePaths(opts);

	const { gtrk, mtimeMs } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);
	const canvas = canvasOf(gtrk);
	const transcript = loadTranscript(transcriptPath);

	log.step(`▶ 字幕上轨：${transcript.utterances.length} 句 · 样式 ${presetId} · 颜色 ${colorId}`);

	// ── 投影（与 split/matrix 同一口径的唯一投影器）──
	const view = projectTranscript(transcript, gtrk as GtrkProject);
	const alive = view.utterances.filter((u) => !u.dropped);
	if (alive.length === 0) {
		const report = describeProjectionSource(gtrk as GtrkProject, transcript.material_id);
		throw new Error(
			`投影零命中：transcript 的口播素材（material_id=${transcript.material_id}）在当刻时间线上没有任何存活句。\n${report.text}\n${report.hint}`,
		);
	}
	const { captions, droppedShort } = captionsFromProjection(view.utterances);
	if (droppedShort > 0) {
		log.warn(`丢弃 ${droppedShort} 条短于最小可读时长（${MIN_CAPTION_SEC}s）的投影实例`);
	}
	if (captions.length === 0) {
		throw new Error(`存活投影实例全部短于最小可读时长（${MIN_CAPTION_SEC}s），无字幕可上——请检查剪辑是否把整句都切碎了`);
	}

	// ── 逐句构造契约形态 text 元素 → cve 幂等替换 ──
	const elements = captions.map((c, index) =>
		buildCaptionElement({
			index,
			text: c.text,
			startSec: c.startSec,
			durationSec: c.durationSec,
			presetId,
			colorId,
			canvas,
		}),
	);
	const structMeta = (gtrk.struct_meta as Record<string, unknown> | undefined) ?? {};
	const { mirror, replacedLanes } = replaceSubtitleLane(structMeta.client_visual_elements, elements);
	if (replacedLanes > 0) log.info(`幂等：已替换 ${replacedLanes} 条既有字幕 lane（不叠加重复字幕）`);

	const next: Record<string, unknown> = {
		...gtrk,
		struct_meta: { ...structMeta, client_visual_elements: mirror },
	};
	writeGtrkAtomic(gtrkPath, next, mtimeMs);

	const orientation = orientationOf(canvas);
	log.ok(
		`字幕已写入：${elements.length} 条 · ${orientation === "landscape" ? "横屏" : "竖屏"}档（${canvas.width}x${canvas.height}）· ${presetId}/${colorId}` +
			(replacedLanes ? `（替换旧字幕 lane ${replacedLanes} 条）` : ""),
	);
	log.info("客户端打开工程即见字幕（字幕面板可整轨换样式、逐条可编辑）。");

	const result: SubtitleLayResult = {
		ok: true,
		mode: "subtitle-lay",
		gtrkPath,
		laneElements: elements.length,
		replacedLanes,
		droppedShort,
		style: presetId,
		color: colorId,
		canvas: [canvas.width, canvas.height],
		orientation,
		fontFamily: SUBTITLE_FONT_FAMILY,
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

export function registerSubtitle(program: Command): void {
	program
		.command("subtitle [words...]")
		.description(
			"字幕零件：gtrk subtitle lay 把 transcript 逐句投影成客户端契约字幕写进 .gtrk（cve text lane；重跑幂等替换；纯本地零计费）",
		)
		.option("--project <dir>", "工程产物目录（自动定位 gtrk/project.gtrk 与 transcript/transcript.json）")
		.option("--gtrk <path>", "显式指定 .gtrk 工程文件（非标准布局兜底）")
		.option("--transcript <path>", "显式指定 transcript.json（非标准布局兜底）")
		.option("--style <id>", "字幕样式（default/outline/cinema_yellow/immersive_box/wide_spacing/deep_shadow/boxed，默认 default）")
		.option("--color <id>", "字幕颜色（雅黑/淡绿/森林绿/湖蓝/道奇蓝/钢蓝/浅粉红/深橙/珊瑚橙/橙红/土豪金，默认 雅黑）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action((words: string[] | undefined, opts: SubtitleLayOpts) => {
			parseSubtitlePositional(words);
			runSubtitleLay(opts);
		});
}
