## Why

D-P0(`add-column-config-schema`)把 narrative/container 词表配置化了,但风格层若仍由框架定义维度(曾拟的 style 8 子块 schema)——从《实在界漫游指南》的两个视觉 skill 归纳出「visual_tokens/invariants/themes/…」——本质还是**「我们定义 k 让用户填 v」**,归纳本身就是路径依赖残留(主理人 2026-07-10 元洞察)。今天栏目的视觉产线是 MG/AI 再现,明天可能是手绘定格/数据大屏/实拍混剪,框架预设任何视觉维度都会把第一个栏目的世界观焊死给所有栏目。

主理人拍板的边界公式:**框架对审美零预设,对管线接口(lane 概念 + handoff 契约)全权威**(与 skills-roadmap 北极星「所有车道产物收敛到 .gtrk 契约,客户端只认契约、不认 skill 细节」同构)。据此,风格知识应活在**用户自己的 skill**里(可执行/黑盒/留本地,我们看不到,没关系);框架只持有**引用清单**和**管线契约**,再提供一个**「能生产 skill 的 meta skill」**(授人以渔)——引导任何栏目主想清楚他自己的视觉语法,产出他自己的 skill 家族,而不是填我们的模板。且「零预设」不能靠措辞自觉:对抗审查证实预设会从契约示例、种子内容、验收基准三个后门复活,故本 change 把零预设与脱敏一并**验收化**(grep 自证 + 访谈可审计)。

## What Changes

- **style 块定形为不透明引用清单**(D-P0 修订版已将 style 改为空占位,本 change 定义内部形态):`style = { skills: [{id, ref, produces?, status?, routing?}], shared: [{id, ref, role?}], bundle_ref }`。框架 **MUST NOT 解析 ref 指向的内容**;`status/role` 仅透传。
- **`produces` 惰性路由**:登记产物绑定的 handoff 类型;命中 handoff 注册集(当前=现行四车道,P2 注册表化前的过渡事实,工件不复述枚举)才参与派单路由,未命中 = **静默**惰性登记(仅编辑距离近似时提示疑似拼写,`routing:"none"` 可豁免)。
- **新增 meta skill `gtrk-style-maker`**(源码进 `cli/skills/`,随 npm 分发,`gtrk skills install` 安装):七招启发式(**问证据、不问维度**),零预设**可审计**(追问 ≤3 条且须用户已说内容触发/组织维度首提者=用户/预设语系 grep);产出 = 用户 skill 目录(落 `~/.claude/skills`)+ 条件产出的栏目共享词表 + 栏目配置追加登记。
- **工程契约库**:自有管线契约经**中性化改写**(只留机器可判定属性,示例色值字体一律中性占位,审美铁律不入库)收进 `cli/contracts/`(管线资产归管线位置,不寄居 skill 目录);收录范围封闭列举;维护 handoff→契约映射表(允许「暂无契约」),消费方查表不硬编码。
- **分发物自证验收**:整个 npm 包(含种子)grep 外部供应商/平台名零命中;契约库另 grep 栏目词表词条/HEX/字体名零命中。种子只收组织维度+词表+自检结构且脱敏。
- **上云预留**:`bundle_ref` 占位(config→DB 与 bundle→OSS 分家);引用清单对「skill 是视觉还是声音」无感知,声音 DNA 等未来 taste 维度零改动纳入。

## Capabilities

### New Capabilities
- `column-style-manifest`: style 块 = 不透明引用清单——字段形态、框架零解析约束、produces 惰性路由(静默登记+疑似拼写提示+豁免)、OVERRIDE 折叠与 L0 不带清单。
- `style-meta-skill`: 能生产 skill 的 meta skill——可审计的零维度预设引导、产出物形态(条件三件套/追加登记/单向流)、按映射绑定契约、种子脱敏与双道等强验收。
- `handoff-contract-library`: 框架契约库——正本位置与版本化引用、收录双轴边界(管线性+脱敏)、handoff→契约映射登记、分发物整体自证。

### Modified Capabilities
<!-- 无:D-P0(修订版)的 column-config spec 对 style 仅声明维度名与 OVERRIDE 算子,本 change 纯增量定义内部形态,不改其任何 requirement -->

## Impact

- **依赖**:`add-column-config-schema`(D-P0)**修订版**须先 apply。修订已随本 change 的对抗审查**直接回写其工件**(非「apply 时顺手改」):①L2 路径 `~/.gtrk-cli/columns/` → `~/.gitruck/columns/`(paths.ts 现状);②补 `split-doc-contract` 的 MODIFIED delta(八/七/三枚举校验源改有效 vocab);③style 骨架 `{palette, aspect_ratio}` 废弃为空占位(palette/aspect_ratio 是框架预设视觉维度)。两 change 一并重过人审。
- 代码:`src/lib/column-config.ts`(style manifest 类型 + 宽松解析 + produces 提示策略)、`src/commands/skills.ts`(分发清单增 `gtrk-style-maker`)、`package.json`(files 增列 `contracts`)。
- 新目录:`cli/skills/gtrk-style-maker/`(SKILL.md + references 工艺文档 + seeds/)、`cli/contracts/`(契约正本 + 映射表)。
- 文档:无对外 API 变更,不涉 gitruck-cloud docs 联动(纯 CLI 本地能力)。
- **Out-of-scope**:①P1b《实在界》种子重构(作坊侧轻治理,另有计划文档;本 change 的种子/重生成素材以其收口后为基准,任务 2.4/4.1 阻塞于 P1b);②lane/handoff 注册表化(P2 承重面,单独 change);③splitter 类管线文档生产者的登记语义(留 P2 与注册表一起定);④`gtrk column` 登记类子命令(按需后续);⑤L1 后端/L3 钉存对 style 块的承载(随 D-P0 的 out-of-scope 一并后续)。
