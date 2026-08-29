/**
 * `.gtrk` 读取 + 原子写回（`struct_meta.split` 单键写回 / 整文件写回两个原语）。
 *
 * 契约（`gtrk-writeback-contract` spec，change `adjust-gtrk-writeback-content-revision`）：
 * 写回 MUST 经临时文件 + rename 原子替换；冲突判据 MUST 为**文件内容 revision**（原始字节 sha256），
 * **MUST NOT 用 mtime** —— mtime 会被「内容逐字节相同的重写」污染（本仓 `consume-side-reprojection`
 * spec 早已就「派单是否过期」否决过同一判据：实测 mtime 晚 2h52m 而投影 49/49 相等 ⇒ 100% 误报）。
 *
 * **双重校验**（该 change 的要害，非可选）：入口守卫之外，**rename 之前 MUST 再读盘重检一次**。
 * 缺陷不在判据精度而在「判据只求值一次」——守卫通过到 rename 落地之间实测有毫秒级 TOCTOU 窗口
 * （332KB 真样本 3~4ms），外部写入落于其中会被 rename 无声覆盖；该窗口与判据取 mtime 还是 revision **正交**。
 * ⚠️ 重检 MUST NOT 被任何旁路豁免（本模块不提供 `--force`；将来若引入，只可豁免入口守卫）。
 * ⚠️ 诚实边界：重检把窗口压到亚毫秒级但**不消除竞态**（无「校验与 rename 原子完成」的系统原语）；
 * 真正归零须跨进程写锁，本仓明确不做（本机单命令模型，锁的失效模式代价高于它消除的窗口）。
 *
 * ⚠️ **写回路径 MUST NOT 引入「每次写都变」的字段**（保存时间戳 / 随机 id / 递增计数器）：
 * 那会让语义未变的写入必然产生新 revision，上述收益即刻归零（外部实证：FreeCut 覆写 `updatedAt` 自我抵消）。
 *
 * 同步 IO：读→算→写是一条不可让出的临界路径，同步实现最省心（CLI 单发命令，无并发压力）。
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes, createHash } from "node:crypto";

export interface GtrkRead {
	gtrk: Record<string, unknown>;
	/** 读取时刻的内容 revision（原始字节 sha256），写回前用于冲突检测。 */
	revision: string;
}

/**
 * 内容 revision = **文件原始字节**的 sha256（小写 hex 64 字符）。
 *
 * **单一取值点**：MUST NOT 在别处另写一份。
 * 刻意**不做 JSON 规范化**（parse → 稳定键序 → hash）：规范化规则自身会变成一条须跨端对齐、
 * 要立法要测试的新契约面，而两侧写出格式本就同款（`JSON.stringify(x, null, 2)`；客户端
 * `serializer-gtrk-v1.ts` 同）。已知代价：以不同键序重写同一语义工程会判冲突——该情形在旧
 * mtime 判据下同样会拒，不构成退步。
 */
export function revisionOf(raw: Buffer | string): string {
	return createHash("sha256")
		.update(typeof raw === "string" ? Buffer.from(raw, "utf8") : raw)
		.digest("hex");
}

/** 读 `.gtrk` + 求内容 revision。JSON 解析失败/文件缺失按原样抛。 */
export function readGtrk(path: string): GtrkRead {
	// 读字节而非字符串：revision 恒按原始字节求，且此处已持有全文 ⇒ 求 revision 零额外 IO。
	const raw = readFileSync(path);
	let gtrk: unknown;
	try {
		gtrk = JSON.parse(raw.toString("utf8"));
	} catch (e) {
		throw new Error(`工程文件不是合法 JSON：${path}（${e instanceof Error ? e.message : String(e)}）`);
	}
	if (typeof gtrk !== "object" || gtrk === null || Array.isArray(gtrk)) {
		throw new Error(`工程文件结构异常（顶层非对象）：${path}`);
	}
	return { gtrk: gtrk as Record<string, unknown>, revision: revisionOf(raw) };
}

/** v1 版本门：非 v1 硬拒（提示用新链路重产）。 */
export function assertGtrkV1(gtrk: Record<string, unknown>): void {
	if (gtrk.version !== "v1") {
		throw new Error(`工程文件不是 v1（version=${JSON.stringify(gtrk.version)}）：请用新链路重产 v1 工程后再拆分`);
	}
}

