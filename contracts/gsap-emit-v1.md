# GSAP-emit 契约 v1 · HTML 动画颗粒的逐帧 seek 渲染合规

> **契约版本**：gsap-emit v1。产 HTML 动画颗粒、经同合云 `html_animate_render` 逐帧 seek 合成的 skill/工具，其产物 MUST 满足本契约。
> **边界**：本契约只约束机器可判定的管线消费属性（封装/注册/确定性/自包含/体积上限/依赖可达/禁 `var()`/字体名命中注册表）。颜色、字体取值、构图和节奏由调用方栏目规则决定。

## 原理（为什么不能用 CSS animation）

渲染引擎逐帧渲染时，靠调用每个子合成在 `window.__timelines` 注册的 GSAP 时间线的 `.seek(t)` 把画面定格到第 t 秒。GSAP `paused` 时间线 = 可被外部 seek 的虚拟时钟 → 逐帧正确；纯 CSS `animation-delay` 动画不在 `window.__timelines` 里，引擎 seek 不到 → 画面冻结。

## 回调与 seek 语义

> 颗粒可以用时间线回调（`onUpdate` 等）驱动画面；保证定帧时回调可达是渲染引擎侧的义务，不是颗粒作者的义务。本节是该主题的唯一口径来源。

- **引擎侧（MUST）**：定帧时必须保证 GSAP 时间线回调可达，使用 `seek(t, false)`、`time(t)`、`progress(p)` 或 `totalTime(t)` 等等价方式，不能使用默认会抑制回调的裸 `seek(t)`。
- **颗粒侧（MUST NOT）**：颗粒可以用 `onUpdate` / `onStart` / `onComplete` / `onRepeat` 写 DOM 或属性；不得运行时覆写 `tl.seek`，也不得替换 `window.__timelines[…]`。新颗粒不得添加 seek 垫片；已有垫片可在重渲复验后择期清理。
- **幂等回调**：逐帧 scrub 会反复触发回调，回调必须从当前补间状态重算画面，不得累加计数、追加数组或执行一次性 DOM 插入。
- **lint 哨兵**：`x-callback-driven`、`x-engine-api-override`、`x-raf-interval` 均为非致命提醒；它们用于提示引擎接口风险，不要求作者绕过契约自行添加垫片。

实验和版本证据见 [`gsap-emit-v1-evidence.md`](gsap-emit-v1-evidence.md)「回调与 seek 语义」节。

## 八条铁律（违反任一条 → 整片渲染失败 / 颗粒冻结 / 全黑 / 坑位内突兀消失 / 画面被切成横带）

1. **`<template>` 包裹根元素**：根元素必须位于 `<template>` 内，并带 `data-composition-id`、`data-width`、`data-height`。声明尺寸 MUST 为正整数且等于目标工程画幅；跨比例会拉伸，文字 IR 可在编译期按目标画幅缩放。
2. **GSAP `paused` 时间线 + 注册**：使用 `gsap.timeline({paused:true})`，并把时间线注册到 `window.__timelines["<id>"]`；`<id>` 必须等于根的 `data-composition-id`。
3. **确定性**：禁用 `Math.random`、`Date.now` 和无参 `new Date()`。需要随机感时使用固定种子、解析式或递归生成。
4. **自包含 + 实心底下沉子层 + 透明度显式声明**：颗粒不得依赖外部文件（脚本可由渲染管线 vendor 或可达 CDN 提供）。
   - 实心底 MUST 写在根下第一个全幅子层，MUST NOT 写在根元素 `style` 上。
   - 根元素 MUST 保持零视觉；透明 overlay MUST 在根显式写 `background:transparent`。
   - `gtrk mg lint` 按根与首个全幅子层的 `background` 推导 `opaque`；`4-bg-explicit` 与 `4-bg-on-root` 为非致命提示。
   - HTML 总长 MUST ≤ 2,000,000 个 JS UTF-16 码元，SHOULD ≤ 500,000；位图按实际显示尺寸裁剪缩放后再内嵌，不透明图优先 JPEG/WebP，需要 alpha 才用 PNG，超限则把大图放素材轨。
