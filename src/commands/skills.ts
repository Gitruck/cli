/**
 * gtrk skills —— 把 agent skill 安装进 Claude Code（对标飞书 lark-cli 装 skills 那步）。
 *   gtrk skills install   把 gtrk 全家框架 skill（见 SKILL_NAMES）复制到 ~/.claude/skills/，装完即可斜杠触发。
 * 核心 installSkill 也被 `gtrk install` 复用。
 */
import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { packageRoot } from "../lib/paths";
import { log } from "../lib/log";

// 仓库内打包分发的 skill 名（各含 SKILL.md，gtrk-splitter/gtrk-style-maker 另带 references/）
const SKILL_NAMES = [
	"gtrk-oralcut",
	"gtrk-splitter",
	"gtrk-matrix",
	"gtrk-mg",
	"gtrk-ai-drama",
	"gtrk-style-maker",
	"gtrk-tools",
];

/**
 * 把打包的 skill 目录整体复制到 skills 目录（缺省 ~/.claude/skills）——含 SKILL.md 与 references/。
 * 逐个 skill 尽力而为：单个缺源/失败只 warn、不抛（不挡命令行使用）。全部成功返回 true。
 */
export function installSkill(opts: { dir?: string } = {}): boolean {
	const destRoot = opts.dir ?? join(homedir(), ".claude", "skills");
	let allOk = true;
	for (const name of SKILL_NAMES) {
		const src = join(packageRoot(), "skills", name);
		if (!existsSync(join(src, "SKILL.md"))) {
			log.warn(`找不到打包的 skill 源：${join(src, "SKILL.md")}（跳过 ${name}，不影响命令行）`);
			allOk = false;
			continue;
		}
		const dest = join(destRoot, name);
		try {
			mkdirSync(dest, { recursive: true });
			cpSync(src, dest, { recursive: true });
			log.ok(`已安装 /${name} → ${join(dest, "SKILL.md")}`);
		} catch (e) {
			allOk = false;
			log.warn(`skill 安装失败（${name}，不影响命令行使用）：${e instanceof Error ? e.message : String(e)}`);
		}
	}
	log.info("在 Claude Code 里打 /gtrk-oralcut、/gtrk-splitter 或 /gtrk-style-maker，也可直接说「帮我剪个口播 / 拆个分镜 / 造我栏目的风格 skill」触发（可能需重载会话）。");
	return allOk;
}

export function registerSkills(program: Command): void {
	const skills = program.command("skills").description("管理 agent skill（安装到 Claude Code）");

	skills
		.command("install")
		.description("把 gtrk 全家框架 skill 安装到 ~/.claude/skills（对标飞书 skills add）")
		.option("--dir <dir>", "自定义 skills 目录（缺省 ~/.claude/skills）")
		.action((opts: { dir?: string }) => {
			installSkill({ dir: opts.dir });
		});
}
