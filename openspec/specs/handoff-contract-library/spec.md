# handoff-contract-library Specification

## Purpose
TBD - created by archiving change add-column-style-meta-skill. Update Purpose after archive.
## Requirements
### Requirement: 契约库正本与版本化引用

框架 SHALL 维护 handoff 契约库,正本位于 `cli/contracts/`(管线资产归管线位置,不寄居任何 skill 目录),随 npm 分发;`gtrk-style-maker` 的 references 只放指向正本的引用。每份契约 MUST 带版本标识;创作 skill 以「契约名 + 版本」引用。(注:既有栏目 skill 中的契约副本由作坊侧 P1b 加头注指向正本——作坊不在本仓治理范围,此处仅为过渡说明,规范力限于「正本唯一在契约库」。)

#### Scenario: 首批收录 GSAP-emit 契约
- **WHEN** 本 change 实施完成
- **THEN** `cli/contracts/` 下存在 GSAP-emit/逐帧 seek 契约文档 v1(经中性化改写,内容以契约文档为准),带版本标识

#### Scenario: 契约升版不改用户 skill 内容
- **WHEN** 渲染管线契约升版
- **THEN** 用户 skill 只需更新引用版本号即可感知变化,风格内容零改动

### Requirement: 收录双轴边界

契约收录 SHALL 同时满足两轴边界。轴一(管线性,审美零预设):契约 MUST 只约束机器可判定的管线消费属性(封装/注册/确定性/依赖可达/产物格式);MUST NOT 规定颜色、字体、构图、红点数量等任何视觉取值或栏目词表词条;契约中凡涉视觉取值处(如底色、示例色值)MUST 参数化或用中性占位符。轴二(脱敏):契约库 MUST 只收录自有管线的合规契约,范围为封闭列举——渲染引擎合规、`.gtrk` 契约、派单格式;扩项 MUST 走 change 过审;MUST NOT 收录任何外部供应商/外部平台适配内容(该类内容属用户 skill 侧)。

#### Scenario: 自有但含审美取值的提案被拒收
- **WHEN** 有人提议把「全片最多一个红点」或「旁白主导底色 = 纯黑 #000」收进契约库(理由:自有管线惯例)
- **THEN** 按轴一拒收——红点/底色是栏目审美取值;契约只可规定「根底色透明与否必须显式声明」这类机器可判定属性,具体色值由调用方按栏目规则指定

#### Scenario: 外部平台适配被拒收
- **WHEN** 有人提议把外部 AI 视频平台的提示词格式差异收进契约库
- **THEN** 按轴二拒收,该内容引导放入用户自己的 skill references

### Requirement: handoff 类型→契约映射登记

契约库 SHALL 维护「handoff 类型 → 契约(名+版本)」映射表,注册集内每个类型 MUST 有登记项,允许登记「暂无契约」。映射由契约库单点维护,消费方(含 meta skill)MUST 查表而非硬编码。

#### Scenario: 首批映射表
- **WHEN** 本 change 实施完成
- **THEN** 映射表存在且覆盖当前注册集全部类型;有契约的指向「GSAP-emit v1」等,其余显式登记「暂无契约」

### Requirement: 框架分发物脱敏与零预设自证

对**整个 npm 包产物**(含契约库、meta skill、seeds/ 种子)的验收:①grep 外部供应商/平台名 MUST 零命中;②对 `cli/contracts/` grep 栏目词表词条、栏目专属 HEX 色值、字体名 MUST 零命中。此验收范围 MUST NOT 缩水解释为仅契约库目录。

#### Scenario: 分发物整体自证
- **WHEN** 打包前对 npm 包产物执行上述两组 grep
- **THEN** 全部零命中,否则发布阻断

