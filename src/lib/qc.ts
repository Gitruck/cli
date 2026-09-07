/**
 * 成片质量扫描（add-qc-scan · qc-command spec）。
 *
 * 链路：视频一趟解码（`select='gte(scene,0)',metadata=print` + `blackdetect` + `freezedetect`
 * 滤镜并联，逐帧解码一次共用）+ 音频一趟（`silencedetect` + `astats` + `ebur128`）
 * → 解析各滤镜 stderr → 判定项聚合 → 报告（人读交命令层格式化，机读 qc-report v1）。
 * MUST NOT 逐检测项重复解码。
 *
 * 工程感知（`--gtrk`）：视觉跳变与工程主视频轨 clip 拼接边界有序对表，落边界者=正常剪切不报，
 * 不落者=段内跳切（warn）。对表按**有序单调匹配**而非就近匹配——本地渲染的成片切点相对 EDL
 * 存在随时间累积的漂移（旅拍打样实测 0.028s→0.256s，`trim`+`fps` 在 VFR 源上逐段取整出帧、
 * concat 累加所致；该漂移本身由 `av_drift` 项独立报告），就近匹配会把漂移后的正常剪切误判成段内跳切。
 */
import { spawn } from "node:child_process";
import { requireFfmpeg, ffprobeJson } from "./ffmpeg";
import { parseSceneScores } from "./local-index";
// 黑段解析**唯一实现**（见下方 parseBlackDetect 的头注）：index-decode 是零 I/O 纯函数层，
// 单向 import 不成环；本文件内部（scanFinalCut）也用这一个绑定，MUST NOT 再写第二份正则。
import { parseBlackSpans } from "./index-decode";
import { r3, sec2frame } from "./frame-domain";

// ── 阈值基线（v1 标定值；标定批次调参只改这一处）─────────────────────────
export const QC_THRESHOLDS = {
	/** 视觉跳变判定阈值（成片恒 CFR，无帧率归一问题；与索引场景检测同源取值）。 */
	sceneScore: 0.3,
	/** 过短镜头判定：相邻两跳变间隔 ≤ 此值即判过短（tune-shot-rhythm-thresholds，主理人 2026-08-19
	 * 走查裁定 1.0s）。判据是**节奏断裂**而非「闪」——长镜头之间突然插入半拍短镜头最难受。
	 * 与铺轨的 SLIVER_MIN_SEC 同为 1.0s：防与查同一条感知线。
	 * 严重级 MUST 按端点来源分级（见 scanFinalCut）——一刀切会把素材自身的快剪蒙太奇误报成缺陷。 */
	flashMaxSec: 1.0,
	/** 段内跳切对表容差（秒）：跳变与漂移修正后的 clip 边界之差在此内算正常剪切。 */
	cutMatchTolSec: 0.12,
	/** blackdetect：最短黑段/像素黑判据/单像素黑阈值。 */
	blackMinDurSec: 0.1,
	blackPicTh: 0.98,
	blackPixTh: 0.1,
	/** freezedetect：噪声容限与最短冻结时长。 */
	freezeNoise: 0.003,
	freezeMinDurSec: 2,
	/** silencedetect：静音判据（dB）与最短静音时长。 */
	silenceNoiseDb: -50,
	silenceMinDurSec: 2,
	/** 整片无声阈值（LUFS，ebur128 integrated loudness）——低于此值即判**整片没有声音**（error）。
	 * 判据取整片响度而非静音覆盖比例：比例要先逐段检测再聚合、且整条链受 silenceNoiseDb 门限影响，
	 * 而 integrated loudness 是单一测量值，直接表达「这条片子没声音」。
	 * 实测标尺（2026-09-04 真机事故）：完全无音源残片 −70.0 / 只有轻 BGM 约 −34 / 正常人声+BGM −14.0。
	 * −50 落在「完全没声」与「声音很轻」之间，两侧各留 16~20 dB 余量（取 −60 太脆会漏判带底噪的无声片，
	 * 取 −40 逼近轻 BGM 下沿有误伤风险）。 */
	fullFilmSilenceLufs: -50,
	/** true peak **告警线**（dBTP，ebur128）——超过即提示「已越 EBU R128 交付上限」。
	 * ⚠️ 这条**不是缺陷线**（fix-qc-truepeak-parse §0.1 拍板）：−1 dBTP 是 R128 的**广播交付**天花板，
	 * 其前提是内容已按 −23/−14 LUFS 做过响度归一；而 gtrk 成片实测 I 值在 −10…−16 LUFS、根本没归一，
	 * 只搬天花板不搬地板属口径混用。实测 11 条真语料 **8 条（73%）越过 −1**（上限 +0.6）——
	 * 在本产品语料上它是**常态线**。判 error 会让缺省 `--fail-on error` 恒红、真问题淹进噪音
	 * （本仓已栽过同形跟头：零 delta 恒红积到 23 条）。故降级为 warn，缺陷线另立 truePeakErrorDbtp。 */
	truePeakDbtp: -1,
	/** true peak **严重线**（dBTP）——超过即判真爆音（error）。
	 * 实测标尺（2026-09-04）：真语料上限 **+0.6** / 真·硬削波重编码后 **+1.6** / 合成过载 **+6.9**。
	 * 取 +1.0 使分界线两侧各留 0.4 与 0.6 dB。 */
	truePeakErrorDbtp: 1.0,
	/** 样本域削波比例上限（`Abs Peak count / Number of samples`，**s16 支路下测**）——超过即判 error。
	 * 存在理由：true peak 单腿有**实证盲区**——硬削波在 0 dBFS 处被削平时 TP 仅 +0.1 dBTP，
	 * 与正常成片（−1.5…+0.6）同区间，TP 看不见它。两条腿分工，不冗余。
	 * 实测标尺（2026-09-04）：真·硬削波 s16 原件 77500/220500 = **0.35**；
	 * 正常成片（案例7 重渲）1/13254656 = **7.5e-8**。1e-5 两侧各留约四个数量级。
	 * ⚠️ `Flat factor` **实证否决、MUST NOT 当判据**：真语料 TP+0.6 那条 flat=14.47、
	 * 真·硬削波 13.70，几乎同值——它测的是「s16 钳位发生过」不是「源头被削过」，只可作 evidence 佐证。 */
	clipSampleRatio: 1e-5,
	/** 视频/音频流时长差上限（秒）——超过即判音画不同步（渲染帧数漂移的机读证据）。 */
	avDurationDiffSec: 0.1,
} as const;

