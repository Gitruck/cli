---
name: gtrk-composite
description: 合成层包装（合成颗粒）——粗剪、B-roll、字幕都定了之后，把选定时间窗做成「合成」：一段时间内的整个画面由一颗代码颗粒接管（画中画拼贴、逐句换画面、对照并排、并列卡片、字幕排版），讲者与 B-roll 作为槽位画进去。三种入口：整片铺满 / 让 AI 判定哪里值得做 / 用户指定区间；候选窗口显示在客户端大纲的 CP 行。当用户想「做合成 / 合成层 / 整片做一下合成包装 / 哪里适合做合成 / 这段做成画中画拼贴 / 11 秒到 32 秒做个合成 / 逐句换画面 / 把字幕排进画面里」时使用本 skill，驱动 `gtrk composite`（plan → review → scaffold → build → lint → lay → bake），别手搓 HTML 铺进工程。
---

# 合成层包装（gtrk-composite）

把粗剪工程里选定的时间窗做成**合成颗粒**：在这段时间里，整个画面由一颗代码颗粒接管——它决定画面怎么排、何时换、字幕怎么出；讲者与 B-roll 作为**槽位**由客户端把视频画进去。**CLI 是手（定窗口、解析、校验、机检、铺轨），你是脑（判断这段该怎么排、选哪张画面、写场景）。**

> 本 skill 已含你需要的全部信息。命令参数以 `gtrk composite --help` 为准。规则正本：合成颗粒契约在 infra `composite-particle-profile`；`struct_meta.composite` 写方契约在本仓 `composite-command`。

## 你在成片 SOP 的哪一步

最后一层：**粗剪 → 拆分 → B-roll → MG → BGM → 字幕 → 合成 → 出片**。放在最后，是因为这时粗剪、B-roll、字幕都已定，合成颗粒的输入最稳定。但不写死：上游再改，对应颗粒在客户端变「需重渲」，重跑那几颗即可。

前置：
- 有粗剪工程（`<工程>/gtrk/project.gtrk`）和口播转写（`transcript/transcript.json`，新版 `gtrk oralcut` 恒出）。合成按**句**定窗口，没有转写就做不了。
- 字幕最好已上（`gtrk subtitle lay`）：合成颗粒可以接管字幕、自己排。
- `gtrk composite --help` 能跑（CLI 版本含本命令族）。

⚠️ **出片口径要先说清**：合成颗粒出片靠本机烘焙（`gtrk composite bake`，见「出片：烘焙」一节）——首次要装烘焙浏览器（约 110 MB），某颗烘焙失败时那一段按粗剪出画。用户要交付成片的话，这件事 MUST 在开工时告诉他。

## 入口：三选一（用户已说明就不再问）

| 用户说 | 入口 | 命令 |
|---|---|---|
| 「整片做一下合成」 | 整片铺满 | `gtrk composite plan --project <工程> --mode full` |
| 「看看哪里适合做」「帮我挑」 | AI 判定 | `gtrk composite plan --project <工程> --mode auto [--density 0.25]` |
| 「11 秒到 32 秒做一个」「u0004 到 u0009 那段」 | 用户指定 | `gtrk composite plan --project <工程> --range 11,32 --range u0020-u0024` |

- **整片铺满**：窗口首尾相接覆盖全片，单窗 5–25 秒、在句界（有拆分派单时在 beat 边界）断开。
- **AI 判定**：按信号打分（几秒内多个 B-roll 短镜头、列举、对照 / 转折、具体数字、章节转折、开场 / 收尾），总时长不超过密度上限（缺省全片 25%）。超出的记「超出上限」，**列出来让用户挑，不静默丢**。信号只是起点——你要读审稿稿里每个窗口「这段在说什么」，判断它是否真值得做，不值得的建议用户不要。
- **用户指定**：区间吸附到句界、投影到帧格，回执里写明两端各挪了多少毫秒；直接记为已采纳。

`plan` 把候选写进工程的 `struct_meta.composite`（只动这一个键），另出审稿稿 `<工程>/composite/plan.md`。重跑时已做好的窗口原样保留、用户不要的区间不再提。

### 检查点①（必停）：审窗口

请用户在客户端**重新载入工程**后看大纲的 **CP 行**：虚线框 = 待审，虚线框加浅底 = 已采纳，悬停能看理由与建议。同时把审稿稿的表格摘给他。他在对话里说哪些要、哪些不要、哪些调起止，你用 `review` 写回：

```bash
gtrk composite review --project <工程> --approve W01,W03 --reject W02 --adjust W04=80,90.9 --add 140,150
```

`--approve-all` 采纳全部待审。没有采纳的窗口，后面的步骤一概不做。

## 逐窗口：设计说明 → 选片 → 场景 → 构建 → 机检

