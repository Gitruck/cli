/**
 * gtrk skills —— 把 agent skill 安装进 Claude Code（对标飞书 lark-cli 装 skills 那步）。
 *   gtrk skills install   把 /gtrk-oralcut 复制到 ~/.claude/skills/，装完即可斜杠触发。
 * 核心 installSkill 也被 `gtrk install` 复用。
 */
import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { packageRoot } from "../lib/paths";
import { log } from "../lib/log";

const SKILL_NAME = "gtrk-oralcut";
// 仓库内打包的 skill 源
const SRC = join(packageRoot(), "skills", SKILL_NAME, "SKILL.md");

/** 把打包的 SKILL.md 复制到 skills 目录（缺省 ~/.claude/skills）。失败不抛、只 warn（不挡命令行使用）。 */
export function installSkill(opts: { dir?: string } = {}): boolean {
	if (!existsSync(SRC)) {
		log.warn(`找不到打包的 skill 源：${SRC}（跳过 skill 安装，不影响命令行）`);
		return false;
	}
	const dest = join(opts.dir ?? join(homedir(), ".claude", "skills"), SKILL_NAME);
	try {
		mkdirSync(dest, { recursive: true });
		copyFileSync(SRC, join(dest, "SKILL.md"));
		log.ok(`已安装 /${SKILL_NAME} → ${join(dest, "SKILL.md")}`);
		log.info("在 Claude Code 里打 /gtrk-oralcut，或直接说「帮我剪个口播」即可触发（可能需重载会话）。");
		return true;
	} catch (e) {
		log.warn(`skill 安装失败（不影响命令行使用）：${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

export function registerSkills(program: Command): void {
	const skills = program.command("skills").description("管理 agent skill（安装到 Claude Code）");

	skills
		.command("install")
		.description(`把 /${SKILL_NAME} 安装到 ~/.claude/skills（对标飞书 skills add）`)
		.option("--dir <dir>", "自定义 skills 目录（缺省 ~/.claude/skills）")
		.action((opts: { dir?: string }) => {
			installSkill({ dir: opts.dir });
		});
}
