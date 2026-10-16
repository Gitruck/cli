/**
 * `gtrk project background` —— 写工程背景（底板）。
 *
 * **缺省 = 逐片段**（change link-clip-background-fill design D6，主理人 2026-10-16）：给**主轨**每个视频 / 图片片段写
 * gtrk 契约字段 `background_fill`（`{type:"blur", intensity:<0–1000 整数>}` / `{type:"color", color:"#RRGGBB"}`），
 * 片段自己带一块铺满画布的底，客户端可逐片段（或多选批量）改；剪映底层轨原生承接，本地渲染承接，Pr 模糊降级纯黑。
 * 叠加轨（B-roll / AI 片段已由各自写方带纯黑底）与空档不写不改；`client_background` 不动。
 *
 * **`--scope canvas`** = 旧的画布级写法（change add-project-background-command）：写客户端画布背景
 * `struct_meta.client_background`，下面这段说明适用于它。
 *
 * 形状唯一依据是客户端读写同一个键的实现（`gitruck-opencut-rewrite/apps/web/src/tonghe/client-project-state.ts`
 * 的 `pickBackground`）：`{type:"blur", blurIntensity:<有限非负数>}` / `{type:"color", color:<非空字符串>}`；
 * 客户端打开时按它还原，保存时从内存态全量重写该键（用户在客户端改过就以客户端为准）。
 *
 * 只动这一个键：其余 `struct_meta` 键（broll / mg / client_visual_elements …）与轨道、素材原样保留。
 * 写回走 `writeGtrkAtomic`（临时文件 + rename + 内容 revision 双重校验）；值未变时不写盘。
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { readGtrk, writeGtrkAtomic } from "./gtrk-writeback";
import { pickMainTrack } from "./pip-lay";
import { encodeSolidPng, MAX_BED_DIM } from "./solid-png";

/** 缺省模糊强度 = 客户端「Medium」档；客户端按画布短边各向同性换算（`fix-blur-sigma-isotropic`），1080×1920 竖屏下 σ = 40，与精剪模糊底同值（以真机目视为准）。 */
export const DEFAULT_BLUR_INTENSITY = 200;
/** 客户端接受任意有限非负数；上限只防手误。 */
export const MAX_BLUR_INTENSITY = 1000;
export const CLIENT_BACKGROUND_KEY = "client_background";

export type ClientBackground = { type: "blur"; blurIntensity: number } | { type: "color"; color: string };
/** 片段级底板（gtrk 契约 `background_fill`；刻度键是 `intensity`，与画布级的 `blurIntensity` 同刻度）。 */
export type ClipFill = { type: "blur"; intensity: number } | { type: "color"; color: string };
export const CLIP_FILL_KEY = "background_fill";

/** 作用面：`clips` = 主轨逐片段（缺省），`canvas` = 画布级 `client_background`。 */
export type BackgroundScope = "clips" | "canvas";

export interface BackgroundOpts {
	blur?: boolean;
	intensity?: string | number;
	color?: string;
	clear?: boolean;
	scope?: string;
}

export function parseScope(raw: string | undefined): BackgroundScope {
	if (raw === undefined || raw === "clips") return "clips";
	if (raw === "canvas") return "canvas";
	throw new Error(`--scope 只收 clips（缺省，主轨逐片段）或 canvas（画布级），收到「${raw}」`);
}

/** 画布级动作 → 片段级底板（`--clear` 为 null）。逐片段模糊强度 MUST 为整数（契约刻度）。 */
export function clipFillOf(action: BackgroundAction): ClipFill | null {
	if (action.mode === "clear") return null;
	if (action.value.type === "color") return { type: "color", color: action.value.color.toUpperCase() };
	const n = action.value.blurIntensity;
	if (!Number.isInteger(n)) throw new Error(`逐片段模糊强度须为 0–${MAX_BLUR_INTENSITY} 的整数，收到「${n}」`);
	return { type: "blur", intensity: n };
}

