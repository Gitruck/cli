---
name: gtrk-mg
description: MG 动态图颗粒铺轨器——成片 SOP 第 ④ 步，在 B-roll 定下来之后，把栏目的 html-particle 动态图颗粒（透明叠加 / 满屏底层）叠铺到 B-roll 之上。先由栏目 MG 生产 skill 按派单各槽位产颗粒，再驱动 `gtrk mg` 命令 lint + 铺进 `.gtrk` 工程的 beat_track。当用户想「铺 MG 颗粒 / 上动态图 / 铺动效 / 给这段配动画铺进工程 / 把 MG 派单铺轨 / 消费 dispatch.mg」时使用本 skill。凡涉及把 MG 动态图颗粒铺进已剪好的成片工程，优先用本 skill 驱动 gtrk CLI，别让用户自己去终端敲 `gtrk mg`。
---

# MG 动态图铺轨（gtrk-mg）

把 `gtrk split` 派好的 **MG 槽位**（`dispatch.mg`），先由**栏目的 MG 生产 skill** 产成 html-particle 动态图颗粒，再交给 `gtrk mg` 命令 lint + 铺进 `.gtrk` 工程的 `beat_track`——**叠在已经定下来的 B-roll 之上**。**CLI 是手（lint / 铺轨 / 写回），你是脑（认 SOP 位置、驱动栏目生产 skill、管用户检查点、判 lint 该不该硬铺）。栏目生产 skill 只产纯净颗粒、不知 gtrk 命令，由你驱动。**

> **本 skill 已含你需要的全部信息**（SOP 位置、业务分离、逐槽位工作流、命令参数、lint 铁律、排错、交棒）。命令参数细节以 `gtrk mg --help` 为准；颗粒的视觉/内容规范**不在这里**——那是栏目资产，由栏目 MG 生产 skill 全权负责。

## 你在成片 SOP 的哪一步（先认位置，别抢跑）

成片是**有序 SOP + 用户检查点**，不是并行一次铺完。全序：

> ① `/gtrk-oralcut`（剪口播）→ ② `/gtrk-splitter`（拆分派单出 `dispatch.json`）→ **③ `/gtrk-matrix` 先铺 B-roll → 用户 opencut 挑选/调整确认** → **④ 本 skill：再铺 MG（叠在 B-roll 之上）** → ⑤ `/gtrk-ai-drama`（最后上 AI 再现）→ `gtrk render` 收口

**你是第 ④ 步。MG 颗粒是叠层——底下那层 B-roll 必须先定死，否则 MG 会盖在还没挑好的画面上白铺。** 所以动手前先过前置硬门。

### 前置硬门（不满足就别铺，先回上一步）

1. **B-roll 已铺且用户已确认**：若 `dispatch.film_broll` 非空，必须 ③ 已跑过 `gtrk matrix` **且用户已在 opencut 里挑选/调整确认**。用户没确认 → **别铺 MG**，先回 ③ 让用户定 B-roll，明确告诉他「B-roll 定了我再上 MG」。（`dispatch.film_broll` 为空 = 本片没 B-roll 底层，可直接进 ④。）
2. **有 split 产物**：需要一个跑过 `gtrk split` 的产物目录（含 `split/dispatch.json` 与工程 `.gtrk`）。没有 → 先回 ② `/gtrk-splitter`。
3. **`dispatch.mg` 非空**：为空 = 本片没有 MG 车道 → **别硬造**，直接交棒 ⑤（见末节）。
4. **CLI 在**：`gtrk` 找不到 → 让用户装 `npm i -g @gitruck/cli@latest`（需先有 Node.js）。

## 业务分离：谁产颗粒（栏目），谁铺轨（本 skill）

**本框架 skill 不硬编任何栏目的视觉风格/生产内容。** MG 颗粒长什么样、用什么视觉语法，全由**栏目的 MG 生产 skill** 决定；本 skill 只负责「在对的时候、按派单、驱动它产，然后把成品铺进工程」。

