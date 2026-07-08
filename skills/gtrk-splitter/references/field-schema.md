# 拆分稿字段契约 v1（JSON）

`gtrk-splitter` 的产物是**机器 JSON 拆分稿**（不是 Markdown）——`gtrk split <拆分稿.json>` 校验落地。
目标：LLM 可稳定产出、校验器可硬拒、下游（matrix / rrv / ai-drama）可直接消费。

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
- `queues` 是给人看的四车道汇总（`a_roll/rrv_mg/ai_drama/film_broll` 各 `[{beat, note}]`），**可选**；真正的机器派单 `dispatch.json` 由落地时按 beats 现场生成，不读 `queues`。

## Beat 字段

### 必填

| 字段 | 类型 | 取值 |
|---|---|---|
| `id` | string | `B` + 两位起序号（`B01`…）；同稿内唯一 |
| `span` | object | `{from, to}` 两端均为投影视图中存在的 utterance id；`from ≤ to`（id 序）；beats 间**不重叠**（允许留空隙） |
| `base_track` | enum | 口播底轨三态：`真人出镜` \| `口播继续` \| `旁白主导` |
| `lane` | enum | 主层四选一：`A_ROLL` \| `RRV_MG` \| `AI_DRAMA` \| `FILM_BROLL` |
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
// lane === "RRV_MG"
"handoff": { "slug_hint": "neural-overfit", "theme": "overfitting", "bg": "paper", "duration_hint": 12 }
//   duration_hint（秒）必填；slug_hint / theme / bg 可选（bg 底色可由底轨态推导）

// lane === "FILM_BROLL"
"handoff": { "queries": ["都市独处 夜晚", "地铁 疲惫"], "shots": 6, "per_shot_sec": 2, "exclude": ["卡通", "水印"] }
//   queries（非空字符串数组）必填；shots / per_shot_sec / exclude 可选

// lane === "AI_DRAMA"  —— 全可选（下游 ai-drama-prompter 有推断默认）
"handoff": { "narrative": "trauma-repetition", "theme": "freud-fort-da", "emotion_stage": "abyssal", "platform": "kling", "shot_count": 5 }

// lane === "A_ROLL"  —— 无 handoff
```

## 辅助层字段（aux_layers[]）

```jsonc
{
  "type": "quote-card",                        // 七类：quote-card | term-callout | network-diagram
                                               //       | archive-caption | pause-card | data-annotation | timeline-tag
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

## 落地产物（CLI 写，供参照）

- **`.gtrk` 的 `struct_meta.split`**：`{contract_version, transcript_hash, projected_at, beats:[{id, lane, span, track_st, track_ed, shrunk?, handoff}]}`——投影时刻快照。**消费方要新鲜时码就重新投影**（`gtrk split --project`）。
- **`split/dispatch.json`**：`{rrv_mg:[{beat, composition_id, duration, theme, bg, slug_hint, track_st, track_ed}], film_broll:[{beat, queries, shots, per_shot_sec, exclude, track_st, track_ed}], ai_drama:[{beat, ...handoff, track_st, track_ed}]}`。`composition_id` = `<工程slug>-<beatId>`（rrv 颗粒 `data-composition-id` 直接用它，打通 beat↔颗粒命名）。
- **`split/visual-split.md`**（`--md`）：由机器 JSON 单向渲染的人读稿，不回读。

## 落地时的 dropped 处理（你要知道）

- beat 的 span 内 utterance **全部** dropped（在当前时间线被剪光）→ 该 beat 被**跳过**（不写标注、不进派单），进 result 报告。
- **部分** dropped → beat 轨道区间按存活 utterances 的包络**收缩**、标 `shrunk:true`，进报告提示人工复核。
- 所以：别把 `dropped:true` 的句子划进 span；想让某段进画面，先让用户在客户端恢复它（拉长 clip）再重导视图。
