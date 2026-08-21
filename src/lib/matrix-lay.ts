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
/** 端点残片下限（秒，不暴露配置）：窗口端点与窗内最近切点（seg.cuts）之间短于此的区间 =
 * 异景残片，端点就近**收缩**至切点消除；端点恰落切点上视为无残片。
 *
 * 取 1.0s（tune-shot-rhythm-thresholds，主理人 2026-08-19 走查裁定）：判据不是「残片有多短」
 * 而是**节奏断裂**——「一下慢，一下突然间快，一下又慢」比短镜头本身更难受。铺轨自身的槽长
 * 地板 MIN_SHOT_SEC=1.2s 保证我方从不排出更短的槽，故屏幕上 <1.0s 的镜头必然来自「窗口跨过
 * 源切点且切点贴近端点」，是可修的我方责任。与 QC 的 flashMaxSec 同为 1.0s（防与查同一条线）。
 *
 * **MUST NOT 再上抬到 1.5s 及以上**：实测那是代价拐点——槽位数被迫增加（打样 51→53，节奏反而
 * 变快）、时间线扰动过半（26/51），并开始吃进源素材真实的 1.0–1.5s 镜头（打样素材有 9 条）。
 * 0.5→1.0 这一段实测零代价（槽位数/覆盖率/空槽全不动，窗口收缩由后续槽位吸收）。 */
export const SLIVER_MIN_SEC = 1.0;
/** segment 置信度地板：低于则不采纳（--score-floor 覆盖）。
 * 0.2 = 真机量纲校准（2026-07-10 回声定位）：该后端 score 集中于 0.1~0.4，0.25+ 已是强命中。 */
export const SCORE_FLOOR_DEFAULT = 0.2;
/** 锚起播提前量（秒，add-keyword-anchored-broll）：锚片段钉 `at_sec − 提前量` 起播——提前量让画面
 * 先展开、关键词说出时画面已立住（主理人 2026-08-19 拍板默认 0.5s，常量不暴露配置）。 */
export const ANCHOR_LEAD_SEC = 0.5;
/** 单 beat 单轨槽位上限（防呆）。 */
export const MAX_SLOTS_PER_BEAT = 32;

// ── 句界吸附（adjust-shot-cut-sentence-align，主理人 2026-08-21 拍板「三七开」）────────
//
// TTS 解说类成片约七成「讲新台词」的瞬间画面同步切换、三成有意错开——全对齐机械、全错开涣散。
// 吸附对象 = transcript utterance 起点的**当刻 track 时码**（重投影 utteranceIndex，与锚 at_sec
// 内插同一来源）；吸附率由**确定性负反馈闭环**控制（零新随机源，「同种子幂等」不破）。

/** 句界吸附目标比例缺省（--cut-align 覆盖；0=关闭回旧行为）。 */
export const CUT_ALIGN_DEFAULT = 0.7;
/** 对齐判定容差（秒）：句起点与槽位边界距离 ≤ 此值即算「恰逢切点」。
 * 0.1s ≈ 2–3 帧@24–30fps——帧网格吸附（refineWindow）的 ≤1 帧漂移恒在容差内。 */
export const CUT_ALIGN_EPS = 0.1;
/** 吸附带宽系数（相对节奏区间 [shotMin, shotMax]）：吸附候选带 =
 * [max(MIN_SHOT_SEC, 0.75×shotMin), min(1.25×shotMax, remaining)]。
 * ±25% 下探/上探才够到相邻句距的实测分布（黄石句距 p10=2.12s / p90=4.97s，节奏下限 2.24–2.96s
 * 不下探够不着短句）；MIN_SHOT_SEC 槽长硬地板与 beat 包络是不可越过的既有铁律。 */
export const CUT_SNAP_BAND_LO = 0.75;
export const CUT_SNAP_BAND_HI = 1.25;

/** 主轨 gap 填充模式（adjust-main-track-gap-fill，主理人 2026-08-21 拍板）：
 * fast=快速模式随便填候选（放宽地板）→ 延长相邻颗粒 → 退黑片；solid=黑片垫齐（缺省，精修可见）；
 * none=留 gap（逃生口——客户端主轨磁吸开启时 gap 会被吸除、后续画面整体前移与配音错位）。 */
export type GapFillMode = "fast" | "solid" | "none";

/** gap 填充明细（summary gap_fill.fills 条目；track_st/track_ed = 被该动作覆盖的时间区间）。 */
export interface GapFillEntry {
	beat: string;
	kind: "candidate" | "extend" | "solid";
	track_st: number;
	track_ed: number;
	sec: number;
	/** candidate=填入的 plan clip；extend=被延长的槽位 clip；solid 无此键。 */
	clip_id?: string;
}

/** 闭环控制器状态（每轨一份、跨 beat 共享）：机会数 / 已吸数。 */
export interface CutAlignState {
	chances: number;
	snapped: number;
}

/** 句界吸附入参（fillBeatTrack / fillBeatTrackWithAnchors）：缺席 = 吸附不激活（旧行为逐字节）。 */
export interface CutAlignOpts {
	/** 目标对齐比例 (0,1]；≤0 等价缺席。 */
	ratio: number;
	/** 全片句起点 track 时码（升序、去重）。 */
	starts: number[];
	/** 控制器状态（planBeatFills 按轨各建一份）。 */
	state: CutAlignState;
}

/**
 * 对齐实测（纯函数；summary 与测试共用一份口径）：
 *   分母 = 落在任一已铺 beat `[track_st − ε, track_ed − ε)` 内的句起点（跨 beat 去重）；
 *   分子 = 与任一槽位边界（track_st/track_ed）距离 ≤ ε 者。
 * 计量按**最终产物**（gap 填充之后的首轨槽位）如实执行，不问边界成因（吸附/锚/免费对齐同权计入）。
 */
export function measureCutAlignment(opts: {
	beats: { track_st: number; track_ed: number; slots: { track_st: number; track_ed: number }[] }[];
	starts: number[];
	eps?: number;
}): { starts_total: number; aligned: number; ratio: number } {
	const eps = opts.eps ?? CUT_ALIGN_EPS;
	const cuts: number[] = [];
	for (const b of opts.beats) for (const s of b.slots) cuts.push(s.track_st, s.track_ed);
	cuts.sort((a, b) => a - b);
	const seen = new Set<number>();
	let total = 0;
	let aligned = 0;
	for (const s of opts.starts) {
		const key = Math.round(s * 1000);
		if (seen.has(key)) continue;
		if (!opts.beats.some((b) => s >= b.track_st - eps && s < b.track_ed - eps)) continue;
		seen.add(key);
		total++;
		// cuts 已升序：二分找最近邻
		let lo = 0;
		let hi = cuts.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (cuts[mid]! < s) lo = mid + 1;
			else hi = mid;
		}
		const near = Math.min(
			lo < cuts.length ? Math.abs(cuts[lo]! - s) : Number.POSITIVE_INFINITY,
			lo > 0 ? Math.abs(cuts[lo - 1]! - s) : Number.POSITIVE_INFINITY,
		);
		if (near <= eps) aligned++;
	}
	return { starts_total: total, aligned, ratio: total > 0 ? Math.round((aligned / total) * 1000) / 1000 : 0 };
}

// ── 全局去重与层带（add-broll-dedup-and-layering）─────────────────────────

/** 跳剪豁免阈值（秒，D1 ★ 主理人 2026-08-12 拍板，常量不暴露配置）：同素材相邻槽位，两颗粒源时间
 * 头尾差 <2s（画面几乎相同=同镜头闪现，真疲劳源）才软避让；≥2s 按跳剪论处 MUST NOT 避让
 * （源上跳跃取段=过程/时间推进的合法叙事手法）。 */
export const JUMP_CUT_GAP_SEC = 2;

/** 高运动判据（add-material-motion-signal D1）：段的去重后帧间分 p50 超过此值即视为高运动，
 * 排序时降权（**不是排除**——候选稀疏时宁可用高运动段也不留空，留空的观感代价更大）。
 * 0.05 = 打样标定：问题窗口 0.1058 / 倍帧快摇 0.2747 在线上，干净窗 0.0247 / 真快剪段 0.0165 /
 * 静止 0.0178 在线下。**首批工程复核后再固化**，spec 只要求「可排序、可降权、不硬排除」。 */
export const MOTION_HOT_P50 = 0.05;
/** 高运动降权（分，add-material-motion-signal D1）：排序时高运动段的等效分减去此值——
 * 即「高运动段要比平稳段多 0.02 分才压得过它」，实现 spec 的「同等 score 下优先平稳」。
 * 取降权而非按分档排序：分档会在档位边界上武断（0.339 与 0.341 落不同档）。
 * 无运动信号（旧库/云端候选）时降权恒 0 ⇒ 排序逐字节零回归。 */
export const MOTION_HOT_PENALTY = 0.02;

/** 去重粒度（D1）：scene=场景级（默认）；material=严格档（同一素材文件整轮只消费一次）。 */
export type DedupScope = "scene" | "material";

/** 来源层（D2 层序铁律，写死不配置）：自上而下 local > concept > common（common 最下、紧贴口播/黑底之上）。 */
export type SourceLayer = "local" | "concept" | "common";
/** 层带语义序（自上而下 local > concept > common）。
 * ★ fix-broll-zorder-contract-drift（2026-08-19 打样实锤）：gtrk v1 契约与客户端一致为
 * **track_index 越大越靠前（上层）**（composition-contract-v1 §video_track:「最小=底轨 main，
 * 越大越靠前」；客户端 project-to-timeline 同口径）——本模块此前以相反世界观（小=上层）分配
 * index：黑底落 bandEnd 最大号=按契约盖住全部候选轨、层带 local 落最小号=按契约沉底，
 * 与层序铁律「local 最上」正好相反。音频驱动工程首个客户端走查（黑片压顶截图）拍出实锤。
 * 修正后分配：黑底=baseIndex（最小、垫底），带区自 baseIndex+1 起按 common→concept→local
 * 升号排布（local 号最大=契约上层=铁律「本地最上」）。本常量保持**语义序**（自上而下）不变，
 * index 分配处按其反序遍历。 */
export const SOURCE_LAYER_ORDER: readonly SourceLayer[] = ["local", "concept", "common"];

const isSourceLayer = (v: unknown): v is SourceLayer => v === "local" || v === "concept" || v === "common";

/**
 * 消费单元键（D1/D4 分配即消费）：
 *   - 严格档（--dedup-scope material）：材料 id（整文件一次）；
 *   - 图片：恒文件级（材料 id）；
 *   - 本地视频：（材料 id, 场景近似）——当前 PlanResult 不带场景 idx，以 segment.start 充当场景标识
 *     （聚合段经场景边界对齐，段起点即场景粒度近似；口径注记见 change tasks 2.1）；
 *   - 云端候选：材料 id（云端切片本就是场景粒度，clip 级即场景级）。
 */
export function consumeKeyFor(cand: PlanResult, seg: { start: number }, scope: DedupScope): string {
	if (scope === "material") return cand.clip_id;
	if (cand.kind === "image") return cand.clip_id;
	if (cand.source === "local" || typeof cand.local_path === "string") return `${cand.clip_id}@${seg.start}`;
	return cand.clip_id;
}