export type QcSeverity = "error" | "warn" | "info";
export type QcType =
	| "flash"
	| "intra_cut"
	| "black"
	| "freeze"
	| "clip"
	| "silence"
	| "av_drift"
	| "vfr"
	/** 某检测项本次**未能生效**（测量值解析不到）——不是「该项通过」。
	 * 独立成型而非复用 `clip`：把解析失败报成 `clip` 会被读成「测出了削波」，正好是本件要根治的歧义。 */
	| "measure_unavailable";

export interface QcItem {
	type: QcType;
	severity: QcSeverity;
	/** 缺陷区间（秒，成片时基）。点状缺陷 st===ed。 */
	st: number;
	ed: number;
	/** 各检测项自由证据键值（外层契约锁定，证据留演进余地）。 */
	evidence: Record<string, unknown>;
}

export interface QcReport {
	qc_version: "v1";
	input: string;
	generated_at: string;
	summary: { error: number; warn: number; info: number };
	items: QcItem[];
}

/** 跑 ffmpeg 抓全量 stderr（分析滤镜输出体量 O(帧数)，runFfmpeg 只留尾 4000 字会截断）。 */
function captureStderr(bin: string, args: string[]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const p = spawn(bin, args, { env: process.env });
		let err = "";
		p.stderr.on("data", (b: Buffer) => {
			err += b.toString("utf8");
		});
		p.on("error", (e) => reject(e));
		p.on("close", () => resolvePromise(err));
	});
}

// ── 解析器（各滤镜 stderr → 结构化事实）──────────────────────────────────

/**
 * blackdetect：`black_start:12.5 black_end:13.1 black_duration:0.6`。
 *
 * ⚠️ **本名现在只是 `index-decode.parseBlackSpans` 的别名，不再是第二份实现**
 * （fix-index-gradual-transition-blindness 的 handoff①，2026-09-02 合流）。
 * 合流前是「两份实现 + 一条等价闸」：同一个 ffmpeg 输出格式被 QC 侧与索引侧各解析一次，
 * 写歪一处就是「索引说没黑、QC 说有黑」的**静默分叉**，而两份头注互相自陈「逐字一致」
 * 这种约定已经被同一个 change 证伪过一次（`isScenePassNoiseLine` 那两处 filter）。
 *
 * 方向是安全的：`index-decode.ts` 是**零 I/O 纯函数层**、不 import 仓内任何模块，
 * 故 `qc.ts → index-decode.ts` 单向依赖不成环；反向（让 index-decode 去 import qc）
 * 才会成环，还会把 spawn/ffmpeg 依赖拖进无卡 CI —— 那正是当初被迫写两份的原因。
 * 本名保留是为了不动 `qc-command` 的既有导出面（下游可能在 import 它）。
 */
export { parseBlackSpans as parseBlackDetect };

/** freezedetect：`lavfi.freezedetect.freeze_start: 4.2` / `...freeze_duration` / `...freeze_end`。 */
export function parseFreezeDetect(stderr: string): { st: number; ed: number }[] {
	const out: { st: number; ed: number }[] = [];
	let st: number | undefined;
	for (const line of stderr.split(/\r?\n/)) {
		const s = line.match(/freeze_start:\s*([0-9.]+)/);
		if (s) {
			st = Number(s[1]);
			continue;
		}
		const e = line.match(/freeze_end:\s*([0-9.]+)/);
		if (e && st !== undefined) {
			out.push({ st, ed: Number(e[1]) });
			st = undefined;
		}
	}
	return out;
}

/** silencedetect：`silence_start: 10.2` … `silence_end: 13.4 | silence_duration: 3.2`。 */
export function parseSilenceDetect(stderr: string): { st: number; ed: number }[] {
	const out: { st: number; ed: number }[] = [];
	let st: number | undefined;
	for (const line of stderr.split(/\r?\n/)) {
		const s = line.match(/silence_start:\s*(-?[0-9.]+)/);
		if (s) {
			st = Math.max(0, Number(s[1]));
			continue;
		}
		const e = line.match(/silence_end:\s*([0-9.]+)/);
		if (e && st !== undefined) {
			out.push({ st, ed: Number(e[1]) });
			st = undefined;
		}
	}
	return out;
}

/**
 * astats/ebur128：全片削波样本数、true peak（dBTP）与 **integrated loudness（I 值，LUFS）**。
 *
 * I 值取 stderr 里**最后一处** `I: <n> LUFS`——ebur128 逐帧行与 Summary 段用同一种写法，
 * Summary 必然在最后，故末次即全片整合值（fix-qc-fullfilm-silence-severity）。
 * ⚠️ 完全数字静音时 ffmpeg 可能打 `I: -inf LUFS`（也可能打到 EBU 绝对门限 −70.0）：
 * `-inf` SHALL 解析成 `Number.NEGATIVE_INFINITY`（= 远低于任何阈值），
 * MUST NOT 因「不是有限数字」退回 null —— 那会让最严重的形态（整片一点声都没有）反而漏判。
 * 本函数**不新增解码趟次**：消费的就是 scanFinalCut 音频那一趟已在跑的 ebur128 滤镜输出。
 */
