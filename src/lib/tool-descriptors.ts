/**
 * gtrk tool 工具族 —— 每工具薄 descriptor 契约 + 编译期注册表（add-tool-command-family D3）。
 *
 * 一个工具 = 一个 descriptor 对象；差异全进 descriptor（输入类别/预处理/payload 拼装/产物映射/
 * 工具专属选项/计费/可用门），骨架全归 tool-runner。runner 只认契约、不认工具名（无任何工具特判）。
 * 注册表是编译期 TS 数组、随包分发、不做动态加载；接新工具只加一个 descriptor，不写编排。
 *
 * cloud 型直调公共域 API，local 型可复用同一注册表与发现入口；infra 零改动。
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve as resolvePath } from "node:path";
import { resolveFfmpeg } from "./ffmpeg";
import { assFontNames, burnSubtitle, extractAudio, probeFontAvailable, probeGeometry } from "./media";
import { renderProReport } from "./clip-brief";

// ---------------------------------------------------------------- 类型

export type ToolKind = "cloud" | "local";
export type ToolInputKind = "image" | "video" | "audio" | "images" | "videos" | "directory" | "none";

/** 多文件扁平输入类别（add-tool-multifile-images 建 images、add-tool-video-split-screen 推广 videos）。 */
export const MULTI_INPUT_KINDS: ReadonlySet<ToolInputKind> = new Set(["images", "videos"]);

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
	/** 输入文件/目录绝对路径（input=none 时 undefined；images 多文件时为首个输入）。 */
	inputAbs?: string;
	/** images 多文件输入的全量绝对路径（传入顺序即拼装顺序；其余类别 undefined）。 */
	inputAbsList?: string[];
	/** 输入名去扩展（产物文件/目录命名用；input=none 时为工具名；images 取首个输入）。 */
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
	/** 官网实时价格表 key；cloud 型必填，不从 name/taskType 猜别名。 */
	priceKey?: string;
	/** 稳定的计费条件说明（不得含价格数字），如 MAD「仅 --bgm 卡点时」。 */
	pricingContext?: string;
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
	/** 本地预处理钩子：返回实际上传物路径；缺省=原文件直传（预留低带宽工具）。 */
	preprocess?: (ctx: ToolContext) => Promise<string> | string;
	/** 拼云端 payload；--param/--params-json 由 runner 在其结果上逐字段合并覆盖。 */
	buildPayload?: (fileId: string, ctx: ToolContext) => Record<string, unknown>;
	/**
	 * images 多文件专用 payload 拼装（接收按传入顺序的 file_ids）。
	 * 与 buildPayload 互斥：input.kind="images" ⇔ 声明本项且不声明 buildPayload（注册表校验）。
	 */
	buildPayloadMulti?: (fileIds: string[], ctx: ToolContext) => Record<string, unknown>;
	/**
	 * input=none 零上传直提交专用 payload 拼装（纯参数任务，如文本合成）。
	 * none 的 cloud 工具 MUST 声明 preprocess（产上传物旧路径）或本项恰一；
	 * 与 buildPayload/buildPayloadMulti 互斥（add-tool-audio-tts-clone）。
	 */
	buildPayloadNone?: (ctx: ToolContext) => Record<string, unknown>;
	/** 把 output_result 收敛为下载清单。 */
	mapOutputs?: (out: OutputResult, ctx: ToolContext) => DownloadItem[];
	/**
	 * 下载落地之后、结果收敛之前的本地加工钩子（align-ai-subtitle-audio-only）：收已落地文件绝对路径
	 * **与云端出参 output_result**，返回本地新产出的文件路径（追加进产物清单）。
	 * 之所以也收云端出参：本地加工既可能是对已落地文件的再处理（烧录字幕），也可能是把云端返回的结构
	 * 渲成人读产物（精剪的切片报告），后者只靠文件路径无从下手（add-tool-video-long2short-pro）。让「云端只出轻产物、重加工留在本地」成为工具族一等能力，
	 * 不必为此把工具提升为独立命令。
	 * 失败由 runner 记 `errors[<name>:postprocess]` 并**保留云端已落地产物**——本地加工失败
	 * MUST NOT 丢弃已经付费取得的云端结果。
	 */
	postprocess?: (
		ctx: ToolContext,
		landed: string[],
		out: OutputResult,
	) => Promise<string[] | void> | string[] | void;
	/**
	 * 把 output_result 收敛为一个可 JSON 序列化的结构对象，供 runner 落 `result-output.json`。
	 * 只读纯函数、只返回结构、不负责落盘（落盘归 runner）；与 mapOutputs 相互独立——
	 * 一个能力可以既下载文件（mapOutputs）又落结构化 JSON（mapResult）。分析型能力（分镜/运镜）只声明本项。
	 */
	mapResult?: (out: OutputResult, ctx: ToolContext) => Record<string, unknown>;
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

/** 输入本身是否已是音频文件（音频输入无画面可探、也不必再抽一遍）。 */
const isAudioFile = (p: string): boolean => AUDIO_EXTS.includes(extname(p).toLowerCase());

/** 公共视频原子能力当前实际接受的 utils.base.video_ext；与宽松的通用 VIDEO_EXTS 分开维护。 */
const PUBLIC_VIDEO_EXTS = [
	".mp4",
	".avi",
	".mpg",
	".mov",
	".flv",
	".mxf",
	".mpeg",
	".ogg",
	".3gp",
	".wmv",
	".h264",
	".m4v",
	".ts",
];

