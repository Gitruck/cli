# 契约库引用（正本不在这里）

框架契约库**正本** = `@gitruck/cli` 包内 `contracts/` 目录（管线资产归管线位置）：

- `contracts/README.md` — 收录双轴边界（管线性 + 脱敏）
- `contracts/handoff-contracts.json` — handoff 类型 → 契约映射表（**查表，不硬编码**）
- `contracts/gsap-emit-v1.md` — HTML 动画颗粒逐帧 seek 合规契约 v1

定位方式：本 skill 经 `gtrk skills install` 安装时，CLI 包根即 `gtrk` 命令所属包（`npm root -g` 下的 `@gitruck/cli`，或开发仓根）。找不到包时，让用户跑 `gtrk doctor` 确认安装。
