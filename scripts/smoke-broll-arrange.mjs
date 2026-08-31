#!/usr/bin/env node
/**
 * 本地B-roll编排 · 生产冒烟台架（add-broll-arrange-atom §4.3 / add-broll-arrange-api §7.2）
 *
 * 为什么要有它：这条能力的失败面里，有**一整类只有真机能撞出来**——
 * 全仓单测都 mock 了 HTTP 层与 DB 层，于是服务端的**状态码映射**、**表是否存在**、
 * **真实 ORM 的方法面**、**JSON 键序**这四件事在单测里根本不经过。
 * 2026-08-30~31 上线期间，这个台架逐一撞出：
 *
 *   ① 6210-6214 五个错误码没登记 HTTP 状态 → 静默默认 500 → 客户端把「你传错了」
 *      当成「服务端抖了」进指数退避，白等 7 秒后报「端点不可达」；
 *   ② `lookup()` 的 DB 查询裸着 → 幂等表若未建则整条能力返 500；
 *   ③ `.limit(1)` —— simpysql 没有这个方法（假件多长了一只手，error #58）；
 *   ④ `__create_time__` 声明了却没配 `fresh_timestamp` 覆写 → 幂等登记百分之百失败
 *      （假件放宽了列约束，error #60 → #63）。
 *
 * 所以：**每次重新部署后重跑一遍**，别只信单测。
 *
 * 用法：
 *   node scripts/smoke-broll-arrange.mjs                      # 默认夹具（口播，1 编排量）
 *   node scripts/smoke-broll-arrange.mjs --probe              # 只跑零成本探针，不计费
 *   node scripts/smoke-broll-arrange.mjs food-teppanyaki …    # 指定一或多份 real/ 夹具（可省 .json）
 *   node scripts/smoke-broll-arrange.mjs --cost <名…>         # 只报价不下单
 *   node scripts/smoke-broll-arrange.mjs --all                # real/ 全量（先看 --cost --all）
 *
 * ⚠️ **每份夹具都真实扣费**，且规模差得很远（1 ~ 39 编排量，全量约 70）。
 * 所以先 `--cost` 看账再决定打哪几份——批量跑前尤其别省这一步。
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

//: 真实项目快照（题材维度）与合成用例（分支维度）。合成用例规模小，
//: 用来**廉价地**补真实语料覆盖不到的形态——例如多轨（lay=2）：
//: 真实语料里唯一的 lay=2 那份要 39 编排量，而合成的 04/15 只要 1~2。
const DIRS = ["./test/fixtures/broll-arrange/real/", "./test/fixtures/broll-arrange/cases/"];
const REAL_DIR = DIRS[0];
//: §7.2 指定的默认夹具：规模最小（1 编排量）、金样已锁，适合「每次部署后跑一遍」
const DEFAULT_FIXTURE = "talkinghead-case13";

const argv = process.argv.slice(2);
const probeOnly = argv.includes("--probe");
const costOnly = argv.includes("--cost");
const wantAll = argv.includes("--all");
const named = argv.filter((a) => !a.startsWith("--"));
const names = wantAll
	? fs.readdirSync(REAL_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
	: named.length ? named.map((n) => n.replace(/\.json$/, "")) : [DEFAULT_FIXTURE];

/** 读夹具并投影出请求体。**投影一次、复用同一份**——幂等依赖字节相同的请求体。 */
function load(name) {
	const file = DIRS.map((d) => path.join(d, `${name}.json`)).find((f) => fs.existsSync(f));
	if (!file) {
		const all = DIRS.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")));
		console.error(`✗ 找不到夹具 ${name}\n  可选：${all.join("  ")}`);
		process.exit(2);
	}
	const fx = JSON.parse(fs.readFileSync(file, "utf8"));
	const { plan, lay, score_floor } = fx.input;
	const opts = buildOpts(fx.input);
	return { name, fx, plan, lay, score_floor, opts, req: projectArrangeRequest(plan, lay, score_floor, opts) };
}

const jobs = names.map(load);

