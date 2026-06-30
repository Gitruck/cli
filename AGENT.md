# gtrk-cli · Agent Playbook

给 **agent** 看的操作手册：把用户「想剪一条口播」的自然语言需求，落成对 `gtrk` CLI 的一次调用，
再把产物目录 + 三端（客户端 / 剪映 / PR）打开方式回给用户。任何 agent（Claude / Cursor / …）读完
这一份就能驱动整条闭环；Claude 的 `/口播剪辑` skill 只是这份 playbook 的薄壳。

> 这条 CLI 做的事：**上传毛片 → 云端智能口播剪辑（video_oral_cut）→ 拉回 gtrk/剪映/PR 三方工程
> 文件 → 三端打开**。云端零改动、纯结构产物，源视频不出本地。

---

## 0. 一句话流程

```
gtrk init                                    # 一次性配置（API Key + 剪映目录）
gtrk oralcut <毛片.mp4> [--script 文字稿.txt]  # 剪一条；剪完自动打开产物目录
```

跑完得到一个产物目录：`<毛片同目录>/<毛片名>-video-project-<YYMMDD-HHMMSS>/`，里面按格式分子目录，
三端各自打开即可。

---

## 1. 一次性准备（只做一次）

1. **装 bun**（运行时）：https://bun.sh 。
2. **拿到 CLI**：进入 `gtrk-cli/` 仓库，`bun install`。
3. **调用方式**（二选一）：仓库内 `bun run src/index.ts <命令> …`；或 `bun link` 后全局 `gtrk <命令> …`（本文档统一写 `gtrk`）。
4. **跑 `gtrk init` 引导式配置**（对标飞书 lark-cli install，只做一次）：
   - 填 **API Key**（鉴权 Header `Authorization` 的裸值，非 Bearer）；根地址默认生产、回车即用。
   - **自动扫描剪映草稿目录**：扫到让你确认；扫不到会**自动打开一张指引图**（剪映 → 全局设置 → 草稿 →「草稿位置」）让你把路径粘过来；可留空跳过。
   - 配置写到 `~/.gtrk-cli/config.json`，之后所有命令免重复配置。
   - 环境变量 `GITRUCK_API_KEY` / `GITRUCK_API_BASE` 仍可覆盖（CI / 临时切换）。

> agent 自检：没配 Key 时任何命令会明确报「缺 API Key —— 先跑 `gtrk init`」。剪映目录没配只影响剪映直开，不挡 gtrk/PR。
> `init` 是**人手一次性**交互配置（会弹提示）；agent 日常只跑非交互的 `oralcut`。

---

## 2. 核心命令：`gtrk oralcut <毛片>`

| 参数 | 作用 | 缺省 |
|---|---|---|
| `<毛片>`（位置参数） | 本地口播原视频路径 | 必填 |
| `-s, --script <file>` | 文字稿 txt 路径（**有稿**：按稿对齐裁剪） | 不传 = **无稿智能重建** |
| `-p, --preset <preset>` | 节奏预设 `steady`\|`concise`\|`compact`（松→紧） | `concise` |
| `-o, --out <dir>` | 自定义产物目录 | `<毛片同目录>/<毛片名>-video-project-<YYMMDD-HHMMSS>` |
| `-f, --formats <list>` | 三方格式逗号分隔 | `gtrk,jianying,xml` |
| `--jianying-draft-dir <dir>` | 剪映草稿根目录；传路径或 `auto` | 读 `gtrk init` 配置 / 自动探测 |
| `--reupload` | 强制重新上传，忽略本地上传缓存 | 关 |
| `--no-open` | 完成后**不**自动打开产物目录 | **默认会自动打开** |

**关键行为（agent 需知道，不用解释给用户）：**

- **上传缓存**：同一毛片（按 `size:mtime` 指纹）二次跑直接复用 `file_id`，跳过整段上传。缓存在
  `~/.gtrk-cli/upload-cache.json`。云端 file_id 失效会自动重传兜底。毛片改了但指纹意外没变 → `--reupload`。
- **剪映草稿自动落位**：探到剪映/CapCut 草稿目录时，下载后自动把草稿拷进
  `<草稿根>/<毛片名>-video-project-<时间戳>/`（与产物目录同名、含时间戳）→ 剪映项目列表里每次剪辑
  各为独立条目、不互相覆盖。探不到会警告并提示加 `--jianying-draft-dir`（此时剪映只产 `draft_content.json`、
  缺 meta、无法直接打开）。
- **节奏预设**：`steady` 保留更多停顿（稳）、`concise` 默认精炼、`compact` 最紧凑（压停顿最狠）。
- **部分格式失败不致命**：CLI 如实回显云端 `errors`（某格式没出来不影响其余）。

