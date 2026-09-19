/**
 * 字幕整形纯叶子（change link-subtitle-cloud-line-split，design D7）：
 * 同句回缝 · 最小可读时长过滤 · 云端拆行结果的父句归属与字级时间回贴 · 小 gap 桥接。
 *
 * ★ 零 import、不碰 DOM、不含任何字宽数字或切点规则——断句全部在云端
 *   （infra `subtitle_line_split`），本文件只做**数据对齐**（design D1 的判据：不产生 transcript
 *   里不存在的句界）。
 * ★ 本文件在两仓**逐字节同源**：gitruck-opencut-rewrite `apps/web/src/subtitles/caption-align.ts` 与
 *   cli `src/lib/caption-align.ts`（两仓各以同一份黄金样本 `caption-align.golden.json` 对拍）；
 *   改任一处 MUST 同批改另一处。同步基线：2026-09-06。
 *   ⚠️ 2026-09-07 cli 侧先行（add-cross-clock-adapter D4：`attributeAndAlign` 兜底分支钳进父句包络 + `stats` 出参），
 *   客户端仓待同步（该 change 转出项）；黄金样本 `aligned / bridged` 逐字节未变（样本里无越出父句的行）。
 *   ⚠️ 2026-09-07 cli 侧再先行（unify-time-consumers-and-tolerance D2）：三种时间比较全部落到**整毫秒格**
 *   （`CAPTION_TIME_GRID_MS = 1`），匿名 ε 常量与裸 10⁻³ 清退；客户端件镜像同一组常量与判据，
 *   两仓共用测试向量 `test/fixtures/caption-align-grid.json`。
 * ★ 零 import 的代价：秒 → 整毫秒的换算在本文件**本地镜像**一份 `sec2ms`（与 `frame-domain.ts sec2ms` 逐字同体、
 *   MUST NOT 分叉）——这是全仓 `Math.round(x × 1000)` 机械判据的登记豁免行（同 `mg-lint.ts` 零依赖豁免），
 *   理由：本文件在客户端仓没有 `frame-domain` 可 import，加 import 即破两仓逐字节同源。
 */

/** 轨上时基的字（秒）。 */
export interface AlignedWord {
	w: string;
	st: number;
	ed: number;
}

/**
 * 投影实例 / 回缝后的句（同形）。`words === null` = 该 utterance 无字级时码（TTS 产物），
 * 文本为整句、时间为句级求交结果。
 */
export interface ProjectedUnit {
	utteranceId: string;
	text: string;
	startTime: number;
	endTime: number;
	words: AlignedWord[] | null;
	/**
	 * 残片标记（adjust-caption-keep-complete-sentence / link-caption-keep-complete-sentence，2026-09-19）：
	 * true = 本实例只覆盖了该 utterance 的一部分（有字级时码：存活字数 < 整句字数；
	 * 无字级时码：句级求交区间小于整句区间）。最小可读时长过滤**只对残片生效**——
	 * 完整句无论多短都保留（0.76s 的「这不是比喻」是内容，不是噪声；真机手修时被补回过）。
	 * 缺席 = 按完整句处理：过滤宁可少丢、不可多丢。
	 */
	partial?: boolean;
	/** 该 utterance 的整句字数（有字级时码时），回缝后据此重算 `partial`；无字级时码为 null / 缺席。 */
	totalWords?: number | null;
}

/** 云端拆行接口的行（轨上秒）。 */
export interface SplitLine {
	text: string;
	st: number;
	ed: number;
}

/** 整形产物（与 CaptionChunk 同形，本文件不 import 它以保持零依赖）。 */
export interface ShapedCaption {
	text: string;
	startTime: number;
	duration: number;
}

/** 同句回缝阈值（秒）——与 cli `CAPTION_RESEW_GAP_SEC` 同值（2026-09-04 拍板：真机同句碎片 gap 0.07~0.13s，真实句间停顿通常 > 0.5s）。 */
export const DEFAULT_RESEW_GAP_SECONDS = 0.5;

