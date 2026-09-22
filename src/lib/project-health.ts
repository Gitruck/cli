/**
 * 工程体检（openspec: add-project-health-check）——把散落在各命令里的自检集中成一份报告。
 *
 * ## 立题
 *
 * 交付前要查的是固定那几样：clip 数对不对、有没有缝、恒等式违不违例、素材缺不缺、
 * 顶层 `duration` 够不够。**这些工具内部已经在算**——`patch` 的写方自检会报存量不变量违例、
 * `mg` 的素材落盘自检会报素材就位数——**但没有一个命令是专门干这个的**。
 * 2026-09-20 交付前是靠 `gtrk patch set --total max --dry-run` 的**副作用**拿到写方自检结果，
 * 再自己写 Python 数 clip 与缝。靠副作用做验收，既不可靠也不可教。
 *
 * ## 铁律：复用，MUST NOT 另写判据
 *
 * 结构级走 `gtrk-invariants.collectWriteViolations`、素材级走 `material-integrity.checkMaterialIntegrity`
 * ——与写回时**同一份实现**。判据一旦分叉，「体检说没事、写回时报违例」就会成为常态，
 * 那比没有体检更坏。本文件只负责**编排与分档**，不含任何新的结构判据。
 *
 * 轨级的缝隙/时码范围是本文件自己算的——那不是「判据」，是**读数**：它不判对错，
 * 只把事实摆出来（缝隙可以是有意的，见退出码分档）。
 */

import { r3, sec2ms } from "./frame-domain";
import { collectWriteViolations, type WriteViolation } from "./gtrk-invariants";

/** 小于这么多毫秒的缝不算缝：帧量化的亚毫秒残差不是「工程有洞」。 */
const GAP_MIN_MS = 2;

/** 标准帧率白名单。非标不判错、只告警——客户端能导什么帧率不由本仓说了算。 */
const STANDARD_RATES = [24, 25, 30, 50, 60] as const;

export type HealthLevel = "ok" | "warn" | "fail";

export interface HealthFinding {
	/** 检查项标识（机读）。 */
	code: string;
	level: HealthLevel;
	/** 人读一行。 */
	message: string;
	/** 明细（逐条位置等）；无则省略。 */
	detail?: unknown;
}

export interface TrackHealth {
	track: string;
	clips: number;
	track_st: number | null;
	track_ed: number | null;
	gaps: Array<{ after: string; st: number; ed: number; gap: number }>;
	overlaps: Array<{ a: string; b: string; overlap: number }>;
	/**
	 * 这条轨**是否本该连续**。只有**视觉底轨**（号最小的 video 轨）是——它是画面的铺底，
	 * 那里缺一段就是真的黑帧。
	 *
	 * ⚠️ 其余轨 MUST NOT 按缝隙告警：叠加轨、MG/颗粒轨（beat 轨）**天生稀疏**——
	 * 真机上一条 543 秒的片子，beat 轨 12 颗颗粒之间有 11 处「缝」、最长 122 秒，
	 * 那是正常形态而不是洞。把它们一起报出来，这条告警就变成噪声
	 * （同一条教训见 `mg-coverage`：MG 的判据是最长空档占比，不是有没有空档）。
	 */
	continuous: boolean;
}

export interface HealthReport {
	ok: boolean;
	/** 有阻断级问题（退出码非 0 的唯一依据）。 */
	blocking: boolean;
	tracks: TrackHealth[];
	findings: HealthFinding[];
	project: { duration: number | null; video_rate: number | null; timeline_ed: number | null };
}

type Obj = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 轨上的片段（`track_timeline` 里的对象元素，与 `gtrk-invariants` 同义）。 */
function clipsOf(track: Obj): Obj[] {
	return (Array.isArray(track.track_timeline) ? (track.track_timeline as unknown[]) : []).filter(
		(c): c is Obj => typeof c === "object" && c !== null && !Array.isArray(c),
	);
}

/** 一条轨的读数：clip 数、时码范围、缝、重叠。 */
export function trackHealth(label: string, track: Obj, continuous = false): TrackHealth {
	const clips = clipsOf(track)
		.map((c) => ({
			id: String(c.clip_id ?? "?"),
			st: num(c.track_st) ?? 0,
			ed: num(c.track_ed) ?? (num(c.track_st) ?? 0) + (num(c.duration) ?? 0),
		}))
		.sort((a, b) => a.st - b.st);
	const gaps: TrackHealth["gaps"] = [];
	const overlaps: TrackHealth["overlaps"] = [];
	for (let i = 0; i < clips.length - 1; i++) {
		const d = sec2ms(clips[i + 1].st) - sec2ms(clips[i].ed);
		if (d > GAP_MIN_MS) {
			gaps.push({ after: clips[i].id, st: r3(clips[i].ed), ed: r3(clips[i + 1].st), gap: r3(d / 1000) });
		} else if (d < -GAP_MIN_MS) {
			overlaps.push({ a: clips[i].id, b: clips[i + 1].id, overlap: r3(-d / 1000) });
		}
	}
	return {
		track: label,
		clips: clips.length,
		track_st: clips.length ? r3(clips[0].st) : null,
		track_ed: clips.length ? r3(Math.max(...clips.map((c) => c.ed))) : null,
		gaps,
		overlaps,
		continuous,
	};
}

