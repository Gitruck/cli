/**
 * projection.projectTranscript 单测（change add-splitter-integration §1.2）：
 * 乱序三段剪辑 / 恢复片段（clip 拉长后 word 复活）/ 恒等投影（已剪好成片）/ 复制片段多实例 / 全 dropped。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectTranscript } from "../.test-build/projection.mjs";

const PA = "2026-07-07T00:00:00.000Z"; // 注入 projected_at 保证可复现

/** 造一条 transcript：words 单字、每字 1s、句时码 = 首末字包络。 */
function mkTranscript(specs, materialId = "M1") {
	const utterances = specs.map(({ id, words }) => ({
		id,
		st: words[0].st,
		ed: words[words.length - 1].ed,
		text: words.map((w) => w.w).join(""),
		words,
	}));
	return { version: "v1", material_id: materialId, text_hash: "H", duration: 999, utterances };
}
const word = (w, st) => ({ w, st, ed: st + 1 });

// 源：u1=[0,3) 三字 / u2=[3,6) 三字 / u3=[6,9) 三字
const base = mkTranscript([
	{ id: "u1", words: [word("A", 0), word("B", 1), word("C", 2)] },
	{ id: "u2", words: [word("D", 3), word("E", 4), word("F", 5)] },
	{ id: "u3", words: [word("G", 6), word("H", 7), word("I", 8)] },
]);

const mainTrack = (clips) => ({
	version: "v1",
	video_track: [{ track_index: 0, track_timeline: clips }],
});
const clip = (clip_st, clip_ed, track_st, material = "M1") => ({
	material,
	clip_st,
	clip_ed,
	track_st,
	track_ed: track_st + (clip_ed - clip_st),
	duration: clip_ed - clip_st,
});

test("恒等投影：单 clip 全长引用 → 轨道时码与源逐字相等", () => {
	const gtrk = mainTrack([clip(0, 9, 0)]);
	const v = projectTranscript(base, gtrk, { projectedAt: PA });
	assert.equal(v.utterances.length, 3);
	assert.deepEqual(
		v.utterances.map((u) => [u.id, u.track_st, u.track_ed, u.dropped]),
		[
			["u1", 0, 3, false],
			["u2", 3, 6, false],
			["u3", 6, 9, false],
		],
	);
	assert.equal(v.transcript_hash, "H");
	assert.equal(v.projected_at, PA);
});

test("乱序三段剪辑：保留 u3、u1、u2 顺序拼接 → 视图按 track_st 排序、时码重映射", () => {
	// track: [u3@0..3][u1@3..6][u2@6..9]
	const gtrk = mainTrack([clip(6, 9, 0), clip(0, 3, 3), clip(3, 6, 6)]);
	const v = projectTranscript(base, gtrk, { projectedAt: PA });
	assert.deepEqual(
		v.utterances.map((u) => [u.id, u.track_st, u.track_ed]),
		[
			["u3", 0, 3],
			["u1", 3, 6],
			["u2", 6, 9],
		],
	);
});

test("部分剪辑 + 全 dropped：剪掉 u2、u3 整句被剪 → u2 收缩、u3 dropped 插位标记", () => {
	// 只保留 u1 全部 + u2 的前两字（D、E），u3 完全不在任何 clip
	const gtrk = mainTrack([clip(0, 5, 0)]); // 覆盖 [0,5)：u1 全、u2 的 D(3~4)E(4~5)，u3 无
	const v = projectTranscript(base, gtrk, { projectedAt: PA });
	const byId = Object.fromEntries(v.utterances.map((u) => [u.id, u]));
	assert.equal(byId.u1.dropped, false);
	assert.deepEqual([byId.u1.track_st, byId.u1.track_ed], [0, 3]);
	assert.equal(byId.u2.dropped, false);
	assert.equal(byId.u2.kept_words, 2); // 只 D、E 存活
	assert.deepEqual([byId.u2.track_st, byId.u2.track_ed], [3, 5]);
	assert.equal(byId.u3.dropped, true); // 完全被剪
	assert.equal(byId.u3.track_st, null);
	assert.equal(byId.u3.total_words, 3);
	// dropped 的 u3 按源序插位在 u2 之后
	assert.deepEqual(v.utterances.map((u) => u.id), ["u1", "u2", "u3"]);
});

test("恢复片段：clip 拉长后此前被剪的 word 复活（无需重跑转写）", () => {
	const cut = projectTranscript(base, mainTrack([clip(0, 3, 0)]), { projectedAt: PA });
	assert.equal(cut.utterances.find((u) => u.id === "u2").dropped, true); // u2 起初全被剪
	const restored = projectTranscript(base, mainTrack([clip(0, 6, 0)]), { projectedAt: PA });
	const u2 = restored.utterances.find((u) => u.id === "u2");
	assert.equal(u2.dropped, false); // clip 拉到 [0,6) → u2 复活
	assert.deepEqual([u2.track_st, u2.track_ed], [3, 6]);
});

test("复制片段：同一源区间被两 clip 引用 → 该 utterance 出现两个投影实例、按 track_st 排序", () => {
	// u1 源区间 [0,3) 被复制：一处 track@0，一处 track@10
	const gtrk = mainTrack([clip(0, 3, 0), clip(0, 3, 10)]);
	const only = mkTranscript([{ id: "u1", words: [word("A", 0), word("B", 1), word("C", 2)] }]);
	const v = projectTranscript(only, gtrk, { projectedAt: PA });
	const insts = v.utterances.filter((u) => u.id === "u1");
	assert.equal(insts.length, 2);
	assert.deepEqual(insts.map((u) => u.track_st), [0, 10]); // 排序
	assert.ok(insts.every((u) => !u.dropped && u.kept_words === 3));
});

test("全 dropped：无匹配 material 的 clip 不参与 → 全部 dropped", () => {
	const gtrk = mainTrack([clip(0, 9, 0, "OTHER")]); // material 不命中
	const v = projectTranscript(base, gtrk, { projectedAt: PA });
	assert.ok(v.utterances.every((u) => u.dropped));
	assert.equal(v.utterances.length, 3);
});

test("只扫 track_index 最小的 main 底轨，overlay 轨不参与", () => {
	const gtrk = {
		version: "v1",
		video_track: [
			{ track_index: 10, track_timeline: [clip(0, 9, 0)] }, // overlay：应被忽略
			{ track_index: 0, track_timeline: [clip(0, 3, 0)] }, // main：只覆盖 u1
		],
	};
	const v = projectTranscript(base, gtrk, { projectedAt: PA });
	assert.equal(v.utterances.find((u) => u.id === "u1").dropped, false);
	assert.equal(v.utterances.find((u) => u.id === "u2").dropped, true); // overlay 覆盖也不算
});

test("--words 开启才出字级明细", () => {
	const gtrk = mainTrack([clip(0, 3, 0)]);
	const noWords = projectTranscript(base, gtrk, { projectedAt: PA });
	assert.equal(noWords.utterances[0].words, undefined);
	const withWords = projectTranscript(base, gtrk, { projectedAt: PA, words: true });
	assert.deepEqual(withWords.utterances[0].words, [
		{ w: "A", track_st: 0, track_ed: 1 },
		{ w: "B", track_st: 1, track_ed: 2 },
		{ w: "C", track_st: 2, track_ed: 3 },
	]);
});
