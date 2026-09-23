/**
 * 命令可达性的底座（change add-gtrk-command-availability · gtrk-command-availability spec）：
 *   ① 按 PATH 解析可执行体——**目录外层、后缀内层**（Windows `exe/bat/cmd`），与 cmd.exe 及
 *      opencut 仓 `resolve_in_path` 同序，两侧对「谁被敲到」说法一致；
 *   ② 读**持久** PATH（Windows = 注册表 HKLM + HKCU 的 `Path` 合并展开；POSIX 退回进程 PATH）——
 *      进程 PATH 是启动它的终端给的，从一个碰巧带 npm 目录的终端里跑会假绿；
 *   ③ 启动器目录算法（npm 全局形态 / `~/.gitruck` 私有形态）与目录归一化比对。
 *
 * 🔴 Windows 读注册表走 PowerShell 的 .NET 注册表 API 而不是 `reg.exe`：`reg query` 的输出按 OEM 代码页
 *    （中文机是 GBK）吐，含中文用户名的目录会被 utf8 解成乱码进而判「不在 PATH」；PowerShell 侧把
 *    控制台编码钉成 UTF-8 并按 `DoNotExpandEnvironmentNames` 取**原值**（`%…%` 不展开），类型一并带回。
 * 全部 I/O 经可注入的 `deps`，单测零真实注册表、零子进程。
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { posix, win32, sep } from "node:path";
import { gitruckHome } from "./paths";

/** Windows 可执行后缀候选，序同 `PATHEXT` 默认值里这三项的相对次序（`.EXE` 先于 `.BAT`/`.CMD`）。 */
export const WIN_EXEC_EXTS: readonly string[] = ["exe", "bat", "cmd"];

export type RegKind = "ExpandString" | "String" | string;

/** 注册表 `Path` 值的原样读数：`kind`/`value` 同为 null 表示该值不存在。 */
export interface RegPathValue {
	kind: RegKind | null;
	value: string | null;
}

export interface CommandPathDeps {
	platform?: string;
	env?: Record<string, string | undefined>;
	/** `statSync(p).isFile()` 的可注入替身。 */
	isFile?: (p: string) => boolean;
	/** 读注册表 `Path`（Windows）。缺省真读；测试注入。 */
	readRegPath?: (hive: "HKLM" | "HKCU") => RegPathValue;
	/** `npm prefix -g` 的可注入替身；返 null 表示拿不到。 */
	npmGlobalPrefix?: () => string | null;
	/** `~/.gitruck` 基址（测试注入）。 */
	home?: string;
}

const isWin = (platform: string) => platform === "win32";

/** 按目标平台选 path 实现：纯函数在任何宿主上对任何平台的路径都算得对（测试在 Windows 上跑 POSIX 用例）。 */
export function pathFor(platform: string): typeof posix | typeof win32 {
	return isWin(platform) ? win32 : posix;
}

function defaultIsFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

/**
 * 按 PATH 解析一个可执行体：目录外层、后缀内层，第一个命中的文件即返回。
 * 纯函数（目录表与 `isFile` 都注入）。POSIX 传 `exts=[]`（无后缀）。
 */
export function resolveOnPath(
	stem: string,
	dirs: readonly string[],
	exts: readonly string[],
	isFile: (p: string) => boolean = defaultIsFile,
	platform: string = process.platform,
): string | null {
	const P = pathFor(platform);
	for (const dir of dirs) {
		if (!dir) continue;
		const candidates = exts.length ? exts.map((e) => P.join(dir, `${stem}.${e}`)) : [P.join(dir, stem)];
		for (const c of candidates) if (isFile(c)) return c;
	}
	return null;
}

/** 平台专属的后缀表：Windows 三后缀，POSIX 无后缀。 */
export function execExtsFor(platform: string): readonly string[] {
	return isWin(platform) ? WIN_EXEC_EXTS : [];
}

/** 拆 PATH 列表：Windows 按 `;`，POSIX 按 `:`；去空项、去首尾空白与包裹引号。 */
export function splitPathList(value: string | null | undefined, platform: string): string[] {
	if (!value) return [];
	return value
		.split(isWin(platform) ? ";" : ":")
		.map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
		.filter(Boolean);
}

/** 展开 `%VAR%`（大小写不敏感，与 Windows 一致）；未定义的变量原样保留。 */
export function expandWinVars(value: string, env: Record<string, string | undefined>): string {
	const lower = new Map<string, string>();
	for (const [k, v] of Object.entries(env)) if (typeof v === "string") lower.set(k.toLowerCase(), v);
	return value.replace(/%([^%]+)%/g, (m, name: string) => lower.get(name.toLowerCase()) ?? m);
}

