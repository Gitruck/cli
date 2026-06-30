/** 剪映/CapCut 草稿目录解析。oralcut 与 init 共用。 */
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readUserConfig } from "./user-config";

/** 探测剪映/CapCut 草稿根目录（Windows 标准位置）。探到返回路径，否则 undefined。 */
export function probeJianyingDraftDir(): string | undefined {
	const local = process.env.LOCALAPPDATA;
	if (!local) return undefined;
	const candidates = [
		join(local, "JianyingPro", "User Data", "Projects", "com.lveditor.draft"),
		join(local, "CapCut", "User Data", "Projects", "com.lveditor.draft"),
	];
	return candidates.find((p) => existsSync(p));
}

/** 解析剪映草稿目录：显式 flag（非 "auto"）> `gtrk init` 持久配置 > 标准位置自动探测。 */
export function resolveJianyingDraftDir(opt: string | undefined): string | undefined {
	if (opt && opt !== "auto") return resolve(opt);
	const saved = readUserConfig().jianyingDraftDir;
	if (saved && existsSync(saved)) return saved;
	return probeJianyingDraftDir();
}