export function parseAudioStats(stderr: string): {
	/** 样本域削波比例 `Abs Peak count / Number of samples`（s16 支路）；测不到为 null。 */
	clipSampleRatio: number | null;
	absPeakCount: number | null;
	sampleCount: number | null;
	/** 仅作 evidence 佐证，MUST NOT 参与判定（见 QC_THRESHOLDS.clipSampleRatio 的实证否决）。 */
	flatFactor: number | null;
	truePeakDbtp: number | null;
	integratedLufs: number | null;
} {
	// ── true peak：**跨行**取值（fix-qc-truepeak-parse）───────────────────────
	// ebur128 Summary 由三个标题行各领若干缩进子行构成，数值在标题行**之后**：
	//     True peak:
	//       Peak:      -11.7 dBFS
	// 旧写法 /True peak:\s*(-?[0-9.]+|-inf)/ 按同行匹配 ⇒ 紧跟的实际字符是 `P`(Peak:) ⇒ **永不命中**
	// ⇒ truePeakDbtp 恒 null ⇒ 消费方的 `!== null` 防呆把整个削波检测静默吞掉，潜伏了一整个生命周期。
	// ⚠️ 锚点 MUST 保持在 `True peak:` 标题行上、只在其后续子行里找 `Peak:`：同一份 stderr 里近邻键名
	// 密集（astats 的 `Peak level dB:` / `Peak count:` / `Abs Peak count:`、逐帧行的 `TPK:` / `FTPK:`），
	// 放宽成裸 `Peak:` 会吃错值。
	let truePeak: number | null = null;
	const takePeak = (raw: string): void => {
		const v = /^-?inf$/i.test(raw) ? (raw.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY) : Number(raw);
		if (Number.isNaN(v)) return;
		if (truePeak === null || v > truePeak) truePeak = v;
	};
	// 主判据：跨行（实测格式）。数值三形态：负数 / **无符号正数**（超 0 dBFS 时无正号）/ `-inf`。
	for (const m of stderr.matchAll(/True peak:[^\n]*\r?\n\s*Peak:\s*(-?inf|-?[0-9.]+)\s*dBFS/gi)) takePeak(m[1] as string);
	// 兜底：同行写法。异版 ffmpeg 若把数值写回同一行不至于哑；有下面「解析失败可见」那条闸兜着，
	// 容错在这里是纯收益（认得出照常判、认不出照样喊），不会掩盖格式漂移。
	for (const m of stderr.matchAll(/True peak:[ \t]*(-?inf|-?[0-9.]+)\s*dBFS/gi)) takePeak(m[1] as string);

	// ── 样本域削波：取 astats **Overall** 段（该段在最后，故取末次命中）────────
	// ⚠️ 旧写法匹配 `Number of clipped samples:` —— **astats 根本没有这个指标**
	// （`-h filter=astats` 的 measure_overall/measure_perchannel 枚举表里无任何 clipped 项），该行永不出现。
	const last = (re: RegExp): number | null => {
		let v: number | null = null;
		for (const m of stderr.matchAll(re)) v = Number(m[1]);
		return v !== null && Number.isFinite(v) ? v : null;
	};
	const absPeakCount = last(/Abs Peak count:\s*([0-9.]+)/g);
	const sampleCount = last(/Number of samples:\s*([0-9.]+)/g);
	const flatFactor = last(/Flat factor:\s*([0-9.]+)/g);
	// 分母取**每声道**样本数、分子在多声道时可能是跨声道聚合 ⇒ 比值最多虚高约声道数倍。
	// 判据两侧有约四个数量级余量，这点系统偏差不影响分级（实测：硬削 0.35 vs 正常 7.5e-8）。
	const clipSampleRatio = absPeakCount !== null && sampleCount !== null && sampleCount > 0 ? absPeakCount / sampleCount : null;

	let integrated: number | null = null;
	for (const m of stderr.matchAll(/\bI:\s*(-?[0-9.]+|-inf)\s*LUFS/g)) {
		integrated = m[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]);
	}
	if (integrated !== null && Number.isNaN(integrated)) integrated = null;
	return { clipSampleRatio, absPeakCount, sampleCount, flatFactor, truePeakDbtp: truePeak, integratedLufs: integrated };
}

// ── 判定（纯函数，供单测直调）────────────────────────────────────────────

/**
 * **整片无声**判定（fix-qc-fullfilm-silence-severity · qc-command「整片无声」条款）。
 *
 * 2026-09-04 真机事故：一条整片数字静音（−70.0 LUFS）的成片，QC 报「严重 0 · 提示 1」，
 * agent 据此报告「渲染完成、质检严重 0」，差点被当成品收下。根因是逐段 silence 一律 `warn`，
 * 不区分「片中一小段留白」与「整片都没声音」——前者常见且多半无害，后者是交付级缺陷。
 *
 * 判据是**整片 integrated loudness**，而非静音段覆盖比例：比例要先逐段检测再聚合、
 * 且整条链受 `silenceNoiseDb` 门限影响；I 值是单一测量值，直接表达「这片子没声音」。
 * 覆盖比例只作 evidence 佐证（让人一眼分清「一段留白」与「整片没声」），MUST NOT 反过来当判据。
 *
 * ⚠️ `-inf`（完全数字静音）经 parseAudioStats 解析成 `NEGATIVE_INFINITY`，在此照常小于阈值 ⇒ 判 error，
 * MUST NOT 因「不是有限数字」跳过判定。evidence 里落成字符串 `"-inf"`（JSON 无 Infinity 字面量）。
 *
 * 逐段 silence 条目的 `warn` 不受本判定影响（两者并存，见 scanFinalCut）。
 */
