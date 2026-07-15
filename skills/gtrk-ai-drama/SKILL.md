---
name: gtrk-ai-drama
description: AI 再现分镜稿生成器——把成片 SOP 第⑤步分到 AI_DRAMA 车道的 beat，逐个产**四段朴素描述（故事背景 / 角色 / 分镜 / 原文文稿）+ 独立视觉基调段 + 时长预算**，中英双版，可直接拿去任意外部 AI 漫剧管线（可灵 / 即梦 / Vidu / Veo / Runway / LTX / 本地开源，或 LibTV / OiiOii / TapNow 这类成片 agent 平台）上手用。这是**纯创作 skill、无 gtrk 命令**（产物即描述文本、出片在外部平台、用户手动拼回，同 /gtrk-style-maker）。当用户想「上 AI 再现 / 做 AI 分镜 / AI 动画描述 / 把这段做成 AI 视频 / 给这段配 AI 再现 / 弗洛伊德这段怎么做视频」时使用本 skill。通用拆镜 craft（蒙太奇段分层 / 四段描述结构 / 中英双语 / 时长预算）由本 skill 自持；栏目视觉 DNA（Style Lock）从栏目配置 style.skills 里 produces==AI_DRAMA 的条目解析注入，绝不硬编某栏目风格。凡把口播派单里 AI_DRAMA 段落转成可出片的描述稿，优先用本 skill，别手搓。
---

# AI 再现分镜稿生成器（gtrk-ai-drama）

把口播派单里分到 **`AI_DRAMA` 车道**的 beat，逐个拆成分镜、为每个 beat 产 **四段朴素描述 + 独立视觉基调 + 时长预算**（中英双版），落到 `<project>/ai-drama/<beat_id>.md`，再交棒用户拿去任意外部平台出片、手动拼回时间线。

> **这是纯创作 skill、没有 gtrk 命令**——AI_DRAMA 车道的产物就是**描述文本本身**，出片在外部生成平台、拼回时间线由用户手动做，没有确定性机械尾巴可下沉成 CLI 命令（性质同 `/gtrk-style-maker`）。所以「脑」是你（拆镜 + 注入栏目风格 + 管用户交互），「手」在外部平台和用户手里，不是 gtrk。别去找 `gtrk ai-drama` 这条命令，它不存在也不该存在。

## 为什么是「四段朴素描述」而不是「平台优化提示词」

因为**责权利要清**：无论用户拿去哪个管线，一致性的可移植载体是**角色/场景描述**，不是某平台的提示词语法（"assets model-agnostic, prompts model-specific"）。而且下游 agent 成片平台（LibTV / OiiOii / TapNow 等）拿到分镜稿会**自己重拆分镜、重写 prompt**，角色圣经（三视图）也在那些产品里生成——所以本 skill **不产平台优化提示词、不产角色圣经、不产参考图、不产成片**，只产四段可移植描述 + 视觉基调 + 时长，把「怎么出片、怎么保角色一致」交给下游平台，把「拼回时间线」交给用户。

## SOP 定位：第 ⑤ 步，最后上

成片是**有序 SOP + 用户检查点**，不是并行一把铺。次序（有理由：越往后叠得越上层）：

> ① oralcut 剪口播 → ② split 视觉拆分派单 → ③ **matrix 先铺 B-roll（定底层）** → 用户 opencut 调整/挑选确认 → ④ **mg 铺 MG（叠在 B-roll 之上）** → ⑤ **本 skill 上 AI 再现（叠在最上层）** → `gtrk render` 收口

本 skill 是**第 ⑤ 步、最后一层视觉**。前面 B-roll、MG 都铺完、用户确认后才轮到它；它产完描述、用户拿去外部平台出片、AI 片段手动回铺齐，就该交给 `gtrk render` 出片——后面没有别的车道了。

## 三条铁律（先记死）

