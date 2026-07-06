## Context

`gtrk oralcut` 闭环当前把机读结果（含剪辑 `report`）只在 `--json` 下经 stdout 输出一次、不落盘（`src/commands/oralcut.ts:308-323`，`runOralCut` 全程无 `writeFile`）。`outDir` 在任何云端动作前就 `mkdir`（`:146`），首次真正写入却要等下载循环（`:247`）。`task_id` 只经 `log.info`（`:231`，`--json` 下走 stderr）与最终 JSON 露出。

后端侧已确认（逐行）：`GET /task/cli/video_oral_cut_for_cli/<task_id>` → `get_task_by_id`（`services/task_services.py:193-269`）是幂等纯 DB 读，返回持久化的 `output_result = {report, files[], errors}`——正是 `pollTask` 每 5s 打的同一 URL（`src/lib/cloud.ts:129`）。`download_url` 是无签名、确定性、内容寻址静态路径（`upload_services.py:174-188`），窗口内可反复取；底层文件 60 天 GC（`FILE_EXPIRE_DAYS=60`），但报告 JSON 存于任务行、不受此限。离线渲染自足于 gtrk（几何 `video_size/video_rate` 与剪切点 `clip_st/duration` 均内嵌，`render.ts:118-120,155-159`），只需 gtrk + 原毛片仍在 `materials[].path` + ffmpeg；且 `gtrk render <gtrk>` 已存在（吃本地 gtrk 路径、不认 task_id）。

## Goals / Non-Goals

**Goals:**
- 报告永不因 stdout 路由而丢失：跑批恒把 `result.json` 落到产物目录。
- 按 `task_id` 秒级恢复：新增 `gtrk oralcut result <taskId>`，取回报告 + 产物（可选重渲），零云端重跑。
- 失败卫生：预下载失败不再留空壳目录；提交后崩溃留下 `task.json` 可恢复指针。
- 零后端改动；复用既有下载/分组/剪映/渲染代码路径。

**Non-Goals（本轮明确不做）:**
- `--json` 失败时向 stdout 吐机读错误信封（#4）。
- `download()` 改流式 + 重试（#5）。
- `--source` 重定位已移动的毛片（#6）。
- 顶层通用 `gtrk result <taskId>`（跨任意 task 类型）——本轮只做 oralcut 归属的子命令。

## Decisions

### D1. 抽出 `getTaskResult(cfg, taskType, taskId)`，`pollTask` 复用
把 `pollTask` 循环内联的 GET + 解包（`cloud.ts:127-142`）提成单发导出函数，返回**完整** `{status, progress?, output: OralCutOutput}`（`pollTask` 目前只返回 `output_result`、丢弃 `status/progress`；恢复命令需要 `status` 判「是否完成」）。`pollTask` 改为循环调用它。
- 备选：恢复命令里另写一遍 GET（否决——与 `pollTask` 漂移、双份鉴权/解包易出错）。

### D2. 命令形态 `gtrk oralcut result <taskId>`
`oralcut` 既有形态是 `program.command("oralcut <input>")`。为兼容既有 `gtrk oralcut <input>` 又挂上 `result` 子命令，把 `oralcut` 建为带**默认参数 + 子命令**的命令组：父命令 `.argument('[input]')`+`.action(runOralCut)`，子命令 `.command('result <taskId>')`。commander 优先派发已注册子命令名。
- 风险：当毛片位置参数恰好等于字面量 `result` 时产生歧义——毛片是带扩展名的文件路径，冲突几率可忽略，design 记录、apply 时验证。
- 备选：顶层 `gtrk oralcut-result <taskId>`（连字符）作为**兜底**，若 commander 嵌套在实现中不稳则回退；用户已选定空格形态，优先按 D2 落地。
- 备选：`--from-task` flag（用户已否决）。
- **落地（apply 实测 commander@12）**：父命令 `oralcut` 与子命令 `result` 的**同名选项**（`--out`/`--json`/`--render`/`--no-open`…）会被父命令吞掉——路由正确（`result` 子命令能派发）但选项不绑定到子命令。故采兜底：命令改为**顶层 `gtrk oralcut-result <taskId>`**（`registerOralCutResult(program)` 一行注册，选项绑定干净、无父子冲突）。spec 与 README 均以 `oralcut-result` 记述。