/** 输入类别的默认扩展名白名单（descriptor.input.exts 缺省时用）。 */
export function defaultExtsFor(kind: ToolInputKind): string[] | undefined {
	if (kind === "image" || kind === "images") return IMAGE_EXTS;
	if (kind === "video" || kind === "videos") return VIDEO_EXTS;
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

// ---------------------------------------------------------------- 图片/视频首批 descriptor

/** image_move —— 图转运镜（公共域 /task/image_move，价格运行时查公开价格表）。 */
const imageMove: ToolDescriptor = {
	name: "image_move",
	title: "图转运镜",
	description: "把一张静态图生成带运镜的短视频。",
	kind: "cloud",
	input: { kind: "image" },
	priceKey: "image_move_local",
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

/** image_matting —— 图片抠像（公共域 /task/image_matting，价格运行时查公开价格表）。 */
const imageMatting: ToolDescriptor = {
	name: "image_matting",
	title: "图片抠像",
	description: "把图片主体从背景抠出，产透明背景 png（可经 --param 请求额外背景底板输出）。",
	kind: "cloud",
	input: { kind: "image" },
	priceKey: "image_matting",
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

/** image_blackborder_remove —— 自动裁去单张图片四周黑边。 */
const imageBlackborderRemove: ToolDescriptor = {
	name: "image_blackborder_remove",
	title: "图片去黑边",
	description: "自动检测并裁去单张图片四周的黑边，保留有效画面。",
	kind: "cloud",
	input: { kind: "image" },
	priceKey: "image_blackborder_remove",
	outputHint: "去黑边图片",
	enabled: true,
	taskType: "image_blackborder_remove",
	buildPayload(fileId) {
		return { file_id: fileId };
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url
			? [{ url, filename: `${ctx.baseName}-blackborder-removed${extFromUrl(url, ".jpg")}` }]
			: [];
	},
};

/** image_canvas_adapt —— 按实际 Handler 的三种画布模式适配单张图片。 */
const imageCanvasAdapt: ToolDescriptor = {
	name: "image_canvas_adapt",
	title: "图片比例转换",
	description: "把单张图片适配到目标画布尺寸，可选适配、矩形裁剪或方形裁剪。",
	kind: "cloud",
	input: { kind: "image" },
	priceKey: "image_canvas_adapt",
	outputHint: "比例适配图片",
	enabled: true,
	taskType: "image_canvas_adapt",
	options: [
		{ flag: "--canvas-width <px>", desc: "目标画布宽度（像素；未传则使用服务端默认）" },
		{ flag: "--canvas-height <px>", desc: "目标画布高度（像素；未传则使用服务端默认）" },
		{
			flag: "--canvas-type <normal|rectangle|square>",
			desc: "画布模式：normal、rectangle 或 square（未传则使用服务端默认）",
		},
	],
	buildPayload(fileId, ctx) {
		const payload: Record<string, unknown> = { file_id: fileId };
		for (const [optKey, payloadKey, flag] of [
			["canvasWidth", "canvas_width", "--canvas-width"],
			["canvasHeight", "canvas_height", "--canvas-height"],
		] as const) {
			if (ctx.opts[optKey] == null) continue;
			const value = Number(ctx.opts[optKey]);
			if (!Number.isFinite(value)) throw new Error(`${flag} 必须是数字`);
			payload[payloadKey] = value;
		}
		if (ctx.opts.canvasType != null) {
			const value = String(ctx.opts.canvasType);
			if (value !== "normal" && value !== "rectangle" && value !== "square") {
				throw new Error("--canvas-type 只支持 normal、rectangle 或 square");
			}
			payload.canvas_type = value;
		}
		return payload;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url
			? [{ url, filename: `${ctx.baseName}-canvas-adapted${extFromUrl(url, ".jpg")}` }]
			: [];
	},
};

/** image_purify —— 清理用户有权处理素材中的水印、Logo 或叠加元素。 */
const imagePurify: ToolDescriptor = {
	name: "image_purify",
	title: "图片净化",
	description: "清理你有权处理的图片中的水印、Logo 或叠加元素。",
	kind: "cloud",
	input: { kind: "image" },
	priceKey: "image_purify",
	outputHint: "净化图片",
	enabled: true,
	taskType: "image_purify",
	buildPayload(fileId) {
		return { file_id: fileId };
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}-purified${extFromUrl(url, ".jpg")}` }] : [];
	},
};

/** video_blackborder_remove —— 自动检测并裁去单条视频四周黑边。 */
const videoBlackborderRemove: ToolDescriptor = {
	name: "video_blackborder_remove",
	title: "视频去黑边",
	description: "自动检测并裁去单条视频四周的黑边，保留有效画面与原音轨。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_blackborder_remove",
	outputHint: "去黑边视频",
	enabled: true,
	taskType: "video_blackborder_remove",
	buildPayload(fileId) {
		return { file_id: fileId };
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url
			? [{ url, filename: `${ctx.baseName}-blackborder-removed${extFromUrl(url, ".mp4")}` }]
			: [];
	},
};

/** video_canvas_adapt —— 视频目标画布、时间片段与音轨保留适配。 */
const videoCanvasAdapt: ToolDescriptor = {
	name: "video_canvas_adapt",
	title: "视频比例转换",
	description: "把单条视频适配到目标画布，可选截取时间片段并移除音轨。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_canvas_adapt",
	outputHint: "比例适配视频",
	enabled: true,
	taskType: "video_canvas_adapt",
	options: [
		{ flag: "--canvas-width <px>", desc: "目标画布宽度（像素；未传则使用服务端默认）" },
		{ flag: "--canvas-height <px>", desc: "目标画布高度（像素；未传则使用服务端默认）" },
		{
			flag: "--canvas-type <normal|rectangle|square>",
			desc: "画布模式：normal、rectangle 或 square（未传则使用服务端默认）",
		},
		{ flag: "--clip-start <frame>", desc: "截取起始帧序号（未传则使用服务端默认）" },
		{ flag: "--clip-end <frame>", desc: "截取结束帧序号（未传则使用服务端默认）" },
		{ flag: "--without-audio", desc: "输出视频不保留音轨" },
	],
	buildPayload(fileId, ctx) {
		const payload: Record<string, unknown> = { file_id: fileId };
		for (const [optKey, payloadKey, flag] of [
			["canvasWidth", "target_width", "--canvas-width"],
			["canvasHeight", "target_height", "--canvas-height"],
		] as const) {
			if (ctx.opts[optKey] == null) continue;
			const value = Number(ctx.opts[optKey]);
			if (!Number.isFinite(value) || !Number.isInteger(value)) {
				throw new Error(`${flag} 必须是有限整数`);
			}
			payload[payloadKey] = value;
		}
		for (const [optKey, payloadKey, flag] of [
			["clipStart", "start", "--clip-start"],
			["clipEnd", "end", "--clip-end"],
		] as const) {
			if (ctx.opts[optKey] == null) continue;
			const value = Number(ctx.opts[optKey]);
			if (!Number.isFinite(value) || !Number.isInteger(value)) {
				throw new Error(`${flag} 必须是有限整数帧号`);
			}
			payload[payloadKey] = value;
		}
		if (ctx.opts.canvasType != null) {
			const value = String(ctx.opts.canvasType);
			if (value !== "normal" && value !== "rectangle" && value !== "square") {
				throw new Error("--canvas-type 只支持 normal、rectangle 或 square");
			}
			payload.canvas_type = value;
		}
		if (ctx.opts.withoutAudio === true) payload.need_audio = false;
		return payload;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url
			? [{ url, filename: `${ctx.baseName}-canvas-adapted${extFromUrl(url, ".mp4")}` }]
			: [];
	},
};

/** video_stabilizer —— 以公共 API 的 fast / exp / turbo 三种方式做视频防抖。 */
const videoStabilizer: ToolDescriptor = {
	name: "video_stabilizer",
	title: "视频防抖",
	description: "稳定手持或运动拍摄画面；exp 为实验方式，产物观感需自行检查。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_stabilizer",
	outputHint: "防抖视频",
	enabled: true,
	taskType: "video_stabilizer",
	options: [{ flag: "--stabilizer-method <fast|exp|turbo>", desc: "防抖方式（未传则使用服务端 turbo 默认值）" }],
	buildPayload(fileId, ctx) {
		const payload: Record<string, unknown> = { file_id: fileId };
		if (ctx.opts.stabilizerMethod == null) return payload;
		const method = String(ctx.opts.stabilizerMethod);
		if (method !== "fast" && method !== "exp" && method !== "turbo") {
			throw new Error("--stabilizer-method 只支持 fast、exp 或 turbo");
		}
		payload.method = method;
		return payload;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}-stabilized${extFromUrl(url, ".mp4")}` }] : [];
	},
};

/** video_vaporwave —— 按服务端精确预设名应用蒸汽波滤镜。 */
const videoVaporwave: ToolDescriptor = {
	name: "video_vaporwave",
	title: "视频蒸汽波滤镜",
	description: "按精确预设名称为单条视频应用蒸汽波风格滤镜。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_vaporwave",
	outputHint: "蒸汽波滤镜视频",
	enabled: true,
	taskType: "video_vaporwave",
	options: [{ flag: "--vaporwave-filter <name>", desc: "精确滤镜名称（默认：愈漸升溫）" }],
	buildPayload(fileId, ctx) {
		const raw = ctx.opts.vaporwaveFilter;
		const filter = raw == null ? "愈漸升溫" : String(raw);
		if (!filter.trim()) throw new Error("--vaporwave-filter 不能为空");
		return { file_id: fileId, filter };
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}-vaporwave${extFromUrl(url, ".mp4")}` }] : [];
	},
};

type NormalizedRoi = { x: number; y: number; w: number; h: number };

/** Parse and validate the public video_purify normalized ROI contract. */
export function parseNormalizedRoi(value: unknown): NormalizedRoi {
	let rawValues: unknown[];
	let acceptNumericStrings = false;
	if (typeof value === "string") {
		acceptNumericStrings = true;
		const parts = value.split(",");
		if (parts.length !== 4 || parts.some((part) => !part.trim())) {
			throw new Error("--purify-roi 必须是 x,y,w,h 四个归一化数字");
		}
		rawValues = parts;
	} else if (value && typeof value === "object" && !Array.isArray(value)) {
		const roi = value as Record<string, unknown>;
		rawValues = [roi.x, roi.y, roi.w, roi.h];
	} else {
		throw new Error("ROI 必须包含归一化数字 x、y、w、h");
	}

	const numbers = rawValues.map((item) => {
		if (typeof item === "number") return item;
		if (acceptNumericStrings && typeof item === "string") return Number(item);
		return Number.NaN;
	});
	if (numbers.some((item) => !Number.isFinite(item))) {
		throw new Error("ROI 的 x、y、w、h 必须是有限数字");
	}
	const [x, y, w, h] = numbers as [number, number, number, number];
	if (x < 0 || x > 1 || y < 0 || y > 1 || w <= 0 || w > 1 || h <= 0 || h > 1 || x + w > 1 || y + h > 1) {
		throw new Error("ROI 必须满足 0≤x,y≤1、0<w,h≤1、x+w≤1、y+h≤1");
	}
	return { x, y, w, h };
}

/** video_purify —— 净化用户有权处理的视频中的水印、字幕或指定区域。 */
const videoPurify: ToolDescriptor = {
	name: "video_purify",
	title: "视频净化",
	description: "清理你有权处理的视频中的水印、字幕或指定区域；不承诺还原被遮挡的原始内容。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_purify",
	outputHint: "净化视频",
	enabled: true,
	taskType: "video_purify",
	pollTimeoutMs: 4 * 60 * 60 * 1000,
	options: [
		{
			flag: "--purify-scope <full_screen|subtitle|custom>",
			desc: "净化范围；未传时使用服务端 full_screen 默认值",
		},
		{
			flag: "--purify-method <ffmpeg|raft>",
			desc: "净化方式；未传时使用服务端 ffmpeg 默认值，raft 仅支持 20 分钟以内视频",
		},
		{ flag: "--purify-roi <x,y,w,h>", desc: "custom 模式的归一化矩形区域" },
	],
	buildPayload(fileId, ctx) {
		const payload: Record<string, unknown> = { file_id: fileId };
		const scopeRaw = ctx.opts.purifyScope;
		const scope = scopeRaw == null ? undefined : String(scopeRaw);
		if (scope != null && scope !== "full_screen" && scope !== "subtitle" && scope !== "custom") {
			throw new Error("--purify-scope 只支持 full_screen、subtitle 或 custom");
		}
		if (scope != null) payload.purify_scope = scope;

		const methodRaw = ctx.opts.purifyMethod;
		const method = methodRaw == null ? undefined : String(methodRaw);
		if (method != null && method !== "ffmpeg" && method !== "raft") {
			throw new Error("--purify-method 只支持 ffmpeg 或 raft");
		}
		if (method != null) payload.purify_func_type = method;

		const roiRaw = ctx.opts.purifyRoi;
		if (roiRaw != null) {
			if (scope !== "custom") {
				throw new Error("--purify-roi 只能与 --purify-scope custom 一起使用");
			}
			payload.roi = parseNormalizedRoi(roiRaw);
		} else if (scope === "custom") {
			if (ctx.extraParams.roi == null) {
				throw new Error("--purify-scope custom 必须同时提供 --purify-roi 或 params-json.roi");
			}
			parseNormalizedRoi(ctx.extraParams.roi);
		}
		return payload;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}-purified${extFromUrl(url, ".mp4")}` }] : [];
	},
};

