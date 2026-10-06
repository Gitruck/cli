/** 指定来源的两端共同契约；与客户端同名文件保持一致。 */
import { parseOnlineOrigin, type OnlineOrigin } from "./online-broll-contract";

export interface ManualCandidate {
 clip_id: string; selection_mode: "manual"; origin: OnlineOrigin;
 cover_url: string; preview_path: null; source: "preview"; raw_url: "";
 seg: { start: number; end: number; best: number };
}
export interface SourceStatus {
 source_url: string; asset_id: string; platform: string; status: "ready" | "failed";
 error_code?: string; retryable?: boolean;
}
export interface SourceImportResult {
 task_id: string; candidates: ManualCandidate[]; sources: SourceStatus[];
 manifest: { url: string; file_id: string }; stop_reason?: string;
}

export function normalizeSourceUrls(input: string[]): string[] {
 if (!input.length || input.length > 32) throw new Error("一次请输入 1–32 条视频链接");
 const urls = input.map(raw => {
  if (/[\s\\\[\]]/.test(raw) || raw.length > 2048) throw new Error("视频链接格式无效");
  const u = new URL(raw);
  if (u.protocol !== "https:" || u.username || u.password || u.port) throw new Error("仅支持四平台 HTTPS 视频链接");
  const host = u.hostname, path = u.pathname;
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
   const id = host === "youtu.be" ? path.slice(1) : path === "/watch" ? u.searchParams.get("v") : path.startsWith("/shorts/") ? path.slice(8) : "";
   if (id && /^[\w-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
  }
  if (["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)) {
   const match = /^\/(?:video\/)?([0-9]{1,15})\/?$/.exec(path);
   if (match) return `https://vimeo.com/${match[1]}`;
  }
  if (["tiktok.com", "www.tiktok.com"].includes(host)) {
   const match = /^\/(@[\w.]+)\/video\/([0-9]{10,25})\/?$/.exec(path);
   if (match) return `https://www.tiktok.com/${match[1]}/video/${match[2]}`;
  }
  if (["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(host)) {
   const match = /^\/video\/(BV[0-9A-Za-z]{10}|av[0-9]+)\/?$/.exec(path), part = u.searchParams.get("p") ?? "1";
   if (match && /^[1-9][0-9]{0,3}$/.test(part)) return `https://www.bilibili.com/video/${match[1]}?p=${part}`;
  }
  throw new Error("链接不是支持的视频页面，请展开短链后再提交");
 });
 return [...new Set(urls)];
}

export function parseSourceImportResult(raw: unknown, taskId: string): SourceImportResult {
 const data = raw as Record<string, any>;
 if (!/^\d{1,30}$/.test(taskId) || !data || data.selection_mode !== "manual" || !Array.isArray(data.results)
  || !Array.isArray(data.sources) || !data.manifest || !/^\d+$/.test(data.manifest.file_id)
  || typeof data.manifest.url !== "string" || !data.manifest.url.startsWith("https://")) throw new Error("指定来源结果格式无效");
 const seen = new Set<string>();
 const candidates = data.results.map((row: Record<string, any>): ManualCandidate => {
  const origin = parseOnlineOrigin(row?.origin), seg = row?.segments?.[0];
  if (!origin || origin.search_task_id !== taskId || row.selection_mode !== "manual"
   || !/^online-[a-f0-9]{24}$/.test(row.clip_id) || seen.has(row.clip_id) || row.segments.length !== 1
   || !seg || seg.start !== origin.source_start || seg.end !== origin.source_end
   || !Number.isFinite(seg.best) || seg.best < seg.start || seg.best >= seg.end) throw new Error("指定来源身份或时间窗无效");
  seen.add(row.clip_id);
  return { clip_id: row.clip_id, selection_mode: "manual", origin, cover_url: typeof row.cover_url === "string" ? row.cover_url : "",
   preview_path: null, source: "preview", raw_url: "", seg: { start: seg.start, end: seg.end, best: seg.best } };
 });
 const sources = data.sources.map((s: SourceStatus) => {
  if (!s || !["ready", "failed"].includes(s.status) || typeof s.source_url !== "string" || !/^[a-f0-9]{24}$/.test(s.asset_id)
   || (s.status === "ready" && !candidates.some(c => c.origin.asset_id === s.asset_id))) throw new Error("来源处理状态无效");
  return s;
 });
 return { task_id: taskId, candidates, sources, manifest: data.manifest, ...(data.stop_reason ? { stop_reason: data.stop_reason } : {}) };
}

export function appendManualSources(meta: Record<string, any>, beatId: string, result: SourceImportResult): Record<string, any> {
 const broll = meta.broll;
 if (!broll || broll.contract_version !== "v1" || !Array.isArray(broll.beats) || !broll.beats.some((b: any) => b.beat === beatId))
  throw new Error("目标 B-roll beat 不存在，请先建立 B-roll 区间");
 return { ...meta, broll: { ...broll, beats: broll.beats.map((b: any) => {
  if (b.beat !== beatId) return b;
  const existing = Array.isArray(b.candidates) ? b.candidates : [];
  const ids = new Set(existing.filter(Boolean).map((c: any) => c.clip_id));
  const candidates = [...existing, ...result.candidates.filter(c => !ids.has(c.clip_id))];
  return { ...b, candidates, online_search_task_ids: [...new Set([...(b.online_search_task_ids ?? []), result.task_id])] };
 }) } };
}
