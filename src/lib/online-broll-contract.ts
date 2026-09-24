/** 外网来源与媒体时钟。跨端同源契约，source 仍只表示 preview/raw/local。 */
export const ONLINE_PLATFORMS = ["youtube", "vimeo", "tiktok", "bilibili"] as const;
export type OnlinePlatform = (typeof ONLINE_PLATFORMS)[number];
export interface OnlineClock {
	source_start: number;
	duration: number;
	verified: true;
}
export interface OnlineOrigin {
	kind: "online";
	platform: OnlinePlatform;
	video_id: string;
	part: string;
	asset_id: string;
	source_url: string;
	search_task_id: string;
	title: string;
	uploader: string;
	preview_url: string;
	preview_clock: OnlineClock;
	source_start: number;
	source_end: number;
}

export function parseOnlineClock(raw: unknown): OnlineClock | null {
	if (!raw || typeof raw !== "object") return null;
	const c = raw as Record<string, unknown>;
	return c.verified === true && typeof c.source_start === "number" && Number.isFinite(c.source_start) && c.source_start >= 0
		&& typeof c.duration === "number" && Number.isFinite(c.duration) && c.duration > 0
		? { source_start: c.source_start, duration: c.duration, verified: true } : null;
}

export function parseOnlineOrigin(raw: unknown): OnlineOrigin | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (o.kind !== "online" || !ONLINE_PLATFORMS.includes(o.platform as OnlinePlatform)) return null;
	for (const key of ["video_id", "part", "asset_id", "source_url", "search_task_id", "preview_url"])
		if (typeof o[key] !== "string" || !o[key]) return null;
	const clock = parseOnlineClock(o.preview_clock);
	if (!clock || typeof o.source_start !== "number" || typeof o.source_end !== "number"
		|| !Number.isFinite(o.source_start) || !Number.isFinite(o.source_end)
		|| o.source_start < clock.source_start || o.source_start >= o.source_end
		|| o.source_end > clock.source_start + clock.duration + 0.001) return null;
	return {
		kind: "online", platform: o.platform as OnlinePlatform, video_id: o.video_id as string,
		part: o.part as string, asset_id: o.asset_id as string, source_url: o.source_url as string,
		search_task_id: o.search_task_id as string, preview_url: o.preview_url as string,
		title: typeof o.title === "string" ? o.title : "", uploader: typeof o.uploader === "string" ? o.uploader : "",
		preview_clock: clock, source_start: o.source_start, source_end: o.source_end,
	};
}

export function onlineMediaWindow(sourceStart: number, sourceEnd: number, clock: OnlineClock): [number, number] {
	if (!parseOnlineClock(clock) || !Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd))
		throw new Error("素材源时间映射未验证");
	const start = sourceStart - clock.source_start, end = sourceEnd - clock.source_start;
	if (!(0 <= start && start < end && end <= clock.duration + 0.001)) throw new Error("选段超出已下载素材窗口");
	return [start, end];
}

export function parseOnlinePlatforms(value?: string): OnlinePlatform[] {
	if (value === undefined) return [...ONLINE_PLATFORMS];
	const parts = value.split(",").map((p) => p.trim());
	if (!parts.length || parts.some((p) => !ONLINE_PLATFORMS.includes(p as OnlinePlatform)))
		throw new Error("--platforms 只能包含 youtube,vimeo,tiktok,bilibili");
	return [...new Set(parts)] as OnlinePlatform[];
}
