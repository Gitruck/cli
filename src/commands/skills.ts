/**
 * gtrk skills —— 把随包分发的 Agent Skills 安装到各类 Agent。
 *
 * 对齐 lark-cli：gtrk 只决定“安装哪一组 skill”，Agent 探测、目录映射和
 * symlink/junction 交给通用 `skills` CLI，避免在本仓维护一份会过期的宿主表。
 * `--dir` 保留为旧版兼容入口，显式指定时直接复制到该目录。
 */
import type { Command } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { packageRoot } from "../lib/paths";
import { log, routeLogsToStderr } from "../lib/log";
import { currentVersion } from "../lib/version";
import { appendStyleSkillEntry, type AppendStyleSkillResult, type StyleSkillEntry } from "../lib/column-config";
import { readUserConfig } from "../lib/user-config";
import {
	catalogSnapshotDate,
	formatHuman,
	isScene,
	isTechniqueEntry,
	listScenes,
	lookupByRepo,
	recommend,
	toJson,
	type CatalogProduces,
} from "../lib/third-party-catalog";
import {
	buildSkillManifest,
	detectStoreMode,
	listPackagedSkills,
	unifiedSkillStore,
	writeSkillManifest,
} from "../lib/skill-freshness";

// 仓库内打包分发的 skill 名（各含 SKILL.md；部分另带 references/ 或 agents/）
export const SKILL_NAMES = [
	"gtrk-oralcut",
	"gtrk-long2short",
	"gtrk-splitter",
	"gtrk-matrix",
	"gtrk-mg",
	"gtrk-ai-drama",
	"gtrk-style-maker",
	"gtrk-transcript",
	"gtrk-tools",
	"gtrk-music-visualizer",
	// 既有不一致修正（add-travel-recap-skill 顺带）：gtrk-cover 一直在磁盘却不在分发清单，README 宣称随包 11 个
	"gtrk-cover",
	// 第一张 structure 级组合图纸（add-travel-recap-skill）
	"gtrk-travel-recap",
	// 第三张 structure 级组合图纸（add-live-slicing-skill）：直播回放 → 一批粗剪工程
	"gtrk-live-slicing",
	// 第四张 structure 级组合图纸（add-talking-head-skill）：口播毛片 → 完整包装成片工程
	"gtrk-talking-head",
	// 解说链正本图纸（add-narration-skill）：素材自带时序 → 提炼看点重述成片
	"gtrk-narration",
	// 配音链快速成片预设（add-voiceover-skill）：稿 → 配音 → 配画面成片
	"gtrk-voiceover",
	// 解说链垂类示例（add-food-recap-skill）：探店/密着/做饭流程 → 美食解说成片
	"gtrk-food-recap",
	// Vlog 纪实类组合图纸（add-vlog-docu-skill）：现场同期声 × 后期旁白双声道交替 → 纪实成片工程；主理人 2026-09-10 拍板入清单
	"gtrk-vlog-docu",
] as const;

export interface InstallSkillOptions {
	/** 兼容旧参数：指定后绕过通用适配器，只写这个目录。 */
	dir?: string;
	/** 逗号或空格分隔的 skills CLI Agent ID；缺省为自动检测。 */
	agents?: string;
	/** 安装到 skills CLI 支持的全部 Agent。 */
	all?: boolean;
	/** 不创建链接，直接给每个 Agent 复制一份。 */
	copy?: boolean;
	/** 仅供嵌入调用/测试覆盖。 */
	source?: string;
	/** 仅供嵌入调用/测试覆盖。 */
	home?: string;
}

/**
 * 上游 skills CLI 尚未登记、但已有稳定全局 Skill 目录的宿主。
 * 这里只补缺口；已被上游支持的 Agent 继续由上游维护探测和目录映射。
 */
export const SUPPLEMENTAL_AGENTS = [
	{
		id: "workbuddy",
		displayName: "WorkBuddy",
		dataDir: ".workbuddy",
	},
	{
		id: "qoderwork",
		displayName: "QoderWork",
		dataDir: ".qoderwork",
	},
	{
		id: "comate",
		displayName: "Baidu Comate",
		dataDir: ".comate",
	},
] as const;

