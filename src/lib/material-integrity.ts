/**
 * 素材落盘完整性自检（material-integrity-check spec）。
 *
 * 主理人 2026-07-26：「gtrk matrix 跑完自检一遍 `materials[].path` 是否真的都落盘了，没落盘的如实报」。
 *
 * 定位是**检测面**（发现已存在的悬空引用），不是预防面（不让它产生）——真机那 2 条 `broll-raw-*`
 * 由 opencut 客户端「确认原片」流程写入（`apps/web/src/tonghe/broll-actions.ts:513`，落点
 * `assets/broll/<clip_id>.mp4`），CLI 侧只读该前缀、从不写它。预防面在 opencut 另立 change；
 * 二者互补：客户端修好了，历史工程里已有的悬空引用仍然需要有人查得出来。
 *
 * 三条铁律：
 *   - **基准**：相对路径恒以 `.gtrk` 文件所在目录为基准解析（`<产物目录>/gtrk/`），**不是工程根**。
 *     这是本仓的历史坑：真机 237 条全相对路径的工程，按工程根解析会误报 **235** 条，
 *     按 `.gtrk` 目录解析恰好命中真悬空的 **2** 条。写侧四条路径（B-roll 代理 `assets/broll-preview/`、
 *     MG 颗粒 `assets/mg/`、黑底 PNG `assets/builtin/`、客户端确认原片 `assets/broll/`）
 *     基准完全一致 = `dirname(<project.gtrk>)`。
 *   - **非致命**：自检只告知，MUST NOT 让命令失败 / 改退出码 / 拒写。悬空多半是历史遗留，
 *     拦住只会让用户没法继续干活；客户端还有 relink 回落。
 *   - **零误伤**：只读。MUST NOT 删素材条目、MUST NOT 删文件、MUST NOT 二次写 `.gtrk`。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** 人读逐条清单上限（截断时明示总数）；机读侧 MUST NOT 截断。 */
export const INTEGRITY_LIST_CAP = 10;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** `materials[].path` 的四种形态。 */
export type MaterialPathKind = "relative" | "absolute" | "remote" | "none";

/** 时间线上对某素材的一次引用。 */
export interface MaterialRef {
	track: "video_track" | "audio_track" | "beat_track";
	track_index: number | null;
	clip_id: string | null;
	track_st: number | null;
	/** clip 带 `track_ed` 直接取；只带 `track_st`+`duration`（客户端写侧形态）时由二者推得。 */
	track_ed: number | null;
	/** 引用键：`material`（普通素材）或 `html_material`（MG 颗粒）。 */
	key: "material" | "html_material";
}

/** 一条文件不在盘上的素材。 */
export interface MissingMaterial {
	id: string;
	path: string;
	kind: "relative" | "absolute";
	/** 解析后的绝对路径（相对路径按 `.gtrk` 所在目录解析）。 */
	resolved: string;
	/** 是否被时间线引用——被引用的比孤儿严重得多（播到那段就没画面）。 */
	referenced: boolean;
	refCount: number;
	refs: MaterialRef[];
}

export interface IntegrityReport {
	/** 已检查的 `materials[]` 条数。 */
	checked: number;
	counts: { relative: number; absolute: number; remote: number; noPath: number };
	/** 主判悬空（相对路径解析后文件不存在）全量，被引用者在前。MUST NOT 按人读阈值过滤/截断。 */
	dangling: MissingMaterial[];
	danglingReferenced: number;
	danglingOrphan: number;
	/** 绝对路径缺失（另一档，不强判——外接盘/网络盘没挂载是常态，混进主判必假阳性）。 */
	external: MissingMaterial[];
	/** `path` 缺失 / 空 / 非字符串的素材 id（结构问题，与「缺文件」不是一回事）。 */
	noPathIds: string[];
	/** 自检自身失败时的降级记录（MUST NOT 把「查不了」冒充成「查过且干净」）。 */
	degraded?: { count: number; reason: string };
}

/**
 * path 形态分档。绝对判据**自实现**：`node:path.isAbsolute` 在 POSIX 下不认 `X:/…` 盘符路径，
 * 直接用它会让跨平台单测结果漂移。
 */
