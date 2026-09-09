/**
 * 看点准则（highlight rubric）的归一化、分桶哈希与三级来源决议
 * （fix-highlight-rubric-wiring · matrix-lay-tracks「看点分的评判基准三级取用」）。
 *
 * 为什么单立一个零件：准则同时被三处消费——`matrix describe`（决定上行什么、落哪个桶）、
 * `matrix lay`（决定读哪个桶）、栏目配置（L2 来源）。三处各算各的哈希，迟早算出两个值，
 * 那就是「同一份准则被拆成两个桶、白扣一次看片钱」。**唯一决议点在这里。**
 *
 * 三级来源与优先级（spec）：
 *   L1 `--highlight-rubric <text|@file>`  >  L2 栏目配置 `broll.highlight_rubric`  >  L0 缺省
 * L0 = **不上行任何准则字段**，服务端走它自己的领域无关缺省 —— 这一路的请求体与本件之前
 * 逐字节一致，零回归靠「整键缺席」保证，不靠传一个空串糊弄。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** 缺省桶哨兵：不传准则时的 `rubric_hash`。
 * **刻意不是 NULL、不是空串**——本件之前写下的看点分 `rubric_hash` 恒为 NULL，
 * 读侧把 NULL 一律当作本桶命中，于是「今天已有的分」在缺省路径上照常可用（零回归的结构保证）。 */
export const RUBRIC_DEFAULT_BUCKET = "L0";

/** 服务端上限（`describe_gateway_services.py:301` 逐字对齐）：超限服务端 400 且不建任务。
 * CLI 侧同限先拒，是为了让报错发生在本地、话里带得上是哪份文件超了。 */
export const RUBRIC_MAX_CHARS = 2000;

/** 哈希取前 16 位（`claimHash` 取 32 位，两者互不相干；桶数量级远小于稿句，16 位足量）。 */
const RUBRIC_HASH_LEN = 16;

/**
 * 准则文本归一化 —— **上行的与被哈希的是同一份**，绝不「传原文、哈希归一化后的」。
 * 那样两份只差换行的准则会共用一个桶，却让服务端收到两种 prompt，
 * 于是同一个桶里躺着两套口径打出来的分，事后无从分辨。
 *
 * 三步：换行统一为 `\n`（**Windows 主力机，CRLF/LF 由落盘方式决定、用户完全无感**，
 * 不归一就是「我什么都没改怎么又扣了一次钱」）→ 去首尾空白 → NFC（同 `claimHash` 口径）。
 */
export function normalizeRubric(text: string): string {
	return text.replace(/\r\n?/g, "\n").trim().normalize("NFC");
}

/**
 * 准则 → 分桶哈希。空/纯空白/缺席一律落缺省桶（`L0`）。
 * ⚠️ 入参应当是**已归一化**的文本；本函数内部再归一一次以防调用方漏做（幂等）。
 */
export function rubricHashOf(text?: string | null): string {
	if (typeof text !== "string") return RUBRIC_DEFAULT_BUCKET;
	const norm = normalizeRubric(text);
	if (!norm) return RUBRIC_DEFAULT_BUCKET;
	return createHash("sha256").update(norm).digest("hex").slice(0, RUBRIC_HASH_LEN);
}

/** 决议结果。`text` 缺席 = 走 L0（**MUST NOT 上行准则字段**）。 */
export interface ResolvedRubric {
	/** 上行用的准则正文（已归一化）；缺席即不上行。 */
	text?: string;
	/** 分桶哈希；L0 时为 `RUBRIC_DEFAULT_BUCKET`。 */
	hash: string;
	/** 来源留痕（钉进 plan、打进日志）：`flag:@<path>` / `flag:inline` / `column:<id>` / `default`。 */
	source: string;
}

/** 准则解析/取值失败：话里 MUST 带上是哪一份（文件路径或栏目 id），否则用户无从下手。 */
export class RubricError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "RubricError";
	}
}

/** 超限文案（flag 与栏目配置两路共用，措辞一致）。 */
function tooLong(whence: string, chars: number): RubricError {
	return new RubricError(
		`看点准则超长（${whence}：${chars} 字符 > 上限 ${RUBRIC_MAX_CHARS}）——服务端会直接 400 拒绝且不建任务。` +
			`准则只判「镜头里看得见的东西」，写不下通常是把知识侧要素（典故/来历/背景）也塞进来了，那些归写稿不归准则`,
	);
}

