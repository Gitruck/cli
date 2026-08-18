---
name: gtrk-matrix
description: B-roll 检索铺轨编排手册——成片管线里第一个铺的车道（SOP ③ B-roll 底轨阶段的影视/本地素材腿），也是素材智能铺轨「乐高架构」的裁定层指引。消费拆分派单的 FILM_BROLL 队列（`dispatch.film_broll`），双口向量检索 + 下载 preview 代理，在工程里平铺 N 条候选 B-roll 轨，供用户在 opencut 里用轨道小眼睛切换对比、挑选/调整；确认后交棒同阶段的 AI 情景片段腿（`/gtrk-ai-drama`，车道非空时），三源落齐再进 ④ 全局抽帧检查构图、⑤ 才铺 MG。另支持**本地素材模式**（`matrix index` 建免切片索引、`--local` 本地检索铺轨，素材本体不上云）、**按需理解零件**（`matrix describe`：VLM 描述/标签/质量分/可用性信号，plan 注入或素材直理解）、**源时间窗检索**（`--source-window`，电影解说式逐段推进）与 **plan 可编辑通路**（agent 改 plan 后 `matrix lay` 消费）。当用户想「铺 B-roll / 检索素材 / 找空镜 / 给空镜配画面 / 填 B-roll 候选 / 单独搜个词补个空槽 / 用我自己的素材铺 B-roll / 给素材文件夹建索引 / 理解一下这些素材能不能用 / 把这堆素材剪成片 / 影视解说配画面」时使用本 skill。凡涉及把素材检索并铺进工程，优先用本 skill 驱动 gtrk CLI 的 `matrix` 命令族，别让用户自己去终端敲、也别手搓检索。
---

# B-roll 检索铺轨编排手册（gtrk-matrix）

把素材检索铺轨当**乐高**：CLI 提供原子零件（index / search / describe / plan / lay），你按场景裁定怎么编排——本手册给你六个起手配方、三条裁定判据、零件参数总表、plan 编辑口径与计费速查。**CLI 是手（检索/理解/下载/铺轨/写回），你是脑（裁定用哪个配方、管用户检查点、遇差调参补空）。**

> **本 skill 已含你需要的全部信息**，照它做即可，不用也无法去查外部文档。（`gtrk matrix --help` 也随时列全部 flag。）

## 四层架构与三条铁律（先立规矩）

```
裁定层（你）：按题材/素材形态/文稿有无/用户偏好，选配方或自创编排
配方层（本手册 §配方库）：原子命令的调用序列——只是起手式，可变奏可自创
原子层（gtrk CLI）：index / search(--local/--source-window) / describe / matrix(plan) / lay / tool image_move
服务层（云端）：embed 端点 / material_describe / 检索双口 / image_move
```

1. **零件不裁定**：原子命令不猜用户意图，行为全由显式参数决定。`describe` 出的 `usable_flags`（水印/字幕/黑边/模糊）只是**给你的信号**——CLI 永远不会依据它自动剔除候选，剔不剔由你编辑 plan 裁定。
2. **配方不进代码**：配方只活在本手册。遇到新场景，别等 CLI 发版——用现有零件拼。
3. **plan 是一等可编辑中间产物**：检索产 plan → 你改 plan（删候选/重排/删段/注理解/钉选）→ `matrix lay` 消费。这是你的裁定注入铺轨的**法定通道**（口径见 §plan 编辑口径）。

## 配方库 v1（起手式，可变奏可自创）

> 配方前置都一样：能跑 `gtrk` CLI；本地素材类配方先 `gtrk matrix index --dirs <素材夹>` 建索引。每条命令都带 `--json`。

### 配方 A · 纯匹配铺轨（默认主路）

- **适用线索**：文稿强（口播/解说已定）、素材净（策划过的素材夹或云端素材库）、节奏快、成本敏感。
- **命令序列**：
  ```bash
  gtrk split <拆分稿>                                   # ② 产派单
  gtrk matrix --project <目录> --json                    # ③ 检索+铺轨一步走（云端）
  # 本地素材版：gtrk matrix --local --dirs <素材夹> --project <目录> --json
  ```
- **变奏点**：`--lay N` 多候选轨；`--score-floor` 卡准入；`--top-k` 扩候选面；`--lay 0` 先出 plan 人审再 `matrix lay`。

### 配方 B · 匹配后理解铺轨（求稳/素材可信度存疑）

- **适用线索**：素材夹很「野」（下载杂片/相机胶卷，可能混着带水印、烧字幕、黑边、糊片）；高价值成片求稳；用户抱怨过「搜出来的像但不能用」。
- **命令序列**：
  ```bash
  gtrk matrix --local --dirs <素材夹> --project <目录> --lay 0 --json     # ① 只出 plan 不铺
  gtrk matrix describe --plan <目录>/split/broll-plan.json --top-k 5 --json  # ② 理解 top 候选，产物注入 plan
  # ③ 你读 plan 各 result.describe，裁定：剔除 usable_flags 命中且描述证实不能用的候选（删 result 条目）、
  #    按描述调顺序（重排）、把非留不可的候选标 pinned:true —— 直接编辑 plan 文件
  gtrk matrix lay --project <目录> --json                                  # ④ 消费你编辑后的 plan 铺轨
  ```
