/**
 * gtrk music-visualizer —— 音乐可视化独立命令（公共域 music_visualizer，id 39）。
 *   主音频（缓存上传）+ 可选背景（图/视频）/封面（仅图）各自独立上传拿 file_id → 拼一次 payload
 *   → 云端出单个频谱可视化成片 mp4 → 拉回本地。样式参数（模板/分辨率/帧率/双色/模糊/叠字）提交前校验。
 *
 * 不进工具族：主音频 + 两个语义各异的可选辅助文件 + 结构化样式集 + 三路上传编排，超出单文件 descriptor 契约。
 * 复用共享上传缓存/6004 恢复（主音频走 uploadAndSubmitTask）/轮询/流式下载，cloud.ts 等基建零改动。
 */
import { Command } from "commander";
import { resolve, join, dirname, basename, extname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadConfig } from "../lib/config";
import { pollTask, submitTask, type OralCutOutput } from "../lib/cloud";
import { uploadCached } from "../lib/upload-cache";
import { uploadAndSubmitTask } from "../lib/upload-submit";
import { defaultExtsFor } from "../lib/tool-descriptors";
import { downloadStream } from "../lib/tool-runner";
import { resolveToolPricing } from "../lib/tool-pricing";
import { extFromUrl } from "../lib/tool-descriptors";
import { log, routeLogsToStderr } from "../lib/log";

const TASK_TYPE = "music_visualizer";
const PRICE_KEY = "music_visualizer";
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const AUDIO_EXTS = defaultExtsFor("audio") ?? [];
const IMAGE_EXTS = defaultExtsFor("image") ?? [];
const VIDEO_EXTS = defaultExtsFor("video") ?? [];

interface MusicVisualizerOpts {
	template?: string;
	background?: string;
	cover?: string;
	track?: string;
	artist?: string;
	resolution?: string;
	fps?: string;
	c1?: string;
	c2?: string;
	blur?: string;
	out?: string;
	param: string[];
	paramsJson?: string;
	reupload?: boolean;
	json?: boolean;
}

const collectParam = (v: string, acc: string[]): string[] => {
	acc.push(v);
	return acc;
};

function coerceValue(v: string): unknown {
	if (v === "true") return true;
	if (v === "false") return false;
	if (v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
	return v;
}

function parseExtraParams(pairs: string[], jsonStr?: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const pair of pairs) {
		const i = pair.indexOf("=");
		if (i < 0) throw new Error(`--param 需要 key=value 格式：「${pair}」`);
		out[pair.slice(0, i).trim()] = coerceValue(pair.slice(i + 1));
	}
	if (jsonStr) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonStr);
		} catch {
			throw new Error(`--params-json 不是合法 JSON：${jsonStr}`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("--params-json 必须是一个 JSON 对象");
		}
		Object.assign(out, parsed as Record<string, unknown>);
	}
	return out;
}

/** 时间戳 YYMMDD-HHMMSS。 */
function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 校验输入文件存在且扩展名在白名单内（提交前，供应商中性报错）。 */
function assertExt(pathAbs: string, exts: string[], label: string): void {
	if (!existsSync(pathAbs)) throw new Error(`${label}不存在：${pathAbs}`);
	const e = extname(pathAbs).toLowerCase();
	if (exts.length && !exts.includes(e)) {
		throw new Error(`${label}扩展名不支持：${e}（支持 ${exts.join(" ")}）`);
	}
}

/** 解析并校验全部样式参数，返回要拼进 payload 的字段（缺省省略）。非法一律抛错（提交前）。 */
export function buildStyleFields(opts: MusicVisualizerOpts): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	if (opts.track != null) fields.track = String(opts.track);
	if (opts.artist != null) fields.artist = String(opts.artist);
	if (opts.resolution != null) {
		const m = /^(\d+)[xX](\d+)$/.exec(opts.resolution.trim());
		if (!m) throw new Error(`--resolution 必须是 <宽>x<高> 格式（如 1920x1080）：${opts.resolution}`);
		const width = Number(m[1]);
		const height = Number(m[2]);
		if (!(width > 0) || !(height > 0)) throw new Error("--resolution 的宽高必须为正整数");
		fields.resolution = { width, height };
	}
	if (opts.fps != null) {
		const fps = Number(opts.fps);
		if (!Number.isInteger(fps) || fps < 30 || fps > 60) throw new Error("--fps 必须是 30 到 60 的整数");
		fields.fps = fps;
	}
	if (opts.c1 != null) {
		if (!HEX_RE.test(opts.c1)) throw new Error("--c1 必须是十六进制颜色（如 #ff0066 或 #f06）");
		fields.c1 = opts.c1;
	}
	if (opts.c2 != null) {
		if (!HEX_RE.test(opts.c2)) throw new Error("--c2 必须是十六进制颜色（如 #6600ff 或 #60f）");
		fields.c2 = opts.c2;
	}
	if (opts.blur != null) {
		const blur = Number(opts.blur);
		if (!Number.isInteger(blur) || blur < 0 || blur > 40) throw new Error("--blur 必须是 0 到 40 的整数");
		fields.blur = blur;
	}
	return fields;
}

