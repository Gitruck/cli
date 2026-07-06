## Why

一次真实的口播剪辑闭环跑批暴露了两处生产级痛点，均已逐行溯源确认：剪辑报告（时长/覆盖率/剔除段/终稿来源等）只在 `--json` 下经 stdout 输出一次、全程不落盘，stdout 一旦被重定向或丢失，报告即永久不可恢复；而后端明明已用幂等 GET 按 `task_id` 持久返回整份任务结果，CLI 却没有任何入口去取它——只能重跑整条分钟级云端任务来找回一份服务端本就存着的报告。与之相连的失败卫生问题：预下载阶段任一步抛异常都会留下一个空壳产物目录，且 `task_id` 未落盘、无从恢复。

## What Changes

- 新增命令 `gtrk oralcut result <taskId> [--out <dir>] [--render] [--json]`：按 `task_id` 从云端取回已完成任务的报告 + 三方工程产物（可选本地渲染成片），**跳过预处理/上传/提交/轮询**；复用现有的下载/按格式分组/剪映拷贝/渲染代码路径。
- 在 `src/lib/cloud.ts` 抽出单发原语 `getTaskResult(cfg, taskType, taskId)`（返回完整 `{status, progress?, output}`）；`pollTask` 复用它（消除内联 GET 重复）。
- 正常 `gtrk oralcut` 跑批**恒写 `<outDir>/result.json`**（不受 `--json` 约束）：在轮询返回后、下载之前先写一版，使报告能扛住其后的下载/渲染失败；下载渲染完成后再补写解析出的本地路径。
- 跑批在 submit 成功的瞬间写 `<outDir>/task.json` 面包屑，并把 `outDir` 的创建**延后到首次真正写入**——预下载阶段失败不再留空壳目录，任何中途崩溃都留下可恢复的 `task_id` 指针。
- `result` 命令优雅降级：底层产物文件若已过保留期（≥60 天被 GC）导致下载 404，仍打印/落盘报告（报告存于任务行、不受该 60 天文件保留期限制）；异账号/软删任务给出清晰的 `TASK_NOT_FOUND`（取结果需同账号鉴权）。
- **零后端改动**。

## Capabilities

### New Capabilities
- `oralcut-result-persistence`: 口播剪辑跑批把结果/报告与任务面包屑持久化落盘到产物目录，且失败时永不遗留空壳产物目录。
- `oralcut-result-recovery`: 按 `task_id` 取回并重新落地一个已完成口播剪辑任务的报告与三方工程产物（可选重渲成片），无需重跑云端流水线。

### Modified Capabilities
<!-- 无：openspec/specs/ 尚无已归档基线可作 delta；跑批新增的落盘行为归入上面的新能力表述。 -->

## Impact

- 代码：`src/lib/cloud.ts`（新增 `getTaskResult`、`pollTask` 复用之）；`src/commands/oralcut.ts`（恒写 result.json、写 task.json 面包屑、延后 outDir mkdir）；新增 `src/commands/oralcut-result.ts`（`src/index.ts` 一行注册，沿用 `register<Name>` 约定）。
- CLI 界面：新增 `gtrk oralcut result <taskId>`；既有 `gtrk oralcut <input>` 额外产出磁盘上的 `result.json` / `task.json`（增量、非破坏）。
- 后端：无。依赖既有 `GET /task/cli/video_oral_cut_for_cli/<task_id>` 与无签名确定性内容寻址 `download_url`；遵守同账号鉴权 scope 与 60 天文件保留窗口。
- 文档/skill：`gtrk-oralcut` skill 宜后续补上「拿报告直接用 result 命令、不必重跑」的说明（代码外，tasks 内记一条）。
