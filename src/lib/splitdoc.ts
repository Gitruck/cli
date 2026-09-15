/**
 * 拆分稿机器契约 v1 —— 解析 / 校验 / 落地投影（纯逻辑，不碰文件 IO）。
 *
 * 校验（split-doc-contract spec）：结构/枚举 → id 合法性（存在/from≤to/beats 不重叠）→ handoff 按 lane 分型
 * → transcript_hash 硬拒。错误逐条含 beat id + 原因。落地（timeline-projection spec）：整 beat 全 dropped → 跳过
 * 并入 report；部分 dropped → 按存活包络收缩、标 shrunk。落地产 struct_meta.split 快照 + dispatch 派单清单。
 */
import type { ProjectionView } from "./projection";
import {
	VISUAL_JOBS,
	briefLooksSingular,
	emptyDistribution,
	findTemplateIdRef,
	formatJobDistribution,
	isVisualJob,
	needsVisualJobNote,
	type JobDistribution,
	type VisualJob,
} from "./mg-visual-job";
// 「span → 存活实例包络」的**唯一**实现（add-consume-side-reprojection）：split 落地与 mg/matrix
// 消费侧共用同一份 —— 两侧相等是「同一段代码 × 同一份输入」的构造性保证，MUST NOT 两处各算一遍。
import { buildSpanIndex, envelopeForSpan } from "./reproject";
import { r3 } from "./frame-domain";

export const BASE_TRACKS = ["真人出镜", "口播继续", "旁白主导"] as const;
export const LANES = ["A_ROLL", "MG", "AI_DRAMA", "FILM_BROLL"] as const;
export const NARRATIVES = [
	"mirror-hook",
	"demolition",
	"container-translation",
	"abyssal-fall",
	"holding",
	"reversal-elevation",
	"callback-closure",
	"typography-emphasis",
] as const;
export const CONTAINER_STAGES = [
	"none",
	"seed",
	"expand",
	"translate",
	"rupture",
	"flip",
	"callback",
] as const;
export const IRREPLACEABILITY = ["必须真人出镜", "优先 MG", "可被 B-roll 替代", "可降级处理"] as const;
export const AUX_TYPES = [
	"quote-card",
	"term-callout",
	"network-diagram",
	"archive-caption",
	"pause-card",
	"data-annotation",
	"timeline-tag",
	// 第八枚（add-aux-rrv-overlay-particle）：承接透明叠层颗粒派单的 aux 类型——
	// 与前七枚纯建议性不同，overlay aux 必带 handoff（duration_hint 正数）、由 buildLanding
	// 投影进 dispatch.mg + 合成 struct_meta.split.beats（lane=MG），铺出叠在底轨主视觉上的透明颗粒。
	"overlay",
] as const;

export type Lane = (typeof LANES)[number];

/**
 * 关键词锚（add-keyword-anchored-broll）：FILM_BROLL beat 的 `handoff.anchors` 条目——agent 圈定的
 * 「听到关键词的瞬间看到对应画面」锚点，铺轨时锚 query 的**原始 sim 最高的合格命中**
 * （原始检索相似度，不是 mark/highlight 融合分）钉在关键词说出时刻。
 * 锚预留**优先于**普通序贯槽消费（铺轨前先为每锚锁住 sim 第一名，落位或降级后立即释放）；
 * 取不到第一名时锚 outcome 如实报名次与去向，MUST NOT 静默当成钉准。
 *
 * 措辞为什么要写这么死（fix-anchor-top-hit-guarantee）：旧口径只写「最高分命中」，实现取的却是
 * 「池内首个未被消费的合格对」，两次真机复现——2026-08-23 黄石锚落其池第 7 名（0.2801），
 * 2026-09-02 武汉「十二中校门」锚落 36 条命中里 sim 第 29 名（画面是《三色绘恋》户外广告牌，
 * 而 sim 第 1 名的校门段被前序 B02 一条泛化 query 以 0.3531 < 0.4274 的更低分先消费掉）。
 * 旧口径「最高分」这三个字含糊到能同时指融合分与首个可用对，正是那次事故的一半病灶。
 *
 * 拆分层只写语义（哪个词、哪句、什么画面）；说出时刻（at_sec）由消费侧（matrix plan）现场内插。
 */
export interface SplitAnchor {
	/** 关键词原文（须为所在句 text 的子串——照原句抄写，勿改写勿增删标点）。 */
	keyword: string;
	/** 关键词所在句 utterance id（须落在该 beat 的 span 区间内）。 */
	utterance: string;
	/** 锚专属检索词（视觉描述，与 handoff.queries 同链检索）。 */
	query: string;
}
/** 每 beat 锚上限（主理人 2026-08-19 拍板 0-2）：锚过密会把序贯填充区间切碎。 */
export const MAX_ANCHORS_PER_BEAT = 2;

/**
 * 遗留 lane 别名（去品牌化读旧兼容）：既有工程/拆分稿的品牌名读入即归一为中性名。
 * 写侧一律新名（buildLanding/struct_meta/dispatch）；此表只服务读侧双名认旧。
 */
const LEGACY_LANE_ALIASES: Record<string, Lane> = { RRV_MG: "MG" };

/** lane 归一：命中中性枚举或遗留别名即返回中性 Lane；否则 undefined（非法）。 */
export function normalizeLane(v: unknown): Lane | undefined {
	if (typeof v !== "string") return undefined;
	if ((LANES as readonly string[]).includes(v)) return v as Lane;
	return LEGACY_LANE_ALIASES[v];
}

export interface SplitSpan {
	from: string;
	to: string;
}

/** 辅助层挂载范围三型：整 beat / id 区间 / 触发点。 */
export type AuxMount = "same_beat" | { from: string; to: string } | { trigger: string };

export interface SplitAuxLayer {
	type: string;
	mount: AuxMount;
	role: string;
	note?: string;
	necessity?: string;
	promote_condition?: string;
	fallback?: string;
	/**
	 * 颗粒派单入参（add-aux-rrv-overlay-particle）：仅 `type==="overlay"` 的 aux 承接——
	 * 镜像 MG lane 的 handoff。`duration_hint`（正数秒）与 `visual_job`（四档）必填，
	 * 其余可选透传给派生颗粒。
	 * ⚠️ `visual_job` 在**类型上**仍是可选：旧派单稿里它不在，校验器负责判红，
	 * 类型层若写成必填，读旧稿的代码会先在编译期炸掉、错过那条说人话的校验消息。
	 */
	handoff?: {
		duration_hint: number;
		visual_job?: unknown;
		visual_brief?: unknown;
		category?: string;
		slug_hint?: string;
		theme?: string;
		bg?: string;
	};
}

