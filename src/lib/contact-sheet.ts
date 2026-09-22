/**
 * 联络表布局（纯函数，零 IO）——openspec: add-qc-contact-sheet。
 *
 * ## 立题
 *
 * 镜头量级上百之后，**逐张看不现实，不看又不负责**。2026-09-20 一次 232 镜的出图验收，
 * 靠自写脚本把关键帧按拍拼成带镜号标签的联络表，agent 逐张判读后只把翻车项交给用户——
 * 这条路径可行且必要，但它是一次性脚本。任何 AI 画面链路（AI 漫剧、封面批产、B-roll 抽帧复核）
 * 都要做同一件事。
 *
 * ## 本文件的射程：只排版，不碰像素
 *
 * 拼图本身交给 ffmpeg（`tile` 滤镜）。这里只算「谁在第几格、第几页」，
 * 因为**错位是这类工具唯一致命的缺陷**——标签错位会让判读结论全部指向错误的镜头，
 * 比没有联络表更有害。把顺序算清楚并单独钉住，比把整条 ffmpeg 命令塞进一个函数里可证得多。
 */

/** 缺省列数与格宽：实测该密度下 agent 能可靠判读人数与鬼影。 */
export const DEFAULT_COLS = 6;
export const DEFAULT_CELL_WIDTH = 360;

/**
 * 单页格数上限。
 *
 * 不设上限的后果不是「图很大」而是**解码峰值内存炸掉**：232 张 1920×1080
 * 同时解到内存是 ~1.4 GiB。6×10 一页是实测能一眼扫完的量级，也把峰值压在 ~90 MiB。
 */
export const MAX_CELLS_PER_SHEET = 60;

export interface SheetCell {
	/** 源文件绝对路径。 */
	file: string;
	/** 格内标签（镜号必出）。 */
	label: string;
}

export interface SheetPage {
	/** 页号，从 1 起。 */
	page: number;
	cols: number;
	rows: number;
	/** 本页的格，**顺序即摆放顺序**（左上起、先行后列）。 */
	cells: SheetCell[];
}

/**
 * 分页。
 *
 * ⚠️ **标签与文件在同一个 `SheetCell` 里绑死**，从入口到 ffmpeg 命令全程不分家。
 * 这不是风格问题：只要两者在任何一步各排各的序（比如一边按文件名排、一边按 manifest 排），
 * 错位就会发生且**肉眼不一定看得出来**——图都是同一批图，只是名字对错了人。
 */
export function paginate(cells: ReadonlyArray<SheetCell>, cols = DEFAULT_COLS, perPage = MAX_CELLS_PER_SHEET): SheetPage[] {
	const c = Math.max(1, Math.floor(cols));
	const cap = Math.max(c, Math.floor(perPage / c) * c); // 每页整行，避免最后一行只有一格
	const pages: SheetPage[] = [];
	for (let i = 0; i < cells.length; i += cap) {
		const slice = cells.slice(i, i + cap);
		pages.push({ page: pages.length + 1, cols: c, rows: Math.ceil(slice.length / c), cells: slice });
	}
	return pages;
}

/**
 * `drawtext` 的文本转义。
 *
 * ffmpeg 的滤镜串有三层解析（滤镜图 → 滤镜参数 → drawtext 自己的 text），
 * `:` `'` `\` `%` 任何一个没转义都会让整条命令**改变语义而不是报错**。
 * 镜号里出现 `:` 不是假设——`video:0` 这种轨道串就带冒号。
 */
export function escapeDrawText(s: string): string {
	return s
		.replace(/\\/g, "\\\\\\\\")
		.replace(/'/g, "\\\\'")
		.replace(/:/g, "\\\\:")
		.replace(/%/g, "\\\\%");
}

/** 单格的字号：跟格宽走，太小 agent 读不出镜号，太大盖住画面。 */
export function labelFontSize(cellWidth: number): number {
	return Math.max(12, Math.round(cellWidth / 14));
}

/**
 * 从 return-v1 manifest 取标签。
 *
 * 标签形如 `B03 s1`（镜号必出）；有时长就带上——出图验收时「这一镜多长」是判读依据之一。
 */
export function labelsFromManifest(manifest: {
	beatId?: unknown;
	items?: unknown;
}): SheetCell[] | null {
	const beat = typeof manifest.beatId === "string" ? manifest.beatId.toUpperCase() : null;
	if (!beat || !Array.isArray(manifest.items)) return null;
	return (manifest.items as Array<Record<string, unknown>>)
		.filter((it) => typeof it.file === "string")
		.sort((a, b) => Number(a.shotIndex ?? 0) - Number(b.shotIndex ?? 0))
		.map((it) => {
			const dur = typeof it.measuredSec === "number" ? ` ${Math.round(it.measuredSec * 10) / 10}s` : "";
			return { file: String(it.file), label: `${beat} s${String(it.shotIndex ?? "?")}${dur}` };
		});
}
