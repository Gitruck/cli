/* 合成颗粒工具箱 composite-kit@1（html@1 引擎）——`gtrk composite build` 构建时内联进每颗颗粒，颗粒自包含、不外链。
 * 随 @gitruck/cli 分发（assets/composite-kit/）；改行为即升版本号（颗粒 <meta name="generator"> 与 CP.VERSION 记着它）。
 *
 * 场景脚本只写一件事：`CP.render = (t) => { ... }`（t = 局部秒）。其余由这里负责：
 * - 宿主协议：hello → meta；init → 帧率 / 锚点 / 图层 / 字幕；apply(frame) → 画这一帧并回报槽位几何；lint → 排版自检；
 * - 分层：舞台缺省属 back，`data-layer="front"` 的子树属 front（visibility 继承）；
 * - 槽位几何：`[data-slot]` 的包围盒 + data-z / data-fit / data-shape / data-radius / data-filter / data-crop（上右下左）；
 * - 装饰跟随：`data-for="<槽位>"` 的元素与槽位同框（data-pad 外扩），用于边框、阴影、角标；
 * - 字幕：接管字幕后由颗粒自己排（`CP.caption`），文字来自 init.texts；
 * - 逐句换画面与版式切换：`at` / `mix` / `seq` / `place`；
 * - 排版自检 `lint`：下层画面的 front 描边压上层画面、front 线条穿过画面、画面越出舞台。
 * 纯函数：同一帧号永远画出同一画面；不用 Date / Math.random / requestAnimationFrame / setInterval。
 */
