# gtrk-cli · Agent Playbook

给 **agent** 看的操作手册：把用户「想剪一条口播」的自然语言需求，落成对 `gtrk` CLI 的一次调用，
再把产物目录 + 三端（客户端 / 剪映 / PR）打开方式回给用户。任何 agent（Claude / Cursor / …）读完
这一份就能驱动整条闭环；Claude 的 `/口播剪辑` skill 只是这份 playbook 的薄壳。

> 这条 CLI 做的事：**本地抽音频/720p（毛片永不上传）→ 只传抽出物 → 云端智能口播剪辑（video_oral_cut）
> → 拉回 gtrk/剪映/PR 三方工程文件 →（可选）本地 ffmpeg 渲染成片 → 三端打开**。云端零改动、纯结构产物，
> 源视频不出本地。结果/报告恒落盘 `result.json`，可按 `task_id` 秒级取回、无需重跑（见 §2.1 / §4）。

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
   - 配置写到 `~/.gitruck/config.json`，之后所有命令免重复配置。
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
| `--lang <code>` | 语言代码（英文 `en-US`、日文 `ja-JP`…） | `zh-CN` |
| `--visual-assist` | **视觉兜底**：改传 **720p 代理**（非原片）+ 人脸/说话检测保护漏识别段并重识别（剪不准时开） | 关 |
| `--no-adaptive-rhythm` | 关闭自适应节奏，改用固定标点停顿表 | 自适应开 |
| `--render` | 额外**本地 ffmpeg** 按 gtrk EDL 渲染成片 mp4（毛片仍不上传、云端不渲染） | 只出工程 |
| `--crf <n>` / `--codec <c>` | 本地渲染视频质量 14-28（默认 18，越小越清晰）/ 编码（默认 h264），配 `--render` | — |
| `--ffmpeg-path <dir>` | 指定 ffmpeg/ffprobe 所在目录（本地抽音频/渲染用） | `~/.gitruck/ffmpeg` → 系统 PATH |
| `--param k=v` / `--params-json '{…}'` | **通用透传**：任意云端参数（标量可重复 / JSON 嵌套），优先级最高 | — |
| `--reupload` | 强制重新上传，忽略本地上传缓存 | 关 |
| `--no-open` | 完成后**不**自动打开产物目录 | **默认会自动打开** |

**关键行为（agent 需知道，不用解释给用户）：**

- **上传缓存**：同一毛片（按 `size:mtime` 指纹）二次跑直接复用 `file_id`，跳过整段上传。缓存在
  `~/.gitruck/upload-cache.json`。云端 file_id 失效会自动重传兜底。毛片改了但指纹意外没变 → `--reupload`。
- **大文件分片断点续传**：≥256MiB 自动走分片上传（32MiB/片、3 并发、单片自动重试）。上传中断（断网/
  Ctrl+C/进程崩）→ **重跑同一命令即自动续传**，只补缺片不重来（会话在 `~/.gitruck/upload-sessions.json`）。
  云端已有同内容文件（未过期）时**秒传**：零字节上传直接拿 file_id。`--reupload` 同时跳过缓存/续传会话/秒传，
  强制整传。小文件路径与输出契约完全不变。
- **剪映草稿自动落位**：探到剪映/CapCut 草稿目录时，下载后自动把草稿拷进
  `<草稿根>/<毛片名>-video-project-<时间戳>/`（与产物目录同名、含时间戳）→ 剪映项目列表里每次剪辑
  各为独立条目、不互相覆盖。探不到会警告并提示加 `--jianying-draft-dir`（此时剪映只产 `draft_content.json`、
  缺 meta、无法直接打开）。
