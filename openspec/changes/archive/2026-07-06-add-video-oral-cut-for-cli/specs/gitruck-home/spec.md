## ADDED Requirements

### Requirement: `~/.gitruck` 统一用户目录

CLI 的用户级持久数据 MUST 统一落 `~/.gitruck/`：`config.json`、上传/会话缓存、`ffmpeg/`（二进制）、`audio-cache/`（抽出的音频/720p 代理）。目录基址 MUST 集中定义（单一来源），供各模块引用，未来只保留 `.gitruck` 一个目录。

#### Scenario: 各类数据统一归位
- **WHEN** CLI 读写配置、上传缓存、ffmpeg、抽出物缓存
- **THEN** 全部位于 `~/.gitruck/` 对应子路径下，不再写 `~/.gtrk-cli`

### Requirement: 从 `~/.gtrk-cli` 一次性迁移

CLI 启动时 MUST 检测：当 `~/.gtrk-cli` 存在且 `~/.gitruck` 尚无对应内容时，一次性迁移旧目录数据到 `~/.gitruck`。迁移 MUST 幂等、MUST NOT 删除旧目录（保留观察期，由用户自行清理），迁移失败或旧数据损坏 MUST NOT 阻断命令（降级为新建空配置）。

#### Scenario: 首次升级自动迁移
- **WHEN** 老用户升级后首次运行、`~/.gtrk-cli/config.json` 存在而 `~/.gitruck` 缺失
- **THEN** 配置/缓存迁移到 `~/.gitruck`，旧目录保留，命令正常执行

#### Scenario: 迁移幂等
- **WHEN** `~/.gitruck` 已有配置后再次运行
- **THEN** 不重复迁移、不覆盖新目录数据

#### Scenario: 旧数据损坏不阻断
- **WHEN** `~/.gtrk-cli` 存在但内容损坏
- **THEN** CLI 跳过迁移、以空配置继续（可由 `gtrk init` 重写），不报致命错误
