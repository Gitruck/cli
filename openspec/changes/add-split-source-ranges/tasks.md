# add-split-source-ranges · Tasks

> 路线 B：`.gtrk` 自包含源区间。纯追加输出字段，契约面零变化（design D4）。

## 1. 落地层

- [x] 1.1 `src/lib/splitdoc.ts`：`SplitMetaBeat` 增 `source_ranges?: { st: number; ed: number }[]`；`StructMetaSplit` 增 `material_id?: string`
- [x] 1.2 `buildLanding` opts 增 `sourceIndex?: { materialId, utterances: Map<id, {st, ed}> }`（可选，不传不写新字段）；落轨 beat 组装处按 span 包络写 `source_ranges`（r3 取整，`ed ≤ st` 防御跳过），split 顶层写 `material_id`
- [x] 1.4 `buildLanding` metaBeat 透传拆分稿 `narrative`/`container_stage`/`visual_task`（空值省略）
- [x] 1.3 `src/commands/split.ts` `runLand`：从已加载 transcript 组装 sourceIndex 传入 buildLanding

## 2. 测试

- [x] 2.1 `test/split.test.mjs`：正常落地断言 source_ranges 单元素包络值 + material_id；shrunk beat 仍写全 span 包络；不传 sourceIndex 不写新字段
- [x] 2.2 全量测试绿

## 3. 文档与发版

- [x] 3.1 skill `gtrk-splitter/references/field-schema.md` 落地产物字段清单补 source_ranges / material_id 两行
- [x] 3.2 真机：回声定位工程重跑 `gtrk split` → 检查 struct_meta.split 新字段值与 transcript 对得上
- [ ] 3.3 发版 0.2.5（npm publish + 版本号）

## 4. 跨仓联动（范围外记录，opencut 侧另行提交）

- [x] 4.1 opencut `add-split-beat-lane` 追加任务：loadSplitFromGtrk 优先消费 `source_ranges`+`material_id`（免 transcript/hash 门槛），transcript 读取降为兜底链路