/** 目录归一化：展开变量 → resolve → 去尾分隔符 → Windows 小写。只用于比对，不用于写入。 */
export function normalizeDir(dir: string, platform: string, env: Record<string, string | undefined>): string {
	let d = isWin(platform) ? expandWinVars(dir, env) : dir;
	d = pathFor(platform).resolve(d).replace(/[\\/]+$/, "");
	if (isWin(platform)) d = d.replace(/\//g, "\\").toLowerCase();
	return d;
}

/** `dir` 是否已在 `entries`（任一形态：大小写 / 尾斜杠 / `%USERPROFILE%`）。 */
export function dirInPath(
	dir: string,
	entries: readonly string[],
	platform: string,
	env: Record<string, string | undefined>,
): boolean {
	const want = normalizeDir(dir, platform, env);
	return entries.some((e) => normalizeDir(e, platform, env) === want);
}

// ── 注册表读取（Windows）──────────────────────────────────────────────

const HKLM_ENV_SUBKEY = "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

/** 读注册表 `Path` 原值的 PowerShell 脚本（UTF-8 控制台、不展开 `%…%`、带类型）。 */
export function regReadScript(hive: "HKLM" | "HKCU"): string {
	const root = hive === "HKLM" ? "LocalMachine" : "CurrentUser";
	const sub = hive === "HKLM" ? HKLM_ENV_SUBKEY : "Environment";
	return [
		"$ErrorActionPreference='Stop'",
		"[Console]::OutputEncoding=[Text.Encoding]::UTF8",
		`$k=[Microsoft.Win32.Registry]::${root}.OpenSubKey('${sub}')`,
		"if($null -eq $k){ Write-Output '{\"kind\":null,\"value\":null}'; exit 0 }",
		"$names=$k.GetValueNames()",
		"if(-not ($names -contains 'Path')){ Write-Output '{\"kind\":null,\"value\":null}'; exit 0 }",
		"$v=$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
		"$kind=$k.GetValueKind('Path').ToString()",
		"@{kind=$kind;value=[string]$v} | ConvertTo-Json -Compress",
	].join("\n");
}

/**
 * 跑一段 PowerShell：脚本经 **stdin**（`-Command -`）喂进去，不拼进命令串、不做 base64。
 * 脚本本体只含 ASCII；带中文/空格/分号的值一律走环境变量进去（见 user-path.ts）。`windowsHide` 不弹黑框。
 */
export function runPowerShell(
	script: string,
	env?: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string } {
	const r = spawnSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
		{ input: script, encoding: "utf8", windowsHide: true, env: env ? { ...process.env, ...env } : process.env },
	);
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 解析读脚本的 JSON 输出；解析不了按「值不存在」处理（宁可判缺失去追加，也不假定在）。 */
export function parseRegPathJson(stdout: string): RegPathValue {
	try {
		const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
		const o = JSON.parse(line) as { kind?: unknown; value?: unknown };
		return {
			kind: typeof o.kind === "string" ? o.kind : null,
			value: typeof o.value === "string" ? o.value : null,
		};
	} catch {
		return { kind: null, value: null };
	}
}

function defaultReadRegPath(hive: "HKLM" | "HKCU"): RegPathValue {
	const r = runPowerShell(regReadScript(hive));
	if (r.status !== 0) return { kind: null, value: null };
	return parseRegPathJson(r.stdout);
}

/**
 * 持久 PATH 的目录表：Windows = HKLM 在前、HKCU 在后（与系统合成序一致），展开 `%…%` 后拆分；
 * POSIX = 进程 PATH（无持久概念可读，调用方在文案里注明「按当前 shell」）。
 */
export function persistedPathDirs(deps: CommandPathDeps = {}): string[] {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	if (!isWin(platform)) return splitPathList(env.PATH, platform);
	const read = deps.readRegPath ?? defaultReadRegPath;
	const out: string[] = [];
	for (const hive of ["HKLM", "HKCU"] as const) {
		const v = read(hive).value;
		if (v) out.push(...splitPathList(expandWinVars(v, env), platform));
	}
	return out;
}

/** 在持久 PATH 上解析 `gtrk`（拿到的是终端真正会敲到的那个入口）。 */
export function persistedResolve(stem: string, deps: CommandPathDeps = {}): string | null {
	const platform = deps.platform ?? process.platform;
	return resolveOnPath(stem, persistedPathDirs(deps), execExtsFor(platform), deps.isFile, platform);
}

// ── 启动器目录 ─────────────────────────────────────────────────────────

function defaultNpmGlobalPrefix(): string | null {
	const r = spawnSync("npm prefix -g", { shell: true, encoding: "utf8", windowsHide: true });
	const out = (r.stdout ?? "").trim();
	return r.status === 0 && out ? out : null;
}

/**
 * 启动器所在目录——就是要进 PATH 的那一个：
 *   npm 全局形态：Windows 是 `npm prefix -g` 本身（`%APPDATA%\npm`），POSIX 是 `<prefix>/bin`；
 *   私有形态：`~/.gitruck/bin`。
 * npm 前缀拿不到时返 null（调用方给人话，不猜）。
 */
export function launcherDir(channel: "npm-global" | "private", deps: CommandPathDeps = {}): string | null {
	const platform = deps.platform ?? process.platform;
	const P = pathFor(platform);
	if (channel === "private") return P.join(deps.home ?? gitruckHome(), "bin");
	const prefix = (deps.npmGlobalPrefix ?? defaultNpmGlobalPrefix)();
	if (!prefix) return null;
	return isWin(platform) ? prefix : P.join(prefix, "bin");
}

/** 平台分隔符（供拼 PATH 提示）。 */
export const PATH_SEP_OF = (platform: string) => (isWin(platform) ? ";" : ":");
export { sep as PATH_DIR_SEP };
