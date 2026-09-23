/**
 * 跨时钟适配器叶子（openspec: add-cross-clock-adapter，capability `clock-adapter`；法源 `time-domain-discipline` T5
 * 「跨时钟拼接必须过具名适配器，且有上界」，批 1 `add-lay-writer-self-check` 的 `assertSourceBound` 是 T5 后半句的实现）。
 *
 * **零 IO、零契约知识**：与 `frame-domain.ts` 并列的叶子——只知道「一个时长值来自哪口钟、由谁给出、误差多大」，
 * 不知道 clip / material / gtrk 长什么样。不变量断言仍在 `gtrk-invariants.ts`（那里才有契约形状与错误文案）。
 *
 * 三段式（每个构造点 / 比对点都按此声明）：
 *   · **误差来源**：同一段画面在不同钟上读出的时长不同——preview 代理是重编码物（容器时长 / 帧率可与原片不同），
 *     外部 manifest 是工作台自述（可能是生成参数而非产物实测），云端自述是原片值而非落盘文件的值；
 *   · **钳位对象**：`materials[].duration`（写方写出的上界真相源）与 `clip_ed` 的上界（`assertSourceBound` /
 *     `projectSlotsToFrameGrid` 的 `boundMsOf`）——判据一个字不改，改的是供值；
 *   · **越界处置**：比对差 > 容差 ⇒ 只告警、只进 `--json`，MUST NOT 阻断、MUST NOT 改决策层任何输入
 *     （`cand.fps` / `segments`）；探测失败 ⇒ 回退自述 + `unverified`。
 *
 * 只声明与比对，**不替代既有钳位**（design D1）：`assertSourceBound` / `refineWindow` 段界 / `projectSpan` 夹逼 /
 * `projectSlotsToFrameGrid` 上界全部保持；本模块提供 `SourceWall`（值 + 钟 + 来源 + 容差 + 声明）与 `compareWalls`。
 *
 * 依赖面：只 import `frame-domain`。被 `matrix-lay` / `commands/matrix` / `commands/ai-drama` import。
 */
import { r3, sec2ms } from "./frame-domain";

/**
 * 时钟（T5 点名的 join 点两侧）：
 *   - `source_container`  原片容器 PTS（ffprobe 实测原片；本地素材路恒等于它）
 *   - `preview_proxy`     云端 preview 代理文件（重编码物，落盘后 ffprobe 实测）
 *   - `asr_extract`       上传前抽出的 16k 音频 / 720p 代理（ASR 时码所在钟）
 *   - `index_proxy`       本地索引代理解码（实际恒等于 `source_container`：三档只 scale、无时基滤镜，由单测锁）
 *   - `external_manifest` 外部工作台 manifest 自述（return-v1 `measuredSec`）
 *   - `cloud_declared`    云端响应体自述（plan 候选的 `duration` / `fps`，是原片值不是代理值）
 *   - `timeline`          工程轨道时基（`track_st / track_ed`）
 */
export type Clock =
	| "source_container"
	| "preview_proxy"
	| "asr_extract"
	| "index_proxy"
	| "external_manifest"
	| "cloud_declared"
	| "timeline";

/** 素材时长之墙：任何用作 `clip_ed` 上界或 `materials[].duration` 的时长都该长这样，而不是一个裸 number。 */
export interface SourceWall {
	/** 整毫秒时长（`sec2ms` 半上入）——比对与上界判定的运算域。 */
	durationMs: number;
	/**
	 * 秒字面——写 `materials[].duration` 用。实测路 = 毫秒格上的 `r3`；自述路 = **来源字面原样**
	 * （回退自述时产物 MUST 与改前逐字节相同，不能因为过了一遍毫秒格就把 `12.3456` 写成 `12.346`）。
	 */
	durationSec: number;
	clock: Clock;
	/** 来源（人读）：`ffprobe` / `plan` / `manifest` …，进告警文案。 */
	origin: string;
	/**
	 * **上界容差**（毫秒）：`clip_ed ≤ durationMs + toleranceMs` 才算不越界。恒 1（T4：全套自检里唯一的容差）。
	 * ⚠️ 与「比对容差」是两件事：自述 vs 实测差多少算不一致由 `compareWalls` 按 `rate` 定（1 帧 / 1ms）。
	 */
	toleranceMs: number;
	/** 实测（ffprobe）= true；自述（云端 / manifest）= false。回退自述时写方据此计 `unverified`。 */
	verified: boolean;
	/** 误差声明（人读一句）。 */
	note: string;
}

