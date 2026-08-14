/**
 * 用户级持久配置：~/.gitruck/config.json。
 * 由 `gtrk init` 一次性写入（API Key / 根地址 / 剪映草稿目录），之后所有命令免重复配置。
 * 与上传缓存、ffmpeg、抽出物缓存同住 ~/.gitruck/。读为 sync（配置极小），写在 init 流程里调。
 */
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gitruckHome } from "./paths";

/** 云端 API 默认根地址（生产）。init 预填、loadConfig 兜底，用户一般只需填 Key。 */
export const DEFAULT_API_BASE = "https://api.ai-mcn.tv:10000";

const DIR = gitruckHome();
const FILE = join(DIR, "config.json");

export interface UserConfig {
	apiBase?: string;
	apiKey?: string;
	jianyingDraftDir?: string;
	/** 缺省栏目配置 id（gtrk split --column 未传时取此；再缺省 = 内置默认栏目）。 */
	defaultColumn?: string;
	/** 自建 embed 端点完整 URL 覆盖（add-matrix-local-search；缺省 = apiBase 推导，env GITRUCK_EMBED_URL 优先级更高）。 */
	embedUrl?: string;
	/** 素材理解端点完整 URL 覆盖（add-matrix-describe-and-window；缺省 = apiBase 推导
	 * `/task/cli/material_describe`，env GITRUCK_DESCRIBE_URL 优先级更高）。 */
	describeUrl?: string;
	/** 合规告知留痕（add-compliance-notice）：已告知的条款版本标识。缺失 = 未告知；
	 * 与 CLI 常量 TERMS_VERSION 不一致（条款实质更新后 bump）⇒ 重新告知一次。
	 * **纯本地留痕**，MUST NOT 上报服务端；它 MUST NOT 被当作任何命令的执行前置条件。 */
	termsNoticeVersion?: string;
	/** 合规告知留痕（add-compliance-notice）：告知时间戳（ISO 8601）。 */
	termsNoticeAt?: string;
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