- **节奏预设**：`steady` 保留更多停顿（稳）、`concise` 默认精炼、`compact` 最紧凑（压停顿最狠）。
- **部分格式失败不致命**：CLI 如实回显云端 `errors`（某格式没出来不影响其余）。
- **本地预处理 · 只传抽出物**：跑批先本地探几何 + 抽 16k 单声道 mp3（默认）/ 压 720p 代理（`--visual-assist`）；**毛片永不上传**，只传几十 MB 抽出物。抽出物按原片 `size:mtime` 指纹缓存在 `~/.gitruck/audio-cache/`，同毛片重剪免重抽（720p 与 mp3 各缓存各的、互不覆盖）。
- **结果恒落盘 · 可按 task_id 恢复**：每次跑批恒写 `<产物目录>/result.json`（含完整 `report`，**不受 `--json` 约束**）；submit 一成功就写 `task.json`（含 `taskId`）面包屑，且产物目录**延后到首次写入才建**（提交前失败不留空壳、提交后失败留 `task.json` 可恢复）。→ stdout 丢了 / 中途崩了，报告与 `taskId` 都在盘上，用 `gtrk oralcut-result <taskId>` 秒级取回、**别重跑整条 `oralcut`**（见 §2.1）。

**细节微调 —— 按用户诉求因势象形、自由组合**（上表是常用一等 flag；下面是节奏细调 + 完整取值）。你有云端全部参数，按需自由决定用哪些。**唯一要求：名字 / 取值 / 范围照文档用**（别记错拼错）；传越界云端报 `6016` 附原因、照改即可（乱传不产错误成片、只明确报错）。没特别诉求就跑默认。

- **剪不准 / 剪掉真内容 / 有句话没剪进去** → `--visual-assist`：ASR 之外并行跑人脸 + 说话检测，画面在说话却没识别出字的地方**保护不剪**并重识别捞回（需说话人面部基本可见），捞不回的进 `report.review_points` 复核；引擎挂了只降级不失败；会增加处理耗时（与主识别并行、约两者较大值），但不额外计费、绝不凭空生成。**「剪不准」的兜底。**
- **节奏散参数**（无一等 flag，走 `--param 键=值` / `--params-json`，单位秒、范围 0–5）：
  - `punctuation_breaks`：逐标点停顿，键 `，、；：。！？—……` + `paragraph`（段落）。例 `--params-json '{"punctuation_breaks":{"。":0.6,"，":0.3}}'`。
  - `intra_gap_max`（>此值算气口，默认 0.35）/ `intra_gap_target`（收到多长，默认 0.10）/ `pad_in`(0.05) / `pad_out`(0.08)。例「气口留白多点」`--param pad_out=0.15`。
  - `render.audio_crossfade_ms`（切点淡化毫秒 0–50、默认 8）等也能透传。
- **节奏预设完整值**（选最贴内容的、再逐项覆盖；「默认」列 = 不选预设时各标点的默认停顿）：

  | 参数（秒） | steady 稳健 | concise 精练 | compact 紧凑 | 默认 |
  |---|---|---|---|---|
  | 适用 | 讲述/教学 | 自媒体中长 | 短视频/广告 | 通用 |
  | `、`/`，`/`；` | 0.18/0.25/0.36 | 0.12/0.18/0.26 | 0.06/0.08/0.12 | 0.15/0.20/0.30 |
  | `：`/`—` | 0.45/0.55 | 0.32/0.40 | 0.15/0.18 | 0.35/0.45 |
  | `。``！`/`？` | 0.55/0.60 | 0.40/0.45 | 0.18/0.20 | 0.45/0.50 |
  | `……`/`paragraph` | 0.75/1.20 | 0.55/0.90 | 0.25/0.40 | 0.60/1.00 |
  | `intra_gap_max`/`intra_gap_target` | 0.45/0.15 | 0.35/0.10 | 0.25/0.05 | 0.35/0.10 |
  | `pad_in`/`pad_out` | 0.05/0.10 | 0.05/0.08 | 0.03/0.05 | 0.05/0.08 |

