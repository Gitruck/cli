/**
 * gtrk doctor —— 一键体检：配置 / 云端连通 / 剪映目录 / 运行时是否就绪。
 * 排障入口（对标飞书 lark-cli 的 auth check）。非交互、只读，不改任何配置。
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readUserConfig, configPath } from "../lib/user-config";
import { resolveApiBase } from "../lib/config";
import { columnsDir } from "../lib/column-config";
import { resolveJianyingDraftDir } from "../lib/jianying";
import { resolveFfmpeg, probeCapabilities } from "../lib/ffmpeg";
import { skillFreshnessDoctorRow } from "../lib/skill-freshness";
import { currentVersion, latestVersion, cmpSemver } from "../lib/version";
import { commandReachDoctorRow } from "../lib/self-install";
import { crashSwitchState, CRASH_REPORT_ENV } from "../lib/crash-report";
import { catalogSnapshotPath, primeCatalog, readSnapshot as readCatalogSnapshot } from "../lib/enum-catalog";
import { readGtrk, assertGtrkV1 } from "../lib/gtrk-writeback";
import { collectWriteViolations } from "../lib/gtrk-invariants";
import { checkMaterialIntegrity } from "../lib/material-integrity";
import { buildHealthReport, trackHealth, type HealthReport, type TrackHealth } from "../lib/project-health";

export function registerDoctor(program: Command): void {
	program
		.command("doctor")
		.description("体检：环境（配置 / 云端连通 / 剪映目录 / 运行时）；给 --project 则改查工程结构")
		.option("--refresh-catalog", "强制重拉服务端枚举清单（无视 24h 新鲜期）")
		.option("--project <dir>", "改查**工程结构**：轨级缝隙/重叠、素材就位、时码恒等式、顶层 duration 与帧率")
		.option("--json", "机读模式（仅 --project 体检）：stdout 只输出结果 JSON")
		.action(async (opts: { refreshCatalog?: boolean; project?: string; json?: boolean }) => {
			// --project 缺席时逐字走既有路径（spec：既有行为 SHALL 逐字不变）
			if (opts.project) {
				await runProjectHealth(opts.project, { json: opts.json === true });
				return;
			}
			await runDoctor({ refreshCatalog: opts.refreshCatalog === true });
		});
}

/** 快照年龄的人读化。只给量级——精确到分钟对排障没有增量价值。 */
function catalogAge(ms: number): string {
	const h = Math.floor(ms / 3_600_000);
	if (h < 1) return "不到 1 小时";
	if (h < 48) return `${h} 小时`;
	return `${Math.floor(h / 24)} 天`;
}

type Status = "ok" | "warn" | "fail";
const MARK: Record<Status, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };

interface Row {
	name: string;
	status: Status;
	detail: string;
}

