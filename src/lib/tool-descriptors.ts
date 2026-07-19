/**
 * gtrk tool 工具族 —— 每工具薄 descriptor 契约 + 编译期注册表（add-tool-command-family D3）。
 *
 * 一个工具 = 一个 descriptor 对象；差异全进 descriptor（输入类别/预处理/payload 拼装/产物映射/
 * 工具专属选项/计费/可用门），骨架全归 tool-runner。runner 只认契约、不认工具名（无任何工具特判）。
 * 注册表是编译期 TS 数组、随包分发、不做动态加载；接新工具只加一个 descriptor，不写编排。
 *
 * 首批三成员全为 cloud 型，直调公共域 API（image_move / image_matting / video_matting），infra 零改动。
 * local 型（无 Key 可跑、可选云端加料，如后续的 mad）的字段（runLocal/fallbackChain）已在契约里占位，
 * 本 change 不含 local 实例。
 */
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { resolveFfmpeg } from "./ffmpeg";
import { probeGeometry } from "./media";

// ---------------------------------------------------------------- 类型

export type ToolKind = "cloud" | "local";
export type ToolInputKind = "image" | "video" | "audio" | "directory" | "none";

/** 工具专属 CLI 选项声明（族命令注册时统一挂 commander）。 */
export interface ToolOption {
	flag: string;
	desc: string;
}

/** 输入声明：类别 + 扩展名白名单（缺省按类别取默认）+ 视频类可选硬时长上限（上传前 ffprobe 前置）。 */
export interface ToolInputSpec {
	kind: ToolInputKind;
	/** 覆盖默认扩展名白名单（小写、含前导点，如 [".jpg", ".png"]）。 */
	exts?: string[];
	/** 视频类硬上限（秒）：上传前以 ffprobe 探测，超限直接拒绝（不上传不提交）。 */
	maxDurationSec?: number;
}

/** buildPayload / preprocess / mapOutputs 的执行上下文。 */
export interface ToolContext {
	/** 输入文件/目录绝对路径（input=none 时 undefined）。 */
	inputAbs?: string;
	/** 输入名去扩展（产物文件/目录命名用；input=none 时为工具名）。 */
	baseName: string;
	/** 显式 ffmpeg/ffprobe 目录（--ffmpeg-path）。 */
	ffmpegPath?: string;
	/** 解析后的命令选项（工具专属 flag + 内置 flag）。 */
	opts: Record<string, unknown>;
	/** --param/--params-json 解析结果（runner 最终会逐字段合并覆盖到 payload 上，descriptor 只读）。 */
	extraParams: Record<string, unknown>;
	/** 人读提示输出口（一律走 stderr，不污染 --json 的 stdout）。 */
	warn: (msg: string) => void;
}

/** 云端任务原始产物 output_result（形态各异：单 file / 多 file 键，由 mapOutputs 收敛）。 */
export type OutputResult = Record<string, unknown>;

/** 收敛后的下载清单条目（runner 只认这个）。 */
export interface DownloadItem {
	url: string;
	filename: string;
}

export interface ToolDescriptor {
	/** 族内命令名（kebab/snake 均可，全族唯一，不得为保留字 list）。 */
	name: string;
	/** list 展示：一句话标题。 */
	title: string;
	/** list 展示：详述。 */
	description: string;
	kind: ToolKind;
	input: ToolInputSpec;
	/** 人读计费提示（如「2 积分/个」「免费」）——提交前打印、skill 转述给用户。 */
	billingHint: string;
	/** 人读产物形态（list 的「产物形态」列，如「运镜视频」「透明 png」）。 */
	outputHint: string;
	/** 可用门：false 时 MUST 带 disabledReason（list 标「未开放」、直调报错、进程非 0）。 */
	enabled: boolean;
	disabledReason?: string;
	/** 工具专属 CLI 选项（族命令注册时统一挂 commander）。 */
	options?: ToolOption[];

	// —— cloud 型 ——
	/** 云端任务类型，可含 cli/ 域前缀（cloud.ts 的 /task/${taskType} 模板天然通吃两域）。 */
	taskType?: string;
	/** 本地预处理钩子：返回实际上传物路径；缺省=原文件直传。首批三工具均缺省（预留低带宽工具）。 */
	preprocess?: (ctx: ToolContext) => Promise<string> | string;
	/** 拼云端 payload；--param/--params-json 由 runner 在其结果上逐字段合并覆盖。 */
	buildPayload?: (fileId: string, ctx: ToolContext) => Record<string, unknown>;
	/** 把 output_result 收敛为下载清单。 */
	mapOutputs?: (out: OutputResult, ctx: ToolContext) => DownloadItem[];
	/** 轮询墙钟覆盖（毫秒）；缺省 30 分钟。 */
	pollTimeoutMs?: number;

	// —— local 型（本 change 无实例，mad 接入时消费）——
	/** 本地执行入口：无 Key 跑通主链路、返回产物清单。 */
	runLocal?: (ctx: ToolContext) => Promise<DownloadItem[]> | DownloadItem[];
	/** 可选云端加料步骤的降级链（缺 Key / 云端不可用时按此降级，不整体失败）。 */
	fallbackChain?: string[];
}

