---
name: gtrk-oralcut
description: 智能口播剪辑闭环——把一条口播原视频(毛片)通过同合云云端剪掉废话/重复/长停顿，产出客户端(gtrk)+剪映+PR 三方工程文件并自动打开产物目录。当用户想「剪口播/剪个视频/智能剪辑/去掉废话和停顿/把这条口播剪一版/出剪映草稿/生成剪辑工程/oral cut」时使用本 skill。凡涉及把口播毛片做成可二次精修的剪辑工程，优先用本 skill 驱动 gtrk CLI，不要手搓 ffmpeg。
---

# 口播剪辑（gtrk-oralcut）

把用户的口播毛片，用 `gtrk` CLI 跑通「**本地抽音频/720p → 只传抽出物（毛片永不上传）** → 云端智能口播剪辑 → 拉回三方工程文件 →（可选）**本地 ffmpeg 渲染成片**」，再把产物目录 + 三端打开方式回给用户。**CLI 是手、你是脑。**

> **本 skill 已含你需要的全部信息**（参数、取值、执行、读报告、排错），照它做即可，不用也无法去查外部文档。（源仓库另有一份更全的工具无关版 `AGENT.md`，那是给在仓库里开发的人看的，与你无关。）

## 前置：CLI 装没装 + 体检

先跑 `gtrk doctor`（它顺带验证 `gtrk` 命令本身在不在）：
- **`gtrk` 找不到 / command not found** → CLI 没装 → 让用户装 `npm i -g @gitruck/cli@latest`（需先有 Node.js），再重试。
- 报「缺 API Key」→ 让用户先跑一次 `gtrk init`（一次性配 Key + 剪映目录，**交互式、需真终端**，你别替他跑）。
- 报云端连不上 / 剪映目录没配 → 照提示让用户处理。
- 全绿就往下走。

### ffmpeg 依赖（本地抽音频 / 渲染必需，缺了你来装）

oralcut 现在**本地预处理**（探原片几何 + 抽 16k 单声道 mp3 / 压 720p 代理）和 **本地渲染**都靠 `ffmpeg`/`ffprobe`。看 `gtrk doctor` 里「本地渲染 (ffmpeg)」这行：

- **已就绪** → 往下走。
- **未找到** → 你来装（CLI 不自下不自分发）：**先确认确实没有**（doctor 已查过 `~/.gitruck/ffmpeg` 与系统 PATH），缺了再拉 `ffmpeg` + `ffprobe` 两个可执行文件放到 `~/.gitruck/ffmpeg/`（Windows 即 `ffmpeg.exe`/`ffprobe.exe`）。
  - **国内用户优先国内加速站点**：GitHub 官方静态构建（BtbN / gyan.dev）直连慢，走 GitHub 加速代理（pass-through）或同合云自建镜像拉，下载后**核对 sha256**。
  - 装好复跑 `gtrk doctor` 确认转绿。
- 用户自己装过 ffmpeg 并配了 PATH → doctor 会从系统探到直接用；**绝不去改用户的环境变量/PATH**（CLI 一律绝对路径调用）。若装在别处，用 `--ffmpeg-path <目录>` 指给它。

## 把用户的话变成一次调用

> **每次调用都必须带 `--json`**（成功时 stdout 只出一行结果 JSON、人读日志转 stderr），你才能解析结果 + 读报告。不是可选项。

从用户消息里取这几样，缺关键的就问：

1. **毛片路径**（必需）：口播原视频的本地路径。没有就问。
2. **文稿**：用户给了逐字稿/文字稿**文件** → `--script <txt文件路径>`（接的是 .txt 文件路径，不是稿子正文）；没给则不传（CLI 会探毛片同名 `.txt`，有就自动按有稿剪、更准；无则云端无稿智能重建）。
3. **节奏**：用户说「快/紧凑/卡点狠」→ `--preset compact`；「稳/别删太多停顿」→ `--preset steady`；没特别说就不传（CLI 默认 `concise` 精练）。
4. **只要某端**：只要客户端 → `--formats gtrk`；只要剪映 → `--formats jianying`；只要 PR → `--formats xml`（全部格式见下表、逗号可多选）；默认三端全给（`gtrk,jianying,xml`）。

