# 拆分稿字段契约 v1（JSON）

`gtrk-splitter` 的产物是**机器 JSON 拆分稿**（不是 Markdown）——`gtrk split <拆分稿.json>` 校验落地。
目标：LLM 可稳定产出、校验器可硬拒、下游（matrix / mg / ai-drama）可直接消费。

> 时码零触碰：拆分稿里**不含任何秒级时码字段**。轨道时码由 `gtrk split` 落地时现场投影写入 `struct_meta.split` / `dispatch.json`。

## 顶层结构

```jsonc
{
  "contract_version": "v1",              // 固定 "v1"
  "transcript_hash": "<64 位 hex>",      // 必填：原样透传投影视图的 transcript_hash（hash 链，错版硬拒）
  "beats": [ /* Beat[]，见下 */ ],        // 必填非空
  "queues": { /* 人读派单汇总，可选；机器侧不消费，dispatch.json 由 beats 现场生成 */ }
}
```

- `transcript_hash` 不匹配当前 `transcript.json` 的 `text_hash` → **硬拒**（提示转写已变更、需重新导出视图重拆）。
- `queues` 是给人看的四车道汇总（`a_roll/mg/ai_drama/film_broll` 各 `[{beat, note}]`），**可选**；真正的机器派单 `dispatch.json` 由落地时按 beats 现场生成，不读 `queues`。

## Beat 字段

### 必填

| 字段 | 类型 | 取值 |
|---|---|---|
| `id` | string | `B` + 两位起序号（`B01`…）；同稿内唯一 |
| `span` | object | `{from, to}` 两端均为投影视图中存在的 utterance id；`from ≤ to`（id 序）；beats 间**不重叠**（允许留空隙） |
| `base_track` | enum | 口播底轨三态：`真人出镜` \| `口播继续` \| `旁白主导` |
| `lane` | enum | 主层四选一：`A_ROLL` \| `MG` \| `AI_DRAMA` \| `FILM_BROLL`（遗留 `RRV_MG` 读旧归一为 `MG`） |
| `narrative` | enum | 八枚举：`mirror-hook` \| `demolition` \| `container-translation` \| `abyssal-fall` \| `holding` \| `reversal-elevation` \| `callback-closure` \| `typography-emphasis` |
| `container_stage` | enum | 七枚举：`none` \| `seed` \| `expand` \| `translate` \| `rupture` \| `flip` \| `callback` |
| `rhythm` | string | 人读节奏标签（`快剪` / `平稳` / `渐升` / `停顿` / `悬停` / `回扣` 等）；**机器不消费**、只透传 |
| `visual_task` | string | 一句话：该 beat 让观众「看到什么变化」 |
| `irreplaceability` | enum | `必须真人出镜` \| `优先 MG` \| `可被 B-roll 替代` \| `可降级处理` |

### 可选

| 字段 | 类型 | 说明 |
|---|---|---|
| `handoff` | object | 按 `lane` 分型（见下）。`A_ROLL` 不应带，带了被警告忽略 |
| `aux_layers` | array | 辅助层（见下） |
| `fallback` | string | 预算/素材/AI 稳定性不足时的降级方案 |
| `callback_of` | string | 回扣对象 beat id（如 `B07`）；前文意象后文重调时**不合并 beat**，在后文 beat 写此字段 |
| `note` | string | 其他对制作有帮助的信息 |

## handoff 按 lane 分型（校验器硬查）

