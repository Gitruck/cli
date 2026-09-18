/**
 * 磁盘上 JSON 的统一读取入口（change `fix-local-io-environment-failures`）。
 *
 * 生产报错 `base_error#175`：一份 `utf-8-sig` + CRLF + `indent=4` 的拆分稿喂进 `gtrk split`，
 * 用户拿到的是 `SyntaxError: Unexpected token <U+FEFF>, "<U+FEFF>{…"... is not valid JSON` ——
 * 不说是哪个文件，更不说是字节序标记。而在 Windows 上写出 BOM 是常态：
 * Python `open(..., encoding="utf-8-sig")`、PowerShell 5.1 `Out-File`、记事本「UTF-8 带 BOM」
 * 都这么写。主流 JSON 消费者都剥它，本仓此前 69 个 `JSON.parse` 一个都不剥。
 *
 * ## 两条硬边界
 *
 * ① **只剥字节序标记，MUST NOT 扩 JSON 方言**（design C）。尾随逗号、注释、单引号一律照旧拒。
 *    BOM 是编码层的东西，尾逗号是语法层的；混为一谈就等于自创一套只有 gtrk 认的 JSON，
 *    那份文件换个工具就读不动了。
 * ② **抛的是带人话文案的普通 `Error`，MUST NOT 是 `SyntaxError`、MUST NOT 带 `code`。**
 *    `crash-report.ts` 的判据把「引擎错误类型」与「带 `E***` 系统码」判为崩溃；
 *    原样重抛解析器的 `SyntaxError` 会让用户的文件格式问题变成我们的崩溃上报。
 *    ⚠️ 改本模块时别顺手给错误加 `name` 或 `code`——那两个字段是判据的输入。
 *
 * ## 提示语为什么是条件式的
 *
 * 剥过 BOM 之后还失败，成因就**不是**开头那个 BOM 了。无差别提示「可能带 BOM」是误导。
 * 所以 {@link diagnose} 只在能判定时说具体成因（空文件 / 内嵌 BOM / 非 UTF-8 字节），
 * 判不出来就只给路径与原始解析器消息，不编。
 */
import { readFile as readFileAsync } from "node:fs/promises";
import { readFileSync } from "node:fs";

/** UTF-8 字节序标记解码成文本后的样子。 */
const BOM = "\uFEFF";

/** 剥掉**前导**字节序标记。文本中间的那些不动——它们是内容异常，交给 {@link diagnose} 点名。 */
export function stripBom(text: string): string {
	return text.startsWith(BOM) ? text.slice(1) : text;
}

/**
 * 按已剥 BOM 的文本给一句**判得出来才说**的成因提示。判不出来返回兜底句，绝不猜。
 */
function diagnose(stripped: string): string {
	if (stripped.trim() === "") return "这个文件是空的——产它的那一步可能没写成，或者写到一半被打断了。";
	if (stripped.includes(BOM)) return "文件正文里还夹着字节序标记（U+FEFF），不只开头那一个——多半是两份文本被直接拼在了一起。";
	if (stripped.includes("\u0000")) return "文件里有 NUL 字节，它不像 UTF-8 文本——可能被存成了 UTF-16，重新按 UTF-8 存一次。";
	if (stripped.includes("\uFFFD")) return "文件里有解不开的字节，编码可能不是 UTF-8——重新按 UTF-8 存一次。";
	return "这份文件不是合法 JSON；若它是别的工具生成的，先确认输出的是 UTF-8 纯文本。";
}

/** 组装人话文案。`label` 只进文案不进判据（如「拆分稿」「工程文件」）。 */
function describe(path: string, label: string | undefined, stripped: string, cause: unknown): string {
	const what = label ? `${label}「${path}」` : `「${path}」`;
	const raw = cause instanceof Error ? cause.message : String(cause);
	return `读不动这份 JSON：${what}\n${diagnose(stripped)}\n原始解析器消息：${raw}`;
}

/**
 * 解析一段已经拿到手的 JSON 文本。调用方若已因别的理由读过文件（如先探测是不是 HTML），用这个。
 *
 * 泛型参数只是**断言**不是校验——与原来各站点的 `JSON.parse(...) as T` 等价，
 * 结构校验该在哪儿还在哪儿。
 */
export function parseJsonText<T = unknown>(text: string, path: string, label?: string): T {
	const stripped = stripBom(text);
	try {
		return JSON.parse(stripped) as T;
	} catch (e) {
		throw new Error(describe(path, label, stripped, e));
	}
}

/** 同步读 + 解析。收编 `JSON.parse(readFileSync(p, "utf8"))` 那一族站点。 */
export function readJsonSync<T = unknown>(path: string, label?: string): T {
	return parseJsonText<T>(readFileSync(path, "utf8"), path, label);
}

/** 异步读 + 解析。收编 `JSON.parse(await readFile(p, "utf8"))` 那一族站点。 */
export async function readJson<T = unknown>(path: string, label?: string): Promise<T> {
	return parseJsonText<T>(await readFileAsync(path, "utf8"), path, label);
}