**车道 → 栏目生产 skill 的解析（照此，别猜）**：读**有效栏目配置**的 `style.skills[]`（配置文件 `~/.gitruck/columns/<id>.json`；栏目 id 由 `--column <id>` 或 config `defaultColumn` 选取；零配置 = L0 内置默认栏目，**不携带 style 清单** → 必然走下方「无匹配」分支）。在 `style.skills[]` 里取 **`produces` 归一后（旧 `RRV_MG` → `MG`）等于 `MG`** 的条目 → 触发它 `ref` 指向的 skill 产颗粒。
- 命中多条 → 按栏目约定取其一（一般栏目只登记一个 MG 生产 skill）。
- 条目带 `routing:"none"`（管线外产物，如封面）→ 跳过，不当 MG 生产 skill。
- **无匹配** = 本栏目没有 MG 生产 skill → 别硬铺；告诉用户「本栏目还没有 MG 生产 skill，先用 `/gtrk-style-maker` 建一个，或换个已配置的栏目（`--column`）」。

> **生产 skill 是栏目的纯净资产**：它只懂本栏目的视觉语法、只产 html-particle 颗粒，**不知道 gtrk 命令、不知道产物落哪**。由本 skill 驱动它、并**由本 skill 负责把它产出的颗粒存到 `gtrk mg` 要读的路径**：`<产物目录>/mg/<composition_id>.html`。举例（仅示意解析机制，非硬编）：`real-roam-guide` 栏目配置里 `style.skills` 有一条 `{produces:"MG", ref:"…/real-roam-viz"}` → 驱动它产颗粒；换个栏目、换个 ref，产颗粒的就是另一个生产 skill。**本 skill 正文里不绑死任何栏目的生产 skill。**

## 逐槽位工作流（产 → lint → 铺，循环到铺满）

### 1. 看板起手：先看 `dispatch.mg` 有哪些槽位、铺到哪了

```bash
gtrk mg status --project "<split产物目录>" --json
```

- 汇总 MG 流水线：`dispatch.mg` beat 槽位总数 / 已产源 HTML 数 / 已铺进 `.gtrk` 数，并**逐 beat 标注**（缺 HTML / 已产未铺 / 已铺）。
- 每个槽位有 `composition_id`（主颗粒 = `<工程slug>-<beatId>`；`overlay` 叠层派生颗粒 = `<工程slug>-<beatId>-aux<n>`）与 `handoff`（`theme` / `duration_hint`（秒）/ `category` 等）。**这些是你交给栏目生产 skill 的产片订单。**

### 2. 逐槽位产颗粒（驱动栏目 MG 生产 skill）

对每个「缺 HTML」的槽位：把它的 `composition_id` + `handoff`（`theme` / `duration_hint` / `category`：`overlay` 透明叠加·不挡主体 / `fullscreen` 不透明满屏）+ beat 语义上下文，**交给第「业务分离」节解析出的栏目 MG 生产 skill 产一颗 html-particle**。产完把颗粒**存到 `<产物目录>/mg/<composition_id>.html`**（`gtrk mg` 就从这里读）。
- **`-aux<n>` 叠层颗粒同样处理**：`gtrk split` 若在某 beat 的 `aux_layers` 派了 `overlay`，会派生 `<beat>-aux<n>` 进 `dispatch.mg`（多为 B-roll 底轨之上叠透明概念图解）——照样产、照样存到对应 `composition_id.html`。
- **category 决定叠法**：`overlay` 颗粒背景透明、盖在 B-roll 上不挡主体；`fullscreen` 不透明满屏。最终透明度由颗粒 HTML 根 `background` 反推的 `opaque` 定，生产 skill 要让二者自洽（lint 会查）。

### 3. lint 门：铺之前先单测每颗（不过就退回生产 skill，别硬铺）

