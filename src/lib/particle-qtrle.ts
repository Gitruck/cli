/**
 * MG 颗粒 → qtrle 透明 MOV 的预渲与**跨端内容寻址缓存**（change add-render-overlay-compositing）。
 *
 * 为什么存在：CLI 没有 HTML 渲染引擎，颗粒像素权威在服务端 Hyperframes 渲染机。本地渲染要叠颗粒，
 * 唯一路 = 走 `html_render_simple`（`render.output_format="qtrle"`）把每颗颗粒烤成带 alpha 的 MOV，
 * 再交给 ffmpeg 叠。本模块只管「把 MOV 备齐」，**不碰滤镜图**（那在 render.ts）。
 *
 * 🔴 **键与落点 MUST 与客户端逐字节同构** —— 这是钱的问题，不是性能问题。
 * 客户端（`gitruck-opencut-rewrite/apps/web/src/tonghe/`）导出剪映时走的是同一条链：
 *   · 键：`particle-cache.ts:81 serializeParticleRenderIdentity` + `:106 particleCacheKey`
 *   · 落点：`cloud-export.ts:73 CACHE_DIR` + `:126 cacheFilePath`
 * 两端同构 ⇒ 客户端烤过的颗粒 CLI 直接命中、反之亦然，同一颗粒永不烤第二遍。
 * 键的任一字段（含 `width`/`height`）一变即分叉，命中率归零 —— 分叉不会出错，只是白花钱，
 * 因而**不会被任何测试自然发现**，只能靠这里的注释与 `particle-qtrle.test.mjs` 的固定向量守。
 *
 * ⚠️ **与 `mg-render.ts` 有意分道**：那条是 `gtrk mg render`（脱离工程的精剪补给口），
 * 提交体 `video_size` 是 **1920×1080**（`mg-render.ts:168`，其射程本就是 1920×1080-only）。
 * 本模块恒 **1280×720**（= 客户端 `PARTICLE_CAPTURE_SIZE`）。两条路共用端点**不共用几何**，
 * MUST NOT 为「复用」把任一侧改成对方的尺寸。
 *
 * 与在飞件 `add-project-export-command` 的分工（design D1，2026-09-09 拍板 A 案）：
 * 本模块提供两件都要的公共部分（常量 / 键 / 落点 / 取 HTML / 提交体 / 编排）；
 * 那件专属的「beat_track 投影成 video_track」**不在本模块**，由它 apply 时自行补，
 * 且 MUST 先 rebase 到本模块、MUST NOT 另起一份键。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { CloudConfig } from "./config";
import { loadConfig } from "./config";
import {
	submitTask as realSubmitTask,
	pollTask as realPollTask,
	download as realDownload,
} from "./cloud";
import { resolveToolPricing, type PriceResolver } from "./tool-pricing";
import { noticeOnce } from "./compliance-notice";
import { log } from "./log";

/** 颗粒渲染器 ABI。出处：客户端 `tonghe/particle-cache.ts:51 PARTICLE_RENDER_ABI`。
 *  v2 对应服务端 fix-particle-subcomposition-scale（声明尺寸 ≠ 720p 根舞台时 wrapper 缩放）。
 *  🔴 客户端提 ABI 而这里没跟 ⇒ 两端各存一份、命中率归零。跨端对表见 tasks §0.8。 */
export const PARTICLE_RENDER_ABI = "v2-subcomposition-scale";

/** 颗粒捕获尺寸。出处：客户端 `tonghe/cloud-render.ts:625 PARTICLE_CAPTURE_SIZE`。
 *  🔴 恒定，**MUST NOT** 取工程画布尺寸 —— 它进内容寻址键，一变即分叉。
 *  几何取舍（继承客户端既定口径）：颗粒是满帧叠加层，画布 >720p 时按 contain-fit 上采样回满帧，
 *  降画质已接受。MG 颗粒 HTML 恒声明 1920×1080（`mg-lint.ts` 的 fatal 门）与 720p 舞台同为 16:9。 */
export const PARTICLE_CAPTURE_SIZE = { width: 1280, height: 720 } as const;

/** 计费任务类型（与 `gtrk mg render` 同一端点，task type id 38，measure=分钟）。 */
export const PARTICLE_TASK_TYPE = "html_render_simple";

