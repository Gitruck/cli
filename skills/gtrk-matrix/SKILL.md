---
name: gtrk-matrix
description: B-roll 检索铺轨器——成片管线里第一个铺的车道（SOP ③）。消费拆分派单的 FILM_BROLL 队列（`dispatch.film_broll`），双口向量检索 + 下载 preview 代理，在工程里平铺 N 条候选 B-roll 轨，供用户在 opencut 里用轨道小眼睛切换对比、挑选/调整；确认后交棒 ④ 铺 MG。当用户想「铺 B-roll / 检索素材 / 找空镜 / 给空镜配画面 / 填 B-roll 候选 / 单独搜个词补个空槽」时使用本 skill。凡涉及把拆分派单里的影视素材段落检索并铺进工程，优先用本 skill 驱动 gtrk CLI 的 `matrix` 命令，别让用户自己去终端敲、也别手搓检索。
---

# B-roll 检索铺轨器（gtrk-matrix）

把拆分派单里的 **FILM_BROLL 队列**（`split/dispatch.json` 的 `film_broll`），用 `gtrk matrix` 跑通「双口向量检索 → 下载 preview 代理 → 在工程里平铺 N 条候选 B-roll 轨」，再**提示用户在 opencut 里挑选/调整**、确认后交棒下一步。**CLI 是手（检索/下载/铺轨/写回），你是脑（懂 SOP 位置、管用户检查点、遇差调参补空）。**

> **本 skill 已含你需要的全部信息**（SOP 位置、参数、执行、读结果、检查点、排错、交棒），照它做即可，不用也无法去查外部文档。（`gtrk matrix --help` 也随时列全部 flag。）

## 你在成片管线里的位置（SOP 第 ③ 步 · 第一个铺的车道）

成片是**有序 SOP + 用户检查点**，不是并行一次铺完。全链：

> ① `oralcut` 剪口播 → ② `split` 拆分派单出 `dispatch.json` → **③ `matrix` 先铺 B-roll（你在这）** → **用户 opencut 调整/挑选** → ④ `mg` 再铺 MG（叠在 B-roll 之上）→ ⑤ `ai-drama` 最后上 AI 再现 → `render` 收口。

**为什么 B-roll 第一个铺**：MG 颗粒是**叠在 B-roll 之上**的透明/满屏视觉，AI 再现最后上——所以要先把**底层 B-roll 定下来、用户满意了**，上面几层才有稳的地基。你这一步是整条视觉链的**打底**，铺完**必须停下等用户在 opencut 里挑选/调整**（关键检查点，见下文），不要一口气往 ④ 冲。

## 前置：确认派单 + CLI

- 需要一个**跑过 `gtrk split` 的产物目录**，里面有 `split/dispatch.json`。没有 → 先回到 ② 触发 `/gtrk-splitter` 产派单。
- 看 `dispatch.json` 的 `film_broll` 队列：**空 = 本片没有 B-roll 车道**（拆分时没有段落被判给 `FILM_BROLL`）→ 直接跳过本步、交棒 ④ 铺 MG，别空跑。非空才往下。
- `gtrk` 命令找不到 → 让用户装 `npm i -g @gitruck/cli@latest`（需先有 Node.js）。
- 用户可以先在 opencut 里手调切点再保存——铺轨是往当前工程 append 候选轨，基于工程现状。

## 业务分离：B-roll 无栏目生产 skill，检索偏好由栏目配置供

**本框架 skill 不硬编任何栏目的审美/内容。** 但 B-roll 车道和 MG / AI 再现不同——

- **B-roll 没有「栏目生产 skill」**：检索用的 `queries`（英文长句场景描述）**在 ② 拆分时就由 splitter 写进派单**（`dispatch.film_broll[].queries`），是现成的机器输入。所以这一步**不触发任何生产 skill**，直接跑命令消费队列即可。（对照：④ MG / ⑤ AI 再现才需要栏目生产 skill 产内容；A_ROLL 就是口播本身。）
- **栏目只供「检索偏好」**：命中哪类素材、打什么标签、real_shot 还是 concept，走**栏目配置的 B-roll 偏好**（`~/.gitruck/columns/<id>.json` 的 `broll.column_tag_ids` / `material_class_policy` / `facet_defaults`）。用 `--column <id>` 选栏目，缺省取 config `defaultColumn`，再缺省内置默认栏目。**你不用手填这些**——`gtrk matrix` 读栏目配置自动注入；你只在用户明确要覆盖时才用 `--material-class` 等散参。
- **档位决定偏好是否生效**：命令先探身份档位——**internal（矩阵成员口）**才注入栏目检索偏好、支持 `concept`；**external（通用口）**服务端固定 `real_shot` + 有版权素材，栏目偏好与 `--material-class concept` 不适用（命令会警告或报错）。档位在结果 JSON 的 `memberType` 里，照它跟用户交代即可，别自己猜。

