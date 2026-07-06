## ADDED Requirements

### Requirement: 从 gtrk EDL 本地渲染成片

CLI MUST 能解析 gtrk 工程（EDL）并用本地 ffmpeg 渲染成片，滤镜语义 MUST 与后端 `build_filter_graph` 一致：视频链 `trim=st:ed → setpts=PTS-STARTPTS → fps → scale=force_original_aspect_ratio=decrease → pad 居中黑边 → setsar=1 → format=yuv420p → concat`；音频链 `atrim → asetpts → aresample=48000 → aformat=fltp:stereo`，段首尾 `afade`（段间硬切，无 acrossfade），多轨 `amix normalize=0`。渲染入口为独立 `render <gtrk>` 命令，`oralcut --local-render` 内联复用同一实现。

#### Scenario: 单源单轨口播工程渲染出片
- **WHEN** `gtrk render <project.gtrk>`（或 `oralcut --local-render`）
- **THEN** 按 EDL 逐段 trim + concat 生成成片 mp4，段边界与 gtrk 时码一致

### Requirement: 渲染编码参数

渲染 MUST 默认 `libx264 -preset medium -crf 18 -c:a aac -b:a 192k -movflags +faststart`；`--crf`（14–28）与 `--codec`（当前仅 h264）MUST 可覆盖，语义与云端渲染参数一致。

#### Scenario: 覆盖 CRF
- **WHEN** `gtrk render <gtrk> --crf 20`
- **THEN** 以 crf=20 编码，其余参数不变

### Requirement: material 用本地原片

渲染的 `material` 输入 MUST 取 gtrk `materials[].path`（即 `source_path`，原片本地绝对路径）；路径不存在 MUST 报错并指明缺失素材，不得静默出错片。

#### Scenario: 原片缺失报错
- **WHEN** gtrk 引用的原片路径在本地不存在
- **THEN** CLI 报错指明缺失的素材路径，中止渲染

### Requirement: 观感等价与黄金用例对拍

本地渲染验收口径为**观感等价**（时长/切点/画布/音画同步/编码参数一致），不承诺与云端 `outputs=[video]` 逐字节一致。CLI 生成的 `filter_complex` MUST 与后端导出的黄金用例向量（同 gtrk + 同几何 → 期望 filter_complex 文本）对拍一致，以防跨仓语义漂移。

#### Scenario: filter_complex 对拍一致
- **WHEN** 用后端黄金向量的 gtrk + 几何驱动本地渲染的 filtergraph 生成
- **THEN** 生成的 `filter_complex` 文本与后端期望向量一致

### Requirement: 渲染进度与失败反馈

渲染过程 MUST 有进度反馈；ffmpeg 非零退出 MUST 报错并带回 ffmpeg stderr 摘要，`--json` 模式下进度走 stderr、stdout 契约不变。

#### Scenario: ffmpeg 失败带回错误
- **WHEN** ffmpeg 渲染进程非零退出
- **THEN** CLI 报错并附 ffmpeg stderr 摘要，退出码非零
