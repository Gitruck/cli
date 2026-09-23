/**
 * gtrk ai-drama —— 三个动作：
 *   `lay`   消费 return-v1 导出包，确定性回填独立 AI 视频轨
 *   `pack`  从一个视频目录 + 派单**产出**合规 return-v1 包（自出图自运镜这条路的入口）
 *   `swap`  原地替换某 clip 背后的素材文件，断言结构等价、`.gtrk` 一字不动（出口）
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { aiDramaTracksEdited, layAiDramaTracks, type AiDramaLayPackage } from "../lib/ai-drama-lay";
// [adjust-lay-frame-domain D1] 顶层 video_rate 与 matrix lay / gtrk patch 同一读法：缺席 / 非正 / 非整数 ⇒ 报错退出零副作用
import { videoRateOf } from "../lib/gtrk-patch";
import { r3 } from "../lib/frame-domain";
import { assertGtrkV1, readGtrk, writeGtrkAtomic } from "../lib/gtrk-writeback";
import { classifyMaterialPath, normalizeRel, reportMaterialIntegrity, safeCheckMaterialIntegrity } from "../lib/material-integrity";
import { reportReprojection, reprojectDispatchWindows } from "../lib/reproject";
import { probeGeometry, type Geometry } from "../lib/media";
import { compareWalls, wallFromDeclared, wallFromProbe } from "../lib/clock-adapter";
import { log, routeLogsToStderr } from "../lib/log";
import { readJson } from "../lib/read-json";
import { resolveDeskProject, type DeskResolveVia } from "../lib/desk-locate";
import {
	buildReturnManifest,
	compareSwapGeometry,
	resolveShotFiles,
	swapRejectReason,
	NAMING_DEFAULT,
	type PackProbe,
	type ShotSpec,
} from "../lib/ai-drama-pack";

interface AiDramaOpts {
	project?: string;
	/** commander 将 `--package` 映射为单数属性；值本身由 collector 累加成数组。 */
	package?: string[];
	/** AI Drama Desk 的项目 id，可重复；由 desk-locate 解析成导出包目录后并入 package。 */
	deskProject?: string[];
	replaceAll?: boolean;
	json?: boolean;
	// ── pack ──
	beat?: string;
	dir?: string;
	dispatch?: string;
	map?: string;
	slug?: string;
	naming?: string;
	ext?: string;
	out?: string;
	// ── swap ──
	clip?: string;
	file?: string;
	backup?: boolean;
	dryRun?: boolean;
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
		.description(
			"AI 情景片段：lay 回填导出包新增独立 AI 视频轨 / pack 从自出的视频目录产出 return-v1 包 / swap 原地换素材不动时间线（纯本地、零模型调用、零计费）",
		)
		.option("--project <dir>", "口播工程产物目录（定位 gtrk/project.gtrk）")
		.option("--package <path>", "[lay] return-v1 导出目录或 manifest.json，可重复传", collectPath)
		.option(
			"--desk-project <id>",
			"[lay] AI Drama Desk 项目 id，可重复传；先问服务、服务没起再读落脚点解析出导出包（不扫盘）",
			collectPath,
		)
		.option("--replace-all", "[lay] 已铺 AI 轨在客户端被编辑过时仍重置重铺（会覆盖该 AI 轨上的手调）")
		.option("--beat <id>", "[pack] 要打包的 beat，如 B03")
		.option("--dir <path>", "[pack] 存放该 beat 各镜视频的目录")
		.option("--dispatch <path>", "[pack] 派单清单（缺省 <project>/split/dispatch.json）")
		.option("--map <path>", "[pack] 镜↔文件显式映射 JSON（形如 [{\"shotIndex\":1,\"file\":\"a.mp4\",\"suggestedSec\":2.2}]）")
		.option("--slug <s>", "[pack] 工程 slug（缺省取 --project 目录名的父级工程名）")
		.option("--naming <pattern>", `[pack] 命名约定，占位 {slug}/{beat}/{shot}/{ext}（缺省 ${NAMING_DEFAULT}）`)
		.option("--ext <e>", "[pack] 命名约定里的扩展名（缺省 mp4）")
		.option("-o, --out <dir>", "[pack] 包落盘目录（缺省就地写进 --dir）")
		.option("--clip <id>", "[swap] 要换素材的 clip_id")
		.option("--file <path>", "[swap] 新素材文件")
		.option("--no-backup", "[swap] 不备份原素材（缺省备份到 assets/.swap-backup/）")
		.option("--dry-run", "[pack/swap] 只报要做什么，零写盘")
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
	const manifest = await readJson(manifestPath, "AI 导出清单") as ReturnManifest;
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
	if (words.length !== 1 || !["lay", "pack", "swap"].includes(words[0]!)) {
		throw new Error(
			"用法：gtrk ai-drama <lay|pack|swap> …\n" +
				"  lay  --project <目录> --package <导出目录或manifest.json> [--package ...]\n" +
				"  pack --project <目录> --beat B03 --dir <视频目录> [--map <json>] [-o <包目录>]\n" +
				"  swap --project <目录> --clip <clip_id> --file <新素材>",
		);
	}
	if (words[0] === "pack") return runAiDramaPack(opts, deps);
	if (words[0] === "swap") return runAiDramaSwap(opts, deps);
	if (!opts.project) throw new Error("ai-drama lay 需要 --project <目录>");
	if (!opts.package?.length && !opts.deskProject?.length) {
		throw new Error("ai-drama lay 至少需要一个 --package <导出目录或manifest.json> 或 --desk-project <id>");
	}

	// 按 id 解析：先问服务、服务没起再读落脚点；两条都不通就带着出路抛错，**绝不扫盘**。
	// 解析出的路径与直接传入的 --package 汇成一个集合并按绝对路径去重，
	// 之后走的是同一条校验与写回路径——解析方式不放宽任何既有判据。
	const sources = new Map<string, { via: "byId" | "byPath"; resolvedVia?: DeskResolveVia; projectId?: string }>();
	for (const p of opts.package ?? []) sources.set(manifestPathOf(p), { via: "byPath" });
	for (const id of opts.deskProject ?? []) {
		const hit = await resolveDeskProject(id);
		const key = manifestPathOf(hit.packageDir);
		// 同一个包既按 id 指认又直接给了路径时只回填一次；标注保留「按 id」这一侧，
		// 因为排障时更想知道当刻连的是哪个部署。
		sources.set(key, { via: "byId", resolvedVia: hit.via, projectId: id });
		log.info(`--desk-project ${id} → ${hit.packageDir}（经${hit.via === "api" ? "工作台服务" : "落脚点"}解析）`);
	}
	const packageInputs = [...sources.keys()];

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

	const loaded = await Promise.all(packageInputs.map(readPackage));
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
	if (laid.summary.laidClips > 0 && laid.summary.laidTrack != null) {
		log.info(`需要贴合口播切点时，可先运行 gtrk patch snap --project <工程目录> --track video:${laid.summary.laidTrack} --audio <口播音频路径> --dry-run 检查，再确认执行；之后用 patch seal 补缝。回轨不会自动改动切点。`);
	}
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
		// 「怎么找到的」与「找到了什么」同等重要：不标出来就没法判断当刻连的是哪个部署
		package_sources: packageInputs.map((k) => {
			const s2 = sources.get(k)!;
			return { manifest: k, via: s2.via, ...(s2.resolvedVia ? { resolved_via: s2.resolvedVia } : {}), ...(s2.projectId ? { desk_project: s2.projectId } : {}) };
		}),
		// 时钟账面（add-cross-clock-adapter D3）：实测覆盖 / 回退自述计数 + manifest_mismatch 全量明细
		clock,
		...(integrity ? { integrity } : {}),
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

