# 工作台实例化指南（workbench-guide）

`assets/workbench-template.html` 是**中性活范本**：一份完整可运行的排字工作台（拖拽 / 方向键 / 数值 / 滚轮微调、逐尺寸与一键导出），实例化 = 逐替换位换成当期值。本文是替换位总表 + 工程注意 + 合规检查。

## 0. 分工提醒

模板的 **JS 引擎层不要动**：拖拽 / 方向键 / 滚轮 / 图层选中 / 舞台缩放（负 margin 占位）/ 导出（html2canvas）都是通用基建。要动的只有**数据与样式**：占位符、常量、DEFAULTS、CSS 变量与字体、图层组。

## 1. 替换位总表

| 替换位 | 位置 | 说明 |
|---|---|---|
| `__BG_16_9__` / `__BG_4_3__` / `__BG_3_4__` | 各 `.cover` 的 `<img class="bg">` | 唯一的显式占位符：换成 `data:image/jpeg;base64,<压缩后>` |
| `<title>` / `<h1>` / `.sub` / 3 个 `.pill` | 头部 | 当期 T1、英文副题、布局名 / 色板名 / 操作提示 |
| `T1_KEYS` 常量 | script 顶部 | **T1 字数驱动的总开关**，见 §2 |
| `#t1-text` 的 `value` 与 `maxlength`、`state.t1Text` | 右栏 + script | T1 初值**两处**必须一致 |
| 各 `.cover` 内的 `char*` div 组 | 三个 cover | 数量与 `T1_KEYS` 一致、initial 文本逐字填 |
| `t2 / t5 / t4` 初始文案 | cover 内 div **与** DEFAULTS `text` 双处 | 副标题（≤12 字钩子）/ 装饰英文 / 品牌戳（用户没给就 `visible:false` 且不编内容） |
| `DEFAULTS` 整块 | script | 三尺寸 × 全图层默认坐标：从 layout-recipes 选配方起步，再按实际画面气口微调 |
| `:root` 色板变量 | CSS | 见 §3 |
| `.t1` 字体 / 描边 / 发光 | CSS **与** `applyT1Style()` | 发光 rgba **两处**（CSS 初值 + JS 滑杆模板串）必须同色 |
| `#t1-color` 选项 / 发光滑杆 label 与默认值 | 右栏 | 按栏目色板给 2~3 档字色；发光名跟色板叫（银辉 / 琥珀 / …） |
| 装饰件默认开关 | 右栏 checkbox + `applyInner/applyCorner` | 当期装饰件决策的落点 |
| 尺寸 tab 的 `.desc` | 左栏 | 标注当期布局（如「左人右字」「上下分飞」） |

## 2. T1 字数驱动（防「四字机器」回潮）

模板 T1 图层数由 `T1_KEYS` 常量驱动。当期 T1 为 N 字时，改四处并保持一致：
1. `T1_KEYS = ['char1', …, 'charN']`；
2. 每个 `.cover` 内放 N 个 `char*` div（initial 逐字填）；
3. `#t1-text` 的 `maxlength="N"` 与 `value`；
4. `DEFAULTS` 三尺寸各含 N 条 `char*` 坐标。

`applyT1Text / renderCharBlocks / applyT1SizeAll` 都吃 `T1_KEYS`，不用改。`#t1-size-all` 滑杆的 min/max 按字号量级调（4 字大字 280~800；5 字竖排 150~700）。

## 3. 色板 CSS 变量（变量名固定、换值即换装）

| 变量 | 语义 | 用途 |
|---|---|---|
| `--midnight` | 最深底色 | 画布底、T1 描边、色块 |
| `--indigo` | 次深色 | 氛围渐变 |
| `--amber` | **强调色**（语义槽位，不必是琥珀） | UI 强调、选中框、导出钮、T5/装饰可用 |
| `--amber-soft` | 强调色柔化档 | hover、副文本 |
| `--bone` | 浅色字底 | T1 默认字色、浅 UI 文本 |

值从**栏目封面风格资产的色板表**取；无资产用模板自带中性值。UI chrome 与画布共用这套变量——换值后整个工作台会跟着栏目气质走，这是特性不是 bug。

## 4. 附加文字图层（品牌戳 / 拟声词 / 任意）

