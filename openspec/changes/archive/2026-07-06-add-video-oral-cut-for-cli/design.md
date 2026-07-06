## Context

现状：`gtrk oralcut <毛片>` 上传整条视频（`uploadCached(cfg, inputAbs)`，`src/commands/oralcut.ts:165`），云端 `video_oral_cut` 出 gtrk/剪映/PR 工程文件 + 可选云端渲染，CLI 本地零媒体处理。`cloud.ts` 是薄客户端：`submitTask` = `POST /task/${taskType}`（`:86`）、`pollTask` = `GET /task/${taskType}/${taskId}`（`:129`）。配置/缓存在 `~/.gtrk-cli/`（`user-config.ts:13`、`upload-cache.ts`）。全仓零 ffmpeg 依赖、bun 单文件分发、唯一运行时依赖 `hash-wasm`。

约束：口播剪辑「决策」只需音频（后端 ASR 字级 + RMS 包络，不碰像素）；gtrk 是自洽 EDL（逐段四时码，气口/pad 已烘焙进 segment 边界）；云端渲染即 `build_filter_graph` 纯 ffmpeg 滤镜。配套后端 change `add-cli-domain-video-oral-cut`（gitruck-infra）新增 `/task/cli/video_oral_cut_for_cli`、收音频/720p 双输入、按音频流探时长计费（同通用 video_oral_cut）、几何元数据契约与交叉校验。

## Goals / Non-Goals

**Goals:** 毛片永不上传；上传体量从几 GB 降到几十 MB；本地 ffmpeg 按 EDL 渲染出观感等价成片；ffmpeg 不由我方分发（规避 GPL）且不侵入用户环境；用户目录归一 `~/.gitruck`；对上层结果 JSON 与三方工程文件契约零感知。

**Non-Goals:** 不动通用 `video_oral_cut`；不做 CLI 自动下载 ffmpeg 的跨平台二进制矩阵（委托 agent）；不承诺本地/云端成片逐字节一致；不把 doctor 的 ffmpeg 检查做成 fail 门禁；不引入 render 参数面之外的编码能力。

## Decisions

**D1 上传标的按 `visual_assist` 分流，永不传原片。** `false`（默认）→ 本地 `ffmpeg -i 毛片 -vn -ac 1 -ar 16000 -c:a libmp3lame -b:a 64k` 抽 16k 单声道 **mp3**（豆包 AUC 大模型 2.0 最终就以 mp3 提交、`ASR.core()` 对 mp3 直通不再转码，mp3 上传体积远小于 wav；采样率/声道对 mp3 自描述容器由服务端自动识别，RMS 从解码后音频求值不受影响）；`true` → `ffmpeg -i 毛片 -vf scale=-2:720 -c:v libx264 -preset veryfast -crf 28 -c:a aac` 压 720p 代理（视觉说话检测在 720p 上 `track_sample_fps=5` 足够）。**替代方案**：始终传 720p（省一条音频分支）——否决，纯音频链路上传更小、且 `visual_assist=false` 是默认高频路径。

**D2 客户端 MUST 回传原片真实几何。** 抽出的音频/720p 几何 ≠ 原片，后端 `_probe_source` 拿不到真值会落兜底 1920×1080/30fps 致工程画布/帧率失真。故 `oralcut` 先 `ffprobe` 探原片 `{width,height,fps,duration}`，随请求下发 `video_size`/`video_rate`/`video_duration`/`fingerprint`；`source_path` 仍为原片本地绝对路径（写进 gtrk materials，本地打开/渲染认素材）。

**D3 本地渲染移植后端 `build_filter_graph` 语义，验收观感等价。** `src/lib/render.ts` 解析 gtrk EDL → 拼 `filter_complex`：视频链 `trim=st:ed,setpts=PTS-STARTPTS,fps,scale=force_original_aspect_ratio=decrease,pad 居中黑边,setsar=1,format=yuv420p` + `concat`；音频链 `atrim,asetpts,aresample=48000,aformat=fltp:stereo`，段首尾 `afade`（**注意云端无 acrossfade、段间硬切**，`audio_crossfade_ms` 实为 afade 时长），多轨 `amix normalize=0`；编码 `libx264 -preset medium -crf 18 -c:a aac -b:a 192k -movflags +faststart`。`material` 输入用本地原片。**替代方案**：让后端把渲染参数随 gtrk 下发而非 CLI 硬移植——部分采纳（关键参数从 gtrk/响应读，滤镜结构在 CLI），但结构语义必须与后端对拍，故用**黄金用例对拍**（同 gtrk+几何 → 同 filter_complex 文本）防跨仓漂移。验收口径明确为观感等价（时长/切点/画布/音画同步/编码参数一致），不承诺 libx264 逐字节一致。

