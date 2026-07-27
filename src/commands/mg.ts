/**
 * gtrk mg —— MG 颗粒生产铺轨（add-rrv-lay，去品牌化前 gtrk rrv）。
 *
 * 脑手分工：real-roam-viz skill=脑（产 GSAP 颗粒 HTML），本命令=手（lint / 铺轨 / 看板）。
 * **不云渲、不下载 webm**——渲染是客户端出片期的事（客户端有内容 key 缓存）。
 *
 * 三模式（沿 matrix/split 的「顶层命令 + 可选 positional」范式）：
 *   gtrk mg --project <dir>        消费 dispatch.mg → 定位颗粒 HTML → lint → 铺 html-particle 到 beat_track
 *   gtrk mg lint <particle.html>   单文件纯本地静态 lint（六铁律静态子集）
 *   gtrk mg status --project <dir> 编排看板（几 beat / 几已产 / 几已铺）
 *
 * 去品牌化双名认旧：命令保留弃用别名 `gtrk rrv`；dispatch 读 `mg ?? rrv_mg`；源目录双探 `mg/ ∪ rrv/`；
 * struct_meta 读 `mg ?? rrv`。写侧一律新名（assets/mg、mg- 前缀、struct_meta.mg）。
 */
import type { Command } from "commander";
import { resolve, join, dirname, basename } from "node:path";
import { existsSync } from "node:fs";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { readGtrk, assertGtrkV1, writeGtrkAtomic } from "../lib/gtrk-writeback";
import { lintParticle, parseCompositionId } from "../lib/mg-lint";
import { layMgTracks, type MgLayItem, type StructMetaMg } from "../lib/mg-lay";
import type { Dispatch, MgDispatch } from "../lib/splitdoc";
import { reportReprojection, reprojectDispatchWindows, withTimecodeSource } from "../lib/reproject";
import { reportMaterialIntegrity, safeCheckMaterialIntegrity } from "../lib/material-integrity";
import { log, routeLogsToStderr } from "../lib/log";

const MG_ASSET_DIR = "assets/mg"; // <gtrk-dir>/assets/mg/<composition_id>.html （工程自包含落地，写侧）
// 源目录双探（读旧兼容）：写侧 mg/，读侧并集 mg/ ∪ rrv/（既有工程零迁移）
const MG_SRC_DIRS = ["mg", "rrv"] as const;

interface MgOpts {
	project?: string;
	dispatch?: string;
	only?: string;
	lintOnly?: boolean;
	/** 逃生门（fix-mg-lay-strip-scope ④）：显式授权「重置整轨」——清空保留集 + 绕过空 queue 守门。 */
	replaceAll?: boolean;
	json?: boolean;
}

export function registerMg(program: Command): void {
	program
		.command("mg [words...]")
		.alias("rrv") // 去品牌化弃用别名：`gtrk rrv` 旧脚本/skill 不断（打 deprecation 提示）
		.description(
			"MG 颗粒铺轨：无 positional=消费 dispatch.mg 铺 html-particle；`mg lint <file>`=单文件 lint；`mg status`=看板",
		)
		.option("--project <dir>", "oralcut 产物目录（定位 split/dispatch.json 与工程）")
		.option("--dispatch <path>", "显式指定 dispatch.json（非标准布局兜底）")
		.option("--only <beat>", "只跑单 beat（收 beat id 如 B12，非 composition_id）：增量重铺该 beat，轨上其余已铺颗粒原样保留")
		.option("--lint-only", "只 lint 校验，不铺轨不写回")
		.option("--replace-all", "显式授权重置整轨：不走增量保留、整轨剥掉重铺——会删掉轨上其余已铺颗粒（不在本次派单/--only 里的那些）")
		.option("--json", "机读模式：人读日志转 stderr，stdout 只输出结果 JSON")
		.action(async (words: string[] | undefined, opts: MgOpts) => {
			if (process.argv[2] === "rrv") log.warn("`gtrk rrv` 已更名为 `gtrk mg`（去品牌化），别名仍可用但建议改用 `gtrk mg`。");
			await runMg(words ?? [], opts);
		});
}