export function registerMusicVisualizer(program: Command): void {
	program
		.command("music-visualizer <audio>")
		.description("音乐可视化：一首歌 → 频谱可视化成片（可选背景/封面 + 模板/配色样式）")
		.option("-t, --template <id>", "可视化模板 id（必填；取值见云端 API 文档 / 服务端模板列表）")
		.option("--background <图或视频>", "可选背景素材（图片或视频，独立上传）")
		.option("--cover <图>", "可选封面图（仅图片，独立上传）")
		.option("--track <名>", "曲名（叠加文字）")
		.option("--artist <名>", "歌手名（叠加文字）")
		.option("--resolution <WxH>", "输出分辨率（如 1080x1920；默认服务端 1920x1080）")
		.option("--fps <n>", "帧率 30-60（默认服务端 30）")
		.option("--c1 <hex>", "频谱主色十六进制（如 #ffffff；默认服务端白）")
		.option("--c2 <hex>", "频谱第二色十六进制（给定则双色渐变）")
		.option("--blur <n>", "背景模糊 0-40（默认服务端 16）")
		.option("-o, --out <dir>", "产物目录（缺省 = <音频同目录>/<音频名>-visualizer-<时间戳>）")
		.option("--param <k=v>", "透传任意云端参数（标量、可重复）", collectParam, [])
		.option("--params-json <json>", "透传任意云端参数（JSON 对象）")
		.option("--reupload", "强制重新上传，忽略本地上传缓存")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (audio: string, opts: MusicVisualizerOpts) => {
			await runMusicVisualizer(audio, opts);
		});
}

