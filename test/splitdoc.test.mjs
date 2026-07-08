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
