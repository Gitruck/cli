import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { loadConfig, type CloudConfig } from "./config";
import { probeGeometry } from "./media";
import { uploadCached } from "./upload-cache";
import { submitTask, cloudErrorCode } from "./cloud";
import { downloadStream, pollToolTask } from "./tool-runner";
import { log } from "./log";
import { appendRegionSpecs, parseRoiSpec, summarizeRegions, validateDocument, validateRegions, type PurifyDocument } from "./purify-contract";

const TASK = "video_purify";
export interface PurifyOpts {
	out?: string; detectScope?: string; detectRoi?: string; watermarkRegion?: string[]; protectRegion?: string[];
	regionsJson?: string; purifyFuncType?: string; reupload?: boolean; json?: boolean; detect?: boolean; noDetect?: boolean;
}
export interface PurifyDeps {
	cfg: CloudConfig; probe: typeof probeGeometry; upload: typeof uploadCached; submit: typeof submitTask;
	poll: typeof pollToolTask; download: typeof downloadStream;
	checkProtocol: (cfg: CloudConfig) => Promise<void>;
}
interface Phase { status: "submitting" | "submitted" | "completed" | "rejected"; taskId?: string; output?: Record<string, unknown>; }
interface Journal {
	version: 1; identity: string; mode: "detect" | "apply" | "run"; base: string;
	document: PurifyDocument; options: PurifyOpts; detect?: Phase; purify?: Phase;
	finalDocument?: PurifyDocument; result?: PurifyResult;
}
export interface PurifyResult {
	ok: true; status: "awaiting_review" | "completed" | "unchanged"; journal: string;
	fileId?: string; detectTaskId?: string; purifyTaskId?: string; output?: string;
	detectedRegionsJson?: string; finalRegionsJson?: string; summary: ReturnType<typeof summarizeRegions>;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function hashVideo(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const tmp = path + "." + randomUUID() + ".tmp";
	try { await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8"); await rename(tmp, path); }
	finally { await rm(tmp, { force: true }); }
}
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

async function locked<T>(dir: string, action: () => Promise<T>): Promise<T> {
	const path = join(dir, ".purify.lock");
	if (existsSync(path)) {
		const old = await readJson(path) as { pid: number; host: string };
		let dead = false;
		if (old.host === hostname() && Number.isInteger(old.pid) && old.pid > 0) {
			try { process.kill(old.pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === "ESRCH"; }
		}
		if (!dead) throw new Error("产物目录已有运行中的 purify 任务：" + dir);
		await rm(path);
	}
	const handle = await open(path, "wx");
	try {
		await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
		return await action();
	} finally { await handle.close(); await rm(path, { force: true }); }
}
function dependencies(overrides: Partial<PurifyDeps>): PurifyDeps {
	return { cfg: overrides.cfg ?? loadConfig(), probe: overrides.probe ?? probeGeometry, upload: overrides.upload ?? uploadCached,
		submit: overrides.submit ?? submitTask, poll: overrides.poll ?? pollToolTask, download: overrides.download ?? downloadStream,
		checkProtocol: overrides.checkProtocol ?? checkPurifyProtocol };
}
export async function checkPurifyProtocol(cfg: CloudConfig): Promise<void> {
	const response = await fetch(cfg.base + "/task/video_purify/capabilities", { headers: { Authorization: cfg.apiKey }, signal: AbortSignal.timeout(15000) });
	const body = await response.json().catch(() => null) as { code?: number; data?: { review_protocol?: number } } | null;
	if (!response.ok || body?.code !== 200 || (body.data?.review_protocol ?? 0) < 2) throw new Error("服务尚未支持净化确认协议 v2，已停止处理，避免保护区域或精确范围被旧服务忽略。请升级后端后重试。");
}
function validateOptions(mode: string, opts: PurifyOpts, doc: PurifyDocument): PurifyOpts {
	const method = opts.purifyFuncType ?? "ffmpeg";
	if (!["ffmpeg", "raft"].includes(method)) throw new Error("处理方式只能是 ffmpeg（模糊）或 raft（内容修复）");
	if (mode !== "apply") {
		if (!opts.detectScope || !["full_screen", "subtitle", "custom"].includes(opts.detectScope)) throw new Error("请明确 --detect-scope full_screen|subtitle|custom；全屏检测不等于所有文字都该删除");
		if (opts.detectScope === "custom" && !opts.detectRoi) throw new Error("custom 需要 --detect-roi x,y,w,h");
		if (opts.detectRoi && opts.detectScope !== "custom") throw new Error("--detect-roi 只能用于 custom");
		if (opts.detectRoi) parseRoiSpec(opts.detectRoi);
	}
	doc.regions = validateRegions(appendRegionSpecs(doc.regions, opts.watermarkRegion ?? [], doc.video.duration), doc.video.duration);
	doc.protect_regions = validateRegions(appendRegionSpecs(doc.protect_regions ?? [], opts.protectRegion ?? [], doc.video.duration, "protect"), doc.video.duration);
	return { ...opts, purifyFuncType: method };
}

async function execute(journalPath: string, state: Journal, d: PurifyDeps): Promise<PurifyResult> {
	const dir = dirname(journalPath);
	const stem = basename(journalPath, ".json");
	const detectedPath = join(dir, stem + "-detected.json");
	const finalPath = join(dir, stem + "-final.json");
	const save = () => writeJsonAtomic(journalPath, state);
	if (state.base !== d.cfg.base) throw new Error("API 地址与原任务不同，不能恢复或混用源文件");
	if (await hashVideo(state.document.source.input_path) !== state.document.source.sha256) throw new Error("源视频已经变化，请重新检测");
	if (state.result && (!state.result.output || existsSync(state.result.output)) && (!state.result.finalRegionsJson || existsSync(state.result.finalRegionsJson))) return state.result;
	state.result = undefined;
	async function phase(name: "detect" | "purify", payload: Record<string, unknown>) {
		let p = state[name];
		if (p?.status === "submitting") throw new Error("上次提交结果未知，已阻止重复收费请求。请先核对云端任务；运行记录：" + journalPath);
		if (!p || p.status === "rejected") {
			p = state[name] = { status: "submitting" }; await save();
			try { p.taskId = await d.submit(d.cfg, TASK, payload); }
			catch (error) {
				// 只有明确业务拒单才允许下次重试；网络/系统错误保留不确定状态。
				const code = cloudErrorCode(error);
				if (code != null && code >= 6000 && code < 7000) { p.status = "rejected"; await save(); }
				throw error;
			}
			p.status = "submitted"; await save();
		}
		if (p.status !== "completed") {
			p.output = await d.poll(d.cfg, TASK, p.taskId!, { timeoutMs: 4 * 60 * 60 * 1000,
				onTick: (status, progress) => log.info(name + "：" + status + (progress == null ? "" : " " + progress + "%")) }) as Record<string, unknown>;
			p.status = "completed"; await save();
		}
		return p.output!;
	}
	async function download(url: unknown, target: string) {
		if (typeof url !== "string" || !url) throw new Error("任务缺少产物 URL");
		const partial = target + ".part";
		await d.download(new URL(url, d.cfg.base + "/").href, partial);
		await rename(partial, target);
	}
	let doc = state.finalDocument ?? state.document;
	if (state.mode === "apply" && !doc.regions.length) {
		const result: PurifyResult = { ok: true, status: "unchanged", journal: journalPath, output: doc.source.input_path, summary: summarizeRegions(doc) };
		state.result = result; await save(); return result;
	}
	// 在任何新上传/计费请求之前验证服务能力；已建单的恢复只轮询下载。
	if (state.mode !== "detect" && !state.purify?.taskId) await d.checkProtocol(d.cfg);
	if (!state.document.source.file_id) {
		const uploaded = await d.upload(d.cfg, state.document.source.input_path, { force: state.options.reupload });
		state.document.source.file_id = uploaded.fileId; state.document.source.api_base = d.cfg.base; await save();
	}
	if (state.mode !== "apply" && !state.finalDocument) {
		const output = await phase("detect", { file_id: state.document.source.file_id, phase: "detect", detect_scope: state.options.detectScope,
			...(state.options.detectRoi ? { detect_roi: parseRoiSpec(state.options.detectRoi) } : {}) });
		await download(output.regions_download_url, detectedPath);
		const detected = await readJson(detectedPath);
		if (detected.version !== 1 || !detected.video || !Array.isArray(detected.regions)) throw new Error("检测文件结构无效");
		if (detected.source?.file_id && String(detected.source.file_id) !== state.document.source.file_id) throw new Error("检测产物源 ID 不匹配");
		doc = validateDocument({ ...detected, source: state.document.source,
			regions: [...detected.regions, ...state.document.regions], protect_regions: state.document.protect_regions });
		await writeJsonAtomic(detectedPath, doc);
		state.finalDocument = doc; await save();
	}
	doc = state.finalDocument ?? state.document;
	if (state.detect && !existsSync(detectedPath)) await writeJsonAtomic(detectedPath, doc);
	await writeJsonAtomic(finalPath, doc);
	const result: PurifyResult = { ok: true, status: "awaiting_review", journal: journalPath, fileId: doc.source.file_id,
		detectTaskId: state.detect?.taskId, ...(state.detect ? { detectedRegionsJson: detectedPath } : {}), finalRegionsJson: finalPath, summary: summarizeRegions(doc) };
	if (state.mode !== "detect") {
		if (!doc.regions.length) { result.status = "unchanged"; result.output = doc.source.input_path; }
		else {
			if (await hashVideo(doc.source.input_path) !== doc.source.sha256) throw new Error("检测期间源视频发生变化，拒绝处理");
			const out = await phase("purify", { file_id: doc.source.file_id, source_file_id: doc.source.file_id, phase: "purify",
				purify_func_type: state.options.purifyFuncType, regions: doc.regions, protect_regions: doc.protect_regions ?? [] });
			result.purifyTaskId = state.purify?.taskId;
			result.output = join(dir, stem + "-purified.mp4");
			await download(out.download_url, result.output); result.status = "completed";
		}
	}
	state.result = result; await save();
	await writeJsonAtomic(join(dir, stem + "-result.json"), result);
	return result;
}

export async function startPurify(mode: "detect" | "apply" | "run" | "manual", input: string, opts: PurifyOpts = {}, overrides: Partial<PurifyDeps> = {}): Promise<PurifyResult> {
	const fromDocument = mode === "apply";
	let doc: PurifyDocument;
	if (mode === "apply") doc = validateDocument(await readJson(resolve(input)));
	else {
		const path = resolve(input);
		if (!(await stat(path)).isFile()) throw new Error("输入不是本地视频文件");
		const video = (overrides.probe ?? probeGeometry)(path);
		doc = validateDocument({ version: 1, source: { input_path: path, sha256: await hashVideo(path) }, video, regions: [] });
	}
    if (mode === "manual") mode = "apply";
    const options = validateOptions(mode, opts, doc);
	if (mode !== "apply" && opts.regionsJson) throw new Error("编辑后的清单请用 purify apply，不能追加到重新检测的结果");
	const d = dependencies(mode === "apply" && doc.regions.length === 0 ? { ...overrides, cfg: overrides.cfg ?? { base: doc.source.api_base ?? "", apiKey: "" } } : overrides);
	if (doc.source.api_base && doc.source.api_base !== d.cfg.base) throw new Error("区域文件来自不同的 API 服务");
	const dir = opts.out ? resolve(opts.out) : fromDocument ? dirname(resolve(input)) : join(dirname(doc.source.input_path), basename(doc.source.input_path, extname(doc.source.input_path)) + "-purify");
	await mkdir(dir, { recursive: true });
	const identity = digest({ mode, doc, method: options.purifyFuncType, scope: options.detectScope, roi: options.detectRoi, base: d.cfg.base });
	const path = join(dir, mode + "-" + identity.slice(0, 16) + ".json");
	return locked(dir, async () => {
		const state: Journal = existsSync(path) ? await readJson(path) : { version: 1, identity, mode, base: d.cfg.base, document: doc, options };
		if (state.identity !== identity) throw new Error("运行记录与请求不匹配");
		await writeJsonAtomic(path, state);
		return execute(path, state, d);
	});
}

export async function resumePurify(path: string, overrides: Partial<PurifyDeps> = {}): Promise<PurifyResult> {
	path = resolve(path);
	return locked(dirname(path), async () => {
		const state = await readJson(path) as Journal;
		if (state.version !== 1 || !["detect", "apply", "run"].includes(state.mode) || !state.identity) throw new Error("不是 purify 运行记录");
		validateDocument(state.document);
		const empty = state.mode === "apply" && !(state.finalDocument ?? state.document).regions.length;
		const d = dependencies(empty ? { ...overrides, cfg: overrides.cfg ?? { base: state.base, apiKey: "" } } : overrides);
		return execute(path, state, d);
	});
}
