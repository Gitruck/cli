/**
 * gtrk install —— 一条命令装全（对标飞书 `npx @larksuite/cli install`）：
 *   ① 装 agent skill（通用适配器自动检测各类 Agent）
 *   ② 配置 API Key + 剪映目录（交互；或 --api-key/-y 非交互）+ 自动体检
 * 即 `gtrk skills install` + `gtrk init` 合一。`npx @gitruck/cli install` 一步到位。
 */
import { Command } from "commander";
import { installSkill } from "./skills";
import { runInit } from "./init";
import { log } from "../lib/log";

interface InstallOpts {
	apiKey?: string;
	apiBase?: string;
	jianyingDraftDir?: string;
	skillsDir?: string;
	skillAgents?: string;
	allAgents?: boolean;
	copySkills?: boolean;
	yes?: boolean;
	reconfigure?: boolean;
}

export function registerInstall(program: Command): void {
	program
		.command("install")
		.description("一条命令装全：安装 /gtrk-oralcut skill + 配置（对标飞书 lark-cli install）")
		.option("--api-key <key>", "非交互：直接指定 API Key")
		.option("--api-base <url>", "非交互：指定 API 根地址")
		.option("--jianying-draft-dir <dir>", "非交互：剪映草稿目录（传 auto 则自动探测）")
		.option("--skills-dir <dir>", "自定义单个 skills 目录（优先于 Agent 自动检测）")
		.option("--skill-agents <list>", "skills CLI Agent ID，逗号分隔，如 codex,cursor,trae-cn")
		.option("--all-agents", "把 skill 安装到上游和 gtrk 已登记的全部 Agent")
		.option("--copy-skills", "每个 Agent 各复制一份（默认统一存储 + symlink/junction）")
		.option("--reconfigure", "重走配置向导（默认：已配过则保留现有配置、只刷新 skill）")
		.option("-y, --yes", "非交互：用传入值 + 自动探测，不弹任何提示")
		.action(async (opts: InstallOpts) => {
			log.step("① 安装 / 刷新 agent skill…");
			const skillsOk = installSkill({
				dir: opts.skillsDir,
				agents: opts.skillAgents,
				all: opts.allAgents,
				copy: opts.copySkills,
			});
			if (!skillsOk) process.exitCode = 1;
			log.step("② 配置 + 体检…");
			await runInit(opts);
		});
}
