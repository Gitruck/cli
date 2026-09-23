/**
 * `.gtrk` 写方不变量自检的**唯一正本**（openspec: add-lay-writer-self-check，capability `gtrk-writer-invariants`）。
 *
 * 法源：`time-domain-discipline`（批 0 `link-time-domain-discipline`）
 *   - T4 容差只有 1ms / 1 帧——本模块里**唯一**的容差是素材上界那 1ms，恒等式与重叠零容差；
 *   - T5 任何写出 `clip_ed` 的模块 SHALL 自证 `clip_ed ≤ materials[].duration + 1ms`；
 *   - T7 写方自检在**唯一出口**（写回前），不靠读侧、不靠悔棋期（`gtrk patch` 校验器只在用户主动悔棋时才跑）。
 *
 * 三条断言 + 一次调：
 *   - `assertTrimIdentity`      裁剪恒等式（`gtrk-patch.ts` E1 / E2 镜像，整毫秒域零容差）——原 `matrix-lay.ts` 搬入，判据一字未改；
 *   - `assertTrackContinuity`   同轨零重叠（E9 镜像，整毫秒域零容差）——原 `matrix-lay.ts` 搬入，判据一字未改；
 *   - `assertSourceBound`       素材上界（E5 上界镜像，`+1ms` 是唯一容差；material 无 `duration` 跳过）——本 change 新增；
 *   - `assertGtrkWriteInvariants` 整份 gtrk：`video_track` / `audio_track` 三件都查，`beat_track` 只查 track 半边恒等式 + 重叠
 *     （`audio_track` 自 add-cross-clock-adapter D6 纳入；`audio lay` 同批接线，存量违例 WARN）。
 *
 * 判据与 `gtrk-patch.ts` E1 / E2 / E5 / E9 及 infra `video_project/gtrk_check.py` **逐字同源**：
 * 整毫秒域（`sec2ms` 半上入）、恒等式与重叠零容差、上界 `+1ms`、beat / gap 只查 track 半边、无 `duration` 跳过上界。
 * MUST NOT 在任何 lay 模块内复刻这些判据——复制一遍就是给「两份判据慢慢漂开」留门（fix-mg-beat-clip-track-ed D2 的教训）。
 *
 * 依赖面：只 import `frame-domain`（零 IO 换算叶子）；被 `matrix-lay` / `mg-lay` / `ai-drama-lay` import。
 * `matrix-lay.ts` 对前两条 re-export，既有 `import { assertTrimIdentity } from "./matrix-lay"` 路径不变（design D1）。
 * 不变量断言**不**放进 `frame-domain.ts`：那是零契约知识的换算叶子，塞进 clip / material 形状与错误文案会让叶子长出契约。
 *
 * 违约即抛、零副作用：所有调用点 MUST 在 `writeGtrkAtomic` 之前——抛了工程文件逐字节不变（design D2）。
 * 「先量化再开抛」：接线前已在全部铺轨金样 / MG / AI 再现用例 / 真机工程副本上以报告模式（`collectWriteViolations`）
 * 跑过一遍：三个写方**自己写出的** clip 四类违例 0；真机副本另有 35 条存量违例，全部由旧客户端重存产生
 * （帧格值 `48.666…` 落到毫秒格后恒等式差 1ms）（tasks 1.1）。
 *
 * 射程（design D2′，2026-09-06）：`assertGtrkWriteInvariants` 带 `ownClipIds` 时只对**本次写出的 clip** 断言恒等式与
 * 素材上界；同轨重叠断言覆盖「本次 clip × 同轨相邻任一邻居」（落位是本次的责任，邻居是不是存量都不许压）；
 * 其余存量 clip 的违例走报告模式收集，经 `warn` 回调打**一条**可读汇总，MUST NOT 阻断——写方证明自己写的，
 * 不替旧客户端的历史埋单。不带 `ownClipIds` = 整份射程（测试 / 报告用）。容差 MUST NOT 因存量放宽。
 *
 * `beat_track` 重叠的**唯一**豁免（design D6）：同一 composition 家族——主颗粒 `<slug>-B<n>` 与其 `-aux<k>` 派生、
 * 或同主的两枚 aux——契约明文允许同窗叠放（mg-command「同 beat 主 + aux 两颗粒各自成 clip 不撞」，
 * add-aux-rrv-overlay-particle：aux 是叠在主颗粒之上的透明覆层）。`video_track` 无此豁免。
 * `gtrk-patch.ts` E9 今天对 beat 轨不分家族一律判重叠 ⇒ 在含 aux 的工程上是假阳性，归 patch 侧另立 fix（本件转出项）。
 */
