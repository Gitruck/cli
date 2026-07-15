/**
 * split 落地单测（change add-splitter-integration §3.4 + §5.2）：
 *   - struct_meta.split 原子写回后 .gtrk 其余键逐字节语义不变（round-trip）
 *   - 写入窗口 mtime 冲突拒写
 *   - 校验失败零副作用（split/ 目录无残留、.gtrk 未被写入）
 *   - 金样端到端 dry-run：fixture transcript + 20-beat 金样 → 落地 → 断言 struct_meta.split / dispatch 与预期一致
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, cp, readFile, writeFile, stat, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readGtrk, assertGtrkV1, writeStructMetaSplit } from "../.test-build/gtrk-writeback.mjs";
import { runSplit } from "../.test-build/split.mjs";
import { buildLanding } from "../.test-build/splitdoc.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "splitter");
const EXAMPLE = join(HERE, "..", "skills", "gtrk-splitter", "references", "example-visual-split.json");

const sampleGtrk = () => ({
	version: "v1",
	video_size: [1920, 1080],
	video_rate: 30,
	duration: 10,
	materials: [{ id: "M1", path: "C:/x.mp4", duration: 10 }],
	video_track: [{ track_index: 0, track_timeline: [{ material: "M1", clip_st: 0, clip_ed: 10, track_st: 0, duration: 10 }] }],
	audio_track: [],
	beat_track: [],
	struct_meta: { nle_draft_dir: "C:/draft" },
});

test("writeStructMetaSplit：只改 struct_meta.split、其余键 round-trip 不变", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gtrk-split-"));
	try {
		const p = join(dir, "project.gtrk");
		const original = sampleGtrk();
		await writeFile(p, JSON.stringify(original, null, 2));
		const { gtrk, mtimeMs } = readGtrk(p);
		assertGtrkV1(gtrk);
		writeStructMetaSplit(p, gtrk, { contract_version: "v1", beats: [{ id: "B01" }] }, mtimeMs);
		const after = JSON.parse(await readFile(p, "utf8"));
		// struct_meta.split 新增
		assert.equal(after.struct_meta.split.contract_version, "v1");
		assert.equal(after.struct_meta.nle_draft_dir, "C:/draft"); // 同键其余保留
		// 其余顶层键逐字节语义不变
		for (const k of ["version", "video_size", "video_rate", "duration", "materials", "video_track", "audio_track", "beat_track"]) {
			assert.deepEqual(after[k], original[k], `顶层键 ${k} 不应变化`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("writeStructMetaSplit：mtime 冲突拒写，文件不被修改", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gtrk-split-"));
	try {
		const p = join(dir, "project.gtrk");
		await writeFile(p, JSON.stringify(sampleGtrk(), null, 2));
		const { gtrk, mtimeMs } = readGtrk(p);
		// 模拟外部在 split 运行间隙改了文件（mtime 变化）
		const future = new Date(Date.now() + 10000);
		await utimes(p, future, future);
		assert.throws(() => writeStructMetaSplit(p, gtrk, { split: 1 }, mtimeMs), /保存冲突|拒绝写入/);
		const after = JSON.parse(await readFile(p, "utf8"));
		assert.equal(after.struct_meta.split, undefined); // 未写入
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("assertGtrkV1：非 v1 硬拒", async () => {
	assert.throws(() => assertGtrkV1({ version: "v0" }), /不是 v1/);
	assert.throws(() => assertGtrkV1({}), /不是 v1/);
});

/** 把 fixture 铺成标准 oralcut 产物目录布局（<base>/overfitting-fixture/{gtrk,transcript}）。 */
async function layoutProject(base) {
	const proj = join(base, "overfitting-fixture");
	await mkdir(join(proj, "gtrk"), { recursive: true });
	await mkdir(join(proj, "transcript"), { recursive: true });
	await cp(join(FIX, "project.gtrk"), join(proj, "gtrk", "project.gtrk"));
	await cp(join(FIX, "transcript.json"), join(proj, "transcript", "transcript.json"));
	return proj;
}

