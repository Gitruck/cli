#!/usr/bin/env node
/**
 * gtrk —— 同合云成片流水线 CLI。
 *
 * 设计取向（对标专业 CLI 的子命令结构，可长很多命令）：
 *   - 每个能力一个子命令，放 src/commands/ 下，自带 register<Name>(program)。
 *   - 共享逻辑（云端调用 / 配置 / 输出）放 src/lib/。
 *   - 新增命令 = 写 commands/<name>.ts + 在下方注册一行。
 *
 * 当前命令：
 *   gtrk install          一条命令装全（skill + 配置），对标飞书 npx @larksuite/cli install
 *   gtrk init             仅配置（API Key + 剪映草稿目录）
 *   gtrk oralcut <毛片>   智能口播剪辑最小闭环（云端剪辑 → 拉回三方工程文件 → 打开）
 *   gtrk split [拆分稿]   视觉拆分派单器（transcript × .gtrk 投影 → 校验落地 struct_meta.split + dispatch）
 *   gtrk doctor           体检（配置 / 云端连通 / 剪映目录 / 运行时 / 版本）
 *   gtrk upgrade          升级 CLI 到最新版 + 刷新 skill（配置保留）
 *   gtrk skills install   单独把 /gtrk-oralcut skill 装进 Claude Code
 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrateLegacyHome, packageRoot } from "./lib/paths";
import { registerInstall } from "./commands/install";
import { registerInit } from "./commands/init";
import { registerOralCut } from "./commands/oralcut";
import { registerOralCutResult } from "./commands/oralcut-result";
import { registerDoctor } from "./commands/doctor";
import { registerSkills } from "./commands/skills";
import { registerUpgrade } from "./commands/upgrade";
import { registerRender } from "./commands/render";
import { registerSplit } from "./commands/split";

// 兼容 node：bun 会自动加载 .env，node 用 loadEnvFile 补上（无 .env 就忽略）。
// 配置主源是 ~/.gitruck/config.json（gtrk init 写），.env 仅作可选覆盖。
try {
	(process as { loadEnvFile?: () => void }).loadEnvFile?.();
} catch {
	/* 没有 .env 文件，忽略 */
}

// 用户目录归一：一次性把旧 ~/.gtrk-cli 迁到 ~/.gitruck（幂等、不删旧目录、失败不阻断）
migrateLegacyHome();

// 版本读 package.json（package.json 必随包发布），避免和 --version 硬编码漂移
const { version } = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
	version: string;
};

const program = new Command();

program
	.name("gtrk")
	.description("同合云成片流水线 CLI —— agent 驱动云端任务、产物拉回本地、三方工程文件（客户端/剪映/PR）互通")
	.version(version);

// ── 注册子命令（后续新增命令在此加一行）──
registerInstall(program);
registerInit(program);
registerOralCut(program);
registerOralCutResult(program); // 按 task_id 取回已完成任务的报告/产物（不重跑云端）
registerDoctor(program);
registerSkills(program);
registerUpgrade(program);
registerRender(program); // 本地渲染 gtrk 工程（EDL）→ 成片 mp4
registerSplit(program); // 视觉拆分派单器：transcript × .gtrk 投影 → 校验落地 struct_meta.split + dispatch
// registerStruct(program);   // 已有 gtrk → 三方工程文件
// registerMatrix(program);   // B-roll 检索

program.parseAsync(process.argv).catch((e: unknown) => {
	console.error(`\n❌ ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