export interface MaterialProbe {
	/** 素材总数。 */
	total: number;
	/**
	 * **主判缺失**：相对路径解析后文件不存在。工程自带的素材少一个就是空片段，阻断级。
	 * 对应 `IntegrityReport.dangling`。
	 */
	missing: Array<{ id: string; path: string }>;
	/**
	 * 绝对路径缺失——**另一档，只告警**。外接盘 / 网络盘没挂载是常态，
	 * 混进主判必然假阳性（`material-integrity` 分这两档的理由，本文件照搬，MUST NOT 合并）。
	 */
	external: Array<{ id: string; path: string }>;
	/** 查不了（权限/网络盘掉线）——**不算缺失**，只记降级。 */
	degraded: number;
}

/**
 * 把各层结果编排成报告 + 分档。
 *
 * 分档口径（tasks 0.1 拍板）：
 *  · **阻断级**（退出码非 0）= 素材缺失 + 结构级不变量违例（含同轨重叠）
 *  · **告警级**（退出码 0）= 缝隙、非标准帧率、顶层 duration 短于全轨末端
 *
 * 为什么缝隙只告警：缝可以是有意的（一拍真的少了镜头，盖住比报出来更坏），
 * 而且**一旦缝隙让退出码非 0，调用方就会为了让脚本继续而整个忽略体检**——
 * 那等于把所有检查项一起废掉。
 */
export function buildHealthReport(input: {
	gtrk: Obj;
	tracks: TrackHealth[];
	materials: MaterialProbe;
	/** 结构级违例；由调用方传 `collectWriteViolations` 的结果（MUST NOT 在本文件另算）。 */
	violations: readonly WriteViolation[];
}): HealthReport {
	const findings: HealthFinding[] = [];
	const { gtrk, tracks, materials, violations } = input;

	// ── 结构级（复用写方自检）
	if (violations.length) {
		findings.push({
			code: "invariant_violation",
			level: "fail",
			message: `时码恒等式 / 源窗违例 ${violations.length} 条——写回时会被同一道闸拒绝`,
			detail: violations,
		});
	} else {
		findings.push({ code: "invariant_violation", level: "ok", message: "时码恒等式与源窗全部通过" });
	}

	// ── 素材级
	if (materials.missing.length) {
		findings.push({
			code: "material_missing",
			level: "fail",
			message: `${materials.missing.length} 条素材不在盘上——导进客户端会是空片段`,
			detail: materials.missing,
		});
	} else {
		findings.push({
			code: "material_missing",
			level: "ok",
			message:
				`${materials.total} 条素材全部就位` +
				(materials.degraded ? `（另有 ${materials.degraded} 条查不了，按「不算缺失」处置）` : ""),
		});
	}
	if (materials.external.length) {
		findings.push({
			code: "material_external",
			level: "warn",
			message: `${materials.external.length} 条**绝对路径**素材不在盘上——外接盘/网络盘没挂载是常态，故只告警不阻断`,
			detail: materials.external,
		});
	}

	// ── 轨级：重叠算阻断（它是不变量问题的一种表现），缝隙只告警
	const overlaps = tracks.flatMap((t) => t.overlaps.map((o) => ({ track: t.track, ...o })));
	if (overlaps.length) {
		findings.push({ code: "track_overlap", level: "fail", message: `同轨重叠 ${overlaps.length} 处`, detail: overlaps });
	}
	// 缝隙只在**该连续的轨**上算问题。叠加轨与 MG/颗粒轨天生稀疏，一并报会把这条告警变成噪声。
	const bed = tracks.filter((t) => t.continuous);
	const gaps = bed.flatMap((t) => t.gaps.map((g) => ({ track: t.track, ...g })));
	if (gaps.length) {
		const worst = gaps.reduce((a, b) => (b.gap > a.gap ? b : a));
		findings.push({
			code: "track_gap",
			level: "warn",
			message: `视觉底轨有 ${gaps.length} 处缝隙，最长 ${worst.gap}s（${worst.track} 的 ${worst.st}–${worst.ed}s）——成片里会闪黑；跑 gtrk patch seal 可补平`,
			detail: gaps,
		});
	} else if (bed.length) {
		findings.push({ code: "track_gap", level: "ok", message: `视觉底轨（${bed.map((t) => t.track).join("、")}）零缝隙` });
	}

	// ── 工程级
	const rate = num(gtrk.video_rate);
	if (rate === null || !(rate > 0)) {
		findings.push({ code: "video_rate", level: "fail", message: "顶层 video_rate 缺席或非正——帧域命令会直接报错退出" });
	} else if (!STANDARD_RATES.includes(rate as (typeof STANDARD_RATES)[number])) {
		findings.push({ code: "video_rate", level: "warn", message: `video_rate=${rate} 不在标准帧率里（${STANDARD_RATES.join("/")}）` });
	} else {
		findings.push({ code: "video_rate", level: "ok", message: `video_rate=${rate}` });
	}

	const timelineEd = tracks.reduce<number | null>((acc, t) => (t.track_ed === null ? acc : Math.max(acc ?? 0, t.track_ed)), null);
	const duration = num(gtrk.duration);
	if (duration !== null && timelineEd !== null && sec2ms(duration) < sec2ms(timelineEd) - GAP_MIN_MS) {
		findings.push({
			code: "duration_short",
			level: "warn",
			message: `顶层 duration ${r3(duration)}s 短于全轨末端 ${r3(timelineEd)}s——末尾 ${r3(timelineEd - duration)}s 可能不出片`,
		});
	} else if (duration !== null) {
		findings.push({ code: "duration_short", level: "ok", message: `顶层 duration ${r3(duration)}s 覆盖全轨末端` });
	}

	const blocking = findings.some((f) => f.level === "fail");
	return {
		ok: !blocking,
		blocking,
		tracks,
		findings,
		project: { duration, video_rate: rate, timeline_ed: timelineEd },
	};
}
