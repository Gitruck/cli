/**
 * splitdoc.validateSplitDoc 校验矩阵单测（change add-splitter-integration §2.3）：
 * 幻觉 id / 区间倒序 / 重叠 / hash 错版 / FILM_BROLL 缺 queries / A_ROLL 带 handoff 警告 + 合法通过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSplitDoc } from "../.test-build/splitdoc.mjs";

const CTX = { utteranceIds: ["u0001", "u0002", "u0003", "u0004", "u0005", "u0006"], transcriptHash: "HASH_OK" };

/** 造一个合法 beat（可覆盖字段）。 */
function beat(over = {}) {
	return {
		id: "B01",
		span: { from: "u0001", to: "u0002" },
		base_track: "真人出镜",
		lane: "A_ROLL",
		narrative: "mirror-hook",
		container_stage: "none",
		rhythm: "平稳",
		visual_task: "主持人出镜",
		irreplaceability: "必须真人出镜",
		...over,
	};
}
function doc(beats, over = {}) {
	return { contract_version: "v1", transcript_hash: "HASH_OK", beats, ...over };
}
const hasErr = (r, re) => r.errors.some((e) => re.test(e));

test("合法拆分稿通过（无 error）", () => {
	const r = validateSplitDoc(doc([beat()]), CTX);
	assert.deepEqual(r.errors, []);
});

test("幻觉 id 被硬拒（附 beat id）", () => {
	const r = validateSplitDoc(doc([beat({ span: { from: "u0001", to: "u9999" } })]), CTX);
	assert.ok(r.errors.length >= 1);
	assert.ok(hasErr(r, /B01.*u9999/));
});

test("区间倒序被硬拒", () => {
	const r = validateSplitDoc(doc([beat({ span: { from: "u0003", to: "u0001" } })]), CTX);
	assert.ok(hasErr(r, /B01.*倒序/));
});

test("beats 区间重叠被硬拒（指明 beat 对）", () => {
	const b1 = beat({ id: "B01", span: { from: "u0001", to: "u0003" } });
	const b2 = beat({ id: "B02", span: { from: "u0002", to: "u0004" } });
	const r = validateSplitDoc(doc([b1, b2]), CTX);
	assert.ok(hasErr(r, /B01.*B02.*重叠/));
});

test("相邻不重叠（留空隙）合法", () => {
	const b1 = beat({ id: "B01", span: { from: "u0001", to: "u0002" } });
	const b2 = beat({ id: "B02", span: { from: "u0004", to: "u0005" } }); // 跳过 u0003 空隙
	const r = validateSplitDoc(doc([b1, b2]), CTX);
	assert.deepEqual(r.errors, []);
});

test("hash 错版硬拒（不放行）", () => {
	const r = validateSplitDoc(doc([beat()], { transcript_hash: "HASH_STALE" }), CTX);
	assert.ok(hasErr(r, /transcript_hash 不匹配/));
});

test("FILM_BROLL 缺 queries 被拒", () => {
	const noQ = beat({ lane: "FILM_BROLL", handoff: {} });
	const emptyQ = beat({ id: "B02", span: { from: "u0003", to: "u0004" }, lane: "FILM_BROLL", handoff: { queries: [] } });
	const r = validateSplitDoc(doc([noQ, emptyQ]), CTX);
	assert.ok(hasErr(r, /B01.*query/));
	assert.ok(hasErr(r, /B02.*query/));
});

test("FILM_BROLL 带非空 queries 通过", () => {
	const r = validateSplitDoc(doc([beat({ lane: "FILM_BROLL", handoff: { queries: ["城市 夜景"] } })]), CTX);
	assert.deepEqual(r.errors, []);
});

test("RRV_MG 缺 duration_hint 被拒；有则通过", () => {
	const bad = validateSplitDoc(doc([beat({ lane: "RRV_MG", handoff: { theme: "x" } })]), CTX);
	assert.ok(hasErr(bad, /B01.*duration_hint/));
	const ok = validateSplitDoc(doc([beat({ lane: "RRV_MG", handoff: { duration_hint: 12 } })]), CTX);
	assert.deepEqual(ok.errors, []);
});

test("A_ROLL 带 handoff 只警告不报错", () => {
	const r = validateSplitDoc(doc([beat({ handoff: { duration_hint: 5 } })]), CTX);
	assert.deepEqual(r.errors, []);
	assert.ok(r.warnings.some((w) => /A_ROLL.*handoff/.test(w)));
});

test("枚举越界 / 缺必填 逐条报错", () => {
	const r = validateSplitDoc(
		doc([beat({ lane: "X_ROLL", narrative: "nope", container_stage: "bad", base_track: "隐身", irreplaceability: "随便", rhythm: "", visual_task: "" })]),
		CTX,
	);
	assert.ok(hasErr(r, /lane 非法/));
	assert.ok(hasErr(r, /narrative 非法/));
	assert.ok(hasErr(r, /container_stage 非法/));
	assert.ok(hasErr(r, /base_track 非法/));
	assert.ok(hasErr(r, /irreplaceability 非法/));
	assert.ok(hasErr(r, /缺 rhythm/));
	assert.ok(hasErr(r, /缺 visual_task/));
});

test("id 格式 / contract_version 校验", () => {
	const r = validateSplitDoc(doc([beat({ id: "beat1" })], { contract_version: "v2" }), CTX);
	assert.ok(hasErr(r, /contract_version 必须为 "v1"/));
	assert.ok(hasErr(r, /id 须为/));
});

