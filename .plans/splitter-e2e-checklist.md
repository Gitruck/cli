# Splitter 端到端真机联调清单（2026-07-08）

> 一条链验三仓：infra `add-oral-cut-transcript-output` 5.1 · cli `add-splitter-integration` 5.3 · opencut `add-gtrk-reload` 3.2/3.3。
> 每步的断言打勾；任何一步失败 → 截图/贴 CLI stderr 给 Claude 当场修，不必继续往下。

## 准备

- [ ] 真口播毛片一条（几分钟即可，带口误/停顿更好——能看出剪辑与 dropped）
- [ ] 生产 API Key 已配置（`gtrk` 当前登录态指向生产）
- [ ] 本地 CLI 为联调版本（cli 仓最新构建）；opencut 客户端跑最新代码（dev server 或打包版）

## Step 1 · oralcut 全链（infra 5.1：transcript 生产首验）

```bash
gtrk oralcut <毛片路径> [--script <稿子.txt>]
```

- [ ] 任务 completed；产物目录含 `gtrk/project.gtrk` + report + `transcript/transcript.json`
- [ ] GET 产物 `files[]` 含 `{type:"transcript", format:"json"}`（CLI 输出/oralcut-result 可见）
- [ ] `transcript.json`：`version:"v1"`；`material_id` 与 `project.gtrk` 的 `materials[].id` 同值；`utterances[].words[]` 为源时基秒（3 位小数）
- [ ] 任务 `errors` 中**无** `"transcript"` 键
- 记录：transcript 文件大小 ______ KB；utterances 句数 ______

## Step 2 · 客户端手调切点（投影跟随的前置）

- [ ] opencut「打开工程」载入 `project.gtrk`
- [ ] 手调 2–3 处并记住改了哪：①拖短某颗粒（剪掉几个字）②拉长某颗粒恢复一段被剪内容 ③挪一颗粒顺序（顺带验主轨磁吸）
- [ ] 「保存工程」写回 .gtrk（客户端保持开启，Step 5 要用）

## Step 3 · split 视图 · 投影跟随（cli 5.3 核心）

```bash
gtrk split --project <工程目录> --json
```

- [ ] `split/view.json` 生成，`transcript_hash` 透传在内
- [ ] **投影跟随**：①拖短处对应句 `kept_words` 减少或 `dropped`②恢复段句子出现且 words 投影存活（即使源 `kept=false`）③挪序处 `track_st` 随新位置
- [ ] 抽 2 句对时间：view 的 `track_st/track_ed` 与客户端时间线目测一致（±0.1s 级）
- 记录：view 句数 ______；dropped 数 ______

## Step 4 · 拆分落地

方式任选：A) Claude 里跑 `gtrk-splitter` skill 全链产拆分稿；B) 手写 2-beat 小拆分稿（**只引用 view.json 里真实 utterance id**，hash 从 view 继承）。

```bash
gtrk split <拆分稿.json> --project <工程目录> --json --md
```

- [ ] 校验通过零重试（或按 error 修正 ≤3 轮——记录轮数 ______）
- [ ] `.gtrk` 写回 `struct_meta.split`（原子写，含 `transcript_hash/projected_at/beats[]`）
- [ ] `split/dispatch.json` 生成（composition_id = `<工程slug>-<beat_id>`）；`--md` 人读稿生成
- [ ] 抽查 `.gtrk` 其余键不变（materials 数、轨道数与 Step 2 保存后一致）

## Step 5 · 客户端外部更新重载（opencut 3.2 三分支）

**A 干净态**（Step 2 已保存、无未存修改，Step 4 的写回已发生）：
- [ ] 客户端感知外部更新并重载，toast「工程已被外部更新，已重载」
- [ ] `struct_meta.split` 内存态完整：客户端再点一次「保存工程」→ 文本查 .gtrk **仍含 `struct_meta.split`**（不被剥掉）

**B 脏态 · 放弃重载**：客户端随便改一下**不存** → 再跑一次 Step 4 落地（CLI 写回）→ 提示条出现：
- [ ] 选「放弃我的更改并重载」→ 外部 split 内容保留、自己未存修改丢弃

**C 脏态 · 保留编辑**：重复 B 制造脏态+外部写回 → 提示条选「保留编辑」→ 点「保存工程」：
- [ ] 覆盖二次确认弹出（明示会覆盖外部写入如 struct_meta.split）→ 确认 → 磁盘被内存态覆盖（符合预期）