### D3. `result.json` 两段写
在 `pollTask` 返回后、下载循环前**先写一版** `result.json`（`{ok,outDir,taskId,fileId,report,files,errors}`），下载/渲染完成后**再补写**解析出的本地路径（`byFormat/jianyingDraftPath/rendered`）。目的：报告能扛住其后的下载/渲染失败。
- 备选：仅结尾写一次（否决——晚段失败即丢报告）。

### D4. 抽出共享落地函数 `materializeResult(...)`
把「按 `baseFormat` 分组下载 + 剪映拷贝 + 可选 `renderGtrk` + 写 `result.json` + `--json` 输出」这段（现 `oralcut.ts:241-323`）抽成共享函数，供 `oralcut` 与 `oralcut result` 两条路径复用，避免复制粘贴漂移。
- 备选：恢复命令里拷贝该段（否决——两处维护）。

### D5. 延后 `outDir` 建目录 + 面包屑落盘位置
去掉 `:146` 的 eager `mkdir(outDir)`；改为写入方各自 `mkdir(dirname, {recursive:true})` on-demand（下载循环已按格式 mkdir；`task.json`/`result.json` 写时 mkdir）。净效果：**提交前**失败 → 不建目录（不留空壳）；**提交后**失败 → 目录存在且含 `task.json`（可恢复的面包屑，而非空壳）。

### D6. 恢复命令的 outDir 默认与成片命名
`output_result` 只带 `{report,files,errors}`、不含毛片名。恢复命令 `--out` 缺省用 `<cwd>/<taskId>-video-project-<时间戳>`；`--render` 时成片名取 gtrk 内嵌 `materials[].path` 的 basename，取不到则退化为 `<taskId>.mp4`。

## Risks / Trade-offs

- **[commander 父命令位置参数 vs 子命令歧义]** → D2 记录冲突几率可忽略，apply 时以既有 `oralcut <input>` 用例回归验证；不稳则启用连字符兜底。
- **[产物 60 天 GC]** → 恢复命令把下载 404 判为「文件已过期」、仍打印/落盘报告（报告不随文件过期）；文档标注 ~60 天产物窗口。
- **[取结果需同账号]** → 恢复命令对 `TASK_NOT_FOUND` 明确提示「须用提交该任务的同一账号 key」。
- **[`--render` 需原毛片在位]** → 沿用 `render.ts:227` 的清晰报错；`--source` 重定位属 Non-Goal，本轮不做。
- **[每个产物目录多出 result.json/task.json]** → 增量、有用（可读报告 + 可恢复），可接受。

## Migration Plan

纯增量、无数据迁移：新增一个命令文件 + 一行注册；`cloud.ts` 抽函数（`pollTask` 行为不变）；`oralcut.ts` 增加两处落盘与延后 mkdir。回滚 = 还原这些改动。既有 `gtrk oralcut <input>` 行为向后兼容（仅额外产出 `result.json`/`task.json`）。

## Open Questions

- `result.json` / `task.json` 命名是否要用隐藏点前缀（如 `.gtrk-result.json`）或合并为一个文件？（当前取显式 `result.json` + `task.json`。）
- 是否也在 `failed/cancelled` 任务上落盘一份带错误的 `result.json`，给 agent 一个持久失败工件？（倾向纳入恢复命令、但主跑批本轮从简。）
- D2 采 commander 父命令+子命令，还是稳妥起见直接连字符 `oralcut-result` 而对外仍以 `oralcut result` 记述？apply 首步先验证再定。
