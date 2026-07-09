# timeline-projection · Spec Delta

## ADDED Requirements

### Requirement: 源时基到轨道时基的投影

投影 SHALL 以 word 为最小单元：对 main 底轨（`track_index` 最小的 video_track）中 `material` 命中 `transcript.material_id` 的每个 clip，word 区间 `[st,ed]` 与 `[clip_st,clip_ed]` 相交则映射 `track_t = track_st + (t - clip_st)`。utterance 投影 = 存活 words 的包络；无存活 word 即 `dropped`。overlay 轨与非命中 material 的 clip MUST NOT 参与投影。投影 MUST 为纯函数（transcript × gtrk → 视图），同输入恒同输出。

#### Scenario: 用户手调切点后投影跟随
- **WHEN** 用户把某 clip 的 `clip_st` 前移 2s 并保存，重新导出视图
- **THEN** 该 clip 覆盖的 words 轨道时码整体前移，此前被剪掉、现落入 `[clip_st,clip_ed]` 的 words 恢复存活——无需重跑转写

#### Scenario: 已剪好成片恒等投影
- **WHEN** `.gtrk` 为单 clip 全长引用源素材（`clip_st=0, clip_ed=duration, track_st=0`）
- **THEN** 视图轨道时码与源时基逐字相等

#### Scenario: 复制片段产生多实例
- **WHEN** 同一源区间被两个 clip 引用
- **THEN** 覆盖的 utterance 在视图中出现两个投影实例，按 `track_st` 排序全部列出

### Requirement: 投影视图契约

视图 SHALL 落盘 `<project>/split/view.json` 并支持 stdout `--json`：`{transcript_hash, projected_at, utterances:[{id, text, track_st, track_ed, dropped, kept_words, total_words}]}`，按 `track_st` 排序（dropped 条目按源序插位并标记）。缺省不含字级明细（`--words` 开启）。`transcript_hash` MUST 从 transcript.json 原样透传。

#### Scenario: 视图供 skill 消费
- **WHEN** `gtrk split --project <dir>` 执行成功
- **THEN** `split/view.json` 生成，句级条目含轨道时码与 dropped 标注，字级明细缺省不出现

### Requirement: beat 的 dropped 处理（收缩 + 报告）

落地投影时：beat 的 span 内 utterance **全部** dropped → 跳过该 beat（不写标注、不进派单），记入 result 报告；**部分** dropped → 按存活 utterances 的包络**收缩** beat 的轨道区间，标 `shrunk:true` 并记入报告。两种情况 MUST NOT 使命令失败。

#### Scenario: 整 beat 被剪跳过
- **WHEN** 某 beat 的 span 内全部 utterance 无存活 word
- **THEN** 该 beat 不落 `struct_meta.split`、不进 dispatch，report 列出 beat id 与原因

#### Scenario: 部分被剪收缩
- **WHEN** beat span 内 4 句中 1 句被剪
- **THEN** beat 轨道区间按剩余 3 句包络收缩、`shrunk:true`，report 提示人工复核