- **变奏点**：`--top-k` 控理解成本（1 积分/张，只理解你会认真考虑的那几条）；云端 plan 同样可 describe（帧从签名 url 现抽）；理解产物有本地缓存，反复迭代不重复扣费。
- **裁定要点**：`usable_flags` 是信号不是判决——结合 `desc` 复核（水印在角落的航拍也许仍可用）；剔除动作=从 plan 删掉那条 result，CLI 不会替你剔。

### 配方 C · 时间窗匹配（电影解说式）

- **适用线索**：解说顺序≈素材内时间顺序（影视解说、赛事复盘、长录像剪辑）——第 N 段解说该配影片第 N 段邻域的画面，全片乱配会剧透/错位。
- **命令序列**（逐段推进窗口，窗口推进是你的编排逻辑，CLI 不自动推进）：
  ```bash
  gtrk matrix index --dirs <影片所在夹> --json
  # 对解说的每一段（第 i 段，共 n 段，影片时长 D 秒）：
  #   窗口中心 ≈ D × (i/n)（解说进度比），半径 r 可调（起手 ±D/n 到 ±2D/n）
  gtrk matrix search "<该段画面描述>" --local --dirs <夹> --source-window <中心-r>,<中心+r> --out seg-i.json --json
  # 空窗（results 空）→ 你裁定：扩半径重试 / 接受留空 / 放弃时序约束去全片搜
  # 汇总各段命中，手工组一份 plan（结构照 broll-plan.json；每段一个 beat、track_st/ed=该段口播窗口）
  gtrk matrix lay --project <目录> --plan <你组的 plan 路径> --json
  #（可选）组 plan 前先 describe 一轮候选帮助取舍（配方 B ③ 的动作）
  ```
- **变奏点**：窗口公式只是起手——非线性叙事（倒叙/闪回）按你对片子的理解手排窗口；`--source-window` 与 `--score-floor` AND 叠加；窗口显式传入时图片候选自动排除（无时间轴）。
- **要点**：段边界不被窗口裁剪（有交集即完整返回），截多长归铺轨槽长逻辑；扩窗与否永远是你的裁定，CLI 绝不自动扩。

### 配方 D · 理解先行编剧（vlog 式，素材→文稿）

- **适用线索**：**没有文稿**、素材是叙事源头（「帮我把这堆素材剪成片」、旅行胶卷、活动跟拍）。查询不存在，无物可匹配——先理解素材，再由你编剧。
- **命令序列**：
  ```bash
  gtrk matrix index --dirs <素材夹> --json
  gtrk matrix describe --materials <素材路径列表> --json      # 全量或抽样理解（视频按场景抽帧、图片直传）
  # 你拿着逐场景描述编剧：大纲 → 章节 → 逐章旁白（与用户对话定基调）
  # 旁白定稿 → 走口播管线反填：oralcut/TTS 出口播 → gtrk split → 配方 A/B 反填 B-roll
  ```
- **变奏点**：素材多时先抽样（每夹几条）理解定大纲，定了再补理解入选素材；描述有缓存，二次编排零成本；`>20` 张会有计费确认（1 积分/张），先跟用户对齐预算。

### 配方 E · 三层层叠（企业动线）

- **适用线索**：本地素材不够填、需要栏目概念素材/通用素材补空洞；企业客户三源混用。
- **命令序列**（任意顺序，层序铁律自动保序 local > concept > common）：
  ```bash
  gtrk matrix --local --dirs <素材夹> --project <目录> --lay 2 --json        # 本地层
  gtrk matrix --project <目录> --column <id> --material-class concept --json  # 概念层（internal 矩阵成员口）
  gtrk matrix --project <目录> --json                                         # 通用层垫底填空洞
  ```
- **变奏点**：每层可独立换配方（本地层走 B 先理解再铺）；每层铺完停下让用户看（见「三条业务动线」节）；重铺某层不碰他层。
- **注意**：概念层重铺请走上面的检索命令（`matrix lay` 从 plan 推导层归属：local→local、云端→common，概念层信息不在 plan 里）。

### 配方 F · 图文混排

- **适用线索**：素材夹含大量剧照/海报/示意图；图片值得上轨（被选中时自动经云端 image_move 转运镜视频，2 积分/张）。
- **命令序列**：任意配方照跑——图片默认参与索引/检索/铺轨；`--no-image-broll` 反向排除（零图片上云）。
- **变奏点**：describe 对图片是文件直传理解；出域与计费口径见「图片候选运镜入轨」节——**图片本体会上云**这条差异必须跟用户说清。

## 裁定线索（判断素材，不是分支条件）

