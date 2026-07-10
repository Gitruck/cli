## ADDED Requirements

### Requirement: style 块为不透明引用清单

栏目配置的 `style` 维度 SHALL 定形为引用清单:`style = { skills: [{id, ref, produces?, status?, routing?}], shared: [{id, ref, role?}], bundle_ref? }`。`ref` 为逻辑引用(本地路径;上云后可为 DB/OSS 引用),内容**不内嵌**。`produces` 为 `string | string[]`(一个 skill 可产多类 handoff)。`status`/`role` 框架**不消费、仅透传展示**,值域不设限。全部字段可选,与 D-P0「schema 全字段可选」一致。条目最小合法字段 = `id` + `ref`。

#### Scenario: 登记一个栏目自产 skill
- **WHEN** 栏目配置 `style.skills=[{id:"my-anim", ref:"D:/work/skills/my-anim", produces:"hand-drawn-stopmotion"}]`(produces 为用户自造串)
- **THEN** 配置合法,解析后有效配置中可读取该清单条目原样

#### Scenario: 无 style 块零感知
- **WHEN** 栏目配置不含 `style` 块
- **THEN** 解析、校验、split 全链路行为与 D-P0 一致,无告警

#### Scenario: 非法条目跳过不阻断
- **WHEN** `style.skills` 某条目缺 `ref` 或不是对象
- **THEN** 该条目被跳过并提示,其余条目正常解析,MUST NOT 抛错中断(此为清单自身字段级校验,不涉 ref 内容,不违反零解析约束)

### Requirement: 框架零解析(审美零预设)

框架 MUST NOT 读取、解析或校验 `ref` 所指向文件的内容;MUST NOT 对 skill 的内部结构、风格维度、取值做任何 schema 约束。框架消费的仅限清单条目自身的字段。

#### Scenario: 引用指向任意结构的用户 skill
- **WHEN** `style.skills[].ref` 指向一个完全自定义结构的 skill 目录(维度全是用户自造)
- **THEN** 解析照常成功,框架不因内容结构产生任何错误或告警

#### Scenario: 引用路径不存在不阻断
- **WHEN** `ref` 指向的路径当前不存在
- **THEN** 解析不失败(清单是登记不是校验),仅在显式消费该引用的场景提示

### Requirement: produces 惰性路由

`produces` SHALL 登记 skill 产物绑定的 handoff 类型。取值命中 **handoff 注册集**(取值与演进归 lane/handoff 侧能力管理,本 spec 不复述其枚举;当前注册集 = 现行四车道,属 P2 注册表化前的过渡事实)时,该条目可参与派单路由消费;未命中时 SHALL **静默惰性登记**——保留原值、不校验、不报错、不提示。仅当未命中值与某注册值仅大小写差异或编辑距离 ≤2 时,SHALL 提示疑似拼写(每次 resolve 每值至多一条);条目声明 `routing:"none"` 时连该提示也豁免(显式管线外)。

#### Scenario: 命中注册集的 skill 可路由
- **WHEN** `produces` 命中 handoff 注册集中的某类型
- **THEN** 该条目在派单消费场景可被按该类型检索为产能登记

#### Scenario: 管线外产物静默登记
- **WHEN** `produces:"cover"`(与任何注册值编辑距离 >2)
- **THEN** 条目原样保留可读取,无任何提示或告警

#### Scenario: 疑似拼写才提示
- **WHEN** `produces:"RRV_MC"`(与注册值编辑距离 1)且未声明 `routing:"none"`
- **THEN** 输出一条疑似拼写提示,条目仍惰性登记不报错

### Requirement: style 折叠沿用整块 OVERRIDE

层栈折叠时 `style` 维度 SHALL 沿用 D-P0 的 OVERRIDE 算子:高层配置的 style 块整块替换低层,MUST NOT 对 `skills`/`shared` 数组做逐条 merge(「换装」语义:别的栏目不应继承默认栏目的 skill 家族)。L0 内置默认 SHALL **不携带** style 清单(默认栏目的 skill 家族也走 L2 登记,避免「追加须 fork 整块」的配置层副本漂移)。

#### Scenario: L2 定义 style 时整块生效
- **WHEN** L2 本地栏目配置定义了 style 清单
- **THEN** 有效配置的 style = L2 的整块;任何更低层若含 style 亦被整块替换(纯算子行为说明,L0 携带 style 非推荐形态)

#### Scenario: L0 无 style 清单
- **WHEN** 零配置(仅 L0)解析有效配置
- **THEN** style 为空,不含任何内置 skill 登记
