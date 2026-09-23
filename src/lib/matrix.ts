/**
 * gtrk matrix —— B-roll 双口检索纯逻辑（matrix-command / broll-plan-contract spec）。
 *
 * 身份路由（档位主/子类型次，不降级不缓存）：matrix_member_type === "internal" → /task/custom/video_clip_search
 * （原 /task/custom/search，网关 add-custom-search-alignment 改名，adjust-matrix-custom-route-alignment 切换）；
 * 其他任何值（external/缺失/未知新档位）→ /task/video_clip_search（与网关「仅 internal 放行」对齐）。
 * 栏目配置显式消费（成片层）：column_tag_ids **字符串数组原样**传（雪花 id >2^53，parse 成 number 必丢精度）。
 * 错误按 body.code 分支（403 与 6401/6402 均伪装成 HTTP 500；master 层参数错经网关代理一律 6401——双语义）。
 */
import type { CloudConfig } from "./config";
import type { FilmDispatch } from "./splitdoc";
import type { ColumnBroll } from "./column-config";
import { parseJson, CloudError, type ApiResp } from "./cloud";
import { r3 } from "./frame-domain";

// ── 类型（broll-plan-contract spec 字段级）────────────────────────────────

/** 服务端 result 原样字段 + 本地附加（仅 excluded_hint / also_matched_queries 两个）。
 * clip_id 一律**字符串**：服务端返回雪花大整数（>2^53），JSON.parse 成 number 必丢精度
 * （真机实测 …141 被砸成 …140，两个不同 clip 撞成同一 id）——解析层引号化，契约统一字符串。
 *
 * 本地形态（add-matrix-local-search · broll-plan-contract，2026-08-12 联测收口）：`source:"local"` 标记，
 * `clip_id`=`local-<blake3-16>`——**与云端同构：材料 id 由消费方既有拼接 `broll-`+clip_id 得出
 * `broll-local-<blake3-16>`，MUST NOT 在 clip_id 里预置 `broll-` 前缀（否则拼出 `broll-broll-` 双前缀）**；
 * `local_path`/`cover_path` 替代 `url`/`cover_url`（无 24h 签名过期语义，url 系字段 MUST NOT 出现）；
 * `segments` 结构与云端形态逐字段一致。云端形态字段与语义不变（无 source 键即云端）。 */
export interface PlanResult {
	clip_id: string;
	score: number;
	/** 云端形态必有；本地形态（source:"local"）MUST NOT 出现。 */
	url?: string;
	/** 云端形态必有；本地形态 MUST NOT 出现（封面走 cover_path）。 */
	cover_url?: string;
	duration?: number;
	width?: number;
	height?: number;
	fps?: number;
	orientation?: string;
	/** 按 score 降序（非时间序）；best = 段内最像 query 的一帧时刻（截取/缩略锚点）。
	 * cuts（fix-broll-flash-frames · broll-plan-contract）：本地形态可选——段内已知场景切点时码
	 * （素材时基秒，升序，严格落在 (start,end) 开区间内），铺轨据此吸附窗口端点消残片；
	 * ★ **在不在场 ⇔ 该素材扫没扫过切点**（fix-cut-scan-warning-semantics）：
	 *   · 缺省 = 该素材**未扫过切点**（旧 plan / `cuts_indexed` 未置位）⇒ 真的不可判；
	 *   · `[]` = 扫过了，只是这一段内没有切点 ⇒ **可判**，判出来是「没有」。
	 *   两者 MUST NOT 混为一谈——混了就会把「这段没切点」误报成「这素材没索引」，
	 *   并开出「重跑索引」这条昂贵且无效的处方。与下面 `motion` 的「缺省=不可判」同构。
	 * 云端形态 MUST NOT 出现该字段——那是**不适用**，不是「不可判」，MUST NOT 进不可判分母。
	 * motion（add-material-motion-signal）：本地形态可选——该段去重后的帧间跳变分位与样本数，
	 * 供铺轨择窗降权、agent 换段裁定；缺省=**不可判**（旧库/样本不足），MUST NOT 当「平稳」用。
	 * black（fix-index-gradual-transition-blindness）：本地形态可选——与本段区间有**交叠**的黑段
	 * `[st, ed]` 对（素材时基秒，按起点升序），铺轨据此把窗口收缩到黑段一侧消渐变过黑；
	 * 三态语义与 `cuts` 同构（缺省=该素材未扫过黑段 / `[]`=扫过且本段无黑 / 有值=本段含黑）。
	 * ⚠️ **与 `cuts` 的关键差别：黑段横跨段界是常态，MUST NOT 要求落在段内**——黑段中点已被注入
	 * 成场景边界、而段边界恒落在场景边界上（真机 424.083–424.367 的中点 424.225 就是段界，
	 * 两侧段各含它一半）。值给的是**未裁剪的源坐标**（裁到段界会让端点吸到黑段中点上）。 */
	segments?: {
		start: number;
		end: number;
		best: number;
		score: number;
		cuts?: number[];
		motion?: { p50: number; p90: number; samples: number; effective_fps?: number };
		black?: [number, number][];
	}[];
	note?: string | null;
	matched?: Record<string, unknown>;
	// internal 口独有
	material_class?: string;
	level?: string;
	is_copyright?: boolean;
	// 本地检索形态（local-material-search spec）
	source?: "local";
	/** 素材形态（broll-plan-contract · add-matrix-local-image-broll）：可选、缺省 video；
	 * `"image"` = 本地图片候选（零区间 segments + local_path）。云端形态 MUST NOT 出现本字段；
	 * 消费方对未知取值按 video 兜底（前向兼容）。 */
	kind?: "video" | "image";
	/** 本地素材绝对路径（免下载免上传，消费方按它/asset:// 直读，MUST NOT 推导远程 preview URL）。 */
	local_path?: string;
	/** 工程内封面相对路径（assets/broll-cover/<id>.jpg），可缺省待铺轨时现抽。 */
	cover_path?: string;
	// 本地附加
	excluded_hint?: true;
	also_matched_queries?: string[];
	/** 理解产物（broll-plan-contract · add-matrix-describe-and-window）：`matrix describe` 注入的
	 * 可选字段，随 plan 流转；消费方（lay/客户端 parseBrollMeta）宽松兼容不识别不炸；云端检索产出
	 * 的 plan 不含本字段（注入是 CLI 后处理）。usable_flags 是给 agent 的**信号**——CLI MUST NOT
	 * 依据它自动剔除候选（零件不裁定，剔除与否是裁定层的事）。 */
	describe?: MaterialDescribeMeta;
	/** agent 编辑钉选（plan 可编辑契约）：true = 分配器优先满足、强制入选（覆盖 score 排序）；
	 * pinned 间冲突（消费键/同 beat 归属互斥）后到让位并在 summary 明示。缺省缺失。 */
	pinned?: boolean;
	[k: string]: unknown;
}

