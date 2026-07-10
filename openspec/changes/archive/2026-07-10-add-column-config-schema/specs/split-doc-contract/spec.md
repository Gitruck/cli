## MODIFIED Requirements

### Requirement: 拆分稿机器契约 v1 顶层结构

拆分稿 SHALL 为 UTF-8 JSON，必含 `{contract_version:"v1", transcript_hash, beats:[]}`。`transcript_hash` MUST 从投影视图透传（源头 = transcript.json 的 `text_hash`）；落地时以当前 transcript 内容重算比对（见「错版硬拒」需求），不信任字段自述。`queues:{}`（四车道 A_ROLL/RRV_MG/AI_DRAMA/FILM_BROLL 的人读派单摘要）为**可选人读冗余**——机器派单清单 `dispatch.json` 由 `beats[]` 现场生成、不消费 `queues`，故校验器 SHALL NOT 因缺 `queues` 而拒绝合法稿（金样输出仍带 `queues` 供人读/参照）。`beats[]` 每条必含：`id`（`B` + 两位起序号）、`span:{from,to}`（utterance id 区间）、`base_track`、`lane`（四选一：`A_ROLL|RRV_MG|AI_DRAMA|FILM_BROLL`）、`narrative`、`container_stage`、`rhythm`（人读节奏标签，机器不消费）、`visual_task`（一句话）、`irreplaceability`（四枚举）；可选：`handoff`、`aux_layers[]`、`fallback`、`callback_of`、`note`。其中 `base_track`/`narrative`/`container_stage` 的取值校验 SHALL 基于**当前有效栏目配置的 vocab 词表**（见 column-config capability）；默认栏目（零配置）的内置词表 = 原三态/八枚举/七枚举，默认校验行为不变。`lane` 仍为硬四枚举（P0 不动，扩展属 P2 承重面）。

#### Scenario: 合法拆分稿通过结构校验
- **WHEN** 拆分稿含全部必填字段且枚举取值合法（narrative/container_stage/base_track 命中有效栏目 vocab，lane 命中四枚举）
- **THEN** `gtrk split` 结构校验通过，进入 id/投影校验阶段

#### Scenario: 零配置时校验行为与旧契约一致
- **WHEN** 未指定栏目且无本地栏目配置，拆分稿 narrative/container_stage/base_track 取值均命中原八/七/三枚举
- **THEN** 校验通过，行为与词表化前逐字节一致
