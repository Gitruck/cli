---
name: gtrk-travel-recap
description: 旅拍解说一站式成片图纸——输入一个旅拍素材文件夹（长视频或素材集），AI 理解素材、写三段式解说稿、一次确认后全自动跑完配音/建工程/拆分/B-roll/字卡/BGM，直达客户端可出片工程。当用户想「旅拍解说 / 旅行视频解说 / 把这条旅行长视频做成解说视频 / 旅拍素材做成片 / 长视频二创解说 / vlog 解说化 / travel recap」时使用本 skill。凡涉及把旅拍素材（自拍或网络长视频）做成中文解说成片，优先用本 skill 编排 gtrk CLI 全链，不要手搓单命令、别让用户逐步驱动。
---

# gtrk-travel-recap（旅拍解说 · 组合成片图纸）

把**一个旅拍素材文件夹**变成**一条中文解说成片工程**：理解素材 → 三段式写稿 → 检查点①一次拍板 → 配音/建工程/拆分/B-roll/字卡/BGM 全自动 → 客户端出片。

> **定位**：本 skill 是第一张 **structure 级组合图纸**——它不新增任何命令，只编排既有原子零件（transcript / matrix / project init / split / mg / audio lay / TTS 工具）。零件的参数细节以各自 skill（`gtrk-matrix` / `gtrk-splitter` / `gtrk-mg` / `gtrk-transcript`）与 `--help` 为准，**本图纸引用不复制**；但**编排次序、检查点、配方级参数**以本图纸为准。**CLI 是手，你是脑**：写稿、切 beat、挑候选信号、产字卡颗粒、管检查点，都是你的活。
>
> **本 skill 已含跑通全链需要的全部编排信息**。打样验证：2026-08-19 黄石公园 20 分钟长视频二创，双轮真机全链通过。

## 一、输入契约与双场景识别

用户给**一个素材文件夹**（或多个，逗号分隔传 `--dirs`）：

| 内容 | 必须性 | 说明 |
|---|---|---|
| 视频/图片素材 | **必须** | 一条长视频（二创）或一堆素材（原创拍摄）皆可；图片会被自动运镜成动态上轨 |
| BGM 音频文件 | 可选 | 没有就走素材矩阵搜索（见检查点①） |
| 介绍类文本（txt/md） | 可选 | 有则作写稿补充素材 |

**MUST NOT 执行任何网络下载**：网络视频二创场景下，下载动作归用户（版权责任边界）——用户给的文件夹里是什么就用什么。

**双场景识别**（决定理解编排走法）：
- **二创**：文件夹里是网络旅行长视频（通常含博主解说语音）→ 原片文案是写稿主料；
- **原创**：用户自己拍的素材集（通常无解说语音）→ 素材理解（describe）是写稿主料。
- 拿不准就 ffprobe 看时长与条数：单条 10 分钟以上大概率二创；几十条短素材大概率原创。仍拿不准，问用户一句。

## 二、全链总览（快速模式）

```
① 理解        transcript 原片（二创）/ matrix index + describe（原创）
② 写稿        三段式规约（见 §三）→ 解说稿 + 标题 + HashTag
③ 检查点①     【必停】稿件确认 · 画幅 · 音色 · BGM · 字幕样式（§四）
④ 配音        gtrk tool audio_tts_clone（≤5000 字，句级时码直出）
⑤ 建工程      gtrk project init --tts-task <id> --canvas <WxH>
⑥ 拆分派单    gtrk split 投影 → 你写拆分稿（含字卡 overlay aux）→ split 落地
⑦ B-roll      matrix --local --dirs → describe --plan → lay --mark-weight 0.3
⑧ 抽帧检查    对字卡挂点抽帧看底轨构图（gtrk-mg SOP）
⑨ MG 字卡     按 §六 轻量规约产颗粒 → mg lint → gtrk mg --project
⑩ BGM        gtrk audio lay --volume 0.2 --beat-align
⑪ 交付        客户端打开工程出片（gtrk render 仅主轨快照预览，见 §八）
```

检查点①之后一路跑完不再打扰用户（快速模式默认）；用户要精修则按 §七 逐步停。

## 三、三段式写稿规约

### 通用框架层（可移植——其他垂类图纸原样复用本层）