```jsonc
// lane === "MG"（遗留 "RRV_MG" 读旧兼容）
"handoff": { "category": "overlay", "slug_hint": "neural-overfit", "theme": "overfitting", "bg": "paper", "duration_hint": 12 }
//   duration_hint（秒）必填；slug_hint / theme / bg / category 可选（bg 底色可由底轨态推导）
//   ⚠️ duration_hint 语义（2026-07-24 主理人硬性规定）：只是「动画主叙事时长」参考，供生产 skill 排布节奏；
//   落轨 clip 恒占满槽位包络（track_ed − track_st），颗粒 tl 总长须 ≥ 包络、终态定格或有限循环驻留、
//   禁全局渐隐退场（gsap-emit v1 铁律⑦）。别把 duration_hint 当颗粒寿命写短。
//   category（颗粒品类子类型，裁决⑩）：overlay（透明叠加,叠在 A-roll/B-roll 上,不挡主体）
//     | fullscreen（不透明满屏,旁白主导整帧）；缺省=下游按颗粒 HTML 根 background 反推透明度。
//     二期扩 subtitle/title。供剪辑器色带按品类分层(叠加/满屏 各一行)。
//     读旧兼容：遗留品牌值 rrv-overlay/mg-fullscreen/explain-subtitle/op-ed-title 仍认。

// lane === "FILM_BROLL"
"handoff": { "queries": ["lonely person in a city apartment at night", "exhausted commuter on a crowded subway train"], "shots": 6, "per_shot_sec": 2, "exclude": ["卡通", "水印"] }
//   queries（非空字符串数组）必填；shots / per_shot_sec / exclude 可选
//   queries 语言规范（经真机中英 A/B 校准）：
//   - 用**英文长句场景描述**（5-12 词，谁+在哪+做什么），不是关键词堆叠——检索后端向量模型英文场景级命中明显更准
//   - 每条 query 只装一个场景意象，多意象拆成多条
//   - **避多义/字面义强的动词**（"pointing" 会召回手指特写、"hunting" 召回猎人——改用 "giving suggestions in a meeting" 这类场景语义）
//   - **exclude 保持中文**：负向过滤匹配的是服务端返回的中文 note，写英文会失效

// lane === "AI_DRAMA"  —— 全可选（下游框架 skill /gtrk-ai-drama 有推断默认）
"handoff": { "narrative": "trauma-repetition", "theme": "freud-fort-da", "emotion_stage": "abyssal", "platform": "video-gen", "shot_count": 5 }

// lane === "A_ROLL"  —— 无 handoff
```

## 辅助层字段（aux_layers[]）

```jsonc
{
  "type": "quote-card",                        // 八类：quote-card | term-callout | network-diagram
                                               //       | archive-caption | pause-card | data-annotation | timeline-tag | overlay
  "mount": { "from": "u0001", "to": "u0002" }, // 挂载范围三型："same_beat" | {from,to} | {trigger:"uNNNN"}
  "role": "金句提炼",                           // 职责：金句提炼/术语解释/关系表达/证据标注/停顿加压/情绪聚焦/回扣提示
  "necessity": "强建议",                        // 可选：必须 | 强建议 | 建议 | 可省略
  "note": "为什么加它",                         // 可选
  "promote_condition": "若连续承担主要理解职责，则升级为下一个 beat 主层",  // 可选
  "fallback": "该辅助层不可做时的替代方式"       // 可选
}
```

- `mount` 里的所有 id（`from`/`to`/`trigger`）MUST 为视图中存在的 utterance id，否则硬拒。
- 辅助层是补充理解职责，不是装饰。满足升级规则时**切出新 beat 升级为主层**，别硬塞辅助层。
- 前七类是**纯建议性**（人读稿一行摘要，不承接派单）；第八类 `overlay` 是**承接颗粒派单**的叠层类型（见下）。

### `overlay` 叠层颗粒 aux（第八类，承接派单）

`overlay` = 与底轨主视觉（如 `FILM_BROLL` 电影感 B-roll）**同段共存的透明概念颗粒**——想「底轨放实拍情绪镜头、其上叠一层 MG 透明图解/金句」时用它。与前七类不同，`overlay` aux 必带 `handoff`，由 `gtrk split` 落地投影成派生颗粒（进 `dispatch.mg` + 合成 `struct_meta.split.beats`），后续 `gtrk mg` 铺出透明颗粒盖在底轨上。