/** video_upscale —— 实验性 GPU 视频超分辨率。 */
const videoUpscale: ToolDescriptor = {
	name: "video_upscale",
	title: "视频超分",
	description: "对一分钟以内的低分辨率视频做实验性 GPU 超分；效果需自行检查。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS, maxDurationSec: 60 },
	priceKey: "video_upscale",
	outputHint: "超分视频",
	enabled: true,
	taskType: "video_upscale",
	pollTimeoutMs: 4 * 60 * 60 * 1000,
	options: [
		{ flag: "--upscale-times <2|3|4>", desc: "超分倍数；未传时使用服务端 2 倍默认值" },
		{ flag: "--upscale-type <Reality|Anime>", desc: "写实或动漫类型；未传时使用服务端 Reality 默认值" },
	],
	buildPayload(fileId, ctx) {
		const payload: Record<string, unknown> = { file_id: fileId };
		if (ctx.opts.upscaleTimes != null) {
			const times = Number(ctx.opts.upscaleTimes);
			if (!Number.isInteger(times) || (times !== 2 && times !== 3 && times !== 4)) {
				throw new Error("--upscale-times 只支持 2、3 或 4");
			}
			payload.times = times;
		}
		if (ctx.opts.upscaleType != null) {
			const upscaleType = String(ctx.opts.upscaleType);
			if (upscaleType !== "Reality" && upscaleType !== "Anime") {
				throw new Error("--upscale-type 只支持 Reality 或 Anime");
			}
			payload.upscale_type = upscaleType;
		}
		return payload;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}-upscaled${extFromUrl(url, ".mp4")}` }] : [];
	},
};

/** video_interpolate —— 以 2/3/4 倍插帧提升视频流畅度。 */
const videoInterpolate: ToolDescriptor = {
	name: "video_interpolate",
	title: "视频插帧",
	description: "以 GPU 帧插值提升视频流畅度；不附加未经服务端声明的时长限制。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_interpolate",
	outputHint: "插帧视频",
	enabled: true,
	taskType: "video_interpolate",
	pollTimeoutMs: 4 * 60 * 60 * 1000,
	options: [
		{ flag: "--interpolate-multiplier <2|3|4>", desc: "插帧倍数；未传时使用服务端 2 倍默认值" },
	],
	buildPayload(fileId, ctx) {
		const payload: Record<string, unknown> = { file_id: fileId };
		if (ctx.opts.interpolateMultiplier != null) {
			const multiplier = Number(ctx.opts.interpolateMultiplier);
			if (!Number.isInteger(multiplier) || (multiplier !== 2 && multiplier !== 3 && multiplier !== 4)) {
				throw new Error("--interpolate-multiplier 只支持 2、3 或 4");
			}
			payload.multiplier = multiplier;
		}
		return payload;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}-interpolated${extFromUrl(url, ".mp4")}` }] : [];
	},
};

