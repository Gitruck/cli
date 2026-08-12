/**
 * 图转运镜联动共享层（add-matrix-local-image-broll D2/D3/D4）。
 *
 * 把「本地图片候选 → 云端 /task/image_move 运镜视频 → 工程 assets/broll-move/ 落地」焊成一条
 * 可复用链：参数推导（统一 5s 档 + 工程画布几何覆盖）、产物身份与缓存指纹
 * （材料 id=`broll-local-<图hash16>-mv<参数指纹8>`，同图同参零重复计费）、云端执行
 * （复用 tool image_move 抽取的 runCloudFileTask 执行核，MUST NOT 复制「上传→提交→轮询」实现）。
 *
 * 计费口径：image_move 按任务计费（2 积分/张），走其自身任务链路——与 embed 计量会话无关，
 * internal 豁免与否按 image_move 自身口径。出域口径：图片本体**会上云**做运镜（与视频素材
 * 「本体不上云」不同），命令层与 SKILL.md 明示。
 */
import { mkdirSync } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname } from "node:path";
import { blake3 } from "hash-wasm";
import { runCloudFileTask, downloadStream, type CloudFileTaskDeps } from "./tool-runner";
import { pickUrl, type OutputResult } from "./tool-descriptors";
import { BROLL_LOCAL_MATERIAL_PREFIX } from "./matrix-lay";

export const IMAGE_MOVE_TASK_TYPE = "image_move";
/** image_move 既有计费口径：2 积分/张（proposal Impact；预估确认护栏 D5 用）。 */
export const IMAGE_MOVE_CREDITS_PER_IMAGE = 2;
/** 统一档 duration（★ 主理人 2026-08-12 由 4s 上调 5s）：覆盖 2-4s 缺省槽长且余量更大，缓存最大化命中。 */
export const IMAGE_MOVE_DURATION_DEFAULT_SEC = 5;
/** /task/image_move 的 duration 服务端钳位 [2,12]。 */
export const IMAGE_MOVE_DURATION_MIN_SEC = 2;
export const IMAGE_MOVE_DURATION_MAX_SEC = 12;
/** 运镜产物工程内目录（D3：产物落工程、跨工程不共享缓存——工程自包含原则）。 */
export const BROLL_MOVE_DIR = "assets/broll-move";
/** 铺轨侧运镜生成并发上限（云端 GPU 任务，礼貌并发，D4）。 */
export const IMAGE_MOVE_CONCURRENCY = 2;

export interface ImageMoveParams {
	width: number;
	height: number;
	duration: number;
}

/** D2 统一档：槽长 ≤5s 恒 5s（入轨按槽长裁剪）；>5s 取 ceil(槽长)；全域钳 [2,12]。 */
export function imageMoveDurationForSlot(slotSec: number): number {
	const d = slotSec > IMAGE_MOVE_DURATION_DEFAULT_SEC ? Math.ceil(slotSec) : IMAGE_MOVE_DURATION_DEFAULT_SEC;
	return Math.min(IMAGE_MOVE_DURATION_MAX_SEC, Math.max(IMAGE_MOVE_DURATION_MIN_SEC, d));
}

/** 参数指纹 = blake3("duration|width|height") 前 8 hex（D3；进材料 id，同图不同参不串产物）。 */
export async function imageMoveParamFingerprint(p: ImageMoveParams): Promise<string> {
	return (await blake3(`${p.duration}|${p.width}|${p.height}`)).slice(0, 8);
}

/** 本地图片 hash16：plan 侧 clip_id=`local-<blake3-16>` 去前缀（防御：无前缀原样返回）。 */
export function imageHash16FromClipId(clipId: string): string {
	return clipId.startsWith("local-") ? clipId.slice("local-".length) : clipId;
}

/** 运镜产物材料 id：`broll-local-<图hash16>-mv<参数指纹8>`——仍属 broll-local- 自产前缀家族，
 * 剥旧 L1 / confirmBroll 排除 / 云渲提交防线全部天然覆盖（MUST NOT 为它新增判定分支）。 */
export function imageMoveMaterialId(imageHash16: string, fp8: string): string {
	return `${BROLL_LOCAL_MATERIAL_PREFIX}${imageHash16}-mv${fp8}`;
}

/** 静态兜底材料 id（D6：运镜失败图片静态上轨）：`broll-local-<图hash16>`，无 mv 后缀——
 * 重铺时缓存无产物自然重试运镜，静态兜底被剥旧机制正常处置。 */
export function imageStaticMaterialId(imageHash16: string): string {
	return `${BROLL_LOCAL_MATERIAL_PREFIX}${imageHash16}`;
}

/** 运镜产物工程内相对路径。 */
export function imageMoveRelPath(materialId: string): string {
	return `${BROLL_MOVE_DIR}/${materialId}.mp4`;
}

/**
 * 生成一张图片的运镜视频并落地 destAbs（真云端链：上传→提交 /task/image_move→轮询→流式下载）。
 * 执行核与 `gtrk tool image_move` 共享（runCloudFileTask 抽取，D4）；落地走临时文件 + rename
 * 原子化——半包不会被「同名即复用」的缓存查询静默命中。
 */
export async function generateImageMoveAsset(opts: {
	deps: CloudFileTaskDeps;
	imageAbs: string;
	destAbs: string;
	params: ImageMoveParams;
	/** 测试注入下载器（缺省=流式下载）。 */
	download?: (url: string, dest: string) => Promise<void>;
	onTick?: (status: string, progress?: number) => void;
}): Promise<{ taskId: string }> {
	const { params } = opts;
	const run = await runCloudFileTask({
		deps: opts.deps,
		uploadPath: opts.imageAbs,
		taskType: IMAGE_MOVE_TASK_TYPE,
		// 画布几何显式下发（覆盖工具默认的原图朝向推导——B-roll 必须匹配工程画布，D2）
		buildPayload: (fid) => ({ file_id: fid, width: params.width, height: params.height, duration: params.duration }),
		onTick: opts.onTick,
	});
	const url = pickUrl(run.output as unknown as OutputResult, ["download_url", "video_download_url", "url"]);
	if (!url) throw new Error("image_move 任务完成但未返回产物下载链接（output_result 形态异常）");
	mkdirSync(dirname(opts.destAbs), { recursive: true });
	const tmp = `${opts.destAbs}.tmp-${process.pid}`;
	await (opts.download ?? downloadStream)(url, tmp);
	await rename(tmp, opts.destAbs);
	return { taskId: run.taskId };
}
