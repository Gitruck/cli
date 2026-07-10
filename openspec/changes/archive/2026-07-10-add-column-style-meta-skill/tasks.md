# Tasks — add-column-style-meta-skill

> Change D-P1a(cli 仓):style 块定形为不透明引用清单 + meta skill `gtrk-style-maker` + 框架契约库(`cli/contracts/`)。依赖 **修订版** `add-column-config-schema`(D-P0)先 apply(修订已回写其工件:~/.gitruck 路径 / split-doc-contract delta / style 空占位)。**任务 2.4 与 4.1 阻塞于 P1b 收口**(种子与重生成素材以 P1b 收口后的 `D:\file\skills` 正本为基准,防止旧版铁律被固化)。

## 1. style manifest(schema + loader)

- [x] 1.1 `src/lib/column-config.ts`:`ColumnStyle` 类型 `{skills:[{id,ref,produces?,status?,routing?}], shared:[{id,ref,role?}], bundle_ref?}`;`produces: string|string[]`;`status/role` 透传不消费;条目最小合法字段 = id+ref,非法条目跳过+提示不抛(字段级校验,零解析约束内)
- [x] 1.2 折叠算子:style 整块 OVERRIDE(数组不逐条 merge);**L0 内置默认不携带 style 清单**;补 fold 单测
- [x] 1.3 produces 惰性路由:命中 handoff 注册集可被按类型检索;未命中**静默**登记;仅大小写差异/编辑距离 ≤2 提示疑似拼写(每次 resolve 每值至多一条);`routing:"none"` 豁免提示
- [x] 1.4 零解析约束落实:确认全链路无任何读取 `ref` 内容的代码路径;`ref` 路径不存在不阻断解析

## 2. 契约库 + meta skill

- [x] 2.1 `cli/contracts/`:GSAP-emit 契约 v1——从 gsap-emit-pattern.md 剥离并**中性化改写**(只留机器可判定属性:template 包裹/paused 注册/确定性/自包含/依赖可达/字面值禁 var;示例色值字体一律中性占位;「旁白主导=纯黑」改写为「根底色透明与否必须显式声明,色值由调用方指定」;1920×1080 标注引擎版本约束;「红点 ≤1」等审美铁律**不入库**);建 handoff→契约映射表(注册集全类型覆盖,允许「暂无契约」);package.json files 增列 contracts
- [x] 2.2 `cli/skills/gtrk-style-maker/SKILL.md`:七招硬工序(每招配正反例 + 不适用分支);卡壳追问三约束(≤3 条/须触发语并记录/禁按预设语系顺次遍历);产出工序含「produces 命中且映射表有契约 → 生成的 skill 引用契约(名+版本)+ 自检含合规项(查表,不硬编码)」
- [x] 2.3 references/craft:产出物规范(skill 目录解剖/共享词表**条件产出**规则/栏目配置**追加**登记——位置写「以 gtrk paths 口径为准」不写死路径)+「正本→安装」单向流说明;references/contracts 只放指向 `cli/contracts/` 正本的引用
- [x] 2.4 references/seeds/:收 ≥2 个异构种子削减版(**只含组织维度+词表+自检结构,不含平台 prompt 内容**;供应商/平台名中性占位;标注「案例非模板」)。**阻塞于 P1b:素材以收口后正本为基准**
- [x] 2.5 `src/commands/skills.ts`:分发清单加入 `gtrk-style-maker`,`gtrk skills install` 安装验证

## 3. 测试

- [x] 3.1 loader:无 style 块零感知(与修订版 D-P0 行为一致)/最小清单合法/非法条目跳过+提示/损坏回落
- [x] 3.2 produces:命中注册集可检索/未命中静默(`"cover"` 类)/编辑距离 1(如 `RRV_MC`)提示疑似拼写/`routing:"none"` 豁免/`string[]` 多产物
- [x] 3.3 OVERRIDE 折叠:L2 定义 style 整块生效;L0 解析结果不含任何内置 skill 登记
- [x] 3.4 install:gtrk-style-maker 随 `gtrk skills install` 落位 `~/.claude/skills`

## 4. 验收(双道等强 + 自证)

- [x] 4.1 重生成道(**阻塞于 P1b**):以 P1b 收口后的《实在界》四 skill 为访谈素材走 meta 流程,收敛出等价家族(组织维度/铁律/词表等价,允许措辞差异)
- [x] 4.2 异构道(等强判据):对一个异构栏目型(倾向带货)端到端跑通;验收 = 访谈记录通过零预设审计(每个组织维度首提者=用户 + 对预设语系词表 grep meta skill 提问零命中)+ 产出 skill 通过其自身自检清单 + 落盘登记完整(skill 目录/条件词表/配置追加)
- [x] 4.3 分发物自证:对**整个 npm 包产物(含 seeds/)** grep 外部供应商/平台名零命中;对 `cli/contracts/` grep 栏目词表词条/栏目专属 HEX/字体名零命中;两组 grep 进打包前检查