## 完整参数规格 —— 按用户需求因势象形、自由组合

**你手上有云端全部参数（下表）。按用户的具体诉求自由决定用哪些、怎么配——需要就调、没提就跑默认（默认已是给多数人调好的）。** 只有一条要求：**名字 / 取值 / 范围照下表用**（别记错拼错）；万一传越界，云端会报 `6016` 并附具体原因，照着改即可——乱传不会产出错误成片，只会明确报错。

| 用户想要 | CLI 怎么传 | 取值 · 默认 | 说明 |
|---|---|---|---|
| 有稿对齐（更准） | `--script <txt>`（或毛片同名 `.txt` 自动） | 10–50000 字 · 缺省无稿重建 | 有稿逐字对齐质量最佳；无稿智能重建终稿 |
| 换语种 | `--lang <码>` | `zh-CN`/`en-US`/`ja-JP`… · 默认 `zh-CN` | 不传即 CLI 默认发 `zh-CN`；主推中文，余语种尽力而为 |
| 产哪些工程格式 | `--formats <逗号列表>` | `xml`/`fcpxml`/`otio`/`jianying`/`capcut`/`gtrk` · CLI 缺省 `gtrk,jianying,xml` | 可多选 |
| 顺带出成片视频 | `--render` | 开关 · 缺省不渲 | **本地** ffmpeg 按 gtrk EDL 渲染 mp4（毛片仍不上传、云端不渲染）；需 ffmpeg 就绪 |
| 成片画质 | `--crf <n>`（配 `--render`） | 整数 14–28 · `18` | 本地渲染用；越小越清晰 / 越大体积越小 |
| 成片编码 | `--codec <c>`（配 `--render`） | `h264` · `h264` | 本地渲染用；当前仅 h264 |
| 指定 ffmpeg 位置 | `--ffmpeg-path <目录>` | 路径 · 缺省 `~/.gitruck/ffmpeg`→系统 | 用户 ffmpeg 装在非标准位置时指给它 |
| 节奏松紧 | `--preset <名>` | `steady`/`concise`/`compact` · 默认 `concise` | 不传即 CLI 默认发 `concise`（精练）；见下方预设表，铺底后可逐项覆盖 |
| **剪不准 / 剪掉真内容 / 有话没剪进去** | `--visual-assist` | 开关 · 关 | 开则**本地改传 720p 代理**（非上传原片）+ **视觉找补兜底**：画面说话检测保护疑似漏识别段不被误剪并重识别捞回（需说话人面部基本可见）；上传体量比纯音频大、处理耗时增加，但不额外计费、绝不凭空生成 |
| 别随说话人节奏自适应 | `--no-adaptive-rhythm` | 一元 flag：传即关闭 · 自适应默认开 | 是否定 flag（不接受 `=值` 赋值）；关了改用固定标点停顿表 |
| 剪映草稿目录（非标准位置） | `--jianying-draft-dir <目录>`（或 `auto`） | 路径 · 读 init 配置 / 自动探测 | 出剪映可直开草稿需要它 |
| 工程落盘到别处 | `--out <目录>`（或 `-o`） | 路径 · 缺省 `<毛片同目录>/<毛片名>-video-project-<时间戳>` | 想把产物放指定位置时用 |

**更细的节奏散参数**（无一等 flag，用 `--param 键=值` 或嵌套 `--params-json`）：

