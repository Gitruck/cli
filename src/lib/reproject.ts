/**
 * 重投影共享叶子（add-consume-side-reprojection）——「span → 存活实例包络」的**唯一**实现。
 *
 * 立题：`split/dispatch.json` 里的 `track_st/track_ed` 是**投影那一刻的快照**；用户在 `gtrk split` 之后
 * 继续微调口播主轨是**常态**，消费方（`gtrk mg` / `gtrk matrix`）必须在用这些时码做任何事之前，
 * 以「当刻 `transcript` × 当刻 `.gtrk`」重算窗口。
 *
 * 口径（★ 2026-07-26 拍板取 ②a）：
 *   - 输入**恒为** `transcript` × 当刻 `.gtrk`，内部 **MUST** 调 `projectTranscript`（同一段代码）。
 *   - **MUST NOT** 读 `struct_meta.split.beats[].source_ranges` 求交——那是与 split 落地**不同源**的
 *     另一条推导路径（源包络含被剪词，尾部会被夹到 clip 边界，真机末尾 beat 差 6.800s）。
 *     它也 **MUST NOT** 充当「transcript 缺失」时的中间降级档：降级链**无中间档**。
 *   - `buildLanding`（split 落地）与消费侧走**同一份** `buildSpanIndex` / `envelopeForSpan`：
 *     两侧相等是「同一段代码 × 同一份输入」的**构造性保证**，不靠两处对齐维护。
 *
 * 降级（★ D6 拍板取 ①a「门内吞掉」）：读不出工程 / transcript / 主轨零命中素材 → **不抛错**，
 * 记降级、回退派单快照时码；既有失败面一动不动（非 v1 的 `assertGtrkV1` 仍在调用方原位置抛）。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	countMainTrackMaterialClips,
	projectTranscript,
	type GtrkProject,
	type ProjectionView,
	type Transcript,
} from "./projection";
import { log } from "./log";

export interface ReprojectSpan {
	from: string;
	to: string;
}

// ── 纯逻辑层：span → 存活包络（split 落地与消费侧共用）──────────────────────

interface SurvivingInstance {
	track_st: number;
	track_ed: number;
}

/** 存活实例索引：`utterance id → 该 id 的存活投影实例`（无实例 = 该 id 被全剪）。 */
export interface SpanIndex {
	utteranceIds: string[];
	byId: Map<string, SurvivingInstance[]>;
	idIndex: Map<string, number>;
}

/** span 包络结果三态：落轨 / 全剪 / span 端点在当刻 transcript 里查不到。 */
export type SpanOutcome =
	| { kind: "ok"; track_st: number; track_ed: number; shrunk: boolean; kept: number; dropped: number }
	| { kind: "dropped" }
	| { kind: "unresolved" };

/** 由投影视图 + 文稿 id 序建存活实例索引（口径同 `buildLanding`，**唯一实现**）。 */
export function buildSpanIndex(view: ProjectionView, utteranceIds: string[]): SpanIndex {
	const byId = new Map<string, SurvivingInstance[]>();
	for (const id of utteranceIds) byId.set(id, []);
	for (const u of view.utterances) {
		if (u.dropped || u.track_st == null || u.track_ed == null) continue;
		if (!byId.has(u.id)) byId.set(u.id, []);
		byId.get(u.id)!.push({ track_st: u.track_st, track_ed: u.track_ed });
	}
	const idIndex = new Map<string, number>();
	utteranceIds.forEach((id, i) => idIndex.set(id, i));
	return { utteranceIds, byId, idIndex };
}

/**
 * span（utterance 区间）→ 存活实例包络。**唯一实现**：split 落地与消费侧重投影共用这一份。
 * 全剪 → `dropped`（调用方 skip，MUST NOT 回落快照时码）；部分剪 → `shrunk:true` 并按存活包络收缩。
 */
export function envelopeForSpan(index: SpanIndex, span: ReprojectSpan): SpanOutcome {
	const fromIdx = index.idIndex.get(span.from);
	const toIdx = index.idIndex.get(span.to);
	if (fromIdx === undefined || toIdx === undefined) return { kind: "unresolved" };
	const spanIds = index.utteranceIds.slice(fromIdx, toIdx + 1);
	const instances = spanIds.flatMap((id) => index.byId.get(id) ?? []);
	if (instances.length === 0) return { kind: "dropped" };
	const droppedCount = spanIds.filter((id) => (index.byId.get(id)?.length ?? 0) === 0).length;
	return {
		kind: "ok",
		track_st: Math.min(...instances.map((x) => x.track_st)),
		track_ed: Math.max(...instances.map((x) => x.track_ed)),
		shrunk: droppedCount > 0,
		kept: spanIds.length - droppedCount,
		dropped: droppedCount,
	};
}

