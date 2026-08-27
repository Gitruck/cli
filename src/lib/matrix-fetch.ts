/**
 * gtrk matrix fetch —— 精剪期拉原片（add-matrix-raw-fetch，resign 消费口，CLI 首个）。
 *
 * 两段式动线的第二段：`matrix search`（计费检索、出候选、成功即灌授予账本 gc_material_grant）→
 * 用户/agent 挑定 clip_id → 本件（免费重签 + 下载落盘）。fetch 自身零计费、不发起检索、
 * 不隐式批量拉取未点名的候选。
 *
 * resign 契约（tasks 0.2 实读 `api/material_resign.py` 定稿）：
 * `POST /task/material_resign` body `{clip_ids: string[]}`（≤500，字符串传防 JS 精度、数字兼容）；
 * 响应 data = `{clips:[{clip_id,url}], missing:[{clip_id,reason}]}`；reason = 「未购授予」「clip_id 非法」
 * （api 层）∪ master 侧可见性 reason（透传）。未购不连坐、不触 master；授予持久 ⇒ 24h 过期签名不构成障碍。
 *
 * 首发射程 = 仅 clip 原片：clip/image/audio 共享雪花数字 id 空间、静态判形不可行（design D3 退化分支）——
 * master 侧可见性 missing 逐条透传 reason 并附「若是图片/音频素材属暂不支持」提示，不自造判据。
 */
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { stat } from "node:fs/promises";
import type { CloudConfig } from "./config";
import { loadConfig } from "./config";
import { parseJson, CloudError, download as realDownload } from "./cloud";
import { assertNotJianyingDraftDir } from "./mg-render";
import { log } from "./log";

/** 服务端单批上限（api MAX_RESIGN_BATCH 同值；CLI 前置校验并提示分批）。 */
export const MAX_FETCH_BATCH = 500;

export const REASON_NOT_GRANTED = "未购授予";
export const REASON_INVALID_ID = "clip_id 非法";

/** 未购项的出路提示（对齐 resign spec 不连坐语义：报因之外还要指路）。 */
export const HINT_NOT_GRANTED = "对该素材的关键词跑一次计费检索（gtrk matrix search）即获持久授予，之后可无限免费重签";
/** master 侧可见性 missing 的附加提示（判形不可行 ⇒ 透传 + 提示，见文件头）。 */
export const HINT_MAYBE_UNSUPPORTED = "若该 id 是图片/音频素材：重签面现仅覆盖视频 clip 原片，属暂不支持；若是视频素材则多半已下架/不在库";

export interface ResignMissing {
	clip_id: string;
	reason: string;
	/** CLI 转译层附加的出路/解释提示（服务端报因原样保留在 reason）。 */
	hint?: string;
}

export interface FetchedItem {
	clip_id: string;
	/** 落盘文件绝对路径。 */
	file: string;
	bytes: number;
}

export interface MatrixFetchResult {
	ok: boolean;
	mode: "fetch";
	requested: number;
	downloaded: FetchedItem[];
	missing: ResignMissing[];
	/** 下载阶段失败的条目（resign 放行但下载失败——与授予无关，报因供重试）。 */
	failed: { clip_id: string; reason: string }[];
	outDir: string;
	[k: string]: unknown;
}

export interface MatrixFetchDeps {
	loadCfg?: () => CloudConfig;
	fetchFn?: typeof fetch;
	download?: typeof realDownload;
}

/** 缺省落点：显式 --out 优先，缺省当前目录子文件夹（产物落点纪律，与 mg render 同构）。 */
export function resolveFetchOutDir(out?: string): string {
	return resolve(out ?? "matrix-fetch");
}

/** 从 resign url 提取扩展名（`…/raw/<id>.mp4?expires=…` → `mp4`）；取不到回落 `bin`。 */
export function extFromUrl(url: string): string {
	try {
		const path = new URL(url).pathname;
		const m = /\.([A-Za-z0-9]{1,5})$/.exec(path);
		return m ? m[1].toLowerCase() : "bin";
	} catch {
		return "bin";
	}
}

/** missing 分类转译：reason 原样保留，按类附加出路/解释提示（不吞并、不合并、不自造判据）。 */
export function translateMissing(missing: { clip_id?: unknown; reason?: unknown }[]): ResignMissing[] {
	return (missing ?? []).map((m) => {
		const clip_id = String(m?.clip_id ?? "");
		const reason = String(m?.reason ?? "未知原因");
		if (reason === REASON_NOT_GRANTED) return { clip_id, reason, hint: HINT_NOT_GRANTED };
		if (reason === REASON_INVALID_ID) return { clip_id, reason };
		return { clip_id, reason, hint: HINT_MAYBE_UNSUPPORTED };
	});
}

