/**
 * gtrk subtitle —— 字幕零件族（add-subtitle-lay-command，★ 主理人 2026-08-21 口头拍板）。
 *
 * `gtrk subtitle lay --project <dir> [--style <7 选 1>] [--color <11 选 1>] [--keep-punctuation] [--offline] [--json]`：
 * 读工程 transcript（行粒度 utterances，含字级时码）→ 既有投影器（与 split/matrix 同一口径）投到轨道时基 →
 * 同句回缝 → **云端拆行**（infra `subtitle_line_split`，0 积分留痕）→ 字级时间回贴 → 桥接 →
 * 逐条转客户端契约形态的 text 元素 → 写进 `.gtrk` 的 `struct_meta.client_visual_elements` text lane。
 * 快速成片模式产出的工程由此直接带好字幕——客户端打开即见、字幕面板认得、可整轨换样式。
 * content 缺省做逗号句号清洗（★ 2026-08-21 真机走查拍板，见 lib/subtitle-lay.ts
 * stripSubtitlePunctuation）；`--keep-punctuation` 保留原始标点。
 *
 *   - 断句零本地实现（link-subtitle-lay-cloud-line-split，主理人 2026-09-06 拍板「不本地自造断句、复用云端那一套」）：
 *     拆行缺省走云端 `POST /task/cli/subtitle_line_split`（带当前样式 id ⇒ 服务端按模板 + 真实画布实算宽度预算）；
 *     云端不可用（无 key / 离线 / 超时 / 接口未上线）**fail-open**：回缝后的句原样上轨、长句未拆、告警可读，
 *     MUST NOT 静默落到本地拆窗器。`--offline` 才走本地拆窗器（冻结版，只作兜底）。
 *   - 零计费：云端拆行 0 积分（照留痕）；其余纯本地。写回复用原子写回口径（writeGtrkAtomic）；
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
import { loadConfig } from "../lib/config";
import {
	buildCaptionElement,
	captionsFromProjection,
	shapeCaptionsCloud,
	parseColorId,
	parsePresetId,
	orientationOf,
	replaceSubtitleLane,
	CAPTION_RESEW_GAP_SEC,
	MIN_CAPTION_SEC,
	SUBTITLE_FONT_FAMILY,
	type CaptionWindow,
	type SubtitleOrientation,
} from "../lib/subtitle-lay";
import { DEFAULT_BRIDGE_GAP_SECONDS, type SplitLine } from "../lib/caption-align";
import {
	CloudLineSplitUnavailable,
	splitLinesViaCloud,
	type CloudLineSplitRequest,
	type CloudLineSplitResult,
} from "../lib/subtitle-line-split-client";
import { log, routeLogsToStderr } from "../lib/log";

/**
 * transcript 语言（云端拆行 `language` 入参，服务端 `normalize_hanlp_language` 归一）。
 * transcript v1 没有语言字段，先按中文口播；契约加字段后再跟（与客户端同一常量）。
 */
const TRANSCRIPT_LANGUAGE = "zh-CN";

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
	/** 保留原始标点（逃生口）；缺省对 content 清洗逗号句号（★ 2026-08-21 拍板）。 */
	keepPunctuation?: boolean;
	json?: boolean;
	/** 【仅 --offline 生效】单窗最大字宽单位（CJK=1/ASCII=0.5）；缺省按画布档（横 20/竖 13）；0=不拆窗。 */
	maxUnits?: string;
	/** 相邻窗 gap ≤ 此秒数时桥接前窗（缺省 1.5 = 剪映「自动填充文本空隙」但过长不硬填；0=不桥接）。云端 / 离线两路都生效。 */
	maxGap?: string;
	/** 离线模式：不调云端拆行，用本地拆窗器（冻结版兜底）。缺省 false = 云端拆行。 */
	offline?: boolean;
}

export type SubtitleSplitter = "cloud" | "offline";

