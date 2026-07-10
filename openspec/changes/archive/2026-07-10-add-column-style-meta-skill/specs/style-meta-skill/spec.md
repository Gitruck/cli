## ADDED Requirements

### Requirement: meta skill 随 CLI 分发

系统 SHALL 提供 meta skill `gtrk-style-maker`,源码位于 `cli/skills/gtrk-style-maker/`,注册进 CLI 的 skill 分发清单,经 `gtrk skills install` 安装到 `~/.claude/skills`,与既有 skill 同范式。

#### Scenario: 一键安装
- **WHEN** 用户执行 `gtrk skills install`
- **THEN** `~/.claude/skills/gtrk-style-maker/` 存在且可被 Claude Code 发现触发

### Requirement: 启发式引导零维度预设

meta skill 的引导流程 MUST 「问证据、不问维度」:MUST NOT 向用户出示任何预设视觉维度清单/表单让用户挑选或填空(不假设有叙事结构、有容器概念、视觉分 MG/AI 等)。引导 SHALL 以七招工艺组织:作品逆向、禁令先行、从工序提决策树、铁律化自检、词表沉淀、家族切分、exemplar 优先;每招 SHALL 配「不适用分支」(如无既有作品时改用他人作品定位)。**预设语系**定义为:历史 8 子块的概念名 + 《实在界漫游指南》四 skill 词表词条。卡壳追问 SHALL 满足:单次访谈 ≤3 条、每条 MUST 由用户已说内容触发并记录触发语、MUST NOT 按预设语系逐项顺次遍历(疑问句版表单)。

#### Scenario: 异构栏目访谈可审计地零预设
- **WHEN** 一个无三幕/无容器概念的异构栏目主接受引导并完成产出
- **THEN** 访谈记录中每个组织维度的首次提出者均为用户;对预设语系词表 grep 访谈中 meta skill 的提问,零命中(用户自己先说出的词除外)

#### Scenario: 卡壳追问有触发语
- **WHEN** 用户说不清自己的风格,meta skill 发起追问
- **THEN** 该追问引用用户已说的具体内容作为触发语并被记录;单次访谈此类追问不超过 3 条

### Requirement: 产出物形态

meta skill 的产出 SHALL 为:①用户 skill 目录(标准解剖:SKILL.md 含 name+description 触发器,按需 references/assets/scripts),落 `~/.claude/skills` 即装即用;②栏目配置登记——把 `{id, ref, produces}` 写入本地栏目配置(位置以 CLI paths 口径为准)的 `style.skills`/`style.shared`,同层写入 MUST 为**追加**语义(不清空既有登记);③当家族 ≥2 个 skill 或访谈沉淀出自造词时 MUST 产栏目内共享词表文档(家族各 skill 引用之,防多处定义漂移),否则词表内容并入 SKILL.md。产出的 skill README MUST 写明「正本→安装」单向流(源码正本在用户作坊目录,安装位是产物)。

#### Scenario: 产出即可用
- **WHEN** 引导完成并落盘
- **THEN** 新会话中该用户 skill 可被触发;栏目配置的 style 清单含对应条目

#### Scenario: 第二次访谈追加不清空
- **WHEN** 栏目已有 style.skills 登记,用户再次通过 meta skill 新增一个 skill
- **THEN** 既有条目保留,新条目追加

#### Scenario: 家族内防漂移
- **WHEN** 用户家族有两个 skill 共用同一组自造词
- **THEN** 该组词只在共享词表定义一次,两个 skill 以引用指向,不各自复制定义

### Requirement: 产物按映射绑定管线契约

当用户 skill 的 `produces` 命中 handoff 注册集**且契约库映射表中该类型存在已收录契约**时,meta skill MUST 在生成的 skill 中引用对应契约(名+版本),且其自检清单包含契约合规项;映射表中登记「暂无契约」的类型与管线外产物无此要求。映射关系 MUST 查契约库映射表获得,MUST NOT 在 meta skill 内硬编码。

#### Scenario: 有契约的产线绑定引用
- **WHEN** 用户产线的 produces 在映射表中对应 GSAP-emit 契约 v1
- **THEN** 生成的 skill 引用「GSAP-emit v1」,自检清单含契约合规项

#### Scenario: 暂无契约的产线不空转
- **WHEN** 用户产线的 produces 命中注册集但映射表登记「暂无契约」
- **THEN** 生成照常完成,不产生契约引用,不报错

### Requirement: 种子案例与双道等强验收

meta skill 的 references SHALL 收录 ≥2 个异构种子(削减版:组织维度 + 词表 + 自检结构,**不含平台 prompt 内容**)作 few-shot,并标注「种子是案例不是模板,结构随栏目而异」。种子素材 MUST 以 P1b 收口后的作坊正本为基准;种子内容 MUST 脱敏——外部供应商/平台名以中性占位(如「外部生成平台」)替换,并注明完整版正本在用户作坊。验收 SHALL 双道等强:①重生成道——以 P1b 收口后的《实在界》四 skill 为访谈素材走 meta 流程,收敛出等价家族(组织维度/铁律/词表等价,允许措辞差异);②异构道——对一个异构栏目型端到端跑通,判据 = 访谈记录满足「零维度预设」requirement 的审计条件 + 产出 skill 通过其自身自检清单 + 完成落盘登记三件套。

#### Scenario: 种子不被当模板
- **WHEN** 用户的栏目与所有种子都不像
- **THEN** meta skill 按七招从零引导,不套用任何种子的结构

#### Scenario: 种子脱敏
- **WHEN** 对 references/seeds/ 全部内容 grep 外部供应商/平台名
- **THEN** 零命中

#### Scenario: 异构道验收可判定
- **WHEN** 异构试金石完成
- **THEN** 存在访谈记录且通过零预设审计(维度首提者=用户、预设语系 grep 零命中),产出 skill 自检全过、登记落盘完整