/** 填充统计（宁空不重复+跳剪豁免的机读 summary；planBeatFills 聚合）。 */
export interface FillStats {
	/** 因候选枯竭（消费殆尽/避让无次优后仍无对）留空的槽位事件数。 */
	emptySlots: number;
	/** 跳剪避让「枯竭放行」次数（无次优候选时放行同素材近邻颗粒）。 */
	adjacentWaived: number;
	/** pinned 槽位落成数（plan 可编辑契约：agent 钉选被分配器满足的槽位事件数）。 */
	pinnedPlaced: number;
	/** 其中**因窗口精修（残片收缩）后不足 MIN_SHOT_SEC 而无候选可用**导致的留空数
	 * （tune-shot-rhythm-thresholds 的代价观察项：SLIVER_MIN_SEC 上调的真实代价只可能在此显形。
	 * 候选充足时精修弃用会被「换下一候选」吸收、该数恒 0；候选稀疏工程才可能非 0）。 */
	emptySlotsByRefine: number;
	/** 落成槽位中取用了**高运动段**的数量（add-material-motion-signal）：降权只改排序不作排除，
	 * 候选稀疏时仍会取高运动段——如实记录，让「为什么这颗抖」可追溯。 */
	hotSlotsPlaced: number;
	/** pinned 候选未能入选数（冲突后到让位/候选枯竭/被排除——按候选 clip 计，summary 明示）。 */
	pinnedYielded: number;
}

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
	/** 图片候选（add-matrix-local-image-broll）：运镜/静态兜底材料 id 覆盖（命令层运镜准备阶段注入；
	 * 缺省 = 既有 `broll-`+clip_id 拼接）。材料实体经 layBrollTracks 的 injectedMaterials 登记。 */
	material_id?: string;
	/** gap 填充溯源（adjust-main-track-gap-fill）：该槽位由主轨 gap 填充产出（candidate/solid）。
	 * 随 laid[].slots 入 struct_meta.broll（消费方白名单解析防线覆盖）；应用段据此在填充
	 * 不适用（口播/他层主轨）时把规划槽位滤出落轨。常规槽位无此键（旧产物逐字节不变）。 */
	gap_fill?: true;
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
	/** 图片候选附加（add-matrix-local-image-broll）：图片源绝对路径——面板溯源与重生成用。 */
	source_image_path?: string;
	/** 来源层（add-broll-dedup-and-layering 3.1）：候选逐条继承所属层；旧登记缺席=过渡口径。 */
	source_layer?: SourceLayer;
}

export interface BrollMetaBeat {
	beat: string;
	track_st: number;
	track_ed: number;
	per_shot_sec?: number;
	candidates: BrollMetaCandidate[];
	/** 每轨一条；clip_id = 首槽 clip（兼容旧消费方），slots 为平铺明细；
	 * source_layer = 该轨来源层（add-broll-dedup-and-layering 3.1；旧登记缺席按过渡口径处置）。 */
	laid: { order: number; clip_id: string; track_index: number; slots: FillSlot[]; source_layer?: SourceLayer }[];
	pinned: null;
}

export interface StructMetaBroll {
	contract_version: "v1";
	generated_at: string;
	plan_path: string;
	/** 自产轨 index 全集（各层候选轨 ∪ 黑底轨，升序）——黑轨在册才能被老版 CLI 一并剥掉。
	 * 形态保持 number[]（老读方 filter typeof number 的宽松解析零破坏）；层归属另见 track_layers。 */
	lay_tracks: number[];
	/** 层带登记（add-broll-dedup-and-layering 3.1）：track_index（字符串键）→ 来源层。
	 * 黑底轨不在此册（black_track 单列）；缺失该键的存量登记按过渡口径处置（broll-local- 前缀推断 local）。 */
	track_layers?: Record<string, SourceLayer>;
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
	seg: { start: number; end: number; best: number; score: number; cuts?: number[] };
	query: string;
	/** 全局消费单元键（consumeKeyFor：云端/图片=材料级、本地视频=场景级、严格档=材料级）。 */
	key: string;
	/** agent 钉选（plan 可编辑契约）：排序置顶（覆盖 score 排序）+ 免 score 地板（强制入选语义）。 */
	pinned: boolean;
	/** 融合分（add-audio-project-atoms mark-weight）：w=0 时恒 === seg.score（排序逐字节零回归）；
	 * w>0 且 mark 缓存命中时 = sim×(1-w)+(mark/100)×w，无缓存中性（=sim）。只参与排序，
	 * MUST NOT 参与 score 地板判定（mark 缺失/低 mark 不得变成变相剔除）。 */
	fused: number;
	/** 排序用等效分（add-material-motion-signal）：`fused − 高运动降权`。无运动信号时恒 === fused
	 * （零回归）。只参与**排序**，MUST NOT 参与 score 地板判定或作为排除条件。 */
	rank: number;
	/** 该段是否判为高运动（p50 > MOTION_HOT_P50）——summary 计数与诊断用。 */
	hot: boolean;
}

/** mark 融合统计收集器（按候选 clip 去重；planBeatFills 聚合进 summary）。 */
export interface MarkStatsSets {
	/** describe 缓存命中的候选 clip_id 集。 */
	hit: Set<string>;
	/** 无缓存按中性处理的候选 clip_id 集。 */
	neutral: Set<string>;
}

/** mark 查询闭包（命令层供给：material_id+ts_ms 就近命中 describes 缓存；纯函数层零 IO）。 */
export type MarkLookup = (clipId: string, tsMs: number) => number | undefined;

/** 图片候选判据（broll-plan-contract kind 可选缺省 video；未知取值按 video 兜底）。 */
const isImagePair = (p: Pair): boolean => p.cand.kind === "image";

/** 每 query 的取材池：results 展开全部 segments，融合分降序（严格同分视频优先 tie-break，
 * ★ 主理人 2026-08-12 拍板）；excluded_hint 与低于地板的对不进池；noImage（--no-image-broll）
 * 时图片候选完全不进池（不上云）。
 * pinned（plan 可编辑契约）：钉选候选**置顶**（覆盖 score 排序）且免 excluded_hint / score 地板
 * （agent 显式裁定 > 自动护栏）；noImage 例外——「零图片上云」是用户级硬承诺，pinned 不豁免。
 * mark-weight（add-audio-project-atoms）：markWeight>0 时融合分 = sim×(1-w)+(mark/100)×w，
 * mark 经 markLookup 取 describes 缓存（就近命中）；无缓存候选中性（融合分=sim，不惩罚不加分）；
 * score 地板仍只看原始 sim（mark 缺失 MUST NOT 变成变相剔除）；默认 w=0 排序逐字节零回归。 */
function buildQueryPools(
	beat: PlanBeat,
	scoreFloor: number,
	opts: {
		noImage?: boolean;
		dedupScope?: DedupScope;
		markWeight?: number;
		markLookup?: MarkLookup;
		markStats?: MarkStatsSets;
	} = {},
): { query: string; pool: Pair[] }[] {
	const scope = opts.dedupScope ?? "scene";
	const w = typeof opts.markWeight === "number" && opts.markWeight > 0 ? Math.min(1, opts.markWeight) : 0;
	const out: { query: string; pool: Pair[] }[] = [];
	for (const q of beat.queries) {
		const pool: Pair[] = [];
		for (const cand of q.results ?? []) {
			const pinned = cand.pinned === true;
			if (!pinned && cand.excluded_hint) continue; // 命中派单负词：自动填充跳过（人工面板保留）
			if (opts.noImage && cand.kind === "image") continue; // 排除开关：图片不出候选池（pinned 也不豁免）
			const segs = cand.segments?.length
				? cand.segments
				: // 无命中段的候选降级为整片伪段（少见；score 用 clip 级分）
					[{ start: 0, end: cand.duration ?? SHOT_TARGET_DEFAULT, best: (cand.duration ?? SHOT_TARGET_DEFAULT) / 2, score: cand.score }];
			for (const seg of segs) {
				if (!pinned && seg.score < scoreFloor) continue; // 低于阈值不采纳（pinned=强制入选，免地板；地板恒看原始 sim）
				let fused = seg.score;
				if (w > 0) {
					const mark = opts.markLookup?.(cand.clip_id, Math.round(seg.best * 1000));
					if (typeof mark === "number" && Number.isFinite(mark)) {
						fused = seg.score * (1 - w) + (Math.min(100, Math.max(0, mark)) / 100) * w;
						opts.markStats?.hit.add(cand.clip_id);
					} else {
						opts.markStats?.neutral.add(cand.clip_id); // 无缓存中性：融合分=sim
					}
				}
				// 高运动降权（add-material-motion-signal）：只影响排序，不改地板、不作排除
				const p50 = (seg as { motion?: { p50?: number } }).motion?.p50;
				const hot = typeof p50 === "number" && Number.isFinite(p50) && p50 > MOTION_HOT_P50;
				pool.push({
					cand,
					seg,
					query: q.query,
					key: consumeKeyFor(cand, seg, scope),
					pinned,
					fused,
					hot,
					rank: hot ? fused - MOTION_HOT_PENALTY : fused,
				});
			}
		}
		pool.sort(
			(a, b) =>
				Number(b.pinned) - Number(a.pinned) ||
				// rank = fused − 高运动降权（无信号时恒 === fused，排序零回归）
				b.rank - a.rank ||
				b.fused - a.fused ||
				b.seg.score - a.seg.score ||
				Number(isImagePair(a)) - Number(isImagePair(b)),
		);
		if (pool.length) out.push({ query: q.query, pool });
	}
	return out;
}

/** 颗粒源窗（选取评估与落位共用，保证避让判定用的就是将落位的窗口）：
 * 图片=0..d（运镜分支）；视频=best 居中截 d **钳段界**（fix-broll-flash-frames D1——
 * 「有素材时长向段外扩」口径废止：段边界≈场景切点，外扩即把邻场景异景帧截进 clip，
 * 旅拍打样闪帧实锤根因；本地与云端视频候选统一段界口径）。 */
function sourceWindowFor(p: Pair, d: number): { clipSt: number; clipEd: number } {
	if (isImagePair(p)) return { clipSt: 0, clipEd: d };
	const lo = p.seg.start;
	const maxSt = Math.max(lo, p.seg.end - d);
	const clipSt = Math.min(Math.max(p.seg.best - d / 2, lo), maxSt);
	return { clipSt, clipEd: Math.min(clipSt + d, p.seg.end) };
}

/** 窗口精修（fix-broll-flash-frames D1）：①端点残片收缩（只收不移）——窗内切点（seg.cuts）距
 * 端点 <SLIVER_MIN_SEC 时端点吸附至切点（恰落切点=无残片不动）；②帧网格吸附——端点按素材帧率
 * （result.fps）就近吸附整帧边界（VFR/非常规 time_base 消除 ±1 帧边界抖动；fps 缺失跳过）。
 * 两步**只许缩短不许撑长**：吸附取整可能把槽长撑出 1 帧，`maxD`（剩余 beat 空间）与段界是硬上限
 * ——越界会顶掉下一 beat 的首槽造成时间线重叠（渲染器 normalizeTrack 直接硬拒）。
 * 精修后短于 MIN_SHOT_SEC 返回 null（该对不采纳，走既有换候选/留空路径）。图片候选原样返回。 */
function refineWindow(
	p: Pair,
	win: { clipSt: number; clipEd: number },
	maxD: number,
): { clipSt: number; clipEd: number } | null {
	if (isImagePair(p)) return win;
	const EPS = 1e-6;
	let { clipSt, clipEd } = win;
	// 端点是否由「吸附到切点」得来——若是，帧网格取整 MUST NOT 把它推回切点的另一侧：
	// 切点时码 = 新场景**首帧**的时刻，起点就近取整可能落到切点前一帧（= 留 1 帧旧场景，
	// 把刚做的收缩撤销了半帧；打样实测 618.469 在 60fps 上取整到 618.4667）。故起点向上取整、
	// 终点向下取整，宁可少一帧也不越到切点另一侧。
	let stOnCut = false;
	let edOnCut = false;
	const cuts = p.seg.cuts;
	if (Array.isArray(cuts) && cuts.length) {
		const inWin = cuts.filter((c) => Number.isFinite(c) && c > clipSt + EPS && c < clipEd - EPS);
		if (inWin.length) {
			const head = inWin[0]!;
			if (head - clipSt < SLIVER_MIN_SEC) {
				clipSt = head;
				stOnCut = true;
			}
			const tail = inWin[inWin.length - 1]!;
			if (tail > clipSt + EPS && clipEd - tail < SLIVER_MIN_SEC) {
				clipEd = tail;
				edOnCut = true;
			}
		}
	}
	const fps = p.cand.fps;
	if (typeof fps === "number" && Number.isFinite(fps) && fps > 0) {
		// 起点：吸附到切点者向上取整（不含切点前那帧），否则就近；再钳回段内
		const stGrid = stOnCut ? Math.ceil(clipSt * fps - EPS) / fps : Math.round(clipSt * fps) / fps;
		const st = Math.min(Math.max(stGrid, p.seg.start), clipEd);
		// 终点：吸附到切点者向下取整（不含切点那帧，它属下一镜头），否则就近
		let ed = Math.min(edOnCut ? Math.floor(clipEd * fps + EPS) / fps : Math.round(clipEd * fps) / fps, p.seg.end);
		// 吸附撑长的硬上限：超出剩余空间即把终点**向下**取整到帧网格（宁短一帧不越界）
		if (ed - st > maxD + EPS) ed = st + Math.floor((maxD + EPS) * fps) / fps;
		if (ed - st > EPS) {
			clipSt = st;
			clipEd = ed;
		}
	}
	if (clipEd - clipSt > maxD + EPS) clipEd = clipSt + maxD; // 无 fps 分支的兜底上限
	if (clipEd - clipSt < MIN_SHOT_SEC) return null;
	return { clipSt, clipEd };
}

