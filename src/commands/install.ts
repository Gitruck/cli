/**
 * gtrk install —— 一条命令装全（对标飞书 `npx @larksuite/cli install`）：
 *   ① 装 agent skill（通用适配器自动检测各类 Agent）
 *   ② 配置 API Key + 剪映目录（交互；或 --api-key/-y 非交互）+ 自动体检
 * 即 `gtrk skills install` + `gtrk init` 合一。`npx @gitruck/cli install` 一步到位。
 *
 * ⓪（change add-gtrk-command-availability）：装 skill 之前先让 `gtrk` 对**新开终端**可用——
 *   npx 临时态 / 未 link 的本地检出 ⇒ 自持一份全局副本（钉运行中版本，不降级已有更高版本）；
 *   启动器目录不在持久 PATH ⇒ Windows 追加到用户 PATH 尾部，POSIX 只给一行指引。
 *   放在最前且紧接 PATH：用户中途 Ctrl-C 掉 init，gtrk 也已经可敲。
 */
import { Command } from "commander";
import { installSkill } from "./skills";
import { runInit } from "./init";
import { log } from "../lib/log";
import { ensureCommandAvailable, type SelfInstallReport } from "../lib/self-install";

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

/** 把第 ⓪ 步的报告打成人话（每种结果一行，失败带可照抄的出路）。 */
export function reportCommandAvailability(rep: SelfInstallReport): void {
	const { plan, resolvedBefore, install, path } = rep;
	if (plan.action === "skip") {
		if (plan.reason === "private") log.info("私有运行时（客户端自举落位），全局副本由客户端维护");
		else if (plan.reason === "same") log.info(`已是全局副本 v${resolvedBefore?.version ?? "?"}（${resolvedBefore?.shim}）`);
		else log.info(`已有更高版本 v${resolvedBefore?.version}（${resolvedBefore?.shim}），未改动`);
	} else if (install) {
		if (install.ok) log.ok(install.detail);
		else log.warn(install.detail);
	}
	if (!path) {
		log.warn("拿不到 gtrk 启动器目录（npm prefix -g 失败），没法核对 PATH；新终端敲不到 gtrk 的话跑 gtrk doctor");
		return;
	}
	if (path.status === "already") log.info(path.detail);
	else if (path.status === "added") log.ok(path.detail);
	else {
		log.warn(path.detail);
		if (path.hint) log.info(path.hint);
	}
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
			log.step("⓪ 让 gtrk 对新开终端可用…");
			reportCommandAvailability(ensureCommandAvailable());
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