5. **脚本用渲染机可达的 CDN（编译期内联）**：使用 `lib.baomitu.com` GSAP 或渲染管线 vendor；不得依赖运行时相对路径。
6. **颜色/字体用字面值**：禁 CSS `var()` 自定义变量；SVG 属性同样适用。具名字体 MUST 命中渲染服务端注册表，并以 `sans-serif` / `serif` 通用族收尾；栏目主题在生成期替换字面值。
7. **占满坑位 + 终态驻留**：时间线总长 MUST ≥ 落轨 clip 的实际坑位时长（不是 `duration_hint`）。主叙事结束后定格或有限循环至坑位末尾；禁止 `repeat:-1`、整体渐隐到空或清空画面。循环次数按坑位算死：`repeat = ceil((坑位时长 − 循环起点) / 单圈时长) − 1`。
8. **重复图元合并**：同色、同 `stroke` / `fill`、整组同步驱动或静态的网格、排线、刻度、点阵 MUST 合并成单个元素；逐元素动画（stagger/逐条画入/逐个变色）可保留元素身份。该规则是作者侧规避，真实触发轴由渲染侧决定，命中批次 MUST 做真渲染抽帧验收。

> **⚠️ 铁律编号的唯一定义在本文件。** 栏目 skill / 作坊引用时直接写「gsap-emit v1 铁律 N」，不得另立同号条款；栏目自身规则请使用独立编号空间。

> 铁律 4 和铁律 8 的实验依据见 [`gsap-emit-v1-evidence.md`](gsap-emit-v1-evidence.md)。正文只保留当前可执行契约。

## 渲染成本：真卷积滤镜

> 本节约束逐帧成本，不改变八条正确性铁律；命中成本项时画面仍可能正确，lint 提示保持非致命、不拦铺轨。

### 射程

| 进射程（真卷积） | 射程外 |
|---|---|
| CSS `filter` / `-webkit-filter` / `backdrop-filter` 中的非零 `blur` 或带模糊半径的 `drop-shadow` | `blur(0)`、无模糊半径的 `drop-shadow`、`filter:none`、任何 `box-shadow` |
| SVG `feGaussianBlur` / `feDropShadow`（含 `filter:url(#id)` 引用） | `opacity`、`transform`、`mix-blend-mode`、`border-radius` |

`box-shadow` 整族不报警；铁律 4②管根元素绘制属性的位置，本节管卷积成本，两者互不冲突。

### 条文

- 真卷积每帧代价随**覆盖面积 × 模糊半径 × 帧数**增长。
- MUST NOT 用时间线补间驱动 `filter` 或 SVG `stdDeviation`；需要同一叙事动作时改用 `opacity` / `transform`，或做静态两态切换。
- 带静态滤镜的元素 MUST NOT 再用补间驱动 `transform`；优先拆分滤镜层与运动层，其次缩小覆盖面积，最后才考虑预烘。
- `gsap.set(el, {filter: …})` 只设一次属于静态形态；`opacity` 补间不在本节射程内。
- 整幅静态滤镜 SHOULD 缩小覆盖面积。预烘不是默认解法，确需预烘时 MUST 使用 RGBA PNG，并先做同颗对照；MUST NOT 用 JPEG 代替带 alpha 的颗粒素材。
- 判断权在作者，契约只规定成本机制与改法，不规定视觉取值。

### 维护边界

成本项保持非致命、不拦铺轨；实际收益取决于颗粒形态，不能把单批实验数字当成通用提速承诺。调整严重度时另开 change，并先复扫现网生产语料。实验和版本证据见 [`gsap-emit-v1-evidence.md`](gsap-emit-v1-evidence.md)。

## Alpha 交付口径

> 颗粒内一律使用直通 alpha；剪映 qtrle 交付由渲染管线负责预乘。颗粒与 CLI MUST NOT 再做第二次预乘。

1. **颗粒侧（MUST）**：颜色使用 `rgba(r,g,b,a)`、`#RRGGBBAA`、`opacity` 或渐变透明值；不得为迁就 NLE 自行把半透明色改暗或回避半透明。
2. **交付面**：客户端预览、本地 webm 和云端 overlay 合成使用直通 alpha；剪映 qtrle 由管线预乘。
3. **验收（MUST）**：含软光晕、渐变透明、带 blur 的 `text-shadow` 或 `opacity<1` 图层时，剪映验收必须使用本颗粒或同类半透明颗粒，不能用实心颗粒代验。
4. **哨兵**：`gtrk mg lint` 的 `x-soft-alpha` 为非致命提示，不拦铺轨、不要求作者改写。