/**
 * `--highlight-rubric <text|@file>` 入参解析。
 * `@` 前缀 = 从文件读（多行准则的主用法，免命令行转义）；其余按内联文本。
 *
 * **给了却是空的 = 硬失败**（不静默回落 L0）：显式传了这个 flag 就是在表态「我要按这份准则打分」，
 * 空文件多半是路径写对了但内容没写进去；静默回落会让用户拿着 L0 的分以为是自己的准则打的。
 */
export function parseRubricOption(raw: string, deps: { readFile?: (p: string) => string } = {}): { text: string; source: string } {
	const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
	const trimmed = raw.trim();
	if (trimmed.startsWith("@")) {
		const path = trimmed.slice(1).trim();
		if (!path) throw new RubricError("--highlight-rubric 的 @ 形态缺文件路径（用法：--highlight-rubric @<准则文件>）");
		let body: string;
		try {
			body = readFile(path);
		} catch (e) {
			throw new RubricError(`读不到看点准则文件：${path}（${e instanceof Error ? e.message : String(e)}）`);
		}
		const text = normalizeRubric(body);
		if (!text) throw new RubricError(`看点准则文件是空的：${path}——显式传了 --highlight-rubric 就 MUST NOT 静默回落缺省准则`);
		if (text.length > RUBRIC_MAX_CHARS) throw tooLong(path, text.length);
		return { text, source: `flag:@${path}` };
	}
	const text = normalizeRubric(trimmed);
	if (!text) throw new RubricError("--highlight-rubric 收到空串——显式传了就 MUST NOT 静默回落缺省准则（不想传就别传这个参数）");
	if (text.length > RUBRIC_MAX_CHARS) throw tooLong("内联文本", text.length);
	return { text, source: "flag:inline" };
}

/**
 * 三级决议：flag > 栏目配置 > 缺省。
 *
 * 栏目配置里的空/纯空白值按**未配置**处理（配置文件里留个空字段是「没配」的自然读法，
 * 与「显式传了空 flag」不是一回事——后者是表态，前者不是）；超长仍硬失败，
 * 因为那份配置每次跑都会被服务端 400 拒，静默截断等于替用户偷改评分口径。
 */
export function resolveHighlightRubric(input: {
	/** 已由 `parseRubricOption` 解析过的 flag 结果（未传则缺席）。 */
	flag?: { text: string; source: string };
	/** 栏目配置 `broll.highlight_rubric` 原值（未配/非字符串则缺席）。 */
	columnRubric?: unknown;
	/** 栏目 id，仅用于来源留痕与报错话术。 */
	columnId?: string;
}): ResolvedRubric {
	if (input.flag) return { text: input.flag.text, hash: rubricHashOf(input.flag.text), source: input.flag.source };
	if (typeof input.columnRubric === "string") {
		const text = normalizeRubric(input.columnRubric);
		if (text) {
			const whence = `栏目配置 ${input.columnId ?? "<未指名>"} 的 broll.highlight_rubric`;
			if (text.length > RUBRIC_MAX_CHARS) throw tooLong(whence, text.length);
			return { text, hash: rubricHashOf(text), source: `column:${input.columnId ?? "?"}` };
		}
	}
	return { hash: RUBRIC_DEFAULT_BUCKET, source: "default" };
}

/**
 * 上行告知文案。**只说「已上行」，不说「已生效」**——服务端对扩参是宽松超集，
 * 未升级时整段忽略且产物形状完全一致，CLI 拿不到任何回执。
 * 把不可回执的事说成确定的事，正是本件在修的那类静默。
 */
export function rubricUplinkNote(r: ResolvedRubric): string | undefined {
	if (!r.text) return undefined;
	return (
		`看点准则已随本批上行（hash=${r.hash.slice(0, 8)} · 来源 ${r.source} · ${r.text.length} 字符）` +
		`——服务端不回执，故本行只陈述「已上行」，不代表服务端确已按它打分`
	);
}
