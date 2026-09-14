/**
 * 本地编译的 CLI 侧适配层（change `move-text-ir-compiler-to-client`）。
 *
 * `compile.ts` 是与 Python 正本逐字节等价的**纯函数**——不做 IO、不做哈希，
 * 因为两个消费方的哈希能力不同（CLI 走 `node:crypto` 同步、客户端走 WebCrypto 异步）。
 * 本文件只负责把 `node:crypto` 那一半注进去，并把结果整成与服务端 `run_compile`
 * **同形状**的返回值，让 `gtrk mg compile` 的两条路（本地 / `--remote`）出入口一致。
 *
 * ⚠️ `duration` 与 `composition_id` 的取法 MUST 与服务端一致（`canvas.duration` / `id`）。
 * 两侧口径在这里分家，对拍就会拿一个假的「不一致」把人往编译器里带。
 */
import { createHash } from "node:crypto";

import { canonicalJson, compileIrBody } from "./compile";
import type { CompileResult } from "../text-ir-client";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** IR → 与服务端同形的编译结果。抛错即编译失败，调用方 MUST NOT 落盘。 */
export function compileIrLocal(ir: Record<string, unknown>): CompileResult {
	const body = compileIrBody(ir);
	// 两个哈希口径不同：ir 的按 canonical JSON 算；html 的按**去掉首行声明后**的字节算
	// （同正本 `identity.html_sha256`）。错一个就会让自家产物被自家判成 detached。
	const irSha = sha256(canonicalJson(ir));
	const htmlSha = sha256(body);
	const canvas = ir.canvas as { duration?: unknown } | undefined;
	return {
		html: `<!-- gtrk-ir-sha256=${irSha} gtrk-html-sha256=${htmlSha} -->\n${body}`,
		ir_sha256: irSha,
		html_sha256: htmlSha,
		composition_id: String(ir.id ?? ""),
		duration: Number(canvas?.duration ?? 0),
	};
}
