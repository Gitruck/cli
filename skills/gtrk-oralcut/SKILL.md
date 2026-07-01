---
name: gtrk-oralcut
description: 智能口播剪辑闭环——把一条口播原视频(毛片)通过同合云云端剪掉废话/重复/长停顿，产出客户端(gtrk)+剪映+PR 三方工程文件并自动打开产物目录。当用户想「剪口播/剪个视频/智能剪辑/去掉废话和停顿/把这条口播剪一版/出剪映草稿/生成剪辑工程/oral cut」时使用本 skill。凡涉及把口播毛片做成可二次精修的剪辑工程，优先用本 skill 驱动 gtrk CLI，不要手搓 ffmpeg。
---

# 口播剪辑（gtrk-oralcut）

把用户的口播毛片，用 `gtrk` CLI 跑通「上传 → 云端智能口播剪辑 → 拉回三方工程文件 → 打开」，再把产物目录 + 三端打开方式回给用户。**CLI 是手、你是脑。**

> **本 skill 已含你需要的全部信息**（参数、取值、执行、读报告、排错），照它做即可，不用也无法去查外部文档。（源仓库另有一份更全的工具无关版 `AGENT.md`，那是给在仓库里开发的人看的，与你无关。）

## 前置：CLI 装没装 + 体检

先跑 `gtrk doctor`（它顺带验证 `gtrk` 命令本身在不在）：
- **`gtrk` 找不到 / command not found** → CLI 没装 → 让用户装 `npm i -g @gitruck/cli@latest`（需先有 Node.js），再重试。
- 报「缺 API Key」→ 让用户先跑一次 `gtrk init`（一次性配 Key + 剪映目录，**交互式、需真终端**，你别替他跑）。
- 报云端连不上 / 剪映目录没配 → 照提示让用户处理。
- 全绿就往下走。

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
| 顺带渲个成片视频 | `--render` | 开关 · 缺省不渲 | 加它则额外出 mp4 成片 |
| 成片画质 | `--crf <n>`（配 `--render`） | 整数 14–28 · `18` | 越小越清晰 / 越大体积越小 |
| 成片编码 | `--codec <c>`（配 `--render`） | `h264` · `h264` | 当前仅 h264 |
| 节奏松紧 | `--preset <名>` | `steady`/`concise`/`compact` · 默认 `concise` | 不传即 CLI 默认发 `concise`（精练）；见下方预设表，铺底后可逐项覆盖 |
| **剪不准 / 剪掉真内容 / 有话没剪进去** | `--visual-assist` | 开关 · 关 | **视觉找补兜底**：画面说话检测保护疑似漏识别段不被误剪并重识别捞回；不额外计费、绝不凭空生成 |
| 别随说话人节奏自适应 | `--no-adaptive-rhythm` | 开关 · 自适应默认开 | 关了改用固定标点停顿表 |
| 剪映草稿目录（非标准位置） | `--jianying-draft-dir <目录>`（或 `auto`） | 路径 · 读 init 配置 / 自动探测 | 出剪映可直开草稿需要它 |

**更细的节奏散参数**（无一等 flag，用 `--param 键=值` 或嵌套 `--params-json`）：

| 参数 | 传法 | 取值 · 默认 | 说明 |
|---|---|---|---|
| `punctuation_breaks` | `--params-json '{"punctuation_breaks":{"。":0.6,"，":0.3}}'` | 每标点 0–5 秒 · 见预设表 | 逐标点停顿；键只能是 `，、；：。！？—……` 和 `paragraph`（段落） |
| `intra_gap_max` | `--param intra_gap_max=0.4` | 0–5 · `0.35` | 句内停顿超此值算气口、触发收紧 |
| `intra_gap_target` | `--param intra_gap_target=0.05` | 0–5 且 <max · `0.10` | 气口收到的目标秒数 |
| `pad_in` / `pad_out` | `--param pad_out=0.15` | 0–5 · `0.05` / `0.08` | 保留片段头 / 尾呼吸留白 |
| `render.audio_crossfade_ms` | `--params-json '{"render":{"audio_crossfade_ms":12}}'` | 0–50 · `8` | 切点淡化毫秒，`0`=硬切 |

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
  `{ ok, outDir, files:{gtrk:[],jianying:[],xml:[]}, jianyingDraftPath, report, errors, taskId, fileId }`
- **命令失败**（毛片路径错 / 鉴权失败 / 参数越界 6016 等）→ **进程非 0 退出、报错打到 stderr、stdout 无 JSON**。先看退出码，非 0 就把 stderr 的报错如实回给用户、别当成功。
- 默认会自动打开产物目录（用户能直接看到文件）；纯脚本/无头环境才加 `--no-open`。
- 云端处理是分钟级，耐心等命令返回。

## 跑完读报告、给用户交代、按需调整（因势象形的另一半）

`--json` 的 stdout 那行带 **`report`**（云端返回的原始剪辑报告对象，字段按需读、个别可能缺，读前判空）——读它，别只回一句"剪好了"：

- `duration_before` → `after`：剪了多少（如 114.7s → 68.6s）。
- `dropped[]`：剔掉了哪些段（`reason`：`retake` 重读 / `misread` 口误）——可挑几条告诉用户「去掉了这些重录 / 口误」。
- `coverage`（0–1）：终稿覆盖率。**低于 0.6（附 `low_coverage`）= 文稿与实拍严重不符** → 提醒用户核对文稿、或考虑无稿重跑。
- `uncovered_script[]`：**文稿里有、实拍没找到的段（漏读）** → 如实告诉用户「『xx』这段没在录像里找到」；疑似是漏识别而非真漏读时，建议加 `--visual-assist` 重跑。
- `review_points[]`：建议人工复核处（识别置信度偏低）。
- `adaptive_rhythm` / `analysis_degraded`：自适应是否生效 / 是否降级到机械规则。
- 开了 `--visual-assist`：`suspect_omissions` / `stt_recovered`（找回了哪些字）/ `visual_assist_degraded`。
- `ok=false` 或 `errors` 非空：某格式没出来 → 如实说哪个、为什么。

**据此因势象形调整**（同一毛片可反复剪对比）：覆盖率低 / 漏读多 → 开 `--visual-assist` 或核对文稿重跑；节奏不满意 → 调 `--preset` / 散参数重跑；某格式失败 → 补 `--jianying-draft-dir` / `--reupload` 重跑。

跑完确认 `files.gtrk[0]` 在；要剪映确认 `jianyingDraftPath` 非空。

## 回给用户（三端打开方式）

- **客户端**：在同合云桌面客户端（OpenCut Gitruck Edition）里「打开工程」选 `files.gtrk[0]`（…/gtrk/project.gtrk）。
- **剪映**：已自动落到剪映草稿目录（`jianyingDraftPath`），开剪映在项目列表里找**同名工程**即可。
- **PR/FCP**：Premiere 里「文件 > 导入」`files.xml[0]`（…/xml/premiere.xml）。

产物目录名形如 `<毛片名>-video-project-<时间戳>`，靠文件名 + 时间认出是哪一次剪辑、互不覆盖。
