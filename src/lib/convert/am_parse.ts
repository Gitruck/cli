/**
 * AM XML / .amproj → IR v1（互转的输入侧）。
 *
 * 移植三份 Python 合一直出 IR v1：
 *   - scripts/am_to_ir.py       ：<scene> 层标签 / transform 通道 <kf t v e> / effect id+params
 *   - hyperframes_poc/am_ir_to_v1.py ：kf t 归一[0,1]→绝对秒、AM 色值→CSS、层型判定
 *   - hyperframes_poc/fx_ops_am.py   ：特效正向提取（换算常数与 ir_to_am.ts 的逆映射同一套，
 *                                      保证 emit→parse 往返数值守恒）
 *
 * 浏览器端用全局 DOMParser（测试端由 jsdom 提供同名实现）；
 * .amproj = zip[{uuid}.xml + manifest.txt]，用 jszip 动态 import 解包。
 */
import type { IRFx, IRKeyframe, IRLayer, IRProject } from "./types";

// ---- 基础常量（与 am_to_ir.py / ir_to_am.ts 对齐）----

const LAYER_TAGS = new Set([
  "image", "video", "audio", "text", "shape", "drawing", "embedScene",
  "element", "solid", "camera", "group", "nullObject",
]);

/** AM blending → IR blend（ir_to_am.BLEND_AM 取逆） */
const BLEND_IR: Record<string, string> = {
  screen: "screen",
  multiply: "multiply",
  overlay: "overlay",
  "linear-dodge": "add",
  lighten: "lighten",
  darken: "darken",
  "soft-light": "soft-light",
  "hard-light": "hard-light",
  difference: "difference",
  exclude: "exclusion",
  hue: "hue",
  color: "color",
};

/** ir_to_am 占位素材 label 标记（用于往返时还原 image/video 层型与 asset） */
const PLACEHOLDER_RE = /^\[占位:(image|video)(?::([^\]]*))?\]\s*(.*)$/;

// ---- 小工具 ----