拿到一个活，先过三个判据。它们帮你**倾向**某配方，不是 if-else——边界情况跟用户对话确认。

1. **信息流方向**：成片从素材长出来（素材→文稿），还是素材服务既有叙事（文稿→素材）？
   用户给了完整口播/文稿/解说 → 查询存在，匹配主导（A/B/C）。用户只有一堆素材、叙事尚未诞生 → 无物可匹配，理解主导（D）。「先剪口播再配画面」是前者，「把这堆素材剪成片」是后者——同一个用户两天能各来一次，别拿昨天的路径套今天。
2. **素材可信度**：素材越「野」，理解的前置价值越大。策划过的素材（成片切片/精选夹/云素材库）→ 纯匹配直接吃（A）；下载杂片/用户随手拍（可能混水印、字幕残留、糊片）→ 匹配后理解过一道（B），甚至先 describe 全量过滤再谈其他。判断不了就问用户素材哪来的。
3. **规模 × 决策类型**：几十个镜头 → 描述装得进上下文，你直接读 describe 产物做编排；万级库 → embedding 粗筛必须先行（index/search），理解只花在 top 候选（B 的成本结构：O(候选) 而非 O(素材库)）。「找相似画面」→ 检索足矣；「排叙事/定取舍/避剧透」→ 必须理解物+你裁定（B/C/D）。

再叠两条场景特征：解说与素材同源（影视解说）→ C 的时间窗；素材夹里图片占比高 → F 的口径先交代。

## 零件参数总表

**检索/铺轨主命令**（`gtrk matrix`，云端派单消费为默认路）：

| 用户想要 | CLI 怎么传 | 取值 · 默认 | 说明 |
|---|---|---|---|
| 消费派单铺 B-roll（主路） | `gtrk matrix --project <目录>` | 目录 · — | 读 `split/dispatch.json` 的 `film_broll`，产候选清单 + 铺轨 |
| 单独搜个词（ad-hoc） | `gtrk matrix search "<词>"` | 字符串 · — | 单条检索；`--out <file>` 落盘或缺省 stdout |
| 显式指定派单文件 | `--dispatch <path>` | 路径 · 由 `--project` 推 | 非标准布局兜底 |
| 按某栏目检索偏好 | `--column <id>` | 栏目 id · config `defaultColumn`→内置默认 | 仅 internal 口生效 |
| 多铺几条候选对比 | `--lay <n>` | 非负整数 · `1`（`0`=只出 plan 不铺轨） | opencut 小眼睛切换对比挑选 |
| 每段多给几个候选 | `--top-k <n>` | 整数 · 派单 `shots` 值（服务端上限 50） | 每 query 候选数上限 |
| 指定素材类型 | `--material-class <c>` | `real_shot` \| `concept` · 栏目策略 | 仅 internal 矩阵成员口 |
| 填充门槛 | `--score-floor <f>` | 浮点 0–1 · `0.2` | 低于不采纳、槽位留空露黑底；调完必看空洞告警 |
| 不要黑底垫轨 | `--no-black-bed` | 开关 · 默认铺 | 黑底按 beat 包络整条铺，B-roll 期间遮口播 |
| 已编辑轨强铺逃生门 | `--force-relay` | 开关 · 关 | 用户明确点头才带；raw 登记删除不可恢复 |
| 同素材彻底不二用 | `--dedup-scope material` | `scene`（默认）\| `material` | 收严会加剧空洞，先看 `lay.dedup.emptySlots` |
| 机读（你必带） | `--json` | 开关 · 关 | 人读日志转 stderr，stdout 只出结果 JSON |

**本地素材零件**（`matrix index` / `--local`）：

| 用户想要 | CLI 怎么传 | 取值 · 默认 | 说明 |
|---|---|---|---|
| 给素材夹建索引 | `gtrk matrix index --dirs <a,b,...>` | 逗号分隔目录 · — | 免切片只记时间戳；指纹增量零重算；断点续传 |
| 本地检索模式 | `--local` | 开关 · 关 | 必配 `--dirs`；跳过身份探针、不触云端检索端点；与 `--column`/`--material-class` 互斥 |
| 圈定检索域 | `--dirs <a,b,...>` | 逗号分隔目录 · — | 检索域永远显式可见；绝不与云端结果混合 |
| **源时间窗过滤** | `--source-window <start,end>` | 秒，`start<end` · 不过滤 | 仅 `--local`：只返回与窗口**有交集**的命中段（段边界不裁剪）；与其他过滤器 AND 叠加；图片候选自动排除；**空窗 = ok 空结果非错误**，扩窗是你的裁定 |
| 场景切分粒度 | `--scene-threshold <f>` | 浮点 (0,1) · `0.3` | 仅 index：镜头切换快调高、长镜头调低 |
| 固定机位判稳阈值 | `--stability-threshold <f>` | 浮点 (0,1) · `0.05` | 仅 index：场景内最大帧间变化低于此值判 stable，抽帧收敛为**中点 1 帧**（60s 固定机位从 30 帧省到 1 帧）；summary 分列 stable/unstable 场景数与省帧数；误判 stable 丢检索粒度、误判 unstable 只是不省钱——**宁严勿松**；默认为保守值待标定 |
| 索引强制重建 | `--rebuild` | 开关 · 关 | 忽略指纹全部重算向量；**理解缓存（describes）不清** |
| 不要图片候选 | `--no-image-broll` | 开关 · 默认参与 | 检索与铺轨完全排除图片（零图片上云）；pinned 也不豁免这条 |
| 跳过计费确认 | `--yes` | 开关 · 关 | 图片运镜 / describe >20 张两处护栏通用 |