/** 缓存目录（相对 `.gtrk` 所在目录）。出处：客户端 `tonghe/cloud-export.ts:73 CACHE_DIR`。 */
export const PARTICLE_CACHE_DIR = ".tonghe-cache/particles";

/** 颗粒渲染并发缺省值。与客户端 `PARTICLE_RENDER_CONCURRENCY` 及 project-export 同值。 */
export const DEFAULT_PARTICLE_CONCURRENCY = 6;
export const MIN_PARTICLE_CONCURRENCY = 1;
export const MAX_PARTICLE_CONCURRENCY = 8;

/** 决定单颗粒透明层像素的全部输入。新增视觉参数时 MUST 入此身份或提升 ABI。 */
export interface ParticleIdentity {
	html: string;
	format: "qtrle";
	quality: "draft";
	fps: number;
	width: number;
	height: number;
	duration: number;
	opaque: boolean;
	/** 测试/迁移显式覆盖；生产缺省恒取 `PARTICLE_RENDER_ABI`。 */
	abi?: string;
}

/**
 * 固定字段顺序的渲染身份串。
 *
 * 🔴 **字段顺序即序列化顺序**（`JSON.stringify` 按字面量书写序出键），MUST 与客户端
 * `serializeParticleRenderIdentity` 逐字一致：`abi,html,format,quality,fps,width,height,durationUs,opaque`。
 * 调换任意两项都会换出另一个 sha256 —— 不报错，只是从此和客户端各烤各的。
 * HTML **不做任何归一化**（客户端亦然：`materializeBeatHtml` 在文件形态下原样返回文件文本）。
 */
export function serializeParticleIdentity({
	html,
	format,
	quality,
	fps,
	width,
	height,
	duration,
	opaque,
	abi = PARTICLE_RENDER_ABI,
}: ParticleIdentity): string {
	return JSON.stringify({
		abi,
		html,
		format,
		quality,
		fps,
		width,
		height,
		durationUs: Math.round(duration * 1_000_000),
		opaque,
	});
}

/** 内容寻址键 = sha256(身份串) 的小写 hex。与客户端 `crypto.subtle.digest("SHA-256", utf8)` 同值。 */
export function particleCacheKey(identity: ParticleIdentity): string {
	return createHash("sha256").update(serializeParticleIdentity(identity), "utf8").digest("hex");
}

/** 缓存落点：`<.gtrk 所在目录>/.tonghe-cache/particles/<key>.mov`（与客户端同构）。 */
export function particleCachePath(gtrkDir: string, key: string): string {
	return resolve(gtrkDir, PARTICLE_CACHE_DIR, `${key}.mov`);
}

/** gtrk v1 的 beat（颗粒）与 materials 的最小读侧形状。 */
export interface BeatLike {
	clip_id?: string;
	/** ⚠️ 颗粒 composition-id，**不是**素材引用键。MUST NOT 拿它去 materials 查表。 */
	material?: unknown;
	html?: unknown;
	html_material?: unknown;
	opaque?: unknown;
	track_st?: unknown;
	track_ed?: unknown;
	duration?: unknown;
}
export interface MaterialLike {
	id?: unknown;
	path?: unknown;
}

export type ParticleHtmlRef =
	| { kind: "inline"; html: string }
	| { kind: "file"; path: string };

/**
 * 取颗粒 HTML 的引用（**纯函数**，不读盘）。三级：内联 `html` → `html_material` 精确查表 → 失败。
 *
 * 🔴 **MUST NOT** 拿 `beat.material` 去 `materials` 查表 —— 契约明文（infra `gtrk-contract` spec）：
 * beat clip 的 `material` = 颗粒 composition-id，与 video/audio clip 的同名字段**语义不同**；
 * 它「不参与查表定位」，碰巧与某条 `materials[].id` 同名也不改变这一点。
 * 🔴 **MUST NOT** 用 `mg-` / `rrv-` / `html-` 前缀匹配反推 —— 客户端会把 `html_material` 改写成
 * `html-<短码>`（真机实证）而 `path` 不动，前缀匹配已付过一次学费。
 * 同口径见在飞件 `add-project-export-command` 的 **D11**，两处互引。
 *
 * 相对 `path` 以 `.gtrk` 所在目录为基准解析（与 material-integrity / materialPathsFromGtrk 同口径）。
 */
