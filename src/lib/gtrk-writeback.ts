/**
 * `.gtrk` 读取 + `struct_meta.split` 原子写回（split 命令落地专用）。
 *
 * 契约（split-command spec）：写回 MUST 只改 `struct_meta.split` 一个键、经临时文件 + rename 原子替换；
 * 写前 MUST 比对文件 mtime 与读取时一致（不一致=保存冲突，拒写）。落地前置 `version==="v1"` 门。
 * 同步 IO：读→算→写是一条不可让出的临界路径，同步实现最省心（CLI 单发命令，无并发压力）。
 */
import { readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";

export interface GtrkRead {
	gtrk: Record<string, unknown>;
	/** 读取时刻的 mtimeMs，写回前用于冲突检测。 */
	mtimeMs: number;
}

/** 读 `.gtrk` + 记录 mtime。JSON 解析失败/文件缺失按原样抛。 */
export function readGtrk(path: string): GtrkRead {
	const raw = readFileSync(path, "utf8");
	let gtrk: unknown;
	try {
		gtrk = JSON.parse(raw);
	} catch (e) {
		throw new Error(`工程文件不是合法 JSON：${path}（${e instanceof Error ? e.message : String(e)}）`);
	}
	if (typeof gtrk !== "object" || gtrk === null || Array.isArray(gtrk)) {
		throw new Error(`工程文件结构异常（顶层非对象）：${path}`);
	}
	return { gtrk: gtrk as Record<string, unknown>, mtimeMs: statSync(path).mtimeMs };
}

/** v1 版本门：非 v1 硬拒（提示用新链路重产）。 */
export function assertGtrkV1(gtrk: Record<string, unknown>): void {
	if (gtrk.version !== "v1") {
		throw new Error(`工程文件不是 v1（version=${JSON.stringify(gtrk.version)}）：请用新链路重产 v1 工程后再拆分`);
	}
}

/**
 * 原子写回 `struct_meta.split`：只替换该键、其余键原样保留；写前比对 mtime。
 * @param gtrk 读取时的原始对象（`readGtrk` 产出，避免二次解析漂移）。
 * @param expectedMtimeMs 读取时刻的 mtimeMs；与当前不符即拒写。
 */
export function writeStructMetaSplit(
	path: string,
	gtrk: Record<string, unknown>,
	splitObj: unknown,
	expectedMtimeMs: number,
): void {
	const cur = statSync(path).mtimeMs;
	if (cur !== expectedMtimeMs) {
		throw new Error(
			"工程文件在 split 运行期间被外部修改（保存冲突），已拒绝写入；请重新导出视图后重试（客户端侧需先保存、发起后等重载）",
		);
	}
	const nextStructMeta = { ...((gtrk.struct_meta as Record<string, unknown> | undefined) ?? {}), split: splitObj };
	const next = { ...gtrk, struct_meta: nextStructMeta };
	const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		writeFileSync(tmp, JSON.stringify(next, null, 2));
		renameSync(tmp, path);
	} catch (e) {
		try {
			unlinkSync(tmp);
		} catch {
			/* 临时文件清理失败无害 */
		}
		throw e;
	}
}