/** 理解产物形态（matrix-describe spec：desc/tags/mark/usable_flags）——各键宽松可选。 */
export interface MaterialDescribeMeta {
	desc?: string;
	tags?: string[];
	mark?: number;
	usable_flags?: Record<string, boolean>;
	/**
	 * 射程锚点（fix-describe-window-coverage · broll-plan-contract）：本条理解产物出自的**帧时刻**，
	 * 素材时基秒，与 `segments[].best` 同时基同单位。
	 *
	 * 为什么必须有这个字段：`matrix describe --plan` 每个候选**只抽一帧**（恒取 `segments[0].best`，
	 * 见 `src/commands/matrix.ts` 的 `collectPlanDescribeItems`），而这条判决此前被挂到**整个候选**上。
	 * 真机 260902 实测：32 个被理解候选共带 **843 段，只有 32 段（3.8%）被理解过**；
	 * 95 个落轨坑位里只有 12 个（12.6%）含那一帧 —— 87.4% 的落轨画面从未被 describe 看过，
	 * 最远的一条相距约 680s。没有这个字段，下游拿到 `describe` 后**在数据上根本无从知道它出自哪一帧**，
	 * 只能整条候选一视同仁。
	 *
	 * 缺省容错是硬要求：字段缺席时消费方 MUST NOT 报错、**MUST NOT 外推到全部段**，
	 * SHALL 按 `segments[0]` 推定（既有产出口径恒取 `segments[0].best`，对 CLI 自产的存量 plan 该推定
	 * 与事实一致），并在人读输出里标注为**推定**。判定走 {@link describeScopeOf} / {@link segInDescribeScope}。
	 *
	 * 图片候选（`kind === "image"`，缓存键 ts=0）**不写本字段**——图片没有时间轴，写 0 是误导性锚点；
	 * 它的射程天然是整条素材。云端检索产出的 plan 不含 `describe`，故本字段对云端形态零影响。
	 *
	 * ⚠️ **同名不同轴，别读混**：同一份 `broll-plan.json` 里 `beats[].anchors[].at_sec` 是**工程轴**秒
	 * （成片时间线上的卡点时刻，lay 据它钉锚槽），本字段是**素材时基**秒（源片内的帧时刻，与
	 * `segments[].best` 同轴）。两者嵌套位置不同、语义不同，MUST NOT 互相换算或互相拷贝。
	 * 名字沿用 proposal 的建议值（tasks 0.3 的推荐档），撞名这件事已如实记在 change 的 tasks 里。
	 */
	at_sec?: number;
	[k: string]: unknown;
}

/** {@link describeScopeOf} 的产物：这条 describe 的有效射程。 */
export interface DescribeScopeInfo {
	/** 射程锚点（素材时基秒）。undefined = 该候选没有可用时间轴 ⇒ 射程为整条素材。 */
	atSec?: number;
	/** true = 锚点字段缺席、按 `segments[0].best` 推定（旧 plan / agent 手组 plan）。
	 * 人读输出 MUST 标注为「推定射程」，MUST NOT 与写明锚点的条目混为一谈。 */
	presumed: boolean;
	/** true = 射程覆盖整条素材（图片候选 / 无 segments 的退化候选）——无「射程外」可言。 */
	wholeMaterial: boolean;
}

/**
 * 这条 `result.describe` 的有效射程（fix-describe-window-coverage）。
 *
 * 无 `describe` ⇒ undefined（没有理解产物就没有射程可言，消费方按「无理解」中性处置）。
 *
 * ⚠️ 本函数**只是射程标注**，MUST NOT 被当作剔除、降权或排序的判据来源——
 * 它回答的是「这条判决说的是哪一段」，不回答「这一段好不好」。
 */
export function describeScopeOf(cand: PlanResult): DescribeScopeInfo | undefined {
	const d = cand.describe;
	if (!d || typeof d !== "object") return undefined;
	// 图片：无时间轴（缓存键 ts=0 是缓存键不是时刻），射程 = 整条素材
	if (cand.kind === "image") return { presumed: false, wholeMaterial: true };
	const at = d.at_sec;
	if (typeof at === "number" && Number.isFinite(at)) return { atSec: at, presumed: false, wholeMaterial: false };
	// 缺省推定：既有产出口径恒取 segments[0].best（MUST NOT 外推到全部段）
	const best = cand.segments?.[0]?.best;
	if (typeof best === "number" && Number.isFinite(best)) return { atSec: best, presumed: true, wholeMaterial: false };
	// 连 segments 都没有（退化候选，segmentsOf 会合成整片伪段）⇒ 只有一段，射程就是它
	return { presumed: true, wholeMaterial: true };
}

/**
 * 某个 segment 是否落在这条 describe 的射程内（fix-describe-window-coverage）。
 *
 * 无 `describe` 恒 false —— 消费方对「无理解」的处置是**中性**（不惩罚不加分），
 * 与「射程外」同一档；两者在本函数的返回值上不必区分，区分留给调用方的语义。
 *
 * ⚠️ 端点**双闭**：锚点恰好落在段界上时两侧段都算射程内。这是刻意的保守选择——
 * 收窄射程的目的是别让一帧的判决去替它没看过的画面说话，不是趁机把它没看过的画面也判死；
 * 边界那一帧两段都看得见，两段都算「看过」不冤枉谁。
 */
export function segInDescribeScope(cand: PlanResult, seg: { start: number; end: number }): boolean {
	const scope = describeScopeOf(cand);
	if (!scope) return false;
	if (scope.wholeMaterial) return true;
	const at = scope.atSec as number;
	return seg.start <= at && at <= seg.end;
}

/** 本地形态 clip_id 前缀（broll-plan-contract 2026-08-12 收口）：`local-<blake3-16>`。
 * 材料 id 前缀 `broll-local-` 是消费方拼 `broll-` 之后的产物，MUST NOT 出现在 clip_id 里
 * （此处独立声明避免与 matrix-lay 环依赖）。 */
const LOCAL_CLIP_PREFIX = "local-";

/** result 是否本地形态（消费方分流判据：source 标记或 local_path 存在性）。 */
export function isLocalPlanResult(r: Pick<PlanResult, "source" | "local_path">): boolean {
	return r.source === "local" || typeof r.local_path === "string";
}