**结构三段式**：第一部分「钩子」抓眼球保留存 → 第二部分「干货」给内容价值 → 第三部分「升华」给情绪价值。爆款四属性贯穿：快乐+知识+共鸣+节奏。

**文风铁律**：
- 禁模板连接词：让我们/首先/然后/最后/此外 等一律不用；
- 拒翻译腔：全部短句中文语感，无欧化从句；
- **禁幼稚拟声与过度儿化**（★ 打样校准）：「轰隆隆砸下来」这类拟声，换成**真实事实**（「从九十多米高处坠进谷底，比尼亚加拉还高出近一倍」）——数字与事实比拟声词有力得多；
- **风格目标 = 与原素材旗鼓相当**：原片多吸引人，解说就得配得上——贴着原片气质走，**不加分**（加分是业务化的事，走栏目风格）**不减分**。

**成片时长 = min(内容所支撑, 素材所支撑)**：
- 内容支撑：有多少真东西说多少话，素材再多也不注水；
- 素材支撑：按「30% 图片×8 秒 + 70% 视频素材时长」估算上限，稿子在写稿阶段就按上限收敛（不要等铺轨时开天窗）；
- 折算口径：约 200-240 字/分钟（TTS 实测，语速快的音色偏 270）。3 分钟成片 ≈ 700-800 字。

**写后自校验清单**（逐项过，不过重写）：
- [ ] 三段结构完整、时长在 min 公式内
- [ ] 禁词零命中、无翻译腔、无幼稚拟声
- [ ] **重复字/错字扫描**（★ 打样实锤：「下瀑布瀑布」重复字 TTS 会照念）
- [ ] 事实矫正：转写稿的明显错误（如数量级离谱的数字）按常识矫正或模糊处理，不确定的不引用
- [ ] 解说序 ≈ 素材序（二创场景：按原片游览顺序写，B-roll 时间窗天然可用）
- [ ] 同批产出：标题 3-5 个（≤30 字）+ HashTag 3-5 个

### 旅拍要素层（垂类专属）

- **钩子要素**（第一部分重点找）：贵大奇多 / 热门 IP / 名人名著 / 知名历史事件 / 全球 TOP 榜 / 奇闻轶事 / 脍炙人口；
- **干货要素**（第二部分）：攻略 tips / 游览流程 / 干货&经验 / 旅途见闻，幽默口吻、隔几句一个梗（谐音/反转/无厘头），在精不在多；
- **升华笔法**（第三部分）：思考/感悟/启发/感动，正能量收束；第一人称历数、物象隐喻收尾都是成熟笔法；
- 有文化衍生空间（历史典故/风俗人文）可适当发挥，但以原素材内容为锚。

## 四、检查点①（双模式共有，必停）

写完稿**必须停下**，把以下五项一次给用户拍板。**未经确认 MUST NOT 发起 TTS 计费动作**。

1. **解说稿 + 标题**：正文全文贴给用户（不是给路径），标题候选列出；
2. **画幅**（★ 打样事故教训——横屏素材铺进默认竖屏画布=信箱黑边）：问目标平台——横屏 B 站/西瓜=1920x1080，竖屏抖音=1080x1920。**素材几何与画幅不一致时明确提示**（横素材→竖画布会裁切或留边）；
3. **TTS 音色**：拉 catalog（`GET {apiBase}/task/tts/voices`，免鉴权）按内容调性挑 2-4 个候选，**每个附试听链接**（catalog 的 audition_url 字段，api.ai-mcn.tv:9000 静态直链）——用户在对话框里直接点开听。internal 标注的音色注明「仅内部成员」。也可按用户描述语义挑（「要个温柔女声」）；
4. **BGM 处置（双来源）**：
   - 用户有本地音乐 → 询问是否 `gtrk tool audio_separation` 伴奏分离后取伴奏（缺省建议分离——TTS 配音不与歌曲人声打架）；
   - 用户未提供 → **搜同和素材矩阵**（`POST {apiBase}/task/material_search`，`{scope:"audio", query:"<按稿件情绪+地理文化写>", top_k:4, diversity:true}`，1 积分/次）推荐 3-5 首、**每首附试听链接**（返回的 download_url）；`audio_type:"pure"` 纯音乐直接用，`"song"` 直接取返回的 `accompaniment_url` 现成伴奏（零处理成本）；注意曲长 vs 成片时长（audio lay 不循环，短曲只垫前段）；
   - **试听链接义务（MUST）**：音色与 BGM 的推荐没有试听链接=未完成推荐。