test("校验失败零副作用：坏 hash 拆分稿 → 抛错、无 split/ 残留、.gtrk 未写入", async () => {
	const base = await mkdtemp(join(tmpdir(), "gtrk-split-"));
	try {
		const proj = await layoutProject(base);
		const badDoc = join(base, "bad.json");
		const good = JSON.parse(await readFile(EXAMPLE, "utf8"));
		await writeFile(badDoc, JSON.stringify({ ...good, transcript_hash: "STALE" }));
		await assert.rejects(() => runSplit(badDoc, { project: proj, json: true }), /校验失败/);
		assert.equal(existsSync(join(proj, "split")), false, "split/ 目录不应产生");
		const gtrk = JSON.parse(await readFile(join(proj, "gtrk", "project.gtrk"), "utf8"));
		assert.equal(gtrk.struct_meta.split, undefined, ".gtrk 不应被写入");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("金样端到端 dry-run：20-beat 落地 → struct_meta.split + dispatch 与预期一致（恒等投影全部落轨）", async () => {
	const base = await mkdtemp(join(tmpdir(), "gtrk-split-"));
	try {
		const proj = await layoutProject(base);
		const result = await runSplit(EXAMPLE, { project: proj, json: true, md: true });
		assert.equal(result.ok, true);
		assert.equal(result.mode, "land");

		// struct_meta.split：恒等投影 → 20 beat 全落轨、无跳过/收缩
		const gtrk = JSON.parse(await readFile(join(proj, "gtrk", "project.gtrk"), "utf8"));
		const split = gtrk.struct_meta.split;
		assert.equal(split.contract_version, "v1");
		assert.equal(split.beats.length, 20);
		assert.equal(result.beats.skipped.length, 0);
		assert.equal(result.beats.shrunk.length, 0);
		// 其余 struct_meta 键保留
		assert.equal(gtrk.struct_meta.nle_draft_dir, "C:/fixture/draft");
		// hash 链透传
		const transcript = JSON.parse(await readFile(join(proj, "transcript", "transcript.json"), "utf8"));
		assert.equal(split.transcript_hash, transcript.text_hash);
		// 恒等投影：B01=u0001..u0003 → [0,12]；B20=u0049 → [192,196]
		const b01 = split.beats.find((b) => b.id === "B01");
		assert.deepEqual([b01.track_st, b01.track_ed], [0, 12]);
		const b20 = split.beats.find((b) => b.id === "B20");
		assert.deepEqual([b20.track_st, b20.track_ed], [192, 196]);
		// A_ROLL beat 不带 handoff；MG 带
		assert.equal(b01.handoff, undefined);
		assert.ok(split.beats.find((b) => b.id === "B05").handoff.duration_hint === 12);
		// source_ranges/material_id（add-split-source-ranges）：.gtrk 自包含源时基；恒等投影下 span 源包络 == 轨道包络
		assert.equal(split.material_id, transcript.material_id);
		assert.deepEqual(b01.source_ranges, [{ st: 0, ed: 12 }]);
		assert.deepEqual(b20.source_ranges, [{ st: 192, ed: 196 }]);
		// 语义字段透传（客户端 hover 详情卡「这段对应什么」）
		assert.equal(typeof b01.visual_task, "string");
		assert.ok(b01.visual_task.length > 0);
		assert.equal(typeof b01.narrative, "string");
		assert.equal(typeof b01.container_stage, "string");

		// dispatch.json：MG 5 / FILM_BROLL 6 / AI_DRAMA 1（去品牌化后桶键 mg）
		const dispatch = JSON.parse(await readFile(join(proj, "split", "dispatch.json"), "utf8"));
		assert.equal(dispatch.mg.length, 5);
		assert.equal(dispatch.film_broll.length, 6);
		assert.equal(dispatch.ai_drama.length, 1);
		assert.ok(!("rrv_mg" in dispatch), "写侧不留遗留桶键 rrv_mg");
		// composition_id = <工程slug>-<beatId>（slug 取目录名）
		assert.equal(dispatch.mg.find((r) => r.beat === "B05").composition_id, "overfitting-fixture-B05");
		assert.equal(dispatch.mg.find((r) => r.beat === "B05").duration, 12);
		// FILM_BROLL 携 queries 与轨道区间
		const film = dispatch.film_broll.find((f) => f.beat === "B02");
		assert.ok(Array.isArray(film.queries) && film.queries.length >= 1);
		assert.ok(typeof film.track_st === "number" && typeof film.track_ed === "number");
		// AI_DRAMA 透传 handoff（platform 取自 build-fixtures 金样源）
		assert.equal(dispatch.ai_drama[0].beat, "B07");
		assert.equal(dispatch.ai_drama[0].platform, "kling");

		// --md 人读稿落盘
		assert.ok(existsSync(join(proj, "split", "visual-split.md")));
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("视图模式：无 positional → 产 split/view.json，恒等投影句级时码等于源", async () => {
	const base = await mkdtemp(join(tmpdir(), "gtrk-split-"));
	try {
		const proj = await layoutProject(base);
		const result = await runSplit(undefined, { project: proj, json: true });
		assert.equal(result.mode, "view");
		assert.equal(result.counts.dropped, 0); // 恒等投影无 dropped
		const view = JSON.parse(await readFile(join(proj, "split", "view.json"), "utf8"));
		assert.equal(view.utterances[0].id, "u0001");
		assert.deepEqual([view.utterances[0].track_st, view.utterances[0].track_ed], [0, 4]);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("transcript 缺失明确报错（引导重跑 oralcut / transcribe）", async () => {
	const base = await mkdtemp(join(tmpdir(), "gtrk-split-"));
	try {
		const proj = join(base, "noltrans");
		await mkdir(join(proj, "gtrk"), { recursive: true });
		await cp(join(FIX, "project.gtrk"), join(proj, "gtrk", "project.gtrk"));
		await assert.rejects(() => runSplit(undefined, { project: proj, json: true }), /transcript\.json|transcribe/);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("buildLanding：不传 sourceIndex 不写新字段（向后兼容）；传则写 span 源包络 + material_id（r3 取整）", () => {
	const doc = {
		contract_version: "v1",
		transcript_hash: "h",
		beats: [{
			id: "B01", span: { from: "u1", to: "u2" }, base_track: "真人出镜", lane: "A_ROLL",
			narrative: "mirror-hook", container_stage: "none", rhythm: "-", visual_task: "-", irreplaceability: "-",
		}],
		queues: {},
	};
	const view = {
		transcript_hash: "h", projected_at: "t",
		utterances: [
			{ id: "u1", text: "a", track_st: 5, track_ed: 6, dropped: false, kept_words: 1, total_words: 1 },
			{ id: "u2", text: "b", track_st: 6, track_ed: 8, dropped: false, kept_words: 1, total_words: 1 },
		],
	};
	const base = { utteranceIds: ["u1", "u2"], projectSlug: "s", projectedAt: "t" };

	const plain = buildLanding(doc, view, base);
	assert.equal(plain.split.material_id, undefined);
	assert.equal(plain.split.beats[0].source_ranges, undefined);

	const withSrc = buildLanding(doc, view, {
		...base,
		sourceIndex: {
			materialId: "M1",
			utterances: new Map([["u1", { st: 3.1234, ed: 4.5 }], ["u2", { st: 4.8, ed: 7.8919 }]]),
		},
	});
	assert.equal(withSrc.split.material_id, "M1");
	assert.deepEqual(withSrc.split.beats[0].source_ranges, [{ st: 3.123, ed: 7.892 }]);
	// shrunk 语义不受影响：包络恒为全 span（含被剪部分），由消费方求交自然收窄
});

test("buildLanding：未来 lane 无 dispatch 分支 → unhandledLanes 收集告警(不静默丢队列)", () => {
	const doc = {
		contract_version: "v1",
		transcript_hash: "h",
		beats: [
			{ id: "B01", span: { from: "u1", to: "u1" }, base_track: "真人出镜", lane: "A_ROLL",
			  narrative: "-", container_stage: "none", rhythm: "-", visual_task: "-", irreplaceability: "-" },
			{ id: "B02", span: { from: "u2", to: "u2" }, base_track: "旁白主导", lane: "INTERVIEW",
			  narrative: "-", container_stage: "none", rhythm: "-", visual_task: "-", irreplaceability: "-" },
		],
		queues: {},
	};
	const view = {
		transcript_hash: "h", projected_at: "t",
		utterances: [
			{ id: "u1", text: "a", track_st: 0, track_ed: 2, dropped: false, kept_words: 1, total_words: 1 },
			{ id: "u2", text: "b", track_st: 2, track_ed: 4, dropped: false, kept_words: 1, total_words: 1 },
		],
	};
	const landing = buildLanding(doc, view, { utteranceIds: ["u1", "u2"], projectSlug: "s", projectedAt: "t" });
	// A_ROLL 故意无派单，不进 unhandled；INTERVIEW 无 dispatch 分支 → 被收集告警
	assert.deepEqual(landing.unhandledLanes, ["INTERVIEW"]);
	// 已知四 lane 全无遗漏时 unhandledLanes 为空
	const doc2 = { ...doc, beats: [doc.beats[0]] };
	assert.deepEqual(buildLanding(doc2, view, { utteranceIds: ["u1", "u2"], projectSlug: "s", projectedAt: "t" }).unhandledLanes, []);
});
