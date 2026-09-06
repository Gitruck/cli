/**
 * 云端字幕行拆分薄客户端（link-subtitle-lay-cloud-line-split）：
 * `POST {base}/task/cli/subtitle_line_split`（infra `add-subtitle-line-split-api`，SYNC_INLINE 家族，
 * 0 积分留痕，`Authorization` 裸 key，非 Bearer——cloud-link 口径）。
 *
 * 本文件**不做任何断句**（主理人 2026-09-06 拍板：不本地自造断句，复用云端那一套）：
 * 只负责把回缝后的句子送过去、把行拿回来——分批 / 超时 / 信封 / 超限对半。
 * 与客户端 `apps/web/src/subtitles/cloud-line-split.ts` 同口径（两侧各自适配自己的 fetch 与凭据面）。
 *
 * 契约要点（infra design D2/D3/D5/D8）：
 * - 入参 `lines[{text, st, ed}]`（时码由调用方自持，服务端只要求 0 ≤ st ≤ ed）+ `canvas` + `language`
 *   + 可选 `subtitle_type`（给了才按该样式模板与真实画布实算宽度预算 `wt`）；
 * - 出参 `lines[]` 顺序保持、父句内子行首尾相接、首行 st / 末行 ed 恰为父句端点；**不带父句归属**；
 * - 闸值 200 行 / 8000 字，超限业务码 6034 整单拒绝并提示分批；
 * - 分词不可达 fail-open：`degraded: true` + `degrade_message`，HTTP 层仍是 200。
 */
import type { CloudConfig } from "./config";
import type { SplitLine } from "./caption-align";

export const CLOUD_LINE_SPLIT_PATH = "/task/cli/subtitle_line_split";

/** 单次请求超时。热态 27 句实测 0.5s；冷加载只在服务重启后首调（2-10s）。 */
export const CLOUD_LINE_SPLIT_TIMEOUT_MS = 30_000;

/**
 * 首轮分批粒度 = 服务端 env 缺省（`SUBTITLE_SPLIT_MAX_LINES` / `SUBTITLE_SPLIT_MAX_TOTAL_CHARS`）。
 * ★ 这**不是**本地预算：服务端改闸值时靠 6034 对半自适应，本常量只决定第一刀切多大。
 */
export const CLOUD_LINE_SPLIT_BATCH_LINES = 200;
export const CLOUD_LINE_SPLIT_BATCH_CHARS = 8000;

/** infra `error_codes.py` SUBTITLE_INPUT_LIMIT_EXCEEDED。 */
const CODE_INPUT_LIMIT_EXCEEDED = 6034;

/**
 * CLI / 客户端预设 id（snake_case，= 云端 `video_ai_subtitle` 的 `subtitle_type` 入参口径）
 * → 本接口的 `subtitle_type`（infra `SubtitleType` 枚举**值**，PascalCase）。
 *
 * 2026-09-06 生产实测：本接口用 `SubtitleType(name)` 校验，只认
 * Default / Outline / CinemaYellow / ImmersiveBox / WideSpacing / DeepShadow / Boxed，
 * 传 `immersive_box` 被拒「subtitle_type 未知」。同一枚举在 infra 两个接口上口径不一致，
 * 待 infra 对齐前由消费方适配；未知 id 原样透传（服务端会给可读错误 ⇒ fail-open）。
 */
export const CLOUD_SUBTITLE_TYPE_BY_PRESET: Readonly<Record<string, string>> = {
	default: "Default",
	outline: "Outline",
	cinema_yellow: "CinemaYellow",
	immersive_box: "ImmersiveBox",
	wide_spacing: "WideSpacing",
	deep_shadow: "DeepShadow",
	boxed: "Boxed",
};

export function toCloudSubtitleType(presetId: string | undefined): string | undefined {
	if (!presetId) return undefined;
	return CLOUD_SUBTITLE_TYPE_BY_PRESET[presetId] ?? presetId;
}

/** 云端拆行不可用（无 key / 网络 / 超时 / 信封非 200 / 解析失败）：调用方据此 fail-open。 */
export class CloudLineSplitUnavailable extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "CloudLineSplitUnavailable";
	}
}

/**
 * 跨 bundle 稳定判「不可用」：测试打包把 lib 与 command 各打成一份 bundle，`instanceof` 会在两份
 * class 之间失效（本仓 `cloudErrorCode` 的同一个坑）——按 `name` 鸭子判，与 `instanceof` 并用。
 */
export function isCloudLineSplitUnavailable(e: unknown): e is CloudLineSplitUnavailable {
	if (e instanceof CloudLineSplitUnavailable) return true;
	return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "CloudLineSplitUnavailable";
}

class InputLimitExceeded extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InputLimitExceeded";
	}
}

export interface CloudLineSplitResult {
	lines: SplitLine[];
	degraded: boolean;
	degradeMessage: string | null;
}

