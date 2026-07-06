## ADDED Requirements

### Requirement: ffmpeg/ffprobe 定位优先级

CLI MUST 按固定顺序定位 ffmpeg/ffprobe：① `--ffmpeg-path` 显式覆盖 → ② `~/.gitruck/ffmpeg/{ffmpeg,ffprobe}[.exe]` → ③ 系统 `PATH`。定位结果 MUST 缓存于单次进程内避免重复探测。

#### Scenario: 优先用 ~/.gitruck 下的二进制
- **WHEN** `~/.gitruck/ffmpeg/ffmpeg.exe` 存在
- **THEN** CLI 用该绝对路径，而非系统 PATH 上的 ffmpeg

#### Scenario: 回退系统 ffmpeg
- **WHEN** `~/.gitruck/ffmpeg` 无二进制但系统 `PATH` 有 ffmpeg
- **THEN** CLI 用系统 ffmpeg

#### Scenario: 显式路径覆盖
- **WHEN** 传入 `--ffmpeg-path <dir>`
- **THEN** CLI 用该路径下的 ffmpeg/ffprobe，优先于本地与系统

### Requirement: 绝对路径调用与用户环境零侵入

CLI 调用 ffmpeg/ffprobe MUST 用绝对路径 spawn，MUST NOT 修改用户系统环境变量或持久化 `PATH`。若某次调用确需设置环境变量，MUST 仅作用于该 spawn 子进程（进程结束即失效），MUST NOT 触及用户机的持久环境（尊重用户自装 ffmpeg 及其 PATH）。

#### Scenario: 不污染用户环境
- **WHEN** CLI 执行任意 ffmpeg 子进程
- **THEN** 用户 shell 的 `PATH`/系统环境变量在命令前后完全一致，无任何持久写入

### Requirement: ffmpeg 供给委托 agent、CLI 不自动下载

CLI MUST NOT 自行下载或随包分发 ffmpeg 二进制。未定位到可用 ffmpeg 时，CLI MUST 给出可执行指引：委托 agent 将 `ffmpeg.exe`+`ffprobe.exe` 放到 `~/.gitruck/ffmpeg/`（或用 `--ffmpeg-path`）。agent 执行安装时 MUST 先检查本地（`~/.gitruck/ffmpeg` 与系统 PATH）确实缺失才拉取；面向国内用户 SHOULD 优先国内加速站点（GitHub 代理 pass-through 拉官方静态构建，或同合云自建镜像）并做 sha256 校验，避免直连 github 慢/断。

#### Scenario: 缺失时给委托安装指引
- **WHEN** 三条定位路径均未找到 ffmpeg，且需要本地渲染
- **THEN** CLI 报错并提示把 ffmpeg/ffprobe 放到 `~/.gitruck/ffmpeg/`（agent 可代办）或用 `--ffmpeg-path`，不自行下载

#### Scenario: 已装则不重复拉取
- **WHEN** `~/.gitruck/ffmpeg` 或系统已有可用 ffmpeg
- **THEN** 直接复用，agent 不再拉取（先查后拉）

### Requirement: 能力与版本探测

`doctor` 与渲染前 CLI MUST 用 `ffprobe -encoders`/`-filters` 校验存在 `libx264`、`aac`、`afade`、`aresample` 等所需能力与最低版本门槛；缺失或过旧 MUST 给出明确提示。

#### Scenario: 缺 libx264 明确报错
- **WHEN** 定位到的 ffmpeg 无 `libx264` 编码器
- **THEN** CLI 明确提示该 ffmpeg 构建不含 libx264、需替换，而非渲染时静默失败