(() => {
  "use strict";
  const META = JSON.parse(document.querySelector("script[data-gtrk-composite]").textContent);
  const W = META.stage.width, H = META.stage.height;
  const stage = document.getElementById("stage");
  let FPS = (META.resolved && META.resolved.video_rate) || 60;
  let ANCHORS = (META.resolved && META.resolved.anchors_f) || {};
  let LAYER = "all";
  let TEXTS = {};

  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, p) => a + (b - a) * p;
  const ease = {
    out: (x) => 1 - Math.pow(1 - x, 3),
    inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
    back: (x) => { const c = 1.4; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); },
    lin: (x) => x,
  };
  const prog = (t, t0, dur, e = ease.out) => e(clamp((t - t0) / Math.max(dur, 1e-6)));
  /** 窗口内出现：t0 前 0，淡入 fi 秒到 1，t1 起淡出 fo 秒到 0。 */
  const span = (t, t0, t1, fi = 0.5, fo = 0.4) => Math.min(prog(t, t0, fi), 1 - prog(t, t1, fo, ease.inOut));
  const $ = (id) => document.getElementById(id);
  const A = (key) => {
    if (!(key in ANCHORS)) throw new Error("锚点「" + key + "」未解析");
    return ANCHORS[key] / FPS;
  };

  function box(el, x, y, w, h) {
    if (typeof el === "string") el = $(el);
    el.style.left = x + "px"; el.style.top = y + "px"; el.style.width = w + "px"; el.style.height = h + "px";
    return el;
  }
  /** 透明度 + 位移 / 缩放（不旋转——槽位与其装饰不得旋转）。 */
  function look(el, o = 1, dx = 0, dy = 0, s = 1) {
    if (typeof el === "string") el = $(el);
    el.style.opacity = String(clamp(o));
    el.style.transform = dx || dy || s !== 1 ? "translate(" + dx + "px," + dy + "px) scale(" + s + ")" : "";
    return el;
  }
  /** 槽位与跟随它的装饰一起定框；o 同时作用于两者。 */
  function slot(id, x, y, w, h, o = 1) {
    const el = document.querySelector('[data-slot="' + id + '"]');
    box(el, x, y, w, h); el.style.opacity = String(clamp(o));
    for (const d of document.querySelectorAll('[data-for="' + id + '"]')) {
      const p = Number(d.dataset.pad || 0);
      box(d, x - p, y - p, w + 2 * p, h + 2 * p); d.style.opacity = String(clamp(o));
    }
  }
  /** 槽位按矩形 [x, y, w, h] 定框（slot 的数组写法）。 */
  const at = (id, r, o = 1) => slot(id, r[0], r[1], r[2], r[3], o);
  /** 两个矩形之间插值（版式切换：单画 → 并排）。 */
  const mix = (a, b, p) => a.map((v, i) => lerp(v, b[i], p));
  /**
   * 逐句换画面的透明度：在 a 前 fade 秒淡入、a 时刻已全显；到 b（下一张已全显）之后直接关掉。
   * 同一位置叠放的几张画面按 data-z 递增排，下一张盖住上一张再关上一张——任一时刻最多两张在解码。
   */
  const seq = (t, a, b = null, fade = 0.3) => prog(t, a - fade, fade) * (b == null || t < b + 0.02 ? 1 : 0);
  /** 把元素放到 (x, y) 并给透明度（标签、角标跟随画面用）。 */
  function place(el, x, y, o = 1) {
    if (typeof el === "string") el = $(el);
    el.style.left = x + "px"; el.style.top = y + "px"; el.style.opacity = String(clamp(o));
    return el;
  }
  /** 逐字显现（p ∈ [0,1]）：未显现的字留占位但透明，排版不跳。 */
  function typeOn(el, text, p) {
    if (typeof el === "string") el = $(el);
    const n = Math.round(clamp(p) * text.length);
    const key = text + "|" + n;
    if (el.dataset.typed === key) return;
    el.dataset.typed = key;
    el.innerHTML = "";
    const a = document.createElement("span"); a.textContent = text.slice(0, n);
    const b = document.createElement("span"); b.textContent = text.slice(n); b.style.opacity = "0";
    el.append(a, b);
  }
  /** 字幕：取文本输入 slot 在第 f 帧的那一条；highlight 里的词加强调色。 */
  function cueAt(slotId, t) {
    const f = Math.floor(t * FPS + 1e-6);
    const list = TEXTS[slotId] || [];
    for (const c of list) if (f >= c.f0 && f < c.f1) return c;
    return null;
  }
  /** 显现：淡入 + 上浮（p ∈ [0,1]）。 */
  const reveal = (el, p, dy = 26) => look(el, p, 0, dy * (1 - p));
  /** 从左往右擦出。 */
  function wipe(el, p) {
    if (typeof el === "string") el = $(el);
    el.style.clipPath = "inset(-20% " + (100 - clamp(p) * 100).toFixed(2) + "% -20% 0)";
    el.style.opacity = p > 0 ? "1" : "0";
  }
  /** SVG 路径描边动画。 */
  function draw(el, p) {
    if (typeof el === "string") el = $(el);
    const L = el.getTotalLength();
    el.style.strokeDasharray = String(L);
    el.style.strokeDashoffset = String(L * (1 - clamp(p)));
  }
  /** 字幕；hide = [[t0, t1], …] 时段内不显示（屏上排版已经写着同一句话时用）。 */
  function caption(el, slotId, t, highlight = [], hide = []) {
    if (typeof el === "string") el = $(el);
    if (hide.some(([a, b]) => t >= a && t < b)) { el.style.opacity = "0"; return null; }
    const c = cueAt(slotId, t);
    const text = c ? c.text : "";
    const key = text + "|" + highlight.join(",");
    if (el.dataset.cue !== key) {
      el.dataset.cue = key;
      el.innerHTML = "";
      let rest = text;
      while (rest) {
        let hit = null, at = -1;
        for (const w of highlight) {
          const i = rest.indexOf(w);
          if (i >= 0 && (at < 0 || i < at)) { at = i; hit = w; }
        }
        if (!hit) { el.append(document.createTextNode(rest)); break; }
        if (at > 0) el.append(document.createTextNode(rest.slice(0, at)));
        const b = document.createElement("b"); b.textContent = hit; el.append(b);
        rest = rest.slice(at + hit.length);
      }
    }
    const age = c ? t - c.f0 / FPS : 0;
    el.style.opacity = c ? String(prog(age, 0, 0.12)) : "0";
    return c;
  }

  function applyLayer() {
    stage.style.visibility = LAYER === "front" ? "hidden" : "visible";
    for (const el of stage.querySelectorAll("[data-layer]")) {
      el.style.visibility = LAYER === "all" || el.dataset.layer === LAYER ? "visible" : "hidden";
    }
  }

  function measure() {
    const s = stage.getBoundingClientRect(), k = s.width / W;
    const out = [];
    for (const el of stage.querySelectorAll("[data-slot]")) {
      const r = el.getBoundingClientRect();
      const opacity = parseFloat(getComputedStyle(el).opacity);
      const crop = (el.dataset.crop || "0,0,0,0").split(",").map(Number);
      out.push({
        id: el.dataset.slot, z: Number(el.dataset.z || 0),
        x: (r.left - s.left) / k, y: (r.top - s.top) / k, w: r.width / k, h: r.height / k,
        opacity, visible: opacity > 0.001 && r.width > 0.5 && r.height > 0.5,
        shape: el.dataset.shape || "rect", radius: Number(el.dataset.radius || 0),
        fit: el.dataset.fit || "cover", filter: el.dataset.filter || "",
        crop: crop.length === 4 && crop.every((c) => c >= 0 && c < 1) ? crop : [0, 0, 0, 0],
      });
    }
    return out.sort((a, b) => a.z - b.z);
  }

  /**
   * 排版自检（只给出片台 / 构建工具用，宿主协议不依赖它）。查三类：
   * 1. 两张可见画面重叠，而下面那张有 front 层描边 —— 宿主先画全部画面、再画 front 镜像，
   *    下面那张的边框会压在上面那张画面上（同框交替淡入时两框重合，不算）；
   * 2. front 层的线条（path / line / polyline，按已画出的长度取点）穿过某张可见画面；
   * 3. 画面越出舞台（铺满舞台的底图除外）。
   */
  function lint() {
    const s = stage.getBoundingClientRect(), k = s.width / W;
    const op = (el) => { let o = 1; for (let e = el; e && e !== stage; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
    // 铺满舞台的画面是底图，压在它上面的任何东西都是有意叠加，不算穿模
    const slots = measure().filter((g) => g.visible && !(g.x <= 1 && g.y <= 1 && g.x + g.w >= W - 1 && g.y + g.h >= H - 1));
    const same = (a, b) => ["x", "y", "w", "h"].every((q) => Math.abs(a[q] - b[q]) < 2);
    const meet = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 2 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 2;
    const deco = (id) => [...stage.querySelectorAll('[data-for="' + id + '"][data-layer="front"]')].some((d) => op(d) > 0.01);
    const issues = [];
    for (const g of measure().filter((g) => g.visible)) {
      if (g.x < -1 || g.y < -1 || g.x + g.w > W + 1 || g.y + g.h > H + 1) {
        const full = g.x <= 1 && g.y <= 1 && g.x + g.w >= W - 1 && g.y + g.h >= H - 1;
        if (!full) issues.push({ kind: "slot-out-of-stage", slot: g.id });
      }
    }
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i], b = slots[j];
        if (!meet(a, b) || same(a, b)) continue;
        if (deco(a.id)) issues.push({ kind: "border-over-slot", lower: a.id, upper: b.id });
        else if (a.z === b.z && deco(b.id)) issues.push({ kind: "same-z-overlap", a: a.id, b: b.id });
      }
    }
    const inside = (g, x, y) => {
      if (g.shape === "circle") { const dx = (x - g.x - g.w / 2) / (g.w / 2), dy = (y - g.y - g.h / 2) / (g.h / 2); return dx * dx + dy * dy < 0.96; }
      return x > g.x + 3 && x < g.x + g.w - 3 && y > g.y + 3 && y < g.y + g.h - 3;
    };
    for (const p of stage.querySelectorAll('[data-layer="front"] path, [data-layer="front"] line, [data-layer="front"] polyline')) {
      if (op(p) < 0.01 || !p.getTotalLength) continue;
      const L = p.getTotalLength();
      const cs = getComputedStyle(p);
      const drawn = cs.strokeDasharray && cs.strokeDasharray !== "none" ? L - (parseFloat(cs.strokeDashoffset) || 0) : L;
      const m = p.getScreenCTM();
      const hit = new Set();
      for (let d = 0; d <= drawn; d += 6) {
        const q = new DOMPoint(p.getPointAtLength(d).x, p.getPointAtLength(d).y).matrixTransform(m);
        const x = (q.x - s.left) / k, y = (q.y - s.top) / k;
        for (const g of slots) if (!hit.has(g.id) && inside(g, x, y)) hit.add(g.id);
      }
      for (const id of hit) issues.push({ kind: "stroke-through-slot", stroke: p.id || p.tagName, slot: id });
    }
    return issues;
  }

  function fitStage() { stage.style.transform = "scale(" + innerWidth / W + ")"; }
  addEventListener("resize", fitStage); fitStage();

  const CP = (window.CP = {
    VERSION: "composite-kit@1",
    META, W, H, $, A, has: (k) => k in ANCHORS, clamp, lerp, ease, prog, span, box, look, slot, at, mix, seq, place, typeOn, cueAt, caption,
    reveal, wipe, draw, cues: (slotId) => TEXTS[slotId] || [], fps: () => FPS,
    render: () => {},
    /** init 之后调用一次（字幕等输入已就位）：按输入建一次性的 DOM。必须幂等。 */
    setup: () => {},
  });

  addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || m.ch !== "gtrk-composite") return;
    const reply = (x) => parent.postMessage(Object.assign({ ch: "gtrk-composite" }, x), "*");
    try {
      if (m.type === "hello") reply({ type: "meta", meta: META });
      else if (m.type === "init") {
        FPS = m.fps || FPS; ANCHORS = m.anchors || ANCHORS; LAYER = m.layer || "all"; TEXTS = m.texts || {};
        CP.setup(); applyLayer(); reply({ type: "ready", layer: LAYER });
      } else if (m.type === "apply") {
        CP.render(m.frame / FPS);
        reply({ type: "frame", seq: m.seq, frame: m.frame, slots: measure(), layer: LAYER });
      } else if (m.type === "lint") {
        // 回包类型不能也叫 lint：颗粒作为顶层页面跑（gtrk composite lint）时回包会回到自己的监听里，同名就会无限往返
        reply({ type: "lint-result", seq: m.seq, issues: lint() });
      }
    } catch (e) { reply({ type: "error", seq: m.seq, message: String((e && e.message) || e) }); }
  });
})();