/** 该对可供的最大镜头长 = 段界内长度（fix-broll-flash-frames D1：外扩口径废止，只信段长）。
 * 图片候选恒不限长（运镜视频按槽长档位现生成，槽长在 shotRange 上限内必被覆盖）。 */
function pairAvail(p: Pair): number {
	if (isImagePair(p)) return Number.POSITIVE_INFINITY;
	return Math.max(0, p.seg.end - p.seg.start);
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
 *
 * 全局去重（add-broll-dedup-and-layering D1/D4）：consumed 跨 beat 跨轨共享，消费单元见
 * consumeKeyFor（分配即消费、该轮不归还，宁空不重复——铁律优先于填充率）；beatOwners 为同 beat
 * 跨轨的素材归属（同槽候选组互斥：一个素材文件在一个 beat 里至多出现在一条候选轨上，给用户真实选择面）。
 * 相邻避让走跳剪豁免版：同素材相邻槽位（间隔 <2 槽）仅当源头尾差 <JUMP_CUT_GAP 才取次优；
 * ≥2s 按跳剪放行；无次优时枯竭放行并计 stats.adjacentWaived。
 */
export function fillBeatTrack(opts: {
	beat: PlanBeat;
	/** 轨序（0 起）——入种子：同 beat 两条轨节奏各异，重跑可复现。 */
	trackOrder: number;
	consumed: Set<string>;
	scoreFloor: number;
	/** --no-image-broll：图片候选不进池（add-matrix-local-image-broll）。 */
	noImage?: boolean;
	/** 去重粒度（缺省 scene；material=严格档）。 */
	dedupScope?: DedupScope;
	/** 同 beat 跨轨素材归属（材料 id → 首个占用的 trackOrder）；planBeatFills 每 beat 建一份共享。 */
	beatOwners?: Map<string, number>;
	/** 填充统计收集器（planBeatFills 聚合进 summary）。 */
	stats?: FillStats;
	/** 美观度权重（add-audio-project-atoms）：0..1，默认 0 零回归；配 markLookup 用。 */
	markWeight?: number;
	/** mark 查询闭包（命令层供给 describes 缓存就近命中；缺省=全部中性）。 */
	markLookup?: MarkLookup;
	/** mark 融合统计收集器（planBeatFills 聚合）。 */
	markStats?: MarkStatsSets;
	/** 句界吸附（adjust-shot-cut-sentence-align）：缺席/ratio≤0 = 不激活（旧行为逐字节零回归）。 */
	cutAlign?: CutAlignOpts;
}): FillSlot[] {
	const { beat, trackOrder, consumed, scoreFloor } = opts;
	const span = beat.track_ed - beat.track_st;
	if (!(span > 0)) return [];
	const [shotMin, shotMax] = shotRange(beat, span);
	const rand = mulberry32(hashStr(`${beat.beat}#${trackOrder}`));

	// 句界吸附激活判定 + 免费对齐入账：beat 起点恰逢句起点（音频驱动工程 beat 边界 = utterance span
	// 包络，首槽起点天然对齐）——不入账会让实测系统性超出目标比例（design §2 论据 2）
	const ca = opts.cutAlign && opts.cutAlign.ratio > 0 && opts.cutAlign.starts.length ? opts.cutAlign : undefined;
	if (ca && ca.starts.some((s) => Math.abs(s - beat.track_st) <= CUT_ALIGN_EPS)) {
		ca.state.chances++;
		ca.state.snapped++;
	}

	const pools = buildQueryPools(beat, scoreFloor, {
		noImage: opts.noImage,
		dedupScope: opts.dedupScope,
		markWeight: opts.markWeight,
		markLookup: opts.markLookup,
		markStats: opts.markStats,
	});
	if (!pools.length) return [];

	const slots: FillSlot[] = [];
	let cursor = beat.track_st;
	let lastPlaced: { slotIdx: number; clipId: string; clipEd: number } | null = null;
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

		// 句界吸附（adjust-shot-cut-sentence-align）：带内取距 cursor+dTarget 最近的句起点，闭环放行才吸。
		// 只改 dTarget 取值、不消耗随机序列（上面的 rand() 调用次数与旧行为恒等——关闭即逐字节回旧）。
		let snapTarget: number | undefined;
		const preSnapDTarget = dTarget; // 吸附放弃时恢复的随机槽长（供长不足踩不到点 → 回普通选取）
		if (ca) {
			const bandLo = cursor + Math.max(MIN_SHOT_SEC, shotMin * CUT_SNAP_BAND_LO);
			const bandHi = cursor + Math.min(shotMax * CUT_SNAP_BAND_HI, remaining);
			let best: number | undefined;
			let bestDist = Number.POSITIVE_INFINITY;
			for (const s of ca.starts) {
				if (s < bandLo - 1e-6) continue;
				if (s > bandHi + 1e-6) break; // starts 升序，越带即止
				const tailRoom = beat.track_ed - s;
				if (tailRoom > 1e-6 && tailRoom < MIN_SHOT_SEC) continue; // beat 尾死残段保护（吸了填不进颗粒）
				const dist = Math.abs(s - (cursor + dTarget));
				if (dist < bestDist) {
					best = s;
					bestDist = dist;
				}
			}
			if (best !== undefined) {
				ca.state.chances++;
				// 负反馈闭环：已实现比例低于目标才吸（三成错开由「不低于则有意跳过」产生）；
				// 确定性纯函数，密度自适应——句密多跳、句疏多吸（design §2）
				if (ca.state.snapped / ca.state.chances < ca.ratio - 1e-9) {
					ca.state.snapped++;
					snapTarget = best;
					dTarget = best - cursor;
				}
			}
		}

		const minLen = Math.min(MIN_SHOT_SEC, remaining);
		const dFor = (p: Pair): number => Math.min(dTarget, pairAvail(p), remaining);
		// 基础合格：未被全局消费 ∧ 供长够 ∧ 同 beat 素材归属不冲突（同槽候选组互斥）
		const eligible = (p: Pair): boolean => {
			if (consumed.has(p.key) || pairAvail(p) < minLen) return false;
			const owner = opts.beatOwners?.get(p.cand.clip_id);
			return owner === undefined || owner === trackOrder;
		};
		// 将落位窗口 = 基础源窗（best 居中钳段）+ 精修（残片收缩/帧吸附，受剩余 beat 空间上限约束）；
		// null = 精修后不足最小槽长，该对不采纳
		const resolveWindow = (p: Pair): { clipSt: number; clipEd: number } | null =>
			refineWindow(p, sourceWindowFor(p, dFor(p)), remaining);
		// 跳剪豁免版相邻避让（D1）：相邻槽位（间隔 <2 槽）∧ 同素材 ∧ |后颗粒 clip_st − 前颗粒 clip_ed| < 2s
		const jumpCutBlocked = (p: Pair, win: { clipSt: number }): boolean => {
			if (!lastPlaced || slotIdx - lastPlaced.slotIdx >= 2) return false;
			if (p.cand.clip_id !== lastPlaced.clipId) return false;
			return Math.abs(win.clipSt - lastPlaced.clipEd) < JUMP_CUT_GAP_SEC;
		};

		// query 叙事序轮转：本槽位从 slotIdx 对应的 query 起，池干涸/无合格对则轮下一条。
		// 吸附感知选取（adjust-shot-cut-sentence-align）：吸附槽位先只接受**踩得到吸附点**的对
		// （精修后窗口长 ≥ 吸附槽长 − 容差）——否则边界被供长/精修拉离句起点，吸了白吸（真机重放实锤）。
		const attempt = (requireReach: boolean): { p: Pair; win: { clipSt: number; clipEd: number } } | null => {
			for (let t = 0; t < pools.length; t++) {
				const { pool } = pools[(slotIdx + t) % pools.length];
				for (const p of pool) {
					if (!eligible(p)) continue;
					const win = resolveWindow(p);
					if (!win || jumpCutBlocked(p, win)) continue;
					if (requireReach && snapTarget !== undefined && win.clipEd - win.clipSt < snapTarget - cursor - CUT_ALIGN_EPS) continue;
					return { p, win };
				}
			}
			return null;
		};
		let pick: Pair | null = null;
		let pickWin: { clipSt: number; clipEd: number } | null = null;
		let got = attempt(snapTarget !== undefined);
		if (!got && snapTarget !== undefined && ca) {
			// 无对踩得到吸附点：放弃本槽吸附（如实退账，闭环续补），恢复随机槽长走普通选取
			ca.state.snapped--;
			snapTarget = undefined;
			dTarget = preSnapDTarget;
			got = attempt(false);
		}
		if (got) {
			pick = got.p;
			pickWin = got.win;
		}
		// 精修弃用归因（tune-shot-rhythm-thresholds 代价观察项）：本槽位是否**只**因窗口精修
		// （残片收缩后不足 MIN_SHOT_SEC）而找不到对——即存在基础合格但精修返回 null 的候选
		let refineRejected = false;
		if (!pick) {
			// 枯竭放行（软避让）：无次优候选时放行被避让的同素材近邻颗粒，计入 summary
			for (let t = 0; t < pools.length && !pick; t++) {
				const { pool } = pools[(slotIdx + t) % pools.length];
				for (const p of pool) {
					if (!eligible(p)) continue;
					const win = resolveWindow(p);
					if (!win) {
						refineRejected = true;
						continue;
					}
					pick = p;
					pickWin = win;
					break;
				}
			}
			if (pick && opts.stats) opts.stats.adjacentWaived++;
		}
		if (!pick || !pickWin) {
			// 宁空不重复（铁律）：候选枯竭即留空，MUST NOT 复用已分配素材；连空两次视为干涸
			if (opts.stats) {
				opts.stats.emptySlots++;
				// 有基础合格候选、但全被精修弃用 ⇒ 该空槽记在阈值账上（候选充足时恒为 0）
				if (refineRejected) opts.stats.emptySlotsByRefine++;
			}
			gapRun++;
			if (gapRun >= 2) break;
			cursor += Math.min(dTarget, remaining);
			continue;
		}
		gapRun = 0;

		// 落位窗口即避让判定用的窗口（精修后 d 可短于抽取槽长——钳段/收缩/吸附皆只收不涨）
		const win = pickWin;
		const d = win.clipEd - win.clipSt;
		// 句界吸附退账：供长不足/窗口精修把边界拉离吸附点 → 本次实际未对齐，退还闭环账（后续机会续补）
		if (ca && snapTarget !== undefined && Math.abs(cursor + d - snapTarget) > CUT_ALIGN_EPS) ca.state.snapped--;

		slots.push({
			clip_id: pick.cand.clip_id,
			query: pick.query,
			score: pick.seg.score,
			clip_st: r3(win.clipSt),
			clip_ed: r3(win.clipEd),
			track_st: r3(cursor),
			track_ed: r3(cursor + d),
		});
		if (pick.pinned && opts.stats) opts.stats.pinnedPlaced++; // pinned 落成计数（summary 明示）
		if (pick.hot && opts.stats) opts.stats.hotSlotsPlaced++; // 取用高运动段（降权未挡住=候选稀疏）
		consumed.add(pick.key);
		opts.beatOwners?.set(pick.cand.clip_id, trackOrder);
		lastPlaced = { slotIdx, clipId: pick.cand.clip_id, clipEd: win.clipEd };
		lastPick = pick;
		cursor += d;
	}

	// 碎尾吸收:残量 < MIN_SHOT(素材短截/浮点残渣)且最后一颗粒紧贴残量时,由它顺延吃掉(**段界内**,
	// 双时基同步);gap 造成的大段留空(≥ MIN_SHOT)是有意留空,不吸——该处露黑底垫轨(默认开),
	// 仅 --no-black-bed / 该 beat 未铺黑底时才露 A-roll。
	// fix-broll-flash-frames D1:吸收上界随窗口口径一并收窄到段界(MUST NOT 用素材时长外扩),
	// 且吸收后的尾端点同样过残片收缩/帧吸附(吸收不得把刚消掉的异景残片又吃回来)。
	const last = slots[slots.length - 1];
	if (last && lastPick) {
		const tail = beat.track_ed - last.track_ed;
		if (tail > 1e-6 && tail < MIN_SHOT_SEC) {
			// 图片候选不限源界（运镜 duration 按最终槽长档位生成，吸收后仍被覆盖）
			const hi = isImagePair(lastPick) ? Number.POSITIVE_INFINITY : lastPick.seg.end;
			const ext = Math.min(tail, Math.max(0, hi - last.clip_ed));
			if (ext > 1e-6) {
				// 上限 = 该槽起点到 beat 末端的全部空间（吸收后仍 MUST NOT 越过 beat 包络）
				const maxD = beat.track_ed - last.track_st;
				const refined = refineWindow(lastPick, { clipSt: last.clip_st, clipEd: last.clip_ed + ext }, maxD);
				// 精修失败（收缩后不足下限）= 维持吸收前窗口，如实留空
				if (refined && refined.clipEd > last.clip_ed + 1e-6) {
					const grew = refined.clipEd - last.clip_ed;
					last.clip_ed = r3(refined.clipEd);
					last.track_ed = r3(last.track_ed + grew);
				}
			}
		}
	}
	return slots;
}

