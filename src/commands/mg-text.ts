/**
 * gtrk mg 的文字模板三口（change add-text-template-source）：
 *
 *   gtrk mg fetch --source text <检索词>        候选态（离线可用）/ 取块态
 *   gtrk mg compile <ir.json> [--out <dir>]     改 IR 重编译（L0，本地跑、0 积分、零请求）
 *   gtrk mg edit <particle.html> --say "<要求>"  自然语言改写（2 积分/候选）
 *
 * 与中性块 registry 那条路**刻意不同的一点**：文字模板 MUST NOT 走机械改写。
 * 中性块来自第三方、要替字体换色板才合规；文字模板是我方 clean-room 重写的，
 * 一旦改 HTML 字节，它就从 `ir` 态掉到 `detached`——云端再也调不动了。
 * 改内容只有两条路：改 IR 后 `compile`，或者 `edit` 让云端改。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { log } from "../lib/log";
import { lintParticle } from "../lib/mg-lint";
import { assertNotJianyingDraftDir } from "../lib/mg-render";
import { describeState, identifyParticle } from "../lib/particle-identity";
import {
	compileIr as compileIrRemote,
	generateParticle,
	GENERATE_PRICE_KEY,
	type GenerateCandidate,
} from "../lib/text-ir-client";
import { compileIrLocal } from "../lib/text-ir/compile-local";
import { resolveToolPricing } from "../lib/tool-pricing";
import {
	describeCatalog,
	fetchTemplateHtml,
	findTemplate,
	pinTemplateIr,
	resolveCatalog,
	searchTemplates,
	SLOT_MARGIN_SEC,
	type ResolvedCatalog,
	type TextTemplateItem,
	categoryOf,
} from "../lib/text-templates";
// 派单读取与 registry 中性块路共用同一份口径（fix-mg-fetch-text-slot-identity）
import { matchSlot, readMgQueue, resolveDispatch } from "../lib/mg-dispatch";
import { r3 } from "../lib/frame-domain";

export interface TextCmdOpts {
	pick?: string;
	top?: string;
	as?: string;
	out?: string;
	slot?: string;
	project?: string;
	dispatch?: string;
	/** 独立模式：坑位时长锚（秒）。派单模式不收它——那边的包络由 dispatch 定。 */
	duration?: string;
	say?: string;
	n?: string;
	yes?: boolean;
	json?: boolean;
	offline?: boolean;
	/** `mg compile` 走服务端而不是本地。排查与对拍用（§4.1），不是默认路径。 */
	remote?: boolean;
}

/** 候选数只有两档：确认框的金额就只有两种，用户不必在 1/2/3 之间做无意义的权衡。 */
const ALLOWED_N = [1, 3];

function parseN(raw: string | undefined): number {
	if (raw === undefined) return 1;
	const n = Number(raw);
	if (!ALLOWED_N.includes(n)) {
		throw new Error(`--n 只接受 ${ALLOWED_N.join(" 或 ")}（收到 ${raw}）——候选数是计费单位数，n=1 与 n=3 分别对应一次和三次独立的模型调用`);
	}
	return n;
}

/** 目录来源一律明示：静默用旧目录，用户会以为新模板没发布。 */
function announceCatalog(resolved: ResolvedCatalog): void {
	const line = describeCatalog(resolved);
	if (resolved.origin === "remote") log.step(`▶ ${line}`);
	else log.warn(`▶ ${line}`);
}

// ─────────────────────────── fetch --source text ───────────────────────────