/**
 * 本地形态 result 轻校验（broll-plan-contract「本地结果形态」逐条）：返回违约描述数组（空=合规）。
 * 仓内无 zod，按既有 validateSplitDoc 先例做手写校验，供组装侧/测试对拍 spec。
 */
export function validateLocalResult(r: PlanResult): string[] {
	const errs: string[] = [];
	if (r.source !== "local") errs.push('本地 result 必须带 source:"local" 标记');
	// `broll-local-…` 不以 `local-` 开头 → 双前缀形态（预置了 broll-）在此同被拦下
	if (!r.clip_id.startsWith(LOCAL_CLIP_PREFIX)) {
		errs.push(
			`clip_id 必须为 ${LOCAL_CLIP_PREFIX}<blake3-16> 且 MUST NOT 预置 broll- 前缀（得到 ${r.clip_id}）——材料 id 由消费方拼 broll-+clip_id 得出`,
		);
	}
	if (typeof r.local_path !== "string" || !r.local_path) errs.push("本地 result 缺 local_path（素材绝对路径）");
	for (const k of ["url", "cover_url", "url_ttl_note"] as const) {
		if (k in r) errs.push(`本地 result MUST NOT 出现 ${k}（无签名过期语义）`);
	}
	const segs = r.segments ?? [];
	for (let i = 1; i < segs.length; i++) {
		if (segs[i]!.score > segs[i - 1]!.score) {
			errs.push("segments 必须按 score 降序");
			break;
		}
	}
	for (const s of segs) {
		if (!(s.start <= s.best && s.best <= s.end)) {
			errs.push(`segment best 必须落在 [start,end] 内（${s.start}–${s.end} best=${s.best}）`);
			break;
		}
	}
	return errs;
}

export interface PlanQuery {
	query: string;
	/** 服务端回显（过滤前真实召回数）——results 的兄弟字段。 */
	recalled?: number;
	results?: PlanResult[];
	error?: { code?: number; msg: string };
}

// ── plan 可编辑通路契约（matrix-command spec · add-matrix-describe-and-window D4）──────
//
// plan 是一等可编辑中间产物（agent 裁定注入铺轨的法定通道）。
// 可编辑面（白名单）：results 删条/重排、segments 删段、describe 字段增删、result 级 pinned:true。
// 不可编辑面：clip_id / local_path / url / 几何字段（duration/width/height/fps）——没有「原件」可
// 对拍，防线走**结构完整性校验**（类型/格式/一致性），改坏即拒并明示字段；lay 消费编辑后 plan
// 一律按 plan 现值执行，MUST NOT 因「与原始检索结果不一致」拒绝（我们从不做原件比对）。

/** 几何键（不可编辑面）：存在即须为正有限数。 */
const GEOMETRY_KEYS = ["duration", "width", "height", "fps"] as const;

function validatePlanResultForLay(r: PlanResult, where: string, errs: string[]): void {
	if (typeof r.clip_id !== "string" || !r.clip_id) {
		errs.push(`${where}：clip_id 不可编辑——必须为非空字符串（得到 ${JSON.stringify(r.clip_id)}）`);
		return; // clip_id 都没了，后续定位信息不可信
	}
	if (!(typeof r.score === "number" && Number.isFinite(r.score))) {
		errs.push(`${where}：score 必须为有限数字（得到 ${JSON.stringify(r.score)}）`);
	}
	for (const k of GEOMETRY_KEYS) {
		const v = r[k];
		if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v > 0)) {
			errs.push(`${where}：几何字段 ${k} 不可编辑——须为正数（得到 ${JSON.stringify(v)}）`);
		}
	}
	if (r.segments !== undefined) {
		if (!Array.isArray(r.segments)) {
			errs.push(`${where}：segments 须为数组（可删段，但不可改形态）`);
		} else {
			for (const s of r.segments) {
				const nums = [s?.start, s?.end, s?.best, s?.score];
				if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
					errs.push(`${where}：segment 四键（start/end/best/score）须为有限数字`);
					break;
				}
				if (!(s.start <= s.best && s.best <= s.end)) {
					errs.push(`${where}：segment 几何不可编辑——best 必须落在 [start,end] 内（${s.start}–${s.end} best=${s.best}）`);
					break;
				}
				// motion 可选字段（add-material-motion-signal）：agent 可整体删除，改坏即拒
				if (s.motion !== undefined) {
					const m = s.motion as { p50?: unknown; p90?: unknown; samples?: unknown; effective_fps?: unknown };
					const num = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
					const bad =
						!m ||
						typeof m !== "object" ||
						Array.isArray(m) ||
						!num(m.p50) ||
						!num(m.p90) ||
						(m.p90 as number) < (m.p50 as number) ||
						!(typeof m.samples === "number" && Number.isInteger(m.samples) && m.samples > 0) ||
						(m.effective_fps !== undefined && !(num(m.effective_fps) && (m.effective_fps as number) > 0));
					if (bad) {
						errs.push(`${where}：segment motion 须为 {p50,p90(≥p50),samples(正整数),effective_fps?(正数)}（可整体删除，不可改坏形态）`);
						break;
					}
				}
				// cuts 可选字段（fix-broll-flash-frames）：agent 可增删；存在即须为升序有限数字、
				// 严格落在 (start,end) 开区间内（改坏即拒——铺轨吸附消费不做猜测修复）
				if (s.cuts !== undefined) {
					const bad =
						!Array.isArray(s.cuts) ||
						!s.cuts.every((c: unknown) => typeof c === "number" && Number.isFinite(c)) ||
						s.cuts.some((c: number, i: number) => (i > 0 && c <= s.cuts![i - 1]!) || c <= s.start || c >= s.end);
					if (bad) {
						errs.push(`${where}：segment cuts 须为升序有限数字且严格落在 (start,end) 开区间内（可整体删除，不可改坏形态）`);
						break;
					}
				}
				// black 可选字段（fix-index-gradual-transition-blindness）：agent 可整体删除，改坏即拒。
				// ⚠️ 判据**刻意不照抄上面 cuts 的「严格落在 (start,end) 开区间内」**：黑段中点已被
				// 索引侧注入成场景边界、而段边界恒落在场景边界上 ⇒ **黑段横跨段界是常态而非例外**
				// （真机 424.083–424.367 的中点 424.225 就是段界，两侧段各含它一半，
				// `test/matrix-lay-black-shrink.test.mjs` 末条把这个「骑缝」形态钉死）。照抄那条
				// 就会把 CLI 自己刚产出的正常 plan 判成坏形态，全链路当场断在校验上。
				// 故只校验**自洽性**：数对成形 / ed>st / 按起点升序，不校验与段区间的位置关系。
				if (s.black !== undefined) {
					const bad =
						!Array.isArray(s.black) ||
						!s.black.every(
							(b: unknown) =>
								Array.isArray(b) && b.length === 2 && b.every((n) => typeof n === "number" && Number.isFinite(n)) && (b[1] as number) > (b[0] as number),
						) ||
						s.black.some((b: [number, number], i: number) => i > 0 && b[0] < s.black![i - 1]![0]);
					if (bad) {
						errs.push(`${where}：segment black 须为 [st,ed](ed>st) 数对数组、按起点升序（可整体删除，不可改坏形态；黑段骑段界是常态，不校验是否落在段内）`);
						break;
					}
				}
			}
		}
	}
	if (r.pinned !== undefined && typeof r.pinned !== "boolean") {
		errs.push(`${where}：pinned 只能是布尔（钉选写 pinned:true；得到 ${JSON.stringify(r.pinned)}）`);
	}
	if (r.describe !== undefined) {
		const d = r.describe;
		if (!d || typeof d !== "object" || Array.isArray(d)) {
			errs.push(`${where}：describe 须为对象（{desc,tags,mark,usable_flags} 宽松形态）`);
		} else {
			if (d.desc !== undefined && typeof d.desc !== "string") errs.push(`${where}：describe.desc 须为字符串`);
			if (d.tags !== undefined && !(Array.isArray(d.tags) && d.tags.every((t) => typeof t === "string"))) {
				errs.push(`${where}：describe.tags 须为字符串数组`);
			}
			if (d.mark !== undefined && !(typeof d.mark === "number" && Number.isFinite(d.mark))) {
				errs.push(`${where}：describe.mark 须为数字`);
			}
			if (d.usable_flags !== undefined && (!d.usable_flags || typeof d.usable_flags !== "object" || Array.isArray(d.usable_flags))) {
				errs.push(`${where}：describe.usable_flags 须为对象`);
			}
			// at_sec（fix-describe-window-coverage）：射程锚点，存在即须为有限数。
			// ⚠️ **刻意不校验「落在某个 segments[i] 内」**：agent 删段是白名单内的合法编辑
			// （plan 可编辑面原文「segments 删段」），把被理解的那一段删掉之后锚点自然落在段外，
			// 那是合法产物不是坏形态。落段外的后果由消费方承担——所有段一律判射程外走中性，
			// 与「没跑过 describe」同档，安全方向正确。
			if (d.at_sec !== undefined && !(typeof d.at_sec === "number" && Number.isFinite(d.at_sec))) {
				errs.push(`${where}：describe.at_sec 须为有限数字（素材时基秒的射程锚点；可整体删除，删了按 segments[0] 推定）`);
			}
		}
	}
	// 本地形态整包复检（clip_id 前缀 / url 系禁键 / local_path 在位 / segments 降序）
	if (isLocalPlanResult(r)) {
		for (const v of validateLocalResult(r)) errs.push(`${where}：${v}`);
	}
}