const SUPPLEMENTAL_AGENT_IDS = new Set<string>(SUPPLEMENTAL_AGENTS.map((agent) => agent.id));

/** 兼容旧参数和常见品牌写法；最终 ID 要么交给上游，要么命中本地补充层。 */
const AGENT_ALIASES: Readonly<Record<string, string>> = {
	claude: "claude-code",
	"trae-global": "trae",
	"tencent-workbuddy": "workbuddy",
	"qoder-work": "qoderwork",
	"baidu-comate": "comate",
	"wenxin-comate": "comate",
	qwen: "qwen-code",
	kimi: "kimi-code-cli",
	"kimi-code": "kimi-code-cli",
	iflow: "iflow-cli",
	codearts: "codearts-agent",
	"tongyi-lingma": "lingma",
	"tencent-codebuddy": "codebuddy",
};

// spawn 在 Windows 需要 shell 才能执行 npx.cmd；严格限制用户输入，避免 shell 元字符。
const SAFE_AGENT_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/gu;
const PROMPTSCRIPT_GLOBAL_ERROR =
	"PromptScript: PromptScript does not support global skill installation";

export interface AdapterOutputFilterResult {
	output: string;
	suppressedPromptScriptFailures: number;
}

export function parseAgentIds(input?: string): string[] {
	const values = (input ?? "")
		.split(/[\s,]+/u)
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean)
		.map((value) => AGENT_ALIASES[value] ?? value);

	const invalid = values.filter((value) => !SAFE_AGENT_ID.test(value));
	if (invalid.length > 0) {
		throw new Error(`Agent ID 格式不合法：${invalid.join(", ")}`);
	}
	return [...new Set(values)];
}

export interface AgentSelection {
	requested: string[];
	upstream: string[];
	supplemental: string[];
}

/** 把显式目标拆成上游注册表目标和 gtrk 补充目标，避免把未知 ID 传给上游而报错。 */
export function splitAgentSelection(input?: string): AgentSelection {
	const requested = parseAgentIds(input);
	return {
		requested,
		upstream: requested.filter((id) => !SUPPLEMENTAL_AGENT_IDS.has(id)),
		supplemental: requested.filter((id) => SUPPLEMENTAL_AGENT_IDS.has(id)),
	};
}

export interface SupplementalAgentTarget {
	id: string;
	displayName: string;
	destRoot: string;
}

/**
 * 缺省安装只补检测到的宿主；显式 --agents 和 --all 与上游行为一致，即使目录尚不存在也创建。
 */
export function resolveSupplementalAgentTargets(
	opts: Pick<InstallSkillOptions, "agents" | "all"> = {},
	home = homedir(),
	pathExists: (path: string) => boolean = existsSync,
): SupplementalAgentTarget[] {
	const selection = splitAgentSelection(opts.agents);
	const explicitIds = new Set(selection.supplemental);
	return SUPPLEMENTAL_AGENTS.filter((agent) => {
		if (opts.all) return true;
		if (selection.requested.length > 0) return explicitIds.has(agent.id);
		return pathExists(join(home, agent.dataDir));
	}).map((agent) => ({
		id: agent.id,
		displayName: agent.displayName,
		destRoot: join(home, agent.dataDir, "skills"),
	}));
}

function plainTerminalLine(line: string): string {
	return line.replace(ANSI_ESCAPE, "").trim();
}

/**
 * skills CLI 1.5.x 会把仅支持项目级安装的 PromptScript 隐式加入 `-g -y` 的
 * universal 目标，随后为每个 skill 打一条失败。其他 Agent 已成功且进程仍返回 0。
 * 只在失败块全部命中这一条已知问题时收起噪声；混合或未知失败完整保留。
 */