export async function runFetchText(args: string[], opts: TextCmdOpts): Promise<Record<string, unknown>> {
	const query = args.join(" ").trim();
	const top = Math.max(1, Number(opts.top ?? 3) || 3);
	const resolved = await resolveCatalog({ ...(opts.offline ? { offline: true } : {}) });
	const catalog = resolved.catalog;
	const pickId = opts.pick ?? (query && findTemplate(query, catalog) ? query : undefined);

	// ── 候选态：网络不可达也要能列（spec「候选离线可列」）──
	if (!pickId) {
		announceCatalog(resolved);
		const cands = searchTemplates(query ? query.split(/\s+/) : [], catalog, top);
		log.step(`▶ 文字模板候选：「${query || "（全部）"}」→ ${cands.length} 件`);
		for (const { item } of cands) {
			// 列分类不列 family——F/M/R 是内部来源编号，用户看不懂（主理人 260914）。
			log.info(
				`${item.id}  ${item.title}  [${categoryOf(item)}]  ${item.duration}s  槽位=${item.slots.join(",") || "-"}`,
			);
			if (item.poster) log.info(`   预览：${item.poster}`);
		}
		if (cands.length === 0) log.warn("无候选——换个检索词（中文可用：开场 / 字卡 / 标题 / 字幕 / 强调 / 打字机 / 字条 / 引用 / 气泡 / 故障 / 竖排 / 闪光 / 清单 / 计数 …）");
		return {
			ok: true,
			mode: "fetch",
			source: "text",
			stage: "candidates",
			query,
			catalog: { version: catalog.version, origin: resolved.origin, ...(resolved.reason ? { reason: resolved.reason } : {}) },
			candidates: cands.map(({ item, score }) => ({ ...item, score })),
		};
	}

	// ── 取块态 ──
	const item = findTemplate(pickId, catalog);
	if (!item) {
		throw new Error(`模板目录里没有「${pickId}」（目录 v${catalog.version}，${catalog.items.length} 件；先用候选态检索：gtrk mg fetch --source text <检索词>）`);
	}
	const target = await resolveTextTarget(item, opts);

	log.step(`▶ 取模板 ${item.id}（${item.file.path}，${item.file.bytes} B，sha256 ${item.file.sha256.slice(0, 12)}…）`);
	const got = await fetchTemplateHtml(catalog, item);
	for (const a of got.attempts) log.info(`[${a.id}] ${a.ok ? "✓" : "✗"} ${a.url}${a.reason ? `（${a.reason}）` : ""} ${a.ms}ms`);

	// 镜像块自身 MUST 是 `ir` 态：目录里的模板本就由 IR 编译而来，不是的话是**发布事故**
	// （块被直接改过 / 镜像传错文件）。静默落一颗改不动的颗粒，用户要到 `mg edit` 被拒
	// 那一刻才发现，而那时他已经在它上面改了半天。
	const src = identifyParticle(got.html);
	if (src.state !== "ir" || !src.ir) {
		throw new Error(
			`模板块 ${item.id} 自证不是 ir 态（identity=${src.state}）——目录里的模板应恒由 IR 编译而来，` +
				"这多半是发布事故（块被直接改过，或镜像传错了文件）。已零落盘，请报 issue。",
		);
	}

	// ── 钉落点：id → 期望 composition_id，canvas.duration → 坑位包络 ──
	// **改 IR、不改 HTML**：HTML 里的 `data-composition-id` / `__timelines` 注册键 / CSS 属性选择器
	// 作用域全由 IR 的 `id` 编译而来，而 lint 铁律 `1-cid-expect` 校的正是「HTML 内 id == 期望 id」。
	// 直接改字节会让这颗从 `ir` 掉成 `detached`（云端调不动），所以唯一合法的改法是改 IR 再走
	// **同一条**编译链——契约 `gsap-emit-v1.md`「模板颗粒（ir 态）的改法」。
	const pinned = pinTemplateIr(src.ir, {
		id: target.cid,
		...(target.pinDuration !== undefined ? { duration: target.pinDuration } : {}),
		// 满屏槽位：把派单声明的底色钉进 `canvas.bg`（add-text-ir-canvas-bg §5.1）。
		// 不接这根线的话，满屏槽位取模板必然撞 `x-category-opaque` 致命闸——
		// 而派单其实早就写了要用什么颜色，闸就只是在挡路。
		...(target.bg ? { bg: target.bg } : {}),
	});
	let html = got.html;
	if (pinned.changed) {
		if (pinned.id) log.step(`▶ 钉 composition_id：${pinned.id.from} → ${pinned.id.to}`);
		if (pinned.duration) {
			const why =
				target.slotSec !== undefined
					? `（坑位包络 ${target.slotSec}s + ${SLOT_MARGIN_SEC}s 余量，铁律⑦）`
					: "（--duration）";
			const layers = pinned.pinnedLayers.length ? `；贴模板末尾的层跟着钉：${pinned.pinnedLayers.join("、")}` : "";
			log.step(`▶ 钉时长：${pinned.duration.from}s → ${pinned.duration.to}s ${why}${layers}`);
		}
		if (pinned.bg)
			log.step(
				`▶ 钉满屏底色：${pinned.bg.from ?? "（模板原本没有底）"} → ${pinned.bg.to}` +
					"（派单 category=fullscreen 且写了 bg；transparent 同批翻 false）",
			);
		const res = compileIrLocal(pinned.ir);
		// 自证不过 = 编译器与三态判定的口径漂了，比落一颗坏颗粒更该当场停（同 `mg compile`）。
		const after = identifyParticle(res.html);
		if (after.state !== "ir") {
			throw new Error(`钉定后的本地产物自证失败（identity=${after.state}）——编译器与三态判定的哈希口径可能已不一致，请报 issue，不落盘`);
		}
		html = res.html;
	}

	const lint = lintParticle(html, {
		compositionId: target.cid,
		slotDuration: target.lintSec,
		identity: "ir",
		...(target.category ? { category: target.category } : {}),
	});
	for (const v of lint.violations) (v.fatal ? log.err : log.warn)(`${v.fatal ? "✗" : "·"} ${v.law}: ${v.msg}`);
	const base = {
		mode: "fetch" as const,
		source: "text",
		id: item.id,
		composition_id: target.cid,
		catalog: { version: catalog.version, origin: resolved.origin },
		fetched_from: got.source,
		url: got.url,
		identity: "ir",
		...(target.slotSec !== undefined ? { slot_sec: target.slotSec } : {}),
		duration: pinned.duration?.to ?? item.duration,
		pinned: {
			changed: pinned.changed,
			...(pinned.id ? { id: pinned.id } : {}),
			...(pinned.duration ? { duration: pinned.duration } : {}),
			...(pinned.bg ? { bg: pinned.bg } : {}),
			layers: pinned.pinnedLayers,
		},
		compiled: pinned.changed,
		lint: { ok: lint.ok, opaque: lint.opaque, violations: lint.violations },
	};
	if (!lint.ok) {
		log.err(`lint 致命项未过（${lint.violations.filter((v) => v.fatal).length} 项），不落盘`);
		return { ...base, ok: false, stage: "lint-failed" };
	}
	await mkdir(dirname(target.outPath), { recursive: true });
	// 恒 LF：哈希是三态身份的判据，CRLF 会让这颗在别的机器上被判 detached
	await writeFile(target.outPath, html, "utf8");
	log.ok(`已落 ${target.outPath}（${describeState("ir")}；${base.duration}s；槽位 ${item.slots.join("、") || "无"}）`);
	log.warn("改内容走 `gtrk mg compile`（改 IR 重编译）或 `gtrk mg edit --say`（云端改写）——直接改 HTML 会让它脱离模板，云端就调不动了。");
	return { ...base, ok: true, stage: "written", path: target.outPath };
}

