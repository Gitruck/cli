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

> **素材类型口径（公约 §三″）**：配音链虽以平台库为一等来源，检索仍**缺省实拍向**（`--material-class real_shot`，成员口生效）；概念/意象素材只在栏目调性本身是抽象命题时启用，且由栏目配置 `broll.material_class_policy` 持有，MUST NOT 在本图纸写死。
| ③ | 画幅 | 按投放平台问 | 画布（B 站横屏 / 抖音竖屏） |
| ④ | 音色 | catalog 语义检索给候选，**附试听链接** | TTS `--speaker` |
| ⑤ | BGM 与字幕样式 | 自备给文件；没有搜候选附试听；字幕不挑走默认不追问 | `audio lay` / `subtitle lay` 拍板值 |

一张表一次问完；**未经检查点①确认 MUST NOT 发起 TTS 计费动作**。

> ⟲ **推荐面（公约 §三‴）**：问答收口时多问一句「要不要看看第三方 skill？」，不列名；题材命中场景触发词才多 1–2 句定向推（`gtrk skills recommend --scene <id> --json` 取 tier 最高者，各给一句为什么），用户追问才展开完整块；轻提加定向合计不超三句、同会话同场景只推一次、答「不要」零动作。

## 二、快速成片编排

```bash
# ①② 写稿（三段式通用框架层 + 文风铁律自校验）→ 产前六秒方案（公约 §三⁗：基于稿件首段改写钩子文案三候选 + 画面层建议 + 字卡节奏，只改开口不改事实）→ 检查点①拍板
gtrk matrix material "<情绪 调性 检索词>" --scope audio --top-k 5 --json   # BGM 候选附试听
#   ⚠️ is_copyright：1/true=可商用、0/false=**不可商用**（反直觉，MUST NOT 读成「无版权、可随便用」）。
#   ⟲ 260906 拍板：矩阵成员档**缺省搜全库**，MUST NOT 默认加 --commercial-only、也 MUST NOT 擅自剔掉
#   false 的候选；对价是推荐时 MUST 逐条带上派生位 copyright_label 的中文标签（不追问不阻塞）。
#   用户**特意说明**只要可商用 / 要商用发布 / 客户商单时，才加 --commercial-only 收紧。

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
# --beat-align 的高潮点取自 split.beats 的 narrative / container_stage（升华段 → 容器转折 → 回扣段）；
# 拆分稿没带这两个字段 ⇒ 落 0.75×全片兜底档，**CLI 会明示那是猜的**。不接受就用 --climax <轨秒> 指定。
# 两侧都够长时零平铺（恰好 1 个 clip）；不够长才按小节线平铺补齐、接缝吸附 downbeat。
gtrk audio lay --project "<工程>" --file "<bgm>" --volume 0.1 --beat-align --json
gtrk subtitle lay --project "<工程>" --style <样式> --color <色> --json
```

> **停顿太长时**：自训音色加 `--fragment-interval 0.2`（合成时就对）；云引擎音色**不支持**该参数（传了会报错，不会静默忽略），改在合成后跑 `gtrk audio tighten --project <工程>` 收紧句间停顿（纯本地零计费；只压跨句界的停顿，句内换气与原声引用段不动）。

配方口径（mark-weight 0.3 / BGM 0.10 宁低勿高 / gap-fill fast / 句界吸附缺省）与旅拍图纸 §五 同源，引用不复制。派单车道按内容走（FILM_BROLL 为主，可派 MG / AI 情景动画——AI 情景动画描述稿走 `/gtrk-ai-drama`，外部平台出片手动回铺）。

## 三、检查点①（必停一次）

稿件全文 + **前六秒方案**（公约 §三⁗ 执行文本，引用不复制：钩子文案三候选各一行 + 画面层 A_ROLL / MG 字卡 / 拼贴或 AI 片段三选一 + 字卡节奏；只改开口方式、MUST NOT 改动用户的事实与数据；答「开场照原样」= 零动作、后续不再提；先给自持方案，再一句轻提「要更多变体也可以看第三方钩子 skill」，推荐面 §三‴ 的 `hook` 场景、不列名）+ 画幅 + 音色（试听）+ BGM（试听）+ 字幕样式，一屏给齐一次拍板。改稿在这站改到满意——配音之前全部免费。拍了 MG 字卡 ⇒ §二 ④ 拆分稿里开场 beat 的 MG `handoff.theme` 写 `"opening-hook｜屏字：<拍板文案>"`；拍了拼贴或 AI 片段 ⇒ 开场 beat 派 AI_DRAMA；拍了 A_ROLL ⇒ 开场不派辅助层。

## 四、MG 风格（公约 §三 执行文本）

有栏目风格 skill 走栏目；没有则按**当下这片的内容**临场泛化一套自洽风格全片贯彻（配色/字体气质/动效克制度与调性绑定），MUST NOT 逐颗粒各自为政，也 MUST NOT 拿固定模板死板套片。

## 五、双模式

| 模式 | 停点 |
|---|---|
| **快速成片**（默认） | 开工五问 → 检查点①（必停一次）→ 一杆到底 |
| **逐步推进** | 每步停等确认（稿 / 拆分稿 / 候选画面 / 字卡 / BGM / 字幕逐项） |

## 六、计费与排错

- 计费大头 = TTS 按字数（跑前实时价格原样转述）；平台库检索/理解按矩阵成员口径，运行时打印为准。
- 素材夹索引、拆分、铺排纯本地零计费；字幕上轨零计费（拆行走云端 subtitle_line_split，0 积分留痕；离线可加 `--offline`）。
- 排错回各零件 skill（`gtrk-matrix` / `gtrk-mg` / `gtrk-transcript` / `gtrk project --help`），本图纸不搬；文风与写稿症状按 `gtrk-travel-recap` §三 通用框架层自校验清单处理。
