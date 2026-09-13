/**
 * gtrk mg —— MG 颗粒生产铺轨（add-rrv-lay，去品牌化前 gtrk rrv）。
 *
 * 脑手分工：real-roam-viz skill=脑（产 GSAP 颗粒 HTML），本命令=手（lint / 铺轨 / 看板）。
 * **铺轨这几个模式不云渲、不下载 webm**——铺轨只管把颗粒落进 `beat_track`。
 * ⚠️ 「CLI 不云渲」这句已被**两次**破例，别再照旧理解：
 *   ① `gtrk mg render`（add-mg-standalone-render）——脱离工程的单颗粒 qtrle 云渲；
 *   ② `gtrk render`（add-render-overlay-compositing）——出片时对未命中缓存的颗粒云渲再本地叠。
 * 两者都走 `html_render_simple`，都有计费确认闸；②与客户端共用工程目录里的内容寻址缓存。
 *
 * 四模式（沿 matrix/split 的「顶层命令 + 可选 positional」范式）：
 *   gtrk mg --project <dir>        消费 dispatch.mg → 定位颗粒 HTML → lint → 铺 html-particle 到 beat_track
 *   gtrk mg lint <particle.html>   单文件纯本地静态 lint（六铁律静态子集）
 *   gtrk mg status --project <dir> 编排看板（几 beat / 几已产 / 几已铺）
 *   gtrk mg render <particle.html> --duration <sec>   独立颗粒云渲 qtrle 透明 MOV（脱离工程，精剪补给口；
 *                                  add-mg-standalone-render——例外于「不云渲」旧注：仅此模式云渲、计费确认前置）
 *
 * 去品牌化双名认旧：命令保留弃用别名 `gtrk rrv`；dispatch 读 `mg ?? rrv_mg`；源目录双探 `mg/ ∪ rrv/`；
 * struct_meta 读 `mg ?? rrv`。写侧一律新名（assets/mg、mg- 前缀、struct_meta.mg）。
 */
import type { Command } from "commander";
import { resolve, join, dirname, basename } from "node:path";
import { existsSync } from "node:fs";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { readGtrk, assertGtrkV1, writeGtrkAtomic } from "../lib/gtrk-writeback";
// [adjust-lay-frame-domain D2] 顶层 video_rate 与 matrix lay / ai-drama lay 同一读法：缺席 / 非正 / 非整数 ⇒ 报错退出零副作用
import { videoRateOf } from "../lib/gtrk-patch";
import { r3 } from "../lib/frame-domain";
import { lintParticle, parseCompositionId } from "../lib/mg-lint";
import { isInsideDir } from "../lib/outdir-guard";
import { renderParticle, CID_SHAPE, assertNotJianyingDraftDir } from "../lib/mg-render";
import { layMgTracks, type MgLayItem, type StructMetaMg } from "../lib/mg-lay";
import type { Dispatch, MgDispatch } from "../lib/splitdoc";
import { reportReprojection, reprojectDispatchWindows, withTimecodeSource } from "../lib/reproject";
import { reportMaterialIntegrity, safeCheckMaterialIntegrity } from "../lib/material-integrity";
import { log, routeLogsToStderr } from "../lib/log";
import { writeFile } from "node:fs/promises";
import { adoptBlock, AdoptError, DEFAULT_FONT, PARTICLE_H, PARTICLE_W } from "../lib/mg-adopt";
import { fetchBlockFile, findBlock, loadSnapshot, primaryFile, searchBlocks, type SnapshotItem } from "../lib/mg-registry";
import { runCompile, runEdit, runFetchText } from "./mg-text";
import { describeState, identifyParticle } from "../lib/particle-identity";

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
	/** render 模式（add-mg-standalone-render）：显式时长锚（秒，必填）。 */
	duration?: string;
	/** render 模式：产物格式，首发仅 qtrle（缺省即它）。 */
	format?: string;
	/** render 模式：落盘目录（缺省 ./mg-render/<composition_id>/）。 */
	out?: string;
	/** render 模式：跳过计费预估确认。 */
	yes?: boolean;
	/** fetch 模式（add-mg-registry-neutral-source）：取块并改写；缺省为候选态。 */
	pick?: string;
	/** fetch 候选态：列前 N 件（缺省 3）。 */
	top?: string;
	/** fetch 派单模式：目标 beat id（如 B03）或 composition_id；配 --project / --dispatch。 */
	slot?: string;
	/** fetch 独立模式：目标 composition_id（配 --duration）。 */
	as?: string;
	/** fetch：画布 WxH；契约当前只收 1920x1080，其余拒绝。 */
	canvas?: string;
	/** fetch：overlay / fullscreen；缺省按块底色推断（派单模式取派单 category）。 */
	category?: string;
	/** fetch：替换块内 font-family 的字体名；缺省为运行时镜像可证的 CJK 字体。 */
	font?: string;
	/** fetch：候选态也列 excluded 件（缺省只列 ok / review）。 */
	all?: boolean;
	/** fetch 来源：`registry`（中性块，缺省）或 `text`（我方文字模板库）。 */
	source?: string;
	/** edit 模式：一句话说清要改成什么。 */
	say?: string;
	/** edit 模式：候选数，只收 1 或 3（缺省 1）。它就是计费单位数。 */
	n?: string;
	/** fetch --source text：跳过目录更新，只用本地（离线/内网）。 */
	offline?: boolean;
}

