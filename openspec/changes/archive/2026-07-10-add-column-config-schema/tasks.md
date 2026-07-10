# add-column-config-schema · Tasks

> Change D-P0(cli 仓):栏目配置文档 schema + 四层算子(L0/L2)+ narrative/container/base_track 词表放宽 + 默认兜底。兑现主理人 challenge(叙事/容器非通用,进栏目配置)。lane 集不动(P2),L1/L3/opencut 后续。

## 1. schema + loader

- [x] 1.1 `src/lib/column-config.ts`:`ColumnConfig` 类型(meta/vocab/lanes/broll/style/fallback,全可选);内置默认 `DEFAULT_COLUMN_CONFIG`(= 《实在界漫游指南》,引用 splitdoc 的 NARRATIVES/CONTAINER_STAGES/BASE_TRACKS/LANES)。**style 本 change 只留空占位 `style?: unknown`**(内部形态由后续 change `add-column-style-meta-skill` 定形为引用清单;不实现 palette/aspect_ratio 等任何框架可读视觉字段——那是框架预设视觉维度,违反审美零预设)
- [x] 1.2 逐维度算子折叠 `foldColumnConfigs(layers)`:vocab/lanes.enabled/column_tag_ids=UNION、facet_allowed=INTERSECTION、appearance/material_class_policy/facet_defaults/style=OVERRIDE
- [x] 1.3 四层加载(P0 仅 L0+L2):`resolveColumnConfig({ columnId })` = fold([L0 内置, L2 `~/.gitruck/columns/<id>.json`,经 paths.ts `gitruckHome()`]);L1/L3 留 TODO 钩子
- [x] 1.4 宽松解析本地配置(非法字段跳过/整体损坏回落内置默认,不抛)

## 2. 校验放宽

- [x] 2.1 `splitdoc.ts` `validateSplitDoc` 收 `vocab`(来自有效配置);narrative/container_stage/base_track 校验改 `enumOk(x, vocab.*)`;NARRATIVES/CONTAINER_STAGES/BASE_TRACKS 常量保留为默认 vocab
- [x] 2.2 `fallback.unknown_narrative=allow` 时跳过该三项校验(自由串)
- [x] 2.3 `gtrk split`(runLand)接 `--column <id>` → resolveColumnConfig → 传 vocab 给 validateSplitDoc;缺省 = 内置默认

## 3. 测试

- [x] 3.1 **默认兜底铁律**:无 column/无配置时 split 校验+落地+派单与现状逐字节等价(现有用例不变)
- [x] 3.2 折叠算子:vocab UNION(默认∪栏目)、facet_allowed INTERSECTION、appearance OVERRIDE
- [x] 3.3 校验放宽:自定义 vocab.narrative 命中通过;非 vocab 值被拒(unknown=reject);unknown=allow 时放行
- [x] 3.4 本地配置宽松解析(损坏→回落默认)

## 4. 文档

- [x] 4.1 skill `gtrk-splitter` 方法论:标注 narrative/container/base_track 词表随栏目配置(非固定八/七枚举);默认栏目仍用现枚举
- [x] 4.2 全量 bun test 绿 + tsc 零新增

## 5. 后续(范围外,记录)

- 5.1 L1 矩阵后端配置库(member 隔离,涉 infra/yudao)——另 change
- 5.2 L3 `.gtrk` struct_meta 栏目配置钉存(复用 split 快照范式)——另 change
- 5.3 opencut 消费:配置 loader → beat.kind(lane 外观覆写通道就绪)——opencut 侧任务
- 5.4 lane 启用集 UNION 扩展(加新 lane 涉召回队列/handoff/客户端注册表 P2 承重面)——单独 change