---

## 3. 产物结构 + 三端打开

```
<毛片名>-video-project-<YYMMDD-HHMMSS>/
├── gtrk/project.gtrk        → 客户端（opencut-rewrite）：「打开工程」选它
├── jianying/                → 剪映：已自动拷进剪映草稿根，剪映里直接见草稿
│   ├── draft_content.json
│   └── draft_meta_info.json （仅当探到/指定了剪映草稿目录才有）
└── xml/premiere.xml         → Premiere Pro：文件 > 导入
```

**默认跑完自动打开产物目录文件夹**（`--no-open` 关）——用户常不知道文件落哪，直接帮他打开、自己挑工具。三端切点正确、同源一致（gtrk 是真超集）。

---

## 4. Agent 决策清单（自然语言 → 参数）

把用户的话映射到一次调用，按这几条判断：

1. **毛片路径**：用户给的视频文件绝对路径 → 位置参数。缺则先问。
2. **有稿 / 无稿**：
   - 用户给了文字稿/逐字稿文件 → `--script <该文件>`（按稿剪，最准）。
   - 没稿 → 不传 `--script`，走云端无稿智能重建（CLI 默认）。
3. **节奏**：用户说「快/紧凑/卡点狠」→ `--preset compact`；「稳一点/别删太多停顿」→ `steady`；
   没特别要求 → 默认 `concise`，不用传。
4. **要不要自动打开**：默认就开（用户常不知道文件去哪了，别让他找）。只有明确「别打开 / 批处理」才加 `--no-open`。
5. **剪映装在非标准位置 / 多版本**：若用户没跑过 `gtrk init` 或探测失败，问剪映草稿根目录、传 `--jianying-draft-dir`（或让他先 `gtrk init`）。
6. **只要某一两端**：用户只要客户端 → `--formats gtrk`；只要剪映 → `--formats jianying`；默认三端全给。

**跑完做一层验证**（别只信"成功"二字、别谎报三端都好）：
- 确认产物目录在、`gtrk/project.gtrk` 非空（>0 字节）；要剪映就确认剪映草稿根里有**同名工程目录** + `draft_meta_info.json`。
- 云端 `errors` 非空 → 如实告知哪个格式失败、原因；必要时按用户意图微调重跑（换 `--preset`、补 `--jianying-draft-dir`、`--reupload`）。
- 然后**回给用户**：产物目录路径 + 三端各自怎么打开（客户端选 `gtrk/project.gtrk`、剪映已在项目列表、PR 导入 `xml/premiere.xml`）。

---

## 5. 典型调用

```bash
# 有稿 + 剪完就看（最常见）
gtrk oralcut "D:/素材/某选题-原始口播.mp4" --script "D:/素材/某选题-文字稿.txt" --open

# 无稿、要最紧凑节奏
gtrk oralcut "D:/素材/某条.mp4" --preset compact

# 只要客户端工程，不碰剪映/PR
gtrk oralcut "D:/素材/某条.mp4" --formats gtrk

# 剪映装在非标准盘符，手动指目录
gtrk oralcut "D:/素材/某条.mp4" --jianying-draft-dir "F:/JianyingPro/User Data/Projects/com.lveditor.draft"
```

---

## 6. 排错

| 现象 | 处置 |
|---|---|
| `缺 API Key —— 先跑 gtrk init` | 没配过 → 跑 `gtrk init`（或设环境变量 `GITRUCK_API_KEY`） |
| 剪映警告「没找到草稿目录」 | 剪映/CapCut 没装在标准位置 → 加 `--jianying-draft-dir <你的草稿根>` 重跑 |
| 云端 errors 含某格式 | 该格式单独失败、其余可用；把 errors 原文回给用户/反馈维护方 |
| 同毛片改了内容但产物像旧的 | 指纹意外没变 → 加 `--reupload` 强制重传 |
| 任务很久不动 | 轮询有 30min 墙钟上限；超时 CLI 会报，稍后重试或查云端任务 |

---

## 7. 扩展（给改 CLI 的 agent）

新增命令 = 写 `src/commands/<name>.ts` 的 `register<Name>(program)` + 在 `src/index.ts` 注册一行。
云端调用走 `src/lib/cloud.ts`（`{code,msg,data}` 包装、鉴权 Header `Authorization:<裸key>`）；上传一律走
`src/lib/upload-cache.ts` 的 `uploadCached`（白嫖指纹缓存）。规划中：`render`（云渲）、`struct`（已有 gtrk →
三方工程）、`matrix`（B-roll 检索）。
