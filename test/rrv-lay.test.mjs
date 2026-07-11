/**
 * RRV 铺轨单测（add-rrv-lay §3.2）：html-particle 落 beat_track / 幂等剥离(html_material 键) /
 * opaque 透传 / 一对一 / duration>0 兜底 / struct_meta.rrv 契约 / e2e。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { layRrvTracks } from "../.test-build/rrv-lay.mjs";
import { runRrv } from "../.test-build/rrv-cmd.mjs";

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
	opaque: true, html_rel: "assets/rrv/proj-B06.html", ...over,
});

test("铺 html-particle 到 beat_track（不是 video_track）；materials/clip 结构正确", () => {
	const { next, summary, rrv } = layRrvTracks({ gtrk: baseGtrk(), items: [item()], generatedAt: "t" });
	// 落 beat_track，video_track 不动
	assert.equal(next.video_track.length, 1);
	assert.equal(next.beat_track.length, 1);
	const tr = next.beat_track[0];
	assert.ok(tr.track_index >= 10, "beat_track 轨序 ≥10");
	assert.equal(summary.laidTrack, tr.track_index);
	assert.equal(summary.laidParticles, 1);
	const clip = tr.track_timeline[0];
	assert.equal(clip.clip_id, "B06");
	assert.equal(clip.material, "proj-B06"); // = composition_id
	assert.equal(clip.html_material, "rrv-proj-B06");
	assert.equal(clip.opaque, true);
	assert.equal(clip.track_st, 63.9);
	assert.equal(clip.duration, 20);
	assert.ok(!("clip_st" in clip) && !("clip_ed" in clip), "颗粒无 clip_st/clip_ed");
	// materials 加一条 path
	assert.ok(next.materials.some((m) => m.id === "rrv-proj-B06" && m.path === "assets/rrv/proj-B06.html"));
	// struct_meta.rrv 契约
	assert.equal(rrv.contract_version, "v1");
	assert.deepEqual(rrv.lay_tracks, [tr.track_index]);
	assert.equal(rrv.beats[0].laid.track_index, tr.track_index);
	assert.equal(rrv.beats[0].composition_id, "proj-B06");
	assert.equal(next.struct_meta.split.contract_version, "v1"); // 其他键原样
});

test("多颗粒共用一条 beat_track，按 track_st 排序", () => {
	const items = [item({ beat: "B11", composition_id: "proj-B11", track_st: 169, html_rel: "assets/rrv/proj-B11.html" }), item()];
	const { next } = layRrvTracks({ gtrk: baseGtrk(), items, generatedAt: "t" });
	assert.equal(next.beat_track.length, 1);
	const clips = next.beat_track[0].track_timeline;
	assert.equal(clips.length, 2);
	assert.deepEqual(clips.map((c) => c.clip_id), ["B06", "B11"]); // 63.9 先于 169
});

test("幂等重铺：按 lay_tracks 剥旧 beat 轨 + 按 html_material 的 rrv- 前缀剥素材；用户手加轨零连带", () => {
	const first = layRrvTracks({ gtrk: baseGtrk(), items: [item()], generatedAt: "t1" });
	// 用户手加一条自己的 beat 轨 + 素材
	const edited = {
		...first.next,
		materials: [...first.next.materials, { id: "user-particle", path: "x.html" }],
		beat_track: [...first.next.beat_track, { track_index: 20, track_timeline: [{ clip_id: "u", material: "user-comp", html_material: "user-particle" }] }],
	};
	const second = layRrvTracks({ gtrk: edited, items: [item({ composition_id: "proj-B99", html_rel: "assets/rrv/proj-B99.html" })], generatedAt: "t2" });
	// 旧自产素材/轨被剥
	assert.ok(!second.next.materials.some((m) => m.id === "rrv-proj-B06"));
	assert.ok(second.next.materials.some((m) => m.id === "rrv-proj-B99"));
	// 用户手加素材/轨零连带保留
	assert.ok(second.next.materials.some((m) => m.id === "user-particle"));
	assert.ok(second.next.beat_track.some((t) => t.track_index === 20));
	// 新轨序避开现存最大（20）→ 21
	assert.deepEqual(second.rrv.lay_tracks, [21]);
});

test("duration 非正数 → 不铺该颗粒，记 laid:null", () => {
	const { next, rrv, summary } = layRrvTracks({ gtrk: baseGtrk(), items: [item({ duration: 0 })], generatedAt: "t" });
	assert.equal(summary.laidParticles, 0);
	assert.deepEqual(next.beat_track, []); // 空轨不建
	assert.equal(rrv.beats[0].laid, null);
});

test("items 为空 = 只剥旧自产物（清空 RRV 轨）", () => {
	const first = layRrvTracks({ gtrk: baseGtrk(), items: [item()], generatedAt: "t1" });
	const cleared = layRrvTracks({ gtrk: first.next, items: [], generatedAt: "t2" });
	assert.deepEqual(cleared.next.beat_track, []);
	assert.ok(!cleared.next.materials.some((m) => String(m.id).startsWith("rrv-")));
	assert.deepEqual(cleared.rrv.lay_tracks, []);
});

// ── e2e（gtrk rrv 命令）────────────────────────────────────────────────────

const goodHtml = (id) => `<template><div data-composition-id="${id}" data-width="1920" data-height="1080" style="background:#0A1420;"><svg viewBox="0 0 1920 1080"></svg></div><script src="https://lib.baomitu.com/gsap/3.13.0/gsap.min.js"></script><script>const tl=gsap.timeline({paused:true});tl.to({},{duration:20});window.__timelines=window.__timelines||{};window.__timelines["${id}"]=tl;</script></template>`;

function setupProject(dir, { withHtml = true } = {}) {
	mkdirSync(join(dir, "split"), { recursive: true });
	mkdirSync(join(dir, "gtrk"), { recursive: true });
	mkdirSync(join(dir, "rrv"), { recursive: true });
	writeFileSync(join(dir, "gtrk", "project.gtrk"), JSON.stringify(baseGtrk()));
	writeFileSync(join(dir, "split", "dispatch.json"), JSON.stringify({
		rrv_mg: [{ beat: "B06", composition_id: "proj-B06", duration: 20, bg: "paper", track_st: 63.9, track_ed: 83.9 }],
		film_broll: [], ai_drama: [],
	}));
	if (withHtml) writeFileSync(join(dir, "rrv", "proj-B06.html"), goodHtml("proj-B06"));
}

test("e2e：gtrk rrv 铺轨端到端（复制 HTML/beat_track/struct_meta.rrv）；重跑幂等", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rrv-e2e-"));
	try {
		setupProject(dir);
		const res = await runRrv([], { project: dir, json: false });
		assert.equal(res.laid, 1);
		assert.ok(existsSync(join(dir, "gtrk", "assets", "rrv", "proj-B06.html")), "HTML 复制进工程 assets/rrv/");
		const g = JSON.parse(readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8"));
		assert.equal(g.beat_track.length, 1);
		assert.equal(g.beat_track[0].track_timeline[0].material, "proj-B06");
		assert.equal(g.beat_track[0].track_timeline[0].opaque, true); // 从 background:#0A1420 推导
		assert.equal(g.struct_meta.rrv.beats[0].composition_id, "proj-B06");
		assert.equal(g.struct_meta.split.contract_version, "v1");
		// 重跑幂等：仍一条轨
		await runRrv([], { project: dir, json: false });
		const g2 = JSON.parse(readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8"));
		assert.equal(g2.beat_track.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("e2e：缺颗粒 HTML 局部化跳过，退出正常不铺", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rrv-e2e-"));
	try {
		setupProject(dir, { withHtml: false });
		const res = await runRrv([], { project: dir, json: false });
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
	const dir = mkdtempSync(join(tmpdir(), "rrv-e2e-"));
	try {
		setupProject(dir);
		const res = await runRrv(["status"], { project: dir, json: false });
		assert.equal(res.total, 1);
		assert.equal(res.authored, 1);
		assert.equal(res.laid, 0); // 还没铺
		await runRrv([], { project: dir, json: false });
		const res2 = await runRrv(["status"], { project: dir, json: false });
		assert.equal(res2.laid, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