**理解零件**（`gtrk matrix describe`，三输入形态）：

| 用户想要 | CLI 怎么传 | 取值 · 默认 | 说明 |
|---|---|---|---|
| 理解 plan 里的候选 | `gtrk matrix describe --plan <path>` | plan 路径 · — | 对各 query 候选取 best 帧理解，产物注入 `result.describe` 后**回写 plan 文件** |
| 只理解前 N 条 | `--top-k <n>` | 整数 · 全部 | 每 query 限量（省钱：只理解会认真考虑的候选） |
| 直接理解素材文件 | `--materials <a,b,...>` | 逗号分隔文件 · — | 视频按**场景中点**逐帧理解；图片文件直传；结果在 stdout JSON `items` |
| 跳过确认 | `--yes` | 开关 · 关 | 将实际调用 >20 张才触发确认（预估积分明示）；internal 豁免免确认仅提示 |

理解产物形态：`{desc(≤200字中文描述), tags[], mark(0-100 质量分), usable_flags{watermark, text_overlay, black_border, blurry}}`。**缓存即钱**：产物按（素材, 帧时刻）落本地索引库，同帧重复 describe 零调用零计费；素材内容变了（size:mtime 指纹变）该素材缓存自动作废。

**plan 消费零件**（`gtrk matrix lay`）：

| 用户想要 | CLI 怎么传 | 取值 · 默认 | 说明 |
|---|---|---|---|
| 消费（编辑后的）plan 铺轨 | `gtrk matrix lay --project <目录>` | 目录 · — | 读 `<目录>/split/broll-plan.json`，白名单校验后按 **plan 现值**铺轨（不重新检索、零检索开销） |
| 显式指定 plan 文件 | `--plan <path>` | 路径 · 上述默认 | 配方 C 手工组的 plan 从这进 |
| 美观度参与排序 | `--mark-weight <w>` | 浮点 0–1 · `0`（关闭） | 仅 `matrix lay`：候选融合分 = `sim×(1-w)+(mark/100)×w`，mark 取 describe 理解缓存（素材内**就近帧**命中）；无缓存候选**中性**（融合分=sim，不惩罚不加分、绝不变相剔除）；score 地板仍只看原始 sim。**零件不裁定：默认关（0 时排序与产物逐字节零回归），开不开、开多大由配方/你裁定**——先 describe 过一轮才有 mark 可用（配方 B ② 之后开才有意义），开启时结果 JSON `lay` 含 `mark_weight/mark_hit/mark_neutral` |
| 其余铺轨参数 | `--lay/--score-floor/--no-black-bed/--force-relay/--dedup-scope/--yes/--no-image-broll` | 同主命令 | 语义一致 |

## plan 编辑口径（法定通道的边界）

`broll-plan.json` 你可以放心编辑，`matrix lay` 按现值消费，**绝不因「与原始检索结果不一致」拒绝**。但有白名单：

**可编辑面**（随便动）：
- `results` 数组：**删条**（剔除不能用的候选）、**重排**（调优先级——池内按 score 排序，重排主要配合删条用）；
- `segments` 数组：**删段**（某命中段不想要就删）；
- `result.describe`：增删（describe 命令注入的，你也可以手写笔记进去）；
- `result.pinned: true`：**钉选**——分配器优先满足（覆盖 score 排序、免 score 地板强制入选）。多个 pinned 冲突（同槽/供长不足）时**后到让位**，让位名单在结果 JSON `lay.pinned.yielded` 与告警里明示。注意 `--no-image-broll` 下图片候选连 pinned 也进不来（零图片上云是硬承诺）。
- beat 的 `per_shot_sec`/`requested_shots`（节奏锚，影响槽长档位）。

**不可编辑面**（动了会被 `matrix lay` 校验拒绝并指名字段）：
- `clip_id` / `local_path` / `url`：素材身份与来源是检索产出，改了必错（`local_path` 指向不存在的路径会被拒——可移动盘先挂载再 lay）；
- 几何字段（`duration`/`width`/`height`/`fps`）与 `segments` 内部几何（`best` 必须落在 `[start,end]`）；
- 结构形态（`plan_version`/`beats`/`queries`/`results` 的数组性、`pinned` 必须是布尔）。