export function resolveParticleHtmlRef(
	beat: BeatLike,
	materials: MaterialLike[],
	gtrkDir: string,
): ParticleHtmlRef | undefined {
	if (typeof beat.html === "string" && beat.html.length > 0) {
		return { kind: "inline", html: beat.html };
	}
	const key = beat.html_material;
	if (typeof key !== "string" || key.length === 0) return undefined;
	// 精确查 id（=== 比较，非前缀、非包含）
	const hit = materials.find((m) => typeof m.id === "string" && m.id === key);
	if (!hit || typeof hit.path !== "string" || hit.path.length === 0) return undefined;
	const p = hit.path;
	return { kind: "file", path: isAbsolute(p) ? p : resolve(gtrkDir, p) };
}

/**
 * 单颗粒 composition 提交体（**纯函数**）。形状以 infra `html_animate_render` 校验代码为准：
 * `video_size` 是 `{width,height}` 对象（非 `.gtrk` 的 `[宽,高]`）、beat 时长字段 = `start`+`duration`
 * （非 track_st/track_ed）、`assets.file_id` 必须为 dict（纯内联 beats 也要给空 map）。
 *
 * 🔴 三条硬约束，改任一条即偏离客户端：`video_size` 恒 1280×720、`tracks: []`、`assets.file_id: {}`。
 */
export function buildParticleComposition(opts: {
	html: string;
	duration: number;
	fps: number;
	opaque: boolean;
	trackIndex: number;
	id: string;
}): Record<string, unknown> {
	return {
		composition: {
			// 恒 720p 捕获；MUST NOT 取工程画布（见 PARTICLE_CAPTURE_SIZE 注释）
			video_size: { width: PARTICLE_CAPTURE_SIZE.width, height: PARTICLE_CAPTURE_SIZE.height },
			// 云端 _validate_render 要求 fps 为 int（29.97 这类小数会被拒）
			fps: Math.round(opts.fps),
			duration: opts.duration,
			// beats-only 透明层：不引入视频底轨
			tracks: [],
			// _validate_assets 无条件调用，纯内联也要给空 dict
			assets: { file_id: {} },
			beats: [
				{
					id: opts.id,
					start: 0, // 归零：单颗粒从 0 秒独立渲
					duration: opts.duration,
					track_index: opts.trackIndex,
					opaque: opts.opaque,
					html: opts.html,
				},
			],
		},
		render: { output_format: "qtrle" },
	};
}

/** 一颗待备齐的颗粒（preflight 产物）。 */
export interface ParticlePlanItem {
	clipId: string;
	key: string;
	cachePath: string;
	cached: boolean;
	/** 已读出的 HTML 原文（进键的那一份，MUST 与提交体同一个串）。 */
	html: string;
	duration: number;
	opaque: boolean;
	trackIndex: number;
}

/** 同键分组（同一颗粒在轨上出现 N 次只烤一次）。 */
export interface ParticleGroup {
	key: string;
	leader: ParticlePlanItem;
	/** 该组全部 clipId（含 leader）。 */
	members: string[];
	cached: boolean;
}

export interface ParticleSkip {
	clipId: string;
	reason: string;
}

export interface ParticlePlan {
	items: ParticlePlanItem[];
	skipped: ParticleSkip[];
	groups: ParticleGroup[];
	/** 算键时用的 fps（= `Math.round(video_rate)`）。提交体 MUST 用同一个值——
	 *  键里的 fps 与提交体的 fps 一旦分家，烤出来的东西就不是键所描述的那一件。 */
	fps: number;
	/** 轨上颗粒总数（解析成功的）。 */
	total: number;
	/** 唯一颗粒数（= groups.length）。 */
	unique: number;
	/** 已命中缓存的唯一颗粒数。 */
	cached: number;
	/** 未命中、需要提交云任务的唯一颗粒数。 */
	miss: number;
	/** 计费秒数 = 全部未命中组的 duration 之和（服务端按分钟计量）。 */
	billedSeconds: number;
}