/**
 * 小 gap 桥接阈值（秒）——与 cli `--max-gap` 缺省同值。语义 = 剪映「自动填充文本空隙」，但**过长的空隙不硬填**。
 *
 * 取值 1.5（主理人 2026-09-06 提出「过长 gap 不硬填」，阈值按真机数据定）：口播工程 90 条字幕 89 个相邻 gap 的分布
 * 为 <0.5s 76 个、0.5~1.31s 13 个（逐条核对全是句间换气：「举个例子啊」→「我记得有个电影里面呢」0.76s 之类）、
 * ≥1.5s 0 个。0.5 会把这 13 处换气留成 0.5~1.3s 的黑屏闪断，口播里看着像故障；换气与真正的停顿（转场 / 留白 /
 * 切 B-roll，通常 ≥2s）之间 1.5 是一个数量级的空档。
 * ⚠️ 与 `DEFAULT_RESEW_GAP_SECONDS` 是两个问题（回缝问「是不是同一句」，桥接问「视觉上要不要拉长前条」），MUST NOT 共用。
 */
export const DEFAULT_BRIDGE_GAP_SECONDS = 1.5;

/**
 * 字级时码的整毫秒格（unify-time-consumers-and-tolerance D2；capability `time-tolerance-whitelist` 白名单项）：
 * 本文件所有时间比较的**唯一**容差——「相邻 / 相同」= 整毫秒相等，「推进到下一父句」= 行起点 + 1 格 ≥ 父句终点。
 * MUST NOT 再引入 10⁻⁶ / 10⁻³ 一类匿名 ε：审计与实现引用同一个常量。
 */
export const CAPTION_TIME_GRID_MS = 1;

/** 秒 → 整毫秒（`frame-domain.ts sec2ms` 的零 import 镜像，见文件头；MUST 与正本逐字同体）。 */
const sec2ms = (sec: number): number => Math.round(sec * 1000);

/**
 * 同句回缝：相邻且同 `utteranceId` 且 gap ≤ 阈值（含负 gap）的实例并为一条。
 * 有字级时码：字按轨上 `st` 归并、去掉完全重复的字（同一素材摆在两条轨上会吐出时码全等的实例），
 * 文本 = 归并后的字拼接（跟着音频走）；无字级时码：保留整句一次，时间取包络。
 * 入参 MUST 已按 `startTime` 升序。
 */
export function resewProjectedInstances(
	instances: ProjectedUnit[],
	gapSec: number = DEFAULT_RESEW_GAP_SECONDS,
): { units: ProjectedUnit[]; mergedCount: number } {
	const units: ProjectedUnit[] = [];
	let mergedCount = 0;
	for (const inst of instances) {
		const prev = units[units.length - 1];
		if (
			prev &&
			prev.utteranceId === inst.utteranceId &&
			sec2ms(inst.startTime - prev.endTime) <= sec2ms(gapSec)
		) {
			let survivingWords: number | null = null;
			if (prev.words && inst.words) {
				const merged = mergeWordsByTime(prev.words, inst.words);
				prev.words = merged;
				prev.text = merged.map((w) => w.w).join("");
				survivingWords = merged.length;
			}
			// 回缝后重算残片：并回的存活字仍不足整句才算残片；无字级时码两片都是残片才仍算残片
			// （合起来可能已覆盖整句，宁可不丢）。两侧都没标记时不凭空造键（存量调用方产物逐字节不变）。
			const partial = mergedPartial(prev, inst, survivingWords);
			if (partial !== undefined) prev.partial = partial;
			if (prev.totalWords === undefined && inst.totalWords !== undefined) prev.totalWords = inst.totalWords;
			prev.startTime = Math.min(prev.startTime, inst.startTime);
			prev.endTime = Math.max(prev.endTime, inst.endTime);
			mergedCount += 1;
			continue;
		}
		units.push({
			utteranceId: inst.utteranceId,
			text: inst.text,
			startTime: inst.startTime,
			endTime: inst.endTime,
			words: inst.words ? inst.words.map((w) => ({ ...w })) : null,
			...(inst.partial !== undefined ? { partial: inst.partial } : {}),
			...(inst.totalWords !== undefined ? { totalWords: inst.totalWords } : {}),
		});
	}
	return { units, mergedCount };
}

