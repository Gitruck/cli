/**
 * IR v1 → Alight Motion 工程 XML 字符串（+ 可选 JSZip 打 .amproj）。
 *
 * 反向参考 scripts/am_to_ir.py + hyperframes_poc/am_ir_to_v1.py（本文件 = 其换算取逆）：
 *   - 关键帧 t：IR 绝对秒 → 层内归一 [0,1]
 *   - 缓动：CSS cubic-bezier(a,b,c,d) → AM "cubicBezier a b c d"
 *   - AM scale = 相对基准尺寸的倍数（shape 基准=size 属性；text 基准=字面排版尺寸），
 *     与 IR scale 同为倍数语义，直接过值
 *   - location kf 值 "x,y,z"（画布 px）；opacity/rotation 单值
 *   - 颜色：CSS → AM #AARRGGBB
 *   - amver/ffver/amplatform 用样本最常见值（200 份 AM 工程普查：amver=3019/ffver=105/android）
 *
 * .amproj = zip[ {uuid}.xml + manifest.txt(媒体清单,占位导出为空) ]。
 */
import type { ExportResult, IRFx, IRKeyframe, IRLayer, IRProject } from "./types";
import { fontPx, mergeChannelTracks, num, parseCssColor, parseCubicBezier } from "./types";

// 样本最常见工程指纹（见 tools 普查：amver 3019=106/200, ffver 105=167/200, android=194/200）
const AM_VER = "3019";
const FF_VER = "105";
const AM_PLATFORM = "android";
const AM_APP = "com.alightcreative.motion/4.3.4.3019";

const EFFECT_PREFIX = "com.alightcreative.effects.";

function xmlEsc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function f6(v: number): string {
  return (isFinite(v) ? v : 0).toFixed(6);
}

/** CSS 颜色 → AM #AARRGGBB */
function amColor(css: string | undefined | null, fallback = "#ffffffff"): string {
  const c = parseCssColor(css);
  if (!c) return fallback;
  const hex = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return `#${hex(c[3] * 255)}${hex(c[0])}${hex(c[1])}${hex(c[2])}`;
}

/** CSS cubic-bezier → AM 缓动串 */
function amEase(e: string | null | undefined): string | null {
  const cb = parseCubicBezier(e);
  if (!cb) return null;
  return `cubicBezier ${cb[0]} ${cb[1]} ${cb[2]} ${cb[3]}`;
}

/** IR 绝对秒 → 层内归一 t */
function normT(t: number, inn: number, out: number): number {
  const dur = Math.max(0.001, out - inn);
  return Math.min(1, Math.max(0, (t - inn) / dur));
}

interface KfOut {
  t: number;
  v: string;
  e?: string | null;
}

function kfElements(kfs: KfOut[], indent: string): string[] {
  return kfs.map((k) => {
    const e = amEase(k.e);
    return `${indent}<kf t="${f6(k.t)}" v="${xmlEsc(k.v)}"${e ? ` e="${xmlEsc(e)}"` : ""} />`;
  });
}

/** 一条变换/参数通道：有轨出 <kf>、无轨出 value 属性 */
function propChannel(
  tag: string,
  staticValue: string,
  track: KfOut[] | null,
  indent: string,
): string[] {
  if (track && track.length >= 2) {
    return [`${indent}<${tag}>`, ...kfElements(track, indent + "  "), `${indent}</${tag}>`];
  }
  return [`${indent}<${tag} value="${xmlEsc(staticValue)}" />`];
}

// ---- 特效逆映射（fx_ops_am.extract_fx 的取逆；单位换算按同一常数反推）----

interface AmEffect {
  id: string;
  props: { name: string; type: string; value?: string; kfs?: KfOut[] }[];
}

function fxTrack(
  fx: IRFx,
  key: string,
  inn: number,
  out: number,
  conv: (v: number) => number,
): KfOut[] | null {
  const tk = fx.tracks?.[key];
  if (!tk || tk.length < 2) return null;
  return tk.map((k: IRKeyframe) => ({ t: normT(k.t, inn, out), v: f6(conv(num(k.v))), e: k.e }));
}

