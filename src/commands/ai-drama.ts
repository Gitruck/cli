/** gtrk ai-drama lay —— 消费 AI Drama Desk return-v1 导出包，确定性回填独立 AI 视频轨。 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { aiDramaTracksEdited, layAiDramaTracks, type AiDramaLayPackage } from "../lib/ai-drama-lay";
// [adjust-lay-frame-domain D1] 顶层 video_rate 与 matrix lay / gtrk patch 同一读法：缺席 / 非正 / 非整数 ⇒ 报错退出零副作用
import { videoRateOf } from "../lib/gtrk-patch";
import { assertGtrkV1, readGtrk, writeGtrkAtomic } from "../lib/gtrk-writeback";
import { reportMaterialIntegrity, safeCheckMaterialIntegrity } from "../lib/material-integrity";
import { reportReprojection, reprojectDispatchWindows } from "../lib/reproject";
import { probeGeometry, type Geometry } from "../lib/media";
import { compareWalls, wallFromDeclared, wallFromProbe } from "../lib/clock-adapter";
import { log, routeLogsToStderr } from "../lib/log";

interface AiDramaOpts {
	project?: string;
	/** commander 将 `--package` 映射为单数属性；值本身由 collector 累加成数组。 */
	package?: string[];
	replaceAll?: boolean;
	json?: boolean;
}

interface ReturnManifestItem {
	shotIndex?: unknown;
	file?: unknown;
	suggestedSec?: unknown;
	measuredSec?: unknown;
	width?: unknown;
	height?: unknown;
	fps?: unknown;
}

interface ReturnManifest {
	slug?: unknown;
	beatId?: unknown;
	trackSt?: unknown;
	trackEd?: unknown;
	items?: unknown;
	skipped?: unknown;
}

/** 可注入依赖（测试替身，离线）：`probe` = 拷贝落盘后对导出片段 ffprobe（add-cross-clock-adapter D3；缺省 = 真 `probeGeometry`）。 */
export interface AiDramaDeps {
	probe?: (abs: string) => Geometry;
}

/** 时钟账面（--json `clock`）：manifest 自述 vs 落盘实测。 */
interface AiDramaClock {
	/** 实测成功、`measuredSec` 已由实测覆盖的镜头数。 */
	manifest_probed: number;
	/** 探测失败、沿用 manifest 自述的镜头数。 */
	unverified: number;
	/** 自述 vs 实测差 > 1ms 的明细（实测已覆盖自述；这里只是把差异说出来）。 */
	manifest_mismatch: Array<{ beat: string; shot_index: number; file: string; declared_ms: number; probed_ms: number }>;
}

const collectPath = (v: string, prev: string[] | undefined): string[] => [...(prev ?? []), v];
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function registerAiDrama(program: Command, deps: AiDramaDeps = {}): void {
	program
		.command("ai-drama [words...]")
		.description("AI 情景片段回填：消费 AI Drama Desk return-v1 导出包，新增一条独立 AI 视频轨（纯本地、零模型调用、零计费）")
		.option("--project <dir>", "口播工程产物目录（定位 gtrk/project.gtrk）")
		.option("--package <path>", "return-v1 导出目录或 manifest.json，可重复传", collectPath)
		.option("--replace-all", "已铺 AI 轨在客户端被编辑过时仍重置重铺（会覆盖该 AI 轨上的手调）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[] | undefined, opts: AiDramaOpts) => {
			await runAiDrama(words ?? [], opts, deps);
		});
}

function locateGtrk(baseDir: string): string {
	const found = [join(baseDir, "gtrk", "project.gtrk"), join(baseDir, "project.gtrk")].find((p) => existsSync(p));
	if (!found) throw new Error(`找不到工程文件：${join(baseDir, "gtrk", "project.gtrk")}`);
	return found;
}

function manifestPathOf(input: string): string {
	const abs = resolve(input);
	return abs.toLowerCase().endsWith(".json") ? abs : join(abs, "manifest.json");
}