export async function runDoctor(opts: { refreshCatalog?: boolean } = {}): Promise<boolean> {
	const rows: Row[] = [];

	// 后台查最新版（与下面的云端连通检查并行，不额外拖慢体检）
	const latestP = latestVersion(5000).catch(() => null);

	const bunVer = (process.versions as { bun?: string }).bun;
	rows.push({
		name: "运行时",
		status: "ok",
		detail: bunVer ? `bun ${bunVer}` : `node ${process.version}`,
	});

	// 命令可达（change add-gtrk-command-availability）：判据是**持久** PATH（注册表），不是启动本进程的终端给的 PATH——
	// 从一个碰巧带 npm 目录的终端里跑会假绿。POSIX 无持久 PATH 可读，detail 注明「按当前 shell」。
	rows.push(commandReachDoctorRow());

	const uc = readUserConfig();
	const apiKey = (process.env.GITRUCK_API_KEY ?? uc.apiKey ?? "").trim();
	// ⚠️ 走 config.ts 的单一解析口，MUST NOT 在这里再抄一份三行
	//（change link-enum-catalog-cli §1.1：两份会分头漂，而「我在打哪个 base」是排障第一问）。
	const apiBase = resolveApiBase();
	rows.push({
		name: "API Key",
		status: apiKey ? "ok" : "fail",
		detail: apiKey
			? `已配（${apiKey.slice(0, 6)}…，来源 ${process.env.GITRUCK_API_KEY ? "环境变量" : "gtrk init"}）`
			: "未配 —— 跑 gtrk init",
	});
	rows.push({ name: "API 根地址", status: "ok", detail: apiBase });

	// 云端连通 + 鉴权：实打一发受保护接口（POST /user/get_user_info 带 Authorization）。
	// 比 GET 根路径（永远 404、误导人）有意义——拿到 code=200 才算真通且 Key 有效。
	let apiStatus: Status = "warn";
	let apiDetail = "跳过（未配 Key）";
	if (apiKey) {
		try {
			const res = await fetch(`${apiBase}/user/get_user_info`, {
				method: "POST",
				headers: { accept: "application/json", Authorization: apiKey },
				body: "",
				signal: AbortSignal.timeout(8000),
			});
			const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
			if (data.code === 200) {
				apiStatus = "ok";
				apiDetail = "可达，鉴权通过";
			} else {
				apiStatus = "fail";
				apiDetail = `可达，但鉴权失败（code=${data.code ?? res.status}${data.msg ? `，${data.msg}` : ""}）—— 检查 API Key`;
			}
		} catch (e) {
			apiStatus = "fail";
			apiDetail = `连不上：${e instanceof Error ? e.message : String(e)}`;
		}
	}
	rows.push({ name: "云端连通 + 鉴权", status: apiStatus, detail: apiDetail });

	const draftDir = resolveJianyingDraftDir(undefined);
	const draftOk = !!draftDir && existsSync(draftDir);
	rows.push({
		name: "剪映草稿目录",
		status: draftOk ? "ok" : "warn",
		detail: draftOk ? (draftDir as string) : "未配/未探到 —— 要剪映直开就跑 gtrk init 或加 --jianying-draft-dir",
	});

	rows.push({
		name: "配置文件",
		status: existsSync(configPath()) ? "ok" : "warn",
		detail: existsSync(configPath()) ? configPath() : `未生成 —— 跑 gtrk init（${configPath()}）`,
	});

	// 栏目（轻引导，恒 ok 不挡路）：不建栏目就用默认"厨房"，建了显示当前生效栏目
	const col = uc.defaultColumn;
	const colFile = col ? join(columnsDir(), `${col}.json`) : undefined;
	rows.push({
		name: "当前栏目",
		status: "ok",
		detail: col
			? `${col}${colFile && existsSync(colFile) ? `（${colFile}）` : `（⚠ 配置文件缺失：${colFile}，将回落内置默认）`}`
			: "内置默认 —— 想建自己栏目的风格体系，跑 /gtrk-style-maker（不建也能直接用默认）",
	});

	// 枚举清单（link-enum-catalog-cli §2.6）：三态如实呈现，**恒 ok 不挡路**。
	// ⚠️ 拿不到清单**不是故障**——那条路径上 CLI 会跳过本地枚举校验、直接交服务端裁决，
	// 功能完全可用，只是少了「上传前就告诉你传错了」这一层。判 fail 会误导用户去修一个不存在的问题。
	await primeCatalog(opts.refreshCatalog ? { refresh: true } : {});
	const catalogSnap = readCatalogSnapshot();
	rows.push({
		name: "枚举清单",
		status: "ok",
		detail: catalogSnap
			? `v${catalogSnap.catalog_version.slice(0, 8)}｜${catalogAge(Date.now() - catalogSnap.fetched_at)}前拉取｜${catalogSnapshotPath()}`
			: "无快照 —— 本地跳过枚举校验，取值由服务端裁决（联网后自动拉；`--refresh-catalog` 可立刻拉）",
	});

	// 崩溃自动上报（link-client-error-report-cli）：三态如实呈现，**恒 ok 不挡路**——
	// 关掉它是用户的正当选择，不是「体检不通过」。
	const crashState = crashSwitchState();
	rows.push({
		name: "崩溃自动上报",
		status: "ok",
		detail:
			crashState === "on"
				? `开（仅错误消息与堆栈；关闭：gtrk init --no-crash-report 或 ${CRASH_REPORT_ENV}=0）`
				: crashState === "off-env"
					? `关（来源 环境变量 ${CRASH_REPORT_ENV}=0；它优先于配置文件）`
					: "关（来源 gtrk init --no-crash-report 写下的 crashReport:false）",
	});

	// skill 新鲜度（fix-skill-install-staleness）：已装 skill 与包内正本是否同步。
	// 恒 ok/warn 不挡路；未装过（无 manifest）时判不出，如实说而不是装作没事。
	rows.push(skillFreshnessDoctorRow());

	// 本地渲染工具（ffmpeg）：判 warn 不判 fail —— 只出工程文件、不本地渲染的用户不受阻
	const ff = resolveFfmpeg();
	if (ff) {
		let hasX264 = false;
		let ver = "";
		try {
			const cap = probeCapabilities(ff);
			hasX264 = cap.hasLibx264;
			ver = cap.version.replace(/^ffmpeg version\s*/i, "v");
		} catch {
			/* 探测失败按未知能力处理 */
		}
		rows.push({
			name: "本地渲染 (ffmpeg)",
			status: hasX264 ? "ok" : "warn",
			detail: hasX264
				? `就绪（来源 ${ff.source}${ver ? `，${ver.split(/\s/)[0]}` : ""}）`
				: `找到 ffmpeg（${ff.source}）但缺 libx264 —— 本地渲染需换含 libx264 的构建`,
		});
	} else {
		rows.push({
			name: "本地渲染 (ffmpeg)",
			status: "warn",
			detail: "未找到 —— 只出工程文件可忽略；要本地渲染成片，让 agent 装 ffmpeg/ffprobe 到 ~/.gitruck/ffmpeg 或 --ffmpeg-path",
		});
	}

	// CLI 版本（best-effort，查不到就只显当前版本、不判 fail；有新版给升级提示、但不致 doctor 失败）
	const cur = currentVersion();
	const latest = await latestP;
	rows.splice(1, 0, {
		name: "CLI 版本",
		status: latest && cmpSemver(latest, cur) > 0 ? "warn" : "ok",
		detail:
			latest && cmpSemver(latest, cur) > 0
				? `v${cur} —— 有新版 v${latest}，跑 gtrk upgrade 升级`
				: latest
					? `v${cur}（已是最新）`
					: `v${cur}`,
	});

	console.log("\ngtrk 体检：\n");
	for (const r of rows) console.log(`  ${MARK[r.status]} ${r.name}：${r.detail}`);
	const failed = rows.some((r) => r.status === "fail");
	console.log(failed ? "\n有项不通，按提示处理后再开剪。\n" : "\n一切就绪，可以开剪。\n");
	if (failed) process.exitCode = 1;
	return !failed;
}