export function fullFilmSilenceItem(
	integratedLufs: number | null,
	silences: { st: number; ed: number }[],
	durationSec: number,
	thresholdLufs: number = QC_THRESHOLDS.fullFilmSilenceLufs,
): QcItem | null {
	if (integratedLufs === null || !(integratedLufs < thresholdLufs)) return null;
	const silentSec = silences.reduce((n, s) => n + Math.max(0, s.ed - s.st), 0);
	const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
	return {
		type: "silence",
		severity: "error",
		st: 0,
		ed: r3(dur),
		evidence: {
			full_film_silence: true,
			integrated_lufs: Number.isFinite(integratedLufs) ? r3(integratedLufs) : "-inf",
			threshold_lufs: thresholdLufs,
			// 佐证（非判据）：静音总时长与覆盖比例
			silent_sec: r3(silentSec),
			silent_ratio: dur > 0 ? r3(Math.min(1, silentSec / dur)) : null,
			note: "整片无声：全片响度（integrated loudness）低于阈值，成片没有声音——不是片中留白，是交付级缺陷；静音时长/覆盖比例仅作佐证",
		},
	};
}

/**
 * **爆音/削波**判定（fix-qc-truepeak-parse · qc-command「解析实证对齐」条款）。
 *
 * 两条腿、两条线（§0.1/§0.2 拍板）：
 *  - **样本域**：`Abs Peak count / Number of samples`（s16 支路）> `clipSampleRatio` ⇒ **error**。
 *    专治 true peak 的盲区——硬削波在 0 dBFS 被削平时 TP 只有 +0.1，与正常成片同区间。
 *  - **true peak**：> `truePeakErrorDbtp`（+1.0）⇒ **error**；> `truePeakDbtp`（−1）⇒ **warn**。
 *    warn 那条报的是「已越 R128 交付上限、平台二压可能削」，是可行动信号但不是缺陷。
 *
 * 本函数**只在两条腿都拿到读数时才下结论**；解析不到由 {@link audioParseFailureItem} 单独喊，
 * MUST NOT 在这里用 `!== null` 悄悄跳过——那正是本件要根治的病。
 */
export function clipItem(
	truePeakDbtp: number | null,
	clipSampleRatio: number | null,
	durationSec: number,
	flatFactor: number | null = null,
	th: { warnDbtp?: number; errorDbtp?: number; ratio?: number } = {},
): QcItem | null {
	const warnLine = th.warnDbtp ?? QC_THRESHOLDS.truePeakDbtp;
	const errLine = th.errorDbtp ?? QC_THRESHOLDS.truePeakErrorDbtp;
	const ratioLine = th.ratio ?? QC_THRESHOLDS.clipSampleRatio;
	const overRatio = clipSampleRatio !== null && clipSampleRatio > ratioLine;
	const overErr = truePeakDbtp !== null && truePeakDbtp > errLine;
	const overWarn = truePeakDbtp !== null && truePeakDbtp > warnLine;
	if (!overRatio && !overErr && !overWarn) return null;
	const severity: QcSeverity = overRatio || overErr ? "error" : "warn";
	return {
		type: "clip",
		severity,
		st: 0,
		ed: r3(durationSec),
		evidence: {
			// −inf/+inf 无 JSON 字面量，落字符串（同姊妹件 integrated_lufs 的处置）
			true_peak_dbtp: truePeakDbtp === null ? null : Number.isFinite(truePeakDbtp) ? r3(truePeakDbtp) : truePeakDbtp > 0 ? "inf" : "-inf",
			true_peak_warn_dbtp: warnLine,
			true_peak_error_dbtp: errLine,
			clip_sample_ratio: clipSampleRatio === null ? null : Number(clipSampleRatio.toPrecision(3)),
			clip_sample_ratio_threshold: ratioLine,
			// 佐证（非判据）：flat factor 对「源头被削」无判别力，只说明 s16 钳位发生过
			flat_factor: flatFactor === null ? null : r3(flatFactor),
			note:
				severity === "error"
					? "音频爆音：样本域削波比例越限或 true peak 越过严重线，成片过响已失真"
					: "true peak 已越 EBU R128 交付上限（−1 dBTP）——不是缺陷，但平台二压时可能被削，需要更大余量就压低母带",
		},
	};
}

/**
 * **测量项未生效**自陈（qc-command「解析失败 SHALL 可见」条款）。
 *
 * ★ 这条是本件的**根本闸**，比病灶本身更要紧：true peak 恒 `null` 之所以能潜伏一整个产品生命周期，
 * 正是因为消费方 `truePeakDbtp !== null` 的防呆让「解析失败」与「测出来没超限」在下游完全同形
 * ——不会红、只会静默放行。凡以 `x !== null` 保护的测量判定，`null` 分支 SHALL 是**可见分支**。
 *
 * 取 `warn` 而非 `info`（§0.4）：`gtrk render` 收口那条路（`runPostRenderQc`）**只打印 error 条目**，
 * `info` 等于没说；但工具链问题也不该阻断出片、不该让缺省 `--fail-on error` 变红。
 * 无音频流时不适用（那由既有音画规整条款处理），MUST NOT 误报。
 */
