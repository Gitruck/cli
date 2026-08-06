/**
 * 长剪短人读简报渲染（add-long2short-clip-brief）：把服务端**已经返回**的编剧元信息
 * （title/summary/score+score_reason/jumpcut_note/tags·themes·genres·moods/highlight_words）
 * 渲成 Markdown —— 逐 clip 一份 `clip.md`，产物根一份 `clips.md` 总览。
 *
 * 纯函数、纯增文件：`result.json` / `report.json` / `--json` 机读契约逐字节不动。
 * 字段缺失时**整节省略**（服务端演进不产空壳、不抛）——这是本模块唯一的硬约束。
 */

/** 云端 clip 的松散视图：只读已知字段，未知字段一律忽略（服务端可自由演进）。 */
export type ClipMeta = Record<string, unknown>;

export interface OverviewContext {
	source: string; // 毛片绝对路径
	jumpCut: boolean;
	splitMaterials?: { landed: number; total: number };
	taskId?: string;
}

const str = (v: unknown): string | undefined => {
	const s = typeof v === "string" ? v.trim() : "";
	return s ? s : undefined;
};
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => !!x) : []);

/** ms → m:ss（≥1h 时 h:mm:ss）。负值/非数按 0 处理。 */
export function fmtTime(ms: unknown): string {
	const total = Math.max(0, Math.round((num(ms) ?? 0) / 1000));
	const s = total % 60;
	const m = Math.floor(total / 60) % 60;
	const h = Math.floor(total / 3600);
	const mm = h ? String(m).padStart(2, "0") : String(m);
	return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** 取路径末段（不引 node:path，本模块保持纯字符串处理、Win/POSIX 分隔符都吃）。 */
const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;

/** 表格单元格转义：竖线与换行会撑破 Markdown 表。 */
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/** 跳剪备注翻成人话；LLM 自由文本原样透出。 */
function jumpcutText(note: string): string {
	if (note === "jumpcut_off") return "未启用跳剪（`--no-jump-cut`），片段按原样保留。";
	if (note === "too_short") return "片段过短，跳剪跳过（保留全部内容）。";
	if (note === "degraded") return "跳剪降级：本条未压缩，保留全部内容。";
	return note;
}

/** 一条切片的时长与片段数（缺 segments 时退化为单段）。 */
function clipDurationMs(clip: ClipMeta): number | undefined {
	return num(clip.total_duration_ms) ?? num(clip.duration_ms);
}
function clipSegmentCount(clip: ClipMeta): number | undefined {
	return num(clip.segment_count) ?? (Array.isArray(clip.segments) ? clip.segments.length : undefined);
}

/** 切片在源片上的起止（取首末子段；无 segments 时用 clip 自身 begin/end）。 */
function sourceSpan(clip: ClipMeta): [number, number] | undefined {
	const segs = Array.isArray(clip.segments) ? (clip.segments as ClipMeta[]) : [];
	if (segs.length) {
		const b = num(segs[0]?.begin_time);
		const e = num(segs[segs.length - 1]?.end_time);
		if (b != null && e != null) return [b, e];
	}
	const b = num(clip.begin_time);
	const e = num(clip.end_time);
	return b != null && e != null ? [b, e] : undefined;
}

/**
 * 渲染单条切片简报。`files` 为 materialize 的 format → 落地路径表（可空）。
 */
export function renderClipBrief(clip: ClipMeta, index: number, files: Record<string, string[]> = {}): string {
	const title = str(clip.title);
	const out: string[] = [`# clip${index}${title ? `「${title}」` : ""}`, ""];

	// 概览：时长 / 片段数 / 在源片的位置——任一缺失就少一项，全缺则整行省略
	const bits: string[] = [];
	const dur = clipDurationMs(clip);
	if (dur != null) bits.push(`时长 ${fmtTime(dur)}`);
	const segCount = clipSegmentCount(clip);
	if (segCount != null) bits.push(`${segCount} 个保留片段`);
	const span = sourceSpan(clip);
	if (span) bits.push(`源片 ${fmtTime(span[0])}–${fmtTime(span[1])}`);
	if (bits.length) out.push(`- ${bits.join(" · ")}`, "");

	const score = num(clip.score);
	const reason = str(clip.score_reason);
	if (score != null || reason) {
		out.push("## 入选理由", "");
		out.push([score != null ? `**评分 ${score}**` : null, reason].filter(Boolean).join(" — "), "");
	}

	const summary = str(clip.summary);
	if (summary) out.push("## 简介", "", summary, "");

	const note = str(clip.jumpcut_note);
	if (note) out.push("## 跳剪", "", jumpcutText(note), "");

	// 分类与调性：四类各自可缺，全缺则整节省略
	const cats: Array<[string, string[]]> = [
		["主题", list(clip.themes)],
		["标签", list(clip.tags)],
		["类型", list(clip.genres)],
		["调性", list(clip.moods)],
	];
	const shown = cats.filter(([, v]) => v.length);
	if (shown.length) {
		out.push("## 分类与调性", "");
		for (const [k, v] of shown) out.push(`- ${k}：${v.join("、")}`);
		out.push("");
	}

	const hl = Array.isArray(clip.highlight_words) ? (clip.highlight_words as ClipMeta[]) : [];
	const hlRows = hl.map((h) => ({ text: str(h?.text), at: num(h?.begin_time) })).filter((h) => h.text);
	if (hlRows.length) {
		out.push("## 高光词（源片时码）", "");
		for (const h of hlRows) out.push(`- ${h.at != null ? `${fmtTime(h.at)} ` : ""}「${h.text}」`);
		out.push("");
	}

	const formats = Object.keys(files).filter((f) => files[f]?.length);
	if (formats.length) {
		out.push("## 本条工程文件", "");
		// 只列文件名：clip.md 与产物同处 clip{i}/，绝对路径在这儿是噪音
		for (const f of formats) out.push(`- ${f}：${files[f].map(baseName).join("、")}`);
		out.push("");
	}

	return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/**
 * 渲染产物根总览：任务级事实 + 全部切片一张表（一眼选出先精修哪条）。
 */
export function renderClipsOverview(clips: ClipMeta[], ctx: OverviewContext): string {
	const name = ctx.source.split(/[\\/]/).pop() || ctx.source;
	const out: string[] = [`# ${name} · 长剪短总览`, ""];

	out.push(`- 源片：\`${ctx.source}\``);
	out.push(`- 切片：${clips.length} 条`);
	out.push(`- 跳剪：${ctx.jumpCut ? "开" : "关"}`);
	if (ctx.splitMaterials?.total) out.push(`- 分屏素材：${ctx.splitMaterials.landed}/${ctx.splitMaterials.total} 条已落地`);
	if (ctx.taskId) out.push(`- task_id：\`${ctx.taskId}\``);
	out.push("");

	out.push("| # | 标题 | 时长 | 评分 | 简介 |", "| --- | --- | --- | --- | --- |");
	for (const [i, clip] of clips.entries()) {
		const dur = clipDurationMs(clip);
		const score = num(clip.score);
		out.push(
			`| clip${i} | ${cell(str(clip.title) ?? "—")} | ${dur != null ? fmtTime(dur) : "—"} | ${score ?? "—"} | ${cell(str(clip.summary) ?? "—")} |`,
		);
	}
	out.push("", "> 逐条入选理由、跳剪说明、高光词见各 `clip{i}/clip.md`。");
	return `${out.join("\n")}\n`;
}
