/**
 * MG 槽位的**视觉职能** `visual_job`（change: gate-mg-visual-job）。
 *
 * ## 治的是什么
 *
 * 上线一个现成品库（文字模板 103 件、检索即得）就同时上线了一个**引力井**：
 * 对 agent 而言「检索一个现成的」永远比「为这次专门设计一个」路径更短、更确定。
 * 产出会**单调滑向库里已有的那些形态**，直到全片长得一模一样。
 *
 * 2026-09-15 实测：两条真片子 27 颗旧 MG 里 **26 颗出自模板库（96%）**。
 * 主理人拿一张旧片截图指出损失——一块半透明面板，小标题「边界的姿态」，
 * 下面两行并置 `温柔 — 坚定` / `和善 — 有立场`：**它是纯文字画的，但它表达的是一个关系**。
 * 模板库里没有这种东西，也不可能有。
 *
 * 制度层正本：`gitruck-infra/docs/同合云顶层设计文档/模板化对自由创意的侵蚀.md`。
 *
 * ## ⚠️ 判据建在「意思的结构」上，不建在「呈现媒介」上
 *
 * 本件初版第一档叫 `text`、判据写成「去掉文字之后什么都不剩」——被上面那张截图当场证伪：
 * 那块面板**是文字做的**，按初版判据会被归进 `text` 档 ⇒ 文字模板放行 ⇒ 它退化成一张字卡。
 * **判据会亲手促成它要防的那件事。**
 *
 * 正确的判据是「**这段的意思里有没有第二个东西与它并置**」，与「用不用字」无关。
 * 枚举第一档因此叫 `statement` 而**不叫 `text`**——
 * 叫 `text` 会让「它是文字做的」直接滑成「它是 text 档」。**名字本身就是防线。**
 */

/** 四档视觉职能。**MUST NOT 把第一档改名叫 `text`**（见文件头注）。 */
export const VISUAL_JOBS = ["statement", "relation", "data", "decor"] as const;
export type VisualJob = (typeof VISUAL_JOBS)[number];

/** 需要「为这个意思专门设计」的两档 —— 生产侧硬闸与排产顺序闸都认这两档。 */
export const ORIGINAL_JOBS: readonly VisualJob[] = ["relation", "data"];

export const isVisualJob = (v: unknown): v is VisualJob => VISUAL_JOBS.includes(v as VisualJob);

/** 模板 id 的形状。派单产物里出现它 = 「这一步看过库」的直接证据。 */
const TEMPLATE_ID_SHAPE = /\btfx-[a-z0-9]+(?:-[a-z0-9]+)*\b/i;

/**
 * 派单自由文本里有没有引用具体模板 id。
 *
 * ⚠️ **只拦「引用具体模板」，MUST NOT 误伤描述**：
 * 「大字标题从左侧滑入」是合格的视觉描述，`tfx-title-typeline` 才是证据。
 *
 * ⚠️ 射程如实声明：这条**无法保证** agent 的上下文里没有模板库（它可能在同一次会话更早
 * 读过 MG 图纸，或由用户贴入）。能做到的只有「图纸与工具面不提供」＋「产物留痕就判红」。
 * 这是**提高代价**，不是**杜绝**。
 */
export function findTemplateIdRef(text: unknown): string | null {
	if (typeof text !== "string") return null;
	const m = TEMPLATE_ID_SHAPE.exec(text);
	return m ? m[0] : null;
}

/**
 * `visual_brief` 是不是只描述了**单一物件**。
 *
 * ⚠️ 判据是「有没有第二个东西」，**不是**「有没有用文字」：
 * 「两列并置 + 破折号」同样是文字描述，但它合格。
 *
 * ⚠️ 本函数**恒用于告警、MUST NOT 用于判红**：自动识别「这句话里有没有关系」不可靠，
 * 做成硬闸会误伤排版型答案——而那正是本件要保住的东西。
 */
const RELATION_HINTS = [
	"并置", "对比", "对照", "两列", "两行", "左右", "上下", "之间", "连起来", "连线",
	"破折号", "箭头", "指向", "咬合", "包含", "递进", "循环", "聚合", "分支", "因果",
	"vs", "→", "—", "↔",
];
export function briefLooksSingular(brief: unknown): boolean {
	if (typeof brief !== "string" || !brief.trim()) return true;
	return !RELATION_HINTS.some((k) => brief.includes(k));
}

/** 四档计数。⚠️ `decor` MUST 单列（见 `formatJobDistribution`）。 */
export type JobDistribution = Record<VisualJob, number>;

export const emptyDistribution = (): JobDistribution => ({ statement: 0, relation: 0, data: 0, decor: 0 });

/**
 * 职能分布的可读一行。
 *
 * ⚠️ 本行 MUST NOT 被用作任何判红依据 —— **观测归观测，裁决归裁决**。
 * 它是给人看的信号：一眼看出「这片子 20 个槽位全是 statement」，比任何阈值都直接。
 *
 * ⚠️ `decor` MUST 单独成项、MUST NOT 并进 `statement`：它是**必要但可被滥用**的一档
 * （「标成 decor 就不用想视觉了」），**异常多本身就是信号**，并进去就看不见了。
 */
export function formatJobDistribution(d: JobDistribution): string {
	return VISUAL_JOBS.map((k) => `${k} ${d[k]}`).join(" / ");
}

/** 全片没有任何关系型视觉（`relation` + `data` 为 0）——此时顶层要具名一句。 */
export const needsVisualJobNote = (d: JobDistribution): boolean => d.relation === 0 && d.data === 0;