function safeLeafFile(v: unknown, where: string): string {
	if (typeof v !== "string" || !v || isAbsolute(v) || basename(v) !== v || v === "." || v === "..") {
		throw new Error(`${where} 的 file 必须是导出目录内的单个文件名（得到 ${JSON.stringify(v)}）`);
	}
	return v;
}

async function readPackage(input: string): Promise<{ exportDir: string; pkg: AiDramaLayPackage }> {
	const manifestPath = manifestPathOf(input);
	if (!existsSync(manifestPath)) throw new Error(`找不到 AI 导出清单：${manifestPath}`);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ReturnManifest;
	if (typeof manifest.slug !== "string" || !manifest.slug) throw new Error(`${manifestPath}：缺 slug`);
	if (typeof manifest.beatId !== "string" || !/^B\d+$/i.test(manifest.beatId)) throw new Error(`${manifestPath}：beatId 须形如 B03`);
	if (!finite(manifest.trackSt) || !finite(manifest.trackEd) || manifest.trackEd <= manifest.trackSt) {
		throw new Error(`${manifestPath}：trackSt/trackEd 窗口无效`);
	}
	if (!Array.isArray(manifest.items) || manifest.items.length === 0) throw new Error(`${manifestPath}：没有可回填的 items`);
	if (Array.isArray(manifest.skipped) && manifest.skipped.length > 0) {
		throw new Error(`${manifestPath}：仍有 ${manifest.skipped.length} 个镜头未导出，拒绝把不完整包铺进工程`);
	}
	const exportDir = dirname(manifestPath);
	const seenShots = new Set<number>();
	const items = (manifest.items as ReturnManifestItem[]).map((raw, i) => {
		const where = `${manifestPath} items[${i}]`;
		if (!finite(raw.shotIndex) || !Number.isInteger(raw.shotIndex) || raw.shotIndex <= 0) throw new Error(`${where}：shotIndex 无效`);
		if (seenShots.has(raw.shotIndex)) throw new Error(`${where}：shotIndex ${raw.shotIndex} 重复`);
		seenShots.add(raw.shotIndex);
		const file = safeLeafFile(raw.file, where);
		const source = join(exportDir, file);
		if (!existsSync(source)) throw new Error(`${where}：导出视频不存在：${source}`);
		if (!finite(raw.suggestedSec) || raw.suggestedSec <= 0 || !finite(raw.measuredSec) || raw.measuredSec <= 0) {
			throw new Error(`${where}：suggestedSec/measuredSec 须为正数`);
		}
		return {
			shotIndex: raw.shotIndex,
			file,
			relPath: "",
			suggestedSec: raw.suggestedSec,
			measuredSec: raw.measuredSec,
			...(finite(raw.width) && raw.width > 0 ? { width: raw.width } : {}),
			...(finite(raw.height) && raw.height > 0 ? { height: raw.height } : {}),
			...(finite(raw.fps) && raw.fps > 0 ? { fps: raw.fps } : {}),
		};
	});
	return {
		exportDir,
		pkg: {
			slug: manifest.slug,
			beatId: manifest.beatId.toUpperCase(),
			manifestPath,
			trackSt: manifest.trackSt,
			trackEd: manifest.trackEd,
			items,
		},
	};
}

