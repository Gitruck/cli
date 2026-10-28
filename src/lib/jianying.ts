/** 剪映/CapCut 草稿目录解析与草稿落地。oralcut / long2short / init 共用。 */
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { readUserConfig } from "./user-config";

/** 探测剪映/CapCut 草稿根目录（Windows 标准位置）。探到返回路径，否则 undefined。 */
export function probeJianyingDraftDir(): string | undefined {
	const local = process.env.LOCALAPPDATA;
	if (!local) return undefined;
	const candidates = [
		join(local, "JianyingPro", "User Data", "Projects", "com.lveditor.draft"),
		join(local, "CapCut", "User Data", "Projects", "com.lveditor.draft"),
	];
	return candidates.find((p) => existsSync(p));
}

/** 解析剪映草稿目录：显式 flag（非 "auto"）> `gtrk init` 持久配置 > 标准位置自动探测。 */
export function resolveJianyingDraftDir(opt: string | undefined): string | undefined {
	if (opt && opt !== "auto") return resolve(opt);
	const saved = readUserConfig().jianyingDraftDir;
	if (saved && existsSync(saved)) return saved;
	return probeJianyingDraftDir();
}

/** 两个本机路径是否指同一处（Windows 下不分大小写）。 */
export function samePath(a: string, b: string): boolean {
	const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
	return norm(a) === norm(b);
}

/**
 * 认领产物目录面包屑里记录的草稿落点（fix-long2short-dub-export-draft-collision D1；oralcut-result 也用它）。
 *
 * 剪映草稿根是所有毛片共用的一层目录，只靠名字分不清「同一毛片重跑」与「别的毛片撞名」；
 * 能分清的只有 CLI 自己写的面包屑：`<outDir>/task.json` 满足调用方的 `match`（oralcut-result 比 task_id、
 * long2short / 译制配音比 `source`），且 `key` 记的落点就在本次解析出的草稿根下 ⇒ 这个落点属于本产物目录。
 * 落点（`suffix` 给了就看 `<落点><suffix>`，long2short 的锚点 `_clip0`）还在就沿用；被删了就非递归重建，
 * 重建失败（已被别的运行占走 / 写不进）⇒ 不认领。task.json 缺失、读坏、不匹配、换了草稿根 ⇒ 不认领、不报错，交调用方去仲裁。
 * `created` 为 true 表示锚点是这一次重建的（提交前失败时可以删）。
 */
export async function claimRecordedDraft(opts: {
	outDir: string;
	draftRoot: string;
	key: "jianyingDraftDir" | "jianyingDraftBase";
	match: (crumb: Record<string, unknown>) => boolean;
	suffix?: string;
}): Promise<{ path: string; created: boolean } | undefined> {
	let crumb: unknown;
	try {
		crumb = JSON.parse(await readFile(join(opts.outDir, "task.json"), "utf8"));
	} catch {
		return undefined;
	}
	if (!crumb || typeof crumb !== "object" || Array.isArray(crumb)) return undefined;
	const rec = crumb as Record<string, unknown>;
	const path = rec[opts.key];
	if (typeof path !== "string" || !path || !opts.match(rec)) return undefined;
	if (!samePath(dirname(path), opts.draftRoot)) return undefined;
	const probe = `${path}${opts.suffix ?? ""}`;
	if (existsSync(probe)) return { path, created: false };
	try {
		await mkdir(probe); // 非递归：只重建这一级
		return { path, created: true };
	} catch {
		return undefined;
	}
}

/**
 * 剪映/CapCut 只认的固定两件套文件名——缺一件，草稿就不在软件的草稿列表里显示。
 * 判据来自对照实测：剪映自建草稿与 oralcut 落的可见草稿都是这两个无前缀固定名。
 */
export const JIANYING_DRAFT_FILES = ["draft_content.json", "draft_meta_info.json"] as const;

export interface JianyingDraftLanding {
	/** 落成固定名的文件：固定名 → 目标绝对路径。 */
	landed: Record<string, string>;
	/** 缺席的固定名（空数组 = 两件套齐全）。 */
	missing: string[];
	/** 两件套齐全 = 剪映列表里可见。 */
	complete: boolean;
	/** 未参与改名、按原名原样搬运的条目名。 */
	passthrough: string[];
}

/**
 * 把 srcDir 拷进 destDir，并把工程文件落成剪映认的固定名：
 * `*draft_content.json` → `draft_content.json`、`*draft_meta_info.json` → `draft_meta_info.json`。
 *
 * 按**后缀**识别、不硬编云端前缀（long2short 今日产 `clip{i}_` 前缀、oralcut 产无前缀）——
 * 云端将来改前缀也不复发「草稿建了但剪映扫不到」。同一固定名有多个候选时精确同名优先、
 * 否则取按名排序的第一个（不依赖 readdir 顺序）；其余条目（子目录/其它文件/同类落选者）
 * 按原名原样搬运，每个源条目恰好拷一次。
 *
 * 不删 destDir 既有内容、不改文件内容（`draft_fold_path`/`draft_name`/素材路径由产出方写定）。
 */
export async function copyJianyingDraft(srcDir: string, destDir: string): Promise<JianyingDraftLanding> {
	const entries = (await readdir(srcDir, { withFileTypes: true })).sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	);

	// 逐固定名选源（源条目名 → 该落成的固定名）
	const chosen = new Map<string, string>();
	for (const fixed of JIANYING_DRAFT_FILES) {
		const cands = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(fixed));
		const pick = cands.find((e) => e.name.toLowerCase() === fixed) ?? cands[0];
		if (pick) chosen.set(pick.name, fixed);
	}

	await mkdir(destDir, { recursive: true });
	const landed: Record<string, string> = {};
	const passthrough: string[] = [];
	for (const e of entries) {
		const fixed = chosen.get(e.name);
		const dest = join(destDir, fixed ?? e.name);
		await cp(join(srcDir, e.name), dest, { recursive: true });
		if (fixed) landed[fixed] = dest;
		else passthrough.push(e.name);
	}

	const missing = JIANYING_DRAFT_FILES.filter((f) => !landed[f]);
	return { landed, missing, complete: missing.length === 0, passthrough };
}
