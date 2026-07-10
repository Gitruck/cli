## Why

`narrative`(八叙事功能)、`container_stage`(七容器阶段)、`base_track`、`lane` 都是**《实在界漫游指南》专属的视觉叙事语法**,却被**硬编码 + 硬枚举校验**在 `src/lib/splitdoc.ts`(`NARRATIVES`/`CONTAINER_STAGES`/`BASE_TRACKS`/`LANES` + :158-159 校验闸门)。主理人 challenge 一针见血:这些概念**不通用**——科普栏目是"论点-论据-结论"、vlog 是"日常流水"、带货是"痛点-卖点-促单",各有各的叙事结构,甚至没有"容器"概念。

gtrk-cli 要对外发布 + 支撑多栏目,必须把这些"栏目专属 DNA"从写死变成**「视频栏目配置文档」**——每个栏目自带词表。且成片需求是**交并集非父子集**(主理人拍板):不是"栏目继承默认再打补丁",而是每个维度带自己的集合算子折叠。好消息:审计确认客户端对 narrative/container **纯字符串展示、不校验值**——词表化**零客户端改动**,CLI 只需把"硬枚举校验"放宽成"栏目 vocab 词表",并留一套默认配置(《实在界漫游指南》)让小白零配置也能跑完。

## What Changes

- **栏目配置文档 schema**(`column_config`):`meta`(id/name/version) + `vocab`(narrative/container_stage/base_track 词表) + `lanes`(启用集 + 外观,P0 只读不强改) + `broll`(检索偏好:column_tag_ids/facet 默认/material_class 策略) + `style`(**空占位**,内部形态由后续 change `add-column-style-meta-skill` 定形为不透明引用清单,本 change 不设任何框架可读视觉字段) + `fallback`。
- **四层解析 + 逐维度算子**(交并集语义):有效配置 = `fold([L0内置默认, L1矩阵后端, L2本地, L3工程钉存])`,每维度带算子——**词表/lane 启用集/栏目标签 = UNION(附加不丢)**、**facet 可用集 = INTERSECTION(收窄)**、**外观/风格/material_class 策略 = OVERRIDE(换装)**。P0 落地 L0(内置默认)+ L2(本地 `~/.gitruck/columns/*.json`,经 paths.ts 统一目录),复用 `readUserConfig` 范式。
- **narrative/container_stage/base_track 校验放宽**:`splitdoc.ts:158-159` 从"硬八/七枚举"改为"**当前有效栏目配置的 vocab 词表**";默认栏目(《实在界漫游指南》)的内置词表 = 现有八/七枚举,行为不变。
- **默认兜底**:无任何栏目配置 → 只评 L0 内置默认(= 现《实在界漫游指南》词表 + lane 四枚举),**小白零配置端到端能跑完**,现有行为逐字节不变。
- **命令接线**:`gtrk split` 等加 `--column <id>`(或 config 默认栏目)选取有效栏目配置;缺省 = 默认栏目。
- gtrk-splitter skill:方法论章节标注"narrative/container 词表随栏目配置,非固定八/七枚举"。

## Capabilities

### New Capabilities
- `column-config`: 视频栏目配置文档——schema + 四层逐维度算子折叠 + 词表放宽(narrative/container/base_track)+ 默认兜底,让栏目专属叙事语法从硬编码变配置驱动。

### Modified Capabilities
- `split-doc-contract`: 顶层结构 requirement 中 narrative/container_stage/base_track 的校验源从硬枚举改为「有效栏目配置 vocab」(默认栏目=原枚举,行为不变);lane 仍硬四枚举不动。

## Impact

- 代码:`src/lib/splitdoc.ts`(narrative/container/base_track 校验改查有效 vocab)、新 `src/lib/column-config.ts`(schema + 四层 loader + 算子)、`src/lib/user-config.ts`(复用加载范式)、`gtrk split` 命令接 `--column`。
- 文档:skill `gtrk-splitter` 方法论词表化说明。
- 兼容:纯放宽 + 默认兜底,无配置时逐字节回退现状;`lane` 集 P0 **不动**(仍四枚举)。
- **Out-of-scope(后续 change)**:①L1 矩阵后端配置库(member 隔离,涉 infra/yudao)②L3 `.gtrk` struct_meta 钉存(复用 split 快照范式)③opencut 客户端消费(lane 外观已有 beat.kind 覆写通道就绪,配置 loader 写入即生效,另任务对接)④lane 启用集 UNION 扩展(加新 lane 涉召回队列/handoff 分型/客户端注册表,是 P2 承重面重构,风险大,单独立 change)。
