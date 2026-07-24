# GSAP-emit 契约 v1 · HTML 动画颗粒的逐帧 seek 渲染合规

> **契约版本**：gsap-emit v1（2026-07-10；2026-07-24 增补铁律 7「占满坑位 + 终态驻留」，主理人硬性规定；同日铁律 6 增补字体注册表命中规则，对齐 gitruck-infra change `align-render-font-contract`）。产 HTML 动画颗粒、经同合云渲染管线（html_animate_render）逐帧 seek 合成的 skill/工具，其产物 MUST 满足本契约。
> **边界**：本契约只约束**机器可判定的管线消费属性**（封装/注册/确定性/自包含/依赖可达/禁 var()/字体名命中注册表）。画面长什么样——颜色、字体取值、构图、节奏——**一律由调用方按其栏目自身规则决定**，本契约不点名任何具体字体/颜色；文中示例取值均为中性占位。

## 原理（为什么不能用 CSS animation）

渲染引擎逐帧渲染时，靠调用每个子合成在 `window.__timelines` 注册的 GSAP 时间线的 `.seek(t)` 把画面定格到第 t 秒。GSAP `paused` 时间线 = 可被外部 seek 的虚拟时钟 → 逐帧正确；纯 CSS `animation-delay` 动画不在 `window.__timelines` 里，引擎 seek 不到 → 画面冻结（实测）。

## 七条铁律（违反任一条 → 整片渲染失败 / 颗粒冻结 / 全黑 / 坑位内突兀消失）

1. **`<template>` 包裹根元素**：`<template><div data-composition-id="<id>" data-width="1920" data-height="1080">…</div></template>`。编译器取的是 `<template>` 内容；裸 `<div>` 会被判 "empty or could not be parsed" 整片失败。（1920×1080 为**当前引擎版本约束**，分辨率参数化预留——升版时以本契约新版为准。）
2. **GSAP `paused` 时间线 + 注册**：`var tl = gsap.timeline({paused:true}); … window.__timelines = window.__timelines || {}; window.__timelines["<id>"] = tl;`。`<id>` 必须等于根的 `data-composition-id`。
3. **确定性**：禁用 `Math.random` / `Date.now` / 无参 `new Date()`（过不了引擎 StaticGuard）。要"随机感"用固定种子/解析式/递归生成（见「确定性配方」）。
4. **自包含 + 底色显式声明**：颗粒不依赖外部文件（除脚本 CDN）。**根底色透明与否必须显式声明**——全屏颗粒给根设明确 `background`（色值由调用方按栏目规则指定）；叠加在底轨上的透明颗粒根**不设** background。不显式想清楚这一层，叠加合成必出错。
5. **脚本用渲染机可达的 CDN（编译期内联）**：`<script src="https://lib.baomitu.com/gsap/3.13.0/gsap.min.js"></script>` 或由渲染管线 vendor 本地。⚠️ jsdelivr 在渲染服务器不稳（实测 compile 期 `fetch failed` → GSAP 未加载 → 整片全黑）。编译器**只内联 http(s) CDN、不内联相对本地路径**（写 `src="gsap.min.js"` 运行时 404）。
6. **颜色/字体用字面值，禁 CSS `var()` 自定义变量；字体名 MUST 命中服务端注册字体表**：编译器/挂载不可靠地解析 var()（字体映射把 `var(--font-body)` 当字面字体名；颜色 var() 不应用 → 整片全黑，实测）。直接写字面值（如 `#RRGGBB` / `'某字体名'`）；SVG 属性里同样禁 var()。栏目级换色/换主题 = **生成期**替换字面值（查调用方自己的词表/token 注入），不是运行时变量。**字体名规则（2026-07-24 增补）**：font-family 的每个具名家族 MUST 逐字符命中渲染服务端注册字体表（gitruck-infra 仓 `utils/assets/text/classic_template/font_manifest.json`，中英别名等价），并 SHOULD 以 `sans-serif`/`serif` 通用族收尾兜底；表外名字渲染不失败但**字形不保证**（服务端 fail-open 系统回退，2026-07-24 真机实锤：错名导致宋体被渲成回退黑体）。具体选哪款仍由调用方栏目规则决定，本契约不点名。
7. **占满坑位 + 终态驻留（2026-07-24 主理人硬性规定）**：颗粒时间线总长 MUST ≥ 它在成片中的**坑位时长**（落轨 clip 的实际时长，通常 = 派单槽位包络 `track_ed − track_st`，**不是** `duration_hint`）；动画主叙事播完后，颗粒 MUST 以「**定格保持**」或「**有限次循环**」驻留到坑位末尾——坑位内任意时刻（含最后一帧）核心内容必须可见。**禁止**「整体渐隐到空 / 全局退场 / 清空画面」类收尾：渐隐会与剪辑层转场冲突，淡出与否由剪辑/装配层决定，不在颗粒内做。局部元素可按叙事退场（黯淡/让位），但画面在坑位内不得归零；**定格不动是完全合法的终态**（不必为凑动作密度在尾段硬加动画）。违反表现 = 观感上「动画一过完整个颗粒突兀消失」（2026-07-24 回声定位真机实测）。