/** IR fx → AM effect 元素（一个 op 可能产出 0..2 个 effect）；null=未映射 */
function fxToAm(fx: IRFx, ly: IRLayer, canvasMin: number, warnings: string[]): AmEffect[] | null {
  const inn = num(ly.in, 0);
  const out = Math.max(inn + 0.001, num(ly.out, inn + 1));
  const F = (name: string, value: number): AmEffect["props"][number] => ({
    name,
    type: "float",
    value: f6(value),
  });
  const KF = (name: string, kfs: KfOut[]): AmEffect["props"][number] => ({ name, type: "float", kfs });

  switch (fx.op) {
    case "pulsate": {
      return [
        {
          id: "pulsate2",
          props: [F("maxsize", num(fx.max, 1.05)), F("minsize", num(fx.min, 1)), F("freq", num(fx.freq, 2))],
        },
      ];
    }
    case "shake": {
      const tk = fxTrack(fx, "mag", inn, out, (v) => v);
      const props = [F("mag", num(fx.mag, 18)), F("freq", num(fx.freq, 12)), F("angle", num(fx.angle, 0))];
      if (tk) props.push(KF("mag", tk));
      return [{ id: "shake2", props }];
    }
    case "oscillate": {
      if (fx.rot === true) {
        return [
          { id: "swing2", props: [F("a1", num(fx.a1, -10)), F("a2", num(fx.a2, 10)), F("freq", num(fx.freq, 2))] },
        ];
      }
      const tk = fxTrack(fx, "mag", inn, out, (v) => v);
      const props = [F("mag", num(fx.mag, 40)), F("angle", num(fx.angle, 90)), F("freq", num(fx.freq, 4))];
      if (tk) props.push(KF("mag", tk));
      return [{ id: "oscillate3", props }];
    }
    case "dirBlur": {
      // 正向: len = strength * min(w,h) * 0.15 → 逆向 strength = len / (mn*0.15)
      const inv = (len: number) => len / Math.max(1, canvasMin * 0.15);
      const tk = fxTrack(fx, "len", inn, out, inv);
      const props = [F("strength", inv(num(fx.len, 12))), F("angle", num(fx.angle, 0))];
      if (tk) props.push(KF("strength", tk));
      return [{ id: "dblur", props }];
    }
    case "blur": {
      // 正向: r = strength * 100
      const inv = (r: number) => r / 100;
      const tk = fxTrack(fx, "r", inn, out, inv);
      const props = [F("strength", inv(num(fx.r, 8)))];
      if (tk) props.push(KF("strength", tk));
      return [{ id: "gaussianblur", props }];
    }
    case "glow": {
      // 正向: r = strength*80, inten = rrr
      return [{ id: "deepglow", props: [F("strength", num(fx.r, 22) / 80), F("rrr", num(fx.inten, 1.3))] }];
    }
    case "dropShadow":
      return [{ id: "dropshadow", props: [] }];
    case "colorAdjust": {
      const out2: AmEffect[] = [];
      const br = num(fx.brightness, NaN);
      // 静态值中性但带参数轨的也要发射（否则轨丢失，如「brightness=1 + 轨 2.056→1」的闪白）
      if ((isFinite(br) && Math.abs(br - 1) > 1e-3) || (fx.tracks?.brightness?.length ?? 0) >= 2) {
        // 正向: brightness = 2^exposure → exposure = log2(brightness)
        const inv = (b: number) => Math.log2(Math.min(3, Math.max(0.2, b)));
        const tk = fxTrack(fx, "brightness", inn, out, inv);
        const props = [F("exposure", inv(isFinite(br) ? br : num(fx.tracks?.brightness?.[0]?.v, 1)))];
        if (tk) props.push(KF("exposure", tk));
        out2.push({ id: "exposure", props });
      }
      const sat = num(fx.saturate, NaN);
      if ((isFinite(sat) && Math.abs(sat - 1) > 1e-3) || (fx.tracks?.saturate?.length ?? 0) >= 2) {
        // 正向: saturate = 1 + saturation
        const tk = fxTrack(fx, "saturate", inn, out, (v) => v - 1);
        const props = [F("saturation", (isFinite(sat) ? sat : num(fx.tracks?.saturate?.[0]?.v, 1)) - 1)];
        if (tk) props.push(KF("saturation", tk));
        out2.push({ id: "hsl", props });
      }
      const ct = num(fx.contrast, NaN);
      if (isFinite(ct) && Math.abs(ct - 1) > 1e-3) {
        out2.push({ id: "brightcont2", props: [F("contrast", ct - 1)] });
      }
      return out2.length ? out2 : [{ id: "hsl", props: [F("saturation", 0.1)] }];
    }
    case "rgbSplit": {
      // 正向: amt = strength * 120
      const inv = (a: number) => a / 120;
      const tk = fxTrack(fx, "amt", inn, out, inv);
      const props = [F("strength", inv(num(fx.amt, 5))), F("angle", num(fx.angle, 0))];
      if (tk) props.push(KF("strength", tk));
      return [{ id: "rgbsep", props }];
    }
    case "turbulence": {
      // 正向: disp = intensity * mn * 0.25; freq = 0.012 / scale
      const inv = (d: number) => d / Math.max(1, canvasMin * 0.25);
      const tk = fxTrack(fx, "disp", inn, out, inv);
      const props = [F("intensity", inv(num(fx.disp, 16))), F("scale", 0.012 / Math.max(0.0005, num(fx.freq, 0.012)))];
      if (tk) props.push(KF("intensity", tk));
      return [{ id: "turbulentdisplace", props }];
    }
    case "bulge": {
      const tk = fxTrack(fx, "strength", inn, out, (v) => v);
      const props = [F("strength", num(fx.strength, 0.4)), F("radius", num(fx.radius, 1.5))];
      if (tk) props.push(KF("strength", tk));
      return [{ id: "pinchbulge2", props }];
    }
    case "wipe": {
      const s = fxTrack(fx, "start", inn, out, (v) => v);
      const e2 = fxTrack(fx, "end", inn, out, (v) => v);
      const props = [F("start", num(fx.start, 0)), F("end", num(fx.end, 1)), F("angle", num(fx.angle, 90))];
      if (s) props.push(KF("start", s));
      if (e2) props.push(KF("end", e2));
      return [{ id: "wipe2", props }];
    }
    case "flicker":
      return [{ id: "flicker2", props: [F("mag", num(fx.mag, 0.6)), F("freq", num(fx.freq, 8))] }];
    case "invert":
      return [{ id: "invert", props: [] }];
    case "flip": {
      const tk = fxTrack(fx, "deg", inn, out, (v) => v);
      const props = [F("angle", num(fx.deg, 180))];
      if (tk) props.push(KF("angle", tk));
      return [{ id: "flip3", props }];
    }
    case "stretch": {
      const tk = fxTrack(fx, "scale", inn, out, (v) => v);
      const props = [F("scale", num(fx.scale, 1)), F("angle", num(fx.angle, 0))];
      if (tk) props.push(KF("scale", tk));
      return [{ id: "stretch2", props }];
    }
    case "keyed":
      return [{ id: "chromakey", props: [] }];
    case "tile":
      return [{ id: "tile", props: [] }];
    case "zoom": {
      // 正向来源: tile.scale 参数轨 → zoom；逆向还原为 tile 的 scale 轨
      const tk = fxTrack(fx, "scale", inn, out, (v) => v);
      return [{ id: "tile", props: tk ? [KF("scale", tk)] : [] }];
    }
    default:
      warnings.push(`am: 未映射特效 ${fx.op}${fx.src ? `(${fx.src})` : ""}，已写 XML 注释`);
      return null;
  }
}