坏 plan 的拒绝是**整单拒绝+逐条明示**（防误铺），改好重跑即可；plan 与已下载代理都还在，拒的只是这一步。

## 计费速查

| 零件 | 单价 | 计费形态 | internal 豁免 | 备注 |
|---|---|---|---|---|
| embed（`matrix index` 抽帧图） | **0.1 积分/张** | **会话计量**：开跑前按抽帧计划预扣 `ceil(N×0.1)`，跑完按实际用量结算多退少不补（用量>0 最低 1 积分） | ✅ gc_member_type=internal 免会话零计费 | **文本 embed 免费**——`--local` 检索本身零积分 |
| describe（`matrix describe`） | **1 积分/张** | **异步任务**（提交预扣→完成结算，失败自动退款），无会话 | ✅ 同上（豁免时 >20 张护栏免确认仅提示） | 缓存命中零调用零计费；>20 张确认护栏（`--yes` 跳过） |
| image_move（图片运镜入轨） | **2 积分/张** | 按任务计费 | **internal 不豁免、照常计费**（已查证：走标准任务计费链路无 gc_member_type 豁免；豁免只存在于 embed/describe 两个原子口） | 工程内同图同参恒复用不再扣费；铺轨前有预估确认（`--yes` 跳过，拒绝=整轮中止零调用） |

- 豁免看的是 **gc_member_type**（同合云内部成员），与检索档位 `matrix_member_type` 是两个维度——`memberType:"internal"`（检索口）≠ 计费豁免，别混。
- 量级参考：全量索引 5000 帧 ≈ 500 积分 ≈ 5 元；describe 50 张候选 = 50 积分；增量都只按新增算（索引指纹增量、理解缓存命中）。

## 你在成片管线里的位置（SOP 第 ③ 步 · B-roll 底轨阶段的影视/本地素材腿）

成片是**有序 SOP + 用户检查点**，不是并行一次铺完。全链：

> ① `oralcut` 剪口播 → ② `split` 拆分派单出 `dispatch.json` → **③ B-roll 底轨全铺齐**（**`matrix` 铺影视/本地素材（你在这）** + `/gtrk-ai-drama` 产稿→外部出片→用户手动回铺，**两条腿同一阶段**）→ **用户 opencut 调整/挑选** → ④ **全局抽帧检查画面构图** → ⑤ `mg` 铺 MG（含 ov，最后叠上）→ `render` 收口。

**为什么 B-roll 整个阶段最先**：**AI 情景片段属于底轨 B-roll 画面家族，不是叠加层**——叠加层只有 MG（含 ov）。MG 的排版决策是「因势象形避主体」，**依赖底轨的最终画面构图**；三源（影视/本地/AI）没落齐就产 MG，等 AI 片段回铺后避让必然错位、甚至盖住 AI 画面主体。

> ⚠️ 旧序（MG ④ 在 AI 再现 ⑤ 之前、理由写「越往后叠得越上层」）**是把「工序次序」误当成了「图层次序」**。工序上 AI 片段必须先落位；图层上它本来就在底轨。

铺完**必须停下等用户在 opencut 里挑选/调整**（关键检查点），不要一口气往下冲。

**前置**：需要跑过 `gtrk split` 的产物目录（`split/dispatch.json`）。`film_broll` 空 = 本片没有影视/本地素材腿 → 跳过本步，看 AI 情景片段腿（`dispatch.ai_drama` 非空则交棒 `/gtrk-ai-drama`），两腿都空才直接进 ⑤。`gtrk` 找不到 → `npm i -g @gitruck/cli@latest`。用户先在 opencut 手调过切点也不怕——命令每次都现场重投影 beat 窗口，微调口播轨不用重跑 `gtrk split`，只有拆分稿本身变了才要。

**业务分离**：本框架 skill 不硬编任何栏目审美。B-roll 的 `queries` 在 ② 拆分时已写进派单（不触发生产 skill）；栏目只供检索偏好（`--column`，internal 口生效）。档位由命令自己探（结果 JSON `memberType`），external 口固定 real_shot+有版权素材。

## 本地素材检索模式要点（`--local` / `matrix index`）

- **视频素材本体永不上云**：只把 512px 抽帧图送同合云自建 embed 端点向量化、即传即弃；产物以绝对路径直引原文件（免下载免代理，无 url 签名/过期语义）。
- 图片一视同仁可检索可铺轨（`kind:"image"`）；被选中时经云端 `image_move` 转运镜视频入轨（**图片本体会上云**，见下节）。
- 两步走：`gtrk matrix index --dirs <a,b> --json` 建索引（增量零重算）→ `gtrk matrix --local --dirs <a,b> --project <目录> --json` 检索铺轨。
- **score 地板观察（重要）**：本地域 score 量纲与云端不同，完美命中可低至 0.246——默认 `0.2` 是松地板，排名靠查询内相对顺序。**别按云端直觉调高**（0.3 可能把正确命中砍光）。
- 索引跨机不可移植（键=绝对路径）：换机重跑 `matrix index` 即可（分钟级）；素材改名/移动身份不变（内容哈希）。
- 含本地 B-roll 的工程云渲会被提交口直接拒绝（`local_broll_cloud_render_rejected`）——走客户端本地出片或 `gtrk render`。
- embed 端点连不通（`embed_endpoint_unreachable`）：查 `~/.gitruck` config `embedUrl` / env `GITRUCK_EMBED_URL`；describe 端点同理（`describe_endpoint_unreachable`，`describeUrl` / `GITRUCK_DESCRIBE_URL`）；CLI 绝不回落第三方端点。会话失效（6033）重跑即自动重开续跑。

