## Why

口播剪辑今天要求上传整条毛片（几 GB），云端做 ASR + 分析 + 渲染再下载。但剪辑「决策」只依赖音频（ASR 字级时间戳 + RMS 包络），gtrk 工程本就是纯 EDL、云端渲染就是标准 ffmpeg 滤镜——毛片像素对**决策**毫无必要。让 CLI 作为客户端在本地预处理（抽音频 / 压 720p）、只把几十 MB 上云拿回 gtrk EDL、再本地 ffmpeg 渲染成片：**毛片永不出本地、上传从几 GB 降到几十 MB、且比现状更快**。这是通用 `video_oral_cut`（强制传原片）覆盖不了的诉求，故立 CLI 特例 `video_oral_cut_for_cli`——CLI 默认仍走通用 API，只有通用覆盖不了才转 cli 特例。

## What Changes

- **`oralcut` 不再上传原片，改为本地预处理后只传小文件**：`visual_assist=false`（默认）→ 本地 `ffmpeg -vn -ac 1 -ar 16000` 抽音频；`visual_assist=true` → 本地压 720p 视频（视觉说话检测在 720p 上做足够）。两种输入都 **MUST 回传原片真实几何** `video_size` / `video_rate` / `video_duration` / `fingerprint` + `source_path`（原片本地绝对路径，写进 gtrk materials 供本地打开/渲染认素材）。
- **taskType 改 `cli/video_oral_cut_for_cli`**：对应后端 `/task/cli/video_oral_cut_for_cli`；`cloud.ts` 的 `POST/GET /task/${taskType}` 模板天然成立，**上传/提交/轮询封装零改动**。
- **新增本地 ffmpeg 渲染成片**（新命令 `render` 或 `oralcut --local-render`）：解析云端返回的 gtrk EDL，移植后端 `build_filter_graph` 语义拼 `filter_complex`，`material` 用本地原片，产出成片。验收口径为**观感等价**（时长/切点/画布/音画同步/编码参数一致），不承诺逐字节一致。
- **ffmpeg 供给委托 agent、不由 CLI 分发**：`ffmpeg.exe` + `ffprobe.exe` 落 `~/.gitruck/ffmpeg/`（缺失时 `SKILL.md` 指示 agent 安装）。CLI 一律**绝对路径**调用，**绝不改用户系统环境变量/PATH**；解析顺序：优先 `~/.gitruck/ffmpeg`，缺失回退系统 `PATH`。彻底规避 GPL 传染（我方不分发二进制）。
- **配置目录归一 `~/.gitruck`**：`config` / caches / `ffmpeg` / `audio-cache` 全归一；启动检测到旧 `~/.gtrk-cli` 即迁移；未来只保留 `.gitruck`。
- **`doctor` 加「本地渲染工具(ffmpeg)」检查**：判 **warn 不判 fail**（别误伤只出工程文件、不本地渲染的用户）；`ffprobe -encoders` 能力探测（libx264/aac 等）与最低版本门槛。
- **上传缓存指纹改造**：键从原片 `size:mtime` 切到抽出的音频/720p 产物；另存「原片指纹 → file_id」映射避免每次重抽；本地缓存抽出物（抽音频/压制本身耗时）。
- 结果 JSON、三方工程文件（gtrk/剪映/PR）落位与 `--json` 机读契约对上层**保持不变**。

## Capabilities

### New Capabilities

- `video-oral-cut-for-cli`：CLI 口播剪辑闭环行为契约——本地探几何 + 预处理（音频/720p）+ 回传几何 + 提交 `cli/video_oral_cut_for_cli` + 拉回 gtrk/剪映/PR 工程文件。
- `local-ffmpeg-render`：本地按 gtrk EDL 用 ffmpeg 渲染成片的保真契约（滤镜语义、编码参数、观感等价验收）。
- `ffmpeg-runtime`：ffmpeg/ffprobe 的定位、agent 委托供给、绝对路径调用与用户环境零侵入、doctor 能力探测。
- `gitruck-home`：`~/.gitruck` 统一用户目录与从 `~/.gtrk-cli` 的一次性迁移。

### Modified Capabilities

（无——`openspec/specs/` 尚无归档 baseline；pending change `add-chunked-upload-client` 的 `~/.gtrk-cli/upload-sessions.json` 路径引用由本 change 的 `gitruck-home` 迁移一并收编，见 Impact。）

## Impact

- **代码**：`src/commands/oralcut.ts`（前置本地探几何 + 抽音频/压 720p、回传几何、taskType 改 `cli/...`）；新增 `src/lib/ffmpeg.ts`（二进制定位 + 探测 + 调用封装）、`src/lib/media.ts`（探几何/抽音频/压 720p）、`src/lib/render.ts`（gtrk EDL → filter_complex → 成片）；`src/commands/render.ts`（新命令，`index.ts` 已注释预留 `registerRender`）；`src/lib/paths.ts` / `user-config.ts` / `upload-cache.ts` 目录基址切 `~/.gitruck` + 迁移；`src/commands/doctor.ts` 加 ffmpeg 检查。
- **依赖**：**无新增运行时 npm 依赖**——ffmpeg 是外部二进制、不进包（保持 bun 单文件轻量分发）。
- **服务端契约**：消费 gitruck-infra 配套 change `add-cli-domain-video-oral-cut`（另起）定义的 `/task/cli/video_oral_cut_for_cli` 接口、几何元数据与交叉校验契约；两 change 的 proposal 互链，本 change 联调依赖后端先部署。
- **分发 / 合规**：ffmpeg 不随 npm 包分发 → 我方不是 GPL 分发主体、零传染义务。
- **文档**：`AGENT.md` / `skills/gtrk-oralcut/SKILL.md` 补「本地预处理 + 只传音频 + 本地渲染 + ffmpeg 委托安装」；**接口文档只落 Swagger `/cli/apidocs` + 飞书，绝不进同合云前端**（cli 特例不对终端用户展示）。
- **与 pending change `add-chunked-upload-client` 的关系**：其 `upload-sessions.json` 随 `gitruck-home` 从 `~/.gtrk-cli` 迁到 `~/.gitruck`，两 change 归档口径对齐（谁后归档谁按 `.gitruck`）。
- **测试**：`test/` 下 `node:test` 离线用例——几何探测/抽音频时长一致性校验、gtrk EDL → filter_complex 生成的黄金用例对拍（与后端 `build_filter_graph` 输出对齐）、目录迁移幂等、ffmpeg 缺失/回退解析。真机 E2E 待后端部署后与真实毛片同跑。

### 非目标（刻意不做）

- 不动通用 `video_oral_cut`（直传原片路径保留给非 CLI / API 直调用户）。
- 不做 CLI 自动下载 ffmpeg 的跨平台二进制矩阵管理（下载/放置委托 agent；CLI 只负责定位、探测、绝对路径调用）。
- 不追求本地成片与云端 `outputs=[video]` 逐字节一致（libx264 跨版本/平台不保证；验收=观感等价）。
- 不把 `doctor` 的 ffmpeg 检查做成 fail 门禁（warn，只出工程文件的用户不受阻）。
- 不改 `--json` 机读契约与三方工程文件落位逻辑。