| 参数 | 传法 | 取值 · 默认 | 说明 |
|---|---|---|---|
| `punctuation_breaks` | `--params-json '{"punctuation_breaks":{"。":0.6,"，":0.3}}'` | 每标点 0–5 秒 · 见预设表 | 逐标点停顿；键只能是 `，、；：。！？—……` 和 `paragraph`（段落） |
| `intra_gap_max` | `--param intra_gap_max=0.4` | 0–5 · `0.35` | 句内停顿超此值算气口、触发收紧 |
| `intra_gap_target` | `--param intra_gap_target=0.05` | 0–5 且 <max · `0.10` | 气口收到的目标秒数 |
| `pad_in` / `pad_out` | `--param pad_out=0.15` | 0–5 · `0.05` / `0.08` | 保留片段头 / 尾呼吸留白 |
| `render.audio_crossfade_ms` | `--params-json '{"render":{"audio_crossfade_ms":12}}'` | 0–50 · `8` | 切点淡化毫秒，`0`=硬切；**需配 `--render`**（属成片音频淡化，不开 --render 云端忽略此字段） |

**节奏预设表 · 完整值**（选最贴内容类型的，再逐项覆盖散参数；「默认」列 = 不选预设时的基线，也即各标点的默认停顿）：

| 参数（秒） | `steady` 稳健 | `concise` 精练 | `compact` 紧凑 | 默认 |
|---|---|---|---|---|
| 适用 | 讲述 / 教学 | 自媒体中长视频 | 短视频 / 广告 | 通用 |
| `、` / `，` / `；` | 0.18 / 0.25 / 0.36 | 0.12 / 0.18 / 0.26 | 0.06 / 0.08 / 0.12 | 0.15 / 0.20 / 0.30 |
| `：` / `—` | 0.45 / 0.55 | 0.32 / 0.40 | 0.15 / 0.18 | 0.35 / 0.45 |
| `。` `！` / `？` | 0.55 / 0.60 | 0.40 / 0.45 | 0.18 / 0.20 | 0.45 / 0.50 |
| `……` / `paragraph`（段落） | 0.75 / 1.20 | 0.55 / 0.90 | 0.25 / 0.40 | 0.60 / 1.00 |
| `intra_gap_max` / `intra_gap_target` | 0.45 / 0.15 | 0.35 / 0.10 | 0.25 / 0.05 | 0.35 / 0.10 |
| `pad_in` / `pad_out` | 0.05 / 0.10 | 0.05 / 0.08 | 0.03 / 0.05 | 0.05 / 0.08 |

> **因势象形举例**：「教学口播、别删太狠、句号后多顿一下」→ `--preset steady --params-json '{"punctuation_breaks":{"。":0.7}}'`；「英文短视频卡点狠、顺便出成片」→ `--lang en-US --preset compact --render`；「上次有句话没剪进去」→ `--visual-assist`。用户**自己点名**某参数+值 → 照他原样 `--param`/`--params-json` 透传（CLI 底层支持任意云端参数）。
>
> **以上就是你需要的全部参数——本 skill 自足，别去别处查**（`gtrk oralcut --help` 也随时列全部 flag）。官网另有一份面向开发者的原始 HTTP API 文档，那是给人看的，你不必也无法访问。

## 执行（每次都带 `--json`）

```bash
gtrk oralcut "<毛片绝对路径>" [--script "<txt路径>"] [--preset steady|concise|compact] [其它参数…] --json
```

- `--json`：人读日志走 stderr，**成功时 stdout 只有一行结果 JSON**：
  `{ ok, outDir, files:{gtrk:[],jianying:[],xml:[]}, jianyingDraftPath, rendered, report, errors, taskId, fileId }`（`rendered`=本地渲染成片路径，未开 `--render` 时为 `null`）
- **命令失败**（毛片路径错 / 鉴权失败 / 参数越界 6016 等）→ **进程非 0 退出、报错打到 stderr、stdout 无 JSON**。先看退出码，非 0 就把 stderr 的报错如实回给用户、别当成功。
- 默认会自动打开产物目录（用户能直接看到文件）；纯脚本/无头环境才加 `--no-open`。
- 云端处理是分钟级，耐心等命令返回。

## 跑完读报告、给用户交代、按需调整（因势象形的另一半）