test("辅助层 mount 三型：same_beat / 区间 / trigger，幻觉 id 报错", () => {
	const good = beat({
		aux_layers: [
			{ type: "quote-card", mount: "same_beat", role: "金句" },
			{ type: "term-callout", mount: { from: "u0001", to: "u0002" }, role: "术语" },
			{ type: "pause-card", mount: { trigger: "u0002" }, role: "停顿" },
		],
	});
	assert.deepEqual(validateSplitDoc(doc([good]), CTX).errors, []);
	const bad = beat({ aux_layers: [{ type: "quote-card", mount: { trigger: "u9999" }, role: "金句" }] });
	assert.ok(hasErr(validateSplitDoc(doc([bad]), CTX), /aux.*u9999/));
});

test("非数组 / 空 beats 报错", () => {
	assert.ok(validateSplitDoc(doc([]), CTX).errors.some((e) => /beats 必须是非空数组/.test(e)));
});

// ── 栏目 vocab 校验放宽（change add-column-config-schema §2）──────────────

test("自定义栏目 vocab：命中词表通过，不因非八枚举被拒（spec Scenario 科普栏目）", () => {
	const vocab = {
		narrative: ["论点", "论据", "结论"],
		container_stage: ["none", "开场", "收尾"],
		base_track: ["真人出镜", "旁白主导"],
	};
	const b = beat({ narrative: "论据", container_stage: "开场" });
	const r = validateSplitDoc(doc([b]), { ...CTX, vocab });
	assert.deepEqual(r.errors, []);
});

test("自定义 vocab 下，不在词表的值被拒（unknown=reject 缺省）", () => {
	const vocab = { narrative: ["论点"], container_stage: ["none"], base_track: ["真人出镜"] };
	const r = validateSplitDoc(doc([beat({ narrative: "mirror-hook" })]), { ...CTX, vocab });
	assert.ok(hasErr(r, /narrative 非法/));
});

test("unknown_narrative=allow：三项放行自由串（异构栏目），空串仍拒", () => {
	const vocab = { narrative: [], container_stage: [], base_track: [], unknown_narrative: "allow" };
	const free = beat({ narrative: "痛点直击", container_stage: "促单", base_track: "口播带货" });
	assert.deepEqual(validateSplitDoc(doc([free]), { ...CTX, vocab }).errors, []);
	const empty = beat({ narrative: "", container_stage: "促单", base_track: "口播带货" });
	assert.ok(hasErr(validateSplitDoc(doc([empty]), { ...CTX, vocab }), /缺 narrative/));
});

test("allow 不放宽 lane：lane 仍硬四枚举（P0 不动）", () => {
	const vocab = { narrative: [], container_stage: [], base_track: [], unknown_narrative: "allow" };
	const r = validateSplitDoc(doc([beat({ narrative: "x", container_stage: "y", base_track: "z", lane: "HAND_DRAWN" })]), { ...CTX, vocab });
	assert.ok(hasErr(r, /lane 非法/));
});

test("不传 vocab = 内置默认：行为与词表化前一致（默认兜底铁律）", () => {
	// 与文件头部既有用例同口径：合法稿通过、越界被拒——这里显式对照两条
	assert.deepEqual(validateSplitDoc(doc([beat()]), CTX).errors, []);
	assert.ok(hasErr(validateSplitDoc(doc([beat({ narrative: "nope" })]), CTX), /narrative 非法/));
});

// ── RRV_MG category 子类型（add-rrv-category，裁决⑩）──────────────────────

import { buildLanding } from "../.test-build/splitdoc.mjs";

test("RRV_MG category 非法值只告警不拒；合法值静默", () => {
	const bad = validateSplitDoc(doc([beat({ lane: "RRV_MG", handoff: { duration_hint: 12, category: "foobar" } })]), CTX);
	assert.deepEqual(bad.errors, []); // 不拒
	assert.ok(bad.warnings.some((w) => /category.*foobar|非已知品类/.test(w)));
	const ok = validateSplitDoc(doc([beat({ lane: "RRV_MG", handoff: { duration_hint: 12, category: "rrv-overlay" } })]), CTX);
	assert.ok(!ok.warnings.some((w) => /category/.test(w)));
});

test("buildLanding 透传 category 进 dispatch.rrv_mg 与 struct_meta.split.beats；缺省不带", () => {
	const view = { utterances: [
		{ id: "u0001", track_st: 0, track_ed: 4 }, { id: "u0002", track_st: 4, track_ed: 8 },
		{ id: "u0003", track_st: 8, track_ed: 12 }, { id: "u0004", track_st: 12, track_ed: 16 },
	] };
	const beats = [
		beat({ id: "B01", span: { from: "u0001", to: "u0002" }, lane: "RRV_MG", handoff: { duration_hint: 8, category: "mg-fullscreen" } }),
		beat({ id: "B02", span: { from: "u0003", to: "u0004" }, lane: "RRV_MG", handoff: { duration_hint: 8 } }), // 无 category
	];
	const landing = buildLanding(doc(beats), view, { utteranceIds: CTX.utteranceIds, projectSlug: "proj", projectedAt: "t" });
	const d1 = landing.dispatch.rrv_mg.find((r) => r.beat === "B01");
	assert.equal(d1.category, "mg-fullscreen");
	assert.equal(d1.composition_id, "proj-B01");
	const d2 = landing.dispatch.rrv_mg.find((r) => r.beat === "B02");
	assert.ok(!("category" in d2)); // 缺省不带
	// struct_meta.split.beats 同步透传
	const s1 = landing.split.beats.find((b) => b.id === "B01");
	assert.equal(s1.category, "mg-fullscreen");
	const s2 = landing.split.beats.find((b) => b.id === "B02");
	assert.ok(!("category" in s2));
});