// ── 锚点优先布局（add-keyword-anchored-broll）─────────────────────────────

/** 逐锚落位结果（summary anchor_details 条目）：status = planned（系统选取钉位）| pinned（用户
 * 钉选候选占锚槽——用户 pin 优先于锚的系统选取）| degraded（退化普通槽，reason 给因）。 */
export interface AnchorOutcome {
	beat: string;
	keyword: string;
	at_sec: number | null;
	/** 实际钉住的槽位起点（track_st = max(beat 起点, at_sec − ANCHOR_LEAD_SEC) 出界钳回）；degraded 时 null。 */
	track_st: number | null;
	clip_id: string | null;
	status: "planned" | "pinned" | "degraded";
	/** degraded 原因（人读告警与机读诊断共用）。 */
	reason?: string;
}

/**
 * 单 beat 首轨锚点优先布局（add-keyword-anchored-broll）：先钉锚、再在锚点分割出的区间内复用
 * 既有序贯填充（fillBeatTrack 整套切槽/避让/精修/吸收逻辑，MUST NOT 另写一套）。
 *
 * 口径：
 *   - 锚只钉**首轨**（trackOrder 0，默认可见的主候选轨）；备选轨保持既有序贯填充——N 轨 × 锚
 *     重复钉位会把不二用消费池抽干，备选轨要给用户的是整套差异化方案，同一锚的次优命中撑不起这个价值。
 *   - 每锚取其 query 池的首个合格对（池序 = pinned 置顶 > 等效分降序——**用户 pinned 优先于锚**
 *     的系统选取，取到 pinned 对时 status="pinned"）；片段钉 `max(beat.track_st, at_sec − 提前量)`，
 *     时长 = min(命中段可用长, per_shot_sec×2)，出界钳回 beat 窗口。
 *   - 锚间时间重叠：按 at_sec 先到先钉，后锚只后移不重叠；挤到不足最小槽长即 degraded（不硬锚）。
 *   - 锚 query 无 ≥score 地板命中 / at_sec 缺失（内插失败）→ 该锚 degraded 退化普通槽 + summary 明示；
 *     锚池为空时 reason 按 anchorPoolEmptyReason 如实归因（检索失败/零命中/被旧版 plan 去重折叠分案，
 *     真机验收发现①：折叠致池空曾被误报成「无 ≥score 地板的命中」）。
 *   - 锚片段消费照走全局不二用记账（consumed/beatOwners）；黑片叠底/mark-weight/层带零改动。
 */
/** 锚池为空的如实归因（degraded reason，add-keyword-anchored-broll 发现①修订）：
 * 「无 ≥score 地板的命中」只在**命中确实存在但全被地板/负词/排除开关拦下**时报；plan 内无检索
 * 记录、检索失败、零命中、命中被旧版 plan 的 beat 内去重折进其他 query（plan 构建现已对锚 query
 * 免折，此案只剩旧版/手编 plan 可达——防御性保留）各自分案明示。 */
function anchorPoolEmptyReason(beat: PlanBeat, query: string): string {
	const q = beat.queries.find((x) => x.query === query);
	if (!q) return `锚 query「${query}」在 plan 内无检索记录（该 query 被编辑删除或检索未跑）——重跑 gtrk matrix 可恢复`;
	if (q.error) return `锚 query「${query}」检索失败（${q.error.msg}）`;
	if (!q.results?.length) {
		// also_matched_queries 里出现本 query = 命中明明存在、被 beat 内去重折进了别的 query
		const folded = beat.queries.some((x) => x !== q && (x.results ?? []).some((r) => r.also_matched_queries?.includes(query)));
		return folded
			? `锚 query「${query}」的命中被 beat 内去重折进同 beat 其他 query（旧版 plan 形态）——重跑 gtrk matrix 生成新 plan 即恢复`
			: `锚 query「${query}」检索零命中`;
	}
	return `锚 query「${query}」无 ≥score 地板的命中`;
}

export function fillBeatTrackWithAnchors(opts: {
	beat: PlanBeat;
	trackOrder: number;
	consumed: Set<string>;
	scoreFloor: number;
	noImage?: boolean;
	dedupScope?: DedupScope;
	beatOwners?: Map<string, number>;
	stats?: FillStats;
	markWeight?: number;
	markLookup?: MarkLookup;
	markStats?: MarkStatsSets;
	/** 句界吸附（adjust-shot-cut-sentence-align）：锚槽窗口零改动（锚 > 句吸附），锚点分割区间内透传照常吸附。 */
	cutAlign?: CutAlignOpts;
}): { slots: FillSlot[]; anchors: AnchorOutcome[] } {
	const { beat } = opts;
	const anchorsIn = Array.isArray(beat.anchors) ? beat.anchors : [];
	// 无锚 = 原路序贯填充（零回归：本函数只是 fillBeatTrack 的透明壳）
	if (!anchorsIn.length) return { slots: fillBeatTrack(opts), anchors: [] };

	const outcomes: AnchorOutcome[] = [];
	const anchorSlots: FillSlot[] = [];
	const span = beat.track_ed - beat.track_st;
	const degraded = (a: { keyword: string; at_sec: number | null }, reason: string): void => {
		outcomes.push({ beat: beat.beat, keyword: a.keyword, at_sec: a.at_sec ?? null, track_st: null, clip_id: null, status: "degraded", reason });
	};
	if (!(span > 0)) {
		for (const a of anchorsIn) degraded({ keyword: a.keyword, at_sec: a.at_sec ?? null }, "beat 窗口无长度");
		return { slots: [], anchors: outcomes };
	}

	const pools = buildQueryPools(beat, opts.scoreFloor, {
		noImage: opts.noImage,
		dedupScope: opts.dedupScope,
		markWeight: opts.markWeight,
		markLookup: opts.markLookup,
		markStats: opts.markStats,
	});
	const poolByQuery = new Map(pools.map((p) => [p.query, p.pool]));
	const perShot = typeof beat.per_shot_sec === "number" && beat.per_shot_sec > 0 ? beat.per_shot_sec : SHOT_TARGET_DEFAULT;
	const maxAnchorLen = perShot * 2; // 锚片段时长上限 = per_shot_sec × 2（拍板口径）
	// 按 at_sec 升序钉位（at_sec 缺失者排尾直接 degraded，不占位）；同刻按原序
	const sorted = anchorsIn
		.map((a, i) => ({ a, i }))
		.sort((x, y) => (x.a.at_sec ?? Number.POSITIVE_INFINITY) - (y.a.at_sec ?? Number.POSITIVE_INFINITY) || x.i - y.i);
	let cursorMin = beat.track_st; // 前锚已占用的推进线（锚间只后移不重叠）

	for (const { a } of sorted) {
		if (typeof a.at_sec !== "number" || !Number.isFinite(a.at_sec)) {
			degraded(a, "at_sec 缺失（plan 内插失败：文本漂移/句被剪/重投影降级）");
			continue;
		}
		// 钉位：at_sec − 提前量，出界钳回 beat 窗口（尾部至少容一个最小槽）
		let st = Math.max(beat.track_st, a.at_sec - ANCHOR_LEAD_SEC);
		st = Math.min(st, beat.track_ed - MIN_SHOT_SEC);
		st = Math.max(st, beat.track_st, cursorMin);
		const room = beat.track_ed - st;
		if (room < MIN_SHOT_SEC - 1e-6) {
			degraded(a, "锚点窗口不足（与前锚重叠或过近 beat 末端）");
			continue;
		}
		const pool = poolByQuery.get(a.query);
		if (!pool?.length) {
			degraded(a, anchorPoolEmptyReason(beat, a.query));
			continue;
		}
		// 取该 query 池首个合格对：不二用/同 beat 归属/精修口径与序贯填充完全同一套
		let pick: Pair | null = null;
		let pickWin: { clipSt: number; clipEd: number } | null = null;
		for (const p of pool) {
			if (opts.consumed.has(p.key)) continue;
			if (pairAvail(p) < Math.min(MIN_SHOT_SEC, room)) continue;
			const owner = opts.beatOwners?.get(p.cand.clip_id);
			if (owner !== undefined && owner !== opts.trackOrder) continue;
			const win = refineWindow(p, sourceWindowFor(p, Math.min(maxAnchorLen, pairAvail(p), room)), room);
			if (!win) continue;
			pick = p;
			pickWin = win;
			break;
		}
		if (!pick || !pickWin) {
			degraded(a, `锚 query「${a.query}」候选耗尽或精修后不足最小槽长`);
			continue;
		}
		const d = pickWin.clipEd - pickWin.clipSt;
		anchorSlots.push({
			clip_id: pick.cand.clip_id,
			query: a.query,
			score: pick.seg.score,
			clip_st: r3(pickWin.clipSt),
			clip_ed: r3(pickWin.clipEd),
			track_st: r3(st),
			track_ed: r3(st + d),
		});
		opts.consumed.add(pick.key);
		opts.beatOwners?.set(pick.cand.clip_id, opts.trackOrder);
		if (pick.pinned && opts.stats) opts.stats.pinnedPlaced++;
		if (pick.hot && opts.stats) opts.stats.hotSlotsPlaced++;
		cursorMin = st + d;
		outcomes.push({
			beat: beat.beat,
			keyword: a.keyword,
			at_sec: a.at_sec,
			track_st: r3(st),
			clip_id: pick.cand.clip_id,
			// 用户 pinned 优先于锚：锚槽被用户钉选候选占据时如实标 pinned（系统选取让位）
			status: pick.pinned ? "pinned" : "planned",
		});
	}

	// 锚点分割区间：各区间内按既有序贯逻辑铺（复用 fillBeatTrack；子区间以 sub-beat 形态传入——
	// beat 名带区间序号只为节奏种子分流，FillSlot 不携带 beat 名故对产物形态零影响）
	const intervals: { st: number; ed: number }[] = [];
	let cur = beat.track_st;
	for (const s of [...anchorSlots].sort((x, y) => x.track_st - y.track_st)) {
		if (s.track_st - cur >= MIN_SHOT_SEC) intervals.push({ st: cur, ed: s.track_st });
		cur = Math.max(cur, s.track_ed);
	}
	if (beat.track_ed - cur >= MIN_SHOT_SEC) intervals.push({ st: cur, ed: beat.track_ed });

	const slots = [...anchorSlots];
	intervals.forEach((iv, i) => {
		const sub: PlanBeat = { ...beat, beat: `${beat.beat}~a${i}`, track_st: iv.st, track_ed: iv.ed };
		slots.push(...fillBeatTrack({ ...opts, beat: sub }));
	});
	slots.sort((x, y) => x.track_st - y.track_st);
	return { slots, anchors: outcomes };
}

