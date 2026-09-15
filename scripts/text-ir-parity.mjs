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
 * ## 两段，缺一段就是「绿得不对地方」（fix-local-ir-compile-skips-validation）
 *
 * ① **合法面**：金样两侧逐字节相同（本闸原有的全部内容）。
 * ② **拒绝面**：非法样本集两侧**都拒**，且**拒的条数与首条消息一致**。
 *
 * ⚠️ 加 ② 的理由，是 ① 单独存在时有一个结构性盲区：它**只喂合法输入**，
 * 于是两份实现的快乐路径逐字节等价、**拒绝面各走各的，闸看不见那一侧**。
 * 2026-09-15 的代价：TS 侧压根没有校验器，`transparent:false` 与 `1280x720@60fps`
 * 本地一律 exit 0 落盘，而服务端会拒——t07 工程里三颗颗粒就是从这个口子溜进来的。
 * **闸是绿的、绿得也对，只是它量的不是这件事。**
 *
 * ⚠️ 两段的通过数 MUST **分别**报出。合并成一个数之后，「拒绝面一条都没跑」
 * 在输出里看不出来——那正是本段要根治的那种盲。
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
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ **先重建再对拍**。`.test-build/` 只由 `npm test` 产出，单独跑本脚本会拿**旧构建**去比——
// 2026-09-14 实撞：改完 TS 编译器直接跑闸，10 份新金样判红，查了半天才发现红的是陈旧产物。
// 闸拿旧东西比出来的绿是假绿，比判红更危险。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 走 `node <esbuild 的 js 入口>` 而不是 `.bin/esbuild.cmd`：
// Windows 上 `.cmd` 壳需要 shell 才 spawn 得起来，而开 shell 又要处理带空格的路径转义。
execFileSync(
	process.execPath,
	[
		join(ROOT, "node_modules", "esbuild", "bin", "esbuild"),
		join(ROOT, "src", "lib", "text-ir", "compile.ts"),
		"--bundle",
		"--platform=node",
		"--format=esm",
		`--outfile=${join(ROOT, ".test-build", "text-ir-compile.mjs")}`,
	],
	{ stdio: "pipe" },
);

execFileSync(
	process.execPath,
	[
		join(ROOT, "node_modules", "esbuild", "bin", "esbuild"),
		join(ROOT, "src", "lib", "text-ir", "validate.ts"),
		"--bundle",
		"--platform=node",
		"--format=esm",
		`--outfile=${join(ROOT, ".test-build", "text-ir-validate.mjs")}`,
	],
	{ stdio: "pipe" },
);

const { compileIr } = await import("../.test-build/text-ir-compile.mjs");
const { validateIr } = await import("../.test-build/text-ir-validate.mjs");

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

console.log(`① 合法面：${ok} / ${ids.length} 逐字节相同`);
if (bad.length) {
	console.log(`\n✗ ${bad.length} 份不同：`);
	for (const b of bad.slice(0, 8)) console.log(`  · ${b.id}：${b.why}`);
	if (bad.length > 8) console.log(`  …另有 ${bad.length - 8} 份`);
	process.exit(1);
}

// ───────────────────────── ② 拒绝面 ─────────────────────────
// 非法样本两侧都 MUST 拒。判据取「拒的条数 + 首条消息」——
// 逐条全比会把措辞也钉死，改一句文案就红；只比「拒没拒」又太松（两侧可能因**完全不同**
// 的理由拒，那是漂了而不自知）。条数 + 首条落在这两者之间。
const invalidDir = process.env.GTRK_TEXT_IR_INVALID ?? dir.replace(/text_ir$/, "text_ir_invalid");
if (!existsSync(invalidDir)) {
	console.error(`❌ 拒绝面样本目录不可达：${invalidDir}`);
	console.error("   ⚠️ **MUST NOT 改成静默跳过**：本段正是为了根治「只测快乐路径」的盲，");
	console.error("   跳过它等于把那个盲又装回来，而且装得更隐蔽（闸还是绿的）。");
	process.exit(2);
}
const invalidIds = readdirSync(invalidDir)
	.filter((f) => f.endsWith(".ir.json"))
	.map((f) => f.slice(0, -".ir.json".length))
	.sort();
if (invalidIds.length === 0) {
	console.error(`❌ ${invalidDir} 里一份非法样本都没有 —— 拒绝面 0/0 是「没跑」不是「通过」`);
	process.exit(2);
}

let okBad = 0;
const badBad = [];
for (const id of invalidIds) {
	const ir = JSON.parse(readFileSync(join(invalidDir, `${id}.ir.json`), "utf8"));
	const want = JSON.parse(readFileSync(join(invalidDir, `${id}.expected.json`), "utf8"));
	const got = validateIr(ir);
	if (got.length === 0) {
		badBad.push({ id, why: "TS 侧**放行**了这份非法 IR（Python 正本拒了）" });
		continue;
	}
	if (got.length !== want.count || got[0] !== want.first) {
		badBad.push({
			id,
			why:
				`条数/首条不符 —— Python ${want.count} 条、首条 ${JSON.stringify(want.first)}；` +
				`TS ${got.length} 条、首条 ${JSON.stringify(got[0])}`,
		});
		continue;
	}
	okBad++;
}
console.log(`② 拒绝面：${okBad} / ${invalidIds.length} 两侧同判`);
if (badBad.length) {
	console.log(`\n✗ ${badBad.length} 份不同：`);
	for (const b of badBad.slice(0, 8)) console.log(`  · ${b.id}：${b.why}`);
	if (badBad.length > 8) console.log(`  …另有 ${badBad.length - 8} 份`);
	process.exit(1);
}
console.log("等价闸通过（两段）");
