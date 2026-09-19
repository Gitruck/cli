#!/usr/bin/env node
/**
 * 测试期工作区零污染闸（change fix-test-workspace-pollution · capability `test-gate-discipline`）。
 *
 * ── 治什么 ──────────────────────────────────────────────────────────
 * 用例裸调「产物落点缺省为 **cwd 相对**」的被测入口时，产物会落进**仓库工作区**
 * （`npm test` 的 cwd = 仓根）。2026-09-19 实测：仓根长期挂着未跟踪的
 * `mg-render/proj-B06/`、`mg-render/proj-B07/`，内容全是假依赖的回声
 * —— 9 字节的 `mov-bytes`、`task_id: task-001`、`file_id: F999`，
 * 而 `task.json` 的 `source` 还指着早被 `rmSync` 删掉的临时夹具。
 *
 * 判据：一次 `npm test` 跑完后，仓库工作区 MUST 与跑之前**逐路径相同**。
 * 新增判红，消失也判红（用例删掉仓里的文件与写进仓里同级严重，主理人 2026-09-19 拍板）。
 *
 * ── ⚠️ 判据为什么是文件系统遍历，MUST NOT 换成 `git status` ────────────
 * `git status` 认 `.gitignore`。而本仓 `.gitignore` 里正躺着**五条同类污染的事后屏蔽**：
 * `/audio_tts_clone-…`、`/qc-verify-…`、`/anchor-verify-…`、`/.runs/`、`/*-out.json`
 * （前三条在 `.gitignore` 里是带通配的目录条目，这里按字面写会提前闭合本块注释，故省略号代之）
 * —— 都是「真机跑 CLI 时落在仓根的产物目录」。
 * 拿 git 当判据 ⇒ 这五类一律判绿，闸从第一天起就对自己要治的那堆历史堆积**天然失明**。
 * 遍历不认 `.gitignore`，于是「把它加进 `.gitignore` 了事」这条路在机器判据层面就走不通
 * —— 这正是主理人那条禁令（「那是把污染藏起来，不是修好」）的落法。**这段碑 MUST 留着。**
 *
 * ── 基线为什么取「跑前快照」而非「工作区必须干净」────────────────────
 * 开发机上本就会有别的线的未提交改动与临时件（立案当天就有云端字体库那条线的四个文件）。
 * 「跑前 vs 跑后」对差只判**本次测试造成的增量**，与工作区当下有什么无关，假阳性为零。
 *
 * ── 无旁路（照 add-artifact-landing-gate 裁决 D5：裁决即缺省）─────────
 * 本闸 MUST NOT 提供 `--force` / `--yes` / 环境变量 / `GTRK_SKIP` 之类跳过开关。
 * `test/workspace-pollution-gate.test.mjs` 有一条用例盯着这件事。
 *
 * 用法（已挂进 `package.json` 的 `test` 脚本首尾，别单独记）：
 *   node scripts/workspace-pollution-gate.mjs --snapshot   # 测试前
 *   node scripts/workspace-pollution-gate.mjs --verify     # 测试后
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_FILE = join(ROOT, ".test-build", "workspace-snapshot.txt");

/**
 * 不走的目录（按**目录名**匹配，任意深度）。三者都不是「工作区」语义，
 * 且 `.test-build/` 在一次 `npm test` 里本就由 esbuild 重写。
 * 快照文件自己也住在 `.test-build/`，故不会把自己算进增量。
 */
export const SKIP_DIRS = new Set([".git", "node_modules", ".test-build"]);

/**
 * 遍历 `root`，产**排序后的相对路径清单**（目录带尾随 `/`，分隔符恒 `/`）。
 * 只记路径，不记内容、不记 mtime —— 本闸判的是「有没有多/少东西」，不是「改没改」
 * （工作区里别的线正在改文件是常态，那不归本闸管）。
 *
 * 符号链接**不跟随**：`Dirent.isDirectory()` 走 lstat 语义，对 symlink 恒 false，
 * 于是它只作为一条路径被记下、不会被递归进去（`gtrk skills install` 会造 symlink）。
 */
export function snapshotTree(root, skip = SKIP_DIRS) {
	const out = [];
	const walk = (abs) => {
		let entries;
		try {
			entries = readdirSync(abs, { withFileTypes: true });
		} catch {
			return; // 读不动的目录（权限 / 竞态删除）不算污染，跳过
		}
		for (const e of entries) {
			const isDir = e.isDirectory();
			if (isDir && skip.has(e.name)) continue;
			const abspath = join(abs, e.name);
			const rel = relative(root, abspath).split(sep).join("/");
			out.push(isDir ? `${rel}/` : rel);
			if (isDir) walk(abspath);
		}
	};
	walk(root);
	return out.sort();
}

