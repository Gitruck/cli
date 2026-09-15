#!/usr/bin/env node
/**
 * 存量修复：把被客户端刷宽的 MG clip 窗口拉回 `struct_meta.mg` 账本记的值。
 *
 * ## 治的是什么
 *
 * opencut 打开工程时的模板自动刷新曾把时间线元素的 `duration` 写成颗粒 IR 的
 * `canvas.duration`（`fix-template-refresh-overwrites-clip-window`，已修）。
 * 而 CLI 铺的文字模板颗粒按铁律⑦ **恒比坑位包络长 0.3 秒** ⇒ 工程每开一次，
 * 每颗颗粒的窗口就被拉长 0.3s ⇒ MG 槽位间隙常只有 100–200ms ⇒ **同轨重叠**
 * ⇒ 导出时写方不变量把**六种格式一起**拦下。
 *
 * 代码修好之后**新的不会再坏，但已经写进盘的坏值不会自愈**——这个脚本管存量。
 *
 * ## 判据与边界
 *
 * - 权威是 `struct_meta.mg.beats[].track_ed`（`gtrk mg lay` 按坑位包络写的，账本是对的）。
 * - **只收窄、不扩张**。轨上比账本**短**的一律不碰——那可能是用户自己拖短的。
 * - **只动账本认领的 clip**（`composition_id` 在 `beats` 里）。用户手加的颗粒零连带。
 * - 账本读 `mg ∪ rrv` 并集（老工程用 `rrv` 键）。
 * - **默认 dry-run**，要写盘必须显式 `--write`；写盘前留 `.bak-<时间戳>`。
 *
 * ⚠️ 本脚本 MUST NOT 去猜「账本没有的 clip 该多长」——判不准一律不动。
 *
 * 用法：
 *   node scripts/repair-mg-clip-windows.mjs <project.gtrk 或工程目录> [--write]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const write = args.includes("--write");
const target = args.find((a) => !a.startsWith("--"));

if (!target) {
	console.error("用法: node scripts/repair-mg-clip-windows.mjs <project.gtrk 或工程目录> [--write]");
	process.exit(2);
}

const file = existsSync(target) && statSync(target).isDirectory() ? join(target, "project.gtrk") : target;
if (!existsSync(file)) {
	// 盘不在就报错退出，MUST NOT 静默跳过——「以为修了其实没修」比没修更糟。
	console.error(`找不到工程文件：${file}`);
	process.exit(2);
}

const raw = readFileSync(file, "utf8");
const doc = JSON.parse(raw);

/** 账本：composition_id → 账本记的 track_ed（读 mg ∪ rrv 并集，老工程零迁移）。 */
const ledger = new Map();
for (const key of ["mg", "rrv"]) {
	for (const b of doc.struct_meta?.[key]?.beats ?? []) {
		if (typeof b?.composition_id === "string" && typeof b?.track_ed === "number") {
			// 同 id 两处都有时取**更小**的那个：收窄方向保守。
			const prev = ledger.get(b.composition_id);
			ledger.set(b.composition_id, prev === undefined ? b.track_ed : Math.min(prev, b.track_ed));
		}
	}
}

if (!ledger.size) {
	console.log("struct_meta 里没有 mg/rrv 账本，无从判断权威值——不动任何东西。");
	process.exit(0);
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const fixes = [];
const skippedShorter = [];
const skippedUnknown = new Set();

for (const track of doc.beat_track ?? []) {
	for (const clip of track.track_timeline ?? []) {
		// 颗粒身份取 clip.material（mg-lay 写的 composition_id）；取不到就不认领。
		const cid = typeof clip.material === "string" ? clip.material : "";
		const want = ledger.get(cid);
		if (want === undefined) {
			if (cid) skippedUnknown.add(cid);
			continue;
		}
		const have = clip.track_ed;
		if (typeof have !== "number") continue;
		const deltaMs = Math.round((have - want) * 1000);
		if (deltaMs <= 0) {
			if (deltaMs < 0) skippedShorter.push({ cid, have, want, deltaMs });
			continue;
		}
		fixes.push({ track: track.track_index, cid, have, want, deltaMs, clip });
	}
}

console.log(`工程：${file}`);
console.log(`账本认领 ${ledger.size} 颗；beat 轨 ${(doc.beat_track ?? []).length} 条\n`);

if (!fixes.length) {
	console.log("✅ 没有比账本长的 clip，无需修复。");
} else {
	console.log(`发现 ${fixes.length} 颗窗口比账本长：`);
	for (const f of fixes) {
		console.log(`  [t${f.track}] ${f.cid.padEnd(22)} ${f.have.toFixed(3)} → ${f.want.toFixed(3)}  (收窄 ${f.deltaMs}ms)`);
	}
}

if (skippedShorter.length) {
	console.log(`\n比账本短的 ${skippedShorter.length} 颗**不动**（可能是用户自己拖短的）：`);
	for (const s of skippedShorter) console.log(`  ${s.cid}  ${s.have.toFixed(3)} < 账本 ${s.want.toFixed(3)}`);
}
if (skippedUnknown.size) {
	console.log(`\n账本没认领的 ${skippedUnknown.size} 颗**不动**：${[...skippedUnknown].join(", ")}`);
}

// 修复后再扫一遍同轨重叠，把结果如实报出来——「修完还剩几条」比「修了几条」有用。
const overlapsAfter = [];
for (const track of doc.beat_track ?? []) {
	const clips = [...(track.track_timeline ?? [])]
		.map((c) => ({
			id: c.clip_id ?? c.material,
			st: c.track_st,
			ed: ledger.has(c.material) ? Math.min(c.track_ed, ledger.get(c.material)) : c.track_ed,
		}))
		.filter((c) => typeof c.st === "number" && typeof c.ed === "number")
		.sort((a, b) => a.st - b.st);
	for (let i = 0; i + 1 < clips.length; i++) {
		const ov = Math.round((clips[i].ed - clips[i + 1].st) * 1000);
		if (ov > 0) overlapsAfter.push(`[t${track.track_index}] ${clips[i].id} 与 ${clips[i + 1].id} 仍重叠 ${ov}ms`);
	}
}
console.log(
	overlapsAfter.length
		? `\n⚠️ 修复后仍有 ${overlapsAfter.length} 处同轨重叠（不是本脚本能治的，需人看）：\n  ` +
				overlapsAfter.join("\n  ")
		: "\n✅ 按修复值重算，同轨重叠为 0。",
);

if (!fixes.length) process.exit(0);

if (!write) {
	console.log("\n（dry-run。要写盘请加 --write）");
	process.exit(0);
}

for (const f of fixes) {
	f.clip.track_ed = r3(f.want);
	if (typeof f.clip.track_st === "number") f.clip.duration = r3(f.want - f.clip.track_st);
}

const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(file, bak);
// 保持原文件的缩进风格：绝大多数 .gtrk 是紧凑 JSON，重排会让整个文件进 diff。
const compact = !/\n\s+"/.test(raw.slice(0, 4096));
writeFileSync(file, JSON.stringify(doc, null, compact ? 0 : "\t"), "utf8");
console.log(`\n✅ 已写盘，${fixes.length} 颗收窄。备份：${bak}`);
