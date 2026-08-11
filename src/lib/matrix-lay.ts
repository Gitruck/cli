/**
 * matrix 候选铺轨纯逻辑（matrix-lay-tracks spec，add-matrix-smart-fill 平铺版）。
 *
 * 核心语义（主理人 2026-07-10 对齐）：**一个 FILM_BROLL beat 区间由多颗粒平铺占满**，
 * 填哪几颗、各自起止由算法决定。吸收主理人旧方案思想（词锚定/置信度阈值/低于阈值不采纳），
 * 映射到 segments 底座：
 *   - 取材单元 = (clip, segment) 对（候选全部命中段，segment.score 降序）；
 *   - 槽位按 query 叙事序轮转（拆分稿 query 顺序 = beat 的叙事子意象序）；
 *   - score < 地板不采纳 → 槽位留空（优于硬塞）——留空处露什么取决于黑底垫轨：默认铺黑底时
 *     露的是**黑底垫轨**，仅 `--no-black-bed` / 该 beat 未铺黑底时才露主轨 A-roll；
 *   - 紧邻槽位不同 clip；(clip,segment) 对跨轨不复用（轨 2 = 真正差异化方案）；
 *   - excluded_hint（note 命中派单负词）不进自动填充，人工面板仍可选。
 * 素材 = 已下载落地的 preview 代理（契约铁律「无 url 素材态」，url 只活在 struct_meta.broll）。
 *
 * 幂等剥旧的判据 = **自产指纹**（fix-matrix-strip-identity；不再单认位置号）：
 *   - 自产素材恒为 `broll-`/`ex-solid-` 前缀；
 *   - 一条现存轨可剥 ⟺ L1 内容自产（每颗 clip 的 material 都带自产前缀）∧ L2 与盘上
 *     `struct_meta.broll` 复算出的某条**期望指纹条数吻合**（★ 中档：只比 clip 数，不比 material id
 *     逐条恒等、不比窗口时码、不引入 ε）；匹配按「与任一条期望吻合」判，**不要求轨号相等**
 *     （客户端保存会把 overlay 轨整体重编号，号是显示层排序结果、不是身份）。
 *   - 优先条款：轨上有任一 `broll-raw-*` clip（用户点过「确认原片」）⇒ 直接算**已编辑**，
 *     先于 L1/L2 与混合轨归属——剥它会删光 raw 素材登记、盘上已下载原片就地成孤儿。
 *   - 「自产内容但已被编辑」⇒ 保留 + **本次整体不铺**（工程零改动）+ 逐轨告警，
 *     逃生门 `--force-relay`（opts.forceRelay）才按旧语义强剥。
 *   - `track_index`/`lay_tracks` 降级为**辅助信号**：只用于多轨同时吻合时排歧义、
 *     以及「号在册但内容对不上 → 疑似我们的轨被改过 → 拒铺」，MUST NOT 反推成「在册即可删」。
 * 剥离时对仍被保留轨引用的素材有零引用保护，故合并写回按 id 去重。
 *
 * 黑底垫轨（add-matrix-black-bed-track）：在全部候选轨之下、口播主轨之上铺一条纯黑 image 轨，
 * 时窗按**已落成候选轨的 beat 包络整条**（主理人 2026-07-25 拍板，非槽位并集）——B-roll 期间
 * 恒不漏出底下的 A-roll 口播。默认开，`--no-black-bed` 关。
 */
import type { BrollPlan, PlanBeat, PlanResult } from "./matrix";
import {
	BLACK_BED_HEX,
	SOLID_MATERIAL_PREFIX,
	isLayoutableCanvas,
	solidMaterialId,
	solidRelPath,
} from "./solid-png";

export const BROLL_PREVIEW_DIR = "assets/broll-preview";
/** 本地素材封面目录（工程内相对路径；铺轨时 ffmpeg 现抽 best 帧落此，add-matrix-local-search 4.2）。 */
export const BROLL_COVER_DIR = "assets/broll-cover";
export const BROLL_MATERIAL_PREFIX = "broll-";
/**
 * 客户端「确认原片」后把 clip 的 material 切成的前缀（`broll-` 的子集，见姊妹仓
 * `broll-actions.ts:460-464`）。CLI 自己从不写它——它出现即证明用户在客户端做过确认动作。
 */
export const BROLL_RAW_MATERIAL_PREFIX = "broll-raw-";
/**
 * 本地素材身份前缀（add-matrix-local-search D6）：material id = `broll-local-<blake3-16>`
 * （文件内容 blake3 前 16 hex，改名/移动不变身份）。以 `broll-` 开头 ⇒ 既有 L1 剥旧判据、
 * 垫片保护与零引用保护**天然覆盖**（spec 硬性：MUST NOT 为它引入与 `broll-` 不同的剥旧分支）；
 * 不以 `broll-raw-` 开头 ⇒ 「确认原片优先条款」不受影响。
 * plan 侧 clip_id = `local-<blake3-16>`（**不带** broll-，broll-plan-contract 2026-08-12 收口）——
 * 材料 id 由下方既有拼接得出本前缀形态，同构且杜绝 `broll-broll-` 双前缀。
 */
export const BROLL_LOCAL_MATERIAL_PREFIX = "broll-local-";

/** 素材登记 id：既有拼接 `broll-`+clip_id，本地/云端同构——本地 clip_id=`local-<hash>` →
 * `broll-local-<hash>`；云端雪花 id → `broll-<clip_id>`。clip_id MUST NOT 预置 `broll-`
 * 前缀（broll-plan-contract「材料 id 拼接同构无双前缀」）。 */
export function brollMaterialIdFor(clipId: string): string {
	return `${BROLL_MATERIAL_PREFIX}${clipId}`;
}
/** struct_meta.broll 每 beat 候选精简集上限（全集回 plan 文件）。 */
export const BROLL_META_CANDIDATE_CAP = 12;
/** 目标镜头长缺省（秒）。 */
export const SHOT_TARGET_DEFAULT = 3;
/** 最小可用镜头长（秒）：低于此长度的碎片不铺。 */
export const MIN_SHOT_SEC = 1.2;
/** segment 置信度地板：低于则不采纳（--score-floor 覆盖）。
 * 0.2 = 真机量纲校准（2026-07-10 回声定位）：该后端 score 集中于 0.1~0.4，0.25+ 已是强命中。 */
export const SCORE_FLOOR_DEFAULT = 0.2;
/** 单 beat 单轨槽位上限（防呆）。 */
export const MAX_SLOTS_PER_BEAT = 32;

export interface DownloadedProxy {
	/** 相对 gtrk 目录路径（assets/broll-preview/<clip_id>.mp4）；
	 * 本地素材（source:"local"）为**素材绝对路径**——免下载免代理，直指原文件。 */
	rel: string;
	source: "preview" | "raw" | "local";
}