import { sec2ms } from "./frame-domain";

/** 四类违例。与 infra `gtrk_check.py` 的 kind 逐字同名（D5「两仓同一份坏 gtrk 同判」）。 */
export type InvariantKind = "clip_identity" | "track_identity" | "overlap" | "source_overrun";

/**
 * 不变量违约。`message` 是给人读的中文（点名 clip_id 与不变量）；`kind` / `clipId` 是给机器读的
 * ——报告模式（`collectWriteViolations`）与两仓对拍测试靠它们逐条比对，MUST NOT 靠解析 message。
 * 重叠时 `clipId` 取**后一颗**（track_st 侵入前一颗 track_ed 的那颗），message 两颗都点名。
 */
export class GtrkInvariantError extends Error {
	readonly kind: InvariantKind;
	readonly clipId: string | undefined;
	constructor(kind: InvariantKind, clipId: string | undefined, message: string) {
		super(message);
		this.name = "GtrkInvariantError";
		this.kind = kind;
		this.clipId = clipId;
	}
}

/** 秒 → 整毫秒；非 number 透出 undefined（缺席字段 = 该半边不查，与 `gtrk-patch.ts` 的 `Number.isFinite` 守卫同义）。 */
const ms = (v: number | undefined): number | undefined => (typeof v === "number" ? sec2ms(v) : undefined);

/**
 * 写方自检：裁剪恒等式（fix-trim-identity-constructive §3.1）。
 *
 * ★ 为什么必须是**写方**自检，而不是只靠 `gtrk-patch.ts` 的 E1/E2：
 * 那条校验器只在用户**主动悔棋**（跑 `gtrk patch`）时才经过，于是违约可以长期无声
 * 存在——实测存量 55/352 槽位（15.6%），而全套测试照样绿、客户端也不报错，
 * 唯一的症状是「成片可能用陈旧出点」和「悔棋通道在自家产物上失效」。
 *
 * 判据与 `gtrk-patch.ts` 逐字同源：**整毫秒域、零容差**。
 * MUST NOT 在这里放宽成「差 1ms 以内可接受」——那正是本缺陷的形状。
 *
 * 只给 track 半边（无 `clip_st` / `clip_ed`：gap、beat 颗粒）时只查 track 半边——E7 / E8 禁止它们带源裁剪字段，
 * 于是「不带就不查」与 `gtrk-patch.ts` 的分流同义。
 */
export function assertTrimIdentity(
	c: { clip_id?: string; clip_st?: number; clip_ed?: number; track_st?: number; track_ed?: number; duration: number },
	where: string,
): void {
	const [cs, ce, ts, te, du] = [ms(c.clip_st), ms(c.clip_ed), ms(c.track_st), ms(c.track_ed), ms(c.duration)!];
	if (cs !== undefined && ce !== undefined && ce - cs !== du) {
		throw new GtrkInvariantError(
			"clip_identity",
			c.clip_id,
			`铺轨自检失败（${where}）：clip_ed − clip_st = ${ce - cs}ms ≠ duration ${du}ms。` +
				"裁剪恒等式须**构造性成立**（composition-contract-v1 §3），" +
				"两个端点 MUST NOT 各自舍入——见 slotTimes 头注。",
		);
	}
	if (ts !== undefined && te !== undefined && te - ts !== du) {
		throw new GtrkInvariantError(
			"track_identity",
			c.clip_id,
			`铺轨自检失败（${where}）：track_ed − track_st = ${te - ts}ms ≠ duration ${du}ms。`,
		);
	}
}