## 颗粒骨架（中性模板）

```html
<template id="p">
<div data-composition-id="<id>" data-width="1920" data-height="1080"
     style="position:absolute;inset:0;/* 底色显式声明:全屏颗粒填你栏目的底色,透明叠加则删除 background */background:<你的底色>;overflow:hidden;font-family:'<你的字体·须命中服务端 font_manifest.json>',sans-serif;">
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

缓动可用 CustomEase 精确还原你栏目自己的 cubic-bezier（缺插件时给近似回退）——bezier 数值属于栏目审美，本契约不规定。

## 确定性配方（替代 random）

- 递归结构：固定角度、比例、深度参数 → 完全确定。
- "噪声感"：`Math.sin(i*0.18 + j*0.2)` 类解析式伪随机。
- 打散：用 index 派生（如 `i*137.5°` 黄金角），不要 `Math.random()`。

## 验证（交付前必做）

墙钟截图类工具驱动不了 paused 时间线（只看到 t=0），**不能**用来验收。必须真渲染引擎 seek 验证：
1. 颗粒放进最小 composition（root `index.html` 用 `data-composition-src` 引它）；
2. 走渲染管线（html_animate_render）渲染；
3. 抽不同时间点的帧**比对应当不同**（相同=冻结=铁律没守住）。客观自检：根有 `<template>`、`window.__timelines["<id>"]` 已注册且 id 匹配、无 random/Date、tl 总长 ≥ 颗粒时长。
> ⚠️ 不要用「本地等价 seek 脚本 / Node 无头模拟」替代真引擎渲染——它不经真编译+挂载，测不出 var()-不解析、CDN-内联失败、StaticGuard 这类只在真引擎暴露的问题（实测教训：本地等价测试报 OK，真引擎全黑）。

## 专属坑

- **样式作用域**：颗粒与其他颗粒/根同处一个文档，全局类会撞——用 `[data-composition-id="<id>"] .xxx` 属性选择器作用域。
- **`<template>` 内的 `<script>` 默认不执行**——引擎把 template 内容克隆进文档后才执行；本地直接开浏览器不会跑，必须经引擎/player。
- **transform-origin（SVG）**：缩放 `<g>` 用 GSAP `svgOrigin:"x y"`（SVG 用户坐标），别用 CSS transform-origin。
- **时间线总长 ≥ 坑位时长**：颗粒 tl 总时长 ≥ 落轨 clip 时长（坑位包络），否则 seek 越界（已升格为铁律 7，含终态驻留要求）。
- **别用 `requestAnimationFrame`/`setInterval` 驱动画面**——不被 seek，等于冻结。所有视觉变化必须挂在 tl 上。
