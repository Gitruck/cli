# 产出物规范（craft-output-spec）

## 1. 用户 skill 目录解剖

```
<skill-name>/
├── SKILL.md          # 必须。frontmatter: name + description（description 即触发器）
├── README.md         # 必须。对人类的说明 + 「正本→安装」单向流声明（spec MUST）
├── references/       # 按需。深文档（渐进披露：SKILL.md 装不下的细则放这里）
├── assets/           # 按需。exemplar 成品/模板/素材
└── scripts/          # 按需。可执行工具
```

- **frontmatter 最小集**：`name`（kebab-case）+ `description`。description 决定触发——包含功能关键词 + 「当用户想「…」时使用本 skill」+ 触发短语枚举。这是生态实证的唯一触发机制，没有独立 trigger 字段。
- **自足性铁律**：skill 里要含齐干活所需的全部信息（或明确引用哪里查），不让运行时去猜。
- **正文结构由访谈维度决定**——用户的 Step 1 是什么，skill 的 Step 1 就是什么。唯一必备的三个小节：铁律（含禁令）、交付前自检清单、（多 skill 家族时）「这个 skill 不做什么 → 找谁」。

## 2. 「正本→安装」单向流（写进产出 skill 的 README）

> 本 skill 源码正本在 `<用户作坊路径>`；`~/.claude/skills/<name>/` 是安装产物。改动**永远先改正本**，再重新拷贝安装。云端（claude.ai capability）上传是可选的第三级分发，同样以作坊正本打包。
> ——副本漂移是有血泪教训的（同一枚举曾在 6 处定义、口径打架），单向流是唯一解法。

## 3. 共享词表（条件产出）

触发条件（任一）：家族 ≥2 个 skill；访谈沉淀出自造词。
形态：单独一份 `_shared/<栏目>/vocab.md`（下划线前缀防误认成 skill），条目 = 词 + 定义 + 取值（如有）。各 skill **引用不复制**（需要内联值时标注「正本在词表，改值先改那里」）。文件头写治理规则：「新词先入表再用」。
不满足条件时：词表内容并入 SKILL.md 一节。

## 4. 栏目配置登记

- 位置：以 gtrk paths 口径为准（当前 `~/.gitruck/columns/<栏目id>.json`；权威在 CLI 的 paths 模块，本文档不是路径权威源）。
- 写法：**追加**进 `style.skills` / `style.shared` 数组，绝不清空既有条目；文件不存在则创建最小骨架。
- 条目：`{ "id": "<skill-name>", "ref": "<正本绝对路径>", "produces": "<handoff 类型或用户自造串>" }`；管线外产物（封面、周边图等）加 `"routing": "none"`（豁免疑似拼写提示）。
- `produces` 是登记不是审批：写用户自造串完全合法（框架静默惰性登记）；只有命中管线 handoff 注册集的才参与派单路由。

## 5. 契约绑定

查 `contracts/handoff-contracts.json`（随 @gitruck/cli 分发，包内相对路径 `contracts/`；本 skill 安装后可从 CLI 包根定位）。规则：
- `produces` 命中注册集 **且** 映射表给出契约 → 生成的 skill 必须：①引用「契约名+版本」（如 `gsap-emit v1`，契约文档在 `contracts/<doc>`）；②把契约合规项列进自检清单（如：template 包裹？paused 时间线注册？无 random/Date？字面值无 var()？）。
- 映射为 `null`（暂无契约）或管线外产物 → 无绑定要求，照常生成。
- **永远查表，不硬编码映射**——契约升版/新增时表会更新。

## 6. 收尾提醒（给用户）

- skill 留本地即完整可用；上传 claude.ai（打包 .skill zip）是**可选**分发，供网页/移动端触发。
- 后续迭代：改作坊正本 → 重拷 `~/.claude/skills/` → （可选）重新打包上传。
