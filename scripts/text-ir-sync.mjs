/**
 * 把 TS 编译器同步到 opencut（方案 A：一份实现放 cli，脚本同步过去）。
 *
 * 为什么是复制而不是共享包：cli 与 opencut 是两个独立仓、没有共享包基建，
 * 目录快照（`text-template-catalog.json`）走的也是同一个模式。新起一个 npm 包会把
 * 两仓的发版耦合起来，代价大于收益（主理人 2026-09-14 拍板取 A）。
 *
 * ⚠️ 复制的代价是**两份字节会漂**。所以两端各有一条用例校「与 cli 那份逐字节相同」——
 * 没有那条闸，A 方案就退化成「两份实现」，而那正是本线最想避免的东西。
 *
 * 用法：node scripts/text-ir-sync.mjs [opencut 仓根]
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "lib", "text-ir", "compile.ts");
const DEFAULT_OC = "D:/file/gitruck-opencut-rewrite";
const oc = process.argv[2] ?? process.env.GTRK_OPENCUT_ROOT ?? DEFAULT_OC;
const dstDir = join(oc, "apps", "web", "src", "tonghe", "text-ir");
const dst = join(dstDir, "compile.ts");

if (!existsSync(oc)) {
	console.error(`❌ opencut 仓不可达：${oc}`);
	console.error("   传路径：node scripts/text-ir-sync.mjs <opencut 仓根>，或设 GTRK_OPENCUT_ROOT");
	process.exit(2);
}
mkdirSync(dstDir, { recursive: true });
copyFileSync(SRC, dst);

const a = readFileSync(SRC, "utf8");
const b = readFileSync(dst, "utf8");
if (a !== b) {
	console.error("❌ 复制后两份仍不同——文件系统或换行处理有问题，别当成功");
	process.exit(1);
}

// 指纹旁挂：两边各写一份**同样**的 sha256。各仓的用例只校「我这份的 hash == 我这边的旁挂」，
// 于是跨仓比对不需要对方的检出（CI 上本来就拿不到）。
// 直接改副本 → 副本那边红；改了源没同步 → 源那边红。两条漂都抓得住。
const sha = createHash("sha256").update(a, "utf8").digest("hex");
writeFileSync(`${SRC}.sha256`, `${sha}\n`, "utf8");
writeFileSync(`${dst}.sha256`, `${sha}\n`, "utf8");
console.log(`已同步 → ${dst}`);
console.log(`  ${a.length} 字符，逐字节相同；指纹 ${sha.slice(0, 12)}… 已旁挂两边`);
