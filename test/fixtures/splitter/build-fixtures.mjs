/**
 * 金样 fixture 生成器（单一真相源）——把《过拟合》20-beat 金样合成一套「互洽三件」：
 *   ① test/fixtures/splitter/transcript.json   合成 transcript（单调时码、u0001 起编号、源时基）
 *   ② test/fixtures/splitter/project.gtrk       单源恒等 fixture gtrk（单 clip 全长引用 → 恒等投影）
 *   ③ skills/gtrk-splitter/references/example-visual-split.json  20-beat 金样迁移版拆分稿
 *
 * 三件互洽：拆分稿 span 引用 transcript 的真实 utterance id、transcript_hash 对得上（防错版硬拒可过）。
 * 供 skill 作示例，同时供 test/split.test.mjs 端到端 dry-run 复用。改金样只改本文件、`node build-fixtures.mjs` 重生。
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATERIAL_ID = "F-overfitting-fixture";
const SOURCE_PATH = "C:/fixture/overfitting.mp4";
const UTTER_SEC = 4.0; // 每句时长（合成单调时码）

// 20-beat 金样：每 beat 的字段 + 该 beat 覆盖的句子（合成文稿）。
const BEATS = [
	{
		id: "B01", base_track: "真人出镜", lane: "A_ROLL", narrative: "mirror-hook", container_stage: "none",
		rhythm: "平稳 -> 停顿", visual_task: "主持人直视镜头带观众做掐虎口实验，让观众从旁观者变成参与者",
		irreplaceability: "必须真人出镜",
		aux_layers: [{ type: "quote-card", mount: { from: "u0001", to: "u0002" }, role: "金句提炼", note: "先把反常识理论钉住，再进入身体实验", necessity: "强建议" }],
		utterances: ["精神分析中有一句话说得极好。", "你以为的痛苦，其实是在享受剩余快感。", "现在告诉我你痛吗，好了恭喜你，完整体验了潜意识里最隐秘的享乐闭环。"],
	},
	{
		id: "B02", base_track: "口播继续", lane: "FILM_BROLL", narrative: "mirror-hook", container_stage: "none",
		rhythm: "快剪", visual_task: "用亲人离去、职场背刺、关系破裂、都市独处等现实碎片建立普遍痛感",
		irreplaceability: "可被 B-roll 替代",
		handoff: { queries: ["都市独处 夜晚", "地铁 疲惫 通勤", "关系破裂 争吵"], shots: 6, per_shot_sec: 2, exclude: ["卡通", "明显水印"] },
		utterances: ["这就是通俗意义上的痛苦。", "从不相信，到沉默，到愤怒，到绝望。", "最后如果你运气好，你会走到接受。"],
	},
	{
		id: "B03", base_track: "口播继续", lane: "FILM_BROLL", narrative: "demolition", container_stage: "none",
		rhythm: "快剪 -> 停顿", visual_task: "从深夜闪回、地铁失神、伴侣争吵中压出痛苦在被自己重复生产",
		irreplaceability: "可被 B-roll 替代",
		handoff: { queries: ["深夜 失眠 闪回", "伴侣 争吵 冷战"], shots: 4, per_shot_sec: 2.5 },
		aux_layers: [{ type: "quote-card", mount: "same_beat", role: "情绪聚焦", note: "把身体实验回扣成一句能留下来的判断", necessity: "强建议" }],
		utterances: ["随着时间推移，深夜闪回、地铁失神、伴侣争吵不断上演。", "我们，一直在自己掐自己的虎口。"],
	},
	{
		id: "B04", base_track: "真人出镜", lane: "A_ROLL", narrative: "demolition", container_stage: "seed",
		rhythm: "悬停", visual_task: "主持人正面抛出从心理学跨越到人工智能的桥，完成容器首次登场",
		irreplaceability: "必须真人出镜",
		aux_layers: [{ type: "term-callout", mount: { trigger: "u0009" }, role: "术语解释", note: "首次给英文名和中文名，便于后文反复调用", necessity: "必须" }],
		utterances: ["在精神分析学家拉康眼中，事情没那么简单。", "你的痛苦，不过是一场荒诞的过拟合。"],
	},
	{
		id: "B05", base_track: "旁白主导", lane: "RRV_MG", narrative: "container-translation", container_stage: "expand",
		rhythm: "平稳", visual_task: "用训练集、噪音、测试集、错误预测的动态图把过拟合先讲清楚",
		irreplaceability: "优先 MG", fallback: "若 MG 档期不足，可降级为 A_ROLL + 简单图表动效",
		handoff: { slug_hint: "neural-overfit", theme: "overfitting", bg: "paper", duration_hint: 12 },
		utterances: ["什么是过拟合？", "模型把训练数据里的噪音也当成不可动摇的真理。", "面对没见过的新题，它给出一个极其离谱的错误答案。"],
	},
	{
		id: "B06", base_track: "旁白主导", lane: "RRV_MG", narrative: "container-translation", container_stage: "translate",
		rhythm: "渐升", visual_task: "把 AI 过拟合映射到创伤、自动化防御、现实崩溃，完成 AI 到人类的翻译",
		irreplaceability: "优先 MG",
		handoff: { slug_hint: "dual-pane-map", theme: "overfitting", bg: "paper", duration_hint: 14 },
		aux_layers: [{ type: "network-diagram", mount: "same_beat", role: "关系表达", note: "左右映射把噪音、答对过去、失去未来翻译成心理结构", necessity: "必须" }],
		utterances: ["它太想答对过去的每一道题。", "让我们把这个概念放回我们人类的身上。", "你的潜意识，依然乐此不疲地重复着自动化防御。"],
	},
	{
		id: "B07", base_track: "旁白主导", lane: "AI_DRAMA", narrative: "container-translation", container_stage: "translate",
		rhythm: "平稳 -> 渐升", visual_task: "演绎弗洛伊德、创伤退伍士兵、Fort-Da 游戏，建立主动重复痛苦是为了争夺控制感",
		irreplaceability: "可降级处理", fallback: "若 AI 演绎不稳，可改为 A_ROLL + 档案照片 + 文字动画",
		handoff: { narrative: "trauma-repetition", theme: "freud-fort-da", emotion_stage: "abyssal", platform: "kling", shot_count: 5 },
		aux_layers: [{ type: "archive-caption", mount: { from: "u0016", to: "u0017" }, role: "证据标注", note: "补足年份、人物、著作名，让历史再现不只是氛围画面", necessity: "强建议" }],
		utterances: ["1920年，弗洛伊德发表了著名的《超越快乐原则》。", "那些创伤退伍士兵，在梦里每天反复重演战场上的血肉横飞。", "小孙子把线轴用力扔到床底下，又一次次把它拉回来。", "我们在幻想着，控制那混乱无序的痛苦根源。"],
	},
	{
		id: "B08", base_track: "口播继续", lane: "FILM_BROLL", narrative: "container-translation", container_stage: "translate",
		rhythm: "快剪", visual_task: "用评论区对骂、戾气、猫梗、羞辱感把过拟合落到当代网络环境",
		irreplaceability: "可被 B-roll 替代",
		handoff: { queries: ["社交媒体 评论区 对骂", "手机屏幕 戾气 弹幕"], shots: 5, per_shot_sec: 1.8, exclude: ["真实人脸特写"] },
		aux_layers: [{ type: "network-diagram", mount: "same_beat", role: "关系表达", note: "羞辱到恐惧到抢先惩罚到愤怒到剩余享乐的连锁图", necessity: "强建议" }],
		utterances: ["再来看看现在很多社媒的评论区。", "被嘲笑的其实不是那只猫，而是我自己。", "于是我的潜意识，获得了那可怜的剩余享乐。"],
	},
	{
		id: "B09", base_track: "口播继续", lane: "FILM_BROLL", narrative: "abyssal-fall", container_stage: "rupture",
		rhythm: "悬停", visual_task: "从草丛惊动、捕食风险切到现代都市失配，做出旧生存策略变成顽疾的冷落差",
		irreplaceability: "可被 B-roll 替代",
		handoff: { queries: ["荒野 草丛 风声", "都市 人群 疏离"], shots: 4, per_shot_sec: 2.2 },
		utterances: ["这其实是人类进化留在基因里的一部分。", "旧的生存策略，在今天却变成了一种精神的顽疾。"],
	},
	{
		id: "B10", base_track: "真人出镜", lane: "A_ROLL", narrative: "abyssal-fall", container_stage: "rupture",
		rhythm: "停顿", visual_task: "主持人重新出镜，直问看见过拟合之后能否脱离循环，把观众锁进悬崖边",
		irreplaceability: "必须真人出镜",
		aux_layers: [{ type: "pause-card", mount: { trigger: "u0027" }, role: "停顿加压", note: "让答案暂时缺席，制造真空感", necessity: "必须" }],
		utterances: ["好，那么问题来了。", "看见了过拟合之后，我们是不是就能脱离这种循环？"],
	},
	{
		id: "B11", base_track: "口播继续", lane: "FILM_BROLL", narrative: "demolition", container_stage: "rupture",
		rhythm: "快剪", visual_task: "把脱敏、和解、发泄、打枕头做成一组被逐个击穿的商品化镜头",
		irreplaceability: "可被 B-roll 替代",
		handoff: { queries: ["心理疗愈 商品 广告感", "打枕头 发泄 房间"], shots: 5, per_shot_sec: 1.8, exclude: ["真实诊疗记录"] },
		aux_layers: [{ type: "quote-card", mount: "same_beat", role: "金句提炼", note: "把批判压成一句容易传播的判断", necessity: "强建议" }],
		utterances: ["现在市面上有很多流行的心理学流派。", "脱敏、和解、发泄、打枕头，最后往往只是旧病复发。"],
	},
	{
		id: "B12", base_track: "口播继续", lane: "FILM_BROLL", narrative: "abyssal-fall", container_stage: "rupture",
		rhythm: "平稳 -> 渐升", visual_task: "用关系案例把潜意识雷达和重复跳进火坑演成不断复写的亲密关系模式",
		irreplaceability: "可被 B-roll 替代",
		handoff: { queries: ["亲密关系 反复 争执", "童年 阴影 家庭"], shots: 4, per_shot_sec: 2.5 },
		aux_layers: [{ type: "quote-card", mount: "same_beat", role: "金句提炼", note: "把案例的底层动力压缩成一张标题卡", necessity: "强建议" }],
		utterances: ["比如，一个从小被父亲家暴的人。", "仿佛只要重演，我就能改写童年那个无能为力的自己。"],
	},
	{
		id: "B13", base_track: "真人出镜", lane: "A_ROLL", narrative: "abyssal-fall", container_stage: "rupture",
		rhythm: "悬停", visual_task: "主持人用更低更稳的语气说出你找到的只是重温旧梦的恶鬼，把实在界压到观众面前",
		irreplaceability: "必须真人出镜",
		aux_layers: [{ type: "term-callout", mount: "same_beat", role: "术语解释", note: "给实在界一个明确落点，防止术语空转", necessity: "建议" }],
		utterances: ["你的潜意识，是一台精准的雷达。", "你找到的只是重温旧梦的那个恶鬼，而它，正是你自己。"],
	},
	{
		id: "B14", base_track: "旁白主导", lane: "RRV_MG", narrative: "abyssal-fall", container_stage: "rupture",
		rhythm: "渐升", visual_task: "把神经递质、创伤印痕、代际传递、大他者压成一张逐步收紧的因果网",
		irreplaceability: "优先 MG",
		handoff: { slug_hint: "grid-captured", theme: "overfitting", bg: "paper", duration_hint: 16 },
		aux_layers: [{ type: "network-diagram", mount: "same_beat", role: "关系表达", note: "把神经元、童年、代际传递、大他者串成压迫主体的结构网络", necessity: "必须" }],
		utterances: ["斯坦福大学神经生物学教授罗伯特·萨波斯基这样说。", "每一次心跳加速，都是神经递质与创伤印痕的合谋。", "代际传递与那个大他者，共同构成了规则与匮乏。"],
	},
	{
		id: "B15", base_track: "真人出镜", lane: "A_ROLL", narrative: "holding", container_stage: "flip",
		rhythm: "停顿", visual_task: "主持人先接住观众的绝望，不急着讲希望，先让被理解成立",
		irreplaceability: "必须真人出镜",
		aux_layers: [{ type: "pause-card", mount: "same_beat", role: "停顿加压", note: "把绝望明确说透，才有后面的反转重量", necessity: "必须" }],
		utterances: ["听到这里，你可能会觉得绝望。", "如果这一切，都只是潜意识写好的剧本呢？"],
	},
	{
		id: "B16", base_track: "旁白主导", lane: "RRV_MG", narrative: "reversal-elevation", container_stage: "flip",
		rhythm: "渐升", visual_task: "用偏差-方差权衡、插值阈值、双重下降曲线完成过拟合到泛化的结构反转",
		irreplaceability: "优先 MG",
		handoff: { slug_hint: "overfit-to-double-descent", theme: "overfitting", bg: "paper", duration_hint: 15 },
		aux_layers: [{ type: "data-annotation", mount: "same_beat", role: "术语解释", note: "把几个高密度术语压成可看懂的几个标注点", necessity: "强建议" }],
		utterances: ["在传统的机器学习理论中，过拟合意味着失败。", "但越过那个插值阈值，模型反而展现出不可思议的泛化能力。", "这就是双重下降，是涌现出来的智能。"],
	},
	{
		id: "B17", base_track: "真人出镜", lane: "A_ROLL", narrative: "holding", container_stage: "flip",
		rhythm: "平稳", visual_task: "主持人把双重下降翻译回人的生命经验，让观众感到我不是死循环而是螺旋上升",
		irreplaceability: "必须真人出镜",
		aux_layers: [{ type: "quote-card", mount: "same_beat", role: "金句提炼", note: "把第三幕的第一波希望感提炼成一个可记忆句子", necessity: "强建议" }],
		utterances: ["人类的历史，人类的心智，不也是如此吗？", "现实也会在我们眼中，以意想不到的方式发生折叠与变化。"],
	},
	{
		id: "B18", base_track: "真人出镜", lane: "A_ROLL", narrative: "reversal-elevation", container_stage: "flip",
		rhythm: "平稳 -> 悬停", visual_task: "主持人完成认同你的症状这次真正的主体性重构，只给重新理解自身的入口",
		irreplaceability: "必须真人出镜",
		aux_layers: [{ type: "term-callout", mount: "same_beat", role: "术语解释", note: "给拉康晚期的核心提法一个清晰入口", necessity: "必须" }],
		utterances: ["在法国精神分析宗师拉康晚期的理论中。", "认同你的症状，你才能获得一点点真正的自由。"],
	},
	{
		id: "B19", base_track: "旁白主导", lane: "RRV_MG", narrative: "callback-closure", container_stage: "callback",
		rhythm: "回扣", visual_task: "把前文幽灵堵车回调出来，用自动驾驶车辆吸收刹车波浪的系统动画做出解法",
		irreplaceability: "优先 MG", callback_of: "B07",
		handoff: { slug_hint: "recall-image-question", theme: "overfitting", bg: "paper", duration_hint: 13 },
		aux_layers: [{ type: "network-diagram", mount: "same_beat", role: "关系表达", note: "把缓冲、吸收冲击波、整体起速呈现成一个系统过程", necessity: "强建议" }],
		utterances: ["回到之前的话题，我们该如何解决幽灵堵车？", "自动驾驶车辆感知到前方的刹车波浪。", "缓冲、吸收冲击波，最后所有的车流都能够慢慢起速。"],
	},
	{
		id: "B20", base_track: "真人出镜", lane: "A_ROLL", narrative: "callback-closure", container_stage: "callback",
		rhythm: "悬停", visual_task: "回到主持人，让问题停在观众心里，而不是替观众收尾",
		irreplaceability: "必须真人出镜",
		aux_layers: [{ type: "quote-card", mount: "same_beat", role: "回扣提示", note: "保留一个极简的结尾文字层，让问题在黑场里继续回荡", necessity: "建议" }],
		utterances: ["那么，我们的人生，是否还在堵车呢？"],
	},
];

/** 把一句话切成 ~3 字词元，时码在 [st,ed] 内均匀铺满（合成字级时基）。 */
function tokenize(text, st, ed) {
	const chars = [...text];
	const groups = [];
	for (let i = 0; i < chars.length; i += 3) groups.push(chars.slice(i, i + 3).join(""));
	if (!groups.length) groups.push(text);
	const per = (ed - st) / groups.length;
	return groups.map((w, i) => ({ w, st: round3(st + i * per), ed: round3(st + (i + 1) * per) }));
}

