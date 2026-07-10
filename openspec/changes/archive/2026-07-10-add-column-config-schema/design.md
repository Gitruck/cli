## Context

`splitdoc.ts` 硬编码四组《实在界漫游指南》专属枚举:`BASE_TRACKS`(:10 真人出镜/口播继续/旁白主导)、`LANES`(:11 A_ROLL/RRV_MG/AI_DRAMA/FILM_BROLL)、`NARRATIVES`(:12 八功能)、`CONTAINER_STAGES`(:22 七阶段),并在 `validateSplitDoc`(:158-159)硬校验 narrative/container_stage 必须是八/七枚举。审计确认:客户端(opencut)对 narrative/container/visual_task **纯字符串展示、不校验值**(beat 色带 hover 详情卡直取);机器侧这几个字段**惰性**(不参与派单/时码/召回路由),只喂人读 markdown + 客户端展示。CLI 现有配置范式:`readUserConfig`(`~/.gitruck/config.json`,env > config > default;`~/.gtrk-cli` 已被 paths.ts 定为 LEGACY_HOME 仅迁移用)。

## Goals / Non-Goals

**Goals:**
- narrative/container/base_track 从"《实在界漫游指南》硬枚举"→"栏目配置的 vocab 词表",别的栏目可自定义。
- 表达"交并集非父子集"的分层折叠语义(逐维度算子)。
- 小白零配置端到端能跑(默认 = 现《实在界漫游指南》),现有行为逐字节不变。

**Non-Goals:**
- lane 启用集扩展(加第五 lane):涉召回队列/handoff 分型/客户端注册表三层承重面,P2 单独立 change。P0 lane 仍四枚举。
- L1 矩阵后端配置库、L3 工程钉存、opencut 消费:后续 change(见 proposal out-of-scope)。
- 风格化实际渲染(style token 只入 schema,不驱动渲染)。

## Decisions

- **D1 schema 维度**
  ```
  column_config {
    meta:   { id, name, version }
    vocab:  { narrative[], container_stage[], base_track[] }   # 词表(放宽校验的来源)
    lanes:  { enabled[], appearance: { <lane>: {code,label,color,pattern} } }  # P0 只读, appearance 供 opencut 后续
    broll:  { column_tag_ids[], material_class_policy, facet_defaults, facet_allowed[] }  # 供 Change C(matrix)
    style:  {}   # 空占位;内部形态由后续 change add-column-style-meta-skill 定形为不透明引用清单。不设 palette/aspect_ratio 等框架可读视觉字段(那是框架预设视觉维度)
    fallback: { unknown_narrative: allow|reject }
  }
  ```
- **D2 四层解析 + 逐维度算子(交并集核心)**——有效配置 = 在层栈 `[L0内置, L1后端, L2本地, L3工程]` 上**逐维度 fold**,不是全局 deep-merge(那才是父子集):

  | 维度 | 算子 | 语义 |
  |---|---|---|
  | vocab(narrative/container/base_track) | **UNION** | 栏目补领域词,默认词不丢 |
  | lanes.enabled | UNION(P0 恒四枚举,预留) | 栏目可加 lane(P2) |
  | broll.column_tag_ids | UNION(附加) | 栏目附加自己的栏目标签 |
  | broll.facet_allowed | **INTERSECTION** | 栏目收窄可用 facet |
  | lanes.appearance / broll.material_class_policy / facet_defaults / style | **OVERRIDE** | 栏目换装 |

  P0 只落地 **L0(内置默认)+ L2(本地 `~/.gitruck/columns/<id>.json`,经 paths.ts 统一目录)**;L1/L3 后续。一句话概括:**默认给地板,栏目做加(并)/减(交)/换装(覆盖)三种动作**。
- **D3 校验放宽:硬枚举 → 有效 vocab 词表**
  `validateSplitDoc` 收一个 `vocab`(来自有效栏目配置);narrative/container_stage/base_track 校验从 `enumOk(x, NARRATIVES)` 改 `enumOk(x, vocab.narrative)`。默认栏目的内置 vocab = 现有 `NARRATIVES`/`CONTAINER_STAGES`/`BASE_TRACKS`(常量不删,作默认词表),故默认行为不变。`fallback.unknown_narrative=allow` 时甚至不校验(纯自由串,给完全异构栏目)。
- **D4 默认兜底(小白零配置)**
  无 `--column`、无本地配置 → 有效配置 = L0 内置默认(《实在界漫游指南》全套词表 + lane 四枚举)。**splitdoc 校验、落地、派单逐字节等价现状**。skill 产拆分稿默认也用这套。
- **D5 P0 边界只碰 CLI**
  schema + 四层 loader(仅 L0/L2)+ 校验放宽 + `--column`。lane 集不扩(避 P2)。opencut 消费:配置 loader 已能把 lanes.appearance 写进 beat.kind(客户端覆写通道就绪),但对接落 opencut 后续任务,本 change 不改客户端。
- **D6 vocab 常量保留为默认词表**
  `NARRATIVES`/`CONTAINER_STAGES`/`BASE_TRACKS` 不删——它们成为"默认栏目《实在界漫游指南》"的内置 vocab,被 L0 引用。放宽 = 校验源从"写死常量"变"有效配置的 vocab",常量仍是默认值。

## Risks / Trade-offs

- [放宽放行脏 narrative] narrative/container 机器惰性(只喂人读+客户端展示,零路由),放行非常规值零风险;`unknown_narrative=reject`(默认栏目)仍按 vocab 硬拒防手滑,异构栏目可设 allow。
- [默认兜底回归] 无配置 = 内置默认 = 现枚举,测试须覆盖"无配置逐字节等价现状"。
- [lane 不动的克制] lane 集扩展是 P2 承重面,本期只放宽 vocab(惰性字段),不碰 lane(路由承重),把风险挡在 P0 外。
- [schema 前瞻字段] lanes.appearance/broll/style 本期入 schema 但 CLI 未全消费(broll 待 Change C、appearance 待 opencut)——纯前瞻占位,不影响 P0 校验放宽主线。

## Migration Plan

纯新增 schema + loader + 校验源切换,默认兜底保现状。无配置零感知;要定制栏目建 `~/.gitruck/columns/<id>.json` + `--column`。回滚 = 校验源切回常量。

## Open Questions

- 本地配置目录 `~/.gitruck/columns/` vs 单文件多栏目——倾向目录(一栏目一文件,清晰);待主理人定。
- `--column` 缺省栏目:config.json 加 `defaultColumn` 字段,还是恒内置默认?倾向 config 可配、缺省内置默认。