// ── 消费侧：定位 / 读盘 / 降级 ─────────────────────────────────────────────

/** transcript 候选路径（与 `src/commands/split.ts` 的 `resolvePaths` 同序，改一处要同步另一处）。 */
export function transcriptCandidates(baseDir: string): string[] {
	return [
		join(baseDir, "transcript", "transcript.json"),
		join(baseDir, "json", "transcript.json"),
		join(baseDir, "transcript.json"),
	];
}

/** 整体降级原因（枚举即降级矩阵的「情形」列）。 */
export type DegradeReason =
	| "no_project"
	| "gtrk_unreadable"
	| "project_not_v1"
	| "transcript_missing"
	| "transcript_unreadable"
	| "no_material_clip";

const DEGRADE_TEXT: Record<DegradeReason, string> = {
	no_project: "定位不到工程文件（.gtrk）",
	gtrk_unreadable: "工程文件读不出来（JSON 不可解析）",
	project_not_v1: "工程不是 v1（重投影不介入，版本门行为不变）",
	transcript_missing: "找不到 transcript.json",
	transcript_unreadable: "transcript.json 读不出来或结构异常",
	no_material_clip: "当刻主轨查不到命中口播素材（material_id）的 clip",
};

/** 逐条降级原因。 */
export type EntryDegradeReason = "no_span" | "span_unresolved";

const ENTRY_DEGRADE_TEXT: Record<EntryDegradeReason, string> = {
	no_span: "派单条目无 span，且 struct_meta.split 里也定位不到（老档 + 工程账本对不上）",
	span_unresolved: "span 端点在当刻 transcript 里不存在（transcript 被换过）",
};

/** 待重投影的一条派单条目（快照时码随行，作降级回退值）。 */
export interface ReprojectEntryInput {
	/** 稳定标识：MG 用 composition_id，B-roll/AI 用 beat id。 */
	key: string;
	/** 人读 beat 名（告警用）。 */
	beat: string;
	/** MG 条目的 composition_id（老档回落定位 MUST 按它，而非 `beat` 字段——aux 的 `beat` 记的是主 beat id）。 */
	compositionId?: string;
	/** dispatch 自带的 span（优先级 ①）。 */
	span?: ReprojectSpan;
	/** 派单快照时码（降级回退值）。 */
	track_st: number;
	track_ed: number;
}

export interface ReprojectEntryOutcome {
	key: string;
	beat: string;
	/** 本次采用的窗口（重投影值或快照回退值）。 */
	track_st: number;
	track_ed: number;
	source: "reprojected" | "dispatch_snapshot";
	/** 与派单快照相比是否漂移。 */
	drifted: boolean;
	/** 漂移量 = max(|Δst|, |Δed|)。 */
	offset: number;
	shrunk: boolean;
	/** 重投影后零存活：调用方 MUST skip，MUST NOT 回落快照时码。 */
	dropped: boolean;
	degradeReason?: EntryDegradeReason;
}

export interface ReprojectSummary {
	mode: "reprojected" | "dispatch_snapshot";
	degraded: boolean;
	reason?: DegradeReason;
	reason_text?: string;
	projected_at: string | null;
	total: number;
	reprojected: number;
	drifted: number;
	max_offset: number;
	shrunk: string[];
	dropped: string[];
	degraded_entries: { beat: string; reason: EntryDegradeReason; text: string }[];
}

export interface ReprojectResult {
	summary: ReprojectSummary;
	entries: ReprojectEntryOutcome[];
	/** key → 本次采用窗口（调用方按 key 查表换时码）。 */
	windows: Map<string, { track_st: number; track_ed: number }>;
}

export interface ReprojectRequest {
	/** 产物基目录（定位 transcript.json）。 */
	baseDir: string;
	/** 已读入的当刻工程；undefined = 定位不到（`gtrkUnreadable` 区分「读失败」）。 */
	gtrk?: Record<string, unknown>;
	/** ①a 门内吞掉：调用方读 `.gtrk` 抛错时置 true（本叶子不自己读工程，避免读两遍口径不一）。 */
	gtrkUnreadable?: boolean;
	entries: ReprojectEntryInput[];
	/** 注入时间戳（测试可复现）。 */
	now?: string;
}