1. **业务分离：通用 craft 归本 skill，栏目风格从配置解析。** 本 skill 只持**对任何栏目都通用的拆镜工艺**（蒙太奇段分层、四段描述结构、中英双语、时长预算）。**栏目专属的视觉 DNA / Style Lock（底色、单点强调色、影视参考锚点、材质、禁令）从有效栏目配置解析注入**（见下节），**绝不硬编某栏目风格**——尤其别把《实在界漫游指南》那套「黑白二元 + 单点朱红」当默认塞给所有人，那是它的栏目资产，该从配置来。未绑 AI_DRAMA 风格资产的栏目 → 用本 skill 的**中性默认**兜底。
2. **只产描述，不产成片、不产角色圣经、不产参考图。** 本 skill 的交付物是四段可移植描述文本。出片（渲染成视频片段）、角色三视图/角色圣经、参考图，全在下游平台或用户手里。不要假装能帮他渲染或建角色资产。
3. **中英双版地位平等，不是主辅。** ①视觉基调、②故事背景、③角色、④分镜四段每一段都给完整的中文版 + 英文版（不是把中文翻一句了事）。中文喂可灵 / 即梦 / Vidu / 通义，英文喂 Veo / Runway / LTX / Luma，用户按目标平台选。**唯独 ⑤ 原文文稿是中文口播原文、不翻译**（它是源真相 + 手动拼接的对位锚，翻译反而失真）。

## 业务分离：栏目 Style Lock 从哪来（关键）

**视觉风格不是本 skill 预设的，是从栏目配置里解析出来的。** 解析链路（与 `gtrk-splitter` 的车道→生产 skill 解析同源）：

1. **定位有效栏目**：用**与该工程 split 时相同的栏目**——用户 `--column <id>` 指定，或本地 config 的 `defaultColumn`；配置文件在 `~/.gitruck/columns/<id>.json`。本 skill 无 gtrk 命令，**直接读这个 JSON 文件**（同 `/gtrk-style-maker` 的做法）。
2. **取 AI_DRAMA 生产条目**：读 `style.skills[]`，逐条把 `produces` **归一**（历史别名如 `RRV_MG→MG` 等按归一规则处理），取 `produces == "AI_DRAMA"` 的条目。
   - 命中 → 拿它的 `ref`（指向一个 skill 目录/资源）→ **读该 skill 的 Style Lock / 风格资产**（通常是它 `references/` 下的 style-lock、theme-accent、影视参考锚点等），把其中的**底色 / 单点强调色 / 影视参考 / 材质 / 栏目禁令**当作本次生成的视觉 DNA，注入 ①视觉基调段与各描述。
   - 条目声明 `routing:"none"` → 跳过（显式管线外）。
   - **无 AI_DRAMA 匹配条目 = 该栏目没绑 AI 再现风格资产** → 用下面「中性默认」。
3. **注入，不臆造**：读到什么风格资产就用什么；**没读到就用中性默认，绝不凭栏目名猜风格、绝不套用别的栏目的调性**。

> 举例（仅示意解析机制，非硬编）：`real-roam-guide` 栏目配置里 `style.skills` 有一条 `{produces:"AI_DRAMA", ref:"…/ai-drama-prompter"}` → 解析到它 → 读它的 style-lock（黑白单红那套）注入。换个栏目、换个 ref，注入的就是另一套风格。**本 skill 正文里不写死任何一套具体风格。**

## 前置与输入

- **需要一个 split 落地过的工程目录**：里面有 `split/dispatch.json`（`gtrk split` 产物）。没有 → 先回 `/gtrk-splitter` 拆分派单。
- **消费 `dispatch.ai_drama[]`**：读 `<project>/split/dispatch.json` 的 `ai_drama` 数组。每条形如 `{beat, narrative?, theme?, emotion_stage?, platform?, shot_count?, track_st, track_ed}`：
  - `narrative / theme / emotion_stage / platform / shot_count` **全可选**，缺则按文稿内容与位置**推断**（推断出的值在元信息处标注「推断」）。
  - `track_st / track_ed` = 该 beat 在时间线上的起止秒，**给你时长预算**（据此定区间总时长、蒙太奇段数、各镜建议秒数；本 skill 不改时码、只读）。