// ─────────────────────────── pack：产出 return-v1 包 ───────────────────────────

interface DispatchAiDramaItem {
	beat?: unknown;
	shot_count?: unknown;
	track_st?: unknown;
	track_ed?: unknown;
}

/**
 * 从派单里取这一 beat 的窗口与镜数。
 *
 * 为什么必须走派单而不是让用户手填：`trackSt/trackEd` 是**成片时间线**上的窗口，
 * 手填一个差 0.1s 的值，`lay` 会照着铺，错位要到出片才看得见。派单是这个窗口的唯一权威。
 */
async function readDispatchBeat(
	dispatchPath: string,
	beatId: string,
): Promise<{ trackSt: number; trackEd: number; shotCount: number }> {
	if (!existsSync(dispatchPath)) {
		throw new Error(`找不到派单清单：${dispatchPath}——先跑 gtrk split <拆分稿> --project <目录> 产出它`);
	}
	const d = (await readJson(dispatchPath, "派单清单")) as { ai_drama?: unknown };
	const queue = Array.isArray(d.ai_drama) ? (d.ai_drama as DispatchAiDramaItem[]) : [];
	const hit = queue.find((it) => String(it.beat ?? "").toUpperCase() === beatId.toUpperCase());
	if (!hit) {
		const known = queue.map((it) => String(it.beat ?? "?")).join("、") || "（空队列）";
		throw new Error(`派单里没有 ${beatId} 这一拍的 AI_DRAMA 条目；该队列现有：${known}`);
	}
	if (!finite(hit.track_st) || !finite(hit.track_ed) || hit.track_ed <= hit.track_st) {
		throw new Error(`派单 ${beatId}：track_st/track_ed 窗口无效（${String(hit.track_st)}–${String(hit.track_ed)}）`);
	}
	const shotCount = finite(hit.shot_count) && Number.isInteger(hit.shot_count) && hit.shot_count > 0 ? hit.shot_count : 0;
	if (!shotCount) throw new Error(`派单 ${beatId}：缺 shot_count，无从确定镜号集合——请用 --map 显式给出镜↔文件映射`);
	return { trackSt: hit.track_st, trackEd: hit.track_ed, shotCount };
}

