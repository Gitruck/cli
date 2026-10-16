/** 外网来源与媒体时钟。跨端同源契约，source 仍只表示 preview/raw/local。
 * 本文件已含 pexels（link-online-broll-pexels-platform-cli）；客户端同名文件待客户端联动件
 * link-online-broll-pexels-platform-client 同步，在那之前两端有意不一致。 */
export const ONLINE_PLATFORMS = ["youtube", "vimeo", "tiktok", "bilibili", "pexels"] as const;
export type OnlinePlatform = (typeof ONLINE_PLATFORMS)[number];
/** 加入 Pexels 之前的缺省平台；只用于回看升级前的续跑记录与旧服务端提示。 */
export const LEGACY_ONLINE_PLATFORMS: readonly OnlinePlatform[] = ["youtube", "vimeo", "tiktok", "bilibili"];
export interface OnlineClock {
	source_start: number;
	duration: number;
	verified: true;
}
export interface OnlineOrigin {
	preview_file_id?: string;
	media_version?: string;
	kind: "online";
	platform: OnlinePlatform;
	video_id: string;
	part: string;
	asset_id: string;
	source_url: string;
	search_task_id: string;
	title: string;
	uploader: string;
	/** 摄影师主页（目前只有 Pexels 候选带）；仅收 https，不合法时丢掉该字段。 */
	uploader_url?: string;
	/** 素材许可（目前只有 Pexels 候选带）；url 仅收 https，不合法时丢掉该字段。 */
	license?: { name: string; url: string };
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

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== "string" || !value.startsWith("https://") || value.length > 2048) return false;
	try { return new URL(value).protocol === "https:"; } catch { return false; }
}

/** 署名字段只用于展示：坏了只丢字段，不影响整条候选。 */
function parseOnlineLicense(raw: unknown): { name: string; url: string } | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const l = raw as Record<string, unknown>;
	return typeof l.name === "string" && l.name && isHttpsUrl(l.url) ? { name: l.name, url: l.url } : undefined;
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
	const license = parseOnlineLicense(o.license);
	return {
		kind: "online", platform: o.platform as OnlinePlatform, video_id: o.video_id as string,
		...(typeof o.preview_file_id === "string" && /^\d+$/.test(o.preview_file_id) ? { preview_file_id: o.preview_file_id } : {}),
		...(typeof o.media_version === "string" && /^[a-f0-9]{64}$/.test(o.media_version) ? { media_version: o.media_version } : {}),
		part: o.part as string, asset_id: o.asset_id as string, source_url: o.source_url as string,
		search_task_id: o.search_task_id as string, preview_url: o.preview_url as string,
		title: typeof o.title === "string" ? o.title : "", uploader: typeof o.uploader === "string" ? o.uploader : "",
		...(isHttpsUrl(o.uploader_url) ? { uploader_url: o.uploader_url } : {}),
		...(license ? { license } : {}),
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
		throw new Error(`--platforms 只能包含 ${ONLINE_PLATFORMS.join(",")}`);
	return [...new Set(parts)] as OnlinePlatform[];
}
