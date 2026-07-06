## 1. cloud 原语：抽出 getTaskResult

- [x] 1.1 在 `src/lib/cloud.ts` 新增 `getTaskResult(cfg, taskType, taskId): Promise<{status, progress?, output}>`：单发 GET、复用 `parseJson`、非 200 抛 `CloudError`、返回完整 status/progress/output_result
- [x] 1.2 `pollTask` 改为循环调用 `getTaskResult`；对外行为不变（CloudError 透传、瞬断 continue、completed 返回 output、failed/cancelled 抛错、其余 onTick）
- [x] 1.3 `OralCutOutput` / `ProductFile` 已 export，恢复命令直接复用

## 2. 共享落地函数 materializeResult

- [x] 2.1 新建 `src/lib/materialize.ts`：`baseFormat` + `FORMAT_META` + `materializeResult`（下载分组 / 剪映拷贝 / 可选渲染 / result.json / 人读提示 / --json 输出），`download` 可注入（测试用）
- [x] 2.2 `result.json` 两段写：下载前先落基础版（含 report/taskId），末尾补写 `{files:byFormat, jianyingDraftPath, rendered}`（单测覆盖）
- [x] 2.3 下载 404（产物过期）不整体中止：记入 `errors`、告警、仍落盘/输出报告（单测覆盖）；剪映拷贝亦尽力而为

## 3. 主命令 oralcut 落盘与失败卫生

- [x] 3.1 去掉 eager `mkdir(outDir)`，改按需建目录
- [x] 3.2 submit 成功即写 `<outDir>/task.json`（含 taskId/taskType/fileId/source/formats/createdAt）
- [x] 3.3 主流程 ⑤⑥⑦ 换用 `materializeResult`，result.json 恒写、下载前先落基础版
- [x] 3.4 实测：提交前失败（伪视频触发 ffprobe 失败）→ 无空壳目录 ✅；`--json` 重定向后仍能从 result.json 读报告 ✅（集成验证）；提交后失败→仅含 task.json（结构保证：task.json 在 submit 后即落）

## 4. 新命令 gtrk oralcut-result <taskId>

- [x] 4.1 D2 实测 commander@12：父命令 `oralcut` 与子命令 `result` 同名选项被父命令吞（路由对、选项不绑）→ **采兜底：顶层 `gtrk oralcut-result <taskId>`**（spec/README/design 已同步）
- [x] 4.2 新建 `src/commands/oralcut-result.ts` 导出 `registerOralCutResult(program)`，选项 out/render/crf/codec/ffmpeg-path/jianying-draft-dir/no-open/json
- [x] 4.3 命令体：`getTaskResult` → 非 completed 清晰报错并非零退出 → completed 调 `materializeResult`；`--out` 缺省 `<cwd>/<taskId>-video-project-<时间戳>`（真实已完成任务集成验证通过）
- [x] 4.4 `--render` 成片名取 gtrk 素材 basename、退化 `<taskId>.mp4`（渲染路径与主命令 renderGtrk 同一代码、已在既有跑批验证；恢复路径未跑满 10min 实渲）
- [x] 4.5 `TASK_NOT_FOUND`（异账号/软删/不存在）清晰提示「须用同账号 key」（伪 task_id 实测 code=6006 命中）
- [x] 4.6 `src/index.ts` 一行注册 `registerOralCutResult(program)`

## 5. 测试

- [x] 5.1 `getTaskResult` 单测：completed 返回 output、非 completed 保留 status/progress、非 200 抛 CloudError（3 例）
- [x] 5.2 `materializeResult` 单测：404 降级仍落盘报告、成功分组 + result.json 两段写、无产物即抛、baseFormat 归一（4 例）；已把 cloud/materialize 加入测试打包
- [x] 5.3 主命令回归：`oralcut <input>` 路由/选项不变（--help + 伪输入实测）；⑤⑥⑦ 走 materialize（单测+集成覆盖）；失败不留空壳（实测）
- [x] 5.4 `oralcut-result`：已完成落地 + `--json` 单行 + `--out`/`--jianying-draft-dir`/`--no-open` 均生效（真实任务 88269671080189958 集成验证）；TASK_NOT_FOUND 实测；未完成/`--render` 路径代码清晰（未跑满实渲）

## 6. 文档与收尾

- [x] 6.1 README 新增 `gtrk oralcut-result <taskId>` 小节 + result.json/task.json 说明 + 补回 `--json` 输出漏写的 `rendered` 字段；命令自带 `--help`
- [x] 6.2 记一条（已开 background task）：`gtrk-oralcut` skill 后续补「拿报告直接用 `oralcut-result`、不必重跑；~60 天产物窗口」
- [x] 6.3 `tsc --noEmit` 通过；`bun run build`（33 模块）通过；`bun run test` 23/23 全绿；`gtrk doctor` 不回归