/** 命令分派（导出供测试直调）：空=铺轨 / `lint <file>` / `status`。 */
export async function runMg(words: string[], opts: MgOpts): Promise<MgResult> {
	if (opts.json) routeLogsToStderr();
	const sub = words[0];
	if (sub === "lint") return runLint(words.slice(1), opts);
	if (sub === "status") return runStatus(opts);
	if (sub) throw new Error(`未知子命令「${sub}」——铺轨：gtrk mg --project <dir>；lint：gtrk mg lint <file>；看板：gtrk mg status`);
	return runLay(opts);
}

/** 定位 dispatch + baseDir（同 matrix）。 */
function resolveDispatch(opts: MgOpts): { dispatchPath: string; baseDir: string } {
	if (opts.dispatch) {
		const dispatchPath = resolve(opts.dispatch);
		return { dispatchPath, baseDir: dirname(dirname(dispatchPath)) };
	}
	if (opts.project) {
		const baseDir = resolve(opts.project);
		return { dispatchPath: join(baseDir, "split", "dispatch.json"), baseDir };
	}
	throw new Error("需 --project <目录> 或显式 --dispatch <path>");
}

function locateGtrk(baseDir: string): string | undefined {
	return [join(baseDir, "gtrk", "project.gtrk"), join(baseDir, "project.gtrk")].find((p) => existsSync(p));
}

/** 定位颗粒源 HTML：双探源目录（mg/ 写侧、rrv/ 读旧），命中即返回绝对路径。 */
function locateSrcHtml(baseDir: string, compositionId: string): string | undefined {
	for (const d of MG_SRC_DIRS) {
		const p = join(baseDir, d, `${compositionId}.html`);
		if (existsSync(p)) return p;
	}
	return undefined;
}

async function readMgQueue(dispatchPath: string): Promise<MgDispatch[]> {
	if (!existsSync(dispatchPath)) throw new Error(`找不到派单清单：${dispatchPath}（先跑 gtrk split 落地派单）`);
	// dispatch 桶读旧兼容：新键 mg，遗留键 rrv_mg（既有 dispatch.json 零迁移）
	const dispatch = JSON.parse(await readFile(dispatchPath, "utf8")) as Dispatch & { rrv_mg?: MgDispatch[] };
	const queue = dispatch.mg ?? dispatch.rrv_mg;
	return Array.isArray(queue) ? queue : [];
}

interface MgResult {
	ok: boolean;
	mode: "lay" | "lint" | "status";
	[k: string]: unknown;
}

/**
 * 读回登记里**已铺**（`laid` 非空）的 composition_id —— 登记键读**并集** mg ∪ rrv（老工程零迁移）。
 *
 * fix-mg-lay-strip-scope（1.1）：这是剥离面判据的**唯一来源**。判据与处置刻意分离：
 * 阶段 B 拿「已铺但本次 items 未覆盖」的差集去**报因拒写**，阶段 A 拿**同一个集合**当**保留集**
 * 传给 layMgTracks 走增量合并（★ 阶段 A 已落地：只换了处置分支，本函数一字未动）。
 */
function laidCompositionIds(gtrk: Record<string, unknown> | undefined): string[] {
	if (!gtrk) return [];
	const structMeta = gtrk.struct_meta as { mg?: StructMetaMg; rrv?: StructMetaMg } | undefined;
	const ids: string[] = [];
	const seen = new Set<string>();
	// 并集而非 `mg ?? rrv`：老工程可能两个键并存，漏读任一侧都会让守门放空（fix-mg-lay-strip-scope 4.9）
	for (const meta of [structMeta?.mg, structMeta?.rrv]) {
		for (const b of meta?.beats ?? []) {
			if (!b?.laid || typeof b.composition_id !== "string" || seen.has(b.composition_id)) continue;
			seen.add(b.composition_id);
			ids.push(b.composition_id);
		}
	}
	return ids;
}