```bash
gtrk composite scaffold --project <工程>          # 为已采纳窗口落场景骨架 composite/scenes/cp-wNN.html
                                                  # 与上下文 cp-wNN.context.md（这段在说什么、窗口内片段、已登记素材）
```

对每个窗口：

1. **先读上下文、写设计说明**（写进对话给用户看，或写在场景文件开头的注释里）：
   - 这段话分几拍？每拍对应哪句、哪个关键词？
   - 每拍画面是什么？为什么是一画 / 多画？（见下节规则 1）
   - 字幕怎么处理（接管后自己排 / 屏上已写着同一句时隐藏）。
2. **选片**（需要 `own` 槽位时）：

   ```bash
   gtrk composite shots --project <工程> --material <素材 id 或文件> --around 246 --span 20
   ```

   看联系表（每格左上是源时间码）、切点列表、黑边实测。入点与在场时长 MUST 落在一个镜头内（规则 5），`data-crop` 按黑边实测取（规则 3）。工程里还没登记的素材写进 `<工程>/composite/materials.json`（`[{ "id", "path", "duration" }]`），铺轨时一并登记。
3. **写场景**（格式见「场景写法速查」）。
4. **构建**：`gtrk composite build --project <工程> [--only cp-w03]`——按 infra 规则解析（帧格窗口、轨身份、锚点、字幕输入、`inputs_hash`）并校验，产 `<工程>/gtrk/assets/composite/<id>.html`。回执里每颗应为 `fresh`。
5. **机检**：`gtrk composite lint --project <工程> --stills 26,86.6`——静态校验 + 逐帧排版（下层画面的前景描边压上层画面、前景线条穿过画面、画面越出舞台），顺带出静帧。**不过就改场景重跑，过了才往下走。**
   - 退出码 3 = 本机找不到 Chrome / Edge，**排版没机检**：照实告诉用户，用静帧（或客户端预览）人眼逐颗查穿模，MUST NOT 当成通过。

### 检查点②：看静帧

每颗至少给用户 2–3 张关键时刻的静帧（换画面前后、拆分并排时、结尾）。快速成片模式下全部窗口做完后一次给。用户点头再铺：

```bash
gtrk composite lay --project <工程>              # 全量；--only cp-w03 只替换这颗
```

铺完请用户重新载入工程：CP 行上的提案块变成实色合成块，预览即合成效果。

## 出片：烘焙

铺完、用户确认后、出片前，先在本机把合成烤成视频（`gtrk render` / `gtrk project export` 也会自动先烤，单独跑便于先看结果）：

```bash
gtrk deps install --browser                  # 首次：装钉定版本的烘焙浏览器（约 110 MB）。MUST 先告诉用户再装
gtrk composite bake --project <工程>          # 全部合成；--only cp-w03 只烤这颗
```

- **缓存即复用**：没改过的颗粒二次运行全部命中；改了场景、素材文件、上游时间线或帧率才重烤。
- **没装钉定浏览器**也能烤（退回本机 Chrome / Edge，截图模式，更慢）——回执会提示，**MUST NOT 自作主张下载**；用户同意后再 `gtrk deps install --browser`，或本命令加 `--install-browser`。
- **某颗失败**（退出码 1）：其余照常。回执给出原因（常见：素材丢失、窗口为零、未解析——重跑 `build`）；修好再烤那一颗。不修的话出片时该段按粗剪出画，MUST 照实告诉用户。
- **出片时**：成功的那段以烘焙视频出画；**整段落在合成窗口内的 MG / OV 不再预渲、不计费**（被合成接管了）。
- 帧纯度（`lint` 的 `impure-frame`）不过的颗粒，烘焙段首帧会与连续播放不同——**lint 过了再烤**。

## 编排规则（每条都是测试工程走查时真犯过的）

1. **画面数由内容定，不照搬粗剪的轨结构。** 逐句看台词：一句话说到什么就换成什么；没有具体可看的，让讲者本人占画框或用纯排版；**只有内容本身是两个以上的东西才同时放多画**——关系（「你再指点妈妈」→ 女儿 / 妈妈并排）、对照（「她会化浓妆」VS「妈妈没化过妆」）、并列（「打耳钉 / 抽烟 / 喝酒」三张卡逐词亮起）。
   - ❌ 反例：粗剪在这段有两条 B-roll 候选轨，就放一个大框 + 一个小框，两条轨各占一个——画面数由轨数决定，跟内容无关。
   - 画面多用 `own` 槽位按内容另挑入点（粗剪轨上的片段只是候选之一）；用 `ref-lane` 的前提是那条轨在这段的时序恰好就是你要的。
