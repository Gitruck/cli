## ADDED Requirements

### Requirement: 本地预处理后只传小文件

`oralcut` MUST 在上传前本地预处理毛片、且**永不上传原片**：`visual_assist=false`（默认）MUST 用 ffmpeg 抽单声道 16kHz mp3（`-vn -ac 1 -ar 16000 -c:a libmp3lame`）上传；`visual_assist=true` MUST 本地压 720p 视频代理（`scale=-2:720`）上传。上传标的为抽出物而非原片；`source_path` 仍指向原片本地绝对路径。

#### Scenario: 默认抽音频上传
- **WHEN** `gtrk oralcut <毛片>`（未开 visual_assist）
- **THEN** 本地抽出 16k 单声道音频（几十 MB）并上传，原片不出本地

#### Scenario: 视觉兜底压 720p 上传
- **WHEN** `gtrk oralcut <毛片> --visual-assist`
- **THEN** 本地压出 720p 代理视频并上传，供云端在 720p 上做说话检测，原片不出本地

### Requirement: 回传原片真实几何

因抽出物几何 ≠ 原片、后端在纯音频/720p 下拿不到原片真值，`oralcut` MUST 先用 `ffprobe` 探原片 `{width, height, fps, duration}`，并在提交请求时携带 `video_size`、`video_rate`、`video_duration`、`fingerprint` 与 `source_path`（原片本地绝对路径）。

#### Scenario: 请求携带几何元数据
- **WHEN** 提交 `cli/video_oral_cut_for_cli` 任务
- **THEN** payload 含 `video_size`/`video_rate`/`video_duration`/`fingerprint`/`source_path`，供后端还原工程画布/帧率并做计费交叉校验

### Requirement: 路由到 cli 域任务类型

`oralcut` MUST 以 taskType `cli/video_oral_cut_for_cli` 提交与轮询，命中后端 `/task/cli/video_oral_cut_for_cli`。既有 `cloud.ts` 的 `POST/GET /task/${taskType}` 封装 MUST NOT 因此改动。

#### Scenario: 提交与轮询走 cli 域路径
- **WHEN** 提交任务并轮询状态
- **THEN** 请求分别打到 `POST /task/cli/video_oral_cut_for_cli` 与 `GET /task/cli/video_oral_cut_for_cli/<task_id>`

### Requirement: 抽出物时长与原片一致性自检

上传前 CLI MUST 校验抽出物（音频/720p）时长与原片 `ffprobe` 时长一致（容差 < 1s）；不一致 MUST 中止并报错，不得上传残缺抽出物（防少计费与探测异常）。

#### Scenario: 时长偏差超容差中止
- **WHEN** 抽出物时长与原片偏差 ≥ 1s
- **THEN** CLI 报错中止、不上传，提示重试或检查毛片

### Requirement: 产物落位与机读契约不变

拉回的 gtrk/剪映/PR 工程文件按基础格式分目录落位、剪映草稿拷贝、`--json` 机读 stdout 单行结果契约 MUST 与现状逐字段一致。

#### Scenario: --json 契约不变
- **WHEN** `gtrk oralcut <毛片> --json`
- **THEN** stdout 仅输出既有结构的一行结果 JSON，人读日志走 stderr
