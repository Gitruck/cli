---
name: gtrk-oralcut
description: 智能口播剪辑闭环——把一条口播原视频(毛片)通过同合云云端剪掉废话/重复/长停顿，产出客户端(gtrk)+剪映+PR 三方工程文件并自动打开产物目录。当用户想「剪口播/剪个视频/智能剪辑/去掉废话和停顿/把这条口播剪一版/出剪映草稿/生成剪辑工程/oral cut」时使用本 skill。凡涉及把口播毛片做成可二次精修的剪辑工程，优先用本 skill 驱动 gtrk CLI，不要手搓 ffmpeg。
---

# 口播剪辑（gtrk-oralcut）

把用户的口播毛片，用 `gtrk` CLI 跑通「上传 → 云端智能口播剪辑 → 拉回三方工程文件 → 打开」，再把产物目录 + 三端打开方式回给用户。**CLI 是手、你是脑。**

> 权威操作手册见 gtrk-cli 仓库的 `AGENT.md`（更全、工具无关）；本 skill 是它的 Claude 化薄壳，已自带够用的决策与验证逻辑。

## 前置：CLI 在不在

先 `gtrk doctor` 体检：
- 报「缺 API Key」→ 让用户先跑一次 `gtrk init`（一次性配 Key + 剪映目录，**交互式、需真终端**，你别替他跑）。
- 报云端连不上 / 剪映目录没配 → 照提示让用户处理。
- 全绿就往下走。

## 把用户的话变成一次调用

从用户消息里取这几样，缺关键的就问：

1. **毛片路径**（必需）：口播原视频的本地路径。没有就问。
2. **文稿**：用户给了逐字稿/文字稿 → `--script <稿>`；没给则不传（CLI 会探毛片同名 `.txt`，有就自动按有稿剪、更准；无则云端无稿智能重建）。
3. **节奏**：用户说「快/紧凑/卡点狠」→ `--preset compact`；「稳/别删太多停顿」→ `--preset steady`；没特别说就默认（不传）。
4. **只要某端**：只要客户端 → `--formats gtrk`；只要剪映 → `--formats jianying`；默认三端全给。

## 执行（务必带 `--json`，便于你解析与验证）

```bash
gtrk oralcut "<毛片绝对路径>" [--script "<稿>"] [--preset compact|steady] --json
```

- `--json`：人读日志走 stderr，**stdout 只有一行结果 JSON**：
  `{ ok, outDir, files:{gtrk:[],jianying:[],xml:[]}, jianyingDraftPath, errors, taskId, fileId }`
- 默认会自动打开产物目录文件夹（用户能直接看到文件）；纯批处理才加 `--no-open`。
- 云端处理是分钟级，耐心等命令返回。

## 跑完做一层验证（别只信"成功"二字）

解析 stdout 那行 JSON：
- `ok=false` 或 `errors` 非空 → 如实告诉用户哪个格式没出来、为什么；必要时按用户意图微调重跑（换 `--preset`、补 `--jianying-draft-dir`、加 `--reupload`）。
- 确认 `files.gtrk[0]` 存在；要剪映就确认 `jianyingDraftPath` 非空。

## 回给用户（三端打开方式）

- **客户端**：opencut-rewrite 里「打开工程」选 `files.gtrk[0]`（…/gtrk/project.gtrk）。
- **剪映**：已自动落到剪映草稿目录（`jianyingDraftPath`），开剪映在项目列表里找**同名工程**即可。
- **PR/FCP**：Premiere 里「文件 > 导入」`files.xml[0]`（…/xml/premiere.xml）。

产物目录名形如 `<毛片名>-video-project-<时间戳>`，靠文件名 + 时间认出是哪一次剪辑、互不覆盖。