## 完整参数规格 —— 按需组合，没提就跑默认

**默认（`gtrk matrix --project <目录>`，`--lay 1`）已是给多数人调好的**：消费派单、检索、铺 1 条候选轨。只在用户有具体诉求时才加参数。名字/取值照下表用。

| 用户想要 | CLI 怎么传 | 取值 · 默认 | 说明 |
|---|---|---|---|
| 消费派单铺 B-roll（主路） | `gtrk matrix --project <目录>` | 目录 · — | 读 `<目录>/split/dispatch.json` 的 `film_broll`，产候选清单 + 铺轨 |
| 单独搜个词补空槽（ad-hoc） | `gtrk matrix search "<词>"` | 字符串 · — | 不依赖派单的单条检索；`--out <file>` 落盘或缺省 stdout |
| 显式指定派单文件 | `--dispatch <path>` | 路径 · 由 `--project` 推 | 非标准布局兜底 |
| 按某栏目的检索偏好 | `--column <id>` | 栏目 id · config `defaultColumn`→内置默认 | 注入该栏目 `broll` 标签/material_class/facets（仅 internal 口生效） |
| 多铺几条候选来对比 | `--lay <n>` | 非负整数 · `1`（`0`=只出 plan 不铺轨） | 平铺 N 条候选轨，opencut 里小眼睛切换对比挑选 |
| 每段多给几个候选 | `--top-k <n>` | 整数 · 派单 `shots` 值（服务端上限 50） | 覆盖派单里每 query 的候选数上限 |
| 指定素材类型 | `--material-class <c>` | `real_shot` \| `concept` · 栏目策略 | 仅 internal 矩阵成员口；external 固定 real_shot、传 concept 报错 |
| 填充太满/太差调门槛 | `--score-floor <f>` | 浮点 0–1 · `0.2` | segment score 低于此值不采纳、槽位留空露主轨 |
| ad-hoc 结果落文件 | `--out <file>` | 路径 · 缺省 stdout | 仅 `search` 模式 |
| 机读（你必带） | `--json` | 开关 · 关 | 人读日志转 stderr，stdout 只出一行结果 JSON |

> **因势象形举例**：「B-roll 多铺几条候选让我挑」→ `--lay 3`；「这段填得太杂、卡严点」→ `--score-floor 0.35`；「每段多给点候选」→ `--top-k 12`；「先只出清单别铺轨」→ `--lay 0`；「单独给『深夜地铁失神』搜一组」→ `gtrk matrix search "exhausted commuter staring blankly on a late night subway" --project <目录> --json`。

## 执行（每次都带 `--json`）

```bash
gtrk matrix --project "<split 产物目录>" [--lay N] [--score-floor F] [--top-k K] [--column <id>] --json
```

- `--json`：人读日志走 stderr，**成功时 stdout 只有一行结果 JSON**：
  `{ ok, mode:"plan", memberType:"internal"|"external", columnId?, planPath, lay:{ laidTracks:[…], laidClips, downloads:{preview,raw,reused,failed} }, counts:{ beats, queries, results, errors } }`
  （`--lay 0` 时无 `lay` 字段；ad-hoc `search` 模式则是 `{ ok, mode:"search", results:[…], counts, outPath? }`）
- 产物：候选清单 `<目录>/split/broll-plan.json`（只含引用不含素材，`cover_url` 可预览、签名 url 约 24h 过期，过期重跑即重签），铺轨则把候选轨写回工程 `gtrk/project.gtrk`。
- **命令失败**（缺 `--dispatch`/派单、鉴权失败、全部 query 检索失败、参数越界等）→ **进程非 0 退出、报错打到 stderr、stdout 无 JSON**。先看退出码，非 0 就把 stderr 的报错如实回给用户，别当成功。
- 检索是分钟级（逐 beat 逐 query + 下载代理），耐心等命令返回。

## 跑完读结果、给用户交代

读 stdout 那行结果 JSON（字段按需读、读前判空），别只回「铺好了」：

