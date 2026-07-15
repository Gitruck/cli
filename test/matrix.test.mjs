/**
 * gtrk matrix 单测（change add-matrix-broll-search §3）：
 * 路由（非 internal 一律 external）/请求构建（派单翻译+栏目注入+大整数字符串）/
 * plan 构建（去重/标记/recalled/透传）/错误分支（body.code 优先）/端到端 dry-run（mock 双口）+ 幂等。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	decideRoute,
	shotsToTopK,
	trimFacets,
	buildSearchBody,
	buildPlanBeat,
	buildPlan,
	dedupeBeatQueries,
	markExcluded,
	classifyApiError,
	probeMemberType,
	searchOnce,
	URL_TTL_NOTE,
} from "../.test-build/matrix.mjs";
import { runMatrix, parseAdhocQuery } from "../.test-build/matrix-cmd.mjs";

const CFG = { base: "http://mock", apiKey: "test_key" };
const jsonRes = (obj, status = 200) =>
	new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// ── 3.1 路由 ──────────────────────────────────────────────────────────────

test("路由：internal 走 custom 口;external/缺失/未知档位一律通用口", () => {
	assert.equal(decideRoute("internal").endpoint, "/task/custom/search");
	assert.equal(decideRoute("external").endpoint, "/task/video_clip_search");
	assert.equal(decideRoute(undefined).endpoint, "/task/video_clip_search");
	assert.equal(decideRoute("partner").endpoint, "/task/video_clip_search"); // 未知新档位不误打 custom 口
	assert.equal(decideRoute(42).endpoint, "/task/video_clip_search");
});

test("探针：code!=200 抛错（探针失败=整体失败）;成功按字段路由", async () => {
	const orig = globalThis.fetch;
	try {
		globalThis.fetch = async () => jsonRes({ code: 200, msg: "success", data: { matrix_member_type: "internal" } });
		assert.equal(await probeMemberType(CFG), "internal");
		globalThis.fetch = async () => jsonRes({ code: 200, msg: "success", data: {} }); // 旧服务端字段缺失
		assert.equal(await probeMemberType(CFG), "external");
		globalThis.fetch = async () => jsonRes({ code: 6502, msg: "鉴权失败" }, 401);
		await assert.rejects(() => probeMemberType(CFG), /鉴权失败/);
	} finally {
		globalThis.fetch = orig;
	}
});

// ── 3.2 请求构建 ──────────────────────────────────────────────────────────

test("shots 翻译与钳位：4→12;30→50;非法/缺省→10;--top-k 覆盖", () => {
	assert.equal(shotsToTopK(4), 12);
	assert.equal(shotsToTopK(30), 50);
	assert.equal(shotsToTopK(1), 10); // 3 < 下限 10
	assert.equal(shotsToTopK(undefined), 10);
	assert.equal(shotsToTopK("6"), 10); // 非数值不生效
	assert.equal(shotsToTopK(-2), 10);
	assert.equal(shotsToTopK(4, 25), 25); // 显式覆盖
	assert.equal(shotsToTopK(4, 99), 50); // 覆盖也钳服务端上限
});

test("internal 注入：column_tag_ids 字符串原样(>2^53 逐字节)/material_class 白名单/facets 交集/min_duration", () => {
	const broll = {
		column_tag_ids: ["83928792563953670", "123"],
		material_class_policy: "concept",
		facet_defaults: { shot_type: ["wide"], weather: ["clear"] },
		facet_allowed: ["shot_type"],
	};
	const body = buildSearchBody("internal", "城市 夜景", { shots: 4, per_shot_sec: 3 }, broll, {});
	assert.deepEqual(body.column_tag_ids, ["83928792563953670", "123"]);
	assert.equal(typeof body.column_tag_ids[0], "string"); // 精度无损
	assert.equal(body.material_class, "concept");
	assert.deepEqual(body.facets, { shot_type: ["wide"] }); // weather 被 facet_allowed 剪除
	assert.equal(body.filters.min_duration, 3);
	assert.equal(body.top_k, 12);
	// 序列化后仍是字符串（JSON 层不丢精度）
	assert.ok(JSON.stringify(body).includes('"83928792563953670"'));
});

test("material_class_policy 白名单：mixed/未知值不传（混搜）;--material-class 覆盖", () => {
	assert.equal(buildSearchBody("internal", "q", undefined, { material_class_policy: "mixed" }, {}).material_class, undefined);
	assert.equal(buildSearchBody("internal", "q", undefined, { material_class_policy: "whatever" }, {}).material_class, undefined);
	assert.equal(buildSearchBody("internal", "q", undefined, { material_class_policy: "concept" }, { materialClass: "real_shot" }).material_class, "real_shot");
});

test("external 零注入：三项全不进请求体", () => {
	const broll = { column_tag_ids: ["1"], material_class_policy: "concept", facet_defaults: { shot_type: ["wide"] } };
	// 命令层对 external 传 undefined broll,这里再验 buildSearchBody 的 tier 闸门
	const body = buildSearchBody("external", "q", { shots: 4 }, broll, {});
	assert.equal(body.column_tag_ids, undefined);
	assert.equal(body.material_class, undefined);
	assert.equal(body.facets, undefined);
});

test("trimFacets：allowed 未定义时全保留;空交集返回 undefined", () => {
	assert.deepEqual(trimFacets({ a: [1] }, undefined), { a: [1] });
	assert.equal(trimFacets({ a: [1] }, ["b"]), undefined);
	assert.equal(trimFacets(undefined, ["a"]), undefined);
});

// ── 3.3 plan 构建 ─────────────────────────────────────────────────────────

const mkResult = (clip_id, score, extra = {}) => ({
	clip_id: String(clip_id),
	score,
	url: `http://u/${clip_id}?expires=1&sign=x`,
	cover_url: `http://c/${clip_id}.jpg`,
	segments: [{ start: 1, end: 5, best: 2.5, score }],
	...extra,
});

test("beat 内去重：保最高分出现+also_matched_queries;跨 beat 不去重", () => {
	const entry = { beat: "B05", queries: ["夜景", "都市"], track_st: 1, track_ed: 9 };
	const beatA = buildPlanBeat(entry, [
		{ query: "夜景", data: { recalled: 5, results: [mkResult(123, 0.9), mkResult(200, 0.8)] } },
		{ query: "都市", data: { recalled: 3, results: [mkResult(123, 0.7)] } },
	]);
	const qA = beatA.queries[0];
	const qB = beatA.queries[1];
	assert.deepEqual(qA.results.map((r) => r.clip_id), ["123", "200"]);
	assert.deepEqual(qB.results, []); // 123 被去重进 A
	assert.deepEqual(qA.results[0].also_matched_queries, ["都市"]);
	// 跨 beat：同 clip 在另一 beat 独立保留
	const beatB = buildPlanBeat({ beat: "B09", queries: ["夜景"], track_st: 20, track_ed: 25 }, [
		{ query: "夜景", data: { recalled: 1, results: [mkResult(123, 0.6)] } },
	]);
	assert.equal(beatB.queries[0].results[0].clip_id, "123");
});

test("excluded_hint：note 命中标记不删除;note 为 null/无命中不标", () => {
	const results = [
		mkResult(1, 0.9, { note: "卡通风格城市动画" }),
		mkResult(2, 0.8, { note: null }),
		mkResult(3, 0.7, { note: "实拍夜景" }),
	];
	markExcluded(results, ["卡通", "水印"]);
	assert.equal(results[0].excluded_hint, true);
	assert.equal(results[1].excluded_hint, undefined);
	assert.equal(results[2].excluded_hint, undefined);
	assert.equal(results.length, 3); // 一条没删
});

test("recalled 平级透传;派单原值透传;error 局部化", () => {
	const entry = { beat: "B01", queries: ["a", "b"], shots: 4, per_shot_sec: 3.5, exclude: ["水印"], track_st: 0, track_ed: 5 };
	const beat = buildPlanBeat(entry, [
		{ query: "a", data: { recalled: 37, results: [mkResult(1, 0.5)] } },
		{ query: "b", error: { code: 6402, msg: "上游超时" } },
	]);
	assert.equal(beat.requested_shots, 4);
	assert.equal(beat.per_shot_sec, 3.5);
	assert.deepEqual(beat.exclude, ["水印"]);
	assert.equal(beat.queries[0].recalled, 37); // results 的兄弟字段
	assert.ok(Array.isArray(beat.queries[0].results));
	assert.equal(beat.queries[1].error.code, 6402);
	assert.equal(beat.queries[1].results, undefined);
});

test("plan 顶层：url_ttl_note 必含;无鉴权信息;column_id 可选", () => {
	const plan = buildPlan({ generatedAt: "2026-07-10T00:00:00Z", memberType: "internal", columnId: "col-x", beats: [] });
	assert.equal(plan.plan_version, "v1");
	assert.equal(plan.url_ttl_note, URL_TTL_NOTE);
	assert.equal(plan.column_id, "col-x");
	assert.ok(!JSON.stringify(plan).includes("test_key"));
	const noCol = buildPlan({ generatedAt: "t", memberType: "external", beats: [] });
	assert.ok(!("column_id" in noCol));
});

// ── 3.4 错误分支 ──────────────────────────────────────────────────────────

test("错误分类：403 身份提示;6401 双语义;6402 重试;400 网关层", () => {
	assert.match(classifyApiError(403), /矩阵成员|身份/);
	assert.match(classifyApiError(6401), /上游故障/);
	assert.match(classifyApiError(6401), /栏目配置|检索参数/); // 双语义:不能只说稍后重试
	assert.match(classifyApiError(6402), /超时/);
	assert.match(classifyApiError(400, "请求参数或请求体格式错误"), /请求/);
	assert.match(classifyApiError(6502), /API Key|鉴权/);
});

test("searchOnce 按 body.code 分支：HTTP 500+code=403 → 身份提示（真实伪装组合）", async () => {
	const orig = globalThis.fetch;
	try {
		globalThis.fetch = async () => jsonRes({ code: 403, msg: "Unknown error" }, 500);
		await assert.rejects(() => searchOnce(CFG, "internal", { query: "q", top_k: 10 }), /矩阵成员|身份/);
		// HTTP 400+code=400（真实组合）
		globalThis.fetch = async () => jsonRes({ code: 400, msg: "请求参数或请求体格式错误" }, 400);
		await assert.rejects(() => searchOnce(CFG, "external", { query: "q", top_k: 10 }), /请求/);
		// 防御性用例（非真实组合,验证 body.code 优先于 HTTP 状态）:HTTP 200 + 异常 code
		globalThis.fetch = async () => jsonRes({ code: 6401, msg: "Unknown error" }, 200);
		await assert.rejects(() => searchOnce(CFG, "internal", { query: "q", top_k: 10 }), /上游故障/);
	} finally {
		globalThis.fetch = orig;
	}
});

// ── 3.5 端到端 dry-run（mock 双口 + 幂等）─────────────────────────────────

test("parseAdhocQuery：空=plan 模式;search 引导词;未知子命令报错", () => {
	assert.equal(parseAdhocQuery(undefined), undefined);
	assert.equal(parseAdhocQuery([]), undefined);
	assert.equal(parseAdhocQuery(["search", "城市", "夜景"]), "城市 夜景");
	assert.throws(() => parseAdhocQuery(["searhc", "x"]), /未知子命令/);
	assert.throws(() => parseAdhocQuery(["search"]), /不能为空/);
});

/** BigInt 感知的响应构造：把 BigInt 序列化为**裸数字字面量**（模拟真实服务端的雪花大整数 JSON）。 */
const bigJsonRes = (obj, status = 200) => {
	const txt = JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? `__BIG__${v}__` : v))
		.replace(/"__BIG__(\d+)__"/g, "$1");
	return new Response(txt, { status, headers: { "content-type": "application/json" } });
};