```jsonc
{
  "type": "overlay",
  "mount": "same_beat",                        // same_beat（复用当前 beat 落轨区间）| {from,to}（子区间）；{trigger} 一期不支持
  "role": "概念叠层图解",
  "handoff": {                                 // overlay 必带（镜像 MG lane 的 handoff）
    "duration_hint": 6,                        //   必填正数秒（该 aux 要生成颗粒，无时长不成立；缺/非正数硬拒）
    "category": "overlay",                     //   可选品类（软校验，非法只告警不拒；派生颗粒实际 category 恒 "overlay"）
    "slug_hint": "overfit-mirror",             //   可选：颗粒 slug 提示
    "theme": "overfitting",                    //   可选：主题
    "bg": "transparent"                        //   可选：底色（叠层通常透明）
  }
}
```

- **mount 投影**：`same_beat` → 复用当前 beat 的 `track_st/track_ed`；`{from,to}` → 取该子区间存活实例的包络（全被剪则计入 `skipped` 不落）。**`{trigger}` 点挂载一期不支持**（无干净源区间，`duration_hint` 是时间线秒非源秒 → 跟随会不准）：遇到计入 `skipped` + 告警，二期再补。
- **composition_id 命名**：派生颗粒 = `<工程slug>-<beatId>-aux<n>`（`n` 从 1，位置计数）；同 beat 主颗粒仍是 `<工程slug>-<beatId>`。「一 beat 一 composition_id」松绑为「`composition_id` 全局唯一，一 beat 可派生主 + N 个 `-aux<n>` 颗粒」。
- **一期约束**：`FILM_BROLL` 主（底轨不产 MG 颗粒）+ 一颗 `overlay` aux 同段安全；`MG` 主 beat 再挂 `overlay` aux 会同段两颗撞一轨（后续拆轨），先避开。

## 落地产物（CLI 写，供参照）

- **`.gtrk` 的 `struct_meta.split`**：`{contract_version, transcript_hash, projected_at, material_id, beats:[{id, lane, span, track_st, track_ed, source_ranges, narrative, container_stage, visual_task, shrunk?, handoff}]}`——投影时刻快照。**消费方要新鲜时码就重新投影**（`gtrk split --project`）。
  - `material_id`：口播素材 id（= transcript.material_id），消费方脱离 transcript 文件即可定位素材。
  - `beats[].source_ranges`：`[{st, ed}]` 源时基秒（v1 恒单元素 = span 源包络，含句间静默与被剪词）——**源时基不随时间线编辑漂移**，消费方以「源区间 ∩ 当刻颗粒源窗口」投影可得实时覆盖（客户端色带跟随模式即此）。
- **`split/dispatch.json`**：`{mg:[{beat, composition_id, duration, category?, theme, bg, slug_hint, track_st, track_ed}], film_broll:[{beat, queries, shots, per_shot_sec, exclude, track_st, track_ed}], ai_drama:[{beat, ...handoff, track_st, track_ed}]}`（去品牌化前 `mg` 键为 `rrv_mg`，消费方 `mg ?? rrv_mg` 双读）。`composition_id` = `<工程slug>-<beatId>`（MG 颗粒 `data-composition-id` 直接用它，打通 beat↔颗粒命名）；`overlay` aux 派生颗粒 = `<工程slug>-<beatId>-aux<n>`（`n` 从 1）——`composition_id` 全局唯一，一 beat 可派生主 + N 个 `-aux<n>` 颗粒。
- **`split/visual-split.md`**（`--md`）：由机器 JSON 单向渲染的人读稿，不回读。

## 落地时的 dropped 处理（你要知道）

- beat 的 span 内 utterance **全部** dropped（在当前时间线被剪光）→ 该 beat 被**跳过**（不写标注、不进派单），进 result 报告。
- **部分** dropped → beat 轨道区间按存活 utterances 的包络**收缩**、标 `shrunk:true`，进报告提示人工复核。
- 所以：别把 `dropped:true` 的句子划进 span；想让某段进画面，先让用户在客户端恢复它（拉长 clip）再重导视图。
