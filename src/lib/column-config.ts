/**
 * 视频栏目配置文档（column-config spec）：schema + 四层逐维度算子折叠 + 默认兜底。
 *
 * 有效配置 = fold([L0 内置默认, L1 矩阵后端(TODO), L2 本地 ~/.gitruck/columns/<id>.json, L3 工程钉存(TODO)])，
 * P0 只落 L0+L2。逐维度算子（交并集非父子集，禁全局 deep-merge）：
 *   vocab / lanes.enabled / broll.column_tag_ids = UNION（附加不丢默认）
 *   broll.facet_allowed = INTERSECTION（收窄）
 *   lanes.appearance / broll.material_class_policy / facet_defaults / style = OVERRIDE（换装）
 * 零配置 = 只评 L0（《实在界漫游指南》全套词表），split 链路行为与词表化前逐字节等价。
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { gitruckHome } from "./paths";
import { BASE_TRACKS, CONTAINER_STAGES, LANES, NARRATIVES } from "./splitdoc";

export interface ColumnVocab {
	narrative?: string[];
	container_stage?: string[];
	base_track?: string[];
}

export interface LaneAppearance {
	code?: string;
	label?: string;
	color?: string;
	pattern?: string;
}

export interface ColumnLanes {
	/** P0 恒内置四枚举（UNION 预留，扩 lane 属 P2 承重面）。 */
	enabled?: string[];
	/** 供 opencut beat.kind 覆写通道消费（后续任务对接），P0 只透传。 */
	appearance?: Record<string, LaneAppearance>;
}

export interface ColumnBroll {
	/** 栏目标签 id——雪花大整数一律字符串传，防 JS number >2^53 精度丢失。 */
	column_tag_ids?: string[];
	material_class_policy?: string;
	facet_defaults?: Record<string, unknown>;
	facet_allowed?: string[];
}

/** style.skills 清单条目（column-style-manifest spec）：栏目自产 skill 的逻辑引用登记。
 * 框架零解析：ref 指向的内容永不读取/校验；status/routing 仅透传展示。 */
export interface StyleSkillEntry {
	id: string;
	/** 逻辑引用（本地路径；上云后可为 DB/OSS 引用），内容不内嵌。 */
	ref: string;
	/** 产物绑定的 handoff 类型（string | string[]）；命中注册集才参与路由，未命中静默惰性登记。 */
	produces?: string | string[];
	status?: string;
	/** "none" = 显式管线外，连疑似拼写提示也豁免。 */
	routing?: string;
}

export interface StyleSharedEntry {
	id: string;
	ref: string;
	role?: string;
}

/** style 块 = 不透明引用清单（add-column-style-meta-skill）。风格知识全在用户 skill 里，框架只持引用。 */
export interface ColumnStyle {
	skills?: StyleSkillEntry[];
	shared?: StyleSharedEntry[];
	/** 上云占位：打包件指向（config→DB 与 bundle→OSS 分家）。 */
	bundle_ref?: string;
}

export interface ColumnConfig {
	meta?: { id?: string; name?: string; version?: string };
	vocab?: ColumnVocab;
	lanes?: ColumnLanes;
	broll?: ColumnBroll;
	/** 不透明引用清单（见 ColumnStyle）。折叠算子 = OVERRIDE 整块（换装语义，数组不逐条 merge）；
	 * L0 内置默认不携带 style 清单（默认栏目家族也走 L2 登记，防「追加须 fork 整块」）。 */
	style?: ColumnStyle;
	fallback?: { unknown_narrative?: "allow" | "reject" };
}

/** L0 内置默认 = 《实在界漫游指南》全套词表（引用 splitdoc 现枚举），小白零配置逐字节兜底。 */
export const DEFAULT_COLUMN_CONFIG: ColumnConfig = {
	meta: { id: "real-roam-guide", name: "实在界漫游指南（内置默认）" },
	vocab: {
		narrative: [...NARRATIVES],
		container_stage: [...CONTAINER_STAGES],
		base_track: [...BASE_TRACKS],
	},
	lanes: { enabled: [...LANES] },
	fallback: { unknown_narrative: "reject" },
};

