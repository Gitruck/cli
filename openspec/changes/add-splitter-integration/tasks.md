# add-splitter-integration · Tasks

> 纯本地新命令 + skill 收编，无云端调用变更。联动：infra `add-oral-cut-transcript-output`（transcript 恒出，联调前置）、opencut `add-gtrk-reload`（重载闭环，不阻塞本 change）。
> 离线开发不依赖后端：用金样 transcript fixture 全程可测。

## 1. 投影器（src/lib/projection.ts，纯函数）

- [x] 1.1 `projectTranscript(transcript, gtrk, {words?}) -> view`：word 区间交集映射 + utterance 包络 + dropped 判定 + 多实例排序；只扫 main 底轨、只认 `material===transcript.material_id`
- [x] 1.2 离线单测（node:test）：乱序三段剪辑 / 恢复片段（clip 拉长后 word 复活）/ 恒等投影（已剪好成片）/ 复制片段多实例 / 全 dropped

## 2. 拆分稿解析与校验（src/lib/splitdoc.ts）

- [x] 2.1 结构/枚举校验（必填字段、lane 四选一、narrative 八枚举、container_stage 七枚举、handoff 按 lane 分型）
- [x] 2.2 id 校验（存在性 / from≤to / beats 不重叠）+ `transcript_hash` 硬拒 + 错误信息逐条可操作（beat id + 原因）
- [x] 2.3 校验矩阵单测：幻觉 id / 区间倒序 / 重叠 / hash 错版 / FILM_BROLL 缺 queries / A_ROLL 带 handoff 警告

## 3. split 命令（src/commands/split.ts + index.ts 注册）

- [x] 3.1 双模式路由（`.argument('[splitdoc]')`）+ `--project` 自动定位 / `--gtrk`/`--transcript` 兜底 + `--json`/`--md`/`--words`
- [x] 3.2 视图模式：投影 → `split/view.json` + stdout；transcript 缺失的引导性报错
- [x] 3.3 落地模式：v1 门 → 校验链 → 投影 → 三件产物（`struct_meta.split` 原子写回〔mtime 比对拒写〕/ `dispatch.json`〔composition_id=`<工程slug>-<beat_id>`〕/ `--md` 人读稿渲染）
- [x] 3.4 单测：原子写回后 `.gtrk` 其余键不变（round-trip 断言）/ mtime 冲突拒写 / 零副作用失败（校验失败时 split/ 目录无残留）

## 4. skill 收编（skills/gtrk-splitter/）

- [x] 4.1 SKILL.md 重写：transcript 驱动流程（取视图 → 拆分 → 落地 → 修正循环 ≤3 轮）+ 三条铁律（只引用 id / 不抄原文定位 / 不碰时码）+ dispatch 摘要回报格式
- [x] 4.2 references：`field-schema.md`（json 契约版，枚举与升级规则沿旧版精华）+ `example-visual-split.json`（《过拟合》20-beat 金样迁移）+ 旧 md 金样留作人读稿风格参照
- [x] 4.3 `src/commands/skills.ts` 登记 gtrk-splitter；`gtrk skills install` 双 skill 安装验证
- [x] 4.4 工作区归档动作：`file/skills/video-script-visual-splitter/` 移入 `file/skills/history/`（连带清理 rrv 的过期 V2_UPDATE_GUIDE 陷阱可顺手，单独 commit）

## 5. 文档与端到端

- [x] 5.1 AGENT.md 补 splitter 编排章节（oralcut → 保存 → split 视图 → 拆分 → split 落地 → 各车道派单）；README 命令表补 split
- [x] 5.2 金样端到端 dry-run：fixture transcript + 20-beat 金样拆分稿 → split 落地 → 断言 struct_meta.split/dispatch.json 与预期一致
- [x] 5.3 真机联调（依赖 infra transcript 上生产）：真口播毛片 oralcut → 客户端手调切点保存 → split 视图确认投影跟随 → 拆分落地 → 客户端双击打开确认 struct_meta 存活
- [ ] 5.4 发版（npm publish + 版本号）；上线后 24–48h 观察：skill 修正循环触发率（>1 轮占比高 = 契约/提示词需调）

## 6. 规范自检

- [x] 6.1 `--json` 机读契约与 stderr 日志分离自检；错误路径全部非 0 退出且零副作用
- [x] 6.2 与 infra change proposal 互链检查（两侧 proposal 均已引用对方）
