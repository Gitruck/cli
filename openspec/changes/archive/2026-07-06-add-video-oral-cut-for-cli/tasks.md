## 1. 前置对齐（豆包字级/时基已确认，见 design）

- [x] 1.1 抽音频口径对齐：`media.extractAudio` 用 `-vn -ac 1 -ar 16000 -c:a libmp3lame -b:a 64k` 抽 16k 单声道 mp3（复刻后端抽音频口径；时基对齐是既有大前提）；VFR/偏移异常片留 `-copyts` 兜底为后续
- [ ] 1.2 拉取后端渲染黄金用例向量作 §6 对拍基线 —— 待后端 change 的 §7.1 导出（本地已先建自洽对拍基线，见 §8.4）

## 2. 用户目录归一 ~/.gitruck（gitruck-home）

- [x] 2.1 `src/lib/paths.ts` 加 `gitruckHome/homeFile/ffmpegDir/audioCacheDir`；`user-config.ts`、`upload-cache.ts` 基址由 `~/.gtrk-cli` 切到 `gitruckHome()`
- [x] 2.2 `migrateLegacyHome()`：旧目录存在且新目录无 config.json 时一次性迁移，幂等、不删旧目录、损坏不阻断；`index.ts` 启动即调

## 3. ffmpeg 运行时（ffmpeg-runtime，src/lib/ffmpeg.ts 新增）

- [x] 3.1 二进制定位 `resolveFfmpeg`：`--ffmpeg-path` → `~/.gitruck/ffmpeg/{ffmpeg,ffprobe}[.exe]` → 系统 PATH，进程内按 key 缓存
- [x] 3.2 绝对路径 spawn（`runFfmpeg`/`ffprobeJson`），env 用 process.env 原样传入——不写/不改用户 PATH 与环境变量
- [x] 3.3 能力/版本探测 `probeCapabilities`：`-encoders`/`-filters` 校验 libx264/aac/afade/aresample
- [x] 3.4 缺失指引 `FFMPEG_INSTALL_HINT`：委托 agent 装到 `~/.gitruck/ffmpeg/`、先查本地缺失才拉、国内加速站点 + sha256（SKILL.md 已落具体做法），不自行下载

## 4. 本地媒体预处理（src/lib/media.ts 新增）

- [x] 4.1 `probeGeometry`：ffprobe 探原片 `{width,height,fps,duration}`（r_frame_rate 求值）
- [x] 4.2 `extractAudio`：抽 16k 单声道 mp3 到 `~/.gitruck/audio-cache/`，按原片指纹命名缓存
- [x] 4.3 `compress720p`：`scale=-2:720 libx264 veryfast crf28 aac` 压 720p 代理（visual_assist 时）
- [x] 4.4 `assertDurationConsistent`：抽出物时长与原片一致性自检（容差 1s），不一致中止报错

## 5. oralcut 命令改造（src/commands/oralcut.ts）

- [x] 5.1 上传标的从原片改为抽出物：默认抽音频；`--visual-assist` 压 720p
- [x] 5.2 payload 携带 `video_size`/`video_rate`/`video_duration`（本地探得）+ 保留 `source_path`=原片绝对路径
- [x] 5.3 taskType 改 `cli/video_oral_cut_for_cli`（cloud.ts 不改，bun 冒烟验证命令拼接）
- [x] 5.4 上传缓存指纹落到抽出物；抽出物按原片指纹本地缓存（免重抽）；`--reupload` 顺延；6004 失效重传抽出物
- [x] 5.5 三方产物落位与 `--json` 机读契约保持（新增 `rendered` 字段，其余逐字段不变）

## 6. 本地渲染（src/lib/render.ts + src/commands/render.ts 新增）

- [x] 6.1 gtrk EDL 解析（readGtrkFile + materialPathsFromGtrk）：读 materials[].path/video_track/audio_track/clip 时码
- [x] 6.2 `buildFilterGraph`：1:1 移植后端 build_filter_graph（视频 trim+setpts+fps+scale+pad+setsar+format+concat；音频 atrim+asetpts+aresample+aformat+afade+concat/amix；%g/`.6f` 格式对齐）
- [x] 6.3 编码 `libx264 -preset medium -crf 18 -c:a aac -b:a 192k -movflags +faststart`；`--crf`/`--codec` 覆盖；进度反馈 + ffmpeg 非零退出带回 stderr
- [x] 6.4 `index.ts` 启用 `registerRender`，独立 `render <gtrk>` 命令；`oralcut --render` 内联本地渲染
- [x] 6.5 原片素材缺失/路径不存在报错指明缺失

## 7. doctor（src/commands/doctor.ts）

- [x] 7.1 新增「本地渲染 (ffmpeg)」行：定位到显来源 + libx264 能力探测；未定位/缺 libx264 判 **warn 不判 fail**

## 8. 测试（test/，node:test 离线）

- [ ] 8.1 目录迁移单测 —— 未写（migrateLegacyHome 触及真实 ~/，需 HOME 覆盖/mock，留 CI）
- [ ] 8.2 ffmpeg 定位优先级 + 环境零侵入单测 —— 未写（touches fs+spawn，留 CI）
- [ ] 8.3 几何探测 + 抽出物时长自检单测 —— 需真实 ffmpeg，留部署/CI
- [ ] 8.4 filter_complex 对拍：本地自洽基线已建（test/render.test.mjs 3 用例：单源单轨精确 filter 串 / 无音轨全静音 / 视频补黑场尾，本机 3/3 通过）；与**后端黄金向量**逐文本比对待后端 §7.1 导出
- [x] 8.5 `tsc --noEmit` 0 错 + `bun build` 全量构建成功 + CLI 冒烟（--version/命令列表/render 注册/oralcut 新选项）全绿；`npm test` 16/16 通过

## 9. 文档

- [ ] 9.1 SKILL.md 已更（本地预处理/只传小文件/本地渲染/ffmpeg 委托 agent 装~/.gitruck·先查后拉+国内镜像/`--render` 本地/`--visual-assist` 720p/`rendered` 字段）；`AGENT.md`（开发者向）待同步补
- [x] 9.2 飞书接口文档已建（video_oral_cut_for_cli `docx/HyEXddaT9oWCHSx4gLMcytT1nqc`，与后端 Swagger `/cli/apidocs` 对齐）

## 10. 联调与发版（等后端 add-cli-domain-video-oral-cut 部署后）

- [ ] 10.1 真机 E2E：真实毛片 → 抽音频/720p 上传 → 拉 gtrk EDL(画布/帧率正确) → 本地渲染成片 → 与云端观感等价比对
- [ ] 10.2 bun build + npm publish 新版本