## 图片候选运镜入轨（出域口径必读）

- **图片本体会上云**：图片候选被选中时经云端 `image_move`（GPU 运镜）转短视频——与视频素材「本体不上云」不同，跟用户交代本地模式时必须说清这条差异。不愿图片上云 → `--no-image-broll`。
- **计费**：2 积分/张，铺轨前汇总确认（`--yes` 跳过；拒绝=整轮铺轨中止零云端调用，`reason:"image_move_billing_declined"`，plan 照常可用）。
- **缓存零重复计费**：产物落工程 `assets/broll-move/`（材料 id=`broll-local-<图hash>-mv<参数指纹>`），同图同参恒复用；跨工程会重新生成。
- **参数定死统一档**：duration 恒 5s（槽长 >5s 取 ceil，钳 [2,12]）、画布=工程 video_size、入轨按槽长裁剪——统一档就是为了缓存命中与重铺画面不跳。
- **失败降级=静态图片上轨**（不换内容不留黑），明细在 `lay.image_move_failures`；重铺自动重试运镜。
- **读结果**：`image_move_billing:{generated, reused, estimated_credits}`——`generated` 非零要如实告诉用户扣了多少积分。

## 三条业务动线与层序铁律（多源分批铺轨必读）

**层序铁律（写死，无配置项）**：B-roll 轨按来源分三层带，渲染遮挡自上而下恒为 **本地（local）> 栏目概念（concept）> 通用（common）**，与铺轨先后无关。换层重跑他层轨号整体平移是预期行为，内容零扰动。

**不二用与宁空不重复（防审美疲劳铁律）**：单轮铺轨一个素材单元全局只用一次（云端按切片、本地视频按场景、图片按文件；`--dedup-scope material` 收严）。候选枯竭宁空不重复（留空走黑底），空洞数在 `lay.dedup.emptySlots`。**跳剪豁免**：同素材相邻槽位只有源画面头尾差 <2s 才避让；≥2s 属合法叙事照铺（`lay.dedup.adjacentWaived` 记枯竭放行数）。

**三条动线（分批执行，每层铺完停下让用户看）**：
1. **只铺本地**（个人创作者主线）：`--local` 铺 → 看效果 → 调参重跑，重铺只剥本地层。
2. **本地打底 + 通用垫底填空洞**：本地先铺（`--local --lay 2`）；空洞多 → 不动本地层，补跑一轮云端通用检索，自动垫到本地层之下。
3. **企业级三层**：即配方 E。

存量工程首次重铺的过渡口径：层带引入前的旧自产轨没层登记——`broll-local-` 前缀轨自动归 local 照剥；其余保守不剥并告警（指名 track_index）。

## 执行（每次都带 `--json`）

> **产物落点纪律（MUST · 全文见随包 `AGENT.md` 同名一节）**：一切产物只落**工程目录**或**用户显式指定的输出路径**；**MUST NOT** 把成片/预览/素材复制到 agent 自有工作目录——引用媒体用原路径；临时文件放系统 temp 用完即删。违者后果=用户系统盘被静默吃满（真机事故）。

```bash
gtrk matrix --project "<split 产物目录>" [--lay N] [--score-floor F] [--top-k K] [--column <id>] --json
```

- `--json`：人读日志走 stderr，成功时 stdout 只有一行结果 JSON：
  `{ ok, mode:"plan", memberType, columnId?, planPath, lay:{ refused, laidTracks:[…], laidClips, removedTracks:[…], keptEditedTracks:[…], blackTrack, blackBedHoleSec, blackBedHoles:[…], dedup:{scope,emptySlots,adjacentWaived}, pinned?:{requested,placedSlots,yielded}, downloads:{preview,raw,reused,failed} }, integrity:{…}, reprojection:{…}, counts:{ beats, queries, results, errors } }`
  （`--lay 0` 时无 `lay`；`search` 模式 `{ ok, mode:"search", results:[…], counts, outPath? }`；`matrix lay` 模式 `mode:"lay"` 且 `counts.queries` 恒 0——零检索；`matrix describe` 模式 `{ ok, mode:"describe", described, cached, called, failed, credits_estimated, exempt?, planPath?/items? }`）