export interface SplitBeat {
	id: string;
	span: SplitSpan;
	base_track: string;
	lane: string;
	narrative: string;
	container_stage: string;
	rhythm: string;
	visual_task: string;
	irreplaceability: string;
	handoff?: Record<string, unknown>;
	aux_layers?: SplitAuxLayer[];
	fallback?: string;
	callback_of?: string;
	note?: string;
}

export interface SplitDoc {
	contract_version: string;
	transcript_hash: string;
	beats: SplitBeat[];
	queues?: Record<string, unknown>;
}

/** splitdoc 校验用词表（来自有效栏目配置，column-config spec）。 */
export interface VocabCtx {
	narrative: readonly string[];
	container_stage: readonly string[];
	base_track: readonly string[];
	/** "allow" 时 narrative/container_stage/base_track 三项不做枚举校验（纯自由串，完全异构栏目）。 */
	unknown_narrative?: "allow" | "reject";
}

/** 校验上下文：utterance id 的**权威源序**（用于区间/重叠判定）+ 当前 transcript 的 text_hash。 */
export interface ValidationCtx {
	utteranceIds: string[];
	transcriptHash: string;
	/** 有效栏目配置的 vocab；缺省 = 内置默认（现枚举），校验行为与词表化前一致。 */
	vocab?: VocabCtx;
	/**
	 * 句文本供给（add-keyword-anchored-broll）：utterance id → text。分层理由：splitdoc 是纯逻辑层
	 * 不碰文件 IO，transcript 全文只在命令层（split 落地 loadTranscript 之后）持有——沿 utteranceIds
	 * 同一条供给路径注入。供给在位时 anchors 的「keyword ∈ 句文」在校验链内完成（失败零副作用口径
	 * 不变）；供给缺席只校字段形态 + utterance ∈ span，不做静默降级猜测。
	 */
	utteranceTexts?: Map<string, string>;
}

export interface ValidationResult {
	errors: string[];
	warnings: string[];
	/**
	 * [gate-mg-visual-job] MG 槽位的四档职能分布（`statement` / `relation` / `data` / `decor`）。
	 *
	 * ⚠️ **观测归观测，裁决归裁决**：本字段 MUST NOT 被用作任何判红依据。
	 * 它是给人看的信号——一眼看出「这片子 20 个槽位全是 statement」，比任何阈值都直接。
	 * ⚠️ `decor` MUST 单列：它是必要但可被滥用的一档（「标成 decor 就不用想视觉了」），
	 * **异常多本身就是信号**，并进 statement 就看不见了。
	 */
	visualJobs?: JobDistribution;
}

