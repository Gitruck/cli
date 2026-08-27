---
name: gtrk-voiceover
description: 通用配音视频创作图纸（配音链快速成片预设）——写好的稿子（或让 AI 代写）→ 配音 → 自动配画面 → 字卡/BGM/字幕 → 客户端可出片工程。适用素材为叙事服务、无自带时序的题材：知识科普、情感电台、观点输出、带货文案、盘点合集。当用户想「拿这篇稿子出条片 / 帮我写稿配音做成视频 / 科普视频 / 情感文案视频 / 把文字变成视频」时使用本图纸。素材自带时间线的解说类（旅拍/影视/游戏/探店）走 gtrk-narration，别用本图纸硬套。
---

# gtrk-voiceover（通用配音 · 配音链快速成片预设）

把**一段文字**（你写的或 AI 代写的）变成**一条配好画面的成片工程**：稿 → 检查点①一次拍板 → 配音 → 建工程 → 配画面 → 字卡 → BGM → 字幕 → 客户端出片。

> **定位**：配音链的快速成片预设（structure 级图纸，不新增命令）。**素材为叙事服务**——
> 画面是插画，纯语义匹配，无时序义务；素材自带时间线的题材（旅拍/影视/游戏/探店）按判据
> 属解说链，转 `gtrk-narration`。通用框架层（三段式写稿规约/文风铁律/自校验）正本在
> `gtrk-travel-recap` §三，原样继承；双模式与决策前置见《成片型图纸公约》。**CLI 是手，你是脑。**

## 一、输入契约与开工五问

**输入**：稿件（txt/md，可无——AI 代写）± 本地素材夹 ± BGM 音频。

| # | 问 | 怎么取证 | 决定什么 |
|---|---|---|---|
| ① | 稿从哪来 | **问用户**：已有稿 / AI 代写（代写要主题与调性） | 代写按通用框架层三段式 + 文风铁律，写完进检查点① |
| ② | 画面素材从哪来 | **问用户，MUST NOT 硬塞**：本地素材夹（要路径）/ 平台素材库 / 两者混用 | 配音链里平台库是一等来源（与解说链相反）；本地夹先 `gtrk matrix index` |
| ③ | 画幅 | 按投放平台问 | 画布（B 站横屏 / 抖音竖屏） |
| ④ | 音色 | catalog 语义检索给候选，**附试听链接** | TTS `--speaker` |
| ⑤ | BGM 与字幕样式 | 自备给文件；没有搜候选附试听；字幕不挑走默认不追问 | `audio lay` / `subtitle lay` 拍板值 |

一张表一次问完；**未经检查点①确认 MUST NOT 发起 TTS 计费动作**。

## 二、快速成片编排

```bash
# ①② 写稿（三段式通用框架层 + 文风铁律自校验）→ 检查点①拍板
gtrk matrix material "<情绪 调性 检索词>" --scope audio --top-k 5 --json   # BGM 候选附试听

# ③ 配音 → 建工程
gtrk tool audio_tts_clone --text-file <稿.txt> --speaker <voice_id> --json
gtrk project init --tts-task <TTS任务id> --canvas <WxH> --no-open --json

# ④ 拆分派单 → 配画面（纯语义：平台库走云端检索，本地夹加 --local --dirs）
gtrk split --project "<工程>" --json && gtrk split "<拆分稿>" --project "<工程>" --json
gtrk matrix --project "<工程>" [--local --dirs "<素材夹>"] --lay 0 --json
gtrk matrix describe --plan "<工程>/split/broll-plan.json" --yes --json
gtrk matrix lay --project "<工程>" --mark-weight 0.3 --gap-fill fast --json

# ⑤⑥⑦ 字卡 → BGM → 字幕
gtrk mg --project "<工程>" --json
gtrk audio lay --project "<工程>" --file "<bgm>" --volume 0.1 --beat-align --json
gtrk subtitle lay --project "<工程>" --style <样式> --color <色> --json
```

配方口径（mark-weight 0.3 / BGM 0.10 宁低勿高 / gap-fill fast / 句界吸附缺省）与旅拍图纸 §五 同源，引用不复制。派单车道按内容走（FILM_BROLL 为主，可派 MG / AI 再现——AI 再现描述稿走 `/gtrk-ai-drama`，外部平台出片手动回铺）。

## 三、检查点①（必停一次）

稿件全文 + 画幅 + 音色（试听）+ BGM（试听）+ 字幕样式，一屏给齐一次拍板。改稿在这站改到满意——配音之前全部免费。

## 四、MG 风格（公约 §三 执行文本）

有栏目风格 skill 走栏目；没有则按**当下这片的内容**临场泛化一套自洽风格全片贯彻（配色/字体气质/动效克制度与调性绑定），MUST NOT 逐颗粒各自为政，也 MUST NOT 拿固定模板死板套片。

## 五、双模式

| 模式 | 停点 |
|---|---|
| **快速成片**（默认） | 开工五问 → 检查点①（必停一次）→ 一杆到底 |
| **逐步推进** | 每步停等确认（稿 / 拆分稿 / 候选画面 / 字卡 / BGM / 字幕逐项） |

## 六、计费与排错

- 计费大头 = TTS 按字数（跑前实时价格原样转述）；平台库检索/理解按矩阵成员口径，运行时打印为准。
- 素材夹索引、拆分、铺排、字幕纯本地零计费。
- 排错回各零件 skill（`gtrk-matrix` / `gtrk-mg` / `gtrk-transcript` / `gtrk project --help`），本图纸不搬；文风与写稿症状按 `gtrk-travel-recap` §三 通用框架层自校验清单处理。