- **也接单段直投**：用户直接甩一段文稿 + 「把这段做成 AI 视频」时，无需 dispatch，把这段当一个 beat 走同一套工艺即可（落用户指定处或 `<cwd>/ai-drama/<自拟标题>.md`）。
- **文稿内容从哪读**：dispatch 条目带 `beat` id，对应文稿去投影视图 / transcript 里按该 beat 的 span 读原文（读懂内容拆镜、并抄进 ⑤ 原文文稿区块）。用户直投时用他给的文本。

## 通用 craft（本 skill 自持，任何栏目通用）

### A. 蒙太奇段分层拆镜

1. **1 镜 = 1 情感颗粒**：同一个动作不切两镜；情绪转折必须切镜。
2. **每镜 3–8 秒**：短于 3 秒观众来不及呼吸；长于 8 秒 AI 视频模型会塌（人物表情 / 手部漂移）。
3. **长文段拆蒙太奇段**：一个 AI_DRAMA beat 可能覆盖很长一段文稿、含多个场景/情境。此时**先拆蒙太奇段**（每段锚一个场景/情境），**段内 3–6 镜**按情感颗粒切、**段间可换场**。镜数上限按**段级**判定，**不再因整段总镜数超 6 就回退 splitter**——长区间整段做 AI 再现是合法创作，不是拆分错误。
4. **切分触发器**（任一出现才考虑切）：时间 / 空间改变、主体改变（例：理论家 → 当事人）、抽象概念登场（从「人物戏」切到「象征物戏」）、情绪转折（安静→刺点 / 爆发→凝滞）。**不要因一个句号、一个逗号就切。**
5. **控整体不控单镜**：你对**区间总时长**负责（各镜建议秒数之和量级贴合 `track_st→track_ed`），但不必把每一镜的秒数抠死——AI 平台交付本就不保证逐帧准，最终由用户手动拼时对齐区间。

### B. 视觉基调：独立成段 + 融入各描述（一源多处）

视觉基调**既独立成段（作权威源），又融入各描述（防漂）**：

- **① 独立段（权威源）**：把解析到的栏目 Style Lock 写成完整一段（底色 / 中性调 / 单点强调色 / 材质 / 影视参考 / 禁忌），60–120 字/词，CN + EN。这是权威源，供各分镜复述。
- **融入 ② 故事背景**：末句锁整段色调（「整段以……色彩与质感呈现」）。
- **融入 ③ 角色**：每角色一句质感落点（他在这套调子里长什么样、那点单点强调色落在哪个道具上——书脊 / 印章 / 丝带 / 封蜡，别做成环境光 / 滤镜 / 背景色）。
- **融入 ④ 分镜**：**每镜前缀复述一句**视觉基调（AI 视频模型健忘，不复述必漂色）。

### C. 中英双版结构（中英分离落盘 + EN 的强制调整）

**中英分块、不逐段交错**：产物分成两大块——先一整块**中文稿**（元信息 + ①②③④ 中文 + ⑤ 原文文稿），再一整块 **English Storyboard**（① Style Lock + ②③④ 英文）。这样用户按目标平台**整块复制**：中文平台（可灵 / 即梦 / Vidu / 通义）拷中文稿、英文平台（Veo / Runway / LTX / Luma）拷英文稿，不用逐行挑出中/英。**别在每个小节里 `【中文】…【EN】…` 交错**（那样复制粘贴要一句句抠）。