function isNonEmptyStr(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function enumOk<T extends readonly string[]>(v: unknown, list: T): boolean {
	return typeof v === "string" && (list as readonly string[]).includes(v);
}

/**
 * 有限集合拒绝理由的合法值提示（add-split-doc-field-completeness）。
 *
 * 为什么单开一个 helper：2026-09-02 真机复盘里 `irreplaceability` 按字面意思填了自然语言，
 * 整稿被拒，而报错只说「四枚举之一」——**同一个 forEach 里相邻的 lane 那行却把四个值摆出来了**。
 * 于是写稿人只能退出去翻 `skills/gtrk-splitter/references/field-schema.md` 才知道那四个值是什么。
 * 报错自带答案，就把「文档缺失」降级成一次无害重试。七处有限集合判定统一走这里，免得日后再分叉。
 *
 * ⚠️ 入参 MUST 是代码常量或**当次生效**的栏目 vocab 引用；本函数内 MUST NOT 出现任何硬编码字面值——
 * 手抄一份副本必然与正本漂移，而**漂移的合法值列表比不列更坏**（把人引向一个当次并不生效的答案）。
 */
function enumHint(list: readonly string[]): string {
	return `（合法值：${list.join(" | ")}）`;
}

/**
 * 全量校验拆分稿。返回逐条错误 + 警告；`errors` 非空即整体拒绝（命令层非 0 退出、零副作用）。
 */
export function validateSplitDoc(doc: unknown, ctx: ValidationCtx): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
		return { errors: ["拆分稿必须是一个 JSON 对象"], warnings };
	}
	const d = doc as Record<string, unknown>;

	// 校验源 = 有效栏目 vocab；缺省 = 内置枚举（默认栏目行为不变）。unknown_narrative=allow 时该三项放行自由串。
	const vocab: VocabCtx = ctx.vocab ?? {
		narrative: NARRATIVES,
		container_stage: CONTAINER_STAGES,
		base_track: BASE_TRACKS,
	};
	const freeVocab = vocab.unknown_narrative === "allow";

	if (d.contract_version !== "v1") {
		errors.push(`contract_version 必须为 "v1"（实际：${JSON.stringify(d.contract_version)}）`);
	}
	if (!isNonEmptyStr(d.transcript_hash)) {
		errors.push("缺 transcript_hash（应从投影视图透传）");
	} else if (d.transcript_hash !== ctx.transcriptHash) {
		errors.push(
			`transcript_hash 不匹配：拆分稿 ${d.transcript_hash} ≠ 当前 transcript ${ctx.transcriptHash}——转写已变更，请重新导出视图并重拆`,
		);
	}

	if (!Array.isArray(d.beats) || d.beats.length === 0) {
		errors.push("beats 必须是非空数组");
		return { errors, warnings };
	}

	const idIndex = new Map<string, number>();
	ctx.utteranceIds.forEach((id, i) => idIndex.set(id, i));

	// 逐 beat 校验，同时收集合法区间供重叠检测
	const ranges: { id: string; from: number; to: number }[] = [];
	const seenBeatIds = new Set<string>();
	// [gate-mg-visual-job] 四档计数。**观测归观测、裁决归裁决** —— 本分布 MUST NOT 判红。
	const dist: JobDistribution = emptyDistribution();

	(d.beats as unknown[]).forEach((raw, i) => {
		const tag = (() => {
			const bid = (raw as Record<string, unknown>)?.id;
			return isNonEmptyStr(bid) ? bid : `beats[${i}]`;
		})();
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			errors.push(`${tag}：beat 必须是对象`);
			return;
		}
		const b = raw as Record<string, unknown>;

		if (!isNonEmptyStr(b.id)) errors.push(`${tag}：缺 id`);
		else if (!/^B\d{2,}$/.test(b.id)) errors.push(`${b.id}：id 须为 "B"+两位起序号（如 B01）`);
		else if (seenBeatIds.has(b.id)) errors.push(`${b.id}：beat id 重复`);
		else seenBeatIds.add(b.id);

		// base_track/narrative/container_stage 校验源 = 栏目 vocab（默认=内置枚举）；allow 时放行自由串（仍须非空）
		if (freeVocab) {
			if (!isNonEmptyStr(b.base_track)) errors.push(`${tag}：缺 base_track`);
			if (!isNonEmptyStr(b.narrative)) errors.push(`${tag}：缺 narrative`);
			if (!isNonEmptyStr(b.container_stage)) errors.push(`${tag}：缺 container_stage`);
		} else {
			// 三项回显 **当次生效** 的 vocab：栏目覆写后内置八/七枚举就不作数了，
			// 回显一张当次没在用的表 = 把人引向错误答案，故入参只能是 vocab.*、不能是 NARRATIVES/CONTAINER_STAGES
			if (!enumOk(b.base_track, vocab.base_track)) errors.push(`${tag}：base_track 非法${enumHint(vocab.base_track)}`);
			if (!enumOk(b.narrative, vocab.narrative)) errors.push(`${tag}：narrative 非法${enumHint(vocab.narrative)}`);
			if (!enumOk(b.container_stage, vocab.container_stage)) errors.push(`${tag}：container_stage 非法${enumHint(vocab.container_stage)}`);
		}
		// lane 双名认旧：遗留品牌值（如 RRV_MG）归一后放行，不判非法（既有工程零迁移）。
		// 提示只列中性新名：遗留别名是读旧兼容，不是给写稿人挑的答案。
		if (!normalizeLane(b.lane)) errors.push(`${tag}：lane 非法${enumHint(LANES)}`);
		if (!enumOk(b.irreplaceability, IRREPLACEABILITY)) errors.push(`${tag}：irreplaceability 非法${enumHint(IRREPLACEABILITY)}`);
		if (!isNonEmptyStr(b.rhythm)) errors.push(`${tag}：缺 rhythm（人读节奏标签）`);
		if (!isNonEmptyStr(b.visual_task)) errors.push(`${tag}：缺 visual_task（一句话视觉任务）`);

		// span 与 id 合法性
		const span = b.span as Record<string, unknown> | undefined;
		let fromIdx = -1;
		let toIdx = -1;
		if (!span || !isNonEmptyStr(span.from) || !isNonEmptyStr(span.to)) {
			errors.push(`${tag}：缺 span.from / span.to（utterance id 区间）`);
		} else {
			if (!idIndex.has(span.from)) errors.push(`${tag}：span.from 引用了不存在的 utterance id ${span.from}`);
			else fromIdx = idIndex.get(span.from)!;
			if (!idIndex.has(span.to)) errors.push(`${tag}：span.to 引用了不存在的 utterance id ${span.to}`);
			else toIdx = idIndex.get(span.to)!;
			if (fromIdx >= 0 && toIdx >= 0) {
				if (fromIdx > toIdx) errors.push(`${tag}：区间倒序（span.from ${span.from} 晚于 span.to ${span.to}）`);
				else if (isNonEmptyStr(b.id)) ranges.push({ id: b.id, from: fromIdx, to: toIdx });
			}
		}

		// handoff 按 lane 分型
		validateHandoff(tag, b, errors, warnings);

		// [gate-mg-visual-job] 视野隔离的机器代理：整条 beat（含 handoff / aux）扫模板 id。
		// ⚠️ 扫的是**整条**而不是某几个具名字段：模板 id 可能落在 theme / slug_hint /
		//    visual_brief / 甚至一个将来才加的字段里。按字段名白名单扫，加一个字段就漏一个。
		validateNoTemplateIdLeak(tag, b, errors);

		// 职能分布（观测，MUST NOT 判红）
		countVisualJobs(b, dist);

		// 关键词锚（add-keyword-anchored-broll）：utterance ∈ span 复用上方 fromIdx/toIdx 判定
		validateAnchors(tag, b, idIndex, fromIdx, toIdx, ctx.utteranceTexts, errors, warnings);

		// 辅助层
		if (b.aux_layers != null) {
			if (!Array.isArray(b.aux_layers)) errors.push(`${tag}：aux_layers 必须是数组`);
			else (b.aux_layers as unknown[]).forEach((a, ai) => validateAux(`${tag}.aux[${ai}]`, a, idIndex, errors, warnings));
		}
	});

	// 区间重叠检测（按 from 升序，相邻比对）
	const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
	for (let i = 1; i < sorted.length; i++) {
		const prev = sorted[i - 1];
		const cur = sorted[i];
		if (cur.from <= prev.to) {
			errors.push(`${prev.id} 与 ${cur.id}：utterance 区间重叠（beats 之间不允许交集）`);
		}
	}

	// [gate-mg-visual-job] 全片没有任何关系型视觉（relation + data 为 0）⇒ 顶层要具名一句。
	//
	// ⚠️ **MUST NOT 实现成比例阈值。** 比例阈值（「模板占比 ≤ 60%」）是代理指标，两头都不成立：
	// 误伤合法形态（纯字卡包装的口播片本来就该全是模板），又可被「宣告一个例外槽位」绕过，
	// 且任何具体的 N 都给不出依据（主理人 2026-09-15 当场否掉初版的 60%）。
	// 换成「一个都没有时要求具名一句」——「这片子完全不需要非模板的东西」是个**质的判断**，
	// 可以要求交代；「不超过 N%」是个**量的判断**，交代不了。
	const hasMgSlot = dist.statement + dist.relation + dist.data + dist.decor > 0;
	if (hasMgSlot && needsVisualJobNote(dist) && !isNonEmptyStr(d.mg_visual_job_note)) {
		errors.push(
			`本片未声明任何关系型视觉（visual_job 分布：${formatJobDistribution(dist)}）——` +
				"顶层须具名 mg_visual_job_note，一句话说明为什么通篇只有单一陈述。" +
				"（纯字卡包装的口播片是**合法**形态，本条只要求它是个有意识的选择）",
		);
	}

	return { errors, warnings, visualJobs: dist };
}

/** 统计一条 beat（含 aux）贡献的四档计数。缺失/非法不计——那由校验负责判红。 */
function countVisualJobs(b: Record<string, unknown>, dist: JobDistribution): void {
	const bump = (h: unknown) => {
		const job = (h as Record<string, unknown> | undefined)?.visual_job;
		if (isVisualJob(job)) dist[job as VisualJob]++;
	};
	if (b.lane === "MG" || b.lane === "RRV_MG") bump(b.handoff);
	if (Array.isArray(b.aux_layers)) {
		for (const a of b.aux_layers as Record<string, unknown>[]) {
			if (a?.kind === "overlay" || a?.type === "overlay" || a?.handoff) bump(a.handoff);
		}
	}
}

