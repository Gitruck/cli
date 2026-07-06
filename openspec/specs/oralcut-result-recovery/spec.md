# oralcut-result-recovery Specification

## Purpose
TBD - created by archiving change oralcut-resumable-report. Update Purpose after archive.
## Requirements
### Requirement: 按 task_id 取回已完成任务结果
CLI SHALL 提供 `gtrk oralcut-result <taskId>` 命令，按 `task_id` 从云端取回一个已完成口播剪辑任务的报告与三方工程产物，并写入 `result.json`。该命令 MUST NOT 触发本地预处理、上传、任务提交或轮询等待；它 SHALL 复用既有的产物下载/按格式分组/剪映拷贝路径把产物落地到产物目录。

#### Scenario: 已完成任务重新落地报告与产物
- **WHEN** 用户对一个已完成任务运行 `gtrk oralcut-result <taskId>`
- **THEN** 命令一次性取回结果，把三方产物下载到产物目录，并写入含报告的 `result.json`，全程不重跑云端流水线

#### Scenario: --render 从 gtrk 重渲成片
- **WHEN** 用户运行 `gtrk oralcut-result <taskId> --render` 且原毛片仍在 gtrk 内嵌路径
- **THEN** 命令按 gtrk 用本地 ffmpeg 渲染出成片 mp4

#### Scenario: --json 输出与主命令同构
- **WHEN** 用户运行 `gtrk oralcut-result <taskId> --json`
- **THEN** stdout 输出与 `gtrk oralcut --json` 同构的单行结果 JSON（含 report / files / taskId 等字段）

### Requirement: 未完成与鉴权失败清晰处理
`gtrk oralcut-result` 对非「已完成」状态 SHALL 给出清晰报错并以非零码退出；对不属于当前账号或已软删的任务 SHALL 呈现 `TASK_NOT_FOUND` 语义提示（取结果需与提交者同账号）。

#### Scenario: 任务仍在处理中
- **WHEN** 目标任务尚未完成（processing / queued）
- **THEN** 命令报出当前状态并以非零码退出，不产出结果清单

#### Scenario: 异账号或已删任务
- **WHEN** `task_id` 不属于当前账号或已被软删
- **THEN** 命令呈现 `TASK_NOT_FOUND` 语义提示，并明确「须用提交该任务的同一账号 key」

### Requirement: 产物过期时仍恢复报告
当任务的底层产物文件已过保留期而下载返回 404 时，`gtrk oralcut-result` SHALL 仍打印并落盘报告（报告存于任务记录、不随文件过期而消失），并明确告知产物文件已过期。

#### Scenario: 产物已被 GC
- **WHEN** 距任务完成已超过文件保留窗口、产物下载返回 404
- **THEN** 命令仍输出并写入报告，同时提示「产物文件已过期、报告仍可用」

