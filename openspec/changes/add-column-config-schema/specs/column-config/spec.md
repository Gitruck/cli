## ADDED Requirements

### Requirement: 视频栏目配置文档 schema

系统 SHALL 定义栏目配置文档 `column_config`,含 `meta`(id/name/version)、`vocab`(narrative/container_stage/base_track 词表)、`lanes`(enabled + appearance)、`broll`(column_tag_ids/facet 偏好/material_class 策略)、`style`、`fallback` 维度。schema MUST 全字段可选(缺省走默认),使部分配置合法。

#### Scenario: 只配 vocab 的最小栏目配置
- **WHEN** 某栏目配置只含 `meta` + `vocab.narrative`
- **THEN** 该配置合法;未配维度走内置默认

### Requirement: 四层逐维度算子折叠(交并集非父子集)

有效栏目配置 SHALL 为层栈 `[L0内置默认, L1矩阵后端, L2本地, L3工程钉存]` 的**逐维度折叠**,每维度按其算子合并:vocab / lanes.enabled / broll.column_tag_ids = **UNION**;broll.facet_allowed = **INTERSECTION**;lanes.appearance / broll.material_class_policy / facet_defaults / style = **OVERRIDE**。MUST NOT 用单一全局 deep-merge(那是父子继承,非交并集)。P0 SHALL 至少落地 L0 + L2。

#### Scenario: 词表并集不丢默认
- **WHEN** 栏目 L2 配置 `vocab.narrative=["custom-hook"]`
- **THEN** 有效 narrative 词表 = 内置默认八功能 ∪ `custom-hook`(默认词不丢)

#### Scenario: facet 可用集收窄
- **WHEN** 栏目配置 `broll.facet_allowed=["shotType"]`
- **THEN** 有效可用 facet = 默认 ∩ {shotType}(收窄到该维度)

### Requirement: narrative/container/base_track 校验放宽为栏目 vocab

`validateSplitDoc` 对 `narrative`/`container_stage`/`base_track` 的枚举校验 SHALL 基于**当前有效栏目配置的 vocab 词表**,而非写死的八/七/三枚举。默认栏目(《实在界漫游指南》)的内置 vocab SHALL 等于现有 `NARRATIVES`/`CONTAINER_STAGES`/`BASE_TRACKS`,故默认校验行为不变。栏目配置 `fallback.unknown_narrative=allow` 时 SHALL 跳过该校验(纯自由串,支持完全异构栏目)。

#### Scenario: 别的栏目用自己的叙事词表
- **WHEN** 选取一个 vocab.narrative=["论点","论据","结论"] 的科普栏目,拆分稿 narrative="论据"
- **THEN** 校验通过(命中该栏目 vocab),不因非八枚举被拒

#### Scenario: 默认栏目行为不变
- **WHEN** 不指定栏目(默认),拆分稿 narrative="holding"
- **THEN** 校验按内置八枚举通过,与现状一致

### Requirement: 默认兜底(零配置端到端)

无 `--column`、无本地栏目配置时,有效配置 SHALL 为 L0 内置默认(《实在界漫游指南》全套 vocab + lane 四枚举)。此时 `gtrk split` 的校验、落地、派单 MUST 与未引入本 change 时**逐字节等价**。

#### Scenario: 小白零配置跑完
- **WHEN** 用户不做任何栏目配置直接 `gtrk split`
- **THEN** 行为与现状完全一致,不因配置化而破坏