export function filterKnownAdapterOutput(output: string): AdapterOutputFilterResult {
	const newline = output.includes("\r\n") ? "\r\n" : "\n";
	const lines = output.split(/\r?\n/u);
	const failureStart = lines.findIndex((line) => plainTerminalLine(line).includes("Failed to install"));
	if (failureStart < 0) return { output, suppressedPromptScriptFailures: 0 };

	const doneIndex = lines.findIndex(
		(line, index) => index > failureStart && plainTerminalLine(line).includes("Done!"),
	);
	if (doneIndex < 0) return { output, suppressedPromptScriptFailures: 0 };

	const failureLines = lines
		.slice(failureStart, doneIndex)
		.map(plainTerminalLine)
		.filter((line) => line.includes("✗"));
	if (
		failureLines.length === 0 ||
		failureLines.some((line) => !line.includes(PROMPTSCRIPT_GLOBAL_ERROR))
	) {
		return { output, suppressedPromptScriptFailures: 0 };
	}

	// 一并移除失败块前后的空连接线，避免保留一个悬空的 `│`。
	let removeStart = failureStart;
	while (removeStart > 0) {
		const previous = plainTerminalLine(lines[removeStart - 1] ?? "");
		if (previous !== "" && previous !== "│" && previous !== "|") break;
		removeStart -= 1;
	}
	let removeEnd = doneIndex + 1;
	while (removeEnd < lines.length && plainTerminalLine(lines[removeEnd] ?? "") === "") {
		removeEnd += 1;
	}

	return {
		output: [...lines.slice(0, removeStart), ...lines.slice(removeEnd)].join(newline),
		suppressedPromptScriptFailures: failureLines.length,
	};
}

/** 构造与 lark-cli 相同思路的通用适配器命令参数。 */
export function buildSkillsAdapterArgs(
	source: string,
	opts: Pick<InstallSkillOptions, "agents" | "all" | "copy"> = {},
): string[] {
	const args = ["-y", "skills", "add", source, "-g", "-y"];
	if (opts.all) {
		args.push("--all");
	} else {
		for (const agent of splitAgentSelection(opts.agents).upstream) {
			args.push("--agent", agent);
		}
	}
	if (opts.copy) args.push("--copy");
	return args;
}

/**
 * 优先用当前 Node 直接执行 npx-cli.js：路径含空格时也无需经过 shell。
 * 找不到 npm 自带入口时才回落 PATH 中的 npx（Windows 的 npx.cmd 需要 shell）。
 */
function npxInvocation(args: string[]): { command: string; args: string[]; shell: boolean } {
	const npmExecPath = process.env.npm_execpath;
	const candidates = [
		npmExecPath && join(dirname(npmExecPath), "npx-cli.js"),
		join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
		resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
	].filter((value): value is string => Boolean(value));
	const npxCli = candidates.find((value) => existsSync(value));
	if (npxCli) return { command: process.execPath, args: [npxCli, ...args], shell: false };
	return { command: "npx", args, shell: process.platform === "win32" };
}

function validateBundledSkills(source: string): boolean {
	let allOk = true;
	for (const name of SKILL_NAMES) {
		const manifest = join(source, name, "SKILL.md");
		if (!existsSync(manifest)) {
			log.warn(`找不到打包的 skill 源：${manifest}（跳过 ${name}，不影响命令行）`);
			allOk = false;
		}
	}
	return allOk;
}

/**
 * 给一个已装存储写「一致性戳」（manifest：包版本 + 逐 skill 内容指纹/形状签名 + 安装时间）。
 *
 * 本轮只做 spec 的 ③ 过期检测：安装形态没动，统一存储仍是快照，
 * 戳的作用就是让**后续命令**能廉价判出「这份快照比包内正本旧了」。
 * 装了几个就戳几个（`names` 传实际落地的那一组），别把没装的写进去。
 * 写不进去 ⇒ 静默返回 false：那只意味着「日后核对判不出、静默跳过」，MUST NOT 打扰用户。
 */
function stampSkillStore(storeDir: string, source: string, names: readonly string[]): boolean {
	if (names.length === 0) return false;
	try {
		return writeSkillManifest(
			storeDir,
			buildSkillManifest({
				source,
				names,
				cliVersion: currentVersion(),
				mode: detectStoreMode(storeDir, source, names),
			}),
		);
	} catch {
		return false;
	}
}