- 优先级：`--preset` → 一等 flag → 透传（后者覆盖前者）。用户**自己点名**某参数 + 值 → 照他原样透传（CLI 底层支持任意云端参数）。**以上即 agent 需要的全部参数、本文档自足**（`gtrk oralcut --help` 也列全部 flag）；官网的原始 HTTP API 文档是给人看的，agent 不必也无法访问。

### 2.1 取回命令：`gtrk oralcut-result <taskId>`（报告丢了别重跑）

按 `task_id` 从云端取回一个**已完成**任务的报告 + 三方工程产物（可选本地渲染成片），**跳过预处理 / 上传 / 提交 / 轮询**。用在：`--json` 的 stdout 丢了、进程中途崩了、或想换台机器再拉一次产物 —— **不要重跑整条 `gtrk oralcut`**（后端 `get_task_by_id` 幂等，报告本就存着）。`taskId` 从产物目录 `task.json`、上次结果 JSON 或日志里取。

| 参数 | 作用 | 缺省 |
|---|---|---|
| `<taskId>`（位置参数） | 任务 id | 必填 |
| `-o, --out <dir>` | 产物目录 | `<当前目录>/<taskId>-video-project-<时间戳>` |
| `--render` | 额外本地渲染成片（需原毛片仍在 gtrk 内嵌路径 + ffmpeg） | 关 |
| `--jianying-draft-dir` / `--ffmpeg-path` / `--crf` / `--codec` / `--no-open` / `--json` | 同 `oralcut` | — |

- **同账号**：取结果需用**提交该任务的同一账号** API Key；异账号 / 已删任务报 `TASK_NOT_FOUND`（CLI 会提示「须用同账号 key」）。
- **报告长期可取、产物约 60 天**：报告存于任务记录、长期可取；底层产物文件约 **60 天**后被 GC，届时产物下载 404、命令会提示「已过期」并**照常落盘 / 输出报告**（报告不随文件过期）。
- **输出契约同 `oralcut --json`**：单行 `{ok,outDir,files,jianyingDraftPath,rendered,report,errors,taskId,fileId}`，恢复场景 `fileId=null`。

```bash
# 报告丢了、按 task_id 取回（不重跑云端）
gtrk oralcut-result 88269671080189958 --json
# 顺带本地重渲成片（原毛片需仍在 gtrk 内嵌路径）
gtrk oralcut-result 88269671080189958 --render --out "D:/回收/某条"
```

---

## 2.2 视觉拆分派单器：`gtrk split`（成片 → 分镜派单）

`oralcut` 出的是「剪好的口播成片」；`split` 把它拆成 **beat 级视觉分镜**并派单给下游四车道（真人 A-roll / MG 动态图 / AI_DRAMA 再现 / FILM_BROLL 影视素材）。**纯本地、同步、无云端任务**。上游依赖 `transcript.json`（oralcut 家族恒出的句级词表，源时基）。

编排顺序（脑=`gtrk-splitter` skill / 手=本命令）：

```
gtrk oralcut <毛片>                              # ① 出成片工程（gtrk + transcript）
（用户可在客户端手调切点后保存）                  # ② 时间线随时可改，所见即所得
gtrk split --project <产物目录> --json           # ③ 导出「发起那一刻」的投影视图 split/view.json（skill 创作输入）
（skill 按视图句级 id 拆 beat、选 lane、写 handoff） # ④ 产机器 JSON 拆分稿（零时码、只引用 utterance id）
gtrk split <拆分稿.json> --project <目录> --md --json  # ⑤ 校验落地：写回 struct_meta.split + 产 dispatch.json
```

