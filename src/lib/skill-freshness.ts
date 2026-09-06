/**
 * skill 新鲜度（change fix-skill-install-staleness · skill-install-freshness spec）。
 *
 * **本轮只做 spec 的第 ③ 层「过期检测」**：①（默认软链到包内）②（安装形态改造）未做，
 * 故当前默认安装形态仍是「统一存储快照 + 各 Agent symlink」，本模块负责让这个快照
 * **可观测**——2026-09-04 真机事故里，主理人机器上五个 skill 全部停在 43 天前，
 * 而全链没有任何一处会告诉他「你读到的是旧快照」。
 *
 * ── 两种指纹，用途不同（这是本模块最容易被误读的地方）──────────────────
 *
 *  ① `fingerprintSkillDir()` **内容指纹**：目录下全部文件**内容**的稳定哈希。
 *     MUST 与文件遍历顺序无关（排序后再喂哈希）、MUST 忽略 mtime（全程不取时间戳）。
 *     只在 **install 时**算一次（那时本来就在读/拷文件，零额外成本），写进 manifest。
 *  ② `shapeSkillDir()` **形状签名**：只 `readdir` + `stat`（路径 + 字节数），**不读正文**。
 *     供**每条命令**的廉价核对使用 —— spec 明令「MUST NOT 遍历读取全部 skill 正文」。
 *
 *  核对时比的是 ②：把 manifest 里记的「装的时候源是什么形状」和「源现在是什么形状」对一下。
 *  比的两边都是**包内源**，不碰已装副本 —— 副本可能在符号链接后面、可能在别的盘。
 *  **已知取舍**：形状签名对「字节数不变的改动」不敏感（改一个等长的字），
 *  这是为了守住「不读正文」这条硬约束付的代价；真机事故那种 472→111 行的漂移必被抓住。
 *  要精确到内容，走 {@link verifySkillFingerprints}（贵，只给 doctor 这类低频命令用）。
 *
 * ── 零噪音是硬要求 ────────────────────────────────────────────────
 *
 *  skill 过期是**罕见事件**。用高频提示覆盖低频事件，用户会脱敏，真正该看的那次也被划过去
 *  （proposal 明确否掉了「每次执行都提醒更新 CLI」这个方案）。故：
 *   - 一致 ⇒ **一个字都不输出**；
 *   - manifest 缺失 / 损坏 / 任何异常 ⇒ **静默跳过**，MUST NOT 拦路、MUST NOT 抛给上游；
 *   - 只在**需要 skill 的命令**上核对（{@link SKILL_FRESHNESS_COMMANDS}），
 *     `doctor` / `tool` / `deps` 这类不读 skill 的命令不提示。
 *
 *  修复命令 **MUST 是 `gtrk skills install`**（或 `gtrk upgrade`）。
 *  **MUST NOT 写 `npm i -g`** —— npm 更新只换包、不刷已装 skill，照它做的用户会以为修好了
 *  而实际没有；那正是本次事故的认知根源。
 *
 * **零网络往返**：全部是本地文件系统操作，断网照常可用。
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./paths";

/** manifest 文件名。落在**已装 skill 的同一存储目录**下（spec 要求），点开头避免被 Agent 当 skill 扫。 */
export const SKILL_MANIFEST_FILENAME = ".gtrk-skills.json";

/** 关闭开关（环境变量）。取 `0` / `off` / `false` / `no` 即整块静默。 */
export const SKILL_FRESHNESS_ENV = "GTRK_SKILL_FRESHNESS";

/** 修复命令**全仓单一副本**：提示文案与 doctor 详情共用，防两处写法漂移。 */
export const SKILL_FRESHNESS_FIX_COMMAND = "gtrk skills install";

/**
 * 做核对的命令**白名单**（0.2 拍板值：只在需要 skill 的命令上做）。
 * 刻意用白名单而非黑名单：新增命令默认**不提示**，零噪音优先——
 * 漏提示只是少一次提醒，误提示是实打实的噪音污染。
 */
export const SKILL_FRESHNESS_COMMANDS: readonly string[] = [
	"oralcut",
	"long2short",
	"split",
	"matrix",
	"mg",
	"subtitle",
	"project",
];

/** 提示里最多点名几个 skill（其余折成「等 N 个」）——agent 上下文是稀缺资源。 */
const MAX_NAMED_SKILLS = 4;

// ── 目录遍历与指纹 ────────────────────────────────────────────────