/** 本地栏目配置目录 ~/.gitruck/columns/（一栏目一文件）。 */
export function columnsDir(): string {
	return join(gitruckHome(), "columns");
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/** 宽松取字符串数组：非数组/混入非字符串项时过滤，绝不抛。 */
function strArr(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	return v.filter((x): x is string => typeof x === "string");
}

/**
 * 四层逐维度算子折叠（层序 = [L0, L1, L2, L3]，后层作用于前层累积值）。
 * 非全局 deep-merge：每个维度按自己的算子合并，未配维度不动。
 */
export function foldColumnConfigs(layers: ColumnConfig[]): ColumnConfig {
	const out: ColumnConfig = {};
	for (const l of layers) {
		if (!l || typeof l !== "object" || Array.isArray(l)) continue;

		if (l.meta && typeof l.meta === "object") out.meta = { ...out.meta, ...l.meta };

		// vocab：UNION（栏目补领域词，默认词不丢）
		if (l.vocab && typeof l.vocab === "object") {
			out.vocab ??= {};
			for (const k of ["narrative", "container_stage", "base_track"] as const) {
				const add = strArr(l.vocab[k]);
				if (add) out.vocab[k] = uniq([...(out.vocab[k] ?? []), ...add]);
			}
		}

		if (l.lanes && typeof l.lanes === "object") {
			out.lanes ??= {};
			// enabled：UNION（P0 恒四枚举，预留 P2）
			const en = strArr(l.lanes.enabled);
			if (en) out.lanes.enabled = uniq([...(out.lanes.enabled ?? []), ...en]);
			// appearance：OVERRIDE（换装）
			if (l.lanes.appearance && typeof l.lanes.appearance === "object") {
				out.lanes.appearance = l.lanes.appearance;
			}
		}

		if (l.broll && typeof l.broll === "object") {
			out.broll ??= {};
			// column_tag_ids：UNION（附加栏目标签）
			const tags = strArr(l.broll.column_tag_ids);
			if (tags) out.broll.column_tag_ids = uniq([...(out.broll.column_tag_ids ?? []), ...tags]);
			// facet_allowed：INTERSECTION（收窄；首个声明层视为全集边界）
			const fa = strArr(l.broll.facet_allowed);
			if (fa) {
				out.broll.facet_allowed = out.broll.facet_allowed
					? out.broll.facet_allowed.filter((x) => fa.includes(x))
					: [...fa];
			}
			// 其余：OVERRIDE
			if (typeof l.broll.material_class_policy === "string") out.broll.material_class_policy = l.broll.material_class_policy;
			if (l.broll.facet_defaults && typeof l.broll.facet_defaults === "object") out.broll.facet_defaults = l.broll.facet_defaults;
		}

		// style：OVERRIDE 整块（「换装」语义，数组/子块不逐条 merge）
		if (l.style !== undefined) out.style = l.style;

		if (l.fallback && typeof l.fallback === "object") {
			const un = l.fallback.unknown_narrative;
			if (un === "allow" || un === "reject") out.fallback = { unknown_narrative: un };
		}
	}
	return out;
}

export interface ResolveColumnResult {
	config: ColumnConfig;
	/** 加载途中的降级提示（配置缺失/损坏回落等）——告警不静默，命令层决定呈现。 */
	warnings: string[];
}

/** L2 本地栏目配置读取：文件缺失返回 undefined；损坏当空回落（与 readUserConfig 范式一致），绝不抛。 */
function readLocalColumn(columnId: string, dir: string, warnings: string[]): ColumnConfig | undefined {
	const p = join(dir, `${columnId}.json`);
	if (!existsSync(p)) {
		warnings.push(`栏目配置不存在：${p}，回落内置默认`);
		return undefined;
	}
	try {
		const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			warnings.push(`栏目配置格式异常（非 JSON 对象）：${p}，回落内置默认`);
			return undefined;
		}
		return parsed as ColumnConfig;
	} catch {
		warnings.push(`栏目配置损坏（JSON 解析失败）：${p}，回落内置默认`);
		return undefined;
	}
}

/**
 * 解析有效栏目配置。无 columnId = 只评 L0（内置默认，现状逐字节等价）。
 * L1（矩阵后端）/L3（工程钉存）为后续 change 预留钩子，此处 no-op。
 */
export function resolveColumnConfig(
	opts: { columnId?: string; columnsDir?: string } = {},
): ResolveColumnResult {
	const warnings: string[] = [];
	const layers: ColumnConfig[] = [DEFAULT_COLUMN_CONFIG];
	// L1 矩阵后端权威库：TODO（另 change，member 隔离，涉 infra/yudao）
	if (opts.columnId) {
		const l2 = readLocalColumn(opts.columnId, opts.columnsDir ?? columnsDir(), warnings);
		if (l2) layers.push(l2);
	}
	// L3 工程钉存（.gtrk struct_meta）：TODO（另 change，复用 split 快照范式）
	const config = foldColumnConfigs(layers);
	// style 清单字段级宽松校验（不涉 ref 内容，零解析约束内）+ produces 疑似拼写提示
	config.style = normalizeColumnStyle(config.style, warnings);
	for (const n of producesNotices(config.style)) warnings.push(n);
	return { config, warnings };
}

