import type { FilmDispatch } from "./splitdoc";

export interface OnlineMaterialNeed {
	need_id: string;
	beat_id?: string;
	intent: string;
	visual_description?: string;
	constraints?: Partial<Record<"event" | "location" | "person" | "work" | "character" | "footage_type" | "action", string>> & { event_year?: number };
	target_duration_sec?: number;
	query_hints?: string[];
	exclude?: string[];
	fallback?: { policy: "review_only" | "none"; description?: string };
}

/** 每个明确目标一单，语言变体不是独立需求。旧派单原文完整保留，不猜人名。 */
export function onlineNeedsForEntry(entry: FilmDispatch): OnlineMaterialNeed[] {
	const explicit = entry.needs ?? (entry.need ? [entry.need] : undefined);
	if (explicit && (!Array.isArray(explicit) || explicit.length === 0)) throw new Error(`${entry.beat}: needs 必须为非空需求列表`);
	const needs: OnlineMaterialNeed[] = [...(explicit ?? [{ need_id: `${entry.beat}-main`, intent: entry.queries.join("；"), query_hints: entry.queries.slice(0, 4) }])];
	for (const anchor of entry.anchors ?? []) {
		if (!needs.some(n => n?.intent === anchor.query || n?.query_hints?.includes(anchor.query))) {
			needs.push({ need_id: `${entry.beat}-anchor-${needs.length}`, intent: anchor.query });
		}
	}
	const ids = new Set<string>();
	return needs.map(need => {
		if (!need || typeof need.intent !== "string" || !need.intent.trim() || need.intent.length > 4000
			|| typeof need.need_id !== "string" || !need.need_id.trim() || need.need_id.length > 128 || ids.has(need.need_id))
			throw new Error(`${entry.beat}: 需求 intent/need_id 无效或重复`);
		ids.add(need.need_id);
		const target = need.target_duration_sec ?? (typeof entry.per_shot_sec === "number" ? entry.per_shot_sec : Math.min(12, Math.max(.5, entry.track_ed - entry.track_st)));
		if (!Number.isFinite(target) || target < .5 || target > 1200) throw new Error(`${entry.beat}: 目标时长无效`);
		const exclude = need.exclude ?? (Array.isArray(entry.exclude) ? entry.exclude.map(String) : typeof entry.exclude === "string" ? [entry.exclude] : []);
		const allowed = new Set(["need_id", "beat_id", "intent", "visual_description", "constraints", "target_duration_sec", "query_hints", "exclude", "fallback"]);
		const text = (value: unknown, limit: number) => typeof value === "string" && !!value.trim() && value.length <= limit;
		if (Object.keys(need).some(k => !allowed.has(k)) || !text(entry.beat, 4000)
			|| (need.visual_description !== undefined && !text(need.visual_description, 4000))) throw new Error(`${entry.beat}: 需求字段无效`);
		if (need.constraints !== undefined) {
			const keys = new Set(["event", "event_year", "location", "person", "work", "character", "footage_type", "action"]);
			if (!need.constraints || typeof need.constraints !== "object" || Array.isArray(need.constraints)
				|| Object.entries(need.constraints).some(([k, v]) => !keys.has(k) || (k === "event_year" ? !(typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 9999) : !text(v, 500))))
				throw new Error(`${entry.beat}: 硬条件无效`);
		}
		for (const [values, max] of [[need.query_hints ?? [], 4], [exclude, 16]] as const) {
			if (!Array.isArray(values) || values.length > max || values.some(v => !text(v, 1000))) throw new Error(`${entry.beat}: 查询提示或排除条件无效`);
		}
		if (need.fallback !== undefined && (!need.fallback || !["review_only", "none"].includes(need.fallback.policy)
			|| Object.keys(need.fallback).some(k => !["policy", "description"].includes(k))
			|| (need.fallback.description !== undefined && !text(need.fallback.description, 1000)))) throw new Error(`${entry.beat}: 替代策略无效`);
		return { ...need, beat_id: entry.beat, target_duration_sec: target, exclude,
			fallback: need.fallback ?? { policy: "review_only" } };
	});
}