const round3 = (n) => Math.round(n * 1000) / 1000;

// ── 组装 transcript（分配 id + 单调时码）──
const utterances = [];
let cursor = 0;
let counter = 0;
const spans = {}; // beatId -> {from, to}
for (const beat of BEATS) {
	const ids = [];
	for (const text of beat.utterances) {
		counter += 1;
		const id = `u${String(counter).padStart(4, "0")}`;
		const st = round3(cursor);
		const ed = round3(cursor + UTTER_SEC);
		utterances.push({ id, st, ed, text, kept: true, words: tokenize(text, st, ed) });
		ids.push(id);
		cursor = ed;
	}
	spans[beat.id] = { from: ids[0], to: ids[ids.length - 1] };
}

const duration = round3(cursor);
const textHash = createHash("sha256").update(utterances.map((u) => u.text).join("\n")).digest("hex");

const transcript = {
	version: "v1",
	source: "oral_cut",
	script_source: "user",
	material_id: MATERIAL_ID,
	text_hash: textHash,
	duration,
	utterances,
};

// ── 组装单源恒等 gtrk（单 clip 全长引用 → 恒等投影）──
const fullClip = {
	clip_id: "c1", material: MATERIAL_ID,
	clip_st: 0, clip_ed: duration, track_st: 0, track_ed: duration, duration,
};
const gtrk = {
	version: "v1",
	video_size: [1920, 1080],
	video_rate: 30,
	duration,
	materials: [{ id: MATERIAL_ID, path: SOURCE_PATH, duration, video_size: [1920, 1080], video_rate: 30, audio_channel: "stereo" }],
	video_track: [{ track_index: 0, track_size: [1920, 1080], track_timeline: [fullClip] }],
	audio_track: [{ track_index: 0, track_timeline: [{ ...fullClip, clip_id: "a1" }] }],
	beat_track: [],
	struct_meta: { nle_draft_dir: "C:/fixture/draft" },
};