export interface ParticleDeps {
	submitTask?: typeof realSubmitTask;
	pollTask?: typeof realPollTask;
	download?: typeof realDownload;
	/** 读 HTML（测试注入）。 */
	readTextFile?: (p: string) => Promise<string>;
	/** 缓存是否命中（测试注入）。 */
	cacheHit?: (p: string) => boolean;
}

const num = (v: unknown, dflt = 0): number => {
	const n = Number(v);
	return Number.isFinite(n) ? n : dflt;
};

/**
 * 全量本地 preflight：取 HTML → 算键 → 查缓存 → 按键分组。**零网络、零计费**。
 *
 * 单颗粒解析失败（查不到 `html_material` / 文件读不出）SHALL 记进 `skipped` 并继续，
 * MUST NOT 阻断整片渲染 —— 一颗坏颗粒不该毁掉 45 分钟的成片。
 */
export async function buildParticlePlan(
	beats: { beat: BeatLike; trackIndex: number }[],
	materials: MaterialLike[],
	gtrkDir: string,
	fps: number,
	deps: ParticleDeps = {},
): Promise<ParticlePlan> {
	const readText = deps.readTextFile ?? ((p: string) => readFile(p, "utf8"));
	const hit = deps.cacheHit ?? ((p: string) => existsSync(p));

	const items: ParticlePlanItem[] = [];
	const skipped: ParticleSkip[] = [];

	for (const { beat, trackIndex } of beats) {
		const clipId = typeof beat.clip_id === "string" && beat.clip_id ? beat.clip_id : String(beat.material ?? "?");
		const duration = num(beat.duration, num(beat.track_ed) - num(beat.track_st));
		if (!(duration > 0)) {
			skipped.push({ clipId, reason: "时长非正数" });
			continue;
		}
		const ref = resolveParticleHtmlRef(beat, materials, gtrkDir);
		if (!ref) {
			skipped.push({
				clipId,
				reason: "取不到颗粒 HTML（无内联 html，且 html_material 在 materials 里精确查不到或缺 path）",
			});
			continue;
		}
		let html: string;
		if (ref.kind === "inline") {
			html = ref.html;
		} else {
			try {
				html = await readText(ref.path);
			} catch (e) {
				skipped.push({ clipId, reason: `颗粒 HTML 读取失败（${ref.path}）：${(e as Error).message}` });
				continue;
			}
		}
		const opaque = beat.opaque === true;
		const key = particleCacheKey({
			html,
			format: "qtrle",
			quality: "draft",
			fps: Math.round(fps),
			width: PARTICLE_CAPTURE_SIZE.width,
			height: PARTICLE_CAPTURE_SIZE.height,
			duration,
			opaque,
		});
		const cachePath = particleCachePath(gtrkDir, key);
		items.push({ clipId, key, cachePath, cached: hit(cachePath), html, duration, opaque, trackIndex });
	}

	// 按键分组（保序：首次出现者为 leader）
	const byKey = new Map<string, ParticleGroup>();
	for (const it of items) {
		const g = byKey.get(it.key);
		if (g) {
			g.members.push(it.clipId);
		} else {
			byKey.set(it.key, { key: it.key, leader: it, members: [it.clipId], cached: it.cached });
		}
	}
	const groups = [...byKey.values()];
	const missGroups = groups.filter((g) => !g.cached);
	return {
		items,
		skipped,
		groups,
		fps: Math.round(fps),
		total: items.length,
		unique: groups.length,
		cached: groups.length - missGroups.length,
		miss: missGroups.length,
		billedSeconds: missGroups.reduce((s, g) => s + g.leader.duration, 0),
	};
}

export interface ParticleRenderResult {
	/** clipId → qtrle MOV 本机绝对路径（含命中缓存与本次烤出的）。 */
	paths: Record<string, string>;
	/** 本次实际提交云任务的唯一颗粒数。 */
	rendered: number;
	/** 本次失败（跳过）的颗粒。 */
	failed: ParticleSkip[];
}

/**
 * 备齐颗粒 MOV：命中缓存直接用；未命中的唯一组按有界并发提云任务 → 拉回落缓存 → fan-out。
 *
 * 失败策略 = **continue**（与客户端的 `errorPolicy:"stop"` 有意分歧）：CLI 是批处理场景，
 * 一颗坏颗粒不该毁掉整片渲染。失败颗粒**记名**返回，由命令层如实告知，MUST NOT 静默。
 * 缓存写失败同样只降级（内容寻址产物可重烤，误失效的代价上界 = 一次重烤）。
 */