/** 读显式映射。**MUST NOT 容忍半个**：给了 --map 就以它为准，缺字段即报错。 */
async function readShotMap(mapPath: string): Promise<ShotSpec[]> {
	const raw = (await readJson(mapPath, "镜↔文件映射")) as unknown;
	const arr = Array.isArray(raw) ? raw : (raw as { items?: unknown })?.items;
	if (!Array.isArray(arr) || arr.length === 0) {
		throw new Error(`${mapPath}：映射为空，应是 [{shotIndex, file, suggestedSec?}] 的数组`);
	}
	const seen = new Set<number>();
	return arr.map((r, i) => {
		const o = r as { shotIndex?: unknown; file?: unknown; suggestedSec?: unknown };
		const where = `${mapPath}[${i}]`;
		if (!finite(o.shotIndex) || !Number.isInteger(o.shotIndex) || o.shotIndex <= 0) throw new Error(`${where}：shotIndex 无效`);
		if (seen.has(o.shotIndex)) throw new Error(`${where}：shotIndex ${o.shotIndex} 重复`);
		seen.add(o.shotIndex);
		const file = safeLeafFile(o.file, where);
		if (o.suggestedSec !== undefined && (!finite(o.suggestedSec) || o.suggestedSec <= 0)) {
			throw new Error(`${where}：suggestedSec 给了就必须是正数`);
		}
		return { shotIndex: o.shotIndex, file, ...(finite(o.suggestedSec) ? { suggestedSec: o.suggestedSec } : {}) };
	});
}

/** 工程 slug：`<工程名>/project` 这种布局取上一级，否则取目录名本身。 */
function slugOfProject(baseDir: string): string {
	const leaf = basename(baseDir);
	const raw = leaf.toLowerCase() === "project" ? basename(dirname(baseDir)) : leaf;
	const s = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!s) throw new Error(`无法从 ${baseDir} 推出 slug（目录名里没有 ASCII 字符），请用 --slug 显式给出`);
	return s;
}

