/**
 * 编排期 QC 的**真实件绑定**（change: add-broll-arrange-atom P3.2）。
 *
 * `arrange-qc.ts` 是纯逻辑（闭环 + 轮数上限 + 缓存策略），一个 IO 都不做——那让它能被穷举测试，
 * 包括「让一个永远不满意的裁判去撞上限」这种在真实件上跑不起来的用例。
 * 本文件负责把它接到真东西上：dispatch 的 lead 句、ffmpeg 抽帧、describe claims 判定、SQLite 缓存。
 *
 * ## 判定的独立性（沿用 alignment-qc 的既有铁则）
 *
 * 选段用 jina 双塔 embed，判定用服务端 VLM **看原始帧 + 稿句**——两族模型失败模式互补。
 * MUST NOT 用 jina 相似度冒充质检（那是拿选它的尺子去量它自己），
 * MUST NOT 拿 describe 已产出的 `desc` 文本喂判定（那是在判自己写的作文）。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DescribeEndpoint, MaterialDescribe } from "./describe";
import { describeImages } from "./describe";
import { extractFrameJpg, type SqlDb } from "./local-index";
import type { LeadSentence, QcCache, QcJudgement, QcProbe } from "./arrange-qc";

/**
 * dispatch + 重投影索引 → lead 句表。
 *
 * lead 句 = 各 beat 的 `span.from`（派单里的领衔句，画面为它而挑）。跟随句不判——
 * 它们是抽象/数字/修辞句，蹭领衔镜头保节奏自然，其 mismatch 属设计非缺陷。
 *
 * ⚠️ 时码取**重投影后**的 `utteranceIndex`，不取 dispatch 里的快照时码：
 * 快照是投影时刻的，用户改完口播轨它就过期了，拿它去定位抽帧位会抽到错的帧。
 * 拿不到重投影索引 ⇒ 回空表（不判，不是判过了）。
 */
export function leadSentencesFrom(
	dispatch: { film_broll?: Array<{ beat?: string; span?: { from?: string } }> } | undefined,
	utteranceIndex: Map<string, { track_st: number; track_ed: number; text: string }> | undefined,
): LeadSentence[] {
	if (!dispatch?.film_broll || !utteranceIndex) return [];
	const out: LeadSentence[] = [];
	for (const f of dispatch.film_broll) {
		const id = f.span?.from;
		if (!id) continue;
		const u = utteranceIndex.get(id);
		if (!u) continue; // 该句在重投影里已不存在（改稿删句）——不判，不是判过了
		out.push({
			id,
			text: u.text,
			track_mid: Math.round(((u.track_st + u.track_ed) / 2) * 1000) / 1000,
			beat: f.beat ?? id,
		});
	}
	return out;
}

/** SQLite 判定缓存（`qc_verdicts` 表，键 = material_id + ts_ms + claim 哈希）。 */
export function sqliteQcCache(db: SqlDb, materialIdFor: (clipId: string) => string): QcCache {
	return {
		get(clipId, tsMs, claimHash) {
			const row = db.get<{ verdict: string; reason: string | null; frame_desc: string | null }>(
				"SELECT verdict, reason, frame_desc FROM qc_verdicts WHERE material_id = ? AND ts_ms = ? AND claim_hash = ?",
				[materialIdFor(clipId), tsMs, claimHash],
			);
			if (!row) return undefined;
			// 未知 verdict 取值按未命中处理：宁可重判一次，也不拿一个读不懂的结论去决定换不换候选
			if (row.verdict !== "match" && row.verdict !== "partial" && row.verdict !== "mismatch") return undefined;
			return {
				verdict: row.verdict,
				...(row.reason ? { reason: row.reason } : {}),
				...(row.frame_desc ? { frame_desc: row.frame_desc } : {}),
			};
		},
		put(clipId, tsMs, claimHash, j) {
			db.run(
				"INSERT OR REPLACE INTO qc_verdicts(material_id, ts_ms, claim_hash, verdict, reason, frame_desc, created_at) VALUES (?,?,?,?,?,?,?)",
				[materialIdFor(clipId), tsMs, claimHash, j.verdict, j.reason ?? null, j.frame_desc ?? null, new Date().toISOString()],
			);
		},
	};
}