function mockCloud(memberType, resultsByQuery) {
	return async (url, init) => {
		if (String(url).includes("/user/get_user_info")) {
			return jsonRes({ code: 200, msg: "success", data: memberType ? { matrix_member_type: memberType } : {} });
		}
		const body = JSON.parse(init.body);
		const make = resultsByQuery[body.query];
		if (!make) return jsonRes({ code: 6402, msg: "Unknown error" }, 500);
		return bigJsonRes({ code: 200, msg: "success", data: make(body) });
	};
}

test("端到端 dry-run：2 beat 3 query → plan 金样断言;重跑幂等;单 query 失败局部化", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-matrix-"));
	const orig = globalThis.fetch;
	const origKey = process.env.GITRUCK_API_KEY;
	try {
		process.env.GITRUCK_API_KEY = "test_key";
		mkdirSync(join(dir, "split"), { recursive: true });
		const dispatch = {
			mg: [],
			ai_drama: [],
			film_broll: [
				{ beat: "B05", queries: ["城市 夜景", "都市 車流"], shots: 2, per_shot_sec: 3, exclude: ["卡通"], track_st: 10, track_ed: 18 },
				{ beat: "B09", queries: ["暴雨 街头"], track_st: 30, track_ed: 34 },
			],
		};
		writeFileSync(join(dir, "split", "dispatch.json"), JSON.stringify(dispatch));

		// mock 服务端返回 number 型 clip_id(含 >2^53 大整数)——searchOnce 文本层引号化后应无损成字符串
		const raw = (clip_id, score, extra = {}) => ({ ...mkResult("0", score, extra), clip_id });
		const resultsByQuery = {
			"城市 夜景": () => ({ recalled: 5, results: [raw(84795153478832141n, 0.9, { note: "实拍夜景" }), raw(7, 0.8, { note: "卡通城市" })] }),
			"都市 車流": () => ({ recalled: 2, results: [raw(84795153478832141n, 0.6)] }),
			// "暴雨 街头" 不在表里 → 6402 局部失败
		};
		globalThis.fetch = mockCloud("internal", resultsByQuery);

		const res = await runMatrix(undefined, { project: dir, column: "ghost-col", json: false });
		assert.equal(res.ok, true);
		assert.equal(res.mode, "plan");
		assert.equal(res.memberType, "internal");
		assert.deepEqual(res.counts, { beats: 2, queries: 3, results: 3, errors: 1 });

		const plan = JSON.parse(readFileSync(join(dir, "split", "broll-plan.json"), "utf8"));
		assert.equal(plan.plan_version, "v1");
		assert.equal(plan.member_type, "internal");
		assert.equal(plan.column_id, "ghost-col");
		assert.equal(plan.url_ttl_note, URL_TTL_NOTE);
		assert.ok(!JSON.stringify(plan).includes("test_key"));
		const b05 = plan.beats[0];
		assert.equal(b05.requested_shots, 2);
		assert.equal(b05.per_shot_sec, 3);
		assert.equal(b05.queries[0].recalled, 5);
		assert.equal(b05.queries[0].results.find((r) => r.clip_id === "7").excluded_hint, true); // 卡通命中标记
		const big = b05.queries[0].results.find((r) => r.clip_id === "84795153478832141"); // 大整数无损成字符串
		assert.ok(big, "大整数 clip_id 应精度无损");
		assert.equal(big.also_matched_queries[0], "都市 車流"); // 去重
		assert.deepEqual(b05.queries[1].results, []);
		const b09 = plan.beats[1];
		assert.equal(b09.queries[0].error.code, 6402); // 局部失败
		// 幂等:同输入重跑,除 generated_at 外结构等价(mock url 无随机签名)
		await runMatrix(undefined, { project: dir, column: "ghost-col", json: false });
		const plan2 = JSON.parse(readFileSync(join(dir, "split", "broll-plan.json"), "utf8"));
		const strip = (p) => JSON.stringify({ ...p, generated_at: null });
		assert.equal(strip(plan2), strip(plan));
	} finally {
		globalThis.fetch = orig;
		if (origKey === undefined) delete process.env.GITRUCK_API_KEY;
		else process.env.GITRUCK_API_KEY = origKey;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("端到端：film_broll 空 → 空 plan 退出正常;全部 query 失败 → 抛错不写盘", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-matrix-"));
	const orig = globalThis.fetch;
	const origKey = process.env.GITRUCK_API_KEY;
	try {
		process.env.GITRUCK_API_KEY = "test_key";
		mkdirSync(join(dir, "split"), { recursive: true });
		// 空队列
		writeFileSync(join(dir, "split", "dispatch.json"), JSON.stringify({ mg: [], ai_drama: [], film_broll: [] }));
		globalThis.fetch = mockCloud("external", {});
		const res = await runMatrix(undefined, { project: dir, column: "ghost-col", json: false });
		assert.equal(res.counts.beats, 0);
		const plan = JSON.parse(readFileSync(join(dir, "split", "broll-plan.json"), "utf8"));
		assert.deepEqual(plan.beats, []);
		assert.equal(plan.member_type, "external");
		// 全部失败
		writeFileSync(join(dir, "split", "dispatch.json"), JSON.stringify({
			mg: [], ai_drama: [],
			film_broll: [{ beat: "B01", queries: ["不存在"], track_st: 0, track_ed: 1 }],
		}));
		rmSync(join(dir, "split", "broll-plan.json"));
		await assert.rejects(() => runMatrix(undefined, { project: dir, column: "ghost-col", json: false }), /全部.*失败/);
		assert.ok(!readSafe(join(dir, "split", "broll-plan.json")));
	} finally {
		globalThis.fetch = orig;
		if (origKey === undefined) delete process.env.GITRUCK_API_KEY;
		else process.env.GITRUCK_API_KEY = origKey;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("external 显式 --material-class concept 报错;real_shot 警告继续", async () => {
	const orig = globalThis.fetch;
	const origKey = process.env.GITRUCK_API_KEY;
	try {
		process.env.GITRUCK_API_KEY = "test_key";
		globalThis.fetch = mockCloud(undefined, { q: () => ({ recalled: 0, results: [] }) });
		await assert.rejects(
			() => runMatrix("q", { materialClass: "concept", column: "ghost-col", json: false }),
			/external.*concept 不可用/,
		);
		const res = await runMatrix("q", { materialClass: "real_shot", column: "ghost-col", json: false });
		assert.equal(res.ok, true); // 警告不阻断
	} finally {
		globalThis.fetch = orig;
		if (origKey === undefined) delete process.env.GITRUCK_API_KEY;
		else process.env.GITRUCK_API_KEY = origKey;
	}
});

function readSafe(p) {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return null;
	}
}
