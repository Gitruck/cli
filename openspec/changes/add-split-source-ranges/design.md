# add-split-source-ranges · Design

## Context

`gtrk split` 落地链路：`runLand`（split.ts:156-227）加载 transcript（:168，utterance 自带源时基 `st/ed`）→ 现场投影 `projectTranscript`（:186）→ `buildLanding(doc, view, opts)` 纯函数产 `landing.split`（splitdoc.ts:338-418）→ `writeStructMetaSplit` 原子写回。当前 `SplitMetaBeat`（splitdoc.ts:267-275）只有轨道时基 `track_st/track_ed` + `span`，无源时基、无素材 id——客户端跟随模式（opencut A′）只好自读 transcript 反解。

## Goals / Non-Goals

**Goals:**
- `.gtrk` 自包含：`struct_meta.split` 携带每 beat 源时基区间 + 口播素材 id，客户端零外部文件即可实时跟随投影
- 语义与 A′ 客户端反解**严格一致**（真机已验收的行为不漂移）
- 纯追加字段：拆分稿输入契约、校验器、投影层、view.json、dispatch、写回层全部零改动

**Non-Goals:**
- 客户端对接（opencut 侧优先吃新字段、transcript 降兜底）——另行小任务
- dispatch.json 携带源区间（下游无消费需求）
- 按投影实例精化的多段源区间（见 D1 预留）

## Decisions

- **D1 source_ranges = span 源包络，v1 恒单元素数组**
  `source_ranges: [{ st: from.st, ed: to.ed }]`（源时基秒，r3 三位小数与投影层一致）。取**span 包络**而非落地时存活实例的精确区间，是刻意对齐 A′ 客户端语义（真机验收基准）：包络含句间静默与被剪词——客户端「源区间 ∩ 当刻颗粒」自然削掉不在成片里的部分；用户**变长恢复**被剪词时立即点亮。若透传存活实例区间，恢复词反而永远不亮（劣化）。数组形状为将来按实例精化预留（若某天需要「只亮落地时存活片段」语义，多段即多元素，客户端已按数组消费）。
- **D2 struct_meta.split 顶层增 `material_id`**
  = `transcript.material_id`。客户端脱离 transcript 后定位口播素材的钥匙（经 ProjectMeta.bindings 反查 mediaId 集）。不放 beat 级——口播工程单素材，顶层一份。
- **D3 buildLanding 扩展 opts 传源索引，保持纯函数**
  `opts` 增 `sourceIndex?: { materialId: string; utterances: Map<string, { st: number; ed: number }> }`；`runLand` 从已加载 transcript 组装传入。可选字段：不传则不写新字段（旧测试用例零波动、防御未来调用方）。span id ∈ utteranceIds 由校验器已保证（transcript 即 id 源），包络异常（`!(ed > st)`）防御性跳过该 beat 的 source_ranges 不阻断落地。
- **D4 契约面零变化**
  `validateSplitDoc` 只管拆分稿输入（splitdoc.ts:108-202），source_ranges/material_id 是落地输出——零改动；`contract_version` 门（:117-119）管输入格式——不 bump；`writeStructMetaSplit` 原样写整棵 split 对象——零改动；拆分稿「零时码」铁律不受影响（时码仍全部由 CLI 现场写入）。
- **D5 文档同步**
  skill `gtrk-splitter/references/field-schema.md` 落地产物字段清单补 `source_ranges`/`material_id` 两行。add-splitter-integration 的 delta（split-command/spec.md 枚举的 beat 字段集）不回改——本 change 自带独立 capability delta，归档次序无耦合。

## Risks / Trade-offs

- [包络 vs 实例精度] span 包络在「beat 内句间静默仍留在成片」时会把静默段算进 beat 覆盖——与 A′ 完全一致（真机已接受），且这本就是「该 beat 的口播区间」的自然语义。需要更细粒度时走 D1 预留的多段精化。
- [旧快照无新字段] 已落地的 .gtrk 没有 source_ranges/material_id——客户端本就宽松解析+A′ 兜底链路，无兼容风险；重跑 `gtrk split` 即升级。
- [transcript 与素材错位] source_ranges 指向素材时间轴，素材文件被替换（同 id 不同内容）时区间失义——与 transcript 本身同风险，非本 change 引入。

## Migration Plan

纯追加输出字段，随 0.2.5 发版；旧版客户端忽略未知字段，新版客户端优先消费、缺字段自动走 A′ 兜底。回滚 = 回退版本，已写入的多余字段无害。

## Open Questions

- 无（客户端对接细节归 opencut 侧任务）