export function audioParseFailureItem(
	hasAudioStream: boolean,
	missing: { truePeak: boolean; clipSampleRatio: boolean },
	durationSec: number,
	ffmpegPath?: string,
): QcItem | null {
	if (!hasAudioStream) return null;
	const lost: string[] = [];
	if (missing.truePeak) lost.push("true_peak_dbtp");
	if (missing.clipSampleRatio) lost.push("clip_sample_ratio");
	if (lost.length === 0) return null;
	return {
		type: "measure_unavailable",
		severity: "warn",
		st: 0,
		ed: r3(durationSec),
		evidence: {
			measure: "clip",
			missing: lost,
			ffmpeg: ffmpegPath ?? null,
			note: "削波判定本次未生效：上列测量值未能从 ffmpeg 输出解析到（可能是 ffmpeg 换了输出格式）——这不等于「爆音检测已通过」，请勿据此判定成片无爆音",
		},
	};
}

/** 过短镜头：相邻跳变间隔 ≤ flashMaxSec 者（区间 = 两跳变之间）。纯阈值，**不判严重级**——
 * 定级要看端点来源（拼接切 vs 段内跳切），那是 scanFinalCut 在工程对表之后做的事。 */
export function detectFlashes(
	cuts: number[],
	maxSec: number = QC_THRESHOLDS.flashMaxSec,
): { st: number; ed: number; sec: number }[] {
	const out: { st: number; ed: number; sec: number }[] = [];
	for (let i = 1; i < cuts.length; i++) {
		const sec = cuts[i]! - cuts[i - 1]!;
		if (sec > 0 && sec <= maxSec) out.push({ st: r3(cuts[i - 1]!), ed: r3(cuts[i]!), sec: r3(sec) });
	}
	return out;
}

/**
 * 过短镜头 → 报告条目，**按两端来源定级**（tune-shot-rhythm-thresholds · spec「闪现判定按端点来源分级」）：
 *
 *   · 至少一端是 clip 拼接切 → `error`：我方剪辑造成的节奏断裂。铺轨的槽长地板（MIN_SHOT_SEC=1.2s）
 *     保证我方从不排出更短的槽，故这类短镜头必然是「颗粒窗口跨过源切点、且切点贴近拼接处」的产物，
 *     属可修缺陷（铺轨的 SLIVER_MIN_SEC 负责预防）。
 *   · 两端皆段内跳切 → `info`：整段落在同一颗粒内部，是**源素材自身的快剪语言**（打样实锤：源
 *     550.567–553.017s 的真蒙太奇，7 刀 0.267–0.467s，成片曾整段采用）。一刀切会把它误报成 6 条
 *     error，与「除非素材颗粒内部本来就高频」的例外条款直接冲突。
 *   · `spliceCuts === null`（未开工程感知）→ 来源不可判，退回不分级的 `warn` 并标注口径受限。
 *
 * 端点归属判在**帧域**（fix-matrix-lay-frame-grid 2.9）：工程有合法 `video_rate` 时，切点与拼接集合都经
 * `sec2frame` 帧化后比对——写出侧 `f2ms` 改向下投影后，30fps 下 `n ≡ 2 (mod 3)` 的帧位写出 `0.066`
 * 而成片切点 `r3(2/30) = 0.067`，毫秒等值比对恒 miss、分级会静默退成 `info`；同一帧号则两侧恒等。
 * 工程无合法帧率（老工程）时退回毫秒等值口径（`kind: "ms"`），MUST NOT 编造帧率。
 *
 * 纯函数，供单测直调 spec 的三条 Scenario。
 */
export type SpliceIndex =
	| { kind: "frames"; rate: number; frames: Set<number> }
	| { kind: "ms"; ms: Set<number> };

export function shortShotItems(cuts: number[], spliceCuts: SpliceIndex | null): QcItem[] {
	const isSplice = (t: number): boolean =>
		spliceCuts !== null &&
		(spliceCuts.kind === "frames" ? spliceCuts.frames.has(sec2frame(t, spliceCuts.rate)) : spliceCuts.ms.has(r3(t)));
	return detectFlashes(cuts).map((f) => {
		if (spliceCuts === null) {
			return {
				type: "flash" as const,
				severity: "warn" as const,
				st: f.st,
				ed: f.ed,
				evidence: { shot_sec: f.sec, note: "镜头过短；未开工程感知（--gtrk），来源不可判、未分级" },
			};
		}
		const ours = isSplice(f.st) || isSplice(f.ed);
		return {
			type: "flash" as const,
			severity: (ours ? "error" : "info") as QcSeverity,
			st: f.st,
			ed: f.ed,
			evidence: {
				shot_sec: f.sec,
				endpoints: `${isSplice(f.st) ? "拼接切" : "段内跳切"}→${isSplice(f.ed) ? "拼接切" : "段内跳切"}`,
				note: ours
					? "镜头过短且至少一端是 clip 拼接处：颗粒窗口跨过源切点造成的节奏断裂，可重铺修复"
					: "镜头过短但两端都在同一颗粒内部：源素材自身的快剪节奏，非缺陷",
			},
		};
	});
}

/**
 * 跳变 ↔ clip 边界有序对表（单调匹配，见文件头「工程感知」注记）：每个边界认领其后**首个**
 * 落在 [−tol, maxDriftSec] 内的跳变；认领不到即记 missing（该剪切点在成片里没形成可见跳变，
 * 多为相邻两颗粒画面本就相近，不报缺陷只作诊断）。未被认领的跳变 = 段内跳切。
 */
