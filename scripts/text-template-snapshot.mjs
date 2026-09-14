/**
 * 文字模板目录快照 + 镜像包生成（change add-text-template-source）。
 *
 * 从一批 IR 与编译产物产出两样东西：
 *   ① `src/data/text-template-catalog.json` —— 随包的**离线兜底**目录
 *   ② 镜像目录本身 —— `catalog.json` + 不可变副本 `catalog-<version>.json`
 *      + `blocks/<id>/<id>.html` + `posters/`
 *
 * ⚠️ **②直接写生效的镜像目录，不再经 `dist/` 中转**（主理人 2026-09-14 拍板：
 * 「以后直接改 T:\web\broadcast\text-templates 就好，dist 那份不用了」）。那个盘
 * 即公网 `MIRROR_ROOT` 的落地面（见 static-assets 映射），**写进去就是发布**。
 * 因此本脚本按「先块、后不可变副本、最后才切 `catalog.json` 指针」的次序写：
 * 指针是唯一的生效开关，它最后落地，中途失败也不会出现「目录声明了某块、块还没上去」。
 * 回滚 = 把某个 `catalog-<旧版本>.json` 覆盖成 `catalog.json`（块是只增不删的）。
 *
 * 目录走「远端择新、随包兜底」（主理人 2026-09-14 拍板）：扩批是零代码的纯写 IR 轮次，
 * 不该被 CLI 与客户端各发一次版卡住。所以随包那份**会过期，这是设计**——
 * 运行时按 `version` 择新，随包只在三源都不可达时顶上。
 *
 * 用法：
 *   node scripts/text-template-snapshot.mjs --src <产物目录> --version 2026-09-14.1
 *   node scripts/text-template-snapshot.mjs --src <产物目录> --version … --mirror <目录>
 *
 * `--src` 目录里要有 `ir/<id>.ir.json` 与 `out/<id>.html`（或 `out-prod/`）。
 * `--mirror` 默认 `MIRROR_DIR`，也可用环境变量 `GITRUCK_TEXT_TEMPLATE_MIRROR_DIR` 顶掉
 * （换机器 / 演练时用）。**盘不在就报错退出，不偷偷落到别处** —— 静默换落点等于
 * 「以为发了、其实没发」，而目录的失败形态本来就是「悄悄少一件」。
 * 每件的 `sha256` 取**编译产物 HTML 的字节**——取块时逐字节校它，版本错位与篡改在那里被拒。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR_ROOT = "https://api.ai-mcn.tv:9000/broadcast/text-templates";
/** `MIRROR_ROOT` 的落地目录（本机 T: 盘即公网静态资源根）。 */
const MIRROR_DIR = "T:\\web\\broadcast\\text-templates";
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

// ── 分类（change add-text-template-category）──────────────────────────────
// `family` 是**内部来源编号**（F=喵影家族 / M=MAD 技法图鉴技法号 / R=参考视频序号），
// 93 件摊出 37 组、其中 16 组只有 1 件。它从来不是给用户看的字段。
// 分类按**用户想干什么**归，判据是规则不是手工名单：满 MIN_MEMBERS 件才配独立，
// 其余进「其他」，总数（含「其他」）≤ MAX_CATEGORIES。扩批时按同一把尺重算——
// 手工名单会让「上次怎么分的」只存在于某个人的记忆里。
const OTHER = "其他";
const MIN_MEMBERS = 7;
const MAX_CATEGORIES = 8;
/** 组名 → 判定（收 id 去掉 `tfx-` 前缀后的短名）。顺序即优先级，先命中先归。 */
const GROUPS = [
	["打字机", (s) => s.startsWith("type-") || s === "title-typeline"],
	["字幕", (s) =>
		s.startsWith("caption-") ||
		["word-relay", "lyric-stagger", "variety-subtitle", "card-caption", "brush-title"].includes(s)],
	["人名条", (s) => s.startsWith("lowerthird-") || ["hud-lowerthird", "tag-pill"].includes(s)],
	["对话气泡", (s) => s.startsWith("bubble-") || ["button-emoji", "ui-toast"].includes(s)],
	["标注引用", (s) => s.startsWith("callout-") || s.startsWith("quote-")],
	["商务排版", (s) =>
		s.startsWith("biz-") || ["mag-cover", "news-band", "cine-title"].includes(s)],
	// 标题放最后：`title-*` 是最泛的前缀，前面那些更具体的先挑走
	["标题", (s) => s.startsWith("title-") || ["beat-swap", "char-relay"].includes(s)],
];

function groupOf(id) {
	const s = id.replace(/^tfx-/, "");
	for (const [name, hit] of GROUPS) if (hit(s)) return name;
	return OTHER;
}