| 用法 | 作用 |
|---|---|
| `gtrk split --project <dir>` | **投影视图导出**：transcript × 当刻 `.gtrk` 的 clips → `split/view.json`（句级轨道时基视图，含 dropped 标注） |
| `gtrk split <拆分稿.json> --project <dir>` | **校验落地**：v1 门 → 结构/枚举/id/hash 校验 → 现场投影 → ① `.gtrk` 的 `struct_meta.split` 原子写回（只改这一个键、mtime 冲突拒写）② `split/dispatch.json` 派单清单（`composition_id`=`<工程slug>-<beatId>`）③ `--md` 人读稿 |
| `--gtrk` / `--transcript` | 非标准布局兜底：显式指定工程/词表路径（缺省从 `--project` 自动定位 `gtrk/project.gtrk` 与 `transcript/transcript.json`） |
| `--words` | 视图模式附字级明细（缺省只出句级） |

**关键行为（agent 需知）：**
- **时码恒挂源时基、每次发起现场投影**：用户手调切点后重导视图即跟随；此前被剪、现落回 clip 的句子自动复活，无需重跑转写。「拖入已剪好成片」= 恒等投影，同一套逻辑。
- **拆分稿零时码、id 区间引用**：beat 的文稿范围 = `span:{from:"u0007",to:"u0011"}`（utterance id 区间），**绝不抄原句文字、绝不自造时码**（防 LLM 幻觉）。幻觉 id / 区间倒序 / 跨 beat 重叠 / `transcript_hash` 错版 → **硬拒、非 0 退出、零副作用**。
- **dropped 处理**：beat 的 span 内 utterance 全被剪 → 跳过该 beat 并入报告；部分被剪 → 按存活句包络收缩、标 `shrunk`。均不使命令失败。
- **transcript 缺失**（旧任务）→ 明确报错引导「用新版本重跑 oralcut（恒出 transcript）或 transcribe（规划中）」，不做降级猜测。
- **只动 `struct_meta.split`**：写回不碰 materials/tracks，配合客户端「保存 → 发起 → 写回 → 重载」闭环（opencut 联动）。
- **下游消费**：`dispatch.json` 的 `film_broll` 队列 → `gtrk matrix --project <dir>`（B-roll 双口检索 → `split/broll-plan.json` 候选清单;url 24h 过期,重跑即重签）；`mg` 槽位表（去品牌化前 `rrv_mg`）→ `gtrk mg` 铺轨 / real-roam-viz 产颗粒；`ai_drama` 队列 → ai-drama-prompter。

> **skill 分工**：拆 beat / 选 lane / 写 handoff 是脑（`gtrk-splitter` skill）的活；投影 / 校验 / 落地 / 写时码是手（本命令）的活。skill 铁律：只引用视图存在的 utterance id、不抄原文定位、不碰时码。

---

## 3. 产物结构 + 三端打开