/** video_matting —— 视频抠像（公共域 /task/video_matting，10min 硬上限、原片直传禁代理）。 */
const videoMatting: ToolDescriptor = {
	name: "video_matting",
	title: "视频抠像",
	description: "把视频主体从背景抠出，产透明背景 webm（像素级、原片直传不压代理；单片 ≤10 分钟）。",
	kind: "cloud",
	// 10min 硬上限：上传前 ffprobe 探测时长，超限直接拒绝（封带宽/GPU 成本敞口）。
	input: { kind: "video", maxDurationSec: 600 },
	priceKey: "video_matting",
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

// ---------------------------------------------------------------- 音频首批 descriptor

/** audio_separation —— 单条音频分离为人声与伴奏，按 files[].type 映射可选双产物。 */
const audioSeparation: ToolDescriptor = {
	name: "audio_separation",
	title: "人声伴奏分离",
	description: "把单条音频分离为人声与伴奏，可返回其中一项或两项。",
	kind: "cloud",
	input: { kind: "audio" },
	priceKey: "audio_separation",
	outputHint: "人声与伴奏音频",
	enabled: true,
	taskType: "audio_separation",
	options: [{ flag: "--mode <fast|turbo>", desc: "处理档位（默认 fast，可选 turbo）" }],
	buildPayload(fileId, ctx) {
		const raw = ctx.opts.mode;
		const mode = raw == null ? "fast" : String(raw);
		if (mode !== "fast" && mode !== "turbo") throw new Error("--mode 只支持 fast 或 turbo");
		return { file_id: fileId, mode };
	},
	mapOutputs(out, ctx) {
		if (!Array.isArray(out.files)) return [];
		const items: DownloadItem[] = [];
		for (const raw of out.files) {
			if (!raw || typeof raw !== "object") continue;
			const file = raw as Record<string, unknown>;
			const type = file.type;
			const url = file.download_url;
			if ((type !== "vocals" && type !== "instrumental") || typeof url !== "string" || !url.trim()) continue;
			items.push({ url, filename: `${ctx.baseName}-${type}${extFromUrl(url, ".wav")}` });
		}
		return items;
	},
};

/** audio_noise_reduce —— API 同时接受音频与视频输入，但能力模态及产物均为音频。 */
const audioNoiseReduce: ToolDescriptor = {
	name: "audio_noise_reduce",
	title: "音频降噪",
	description: "对音频或视频中的声音降噪，输出降噪后的音频。",
	kind: "cloud",
	input: { kind: "audio", exts: [...AUDIO_EXTS, ...VIDEO_EXTS] },
	priceKey: "audio_noise_reduce",
	outputHint: "降噪音频",
	enabled: true,
	taskType: "audio_noise_reduce",
	options: [{ flag: "--prop-decrease <0..1>", desc: "降噪强度（0 到 1；未传则使用服务端默认）" }],
	buildPayload(fileId, ctx) {
		const payload: Record<string, unknown> = { file_id: fileId };
		if (ctx.opts.propDecrease != null) {
			const value = Number(ctx.opts.propDecrease);
			if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("--prop-decrease 必须是 0 到 1 的数字");
			payload.prop_decrease = value;
		}
		return payload;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}-denoise${extFromUrl(url, ".wav")}` }] : [];
	},
};

/** audio_silence_remove —— 仅音频输入，移除过长静音并只落处理后的音频。 */
const audioSilenceRemove: ToolDescriptor = {
	name: "audio_silence_remove",
	title: "静音片段移除",
	description: "移除音频中过长的静音片段，输出压缩停顿后的音频。",
	kind: "cloud",
	input: { kind: "audio" },
	priceKey: "audio_silence_remove",
	outputHint: "去静音音频",
	enabled: true,
	taskType: "audio_silence_remove",
	options: [
		{ flag: "--min-silence-len <ms>", desc: "被视为静音片段的最短毫秒数（未传则使用服务端默认）" },
		{ flag: "--desired-silence-len <ms>", desc: "处理后保留的静音毫秒数（未传则使用服务端默认）" },
	],
	buildPayload(fileId, ctx) {
		const payload: Record<string, unknown> = { file_id: fileId };
		for (const [optKey, payloadKey, flag] of [
			["minSilenceLen", "min_silence_len", "--min-silence-len"],
			["desiredSilenceLen", "desired_silence_len", "--desired-silence-len"],
		] as const) {
			if (ctx.opts[optKey] == null) continue;
			const value = Number(ctx.opts[optKey]);
			if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} 必须是非负毫秒数`);
			payload[payloadKey] = value;
		}
		return payload;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}-desilence${extFromUrl(url, ".wav")}` }] : [];
	},
};

// ---------------------------------------------------------------- 分析型 descriptor（结构化 JSON 结果，add-tool-video-analysis-json）

/**
 * video_segment —— 机械分镜（画面变动率切分区间）。only_struct=true 出纯结构，不切片产文件。
 * 结果经 mapResult 落 result-output.json（scene_count/scene_list[]），无文件下载。
 */
const videoSegment: ToolDescriptor = {
	name: "video_segment",
	title: "视频机械分镜",
	description: "按画面变动率把视频切成分镜区间，输出结构化 JSON（场景数与各段起止/时长），不产切片文件。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_segment",
	outputHint: "分镜区间结构（result-output.json）",
	enabled: true,
	taskType: "video_segment",
	options: [
		{ flag: "--detector <content|adaptive>", desc: "切分算法（未传则使用服务端默认）" },
		{ flag: "--threshold <number>", desc: "切分阈值（未传则使用服务端默认）" },
	],
	buildPayload(fileId, ctx) {
		const payload: Record<string, unknown> = { file_id: fileId, only_struct: true };
		if (ctx.opts.detector != null) {
			const detector = String(ctx.opts.detector);
			if (detector !== "content" && detector !== "adaptive") {
				throw new Error("--detector 只支持 content 或 adaptive");
			}
			payload.detector = detector;
		}
		if (ctx.opts.threshold != null) {
			const value = Number(ctx.opts.threshold);
			if (!Number.isFinite(value)) throw new Error("--threshold 必须是数字");
			payload.threshold = value;
		}
		return payload;
	},
	mapResult(out) {
		return out as Record<string, unknown>;
	},
};

/**
 * video_ai_segment —— 智能语义分镜（多模态类目/镜头）。only_struct=true 出纯结构。
 * 结果经 mapResult 落 result-output.json（mode/total_shots/categories[].shots[]）。
 */
const videoAiSegment: ToolDescriptor = {
	name: "video_ai_segment",
	title: "视频智能分镜",
	description: "按语义把视频切成带类目、景别、标签、描述的镜头结构，输出结构化 JSON，不产切片文件。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_ai_segment",
	outputHint: "语义分镜结构（result-output.json）",
	enabled: true,
	taskType: "video_ai_segment",
	// 注意：flag 全族唯一（options 统一挂同一 tool 命令）；--mode 已被 audio_separation 占用，故用 --segment-mode。
	options: [
		{ flag: "--segment-mode <scene|shot_type|narrative|subject>", desc: "分镜维度（未传则使用服务端默认）" },
	],
	buildPayload(fileId, ctx) {
		const payload: Record<string, unknown> = { file_id: fileId, only_struct: true };
		if (ctx.opts.segmentMode != null) {
			const mode = String(ctx.opts.segmentMode);
			if (mode !== "scene" && mode !== "shot_type" && mode !== "narrative" && mode !== "subject") {
				throw new Error("--segment-mode 只支持 scene、shot_type、narrative 或 subject");
			}
			payload.mode = mode;
		}
		return payload;
	},
	mapResult(out) {
		return out as Record<string, unknown>;
	},
};

/**
 * video_motion_cut —— 运镜/高光片段（光流分析）。服务端恒纯结构、无 only_struct、完全不产文件。
 * 结果经 mapResult 落 result-output.json（total_cut_points/video_meta/cut_points[]）。
 */
const videoMotionCut: ToolDescriptor = {
	name: "video_motion_cut",
	title: "视频运镜高光",
	description: "用光流分析提取运镜/高光片段，输出结构化 JSON（每片帧号、秒级时码与运动特征），不产文件。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_motion_cut",
	outputHint: "运镜高光片段结构（result-output.json）",
	enabled: true,
	taskType: "video_motion_cut",
	buildPayload(fileId) {
		return { file_id: fileId };
	},
	mapResult(out) {
		return out as Record<string, unknown>;
	},
};

// ---------------------------------------------------------------- 分析型二批（add-tool-video-analysis-batch-2）

/** 数值 flag 解析：显式给出时须为有限数值（语义边界交服务端），否则提交前人话报错；缺省 undefined。 */
function parseNumFlag(v: unknown, flag: string): number | undefined {
	if (v == null) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) throw new Error(`${flag} 需要有限数值，拿到「${String(v)}」`);
	return n;
}

/**
 * video_speaker_detect —— 音视频说话人检测（重 GPU）。内部融合 ASR/人声/画面，产可见说话人 struct。
 * --language 复用全族共享 flag（本工具可选、缺省交服务端默认；必填语义只属 video_ai_subtitle）。
 * struct 原样透传（不做时基换算/字段重命名），时基以服务端输出为准。
 */
const videoSpeakerDetect: ToolDescriptor = {
	name: "video_speaker_detect",
	title: "音视频说话人检测",
	description: "检测画面中谁在何时说话（融合语音转写与人脸/人身追踪），输出可见说话人结构化 JSON，不产文件。重 GPU 能力、按分钟计费较高，长片先想清楚。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_speaker_detect",
	outputHint: "可见说话人结构（result-output.json，时基以服务端输出为准）",
	enabled: true,
	taskType: "video_speaker_detect",
	options: [
		{ flag: "--max-faces-per-frame <n>", desc: "单帧最多检测人脸数（未传则服务端默认）" },
		{ flag: "--detect-body", desc: "同时检测人身（未传则服务端默认关闭）" },
		{ flag: "--track-sample-fps <n>", desc: "追踪采样帧率（未传则服务端默认）" },
	],
	buildPayload(fileId, ctx) {
		const o = ctx.opts;
		const p: Record<string, unknown> = { file_id: fileId };
		if (typeof o.language === "string" && o.language.trim()) p.language = o.language;
		const maxFaces = parseNumFlag(o.maxFacesPerFrame, "--max-faces-per-frame");
		if (maxFaces != null) p.max_faces_per_frame = maxFaces;
		if (o.detectBody === true) p.detect_body = true;
		const fps = parseNumFlag(o.trackSampleFps, "--track-sample-fps");
		if (fps != null) p.track_sample_fps = fps;
		return p;
	},
	mapResult(out) {
		return out as Record<string, unknown>;
	},
};

/**
 * video_face_track —— 多脸追踪/身份聚类（重 GPU）。产稳定人物 ID + 时间段 + 轨迹 struct。
 * 结构化 time_ranges 不设标量 flag，经 --params-json 透传（先例：ai_subtitle 的 content）。
 */
const videoFaceTrack: ToolDescriptor = {
	name: "video_face_track",
	title: "多脸追踪/身份聚类",
	description: "追踪视频中的人脸并聚成稳定人物 ID（出场时间段与轨迹），输出结构化 JSON，不产文件；`time_ranges` 经 --params-json 透传。重 GPU 能力、按分钟计费较高。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_face_track",
	outputHint: "人物 ID/时间段/轨迹结构（result-output.json，时基以服务端输出为准）",
	enabled: true,
	taskType: "video_face_track",
	options: [
		{ flag: "--sample-fps <n>", desc: "检测采样帧率（未传则服务端默认）" },
		{ flag: "--max-faces <n>", desc: "最多聚类人物数（未传则服务端默认）" },
		{ flag: "--min-face-ratio <n>", desc: "最小人脸占比阈值（未传则服务端默认）" },
		{ flag: "--enable-body-match", desc: "启用人身匹配辅助聚类（未传则服务端默认关闭）" },
		{ flag: "--similarity-threshold <n>", desc: "身份聚类相似度阈值（未传则服务端默认）" },
	],
	buildPayload(fileId, ctx) {
		const o = ctx.opts;
		const p: Record<string, unknown> = { file_id: fileId };
		const sampleFps = parseNumFlag(o.sampleFps, "--sample-fps");
		if (sampleFps != null) p.sample_fps = sampleFps;
		const maxFaces = parseNumFlag(o.maxFaces, "--max-faces");
		if (maxFaces != null) p.max_faces = maxFaces;
		const minRatio = parseNumFlag(o.minFaceRatio, "--min-face-ratio");
		if (minRatio != null) p.min_face_ratio = minRatio;
		if (o.enableBodyMatch === true) p.enable_body_match = true;
		const sim = parseNumFlag(o.similarityThreshold, "--similarity-threshold");
		if (sim != null) p.similarity_threshold = sim;
		return p;
	},
	mapResult(out) {
		return out as Record<string, unknown>;
	},
};

// ---------------------------------------------------------------- C1 漏网批（add-tool-c1-batch-2）

/**
 * audio_speaker_split —— 按说话人分轨。默认产各说话人 .wav（mapOutputs 多产物）+ spoken_list 时间线（mapResult）。
 * --only-struct 只出结构不切文件。mapResult/mapOutputs 共存的真实用例。
 */
const audioSpeakerSplit: ToolDescriptor = {
	name: "audio_speaker_split",
	title: "按说话人分轨",
	description: "把多说话人音频按说话人分成独立音轨，并产说话人时间线结构；--only-struct 只出结构不切文件。",
	kind: "cloud",
	input: { kind: "audio" },
	priceKey: "audio_speaker_split",
	outputHint: "各说话人音轨 + 时间线结构",
	enabled: true,
	taskType: "audio_speaker_split",
	options: [{ flag: "--only-struct", desc: "只输出说话人时间线结构，不切分音轨文件" }],
	buildPayload(fileId, ctx) {
		return { file_id: fileId, only_struct: ctx.opts.onlyStruct === true };
	},
	mapOutputs(out, ctx) {
		if (!Array.isArray(out.files)) return [];
		const items: DownloadItem[] = [];
		for (const raw of out.files) {
			if (!raw || typeof raw !== "object") continue;
			const file = raw as Record<string, unknown>;
			const url = file.download_url;
			if (typeof url !== "string" || !url.trim()) continue;
			const speaker = typeof file.speaker === "string" && file.speaker.trim() ? file.speaker : `speaker_${items.length + 1}`;
			items.push({ url, filename: `${ctx.baseName}-${speaker}${extFromUrl(url, ".wav")}` });
		}
		return items;
	},
	mapResult(out) {
		// 只落时间线结构，不含已下载的 files 数组。
		return { spoken_list: Array.isArray(out.spoken_list) ? out.spoken_list : [] };
	},
};

/** audio_stretch —— 变调变速（semitones 升正降负、speed 倍率 MUST > 0，二者独立）。 */
const audioStretch: ToolDescriptor = {
	name: "audio_stretch",
	title: "音频变调变速",
	description: "对音频独立调整音高（半音）与速度（倍率），输出处理后的音频。",
	kind: "cloud",
	input: { kind: "audio" },
	priceKey: "audio_stretch",
	outputHint: "变调变速音频",
	enabled: true,
	taskType: "audio_stretch",
	options: [
		{ flag: "--semitones <n>", desc: "变调半音（升正降负；未传则不变调）" },
		{ flag: "--speed <n>", desc: "变速/语速倍率（各工具范围与缺省见各自说明）" },
	],
	buildPayload(fileId, ctx) {
		const payload: Record<string, unknown> = { file_id: fileId };
		if (ctx.opts.semitones != null) {
			const value = Number(ctx.opts.semitones);
			if (!Number.isFinite(value)) throw new Error("--semitones 必须是数字");
			payload.semitones = value;
		}
		if (ctx.opts.speed != null) {
			const value = Number(ctx.opts.speed);
			if (!Number.isFinite(value) || value <= 0) throw new Error("--speed 必须是大于 0 的数字");
			payload.speed = value;
		}
		return payload;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}-stretch${extFromUrl(url, ".wav")}` }] : [];
	},
};