/**
 * 写方自检：同轨零重叠（fix-slot-seam-continuity）。
 *
 * ★ 为什么与 `assertTrimIdentity` 分两条：那条管的是**单颗槽位内部**两个时基自洽，
 * 这条管的是**相邻两颗之间**。前者全绿时后者照样可以塌——上一版就是这么塌的：
 * 恒等式构造性成立了，接缝却在非整毫秒相位上差 1ms，而 `gtrk render` 对同轨重叠
 * 是零容差硬拒（E9），真机三条工程全部渲不出来，全套测试却是绿的。
 *
 * 判据与 `gtrk-patch.ts` 的 E9 逐字同源：**整毫秒域、零容差**。
 *
 * ⚠️ 本条只判**重叠**，不判空洞：候选枯竭造成的留空是有意为之（填槽循环里
 * 「宁空不重复」那条铁律的正常产物），在这里看不出与违约的区别——
 * 「相邻两颗中间有没有过一次空槽推进」这个信息只在填槽循环内存在，到组装期已经丢了。
 * 所以**严格接缝**（两个方向都管，含 1ms 空洞）由填槽循环内那条断言负责，
 * 本条是覆盖全轨的兜底网：重叠在任何情况下都不合法，无需分流即可判。
 */
export function assertTrackContinuity(
	clips: { clip_id?: string; track_st?: number; track_ed?: number }[],
	where: string,
): void {
	const ordered = clips
		.filter((c) => typeof c.track_st === "number" && typeof c.track_ed === "number")
		.sort((a, b) => a.track_st! - b.track_st!);
	for (let i = 0; i + 1 < ordered.length; i++) {
		const prevEd = ms(ordered[i]!.track_ed)!;
		const nextSt = ms(ordered[i + 1]!.track_st)!;
		if (nextSt < prevEd) {
			throw new GtrkInvariantError(
				"overlap",
				ordered[i + 1]!.clip_id,
				`铺轨自检失败（${where}）：同轨相邻槽位重叠 ${prevEd - nextSt}ms` +
					`（${ordered[i]!.clip_id ?? "?"} 的 track_ed=${ordered[i]!.track_ed} > ` +
					`${ordered[i + 1]!.clip_id ?? "?"} 的 track_st=${ordered[i + 1]!.track_st}）。` +
					"接缝两侧 MUST 由同一个表达式求值——见 slotTimes 头注。",
			);
		}
	}
}

/** `materials[]` 里 material 的最小形状：只看 `duration`。 */
export interface MaterialDurationLike {
	duration?: unknown;
}

/** `materials[]`（任意形状）→ id → material。id 非 string 的条目跳过（无从被 clip 引用）。 */
export function materialsByIdOf(materials: unknown): Map<string, MaterialDurationLike> {
	const m = new Map<string, MaterialDurationLike>();
	if (!Array.isArray(materials)) return m;
	for (const raw of materials) {
		if (typeof raw !== "object" || raw === null) continue;
		const mat = raw as { id?: unknown; duration?: unknown };
		if (typeof mat.id === "string" && mat.id) m.set(mat.id, mat);
	}
	return m;
}