// ── 主轨 gap 填充 · fast 规划段（adjust-main-track-gap-fill）──────────────

/** beat 内首轨槽位未覆盖区间（> EPS；beat 间隙不在职责内）。 */
function beatGaps(beat: { track_st: number; track_ed: number }, slots: FillSlot[]): { st: number; ed: number }[] {
	const sorted = [...slots].sort((a, b) => a.track_st - b.track_st);
	const gaps: { st: number; ed: number }[] = [];
	let cur = beat.track_st;
	for (const s of sorted) {
		if (s.track_st - cur > BLACK_BED_MERGE_EPS) gaps.push({ st: cur, ed: s.track_st });
		cur = Math.max(cur, s.track_ed);
	}
	if (beat.track_ed - cur > BLACK_BED_MERGE_EPS) gaps.push({ st: cur, ed: beat.track_ed });
	return gaps;
}

/**
 * fast 填充规划（纯函数，破坏性写入 slots——candidate 槽位并入首轨随常规链路走下载/落轨/登记，
 * extend 就地改写相邻槽位窗口）：candidate（放宽地板取剩余候选）→ extend（段界内延长相邻颗粒）；
 * 段界耗尽的残余留给应用段的 solid 兜底（layBrollTracks 洞检测自动接住）。
 *
 * 判据（design §2）：地板放宽至 0（「随便填」拍板原话）；不二用/同 beat 归属互斥/负词排除照旧；
 * 紧邻避让等节奏机制不适用；图片候选不参与（避免顺带触发运镜计费）；延长上限=段界
 * （fix-broll-flash-frames 段界口径优先于「素材长度」字面），延长不做残片收缩（覆盖优先——
 * 延长被撤销即回到留 gap，比多一帧异景更糟）；图片槽位（material_id 在册）不延长。
 */
function fastFillBeatGaps(o: {
	beat: PlanBeat;
	slots: FillSlot[];
	consumed: Set<string>;
	beatOwners: Map<string, number>;
	noImage?: boolean;
	dedupScope?: DedupScope;
	entries: GapFillEntry[];
}): void {
	const { beat, slots } = o;
	const EPS = BLACK_BED_MERGE_EPS;
	let merged: Pair[] | undefined; // 惰性构建（无 gap 的 beat 零开销）；序=等效分降序（剩余里也先取好的）
	const pairsRelaxed = (): Pair[] => {
		if (!merged) {
			merged = buildQueryPools(beat, 0, { noImage: o.noImage, dedupScope: o.dedupScope })
				.flatMap((q) => q.pool)
				.filter((p) => !isImagePair(p))
				.sort((a, b) => b.rank - a.rank || b.fused - a.fused || b.seg.score - a.seg.score);
		}
		return merged;
	};
	// 槽位的段界回查（延长上限）：找包含该窗口的命中段；整片伪段候选（无 segments）以素材时长为界。
	// dur = 素材物理时长（微残量借帧的硬上限）。
	const segBoundsOf = (slot: FillSlot): { lo: number; hi: number; dur?: number } | undefined => {
		for (const q of beat.queries) {
			for (const rr of q.results ?? []) {
				if (rr.clip_id !== slot.clip_id || rr.kind === "image") continue;
				for (const sg of rr.segments ?? []) {
					if (sg.start <= slot.clip_st + 1e-6 && slot.clip_ed <= sg.end + 1e-6) {
						return { lo: sg.start, hi: sg.end, ...(typeof rr.duration === "number" ? { dur: rr.duration } : {}) };
					}
				}
				if (!rr.segments?.length) return { lo: 0, hi: rr.duration ?? slot.clip_ed, ...(typeof rr.duration === "number" ? { dur: rr.duration } : {}) };
			}
		}
		return undefined;
	};

	for (const g of beatGaps(beat, slots)) {
		let cursor = g.st;
		// ① 候选填充：放宽地板取剩余候选（不二用/归属互斥/负词照旧；节奏机制不适用）
		while (g.ed - cursor >= MIN_SHOT_SEC - EPS) {
			let placed = false;
			for (const p of pairsRelaxed()) {
				if (o.consumed.has(p.key)) continue;
				const room = g.ed - cursor;
				if (pairAvail(p) < Math.min(MIN_SHOT_SEC, room)) continue;
				const owner = o.beatOwners.get(p.cand.clip_id);
				if (owner !== undefined && owner !== 0) continue;
				const win = refineWindow(p, sourceWindowFor(p, Math.min(room, pairAvail(p))), room);
				if (!win) continue;
				const d = win.clipEd - win.clipSt;
				const slot: FillSlot = {
					clip_id: p.cand.clip_id,
					query: p.query,
					score: p.seg.score,
					clip_st: r3(win.clipSt),
					clip_ed: r3(win.clipEd),
					track_st: r3(cursor),
					track_ed: r3(cursor + d),
					gap_fill: true,
				};
				slots.push(slot);
				o.consumed.add(p.key);
				o.beatOwners.set(p.cand.clip_id, 0);
				o.entries.push({ beat: beat.beat, kind: "candidate", clip_id: p.cand.clip_id, track_st: slot.track_st, track_ed: slot.track_ed, sec: r3(d) });
				cursor += d;
				placed = true;
				break;
			}
			if (!placed) break;
		}
		// ② 相邻颗粒延长：先前一颗 clip_ed、再后一颗 clip_st（就近；后颗起点若被句界吸附踩中也尽量保住）。
		// 微残量借帧（≤ 0.05s ≈ 一帧@20fps+）：帧网格吸附与 beat 端点的网格错位会留下毫秒级残洞
		// （黄石实测 1–6ms），做成黑片即亚帧碎片——此档允许延长越过段界（借入邻场景 ≤1 帧，肉眼不可辨），
		// 硬上限仍为素材物理时长/0。
		const MICRO_SLOP = 0.05;
		if (g.ed - cursor > EPS) {
			const prev = slots.find((s) => Math.abs(s.track_ed - cursor) <= EPS);
			if (prev && prev.material_id === undefined) {
				const seg = segBoundsOf(prev);
				if (seg) {
					const residue = g.ed - cursor;
					const hi = residue <= MICRO_SLOP ? Math.min(seg.hi + residue, seg.dur ?? seg.hi + residue) : seg.hi;
					const ext = Math.min(residue, Math.max(0, hi - prev.clip_ed));
					if (ext > EPS) {
						prev.clip_ed = r3(prev.clip_ed + ext);
						prev.track_ed = r3(prev.track_ed + ext);
						o.entries.push({ beat: beat.beat, kind: "extend", clip_id: prev.clip_id, track_st: r3(cursor), track_ed: r3(cursor + ext), sec: r3(ext) });
						cursor = prev.track_ed;
					}
				}
			}
		}
		if (g.ed - cursor > EPS) {
			const next = slots.find((s) => Math.abs(s.track_st - g.ed) <= EPS);
			if (next && next.material_id === undefined) {
				const seg = segBoundsOf(next);
				if (seg) {
					const residue = g.ed - cursor;
					const lo = residue <= MICRO_SLOP ? Math.max(0, seg.lo - residue) : seg.lo;
					const ext = Math.min(residue, Math.max(0, next.clip_st - lo));
					if (ext > EPS) {
						next.clip_st = r3(next.clip_st - ext);
						next.track_st = r3(next.track_st - ext);
						o.entries.push({ beat: beat.beat, kind: "extend", clip_id: next.clip_id, track_st: next.track_st, track_ed: r3(g.ed), sec: r3(ext) });
					}
				}
			}
		}
		// ③ 残余中段（两端段界都到顶）→ 留给应用段 solid 兜底（layBrollTracks 洞检测自动接住）
	}
	slots.sort((a, b) => a.track_st - b.track_st);
}

/** 全 plan 预填充（纯函数）：先定「填哪些颗粒」，供调用方下载后再落轨。
 * pinned 结算（plan 可编辑契约）：铺完统计 plan 内钉选候选的入选/让位（冲突后到让位不报错，
 * summary 明示——stats.pinnedYielded；yielded 名单由 pinnedOutcome 给出供告警指名）。 */
