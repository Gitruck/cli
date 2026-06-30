import { DEFAULT_API_BASE, readUserConfig } from "./user-config";

/** 云端连接配置。优先级：环境变量 / .env（bun 自动加载）> `gtrk init` 写的持久配置 > 默认根地址。 */
export interface CloudConfig {
	/** API 根地址，如 https://api.ai-mcn.tv:10000（无末尾斜杠）。 */
	base: string;
	/** 鉴权 Header Authorization 的裸值（非 Bearer）。 */
	apiKey: string;
}

export function loadConfig(): CloudConfig {
	const uc = readUserConfig();
	const apiKey = (process.env.GITRUCK_API_KEY ?? uc.apiKey ?? "").trim();
	const base = (process.env.GITRUCK_API_BASE ?? uc.apiBase ?? DEFAULT_API_BASE)
		.trim()
		.replace(/\/+$/, "");
	if (!apiKey) {
		throw new Error("缺 API Key —— 先跑 `gtrk init` 配置（或设环境变量 GITRUCK_API_KEY）");
	}
	return { base, apiKey };
}
