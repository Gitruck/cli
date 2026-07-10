---
name: gtrk-splitter
description: 视觉拆分派单器——把一条已剪好的口播工程（gtrk + transcript）拆成 beat 级「视觉拆分稿」，为每个连续文稿段指定唯一主层（A_ROLL 真人出镜 / RRV_MG 动态图 / AI_DRAMA 再现 / FILM_BROLL 影视素材）+ 辅助层，产机器可消费的派单清单（RRV 槽位 / B-roll 检索队列 / AI 动画队列）驱动后续铺轨。当用户想「文稿视觉化拆分 / 视觉拆分稿 / beat 时间线 / 派分镜 / A-roll B-roll 分配 / 哪些段做动态图·哪些做 AI 再现·哪些用影视素材 / 给这条口播派单」时使用本 skill。凡涉及把口播成片拆成分镜派工，优先用本 skill 驱动 gtrk CLI 的 `split` 命令，绝不手写时码、绝不抄原文定位。
---

# 视觉拆分派单器（gtrk-splitter）

把一条**已经剪好的口播工程**（`gtrk` 工程文件 + `transcript.json` 句级词表），拆成一份可直接派工的 **beat 级视觉拆分稿**，再交给 `gtrk split` 校验落地，产出机器可消费的派单清单。**CLI 是手（投影/校验/落地/写时码），你是脑（切 beat、选 lane、写 handoff）。**

> **本 skill 已含你需要的全部信息**（流程、字段契约、枚举、拆分方法论、铁律）。字段细节与升级规则读 `references/field-schema.md`；模仿文档形态读 `references/example-visual-split.json`（《过拟合》20-beat 金样，机器 JSON）与 `references/example-visual-split.md`（同一金样的人读版式参照）。

## 三条铁律（先记死，再动手）

1. **只引用视图里存在的 utterance id**：beat 的文稿范围 = `span:{from:"u0007", to:"u0011"}`（utterance id 区间）。id 必须来自 `gtrk split --project` 导出的投影视图，**不许臆造**（`u9999` 一定被硬拒）。
2. **绝不抄原句文字作定位**：旧版用「前锚点……后锚点」原文片段定位——**已退役**。锚点文字会诱发幻觉、会和实拍漂移。一律用 id 区间。
3. **绝不自造/推算任何时码**：拆分稿里**不写任何秒级时码字段**。轨道时码由 `gtrk split` 落地时现场投影写入 `struct_meta.split` / `dispatch.json`。你只管语义（lane / 叙事功能 / handoff），时间线交给 CLI。

## 前置：确认工程 + CLI

- 需要一个 **oralcut 产物目录**（跑过 `gtrk oralcut` 得到的目录），里面有 `gtrk/project.gtrk` 与 `transcript/transcript.json`。没有 transcript（旧任务）→ 让用户用新版本重跑 `gtrk oralcut`（恒出 transcript）。
- `gtrk` 命令找不到 → 让用户装 `npm i -g @gitruck/cli@latest`。
- 用户可以先在客户端手调切点再保存——**每次拆分都基于「发起那一刻」的时间线投影**，所见即所得。

## 完整流程（取视图 → 拆分 → 落地 → 修正循环 ≤3 轮）

### 1. 取投影视图（你的唯一创作输入）

```bash
gtrk split --project "<oralcut产物目录>" --json
```

- 产 `<目录>/split/view.json` 并在 stdout 回一行结果 JSON。**读 `view.json` 文件**（大稿更稳），不要只解析终端。
- 视图结构：`{transcript_hash, projected_at, utterances:[{id, text, track_st, track_ed, dropped, kept_words, total_words}]}`。
  - `id` = 你要引用的 utterance id（如 `u0007`）。
  - `text` = 该句文字（**只用来读懂内容、判断在哪切 beat**，绝不复制进拆分稿）。
  - `dropped:true` = 这句在当前时间线上已被剪掉——**别把它划进任何 beat 的 span**（划了落地会跳过/收缩）。
  - `track_st/track_ed` = 轨道时码（**只读，帮你感知节奏/时长**，不要抄进拆分稿）。
- **透传 `transcript_hash`**：拆分稿的 `transcript_hash` 必须原样等于视图里的 `transcript_hash`（hash 链，错版硬拒）。

### 2. 通读全片，按视觉职责切 beat