// ---- 层发射 ----

const BLEND_AM: Record<string, string> = {
  screen: "screen",
  multiply: "multiply",
  overlay: "overlay",
  add: "linear-dodge",
  lighten: "lighten",
  darken: "darken",
  "soft-light": "soft-light",
  "hard-light": "hard-light",
  difference: "difference",
  exclusion: "exclude",
  hue: "hue",
  color: "color",
};

interface AmCtx {
  idSeq: number;
  warnings: string[];
  fps: number;
  canvasW: number;
  canvasH: number;
}

/** 变换块（location/scale/rotation/opacity），tOffset=本层所在时间基（父组 in），秒 */
function transformXml(ly: IRLayer, inn: number, out: number, indent: string): string[] {
  const anim = ly.anim ?? {};
  const px = num(ly.pos?.[0], 0);
  const py = num(ly.pos?.[1], 0);
  const L: string[] = [`${indent}<transform>`];
  const ind = indent + "  ";

  // location（x/y 合并；kf v="x,y,0"）
  let locTrack: KfOut[] | null = null;
  if ((anim.x?.length ?? 0) >= 2 || (anim.y?.length ?? 0) >= 2) {
    locTrack = mergeChannelTracks(anim.x, anim.y, px, py).map((k) => ({
      t: normT(k.t, inn, out),
      v: `${f6(k.a)},${f6(k.b)},0.000000`,
      e: k.e,
    }));
  }
  L.push(...propChannel("location", `${f6(px)},${f6(py)},0.000000`, locTrack, ind));

  // scale（scale 单轨 / sx,sy 双轨；kf v="sx,sy"）
  let scTrack: KfOut[] | null = null;
  if ((anim.scale?.length ?? 0) >= 2) {
    scTrack = (anim.scale ?? []).map((k) => ({
      t: normT(k.t, inn, out),
      v: `${f6(num(k.v, 1))},${f6(num(k.v, 1))}`,
      e: k.e,
    }));
  } else if ((anim.sx?.length ?? 0) >= 2 || (anim.sy?.length ?? 0) >= 2) {
    scTrack = mergeChannelTracks(anim.sx, anim.sy, 1, 1).map((k) => ({
      t: normT(k.t, inn, out),
      v: `${f6(k.a)},${f6(k.b)}`,
      e: k.e,
    }));
  }
  L.push(...propChannel("scale", "1.000000,1.000000", scTrack, ind));

  // rotation
  if ((anim.rot?.length ?? 0) >= 2) {
    const rt = (anim.rot ?? []).map((k) => ({ t: normT(k.t, inn, out), v: f6(num(k.v, 0)), e: k.e }));
    L.push(...propChannel("rotation", "0.000000", rt, ind));
  }
  // opacity
  if ((anim.opacity?.length ?? 0) >= 2) {
    const ot = (anim.opacity ?? []).map((k) => ({
      t: normT(k.t, inn, out),
      v: f6(Math.min(1, Math.max(0, num(k.v, 1)))),
      e: k.e,
    }));
    L.push(...propChannel("opacity", "1.000000", ot, ind));
  }
  L.push(`${indent}</transform>`);
  return L;
}