## 模板颗粒（ir 态）的改法

> **一句话**：由 IR 编译出来的颗粒，改内容 **MUST 改 IR 再重编译**，**MUST NOT 直接改 HTML**。
> 词表、不变量、编译确定性与三态判定的正本在 infra capability `text-ir-profile`
> ，本节**只作导读、不复制规则**。

同合云的文字特效模板是由一份 **IR 文字子集**确定性编译出来的普通 gsap-emit v1 颗粒——
对本契约而言它和别的颗粒没有任何区别，`beat_track` 也不为它新增任何键。

区别只在**它自带出身证明**：编译产物在 `<template>` 内以
`<script type="application/json" data-gtrk-ir>` 内嵌完整 IR，并在首行注释写
`gtrk-ir-sha256` 与 `gtrk-html-sha256` 两个哈希。判定只看文件内容，不依赖文件名或目录。

| 三态 | 含义 | 还能云端改写吗 |
|---|---|---|
| `ir` | 内嵌 IR 在，且声明的 html 哈希与实测一致 | 能 |
| `detached` | 内嵌 IR 在但哈希对不上 ⇒ HTML 被直接改过 | 不能；可按内嵌 IR 重编回模板 |
| `html` | 无内嵌 IR（绝大多数颗粒） | 不能（本来也不需要） |

**手改 HTML 是单向操作**：改一个字节就从 `ir` 掉到 `detached`，`gtrk mg edit` 与客户端
属性面板都会拒绝它。颗粒本身照常能渲能铺，所以 `gtrk mg lint` 只给**非致命**的
`x-ir-detached` 提醒，不拦。

两条合法改法：
- **改字 / 换色 / 改字号描边阴影 / 改时长**：改 IR 后 `gtrk mg compile <ir.json>`（L0，0 积分）。
- **换效果**：`gtrk mg edit <particle.html> --say "<一句话>"`（经云端模型链，按候选计费）。

**内嵌的 JSON 块不参与渲染**，也不在本契约任何检查的射程内（它既没有 `src` 也不执行）。

## 颗粒骨架（中性模板）

```html
<template id="p">
<!-- 铁律4:根 MUST 零视觉。这里的 background 恒为 transparent(显式声明,不是省略),实心底一律下沉到下面的 .bgfill 子层 -->
<div data-composition-id="<id>" data-width="1920" data-height="1080"
     style="position:absolute;inset:0;background:transparent;overflow:hidden;font-family:'<你的字体·须命中服务端 font_manifest.json>',sans-serif;">
  <!-- 铁律4①:实心底 MUST 是根下第一个全幅子层。满屏颗粒填你栏目的底色;透明叠加(overlay)颗粒把整行删掉 -->
  <div class="bgfill" style="position:absolute;inset:0;background:<你的底色>;z-index:0;"></div>
  <style> [data-composition-id="<id>"] .xxx{ … } </style>   <!-- 样式用属性选择器作用域，防跨颗粒污染 -->
  <svg viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid meet" style="position:absolute;inset:0;width:100%;height:100%;">…</svg>
  <script src="https://lib.baomitu.com/gsap/3.13.0/gsap.min.js"></script>
  <script>(function(){
    var ROOT='[data-composition-id="<id>"]';
    /* 1) 确定性构建静态结构 */
    /* 2) gsap.set 初始态 */
    /* 3) var tl = gsap.timeline({paused:true}); … 编排 … */
    window.__timelines = window.__timelines || {};
    window.__timelines["<id>"] = tl;
  })();</script>
</div>
</template>
```

> **骨架里 `.bgfill` 那一行的三个要点**：① 它 MUST 是**根下第一个**子元素（后续前景层自然压在它之上，不必给前景排 z-index）；
> ② 它 MUST **全幅**（`position:absolute;inset:0`，或等价的 `top/left/width/height` 铺满）——不铺满就不是「实心底」；
> ③ 类名 `bgfill` 只是**惯例**，其底色写在**行内 style** 上（不靠 `<style>` 里的类规则），故不受「样式作用域」那条专属坑影响；
> 换名字不违约，但 `gtrk mg lint` 认的是「根下首个全幅子层的 `background`」这个**结构**，不认类名。