function validateHandoff(
	tag: string,
	b: Record<string, unknown>,
	errors: string[],
	warnings: string[],
): void {
	const lane = b.lane;
	const handoff = b.handoff as Record<string, unknown> | undefined;
	if (lane === "A_ROLL") {
		if (handoff != null) warnings.push(`${tag}：A_ROLL 不应带 handoff，已忽略`);
		return;
	}
	// MG（去品牌化前 RRV_MG）：双名认旧，遗留 lane 值同走此分支
	if (lane === "MG" || lane === "RRV_MG") {
		if (!handoff || typeof handoff.duration_hint !== "number") {
			errors.push(`${tag}：MG 的 handoff.duration_hint 必填（秒，数值）`);
		}
		// category 可选软校验（裁决⑩，lane 不新增故宽松：非法只告警不拒）；已知集含新旧品类键，遗留值不告警
		if (handoff && handoff.category !== undefined && !isKnownCategory(handoff.category)) {
			warnings.push(`${tag}：handoff.category「${String(handoff.category)}」非已知品类${enumHint(MG_CATEGORIES)}，已透传但下游按 opaque 反推`);
		}
		validateVisualJob(tag, handoff, errors, warnings);
		return;
	}
	if (lane === "FILM_BROLL") {
		const q = handoff?.queries;
		if (!Array.isArray(q) || q.length === 0 || !q.every((x) => isNonEmptyStr(x))) {
			errors.push(`${tag}：FILM_BROLL 缺检索 query（handoff.queries 必须为非空字符串数组）`);
		}
		return;
	}
	// AI_DRAMA：字段全可选，下游有推断默认——不强校验
}

/**
 * 视觉职能校验（change: gate-mg-visual-job）。
 *
 * 判据是「**这段的意思里有没有第二个东西与它并置**」：
 * 就一句话 / 一个词 / 一个标题 ⇒ `statement`；出现对比 / 并置 / 因果 / 包含 / 递进 / 聚合 / 循环
 * ⇒ `relation`；具体的量、步骤或拓扑 ⇒ `data`；不承载信息 ⇒ `decor`。
 *
 * ⚠️ **判的是意思的结构，不是用什么画。** 一块「温柔—坚定 / 和善—有立场」的并置面板
 * 是纯文字画的，但它表达的是对照关系 ⇒ `relation`，**不是** `statement`。
 *
 * ⚠️ MUST 必填、MUST NOT 带缺省值：可选字段在存量派单与偷懒路径上都会走缺省，闸等于没开。
 */
function validateVisualJob(
	tag: string,
	handoff: Record<string, unknown> | undefined,
	errors: string[],
	warnings: string[],
): void {
	const job = handoff?.visual_job;
	if (job === undefined) {
		errors.push(`${tag}：handoff.visual_job 必填${enumHint(VISUAL_JOBS)}（判据是「这段的意思里有没有第二个东西与它并置」，与用不用文字无关）`);
		return;
	}
	if (!isVisualJob(job)) {
		errors.push(`${tag}：handoff.visual_job「${String(job)}」不在枚举内${enumHint(VISUAL_JOBS)}`);
		return;
	}
	if (job === "relation") {
		const brief = handoff?.visual_brief;
		if (!isNonEmptyStr(brief)) {
			// ⚠️ brief **MUST NOT 被要求是非文字的**：「两列并置、破折号连起来、右列更重」
			// 与「三个齿轮咬合」是同一类合格答案。要求「必须非文字」会把**用排版画关系**
			// 这条路堵死，而那恰恰是要保住的东西。
			errors.push(`${tag}：visual_job=relation 须填 handoff.visual_brief（一句话说清这个关系靠什么视觉手段成立；用排版画关系同样合格）`);
		} else if (briefLooksSingular(brief)) {
			// 告警不判红：自动识别「这句话里有没有关系」不可靠，硬闸会误伤排版型答案。
			warnings.push(`${tag}：visual_brief 读起来只有一个东西——若这段其实是单一陈述，改判 statement 更诚实`);
		}
	}
}

/**
 * 视野隔离的机器代理（change: gate-mg-visual-job）。
 *
 * 派单产物的**任何自由文本字段**里出现 `tfx-*` 形状的模板 id ⇒ 判红。
 * 它是「这一步看过库」的直接证据。
 *
 * ⚠️ 理由是**锚定**：光把判断点前移还不够——若库仍在视野里，agent 会
 * **从「库里有什么」倒推「这段需要什么」**。正确的形态不是早点判，
 * 是**判的时候那个选项根本不存在**。
 *
 * ⚠️ 射程如实声明：本条**无法保证** agent 的上下文里没有模板库。
 * 能做到的只有「图纸与工具面不提供」＋「产物里留下痕迹就判红」。**提高代价，不是杜绝。**
 */
function validateNoTemplateIdLeak(tag: string, obj: unknown, errors: string[], path = ""): void {
	if (typeof obj === "string") {
		const hit = findTemplateIdRef(obj);
		if (hit) {
			errors.push(`${tag}：${path || "文本"} 里出现模板 id「${hit}」——派单阶段 MUST NOT 引用具体模板（判「这段要什么」的那一步不该看见模板库）`);
		}
		return;
	}
	if (Array.isArray(obj)) {
		obj.forEach((v, i) => validateNoTemplateIdLeak(tag, v, errors, `${path}[${i}]`));
		return;
	}
	if (obj && typeof obj === "object") {
		for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
			validateNoTemplateIdLeak(tag, v, errors, path ? `${path}.${k}` : k);
		}
	}
}

/**
 * 关键词锚校验（add-keyword-anchored-broll）：handoff.anchors 仅 FILM_BROLL 主层消费——
 * ≤MAX_ANCHORS_PER_BEAT 个/beat、keyword/utterance/query 非空、utterance ∈ beat span（id 序比较）。
 * 「keyword ∈ 句文」只在 ctx 供给 utteranceTexts 时校验（分层理由见 ValidationCtx.utteranceTexts 注释）。
 */
