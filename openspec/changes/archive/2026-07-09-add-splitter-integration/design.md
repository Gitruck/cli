# add-splitter-integration · Design

## Context

上游：infra `add-oral-cut-transcript-output` 使 oralcut 家族恒出 `transcript.json`（源时基、utterance/word 全量、id 稳定，契约 `oral-cut-transcript`）。客户端（opencut v0.1.7）：`.gtrk` v1-only、双击直开、`struct_meta` 顶层键整块原样回写（round-trip 安全区）、clip 级未知字段保存即丢。主理人核心需求：铺轨按**发起那一刻**的字级时间戳落位、用户随时手调时间线、所见即所得（explore-splitter-cli-integration D3/D8，落 `gitruck-infra/.plans/`）。

## Goals / Non-Goals

**Goals:**
- 投影器：源时基 → 当刻轨道时基，纯函数、可离线单测、对「已剪好成片」恒等成立。
- 拆分稿契约：LLM 可稳定产出、校验器可硬拒、下游（matrix/rrv/ai-drama）可直接消费。
- skill 收编：单一真相源、随 CLI 分发、与 oralcut skill 同一套编排语法。

**Non-Goals:** 铺轨/检索/客户端编辑器/transcribe/TTS producer/纯文稿模式（见 proposal 非目标）。

## Decisions

**D1 投影算法：区间交集映射，word 级精度，utterance 级出口**
对每条 video_track main 轨 clip（`material` 命中 `transcript.material_id`）：word 的 `[st,ed]` 与 `[clip_st,clip_ed]` 相交 → 映射 `track_t = track_st + (t - clip_st)`。utterance 的投影 = 其 words 投影的包络；无任何 word 存活 = dropped。输出视图按 utterance 聚合（`{id, text, kept_words/total_words, track_st, track_ed, dropped}`），字级明细不进视图缺省输出（`--words` 可开）——**skill 上下文只吃句级**，字级留给未来铺轨微调。多 clip 引用同一源区间（用户复制片段）时同一 utterance 产多个投影实例，视图按 `track_st` 排序全部列出。仅扫 `track_index` 最小的 main 底轨——口播底轨是唯一语义载体，overlay 轨（B-roll/画中画）不参与投影。

**D2 视图也是文件契约：`split/view.json`**
投影视图落盘（`<project>/split/view.json`）+ stdout `--json`。skill 读文件而非解析终端输出（大稿健壮）；view 携带 `transcript_hash` 透传，拆分稿从 view 继承该 hash——**hash 链：transcript → view → 拆分稿 → split 落地校验**，任何一环错版硬拒（Q5 定案）。

**D3 拆分稿 schema 要点**
- `span.from/to` 为 utterance id，校验：两端存在、`from ≤ to`（按 id 序）、beat 间不重叠、允许留空隙（未拆段默认 A_ROLL 底轨直出）。
- `lane` 四选一 + `handoff` 按 lane 分型强校验（RRV_MG 必有 `duration_hint`；FILM_BROLL 必有 `queries` 非空数组；AI_DRAMA 字段全可选〔ai-drama-prompter 有推断默认〕）。
- 节奏标签/叙事功能/容器阶段沿旧 skill 枚举（人读价值保留），机器侧只透传不消费。
- 辅助层沿旧七类，挂载范围同样改 id 引用（`same_beat` | `{from,to}` | `trigger:"uNNNN"`）。

**D4 落地产物三件**
1. `.gtrk` 的 `struct_meta.split`：`{contract_version, transcript_hash, projected_at, beats:[{id, lane, span, track_st, track_ed, shrunk?, handoff}]}`——投影时刻的快照，供客户端展示/后续命令兜底；track 时码仅供参考，**消费方要新鲜时码就重新投影**（契约明文）。
2. `split/dispatch.json` 派单清单：`{rrv_mg:[{beat, composition_id, duration, theme, bg, slug_hint}], film_broll:[{beat, queries, shots, per_shot_sec, exclude, track_st, track_ed}], ai_drama:[{beat, handoff…}]}`；`composition_id` 命名约定 `<工程名>-<beat_id>`（rrv 颗粒 data-composition-id 直接用它，打通 beat↔颗粒命名）。
3. `split/visual-split.md`（`--md`）：由机器 JSON 渲染人读稿（沿旧版式：全片总览/Beat Timeline/四队列），**单向生成、不回读**。

**D5 写回 `.gtrk`：读-改-写仅 `struct_meta.split`，原子替换**
读原文件 → JSON parse → 只替换 `struct_meta.split` → 序列化写临时文件 → rename 覆盖。不重排任何既有键序之外的内容（JSON.stringify 全量重写可接受——客户端保存本就重建全文）。前置校验：目标 `.gtrk` `version==="v1"`，否则硬拒。**不做文件锁**：闭环时序由「用户先保存、发起后客户端等重载」保证（D8/opencut 联动），CLI 侧仅在写前比对文件 mtime 与读取时一致，变了则拒写重试。

**D6 skill 设计（gtrk-splitter）**
SKILL.md 流程：确认工程目录 → `gtrk split --project <dir> --json`（拿 view）→ 按 view 句级创作拆分（枚举/触发器/升级规则沿旧 SKILL 精华）→ 写拆分稿 json → `gtrk split <拆分稿> --project <dir> --json` → 若校验错误按 error 逐条修正重试（上限 3 轮）→ 回报 dispatch 摘要。铁律写进 SKILL：**只引用 view 里存在的 utterance id、不得抄写原句文字作定位、不得自造时码**。references：`field-schema.md`（新 json 契约版）+ `example-visual-split.json`（20-beat 金样迁移）+ 旧 md 金样留作人读稿风格参照。

**D7 命令面：单命令双模式（positional 有无区分）**
`gtrk split --project <dir>` = 投影视图；`gtrk split <拆分稿> --project <dir>` = 校验落地。commander `.argument('[splitdoc]')` 可选位置参数，无嵌套子命令（沿 oralcut-result 的 D2 教训：避免父子命令吞选项）。`--project` 指 oralcut 产物目录（自动定位 `gtrk/project.gtrk` 与 `transcript/transcript.json`）或任意目录（显式 `--gtrk` / `--transcript` 兜底）。

## Risks / Trade-offs

- [LLM 产拆分稿字段漂移] → 校验器硬拒 + 错误信息逐条可操作（skill 修正循环消化）；金样作回归。
- [`struct_meta.split` 时码快照被误当新鲜值] → 契约明文「参考快照，消费前重投影」；dispatch.json 同理携带 `projected_at`。
- [用户在 split 运行间隙改了 `.gtrk`] → 写前 mtime 比对拒写；配合客户端保存/重载门（opencut `add-gtrk-reload`）。
- [transcript 缺失（旧任务/直拖成片）] → 明确报错引导：重跑 oralcut 或（后续）`transcribe`；不做降级猜测。
- [同源多实例投影（复制片段）] → 视图全部列出由 skill 自行取舍；拆分稿 span 引用 id 不引用实例，落地时全部实例都打标注。

## Migration Plan

纯新增命令 + skill，无既有行为变更。发版顺序：infra transcript 先上生产 → 本 change 发 CLI 版本 → `gtrk skills install` 更新 skill。回滚 = 退版本，`struct_meta.split` 残留无害（客户端原样回写、无消费方时是惰性数据）。

## Open Questions

- 无阻塞项。（`composition_id` 前缀取工程目录名的 slug 化规则、view 的 `--words` 明细格式，apply 时定即可。）
