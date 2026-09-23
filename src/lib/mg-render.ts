/**
 * gtrk mg render —— 独立颗粒渲染（add-mg-standalone-render，精剪补给口）。
 *
 * 脱离工程：颗粒 HTML → lint（包络 = --duration）→ 计费预估确认（--yes 跳过）→
 * 内联提交 html_render_simple（output_format=qtrle，tracks=[] beats-only 透明层）→
 * 轮询 → 剪映可读 alpha MOV 落盘 + task.json/result.json 面包屑（对齐工具族 runner 惯例）。
 *
 * 首发射程（proposal 决策留痕 3）：qtrle only、1920×1080 only、--duration 必填；
 * webm / 竖屏 / 异形画布明确拒绝——契约没开口，不静默出坏片。
 * CLI 无本地 HTML 渲染引擎——独立颗粒唯一路 = 云渲计费任务（确认提示里如实明示）。
 *
 * 载荷形状以 infra `html_animate_render.py` 校验代码为准（tasks 0.1 核对）：
 * composition = { video_size:{width,height}, tracks:[], beats:[{html,start,duration}], assets:{file_id:{}} }
 * —— video_size 是 {width,height} 对象（非 .gtrk 的 [宽,高]）、beat 时长字段 = start+duration
 * （非 track_st/track_ed）、不标 version（载荷刻意不与 .gtrk gtrk-v1 同名，见 erase-v0-composition-contract）、
 * assets.file_id 必须为 dict（纯内联 beats 也要给空 map，_validate_assets 无条件调用）。
 */
