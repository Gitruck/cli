---
name: gtrk-music-visualizer
description: 音乐可视化成片——把一首歌通过同合云出成一条频谱可视化视频（可选背景/封面 + 模板/配色样式）。当用户想「把这首歌做成可视化视频 / 音乐可视化 / 频谱视频 / 歌曲配画面出片 / music visualizer / 给歌配个动态封面视频」时使用本 skill。凡涉及把一段音频做成频谱可视化成片，优先用本 skill 驱动 gtrk CLI 的 `music-visualizer` 命令，不要手搓 ffmpeg。
---

# 音乐可视化（gtrk-music-visualizer）

把用户的一首歌，用 `gtrk` CLI 跑通「**主音频上传（+可选背景/封面各自上传）** → 云端出频谱可视化成片 → 拉回本地」，再把产物目录回给用户。**CLI 是手、你是脑。**

> **本 skill 已含你需要的全部信息**（参数、取值、执行、排错），照它做即可。具体模板 id 与参数细节以云端 API 文档为准（本地不冻结模板列表）。

## 前置：CLI 装没装 + 体检

先跑 `gtrk doctor`：
- **`gtrk` 找不到 / command not found** → 让用户装 `npm i -g @gitruck/cli@latest`（需先有 Node.js），再重试。
- 报「缺 API Key」→ 让用户先跑一次 `gtrk init`（一次性配 Key，交互式、需真终端，你别替他跑）。
- 全绿就往下走。

## 一条命令

```
gtrk music-visualizer <音频> --template <模板id> [可选样式/文件] [--json]
```

- `<音频>`：本地音频文件（mp3/wav/m4a/aac/flac/ogg/wma 等）。按其时长计费。
- `--template <id>`：**必填**。可视化模板 id（如 `aurora`）。取值以云端 API 文档 / 服务端模板列表为准；用户没指定就问他要，或让他去文档挑一个。传错服务端会报错并列出可选集。

### 可选辅助文件（各自独立上传）
- `--background <图或视频>`：背景素材，接受图片或视频。
- `--cover <图>`：封面图，**仅接受图片**。

### 可选样式参数
- `--track <曲名>` / `--artist <歌手>`：叠加到画面的文字。
- `--resolution <WxH>`：输出分辨率，如 `1080x1920`（竖屏）、`1920x1080`（横屏）。缺省走服务端默认 1920x1080。
- `--fps <30-60>`：帧率，缺省 30。
- `--c1 <hex>`：频谱主色，十六进制如 `#ff0066`。缺省白色。
- `--c2 <hex>`：频谱**第二色**——**给了它才是双色渐变**，不给就是 `--c1` 单色。想要炫一点的渐变频谱就配上 `--c2`。
- `--blur <0-40>`：背景模糊强度，缺省 16。

### 通用
- `--out <dir>`：产物目录（缺省 = 音频同目录下带时间戳的子目录）。
- `--param k=v` / `--params-json '{...}'`：透传任意云端参数（覆盖优先级最高）。
- `--json`：机读模式，stdout 只出结果 JSON。
- `--reupload`：强制重新上传，忽略缓存。

## 常见用法

- 最简：`gtrk music-visualizer ./song.mp3 --template aurora`
- 竖屏 + 双色渐变 + 叠字：`gtrk music-visualizer ./song.mp3 --template aurora --resolution 1080x1920 --c1 #ff0066 --c2 #6600ff --track 夜曲 --artist 周杰伦`
- 带自定义背景 + 封面：`gtrk music-visualizer ./song.mp3 --template aurora --background ./bg.jpg --cover ./cover.png`

## 配色引导（你帮用户想清楚）

- 用户只说「配色炫一点 / 渐变」→ 给 `--c1` + `--c2` 两个色（双色渐变）。
- 用户说「纯色 / 简洁」→ 只给 `--c1`。
- 拿不准具体 hex：给常见搭配建议（如霓虹粉紫 `#ff0066`→`#6600ff`、青蓝 `#00e5ff`→`#0066ff`），或让用户给个大概色系你转 hex。
- hex 必须是 `#RRGGBB` 或 `#RGB`；写错命令会在提交前报错。

## 读产物

完成后产物目录里有：
- `<音频名>-visualizer.mp4`：成片。
- `result.json`：`ok`/`files`/`taskId`；`ok=false` 时看 `errors`，可凭 `task.json` 的 `taskId` 稍后恢复，别急着重跑（重跑会重新计费）。

## 排错

- **缺 `--template`**：必填，问用户要模板 id 或让他查云端 API 文档的模板列表。
- **模板 id 报错**：服务端会列出可选集，照着改。
- **`--cover` 报「仅接受图片」**：封面只能是图片；视频素材放 `--background`。
- **样式参数报错**：`--fps` 30-60、`--blur` 0-40、`--resolution` 必须 `宽x高`、`--c1/--c2` 必须十六进制——按报错提示改。
- **产物下载失败（ok=false）**：网络波动或链接过期；凭 `taskId` 恢复，不整条重跑。