export async function ensureParticleQtrle(
	plan: ParticlePlan,
	cfg: CloudConfig,
	opts: { concurrency?: number; onTick?: (done: number, total: number, note: string) => void } = {},
	deps: ParticleDeps = {},
): Promise<ParticleRenderResult> {
	const submit = deps.submitTask ?? realSubmitTask;
	const poll = deps.pollTask ?? realPollTask;
	const dl = deps.download ?? realDownload;
	const concurrency = Math.max(
		MIN_PARTICLE_CONCURRENCY,
		Math.min(MAX_PARTICLE_CONCURRENCY, Math.trunc(opts.concurrency ?? DEFAULT_PARTICLE_CONCURRENCY)),
	);

	const paths: Record<string, string> = {};
	const failed: ParticleSkip[] = [];
	// 命中组先落位
	for (const g of plan.groups) {
		if (!g.cached) continue;
		for (const id of g.members) paths[id] = g.leader.cachePath;
	}

	const queue = plan.groups.filter((g) => !g.cached);
	let done = 0;
	let rendered = 0;
	const total = queue.length;

	const runOne = async (g: ParticleGroup): Promise<void> => {
		const it = g.leader;
		try {
			const payload = buildParticleComposition({
				html: it.html,
				duration: it.duration,
				// 键里的 fps 与提交体的 fps MUST 同源：都取自 plan 构造时的 Math.round(video_rate)。
				// 这里从键无法反解，故由 leader 携带的语境重算 —— 见 buildParticlePlan 的同一表达式。
				fps: plan.fps,
				opaque: it.opaque,
				trackIndex: it.trackIndex,
				id: it.clipId,
			});
			const taskId = await submit(cfg, PARTICLE_TASK_TYPE, payload);
			const out = (await poll(cfg, PARTICLE_TASK_TYPE, taskId)) as unknown as Record<string, unknown>;
			// ⚠️ 按 Record<string, unknown> 取值：MUST NOT 改 cloud.ts 的 OralCutOutput 类型
			// （那会波及 oralcut / long2short 两条在产链路）
			const url = typeof out.download_url === "string" ? out.download_url : undefined;
			if (!url) throw new Error(`任务完成但 output_result 缺 download_url（task_id=${taskId}）`);
			await mkdir(resolve(it.cachePath, ".."), { recursive: true });
			await dl(url, it.cachePath);
			rendered++;
			for (const id of g.members) paths[id] = it.cachePath;
		} catch (e) {
			const reason = (e as Error).message;
			for (const id of g.members) failed.push({ clipId: id, reason });
			log.warn(`颗粒 ${it.clipId} 渲染失败，本片将不含这一颗（其余照常）：${reason}`);
		} finally {
			done++;
			opts.onTick?.(done, total, it.clipId);
		}
	};

	// 有界并发：固定 N 条工人流水线轮取队列
	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = cursor++;
			if (i >= queue.length) return;
			await runOne(queue[i]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));

	return { paths, rendered, failed };
}

/** 把 plan 的计费面渲染成人读预估行（三个数一起给：只报总数会把「第二次免费」藏掉）。 */
export function particleBillingSummary(plan: ParticlePlan): string {
	const minutes = Math.round((plan.billedSeconds / 60) * 100) / 100;
	return `颗粒 ${plan.total} 颗 / 唯一 ${plan.unique} 颗 / 未命中缓存 ${plan.miss} 颗 → 本次计费时长 ≈ ${minutes} 分钟`;
}

// ══════════════════════════════════════════════════════════════════════════════
// 渲染前编排（`gtrk render` 与 `oralcut --local-render` **共用同一条**，MUST NOT 分叉）
// ══════════════════════════════════════════════════════════════════════════════

/** 从 gtrk v1 取**可见** beat_track 的颗粒。🔴 `hidden: true` 的颗粒轨整条跳过——
 *  它不进成片，为它烤颗粒就是**白花钱**（严格布尔，非法值当键缺席）。 */