- **拒铺结局**（候选轨已被用户编辑）：stdout 出 `{ ok:false, refused:[…], reason:"tracks_edited", planReusable:true, … }` 且非 0 退出——不是命令失败，plan 已产出，处置见下表。
- **命令失败**（缺派单、鉴权失败、全部 query 失败、参数越界、坏 plan 被 lay 拒）→ 非 0 退出、报错在 stderr、stdout 无 JSON。先看退出码，把 stderr 报错如实回给用户。
- 检索分钟级，耐心等返回。

## 跑完读结果、给用户交代

读 stdout 那行 JSON（字段按需读、读前判空），别只回「铺好了」：

- `counts`：几个 beat、几条检索（几条失败）、几条候选——一句话概括盘子大小。
- `memberType`：internal=矩阵成员口（栏目偏好/concept 生效）；external=通用口（固定 real_shot 有版权）。
- `lay.laidTracks` / `lay.laidClips`：铺了几条候选轨、几个颗粒（不含黑底轨）。
- `lay.blackTrack`：黑底垫轨轨号（未铺时 null）。
- `lay.blackBedHoleSec` / `lay.blackBedHoles`：**黑底空洞**（纯黑压口播时段），恒全量不按阈值过滤——非零就主动报（哪个 beat、几秒、在哪），这是粗剪期既定取舍不是故障。
- `lay.removedTracks` / `lay.keptEditedTracks`：剥了哪些旧自产轨 / 因「你编辑过」保留未剥的轨。删了什么必须跟用户说。
- `lay.dedup`：`emptySlots`（宁空不重复的空槽数——多了是该补料或走动线②的信号）、`adjacentWaived`。
- `lay.pinned`（有钉选才出现）：`requested/placedSlots/yielded`——`yielded` 非空要指名哪些钉选让位了（stderr 也有告警）。
- `lay.downloads`：`raw` 原片回落 / `failed` 掉槽位非零时提一句。
- `integrity`（素材落盘自检，只在真写回过时出现）：`dangling` 悬空引用全量清单；`danglingReferenced`（时间线上没素材可放）与 `danglingOrphan`（只挂在 materials 里）严重度差一个量级，**分开说**；`external` 绝对路径找不到文件另一档。告知不拦阻，别自己删素材。
- 单 query 失败是局部化的（`counts.errors>0` 但 `ok:true`）：如实说哪几段没检到。
- 工程缺失/非 v1 → 告警跳过铺轨但仍产 plan（`lay` 字段缺失）。
- `reprojection.degraded:true` → 已降级至派单快照时码，照 `reason` 给出路（transcript 补回 / 工程放回 / 用户接受快照就照跑但要说明位置可能偏了）。
- describe 结果：`called` 非零如实报扣了多少积分（1 积分/张）；`cached` 命中说明零计费；`failed` 非零说明哪些帧没取到。

## 关键检查点：让用户在 opencut 里挑选/调整（别跳过）

**这是本步的核心，不是可选收尾。** 铺轨产出的是多条并列候选轨，不是定死的成片。铺完必须提示并**停下等确认**：

- 在同合云桌面客户端（opencut / OpenCut Gitruck Edition）里打开工程，候选轨已铺好。
- 用轨道头「小眼睛」逐条切换对比，留满意的、关不要的。
- 候选默认是 preview 代理；下载原片属挑选后的动作（客户端挑选 UI）。
- 候选轨下方垫了纯黑底轨（`lay.blackTrack`）——删多余候选轨时**别误删它**；换片拖到**候选轨颗粒**上、别拖到黑底条上（0.2.10 起客户端会拒绝并提示；旧版会静默建轨——用户说「拖了没反应」先让他重启客户端吃强更，再查轨道数，`Ctrl+Z` 整条撤销）。**MUST NOT 对旧版客户端用户承诺「客户端会拒绝并提示」**。
- 觉得填充有问题（太杂/太空/漏段）→ 回来找我调参重铺（配方 B 的理解裁定也在这时上场）。

**用户明确说「B-roll 就这样」之后**，才往下走——先看 AI 情景片段腿（同属 ③），三源齐了再进 ④ 全局抽帧检查，过了才交棒 ⑤ 铺 MG。详见末节「下一步」。

## 常见情况处置（据结果因势象形调整，同目录可反复重跑对比）

