/**
 * 对齐质检编排（add-shot-cards-and-alignment-qc 1.4 · CLI 专属杀手锏，不外显）。
 *
 * 判什么：铺完的成片里，每句叙述稿对应位置的画面**是否给到稿句所说的东西**——
 * 小伙伴人眼「20% 没给到预期画面」的机器刻度（260828 拉面店基线 75.0% 与人眼 75 分互证）。
 *
 * 裁判独立性（proposal 铁则）：选段=jina 双塔 embed，判定=服务端 VLM 看**原始帧+稿句**
 * （material_describe 的 claims 扩参，仅 CLI 条路由解析）——两族模型失败模式互补；
 * MUST NOT 用 jina 相似度冒充质检，MUST NOT 拿 describe 已产出的 desc 文本喂判定。
 *
 * 防冗余（proposal 铁则）：只审**检索/铺排段**；plan 里 query 含「引用段」的 beat
 * （画音对齐由 clip_st/track_st 恒等式结构校验，Δ=0）整段跳过，不烧判定积分。
 * 粒度=稿句级（每句 1 帧，取句中点对应的已铺画面帧）。
 *
 * agent 视觉不可依赖（公约 §二″）：判定在云端 VLM，本编排产物全是文本+缩略图文件——
 * 纯文本 agent 读 JSON 报告即可闭环。降级路：服务端未升级（返回行缺 claim_aligned）时
 * 不失败整命令——报告降级形态（帧 desc + 稿句配对表交 agent 文本裁定），打可读 INFO。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	describeImages,
	putCachedDescribe,
	DESCRIBE_CREDITS_PER_IMAGE,
	type DescribeEndpoint,
	type MaterialDescribe,
} from "./describe";
import { extractFrameJpg, openLocalIndexDb, type SqlDb } from "./local-index";

/** 单句审计条目（alignment-audit.json items[]）。 */
export interface AlignmentItem {
	id: string;
	sentence: string;
	/** 成片轴句中点（秒）。 */
	track_mid: number;
	clip_id: string | null;
	/** 源片路径 + 源内时刻（抽帧位）。 */
	source_path: string | null;
	source_sec: number | null;
	/** 判定（服务端 claims；降级时缺席）。 */
	aligned?: number;
	verdict?: "match" | "partial" | "mismatch";
	reason?: string;
	/** 该帧客观描述（判定与降级两态都有，供人读对照表）。 */
	frame_desc?: string;
	/** 缩略图相对路径（对照表嵌图，公约 §二″ 给用户眼睛的，不是给 agent 的）。 */
	thumb?: string;
	/** 跳过原因（引用段/无覆盖 clip/抽帧失败）。 */
	skipped?: string;
}

export interface AlignmentReport {
	qc_version: "alignment-v1";
	project: string;
	generated_at: string;
	degraded: boolean;
	summary: {
		audited: number;
		skipped: number;
		match: number;
		partial: number;
		mismatch: number;
		/** match=1 / partial=0.5 / mismatch=0 计分；降级时 null。 */
		rate: number | null;
	};
	items: AlignmentItem[];
}

interface GtrkClip {
	clip_id?: string;
	material?: string;
	clip_st: string | number;
	clip_ed: string | number;
	track_st: string | number;
	track_ed: string | number;
}

const num = (v: string | number): number => (typeof v === "number" ? v : Number.parseFloat(v));

/** 引用段 beat 的成片轴区间（防冗余排除域）：plan 里 query 含「引用段”的 beat。 */
export function quoteSpansFromPlan(planJson: unknown): Array<[number, number]> {
	const beats = (planJson as { beats?: unknown } | null)?.beats;
	if (!Array.isArray(beats)) return [];
	const spans: Array<[number, number]> = [];
	for (const b of beats) {
		const beat = b as { track_st?: number; track_ed?: number; queries?: Array<{ query?: string }> };
		if (
			Array.isArray(beat.queries) &&
			beat.queries.some((q) => typeof q?.query === "string" && q.query.includes("引用段")) &&
			typeof beat.track_st === "number" &&
			typeof beat.track_ed === "number"
		) {
			spans.push([beat.track_st, beat.track_ed]);
		}
	}
	return spans;
}