/**
 * 目录下全部普通文件的相对路径（posix 分隔符），**已排序**。
 * 排序是「与遍历顺序无关」这条硬要求的落点：不同平台 / 不同文件系统的 readdir 顺序不一致。
 * 不跟进符号链接的子目录（防环，且软链形态另有判定路径）。manifest 自身不参与指纹。
 */
function walkRelFiles(dir: string): string[] {
	const out: string[] = [];
	const rec = (cur: string, prefix: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(cur, { withFileTypes: true });
		} catch {
			return; // 读不动就当空，交由上层判 null
		}
		for (const entry of entries) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) rec(join(cur, entry.name), rel);
			else if (entry.isFile() && rel !== SKILL_MANIFEST_FILENAME) out.push(rel);
		}
	};
	rec(dir, "");
	return out.sort();
}

/**
 * **内容指纹**：目录下全部文件内容的稳定哈希。
 * MUST 与文件遍历顺序无关（排序后逐条喂）、MUST 忽略 mtime（全程不读时间戳）。
 * 目录不存在 / 空 / 读不出 ⇒ null（调用方按「不可判定」处理，MUST NOT 当作不一致）。
 */
export function fingerprintSkillDir(dir: string): string | null {
	const rels = walkRelFiles(dir);
	if (rels.length === 0) return null;
	const hash = createHash("sha256");
	for (const rel of rels) {
		let buf: Buffer;
		try {
			buf = readFileSync(join(dir, rel));
		} catch {
			return null;
		}
		hash.update(rel, "utf8");
		hash.update("\0");
		hash.update(createHash("sha256").update(buf).digest("hex"), "utf8");
		hash.update("\n");
	}
	return hash.digest("hex");
}

/**
 * **形状签名**：只 readdir + stat（相对路径 + 字节数），**不读任何文件正文**。
 * 这是每条命令都会跑的那一次核对所用的信号——spec 的「廉价」与「MUST NOT 读正文」两条同时满足。
 * 同样与遍历顺序无关、同样不取 mtime。
 */
export function shapeSkillDir(dir: string): string | null {
	const rels = walkRelFiles(dir);
	if (rels.length === 0) return null;
	const hash = createHash("sha256");
	for (const rel of rels) {
		let size: number;
		try {
			size = statSync(join(dir, rel)).size;
		} catch {
			return null;
		}
		hash.update(`${rel}:${size}\n`, "utf8");
	}
	return hash.digest("hex").slice(0, 32);
}

/** 包内 `skills/` 下真正带 SKILL.md 的目录名（= 通用适配器实际会装的那一组），已排序。 */
export function listPackagedSkills(source: string): string[] {
	try {
		return readdirSync(source, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => entry.name)
			.filter((name) => existsSync(join(source, name, "SKILL.md")))
			.sort();
	} catch {
		return [];
	}
}

/** 包内 skill 源目录（`<packageRoot>/skills`）。 */
export function packagedSkillsDir(): string {
	return join(packageRoot(), "skills");
}

// ── manifest ────────────────────────────────────────────────────

export interface SkillManifestEntry {
	/** 内容指纹（install 时算，见文件头 ①）。 */
	fp: string;
	/** 形状签名（廉价核对比的就是它，见文件头 ②）。 */
	shape: string;
}

export interface SkillManifest {
	schema: 1;
	/** 装的时候的 CLI 包版本（只用于提示文案，**不作为过期判据**——同版本改内容也要能抓）。 */
	cliVersion: string;
	/** 安装时间（ISO 8601）。 */
	installedAt: string;
	/** `copy` = 装完即冻结的快照，需要核对；`link` = 随包跟随，恒新鲜。 */
	mode: "copy" | "link";
	/** 装的时候的包内源目录（只用于排障展示，**不作为过期判据**：换安装方式不等于内容变了）。 */
	source: string;
	skills: Record<string, SkillManifestEntry>;
}

export interface BuildManifestOptions {
	source: string;
	names: readonly string[];
	cliVersion: string;
	mode?: "copy" | "link";
	now?: Date;
}

/** 按当前包内源算一份 manifest（内容指纹 + 形状签名各一）。源里没有的 skill 直接略过。 */
export function buildSkillManifest(opts: BuildManifestOptions): SkillManifest {
	const skills: Record<string, SkillManifestEntry> = {};
	for (const name of opts.names) {
		const dir = join(opts.source, name);
		const fp = fingerprintSkillDir(dir);
		const shape = shapeSkillDir(dir);
		if (!fp || !shape) continue;
		skills[name] = { fp, shape };
	}
	return {
		schema: 1,
		cliVersion: opts.cliVersion,
		installedAt: (opts.now ?? new Date()).toISOString(),
		mode: opts.mode ?? "copy",
		source: opts.source,
		skills,
	};
}

