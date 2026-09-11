/**
 * gtrk pip lay —— 双源画中画（add-pip-companion-lay）：屏录 / 第二机位与口播粗剪同步。
 *
 * 三分支偏移（与 `gtrk audio align` 同一套原语、同一阈值）：自动（互相关 + 置信门）/ `--offset` 显式 / `--resume` 读回客户端拖齐的对齐工程。
 * 纯本地、零云端、零计费。铺轨逻辑在 `lib/pip-lay.ts`（纯函数）；本文件只做：定位工程 → 探测 → 分支 → 写回 → 回执（打印数字，不打「已验证」）。
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_ALIGN_THRESHOLD, detectOffset, writeAlignProject } from "../lib/audio-align";
import { videoRateOf } from "../lib/gtrk-patch";
import { assertGtrkV1, readGtrk, writeGtrkAtomic, GtrkWritebackConflictError } from "../lib/gtrk-writeback";
import { log, routeLogsToStderr } from "../lib/log";
import { probeGeometry } from "../lib/media";
import { audioCacheDir } from "../lib/paths";
import { deliveryRate } from "../lib/frame-domain";
import {
	PIP_ANCHORS,
	PIP_SHAPES,
	type PipAnchor,
	type PipMaskSpec,
	type PipShape,
	buildPipAlignProject,
	buildPipTracks,
	pickMainTrack,
	pipGeometry,
	pipMask,
	readPipAlignOffset,
} from "../lib/pip-lay";

interface PipOpts {
	project?: string;
	gtrk?: string;
	companion?: string;
	resume?: string;
	shape?: string;
	feather?: string;
	cornerRadius?: string;
	borderRadius?: string;
	anchor?: string;
	scale?: string;
	margin?: string;
	offset?: string;
	threshold?: string;
	dryRun?: boolean;
	expectedRevision?: string;
	ffmpegPath?: string;
	json?: boolean;
	/** 测试注入（离线）。 */
	_detect?: typeof detectOffset;
	_probe?: typeof probeGeometry;
}

export interface PipLayResult {
	ok: boolean;
	mode: "lay" | "dry-run" | "align-project";
	gtrk?: string;
	offset_sec?: number;
	confidence?: number;
	threshold?: number;
	companion?: { path: string; duration: number; video_size?: [number, number]; vfr?: boolean | null };
	tracks?: { companion: number | null; pip: number | null };
	laid?: { companion: number; pip: number; empty: number; clamped: number };
	geometry?: Record<string, unknown>;
	border_radius?: number;
	clip_mask?: PipMaskSpec;
	strip?: { removedClips: number; removedTracks: number[]; keptForeign: Array<{ track_index: number; clip_id: string }> };
	cuts?: Array<Record<string, unknown>>;
	revision?: string;
	alignProject?: string;
	conflict?: { expected_revision: string; actual_revision: string };
}

const fwd = (p: string): string => p.replace(/\\/g, "/");

function locateGtrk(opts: PipOpts): string {
	if (opts.gtrk) {
		const p = resolve(opts.gtrk);
		if (!existsSync(p)) throw new Error(`工程文件不存在：${p}`);
		return p;
	}
	if (!opts.project) throw new Error("需 --project <工程目录>（自动定位 gtrk/project.gtrk）或 --gtrk <path>");
	const base = resolve(opts.project);
	const found = [join(base, "gtrk", "project.gtrk"), join(base, "project.gtrk")].find((p) => existsSync(p));
	if (!found) throw new Error(`未找到工程文件（${join(base, "gtrk", "project.gtrk")}）`);
	return found;
}

function num(v: string | undefined, name: string): number | undefined {
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) throw new Error(`${name} 需要数字，拿到「${v}」`);
	return n;
}

function enumOpt<T extends string>(v: string | undefined, allowed: readonly T[], name: string, fallback: T): T {
	if (v === undefined) return fallback;
	if (!(allowed as readonly string[]).includes(v)) throw new Error(`${name} 取值 ${allowed.join("|")}，拿到「${v}」`);
	return v as T;
}