interface TextTarget {
	/** 期望 composition_id：派单条目的 `composition_id` / `--as` / 模板 id。 */
	cid: string;
	outPath: string;
	/** 送 lint 的坑位包络（铁律⑦判据）。 */
	lintSec: number;
	/** 钉给 `canvas.duration` 的值；`undefined` = 不钉，保留模板时长。 */
	pinDuration?: number;
	/** 派单坑位包络（仅派单模式）——出参与日志用。 */
	slotSec?: number;
	/** 派单 category，透传 lint 做 opaque 对账（`fullscreen` 却没实心底 ⇒ 致命）。 */
	category?: "overlay" | "fullscreen";
	/**
	 * 派单声明的满屏底色，钉给 `canvas.bg`。只在 `category:"fullscreen"` 且派单写了 `bg` 时有。
	 *
	 * ⚠️ 没有它的话，满屏槽位取模板必然撞 `x-category-opaque` 致命闸（库里 103 件一件没有底），
	 * 而派单其实**早就写了要用什么颜色**——这根线不接上，闸就只是在挡路。
	 */
	bg?: string;
}

/**
 * 取块落点与钉定目标。
 *
 * ⚠️ **派单模式的 composition_id 来自 `dispatch.mg`，不是 `--slot` 的值**
 * （fix-mg-fetch-text-slot-identity）：`--slot` 收的是 beat id（`B05`），而派单条目的
 * `composition_id` 是 `<工程slug>-<beatId>`（`t07-B05`）——铺轨与 `mg lint --dispatch`
 * 都按后者对账。旧实现把前者直接当 id 用，于是派单模式**必然** `1-cid-expect` 致命。
 * 口径与 registry 中性块路共用 `matchSlot`，两条路不再各写一份。
 */