function mergedPartial(
	prev: ProjectedUnit,
	inst: ProjectedUnit,
	survivingWords: number | null,
): boolean | undefined {
	const total = prev.totalWords ?? inst.totalWords ?? null;
	if (survivingWords !== null && total !== null) return survivingWords < total;
	if (prev.partial === undefined && inst.partial === undefined) return undefined;
	return prev.partial === true && inst.partial === true;
}

function mergeWordsByTime(a: AlignedWord[], b: AlignedWord[]): AlignedWord[] {
	const all = [...a, ...b].sort((x, y) => x.st - y.st || x.ed - y.ed);
	const out: AlignedWord[] = [];
	for (const w of all) {
		const last = out[out.length - 1];
		// 字级时码「相同」= 整毫秒相等（同一素材摆在两条轨上吐出的重复字，时码差只会是浮点尾差）
		if (last && last.w === w.w && sec2ms(last.st) === sec2ms(w.st) && sec2ms(last.ed) === sec2ms(w.ed)) {
			continue;
		}
		out.push(w);
	}
	return out;
}

/**
 * 最小可读时长过滤（MUST 在回缝之后、拆行之前）。
 * **只丢残片**（`partial === true` 且短于 `minSec`）；完整句无论多短都保留，交给后面的小 gap 桥接延长，
 * 桥不到（后一行紧接）就按实际时长显示。未标记 `partial` 的单元按完整句处理。
 */
export function dropShortUnits(
	units: ProjectedUnit[],
	minSec: number,
): { kept: ProjectedUnit[]; droppedCount: number } {
	const kept: ProjectedUnit[] = [];
	let droppedCount = 0;
	for (const u of units) {
		if (u.partial === true && u.endTime - u.startTime < minSec) droppedCount += 1;
		else kept.push(u);
	}
	return { kept, droppedCount };
}

/** 内容字符判据：非空白、非标点、非符号（对齐时两侧同时过滤，服务端标点清洗不影响对齐）。 */
function isContentChar(ch: string): boolean {
	return !/[\p{P}\p{S}\s]/u.test(ch);
}

/**
 * 把 utterance 原文里紧跟在每个字后面的标点 / 空白（最长连续串）挂回该字。
 *
 * 投影只按 `words[]` 取字，而 transcript 的 `words[]` **不含标点**（oral_cut 逐字时码只给汉字），
 * 不挂回去，字幕里的顿号 / 问号 / 引号就全丢了——08-21 拍板只清逗号句号、其余标点 SHALL 保留。
 * 标点归前字（「切在标点之后」的既有口径）；原文找不到的字原样保留、游标不动；被剪掉的字连同它
 * 后面的标点一起消失。`words` 可以是全量也可以只是存活子集（游标按序 indexOf，两种都对）。
 */
export function attachPunctuation(text: string, words: AlignedWord[]): AlignedWord[] {
	let cursor = 0;
	return words.map((word) => {
		if (!word.w) return { ...word };
		const at = text.indexOf(word.w, cursor);
		if (at < 0) return { ...word };
		let end = at + word.w.length;
		let trail = "";
		while (end < text.length && !isContentChar(text[end])) {
			trail += text[end];
			end += 1;
		}
		cursor = end;
		return { ...word, w: word.w + trail };
	});
}

/** 中日韩后继判据（U+3000-30FF 标点/假名、U+3400-9FFF 表意、U+F900-FAFF 兼容、U+FF00-FFEF 全角）。
 *  写成转义而非字面：本文件在客户端受 CJK 硬编码护栏扫描（scan-hardcoded-cjk），字面形式会被当成 UI 文案误报。 */
