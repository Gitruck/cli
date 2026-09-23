# 开发与贡献

[返回首页](../README.md) · [命令参考](reference.md) · [English](development.en.md)

## 本地开发

CLI 运行时需要 Node.js ≥ 20.6；源码开发与构建使用 Bun。

```bash
git clone https://github.com/Gitruck/cli.git
cd cli
bun install
bun run src/index.ts --help
npm run typecheck
bun run build
```

公共仓库可用于阅读、开发和构建 CLI。`test/` 与 `openspec/` 是需要维护者权限的私有子模块，公开贡献者无需递归拉取它们；完整测试由有权限的维护者运行。

## 项目结构

```text
src/index.ts       命令入口
src/commands/      CLI 命令
src/lib/           云端调用、素材处理、工程装配与渲染
skills/            随包 Agent Skills
contracts/         工程与动态图等开放契约
docs/              工作流、配置、命令和开发参考
assets/            README 配图
AGENT.md           可移植 Agent 操作手册
```

新增命令在 `src/commands/` 中提供注册函数，并在 `src/index.ts` 接入；工具族优先复用已有描述器与执行器。随包 Skills 的权威清单在 `src/commands/skills.ts`，详细名单见[参考文档](reference.md)。

## 文档与校验

- README 负责产品展示和上手；参数、配置与完整操作解释维护在 `docs/reference.md` / `docs/reference.en.md`。
- 两份 README 和对应双语文档同步更新。命令名、参数、字段与产物文件名保持原样；示例命令保持一致。
- 配图使用公开可访问资源，或放入 `assets/`；案例保持可追溯，不将大视频打包进 npm。
- 维护者运行 `npm test`（构建后通过 Node 测试），不要用 `bun test` 代替。纯文档变更至少运行相关文档守卫、检查链接和展示效果。
- 修改公开随包文档时，检查 `npm pack --dry-run` 的文件清单，避免移动后漏包。

## 提交贡献

通过 [Issues](https://github.com/Gitruck/cli/issues)描述问题、使用场景或希望改进的行为。提交 PR 时说明变更与验证方式。不要提交 API Key、个人配置、素材路径、生成产物或私有子模块的内容。

接口约定见 [contracts](../contracts/README.md)，Agent 使用方式见 [AGENT.md](../AGENT.md)。