英文块不是直译，要做这些原生化：
- **摄影术语用英文原生词**：push-in / dolly-in、pull-back、tilt-up、lateral pan、rack focus、chiaroscuro、key/fill/rim light、practical light；景别 extreme close-up … extreme wide；焦段 35mm anamorphic / 50mm spherical / 85mm portrait。
- **年份用英文格式**：`Vienna, 1920`，不是 `1920 年维也纳`。
- **人名用英文原名**：`Sigmund Freud` / `Lacan`，不是拼音。
- **影视参考用英文片名**（斜体）。
- **⑤ 原文文稿只在中文稿里、不翻译**：逐句列中文口播原文即可，英文块不含它。
- **元信息只写一次**（放最前），中英两块不重复；每镜的「建议秒数 / 段 / 场景 / 角色 / 对应原文句」表头行在中/英两块各写各自语言的一份。

### D. 时长预算

- **元信息给区间总时长**：`track_ed - track_st`，据此定蒙太奇段数与建议分镜数。
- **④ 每镜给建议秒数**：各镜秒数之和量级贴合区间总时长。
- **定位：意图值，不是精确交付保证**。多数平台由参数控时且不保证逐帧精确（各平台 fps 也不一），提示里写死秒数无用；把时长放**元信息 + 每镜建议秒数**，最终对齐在用户手动拼接那一步完成。
- **时码只读不改**：本 skill 不写回 dispatch / struct_meta，只读 `track_st/track_ed`。

## 工作流

**Step 1 · 通读该 beat 文稿**：判有无历史/时代锚点（年份 / 地点 / 人物 / 事件）、主体是谁、情感落点在哪、叙事功能与阶段。dispatch 缺的参数在此推断并标注「推断」。

**Step 2 · 拆蒙太奇段与镜**：按 craft A 判是否长文段需分蒙太奇段，段内按情感颗粒切镜，定各段镜数（文稿长度 × track 时长双校准）。

**Step 3 · 锁风格**：按「业务分离」节解析栏目 Style Lock（读配置 → 取 produces==AI_DRAMA 条目 → 读其风格资产）；无则取中性默认。组装成 60–120 字/词的 CN + EN 双语 ①视觉基调段。

**Step 4 · 写四段描述（中英分块）**：先出**中文稿**（② 故事背景末句锁调 → ③ 角色结构化 + 禁变项 + 质感落点，复现理论家 pin 复用同段文字 → ④ 分镜每镜前缀复述基调 + 建议秒数 + 对应原文句 + 蒙太奇级意图 → ⑤ 原文文稿中文逐句不翻译），再整块出 **English Storyboard**（① Style Lock + ②③④ 英文原生化，不含 ⑤）。中英**分两大块、不逐段交错**（craft C）。

**Step 5 · 落盘**：写到 `<project>/ai-drama/<beat_id>.md`（一 beat 一文件，靠 beat id 认得是哪段、互不覆盖）。用户直投单段时落到用户指定处或 `<cwd>/ai-drama/<自拟标题>.md`。

## 输出契约（落盘 Markdown 结构 · 中英分块）

顶部放一次责权利声明 + 元信息（不分语言）；然后 **`## 一、中文稿`** 一整块、**`## 二、English Storyboard`** 一整块，用户整块复制。