function effectsXml(ctx: AmCtx, ly: IRLayer, inn: number, out: number, indent: string): string[] {
  const L: string[] = [];
  for (const fx of ly.fx ?? []) {
    const mapped = fxToAm(fx, ly, Math.min(ctx.canvasW, ctx.canvasH), ctx.warnings);
    if (!mapped) {
      L.push(`${indent}<!-- TODO 未映射特效: ${xmlEsc(JSON.stringify(fx))} -->`);
      continue;
    }
    for (const eff of mapped) {
      L.push(`${indent}<effect id="${EFFECT_PREFIX}${eff.id}" locallyApplied="true">`);
      for (const p of eff.props) {
        if (p.kfs) {
          L.push(`${indent}  <property name="${xmlEsc(p.name)}" type="${p.type}">`);
          L.push(...kfElements(p.kfs, indent + "    "));
          L.push(`${indent}  </property>`);
        } else {
          L.push(`${indent}  <property name="${xmlEsc(p.name)}" type="${p.type}" value="${xmlEsc(p.value ?? "0")}" />`);
        }
      }
      L.push(`${indent}</effect>`);
    }
  }
  if (ly.raw_fx?.length) {
    L.push(`${indent}<!-- 原工程未解析特效: ${xmlEsc(ly.raw_fx.join(", "))} -->`);
  }
  return L;
}

