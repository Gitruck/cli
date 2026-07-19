/**
 * MAD 一键剪 MAD 编排（add-tool-mad，tool-mad spec）。tool.ts 的 local 型 mad handler。
 *
 * 流水线：扫文件夹（probeGeometry）→ 画布多数决 → 数据获取（manifest→缓存）→ 规则选窗 →
 * IR 按需拉取 → BGM/beat 三级降级 → madJsx 组装 → 落 .jsx + result.json + 完成话术。
 * 无 Key 承诺（D10）：无 --bgm 全程只走免鉴权数据面，不触需鉴权接口、不要求 Key、零计费。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import type { CloudConfig } from "../config";
import { loadConfig as realLoadConfig } from "../config";
import { submitTask } from "../cloud";
import { uploadCached, invalidateUpload } from "../upload-cache";
import { pollToolTask } from "../tool-runner";
import { probeDuration } from "../media";
import { madJsx, type MadWindow, type FootageMap, type BeatMarker } from "../convert/ir_to_jsx";
import { scanFolder, masterCanvas, type ProbeFn } from "./scan";
import { selectWindows } from "./selector";
import { fixedRhythm, beatQuantized, MIN_WIN, type BeatAnalysis } from "./beat";
import { ensureMadData, madCacheDir, type DataDeps } from "./data";
import { makeIrLoader, type IRProject } from "./pool";
import { analyzeBgm, type BeatCloudDeps } from "./cloud-beat";
import type { DegradeLevel } from "./types";

/** 产物 header 定稿（D9；{version}/{generated_at} 运行时填充）。CLI 自有产物挂 gtrk/同合云品牌。 */
export function madHeader(version: string, generatedAt: string): string {
	return [
		"/*═══════════════════════════════════════════════",
		"  MAD 一键工程 — 由 gtrk 自动生成",
		"  ───────────────────────────────────────────────",
		"  用法：After Effects  文件 › 脚本 › 运行脚本文件…  选择本文件",
		"  运行后自动生成母合成：素材已按技法段填入各素材位，",
		"  彩色占位块为素材位，可在合成里替换或微调。",
		"",
		"  生成工具：gtrk tool mad · 同合云 gitruck",
		"  了解一键成片流程：https://cloud.ai-mcn.tv/cli",
		`  版本 ${version} · 生成于 ${generatedAt}`,
		"═══════════════════════════════════════════════*/",
	].join("\n");
}

/** 无 AE 兜底话术（仅给「装 AE 2020+ 跑脚本」一条路，不提 .amproj/Alight Motion）。 */
export function completionMessage(jsxPath: string, level: DegradeLevel): string {
	const beat = level === 1 ? "已按 BGM downbeat 卡点" : level === 2 ? "BGM 已入轨、按固定节奏切窗" : "按固定节奏切窗";
	return [
		`工程文件已生成：${jsxPath}（${beat}）`,
		"用法：装 After Effects 2020+ 后，文件 › 脚本 › 运行脚本文件… 选它，30 秒重建整条时间线。",
	].join("\n");
}

export interface MadOpts {
	bgm?: string;
	duration?: number;
	seed?: number;
	refresh?: boolean;
	out?: string;
	ffmpegPath?: string;
	json?: boolean;
}

export interface RunMadDeps {
	fetchFn?: typeof fetch;
	cacheRoot?: string;
	loadConfig?: () => CloudConfig;
	probeGeometry?: ProbeFn;
	probeDurationFn?: (p: string, ff?: string) => number;
	beatCloud?: BeatCloudDeps;
	now?: () => Date;
	cliVersion?: string;
	warn?: (m: string) => void;
	emitBilling?: (hint: string) => void;
}

export interface MadResult {
	ok: boolean;
	tool: "mad";
	outDir: string;
	files: string[];
	seed: number;
	dataVersion: number;
	degradeLevel: DegradeLevel;
	techniques: { uid: string; pid: string; cat: string; t0: number; t1: number }[];
}