// ---------------------------------------------------------------- 扩展名白名单

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".heic", ".heif", ".avif"];
const VIDEO_EXTS = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".wmv", ".mpg", ".mpeg", ".ts", ".m2ts"];
const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"];

/** 输入类别的默认扩展名白名单（descriptor.input.exts 缺省时用）。 */
export function defaultExtsFor(kind: ToolInputKind): string[] | undefined {
	if (kind === "image") return IMAGE_EXTS;
	if (kind === "video") return VIDEO_EXTS;
	if (kind === "audio") return AUDIO_EXTS;
	return undefined; // directory / none 不做扩展名校验
}

// ---------------------------------------------------------------- 产物 URL / 文件名 工具

/** 从 output_result 的一组候选键里取第一个非空字符串 URL。 */
export function pickUrl(out: OutputResult, keys: string[]): string | undefined {
	for (const k of keys) {
		const v = out[k];
		if (typeof v === "string" && v.trim()) return v;
	}
	return undefined;
}

/** 从下载 URL 推断扩展名（含点），取不到用 fallback。 */
export function extFromUrl(url: string, fallback: string): string {
	let path = url;
	try {
		path = new URL(url).pathname;
	} catch {
		path = url.split("?")[0] ?? url;
	}
	const e = extname(path);
	return e || fallback;
}

// ---------------------------------------------------------------- image_move 几何推导

/**
 * 按原图朝向推导输出几何（横 1920×1080 / 竖 1080×1920）。纯函数，dims 缺失（无 ffprobe）→ fellBack。
 * 与探测解耦，便于离线单测。
 */
export function deriveMoveGeometry(
	dims: { width: number; height: number } | undefined,
): { width?: number; height?: number; fellBack: boolean } {
	if (!dims || !(dims.width > 0) || !(dims.height > 0)) return { fellBack: true };
	return dims.height > dims.width
		? { width: 1080, height: 1920, fellBack: false }
		: { width: 1920, height: 1080, fellBack: false };
}

/** best-effort 探图片宽高：无 ffprobe 返回 undefined（绝不抛——图片工具不得因缺 ffmpeg 拒跑）。 */
export function probeImageDims(
	inputAbs: string,
	ffmpegPath?: string,
): { width: number; height: number } | undefined {
	if (!resolveFfmpeg(ffmpegPath)) return undefined;
	try {
		const g = probeGeometry(inputAbs, ffmpegPath);
		if (g.width > 0 && g.height > 0) return { width: g.width, height: g.height };
	} catch {
		/* best-effort：探测失败按无 ffprobe 处理 */
	}
	return undefined;
}

// ---------------------------------------------------------------- 首批三 descriptor

/** image_move —— 图转运镜（公共域 /task/image_move，2 积分/个）。 */
const imageMove: ToolDescriptor = {
	name: "image_move",
	title: "图转运镜",
	description: "把一张静态图生成带运镜的短视频。",
	kind: "cloud",
	input: { kind: "image" },
	billingHint: "2 积分/个",
	outputHint: "运镜视频",
	enabled: true,
	taskType: "image_move",
	buildPayload(fileId, ctx) {
		const p: Record<string, unknown> = { file_id: fileId };
		// 几何按原图朝向推导（best-effort）；用户显式给了 width/height 则不推导也不提示（runner 会合并覆盖）。
		const explicit = ctx.extraParams.width != null || ctx.extraParams.height != null;
		if (!explicit && ctx.inputAbs) {
			const dims = probeImageDims(ctx.inputAbs, ctx.ffmpegPath);
			const geo = deriveMoveGeometry(dims);
			if (geo.width && geo.height) {
				p.width = geo.width;
				p.height = geo.height;
			}
			if (geo.fellBack) {
				ctx.warn(
					"未探测到图片朝向（缺 ffprobe），将按云端默认横屏 1920×1080 出片；" +
						"可用 --param width=… --param height=… 显式指定几何。",
				);
			}
		}
		return p;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url", "video_download_url", "url"]);
		if (!url) return [];
		return [{ url, filename: `${ctx.baseName}-image_move${extFromUrl(url, ".mp4")}` }];
	},
};

/** image_matting —— 图片抠像（公共域 /task/image_matting，免费）。 */
const imageMatting: ToolDescriptor = {
	name: "image_matting",
	title: "图片抠像",
	description: "把图片主体从背景抠出，产透明背景 png（可经 --param 请求额外背景底板输出）。",
	kind: "cloud",
	input: { kind: "image" },
	billingHint: "免费",
	outputHint: "透明 png",
	enabled: true,
	taskType: "image_matting",
	buildPayload(fileId) {
		return { file_id: fileId, output_format: "png" };
	},
	mapOutputs(out, ctx) {
		const files: DownloadItem[] = [];
		const main = pickUrl(out, ["download_url", "image_download_url", "url"]);
		if (main) files.push({ url: main, filename: `${ctx.baseName}-matte${extFromUrl(main, ".png")}` });
		// 多 file 键：请求了背景底板输出时收敛之。
		const bg = pickUrl(out, ["background_download_url", "bg_download_url"]);
		if (bg) files.push({ url: bg, filename: `${ctx.baseName}-bg${extFromUrl(bg, ".png")}` });
		return files;
	},
};

