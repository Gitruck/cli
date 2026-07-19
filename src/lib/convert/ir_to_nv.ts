/**
 * IR v1 → NodeVideo .nv（模板法）。
 *
 * 流程：
 *   1. nv_templates.json（tools/harvest_nv_templates.py 从真机样本收割）按 IR 层结构组装节点树
 *   2. 注入差异参数（TimeLine/位置/缩放/旋转/透明度/文本/媒体占位/特效强度）
 *      + 关键帧 KeyFrames{_x,_y,Interpolation,Ease,CP0/CP1}
 *   3. 移植 scripts/nv_roundtrip.py 已真机验证的重建算法：DFS 顺序重编 $id + $ref 路径锚定还原
 *
 * NV 单位约定（nv_raw_to_v1.py 的取逆）：
 *   position 归一 [-1,1] 从画布中心；scale 倍数；rotation 度；opacity [0,1]；
 *   kf._x = 节点内归一时间 [0,1]，kf._y = 参数值。
 */
import templatesJson from "./nv_templates.json";
import type { ExportResult, IRFx, IRKeyframe, IRLayer, IRProject } from "./types";
import { num } from "./types";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;
type Dict = Record<string, unknown>;

interface TemplateBlob {
  meta: {
    kfDefaults: { combo: number[] };
    [k: string]: unknown;
  };
  defs: unknown[];
  root: unknown;
  nodes: Record<string, unknown>;
  effects: Record<string, unknown>;
}

const TPL = templatesJson as unknown as TemplateBlob;

// ---- 模板池展开（{"__D__":n} → defs[n] 深拷贝） ----

function inflate(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(inflate);
  if (x && typeof x === "object") {
    const o = x as Dict;
    if (typeof o.__D__ === "number" && Object.keys(o).length === 1) {
      return inflate(TPL.defs[o.__D__ as number]);
    }
    const out: Dict = {};
    for (const [k, v] of Object.entries(o)) out[k] = inflate(v);
    return out;
  }
  return x;
}

function isMarker(o: Dict): boolean {
  const keys = Object.keys(o);
  return keys.length === 1 && (keys[0] === "__R__" || keys[0] === "__RP__" || keys[0] === "__RN__");
}

/** 模板实例落位：内部相对 __R__ 改写成绝对路径（__RP__/__RN__ 留给 rebuild 按祖先解析） */
function anchorRefs(x: unknown, basePath: string): void {
  if (Array.isArray(x)) {
    x.forEach((v) => anchorRefs(v, basePath));
    return;
  }
  if (x && typeof x === "object") {
    const o = x as Dict;
    if (typeof o.__R__ === "string" && Object.keys(o).length === 1) {
      o.__R__ = basePath + (o.__R__ as string);
      return;
    }
    for (const v of Object.values(o)) anchorRefs(v, basePath);
  }
}

// ---- 参数定位/注入 ----

function shortType(o: unknown): string {
  if (!o || typeof o !== "object" || Array.isArray(o)) return "";
  const t = (o as Dict).$type;
  return typeof t === "string" ? t.split(",")[0].split(".").pop() ?? "" : "";
}

/** 在对象里找 Name===name 的 P* 参数（跳过 NestedParams 修饰通道） */
function findParam(o: unknown, name: string): Dict | null {
  if (Array.isArray(o)) {
    for (const v of o) {
      const r = findParam(v, name);
      if (r) return r;
    }
    return null;
  }
  if (o && typeof o === "object") {
    const d = o as Dict;
    if (d.Name === name && shortType(d).startsWith("P")) return d;
    for (const [k, v] of Object.entries(d)) {
      if (k === "NestedParams") continue;
      if (v && typeof v === "object") {
        const r = findParam(v, name);
        if (r) return r;
      }
    }
  }
  return null;
}

/** Params 容器（dict 键名直取 → 深搜兜底） */
function getParam(container: unknown, name: string): Dict | null {
  if (container && typeof container === "object" && !Array.isArray(container)) {
    const p = (container as Dict).Params;
    if (p && typeof p === "object" && !Array.isArray(p)) {
      const hit = (p as Dict)[name];
      if (hit && typeof hit === "object") return hit as Dict;
    }
  }
  return findParam(container, name);
}