/** piano_audio_to_midi —— 钢琴音频转 MIDI（仅 file_id，产 .mid）。 */
const pianoAudioToMidi: ToolDescriptor = {
	name: "piano_audio_to_midi",
	title: "钢琴音频转 MIDI",
	description: "把钢琴演奏音频扒谱为 MIDI 文件。",
	kind: "cloud",
	input: { kind: "audio" },
	priceKey: "piano_audio_to_midi",
	outputHint: "MIDI 文件（.mid）",
	enabled: true,
	taskType: "piano_audio_to_midi",
	buildPayload(fileId) {
		return { file_id: fileId };
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}${extFromUrl(url, ".mid")}` }] : [];
	},
};

/** piano_audio_enhance —— 钢琴音频修复增强（WAV 主产物 + MIDI 副产物）。 */
const pianoAudioEnhance: ToolDescriptor = {
	name: "piano_audio_enhance",
	title: "钢琴音频修复增强",
	description: "修复并增强钢琴录音音质，产高质量 WAV 与配套 MIDI。",
	kind: "cloud",
	input: { kind: "audio" },
	priceKey: "piano_audio_enhance",
	outputHint: "高质量 WAV + MIDI",
	enabled: true,
	taskType: "piano_audio_enhance",
	buildPayload(fileId) {
		return { file_id: fileId };
	},
	mapOutputs(out, ctx) {
		const files: DownloadItem[] = [];
		const main = pickUrl(out, ["download_url"]);
		if (main) files.push({ url: main, filename: `${ctx.baseName}-enhanced${extFromUrl(main, ".wav")}` });
		const midi = pickUrl(out, ["midi_download_url"]);
		if (midi) files.push({ url: midi, filename: `${ctx.baseName}${extFromUrl(midi, ".mid")}` });
		return files;
	},
};

/** image_to_square —— 长图转方图（max_line 默认 4000、上限 20000）。 */
const imageToSquare: ToolDescriptor = {
	name: "image_to_square",
	title: "长图转方图",
	description: "把长图智能转为方形图，可指定最大边长（默认 4000，上限 20000）。",
	kind: "cloud",
	input: { kind: "image" },
	priceKey: "image_to_square",
	outputHint: "方形图片",
	enabled: true,
	taskType: "image_to_square",
	options: [{ flag: "--max-line <px>", desc: "最大边长像素（默认 4000，上限 20000）" }],
	buildPayload(fileId, ctx) {
		const payload: Record<string, unknown> = { file_id: fileId };
		if (ctx.opts.maxLine != null) {
			const value = Number(ctx.opts.maxLine);
			if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 20000) {
				throw new Error("--max-line 必须是 1 到 20000 之间的整数");
			}
			payload.max_line = value;
		}
		return payload;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}-square${extFromUrl(url, ".jpg")}` }] : [];
	},
};

/** image_to_live —— 智能 LivePhoto（图 → .mp4 微动视频，产物是视频非图片）。 */
const imageToLive: ToolDescriptor = {
	name: "image_to_live",
	title: "智能 LivePhoto",
	description: "把一张静态图片生成微动的 LivePhoto 视频（产物是视频）。",
	kind: "cloud",
	input: { kind: "image" },
	priceKey: "image_to_live",
	outputHint: "微动视频（.mp4）",
	// 2026-08-05 回收（adjust-gate-image-to-live）：上游生成能力暂未开放，恢复后新 change 翻门重上
	enabled: false,
	disabledReason: "上游生成能力暂未开放，恢复后重新上架",
	taskType: "image_to_live",
	buildPayload(fileId) {
		return { file_id: fileId };
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url", "video_download_url", "url"]);
		return url ? [{ url, filename: `${ctx.baseName}-live${extFromUrl(url, ".mp4")}` }] : [];
	},
};

// ---------------------------------------------------------------- 智能视频字幕（add-tool-video-ai-subtitle）

/** 服务端 subtitle_type 样式枚举（7 种小稳集，bundle 校验；--param 可绕过作前向兼容逃生）。 */
const AI_SUBTITLE_TYPES = ["default", "outline", "cinema_yellow", "immersive_box", "wide_spacing", "deep_shadow", "boxed"];
/** 服务端 subtitle_color 颜色枚举（11 种）。 */
const AI_SUBTITLE_COLORS = ["雅黑", "淡绿", "森林绿", "湖蓝", "道奇蓝", "钢蓝", "浅粉红", "深橙", "珊瑚橙", "橙红", "土豪金"];

/**
 * video_ai_subtitle —— 智能视频字幕。一进多出的混合能力：
 * mapOutputs 收 .ass 字幕（恒有）+ 可选烧录/去字幕 .mp4；mapResult 落 summary + asr 结构。
 * --language 必填（服务端校验支持列表）；内部编排较重，pollTimeoutMs 放宽 4h。
 */
const videoAiSubtitle: ToolDescriptor = {
	name: "video_ai_subtitle",
	title: "智能视频字幕",
	description: "为视频（或音频）智能生成字幕，可选双语翻译、烧录进视频、去除原字幕；另产 LLM 摘要与字级时间轴。",
	kind: "cloud",
	input: { kind: "video", exts: [...PUBLIC_VIDEO_EXTS, ...AUDIO_EXTS] },
	priceKey: "video_ai_subtitle",
	outputHint: "字幕 .ass + 可选烧录/去字幕视频 + 摘要/字级时轴结构",
	enabled: true,
	taskType: "video_ai_subtitle",
	pollTimeoutMs: 4 * 60 * 60 * 1000, // 内部含去字幕+ASR+LLM+烧录，长视频耗时可观
	options: [
		{ flag: "--language <code>", desc: "源语种代码（video_ai_subtitle 必填、其余工具可选；具体取值由服务端支持列表校验）" },
		{ flag: "--translate-language <code>", desc: "译文目标语种（未传则单语）" },
		{ flag: "--need-render", desc: "把字幕烧录进视频（仅视频输入有效）" },
		{ flag: "--need-pure", desc: "先去除原视频中的字幕" },
		{ flag: "--subtitle-type <style>", desc: `字幕样式：${AI_SUBTITLE_TYPES.join("/")}（未传则用服务端默认）` },
		{ flag: "--subtitle-color <color>", desc: `字幕颜色：${AI_SUBTITLE_COLORS.join("/")}（未传则用服务端默认）` },
	],
	/**
	 * 默认只传抽出音频（毛片永不上传，对齐 oralcut / long2short）：字幕主产物是 .ass 文本，画面对
	 * 生成字幕本身无用。例外只有 --need-pure——去原字幕是画面操作，音频路径下服务端无从执行，
	 * 故回退整片上传并明说原因（别让用户付了钱、传了参数、什么都没发生）。
	 */
	async preprocess(ctx) {
		const inputAbs = ctx.inputAbs!;
		if (ctx.opts.needPure === true) {
			ctx.warn("--need-pure 需要画面（去原字幕是画面操作），本次整片上传；只要字幕文件时去掉该 flag 即可只传音频");
			return inputAbs;
		}
		if (isAudioFile(inputAbs)) return inputAbs; // 用户本来就传的音频，不重复抽
		const audio = await extractAudio(inputAbs, ctx.ffmpegPath);
		return audio;
	},
	buildPayload(fileId, ctx) {
		const language = ctx.opts.language == null ? "" : String(ctx.opts.language).trim();
		if (!language) throw new Error("--language 必填：请指定源语种代码（具体取值见云端 API 文档 / 服务端支持列表）");
		const payload: Record<string, unknown> = { file_id: fileId, language };
		// 上传物是抽出音频时，画布几何须由客户端回传（服务端音频分支否则退 1920x1080 兜底，
		// 宽高比不一致会落错样式档）。服务端未支持该字段时被忽略，客户端不因此失败。
		const inputAbs = ctx.inputAbs;
		if (inputAbs && !isAudioFile(inputAbs)) {
			try {
				const geo = probeGeometry(inputAbs, ctx.ffmpegPath);
				if (geo.width > 0 && geo.height > 0) payload.video_size = [geo.width, geo.height];
			} catch {
				ctx.warn("探原片几何失败，本次不回传 video_size（服务端将按 1920x1080 兜底出字幕）");
			}
		}
		if (ctx.opts.translateLanguage != null) {
			const t = String(ctx.opts.translateLanguage).trim();
			if (t) payload.translate_language = t;
		}
		// need_render 不再提交给服务端：烧录改在本地做（见 postprocess），否则云端白烧一遍
		// 还要把大成片下行回来。--need-pure 仍走服务端（它必须有画面，且已回退整片上传）。
		if (ctx.opts.needPure === true) payload.need_pure = true;
		if (ctx.opts.subtitleType != null) {
			const v = String(ctx.opts.subtitleType);
			if (!AI_SUBTITLE_TYPES.includes(v)) throw new Error(`--subtitle-type 只支持 ${AI_SUBTITLE_TYPES.join("、")}`);
			payload.subtitle_type = v;
		}
		if (ctx.opts.subtitleColor != null) {
			const v = String(ctx.opts.subtitleColor);
			if (!AI_SUBTITLE_COLORS.includes(v)) throw new Error(`--subtitle-color 只支持 ${AI_SUBTITLE_COLORS.join("、")}`);
			payload.subtitle_color = v;
		}
		return payload;
	},
	mapOutputs(out, ctx) {
		const files: DownloadItem[] = [];
		const sub = pickUrl(out, ["subtitle_file_download_url"]);
		if (sub) files.push({ url: sub, filename: `${ctx.baseName}${extFromUrl(sub, ".ass")}` });
		const rendered = pickUrl(out, ["rendered_file_download_url"]);
		if (rendered) files.push({ url: rendered, filename: `${ctx.baseName}-subtitled${extFromUrl(rendered, ".mp4")}` });
		const pure = pickUrl(out, ["pure_file_download_url"]);
		if (pure) files.push({ url: pure, filename: `${ctx.baseName}-pure${extFromUrl(pure, ".mp4")}` });
		return files;
	},
	/**
	 * --need-render 的本地烧录：拿拉回的 .ass 烧本地原片，毛片不出本地、成片也不从云端下行。
	 * 缺模板字体一律硬失败——替代字体烧出来的东西「看着正常」但与模板设计不符，用户无从察觉
	 * （与 ffmpeg 不自分发同一口径：不自带字体，也不假装能用别的顶）。
	 */
	async postprocess(ctx, landed) {
		if (ctx.opts.needRender !== true) return;
		const inputAbs = ctx.inputAbs!;
		if (isAudioFile(inputAbs)) {
			throw new Error("--need-render 需要视频输入：本次输入是音频文件，无画面可烧");
		}
		const ass = landed.find((p) => p.toLowerCase().endsWith(".ass"));
		if (!ass) throw new Error("未拉回 .ass 字幕文件，无法本地烧录");

		const fonts = assFontNames(await readFile(ass, "utf8"));
		const missing: string[] = [];
		for (const f of fonts) {
			if ((await probeFontAvailable(f, ctx.ffmpegPath)) === false) missing.push(f);
		}
		if (missing.length) {
			throw new Error(
				`本机缺字幕模板所需字体：${missing.join("、")}。` +
					`装上后重跑即可（字幕文件已落地，无需重新提交任务）。CLI 不自带字体、也不用替代字体顶——` +
					`替代字体烧出来的成片观感与模板设计不符且难以察觉。`,
			);
		}
		const out = join(dirname(ass), `${ctx.baseName}-subtitled.mp4`);
		await burnSubtitle(inputAbs, ass, out, { ffmpegPath: ctx.ffmpegPath });
		return [out];
	},
	mapResult(out) {
		return { summary: typeof out.summary === "string" ? out.summary : "", asr: out.asr ?? null };
	},
};

