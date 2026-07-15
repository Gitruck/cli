/**
 * MG 铺轨单测（add-rrv-lay §3.2，去品牌化后 mg-lay）：html-particle 落 beat_track / 幂等剥离(html_material 键) /
 * opaque 透传 / 一对一 / duration>0 兜底 / struct_meta.mg 契约 / e2e。
 * 含去品牌化双名回归：struct_meta.rrv 读旧 + rrv- 前缀剥旧 + 源目录 rrv/ 双探 + dispatch.rrv_mg 读旧。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { layMgTracks } from "../.test-build/mg-lay.mjs";
import { runMg } from "../.test-build/mg-cmd.mjs";

const baseGtrk = () => ({
	version: "v1",
	video_size: [1920, 1080],
	video_rate: 30,
	duration: 60,
	materials: [{ id: "F-main", path: "C:/x/main.mp4", duration: 60 }],
	video_track: [{ track_index: 0, track_size: [1920, 1080], track_timeline: [{ clip_id: "c1", material: "F-main", track_st: 0, track_ed: 60, duration: 60 }] }],
	audio_track: [],
	beat_track: [],
	struct_meta: { split: { contract_version: "v1" } },
});
const item = (over = {}) => ({
	beat: "B06", composition_id: "proj-B06", track_st: 63.9, track_ed: 83.9, duration: 20,
	opaque: true, html_rel: "assets/mg/proj-B06.html", ...over,
});

test("铺 html-particle 到 beat_track（不是 video_track）；materials/clip 结构正确", () => {
	const { next, summary, mg } = layMgTracks({ gtrk: baseGtrk(), items: [item()], generatedAt: "t" });
	// 落 beat_track，video_track 不动
	assert.equal(next.video_track.length, 1);
	assert.equal(next.beat_track.length, 1);
	const tr = next.beat_track[0];
	assert.ok(tr.track_index >= 10, "beat_track 轨序 ≥10");
	assert.equal(summary.laidTrack, tr.track_index);
	assert.equal(summary.laidParticles, 1);
	const clip = tr.track_timeline[0];
	assert.equal(clip.clip_id, "proj-B06"); // clip_id = composition_id（去撞：一 beat 可派生主+aux 多颗粒）
	assert.equal(clip.material, "proj-B06"); // = composition_id
	assert.equal(clip.html_material, "mg-proj-B06"); // 写侧新前缀 mg-
	assert.equal(clip.opaque, true);
	assert.equal(clip.track_st, 63.9);
	assert.equal(clip.duration, 20);
	assert.ok(!("clip_st" in clip) && !("clip_ed" in clip), "颗粒无 clip_st/clip_ed");
	// materials 加一条 path
	assert.ok(next.materials.some((m) => m.id === "mg-proj-B06" && m.path === "assets/mg/proj-B06.html"));
	// struct_meta.mg 契约（写侧新键）
	assert.equal(mg.contract_version, "v1");
	assert.deepEqual(mg.lay_tracks, [tr.track_index]);
	assert.equal(mg.beats[0].laid.track_index, tr.track_index);
	assert.equal(mg.beats[0].composition_id, "proj-B06");
	assert.equal(next.struct_meta.mg.contract_version, "v1"); // struct_meta 写 mg 键
	assert.equal("rrv" in next.struct_meta, false); // 旧品牌键不残留
	assert.equal(next.struct_meta.split.contract_version, "v1"); // 中性契约键 split 原样保留
});

test("多颗粒共用一条 beat_track，按 track_st 排序", () => {
	const items = [item({ beat: "B11", composition_id: "proj-B11", track_st: 169, html_rel: "assets/mg/proj-B11.html" }), item()];
	const { next } = layMgTracks({ gtrk: baseGtrk(), items, generatedAt: "t" });
	assert.equal(next.beat_track.length, 1);
	const clips = next.beat_track[0].track_timeline;
	assert.equal(clips.length, 2);
	assert.deepEqual(clips.map((c) => c.clip_id), ["proj-B06", "proj-B11"]); // clip_id=composition_id；63.9 先于 169
});

test("幂等重铺：按 lay_tracks 剥旧 beat 轨 + 按 html_material 的 mg- 前缀剥素材；用户手加轨零连带", () => {
	const first = layMgTracks({ gtrk: baseGtrk(), items: [item()], generatedAt: "t1" });
	// 用户手加一条自己的 beat 轨 + 素材
	const edited = {
		...first.next,
		materials: [...first.next.materials, { id: "user-particle", path: "x.html" }],
		beat_track: [...first.next.beat_track, { track_index: 20, track_timeline: [{ clip_id: "u", material: "user-comp", html_material: "user-particle" }] }],
	};
	const second = layMgTracks({ gtrk: edited, items: [item({ composition_id: "proj-B99", html_rel: "assets/mg/proj-B99.html" })], generatedAt: "t2" });
	// 旧自产素材/轨被剥
	assert.ok(!second.next.materials.some((m) => m.id === "mg-proj-B06"));
	assert.ok(second.next.materials.some((m) => m.id === "mg-proj-B99"));
	// 用户手加素材/轨零连带保留
	assert.ok(second.next.materials.some((m) => m.id === "user-particle"));
	assert.ok(second.next.beat_track.some((t) => t.track_index === 20));
	// 新轨序避开现存最大（20）→ 21
	assert.deepEqual(second.mg.lay_tracks, [21]);
});

test("duration 非正数 → 不铺该颗粒，记 laid:null", () => {
	const { next, mg, summary } = layMgTracks({ gtrk: baseGtrk(), items: [item({ duration: 0 })], generatedAt: "t" });
	assert.equal(summary.laidParticles, 0);
	assert.deepEqual(next.beat_track, []); // 空轨不建
	assert.equal(mg.beats[0].laid, null);
});

test("items 为空 = 只剥旧自产物（清空 MG 轨）", () => {
	const first = layMgTracks({ gtrk: baseGtrk(), items: [item()], generatedAt: "t1" });
	const cleared = layMgTracks({ gtrk: first.next, items: [], generatedAt: "t2" });
	assert.deepEqual(cleared.next.beat_track, []);
	assert.ok(!cleared.next.materials.some((m) => String(m.id).startsWith("mg-")));
	assert.deepEqual(cleared.mg.lay_tracks, []);
});

// ── 去品牌化双名回归（读旧写新）──────────────────────────────────────────────

test("[读旧] 遗留 struct_meta.rrv 登记 + rrv- 前缀素材：重铺按并集剥净、迁移写 struct_meta.mg（删旧 rrv 键）", () => {
	// 造一个「上一版 gtrk rrv 铺过」的既有工程：struct_meta.rrv 登记 + rrv- 素材 + 旧 beat 轨
	const legacy = {
		...baseGtrk(),
		materials: [{ id: "F-main", path: "C:/x/main.mp4", duration: 60 }, { id: "rrv-proj-B06", path: "assets/rrv/proj-B06.html" }],
		beat_track: [{ track_index: 10, track_timeline: [{ clip_id: "B06", material: "proj-B06", html_material: "rrv-proj-B06", opaque: true, track_st: 63.9, duration: 20 }] }],
		struct_meta: { split: { contract_version: "v1" }, rrv: { contract_version: "v1", generated_at: "t0", lay_tracks: [10], beats: [] } },
	};
	const re = layMgTracks({ gtrk: legacy, items: [item({ composition_id: "proj-B07", html_rel: "assets/mg/proj-B07.html" })], generatedAt: "t1" });
	// 旧 rrv- 素材按遗留前缀并集剥净
	assert.ok(!re.next.materials.some((m) => m.id === "rrv-proj-B06"), "遗留 rrv- 素材应被剥离");
	// 新素材写 mg- 前缀
	assert.ok(re.next.materials.some((m) => m.id === "mg-proj-B07"));
	// 旧登记轨（10）被剥、只剩新铺的一条轨（≥10 惯例）；新轨承载新颗粒（旧 B06 clip 已随轨剥离）
	assert.equal(re.next.beat_track.length, 1);
	assert.ok(re.next.beat_track[0].track_index >= 10);
	assert.equal(re.next.beat_track[0].track_timeline[0].html_material, "mg-proj-B07");
	// 迁移：写 struct_meta.mg，删旧 rrv 键防孤儿
	assert.equal(re.next.struct_meta.mg.contract_version, "v1");
	assert.equal("rrv" in re.next.struct_meta, false);
});

// ── e2e（gtrk mg 命令）────────────────────────────────────────────────────

const goodHtml = (id) => `<template><div data-composition-id="${id}" data-width="1920" data-height="1080" style="background:#0A1420;"><svg viewBox="0 0 1920 1080"></svg></div><script src="https://lib.baomitu.com/gsap/3.13.0/gsap.min.js"></script><script>const tl=gsap.timeline({paused:true});tl.to({},{duration:20});window.__timelines=window.__timelines||{};window.__timelines["${id}"]=tl;</script></template>`;

function setupProject(dir, { withHtml = true, srcDir = "mg", dispatchKey = "mg" } = {}) {
	mkdirSync(join(dir, "split"), { recursive: true });
	mkdirSync(join(dir, "gtrk"), { recursive: true });
	mkdirSync(join(dir, srcDir), { recursive: true });
	writeFileSync(join(dir, "gtrk", "project.gtrk"), JSON.stringify(baseGtrk()));
	const slot = { beat: "B06", composition_id: "proj-B06", duration: 20, bg: "paper", track_st: 63.9, track_ed: 83.9 };
	writeFileSync(join(dir, "split", "dispatch.json"), JSON.stringify({
		[dispatchKey]: [slot],
		film_broll: [], ai_drama: [],
	}));
	if (withHtml) writeFileSync(join(dir, srcDir, "proj-B06.html"), goodHtml("proj-B06"));
}

test("e2e：gtrk mg 铺轨端到端（复制 HTML/beat_track/struct_meta.mg）；重跑幂等", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mg-e2e-"));
	try {
		setupProject(dir);
		const res = await runMg([], { project: dir, json: false });
		assert.equal(res.laid, 1);
		assert.ok(existsSync(join(dir, "gtrk", "assets", "mg", "proj-B06.html")), "HTML 复制进工程 assets/mg/");
		const g = JSON.parse(readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8"));
		assert.equal(g.beat_track.length, 1);
		assert.equal(g.beat_track[0].track_timeline[0].material, "proj-B06");
		assert.equal(g.beat_track[0].track_timeline[0].opaque, true); // 从 background:#0A1420 推导
		assert.equal(g.struct_meta.mg.beats[0].composition_id, "proj-B06");
		assert.equal(g.struct_meta.split.contract_version, "v1");
		// 重跑幂等：仍一条轨
		await runMg([], { project: dir, json: false });
		const g2 = JSON.parse(readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8"));
		assert.equal(g2.beat_track.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("[读旧] e2e：遗留 dispatch.rrv_mg + 源目录 rrv/ 仍正确路由铺轨", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mg-e2e-legacy-"));
	try {
		// 既有工程：dispatch 用旧键 rrv_mg、颗粒源在 rrv/ 目录
		setupProject(dir, { srcDir: "rrv", dispatchKey: "rrv_mg" });
		const res = await runMg([], { project: dir, json: false });
		assert.equal(res.laid, 1, "遗留 dispatch.rrv_mg + rrv/ 源目录应正常铺轨");
		const g = JSON.parse(readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8"));
		assert.equal(g.beat_track.length, 1);
		assert.equal(g.beat_track[0].track_timeline[0].html_material, "mg-proj-B06"); // 写侧仍新前缀
		assert.equal(g.struct_meta.mg.beats[0].composition_id, "proj-B06");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("e2e：缺颗粒 HTML 局部化跳过，退出正常不铺", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mg-e2e-"));
	try {
		setupProject(dir, { withHtml: false });
		const res = await runMg([], { project: dir, json: false });
		assert.equal(res.ok, true);
		assert.equal(res.laid, 0);
		assert.equal(res.skipped.length, 1);
		assert.match(res.skipped[0].reason, /缺颗粒 HTML/);
		const g = JSON.parse(readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8"));
		assert.deepEqual(g.beat_track, []); // 未铺
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("e2e：status 看板汇总", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mg-e2e-"));
	try {
		setupProject(dir);
		const res = await runMg(["status"], { project: dir, json: false });
		assert.equal(res.total, 1);
		assert.equal(res.authored, 1);
		assert.equal(res.laid, 0); // 还没铺
		await runMg([], { project: dir, json: false });
		const res2 = await runMg(["status"], { project: dir, json: false });
		assert.equal(res2.laid, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
