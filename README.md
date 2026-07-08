# gtrk-cli

> 同合云成片流水线 CLI —— **agent 驱动云端任务、产物拉回本地、三方工程文件（客户端 / 剪映 / PR）互通**。
>
> 一条命令，把口播毛片变成可二次精修的剪辑工程。云端做重活，本地只装配，源视频不出本地。

---

## 为什么用 gtrk-cli

- **一条命令出三方工程**：上传口播毛片 → 云端智能剪辑（剪废话 / 重复 / 长停顿）→ 拉回**客户端（gtrk）+ 剪映 + PR/FCP** 三方工程文件 → 自动打开产物目录。
- **云端做重活、本地只装配**：识别、剪辑、对齐都在云端；本地只拿结果，**源视频不出本地**（路径写进工程、本地打开直接认素材）。
- **为 agent 而生**：配套 skill `/gtrk-oralcut`，在 Claude Code 等工具里一句「帮我剪个口播」就能发起，CLI 是手、agent 是脑。
- **专业可扩展**：单 binary + 子命令（对标飞书 `lark-cli`），后续长出 `render` / `struct` / `matrix` 等命令。

## 功能

| | 命令 | 做什么 |
|---|---|---|
| 🎬 | `gtrk oralcut <毛片>` | 智能口播剪辑闭环：一次出 gtrk + 剪映 + PR 三方工程，自动打开 |
| ✂️ | `gtrk split [拆分稿]` | 视觉拆分派单器：成片 × transcript 投影 → beat 分镜校验落地（`struct_meta.split` + `dispatch.json`），驱动四车道派单 |
| ⚙️ | `gtrk init` | 引导式一次性配置（API Key + 剪映草稿目录），之后免管 |
| 🩺 | `gtrk doctor` | 体检：配置 / 云端连通 / 剪映目录 / 运行时一键自检 |
| 🤖 | `gtrk skills install` | 把 `/gtrk-oralcut`、`/gtrk-splitter` skill 装进 Claude Code |
| ⬆️ | `gtrk upgrade` | 升级 CLI 到最新版 + 刷新 skill（配置保留）；`--check` 只查不装 |
| 🚧 | `render` / `struct` / `matrix` | 本地渲染 gtrk 成片 /（规划中）已有 gtrk 转三方工程 / B-roll 检索 |

---

## 获取 API Key

CLI 要调用同合云云端能力，需先拿一个 API Key（形如 `gc_xxxxxxxx`）：