// ---------------------------------------------------------------- 长剪短·精剪（add-tool-video-long2short-pro）

/** 精剪成片画幅枚举（与服务端 _OUTPUT_SIZE_RATIOS 同源；自定义 WxH 由服务端校验）。 */
const PRO_DURATION_PREFS = ["auto", "short", "medium", "long"];

/**
 * video_long2short_pro —— 长剪短·精剪，一键直接出成片。
 *
 * 与粗剪 `gtrk long2short`（独立命令）分工明确：粗剪出**可编辑工程**（gtrk/剪映/PR）、与客户端打配合、
 * 毛片不上传；精剪**只直接出成片 mp4**、不给编辑面、整片上传（服务端要渲染，input_ext 亦只收视频）。
 * 服务端拒收 outputs/source_path，正是「直接结果型能力」的形状，故入驻工具族而非另开命令。
 * 产物：逐条 clip{i}.mp4 + result-output.json + 人读报告 clips.md（含润色降级明细）。
 */
const videoLong2ShortPro: ToolDescriptor = {
	name: "video_long2short_pro",
	title: "长剪短·精剪（直接出片）",
	description:
		"长内容按语义抽多条高光短片并一键出成品：选段+跳剪+分屏内核，叠加模糊底画布适配/克制运镜/调速保音高/智能字幕。只出成片，不产工程文件——要可编辑工程请用 gtrk long2short（粗剪）。",
	kind: "cloud",
	input: { kind: "video", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_long2short_pro",
	outputHint: "逐条高光成片 mp4 + 切片报告 clips.md",
	enabled: true,
	taskType: "video_long2short_pro",
	pollTimeoutMs: 4 * 60 * 60 * 1000, // 内含 ASR + 选段 + 逐 clip 润色渲染，长片耗时可观
	options: [
		{ flag: "--language <code>", desc: "源语种代码（精剪必填；取值以服务端支持列表为准）" },
		{ flag: "--output-language <code>", desc: "选段/文案的输出语种（未传则同源语种）" },
		{ flag: "--main-topic <text>", desc: "主题引导（影响选段偏好）" },
		{ flag: "--output-size <s>", desc: "成片画幅 9:16|16:9|1:1 或自定义 WxH（未传则服务端默认）" },
		{ flag: "--no-jump-cut", desc: "关闭跳剪（默认开：片内去水词/冗余，只删不重排）" },
		{ flag: "--duration-pref <p>", desc: `成片时长偏好 ${PRO_DURATION_PREFS.join("/")}（成片条数由内容语义决定、不可指定）` },
		{ flag: "--max-clip-sec <n>", desc: "单条成片时长安全上限（秒；未传则服务端默认）" },
		{ flag: "--split-screen", desc: "开启智能分屏（多人同框段合成分屏画面）" },
		{ flag: "--split-orientation <o>", desc: "分屏方向 auto|lr|tb（未传则服务端默认）" },
		{ flag: "--speed-factor <n>", desc: "整体调速倍率（保音高；未传则服务端默认）" },
		{ flag: "--no-camera-move", desc: "关闭克制运镜（默认开：亚像素推/拉）" },
		{ flag: "--no-subtitle", desc: "关闭智能字幕（默认开：成片内烧录字幕）" },
		{ flag: "--subtitle-translate-language <code>", desc: "字幕译文语种（未传则单语字幕）" },
	],
	buildPayload(fileId, ctx) {
		const o = ctx.opts;
		const language = o.language == null ? "" : String(o.language).trim();
		if (!language) throw new Error("--language 必填：请指定源语种代码（具体取值见云端 API 文档 / 服务端支持列表）");
		const p: Record<string, unknown> = { file_id: fileId, language };

		if (o.outputLanguage != null && String(o.outputLanguage).trim()) p.output_language = String(o.outputLanguage).trim();
		if (o.mainTopic != null && String(o.mainTopic).trim()) p.main_topic = String(o.mainTopic).trim();
		if (o.outputSize != null && String(o.outputSize).trim()) p.output_size = String(o.outputSize).trim();
		if (o.jumpCut === false) p.jump_cut = false;

		const duration: Record<string, unknown> = {};
		if (o.durationPref != null && String(o.durationPref).trim()) duration.pref = String(o.durationPref).trim();
		const mcs = parseCountFlag(o.maxClipSec, "--max-clip-sec");
		if (mcs != null) duration.max_clip_sec = mcs;
		if (Object.keys(duration).length) p.duration = duration;

		if (o.splitScreen === true) {
			const ss: Record<string, unknown> = { enable: true };
			if (o.splitOrientation != null && String(o.splitOrientation).trim()) ss.orientation = String(o.splitOrientation).trim();
			p.split_screen = ss;
		}

		if (o.speedFactor != null) {
			const n = Number(o.speedFactor);
			if (!Number.isFinite(n)) throw new Error(`--speed-factor 需要有限数值，拿到「${o.speedFactor}」`);
			p.speed = { factor: n };
		}
		if (o.cameraMove === false) p.camera_move = { enable: false };

		const sub: Record<string, unknown> = {};
		if (o.subtitle === false) sub.enable = false;
		if (o.subtitleTranslateLanguage != null && String(o.subtitleTranslateLanguage).trim()) {
			sub.translate_language = String(o.subtitleTranslateLanguage).trim();
		}
		if (Object.keys(sub).length) p.subtitle = sub;

		return p;
	},
	mapOutputs(out, _ctx) {
		const clips = Array.isArray(out.clips) ? (out.clips as Record<string, unknown>[]) : [];
		const files: DownloadItem[] = [];
		for (const [i, clip] of clips.entries()) {
			const f = clip?.file as Record<string, unknown> | undefined;
			const url = typeof f?.download_url === "string" ? f.download_url : undefined;
			if (!url) continue; // 该条渲染失败（file 为 null）→ 不产伪条目，降级明细由报告点名
			files.push({ url, filename: `clip${i}${extFromUrl(url, ".mp4")}` });
		}
		return files;
	},
	mapResult(out) {
		// clips 原样保留（含 file 的 file_id/download_url）：download_url 有时效，但它同时是
		// 「这条渲出来了没有」的唯一机读证据，抹掉反而让面包屑失去价值。
		return { clips: out.clips ?? [], report: out.report ?? {} };
	},
	async postprocess(ctx, landed, out) {
		const clips = Array.isArray(out.clips) ? (out.clips as Record<string, unknown>[]) : [];
		if (!clips.length) return;
		const mp4s = landed.filter((p) => p.toLowerCase().endsWith(".mp4"));
		const byIndex = clips.map((_c, i) => mp4s.find((p) => new RegExp(`clip${i}\.[a-z0-9]+$`, "i").test(p)));
		const dest = join(dirname(landed[0] ?? "."), "clips.md");
		await writeFile(
			dest,
			renderProReport(clips, (out.report ?? {}) as Record<string, unknown>, {
				source: ctx.inputAbs ?? ctx.baseName,
				clipFiles: byIndex,
			}),
			"utf8",
		);
		return [dest];
	},
};

// ---------------------------------------------------------------- 多文件图片工具（add-tool-multifile-images）

/** 数值 flag 解析：显式给出时须为有限非负整数，否则提交前人话报错；缺省返回 undefined。 */
function parseCountFlag(v: unknown, flag: string): number | undefined {
	if (v == null) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
		throw new Error(`${flag} 需要有限非负整数，拿到「${String(v)}」`);
	}
	return n;
}