/** PVector2 → [xch, ych]（PResConst 等变体的通道在 List 里，兜底兼容） */
function vec2Channels(p: Dict | null): [Dict | null, Dict | null] {
  if (!p) return [null, null];
  const prm = Array.isArray(p.Params) ? p.Params : Array.isArray(p.List) ? p.List : null;
  if (prm && prm.length >= 2) {
    return [prm[0] as Dict, prm[1] as Dict];
  }
  return [null, null];
}

const [KF_INTERP, KF_EASE, KF_HANDLE] = (TPL.meta?.kfDefaults?.combo as number[] | undefined) ?? [1, 2, 1];

/** 造一条 NV KeyFrame（$id 由 rebuild 统一补） */
function nvKf(x: number, y: number): Dict {
  return {
    _hovered: false,
    _selected: false,
    Handle: KF_HANDLE,
    Interpolation: KF_INTERP,
    Ease: KF_EASE,
    CP0: { x: 0.0, y: 0.0 },
    CP1: { x: 0.0, y: 0.0 },
    _x: Math.min(1, Math.max(0, x)),
    _y: y,
  };
}

/** 给 PFloat 通道设静态值 + 可选关键帧轨（t 为颗粒绝对秒） */
function setChannel(
  ch: Dict | null,
  staticV: number,
  track: IRKeyframe[] | undefined,
  inn: number,
  dur: number,
  conv: (v: number) => number,
  warnings: string[],
  what: string,
): void {
  if (!ch) {
    warnings.push(`nv: 找不到参数通道 ${what}，跳过`);
    return;
  }
  ch.Value = conv(staticV);
  if (track && track.length >= 2) {
    const kfs = track
      .map((k) => nvKf((num(k.t) - inn) / Math.max(0.001, dur), conv(num(k.v))))
      .sort((a, b) => (a._x as number) - (b._x as number));
    ch.KeyFrames = kfs;
    ch.Value = kfs[0]._y;
  }
}

// ---- IR fx → NV DataEffect ----

/** op → [DataPath, 参数候选名, IR 主参数字段, IR值→NV值 逆换算] */
interface FxRule {
  path: string;
  paramNames: string[];
  irKey?: string;
  trackKey?: string;
  inv?: (v: number, cw: number, ch: number) => number;
  approx?: string;
}

const NV_FX_RULES: Record<string, FxRule> = {
  blur: {
    path: "_Effect/_AssetStore/_Blur/_GaussianBlur",
    paramNames: ["_size", "_strength", "_amount", "_blur", "_blur_radius"],
    irKey: "r",
    trackKey: "r",
    inv: (v) => Math.min(1, Math.abs(v) / 60),
  },
  glow: { path: "_Effect/_AssetStore/_Shine/_Glow", paramNames: [] },
  rgbSplit: { path: "_Effect/_AssetStore/_RGB/_ChromaticAberration", paramNames: [] },
  colorAdjust: {
    path: "_Effect/_BasicCorrection",
    paramNames: ["_exposure", "_brightness"],
    irKey: "brightness",
    trackKey: "brightness",
    inv: (v) => v - 1,
  },
  shake: {
    path: "_Effect/_Shake",
    paramNames: ["_mag", "_magnitude", "_strength", "_amount"],
    irKey: "mag",
    trackKey: "mag",
    inv: (v, cw) => Math.abs(v) / Math.max(1, cw * 0.1),
  },
  keyed: { path: "_Effect/_ChromaKey", paramNames: [] },
  turbulence: {
    path: "_Effect/_AssetStore/_Distort/_TurbulentDistortion",
    paramNames: ["_strength", "_amount", "_intensity"],
    irKey: "disp",
    trackKey: "disp",
    inv: (v, cw, ch) => Math.abs(v) / Math.max(1, Math.min(cw, ch) * 0.25),
  },
  tile: { path: "_Effect/_AssetStore/_Stylize/_MotionTile", paramNames: [] },
  zoom: {
    path: "_Effect/_AssetStore/_Stylize/_MotionTile",
    paramNames: ["_tile_scale"],
    irKey: "scale",
    trackKey: "scale",
    inv: (v) => Math.min(4, Math.max(0.05, v)),
  },
  bulge: {
    path: "_Effect/_AssetStore/_Distort/_PinchBulge",
    paramNames: ["_size", "_strength", "_amount"],
    irKey: "strength",
    trackKey: "strength",
    inv: (v) => Math.min(2, Math.max(-2, v)),
  },
  dropShadow: { path: "_Effect/_LayerStyles2", paramNames: [] },
  dirBlur: {
    path: "_Effect/_AssetStore/_Blur/_GaussianBlur",
    paramNames: ["_size", "_strength", "_amount"],
    irKey: "len",
    trackKey: "len",
    inv: (v) => Math.min(1, Math.abs(v) / 45),
    approx: "方向模糊无模板,高斯模糊近似(丢方向)",
  },
};

