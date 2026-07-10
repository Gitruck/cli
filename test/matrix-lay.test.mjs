/**
 * matrix 候选铺轨单测（add-matrix-lay-tracks §4 + add-matrix-smart-fill §2 平铺语义）：
 * 平铺填充/阈值留空/轮转与去重/轨间差异化/幂等替换零连带/broll 元契约(laid.slots)/
 * writeGtrkAtomic 守卫/render 校验收窄/e2e（mock 云端+下载）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	fillBeatTrack,
	planBeatFills,
	mergedCandidates,
	previewUrlFor,
	previewDims,
	layBrollTracks,
	BROLL_META_CANDIDATE_CAP,
	SCORE_FLOOR_DEFAULT,
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
const fill1 = (beat, floor = SCORE_FLOOR_DEFAULT) => fillBeatTrack({ beat, consumed: new Set(), scoreFloor: floor });

// ── 平铺填充（spec「窗口计算」MODIFIED）──────────────────────────────────

test("平铺：长 beat 多颗粒铺满;query 叙事序轮转;紧邻不同 clip（spec Scenario）", () => {
	// 仿 B12：span 25.1s、per_shot 2、三 query 各 5 条候选
	const q = (name, base) => ({
		query: name,
		results: Array.from({ length: 5 }, (_, i) => mkResult(base + i, 0.9 - i * 0.05)),
	});
	const beat = {
		beat: "B12", track_st: 10, track_ed: 35.1, per_shot_sec: 2, requested_shots: 6,
		queries: [q("辅导作业", 100), q("情侣争吵", 200), q("职场敷衍", 300)],
	};
	const slots = fill1(beat);
	assert.equal(slots.length, 13); // 均分定长:round(25.1/2)=13 槽 × ~1.93s,无碎尾
	assert.equal(slots[0].track_st, 10);
	assert.equal(slots[12].track_ed, 35.1); // 精确铺满至 track_ed
	// 连续无缝
	for (let i = 1; i < slots.length; i++) assert.equal(slots[i].track_st, slots[i - 1].track_ed);
	// query 轮转：槽位 0/1/2 分属三条 query,3 回到第一条
	assert.equal(slots[0].query, "辅导作业");
	assert.equal(slots[1].query, "情侣争吵");
	assert.equal(slots[2].query, "职场敷衍");
	assert.equal(slots[3].query, "辅导作业");
	// 紧邻不同 clip
	for (let i = 1; i < slots.length; i++) assert.notEqual(slots[i].clip_id, slots[i - 1].clip_id);
	// (clip,seg) 对不复用：13 槽 13 个不同对
	assert.equal(new Set(slots.map((s) => `${s.clip_id}@${s.clip_st}`)).size, 13);
});

test("碎尾吸收：素材短截的 <1.2s 残量由最后颗粒顺延吃掉;有意留空不吸（spec Scenario）", () => {
	// 前两颗素材仅 1.6s 截短槽长,尾颗素材充裕:残 0.533s 由它顺延吸收,双时基同步
	const beat = mkBeat("B20", [
		mkResult(101, 0.9, { duration: 1.6, segments: [{ start: 0, end: 1.6, best: 0.8, score: 0.9 }] }),
		mkResult(102, 0.85, { duration: 1.6, segments: [{ start: 0, end: 1.6, best: 0.8, score: 0.85 }] }),
		mkResult(103, 0.8),
	], { track_ed: 15.6, per_shot_sec: 2 });
	const slots = fill1(beat);
	assert.equal(slots.length, 3);
	assert.equal(slots[2].track_ed, 15.6); // 吸收后精确到 track_ed
	assert.ok(Math.abs((slots[2].clip_ed - slots[2].clip_st) - (slots[2].track_ed - slots[2].track_st)) < 2e-3); // 双时基同步(r3 千分位粒度)
	// 有意留空(gap ≥1.2s)不被吸收:单候选干涸后余量如实露 A-roll
	const sparse = fill1(mkBeat("B21", [mkResult(101, 0.9)], { per_shot_sec: 3 }));
	assert.equal(sparse.length, 1);
	assert.ok(sparse[0].track_ed < 18 - 1.2); // 尾部大段留空保留
});

test("阈值：全低于地板→留空;低分段跳过;excluded_hint 不进自动填充（spec Scenario）", () => {
	const low = mkBeat("B01", [mkResult(101, 0.15, { segments: [{ start: 0, end: 8, best: 4, score: 0.15 }] })]);
	assert.deepEqual(fill1(low), []); // 全低于地板 → 留空露主轨
	const mixed = mkBeat("B02", [
		mkResult(101, 0.9),
		mkResult(102, 0.8, { segments: [{ start: 0, end: 8, best: 4, score: 0.1 }] }),
		mkResult(103, 0.7, { excluded_hint: true }),
	], { per_shot_sec: 4 });
	const slots = fill1(mixed);
	assert.deepEqual(slots.map((s) => s.clip_id), ["101"]); // 102 低分段/103 命中负词均不采纳
	// 地板可调：--score-floor 0.05 时低分段可入
	const loose = fill1(mixed, 0.05);
	assert.ok(loose.some((s) => s.clip_id === "102"));
	assert.ok(!loose.some((s) => s.clip_id === "103")); // excluded_hint 与地板无关,永不自动填充
});

test("镜头长：best 居中;有素材时长可向段外扩;素材不足不拉伸（spec Scenario）", () => {
	// 段仅 2s 但素材 30s,目标 4s → 外扩到 4s,best 居中
	const wide = fill1(mkBeat("B03", [mkResult(101, 0.9, { segments: [{ start: 8, end: 10, best: 9, score: 0.9 }] })], { track_ed: 14, per_shot_sec: 4 }));
	assert.equal(wide[0].clip_st, 7); // best=9 居中 [7,11]
	assert.equal(wide[0].clip_ed, 11);
	// 无素材时长 → 只信段界
	const seg = fill1(mkBeat("B04", [mkResult(101, 0.9, { duration: undefined, segments: [{ start: 8, end: 10, best: 9, score: 0.9 }] })], { track_ed: 14, per_shot_sec: 4 }));
	assert.equal(seg[0].clip_st, 8);
	assert.equal(seg[0].clip_ed, 10);
	// 素材总长 1.4s → 槽位 1.4s 不拉伸,游标继续
	const short = fill1(mkBeat("B05", [
		mkResult(101, 0.9, { duration: 1.4, segments: [{ start: 0, end: 1.4, best: 0.7, score: 0.9 }] }),
		mkResult(102, 0.8),
	], { per_shot_sec: 4 }));
	assert.ok(Math.abs(short[0].track_ed - short[0].track_st - 1.4) < 1e-9);
	assert.equal(short[1].clip_id, "102"); // 游标继续
});

test("平铺：单候选不重复塞满,余量留空;缺 per_shot 用 span/shots 推目标", () => {
	// 单候选单段：只铺一颗(消费后干涸),不同 clip 重复塞满
	const single = fill1(mkBeat("B06", [mkResult(101, 0.9)], { per_shot_sec: 3 }));
	assert.equal(single.length, 1);
	// span 8 / shots 4 → 目标 2s
	const byShots = fill1(mkBeat("B07", Array.from({ length: 6 }, (_, i) => mkResult(400 + i, 0.9 - i * 0.02)), { requested_shots: 4 }));
	assert.equal(byShots[0].track_ed - byShots[0].track_st, 2);
});

test("previewUrlFor：直连优先/推导兜底/无 cover 返回 null;previewDims 缩放偶数", () => {
	assert.equal(previewUrlFor({ ...mkResult(7, 1), preview_url: "http://p/7.mp4" }), "http://p/7.mp4");
	assert.equal(previewUrlFor(mkResult(7, 1)), "http://u/preview/7.mp4"); // 从 cover 推导
	assert.equal(previewUrlFor({ ...mkResult(7, 1), cover_url: "http://x/other.jpg" }), null);
	assert.deepEqual(previewDims(1920, 1080), [640, 360]);
	assert.deepEqual(previewDims(640, 480), [640, 480]);
	assert.equal(previewDims(undefined, 100), undefined);
});

// ── 铺轨与幂等 ────────────────────────────────────────────────────────────

function layOnce(gtrk, plan, lay = 1, ids = ["101"]) {
	const { fills } = planBeatFills(plan, lay, SCORE_FLOOR_DEFAULT);
	const downloads = new Map(ids.map((id) => [String(id), { rel: `assets/broll-preview/${id}.mp4`, source: "preview" }]));
	return layBrollTracks({ gtrk, plan, lay, fills, downloads, generatedAt: "2026-07-10T00:00:00Z", planPath: "split/broll-plan.json" });
}

test("铺轨：materials/overlay 轨/broll 元齐备;laid 带 slots 且旧字段在;无 url 进 materials.path", () => {
	const plan = mkPlan([mkBeat("B05", [mkResult(101, 0.9), mkResult(102, 0.8)], { per_shot_sec: 4 })]);
	const { next, broll, summary } = layOnce(baseGtrk(), plan, 1, ["101", "102"]);
	assert.equal(summary.laidClips, 2); // span 8 / 4s = 两槽平铺
	assert.deepEqual(broll.lay_tracks, [1]);
	const mat = next.materials.find((m) => m.id === "broll-101");
	assert.equal(mat.path, "assets/broll-preview/101.mp4");
	assert.deepEqual(mat.video_size, [640, 360]);
	assert.ok(!JSON.stringify(next.materials).includes("http"));
	const track = next.video_track.find((t) => t.track_index === 1);
	assert.deepEqual(track.track_size, [1920, 1080]);
	assert.equal(track.track_timeline.length, 2);
	assert.equal(track.track_timeline[0].material, "broll-101");
	assert.equal(track.track_timeline[0].track_st, 10);
	assert.equal(track.track_timeline[1].material, "broll-102");
	assert.equal(track.track_timeline[1].track_st, 14);
	assert.equal(broll.confirmed, false);
	const laid = broll.beats[0].laid[0];
	assert.equal(laid.order, 0); // 旧消费方兼容字段
	assert.equal(laid.clip_id, "101"); // = 首槽 clip
	assert.equal(laid.track_index, 1);
	assert.equal(laid.slots.length, 2); // 槽位明细
	assert.deepEqual(laid.slots.map((s) => s.clip_id), ["101", "102"]);
	assert.equal(laid.slots[0].query, "q1");
	assert.equal(laid.slots[0].score, 0.9);
	assert.equal(broll.beats[0].pinned, null);
	assert.equal(broll.beats[0].candidates[0].preview_path, "assets/broll-preview/101.mp4");
	assert.equal(next.struct_meta.split.contract_version, "v1"); // 其他键原样
});

test("candidates 截 12;下载失败丢槽位留空", () => {
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

test("lay=2：轨间不复用 (clip,seg) 对,方案差异化;候选耗尽的轨不建（spec Scenario）", () => {
	const plan = mkPlan([
		mkBeat("B05", [
			mkResult(101, 0.9, { segments: [{ start: 8, end: 16, best: 10, score: 0.9 }, { start: 20, end: 28, best: 24, score: 0.8 }] }),
			mkResult(102, 0.85, { segments: [{ start: 5, end: 9, best: 7, score: 0.85 }, { start: 12, end: 18, best: 15, score: 0.75 }] }),
		]),
		mkBeat("B09", [mkResult(201, 0.7)], { track_st: 30, track_ed: 34 }),
	]);
	const { next, broll } = layOnce(baseGtrk(), plan, 2, ["101", "102", "201"]);
	assert.deepEqual(broll.lay_tracks, [1, 2]);
	const t1 = next.video_track.find((t) => t.track_index === 1);
	const t2 = next.video_track.find((t) => t.track_index === 2);
	// 轨 1：B05 平铺(101/102 交替) + B09 单槽;轨 2：B05 用未消费对,B09 无余粮不铺
	assert.ok(t1.track_timeline.length >= 3);
	assert.ok(t2.track_timeline.length >= 1);
	const pairKey = (c) => `${c.material}@${c.clip_st}`;
	const used1 = new Set(t1.track_timeline.map(pairKey));
	for (const c of t2.track_timeline) assert.ok(!used1.has(pairKey(c))); // 跨轨不复用
	const b09laid = broll.beats[1].laid;
	assert.equal(b09laid.length, 1); // B09 只有轨 1 有槽 → 轨 2 无 laid 条目
	assert.equal(b09laid[0].order, 0);
});

// ── writer ────────────────────────────────────────────────────────────────

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

// ── render 校验收窄 ──────────────────────────────────────────────────────

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

// ── e2e（mock 云端 + mock 下载）─────────────────────────────────────────

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

test("e2e：默认 lay=1 端到端(下载代理/平铺/元);重跑幂等复用;--lay 0 不动工程", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-lay-e2e-"));
	const orig = globalThis.fetch;
	const origKey = process.env.GITRUCK_API_KEY;
	try {
		process.env.GITRUCK_API_KEY = "test_key";
		setupProject(dir);
		globalThis.fetch = mockCloudAndCdn(
			// 两条候选:span 8/per_shot 4 → 平铺两槽
			{ "城市 夜景": () => ({ recalled: 3, results: [mkResult(101, 0.9), mkResult(102, 0.8)] }) },
			(u) => (u.includes("/preview/101.mp4") || u.includes("/preview/102.mp4") ? Buffer.from("fake-mp4") : null),
		);
		const res = await runMatrix(undefined, { project: dir, column: "ghost-col", json: false });
		assert.equal(res.lay.laidClips, 2);
		assert.deepEqual(res.lay.downloads, { preview: 2, raw: 0, reused: 0, failed: 0 });
		assert.ok(existsSync(join(dir, "gtrk", "assets", "broll-preview", "101.mp4")));
		assert.ok(existsSync(join(dir, "gtrk", "assets", "broll-preview", "102.mp4")));
		const g = JSON.parse(readFileSync(join(dir, "gtrk", "project.gtrk"), "utf8"));
		assert.equal(g.video_track.length, 2);
		assert.equal(g.video_track[1].track_timeline.length, 2); // 平铺两颗粒
		assert.equal(g.struct_meta.broll.confirmed, false);
		assert.equal(g.struct_meta.broll.beats[0].laid[0].slots.length, 2);
		assert.equal(g.struct_meta.split.contract_version, "v1"); // split 原样
		// 重跑:代理复用、轨替换(仍 2 条)
		const res2 = await runMatrix(undefined, { project: dir, column: "ghost-col", json: false });
		assert.equal(res2.lay.downloads.reused, 2);
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
			const res3 = await runMatrix(undefined, { project: dir2, column: "ghost-col", json: false });
			assert.equal(res3.ok, true);
			assert.equal(res3.lay, undefined);
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