export async function runAiDramaPack(opts: AiDramaOpts, deps: AiDramaDeps = {}): Promise<Record<string, unknown>> {
	if (!opts.project) throw new Error("ai-drama pack 需要 --project <目录>");
	if (!opts.beat || !/^B\d+$/i.test(opts.beat)) throw new Error("ai-drama pack 需要 --beat <id>，形如 B03");
	if (!opts.dir) throw new Error("ai-drama pack 需要 --dir <视频目录>");
	const beatId = opts.beat.toUpperCase();
	const baseDir = resolve(opts.project);
	const videoDir = resolve(opts.dir);
	if (!existsSync(videoDir)) throw new Error(`视频目录不存在：${videoDir}`);
	const dispatchPath = opts.dispatch ? resolve(opts.dispatch) : join(baseDir, "split", "dispatch.json");
	const window = await readDispatchBeat(dispatchPath, beatId);
	// slug 缺省取**工程目录的父目录名**：`lay` 写出的 clip_id / material_id 以它为前缀，
	// 与 2026-09-20 真机手搓包同源（那条片子 slug=`coach`，来自工程名而非 `project` 这个固定子目录名）。
	const slug = opts.slug || slugOfProject(baseDir);

	// 镜↔文件：显式映射优先；否则按**声明的**命名约定拼名字。两条路都不扫盘（spec：MUST NOT 靠扫盘猜测）。
	const shots = opts.map
		? await readShotMap(resolve(opts.map))
		: resolveShotFiles({ naming: opts.naming, slug, beatId, shotCount: window.shotCount, ext: opts.ext });
	if (opts.map) {
		const extra = shots.filter((s) => s.shotIndex > window.shotCount);
		if (extra.length) {
			throw new Error(
				`映射里的 s${extra.map((s) => s.shotIndex).join("/s")} 超出派单声明的 ${window.shotCount} 镜——` +
					`要么派单该改（改拆分稿重跑 split），要么映射写错了；MUST NOT 产出一个与派单不一致的包`,
			);
		}
	}

	// 逐文件实测（MUST NOT 用声明值：lay 的越素材判据建在 measuredSec 上）
	const probe = deps.probe ?? probeGeometry;
	const probes = new Map<number, PackProbe>();
	const missing: string[] = [];
	const unprobed: string[] = [];
	for (const s of shots) {
		const abs = join(videoDir, s.file);
		if (!existsSync(abs)) {
			missing.push(`${beatId} s${s.shotIndex} → ${s.file}`);
			continue;
		}
		try {
			const g = probe(abs);
			if (!(g.duration > 0)) throw new Error(`ffprobe 时长无效（${g.duration}）`);
			probes.set(s.shotIndex, { width: g.width, height: g.height, fps: g.fps, duration: g.duration });
		} catch (e) {
			unprobed.push(`${beatId} s${s.shotIndex}（${e instanceof Error ? e.message : String(e)}）`);
		}
	}
	if (missing.length) {
		throw new Error(
			`目录里缺 ${missing.length} 个镜的视频：${missing.slice(0, 5).join("、")}${missing.length > 5 ? " 等" : ""}——` +
				`已拒绝产出不完整的包。命名约定是 ${opts.naming || NAMING_DEFAULT}；文件名不合约定请用 --map 显式给出映射。`,
		);
	}
	// 实测不了 ⇒ **拒绝落盘**。这里与 `lay` 的处置刻意不同：lay 是「包已经存在、沿用自述总比不铺强」，
	// pack 是「这个包由我产出」——产一个时长靠猜的包等于把错误固化进契约。
	if (unprobed.length) {
		throw new Error(
			`有 ${unprobed.length} 个镜实测失败：${unprobed.slice(0, 3).join("、")}${unprobed.length > 3 ? " 等" : ""}——` +
				`产出的包里 measuredSec 必须是实测值（lay 的越素材判据建在它上面），已拒绝落盘。装好 ffmpeg 后重跑（gtrk doctor 可查）。`,
		);
	}

	const manifest = buildReturnManifest({ slug, beatId, trackSt: window.trackSt, trackEd: window.trackEd, shots, probes });
	const outDir = opts.out ? resolve(opts.out) : videoDir;
	const manifestPath = join(outDir, "manifest.json");

	if (opts.dryRun) {
		log.ok(`[dry-run] ${beatId}：${manifest.items.length} 镜、窗口 ${manifest.trackSt}–${manifest.trackEd}s，将写 ${manifestPath}`);
		const dryResult = { ok: true, mode: "pack", dry_run: true, beat: beatId, slug, manifest_path: manifestPath, manifest };
		if (opts.json) console.log(JSON.stringify(dryResult));
		return dryResult;
	}

	await mkdir(outDir, { recursive: true });
	// 包要**自包含**：manifest 里的 file 是叶名、相对 manifest 所在目录解析，
	// 所以 -o 指向别处时必须把视频也带过去，否则产出的是一个读不动的包。
	let copied = 0;
	if (outDir !== videoDir) {
		for (const it of manifest.items) {
			await copyFile(join(videoDir, it.file), join(outDir, it.file));
			copied++;
		}
	}

	// 落盘前自检：先写临时名 → 用 `lay` **同一个** readPackage 校验 → 通过才 rename 成 manifest.json。
	// 「不合规不落盘」这句话必须由同一套校验兑现；另写一份校验迟早与 lay 分叉。
	const tmpPath = join(outDir, `.manifest.pack-${process.pid}.json`);
	await writeFile(tmpPath, JSON.stringify(manifest, null, 1));
	try {
		await readPackage(tmpPath);
	} catch (e) {
		await rm(tmpPath, { force: true });
		throw new Error(`自检未过，已放弃落盘：${e instanceof Error ? e.message : String(e)}`);
	}
	await rename(tmpPath, manifestPath);

	log.ok(`已产出 return-v1 包：${beatId} / ${manifest.items.length} 镜 → ${manifestPath}`);
	log.info(
		`窗口 ${manifest.trackSt}–${manifest.trackEd}s；` +
			(opts.map ? "镜↔文件按 --map 显式映射" : `镜↔文件按命名约定 ${opts.naming || NAMING_DEFAULT}`) +
			(copied ? `；已复制 ${copied} 个视频进包目录` : "") +
			`。下一步：gtrk ai-drama lay --project ${opts.project} --package ${outDir}`,
	);
	const result = {
		ok: true,
		mode: "pack",
		dry_run: false,
		beat: beatId,
		slug,
		dispatch: dispatchPath,
		manifest_path: manifestPath,
		copied,
		mapping: opts.map ? "explicit_map" : "naming_convention",
		manifest,
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}

// ─────────────────────────── swap：原地换素材 ───────────────────────────

/** 在 .gtrk 里按 clip_id 找到它的素材记录与磁盘路径。 */
function locateClipMaterial(
	gtrk: Record<string, unknown>,
	clipId: string,
	gtrkDir: string,
): { materialId: string; abs: string; declared: string } {
	// ⚠️ 轨键是 `video_track` / `audio_track`（单数）、片段键是 `track_timeline`——
	// 与 `gtrk-invariants` 的 WRITE_SCOPES 同一读法。写成 `video_tracks` / `clips`
	// 不会报错，只会**一个 clip 都找不到**，表现成「工程里没有这个 clip」。
	const tracks = Array.isArray(gtrk.video_track) ? (gtrk.video_track as Array<Record<string, unknown>>) : [];
	const audio = Array.isArray(gtrk.audio_track) ? (gtrk.audio_track as Array<Record<string, unknown>>) : [];
	let materialId: string | null = null;
	for (const t of [...tracks, ...audio]) {
		const clips = Array.isArray(t.track_timeline) ? (t.track_timeline as Array<Record<string, unknown>>) : [];
		const hit = clips.find((c) => String(c.clip_id ?? "") === clipId);
		if (hit) {
			materialId = hit.material == null ? null : String(hit.material);
			break;
		}
	}
	if (materialId === null) throw new Error(`工程里没有 clip_id=${clipId}（或它没有绑定素材）`);
	const materials = Array.isArray(gtrk.materials) ? (gtrk.materials as Array<Record<string, unknown>>) : [];
	const mat = materials.find((m) => String(m.id ?? "") === materialId);
	if (!mat) throw new Error(`clip ${clipId} 指向的素材 ${materialId} 不在 materials 里（工程结构已损坏，swap 拒绝介入）`);
	const { kind, path } = classifyMaterialPath(mat.path);
	if (kind === "none") throw new Error(`素材 ${materialId} 没有 path，无从替换`);
	if (kind === "remote") throw new Error(`素材 ${materialId} 是远端地址（${path}），swap 只换本地文件`);
	const abs = kind === "relative" ? resolve(gtrkDir, normalizeRel(path)) : path;
	if (!existsSync(abs)) throw new Error(`素材文件不在盘上：${abs}——先修好关联再换`);
	return { materialId, abs, declared: path };
}

export async function runAiDramaSwap(opts: AiDramaOpts, deps: AiDramaDeps = {}): Promise<Record<string, unknown>> {
	if (!opts.project) throw new Error("ai-drama swap 需要 --project <目录>");
	if (!opts.clip) throw new Error("ai-drama swap 需要 --clip <clip_id>");
	if (!opts.file) throw new Error("ai-drama swap 需要 --file <新素材>");
	const newFile = resolve(opts.file);
	if (!existsSync(newFile)) throw new Error(`新素材不存在：${newFile}`);

	const baseDir = resolve(opts.project);
	const gtrkPath = locateGtrk(baseDir);
	const gtrkDir = dirname(gtrkPath);
	// ⚠️ 只**读** .gtrk 找素材落点。本命令自始至终 MUST NOT 写它——
	// 「.gtrk 逐字节不变」是 swap 存在的全部理由（重跑 lay 会冲掉已补的缝与切点调整）。
	const { gtrk } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);
	const target = locateClipMaterial(gtrk, opts.clip, gtrkDir);

	const probe = deps.probe ?? probeGeometry;
	const geoOf = (p: string, tag: string): PackProbe => {
		const g = probe(p);
		if (!(g.duration > 0)) throw new Error(`${tag} 实测时长无效（${g.duration}）：${p}`);
		return { width: g.width, height: g.height, fps: g.fps, duration: g.duration };
	};
	const from = geoOf(target.abs, "原素材");
	const to = geoOf(newFile, "新素材");
	const diffs = compareSwapGeometry(from, to);
	if (diffs.length) throw new Error(swapRejectReason(opts.clip, diffs));

	const backup = opts.backup !== false;
	// 备份落在 assets/.swap-backup/ 而不是原地加后缀：assets/ai-drama/ 下多出 .bak 文件
	// 会被素材自检与人眼同时看成「工程里多了个片段」。带时间戳 ⇒ 连换多次不互相覆盖。
	const backupPath = backup
		? join(gtrkDir, "assets", ".swap-backup", `${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(target.abs)}`)
		: null;

	if (opts.dryRun) {
		log.ok(`[dry-run] ${opts.clip}：结构等价（${to.width}×${to.height} @${r3(to.fps)}fps / ${r3(to.duration)}s），可替换`);
		log.info(`将覆盖 ${target.abs}${backupPath ? `，原文件备份到 ${backupPath}` : "（--no-backup：不备份）"}`);
		const dryResult = {
			ok: true,
			mode: "swap",
			dry_run: true,
			project: baseDir,
			gtrk: gtrkPath,
			clip: opts.clip,
			material: target.materialId,
			target: target.abs,
			source: newFile,
			backup: backupPath,
			geometry: { from, to },
		};
		if (opts.json) console.log(JSON.stringify(dryResult));
		return dryResult;
	}

	if (backupPath) {
		await mkdir(dirname(backupPath), { recursive: true });
		await copyFile(target.abs, backupPath);
	}
	await copyFile(newFile, target.abs);

	log.ok(`已替换 ${opts.clip} 的素材：${basename(newFile)} → ${target.declared}`);
	log.info(
		`结构等价已断言（时长 ${r3(to.duration)}s / ${to.width}×${to.height} / ${r3(to.fps)}fps）；` +
			`.gtrk 一字未动，时间线上的切点与缝隙状态完全保持。` +
			(backupPath ? `原文件已备份到 ${backupPath}` : "未备份（--no-backup）"),
	);
	const result = {
		ok: true,
		mode: "swap",
		dry_run: false,
		project: baseDir,
		gtrk: gtrkPath,
		clip: opts.clip,
		material: target.materialId,
		target: target.abs,
		source: newFile,
		backup: backupPath,
		geometry: { from, to },
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}
