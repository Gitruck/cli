import { DEFAULT_API_BASE, readUserConfig } from "./user-config";

/** 云端连接配置。优先级：环境变量 / .env（bun 自动加载）> `gtrk init` 写的持久配置 > 默认根地址。 */
export interface CloudConfig {
	/** API 根地址，如 https://api.ai-mcn.tv:10000（无末尾斜杠）。 */
	base: string;
	/** 鉴权 Header Authorization 的裸值（非 Bearer）。 */
	apiKey: string;
}

/**
 * API 根地址的**唯一解析口**（change `link-enum-catalog-cli` §1.1）。
 *
 * 优先级：`GITRUCK_API_BASE` > `config.json.apiBase` > {@link DEFAULT_API_BASE}；恒去末尾斜杠。
 *
 * ⚠️ 为什么单抽出来：这三行此前在 `loadConfig()` 与 `doctor.ts` 里各抄了一份。
 * 抄两份的代价不是重复，是**它们会分头漂**——而「我到底在打哪个 base」正是排障第一问，
 * 两处给出不同答案时没有任何东西会报错。
 * ⚠️ **不要求有 Key**：枚举清单是公开只读接口（主件 P1「公开匿名只读」），
 * 没配 Key 的机器也得能解析出 base；要 Key 的路径走 {@link loadConfig}。
 */
export function resolveApiBase(): string {
	return (process.env.GITRUCK_API_BASE ?? readUserConfig().apiBase ?? DEFAULT_API_BASE)
		.trim()
		.replace(/\/+$/, "");
}

export function loadConfig(): CloudConfig {
	const apiKey = (process.env.GITRUCK_API_KEY ?? readUserConfig().apiKey ?? "").trim();
	const base = resolveApiBase();
	if (!apiKey) {
		throw new Error("缺 API Key —— 先跑 `gtrk init` 配置（或设环境变量 GITRUCK_API_KEY）");
	}
	return { base, apiKey };
}