/** 稿句 ↔ 已铺画面配对（纯函数，可单测）：句中点 → 覆盖 clip → 源内时刻。 */
export function pairSentencesWithClips(args: {
	utterances: Array<{ id: string; text: string; st: number; ed: number }>;
	clips: GtrkClip[];
	materials: Record<string, string>;
	quoteSpans: Array<[number, number]>;
}): AlignmentItem[] {
	const sorted = [...args.clips].sort((a, b) => num(a.track_st) - num(b.track_st));
	return args.utterances.map((u) => {
		const mid = (u.st + u.ed) / 2;
		const base: AlignmentItem = {
			id: u.id,
			sentence: u.text,
			track_mid: Math.round(mid * 1000) / 1000,
			clip_id: null,
			source_path: null,
			source_sec: null,
		};
		// 引用段跳过双判据：plan 标注（新批规范）∪ 转写文本「（…原声）」前缀（存量工程兜底——
		// 260828 拉面店实测其 plan 用「甲档出处直排」旧标签，纯 plan 判据漏跳 2 句烧了无谓判定）
		const isQuoteText = /^（[^）]*原声）/.test(u.text.trim());
		if (isQuoteText || args.quoteSpans.some(([a, b]) => u.st >= a - 0.05 && u.ed <= b + 0.05)) {
			return { ...base, skipped: "quote" }; // 引用段：结构校验已覆盖，不烧判定
		}
		const clip = sorted.find((c) => num(c.track_st) <= mid && mid < num(c.track_ed));
		if (!clip) return { ...base, skipped: "no_clip" };
		const srcSec = num(clip.clip_st) + (mid - num(clip.track_st));
		const path = clip.material ? (args.materials[clip.material] ?? null) : null;
		if (!path) return { ...base, clip_id: clip.clip_id ?? null, skipped: "no_material_path" };
		return {
			...base,
			clip_id: clip.clip_id ?? null,
			source_path: path,
			source_sec: Math.round(srcSec * 1000) / 1000,
		};
	});
}

/** verdict 计分（match=1 / partial=0.5 / mismatch=0）。 */
export function alignmentRate(items: AlignmentItem[]): number | null {
	const judged = items.filter((i) => i.verdict);
	if (judged.length === 0) return null;
	const score = judged.reduce(
		(acc, i) => acc + (i.verdict === "match" ? 1 : i.verdict === "partial" ? 0.5 : 0),
		0,
	);
	return Math.round((score / judged.length) * 1000) / 10;
}

export interface AlignmentRunDeps {
	endpoint: DescribeEndpoint;
	ffmpeg: string;
	/** 计费确认（--yes 跳过）。 */
	confirm: (msg: string) => Promise<boolean>;
	yes: boolean;
	onLog?: (msg: string) => void;
	/** 测试注入：服务端批判定替身。 */
	describeBatch?: (images: string[], claims: (string | null)[]) => Promise<MaterialDescribe[]>;
	/** 测试注入：抽帧替身。 */
	extractFrame?: (src: string, tsSec: number, outJpg: string) => Promise<boolean>;
	/** 索引库（客观卡片顺手写缓存；测试可注入内存库）。 */
	db?: SqlDb;
}

