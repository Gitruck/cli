/**
 * RRV 颗粒 lint 单测（add-rrv-lay §3.1）：六铁律静态子集 + opaque 推导 + composition_id 对齐。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintParticle } from "../.test-build/rrv-lint.mjs";

/** 合规颗粒骨架（opaque 满屏底）。 */
const good = (id = "proj-B06", bg = "background:#0A1420;") => `
<template>
  <div data-composition-id="${id}" data-width="1920" data-height="1080" style="${bg}">
    <svg viewBox="0 0 1920 1080"><circle cx="960" cy="540" r="12" fill="#7FB8D6"></circle></svg>
  </div>
  <script src="https://lib.baomitu.com/gsap/3.13.0/gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.to({}, { duration: 20 });
    window.__timelines = window.__timelines || {};
    window.__timelines["${id}"] = tl;
  </script>
</template>`;

test("合规颗粒通过；opaque 从根 background 推导为 true", () => {
	const r = lintParticle(good());
	assert.equal(r.ok, true);
	assert.equal(r.opaque, true);
	assert.equal(r.compositionId, "proj-B06");
	assert.ok(!r.violations.some((v) => v.fatal));
});

test("透明底（无 background 或 transparent）→ opaque=false + 显式声明告警", () => {
	const noBg = lintParticle(good("proj-B07", ""));
	assert.equal(noBg.opaque, false);
	assert.ok(noBg.violations.some((v) => v.law === "4-bg-explicit" && !v.fatal)); // 非致命
	assert.equal(noBg.ok, true);
	const transp = lintParticle(good("proj-B07", "background:transparent;"));
	assert.equal(transp.opaque, false);
	assert.ok(!transp.violations.some((v) => v.law === "4-bg-explicit")); // 显式 transparent 不告警
});

test("缺 <template> 致命", () => {
	const r = lintParticle(good().replace(/<\/?template>/g, ""));
	assert.equal(r.ok, false);
	assert.ok(r.violations.some((v) => v.law === "1-template" && v.fatal));
});

test("data-width/height 非 1920/1080 致命", () => {
	const r = lintParticle(good().replace('data-width="1920"', 'data-width="1280"'));
	assert.equal(r.ok, false);
	assert.ok(r.violations.some((v) => v.law === "1-width" && v.fatal));
});

test("__timelines 注册 id 与 data-composition-id 不一致致命", () => {
	const r = lintParticle(good().replace('window.__timelines["proj-B06"]', 'window.__timelines["wrong-id"]'));
	assert.equal(r.ok, false);
	assert.ok(r.violations.some((v) => v.law === "2-id-match" && v.fatal));
});

test("timeline paused 空白宽容：{paused:true} 与 { paused: true } 均过", () => {
	const tight = lintParticle(good().replace("{ paused: true }", "{paused:true}"));
	assert.ok(!tight.violations.some((v) => v.law === "2-paused"));
});

test("注册两惯例：字面量 __timelines[\"id\"] 与 var ID 常量均过；var 值不匹配则致命", () => {
	// var ID 惯例（B06/B13 真机形态）
	const varForm = `
<template><div data-composition-id="proj-B06" data-width="1920" data-height="1080" style="background:#000;"></div>
<script src="https://lib.baomitu.com/gsap/3.13.0/gsap.min.js"></script>
<script>var ID="proj-B06";const tl=gsap.timeline({paused:true});window.__timelines=window.__timelines||{};window.__timelines[ID]=tl;</script></template>`;
	const r = lintParticle(varForm);
	assert.equal(r.ok, true);
	assert.ok(!r.violations.some((v) => v.law.startsWith("2-")));
	// var 值与 data-composition-id 不一致 → 致命
	const bad = lintParticle(varForm.replace('var ID="proj-B06"', 'var ID="wrong"'));
	assert.ok(bad.violations.some((v) => v.law === "2-id-match" && v.fatal));
});

test("Math.random / Date.now / 无参 new Date 致命", () => {
	assert.ok(lintParticle(good() + "<script>Math.random()</script>").violations.some((v) => v.law === "3-random" && v.fatal));
	assert.ok(lintParticle(good() + "<script>Date.now()</script>").violations.some((v) => v.law === "3-date-now" && v.fatal));
	assert.ok(lintParticle(good() + "<script>new Date()</script>").violations.some((v) => v.law === "3-new-date" && v.fatal));
	// 带参 new Date(ts) 不致命
	assert.ok(!lintParticle(good() + "<script>new Date(1700)</script>").violations.some((v) => v.law === "3-new-date"));
});

test("var(--) 致命；相对外链致命；jsdelivr 告警非致命", () => {
	assert.ok(lintParticle(good().replace("#7FB8D6", "var(--accent)")).violations.some((v) => v.law === "6-css-var" && v.fatal));
	assert.ok(lintParticle(good() + '<img src="./x.png">').violations.some((v) => v.law === "4-rel-asset" && v.fatal));
	const jd = lintParticle(good().replace("lib.baomitu.com", "cdn.jsdelivr.net/npm/gsap@3"));
	assert.ok(jd.violations.some((v) => v.law === "5-cdn-jsdelivr" && !v.fatal));
	assert.equal(jd.ok, true); // 告警不拦
});

test("script src 相对路径致命", () => {
	const r = lintParticle(good().replace("https://lib.baomitu.com/gsap/3.13.0/gsap.min.js", "./gsap.min.js"));
	assert.ok(r.violations.some((v) => v.law === "4-script-rel" && v.fatal));
});

test("composition_id 不在 dispatch → 告警非致命", () => {
	const r = lintParticle(good("proj-B06"), { dispatchIds: ["proj-B02", "proj-B05"] });
	assert.ok(r.violations.some((v) => v.law === "x-dispatch" && !v.fatal));
	assert.equal(r.ok, true);
	const ok = lintParticle(good("proj-B06"), { dispatchIds: ["proj-B06"] });
	assert.ok(!ok.violations.some((v) => v.law === "x-dispatch"));
});