| 情况 | 怎么做 |
|---|---|
| 想在多个候选里挑 | `--lay N` 多铺几条候选轨。**只增加可选方案数，不扩大覆盖**——别把它当空洞的解药 |
| 填充太差 / 命中太杂 | 先看排序前几条质量再调 `--score-floor`（调高留空处露黑底，必看空洞告警）；杂得可疑 → 走配方 B：describe top 候选，按 `usable_flags`+`desc` 剔除后 `matrix lay` |
| 「像但不能用」（水印/字幕/黑边混进候选） | 配方 B 的标准场景：`describe --plan` → 你删掉命中的 result → `matrix lay`。**CLI 不会自动剔**（零件不裁定），删不删你判断 |
| 某候选非用不可 / 顺序想钦定 | 编辑 plan：该 result 标 `pinned:true` → `matrix lay`。`lay.pinned.yielded` 非空说明钉多了在打架 |
| **出现黑底空洞告警** | 不是故障：照 `lay.blackBedHoles` 逐段报给用户，出路=调低 `--score-floor` / `--no-black-bed` 露主轨 / opencut 手动补片 / 动线②云端垫底 |
| 每段候选太少不够挑 | `--top-k` 调大重跑 |
| 某段有空槽 / 想补特定意象 | `gtrk matrix search "<英文长句场景描述>" --project <目录> --json` 单条补检；影视解说类补检记得带 `--source-window` 保时序 |
| 只想先看清单不铺轨 | `--lay 0`（只产 plan）；之后铺 = `matrix lay`（不重新检索、不重新烧配额） |
| **报「候选轨已被你编辑过」拒铺** | 保护不是故障：工程零改动，plan 照常产出。① opencut 处置那条轨后重跑；② 用户明确点头 → `--force-relay`（raw 登记删除不可恢复，先说后果） |
| **`matrix lay` 报「plan 校验未通过」** | 你把不可编辑面改坏了（报错逐条指名字段）：按 §plan 编辑口径改回来重跑；`local_path 路径无效` 多半是可移动盘没挂载或真把路径改了 |
| 报「本地索引不存在」 | 先 `gtrk matrix index --dirs <...>`；已建过则查 `--dirs` 与建索引目录是否一致、可移动盘是否挂载 |
| 换电脑用不了索引 | 索引跨机不可移植（本机缓存），新机重跑 `matrix index` 即可 |
| 预览看不了 / 想「重签」 | 别为此重跑铺轨：`preview_url`/`cover_url` 不带签名不过期；带签名 24h 过期的是原片 `url`，由客户端「确认原片」重签 |
| raw 原片回落 / 体积大 | 提示用户；服务端 backfill 后重跑可换回轻量代理 |
| `reprojection.degraded:true` | 不是故障：命令算不出当刻窗口退回快照。`transcript_missing` → 补回 transcript.json 或新版 oralcut 重出；`no_project`/`gtrk_unreadable` → 工程放回位或 `--project` 指对 |
| 期望 concept 却报 external 限制 | 如实说明当前身份只出 real_shot 有版权素材，concept 需矩阵成员口 |
| describe 报 `describe_endpoint_unreachable` | 服务端未上线/网络/配置指错：查 `describeUrl` / `GITRUCK_DESCRIBE_URL`；缓存与 plan 都在，修好重跑。describe 走异步任务（提交后轮询取结果）：任务提交成功后即便中途断网结果也不丢（服务端照跑），可重新轮询/稍后重跑取回；上游失败服务端自动退款，只需重跑 |

> **搜词规范**（ad-hoc `search` 与理解派单 queries 通用）：英文长句场景描述（5–12 词，谁+在哪+做什么），一条只装一个场景意象，避多义/字面强的动词（"pointing"/"hunting" 会召回特写/猎人，改用 "giving suggestions in a meeting" 这类场景语义）。

## 下一步（别停在铺完，也别直接跳去铺 MG）

用户确认你这条腿的 B-roll 满意后，**先看 AI 情景片段腿有没有活**——它与你同属 ③ B-roll 底轨阶段，MUST 在 MG 之前落位：

- **`dispatch.ai_drama` 非空** → 交棒 `/gtrk-ai-drama`（产分镜稿 → 用户去外部平台出片 → 手动回铺）。一句话交代：「影视素材这腿定了，AI 情景片段还有 N 段要出，我把分镜稿产出来给你」。
  ⚠️ **异步等待的口子**：外部平台抽卡可能数天，严格串行会把后续无限期卡住。故进 ⑤ 的硬门是「**AI 片段已回铺 ∨ 用户明示先跳过**」。走「明示跳过」时 MUST 把**与 AI beat 相邻或重叠区间的 MG 颗粒**标记为「AI 回铺后待复查构图」并在收口时复述该清单，**MUST NOT 静默跳过**。
- **`dispatch.ai_drama` 为空** → 三源已齐，直接进 **④ 全局抽帧检查画面构图**：对最终底轨抽帧看主体位置 / 安全区 / 画面朝向 / 明暗，**停下等用户确认构图无误**（这与刚才「挑选 B-roll」那次确认是两次不同的确认），过了才交棒 ⑤ `/gtrk-mg`。
- `dispatch.mg` 也为空 → 无 MG 车道，④ 检查过后直接 `render` 收口。
- 用户表示暂时只要 B-roll → 停在这，尊重他的节奏。

> 原则：**agent 替用户跑 CLI / 接力 skill，用户只对话**——别让用户自己去终端敲下一条 gtrk 命令；但关键检查点务必停下等用户确认再进下一步——本车道涉及**两处**：① B-roll 铺完让用户挑选/调整；② ④ 全局抽帧检查后让用户确认构图。