export function matchCutsToBoundaries(
	cuts: number[],
	boundaries: number[],
	opts: { tolSec?: number; maxDriftSec?: number } = {},
): { matched: { boundary: number; cut: number; drift: number }[]; intra: number[]; missing: number[] } {
	const tol = opts.tolSec ?? QC_THRESHOLDS.cutMatchTolSec;
	const maxDrift = opts.maxDriftSec ?? 1.0;
	const matched: { boundary: number; cut: number; drift: number }[] = [];
	const missing: number[] = [];
	const claimed = new Set<number>();
	let j = 0;
	for (const b of boundaries) {
		while (j < cuts.length && cuts[j]! < b - tol) j++;
		if (j < cuts.length && cuts[j]! - b <= maxDrift) {
			matched.push({ boundary: r3(b), cut: r3(cuts[j]!), drift: r3(cuts[j]! - b) });
			claimed.add(j);
			j++;
		} else {
			missing.push(r3(b));
		}
	}
	const intra = cuts.filter((_, i) => !claimed.has(i)).map(r3);
	return { matched, intra, missing };
}

/** 工程槽位登记（add-material-motion-signal · qc-command「缺陷带工程坐标」）：从
 * `struct_meta.broll.beats[].laid[].slots[]` 反查，把成片时码映射回 (beat, 槽位, clip, 源窗)。 */
export interface SlotRef {
	beat: string;
	slotIndex: number;
	clipId: string;
	trackSt: number;
	trackEd: number;
	clipSt: number;
	clipEd: number;
}

/** 同 beat 的候选段（备选建议用）。 */
export interface CandidateRef {
	clipId: string;
	start: number;
	end: number;
	score: number;
	/** 去重后帧间分 p50（越低越稳）；索引无信号时 undefined。 */
	motionP50?: number;
	/** 段内已知切点数（越少越好）。 */
	cutCount?: number;
}

/** 从工程 struct_meta.broll 抽出全部落成槽位（按 track_st 升序）。 */
export function slotsFromGtrk(gtrk: unknown): SlotRef[] {
	const beats = (gtrk as { struct_meta?: { broll?: { beats?: unknown[] } } })?.struct_meta?.broll?.beats;
	if (!Array.isArray(beats)) return [];
	const out: SlotRef[] = [];
	for (const b of beats as { beat?: string; laid?: { slots?: Record<string, number | string>[] }[] }[]) {
		for (const l of b.laid ?? []) {
			(l.slots ?? []).forEach((s, i) => {
				const num = (v: unknown): number => (typeof v === "number" ? v : Number.NaN);
				const trackSt = num(s.track_st);
				if (!Number.isFinite(trackSt)) return;
				out.push({
					beat: String(b.beat ?? ""),
					slotIndex: i,
					clipId: String(s.clip_id ?? ""),
					trackSt,
					trackEd: num(s.track_ed),
					clipSt: num(s.clip_st),
					clipEd: num(s.clip_ed),
				});
			});
		}
	}
	return out.sort((a, b) => a.trackSt - b.trackSt);
}

/** 成片时码 → 所属槽位（扣渲染漂移：容差按帧级给，命中不唯一时返回 null）。 */
export function slotAt(slots: SlotRef[], t: number, tolSec = 0.1): SlotRef | null {
	const hit = slots.filter((s) => t >= s.trackSt - tolSec && t < s.trackEd + tolSec);
	return hit.length === 1 ? hit[0]! : null;
}

/** 成片时码 → 源素材时码（经所属槽位换算；槽位不唯一时 null）。 */
export function toSourceTime(slots: SlotRef[], t: number, tolSec = 0.1): { slot: SlotRef; src: number } | null {
	const slot = slotAt(slots, t, tolSec);
	if (!slot) return null;
	return { slot, src: r3(slot.clipSt + (t - slot.trackSt)) };
}

/** 同 beat 未被采用的候选段，按「稳」排序：运动量升序 → 段内切点数升序 → score 降序。
 * 索引无运动信号时退回单维（切点数）排序，调用方据 `ranked_by` 标注口径受限。 */
export function rankAlternatives(candidates: CandidateRef[], usedClipIds: Set<string>): CandidateRef[] {
	return candidates
		.filter((c) => !usedClipIds.has(c.clipId))
		.sort(
			(a, b) =>
				(a.motionP50 ?? Number.POSITIVE_INFINITY) - (b.motionP50 ?? Number.POSITIVE_INFINITY) ||
				(a.cutCount ?? 0) - (b.cutCount ?? 0) ||
				b.score - a.score,
		);
}

/** gtrk 工程 → 主视频轨 clip 拼接边界（秒，升序；首 clip 起点不算切点）。
 * 主轨口径与渲染一致：track_index 最小的**非黑底垫轨**（struct_meta.broll.black_track 登记）。 */
export function boundariesFromGtrk(gtrk: unknown): number[] {
	const g = gtrk as {
		video_track?: { track_index?: number; track_timeline?: { track_st?: number; duration?: number; material?: unknown }[] }[];
		struct_meta?: { broll?: { black_track?: number | null } };
	};
	const tracks = [...(g.video_track ?? [])]
		.map((t, i) => ({ key: typeof t.track_index === "number" ? t.track_index : i, t }))
		.sort((a, b) => a.key - b.key);
	if (!tracks.length) return [];
	const black = g.struct_meta?.broll?.black_track ?? null;
	const main = (typeof black === "number" ? tracks.filter((x) => x.key !== black) : tracks)[0] ?? tracks[0];
	const timeline = [...(main!.t.track_timeline ?? [])].sort((a, b) => Number(a.track_st) - Number(b.track_st));
	return timeline
		.map((c) => Number(c.track_st))
		.filter((t) => Number.isFinite(t))
		.slice(1);
}

/** 黑段是否命中工程登记的黑底空洞（命中即降级 info——预期内产物）。 */
export function isKnownBlackHole(gtrk: unknown, st: number, ed: number): boolean {
	const holes = (gtrk as { struct_meta?: { broll?: { holes?: { track_st: number; track_ed: number }[] } } })
		?.struct_meta?.broll?.holes;
	if (!Array.isArray(holes)) return false;
	return holes.some((h) => ed >= Number(h.track_st) - 0.25 && st <= Number(h.track_ed) + 0.25);
}