/**
 * 写方自检：素材上界（T5；`gtrk-patch.ts` E5 上界镜像）。
 *
 * 判据：clip 有源（`material` 是 string 且在 `materialsById` 里）且该 material 的 `duration` 是**有限正数**时，
 * `sec2ms(clip_ed) ≤ sec2ms(duration) + 1`。那 1ms 是全套自检里**唯一**的容差（T4）：`clip_ed` 是帧域导出量、
 * `f2ms` 不可加的残差恒 ≤1ms ⇒ 贴素材尾部的 clip 被纯 move 后会溢出 1ms。
 * 容差 MUST NOT 扩大、MUST NOT 用于恒等式与重叠。
 *
 * 跳过（design D3）：material 无 `duration`（黑底 / 纯色 / html 颗粒 / 静图——`matrix-lay.ts`「黑片 material
 * MUST NOT 带 duration」既有铁律相容）、clip 无 `clip_ed`（gap / beat 颗粒）、material 不在表里（那是 E4 的事，
 * 不在本条射程）。B-roll 代理与原片时长可能不同：判据用 `materials[]` 里登记的那条——写方写的就是它——本条不另探测；
 * 「登记的那条是不是文件本身的真值」归 `clock-adapter.ts`（add-cross-clock-adapter：preview 代理落盘即实测、
 * `materials[]` 写文件真值，自述只作比对），墙的真相源换了，本条判据一个字没改。
 */
export function assertSourceBound(
	clips: { clip_id?: string; material?: unknown; clip_ed?: number }[],
	materialsById: ReadonlyMap<string, MaterialDurationLike>,
	where: string,
): void {
	for (const c of clips) {
		if (typeof c.material !== "string" || typeof c.clip_ed !== "number") continue;
		const mat = materialsById.get(c.material);
		if (!mat) continue;
		const dur = mat.duration;
		if (typeof dur !== "number" || !Number.isFinite(dur) || dur <= 0) continue;
		const ceMs = sec2ms(c.clip_ed);
		const durMs = sec2ms(dur);
		if (ceMs > durMs + 1) {
			throw new GtrkInvariantError(
				"source_overrun",
				c.clip_id,
				`铺轨自检失败（${where}）：${c.clip_id ?? "?"} 的 clip_ed=${c.clip_ed}s 超出素材 ${c.material} 的时长 ${dur}s` +
					`（越界 ${ceMs - durMs}ms，容差 1ms）[source_overrun]。` +
					"源窗 MUST 钳在素材实测时长内——检查 plan 候选的 segments / 代理解码时长，或对该槽位重铺。",
			);
		}
	}
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

/**
 * 三件套在一份 gtrk 上的射程：`video_track` / `audio_track` 三件都查（音频 clip 同样有源裁剪与素材上界：
 * BGM 越素材 = 客户端播到素材尾巴后静音，与视频越素材同一形状）；`beat_track` 颗粒无源裁剪，只查 track 半边恒等式 + 重叠。
 * `audio_track` 由 add-cross-clock-adapter D6 纳入（T5 末句「任何写出 `clip_ed` 的模块 SHALL 自证上界」此前对音频轨落空）；
 * 扩射程前已在夹具与真机工程上量化存量违例（见该 change tasks 1.2）。
 */
const WRITE_SCOPES: ReadonlyArray<{ key: "video_track" | "audio_track" | "beat_track"; withSource: boolean }> = [
	{ key: "video_track", withSource: true },
	{ key: "audio_track", withSource: true },
	{ key: "beat_track", withSource: false },
];

/** 一条待检轨：`label` 进错误文案；`clips` 是 `track_timeline` 里的对象元素（非对象元素跳过，与 `collectElements` 同义）。 */
function tracksOf(gtrk: Obj, where: string): Array<{ label: string; withSource: boolean; clips: Obj[] }> {
	const out: Array<{ label: string; withSource: boolean; clips: Obj[] }> = [];
	for (const { key, withSource } of WRITE_SCOPES) {
		const tracks = Array.isArray(gtrk[key]) ? (gtrk[key] as unknown[]) : [];
		tracks.forEach((t, ti) => {
			if (!isObj(t)) return;
			const idx = typeof t.track_index === "number" ? t.track_index : ti;
			const clips = (Array.isArray(t.track_timeline) ? (t.track_timeline as unknown[]) : []).filter(isObj);
			out.push({ label: `${where} ${key}[${idx}]`, withSource, clips });
		});
	}
	return out;
}

type ClipLike = { clip_id?: string; clip_st?: number; clip_ed?: number; track_st?: number; track_ed?: number; duration: number; material?: unknown };

/** beat 颗粒只看 track 半边：即便某颗违契约带了 `clip_st` / `clip_ed`，本条也不据此判——那是 E7 / E8 的射程。 */
const trackSideOnly = (c: Obj): ClipLike => ({
	clip_id: c.clip_id as string | undefined,
	track_st: c.track_st as number | undefined,
	track_ed: c.track_ed as number | undefined,
	duration: c.duration as number,
});

const labelOf = (c: Obj): string => (typeof c.clip_id === "string" && c.clip_id ? c.clip_id : "(gap)");

/** composition_id 形状（split-doc-contract）：`<slug>-B<数字>` 主颗粒，`<slug>-B<数字>-aux<n>` 派生覆层。 */
const AUX_SUFFIX = /-aux\d+$/i;
const MAIN_SHAPE = /-B\d+$/i;

/**
 * beat 轨重叠豁免判据（design D6）：两枚颗粒属同一 composition 家族——主 `<slug>-B<n>` 与其 `-aux<k>`，或同主的两枚 aux。
 * 只认契约形状：去掉 `-aux<n>` 后须形如 `…-B<数字>` 且两边相同；两边 id 相同（同 id 撞车）不豁免。
 * 只用于 `beat_track`；`video_track` 的重叠没有任何豁免。
 */
export function isSameParticleFamily(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b || a === b) return false;
	const baseA = a.replace(AUX_SUFFIX, "");
	const baseB = b.replace(AUX_SUFFIX, "");
	return baseA === baseB && MAIN_SHAPE.test(baseA);
}