/** 铺轨模式。 */
async function runLay(opts: MgOpts): Promise<MgResult> {
	const { dispatchPath, baseDir } = resolveDispatch(opts);
	const allQueue = await readMgQueue(dispatchPath);
	const queue = opts.only ? allQueue.filter((q) => q.beat === opts.only) : allQueue;
	log.step(`▶ MG 颗粒铺轨：${queue.length} 个 beat…`);
	if (opts.only && queue.length === 0) {
		// 1.6：真机实测「--only 打错字」= 全轨被清空，且报因看不出是选择器打空了。无条件提示，不只在拒写时提。
		const beats = [...new Set(allQueue.map((q) => q.beat))];
		log.warn(`--only ${opts.only} 未命中任何 beat——该选择器收的是「beat id」（如 B12），不是 composition_id（如 <slug>-B12）。`);
		log.warn(`dispatch 现有 beat：${beats.slice(0, 12).join("、") || "（空）"}${beats.length > 12 ? ` …共 ${beats.length} 个` : ""}`);
	}

	// 工程**提前读取**（fix-mg-lay-strip-scope 1.7 + add-consume-side-reprojection 5.1）：
	// 剥离面守门要先知道登记里有没有已铺条目；重投影更要在 lint / 复制 HTML / 铺轨**三者之前**拿到当刻工程。
	// `--lint-only` 也读（D6 ①a）：读得到且 v1 就按当刻窗口 lint；读不到 / 非 v1 / JSON 坏一律**门内吞掉**
	// 降级为快照窗口——它 MUST NOT 进版本门，其退出码与 lint 报告须与本能力上线前逐条一致。
	const gtrkPath = locateGtrk(baseDir);
	let project: ReturnType<typeof readGtrk> | undefined;
	let gtrkUnreadable = false;
	if (gtrkPath) {
		try {
			project = readGtrk(gtrkPath);
		} catch (e) {
			// 既有失败面一动不动：铺轨路径照旧原样上抛（非 0 退出）；`--lint-only` 今天压根不读 → 吞掉
			if (!opts.lintOnly) throw e;
			gtrkUnreadable = true;
		}
	}
	// 版本门位置不挪（gtrk-writeback.ts assertGtrkV1）：铺轨路径仍硬失败，MUST NOT 降成放行。
	if (!opts.lintOnly && project) assertGtrkV1(project.gtrk);
	const laidBefore = laidCompositionIds(opts.lintOnly ? undefined : project?.gtrk);

	// ── 现场重投影（add-consume-side-reprojection）：恒执行、在 lint 之前 ─────────────────
	// 铁律⑦ 的槽位包络取自 track_ed − track_st，拿派单快照窗口 lint 等于**按错长度判颗粒**。
	const reproj = await reprojectDispatchWindows({
		baseDir,
		gtrk: project?.gtrk,
		gtrkUnreadable,
		entries: queue.map((q) => ({
			key: q.composition_id,
			beat: q.beat,
			compositionId: q.composition_id, // 老档回落 MUST 按 composition_id 定位（aux 的 beat 字段是主 beat id）
			span: q.span,
			track_st: q.track_st,
			track_ed: q.track_ed,
		})),
	});
	reportReprojection(reproj);

	const dispatchIds = queue.map((q) => q.composition_id);
	const items: MgLayItem[] = [];
	const srcByComp = new Map<string, string>(); // composition_id → 源 HTML 绝对路径（供复制）
	const skipped: { beat: string; reason: string }[] = [];

	const windowOf = new Map(reproj.entries.map((o) => [o.key, o]));
	for (const q of queue) {
		const outcome = windowOf.get(q.composition_id);
		if (outcome?.dropped) {
			// 零存活 MUST NOT 回落快照时码：那段确实已不在成片里，铺上去必然错位。
			// 零副作用：不复制 HTML 进 assets/mg/（本 continue 排在 locateSrcHtml 之前）。
			// 告警不在此重复打——reportReprojection 已用共用话术逐条报过（6.2「别写两遍」）。
			skipped.push({ beat: q.beat, reason: "重投影后零存活（该段已被剪出成片）" });
			continue;
		}
		// 本次采用窗口（重投影值；降级时是派单快照回退值）——lint 与落轨同源于它
		const win = outcome ?? { track_st: q.track_st, track_ed: q.track_ed };
		const srcPath = locateSrcHtml(baseDir, q.composition_id);
		if (!srcPath) {
			skipped.push({ beat: q.beat, reason: "缺颗粒 HTML（未产出）" });
			log.warn(`${q.beat}：缺 ${join(baseDir, MG_SRC_DIRS[0], `${q.composition_id}.html`)}，跳过`);
			continue;
		}
		const html = await readFile(srcPath, "utf8");
		const category = typeof q.category === "string" ? q.category : undefined;
		// 铁律⑦：坑位长度 = 槽位包络，与 dispatch 的 duration（=duration_hint 语义）彻底解耦。
		const slotDuration = Math.round((win.track_ed - win.track_st) * 1000) / 1000;
		const lint = lintParticle(html, {
			compositionId: q.composition_id,
			dispatchIds,
			category,
			...(slotDuration > 0 ? { slotDuration } : {}),
		});
		for (const vv of lint.violations) (vv.fatal ? log.warn : log.info)(`${q.beat} lint ${vv.fatal ? "✗" : "·"} ${vv.law}: ${vv.msg}`);
		if (!lint.ok) {
			skipped.push({ beat: q.beat, reason: "lint 未过" });
			log.warn(`${q.beat}：lint 未过，跳过`);
			continue;
		}
		if (!(slotDuration > 0)) {
			skipped.push({ beat: q.beat, reason: "槽位包络非正数" });
			continue;
		}
		srcByComp.set(q.composition_id, srcPath);
		items.push({
			beat: q.beat,
			composition_id: q.composition_id,
			track_st: win.track_st,
			track_ed: win.track_ed,
			opaque: lint.opaque,
			html_rel: `${MG_ASSET_DIR}/${q.composition_id}.html`,
			...(category ? { category } : {}),
		});
	}

	if (opts.lintOnly) {
		// ③（2.5）：`--lint-only` 今日已按 skipped 算 ok，但退出码恒 0 —— 与 lay 分支同病同治，
		// ok:false 一律连带非 0 退出（统一落在 done()）。
		const lintOk = skipped.length === 0;
		(lintOk ? log.ok : log.warn)(`lint-only：${items.length}/${queue.length} 通过，${skipped.length} 跳过（不铺轨）`);
		return done(opts, {
			ok: lintOk,
			mode: "lay",
			lintOnly: true,
			...(lintOk ? {} : { reason: "skipped" }),
			passed: items.length,
			skipped,
			reprojection: reproj.summary,
		});
	}

	// 工程缺失/非 v1 = 告警跳过（铺轨是增值不是门槛）；`reason: "no_project"` 让 agent 能与「拒写回」「全铺成」区分
	if (!gtrkPath || !project) {
		log.warn(`未找到工程文件（${join(baseDir, "gtrk", "project.gtrk")}），跳过铺轨——lint 已完成`);
		return done(opts, {
			ok: skipped.length === 0,
			mode: "lay",
			reason: "no_project",
			laid: 0,
			laidTrack: null,
			track_total: 0,
			removed: 0,
			kept: 0,
			kept_ids: [],
			skipped,
			note: "工程缺失，未铺轨",
			reprojection: reproj.summary,
		});
	}
	const { gtrk, mtimeMs } = project;
	const gtrkDir = dirname(gtrkPath);

	// ── 剥离面（fix-mg-lay-strip-scope 阶段 A · 真增量合并）───────────────────────────
	// 判据集与阶段 B **逐字相同**：orphans =「登记里已铺、但本次 items 未覆盖」的 composition_id。
	// 阶段 A 只换**处置**——B 拿它报因拒写，A 拿它当**保留集**交给 layMgTracks 原样搬运。
	// MUST NOT 另起一套判据（两套判据会算出不同集合，那正是分两阶段最大的风险）。
	const covered = new Set(items.map((it) => it.composition_id));
	const orphans = laidBefore.filter((id) => !covered.has(id));
	// 处置面分流（同一个 orphans，只在「怎么处置」上分模式，MUST NOT 另算集合）：
	//   `--only` = **选择**，选择面之外的一律保留；
	//   全量     = 以当刻派单为准：派单里有、本次却没铺成（skip）的**保留**（★ ② 终态口径 2026-07-26：
	//              「因为新的做坏了就把旧的也毁掉」正是本轮审计在修的静默丢产物）；
	//              派单里**已不存在**的仍照剥——那是明确的计划变更，一律保留会让陈旧 ghost 带着过期时码永久驻留。
	const inDispatch = new Set(allQueue.map((q) => q.composition_id));
	const keep = opts.replaceAll ? [] : opts.only ? orphans : orphans.filter((id) => inDispatch.has(id));
	const keepSet = new Set(keep);
	// 本次若真写回，会从轨上消失的那些（拒写时用来说清代价；`--only` 打空 / 全 skip 下通常为空）
	const wouldRemove = laidBefore.filter((id) => !covered.has(id) && !keepSet.has(id));
	// 1.3（永久条款，阶段 A 之后 SHALL 保留）：一条都没定位到 = dispatch/选择器出问题的信号，不是清空指令。
	// 增量合并之后它已不再是「防铲」，而是「别把错误信号当指令」——不拒就会报一句「铺轨完成：0 颗粒」放行。
	const refuse: "empty_queue" | undefined = laidBefore.length > 0 && items.length === 0 ? "empty_queue" : undefined;
	if (refuse && !opts.replaceAll) {
		log.err(`拒绝写回：本次一条颗粒都没定位到，而轨上已铺 ${laidBefore.length} 颗——「一条都没定位到」是派单/选择器出问题的信号，不是清空指令。`);
		if (opts.only && queue.length === 0) {
			log.warn(`成因：--only ${opts.only} 未命中任何 beat（选择器提示见上）。`);
		} else if (allQueue.length === 0) {
			log.warn("dispatch.mg（读旧 rrv_mg）为空或缺失——先跑 gtrk split 落地派单，再铺轨。");
		} else {
			log.warn(`本次 ${queue.length} 个条目全部被跳过（${[...new Set(skipped.map((s) => s.reason))].join("、")}）——先按上面的 lint 报因补产 / 修颗粒，再重铺。`);
		}
		if (wouldRemove.length) {
			const preview = wouldRemove.slice(0, 8);
			log.warn(`将被铲掉：${preview.join("、")}${wouldRemove.length > preview.length ? ` …等共 ${wouldRemove.length} 颗` : ""}`);
		}
		log.warn("出路二选一：① 按上面的报因修好派单 / 选择器 / 颗粒后重铺；② 确知要清空整轨 → 加 --replace-all 显式授权（会删掉轨上全部已铺颗粒）");
		log.warn(`工程未被改动（.gtrk 逐字节不变，轨上仍 ${laidBefore.length} 颗）。`);
		return done(opts, {
			ok: false,
			mode: "lay",
			reason: refuse,
			refused: true,
			laid: 0,
			laidTrack: null,
			track_total: laidBefore.length, // 轨上现存（拒写 → 与跑之前一致），不是 0
			removed: 0,
			kept: 0,
			kept_ids: [],
			blocked: wouldRemove,
			skipped,
			reprojection: reproj.summary,
		});
	}
	if (opts.replaceAll && orphans.length > 0) {
		log.warn(`--replace-all：已显式授权重置整轨，轨上其余 ${orphans.length} 颗已铺颗粒将被剥离（不走增量保留）。`);
	}

	// 复制颗粒 HTML 进工程 assets/mg/（自包含）
	await mkdir(join(gtrkDir, ...MG_ASSET_DIR.split("/")), { recursive: true });
	for (const it of items) {
		await copyFile(srcByComp.get(it.composition_id)!, join(gtrkDir, ...it.html_rel.split("/")));
	}

	const { next, summary, mg } = layMgTracks({ gtrk, items, generatedAt: new Date().toISOString(), keep });
	// 时码来源登记（add-consume-side-reprojection 7.1，纯追加可选字段）：
	// 让「这批已铺产物是照哪条时间线、哪种模式铺的」可被后续体检读取。本 change 只**登记**，不据此判失效。
	// 注意它描述的是**本次铺的那些**——保留条目带的是上一轮时码（混排形态，见 spec 同名 Scenario）。
	const written = withTimecodeSource(next, "mg", reproj);
	writeGtrkAtomic(gtrkPath, written, mtimeMs);
	// 素材落盘自检（material-integrity-check）：与 `gtrk matrix` 同一纯函数、同名同形字段。
	// 只读、非致命——查出悬空 MUST NOT 改 ok / 退出码 / 写回结果；人读输出压在铺轨完成行之后。
	const integrity = safeCheckMaterialIntegrity({ gtrk: written, gtrkDir, log });
	// 2.1/2.2 + 7.3：日志与结果报**三数**——只报「本次几颗」会让「铺 1 颗剥 20 颗」读起来跟「补铺 1 颗」一模一样；
	// 只报「本次 + 轨上共」又会让「轨上那 20 颗是上一轮的」这条代价说不出口（★ ② 终态口径要求如实标出）。
	const trackTotal = mg.beats.filter((b) => b.laid).length; // 轨上现存已铺数 = 本次铺成数 + 保留数
	// 上轮遗留（保留成功）的 composition_id：登记里在保留集内且仍标 laid 的那些。
	// 「登记说已铺、轨上却没捞到 clip」的条目已在铺轨层降级 laid:null，因此不会混进来。
	const keptIds = mg.beats.filter((b) => b.laid && keepSet.has(b.composition_id)).map((b) => b.composition_id);
	const removed = laidBefore.length - keptIds.length; // 本次被剥数 = 上一轮已铺里没被保留下来的（含「剥了再铺」的那些）
	const ok = skipped.length === 0;
	const tail =
		`本次 ${summary.laidParticles} 颗 / 轨上共 ${trackTotal} 颗${keptIds.length ? `（保留 ${keptIds.length} 颗）` : ""}` +
		` → beat_track ${summary.laidTrack ?? "-"}` +
		`${removed ? `（剥旧 ${removed} 颗）` : ""}${skipped.length ? `（${skipped.length} beat 跳过）` : ""}`;
	if (summary.laidTrack === null) log.warn(`未铺成任何颗粒：${tail}`); // laidTrack 为 null MUST NOT 打 ✅
	else if (ok) log.ok(`铺轨完成：${tail}`);
	else log.warn(`铺轨完成（有跳过）：${tail}`);
	if (keptIds.length) {
		const preview = keptIds.slice(0, 8);
		log.warn(
			`其中 ${keptIds.length} 颗是上轮遗留、本次未重铺：${preview.join("、")}${keptIds.length > preview.length ? ` …等共 ${keptIds.length} 颗` : ""}` +
				`——轨上内容 = 本次 ${summary.laidParticles} 颗 + 上轮 ${keptIds.length} 颗，与本次派单不完全对应（要全部刷新就去掉 --only 全量重铺）。`,
		);
	}
	log.info("opencut 打开工程即见 MG overlay 轨（预览需 add-particle-project-folder-preview 上线）；出片时客户端云渲。");
	if (integrity) reportMaterialIntegrity(integrity, log);
	return done(opts, {
		ok,
		mode: "lay",
		...(ok ? {} : { reason: "skipped" }),
		laid: summary.laidParticles,
		laidTrack: summary.laidTrack,
		track_total: trackTotal,
		removed,
		kept: keptIds.length,
		kept_ids: keptIds, // ★ ② 的「代价如实标出」落点：轨上哪几颗不是这一轮的，机读方一眼可见
		skipped,
		// 素材落盘自检：只在**真写回过**的路径上出现；字段缺席 = 「本次没查」（与 `gtrk matrix` 同形）
		...(integrity ? { integrity } : {}),
		reprojection: reproj.summary,
	});
}

