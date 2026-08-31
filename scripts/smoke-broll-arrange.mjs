#!/usr/bin/env node
/**
 * 本地B-roll编排 · 生产冒烟台架（add-broll-arrange-atom §4.3 / add-broll-arrange-api §7.2）
 *
 * 为什么要有它：这条能力的失败面里，有**一整类只有真机能撞出来**——
 * 全仓单测都 mock 了 HTTP 层与 DB 层，于是服务端的**状态码映射**与**表是否存在**
 * 这两件事在单测里根本不经过。2026-08-30 上线当天，这个台架在头两分钟内各撞到一次：
 *
 *   ① 6210-6214 五个错误码没登记 HTTP 状态 → 静默默认 500 → 客户端把「你传错了」
 *      当成「服务端抖了」进指数退避，白等 7 秒后报「端点不可达」；
 *   ② `lookup()` 的 DB 查询裸着 → 幂等表若未建则整条能力返 500。
 *
 * 所以：**每次重新部署后重跑一遍**，别只信单测。
 *
 * 用法：
 *   node scripts/smoke-broll-arrange.mjs            # 全套（会真实计费，约 2 积分）
 *   node scripts/smoke-broll-arrange.mjs --probe    # 只跑零成本探针，不计费
 *
 * 前置：`npm test` 至少跑过一次（本脚本读 .test-build 的产物）；~/.gitruck/config.json 有可用 Key。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectArrangeRequest } from "../.test-build/arrange-wire.mjs";
import { requestArrange, resolveArrangeUrl } from "../.test-build/arrange-client.mjs";
import { applyArrangeResponse } from "../.test-build/arrange-apply.mjs";
import { planBeatFills } from "../.test-build/matrix-lay.mjs";
import { buildOpts, serialize } from "../test/fixtures/broll-arrange/harness.mjs";

const probeOnly = process.argv.includes("--probe");
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".gitruck", "config.json"), "utf8"));
const endpoint = { url: resolveArrangeUrl(cfg.apiBase || cfg.base), apiKey: cfg.apiKey };

// §7.2 指定的冒烟夹具：唯一的云端候选快照，规模小（1 编排量）、金样已锁
const FIXTURE = "./test/fixtures/broll-arrange/real/talkinghead-case13.json";
const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const { plan, lay, score_floor } = fx.input;
const opts = buildOpts(fx.input);
const req = projectArrangeRequest(plan, lay, score_floor, opts);

console.log(`端点 ${endpoint.url}`);
console.log(`夹具 ${path.basename(FIXTURE)}  估 ${req.estimated_units} 编排量  上行 ${(JSON.stringify(req).length / 1024).toFixed(1)}KB\n`);

// ── 探针：零成本。故意传不认识的口径版本，服务端应**前置拒绝**（6212，零执行零计费）──
// 它同时验三件事：路由在、鉴权通、错误码映射对（6212 必须是 4xx，不是 5xx）
console.log("【探针】不认识的 algo_pin → 应 400 + code 6212（零计费）");
try {
	await requestArrange(endpoint, { ...req, algo_pin: "arrange-metering@v0-probe" }, { retries: 0 });
	console.log("  ✗ 竟然成功了 —— 不认识的口径版本本该被拒");
} catch (e) {
	if (e.rejected === true && e.code === 6212) console.log("  ✓ 6212，且被正确识别为业务拒绝（未进退避）");
	else console.log(`  ✗ 期望 6212 业务拒绝，实得 code=${e.code} rejected=${e.rejected === true}\n    ${String(e.message).split("\n")[0].slice(0, 160)}`);
}
if (probeOnly) process.exit(0);

// ── 真机编排：会计费 ──
console.log("\n【1】真机编排（会计费）");
const resp = await requestArrange(endpoint, req, { retries: 0 });
console.log(`  ✓ units=${resp.units}  task_id=${resp.task_id}  幂等登记=${resp.idempotency_recorded}`);

console.log("\n【2】双端复算一致");
console.log(`  ${req.estimated_units === resp.units ? "✓" : "✗"} 本地 ${req.estimated_units} / 服务端 ${resp.units}`);

// ★ 真机跨语言对拍：服务端产物必须与本仓金样逐字节相同
console.log("\n【3】真机产物 vs 金样（跨语言等价性的最终判据）");
const remote = JSON.stringify(serialize(applyArrangeResponse(resp, lay)));
const golden = JSON.stringify(fx.expected);
const local = JSON.stringify(serialize(planBeatFills(plan, lay, score_floor, opts)));
console.log(`  ${remote === golden ? "✓" : "✗"} 服务端 vs 金样${remote === golden ? "：逐字节一致" : "：**不一致**"}`);
console.log(`  ${local === golden ? "✓" : "✗"} 本地重跑 vs 金样`);

console.log("\n【4】幂等重发（逐字节相同的请求体）");
const resp2 = await requestArrange(endpoint, req, { retries: 0 });
const same = resp2.task_id === resp.task_id;
console.log(`  ${same ? "✓" : "✗"} task_id ${same ? "与首次相同 —— 回放，未二次扣费" : "不同 —— 又跑了一遍、又扣了一次"}`);
console.log(`  ${resp2.idempotent_replay === true ? "✓" : "✗"} idempotent_replay=${resp2.idempotent_replay}`);