```
# AI 再现分镜稿 · [自动标题]（beat <beat_id>）

> [责权利声明：本稿只描述意图与时长；角色一致性依赖下游角色资产机制；出片/拼回在用户手里]

## 元信息
- 区间总时长：track_st→track_ed ≈ X 秒
- 建议分镜数：N 镜（含 M 个蒙太奇段）
- 复现角色：<角色名>（栏目级·pin 复用 / 本片新建）…
- 叙事功能 / 情感阶段：xxx（用户指定 / 推断）
- 目标平台：xxx（缺省 = 通用）

======================================================================
## 一、中文稿（喂可灵 / 即梦 / Vidu / 通义）
======================================================================

### ① 视觉基调（Style Lock）
> 权威源，供各分镜前缀复述。来源：<解析到的 ref skill> / 中性默认
[底色 / 中性调 / 单点强调色 / 材质 / 影视参考，60–120 字]
> 禁忌：[通用 AI slop 兜底 + 栏目专属禁令]

### ② 故事背景描述
[时代 / 地点 / 世界观 / 场景。末句锁调：整段以……色彩与质感呈现。]

### ③ 角色描述
#### <角色名>（栏目级·pin / 本片新建）
脸型 / 发型 / 瞳色 / 服装 / 标志物 + 禁变项（不留长发、不换西装…）+ 一句质感落点。

### ④ 分镜描述
#### 分镜 01 · [标题] ｜建议 ≈Xs ｜段：<蒙太奇段名> ｜场景：xxx ｜角色：xxx ｜对应原文：第 a–b 句
〔视觉基调前缀复述一句〕+ 主体在做什么具体动作 + 蒙太奇级镜头意图（不逐帧硬控）。
#### 分镜 02 · …

### ⑤ 原文文稿（本区间口播原文，不翻译）
1. [第一句中文原文]
2. [第二句中文原文]
…

======================================================================
## 二、English Storyboard (for Veo / Runway / LTX / Luma)
======================================================================

### ① Visual Tone (Style Lock)
> Authoritative source; restated as a prefix in every shot. Source: <resolved ref skill> / neutral default
[palette / neutrals / single accent / texture / film references]
> Avoid: [generic AI slop floor + column-specific bans]

### ② Background
[era / place / world / setting. Closing line locks palette & texture.]

### ③ Characters
#### <name> (column-pinned / new to this film)
face / hair / eyes / wardrobe / signature prop + do-not-change + one line on how they render in the tone.

### ④ Shots
#### Shot 01 · [title] ｜≈Xs ｜segment: <montage segment> ｜scene: xxx ｜cast: xxx ｜source lines: a–b
〔restate style prefix〕+ subject's concrete action + shot intent (montage-level, not frame-locked).
#### Shot 02 · …
```

> ⑤ 原文文稿只在中文稿里；English 块到 ④ Shots 为止。

## 中性默认（未绑 AI_DRAMA 风格资产时）

栏目配置里**没有 produces==AI_DRAMA 的条目**时，别停、别硬套别的栏目，用这套克制、通用、不特化任何栏目的兜底写 ①视觉基调段：

> **中性 Style Lock**：影视级自然主义画面，真实可信的光源（窗光 / 实用光 / 自然天光，不炫技），克制稳定的镜头语言（固定或缓慢推拉摇，无手持抖动 / 无广告级动态运镜 / 无无人机炫技），近单色到低饱和的克制调色（不追 HDR、不追霓虹），胶片颗粒质感。忌塑料 3D 渲染、忌动漫二次元、忌过度戏剧化打光。
> **EN**: Cinematic naturalism, believable practical light sources (window / practical / natural daylight, no showing off), restrained stable camera language (locked or slow dolly/pan/tilt, no handheld shake, no ad-grade dynamic moves, no drone stunts), near-monochrome to low-saturation restrained grade (no HDR, no neon), visible film grain. Avoid plastic 3D render, anime, and over-dramatic lighting.

中性默认下**不设单点强调色 / 不指定影视导演锚点**（那些是栏目资产）。用完顺带提醒用户：**想要这条栏目有自己的 AI 再现视觉 DNA，去 `/gtrk-style-maker` 沉淀一套 AI_DRAMA 风格资产并登记进 `style.skills`**，之后每次生成都会自动注入。

**禁忌行**（写进 ①）分两层：
- **通用 AI slop 兜底（本 skill 自带，任何栏目都写）**：glossy 3D render / plastic skin、HDR look / oversaturated、generic AI anime / saccharine、deformed face / extra fingers / mutated limbs、text overlay / captions / 字幕（字幕剪辑阶段另做）、heavy lens flare / chromatic aberration、cartoon / low-res / unfinished。
- **栏目专属禁令（从 Style Lock 追加）**：栏目风格资产里写明的禁令（如某栏目「禁多个红点 / 禁渐变 / 禁霓虹」）追加进来。无风格资产则只留通用兜底。