function validateAnchors(
	tag: string,
	b: Record<string, unknown>,
	idIndex: Map<string, number>,
	fromIdx: number,
	toIdx: number,
	texts: Map<string, string> | undefined,
	errors: string[],
	warnings: string[],
): void {
	const handoff = b.handoff as Record<string, unknown> | undefined;
	const anchors = handoff?.anchors;
	if (anchors === undefined) return;
	// 锚只被 FILM_BROLL 派单分支消费（dispatch.film_broll 透传）；其余 lane 出现即告警忽略，不静默
	if (normalizeLane(b.lane) !== "FILM_BROLL") {
		warnings.push(`${tag}：handoff.anchors 仅 FILM_BROLL 主层消费（当前 lane=${String(b.lane)}），已忽略不透传`);
		return;
	}
	if (!Array.isArray(anchors)) {
		errors.push(`${tag}：handoff.anchors 必须是数组`);
		return;
	}
	if (anchors.length > MAX_ANCHORS_PER_BEAT) {
		errors.push(`${tag}：anchors 至多 ${MAX_ANCHORS_PER_BEAT} 个/beat（得到 ${anchors.length}）——锚过密会把序贯填充区间切碎`);
	}
	anchors.forEach((raw, ai) => {
		const atag = `${tag}.anchors[${ai}]`;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			errors.push(`${atag}：锚必须是对象（{keyword, utterance, query}）`);
			return;
		}
		const a = raw as Record<string, unknown>;
		if (!isNonEmptyStr(a.keyword)) errors.push(`${atag}：缺 keyword（关键词原文）`);
		if (!isNonEmptyStr(a.query)) errors.push(`${atag}：缺 query（锚专属检索词，写视觉描述）`);
		if (!isNonEmptyStr(a.utterance)) {
			errors.push(`${atag}：缺 utterance（关键词所在句 id）`);
			return;
		}
		const ui = idIndex.get(a.utterance);
		if (ui === undefined) {
			errors.push(`${atag}：utterance 引用了不存在的 id ${a.utterance}`);
			return;
		}
		if (fromIdx >= 0 && toIdx >= 0 && (ui < fromIdx || ui > toIdx)) {
			errors.push(`${atag}：utterance ${a.utterance} 不在该 beat 的 span 区间内`);
		}
		const text = texts?.get(a.utterance);
		if (isNonEmptyStr(a.keyword) && typeof text === "string" && !text.includes(a.keyword)) {
			errors.push(`${atag}：keyword「${a.keyword}」不是句 ${a.utterance} 文本的子串——照原句抄写关键词（勿改写、勿增删标点）`);
		}
	});
}

function validateAux(
	tag: string,
	raw: unknown,
	idIndex: Map<string, number>,
	errors: string[],
	warnings: string[],
): void {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		errors.push(`${tag}：辅助层必须是对象`);
		return;
	}
	const a = raw as Record<string, unknown>;
	if (!enumOk(a.type, AUX_TYPES)) errors.push(`${tag}：type 非法${enumHint(AUX_TYPES)}`);
	if (!isNonEmptyStr(a.role)) errors.push(`${tag}：缺 role（职责）`);
	// overlay 叠层颗粒类型（add-aux-rrv-overlay-particle）：强校验 handoff.duration_hint 正数
	// （该 aux 要生成颗粒，无时长不成立）；category 走软校验（非法告警不拒，同 lane 分型纪律）。
	if (a.type === "overlay") {
		const handoff = a.handoff as Record<string, unknown> | undefined;
		// [gate-mg-visual-job] overlay aux 派生的是颗粒槽位，与 MG 主层同样必填 visual_job。
		// aux 多为「B-roll 底轨之上叠透明概念图解」，**正是最该判 relation 的一档**——
		// 漏掉它等于把最需要原创的那批放掉。
		validateVisualJob(tag, handoff, errors, warnings);
		if (!handoff || typeof handoff.duration_hint !== "number" || !(handoff.duration_hint > 0)) {
			errors.push(`${tag}：overlay aux 缺颗粒时长（handoff.duration_hint 必填且须为正数）`);
		}
		if (handoff && handoff.category !== undefined && !isKnownCategory(handoff.category)) {
			warnings.push(`${tag}：handoff.category「${String(handoff.category)}」非已知品类${enumHint(MG_CATEGORIES)}，已透传但下游按 opaque 反推`);
		}
	}
	const m = a.mount;
	if (m === "same_beat") return;
	if (typeof m === "object" && m !== null) {
		const mo = m as Record<string, unknown>;
		if (isNonEmptyStr(mo.trigger)) {
			if (!idIndex.has(mo.trigger)) errors.push(`${tag}：mount.trigger 引用了不存在的 utterance id ${mo.trigger}`);
			return;
		}
		if (isNonEmptyStr(mo.from) && isNonEmptyStr(mo.to)) {
			if (!idIndex.has(mo.from)) errors.push(`${tag}：mount.from 引用了不存在的 utterance id ${mo.from}`);
			if (!idIndex.has(mo.to)) errors.push(`${tag}：mount.to 引用了不存在的 utterance id ${mo.to}`);
			if (idIndex.has(mo.from) && idIndex.has(mo.to) && idIndex.get(mo.from)! > idIndex.get(mo.to)!) {
				errors.push(`${tag}：mount 区间倒序`);
			}
			return;
		}
	}
	errors.push(`${tag}：mount 非法（应为 "same_beat" | {from,to} | {trigger}）`);
}

// ── 落地投影 ──────────────────────────────────────────────────────────────

export interface SplitMetaBeat {
	id: string;
	lane: string;
	span: SplitSpan;
	track_st: number;
	track_ed: number;
	shrunk?: boolean;
	handoff?: Record<string, unknown>;
	/**
	 * 源时基区间（add-split-source-ranges）：v1 恒单元素 = span 源包络 [from.st, to.ed]，
	 * 含句间静默与被剪词——消费方以「源区间 ∩ 当刻颗粒源窗口」投影即得实际覆盖，
	 * 恢复被剪词（变长）即点亮。数组形状为将来按投影实例精化预留。
	 */
	source_ranges?: { st: number; ed: number }[];
	/**
	 * 语义字段透传（add-split-source-ranges）：客户端色带 hover 详情卡展示「这段对应什么」。
	 * 原样透传拆分稿 narrative（叙事功能）/container_stage（容器阶段）/visual_task（视觉任务描述）。
	 */
	narrative?: string;
	container_stage?: string;
	visual_task?: string;
	/** MG 品类子类型透传（裁决⑩）：供 opencut 色带按 category 分层（overlay 透明叠加/fullscreen 不透明满屏）。 */
	category?: string;
}

