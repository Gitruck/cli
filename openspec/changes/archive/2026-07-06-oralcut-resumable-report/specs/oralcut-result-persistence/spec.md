## ADDED Requirements

### Requirement: 结果报告恒落盘产物目录
口播剪辑跑批 SHALL 在产物目录写入机读 `result.json`，且该行为 MUST NOT 依赖 `--json` 开关。`result.json` MUST 包含该次剪辑的报告对象（`report`）、三方产物清单、错误集合、`taskId` 与 `fileId`。系统 SHALL 在云端轮询返回后、下载三方产物之前先写入一版 `result.json`，使报告能在其后的下载或渲染失败时依然留存于磁盘。

#### Scenario: 未传 --json 也落盘报告
- **WHEN** 用户不带 `--json` 跑完一次口播剪辑
- **THEN** 产物目录存在 `result.json`，其 `report` 为该次剪辑的完整报告对象

#### Scenario: stdout 被重定向仍可从磁盘取回报告
- **WHEN** 用户带 `--json` 跑批但把 stdout 重定向到 /dev/null
- **THEN** 报告仍完整保存在产物目录的 `result.json` 中

#### Scenario: 下载阶段失败报告不丢
- **WHEN** 云端任务已完成、`result.json` 已先行写入，随后某个三方产物下载失败
- **THEN** 进程虽以失败告终，但 `result.json`（含报告与 `taskId`）已在磁盘、可据以恢复

### Requirement: 提交后写任务面包屑
口播剪辑跑批 SHALL 在云端任务提交成功的瞬间，于产物目录写入 `task.json`，至少包含 `taskId`、`taskType`、`fileId`、源毛片路径、请求格式与创建时间。

#### Scenario: 中途崩溃留下可恢复指针
- **WHEN** 任务已提交，但轮询或下载阶段进程崩溃或异常退出
- **THEN** 产物目录中存在 `task.json`，其 `taskId` 足以据以按 task_id 恢复该任务

### Requirement: 失败不留空壳产物目录
口播剪辑跑批 SHALL NOT 在产生任何可写产物之前创建产物目录；产物目录 MUST 仅在首次真正写入（任务面包屑、产物文件或结果清单）时按需创建。

#### Scenario: 提交前失败不建目录
- **WHEN** 本地预处理或上传阶段失败（尚未提交云端任务）
- **THEN** 不存在任何空的产物目录残留

#### Scenario: 提交后失败目录含面包屑而非空壳
- **WHEN** 任务已提交、但其后阶段失败
- **THEN** 产物目录存在且至少含 `task.json`（可恢复），而非空壳目录