缓动可用 CustomEase 精确还原你栏目自己的 cubic-bezier（缺插件时给近似回退）——bezier 数值属于栏目审美，本契约不规定。

## 确定性配方（替代 random）

- 递归结构：固定角度、比例、深度参数 → 完全确定。
- "噪声感"：`Math.sin(i*0.18 + j*0.2)` 类解析式伪随机。
- 打散：用 index 派生（如 `i*137.5°` 黄金角），不要 `Math.random()`。

## 验证（交付前必做）

墙钟截图类工具驱动不了 paused 时间线（只看到 t=0），**不能**用来验收。必须真渲染引擎 seek 验证：
1. 颗粒放进最小 composition（root `index.html` 用 `data-composition-src` 引它）；
2. 走渲染管线（html_animate_render）渲染；
3. 抽不同时间点的帧**比对应当不同**（相同=冻结=铁律没守住）。客观自检：根有 `<template>`、`window.__timelines["<id>"]` 已注册且 id 匹配、无 random/Date、tl 总长 ≥ 颗粒时长、HTML ≤ 2,000,000 字符（铁律 4；`gtrk mg lint` 的 `4-html-size`）。
> ⚠️ 不要用「本地等价 seek 脚本 / Node 无头模拟」替代真引擎渲染——它不经真编译+挂载，无法覆盖 var()、CDN 内联和 StaticGuard 等真引擎行为。
>
> ⚠️ **客户端预览对「底色 / 透明度」类问题结构性失明，MUST NOT 用作这类验收的判据**。
> 客户端预览会按 clip 登记的 `opaque` 位**给颗粒根盒强行打底**（`!important`，恒胜过颗粒自身的设计期底色）——
> 于是无论根 `background` 有没有被丢弃、有没有实心底子层，**预览看到的都是「按登记值应该长的样子」**。
> 铁律 4 的证据锚正是靠**真渲染出片抽帧**取得的，不是靠预览。预览截图只作对照留档，不入判据。

## 专属坑

- **样式作用域**：颗粒与其他颗粒/根同处一个文档，全局类会撞——用 `[data-composition-id="<id>"] .xxx` 属性选择器作用域。
- **`<template>` 内的 `<script>` 默认不执行**——引擎把 template 内容克隆进文档后才执行；本地直接开浏览器不会跑，必须经引擎/player。
- **transform-origin（SVG）**：缩放 `<g>` 用 GSAP `svgOrigin:"x y"`（SVG 用户坐标），别用 CSS transform-origin。
- **时间线总长 ≥ 坑位时长**：颗粒 tl 总时长 ≥ 落轨 clip 时长（坑位包络），否则 seek 越界（已升格为铁律 7，含终态驻留要求）。
- **整组同步驱动的重复图元必须合并**：网格、排线、刻度、点阵用单元素表达，SVG 以一条 `<path>` 的多子路径合成；逐元素动画批次豁免。详见 gsap-emit v1 铁律 8。
- **真卷积滤镜别用补间驱动（也别让带滤镜的元素被 `transform` 补间驱动）、整幅静态滤镜先缩面积**：`blur()` / `drop-shadow()` / `feGaussianBlur` 按「面积 × 半径 × 帧数」增加每帧成本。预烘是次选、必须 RGBA PNG，先做同颗对照再用；`box-shadow` 整族不在射程内。详见本文件「渲染成本：真卷积滤镜」一节。
- **别用 `requestAnimationFrame`/`setInterval` 驱动画面**——不被 seek，等于冻结。所有视觉变化必须挂在 tl 上。（与「回调与 seek 语义」一节同源：任何**不经 tl** 的自有时钟都不被定帧驱动；而挂在 tl 上的回调是否被触发，则由该节的引擎侧条款保证。`gtrk mg lint` 对本条给**非致命**项 `x-raf-interval`——静态正则分不清「驱动画面」与其它用途，故只提醒不拦。）
- **自包含 ≠ 无限内嵌**：原图整张 base64 塞进颗粒会撞客户端 2,000,000 字符硬限。位图先按实际显示尺寸裁剪缩放再内嵌，大图走图片素材轨。详见铁律 4；`gtrk mg lint` 报 `4-html-size`（致命）/`4-html-size-heavy`（非致命）。