async function resolveTextTarget(item: TextTemplateItem, opts: TextCmdOpts): Promise<TextTarget> {
	if (opts.slot) {
		if (!opts.project && !opts.dispatch) throw new Error("--slot 需要配 --project <dir>（或 --dispatch <path>）");
		if (opts.duration !== undefined) {
			throw new Error("--slot 与 --duration 互斥：派单模式的坑位包络由 dispatch.mg 的 track_st / track_ed 定，显式给时长会与它打架");
		}
		const { dispatchPath, baseDir } = resolveDispatch(opts);
		const hit = matchSlot(await readMgQueue(dispatchPath), opts.slot);
		return {
			cid: hit.compositionId,
			outPath: join(baseDir, "mg", `${hit.compositionId}.html`),
			lintSec: hit.slotSec,
			// 铁律⑦：总长 ≥ 坑位 + 0.3s 余量，主叙事播完定格驻留到坑位末尾
			pinDuration: r3(hit.slotSec + SLOT_MARGIN_SEC),
			slotSec: hit.slotSec,
			...(hit.category ? { category: hit.category } : {}),
			...(hit.bg ? { bg: hit.bg } : {}),
		};
	}
	const cid = opts.as ?? item.id;
	const outDir = resolve(opts.out ?? "./mg-fetch");
	assertNotJianyingDraftDir(outDir);
	const outPath = join(outDir, `${cid}.html`);
	if (opts.duration === undefined) return { cid, outPath, lintSec: item.duration };
	const d = Number(opts.duration);
	if (!(d > 0)) throw new Error(`--duration 必须为正数秒：${opts.duration}`);
	// 独立模式无坑位包络，`--duration` 就是 lint 包络（同 `mg render` / registry 独立模式口径）
	return { cid, outPath, lintSec: d, pinDuration: d };
}

// ─────────────────────────── mg compile ───────────────────────────