export interface StructMetaSplit {
	contract_version: string;
	transcript_hash: string;
	projected_at: string;
	/** 口播素材 id（= transcript.material_id）——消费方脱离 transcript 文件定位素材绑定。 */
	material_id?: string;
	beats: SplitMetaBeat[];
}

/** MG 颗粒品类子类型（裁决⑩，不新增 lane）。一期 overlay/fullscreen；二期扩 subtitle/title。 */
export const MG_CATEGORIES = ["overlay", "fullscreen", "subtitle", "title"] as const;
export type MgCategory = (typeof MG_CATEGORIES)[number];
/**
 * 透明/不透明默认映射（category → 期望 opaque）。透明叠加品类→false，满屏底层品类→true。
 * 双名认旧：同时含中性新键（overlay/fullscreen/subtitle/title）与遗留品牌键
 * （rrv-overlay/mg-fullscreen/explain-subtitle/op-ed-title），既有工程/颗粒零迁移仍命中。
 */
export const CATEGORY_EXPECTED_OPAQUE: Record<string, boolean> = {
	overlay: false,
	fullscreen: true,
	subtitle: false,
	title: true,
	// 遗留品牌键（读旧兼容）
	"rrv-overlay": false,
	"mg-fullscreen": true,
	"explain-subtitle": false,
	"op-ed-title": true,
};
export function isMgCategory(v: unknown): v is MgCategory {
	return typeof v === "string" && (MG_CATEGORIES as readonly string[]).includes(v);
}
/** 已知品类（含遗留品牌键）：命中即视为已知、软校验不告警。 */
function isKnownCategory(v: unknown): boolean {
	return typeof v === "string" && Object.prototype.hasOwnProperty.call(CATEGORY_EXPECTED_OPAQUE, v);
}

export interface MgDispatch {
	beat: string;
	composition_id: string;
	/** **槽位包络** r3(track_ed − track_st) = 落轨 clip 的坑位长度（铁律⑦，非动画节奏参考）。 */
	duration: number | null;
	/** 动画主叙事节奏参考，原样透传自 handoff.duration_hint；缺失落 null。**不参与落轨**。 */
	duration_hint: number | null;
	/** 品类子类型（可选；缺省=向后兼容，下游回落颗粒 HTML 反推 opaque）。 */
	category?: unknown;
	/**
	 * [gate-mg-visual-job §1.1] 这一槽的**视觉职能**（四档），原样透传自 handoff。
	 * 生产侧据它判 `relation` / `data` 两档能不能收文字模板颗粒。
	 * ⚠️ 类型写 `unknown` 而不是 `VisualJob`：**旧派单里它不在**，下游 MUST 按「可能缺」处理。
	 */
	visual_job?: unknown;
	/**
	 * `relation` 档的一句话视觉说明，**为了错误消息**而透传——判红时把 agent 自己写的这句
	 * 摆在它交上来的东西旁边，比任何我们写的措辞都更说明问题。
	 */
	visual_brief?: unknown;
	theme?: unknown;
	bg?: unknown;
	slug_hint?: unknown;
	track_st: number;
	track_ed: number;
	/**
	 * 该条目对应的 utterance 区间（add-consume-side-reprojection，纯追加可选）——让派单**自述「派什么」**，
	 * 时码不再是它唯一的权威内容。aux 派生条目写的是 **aux 自己的** span（可为主 beat span 的子区间），
	 * 这直接消掉「按 `beat` 字段回查会把 aux 错算成主 beat 窗口」的陷阱。
	 */
	span?: SplitSpan;
}
export interface FilmDispatch {
	beat: string;
	queries: string[];
	shots?: unknown;
	per_shot_sec?: unknown;
	exclude?: unknown;
	/** 关键词锚（add-keyword-anchored-broll，纯追加可选）：agent 圈定的 0-2 个锚原样透传——
	 * 不派生颗粒；at_sec 内插与锚定布局在消费侧（gtrk matrix）完成。 */
	anchors?: SplitAnchor[];
	track_st: number;
	track_ed: number;
	/** 该 beat 的 utterance 区间（add-consume-side-reprojection，纯追加可选）。 */
	span?: SplitSpan;
}
export interface AiDramaDispatch {
	beat: string;
	track_st: number;
	track_ed: number;
	/** 该 beat 的 utterance 区间（add-consume-side-reprojection，纯追加可选）。 */
	span?: SplitSpan;
	[k: string]: unknown;
}
export interface Dispatch {
	mg: MgDispatch[];
	film_broll: FilmDispatch[];
	ai_drama: AiDramaDispatch[];
}

export interface SkipReport {
	beat: string;
	reason: string;
}
export interface ShrinkReport {
	beat: string;
	kept: number;
	dropped: number;
	track_st: number;
	track_ed: number;
}

export interface Landing {
	split: StructMetaSplit;
	dispatch: Dispatch;
	skipped: SkipReport[];
	shrunk: ShrinkReport[];
	/**
	 * 校验通过却无派单分支的 lane（footgun 防御）：A_ROLL 故意无派单，此处只收未来扩展
	 * LANES 却漏改 dispatch 分派的遗漏 lane——落地不再静默，交由命令层告警。
	 */
	unhandledLanes: string[];
}

/**
 * 落地：把（已校验通过的）拆分稿 × 投影视图 → struct_meta.split 快照 + dispatch 派单清单 + 收缩/跳过报告。
 * 纯函数，不写文件。整 beat 全 dropped 跳过；部分 dropped 按存活包络收缩。
 */
