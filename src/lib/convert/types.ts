/**
 * IR v1 类型定义（按 IR_v1_spec.md + dataset/ir_v1 全量 2095 份真实样本对齐）。
 *
 * 宽容原则：真实样本字段为准、spec 字段可选、未知字段透传（索引签名兜底），
 * 转换器一律 defensive 读取——缺字段给默认、多字段不报错。
 */

/** 关键帧：t=颗粒时间线绝对秒，v=通道值，e=CSS cubic-bezier 缓动串（可缺/可 null） */
export interface IRKeyframe {
  t: number;
  v: number;
  e?: string | null;
  [k: string]: unknown;
}

/** 逐通道动画轨。值单位：x/y=画布 px 绝对坐标，scale/sx/sy=倍数，rot=度，opacity=[0,1]，ls=px 字距 */
export interface IRAnim {
  x?: IRKeyframe[];
  y?: IRKeyframe[];
  scale?: IRKeyframe[];
  sx?: IRKeyframe[];
  sy?: IRKeyframe[];
  rot?: IRKeyframe[];
  opacity?: IRKeyframe[];
  /** letterspacing 轨（AM textspacing 降解产物，罕见） */
  ls?: IRKeyframe[];
  [k: string]: IRKeyframe[] | undefined;
}

/** 特效算子参数关键帧轨（op 内 tracks：如 blur.r / shake.mag / wipe.start） */
export type IRFxTracks = Record<string, IRKeyframe[]>;

/**
 * 特效算子。op 全集来自真实样本普查（38377 层带 fx）：
 * dirBlur/tile/shake/colorAdjust/pulsate/oscillate/turbulence/glow/blur/bulge/
 * dropShadow/rgbSplit/keyed/wipe/zoom/fill/flicker/vignette/stretch/invert/flip/noise/unmult
 * 其余字段按 op 而异，全部可选。
 */
export interface IRFx {
  op: string;
  /** 原始特效名（AM effect id / NV DataPath 末段 / 剪映名），溯源用 */
  src?: string;
  /** 参数关键帧轨 */
  tracks?: IRFxTracks;
  /** 时序算子生效窗（秒） */
  t0?: number;
  t1?: number;
  // —— 常见参数（按普查频次收录，全可选）——
  freq?: number;
  angle?: number;
  mag?: number;
  len?: number;
  r?: number;
  decay?: boolean;
  color?: string;
  min?: number;
  max?: number;
  brightness?: number;
  disp?: number;
  octaves?: number;
  inten?: number;
  radius?: number;
  strength?: number;
  contrast?: number;
  saturate?: number;
  amt?: number;
  dx?: number;
  dy?: number;
  blur?: number;
  rot?: boolean | number;
  a1?: number;
  a2?: number;
  opacity?: number;
  kind?: string;
  start?: number;
  end?: number;
  scale?: number;
  deg?: number;
  amp?: number;
  intensity?: number;
  exposure?: number;
  hue?: number;
  [k: string]: unknown;
}

export type IRLayerType = "text" | "image" | "video" | "shape" | "group" | "null";

/** 图层。in/out=颗粒时间线在场区间（秒），pos=home 位置（画布 px，锚点处） */
export interface IRLayer {
  id: string;
  type: IRLayerType | string;
  in: number;
  out: number;
  pos: [number, number] | number[];
  /** 归一锚点（spec 有、样本缺省=[0.5,0.5]） */
  anchor?: [number, number] | number[];
  /** 混合模式（spec 有、样本罕见） */
  blend?: string;

  // —— text ——
  text?: string;
  /** CSS font 简写，如 "700 220px 'Microsoft YaHei'" */
  font?: string;
  color?: string;
  letterspacing?: number;
  align?: string;

  // —— image / video ——
  /** assets[].id 引用；样本里常见哨兵值 "slot" */
  asset?: string;

  // —— shape ——
  shape?: "rect" | "ellipse" | string;
  fill?: string;

  /** 内容盒尺寸（image/video/shape 常带） */
  w?: number;
  h?: number;

  anim?: IRAnim;
  fx?: IRFx[];
  /** 未映射的原始特效名列表（分析态残留，只读） */
  raw_fx?: string[];
  /** 未映射的原始动画通道（分析态残留，只读） */
  raw_anims?: unknown[];

  /** type=group 时的子层 */
  children?: IRLayer[];

  [k: string]: unknown;
}

export interface IRCanvas {
  w: number;
  h: number;
  fps: number;
  /** 秒 */
  duration: number;
  bg?: string;
  [k: string]: unknown;
}