function copySkillsToTarget(dir: string, source: string, targetLabel?: string): boolean {
	const destRoot = resolve(dir);
	let allOk = validateBundledSkills(source);
	const copied: string[] = [];
	for (const name of SKILL_NAMES) {
		const src = join(source, name);
		if (!existsSync(join(src, "SKILL.md"))) continue;
		const dest = join(destRoot, name);
		try {
			mkdirSync(dest, { recursive: true });
			cpSync(src, dest, { recursive: true });
			copied.push(name);
			log.ok(`已安装 ${name}${targetLabel ? ` → ${targetLabel}` : ""}：${join(dest, "SKILL.md")}`);
		} catch (error) {
			allOk = false;
			log.warn(
				`skill 安装失败（${name}，不影响命令行使用）：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	// 一致性戳：这一段是 cpSync 快照，装完即冻结；不留戳就没人能判断它有没有过期
	// （change fix-skill-install-staleness · 2026-09-04 真机事故）。写失败是良性降级，不打扰用户。
	stampSkillStore(destRoot, source, copied);
	if (targetLabel) {
		log.info(`已写入 ${targetLabel}；若当前会话未出现新 Skill，请重启或刷新该 Agent。`);
	} else {
		log.info("已写入自定义 skills 目录；具体调用入口以该 Agent 的界面为准。");
	}
	return allOk;
}

/** 兼容 `--dir`：不做 Agent 适配，直接把随包 skills 复制到用户指定目录。 */
export function copySkillsToDirectory(dir: string, source = join(packageRoot(), "skills")): boolean {
	return copySkillsToTarget(dir, source);
}

/**
 * 安装随包 skills。默认把本地包根交给上游 `skills` CLI：它负责发现宿主，
 * 以 ~/.agents/skills 为统一正本，并为各 Agent 创建 symlink / Windows junction。
 */
export function installSkill(opts: InstallSkillOptions = {}): boolean {
	// 只把随包 skills/ 交给发现器；开发仓根还可能有 .agents/skills 等项目工具，不能误装。
	const source = resolve(opts.source ?? join(packageRoot(), "skills"));
	if (opts.dir) return copySkillsToDirectory(opts.dir, source);

	let selection: AgentSelection;
	try {
		selection = splitAgentSelection(opts.agents);
	} catch (error) {
		log.err(error instanceof Error ? error.message : String(error));
		return false;
	}

	const sourcesOk = validateBundledSkills(source);
	const shouldRunAdapter = opts.all || selection.requested.length === 0 || selection.upstream.length > 0;
	let adapterOk = true;
	if (shouldRunAdapter) {
		const args = buildSkillsAdapterArgs(source, {
			...opts,
			agents: selection.upstream.join(","),
		});
		log.info("使用通用 Agent Skills 适配器：自动探测宿主、统一存储，并链接到各 Agent。");
		const invocation = npxInvocation(args);
		const result = spawnSync(invocation.command, invocation.args, {
			stdio: ["inherit", "pipe", "pipe"],
			shell: invocation.shell,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		const defaultAutoInstall = !opts.all && selection.requested.length === 0;
		const filtered = defaultAutoInstall
			? filterKnownAdapterOutput(result.stdout ?? "")
			: { output: result.stdout ?? "", suppressedPromptScriptFailures: 0 };
		if (filtered.output) {
			process.stdout.write(filtered.output);
			if (!filtered.output.endsWith("\n")) process.stdout.write("\n");
		}
		if (result.stderr) process.stderr.write(result.stderr);
		if (filtered.suppressedPromptScriptFailures > 0) {
			log.info("已跳过 PromptScript：它只支持项目级 Skill，不参与本次全局安装；其他 Agent 不受影响。");
		}

		if (result.error) {
			adapterOk = false;
			log.warn(`无法启动 skills 适配器：${result.error.message}`);
			log.info(`可手动重试：npx -y skills add "${source}" -g -y`);
		} else if (result.status !== 0) {
			adapterOk = false;
			log.warn(`skills 适配器安装失败（退出码 ${result.status ?? "未知"}）。`);
			log.info(`可查看支持的 Agent ID：npx -y skills add "${source}" --list`);
		}

		// 一致性戳：适配器把整个 source 目录交给它自己的发现器（凡带 SKILL.md 的目录都装），
		// 所以这里按**包里实际有什么**戳，而不是按 SKILL_NAMES —— 两者不一定同步
		// （在飞 change 新加的 skill 会先落磁盘、后进分发清单）。
		if (adapterOk) {
			stampSkillStore(unifiedSkillStore(opts.home ?? homedir()), source, listPackagedSkills(source));
		}
	}

	let supplementalOk = true;
	const supplementalTargets = resolveSupplementalAgentTargets(opts, opts.home ?? homedir());
	for (const target of supplementalTargets) {
		log.info(`使用 gtrk 补充适配：${target.displayName} → ${target.destRoot}`);
		if (!copySkillsToTarget(target.destRoot, source, target.displayName)) supplementalOk = false;
	}

	if (adapterOk && supplementalOk) {
		log.info("若当前会话没有立刻出现新 skill，请刷新窗口或新开一个会话。");
	}
	return sourcesOk && adapterOk && supplementalOk;
}

// ── 第三方 skill：推荐目录与安装登记（change add-third-party-skill-catalog）──────────────

const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const PRODUCES_VALUES: readonly CatalogProduces[] = ["MG", "AI_DRAMA", "FILM_BROLL", "A_ROLL", "script", "none"];

/** `gtrk skills recommend`：无场景列枚举；有场景按 tier 输出。人读恒走 stderr；`--json` 时 stdout 只有 JSON。 */
export function recommendSkills(opts: { scene?: string; json?: boolean } = {}): number {
	routeLogsToStderr();
	if (!opts.scene) {
		const scenes = listScenes();
		log.step(`第三方 skill 推荐目录（快照 ${catalogSnapshotDate()}，条目以仓库页为准）——按场景查：gtrk skills recommend --scene <id>`);
		for (const s of scenes) log.info(`${s.id.padEnd(13)} ${s.label}（${s.count} 条）`);
		if (opts.json) process.stdout.write(`${JSON.stringify(scenes, null, 2)}\n`);
		return 0;
	}
	if (!isScene(opts.scene)) {
		log.err(`未知场景「${opts.scene}」；合法场景：${listScenes().map((s) => s.id).join(" / ")}`);
		return 1;
	}
	const entries = recommend(opts.scene);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(toJson(entries), null, 2)}\n`);
		return 0;
	}
	log.step(`场景「${opts.scene}」推荐 ${entries.length} 条（快照 ${catalogSnapshotDate()}，star 与许可以仓库页为准；推荐是建议，装不装是你的选择）`);
	process.stderr.write(`${formatHuman(entries)}\n`);
	return 0;
}

export interface AddSkillOptions {
	skill?: string[];
	produces?: string;
	column?: string;
	agents?: string;
	all?: boolean;
	copy?: boolean;
	/** 仅供测试覆盖。 */
	columnsDir?: string;
	home?: string;
}

export interface AddSkillDeps {
	/** 透传上游 `skills add`；测试注入假实现。 */
	run?: (invocation: { command: string; args: string[]; shell: boolean }) => {
		status: number | null;
		stdout?: string;
		stderr?: string;
		error?: Error;
	};
	appendEntry?: typeof appendStyleSkillEntry;
	/** 缺省栏目 id 来源（config.json `defaultColumn`）；测试注入。 */
	defaultColumn?: () => string | undefined;
}

export interface AddSkillResult {
	ok: boolean;
	repo: string;
	columnId?: string;
	entries: StyleSkillEntry[];
	registrations: AppendStyleSkillResult[];
	/** 登记后的提示（车道绑定来源 / 技法族 / 未绑定），与人读日志同文；供测试与机读。 */
	notices: string[];
	reason?: string;
}

/** 上游 `skills add <owner/repo>` 的参数拼装：与随包安装同一条路，多 `--skill` 逐个透传。 */
export function buildThirdPartyAdapterArgs(
	repo: string,
	opts: Pick<AddSkillOptions, "skill" | "agents" | "all" | "copy"> = {},
): string[] {
	const args = ["-y", "skills", "add", repo, "-g", "-y"];
	for (const s of opts.skill ?? []) args.push("--skill", s);
	if (opts.all) {
		args.push("--all");
	} else {
		for (const agent of splitAgentSelection(opts.agents).upstream) args.push("--agent", agent);
	}
	if (opts.copy) args.push("--copy");
	return args;
}

/**
 * 决定登记条目的 produces / routing：显式 `--produces` > 目录值 > 管线外（routing:none）。
 * `script` / `none` 恒带 `routing:"none"`（spec：管线外产物不猜车道）。
 * `status` 取目录条目的 `origin`（一方 = "first-party"），无则 "third-party"；技法族（场景 technique）条目目录值即 none。
 */
export function resolveRegistration(
	repo: string,
	skills: string[],
	producesOpt?: string,
): { entries: StyleSkillEntry[]; fromCatalog: boolean; unbound: boolean; technique: boolean } {
	const cat = lookupByRepo(repo);
	const technique = Boolean(cat && isTechniqueEntry(cat));
	const status = cat?.origin ?? "third-party";
	const produces = (producesOpt ?? cat?.produces) as CatalogProduces | undefined;
	const names = skills.length > 0 ? skills : cat?.skills?.length ? [cat.skills[0]] : [repo.split("/")[1]];
	const entries: StyleSkillEntry[] = names.map((name) => {
		const e: StyleSkillEntry = { id: name, ref: `${repo}#${name}`, status };
		if (produces) {
			e.produces = produces;
			if (produces === "script" || produces === "none") e.routing = "none";
		} else {
			e.routing = "none";
		}
		return e;
	});
	return { entries, fromCatalog: !producesOpt && Boolean(cat?.produces), unbound: !produces, technique };
}

/** `gtrk skills add <owner/repo>`：透传上游安装 → 成功才登记进栏目配置 `style.skills`（追加、去重、失败不登记）。 */
export function addThirdPartySkill(repo: string, opts: AddSkillOptions = {}, deps: AddSkillDeps = {}): AddSkillResult {
	const fail = (reason: string): AddSkillResult => ({ ok: false, repo, entries: [], registrations: [], notices: [], reason });
	if (!REPO_SHAPE.test(repo)) return fail(`仓名格式应为 owner/repo：${repo}`);
	if (opts.produces !== undefined && !PRODUCES_VALUES.includes(opts.produces as CatalogProduces)) {
		return fail(`--produces 取值应为 ${PRODUCES_VALUES.join(" / ")}：${opts.produces}`);
	}
	let args: string[];
	try {
		args = buildThirdPartyAdapterArgs(repo, opts);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	const invocation = npxInvocation(args);
	const run =
		deps.run ??
		((inv) => {
			const r = spawnSync(inv.command, inv.args, {
				stdio: ["inherit", "pipe", "pipe"],
				shell: inv.shell,
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
			});
			return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
		});
	log.info(`透传通用 Agent Skills 适配器安装 ${repo}${opts.skill?.length ? `（skill：${opts.skill.join(", ")}）` : ""}`);
	const result = run(invocation);
	if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.error) return fail(`无法启动 skills 适配器：${result.error.message}`);
	if (result.status !== 0) return fail(`上游 skills 适配器安装失败（退出码 ${result.status ?? "未知"}），未登记`);

	const columnId = opts.column ?? (deps.defaultColumn ?? (() => readUserConfig().defaultColumn))() ?? "default";
	const { entries, fromCatalog, unbound, technique } = resolveRegistration(repo, opts.skill ?? [], opts.produces);
	const notices: string[] = [];
	const notice = (msg: string, level: "info" | "warn" = "info") => {
		notices.push(msg);
		log[level](msg);
	};
	const append = deps.appendEntry ?? appendStyleSkillEntry;
	const registrations: AppendStyleSkillResult[] = [];
	for (const entry of entries) {
		try {
			const r = append(entry, { columnId, columnsDir: opts.columnsDir });
			registrations.push(r);
			if (r.appended) log.ok(`已登记 ${entry.ref} → 栏目「${columnId}」${r.created ? "（新建配置文件）" : ""}：${r.path}`);
			else log.info(`已登记过 ${entry.ref}，未重复追加：${r.path}`);
		} catch (error) {
			return { ok: false, repo, columnId, entries, registrations, notices, reason: error instanceof Error ? error.message : String(error) };
		}
	}
	if (technique) {
		const lane = opts.produces;
		if (lane === undefined || lane === "none" || lane === "script") {
			notice("技法族条目：不绑车道（routing:none），/gtrk-mg 在 MG 步按槽位取用，不当 MG 生产 skill。");
		} else {
			notice(`目录记该仓为技法族（不绑车道），已按你的指定登记为 ${lane} 生产者——它会被当作本栏目 ${lane} 生产 skill 解析。`, "warn");
		}
	} else if (fromCatalog) {
		notice(`车道绑定取自推荐目录：produces=${entries[0]?.produces}`);
	}
	if (unbound) notice("未绑定车道（routing:none）；需要参与铺轨请用 --produces MG|AI_DRAMA|FILM_BROLL 指定。");
	if (!opts.column && columnId === "default") {
		log.info("未指定 --column 且 config.json 无 defaultColumn：已登记到栏目「default」；要让派单消费它，运行时传 --column default 或在 ~/.gitruck/config.json 设 defaultColumn。");
	}
	return { ok: true, repo, columnId, entries, registrations, notices };
}

export function registerSkills(program: Command): void {
	const skills = program.command("skills").description("管理跨 Agent Skills（通用适配器 + gtrk 补充宿主）");

	skills
		.command("recommend")
		.description("skill 推荐目录（第三方 + 一方技法族）：不带 --scene 列场景；--scene <id> 按场景给条目（用途 / 安装 / 许可 / 登记）。无状态、不联网")
		.option("--scene <id>", "场景 id：hook / mg-explainer / kinetic-text / data-viz / map / ai-drama / collage / caption / principles / technique（一方排版技法族）")
		.option("--json", "机读：stdout 只输出 JSON，人读转 stderr")
		.action((opts: { scene?: string; json?: boolean }) => {
			const code = recommendSkills(opts);
			if (code !== 0) process.exitCode = code;
		});

	skills
		.command("add <repo>")
		.description("安装第三方 skill（透传通用 skills 适配器）并登记进栏目配置 style.skills；repo 形如 owner/repo")
		.option("--skill <name>", "多 skill 仓只装指定 skill（可重复）", (v: string, prev: string[] = []) => [...prev, v], [])
		.option("--produces <lane>", "产物绑定车道：MG / AI_DRAMA / FILM_BROLL / A_ROLL / script / none（缺省取目录值，没有则 routing:none）")
		.option("--column <id>", "登记到哪个栏目（缺省 config.json 的 defaultColumn）")
		.option("--agents <list>", "指定 Agent ID，逗号分隔")
		.option("--all", "安装到全部已登记 Agent")
		.option("--copy", "每个 Agent 各复制一份")
		.action((repo: string, opts: AddSkillOptions) => {
			const r = addThirdPartySkill(repo, opts);
			if (!r.ok) {
				log.err(r.reason ?? "安装失败");
				process.exitCode = 1;
			}
		});

	skills
		.command("install")
		.description("把 gtrk 全家框架 skill 安装到自动检测或指定的 Agent")
		.option("--agents <list>", "指定 Agent ID，逗号分隔，如 codex,trae-cn,workbuddy,comate")
		.option("--all", "安装到上游和 gtrk 已登记的全部 Agent")
		.option("--copy", "每个 Agent 各复制一份（默认统一存储 + symlink/junction）")
		.option("--dir <dir>", "兼容模式：直接复制到单个 skills 目录，绕过 Agent 适配器")
		.action((opts: { agents?: string; all?: boolean; copy?: boolean; dir?: string }) => {
			if (!installSkill(opts)) process.exitCode = 1;
		});
}
