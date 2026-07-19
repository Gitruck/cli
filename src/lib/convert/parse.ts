/**
 * 工程文件解析统一入口：按扩展名分发到 AM / NV 解析器。
 *
 *   parseProject(file) → { ir, warnings, format }
 *
 * 全程纯前端（文件不出浏览器）；错误信息一律人话化，直接可展示给用户。
 */
import { parseAmproj, parseAmXml } from "./am_parse";
import { parseNvText, parseNvZip } from "./nv_parse";
import type { IRProject } from "./types";

/** 大文件防线：超过 80MB 直接拒绝（NV 真机样本有 196MB 巨物，整读会卡死页面） */
export const MAX_PARSE_BYTES = 80 * 1024 * 1024;

export type ParseFormat = "am" | "amproj" | "nv";

export interface ParsedProject {
  ir: IRProject;
  warnings: string[];
  format: ParseFormat;
}

export async function parseProject(file: File): Promise<ParsedProject> {
  const name = file.name || "";
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";

  if (file.size > MAX_PARSE_BYTES) {
    const mb = Math.round(file.size / 1048576);
    throw new Error(
      `文件太大（约 ${mb}MB，超过 80MB 上限），浏览器整读会卡死。请先在原工具里删掉未用素材/精简工程后再试。`,
    );
  }
  if (file.size === 0) {
    throw new Error("文件是空的（0 字节），请确认导出/拷贝过程没有出错。");
  }

  try {
    switch (ext) {
      case "xml": {
        const r = parseAmXml(await file.text());
        return { ...r, format: "am" };
      }
      case "amproj": {
        const r = await parseAmproj(await file.arrayBuffer());
        return { ...r, format: "amproj" };
      }
      case "nv": {
        const r = parseNvText(await file.text());
        return { ...r, format: "nv" };
      }
      case "zip": {
        // NodeVideo「导出工程包」产物：zip 内套 .nv
        const r = await parseNvZip(await file.arrayBuffer());
        return { ...r, format: "nv" };
      }
      default:
        throw new Error(
          `不认识「.${ext || "?"}」格式：目前支持 .xml / .amproj（Alight Motion）和 .nv / .zip 工程包（NodeVideo）。`,
        );
    }
  } catch (e) {
    // 解析器抛出的已是人话；兜底把未知异常包一层
    if (e instanceof Error && /[一-鿿]/.test(e.message)) throw e;
    const brief = e instanceof Error ? e.message.slice(0, 120) : String(e);
    throw new Error(`解析失败：${brief || "未知错误"}`);
  }
}