按下面「拆分方法论」把连续的 utterance 分成若干 beat。一个 beat 覆盖**连续的 id 区间**（可跨多句），但**不能跨前后两处拼接**。beat 之间允许留空隙（未覆盖段默认 A_ROLL 底轨直出），**不许重叠**。

### 3. 写拆分稿 JSON

按 `references/field-schema.md` 的契约写。骨架：

```json
{
  "contract_version": "v1",
  "transcript_hash": "<原样透传视图里的 transcript_hash>",
  "beats": [
    {
      "id": "B01",
      "span": { "from": "u0001", "to": "u0003" },
      "base_track": "真人出镜",
      "lane": "A_ROLL",
      "narrative": "mirror-hook",
      "container_stage": "none",
      "rhythm": "平稳 -> 停顿",
      "visual_task": "主持人直视镜头带观众做实验",
      "irreplaceability": "必须真人出镜",
      "aux_layers": [
        { "type": "quote-card", "mount": { "from": "u0001", "to": "u0002" }, "role": "金句提炼", "necessity": "强建议" }
      ]
    }
  ],
  "queues": { "a_roll": [], "rrv_mg": [], "ai_drama": [], "film_broll": [] }
}
```

关键：
- `lane` 四选一 `A_ROLL | RRV_MG | AI_DRAMA | FILM_BROLL`；`base_track` 三选一 `真人出镜 | 口播继续 | 旁白主导`。
- **handoff 按 lane 分型**（校验器会硬查）：
  - `RRV_MG` → `handoff:{slug_hint?, theme?, bg?, duration_hint}`，**`duration_hint`（秒）必填**。
  - `FILM_BROLL` → `handoff:{queries:[...非空], shots?, per_shot_sec?, exclude?}`，**`queries` 非空必填**；queries 写**英文长句场景描述**（一条一个意象，避多义动词），**exclude 保持中文**（细则见 field-schema）。
  - `AI_DRAMA` → `handoff:{narrative?, theme?, emotion_stage?, platform?, shot_count?}`，全可选（下游 ai-drama-prompter 有推断默认）。
  - `A_ROLL` → **无 handoff**（写了会被警告忽略）。

### 4. 落地校验

```bash
gtrk split "<拆分稿.json>" --project "<oralcut产物目录>" --md --json
```

- 成功：写回 `.gtrk` 的 `struct_meta.split`（投影快照）+ 产 `split/dispatch.json`（派单清单）+ `--md` 的 `split/visual-split.md`（人读稿）。stdout 回结果 JSON。
- 失败：**进程非 0 退出、stderr 打逐条错误、无任何写入**。

### 5. 修正循环（≤3 轮）

校验失败时，**按 stderr 里逐条错误（每条含 beat id + 原因）修正拆分稿并重试**，上限 3 轮。常见错误与改法：
- `span.to 引用了不存在的 utterance id u9999` → 该 id 不在视图里，换成视图里真实存在的 id。
- `区间倒序` → `from` 的 id 序晚于 `to`，对调或修正。
- `B02 与 B03 区间重叠` → 收窄其中一个 beat 的 span，让区间不相交。
- `transcript_hash 不匹配` → 转写已变更：**重新跑第 1 步导出视图**，用新 hash 重拆（别硬改 hash 蒙混）。
- `FILM_BROLL 缺检索 query` / `RRV_MG 缺 duration_hint` → 补齐对应 handoff 必填字段。

**3 轮仍失败 → 把错误原样呈给用户**，不静默降级、不绕过校验。

### 6. 回报 dispatch 摘要

落地成功后，读 `split/dispatch.json` + 结果 JSON 的 `beats`，向用户交代：
- 各车道 beat 数（A_ROLL / RRV_MG / AI_DRAMA / FILM_BROLL）。
- **被跳过的 beat**（span 内 utterance 全被剪，`beats.skipped[]`）及原因。
- **被收缩的 beat**（部分被剪、按存活句包络收窄，`beats.shrunk[]`）——提示人工复核。
- 下游各拿各的：`dispatch.rrv_mg`（RRV 槽位表，`composition_id` 已按 `<工程slug>-<beatId>` 命名）/ `dispatch.film_broll`（B-roll 检索队列）/ `dispatch.ai_drama`（AI 动画队列）。

---

## 拆分方法论（沿《实在界漫游指南》视觉语法精华）

