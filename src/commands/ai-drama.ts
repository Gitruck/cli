/** gtrk ai-drama lay —— 消费 AI Drama Desk return-v1 导出包，确定性回填独立 AI 视频轨。 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { aiDramaTracksEdited, layAiDramaTracks, type AiDramaLayPackage } from "../lib/ai-drama-lay";
import { assertGtrkV1, readGtrk, writeGtrkAtomic } from "../lib/gtrk-writeback";
import { reportMaterialIntegrity, safeCheckMaterialIntegrity } from "../lib/material-integrity";
import { reportReprojection, reprojectDispatchWindows } from "../lib/reproject";
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

const collectPath = (v: string, prev: string[] | undefined): string[] => [...(prev ?? []), v];
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function registerAiDrama(program: Command): void {
	program
		.command("ai-drama [words...]")
		.description("AI 情景片段回填：消费 AI Drama Desk return-v1 导出包，新增一条独立 AI 视频轨（纯本地、零模型调用、零计费）")
		.option("--project <dir>", "口播工程产物目录（定位 gtrk/project.gtrk）")
		.option("--package <path>", "return-v1 导出目录或 manifest.json，可重复传", collectPath)
		.option("--replace-all", "已铺 AI 轨在客户端被编辑过时仍重置重铺（会覆盖该 AI 轨上的手调）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[] | undefined, opts: AiDramaOpts) => {
			await runAiDrama(words ?? [], opts);
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

export async function runAiDrama(words: string[], opts: AiDramaOpts): Promise<Record<string, unknown>> {
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

	for (const pkg of packages) {
		const src = loaded.find((p) => p.pkg.slug === pkg.slug && p.pkg.beatId === pkg.beatId)!;
		const assetDir = join(gtrkDir, "assets", "ai-drama", pkg.slug);
		await mkdir(assetDir, { recursive: true });
		for (const item of pkg.items) await copyFile(join(src.exportDir, item.file), join(assetDir, item.file));
	}

	const generatedAt = new Date().toISOString();
	const laid = layAiDramaTracks({ gtrk, packages, generatedAt });
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
		...(integrity ? { integrity } : {}),
	};
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}
