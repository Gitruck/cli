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
import { log } from "../lib/log";

// 仓库内打包分发的 skill 名（各含 SKILL.md；部分另带 references/ 或 agents/）
export const SKILL_NAMES = [
	"gtrk-oralcut",
	"gtrk-splitter",
	"gtrk-matrix",
	"gtrk-mg",
	"gtrk-ai-drama",
	"gtrk-style-maker",
	"gtrk-transcript",
	"gtrk-tools",
	"gtrk-music-visualizer",
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

function copySkillsToTarget(dir: string, source: string, targetLabel?: string): boolean {
	const destRoot = resolve(dir);
	let allOk = validateBundledSkills(source);
	for (const name of SKILL_NAMES) {
		const src = join(source, name);
		if (!existsSync(join(src, "SKILL.md"))) continue;
		const dest = join(destRoot, name);
		try {
			mkdirSync(dest, { recursive: true });
			cpSync(src, dest, { recursive: true });
			log.ok(`已安装 ${name}${targetLabel ? ` → ${targetLabel}` : ""}：${join(dest, "SKILL.md")}`);
		} catch (error) {
			allOk = false;
			log.warn(
				`skill 安装失败（${name}，不影响命令行使用）：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
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

export function registerSkills(program: Command): void {
	const skills = program.command("skills").description("管理跨 Agent Skills（通用适配器 + gtrk 补充宿主）");

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