/**
 * `--lay` 消费前的 plan 白名单校验（纯函数零 IO；local_path 的**路径有效性**属命令层职责）。
 * 返回违约描述数组（空=可消费）；坏 plan 明示拒绝，MUST NOT 静默跳过或猜测修复。
 */
export function validatePlanForLay(planRaw: unknown): string[] {
	const errs: string[] = [];
	if (!planRaw || typeof planRaw !== "object" || Array.isArray(planRaw)) return ["plan 不是 JSON 对象"];
	const plan = planRaw as Partial<BrollPlan> & Record<string, unknown>;
	if (plan.plan_version !== "v1") errs.push(`plan_version 必须为 "v1"（得到 ${JSON.stringify(plan.plan_version)}）`);
	if (!Array.isArray(plan.beats)) {
		errs.push("beats 必须为数组");
		return errs;
	}
	for (const beat of plan.beats as PlanBeat[]) {
		if (!beat || typeof beat !== "object" || typeof beat.beat !== "string" || !beat.beat) {
			errs.push("存在缺 beat 名的 beat 条目");
			continue;
		}
		if (!(typeof beat.track_st === "number" && typeof beat.track_ed === "number" && Number.isFinite(beat.track_st) && Number.isFinite(beat.track_ed))) {
			errs.push(`beat ${beat.beat}：track_st/track_ed 须为有限数字`);
		}
		// 关键词锚（add-keyword-anchored-broll）：可编辑面（挪 at_sec/换 query/删锚），改坏形态即拒
		if (beat.anchors !== undefined) {
			if (!Array.isArray(beat.anchors)) {
				errs.push(`beat ${beat.beat}：anchors 须为数组（可删锚/挪 at_sec，不可改坏形态）`);
			} else {
				for (const a of beat.anchors) {
					const ok =
						a &&
						typeof a === "object" &&
						!Array.isArray(a) &&
						typeof a.keyword === "string" &&
						a.keyword &&
						typeof a.utterance === "string" &&
						a.utterance &&
						typeof a.query === "string" &&
						a.query &&
						(a.at_sec === null || (typeof a.at_sec === "number" && Number.isFinite(a.at_sec)));
					if (!ok) {
						errs.push(
							`beat ${beat.beat}：anchor 须为 {keyword/utterance/query 非空字符串, at_sec 有限数字或 null}（可删锚/挪 at_sec，不可改坏形态）`,
						);
						break;
					}
				}
			}
		}
		// ── 编排档位与直排槽（add-arrange-direct-tier）─────────────────────────
		// ⚠️ 本块 MUST 留在下面 `queries` 那条 `continue` **之前**：那条 continue 会跳过
		// 本 beat 剩余全部校验，插在其后会让「queries 形态也坏了」的 beat 整块漏检。
		// 档位：缺席 = 低档 = 逐字节零回归，故必须先判 `!== undefined` 再判越界；
		// 越界即拒，MUST NOT 静默降级到低档——与服务端 6214 同一条纪律。
		const tier = beat.arrange_mode as unknown;
		if (tier !== undefined && !(typeof tier === "string" && (ARRANGE_TIERS as readonly string[]).includes(tier))) {
			errs.push(
				`beat ${beat.beat}：arrange_mode 非法（三选一：${ARRANGE_TIERS.join(" | ")}；得到 ${JSON.stringify(tier)}）——越界档位 MUST NOT 静默降级到低档`,
			);
		}
		const ds = beat.direct_slots as unknown;
		if (ds !== undefined) {
			if (!Array.isArray(ds)) {
				errs.push(`beat ${beat.beat}：direct_slots 须为数组（可删槽，不可改坏形态）`);
			} else {
				const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
				for (const d of ds as Record<string, unknown>[]) {
					if (!d || typeof d !== "object" || Array.isArray(d)) {
						errs.push(`beat ${beat.beat}：存在非对象 direct_slot 条目`);
						break;
					}
					const { clip_id, clip_st, clip_ed, track_st, track_ed } = d;
					if (!(typeof clip_id === "string" && clip_id) || !num(clip_st) || !num(clip_ed)) {
						errs.push(`beat ${beat.beat}：direct_slot 须为 {clip_id 非空字符串, clip_st/clip_ed 有限数字}（得到 ${JSON.stringify(d)}）`);
						break;
					}
					if (!(clip_st < clip_ed)) {
						errs.push(
							`beat ${beat.beat}：direct_slot 源窗须 clip_st < clip_ed（得到 ${JSON.stringify(clip_st)}–${JSON.stringify(clip_ed)}）——源窗是「出处」的本体`,
						);
						break;
					}
					// 半给的位置在下游是**静默**处置的（投影层丢掉位置、铺轨层降级成顺排），
					// 静默移位正是引用段要防的东西，故在此拒掉而不是让它悄悄改语义。
					if ((track_st === undefined) !== (track_ed === undefined)) {
						errs.push(`beat ${beat.beat}：direct_slot 的 track_st/track_ed 要么都给要么都不给（只给一半是无意义的半个约束）`);
						break;
					}
					const role = d.slot_role;
					if (role !== undefined && !(typeof role === "string" && (DIRECT_SLOT_ROLES as readonly string[]).includes(role))) {
						errs.push(
							`beat ${beat.beat}：direct_slot 的 slot_role 非法（二选一：${DIRECT_SLOT_ROLES.join(" | ")}；得到 ${JSON.stringify(role)}）——越界值 MUST NOT 静默降级`,
						);
						break;
					}
					// 引用段没有时间线位置就无从「逐秒对齐」，是不自洽的请求。
					// ⚠️ 反向不成立：钉了位的硬出处段是合法的，故 MUST NOT 从位置反推 slot_role。
					if (role === "quote" && track_st === undefined) {
						errs.push(`beat ${beat.beat}：direct_slot 标了 slot_role:"quote" 却没给 track_st/track_ed——引用段要逐秒对齐，没有时间线位置无从对齐`);
						break;
					}
					if (track_st !== undefined && !(num(track_st) && num(track_ed) && track_st < track_ed)) {
						errs.push(
							`beat ${beat.beat}：direct_slot 的时间线位置须为有限数字且 track_st < track_ed（得到 ${JSON.stringify(track_st)}–${JSON.stringify(track_ed)}）`,
						);
						break;
					}
				}
			}
		}
		if (!Array.isArray(beat.queries)) {
			errs.push(`beat ${beat.beat}：queries 必须为数组`);
			continue;
		}
		for (const q of beat.queries) {
			if (!q || typeof q !== "object" || typeof q.query !== "string") {
				errs.push(`beat ${beat.beat}：存在缺 query 文本的 query 条目`);
				continue;
			}
			if (q.results === undefined) continue;
			if (!Array.isArray(q.results)) {
				errs.push(`beat ${beat.beat}/「${q.query}」：results 须为数组（可删条/重排，不可改形态）`);
				continue;
			}
			for (const r of q.results) {
				if (!r || typeof r !== "object") {
					errs.push(`beat ${beat.beat}/「${q.query}」：存在非对象 result 条目`);
					continue;
				}
				validatePlanResultForLay(r, `beat ${beat.beat}/「${q.query}」/clip ${String((r as PlanResult).clip_id ?? "?")}`, errs);
			}
		}
	}
	return errs;
}