export async function runCompile(args: string[], opts: TextCmdOpts): Promise<Record<string, unknown>> {
	const file = args[0];
	if (!file) throw new Error("用法：gtrk mg compile <ir.json | particle.html> [--out <dir>] [--remote]");
	const inputPath = resolve(file);
	if (!existsSync(inputPath)) throw new Error(`文件不在：${inputPath}`);
	const raw = await readFile(inputPath, "utf8");

	// 入参两收：`.ir.json` 是常规改法；**给颗粒 HTML 就是「重置回模板」**——
	// 取它内嵌的那份 IR 重编一次，被手改掉的字节全部回到模板原样。
	// 这条对 `detached` 颗粒尤其有用，那是它唯一的回头路。
	let ir: Record<string, unknown>;
	let reset = false;
	if (/^\s*</.test(raw)) {
		const embedded = identifyParticle(raw).ir;
		if (!embedded) throw new Error(`这颗没有内嵌 IR，重置不了（${inputPath}）——它不是模板颗粒，请改用本地 AI 修改`);
		ir = embedded;
		reset = true;
		log.step("▶ 从颗粒里取出内嵌 IR，按它重编（重置回模板）");
	} else {
		try {
			ir = JSON.parse(raw);
		} catch (e) {
			throw new Error(`IR 不是合法 JSON（${inputPath}）：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 默认本地编译：零请求、零计费、断网可用（change move-text-ir-compiler-to-client）。
	// `--remote` 留给排查与对拍——服务端那条路 MUST NOT 下线，它是等价闸的参照系。
	const remote = Boolean(opts.remote);
	let res;
	if (remote) {
		log.step("▶ 云端编译（0 积分，--remote 显式指定）");
		res = await compileIrRemote(ir);
	} else {
		log.step("▶ 本地编译（0 积分、零请求）");
		res = compileIrLocal(ir);
	}
	const outDir = resolve(opts.out ?? dirname(inputPath));
	assertNotJianyingDraftDir(outDir);
	const outPath = join(outDir, `${res.composition_id}.html`);

	const identity = identifyParticle(res.html);
	if (identity.state !== "ir") {
		// 产物自证不过 = 编译器与三态判定的口径漂了，比落一个坏颗粒更该当场停。
		// 本地编译之后这道自证更值钱：它是「等价闸放过去了但产物其实坏了」的现场信号。
		throw new Error(
			`${remote ? "服务端" : "本地"}产物自证失败（identity=${identity.state}）——编译器与三态判定的哈希口径可能已不一致，请报 issue，不落盘`,
		);
	}
	await mkdir(outDir, { recursive: true });
	// 恒 LF：哈希是三态身份的判据，CRLF 会让这颗在别的机器上被判 detached
	await writeFile(outPath, res.html, "utf8");
	log.ok(`已落 ${outPath}（${describeState(identity.state)}；${res.duration}s；html_sha256 ${res.html_sha256.slice(0, 12)}…）`);
	return {
		ok: true,
		mode: "compile",
		composition_id: res.composition_id,
		path: outPath,
		duration: res.duration,
		ir_sha256: res.ir_sha256,
		html_sha256: res.html_sha256,
		identity: identity.state,
		reset,
		// 对拍时要能一眼看出这一份是谁编的——两份 html_sha256 摆在一起才有意义
		compiledBy: remote ? "remote" : "local",
	};
}

// ─────────────────────────── mg edit ───────────────────────────

export async function runEdit(args: string[], opts: TextCmdOpts, deps: { confirm?: (q: string) => Promise<boolean> } = {}): Promise<Record<string, unknown>> {
	const file = args[0];
	if (!file) throw new Error('用法：gtrk mg edit <particle.html> --say "<自然语言要求>" [--n 1|3] [--pick <k>] [--yes]');
	if (!opts.say?.trim()) throw new Error("--say 必填：一句话说清要改成什么（如「打字机快一倍，副标改成青色」）");
	const n = parseN(opts.n);
	const particlePath = resolve(file);
	const html = await readFile(particlePath, "utf8");

	// ── 三态判定：本地就能拒的，不要发去云端花钱 ──
	const identity = identifyParticle(html);
	if (identity.state !== "ir") {
		const hint =
			identity.state === "detached"
				? `这颗已脱离模板（HTML 被直接改过），云端调不动了。重置回模板：\`gtrk mg compile ${file}\`（按它内嵌的 IR 重编一次，手改的字节全部回到原样）；或就这么留着，改用本地 AI 直接改。`
				: "这颗没有内嵌 IR（不是模板颗粒），云端调不动。请改用本地 AI 直接改，或换一颗文字模板。";
		log.err(`${describeState(identity.state)}：${hint}`);
		return { ok: false, mode: "edit", reason: identity.state, path: particlePath, identity: identity.state };
	}

	// ── 计费确认（--yes 跳过；拒绝 = 零云端调用）──
	const { billingHint } = await resolveToolPricing(GENERATE_PRICE_KEY, "文字颗粒自然语言改写");
	log.warn(`计费提示：${billingHint}`);
	log.warn(`本次请求 ${n} 个候选 ⇒ 计费 ${n} 个单位（候选数就是计费单位数；首次与改写同价，无免费次数）。`);
	if (!opts.yes) {
		if (opts.json) throw new Error("--json 下不弹交互确认，请显式加 --yes 承认计费");
		const go = await (deps.confirm ?? confirmViaStdin)("确认提交改写？");
		if (!go) {
			log.warn("已取消：零云端调用、零计费。");
			return { ok: false, mode: "edit", reason: "declined", declined: true, path: particlePath };
		}
	}

	log.step(`▶ 提交改写：「${opts.say.trim()}」（n=${n}）`);
	const { result, taskId } = await generateParticle(
		{ html, instruction: opts.say.trim(), n },
		(s, p) => log.info(`${s}${typeof p === "number" ? ` ${p}%` : ""}`),
	);

	// ── 拒绝：如实打印，非 0 退出码，但与网络错误区分 ──
	if (result.refusal) {
		log.warn(`服务端拒绝了这次改写：${result.refusal}`);
		log.info("这不是故障——IR 词表里没有对应的表达。换个说法，或者把这颗当底子用本地 AI 做。");
		return { ok: false, mode: "edit", reason: "refusal", refusal: result.refusal, task_id: taskId, path: particlePath };
	}
	if (result.candidates.length === 0) throw new Error(`任务完成但既无候选也无拒绝说明（task_id=${taskId}）`);

	// ── 候选落盘 ──
	const cid = basename(particlePath).replace(/\.html?$/i, "");
	const outDir = dirname(particlePath);
	const landed: { index: number; path: string; cand: GenerateCandidate }[] = [];
	for (const [index, cand] of result.candidates.entries()) {
		const candPath = join(outDir, `${cid}.cand${index}.html`);
		const body = await downloadText(cand.html_download_url);
		await writeFile(candPath, body, "utf8");
		landed.push({ index, path: candPath, cand });
	}
	log.step(`▶ ${landed.length} 个候选：`);
	for (const { index, path, cand } of landed) {
		const dup = cand.duplicate_of != null ? `  ⟲ 与候选 ${cand.duplicate_of} 相同` : "";
		log.info(`[${index}] ${cand.scope}  ${cand.html_sha256.slice(0, 12)}…  ${basename(path)}${dup}`);
		if (cand.note) log.info(`    ${cand.note}`);
	}

	// ── 选一替换（--pick 给了就直接替换，没给就只落候选让人看）──
	const base = {
		mode: "edit" as const,
		task_id: taskId,
		path: particlePath,
		billable_units: result.billable_units ?? n,
		candidates: landed.map(({ index, path, cand }) => ({ index, path, ...cand })),
	};
	if (opts.pick === undefined) {
		log.warn(`未选定：候选已落在 ${outDir}。看过之后用 \`gtrk mg edit ${file} --say "…" --pick <k>\` 重跑会再计一次费——建议直接手动把选中的候选改名覆盖原文件（原文件请先自行备份）。`);
		return { ...base, ok: true, stage: "candidates" };
	}
	const pick = Number(opts.pick);
	const chosen = landed.find((l) => l.index === pick);
	if (!chosen) throw new Error(`--pick ${opts.pick} 不在候选范围（0–${landed.length - 1}）`);
	const bakPath = join(outDir, `${cid}.bak.html`);
	await writeFile(bakPath, html, "utf8");
	await writeFile(particlePath, await readFile(chosen.path, "utf8"), "utf8");
	log.ok(`已用候选 ${pick} 替换 ${particlePath}（原件备份 ${basename(bakPath)}）`);
	return { ...base, ok: true, stage: "replaced", picked: pick, backup: bakPath };
}

async function downloadText(url: string): Promise<string> {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`候选下载失败 HTTP ${r.status}：${url}`);
	return r.text();
}

/** stdin 计费确认（与 mg render 的确认闸同款姿势）。 */
async function confirmViaStdin(question: string): Promise<boolean> {
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
		return a === "y" || a === "yes";
	} finally {
		rl.close();
	}
}