export function registerMg(program: Command): void {
	program
		.command("mg [words...]")
		.alias("rrv") // 去品牌化弃用别名：`gtrk rrv` 旧脚本/skill 不断（打 deprecation 提示）
		.description(
			"MG 颗粒铺轨：无 positional=消费 dispatch.mg 铺 html-particle；`mg lint <file>`=单文件 lint；`mg status`=看板；`mg render <file> --duration <sec>`=独立颗粒云渲 qtrle 透明 MOV（精剪补给口）",
		)
		.option("--project <dir>", "oralcut 产物目录（定位 split/dispatch.json 与工程）")
		.option("--dispatch <path>", "显式指定 dispatch.json（非标准布局兜底）")
		.option("--only <beat>", "只跑单 beat（收 beat id 如 B12，非 composition_id）：增量重铺该 beat，轨上其余已铺颗粒原样保留")
		.option("--lint-only", "只 lint 校验，不铺轨不写回")
		.option("--replace-all", "显式授权重置整轨：不走增量保留、整轨剥掉重铺——会删掉轨上其余已铺颗粒（不在本次派单/--only 里的那些）")
		.option("--duration <sec>", "render 模式必填：显式时长锚（秒）——独立模式无坑位包络，它就是 lint 包络与计费时长")
		.option("--format <fmt>", "render 模式产物格式：首发仅 qtrle（剪映可读透明 MOV；webm 剪映不吃、明确拒绝）")
		.option("--out <dir>", "render 模式落盘目录（缺省 ./mg-render/<composition_id>/；绝不写剪映草稿目录）")
		.option("--yes", "render 模式：跳过计费预估确认")
		.option("--pick <name>", "fetch 模式：取 registry 块 <name> 改写成颗粒（缺省不给 = 候选态只列不取）")
		.option("--top <n>", "fetch 候选态：列前 N 件（缺省 3）")
		.option("--slot <beat>", "fetch 派单模式：目标 beat id（如 B03）——从 dispatch.mg 取 composition_id / 坑位包络 / category，产物落 <project>/mg/")
		.option("--as <composition_id>", "fetch 独立模式：目标 composition_id（配 --duration），产物落 --out（缺省 ./mg-fetch/）")
		.option("--canvas <WxH>", "fetch：画布尺寸；契约当前只收 1920x1080")
		.option("--category <c>", "fetch：overlay / fullscreen（缺省派单值或按块底色推断）")
		.option("--font <name>", "fetch：替换块内字体名（缺省运行时镜像可证的 CJK 字体）")
		.option("--all", "fetch 候选态：连 excluded 件一起列")
		.option("--source <s>", "fetch 来源：registry（中性块，缺省）| text（我方文字模板库，块自带 IR 可云端改写）")
		.option("--say <text>", "edit 模式：一句话说清要改成什么（如「打字机快一倍，副标改成青色」）")
		.option("--n <n>", "edit 模式：候选数，只收 1 或 3（缺省 1）——它就是计费单位数")
		.option("--offline", "fetch --source text：不更新模板目录，直接用本地那份")
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
	if (sub === "render") return runRender(words.slice(1), opts);
	if (sub === "fetch") {
		// 文字模板是**第二个来源**，不是 registry 的一种过滤：它的块自带 IR、不做机械改写、
		// 改内容走 compile / edit。两条路的取块与改写语义都不同，故在这里分流而非塞进 runFetch。
		if ((opts.source ?? "registry") === "text") return done(opts, (await runFetchText(words.slice(1), opts)) as MgResult);
		if (opts.source && opts.source !== "registry") throw new Error(`--source 只收 registry | text：${opts.source}`);
		return runFetch(words.slice(1), opts);
	}
	if (sub === "compile") return done(opts, (await runCompile(words.slice(1), opts)) as MgResult);
	if (sub === "edit") return done(opts, (await runEdit(words.slice(1), opts)) as MgResult);
	if (sub) throw new Error(`未知子命令「${sub}」——铺轨：gtrk mg --project <dir>；lint：gtrk mg lint <file>；看板：gtrk mg status；独立渲染：gtrk mg render <file> --duration <sec>；文字模板：gtrk mg fetch --source text <检索词> / gtrk mg compile <ir.json> / gtrk mg edit <file> --say "…"`);
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
	mode: "lay" | "lint" | "status" | "fetch";
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
	// ── 帧率预检（adjust-lay-frame-domain D2）：颗粒窗口帧格化锚在顶层 video_rate；缺席 / 非正 / 非整数在这里就抛
	//    （与 matrix lay / layMgTracks 同一读法与话术）——此刻零复制、零改动，MUST NOT 静默退回毫秒路。`--lint-only` 不铺不查。
	if (!opts.lintOnly && project) videoRateOf(project.gtrk);
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
		// ══ 铺轨侧的工程内含闸（add-artifact-landing-gate §6.1 的「与铺轨路径」那半）══
		// `locateSrcHtml` 是 `join(baseDir, d, cid + ".html")`，**结构上**只往工程内看 ——
		// 但 `composition_id` 来自派单文件，是外部输入：含 `../` 的 cid 会让 join 归一化后**逃出工程根**。
		// runLint 那半有 isInsideDir 把关，铺轨这半此前一处都没有（2026-09-08 审计查出）。
		// 判据与 runLint 同源（realpath 包含关系，MUST NOT 字符串前缀），故软链抵达仍放行。
		if (srcPath && !isInsideDir(srcPath, baseDir)) {
			throw new Error(
				`派单条目 ${q.composition_id} 解析出的颗粒路径逃出了工程目录，已拒绝：${resolve(srcPath)}
` +
					`  工程根：${baseDir}
` +
					`  composition_id 来自派单文件（外部输入），含 \`../\` 时 join 会归一化到工程外。` +
					`交付物 SHALL 直接产在工程目录里，MUST NOT 经派单把读取指向别处。`,
			);
		}
		if (!srcPath) {
			skipped.push({ beat: q.beat, reason: "缺颗粒 HTML（未产出）" });
			log.warn(`${q.beat}：缺 ${join(baseDir, MG_SRC_DIRS[0], `${q.composition_id}.html`)}，跳过`);
			continue;
		}
		const html = await readFile(srcPath, "utf8");
		const category = typeof q.category === "string" ? q.category : undefined;
		// 铁律⑦：坑位长度 = 槽位包络，与 dispatch 的 duration（=duration_hint 语义）彻底解耦。
		const slotDuration = r3(win.track_ed - win.track_st);
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
	// 工程读取①（计算用）：剥离面判据（laidBefore / orphans）与重投影按这份算。
	// ⚠️ `revision` **不作写回 expected**——下方重投影与资产落地（mkdir/copyFile 批）是秒级动作，
	// 持有跨越它们的 revision 会让「客户端自动保存了一次」直接作废整轮。见工程读取②。
	const { gtrk, revision: planningRevision } = project;
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

	// ── 工程读取②（写回用）：耗时动作（重投影 + 资产落地）全部完成后才取 revision ──────────
	// 客户端 `.gtrk` 每 60s 自动保存一次（与用户有没有未保存改动无关），持有跨越资产落地的
	// revision 会让本轮铺轨整体白跑。此刻重读后冲突窗口 = 重读到 rename 的毫秒级，且
	// writeGtrkAtomic 的 rename 前重检照旧兜底（那条 MUST NOT 删）。
	//
	// ★ MUST 整体迁移基底：`layMgTracks` 的入参 `gtrk` 若还是读①那份，写出的整文件就不含用户
	// 那次保存，且因 revision 相符而通过全部校验、无任何告警——gtrk-writeback-contract
	// 「只换 revision 不换基底 = 静默覆盖」。故**入参与写回一律用 freshGtrk**。
	const { gtrk: freshGtrk, revision } = readGtrk(gtrkPath);
	assertGtrkV1(freshGtrk);
	if (revision !== planningRevision) {
		log.warn(
			"工程在本轮铺轨期间被改动过（颗粒资产落地进行中，你在客户端保存了工程）：已按**改后**的工程" +
				"铺轨写回，你那次保存不会被覆盖；但本轮的槽位包络与剥离面是按改动前的 beat 窗口算的——" +
				"若你改的正是时间线或 beat 派单，颗粒时码可能与新窗口对不齐，重跑一次本命令即可（纯本地、不计费）。",
		);
	}
	const { next, summary, mg } = layMgTracks({ gtrk: freshGtrk, items, generatedAt: new Date().toISOString(), keep, warn: log.warn, info: log.info });
	// 时码来源登记（add-consume-side-reprojection 7.1，纯追加可选字段）：
	// 让「这批已铺产物是照哪条时间线、哪种模式铺的」可被后续体检读取。本 change 只**登记**，不据此判失效。
	// 注意它描述的是**本次铺的那些**——保留条目带的是上一轮时码（混排形态，见 spec 同名 Scenario）。
	const written = withTimecodeSource(next, "mg", reproj);
	writeGtrkAtomic(gtrkPath, written, revision);
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
	log.info(
		"opencut 打开工程即见 MG 轨；出片两条路都行：客户端云渲，" +
			"或 `gtrk render`（对未命中缓存的颗粒云渲计费，两端共用同一份工程目录缓存）。",
	);
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

// CID_SHAPE（文件名是否形如 composition_id）已上提至 lib/mg-render.ts 导出（render/lint 两模式同规则，单一真相源）。

/** render 模式（add-mg-standalone-render）：参数转译 + 统一退出码；主链在 lib/mg-render.ts。 */
async function runRender(args: string[], opts: MgOpts): Promise<MgResult> {
	const file = args[0];
	if (!file) throw new Error("用法：gtrk mg render <particle.html> --duration <sec> [--format qtrle] [--out <dir>] [--yes]");
	const duration = Number(opts.duration);
	const result = await renderParticle({
		file,
		duration,
		...(opts.format ? { format: opts.format } : {}),
		...(opts.out ? { out: opts.out } : {}),
		...(opts.yes ? { yes: true } : {}),
	});
	return done(opts, result as unknown as MgResult);
}

/** 单文件 lint 模式。 */
async function runLint(args: string[], opts: MgOpts): Promise<MgResult> {
	const file = args[0];
	if (!file) throw new Error('用法：gtrk mg lint <particle.html> [--dispatch <path>]');
	const html = await readFile(resolve(file), "utf8");
	// 三态由 particle-identity 算好传进 lint——lint 自身零 import，算不了 sha256
	const particleState = identifyParticle(html).state;
	const nameId = basename(file).replace(/\.html?$/i, "");
	let dispatchIds: string[] | undefined;
	let slotDuration: number | undefined;
	let compositionId: string | undefined; // 期望 id（非覆盖值）
	// 工程根/派单定位：`--dispatch` 与 `--project` 都能解析出来（今日只认前者，于是给了
	// `--project` 时既不比对派单、也无从谈工程内含闸——2026-09-07 正是这条路）。
	let dispatchPath: string | undefined;
	if (opts.dispatch || opts.project) {
		try {
			dispatchPath = resolveDispatch(opts).dispatchPath;
		} catch {
			/* 解析不出（两个参数都没给）⇒ 裸 lint，本闸天然不介入 */
		}
	}
	if (dispatchPath && existsSync(dispatchPath)) {
		const queue = await readMgQueue(dispatchPath);
		dispatchIds = queue.map((q) => q.composition_id);
		// 定位派单条目：先按文件名（铺轨链路上文件名恒 = composition_id，见 :151/:174），
		// 未命中再退回 HTML 内 cid（这时不设期望 id——拿自己比自己是恒真检查）。
		const byName = queue.find((q) => q.composition_id === nameId);
		const innerCid = parseCompositionId(html);
		const hit = byName ?? (innerCid ? queue.find((q) => q.composition_id === innerCid) : undefined);
		if (hit) {
			// 铁律⑦：坑位长度 = 槽位包络（与 dispatch.duration 的 hint 语义解耦），同 runLay
			const d = r3(hit.track_ed - hit.track_st);
			if (d > 0) slotDuration = d;
		}
		if (byName) compositionId = byName.composition_id;

		// ══ 工程内含闸（add-artifact-landing-gate §6 · D1b 的可执行抓手）══
		// 命中派单 = 这是一件**正式交付物**；此刻工程根也已解析出来。
		// 2026-09-07 的失守形态正是：CLI 既知道工程根、又知道文件命中派单，
		// 却照样 lint 了一个住在 agent 工作目录里的副本，退出码 0。
		// 故此处**命令级前置硬拒**（跑在 lint 之前），MUST NOT 做成 lint 违规项
		// （`x-` 恒非致命拦不住 / 数字前缀会让铁律条数漂移 / `c-` 语义不符）。
		// ⚠️ 判据只取 `byName`（文件名 = composition_id），**不含** innerCid 命中：
		//   铺轨链路上交付物的文件名恒 = composition_id（:151/:174），2026-09-07 那 10 个正是这形态；
		//   而改过名的临时副本（`tmp.html`）里同样含 cid，若按 innerCid 判就会误杀
		//   `1-cid-expect` 明文祝福的那条豁免（mg-command/spec.md:64 与 Scenario :114）。
		//   本处偏离了 tasks 6.1 括注里的「或 HTML 内 cid 命中」，理由见 tasks 6.1 下的施工记。
		if (byName) {
			const { baseDir } = resolveDispatch(opts);
			if (!isInsideDir(file, baseDir)) {
				throw new Error(
					`颗粒不在工程目录内，已拒绝：${resolve(file)}
` +
						`  工程根：${baseDir}
` +
						`  该文件命中派单条目 ${byName.composition_id}，即它是一件正式交付物；` +
						`交付物 SHALL 直接产在工程目录里，MUST NOT 先写别处再拷进来。
` +
						`  出路：把它**直接产到** ${join(baseDir, "mg", `${byName.composition_id}.html`)}，然后对那个路径跑本命令。`,
				);
			}
		}
	}
	// 无派单命中时：文件名形如 composition_id 才拿它当期望 id（改过名的临时副本不比对，防误判致命）
	if (compositionId === undefined && CID_SHAPE.test(nameId)) compositionId = nameId;
	const lint = lintParticle(html, {
		...(dispatchIds ? { dispatchIds } : {}),
		...(compositionId ? { compositionId } : {}),
		...(slotDuration ? { slotDuration } : {}),
		identity: particleState,
	});
	for (const vv of lint.violations) (vv.fatal ? log.err : log.warn)(`${vv.fatal ? "✗" : "·"} ${vv.law}: ${vv.msg}`);
	if (lint.ok) log.ok(`lint 通过（${basename(file)}；opaque=${lint.opaque}；${describeState(particleState)}）`);
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

/**
 * fetch 模式（add-mg-registry-neutral-source）：registry 中性块 → 候选态（离线）/ 取块态（三源 + sha256 → 机械改写八条 → lint → 落盘）。
 * 产物只落 `<project>/mg/<composition_id>.html`（派单模式）或 `--out`（独立模式，缺省 ./mg-fetch/）；lint 致命项不过 MUST NOT 落盘。
 */
async function runFetch(args: string[], opts: MgOpts): Promise<MgResult> {
	const snap = loadSnapshot();
	const query = args.join(" ").trim();
	const top = Math.max(1, Number(opts.top ?? 3) || 3);
	const pickName = opts.pick ?? (query && findBlock(query, snap) ? query : undefined);

	// ── 候选态（零网络）──
	if (!pickName) {
		if (!query) {
			throw new Error(
				"用法：gtrk mg fetch <检索词|块名> [--top 3] [--all]（候选态）；取块：gtrk mg fetch --pick <块名> --slot <beat> --project <dir>，或 --pick <块名> --as <composition_id> --duration <sec> [--out <dir>]",
			);
		}
		const cands = searchBlocks(query, snap, { top, includeExcluded: Boolean(opts.all) });
		log.step(`▶ registry 候选：「${query}」→ ${cands.length} 件（快照 ${snap.source.snapshot_date} @ ${snap.source.commit.slice(0, 12)}，离线）`);
		for (const c of cands) {
			const it = c.item;
			log.info(`${it.name}  ${it.title}  [${it.compat}]  ${it.duration ?? "?"}s  ${it.width}×${it.height}  tags=${it.tags.join(",")}`);
			log.info(`   海报：${it.preview.poster ?? "-"}${it.preview.video ? `  视频：${it.preview.video}` : ""}`);
			if (it.compat !== "ok") log.info(`   ⚠ ${it.compat_reasons.join("；")}`);
		}
		if (cands.length === 0) log.warn("无候选——换个检索词（中文可用：数据 / 图表 / 标题 / 字幕 / 转场 / 通知 / 代码 / 地图 / 手写 / 卡片 / 片头 …）");
		return done(opts, {
			ok: true,
			mode: "fetch",
			stage: "candidates",
			query,
			snapshot: snap.source,
			candidates: cands.map((c) => ({
				name: c.item.name,
				title: c.item.title,
				description: c.item.description,
				compat: c.item.compat,
				compat_reasons: c.item.compat_reasons,
				duration: c.item.duration,
				width: c.item.width,
				height: c.item.height,
				tags: c.item.tags,
				preview: c.item.preview,
				score: c.score,
				hits: c.hits,
			})),
		});
	}

	// ── 取块态 ──
	const item: SnapshotItem | undefined = findBlock(pickName, snap);
	if (!item) throw new Error(`快照里没有块「${pickName}」（先用候选态检索：gtrk mg fetch <检索词>）`);
	if (item.compat === "excluded") {
		throw new Error(`块「${item.name}」被预筛排除，不在可取范围：${item.compat_reasons.join("；")}。要用请自行去 registry 取（那是你的选择，不经本命令）`);
	}
	if (item.compat === "review") log.warn(`块「${item.name}」标 review（${item.compat_reasons.join("；")}）——可取，但 MUST 真渲验收后再交付`);
	if (opts.canvas) {
		const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(opts.canvas.trim());
		if (!m) throw new Error(`--canvas 格式应为 WxH：${opts.canvas}`);
		if (Number(m[1]) !== PARTICLE_W || Number(m[2]) !== PARTICLE_H) {
			throw new Error(`契约当前只收 ${PARTICLE_W}×${PARTICLE_H} 颗粒（lint 铁律 1）：竖屏 / 异形画布请走栏目 skill，或等契约开口；registry 中性块不适用`);
		}
	}
	if (opts.category !== undefined && opts.category !== "overlay" && opts.category !== "fullscreen") {
		throw new Error(`--category 只收 overlay / fullscreen：${opts.category}`);
	}

	let cid: string;
	let slotSec: number;
	let category: "overlay" | "fullscreen" | undefined = opts.category as "overlay" | "fullscreen" | undefined;
	let outPath: string;
	if (opts.slot) {
		const { dispatchPath, baseDir } = resolveDispatch(opts);
		const queue = await readMgQueue(dispatchPath);
		const q = queue.find((x) => x.beat === opts.slot || x.composition_id === opts.slot);
		if (!q) {
			throw new Error(`派单里没有 beat「${opts.slot}」；现有：${[...new Set(queue.map((x) => x.beat))].slice(0, 12).join("、") || "（空）"}`);
		}
		cid = q.composition_id;
		slotSec = r3(q.track_ed - q.track_st);
		if (!(slotSec > 0)) throw new Error(`派单条目 ${cid} 的坑位包络非正（track_st=${q.track_st} track_ed=${q.track_ed}）`);
		if (!category && typeof q.category === "string" && (q.category === "overlay" || q.category === "fullscreen")) category = q.category;
		outPath = join(baseDir, "mg", `${cid}.html`);
	} else {
		if (!opts.as || !opts.duration) {
			throw new Error("取块需指明落点：派单模式 --slot <beat> --project <dir>；独立模式 --as <composition_id> --duration <sec> [--out <dir>]");
		}
		cid = opts.as;
		slotSec = Number(opts.duration);
		if (!(slotSec > 0)) throw new Error(`--duration 必须为正数秒：${opts.duration}`);
		const outDir = resolve(opts.out ?? "./mg-fetch");
		assertNotJianyingDraftDir(outDir);
		outPath = join(outDir, `${cid}.html`);
	}

	const file = primaryFile(item);
	log.step(`▶ 取块 ${item.name}（${file.path}，${file.bytes} B，sha256 ${file.sha256.slice(0, 12)}…）`);
	const got = await fetchBlockFile(snap, item, file);
	for (const a of got.attempts) log.info(`[${a.id}] ${a.ok ? "✓" : "✗"} ${a.url}${a.reason ? `（${a.reason}）` : ""} ${a.ms}ms`);

	let adopted;
	try {
		adopted = adoptBlock(got.html, {
			compositionId: cid,
			slotSec,
			...(category ? { category } : {}),
			font: opts.font ?? DEFAULT_FONT,
			blockWidth: item.width,
			blockHeight: item.height,
			...(typeof item.duration === "number" ? { declaredDurationSec: item.duration } : {}),
		});
	} catch (e) {
		if (e instanceof AdoptError) throw new Error(`改写失败（${e.reason}）：${e.message}`);
		throw e;
	}
	log.step("▶ 机械改写");
	for (const l of adopted.log) log.info(l);

	const lint = lintParticle(adopted.html, { compositionId: cid, slotDuration: slotSec, category: adopted.category });
	for (const vv of lint.violations) (vv.fatal ? log.err : log.warn)(`${vv.fatal ? "✗" : "·"} ${vv.law}: ${vv.msg}`);
	const base = {
		mode: "fetch" as const,
		stage: "adopted",
		name: item.name,
		compat: item.compat,
		source: got.source,
		url: got.url,
		composition_id: cid,
		slot_sec: slotSec,
		category: adopted.category,
		timing: adopted.timing,
		editable: adopted.editable,
		log: adopted.log,
		lint: { ok: lint.ok, opaque: lint.opaque, violations: lint.violations },
	};
	if (!lint.ok) {
		log.err(`lint 致命项未过（${lint.violations.filter((v) => v.fatal).length} 项），不落盘`);
		return done(opts, { ...base, ok: false });
	}
	await mkdir(dirname(outPath), { recursive: true });
	await writeFile(outPath, adopted.html, "utf8");
	log.ok(`已落 ${outPath}（${adopted.category}；时长处置 ${adopted.timing.action}${adopted.timing.factor ? ` ×${adopted.timing.factor}` : ""}）`);
	log.warn(`这是中性骨架：文案 ${adopted.editable.texts.length} 处 / 数值数组 ${adopted.editable.numberArrays.length} 处 / 色值 ${adopted.editable.colors.length} 个 MUST 按 beat 与栏目改写后再 lint、再铺，MUST NOT 原样铺`);
	return done(opts, { ...base, ok: true, stage: "written", path: outPath });
}

function done(opts: MgOpts, result: MgResult): MgResult {
	// ③（fix-mg-lay-strip-scope 2.4/2.5，2026-07-26 拍板取「一起变严」）：`ok:false` 一律连带非 0 退出码。
	// 本 CLI 的主要消费者是 agent，「ok:false + 退出码 0」是静默错判的源头（`--lint-only` 今日正是该形态）。
	// 姿势对齐同仓既有：tool.ts / music-visualizer.ts / doctor.ts。
	if (!result.ok) process.exitCode = 1;
	if (opts.json) console.log(JSON.stringify(result));
	return result;
}