export interface SubtitleLayResult {
	ok: true;
	mode: "subtitle-lay";
	gtrkPath: string;
	/** 落轨字幕元素条数。 */
	laneElements: number;
	/** 幂等替换掉的既有字幕 lane 条数。 */
	replacedLanes: number;
	/** 短于最小可读时长（0.8s，客户端同标尺）被丢弃的**回缝后**字幕单元数。 */
	droppedShort: number;
	/**
	 * 同句回缝（fix-subtitle-lay-duplicate-instances）并掉的投影实例数：智能剪辑把一句切成多片时，
	 * 投影器对每片都吐一个实例，不回缝就是同一句在时间线上重复 N 遍。0 = 本次无一句被剪成多片。
	 */
	mergedCount: number;
	/**
	 * 【仅 offline】拆窗切点退化次数（fix-caption-split-word-boundary）：浮动窗内既无标点/空白、又无合规词边界，
	 * 只能退回字宽均分锚点的处数。云端路恒 0（拆行不在本地做）。
	 */
	splitFallbackCount: number;
	/** 本次拆行走了哪条路。 */
	splitter: SubtitleSplitter;
	/** 云端路：null = 走通；string = 不可用原因（已 fail-open：整句上轨、长句未拆）。offline 恒 null。 */
	cloudUnavailable: string | null;
	/** 云端路：服务端 fail-open 降级（行照用、消息透传）。 */
	cloudDegraded: boolean;
	cloudDegradeMessage: string | null;
	/** 云端路：服务端整形行时码被钳进父句包络的行数（add-cross-clock-adapter D4，spec 字段名 `clamped_lines`）。offline 恒 0。 */
	clamped_lines: number;
	style: string;
	color: string;
	canvas: [number, number];
	orientation: SubtitleOrientation;
	fontFamily: string;
	/** true = 本次保留了原始标点（--keep-punctuation）；false = 已做逗号句号清洗。 */
	keepPunctuation: boolean;
}

/** 可注入依赖（测试替身）：云端拆行客户端。 */
export interface SubtitleLayDeps {
	splitLines?: (req: CloudLineSplitRequest) => Promise<CloudLineSplitResult>;
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

/**
 * 真实云端拆行客户端：凭据缺失（未 `gtrk init`）也算「不可用」——fail-open 的一种，
 * 不该让一条纯产出命令因为没配 key 而整条报错退出。
 */
function realSplitLines(req: CloudLineSplitRequest): Promise<CloudLineSplitResult> {
	let cfg;
	try {
		cfg = loadConfig();
	} catch (e) {
		return Promise.reject(new CloudLineSplitUnavailable(e instanceof Error ? e.message : String(e)));
	}
	return splitLinesViaCloud(cfg, req);
}

/** 命令主逻辑（导出供测试）。任一校验失败抛错且零副作用。 */
export async function runSubtitleLay(opts: SubtitleLayOpts, deps: SubtitleLayDeps = {}): Promise<SubtitleLayResult> {
	if (opts.json) routeLogsToStderr();
	const presetId = parsePresetId(opts.style);
	const colorId = parseColorId(opts.color);
	const { gtrkPath, transcriptPath } = resolvePaths(opts);

	const { gtrk, revision } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);
	const canvas = canvasOf(gtrk);
	const transcript = loadTranscript(transcriptPath);
	const splitter: SubtitleSplitter = opts.offline ? "offline" : "cloud";

	log.step(`▶ 字幕上轨：${transcript.utterances.length} 句 · 样式 ${presetId} · 颜色 ${colorId} · 拆行 ${splitter === "cloud" ? "云端" : "离线（本地拆窗器）"}`);

	// ── 投影（与 split/matrix 同一口径的唯一投影器；带字级明细 ⇒ 被剪掉的字不上轨）──
	const view = projectTranscript(transcript, gtrk as GtrkProject, { words: true });
	const alive = view.utterances.filter((u) => !u.dropped);
	if (alive.length === 0) {
		const report = describeProjectionSource(gtrk as GtrkProject, transcript.material_id);
		throw new Error(
			`投影零命中：transcript 的口播素材（material_id=${transcript.material_id}）在当刻时间线上没有任何存活句。\n${report.text}\n${report.hint}`,
		);
	}
	const orientation = orientationOf(canvas);
	// 桥接缺省 = 共享叶子的 DEFAULT_BRIDGE_GAP_SECONDS（1.5s，取值依据见其头注）；剪映「自动填充文本空隙」语义、过长不硬填
	const maxGapSec = opts.maxGap != null ? Math.max(0, Number(opts.maxGap) || 0) : DEFAULT_BRIDGE_GAP_SECONDS;