/** 模板缺口：这些 op 在 6 份样本里无对应 DataEffect 模板，只能告警放弃 */
const NV_GAP_OPS = new Set([
  "pulsate",
  "oscillate",
  "wipe",
  "flicker",
  "vignette",
  "stretch",
  "invert",
  "flip",
  "noise",
  "unmult",
  "fill",
]);

// ---- 组装 ----

interface NvCtx {
  warnings: string[];
  nodeSeq: number;
  cw: number;
  ch: number;
  duration: number;
}

function uuid4(): string {
  const b = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const s = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const TYPE_TO_NODE: Record<string, string> = {
  image: "NodeMediaImage",
  video: "NodeMediaVideo",
  text: "NodeViewText2",
  group: "NodeGroup",
  shape: "NodeFill",
  null: "NodeAdjustment",
};

function instantiate(tplKey: string, fromEffects: boolean, basePath: string): Dict | null {
  const src = fromEffects ? TPL.effects[tplKey] : TPL.nodes[tplKey];
  if (!src) return null;
  const inst = inflate(src) as Dict;
  anchorRefs(inst, basePath);
  return inst;
}

/** DataTransform 注入：位置/缩放/旋转/透明度（静态 + 关键帧） */
function injectTransform(ctx: NvCtx, node: Dict, ly: IRLayer, inn: number, dur: number): void {
  const props = node.Props as unknown[] | undefined;
  const dt = (props ?? []).find((p) => shortType(p) === "DataTransform") as Dict | undefined;
  if (!dt) {
    ctx.warnings.push(`nv: 节点 ${ly.id} 模板无 DataTransform`);
    return;
  }
  const cx = ctx.cw / 2;
  const cy = ctx.ch / 2;
  const anim = ly.anim ?? {};
  const px = num(ly.pos?.[0], cx);
  const py = num(ly.pos?.[1], cy);

  const pos = getParam(dt, "_position");
  const [posX, posY] = vec2Channels(pos);
  // 归一坐标：v = (px - cx) / cx
  setChannel(posX, px, anim.x, inn, dur, (v) => (v - cx) / Math.max(1, cx), ctx.warnings, `${ly.id}._position.x`);
  setChannel(posY, py, anim.y, inn, dur, (v) => (v - cy) / Math.max(1, cy), ctx.warnings, `${ly.id}._position.y`);

  const sc = getParam(dt, "_scale");
  const [scX, scY] = vec2Channels(sc);
  const sTrack = anim.scale ?? anim.sx;
  const sTrackY = anim.scale ?? anim.sy;
  const clampS = (v: number) => Math.min(4, Math.max(0.02, v));
  setChannel(scX, sTrack?.length ? num(sTrack[0].v, 1) : 1, sTrack, inn, dur, clampS, ctx.warnings, `${ly.id}._scale.x`);
  setChannel(scY, sTrackY?.length ? num(sTrackY[0].v, 1) : 1, sTrackY, inn, dur, clampS, ctx.warnings, `${ly.id}._scale.y`);

  if (anim.rot?.length) {
    const rot = getParam(dt, "_rotation");
    setChannel(rot, num(anim.rot[0].v, 0), anim.rot, inn, dur, (v) => v, ctx.warnings, `${ly.id}._rotation`);
  }
  if (anim.opacity?.length) {
    const op = getParam(dt, "_opacity") ?? getParam(dt, "_alpha");
    if (op) {
      setChannel(op, num(anim.opacity[0].v, 1), anim.opacity, inn, dur, (v) => Math.min(1, Math.max(0, v)), ctx.warnings, `${ly.id}._opacity`);
    } else {
      ctx.warnings.push(`nv: 模板无 _opacity 参数，层 ${ly.id} 透明度动画丢失`);
    }
  }
}

/** fx 注入：按规则挂 DataEffect 模板 + 强度参数/参数轨 */
function injectEffects(ctx: NvCtx, node: Dict, nodePath: string, ly: IRLayer, inn: number, dur: number): void {
  const props = node.Props as unknown[];
  if (!Array.isArray(props)) return;
  for (const fx of ly.fx ?? []) {
    const rule = NV_FX_RULES[fx.op];
    if (!rule) {
      if (NV_GAP_OPS.has(fx.op)) ctx.warnings.push(`nv: 特效 ${fx.op} 无样本模板（缺口），已跳过`);
      else ctx.warnings.push(`nv: 未知特效 ${fx.op}，已跳过`);
      continue;
    }
    const effPath = `${nodePath}/Props[${props.length}]`;
    const eff = instantiate(rule.path, true, effPath);
    if (!eff) {
      ctx.warnings.push(`nv: 特效模板缺失 ${rule.path}（op=${fx.op}），已跳过`);
      continue;
    }
    if (rule.approx) ctx.warnings.push(`nv: ${fx.op} → ${rule.path} 近似（${rule.approx}）`);
    if (rule.paramNames.length && rule.irKey) {
      const inv = rule.inv ?? ((v: number) => v);
      let target: Dict | null = null;
      for (const nm of rule.paramNames) {
        target = getParam(eff, nm);
        if (target) {
          // PVector2 参数取 x 通道
          if (shortType(target) === "PVector2") target = vec2Channels(target)[0];
          break;
        }
      }
      if (target) {
        const staticV = num((fx as Record<string, unknown>)[rule.irKey] as number, NaN);
        const track = rule.trackKey ? fx.tracks?.[rule.trackKey] : undefined;
        if (isFinite(staticV) || track) {
          setChannel(
            target,
            isFinite(staticV) ? staticV : num(track?.[0]?.v),
            track,
            inn,
            dur,
            (v) => (rule.inv ? inv(v, ctx.cw, ctx.ch) : v),
            ctx.warnings,
            `${ly.id}.fx.${fx.op}`,
          );
        }
      } else {
        ctx.warnings.push(`nv: ${rule.path} 模板里找不到参数 ${rule.paramNames.join("/")}，用默认强度`);
      }
    }
    props.push(eff);
  }
  if (ly.raw_fx?.length) ctx.warnings.push(`nv: 层 ${ly.id} 原始未解析特效 ${ly.raw_fx.join(",")} 未迁移`);
}

/** IRLayer → NV 节点（含递归子层）。nodePath: 本节点在最终树里的绝对路径 */
function buildNode(ctx: NvCtx, ly: IRLayer, nodePath: string, uiIndex: number): Dict | null {
  const tplKey = TYPE_TO_NODE[String(ly.type)] ?? "NodeAdjustment";
  const node = instantiate(tplKey, false, nodePath);
  if (!node) {
    ctx.warnings.push(`nv: 无节点模板 ${tplKey}（层 ${ly.id} type=${ly.type}），已跳过`);
    return null;
  }
  const inn = Math.max(0, num(ly.in, 0));
  const out = Math.min(ctx.duration, Math.max(inn + 0.05, num(ly.out, ctx.duration)));
  const dur = out - inn;

  node.Name = String(ly.id ?? `L${ctx.nodeSeq}`);
  node.UID = uuid4();
  node.ID = ++ctx.nodeSeq;
  node.UIIndex = uiIndex;
  node.Hided = false;
  const tl = node.TimeLine as Dict | undefined;
  if (tl) {
    tl.Pos = inn;
    tl.Start = 0.0;
    tl.End = dur;
    tl.Duration = dur;
    tl.Stretch = 1.0;
    tl.Trimed = false;
  }

  injectTransform(ctx, node, ly, inn, dur);

  // 类型专属注入
  if (ly.type === "text") {
    const dt2 = ((node.Props as unknown[]) ?? []).find((p) => shortType(p) === "DataText2") as Dict | undefined;
    const pText = dt2 ? getParam(dt2, "_text") : null;
    if (pText) pText.Text = String(ly.text ?? "");
    else ctx.warnings.push(`nv: 文本层 ${ly.id} 找不到 _text 参数`);
    // 字号/颜色映射无真机换算依据，保持模板默认（报告缺口）
  } else if (ly.type === "image" || ly.type === "video") {
    for (const key of ["AssetImage", "AssetVideo"]) {
      const asset = node[key] as Dict | undefined;
      if (asset && typeof asset === "object") {
        asset.AbsolutePath = `Medias/placeholder_${String(ly.asset ?? "slot")}${key === "AssetVideo" ? ".mp4" : ".jpg"}`;
        if ("Width" in asset) asset.Width = Math.round(num(ly.w, ctx.cw));
        if ("Height" in asset) asset.Height = Math.round(num(ly.h, ctx.ch));
      }
    }
  } else if (ly.type === "shape") {
    // NodeFill: 填充色尽力注入（找第一个 PColor）
    const fillEff = ((node.Props as unknown[]) ?? []).find(
      (p) => shortType(p) === "DataEffect" && String((p as Dict).DataPath ?? "").startsWith("_Fill/"),
    ) as Dict | undefined;
    const pc = fillEff ? findFirstPColor(fillEff) : null;
    if (pc) {
      const rgba = cssToRgba01(ly.fill);
      if (rgba) {
        if ("r" in pc) {
          pc.r = rgba[0];
          pc.g = rgba[1];
          pc.b = rgba[2];
          pc.a = rgba[3];
        } else if (pc.Value && typeof pc.Value === "object") {
          const v = pc.Value as Dict;
          v.r = rgba[0];
          v.g = rgba[1];
          v.b = rgba[2];
          v.a = rgba[3];
        }
      }
    } else {
      ctx.warnings.push(`nv: 形状层 ${ly.id} 填充色未注入（模板无 PColor）`);
    }
  }

  injectEffects(ctx, node, nodePath, ly, inn, dur);

  // 子层
  if (ly.type === "group" && ly.children?.length) {
    const kids: unknown[] = [];
    ly.children.forEach((child, i) => {
      const kid = buildNode(ctx, child, `${nodePath}/ChildList[${kids.length}]`, i);
      if (kid) kids.push(kid);
    });
    node.ChildList = kids;
  } else if (!Array.isArray(node.ChildList)) {
    node.ChildList = [];
  }
  return node;
}

function findFirstPColor(o: unknown): Dict | null {
  if (Array.isArray(o)) {
    for (const v of o) {
      const r = findFirstPColor(v);
      if (r) return r;
    }
    return null;
  }
  if (o && typeof o === "object") {
    const d = o as Dict;
    if (shortType(d) === "PColor") return d;
    for (const [k, v] of Object.entries(d)) {
      if (k === "NestedParams") continue;
      if (v && typeof v === "object") {
        const r = findFirstPColor(v);
        if (r) return r;
      }
    }
  }
  return null;
}

function cssToRgba01(css: string | undefined): [number, number, number, number] | null {
  if (!css) return null;
  const m = css.match(/^#([0-9a-fA-F]{6})$/);
  if (m) {
    return [
      parseInt(m[1].slice(0, 2), 16) / 255,
      parseInt(m[1].slice(2, 4), 16) / 255,
      parseInt(m[1].slice(4, 6), 16) / 255,
      1,
    ];
  }
  const mm = css.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (mm) return [+mm[1] / 255, +mm[2] / 255, +mm[3] / 255, mm[4] !== undefined ? +mm[4] : 1];
  return null;
}

// ---- rebuild：nv_roundtrip.py 的 TS 移植（DFS $id 重编 + $ref 路径锚定） ----

function isNodeLike(o: Dict): boolean {
  return "Props" in o && "TimeLine" in o && "UID" in o;
}

function isDataProp(o: Dict): boolean {
  const t = o.$type;
  return typeof t === "string" && /NodeVideo\.Data\.Data/.test(t);
}

export function rebuildNv(tree: unknown): unknown {
  // Pass A: 非 marker dict 分配 $id（DFS 键序），记录 path→id；marker 记解析目标 path
  const path2id = new Map<string, string>();
  const markerTarget = new Map<Dict, string>();
  let counter = 0;

  const passA = (o: unknown, path: string, ancestors: { obj: Dict; path: string }[]): void => {
    if (Array.isArray(o)) {
      o.forEach((v, i) => passA(v, `${path}[${i}]`, ancestors));
      return;
    }
    if (o && typeof o === "object") {
      const d = o as Dict;
      if (isMarker(d)) {
        if (typeof d.__R__ === "string") {
          markerTarget.set(d, d.__R__);
        } else if (d.__RP__ !== undefined) {
          const anc = [...ancestors].reverse().find((a) => isDataProp(a.obj));
          if (!anc) throw new Error(`nv rebuild: __RP__ 无 Data* 祖先 @${path}`);
          markerTarget.set(d, anc.path);
        } else {
          const anc = [...ancestors].reverse().find((a) => isNodeLike(a.obj));
          if (!anc) throw new Error(`nv rebuild: __RN__ 无节点祖先 @${path}`);
          markerTarget.set(d, anc.path);
        }
        return;
      }
      counter += 1;
      path2id.set(path, String(counter));
      const next = [...ancestors, { obj: d, path }];
      for (const [k, v] of Object.entries(d)) passA(v, `${path}/${k}`, next);
    }
  };
  passA(tree, "", []);

  // Pass B: 输出（$id 在前；marker → {$ref}）
  const passB = (o: unknown, path: string): unknown => {
    if (Array.isArray(o)) return o.map((v, i) => passB(v, `${path}[${i}]`));
    if (o && typeof o === "object") {
      const d = o as Dict;
      if (isMarker(d)) {
        const target = markerTarget.get(d);
        const id = target !== undefined ? path2id.get(target) : undefined;
        if (id === undefined) throw new Error(`nv rebuild: $ref 目标不存在 @${path} -> ${target}`);
        return { $ref: id };
      }
      const out: Dict = { $id: path2id.get(path) };
      for (const [k, v] of Object.entries(d)) out[k] = passB(v, `${path}/${k}`);
      return out;
    }
    return o;
  };
  return passB(tree, "");
}

// ---- 顶层 ----

/** IR → NV 工程对象（未序列化） */
export function irToNvObject(ir: IRProject): { nv: unknown; warnings: string[] } {
  const c = ir.canvas;
  const cw = Math.max(4, Math.round(num(c.w, 1080)));
  const chh = Math.max(4, Math.round(num(c.h, 1920)));
  const fps = Math.min(120, Math.max(1, num(c.fps, 30)));
  const duration = Math.max(0.1, num(c.duration, 3));
  const ctx: NvCtx = { warnings: [], nodeSeq: 1, cw, ch: chh, duration };

  const root = inflate(TPL.root) as Dict;
  anchorRefs(root, "");
  root.Name = "根节点";

  // 工程设置注入
  const rootProps = (root.Props as unknown[]) ?? [];
  const ps = rootProps.find((p) => shortType(p) === "DataProjectSetting") as Dict | undefined;
  if (ps) {
    ps.ProjectName = String(ir.id ?? "ir");
    ps.ProjectGUID = uuid4();
    ps.CreationTime = new Date().toISOString();
    ps.TotalTimeUsed = duration * 1000;
    ps.IsExample = false;
    const res = getParam(ps, "_resolution");
    const [rx, ry] = vec2Channels(res);
    if (rx) {
      rx.Value = cw;
      if ("OriValue" in rx) rx.OriValue = cw;
    } else {
      ctx.warnings.push("nv: 工程设置缺 _resolution 宽通道，分辨率未注入");
    }
    if (ry) {
      ry.Value = chh;
      if ("OriValue" in ry) ry.OriValue = chh;
    }
    const pfps = getParam(ps, "_fps");
    if (pfps) pfps.Value = fps;
    else ctx.warnings.push("nv: 工程设置缺 _fps 参数");
  } else {
    ctx.warnings.push("nv: 根模板缺 DataProjectSetting");
  }
  const tl = root.TimeLine as Dict | undefined;
  if (tl) {
    tl.Pos = 0.0;
    tl.Start = 0.0;
    tl.End = duration;
    tl.Duration = duration;
  }

  // 层 → 节点
  const kids: unknown[] = [];
  (ir.layers ?? []).forEach((ly, i) => {
    const node = buildNode(ctx, ly, `/ChildList[${kids.length}]`, i);
    if (node) kids.push(node);
  });
  root.ChildList = kids;

  const nv = rebuildNv(root);
  return { nv, warnings: ctx.warnings };
}

/** IR → .nv JSON 字符串（紧凑、UTF-8） */
export function irToNv(ir: IRProject): { nv: string; warnings: string[] } {
  const { nv, warnings } = irToNvObject(ir);
  return { nv: JSON.stringify(nv), warnings };
}

/**
 * IR → NodeVideo 工程包（.zip 内套单个 .nv）。
 * NV 的导入入口是「导入工程包(.Zip压缩包)」，裸 .nv 无法导入——2026-07-17 真机确认。
 */
export async function exportNv(ir: IRProject): Promise<ExportResult> {
  const { nv, warnings } = irToNv(ir);
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const base = ir.id || "ir";
  zip.file(`${base}.nv`, nv);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  return { filename: `${base}.zip`, mime: "application/zip", data: blob, warnings };
}
