/** gtrk tool 实时价格：公开匿名价格表是唯一真相，不保存本地价格快照。 */

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

/** 严格解析官网直接数组响应；畸形项忽略，非数组视为接口失败。 */
export function parseToolPriceList(value: unknown): ToolPriceMap {
	if (!Array.isArray(value)) throw new Error("价格表响应不是数组");
	const prices: ToolPriceMap = new Map();
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as Record<string, unknown>;
		const key = typeof item.key === "string" ? item.key.trim() : "";
		const measure = typeof item.measure === "string" ? item.measure.trim() : "";
		if (!key || !measure || !validNumber(item.price) || !validNumber(item.exPrice)) continue;
		prices.set(key, {
			...(validNumber(item.taskTypeId) ? { taskTypeId: item.taskTypeId } : {}),
			...(typeof item.name === "string" ? { name: item.name } : {}),
			key,
			price: item.price,
			exPrice: item.exPrice,
			measure,
			...(typeof item.note === "string" ? { note: item.note } : {}),
		});
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