	let captions: CaptionWindow[];
	let droppedShort = 0;
	let mergedCount = 0;
	let bridgedCount = 0;
	let splitFallbackCount = 0;
	let cloudUnavailable: string | null = null;
	let cloudDegraded = false;
	let cloudDegradeMessage: string | null = null;
	let clampedLines = 0;

	if (splitter === "cloud") {
		if (opts.maxUnits != null) log.info("--max-units 仅离线拆窗生效；云端拆行按所选样式模板与真实画布实算宽度预算");
		const splitLines = deps.splitLines ?? realSplitLines;
		const r = await shapeCaptionsCloud(alive, {
			splitLines: (lines: SplitLine[]) =>
				splitLines({
					lines,
					canvas: [canvas.width, canvas.height],
					language: TRANSCRIPT_LANGUAGE,
					subtitleType: presetId,
				}),
			maxGapSec,
		});
		captions = r.captions;
		droppedShort = r.droppedShort;
		mergedCount = r.mergedCount;
		bridgedCount = r.bridgedCount;
		cloudUnavailable = r.cloud.unavailable;
		cloudDegraded = r.cloud.degraded;
		cloudDegradeMessage = r.cloud.degradeMessage;
		clampedLines = r.cloud.clampedLines;
		if (cloudUnavailable !== null) {
			// 良性降级打可读 WARN：用户可感知的产物差异（长句未拆），且给出当下就能执行的下一步
			log.warn(
				`云端拆行不可用：${cloudUnavailable}——本次按整句上轨、长句未拆（文本与时码仍对）；接口恢复后重跑本命令即可（幂等替换、0 积分），离线可加 --offline 用本地拆窗器`,
			);
		} else {
			log.info(`云端拆行：${r.cloud.inputLines} 句 → ${r.cloud.outputLines} 行（subtitle_line_split，0 积分留痕）`);
			if (cloudDegraded) log.warn(`云端拆行部分降级：${cloudDegradeMessage ?? "服务端未给原因"}——重跑本命令即可（0 积分）`);
			// 良性、根因已知（服务端整形行越出父句区间）⇒ INFO 不升告警（add-cross-clock-adapter D4）
			if (clampedLines > 0) log.info(`父句包络钳位：${clampedLines} 行服务端时码越出父句区间，已钳回 [父句起, 父句止]（字级回贴路不经此）`);
		}
	} else {
		// 【冻结】离线拆窗（fix-subtitle-lay-split-and-gap / fix-caption-split-word-boundary）：横屏 20 / 竖屏 13 字宽档
		const defaultUnits = orientation === "portrait" ? 13 : 20;
		const maxUnits = opts.maxUnits != null ? Math.max(0, Number(opts.maxUnits) || 0) : defaultUnits;
		const r = captionsFromProjection(alive, { maxUnits, maxGapSec });
		captions = r.captions;
		droppedShort = r.droppedShort;
		mergedCount = r.mergedCount;
		bridgedCount = r.bridgedCount;
		splitFallbackCount = r.splitFallbackCount;
		if (r.splitCount > 0)
			log.info(
				`离线拆窗：+${r.splitCount} 窗（上限 ${maxUnits} 字宽单位/${orientation === "portrait" ? "竖" : "横"}屏档，切点优先落标点/空白/词边界）` +
					(r.splitFallbackCount > 0 ? `，其中 ${r.splitFallbackCount} 处无词边界可用、已退回字宽均分` : ""),
			);
	}
	if (mergedCount > 0)
		log.info(
			`同句回缝：${mergedCount} 个投影实例并回原句（阈值 ${CAPTION_RESEW_GAP_SEC}s，智能剪辑把一句切成多片，不并会出重复字幕；有字级时码时按时间线序拼接存活字）`,
		);
	if (droppedShort > 0) {
		log.warn(`丢弃 ${droppedShort} 条短于最小可读时长（${MIN_CAPTION_SEC}s）的字幕单元`);
	}
	if (bridgedCount > 0) log.info(`小 gap 桥接：${bridgedCount} 处（阈值 ${maxGapSec}s，消灭字幕闪烁）`);
	if (captions.length === 0) {
		throw new Error(`存活投影实例全部短于最小可读时长（${MIN_CAPTION_SEC}s），无字幕可上——请检查剪辑是否把整句都切碎了`);
	}