/** 先分组，再把不够 MIN_MEMBERS 的整组降级进「其他」。返回 id → 分类。 */
function assignCategories(ids) {
	const buckets = new Map();
	for (const id of ids) {
		const g = groupOf(id);
		if (!buckets.has(g)) buckets.set(g, []);
		buckets.get(g).push(id);
	}
	const out = new Map();
	for (const [name, members] of buckets) {
		const keep = name !== OTHER && members.length >= MIN_MEMBERS;
		for (const id of members) out.set(id, keep ? name : OTHER);
	}
	return out;
}

const items = [];
const blocksOut = resolve(arg("mirror", process.env.GITRUCK_TEXT_TEMPLATE_MIRROR_DIR?.trim() || MIRROR_DIR));
// 盘/父目录不在就停，别 mkdir 出一个无人会去取的影子镜像——
// 那种「跑完了、公网没变」的失败最难发现（表现是目录悄悄停在旧版本）。
if (!existsSync(dirname(blocksOut))) {
	console.error(`镜像目录的上级不存在：${dirname(blocksOut)}`);
	console.error(`  这通常是 T: 盘没挂上。换机器请用 --mirror <目录> 或 GITRUCK_TEXT_TEMPLATE_MIRROR_DIR。`);
	process.exit(2);
}
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

// 分类要看全量才能判「这组够不够 MIN_MEMBERS」，所以在收集完之后统一赋。
const categories = assignCategories(items.map((it) => it.id));
for (const it of items) it.category = categories.get(it.id) ?? OTHER;

// 自检：静默产一份分类超标/漏分的目录，在客户端那边只表现为「chip 怎么又变多了」，
// 没人会知道是哪一步放的水。宁可不产。
{
	const used = [...new Set(items.map((it) => it.category))];
	const missing = items.filter((it) => !it.category);
	if (missing.length) {
		console.error(`有 ${missing.length} 件没分到类：${missing.slice(0, 5).map((i) => i.id).join(", ")}`);
		process.exit(1);
	}
	if (used.length > MAX_CATEGORIES) {
		console.error(`分类 ${used.length} 个，超过上限 ${MAX_CATEGORIES}：${used.join(" / ")}`);
		console.error(`  调 GROUPS 或抬 MIN_MEMBERS（现 ${MIN_MEMBERS}），别抬上限。`);
		process.exit(1);
	}
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
// **次序有意义**：块在上面的循环里已经落地，这里先写不可变副本、最后才切 `catalog.json`——
// 指针是唯一的生效开关，落在最后，中途挂掉线上仍是上一版的自洽状态。
writeFileSync(join(blocksOut, `catalog-${version}.json`), json, "utf8");
writeFileSync(join(blocksOut, "catalog.json"), json, "utf8");

// opencut 的随包兜底是**同一份字节**（两仓各自打包，客户端三源不可达时顶上）。
// 原先靠人记得手工复制一次——这正是本线反复栽的那类坑：同一条规则落在两处、只改了一处。
// 所以在这里一并刷。仓不可达 **不** 静默跳过：那会让「我发了」与「客户端随包还是旧的」
// 悄悄分叉，而分叉只有在三源全断的极端场景才暴露，届时没人会想到是这里。
// 演练 / 换机可用 `--no-opencut` 明示放弃（明示的漏刷不是静默的漏刷）。
const skipOpencut = process.argv.includes("--no-opencut");
const ocRoot = arg("opencut", process.env.GTRK_OPENCUT_ROOT ?? "D:/file/gitruck-opencut-rewrite");
if (skipOpencut) {
	console.warn("⚠️ 按 --no-opencut 跳过随包兜底同步；opencut 那份仍是上一版");
} else {
	const ocDst = join(ocRoot, "apps", "web", "src", "data", "text-template-catalog.json");
	if (!existsSync(dirname(ocDst))) {
		console.error(`❌ opencut 随包目录不可达：${ocDst}`);
		console.error("   传 --opencut <仓根> 或设 GTRK_OPENCUT_ROOT；确实不想刷就传 --no-opencut");
		process.exit(1);
	}
	writeFileSync(ocDst, json, "utf8");
	if (readFileSync(ocDst, "utf8") !== json) {
		console.error("❌ 写完读回不一致——别当成功");
		process.exit(1);
	}
}

console.log(`目录 v${version}：${items.length} 件`);
console.log(`  随包兜底 → src/data/text-template-catalog.json`);
if (!skipOpencut) console.log(`  opencut  → ${join(ocRoot, "apps/web/src/data/text-template-catalog.json")}`);
console.log(`  镜像     → ${blocksOut}（即 ${MIRROR_ROOT}/，写完即生效）`);
console.log(`  ⚠️ 两仓的 CATALOG_COUNT / 件数用例会红——那是闸在响，同批改成 ${items.length}`);