**D4 ffmpeg 委托 agent、`~/.gitruck/ffmpeg/`、绝对路径、环境零侵入。** CLI **不下载不分发** ffmpeg（我方非分发主体 → 零 GPL 义务）；缺失时由 `SKILL.md` 指示 agent 下载 `ffmpeg.exe`+`ffprobe.exe` 到 `~/.gitruck/ffmpeg/`。`src/lib/ffmpeg.ts` 解析顺序：`~/.gitruck/ffmpeg/{ffmpeg,ffprobe}[.exe]`（优先）→ 系统 `PATH`（回退）→ `--ffmpeg-path` 显式覆盖。**一律用绝对路径 spawn**，不设、不改用户系统环境变量/`PATH`；若某调用确需 env 也只作用于该 spawn 子进程、进程结束即失效，绝不落用户机持久环境（尊重用户自装的 ffmpeg 与其 PATH）。**agent 拉取策略**：先查 `~/.gitruck/ffmpeg` 与系统，确实缺失才拉；面向国内用户优先国内加速站点——GitHub 代理（ghproxy 类 pass-through，不构成同合云分发）拉 BtbN/gyan.dev 官方静态构建，或同合云自建镜像（若愿随附 GPL 对应源码），配 sha256 校验，避免直连 github 慢/断。**替代方案**：CLI 首运自动下载 + 跨平台矩阵（评估阶段设计）——否决，quarantine/GPL 分发/多平台全是负担，且与「agent 驱动」定位不符。

**D5 taskType = `cli/video_oral_cut_for_cli`，`cloud.ts` 零改动。** `submitTask`/`pollTask` 本就是 `/task/${taskType}`，taskType 传含斜杠的 `cli/video_oral_cut_for_cli` 即拼出 `/task/cli/video_oral_cut_for_cli`，无需给 cloud.ts 加域参数。存库 `task_type` 仍是干净的 `video_oral_cut_for_cli`（后端 create 端点内部指定，与 URL 解耦）。

**D6 上传缓存指纹切到抽出物 + 原片映射。** 现按原片 `size:mtime` 缓存 file_id（`upload-cache.ts:33`）。改为：对抽出的音频/720p 计缓存键（它们才是真正上传物）；另存「原片指纹 → 抽出物 file_id」映射与本地抽出物缓存，使同一毛片重剪免重抽、免重传。`--reupload` 顺延跳过抽出物缓存与映射。

**D7 `doctor` ffmpeg 检查判 warn、带能力探测。** 新增一行 Row：定位到 ffmpeg 则 `ok`（显版本 + 来源 `~/.gitruck` 还是系统），`ffprobe -encoders`/`-filters` 校验 `libx264`/`aac`/`afade`/`aresample` 与最低版本门槛；未定位到判 **warn**（提示 agent 安装到 `~/.gitruck/ffmpeg` 或 `--ffmpeg-path`），**不判 fail**——`doctor.ts:113` 的 `exitCode=1` 只对真 fail 触发，只出工程文件的用户不被拦。

**D8 独立 `render` 命令 + `oralcut --local-render` 内联。** `index.ts:56` 已注释预留 `registerRender`。落一个独立 `render <gtrk>`（可对任意 gtrk 工程本地出片，复用于未来 struct/matrix），`oralcut --local-render` 则是拉回 EDL 后内联调用同一 `src/lib/render.ts`。

## Risks / Trade-offs

- [音画时基对齐：VFR/容器 `start_time`/edit list 致抽出音频与原片 PTS 漂移 → 本地渲染切点错帧] → 属正确性风险、非画质；列为**阶段 0 go/no-go 前置实测**（真实毛片抽音频后校验时基）；抽音频命令保留原始时基（不加 `-ss`/`-t` 偏移）。
- [本地渲染必然整片重编码（切点落非关键帧、无法 stream copy），低配机渲长毛片慢] → 给进度反馈与预期说明；不做提速 hack。
- [跨仓 gtrk / filter_complex 语义漂移] → 黄金用例对拍固化契约（D3），后端 change 导出对拍向量。
- [客户端 ffmpeg 版本与云端不一致致滤镜默认行为微异] → doctor 探测 + 最低版本门槛；文档钉推荐版本。
- [内网/离线客户 agent 装不了 ffmpeg] → `--ffmpeg-path` 手动指定 + 离线放置到 `~/.gitruck/ffmpeg` 兜底。
- [目录迁移误动用户数据] → 迁移只在 `~/.gitruck` 目标缺失且 `~/.gtrk-cli` 存在时执行、幂等、保留旧目录不删（观察期后再由用户清）。

## Migration Plan

纯客户端增量：发 npm 新版本即生效。启动时 `~/.gtrk-cli`→`~/.gitruck` 一次性迁移（幂等、不删旧目录）。联调依赖后端 change `add-cli-domain-video-oral-cut` 先部署；回滚 = 回退 CLI 版本（旧版继续读 `~/.gtrk-cli`、走通用 `video_oral_cut` 直传，不受影响）。

## Open Questions

- 时基对齐为既有大前提：现链路即在 ASR 步抽音频喂豆包、渲染在原片按秒下刀，生产未遇严重偏移（主理人确认）。客户端 `-vn` 抽音频复刻同一口径即对齐；仅对 VFR/偏移异常片保留 `-copyts` 兜底选项，非阻断。
- ffmpeg 最低版本钉定值（≥4.x 够用，倾向推荐 6.x）待定，随 doctor 能力探测一起定。
- 后端计费按上传音频流时长、仅设宽松容差 sanity 校验、**不做抽检**（主理人定：机制卡+护栏，非监管兜底）；CLI 侧保证抽出物时长与原片一致（容差 <1s）后再上传。
