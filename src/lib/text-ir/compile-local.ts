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
import { assertValidIr } from "./validate";
import type { CompileResult } from "../text-ir-client";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** IR → 与服务端同形的编译结果。抛错即编译失败，调用方 MUST NOT 落盘。 */
export function compileIrLocal(ir: Record<string, unknown>): CompileResult {
	// ★ 先校验再编译（fix-local-ir-compile-skips-validation）。
	//
	// 此前这条路**零校验**：`transparent:false`、`canvas:1280x720@60fps` 这类服务端会当场拒
	// 的 IR，本地一律 exit 0 落盘。于是「本地能编出来」不再蕴含「这份 IR 合法」——
	// 2026-09-15 实测：t07 工程里三颗颗粒带着 `transparent:false` 的内嵌 IR 落进了 `.gtrk`，
	// **就是从这个口子溜进来的**。
	//
	// ⚠️ 校验器是 Python 正本的**第二实现**，靠 `scripts/text-ir-parity.mjs` 的**第二段**
	// （拒绝面同判）钉住。原则不是「不许有两份实现」，是「不许有两份实现而没有会响的闸」。
	//
	// ⚠️ 位置 MUST 在 `compileIrBody` **之前**：编译器对某些非法输入会抛它自己的异常
	// （如未定义颜色引用），那句话没有路径、用户拿不到定位。先校验才有指名到键的消息。
	assertValidIr(ir);
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