1. 打开官网 **[cloud.ai-mcn.tv](https://cloud.ai-mcn.tv)** 并登录 —— **登录即开通**、自带免费测试额度、零门槛。
2. 进入 **[控制台](https://cloud.ai-mcn.tv/zh-CN/dashboard)**，在「API 密钥 / 密钥管理」处生成并复制你的 Key。
3. 下一步 `gtrk install` 会让你把它粘进去（一次配好、本地长期复用）。

> 快速开始文档：[cloud.ai-mcn.tv/zh-CN/docs/quick-start](https://cloud.ai-mcn.tv/zh-CN/docs/quick-start) · 对接咨询：business@migotimes.com

## 安装 & 快速上手

需要 Node.js ≥ 20.6（`node -v` 查看）。

```bash
# 1) 一条命令装全：命令行 gtrk + /gtrk-oralcut skill + 配置（填 API Key、自动扫剪映目录）
npm i -g @gitruck/cli@latest && gtrk install
#   或免全局安装直接用：npx @gitruck/cli@latest install

# 2) 剪一条（剪完自动打开产物目录）
gtrk oralcut "D:/素材/某选题-原始口播.mp4" --script "D:/素材/某选题-文字稿.txt"
```

> 只想配置、不装 skill：用 `gtrk init`。本地开发：`cd gtrk-cli && bun install && bun run src/index.ts <命令>`。

产物目录形如 `<毛片名>-video-project-<YYMMDD-HHMMSS>/`，内含 `gtrk/`、`jianying/`、`xml/` 三端工程。

> **重复装不会重复填配置**：`gtrk install` / `gtrk init` 检测到已配好就默认保留、只刷新 skill；想改配置加 `--reconfigure`（Key / 剪映目录也都能回车沿用）。

## 升级

**CLI + skill**（配置原样保留）：

```bash
gtrk upgrade          # 有新版则升到最新 + 刷新 skill
gtrk upgrade --check  # 只看有没有新版，不动手
```

> 用 `npx` 的（没全局装）本就每次拉最新：`npx @gitruck/cli@latest install`。`gtrk doctor` 也会顺带提示「有新版可升级」。

**桌面客户端**：重跑一键安装脚本即覆盖装最新版（per-user、免管理员、配置不动）：

```powershell
irm https://api.ai-mcn.tv:9000/broadcast/exe/install.ps1 | iex
```

## 给 AI Agent 用

`gtrk install` 已经把 `/gtrk-oralcut` skill 装进 `~/.claude/skills`（单独装用 `gtrk skills install`）。

然后在 Claude Code 里直接说「**帮我把这条口播剪一版**」或打 `/gtrk-oralcut`，agent 会问清毛片 / 文稿 / 节奏，调 `gtrk oralcut --json` 跑通闭环、验证产物、把三端打开方式回给你。完整可移植 playbook 见 [`AGENT.md`](./AGENT.md)。

### Skills

| Skill | 触发 | 做什么 |
|---|---|---|
| `/gtrk-oralcut` | 斜杠，或「剪口播 / 智能剪辑 / 去掉废话停顿 / 出剪映草稿」 | 驱动 `oralcut` 闭环：云端剪辑 → 拉回三方工程 → 验证 → 回报三端打开方式 |

---

## 配置

`gtrk init` 把配置写到 `~/.gtrk-cli/config.json`。读取优先级：**环境变量 / `.env` > `init` 持久配置 > 默认根地址**。

| 项 | 来源 | 说明 |
|---|---|---|
| `GITRUCK_API_KEY` | env / init | 鉴权 Header `Authorization` 的**裸值**（非 Bearer） |
| `GITRUCK_API_BASE` | env / init | API 根地址，默认 `https://api.ai-mcn.tv:10000` |
| 剪映草稿目录 | init / 自动探测 / `--jianying-draft-dir` | 决定剪映草稿落哪、能否直接打开 |

非交互配置（脚本 / CI）：

```bash
gtrk init --api-key <KEY> --jianying-draft-dir auto -y
```

随时 `gtrk doctor` 自检：

```
✅ 运行时：node v24.x
✅ CLI 版本：v0.3.0（已是最新）
✅ API Key：已配（gc_xxx…）
✅ 云端连通 + 鉴权：可达，鉴权通过
✅ 剪映草稿目录：C:\Users\…\com.lveditor.draft
```

---

## 命令参考

### `gtrk oralcut <毛片>`

| 参数 | 作用 | 缺省 |
|---|---|---|
| `-s, --script <file>` | 文字稿 txt（有稿按稿剪、更准） | 探毛片同名 `.txt`；无则无稿智能重建 |
| `-p, --preset <p>` | 节奏 `steady`\|`concise`\|`compact`（松→紧） | `concise` |
| `-o, --out <dir>` | 自定义产物目录 | `<毛片名>-video-project-<时间戳>` |
| `-f, --formats <list>` | 三方格式逗号分隔 | `gtrk,jianying,xml` |
| `--jianying-draft-dir <dir>` | 剪映草稿根目录（或 `auto`） | 读 init 配置 / 自动探测 |
| `--reupload` | 强制重传，忽略上传缓存 | 关 |
| `--no-open` | 完成后不自动打开产物目录 | **默认自动打开** |
| `--json` | 机读：stdout 只输出结果 JSON（给 agent / 脚本） | 关 |

`--json` 输出（成功时 stdout 单行）：`{ ok, outDir, files:{gtrk,jianying,xml}, jianyingDraftPath, rendered, report, errors, taskId, fileId }`；命令失败则进程非 0 退出、报错走 stderr、stdout 无 JSON。

> 每次跑批都会把这份结果**恒写一份 `result.json` 到产物目录**（不受 `--json` 约束）；提交成功后还会落一份 `task.json` 面包屑。即便 stdout 丢了、或中途崩了，报告与 `taskId` 都在盘上，可用下面的 `oralcut-result` 秒级取回、无需重跑云端。

### `gtrk oralcut-result <taskId>`

按 `task_id` 从云端取回一个**已完成**任务的报告与三方工程产物（可选本地渲染成片），**跳过预处理 / 上传 / 提交 / 轮询**——报告丢了、或想换台机器再拉一次产物时用它，不重跑云端。

| 参数 | 作用 | 缺省 |
|---|---|---|
| `-o, --out <dir>` | 产物目录 | `<当前目录>/<taskId>-video-project-<时间戳>` |
| `--render` | 额外本地渲染成片（需原毛片仍在 gtrk 内嵌路径 + ffmpeg） | 关 |
| `--jianying-draft-dir <dir>` | 剪映草稿根目录（或 `auto`） | 读 init 配置 / 自动探测 |
| `--no-open` / `--json` | 同 `oralcut` | — |

> 取结果需用**提交该任务的同一账号** API Key（异账号 / 已删任务报 `TASK_NOT_FOUND`）。报告存于任务记录、长期可取；底层产物文件约 **60 天**后被清理，届时仍能取回报告、但产物下载会 404（命令会提示、并照常落盘报告）。

### 其它

- `gtrk install [--api-key … -y --skills-dir …]` — 一条命令装全（skill + 配置 + 体检），对标飞书 `lark-cli install`。
- `gtrk init [--api-key … --api-base … --jianying-draft-dir … -y]` — 仅配置（交互 / 非交互）。
- `gtrk doctor` — 体检（含 CLI 版本 / 有无新版）。
- `gtrk upgrade [--check]` — 升级 CLI 到最新版 + 刷新 skill（配置保留）；`--check` 只查不装。
- `gtrk skills install [--dir <skills 目录>]` — 单独安装 agent skill。

---

## 工作原理

```
本地 gtrk CLI                          同合云                         本地三端
─────────────                      ─────────────                  ─────────────
毛片 ──上传(指纹缓存免重传)──▶  video_oral_cut 智能剪辑  ──产物──▶  客户端 gtrk/project.gtrk
                                  (一次出 gtrk/剪映/xml)            剪映  自动落草稿目录
源路径写进 gtrk materials.path                                     PR/FCP  导入 premiere.xml
```

- **gtrk** 是 timeline 的真超集 + HTML 颗粒，是同合云的统一工程契约；三端从同一份 gtrk 派生、切点一致。
- 云端**零改动**全用现成 `video_oral_cut`；CLI 只做编排（上传 / 提交 / 轮询 / 拉回 / 落位 / 打开）。

## 注意

- 剪映 / CapCut 草稿需 `draft_content.json` + `draft_meta_info.json` **成对**才被软件识别——要么 `gtrk init` 配好草稿目录、要么 `--jianying-draft-dir` 指定，否则只产 content、需手动导入。
- 多台机器盘符不同时，配置走 `~/.gtrk-cli/`（用户级），产物默认落毛片同目录。
- 节奏预设强度以云端为准；`--preset` 只选预设、不改源裁剪。

---

## 结构

```
gtrk-cli/
├── src/index.ts              # commander 入口
├── src/commands/             # 子命令：install / init / oralcut / doctor / upgrade / skills
├── src/lib/                  # cloud / config / user-config / jianying / open / upload-cache / log
├── skills/gtrk-oralcut/      # 打包的 agent skill（skills install 装它）
├── assets/                   # 剪映草稿目录指引图
└── AGENT.md                  # 可移植 agent playbook（skill 底座）
```

新增命令 = 写 `src/commands/<name>.ts` 的 `register<Name>(program)` + 在 `src/index.ts` 注册一行。