/**
 * image_classic_template —— 智能拼图/封面（images 多文件首个成员）。
 * --main-title 必填（服务端 required）；数量类参数服务端钳制 ≤20（CLI 照传、如实转述不复刻）。
 * 产物三组（text/pic/render）各自可空，按组命名收敛。
 */
const imageClassicTemplate: ToolDescriptor = {
	name: "image_classic_template",
	title: "智能拼图/封面",
	description: "标题 + 多张图 → 成品封面/拼图；--main-title 必填，文件顺序即拼装顺序。",
	kind: "cloud",
	input: { kind: "images" },
	priceKey: "image_classic_template",
	outputHint: "封面/拼图成品（text/pic/render 三组、可多张）",
	enabled: true,
	taskType: "image_classic_template",
	options: [
		{ flag: "--main-title <text>", desc: "主标题（image_classic_template 必填）" },
		{ flag: "--sub-title <text>", desc: "副标题（未传则服务端默认）" },
		{ flag: "--template-mode <mode>", desc: "拼图模式（映射服务端 mode；未传则服务端默认）" },
		{ flag: "--aspect <ratio>", desc: "画幅比例（如 3:4；未传则服务端默认）" },
		{ flag: "--quality <q>", desc: "输出质量（如 1080p；未传则服务端默认）" },
		{ flag: "--output-pic-count <n>", desc: "图组产出数量（服务端钳制 ≤20；未传则服务端默认）" },
		{ flag: "--output-text-count <n>", desc: "文字组产出数量（服务端钳制 ≤20；未传则服务端默认）" },
		{ flag: "--title-layout <layout>", desc: "标题版式（映射服务端 output_title_layout；未传则服务端默认）" },
	],
	buildPayloadMulti(fileIds, ctx) {
		const o = ctx.opts;
		const mainTitle = typeof o.mainTitle === "string" && o.mainTitle.trim() ? o.mainTitle : undefined;
		if (!mainTitle) throw new Error("image_classic_template 需要 --main-title <text>（主标题必填）");
		const p: Record<string, unknown> = { file_ids: fileIds, main_title: mainTitle };
		if (typeof o.subTitle === "string") p.sub_title = o.subTitle;
		if (typeof o.templateMode === "string") p.mode = o.templateMode;
		if (typeof o.aspect === "string") p.aspect = o.aspect;
		if (typeof o.quality === "string") p.quality = o.quality;
		const pic = parseCountFlag(o.outputPicCount, "--output-pic-count");
		if (pic != null) p.output_pic_count = pic;
		const text = parseCountFlag(o.outputTextCount, "--output-text-count");
		if (text != null) p.output_text_count = text;
		if (typeof o.titleLayout === "string") p.output_title_layout = o.titleLayout;
		return p;
	},
	mapOutputs(out, ctx) {
		const groups: Array<[key: string, tag: string]> = [
			["text_file_download_url_list", "text"],
			["pic_file_download_url_list", "pic"],
			["render_file_download_url_list", "render"],
		];
		const items: DownloadItem[] = [];
		for (const [key, tag] of groups) {
			const arr = out[key];
			if (!Array.isArray(arr)) continue;
			arr.forEach((u, i) => {
				if (typeof u === "string" && u.trim()) {
					items.push({ url: u, filename: `${ctx.baseName}-${tag}-${i + 1}${extFromUrl(u, ".jpg")}` });
				}
			});
		}
		return items;
	},
};