## Step 6 · 重载性能与缓存（opencut 3.3）

- [ ] 重载后波形/缩略图**即时出现**（无重解码等待 = 按 material id 复用缓存）
- 记录：重载耗时体感/console ______ ms；素材数 ______

## Step 7 · 双击打开收尾（cli 5.3 尾）

- [ ] 关客户端 → 双击 `.gtrk` 打开 → 工程正常载入、`struct_meta.split` 存活无报错

## 全部通过后

1. cli `npm publish` 发版（cli 5.4）→ `gtrk skills install` 更新 skill
2. 三仓 dogfood 计时 24–48h（infra 5.2 观察 errors["transcript"] 出现率 / cli skill 修正循环率 / opencut 重载误报漏报）
3. 无异常 → 三仓 change 全部 archive；期间 Claude 起草 B-roll（`gtrk matrix`）propose

---
## 真机执行记录（2026-07-08 夜）

### Step 1 · oralcut 全链 ✅（infra 5.1 通过）
- **首跑发现 infra 未部署**：云端 `output_result.files[]` 只返 4 条 `type:project`（xml/剪映×2/gtrk）、零 transcript、`errors:{}` 空 → transcript producer 未在生产 Worker 运行（§5.1 未做）。主理人补部署后重跑。
- **重跑通过**：task_id `89145790499688454`，产物 `回声定位-...-260708-230631`。`json ← transcript.json` 已拉回。
- transcript 结构：v1 / oral_cut / user、186 句 u0001–u0186、字级源时基秒、kept 148·dropped 38、duration 928.752；**material_id 88269616210305030 == gtrk materials[].id ✅**（投影 join 键对齐）。
- ⚠️ 观察：transcript 落 `json/transcript.json`（materialize 按 format=json 分组），非 split help 所述 `transcript/`；但 `split --project` auto-locate 能找到，功能无碍。留作口径一致性备忘。

### Step 3 · split 视图基线 ✅（cli 5.3 前半）
- `gtrk split --project <dir> --json` → `split/view.json`：207 投影（169 live/38 dropped）；`transcript_hash 46d66bbb` 与 transcript text_hash 一致（hash 链完整）；track_st 已投影到轨道时基。这是「已剪好成片」基线。

### 待续（需主理人在客户端操作）
- Step 2 手调切点 → Step 3 复跑验投影跟随 → Step 4 拆分落地 → Step 5 重载三分支。

### Step 4 · 拆分落地 ✅（cli 5.3 后半）
- gtrk-splitter skill 全链：view → 27-beat 拆分稿（A_ROLL 13/RRV_MG 7/AI_DRAMA 3/FILM_BROLL 4）→ `gtrk split <稿> --project --md --json` **一次校验零重试**。
- `struct_meta.split` 写回 .gtrk（27 beats + hash 46d66bbb + projected_at + shrunk:9）；`dispatch.json`（composition_id=`<slug>-B06` 打通）；`visual-split.md` 14KB。跳过 0、收缩 9（span 夹了被剪句、按存活包络收窄，正常）。

### Step 5-A · 干净态自动重载 ✅（opencut 3.2 核心）
- toast「工程已被外部更新，已重载」；工程一致；客户端保存后 **struct_meta.split 存活**（27 beats 不被剥），且与客户端自加的 `nle_draft_dir` 共存 → round-trip 保留外部元数据 ✅。

### Step 5-B · 脏态放弃重载 ✅
- 提示条「工程文件已被外部更新」+ 保留编辑/放弃并重载；点放弃 → 脏改动丢弃、载入外部态，符合预期。
- ⚠️ **体验待办（已记 task_1551eae2）**：自动重载后时间线缩放/播放头被重置为默认；期望保持重载前视口状态（只换轨道不动视口）。后续单修。

### Step 5-C · 脏态保留编辑+覆盖确认 ⚠️ 被 UI bug 卡住 → 已修源码
- **真机逮到 bug**：脏态提示条外层 `fixed inset-x-0 top-0 z-[110]` 全宽透明容器拦截了顶栏「打开/保存/另存/重载」按钮点击（toast 盖热区），导致点不动「保存工程」、无法触发覆盖确认。
- **修复**：`external-reload-watcher.tsx` 外层加 `pointer-events-none`、可见条加 `pointer-events-auto`（透明区放行、条可点）。**待客户端刷新/重构后复验覆盖确认弹窗**。
