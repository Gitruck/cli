# split-source-ranges · Spec Delta

## ADDED Requirements

### Requirement: 落地产物携带 beat 源时基区间

`gtrk split` 校验通过落地时，`struct_meta.split.beats[]` 的每个落轨 beat SHALL 携带 `source_ranges: {st, ed}[]`（源素材时基，秒，三位小数）——取值为该 beat span 的源时基包络 `[from.st, to.ed]`（含句间静默与被剪词，消费方以「源区间 ∩ 当刻颗粒源窗口」投影即得实际覆盖）。v1 SHALL 恒为单元素数组（数组形状为按实例精化预留）。包络端点异常（`ed ≤ st`）时 SHALL 跳过该 beat 的 source_ranges 且 MUST NOT 阻断落地。拆分稿输入契约、校验规则与 `contract_version` MUST NOT 因此变化（源区间是 CLI 落地输出，拆分稿「零时码」铁律不变）。

#### Scenario: 落地后 beat 自带源区间
- **WHEN** 拆分稿校验通过、`gtrk split` 写回 struct_meta.split
- **THEN** 每个落轨 beat 含 `source_ranges`，其唯一元素等于 span 首句源起点与末句源终点的包络（三位小数）

#### Scenario: shrunk beat 仍写全 span 包络
- **WHEN** 某 beat span 内部分 utterance 已被剪（落地记 shrunk）
- **THEN** 其 source_ranges 仍为全 span 包络——被剪词不在成片则消费方求交自然不亮，用户恢复（变长）后即点亮

### Requirement: 落地产物携带口播素材 id

`struct_meta.split` 顶层 SHALL 携带 `material_id`（= transcript.material_id），使消费方脱离 transcript 文件即可定位口播素材。旧快照（无该字段）的消费方 SHALL 容缺降级，不视为错误。

#### Scenario: 客户端零外部文件定位素材
- **WHEN** 客户端读入含 material_id 与 source_ranges 的 struct_meta.split
- **THEN** 无需读取 transcript.json 即可经素材绑定定位口播颗粒并做实时跟随投影

### Requirement: 向后兼容纯追加

新增字段 SHALL 为纯追加：`view.json`、`dispatch.json`、拆分稿校验器、写回层行为均 MUST NOT 变化；不识别新字段的旧消费方 MUST NOT 受影响。

#### Scenario: 旧消费方无感
- **WHEN** 下游（matrix/rrv/ai-drama 或旧版客户端）读取新版落地产物
- **THEN** 未知字段被忽略，现有消费路径行为不变
