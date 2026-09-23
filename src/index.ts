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
 *   gtrk patch <动作>  元素级编辑 .gtrk：move / trim / split / set
 *                     （恒等式同步 + 帧对齐；agent MUST NOT 裸手改 JSON）
 *   gtrk tool <name>      单点工具族（image_move/image_matting/video_matting…）；gtrk tool list 查全部
 *   gtrk doctor           体检（配置 / 云端连通 / 剪映目录 / 运行时 / 版本）
 *   gtrk deps             运行时资产：status 查来源/授权、install 显式装 ffmpeg 与渲染字体
 *   gtrk upgrade          升级 CLI 到最新版 + 刷新 skill（配置保留）
 *   gtrk skills install   通过通用 skills 适配器安装到各类 Agent
 *   gtrk feedback <话>    把使用中的不顺手反馈上去（告知式提交：助手代提必须先念给用户听）
 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrateLegacyHome, packageRoot } from "./lib/paths";
import { installCrashHooks, handleTopLevelError } from "./lib/crash-report";
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
import { registerPatch } from "./commands/patch";
import { registerMatrix } from "./commands/matrix";
import { registerMg } from "./commands/mg";
import { registerTool } from "./commands/tool";
import { registerTranscript } from "./commands/transcript";
import { registerMusicVisualizer } from "./commands/music-visualizer";
import { registerDeps } from "./commands/deps";
import { registerProject } from "./commands/project";
import { registerAudio } from "./commands/audio";
import { registerSubtitle } from "./commands/subtitle";
import { registerFeedback } from "./commands/feedback";
import { registerAiDrama } from "./commands/ai-drama";
import { registerPip } from "./commands/pip";

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
import { skillFreshnessNoticeOnce } from "./lib/skill-freshness";
import { installStreamGuards } from "./lib/log";

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

// ── skill 过期检测（fix-skill-install-staleness · ③ 层）──
// 已装 skill 是「装完即冻结的快照」，npm 升级只换包、不刷它；2026-09-04 主理人机器上
// 五个 skill 停在 43 天前，而全链没有任何一处会告诉他。这里挂一次**廉价**核对：
// 只 readdir+stat 比形状签名（MUST NOT 读 skill 正文、MUST NOT 联网），
// 一致时零输出，不一致才提示一次并给出准确修复命令。异常一律吞掉，MUST NOT 拦路。
// 只对**需要 skill 的命令**做（白名单在 src/lib/skill-freshness.ts）——doctor/tool/deps 不提示。
program.hook("preAction", (_thisCommand, actionCommand) => {
	// 取顶层命令名：`gtrk matrix search` ⇒ matrix（白名单按顶层命令登记）
	let top: Command = actionCommand;
	while (top.parent && top.parent !== program) top = top.parent;
	skillFreshnessNoticeOnce({ command: top.name() });
});

// 崩溃自动上报（change link-client-error-report-cli）：进程级两钩子（uncaught / unhandledRejection）。
// ⚠️ MUST 在注册子命令之前装——命令注册期自己抛的异常也算崩溃。幂等，重复调无副作用。
// 装钩子本身零网络、零磁盘、零输出；真要不要发由 reportCrash 的三道闸（开关/告知痕迹/Key）判。
installCrashHooks();

// 呈现流的**异步**失败路（change `fix-local-io-environment-failures` · design D2）。
// 同步那条在 `lib/log.ts` 的 writeTo 里收；流已排队时 Node 走的是 `error` 事件，由同一模块的守卫收。
// 读端关掉（`gtrk … | head`、终端被关、agent 工具调用被掐）不是缺陷，不该炸掉正在跑的活。
// ⚠️ 只吞具名两码，其余重抛 —— 真出事的写入失败照旧落到 uncaughtException 与崩溃上报。
installStreamGuards();

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
registerPatch(program); // 元素级编辑：move/trim/split/set —— 恒等式同步 + 帧对齐（agent 勿裸手改 JSON）
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
registerFeedback(program); // 用户摩擦上报：gtrk feedback <话> —— 告知式提交，非 TTY 且未声明已告知时拒绝上报（-y 不构成豁免）
registerAiDrama(program); // AI Drama Desk return-v1 导出包 → 独立 AI video_track（纯本地、零计费）
registerPip(program); // 双源画中画：gtrk pip lay 把口播粗剪切点镜像到同步录的屏录 / 第二机位，铺满幅轨 + 人像画中画副本轨（纯本地、零计费）

// 顶层出口。⚠️ 三件事的**次序是契约**（change link-client-error-report-cli，design D2）：
//   ① 先上报（最长 2 s 硬超时，只对判为「崩溃」的错误真发；其余立即 resolve）
//   ② 再原样打印 ❌ 一行 —— 文案与本 change 之前**逐字相同**
//   ③ 退出码恒 1
// 为什么上报在打印之前：`process.exit(1)` 会立刻杀掉进程，打印之后再 await 就没机会发了；
// 而上报器**绝不抛**、恒 resolve，所以它排在前面也不会挡住用户看到报错（最坏晚 2 s）。
program.parseAsync(process.argv).catch(async (e: unknown) => {
	await handleTopLevelError(e);
	console.error(`\n❌ ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