/** 主轨首颗 clip 的素材（人像原片）：路径（相对 gtrk 目录解析）与尺寸。 */
function referenceMaterial(gtrk: Record<string, unknown>, gtrkDir: string): { abs: string; video_size?: [number, number] } {
	const main = pickMainTrack(gtrk);
	const first = (main?.track_timeline ?? []).find((c) => c.material !== null && c.material !== undefined);
	if (!first) throw new Error("主轨没有引用素材的 clip");
	const materials = (Array.isArray(gtrk.materials) ? gtrk.materials : []) as Record<string, unknown>[];
	const mat = materials.find((m) => m.id === first.material);
	const path = typeof mat?.path === "string" ? mat.path : "";
	if (!path) throw new Error(`主轨素材 ${String(first.material)} 缺 path，无法对轨（Profile B 工程才可本地对齐）`);
	const abs = isAbsolute(path) ? path : resolve(gtrkDir, path);
	if (!existsSync(abs)) throw new Error(`主轨素材文件不存在：${abs}`);
	const vs = mat?.video_size;
	const video_size = Array.isArray(vs) && vs.length === 2 && Number(vs[0]) > 0 && Number(vs[1]) > 0 ? ([Number(vs[0]), Number(vs[1])] as [number, number]) : undefined;
	return { abs, video_size };
}

