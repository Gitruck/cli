/**
 * 逐字节等价闸：93 份金样在 **Python 正本** 与 **TS 第二实现** 下产物必须一字不差。
 *
 * 这道闸是 `move-text-ir-compiler-to-client` 成立的**全部前提**。两份实现不可能靠
 * 「小心一点」保持同步——它们会漂，而漂的后果是**静默**的：客户端本地编出来的颗粒
 * 被服务端判成 `detached`，云端改写入口失效，不报任何错。
 *
 * ⚠️ MUST NOT 加容差、MUST NOT 加跳过开关。`html_sha256` 是精确比较，
 * 「差一个空格」与「差一整段」在下游是同一个后果。
 *
 * 判据取的是 **infra 金样目录里的 `.html`**（Python 正本的产物，已被 infra 侧金样闸钉住），
 * 所以本闸不需要现场跑 Python：金样在，就等于正本产物在。
 * 金样目录不可达时**判红退出**，MUST NOT 静默跳过——那正是本闸最该喊的时候。
 *
 * 用法：node scripts/text-ir-parity.mjs [金样目录]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compileIr } from "../.test-build/text-ir-compile.mjs";

const DEFAULT_GOLDEN = "D:/file/gitruck-infra/utils/test/fixtures/text_ir";
const dir = process.argv[2] ?? process.env.GTRK_TEXT_IR_GOLDENS ?? DEFAULT_GOLDEN;

if (!existsSync(dir)) {
	console.error(`❌ 金样目录不可达：${dir}`);
	console.error("   本闸判的是「两份实现产物是否逐字节相同」，没有正本产物就无从判起。");
	console.error("   传目录：node scripts/text-ir-parity.mjs <infra>/utils/test/fixtures/text_ir");
	console.error("   或设 GTRK_TEXT_IR_GOLDENS。**MUST NOT 把它改成静默跳过。**");
	process.exit(2);
}

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const ids = readdirSync(dir)
	.filter((f) => f.endsWith(".ir.json"))
	.map((f) => f.slice(0, -".ir.json".length))
	.sort();

if (ids.length === 0) {
	console.error(`❌ ${dir} 里一份金样都没有`);
	process.exit(2);
}

let ok = 0;
const bad = [];
for (const id of ids) {
	const ir = JSON.parse(readFileSync(join(dir, `${id}.ir.json`), "utf8"));
	const want = readFileSync(join(dir, `${id}.html`), "utf8");
	let got;
	try {
		got = compileIr(ir, sha256);
	} catch (e) {
		bad.push({ id, why: `TS 侧抛错：${e instanceof Error ? e.message : String(e)}` });
		continue;
	}
	if (got === want) {
		ok++;
		continue;
	}
	// 指名到「第几字节、两边各是什么」——只说「不一致」会让排查从头开始
	let i = 0;
	while (i < Math.min(got.length, want.length) && got[i] === want[i]) i++;
	const ctx = (s) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
	bad.push({
		id,
		why:
			`第 ${i} 字节起不同（Python ${want.length} 字节 / TS ${got.length} 字节）\n` +
			`       正本: ${ctx(want)}\n` +
			`       TS  : ${ctx(got)}`,
	});
}

console.log(`逐字节等价：${ok} / ${ids.length} 相同`);
if (bad.length) {
	console.log(`\n✗ ${bad.length} 份不同：`);
	for (const b of bad.slice(0, 8)) console.log(`  · ${b.id}：${b.why}`);
	if (bad.length > 8) console.log(`  …另有 ${bad.length - 8} 份`);
	process.exit(1);
}
console.log("等价闸通过");
