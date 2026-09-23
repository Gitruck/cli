#!/usr/bin/env node
/**
 * 发版期脚本：拉 Hyperframes registry（钉 commit）→ 逐块预筛（prescreen）→ 写随包快照
 * `src/data/mg-registry-catalog.json` + 镜像包 `out/mg-registry-mirror/<commit>/`（原样 HTML + manifest.json + NOTICE）。
 *
 * change add-mg-registry-neutral-source · design D4。**不挂 prepublishOnly**（发版门与快照刷新是两件事），发版清单手动跑：
 *   npm test                                   # 先有 .test-build/mg-adopt.mjs
 *   node scripts/mg-registry-snapshot.mjs [--commit <sha>] [--concurrency 6] [--keep-compat]
 *
 * --keep-compat：保留既有快照里人工改过的 compat（真渲验收后由 review 改 ok / excluded 的件），
 *                只在预筛结论「变严」（新判 excluded）时覆盖；缺省关闭 = 全按预筛重算。
 * 网络：jsdelivr GitHub 镜像优先（大陆可达），失败回落 GitHub raw。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k, d) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1] : d;
};
const REPO = "heygen-com/hyperframes";
const COMMIT = opt("--commit", "8bf5b4423e704ea4578b9fd5dd988907fbfc45bf");
const CONCURRENCY = Number(opt("--concurrency", "6"));
const KEEP_COMPAT = args.includes("--keep-compat");
const MIRROR_ROOT = "https://api.ai-mcn.tv:9000/broadcast/mg-registry";
const SOURCES = [
	`https://cdn.jsdelivr.net/gh/${REPO}@${COMMIT}/registry`,
	`https://raw.githubusercontent.com/${REPO}/${COMMIT}/registry`,
];
const OUT_JSON = join(root, "src", "data", "mg-registry-catalog.json");
const OUT_DIR = join(root, "out", "mg-registry-mirror", COMMIT);
const adoptMod = join(root, ".test-build", "mg-adopt.mjs");
if (!existsSync(adoptMod)) {
	console.error("缺 .test-build/mg-adopt.mjs：先跑一次 npm test");
	process.exit(2);
}
const { prescreenBlock } = await import(`file://${adoptMod.replace(/\\/g, "/")}`);

async function getText(rel) {
	let lastErr;
	for (const base of SOURCES) {
		const url = `${base}/${rel}`;
		for (let attempt = 0; attempt < 2; attempt++) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 15000);
			try {
				const r = await fetch(url, { signal: ac.signal });
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return await r.text();
			} catch (e) {
				lastErr = `${url} → ${e instanceof Error ? e.message : String(e)}`;
			} finally {
				clearTimeout(t);
			}
		}
	}
	throw new Error(`取不到 ${rel}：${lastErr}`);
}

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const prev = existsSync(OUT_JSON) ? JSON.parse(readFileSync(OUT_JSON, "utf8")) : null;
const prevCompat = new Map((prev?.items ?? []).map((i) => [i.name, i]));

console.error(`registry @ ${COMMIT.slice(0, 12)}：读索引…`);
const index = JSON.parse(await getText("registry.json"));
const entries = (index.items ?? index).filter((i) => i.type === "hyperframes:block").map((i) => i.name);
console.error(`block ${entries.length} 件，并发 ${CONCURRENCY}`);

const items = [];
const failures = [];
let done = 0;
async function worker(queue) {
	while (queue.length) {
		const name = queue.shift();
		try {
			const meta = JSON.parse(await getText(`blocks/${name}/registry-item.json`));
			// 只拉 HTML；非 HTML 资产（图片 / 字体 / 打包 js）不下载——多文件块预筛必 excluded，资产路径记进 assets 供人读
			const files = [];
			const assets = [];
			for (const f of meta.files ?? []) {
				if (!/\.html?$/i.test(f.path)) {
					assets.push(f.path);
					continue;
				}
				const text = await getText(`blocks/${name}/${f.path}`);
				files.push({ path: f.path, sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8"), text });
			}
			const html = files.find((f) => /\.html?$/i.test(f.path))?.text ?? "";
			const pre = prescreenBlock(html, {
				name,
				tags: meta.tags ?? [],
				files: (meta.files ?? []).map((f) => ({ path: f.path, target: f.target, type: f.type })),
				width: meta.dimensions?.width,
				height: meta.dimensions?.height,
				duration: meta.duration,
			});
			let compat = pre.compat;
			let reasons = pre.reasons;
			const old = prevCompat.get(name);
			if (KEEP_COMPAT && old && old.compat !== compat && compat !== "excluded") {
				reasons = [...reasons, `保留既有快照人工判定 ${old.compat}（--keep-compat）`];
				compat = old.compat;
			}
			items.push({
				name,
				title: meta.title ?? name,
				description: meta.description ?? "",
				tags: meta.tags ?? [],
				width: meta.dimensions?.width ?? 1920,
				height: meta.dimensions?.height ?? 1080,
				duration: typeof meta.duration === "number" ? meta.duration : null,
				...(meta.stability ? { stability: meta.stability } : {}),
				preview: { poster: meta.preview?.poster, video: meta.preview?.video },
				...(meta.params ? { params: meta.params } : {}),
				...(meta.variables ? { variables: meta.variables } : {}),
				files: files.map(({ text, ...f }) => f),
				...(assets.length ? { assets } : {}),
				compat,
				compat_reasons: reasons,
			});
			for (const f of files) {
				const p = join(OUT_DIR, "blocks", name, f.path);
				mkdirSync(dirname(p), { recursive: true });
				writeFileSync(p, f.text, "utf8");
			}
		} catch (e) {
			failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			done += 1;
			if (done % 20 === 0) console.error(`  …${done}/${entries.length}`);
		}
	}
}
const queue = [...entries];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
items.sort((a, b) => a.name.localeCompare(b.name));

const snapshot = {
	schema: 1,
	source: { repo: REPO, commit: COMMIT, snapshot_date: new Date().toISOString().slice(0, 10), registry_path: "registry" },
	mirrors: [
		{ id: "mirror", base: `${MIRROR_ROOT}/${COMMIT}` },
		{ id: "jsdelivr", base: SOURCES[0] },
		{ id: "github", base: SOURCES[1] },
	],
	items,
};
mkdirSync(dirname(OUT_JSON), { recursive: true });
writeFileSync(OUT_JSON, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

const manifest = {
	schema: 1,
	repo: REPO,
	commit: COMMIT,
	generated: new Date().toISOString(),
	license: "Apache-2.0",
	files: items.flatMap((i) => i.files.map((f) => ({ path: `blocks/${i.name}/${f.path}`, sha256: f.sha256, bytes: f.bytes }))),
};
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
writeFileSync(
	join(OUT_DIR, "NOTICE"),
	`HyperFrames registry blocks — https://github.com/${REPO} @ ${COMMIT}\nLicensed under the Apache License, Version 2.0. Mirrored unmodified for mainland-China reachability by 同合云 gtrk-cli (change add-mg-registry-neutral-source).\n`,
	"utf8",
);

const counts = items.reduce((m, i) => ((m[i.compat] = (m[i.compat] ?? 0) + 1), m), {});
console.error(`\n快照写入 ${OUT_JSON}：${items.length} 件（ok ${counts.ok ?? 0} / review ${counts.review ?? 0} / excluded ${counts.excluded ?? 0}）`);
console.error(`镜像包写入 ${OUT_DIR}（manifest ${manifest.files.length} 文件）`);
if (failures.length) {
	console.error(`\n失败 ${failures.length} 件：\n  ${failures.join("\n  ")}`);
	process.exitCode = 1;
}
const reasonTally = {};
for (const i of items) for (const r of i.compat_reasons) reasonTally[r.split("（")[0].split("：")[0]] = (reasonTally[r.split("（")[0].split("：")[0]] ?? 0) + 1;
console.error("\n预筛原因分布：");
for (const [k, v] of Object.entries(reasonTally).sort((a, b) => b[1] - a[1])) console.error(`  ${String(v).padStart(4)}  ${k}`);