```
<毛片名>-video-project-<YYMMDD-HHMMSS>/
├── gtrk/project.gtrk        → 客户端（OpenCut Gitruck Edition）：「打开工程」选它
├── jianying/                → 剪映：已自动拷进剪映草稿根，剪映里直接见草稿
│   ├── draft_content.json
│   └── draft_meta_info.json （仅当探到/指定了剪映草稿目录才有）
├── xml/premiere.xml         → Premiere Pro：文件 > 导入
├── <毛片名>.mp4             → 成片（仅 --render；本地 ffmpeg 按 gtrk EDL 渲染，云端不产成片）
├── result.json              → 机读结果清单（含完整 report；恒写、不受 --json 约束；可 gtrk oralcut-result 复现）
└── task.json                → 任务面包屑（taskId 等；submit 成功即写，供崩溃后按 task_id 恢复）
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
7. **有具体细节诉求**（剪不准 / 换语言 / 要成片 / 调某个停顿）→ 见上「细节微调」，按需自由取用（`--visual-assist` / `--lang` / `--render` / 散参数）；没特别诉求跑默认即可。

**跑完读 `report`、验证、给用户交代**（`--json` 的 stdout 那行带 `files` / `errors` / **`report`**；别只信"成功"、别谎报三端都好）：
- **读 `report`（因势象形的另一半）**：`duration_before`→`after`（剪了多少）；`script_source`/`final_script`（无稿 `rebuilt` 时把 `final_script` 回给用户核对）；`dropped[]`（剔了哪些、`reason` retake/misread）；`coverage`（<0.6 附 `low_coverage` = 文稿与实拍严重不符）；`uncovered_script[]`（**漏读**：文稿有、实拍没找到 → 如实说，疑似漏识别则建议 `--visual-assist` 重跑）；`review_points[]`（建议复核处）；开了 visual_assist 还有 `suspect_omissions` / `stt_recovered` / `visual_assist_degraded`。**据此因势象形**：覆盖率低 / 漏读多 → 开 `--visual-assist` 或核对文稿重跑；节奏不满意 → 调 `--preset` / 散参数重跑（同毛片可反复剪对比）。
- **报告也在盘上、丢了能取回**：同一份 `report` 恒写在 `<产物目录>/result.json`（不必依赖 stdout）。万一 stdout 没接住或进程崩了 → 直接读 `result.json`，或 `gtrk oralcut-result <taskId> --json` 按 task_id 重新取回，**不要重跑 `oralcut`**（见 §2.1）。
- 确认产物目录在、`gtrk/project.gtrk` 非空（>0 字节）；要剪映就确认剪映草稿根里有**同名工程目录** + `draft_meta_info.json`。
- 云端 `errors` 非空 → 如实告知哪个格式失败、原因。
- 然后**回给用户**：产物目录路径 + 三端各自怎么打开（客户端选 `gtrk/project.gtrk`、剪映已在项目列表、PR 导入 `xml/premiere.xml`），并**据 `report` 给一句交代**（剪了多久 → 多久、去掉了什么、有无漏读需复核）。

---

## 5. 典型调用

> 下面示例为聚焦某个参数、**省略了 `--json`**；你（agent）实际调用**一律带 `--json`**（见 §4），stdout 才只剩结果 JSON、便于解析。

```bash
# 有稿 + 剪完就看（最常见；剪完默认自动打开产物目录，无需额外 flag）
gtrk oralcut "D:/素材/某选题-原始口播.mp4" --script "D:/素材/某选题-文字稿.txt" --json

# 无稿、要最紧凑节奏
gtrk oralcut "D:/素材/某条.mp4" --preset compact

# 只要客户端工程，不碰剪映/PR
gtrk oralcut "D:/素材/某条.mp4" --formats gtrk

# 剪映装在非标准盘符，手动指目录
gtrk oralcut "D:/素材/某条.mp4" --jianying-draft-dir "F:/JianyingPro/User Data/Projects/com.lveditor.draft"

# 用户抱怨"剪掉了真内容 / 剪不准" → 开视觉兜底重跑
gtrk oralcut "D:/素材/某条.mp4" --visual-assist

# 细到某标点停顿 + 顺手渲一个成片
gtrk oralcut "D:/素材/某条.mp4" --params-json '{"punctuation_breaks":{"。":0.6}}' --render --crf 20
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
| 结果 JSON / 报告丢了（stdout 没接住、进程崩了） | 别重跑 → 读产物目录 `result.json`，或 `gtrk oralcut-result <taskId> --json` 按 task_id 取回 |
| 想换机器再拉产物 / 补渲成片 | `gtrk oralcut-result <taskId> [--out <目录>] [--render]`（须同账号 key；产物约 60 天有效，过期仍可取报告） |

---

## 7. 扩展（给改 CLI 的 agent）