// ── 关键词锚（add-keyword-anchored-broll）──────────────────────────────────

/**
 * plan beat 的关键词锚条目：`at_sec` = 关键词说出时刻（句级时码 + 字符偏移比例内插——TTS 无词级
 * 时码的近似，误差 <1s 观感足够；未来 TTS 出词级时码可无缝换源）。`null` = 内插失败（改稿后文本
 * 漂移 / 句被剪 / 重投影降级），lay 按 degraded 处置（退化普通槽 + summary 明示，不硬锚）。
 * plan 一等可编辑：可挪 at_sec、换 query、删锚；keyword/utterance 供溯源展示。
 */
export interface PlanAnchor {
	keyword: string;
	utterance: string;
	at_sec: number | null;
	query: string;
}

/**
 * 锚时刻内插（导出纯函数供单测）：at_sec = track_st + (关键词字符起始偏移 / 句总字数) × 句时长。
 * 关键词多次出现取首次（首现 = 最早说出时刻）；找不到返回 null（改稿后文本漂移——该锚 degraded）。
 */
export function anchorAtSec(utteranceText: string, keyword: string, trackSt: number, trackEd: number): number | null {
	if (!utteranceText || !keyword) return null;
	const idx = utteranceText.indexOf(keyword);
	if (idx < 0) return null;
	const span = trackEd - trackSt;
	if (!(Number.isFinite(trackSt) && Number.isFinite(span) && span > 0)) return null;
	return r3(trackSt + (idx / utteranceText.length) * span);
}

/**
 * 编排档位（add-arrange-direct-tier，design §3「不是二选一，给档位」）。
 *
 * ⚠️ **不要和 `ArrangeMode` 搞混**——那是 `arrange-gate.ts` 的**取数路**
 * （`local|shadow|cloud`，管「在哪算」）；本类型是**编排策略**（管「怎么排」）。
 * 两者正交：本地素材路走云端算（取数路 cloud），而那一份 plan 里每个 beat
 * 各自标什么档位（本类型）与之无关。
 * 命名刻意用 `Tier` 而非 `Mode` 就是为了不再撞车——本仓 2026-08-31 刚因为
 * 「本地/云端」被两根正交轴共用吃过一次亏。
 *
 * - `direct`   高档 · 锚定直排：出处窗直给，不检索不排序，但**过同一套 refineWindow**
 * - `temporal` 中档 · 语义×时序先验：**尚未实现**（衰减函数形态待打样，服务端报 6214）
 * - `semantic` 低档 · 纯语义：现状，缺省
 *
 * 取值表用 `as const` 而非裸联合，是因为**运行期要能 includes**（`validatePlanForLay`
 * 拒越界档位）。一处真值派生出类型，避免「类型加了新档、校验数组忘了加」这类静默漏网
 * ——同 `MATERIAL_CLASSES` 的写法。
 */