const CJK_NEXT = /[\u3000-\u30FF\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

/**
 * 字幕文本去标点（★ 主理人 2026-08-21 真机走查拍板）：中英逗号（，,）与中英句号（。.）
 * 替换为空格——「有些标点符号在字幕里也不好看」；其余标点（引号「」『』、顿号、问号、
 * 感叹号、破折号等）一律保留（裁定只点名逗号句号）。
 *
 *  - 英文句号防误伤小数/缩写：只替换后面跟空白、行尾或中日韩字符的 `.`；
 *    `3.5`、`U.S.`（词内）、`example.com` 这类后接字母/数字的句点不动。
 *  - 英文逗号防误伤千分位：两侧都是数字的 `,`（`1,000`）不动，其余全换。
 *  - 中文逗号句号无此顾虑，全换。
 *
 * 只做「标点 → 空格」一步；收尾（连续空格折叠为一、行首行尾空格裁掉）交由 `normalizeSubtitleContent`。
 * 只影响写出的字幕 content；transcript 原文 MUST NOT 改。
 */
export function stripSubtitlePunctuation(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "，" || ch === "。") {
			out += " ";
			continue;
		}
		if (ch === ",") {
			const prev = i > 0 ? text[i - 1] : "";
			const next = i + 1 < text.length ? text[i + 1] : "";
			out += /[0-9]/.test(prev) && /[0-9]/.test(next) ? ch : " ";
			continue;
		}
		if (ch === ".") {
			const next = i + 1 < text.length ? text[i + 1] : "";
			out += next === "" || /\s/.test(next) || CJK_NEXT.test(next) ? " " : ch;
			continue;
		}
		out += ch;
	}
	return out;
}

/**
 * content 归一：trim + \r\n→\n，逐段 trim、段内空白符折叠为单空格。
 * 逗号句号换出的行尾空格因此直接消失、结尾干净。
 */
export function normalizeSubtitleContent(text: string): string {
	const normalized = text.trim().replace(/\r\n/g, "\n");
	return normalized
		.split("\n")
		.map((paragraph) => {
			const trimmed = paragraph.trim();
			return trimmed ? trimmed.split(/\s+/).join(" ") : "";
		})
		.join("\n");
}

/** 一键上字幕的落轨文本清洗（08-21 规则 + 归一）。`.srt` / `.ass` 导入不走这里（用户文件语义优先）。 */
export function cleanCaptionText(text: string): string {
	return normalizeSubtitleContent(stripSubtitlePunctuation(text));
}

function contentChars(text: string): string[] {
	const out: string[] = [];
	for (const ch of text) if (isContentChar(ch)) out.push(ch);
	return out;
}

/** `attributeAndAlign` 的可选统计出参（调用方给一个对象进来，函数只自增）。 */
export interface AlignStats {
	/** 兜底分支（服务端时码）被钳进父句包络的行数（add-cross-clock-adapter D4）。 */
	clampedLines: number;
}

/**
 * 云端拆行结果 → 字幕：先按时间把每行归属到父句，再按内容字符对齐到父句的字、行时间取字级包络
 * （design D5）。对不齐 / 父句无字级时码 ⇒ 该行用服务端时码（按字数摊分）。显示文本恒取服务端返回行。
 *
 * 归属只依赖服务端契约「子行首尾相接、首行 st = 父 st、顺序保持」；与文本形态无关。
 *
 * 兜底分支的上界（add-cross-clock-adapter D4，spec `subtitle-lay-command`「云端整形行时码 SHALL 钳进父句包络」）：
 * 服务端行与父句同在轨道时基（不跨钟）但此前**无上界**——整形结果越出父句区间会原样落 `client_visual_elements`。
 * 现在服务端时码 MUST 钳进 `[unit.startTime, unit.endTime]`；钳后 `ed ≤ st`（整行落在父句之外）⇒ 走既有
 * 「对不齐」处理（沿服务端时码），计数进 `stats.clampedLines`。字级回贴路天然在父句内，不经钳位。
 */