新增命令 = 写 `src/commands/<name>.ts` 的 `register<Name>(program)` + 在 `src/index.ts` 注册一行。
云端调用走 `src/lib/cloud.ts`（`{code,msg,data}` 包装、鉴权 Header `Authorization:<裸key>`；单发取结果 `getTaskResult`、`pollTask` 复用之）；上传一律走 `src/lib/upload-cache.ts` 的 `uploadCached`（白嫖指纹缓存；≥256MiB 自动分片断点续传，见 `src/lib/chunk-upload.ts`）。本地预处理（探几何 / 抽音频 / 压 720p）在 `src/lib/media.ts`；本地渲染（gtrk EDL → ffmpeg filter_complex）在 `src/lib/render.ts`；三方产物落地 + `result.json` 两段写在 `src/lib/materialize.ts`（`oralcut` 与 `oralcut-result` 共用）。已上线：`oralcut`（云剪）、`oralcut-result`（按 task_id 取回）、`render`（本地渲染 gtrk）、`split`（视觉拆分派单器：`src/lib/projection.ts` 投影纯函数 + `src/lib/splitdoc.ts` 拆分稿校验/落地 + `src/lib/gtrk-writeback.ts` 原子写回 `struct_meta.split`，随包分发 `skills/gtrk-splitter/`）。`matrix`（B-roll 检索：`src/lib/matrix.ts` 双口路由/派单翻译/plan 构建 + `src/commands/matrix.ts`;`matrix search "<词>"` ad-hoc）。规划中：`struct`（已有 gtrk → 三方工程）。

### 工具族：接单点云能力 = 加一个 descriptor（不写编排）

单发单收的单点能力（图转运镜、图片/视频抠像…）不各开顶层命令，而入 `gtrk tool <name>` 工具族。骨架全归共享 runner `src/lib/tool-runner.ts`（校验 → 可选 preprocess → `uploadCached` → 提交前打印 `billingHint` → `submitTask`（6004 失效重传收编于此）→ 自循环轮询（复用 `getTaskResult`、墙钟 per-tool 可覆盖，**不改 `pollTask`**）→ `mapOutputs` **流式下载**落地（fetch body pipe 到 `createWriteStream`，大产物不过内存，**不用 `cloud.ts` 全内存 `download`**）→ `task.json`/`result.json` 面包屑）。差异全归一个薄 descriptor `src/lib/tool-descriptors.ts`（`name`/`kind`/`input`（含扩展名白名单、视频类 `maxDurationSec` 硬上限）/`taskType`/`buildPayload`/`mapOutputs`/`billingHint`/`options`/`enabled`+`disabledReason`/`pollTimeoutMs`）。

**接新工具 = 在 `TOOL_REGISTRY` 追加一个 descriptor 对象**（`tool list` 与分派自动生效），不新写命令编排。`--param`/`--params-json` 在 `buildPayload` 结果上逐字段合并覆盖。`cloud.ts`/`upload-cache.ts`/`chunk-upload.ts`/`media.ts` 只被复用、零改动。`list` 为保留字。工具长出多模式子命令 / SOP 检查点链 / 栏目风格注入时按 `mg`/`matrix` 先例毕业为独立命令。随包分发伞形 skill `skills/gtrk-tools/`（一个 skill 覆盖全族）。

**local 型（`kind:"local"`）首个实例 = `mad`（一键剪 MAD，add-tool-mad）**：无 Key 可跑、可选云端加料。cloud 型走共享 runner 全链，local 型（复杂度上限标尺）在 `tool.ts` 的 local 分支**分派到自己的 handler**（`src/lib/mad/mad.ts::runMad`），不套 runCloudTool。mad 的新逻辑全住 `src/lib/mad/`（数据获取层 `data.ts` = 云端 manifest `/task/mad/manifest` + `~/.gitruck/mad-cache` 版本感知缓存 + sha256 自愈；`selector.ts` 六维规则选窗 + 种子 PRNG；`beat.ts` downbeat 量化 + 三级降级；`pool.ts` IR 分片按需拉取；`scan.ts` 素材扫描；`cloud-beat.ts` audio_music_analyze 接线 + 6004 失效重传）与 `src/lib/convert/`（IR→JSX，含 `madJsx` 母合成拼接 + `bake_ops.ts` 时序算子烘焙）——`tool-descriptors.ts`/`tool-runner.ts`/`cloud.ts` 零改动（红线）。产物仅 `.jsx`／仅支持 AE。