/** 主轨上可带底板的片段：有素材（非空档）的 clip。 */
const isFillableClip = (c: Record<string, unknown>): boolean => typeof c.material === "string" && c.material !== "";

/**
 * 由旧工程生成新工程：只改主轨片段的 `background_fill`（`fill = null` 即去掉），其余内容与键序原样保留。
 * 主轨 = `track_index` 最小的非黑底垫轨（与 render / matrix / pip 同口径）。
 */
export function applyClipFills(
	gtrk: Record<string, unknown>,
	fill: ClipFill | null,
): { next: Record<string, unknown>; clips: number; changed: number; mainTrackIndex: number; canvasBackground: unknown } {
	const main = pickMainTrack(gtrk);
	const timeline = Array.isArray(main?.track_timeline) ? (main!.track_timeline as Record<string, unknown>[]) : [];
	const targets = timeline.filter(isFillableClip);
	if (!main || !targets.length) throw new Error("主轨上没有视频 / 图片片段，无处写片段底板（要写画布级背景用 --scope canvas）");
	let changed = 0;
	const nextTimeline = timeline.map((c) => {
		if (!isFillableClip(c)) return c;
		const before = c[CLIP_FILL_KEY];
		if (fill === null) {
			if (before === undefined) return c;
			changed++;
			const { [CLIP_FILL_KEY]: _drop, ...rest } = c;
			return rest;
		}
		if (JSON.stringify(before) === JSON.stringify(fill)) return c;
		changed++;
		return { ...c, [CLIP_FILL_KEY]: { ...fill } };
	});
	const tracks = gtrk.video_track as Record<string, unknown>[];
	const next = changed ? { ...gtrk, video_track: tracks.map((t) => (t === main ? { ...t, track_timeline: nextTimeline } : t)) } : gtrk;
	const canvasBackground = (gtrk.struct_meta as Record<string, unknown> | undefined)?.[CLIENT_BACKGROUND_KEY];
	return { next, clips: targets.length, changed, mainTrackIndex: main.track_index as number, canvasBackground: canvasBackground ?? null };
}

export type BackgroundAction = { mode: "blur" | "color"; value: ClientBackground } | { mode: "clear" };

const HEX6 = /^#[0-9A-Fa-f]{6}$/;

/** 恰好一个模式 + 取值校验；任何不合法都在读文件之前抛出（文件不变）。 */
export function parseBackgroundOpts(opts: BackgroundOpts): BackgroundAction {
	const modes = [opts.blur && "--blur", opts.color !== undefined && "--color", opts.clear && "--clear"].filter(
		Boolean,
	) as string[];
	if (modes.length === 0) {
		throw new Error("缺少背景模式——三选一：--blur [--intensity <n>] / --color <#RRGGBB> / --clear");
	}
	if (modes.length > 1) throw new Error(`背景模式只能选一个，收到 ${modes.join(" 与 ")}`);
	if (opts.intensity !== undefined && !opts.blur) throw new Error("--intensity 只配合 --blur 使用");

	if (opts.clear) return { mode: "clear" };
	if (opts.color !== undefined) {
		if (!HEX6.test(opts.color)) throw new Error(`--color 须为六位十六进制颜色（如 #1A1A1A），收到「${opts.color}」`);
		return { mode: "color", value: { type: "color", color: opts.color } };
	}
	let intensity = DEFAULT_BLUR_INTENSITY;
	if (opts.intensity !== undefined) {
		const raw = String(opts.intensity).trim();
		intensity = raw === "" ? Number.NaN : Number(raw);
		if (!Number.isFinite(intensity) || intensity < 0 || intensity > MAX_BLUR_INTENSITY) {
			throw new Error(`--intensity 须为 0–${MAX_BLUR_INTENSITY} 的数，收到「${opts.intensity}」`);
		}
	}
	return { mode: "blur", value: { type: "blur", blurIntensity: intensity } };
}

