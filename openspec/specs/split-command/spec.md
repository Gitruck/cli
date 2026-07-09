# split-command Specification

## Purpose
TBD - created by archiving change add-splitter-integration. Update Purpose after archive.
## Requirements
### Requirement: 命令面与双模式

系统 SHALL 提供 `gtrk split [拆分稿.json] --project <dir>` 顶层命令（无嵌套子命令），纯本地同步执行、不发起云端任务：无 positional = **投影视图导出**模式；带 positional = **校验落地**模式。`--project` 指 oralcut 产物目录时 SHALL 自动定位 `gtrk/project.gtrk` 与 `transcript/transcript.json`；非标准布局用 `--gtrk <path>` / `--transcript <path>` 显式兜底。`--json` 模式 stdout 仅一行结果 JSON、人读日志转 stderr（沿 `routeLogsToStderr` 契约）；校验失败进程非 0 退出。

#### Scenario: 视图模式
- **WHEN** `gtrk split --project <oralcut产物目录> --json`
- **THEN** 生成 `split/view.json` 并 stdout 输出视图结果 JSON，退出码 0

#### Scenario: transcript 缺失明确报错
- **WHEN** 工程目录内无 transcript.json（旧任务产物）
- **THEN** 报错并引导「重跑 oralcut（新版本恒出 transcript）或使用 transcribe（规划中）」，不做降级猜测

### Requirement: 落地产物与 struct_meta.split 原子写回

校验落地模式 SHALL 产出三件：① `.gtrk` 的 `struct_meta.split`（`{contract_version, transcript_hash, projected_at, beats:[{id, lane, span, track_st, track_ed, shrunk?, handoff}]}`——投影时刻快照，消费方需新鲜时码 MUST 重新投影）；② `split/dispatch.json` 派单清单（`rrv_mg[]`〔含 `composition_id`=`<工程slug>-<beat_id>`〕/ `film_broll[]`〔含 queries 与轨道区间〕/ `ai_drama[]`）；③ `--md` 时的 `split/visual-split.md` 人读稿（由 JSON 单向渲染，不回读）。写回 `.gtrk` MUST 只修改 `struct_meta.split` 一个键、经临时文件 + rename 原子替换，且写前 MUST 比对文件 mtime 与读取时一致（不一致拒写并提示重试）。

#### Scenario: 只动 struct_meta.split
- **WHEN** 落地成功
- **THEN** `.gtrk` 的 materials/video_track/audio_track/beat_track 与 `struct_meta` 其余键逐字节语义不变，仅 `struct_meta.split` 新增/替换

#### Scenario: 写入窗口冲突拒写
- **WHEN** split 读取 `.gtrk` 后、写回前文件被外部修改（mtime 变化）
- **THEN** 拒绝写入并提示保存冲突，产物三件均不落，退出码非 0

### Requirement: 前置校验与版本门

落地模式 MUST 顺序执行：`.gtrk` `version==="v1"` 门 → 拆分稿结构/枚举校验 → `transcript_hash` 比对（硬拒）→ utterance id 合法性 → 投影。任一失败即整体失败、零副作用（无部分写入）。

#### Scenario: v0 工程被拒
- **WHEN** `--gtrk` 指向 version 非 v1 的工程文件
- **THEN** 直接拒绝并提示用新链路重产 v1 工程