/** 两份清单对差。`added` = 跑后多出来的，`removed` = 跑后少掉的。 */
export function diffSnapshots(before, after) {
	const b = new Set(before);
	const a = new Set(after);
	return {
		added: after.filter((p) => !b.has(p)),
		removed: before.filter((p) => !a.has(p)),
	};
}

/**
 * 失败文案（纯函数，供单测直接比对措辞）。
 *
 * ⚠️ 两个分支**各自成句**，MUST NOT 抽成一段泛化模板：
 * 「写进来了」的正解是给落点，「被删掉了」的正解是别在仓里就地改 —— 套错了就是废话。
 * （起草时共用一段，实测 §5.4 打出来的是「给个临时目录当落点」，对着一条被删的 README 说。）
 */
export function formatViolation({ added, removed }) {
	const lines = ["", "❌ 测试污染了仓库工作区 —— 跑完之后它与跑之前不一致。", ""];
	if (added.length) {
		lines.push(`  新增 ${added.length} 条路径（用例把产物写进了仓里）：`);
		for (const p of added) lines.push(`    + ${p}`);
		lines.push(
			"",
			'  正解：给对应的被测入口显式传一个**临时目录**当落点（如 `out: join(dir, "out")`），',
			"  随夹具一起 rmSync 清掉。落点缺省为 cwd 相对是**产品的正确行为**",
			"  （用户在自己工作目录跑命令就该落 ./<产物目录>/），MUST NOT 为迁就测试去改它。",
			"",
			"  ⚠️ MUST NOT 把这些路径加进 .gitignore 当作修复 —— 那只让 git status 闭嘴，",
			"  产物照旧写进工作区，而且本闸不认 .gitignore，加了也照红。",
			"",
		);
	}
	if (removed.length) {
		lines.push(`  消失 ${removed.length} 条路径（用例删掉了仓里既有的东西）：`);
		for (const p of removed) lines.push(`    - ${p}`);
		lines.push(
			"",
			"  正解：用例要改/删文件时，先把它**拷进临时目录**再动，MUST NOT 就地改仓里的正本。",
			"  先 `git checkout -- <上面这些路径>` 复原，再去找那条动了仓内文件的用例。",
			"",
		);
	}
	return lines.join("\n");
}

/**
 * 是否**直接执行本文件**（而非被 import）。
 * 判据是 argv[1] 与本文件路径逐字相等 —— MUST NOT 用 `argv[1].includes("workspace-pollution-gate")`：
 * `node --test` 会把**测试文件**的路径放进 argv[1]，而它叫 `workspace-pollution-gate.test.mjs`，
 * 子串判法会在自测里误判成「直接执行」，当场打用法 + 置 exitCode=2 把测试弄红（起草时踩过）。
 */
const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const MODE = invokedDirectly ? process.argv[2] : undefined;

if (!invokedDirectly) {
	// 作为模块被 import：只导出纯函数，不做任何副作用。
} else if (MODE === "--snapshot") {
	mkdirSync(dirname(SNAPSHOT_FILE), { recursive: true });
	writeFileSync(SNAPSHOT_FILE, `${snapshotTree(ROOT).join("\n")}\n`, "utf8");
} else if (MODE === "--verify") {
	let before;
	try {
		before = readFileSync(SNAPSHOT_FILE, "utf8").split("\n").filter(Boolean);
	} catch {
		// 禁静默兜底：读不到跑前快照就无法判定，MUST NOT 当绿放行。
		console.error(
			`\n❌ 工作区零污染闸：读不到跑前快照（${relative(ROOT, SNAPSHOT_FILE).split(sep).join("/")}）。\n` +
				"   它由 `npm test` 链首的 `--snapshot` 写；单独跑 `--verify` 没有判定依据。\n" +
				"   跑 `npm test` 走完整条链，别只跑后半截。\n",
		);
		process.exitCode = 1;
	}
	if (before) {
		const d = diffSnapshots(before, snapshotTree(ROOT));
		if (d.added.length || d.removed.length) {
			console.error(formatViolation(d));
			process.exitCode = 1;
		}
	}
} else {
	// 直接执行但参数不认识 —— 报用法而不是静默什么都不做。
	console.error("用法：node scripts/workspace-pollution-gate.mjs --snapshot | --verify");
	process.exitCode = 2;
}
