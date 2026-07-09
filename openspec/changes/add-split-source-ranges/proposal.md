# add-split-source-ranges · Proposal

## Why

客户端 beat 色带的**跟随模式**（opencut `add-split-beat-lane`，路线 A′，已真机验收）靠读工程目录 `json/transcript.json` 反解每个 beat 的源时基区间——工程目录挪走/transcript 缺失/web FSA 越不过授权根时只能回落冻结快照。`gtrk split` 落地时 transcript 全量在手（`runLand` 作用域，split.ts:168），把每 beat 的源区间与口播素材 id 直接写进 `struct_meta.split`，`.gtrk` 即自包含：客户端优先吃现成字段，transcript 读取降为兜底（路线 B，主理人已拍板 A 后做 B）。

## What Changes

- `gtrk split` 落地产物 `struct_meta.split.beats[]` 新增 `source_ranges: {st, ed}[]`（源时基秒）——取值为 **beat span 的源时基包络**（`[from.st, to.ed]`，与客户端 A′ 反解语义完全一致：含句间静默与被剪词，客户端 ∩ 当刻颗粒自然削掉、用户恢复被剪词即点亮）；v1 恒单元素，数组形状为将来按实例精化预留
- `struct_meta.split` 顶层新增 `material_id`（= transcript.material_id）——客户端脱离 transcript 后仍能经 bindings 定位口播素材
- 拆分稿**输入契约零变化**：均为落地输出字段，校验器不涉及；`contract_version` 不 bump（"v1" 门管拆分稿输入格式）
- 投影层（projection.ts）与 `view.json` **零改动**（包络直接取自 transcript span，落地层现算）
- `dispatch.json` 暂不加源区间（下游 matrix/rrv/ai-drama 无消费需求，留观察）
- skill `gtrk-splitter` 的 `references/field-schema.md` 落地产物字段清单补两行
- 发版 0.2.5；客户端对接（优先 `source_ranges`+`material_id`、transcript 读取降为兜底）为 opencut 侧后续小任务，不在本 change 范围

## Capabilities

### New Capabilities
- `split-source-ranges`: gtrk split 落地产物携带 beat 级源时基区间与口播素材 id（.gtrk 自包含支撑客户端实时跟随投影）

### Modified Capabilities
<!-- split-command / timeline-projection 等 spec 仍在 add-splitter-integration 的 delta 中未归档（main specs 尚无），
     本 change 以独立新 capability 描述新增字段，不修改未归档 delta，归档次序无耦合。 -->

## Impact

- 代码：`src/lib/splitdoc.ts`（`SplitMetaBeat`/`StructMetaSplit` 增字段、`buildLanding` 接收 transcript 计算包络）、`src/commands/split.ts`（runLand 把已加载的 transcript 传给 buildLanding）
- 校验/写回：零改动（`validateSplitDoc` 只管输入契约；`gtrk-writeback` 原样写整棵 split）
- 测试：`test/split.test.mjs` 现有断言为字段级 equal 不受影响；新增 source_ranges/material_id 断言
- 文档：skill `gtrk-splitter/references/field-schema.md`
- 下游兼容：纯追加字段，外部消费方（matrix/rrv/ai-drama、opencut 客户端宽松解析）不受影响
