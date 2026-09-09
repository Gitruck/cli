/**
 * Windows 用户级持久 PATH 注册（change add-gtrk-command-availability · gtrk-command-availability spec）。
 *
 * 口径（主理人 2026-09-09 拍板 + design D-2）：
 *   - 只写 HKCU `Environment\Path`，MUST NOT 写 HKLM；
 *   - 只**追加自己那一段到尾部**：不去重、不重排其它段、幂等（已在则零写入零广播）；
 *   - 保留原值类型（缺省 `REG_EXPAND_SZ`），原值里的 `%…%` 原样写回、不展开；
 *   - 写后广播 `WM_SETTINGCHANGE`，让 Explorer 起的新终端立刻可见；广播失败降级为一行「重开终端生效」；
 *   - MUST NOT 用 `setx`（1024 字符截断，用户 PATH 稍长即被截毁）。
 *   - POSIX：不改任何 rc 文件，只给一行可照抄的 `export PATH=…`。
 *
 * 写入走 PowerShell 的 .NET 注册表 API（`SetValue` 带 `RegistryValueKind`，类型与 `%…%` 都保得住），
 * 值经环境变量递进脚本（不拼进命令串，含中文/空格/分号都安全）。全部 I/O 经 `deps` 注入，单测零真实注册表。
 */
import {
	dirInPath,
	regReadScript,
	parseRegPathJson,
	runPowerShell,
	splitPathList,
	type RegPathValue,
} from "./command-path";

export interface UserPathDeps {
	platform?: string;
	env?: Record<string, string | undefined>;
	readUserPath?: () => RegPathValue;
	writeUserPath?: (value: string, kind: string) => void;
	/** 广播 `WM_SETTINGCHANGE`；返回是否成功。 */
	broadcast?: () => boolean;
}

export type UserPathStatus = "already" | "added" | "failed" | "unsupported";

export interface UserPathReport {
	status: UserPathStatus;
	/** 人读一句话（安装输出直接打）。 */
	detail: string;
	/** `added` 时广播是否成功；其余 undefined。 */
	broadcast?: boolean;
	/** POSIX 或失败时给用户照抄的指引；成功时 undefined。 */
	hint?: string;
}

/** 类型缺省：值不存在时按 `REG_EXPAND_SZ` 新建（用户 PATH 惯例）。 */
const DEFAULT_KIND = "ExpandString";

/**
 * 纯函数：把 `dir` 追加到 `existing` 尾部。已在则 `changed=false` 且值原样返回。
 * 只追加、不去重、不重排；尾部多余分号先剥掉再接，避免写出 `;;`。
 */
export function mergeUserPath(
	existing: string | null,
	dir: string,
	platform: string,
	env: Record<string, string | undefined>,
): { value: string; changed: boolean } {
	const cur = existing ?? "";
	if (dirInPath(dir, splitPathList(cur, platform), platform, env)) return { value: cur, changed: false };
	const trimmed = cur.replace(/[;\s]+$/, "");
	return { value: trimmed ? `${trimmed};${dir}` : dir, changed: true };
}

/** 写 HKCU `Environment\Path` 的 PowerShell 脚本：值与类型经环境变量进来。 */
export function regWriteScript(): string {
	return [
		"$ErrorActionPreference='Stop'",
		"$v=$env:GTRK_PATH_VALUE",
		"$kindName=$env:GTRK_PATH_KIND",
		"$kind=[Microsoft.Win32.RegistryValueKind]::$kindName",
		"[Microsoft.Win32.Registry]::SetValue('HKEY_CURRENT_USER\\Environment','Path',$v,$kind)",
	].join("\n");
}

/** 广播 `WM_SETTINGCHANGE`（`HWND_BROADCAST`，lParam `Environment`，`SMTO_ABORTIFHUNG`，5s）。 */
export function broadcastScript(): string {
	return [
		"$ErrorActionPreference='Stop'",
		"$sig='[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'",
		"Add-Type -Namespace GtrkEnv -Name Native -MemberDefinition $sig",
		"$r=[UIntPtr]::Zero",
		"[void][GtrkEnv.Native]::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'Environment',2,5000,[ref]$r)",
	].join("\n");
}

function defaultReadUserPath(): RegPathValue {
	const r = runPowerShell(regReadScript("HKCU"));
	if (r.status !== 0) throw new Error(`读注册表 HKCU\\Environment\\Path 失败：${(r.stderr || r.stdout).trim().slice(0, 300)}`);
	return parseRegPathJson(r.stdout);
}

function defaultWriteUserPath(value: string, kind: string): void {
	const r = runPowerShell(regWriteScript(), { GTRK_PATH_VALUE: value, GTRK_PATH_KIND: kind });
	if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 300) || `退出码 ${r.status}`);
}

function defaultBroadcast(): boolean {
	return runPowerShell(broadcastScript()).status === 0;
}

/** POSIX 的照抄指引（不改 rc，让用户自己贴）。 */
export function posixPathHint(dir: string): string {
	return `export PATH="${dir}:$PATH"`;
}

/**
 * 确保 `dir` 在用户级持久 PATH 里。Windows 真写；POSIX 返 `unsupported` 并附一行指引。
 * 失败不抛：返 `failed` + 可读原因 + 手工指引（`gtrk install` 的主体已完成，缺的是便利，不是功能）。
 */
export function ensureUserPath(dir: string, deps: UserPathDeps = {}): UserPathReport {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	if (platform !== "win32") {
		return {
			status: "unsupported",
			detail: "本平台不改 shell 配置；若新终端敲不到 gtrk，把下面这行加进你的 shell 配置",
			hint: posixPathHint(dir),
		};
	}
	const manual = `手工加法：系统设置 → 环境变量 → 用户变量 Path 追加 ${dir}`;
	let cur: RegPathValue;
	try {
		cur = (deps.readUserPath ?? defaultReadUserPath)();
	} catch (e) {
		return { status: "failed", detail: `读不到用户 PATH：${(e as Error).message}`, hint: manual };
	}
	const merged = mergeUserPath(cur.value, dir, platform, env);
	if (!merged.changed) return { status: "already", detail: `已在用户 PATH：${dir}` };
	try {
		(deps.writeUserPath ?? defaultWriteUserPath)(merged.value, cur.kind ?? DEFAULT_KIND);
	} catch (e) {
		return {
			status: "failed",
			detail: `写用户 PATH 被拒（组策略 / 权限？）：${(e as Error).message}`,
			hint: manual,
		};
	}
	let ok = false;
	try {
		ok = (deps.broadcast ?? defaultBroadcast)();
	} catch {
		ok = false;
	}
	return {
		status: "added",
		broadcast: ok,
		detail: ok
			? `已追加到用户 PATH（新开终端即可用）：${dir}`
			: `已追加到用户 PATH：${dir}（环境变更广播未成功，重开终端后生效）`,
	};
}
