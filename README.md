# gtrk-cli（原·同合智创工具箱）

[English](README.en.md) · **简体中文**

<!-- 中英双份：改本文件必须同步 README.en.md（章节结构由 test/readme-bilingual.test.mjs 守卫）。 -->

> 同合云成片流水线 CLI —— **agent 驱动云端任务、产物拉回本地、三方工程文件（客户端 / 剪映 / PR）互通**。
>
> 一条命令，把口播毛片变成可二次精修的剪辑工程。云端做重活，本地只装配，源视频不出本地。

**🔗 [官网](https://cloud.ai-mcn.tv/zh-CN/cli) · [使用教程](https://hocassian.feishu.cn/wiki/HCFpwoF7SivIFbkKosgcFMcEnxk) · [计费说明](https://hocassian.feishu.cn/docx/DtendXStMogAbJxAOEmcCyC7n3e) · [快速开始](https://cloud.ai-mcn.tv/zh-CN/docs/quick-start) · [客户端下载](https://cloud.ai-mcn.tv/zh-CN/download) · [npm](https://www.npmjs.com/package/@gitruck/cli) · [用户协议](https://hocassian.feishu.cn/wiki/T6UywR8b3ik4Mgk7tP9c1b7Kn0b) · [隐私政策](https://hocassian.feishu.cn/wiki/ZLRNwlEhfishYtkosUhcofMYnPf)**

![把智能创作 AI 能力，装进你的本地 Agent](assets/gtrk-agent-intro.png)

---

## 为什么用 gtrk-cli

- **一条命令出三方工程**：上传口播毛片 → 云端智能剪辑（剪废话 / 重复 / 长停顿）→ 拉回**客户端（gtrk）+ 剪映 + PR/FCP** 三方工程文件 → 自动打开产物目录。
- **云端做重活、本地只装配**：识别、剪辑、对齐都在云端；本地只拿结果，**源视频不出本地**（路径写进工程、本地打开直接认素材）。
- **为 agent 而生**：配套 skill `gtrk-oralcut`，在 Claude Code / Codex / Cursor / Gemini CLI / TRAE 等 Agent 里一句「帮我剪个口播」就能发起，CLI 是手、agent 是脑。
- **通用工具箱**：单 binary + 平行子命令——每个 `gtrk <xyz>`（oralcut / split / mg / matrix / render…）都是一个**业务无关的通用驱动器/工具**，成片流程要哪个启哪个、用不到放着；后续可长更多驱动器。对标飞书 `lark-cli`。目前用它做人文社科视频，但设计上不绑任何栏目。

## 功能

| | 命令 | 做什么 |
|---|---|---|
| 🎬 | `gtrk oralcut <毛片>` | 智能口播剪辑闭环：一次出 gtrk + 剪映 + PR 三方工程，自动打开 |
| ✂️ | `gtrk long2short <毛片>` | 长剪短闭环：长视频语义选段+跳剪（可选 720p 代理智能分屏）→ 逐 clip 出 gtrk + 剪映 + PR 三方工程（毛片不上传）。**只要成片、不再二次编辑请走精剪** `gtrk tool video_long2short_pro` |
| ⏱ | 时长上限 | `oralcut` / `long2short` 的源片 **> 2 小时会在上传前被拦下**（零抽取、零上传、零扣费）。超长源片先分段再逐段跑，建议 40 分钟/段：`ffmpeg -ss 0 -t 2400 -i "<源片>" -c copy "<源片名>_seg01.mp4"`（流拷贝，秒级完成） |
| 📝 | `gtrk transcript <本地视频\|配音音频>` | 视频/音频转文字稿：原文件不上传，只传本地抽取（音频输入则转码）的 16k 音频衍生物，生成一个含总结、时码记录和纯文本的 Markdown；`--json` 时另产句级时码 `transcript.json`（`gtrk project init` 兜底路输入） |
| 🎵 | `gtrk music-visualizer <音频>` | 音乐可视化：一首歌 → 频谱可视化成片（`--template` 必填 + 可选背景/封面 + 模板/配色样式），配套 driver skill `gtrk-music-visualizer` |
| ✂️ | `gtrk split [拆分稿]` | 视觉拆分派单器：成片 × transcript 投影 → beat 分镜校验落地（`struct_meta.split` + `dispatch.json`），驱动四车道派单；`--column <id>` 按栏目词表校验 |
| ⚙️ | `gtrk init` | 引导式一次性配置（API Key + 剪映草稿目录），之后免管 |
| 🩺 | `gtrk doctor` | 体检：配置 / 云端连通 / 剪映目录 / 运行时一键自检 |
| 📦 | `gtrk deps` | 运行时资产：`status` 查 ffmpeg/字体的来源与授权，`install` 从同合云镜像装（**须显式触发，绝不静默自动下载**） |
| 🤖 | `gtrk skills install` | 通过通用 `skills` 适配器和 gtrk 补充层，把 18 个 CLI 自带 skill 装进本机检测到的主流 Agent；`--all` 可覆盖全部已登记宿主；`gtrk skills recommend --scene <id>` 查第三方 skill 推荐目录（随包快照、不联网、只推荐不打包），`gtrk skills add <owner/repo>` 透传安装并登记进栏目配置 `style.skills` |
| ⬆️ | `gtrk upgrade` | 升级 CLI 到最新版 + 刷新 skill（配置保留）；`--check` 只查不装 |
| 🎞️ | `gtrk render` | 本地渲染 gtrk 工程（EDL）→ 成片 mp4（需 ffmpeg）；按契约 z 序合成**全部可见叠加层**（B-roll 等 overlay 视频轨 + MG 颗粒，`hidden` 的轨不进片）；输出帧按时间线**累计对齐**（逐段取整误差不累加，画面不会对配音渐进失步）；渲完自动质检并落 `.qc.json`（`--no-qc` 跳过）；画中画 clip 的 `clip_transform`（缩放 / 落位 / 旋转 / 透明）、`border_radius` 圆角与 `clip_mask` 形状蒙版（圆 / 圆角方 / 爱心 / 菱形 / 星形，带羽化）随工程本地合成，与客户端预览观感等价。⚠️ 未命中缓存的 MG 颗粒要云渲**有计费**（先预估要确认；`--no-particles` 零计费出无颗粒版） |
| 🔬 | `gtrk qc <成片>` | 成片质检：单趟扫全片查闪帧/黑帧/冻结/爆音/静音/音画不同步，带时码定位；`--gtrk <工程>` 开工程感知识别**段内跳切**，`--fail-on error\|warn\|never` 供管线门控 |
| 🔎 | `gtrk matrix` | B-roll 检索+**候选铺轨**：消费 FILM_BROLL 派单 → 产候选清单 + 下载 preview 代理铺 N 条候选轨（`--lay N` 默认 1，opencut 打开即可用轨道小眼睛对比；`--lay 0` 只出清单）；`matrix search "<词>"` 单条 ad-hoc；`matrix fetch <clip_id...>` 精剪期拉原片（已授予素材免费重签+下载落盘，直接拖进剪映）；**本地素材模式**：`matrix index --dirs <素材夹>` 免切片建索引 → `--local --dirs` 检索铺轨（**素材本体不上云**）→ `matrix lay` 消费（可编辑的）plan；`matrix describe` 按需理解候选 |
| 🎨 | `gtrk mg` | MG 动态图颗粒铺轨：消费 MG 派单 → 把 html-particle 颗粒（透明叠加 / 满屏底层，由你栏目的 MG 生产 skill 所产）铺进 `.gtrk` 的 beat_track；`mg lint <颗粒.html>` 铁律静态子集校验、`mg status --project <dir>` 编排看板（缺 HTML / 已产未铺 / 已铺）；`mg render <颗粒.html> --duration <sec>` 脱离工程独立云渲单颗颗粒为剪映可读 qtrle 透明 MOV（精剪补给口）；aux 叠层颗粒同段多铺（一 beat 派生主 + `-aux<n>`）。旧名 `gtrk rrv` 保留为弃用别名；`gtrk mg fetch` 从 Hyperframes registry 取中性块骨架（快照随包离线候选、三源取块我方镜像优先、机械改写后过 lint）；`gtrk mg fetch --source text` 取同合云自家的文字特效模板（开箱即成品、不做机械改写），配 `gtrk mg compile`（改 IR 重编译，0 积分）与 `gtrk mg edit --say`（自然语言改写，按候选计费） |
| 🎙️ | `gtrk project init` | 音频驱动工程起盘：从一条配音建 `.gtrk` 工程——主路 `--tts-task <task_id>` 引用已完成的 TTS 配音任务（直取产物音频+句级时码，零 ASR）；兜底 `--audio`+`--transcript` 自备配音成对给。落好即可 `gtrk split --project` 接成片流水线 |
| 🎼 | `gtrk audio lay` / `tighten` | 音频轨零件：`lay` 往 `.gtrk` 工程追加一条音频轨（BGM/配乐上轨，同源幂等替换不堆轨）；`--beat-align` 云端分析把 **BGM 的情绪峰值压到成片的高潮点上**，锚点前后按小节线平铺补齐、两侧都够长时零平铺（计费一次；高潮点取自 `split.beats` 的判据链，可用 `--climax <轨秒>` 覆盖；`--no-loop` 只放锚点那一段、头尾留白；无 Key / 失败 / 曲子缺高潮点自动降级为不锚定，命令不失败）。`tighten` 收紧配音的句间停顿（纯本地零计费，只压跨句界的静音、句内换气不动） |
| 🎯 | `gtrk audio align` | 音画对轨零件（纯本地零计费）：外录音轨（领夹麦/录音笔）与视频互相关测偏移+置信度；高置信直接换轨（视频流零像素改动），低置信产对齐工程交客户端拖齐后 `--resume` 读回；`--offset` 显式偏移直换 |
| 🧰 | `gtrk tool <name>` | 单点工具族：图转运镜、图片/视频抠像、图片去黑边/比例转换/净化/转方图/LivePhoto、智能拼图封面/拼长图（多图输入）、视频去黑边/比例转换/防抖/蒸汽波滤镜/机械·智能分镜/运镜高光/智能字幕、人声伴奏分离/说话人分轨/变调变速、钢琴转MIDI/修复、音视频降噪、静音移除、MAD 等；`gtrk tool list` 查全部输入/产物/实时价格/状态。单发单收、共享 runner，接新工具只加一个 descriptor |
| 💬 | `gtrk feedback` | 把用得不顺手的地方反馈给我们：`gtrk feedback "<一句话>" --command <命令名>`。**告知式提交**——助手代提时必须先把要发的内容原样念给你、得到同意后才加 `--disclosed` 重跑；管道/非交互环境下没有这句声明会直接拒发。发送前内容会先做一遍脱敏（本机路径、凭据、邮箱、手机号等按形态替换），你看到的就是将要发出的那一份 |
| 🚧 | `struct` | （规划中）已有 gtrk 转三方工程 |

---

## 获取 API Key

CLI 要调用同合云云端能力，需先拿一个 API Key（形如 `gc_xxxxxxxx`）：

1. 打开官网 **[cloud.ai-mcn.tv](https://cloud.ai-mcn.tv)** 并登录 —— **登录即开通**、自带免费测试额度、零门槛。
2. 进入 **[控制台](https://cloud.ai-mcn.tv/zh-CN/dashboard)**，在「API 密钥 / 密钥管理」处生成并复制你的 Key。
3. 下一步 `gtrk install` 会让你把它粘进去（一次配好、本地长期复用）。

> 条款正本：[《"OpenCut Gitruck Edition 客户端"与"gtrk CLI"用户协议》](https://hocassian.feishu.cn/wiki/T6UywR8b3ik4Mgk7tP9c1b7Kn0b) · [隐私政策](https://hocassian.feishu.cn/wiki/ZLRNwlEhfishYtkosUhcofMYnPf) —— 官网**登录或完成注册即代表你已同意**；用 CLI 调用云端能力时，你是所处理内容合法性的第一责任人。
>
> 快速开始文档：[cloud.ai-mcn.tv/zh-CN/docs/quick-start](https://cloud.ai-mcn.tv/zh-CN/docs/quick-start) · 对接咨询：business@gitruck.com

## 安装 & 快速上手

需要 Node.js ≥ 20.6（`node -v` 查看）。

```bash
# 1) 一条命令装全：命令行 gtrk + /gtrk-oralcut skill + 配置（填 API Key、自动扫剪映目录）
#    装完新开一个终端敲 gtrk 就有响：安装器会自持一份全局副本，Windows 上还会把它所在目录加进用户 PATH
npx @gitruck/cli@latest install
#   等价写法：npm i -g @gitruck/cli@latest && gtrk install
#   新终端敲不到 gtrk？跑 gtrk doctor 看「命令可达」那一行

# 2) 剪一条（剪完自动打开产物目录）
gtrk oralcut "D:/素材/某选题-原始口播.mp4" --script "D:/素材/某选题-文字稿.txt"

# 或把本地视频转成一个 Markdown 文字稿
gtrk transcript "D:/素材/采访视频.mp4"
```

> 只想配置、不装 skill：用 `gtrk init`。本地开发：`cd gtrk-cli && bun install && bun run src/index.ts <命令>`。

产物目录形如 `<毛片名>-video-project-<YYMMDD-HHMMSS>/`，内含 `gtrk/`、`jianying/`、`xml/` 三端工程。

> **重复装不会重复填配置**：`gtrk install` / `gtrk init` 检测到已配好就默认保留、只刷新 skill；想改配置加 `--reconfigure`（Key / 剪映目录也都能回车沿用）。

## 操作地图：从零到成片

> **你只管对话，敲 CLI 的活交给 agent。** 下面是一条龙的走法——先做什么、后做什么、遇到情况怎么办。

**一次性准备（装一次，之后免管）**

1. **装 CLI**：`npm i -g @gitruck/cli@latest && gtrk install`（装 gtrk + skill + 填 API Key，一次配好）。
2. **（可选）建栏目风格**：想要自己的视觉调性 / 词表，对 agent 说「**建我栏目的风格体系**」（`/gtrk-style-maker` 访谈式帮你落成你自己的 skill 家族 + 栏目配置）。**不建就用默认厨房**，端到端照常跑。

**每片一条龙（有先后的 SOP，对 agent 说话、每步你可介入——不是一次性并行铺完）**

各车道**按次序铺、每步留检查点**：先把 B-roll 底轨三源铺齐（影视素材 / 本地素材 / AI 情景片段）→ 你调好 → 抽帧核一遍画面构图 → 最后才把 MG（含 ov）叠上去。你对话推进每一步，agent 替你跑对应命令。

**三种入链，一个汇合点。** 素材长什么样决定你走哪条；拿到「工程 + 文稿」之后，三条链完全一样：

```
  ① 口播链      你对着镜头讲的一条口播          gtrk oralcut
                短视频口播 / 人文社科杂谈        照稿剪掉重来·口误·长停顿
                                                      ↓
  ② 配音链      你写的一段稿子 → AI 配音        gtrk project init
                电影解说 / 美食解说              先把配音调舒服，再建工程
                                                      ↓
  ③ 长剪短      一条几十分钟的长素材            gtrk long2short
                播客·圆桌·脱口秀·访谈·直播回放   挑出值得单发的，逐条出工程
                                                      ↓
              ══════════ 工程 + 文稿 ══════════   ← 汇合点：往下三条链一样
                                ↓
        ┌───────────────────────┴───────────────────────┐
        │                                               │
   配画面（可选，次序不能跳）                       只想快点出片
        │                                               │
   gtrk split      把文稿分段派活                        │
        ↓                                               │
   gtrk matrix     按文稿铺 B-roll                       │
        ↓                                               │
   AI 再现（可选）  外部平台出片 → 手动回铺               │
        ↓                                               │
   客户端挑选      抽帧核构图 ← 底轨定稿前别往下走        │
        ↓                                               │
   gtrk mg         MG 主颗粒 + OV 叠层，最后才叠         │
        ↓                                               │
   gtrk audio lay  全片加 BGM（可选）                    │
        │                                               │
        └───────────────────────┬───────────────────────┘
                                ↓
                    客户端：上字幕 → 出片
                     （或导出剪映草稿 / PR 工程）
```

**记两件事就够**：① **底下的先铺、盖在上面的最后叠**——B-roll 与 AI 再现同属底轨画面（并列的两条腿），动态图（MG 主颗粒 + OV 透明叠层）是唯一的叠加层，底轨没定稿就叠等于白做；② 出片永远在客户端或你自己的剪辑软件里完成，CLI 只负责把料铺进工程。

> 三条链各自的完整走法（含每步产物、常见问题）见使用教程的子页：**口播链**（短视频口播 / 人文社科杂谈）· **配音链**（电影解说 / 美食解说）· **长剪短**（播客 / 圆桌 / 脱口秀 / 访谈 / 直播回放）。

| 步 | 你对 agent 说 | agent 替你做 | 你可以介入 |
|:--:|---|---|---|
| ① | 「帮我把这条口播**剪一版**」 | `/gtrk-oralcut` → `gtrk oralcut` → 三方工程 + transcript | — |
| ② | 「接着**拆分镜派单**」 | `/gtrk-splitter` → `gtrk split` → `dispatch.json` 四车道 | 核对派单结果 |
| ③ | 「**铺 B-roll 底轨**」（两条腿同一阶段） | `/gtrk-matrix` → `gtrk matrix` → 影视/本地素材候选轨铺入；`/gtrk-ai-drama`（skill，无命令）→ 四段描述稿（中英分块） | **opencut 里挑选/调整 B-roll**（小眼睛切换对比）；AI 片段去外部平台出片、**手动回铺** |
| ④ | 「B-roll 齐了，**抽帧看看构图**」 | 对**三源合并后的最终底轨**抽帧（agent 纪律，无专属命令） | **确认构图**（主体位置 / 安全区 / 朝向 / 明暗） |
| ⑤ | 「构图没问题，**铺 MG**」 | `/gtrk-mg` → `gtrk mg` → MG（含 ov）叠在已定稿的底轨之上 | 精修颗粒（opencut 手调） |
| ⑥ | 「**出成片**」 | 两条路都行：客户端出片链（多车道合成 + 颗粒云渲 / **导剪映**），或 `gtrk render`（本地叠全部可见叠加层出 mp4，颗粒未命中缓存时计费）；两端共用同一份颗粒缓存 | 客户端里精修定稿 |

> **次序有理由**：**AI 情景片段属于底轨 B-roll 画面家族，不是叠加层**——整条管线里唯一的叠加层是 MG（含 ov）。MG 的排版是「因势象形避主体」、**依赖底轨的最终画面构图**，所以三源（影视 / 本地 / AI）必须全落齐、构图核过，才轮到 MG。用不到的车道跳过（`dispatch` 里该队列为空就不铺）。
>
> ⚠️ **旧版文档曾写「④ 铺 MG → ⑤ 最后上 AI 再现」，理由是「越往后叠得越上层」——那是把「工序次序」误当成了「图层次序」，已于 2026-08-17 纠正。** 若你装的是旧版 skill，`gtrk upgrade` 刷新后才是新序。
>
> **AI 出片是异步的**：外部平台抽卡可能数天，严格串行会把 ④⑤ 无限期卡住。故进 ⑤ 的门是「**AI 片段已回铺 ∨ 你明示先跳过**」；走跳过时 agent 会把与 AI 区间相邻/重叠的 MG 颗粒标记为「AI 回铺后待复查构图」并在收口时复述给你。
>
> ③④⑤⑥ 都要**回到客户端**挑选 / 精修 / 回铺 / 出片——CLI 把料铺进 `.gtrk`，客户端把 `.gtrk` 出成片。详见下文「**CLI × 客户端**」小节。

**遇到情况怎么办**

| 情况 | 怎么做（跟 agent 说，或 agent 自动） |
|---|---|
| 只想要剪辑工程、暂不做视觉 | 到「剪一版」就停：「先只要剪辑工程」 |
| 报告丢了 / 换台机器再拉产物 | 「用 taskId 取回上次的」→ `gtrk oralcut-result <taskId> --out <目录>`（跳过重跑云端） |
| 想在几个 B-roll 候选里挑 | 「B-roll 多铺几条候选」→ `gtrk matrix --lay N`，opencut 里用轨道小眼睛切换对比 |
| B-roll 填充太差 / 有空槽 | 调 `--score-floor` / `--top-k` 重跑，或「单独搜个词」→ `matrix search "<词>"` 补 |
| 想用自己的素材铺 B-roll | 「用我本地的素材铺」→ `gtrk matrix index --dirs <素材夹>` 建索引后 `gtrk matrix --local --dirs … --project …`（**素材本体不上云**，详见命令参考 matrix 节） |
| 画面 / 颗粒要逐帧精修 | opencut 打开工程手调（agent 铺好的是**可编辑工程**，不是死片） |
| 连不上 / 配置出问题 | 「体检一下」→ `gtrk doctor`（配置 / 云端 / 剪映目录 / 版本一键自检） |
| 有新版 | 「升级」→ `gtrk upgrade`（升 CLI + 刷 skill，配置保留） |

## CLI × 客户端：手脑分工、一份 `.gtrk` 贯穿全程

**标准工作流从来不是「只用 CLI」，而是 CLI + 桌面客户端相互配合——客户端是成片流程绕不过去的一环。** 二者分工：

- **CLI = 无头装配器（手/机械活）**：把云端剪辑产物、检索到的 B-roll、栏目产的颗粒，确定性地装进工程、原子写回 `.gtrk`（剪口播 / 拆分派单 / 铺 B-roll 候选轨 / 铺 MG 颗粒）。不做审美判断、不出最终成片。
- **桌面客户端 = 有头工作台（眼/精修活）**：打开**同一份 `.gtrk`**，让你看、挑、逐帧精修、回铺 AI 片段、出片。装法见上一节「升级 → 桌面客户端」的一键脚本（OpenCut Gitruck Edition）。

**`.gtrk` 是两者之间的交接介质**——它是同合云的统一工程契约（timeline 真超集 + HTML 颗粒 + `struct_meta`），**CLI 写、客户端读，双向**。所以一条片子是 CLI 与客户端**交替推进**的：

```
CLI 写 .gtrk ─▶ 客户端打开(自动感知外部改动、先存脏改再刷新、不丢稿)
   ─▶ 你在客户端挑/调/精修 ─▶ 需要就再喊 agent 让 CLI 写下一轮(铺 MG / 铺 AI…)
   ─▶ … 反复 … ─▶ 客户端出片
```

**这几件事只能在客户端做（CLI 给不了）：**

| 环节 | 为什么必须在客户端 |
|---|---|
| **B-roll 候选挑选** | `gtrk matrix` 铺 N 条候选轨，用轨道**小眼睛**逐条切换对比、选定、删多余——审美取舍只能人在客户端做 |
| **MG / 颗粒精修** | 客户端里 html-particle **活颗粒透明预览** + Transform/Blending/Effects 参数逐帧微调 |
| **口播精剪** | 磁性主轨 ripple、手动微调切点 / 停顿 / 分屏 |
| **AI 再现回铺** | 外部平台出的 AI 片段**手动拖进 AI_DRAMA 车道**对齐区间（`/gtrk-ai-drama` 只吐描述稿，片在外部平台出，见 SOP ③——它属底轨阶段，MG 要等它落位后才铺） |
| **最终出片** | 多车道合成（overlay / MG / particle 云渲叠起来）+ 剪映草稿导出，都在客户端出片链 |

> **`gtrk render` 现在会合成叠加层了（1.1.10 起）。** 它按契约 z 序（`track_index` 升序）把**全部可见**的叠加层叠进成片——overlay 视频轨（B-roll 候选 / AI 再现回铺）与 MG 颗粒都在内；在客户端关了「小眼睛」（`hidden`）的轨不进片。
>
> **颗粒那一段有计费**：CLI 没有 HTML 渲染引擎，颗粒要送同合云烤成透明 MOV 再本地叠。计量 = **唯一颗粒数 × 未命中缓存数**（按分钟），未命中时会先出预估并要你确认（`--yes` 跳过；`--json` 下必须显式 `--yes`）。**第二次渲染全命中缓存 ⇒ 零计费**；缓存与客户端导出剪映时那份**同键同落点**（`<工程目录>/.tonghe-cache/particles/`），所以客户端烤过的颗粒 CLI 直接命中、反之亦然。不想花钱用 `--no-particles` 出无颗粒版（overlay 视频轨照常合成，那部分零计费、纯本地）。
>
> **剪映草稿导出仍在客户端出片链**（`gtrk render` 只出 mp4）。

## 升级

> **从 1.0.x 升上来的先看这一条**：1.0.8 及更早版本铺出的工程带一处槽位接缝缺陷
> （主轨 −1 毫秒同轨重叠，`gtrk render` 会硬拒）。**本版修掉了产生它的原因，但修不了已经铺坏的工程**——
> 手上有旧工程就重跑一次 `gtrk matrix lay --project <目录>`。升级后旧工程仍渲不出，
> 不是新版没修好，是那份工程还带着旧缺陷。详见 [CHANGELOG](./CHANGELOG.md)。

**CLI + skill**（配置原样保留）：

```bash
gtrk upgrade          # 有新版则升到最新 + 刷新 skill
gtrk upgrade --check  # 只看有没有新版，不动手
```

> 用 `npx` 的（没全局装）本就每次拉最新：`npx @gitruck/cli@latest install`。`gtrk doctor` 也会顺带提示「有新版可升级」。

**桌面客户端**：重跑一键安装脚本即覆盖装最新版（per-user、免管理员、配置不动）：

```powershell
irm https://api.ai-mcn.tv:9000/broadcast/exe/install.ps1 | iex
```

## 给 AI Agent 用

装好后，在各家 Agent 里一句话就能调用 gtrk 的 skill：

| | |
|:--:|:--:|
| ![在 Agent 中调用 gtrk 示例 1](assets/agent-example-1.png) | ![在 Agent 中调用 gtrk 示例 2](assets/agent-example-2.png) |
| ![在 Agent 中调用 gtrk 示例 3](assets/agent-example-3.png) | ![在 Agent 中调用 gtrk 示例 4](assets/agent-example-4.png) |

`gtrk install` 会把 18 个 CLI 自带 skill（`gtrk-oralcut`·`gtrk-long2short`·`gtrk-splitter`·`gtrk-matrix`·`gtrk-mg`·`gtrk-ai-drama`·`gtrk-style-maker`·`gtrk-transcript`·`gtrk-tools`·`gtrk-music-visualizer`·`gtrk-cover`·`gtrk-travel-recap`·`gtrk-live-slicing`·`gtrk-talking-head`·`gtrk-narration`·`gtrk-voiceover`·`gtrk-food-recap`·`gtrk-vlog-docu`）装进本机检测到的 Agent。实现方式与 lark-cli 一致：gtrk 把本地 skill 源交给通用 `skills` CLI，由它维护 Agent 探测、目录映射及更新规则；gtrk 不再硬编码各家路径。

默认使用 `~/.agents/skills` 作为统一正本，再链接到各 Agent 的兼容目录（Windows 使用 junction）；链接不可用时适配器会回退复制。这样更新只有一份正本，不会让多份副本逐渐漂移。常用命令：

```bash
# 自动探测已安装的 Agent（等价核心：npx -y skills add <gtrk包根>/skills -g -y）
gtrk skills install

# 只装指定宿主；这里使用通用 skills CLI 的 Agent ID
gtrk skills install --agents codex,cursor,gemini-cli,trae-cn

# 安装到适配器当前支持的全部 Agent（会创建较多宿主目录）
gtrk skills install --all

# 不使用链接，每个宿主各复制一份
gtrk skills install --copy
```

`--agents` 接受上游适配器和 gtrk 补充层的 Agent ID。国产 Agent 已覆盖 `trae`、`trae-cn`、`codebuddy`、`qoder`、`qoder-cn`、`qwen-code`、`kimi-code-cli`、`iflow-cli`、`codearts-agent`、`lingma`，并额外补充上游尚未登记的 `workbuddy`、`qoderwork`、`comate`。常见简写 `qwen`、`kimi`、`iflow`、`codearts`、`tongyi-lingma`、`qoder-work`、`baidu-comate` 也会自动映射。以后上游新增 Agent，gtrk 无须发版也能直接使用新 ID；已有脚本若必须写死一个目录，仍可用 `--dir <skills目录>` 走兼容复制模式。

不同 Agent 的**输入 UI 不统一**：Claude 常把 skill 名放进 `/` 补全；Codex 的不同客户端可从 `$`、`/skills` 或 Skills 面板进入；TRAE 以 Skills 设置、显式点名或语义触发为主。因此没看到 Claude 风格的 `/gtrk-*` 下拉，不代表 skill 没安装。新 skill 没出现时，刷新窗口或新开会话。

然后直接说「**帮我把这条口播剪一版**」，或在对应 Agent 的 Skills 入口显式选择 `gtrk-oralcut`，agent 会问清毛片 / 文稿 / 节奏，调 `gtrk oralcut --json` 跑通闭环、验证产物、把三端打开方式回给你。完整可移植 playbook 见 [`AGENT.md`](./AGENT.md)。

**一条龙都交给 agent**：不止剪口播——接着说「拆个分镜」「铺 B-roll」「铺 MG 颗粒」「渲成片」，agent 会配合各车道生产 skill 调 `gtrk split` / `gtrk matrix` / `gtrk mg` / `gtrk render` 跑完整条 **成片管线**。**你只管对话、敲 CLI 的活交给 agent**——下面的「命令参考」是给 agent 查参数用的，不用你自己去终端敲。

### agent 能驱动的能力（skill 驱动命令）

**每个功能 = 一个 skill（脑，你触发、懂 SOP 位置与用户交互）驱动一个 gtrk 命令（手，确定性机械活）。** 成片是**有先后的 SOP、每步用户可介入**，不是一次性并行铺完——`/gtrk-X` skill 负责在对的时机、带着你的确认，去跑 `gtrk X`：

| SOP | 驱动 skill（你对 agent 说） | 底层命令（agent 跑） | 做什么 |
|:--:|---|---|---|
| ① | `/gtrk-oralcut` | `gtrk oralcut` | 智能剪口播 → 客户端/剪映/PR 三方工程 + transcript |
| ② | `/gtrk-splitter` | `gtrk split` | 拆分派单 → `dispatch.json`（A_ROLL/MG/AI_DRAMA/FILM_BROLL 四车道） |
| ③ | `/gtrk-matrix` | `gtrk matrix` | **B-roll 底轨·影视/本地素材腿**：铺候选轨 → **用户调整/挑选**（opencut 小眼睛切换） |
| ③ | `/gtrk-ai-drama` | （无命令，纯创作） | **B-roll 底轨·AI 情景片段腿（与 matrix 同阶段，不是最后）**：产四段描述稿（故事背景/角色/分镜/原文，中英分块）→ 任意外部平台出片、手动回铺（产物即描述文本、无机械尾巴，同 `/gtrk-style-maker` 只 skill 无命令） |
| ④ | （无 skill） | （无命令） | **全局抽帧检查画面构图**：对三源合并后的最终底轨抽帧，用户确认构图——这是 agent 纪律硬门，供 ⑤ 的排版避让决策使用 |
| ⑤ | `/gtrk-mg` | `gtrk mg` | **MG（含 ov）最后叠上**（叠在已定稿、构图已核的底轨之上） |
| — | `/gtrk-style-maker` | （无命令，建栏目） | 一次性访谈式建你栏目的风格体系（skill 家族 + 栏目配置，见下节） |
| ③′ | 「**屏录画中画**」 | `gtrk pip lay` | 把口播粗剪的切点镜像到同步录的屏录 / 第二机位，铺屏录满幅轨 + 人像画中画副本轨（圆 / 圆角方 / 爱心 / 菱形 / 星形蒙版，可圆角）；纯本地零计费；低置信时产对齐工程让客户端拖齐后 `--resume` |
| — | （收口） | `gtrk render` | 本地渲染 gtrk 工程 → 成片 mp4（含 overlay 与 MG 颗粒；颗粒未命中缓存时云渲计费，`--no-particles` 可跳过） |
| ✂️ | `/gtrk-long2short` | `gtrk long2short` | 长剪短·粗剪：长视频语义选段+跳剪 → 逐 clip 出客户端/剪映/PR 三方工程（毛片不上传），**不在成片 SOP 序列内**、随时可独立用 |
| 📝 | `/gtrk-transcript` | `gtrk transcript` | 本地视频/配音音频 → 一个含 Agent 总结、时码记录和纯文本的 Markdown，**不在成片 SOP 序列内** |
| 🧰 | `/gtrk-tools` | `gtrk tool <name>` | 单点工具族（图转运镜 / 图片·视频抠像…）——单发单收，**不在成片 SOP 序列内**、随时可独立用 |
| 🎵 | `/gtrk-music-visualizer` | `gtrk music-visualizer` | 一首歌 → 频谱可视化成片（模板 + 可选背景/封面 + 配色样式），**不在成片 SOP 序列内**、独立引流用 |
| 🖼️ | `/gtrk-cover` | （无命令，纯创作） | 封面工作台两阶段：设计诊断 + 三尺寸中英双版文生图 Prompt → 用户外部平台抽图 → H5 排字工作台（拖拽/滚轮微调、一键导出多尺寸 PNG）。栏目封面审美经栏目配置 `style.skills`（`produces:"cover"`）注入；**不在成片 SOP 序列内**（投放配套的「第 0 阶段」） |
| 🧭 | `/gtrk-talking-head` | 编排 `gtrk audio` → `oralcut` → `split` → `matrix` → `mg` → `audio lay` → `subtitle lay` | **口播链图纸**：一条或一组真人出镜毛片 → 外录音轨对齐换轨、多段拼接、粗剪、拆分派单、B-roll/MG 字卡、BGM、字幕 → 客户端可出片工程 |
| 🧭 | `/gtrk-travel-recap` | 编排 `gtrk tool audio_tts_clone` → `project init` → `split` → `matrix` → `mg` → `audio lay` → `subtitle lay` | **旅拍解说图纸**：旅拍素材夹 → AI 理解素材、写三段式解说稿、一次确认 → 配音/建工程/拆分/B-roll/字卡/BGM/字幕全自动跑完 → 客户端可出片工程 |
| 🧭 | `/gtrk-live-slicing` | 编排 `gtrk long2short`（超长回放先分段） | **直播切片图纸**：数小时直播回放 → 分段（服务端 2h 硬闸）→ 选题清单确认 → 一批逐 clip 粗剪工程（gtrk + 剪映 + PR），按画面形态配分屏 |
| 🧭 | `/gtrk-narration` | 编排 `gtrk transcript` → `project init` → `split` → `matrix` → `mg` → `audio lay` → `subtitle lay` | **通用解说图纸（解说链正本）**：素材自带时序的长东西（影视长片/游戏实况/探店记录…）→ 提炼梗概与看点 → 精简叙述重讲成解说成片工程；旅拍解说与美食解说是它的垂类实例 |
| 🧭 | `/gtrk-voiceover` | 编排 `gtrk tool audio_tts_clone` → `project init` → `split` → `matrix` → `mg` → `audio lay` → `subtitle lay` | **配音链快速成片预设**：写好的稿（或 AI 代写）→ 配音 → 自动配画面 → 字卡/BGM/字幕 → 客户端可出片工程；适用科普/情感电台/观点/带货/盘点等无自带时序的题材 |
| 🧭 | `/gtrk-food-recap` | 沿 `/gtrk-narration` 链路 | **美食解说垂类图纸（解说链示例）**：探店/密着纪实长片或做饭流程记录 → 提炼看点重述成中文美食解说成片工程 |
| 🧭 | `/gtrk-vlog-docu` | 编排 `gtrk transcript` → `tool audio_tts_clone` → `split` → `matrix` → `mg` → `audio lay` → `subtitle lay` | **Vlog 纪实图纸**：一批现场素材 → 素材理解、选档写稿、一次拍板 → 同期声骨架 + 旁白配音 + B-roll + 字幕层 + BGM 全自动 → 客户端可出片工程；「现场同期声 × 后期旁白」双声道交替，区别于纯口播链与纯配音链 |

> **skill 与命令的区别**：`/gtrk-mg` 是**脑**——懂它在 SOP 第 ⑤ 步（B-roll 三源全齐、构图核过才铺 MG）、带用户确认、按栏目配置解析该产哪种颗粒；`gtrk mg` 是**手**——纯确定性 lint + 铺轨。你对话触发 skill，skill 替你跑命令。
> 上面 18 个 `/gtrk-X` 都是 **CLI 自带框架 skill**（`gtrk skills install` 装；名单与「给 AI Agent 用」一节、「结构」一节完全一致）——其中 🧭 标记的 7 张是**组合图纸**（一句话跑全链，只编排上面的单命令 skill、本身不新增命令）；`/gtrk-long2short` 独立驱动长剪短，`/gtrk-transcript` 独立驱动视频/音频转文字稿，`/gtrk-tools` 只负责单点工具族，`/gtrk-cover` 管封面，四者都不属成片 SOP 序列；`/gtrk-ai-drama`·`/gtrk-style-maker`·`/gtrk-cover` 是纯创作 skill（无命令）。栏目专属的**视觉风格/生产内容**另由你栏目的生产 skill（`/gtrk-style-maker` 产、经栏目配置 `style.skills` 绑定）供，不写死在这些框架 skill 里。

**各车道的具体视觉/内容怎么产**——MG 动态图长什么样、AI 再现什么调性——不写死在 CLI 里，而由**你自己栏目的生产 skill** 提供（用 `/gtrk-style-maker` 访谈式产出、留本地）。它们经**栏目配置 `style.skills[].produces`**（值 = 车道名）绑定，`gtrk mg` / `gtrk matrix` 等**通用驱动器**据此消费。**驱动方向 = CLI 驱动栏目 skill**：栏目 skill 只供风格/内容、不含任何「跑哪条命令」的编排职责；框架只认车道与管线接口，画面风格永远归你的栏目。不建栏目就用内置默认，端到端照常跑。

---

## 栏目与风格：两层结构

> **栏目配置是装修厨房，成片是每天做菜。你不会每做一道菜先重新装修一遍厨房，但每道菜确实都在你装修好的厨房里做。**

整个体系分两层，时间尺度完全不同：

**【栏目层 · 一次性/低频】= 建栏目（装修厨房）**
跑 `/gtrk-style-maker`（meta skill），它通过启发式访谈帮你想清楚**你自己的**视觉语法——不预设任何维度：不假设你有叙事结构、有主题系统、视觉分动画/实拍，你的维度和取值全部由你自己定义。产出：

- 你自己的可执行 skill 家族（落到当前 Agent 的用户级 skills 目录，黑盒、留本地）
- 栏目内共享词表（家族各 skill 引用，防多处定义漂移）
- 栏目配置 `~/.gitruck/columns/<id>.json`（词表 vocab + B-roll 检索偏好 + style 引用清单）

**【成片层 · 每片跑】= 做菜（流程形状不变）**
剪口播 → 拆文稿 → 派单（B-roll 检索 / 动效 / 再现）→ 装配 → 渲染。每一步显式消费当前栏目配置：拆文稿按你的词表校验（`--column <id>` 或 config `defaultColumn`），B-roll 检索按你栏目的检索偏好（`broll.column_tag_ids` 栏目标签 / `material_class_policy` / facets），各车道走你自己的生产 skill。

**不建栏目？直接用默认"厨房"。** 零配置 = 内置默认栏目，端到端照常跑通，行为与配置化之前逐字节一致——栏目层是可选资产，不是必经关卡。

**管线契约**：框架对审美零预设、对管线接口全权威。产物要进渲染管线的 skill 须满足对应契约（见 [`contracts/`](./contracts/README.md)，如 HTML 动画颗粒的 `gsap-emit v1`）；契约只约束机器可判定的管线属性，画面长什么样永远归你。

---

## 配置

`gtrk init` 把配置写到 `~/.gitruck/config.json`（用户级统一目录，config / 缓存 / ffmpeg / 栏目配置全在 `~/.gitruck/`）。读取优先级：**环境变量 / `.env` > `init` 持久配置 > 默认根地址**。

| 项 | 来源 | 说明 |
|---|---|---|
| `GITRUCK_API_KEY` | env / init | 鉴权 Header `Authorization` 的**裸值**（非 Bearer） |
| `GITRUCK_API_BASE` | env / init | API 根地址，默认 `https://api.ai-mcn.tv:10000` |
| 剪映草稿目录 | init / 自动探测 / `--jianying-draft-dir` | 决定剪映草稿落哪、能否直接打开 |
| `defaultColumn` | config.json 手填 | 缺省栏目配置 id（`gtrk split` 未传 `--column` 时用它；再缺省 = 内置默认栏目） |
| 栏目配置 | `~/.gitruck/columns/<id>.json` | 一栏目一文件；由 `/gtrk-style-maker` 生成登记，也可手写 |

非交互配置（脚本 / CI）：

```bash
gtrk init --api-key <KEY> --jianying-draft-dir auto -y
```

随时 `gtrk doctor` 自检：

```
✅ 运行时：node v24.x
✅ CLI 版本：v0.3.0（已是最新）
✅ API Key：已配（gc_xxx…）
✅ 云端连通 + 鉴权：可达，鉴权通过
✅ 剪映草稿目录：C:\Users\…\com.lveditor.draft
```

### 枚举清单（`--refresh-catalog`）

`gtrk doctor` 里有一行「枚举清单」：CLI 从服务端拉一份**对外枚举的全集**（字幕样式与颜色、语种码、
工程文件格式、节奏预设、任务可用性等），落在 `~/.gitruck/catalog.json`，24 小时自动刷新。

有了它，`--subtitle-type` 这类参数传错时**在上传之前**就告诉你，并列出当前可用值；
服务端新增一种样式，你不必升级 CLI 就能用上。

```bash
gtrk doctor --refresh-catalog          # 立刻重拉（无视 24 小时新鲜期）
```

**拉不到清单不影响使用**：CLI 会沿用上一次的快照；完全没有快照时**跳过本地校验、直接提交**，
由服务端裁决——服务端白名单永远是唯一真相源。要彻底关掉这次拉取，设 `GITRUCK_CATALOG_OFFLINE=1`。

### 崩溃报告与关闭方式

gtrk 崩溃时（未捕获异常 / 未处理的 Promise 拒绝 / 顶层出口的程序缺陷）会自动上报一条报告，帮我们定位缺陷。**默认开启，首次配置时会告知一次。**

**发送的内容只有这些**：错误消息、错误堆栈、来源标识（`cli`）、CLI 版本号、本次累计发生次数，以及（仅当崩溃发生在一个云端任务过程中时）那个任务的 ID。

**明确不发送**：素材文件与内容、工程文件与路径列表、你的文稿、API Key（发送前会把 Key 的字面值与形如 `gc_…` 的 token 替换成 `<KEY>`）、设备标识、主机名、环境变量。

**只上报「崩溃」，不上报「预期内的失败」**：文件不存在、参数不合法、额度不足、命令用错——这些你看得懂的报错一条都不会发。

三种关法（任选其一，都是即时生效）：

```bash
gtrk init --no-crash-report          # 写进配置，永久关
```

```bash
GITRUCK_CRASH_REPORT=0 gtrk oralcut a.mp4   # 环境变量，临时关一次（优先级高于配置）
```

或直接在 `~/.gitruck/config.json` 里写 `"crashReport": false`。

当前状态随时可查：`gtrk doctor` 的「崩溃自动上报」一行会写明开 / 关，以及关是被谁关的。关闭后崩溃的呈现与退出码**与开启时完全一致**——它只影响发不发那条报告。

---

## 命令参考

### `gtrk transcript <本地视频|配音音频>`

把本地视频或配音音频转为一个多层级的 Markdown 文字稿。只接受本地文件路径：视频在本机抽取、音频在本机转码为 16 kHz 单声道音频，只上传音频衍生物，原文件不会上传，也不支持 URL 或平台视频下载。

```bash
gtrk transcript "D:/素材/采访视频.mp4"
gtrk transcript "D:/素材/采访视频.mp4" --lang zh-CN --out "D:/文字稿/采访.md" --json
```

缺省只生成 `D:/素材/采访视频-transcript.md`，内容固定为：

1. `## 总结`：CLI 先标记为待完成，由 `/gtrk-transcript` 驱动 Agent 阅读全文后生成并写回；
2. `## 文字记录`：以 `[00:01:23]` 开头的可读段落；
3. `## 纯文本`：完整识别正文，便于整段复制。

实时计费在运行前从官网价格表按 `asr` 查询，CLI 与文档不保存价格数字。`--json` 的 stdout 只输出 `{ok,taskId,fileId,output,transcriptJson,summaryPending}`，其中 `output` 指向这一个 Markdown；`summaryPending:true` 表示 `/gtrk-transcript` 驱动 Agent 还需生成语义总结、原地替换待总结标记，完成后仍只交付同一个文件。

> `--json` 时另在源文件旁产一份句级时码 `<名>-transcript.json`（`utterances[]{id,text,st,ed}` + `material_id` + `text_hash` + `duration`，与 `gtrk split` 的 transcript 结构逐字段对齐），可直接被 `gtrk project init --transcript` 兜底路消费。**TTS 合成的配音勿走本零件重跑 ASR**——`gtrk project init --tts-task` 直取服务端句级时码，零 ASR 零额外计费。

### `gtrk oralcut <毛片>`

| 参数 | 作用 | 缺省 |
|---|---|---|
| `-s, --script <file>` | 文字稿 txt（有稿按稿剪、更准） | 探毛片同名 `.txt`；无则无稿智能重建 |
| `-p, --preset <p>` | 节奏 `steady`\|`concise`\|`compact`（松→紧） | `concise` |
| `-o, --out <dir>` | 自定义产物目录 | `<毛片名>-video-project-<时间戳>` |
| `-f, --formats <list>` | 三方格式逗号分隔 | `gtrk,jianying,xml` |
| `--jianying-draft-dir <dir>` | 剪映草稿根目录（或 `auto`） | 读 init 配置 / 自动探测 |
| `--reupload` | 强制重传，忽略上传缓存 | 关 |
| `--no-open` | 完成后不自动打开产物目录 | **默认自动打开** |
| `--json` | 机读：stdout 只输出结果 JSON（给 agent / 脚本） | 关 |

`--json` 输出（成功时 stdout 单行）：`{ ok, outDir, files:{gtrk,jianying,xml}, jianyingDraftPath, rendered, report, errors, taskId, fileId }`；命令失败则进程非 0 退出、报错走 stderr、stdout 无 JSON。

> 每次跑批都会把这份结果**恒写一份 `result.json` 到产物目录**（不受 `--json` 约束）；提交成功后还会落一份 `task.json` 面包屑。即便 stdout 丢了、或中途崩了，报告与 `taskId` 都在盘上，可用下面的 `oralcut-result` 秒级取回、无需重跑云端。

### `gtrk oralcut-result <taskId> --out <目录>`

按 `task_id` 从云端取回一个**已完成**任务的报告与三方工程产物（可选本地渲染成片），**跳过预处理 / 上传 / 提交 / 轮询**——报告丢了、或想换台机器再拉一次产物时用它，不重跑云端。

| 参数 | 作用 | 缺省 |
|---|---|---|
| `-o, --out <dir>` | 产物目录 | **必填**（2026-09-08 起无缺省；`--out .` = 当前目录本身） |
| `--render` | 额外本地渲染成片（需原毛片仍在 gtrk 内嵌路径 + ffmpeg） | 关 |
| `--jianying-draft-dir <dir>` | 剪映草稿根目录（或 `auto`） | 读 init 配置 / 自动探测 |
| `--no-open` / `--json` | 同 `oralcut` | — |

> 取结果需用**提交该任务的同一账号** API Key（异账号 / 已删任务报 `TASK_NOT_FOUND`）。报告存于任务记录、长期可取；底层产物文件约 **60 天**后被清理，届时仍能取回报告、但产物下载会 404（命令会提示、并照常落盘报告）。

### `gtrk split [拆分稿]` — 视觉拆分派单器

成片 × transcript 投影 → beat 分镜。**无 positional = 导出投影视图**（把当前 `.gtrk` 时间线 × transcript 投影成 beat 视图，供拆分/校对，不写回）；**带拆分稿 = 校验落地**（校验拆分稿机器契约 → 投影出 beat 时码 → 原子写回 `struct_meta.split` + 产 `split/dispatch.json` 派单清单，驱动 A_ROLL / MG / AI_DRAMA / FILM_BROLL 四车道）。时码永远归 CLI（拆分稿只描述「哪段做什么」、不写时码）。

| 参数 | 作用 | 缺省 |
|---|---|---|
| `--project <dir>` | oralcut 产物目录（自动定位 `gtrk/project.gtrk` 与 `transcript/transcript.json`） | — |
| `--gtrk <path>` / `--transcript <path>` | 显式指定工程 / transcript（非标准布局兜底） | 由 `--project` 推 |
| `--column <id>` | 栏目配置 id（按你栏目词表校验 lane / category / produces） | config `defaultColumn` → 内置默认栏目 |
| `--md` | 落地时额外渲染人读稿 `split/visual-split.md`（由 JSON 单向渲染） | 关 |
| `--words` | 视图模式附字级明细 | 只出句级 |
| `--json` | 机读：stdout 只输出结果 JSON | 关 |

> 落地产物 `dispatch.json` 三队列 → 下游消费：`mg`（MG 颗粒）→ `gtrk mg` 命令、`film_broll` → `gtrk matrix` 命令、`ai_drama` → `/gtrk-ai-drama` skill（产四段描述稿·中英分块，纯创作、无命令）。配套 skill `/gtrk-splitter` 产拆分稿。
>
> **派单条目自带 `span:{from,to}`**（该条目对应的 utterance 区间；`overlay` aux 派生条目写 **aux 自己的** span，可为主 beat span 的子区间）。**`track_st/track_ed` 是投影时刻的快照**——`gtrk mg` / `gtrk matrix` 消费时会**现场重投影**（见下），所以改完口播轨**不必**回来重跑 `gtrk split`，只有拆分稿本身变了才要重跑。

### `gtrk patch <move|trim|split|set>` — 元素级编辑（改工程唯一入口）

改一个 clip / gap / 颗粒的时码或参数。**agent 勿裸手改 `.gtrk` JSON** —— 片段时码是两套并存的
（`clip_st`+`clip_ed` 与 `clip_st`+`duration`），改一份不改另一份是**静默失败**：客户端优先读 `clip_ed`，
而后端不强校验它，于是没人报错、成片却用了陈旧出点。本命令负责恒等式同步 + 帧对齐 + 写前全档校验。

```bash
gtrk patch move  --project <dir> --clip c2 --to 5.0
gtrk patch trim  --project <dir> --clip c2 --out -1s
gtrk patch split --project <dir> --clip c2 --cut 5.5
gtrk patch set   --project <dir> --track audio:1 --at 3.0 --volume 0.5
```

| 参数 | 作用 | 缺省 |
|---|---|---|
| `--project <dir>` / `--gtrk <path>` | 工程目录（自动定位 `gtrk/project.gtrk`）或直接给路径 | — |
| `--clip <clip_id>` | 按 id 寻址。命中 video/audio **镜像对**时视为一个编辑单元 | — |
| `--track <kind:idx> --at <sec>` | 按位置寻址（`track_st ≤ at < track_ed`）。与 `--clip` 互斥 | — |
| `--to <sec\|Nf>` | `move` 的落点 | — |
| `--in` / `--out` / `--set-in` / `--set-out` / `--slip` | `trim` 的五种语义（前两个相对、中两个绝对、`--slip` 只换源窗） | — |
| `--cut <sec\|Nf>` | `split` 的切点。⚠️ 与寻址用的 `--at` 是两个参数 | — |
| `--muted` / `--volume <gain>` / `--opaque` | `set` 的元素级参数（`--volume` 是线性增益不是 dB） | — |
| `--total <sec\|Nf\|max>` | `set` 的顶层总长（工程级 op，与元素寻址互斥） | — |
| `--ops <file\|->` | 批量事务：一次读、全算、全校验、一次写；任一条失败**零写** | 关 |
| `--dry-run` | 只算与校验、不写文件 | 关 |
| `--json` | 机读回执到 stdout（人读日志转 stderr） | 关 |

> 时码字面：秒（`3.5` / `3.5s`）或帧（`105f`）；相对量带正负号（`-1s`）。
>
> 回执含 `ops[].resolved` 定位三元组 `{track, clip_id, track_st}` —— 下一轮据它复核「所指是否仍是同一元素」。
> `preexisting[]` 是**入档既存**的不变量问题（非本次造成，不阻断）；本次改动造成违规则**零写非 0**。
>
> ⚠️ 空档（gap）不能用 `--clip ""` 寻址：契约允许多个 gap 共享该取值，它不构成地址；用 `--track/--at`。

### `gtrk matrix` — B-roll 检索 + 候选铺轨

**无 positional = 派单消费**：读 `split/dispatch.json` 的 `film_broll` 队列 → 双口检索 → 产候选清单 `split/broll-plan.json` + 下载 preview 代理、在工程里平铺 N 条候选轨（opencut 打开即可用轨道小眼睛对比挑选）。**`matrix search "<query>"` = 单条 ad-hoc 检索**（不依赖派单）。**`matrix fetch <clip_id...>` = 精剪期拉原片**（脱离工程，见下）。

| 参数 | 作用 | 缺省 |
|---|---|---|
| `--project <dir>` | oralcut 产物目录（定位 `split/dispatch.json` 与产物落点） | — |
| `--dispatch <path>` | 显式指定 `dispatch.json` | 由 `--project` 推 |
| `--column <id>` | 栏目配置 id（按你栏目 B-roll 检索偏好：标签 / material_class / facets） | config `defaultColumn` → 内置默认栏目 |
| `--lay <n>` | 候选铺轨数：平铺 N 条 B-roll 候选轨（`0` = 只出 plan 不铺轨） | `1` |
| `--top-k <n>` | 每 query 候选数上限（覆盖派单 shots；服务端上限 50） | 派单值 |
| `--material-class <c>` | 素材类型 `real_shot` \| `concept`（仅矩阵成员口；覆盖栏目策略） | 栏目策略 |
| `--score-floor <f>` | 填充置信度地板：segment score 低于此值不采纳、槽位留空——留空处**露黑底垫轨**（默认铺；除非 `--no-black-bed` 才露主轨）。调高会收缩取材池，整段铺不满即纯黑压口播，调完先看空洞告警 | `0.2` |
| `--no-black-bed` | 不铺纯黑底垫轨（默认铺一条） | 默认铺 |
| `--force-relay` | 候选轨已被你在客户端编辑过时仍强剥重铺（缺省会拒铺并保留那条轨）——**会删掉已确认原片的 `broll-raw-*` 素材登记、盘上原片成孤儿** | 关 |
| `--arrange <m>` | **B-roll 编排取数路**，**按素材来源自动定档、一般不用传**：铺你自己电脑里的素材 → `cloud`（编排在云端做，按「编排量」计费，跑前报预估并征求确认，`--yes` 跳过）；铺素材矩阵的素材 → `local`（编排仍在本机、不计费，逐字不动）。`shadow` 是观测档：本机照跑照铺轨、云端只对拍不采纳。⚠️ 本地素材路上 `--arrange local` 不受理（传了报参数错）；云端拿不到产物时**直接报错**，不会悄悄换算法把活干完 | 按素材来源自动 |
| `--arrange-qc` | **编排期质检**（缺省关）：落轨**之前**就查每个 beat 的卡点句「画面有没有给到稿子说的东西」，没给到就换候选重排，最多 2 轮，到限即交付并如实登记还差哪几句。全程零渲染——替代「铺完 → 渲 → 看 → 重铺 → 再渲」那两轮。⚠️ 判定走素材理解口、**按帧计费**（每个卡点句 1 帧/轮，命中判定缓存的不重复计费），跑前报预估并征求确认（`--yes` 跳过）。与 `--arrange` 正交：本机档与云端档都能开 | 关 |
| `--arrange-cost-cap <n>` | 云端编排单次编排量上限：超限服务端**前置拒绝**、零执行零计费（不是跑到一半掐断）。只在 `--arrange shadow\|cloud` 时有意义 | 不限 |
| `--dump-request <file>` | **排障用**：把**实际上行的**云端编排请求体逐字节写到该文件。服务端**不保存你的 plan**（只留规模摘要），所以出了问题只有这份文件能复现——把它发给我们即可。⚠️ **不能指向工程目录内**（工程会被打包、拷贝、同步出去，而这份文件里有你的 beat 名与检索词）；开 `--arrange-qc` 时每轮各写一份，第 N 轮落在同名加 `.roundN`。机读回执在 `lay.arrange_run.dump_request` | 不写 |
| `--explain` | **外发调参仪表**：缺省的机读账面只给「留空槽数」`lay.dedup.emptySlots`（够判断素材池是不是不够用），其余调参用的细账（其中多少是窗口精修致空、跳剪避让枯竭放行几次、取用了几个高运动/模糊段）收在本开关后，人读日志同口径。不影响任何决策，工程产物逐字节不变 | 关 |
| `--arrange-estimate-only` | **只要预估不要执行**：走到云端编排的计价确认那一步就停，报出编排量后**成功**返回（`ok:true` + `estimateOnly:true`——那是「我在做决定」，不是「我拒绝了」），零云端调用、工程文件零改动。机读值在 `lay.arrange.units` / `lay.arrange.scale`。⚠️ 它省的是**云端那一次调用与其计费**（以及其后的候选下载与落轨），不是整条链：编排量的分母本来就要读工程、读 plan、做重投影才算得出。素材矩阵路报 `applicable:false` 而**不是 0**。与 `--yes` 同给时以本开关为准 | 关 |
| `--cut-align <ratio>` | 句界吸附目标比例 0..1：`0.7` ≈ 约七成字幕句起点恰逢镜头切点、三成有意错开（全对齐反而机械），`0` = 关闭、回旧节奏切槽。⚠️ 句级时码取 `transcript` 现场重投影（与关键词锚同源），**重投影降级时自动回旧行为并告警**——那一轮的吸附比例不作数 | `0.7` |
| `--gap-fill <mode>` | 音频驱动工程主轨的空洞怎么填：`fast` = **尽量不留黑**（放宽 score 地板从候选池填 → 耗尽则延长相邻颗粒 → 再耗尽跨 beat 借候选 → 短于最小镜头长的残洞也补真画面 → 补不满整段才垫黑片）；`solid` = 一律黑片垫齐（精修时一眼看出「这里没匹配到」）；`none` = 原样留 gap。⚠️ `fast` 借来的画面与本段稿子相关性弱、次地板槽是不到 1.2s 的快切，两者都会在日志里按 `kind` 报成 `borrowed` / `subfloor`——**如实告知，不是缺陷**；`none` 撞上客户端主轨磁吸会把 gap 吸掉，导致其后画面与配音**整体错位** | `solid` |
| `--highlight-weight <w>` | 仅 `matrix lay`：把「有没有看点」（信息量 / 戏剧性 / 情绪强度 / 稀缺性）融进候选排序，0..1。与 `--mark-weight`（画面好不好看）**正交**，两权之和钳到 1。⚠️ 看点分取 `describe` 的理解缓存，**没跑过 `describe` 就等于没开**——无缓存候选按中性处理，权重回吐给相似度 | `0`（关闭、零回归） |
| `--decode-path <mode>` | 仅 `matrix index`：场景检测的解码路 `auto` \| `gpu` \| `cpu` \| `full`。`auto` 自动探测硬解并**逐素材降级**（推荐）；`gpu`/`cpu`/`full` 钉死某档且**失败不降级**（对照与排障用）。⚠️ 缺省仍是 `full`（旧行为），要提速得自己传 `auto` | `full` |
| `--proxy-width <n>` | 仅 `matrix index`：代理解码宽度。⚠️ 再往下保真度明显劣化，**勿随手调小** | `384` |
| `--proxy-scaler <name>` | 仅 `matrix index`：代理缩放算法。缺省 `neighbor`（点采样不滤波，实测比 `bicubic` 又快又准）。⚠️ 改它基本只有做对照实验才需要 | `neighbor` |
| `--exclude-recent <n>` | 仅 `matrix material --scope audio`：选曲避让最近 n 首用过的 BGM。历史由 `audio lay` 落轨**自动记账**，不用自己维护 | `12` |
| `--no-exclude-recent` | 关掉上一条的选曲避让，允许复用近期曲目 | 关（缺省避让） |
| `--out <file>` | ad-hoc 模式结果落文件；`matrix fetch` 原片落盘目录（绝不写剪映草稿目录） | stdout / `./matrix-fetch/` |
| `--json` | 机读：stdout 只输出结果 JSON | 关 |

**`matrix fetch <clip_id...>`（精剪期拉原片，脱离工程）**：对**计费检索过**（授予账本命中）的素材按 clip_id 免费重签新鲜下载直链并落盘 `<clip_id>.<ext>`——粗剪导剪映后想补一段 B-roll，不回客户端就能拉到本地直接拖进剪映。动线恒为**两段式**：`matrix search` 挑定 clip_id → `matrix fetch` 拉取（fetch 自身零计费、不发起检索、无确认闸）。**授予持久**：24h 过期签名不构成障碍，三天前 search 出的 clip 照样 fetch。未购项逐条报「未购授予」并给出路（对该词跑一次计费检索即获授予），不连坐其余；单批 ≤500。**首发只覆盖视频 clip 原片**（图片/音频素材重签面未开，进 missing 附提示）。产物不进 `.gtrk`、不写剪映草稿目录；在剪映里补的料不回流工程（导出单向）。

> **beat 窗口现场重投影**：派单消费模式在**发起第一次云端检索之前**，用「`transcript` × 当刻 `.gtrk`」重算每个 beat 的 `[track_st, track_ed]`，检索、`broll-plan.json` 与铺轨一律以重算值为准（`--lay 0` 同守；ad-hoc `search` 不受影响）。`dispatch.json` 里的时码只是**投影时刻快照**，仅在重投影不可行时兜底——**所以改完口播轨直接跑本命令即可，不必先重跑 `gtrk split`**。`--json` 恒出 `reprojection:{mode,degraded,reason?,drifted,max_offset,shrunk,dropped}`；重投影后**零存活**的 beat 会被跳过（不为它烧检索配额、也不铺）。重投影不可行（transcript 缺失 / 工程定位不到 / 主轨查不到口播素材）→ **降级用快照 + 告警 + `--json` 标注**，检索与 plan 照产、不硬崩；非 v1 工程的既有行为不变（plan 先落盘、随后版本门非 0 退出）。
>
> **云端编排（`--arrange`）**：B-roll 的**编排决策**（哪一颗放哪、切多长、从素材的哪一段取）可以交给云端跑。
> 适用面只有一条：**本地素材上轨铺排**。素材库 / 普通素材 / 概念素材那些的匹配与铺排原来什么样、以后还什么样，
> 一个字节都不变。
>
> **不带这个参数时按素材来源自动定档**：铺你自己电脑里的素材走 `cloud`，铺素材库那些走 `local`。
> 本地素材的编排算法只在服务端迭代——改进当天生效，你不必升级客户端。
>
> ⚠️ **代价先说在前面**：本地素材的编排**只在云端完成**。云端拿不到产物（连不上 / 被拒 /
> 产物不合规）就**直接报错**，不会悄悄改用另一套算法把活干完——那会给你一份和云端不同的结果
> 而你并不知情。这条路上 `--arrange local` 不受理（传了会报参数错）。
>
> 跑前的用量确认你要是说「不跑」，**这一步就不做**（整轮铺轨中止，工程一个字节没动、plan 照常可用，随时可改主意重跑），
> 而不是换个便宜办法替你做完。
>
> ⚠️ **它不是省钱开关**：用素材矩阵的素材同样要付检索费。**两条路都要花钱，只是花在不同环节**——
> 自己的素材付编排费，矩阵素材付检索费（矩阵成员的检索是 0）。
>
> `shadow` 是观测档：本机照跑照铺轨、云端只跑一遍做对拍（**不切流**，产物仍用本机的），它不受上面那条报错规则影响。
>
> 云端两档按新计量维度**编排量**计费——要配画面的段落越多、每段候选素材越多、铺的候选轨越多就越贵。
> 跑前会报预估并征求确认，`--yes` 跳过、`--arrange-cost-cap` 设本次上限（超限**前置拒绝**，零执行零计费）。
> 完整计费口径（含既有的额度包 / 余额、阶梯价与免费档）见 **[计费说明](https://hocassian.feishu.cn/docx/DtendXStMogAbJxAOEmcCyC7n3e)**。
> ⚠️ 预估值只供双端一致性校验，**实际计费恒以服务端复算值为准**；两值不一致时服务端会拒绝执行且不计费。
> 上行的只有决策要读的字段——素材绝对路径、签名 URL、画面描述文本、派单负词、口播原文整句一律**不出你的机器**。
>
> **服务端一行不留**：那份上行的 plan 我们**不保存**（留痕只有规模明细、口径版本与复算金额，
> 够独立核对一笔账，但翻不出你的素材结构）。代价是**出了问题我们这边没有可复现的东西**——
> 所以给了 `--dump-request <file>`：它把真上行的那串字节留在**你自己的机器上**，
> 排障时把那个文件发给我们即可。缺省不写，且**不许写进工程目录**（工程是要被打包拷走的）。
>
> 频率上有两层保护，命中都是 **429、零执行零计费**：一层按次数限流；另一层认「同一份 plan
> 被反复换参数重提」这种形态。传输失败的重试发的是**逐字节相同**的请求体，不会被算进去。
>
> 候选的 `preview_url`/`cover_url` **不带签名、不会过期**（本地代理落盘后一律复用）；带签名约 24h 过期的是**原片 `url`**，由客户端「确认原片」链路重签——**不必为「重签」重跑本命令**。
>
> **重跑会剥旧重铺，但不碰你改过的轨**：候选轨的身份按「素材前缀 + 上一轮登记指纹」认，不再认轨号（客户端保存会把 overlay 轨整体重编号）。一旦某条候选轨被判定「你编辑过」（改过 clip，或在客户端确认过原片使 material 变成 `broll-raw-*`），本次**整体不铺**：不剥任何轨、不追加新轨、`.gtrk` 逐字节不变，`broll-plan.json` 照常产出，命令给出「哪条轨 / 什么证据 / 下一步」并以非 0 退出码结束（`--json` 出 `{ok:false, refused:[…]}`）。要强行重铺加 `--force-relay`。
>
> **机读账面：`counts.results` 是「去重前」口径**：`--json` 的 `counts.results` 恒是**逐 query 累加的检索响应条数**（既有口径不动）——15 条 query 各命中同一条素材时它就是 15，而 plan 落盘可能只有 8 行、只对应 1 个素材。要判「到底有多少料」读派单消费模式另出的三键：`counts.zero_yield`（**真·零产出**的 query 数，判据取**检索响应**为空，而非事后扫 plan 的 `results: []`——beat 内去重会把命中折进同 beat 的兄弟 query，折叠 ≠ 零产出）、`counts.plan_results`（plan **落盘后**的实际 result 行数，去重后）、`counts.distinct_clips`（plan 内 distinct `clip_id` 数）。这三键**只在派单消费模式**出现，ad-hoc `matrix search` 与 `matrix lay` 的 `counts` 逐字节不变（**缺席 = 没这个概念，不是「测出来是 0」**）。铺轨侧同理另出 `lay.beatsWithCandidates`（有候选的 beat 数）与 `lay.emptyBeats`（**零候选 beat 名单**——整段没有任何可铺的画面），两者恒满足 `beatsWithCandidates + emptyBeats.length = plan 的 beat 总数`。
>
> **素材落盘自检**：写回工程之后自动查一遍 `materials[].path` 是不是真的都落盘了（**只读、只报不动**）。相对路径恒以 **`.gtrk` 文件所在目录**（`<产物目录>/gtrk/`）为基准解析。`--json` 出 `integrity:{ checked, counts, dangling:[…], danglingReferenced, danglingOrphan, external:[…], noPathIds:[…] }`——`dangling` 是工程自带素材的**悬空引用**（登记在、文件不在）全量清单，每条标出**是否被时间线引用**及引用位置（被引用 = 那一段没素材可放，比孤儿严重得多）；绝对路径缺失另计 `external`（外接盘没挂载也会这样，不混进主判）；http(s) 素材只计数、**不发网络请求**。**这是告知不是拦阻**：查出悬空不改 `ok`、不改退出码、不删任何素材条目或文件。悬空多半是历史遗留（如客户端「确认原片」下载中断），修法是在客户端重新确认原片或删掉那条 clip。没写回的运行（`--lay 0` / 拒铺 / 工程缺失）**不出 `integrity` 字段**——缺席 = 本次没查，不是「查过且干净」。
>
> **纯黑底垫轨**：默认在全部候选轨之下、口播主轨之上垫一条纯黑底轨（`struct_meta.broll.black_track` 记其 `track_index`），按已落成的 beat 包络整条铺满，使 B-roll 期间（含候选轨留空处）不漏出底下的口播画面。**代价是「黑底空洞」**：候选轨没填满的地方就是纯黑压口播，铺轨会把它算出来——`--json` 恒出 `lay.blackBedHoleSec` 与逐段的 `lay.blackBedHoles`，单段 ≥ 3s 或单 beat 占比 ≥ 15% 时另出一条非致命告警（不改退出码、不阻断铺轨），可据此调 `--score-floor`、改用 `--no-black-bed`、或到客户端手动补片。字节落 `assets/builtin/solid-000000-<W>x<H>.png`，与客户端内置纯色素材同 id 命名空间、幂等复用。删候选轨时别误删它；换片请拖到候选轨颗粒上、**别拖到黑底条上**——客户端 0.2.10 起（2026-07-31 发版强更）**拖到黑底条上会被直接拒绝并提示**。若客户端仍是 0.2.10 之前旧版（强更未拉到），旧行为是静默新建一条 video 轨插入、落点在下半区时预览完全看不见（按一次 `Ctrl+Z` 可整条撤销）——先重启客户端吃到强更。不想要黑底加 `--no-black-bed` 重跑即剥净。

**本地素材模式（`matrix index` / `--local`）**：素材不必入云端素材库，用你本地的素材文件夹（视频+图片混合）直接检索铺轨：

```bash
gtrk matrix index --dirs <素材夹或素材文件,...>                # ① 免切片建索引：内容指纹增量、断点续传，素材改名/移动不重算
gtrk matrix --local --dirs <素材夹或素材文件,...> --project <目录>  # ② 本地检索铺轨（--lay 0 = 只出 plan 不铺轨；传单个素材文件即把检索域收窄到它）
gtrk matrix lay --project <目录> [--plan <path>]               # ③ 消费（可编辑后的）plan 铺轨，零检索开销
```

- **路径里有英文半角逗号就重复传**：`--dirs` / `--materials` 缺省按半角逗号分隔；路径自带逗号时改成重复传（`--dirs "A" --dirs "B"`，**累加不覆盖**）。整串在盘上存在时会自动不拆，中文全角「，」从不参与拆分。**枚举报 `0/0` 时先看这一条**，其次看素材夹里有没有断链（失效的软链接）。
- **素材本体永不上云**：只把 512px 抽帧图送同合云自建 embed 端点向量化、即传即弃；产物以绝对路径直引本地原文件（免下载免代理）。索引按实际抽帧张数会话计量（跑前预扣、跑完多退少不补），文本检索零积分。
- **图片一视同仁**：图片可检索可铺轨；被选中时经云端 `image_move` 转 5 秒运镜视频入轨——**图片本体会上云**（2 积分/张，铺轨前汇总确认；同图同参恒复用不重复扣费）。零图片上云 → `--no-image-broll`。
- **同素材不二用**：单轮铺轨一个素材单元全局只用一次（本地视频按场景、图片按文件），候选枯竭宁空不重复；`--dedup-scope material` 收严到文件级。
- **含本地素材的工程不能云渲**：提交会被拒（`local_broll_cloud_render_rejected`）——走客户端本地出片或 `gtrk render`。
- **可选零件**：`matrix describe --plan <path> [--top-k N]` / `--materials <a,b>` 按需理解候选（VLM 描述/标签/质量分/水印·字幕·黑边·模糊信号，1 积分/张（**异步任务计费**：提交预扣→完成结算，失败自动退款；同合云内部成员豁免，跑时自动探测，`--json` 的 `credits_estimated` 即实耗、`credits_would_be` 为原价）、产物注入 plan 并本地缓存、缓存命中零计费、>20 张确认护栏）。**一条 describe 只代表一段**：`--plan` 形态每个候选只抽 `segments[0]` 的 best 一帧，产物带射程锚点 `describe.at_sec`（素材时基秒），跑完报「理解覆盖率 = 理解帧数 / 被理解候选携带的**段总数**」（`--json` 读 `describe_coverage`）——注入 N 条 ≠ 这 N 条候选都被看过；`--source-window <start,end>` 源时间窗过滤（仅 `--local`，影视解说式「第 N 段解说配影片第 N 段邻域画面」）；`matrix lay --mark-weight <0..1>` 把 describe 的质量分融进候选排序（融合分 = sim×(1-w)+(mark/100)×w，只重排序不改准入，无缓存候选按中性处理）。
- **看点准则**：`--highlight-rubric <text|@file>`（describe 与 lay 同参，≤2000 字符，`@<路径>` 从文件读）给看点分（`--highlight-weight`）指定**评判基准**——垂类图纸各持一份（美食判分量对比/价格实物，旅拍判奇观地貌/极端天候）。**不传 = 整个字段不上行、服务端走领域无关缺省，与本参数引入前逐字节一致**。看点分按准则分桶缓存：换准则只重打分、客观描述缓存照常复用不被覆盖；`describe --plan` 会把本轮准则的 `rubric_hash` 钉进 plan，`lay` 据此自动取同一个桶（无需重复传参），两者不同源时**硬失败**而不是静默择一。⚠️ 换准则要重新打分就得重新看片（按张计费）——免看片的文本级重打分要等服务端轻通道，现在没有。
- **索引参数与量纲**：`--scene-threshold` 调场景切分粒度、`--stability-threshold` 固定机位判稳收敛抽帧、`--rebuild` 强制重建（理解缓存不清）；索引跨机不可移植（键=绝对路径，换机重跑 index 即可）。本地 score 量纲与云端不同（完美命中可低至 ~0.25），`--score-floor` 别按云端直觉调高。

**`gtrk matrix material "<词>"`（通用三态素材检索）**：与上面的 B-roll 检索并列的第二条线，出**整条素材**的下载直链（不是段落）——`--scope clip|image|audio`（缺省 `audio`，BGM 主场）、`--commercial-only` 只搜可商用（**按需收紧的显式开关，缺省不带**）、`--min-duration/--max-duration` 按成片时长挑、`--top-k`（缺省 5，服务端上限 50）、`--diversity` 去同质、`--json` 机读、`--out` 落盘。

> ⚠️ **`is_copyright` 读作「能不能商用」，不是「有没有被版权保护」**：`true` = **可商用**（自有 ∪ 已授权），`false` = **不可商用**。
>
> **`false` 不要读成「无版权、可以随便用」——它恰恰相反。** 决定性反证：他人版权的概念素材入库固定写 `is_copyright=0`；这个字段若真是「是否受版权保护」，那批必须是 1。
>
> 这条警示是真机踩出来的：2026-09-02 有 AI 执行方连着两轮**特意去挑 `false`** 当「安全选择」，把不可商用素材铺进了 5 个工程，而唯一安全的 `true` 反倒被主动避开。所以 `--json` 里 CLI 会逐条**派生一个人话标签 `copyright_label`**（`"可商用"` / `"不可商用"`）——它由 `is_copyright` 推出、与之恒同向、缺席同缺席，判读认这两个键之一即可，别靠字段名去猜。
>
> 该字段**只有矩阵成员口才有**：公开口没有它不是「不可商用」，而是服务端在源头就只放可商用素材（缺席即无需判，CLI 如实缺省、绝不补假值）。
>
> **缺省口径（⟲ 2026-09-06）**：矩阵成员档**缺省搜全库**（`copyright_scope=all`，含非商用/概念素材）——那正是成员身份买到的东西，命令不会替你收紧，随包 skill 也不许「保险起见」自行剔掉 `is_copyright:false` 的候选（但会**逐条如实标注**版权状态）。只要可商用时，自己加 `--commercial-only`。

编排配方（纯匹配 / 先理解后铺 / 时间窗 / 素材先行编剧 / 三层层叠）与 plan 编辑口径见随包 skill `/gtrk-matrix`。

### `gtrk mg` — MG 动态图颗粒（铺轨 / lint / status / render）

消费 `gtrk split` 落地的 `dispatch.mg` 派单，把**你栏目的 MG 生产 skill** 产的 html-particle 颗粒铺进 `.gtrk` 工程的 `beat_track`。六种模式按首个 positional 分派：**无参 = 铺轨**、`mg lint <file>` = 单文件校验、`mg status` = 编排看板、`mg render <file>` = 独立颗粒云渲（脱离工程，精剪补给口）、`mg compile <ir.json>` = 改 IR 重编译文字模板、`mg edit <file> --say` = 自然语言改写文字模板。旧名 `gtrk rrv` 保留为弃用别名（会打提示，建议改用 `gtrk mg`）。

| 参数 | 作用 | 缺省 |
|---|---|---|
| `--project <dir>` | oralcut / split 产物目录（定位 `split/dispatch.json` 与工程 `.gtrk`） | — |
| `--dispatch <path>` | 显式指定 `dispatch.json`（非标准布局兜底） | 由 `--project` 推 |
| `--only <beat>` | 只跑单 beat（收 **beat id** 如 `B12`、非 `composition_id`；主 + 其 `-aux<n>` 叠层颗粒一并选）。**真增量合并**：只重铺命中的那几颗，轨上其余已铺颗粒（连同手调）原样保留 | 全部 |
| `--lint-only` | 只 lint 校验，不铺轨不写回 | 关 |
| `--replace-all` | 显式授权**重置整轨**：不走增量保留、整轨剥掉重铺——**会删掉轨上其余已铺颗粒** | 关 |
| `--duration <sec>` | **render 模式必填**：显式时长锚（秒）——独立模式无坑位包络，它同时是 lint 包络、成片时长与计费时长 | — |
| `--format <fmt>` | render 模式产物格式：首发仅 `qtrle`（剪映可读透明 MOV；`webm` 剪映不吃、明确拒绝） | `qtrle` |
| `--out <dir>` | render 模式落盘目录（绝不写剪映草稿目录——拖入剪映由你做） | `./mg-render/<composition_id>/` |
| `--yes` | render 模式：跳过计费预估确认 | 关 |
| `--json` | 机读：人读日志转 stderr，stdout 只输出结果 JSON | 关 |

- **铺轨**（`gtrk mg --project <dir>`）：读 `dispatch.mg` → 逐 beat 从 `<project>/mg/<composition_id>.html` 取源颗粒 → lint → 铺进 `beat_track`，把 `struct_meta.mg` 原子写回 `.gtrk`（幂等登记自产轨 `lay_tracks`，重铺先剥旧自产物再 append、用户手加轨零连带）。「透明叠加 / 满屏底层」由颗粒 HTML 根 `background` 反推的 `opaque` 决定。缺 HTML / lint 失败的 beat 计入 `skipped`、不拦其余。
  - **剥离面 ≠ 「本次铺什么」，也 ≠ 「登记轨全集」**：`--only <beat>` **只剥命中的那几颗**（真增量合并）——轨上其余已铺颗粒的 clip / 素材 / 登记条目**原样保留**，连同用户在 opencut 对它们的手调（保留的是既有 clip 原件，非照登记重建，故透明度 `opaque` 不会丢）；这些保留条目**不重新 lint、不重新复制源 HTML**（工程自包含，`<project>/mg/` 下源文件删了也不影响）。全量重铺仍是「剥净再整轨重建」，**唯一例外**是本次派单里有、却因缺 HTML / lint 未过 / 重投影后零存活而**没铺成**的那几颗——它们上一轮的 clip 保留在轨上（不因为新的做坏了就把旧的也毁掉）；反之**派单里已不存在**的已铺条目仍照剥（计划变更 ≠ 做坏了）。要连其余已铺颗粒一起剥掉重来：`--replace-all` 显式授权。
  - **素材表不囤积**：素材的剥离键按「**自产身份 × 零引用**」判（自产 = `mg-`/`rrv-` 前缀 **或** 落在 CLI 独占的 `assets/mg/` 下且文件名在自产登记里），**不认客户端可改写的 `html_material` 前缀**——所以在 opencut 里编辑过工程之后重铺，旧素材照样剥得掉，`mg-` 素材数**恒等于轨上颗粒数**，历史遗留的重复 / 孤儿条目一并清掉。**非自产素材零连带**（`broll-*` / `ex-solid-*` / 你自加的，哪怕零引用也不碰）；仍被存活 clip 引用的自产素材也不剥（不会剥出失联 clip）；盘上 `assets/mg/` 的 html 副本从不删。
  - **「一条都没定位到」不是清空指令**：`--only` 打空、`dispatch.mg` 为空/缺失、或本次条目全被 skip，**而轨上已有已铺颗粒**时，同样拒绝写回（那是派单或选择器出问题的信号）。确要清空加 `--replace-all`。首次铺轨（轨上本就没有已铺条目）不受此限，照常走完报 `laid=0`。
  - **槽位窗口现场重投影**：铺轨与 lint 之前先用「`transcript` × 当刻 `.gtrk`」重算每条队列条目的 `[track_st, track_ed]`，之后 lint 的坑位包络（铁律⑦）与落轨 clip 时长一律以重算值为准（`--only` 同守；aux 派生颗粒按**自己的** span 重投影，不与主 beat 窗口混同）。`dispatch.mg` 里的时码只是**投影时刻快照**，仅在重投影不可行时兜底——**改完口播轨直接铺即可，不必先重跑 `gtrk split`**。`--json` 恒出 `reprojection:{mode,degraded,reason?,drifted,max_offset,shrunk,dropped}`（`--lint-only` 也有）。重投影后**零存活**的条目 skip 并计入 `skipped`（不复制 HTML、不按快照铺回去）；重投影不可行（transcript 缺失 / 工程定位不到 / 主轨查不到口播素材）→ 降级用快照 + 告警 + `--json` 标注，退出码不变；工程**非 v1** 的既有行为不变（铺轨路径版本门非 0 退出、`--lint-only` 照旧出报告）。铺轨成功会把本次时码来源（`timecode_source` / `reprojected_at`）纯追加登记进 `struct_meta.mg`。
- **lint**（`gtrk mg lint <颗粒.html> [--dispatch <path>]`）：纯本地静态校验颗粒 HTML 的铁律机器可判定子集（`<template>` 包裹、`data-composition-id` + 1920×1080、`gsap.timeline({ paused: true })`、`window.__timelines` 注册、无 `Math.random` / `Date.now`、自包含无相对外链、根 `background` 与 `opaque` 自洽…）；给 `--dispatch` 时校验 `composition_id` 命中派单。任一致命项非 0 退出并逐条报因。
  - **期望 id 一致性**（`1-cid-expect`，**致命**）：HTML 内 `data-composition-id` 必须等于期望 id（铺轨=该条派单的 `composition_id`；`mg lint`=文件名，仅当它命中派单或形如 `…-B<数字>[-aux<n>]` 时比对，`./tmp.html` 这类改过名的副本不比对）。防的是「复制 `<id>.html` 改名时漏改内部 id」——落轨会写出以文件名命名的 clip/material，而文件注册的是另一个 `__timelines` 键、还与同名颗粒抢同一个样式作用域。
  - **铁律⑦ tl 总长估长**（`7-fill-slot` / `7-no-estimate` / `7-infinite-repeat`，**恒非致命、不拦铺轨**）：已知坑位包络时（铺轨逐颗；`mg lint --dispatch` 命中派单条目）对 GSAP 时间线做**静态下界估算**——逐调用降级，能解析的计入（`duration×(repeat+1) + repeatDelay×repeat`，`yoyo` 不加时长），表达式 position / 非字面量 duration 那条**跳过不计**（忽略若干调用仍是合法下界）。估长 < 包络 → 告警；一条都算不出 → 显式提示「无法静态估长，铁律⑦未校验，须真引擎 seek 验收」（**不静默**，「算不出」与「算过且通过」在输出上可区分）；含 `repeat:-1` → 告警「无限循环令总长 Infinity、铁律⑦不可静态验证，请改按坑位算死的有限 repeat」。真判据永远是渲染引擎逐帧，本项只做提醒层。
  - **铁律⑧重复图元合并**（`8-primitive-merge`，**恒非致命、不拦铺轨**）：识别「循环体内创建，或由循环调用具名工厂创建；落到同一父节点；且没有逐元素动画驱动」的可合并 `line` / `rect` / `path` / `polyline` / `polygon` 批次。同一父节点的纯数字循环 trip count 累加后 **≥ 8** 才报数；边界含 `.length` / 具名常量而算不出时仍报「条数未知」，不做常量折叠；逐元素 `gsap.set` / tween 或被 tween 首实参使用的元素数组会被排除。本项只提示「这里有一批可**无损**合并的重复图元，合并后画面逐像素不变」，**不是风险判定**：命中不代表该颗粒会复现缺陷，未命中也不代表安全，真判据仍是真渲染出片抽帧。
  - **回调与 seek 语义**（`x-callback-driven` / `x-engine-api-override` / `x-raf-interval`，**恒非致命、不拦铺轨**）：对齐契约同名一节（2026-07-26 增补）。GSAP `seek(t)` 默认抑制回调 → 补间属性照常插值、但 `onUpdate` 里的 DOM 写入不执行，翻车形态是**画面定在初始态而非黑屏**。契约把保证压在**引擎侧**（定帧 MUST 用 `seek(t,false)` / `time(t)` / `progress(p)`），故颗粒**用回调驱动画面是合规写法**；lint 这三项只是**哨兵**：`x-callback-driven` = 回调写 DOM 且无任何 seek 兜底（有兜底则沉默，避免重复提醒）；`x-engine-api-override` = 颗粒运行时覆写 `tl.seek` 或把 `__timelines[…]` 换成包装对象（会推翻引擎显式传的 `seek(t,true)`，且引擎改走 `time()`/`progress()` 即失效，属过渡态）；`x-raf-interval` = 含 `requestAnimationFrame(` / `setInterval(`（自有时钟不被 seek，等于冻结）。三项 MUST NOT 致命——「用回调驱动画面」不是违规。
- **status**（`gtrk mg status --project <dir>`）：汇总 MG 流水线——`dispatch.mg` beat 总数 / 已产源 HTML 数 / 已铺进 `.gtrk` 数，并逐 beat 标注（缺 HTML / 已产未铺 / 已铺）。
- **render**（`gtrk mg render <颗粒.html> --duration <sec> [--out <dir>] [--yes]`）：**脱离工程**把单颗颗粒云渲成剪映可读的 qtrle 透明 alpha MOV（精剪补给口——粗剪导剪映后缺一颗动态图，不回客户端就能补）。链路 = lint 前置（包络 = `--duration`，任一致命项本地拦截、零提交零计费）→ **计费预估确认**（实时查价；CLI 无本地 HTML 渲染引擎，独立颗粒唯一路 = 云渲计费任务，`--yes` 跳过确认）→ 内联提交云端 → `<composition_id>.mov` 落盘 + `task.json`/`result.json` 面包屑（崩溃可凭 task_id 恢复）。**射程**：首发只出 qtrle（`--format webm` 明确拒绝，剪映不吃 VP8-alpha）、只收 1920×1080 颗粒（契约未开竖屏/异形口）、`--duration` 必填。产物不进 `.gtrk`、不写剪映草稿目录；qtrle 无损体积偏大，适合秒级颗粒。注意与 `gtrk render`（整片成片渲染）同词不同物。
- **fetch**（`gtrk mg fetch <检索词|块名> [--top 3] [--all]` / `gtrk mg fetch --pick <块名> --slot <beat> --project <dir>` / `--pick <块名> --as <composition_id> --duration <sec> [--out <dir>]`）：**registry 中性颗粒源**——没建栏目也能出 MG。候选态**离线**（快照随包、钉死来源 commit）按检索词列 2–3 件（含 compat 标记与海报链接）；取块态按三源顺序取块（我方镜像优先、jsdelivr、GitHub raw，每源 5 s，**逐源 sha256 强校验**，三源皆败零落盘）→ 机械改写八条（`<template>` 包裹 / 改 id / 去 data-start 贴坑位 / 实心底下沉子层 / GSAP 源换契约 CDN / 字体换运行时镜像可证的 CJK 字体 / 时长贴坑位 / 信箱缩放不拉伸）→ `gtrk mg lint` 致命项不过不落盘 → 落 `<project>/mg/<composition_id>.html`。**骨架不是成品**：返回的 `editable`（文案 / 数值数组 / 色值）MUST 按 beat 与栏目改写后再铺。契约当前只收 1920×1080 颗粒，其它画布拒绝；`excluded` 件拒取，`review` 件（canvas / 铁律 8 高危形态）可取但须真渲验收。`GITRUCK_MG_REGISTRY_BASE` 可整体覆盖取块前缀。
- **fetch --source text**（`gtrk mg fetch --source text <检索词> [--top 3] [--offline]` / `--pick <模板 id> --slot <beat> --project <dir>` / `--pick <模板 id> --as <composition_id> [--out <dir>]`）：**同合云自家的文字特效模板库**——与中性块是两条路。模板是我方 clean-room 重写的**成品**（配色与排版已做过），**不做机械改写、MUST NOT 直接改 HTML**。每颗内嵌产生它的 IR 与双哈希，颗粒因此自带出身证明（三态 `ir` / `detached` / `html`）；手改一个字节就掉成 `detached`，云端改写会拒绝它（`gtrk mg lint` 报非致命的 `x-ir-detached`）。目录走**远端择新、随包兜底**：优先取镜像上的 `catalog.json` 按 `version` 择新并缓存 24h，三源皆不可达时回落随包那份并**明示**（候选态因此永远离线可用）。取块仍逐源 sha256 强校验，三源皆败零落盘。`GITRUCK_TEXT_TEMPLATE_BASE` 可整体覆盖取块与目录前缀。
  **落点与时长由命令钉定**：派单模式的 `composition_id` 取自 `dispatch.mg` 那条（`<工程slug>-<beatId>`，不是 `--slot` 收的 beat id），颗粒内嵌 IR 的 `id` 与 `canvas.duration` 被钉到「期望 id」与「坑位包络 + 0.3s 余量」（铁律⑦，贴模板末尾的层跟着钉），再走 `mg compile` 同一条本地编译链重编——产物仍是 `ir` 态，`1-cid-expect` 天然对得上。独立模式 `--as` 同样改写颗粒内部 id，`--duration` 钉时长；`--slot` 与 `--duration` 互斥。两者都没改时原字节落盘。
- **compile**（`gtrk mg compile <ir.json> [--out <dir>]`）：把 IR 交给云端**确定性编译**成颗粒（**0 积分**）。改字、换色、改字号描边阴影、改时长都走它——改 IR 再编，比手改 HTML 干净，且颗粒保持 `ir` 态（云端还能继续调）。**本地没有编译器**是有意的：第二份编译器意味着第二套产物字节，而三态身份判的就是字节。
- **edit**（`gtrk mg edit <颗粒.html> --say "<一句话>" [--n 1|3] [--pick <k>] [--yes]`）：自然语言改写文字模板颗粒，经云端模型链出候选。`--n` 只收 1 或 3，**它就是计费单位数**（2 积分/候选，首次与改写同价、无免费次数）。`detached` / 无内嵌 IR 的颗粒**本地就拒**，不提交云任务、不花钱。候选带 `scope`：`L1` = 在模板可调范围内、`L2` = 越界即新生成（**不是失败**）；服务端说做不到时给一句 `refusal`，命令如实转述并以非 0 退出码区分于网络错误。不给 `--pick` 就只落候选不动原文件；给了才替换并留 `<cid>.bak.html`。

`--json` 输出：`{ ok, mode:"lay"|"lint"|"status", … }`（各模式带对应字段，如铺轨的 `laid` / `skipped`、status 的逐 beat 状态）。铺轨模式另带 **`track_total`**（轨上现存已铺数）、**`kept`** / **`kept_ids`**（其中**上轮遗留**、本次没重铺的颗数与 `composition_id` 清单）与 **`removed`**（本次被剥的旧自产颗粒数）——`laid`（本次）、`track_total`（轨上共）与 `kept`（上轮遗留）**要一起读**，恒有 `track_total = laid + kept`；只看 `laid` 会让「铺 1 颗、剥 20 颗」跟「补铺 1 颗」长得一模一样，只看前两个又会漏掉「轨上那几颗不是这一轮的版本」这条代价（`kept_ids` 与 `skipped` 会重叠：这轮没铺成、上一轮那条还在轨上）。非全绿时另带机读 **`reason`**：`skipped`（部分没铺上）/ `empty_queue`（**拒写回**，工程未被改动，另带 `refused:true` 与 `blocked[]`）/ `no_project`（工程缺失未铺轨）。真写回过的运行另带 **`integrity`**（素材落盘自检，与 `gtrk matrix` 同名同形，口径见上节）。

> **退出码**：铺轨与 `--lint-only` 的 `ok:false` **一律连带非 0 退出**（含「有 beat 被 skip」这种循环中途的正常态）。agent 别把非 0 读成「命令崩了」——按 `reason` / `skipped` 判断即可。

> **aux 叠层颗粒**：`gtrk split` 若在某 beat 的 `aux_layers` 派了 `overlay` 颗粒，会派生 `<beat>-aux<n>` 合成条目进 `dispatch.mg`——`gtrk mg` 一并铺，实现「同段既有底轨主视觉、又叠透明概念图解」。
> **双读兼容**：`dispatch.mg`（读旧 `rrv_mg`）、源目录 `mg/`（读旧 `rrv/`）、素材前缀 `mg-`（读旧 `rrv-`）——去品牌化前的既有工程零迁移。

### `gtrk project init` / `gtrk audio lay` / `gtrk audio tighten` — 音频驱动工程零件（配音先行）

不从口播毛片、而从**一条配音**起盘的工程入口：先有配音（TTS 合成或自己录的），`project init` 建好 `.gtrk` 工程，之后 `gtrk split --project` 投影拆分照常接成片流水线；`audio lay` 则给任意工程补音频轨（BGM/配乐）；`audio tighten` 收紧配音的句间停顿。

| 命令 | 作用 |
|---|---|
| `gtrk project init --tts-task <task_id>` | **主路**：引用一个已完成的 `audio_tts_clone` 配音任务——服务端直取产物音频与句级时码（零 ASR、零额外计费），音频下载落工程 `audio/` |
| `gtrk project init --audio <配音> --transcript <transcript.json>` | **兜底路**：自备配音音频 + 句级时码稿成对给（时码稿由 `gtrk transcript <配音音频> --json` 产出；TTS 合成的配音请走主路，别重跑 ASR） |
| `gtrk audio lay --project <目录> --file <bgm.mp3>` | 往工程追加一条音频轨；**同源幂等替换**（同一来源重跑替换不堆轨、零引用保护剥旧）；`--volume <0..1>`（默认 0.1 垫底音量——契约 volume 只写线性增益、不写 dB；客户端音量面板显示 -20.0，两侧同一标尺）、`--offset <ms>` 定入点 |
| `gtrk audio lay … --beat-align` | **高潮点锚定**（`audio_music_analyze`，计费一次）：把 BGM 的情绪峰值 `H`（服务端 `highlight.time`）压到成片高潮点 `A` 上，映射恒为 `轨秒 = A + (BGM 秒 − H)`；**两侧都够长就零平铺**（恰好 1 个 clip），不够长才按小节线平铺补齐、接缝吸附 downbeat（轨的两个硬边界处的截断不吸附）。`A` 取自 `struct_meta.split.beats` 的判据链：升华段 → 容器转折 → 回扣段 → `0.75×全片`兜底，**命中哪一档 CLI 如实报出，兜底档会明示是猜的**。无 Key / 分析失败 / 曲子缺高潮点一律降级为不锚定，命令不失败 |
| `gtrk audio lay … --beat-align --climax <轨秒>` | 高潮点**逃生门**：一律覆盖上面那条判据链。越界（≤ `--offset` 或 ≥ 工程末尾）或非数**直接报错**，不静默回落 —— 显式给错了值要当场知道。须与 `--beat-align` 同用 |
| `gtrk audio lay … --no-loop` | 不平铺补齐：开了 `--beat-align` 时只放锚点那一段、头尾留白（**留白秒数如实报出**）；未开 `--beat-align` 时保留单次、不循环叠满至工程末尾 |
| `gtrk audio tighten --project <目录>` | 收紧配音轨的**句间**停顿（**纯本地、零计费**）：只压跨句界的静音，**句内换气与原声引用段不动**，出参如实报「跳过句内换气 N 处」。`--keep <秒>` 收紧后保留的静音、`--min-silence <秒>` 短于此不动、`--boundary-tol <秒>` 判「贴着句界」的容差、`--dry-run` 只报会压几处共几秒、不写盘。三个缺省值见 `gtrk audio tighten --help`（实测认可值，换题材/音色可调） |

`project init` 另有 `--canvas <WxH>`（默认 1080x1920）、`-o/--out`、`--reupload`、`--no-open`、`--json`，语义与 `oralcut` 一致；两命令 `--json` 恒出单行结果 JSON（人读日志走 stderr）。

> ⚠️ **`--beat-align` 的语义在 2026-09-02 整套换过**（change `redesign-beat-align-climax-anchor`，主理人拍板）。旧实现是「把整条 BGM 后推 `firstDownbeat` 秒」—— 分析的是 **BGM 自己的时间轴**，工程时间轴里根本没有它的消费方，净效果只是**付一次云端分析的钱换来片头一段等长静音**。
> ⇒ **开过 `--beat-align` 的旧产物不再逐字节可复现**；没开这个 flag 的缺省路径产物**字节零变化**。

> **`tighten` 该在铺轨之前跑**：它会改配音轨时长，`gtrk split` / `gtrk matrix` 的 beat 时码按当刻工程重投影——先收紧再铺轨，省一次返工。想要合成时就对，自训音色可在 TTS 阶段直接传 `--fragment-interval`（见下节 `audio_tts_clone`）；云引擎音色不支持该参数，才用本命令在合成之后收。

### `gtrk tool <name> [输入...]` — 单点工具族

单发单收的独立能力，与成片管线的车道命令（`oralcut`/`split`/`matrix`/`mg`）分家。**顶层命令 + 首个 positional 词分派**（不用父子命令）：`gtrk tool <name> [输入...]` 跑工具（多文件图片工具可传多个路径，顺序即拼装顺序），`gtrk tool list` 查全部。一个工具 = 一个薄 descriptor（输入类别 / payload 拼装 / 产物映射 / 计费 / 可用门），共享 runner 跑「校验 → 上传（指纹缓存、≥256MiB 自动分片）→ 提交 → 轮询 → 流式下载落地 → `task.json`/`result.json` 面包屑」——接新工具只加一个 descriptor、不写编排。

**产物目录口径**：有输入文件的工具缺省落**输入同目录**下 `<输入名>-<工具名>/`；`input=none` 的工具（如 `audio_tts_clone`）缺省落**当前目录**下 `<工具名>-<时间戳>/`。两者都可用 `--out <dir>` 覆盖。缺省名撞上已有目录时自动带 `-2`/`-3` 序号后缀，同一目录内产物文件撞名时带 taskId 后 6 位后缀——**一律以回执的 `outDir` / `files` 为准，别按名字硬拼**（`--out` 显式落点不派生序号，重跑同一输入是幂等覆盖）。

| 工具 | 输入 | 产物 | 计费 | 状态 |
|---|---|---|---|---|
| `image_move` | 单张图片；可选 `--motion` 指定 26 种运镜之一 | 运镜视频（几何按原图朝向推导：横 1920×1080 / 竖 1080×1920） | 运行前实时查询 | 已上线 |
| `image_matting` | 单张图片 | 透明背景 png（可 `--param` 请求背景底板） | 运行前实时查询 | 已上线 |
| `image_blackborder_remove` | 单张本地图片 | 去黑边图片 | 运行前实时查询 | 已上线 |
| `image_canvas_adapt` | 单张本地图片；可选目标宽高与 `normal` / `rectangle` / `square` | 比例适配图片 | 运行前实时查询 | 已上线 |
| `image_purify` | 单张本地图片；可选 `full_screen` / `region` 与区域框（仅处理你有权处理的素材） | 清理水印、Logo 或叠加元素后的净化图片 | 运行前实时查询 | 已上线 |
| `video_matting` | 单条视频（**≤10 分钟**，原片直传不压代理） | 透明背景 webm | 运行前实时查询 | 已上线 |
| `video_blackborder_remove` | 单条本地视频 | 去黑边视频 | 运行前实时查询 | 已上线 |
| `video_canvas_adapt` | 单条本地视频；可选目标宽高、片段、画布模式和无音轨输出 | 比例适配视频 | 运行前实时查询 | 已上线 |
| `video_stabilizer` | 单条本地视频；可选 `fast` / `exp` / `turbo` | 防抖视频 | 运行前实时查询 | 已上线 |
| `video_vaporwave` | 单条本地视频；滤镜使用精确预设名称 | 蒸汽波滤镜视频 | 运行前实时查询 | 已上线 |
| `video_purify` | 单条本地视频；可选 `full_screen` / `subtitle` / `custom` / `region`、`ffmpeg` / `raft`、归一化 ROI 与可带时间段的区域框（仅处理有权修改的素材） | 一条净化视频 | 运行前实时查询 | 已上线 |
| `video_upscale` | 单条本地视频（**≤1 分钟**）；可选 `2` / `3` / `4` 倍与 `Reality` / `Anime` | 一条超分视频 | 运行前实时查询 | 已上线 |
| `video_interpolate` | 单条本地视频；可选 `2` / `3` / `4` 倍，不附加 1 分钟限制 | 一条插帧视频 | 运行前实时查询 | 已上线 |
| `video_segment` | 单条本地视频；可选 `--detector content\|adaptive`、`--threshold` | 分镜区间结构 `result-output.json`（结构化数据，非下载文件） | 运行前实时查询 | 已上线 |
| `video_ai_segment` | 单条本地视频；可选 `--segment-mode scene\|shot_type\|narrative\|subject` | 语义分镜结构 `result-output.json`（结构化数据，非下载文件） | 运行前实时查询 | 已上线 |
| `video_motion_cut` | 单条本地视频 | 运镜/高光片段结构 `result-output.json`（结构化数据，非下载文件） | 运行前实时查询 | 已上线 |
| `video_speaker_detect` | 单条本地视频；可选 `--language`/`--max-faces-per-frame`/`--detect-body`/`--track-sample-fps`（重 GPU） | 可见说话人结构 `result-output.json`（时基以服务端输出为准） | 运行前实时查询 | 已上线 |
| `video_face_track` | 单条本地视频；可选 `--sample-fps`/`--max-faces`/`--min-face-ratio`/`--enable-body-match`/`--similarity-threshold`；`time_ranges` 走 `--params-json`（重 GPU） | 人物 ID/时间段/轨迹结构 `result-output.json`（时基以服务端输出为准） | 运行前实时查询 | 已上线 |
| `audio_tts_clone` | **无文件**：`--text`/`--text-file` 二选一（≤5000 字）+ `--speaker` 必填；可选语言/格式/语速/切分法/字幕/**句间停顿**（`--fragment-interval <秒>`，**仅自训音色**；云引擎音色传了会**报错**而非静默忽略，合法区间由服务端校验并在报错里给出） | 配音音频 wav/mp3（+ 可选字幕）；按文本字符数计费，计量单位与单价以 `gtrk tool list` 实时显示为准 | 运行前实时查询 | 已上线 |
| `video_ai_subtitle` | 单条视频或音频；`--language <码>` 必填；可选 `--translate-language`、`--need-render`、`--need-pure`、`--subtitle-type`、`--subtitle-color`。默认只传本地抽出的音频（毛片不上传） | `.ass` 字幕 + 可选烧录/去字幕 `.mp4` + `result-output.json`（摘要 + 字级时间轴） | 运行前实时查询 | 已上线 |
| `subtitle_translate` | 单个**字幕文件** `.ass` / `.srt`；`--language <码>` 与 `--translate-language <码>` **双必填**；可选 `--output-format`、`--line-mode`、`--bilingual`、`--subtitle-type`、`--subtitle-color`、`--canvas <WxH>`。不含语音识别 | 译文字幕 `.ass` 或 `.srt` + `result-output.json`（条数统计 + 降级标记） | 运行前实时查询 | 已上线 |
| `video_long2short_pro` | 单条长视频（整片上传）；`--language <码>` 必填；可选 `--output-language`、`--main-topic`、`--output-size`、`--no-jump-cut`、`--duration-pref`、`--max-clip-sec`、`--split-screen`、`--split-orientation`、`--speed-factor`、`--no-camera-move`、`--no-subtitle`、`--subtitle-translate-language` | 逐条成片 `clip{i}.mp4` + 人读报告 `clips.md`（含润色降级明细） + `result-output.json` | 运行前实时查询 | 已上线 |
| `audio_separation` | 单条音频；可选 `--mode fast\|turbo` | 人声与伴奏音频（按实际返回可为一项或两项） | 运行前实时查询 | 已上线 |
| `audio_speaker_split` | 单条音频；可选 `--only-struct` | 各说话人 `.wav` 分轨 + `spoken_list` 时间线（`result-output.json`） | 运行前实时查询 | 已上线 |
| `audio_stretch` | 单条音频；可选 `--semitones <n>`、`--speed <n>`（>0） | 变调变速音频 | 运行前实时查询 | 已上线 |
| `audio_noise_reduce` | 单条音频或视频；可选 `--prop-decrease 0..1` | 降噪后的音频 | 运行前实时查询 | 已上线 |
| `audio_silence_remove` | 单条音频；可选静音阈值与保留时长 | 去静音音频 | 运行前实时查询 | 已上线 |
| `piano_audio_to_midi` | 单条音频 | MIDI 文件 `.mid` | 运行前实时查询 | 已上线 |
| `piano_audio_enhance` | 单条音频 | 高质量 WAV + 配套 MIDI（双产物） | 运行前实时查询 | 已上线 |
| `image_to_square` | 单张图片；可选 `--max-line <px>`（≤20000） | 方形图片 | 运行前实时查询 | 已上线 |
| `image_to_live` | 单张图片 | 约 4 秒短视频 `.mp4`（无声）；或安卓动态照片 `.jpg` + 附带同一条 `.mp4` | 运行前实时查询 | 已上线 |
| `image_classic_template` | **多张图片** + `--main-title` 必填；可选副标题/模式/比例/质量/数量/版式 | 封面/拼图成品（text/pic/render 三组、可多张） | 运行前实时查询 | 已上线 |
| `image_vertical_stitch` | **多张图片**（顺序=自上而下拼接顺序） | 一张垂直拼接长图 | 运行前实时查询 | 已上线 |
| `video_split_screen` | **2~16 段视频**（多 positional）；精确档 `--clips-json`（条目 `{input:0 起序号, begin_time_ms, end_time_ms, crop}`，毫秒时基）；九个可选布局/画幅/音频参数 | 一条分屏成片（成片时长对齐最短段） | 运行前实时查询 | 已上线 |
| `mad` | 一个素材文件夹（3~10 条视频）+ 可选 `--bgm` | AE 母合成成片工程 `.jsx`（仅支持 AE） | 仅 `--bgm` 触发实时查价 | 已上线 |

> 价格以 `gtrk tool list --json` 和执行前 stderr 的匿名实时查询为准，README 不保存价格快照。`video_matting` 上传前 ffprobe 探时长，> 10 分钟直接拒绝（不上传不提交、请先裁剪）。
> `mad` 是族内首个 **local 型「纯本地工具、可选云端加料」**：无 Key 可跑且不触发计费任务（技法数据经云端 manifest 下发 + `~/.gitruck/mad-cache` 缓存，**首拉联网、缓存后离线可跑**），`--bgm` 卡点才需 Key 并触发一次云端节拍分析；三级降级（有 Key 卡点 / 无 Key 或坏 BGM 固定节奏 / 云端失败降级）全程不崩。仅产 `.jsx`／仅支持 AE。

去黑边、比例转换、防抖、蒸汽波、净化、超分、插帧七个公共视频工具只接受服务端当前 `video_ext`：`.mp4`、`.avi`、`.mpg`、`.mov`、`.flv`、`.mxf`、`.mpeg`、`.ogg`、`.3gp`、`.wmv`、`.h264`、`.m4v`、`.ts`；`.mkv` 与 `.webm` 会在本地拒绝。输入必须是本地文件路径，CLI 不负责下载远端视频。

- `gtrk tool list [--json]` — 列全部工具（名称/说明/输入/产物/实时价格/状态）；`--json` 出单行机读数组（含动态 `billingHint`/`pricing`）。**无 API Key 也能跑**；价格通过公开接口匿名查询，失败仍列完整清单并标记暂不可用。
- `gtrk tool image_move ./photo.jpg [--motion zoom_in_center] [--json]` — 图转运镜；产物落 `photo-image_move/`。`--motion` 显式指定运镜方式（26 值：平移 8 `up_to_down`/`down_to_up`/`left_to_right`/`right_to_left` 及四对角线、放大锚点 9 `zoom_in_{up,down,left,right,left_up,right_up,left_down,right_down,center}`、缩小锚点 9 `zoom_out_` 同九方位），未传由云端自动选择；`--param width=1080 --param height=1920` 覆盖推导几何。
- `gtrk tool image_matting ./portrait.jpg` / `gtrk tool video_matting ./clip.mp4` — 图片/视频抠像。
- `gtrk tool image_blackborder_remove ./photo.jpg [--json]` — 自动裁去单张图片四周黑边。
- `gtrk tool image_canvas_adapt ./photo.jpg --canvas-width 1080 --canvas-height 1920 --canvas-type rectangle [--json]` — 图片比例转换；省略画布参数时沿用服务端默认。画布模式按实际运行时契约只接受 `normal`、`rectangle`、`square`，不接受旧文档中的 `fit`。
- `gtrk tool image_purify ./photo.jpg [--json]` — 清理你有权处理的图片中的水印、Logo 或叠加元素。
- `gtrk tool image_purify ./photo.jpg --purify-scope region --purify-region 0.02,0.02,0.15,0.08 [--json]` — 按框直接去除：不做识别，**框内全部内容都会被处理**；框越小、越贴近要去除的元素效果越好。
- `gtrk tool video_blackborder_remove ./clip.mp4 [--json]` — 自动裁去单条视频四周黑边并保留原音轨。
- `gtrk tool video_canvas_adapt ./clip.mp4 --canvas-width 1080 --canvas-height 1920 --canvas-type rectangle --clip-start 12 --clip-end 60 --without-audio [--json]` — 视频比例转换；`--clip-start/--clip-end` 是起止帧序号，省略字段时沿用服务端默认，画布模式只接受 `normal`、`rectangle`、`square`。
- `gtrk tool video_stabilizer ./clip.mp4 --stabilizer-method turbo [--json]` — 视频防抖；支持 `fast`、`exp`、`turbo`，其中 `exp` 为实验方式，产物观感需自行检查。
- `gtrk tool video_vaporwave ./clip.mp4 --vaporwave-filter "灼熱苦夏" [--json]` — 使用精确预设名称添加蒸汽波滤镜；省略时显式使用 `愈漸升溫`。
- `gtrk tool video_purify ./clip.mp4 --purify-scope custom --purify-method ffmpeg --purify-roi 0,0.78,1,0.2 [--json]` — 净化用户有权修改的视频；ROI 为归一化 `x,y,w,h` 且只和 `custom` 同用。`raft` 仅支持 20 分钟以内视频，`ffmpeg` 不套用该限制；不承诺还原被遮挡内容。
- `gtrk tool video_purify ./clip.mp4 --purify-scope region --purify-region 0.8,0.02,0.18,0.08,0,5 --purify-region 0.3,0.85,0.4,0.1,120 [--json]` — 按框直接去除，可重复给多个框（最多 16 个）；框后可带 `start,end`（秒，`end` 省略即到结尾）。不做识别，**框内全部内容都会被处理（包括画面主体）**；`ffmpeg` 在框内做模糊、`raft` 做修复补全，框越小、越贴边效果越好。`--purify-region` 只能和 `region` 同用。
- `gtrk tool video_upscale ./clip.mp4 --upscale-times 3 --upscale-type Anime [--json]` — 实验性视频超分；输入最多 60 秒，放大后任一边不得超过 4000 px，支持 `2`、`3`、`4` 倍和 `Reality`、`Anime`。
- `gtrk tool video_interpolate ./clip.mp4 --interpolate-multiplier 3 [--json]` — 视频插帧；支持 `2`、`3`、`4` 倍，不套用旧文档中的 1 分钟限制，原视频任一边不得超过 4000 px。
- `gtrk tool video_segment ./clip.mp4 [--detector adaptive] [--threshold 27] [--json]` — 机械分镜；产**结构化** `result-output.json`（`scene_list` 各段起止/时长），非下载文件。
- `gtrk tool video_ai_segment ./clip.mp4 [--segment-mode shot_type] [--json]` — 智能语义分镜；产 `result-output.json`（`categories[].shots[]` 含景别/标签/描述/秒级时码）。
- `gtrk tool video_motion_cut ./clip.mp4 [--json]` — 运镜/高光片段；产 `result-output.json`（`cut_points[]` 含帧号、秒级时码与运动特征）。
- `gtrk tool video_ai_subtitle ./clip.mp4 --language zh [--translate-language en] [--need-render] [--subtitle-color 湖蓝]` — 智能字幕：`--language` 必填，产 `.ass` 字幕 + `result-output.json`（LLM 摘要 + 字级时间轴）。**默认只上传本地抽出的音频**（毛片不出本地，几何随请求回传）；`--need-render` 改由**本地 ffmpeg 烧录**（缺 `思源黑体 CN Bold` 直接报错，不用替代字体顶）；`--need-pure` 需要画面，加了会整片上传。`subtitle_type`/`subtitle_color` 枚举与 `content` 详见云端 API 文档，`--params-json '{"content":{...}}'` 可透传。
- `gtrk tool subtitle_translate ./movie.ass --language zh-CN --translate-language en-US [--bilingual] [--canvas 1080x1920]` — 智能字幕**翻译**：把已有字幕换个语种，**两个语种参数都必填**。**与 `video_ai_subtitle` 的分界是输入形态**：从音视频里认出字幕走 `video_ai_subtitle`，把已有 `.ass`/`.srt` 换语种走本条（不重跑 ASR，也不覆盖已有校对）。`--line-mode keep` 让时码与输入逐条一致（可直接替换原字幕轨），缺省 `resegment` 译文更通顺但会改行数与时码；`.srt` 里没有画布信息，**竖屏务必传 `--canvas`**，否则按横屏折行可能出血。样式类参数仅 `ass` 输出有效，`srt` 输出叠样式会被服务端在扣费前拒。
- `gtrk tool video_long2short_pro ./talk.mp4 --language zh-CN [--split-screen] [--speed-factor 1.1]` — 长剪短·**精剪**：一键出成片，逐条 `clip{i}.mp4` + 人读报告 `clips.md`（含润色降级明细）。**与 `gtrk long2short`（粗剪）分工**：粗剪出可编辑工程（gtrk/剪映/PR）、毛片不上传、给人再剪；精剪只出成片、整片上传、计费约为粗剪两倍。判断句：剪完还要不要再动？要动走粗剪，不动走精剪。
- 上面三个是**分析型工具**：产物是结构化数据 `result-output.json`（非下载媒体），`result.json` 的 `resultFile` 指向它、`files` 为空且 `ok=true` 属正常。
- `gtrk tool audio_separation ./song.mp3 [--mode turbo]` — 人声伴奏分离；`--param need_vocals=false` 等低频字段仍可透传。
- `gtrk tool audio_speaker_split ./meeting.mp3 [--only-struct]` — 按说话人分轨：默认产各说话人 `.wav` + `result-output.json`（`spoken_list` 时间线）；`--only-struct` 只出结构不切文件。
- `gtrk tool audio_stretch ./song.mp3 [--semitones -3] [--speed 1.5]` — 变调变速；音高与速度独立，`--speed` 必须 > 0。
- `gtrk tool audio_noise_reduce ./interview.mp4 [--prop-decrease 0.5]` — 音频或视频均可输入，统一输出降噪音频。
- `gtrk tool audio_silence_remove ./talk.mp3 [--min-silence-len 800] [--desired-silence-len 200]` — 移除过长静音，只落处理后的音频。
- `gtrk tool piano_audio_to_midi ./piano.mp3` — 钢琴音频扒谱为 `.mid`。
- `gtrk tool piano_audio_enhance ./piano.mp3` — 钢琴录音修复增强，产高质量 WAV 主产物 + 配套 MIDI 副产物。
- `gtrk tool image_to_square ./long.jpg [--max-line 8000]` — 长图转方图；`--max-line` 默认 4000、上限 20000。
- `gtrk tool image_to_live ./photo.jpg [--output-format motion_photo]` — 让静态照片动起来。缺省产出约 4 秒的 `.mp4` 短视频（无声）；`--output-format motion_photo` 改为直出**安卓动态照片**（单个 `.jpg`，静图末尾内嵌该视频，相册里长按即播），并附带同一条 `.mp4`，两种格式同价。兼容边界：支持该标准的安卓相册可识别并播放；**iOS 不识别**，表现为普通静态图片；少数安卓机型可能只显示静图。
- `gtrk tool image_classic_template a.jpg b.jpg c.jpg --main-title "新品速览"` — 标题+多图出封面/拼图；`--output-pic-count`/`--output-text-count` 由服务端钳制 ≤20。
- `gtrk tool image_vertical_stitch top.png mid.png bottom.png` — 多图按传入顺序竖拼成一张长图。
- `gtrk tool video_split_screen a.mp4 b.mp4 --output-ratio 16:9` — 简单档：整段视频自动布局分屏（reaction/对比同框）。
- `gtrk tool video_split_screen a.mp4 b.mp4 --clips-json '[{"input":0,"begin_time_ms":0,"end_time_ms":5000},{"input":1,"crop":{"x":0.1,"y":0,"width":0.8,"height":1}}]'` — 精确档：按 0 起索引指定每段毫秒区间与归一化裁剪框；同一文件可多条目出多窗口。
- `gtrk tool video_speaker_detect ./talk.mp4 --language zh-CN` — 检测画面里谁在何时说话，出结构化 JSON（重 GPU）。
- `gtrk tool video_face_track ./talk.mp4 --params-json '{"time_ranges":[{"begin_time":0,"end_time":30000}]}'` — 人脸追踪/身份聚类，可限定时间段（**单位毫秒**；重 GPU）。
- `gtrk tool audio_tts_clone --text "欢迎收听本期节目" --speaker narrator` — 文字转配音音频（音色列表见官网文档）。
- `gtrk tool audio_tts_clone --text-file 稿子.txt --speaker sweet_female --output-format mp3` — 长文合成，缺省跟随音色调好的语速与切分参数。
- `gtrk tool mad ./素材 [--bgm 歌.mp3] [--duration 20] [--seed 42] [--technique 技法名,…] [--refresh] [--json]` — 一键剪 MAD：扫素材文件夹 → 选技法 → 单一 `.jsx`（AE 2020+ 跑一遍出母合成成片工程）。`--seed` 可复现；`result.json` 记 seed/数据版本/降级档位/选中技法。
- `gtrk tool mad --technique <技法名 | 别名 | pid,…>` — 只用点名的技法出片（不点名则按规则抽样）。名字歧义或不存在时报错列候选、零落盘；点到技法池里没有窗口的技法会说明原因并用剩下的继续。
- `gtrk tool mad --search <关键词> [--json]` — 只查技法目录不出片：按技法名/别名/类目做包含匹配，列出技法名、类目、`pid`、收录次数与池内窗口数。与 `--technique` 互斥；两者都零计费、不需 API Key。
- 通用：`--out <dir>` 覆盖产物目录、`--param k=v`（可重复）/`--params-json '<对象>'` 透传云端参数、`--reupload` 忽略上传缓存、`--json` 机读、`--ffmpeg-path <dir>` 指定 ffmpeg 目录。
- cloud 型工具缺 Key → 报错引导 `gtrk init`。产物下载失败（如链接过期 404）→ `result.json` 记 `errors`、`ok=false`、`task.json` 保留可凭 `taskId` 恢复。
- 净化、超分、插帧为长耗时 GPU 任务，描述器最多轮询 4 小时。等待超时不代表任务取消；保留 `task.json` / `result.json` 并按 `taskId` 恢复，不要直接重跑造成重复计费。

配套 skill `/gtrk-tools`（一个 skill 覆盖整个工具族）。

### `gtrk render <工程.gtrk>` — 本地渲染成片

```
gtrk render <gtrk> [-o <out.mp4>] [--crf <n>] [--codec <c>] [--ffmpeg-path <dir>]
                   [--no-qc] [--no-particles] [--particle-concurrency <n>] [-y|--yes]
                   [--no-open] [--json]
```

把 `.gtrk` 当 EDL 用本地 ffmpeg 出成片。**素材一律取本地原片**（`materials[].path`），云端不产成片。

**合成什么**：底轨（`track_index` 最小的非黑底垫轨）+ 全部音源，再按契约 z 序（`track_index` **升序**，越大越靠前）叠**全部可见叠加层**——overlay 视频轨（B-roll 候选 / AI 再现回铺）与 `beat_track` 的 MG 颗粒。

- **可见性只读 `hidden` 字段**（客户端的「小眼睛」）：关掉的轨整条不进片，如实计数告知。渲染器**不猜**哪条该叠。
- **多条候选轨都可见时成片取最上层**（= 客户端预览所见）。要换，在客户端关小眼睛或删轨。
- overlay 素材本地缺失（如 B-roll 代理没下全）**只降级不阻断**：该 clip 不叠 + 告警，片子照出。

**颗粒那一段有计费**（本命令唯一的云端出口）：

| 事 | 口径 |
|---|---|
| 为什么要上云 | CLI 无 HTML 渲染引擎，颗粒像素权威在同合云 Hyperframes；上行的只有**颗粒 HTML 文本**，素材本体不上行 |
| 计量 | **唯一颗粒数 × 未命中缓存数**（`html_render_simple`，按分钟）。同一颗粒在轨上出现 N 次只烤一次 |
| 缓存 | `<工程目录>/.tonghe-cache/particles/<sha256>.mov`，与**客户端导出剪映**那条链**同键同落点** ⇒ 任一端烤过，另一端直接命中 |
| 确认 | 有未命中即先出预估（总数 / 唯一 / 未命中 / 计费分钟）并要确认；`--yes` 跳过。**全命中不弹确认**（零计费不该有摩擦） |
| `--json` | 有未命中且未给 `--yes` ⇒ **硬拒**（机读模式没有 stdin，不静默提交计费任务） |
| 逃生舱 | `--no-particles` 零计费出无颗粒版；overlay 视频轨**照常合成**（那部分纯本地） |
| 拒绝确认 | 零云端调用、零文件写入退出 |

`--particle-concurrency <n>`（1–8，默认 6）调颗粒云渲并发。

`--json` 结果含 `particles: {total,unique,cached,rendered,billedMinutes,skipped[]}` 与
`overlay: {layers,particles,hiddenSkipped,missingMaterialSkipped,particleUnavailable}`——
**跳过了什么都有机读通路**，不会出现「铺了 65 颗、成片一颗没有、退出码 0」。

渲完自动质检并落 `.qc.json`（`--no-qc` 跳过）；质检结论只呈现、不改渲染退出语义（硬门控走 `gtrk qc --fail-on`）。

### 其它

- `gtrk install [--api-key … -y --skill-agents codex,cursor --all-agents --copy-skills --skills-dir …]` — 一条命令装全（skill + 配置 + 体检），对标飞书 `lark-cli install`。
- `gtrk init [--api-key … --api-base … --jianying-draft-dir … -y]` — 仅配置（交互 / 非交互）。
- `gtrk doctor` — 体检（含 CLI 版本 / 有无新版）。
- `gtrk deps status` — 查 ffmpeg/ffprobe 与渲染字体的**当前来源**（`--ffmpeg-path` / `~/.gitruck` / 系统 / 缺失）、版本、授权与源码地址。
- `gtrk deps install [--ffmpeg] [--font] [--force]` — 从同合云镜像安装运行时资产，**已存在则跳过**。
  - **不会静默自动下载**：任何缺失路径只报错并指向本命令（包体 30–90 MB，且分发物涉及授权，须由用户/agent 显式触发）。
  - 下载一律 https + **sha256 强校验**，校验不过即丢弃、不落地；解包调**系统 tar**（Win10+/macOS/Linux 自带），不引第三方解压依赖。
  - 定位优先级不变：`--ffmpeg-path` → `~/.gitruck/ffmpeg` → 系统 PATH。镜像只填中间那一格，**不越过你自己装的 ffmpeg**。
  - 字体落 `~/.gitruck/fonts`，烧录时经 ffmpeg `ass` 滤镜的 `fontsdir` 供给——**不装进系统字体表、不写注册表、不要管理员权限**。
  - 分发的 ffmpeg 为 GPLv3 构建，对应源码与二进制同处提供（见分发点 `SOURCE.md`）；**下载不附加任何使用限制**。
- `gtrk upgrade [--check]` — 升级 CLI 到最新版 + 刷新 skill（配置保留）；`--check` 只查不装。
- `gtrk skills install [--agents codex,workbuddy,comate,…] [--all] [--copy] [--dir <skills 目录>]` — 单独安装/刷新 Agent Skills；缺省由通用适配器与 gtrk 补充层自动检测。
- `gtrk skills recommend [--scene <id>] [--json]` — 第三方 skill 推荐目录：不带 `--scene` 列九个场景（hook / mg-explainer / kinetic-text / data-viz / map / ai-drama / collage / caption / principles），带场景按 tier 给条目（用途 / 安装命令 / 许可与依赖 / 登记命令）。**只推荐不打包**：目录随包分发、带快照日期、不联网不留痕；star 与许可以仓库页为准，装不装是你的选择。GPL / AGPL / 非商用 / 无许可证 / 只能经 MCP-SaaS 运行的不入目录。
- `gtrk skills add <owner/repo> [--skill <name>]... [--produces MG|AI_DRAMA|FILM_BROLL|script|none] [--column <id>] [--agents ...] [--all] [--copy]` — 透传通用 `skills` 适配器安装第三方 skill，成功后把 `{id, ref: "<owner/repo>#<skill>", produces, status: "third-party"}` **追加**进栏目配置 `style.skills`（同 ref 幂等、失败不登记；`--produces` 缺省取目录值，目录外仓登记为 `routing:"none"`），之后 `gtrk mg` / `/gtrk-ai-drama` 按 `produces` 即可解析到它。

---

## 工作原理

```
本地 gtrk CLI                          同合云                         本地三端
─────────────                      ─────────────                  ─────────────
毛片 ──上传(指纹缓存免重传)──▶  video_oral_cut 智能剪辑  ──产物──▶  客户端 gtrk/project.gtrk
                                  (一次出 gtrk/剪映/xml)            剪映  自动落草稿目录
源路径写进 gtrk materials.path                                     PR/FCP  导入 premiere.xml
```

- **gtrk** 是 timeline 的真超集 + HTML 颗粒，是同合云的统一工程契约；三端从同一份 gtrk 派生、切点一致。
- 云端**零改动**全用现成 `video_oral_cut`；CLI 只做编排（上传 / 提交 / 轮询 / 拉回 / 落位 / 打开）。

## 注意

- 剪映 / CapCut 草稿需 `draft_content.json` + `draft_meta_info.json` **成对**（且必须是这两个**精确文件名**，带前缀的扫不到）才被软件识别——要么 `gtrk init` 配好草稿目录、要么 `--jianying-draft-dir` 指定，否则只产 content、需手动导入。拷进草稿根这一跳由 CLI 统一落成固定名（`long2short` 逐 clip 同），产物目录里保留带 clip 前缀的归档原名。
- 多台机器盘符不同时，配置走 `~/.gitruck/`（用户级；旧 `~/.gtrk-cli` 首次启动自动迁移），产物默认落毛片同目录。
- 节奏预设强度以云端为准；`--preset` 只选预设、不改源裁剪。

---

## 结构

```
gtrk-cli/
├── src/index.ts              # commander 入口
├── src/commands/             # 子命令：install / init / oralcut / long2short / transcript / split / matrix / mg / project / audio / tool / render / doctor / upgrade / skills / …
├── src/lib/                  # cloud / column-config / splitdoc / projection / user-config / jianying / …
├── skills/                   # 打包的框架 skills（18 个，名单 = src/commands/skills.ts 的 SKILL_NAMES）：oralcut / long2short / splitter / matrix / mg / ai-drama / style-maker / transcript / tools / music-visualizer / cover / travel-recap / live-slicing / talking-head / narration / voiceover / food-recap / vlog-docu
├── contracts/                # 框架契约库正本（gsap-emit v1 + handoff→契约映射表）
├── assets/                   # README 配图（介绍图 / Agent 调用示例 / 剪映草稿目录指引图）
└── AGENT.md                  # 可移植 agent playbook（skill 底座）
```

新增命令 = 写 `src/commands/<name>.ts` 的 `register<Name>(program)` + 在 `src/index.ts` 注册一行。