/** 写 manifest 到已装存储。**永不抛**：写不进去只是「日后核对判不出、静默跳过」，不是执行障碍。 */
export function writeSkillManifest(storeDir: string, manifest: SkillManifest): boolean {
	try {
		mkdirSync(storeDir, { recursive: true });
		writeFileSync(join(storeDir, SKILL_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** 读并粗校验 manifest。**永不抛**；缺失 / 损坏 / 字段不对 ⇒ null（= 不可判定 ⇒ 静默跳过）。 */
export function readSkillManifest(storeDir: string): SkillManifest | null {
	try {
		const raw = readFileSync(join(storeDir, SKILL_MANIFEST_FILENAME), "utf8");
		const parsed = JSON.parse(raw) as Partial<SkillManifest>;
		if (!parsed || typeof parsed !== "object") return null;
		if (parsed.schema !== 1) return null;
		if (!parsed.skills || typeof parsed.skills !== "object") return null;
		const skills: Record<string, SkillManifestEntry> = {};
		for (const [name, entry] of Object.entries(parsed.skills)) {
			if (!entry || typeof entry !== "object") continue;
			const { fp, shape } = entry as Partial<SkillManifestEntry>;
			if (typeof fp !== "string" || typeof shape !== "string") continue;
			skills[name] = { fp, shape };
		}
		return {
			schema: 1,
			cliVersion: typeof parsed.cliVersion === "string" ? parsed.cliVersion : "",
			installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : "",
			mode: parsed.mode === "link" ? "link" : "copy",
			source: typeof parsed.source === "string" ? parsed.source : "",
			skills,
		};
	} catch {
		return null;
	}
}

/**
 * 判定某个存储是「快照拷贝」还是「软链到包内」。
 * 本轮 ① 未落地，默认恒为 copy；但用户可能自己跑过上游 `skills add`（链接模式），
 * 那种情况下已装内容随包跟随，**必须判成 link**，否则每次都误报落后 —— 零噪音是硬要求。
 */
export function detectStoreMode(storeDir: string, source: string, names: readonly string[]): "copy" | "link" {
	try {
		const realSource = realpathSync(source);
		for (const name of names) {
			const entry = join(storeDir, name);
			if (!existsSync(entry)) continue;
			// realpath 已把 symlink / junction 解到底：解回包内那一份 ⇒ 随包跟随
			return realpathSync(entry) === join(realSource, name) ? "link" : "copy";
		}
	} catch {
		/* 判不出按快照处理：核对多做一次总比漏报强 */
	}
	return "copy";
}

// ── 核对 ─────────────────────────────────────────────────────────

export type SkillFreshnessState = "unknown" | "fresh" | "stale";

export interface SkillFreshnessResult {
	state: SkillFreshnessState;
	/** 命中的已装存储目录（unknown 时为空）。 */
	storeDir?: string;
	manifest?: SkillManifest;
	/** 指纹已漂的 skill 名（升序）。 */
	stale: string[];
	/** 包里有、manifest 里没有 —— 上次安装之后新加的 skill，Agent 根本读不到。 */
	missing: string[];
	/** unknown 的可读原因（只给 doctor 展示用，不进过期提示）。 */
	reason?: string;
}

export interface CheckFreshnessOptions {
	/** 包内源目录，缺省 `<packageRoot>/skills`。 */
	source?: string;
	/** 已装存储候选，缺省 `~/.agents/skills`（通用适配器的统一正本，各 Agent 由它软链出去）。 */
	stores?: string[];
	home?: string;
}

/**
 * 通用适配器的**统一正本**目录 `~/.agents/skills`：各 Agent 的 skill 目录都是指向这里的
 * symlink / junction，所以只要盯住这一份就等于盯住了所有 Agent 读到的内容。
 * 补充宿主（workbuddy / qoderwork / comate）那几份独立拷贝也会被戳上 manifest，
 * 但**不进核对候选** —— 它们是小众兜底路径，纳入只会增加误报面。
 */
export function unifiedSkillStore(home = homedir()): string {
	return join(home, ".agents", "skills");
}

/** 默认已装存储候选。 */
export function defaultStoreDirs(home = homedir()): string[] {
	return [unifiedSkillStore(home)];
}

/**
 * 廉价新鲜度核对：读 manifest 比形状签名。
 * **MUST NOT 读 skill 正文、MUST NOT 联网**；异常一律吞掉走 unknown（静默跳过、不拦路）。
 */
export function checkSkillFreshness(opts: CheckFreshnessOptions = {}): SkillFreshnessResult {
	try {
		const source = opts.source ?? packagedSkillsDir();
		const stores = opts.stores ?? defaultStoreDirs(opts.home);
		for (const store of stores) {
			const manifest = readSkillManifest(store);
			if (!manifest) continue;
			// 软链形态随包跟随，恒新鲜，连形状都不必算
			if (manifest.mode === "link") {
				return { state: "fresh", storeDir: store, manifest, stale: [], missing: [] };
			}
			const stale: string[] = [];
			for (const [name, entry] of Object.entries(manifest.skills)) {
				const shape = shapeSkillDir(join(source, name));
				if (!shape) continue; // 包里读不出这个 skill：不可判定，MUST NOT 当成落后
				if (shape !== entry.shape) stale.push(name);
			}
			const missing = listPackagedSkills(source).filter((name) => !(name in manifest.skills));
			return {
				state: stale.length + missing.length > 0 ? "stale" : "fresh",
				storeDir: store,
				manifest,
				stale: stale.sort(),
				missing,
			};
		}
		return { state: "unknown", stale: [], missing: [], reason: "没找到 skill 安装 manifest（还没用本版 gtrk 装过 skill）" };
	} catch (error) {
		return {
			state: "unknown",
			stale: [],
			missing: [],
			reason: `核对跳过：${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * **精确**核对（内容指纹，会读全部 skill 正文）。
 * 只给 `gtrk doctor` 这类低频、用户显式发起的命令用；**MUST NOT** 挂到普通命令的执行路径上。
 */
export function verifySkillFingerprints(opts: CheckFreshnessOptions = {}): string[] {
	const source = opts.source ?? packagedSkillsDir();
	const stores = opts.stores ?? defaultStoreDirs(opts.home);
	for (const store of stores) {
		const manifest = readSkillManifest(store);
		if (!manifest || manifest.mode === "link") continue;
		const drifted: string[] = [];
		for (const [name, entry] of Object.entries(manifest.skills)) {
			const fp = fingerprintSkillDir(join(source, name));
			if (fp && fp !== entry.fp) drifted.push(name);
		}
		return drifted.sort();
	}
	return [];
}

// ── 提示 ─────────────────────────────────────────────────────────

/** 安装时间显示成 `YYYY-MM-DD`；解析不了就原样回显（排障时原文比空白有用）。 */
function shortDate(iso: string): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return iso || "未知时间";
	return new Date(t).toISOString().slice(0, 10);
}

function nameList(names: string[]): string {
	if (names.length <= MAX_NAMED_SKILLS) return names.join("、");
	return `${names.slice(0, MAX_NAMED_SKILLS).join("、")} 等 ${names.length} 个`;
}

/**
 * 过期提示文案（纯文本、无 ANSI；着色在输出处做）。**一致 / 不可判定时返回空数组**。
 * MUST 含：落后的 skill 名与数量、安装时间与当时版本、准确的修复命令。
 * MUST NOT 含 `npm i -g`：那条路只换包不刷 skill，是本次事故的认知根源。
 */
export function skillFreshnessNoticeLines(result: SkillFreshnessResult): string[] {
	if (result.state !== "stale") return [];
	const drifted = result.stale;
	const added = result.missing;
	const total = drifted.length + added.length;
	const when = shortDate(result.manifest?.installedAt ?? "");
	const ver = result.manifest?.cliVersion ? `当时 v${result.manifest.cliVersion}` : "版本未记录";
	const lines = [`⚠️ 已装的 gtrk skill 落后于当前 CLI 包：共 ${total} 个（上次安装 ${when}，${ver}）`];
	if (drifted.length > 0) lines.push(`   内容已变：${nameList(drifted)}`);
	if (added.length > 0) lines.push(`   还没装上：${nameList(added)}`);
	lines.push(`   修复：${SKILL_FRESHNESS_FIX_COMMAND}（或 gtrk upgrade）—— 只更新 CLI 包并不会刷新已装 skill`);
	lines.push(`   不想看这条：设环境变量 ${SKILL_FRESHNESS_ENV}=off`);
	return lines;
}

/** 关闭开关判定。 */
export function isSkillFreshnessDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = (env[SKILL_FRESHNESS_ENV] ?? "").trim().toLowerCase();
	return value === "0" || value === "off" || value === "false" || value === "no";
}

/** 该命令是否需要核对（白名单，见 {@link SKILL_FRESHNESS_COMMANDS}）。 */
export function needsSkillFreshnessCheck(command?: string): boolean {
	return !!command && SKILL_FRESHNESS_COMMANDS.includes(command);
}

/**
 * 进程内「已打印过」标记：一次运行最多提示一次（子命令嵌套 / 多处收口都只出一遍）。
 * 刻意**不**做跨进程留痕——过期状态会一直存在直到用户重装，每次都该看见；
 * 而首跑指路那种「一辈子只说一次」的事才需要留痕。
 */
let printedInThisProcess = false;

/** 仅供单测：重置进程内标记（生产代码不该调）。 */
export function resetSkillFreshnessProcessState(): void {
	printedInThisProcess = false;
}

export interface SkillFreshnessNoticeOptions extends CheckFreshnessOptions {
	/** 顶层命令名（`gtrk matrix search` ⇒ `matrix`）。 */
	command?: string;
	/** 输出通道，缺省 process.stderr。**恒 stderr**，与是否 `--json` 无关。 */
	write?: (chunk: string) => void;
	env?: NodeJS.ProcessEnv;
	/** 仅供单测注入核对结果。 */
	check?: (opts: CheckFreshnessOptions) => SkillFreshnessResult;
}

/**
 * 挂在 CLI 入口一处收口的过期提示。返回是否真的打印了。
 *
 * 四道闸，任何一道不过就**零输出**：开关关掉 / 命令不在白名单 / 本进程已打过 / 核对结果不是 stale。
 * 整个函数**永不抛**——它是搭在所有命令前面的钩子，出任何岔子都 MUST NOT 拦路。
 */
export function skillFreshnessNoticeOnce(opts: SkillFreshnessNoticeOptions = {}): boolean {
	try {
		if (isSkillFreshnessDisabled(opts.env ?? process.env)) return false;
		if (!needsSkillFreshnessCheck(opts.command)) return false;
		if (printedInThisProcess) return false;

		const result = (opts.check ?? checkSkillFreshness)({
			source: opts.source,
			stores: opts.stores,
			home: opts.home,
		});
		const lines = skillFreshnessNoticeLines(result);
		if (lines.length === 0) return false; // 一致 / 不可判定 ⇒ 一个字都不输出

		const write = opts.write ?? ((chunk: string) => void process.stderr.write(chunk));
		const [head, ...rest] = lines;
		write(`\x1b[33m${head}\x1b[0m\n${rest.length > 0 ? `\x1b[2m${rest.join("\n")}\x1b[0m\n` : ""}`);
		printedInThisProcess = true;
		return true;
	} catch {
		return false; // 核对失败 SHALL 静默跳过、MUST NOT 拦路
	}
}

/**
 * 给 `gtrk doctor` 用的一行状态（本轮**未接线**：doctor.ts 在本 change 的射程外，
 * 见 tasks.md 1.5 的说明）。接线时一行 `rows.push({ name: "Skill 新鲜度", ...detail })` 即可。
 */
export function skillFreshnessDoctorRow(opts: CheckFreshnessOptions = {}): {
	name: string;
	status: "ok" | "warn";
	detail: string;
} {
	const result = checkSkillFreshness(opts);
	if (result.state === "stale") {
		const total = result.stale.length + result.missing.length;
		return {
			name: "Skill 新鲜度",
			status: "warn",
			detail: `${total} 个已装 skill 落后（上次安装 ${shortDate(result.manifest?.installedAt ?? "")}）—— 跑 ${SKILL_FRESHNESS_FIX_COMMAND}`,
		};
	}
	if (result.state === "fresh") {
		const when = shortDate(result.manifest?.installedAt ?? "");
		const mode = result.manifest?.mode === "link" ? "软链随包跟随" : `快照，装于 ${when}`;
		return { name: "Skill 新鲜度", status: "ok", detail: `与当前包一致（${mode}）` };
	}
	return { name: "Skill 新鲜度", status: "ok", detail: result.reason ?? "无法判定（不影响使用）" };
}