/** 报告模式的一条违例（机读三元 + 人读文案）。 */
export interface WriteViolation {
	kind: InvariantKind;
	clip_id: string | undefined;
	where: string;
	message: string;
}

/**
 * 写方射程（design D2′）。
 * - `ownClipIds`：本次写出的 clip_id 集合。给了就只对它们（及与它们同轨相邻的重叠）**抛**，其余存量只**收集**；
 *   不给 = 整份射程，任何一条违例都抛（测试 / 报告用）。
 * - `warn`：存量违例的 WARN 出口。本模块零 IO——命令层接 `log.warn`、`matrix-lay` 接自己的 `warnings[]`。
 *   缺省丢弃（纯函数单测不需要看它）。
 */
export interface WriteInvariantScope {
	ownClipIds?: ReadonlySet<string>;
	warn?: (message: string) => void;
}

/** 存量违例 WARN 样本 clip_id 上限：够定位、不刷屏（全量走 `collectWriteViolations`）。 */
const LEGACY_SAMPLE_IDS = 3;

/**
 * 存量违例汇总成**一条** WARN（kind 计数 + 前 3 个 clip_id + 修复指引）。
 * 导出只为测试逐字对拍文案骨架；判据不在这里。
 */
export function formatLegacyViolations(violations: readonly WriteViolation[]): string {
	const counts = new Map<InvariantKind, number>();
	for (const v of violations) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
	const kinds = [...counts.entries()].map(([k, n]) => `${k} ${n}`).join("、");
	const ids: string[] = [];
	for (const v of violations) {
		const id = v.clip_id ?? "(gap)";
		if (!ids.includes(id)) ids.push(id);
		if (ids.length >= LEGACY_SAMPLE_IDS) break;
	}
	const more = violations.length > ids.length ? " 等" : "";
	return (
		`写方自检：工程内有 ${violations.length} 条**存量**不变量违例（非本次写出，不阻断本次写回）：${kinds}；` +
		`clip_id 样本：${ids.join("、")}${more}。` +
		"由客户端重存或旧版本产生，重存或 `gtrk patch` 可修。"
	);
}