/** 调 resign：整批一次（D1，≤500 由调用方前置校验），返回 {clips, missing} 原始形态。 */
export async function resignMaterials(
	cfg: CloudConfig,
	clipIds: string[],
	fetchFn: typeof fetch = fetch,
): Promise<{ clips: { clip_id: string; url: string }[]; missing: { clip_id: string; reason: string }[] }> {
	const res = await fetchFn(`${cfg.base}/task/material_resign`, {
		method: "POST",
		headers: { Authorization: cfg.apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({ clip_ids: clipIds }),
	});
	const r = await parseJson<{ clips?: { clip_id: string; url: string }[]; missing?: { clip_id: string; reason: string }[] }>(res);
	if (r.code !== 200) {
		throw new CloudError(r.code, `原片重签失败 (code=${r.code ?? "?"})：${r.msg ?? "未知错误"}`);
	}
	return { clips: r.data?.clips ?? [], missing: r.data?.missing ?? [] };
}

/**
 * fetch 主链：≤500 前置校验 → resign 整批一次 → 新鲜签名串行下载 `<clip_id>.<ext>` → 逐条摘要。
 * 零计费（resign 非计费直通）——无确认闸，如实呈现。
 */
export async function fetchMaterials(
	opts: { clipIds: string[]; out?: string },
	deps: MatrixFetchDeps = {},
): Promise<MatrixFetchResult> {
	const clipIds = [...new Set(opts.clipIds.map((s) => s.trim()).filter(Boolean))];
	if (!clipIds.length) throw new Error('用法：gtrk matrix fetch <clip_id...> [--out <dir>]——clip_id 来自 matrix search 的候选结果');
	if (clipIds.length > MAX_FETCH_BATCH) {
		throw new Error(`单批最多 ${MAX_FETCH_BATCH} 条（收到 ${clipIds.length}）——分批再跑；授予持久、重签免费，分几批都不花钱`);
	}
	const outDir = resolveFetchOutDir(opts.out);
	assertNotJianyingDraftDir(outDir);

	log.step(`▶ 原片重签 ${clipIds.length} 条（免费——授予的账在计费检索时已记完）…`);
	const cfg = (deps.loadCfg ?? loadConfig)();
	const { clips, missing: rawMissing } = await resignMaterials(cfg, clipIds, deps.fetchFn);
	const missing = translateMissing(rawMissing);

	const downloaded: FetchedItem[] = [];
	const failed: { clip_id: string; reason: string }[] = [];
	if (clips.length) await mkdir(outDir, { recursive: true });
	for (const c of clips) {
		const dest = join(outDir, `${c.clip_id}.${extFromUrl(c.url)}`);
		try {
			await (deps.download ?? realDownload)(c.url, dest);
			const bytes = (await stat(dest)).size;
			downloaded.push({ clip_id: c.clip_id, file: dest, bytes });
			log.info(`✓ ${c.clip_id} → ${dest}（${(bytes / 1048576).toFixed(1)}MB）`);
		} catch (e) {
			// 下载失败 ≠ 授予问题：逐条报因不中止（新鲜签名仍在有效期内，按 clip_id 重跑即可）
			failed.push({ clip_id: c.clip_id, reason: (e as Error).message });
			log.warn(`✗ ${c.clip_id} 下载失败：${(e as Error).message}（授予仍在，重跑 fetch 该 id 即可）`);
		}
	}
	for (const m of missing) {
		log.warn(`✗ ${m.clip_id}：${m.reason}${m.hint ? `——${m.hint}` : ""}`);
	}

	const ok = missing.length === 0 && failed.length === 0;
	const tail = `${downloaded.length}/${clipIds.length} 落盘 → ${outDir}${missing.length ? `（${missing.length} 条被拦）` : ""}${failed.length ? `（${failed.length} 条下载失败）` : ""}`;
	(ok ? log.ok : log.warn)(`拉取${ok ? "完成" : "完成（有未落盘项）"}：${tail}`);
	return { ok, mode: "fetch", requested: clipIds.length, downloaded, missing, failed, outDir };
}
