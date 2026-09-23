# 从素材到可编辑工程

[返回首页](../README.md) · [命令参考](reference.md) · [English](workflow.en.md)

## 先选入口

| 输入 | 入口 | 首轮交付 |
| --- | --- | --- |
| 真人口播，一条或多条，可带外录音频 | `gtrk-talking-head` Skill；只粗剪用 `gtrk oralcut` | 对轨、拼段、粗剪后的工程与文稿 |
| 已有文字稿 | `gtrk-voiceover` Skill | 配音、句级时码与音频驱动工程 |
| 播客、访谈、课程或直播回放 | `gtrk-long2short`；超长直播用 `gtrk-live-slicing` Skill | 每个高光独立的剪辑工程 |
| 影视、游戏、旅拍或探店素材 | `gtrk-narration`，或旅拍、美食预设 | 提炼后的解说稿、配音与配画面工程 |
| 保留现场同期声的素材集 | `gtrk-vlog-docu` Skill | 同期声与旁白交替的纪实工程 |

`oralcut` / `long2short` 的单次源片上限为 **2 小时**，超过会在抽取与上传前拒绝；超长回放先分段。完整教程：[口播](https://hocassian.feishu.cn/wiki/Y6Odw4Kz5iPKMxkOOPJc6FyOnpe) · [配音](https://hocassian.feishu.cn/wiki/CdpewYDOmialPLkjOmacI97Wnfd) · [长剪短](https://hocassian.feishu.cn/wiki/Gls1wTebVi1tpDkeaK8cINqbnMb) · [解说](https://hocassian.feishu.cn/wiki/CmtRwmqzYi5dRtkWKgDc7ApWnre)。

## 按创作顺序推进

1. **确定内容和制作方案。** 核对素材、稿件、画幅、声音和视觉方向。配音先试听调整，满意后再建时间线。
2. **拿到工程与文稿。** 粗剪、选段或从配音建工程；先检查节奏与内容，再继续包装。
3. **安排画面。** 分段派单，检索平台或本地素材。B-roll 与 AI 再现片段都属于底层画面，可分别准备。
4. **确定底层构图。** 在客户端挑选候选轨，检查人脸、主体和安全区。AI 片段未回轨时，可明确先跳过，并在回轨后复查相关构图。
5. **叠加动效。** 按最终画面安排字卡、图解和透明叠层，避免遮住主体。
6. **配乐、字幕与交付。** 时间线确定后上字幕，预览、质检、导出成片或支持的剪辑工程。

可选环节可以省略。快速成片会集中确认关键选择；需要逐步看结果时，对 Agent 说“逐步来”。具体检查点与费用确认以对应 Skill 为准。

## 在哪里对话，在哪里编辑

当前在自己的 AI Agent 里对话，客户端没有内置 AI 对话框。Agent 通过 CLI 创建或修改 `.gtrk`；Windows 客户端打开同一工程，供你预览、挑选和精修。

想调整某一步，可以把具体要求交回 Agent；想自己改，可以在客户端操作。自动化或脚本也可用 `gtrk render` 渲染已有工程，无需把“打开客户端”当作每次渲染的前置条件。

## 交付物与导出边界

| 交付物 | 怎么用 | 边界 |
| --- | --- | --- |
| `gtrk/project.gtrk` | 客户端打开 | 保存多轨结构与支持的动态图等信息 |
| 口播／长剪短的剪映草稿 | 安装时配置草稿目录，完成后在剪映项目列表打开 | 草稿目录内需要固定名 `draft_content.json` 和 `draft_meta_info.json` 成对存在 |
| 口播／长剪短的 `xml/premiere.xml` | 在 Premiere 导入 | 是对应粗剪工程，不代表后续所有客户端效果都可无损互转 |
| 客户端导出的剪映草稿 | 完整包装后继续精修 | 按当前导出能力保留支持的轨道与字幕；动态图可能烤成视频素材，不能当作原 HTML 继续编辑 |
| `gtrk render` 输出的 MP4 | 播放、审核、发布 | 合成可见视频叠层与动态图；关闭的轨道不入片。该命令不导出剪映草稿 |

客户端专有元素、复杂效果和第三方工程格式不能笼统视为全部兼容。需要保留最终视觉效果时，检查渲染成片；需要继续编辑时，同时保留 `.gtrk` 与素材。

## 上传与费用

- **口播粗剪、长剪短工程流程：** 原片保留本地，默认上传抽出的音频。视觉辅助或智能分屏改传压缩代理。
- **本地 B-roll：** 原始素材保留本地；理解可能发送抽帧，云端编排使用结构化信息并按相应规则计费。
- **单点云端工具：** 上传要求取决于工具，例如云端视频处理可能需要视频本体。
- **CLI 渲染：** 视频合成在本地；未命中缓存的动态图需云端渲染，先提示费用。`--no-particles` 可跳过动态图，其他可见视频叠层仍正常合成。
- **AI 生成：** 外部模型服务、独立工作台与 Agent 的费用按各自规则结算。

实际价格和免费额度会变化，查看[计费说明](https://hocassian.feishu.cn/wiki/Iq9NwC3briQ2TJkSrzPcm5Jensd)及运行时查询结果。

## 常用恢复与排障

| 情况 | 处理 |
| --- | --- |
| Skills 未出现 | 新开 Agent 会话；必要时 `gtrk skills install`。不同 Agent 的 Skills 入口不一定是 `/` 菜单 |
| 配置、连接或环境有问题 | `gtrk doctor`；缺 FFmpeg 时先 `gtrk deps status`，再按提示显式安装 |
| 剪映里没有草稿 | 核对草稿根目录及两个固定文件名，详见上表 |
| 口播任务已完成，但结果丢失 | 使用下方恢复命令，或读取产物目录中的 `result.json`，不要先重跑云端 |
| 长任务等待超时 | 超时不等于任务取消；保存 `task.json` / `result.json`，按任务 ID 查询或恢复 |
| 需要升级 | `gtrk upgrade` 同时升级 CLI、刷新 Skills；仅 `npm i -g` 不会刷新 Agent 中的 Skills |
| 旧工程有兼容问题 | 先查 [CHANGELOG](../CHANGELOG.md)，按对应版本说明修复 |

```bash
gtrk oralcut-result <taskId> --out <output-directory>
```

详细参数、JSON 回执、计费确认和恢复限制见[命令参考](reference.md)。