// ── 报价：任何真实下单前先把账摆出来。--cost 到此为止 ──
const total = jobs.reduce((s, j) => s + j.req.estimated_units, 0);
for (const j of jobs) {
	console.log(`${String(j.req.estimated_units).padStart(3)} 编排量  ${(JSON.stringify(j.req).length / 1024).toFixed(1).padStart(6)}KB  ${j.name}`);
}
console.log(`—— 合计 ${total} 编排量（余额腿按 price 计价；实际扣费以服务端复算为准）`);
if (costOnly) process.exit(0);

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".gitruck", "config.json"), "utf8"));
const endpoint = { url: resolveArrangeUrl(cfg.apiBase || cfg.base), apiKey: cfg.apiKey };
console.log(`\n端点 ${endpoint.url}`);

// ★ 规范化比对：服务端按字母序输出 JSON 键、本地是插入序，值一样但字节不同。
// 用裸 stringify 比会把「完全一致」判成「全不一致」——上线首日就是这么误报的一次。
const canon = (v) => JSON.stringify(v, (_k, x) =>
	x && typeof x === "object" && !Array.isArray(x)
		? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
		: x);

// ── 探针：零成本，整轮只需一次。故意传不认识的口径版本，服务端应**前置拒绝**（6212）──
// 它同时验三件事：路由在、鉴权通、错误码映射对（6212 必须是 4xx，不是 5xx）
console.log("\n【探针】不认识的 algo_pin → 应 400 + code 6212（零计费）");
try {
	await requestArrange(endpoint, { ...jobs[0].req, algo_pin: "arrange-metering@v0-probe" }, { retries: 0 });
	console.log("  ✗ 竟然成功了 —— 不认识的口径版本本该被拒");
} catch (e) {
	if (e.rejected === true && e.code === 6212) console.log("  ✓ 6212，且被正确识别为业务拒绝（未进退避）");
	else console.log(`  ✗ 期望 6212 业务拒绝，实得 code=${e.code} rejected=${e.rejected === true}\n    ${String(e.message).split("\n")[0].slice(0, 160)}`);
}
if (probeOnly) process.exit(0);

const failures = [];
for (const j of jobs) {
	const { name, fx, plan, lay, score_floor, opts, req } = j;
	console.log(`\n══ ${name}  （${req.estimated_units} 编排量，lay=${lay}）`);
	const bad = (m) => { failures.push(`${name}: ${m}`); return "✗"; };

	// ── 真机编排：会计费 ──
	const resp = await requestArrange(endpoint, req, { retries: 0 });
	const okRec = resp.idempotency_recorded === true;
	console.log(`  ${okRec ? "✓" : bad("幂等未登记 —— 本次调用无幂等保护")} units=${resp.units}  task_id=${resp.task_id}  幂等登记=${resp.idempotency_recorded}`);

	// 双端复算一致：不一致意味着计量公式漂移，是计费争议的源头
	const okUnits = req.estimated_units === resp.units;
	console.log(`  ${okUnits ? "✓" : bad(`复算不一致 本地 ${req.estimated_units} / 服务端 ${resp.units}`)} 双端复算：本地 ${req.estimated_units} / 服务端 ${resp.units}`);

	// ★ 真机跨语言对拍：服务端产物必须与本仓金样逐字节相同
	const remote = canon(serialize(applyArrangeResponse(resp, lay)));
	const golden = canon(fx.expected);
	const local = canon(serialize(planBeatFills(plan, lay, score_floor, opts)));
	console.log(`  ${remote === golden ? "✓" : bad("服务端产物与金样不一致")} 服务端 vs 金样`);
	console.log(`  ${local === golden ? "✓" : bad("本地重跑与金样不一致（金样自身漂了）")} 本地重跑 vs 金样`);

	// 幂等重发：逐字节相同的请求体，必须回放而非重算重扣
	const resp2 = await requestArrange(endpoint, req, { retries: 0 });
	const same = resp2.task_id === resp.task_id && resp2.idempotent_replay === true;
	console.log(`  ${same ? "✓" : bad("重发未命中幂等 —— 又跑了一遍、又扣了一次")} 幂等重发：回放同一 task_id`);
}

console.log(`\n${failures.length ? `✗ ${failures.length} 项未过：\n  ${failures.join("\n  ")}` : `✓ 全部通过（${jobs.length} 份夹具，${total} 编排量）`}`);
process.exit(failures.length ? 1 : 0);