export function classifyMaterialPath(p: unknown): { kind: MaterialPathKind; path: string } {
	if (typeof p !== "string" || p.trim() === "") return { kind: "none", path: typeof p === "string" ? p : "" };
	const path = p.trim();
	if (/^https?:\/\//i.test(path)) return { kind: "remote", path };
	// 盘符（X:/ 或 X:\）/ UNC（\\host）/ POSIX 根（/…）三种绝对形态
	if (/^[a-zA-Z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path) || /^[\\/]/.test(path)) {
		return { kind: "absolute", path };
	}
	return { kind: "relative", path };
}

/** 相对路径形态归一（客户端可能写反斜杠或 `./` 前缀）：只归一形态，MUST NOT 改变基准语义。 */
const normalizeRel = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** clip 的时间线结束时刻：有 `track_ed` 直接取，否则由 `track_st + duration` 推得（真机客户端形态）。 */
function clipTrackEd(clip: Record<string, unknown>): number | null {
	if (typeof clip.track_ed === "number") return clip.track_ed;
	if (typeof clip.track_st === "number" && typeof clip.duration === "number") {
		return r3(clip.track_st + clip.duration);
	}
	return null;
}

const TRACK_GROUPS = ["video_track", "audio_track", "beat_track"] as const;
const REF_KEYS = ["material", "html_material"] as const;

/**
 * 扫全工程时间线，产 `materialId → 引用明细[]`。
 * 覆盖 video/audio/beat 三组轨，且同时认 `material` 与 `html_material` 两个键
 * （后者是 MG 颗粒的引用键，只认前者会把 MG 素材全判成孤儿）。
 */
export function collectMaterialRefs(gtrk: Record<string, unknown>): Map<string, MaterialRef[]> {
	const out = new Map<string, MaterialRef[]>();
	for (const group of TRACK_GROUPS) {
		const tracks = gtrk[group];
		if (!Array.isArray(tracks)) continue;
		for (const t of tracks as Record<string, unknown>[]) {
			if (!t || typeof t !== "object") continue;
			const trackIndex = typeof t.track_index === "number" ? t.track_index : null;
			const clips = Array.isArray(t.track_timeline) ? (t.track_timeline as Record<string, unknown>[]) : [];
			for (const c of clips) {
				if (!c || typeof c !== "object") continue;
				for (const key of REF_KEYS) {
					const id = c[key];
					if (typeof id !== "string" || id === "") continue;
					const list = out.get(id) ?? [];
					list.push({
						track: group,
						track_index: trackIndex,
						clip_id: typeof c.clip_id === "string" ? c.clip_id : null,
						track_st: typeof c.track_st === "number" ? c.track_st : null,
						track_ed: clipTrackEd(c),
						key,
					});
					out.set(id, list);
				}
			}
		}
	}
	return out;
}

/**
 * 素材落盘自检（只读）。
 *
 * @param gtrkDir `.gtrk` **文件所在目录**（相对路径的解析基准；传工程根 = 全面误报）。
 * @param exists 存在性谓词，缺省 `existsSync`；单测注入假实现即可脱离文件系统。
 */
export function checkMaterialIntegrity(opts: {
	gtrk: Record<string, unknown>;
	gtrkDir: string;
	exists?: (absPath: string) => boolean;
}): IntegrityReport {
	const exists = opts.exists ?? ((p: string) => existsSync(p));
	const materials = Array.isArray(opts.gtrk.materials) ? (opts.gtrk.materials as Record<string, unknown>[]) : [];
	const refs = collectMaterialRefs(opts.gtrk);

	const counts = { relative: 0, absolute: 0, remote: 0, noPath: 0 };
	const dangling: MissingMaterial[] = [];
	const external: MissingMaterial[] = [];
	const noPathIds: string[] = [];
	let degradedCount = 0;
	let degradedReason = "";

	for (const m of materials) {
		const id = typeof m?.id === "string" ? m.id : "";
		const { kind, path } = classifyMaterialPath(m?.path);
		if (kind === "none") {
			counts.noPath++;
			noPathIds.push(id || "(无 id)");
			continue;
		}
		if (kind === "remote") {
			// 只计数、零网络请求：体检不该有网络开销、计费或签名过期造成的误判
			counts.remote++;
			continue;
		}
		counts[kind]++;
		const resolved = kind === "relative" ? resolve(opts.gtrkDir, normalizeRel(path)) : path;
		let present: boolean;
		try {
			present = exists(resolved);
		} catch (e) {
			// 权限异常 / 路径超长 / 网络盘掉线：查不了 ≠ 不存在，**不算悬空**（避免假阳性），只记降级
			degradedCount++;
			if (!degradedReason) degradedReason = e instanceof Error ? e.message : String(e);
			continue;
		}
		if (present) continue;
		const list = refs.get(id) ?? [];
		const entry: MissingMaterial = {
			id,
			path,
			kind,
			resolved,
			referenced: list.length > 0,
			refCount: list.length,
			refs: list,
		};
		(kind === "relative" ? dangling : external).push(entry);
	}

	// 被引用者在前（严重度顺序），同档按 id 升序（稳定输出，便于逐次比对）
	const bySeverity = (a: MissingMaterial, b: MissingMaterial): number =>
		a.referenced === b.referenced ? a.id.localeCompare(b.id) : a.referenced ? -1 : 1;
	dangling.sort(bySeverity);
	external.sort(bySeverity);

	return {
		checked: materials.length,
		counts,
		dangling,
		danglingReferenced: dangling.filter((d) => d.referenced).length,
		danglingOrphan: dangling.filter((d) => !d.referenced).length,
		external,
		noPathIds,
		...(degradedCount > 0 ? { degraded: { count: degradedCount, reason: degradedReason } } : {}),
	};
}

/** 自检用到的最小日志面（命令层注入 `log`；纯逻辑不直接依赖 IO 模块）。 */
export interface IntegrityLog {
	info: (s: string) => void;
	warn: (s: string) => void;
}

/**
 * 外层兜底版自检（material-integrity-check「自检自身失败 SHALL 降级」）：
 * 自检整体抛错只告警一句并返回 `undefined`，MUST NOT 改命令的 `ok` / 退出码 / 已写回的内容。
 * 逐条 `exists` 的失败已在 `checkMaterialIntegrity` 内降级，本层兜的是它之外的意外。
 */
export function safeCheckMaterialIntegrity(opts: {
	gtrk: Record<string, unknown>;
	gtrkDir: string;
	log: IntegrityLog;
	exists?: (absPath: string) => boolean;
}): IntegrityReport | undefined {
	try {
		return checkMaterialIntegrity({ gtrk: opts.gtrk, gtrkDir: opts.gtrkDir, exists: opts.exists });
	} catch (e) {
		opts.log.warn(
			`素材落盘自检未能完成（${e instanceof Error ? e.message : String(e)}）——写回结果与命令判定不受影响。`,
		);
		return undefined;
	}
}

/** 一行摘要（人读）。零悬空时也发声——体检做过与没做过必须可区分。 */
export function integritySummaryLine(r: IntegrityReport): string {
	if (r.dangling.length === 0) {
		return `素材落盘自检：${r.checked} 条素材全部就位`;
	}
	return (
		`素材落盘自检：${r.checked} 条素材里有 ${r.dangling.length} 条的文件不在盘上` +
		`（被时间线引用 ${r.danglingReferenced} 条 · 孤儿 ${r.danglingOrphan} 条）——只报不动，工程与文件零改动。`
	);
}

/** 一条悬空的人读行。 */
export function missingLine(m: MissingMaterial): string {
	const tag = m.referenced ? "被引用" : "孤儿";
	if (!m.referenced) return `[${tag}] ${m.id} → ${m.path}`;
	const head = m.refs[0]!;
	// 人读区间取三位小数（真机 track_st 常是 42.76833333333333 这种浮点尾巴，刷在日志里没法读）；
	// 机读侧 MUST 保留原值不动——那是时间线上的真实时码。
	const span =
		head.track_st !== null ? ` · ${r3(head.track_st)}→${head.track_ed === null ? "?" : r3(head.track_ed)}s` : "";
	const more = m.refCount > 1 ? ` 等 ${m.refCount} 处` : "";
	return (
		`[${tag}] ${m.id} → ${m.path}` +
		`（${head.track} track_index=${head.track_index ?? "?"} · clip ${head.clip_id ?? "?"}${span}${more}）`
	);
}

/**
 * 人读呈现（摘要 + 逐条清单）。**告知口吻**：悬空多半是历史遗留，本函数不阻断任何事，
 * 措辞 MUST NOT 写成拦截口吻（沿黑底空洞告警的先例）。
 */
export function reportMaterialIntegrity(r: IntegrityReport, log: IntegrityLog): void {
	if (r.degraded) {
		log.warn(
			`素材落盘自检降级：${r.degraded.count} 条素材查不了存在性（${r.degraded.reason}）——` +
				`这几条既不算就位也不算悬空，其余条目照常已查。`,
		);
	}
	if (r.dangling.length === 0) {
		log.info(integritySummaryLine(r));
	} else {
		log.warn(integritySummaryLine(r));
		for (const m of r.dangling.slice(0, INTEGRITY_LIST_CAP)) log.warn(`   ${missingLine(m)}`);
		if (r.dangling.length > INTEGRITY_LIST_CAP) {
			log.warn(`   …等共 ${r.dangling.length} 条（全量见 --json 的 integrity.dangling）`);
		}
		log.info(
			"被引用的悬空 = 时间线上那一段没有素材可放（客户端可能 relink 回落到别的素材）；孤儿 = 只在 materials 里挂着、不影响画面。",
		);
		log.info(
			"悬空多半是历史遗留（如客户端「确认原片」下载中断）；CLI 只报不删，要修就在客户端重新确认原片、或删掉那条 clip。",
		);
	}
	if (r.external.length > 0) {
		log.warn(
			`另有 ${r.external.length} 条**绝对路径**素材当前找不到文件（外接盘/网络盘没挂载也会这样，不计入上面的悬空）：` +
				r.external.slice(0, INTEGRITY_LIST_CAP).map((m) => `${m.id} → ${m.path}`).join("；") +
				(r.external.length > INTEGRITY_LIST_CAP ? ` …等共 ${r.external.length} 条` : ""),
		);
	}
	if (r.noPathIds.length > 0) {
		log.warn(
			`另有 ${r.noPathIds.length} 条素材没有 path（结构问题，非落盘问题）：` +
				r.noPathIds.slice(0, INTEGRITY_LIST_CAP).join("、") +
				(r.noPathIds.length > INTEGRITY_LIST_CAP ? ` …等共 ${r.noPathIds.length} 条` : ""),
		);
	}
}
