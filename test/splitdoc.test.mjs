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

test("MG 缺 duration_hint 被拒；有则通过", () => {
	const bad = validateSplitDoc(doc([beat({ lane: "MG", handoff: { theme: "x" } })]), CTX);
	assert.ok(hasErr(bad, /B01.*duration_hint/));
	const ok = validateSplitDoc(doc([beat({ lane: "MG", handoff: { duration_hint: 12 } })]), CTX);
	assert.deepEqual(ok.errors, []);
});

test("[读旧] 遗留 lane RRV_MG 归一为 MG：不判非法、缺 duration_hint 仍拒、有则通过", () => {
	// 遗留 lane 值不因去品牌化改名被判非法
	const ok = validateSplitDoc(doc([beat({ lane: "RRV_MG", handoff: { duration_hint: 12 } })]), CTX);
	assert.deepEqual(ok.errors, []);
	// 归一后仍走 MG 分型校验：缺 duration_hint 被拒
	const bad = validateSplitDoc(doc([beat({ lane: "RRV_MG", handoff: { theme: "x" } })]), CTX);
	assert.ok(hasErr(bad, /B01.*duration_hint/));
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

// ── MG category 子类型（add-rrv-category，裁决⑩）──────────────────────────

import { buildLanding } from "../.test-build/splitdoc.mjs";

test("MG category 非法值只告警不拒；合法新名值静默", () => {
	const bad = validateSplitDoc(doc([beat({ lane: "MG", handoff: { duration_hint: 12, category: "foobar" } })]), CTX);
	assert.deepEqual(bad.errors, []); // 不拒
	assert.ok(bad.warnings.some((w) => /category.*foobar|非已知品类/.test(w)));
	const ok = validateSplitDoc(doc([beat({ lane: "MG", handoff: { duration_hint: 12, category: "overlay" } })]), CTX);
	assert.ok(!ok.warnings.some((w) => /category/.test(w)));
});

test("[读旧] 遗留 category 键（rrv-overlay/mg-fullscreen/explain-subtitle/op-ed-title）不告警", () => {
	for (const cat of ["rrv-overlay", "mg-fullscreen", "explain-subtitle", "op-ed-title"]) {
		const r = validateSplitDoc(doc([beat({ lane: "MG", handoff: { duration_hint: 12, category: cat } })]), CTX);
		assert.ok(!r.warnings.some((w) => /category/.test(w)), `遗留品类 ${cat} 不应告警`);
	}
});

test("buildLanding 透传 category 进 dispatch.mg 与 struct_meta.split.beats；缺省不带", () => {
	const view = { utterances: [
		{ id: "u0001", track_st: 0, track_ed: 4 }, { id: "u0002", track_st: 4, track_ed: 8 },
		{ id: "u0003", track_st: 8, track_ed: 12 }, { id: "u0004", track_st: 12, track_ed: 16 },
	] };
	const beats = [
		beat({ id: "B01", span: { from: "u0001", to: "u0002" }, lane: "MG", handoff: { duration_hint: 8, category: "fullscreen" } }),
		beat({ id: "B02", span: { from: "u0003", to: "u0004" }, lane: "MG", handoff: { duration_hint: 8 } }), // 无 category
	];
	const landing = buildLanding(doc(beats), view, { utteranceIds: CTX.utteranceIds, projectSlug: "proj", projectedAt: "t" });
	const d1 = landing.dispatch.mg.find((r) => r.beat === "B01");
	assert.equal(d1.category, "fullscreen");
	assert.equal(d1.composition_id, "proj-B01");
	const d2 = landing.dispatch.mg.find((r) => r.beat === "B02");
	assert.ok(!("category" in d2)); // 缺省不带
	// struct_meta.split.beats 同步透传
	const s1 = landing.split.beats.find((b) => b.id === "B01");
	assert.equal(s1.category, "fullscreen");
	assert.equal(s1.lane, "MG");
	const s2 = landing.split.beats.find((b) => b.id === "B02");
	assert.ok(!("category" in s2));
});

test("[读旧] buildLanding：遗留 lane RRV_MG + 遗留 category 归一路由到 dispatch.mg、struct_meta.lane 写新名 MG、category 透传", () => {
	const view = { utterances: [
		{ id: "u0001", track_st: 0, track_ed: 4 }, { id: "u0002", track_st: 4, track_ed: 8 },
	] };
	const beats = [
		beat({ id: "B01", span: { from: "u0001", to: "u0002" }, lane: "RRV_MG", handoff: { duration_hint: 8, category: "mg-fullscreen" } }),
	];
	const landing = buildLanding(doc(beats), view, { utteranceIds: CTX.utteranceIds, projectSlug: "proj", projectedAt: "t" });
	// 遗留 lane 归一路由到新桶 dispatch.mg（不落遗留桶）
	assert.equal(landing.dispatch.mg.length, 1);
	assert.ok(!("rrv_mg" in landing.dispatch));
	const d1 = landing.dispatch.mg[0];
	assert.equal(d1.beat, "B01");
	assert.equal(d1.composition_id, "proj-B01");
	assert.equal(d1.category, "mg-fullscreen"); // category 原样透传（opaque passthrough）
	// struct_meta.split.beats：lane 写侧归一为中性名 MG；category 透传遗留值
	const s1 = landing.split.beats.find((b) => b.id === "B01");
	assert.equal(s1.lane, "MG");
	assert.equal(s1.category, "mg-fullscreen");
	// unhandledLanes 不误收（RRV_MG 已归一处理）
	assert.deepEqual(landing.unhandledLanes, []);
});

// ── overlay 叠层颗粒 aux（add-aux-rrv-overlay-particle）─────────────────────────

const AUX_VIEW = { utterances: [
	{ id: "u0001", track_st: 0, track_ed: 4 }, { id: "u0002", track_st: 4, track_ed: 8 },
	{ id: "u0003", track_st: 8, track_ed: 12 }, { id: "u0004", track_st: 12, track_ed: 16 },
	{ id: "u0005", track_st: 16, track_ed: 20, dropped: true }, { id: "u0006", track_st: 20, track_ed: 24, dropped: true },
] };
const auxLand = (beats) => buildLanding(doc(beats), AUX_VIEW, { utteranceIds: CTX.utteranceIds, projectSlug: "proj", projectedAt: "t" });

test("[overlay] validateAux：overlay aux 缺/非正 duration_hint 被拒；正数则通过", () => {
	const noH = beat({ aux_layers: [{ type: "overlay", mount: "same_beat", role: "概念叠层" }] });
	assert.ok(hasErr(validateSplitDoc(doc([noH]), CTX), /overlay.*duration_hint|颗粒时长/));
	const zero = beat({ aux_layers: [{ type: "overlay", mount: "same_beat", role: "概念叠层", handoff: { duration_hint: 0 } }] });
	assert.ok(hasErr(validateSplitDoc(doc([zero]), CTX), /duration_hint/));
	const ok = beat({ aux_layers: [{ type: "overlay", mount: "same_beat", role: "概念叠层", handoff: { duration_hint: 6 } }] });
	assert.deepEqual(validateSplitDoc(doc([ok]), CTX).errors, []);
});

test("[overlay] validateAux：category 非法只告警不拒；合法品类静默", () => {
	const bad = validateSplitDoc(doc([beat({ aux_layers: [{ type: "overlay", mount: "same_beat", role: "x", handoff: { duration_hint: 6, category: "foobar" } }] })]), CTX);
	assert.deepEqual(bad.errors, []);
	assert.ok(bad.warnings.some((w) => /category.*foobar|非已知品类/.test(w)));
	const good = validateSplitDoc(doc([beat({ aux_layers: [{ type: "overlay", mount: "same_beat", role: "x", handoff: { duration_hint: 6, category: "overlay" } }] })]), CTX);
	assert.ok(!good.warnings.some((w) => /category/.test(w)));
});

test("[overlay] MG 主 beat 自带 overlay aux → dispatch.mg 双条目（主+aux），-aux1 后缀且全局唯一", () => {
	const b = beat({ id: "B01", span: { from: "u0001", to: "u0002" }, lane: "MG", handoff: { duration_hint: 8 },
		aux_layers: [{ type: "overlay", mount: "same_beat", role: "概念叠层", handoff: { duration_hint: 6, theme: "abyss", bg: "paper", slug_hint: "fall" } }] });
	const land = auxLand([b]);
	assert.equal(land.dispatch.mg.length, 2);
	const main = land.dispatch.mg.find((r) => r.composition_id === "proj-B01");
	const aux = land.dispatch.mg.find((r) => r.composition_id === "proj-B01-aux1");
	assert.ok(main && aux, "主 + aux 两条 dispatch.mg");
	assert.equal(aux.beat, "B01"); // beat 字段仍为原 beat id（--only 选择器可同选主+aux）
	assert.equal(aux.category, "overlay");
	assert.equal(aux.duration, 6);
	assert.equal(aux.theme, "abyss");
	assert.equal(aux.bg, "paper");
	assert.equal(aux.slug_hint, "fall");
	assert.equal(aux.track_st, 0);
	assert.equal(aux.track_ed, 8);
	// composition_id 全局唯一
	const ids = land.dispatch.mg.map((r) => r.composition_id);
	assert.equal(new Set(ids).size, ids.length);
	// 合成 aux beat 进 struct_meta.split.beats（lane=MG, category=overlay）
	const s = land.split.beats.find((x) => x.id === "B01-aux1");
	assert.ok(s, "合成 aux beat 落 struct_meta");
	assert.equal(s.lane, "MG");
	assert.equal(s.category, "overlay");
	assert.equal(s.track_st, 0);
	assert.equal(s.track_ed, 8);
});

test("[overlay] FILM_BROLL 主 + overlay aux 同段派生两颗粒（主进 film_broll、aux 进 mg）", () => {
	const b = beat({ id: "B01", span: { from: "u0001", to: "u0002" }, lane: "FILM_BROLL", handoff: { queries: ["city night"] },
		aux_layers: [{ type: "overlay", mount: "same_beat", role: "概念叠层", handoff: { duration_hint: 6 } }] });
	const land = auxLand([b]);
	assert.equal(land.dispatch.film_broll.length, 1);
	assert.equal(land.dispatch.mg.length, 1);
	assert.equal(land.dispatch.mg[0].composition_id, "proj-B01-aux1");
	assert.equal(land.dispatch.mg[0].category, "overlay");
	// struct_meta：主 beat（FILM_BROLL）+ 合成 aux（MG）两条，同段 track
	const main = land.split.beats.find((x) => x.id === "B01");
	const aux = land.split.beats.find((x) => x.id === "B01-aux1");
	assert.equal(main.lane, "FILM_BROLL");
	assert.equal(aux.lane, "MG");
	assert.equal(aux.track_st, main.track_st);
	assert.equal(aux.track_ed, main.track_ed);
});

test("[overlay] mount {from,to} 投影子区间存活实例包络", () => {
	const b = beat({ id: "B01", span: { from: "u0001", to: "u0004" }, lane: "FILM_BROLL", handoff: { queries: ["x"] },
		aux_layers: [{ type: "overlay", mount: { from: "u0002", to: "u0003" }, role: "叠层", handoff: { duration_hint: 4 } }] });
	const land = auxLand([b]);
	const aux = land.dispatch.mg.find((r) => r.composition_id === "proj-B01-aux1");
	assert.ok(aux);
	assert.equal(aux.track_st, 4); // u0002.track_st
	assert.equal(aux.track_ed, 12); // u0003.track_ed
	const s = land.split.beats.find((x) => x.id === "B01-aux1");
	assert.deepEqual(s.span, { from: "u0002", to: "u0003" });
});

test("[overlay] mount {from,to} 源区间全被剪 → 计入 skipped，不产 dispatch/合成 beat", () => {
	const b = beat({ id: "B01", span: { from: "u0001", to: "u0002" }, lane: "FILM_BROLL", handoff: { queries: ["x"] },
		aux_layers: [{ type: "overlay", mount: { from: "u0005", to: "u0006" }, role: "叠层", handoff: { duration_hint: 4 } }] });
	const land = auxLand([b]);
	assert.equal(land.dispatch.mg.length, 0);
	assert.ok(!land.split.beats.some((x) => x.id === "B01-aux1"));
	assert.ok(land.skipped.some((s) => s.beat === "B01-aux1" && /全被剪|未落轨/.test(s.reason)));
});

test("[overlay] mount {trigger} 一期不支持 → skip + 告警，不产颗粒（校验仍通过）", () => {
	const b = beat({ id: "B01", span: { from: "u0001", to: "u0002" }, lane: "FILM_BROLL", handoff: { queries: ["x"] },
		aux_layers: [{ type: "overlay", mount: { trigger: "u0002" }, role: "叠层", handoff: { duration_hint: 4 } }] });
	// {trigger} 校验通过（trigger id 存在）——skip 是落地期决策，非校验期
	assert.deepEqual(validateSplitDoc(doc([b]), CTX).errors, []);
	const land = auxLand([b]);
	assert.equal(land.dispatch.mg.length, 0);
	assert.ok(!land.split.beats.some((x) => x.id === "B01-aux1"));
	assert.ok(land.skipped.some((s) => s.beat === "B01-aux1" && /trigger|点挂载|一期不支持/.test(s.reason)));
});

test("[overlay] 多条 overlay aux 位置计数 aux1/aux2，composition_id 全局唯一", () => {
	const b = beat({ id: "B01", span: { from: "u0001", to: "u0004" }, lane: "FILM_BROLL", handoff: { queries: ["x"] },
		aux_layers: [
			{ type: "overlay", mount: "same_beat", role: "叠层A", handoff: { duration_hint: 4 } },
			{ type: "term-callout", mount: "same_beat", role: "术语" }, // 非 overlay 不占号、不产颗粒
			{ type: "overlay", mount: { from: "u0002", to: "u0003" }, role: "叠层B", handoff: { duration_hint: 3 } },
		] });
	const land = auxLand([b]);
	const ids = land.dispatch.mg.map((r) => r.composition_id).sort();
	assert.deepEqual(ids, ["proj-B01-aux1", "proj-B01-aux2"]);
	assert.equal(new Set(ids).size, 2);
});
