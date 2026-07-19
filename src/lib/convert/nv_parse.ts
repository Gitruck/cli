/**
 * NodeVideo .nv JSON → IR v1（互转的输入侧）。
 *
 * 移植 hyperframes_poc/nv_raw_to_v1.py：
 *   - $id/$ref 对象图：不整树解引用（__RN__/__RP__ 回指祖先会成环），
 *     与 Python 同策略——遍历原始树，$ref 桩不展开；仅在「取参数通道」等
 *     定点访问处按 $id 表解引用（deref），兼容真实工程里参数被 $ref 共享的情况
 *   - 节点树 ChildList 递归；DataTransform 的 _position/_scale/_rotation/_opacity
 *     （position 归一[-1,1]自画布中心、scale 倍数、rotation 度、opacity[0,1]）
 *   - KeyFrames{_x,_y}：_x=节点内归一时间[0,1] → 绝对秒
 *   - DataEffect DataPath 末段 → IR op（DATAPATH_OP），参数轨按 NV_PARAM_RULE 换算
 *     （换算常数与 ir_to_nv.ts 的逆映射同一套，emit→parse 往返数值守恒）
 *   - 增强：节点 $type 直判层型（NodeFill→shape 等，Python 原版只能靠猜）；
 *     参数静态值也回读（Python 只回读关键帧轨）
 */
import type { IRFx, IRKeyframe, IRLayer, IRProject } from "./types";

type Dict = Record<string, unknown>;

// ---- 小工具 ----

const round = (v: number, p: number): number => {
  const k = 10 ** p;
  return Math.round(v * k) / k;
};
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const isDict = (o: unknown): o is Dict => !!o && typeof o === "object" && !Array.isArray(o);
const numOf = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);

function shortType(o: unknown): string {
  if (!isDict(o)) return "";
  const t = o.$type;
  return typeof t === "string" ? t.split(",")[0].split(".").pop() ?? "" : "";
}