/**
 * 单层 → XML。tBase: 本层时间基（所在 scene 起点的颗粒时间线秒），
 * 层的 startTime/endTime = (in - tBase) * 1000 ms。
 */
function layerXml(ctx: AmCtx, ly: IRLayer, tBase: number, indent: string): string[] {
  const inn = num(ly.in, 0);
  const out = Math.max(inn, num(ly.out, inn));
  const st = Math.max(0, Math.round((inn - tBase) * 1000));
  const et = Math.max(st + 1, Math.round((out - tBase) * 1000));
  const id = ++ctx.idSeq;
  const blend = ly.blend && ly.blend !== "normal" ? BLEND_AM[ly.blend] : undefined;
  const blendAttr = blend ? ` blending="${blend}"` : "";
  const label = xmlEsc(String(ly.id ?? `L${id}`));
  const L: string[] = [];
  const ind = indent + "  ";

  if (ly.type === "group") {
    // 组 → embedScene 内嵌场景（AM 原生编组形态）
    L.push(
      `${indent}<embedScene id="${id}" label="${label}" startTime="${st}" endTime="${et}" fillType="intrinsic" mediaFillMode="stretch"${blendAttr}>`,
    );
    L.push(...transformXml(ly, inn, out, ind));
    L.push(`${ind}<fillColor value="#ff000000" />`);
    L.push(...effectsXml(ctx, ly, inn, out, ind));
    const innerDur = Math.max(1, et - st);
    L.push(
      `${ind}<scene title="" width="${ctx.canvasW}" height="${ctx.canvasH}" exportWidth="${ctx.canvasW}" exportHeight="${ctx.canvasH}" precompose="dynamicResolution" bgcolor="#00000000" totalTime="${innerDur}" fps="${ctx.fps}" modifiedTime="0" amver="${AM_VER}" ffver="${FF_VER}" am="${AM_APP}" amplatform="${AM_PLATFORM}" retime="off" retimeAdaptFPS="false">`,
    );
    for (const child of ly.children ?? []) {
      L.push(...layerXml(ctx, child, inn, ind + "  "));
    }
    L.push(`${ind}</scene>`);
    L.push(`${indent}</embedScene>`);
    return L;
  }

  if (ly.type === "text") {
    const size = fontPx(ly.font);
    L.push(
      `${indent}<text id="${id}" label="${label}" startTime="${st}" endTime="${et}" fillType="color" mediaFillMode="stretch" size="${f6(size)}" wrapWidth="${Math.round(ctx.canvasW / 2)}" align="${xmlEsc(ly.align ?? "center")}"${blendAttr}>`,
    );
    L.push(...transformXml(ly, inn, out, ind));
    L.push(`${ind}<fillColor value="${amColor(ly.color, "#ffffffff")}" />`);
    L.push(...effectsXml(ctx, ly, inn, out, ind));
    L.push(`${ind}<content>${xmlEsc(ly.text ?? "")}</content>`);
    L.push(`${indent}</text>`);
    return L;
  }

  // shape / image / video / null / 未知 —— 统一 shape 承载
  // image/video 无真实媒体：出彩色占位（label 注明），导入后替换 fillType=media 即可
  const isMedia = ly.type === "image" || ly.type === "video";
  const shapeKind = ly.shape === "ellipse" ? ".circle" : ".rect";
  const w = Math.max(2, num(ly.w, isMedia ? ctx.canvasW : 400));
  const h = Math.max(2, num(ly.h, isMedia ? ctx.canvasH : 400));
  const fill = isMedia ? "#ff555a66" : amColor(ly.fill, "#ff3355aa");
  const mediaLabel = isMedia ? xmlEsc(`[占位:${ly.type}${ly.asset ? ":" + ly.asset : ""}] ${String(ly.id ?? "")}`) : label;
  if (isMedia) L.push(`${indent}<!-- 占位素材(${ly.type}): 导入后请把该 shape 换成真实媒体填充 -->`);
  L.push(
    `${indent}<shape id="${id}" label="${mediaLabel}" startTime="${st}" endTime="${et}" fillType="color" mediaFillMode="stretch" s="${shapeKind}"${blendAttr}>`,
  );
  L.push(...transformXml(ly, inn, out, ind));
  L.push(`${ind}<fillColor value="${fill}" />`);
  L.push(`${ind}<property name="size" type="vec2" value="${f6(w)},${f6(h)}" />`);
  L.push(...effectsXml(ctx, ly, inn, out, ind));
  L.push(`${indent}</shape>`);
  return L;
}