export const ARRANGE_TIERS = ["direct", "temporal", "semantic"] as const;
export type ArrangeTier = (typeof ARRANGE_TIERS)[number];

/** 直排槽的语义类别。取值表用 `as const`：运行期要能 includes（越界即拒）。 */
export const DIRECT_SLOT_ROLES = ["quote", "provenance"] as const;
export type DirectSlotRole = (typeof DIRECT_SLOT_ROLES)[number];

/**
 * 直排槽（高档入参）：「这一段就用这条素材的这一段，别检索」。
 *
 * 射程是 narration 图纸 §119 点名的两类——**引用段**（画音必须逐秒对齐，检索无从保证）
 * 与**硬出处段**（稿里显式写「【素材：片段03 2:10-2:40】」，那是指令不是线索）。
 *
 * ★ 直排槽**照样过 refineWindow**（切点吸附 + 帧网格吸附）——这是本档的核心价值：
 * 手写窗必然可能跨源镜头切点，那正是免索引直排闪帧的机制性根因。
 * ⚠️ 但残片收缩依赖 `segments[].cuts`：**素材未索引则无 cuts**，那时只有帧吸附生效，
 * 是**部分收益**。MUST NOT 对用户表述成「直排就一定不闪帧」。
 */
export interface DirectSlot {
	clip_id: string;
	/** 源窗（素材内秒）——「出处」的本体，必给。 */
	clip_st: number;
	clip_ed: number;
	/** 时间线位置。引用段**必给**（画音要逐秒对齐）；硬出处段可缺，缺则在 beat 内顺排。
	 * 要么都给要么都不给。 */
	track_st?: number;
	track_ed?: number;
	/** 溯源用的检索词**原文**。MUST NOT 用 q_idx——下标会因空池折叠而错位（红线 1）。 */
	query?: string;
	/** 直排槽的**语义类别**（narration 图纸 §119 并列的两类；上面头注引用的就是它们）。
	 *
	 * - `quote` **引用段**：画面与口播逐秒对齐。源窗端点是**硬约束**——解说说到
	 *   「他咬下这一口」，若那一口正好横跨一个镜头切换，用户要的就是**含这个切换**
	 *   的那一段；把端点吸走等于删掉他点名要的画面。故 `quote` **跳过切点吸附**。
	 * - `provenance` **硬出处段**：稿里显式写「【素材：片段03 2:10-2:40】」，那是
	 *   出处指令，位置可协商，恰恰**需要**切点吸附消端点残片。
	 *
	 * ★ **只关切点吸附这一步**：帧网格吸附两类都保留（位移 ≤ 半帧，且它保证端点
	 * 落在可播的帧边界上；跳过它只是把量化推给下游，而下游两种语言/两个播放器
	 * 没有共同的取整规则）。切点吸附的位移上界是 `SLIVER_MIN_SEC`（1 秒），
	 * 那才是画音错位的量级。
	 *
	 * **缺席 = 未标注**：决策层按 `provenance` 处置（= 本字段落地前后逐字节一致），
	 * 但投影层 MUST NOT 补成 `"provenance"`——整键不上行，同 `arrange_mode`/`fps`/
	 * `motion` 的既有纪律。缺席不能翻成 `quote`：那会追认已发出的字节，并让所有
	 * 既有硬出处槽**静默**失去消残片。
	 *
	 * ⚠️ 与 `PlanResult.pinned` **无关**：那个挂在**候选**上、管**排序**、可让位；
	 * 本字段挂在**槽**上、管**端点可动性**、不可让位。MUST NOT 合并。 */
	slot_role?: DirectSlotRole;
}

export interface PlanBeat {
	beat: string;
	track_st: number;
	track_ed: number;
	requested_shots?: number;
	per_shot_sec?: number;
	exclude?: string[];
	/** 关键词锚（add-keyword-anchored-broll，可选）：lay 锚点优先布局的输入；无该键 = 行为与
	 * 本 change 之前逐字节一致。 */
	anchors?: PlanAnchor[];
	/** 编排档位（add-arrange-direct-tier，可选）。**缺席 = `semantic` = 逐字节零回归**；
	 * 逐 beat 标注 ⇒ 同一片内可混档（design §3 举例：引用段直排 + 叙述段中档）。
	 * 越界值 MUST NOT 静默降级到低档——与服务端 6214 同一条纪律。 */
	arrange_mode?: ArrangeTier;
	/** 直排槽（`arrange_mode === "direct"` 时消费）。同 beat 内与 `queries` 可并存：
	 * 直排槽先钉死，**剩余区间才走检索**（design「检索只兜出处缺失段」）。 */
	direct_slots?: DirectSlot[];
	queries: PlanQuery[];
}

export interface BrollPlan {
	plan_version: "v1";
	generated_at: string;
	/** 云端双口沿用 internal/external；本地检索（--local）为 "local"。 */
	member_type: "internal" | "external" | "local";
	/** 常量注记（云端形态必含）：结果 url 带签名默认 24h 过期，重跑 gtrk matrix 即重签。
	 * 本地形态 MUST NOT 出现（无签名过期语义，broll-plan-contract）。 */
	url_ttl_note?: string;
	project_slug?: string;
	column_id?: string;
	/** [fix-highlight-rubric-wiring] 本 plan 的看点分是按**哪套评判准则**打的（`matrix describe --plan` 钉存）。
	 * 让「评分口径」随 plan 走，lay 无需用户再传一遍准则；缺席 = 缺省桶（本件之前的 plan 皆如此，宽松兼容不炸）。
	 * ⚠️ 只钉哈希与来源，**不钉准则全文**——plan 是给 agent 读改的工件，塞 2000 字准则会挤占它的注意力。 */
	rubric_hash?: string;
	/** 准则来源留痕：`flag:@<path>` / `flag:inline` / `column:<id>` / `default`（人读，供事后追溯）。 */
	rubric_source?: string;
	beats: PlanBeat[];
}

export const URL_TTL_NOTE = "结果 url 带签名默认 24h 过期；过期后重跑 gtrk matrix 即重签（plan 幂等重生成）。";

export interface SearchFilters {
	min_duration?: number;
	max_duration?: number;
	orientation?: string;
	min_width?: number;
	/** clip_id 维度排除——同 column_tag_ids,一律字符串防大整数精度(服务端 int() 兼容)。本期未用。 */
	exclude_ids?: string[];
	level?: string;
	is_copyright?: boolean;
}