/**
 * 写回冲突（内容 revision 不符）。带回双 revision 供调用方组装结构化回执并 rebase 重试。
 *
 * `phase`：`"guard"` = 入口守卫拦下；`"precommit"` = rename 前重检拦下（TOCTOU 窗口内被插队）。
 * 人读文案两者一致（对用户都是「被外部修改」），机读可分供诊断。
 */
export class GtrkWritebackConflictError extends Error {
	readonly name = "GtrkWritebackConflictError";
	constructor(
		readonly operation: string,
		readonly expectedRevision: string,
		readonly actualRevision: string,
		readonly phase: "guard" | "precommit",
		message: string,
	) {
		super(message);
	}
}

/** 冲突文案：`matrix` 的措辞逐字保持既有（零回归），其余按操作名点名自己。 */
function conflictMessage(operation: string): string {
	return operation === "matrix"
		? "工程文件在 matrix 运行期间被外部修改（保存冲突），已拒绝写入；请关闭客户端未保存的工程或重跑（plan 与已下载代理均保留）"
		: `工程文件在 ${operation} 运行期间被外部修改（保存冲突），已拒绝写入；请关闭客户端未保存的工程后重试`;
}

/**
 * 读盘求当前 revision 并与 expected 比对，不符即抛。**入口守卫与 rename 前重检共用同一实现**
 * （两处判据必须逐字一致，分开写迟早漂移）。导出供调用方在自有临界区内复用与单测直验。
 */
export function assertRevision(path: string, expected: string, operation: string, phase: "guard" | "precommit"): void {
	const actual = revisionOf(readFileSync(path));
	if (actual !== expected) {
		throw new GtrkWritebackConflictError(operation, expected, actual, phase, conflictMessage(operation));
	}
}

/**
 * 临时文件 + rename 原子替换，**rename 前重检 revision**。两个写回原语共用。
 * 任一处校验失败：清理临时文件、目标文件逐字节不变、无残留。
 * @returns 落盘后的新内容 revision（调用方可直接用作下一次写入的 expected，免去重读盘）。
 */
function commitAtomic(path: string, body: string, expectedRevision: string, operation: string): string {
	const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		writeFileSync(tmp, body);
		// ⚠️ rename 前重检：守卫通过到此刻之间的 TOCTOU 窗口内若被插队，此处拦下。MUST NOT 删。
		assertRevision(path, expectedRevision, operation, "precommit");
		renameSync(tmp, path);
	} catch (e) {
		try {
			unlinkSync(tmp);
		} catch {
			/* 临时文件清理失败无害 */
		}
		throw e;
	}
	// 落盘字节即 body（写的就是它），故直接由 body 求，不重读盘。
	return revisionOf(body);
}

/**
 * 原子写回 `struct_meta.split`：只替换该键、其余键原样保留；写前后双重校验内容 revision。
 * @param gtrk 读取时的原始对象（`readGtrk` 产出，避免二次解析漂移）。
 * @param expectedRevision 读取时刻的内容 revision；与当前不符即拒写。
 */
export function writeStructMetaSplit(
	path: string,
	gtrk: Record<string, unknown>,
	splitObj: unknown,
	expectedRevision: string,
): string {
	assertRevision(path, expectedRevision, "split", "guard");
	const nextStructMeta = { ...((gtrk.struct_meta as Record<string, unknown> | undefined) ?? {}), split: splitObj };
	const next = { ...gtrk, struct_meta: nextStructMeta };
	return commitAtomic(path, JSON.stringify(next, null, 2), expectedRevision, "split");
}

/**
 * 原子整文件写回（matrix 铺轨等，add-matrix-lay-tracks）：与 `writeStructMetaSplit` 并存不混用。
 * 调用方自行保证「只动自产物」（broll- 素材 + struct_meta.broll.lay_tracks 登记的轨）；
 * 本函数只负责原子性（临时文件+rename）与内容 revision 双重校验。
 */
export function writeGtrkAtomic(
	path: string,
	next: Record<string, unknown>,
	expectedRevision: string,
	/**
	 * 冲突文案里的操作名。缺省 `"matrix"` —— 既有调用方**逐字节不变**（零回归）。
	 * `patch` 等新调用方显式传自己的名字，免得报出「在 matrix 运行期间被修改」这种指错凶手的话。
	 */
	operation = "matrix",
): string {
	assertRevision(path, expectedRevision, operation, "guard");
	return commitAtomic(path, JSON.stringify(next, null, 2), expectedRevision, operation);
}
