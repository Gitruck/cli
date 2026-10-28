/** gtrk tool 实时价格：公开匿名价格表是唯一真相，不保存本地价格快照。 */

import { estimateBatchCredits } from "./tool-batch";

export const TOOL_PRICE_LIST_URL = "https://cloud.ai-mcn.tv/api/get_price_list";
export const PRICE_UNAVAILABLE_HINT = "实时价格暂不可用，以服务端结算为准";
export const PRICE_REQUEST_TIMEOUT_MS = 5000;

export interface ToolPriceItem {
	taskTypeId?: number;
	name?: string;
	key: string;
	price: number;
	exPrice: number;
	measure: string;
	note?: string;
}

export interface ToolPricingSnapshot {
	key: string;
	available: boolean;
	price?: number;
	exPrice?: number;
	measure?: string;
}

export interface ResolvedToolPricing {
	billingHint: string;
	pricing: ToolPricingSnapshot;
}

export type ToolPriceMap = Map<string, ToolPriceItem>;
export type PriceFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type PriceResolver = (priceKey: string, pricingContext?: string) => Promise<ResolvedToolPricing>;

function validNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

/** 价格表一项；畸形项返回 undefined。 */
function parsePriceItem(raw: unknown): ToolPriceItem | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const item = raw as Record<string, unknown>;
	const key = typeof item.key === "string" ? item.key.trim() : "";
	const measure = typeof item.measure === "string" ? item.measure.trim() : "";
	if (!key || !measure || !validNumber(item.price) || !validNumber(item.exPrice)) return undefined;
	return {
		...(validNumber(item.taskTypeId) ? { taskTypeId: item.taskTypeId } : {}),
		...(typeof item.name === "string" ? { name: item.name } : {}),
		key,
		price: item.price,
		exPrice: item.exPrice,
		measure,
		...(typeof item.note === "string" ? { note: item.note } : {}),
	};
}

/**
 * 严格解析官网直接数组响应；畸形项忽略，非数组视为接口失败。
 * 家族分档（如 image_purify 下的 image_purify_redraw）挂在父项的 `tiers` 里、各有自己的 key，一并摊平进索引；
 * 与顶层同 key 时以顶层为准。
 */
export function parseToolPriceList(value: unknown): ToolPriceMap {
	if (!Array.isArray(value)) throw new Error("价格表响应不是数组");
	const prices: ToolPriceMap = new Map();
	const tiers: unknown[] = [];
	for (const raw of value) {
		const tierList = raw && typeof raw === "object" ? (raw as Record<string, unknown>).tiers : undefined;
		if (Array.isArray(tierList)) tiers.push(...tierList);
		const item = parsePriceItem(raw);
		if (item) prices.set(item.key, item);
	}
	for (const raw of tiers) {
		const item = parsePriceItem(raw);
		if (item && !prices.has(item.key)) prices.set(item.key, item);
	}
	return prices;
}

