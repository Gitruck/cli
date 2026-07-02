/**
 * gtrk init —— 一次性安装配置（对标飞书 lark-cli install 的引导式体验）：
 *   ① 填 API Key（支持 Ctrl+V 粘贴）
 *   ② 自动扫描剪映草稿目录；扫不到则打开指引图 + 让用户手动粘贴
 * 写入 ~/.gtrk-cli/config.json，之后所有命令免重复配置。
 */
import { Command } from "commander";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
	DEFAULT_API_BASE,
	readUserConfig,
	writeUserConfig,
	configPath,
	type UserConfig,
} from "../lib/user-config";
import { probeJianyingDraftDir } from "../lib/jianying";
import { openFile } from "../lib/open";
import { packageRoot } from "../lib/paths";
import { promptText, promptSecret, promptConfirm } from "../lib/prompt";
import { runDoctor } from "./doctor";
import { log } from "../lib/log";

// 指引图随 CLI 打包：剪映 → 全局设置 → 草稿 →「草稿位置」
const GUIDE_IMAGE = join(packageRoot(), "assets", "jianying-draft-path.png");

interface InitOpts {
	apiKey?: string;
	apiBase?: string;
	jianyingDraftDir?: string;
	yes?: boolean;
	reconfigure?: boolean;
}

export function registerInit(program: Command): void {
	program
		.command("init")
		.description("一次性配置：API Key + 剪映草稿目录（之后所有命令免重复配置）")
		.option("--api-key <key>", "非交互：直接指定 API Key")
		.option("--api-base <url>", "非交互：指定 API 根地址（缺省用默认生产地址）")
		.option("--jianying-draft-dir <dir>", "非交互：剪映草稿目录（传 auto 则自动探测）")
		.option("--reconfigure", "重走配置向导（默认：已配过则跳过、保留现有配置）")
		.option("-y, --yes", "非交互：用传入值 + 自动探测，不弹任何提示")
		.action(runInit);
}

export async function runInit(opts: InitOpts): Promise<void> {
	if (opts.yes || opts.apiKey) return runInitNonInteractive(opts); // 脚本/agent 驱动：免交互
	if (!process.stdin.isTTY) {
		log.err("交互式 init 需要真实终端；脚本/agent 请用：gtrk init --api-key <KEY> -y");
		process.exitCode = 1;
		return;
	}
	const existing = readUserConfig();
	const configured = !!existing.apiKey;

	log.step("▶ gtrk 安装配置");

	// 已配过且没要求重配 → 默认保留、跳过重填（升级/重装时的常见路径，免重复输入 Key 和剪映目录）
	if (configured && !opts.reconfigure) {
		log.info(
			`检测到已有配置：API Key ${mask(existing.apiKey as string)}｜根地址 ${existing.apiBase ?? DEFAULT_API_BASE}｜剪映目录 ${existing.jianyingDraftDir ?? "未配"}`,
		);
		if (await promptConfirm("保留现有配置、跳过重填？（要改配置选 N）", true)) {
			log.info("已保留现有配置（要改配置随时跑 gtrk init --reconfigure）。");
			return afterConfigDoctor();
		}
		log.info("好，重新配置——各项可直接回车沿用现有值。");
	}

	// ① API Key（支持 Ctrl+V 粘贴 / 右键粘贴；有旧值时回车沿用、不必重粘）
	let apiKey = existing.apiKey ?? "";
	const keyMsg = apiKey
		? `粘贴新的 API Key，或直接回车沿用现有（${mask(apiKey)}）：`
		: "粘贴同合云 API Key（Ctrl+V 粘贴）：";
	for (;;) {
		const entered = (await promptSecret(keyMsg)).trim();
		if (entered) {
			apiKey = entered;
			break;
		}
		if (apiKey) break; // 回车沿用旧值
		log.warn("API Key 不能为空，再来一次");
	}

	// ② 根地址（回车用现有 / 默认）
	const apiBase = (
		await promptText("云端 API 根地址（回车用默认）：", {
			defaultValue: existing.apiBase ?? DEFAULT_API_BASE,
		})
	).trim();

	// ③ 剪映草稿目录：有旧值且仍在 → 先问保留；否则自动扫，扫到让确认；再不行开指引图手动粘
	let jianyingDraftDir: string | undefined;
	if (existing.jianyingDraftDir && existsSync(existing.jianyingDraftDir)) {
		if (await promptConfirm(`剪映草稿目录现为 ${existing.jianyingDraftDir}，保留吗？`, true)) {
			jianyingDraftDir = existing.jianyingDraftDir;
		}
	}
	if (!jianyingDraftDir) {
		const probed = probeJianyingDraftDir();
		if (probed && (await promptConfirm(`自动找到剪映草稿目录：${probed}，用它吗？`, true))) {
			jianyingDraftDir = probed;
		}
	}
	if (!jianyingDraftDir) {
		log.info(
			"没自动找到（或你选了手动）。已打开一张指引图：剪映 → 全局设置 → 草稿 →「草稿位置」，把那一行路径复制过来；留空则跳过（剪映只产 draft_content.json、缺 meta、需手动导入）。",
		);
		openFile(GUIDE_IMAGE);
		const manual = (await promptText("剪映草稿根目录（…\\com.lveditor.draft），留空跳过：")).trim();
		if (manual) {
			if (existsSync(manual)) jianyingDraftDir = resolve(manual);
			else log.warn(`目录不存在，已跳过：${manual}`);
		}
	}

	// 写盘：未设剪映目录则不写该键（避免重跑 init 跳过时抹掉旧值）
	const patch: UserConfig = { apiKey, apiBase };
	if (jianyingDraftDir) patch.jianyingDraftDir = jianyingDraftDir;
	writeUserConfig(patch);

	log.ok(`配置已写入 ${configPath()}`);
	if (!jianyingDraftDir) {
		log.warn("未配剪映草稿目录：要剪映直接打开，之后可重跑 gtrk init，或单次加 --jianying-draft-dir");
	}

	return afterConfigDoctor();
}