import { basename, join, resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { CloudConfig } from "./config";
import { loadConfig } from "./config";
import { submitTask as realSubmitTask, pollTask as realPollTask, download as realDownload } from "./cloud";
import { lintParticle, parseCompositionId, type LintViolation } from "./mg-lint";
import { resolveToolPricing, type PriceResolver } from "./tool-pricing";
import { log } from "./log";

export const MG_RENDER_TASK_TYPE = "html_render_simple";

/**
 * 文件名是否形如 composition_id（`<slug>-B<数字>` / `<slug>-B<数字>-aux<n>`）。
 * 与 `gtrk mg lint` 裸模式同规则（原 mg.ts 私有常量上提于此，单一真相源）：
 * 命中才拿 basename 当 lint 期望 id，改过名的临时副本不比对、防误判致命。
 */
export const CID_SHAPE = /-B\d+(?:-aux\d+)?$/;

/** 剪映草稿目录特征（产物落点纪律：绝不写草稿目录，拖入剪映由用户做、素材归属清晰）。 */
const JIANYING_DRAFT_DIR_MARKERS = ["com.lveditor.draft", "JianyingPro"];

export interface MgRenderDeps {
	/** 懒加载：确认被拒 / 本地校验失败路径零 loadConfig 零云端触达。 */
	loadCfg?: () => CloudConfig;
	submitTask?: typeof realSubmitTask;
	pollTask?: typeof realPollTask;
	download?: typeof realDownload;
	resolvePricing?: PriceResolver;
	/** stdin 计费确认（--yes 跳过；测试注入）。 */
	confirm?: (question: string) => Promise<boolean>;
	now?: () => string;
}

export interface MgRenderOpts {
	/** 颗粒 HTML 路径。 */
	file: string;
	/** 显式时长锚（秒）——独立模式无坑位包络，它就是 lint 铁律⑦的包络与成片时长。 */
	duration: number;
	/** 首发仅 qtrle（缺省即它；参数位留给将来 webm）。 */
	format?: string;
	/** 落盘目录；缺省 ./mg-render/<composition_id>/。 */
	out?: string;
	/** 跳过计费确认。 */
	yes?: boolean;
}

export interface MgRenderResult {
	ok: boolean;
	mode: "render";
	reason?: "geometry" | "lint" | "declined";
	composition_id?: string;
	task_id?: string;
	/** 产物 MOV 绝对路径。 */
	output?: string;
	outDir?: string;
	duration?: number;
	violations?: LintViolation[];
	[k: string]: unknown;
}

/** 缺省落点纯函数（供单测）：显式 --out 优先，缺省当前目录子文件夹（产物落点纪律）。 */
export function resolveRenderOutDir(compositionId: string, out?: string): string {
	return resolve(out ?? join("mg-render", compositionId));
}

/** 落点守卫：拒绝写进剪映草稿目录（大小写不敏感判特征段）。 */
export function assertNotJianyingDraftDir(dirAbs: string): void {
	const low = dirAbs.toLowerCase();
	for (const m of JIANYING_DRAFT_DIR_MARKERS) {
		if (low.includes(m.toLowerCase())) {
			throw new Error(
				`产物落点纪律：不写剪映草稿目录（${dirAbs}）——MOV 落普通目录后由你拖进剪映，素材归属才清晰。换个 --out 目录。`,
			);
		}
	}
}

/** 解析颗粒自声明几何（data-width/data-height）；解析不到返回 undefined（交给 lint 报缺失）。 */
function parseGeometry(html: string): { width: number; height: number } | undefined {
	const w = /data-width\s*=\s*["'](\d+)["']/.exec(html);
	const h = /data-height\s*=\s*["'](\d+)["']/.exec(html);
	if (!w || !h) return undefined;
	return { width: Number(w[1]), height: Number(h[1]) };
}

/**
 * 独立颗粒渲染主链。业务性拒绝（几何/lint/确认拒）return `ok:false`；
 * 用法性错误（缺 duration / 非法 format / 落点违纪）throw（命令层统一可读报错 + 非 0 退出）。
 */
export async function renderParticle(opts: MgRenderOpts, deps: MgRenderDeps = {}): Promise<MgRenderResult> {
	// ── 入参约束（spec：三类拒绝全部前置在本地、零计费）─────────────────────────
	if (!Number.isFinite(opts.duration) || opts.duration <= 0) {
		throw new Error("--duration <sec> 必填且须为正数（秒）——独立模式无坑位包络，它就是时长锚（lint 包络 = 成片时长 = 计费时长）。");
	}
	const format = opts.format ?? "qtrle";
	if (format !== "qtrle") {
		throw new Error(
			format === "webm"
				? "--format webm 暂不支持：剪映不吃 VP8-alpha，本模式首发只出 qtrle（QuickTime Animation alpha MOV，剪映真透底）。"
				: `--format 仅支持 qtrle（收到「${format}」）。`,
		);
	}

	const fileAbs = resolve(opts.file);
	const html = await readFile(fileAbs, "utf8");

	// ── 几何拒绝（先于 lint，给专属话术）────────────────────────────────────────
	//
	// [add-text-ir-aspect-agnostic-layout] 口径从「首发仅 1920×1080」改成「须为正整数」。
	//
	// ⚠️ 原来那条**当初是对的**：`fix-particle-subcomposition-scale` 之前，颗粒声明尺寸
	// 与根合成尺寸不等会被 `#stage` 裁掉、只渲左上一角，放行就是静默出坏片。
	// 修复上线之后 `html_animate_render` 按颗粒声明的 `data-width/height` 挂载缩放、
	// 根合成尺寸本就是 `flags.width/height` 参数 —— 那个失败形态已经不存在了。
	// ⇒ 这里继续拦，拦的是**一个不存在的东西**，代价是竖屏工程永远出不了文字模板。
	//
	// 现在还拦什么：**非正整数几何**。那种颗粒进云渲会让根合成尺寸算成 0 或 NaN，
	// 失败形态是空片而不是坏片，但同样不该提交（提交了要计费）。
	const geo = parseGeometry(html);
	const badGeo = geo && !(Number.isInteger(geo.width) && geo.width > 0
		&& Number.isInteger(geo.height) && geo.height > 0);
	if (badGeo) {
		log.err(`颗粒几何 ${geo.width}×${geo.height}：宽高须为正整数——不提交云任务，零计费。`);
		return { ok: false, mode: "render", reason: "geometry", geometry: geo };
	}

	// ── lint 前置（复用 mg-lint 全套；包络 = --duration）────────────────────────
	const nameId = basename(fileAbs).replace(/\.html?$/i, "");
	const lint = lintParticle(html, {
		slotDuration: opts.duration,
		...(CID_SHAPE.test(nameId) ? { compositionId: nameId } : {}),
	});
	for (const v of lint.violations) (v.fatal ? log.err : log.warn)(`${v.fatal ? "✗" : "·"} ${v.law}: ${v.msg}`);
	if (!lint.ok) {
		log.err(`lint 未过（${lint.violations.filter((v) => v.fatal).length} 项致命）——未提交云任务，零计费。`);
		return { ok: false, mode: "render", reason: "lint", violations: lint.violations };
	}
	const cid = parseCompositionId(html) ?? nameId;

	// ── 落点定稿 + 守卫（确认前定稿：拒绝路径也零副作用）────────────────────────
	const outDir = resolveRenderOutDir(cid, opts.out);
	assertNotJianyingDraftDir(outDir);

	// ── 计费预估确认（--yes 跳过；拒绝 = 零云端调用、零 loadConfig）─────────────
	const minutes = Math.round((opts.duration / 60) * 10000) / 10000;
	const { billingHint } = await (deps.resolvePricing ?? resolveToolPricing)(
		MG_RENDER_TASK_TYPE,
		"独立颗粒渲染（qtrle 透明 MOV）",
	);
	log.warn(`计费提示：${billingHint}`);
	log.warn(`CLI 无本地 HTML 渲染引擎——独立颗粒唯一路 = 云渲计费任务；本次 ${opts.duration}s ≈ ${minutes} 分钟计费时长。`);
	if (!opts.yes) {
		const go = await (deps.confirm ?? confirmViaStdin)("确认提交云渲？");
		if (!go) {
			log.warn("已取消：零云端调用、零计费。");
			return { ok: false, mode: "render", reason: "declined", declined: true, composition_id: cid };
		}
	}

	// ── 提交（内联 html、tracks=[] beats-only、qtrle）───────────────────────────
	const cfg = (deps.loadCfg ?? loadConfig)();
	const payload = {
		composition: {
			// 🩸 **根合成尺寸取颗粒自己声明的几何**（add-text-ir-aspect-agnostic-layout，
			//    2026-09-16 竖屏云渲真机抓出来的）。
			//
			// 这里原先写死 `{1920, 1080}`。放开几道校验闸之后，一颗声明 1080×1920 的颗粒
			// 能提单、能渲出片——**但出来的 MOV 是 1920×1080**：根合成仍按写死的尺寸开，
			// 颗粒被 `scale(1920/1080, 1080/1920)` 非等比挂上去 ⇒ 横向拉 1.78 倍、纵向压到 0.56，
			// 而**全链零报错**（lint 过、提单过、渲染完成、帧数正确、还真的在动）。
			//
			// ⚠️ 这条正是 tasks 6.1 写「MUST NOT 用读码结论代验」的理由：
			// 读码结论是「根合成尺寸本就是 `flags.width/height` 参数」——**那句话没错**，
			// 错的是**没人把颗粒的声明尺寸传进那个参数**。链路读通 ≠ 跑得通。
			video_size: geo ? { width: geo.width, height: geo.height } : { width: 1920, height: 1080 },
			tracks: [],
			beats: [{ html, start: 0, duration: opts.duration }],
			assets: { file_id: {} },
		},
		render: { output_format: "qtrle" },
	};
	const taskId = await (deps.submitTask ?? realSubmitTask)(cfg, MG_RENDER_TASK_TYPE, payload);
	const now = deps.now ?? (() => new Date().toISOString());
	await mkdir(outDir, { recursive: true });
	// 面包屑口径对齐工具族 runner：submit 一成功就落 task.json（轮询之前），崩溃可凭 task_id 恢复
	await writeFile(
		join(outDir, "task.json"),
		JSON.stringify(
			{ task_type: MG_RENDER_TASK_TYPE, task_id: taskId, composition_id: cid, source: fileAbs, duration_sec: opts.duration, output_format: "qtrle", submitted_at: now() },
			null,
			2,
		),
	);
	log.step(`▶ 已提交云渲（task_id=${taskId}），轮询中…`);

	// ── 轮询 + 落盘 ─────────────────────────────────────────────────────────────
	const output = (await (deps.pollTask ?? realPollTask)(cfg, MG_RENDER_TASK_TYPE, taskId, (s, p) =>
		log.info(`${s}${typeof p === "number" ? ` ${p}%` : ""}`),
	)) as Record<string, unknown>;
	const downloadUrl = typeof output.download_url === "string" ? output.download_url : undefined;
	if (!downloadUrl) throw new Error(`任务完成但 output_result 缺 download_url（task_id=${taskId}，面包屑在 ${outDir}）`);
	const movPath = join(outDir, `${cid}.mov`);
	await (deps.download ?? realDownload)(downloadUrl, movPath);
	await writeFile(
		join(outDir, "result.json"),
		JSON.stringify(
			{ ok: true, task_id: taskId, composition_id: cid, output: `${cid}.mov`, duration_sec: opts.duration, file_id: output.file_id ?? null, completed_at: now() },
			null,
			2,
		),
	);
	log.ok(`渲染完成：${movPath}（qtrle 透明 MOV，直接拖进剪映即用）`);
	return { ok: true, mode: "render", composition_id: cid, task_id: taskId, output: movPath, outDir, duration: opts.duration };
}

/** stdin 计费确认（与 matrix 的确认闸同款姿势）。 */
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