export async function runAlignmentQc(projectDir: string, deps: AlignmentRunDeps): Promise<AlignmentReport> {
	const log = deps.onLog ?? (() => {});
	const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf-8"));
	const gtrkPath = join(projectDir, "gtrk", "project.gtrk");
	const transcriptPath = join(projectDir, "transcript", "transcript.json");
	if (!existsSync(gtrkPath) || !existsSync(transcriptPath)) {
		throw new Error(`工程不完整：需要 ${gtrkPath} 与 ${transcriptPath}（oralcut/project init 产物布局）`);
	}
	const gtrk = readJson(gtrkPath) as {
		video_track?: Array<{ track_timeline?: GtrkClip[] }>;
		materials?: Array<{ id?: string; path?: string }>;
	};
	const transcript = readJson(transcriptPath) as {
		utterances?: Array<{ id: string; text: string; st: number; ed: number }>;
	};
	const planPath = join(projectDir, "split", "broll-plan.json");
	const quoteSpans = existsSync(planPath) ? quoteSpansFromPlan(readJson(planPath)) : [];

	const clips = gtrk.video_track?.[0]?.track_timeline ?? [];
	const materials: Record<string, string> = {};
	for (const m of gtrk.materials ?? []) if (m.id && m.path) materials[m.id] = m.path;

	const items = pairSentencesWithClips({
		utterances: transcript.utterances ?? [],
		clips,
		materials,
		quoteSpans,
	});

	// ── 抽帧（句中点对应的**已铺**画面帧；temp 目录即用即弃，缩略图落工程 qc/ 供对照表嵌图）──
	const qcDir = join(projectDir, "qc");
	const thumbDir = join(qcDir, "alignment-frames");
	mkdirSync(thumbDir, { recursive: true });
	const tmp = join(tmpdir(), `gtrk-alignment-${process.pid}`);
	mkdirSync(tmp, { recursive: true });
	const extract = deps.extractFrame ?? ((src, ts, out) => extractFrameJpg(deps.ffmpeg, src, ts, out));

	const auditable: AlignmentItem[] = [];
	for (const it of items) {
		if (it.skipped || it.source_path === null || it.source_sec === null) continue;
		const jpg = join(tmp, `${it.id}.jpg`);
		const ok = await extract(it.source_path, it.source_sec, jpg);
		if (!ok) {
			it.skipped = "frame_extract_failed";
			continue;
		}
		const thumb = join(thumbDir, `${it.id}.jpg`);
		copyFileSync(jpg, thumb);
		it.thumb = `alignment-frames/${it.id}.jpg`;
		auditable.push(it);
	}

	// ── 计费确认（1 积分/帧；稿句级粒度=防冗余铁则）──
	const credits = auditable.length * DESCRIBE_CREDITS_PER_IMAGE;
	if (auditable.length > 0 && !deps.yes) {
		const go = await deps.confirm(
			`对齐质检将逐句判定 ${auditable.length} 帧（约 ${credits} 积分，1 积分/帧；引用段已按结构校验跳过）。确认继续？`,
		);
		if (!go) {
			rmSync(tmp, { recursive: true, force: true });
			throw new Error("对齐质检计费确认被拒绝——零调用零计费");
		}
	}

	// ── 服务端 claims 批判定（裁判=VLM 看原始帧+稿句）──
	let degraded = false;
	if (auditable.length > 0) {
		const images = auditable.map((it) => readFileSync(join(tmp, `${it.id}.jpg`)).toString("base64"));
		const claims = auditable.map((it) => it.sentence);
		const rows = deps.describeBatch
			? await deps.describeBatch(images, claims)
			: await describeImages(deps.endpoint, images, {}, { claims });
		// 降级判据：**全部**行都缺判定字段=服务端未升级（整体降级）；零星缺行=VLM 偶发漏字段
		// （260828 拉面店实测 32 行漏 1 行），该行单独按「待裁定」处理，不拖垮整场审计。
		degraded = rows.length > 0 && rows.every((r) => r.claim_aligned === undefined);
		rows.forEach((r, i) => {
			const it = auditable[i];
			it.frame_desc = r.desc;
			if (r.claim_aligned !== undefined) {
				it.aligned = r.claim_aligned;
				it.verdict = r.claim_verdict;
				it.reason = r.claim_reason;
			}
			// 客观卡片顺手写缓存（免费副产物；claim 字段刻意不入缓存——判定随稿句走，不可复用）
			if (deps.db && it.source_path !== null && it.source_sec !== null) {
				try {
					putCachedDescribe(deps.db, `align-${basename(it.source_path)}`, Math.round(it.source_sec * 1000), {
						...r,
						claim_aligned: undefined,
						claim_verdict: undefined,
						claim_reason: undefined,
					});
				} catch {
					/* 缓存写失败不影响审计结果 */
				}
			}
		});
		if (degraded) {
			log(
				"[对齐质检] 服务端未返回判定字段（material_describe 未升级或旧版本）——降级为配对表+帧描述，" +
					"裁定交 agent 文本判读（帧 desc 已在报告 items[].frame_desc）",
			);
		} else {
			const holes = rows.filter((r) => r.claim_aligned === undefined).length;
			if (holes > 0) log(`[对齐质检] ${holes} 行 VLM 漏出判定字段，按「待裁定」单列（frame_desc 在场可人工/agent 补裁）`);
		}
	}
	rmSync(tmp, { recursive: true, force: true });

	const judged = items.filter((i) => i.verdict);
	const report: AlignmentReport = {
		qc_version: "alignment-v1",
		project: projectDir,
		generated_at: new Date().toISOString(),
		degraded,
		summary: {
			audited: auditable.length,
			skipped: items.length - auditable.length,
			match: judged.filter((i) => i.verdict === "match").length,
			partial: judged.filter((i) => i.verdict === "partial").length,
			mismatch: judged.filter((i) => i.verdict === "mismatch").length,
			rate: alignmentRate(items),
		},
		items,
	};

	// ── 落盘：机读 JSON + 人读对照表（嵌缩略图，用户不必按时码翻原片）──
	writeFileSync(join(qcDir, "alignment-audit.json"), JSON.stringify(report, null, 1), "utf-8");
	const md: string[] = [
		`# 稿句 ↔ 画面对齐审计（${report.generated_at}）`,
		"",
		report.summary.rate !== null
			? `**对齐率 ${report.summary.rate}%**（match ${report.summary.match} / partial ${report.summary.partial} / mismatch ${report.summary.mismatch}，n=${report.summary.audited}；match=1、partial=0.5 计分）`
			: `**降级形态**（服务端未升级）：帧描述已产出，逐句裁定交 agent 文本判读`,
		"",
		"| 句 | 稿句 | 画面 | 判定 | 说明 |",
		"|---|---|---|---|---|",
	];
	for (const it of items) {
		const img = it.thumb ? `![${it.id}](${it.thumb})` : it.skipped === "quote" ? "（引用段·结构校验）" : `（跳过：${it.skipped ?? "?"}）`;
		const verdict = it.verdict ? `${it.verdict}（${it.aligned}）` : it.skipped ? "—" : "待裁定";
		md.push(`| ${it.id} | ${it.sentence.replace(/\|/g, "\\|")} | ${img} | ${verdict} | ${(it.reason ?? it.frame_desc ?? "").replace(/\|/g, "\\|")} |`);
	}
	writeFileSync(join(qcDir, "alignment-audit.md"), md.join("\n"), "utf-8");
	return report;
}

/** 打开索引库连接（qc 命令层用；失败返回 undefined = 只丢缓存副产物，不影响审计）。 */
export function tryOpenIndexDb(): Promise<SqlDb | undefined> {
	return openLocalIndexDb().catch(() => undefined);
}