export function planBeatFills(
	plan: BrollPlan,
	lay: number,
	scoreFloor: number,
	opts: {
		noImage?: boolean;
		dedupScope?: DedupScope;
		markWeight?: number;
		markLookup?: MarkLookup;
		/** 句界吸附（adjust-shot-cut-sentence-align）：缺席/ratio≤0/starts 空 = 不激活（旧行为逐字节）。
		 * `calibrated` 为内部标定标记（密度自适应两遍法的第二遍/标定遍自带，调用方 MUST NOT 传）。 */
		cutAlign?: { ratio: number; starts: number[]; calibrated?: boolean };
		/** 主轨 gap 填充（adjust-main-track-gap-fill）：仅 "fast" 触发规划段（candidate/extend）；
		 * 调用方（命令层）已按音频驱动形态预判门控——口播工程 MUST NOT 传（零回归）。 */
		gapFill?: GapFillMode;
	} = {},
): {
	fills: Map<string, FillSlot[][]>;
	clipIds: Set<string>;
	stats: FillStats;
	pinnedOutcome: { requested: string[]; yielded: string[] };
	/** mark 融合统计（add-audio-project-atoms）：按候选 clip 去重的缓存命中/中性计数；w=0 时恒 0/0。 */
	markStats: { hit: number; neutral: number };
	/** 逐锚落位结果（add-keyword-anchored-broll）：plan 无 anchors 时恒空数组（零回归）。 */
	anchors: AnchorOutcome[];
	/** 对齐实测（adjust-shot-cut-sentence-align）：首轨口径；吸附未激活时 undefined（lay JSON 零新键）。 */
	cutAlign?: { target: number; starts_total: number; aligned: number; ratio: number };
	/** fast 规划明细（adjust-main-track-gap-fill）：candidate/extend 条目；仅 gapFill==="fast" 时给出
	 * （solid 的黑片兜底由应用段 layBrollTracks 产出）。 */
	gapFills?: GapFillEntry[];
} {
	const fills = new Map<string, FillSlot[][]>();
	const clipIds = new Set<string>();
	// 全局消费集（D4）：跨 beat 跨 query 跨轨共享——分配即消费、该轮不归还（剥旧重铺后新一轮独立适用）
	const consumed = new Set<string>();
	const stats: FillStats = { emptySlots: 0, emptySlotsByRefine: 0, hotSlotsPlaced: 0, adjacentWaived: 0, pinnedPlaced: 0, pinnedYielded: 0 };
	const markSets: MarkStatsSets = { hit: new Set(), neutral: new Set() };
	const anchorOutcomes: AnchorOutcome[] = [];
	// 句界吸附：每轨一份闭环控制器（跨 beat 共享——比例是全片口径，不是逐 beat 口径）。
	// 密度自适应标定（design §2）：闭环控制的是「吸附机会的放行份额」，而实测比例的分母是**句起点**
	// ——够不着的句起点（带宽外/锚槽内/供长不足）把实测系统性压到份额×可达覆盖率。先以全吸（份额 1）
	// 跑一遍标定出本工程的可达覆盖率 C，再按份额 = ratio / C 跑正式遍，实测即贴目标。两遍全确定性。
	const cutAlignOn = opts.cutAlign && opts.cutAlign.ratio > 0 && opts.cutAlign.starts.length > 0 ? opts.cutAlign : undefined;
	let cutEffRatio = cutAlignOn?.ratio ?? 0;
	if (cutAlignOn && !cutAlignOn.calibrated && cutAlignOn.ratio < 1) {
		const cal = planBeatFills(plan, lay, scoreFloor, {
			...opts,
			cutAlign: { ratio: 1, starts: cutAlignOn.starts, calibrated: true },
		});
		const cov = cal.cutAlign?.ratio ?? 0;
		cutEffRatio = cov > 0 ? Math.min(1, cutAlignOn.ratio / cov) : 1;
	}
	const cutStates = new Map<number, CutAlignState>();
	const cutAlignFor = (k: number): CutAlignOpts | undefined => {
		if (!cutAlignOn) return undefined;
		let st = cutStates.get(k);
		if (!st) {
			st = { chances: 0, snapped: 0 };
			cutStates.set(k, st);
		}
		return { ratio: cutEffRatio, starts: cutAlignOn.starts, state: st };
	};
	// 同槽候选组互斥（同 beat 跨轨同素材互斥）；按 beat 留存——gap 填充规划段（两阶段在后）要接着记账
	const ownersByBeat = new Map<string, Map<string, number>>();
	for (const beat of plan.beats) {
		const perTrack: FillSlot[][] = [];
		const beatOwners = new Map<string, number>();
		ownersByBeat.set(beat.beat, beatOwners);
		for (let k = 0; k < Math.max(0, lay); k++) {
			const trackOpts = {
				beat,
				trackOrder: k,
				consumed,
				scoreFloor,
				noImage: opts.noImage,
				dedupScope: opts.dedupScope,
				markWeight: opts.markWeight,
				markLookup: opts.markLookup,
				markStats: markSets,
				beatOwners,
				stats,
				cutAlign: cutAlignFor(k),
			};
			// 锚点优先布局只作用于首轨（口径注记见 fillBeatTrackWithAnchors 头注）；无锚 beat 走原路零回归
			let slots: FillSlot[];
			if (k === 0 && Array.isArray(beat.anchors) && beat.anchors.length) {
				const r = fillBeatTrackWithAnchors(trackOpts);
				slots = r.slots;
				anchorOutcomes.push(...r.anchors);
			} else {
				slots = fillBeatTrack(trackOpts);
			}
			perTrack.push(slots);
			for (const s of slots) clipIds.add(s.clip_id);
		}
		fills.set(beat.beat, perTrack);
	}
	// pinned 结算：requested = plan 内全部钉选候选（去重）；yielded = 未落任何槽位者（后到让位/枯竭/被排除）
	const pinnedRequested = new Set<string>();
	for (const beat of plan.beats) {
		for (const q of beat.queries) for (const r of q.results ?? []) if (r.pinned === true) pinnedRequested.add(r.clip_id);
	}
	// ── 主轨 gap 填充 · fast 规划段（adjust-main-track-gap-fill）──
	// 两阶段：全部 beat 常规填充完成后再补 gap——gap 填充 MUST NOT 抢先消费掉后续 beat
	// 常规填充要用的候选（不二用消费集跨 beat 共享）。candidate 槽位并入首轨（gap_fill 标记，
	// 随常规链路走下载/落轨/登记），extend 就地改写；solid 兜底归应用段（layBrollTracks）。
	let gapFillEntries: GapFillEntry[] | undefined;
	if (opts.gapFill === "fast" && Math.max(0, lay) > 0) {
		gapFillEntries = [];
		for (const beat of plan.beats) {
			const slots = fills.get(beat.beat)?.[0];
			if (!slots) continue;
			fastFillBeatGaps({
				beat,
				slots,
				consumed,
				beatOwners: ownersByBeat.get(beat.beat)!,
				noImage: opts.noImage,
				dedupScope: opts.dedupScope,
				entries: gapFillEntries,
			});
			for (const s of slots) clipIds.add(s.clip_id); // 新填候选进下载集
		}
	}
	const yielded = [...pinnedRequested].filter((id) => !clipIds.has(id));
	stats.pinnedYielded = yielded.length;
	// 对齐实测（adjust-shot-cut-sentence-align）：首轨最终槽位口径——主轨 gap 填充
	// （adjust-main-track-gap-fill）已在上方完成，计量恒按最终产物如实执行
	let cutAlignStats: { target: number; starts_total: number; aligned: number; ratio: number } | undefined;
	if (cutAlignOn) {
		const m = measureCutAlignment({
			beats: plan.beats.map((b) => ({ track_st: b.track_st, track_ed: b.track_ed, slots: fills.get(b.beat)?.[0] ?? [] })),
			starts: cutAlignOn.starts,
		});
		cutAlignStats = { target: cutAlignOn.ratio, ...m };
	}
	return {
		fills,
		clipIds,
		stats,
		pinnedOutcome: { requested: [...pinnedRequested], yielded },
		markStats: { hit: markSets.hit.size, neutral: markSets.neutral.size },
		anchors: anchorOutcomes,
		...(cutAlignStats ? { cutAlign: cutAlignStats } : {}),
		...(gapFillEntries ? { gapFills: gapFillEntries } : {}),
	};
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

/**
 * 形态判据（adjust-black-bed-audio-driven-skip / adjust-main-track-gap-fill 共用纯函数）：
 * 给定轨集内是否存在「保留轨/遮挡对象」= `track_timeline` 非空且含**任一** material 非自产前缀
 * （`broll-`/`ex-solid-` 之外）clip 的 video 轨。material 非 string 的 clip 按非自产计
 * （保守方向 = 判口播形态：多铺黑底/不动主轨，MUST NOT 误跳/误填）。
 * 无保留轨 ⇒ 音频驱动形态（TTS 工程：video 轨全自产 B-roll，底下没有 A-roll）。
 */
export function projectHasShieldTrack(tracks: { track_timeline?: unknown }[]): boolean {
	return tracks.some((t) => {
		const clips = Array.isArray(t.track_timeline) ? (t.track_timeline as { material?: unknown }[]) : [];
		return (
			clips.length > 0 &&
			clips.some((c) => {
				const m = typeof c?.material === "string" ? c.material : "";
				return !(m.startsWith(BROLL_MATERIAL_PREFIX) || m.startsWith(SOLID_MATERIAL_PREFIX));
			})
		);
	});
}

export interface LayResult {
	next: Record<string, unknown>;
	/** laidTracks 只含**本轮目标层候选轨**（人读计数不把黑底/他层保留轨算进来）；黑轨另以 blackTrack 报。 */
	summary: {
		/** 本轮铺轨的来源层（add-broll-dedup-and-layering）。 */
		sourceLayer: SourceLayer;
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
		/** 音频驱动工程跳铺黑底（adjust-black-bed-audio-driven-skip，主理人 2026-08-21 拍板）：
		 * 剥离后无「保留轨」（非自产 video 内容轨 = 黑底的遮挡对象）而判定跳铺时为 "audio_driven"，
		 * 其余（照铺 / --no-black-bed / 拒铺 / 零内容轨）恒 null。跳铺 MUST NOT 静默——
		 * 命令层人读完成行与 lay JSON（仅跳铺时出现该键）同口径明示。 */
		blackBedSkipped: "audio_driven" | null;
		/** 全片累计黑底空洞秒数（= blackBedHoles 各段 sec 之和；未铺黑底时恒 0）。 */
		blackBedHoleSec: number;
		/**
		 * 检出的黑底空洞**全量**（按 track_st 升序）——MUST NOT 按告警阈值过滤：
		 * 阈值只门控人读告警，机读字段一旦被过滤，`0` 就会同时意味着「没空洞」与「有但没超阈值」。
		 */
		blackBedHoles: BlackBedHole[];
		/** 主轨 gap 填充账面（adjust-main-track-gap-fill）：仅音频驱动形态且 mode ≠ none 时出现
		 * （口播工程 / none / 不适用路径 MUST NOT 出现该键——lay JSON 零新键）。 */
		gapFill?: { mode: GapFillMode; filledSec: number; fills: GapFillEntry[] };
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
	/** 来源层（laid.source_layer / track_layers 双源；旧登记缺席=undefined，按层剥旧走过渡口径）。 */
	layer?: SourceLayer;
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
	const trackLayers =
		meta.track_layers && typeof meta.track_layers === "object" ? (meta.track_layers as Record<string, unknown>) : {};
	const out: ExpectedTrack[] = [];

	const byTrack = new Map<number, { count: number; layer?: SourceLayer }>();
	for (const b of beats) {
		for (const l of Array.isArray(b?.laid) ? b.laid : []) {
			const idx = (l as { track_index?: unknown }).track_index;
			const slots = (l as { slots?: unknown }).slots;
			if (typeof idx !== "number" || !Array.isArray(slots) || slots.length === 0) continue;
			const cur = byTrack.get(idx) ?? { count: 0 };
			cur.count += slots.length;
			const sl = (l as { source_layer?: unknown }).source_layer;
			if (!cur.layer && isSourceLayer(sl)) cur.layer = sl;
			byTrack.set(idx, cur);
		}
	}
	for (const [trackIndex, agg] of [...byTrack.entries()].sort((a, b) => a[0] - b[0])) {
		const registered = trackLayers[String(trackIndex)];
		const layer = agg.layer ?? (isSourceLayer(registered) ? registered : undefined);
		out.push({ kind: "candidate", trackIndex, clipCount: agg.count, ...(layer ? { layer } : {}) });
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
 * 轨的层归属判定（add-broll-dedup-and-layering D3 双源）：登记 source_layer 优先；
 * 无登记时按材料前缀推断——全部 clip 均 `broll-local-` 前缀 ⇒ local；其余 undefined
 * （过渡期保守：层归属未知的存量自产轨不剥、告警）。
 */
export function resolveTrackLayer(track: LooseTrack, registered?: SourceLayer): SourceLayer | undefined {
	if (registered) return registered;
	const mats = (Array.isArray(track.track_timeline) ? track.track_timeline : []).map((c) =>
		typeof c?.material === "string" ? c.material : "",
	);
	if (mats.length && mats.every((m) => m.startsWith(BROLL_LOCAL_MATERIAL_PREFIX))) return "local";
	return undefined;
}

/**
 * 铺轨主函数（纯函数，不做 IO）：按层剥离上次自产物 → 按 fills 平铺 append 素材与 overlay 轨 →
 * 层带 track_index 分配（local>concept>common 自上而下写死，黑底恒在全部带区之下）→
 * 写 struct_meta.broll（本层登记替换 + 他层登记保留平移）。下载失败的槽位被丢弃（留空，调用方已告警）
 * ——默认铺黑底时该处露**黑底垫轨**，仅 `--no-black-bed` / 该 beat 未铺黑底时才露 A-roll。
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
	/** 图片运镜/静态兜底材料实体（材料 id → materials 条目；add-matrix-local-image-broll 3.2）：
	 * 命令层运镜准备阶段产出（ffprobe 实测），槽位以 FillSlot.material_id 指向其键；纯函数只登记不做 IO。 */
	injectedMaterials?: Map<string, LooseMaterial>;
	/** 本轮铺轨的来源层（add-broll-dedup-and-layering D2/D3）：按层剥旧与带区分配的目标层。
	 * 缺省按 plan.member_type 推导（local → local；云端 → common）；概念层由命令层显式传入。 */
	sourceLayer?: SourceLayer;
	/** 主轨 gap 填充（adjust-main-track-gap-fill）：mode + fast 规划明细（candidate/extend）。
	 * 应用与否由本函数以剥离后终态权威判定（音频驱动形态 ∧ 目标层首轨=最低号内容轨）；
	 * 不适用时规划槽位（gap_fill 标记）被滤出落轨。缺席/mode none = 现状零回归。 */
	gapFill?: { mode: GapFillMode; planned: GapFillEntry[] };
}): LayResult {
	const { gtrk, plan, lay, fills, downloads } = opts;
	const blackBedOn = opts.blackBed !== false;
	const forceRelay = opts.forceRelay === true;
	const targetLayer: SourceLayer = opts.sourceLayer ?? (plan.member_type === "local" ? "local" : "common");
	const warnings: string[] = [];
	const videoTracks = [...((gtrk.video_track as LooseTrack[] | undefined) ?? [])];
	const materials = [...((gtrk.materials as LooseMaterial[] | undefined) ?? [])];
	const structMeta = { ...((gtrk.struct_meta as Record<string, unknown> | undefined) ?? {}) };

	// ── 按层剥离自产物（幂等重铺；判据 = 自产指纹 + 层归属，登记缺失宁留勿删）──
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
	// 三分（D3 按层剥旧）：removed=目标层自产轨 ∪ 黑底轨 ∪（forceRelay 下的已编辑轨）；
	// keptBand=他层自产轨（保留但随带区平移——L2 不比对 track_index，平移安全）；
	// keptOther=用户轨 ∪ 层归属未知的存量自产轨（过渡口径：保守不剥 + 告警，位置不动）。
	const removedTracks: LooseTrack[] = [];
	const keptOtherTracks: LooseTrack[] = [];
	const keptBandTracks: { track: LooseTrack; layer: SourceLayer; oldIndex: number }[] = [];
	const transitionKeptIndices: number[] = [];
	for (let i = 0; i < videoTracks.length; i++) {
		const t = videoTracks[i]!;
		const v = verdicts[i]!;
		if (v.cls === "self-produced-edited") {
			if (forceRelay) removedTracks.push(t);
			else keptOtherTracks.push(t);
			continue;
		}
		if (v.cls !== "self-produced") {
			keptOtherTracks.push(t);
			continue;
		}
		if (v.matched?.kind === "black") {
			removedTracks.push(t); // 黑底轨恒重铺（位置=全部带区之下，随层结构平移）
			continue;
		}
		const layer = resolveTrackLayer(t, v.matched?.layer);
		if (layer === targetLayer) {
			removedTracks.push(t);
		} else if (layer !== undefined) {
			keptBandTracks.push({ track: t, layer, oldIndex: typeof t.track_index === "number" ? t.track_index : 0 });
		} else {
			keptOtherTracks.push(t);
			if (typeof t.track_index === "number") transitionKeptIndices.push(t.track_index);
			warnings.push(
				`存量自产轨 track_index=${t.track_index} 无 source_layer 层登记、也无法从材料前缀推断层归属：` +
					`按过渡期保守口径保留不剥（本轮新轨照常追加）。要重铺它请在客户端删除该轨后重跑，或先跑一轮对应层的铺轨重建登记。`,
			);
		}
	}
	const keptTracks = [...keptOtherTracks, ...keptBandTracks.map((b) => b.track)];

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
				sourceLayer: targetLayer,
				laidTracks: [],
				laidClips: 0,
				beatsWithCandidates: beatsWithCands,
				blackTrack: null,
				removedTracks: [],
				keptEditedTracks,
				refused: true,
				// 拒铺 = 工程零改动，黑底既没铺也没走到形态判定，跳铺标记恒 null
				blackBedSkipped: null,
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

	// 手工黑底轨检测（★ fix-broll-zorder-contract-drift 文案随契约口径修正）：用户手加的纯色轨
	// 会被当用户轨保留——契约下（大号=上层）新候选轨号更大、恒在其上不被遮，但会与自动黑底
	// 重复垫底、且占着 keptOther 位顶高整段带区号。宁可告警不猜删（登记缺失宁留勿删铁律）。
	for (const t of keptTracks) {
		const clips = t.track_timeline ?? [];
		if (!clips.length) continue;
		if (clips.every((c) => typeof c.material === "string" && c.material.startsWith(SOLID_MATERIAL_PREFIX))) {
			warnings.push(
				`检测到疑似手工纯色底轨（track_index=${t.track_index}）：与自动黑底垫轨功能重复。建议删除该轨后重跑，或用 --no-black-bed 保留手工轨。`,
			);
		}
	}

	// ── 层带布局（D2 三带区间制）：baseIndex 只数「非带区保留轨」（用户轨/过渡轨），带区从其上叠放；
	// ★ fix-broll-zorder-contract-drift：契约=track_index 越大越靠前（上层）。黑底占 baseIndex
	// （最小号、垫底，blackBedOn 时恒预留——最终未铺成则留空号，index 不要求连续无害）；
	// 带区自 baseIndex+1 起按 SOURCE_LAYER_ORDER **反序**（common→concept→local）升号排布：
	// common 最小号（紧贴黑底之上）、local 最大号（契约上层=层序铁律「本地最上」）。
	const canvas = Array.isArray(gtrk.video_size) ? (gtrk.video_size as number[]) : [1920, 1080];
	const baseIndex =
		keptOtherTracks.reduce((mx, t) => Math.max(mx, typeof t.track_index === "number" ? t.track_index : 0), -1) + 1;
	// ── 形态判定（adjust-black-bed-audio-driven-skip，主理人 2026-08-21 拍板）──
	// 黑底的全部职责 = B-roll 空档遮住底下的口播 A-roll。剥离后保留集里没有「保留轨」（非自产
	// video 内容轨 = 遮挡对象）⇒ 音频驱动形态（TTS 工程：video 轨全自产 B-roll，底下没有 A-roll，
	// 空档露的本来就是画布底色）⇒ 跳铺黑底、也不预留黑底号（候选轨带区自 baseIndex 起）。
	// 判定复用既有自产口径（自产素材恒为 broll-/ex-solid- 前缀，与 timeline-projection 的
	// isSelfLaidTrackByMaterial 同族取反）；只扫 keptOtherTracks 即完备——removedTracks 与
	// keptBandTracks 按定义均为自产，self-produced-edited 在非 forceRelay 下已走 ②-B 整轮拒铺。
	// material 非 string 的 clip 按非自产计（保守方向 = 多铺黑底，MUST NOT 误跳）。
	// 判据抽为 projectHasShieldTrack 纯函数（adjust-main-track-gap-fill 复用同一形态口径，两处不写两遍）
	const hasShieldTargetTrack = projectHasShieldTrack(keptOtherTracks);
	const blackBedReserved = blackBedOn && hasShieldTargetTrack ? 1 : 0;
	const bandCounts: Record<SourceLayer, number> = { local: 0, concept: 0, common: 0 };
	for (const b of keptBandTracks) bandCounts[b.layer]++;
	const bandStart = {} as Record<SourceLayer, number>;
	let bandEnd = baseIndex + blackBedReserved;
	for (const layer of [...SOURCE_LAYER_ORDER].reverse()) {
		bandStart[layer] = bandEnd;
		bandEnd += layer === targetLayer ? Math.max(0, lay) : bandCounts[layer];
	}
	// 他层保留轨平移进各自带区（带内按旧号相对序；L2 判据不比对 track_index，平移安全）
	const bandIndexRemap = new Map<number, { newIndex: number; layer: SourceLayer }>();
	const rebasedBandTracks: LooseTrack[] = [];
	for (const layer of SOURCE_LAYER_ORDER) {
		if (layer === targetLayer) continue;
		const members = keptBandTracks.filter((b) => b.layer === layer).sort((a, b) => a.oldIndex - b.oldIndex);
		members.forEach((b, j) => {
			const newIndex = bandStart[layer] + j;
			bandIndexRemap.set(b.oldIndex, { newIndex, layer });
			rebasedBandTracks.push(b.oldIndex === newIndex ? b.track : { ...b.track, track_index: newIndex });
		});
	}
	const candById = new Map<string, PlanResult>();
	for (const beat of plan.beats) for (const c of mergedCandidates(beat)) if (!candById.has(c.clip_id)) candById.set(c.clip_id, c);

	// ── 主轨 gap 填充 · 应用段判定（adjust-main-track-gap-fill）──
	// 权威形态判定以**剥离后终态**为准（与黑底形态判定同口径）：音频驱动（无保留轨/keptOther 全空）
	// ∧ 目标层首轨号 = 最低号内容轨（= 主轨）。多层音频驱动工程目标层首轨非最低号（主轨是他层
	// 保留轨）时不填——改保留轨会砸他层登记指纹（L2 条数吻合链路）。不适用时规划槽位（gap_fill
	// 标记）在下方过滤中被滤出落轨（extend 的窗口改写保留——仍是段界内合法窗口，不产生 gap）。
	const gapFillReq = opts.gapFill && opts.gapFill.mode !== "none" ? opts.gapFill : undefined;
	const mainTrackIdx = bandStart[targetLayer];
	const lowerBandOccupied = SOURCE_LAYER_ORDER.some(
		(l) => l !== targetLayer && bandCounts[l] > 0 && bandStart[l] < mainTrackIdx,
	);
	const gapFillOn =
		gapFillReq !== undefined && !hasShieldTargetTrack && keptOtherTracks.length === 0 && !lowerBandOccupied && Math.max(0, lay) > 0;
	const gapSolidEntries: GapFillEntry[] = [];
	let gapFillCanvasWarned = false;

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
			// 下载失败的槽位丢弃（留空）；图片槽位以 material_id 指向注入材料（运镜/静态兜底）；全空轨槽不建 laid 条目；
			// gap 填充规划槽位在填充不适用时滤出（adjust-main-track-gap-fill 应用段门控）
			const slots = perTrack[k].filter(
				(s) =>
					(!s.gap_fill || gapFillOn) &&
					(downloads.has(s.clip_id) || (s.material_id !== undefined && opts.injectedMaterials?.has(s.material_id))),
			);
			if (!slots.length) continue;
			const trackIndex = bandStart[targetLayer] + k;
			const bucket = trackClips.get(trackIndex) ?? [];
			slots.forEach((s, i) => {
				const materialId = s.material_id ?? brollMaterialIdFor(s.clip_id);
				if (!newMaterialsById.has(materialId)) {
					const injected = s.material_id !== undefined ? opts.injectedMaterials?.get(s.material_id) : undefined;
					if (injected) {
						// 图片运镜/静态兜底材料：命令层已备好实体（ffprobe 实测/静态图片形态），原样登记
						newMaterialsById.set(materialId, { ...injected });
					} else {
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
			laid.push({ order: k, clip_id: slots[0].clip_id, track_index: trackIndex, slots, source_layer: targetLayer });
		}

		// ── 主轨 gap 填充 · solid 兜底（adjust-main-track-gap-fill）：首轨幸存槽位盖不住的洞
		// （solid 模式全部 gap / fast 段界耗尽残余 / 下载失败退化 / 整 beat 零槽位）逐洞落黑片
		// ——磁吸安全不变量（beat 包络内主轨零 gap）在此收口，不依赖下载成败。
		if (gapFillOn) {
			const mainLaid = laid.find((l) => l.order === 0);
			const { holes } = computeBlackBedHoles({
				beats: [{ beat: beat.beat, track_st: beat.track_st, track_ed: beat.track_ed, slots: mainLaid?.slots ?? [] }],
			});
			if (holes.length) {
				if (!isLayoutableCanvas([canvas[0], canvas[1]])) {
					if (!gapFillCanvasWarned) {
						gapFillCanvasWarned = true;
						warnings.push(
							`画布尺寸非法（${canvas[0]}x${canvas[1]}），主轨 gap 黑片兜底跳过——主轨仍有 gap，客户端若开主轨磁吸请注意与配音错位的风险。`,
						);
					}
				} else {
					const width = canvas[0]!;
					const height = canvas[1]!;
					const solidId = solidMaterialId({ hex: BLACK_BED_HEX, width, height });
					if (!newMaterialsById.has(solidId)) {
						// 黑片 material MUST NOT 带 duration（客户端 resolveTrim 铁律，与黑底垫轨同条）
						newMaterialsById.set(solidId, {
							id: solidId,
							path: solidRelPath({ hex: BLACK_BED_HEX, width, height }),
							video_size: [width, height],
						});
					}
					const bucket = trackClips.get(mainTrackIdx) ?? [];
					let entry = mainLaid;
					if (!entry) {
						// 整 beat 零常规槽位：为其新建首轨 laid 条目（clip_id=黑片材料 id，整段黑片精修可见）
						entry = { order: 0, clip_id: solidId, track_index: mainTrackIdx, slots: [], source_layer: targetLayer };
						laid.push(entry);
						laid.sort((a, b) => a.order - b.order);
					}
					holes.forEach((h, i) => {
						const len = r3(h.track_ed - h.track_st);
						bucket.push({
							clip_id: `${beat.beat}-gapfill-${i}`,
							material: solidId,
							clip_st: 0,
							clip_ed: len,
							track_st: h.track_st,
							track_ed: h.track_ed,
							duration: len,
						});
						// 黑片槽位照进 slots 登记（幂等硬约束：轨上 clip 数 === 登记 slots 数，L2 指纹闭环）
						entry!.slots.push({ clip_id: solidId, query: "gap_fill", score: 0, clip_st: 0, clip_ed: len, track_st: h.track_st, track_ed: h.track_ed, gap_fill: true });
						gapSolidEntries.push({ beat: beat.beat, kind: "solid", track_st: h.track_st, track_ed: h.track_ed, sec: h.sec });
						laidClips++;
					});
					trackClips.set(mainTrackIdx, bucket);
					entry.slots.sort((a, b) => a.track_st - b.track_st);
				}
			}
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
					// 层登记（add-broll-dedup-and-layering 3.1）：候选逐条继承本轮来源层
					source_layer: targetLayer,
				};
				// 本地附加键仅本地候选出现（云端 struct_meta 产物逐字节不变）
				if (isLocal) {
					if (typeof c.local_path === "string") entry.local_path = c.local_path;
					entry.cover_path = opts.covers?.get(c.clip_id) ?? null;
					// 图片候选保留源图路径（面板溯源与重生成，matrix-lay-tracks spec）
					if (c.kind === "image" && typeof c.local_path === "string") entry.source_image_path = c.local_path;
				}
				return entry;
			}),
			laid,
			pinned: null,
		};
		if (typeof beat.per_shot_sec === "number") metaBeat.per_shot_sec = beat.per_shot_sec;
		metaBeats.push(metaBeat);
	}

	// gap_fill summary（adjust-main-track-gap-fill）：规划明细中素材仍在下载集者 + solid 兜底明细，
	// 时间升序。下载失败的 candidate 槽位已被丢弃、其窗口由洞检测落黑片——明细 MUST NOT 以成功姿态保留。
	// 有键但 fills 空 = 「填充开着、本轮无洞可填」（与「没开」机读可分）。
	let gapFillSummary: { mode: GapFillMode; filledSec: number; fills: GapFillEntry[] } | undefined;
	if (gapFillOn && gapFillReq) {
		const surviving = gapFillReq.planned.filter((e) => e.clip_id !== undefined && downloads.has(e.clip_id));
		const fillsAll = [...surviving, ...gapSolidEntries].sort((a, b) => a.track_st - b.track_st || a.track_ed - b.track_ed);
		gapFillSummary = { mode: gapFillReq.mode, filledSec: r3(fillsAll.reduce((n, f) => n + f.sec, 0)), fills: fillsAll };
	}

	const createdTracks = [...trackClips.entries()]
		.filter(([, clips]) => clips.length > 0)
		.sort((a, b) => a[0] - b[0])
		.map(([track_index, clips]) => ({
			track_index,
			track_size: [canvas[0], canvas[1]],
			// ★ 走查实锤(2026-08-19 主理人):B-roll 候选轨恒静音——素材原声(如原片博主解说)会与配音/口播打架;
			// 此前恒 false 未暴露是因矩阵影视切片多为无声,本地素材路(原片带声)首次拍出。要听原声在客户端
			// 点开该轨 muted 即可(轨级开关,契约双层语义)。黑片轨同步置 true(png 无音轨,语义统一)。
			muted: true,
			track_timeline: clips.sort((a, b) => (a.track_st as number) - (b.track_st as number)),
		}));

	// ── 他层登记保留合并（3.1/3.3）：本层（targetLayer）登记由本轮 metaBeats 整体替换；
	// 他层保留轨的 laid 条目按 bandIndexRemap 平移号后并回；过渡保留轨（无层登记）条目按原号保留
	// ——期望指纹链路（expectedSelfProducedTracks）因此跨层跨轮闭环。老式登记（candidates 无
	// source_layer）随本层替换语义丢弃（与旧版「整体重写」口径一致，不为过渡态发明新形态）。
	{
		const survivors = new Map<number, { newIndex: number; layer?: SourceLayer }>();
		for (const [oldIndex, v] of bandIndexRemap) survivors.set(oldIndex, v);
		for (const idx of transitionKeptIndices) if (!survivors.has(idx)) survivors.set(idx, { newIndex: idx });
		if (prevBroll && survivors.size > 0) {
			const beatsByName = new Map(metaBeats.map((b) => [b.beat, b]));
			for (const pb of Array.isArray(prevBroll.beats) ? prevBroll.beats : []) {
				if (!pb || typeof pb !== "object") continue;
				const survivingLaid = (Array.isArray(pb.laid) ? pb.laid : [])
					.filter((l) => typeof l?.track_index === "number" && survivors.has(l.track_index))
					.map((l) => {
						const s = survivors.get(l.track_index)!;
						return { ...l, track_index: s.newIndex, ...(s.layer ? { source_layer: s.layer } : {}) };
					});
				const survivingCands = (Array.isArray(pb.candidates) ? pb.candidates : []).filter(
					(c) => isSourceLayer(c?.source_layer) && c.source_layer !== targetLayer,
				);
				if (!survivingLaid.length && !survivingCands.length) continue;
				const into = beatsByName.get(pb.beat);
				if (into) {
					into.laid.push(...survivingLaid);
					for (const c of survivingCands) {
						if (!into.candidates.some((x) => x.clip_id === c.clip_id && x.source_layer === c.source_layer)) {
							into.candidates.push(c);
						}
					}
				} else {
					const carried: BrollMetaBeat = { ...pb, candidates: survivingCands, laid: survivingLaid };
					metaBeats.push(carried);
					beatsByName.set(carried.beat, carried);
				}
			}
		}
	}

	// ── 纯黑底垫轨（track_index 恒 = 全部层带之下 bandEnd，比所有候选轨都大）──
	// gtrk v1 里非主轨 track_index 越大越靠下（客户端 importer 升序进 overlay、overlay[0] 最上层），
	// 故黑底恰好落在「全部候选轨（各层带）之下、口播主轨之上」，B-roll 期间遮住 A-roll。
	// 他层保留轨在场时即使本轮零新轨也要重铺黑底（黑轨已被恒剥，位置随层结构平移）。
	//
	// ★ fix-broll-black-bed-regression：黑底在场不变量 —— **剥后仍有任何自产 B-roll 内容轨在场，
	//   黑底就必须重铺**。黑轨剥离是无条件先行的（见上方 removedTracks 分支 `v.matched?.kind === "black"`），
	//   所以这个条件漏掉任何一类「留下来的内容轨」，那一轮就会把黑底剥光而不重铺，
	//   存量 B-roll 期间直接露出口播 A-roll。三类必须全含：
	//     ① createdTracks        本轮新铺的目标层候选轨
	//     ② rebasedBandTracks    他层自产轨（有层登记，随带区平移）
	//     ③ transitionKeptIndices 存量自产轨但**无层登记也推不出层**（add-broll-dedup-and-layering
	//        之前铺的老工程），按过渡口径保留不剥 —— 原实现漏了这一支，就是本回归的根因。
	//   注：「已被你编辑」的自产轨（keptEditedTracks）走不到这里 —— 那种情形上方 ②-B 已整轮拒铺、
	//   `next: gtrk` 原样返回，黑底因此天然保住，不需要也不应在此重复兜。
	const hasSelfProducedContentInPlace =
		createdTracks.length > 0 || rebasedBandTracks.length > 0 || transitionKeptIndices.length > 0;
	// ★ adjust-black-bed-audio-driven-skip（2026-08-21 拍板）：剥后无保留轨（遮挡对象）⇒ 跳铺黑底。
	// 音频驱动工程的空档露的是画布底色，黑底零遮挡作用还被客户端用户误读成事故轨；跳铺标记
	// blackBedSkipped 走 summary 明示（人读完成行 + lay JSON），MUST NOT 静默。
	const blackBedSkipped: "audio_driven" | null =
		blackBedOn && !hasShieldTargetTrack && hasSelfProducedContentInPlace ? "audio_driven" : null;
	let blackTrack: number | null = null;
	let blackTrackObj: Record<string, unknown> | null = null;
	if (blackBedOn && hasShieldTargetTrack && hasSelfProducedContentInPlace) {
		if (!isLayoutableCanvas([canvas[0], canvas[1]])) {
			warnings.push(
				`画布尺寸非法（${canvas[0]}x${canvas[1]}），跳过铺纯黑底轨（候选轨照常铺）。`,
			);
		} else {
			// 时窗 = **任一层至少落成一条候选轨**的 beat 的包络（整条铺，非槽位并集；含他层保留登记）。
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
				// ★ fix-broll-zorder-contract-drift：黑底取预留的 baseIndex（最小号=契约底层垫底），
				// 不再取 bandEnd（旧值=最大号，按契约会盖住全部候选轨——打样客户端截图实锤）
				blackTrack = baseIndex;
				blackTrackObj = {
					track_index: blackTrack,
					track_size: [width, height],
					muted: true,
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

	// ★ fix-broll-black-bed-regression：静默兜底断言。
	// 本次回归之所以能瞒过客户与我们，是因为它在 CLI 输出上**双重静默**：
	//   ① BUG 态只在绿色 ✅ 摘要里印一句「未铺纯黑底垫轨」，零 ⚠️；
	//   ② 本来最该提示异常的「黑底空洞」遥测被门控在 `blackTrack !== null`（见下），于是一并归零。
	// 于是「该有黑底却没有」这件事在人读与机读两侧同时消失。上面那个漏支已修，
	// 但「内容轨在场 ∧ 未显式关断 ∧ blackTrack 落 null」这个组合本身还没有兜底 ——
	// 将来若新增别的 null 分支，会重蹈同一种静默。这里补一条：凡走到该组合，MUST 出告警。
	// （画布非法与 PNG 落盘失败两条既有 null 分支自带告警，此处会与之叠加，属可接受的重复提示；
	//  宁可多说一句，也不要再让「黑底没了」无声无息。）
	// ★ adjust-black-bed-audio-driven-skip：组合补入 hasShieldTargetTrack 一元——音频驱动跳铺的
	// null 是拍板内有意结果（底下没有口播 A-roll 可露），MUST NOT 误鸣本兜底；其明示走 blackBedSkipped。
	if (blackBedOn && hasShieldTargetTrack && hasSelfProducedContentInPlace && blackTrack === null) {
		warnings.push(
			`异常：本轮有 B-roll 内容轨在场、也没有 --no-black-bed，却没能铺出纯黑底垫轨 —— ` +
				`这些 B-roll 段落底下会直接露出口播 A-roll。请回报此告警（含本轮命令行）以便定位。`,
		);
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
	// 在册全集 = 本层新轨 ∪ 他层保留轨（平移后号）∪ 过渡保留自产轨（原号）；层归属进 track_layers。
	const registeredIndices = [
		...laidTrackIndices,
		...rebasedBandTracks.map((t) => t.track_index as number),
		...transitionKeptIndices,
	].sort((a, b) => a - b);
	const trackLayers: Record<string, SourceLayer> = {};
	for (const idx of laidTrackIndices) trackLayers[String(idx)] = targetLayer;
	for (const [, v] of bandIndexRemap) if (v.layer) trackLayers[String(v.newIndex)] = v.layer;
	const broll: StructMetaBroll = {
		contract_version: "v1",
		generated_at: opts.generatedAt,
		plan_path: opts.planPath,
		// 黑轨也登记进 lay_tracks：老版 CLI 只读这个键剥旧，不在册就会把黑轨当用户轨保留、
		// 顶高 baseIndex，令下次新候选轨落到黑轨之下整片黑。
		lay_tracks: blackTrack === null ? registeredIndices : [...registeredIndices, blackTrack],
		track_layers: trackLayers,
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

	// 带区轨（他层平移轨 + 本层新轨）按 track_index 升序落数组；黑底收尾（渲染层序=数组内号序一致）
	const bandTracksSorted = [...rebasedBandTracks, ...createdTracks].sort(
		(a, b) => (a.track_index as number) - (b.track_index as number),
	);
	const next: Record<string, unknown> = {
		...gtrk,
		materials: [...mergedMaterials.values()],
		video_track: [...keptOtherTracks, ...bandTracksSorted, ...(blackTrackObj ? [blackTrackObj] : [])],
		struct_meta: { ...structMeta, broll },
	};
	return {
		next,
		summary: {
			sourceLayer: targetLayer,
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
			blackBedSkipped,
			blackBedHoleSec,
			blackBedHoles,
			...(gapFillSummary ? { gapFill: gapFillSummary } : {}),
		},
		broll,
		warnings,
	};
}
