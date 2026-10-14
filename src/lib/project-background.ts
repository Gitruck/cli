/**
 * `gtrk project background` —— 写客户端画布背景 `struct_meta.client_background`（change add-project-background-command）。
 *
 * 形状唯一依据是客户端读写同一个键的实现（`gitruck-opencut-rewrite/apps/web/src/tonghe/client-project-state.ts`
 * 的 `pickBackground`）：`{type:"blur", blurIntensity:<有限非负数>}` / `{type:"color", color:<非空字符串>}`；
 * 客户端打开时按它还原，保存时从内存态全量重写该键（用户在客户端改过就以客户端为准）。
 *
 * 只动这一个键：其余 `struct_meta` 键（broll / mg / client_visual_elements …）与轨道、素材原样保留。
 * 写回走 `writeGtrkAtomic`（临时文件 + rename + 内容 revision 双重校验）；值未变时不写盘。
 */
import { readGtrk, writeGtrkAtomic } from "./gtrk-writeback";

/** 缺省模糊强度 = 客户端「Medium」档；客户端按画布短边各向同性换算（`fix-blur-sigma-isotropic`），1080×1920 竖屏下 σ = 40，与精剪模糊底同值（以真机目视为准）。 */
export const DEFAULT_BLUR_INTENSITY = 200;
/** 客户端接受任意有限非负数；上限只防手误。 */
export const MAX_BLUR_INTENSITY = 1000;
export const CLIENT_BACKGROUND_KEY = "client_background";

export type ClientBackground = { type: "blur"; blurIntensity: number } | { type: "color"; color: string };

export interface BackgroundOpts {
	blur?: boolean;
	intensity?: string | number;
	color?: string;
	clear?: boolean;
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
	action: BackgroundAction["mode"];
	/** 写入后的值；`--clear` 为 null。 */
	background: ClientBackground | null;
	previous: unknown;
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
	const action = parseBackgroundOpts(opts);
	const { gtrk, revision } = readGtrk(gtrkPath);
	deps.afterRead?.();
	if (gtrk.version !== "v1") {
		throw new Error(`工程文件不是 v1（version=${JSON.stringify(gtrk.version)}）：客户端只按 v1 读画布背景`);
	}
	const { next, previous, changed } = applyBackground(gtrk, action);
	const dryRun = Boolean(opts.dryRun);
	const write = changed && !dryRun;
	const revisionAfter = write ? writeGtrkAtomic(gtrkPath, next, revision, "project background") : revision;
	return {
		ok: true,
		mode: "project-background",
		gtrk: gtrkPath,
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