/** 平铺槽位（laid.slots 条目；双时基窗口）。 */
export interface FillSlot {
	clip_id: string;
	query: string;
	score: number;
	clip_st: number;
	clip_ed: number;
	track_st: number;
	track_ed: number;
}

export interface BrollMetaCandidate {
	clip_id: string;
	score: number;
	/** 云端候选封面 url；本地候选恒 null（封面走 cover_path，MUST NOT 推导远程 URL）。 */
	cover_url: string | null;
	preview_path: string | null;
	source: "preview" | "raw" | "local" | null;
	raw_url: string | null;
	seg: { start: number; end: number; best: number } | null;
	/** 本地候选附加：素材绝对路径。云端候选不出现该键（云端产物逐字节不变）。 */
	local_path?: string;
	/** 本地候选附加：工程内封面相对路径（assets/broll-cover/<id>.jpg；抽取失败为 null）。 */
	cover_path?: string | null;
}

export interface BrollMetaBeat {
	beat: string;
	track_st: number;
	track_ed: number;
	per_shot_sec?: number;
	candidates: BrollMetaCandidate[];
	/** 每轨一条；clip_id = 首槽 clip（兼容旧消费方），slots 为平铺明细。 */
	laid: { order: number; clip_id: string; track_index: number; slots: FillSlot[] }[];
	pinned: null;
}

export interface StructMetaBroll {
	contract_version: "v1";
	generated_at: string;
	plan_path: string;
	/** 本次自产轨 index 全集（候选轨 ∪ 黑底轨，升序）——黑轨在册才能被老版 CLI 一并剥掉。 */
	lay_tracks: number[];
	/** 黑底垫轨 track_index；未铺时 null。供消费方从 lay_tracks 中区分出黑底轨。 */
	black_track: number | null;
	confirmed: false;
	beats: BrollMetaBeat[];
}

/** 黑底段合并容差（秒）：间隙/重叠 ≤ 此值即并为一段。 */
export const BLACK_BED_MERGE_EPS = 0.001;

/**
 * 黑底时窗合并（纯函数）：入参为**已落成候选轨的 beat 包络**，按 track_st 升序合并
 * （重叠或间隙 ≤ EPS 者并为一段），输出不重叠升序段。
 *
 * 口径铁律（主理人 2026-07-25 拍板）：黑底按 **beat 包络整条**铺，MUST NOT 做槽位收集或
 * 跨轨槽位并集——黑底时窗因此完全不依赖种子化随机的槽位切分，确定性只由 beat 端点决定。
 */
export function mergeBlackBedSegments(
	envelopes: { track_st: number; track_ed: number }[],
): { track_st: number; track_ed: number }[] {
	const valid = envelopes
		.filter(
			(e) =>
				Number.isFinite(e.track_st) && Number.isFinite(e.track_ed) && e.track_ed > e.track_st,
		)
		.sort((a, b) => a.track_st - b.track_st);
	const out: { track_st: number; track_ed: number }[] = [];
	for (const e of valid) {
		const last = out[out.length - 1];
		if (last && e.track_st - last.track_ed <= BLACK_BED_MERGE_EPS) {
			if (e.track_ed > last.track_ed) last.track_ed = e.track_ed;
			continue;
		}
		out.push({ track_st: e.track_st, track_ed: e.track_ed });
	}
	return out.map((s) => ({ track_st: r3(s.track_st), track_ed: r3(s.track_ed) }));
}

/** 黑底空洞告警阈值：单个连续空洞 ≥ 此秒数即告警（fix-black-bed-holes-and-gating，主理人 2026-07-26 拍板）。 */
export const HOLE_WARN_SEC = 3.0;
/** 黑底空洞告警阈值：单 beat 空洞占其包络之比 ≥ 此值即告警（与上条各自独立成立）。 */
export const HOLE_WARN_RATIO = 0.15;

/** 黑底空洞：黑底盖着、其上没有任何 B-roll 的纯黑时段（压住口播）。 */
export interface BlackBedHole {
	beat: string;
	track_st: number;
	track_ed: number;
	sec: number;
}

/**
 * 黑底空洞检测（纯函数，**只读统计**）：空洞 = 该 beat 的黑底包络 − 该 beat 内**全部候选轨槽位的并集**
 * （跨轨取并，不是逐轨算）。并集合并与「算不算空洞」的容差沿用既有 `BLACK_BED_MERGE_EPS`。
 *
 * 定位（主理人 2026-07-26 拍板）：黑底按 beat 包络整条铺、填不满处即纯黑，是粗剪期**预期内的产物**，
 * 兜底手段是用户手动调整。本函数只负责把「哪几段是纯黑、各多长、在哪」算出来，
 * MUST NOT 反过来影响任何铺轨决策（时窗、槽位、产物字节一律不因它改变）。
 *
 * 入参只喂**已铺黑底的 beat**（`laid.length === 0` 的 beat 按既有边界不铺黑底、该处露主轨，不计空洞）。
 */
export function computeBlackBedHoles(opts: {
	beats: {
		beat: string;
		track_st: number;
		track_ed: number;
		/** 该 beat 全部候选轨的槽位（跨轨汇总后传入）。 */
		slots: { track_st: number; track_ed: number }[];
	}[];
}): { holes: BlackBedHole[]; totalSec: number } {
	const holes: BlackBedHole[] = [];
	for (const b of opts.beats) {
		if (!(b.track_ed - b.track_st > BLACK_BED_MERGE_EPS)) continue;
		// 槽位先钳进包络再取并（槽位理论上恒在包络内，钳一道防越界数据把空洞算负）
		const covered = mergeBlackBedSegments(
			b.slots.map((s) => ({
				track_st: Math.max(b.track_st, s.track_st),
				track_ed: Math.min(b.track_ed, s.track_ed),
			})),
		);
		const push = (st: number, ed: number): void => {
			const track_st = r3(st);
			const track_ed = r3(ed);
			if (track_ed - track_st > BLACK_BED_MERGE_EPS) {
				holes.push({ beat: b.beat, track_st, track_ed, sec: r3(track_ed - track_st) });
			}
		};
		let cursor = b.track_st;
		for (const c of covered) {
			push(cursor, c.track_st);
			if (c.track_ed > cursor) cursor = c.track_ed;
		}
		push(cursor, b.track_ed);
	}
	holes.sort((a, b) => a.track_st - b.track_st || a.track_ed - b.track_ed);
	return { holes, totalSec: r3(holes.reduce((n, h) => n + h.sec, 0)) };
}

/** beat 候选合并：各 query results（beat 内已去重）按 score 降序（面板/下载排序用）。 */
export function mergedCandidates(beat: PlanBeat): PlanResult[] {
	const all: PlanResult[] = [];
	for (const q of beat.queries) for (const r of q.results ?? []) all.push(r);
	return all.sort((a, b) => b.score - a.score);
}

