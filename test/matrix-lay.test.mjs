/**
 * matrix 候选铺轨单测（change add-matrix-lay-tracks §4）：
 * 窗口计算/幂等替换零连带/broll 元契约/writeGtrkAtomic 守卫/render 校验收窄/e2e（mock 云端+下载）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	computeWindow,
	mergedCandidates,
	previewUrlFor,
	previewDims,
	layBrollTracks,
	BROLL_META_CANDIDATE_CAP,
} from "../.test-build/matrix-lay.mjs";
import { readGtrk, writeGtrkAtomic } from "../.test-build/gtrk-writeback.mjs";
import { materialPathsFromGtrk } from "../.test-build/render.mjs";
import { runMatrix } from "../.test-build/matrix-cmd.mjs";

const mkResult = (clip_id, score, extra = {}) => ({
	clip_id: String(clip_id),
	score,
	url: `http://u/raw/${clip_id}.mp4?expires=1&sign=x`,
	cover_url: `http://u/keyframe/${clip_id}/cover.jpg`,
	duration: 30,
	width: 1920,
	height: 1080,
	fps: 25,
	segments: [{ start: 8, end: 16, best: 10, score }],
	...extra,
});
const mkBeat = (beat, results, over = {}) => ({
	beat,
	track_st: 10,
	track_ed: 18,
	queries: [{ query: "q1", recalled: results.length, results }],
	...over,
});
const mkPlan = (beats) => ({ plan_version: "v1", generated_at: "t", member_type: "internal", url_ttl_note: "n", beats });
const baseGtrk = () => ({
	version: "v1",
	video_size: [1920, 1080],
	video_rate: 30,
	duration: 60,
	materials: [{ id: "F-main", path: "C:/x/main.mp4", duration: 60 }],
	video_track: [{ track_index: 0, track_size: [1920, 1080], muted: false, track_timeline: [{ clip_id: "c1", material: "F-main", clip_st: 0, clip_ed: 60, track_st: 0, track_ed: 60, duration: 60 }] }],
	audio_track: [],
	beat_track: [],
	struct_meta: { split: { contract_version: "v1" } },
});

// ── 4.1 窗口 ──────────────────────────────────────────────────────────────

test("窗口：best 居中截 per_shot_sec（spec Scenario）", () => {
	const w = computeWindow({ track_st: 0, track_ed: 8, per_shot_sec: 4 }, mkResult(1, 0.9));
	assert.deepEqual(w, { clip_st: 8, clip_ed: 12, track_st: 0, track_ed: 4 }); // best=10 居中 [8,12]
});

test("窗口：素材不足不拉伸;钳在素材末端;无 segments 从 0", () => {
	const short = computeWindow({ track_st: 0, track_ed: 6 }, mkResult(1, 0.9, { duration: 2.5 }));
	assert.equal(short.track_ed, 2.5);
	const tail = computeWindow({ track_st: 0, track_ed: 8, per_shot_sec: 4 }, mkResult(1, 0.9, { duration: 11, segments: [{ start: 8, end: 11, best: 10.5, score: 0.9 }] }));
	assert.equal(tail.clip_ed, 11); // 钳到末端 [7,11]
	assert.equal(tail.clip_st, 7);
	const noSeg = computeWindow({ track_st: 5, track_ed: 9 }, mkResult(1, 0.9, { segments: [] }));
	assert.equal(noSeg.clip_st, 0);
	assert.equal(noSeg.track_st, 5);
});

test("previewUrlFor：直连优先/推导兜底/无 cover 返回 null;previewDims 缩放偶数", () => {
	assert.equal(previewUrlFor({ ...mkResult(7, 1), preview_url: "http://p/7.mp4" }), "http://p/7.mp4");
	assert.equal(previewUrlFor(mkResult(7, 1)), "http://u/preview/7.mp4"); // 从 cover 推导
	assert.equal(previewUrlFor({ ...mkResult(7, 1), cover_url: "http://x/other.jpg" }), null);
	assert.deepEqual(previewDims(1920, 1080), [640, 360]);
	assert.deepEqual(previewDims(640, 480), [640, 480]);
	assert.equal(previewDims(undefined, 100), undefined);
});

// ── 4.2/4.3 铺轨与幂等 ────────────────────────────────────────────────────

function layOnce(gtrk, plan, lay = 1, ids = ["101"]) {
	const downloads = new Map(ids.map((id) => [String(id), { rel: `assets/broll-preview/${id}.mp4`, source: "preview" }]));
	return layBrollTracks({ gtrk, plan, lay, downloads, generatedAt: "2026-07-10T00:00:00Z", planPath: "split/broll-plan.json" });
}

test("铺轨：materials/overlay 轨/broll 元齐备;无 url 进 materials.path", () => {
	const plan = mkPlan([mkBeat("B05", [mkResult(101, 0.9), mkResult(102, 0.8)], { per_shot_sec: 4 })]);
	const { next, broll, summary } = layOnce(baseGtrk(), plan);
	assert.equal(summary.laidClips, 1);
	assert.deepEqual(broll.lay_tracks, [1]);
	const mat = next.materials.find((m) => m.id === "broll-101");
	assert.equal(mat.path, "assets/broll-preview/101.mp4");
	assert.deepEqual(mat.video_size, [640, 360]);
	assert.ok(!JSON.stringify(next.materials).includes("http"));
	const track = next.video_track.find((t) => t.track_index === 1);
	assert.deepEqual(track.track_size, [1920, 1080]);
	assert.equal(track.track_timeline[0].material, "broll-101");
	assert.equal(track.track_timeline[0].track_st, 10);
	assert.equal(broll.confirmed, false);
	assert.equal(broll.beats[0].pinned, null);
	assert.equal(broll.beats[0].laid[0].clip_id, "101");
	assert.equal(broll.beats[0].candidates[0].preview_path, "assets/broll-preview/101.mp4");
	assert.equal(broll.beats[0].candidates[1].preview_path, null); // 未下载候选
	assert.equal(next.struct_meta.split.contract_version, "v1"); // 其他键原样
});

test("candidates 截 12;下载失败丢槽位", () => {
	const many = Array.from({ length: 20 }, (_, i) => mkResult(200 + i, 1 - i * 0.01));
	const plan = mkPlan([mkBeat("B01", many)]);
	const { broll, summary } = layOnce(baseGtrk(), plan, 1, []); // 零下载
	assert.equal(broll.beats[0].candidates.length, BROLL_META_CANDIDATE_CAP);
	assert.equal(summary.laidClips, 0); // 全部丢槽
	assert.deepEqual(broll.lay_tracks, []); // 空轨不建
});

test("幂等重铺：替换自产物,用户轨/素材零连带;登记缺失宁留勿删", () => {
	const plan = mkPlan([mkBeat("B05", [mkResult(101, 0.9)])]);
	const first = layOnce(baseGtrk(), plan);
	// 用户手动加一条自己的 overlay 轨 + 素材
	const edited = {
		...first.next,
		materials: [...first.next.materials, { id: "user-x", path: "C:/me/x.mp4" }],
		video_track: [...first.next.video_track, { track_index: 5, track_size: [1920, 1080], track_timeline: [{ material: "user-x", clip_st: 0, clip_ed: 1, track_st: 0, track_ed: 1, duration: 1 }] }],
	};
	const plan2 = mkPlan([mkBeat("B05", [mkResult(303, 0.95)])]);
	const second = layOnce(edited, plan2, 1, ["303"]);
	assert.ok(!second.next.materials.some((m) => m.id === "broll-101")); // 旧自产素材删了
	assert.ok(second.next.materials.some((m) => m.id === "broll-303"));
	assert.ok(second.next.materials.some((m) => m.id === "user-x")); // 用户素材保留
	assert.ok(second.next.video_track.some((t) => t.track_index === 5)); // 用户轨保留
	assert.deepEqual(second.broll.lay_tracks, [6]); // 现存最大 5 → 新轨 6
	// 登记缺失宁留勿删:抹掉 struct_meta.broll 后重铺,旧 broll 轨被当用户轨保留
	const amnesia = { ...second.next, struct_meta: { ...second.next.struct_meta } };
	delete amnesia.struct_meta.broll;
	const third = layOnce(amnesia, plan2, 1, ["303"]);
	assert.ok(third.next.video_track.some((t) => t.track_index === 6)); // 旧轨保留
	assert.ok(third.next.video_track.some((t) => t.track_index === 7)); // 新轨追加
});

test("lay=2：轨 k=第 k 名候选;缺第 2 名的 beat 轨 2 无该 beat 颗粒", () => {
	const plan = mkPlan([
		mkBeat("B05", [mkResult(101, 0.9), mkResult(102, 0.8)]),
		mkBeat("B09", [mkResult(201, 0.7)], { track_st: 30, track_ed: 34 }),
	]);
	const { next, broll } = layOnce(baseGtrk(), plan, 2, ["101", "102", "201"]);
	assert.deepEqual(broll.lay_tracks, [1, 2]);
	const t1 = next.video_track.find((t) => t.track_index === 1);
	const t2 = next.video_track.find((t) => t.track_index === 2);
	assert.equal(t1.track_timeline.length, 2); // B05 第1名 + B09 第1名
	assert.equal(t2.track_timeline.length, 1); // 仅 B05 第2名
	assert.equal(t2.track_timeline[0].material, "broll-102");
});

// ── 4.4 writer ────────────────────────────────────────────────────────────

test("writeGtrkAtomic：mtime 冲突拒写;正常写回原子替换", () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-lay-"));
	try {
		const p = join(dir, "project.gtrk");
		writeFileSync(p, JSON.stringify(baseGtrk()));
		const { gtrk, mtimeMs } = readGtrk(p);
		// 外部修改(mtime 变)
		utimesSync(p, new Date(), new Date(Date.now() + 5000));
		assert.throws(() => writeGtrkAtomic(p, { ...gtrk, x: 1 }, mtimeMs), /保存冲突/);
		// 正常路径
		const again = readGtrk(p);
		writeGtrkAtomic(p, { ...again.gtrk, marker: true }, again.mtimeMs);
		assert.equal(JSON.parse(readFileSync(p, "utf8")).marker, true);
		assert.ok(!statSync(p).isDirectory());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── 4.5 render 校验收窄 ──────────────────────────────────────────────────

test("render 收窄：overlay-only 素材缺失不炸;主轨素材缺失仍炸(spec MODIFIED)", () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-render-"));
	try {
		const mainPath = join(dir, "main.mp4");
		writeFileSync(mainPath, "x");
		const g = {
			...baseGtrk(),
			materials: [
				{ id: "F-main", path: mainPath, duration: 60 },
				{ id: "broll-101", path: join(dir, "not-exist.mp4") }, // overlay-only,文件缺失
			],
			video_track: [
				baseGtrk().video_track[0],
				{ track_index: 1, track_size: [1920, 1080], track_timeline: [{ material: "broll-101", clip_st: 0, clip_ed: 1, track_st: 0, track_ed: 1, duration: 1 }] },
			],
		};
		const map = materialPathsFromGtrk(g);
		assert.deepEqual(Object.keys(map), ["F-main"]); // 只含被消费素材
		// 主轨素材缺失仍炸
		const bad = { ...g, materials: [{ id: "F-main", path: join(dir, "gone.mp4") }, g.materials[1]] };
		assert.throws(() => materialPathsFromGtrk(bad), /素材文件不存在/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── 4.6 e2e（mock 云端 + mock 下载）─────────────────────────────────────

const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function mockCloudAndCdn(resultsByQuery, cdn) {
	return async (url, init) => {
		const u = String(url);
		if (u.includes("/user/get_user_info")) return jsonRes({ code: 200, msg: "success", data: { matrix_member_type: "internal" } });
		if (u.includes("/task/")) {
			const body = JSON.parse(init.body);
			const make = resultsByQuery[body.query];
			if (!make) return jsonRes({ code: 6402, msg: "Unknown error" }, 500);
			return jsonRes({ code: 200, msg: "success", data: make(body) });
		}
		// CDN 下载:cdn(url) → bytes|null(404)
		const bytes = cdn(u);
		return bytes ? new Response(bytes, { status: 200 }) : new Response("nf", { status: 404 });
	};
}

function setupProject(dir) {
	mkdirSync(join(dir, "split"), { recursive: true });
	mkdirSync(join(dir, "gtrk"), { recursive: true });
	writeFileSync(join(dir, "gtrk", "project.gtrk"), JSON.stringify(baseGtrk()));
	writeFileSync(join(dir, "split", "dispatch.json"), JSON.stringify({
		rrv_mg: [], ai_drama: [],
		film_broll: [{ beat: "B05", queries: ["城市 夜景"], shots: 1, per_shot_sec: 4, track_st: 10, track_ed: 18 }],
	}));
}

test("e2e：默认 lay=1 端到端(下载代理/轨/元);重跑幂等复用;--lay 0 不动工程", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-lay-e2e-"));
	const orig = globalThis.fetch;
	const origKey = process.env.GITRUCK_API_KEY;
	try {
		process.env.GITRUCK_API_KEY = "test_key";
		setupProject(dir);
		let cdnHits = 0;
		globalThis.fetch = mockCloudAndCdn(
			{ "城市 夜景": () => ({ recalled: 3, results: [mkResult(101, 0.9)] }) },
			(u) => {
				cdnHits++;
				return u.includes("/preview/101.mp4") ? Buffer.from("fake-mp4") : null;
			},
		);
		const res = await runMatrix(undefined, { project: dir, column: "ghost-col", json: false });
		assert.equal(res.lay.laidClips, 1);
		assert.deepEqual(res.lay.downloads, { preview: 1, raw: 0, reused: 0, failed: 0 });
		assert.ok(existsSync(join(dir, "gtrk", "assets", "broll-preview", "101.mp4")));
		const g = JSON.parse(readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8"));
		assert.equal(g.video_track.length, 2);
		assert.equal(g.struct_meta.broll.confirmed, false);
		assert.equal(g.struct_meta.split.contract_version, "v1"); // split 原样
		// 重跑:代理复用、轨替换(仍 2 条)
		const res2 = await runMatrix(undefined, { project: dir, column: "ghost-col", json: false });
		assert.equal(res2.lay.downloads.reused, 1);
		const g2 = JSON.parse(readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8"));
		assert.equal(g2.video_track.length, 2);
		// --lay 0:plan 照产,工程不动
		const before = readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8");
		const res3 = await runMatrix(undefined, { project: dir, column: "ghost-col", lay: "0", json: false });
		assert.equal(res3.lay, undefined);
		assert.equal(readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8"), before);
	} finally {
		globalThis.fetch = orig;
		if (origKey === undefined) delete process.env.GITRUCK_API_KEY;
		else process.env.GITRUCK_API_KEY = origKey;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("e2e：preview 404 回落 raw(source=raw);工程缺失只出 plan 不失败", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-lay-e2e-"));
	const orig = globalThis.fetch;
	const origKey = process.env.GITRUCK_API_KEY;
	try {
		process.env.GITRUCK_API_KEY = "test_key";
		setupProject(dir);
		globalThis.fetch = mockCloudAndCdn(
			{ "城市 夜景": () => ({ recalled: 3, results: [mkResult(101, 0.9)] }) },
			(u) => (u.includes("/raw/101.mp4") ? Buffer.from("raw-mp4") : null), // preview 404
		);
		const res = await runMatrix(undefined, { project: dir, column: "ghost-col", json: false });
		assert.deepEqual(res.lay.downloads, { preview: 0, raw: 1, reused: 0, failed: 0 });
		const g = JSON.parse(readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8"));
		assert.equal(g.struct_meta.broll.beats[0].candidates[0].source, "raw");
		// backfill 后重跑:raw 回落态自动重试 preview 并换回(不被本地缓存复用挡住)
		globalThis.fetch = mockCloudAndCdn(
			{ "城市 夜景": () => ({ recalled: 3, results: [mkResult(101, 0.9)] }) },
			(u) => (u.includes("/preview/101.mp4") ? Buffer.from("proxy-now") : null),
		);
		const res2 = await runMatrix(undefined, { project: dir, column: "ghost-col", json: false });
		assert.equal(res2.lay.downloads.preview, 1); // 换回代理
		const g2 = JSON.parse(readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8"));
		assert.equal(g2.struct_meta.broll.beats[0].candidates[0].source, "preview");
		assert.equal(readFileSync(join(dir, "gtrk", "assets", "broll-preview", "101.mp4"), "utf8"), "proxy-now");
		// 工程缺失:plan 照产,退出正常
		const dir2 = mkdtempSync(join(tmpdir(), "gtrk-lay-e2e-"));
		try {
			mkdirSync(join(dir2, "split"), { recursive: true });
			writeFileSync(join(dir2, "split", "dispatch.json"), JSON.stringify({ rrv_mg: [], ai_drama: [], film_broll: [] }));
			const res2 = await runMatrix(undefined, { project: dir2, column: "ghost-col", json: false });
			assert.equal(res2.ok, true);
			assert.equal(res2.lay, undefined);
		} finally {
			rmSync(dir2, { recursive: true, force: true });
		}
	} finally {
		globalThis.fetch = orig;
		if (origKey === undefined) delete process.env.GITRUCK_API_KEY;
		else process.env.GITRUCK_API_KEY = origKey;
		rmSync(dir, { recursive: true, force: true });
	}
});
