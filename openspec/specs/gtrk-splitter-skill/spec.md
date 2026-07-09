# gtrk-splitter-skill Specification

## Purpose
TBD - created by archiving change add-splitter-integration. Update Purpose after archive.
## Requirements
### Requirement: skill 收编与分发

`gtrk-splitter` skill SHALL 收编于 `skills/gtrk-splitter/`（SKILL.md + references），随 `gtrk skills install` 安装；原独立 skill `video-script-visual-splitter`（`file/skills/` 下）SHALL 归档进 `file/skills/history/`，此后单一真相源 = cli 仓。references MUST 含：json 契约版字段说明（`field-schema.md`）与 20-beat 金样迁移版（`example-visual-split.json`）。

#### Scenario: 一键安装可用
- **WHEN** 用户执行 `gtrk skills install`
- **THEN** `gtrk-splitter` 与既有 `gtrk-oralcut` 一并装入 agent skills 目录，斜杠可触发

### Requirement: 脑手分工铁律

skill（LLM）SHALL 只做拆分创作：切 beat、判叙事功能/容器阶段、选 lane、写 handoff 与辅助层。skill MUST 从 `gtrk split --project <dir> --json` 的投影视图取材，MUST 只引用视图中存在的 utterance id，MUST NOT 抄写原句文字作定位、MUST NOT 自造/推算任何时码（轨道时码由 CLI 投影产生）。

#### Scenario: 时码零触碰
- **WHEN** skill 产出拆分稿
- **THEN** 拆分稿内不含任何秒级时码字段——时码只在 `gtrk split` 落地时由投影写入 struct_meta/dispatch

### Requirement: 校验修正循环

skill SHALL 在 `gtrk split <拆分稿>` 校验失败时按错误信息逐条修正拆分稿并重试，上限 3 轮；仍失败则把错误原样呈给用户（不静默降级、不绕过校验）。落地成功后 SHALL 向用户回报 dispatch 摘要（各车道 beat 数、被跳过/收缩的 beat 及原因）。

#### Scenario: 幻觉引用被循环消化
- **WHEN** 首轮拆分稿含一个不存在的 utterance id 引用
- **THEN** skill 依据校验错误修正该引用后重试成功，用户看到最终 dispatch 摘要与一次修正说明