/**
 * 三件套在一份 gtrk 上走一遍的**唯一**遍历：逐颗（恒等式 / 上界）、逐对相邻（重叠）调用上面三条断言。
 * `strict(ids)` 决定该单元的违例是**抛**（true）还是**收集**进返回值（false）——
 * 整份断言 = 恒 true；报告模式 = 恒 false；D2′ 射程 = 单元里任一 clip_id 属本次写出。
 * ⚠️ 本函数 MUST NOT 自带判据——所有判定都发生在三条断言里；这里只负责「拆成最小单元 + 分流」。
 */
function walkWriteInvariants(gtrk: Obj, where: string, strict: (ids: Array<string | undefined>) => boolean): WriteViolation[] {
	const out: WriteViolation[] = [];
	const mats = materialsByIdOf(gtrk.materials);
	const run = (label: string, ids: Array<string | undefined>, fn: () => void): void => {
		if (strict(ids)) {
			fn();
			return;
		}
		try {
			fn();
		} catch (e) {
			if (!(e instanceof GtrkInvariantError)) throw e;
			out.push({ kind: e.kind, clip_id: e.clipId, where: label, message: e.message });
		}
	};
	const idOf = (c: Obj): string | undefined => (typeof c.clip_id === "string" ? c.clip_id : undefined);
	for (const { label, withSource, clips } of tracksOf(gtrk, where)) {
		for (const c of clips) {
			const unit = `${label} ${labelOf(c)}`;
			run(unit, [idOf(c)], () => assertTrimIdentity(withSource ? (c as ClipLike) : trackSideOnly(c), unit));
			if (withSource) run(unit, [idOf(c)], () => assertSourceBound([c as ClipLike], mats, unit));
		}
		const ordered = clips
			.filter((c) => typeof c.track_st === "number" && typeof c.track_ed === "number")
			.sort((a, b) => (a.track_st as number) - (b.track_st as number));
		for (let i = 0; i + 1 < ordered.length; i++) {
			const pair = [ordered[i]!, ordered[i + 1]!];
			const ids = pair.map(idOf);
			// beat 轨：主颗粒与其 aux 覆层同窗叠放是契约行为（D6），不是接缝违约
			if (!withSource && isSameParticleFamily(ids[0], ids[1])) continue;
			run(label, ids, () => assertTrackContinuity(pair as ClipLike[], label));
		}
	}
	return out;
}

/**
 * 三件一次调：写方在 `writeGtrkAtomic` **之前**对「即将写出的整份 gtrk」跑一遍。
 * 任何一条在射程内的违约即抛 `GtrkInvariantError`（点名 clip_id 与不变量）；抛了就不写，工程文件逐字节不变。
 *
 * 射程（D2′）：
 * - 给 `opts.ownClipIds` ⇒ 本次写出的 clip 查恒等式 + 上界；重叠查「本次 clip × 同轨相邻任一邻居」；
 *   其余存量违例收集后经 `opts.warn` 打**一条** WARN，MUST NOT 抛。
 * - 不给 ⇒ 整份文件任何一颗坏 clip 都抛（测试 / 报告器的口径）。
 */
export function assertGtrkWriteInvariants(gtrk: Obj, where: string, opts: WriteInvariantScope = {}): void {
	const own = opts.ownClipIds;
	if (!own) {
		walkWriteInvariants(gtrk, where, () => true);
		return;
	}
	const legacy = walkWriteInvariants(gtrk, where, (ids) => ids.some((id) => id !== undefined && own.has(id)));
	if (legacy.length) opts.warn?.(formatLegacyViolations(legacy));
}

/**
 * 报告模式：与 `assertGtrkWriteInvariants` **同一套断言、同一遍历**（`walkWriteInvariants`），但不在第一条违例处停——
 * 一份文件里的每一条违例都被数到。
 *
 * 用途：tasks 1.1「先量化再开抛」的报告器，与两仓对拍测试（D5：同一份坏 gtrk 夹具，kind + clip_id 逐条相等）。
 */
export function collectWriteViolations(gtrk: Obj, where = "report"): WriteViolation[] {
	return walkWriteInvariants(gtrk, where, () => false);
}