	// ── 逐句构造契约形态 text 元素 → cve 幂等替换 ──
	// 文本清洗（逗号句号→空格）缺省开启，只影响写出的 content；重跑恒以 transcript
	// 原文重新生成再清洗（transcript.json 本身 MUST NOT 改），幂等替换机制照旧。
	const keepPunctuation = opts.keepPunctuation === true;
	if (keepPunctuation) log.info("保留原始标点（--keep-punctuation）：跳过逗号句号清洗");
	const elements = captions.map((c, index) =>
		buildCaptionElement({
			index,
			text: c.text,
			startSec: c.startSec,
			durationSec: c.durationSec,
			presetId,
			colorId,
			canvas,
			keepPunctuation,
		}),
	);
	const structMeta = (gtrk.struct_meta as Record<string, unknown> | undefined) ?? {};
	const { mirror, replacedLanes } = replaceSubtitleLane(structMeta.client_visual_elements, elements);
	if (replacedLanes > 0) log.info(`幂等：已替换 ${replacedLanes} 条既有字幕 lane（不叠加重复字幕）`);

	const next: Record<string, unknown> = {
		...gtrk,
		struct_meta: { ...structMeta, client_visual_elements: mirror },
	};
	writeGtrkAtomic(gtrkPath, next, revision);

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
		mergedCount,
		splitFallbackCount,
		splitter,
		cloudUnavailable,
		cloudDegraded,
		cloudDegradeMessage,
		clamped_lines: clampedLines,
		style: presetId,
		color: colorId,
		canvas: [canvas.width, canvas.height],
		orientation,
		fontFamily: SUBTITLE_FONT_FAMILY,
		keepPunctuation,
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

export function registerSubtitle(program: Command): void {
	program
		.command("subtitle [words...]")
		.description(
			"字幕零件：gtrk subtitle lay 把 transcript 按当刻时间线字级投影、云端拆行后写进 .gtrk（cve text lane；重跑幂等替换；0 积分）",
		)
		.option("--project <dir>", "工程产物目录（自动定位 gtrk/project.gtrk 与 transcript/transcript.json）")
		.option("--gtrk <path>", "显式指定 .gtrk 工程文件（非标准布局兜底）")
		.option("--transcript <path>", "显式指定 transcript.json（非标准布局兜底）")
		.option("--style <id>", "字幕样式（default/outline/cinema_yellow/immersive_box/wide_spacing/deep_shadow/boxed，默认 default）")
		.option("--color <id>", "字幕颜色（雅黑/淡绿/森林绿/湖蓝/道奇蓝/钢蓝/浅粉红/深橙/珊瑚橙/橙红/土豪金，默认 雅黑）")
		.option("--keep-punctuation", "保留原始标点（默认清洗：中英逗号句号替换为空格，小数/千分位/缩写不误伤）")
		.option("--offline", "离线模式：不调云端拆行，用本地拆窗器（冻结版兜底）；缺省走云端 subtitle_line_split（0 积分，按样式模板实算宽度预算）")
		.option("--max-units <n>", "【仅 --offline】单窗最大字宽（CJK=1/ASCII=0.5；缺省按画布档：横屏 20/竖屏 13；0=不拆窗）")
		.option("--max-gap <s>", "相邻字幕 gap ≤ 此秒数时桥接前一条（缺省 1.5：等价剪映「自动填充文本空隙」，但更长的真实停顿不硬填；0=不桥接）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[] | undefined, opts: SubtitleLayOpts) => {
			parseSubtitlePositional(words);
			await runSubtitleLay(opts);
		});
}