/** custom 口（矩阵成员）请求体；通用口 = 去掉 material_class/column_tag_ids/facets。 */
export interface SearchBody {
	query: string;
	top_k: number;
	material_class?: string;
	/** 字符串数组原样（服务端 int() 逐元素兼容；JS 侧绝不 parse 成 number）。 */
	column_tag_ids?: string[];
	facets?: Record<string, unknown>;
	filters?: SearchFilters;
}

export interface SearchRespData {
	request_id?: string | null;
	recalled?: number;
	results?: PlanResult[];
}

// ── 路由（不降级不缓存）──────────────────────────────────────────────────

export type Tier = "internal" | "external";

export const ENDPOINTS: Record<Tier, string> = {
	internal: "/task/custom/video_clip_search",
	external: "/task/video_clip_search",
};

/** 凡非字符串 "internal" 的任何值（缺失/external/未知新档位）一律 external——与网关「仅 internal 放行」对齐。 */
export function decideRoute(memberType: unknown): { tier: Tier; endpoint: string } {
	const tier: Tier = memberType === "internal" ? "internal" : "external";
	return { tier, endpoint: ENDPOINTS[tier] };
}

// ── 请求构建（派单翻译 + 栏目配置注入）───────────────────────────────────

/** 宽召回系数：top_k = clamp(shots*3, 10, 50)。联调后可调，plan 里记 requested_shots 供对照。 */
const WIDE_RECALL_FACTOR = 3;
const TOP_K_MIN = 10;
const TOP_K_MAX = 50; // 服务端硬上限（超 50 静默钳位）
/** 未显式指定 `--top-k` 时的候选数缺省值（导出供 ad-hoc upsell 判定用同一正本，防两处各写一个 10）。 */
export const TOP_K_DEFAULT = 10;

function asPositiveInt(v: unknown): number | undefined {
	return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}