## 责权利边界声明（写进产物顶部或末尾）

产物要**显式声明责权利**，让用户拿去任何管线都心里有数：

> **本稿只描述意图与时长。** 角色一致性依赖**下游管线自带的角色资产 / 参考图机制**（角色圣经 / 三视图在下游产品里生成）——把本稿的角色描述喂给有角色资产库的平台（可灵主体库 / OiiOii 角色设定表 / LTX Elements / LibTV 三视图 等），一致性由它保。若喂给**没有角色资产机制的裸文生视频 API**，角色会逐镜漂脸——那是该管线的短板，不是本稿的责任。出片、拼回时间线，都在你手里。

## 交付前自检

- [ ] 五区块齐备（元信息 + ①视觉基调 + ②故事背景 + ③角色 + ④分镜 + ⑤原文文稿）？
- [ ] 每镜有**明确主语 + 明确动作**？（没有就退回）
- [ ] 是**真的按情感颗粒切镜**，不是按句号切？长文段拆了**蒙太奇段**、段内 3–6 镜、段划分合理？
- [ ] 视觉基调**独立成段（权威源）**，且**每镜前缀都复述**、②末句锁调、③每角色一句质感落点？
- [ ] 中英双版范围对：①②③④ 都双写、**⑤ 原文中文不翻译**？EN 做了原生化（术语 / 年份 / 人名 / 片名）？
- [ ] 底色 / 强调色 / 影视参考**取自栏目 Style Lock**（或明确用了中性默认），**没有硬编某栏目风格**？强调色**是道具化**（不是环境光 / 滤镜）？
- [ ] 时长预算入元信息（区间总时长 + 建议镜数）、每镜有**建议秒数**、各镜之和量级贴合区间？
- [ ] 禁忌行含**通用 slop 兜底**（无论栏目）+ 栏目专属禁令（有资产才加）？分镜区块内没有每镜独立负面词组？
- [ ] 复现的理论家标了 **pin·同段文字复用**、含**禁变项**？
- [ ] 缺省参数都**标了「推断」**、落盘文件名带 beat id、责权利边界声明在？

## 交棒下一步（SOP 收口，别停在交描述）

描述稿落盘后**别收工**，把接力讲清（但这一步的「手」在外部平台和用户手里、必须停下等用户）：

1. **交代出片**：让用户拿 `<project>/ai-drama/<beat_id>.md` 里的描述，去任意外部平台出片——中文版喂可灵 / 即梦 / Vidu；英文版喂 Veo / Runway / LTX / Luma；本地开源（Wan / Hunyuan 等）或成片 agent 平台（LibTV / OiiOii / TapNow）皆可，按下游平台的角色资产机制上传角色描述保一致。
2. **回铺时间线**：出好的 AI 片段**由用户手动**拖回 opencut 的 **AI_DRAMA 车道**，对齐该 beat 的 `track_st→track_ed`（叠在 B-roll / MG 之上，最上层），按区间总时长裁齐。
3. **停下等用户**：AI 出片与拼回是**外部异步、用户驱动**的——本 skill 在此停，等所有 AI_DRAMA beat 的片段都回铺齐。这是 SOP 里的用户检查点，别替他假装出片 / 回轨完成。
4. **汇合后收口**：所有车道（B-roll / MG / AI 再现）铺齐、用户确认后，**交棒 `gtrk render`** 出成片——AI 再现是最后一层视觉，render 之后成片一条龙就到终点了。

> 原则：**agent 替用户跑 CLI / 接力 skill，用户只对话**。但 AI_DRAMA 车道天然有「用户去外部平台出片 + 手动拼回」的手工环节——那部分是外部的手，无法替跑；除此之外的解析、生成、落盘、交代，全由你（脑）一次做完，别让用户自己去拼描述。