/** 3 位小数（与投影层 r3 同式）。 */
function r3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

/** 工程 slug（与 split.ts / matrix.ts 同式：保留 CJK，分隔符折叠为 -）。 */
function slugify(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	return s || "project";
}

interface LooseSplitBeat {
	id?: unknown;
	span?: unknown;
}

/** 从当刻 `.gtrk` 的 `struct_meta.split` 建「beat id → span」回落表（优先级 ②）。 */
export function splitSpanIndex(gtrk: Record<string, unknown> | undefined): Map<string, ReprojectSpan> {
	const out = new Map<string, ReprojectSpan>();
	const split = (gtrk?.struct_meta as Record<string, unknown> | undefined)?.split as
		| { beats?: LooseSplitBeat[] }
		| undefined;
	for (const b of split?.beats ?? []) {
		const span = b?.span as { from?: unknown; to?: unknown } | undefined;
		if (typeof b?.id !== "string" || typeof span?.from !== "string" || typeof span?.to !== "string") continue;
		out.set(b.id, { from: span.from, to: span.to });
	}
	return out;
}

/**
 * 老档回落定位：由 `composition_id` 反解 `struct_meta.split.beats[].id`。
 *
 * **MUST NOT 用 dispatch 条目的 `beat` 字段**：aux 派生颗粒的 `beat` 记的是**主 beat id**
 * （`splitdoc.ts` 的 aux 派单处），而它在 `struct_meta.split.beats[]` 里的 id 是 `<beatId>-aux<n>`——
 * 按 `beat` 回查会把 aux 的窗口错算成主 beat 的整段窗口（aux 的 mount 可以是子区间）。
 */
export function beatIdForComposition(
	compositionId: string,
	projectSlug: string,
	knownIds: Iterable<string>,
): string | undefined {
	const prefix = `${projectSlug}-`;
	const ids = [...knownIds];
	if (compositionId.startsWith(prefix)) {
		const stripped = compositionId.slice(prefix.length);
		if (ids.includes(stripped)) return stripped;
	}
	// slug 与目录名不一致（工程被改名 / --dispatch 指到别处）时的兜底：取最长的后缀匹配
	let best: string | undefined;
	for (const id of ids) {
		if (!compositionId.endsWith(`-${id}`)) continue;
		if (best === undefined || id.length > best.length) best = id;
	}
	return best;
}