/** 掩码显示 Key：只留前 6 位，够认出是哪把、又不整串外露。 */
function mask(key: string): string {
	return `${key.slice(0, 6)}…`;
}

/** 配完自动体检 + 给用法提示（「保留现有配置」与「重新配置」两条路径共用）。 */
async function afterConfigDoctor(): Promise<void> {
	// 现配现验（尤其用 /user/get_user_info 验 API Key 真能上云、鉴权通过）
	const healthy = await runDoctor();
	if (healthy) {
		log.step("装好了！两种用法任选：");
		log.info('① 命令行直接剪：gtrk oralcut "<毛片.mp4>" --script "<文字稿.txt>"（无稿就别加 --script）');
		log.info(
			"② 重启你常用的 AI agent（Claude / Codex / Trae / WorkBuddy 等），用 /gtrk-oralcut <你的口播剪辑需求>，一句话交给它，体验更智能的剪辑~",
		);
	} else {
		log.warn("上面体检有项没通，按提示处理好再开剪（多半是 API Key 或剪映目录）。");
	}
}

/** 非交互配置（脚本/agent 驱动）：用传入值 + 自动探测，不弹提示。 */
async function runInitNonInteractive(opts: InitOpts): Promise<void> {
	const existing = readUserConfig();
	const apiKey = (opts.apiKey ?? existing.apiKey ?? "").trim();
	if (!apiKey) {
		log.err("非交互模式需要 --api-key（或改用交互式 gtrk init）");
		process.exitCode = 1;
		return;
	}
	const apiBase = (opts.apiBase ?? existing.apiBase ?? DEFAULT_API_BASE).trim();

	let jianyingDraftDir: string | undefined;
	const dirOpt = opts.jianyingDraftDir;
	if (dirOpt && dirOpt !== "auto") jianyingDraftDir = resolve(dirOpt);
	else if (dirOpt === "auto" || !existing.jianyingDraftDir) jianyingDraftDir = probeJianyingDraftDir();
	else jianyingDraftDir = existing.jianyingDraftDir;

	const patch: UserConfig = { apiKey, apiBase };
	if (jianyingDraftDir) patch.jianyingDraftDir = jianyingDraftDir;
	writeUserConfig(patch);

	log.ok(`配置已写入 ${configPath()}`);
	log.info(`剪映草稿目录：${jianyingDraftDir ?? "未配（剪映需手动导入，可加 --jianying-draft-dir）"}`);
	await runDoctor();
}