/**
 * 文件名是否形如 composition_id（`<slug>-B<数字>` / `<slug>-B<数字>-aux<n>`）。
 * 裸 lint 拿 basename 当期望 id 时的门槛：`gtrk mg lint ./tmp.html` 这类临时副本必然对不上，
 * 不设门就会误判致命（fix-mg-lint-law7-estimate 开放问题·裸 lint 期望 id 来源）。
 */
const CID_SHAPE = /-B\d+(?:-aux\d+)?$/;

/** 单文件 lint 模式。 */
async function runLint(args: string[], opts: MgOpts): Promise<MgResult> {
	const file = args[0];
	if (!file) throw new Error('用法：gtrk mg lint <particle.html> [--dispatch <path>]');
	const html = await readFile(resolve(file), "utf8");
	const nameId = basename(file).replace(/\.html?$/i, "");
	let dispatchIds: string[] | undefined;
	let slotDuration: number | undefined;
	let compositionId: string | undefined; // 期望 id（非覆盖值）
	if (opts.dispatch && existsSync(resolve(opts.dispatch))) {
		const queue = await readMgQueue(resolve(opts.dispatch));
		dispatchIds = queue.map((q) => q.composition_id);
		// 定位派单条目：先按文件名（铺轨链路上文件名恒 = composition_id，见 :151/:174），
		// 未命中再退回 HTML 内 cid（这时不设期望 id——拿自己比自己是恒真检查）。
		const byName = queue.find((q) => q.composition_id === nameId);
		const innerCid = parseCompositionId(html);
		const hit = byName ?? (innerCid ? queue.find((q) => q.composition_id === innerCid) : undefined);
		if (hit) {
			// 铁律⑦：坑位长度 = 槽位包络（与 dispatch.duration 的 hint 语义解耦），同 runLay
			const d = Math.round((hit.track_ed - hit.track_st) * 1000) / 1000;
			if (d > 0) slotDuration = d;
		}
		if (byName) compositionId = byName.composition_id;
	}
	// 无派单命中时：文件名形如 composition_id 才拿它当期望 id（改过名的临时副本不比对，防误判致命）
	if (compositionId === undefined && CID_SHAPE.test(nameId)) compositionId = nameId;
	const lint = lintParticle(html, {
		...(dispatchIds ? { dispatchIds } : {}),
		...(compositionId ? { compositionId } : {}),
		...(slotDuration ? { slotDuration } : {}),
	});
	for (const vv of lint.violations) (vv.fatal ? log.err : log.warn)(`${vv.fatal ? "✗" : "·"} ${vv.law}: ${vv.msg}`);
	if (lint.ok) log.ok(`lint 通过（${basename(file)}；opaque=${lint.opaque}）`);
	else log.err(`lint 未过（${lint.violations.filter((v) => v.fatal).length} 项致命）`);
	const result: MgResult = { mode: "lint", ...lint, ok: lint.ok };
	if (opts.json) console.log(JSON.stringify(result));
	if (!lint.ok) process.exitCode = 1;
	return result;
}