/** 收集 IR 里的 image/video 素材位 layerId（递归 group，保序）。 */
function collectSlotIds(ir: IRProject): string[] {
	const ids: string[] = [];
	const walk = (layers: unknown[]) => {
		for (const l of layers) {
			const ly = l as { id?: string; type?: string; children?: unknown[] };
			if (ly.type === "image" || ly.type === "video") ids.push(String(ly.id ?? ""));
			if (ly.type === "group" && Array.isArray(ly.children)) walk(ly.children);
		}
	};
	walk(ir.layers ?? []);
	return ids.filter((x) => x);
}

const SLOT_STAGGER = 0.3; // 窗内各 slot srcOffset 错开（秒）

function timestamp(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(now.getFullYear() % 100)}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * mad 主编排。deps 缺省=真实实现；测试注入。
 */
export async function runMad(inputArg: string | undefined, opts: MadOpts, deps: RunMadDeps = {}): Promise<MadResult> {
	const warn = deps.warn ?? ((m: string) => process.stderr.write(`\x1b[2m   ${m}\x1b[0m\n`));
	const emitBilling =
		deps.emitBilling ?? ((h: string) => process.stderr.write(`\x1b[33m⚠️  计费提示：${h}\x1b[0m\n`));
	const now = (deps.now ?? (() => new Date()))();
	const fetchFn = deps.fetchFn ?? fetch;
	const probeDur = deps.probeDurationFn ?? probeDuration;

	// ① 扫描素材文件夹
	if (!inputArg) throw new Error("用法：gtrk tool mad <素材文件夹> [--bgm 歌.mp3]");
	const dirAbs = resolve(inputArg);
	if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
		throw new Error(`素材文件夹不存在或不是目录：${dirAbs}`);
	}
	const { videos, orientation, skipped } = scanFolder(dirAbs, {
		ffmpegPath: opts.ffmpegPath,
		probe: deps.probeGeometry,
		warn,
	});
	for (const s of skipped) void s;
	const master = masterCanvas(orientation);

	// ② 数据获取（manifest → 缓存）
	const dataDeps: DataDeps = { fetchFn, cacheRoot: deps.cacheRoot ?? madCacheDir(), warn };
	const data = await ensureMadData({ refresh: opts.refresh }, dataDeps);

	// ④ IR 装载器（离线只吃缓存分片）
	const irLoader = makeIrLoader(data.assetsBase, data.verDir, data.online, { fetchFn, warn });

	// ③ 规则选窗（带种子可复现）；离线时只从已缓存分片覆盖的池条目中抽取（保证离线出片）
	const durationSec = opts.duration && opts.duration > 0 ? opts.duration : 20;
	const seed = opts.seed && Number.isFinite(opts.seed) ? opts.seed : Math.floor(Math.random() * 2 ** 31);
	warn(`选窗种子 seed=${seed}（复现加 --seed ${seed}）`);
	const selectablePool = data.online ? data.pool : data.pool.filter((e) => irLoader.shardCached(e.shard));
	if (!data.online && selectablePool.length === 0) {
		throw new Error("当前离线且无已缓存的技法数据分片。请连网重跑首拉，或加 --refresh 预热。");
	}
	const chosen = selectWindows({ pool: selectablePool, videos, durationSec, orientation, seed });
	if (chosen.length === 0) {
		throw new Error("技法池为空或无可用条目（数据版本可能异常，可加 --refresh 重拉）。");
	}
	const irs: IRProject[] = [];
	for (const c of chosen) irs.push(await irLoader.getIr(c.entry));

	// ⑤ BGM / beat 三级降级
	let level: DegradeLevel = 3;
	let analysis: BeatAnalysis | null = null;
	let bgmForTrack: string | undefined;
	const bgmAbs = opts.bgm ? resolve(opts.bgm) : undefined;
	if (bgmAbs) {
		let dur = -1;
		try {
			dur = probeDur(bgmAbs, opts.ffmpegPath);
		} catch {
			dur = -1;
		}
		if (!(dur > 0)) {
			warn(`BGM 无法读取（ffprobe 校验失败），按无 BGM 固定节奏出片：${bgmAbs}`);
			level = 3;
		} else {
			let cfg: CloudConfig | null = null;
			try {
				cfg = (deps.loadConfig ?? realLoadConfig)();
			} catch {
				cfg = null;
			}
			if (!cfg) {
				warn("未配置 API Key，无法解锁 BGM 卡点。跑 `gtrk init` 配置后可卡点；本次 BGM 已入轨、按固定节奏出片。");
				level = 2;
				bgmForTrack = bgmAbs;
			} else {
				emitBilling("BGM 卡点将调用一次云端节拍分析（audio_music_analyze），按现行价计费。");
				const beatCloud: BeatCloudDeps =
					deps.beatCloud ?? { uploadCached, invalidateUpload, submitTask, pollToolTask };
				try {
					analysis = await analyzeBgm(cfg, bgmAbs, beatCloud);
					level = 1;
					bgmForTrack = bgmAbs;
				} catch (e) {
					warn(`BGM 云端分析失败（${e instanceof Error ? e.message : String(e)}），BGM 已入轨、切点回退固定节奏`);
					level = 2;
					bgmForTrack = bgmAbs;
				}
			}
		}
	}

	// ⑥ 切点规划
	const natLens = chosen.map((c) => Math.max(MIN_WIN, c.entry.t1 - c.entry.t0));
	let placements: { dropAt: number; outLen: number }[];
	let markers: BeatMarker[] = [];
	if (level === 1 && analysis) {
		const q = beatQuantized(natLens, analysis);
		placements = q.plan.placements;
		markers = q.plan.markers;
		if (q.level === 2) {
			warn("BGM 无有效节拍（beats/downbeats 均空），切点回退固定节奏。");
			level = 2;
			markers = [];
		}
	} else {
		placements = fixedRhythm(natLens).placements;
	}

	// ⑦ 组装 MadWindow[]
	const windows: MadWindow[] = chosen.map((c, i) => {
		const ir = irs[i];
		const slotIds = collectSlotIds(ir);
		const footage: FootageMap = {};
		const vidDur = c.video.duration || 0;
		const winLen = Math.max(MIN_WIN, c.entry.t1 - c.entry.t0);
		slotIds.forEach((lid, idx) => {
			let off = c.srcOffsetBase + idx * SLOT_STAGGER;
			const room = Math.max(0, vidDur - winLen);
			if (room > 0) off = off % room;
			else off = 0;
			footage[lid] = { path: c.video.path, srcOffset: Math.round(off * 1000) / 1000 };
		});
		return {
			ir: ir as unknown as MadWindow["ir"],
			uid: c.entry.uid,
			seq: i,
			t0: c.entry.t0,
			t1: c.entry.t1,
			dropAt: placements[i].dropAt,
			outLen: placements[i].outLen,
			footage,
		};
	});

	// ⑧ 生成 JSX
	const version = deps.cliVersion ?? "";
	const header = madHeader(version, now.toISOString());
	const bgm = level <= 2 && bgmForTrack ? { path: bgmForTrack, markers } : undefined;
	const { jsx } = madJsx({ master, windows, header, bgm });

	// ⑨ 落盘
	const outDir = opts.out ? resolve(opts.out) : join(process.cwd(), `mad-${timestamp(now)}`);
	await mkdir(outDir, { recursive: true });
	const jsxPath = join(outDir, "mad.jsx");
	await writeFile(jsxPath, jsx);
	const result: MadResult = {
		ok: true,
		tool: "mad",
		outDir,
		files: [jsxPath],
		seed,
		dataVersion: data.version,
		degradeLevel: level,
		techniques: chosen.map((c) => ({ uid: c.entry.uid, pid: c.entry.pid, cat: c.entry.cat, t0: c.entry.t0, t1: c.entry.t1 })),
	};
	await writeFile(join(outDir, "result.json"), JSON.stringify({ ...result, finishedAt: now.toISOString() }, null, 2));

	// ⑩ 完成话术
	warn(completionMessage(jsxPath, level));
	return result;
}