`--json` 的 stdout 那行带 **`report`**（云端返回的原始剪辑报告对象，字段按需读、个别可能缺，读前判空）——读它，别只回一句"剪好了"：

- `duration_before` → `duration_after`：剪了多少（如 114.7s → 68.6s）。
- `script_source` + `final_script`：终稿来源与内容（`script_source`=`user` 用户给稿 / `rebuilt` 智能重建）。**无稿重建（`rebuilt`）时务必把 `final_script` 回给用户核对**——那是机器猜出来的终稿，可能跟本意有出入。
- `dropped[]`：剔掉了哪些段（元素 `{start,end,asr_text,reason}`，`reason`：`retake` 重读 / `misread` 口误·弃读·终稿外内容）——可挑几条告诉用户「去掉了这些重录 / 口误或非终稿内容」。
- `coverage`（0–1）：终稿覆盖率。**低于 0.6（附 `low_coverage`）= 文稿与实拍严重不符** → 提醒用户核对文稿、或考虑无稿重跑。
- `uncovered_script[]`：**文稿里有、实拍没找到的段（漏读）** → 如实告诉用户「『xx』这段没在录像里找到」；疑似是漏识别而非真漏读时，建议加 `--visual-assist` 重跑。
- `review_points[]`：建议人工复核处（`{time,note}`，识别置信度偏低）。
- `insufficient_breaks[]`：源素材留白不足、停顿没达到设定值的位置（`{time,want,got}`）——想让停顿更足可调 `--preset`/散参数，但受原素材限制。
- `rhythm_preset`（实际采用的预设名、无预设为 `null`）/ `adaptive_rhythm`（自适应是否生效；生效时另有 `pause_profile` 说话人停顿画像，调参参照）/ `analysis_degraded`（是否降级到纯机械规则）。
- 开了 `--visual-assist`：`suspect_omissions` / `stt_recovered`（找回了哪些字）/ `visual_assist_degraded`。
- `ok`：`true` = 全部格式成功、`errors` 为空；只要有一个格式失败 `ok` 即 `false` 且 `errors` 非空（其余格式仍可用）→ 如实说哪个格式没出来、为什么，别谎报三端都好。

**据此因势象形调整**（同一毛片可反复剪对比）：覆盖率低 / 漏读多 → 开 `--visual-assist` 或核对文稿重跑；节奏不满意 → 调 `--preset` / 散参数重跑；某格式失败 → 补 `--jianying-draft-dir` / `--reupload` 重跑。

跑完确认 `files.gtrk[0]` 在；要剪映确认 `jianyingDraftPath` 非空。

## 回给用户（三端打开方式）

- **客户端**：在同合云桌面客户端（OpenCut Gitruck Edition）里「打开工程」选 `files.gtrk[0]`（…/gtrk/project.gtrk）。
- **剪映**：已自动落到剪映草稿目录（`jianyingDraftPath`），开剪映在项目列表里找**同名工程**即可。
- **PR/FCP**：Premiere 里「文件 > 导入」`files.xml[0]`（…/xml/premiere.xml）。

产物目录名形如 `<毛片名>-video-project-<时间戳>`，靠文件名 + 时间认出是哪一次剪辑、互不覆盖。

## 下一步（自动接力，别停在交工）

口播工程剪好只是成片一条龙的第一站。确认 `ok=true`、`files.gtrk[0]` 与 transcript 就绪后，**别停下等用户开口**——顺势接力到视觉拆分：触发 `/gtrk-splitter`（把这条工程 + transcript 拆成 beat 级分镜派单，agent 再跑 `gtrk split` 产 `dispatch.json`），驱动后续各车道生产+铺轨。一句话交代即推进：「口播工程已就绪，我接着把它拆成分镜派单」，除非用户表示只要这版剪辑工程、暂不往下。

> 原则：**agent 替用户跑 CLI / 接力 skill，用户只对话**——别让用户自己去终端敲下一条 gtrk 命令。
