/**
 * 用户级持久配置：~/.gtrk-cli/config.json。
 * 由 `gtrk init` 一次性写入（API Key / 根地址 / 剪映草稿目录），之后所有命令免重复配置。
 * 与上传缓存同住 ~/.gtrk-cli/。读为 sync（配置极小），写在 init 流程里调。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** 云端 API 默认根地址（生产）。init 预填、loadConfig 兜底，用户一般只需填 Key。 */
export const DEFAULT_API_BASE = "https://api.ai-mcn.tv:10000";

const DIR = join(homedir(), ".gtrk-cli");
const FILE = join(DIR, "config.json");

export interface UserConfig {
	apiBase?: string;
	apiKey?: string;
	jianyingDraftDir?: string;
}

export function configPath(): string {
	return FILE;
}

export function readUserConfig(): UserConfig {
	if (!existsSync(FILE)) return {};
	try {
		return JSON.parse(readFileSync(FILE, "utf8")) as UserConfig;
	} catch {
		return {}; // 损坏当空，init 可重写
	}
}

/** 合并写入（保留未传字段）。 */
export function writeUserConfig(patch: UserConfig): void {
	mkdirSync(DIR, { recursive: true });
	const merged = { ...readUserConfig(), ...patch };
	writeFileSync(FILE, JSON.stringify(merged, null, 2));
}