const round = (v: number, p: number): number => {
  const k = 10 ** p;
  return Math.round(v * k) / k;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const intOf = (s: string | null | undefined, d = 0): number => {
  const v = parseInt(String(s ?? ""), 10);
  return isFinite(v) ? v : d;
};

const floatOf = (s: string | null | undefined, d = 0): number => {
  const v = parseFloat(String(s ?? ""));
  return isFinite(v) ? v : d;
};

/** "x,y,z" → number[]；解析失败 null */
function parseVec(s: string | null | undefined): number[] | null {
  if (s == null) return null;
  const parts = String(s).split(",").map((x) => parseFloat(x));
  if (!parts.length || parts.some((x) => !isFinite(x))) return null;
  return parts;
}

/** AM 颜色 #AARRGGBB / #RRGGBB → CSS（a=255 时收敛回 #rrggbb，保证往返幂等） */
function amColorToCss(c: string | null | undefined): string | null {
  if (!c) return null;
  const s = c.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{8}$/.test(s)) {
    const a = parseInt(s.slice(0, 2), 16);
    const rgb = s.slice(2).toLowerCase();
    if (a === 255) return `#${rgb}`;
    return `rgba(${parseInt(rgb.slice(0, 2), 16)},${parseInt(rgb.slice(2, 4), 16)},${parseInt(rgb.slice(4, 6), 16)},${round(a / 255, 3)})`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toLowerCase()}`;
  return null;
}

/** AM "cubicBezier a b c d" → CSS "cubic-bezier(a,b,c,d)" */
function convEase(e: string | null | undefined): string | null {
  if (!e || !e.includes("cubicBezier")) return null;
  const m = e.match(/[-\d.]+/g);
  if (!m || m.length < 4) return null;
  return `cubic-bezier(${m[0]},${m[1]},${m[2]},${m[3]})`;
}

// ---- XML 低层解析（am_to_ir.py 的 parse_prop_value / parse_effect）----

interface RawKf {
  t: number;
  v: string;
  e: string | null;
}

interface PropChan {
  static: string | null;
  kfs: RawKf[];
}

interface RawEffect {
  id: string;
  params: Record<string, PropChan>;
}

function childrenOf(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag);
}

function parseChan(el: Element): PropChan {
  const v = el.getAttribute("value");
  if (v !== null) return { static: v, kfs: [] };
  const kfs: RawKf[] = childrenOf(el, "kf").map((kf) => ({
    t: floatOf(kf.getAttribute("t"), 0),
    v: kf.getAttribute("v") ?? "",
    e: kf.getAttribute("e"),
  }));
  return { static: null, kfs };
}

function parseEffectEl(el: Element): RawEffect {
  const id = (el.getAttribute("id") ?? "").replace("com.alightcreative.effects.", "");
  const params: Record<string, PropChan> = {};
  for (const p of childrenOf(el, "property")) {
    const name = p.getAttribute("name");
    if (name) params[name] = parseChan(p);
  }
  return { id, params };
}

// ---- 特效正向提取（fx_ops_am.extract_fx 的 TS 移植，覆盖 ir_to_am 全部逆映射 id + 高频别名）----

const chanVal = (p: PropChan | undefined, d = 0): number => {
  if (!p) return d;
  if (p.static != null) {
    const v = parseFloat(String(p.static).split(",")[0]);
    return isFinite(v) ? v : d;
  }
  if (p.kfs.length) {
    const v = parseFloat(String(p.kfs[0].v).split(",")[0]);
    return isFinite(v) ? v : d;
  }
  return d;
};

const chanBool = (p: PropChan | undefined): boolean =>
  !!p && String(p.static ?? "").trim().toLowerCase() === "true";

const chanColor = (p: PropChan | undefined, d: string): string =>
  amColorToCss(p?.static ?? null) ?? d;

/** 参数关键帧轨 → IR 轨（绝对秒 + 换算 + 同刻去重；<2 帧返回 null） */
function chanTrack(
  p: PropChan | undefined,
  innS: number,
  outS: number,
  conv: (v: number) => number = (v) => v,
): IRKeyframe[] | null {
  if (!p || p.kfs.length === 0) return null;
  const dur = Math.max(0.001, outS - innS);
  const out: IRKeyframe[] = [];
  for (const k of p.kfs) {
    const raw = parseFloat(String(k.v).split(",")[0]);
    if (!isFinite(raw)) continue;
    out.push({ t: round(innS + clamp(k.t, 0, 1) * dur, 3), v: round(conv(raw), 3), e: convEase(k.e) });
  }
  out.sort((a, b) => a.t - b.t);
  const ded: IRKeyframe[] = [];
  for (const k of out) {
    if (ded.length && Math.abs(k.t - ded[ded.length - 1].t) < 1e-9) ded[ded.length - 1] = k;
    else ded.push(k);
  }
  return ded.length >= 2 ? ded : null;
}

/**
 * effects → (ops, ls 轨, 未映射 raw)。
 * innS/outS=层在场区间（秒），mn=min(画布宽,高)——与发射端同一换算基准。
 */
function extractFxAm(
  effects: RawEffect[],
  innS: number,
  outS: number,
  mn: number,
): { fx: IRFx[]; ls: IRKeyframe[] | null; raw: string[] } {
  const ops: IRFx[] = [];
  const raw: string[] = [];
  let ls: IRKeyframe[] | null = null;
  const ts = round(innS, 3);
  const te = round(outS, 3);

  for (const eff of effects) {
    const fid = eff.id || "?";
    const P = eff.params;
    const g = (name: string, d = 0): number => chanVal(P[name], d);
    const tr = (name: string, conv: (v: number) => number = (v) => v): IRKeyframe[] | null =>
      chanTrack(P[name], innS, outS, conv);

    if (fid === "tile" || fid === "autfeng.tile" || fid === "offset") {
      ops.push({ op: "tile", src: fid });
      const tSc = tr("scale", (v) => clamp(v, 0.05, 4));
      if (tSc) ops.push({ op: "zoom", tracks: { scale: tSc }, src: `${fid}.scale` });
    } else if (fid === "pulsate2" || fid === "autfeng.pulse" || fid === "autfeng.pulsatee") {
      const mx = g("maxsize", 1);
      const mnz = g("minsize", 1);
      const tMax = tr("maxsize");
      if (Math.abs(mx - 1) < 1e-3 && Math.abs(mnz - 1) < 1e-3 && !tMax) continue;
      const o: IRFx = { op: "pulsate", min: round(mnz, 3), max: round(mx, 3), freq: round(Math.max(g("freq", 2), 0.2), 2), t0: ts, t1: te, src: fid };
      if (tMax) o.tracks = { max: tMax };
      ops.push(o);
    } else if (fid === "shake" || fid === "shake2" || fid === "jitter" || fid === "autfeng.igshake") {
      const mag = g("mag");
      const tMag = tr("mag", (v) => Math.min(Math.abs(v), 240));
      if (Math.abs(mag) < 0.5 && !tMag) continue;
      const freq = fid === "shake" ? clamp(g("speed", 4) * 4, 1, 40) : clamp(g("freq", 12), 1, 40);
      const o: IRFx = { op: "shake", mag: round(Math.min(Math.abs(mag), 240), 1), freq: round(freq, 1), angle: round(g("angle"), 1), decay: false, t0: ts, t1: te, src: fid };
      if (tMag) o.tracks = { mag: tMag };
      ops.push(o);
    } else if (fid === "oscillate3" || fid === "oscillate2" || fid === "oscillate") {
      const mag = g("mag");
      const tMag = tr("mag", (v) => Math.min(Math.abs(v), 400));
      if (Math.abs(mag) < 0.5 && !tMag) continue;
      const o: IRFx = { op: "oscillate", mag: round(Math.min(Math.abs(mag), 400), 1), angle: round(g("angle", 90), 1), freq: round(clamp(g("freq", 4), 0.2, 30), 2), t0: ts, t1: te, src: fid };
      if (tMag) o.tracks = { mag: tMag };
      ops.push(o);
    } else if (fid === "swing2") {
      const a1 = g("a1");
      const a2 = g("a2");
      if (Math.abs(a1) < 0.1 && Math.abs(a2) < 0.1 && !tr("a1") && !tr("a2")) continue;
      ops.push({ op: "oscillate", rot: true, a1: round(a1, 1), a2: round(a2, 1), freq: round(clamp(g("freq", 2), 0.2, 20), 2), t0: ts, t1: te, src: fid });
    } else if (fid === "dblur" || fid === "streaks") {
      const s = g("strength");
      const conv = (v: number) => Math.min(Math.abs(v) * mn * 0.15, 60);
      const tLen = tr("strength", conv);
      if (Math.abs(s) < 1e-3 && !tLen) continue;
      const o: IRFx = { op: "dirBlur", angle: round(g("angle", fid === "streaks" ? 90 : 0), 1), len: round(conv(s), 1), src: fid };
      if (tLen) o.tracks = { len: tLen };
      ops.push(o);
    } else if (/^(motionblur[234]?|moblurplus|MotionBlurPro|autfeng\.(motionblur|MotionBlur))$/.test(fid)) {
      const conv = (v: number) => Math.min(Math.abs(v) * 4, 40);
      const tLen = tr("tune", conv);
      const ln = conv(g("tune", 1));
      if (ln < 0.5 && !tLen) continue;
      const o: IRFx = { op: "dirBlur", angle: 90, len: round(ln, 1), src: fid };
      if (tLen) o.tracks = { len: tLen };
      ops.push(o);
    } else if (/^(gaussianblur|lensblur2?|lensblurobs|bokehblur|BBC-Blur|innerblur(plus)?)$/.test(fid)) {
      const conv = (v: number) => Math.min(Math.abs(v) * 100, 60);
      const tR = tr("strength", conv);
      const s = g("strength");
      if (Math.abs(s) < 1e-3 && !tR) continue;
      const o: IRFx = { op: "blur", r: round(conv(s), 1), src: fid };
      if (tR) o.tracks = { r: tR };
      ops.push(o);
    } else if (fid === "zoomblur3") {
      const conv = (v: number) => Math.min(Math.abs(v) * 60, 45);
      const tR = tr("strength", conv);
      const s = g("strength");
      if (Math.abs(s) < 1e-3 && !tR) continue;
      const o: IRFx = { op: "blur", r: round(conv(s), 1), src: fid };
      if (tR) o.tracks = { r: tR };
      ops.push(o);
    } else if (fid === "deepglow") {
      ops.push({ op: "glow", color: "#9ab8ff", r: round(Math.min(g("strength", 0.15) * 80, 60), 1), inten: round(clamp(g("rrr", 1.2), 0.5, 3), 2), src: fid });
    } else if (fid === "edgeglow" || fid === "glow" || fid === "bloom" || fid === "softglow") {
      ops.push({ op: "glow", color: chanColor(P.fillColor, "#9ab8ff"), r: round(clamp(g("spread", 1.5) * 10, 6, 50), 1), inten: round(clamp(g("strength", 0.5) * 10, 0.5, 3), 2), src: fid });
    } else if (fid === "dropshadow") {
      ops.push({ op: "dropShadow", dx: 5, dy: 5, blur: 10, color: "rgba(0,0,0,.55)", src: fid });
    } else if (fid === "exposure") {
      const ev = g("exposure");
      const gm = g("gamma", 1);
      const conv = (v: number) => clamp(2 ** v, 0.2, 3);
      const tB = tr("exposure", conv);
      if (Math.abs(ev) < 1e-3 && Math.abs(gm - 1) < 1e-3 && Math.abs(g("offset")) < 1e-3 && !tB) continue;
      const o: IRFx = { op: "colorAdjust", brightness: round(conv(ev), 3), src: fid };
      if (Math.abs(gm - 1) > 1e-3) o.contrast = round(clamp(gm, 0.3, 2.5), 3);
      if (tB) o.tracks = { brightness: tB };
      ops.push(o);
    } else if (fid === "lift") {
      const fv = g("fill");
      const conv = (v: number) => clamp(1 + v, 0.2, 3);
      const tB = tr("fill", conv);
      if (Math.abs(fv) < 1e-3 && !tB) continue;
      const o: IRFx = { op: "colorAdjust", brightness: round(conv(fv), 3), src: fid };
      if (tB) o.tracks = { brightness: tB };
      ops.push(o);
    } else if (fid === "satvib" || fid === "hsl") {
      const sat = g("saturation");
      const conv = (v: number) => clamp(1 + v, 0, 2.5);
      const tS = tr("saturation", conv);
      if (Math.abs(sat) < 1e-3 && !tS) continue;
      const o: IRFx = { op: "colorAdjust", saturate: round(conv(sat), 3), src: fid };
      if (tS) o.tracks = { saturate: tS };
      ops.push(o);
    } else if (/^(curves|colorbalance|lut|newcolorize|colortune2|channelmap)$/.test(fid)) {
      ops.push({ op: "colorAdjust", saturate: 1.1, contrast: 1.05, src: fid });
    } else if (fid === "brightcont2") {
      const br = g("brightness");
      const ct = g("contrast");
      const conv = (v: number) => clamp(1 + v, 0.2, 3);
      const tB = tr("brightness", conv);
      if (Math.abs(br) < 1e-3 && Math.abs(ct) < 1e-3 && !tB) continue;
      const o: IRFx = { op: "colorAdjust", brightness: round(conv(br), 3), contrast: round(clamp(1 + ct, 0.3, 2.5), 3), src: fid };
      if (tB) o.tracks = { brightness: tB };
      ops.push(o);
    } else if (fid === "rgbsep") {
      const conv = (v: number) => Math.min(Math.abs(v) * 120, 24);
      const tA = tr("strength", conv);
      const s = g("strength");
      if (Math.abs(s) < 1e-3 && !tA) continue;
      const o: IRFx = { op: "rgbSplit", amt: round(conv(s), 1), angle: round(g("angle"), 1), src: fid };
      if (tA) o.tracks = { amt: tA };
      ops.push(o);
    } else if (fid === "chromabbr") {
      const conv = (v: number) => Math.min(Math.abs(v) * 2, 24);
      const tA = tr("amp", conv);
      const a = g("amp");
      if (Math.abs(a) < 1e-2 && !tA) continue;
      const o: IRFx = { op: "rgbSplit", amt: round(conv(a), 1), angle: 0, src: fid };
      if (tA) o.tracks = { amt: tA };
      ops.push(o);
    } else if (/^(turbulentdisplace3?|fractalwarp4?)$/.test(fid)) {
      const it = g("intensity", g("strength", 0.05));
      const conv = (v: number) => Math.min(Math.abs(v) * mn * 0.25, 80);
      const tD = tr("intensity", conv);
      if (Math.abs(it) < 1e-3 && !tD) continue;
      const o: IRFx = { op: "turbulence", disp: round(conv(it), 1), freq: round(0.012 / Math.max(g("scale", 1), 0.05), 4), octaves: 2, src: fid };
      if (tD) o.tracks = { disp: tD };
      ops.push(o);
    } else if (/^(pinchbulge2?|pinchbulgeinside|squeeze)$/.test(fid)) {
      const s = g("strength");
      const tS = tr("strength");
      if (Math.abs(s) < 1e-3 && !tS) continue;
      const o: IRFx = { op: "bulge", strength: round(clamp(s, -2, 2), 3), radius: round(g("radius", 1.5), 2), t0: ts, t1: te, src: fid };
      if (tS) o.tracks = { strength: tS };
      ops.push(o);
    } else if (fid === "wipe2") {
      const s0 = g("start", 0);
      const e0 = g("end", 1);
      const tS = tr("start");
      const tE = tr("end");
      if (!tS && !tE && s0 <= 0.01 && e0 >= 0.99) continue; // 全显且无动画 = 无效果
      const o: IRFx = { op: "wipe", kind: "linear", angle: round(g("angle", 90), 1), start: round(s0, 3), end: round(e0, 3), src: fid };
      const tks: Record<string, IRKeyframe[]> = {};
      if (tS) tks.start = tS;
      if (tE) tks.end = tE;
      if (Object.keys(tks).length) o.tracks = tks;
      ops.push(o);
    } else if (fid === "flicker2" || fid === "pulseopacity2" || fid === "blink2") {
      const mag = g("mag", g("strength", 0.6));
      if (Math.abs(mag) < 0.05 && !tr("mag") && !tr("strength")) continue;
      ops.push({ op: "flicker", mag: round(Math.min(Math.abs(mag), 1), 2), freq: round(g("freq", 8), 2), t0: ts, t1: te, src: fid });
    } else if (fid === "invert") {
      ops.push({ op: "invert", src: fid });
    } else if (fid === "flip3") {
      const tA = tr("angle");
      const o: IRFx = { op: "flip", deg: round(g("angle", 180), 1), src: fid };
      if (tA) o.tracks = { deg: tA };
      ops.push(o);
    } else if (fid === "stretch2") {
      const conv = (v: number) => clamp(v, 0.1, 4);
      const tS = tr("scale", conv);
      const sc = g("scale", 1);
      if (Math.abs(sc - 1) < 1e-2 && !tS) continue;
      const o: IRFx = { op: "stretch", scale: round(conv(sc), 3), angle: round(g("angle"), 1), src: fid };
      if (tS) o.tracks = { scale: tS };
      ops.push(o);
    } else if (fid === "chromakey" || fid === "lumakey" || fid === "colorkey") {
      ops.push({ op: "keyed", src: fid });
    } else if (fid === "vignette") {
      const st = g("strength", 1);
      if (Math.abs(st) < 0.05) continue;
      ops.push({ op: "vignette", amt: round(clamp(st * 0.45, 0.1, 0.8), 2), src: fid });
    } else if (fid === "textspacing") {
      const lst = chanTrack(P.letterspacing, innS, outS, (v) => v * 40);
      if (lst) ls = lst;
    } else {
      raw.push(fid);
    }
  }
  return { fx: ops, ls, raw };
}

// ---- 层构建 ----

interface AmParseCtx {
  seq: number;
  canvasW: number;
  canvasH: number;
  durationS: number;
  warnings: string[];
  unknownFx: Set<string>;
}

function buildLayer(el: Element, tBase: number, ctx: AmParseCtx): IRLayer {
  const tag = el.tagName;
  const st = intOf(el.getAttribute("startTime"), 0);
  const et = intOf(el.getAttribute("endTime"), 0);
  const inn = round(tBase + st / 1000, 3);
  const out = round(tBase + Math.max(et, st + 1) / 1000, 3);
  const label = el.getAttribute("label");

  // transform 通道
  const trEl = childrenOf(el, "transform")[0];
  const chan = (name: string): PropChan | undefined => {
    if (!trEl) return undefined;
    const c = childrenOf(trEl, name)[0];
    return c ? parseChan(c) : undefined;
  };

  const loc = chan("location");
  let pos: [number, number] = [round(ctx.canvasW / 2, 1), round(ctx.canvasH / 2, 1)];
  const locStatic = parseVec(loc?.static);
  if (locStatic && locStatic.length >= 2) pos = [round(locStatic[0], 1), round(locStatic[1], 1)];
  else if (loc?.kfs.length) {
    const v0 = parseVec(loc.kfs[0].v);
    if (v0 && v0.length >= 2) pos = [round(v0[0], 1), round(v0[1], 1)];
  }

  const anim: Record<string, IRKeyframe[]> = {};
  const dur = Math.max(0.001, out - inn);
  const absT = (t: number) => round(inn + clamp(t, 0, 1) * dur, 3);

  // location kfs → anim.x / anim.y
  if ((loc?.kfs.length ?? 0) >= 2) {
    const xs: IRKeyframe[] = [];
    const ys: IRKeyframe[] = [];
    for (const k of loc!.kfs) {
      const v = parseVec(k.v);
      if (!v) continue;
      const e = convEase(k.e);
      xs.push({ t: absT(k.t), v: round(v[0], 1), e });
      if (v.length > 1) ys.push({ t: absT(k.t), v: round(v[1], 1), e });
    }
    if (xs.length >= 2) anim.x = xs;
    if (ys.length >= 2) anim.y = ys;
  }

  // scale kfs → 等比走 scale，非等比拆 sx/sy
  const sc = chan("scale");
  if ((sc?.kfs.length ?? 0) >= 2) {
    const vecs = sc!.kfs.map((k) => ({ k, v: parseVec(k.v) })).filter((x) => x.v);
    if (vecs.length >= 2) {
      const uniform = vecs.every((x) => x.v!.length < 2 || Math.abs(x.v![0] - x.v![1]) < 1e-6);
      if (uniform) {
        anim.scale = vecs.map((x) => ({ t: absT(x.k.t), v: round(clamp(x.v![0], 0.02, 4), 3), e: convEase(x.k.e) }));
      } else {
        anim.sx = vecs.map((x) => ({ t: absT(x.k.t), v: round(clamp(x.v![0], 0.02, 4), 3), e: convEase(x.k.e) }));
        anim.sy = vecs.map((x) => ({ t: absT(x.k.t), v: round(clamp(x.v![1] ?? x.v![0], 0.02, 4), 3), e: convEase(x.k.e) }));
      }
    }
  }

  const rot = chan("rotation");
  if ((rot?.kfs.length ?? 0) >= 2) {
    const kfs = rot!.kfs
      .map((k) => ({ k, v: parseVec(k.v) }))
      .filter((x) => x.v)
      .map((x) => ({ t: absT(x.k.t), v: round(x.v![0], 1), e: convEase(x.k.e) }));
    if (kfs.length >= 2) anim.rot = kfs;
  }

  const op = chan("opacity") ?? chan("alpha");
  if ((op?.kfs.length ?? 0) >= 2) {
    const kfs = op!.kfs
      .map((k) => ({ k, v: parseVec(k.v) }))
      .filter((x) => x.v)
      .map((x) => ({ t: absT(x.k.t), v: round(clamp(x.v![0], 0, 1), 3), e: convEase(x.k.e) }));
    if (kfs.length >= 2) anim.opacity = kfs;
  }

  // 层骨架
  const L: IRLayer = { id: label || `L${++ctx.seq}`, type: "shape", in: inn, out, pos };
  const blend = el.getAttribute("blending");
  if (blend && BLEND_IR[blend]) L.blend = BLEND_IR[blend];

  const fillColorEl = childrenOf(el, "fillColor")[0];
  const fillCss = amColorToCss(fillColorEl?.getAttribute("value"));

  // 类型与内容
  if (tag === "text") {
    L.type = "text";
    const content = childrenOf(el, "content")[0]?.textContent ?? childrenOf(el, "string")[0]?.textContent ?? el.childNodes[0]?.nodeValue ?? "";
    L.text = String(content).trim().slice(0, 300);
    const size = clamp(floatOf(el.getAttribute("size"), 90), 4, 999);
    L.font = `700 ${Math.round(size)}px 'Microsoft YaHei'`;
    L.color = fillCss ?? "#ffffff";
    const align = el.getAttribute("align");
    if (align) L.align = align;
  } else if (tag === "embedScene" || tag === "group") {
    L.type = "group";
    const kids: Element[] = Array.from(el.children).filter((c) => LAYER_TAGS.has(c.tagName));
    for (const innerScene of childrenOf(el, "scene")) {
      kids.push(...Array.from(innerScene.children).filter((c) => LAYER_TAGS.has(c.tagName)));
    }
    L.children = kids.map((c) => buildLayer(c, inn, ctx));
  } else if (tag === "image" || tag === "video") {
    L.type = tag;
    L.asset = "slot";
    L.w = ctx.canvasW;
    L.h = ctx.canvasH;
  } else if (tag === "shape" || tag === "solid" || tag === "drawing") {
    // 尺寸（ir_to_am 落在 property name="size"）
    const sizeProp = childrenOf(el, "property").find((p) => p.getAttribute("name") === "size");
    const sizeVec = parseVec(sizeProp?.getAttribute("value"));
    const ph = label ? PLACEHOLDER_RE.exec(label) : null;
    if (ph) {
      // ir_to_am 的占位媒体 shape：还原层型/asset/id
      L.type = ph[1];
      if (ph[2]) L.asset = ph[2];
      else L.asset = "slot";
      L.id = ph[3] || L.id;
    } else {
      L.type = "shape";
      L.shape = el.getAttribute("s") === ".circle" ? "ellipse" : "rect";
      L.fill = fillCss ?? "#3355aa";
    }
    if (sizeVec && sizeVec.length >= 2) {
      L.w = round(sizeVec[0], 1);
      L.h = round(sizeVec[1], 1);
    } else if (L.type !== "shape") {
      L.w = ctx.canvasW;
      L.h = ctx.canvasH;
    } else {
      L.w = 400;
      L.h = 400;
    }
  } else {
    // audio / camera / element / nullObject：IR 无对应类型，null 层占位
    L.type = "null";
    if (tag === "audio") ctx.warnings.push(`am: 音频层「${L.id}」无 IR 对应，以 null 层占位（音频内容不迁移）`);
  }

  // 特效
  const effects = childrenOf(el, "effect").map(parseEffectEl);
  if (effects.length) {
    const { fx, ls, raw } = extractFxAm(effects, inn, out, Math.min(ctx.canvasW, ctx.canvasH));
    if (ls && L.type === "text") anim.ls = ls;
    if (fx.length) L.fx = fx;
    if (raw.length) {
      L.raw_fx = raw.slice(0, 10);
      raw.forEach((r) => ctx.unknownFx.add(r));
    }
  }
  if (Object.keys(anim).length) L.anim = anim;
  return L;
}

// ---- 顶层入口 ----

/** AM 工程 XML 字符串 → IR v1 */
export function parseAmXml(xml: string): { ir: IRProject; warnings: string[] } {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml");
  } catch (e) {
    throw new Error(`XML 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const errEl = doc.querySelector("parsererror");
  if (errEl) {
    const brief = (errEl.textContent ?? "").trim().split("\n")[0].slice(0, 120);
    throw new Error(`不是合法的 XML 文件（${brief || "解析器报错"}）`);
  }
  const root = doc.documentElement;
  if (root.tagName !== "scene") {
    throw new Error(`不是 Alight Motion 工程 XML：根元素是 <${root.tagName}>，应为 <scene>`);
  }

  const w = Math.max(4, intOf(root.getAttribute("width"), 1920));
  const h = Math.max(4, intOf(root.getAttribute("height"), 1080));
  const fps = clamp(floatOf(root.getAttribute("fps"), 30), 1, 120);
  const durationS = round(Math.max(100, intOf(root.getAttribute("totalTime"), 3000)) / 1000, 3);
  const bg = amColorToCss(root.getAttribute("bgcolor")) ?? "#0a0a12";

  const ctx: AmParseCtx = { seq: 0, canvasW: w, canvasH: h, durationS, warnings: [], unknownFx: new Set() };
  const layers = Array.from(root.children)
    .filter((c) => LAYER_TAGS.has(c.tagName))
    .map((c) => buildLayer(c, 0, ctx));

  if (!layers.length) ctx.warnings.push("am: 工程里没有可识别的图层（可能是空工程或不支持的结构）");
  for (const fid of ctx.unknownFx) {
    ctx.warnings.push(`am: 特效「${fid}」未映射，已记入 raw_fx（转出时会被跳过）`);
  }

  const ir: IRProject = {
    v: 1,
    id: root.getAttribute("title") || "am-import",
    canvas: { w, h, fps: Math.round(fps * 1000) / 1000, duration: durationS, bg },
    layers,
  };
  return { ir, warnings: ctx.warnings };
}

/** .amproj（zip 内嵌 {uuid}.xml）→ IR v1 */
export async function parseAmproj(data: ArrayBuffer | Blob): Promise<{ ir: IRProject; warnings: string[] }> {
  const { default: JSZip } = await import("jszip");
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error("无法解开 .amproj：不是有效的 zip 包（文件可能损坏或不是 Alight Motion 导出的工程包）");
  }
  const xmlName = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith(".xml") && !zip.files[n].dir);
  if (!xmlName) {
    throw new Error(".amproj 包里找不到工程 XML——可能不是 Alight Motion 工程包");
  }
  const xml = await zip.files[xmlName].async("string");
  return parseAmXml(xml);
}
