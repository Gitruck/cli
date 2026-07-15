/**
 * column-config 单测（change add-column-config-schema §3）：
 * 逐维度算子折叠（UNION/INTERSECTION/OVERRIDE）+ 默认兜底 + L2 宽松解析（缺失/损坏回落）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DEFAULT_COLUMN_CONFIG,
	foldColumnConfigs,
	resolveColumnConfig,
	effectiveVocab,
} from "../.test-build/column-config.mjs";
import { NARRATIVES, CONTAINER_STAGES, BASE_TRACKS, LANES } from "../.test-build/splitdoc.mjs";

// ── 折叠算子 ──────────────────────────────────────────────────────────────

test("vocab UNION：栏目补词不丢默认（spec Scenario 词表并集）", () => {
	const eff = foldColumnConfigs([DEFAULT_COLUMN_CONFIG, { vocab: { narrative: ["custom-hook"] } }]);
	for (const n of NARRATIVES) assert.ok(eff.vocab.narrative.includes(n), `默认词 ${n} 不应丢`);
	assert.ok(eff.vocab.narrative.includes("custom-hook"));
	// 未配维度不动：container/base_track 仍 = 默认
	assert.deepEqual(eff.vocab.container_stage, [...CONTAINER_STAGES]);
	assert.deepEqual(eff.vocab.base_track, [...BASE_TRACKS]);
});

test("vocab UNION 去重：重复词不叠加", () => {
	const eff = foldColumnConfigs([DEFAULT_COLUMN_CONFIG, { vocab: { narrative: ["mirror-hook", "x"] } }]);
	assert.equal(eff.vocab.narrative.filter((n) => n === "mirror-hook").length, 1);
});

test("facet_allowed INTERSECTION：收窄（spec Scenario facet 可用集收窄）", () => {
	const eff = foldColumnConfigs([
		{ broll: { facet_allowed: ["shotType", "cameraMove", "angle"] } },
		{ broll: { facet_allowed: ["shotType", "nonexist"] } },
	]);
	assert.deepEqual(eff.broll.facet_allowed, ["shotType"]);
});

test("lanes.enabled UNION（P0 恒四枚举 + 预留）/ appearance OVERRIDE", () => {
	const eff = foldColumnConfigs([
		DEFAULT_COLUMN_CONFIG,
		{ lanes: { appearance: { MG: { color: "#123456" } } } },
	]);
	assert.deepEqual(eff.lanes.enabled, [...LANES]);
	assert.deepEqual(eff.lanes.appearance, { MG: { color: "#123456" } });
	// 再叠一层 appearance = 整块换装非合并
	const eff2 = foldColumnConfigs([eff, { lanes: { appearance: { A_ROLL: { label: "出镜" } } } }]);
	assert.deepEqual(eff2.lanes.appearance, { A_ROLL: { label: "出镜" } });
});

test("broll.column_tag_ids UNION（字符串防大整数精度）/ material_class_policy OVERRIDE", () => {
	const eff = foldColumnConfigs([
		{ broll: { column_tag_ids: ["83928792563953670"], material_class_policy: "concept" } },
		{ broll: { column_tag_ids: ["123"], material_class_policy: "real_shot" } },
	]);
	assert.deepEqual(eff.broll.column_tag_ids, ["83928792563953670", "123"]);
	assert.equal(eff.broll.material_class_policy, "real_shot");
});

test("style OVERRIDE 整块：后层整体替换，不逐条 merge", () => {
	const eff = foldColumnConfigs([{ style: { a: 1, b: 2 } }, { style: { c: 3 } }]);
	assert.deepEqual(eff.style, { c: 3 });
});

test("fallback.unknown_narrative OVERRIDE；非法值忽略", () => {
	const eff = foldColumnConfigs([DEFAULT_COLUMN_CONFIG, { fallback: { unknown_narrative: "allow" } }]);
	assert.equal(eff.fallback.unknown_narrative, "allow");
	const eff2 = foldColumnConfigs([DEFAULT_COLUMN_CONFIG, { fallback: { unknown_narrative: "whatever" } }]);
	assert.equal(eff2.fallback.unknown_narrative, "reject");
});

test("非法层/非法字段跳过不抛（宽松）", () => {
	const eff = foldColumnConfigs([
		DEFAULT_COLUMN_CONFIG,
		null,
		"junk",
		{ vocab: { narrative: "not-an-array" }, lanes: 42, broll: { facet_allowed: [1, 2] } },
	]);
	// narrative 非数组被忽略，默认词表原样
	assert.deepEqual(eff.vocab.narrative, [...NARRATIVES]);
});

// ── resolve（L0+L2）──────────────────────────────────────────────────────

test("最小栏目配置合法：只配 meta+vocab.narrative，未配维度走默认（spec Scenario 最小配置）", () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-col-"));
	try {
		writeFileSync(join(dir, "sci.json"), JSON.stringify({ meta: { id: "sci" }, vocab: { narrative: ["论点", "论据", "结论"] } }));
		const { config, warnings } = resolveColumnConfig({ columnId: "sci", columnsDir: dir });
		assert.deepEqual(warnings, []);
		const v = effectiveVocab(config);
		assert.ok(v.narrative.includes("论据"));
		assert.ok(v.narrative.includes("mirror-hook")); // UNION 不丢默认
		assert.deepEqual(v.container_stage, [...CONTAINER_STAGES]); // 未配维度=默认
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("零配置 = 只评 L0：与内置默认逐字段一致（默认兜底铁律）", () => {
	const { config, warnings } = resolveColumnConfig({});
	assert.deepEqual(warnings, []);
	const v = effectiveVocab(config);
	assert.deepEqual(v.narrative, [...NARRATIVES]);
	assert.deepEqual(v.container_stage, [...CONTAINER_STAGES]);
	assert.deepEqual(v.base_track, [...BASE_TRACKS]);
	assert.equal(v.unknown_narrative, "reject");
});

test("L2 缺失：告警 + 回落内置默认", () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-col-"));
	try {
		const { config, warnings } = resolveColumnConfig({ columnId: "ghost", columnsDir: dir });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /不存在.*回落/);
		assert.deepEqual(effectiveVocab(config).narrative, [...NARRATIVES]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("L2 损坏：告警 + 回落内置默认（不抛）", () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-col-"));
	try {
		writeFileSync(join(dir, "bad.json"), "{ not json !!!");
		const { config, warnings } = resolveColumnConfig({ columnId: "bad", columnsDir: dir });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /损坏.*回落/);
		assert.deepEqual(effectiveVocab(config).narrative, [...NARRATIVES]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("L2 为数组等非对象：告警 + 回落", () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-col-"));
	try {
		writeFileSync(join(dir, "arr.json"), "[1,2,3]");
		const { warnings } = resolveColumnConfig({ columnId: "arr", columnsDir: dir });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /格式异常.*回落/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── style 引用清单（change add-column-style-meta-skill §1/§3）─────────────

test("最小 style 清单合法：条目原样可读，produces 自造串静默（spec 登记场景）", () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-col-"));
	try {
		writeFileSync(join(dir, "c.json"), JSON.stringify({
			style: { skills: [{ id: "my-anim", ref: "D:/work/skills/my-anim", produces: "hand-drawn-stopmotion" }] },
		}));
		const { config, warnings } = resolveColumnConfig({ columnId: "c", columnsDir: dir });
		assert.deepEqual(warnings, []);
		assert.equal(config.style.skills.length, 1);
		assert.equal(config.style.skills[0].produces, "hand-drawn-stopmotion");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("无 style 块零感知：L0 解析结果不含任何内置 skill 登记（spec L0 无清单）", () => {
	const { config, warnings } = resolveColumnConfig({});
	assert.deepEqual(warnings, []);
	assert.equal(config.style, undefined);
});

test("非法条目跳过不阻断：缺 ref / 非对象条目提示但不抛", () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-col-"));
	try {
		writeFileSync(join(dir, "c.json"), JSON.stringify({
			style: { skills: [{ id: "ok", ref: "x" }, { id: "no-ref" }, 42], shared: "junk" },
		}));
		const { config, warnings } = resolveColumnConfig({ columnId: "c", columnsDir: dir });
		assert.equal(config.style.skills.length, 1);
		assert.ok(warnings.some((w) => /skills\[1\] 缺 id\/ref/.test(w)));
		assert.ok(warnings.some((w) => /skills\[2\] 非对象/.test(w)));
		assert.ok(warnings.some((w) => /shared 非数组/.test(w)));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("produces 命中注册集可按类型检索；string[] 多产物", async () => {
	const { skillsProducing } = await import("../.test-build/column-config.mjs");
	const style = { skills: [
		{ id: "a", ref: "x", produces: "MG" },
		{ id: "b", ref: "y", produces: ["AI_DRAMA", "MG"] },
		{ id: "c", ref: "z", produces: "cover" },
	] };
	assert.deepEqual(skillsProducing(style, "MG").map((e) => e.id), ["a", "b"]);
	assert.deepEqual(skillsProducing(style, "AI_DRAMA").map((e) => e.id), ["b"]);
	assert.deepEqual(skillsProducing(style, "FILM_BROLL"), []);
});

test("[读旧] skillsProducing 双名认旧：produces 遗留 RRV_MG 可被查询 MG 命中；查询遗留名亦归一", async () => {
	const { skillsProducing } = await import("../.test-build/column-config.mjs");
	const style = { skills: [
		{ id: "legacy", ref: "x", produces: "RRV_MG" }, // 既有栏目配置的旧品牌值
		{ id: "neo", ref: "y", produces: "MG" },
	] };
	// 查询中性名 MG 应同时命中遗留声明与新声明（归一比对）
	assert.deepEqual(skillsProducing(style, "MG").map((e) => e.id), ["legacy", "neo"]);
	// 查询遗留名 RRV_MG 也归一为 MG，命中两者
	assert.deepEqual(skillsProducing(style, "RRV_MG").map((e) => e.id), ["legacy", "neo"]);
});

test("produces 疑似拼写才提示：编辑距离≤2 提示；管线外值静默；routing:none 豁免", async () => {
	const { producesNotices } = await import("../.test-build/column-config.mjs");
	// 距离 1：MC → 近拼中性名 MG → 提示（column-style-manifest：RRV_MC 近拼示例跟随 MG）
	assert.equal(producesNotices({ skills: [{ id: "a", ref: "x", produces: "MC" }] }).length, 1);
	// 大小写：mg → 提示
	assert.equal(producesNotices({ skills: [{ id: "a", ref: "x", produces: "mg" }] }).length, 1);
	// 管线外：cover → 静默
	assert.equal(producesNotices({ skills: [{ id: "a", ref: "x", produces: "cover" }] }).length, 0);
	// routing:"none" 豁免（哪怕近似）
	assert.equal(producesNotices({ skills: [{ id: "a", ref: "x", produces: "MC", routing: "none" }] }).length, 0);
	// 命中注册集（中性名）：零提示
	assert.equal(producesNotices({ skills: [{ id: "a", ref: "x", produces: "MG" }] }).length, 0);
	// [读旧] 遗留品牌名 RRV_MG 归一后命中注册集：认旧、零提示（不误报为拼写）
	assert.equal(producesNotices({ skills: [{ id: "a", ref: "x", produces: "RRV_MG" }] }).length, 0);
});

test("style OVERRIDE 折叠（resolve 全链路）：L2 定义 style 整块生效", () => {
	const dir = mkdtempSync(join(tmpdir(), "gtrk-col-"));
	try {
		writeFileSync(join(dir, "c.json"), JSON.stringify({
			style: { skills: [{ id: "mine", ref: "r" }], bundle_ref: "oss://x" },
		}));
		const { config } = resolveColumnConfig({ columnId: "c", columnsDir: dir });
		assert.equal(config.style.skills[0].id, "mine");
		assert.equal(config.style.bundle_ref, "oss://x");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