export function buildLanding(
	doc: SplitDoc,
	view: ProjectionView,
	opts: {
		utteranceIds: string[];
		projectSlug: string;
		projectedAt: string;
		/** 源时基索引（add-split-source-ranges）：传则落地写 source_ranges/material_id，不传不写（向后兼容）。 */
		sourceIndex?: {
			materialId: string;
			utterances: Map<string, { st: number; ed: number }>;
		};
	},
): Landing {
	// id → 存活投影实例（可多实例）；无实例即该 id 被全剪。
	// **单点收敛**：索引与包络计算都走 reproject 叶子，消费侧重投影用的是同一份代码。
	const spanIndex = buildSpanIndex(view, opts.utteranceIds);

	const split: StructMetaSplit = {
		contract_version: doc.contract_version,
		transcript_hash: doc.transcript_hash,
		projected_at: opts.projectedAt,
		...(opts.sourceIndex ? { material_id: opts.sourceIndex.materialId } : {}),
		beats: [],
	};
	const dispatch: Dispatch = { mg: [], film_broll: [], ai_drama: [] };
	const skipped: SkipReport[] = [];
	const shrunk: ShrinkReport[] = [];
	const unhandledLanes = new Set<string>();

	for (const beat of doc.beats) {
		const env = envelopeForSpan(spanIndex, beat.span);
		if (env.kind !== "ok") {
			// 全剪 = 未落轨；unresolved 在此不可达（id 合法性由 validateSplitDoc 前置保证），同路处置不静默丢
			skipped.push({ beat: beat.id, reason: "span 内全部 utterance 被剪，未落轨" });
			continue;
		}
		const { track_st, track_ed, shrunk: isShrunk } = env;

		// 读旧写新：遗留 lane 值（RRV_MG）归一为中性名 MG 后落地/派单（既有工程零迁移）
		const lane = normalizeLane(beat.lane) ?? beat.lane;
		const metaBeat: SplitMetaBeat = { id: beat.id, lane, span: beat.span, track_st, track_ed };
		if (opts.sourceIndex) {
			const from = opts.sourceIndex.utterances.get(beat.span.from);
			const to = opts.sourceIndex.utterances.get(beat.span.to);
			// span 源包络（design D1）；端点异常防御跳过，不阻断落地
			if (from && to && to.ed > from.st) {
				metaBeat.source_ranges = [{ st: r3(from.st), ed: r3(to.ed) }];
			}
		}
		if (isShrunk) metaBeat.shrunk = true;
		// 语义透传（add-split-source-ranges）：客户端 hover 详情卡「这段对应什么」
		if (beat.narrative) metaBeat.narrative = beat.narrative;
		if (beat.container_stage) metaBeat.container_stage = beat.container_stage;
		if (beat.visual_task) metaBeat.visual_task = beat.visual_task;
		// MG 品类透传（裁决⑩）：category 原样透传（含遗留品牌值，opaque passthrough），供 opencut 色带按 category 分层
		if (lane === "MG" && typeof beat.handoff?.category === "string") metaBeat.category = beat.handoff.category;
		if (lane !== "A_ROLL" && beat.handoff) metaBeat.handoff = beat.handoff;
		split.beats.push(metaBeat);

		if (isShrunk) {
			shrunk.push({ beat: beat.id, kept: env.kept, dropped: env.dropped, track_st, track_ed });
		}

		const h = beat.handoff ?? {};
		const compositionId = `${opts.projectSlug}-${beat.id}`;
		if (lane === "MG") {
			dispatch.mg.push({
				beat: beat.id,
				composition_id: compositionId,
				// 铁律⑦：duration = 槽位包络（落轨事实）；hint 另立字段透传，不参与落轨。
				duration: r3(track_ed - track_st),
				duration_hint: typeof h.duration_hint === "number" ? h.duration_hint : null,
				...(h.category !== undefined ? { category: h.category } : {}),
				// [gate-mg-visual-job] 职能与 brief 必须进派单：生产侧硬闸判的就是
				// 「这个槽位声明了什么职能」，而 lint / lay 只读 dispatch，读不到 split 稿。
				// ⚠️ `visual_brief` 一并带上是**为了错误消息**：判红时把 agent 自己写的那句
				//    brief 打出来——它与交上来的东西直接冲突，那句话本身就是最强的说明。
				visual_job: h.visual_job,
				...(h.visual_brief !== undefined ? { visual_brief: h.visual_brief } : {}),
				theme: h.theme,
				bg: h.bg,
				slug_hint: h.slug_hint,
				track_st,
				track_ed,
				// 派单自述「派什么」（add-consume-side-reprojection）：消费方据此现场重投影，不必再靠时码说话
				span: beat.span,
			});
		} else if (lane === "FILM_BROLL") {
			// 关键词锚透传（add-keyword-anchored-broll）：已过校验的 anchors 原样进派单条目——
			// 拆分层不写任何秒级时码，说出时刻（at_sec）由消费侧现场内插（句级时码只在当刻投影里为真）
			const anchors = Array.isArray(h.anchors) && h.anchors.length ? (h.anchors as SplitAnchor[]) : undefined;
			dispatch.film_broll.push({
				beat: beat.id,
				queries: Array.isArray(h.queries) ? (h.queries as string[]) : [],
				shots: h.shots,
				per_shot_sec: h.per_shot_sec,
				exclude: h.exclude,
				...(anchors ? { anchors } : {}),
				track_st,
				track_ed,
				span: beat.span,
			});
		} else if (lane === "AI_DRAMA") {
			// span 排在 ...h 之后：handoff 里若混进同名键，以落地口径为准（span 是派单自述、不是创作参数）
			dispatch.ai_drama.push({ beat: beat.id, ...h, track_st, track_ed, span: beat.span });
		} else if (lane !== "A_ROLL") {
			// A_ROLL 故意无派单；其余 lane 过了校验却无 dispatch 分支
			// = 未来扩展 LANES 漏改此处 → 收集告警，不静默丢队列（footgun 防御）
			unhandledLanes.add(lane);
		}

		// ── aux 叠层颗粒投影（add-aux-rrv-overlay-particle）─────────────────────
		// 主 beat 派单后，把每条 type="overlay" 的 aux 投影为派生颗粒：进 dispatch.mg +
		// 追加合成 struct_meta.split.beats（lane=MG、category=overlay），铺出叠在底轨主视觉上的透明颗粒。
		// composition_id=<slug>-<beatId>-aux<n>（n 从 1，位置计数保证全局唯一 + 幂等）。
		// 注意：此处到达时主 beat 必有存活实例（上方 instances.length===0 已 continue），故 same_beat 恒有效落轨。
		let auxN = 0;
		for (const aux of beat.aux_layers ?? []) {
			if (aux.type !== "overlay") continue;
			auxN += 1;
			const auxTag = `${beat.id}-aux${auxN}`;
			const mount = aux.mount;
			// mount 投影：same_beat 复用主 beat span；{from,to} 取该子区间存活实例包络；{trigger} 一期不支持
			let auxFromId: string;
			let auxToId: string;
			if (mount === "same_beat") {
				auxFromId = beat.span.from;
				auxToId = beat.span.to;
			} else if ("from" in mount && "to" in mount) {
				auxFromId = mount.from;
				auxToId = mount.to;
			} else {
				// {trigger} 点挂载无干净源区间（duration_hint 是时间线秒非源秒 → 跟随会不准），一期 skip + 告警，二期补合成窗口
				skipped.push({ beat: auxTag, reason: "overlay aux 使用 {trigger} 点挂载，一期不支持（二期补合成窗口）" });
				continue;
			}
			const auxSpan: SplitSpan = { from: auxFromId, to: auxToId };
			const auxEnv = envelopeForSpan(spanIndex, auxSpan);
			if (auxEnv.kind !== "ok") {
				// 全 dropped：与主 beat 全剪同纪律，计入 skipped 不静默丢
				skipped.push({ beat: auxTag, reason: "overlay aux 源区间 utterance 全被剪，未落轨" });
				continue;
			}
			const auxTrackSt = auxEnv.track_st;
			const auxTrackEd = auxEnv.track_ed;
			const auxCompositionId = `${opts.projectSlug}-${beat.id}-aux${auxN}`;
			const ah = aux.handoff;

			dispatch.mg.push({
				beat: beat.id,
				composition_id: auxCompositionId,
				duration: r3(auxTrackEd - auxTrackSt),
				duration_hint: ah && typeof ah.duration_hint === "number" ? ah.duration_hint : null,
				category: "overlay",
				visual_job: ah?.visual_job,
				...(ah?.visual_brief !== undefined ? { visual_brief: ah.visual_brief } : {}),
				theme: ah?.theme,
				bg: ah?.bg,
				slug_hint: ah?.slug_hint,
				track_st: auxTrackSt,
				track_ed: auxTrackEd,
				// **aux 自己的** span（mount 为子区间时 ≠ 主 beat span）——这条直接消掉
				// 「按 `beat` 字段回查会把 aux 错算成主 beat 窗口」的 join 陷阱
				span: auxSpan,
			});

			const auxMetaBeat: SplitMetaBeat = {
				id: auxTag,
				lane: "MG",
				span: auxSpan,
				track_st: auxTrackSt,
				track_ed: auxTrackEd,
				category: "overlay",
			};
			// 源包络（同主 beat：传 sourceIndex 才写）——满足客户端 beats.every(source_ranges) 跟随门槛
			if (opts.sourceIndex) {
				const sfrom = opts.sourceIndex.utterances.get(auxFromId);
				const sto = opts.sourceIndex.utterances.get(auxToId);
				if (sfrom && sto && sto.ed > sfrom.st) {
					auxMetaBeat.source_ranges = [{ st: r3(sfrom.st), ed: r3(sto.ed) }];
				}
			}
			split.beats.push(auxMetaBeat);
		}
	}

	return { split, dispatch, skipped, shrunk, unhandledLanes: [...unhandledLanes] };
}