export function visibleBeats(gtrk: {
	beat_track?: { track_index?: number; track_timeline?: BeatLike[]; hidden?: unknown }[];
}): { beat: BeatLike; trackIndex: number }[] {
	const out: { beat: BeatLike; trackIndex: number }[] = [];
	for (const t of gtrk.beat_track || []) {
		if (t.hidden === true) continue;
		const ti = typeof t.track_index === "number" ? t.track_index : 10;
		for (const b of t.track_timeline || []) out.push({ beat: b, trackIndex: ti });
	}
	return out;
}

export interface PrepareParticlesOpts {
	/** 逃生舱：跳过颗粒预渲与颗粒叠加（overlay video_track **照叠**，那部分零计费纯本地）。 */
	noParticles?: boolean;
	concurrency?: number;
	/** 跳过计费确认。 */
	yes?: boolean;
	/** 机读模式：缺 `--yes` 且有未命中时**硬拒**（无 stdin 可交互，静默提交是最坏形态）。 */
	json?: boolean;
}

/** `--json` 的颗粒盘点。字段名取 **camelCase**，与同一个 JSON 对象里的兄弟字段
 *  `audio`（`{lanes, embeddedClips, audioTrackClips, silent}`）保持一致。 */
export interface ParticleSummary {
	total: number;
	unique: number;
	cached: number;
	rendered: number;
	billedMinutes: number;
	skipped: ParticleSkip[];
}

export interface PrepareParticlesResult {
	paths: Record<string, string>;
	summary: ParticleSummary;
	/** 用户在确认闸处答 N。命令层据此走「零副作用退出」。 */
	declined?: boolean;
}

export interface PrepareParticlesDeps extends ParticleDeps {
	loadCfg?: () => CloudConfig;
	resolvePricing?: PriceResolver;
	confirm?: (question: string) => Promise<boolean>;
	/** 合规告知（测试注入）。生产恒 `noticeOnce`。 */
	notice?: () => boolean;
}

/**
 * 渲染前把颗粒 MOV 备齐：**全量 preflight（零网络零计费）→ 计费闸 → 烤未命中的**。
 *
 * 计费闸四条（spec「颗粒预渲的计费闸与逃生舱」）：
 *  ① 未命中为 0 ⇒ **不弹确认**（零计费的操作不该有确认摩擦），只打一行零计费说明；
 *  ② 预估话术**同时给三个数**（总数/唯一/未命中 + 计费分钟）——只报总数会把「第二次免费」藏掉；
 *  ③ `--json` 缺 `--yes` ⇒ 硬拒；
 *  ④ 拒绝 ⇒ 零云端调用、零文件写入，话术给出 `--no-particles` 逃生舱。
 */
