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
 *   gtrk transcript <视频> 本地视频转单个妙记式 Markdown（原视频不上传）
 *   gtrk split [拆分稿]   视觉拆分派单器（transcript × .gtrk 投影 → 校验落地 struct_meta.split + dispatch）
 *   gtrk tool <name>      单点工具族（image_move/image_matting/video_matting…）；gtrk tool list 查全部
 *   gtrk doctor           体检（配置 / 云端连通 / 剪映目录 / 运行时 / 版本）
 *   gtrk deps             运行时资产：status 查来源/授权、install 显式装 ffmpeg 与渲染字体
 *   gtrk upgrade          升级 CLI 到最新版 + 刷新 skill（配置保留）
 *   gtrk skills install   通过通用 skills 适配器安装到各类 Agent
 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrateLegacyHome, packageRoot } from "./lib/paths";
import { registerInstall } from "./commands/install";
import { registerInit } from "./commands/init";
import { registerOralCut } from "./commands/oralcut";
import { registerLong2Short } from "./commands/long2short";
import { registerOralCutResult } from "./commands/oralcut-result";
import { registerDoctor } from "./commands/doctor";
import { registerSkills } from "./commands/skills";
import { registerUpgrade } from "./commands/upgrade";
import { registerRender } from "./commands/render";
import { registerQc } from "./commands/qc";
import { registerSplit } from "./commands/split";
import { registerMatrix } from "./commands/matrix";
import { registerMg } from "./commands/mg";
import { registerTool } from "./commands/tool";
import { registerTranscript } from "./commands/transcript";
import { registerMusicVisualizer } from "./commands/music-visualizer";
import { registerDeps } from "./commands/deps";
import { registerProject } from "./commands/project";
import { registerAudio } from "./commands/audio";
import { registerSubtitle } from "./commands/subtitle";

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

import { firstRunTutorialOnce } from "./lib/first-run-tutorial";

const program = new Command();

program
	.name("gtrk")
	.description("同合云成片流水线 CLI —— agent 驱动云端任务、产物拉回本地、三方工程文件（客户端/剪映/PR）互通")
	.version(version);

// ── 首跑教程指路（add-first-run-tutorial）──
// 挂在入口一处收口：任何子命令的首次运行都会指一次路，各子命令零改动。
// 恒 stderr、幂等靠 ~/.gitruck/config.json 留痕、存量老用户（已有 apiKey）静默补痕不打印。
// MUST NOT 阻断命令、MUST NOT 要交互输入 —— 详见 src/lib/first-run-tutorial.ts 文件头。
program.hook("preAction", () => {
	firstRunTutorialOnce();
});

// ── 注册子命令（后续新增命令在此加一行）──
registerInstall(program);
registerInit(program);
registerOralCut(program);
registerLong2Short(program);
registerOralCutResult(program); // 按 task_id 取回已完成任务的报告/产物（不重跑云端）
registerDoctor(program);
registerSkills(program);
registerUpgrade(program);
registerRender(program); // 本地渲染 gtrk 工程（EDL）→ 成片 mp4
registerQc(program); // 成片质量扫描（闪帧/段内跳切/黑帧/冻结/爆音/静音/音画规整）
registerSplit(program); // 视觉拆分派单器：transcript × .gtrk 投影 → 校验落地 struct_meta.split + dispatch
// registerStruct(program);   // 已有 gtrk → 三方工程文件
registerMatrix(program); // B-roll 检索：dispatch.film_broll → split/broll-plan.json 候选清单（双口路由）
registerMg(program); // MG 颗粒铺轨：dispatch.mg → 定位颗粒 HTML → lint → 铺 html-particle 到 beat_track（弃用别名 gtrk rrv）
registerTool(program); // 单点工具族：gtrk tool <name> [input]（image_move/image_matting/video_matting…）+ gtrk tool list
registerTranscript(program); // 本地视频 → 只传抽取音频 → 单个含总结/时码记录/纯文本的 Markdown
registerMusicVisualizer(program); // 音乐可视化：主音频 + 可选背景/封面 → 频谱可视化成片（独立命令 + driver skill）
registerDeps(program); // 运行时资产：gtrk deps status / install（显式触发，绝不静默自动下载）
registerProject(program); // 音频驱动工程：gtrk project init 从配音起盘建工程（服务端 producer 同步口消费端）
registerAudio(program); // 音频轨零件：gtrk audio lay 往 .gtrk 追加 audio_track（BGM 上轨 + beat 对齐）
registerSubtitle(program); // 字幕零件：gtrk subtitle lay 把 transcript 投影成客户端契约字幕写进 cve text lane（快速成片直接带字幕）

program.parseAsync(process.argv).catch((e: unknown) => {
	console.error(`\n❌ ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
