---
name: gtrk-tools
description: gtrk 单点工具与媒体转换能力的调用向导，覆盖 `gtrk tool` 家族。当用户想“让图动起来 / 抠像去背景 / 图片或视频去黑边 / 图片或视频比例转换 / 视频防抖 / 添加蒸汽波滤镜 / 清理有权处理的图片或视频中的水印、字幕或叠加元素 / 视频超分变清晰 / 视频补帧变流畅 / 分离人声和伴奏 / 提取伴奏 / 按说话人分轨 / 音频变调变速 / 钢琴扒谱转 MIDI 或修复钢琴录音 / 给音频或视频降噪 / 去掉音频静音停顿 / 长图转方图 / 图片变 LivePhoto 微动 / 视频机械分镜或智能分镜切镜头 / 提取运镜高光片段 / 给视频加字幕或翻译字幕或烧录字幕 / 一键剪 MAD / 用某个 gtrk 单点工具 / gtrk 工具族里有什么”时使用本 Skill。凡涉及这些能力，优先驱动 CLI，不让用户自己去终端敲，也不手搓 ffmpeg。
---

# gtrk 工具族（gtrk-tools）

飞书使用教程统一入口：[gtrk CLI 使用教程](https://hocassian.feishu.cn/wiki/HCFpwoF7SivIFbkKosgcFMcEnxk)。

`gtrk tool <name> [input]` 是 gtrk 的**单点能力**族：一个工具 = 单发单收（给一个输入、出一份产物），没有 SOP 次序、没有用户检查点链——与成片管线的车道命令（`oralcut` / `split` / `matrix` / `mg`）是两回事。本 skill 是这个族的**统一调用向导**：认清有哪些工具、按纪律驱动 `gtrk tool` 命令、把产物和计费如实回给用户。

> **本 skill 已含你需要的全部信息**（工具清单、调用纪律、恢复语义、排错话术）。工具清单以 `gtrk tool list --json` 为**唯一真相**——本文件与它漂移时以命令输出为准并回来修本文件。参数细节以 `gtrk tool --help` 为准。

## 工具清单（与 `gtrk tool list` 同源）

| 工具名 | 触发语（用户可能怎么说） | 输入要求 | 产物形态 | 计费 | 可用状态 |
|---|---|---|---|---|---|
| `image_move` | 「把这张图做成运镜视频 / 让图动起来 / 图转视频」 | 单张图片 | 运镜视频 | 运行前实时查询 | 已上线 |
| `image_matting` | 「给图片抠像 / 抠出主体 / 去背景 / 出透明 png」 | 单张图片 | 透明背景 png | 运行前实时查询 | 已上线 |
| `image_blackborder_remove` | 「图片去黑边 / 裁掉四周黑边 / 保留有效画面」 | 单张本地图片 | 去黑边图片 | 运行前实时查询 | 已上线 |
| `image_canvas_adapt` | 「图片比例转换 / 调整画布尺寸 / 转成矩形或方形裁剪」 | 单张本地图片；模式只支持 `normal` / `rectangle` / `square` | 比例适配图片 | 运行前实时查询 | 已上线 |
| `image_purify` | 「清理我有权处理的图片水印 / 去掉 Logo 或叠加元素 / 图片净化」 | 单张本地图片（仅处理你有权处理的素材） | 净化图片 | 运行前实时查询 | 已上线 |
| `video_matting` | 「视频抠像 / 视频去背景 / 出透明背景视频」 | 单条视频（≤10 分钟） | 透明背景 webm | 运行前实时查询 | 已上线 |
| `video_blackborder_remove` | 「视频去黑边 / 裁掉视频四周黑边 / 保留有效画面」 | 单条本地视频 | 去黑边视频 | 运行前实时查询 | 已上线 |
| `video_canvas_adapt` | 「视频比例转换 / 横竖屏适配 / 截取片段并转换画布」 | 单条本地视频；模式只支持 `normal` / `rectangle` / `square` | 比例适配视频 | 运行前实时查询 | 已上线 |
| `video_stabilizer` | 「视频防抖 / 稳定手持画面 / 去抖」 | 单条本地视频；方式 `fast` / `exp` / `turbo` | 防抖视频 | 运行前实时查询 | 已上线 |
| `video_vaporwave` | 「给视频加蒸汽波滤镜 / 复古滤镜 / 使用某个滤镜预设」 | 单条本地视频；滤镜名需精确 | 蒸汽波滤镜视频 | 运行前实时查询 | 已上线 |
| `video_purify` | 「清理我有权处理的视频水印 / 去字幕 / 只净化指定区域」 | 单条本地视频（仅处理你有权处理的素材）；可选范围、方式和归一化 ROI | 一条净化视频 | 运行前实时查询 | 已上线 |
| `video_upscale` | 「视频超分 / 低清视频放大 / 动漫视频变清晰」 | 单条本地视频（≤1 分钟）；倍数 `2` / `3` / `4`，类型 `Reality` / `Anime` | 一条超分视频 | 运行前实时查询 | 已上线 |
| `video_interpolate` | 「视频补帧 / 提高帧率 / 让画面更流畅」 | 单条本地视频；倍数 `2` / `3` / `4`，不附加 1 分钟限制 | 一条插帧视频 | 运行前实时查询 | 已上线 |
| `video_segment` | 「机械分镜 / 按画面变动切分镜区间 / 场景切分」 | 单条本地视频；可选 `--detector content\|adaptive`、`--threshold` | 分镜区间结构 `result-output.json`（非下载文件） | 运行前实时查询 | 已上线 |
| `video_ai_segment` | 「智能分镜 / 语义切镜头 / 按类目景别拆镜头」 | 单条本地视频；可选 `--segment-mode scene\|shot_type\|narrative\|subject` | 语义分镜结构 `result-output.json`（非下载文件） | 运行前实时查询 | 已上线 |
| `video_motion_cut` | 「运镜高光 / 提取运镜片段 / 找高光镜头」 | 单条本地视频 | 运镜/高光片段结构 `result-output.json`（非下载文件） | 运行前实时查询 | 已上线 |
| `video_ai_subtitle` | 「智能字幕 / 给视频加字幕 / 视频翻译字幕 / 烧录字幕 / 去原字幕」 | 单条视频或音频；**`--language <码>` 必填**；可选 `--translate-language`、`--need-render`（烧录）、`--need-pure`（去原字幕）、`--subtitle-type`、`--subtitle-color` | `.ass` 字幕文件 + 可选烧录/去字幕 `.mp4` + `result-output.json`（LLM 摘要 + 字级时间轴） | 运行前实时查询 | 已上线 |
| `audio_separation` | 「分离人声和伴奏 / 提取人声 / 提取伴奏」 | 单条音频 | 人声与伴奏音频（按实际返回可为一项或两项） | 运行前实时查询 | 已上线 |
| `audio_speaker_split` | 「按说话人分轨 / 把不同人的声音分开 / 谁在什么时候说话」 | 单条音频；可选 `--only-struct` 只出结构 | 各说话人 `.wav` 分轨 + `spoken_list` 时间线（`result-output.json`） | 运行前实时查询 | 已上线 |
| `audio_stretch` | 「变调 / 变速 / 升降 key / 加快放慢音频」 | 单条音频；可选 `--semitones`、`--speed`（>0） | 变调变速音频 | 运行前实时查询 | 已上线 |
| `audio_noise_reduce` | 「音频降噪 / 视频声音降噪 / 去底噪」 | 单条音频或视频 | 降噪后的音频 | 运行前实时查询 | 已上线 |
| `audio_silence_remove` | 「去静音 / 删掉过长停顿 / 压缩音频空白」 | 单条音频 | 去静音音频 | 运行前实时查询 | 已上线 |
| `piano_audio_to_midi` | 「钢琴扒谱 / 钢琴音频转 MIDI / 提取 MIDI」 | 单条音频 | MIDI 文件 `.mid` | 运行前实时查询 | 已上线 |
| `piano_audio_enhance` | 「钢琴录音修复 / 增强钢琴音质」 | 单条音频 | 高质量 WAV + 配套 MIDI（双产物） | 运行前实时查询 | 已上线 |
| `image_to_square` | 「长图转方图 / 把长图变方的」 | 单张图片；可选 `--max-line`（≤20000） | 方形图片 | 运行前实时查询 | 已上线 |
| `image_to_live` | 「图片变 LivePhoto / 静图微动 / 让照片动起来」 | 单张图片 | 微动视频 `.mp4`（产物是视频） | 运行前实时查询 | 已上线 |
| `mad` | 「一键剪 MAD / 素材文件夹自动出卡点成片 / 自动选技法 / 给这堆素材出个 AE 工程」 | 一个素材文件夹（3~10 条视频）+ 可选 `--bgm 歌.mp3` | AE 母合成工程 `.jsx`（仅支持 AE） | 仅 `--bgm` 触发实时查价 | 已上线 |

> 清单随 CLI 版本增补。**动手前先跑 `gtrk tool list --json` 拿最新清单**，别凭记忆——新工具、状态变化都在那里。

### mad（一键剪 MAD）的特殊之处

`mad` 是族内首个 **local 型「纯本地工具、可选云端加料」**成员，与 cloud 型工具不同：

- **无 Key 可跑**：不带 `--bgm` 时全程只走免鉴权数据面（技法数据经云端 manifest 下发 + `~/.gitruck/mad-cache` 缓存），**首拉联网一次性下载、缓存命中后离线可跑**；不要求 API Key、不触发计费任务。
- **`--bgm` 才需 Key 且计费一次**：带 `--bgm` 且已配 Key → BGM 卡点到 downbeat（调一次云端节拍分析计费）；没配 Key → **温和提示 `gtrk init` 可解锁卡点，不阻断**，BGM 仍入轨、按固定节奏出片；坏 BGM/云端失败一律降级不崩。
- **产物只有 `.jsx`、只支持 AE**：完成后引导「装 AE 2020+ → 文件›脚本›运行脚本文件 选它」。**不承诺 `.amproj`/Alight Motion 等本命令未产出的形态**。
- **可复现**：`--seed <n>` 固定选窗序列（同素材同种子同数据版本 → 同结果）；`result.json` 记录 seed、数据版本、降级档位、选中技法清单。
- 常用：`gtrk tool mad ./素材 --bgm 歌.mp3 --duration 20 --json`。

## 调用纪律（每次都照做）

1. **先看清单、再对号**：用户的意图对到某个工具名（拿不准就 `gtrk tool list --json` 核对触发语与输入要求）。
2. **执行前转述实时计费提示**：先读本次 `gtrk tool list --json` 的 `billingHint`/`pricing`，再把实时结果如实告诉用户；不得引用本文件或记忆中的旧价格。若显示价格暂不可用，就说明最终以服务端结算为准。
3. **一律带 `--json`**：`gtrk tool <name> <输入> --json`。stdout 只会有一行结果 JSON（`{ ok, outDir, files, taskId, fileId, … }`），人读日志在 stderr。按 `ok` 判成败、从 `files` 拿产物路径、把 `outDir` 回给用户。
4. **缺 API Key 先引导配置**：cloud 型工具没配 Key 会报错让先跑 `gtrk init`。遇到就引导用户 `gtrk init`（或设 `GITRUCK_API_KEY`），别反复重试。
5. **瞬时网络错误退避后只重试 1 次**：若 `gtrk tool list --json` 或工具命令因 `fetch failed`、`ECONNRESET`、`ETIMEDOUT`、`ENOTFOUND`、`socket hang up`、网络不可达或 HTTP `502/503/504` 失败，先等 **2 秒**，再原样执行同一命令 **1 次且仅 1 次**（总尝试次数最多 2 次）。第二次仍失败就停止，如实说明网络波动并给出最后错误，绝不循环重试。参数/文件校验错误、缺 Key、HTTP 4xx、云端业务错误码、明确的任务失败/取消均**不重试**。重试前先检查日志及输出目录：一旦已出现 `taskId` 或 `task.json`，说明任务可能已经提交，禁止重跑整条以免重复计费，转入下一条恢复语义。
6. **产物落地与恢复**：产物落在 `outDir`（缺省 = 输入同目录下 `<输入名>-<工具名>/`，可 `--out <dir>` 覆盖）。提交成功即写 `task.json`（含 `taskId`）、完成即写 `result.json`。**分析型工具**（`video_segment` / `video_ai_segment` / `video_motion_cut`）产的是**结构化数据不是下载文件**：结果落 `result-output.json`（分镜/运镜结构），`result.json` 的 `resultFile` 字段指向它、`files` 为空且 `ok=true` 属正常，别当成「没出产物」。**若 `ok=false`**（任务完成但产物下载失败，如链接过期；或既无文件也无结构）：`result.json` 的 `errors` 有明细、`task.json` 保留——凭其中的 `taskId` 可稍后人工恢复取回，别急着重跑整条（重跑会重新计费）。
7. **透传高级参数**：命令没为某个云端参数开 flag 时，用 `--param k=v`（可重复）或 `--params-json '<对象>'` 直接透传（如 `image_move` 想指定输出几何 `--param width=1080 --param height=1920`）。
8. **单发单收、批量靠循环**：一次一个输入；用户要批处理就你逐个循环调，不是一条命令喂多文件。

图片比例转换常用形态：`gtrk tool image_canvas_adapt ./photo.jpg --canvas-width 1080 --canvas-height 1920 --canvas-type rectangle --json`。`--canvas-type` 只接受实际运行时契约 `normal`、`rectangle`、`square`；不要传旧文档中的 `fit`。省略画布参数时不替服务端写死默认值。

这七个公共视频工具（去黑边、比例转换、防抖、蒸汽波、净化、超分、插帧）都只接本地文件，允许扩展名为 `.mp4/.avi/.mpg/.mov/.flv/.mxf/.mpeg/.ogg/.3gp/.wmv/.h264/.m4v/.ts`；不要把 `.mkv`、`.webm` 或 URL 交给它们。

- 视频比例转换：`gtrk tool video_canvas_adapt ./clip.mp4 --canvas-width 1080 --canvas-height 1920 --canvas-type rectangle --clip-start 12 --clip-end 60 --without-audio --json`。`--clip-start/--clip-end` 传起止帧序号；省略选项就沿用服务端默认，需要保留音轨时不要传 `--without-audio`。
- 视频防抖：`gtrk tool video_stabilizer ./clip.mp4 --stabilizer-method turbo --json`。支持 `fast`、`exp`、`turbo`；未传时由服务端使用 `turbo`，`exp` 只按实验方式转述，不承诺观感。
- 蒸汽波滤镜：`gtrk tool video_vaporwave ./clip.mp4 --vaporwave-filter "灼熱苦夏" --json`。滤镜名原样精确传递，不翻译、不猜别名；未传时 CLI 明确使用 `愈漸升溫`。
- 视频净化：`gtrk tool video_purify ./clip.mp4 --purify-scope custom --purify-method ffmpeg --purify-roi 0,0.78,1,0.2 --json`。ROI 是 `x,y,w,h` 归一化坐标，只能和 `custom` 同用；`raft` 仅支持 20 分钟以内视频，`ffmpeg` 不套用这个上限。只处理用户有权修改的素材，不宣称能还原被遮挡的原始内容。
- 视频超分：`gtrk tool video_upscale ./clip.mp4 --upscale-times 3 --upscale-type Anime --json`。输入最多 60 秒，放大后任一边超过 4000 px 会由服务端拒绝；这是实验性增强，不能承诺主观画质一定提升。
- 视频插帧：`gtrk tool video_interpolate ./clip.mp4 --interpolate-multiplier 3 --json`。支持 `2`、`3`、`4`，不套用旧总览里的 1 分钟限制；原视频任一边超过 4000 px 时由服务端拒绝。

净化、超分、插帧属于长耗时 GPU 任务，CLI 最多持续轮询 4 小时。超时只表示本次等待结束，不等于云端任务已取消；保留输出目录中的 `task.json` / `result.json`，按 `taskId` 查询或恢复，避免直接重跑造成重复计费。

### 某工具显示「未开放」时怎么回应

清单里若某工具状态为**未开放**（带原因），如实告诉用户「这个能力暂时没开放」即可——**不承诺开放时间点、不展开内部原因细节**。当前清单内工具均已上线，此话术是通用兜底。

## 与栏目生产 skill 的边界

本 skill 是**框架向导**、不含任何审美/栏目设定：它只教「怎么调 `gtrk tool`」，不规定运镜风格、不规定抠像用在什么画面上——那些是你自己的创作判断或栏目资产的事。工具族只认「输入 → 产物」的通用契约。

## 毕业条款

某个工具若长出复杂度——需要多模式子命令、需要分步用户确认、需要注入栏目风格——它就该从工具族**毕业**成独立命令 / 独立 skill（照成片车道命令的先例）。毕业后旧的 `gtrk tool <名>` 会报错并指路新命令。你只要跟着 `gtrk tool list` 的当前清单走即可。
