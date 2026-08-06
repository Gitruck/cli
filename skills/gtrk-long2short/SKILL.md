---
name: gtrk-long2short
description: 长剪短闭环——把一条长视频（课程/直播/播客/访谈毛片）通过同合云选段跳剪成多条高光短片工程，一次产出逐 clip 的 gtrk+剪映+PR 三方工程（可选智能分屏）。当用户想「长剪短 / 长视频切高光 / 直播切片 / 课程切短视频 / 播客出短片 / 两小时的课切成几条精华」时使用本 skill。凡涉及把长视频拆成多条可精修的短片工程，优先用本 skill 驱动 gtrk CLI 的 `long2short` 命令，不要手搓 ffmpeg、不要人工挑时间码。
---

# 长剪短（gtrk-long2short）

把用户的一条长视频，用 `gtrk` CLI 跑通「**本地抽音频/720p 代理（毛片永不上传）** → 云端语义选段+跳剪（可选分屏）→ 逐 clip 拉回 gtrk/剪映/PR 三方工程」，再把产物目录回给用户。**CLI 是手、你是脑。**

> 与智能剪口播（gtrk-oralcut）同一心智模型；差异是**一次任务出 N 条短片**，各自一份工程组落 `clip{i}/` 子目录。

## 前置：CLI 装没装 + 体检

先跑 `gtrk doctor`：
- **`gtrk` 找不到** → 让用户装 `npm i -g @gitruck/cli@latest`（需先有 Node.js），再重试。
- 报「缺 API Key」→ 让用户先跑一次 `gtrk init`（交互式、需真终端，你别替他跑）。
- 全绿就往下走。

## 一条命令

```bash
gtrk long2short "D:/毛片/课程.mp4" --language zh-CN --json
```

对谈/多人同框想要分屏：

```bash
gtrk long2short "D:/毛片/对谈.mp4" --language zh-CN --split-screen --split-orientation tb --json
```

## 参数表

| 参数 | 说明 |
|---|---|
| `--language <code>` | **必填**，源语种（如 zh-CN；取值以服务端支持列表为准，传错服务端会报枚举） |
| `--split-screen` | 开启智能分屏：本地改传 **720p 代理**（否则只抽音频）；云端检测多人同框段并烤 720p 分屏素材 |
| `--split-orientation <o>` | 分屏方向 `auto|lr|tb`（缺省 auto=按内容可复现随机） |
| `--main-topic <text>` | 主题引导，影响选段偏好 |
| `--duration-pref <p>` / `--max-clip-sec <n>` | 成片时长偏好 / 单条上限秒。**成片条数由内容语义决定，不能指定条数** |
| `--no-jump-cut` | 关闭跳剪（默认开：片内去水词冗余，只删不重排） |
| `--output-size <s>` | 画布 `9:16|16:9|1:1` 或 `WxH`（缺省 9:16 竖版） |
| `-f, --formats <list>` | 三方格式，缺省 `gtrk,jianying,xml`（云端逐 clip 直产；gtrk 恒有） |
| `--jianying-draft-dir <dir>` | 剪映草稿根（或 `auto`）；各 clip 草稿落 `<草稿根>/<产物根名>_clip{i}` |
| `-o/--out`、`--no-open`、`--json`、`--reupload`、`--param/--params-json` | 与 oralcut 同口径 |

## 计费与跑前须知（每次都转述给用户）

- 运行时 CLI 自动查询实时价格并在跑前打印——**把计费提示原样转述**；按**上传物音频时长**计费（≈原片时长），**长片先向用户确认再跑**。
- 云端处理时长随片长涨（ASR+选段），CLI 轮询墙钟 60 分钟；超时不丢——产物根 `task.json` 里有 `task_id` 可恢复。

## 产物（跑完把这些讲给用户）

- 产物根 `<毛片名>-long2short/`：`report.json`（选段报告）+ `result.json` + 逐 clip 子目录 `clip0/ clip1/ …`（各含 `gtrk/` 客户端工程、`jianying/` 草稿、`xml/` PR 工程）。
- 开了 `--split-screen` 时：**分屏素材落在毛片旁的 `split_screen/` 子目录**（工程素材路径指向那里，别移动/删除，移动了工程会缺素材）——这点要提前告知用户。
- 剪映草稿已拷入草稿根（给了 `--jianying-draft-dir` 时），剪映里直接可见 `<产物根名>_clip{i}`。**判据**：草稿目录里必须是 `draft_content.json` + `draft_meta_info.json` 两个精确文件名（云端产物侧的 `clip{i}_` 前缀在拷进草稿根这一跳被剥掉，产物目录 `clip{i}/jianying/` 里保留带前缀的归档原名）。CLI 日志按实际齐全条数报「N/M 条两件套齐全」，不齐的记进 `result.json` 的 `errors`、该 clip 的 `jianyingDraftPath` 为 `null`。

## 排错

- **部分 clip 失败 / 个别分屏素材 404**：单点失败不连坐，`result.json` 的 `errors` 有明细；把失败项如实告诉用户，其余产物照常可用。
- **轮询超时/进程中断**：凭产物根 `task.json` 的 `task_id` 查询云端状态；任务在云端照常跑完，稍后可重取。
- **clips 为空**：说明内容里没有可成片的高光段（纯语义选段），把 `report.json` 摘要给用户看原因。
- **剪映里看不到草稿**：先看草稿目录里的**文件名**——必须是 `draft_content.json` + `draft_meta_info.json`，缺一件或带前缀剪映都不显示；`result.json` 里该 clip 的 `jianyingDraftPath` 为 `null` 即是此症。