/** 由旧工程生成新工程：只替换 / 删除 `struct_meta.client_background`，其余键与键序原样保留。 */
export function applyBackground(
	gtrk: Record<string, unknown>,
	action: BackgroundAction,
): { next: Record<string, unknown>; previous: unknown; changed: boolean } {
	const structMeta = (gtrk.struct_meta as Record<string, unknown> | undefined) ?? {};
	const previous = structMeta[CLIENT_BACKGROUND_KEY];
	const nextMeta: Record<string, unknown> = { ...structMeta };
	if (action.mode === "clear") delete nextMeta[CLIENT_BACKGROUND_KEY];
	else nextMeta[CLIENT_BACKGROUND_KEY] = action.value;
	const after = action.mode === "clear" ? undefined : action.value;
	const changed = JSON.stringify(previous) !== JSON.stringify(after);
	return { next: { ...gtrk, struct_meta: nextMeta }, previous: previous ?? null, changed };
}

export interface BackgroundResult {
	ok: true;
	mode: "project-background";
	gtrk: string;
	/** 作用面（缺省 clips）。 */
	scope: BackgroundScope;
	action: BackgroundAction["mode"];
	/** 写入后的值；`--clear` 为 null。scope=clips 时是片段底板（契约形状），scope=canvas 时是画布背景。 */
	background: ClientBackground | ClipFill | null;
	/** scope=canvas：写入前的画布背景。scope=clips：恒 null（片段各自的旧值不汇总）。 */
	previous: unknown;
	/** scope=clips：主轨可带底板的片段数 / 本次实际改动的片段数 / 主轨号。 */
	clips?: number;
	changed_clips?: number;
	main_track?: number;
	/** scope=clips：工程里仍在的画布级背景（不动它；有片段的时段被片段底盖住看不见）。 */
	canvas_background?: unknown;
	changed: boolean;
	dry_run: boolean;
	written: boolean;
	revision_before: string;
	revision_after: string;
}

/** 校验 → 读 → 改一个键 → 原子写回。`--dry-run` 只回执将写入的值；值未变时不写盘（revision 不变）。 */
export function runBackground(
	gtrkPath: string,
	opts: BackgroundOpts & { dryRun?: boolean },
	/** 测试注入：读盘之后、写回之前调用（模拟外部改动以验 revision 守卫）；生产不传。 */
	deps: { afterRead?: () => void } = {},
): BackgroundResult {
	const scope = parseScope(opts.scope);
	const action = parseBackgroundOpts(opts);
	const fill = scope === "clips" ? clipFillOf(action) : null;
	const { gtrk, revision } = readGtrk(gtrkPath);
	deps.afterRead?.();
	if (gtrk.version !== "v1") {
		throw new Error(`工程文件不是 v1（version=${JSON.stringify(gtrk.version)}）：客户端只按 v1 读背景`);
	}
	const dryRun = Boolean(opts.dryRun);
	if (scope === "clips") {
		const r = applyClipFills(gtrk, fill);
		const write = r.changed > 0 && !dryRun;
		const revisionAfter = write ? writeGtrkAtomic(gtrkPath, r.next, revision, "project background") : revision;
		return {
			ok: true,
			mode: "project-background",
			gtrk: gtrkPath,
			scope,
			action: action.mode,
			background: fill,
			previous: null,
			clips: r.clips,
			changed_clips: r.changed,
			main_track: r.mainTrackIndex,
			canvas_background: r.canvasBackground,
			changed: r.changed > 0,
			dry_run: dryRun,
			written: write,
			revision_before: revision,
			revision_after: revisionAfter,
		};
	}
	const { next, previous, changed } = applyBackground(gtrk, action);
	const write = changed && !dryRun;
	const revisionAfter = write ? writeGtrkAtomic(gtrkPath, next, revision, "project background") : revision;
	return {
		ok: true,
		mode: "project-background",
		gtrk: gtrkPath,
		scope,
		action: action.mode,
		background: action.mode === "clear" ? null : action.value,
		previous,
		changed,
		dry_run: dryRun,
		written: write,
		revision_before: revision,
		revision_after: revisionAfter,
	};
}