export interface CloudLineSplitRequest {
	lines: SplitLine[];
	canvas: [number, number];
	language: string;
	subtitleType?: string;
}

export interface CloudLineSplitDeps {
	fetchFn?: typeof fetch;
	timeoutMs?: number;
}

interface Envelope {
	code?: number;
	msg?: string;
	data?: { lines?: unknown; degraded?: unknown; degrade_message?: unknown };
}

function isSplitLine(v: unknown): v is SplitLine {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.text === "string" &&
		typeof o.st === "number" &&
		Number.isFinite(o.st) &&
		typeof o.ed === "number" &&
		Number.isFinite(o.ed)
	);
}

/** 按行数 / 总字数把 lines 切成若干批（贪心、保序）。 */
export function batchLines(
	lines: SplitLine[],
	{ maxLines = CLOUD_LINE_SPLIT_BATCH_LINES, maxChars = CLOUD_LINE_SPLIT_BATCH_CHARS } = {},
): SplitLine[][] {
	const batches: SplitLine[][] = [];
	let cur: SplitLine[] = [];
	let chars = 0;
	for (const line of lines) {
		const n = line.text.length;
		if (cur.length > 0 && (cur.length >= maxLines || chars + n > maxChars)) {
			batches.push(cur);
			cur = [];
			chars = 0;
		}
		cur.push(line);
		chars += n;
	}
	if (cur.length > 0) batches.push(cur);
	return batches;
}

/**
 * 云端拆行。任何不可用形态一律抛 `CloudLineSplitUnavailable`（带可读 reason），由调用方 fail-open。
 * 6034 超限 ⇒ 对半重提，单行仍被拒才视为不可用。
 */
export async function splitLinesViaCloud(
	cfg: CloudConfig,
	{ lines, canvas, language, subtitleType }: CloudLineSplitRequest,
	deps: CloudLineSplitDeps = {},
): Promise<CloudLineSplitResult> {
	const fetchFn = deps.fetchFn ?? fetch;
	const timeoutMs = deps.timeoutMs ?? CLOUD_LINE_SPLIT_TIMEOUT_MS;
	const cloudSubtitleType = toCloudSubtitleType(subtitleType);
	const out: SplitLine[] = [];
	let degraded = false;
	let degradeMessage: string | null = null;

	const postBatch = async (batch: SplitLine[]): Promise<void> => {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), timeoutMs);
		let res: Response;
		try {
			res = await fetchFn(`${cfg.base}${CLOUD_LINE_SPLIT_PATH}`, {
				method: "POST",
				headers: { Authorization: cfg.apiKey, "Content-Type": "application/json" },
				body: JSON.stringify({
					lines: batch,
					canvas,
					language,
					...(cloudSubtitleType ? { subtitle_type: cloudSubtitleType } : {}),
					// 标点清洗在本地按 08-21 规则做（buildCaptionElement → stripSubtitlePunctuation，与客户端同一份），
					// 服务端只管拆行：一处规则、两侧同源，也让 --keep-punctuation 真能保住原文标点。
					strip_punctuation: false,
				}),
				signal: ctl.signal,
			});
		} catch (e) {
			throw new CloudLineSplitUnavailable(e instanceof Error ? e.message : String(e));
		} finally {
			// 成功与抛错两条路都要清：定时器到点后再 abort 一个已 settle 的请求是无意义的噪音
			clearTimeout(timer);
		}
		let r: Envelope;
		try {
			r = (await res.json()) as Envelope;
		} catch {
			throw new CloudLineSplitUnavailable(`服务响应解析失败 (HTTP ${res.status})`);
		}
		if (r?.code === CODE_INPUT_LIMIT_EXCEEDED) {
			throw new InputLimitExceeded(r.msg ?? `code ${CODE_INPUT_LIMIT_EXCEEDED}`);
		}
		if (r?.code !== 200) {
			throw new CloudLineSplitUnavailable(r?.msg || `HTTP ${res.status} (code ${r?.code ?? "?"})`);
		}
		const data = r.data;
		if (!data || !Array.isArray(data.lines) || !data.lines.every(isSplitLine)) {
			throw new CloudLineSplitUnavailable("服务响应缺 lines 或形状非法");
		}
		out.push(...(data.lines as SplitLine[]));
		if (data.degraded === true) {
			degraded = true;
			if (degradeMessage === null && typeof data.degrade_message === "string" && data.degrade_message) {
				degradeMessage = data.degrade_message;
			}
		}
	};

	const submit = async (batch: SplitLine[]): Promise<void> => {
		try {
			await postBatch(batch);
		} catch (e) {
			if (!(e instanceof InputLimitExceeded)) throw e;
			if (batch.length <= 1) throw new CloudLineSplitUnavailable(e.message);
			const mid = Math.ceil(batch.length / 2);
			await submit(batch.slice(0, mid));
			await submit(batch.slice(mid));
		}
	};

	for (const batch of batchLines(lines)) await submit(batch);
	return { lines: out, degraded, degradeMessage };
}