export interface JudgeDeps {
	endpoint: DescribeEndpoint;
	ffmpeg: string;
	/** clip_id → 源片绝对路径。拿不到的探针**跳过而不是判 mismatch**（见下）。 */
	sourcePathFor: (clipId: string) => string | undefined;
	/** 测试注入：绕开 ffmpeg 与网络。 */
	extractFrame?: (path: string, tsSec: number, outJpg: string) => Promise<boolean>;
	describeBatch?: (images: string[], claims: (string | null)[]) => Promise<MaterialDescribe[]>;
	log?: { info: (m: string) => void; warn: (m: string) => void };
}

/** 服务端返回行 → 判定。 */
function verdictOf(d: MaterialDescribe | undefined): QcJudgement {
	const raw = (d as { claim_aligned?: unknown; claim_reason?: unknown } | undefined)?.claim_aligned;
	const reason = typeof (d as { claim_reason?: unknown } | undefined)?.claim_reason === "string"
		? ((d as { claim_reason: string }).claim_reason)
		: undefined;
	const base = { ...(reason ? { reason } : {}), ...(d?.desc ? { frame_desc: d.desc } : {}) };
	// 服务端未升级（缺 claim_aligned）⇒ **降级为 partial**，MUST NOT 当 mismatch：
	// 把「判不了」当成「没对上」会触发一轮白换候选，把好镜头换成差镜头。
	if (typeof raw !== "number") return { verdict: "partial", ...base };
	if (raw >= 0.8) return { verdict: "match", ...base };
	if (raw >= 0.4) return { verdict: "partial", ...base };
	return { verdict: "mismatch", ...base };
}

/**
 * 真实判定器：抽帧 → describe claims → 判定。
 *
 * **抽不到帧的探针一律回 `partial` 而不是 `mismatch`**：抽帧失败是我们这边的问题
 * （源文件被挪走、编码异常、ffmpeg 缺失），不是这颗镜头不对。判成 mismatch 会让闭环
 * 白换一轮候选，把一个可能完全正确的镜头换掉。
 */
export function makeJudge(deps: JudgeDeps): (probes: QcProbe[]) => Promise<QcJudgement[]> {
	const log = deps.log ?? { info: () => {}, warn: () => {} };
	return async (probes) => {
		const dir = mkdtempSync(join(tmpdir(), "gtrk-arrange-qc-"));
		try {
			const frames: Array<{ i: number; b64: string; sentence: string }> = [];
			const out: QcJudgement[] = probes.map(() => ({ verdict: "partial", reason: "未判定" }));

			for (let i = 0; i < probes.length; i++) {
				const p = probes[i]!;
				const src = deps.sourcePathFor(p.clipId);
				if (!src || !existsSync(src)) {
					out[i] = { verdict: "partial", reason: "源片不可读，本句跳过判定（不是画面不对）" };
					continue;
				}
				const jpg = join(dir, `${i}.jpg`);
				const ok = deps.extractFrame
					? await deps.extractFrame(src, p.sourceSec, jpg)
					: await extractFrameJpg(deps.ffmpeg, src, p.sourceSec, jpg);
				if (!ok || !existsSync(jpg)) {
					out[i] = { verdict: "partial", reason: "抽帧失败，本句跳过判定（不是画面不对）" };
					continue;
				}
				frames.push({ i, b64: readFileSync(jpg).toString("base64"), sentence: p.sentence });
			}

			if (frames.length === 0) {
				log.warn("编排期 QC：本轮一帧都没抽到，全部跳过判定——请检查源片是否还在原位。");
				return out;
			}
			const rows = deps.describeBatch
				? await deps.describeBatch(frames.map((f) => f.b64), frames.map((f) => f.sentence))
				: await describeImages(deps.endpoint, frames.map((f) => f.b64), {}, { claims: frames.map((f) => f.sentence) });
			frames.forEach((f, k) => {
				out[f.i] = verdictOf(rows[k]);
			});
			return out;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}
