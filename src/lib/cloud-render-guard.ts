/**
 * 云渲/云端任务提交防线（add-matrix-local-search · matrix-lay-tracks spec「含本地素材工程的云渲提交防线」）。
 *
 * 判据：工程 materials 里的 **B-roll 素材**（`broll-` 前缀家族）若
 *   ① id 带 `broll-local-` 前缀（本地素材身份，素材本体永不上云），或
 *   ② path 为**工程目录之外的绝对路径**（云端渲染取不到、归一化上传即违背承诺），
 * 则 SHALL 在提交口直接拒绝 + 机读 code，MUST NOT 静默上传素材归一化为 file_id。
 *
 * 非 B-roll 素材不设防（口播主轨 material 的 path 本就是原片本地绝对路径，属既有契约形态）。
 * 挂载点：uploadAndSubmitTask（云端任务提交唯一漏斗）对 .gtrk 工程文件生效；
 * 未来新增云渲类命令 SHALL 复用 assertCloudSubmittableGtrk。
 */
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { BROLL_LOCAL_MATERIAL_PREFIX, BROLL_MATERIAL_PREFIX } from "./matrix-lay";

/** 机读拒绝码（--json / error.code 同值）。 */
export const CLOUD_LOCAL_BROLL_CODE = "local_broll_cloud_render_rejected";

export interface LocalBrollViolation {
	materialId: string;
	path: string | null;
	reason: "broll_local_prefix" | "external_absolute_path";
}

export class CloudSubmitGuardError extends Error {
	readonly code = CLOUD_LOCAL_BROLL_CODE;
	constructor(readonly violations: LocalBrollViolation[]) {
		const sample = violations
			.slice(0, 3)
			.map((v) => `${v.materialId}${v.path ? `（${v.path}）` : ""}`)
			.join("、");
		super(
			`工程含本地 B-roll 素材（${violations.length} 条，如 ${sample}），已拒绝云端提交` +
				`（code=${CLOUD_LOCAL_BROLL_CODE}）——` +
				"本地素材本体不上云是硬承诺，不会静默上传归一化为 file_id。" +
				"本地 B-roll 工程请走客户端本地出片（或 gtrk render 本地渲染）。",
		);
		this.name = "CloudSubmitGuardError";
	}
}

/** 纯函数检测：返回违规 B-roll 素材清单（空 = 可提交）。gtrkDir 缺省时按「任何绝对 path 都算工程外」从严。 */
export function findLocalBrollViolations(gtrk: Record<string, unknown>, gtrkDir?: string): LocalBrollViolation[] {
	const out: LocalBrollViolation[] = [];
	const materials = Array.isArray(gtrk.materials) ? (gtrk.materials as Record<string, unknown>[]) : [];
	for (const m of materials) {
		const id = typeof m.id === "string" ? m.id : "";
		if (!id.startsWith(BROLL_MATERIAL_PREFIX)) continue; // 只防 B-roll 家族（主轨原片绝对路径属既有形态）
		const path = typeof m.path === "string" ? m.path : null;
		if (id.startsWith(BROLL_LOCAL_MATERIAL_PREFIX)) {
			out.push({ materialId: id, path, reason: "broll_local_prefix" });
			continue;
		}
		if (path && isAbsolute(path)) {
			if (!gtrkDir) {
				out.push({ materialId: id, path, reason: "external_absolute_path" });
				continue;
			}
			const rel = relative(resolve(gtrkDir), resolve(path));
			if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
				out.push({ materialId: id, path, reason: "external_absolute_path" });
			}
		}
	}
	return out;
}

/** 断言可提交，违规抛 CloudSubmitGuardError（code = local_broll_cloud_render_rejected）。 */
export function assertCloudSubmittableGtrk(gtrk: Record<string, unknown>, gtrkDir?: string): void {
	const violations = findLocalBrollViolations(gtrk, gtrkDir);
	if (violations.length) throw new CloudSubmitGuardError(violations);
}

/**
 * 按文件路径守卫（提交口挂载形态）：读 + 解析 .gtrk 后断言。
 * 读不出/解析不了 → 放行（fail-open）：残缺文件不构成「含本地 B-roll 的工程」，
 * 其失败面归上传/服务端校验原位置，防线只拦「明确命中判据」的工程。
 */
export async function guardGtrkCloudSubmit(path: string): Promise<void> {
	let gtrk: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
		gtrk = parsed as Record<string, unknown>;
	} catch {
		return;
	}
	assertCloudSubmittableGtrk(gtrk, dirname(resolve(path)));
}