// ───────────────────────── 工程结构体检（add-project-health-check）─────────────────────────

/** 与 `patch` / `split` 同一条候选序。 */
function locateProjectGtrk(baseDir: string): string {
	const abs = resolve(baseDir);
	const cands = [join(abs, "gtrk", "project.gtrk"), join(abs, "project.gtrk"), abs];
	const hit = cands.find((c) => existsSync(c) && c.toLowerCase().endsWith(".gtrk"));
	if (!hit) throw new Error(`找不到工程文件：${join(abs, "gtrk", "project.gtrk")}`);
	return hit;
}

/** 三类轨全收，标签与 `--track` 的寻址串同形（`video:0`），照着报出来就能直接去 patch。 */
function allTracks(gtrk: Record<string, unknown>): TrackHealth[] {
	const out: TrackHealth[] = [];
	// 视觉底轨 = **有片段的 video 轨里号最小的那条**。只有它该连续（见 TrackHealth.continuous）。
	// ⚠️ MUST NOT 直接取 video_track[0]：客户端重存后轨序会漂，号才是稳的；
	//    也 MUST NOT 取空轨——空的那条不是底轨，是占位。
	const videos = Array.isArray(gtrk.video_track) ? (gtrk.video_track as Array<Record<string, unknown>>) : [];
	const bedIndex = videos
		.filter((t) => (Array.isArray(t.track_timeline) ? t.track_timeline.length : 0) > 0)
		.map((t) => (typeof t.track_index === "number" ? t.track_index : Number.POSITIVE_INFINITY))
		.sort((a, b) => a - b)[0];
	for (const key of ["video_track", "audio_track", "beat_track"] as const) {
		const arr = Array.isArray(gtrk[key]) ? (gtrk[key] as Array<Record<string, unknown>>) : [];
		for (const t of arr) {
			const idx = typeof t.track_index === "number" ? t.track_index : out.length;
			out.push(trackHealth(`${key.replace("_track", "")}:${idx}`, t, key === "video_track" && idx === bedIndex));
		}
	}
	return out;
}

const HEALTH_MARK: Record<string, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };

export async function runProjectHealth(projectDir: string, opts: { json?: boolean } = {}): Promise<HealthReport> {
	const gtrkPath = locateProjectGtrk(projectDir);
	const { gtrk } = readGtrk(gtrkPath);
	assertGtrkV1(gtrk);

	const tracks = allTracks(gtrk);
	// ⚠️ 结构级与素材级都**复用各命令内部的同一份实现**（spec：MUST NOT 另写一份判据）。
	// 另写一份的后果是「体检说没事、写回时报违例」——那比没有体检更坏。
	const violations = collectWriteViolations(gtrk, "doctor --project");
	const integ = checkMaterialIntegrity({ gtrk, gtrkDir: dirname(gtrkPath) });

	const report = buildHealthReport({
		gtrk,
		tracks,
		materials: {
			total: integ.checked,
			missing: integ.dangling.map((m) => ({ id: m.id, path: m.path })),
			external: integ.external.map((m) => ({ id: m.id, path: m.path })),
			degraded: integ.degraded?.count ?? 0,
		},
		violations,
	});

	if (opts.json) {
		console.log(JSON.stringify({ ...report, gtrk: gtrkPath }));
	} else {
		console.log(`\n工程体检：${gtrkPath}\n`);
		for (const t of tracks) {
			const range = t.track_st === null ? "空轨" : `${t.track_st}–${t.track_ed}s`;
			console.log(`  · ${t.track}：${t.clips} 个片段，${range}` + (t.gaps.length ? `，${t.gaps.length} 处缝` : "") + (t.overlaps.length ? `，${t.overlaps.length} 处重叠` : ""));
		}
		console.log("");
		for (const f of report.findings) console.log(`  ${HEALTH_MARK[f.level] ?? "  "} ${f.message}`);
		console.log(
			report.blocking
				? "\n有阻断级问题，交付前必须处理。\n"
				: "\n结构无阻断级问题，可以交付。\n",
		);
	}
	// 退出码只认阻断级（spec：仅告警的发现 MUST NOT 非 0——否则调用方会为了让脚本继续而整个忽略体检）
	if (report.blocking) process.exitCode = 1;
	return report;
}
