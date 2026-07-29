# 文生图 Prompt 模板（框架版）

**铁律**：
- **不**在 Prompt 里要求生图模型渲染中文字。汉字由**阶段二的 H5 工作台**贴字（用户用浏览器交互完成），图里**只留"气息性的软留白"**——不必做硬留白约束。
- 总是输出**英文主版 + 中文辅版**两套。
- 三种尺寸（16:9 / 4:3 / 3:4）**各出一套**，构图差异显式化：
  - **16:9**：横版，主体居中，两侧有气息的空间
  - **4:3**：横版饱满，主体可以顶到三边，对角留气口
  - **3:4**：竖版，主体在中段，上下舒展，便于"上下分飞"排字
- 每套 Prompt 各占一段，不要三尺寸塞一个段落。
- 每套都塞满"风格锚点 + 色板 + 材质"三件套，不要只写主体。

**风格注入槽位**：框架对审美零预设，风格三件套里的「风格」与「材质」是两个注入槽位，值由**栏目封面风格资产**供给；无资产时用中性默认值。

| 槽位 | 含义 | 中性默认值 | 栏目资产供值示例（示例、非默认） |
|---|---|---|---|
| 【风格锚点 A】 | 画风定调串 | cinematic illustration, clean composition | anime illustration style, 2D cel-shaded |
| 【材质串 T】 | 质感/印刷肌理串 | subtle film grain | film grain, paper texture, halftone dots |

---

## 英文主版骨架（Midjourney / SD / Flux / Nano Banana）

```
[主体 S 描写], [容器意象 C 融合描写], [情绪氛围 M],
【风格锚点 A】,
[光线 L], [镜头 Cam], [色板 P],
【材质串 T】,
composition: [留字位描述 R],
negative: photorealistic face, 3D render, glossy skin, ugly anatomy, watermark, text, chinese characters, blurry
--ar [比例] --style raw --stylize 250
```

（负面提示里与画风相斥的项目也随栏目资产调整，如写实系栏目不排除 photorealistic。）

### 槽位填法

| 槽位 | 填法 | 范例 |
|---|---|---|
| S | 角色外形 + 表情 + 姿态；或抽象意象描写 | a solitary young woman with silver hair, downcast eyes, wearing a dark coat / a lone astronaut silhouette |
| C | 容器意象的视觉化，叠在主体身上/周围 | overlaid with translucent neural network patterns glitching / surrounded by colliding light particles forming a supernova |
| M | 情绪形容 | quiet despair yet faint hope, suffocating tenderness, cold clinical detachment |
| L | 光线 | rim light from behind, single hard light from upper left, god rays through dust |
| Cam | 镜头 | close-up portrait, medium shot, wide cinematic shot, dutch angle |
| P | 色板（由栏目风格资产的色板表供英译） | 见下「色板英译」 |
| R | 留字位 | 软建议而非硬约束。例如 "edges with softer visual weight for typography overlay" / "central subject with breathing room on sides" |
| 比例 | --ar 参数 | `--ar 16:9` / `--ar 4:3` / `--ar 3:4` |

### 色板英译

色板英译由**栏目风格资产的色板表自带**（每个色板代号配一条英文描述串）；无资产时用中性描述（如 muted cool palette with a single warm accent）。格式示例：

```
| 代号 | 英文描述 |
|---|---|
| P-x | steel blue and bone white, single warm amber accent |
```

### 完整范例（16:9，"过拟合"主题）——某栏目实例（风格锚点/色板为该栏目资产值）

```
a lone young woman gazing away, her silhouette gradually dissolving into 
translucent glitching neural network lines, looping patterns repeating 
over her shoulders and hair, quiet despair with a distant trace of 
awakening, anime illustration style, 2D cel-shaded with thick line 
art, rim light from behind suggesting hidden warmth, medium close-up 
slightly off-center, steel blue and bone white palette with a single 
amber accent, film grain, paper texture, halftone noise on background,
composition: subject centered with breathing room on both sides, 
edges with softer visual weight so typography can overlay later,
negative: photorealistic face, 3D render, glossy skin, ugly anatomy, 
watermark, text, chinese characters, blurry, extra fingers, deformed hand
--ar 16:9 --style raw --stylize 250
```

---

## 中文辅版骨架（即梦 / 可灵 / 通义万相 / 文心）

中文模型对自然语言段落式 Prompt 响应更好，不要生搬英文结构。

```
【画面主体】一位/一件/一个……，[外形 + 神态 + 姿势]。
【容器意象】画面中融合 [容器的视觉化描述]，与主体叠压 / 环绕 / 映射在背景。
【情绪氛围】整体气氛 [情绪形容]。
【风格】[风格锚点 A 的中文表述]，不要真人写真，不要 3D 渲染（排除项随栏目画风调整）。
【光线】[光线描述]。
【镜头】[镜头角度与景别]。
【色彩】主色 [主色]，辅色 [辅色]，点缀 [强调色]（取值由栏目色板表供给）。
【质感】[材质串 T 的中文表述]。
【构图】主体 [位置]；[明确留白区域]，该区域绝对不要出现任何元素。
【排除】不要文字，不要中文字符，不要水印，不要 3D 光泽皮肤，不要多余手指。
【比例】[16:9 / 4:3 / 3:4]。
```

---

## 模型差异化调参

| 平台 | 独有参数 / 注意事项 |
|---|---|
| Midjourney v7 | 加 `--style raw --stylize 150~400`；需要一致风格时加 `--sref <URL>` 引用一张基准图 |
| Flux.1 (dev/pro) | 去掉 `--ar` 用 `aspect ratio: 16:9` 自然语言；风格锚点要更具体 |
| Stable Diffusion XL | 用 `(keyword:1.3)` 给权重；负面提示单独输入 |
| Nano Banana | 接受长段描述，可直接贴中文辅版；支持参考图输入 |
| 即梦 / 可灵 | 参考图 + 中文辅版效果最佳，英文 Prompt 表现弱 |
| 通义万相 | 对"不要 XX"这类排除描述响应很好，用中文辅版 |

---

## 常见 Prompt 失败与补救

| 症状 | 补救 |
|---|---|
| 模型硬要画中文字，全是乱码 | 负面提示加 `text, chinese characters, letters, signs`，主提示加 `no text, empty space for text overlay` |
| 脸的质感偏离栏目画风（如插画系被画成真人磨皮） | 主提示前置栏目的【风格锚点 A】并显式排除对立画风（如 `NOT photorealistic`）；负面加对立项（如 `3D render, photograph, realistic skin`） |
| 主体被容器意象吞掉，看不清 | 调整描述比例："subject clearly visible, container motif as translucent overlay at 30% opacity" |
| 太满没留字位 | 显式写 "composition: LEFT THIRD completely empty, solid color, no elements"；可先用构图图参考（scribble / sketch）约束 |
| 色板没出效果 | 把色板 HEX 值写进 Prompt：`dominant colors #XXXXXX and #XXXXXX`；或附参考色板图。精确色 token 由栏目风格资产自带，写进 Prompt 用 HEX |