/** 代理 url 决策：出参 preview_url 优先；缺失按 cover_url 模式推导。 */
export function previewUrlFor(result: PlanResult): string | null {
	const direct = (result as { preview_url?: unknown }).preview_url;
	if (typeof direct === "string" && direct) return direct;
	const cover = result.cover_url;
	if (typeof cover === "string") {
		const derived = cover.replace(/\/keyframe\/([^/]+)\/cover\.jpg.*$/, "/preview/$1.mp4");
		if (derived !== cover) return derived;
	}
	return null;
}

/** preview 代理的近似尺寸（≤640 宽等比、偶数高）。 */
export function previewDims(width?: number, height?: number): [number, number] | undefined {
	if (!width || !height || width <= 0 || height <= 0) return undefined;
	if (width <= 640) return [width, height];
	const h = Math.max(2, Math.round((height * 640) / width / 2) * 2);
	return [640, h];
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

// ── 平铺填充 ──────────────────────────────────────────────────────────────

interface Pair {
	cand: PlanResult;
	seg: { start: number; end: number; best: number; score: number };
	query: string;
	/** consumed 集键：clip + 段起点（同 clip 不同命中段是不同镜头源）。 */
	key: string;
}

/** 每 query 的取材池：results 展开全部 segments，score 降序；excluded_hint 与低于地板的对不进池。 */
function buildQueryPools(beat: PlanBeat, scoreFloor: number): { query: string; pool: Pair[] }[] {
	const out: { query: string; pool: Pair[] }[] = [];
	for (const q of beat.queries) {
		const pool: Pair[] = [];
		for (const cand of q.results ?? []) {
			if (cand.excluded_hint) continue; // 命中派单负词：自动填充跳过（人工面板保留）
			const segs = cand.segments?.length
				? cand.segments
				: // 无命中段的候选降级为整片伪段（少见；score 用 clip 级分）
					[{ start: 0, end: cand.duration ?? SHOT_TARGET_DEFAULT, best: (cand.duration ?? SHOT_TARGET_DEFAULT) / 2, score: cand.score }];
			for (const seg of segs) {
				if (seg.score < scoreFloor) continue; // 低于阈值不采纳（主理人旧方案原则）
				pool.push({ cand, seg, query: q.query, key: `${cand.clip_id}@${seg.start}` });
			}
		}
		pool.sort((a, b) => b.seg.score - a.seg.score);
		if (pool.length) out.push({ query: q.query, pool });
	}
	return out;
}

/** 该对可供的最大镜头长：有素材时长则允许向段外扩（同素材相邻画面），否则只信段长。 */
function pairAvail(p: Pair): number {
	const dur = typeof p.cand.duration === "number" && p.cand.duration > 0 ? p.cand.duration : undefined;
	return dur ?? Math.max(0, p.seg.end - p.seg.start);
}

/** 字符串哈希（FNV-1a）→ 种子。 */
function hashStr(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** mulberry32 种子化伪随机：观感随机、同 plan 重跑逐字节同结果（幂等/可测铁律）。 */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 节奏区间（主理人 2026-07-11：固定槽长太死板）：派单锚 ×[0.8,1.6]（钳 [1.5,8]），缺省 [2,4]s。 */
function shotRange(beat: PlanBeat, span: number): [number, number] {
	const shots =
		typeof beat.requested_shots === "number" && beat.requested_shots > 0 ? beat.requested_shots : undefined;
	const anchor =
		typeof beat.per_shot_sec === "number" && beat.per_shot_sec > 0
			? beat.per_shot_sec
			: shots
				? Math.min(Math.max(span / shots, 1.5), 6)
				: undefined;
	if (anchor === undefined) return [2, 4];
	const lo = Math.max(1.5, anchor * 0.8);
	const hi = Math.max(lo + 0.5, Math.min(8, anchor * 1.6));
	return [lo, hi];
}

/**
 * 单 beat 单轨平铺：游标从 track_st 贪心铺到 track_ed，槽长节奏随机（区间抽取）+ 尾部整形。
 * consumed 跨轨共享（(clip,seg) 对不复用 → 轨间方案差异化）。
 */
export function fillBeatTrack(opts: {
	beat: PlanBeat;
	/** 轨序（0 起）——入种子：同 beat 两条轨节奏各异，重跑可复现。 */
	trackOrder: number;
	consumed: Set<string>;
	scoreFloor: number;
}): FillSlot[] {
	const { beat, trackOrder, consumed, scoreFloor } = opts;
	const span = beat.track_ed - beat.track_st;
	if (!(span > 0)) return [];
	const [shotMin, shotMax] = shotRange(beat, span);
	const rand = mulberry32(hashStr(`${beat.beat}#${trackOrder}`));

	const pools = buildQueryPools(beat, scoreFloor);
	if (!pools.length) return [];

	const slots: FillSlot[] = [];
	let cursor = beat.track_st;
	let prevClip: string | null = null;
	let lastPick: Pair | null = null;
	let gapRun = 0;

	for (let slotIdx = 0; slotIdx < MAX_SLOTS_PER_BEAT; slotIdx++) {
		const remaining = beat.track_ed - cursor;
		if (remaining < MIN_SHOT_SEC) break; // 碎尾停铺（残量由下方吸收兜底）

		// 槽长抽取 + 尾部整形：剩余 ≤ 上限尾槽吃满；(上限, 上限+下限) 劈两半——正常路径零碎尾
		let dTarget: number;
		if (remaining <= shotMax) dTarget = remaining;
		else if (remaining < shotMax + shotMin) dTarget = remaining / 2;
		else dTarget = shotMin + rand() * (shotMax - shotMin);

		const minLen = Math.min(MIN_SHOT_SEC, remaining);
		// query 叙事序轮转：本槽位从 slotIdx 对应的 query 起，池干涸/无合格对则轮下一条
		let pick: Pair | null = null;
		for (let t = 0; t < pools.length && !pick; t++) {
			const { pool } = pools[(slotIdx + t) % pools.length];
			pick =
				pool.find(
					(p) => !consumed.has(p.key) && p.cand.clip_id !== prevClip && pairAvail(p) >= minLen,
				) ?? null;
		}
		if (!pick) {
			// 本槽位无合格对（可能仅因紧邻去重被挡）：留空一个镜头位继续，隔空后同 clip 可再用；连空两次视为干涸
			gapRun++;
			if (gapRun >= 2) break;
			cursor += Math.min(dTarget, remaining);
			prevClip = null;
			continue;
		}
		gapRun = 0;

		const d = Math.min(dTarget, pairAvail(pick), remaining);
		// 源窗：best 居中截 d；有素材时长则钳 [0, dur]（允许出段），否则钳段界
		const dur = typeof pick.cand.duration === "number" && pick.cand.duration > 0 ? pick.cand.duration : undefined;
		const lo = dur !== undefined ? 0 : pick.seg.start;
		const hi = dur ?? pick.seg.end;
		const maxSt = Math.max(lo, hi - d);
		const clipSt = Math.min(Math.max(pick.seg.best - d / 2, lo), maxSt);

		slots.push({
			clip_id: pick.cand.clip_id,
			query: pick.query,
			score: pick.seg.score,
			clip_st: r3(clipSt),
			clip_ed: r3(clipSt + d),
			track_st: r3(cursor),
			track_ed: r3(cursor + d),
		});
		consumed.add(pick.key);
		prevClip = pick.cand.clip_id;
		lastPick = pick;
		cursor += d;
	}

	// 碎尾吸收:残量 < MIN_SHOT(素材短截/浮点残渣)且最后一颗粒紧贴残量时,由它顺延吃掉(素材界内,
	// 双时基同步);gap 造成的大段留空(≥ MIN_SHOT)是有意留空,不吸——该处露黑底垫轨(默认开),
	// 仅 --no-black-bed / 该 beat 未铺黑底时才露 A-roll。
	const last = slots[slots.length - 1];
	if (last && lastPick) {
		const tail = beat.track_ed - last.track_ed;
		if (tail > 1e-6 && tail < MIN_SHOT_SEC) {
			const dur =
				typeof lastPick.cand.duration === "number" && lastPick.cand.duration > 0 ? lastPick.cand.duration : undefined;
			const hi = dur ?? lastPick.seg.end;
			const ext = Math.min(tail, Math.max(0, hi - last.clip_ed));
			if (ext > 1e-6) {
				last.clip_ed = r3(last.clip_ed + ext);
				last.track_ed = r3(last.track_ed + ext);
			}
		}
	}
	return slots;
}

/** 全 plan 预填充（纯函数）：先定「填哪些颗粒」，供调用方下载后再落轨。 */
export function planBeatFills(
	plan: BrollPlan,
	lay: number,
	scoreFloor: number,
): { fills: Map<string, FillSlot[][]>; clipIds: Set<string> } {
	const fills = new Map<string, FillSlot[][]>();
	const clipIds = new Set<string>();
	const consumed = new Set<string>();
	for (const beat of plan.beats) {
		const perTrack: FillSlot[][] = [];
		for (let k = 0; k < Math.max(0, lay); k++) {
			const slots = fillBeatTrack({ beat, trackOrder: k, consumed, scoreFloor });
			perTrack.push(slots);
			for (const s of slots) clipIds.add(s.clip_id);
		}
		fills.set(beat.beat, perTrack);
	}
	return { fills, clipIds };
}

// ── 落轨（剥旧 + append + struct_meta.broll）─────────────────────────────

interface LooseTrack {
	track_index?: number;
	track_timeline?: { material?: unknown }[];
	[k: string]: unknown;
}
interface LooseMaterial {
	id?: unknown;
	[k: string]: unknown;
}

export interface LayResult {
	next: Record<string, unknown>;
	/** laidTracks 只含**候选轨**（人读计数不把黑底算成候选轨）；黑轨另以 blackTrack 报。 */
	summary: {
		laidTracks: number[];
		laidClips: number;
		beatsWithCandidates: number;
		blackTrack: number | null;
		/** 本次剥掉的轨号（含黑轨）——删除动作 MUST NOT 在输出里不可见。 */
		removedTracks: number[];
		/** 判为「自产内容但已被用户编辑」而拒剥保留的轨号（机读事实，与人读告警同口径）。 */
		keptEditedTracks: number[];
		/** ②-B：本次因存在已编辑自产轨而整体拒铺（工程零改动）。 */
		refused: boolean;
		/** 全片累计黑底空洞秒数（= blackBedHoles 各段 sec 之和；未铺黑底时恒 0）。 */
		blackBedHoleSec: number;
		/**
		 * 检出的黑底空洞**全量**（按 track_st 升序）——MUST NOT 按告警阈值过滤：
		 * 阈值只门控人读告警，机读字段一旦被过滤，`0` 就会同时意味着「没空洞」与「有但没超阈值」。
		 */
		blackBedHoles: BlackBedHole[];
	};
	broll: StructMetaBroll;
	/** 铺轨过程中的非致命告警，交由命令层打印（纯函数不做 IO）。 */
	warnings: string[];
}

// ── 自产指纹判据（fix-matrix-strip-identity）──────────────────────────────

/** 一条轨的三态判定。 */
export type TrackClass = "self-produced" | "self-produced-edited" | "user";

/** 由盘上登记复算出的一条「我们上轮铺过的轨长什么样」——★ 中档下只用到 clipCount。 */
export interface ExpectedTrack {
	kind: "candidate" | "black";
	/** 登记里的 track_index：仅作排歧义与日志诊断，MUST NOT 当剥离的充分条件。 */
	trackIndex: number;
	/** 期望 clip 条数（候选轨 = 槽位数；黑底轨 = 复算段数）。 */
	clipCount: number;
}

export interface TrackVerdict {
	cls: TrackClass;
	trackIndex: number | null;
	clipCount: number;
	/** 带 `broll-raw-` 前缀的 clip 数（>0 即「用户确认过原片」）。 */
	rawClips: number;
	/** 非自产前缀的 clip 数（>0 即 L1 不成立）。 */
	foreignClips: number;
	matched: ExpectedTrack | null;
	/** 人读证据。★ MUST NOT 报窗口偏移量——窗口不进中档判据，报它等于给假证据。 */
	reason: string;
	/** material 样例（≤2 条，够用户在客户端里认出这条轨）。 */
	samples: string[];
}

const expectedLabel = (e: ExpectedTrack): string =>
	`${e.kind === "black" ? "黑底轨" : "候选轨"}#${e.trackIndex}=${e.clipCount} clip`;

/**
 * 由盘上 `struct_meta.broll` **纯函数复算**期望指纹（MUST NOT 依赖本轮 plan）。
 *
 * - 候选轨：按 `beats[].laid[].track_index` 汇总 `slots` 条数。**只吃 `slots`（全量登记），
 *   MUST NOT 改吃被 `BROLL_META_CANDIDATE_CAP` 截断的 `candidates` 精简集**。
 * - 黑底轨：由 `laid` 非空的 beat 包络喂 `mergeBlackBedSegments` 复算**段数**，
 *   且仅当 `black_track` 明确登记为 number 时才产出（老档缺键 / null 一律无黑轨期望）。
 */
export function expectedSelfProducedTracks(prevBroll: unknown): ExpectedTrack[] {
	if (!prevBroll || typeof prevBroll !== "object") return [];
	const meta = prevBroll as Partial<StructMetaBroll>;
	const beats = Array.isArray(meta.beats) ? (meta.beats as BrollMetaBeat[]) : [];
	const out: ExpectedTrack[] = [];

	const byTrack = new Map<number, number>();
	for (const b of beats) {
		for (const l of Array.isArray(b?.laid) ? b.laid : []) {
			const idx = (l as { track_index?: unknown }).track_index;
			const slots = (l as { slots?: unknown }).slots;
			if (typeof idx !== "number" || !Array.isArray(slots) || slots.length === 0) continue;
			byTrack.set(idx, (byTrack.get(idx) ?? 0) + slots.length);
		}
	}
	for (const [trackIndex, clipCount] of [...byTrack.entries()].sort((a, b) => a[0] - b[0])) {
		out.push({ kind: "candidate", trackIndex, clipCount });
	}

	if (typeof meta.black_track === "number") {
		const envelopes = beats
			.filter((b) => Array.isArray(b?.laid) && b.laid.length > 0)
			.map((b) => ({ track_st: Number(b.track_st), track_ed: Number(b.track_ed) }));
		const segCount = mergeBlackBedSegments(envelopes).length;
		if (segCount > 0) out.push({ kind: "black", trackIndex: meta.black_track, clipCount: segCount });
	}
	return out;
}

/** 就近排歧义：条数吻合的期望里取 `trackIndex` 最近的一条（等距取号小者）。 */
function pickExpectation(
	expected: ExpectedTrack[],
	clipCount: number,
	trackIndex: number | null,
): ExpectedTrack | null {
	let best: ExpectedTrack | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const e of expected) {
		if (e.clipCount !== clipCount) continue;
		const dist = trackIndex === null ? 0 : Math.abs(e.trackIndex - trackIndex);
		if (dist < bestDist || (dist === bestDist && best !== null && e.trackIndex < best.trackIndex)) {
			best = e;
			bestDist = dist;
		}
	}
	return best;
}

/**
 * 单轨三态判定（纯函数）。判定顺序自上而下短路（见 proposal「主判据」表）：
 *
 *   0. 空轨 / 无登记（期望集合为空）           → `user`（宁留勿删、照常追加，MUST NOT 拒铺）
 *   1. 有任一 `broll-raw-*` clip                → `self-produced-edited`（★ 确认原片即算已编辑，先于 L1/L2）
 *   2. L1 ❌（有非自产前缀 clip，含混合轨）     → `user`（★ 本轮取保守法）
 *   3. L1 ✅ 且命中某条期望指纹（clip 数相等）  → `self-produced`（唯一可剥态）
 *   4. L1 ✅ 未命中但号在 `lay_tracks` 在册     → `self-produced-edited`（疑似我们的轨被改过，如 SA 重编号）
 *   5. L1 ✅ 未命中且号不在册                   → `user`（更像用户手加的纯色垫轨 / 复制过去的候选片）
 *
 * `expected` 传**全量**期望（既用于匹配也用于证据文案）；批量调用可用 `opts.matched` 显式传入
 * 认领结果（一条期望最多认领一条现存轨）。
 */
export function classifyTrack(
	track: LooseTrack,
	expected: ExpectedTrack[],
	opts: { layTracks?: Iterable<number>; registered?: boolean; matched?: ExpectedTrack | null } = {},
): TrackVerdict {
	const clips = Array.isArray(track.track_timeline) ? track.track_timeline : [];
	const trackIndex = typeof track.track_index === "number" ? track.track_index : null;
	const materials = clips.map((c) => (typeof c?.material === "string" ? c.material : ""));
	const rawClips = materials.filter((m) => m.startsWith(BROLL_RAW_MATERIAL_PREFIX)).length;
	const foreignClips = materials.filter(
		(m) => !(m.startsWith(BROLL_MATERIAL_PREFIX) || m.startsWith(SOLID_MATERIAL_PREFIX)),
	).length;
	const base = {
		trackIndex,
		clipCount: clips.length,
		rawClips,
		foreignClips,
		samples: [...new Set(materials.filter(Boolean))].slice(0, 2),
		matched: null as ExpectedTrack | null,
	};
	const registered = opts.registered ?? expected.length > 0;

	if (clips.length === 0) return { ...base, cls: "user", reason: "空轨（track_timeline 为空）" };
	if (!registered) {
		return { ...base, cls: "user", reason: "盘上无 struct_meta.broll 登记（或上轮一条都没铺成）：宁留勿删" };
	}
	if (rawClips > 0) {
		return {
			...base,
			cls: "self-produced-edited",
			reason: `${rawClips}/${clips.length} 个 clip 的 material 已是 broll-raw-*（你在客户端确认过原片）`,
		};
	}
	if (foreignClips > 0) {
		return {
			...base,
			cls: "user",
			reason: `${foreignClips}/${clips.length} 个 clip 的 material 非自产前缀（用户轨 / 混合轨）`,
		};
	}
	const matched = opts.matched !== undefined ? opts.matched : pickExpectation(expected, clips.length, trackIndex);
	if (matched) {
		return { ...base, matched, cls: "self-produced", reason: `与登记吻合（${expectedLabel(matched)}）` };
	}
	const inLay = new Set(opts.layTracks ?? []).has(trackIndex ?? Number.NaN);
	const counts = expected.length ? expected.map(expectedLabel).join("、") : "（登记里一条自产轨都没有）";
	if (inLay) {
		return {
			...base,
			cls: "self-produced-edited",
			reason: `clip 数 ${clips.length} 与登记的自产轨条数都对不上（登记：${counts}），而该 track_index 在 lay_tracks 在册`,
		};
	}
	return {
		...base,
		cls: "user",
		reason: `clip 数 ${clips.length} 对不上任何登记指纹（登记：${counts}）且 track_index 不在 lay_tracks 在册：按用户轨保留`,
	};
}

/**
 * 批量判定：先按内容认领期望指纹（一条期望最多认领一条现存轨，多轨同时吻合按号就近排歧义），
 * 再逐轨定案。返回值与入参 `tracks` 一一对应。
 */
export function classifyVideoTracks(
	tracks: LooseTrack[],
	expected: ExpectedTrack[],
	layTracks: Iterable<number> = [],
): TrackVerdict[] {
	const registered = expected.length > 0;
	// 可认领的轨 = L1 ✅ 且不含 raw（含 raw 者已由优先条款判已编辑，不参与认领）
	const eligible = tracks
		.map((t, i) => ({ i, idx: typeof t.track_index === "number" ? t.track_index : null, v: classifyTrack(t, [], { registered: true, matched: null }) }))
		.filter((e) => e.v.clipCount > 0 && e.v.rawClips === 0 && e.v.foreignClips === 0);
	const claimed = new Map<number, ExpectedTrack>();
	const taken = new Set<number>();
	for (const exp of expected) {
		let best = -1;
		let bestDist = Number.POSITIVE_INFINITY;
		let bestIdx = Number.POSITIVE_INFINITY;
		for (const e of eligible) {
			if (taken.has(e.i) || e.v.clipCount !== exp.clipCount) continue;
			const idx = e.idx ?? Number.MAX_SAFE_INTEGER;
			const dist = Math.abs(idx - exp.trackIndex);
			if (dist < bestDist || (dist === bestDist && idx < bestIdx)) {
				best = e.i;
				bestDist = dist;
				bestIdx = idx;
			}
		}
		if (best >= 0) {
			taken.add(best);
			claimed.set(best, exp);
		}
	}
	return tracks.map((t, i) =>
		classifyTrack(t, expected, { layTracks, registered, matched: claimed.get(i) ?? null }),
	);
}

/**
 * 铺轨主函数（纯函数，不做 IO）：剥离上次自产物 → 按 fills 平铺 append 素材与 overlay 轨 →
 * 写 struct_meta.broll。下载失败的槽位被丢弃（留空，调用方已告警）——默认铺黑底时该处露**黑底垫轨**，
 * 仅 `--no-black-bed` / 该 beat 未铺黑底时才露 A-roll。
 */
export function layBrollTracks(opts: {
	gtrk: Record<string, unknown>;
	plan: BrollPlan;
	lay: number;
	fills: Map<string, FillSlot[][]>;
	downloads: Map<string, DownloadedProxy>;
	generatedAt: string;
	planPath: string;
	/** 是否铺纯黑底垫轨（默认 true，`--no-black-bed` 关）。 */
	blackBed?: boolean;
	/** `--force-relay`：把「自产内容但已被编辑」的轨并入剥离集**并解除拒铺**（②-B 的逃生门）。 */
	forceRelay?: boolean;
	/** 本地候选封面登记（clip_id → 工程内相对路径）；命令层现抽后传入，纯函数只登记不做 IO。 */
	covers?: Map<string, string>;
}): LayResult {
	const { gtrk, plan, lay, fills, downloads } = opts;
	const blackBedOn = opts.blackBed !== false;
	const forceRelay = opts.forceRelay === true;
	const warnings: string[] = [];
	const videoTracks = [...((gtrk.video_track as LooseTrack[] | undefined) ?? [])];
	const materials = [...((gtrk.materials as LooseMaterial[] | undefined) ?? [])];
	const structMeta = { ...((gtrk.struct_meta as Record<string, unknown> | undefined) ?? {}) };

	// ── 剥离自产物（幂等重铺；判据 = 自产指纹，登记缺失宁留勿删）──
	const prevBroll = structMeta.broll as StructMetaBroll | undefined;
	const prevIndices = new Set<number>(
		Array.isArray(prevBroll?.lay_tracks)
			? (prevBroll!.lay_tracks as unknown[]).filter((x): x is number => typeof x === "number")
			: [],
	);
	const expected = expectedSelfProducedTracks(prevBroll);
	const verdicts = classifyVideoTracks(videoTracks, expected, prevIndices);
	const editedTracks = videoTracks.filter((_, i) => verdicts[i]!.cls === "self-produced-edited");
	const keptEditedTracks = editedTracks
		.map((t) => (typeof t.track_index === "number" ? t.track_index : -1))
		.filter((n) => n >= 0);
	const strippable = (i: number): boolean =>
		verdicts[i]!.cls === "self-produced" || (forceRelay && verdicts[i]!.cls === "self-produced-edited");
	const removedTracks = videoTracks.filter((_, i) => strippable(i));
	const keptTracks = videoTracks.filter((_, i) => !strippable(i));

	// 逐轨告警：被判「自产内容但已被编辑」的轨必须带证据出场，MUST NOT 静默
	for (let i = 0; i < videoTracks.length; i++) {
		const v = verdicts[i]!;
		if (v.cls !== "self-produced-edited") continue;
		const samples = v.samples.length ? `，material 样例 ${v.samples.join(" / ")}` : "";
		warnings.push(
			`候选轨 track_index=${v.trackIndex} 判定为「已被你编辑」：${v.reason}（该轨 ${v.clipCount} clip${samples}）。` +
				(forceRelay
					? "已按 --force-relay 强制剥离重铺。"
					: "本次不剥它、也不铺新轨——在客户端处置该轨后重跑，或加 --force-relay 强剥重铺。"),
		);
	}

	// ②-B 拒铺：存在已编辑自产轨且未开逃生门 → 工程零改动（不剥、不追加、不写 struct_meta.broll）
	if (editedTracks.length > 0 && !forceRelay) {
		let beatsWithCands = 0;
		for (const beat of plan.beats) if (mergedCandidates(beat).length > 0) beatsWithCands++;
		warnings.push(
			`本次未铺任何轨、工程文件零改动（.gtrk 未写回、struct_meta.broll 未刷新）；` +
				`broll-plan.json 与已落盘的 preview 代理照常产出/复用。`,
		);
		return {
			next: gtrk,
			summary: {
				laidTracks: [],
				laidClips: 0,
				beatsWithCandidates: beatsWithCands,
				blackTrack: null,
				removedTracks: [],
				keptEditedTracks,
				refused: true,
				// 拒铺 = 工程零改动、黑底也没铺，空洞统计恒静默
				blackBedHoleSec: 0,
				blackBedHoles: [],
			},
			// 拒铺 = 盘上登记原样返回（MUST NOT 让调用方以为本轮刷新过 struct_meta.broll）
			broll: (prevBroll ?? {
				contract_version: "v1",
				generated_at: opts.generatedAt,
				plan_path: opts.planPath,
				lay_tracks: [],
				black_track: null,
				confirmed: false,
				beats: [],
			}) as StructMetaBroll,
			warnings,
		};
	}

	// 自产素材 = `broll-` 前缀（候选片）∪ `ex-solid-` 前缀（黑底垫片）
	const removedMaterialIds = new Set<string>();
	for (const t of removedTracks) {
		for (const c of t.track_timeline ?? []) {
			const m = c.material;
			if (
				typeof m === "string" &&
				(m.startsWith(BROLL_MATERIAL_PREFIX) || m.startsWith(SOLID_MATERIAL_PREFIX))
			) {
				removedMaterialIds.add(m);
			}
		}
	}
	// 零引用保护：`ex-solid-*` 与客户端内置示例素材同命名空间（同色同画布恒等 id），用户从示例面板
	// 加过纯黑就必然撞 id；`broll-*` 也可能被用户复制到自有轨。凡仍被任一保留轨引用者 MUST NOT 删。
	const stillReferenced = new Set<string>();
	for (const group of [keptTracks, (gtrk.beat_track as LooseTrack[] | undefined) ?? [], (gtrk.audio_track as LooseTrack[] | undefined) ?? []]) {
		for (const t of group) {
			for (const c of t.track_timeline ?? []) {
				if (typeof c.material === "string") stillReferenced.add(c.material);
			}
		}
	}
	for (const id of stillReferenced) removedMaterialIds.delete(id);
	const keptMaterials = materials.filter((m) => !(typeof m.id === "string" && removedMaterialIds.has(m.id)));

	// --force-relay 的后果必须先说清：raw 登记一删，盘上已下载的原片就地成孤儿（真机同类量级 1.27G）
	if (forceRelay) {
		const rawGone = [...removedMaterialIds].filter((id) => id.startsWith(BROLL_RAW_MATERIAL_PREFIX)).length;
		if (rawGone > 0) {
			warnings.push(
				`--force-relay：本次强制剥离将删除 ${rawGone} 条 broll-raw-* 素材登记，` +
					`gtrk/assets/broll/ 下对应的已下载原片文件会就地成孤儿（CLI 不删字节，但工程里再无引用）。`,
			);
		}
	}

	// 手工黑底轨检测：用户此前手加的黑底轨会被当用户轨保留并顶高 baseIndex，令新候选轨落到它之下
	// 被整片遮住。宁可告警不猜删（登记缺失宁留勿删铁律）。
	for (const t of keptTracks) {
		const clips = t.track_timeline ?? [];
		if (!clips.length) continue;
		if (clips.every((c) => typeof c.material === "string" && c.material.startsWith(SOLID_MATERIAL_PREFIX))) {
			warnings.push(
				`检测到疑似手工纯色底轨（track_index=${t.track_index}）：新候选轨会落到它之下被遮住。建议删除该轨后重跑，或用 --no-black-bed。`,
			);
		}
	}

	// ── 按 fills 平铺构建 ──
	const canvas = Array.isArray(gtrk.video_size) ? (gtrk.video_size as number[]) : [1920, 1080];
	const baseIndex = keptTracks.reduce((mx, t) => Math.max(mx, typeof t.track_index === "number" ? t.track_index : 0), -1) + 1;
	const candById = new Map<string, PlanResult>();
	for (const beat of plan.beats) for (const c of mergedCandidates(beat)) if (!candById.has(c.clip_id)) candById.set(c.clip_id, c);

	const metaBeats: BrollMetaBeat[] = [];
	const newMaterialsById = new Map<string, LooseMaterial>();
	const trackClips = new Map<number, Record<string, unknown>[]>();
	let laidClips = 0;
	let beatsWithCandidates = 0;

	for (const beat of plan.beats) {
		const merged = mergedCandidates(beat);
		if (merged.length > 0) beatsWithCandidates++;
		const perTrack = fills.get(beat.beat) ?? [];
		const laid: BrollMetaBeat["laid"] = [];

		for (let k = 0; k < perTrack.length; k++) {
			// 下载失败的槽位丢弃（留空）；全空轨槽不建 laid 条目
			const slots = perTrack[k].filter((s) => downloads.has(s.clip_id));
			if (!slots.length) continue;
			const trackIndex = baseIndex + k;
			const bucket = trackClips.get(trackIndex) ?? [];
			slots.forEach((s, i) => {
				const materialId = brollMaterialIdFor(s.clip_id);
				if (!newMaterialsById.has(materialId)) {
					const cand = candById.get(s.clip_id);
					const dl = downloads.get(s.clip_id)!;
					const mat: LooseMaterial = { id: materialId, path: dl.rel };
					if (typeof cand?.duration === "number") mat.duration = cand.duration;
					if (dl.source === "local") {
						// 本地素材免代理：path=素材绝对路径，尺寸/帧率取 ffprobe 实测原值（不做 preview 缩放）
						if (cand?.width && cand?.height) mat.video_size = [cand.width, cand.height];
					} else {
						const dims = previewDims(cand?.width, cand?.height);
						if (dims) mat.video_size = dims;
					}
					if (typeof cand?.fps === "number") mat.video_rate = cand.fps;
					newMaterialsById.set(materialId, mat);
				}
				bucket.push({
					clip_id: `${beat.beat}-broll-${k}-${i}`,
					material: materialId,
					clip_st: s.clip_st,
					clip_ed: s.clip_ed,
					track_st: s.track_st,
					track_ed: s.track_ed,
					duration: r3(s.track_ed - s.track_st),
				});
				laidClips++;
			});
			trackClips.set(trackIndex, bucket);
			laid.push({ order: k, clip_id: slots[0].clip_id, track_index: trackIndex, slots });
		}

		const metaBeat: BrollMetaBeat = {
			beat: beat.beat,
			track_st: beat.track_st,
			track_ed: beat.track_ed,
			candidates: merged.slice(0, BROLL_META_CANDIDATE_CAP).map((c) => {
				const dl = downloads.get(c.clip_id);
				const seg = c.segments?.[0];
				const isLocal = c.source === "local" || typeof c.local_path === "string";
				const entry: BrollMetaCandidate = {
					clip_id: c.clip_id,
					score: c.score,
					cover_url: c.cover_url ?? null,
					// 本地素材无 preview 代理概念（dl.rel 是素材绝对路径），preview_path 恒 null，消费方走 local_path
					preview_path: isLocal ? null : (dl?.rel ?? null),
					source: dl?.source ?? (isLocal ? "local" : null),
					raw_url: c.url ?? null,
					seg: seg ? { start: seg.start, end: seg.end, best: seg.best } : null,
				};
				// 本地附加键仅本地候选出现（云端 struct_meta 产物逐字节不变）
				if (isLocal) {
					if (typeof c.local_path === "string") entry.local_path = c.local_path;
					entry.cover_path = opts.covers?.get(c.clip_id) ?? null;
				}
				return entry;
			}),
			laid,
			pinned: null,
		};
		if (typeof beat.per_shot_sec === "number") metaBeat.per_shot_sec = beat.per_shot_sec;
		metaBeats.push(metaBeat);
	}

	const createdTracks = [...trackClips.entries()]
		.filter(([, clips]) => clips.length > 0)
		.sort((a, b) => a[0] - b[0])
		.map(([track_index, clips]) => ({
			track_index,
			track_size: [canvas[0], canvas[1]],
			muted: false,
			track_timeline: clips.sort((a, b) => (a.track_st as number) - (b.track_st as number)),
		}));

	// ── 纯黑底垫轨（track_index 恒 = baseIndex + lay，即比所有候选轨都大）──
	// gtrk v1 里非主轨 track_index 越大越靠下（客户端 importer 升序进 overlay、overlay[0] 最上层），
	// 故黑底恰好落在「全部候选轨之下、口播主轨之上」，B-roll 期间遮住 A-roll。
	let blackTrack: number | null = null;
	let blackTrackObj: Record<string, unknown> | null = null;
	if (blackBedOn && createdTracks.length > 0) {
		if (!isLayoutableCanvas([canvas[0], canvas[1]])) {
			warnings.push(
				`画布尺寸非法（${canvas[0]}x${canvas[1]}），跳过铺纯黑底轨（候选轨照常铺）。`,
			);
		} else {
			// 时窗 = 本轮**至少落成一条候选轨**的 beat 的包络（整条铺，非槽位并集）。
			const laidBeatEnvelopes = metaBeats
				.filter((b) => b.laid.length > 0)
				.map((b) => ({ track_st: b.track_st, track_ed: b.track_ed }));
			const segments = mergeBlackBedSegments(laidBeatEnvelopes);
			if (segments.length > 0) {
				const width = canvas[0]!;
				const height = canvas[1]!;
				const solidId = solidMaterialId({ hex: BLACK_BED_HEX, width, height });
				// 黑底 material MUST NOT 带 duration：带了会让客户端 resolveTrim 走素材时长分支。
				newMaterialsById.set(solidId, {
					id: solidId,
					path: solidRelPath({ hex: BLACK_BED_HEX, width, height }),
					video_size: [width, height],
				});
				blackTrack = baseIndex + lay;
				blackTrackObj = {
					track_index: blackTrack,
					track_size: [width, height],
					muted: false,
					track_timeline: segments.map((s, i) => ({
						clip_id: `blackbed-${i}`,
						material: solidId,
						clip_st: 0,
						clip_ed: r3(s.track_ed - s.track_st),
						track_st: s.track_st,
						track_ed: s.track_ed,
						duration: r3(s.track_ed - s.track_st),
					})),
				};
			}
		}
	}

	// ── 黑底空洞检测与告警（fix-black-bed-holes-and-gating）──
	// 只读统计，写在产物构建之后：它 MUST NOT 参与任何铺轨决策，开检测/关检测写出的 .gtrk 逐字节一致。
	// 未铺黑底（--no-black-bed / --lay 0 / 零候选轨落成 / 画布非法 / 上游 PNG 落盘失败后的降级重跑）
	// 一律静默：那些情形下留空处露的是主轨 A-roll，属既有有意留空语义，不是空洞。
	let blackBedHoles: BlackBedHole[] = [];
	let blackBedHoleSec = 0;
	if (blackTrack !== null) {
		const holeBeats = metaBeats
			.filter((b) => b.laid.length > 0) // 与黑底时窗同一批 beat（laid 为空者本就不铺黑底）
			.map((b) => ({
				beat: b.beat,
				track_st: b.track_st,
				track_ed: b.track_ed,
				slots: b.laid.flatMap((l) => l.slots), // 跨轨取并：轨 1 空、轨 2 有的段落不算空洞
			}));
		({ holes: blackBedHoles, totalSec: blackBedHoleSec } = computeBlackBedHoles({ beats: holeBeats }));

		const spanOf = new Map(holeBeats.map((b) => [b.beat, b.track_ed - b.track_st]));
		const perBeat = new Map<string, { sec: number; longest: BlackBedHole }>();
		for (const h of blackBedHoles) {
			const cur = perBeat.get(h.beat);
			if (!cur) perBeat.set(h.beat, { sec: h.sec, longest: h });
			else {
				cur.sec = r3(cur.sec + h.sec);
				if (h.sec > cur.longest.sec) cur.longest = h;
			}
		}
		// 两条触发条件各自独立成立；阈值只门控这条人读告警，MUST NOT 过滤上面的机读字段
		const offenders = [...perBeat.entries()].filter(([beat, v]) => {
			const span = spanOf.get(beat) ?? 0;
			return v.longest.sec >= HOLE_WARN_SEC || (span > 0 && v.sec / span >= HOLE_WARN_RATIO);
		});
		if (offenders.length > 0) {
			const detail = offenders
				.map(([beat, v]) => {
					const span = spanOf.get(beat) ?? 0;
					const pct = span > 0 ? Math.round((v.sec / span) * 100) : 0;
					return `${beat} 纯黑 ${v.sec}s / 占 ${pct}%（最长一段 ${v.longest.sec}s @ ${v.longest.track_st}–${v.longest.track_ed}）`;
				})
				.join("；");
			// 语气 = 告知，不拦阻：纯黑段是粗剪期预期内的产物（主理人 2026-07-26 拍板），
			// 本条既不改退出码也不阻断铺轨，只把「哪几段是纯黑、多长、在哪」摆出来供手动调整。
			warnings.push(
				`黑底空洞：${offenders.length} 个 beat 的黑底之上没有任何 B-roll，这几段现在是纯黑压住口播——${detail}；` +
					`全片累计纯黑 ${blackBedHoleSec}s。铺轨已照常完成（黑底按 beat 包络整条铺，槽位没填满处就是纯黑，属粗剪期预期内）；` +
					`想调整可：调低 --score-floor 放宽取材、或改用 --no-black-bed 让这些地方露出主轨口播、或到客户端手动往这几段补片。`,
			);
		}
	}

	const laidTrackIndices = createdTracks.map((t) => t.track_index);
	const broll: StructMetaBroll = {
		contract_version: "v1",
		generated_at: opts.generatedAt,
		plan_path: opts.planPath,
		// 黑轨也登记进 lay_tracks：老版 CLI 只读这个键剥旧，不在册就会把黑轨当用户轨保留、
		// 顶高 baseIndex，令下次新候选轨落到黑轨之下整片黑。
		lay_tracks: blackTrack === null ? laidTrackIndices : [...laidTrackIndices, blackTrack],
		black_track: blackTrack,
		confirmed: false,
		beats: metaBeats,
	};

	// 素材按 id 去重合并：零引用保护会让同一 id 同时出现在保留集与自产集里（旧的「先全删再全加」
	// 天然无重复），自产条目覆盖同 id 的保留条目，杜绝 materials 出现重复 id。
	const mergedMaterials = new Map<string, LooseMaterial>();
	for (const m of keptMaterials) {
		if (typeof m.id === "string") mergedMaterials.set(m.id, m);
		else mergedMaterials.set(`__anon_${mergedMaterials.size}`, m);
	}
	for (const [id, m] of newMaterialsById) mergedMaterials.set(id, m);

	const next: Record<string, unknown> = {
		...gtrk,
		materials: [...mergedMaterials.values()],
		video_track: [...keptTracks, ...createdTracks, ...(blackTrackObj ? [blackTrackObj] : [])],
		struct_meta: { ...structMeta, broll },
	};
	return {
		next,
		summary: {
			laidTracks: laidTrackIndices,
			laidClips,
			beatsWithCandidates,
			blackTrack,
			removedTracks: removedTracks
				.map((t) => (typeof t.track_index === "number" ? t.track_index : -1))
				.filter((n) => n >= 0)
				.sort((a, b) => a - b),
			// forceRelay 下被强剥的轨已进 removedTracks，不再算「保留」
			keptEditedTracks: forceRelay ? [] : keptEditedTracks,
			refused: false,
			blackBedHoleSec,
			blackBedHoles,
		},
		broll,
		warnings,
	};
}
