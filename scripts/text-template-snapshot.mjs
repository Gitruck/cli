/**
 * 文字模板目录快照 + 镜像包生成（change add-text-template-source）。
 *
 * 从一批 IR 与编译产物产出两样东西：
 *   ① `src/data/text-template-catalog.json` —— 随包的**离线兜底**目录
 *   ② `dist/text-templates-mirror/` —— 上传到镜像的目录与块（`catalog.json` +
 *      不可变副本 `catalog-<version>.json` + `blocks/<id>/<id>.html` + `posters/`）
 *
 * 目录走「远端择新、随包兜底」（主理人 2026-09-14 拍板）：扩批是零代码的纯写 IR 轮次，
 * 不该被 CLI 与客户端各发一次版卡住。所以随包那份**会过期，这是设计**——
 * 运行时按 `version` 择新，随包只在三源都不可达时顶上。
 *
 * 用法：
 *   node scripts/text-template-snapshot.mjs --src <产物目录> --version 2026-09-14.1
 *
 * `--src` 目录里要有 `ir/<id>.ir.json` 与 `out/<id>.html`（或 `out-prod/`）。
 * 每件的 `sha256` 取**编译产物 HTML 的字节**——取块时逐字节校它，版本错位与篡改在那里被拒。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR_ROOT = "https://api.ai-mcn.tv:9000/broadcast/text-templates";
const MIRRORS = [
	{ id: "tonghe", base: MIRROR_ROOT },
	{ id: "jsdelivr", base: "https://cdn.jsdelivr.net/gh/Gitruck/text-templates@main" },
	{ id: "raw", base: "https://raw.githubusercontent.com/Gitruck/text-templates/main" },
];

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const srcDir = resolve(arg("src", ""));
const version = arg("version", new Date().toISOString().slice(0, 10).replace(/-/g, "-") + ".1");
if (!srcDir || !existsSync(srcDir)) {
	console.error("用法：node scripts/text-template-snapshot.mjs --src <产物目录> --version <版本>");
	process.exit(2);
}

// 两种输入布局都收：
//   ① 分目录：`ir/<id>.ir.json` + `out/<id>.html`（原型工作区 _tmp/textfx-batch1）
//   ② 平铺：  `<id>.ir.json` + `<id>.html` 同目录（infra 的金样目录 utils/test/fixtures/text_ir，
//      **发版应当以它为准**——那是被测试钉住、随 infra 一起提交的那一份）
const nested = existsSync(join(srcDir, "ir"));
const irDir = nested ? join(srcDir, "ir") : srcDir;
const outDir = nested ? ["out-prod", "out"].map((d) => join(srcDir, d)).find((d) => existsSync(d)) : srcDir;
if (!existsSync(irDir) || !outDir) {
	console.error(`目录里既没有 ir/ + out/，也不是平铺的 <id>.ir.json + <id>.html：${srcDir}`);
	process.exit(2);
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** 首行声明里的 ir 哈希原样取出——本脚本不复刻 Python 的 canonical JSON。 */
function declaredIrSha(html) {
	const m = /^<!-- gtrk-ir-sha256=([0-9a-f]{64}) /.exec(html);
	return m ? m[1] : "";
}

/** 家族号从 IR 顶层取；缺了就归 F00，别默默猜错分组。 */
function familyOf(ir) {
	return typeof ir.family === "string" && ir.family ? ir.family : "F00";
}

/** 检索标签：家族 + 标题里的词 + 槽位名。不求全，够打分用。 */
function tagsOf(ir, id) {
	const tags = new Set();
	tags.add(familyOf(ir));
	for (const part of id.replace(/^tfx-/, "").split("-")) if (part) tags.add(part);
	for (const key of Object.keys(ir.slots ?? {})) tags.add(key);
	return [...tags];
}

const items = [];
const blocksOut = join(ROOT, "dist", "text-templates-mirror");
mkdirSync(join(blocksOut, "blocks"), { recursive: true });
mkdirSync(join(blocksOut, "posters"), { recursive: true });

for (const name of readdirSync(irDir).sort()) {
	if (!name.endsWith(".ir.json")) continue;
	const id = name.slice(0, -".ir.json".length);
	const htmlPath = join(outDir, `${id}.html`);
	if (!existsSync(htmlPath)) {
		console.warn(`跳过 ${id}：没有编译产物 ${htmlPath}`);
		continue;
	}
	const ir = JSON.parse(readFileSync(join(irDir, name), "utf8"));
	const html = readFileSync(htmlPath, "utf8");
	if (html.includes("\r")) {
		// CRLF 会让 sha256 与服务端算的对不上，取块时当场判「篡改」
		console.error(`${id} 的产物含 CR，换行必须是 LF`);
		process.exit(1);
	}
	items.push({
		id,
		title: ir.title ?? id,
		family: familyOf(ir),
		tags: tagsOf(ir, id),
		duration: ir.canvas?.duration ?? 0,
		slots: Object.keys(ir.slots ?? {}),
		poster: `posters/${id}.webp`,
		file: { path: `${id}.html`, sha256: sha256(html), bytes: Buffer.byteLength(html, "utf8") },
		ir_sha256: declaredIrSha(html),
	});

	mkdirSync(join(blocksOut, "blocks", id), { recursive: true });
	writeFileSync(join(blocksOut, "blocks", id, `${id}.html`), html, "utf8");
	const poster = join(srcDir, "posters", `${id}.webp`);
	if (existsSync(poster)) copyFileSync(poster, join(blocksOut, "posters", `${id}.webp`));
}

const catalog = {
	schema: 1,
	version,
	generated_at: new Date().toISOString(),
	mirrors: MIRRORS,
	items,
};
const json = JSON.stringify(catalog, null, "\t") + "\n";

writeFileSync(join(ROOT, "src", "data", "text-template-catalog.json"), json, "utf8");
// 镜像上放两份：`catalog.json` 是运行时读的，`catalog-<version>.json` 是不可变副本，
// 方便出问题时钉回某一版看当时到底发了什么。
writeFileSync(join(blocksOut, "catalog.json"), json, "utf8");
writeFileSync(join(blocksOut, `catalog-${version}.json`), json, "utf8");

console.log(`目录 v${version}：${items.length} 件`);
console.log(`  随包兜底 → src/data/text-template-catalog.json`);
console.log(`  镜像包   → dist/text-templates-mirror/（上传到 ${MIRROR_ROOT}/）`);
