import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CloudConfig } from "./config";
import { pollTask, submitTask } from "./cloud";
import { claimOnlineSearch } from "./online-search-journal";
import { appendManualSources, normalizeSourceUrls, parseSourceImportResult } from "./source-import-contract";
import { assertGtrkV1, readGtrk, writeGtrkAtomic } from "./gtrk-writeback";

export interface SourceImportOptions { project?: string; beat?: string; url?: string[]; urls?: string; out?: string; onlineSession?: string }
export async function importSources(cfg: CloudConfig, opts: SourceImportOptions, deps = { submitTask, pollTask }) {
 if (!opts.project && !opts.out) throw new Error("需要 --project <工程目录> 或 --out <结果文件>");
 if (Boolean(opts.project) !== Boolean(opts.beat)) throw new Error("--project 和 --beat 必须一起提供");
 const input = [...(opts.url ?? []), ...(opts.urls ? (await readFile(opts.urls, "utf8")).replace(/^\uFEFF/, "").split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [])];
 const source_urls = normalizeSourceUrls(input);
 const gtrkPath = opts.project ? [join(resolve(opts.project), "gtrk/project.gtrk"), join(resolve(opts.project), "project.gtrk")].find(existsSync) : undefined;
 if (opts.project && !gtrkPath) throw new Error("找不到工程文件");
 const initial = gtrkPath ? readGtrk(gtrkPath) : undefined;
 if (initial) {
  assertGtrkV1(initial.gtrk);
  // 在计费建单前检查目标；空结果只用于验证，不落盘。
  appendManualSources((initial.gtrk.struct_meta ?? {}) as Record<string, any>, opts.beat!, { task_id: "0", candidates: [], sources: [], manifest: {url:"", file_id:""} });
 }
 const journalDir = opts.project ? join(resolve(opts.project), "split/.source-import", encodeURIComponent(opts.beat!)) : `${resolve(opts.out!)}.source-import`;
 const submission = await claimOnlineSearch(journalDir, cfg, { source_urls }, opts.onlineSession);
 const out = opts.out ? resolve(opts.out) : join(journalDir, `${submission.requestId}.result.json`);
 if (gtrkPath && resolve(out).toLowerCase() === resolve(gtrkPath).toLowerCase()) throw new Error("--out 不能覆盖工程文件");
 await mkdir(dirname(out), { recursive: true });
 const taskId = await deps.submitTask(cfg, "cli/online_broll_search", { source_urls, request_id: submission.requestId });
 const result = parseSourceImportResult(await deps.pollTask(cfg, "cli/online_broll_search", taskId), taskId);
 // 先留完整回执；工程写回冲突也不会丢失已付费任务身份和逐条诊断。
 await writeFile(out, JSON.stringify(result, null, 2));
 if (initial && gtrkPath && result.candidates.length) {
  const next = { ...initial.gtrk, struct_meta: appendManualSources((initial.gtrk.struct_meta ?? {}) as Record<string, any>, opts.beat!, result) };
  writeGtrkAtomic(gtrkPath, next, initial.revision, "source-import");
 }
 return { ok: result.candidates.length > 0, mode: "source-import" as const,
  outcome: result.candidates.length ? result.sources.some(s => s.status === "failed") ? "partial" : "ready" : "unavailable",
  ...result, out, ...(gtrkPath ? { gtrk: gtrkPath, beat: opts.beat } : {}) };
}
