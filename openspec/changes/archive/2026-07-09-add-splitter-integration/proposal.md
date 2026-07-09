# add-splitter-integration · Proposal

## Why

口播稿拆分（文稿 → beat 视觉拆分 → 四车道派单）今天是一个游离的独立 skill（`video-script-visual-splitter`）：产物是纯人读 Markdown、用「锚点文字」模糊定位、没有时码、没有机器可消费的载荷——B-roll 检索 / RRV_MG 颗粒 / AI_DRAMA 三条下游车道全部接不上，客户端也无从装配。按「skill 是 cli 的子集」范式（主理人 2026-07-06 定）把它收编进 gtrk：**脑**（`gtrk-splitter` skill，创作拆分）+ **手**（`gtrk split` 命令，投影/校验/落地），用户装一个 gtrk 就获得完整拆分能力，产物直接驱动后续铺轨。这是「派单器」——把智能剪口播已验证的闭环延伸成整条成片流水线的第一块连接组织。

## What Changes

- **skill 整体收编**：`video-script-visual-splitter` 迁入 `skills/gtrk-splitter/`（随 `gtrk skills install` 分发），SKILL.md 大改为 **transcript 驱动**：吃「当前时间线投影视图」（句级），产**双轨拆分稿**——机器 JSON（主产物）+ 人读 Markdown（备选 `--md`）；原 `file/skills` 下目录归档进 `file/skills/history/`（工作区级动作，消灭三处副本漂移）。
- **锚点语法退役，句区间 id 引用**：beat 的文稿范围 = utterance id 区间（`{from:"u001", to:"u004"}`），**绝不以原句文字作索引**（防 LLM 幻觉）；`gtrk split` 对 id 做强校验（不存在/区间倒序/跨 beat 重叠 → 硬拒）。
- **新命令 `gtrk split`（纯本地、同步、无云端任务）**，两模式：
  - **投影视图导出**（`gtrk split --project <dir>`）：读 `transcript.json`（源时基）× 当前 `project.gtrk` 的 clips（`clip_st/clip_ed → track_st/track_ed`），输出**发起那一刻**的句级轨道时基视图（含 dropped 标注）——skill 的创作输入。
  - **拆分稿校验落地**（`gtrk split <拆分稿.json> --project <dir>`）：校验（`contract_version` / `transcript_hash` 不匹配**硬拒** / id 合法性）→ 现场投影 → beat 车道标注写回 `.gtrk` 的 `struct_meta.split`（客户端 round-trip 安全区）→ 产**派单清单** `dispatch.json`（RRV_MG 槽位表 / FILM_BROLL 检索队列 / AI_DRAMA 队列）→ 可选产人读 md。
- **投影规则（explore D3/Q4 定案）**：时码恒挂源时基、每次发起现场投影；beat 的 utterance 全部被剪 → 跳过该 beat 并入 report；部分被剪 → 按剩余区间**收缩**并入 report。「拖入已剪好成片」= 恒等投影，同一套逻辑。
- **拆分稿机器契约 v1**：`beats[]`（id / span / base_track / lane 四选一 / 叙事功能八枚举 / 容器阶段七枚举 / 节奏标签〔人读〕/ handoff 分型 / 辅助层 / 不可替代性 / 降级方案）+ `queues`（四车道结构化派单）+ `contract_version` + `transcript_hash`。handoff 分型：`RRV_MG`（slug 提示/theme/底色〔由底轨态推导〕/时长）、`FILM_BROLL`（**新增素材 query 字段**：关键词组/镜头数/单镜时长/排除项）、`AI_DRAMA`（对齐 ai-drama-prompter 现有输入位）。
- **写回 `.gtrk` 只动 `struct_meta.split` 一个键**（原子写：临时文件 + rename），不碰 materials/tracks——配合客户端「保存 → 发起 → 写回 → 重载」闭环（opencut 侧联动 change `add-gtrk-reload`）。
- `--json` 机读、`routeLogsToStderr`、result 报告沿 v0.2.3 既有范式。