// ── 组装 20-beat 拆分稿（引用真实 id + hash）──
const exampleBeats = BEATS.map((b) => {
	const beat = {
		id: b.id,
		span: spans[b.id],
		base_track: b.base_track,
		lane: b.lane,
		narrative: b.narrative,
		container_stage: b.container_stage,
		rhythm: b.rhythm,
		visual_task: b.visual_task,
		irreplaceability: b.irreplaceability,
	};
	if (b.handoff) beat.handoff = b.handoff;
	if (b.aux_layers) beat.aux_layers = b.aux_layers;
	if (b.fallback) beat.fallback = b.fallback;
	if (b.callback_of) beat.callback_of = b.callback_of;
	return beat;
});

const queues = {
	a_roll: exampleBeats.filter((b) => b.lane === "A_ROLL").map((b) => ({ beat: b.id, note: b.visual_task })),
	rrv_mg: exampleBeats.filter((b) => b.lane === "RRV_MG").map((b) => ({ beat: b.id, note: b.visual_task })),
	ai_drama: exampleBeats.filter((b) => b.lane === "AI_DRAMA").map((b) => ({ beat: b.id, note: b.visual_task })),
	film_broll: exampleBeats.filter((b) => b.lane === "FILM_BROLL").map((b) => ({ beat: b.id, note: b.visual_task })),
};

const example = {
	contract_version: "v1",
	transcript_hash: textHash,
	beats: exampleBeats,
	queues,
};

writeFileSync(join(HERE, "transcript.json"), JSON.stringify(transcript, null, 2) + "\n");
writeFileSync(join(HERE, "project.gtrk"), JSON.stringify(gtrk, null, 2) + "\n");
const exampleOut = join(HERE, "..", "..", "..", "skills", "gtrk-splitter", "references", "example-visual-split.json");
writeFileSync(exampleOut, JSON.stringify(example, null, 2) + "\n");

console.log(`fixtures: ${utterances.length} utterances, duration=${duration}s, text_hash=${textHash}`);
console.log(`  transcript.json / project.gtrk → ${HERE}`);
console.log(`  example-visual-split.json → ${exampleOut}`);