export async function runAiDrama(words: string[], opts: AiDramaOpts, deps: AiDramaDeps = {}): Promise<Record<string, unknown>> {
	if (opts.json) routeLogsToStderr();
	if (words.length !== 1 || words[0] !== "lay") {
		throw new Error("用法：gtrk ai-drama lay --project <目录> --package <导出目录或manifest.json> [--package ...]");
	}
	if (!opts.project) throw new Error("ai-drama lay 需要 --project <目录>");
	if (!opts.package?.length) throw new Error("ai-drama lay 至少需要一个 --package <导出目录或manifest.json>");

	const baseDir = resolve(opts.project);
	const gtrkPath = locateGtrk(baseDir);
	const gtrkDir = dirname(gtrkPath);
	const { gtrk, revision } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);
	// ── 帧率预检（adjust-lay-frame-domain D1）：AI 轨落轨锚在顶层 video_rate；缺席 / 非正 / 非整数在这里就抛
	//    （与 matrix lay / layAiDramaTracks 同一读法与话术）——此刻零复制、零改动，MUST NOT 静默退回毫秒路。
	videoRateOf(gtrk);
	if (!opts.replaceAll && aiDramaTracksEdited(gtrk)) {
		throw new Error("已铺 AI 轨在客户端被编辑过，已拒绝覆盖；确认要丢弃该 AI 轨上的手调后再加 --replace-all");
	}

	const loaded = await Promise.all(opts.package.map(readPackage));
	const beatIds = loaded.map((p) => p.pkg.beatId);
	if (new Set(beatIds).size !== beatIds.length) throw new Error(`同一 beat 重复传包：${beatIds.join("、")}`);
	log.step(`▶ AI 情景片段回填：${loaded.length} 个 beat / ${loaded.reduce((n, p) => n + p.pkg.items.length, 0)} 个镜头…`);

	const reproj = await reprojectDispatchWindows({
		baseDir,
		gtrk,
		entries: loaded.map((p) => ({ key: p.pkg.beatId, beat: p.pkg.beatId, track_st: p.pkg.trackSt, track_ed: p.pkg.trackEd })),
	});
	reportReprojection(reproj);
	const outcomes = new Map(reproj.entries.map((e) => [e.key, e]));
	const skipped: Array<{ beat: string; reason: string }> = [];
	const packages: AiDramaLayPackage[] = [];
	for (const p of loaded) {
		const outcome = outcomes.get(p.pkg.beatId);
		if (outcome?.dropped) {
			skipped.push({ beat: p.pkg.beatId, reason: "重投影后零存活" });
			continue;
		}
		const trackSt = outcome?.track_st ?? p.pkg.trackSt;
		const trackEd = outcome?.track_ed ?? p.pkg.trackEd;
		const assetRelDir = `assets/ai-drama/${p.pkg.slug}`;
		packages.push({
			...p.pkg,
			trackSt,
			trackEd,
			items: p.pkg.items.map((it) => ({ ...it, relPath: `${assetRelDir}/${it.file}` })),
		});
	}
	if (!packages.length) throw new Error("所有 AI beat 都已从当刻成片中剪除，没有可回填内容；工程未改动");

	// ── 拷贝落盘即实测（add-cross-clock-adapter D3）：`materials[].duration` 与越素材判据（帧格化的 `measuredMs`）从此同源于
	//    落盘文件本身；工作台 manifest 的 `measuredSec` 只作比对（外部 manifest 差 > 1ms 即告警）。探测失败 ⇒ 沿自述 + unverified，
	//    MUST NOT 让 lay 失败。判据本身（ai-drama-lay 的 `durMs > measuredMs` / `assertSourceBound`）一字未改，改的是值的真相源。
	const probe = deps.probe ?? probeGeometry;
	const clock: AiDramaClock = { manifest_probed: 0, unverified: 0, manifest_mismatch: [] };
	const unverifiedSamples: string[] = [];
	// VFR 可见（add-frame-rate-table-vfr-detect D4）：叠在同一次拷贝后探测上，零额外进程；只 WARN 不阻断、不改 lay 判据。
	const vfrSamples: string[] = [];
	for (const pkg of packages) {
		const src = loaded.find((p) => p.pkg.slug === pkg.slug && p.pkg.beatId === pkg.beatId)!;
		const assetDir = join(gtrkDir, "assets", "ai-drama", pkg.slug);
		await mkdir(assetDir, { recursive: true });
		for (const item of pkg.items) {
			const dst = join(assetDir, item.file);
			await copyFile(join(src.exportDir, item.file), dst);
			const declared = wallFromDeclared(item.measuredSec, "external_manifest", "return-v1 manifest")!; // readPackage 已判正数
			try {
				const geo = probe(dst);
				if (geo.vfr === true) {
					vfrSamples.push(`${pkg.beatId} s${item.shotIndex}（r ${geo.fps.toFixed(3)} / avg ${geo.avgFps !== undefined ? geo.avgFps.toFixed(3) : "?"}）`);
				}
				const measured = wallFromProbe(geo, "source_container", "ffprobe");
				if (!measured) throw new Error(`ffprobe 时长无效（${geo.duration}）`);
				const cmp = compareWalls(declared, measured); // 外部 manifest：无帧率可谈，容差退 1ms
				if (cmp.exceeds) {
					clock.manifest_mismatch.push({ beat: pkg.beatId, shot_index: item.shotIndex, file: item.file, declared_ms: cmp.declaredMs, probed_ms: cmp.measuredMs });
				}
				item.measuredSec = measured.durationSec;
				clock.manifest_probed++;
			} catch (e) {
				clock.unverified++;
				unverifiedSamples.push(`${pkg.beatId} s${item.shotIndex}（${e instanceof Error ? e.message : String(e)}）`);
			}
		}
	}
	if (vfrSamples.length) {
		log.warn(
			`导出片段疑似可变帧率（VFR）${vfrSamples.length} 镜：${vfrSamples.slice(0, 3).join("、")}${vfrSamples.length > 3 ? " 等" : ""}——` +
				"已按落盘实测时长入轨、lay 判据不变；但 VFR 片段在客户端 / 渲染器上的帧对齐可能逐段漂移，" +
				"稳妥做法是让工作台按固定帧率导出（或 ffmpeg -vsync cfr 重封装）后重跑本命令（幂等重铺）。",
		);
	}
	if (unverifiedSamples.length) {
		log.warn(
			`导出片段实测失败 ${unverifiedSamples.length} 镜：沿用工作台 manifest 自述的 measuredSec（unverified）——` +
				`${unverifiedSamples.slice(0, 3).join("、")}${unverifiedSamples.length > 3 ? " 等" : ""}。ffmpeg 就位后重跑本命令即可实测（幂等重铺）。`,
		);
	}
	if (clock.manifest_mismatch.length) {
		const sample = clock.manifest_mismatch
			.slice(0, 3)
			.map((m) => `${m.beat} s${m.shot_index}（自述 ${m.declared_ms}ms / 实测 ${m.probed_ms}ms）`)
			.join("、");
		log.warn(
			`工作台 manifest 自述时长与落盘实测差 > 1ms：${clock.manifest_mismatch.length} 镜——${sample}${clock.manifest_mismatch.length > 3 ? " 等" : ""}。` +
				"materials[].duration 与越素材判据已按实测；自述值只作比对。全量明细见 --json clock.manifest_mismatch。",
		);
	}

	const generatedAt = new Date().toISOString();
	const laid = layAiDramaTracks({ gtrk, packages, generatedAt, warn: log.warn, info: log.info });
	laid.meta.timecode_source = reproj.summary.mode === "reprojected" ? "reprojected" : "dispatch_snapshot";
	if (reproj.summary.projected_at) laid.meta.reprojected_at = reproj.summary.projected_at;
	if (reproj.summary.reason) laid.meta.timecode_degrade_reason = reproj.summary.reason;
	writeGtrkAtomic(gtrkPath, laid.next, revision, "ai-drama lay");
	const integrity = safeCheckMaterialIntegrity({ gtrk: laid.next, gtrkDir, log });
	log.ok(`AI 轨回填完成：${laid.summary.beats} 个 beat / ${laid.summary.laidClips} 个镜头 → video_track ${laid.summary.laidTrack ?? "-"}`);
	log.info("既有 A-roll、BGM 与 B-roll 轨均未改动；AI 片段已复制进工程 assets/ai-drama，可直接进客户端精剪。");
	if (integrity) reportMaterialIntegrity(integrity, log);
	const result = {
		ok: skipped.length === 0,
		mode: "lay",
		project: baseDir,
		gtrk: gtrkPath,
		laidTrack: laid.summary.laidTrack,
		laidClips: laid.summary.laidClips,
		beats: laid.summary.beats,
		skipped,
		reprojection: reproj.summary,
		frame_grid: laid.summary.frameGrid,
		// 时钟账面（add-cross-clock-adapter D3）：实测覆盖 / 回退自述计数 + manifest_mismatch 全量明细
		clock,
		...(integrity ? { integrity } : {}),
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}