### 非目标（刻意不做）

- ❌ **不铺轨**：split 不产任何 clip、不动轨道——B-roll 素材进轨归 `gtrk matrix`（另立 change），颗粒装配归客户端/渲染链。
- ❌ 不做 B-roll 检索本体（`gtrk matrix` 单独立项，读本 change 的 `dispatch.json`）。
- ❌ 不做客户端可视拆分编辑器 / 拖拽调 beat 边界（后续客户端 change）。
- ❌ 不做纯文稿模式：无 transcript 不跑（「拍前拆稿规划分镜」只发生在 AI 动画层局部，归 ai-drama-prompter，主理人 2026-07-06 定）。
- ❌ 不做 transcribe / TTS producer（explore Q1，另立项）；本 change 只认 `transcript.json` 契约（`oral-cut-transcript`，infra 仓）。
- ❌ 不改 real-roam-viz / ai-drama-prompter skill 本体（handoff 契约就位后各自小改另办）。
- ❌ beat 边界不做句内字级切分（拆分单位 = visual_beat，沿句切；字级仅投影内部使用）。

## Capabilities

### New Capabilities

- `split-doc-contract`：拆分稿机器契约 v1——beats 结构、utterance id 区间引用（禁原文索引）、四车道 handoff 分型、queues、`contract_version`/`transcript_hash` 防错版。
- `timeline-projection`：投影契约——源时基 transcript × `.gtrk` clips → 发起时刻轨道时基视图；dropped 判定与 beat 收缩/跳过规则；恒等投影（已剪好成片）。
- `split-command`：`gtrk split` 命令面——两模式（投影视图导出 / 校验落地）、强校验硬拒语义、`struct_meta.split` 原子写回、`dispatch.json` 派单清单、`--md`/`--json`。
- `gtrk-splitter-skill`：skill 行为契约——脑手分工（LLM 只做拆分创作、不碰时码）、读投影视图、产双轨拆分稿、调 `gtrk split` 校验、按校验错误修正重试的循环。

### Modified Capabilities

（无——现有 7 个 spec 均不涉及；`gitruck-home` 无目录变更，产物落盘在工程目录内。）

## Impact

- **代码**：新增 `src/commands/split.ts`（`registerSplit`，`index.ts` 加一行）、`src/lib/projection.ts`（纯函数：transcript × gtrk → 投影视图；可离线单测）、`src/lib/splitdoc.ts`（拆分稿解析/校验/落地）；`skills/gtrk-splitter/`（SKILL.md + references：字段契约、20-beat 金样迁移版）；`src/commands/skills.ts` 登记新 skill。
- **上游依赖**：gitruck-infra 联动 change `add-oral-cut-transcript-output`（transcript.json 恒出，`oral-cut-transcript` 契约）——**两 change proposal 互链**，本 change 端到端联调依赖其先部署；离线开发用金样 fixture 不阻塞。
- **下游消费方**：`gtrk matrix`（B-roll，另立项）读 `dispatch.json` 的 FILM_BROLL 队列；real-roam-viz 按 RRV_MG 槽位表产颗粒；opencut 客户端联动 change `add-gtrk-reload`（保存→发起→写回→重载闭环）。
- **依赖**：无新增运行时 npm 依赖（投影/校验纯 TS；sha256 用 node:crypto）。
- **工作区动作**：`file/skills/video-script-visual-splitter/` → `file/skills/history/`（归档），单一真相源收敛到 cli 仓。
- **文档**：`AGENT.md` 补 splitter 编排章节（先 oralcut → 保存 → split 投影 → 拆分 → split 落地）；README 命令表补 `split`。
- **测试**：`node:test` 离线用例——投影黄金用例（含乱序剪辑/恢复片段/恒等投影/dropped 收缩）、拆分稿校验矩阵（hash 错版硬拒/id 越界/区间重叠）、`struct_meta.split` 原子写回与 round-trip、20-beat 金样端到端 dry-run。