// ── 扫描编排 ─────────────────────────────────────────────────────────────

export interface QcScanOptions {
	ffmpegPath?: string;
	/** 工程感知模式：已解析的 gtrk 对象（命令层读文件/render 直接透传）。 */
	gtrk?: unknown;
	onProgress?: (line: string) => void;
}

/** 扫描成片，产 qc-report v1（不落盘——落盘与人读格式化归命令层）。 */
export async function scanFinalCut(input: string, opts: QcScanOptions = {}): Promise<QcReport> {
	const ff = requireFfmpeg(opts.ffmpegPath);
	const T = QC_THRESHOLDS;
	const items: QcItem[] = [];

	// ── 流级事实（ffprobe，零解码）：时长差与 CFR ──
	const probe = ffprobeJson(ff.ffprobe, [
		"-v", "error",
		"-show_entries", "stream=codec_type,duration,nb_frames,r_frame_rate,avg_frame_rate",
		"-of", "json",
		input,
	]) as { streams?: { codec_type?: string; duration?: string; nb_frames?: string; r_frame_rate?: string; avg_frame_rate?: string }[] };
	const streams = probe.streams ?? [];
	const v = streams.find((s) => s.codec_type === "video");
	const a = streams.find((s) => s.codec_type === "audio");
	const vDur = v?.duration != null ? Number(v.duration) : null;
	const aDur = a?.duration != null ? Number(a.duration) : null;
	if (vDur !== null && aDur !== null) {
		const diff = vDur - aDur;
		if (Math.abs(diff) > T.avDurationDiffSec) {
			items.push({
				type: "av_drift",
				severity: "error",
				st: r3(Math.min(vDur, aDur)),
				ed: r3(Math.max(vDur, aDur)),
				evidence: {
					video_duration: r3(vDur),
					audio_duration: r3(aDur),
					diff_sec: r3(diff),
					note: "画面与音频总长不一致：画面对口播渐进失步（成片切点相对工程时间线累积漂移）",
				},
			});
		}
	}
	const rateOf = (s?: string): number | null => {
		if (!s) return null;
		const [n, d] = s.split("/").map(Number);
		return d ? n! / d : (n ?? null);
	};
	const rFps = rateOf(v?.r_frame_rate);
	const aFps = rateOf(v?.avg_frame_rate);
	if (rFps && aFps && Math.abs(rFps - aFps) / rFps > 0.01) {
		items.push({
			type: "vfr",
			severity: "error",
			st: 0,
			ed: r3(vDur ?? 0),
			evidence: { r_frame_rate: r3(rFps), avg_frame_rate: r3(aFps), note: "成片非 CFR（渲染产物应恒为固定帧率）" },
		});
	}

	// ── 视频趟：scene score + blackdetect + freezedetect 并联（一次解码）──
	opts.onProgress?.("视频趟：逐帧跳变 + 黑帧 + 冻结检测…");
	const vFilter = [
		"select='gte(scene,0)'",
		"metadata=print",
		`blackdetect=d=${T.blackMinDurSec}:pic_th=${T.blackPicTh}:pix_th=${T.blackPixTh}`,
		`freezedetect=n=${T.freezeNoise}:d=${T.freezeMinDurSec}`,
	].join(",");
	const vErr = await captureStderr(ff.ffmpeg, ["-i", input, "-vf", vFilter, "-f", "null", "-"]);

	const frames = parseSceneScores(vErr);
	const cuts = frames.filter((f) => f.score > T.sceneScore).map((f) => f.ts);

	// 闪现判定放在**工程对表之后**（tune-shot-rhythm-thresholds D1）：严重级要按端点来源裁定，
	// 而来源只有对表才知道。无工程时退回不分级的纯阈值报告。
	let spliceCuts: SpliceIndex | null = null;

	if (opts.gtrk) {
		const bounds = boundariesFromGtrk(opts.gtrk);
		const { matched, intra } = matchCutsToBoundaries(cuts, bounds);
		const drifts = matched.map((m) => m.drift);
		// 拼接集合在构建处按顶层 video_rate 帧化（fix-matrix-lay-frame-grid 2.9）；老工程无合法帧率 ⇒ 毫秒口径
		const vr = (opts.gtrk as { video_rate?: unknown }).video_rate;
		const rate = typeof vr === "number" && Number.isFinite(vr) && vr > 0 && Number.isInteger(vr) ? vr : null;
		spliceCuts =
			rate !== null
				? { kind: "frames", rate, frames: new Set(matched.map((m) => sec2frame(m.cut, rate))) }
				: { kind: "ms", ms: new Set(matched.map((m) => m.cut)) };
		// 工程坐标（add-material-motion-signal）：把成片时码映射回 (beat, 槽位, clip, 源窗)
		const slots = slotsFromGtrk(opts.gtrk);
		for (const t of intra) {
			// 定位到「跳变发生在哪一颗粒内部」：取该跳变之前最后一个已对齐的拼接切点（成片时基，
			// 已含漂移），人跳时码复核时对得上画面；片头颗粒无前序切点则给 null
			const prior = matched.filter((m) => m.cut <= t);
			const clipStart = prior.length ? prior[prior.length - 1]!.cut : null;
			const mapped = toSourceTime(slots, t);
			items.push({
				type: "intra_cut",
				severity: "warn",
				st: t,
				ed: t,
				evidence: {
					note: "跳变不落在任何 clip 拼接边界上：颗粒窗口内部越过了源素材的镜头切点",
					clip_started_at: clipStart,
					...(clipStart !== null ? { into_clip_sec: r3(t - clipStart) } : {}),
					// 工程坐标：定位到 beat / 槽位 / 素材 / 源窗，供直接改 plan 换段
					...(mapped
						? {
								beat: mapped.slot.beat,
								slot_index: mapped.slot.slotIndex,
								clip_id: mapped.slot.clipId,
								source_window: [mapped.slot.clipSt, mapped.slot.clipEd],
								source_time: mapped.src,
							}
						: { coord_note: "跳变落在槽位边界容差内或工程无槽位登记，无法唯一定位" }),
				},
			});
		}
		if (drifts.length) {
			opts.onProgress?.(
				`工程对表：${matched.length}/${bounds.length} 个剪切点对齐（漂移 ${r3(drifts[0]!)}s→${r3(drifts[drifts.length - 1]!)}s）· 段内跳切 ${intra.length}`,
			);
		}
	}

	items.push(...shortShotItems(cuts, spliceCuts));

	// 用 import 进来的那个绑定（`parseBlackDetect` 只是它的导出别名，本模块内无同名局部绑定）
	for (const b of parseBlackSpans(vErr)) {
		const known = opts.gtrk ? isKnownBlackHole(opts.gtrk, b.st, b.ed) : false;
		items.push({
			type: "black",
			severity: known ? "info" : "warn",
			st: r3(b.st),
			ed: r3(b.ed),
			evidence: { sec: r3(b.ed - b.st), ...(known ? { known_black_bed_hole: true } : {}) },
		});
	}
	for (const f of parseFreezeDetect(vErr)) {
		items.push({ type: "freeze", severity: "warn", st: r3(f.st), ed: r3(f.ed), evidence: { sec: r3(f.ed - f.st) } });
	}

	// ── 音频趟：silencedetect + astats + ebur128 并联（一次解码）──
	if (a) {
		opts.onProgress?.("音频趟：静音 + 削波 + true peak 检测…");
		// ⚠️ **顺序是硬约束**（fix-qc-truepeak-parse §0.2 实证）：
		//   `aformat=sample_fmts=s16` MUST 排在 `ebur128` **之后**、`astats` **之前**。
		//   · 放在 astats 之前：float 解码下 astats 的削波指标会塌成常量（Flat factor 0 / Abs Peak count 1），
		//     样本域这条腿丧失判别力（实测：插了 s16 后同一 AAC 恢复成 flat 13.70 / Abs Peak 79）。
		//   · 放在 ebur128 之前会打死另一条腿：s16 在 0 dBFS 处硬钳，会把同一条硬削波语料的
		//     true peak 从 +1.6 压回 +0.1。
		//   `ebur128` 透传音频 ⇒ 仍是**一趟解码**，MUST NOT 新增趟次。
		const aFilter = [
			`silencedetect=n=${T.silenceNoiseDb}dB:d=${T.silenceMinDurSec}`,
			"ebur128=peak=true",
			"aformat=sample_fmts=s16",
			"astats=metadata=1",
		].join(",");
		const aErr = await captureStderr(ff.ffmpeg, ["-i", input, "-af", aFilter, "-f", "null", "-"]);
		const silences = parseSilenceDetect(aErr);
		for (const s of silences) {
			items.push({ type: "silence", severity: "warn", st: r3(s.st), ed: r3(s.ed), evidence: { sec: r3(s.ed - s.st) } });
		}
		const { clipSampleRatio, absPeakCount, sampleCount, flatFactor, truePeakDbtp, integratedLufs } = parseAudioStats(aErr);
		// 整片无声（error）：与上面的逐段 warn 条目**并存**——逐段 warn 是片中留白，本条是「整片没声音」。
		// 复用同一趟已跑的 ebur128，零新增解码。
		const fullSilence = fullFilmSilenceItem(integratedLufs, silences, aDur ?? vDur ?? 0);
		if (fullSilence) items.push(fullSilence);
		// 爆音/削波（fix-qc-truepeak-parse）：两条腿两条线，判据与阈值全在 clipItem / QC_THRESHOLDS。
		const clip = clipItem(truePeakDbtp, clipSampleRatio, aDur ?? 0, flatFactor);
		if (clip) items.push(clip);
		// 解析失败必须可见：有音频流却没拿到读数 ⇒ 明说「本次未生效」，MUST NOT 静默当作通过。
		const unavailable = audioParseFailureItem(
			true, // 本分支的前提就是 ffprobe 见到了 audio stream（`if (a)`）
			{ truePeak: truePeakDbtp === null, clipSampleRatio: clipSampleRatio === null },
			aDur ?? 0,
			ff.ffmpeg,
		);
		if (unavailable) {
			(unavailable.evidence as Record<string, unknown>).abs_peak_count = absPeakCount;
			(unavailable.evidence as Record<string, unknown>).sample_count = sampleCount;
			items.push(unavailable);
		}
	}

	items.sort((x, y) => x.st - y.st || x.ed - y.ed);
	const summary = { error: 0, warn: 0, info: 0 };
	for (const it of items) summary[it.severity]++;
	return { qc_version: "v1", input, generated_at: new Date().toISOString(), summary, items };
}

/** 报告 → 退出码门控（`--fail-on`）。 */
export function shouldFail(report: QcReport, failOn: "error" | "warn" | "never"): boolean {
	if (failOn === "never") return false;
	if (failOn === "warn") return report.summary.error > 0 || report.summary.warn > 0;
	return report.summary.error > 0;
}

/** 秒 → `HH:MM:SS.mmm`（人读报告时码）。 */
export function fmtTime(sec: number): string {
	const s = Math.max(0, sec);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = s % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${ss.toFixed(3).padStart(6, "0")}`;
}