// ── 工程导出的片段底板物化（infra add-clip-background-fill design D3「落点定稿」）─────────────
//
// 剪映 / Pr 表达不了上层轨片段的填充，云端在导出副本里插辅助轨，引用本机 `<nle_asset_dir>/solid-<rrggbb>-<W>x<H>.png`，
// 结果 `materialize_files` 列出须由调用方写出的纯色图。`gtrk project export` 把产物目录作为 `nle_asset_dir` 上行
// （所有格式共用一处：XML / 草稿都按绝对路径引用），拿回结果后写图。与客户端 `tonghe/materialize-files.ts` 同口径。

/** 工程里有没有带 `background_fill` 的视频片段（没有就不上行 `nle_asset_dir`，提交体与改前逐字节一致）。 */
export function hasClipFill(gtrk: Record<string, unknown>): boolean {
	const tracks = Array.isArray(gtrk.video_track) ? (gtrk.video_track as Array<{ track_timeline?: unknown }>) : [];
	return tracks.some((t) =>
		Array.isArray(t.track_timeline) &&
		(t.track_timeline as Array<Record<string, unknown>>).some((c) => c && typeof c === "object" && CLIP_FILL_KEY in c),
	);
}

export interface MaterializeSolid {
	/** 正斜杠绝对路径（与云端引用的字面一致）。 */
	path: string;
	color: string;
	width: number;
	height: number;
}

const fwd = (p: string): string => p.split("\\").join("/").replace(/\/+$/, "");

/**
 * 只认落在本次给出的目录里、文件名由色值与尺寸推得出（`solid-<rrggbb>-<W>x<H>.png`）的条目：
 * 云端回传的是路径，照单全收等于让它往本机任意位置写文件。其余丢弃并计数。
 */
export function acceptMaterializeFiles(raw: unknown, dir: string): { files: MaterializeSolid[]; rejected: number } {
	if (!Array.isArray(raw)) return { files: [], rejected: 0 };
	const want = fwd(dir).toLowerCase();
	const files: MaterializeSolid[] = [];
	const seen = new Set<string>();
	let rejected = 0;
	for (const item of raw) {
		const f = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
		const { path, color, width, height } = f;
		const ok =
			f.kind === "solid" &&
			typeof path === "string" &&
			typeof color === "string" &&
			/^#[0-9a-f]{6}$/i.test(color) &&
			Number.isInteger(width) &&
			Number.isInteger(height) &&
			(width as number) > 0 &&
			(height as number) > 0 &&
			(width as number) <= MAX_BED_DIM &&
			(height as number) <= MAX_BED_DIM;
		const p = ok ? fwd(path as string) : "";
		const cut = p.lastIndexOf("/");
		const name = ok ? `solid-${(color as string).slice(1).toLowerCase()}-${width}x${height}.png` : "";
		if (!ok || p.slice(0, cut).toLowerCase() !== want || p.slice(cut + 1) !== name) {
			rejected++;
			continue;
		}
		if (seen.has(p.toLowerCase())) continue;
		seen.add(p.toLowerCase());
		files.push({ path: p, color: (color as string).toUpperCase(), width: width as number, height: height as number });
	}
	return { files, rejected };
}

/** 写出纯色图（已在盘即跳过：像素由文件名完全决定）；写失败直接抛。返回新写张数。 */
export async function writeMaterializeFiles(files: MaterializeSolid[], dir: string): Promise<number> {
	if (!files.length) return 0;
	await mkdir(dir, { recursive: true });
	let written = 0;
	for (const f of files) {
		if (existsSync(f.path)) continue;
		await writeFile(f.path, encodeSolidPng({ hex: f.color, width: f.width, height: f.height }));
		written++;
	}
	return written;
}