/** zlib.crc32 等价（种子确定性用） */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(s: string): number {
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) c = CRC_TABLE[(c ^ s.charCodeAt(i)) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- $id 表 + 定点解引用 ----

function buildIdMap(root: unknown): Map<string, Dict> {
  const map = new Map<string, Dict>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    if (isDict(o)) {
      if (typeof o.$id === "string") map.set(o.$id, o);
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(root);
  return map;
}

/** {$ref:"n"} 桩 → 目标对象（一跳即可；非桩原样返回） */
function makeDeref(idMap: Map<string, Dict>): (o: unknown) => unknown {
  return (o: unknown): unknown => {
    if (isDict(o) && typeof o.$ref === "string") return idMap.get(o.$ref) ?? o;
    return o;
  };
}

type Deref = (o: unknown) => unknown;

// ---- 参数定位（nv_raw_to_v1.find_named 移植；$ref 桩不展开防成环）----

function findNamed(o: unknown, name: string): Dict | null {
  if (Array.isArray(o)) {
    for (const v of o) {
      const r = findNamed(v, name);
      if (r) return r;
    }
    return null;
  }
  if (isDict(o)) {
    if (o.Name === name && shortType(o).startsWith("P")) return o;
    for (const [k, v] of Object.entries(o)) {
      if (k === "NestedParams" || k.startsWith("$")) continue;
      if (v && typeof v === "object") {
        const r = findNamed(v, name);
        if (r) return r;
      }
    }
  }
  return null;
}

/** Params 容器 dict 键名直取 → 深搜兜底（与 ir_to_nv.getParam 同策略）*/
function getParam(container: unknown, name: string, deref: Deref): Dict | null {
  if (isDict(container)) {
    const p = container.Params;
    if (isDict(p)) {
      const hit = deref(p[name]);
      if (isDict(hit)) return hit;
    }
  }
  const found = findNamed(container, name);
  return found ? (deref(found) as Dict) : null;
}

/** PVector2 → [x通道, y通道]（PResConst 等变体的通道在 List 里，兜底兼容） */
function vec2Channels(p: Dict | null, deref: Deref): [Dict | null, Dict | null] {
  if (!p) return [null, null];
  const prm = Array.isArray(p.Params) ? p.Params : Array.isArray(p.List) ? p.List : null;
  if (prm && prm.length >= 2) {
    const x = deref(prm[0]);
    const y = deref(prm[1]);
    return [isDict(x) ? x : null, isDict(y) ? y : null];
  }
  return [null, null];
}

/** PFloat 参数 → [(t绝对秒, 值)]；无 kf 时回落静态 Value 单点 */
function kfTrack(param: Dict | null, nodeIn: number, nodeDur: number): [number, number][] | null {
  if (!param) return null;
  const kfs = param.KeyFrames;
  if (!Array.isArray(kfs) || kfs.length === 0) {
    const v = param.Value;
    return typeof v === "number" && isFinite(v) ? [[nodeIn, v]] : null;
  }
  const out: [number, number][] = [];
  for (const k of kfs) {
    if (!isDict(k)) continue;
    const x = k._x;
    const y = k._y;
    if (typeof x === "number" && isFinite(x) && typeof y === "number" && isFinite(y)) {
      out.push([round(nodeIn + clamp(x, 0, 1) * nodeDur, 3), y]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.length ? out : null;
}

// ---- DataPath → op / 默认参数 / 参数轨规则（nv_raw_to_v1.py 原表移植）----

const DATAPATH_OP: Record<string, string> = {
  _ChromaticAberration: "rgbSplit", _RGBSplit: "rgbSplit",
  _DirectionalBlur: "dirBlur", _MotionBlur: "dirBlur",
  _GaussianBlur: "blur", _RadialBlur: "blur",
  _Blur: "blur", _ZoomBlur: "blur", _Bokeh: "blur",
  _TurbulentDistortion: "turbulence", _Displace: "turbulence", _Wave: "turbulence",
  _Ripple: "turbulence", _Distort: "turbulence", _Turbulence: "turbulence",
  _Glow: "glow", _Bloom: "glow", _OpticalGlow: "glow",
  _Tint: "colorAdjust", _Curves: "colorAdjust", _HSL: "colorAdjust",
  _Exposure: "colorAdjust", _ColorAdjust: "colorAdjust", _LUT: "colorAdjust",
  _Levels: "colorAdjust", _Vibrance: "colorAdjust", _BasicCorrection: "colorAdjust",
  _MotionTile: "tile", _Mirror: "tile", _Tile: "tile",
  _Shake: "shake", _LensDistortion: "bulge",
  _FillColor: "fill", _LayerStyles2: "dropShadow",
  _UnsharpMask: "colorAdjust", _SolidColor: "fill",
  _ShiftChannels: "rgbSplit", _PinchBulge: "bulge",
  _Vignette: "vignette", _HeatWave: "turbulence",
  _ChromaKey: "keyed", _LumaKey: "keyed",
  _RipplePro: "turbulence", _Ripple2: "turbulence",
  _Squeeze: "bulge", _LensBlur: "blur", _SpinBlur: "blur",
  _RayBlur: "blur", _RGBBlur: "blur",
  _SoftGlow: "glow", _Rays2: "glow", _Invert: "invert", _Lut: "colorAdjust",
  _VoronoiDistortion: "turbulence", _Prism: "turbulence",
  _Stripes: "stripes", _GlitchWave: "glitch", _FindEdges: "edges",
  _RaindropPro: "particles", _Rainy: "particles", _SnowFlake: "particles",
};

const OP_TPL: Record<string, IRFx> = {
  glow: { op: "glow", color: "#9ab8ff", r: 22, inten: 1.3 },
  blur: { op: "blur", r: 8 },
  dirBlur: { op: "dirBlur", angle: 90, len: 12 },
  turbulence: { op: "turbulence", freq: 0.01, octaves: 2, disp: 16 },
  colorAdjust: { op: "colorAdjust", saturate: 1.12, contrast: 1.05 },
  rgbSplit: { op: "rgbSplit", amt: 5 },
  tile: { op: "tile" },
  shake: { op: "shake", mag: 18, freq: 15, decay: false },
  bulge: { op: "bulge", strength: 0.4, radius: 1.5 },
  fill: { op: "fill", color: "#e8ecf5", opacity: 0.5 },
  vignette: { op: "vignette", amt: 0.45 },
  keyed: { op: "keyed" },
  dropShadow: { op: "dropShadow", dx: 5, dy: 5, blur: 10, color: "rgba(0,0,0,.55)" },
  invert: { op: "invert" },
  stripes: { op: "stripes", angle_deg: 90, width_px: 24, gap_px: 24, color: "#ffffff", opacity: 0.9 },
  glitch: { op: "glitch", intensity: 0.5, bands: 6, seed: 0 },
  edges: { op: "edges", mode: "line", invert: false },
  particles: { op: "particles", kind: "rain", count: 18, seed: 0, size_px: 4, speed: 0.6, drift: 0.15 },
};

interface NvParseCtx {
  cw: number;
  ch: number;
  duration: number;
  warnings: string[];
  unknownFx: Set<string>;
  deref: Deref;
}

/** op → (候选参数名, NV值→IR值换算, 目标键)。"__zoom__" 特殊：tile 推拉转独立 zoom op */
type ParamRule = [string[], (v: number, ctx: NvParseCtx) => number, string];
const NV_PARAM_RULE: Record<string, ParamRule> = {
  tile: [["_tile_scale"], (v) => clamp(v, 0.05, 4), "__zoom__"],
  // 上限 240 与 AM 侧 mag 帽对齐（Python 原版 200，会截 AM 源工程的大幅抖动）
  shake: [["_mag", "_magnitude", "_strength", "_amount"], (v, c) => Math.min(Math.abs(v) * c.cw * 0.1, 240), "mag"],
  blur: [["_size", "_strength", "_amount", "_blur", "_blur_radius"], (v) => Math.min(Math.abs(v) * 60, 60), "r"],
  dirBlur: [["_size", "_strength", "_amount"], (v) => Math.min(Math.abs(v) * 45, 45), "len"],
  turbulence: [
    ["_strength", "_amount", "_intensity", "_size", "_scale", "_height", "_radius"],
    (v, c) => Math.min(Math.abs(v) * Math.min(c.cw, c.ch) * 0.25, 80),
    "disp",
  ],
  bulge: [["_size", "_strength", "_amount"], (v) => clamp(v, -2, 2), "strength"],
  colorAdjust: [["_exposure", "_brightness"], (v) => clamp(1 + v, 0.2, 3), "brightness"],
  glitch: [["_strength", "_amount", "_intensity", "_progress"], (v) => Math.min(Math.abs(v), 1), "intensity"],
};

// ---- PColor / 文本 ----

function findFirstPColor(o: unknown): Dict | null {
  if (Array.isArray(o)) {
    for (const v of o) {
      const r = findFirstPColor(v);
      if (r) return r;
    }
    return null;
  }
  if (isDict(o)) {
    if (shortType(o) === "PColor") return o;
    for (const [k, v] of Object.entries(o)) {
      if (k === "NestedParams" || k.startsWith("$")) continue;
      if (v && typeof v === "object") {
        const r = findFirstPColor(v);
        if (r) return r;
      }
    }
  }
  return null;
}

/** PColor {r,g,b,a}(0-1) → CSS（a=1 收敛 #rrggbb，与 ir_to_nv.cssToRgba01 互逆） */
function pcolorToCss(pc: Dict): string | null {
  let src: Dict = pc;
  if (isDict(pc.Value)) src = pc.Value as Dict;
  const r = src.r;
  const g = src.g;
  const b = src.b;
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") return null;
  const a = typeof src.a === "number" ? src.a : 1;
  const to255 = (v: number) => clamp(Math.round(v * 255), 0, 255);
  if (a >= 0.999) {
    const hex = (v: number) => to255(v).toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  return `rgba(${to255(r)},${to255(g)},${to255(b)},${round(a, 3)})`;
}

// ---- 层构建 ----

const NODE_TYPE_IR: Record<string, string> = {
  NodeMediaImage: "image",
  NodeMediaVideo: "video",
  NodeViewText2: "text",
  NodeText: "text",
  NodeGroup: "group",
  NodeFill: "shape",
  NodeAdjustment: "null",
  NodeMediaAudio: "null",
};

function toKfs(track: [number, number][], mapV: (v: number) => number): IRKeyframe[] {
  return track.map(([t, v]) => ({ t, v: mapV(v), e: null }));
}

function tracksEqual(a: [number, number][], b: [number, number][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i][0] - b[i][0]) > 1e-6 || Math.abs(a[i][1] - b[i][1]) > 1e-6) return false;
  }
  return true;
}

function buildLayer(node: Dict, ctx: NvParseCtx): IRLayer {
  const { cw, ch, deref } = ctx;
  const cx = cw / 2;
  const cy = ch / 2;
  const tl = isDict(node.TimeLine) ? (node.TimeLine as Dict) : {};
  const nin = clamp(numOf(tl.Pos, 0), 0, ctx.duration);
  const ndur = clamp(numOf(tl.Duration, ctx.duration) || ctx.duration, 0.02, ctx.duration);

  const props = Array.isArray(node.Props) ? (node.Props as unknown[]).map(deref).filter(isDict) : [];
  const dt = props.find((p) => shortType(p) === "DataTransform") ?? null;
  const effects = props.filter((p) => shortType(p) === "DataEffect");
  const textp = props.find((p) => ["DataText2", "DataText"].includes(shortType(p))) ?? null;

  const L: IRLayer = {
    id: String(node.Name ?? `N${crc32(String(node.UID ?? "")) % 10 ** 8}`),
    type: "image",
    in: round(nin, 3),
    out: round(Math.min(nin + ndur, ctx.duration), 3),
    pos: [round(cx, 1), round(cy, 1)],
  };

  // 变换
  const anim: Record<string, IRKeyframe[]> = {};
  if (dt) {
    const posp = getParam(dt, "_position", deref) ?? getParam(dt, "_3d_position", deref);
    if (posp) {
      const [xch, ych] = vec2Channels(posp, deref);
      const xt = xch ? kfTrack(xch, nin, ndur) : null;
      const yt = ych ? kfTrack(ych, nin, ndur) : null;
      if (xt) {
        L.pos[0] = round(cx + xt[0][1] * cx, 1);
        if (xt.length >= 2) anim.x = toKfs(xt, (v) => round(cx + v * cx, 1));
      }
      if (yt) {
        L.pos[1] = round(cy + yt[0][1] * cy, 1);
        if (yt.length >= 2) anim.y = toKfs(yt, (v) => round(cy + v * cy, 1));
      }
    }
    const scp = getParam(dt, "_scale", deref);
    if (scp) {
      const [xch, ych] = vec2Channels(scp, deref);
      const st = kfTrack(xch ?? scp, nin, ndur);
      const stY = ych ? kfTrack(ych, nin, ndur) : null;
      const mapS = (v: number) => round(clamp(v, 0.02, 4), 3);
      if (st && st.length >= 2) {
        if (stY && stY.length >= 2 && !tracksEqual(st, stY)) {
          anim.sx = toKfs(st, mapS);
          anim.sy = toKfs(stY, mapS);
        } else {
          anim.scale = toKfs(st, mapS);
        }
      }
    }
    const rotp = getParam(dt, "_rotation", deref);
    let rt = rotp ? kfTrack(rotp, nin, ndur) : null;
    if (!rt || rt.length < 2) {
      const r3 = getParam(dt, "_3d_rotation", deref);
      if (r3 && Array.isArray(r3.Params) && r3.Params.length) {
        const chn = deref(r3.Params.length > 2 ? r3.Params[2] : r3.Params[0]);
        if (isDict(chn)) rt = kfTrack(chn, nin, ndur);
      }
    }
    if (rt && rt.length >= 2) anim.rot = toKfs(rt, (v) => round(v, 1));
    for (const onm of ["_opacity", "_alpha", "_3d_opacity"]) {
      const opp = getParam(dt, onm, deref);
      const ot = opp ? kfTrack(opp, nin, ndur) : null;
      if (ot && ot.length >= 2) {
        anim.opacity = toKfs(ot, (v) => round(clamp(v, 0, 1), 3));
        break;
      }
    }
  }
  if (Object.keys(anim).length) L.anim = anim;

  // 类型 + 内容（$type 直判，Python 猜测法兜底）
  const nt = NODE_TYPE_IR[shortType(node)];
  const kids = Array.isArray(node.ChildList) ? (node.ChildList as unknown[]).map(deref).filter(isDict) : [];
  if (nt) L.type = nt;
  else if (textp) L.type = "text";
  else if (kids.length) L.type = "group";
  else L.type = "image";
  if (shortType(node) === "NodeMediaAudio") {
    ctx.warnings.push(`nv: 音频节点「${L.id}」无 IR 对应，以 null 层占位（音频内容不迁移）`);
  }

  if (L.type === "text") {
    const pText = textp ? getParam(textp, "_text", deref) : null;
    let txt: unknown = pText?.Text;
    if (typeof txt !== "string") txt = textp ? (textp as Dict).Text : undefined;
    if (typeof txt !== "string") txt = node.Name;
    L.text = String(txt ?? "文字").slice(0, 300);
    L.font = "700 90px 'Microsoft YaHei'";
    L.color = "#fff";
  } else if (L.type === "image" || L.type === "video") {
    L.asset = "slot";
    L.w = cw;
    L.h = ch;
    for (const key of ["AssetImage", "AssetVideo"]) {
      const a = deref(node[key]);
      if (isDict(a)) {
        const wv = numOf(a.Width, 0);
        const hv = numOf(a.Height, 0);
        if (wv > 0) L.w = Math.round(wv);
        if (hv > 0) L.h = Math.round(hv);
        const ap = typeof a.AbsolutePath === "string" ? a.AbsolutePath : "";
        const m = /placeholder_(.+?)\.(?:jpg|mp4)$/.exec(ap);
        if (m) L.asset = m[1];
      }
    }
  } else if (L.type === "shape") {
    const fillEff = effects.find((p) => String(p.DataPath ?? "").startsWith("_Fill/"));
    const pc = fillEff ? findFirstPColor(fillEff) : null;
    const css = pc ? pcolorToCss(pc) : null;
    L.shape = "rect";
    L.fill = css ?? "#3355aa";
    L.w = 400;
    L.h = 400;
  }

  // 特效（NodeFill 自身的 _Fill/ 填充效果不算特效）
  const fx: IRFx[] = [];
  const seen = new Set<string>();
  const rawFx: string[] = [];
  for (const e of effects) {
    const dp = String(e.DataPath ?? "");
    if (!dp) continue;
    if (L.type === "shape" && dp.startsWith("_Fill/")) continue;
    const seg = dp.split("/").pop() ?? "";
    const op = DATAPATH_OP[seg];
    if (op && !seen.has(op)) {
      seen.add(op);
      const o: IRFx = { ...(OP_TPL[op] ?? { op }), src: seg };
      if (op === "particles" && seg === "_SnowFlake") Object.assign(o, { kind: "snow", size_px: 8, speed: 0.35, drift: 0.5 });
      if (op === "glitch" || op === "particles") o.seed = crc32(`${seg}:${round(nin, 2)}`) % 9973;
      const rule = NV_PARAM_RULE[op];
      if (rule) {
        const [names, conv, key] = rule;
        for (const nm of names) {
          let pa: Dict | null = findNamed(e, nm);
          if (!pa) continue;
          pa = deref(pa) as Dict;
          // PVector2 参数取 x 通道
          const chn = shortType(pa) === "PVector2" ? vec2Channels(pa, deref)[0] : pa;
          if (!chn) continue;
          const tk = kfTrack(chn, nin, ndur);
          if (tk && tk.length >= 2) {
            const track: IRKeyframe[] = tk.map(([t, v]) => ({ t, v: round(conv(v, ctx), 3), e: null }));
            if (key === "__zoom__") {
              if (!seen.has("zoom")) {
                seen.add("zoom");
                fx.push({ op: "zoom", tracks: { scale: track }, src: `${seg}._tile_scale` });
              }
            } else {
              o.tracks = { [key]: track };
              o[key] = track[0].v;
            }
          } else if (tk && tk.length === 1 && key !== "__zoom__") {
            // 静态值回读（Python 只回读轨；这里补上静态强度）
            o[key] = round(conv(tk[0][1], ctx), 3);
          }
          break;
        }
      }
      fx.push(o);
    } else if (!op && seg) {
      rawFx.push(seg);
      ctx.unknownFx.add(seg);
    }
  }
  if (fx.length) L.fx = fx;
  if (rawFx.length) L.raw_fx = rawFx.slice(0, 10);

  // 子层
  if (L.type === "group" || kids.length) {
    L.type = "group";
    L.children = kids.map((c) => buildLayer(c, ctx));
  }
  return L;
}

// ---- 顶层入口 ----

function findProjectSetting(o: unknown, depth = 0): Dict | null {
  if (depth > 6) return null;
  if (Array.isArray(o)) {
    for (const v of o) {
      const r = findProjectSetting(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (isDict(o)) {
    if (String(o.$type ?? "").includes("DataProjectSetting")) return o;
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") {
        const r = findProjectSetting(v, depth + 1);
        if (r) return r;
      }
    }
  }
  return null;
}

/** 已 JSON.parse 的 .nv 根对象 → IR v1 */
export function parseNvObject(rootRaw: unknown): { ir: IRProject; warnings: string[] } {
  if (!isDict(rootRaw) || (!Array.isArray(rootRaw.ChildList) && !Array.isArray(rootRaw.Props))) {
    throw new Error(".nv 结构不对：顶层不是 NodeVideo 节点树（缺 ChildList/Props）");
  }
  const root = rootRaw as Dict;
  const idMap = buildIdMap(root);
  const deref = makeDeref(idMap);
  const warnings: string[] = [];

  // 画布/工程设置
  const proj = findProjectSetting(root) ?? {};
  let duration = NaN;
  for (const k of ["TotalTimeUsed", "Duration", "TotalTime"]) {
    const v = numOf((proj as Dict)[k], 0);
    if (v > 0) {
      duration = v >= 100 ? v / 1000 : v; // 启发式：≥100 视为毫秒
      break;
    }
  }
  if (!isFinite(duration)) {
    const tl = isDict(root.TimeLine) ? (root.TimeLine as Dict) : {};
    duration = numOf(tl.Duration, 3);
  }
  duration = round(clamp(duration || 3, 0.1, 3600), 3);

  let cw = numOf((proj as Dict).Width, 0) || numOf((proj as Dict).CanvasWidth, 0);
  let ch = numOf((proj as Dict).Height, 0) || numOf((proj as Dict).CanvasHeight, 0);
  if (!cw || !ch) {
    const res = getParam(proj, "_resolution", deref);
    const [rx, ry] = vec2Channels(res, deref);
    cw = cw || Math.round(numOf(rx?.Value, 0));
    ch = ch || Math.round(numOf(ry?.Value, 0));
  }
  if (!cw || !ch) {
    warnings.push("nv: 找不到画布分辨率，回落 1080×1920");
    cw = 1080;
    ch = 1920;
  }
  let fps = numOf((proj as Dict).FPS, 0);
  if (!fps) {
    const pfps = getParam(proj, "_fps", deref);
    fps = numOf(pfps?.Value, 0);
  }
  fps = clamp(fps || 30, 1, 120);

  const ctx: NvParseCtx = { cw, ch, duration, warnings, unknownFx: new Set(), deref };
  const kids = Array.isArray(root.ChildList) ? (root.ChildList as unknown[]).map(deref).filter(isDict) : [];
  const layers = kids.map((c) => buildLayer(c, ctx));
  if (!layers.length) warnings.push("nv: 工程里没有可识别的节点（可能是空工程）");
  for (const seg of ctx.unknownFx) {
    warnings.push(`nv: 特效「${seg}」未映射，已记入 raw_fx（转出时会被跳过）`);
  }

  const ir: IRProject = {
    v: 1,
    id: String((proj as Dict).ProjectName ?? "") || "nv-import",
    canvas: { w: cw, h: ch, fps: Math.round(fps * 1000) / 1000, duration, bg: "#0a0a12" },
    layers,
  };
  return { ir, warnings };
}

/** .nv JSON 文本 → IR v1 */
export function parseNvText(text: string): { ir: IRProject; warnings: string[] } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    const brief = e instanceof Error ? e.message.slice(0, 100) : String(e);
    throw new Error(`不是合法的 NodeVideo 工程：JSON 解析失败（${brief}）`);
  }
  return parseNvObject(root);
}

/** NodeVideo 工程包（.zip 内套 .nv，NV「导出工程包」产物）→ IR v1 */
export async function parseNvZip(buf: ArrayBuffer): Promise<{ ir: IRProject; warnings: string[] }> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buf).catch(() => {
    throw new Error("不是合法的 zip 压缩包，无法解开。");
  });
  const entry = Object.values(zip.files).find((f) => !f.dir && /\.nv$/i.test(f.name));
  if (!entry) {
    throw new Error("这个 zip 里没有 .nv 工程文件——NodeVideo 工程包内应包含一个 .nv。");
  }
  return parseNvText(await entry.async("text"));
}
