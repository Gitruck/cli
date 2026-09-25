export interface PurifyRegion {
	id: string; source: "detected" | "manual";
	x: number; y: number; w: number; h: number; start: number; end: number;
}
export interface PurifySource { file_id?: string; input_path: string; sha256: string; api_base?: string; }
export interface PurifyDocument {
	version: 1;
	source: PurifySource;
	video: { duration: number; width?: number; height?: number; fps?: number; fps_exact?: string };
	regions: PurifyRegion[];
	protect_regions?: PurifyRegion[];
}

function number(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(label + " 必须是有限数字");
	return value;
}
export function validateBox(box: Record<string, unknown>, label: string): void {
	const x = number(box.x, label + ".x"), y = number(box.y, label + ".y");
	const w = number(box.w, label + ".w"), h = number(box.h, label + ".h");
	if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 + 1e-8 || y + h > 1 + 1e-8) throw new Error(label + " 坐标越界");
}
export function validateRegions(value: unknown, duration: number, label = "regions"): PurifyRegion[] {
	if (!Array.isArray(value)) throw new Error(label + " 必须是数组");
	const seen = new Set<string>();
	return value.map((raw, i) => {
		if (!raw || typeof raw !== "object") throw new Error(label + " 中存在非对象");
		const r = raw as Record<string, unknown>;
		validateBox(r, label + "[" + i + "]");
		if (typeof r.id !== "string" || !r.id.trim() || seen.has(r.id)) throw new Error(label + " id 缺失或重复：" + String(r.id));
		seen.add(r.id);
		if (r.source !== "detected" && r.source !== "manual") throw new Error(label + " source 必须为 detected/manual");
		const start = number(r.start, "start"), end = number(r.end, "end");
		if (start < 0 || start >= duration || end <= start || end > duration + 1e-6) throw new Error(label + " 时间必须满足 0≤start<end≤视频时长");
		return { id: r.id, source: r.source, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number, start, end };
	});
}
export function parseRoiSpec(spec: string): { x: number; y: number; w: number; h: number } {
	const parts = spec.split(",").map(s => s.trim());
	if (parts.length !== 4 || parts.some(s => !s)) throw new Error("区域需要 x,y,w,h 四个数字");
	const [x, y, w, h] = parts.map(Number) as [number, number, number, number];
	const box = { x, y, w, h }; validateBox(box, "区域"); return box;
}
export function parseRegionSpec(spec: string, duration: number, index: number, prefix = "manual"): PurifyRegion {
	const parts = spec.split(",").map(s => s.trim());
	if (parts.length < 4 || parts.length > 6) throw new Error("区域需要 x,y,w,h[,start[,end]]");
	const box = parseRoiSpec(parts.slice(0, 4).join(","));
	return validateRegions([{ ...box, id: prefix + "-" + String(index).padStart(6, "0"), source: "manual", start: parts[4] ? Number(parts[4]) : 0, end: parts[5] ? Number(parts[5]) : duration }], duration)[0]!;
}
export function appendRegionSpecs(existing: PurifyRegion[], specs: string[], duration: number, prefix = "manual"): PurifyRegion[] {
	const ids = new Set(existing.map(r => r.id));
	let index = 1;
	return [...existing, ...specs.map(spec => {
		let region: PurifyRegion;
		do { region = parseRegionSpec(spec, duration, index++, prefix); } while (ids.has(region.id));
		ids.add(region.id);
		return region;
	})];
}
export function validateDocument(value: unknown): PurifyDocument {
	const d = value as PurifyDocument;
	if (!d || d.version !== 1 || !d.video || !d.source) throw new Error("需要 version=1、video、source 的区域文档；先运行 purify detect");
	const duration = number(d.video.duration, "video.duration");
	if (duration <= 0 || typeof d.source.input_path !== "string" || !d.source.input_path || !/^[a-f0-9]{64}$/.test(d.source.sha256)) throw new Error("源路径、sha256 或时长无效");
	if (d.source.file_id !== undefined && (typeof d.source.file_id !== "string" || !d.source.file_id)) throw new Error("source.file_id 必须是非空字符串");
	if (d.source.api_base !== undefined && (typeof d.source.api_base !== "string" || !d.source.api_base)) throw new Error("source.api_base 必须是非空字符串");
	return { ...d, regions: validateRegions(d.regions, duration), protect_regions: validateRegions(d.protect_regions ?? [], duration, "protect_regions") };
}
export function summarizeRegions(doc: Pick<PurifyDocument, "regions" | "protect_regions">) {
	const bins = Array<number>(9).fill(0);
	let minStart = Infinity, maxEnd = 0;
	const samples: number[] = [];
	const step = Math.max(1, Math.ceil(doc.regions.length / 12));
	for (const [i, r] of doc.regions.entries()) {
		const x = Math.min(2, Math.floor((r.x + r.w / 2) * 3));
		const y = Math.min(2, Math.floor((r.y + r.h / 2) * 3));
		bins[y * 3 + x]!++;
		minStart = Math.min(minStart, r.start); maxEnd = Math.max(maxEnd, r.end);
		if (i % step === 0) samples.push(Number(((r.start + r.end) / 2).toFixed(3)));
	}
	return { regionCount: doc.regions.length, protectCount: doc.protect_regions?.length ?? 0, grid3x3: bins, start: Number.isFinite(minStart) ? minStart : null, end: maxEnd, representativeTimes: samples };
}