function asPositiveNum(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function shotsToTopK(shots: unknown, override?: number): number {
	if (override && override > 0) return Math.min(Math.max(Math.floor(override), 1), TOP_K_MAX);
	const n = asPositiveInt(shots);
	if (!n) return TOP_K_DEFAULT;
	return Math.min(Math.max(n * WIDE_RECALL_FACTOR, TOP_K_MIN), TOP_K_MAX);
}

/** facets = facet_defaults 经 facet_allowed 剪除（INTERSECTION 语义消费端执行）；值不预检（白名单权威在服务端）。 */
export function trimFacets(
	defaults: Record<string, unknown> | undefined,
	allowed: string[] | undefined,
): Record<string, unknown> | undefined {
	if (!defaults || typeof defaults !== "object") return undefined;
	const entries = Object.entries(defaults).filter(([k]) => !allowed || allowed.includes(k));
	return entries.length ? Object.fromEntries(entries) : undefined;
}

const MATERIAL_CLASSES = ["real_shot", "concept"] as const;

export function buildSearchBody(
	tier: Tier,
	query: string,
	dispatch: Pick<FilmDispatch, "shots" | "per_shot_sec"> | undefined,
	broll: ColumnBroll | undefined,
	overrides: { topK?: number; materialClass?: string } = {},
): SearchBody {
	const body: SearchBody = { query, top_k: shotsToTopK(dispatch?.shots, overrides.topK) };

	const perShot = asPositiveNum(dispatch?.per_shot_sec);
	if (perShot) body.filters = { min_duration: perShot };

	if (tier === "internal") {
		// 栏目配置显式消费——external 三项全不注入（通用口契约没有这些参数，零污染）
		if (broll?.column_tag_ids?.length) body.column_tag_ids = [...broll.column_tag_ids];
		const mc = overrides.materialClass ?? broll?.material_class_policy;
		if (mc && (MATERIAL_CLASSES as readonly string[]).includes(mc)) body.material_class = mc;
		const facets = trimFacets(broll?.facet_defaults, broll?.facet_allowed);
		if (facets) body.facets = facets;
	}
	return body;
}

// ── plan 构建（beat 内去重 + exclude 标记 + 失败局部化）─────────────────

function strArr(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v.filter((x): x is string => typeof x === "string");
	return out.length ? out : undefined;
}

/** exclude 词命中 note → excluded_hint 标记（标记不删除：出参文本仅 note，判不全；删除会无声损召回）。 */
export function markExcluded(results: PlanResult[], exclude: string[] | undefined): void {
	if (!exclude?.length) return;
	for (const r of results) {
		if (typeof r.note === "string" && r.note && exclude.some((w) => (r.note as string).includes(w))) {
			r.excluded_hint = true;
		}
	}
}

/** beat 内跨 query 按 clip_id 去重：保 score 最高的出现，其余 query 记进 also_matched_queries。跨 beat 不去重。
 *
 * 锚 query 免折（add-keyword-anchored-broll 真机验收发现①修订）：`keepQueries` 里的 query 对去重
 * **完全透明**——它的命中不并进别的 query，也不吸走别的 query 的命中。lay 的锚点布局只查
 * `poolByQuery.get(锚.query)`，锚命中一旦被折进同 beat 分更高的 query，锚池即空、开箱首轮全
 * degraded（黄石工程三锚实锤）；免折让每条锚 query 的命中（含它自己的 score/segments 语义匹配
 * 数据）保留在自己名下。副作用=同一 clip 可能同时出现在锚 query 与一条普通 query 名下（至多
 * 锚数 ≤2 条/beat），落轨不二用由全局 consumed 记账兜住，不会重复铺。无锚 beat（keepQueries
 * 缺省/空）行为与本修订之前逐字节一致。 */
export function dedupeBeatQueries(queries: PlanQuery[], keepQueries?: ReadonlySet<string>): void {
	const exempt = (q: PlanQuery): boolean => keepQueries?.has(q.query) ?? false;
	// clip_id(字符串) → 当前最优 { query 下标, result 引用 }（免折 query 不参与竞争）
	const bestByClip = new Map<string, { qi: number; r: PlanResult }>();
	for (let qi = 0; qi < queries.length; qi++) {
		if (exempt(queries[qi])) continue;
		for (const r of queries[qi].results ?? []) {
			const prev = bestByClip.get(r.clip_id);
			if (!prev || r.score > prev.r.score) bestByClip.set(r.clip_id, { qi, r });
		}
	}
	for (let qi = 0; qi < queries.length; qi++) {
		const q = queries[qi];
		if (!q.results || exempt(q)) continue;
		q.results = q.results.filter((r) => {
			const best = bestByClip.get(r.clip_id)!;
			if (best.qi === qi && best.r === r) return true;
			// 被去重：把本 query 记到胜者的 also_matched_queries
			const list = (best.r.also_matched_queries ??= []);
			if (!list.includes(q.query)) list.push(q.query);
			return false;
		});
	}
}

export interface QueryOutcome {
	query: string;
	data?: SearchRespData;
	error?: { code?: number; msg: string };
}

export function buildPlanBeat(entry: FilmDispatch, outcomes: QueryOutcome[]): PlanBeat {
	const beat: PlanBeat = {
		beat: entry.beat,
		track_st: entry.track_st,
		track_ed: entry.track_ed,
		queries: [],
	};
	// 派单原值透传（挑选 UI 的建议数据）
	const shots = asPositiveInt(entry.shots);
	if (shots) beat.requested_shots = shots;
	const perShot = asPositiveNum(entry.per_shot_sec);
	if (perShot) beat.per_shot_sec = perShot;
	const exclude = strArr(entry.exclude);
	if (exclude) beat.exclude = exclude;

	for (const o of outcomes) {
		if (o.error) {
			beat.queries.push({ query: o.query, error: o.error });
			continue;
		}
		const results = (o.data?.results ?? []).map((r) => ({ ...r }));
		markExcluded(results, exclude);
		const pq: PlanQuery = { query: o.query, results };
		if (typeof o.data?.recalled === "number") pq.recalled = o.data.recalled; // results 的兄弟字段
		beat.queries.push(pq);
	}
	// 锚 query 免折（add-keyword-anchored-broll 发现①）：锚命中留在自己名下，lay 锚池才取得到
	const anchorQueries = new Set(
		(entry.anchors ?? []).map((a) => a.query).filter((q): q is string => typeof q === "string" && q.length > 0),
	);
	dedupeBeatQueries(beat.queries, anchorQueries.size ? anchorQueries : undefined);
	return beat;
}

export function buildPlan(opts: {
	generatedAt: string;
	memberType: Tier | "local";
	projectSlug?: string;
	columnId?: string;
	beats: PlanBeat[];
}): BrollPlan {
	const plan: BrollPlan = {
		plan_version: "v1",
		generated_at: opts.generatedAt,
		member_type: opts.memberType,
		// 本地 plan 无 url 签名语义 → url_ttl_note MUST NOT 出现；云端形态与本 change 之前逐字节一致
		...(opts.memberType === "local" ? {} : { url_ttl_note: URL_TTL_NOTE }),
		beats: opts.beats,
	};
	if (opts.projectSlug) plan.project_slug = opts.projectSlug;
	if (opts.columnId) plan.column_id = opts.columnId;
	return plan;
}

// ── 错误分类（按 body.code；HTTP 状态仅网络兜底）─────────────────────────

export function classifyApiError(code: number | undefined, msg?: string): string {
	switch (code) {
		case 400:
			return `请求体非法（网关校验）：${msg || "请求参数或请求体格式错误"}`;
		case 6502:
			return "鉴权失败——检查 API Key（gtrk init 重配）";
		case 403:
			return "非矩阵成员或身份可能已变更——矩阵成员口（custom/video_clip_search）仅对 internal 档位开放";
		case 6401:
			// 双语义：master 层参数错误经网关代理后也以 6401 呈现
			return "检索上游故障，或检索参数/栏目配置非法（如 facets 值拼写）——稍后重试仍失败请检查栏目配置的 broll 块";
		case 6402:
			return "检索上游超时——稍后重试";
		default:
			return `云端错误 (code=${code ?? "?"})：${msg || "未知错误"}`;
	}
}

// ── HTTP 调用（薄封装，超时 25s：网关硬超时 15s 必先回包）────────────────

export const SEARCH_TIMEOUT_MS = 25_000;

/** POST /user/get_user_info（无 body 参数）——两路身份探针共用取数（业务码非 200 即抛）。 */
async function fetchUserInfo(cfg: CloudConfig): Promise<Record<string, unknown> | undefined> {
	const res = await fetch(`${cfg.base}/user/get_user_info`, {
		method: "POST",
		headers: { accept: "application/json", Authorization: cfg.apiKey },
		body: "",
		signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
	});
	const r = await parseJson<Record<string, unknown>>(res);
	if (r.code !== 200) throw new CloudError(r.code, classifyApiError(r.code, r.msg));
	return r.data;
}

/** 身份探针（素材矩阵维度）：读 matrix_member_type——**只管云端检索双口路由**。探针失败 = 整体失败（没有身份就没有正确的口）。
 *
 * ⚠️ 计费豁免**不看它**：describe / qc --alignment 等平台能力看 `probeGcMemberType`（gc_member_type）。
 * 服务端已明示「矩阵 internal 而计费 external 则不豁免」，两条轴正交——合并即重犯 260902 那次误判。 */
export async function probeMemberType(cfg: CloudConfig): Promise<Tier> {
	return decideRoute((await fetchUserInfo(cfg))?.matrix_member_type).tier;
}

/** gc 侧身份探针（add-gc-user-member-type D5）：同一 get_user_info 响应读**独立同级字段** `gc_member_type`
 * （同合云内部成员维度——embed 计费豁免等平台能力看它，MUST NOT 复用 matrix_member_type）。
 * 旧服务端无该字段 / 无值 / 未知取值 → 一律兜底 external（非错误）；业务码非 200 仍抛（同 probeMemberType）。 */
export async function probeGcMemberType(cfg: CloudConfig): Promise<Tier> {
	return (await fetchUserInfo(cfg))?.gc_member_type === "internal" ? "internal" : "external";
}

/** 把响应文本里的大整数 clip_id 引号化后再 JSON.parse——JSON.parse 对 >2^53 的 number 丢精度且不可逆,
 * 必须在文本层拦截（reviver 拿到的已是丢精度的 number,来不及）。 */
export function parseClipIdSafe<T>(text: string, status: number): ApiResp<T> {
	try {
		return JSON.parse(text.replace(/"clip_id"\s*:\s*(\d+)/g, '"clip_id":"$1"')) as ApiResp<T>;
	} catch {
		throw new Error(`服务响应解析失败 (HTTP ${status})`);
	}
}

/** 单次检索调用。抛 CloudError（含分类文案）——调用方决定局部化还是整体失败。 */
export async function searchOnce(cfg: CloudConfig, tier: Tier, body: SearchBody): Promise<SearchRespData> {
	const res = await fetch(`${cfg.base}${ENDPOINTS[tier]}`, {
		method: "POST",
		headers: { accept: "application/json", "Content-Type": "application/json", Authorization: cfg.apiKey },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
	});
	const r = parseClipIdSafe<SearchRespData>(await res.text(), res.status);
	if (r.code !== 200) throw new CloudError(r.code, classifyApiError(r.code, r.msg));
	return r.data ?? {};
}