```bash
gtrk mg lint "<产物目录>/mg/<composition_id>.html" --dispatch "<产物目录>/split/dispatch.json"
```

- 纯本地静态校验颗粒 HTML 的**六铁律机器可判定子集**：`<template>` 包裹、`data-composition-id` + 1920×1080、`gsap.timeline({ paused: true })`、`window.__timelines` 注册、无 `Math.random` / `Date.now`（可逐帧 seek 的确定性）、自包含无相对外链、根 `background` 与 `opaque` 自洽…；给 `--dispatch` 会额外校验 `composition_id` 命中派单。
- **不过（非 0 退出、逐条报因）→ 把报错原样丢回栏目 MG 生产 skill 修，重产重 lint，别硬铺**。铺一颗不合规颗粒会污染工程。
- 只想批量干校验不写回：`gtrk mg --project <dir> --lint-only`。

### 4. 铺轨：全槽位就绪后铺进工程（叠在 B-roll 之上）

```bash
gtrk mg --project "<split产物目录>" --json
```

- 读 `dispatch.mg` → 逐 beat 从 `<project>/mg/<composition_id>.html` 取源颗粒 → lint → 铺进 `.gtrk` 的 `beat_track`，把 `struct_meta.mg` 原子写回。**幂等**：重铺先剥旧自产轨再 append，用户在 opencut 手加的轨零连带。
- `--json` 输出：`{ ok, mode:"lay", laid:[…], skipped:[…], … }`。
  - **`laid`** = 铺成的 `composition_id`。
  - **`skipped`** = 缺 HTML / lint 失败的 beat（不拦其余）——**回步骤 2 补产、重铺**，别当没看见。
- **只铺单个 beat**：`--only <beatId>`（主颗粒 + 其 `-aux<n>` 叠层一并选），适合迭代改单段。

### 5. 循环到铺满

多 MG 槽位就**循环「产 → lint → 铺」直到 `dispatch.mg` 全部铺满**（`gtrk mg status` 逐 beat 全标「已铺」、`gtrk mg` 的 `skipped` 为空）。

> 旧名 `gtrk rrv` 是去品牌化前的弃用别名（仍能跑但会打提示）——**一律用 `gtrk mg`**。

## 读结果、给用户交代（别只说「铺好了」）

- **铺了哪些**：`laid[]` 的 `composition_id`，对应哪些 beat；其中哪些是 `overlay` 透明叠加（盖在 B-roll 上）、哪些是 `fullscreen` 满屏。
- **没铺上的**：`skipped[]` + 原因（缺 HTML 还是 lint 失败）——如实说，别谎报全铺；已补产重铺的说清楚补了哪几颗。
- 想在 opencut 里精修颗粒（手调参数/时长）→ 提示用户可打开工程手调；改完不影响本轨幂等重铺。

## 交棒 ⑤（别停在铺完）

`dispatch.mg` 全铺满、`gtrk mg status` 全绿后**别收工**——按 SOP 顺势接力到第 ⑤ 步 **AI 再现**：
- `dispatch.ai_drama` 非空 → 触发 `/gtrk-ai-drama`（持通用分镜 craft + 读栏目 style-lock，产 AI 再现分镜稿——四段描述 + 独立视觉基调 + 时长预算；用户去可灵 / Vidu 等外部平台出片回铺；**此车道产物即分镜稿、无 gtrk 命令**）。一句话交代即推进：「MG 颗粒已叠铺完，我接着安排最后一步 AI 再现」。
- `dispatch.ai_drama` 为空 → 本片没有 AI 车道，可直接 `gtrk render` 收口成片。

除非用户表示只铺这一版 MG、暂不往下。

> 原则：**agent 替用户跑 CLI / 接力 skill、驱动栏目生产 skill，用户只对话**——别让用户自己去终端敲 `gtrk mg`，也别让用户手动去 call 栏目生产 skill。