/** 上界容差（T4 唯一容差）。MUST NOT 因来源不同放宽。 */
export const WALL_TOLERANCE_MS = 1;

const finitePositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * 构造点 ①：本地 ffprobe 实测 → 墙。`geo.duration` 非有限正数（探到 0 / NaN：空容器、坏文件）⇒ `null`，
 * 调用方按「探测失败」处置（回退自述），MUST NOT 把 0 当墙写进 `materials[]`。
 */
export function wallFromProbe(geo: { duration: number }, clock: Clock, origin = "ffprobe"): SourceWall | null {
	if (!finitePositive(geo.duration)) return null;
	const durationMs = sec2ms(geo.duration);
	return {
		durationMs,
		durationSec: r3(geo.duration),
		clock,
		origin,
		toleranceMs: WALL_TOLERANCE_MS,
		verified: true,
		note: `${clock} 钟 · ${origin} 实测容器时长`,
	};
}

/**
 * 构造点 ②：云端 / 外部 manifest 自述 → 墙。秒字面原样保留（见 `SourceWall.durationSec`）。
 * 非有限正数 ⇒ `null`（无墙可立；写方按「素材无 duration」既有口径跳过上界）。
 */
export function wallFromDeclared(sec: unknown, clock: Clock, origin: string): SourceWall | null {
	if (!finitePositive(sec)) return null;
	return {
		durationMs: sec2ms(sec),
		durationSec: sec,
		clock,
		origin,
		toleranceMs: WALL_TOLERANCE_MS,
		verified: false,
		note: `${clock} 钟 · ${origin} 自述时长（未经本地实测）`,
	};
}

export type ClampPolicy = "clamp" | "report";

export interface ClampOutcome {
	/** `clamp` 策略下 = 钳后值（≤ `durationMs`）；`report` 策略下 = 原值。 */
	valueMs: number;
	/** 超出 `durationMs + toleranceMs` 的毫秒数（≤ 0 = 不越界）。 */
	overrunMs: number;
	/** 是否真的动了值（只有 `clamp` 且越界时为 true）。 */
	clamped: boolean;
}

/**
 * 对墙钳位。`clamp` = 越界即钳到墙本身（`durationMs`，不是 `+toleranceMs`——容差是判据不是写出值）；
 * `report` = 值不动、只报越界量。两种策略都零抛：越界即错的语义归 `gtrk-invariants.ts`（`assertSourceBound`），
 * 本函数 MUST NOT 复刻那条判据的文案与抛错。
 */
export function clampToWall(valueMs: number, wall: SourceWall, policy: ClampPolicy): ClampOutcome {
	const overrunMs = valueMs - (wall.durationMs + wall.toleranceMs);
	if (overrunMs <= 0 || policy === "report") return { valueMs, overrunMs, clamped: false };
	return { valueMs: wall.durationMs, overrunMs, clamped: true };
}

export interface WallComparison {
	declaredMs: number;
	measuredMs: number;
	/** 实测 − 自述（有符号毫秒）。 */
	deltaMs: number;
	/** |差| 折成帧数（`r3`）；`rate` 非法时 `null`（无帧可谈）。 */
	frames: number | null;
	/** 本次比对用的容差：`rate` 合法 = 1 帧（`1000 / rate`）；非法 = 1ms。 */
	toleranceMs: number;
	/** |差| > 容差。 */
	exceeds: boolean;
}

/**
 * 自述 vs 实测比对（spec「自述与实测 SHALL 比对，差异按 1 帧 / 1ms 可见」）。
 * 视频文件给 `rate` ⇒ 容差 1 帧；外部 manifest / `rate` 非法（非有限正数）⇒ 退 1ms。
 * 纯比对：MUST NOT 改任何一侧的墙、MUST NOT 抛。
 */
export function compareWalls(declared: SourceWall, measured: SourceWall, rate?: number): WallComparison {
	const deltaMs = measured.durationMs - declared.durationMs;
	const abs = Math.abs(deltaMs);
	const rateOk = finitePositive(rate);
	const toleranceMs = rateOk ? 1000 / rate : WALL_TOLERANCE_MS;
	return {
		declaredMs: declared.durationMs,
		measuredMs: measured.durationMs,
		deltaMs,
		frames: rateOk ? r3((abs * rate) / 1000) : null,
		toleranceMs,
		exceeds: abs > toleranceMs,
	};
}