- `counts`：`beats` 个 beat、`queries` 条检索（`errors` 条失败）、`results` 条候选——一句话概括这次铺了多大盘子。
- `memberType`：`internal` = 矩阵成员口（栏目偏好/concept 生效）；`external` = 通用口（固定 real_shot + 有版权素材）——档位影响命中类型，若用户期望 concept 却是 external，明说「当前身份只能出实拍有版权素材」。
- `lay.laidTracks` / `lay.laidClips`：铺了几条候选轨、共几个颗粒（`--lay 0` 时无此字段，只出了 plan）。
- `lay.downloads`：`preview` 代理数 / `raw` **原片回落**数（无 preview 代理的候选回落下原片、体积大，服务端 backfill 后重跑本命令可换回代理）/ `reused` 复用 / `failed` 掉的槽位——`raw`/`failed` 非零时提一句。
- **单 query 失败是局部化的**（`counts.errors > 0` 但 `ok:true`）：个别检索失败不拖垮整盘，如实说哪几段没检到、其余照铺。只有**全部 query 都失败**才会整体非 0 退出。
- 工程缺失/非 v1 → 命令会**告警跳过铺轨但仍产 plan**（stderr 有提示）——这时 `lay` 字段缺失，告诉用户 plan 已出、可在有工程的目录重跑铺轨。

## 关键检查点：让用户在 opencut 里挑选/调整（别跳过）

**这是本步的核心，不是可选收尾。** 铺轨产出的是**多条并列的候选 B-roll 轨**（`--lay N` 就是 N 条），不是定死的成片——挑哪条、要不要下原片、切点微调，都由用户在 opencut 里定。铺完**必须**这样提示用户，并**停下等他确认**：

- **在同合云桌面客户端（opencut / OpenCut Gitruck Edition）里打开这个工程**，B-roll 候选轨已经铺好。
- **用轨道头的「小眼睛」开关逐条切换对比**：看哪条候选最贴这段口播的情绪/画面，留下满意的、关掉不要的。
- 候选默认是 preview 代理（轻量预览）；**下载原片属挑选后的动作**（客户端挑选 UI），确认要哪条再拉原片。
- 觉得填充有问题（太杂/太空/漏段）先别急着往下——**回来告诉我**，我按下面「常见情况」调参重铺。

**用户明确说「B-roll 就这样、可以了」之后**，才交棒 ④。别自作主张替他拍板往下冲。

## 常见情况处置（据结果因势象形调整，同目录可反复重跑对比）

| 情况 | 怎么做 |
|---|---|
| 想在多个候选里挑 | `--lay N` 多铺几条候选轨，opencut 小眼睛切换对比（N 越大越占轨、挑完可删多余轨） |
| 填充太差 / 命中太杂 | 调 `--score-floor`（调高更严、露主轨；调低更满、可能杂）重跑 |
| 每段候选太少不够挑 | 调 `--top-k`（每 query 给更多候选）重跑 |
| 某段有空槽 / 漏检 / 想补个特定意象 | `gtrk matrix search "<英文长句场景描述>" --project <目录> --json` 单条 ad-hoc 补检，把中意的候选记下、在 opencut 里手动铺进那段 |
| 只想先看清单不铺轨 | `--lay 0`（只产 `broll-plan.json`，不动工程） |
| 代理过期看不了预览 | 直接重跑本命令即重签 preview url（约 24h 过期） |
| 出现 raw 原片回落 / 体积大 | 提示用户；服务端 backfill 后重跑可换回轻量代理 |
| 期望 concept 却报 external 限制 | 如实说明当前身份（`memberType:external`）只出 real_shot 有版权素材，concept 需矩阵成员口 |

> **搜词规范**（ad-hoc `search` 与理解派单 queries 通用）：用**英文长句场景描述**（5–12 词，谁+在哪+做什么），一条只装一个场景意象，**避多义/字面强的动词**（"pointing"/"hunting" 会召回特写/猎人，改用场景语义如 "giving suggestions in a meeting"）。派单里的 queries 已按此校准，你补检时照此写。

## 下一步（交棒 ④，别停在铺完）

用户确认 B-roll 满意后，**别停下等他再开口**——顺势按 SOP 交棒 ④ 铺 MG：触发 `/gtrk-mg`（它读 `dispatch.mg`、由栏目 MG 生产 skill 产 html-particle 颗粒，再跑 `gtrk mg` 把 MG **叠在你刚定好的 B-roll 之上**）。一句话交代即推进：「B-roll 底层定了，我接着把 MG 颗粒叠上去」。

- `dispatch.mg` 为空 → 跳过 ④，直接看 ⑤ AI 再现（`dispatch.ai_drama` 非空则触发 `/gtrk-ai-drama`）。
- 用户表示暂时只要 B-roll、先不往下 → 停在这，尊重他的节奏。

> 原则：**agent 替用户跑 CLI / 接力 skill，用户只对话**——别让用户自己去终端敲下一条 gtrk 命令；但**关键检查点（尤其 B-roll 铺完这一处）务必停下等用户确认**再进下一步。