async function runMusicVisualizer(audio: string, opts: MusicVisualizerOpts): Promise<void> {
	if (opts.json) routeLogsToStderr();
	const cfg = loadConfig();

	// —— 提交前校验（快失败，避免浪费上传）——
	const audioAbs = resolve(audio);
	assertExt(audioAbs, AUDIO_EXTS, "音频");
	const template = opts.template == null ? "" : String(opts.template).trim();
	if (!template) throw new Error("--template 必填：请指定可视化模板 id（取值见云端 API 文档 / 服务端模板列表）");
	const styleFields = buildStyleFields(opts); // 非法样式参数在此抛出
	const bgAbs = opts.background ? resolve(opts.background) : undefined;
	if (bgAbs) assertExt(bgAbs, [...IMAGE_EXTS, ...VIDEO_EXTS], "背景素材");
	const coverAbs = opts.cover ? resolve(opts.cover) : undefined;
	if (coverAbs) assertExt(coverAbs, IMAGE_EXTS, "封面图");
	const extraParams = parseExtraParams(opts.param, opts.paramsJson);

	const projName = basename(audioAbs, extname(audioAbs));
	const outDir = resolve(opts.out ?? join(dirname(audioAbs), `${projName}-visualizer-${timestamp()}`));

	log.step(`▶ 音乐可视化：${basename(audioAbs)}（模板 ${template}${bgAbs ? " · 背景" : ""}${coverAbs ? " · 封面" : ""}）`);

	// 计费提示（实时查价；失败降级不阻断）
	let billingHint: string;
	try {
		billingHint = (await resolveToolPricing(PRICE_KEY)).billingHint;
	} catch {
		billingHint = "实时价格暂不可用，以服务端结算为准";
	}
	process.stderr.write(`\x1b[33m⚠️  计费提示：${billingHint}\x1b[0m\n`);

	// ① 可选辅助文件先各自独立上传拿 file_id（新鲜上传，6004 风险低）
	let backgroundFileId: string | undefined;
	if (bgAbs) {
		log.step("① 上传背景素材…");
		backgroundFileId = (await uploadCached(cfg, bgAbs, { force: opts.reupload })).fileId;
		log.info(`背景 file_id = ${backgroundFileId}`);
	}
	let coverFileId: string | undefined;
	if (coverAbs) {
		log.step("① 上传封面图…");
		coverFileId = (await uploadCached(cfg, coverAbs, { force: opts.reupload })).fileId;
		log.info(`封面 file_id = ${coverFileId}`);
	}

	// ② 主音频走共享上传+提交（6004 失效重传由 uploadAndSubmitTask 收编）
	const buildPayload = (fid: string): Record<string, unknown> => {
		const p: Record<string, unknown> = { file_id: fid, template_id: template };
		if (backgroundFileId) p.background_file_id = backgroundFileId;
		if (coverFileId) p.cover_file_id = coverFileId;
		Object.assign(p, styleFields);
		// 通用透传优先级最高（对象字段逐字段合并）
		for (const [k, v] of Object.entries(extraParams)) {
			const cur = p[k];
			const bothObj =
				!!cur && !!v && typeof cur === "object" && typeof v === "object" && !Array.isArray(cur) && !Array.isArray(v);
			p[k] = bothObj ? { ...(cur as Record<string, unknown>), ...(v as Record<string, unknown>) } : v;
		}
		return p;
	};

	const submitted = await uploadAndSubmitTask(cfg, audioAbs, TASK_TYPE, buildPayload, {
		force: opts.reupload,
		onUploaded: (u) => {
			log.info(u.cached ? `命中上传缓存，复用主音频 file_id = ${u.fileId}` : `主音频 file_id = ${u.fileId}`);
			log.step("② 提交音乐可视化任务…");
		},
		onCacheInvalid: () => log.warn("缓存的 file_id 在云端已失效，重新上传后重试…"),
	});
	const { taskId } = submitted;
	log.info(`task_id = ${taskId}`);
	await mkdir(outDir, { recursive: true });
	await writeFile(
		join(outDir, "task.json"),
		JSON.stringify(
			{ taskId, taskType: TASK_TYPE, fileId: submitted.fileId, source: audioAbs, template, createdAt: new Date().toISOString() },
			null,
			2,
		),
	);

	// ③ 轮询
	log.step("③ 云端处理中（每 5s 轮询）…");
	const result = await pollTask(cfg, TASK_TYPE, taskId, (status, progress) => {
		log.tick(`${status}${progress != null ? ` ${Math.round(progress)}%` : ""}`);
	});
	log.tickEnd();

	// ④ 下载单成片 + result.json（恒落盘，不受 --json 约束）
	const out = result as unknown as Record<string, unknown>;
	const url = [out.download_url, out.video_download_url, out.url].find((u): u is string => typeof u === "string" && !!u.trim());
	const files: string[] = [];
	const errors: Record<string, string> = {};
	if (url) {
		const dest = join(outDir, `${projName}-visualizer${extFromUrl(url, ".mp4")}`);
		try {
			await downloadStream(url, dest);
			files.push(dest);
		} catch (e) {
			errors["output"] = e instanceof Error ? e.message : String(e);
		}
	} else {
		errors["output"] = "任务完成但未解析到成片下载链接（output_result 形态异常）";
	}
	const ok = files.length > 0 && Object.keys(errors).length === 0;
	const resultJson = {
		ok,
		command: "music-visualizer",
		taskType: TASK_TYPE,
		taskId,
		fileId: submitted.fileId,
		outDir,
		files,
		...(Object.keys(errors).length ? { errors } : {}),
		finishedAt: new Date().toISOString(),
	};
	await writeFile(join(outDir, "result.json"), JSON.stringify(resultJson, null, 2));

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(resultJson)}\n`);
	}
	if (!ok) {
		log.err(`产物下载失败：${JSON.stringify(errors)}。可凭 task.json 的 taskId 稍后恢复。`);
		process.exitCode = 1;
		return;
	}
	log.ok(`完成。产物目录：${outDir}`);
}

// OralCutOutput 仅用于对齐 pollTask 泛型返回，不额外约束本命令的 output_result 形状。
export type { OralCutOutput };