5. **字幕样式**：同合云 8 种字幕样式挑选（客户端字幕支持落地后启用此项；未落地期间如实告知字幕暂缺）。

## 五、快速模式逐步编排（打样验证过的真实命令）

```bash
# ① 理解（二创：转写原片，--json 顺产 transcript.json 备用）
gtrk transcript "<原片>" --lang <原片语言 en-US/zh-CN> --json
# 原创场景改跑：gtrk matrix index --dirs "<素材夹>" && gtrk matrix describe --materials ...

# ②③ 写稿（你执笔，§三规约）→ 检查点①拍板

# ④ 配音（音色 code 用 catalog 的 voice_id；稿子存 txt 传 --text-file）
gtrk tool audio_tts_clone --text-file <稿.txt> --speaker <voice_id> --json

# ⑤ 建工程（画幅按检查点①拍板；产物目录含 gtrk/transcript/audio）
gtrk project init --tts-task <TTS任务id> --canvas 1920x1080 --no-open --json

# ⑥ 拆分：先投影拿句表，再写拆分稿，再落地
gtrk split --project "<工程目录>" --json          # 投影：拿 utterance id/时码/hash
# 你写 split/visual-split.json：beat 全覆盖（配音工程无 A-roll 画面，留隙=黑屏！）、
#   lane 全 FILM_BROLL、base_track="旁白主导"、narrative 用八枚举、
#   字卡挂 aux_layers type:"overlay"（handoff.category:"overlay"+duration_hint，进 dispatch.mg）
gtrk split "<拆分稿>" --project "<工程目录>" --json

# ⑦ B-roll 三连（describe 给字卡抽帧检查与 mark 加权供料；internal 用户 describe 免费）
gtrk matrix --project "<工程目录>" --local --dirs "<素材夹>" --lay 0 --json
gtrk matrix describe --plan "<工程目录>/split/broll-plan.json" --yes --json
#   ↑ describe 结果里的 usable_flags 由你裁定（text_overlay 命中=撞原片字幕区,考虑换段或保留交客户端悔棋）
gtrk matrix lay --project "<工程目录>" --mark-weight 0.3 --json

# ⑧⑨ 字卡（§六 规约产颗粒 → lint → 铺）
gtrk mg lint "<工程目录>/mg/<composition_id>.html" --dispatch "<工程目录>/split/dispatch.json"
gtrk mg --project "<工程目录>" --json

# ⑩ BGM（音量口径见下）
gtrk audio lay --project "<工程目录>" --file "<bgm>" --volume 0.2 --beat-align --json
```

**配方级参数口径**（打样标定）：
- `--mark-weight 0.3`：美观度加权起步值（mark 缺失素材中性不受罚）；
- **BGM 音量 0.2-0.25 起步、宁低勿高、客户端终调**（★ 主理人拍板固化）：配音主导原则——BGM 是垫底不是主角；成品音乐响度天然高于 TTS 电平，宁可低了让用户在客户端拉高；
- 时间窗（`--source-window`）：二创场景解说序≈素材序时按 beat 对应的原片区间约束检索（可选增强，全库检索在几百场景规模下命中率已够）；
- 素材不二用、黑片叠底、层序（黑底最低号<common<concept<local，契约=大号在上）均由 lay 内建，MUST NOT 绕过。

## 六、MG 轻量字卡规约（旅拍向最小集，不建栏目 skill）

快速模式**禁留白**（★ 打样修正）——字卡按下述规约**先斩后奏**直接产好叠上，用户不满意在客户端删，别等确认。

- **内容**：地名字卡为主（地标名中文+英文/头衔副标），可加里程/价格数字卡；每片 2-4 颗、挂在地标出场句（拆分稿 aux_layers overlay）；
- **形态**：左下安全区地名条——竖色条装饰+半透明深色衬底圆角条+主标题（60px 级粗体白字）+副标题（28px 级 75% 白）；透明叠加不挡画面主体；
- **动效**：入场滑入淡入约 1.5-2s → **定格驻留到坑位末尾**（gsap-emit v1 铁律⑦：时间线总长≥坑位+0.3s，禁全局渐隐）；
- **工艺**：严格按 `contracts/gsap-emit-v1.md` 颗粒骨架（`<template>` 包裹/1920×1080/`gsap.timeline({paused:true})`/`__timelines` 注册/无随机无时钟/lib.baomitu.com GSAP CDN）；字体用渲染字体注册表在册族（如 `Alibaba PuHuiTi`）；实心衬底写子层不写根（铁律 4）；
- **产前抽帧**（overlay 必做）：对挂点用本地 ffmpeg 抽 1 帧看底轨明暗与主体位置（临时文件落系统 temp 用完即删）；
- 产物存 `<工程目录>/mg/<composition_id>.html`，逐颗 lint 过了再铺。