/** video_matting —— 视频抠像（公共域 /task/video_matting，免费，10min 硬上限、原片直传禁代理）。 */
const videoMatting: ToolDescriptor = {
	name: "video_matting",
	title: "视频抠像",
	description: "把视频主体从背景抠出，产透明背景 webm（像素级、原片直传不压代理；单片 ≤10 分钟）。",
	kind: "cloud",
	// 10min 硬上限：上传前 ffprobe 探测时长，超限直接拒绝（封免费能力的带宽/GPU 成本敞口）。
	input: { kind: "video", maxDurationSec: 600 },
	billingHint: "免费",
	outputHint: "透明 webm",
	enabled: true,
	taskType: "video_matting",
	pollTimeoutMs: 60 * 60 * 1000, // 按分钟计的长片，墙钟拉到 60min
	buildPayload(fileId) {
		return { file_id: fileId, target_mode: "auto", output_format: "webm" };
	},
	mapOutputs(out, ctx) {
		const files: DownloadItem[] = [];
		const main = pickUrl(out, ["download_url", "video_download_url", "url"]);
		if (main) files.push({ url: main, filename: `${ctx.baseName}-matte${extFromUrl(main, ".webm")}` });
		const mask = pickUrl(out, ["mask_download_url"]);
		if (mask) files.push({ url: mask, filename: `${ctx.baseName}-mask${extFromUrl(mask, ".webm")}` });
		return files;
	},
};

/**
 * mad —— 一键剪 MAD（local 型「纯本地工具、可选云端加料」形态首个成员，add-tool-mad）。
 * 素材文件夹（+可选 BGM）→ 自动选技法 → 生成 AE 母合成成片工程 .jsx。
 * kind:local → tool.ts 分派到 mad 自己的 handler（runMad）；无 Key 可跑、仅 --bgm 卡点计费。
 * 数据经云端 manifest 下发 + ~/.gitruck/mad-cache 缓存（首拉联网、缓存后离线可跑）。
 */
const mad: ToolDescriptor = {
	name: "mad",
	title: "一键剪 MAD",
	description:
		"素材文件夹（3~10 条视频）+ 可选 BGM → 自动选技法 → 单一 .jsx，AE 2020+ 跑一遍出 15~30s 卡点成片工程。仅支持 AE。",
	kind: "local",
	input: { kind: "directory" },
	// 无 Key 可跑（首拉联网下载数据、缓存后离线可跑）；仅 --bgm 卡点调一次云端节拍分析才计费
	billingHint: "免费（--bgm 卡点时计费一次云端节拍分析 audio_music_analyze）",
	outputHint: "AE 母合成工程 .jsx",
	enabled: true,
	options: [
		{ flag: "--bgm <音频文件>", desc: "可选 BGM，卡点到 downbeat（需 API Key，计费一次；无 Key 则 BGM 仍入轨、固定节奏）" },
		{ flag: "--duration <秒>", desc: "成片目标时长（默认 20，文案口径 15~30）" },
		{ flag: "--seed <n>", desc: "选窗随机种子（同素材同种子同数据版本 → 可复现同序列）" },
		{ flag: "--refresh", desc: "强制忽略本地缓存、重拉当前 manifest 版本数据" },
	],
};

// ---------------------------------------------------------------- 注册表 + 校验

/** 保留字：族内子模式，不得被 descriptor 取名。 */
export const RESERVED_NAMES = new Set(["list"]);

/** 工具族注册表（编译期数组）。接新工具在此追加一个 descriptor。 */
export const TOOL_REGISTRY: ToolDescriptor[] = [imageMove, imageMatting, videoMatting, mad];

/** 按名字取 descriptor。 */
export function findTool(name: string, registry: ToolDescriptor[] = TOOL_REGISTRY): ToolDescriptor | undefined {
	return registry.find((d) => d.name === name);
}

/**
 * 注册表校验（发版门 / 测试层）：name 全族唯一、不与保留字冲突、disabled 必带原因、cloud 型必有 taskType。
 * 违规即抛（禁止发版）。
 */
export function validateRegistry(registry: ToolDescriptor[] = TOOL_REGISTRY): void {
	const seen = new Set<string>();
	for (const d of registry) {
		if (!d.name) throw new Error("descriptor 缺 name");
		if (RESERVED_NAMES.has(d.name)) throw new Error(`descriptor 名与保留字冲突：「${d.name}」`);
		if (seen.has(d.name)) throw new Error(`descriptor 名重复：「${d.name}」`);
		seen.add(d.name);
		if (!d.enabled && !d.disabledReason) throw new Error(`未启用工具缺 disabledReason：「${d.name}」`);
		if (d.kind === "cloud" && !d.taskType) throw new Error(`cloud 型工具缺 taskType：「${d.name}」`);
	}
}