// ── 人读稿渲染（单向，不回读）─────────────────────────────────────────────

/** 由拆分稿 + 落地结果渲染人读 Markdown（沿旧版式：总览 / Beat Timeline / 四队列）。 */
export function renderSplitMarkdown(
	doc: SplitDoc,
	landing: Landing,
	meta: { projectSlug: string; projectedAt: string },
): string {
	const L: string[] = [];
	const metaById = new Map(landing.split.beats.map((b) => [b.id, b]));
	const skippedIds = new Set(landing.skipped.map((s) => s.beat));

	L.push(`# 视觉拆分稿（${meta.projectSlug}）`);
	L.push("");
	L.push(`- contract_version：\`${doc.contract_version}\``);
	L.push(`- transcript_hash：\`${doc.transcript_hash}\``);
	L.push(`- projected_at：\`${meta.projectedAt}\``);
	L.push(`- beats：${doc.beats.length}（落轨 ${landing.split.beats.length} · 跳过 ${landing.skipped.length} · 收缩 ${landing.shrunk.length}）`);
	L.push("");
	L.push("# Beat Timeline");
	L.push("");
	for (const beat of doc.beats) {
		const mb = metaById.get(beat.id);
		L.push(`## ${beat.id}${skippedIds.has(beat.id) ? "（整段被剪 · 跳过）" : mb?.shrunk ? "（部分被剪 · 已收缩）" : ""}`);
		L.push(`- 文稿范围：\`${beat.span.from} … ${beat.span.to}\``);
		L.push(`- 底轨：\`${beat.base_track}\``);
		L.push(`- 主层：\`${beat.lane}\``);
		L.push(`- 叙事功能：\`${beat.narrative}\``);
		L.push(`- 容器阶段：\`${beat.container_stage}\``);
		if (beat.rhythm) L.push(`- 节奏标签：\`${beat.rhythm}\``);
		L.push(`- 视觉任务：${beat.visual_task}`);
		L.push(`- 不可替代性：\`${beat.irreplaceability}\``);
		if (mb) L.push(`- 轨道时码：\`${mb.track_st}s … ${mb.track_ed}s\``);
		if (beat.callback_of) L.push(`- 回扣对象：\`${beat.callback_of}\``);
		for (const a of beat.aux_layers ?? []) {
			const mount = a.mount === "same_beat" ? "同 beat" : "trigger" in a.mount ? `触发 ${a.mount.trigger}` : `${a.mount.from} … ${a.mount.to}`;
			L.push(`  - 辅助层 \`${a.type}\`（${mount}）：${a.role}`);
		}
		L.push("");
	}

	L.push("# Production Queues");
	L.push("");
	L.push("## A_ROLL Queue");
	for (const b of doc.beats.filter((x) => x.lane === "A_ROLL" && !skippedIds.has(x.id))) {
		L.push(`- \`${b.id}\` ${b.visual_task}`);
	}
	L.push("");
	L.push("## MG Queue");
	for (const r of landing.dispatch.mg) {
		// 铁律⑦：展示**坑位包络**（落轨事实）；hint 有值才另注，null 不打印。
		const slot = r.duration != null ? ` · 坑位 ${r.duration}s` : "";
		const hint = r.duration_hint != null ? ` · hint ${r.duration_hint}s` : "";
		L.push(`- \`${r.beat}\` composition_id=\`${r.composition_id}\`${slot}${hint}`);
	}
	L.push("");
	L.push("## AI_DRAMA Queue");
	for (const a of landing.dispatch.ai_drama) L.push(`- \`${a.beat}\` ${a.track_st}s…${a.track_ed}s`);
	L.push("");
	L.push("## FILM_BROLL Queue");
	for (const f of landing.dispatch.film_broll) {
		// 锚点摘要（add-keyword-anchored-broll）：人读稿一眼看到哪些关键词被钉
		const anchorNote = f.anchors?.length ? ` · 锚=[${f.anchors.map((a) => a.keyword).join(" / ")}]` : "";
		L.push(`- \`${f.beat}\` queries=[${f.queries.join(" / ")}]${anchorNote}`);
	}
	L.push("");
	return L.join("\n");
}
