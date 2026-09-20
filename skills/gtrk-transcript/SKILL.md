---
name: gtrk-transcript
description: 将用户本地视频或音频（自备配音）转成一个飞书妙记式 Markdown 文字稿，并由 Agent 基于完整转写生成总结；音频配 --json 时另产句级时码 transcript.json（音频驱动工程兜底路输入）。用户说“视频转文字稿 / 视频转文字 / 提取视频文稿 / 把本地视频整理成文字稿或妙记 / 给我自己录的配音出时码稿”时使用。只处理本地文件，不接受 URL、平台链接或远端下载。
---

# gtrk 视频/音频转文字稿

飞书使用教程统一入口：[gtrk CLI 使用教程](https://hocassian.feishu.cn/wiki/HCFpwoF7SivIFbkKosgcFMcEnxk)。

本 Skill 驱动一级命令 `gtrk transcript`，最终只交付一个 Markdown：总结、带 `[00:01:23]` 时间戳的可读文字记录、完整纯文本。

## 音频输入与 transcript.json（自备配音时码化兜底）

- 输入白名单已放开音频：wav/mp3/flac/m4a/aac/ogg 等本地音频文件可直接转写（音频无「抽音频」步——已是音频，仍本地转 16k 单声道后只传转码衍生物，原文件不动）。
- `--json` 除机读 stdout 外**另产 `<名>-transcript.json`**（`utterances[]{id,text,st,ed}` + `material_id` + `text_hash` + `duration`，结构与 `gtrk split` 消费契约逐字段对齐）；结果 JSON 的 `transcriptJson` 字段给出路径，可直接被 `gtrk project init --audio <配音> --transcript <该文件>` 兜底路消费。
- **定位注记（MUST 遵守）：TTS 主路勿走本零件**——`gtrk tool audio_tts_clone` 产的配音自带句级 segments（时码直出、零成本零误差），建工程直接 `gtrk project init --tts-task <task_id>`；对 TTS 产物再跑一遍 ASR 转写=重复计费零收益。本零件只服务**自备配音**（用户自录旁白等无时码音频）场景。

## 硬边界

> **产物落点纪律（MUST · 全文见随包 `AGENT.md` 同名一节）**：
> 唯一 Markdown 产物只落 CLI 返回的 `output` 路径（缺省 = 视频同目录）或**用户显式指定的 `--out`**；
> **MUST NOT** 把原视频或任何大媒体文件复制到 agent 自有工作目录（如用户文档目录下 agent 产品自建的目录、agent 家目录缓存、会话工作区）——需要引用媒体时**用原路径引用**，不做副本；
> 临时文件一律放系统 temp 且**用完即删**（含中断 / 失败路径）。违者后果 = 用户系统盘被静默吃满（真机事故，非假设）。
> 交付物（颗粒 HTML / 工程文件 / 派单稿 / 文稿等）SHALL **直接以工程目录内的最终路径为写入路径**，MUST NOT 先写 agent 自有工作目录再拷进工程——**中转本身即违规**，不以「最后拷进去了」免责，**体积不是豁免理由**（2026-09-07 事故里漂掉的是 2.7–6.2 KB 的 HTML）。与上一条的分界：抽帧图这类**不交付**的中间物走系统 temp；**要交付的东西没有暂存态**。

- 只接收用户电脑上已存在的视频/音频文件；遇到 URL、平台视频 ID 或“帮我下载后转写”时，要求用户先提供本地文件，不代为抓取。
- CLI 在本地抽取/转码 16 kHz 单声道音频，只上传音频衍生物；原视频/原音频文件不得上传。
- 最终只保留 CLI 返回的产物：一个 Markdown（`--json` 时另有 CLI 自产的 `<名>-transcript.json`），不另建总结、字幕、TXT 或 HTML 文件。
- 没有可靠的说话人分离数据时，不得编造“说话人 1/2”等标签。
- 价格必须以本次 CLI 从官网价格表得到的实时提示为准，不写死金额、不凭记忆报价。

## 工作流

1. 确认用户给的是本地视频路径；需要时再接受输出文件路径或识别语言。

2. **先判用途，再决定带不带 `--json`。这一步 MUST NOT 跳过，也 MUST NOT 无脑恒带。**

   `--json` 不是「输出格式」开关，**它决定服务端用哪个引擎**（2026-09-19 起，cli change `adjust-transcript-json-word-level`）：

   | 用途 | 命令 | 落腿 |
   |---|---|---|
   | **只要一份能读的文字稿**（默认，含「转文字/提取文稿/出妙记/整理成文档」） | 不带 `--json` | 自部署引擎 + 服务端纠错，句级时码 |
   | **产物要喂工程**（`project init` 兜底路 / `split` 拆分 / `subtitle` 字幕按语音贴时间） | 带 `--json` | 厂商字级腿，`utterances[].words[]` 承载字级 |

   ```bash
   # 默认：只要文字稿
   gtrk transcript "D:/素材/采访视频.mp4" --out "D:/素材/采访视频-transcript.md"

   # 要喂工程时才加 --json
   gtrk transcript "D:/配音/旁白.mp3" --json
   ```

   可选参数：`--out <file>`、`--lang zh-CN`、`--ffmpeg-path <dir>`、`--reupload`。

   > 🔴 **恒带 `--json` 会把「只想要文字稿」的请求也送进厂商付费腿**，且用户拿不到任何额外好处
   > —— Markdown 只渲染句子，`words[]` 一个字都不被读。2026-09-19 一次 254 条的批量转写因此
   > 有 122 条走错了腿，实测发现。**拿不准就不带**：真需要字级时，消费方（`split` / `subtitle`）
   > 会明确报错要 `words[]`，那时补跑一次即可；反过来多付的钱收不回来。
   > 用户明确说「要建工程 / 要拆分 / 要字幕」才算「喂工程」；只说「转个文字稿」不算。

3. 取产物路径，分两种形态：
   - **带 `--json`**：解析 stdout 的唯一 JSON。仅当 `ok:true` 时继续；保存 `taskId`、`output`、
     `transcriptJson`（句级时码稿路径，建工程时交给 `gtrk project init --transcript`），并检查 `summaryPending:true`。
     人读进度在 stderr，不要把日志当成结果 JSON。
   - **不带 `--json`**：stdout 末尾是人读行 `带时码文字稿已生成：<路径>`，**没有结果 JSON**。
     ⇒ 优先显式传 `--out`，这样路径由你指定、无需从日志里抠；缺省路径是 `<源文件同目录>/<源文件名>-transcript.md`。
     判成功用**退出码 + 产物文件存在且非空**，MUST NOT 只看日志里有没有那行字。
     此形态下 `summaryPending` 恒为真（Markdown 里的 `<!-- gtrk:agent-summary-pending -->` 就是判据），
     且**不产 `transcript.json`**。
4. 完整读取 `output` 指向的 Markdown，必须覆盖完整转写内容，不能只看开头几段。
5. 若 `summaryPending:true`，只编辑 `## 总结` 与 `## 文字记录` 之间的内容：删除 `<!-- gtrk:agent-summary-pending -->` 及提示语，写入 3–7 条忠于原文的语义要点。不得改动 `## 文字记录` 和 `## 纯文本`，不得创建第二个文件。
6. 写回后验证：
   - `## 总结`、`## 文字记录`、`## 纯文本` 各出现一次且顺序正确；
   - `gtrk:agent-summary-pending` 已消失；
   - 时间戳文字记录和纯文本仍完整；
   - 返回用户的路径仍是第 3 步拿到的**同一个**产物路径（带 `--json` 时是结果 JSON 的 `output`，
     不带时是你传的 `--out` 或那条缺省路径）——MUST NOT 换成副本或新建文件。

## 总结标准

- 提炼主题、关键论点或事实、重要数字/人名和结论；合并重复内容。
- 总结应是对全文的压缩，不要只复述第一句或按时间线逐段抄写。
- 只使用转写中能确认的信息；含混或缺失处保持克制，不补充常识性猜测。
- 不在正文中添加服务商、底层 ASR、计费实现等用户未要求的技术说明。

## 失败处理

- 缺 API Key：引导运行 `gtrk init`，不要无效重试。
- 输入是 URL 或远端资源：停止执行，要求用户提供本地视频文件。
- ASR 没有可用文字：如实报告失败，不生成虚假总结或空白成品。
- 云任务失败：报告 CLI 返回的错误与 `taskId`（若有），不要把失败包装成完成。
- 实时价格暂不可用：说明最终以服务端结算为准；不要引用旧价格。
