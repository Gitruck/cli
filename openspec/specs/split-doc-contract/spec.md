# split-doc-contract Specification

## Purpose
TBD - created by archiving change add-splitter-integration. Update Purpose after archive.
## Requirements
### Requirement: 拆分稿机器契约 v1 顶层结构

拆分稿 SHALL 为 UTF-8 JSON，必含 `{contract_version:"v1", transcript_hash, beats:[]}`。`transcript_hash` MUST 从投影视图透传（源头 = transcript.json 的 `text_hash`）；落地时以当前 transcript 内容重算比对（见「错版硬拒」需求），不信任字段自述。`queues:{}`（四车道 A_ROLL/RRV_MG/AI_DRAMA/FILM_BROLL 的人读派单摘要）为**可选人读冗余**——机器派单清单 `dispatch.json` 由 `beats[]` 现场生成、不消费 `queues`，故校验器 SHALL NOT 因缺 `queues` 而拒绝合法稿（金样输出仍带 `queues` 供人读/参照）。`beats[]` 每条必含：`id`（`B` + 两位起序号）、`span:{from,to}`（utterance id 区间）、`base_track`、`lane`（四选一：`A_ROLL|RRV_MG|AI_DRAMA|FILM_BROLL`）、`narrative`、`container_stage`、`rhythm`（人读节奏标签，机器不消费）、`visual_task`（一句话）、`irreplaceability`（四枚举）；可选：`handoff`、`aux_layers[]`、`fallback`、`callback_of`、`note`。其中 `base_track`/`narrative`/`container_stage` 的取值校验 SHALL 基于**当前有效栏目配置的 vocab 词表**（见 column-config capability）；默认栏目（零配置）的内置词表 = 原三态/八枚举/七枚举，默认校验行为不变。`lane` 仍为硬四枚举（P0 不动，扩展属 P2 承重面）。

#### Scenario: 合法拆分稿通过结构校验
- **WHEN** 拆分稿含全部必填字段且枚举取值合法（narrative/container_stage/base_track 命中有效栏目 vocab，lane 命中四枚举）
- **THEN** `gtrk split` 结构校验通过，进入 id/投影校验阶段

#### Scenario: 零配置时校验行为与旧契约一致
- **WHEN** 未指定栏目且无本地栏目配置，拆分稿 narrative/container_stage/base_track 取值均命中原八/七/三枚举
- **THEN** 校验通过，行为与词表化前逐字节一致

### Requirement: 文稿范围只认 utterance id，禁原文索引

`span.from/to` 与辅助层挂载范围 MUST 为投影视图中存在的 utterance id；MUST NOT 以原句文字/锚点文本作定位。校验规则：两端 id 存在、`from ≤ to`（id 序）、beats 间区间 MUST NOT 重叠（允许留空隙，未覆盖段默认 A_ROLL 底轨直出）。违反任一条 MUST 整体拒绝（非静默跳过），错误信息逐条列出违规 beat 与原因。

#### Scenario: 幻觉 id 被硬拒
- **WHEN** 某 beat 的 `span.to` 引用了视图中不存在的 `u9999`
- **THEN** `gtrk split` 校验失败、进程非 0 退出，错误列出该 beat id 与非法引用，不产任何落地产物

#### Scenario: 区间重叠被硬拒
- **WHEN** B02 的 span 与 B03 的 span 存在交集
- **THEN** 校验失败并指明重叠的 beat 对

### Requirement: handoff 按 lane 分型

`handoff` SHALL 按 `lane` 分型校验：`RRV_MG` → `{slug_hint?, theme?, bg?, duration_hint}`（`duration_hint` 必填，秒）；`FILM_BROLL` → `{queries:[string,...]（必填非空）, shots?, per_shot_sec?, exclude?[]}`；`AI_DRAMA` → `{narrative?, theme?, emotion_stage?, platform?, shot_count?}`（全可选，下游有推断默认）；`A_ROLL` → 无 handoff（存在即警告忽略）。

#### Scenario: FILM_BROLL 缺 queries 被拒
- **WHEN** 某 `lane="FILM_BROLL"` 的 beat 无 `handoff.queries` 或为空数组
- **THEN** 校验失败，错误指明该 beat 缺检索 query

### Requirement: 错版硬拒（hash 链）

`gtrk split` 落地时 MUST 重新计算当前 `transcript.json` 的 `text_hash` 并与拆分稿 `transcript_hash` 比对，不一致 MUST 硬拒（提示转写已变更、需重新导出视图并重拆），MUST NOT 以警告放行。

#### Scenario: 转写已变更时拒绝落地
- **WHEN** 拆分稿携带的 `transcript_hash` 与当前 transcript.json 不一致
- **THEN** 校验失败、无任何写入，提示重新走「导出视图 → 拆分」流程