2. **任一时刻画面互不重叠。** 客户端先画全部画面、再画前景层，**下层画面的前景描边一定压在上层画面上**。同一位置交替换画面时，**等前一张的框到位、两框重合后再换**（`seq` 已按此写）；版式切换（一画 → 并排）时，先让旧画面缩到位，新画面再进来。讲者不在同一时刻出现两次（大框里是讲者时不放讲者圆窗）。
   - ❌ 反例：讲者圆窗与小画面叠在大画框的边线上，边线横穿它们；分叉曲线从一张画中画中间穿过去。
3. **裁掉画面里的黑边与烧录字幕。** 电影源常带信箱黑边，综艺源常有烧录字幕与人名条；按 `shots` 的实测写 `data-crop="上,右,下,左"`（比例）。
   - ❌ 反例：画框里留一道黑带。
4. **人脸构图：眼睛落在上三分线附近，头顶留约一成余量。** 讲者大框、圆窗、素材里的人脸都一样。
   - ❌ 反例：裁切把眼睛放在画框正中，头顶上方空出一大片窗户。
5. **选片不跨切点。** `own` 的取用段 `[入点, 入点 + 在场时长)` MUST 落在一个镜头内；镜头不够长就接受最后一帧定格或换一个镜头，MUST NOT 拉伸或变速。
6. **字幕：接管就自己排。** 场景声明 `takeover: ["subtitles","overlay"]` 后，窗口内原字幕与 MG 叠层不再显示，字幕由场景用 `caption()` 或对话气泡排出；屏上排版已经写着同一句话时可以在那段隐藏字幕。
7. **先求准，再求满。** AI 判定模式的密度上限是对成片吵闹度的约束；整片铺满时也要让「没有具体可看的段」安静（讲者 + 少量排版），别为了铺满每段都堆画面。

## 场景写法速查

场景文件四段：

```html
<script type="application/x-cp-spec">
{
  "id": "cp-w03",
  "window": [77.483, 90.85],                      // 时间线秒；build 会吸附到帧格
  "takeover": ["subtitles", "overlay"],
  "slots": {
    "teacher": { "bind": { "kind": "ref-lane", "role": "a-roll" }, "label": "讲者", "pin": { "track": 0 } },
    "heavy":   { "bind": { "kind": "own", "facet": "化浓妆的少女近景", "starts_at": "浓妆" }, "label": "浓妆",
                 "pin": { "material": "broll-local-xxx", "src_in_ms": 116250, "dur_t": 3.8, "starts_at_f": "浓妆" } },
    "subs":    { "bind": { "kind": "text", "source": "subtitles" }, "label": "字幕" }
  },
  "anchors": { "浓妆": ["u0026", "特别会化浓妆"], "因为妈妈": ["u0028", "因为妈妈"] }
}
</script>
<style> /* 这颗的版式 */ </style>
<div class="bed dark"></div>
<div class="shadow" data-for="heavy" style="border-radius:16px"></div>
<div data-slot="heavy" data-z="11" data-fit="cover" data-shape="roundrect" data-radius="16" data-crop="0,0,0.2,0"></div>
<div class="frame light thin" data-for="heavy" data-layer="front" style="border-radius:16px"></div>
<div id="tg1" class="ptag warm" data-layer="front">浓妆</div>
<div id="cap" class="cap dark" data-layer="front"></div>
<script>
const { A, prog, at, mix, seq, place, reveal, caption, ease } = CP;
const R = [96, 120, 1160, 652];
CP.render = (t) => {
  at("heavy", R, seq(t, A("浓妆")));
  place("tg1", R[0] + 20, R[1] + 20, seq(t, A("浓妆")));
  caption("cap", "subs", t, ["浓妆"]);
};
</script>
```