图层机制对非 T1 图层是通用的（`applyLayers` 按 `ls.type !== 't1'` 走 text/visible 同步）。加一个图层四步：
1. `DEFAULTS` 三尺寸各加条目 `{type:'<自定义>', pos, text, left, top, size, visible}`；
2. 每个 `.cover` 加 `<div class="layer-text <类名>" data-layer-key="<key>">初值</div>`；
3. `SUB_KEYS` / `SUB_LABELS` 登记（右栏出微调 block）；
4. CSS 加 `.<类名>` 样式（字体 / 颜色 / z-index；旋转等静态变换写在类里，不影响拖拽）。

已验证先例：品牌戳（手写体、可拖）、拟声词（手写体 + 静态旋转 + 强调色，「全画面唯一与强调色同源的字」这类点睛用法）。

## 5. 逐尺寸样式覆写（浅底反转墨色技法）

某一尺寸的背景局部是浅色（如竖版下段渐变成纸面）时，可把该尺寸的文字整体反转为深色：

```css
/* 覆写 .t1 必须 !important —— applyT1Style() 会写内联样式 */
.cover[data-size="3_4"] .t1 { color: #16233A !important; -webkit-text-stroke: 0 transparent !important; text-shadow: 0 2px 12px rgba(20,30,50,0.18) !important; }
/* t2/t5/t4 无内联色，普通级联即可 */
.cover[data-size="3_4"] .t2 { color: rgba(30,58,95,0.92); text-shadow: none; }
```

交付时必须告知用户：**该尺寸不受全局字色 / 发光滑杆影响**，是当期审美决策。

## 6. 装饰件片段

- **薄内框**（装裱感）：`.inner-frame { position:absolute; inset:50px; border:2px solid <色>; pointer-events:none; z-index:5; }` + 右栏开关 + `applyInner()`（模板已带，默认关）。浅底尺寸配 §5 覆写深色框。
- **四角断线框**：模板已带（`.corner` ×4 + 开关，默认关）。
- 胶带 / 撕痕 / REC 取景框等：按当期气质现写（绝对定位 + `pointer-events:none` + `z-index:5`，加进每个 `.cover`）；**装饰件是显式决策**——用或不用都要说理由。

## 7. 背景图归位与压缩

- **归位按宽高比**：`w/h ≥ 1.55 → 16:9`；`≥ 1.15 → 4:3`；否则 `3:4`。同档有多张时显式选择并告知备选（用户可用左栏「上传当前尺寸的背景图」随时换）。归不上任何档就问，别硬塞。
- **压缩参数**（JPEG、渐进式）：16:9 长边 ≤1280 / q82；4:3 ≤1600 / q78；3:4 ≤1400 / q78。纹理极密的图压不动属正常，别为体积牺牲画质到 q70 以下。
- **体积红线**：整份 HTML **>1MB 必须回头降参**（浏览器打开明显变慢）；>600KB 提示一句即可。
- **纪律**：从**原路径**读用户图，压缩产物直接 base64 进 HTML；压缩脚本落**系统 temp、用完即删**；不留任何中间图片副本。

## 8. 工程注意（踩过的坑）

- **缩放占位**：画布用 `transform: scale` 只缩视觉不缩布局，模板已用「`transform-origin: top left` + 负 margin」把占位收缩到缩放后尺寸——**别改回直接设小宽高**（会让外框阴影只包住左上角）。
- **导出**：html2canvas 对发光 text-shadow 的还原略弱于屏显，用户觉得弱就把发光滑杆 +10~15% 再导；一键导出首次会触发浏览器「允许下载多个文件」授权，交付时提示。
- **布局状态在内存**：刷新页面回默认坐标——交付时提醒「调好就导出，导出前别刷新」。
- **字体**：模板经字体服务引入（含手写体），首次打开需联网；断网回退系统字体、不阻塞。

## 9. 实例化后合规检查（交付前必过）

- [ ] 占位符零残留（全文检索 `__BG_` 无命中）；
- [ ] `T1_KEYS` 长度 = 各 cover 的 char div 数 = `maxlength` = DEFAULTS char 条目数；
- [ ] T1 初值两处一致（`#t1-text` value 与 `state.t1Text`）；
- [ ] DEFAULTS 三尺寸齐、每尺寸含全部图层条目；
- [ ] 发光 rgba 在 CSS 与 `applyT1Style()` 两处同色；
- [ ] 默认坐标避开用户分发平台的安全区（如 B 站横版底部 1/10 进度条灰化区、右上 1/8 角标区）；
- [ ] 能验就在浏览器验一遍：控制台零报错、三尺寸切换正常、图层可拖。