// ── style 引用清单（column-style-manifest spec）────────────────────────────

/** handoff 注册集：P2 注册表化前的过渡事实 = 现行四车道。取值与演进归 lane/handoff 侧，此处只引用。 */
const HANDOFF_REGISTRY: readonly string[] = LANES;

function normalizeEntries<T extends { id?: unknown; ref?: unknown }>(
	list: unknown,
	kind: string,
	warnings: string[],
): T[] | undefined {
	if (list === undefined) return undefined;
	if (!Array.isArray(list)) {
		warnings.push(`style.${kind} 非数组，已忽略`);
		return undefined;
	}
	const out: T[] = [];
	list.forEach((e, i) => {
		// 条目最小合法字段 = id + ref；非法条目跳过并提示，不抛（字段级校验，不违反零解析）
		if (typeof e !== "object" || e === null || Array.isArray(e)) {
			warnings.push(`style.${kind}[${i}] 非对象，已跳过`);
			return;
		}
		const o = e as Record<string, unknown>;
		if (typeof o.id !== "string" || typeof o.ref !== "string" || !o.id || !o.ref) {
			warnings.push(`style.${kind}[${i}] 缺 id/ref，已跳过`);
			return;
		}
		out.push(e as T);
	});
	return out;
}

/** style 块宽松归一：非法条目跳过 + 提示；整块非对象忽略。绝不读取 ref 内容。 */
export function normalizeColumnStyle(raw: unknown, warnings: string[]): ColumnStyle | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push("style 块非对象，已忽略");
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	const style: ColumnStyle = {};
	const skills = normalizeEntries<StyleSkillEntry>(r.skills, "skills", warnings);
	if (skills) style.skills = skills;
	const shared = normalizeEntries<StyleSharedEntry>(r.shared, "shared", warnings);
	if (shared) style.shared = shared;
	if (typeof r.bundle_ref === "string") style.bundle_ref = r.bundle_ref;
	return style;
}

/** 编辑距离（Levenshtein），用于 produces 疑似拼写提示。 */
function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const cur = [i];
		for (let j = 1; j <= n; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = cur;
	}
	return prev[n];
}

function producesValues(e: StyleSkillEntry): string[] {
	if (typeof e.produces === "string") return [e.produces];
	if (Array.isArray(e.produces)) return e.produces.filter((x): x is string => typeof x === "string");
	return [];
}

/** 该 skill 条目是否命中某 handoff 类型（用于派单消费方按类型检索产能登记）。 */
export function skillsProducing(style: ColumnStyle | undefined, handoffType: string): StyleSkillEntry[] {
	if (!style?.skills) return [];
	return style.skills.filter((e) => producesValues(e).includes(handoffType));
}

/**
 * produces 惰性路由提示：未命中注册集**静默**登记；仅「大小写不同或编辑距离 ≤2」提示疑似拼写
 * （每次 resolve 每值至多一条）；routing:"none" 显式管线外，连提示也豁免。
 */
export function producesNotices(style: ColumnStyle | undefined): string[] {
	const notices: string[] = [];
	if (!style?.skills) return notices;
	const seen = new Set<string>();
	for (const e of style.skills) {
		if (e.routing === "none") continue;
		for (const v of producesValues(e)) {
			if (HANDOFF_REGISTRY.includes(v) || seen.has(v)) continue;
			const near = HANDOFF_REGISTRY.find(
				(r) => r.toLowerCase() === v.toLowerCase() || editDistance(r.toUpperCase(), v.toUpperCase()) <= 2,
			);
			if (near) {
				seen.add(v);
				notices.push(`style.skills[${e.id}].produces="${v}" 疑似拼写（接近注册类型 "${near}"）；如确为管线外产物可设 routing:"none"`);
			}
			// 其余未命中：静默惰性登记（异构栏目产线天然不在注册集，不唠叨）
		}
	}
	return notices;
}

/** 从有效配置导出 splitdoc 校验用 vocab（L0 兜底使三词表恒存在）。 */
export function effectiveVocab(config: ColumnConfig): {
	narrative: string[];
	container_stage: string[];
	base_track: string[];
	unknown_narrative?: "allow" | "reject";
} {
	return {
		narrative: config.vocab?.narrative ?? [...NARRATIVES],
		container_stage: config.vocab?.container_stage ?? [...CONTAINER_STAGES],
		base_track: config.vocab?.base_track ?? [...BASE_TRACKS],
		unknown_narrative: config.fallback?.unknown_narrative,
	};
}