export async function runPipLay(opts: PipOpts): Promise<PipLayResult> {
	if (opts.json) routeLogsToStderr();
	const detect = opts._detect ?? detectOffset;
	const probe = opts._probe ?? probeGeometry;
	const threshold = num(opts.threshold, "--threshold") ?? DEFAULT_ALIGN_THRESHOLD;
	if (threshold <= 0) throw new Error(`--threshold 需要正数，拿到「${opts.threshold}」`);

	const gtrkPath = locateGtrk(opts);
	const gtrkDir = dirname(gtrkPath);
	const { gtrk, revision } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);
	videoRateOf(gtrk); // 帧率门前置：非法工程在此即止（零副作用）
	if (opts.expectedRevision && opts.expectedRevision !== revision) {
		throw new GtrkWritebackConflictError(
			"pip lay",
			opts.expectedRevision,
			revision,
			"guard",
			`工程已被改动：--expected-revision=${opts.expectedRevision}，实际 ${revision}。重新读取后再 lay。`,
		);
	}
	const canvas = gtrk.video_size as [number, number];
	const ref = referenceMaterial(gtrk, gtrkDir);

	// ── 伴随源与偏移（三分支）──
	let companionAbs: string;
	let offsetSec: number;
	let confidence: number | undefined;
	if (opts.resume) {
		const alignPath = resolve(opts.resume);
		if (!existsSync(alignPath)) throw new Error(`对齐工程不存在：${alignPath}`);
		const doc = readGtrk(alignPath).gtrk;
		const info = readPipAlignOffset(doc, (p) => (isAbsolute(p) ? p : resolve(dirname(alignPath), p)));
		companionAbs = info.companionAbs;
		offsetSec = info.offsetSec;
		log.info(`对齐工程读回：offset = ${offsetSec.toFixed(3)}s（伴随源轨 track_st − 人像轨 track_st）`);
	} else {
		if (!opts.companion) throw new Error("需 --companion <屏录或第二机位视频>（或 --resume <对齐工程>）");
		companionAbs = resolve(opts.companion);
		if (!existsSync(companionAbs)) throw new Error(`伴随源不存在：${companionAbs}`);
		const explicit = num(opts.offset, "--offset");
		if (explicit !== undefined) {
			offsetSec = explicit;
			log.info(`显式偏移：offset = ${offsetSec.toFixed(3)}s（跳过检测）`);
		} else {
			log.step("对轨检测（人像 ↔ 伴随源 互相关 + 置信度）…");
			await mkdir(audioCacheDir(), { recursive: true });
			let det: Awaited<ReturnType<typeof detectOffset>>;
			try {
				det = await detect(ref.abs, companionAbs, audioCacheDir(), opts.ffmpegPath);
			} catch (e) {
				throw new Error(
					`伴随源音频不可用于对轨（${(e as Error).message}）——屏录无麦克风音轨时互相关没有参照：` +
						"改传 --offset <秒>，或先跑一次让客户端拖齐（需要至少一段有声）。",
				);
			}
			offsetSec = det.offsetSec;
			confidence = det.confidence;
			log.info(`偏移 = ${offsetSec.toFixed(3)}s（正 = 伴随源晚开录）  置信度 = ${det.confidence}（阈值 ${threshold}）`);
			if (det.confidence < threshold) {
				const refGeo = probe(ref.abs, opts.ffmpegPath);
				const compGeo = probe(companionAbs, opts.ffmpegPath);
				const projPath = join(dirname(companionAbs), `${basename(companionAbs, extname(companionAbs))}_pip_align.gtrk`);
				const proj = buildPipAlignProject({
					referenceAbs: ref.abs,
					companionAbs,
					offsetEstimate: offsetSec,
					referenceGeo: { width: refGeo.width, height: refGeo.height, rate: deliveryRate(refGeo.fps), duration: refGeo.duration },
					companionGeo: { width: compGeo.width, height: compGeo.height, duration: compGeo.duration },
				});
				writeAlignProject(projPath, proj);
				log.warn(`置信度 ${det.confidence} < 阈值 ${threshold}，不自动铺。`);
				log.info(`已产对齐工程：${projPath}`);
				log.info("请在客户端打开该工程，把「伴随源」轨拖到与人像画面对齐后保存，然后跑：");
				log.info(`  gtrk pip lay --project "${opts.project ?? gtrkDir}" --resume "${projPath}"`);
				const result: PipLayResult = { ok: true, mode: "align-project", gtrk: gtrkPath, offset_sec: offsetSec, confidence, threshold, alignProject: projPath };
				if (opts.json) console.log(JSON.stringify(result));
				return result;
			}
		}
	}

	// ── 伴随源几何 ──
	const compGeo = probe(companionAbs, opts.ffmpegPath);
	if (!(compGeo.duration > 0)) throw new Error(`伴随源时长探测失败：${companionAbs}`);
	if (compGeo.vfr === true) {
		log.warn(`伴随源疑似可变帧率（r=${compGeo.fps} / avg=${compGeo.avgFps}）：镜像切点按源钟毫秒落位、不吸源帧，属预期；只在此报告`);
	}
	const companion = {
		path: fwd(companionAbs),
		duration: compGeo.duration,
		...(compGeo.width > 0 && compGeo.height > 0 ? { video_size: [compGeo.width, compGeo.height] as [number, number] } : {}),
		...(compGeo.fps > 0 ? { video_rate: deliveryRate(compGeo.fps) } : {}),
	};

	// ── 几何与蒙版 ──
	const shape = enumOpt<PipShape>(opts.shape, PIP_SHAPES, "--shape", "ellipse");
	const anchor = enumOpt<PipAnchor>(opts.anchor, PIP_ANCHORS, "--anchor", "bottom-right");
	const geometry = pipGeometry({
		canvas,
		materialSize: ref.video_size,
		scale: num(opts.scale, "--scale"),
		anchor,
		margin: num(opts.margin, "--margin"),
	});
	const mask = pipMask({
		shape,
		width: geometry.width,
		height: geometry.height,
		feather: num(opts.feather, "--feather"),
		cornerRadius: num(opts.cornerRadius, "--corner-radius"),
	});
	const borderRadius = num(opts.borderRadius, "--border-radius");
	if (borderRadius !== undefined && borderRadius < 0) throw new Error("--border-radius 需要 ≥ 0");

	const generatedAt = new Date().toISOString();
	const laid = buildPipTracks({
		gtrk,
		companion,
		offsetSec,
		confidence,
		geometry,
		mask,
		borderRadius,
		generatedAt,
		warn: log.warn,
		info: log.info,
	});

	// ── 回执（数字，不打「已验证」）──
	log.step(
		`${opts.dryRun ? "▶ 计划（--dry-run 不写盘）" : "▶ 铺轨"}：伴随源轨 ${laid.summary.companionTrack ?? "-"} / 画中画轨 ${laid.summary.pipTrack ?? "-"}` +
			`（主轨与音轨零改动；剥旧 ${laid.summary.strip.removedClips} 颗 / ${laid.summary.strip.removedTracks.length} 轨）`,
	);
	for (const c of laid.meta.cuts) {
		const tag = c.empty ? "留空（伴随源不存在）" : `伴随源 clip_st=${c.clip_st.toFixed(3)}s` + (c.clamped_head_ms || c.clamped_tail_ms ? `（钳 头 ${c.clamped_head_ms}ms / 尾 ${c.clamped_tail_ms}ms）` : "");
		log.info(`  ${c.from}: 轨上 ${c.track_st.toFixed(3)}→${c.track_ed.toFixed(3)}s  ${tag}`);
	}
	const g = geometry.clip_transform;
	log.info(`画中画几何：${geometry.width}×${geometry.height}px @ (${g.position_x}, ${g.position_y})  scale=${g.scale_x}  锚 ${anchor}`);
	log.info(`蒙版：${mask ? `${mask.shape} ${mask.width}×${mask.height}（元素归一化）${mask.feather ? ` 羽化 ${mask.feather}%` : ""}${mask.corner_radius ? ` 圆角 ${mask.corner_radius}` : ""}` : "无"}${borderRadius ? `；元素圆角 ${borderRadius}px` : ""}`);
	for (const k of laid.summary.strip.keptForeign) {
		log.warn(`轨 ${k.track_index} 上 clip ${k.clip_id} 已被你编辑过（失去自产身份），保留未动`);
	}

	let newRevision: string | undefined;
	if (!opts.dryRun) {
		try {
			newRevision = writeGtrkAtomic(gtrkPath, laid.next, revision, "pip lay");
		} catch (e) {
			if (e instanceof GtrkWritebackConflictError) {
				const result: PipLayResult = { ok: false, mode: "lay", gtrk: gtrkPath, conflict: { expected_revision: e.expectedRevision, actual_revision: e.actualRevision } };
				if (opts.json) console.log(JSON.stringify(result));
				throw e;
			}
			throw e;
		}
		log.ok(`已写回：${gtrkPath}`);
		log.info("下一步：客户端打开微调画中画（位置 / 大小 / 蒙版页换形状）→ gtrk subtitle lay → 出片（客户端本地导出 / gtrk render / 导剪映）。");
	}

	const result: PipLayResult = {
		ok: true,
		mode: opts.dryRun ? "dry-run" : "lay",
		gtrk: gtrkPath,
		offset_sec: laid.meta.offset_sec,
		...(confidence !== undefined ? { confidence, threshold } : {}),
		companion: { ...companion, vfr: compGeo.vfr ?? null },
		tracks: { companion: laid.summary.companionTrack, pip: laid.summary.pipTrack },
		laid: { companion: laid.summary.laidCompanion, pip: laid.summary.laidPip, empty: laid.summary.emptyCuts, clamped: laid.summary.clampedCuts },
		geometry: { ...g, width: geometry.width, height: geometry.height, anchor },
		...(borderRadius ? { border_radius: borderRadius } : {}),
		...(mask ? { clip_mask: mask } : {}),
		strip: laid.summary.strip,
		cuts: laid.meta.cuts as unknown as Array<Record<string, unknown>>,
		...(newRevision ? { revision: newRevision } : {}),
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

export function registerPip(program: Command): void {
	program
		.command("pip [words...]")
		.description("双源画中画：gtrk pip lay 把口播粗剪的切点镜像到同步录的屏录 / 第二机位，铺满幅轨 + 人像画中画副本轨（带形状蒙版 / 圆角；纯本地零计费）")
		.option("--project <dir>", "[lay] 口播工程产物目录（定位 gtrk/project.gtrk）")
		.option("--gtrk <path>", "[lay] 直接指定 .gtrk 工程文件")
		.option("--companion <video>", "[lay] 同步录制的伴随源（屏录 / 第二机位）")
		.option("--resume <gtrk>", "[lay] 客户端拖齐保存后的对齐工程，读回偏移完成铺轨")
		.option("--shape <s>", `[lay] 画中画蒙版形状 ${PIP_SHAPES.join("|")}（缺省 ellipse = 短边内切正圆）`)
		.option("--feather <0..100>", "[lay] 蒙版羽化（占蒙版短边百分比，缺省 10）")
		.option("--corner-radius <0..1>", "[lay] 仅 --shape rectangle：圆角占蒙版短边一半的比例（缺省 0.25）")
		.option("--border-radius <px>", "[lay] 画中画元素圆角（画布像素；可与形状蒙版共存）")
		.option("--anchor <a>", `[lay] 画中画位置 ${PIP_ANCHORS.join("|")}（缺省 bottom-right）`)
		.option("--scale <0..1>", "[lay] 画中画显示高度占画布高度的比例（缺省 0.28）")
		.option("--margin <px>", "[lay] 画中画到画布边的内缩（缺省 40）")
		.option("--offset <sec>", "[lay] 显式偏移秒（跳过检测；正 = 伴随源晚开录）")
		.option("--threshold <r>", "[lay] 置信度阈值（主峰/次峰显著性比；缺省与 gtrk audio align 同一标定值）")
		.option("--dry-run", "只算与自检、不写文件（回执 plan）")
		.option("--expected-revision <sha256>", "跨命令写回断言：与盘上内容 revision 不符即拒写")
		.option("--ffmpeg-path <dir>", "指定 ffmpeg/ffprobe 所在目录（缺省 ~/.gitruck/ffmpeg → 系统 PATH）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[], opts: PipOpts) => {
			const sub = (words ?? [])[0];
			if (sub !== "lay") throw new Error("用法：gtrk pip lay --project <工程目录> --companion <伴随源>（或 --resume <对齐工程>）");
			await runPipLay(opts);
		});
}