> **词表随栏目配置**：下文的叙事功能（narrative）与容器阶段（container_stage）枚举、底轨三态，是**默认栏目《实在界漫游指南》的词表**，不是固定枚举。`gtrk split` 的校验源 = 有效栏目配置的 vocab（`--column <id>` 或 config `defaultColumn` 选取，配置文件在 `~/.gitruck/columns/<id>.json`）；别的栏目可自定义自己的叙事语法（科普=论点/论据/结论、带货=痛点/卖点/促单……），配置 `fallback.unknown_narrative="allow"` 时甚至可用纯自由串。零配置 = 默认栏目，行为与下文完全一致。lane 四车道仍是硬枚举（管线承重面），不随 vocab 放宽。

### 四车道语义（lane 四选一）

- **`A_ROLL`（真人出镜）**：信任感来自「观众看见真人正在说」。优先给：体验式钩子、立场转换、关键悬念、情绪抱持、理论升华、结尾发问。
- **`RRV_MG`（Real Roam Viz 动态图）**：主要任务是「让观众看懂结构」。优先给：容器概念展开、抽象结构翻译、多概念映射、网络/流程/关系图、容器反转、回扣时的系统动态图。
- **`AI_DRAMA`（AI 再现）**：靠「演绎一个具体历史瞬间」成立。优先给：历史事件再现、理论家/名人/时代场景的动作演绎、有明确年代·人物·地点暗示的桥段。
- **`FILM_BROLL`（影视素材）**：靠「沉浸感、情绪、现实质感」成立。优先给：日常痛感、都市情绪、社会事件氛围、关系案例沉浸——不适合 MG 讲解、也不需要历史 reenactment 的段落。

### 八叙事功能（narrative）

`mirror-hook`（镜像钩子）· `demolition`（拆解）· `container-translation`（容器翻译）· `abyssal-fall`（坠入深渊）· `holding`（抱持）· `reversal-elevation`（反转升华）· `callback-closure`（回扣收束）· `typography-emphasis`（文字强调）。按叙事职责分类，不按形状分类。

### 七容器阶段（container_stage）

若全片有「容器贯穿线」，为每个 beat 标一个阶段：`none`（未调用）· `seed`（首次登场）· `expand`（讲清容器本身）· `translate`（用容器翻译理论）· `rupture`（推向真相/谷底）· `flip`（希望面/结构反转）· `callback`（意象被重新调回）。容器线应贯穿三幕，而不是只在中间出现一次。

### 切分触发器（何时切出新 beat）

遇任一即考虑切：**主层改变** / **叙事功能改变** / **容器阶段改变** / 出现停顿·静音·金句·发问 / 解释职责从「讲感受」变「讲结构」 / 某辅助层升级为主要理解入口。**不要因一个逗号句号就切——只在视觉职责变化时切。**

### 辅助层七类（aux_layers）

`quote-card`（金句卡）· `term-callout`（术语解释）· `network-diagram`（关系图）· `archive-caption`（档案标注）· `pause-card`（停顿卡）· `data-annotation`（数据标注）· `timeline-tag`（年份/时间标注）。辅助层不是装饰，是补充理解职责。挂载范围三型：`"same_beat"`（同 beat）/ `{from,to}`（id 区间）/ `{trigger:"uNNNN"}`（触发点）。

### 升级规则（辅助层 → 主层）

辅助层满足任一条件时，**别再当辅助层**，切出下一个 beat 并把它升级为新 `lane` 主层：连续 2-3 秒成为主要理解入口 / 视觉上占据主体 / 观众看不到它就无法理解当前论证。前文意象在后文被重新调用时，**不要合并两段文稿**——在后文 beat 里写 `callback_of:"B07"`。

## 自检（落地前）

- 有没有机械按句号切？（只在视觉职责变化时切）
- 有没有任何 beat 同时承担两种主职责？（一个 beat 只允许一个 lane）
- 有没有把本该真人承接的段落全交给 b-roll？
- span 里有没有混进 `dropped:true` 的句子？（会被跳过/收缩）
- beat 之间有没有重叠？id 区间有没有倒序？
- FILM_BROLL 有没有 queries？是不是英文长句场景描述（不是中文/关键词堆叠）？exclude 是不是中文？RRV_MG 有没有 duration_hint？
- `transcript_hash` 是不是原样透传自视图？
- 拆分稿里有没有混进任何秒级时码字段？（必须零时码）