/** IR → AM 工程 XML 字符串 */
export function irToAmXml(ir: IRProject): { xml: string; warnings: string[] } {
  const c = ir.canvas;
  const w = Math.max(4, Math.round(num(c.w, 1920)));
  const h = Math.max(4, Math.round(num(c.h, 1080)));
  const fps = Math.min(120, Math.max(1, Math.round(num(c.fps, 30))));
  const totalMs = Math.max(100, Math.round(num(c.duration, 3) * 1000));
  const ctx: AmCtx = { idSeq: 100000, warnings: [], fps, canvasW: w, canvasH: h };

  const L: string[] = [];
  L.push(`<?xml version='1.0' encoding='UTF-8' ?>`);
  L.push(`<!--`);
  L.push(`由技法图鉴重建生成,仅供学习研究;素材为占位,请替换`);
  L.push(`Generated by gitruck-creation IR->AM converter.`);
  L.push(`-->`);
  L.push(
    `<scene title="${xmlEsc(ir.id ?? "ir")}" width="${w}" height="${h}" exportWidth="${w}" exportHeight="${h}" precompose="dynamicResolution" bgcolor="${amColor(c.bg, "#ff0a0a12")}" totalTime="${totalMs}" fps="${fps}" modifiedTime="${Date.now()}" amver="${AM_VER}" ffver="${FF_VER}" am="${AM_APP}" amplatform="${AM_PLATFORM}" retime="freeze" retimeAdaptFPS="false">`,
  );
  for (const ly of ir.layers ?? []) {
    L.push(...layerXml(ctx, ly, 0, "  "));
  }
  L.push(`</scene>`);
  return { xml: L.join("\n") + "\n", warnings: ctx.warnings };
}

function uuid4(): string {
  const b = new Uint8Array(16);
  (globalThis.crypto ?? { getRandomValues: (a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const s = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** IR → .amproj Blob（zip: {uuid}.xml + manifest.txt；媒体全占位故 manifest 为空） */
export async function irToAmproj(ir: IRProject): Promise<{ blob: Blob; warnings: string[] }> {
  const { xml, warnings } = irToAmXml(ir);
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(`${uuid4()}.xml`, xml);
  zip.file("manifest.txt", "");
  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/zip" });
  return { blob, warnings };
}

export function exportAmXml(ir: IRProject): ExportResult {
  const { xml, warnings } = irToAmXml(ir);
  return { filename: `${ir.id || "ir"}.xml`, mime: "application/xml", data: xml, warnings };
}

export async function exportAmproj(ir: IRProject): Promise<ExportResult> {
  const { blob, warnings } = await irToAmproj(ir);
  return { filename: `${ir.id || "ir"}.amproj`, mime: "application/zip", data: blob, warnings };
}
