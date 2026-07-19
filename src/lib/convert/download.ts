/**
 * 统一导出入口 + 浏览器 Blob 下载帮助。
 *
 *   exportProject(ir, "jsx" | "am" | "amproj" | "nv")  → ExportResult
 *   downloadExport(result)                              → 触发浏览器下载
 *   exportAndDownload(ir, format)                       → 一步到位
 */
import { exportAmproj, exportAmXml } from "./ir_to_am";
import { exportJsx } from "./ir_to_jsx";
import { exportNv } from "./ir_to_nv";
import type { ExportFormat, ExportResult, IRProject } from "./types";

/** IR → 指定格式产物（amproj 走异步 zip，其余同步产文本） */
export async function exportProject(ir: IRProject, format: ExportFormat): Promise<ExportResult> {
  switch (format) {
    case "jsx":
      return exportJsx(ir);
    case "am":
      return exportAmXml(ir);
    case "amproj":
      return exportAmproj(ir);
    case "nv":
      return exportNv(ir);
    default:
      throw new Error(`未知导出格式: ${String(format)}`);
  }
}

/** ExportResult → Blob */
export function toBlob(result: ExportResult): Blob {
  if (result.data instanceof Blob) return result.data;
  return new Blob([result.data], { type: `${result.mime};charset=utf-8` });
}

/** 触发浏览器下载（仅浏览器环境；SSR/测试环境下抛错） */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined") {
    throw new Error("downloadBlob 仅限浏览器环境");
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // 延迟回收,避免部分浏览器取消下载
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1500);
}

export function downloadExport(result: ExportResult): void {
  downloadBlob(toBlob(result), result.filename);
}

/** 一步导出+下载，返回转换告警（供 UI 提示） */
export async function exportAndDownload(ir: IRProject, format: ExportFormat): Promise<string[]> {
  const result = await exportProject(ir, format);
  downloadExport(result);
  return result.warnings;
}