export function attributeAndAlign({
	units,
	lines,
	stats,
}: {
	units: ProjectedUnit[];
	lines: SplitLine[];
	stats?: AlignStats;
}): ShapedCaption[] {
	const out: ShapedCaption[] = [];
	if (units.length === 0) return out;
	let ui = 0;
	// 当前父句的内容字符 → 字下标；cursor = -1 表示本父句已放弃对齐（后续各行用服务端时码）
	let charMap: Array<{ ch: string; wordIdx: number }> = [];
	let cursor = -1;
	const enterUnit = (index: number) => {
		ui = index;
		const u = units[index];
		if (u.words && u.words.length > 0) {
			charMap = [];
			u.words.forEach((w, wordIdx) => {
				for (const ch of w.w) if (isContentChar(ch)) charMap.push({ ch, wordIdx });
			});
			cursor = charMap.length > 0 ? 0 : -1;
		} else {
			charMap = [];
			cursor = -1;
		}
	};
	enterUnit(0);

	for (const line of lines) {
		while (ui + 1 < units.length && sec2ms(line.st) + CAPTION_TIME_GRID_MS >= sec2ms(units[ui].endTime)) enterUnit(ui + 1);
		const unit = units[ui];
		let startTime = line.st;
		let endTime = line.ed;
		let fromWords = false;
		if (cursor >= 0 && unit.words) {
			const want = contentChars(line.text);
			let ok = want.length > 0 && cursor + want.length <= charMap.length;
			for (let k = 0; ok && k < want.length; k++) {
				if (charMap[cursor + k].ch !== want[k]) ok = false;
			}
			if (ok) {
				const first = unit.words[charMap[cursor].wordIdx];
				const last = unit.words[charMap[cursor + want.length - 1].wordIdx];
				if (last.ed > first.st) {
					startTime = first.st;
					endTime = last.ed;
					fromWords = true;
				}
				cursor += want.length;
			} else {
				// 对不齐：本父句余下各行一律退服务端时码（部分对齐只会造出错位的混合体）
				cursor = -1;
			}
		}
		if (!(endTime > startTime)) {
			startTime = line.st;
			endTime = line.ed;
			fromWords = false;
		}
		if (!fromWords) {
			// 兜底分支（服务端时码）钳进父句包络（D4）：钳后仍有正时长才采信；否则整行在父句外 ⇒ 沿服务端时码（既有对不齐路径）
			const st = Math.max(startTime, unit.startTime);
			const ed = Math.min(endTime, unit.endTime);
			if (ed > st && (st !== startTime || ed !== endTime)) {
				startTime = st;
				endTime = ed;
				if (stats) stats.clampedLines += 1;
			}
		}
		out.push({ text: line.text, startTime, duration: endTime - startTime });
	}
	return out;
}

/** 小 gap 桥接：只桥 `0 < gap ≤ maxGapSec`（真实长停顿不桥）。原地修改并返回桥接次数。 */
export function bridgeSmallGaps(
	captions: ShapedCaption[],
	maxGapSec: number = DEFAULT_BRIDGE_GAP_SECONDS,
): number {
	let bridged = 0;
	if (!(maxGapSec > 0)) return 0;
	for (let i = 0; i + 1 < captions.length; i++) {
		const cur = captions[i];
		const next = captions[i + 1];
		// 整毫秒格上判「有缝」：亚毫秒缝 = 相邻，不计桥接
		const gapMs = sec2ms(next.startTime - (cur.startTime + cur.duration));
		if (gapMs > 0 && gapMs <= sec2ms(maxGapSec)) {
			cur.duration = next.startTime - cur.startTime;
			bridged += 1;
		}
	}
	return bridged;
}

/** 未拆行的降级路：回缝后的句直接成条。 */
export function unitsToCaptions(units: ProjectedUnit[]): ShapedCaption[] {
	return units.map((u) => ({ text: u.text, startTime: u.startTime, duration: u.endTime - u.startTime }));
}