/** 编排看板模式。 */
async function runStatus(opts: MgOpts): Promise<MgResult> {
	const { dispatchPath, baseDir } = resolveDispatch(opts);
	const queue = await readMgQueue(dispatchPath);
	const gtrkPath = locateGtrk(baseDir);
	let laidIds = new Set<string>();
	if (gtrkPath) {
		const { gtrk } = readGtrk(gtrkPath);
		// struct_meta 登记键读旧兼容：新键 mg，遗留键 rrv
		const structMeta = gtrk.struct_meta as { mg?: StructMetaMg; rrv?: StructMetaMg } | undefined;
		const meta = structMeta?.mg ?? structMeta?.rrv;
		laidIds = new Set((meta?.beats ?? []).filter((b) => b.laid).map((b) => b.composition_id));
	}
	const rows = queue.map((q) => {
		const authored = locateSrcHtml(baseDir, q.composition_id) !== undefined;
		const laid = laidIds.has(q.composition_id);
		return { beat: q.beat, composition_id: q.composition_id, authored, laid, state: laid ? "已铺" : authored ? "已产未铺" : "缺 HTML" };
	});
	const authored = rows.filter((r) => r.authored).length;
	const laid = rows.filter((r) => r.laid).length;
	log.step(`▶ MG 看板：${queue.length} beat · ${authored} 已产 · ${laid} 已铺`);
	for (const r of rows) log.info(`${r.beat}（${r.composition_id}）→ ${r.state}`);
	return done(opts, { ok: true, mode: "status", total: queue.length, authored, laid, rows });
}

function done(opts: MgOpts, result: MgResult): MgResult {
	// ③（fix-mg-lay-strip-scope 2.4/2.5，2026-07-26 拍板取「一起变严」）：`ok:false` 一律连带非 0 退出码。
	// 本 CLI 的主要消费者是 agent，「ok:false + 退出码 0」是静默错判的源头（`--lint-only` 今日正是该形态）。
	// 姿势对齐同仓既有：tool.ts / music-visualizer.ts / doctor.ts。
	if (!result.ok) process.exitCode = 1;
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}
