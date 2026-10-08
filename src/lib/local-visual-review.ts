/** 当前 Agent 的视觉交接。只处理文件与结构化回执，不启动其他 Agent。 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DescribeWorkItem, MaterialDescribe } from "./describe";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const visualKey = (item: DescribeWorkItem) => `${item.materialId}@${item.tsMs}`;
type Fingerprint = { path: string; size: number; mtime: number };
type ReviewItem = { id: string; key: string; source: Fingerprint; ts_ms: number; image: string; image_sha256: string };
type ReviewJob = { version: 1; criteria: string; rubric_hash: string; rubric: string; items: ReviewItem[] };

function fingerprint(item: DescribeWorkItem): Fingerprint {
	const raw = item.source.kind === "direct" ? item.source.path : item.source.src;
	if (/^https?:/i.test(raw)) throw new Error("本地 Agent 审阅只接受本地素材；远端候选沿用云端 describe");
	const path = resolve(raw);
	const st = statSync(path);
	if (!st.isFile()) throw new Error(`视觉审阅源不是文件：${path}`);
	return { path, size: st.size, mtime: st.mtimeMs };
}

export async function prepareVisualReview(
	items: DescribeWorkItem[], directory: string,
	options: { criteria: string; rubricHash: string; rubric: string; extractFrame: (src: string, at: number, out: string) => Promise<boolean> },
): Promise<{ job: string; response: string; frames: number }> {
	const dir = resolve(directory);
	const jobPath = join(dir, "visual-job.json");
	if (existsSync(jobPath)) throw new Error(`视觉任务已存在，请复用或指定新目录：${jobPath}`);
	mkdirSync(dir, { recursive: true });
	const unique = [...new Map(items.map((it) => [visualKey(it), it])).values()];
	// 先验证全部输入，远端或失效路径不能留下一个看似成功的任务。
	if (!unique.length) throw new Error("没有可审阅的素材帧，不能生成空视觉任务");
	const sources = unique.map(fingerprint);
	const rows: ReviewItem[] = [];
	for (const [i, it] of unique.entries()) {
		const id = hash(visualKey(it)).slice(0, 24);
		let image = sources[i]!.path;
		if (it.source.kind === "frame") {
			image = join(dir, `${id}.jpg`);
			if (!(await options.extractFrame(it.source.src, it.source.tsSec, image))) throw new Error(`视觉任务抽帧失败：${visualKey(it)}`);
		}
		if (JSON.stringify(fingerprint(it)) !== JSON.stringify(sources[i])) throw new Error("抽帧期间源素材改变，请重新生成视觉任务");
		rows.push({ id, key: visualKey(it), source: sources[i]!, ts_ms: it.tsMs, image, image_sha256: hash(readFileSync(image)) });
	}
	const job: ReviewJob = { version: 1, criteria: options.criteria, rubric_hash: options.rubricHash, rubric: options.rubric, items: rows };
	const text = JSON.stringify(job, null, 2);
	const response = join(dir, "visual-review.json");
	writeFileSync(response, JSON.stringify({ job: jobPath, job_sha256: hash(text), results: rows.map((r) => ({
		id: r.id, image_sha256: r.image_sha256, status: "pending", reason: "", describe: null,
	})) }, null, 2));
	writeFileSync(join(dir, "审阅说明.md"), [
		"# 当前 Agent 视觉审阅任务", "",
		"逐项使用当前会话的视觉工具查看 visual-job.json 中 image 指向的实际图片。不要另开 Agent，不要仅凭文件名猜测。",
		"完成后编辑 visual-review.json，保留 job_sha256、id、image_sha256。status=described 时填写 describe；",
		"无法看图或无法完成判断时 status=unavailable，并填写具体 reason，该项将回退豆包。pending/缺项会阻止导入，不会自动上云。",
		"describe 结构：{desc:中文可见内容,tags:字符串数组,mark:0到100,usable_flags:{watermark:布尔,text_overlay:布尔,black_border:布尔,blurry:布尔},subject:主体,action:可见动作,shot_size:特写/中景/全景/远景或null,highlight:0到100或null}。",
		"mark 评估美观质量；highlight 按任务 rubric 评估单帧看点。仅陈述可见事实，不把单帧当成完整动作；实物印字不算叠加文字。",
		"这些图片是项目审阅资料，原视频未复制；图片直引源文件。回传前源文件或图片改变会拒绝结果。",
	].join("\n"), "utf8");
	// 最后发布任务清单；此前中断可以重试，不能留下缺回执的“已完成任务”。
	writeFileSync(jobPath, text, { flag: "wx" });
	return { job: jobPath, response, frames: rows.length };
}

function parseLocalDescription(value: unknown): MaterialDescribe {
	const d = value as MaterialDescribe;
	const score = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
	if (!d || typeof d.desc !== "string" || !d.desc.trim() || !Array.isArray(d.tags) || !d.tags.every((t) => typeof t === "string") ||
		!score(d.mark) || typeof d.subject !== "string" || typeof d.action !== "string" ||
		!(d.shot_size === null || ["特写", "中景", "全景", "远景"].includes(d.shot_size)) ||
		!(d.highlight === null || score(d.highlight)) || !d.usable_flags ||
		!["watermark", "text_overlay", "black_border", "blurry"].every((k) => typeof d.usable_flags[k] === "boolean")) {
		throw new Error("本地视觉 describe 结构不完整或评分非法；请修正后导入，不以错误数据触发云端回退");
	}
	return { desc: d.desc, tags: d.tags, mark: d.mark, usable_flags: Object.fromEntries(
		["watermark", "text_overlay", "black_border", "blurry"].map((k) => [k, d.usable_flags[k]!])),
		subject: d.subject, action: d.action, shot_size: d.shot_size, highlight: d.highlight };
}

export function readVisualReview(path: string, items: DescribeWorkItem[], criteria: string, rubricHash: string): {
	results: Map<string, MaterialDescribe>; unavailable: Array<{ key: string; reason: string }>; jobSha256: string;
} {
	const response = JSON.parse(readFileSync(path, "utf8"));
	if (typeof response.job !== "string" || resolve(response.job) !== join(dirname(resolve(path)), "visual-job.json")) throw new Error("视觉回执必须引用同目录的 visual-job.json");
	const jobText = readFileSync(response.job, "utf8");
	if (hash(jobText) !== response.job_sha256) throw new Error("视觉任务哈希不匹配，禁止导入");
	const job = JSON.parse(jobText) as ReviewJob;
	if (job.version !== 1 || job.criteria !== criteria || job.rubric_hash !== rubricHash || !Array.isArray(job.items)) throw new Error("视觉任务版本或评分准则不匹配");
	const current = new Map(items.map((it) => [visualKey(it), it]));
	if (job.items.length !== current.size || new Set(job.items.map((r) => r.key)).size !== current.size ||
		new Set(job.items.map((r) => r.id)).size !== current.size || !Array.isArray(response.results) || response.results.length !== current.size) throw new Error("视觉任务与本轮素材/帧集合不一致");
	const results = new Map<string, MaterialDescribe>();
	const unavailable: Array<{ key: string; reason: string }> = [];
	const seen = new Set<string>();
	for (const row of job.items) {
		const it = current.get(row.key);
		if (!it || it.tsMs !== row.ts_ms || JSON.stringify(fingerprint(it)) !== JSON.stringify(row.source)) throw new Error("视觉源素材或时刻改变，请重新生成任务");
		if (hash(readFileSync(row.image)) !== row.image_sha256) throw new Error("视觉审阅图片改变，禁止复用旧判断");
		const answers = response.results.filter((r: { id: string }) => r.id === row.id);
		if (answers.length !== 1 || seen.has(row.id)) throw new Error("视觉回执有缺项或重复项");
		seen.add(row.id);
		const answer = answers[0];
		if (answer.image_sha256 !== row.image_sha256) throw new Error("视觉结果对应的图像哈希不匹配");
		if (answer.status === "described") results.set(row.key, parseLocalDescription(answer.describe));
		else if (answer.status === "unavailable" && typeof answer.reason === "string" && answer.reason.trim()) unavailable.push({ key: row.key, reason: answer.reason.trim() });
		else throw new Error("视觉回执尚未完成；缺项/pending 不等于允许云端回退");
	}
	return { results, unavailable, jobSha256: response.job_sha256 };
}