## 七、精修模式（用户要逐步确认时切换）

每步完成即停、报告产物、等确认再推进。增量重跑通道：

| 环节 | 暂停点产物 | 调整方式 | 增量重跑 |
|---|---|---|---|
| 写稿 | 解说稿 vN | 用户改意见 → 你改稿 | 改稿后从 ④ 重跑（TTS 变=全链时码变，⑤起全部重建） |
| 拆分 | split/view.json + 拆分稿 | 改 beat 划分/queries | `gtrk split <拆分稿> --project` 重落 |
| B-roll | broll-plan.json | 编辑 plan（删候选/换段/pinned 钉选） | `gtrk matrix lay`（消费 plan 零检索零计费） |
| 字卡 | mg/*.html | 改颗粒 HTML | `gtrk mg --project --only <beatId>` 单颗重铺 |
| BGM | audio_track | 换歌/换音量 | `gtrk audio lay` 同文件幂等替换 |

改口播轨后 matrix/mg 消费侧自带现场重投影，无需回跑 split。

## 八、交付与出片

- **成片出口 = 客户端**（OpenCut Gitruck Edition「打开工程」选 `gtrk/project.gtrk`）：多轨合成（B-roll+字卡+黑底+双音轨混音）只有客户端出片链完整支持；
- **`gtrk render` 仅是主轨快照预览**（★ 打样误用教训）：只渲一条视频轨、不合成字卡 overlay——可以当粗查混音与 B-roll 落位的预览片，**MUST NOT 当成片交付**；
- **云渲必拒**：含本地 B-roll 的工程提交云渲会被直接拒绝（`local_broll_cloud_render_rejected`）——出片走客户端本地导出或 `gtrk render` 预览，如实告知用户；
- 交付话术：报产物目录+客户端打开指引+各环节计费实耗；候选轨小眼睛切换、字卡可删可改、BGM 音量客户端可终调——把悔棋通道讲清楚。

## 九、计费速查

| 环节 | 计费 | 备注 |
|---|---|---|
| transcript 转写 | ASR 按分钟 | 二创场景一次 |
| matrix index（embed） | 会话计量按实际用量 | 同合云内部成员豁免 |
| matrix describe | 1 积分/张 | 内部成员豁免；同帧缓存永不重复计费 |
| TTS 配音 | 按成本档 1-12 积分/计费分钟（240 字/分钟折算） | 音色 catalog 可查档位；同参重合成走缓存不重复扣费 |
| project init / split / audio lay | 0 积分 | producer 同步口 0 元留痕；beat 分析（--beat-align）走 audio_music_analyze 计费 |
| BGM 矩阵搜索 | 1 积分/次 | |
| image_move 图片运镜 | 2 积分/张 | 素材夹含图片且被选中上轨时 |

起跑前把预估总消耗报给用户（检查点①一并确认），结束报实耗。

## 十、已知边界与排障

- **闪帧**：VFR 素材的场景切点可能产生闪帧（专项修复中）——用户报闪帧时告知已立案，客户端可手动微调切点避开；
- **拆分注释投影**：客户端暂不显示 beat 注释（调查中）；
- **字幕**：8 样式客户端支持落地前成片暂无字幕，检查点①如实告知；
- describe 的 `text_overlay` 信号命中多为撞上原片烧录字幕区（片头片尾高发）——裁定换段或保留交客户端；
- `matrix lay` 拒铺（`tracks_edited`）不是失败：用户在客户端动过候选轨，plan 照产（`planReusable:true`），提示用户后按其意愿 `--replace-all` 或保留；
- BGM 曲长 < 成片：audio lay 不循环，垫不满如实告知（客户端可复制 clip 补尾）。