- **槽位绑定**：`ref-lane {track}`（某条轨在该时刻的画面，讲者常用）；`ref {clip_id}`（某个片段，窗口外定格首末帧）；`own {material, src_in_ms, dur_t | dur_f, starts_at: 锚点名 | starts_at_t: 时间线秒}`（自选素材的一段；之前首帧、之后末帧定格）；`text`（字幕文本输入，无几何）。
- **锚点**：`[句 id, 关键词, 第几处(0 起)]`，取关键词首字在时间线上的时刻；场景里 `A("名字")` 得局部秒。关键词所在的字被剪掉时取其后第一个保留的字。
- **槽位元素**：`data-slot` 一槽一个；`data-z` 叠放次序；`data-fit` cover / contain；`data-shape` rect / roundrect / circle；`data-crop` 上右下左比例；`data-filter` 只收白名单滤镜。
- **装饰跟随**：`data-for="<槽位>"` 的元素与槽位同框（`data-pad` 外扩）；`.shadow` 在下（背景层），`.frame` / `.ring` 加 `data-layer="front"` 在上——**只给最上层的画面加前景描边**（规则 2）。
- **分层**：缺省是背景层（画在视频之下）；`data-layer="front"` 的子树在视频之上（文字、标签、描边、线条）。
- **工具箱 `CP`**：`prog(t, 起, 时长, ease)` 进度；`span` 进出；`at(id, [x,y,w,h], 透明度)` 定框；`mix(矩形A, 矩形B, p)` 版式插值；`seq(t, 到点, 下一张到点)` 同一位置逐句换画面的透明度；`place(el, x, y, o)`；`reveal / look / wipe / draw / typeOn`；`caption(el, "subs", t, 高亮词[], 隐藏区间[])`；`cues("subs")` 取字幕条目（局部帧）；`fps()`。
- **常用样式**：`.bed`（底色）/ `.bed.dark`；`.kicker` `.h1` `.h2` `.h3` `.body` `.tag` `.num`；`.ptag` / `.ptag.warm`（画面标签）；`.cap` / `.cap.dark`（字幕）；`.bubble`（对话气泡）；`.stamp`（印章）；`.card` `.pill` `.rule`。配色与字体都是变量：`--bg --bg2 --ink --muted --line --accent --accent2 --accent3 --alert --font --font-serif`。
- **纯函数**：场景脚本 MUST NOT 用 `Date`、`Math.random`、`requestAnimationFrame`、`setInterval`、`setTimeout`（lint 会拦）——同一帧号永远画出同一画面，客户端是逐帧 seek 的。

## 风格

配色、字体、纹理不在工具箱里，写在 `<工程>/composite/theme.css`（构建时接在工具箱样式之后，覆盖上面那组变量）：

- 当前栏目配置 `style.skills` 里有 `produces == "composite"` 的条目 → 触发它产 `theme.css`（与 `gtrk-mg`、`gtrk-ai-drama` 的栏目解析同一套）；
- 没有 → 按这条片子的内容临场定一套（讲什么、什么调性 → 配色倾向、字体气质、动效克制度），**全片所有合成颗粒沿用同一套**。MUST NOT 每颗各自为政，也 MUST NOT 套一个与内容无关的固定模板。

## 与 `/gtrk-mg` 的分工

- 单一陈述的字卡、点题强调、透明叠层 → MG；
- 一段时间内的整个画面（画中画拼贴、逐句换画面、对照并排、字幕排版）→ 合成。
- 同一区间二者只取其一：合成声明 `takeover: overlay` 后，MG 叠层在窗口内不显示。已有满屏 MG 的段，AI 判定不会提。

## 排错

| 现象 | 处理 |
|---|---|
| build 报「素材 X 未登记」 | 写进 `composite/materials.json`（`id` + `path`），或换工程里已登记的素材 |
| build 报「锚点落在窗口外 / 找不到关键词」 | 关键词照句子原文抄（看 `context.md`），或换一个落在窗口内的词 |
| build 报「轨 N 在窗口内没有片段」 | 那条轨这段是空的：换轨，或改用 `own` |
| lint 报 `border-over-slot` | 两张画面重叠且下层有前景描边：错开时序（等前一张到位再换）或去掉下层的前景描边 |
| lint 报 `stroke-through-slot` | 前景线条穿过画面：挪画面或改线条走向 |
| lint 报 `slot-out-of-stage` | 画面出了舞台：收回到 1920×1080 内（满屏底图除外） |
| lint / lay 报「需重渲」 | 上游（粗剪 / 素材 / 字幕）改过：重跑 `build`（再 `lint`、`lay`） |
| lint 退出码 3 | 本机没 Chrome / Edge：排版未机检，用静帧人眼查，照实告诉用户 |
| lint 报 `impure-frame` | 同一帧号随渲染顺序画出不同画面：多半读了带变换元素的渲染后几何（如对正在缩放的元素用 `getBoundingClientRect` 量宽度）——改读 `offsetWidth` / `offsetLeft` 等不含变换的布局值 |
| bake 报「找不到可用的浏览器」（退出码 2） | 本机没有钉定浏览器也没有 Chrome / Edge：征得用户同意后 `gtrk deps install --browser` |
| bake 报「素材缺失：<路径>」 | 素材移动或删除了：恢复文件或重新登记路径后再烤这颗 |
| lay 报「没铺：时间线上已有同 id 的片段」 | 用户在客户端改过那颗：要重铺先请他在客户端删掉它 |
| 客户端 CP 行没出现提案块 | 请用户重新载入工程（外部写入要重载才读进来） |

## 双模式

| 模式 | 停点 |
|---|---|
| 快速成片 | 检查点①（审窗口）必停；全部窗口做完、lint 过后，检查点②一次给静帧，点头后一次铺完 |
| 逐步推进 | 检查点①；每个窗口的设计说明、静帧各停一次 |