function loadTranscriptShape(raw: string): Transcript | undefined {
	let t: unknown;
	try {
		t = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const c = t as Transcript | null;
	if (!c || !Array.isArray(c.utterances) || typeof c.material_id !== "string") return undefined;
	return c;
}

/** 整体降级：全部条目回退快照时码。 */
function degradeAll(entries: ReprojectEntryInput[], reason: DegradeReason): ReprojectResult {
	const outcomes: ReprojectEntryOutcome[] = entries.map((e) => ({
		key: e.key,
		beat: e.beat,
		track_st: e.track_st,
		track_ed: e.track_ed,
		source: "dispatch_snapshot",
		drifted: false,
		offset: 0,
		shrunk: false,
		dropped: false,
	}));
	return {
		summary: {
			mode: "dispatch_snapshot",
			degraded: true,
			reason,
			reason_text: DEGRADE_TEXT[reason],
			projected_at: null,
			total: entries.length,
			reprojected: 0,
			drifted: 0,
			max_offset: 0,
			shrunk: [],
			dropped: [],
			degraded_entries: [],
		},
		entries: outcomes,
		windows: new Map(outcomes.map((o) => [o.key, { track_st: o.track_st, track_ed: o.track_ed }])),
	};
}

/**
 * 消费侧现场重投影（唯一入口）。**恒执行**，MUST NOT 由任何「要不要重算」的条件门收窄
 * （mtime / projected_at / transcript_hash / 跨文件比对三类判据均已实测证伪或构造性失效）。
 */
export async function reprojectDispatchWindows(req: ReprojectRequest): Promise<ReprojectResult> {
	const { baseDir, entries } = req;

	// ── ①a 门内吞掉：工程侧读不出来 = 无法重投影 → 整体降级（既有失败面由调用方原位置负责）──
	if (req.gtrkUnreadable) return degradeAll(entries, "gtrk_unreadable");
	if (!req.gtrk) return degradeAll(entries, "no_project");
	if (req.gtrk.version !== "v1") return degradeAll(entries, "project_not_v1");

	const transcriptPath = transcriptCandidates(baseDir).find((p) => existsSync(p));
	if (!transcriptPath) return degradeAll(entries, "transcript_missing");
	let transcript: Transcript | undefined;
	try {
		transcript = loadTranscriptShape(await readFile(transcriptPath, "utf8"));
	} catch {
		transcript = undefined;
	}
	if (!transcript) return degradeAll(entries, "transcript_unreadable");

	const gtrkProject = req.gtrk as unknown as GtrkProject;
	if (countMainTrackMaterialClips(gtrkProject, transcript.material_id) === 0) {
		return degradeAll(entries, "no_material_clip");
	}

	// ── 现场重投影：transcript × 当刻 .gtrk，同一段代码（projectTranscript）──
	const projectedAt = req.now ?? new Date().toISOString();
	const view = projectTranscript(transcript, gtrkProject, { projectedAt });
	const index = buildSpanIndex(
		view,
		transcript.utterances.map((u) => u.id),
	);

	// span 回落表（优先级 ②）：dispatch 老档没有 span 时按 struct_meta.split 定位
	const fallback = splitSpanIndex(req.gtrk);
	const projectSlug = slugify(basename(baseDir));

	const outcomes: ReprojectEntryOutcome[] = [];
	const shrunk: string[] = [];
	const dropped: string[] = [];
	const degradedEntries: { beat: string; reason: EntryDegradeReason; text: string }[] = [];
	let drifted = 0;
	let maxOffset = 0;
	let reprojected = 0;

	for (const e of entries) {
		let span = e.span;
		if (!span) {
			const bid = e.compositionId
				? beatIdForComposition(e.compositionId, projectSlug, fallback.keys())
				: e.beat;
			span = bid ? fallback.get(bid) : undefined;
		}
		if (!span) {
			outcomes.push({
				key: e.key,
				beat: e.beat,
				track_st: e.track_st,
				track_ed: e.track_ed,
				source: "dispatch_snapshot",
				drifted: false,
				offset: 0,
				shrunk: false,
				dropped: false,
				degradeReason: "no_span",
			});
			degradedEntries.push({ beat: e.beat, reason: "no_span", text: ENTRY_DEGRADE_TEXT.no_span });
			continue;
		}
		const env = envelopeForSpan(index, span);
		if (env.kind === "unresolved") {
			outcomes.push({
				key: e.key,
				beat: e.beat,
				track_st: e.track_st,
				track_ed: e.track_ed,
				source: "dispatch_snapshot",
				drifted: false,
				offset: 0,
				shrunk: false,
				dropped: false,
				degradeReason: "span_unresolved",
			});
			degradedEntries.push({ beat: e.beat, reason: "span_unresolved", text: ENTRY_DEGRADE_TEXT.span_unresolved });
			continue;
		}
		if (env.kind === "dropped") {
			// 零存活：MUST NOT 回落快照时码（那段已不在成片里，铺上去必然错位）
			reprojected += 1;
			dropped.push(e.beat);
			outcomes.push({
				key: e.key,
				beat: e.beat,
				track_st: e.track_st,
				track_ed: e.track_ed,
				source: "reprojected",
				drifted: false,
				offset: 0,
				shrunk: false,
				dropped: true,
			});
			continue;
		}
		reprojected += 1;
		const offset = r3(Math.max(Math.abs(env.track_st - e.track_st), Math.abs(env.track_ed - e.track_ed)));
		const isDrifted = offset > 0;
		if (isDrifted) {
			drifted += 1;
			maxOffset = Math.max(maxOffset, offset);
		}
		if (env.shrunk) shrunk.push(e.beat);
		outcomes.push({
			key: e.key,
			beat: e.beat,
			track_st: env.track_st,
			track_ed: env.track_ed,
			source: "reprojected",
			drifted: isDrifted,
			offset,
			shrunk: env.shrunk,
			dropped: false,
		});
	}

	return {
		summary: {
			mode: "reprojected",
			degraded: degradedEntries.length > 0,
			projected_at: projectedAt,
			total: entries.length,
			reprojected,
			drifted,
			max_offset: r3(maxOffset),
			shrunk,
			dropped,
			degraded_entries: degradedEntries,
		},
		entries: outcomes,
		windows: new Map(outcomes.map((o) => [o.key, { track_st: o.track_st, track_ed: o.track_ed }])),
	};
}

/**
 * 重投影摘要与告警（`consume-side-reprojection`「MUST NOT 静默」）——**mg 与 matrix 共用这一份**
 * （实现与话术都别写两遍）。
 *
 * ② 的固有风险是「自动改对了、也可能自动改错了，而用户看不见」——摘要是这条风险的唯一对冲：
 * 零漂移也留一行（MUST NOT 完全静默），有漂移则报条数与最大偏移；逐 beat 明细只在异常时出（MUST NOT 刷屏）。
 */
export function reportReprojection(reproj: ReprojectResult): void {
	const s = reproj.summary;
	if (s.mode === "dispatch_snapshot") {
		log.warn(reprojectSummaryLine(s));
		log.warn(`正在用**可能已过期**的派单快照时码继续。${reprojectRecoveryHint(s.reason!)}`);
		return;
	}
	log.step(`▶ ${reprojectSummaryLine(s)}`);
	for (const d of s.degraded_entries) log.warn(`${d.beat}：无法重投影（${d.text}），本条回退派单快照时码`);
	for (const b of s.shrunk) log.warn(`${b}：span 内有句被剪，已按存活包络收缩（建议人工复核）`);
	for (const b of s.dropped) log.warn(`${b}：重投影后零存活（整段已被剪出成片），本条跳过——不按快照时码铺回去`);
}

/**
 * 把本次落轨时码来源写进消费方自己的账本（`struct_meta.mg` / `struct_meta.broll`）。
 * 纯追加、可选字段；不识别的旧消费方与客户端白名单式解析天然忽略。
 * 刻意不改 `mg-lay.ts` / `matrix-lay.ts`（那是另两个活跃 change 的地盘），只在命令层补字段。
 *
 * 本函数只负责**登记**；据此判断已铺产物是否失效并告警**不属于本能力**
 * （判据须以已铺 clip 的实际时码为准，不得以本账本记录为准——账本与画面可能各自为真）。
 */
export function withTimecodeSource(
	next: Record<string, unknown>,
	key: "mg" | "broll",
	reproj: ReprojectResult,
): Record<string, unknown> {
	const structMeta = (next.struct_meta as Record<string, unknown> | undefined) ?? {};
	const ledger = structMeta[key] as Record<string, unknown> | undefined;
	if (!ledger) return next;
	return {
		...next,
		struct_meta: {
			...structMeta,
			[key]: {
				...ledger,
				timecode_source: reproj.summary.mode === "reprojected" ? "reprojected" : "dispatch_snapshot",
				...(reproj.summary.projected_at ? { reprojected_at: reproj.summary.projected_at } : {}),
				...(reproj.summary.reason ? { timecode_degrade_reason: reproj.summary.reason } : {}),
			},
		},
	};
}

/** 一行重投影摘要（人读日志用；MUST NOT 静默、也 MUST NOT 逐 beat 刷屏）。 */
export function reprojectSummaryLine(s: ReprojectSummary): string {
	if (s.mode === "dispatch_snapshot") {
		return `重投影降级：按派单快照时码铺 ${s.total} 个条目（原因：${s.reason_text ?? s.reason}）——快照可能已过期`;
	}
	const bits = [`重投影 ${s.reprojected} 个 beat`, `漂移 ${s.drifted} 条`];
	if (s.drifted > 0) bits.push(`最大偏移 ${s.max_offset}s`);
	if (s.shrunk.length) bits.push(`收缩 ${s.shrunk.length} 条`);
	if (s.dropped.length) bits.push(`整段被剪跳过 ${s.dropped.length} 条`);
	if (s.degraded_entries.length) bits.push(`逐条降级 ${s.degraded_entries.length} 条`);
	return bits.join(" · ");
}

/** 降级复原路径（告警第二行；给可直接照做的出路）。 */
export function reprojectRecoveryHint(reason: DegradeReason): string {
	switch (reason) {
		case "transcript_missing":
		case "transcript_unreadable":
			return "复原：把 transcript.json 补回产物目录（transcript/ 或 json/ 下），或用新版 gtrk oralcut 重出产物后重跑本命令。";
		case "no_project":
		case "gtrk_unreadable":
			return "复原：把工程放回 <产物目录>/gtrk/project.gtrk（或用 --project 指到工程所在的产物目录）后重跑本命令。";
		case "project_not_v1":
			return "复原：用新链路重产 v1 工程后重跑本命令。";
		case "no_material_clip":
			return "复原：确认口播主轨还在、且 relink 没换掉素材 id；拿另一个工程的 dispatch 来跑也会命中本情形。";
	}
}
