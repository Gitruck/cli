/**
 * 颗粒三态身份：内嵌 IR + 首行哈希自证（change add-text-template-source）。
 *
 * 服务端正本在 infra `utils/process/media/vision/text_ir/identity.py`（capability `text-ir-profile`）。
 * 三态的产品含义：
 *
 * - `ir`       —— 内嵌 IR 在，且首行声明的 html 哈希与实测一致 ⇒ 这颗是 compile(IR) 的原样产物，云端还能调
 * - `detached` —— 内嵌 IR 在但哈希对不上 ⇒ HTML 被直接改过，云端调不动；可按内嵌 IR「重置回模板」
 * - `html`     —— 没有内嵌 IR（栏目 skill 直产的普通颗粒）
 *
 * **判定只看文件内容**：颗粒会被改名、被内容寻址重命名、被拷进工程目录，任何依赖
 * 文件名或目录的判据都会当场失效。
 *
 * ★ **本实现只核 `gtrk-html-sha256`，不重算 `gtrk-ir-sha256`**，与服务端结论等价：
 *   内嵌 IR 本身就在 HTML 字节里，改它必然改 html 哈希，所以 html 哈希已经覆盖了
 *   "IR 有没有被单独动过"。反过来，重算 ir 哈希要在 JS 里复刻 Python 的 canonical JSON
 *   （键排序 + 非 ASCII 不转义 + 浮点 repr），跨语言的浮点格式化差异是**假 detached**
 *   的经典来源——把好颗粒判成"云端调不动"，用户只会看到功能坏了。
 */
import { createHash } from "node:crypto";

export type ParticleState = "ir" | "detached" | "html";

/** 首行声明。两个哈希都在，但本地只核 html 那个（见模块头注）。 */
const STAMP_RE = /^<!-- gtrk-ir-sha256=([0-9a-f]{64}) gtrk-html-sha256=([0-9a-f]{64}) -->\n/;
/**
 * 内嵌 IR 的载体。**两代都认**：
 *
 * - 新：`<template data-gtrk-ir>` —— 2026-09-14 起。旧载体是 `<script>`，而根元素内
 *   只要存在 `type="application/json"` 的 script，渲染引擎产出的就是**静帧**
 *   （同一份 IR，有它 180 帧只有 1 个不同画面，去掉后 36 个）。
 * - 旧：`<script type="application/json" data-gtrk-ir>` —— **只读不写**。
 *   已落进用户工程的旧颗粒若读不出 IR，会从 `ir` 掉成 `html` 态、云端改写入口
 *   凭空消失——那比静帧更难排查。
 */
const IR_CARRIERS = [
	/<template data-gtrk-ir>([\s\S]*?)<\/template>/,
	/<script type="application\/json" data-gtrk-ir>([\s\S]*?)<\/script>/,
] as const;

export interface ParticleIdentity {
	state: ParticleState;
	/** 内嵌 IR（`ir` 与 `detached` 两态都给——「重置回模板」拿的正是它）。 */
	ir?: Record<string, unknown>;
	/** 首行声明的 IR 哈希（原样带出，不重算）。 */
	declaredIrSha256?: string;
	/** 首行声明的 HTML 哈希。 */
	declaredHtmlSha256?: string;
	/** 实测 HTML 哈希（去掉首行声明后的字节）。 */
	actualHtmlSha256?: string;
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 去掉首行声明注释；没有声明就原样返回。 */
export function stripStamp(html: string): string {
	const m = STAMP_RE.exec(html);
	return m ? html.slice(m[0].length) : html;
}

/** 取出内嵌 IR；没有或解析失败返回 undefined（解析失败按「没有」处理，不抛）。 */
export function extractEmbeddedIr(html: string): Record<string, unknown> | undefined {
	for (const re of IR_CARRIERS) {
		const m = re.exec(html);
		if (!m) continue;
		try {
			const parsed: unknown = JSON.parse(m[1]);
			if (!parsed || typeof parsed !== "object") return undefined;
			return parsed as Record<string, unknown>;
		} catch {
			// 载体在但内容坏了：**不再试另一种载体**。那会把「坏了」读成「没有」，
			// 于是 detached 被误判成 html 态，用户失去「重置回模板」这条出路。
			return undefined;
		}
	}
	return undefined;
}

export function identifyParticle(html: string): ParticleIdentity {
	const ir = extractEmbeddedIr(html);
	if (!ir) return { state: "html" };

	const m = STAMP_RE.exec(html);
	if (!m) {
		// 有 IR 却没有声明：无从自证 HTML 未被改。宁可误判成 detached（用户点一下
		// 「重置回模板」即可），也不能把改过的颗粒当模板送去云端调。
		return { state: "detached", ir };
	}
	const body = html.slice(m[0].length);
	const actual = sha256Hex(body);
	return {
		state: actual === m[2] ? "ir" : "detached",
		ir,
		declaredIrSha256: m[1],
		declaredHtmlSha256: m[2],
		actualHtmlSha256: actual,
	};
}

/** 人读一句话。lint 与 fetch 的输出共用，口径只写一处。 */
export function describeState(state: ParticleState): string {
	if (state === "ir") return "模板 · 可云调（ir 态）";
	if (state === "detached") return "已脱离模板 · 云端不可调（detached；可重置回模板）";
	return "普通颗粒（无内嵌 IR）";
}