/** 可替换素材插槽（spec 有、当前样本未见，保留） */
export interface IRAsset {
  id: string;
  kind?: "image" | "video" | string;
  slot?: string;
  fit?: string;
  [k: string]: unknown;
}

/** IR v1 顶层 */
export interface IRProject {
  v: number;
  id: string;
  /** 源工程路径（脱敏后可能是 uid） */
  source?: string;
  canvas: IRCanvas;
  assets?: IRAsset[];
  layers: IRLayer[];
  /** 卡点书签（ms，分析态残留） */
  bookmarks?: number[];
  [k: string]: unknown;
}

/** 导出目标格式 */
export type ExportFormat = "jsx" | "am" | "amproj" | "nv";

/** 统一导出产物 */
export interface ExportResult {
  /** 建议文件名（含扩展名） */
  filename: string;
  mime: string;
  /** 文本产物（jsx/am/nv）或二进制（amproj zip） */
  data: string | Blob;
  /** 转换过程中的告警/降级说明（未映射特效等） */
  warnings: string[];
}

// —— 内部公共小工具（三个 emitter 共用）——

/** 数值兜底 */
export function num(v: unknown, d = 0): number {
  return typeof v === "number" && isFinite(v) ? v : d;
}

/** 解析 CSS cubic-bezier(a,b,c,d) → [x1,y1,x2,y2]；非法/缺省返回 null */
export function parseCubicBezier(e: string | null | undefined): [number, number, number, number] | null {
  if (!e || typeof e !== "string") return null;
  const m = e.match(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
  if (!m) return null;
  const v = m.slice(1, 5).map(Number) as [number, number, number, number];
  return v.every((x) => isFinite(x)) ? v : null;
}

/** 从 IR font 简写里抽字号 px（缺省 90） */
export function fontPx(font: string | undefined, d = 90): number {
  if (!font) return d;
  const m = font.match(/([\d.]+)px/);
  return m ? Math.max(1, parseFloat(m[1])) : d;
}

/**
 * CSS 颜色 → [r,g,b,a]（0-255 / a 0-1）。支持 #rgb/#rrggbb/#rrggbbaa/rgb()/rgba()。
 * 解析失败返回 null。
 */
export function parseCssColor(c: string | undefined | null): [number, number, number, number] | null {
  if (!c || typeof c !== "string") return null;
  const s = c.trim();
  let m = s.match(/^#([0-9a-fA-F]{3})$/);
  if (m) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
  }
  m = s.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
  if (m) {
    const h = m[1];
    const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) {
    return [
      Math.min(255, parseFloat(m[1])),
      Math.min(255, parseFloat(m[2])),
      Math.min(255, parseFloat(m[3])),
      m[4] !== undefined ? Math.min(1, parseFloat(m[4])) : 1,
    ];
  }
  return null;
}

/**
 * 把 x/y（或 sx/sy）两条独立轨合并成同刻双通道轨：并集时间点 + 线性插值补缺通道。
 * 返回 [{t, a, b, e}]；a/b 分别是两通道在 t 时刻的值。
 */
export function mergeChannelTracks(
  ta: IRKeyframe[] | undefined,
  tb: IRKeyframe[] | undefined,
  defA: number,
  defB: number,
): { t: number; a: number; b: number; e?: string | null }[] {
  const sample = (track: IRKeyframe[] | undefined, t: number, dflt: number): number => {
    if (!track || track.length === 0) return dflt;
    if (t <= track[0].t) return num(track[0].v, dflt);
    for (let i = 1; i < track.length; i++) {
      if (t <= track[i].t) {
        const p = track[i - 1];
        const q = track[i];
        const span = q.t - p.t;
        if (span <= 0) return num(q.v, dflt);
        const k = (t - p.t) / span;
        return num(p.v, dflt) + (num(q.v, dflt) - num(p.v, dflt)) * k;
      }
    }
    return num(track[track.length - 1].v, dflt);
  };
  const times = new Set<number>();
  for (const k of ta ?? []) times.add(k.t);
  for (const k of tb ?? []) times.add(k.t);
  const sorted = [...times].sort((x, y) => x - y);
  return sorted.map((t) => {
    const ea = (ta ?? []).find((k) => k.t === t)?.e;
    const eb = (tb ?? []).find((k) => k.t === t)?.e;
    return { t, a: sample(ta, t, defA), b: sample(tb, t, defB), e: ea ?? eb ?? null };
  });
}