export async function prepareParticlesForRender(
	gtrk: {
		video_rate?: unknown;
		materials?: MaterialLike[];
		beat_track?: { track_index?: number; track_timeline?: BeatLike[]; hidden?: unknown }[];
	},
	gtrkDir: string,
	opts: PrepareParticlesOpts = {},
	deps: PrepareParticlesDeps = {},
): Promise<PrepareParticlesResult> {
	const empty: ParticleSummary = { total: 0, unique: 0, cached: 0, rendered: 0, billedMinutes: 0, skipped: [] };
	const beats = visibleBeats(gtrk);
	if (beats.length === 0) return { paths: {}, summary: empty };

	if (opts.noParticles) {
		log.info(`--no-particles：跳过 ${beats.length} 颗颗粒的预渲与叠加（零计费；overlay 视频轨照常合成）`);
		return { paths: {}, summary: { ...empty, total: beats.length } };
	}

	const fps = Math.round(num(gtrk.video_rate, 30));
	const plan = await buildParticlePlan(beats, gtrk.materials || [], gtrkDir, fps, deps);
	for (const s of plan.skipped) log.warn(`颗粒 ${s.clipId} 跳过：${s.reason}`);

	const summary: ParticleSummary = {
		total: plan.total,
		unique: plan.unique,
		cached: plan.cached,
		rendered: 0,
		billedMinutes: 0,
		skipped: [...plan.skipped],
	};
	if (plan.unique === 0) return { paths: {}, summary };

	// ── 全命中：零计费、零确认 ────────────────────────────────────────────────
	if (plan.miss === 0) {
		log.info(`颗粒 ${plan.total} 颗全部命中本地缓存（${PARTICLE_CACHE_DIR}），本次零计费`);
		const paths: Record<string, string> = {};
		for (const gr of plan.groups) for (const id of gr.members) paths[id] = gr.leader.cachePath;
		return { paths, summary };
	}

	// ── 落点可写性前置（在花钱之前知道写不写得进去）──────────────────────────
	if (!(await ensureParticleCacheDir(gtrkDir))) {
		log.warn(
			`颗粒缓存目录建不出来（${resolve(gtrkDir, PARTICLE_CACHE_DIR)}）：本次不预渲颗粒、零计费。` +
				"修好目录权限后重跑，或用 --no-particles 明确出无颗粒版。",
		);
		return { paths: {}, summary };
	}

	// ── 计费闸 ────────────────────────────────────────────────────────────────
	const minutes = Math.round((plan.billedSeconds / 60) * 100) / 100;
	summary.billedMinutes = minutes;
	const { billingHint } = await (deps.resolvePricing ?? resolveToolPricing)(
		PARTICLE_TASK_TYPE,
		"MG 颗粒预渲（qtrle 透明 MOV）",
	);
	log.warn(`计费提示：${billingHint}`);
	log.warn(`${particleBillingSummary(plan)}`);
	log.warn("CLI 无本地 HTML 渲染引擎——颗粒唯一路 = 云渲计费任务；已命中缓存的不重烤、不计费。");
	if (!opts.yes) {
		if (opts.json) {
			throw new Error(
				"机读模式（--json）无法交互确认颗粒云渲计费：请显式加 --yes 确认，" +
					"或用 --no-particles 出无颗粒版（零计费）。",
			);
		}
		const go = await (deps.confirm ?? confirmViaStdin)("确认提交颗粒云渲？");
		if (!go) {
			log.warn("已取消：零云端调用、零计费。想先出一版无颗粒的，用 --no-particles。");
			return { paths: {}, summary: { ...summary, billedMinutes: 0 }, declined: true };
		}
	}

	// ── 烤 ────────────────────────────────────────────────────────────────────
	// 🔴 合规告知挂在**内容真正离开本机之前**的最后一刻（确认之后、首个 submit 之前）：
	// 本件让 `gtrk render` 第一次有了云端出口——颗粒 HTML 文本会上行（素材本体不上行）。
	// 拒绝确认的路径走不到这里 ⇒ 没有出口就不打告知，与「恰好一次」的幂等语义一致。
	(deps.notice ?? noticeOnce)();
	log.step(`▶ 颗粒预渲：${plan.miss} 颗待烤（并发 ${opts.concurrency ?? DEFAULT_PARTICLE_CONCURRENCY}）`);
	const cfg = (deps.loadCfg ?? loadConfig)();
	const r = await ensureParticleQtrle(
		plan,
		cfg,
		{
			concurrency: opts.concurrency,
			onTick: (done, total, note) => log.tick(`颗粒 ${done}/${total}（${note}）`),
		},
		deps,
	);
	log.tickEnd();
	summary.rendered = r.rendered;
	summary.skipped.push(...r.failed);
	log.ok(`颗粒备齐：命中 ${plan.cached} / 本次烤 ${r.rendered}${r.failed.length ? ` / 失败 ${r.failed.length}` : ""}`);
	return { paths: r.paths, summary };
}

/** stdin 计费确认（与 `mg render` / `matrix image_move` 的确认闸同款姿势）。 */
async function confirmViaStdin(question: string): Promise<boolean> {
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
		return a === "y" || a === "yes";
	} finally {
		rl.close();
	}
}

/**
 * 缓存目录预建（**在任何付费任务之前**做落点可写性探测）。
 * 落点不可写就该在花钱之前知道——烤完 24 分钟才发现写不进去是最坏形态。
 * 失败只返回 false 由调用方决策，不抛。
 */
export async function ensureParticleCacheDir(gtrkDir: string): Promise<boolean> {
	try {
		await mkdir(resolve(gtrkDir, PARTICLE_CACHE_DIR), { recursive: true });
		return true;
	} catch {
		return false;
	}
}