/** 匿名拉取实时价格；只发 Accept，不得带任何用户凭证。 */
export async function fetchToolPrices(fetchFn: PriceFetch = fetch): Promise<ToolPriceMap> {
	const res = await fetchFn(TOOL_PRICE_LIST_URL, {
		method: "GET",
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(PRICE_REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`价格表请求失败 HTTP ${res.status}`);
	return parseToolPriceList(await res.json());
}

/** 只转述 API 返回的 price/exPrice/measure，不推导隐藏阈值。 */
export function formatToolPrice(item: ToolPriceItem, pricingContext?: string): string {
	let price: string;
	if (item.price === 0 && item.exPrice === 0) {
		price = `免费（0 积分/${item.measure}）`;
	} else if (item.price === item.exPrice) {
		price = `${item.price} 积分/${item.measure}`;
	} else {
		price = `标准价 ${item.price} 积分/${item.measure}；超额价 ${item.exPrice} 积分/${item.measure}`;
	}
	return pricingContext ? `${pricingContext}：${price}` : price;
}

/** 从一次请求的索引解析某工具；缺 key/请求失败统一 unavailable。 */
export function resolveToolPricingFromMap(
	priceKey: string,
	prices: ToolPriceMap | undefined,
	pricingContext?: string,
): ResolvedToolPricing {
	const item = prices?.get(priceKey);
	if (!item) {
		return {
			billingHint: pricingContext ? `${pricingContext}：${PRICE_UNAVAILABLE_HINT}` : PRICE_UNAVAILABLE_HINT,
			pricing: { key: priceKey, available: false },
		};
	}
	return {
		billingHint: formatToolPrice(item, pricingContext),
		pricing: {
			key: priceKey,
			available: true,
			price: item.price,
			exPrice: item.exPrice,
			measure: item.measure,
		},
	};
}

/** 单工具便捷解析：任何失败均收敛为 unavailable，调用方无需捕获。 */
export async function resolveToolPricing(
	priceKey: string,
	pricingContext?: string,
	fetchFn: PriceFetch = fetch,
): Promise<ResolvedToolPricing> {
	try {
		return resolveToolPricingFromMap(priceKey, await fetchToolPrices(fetchFn), pricingContext);
	} catch {
		return resolveToolPricingFromMap(priceKey, undefined, pricingContext);
	}
}

/** 提交前计费提示：一律走 stderr（人读；--json 下不污染 stdout 机读契约），与 `gtrk tool` 的提示逐字同形。 */
export function emitBillingHint(hint: string): void {
	process.stderr.write(`\x1b[33m⚠️  计费提示：${hint}\x1b[0m\n`);
}

/**
 * 按时长计费的本次预估。只给积分、不给额度包单位：CLI 渠道分账条与产品主条的额度包是否互通未核实
 * （额度包按 task_type_id 精确匹配），写出「消耗 N 个额度包单位」可能是错的（fix-oralcut-long2short-price-line D3）。
 */
export interface DurationEstimate {
	/** 显示用分钟数（两位小数）；积分按未取整的时长算。 */
	minutes: number;
	standardCredits: number;
	excessCredits: number;
}

export type DurationPricingSnapshot = ToolPricingSnapshot & { estimate?: DurationEstimate };

export interface DurationPricing {
	billingHint: string;
	pricing: DurationPricingSnapshot;
}

/**
 * 按时长计费的命令（oralcut / long2short）跑前查价：单价 + 本次预估。
 * 预估与服务端余额腿同款取整（每条 `max(1, ceil(分钟 × 单价))`），时长不先取整；单位不是「分钟」或时长无效时只给单价。
 * 任何失败均收敛为 unavailable，调用方无需捕获。
 */
export async function resolveDurationPricing(
	priceKey: string,
	durationSec: number,
	pricingContext?: string,
	resolve: PriceResolver = resolveToolPricing,
): Promise<DurationPricing> {
	let resolved: ResolvedToolPricing;
	try {
		resolved = await resolve(priceKey, pricingContext);
	} catch {
		resolved = resolveToolPricingFromMap(priceKey, undefined, pricingContext);
	}
	const { billingHint, pricing } = resolved;
	if (!pricing.available || pricing.price == null || pricing.exPrice == null || pricing.measure !== "分钟") {
		return { billingHint, pricing };
	}
	const est = estimateBatchCredits([durationSec / 60], pricing.price, pricing.exPrice);
	if (est.status !== "available" || est.standardCredits == null || est.excessCredits == null) {
		return { billingHint, pricing };
	}
	const minutes = Math.max(0.01, Math.round((durationSec / 60) * 100) / 100);
	const credits =
		est.standardCredits === est.excessCredits
			? `${est.standardCredits} 积分`
			: `标准价 ${est.standardCredits} 积分 / 超额价 ${est.excessCredits} 积分`;
	return {
		billingHint: `${billingHint}；本次约 ${minutes} 分钟 → 预估 ${credits}（以服务端结算为准）`,
		pricing: {
			...pricing,
			estimate: { minutes, standardCredits: est.standardCredits, excessCredits: est.excessCredits },
		},
	};
}