/** image_vertical_stitch —— 拼长图：多图按传入顺序竖拼，payload 仅 file_ids，单产物。 */
const imageVerticalStitch: ToolDescriptor = {
	name: "image_vertical_stitch",
	title: "拼长图",
	description: "多张图片按传入顺序竖向拼接成一张长图。",
	kind: "cloud",
	input: { kind: "images" },
	priceKey: "image_vertical_stitch",
	outputHint: "垂直拼接长图",
	enabled: true,
	taskType: "image_vertical_stitch",
	buildPayloadMulti(fileIds) {
		return { file_ids: fileIds };
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}-stitch${extFromUrl(url, ".jpg")}` }] : [];
	},
};

/**
 * video_split_screen —— 智能分屏（videos 多文件首个成员，add-tool-video-split-screen）。
 * 简单档：positional 2–16 个视频每文件一条整段 clip；精确档：--clips-json 条目按 0 起索引引用
 * positional 输入（{input, begin_time_ms?, end_time_ms?, crop?}，毫秒时基/归一化 crop 原样透传，
 * 同文件可多窗口）。枚举/区间/资源闸以服务端校验为真相（参数非法不计费）；成片时长对齐最短段。
 */
const videoSplitScreen: ToolDescriptor = {
	name: "video_split_screen",
	title: "智能分屏",
	description:
		"把 2–16 段视频合成一条分屏成片（reaction/对比/多画面同框）；--clips-json 可按 0 起索引精确指定每段毫秒区间与裁剪框，成片时长对齐最短段。",
	kind: "cloud",
	input: { kind: "videos", exts: PUBLIC_VIDEO_EXTS },
	priceKey: "video_split_screen",
	outputHint: "分屏成片视频",
	enabled: true,
	taskType: "video_split_screen",
	options: [
		{
			flag: "--clips-json <json>",
			desc: "结构化条目数组：{input:0 起 positional 序号, begin_time_ms?, end_time_ms?, crop?{x,y,width,height 归一化}}；缺省=每个输入整段参与",
		},
		{ flag: "--layout-mode <m>", desc: "布局模式（auto/template；未传则服务端默认 auto）" },
		{ flag: "--layout-id <n>", desc: "template 模式的布局模板号（合法性由服务端校验）" },
		{ flag: "--output-ratio <r>", desc: "成片画幅（9:16/16:9/1:1；未传则服务端默认）" },
		{ flag: "--fit-mode <m>", desc: "画面贴合方式（cover/contain；未传则服务端默认）" },
		{ flag: "--audio-mode <m>", desc: "音频方式（first/mix/mute；未传则服务端默认）" },
		{ flag: "--gap-ratio <n>", desc: "分屏缝隙比例（0–0.05；未传则服务端默认）" },
		{ flag: "--background-color <c>", desc: "缝隙底色 #RRGGBB（未传则服务端默认）" },
	],
	buildPayloadMulti(fileIds, ctx) {
		const o = ctx.opts;
		let clips: Record<string, unknown>[];
		const clipsJson = o.clipsJson;
		if (typeof clipsJson === "string" && clipsJson.trim()) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(clipsJson);
			} catch {
				throw new Error(`--clips-json 不是合法 JSON：${clipsJson}`);
			}
			if (!Array.isArray(parsed)) throw new Error("--clips-json 必须是一个 JSON 数组");
			if (parsed.length < 2 || parsed.length > 16) {
				throw new Error(`--clips-json 需要 2–16 个条目，拿到 ${parsed.length}`);
			}
			clips = parsed.map((raw, i) => {
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
					throw new Error(`--clips-json 条目[${i}] 必须是对象`);
				}
				const { input, ...rest } = raw as Record<string, unknown>;
				if (typeof input !== "number" || !Number.isInteger(input) || input < 0 || input >= fileIds.length) {
					throw new Error(
						`--clips-json 条目[${i}].input 需要 0 起整数且 < 输入文件数（${fileIds.length}），拿到「${String(input)}」`,
					);
				}
				return { file_id: fileIds[input], ...rest };
			});
		} else {
			if (fileIds.length < 2 || fileIds.length > 16) {
				throw new Error(`video_split_screen 需要 2–16 个输入视频，拿到 ${fileIds.length}`);
			}
			clips = fileIds.map((id) => ({ file_id: id }));
		}
		const p: Record<string, unknown> = { clips };
		if (typeof o.layoutMode === "string") p.layout_mode = o.layoutMode;
		const layoutId = parseNumFlag(o.layoutId, "--layout-id");
		if (layoutId != null) {
			if (!Number.isInteger(layoutId)) throw new Error(`--layout-id 需要整数，拿到「${String(o.layoutId)}」`);
			p.layout_id = layoutId;
		}
		const seed = parseNumFlag(o.seed, "--seed");
		if (seed != null) {
			if (!Number.isInteger(seed)) throw new Error(`--seed 需要整数，拿到「${String(o.seed)}」`);
			p.random_seed = seed;
		}
		if (typeof o.outputRatio === "string") p.output_ratio = o.outputRatio;
		if (typeof o.quality === "string") p.quality = o.quality;
		if (typeof o.fitMode === "string") p.fit_mode = o.fitMode;
		if (typeof o.audioMode === "string") p.audio_mode = o.audioMode;
		const gap = parseNumFlag(o.gapRatio, "--gap-ratio");
		if (gap != null) p.gap_ratio = gap;
		if (typeof o.backgroundColor === "string") p.background_color = o.backgroundColor;
		return p;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		return url ? [{ url, filename: `${ctx.baseName}-splitscreen${extFromUrl(url, ".mp4")}` }] : [];
	},
};

// ---------------------------------------------------------------- 零上传文本工具（add-tool-audio-tts-clone）

/**
 * audio_tts_clone —— 声音克隆配音（none 零上传直提交首个成员）。
 * 文本二选一（--text 短文本 / --text-file UTF-8 文件）+ --speaker 必填（服务端 ext_code 白名单，
 * 传错时报错自带可用列表=发现路径）；speed/text_split_method 缺省跟随该音色服务端调好的参数（不注默认）。
 * 计费按文本字数折算分钟（约 200 字/分钟，服务端估算）；字数上限 2000 如实转述、服务端为真相。
 */
const audioTtsClone: ToolDescriptor = {
	name: "audio_tts_clone",
	title: "声音克隆配音",
	description:
		"输入一段文字，用指定音色合成配音音频（--text 短文本或 --text-file 文本文件二选一，≤2000 字）。按文本字数折算分钟计费。",
	kind: "cloud",
	input: { kind: "none" },
	priceKey: "audio_tts_clone",
	outputHint: "配音音频（wav/mp3）",
	enabled: true,
	taskType: "audio_tts_clone",
	options: [
		{ flag: "--text <text>", desc: "待合成的短文本（与 --text-file 二选一）" },
		{ flag: "--text-file <file>", desc: "待合成的文本文件（UTF-8；与 --text 二选一）" },
		{ flag: "--speaker <code>", desc: "音色代号（必填；可用列表见官网文档「可用音色」，传错时报错会列出全部可用项）" },
		{ flag: "--text-lang <lang>", desc: "文本语言（未传则服务端默认 zh）" },
		{ flag: "--output-format <fmt>", desc: "输出音频格式 wav/mp3（未传则服务端默认 wav）" },
		{ flag: "--split-method <m>", desc: "长文切分法 cut0~cut5（未传则跟随该音色调好的参数）" },
		{ flag: "--batch-size <n>", desc: "分段并发批大小 1~16（未传则服务端默认）" },
	],
	buildPayloadNone(ctx) {
		const o = ctx.opts;
		const hasText = typeof o.text === "string" && o.text.trim() !== "";
		const hasFile = typeof o.textFile === "string" && (o.textFile as string).trim() !== "";
		if (hasText && hasFile) throw new Error("--text 与 --text-file 只能给其一");
		if (!hasText && !hasFile) throw new Error("需要 --text <短文本> 或 --text-file <文本文件>（UTF-8）之一");
		const text = hasText ? (o.text as string) : readFileSync(resolvePath(o.textFile as string), "utf8");
		if (!text.trim()) throw new Error("文本内容为空");
		if (!(typeof o.speaker === "string" && o.speaker.trim())) {
			throw new Error("audio_tts_clone 需要 --speaker <音色代号>（可用列表见官网文档；传错时服务端报错会列出可用项）");
		}
		const p: Record<string, unknown> = { text, speaker: o.speaker };
		if (typeof o.textLang === "string") p.text_lang = o.textLang;
		if (typeof o.outputFormat === "string") p.output_format = o.outputFormat;
		const speed = parseNumFlag(o.speed, "--speed");
		if (speed != null) p.speed = speed;
		if (typeof o.splitMethod === "string") p.text_split_method = o.splitMethod;
		const bs = parseNumFlag(o.batchSize, "--batch-size");
		if (bs != null) {
			if (!Number.isInteger(bs)) throw new Error(`--batch-size 需要整数，拿到「${String(o.batchSize)}」`);
			p.batch_size = bs;
		}
		return p;
	},
	mapOutputs(out, ctx) {
		const url = pickUrl(out, ["download_url"]);
		if (!url) return [];
		const fallback = typeof ctx.opts.outputFormat === "string" ? `.${ctx.opts.outputFormat}` : ".wav";
		const speaker = typeof ctx.opts.speaker === "string" && ctx.opts.speaker.trim() ? ctx.opts.speaker : "voice";
		return [{ url, filename: `tts-${speaker}${extFromUrl(url, fallback)}` }];
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
	// 无 Key 可跑；仅 --bgm 卡点调一次云端节拍分析，价格运行时查公开价格表。
	priceKey: "audio_music_analyze",
	pricingContext: "仅 --bgm 卡点时",
	outputHint: "AE 母合成工程 .jsx",
	enabled: true,
	options: [
		{ flag: "--bgm <音频文件>", desc: "可选 BGM，卡点到 downbeat（需 API Key，计费一次；无 Key 则 BGM 仍入轨、固定节奏）" },
		{ flag: "--duration <秒>", desc: "成片目标时长（默认 20，文案口径 15~30）" },
		{ flag: "--seed <n>", desc: "随机种子（可复现；各工具语义见各自说明）" },
		{ flag: "--refresh", desc: "强制忽略本地缓存、重拉当前 manifest 版本数据" },
	],
};

// ---------------------------------------------------------------- 注册表 + 校验

/** 保留字：族内子模式，不得被 descriptor 取名。 */
export const RESERVED_NAMES = new Set(["list"]);

/** 工具族注册表（编译期数组）。接新工具在此追加一个 descriptor。 */
export const TOOL_REGISTRY: ToolDescriptor[] = [
	imageMove,
	imageMatting,
	imageBlackborderRemove,
	imageCanvasAdapt,
	imagePurify,
	videoMatting,
	videoBlackborderRemove,
	videoCanvasAdapt,
	videoStabilizer,
	videoVaporwave,
	videoPurify,
	videoUpscale,
	videoInterpolate,
	audioSeparation,
	audioNoiseReduce,
	audioSilenceRemove,
	videoSegment,
	videoAiSegment,
	videoMotionCut,
	videoSpeakerDetect,
	videoFaceTrack,
	audioSpeakerSplit,
	audioStretch,
	pianoAudioToMidi,
	pianoAudioEnhance,
	imageToSquare,
	imageToLive,
	videoAiSubtitle,
	imageClassicTemplate,
	imageVerticalStitch,
	videoSplitScreen,
	videoLong2ShortPro,
	audioTtsClone,
	mad,
];

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
		if (d.kind === "cloud" && !d.priceKey) throw new Error(`cloud 型工具缺 priceKey：「${d.name}」`);
		// cloud 型须至少能落一种产物：文件下载（mapOutputs）或结构化结果（mapResult），二选一即可。
		if (d.kind === "cloud" && !d.mapOutputs && !d.mapResult) {
			throw new Error(`cloud 型工具须至少声明 mapOutputs 或 mapResult 之一：「${d.name}」`);
		}
		// 多文件类别（images/videos）与 payload 钩子互斥（add-tool-multifile-images / add-tool-video-split-screen）：
		// 多文件 ⇔ buildPayloadMulti 且无 buildPayload；不支持 preprocess 与 maxDurationSec（防静默失效）；其余类别禁声明 multi。
		if (MULTI_INPUT_KINDS.has(d.input.kind)) {
			if (!d.buildPayloadMulti) throw new Error(`多文件工具缺 buildPayloadMulti：「${d.name}」`);
			if (d.buildPayload) throw new Error(`多文件工具不得声明 buildPayload（与 buildPayloadMulti 互斥）：「${d.name}」`);
			if (d.preprocess) throw new Error(`多文件工具不支持 preprocess：「${d.name}」`);
			if (d.input.maxDurationSec != null) throw new Error(`多文件工具不支持 maxDurationSec：「${d.name}」`);
		} else if (d.buildPayloadMulti) {
			throw new Error(`非多文件工具不得声明 buildPayloadMulti：「${d.name}」`);
		}
		// none 零上传双路径恰一（add-tool-audio-tts-clone）：preprocess（产上传物）或 buildPayloadNone（零上传）二选一
		if (d.buildPayloadNone) {
			if (d.input.kind !== "none") throw new Error(`非 none 工具不得声明 buildPayloadNone：「${d.name}」`);
			if (d.buildPayload || d.buildPayloadMulti) {
				throw new Error(`buildPayloadNone 与其他 payload 钩子互斥：「${d.name}」`);
			}
		}
		if (d.kind === "cloud" && d.input.kind === "none") {
			const paths = (d.preprocess ? 1 : 0) + (d.buildPayloadNone ? 1 : 0);
			if (paths !== 1) {
				throw new Error(`none 工具须声明 preprocess 或 buildPayloadNone 恰一：「${d.name}」`);
			}
		}
	}
}
