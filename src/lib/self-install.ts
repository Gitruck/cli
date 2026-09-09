/**
 * `gtrk install` 的第 ⓪ 步：让 `gtrk` 对任意新开终端可用（change add-gtrk-command-availability）。
 *
 * 两件事，顺序固定：
 *   A. **自持全局副本**——运行中的自己若不是持久 PATH 能解析到的那份（npx 临时态 / 未 link 的本地检出），
 *      `npm i -g @gitruck/cli@<运行中版本>`（钉运行版：用户跑的是哪版就装哪版，可复现）；
 *      持久 PATH 已能解析到版本 ≥ 运行版的副本 ⇒ 不动（MUST NOT 降级）；私有运行时 ⇒ 跳过（副本由客户端落位）。
 *   B. **PATH**——启动器目录不在持久 PATH 就追加（Windows 写 HKCU；POSIX 只给一行指引），见 user-path.ts。
 *
 * 判据取「位置」不取「是否经 npx 启动」：npx 的痕迹在各 npm 版本 / pnpm / bun 下形态各异，靠它判等于赌；
 * `realpath(packageRoot())` 与「持久 PATH 解析到的 gtrk 所属包根」是否同一处，才是可复现的事实（design D-1）。
 * 全部 I/O 经 `deps` 注入，单测零子进程、零注册表。
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { packageRoot } from "./paths";
import { cmpSemver, currentVersion } from "./version";
import { detectChannel, type Channel } from "./runtime-channel";
import {
	dirInPath,
	launcherDir,
	pathFor,
	persistedPathDirs,
	persistedResolve,
	type CommandPathDeps,
} from "./command-path";
import { ensureUserPath, posixPathHint, type UserPathDeps, type UserPathReport } from "./user-path";

export interface ResolvedGlobal {
	/** 持久 PATH 解析到的入口（Windows 多半是 `gtrk.cmd`）。 */
	shim: string;
	/** 该入口所属包根；推不出来为 null。 */
	root: string | null;
	/** 该副本版本；拿不到为 null（入口坏了 / 不可响）。 */
	version: string | null;
}

export type SelfInstallPlan =
	| { action: "install"; reason: "missing" | "older" | "unresponsive" }
	| { action: "skip"; reason: "private" | "same" | "newer-global" };

/** 纯判据（design D-1 五档真值表）。 */
export function selfInstallPlan(input: {
	channel: Channel["kind"];
	runningRoot: string;
	runningVersion: string;
	resolved: ResolvedGlobal | null;
	samePath: (a: string, b: string) => boolean;
}): SelfInstallPlan {
	if (input.channel === "private") return { action: "skip", reason: "private" };
	const r = input.resolved;
	if (!r) return { action: "install", reason: "missing" };
	if (r.root && input.samePath(r.root, input.runningRoot)) return { action: "skip", reason: "same" };
	if (r.version) {
		return cmpSemver(r.version, input.runningVersion) >= 0
			? { action: "skip", reason: "newer-global" }
			: { action: "install", reason: "older" };
	}
	return { action: "install", reason: "unresponsive" };
}

export interface PkgIo {
	exists?: (p: string) => boolean;
	readJson?: (p: string) => unknown;
	realpath?: (p: string) => string;
	isSymlink?: (p: string) => boolean;
}

function defaultReadJson(p: string): unknown {
	return JSON.parse(readFileSync(p, "utf8"));
}
function defaultRealpath(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		return p;
	}
}
function defaultIsSymlink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

function isOurPkg(dir: string, io: PkgIo, platform: string): boolean {
	const exists = io.exists ?? existsSync;
	const readJson = io.readJson ?? defaultReadJson;
	const pj = pathFor(platform).join(dir, "package.json");
	if (!exists(pj)) return false;
	try {
		return (readJson(pj) as { name?: string }).name === "@gitruck/cli";
	} catch {
		return false;
	}
}

/**
 * 从入口推包根：① Windows npm 全局布局 `<入口目录>/node_modules/@gitruck/cli`；
 * ② POSIX 布局 `<入口目录>/../lib/node_modules/@gitruck/cli`；③ 入口是符号链接 ⇒ 沿 realpath 向上找本包的 package.json。
 */
export function globalPackageRootFromShim(shim: string, io: PkgIo = {}, platform: string = process.platform): string | null {
	const P = pathFor(platform);
	const dir = P.dirname(shim);
	const candidates = [
		P.join(dir, "node_modules", "@gitruck", "cli"),
		P.join(dir, "..", "lib", "node_modules", "@gitruck", "cli"),
	];
	for (const c of candidates) if (isOurPkg(c, io, platform)) return c;
	if ((io.isSymlink ?? defaultIsSymlink)(shim)) {
		let cur = P.dirname((io.realpath ?? defaultRealpath)(shim));
		for (let i = 0; i < 8; i++) {
			if (isOurPkg(cur, io, platform)) return cur;
			const parent = P.dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	}
	return null;
}

/** 读包根的版本；读不到为 null。 */
export function packageVersionAt(root: string, io: PkgIo = {}, platform: string = process.platform): string | null {
	try {
		const v = ((io.readJson ?? defaultReadJson)(pathFor(platform).join(root, "package.json")) as { version?: unknown }).version;
		return typeof v === "string" ? v : null;
	} catch {
		return null;
	}
}

/** 跑一个入口的 `--version`（Windows 的 `.cmd` 需经 shell）；拿不到为 null。 */
export function spawnVersion(shim: string, platform: string = process.platform): string | null {
	const r = spawnSync(`"${shim}" --version`, {
		shell: true,
		encoding: "utf8",
		windowsHide: true,
		timeout: 10_000,
	});
	if (r.status !== 0) return null;
	const first = (r.stdout ?? "")
		.split(/\r?\n/)
		.map((s) => s.trim())
		.find(Boolean);
	void platform;
	return first ? first.replace(/^v/, "") : null;
}

export interface SelfInstallDeps {
	channel?: Channel;
	runningRoot?: string;
	runningVersion?: string;
	platform?: string;
	pathDeps?: CommandPathDeps;
	userPathDeps?: UserPathDeps;
	pkgIo?: PkgIo;
	/** `npm i -g <spec>`；返回退出码。 */
	runNpmGlobal?: (spec: string) => number;
	spawnVersion?: (shim: string) => string | null;
	samePath?: (a: string, b: string) => boolean;
}

export interface SelfInstallReport {
	channel: Channel["kind"];
	plan: SelfInstallPlan;
	resolvedBefore: ResolvedGlobal | null;
	/** 执行了安装时的结果；未执行为 null。 */
	install: { ok: boolean; spec: string; detail: string } | null;
	/** 启动器目录；拿不到为 null。 */
	launcherDir: string | null;
	/** PATH 处置；`launcherDir` 为 null 时也为 null。 */
	path: UserPathReport | null;
}

function defaultRunNpmGlobal(spec: string): number {
	const r = spawnSync(`npm i -g ${spec}`, { shell: true, stdio: "inherit", windowsHide: true });
	return r.status ?? 1;
}

function defaultSamePath(a: string, b: string): boolean {
	const na = defaultRealpath(a);
	const nb = defaultRealpath(b);
	return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** 在持久 PATH 上解析 gtrk 并推出包根与版本。 */
export function resolveGlobal(deps: SelfInstallDeps = {}): ResolvedGlobal | null {
	const platform = deps.platform ?? deps.pathDeps?.platform ?? process.platform;
	const shim = persistedResolve("gtrk", { platform, ...deps.pathDeps });
	if (!shim) return null;
	const root = globalPackageRootFromShim(shim, deps.pkgIo, platform);
	const version = root ? packageVersionAt(root, deps.pkgIo, platform) : (deps.spawnVersion ?? spawnVersion)(shim);
	return { shim, root, version };
}

/**
 * 第 ⓪ 步主流程：判 → 自持 → PATH。不抛：每一步的结果都进报告，由调用方打成人话。
 */
export function ensureCommandAvailable(deps: SelfInstallDeps = {}): SelfInstallReport {
	const platform = deps.platform ?? process.platform;
	const channel = deps.channel ?? detectChannel();
	const runningRoot = deps.runningRoot ?? packageRoot();
	const runningVersion = deps.runningVersion ?? currentVersion();
	const samePath = deps.samePath ?? defaultSamePath;
	const pathDeps: CommandPathDeps = { platform, ...deps.pathDeps };

	const resolvedBefore = resolveGlobal({ ...deps, pathDeps });
	const plan = selfInstallPlan({ channel: channel.kind, runningRoot, runningVersion, resolved: resolvedBefore, samePath });

	let install: SelfInstallReport["install"] = null;
	if (plan.action === "install") {
		const spec = `@gitruck/cli@${runningVersion}`;
		const code = (deps.runNpmGlobal ?? defaultRunNpmGlobal)(spec);
		install = {
			ok: code === 0,
			spec,
			detail: code === 0 ? `已装全局副本 v${runningVersion}` : `全局副本没装上（npm 退出码 ${code}）。手工跑：npm i -g ${spec}`,
		};
	}

	// 启动器目录：私有 ⇒ ~/.gitruck/bin；npm 全局 ⇒ 优先用（安装后）真解析到的入口所在目录，退回 npm prefix -g
	let dir: string | null;
	if (channel.kind === "private") {
		dir = channel.bin;
	} else {
		const after = install ? resolveGlobal({ ...deps, pathDeps }) : resolvedBefore;
		dir = after ? pathFor(platform).dirname(after.shim) : launcherDir("npm-global", pathDeps);
	}

	let path: UserPathReport | null = null;
	if (dir) {
		if (platform === "win32") {
			path = ensureUserPath(dir, { platform, ...deps.userPathDeps });
		} else if (dirInPath(dir, persistedPathDirs(pathDeps), platform, pathDeps.env ?? process.env)) {
			path = { status: "already", detail: `已在 PATH：${dir}` };
		} else {
			path = {
				status: "unsupported",
				detail: "本平台不改 shell 配置；新终端敲不到 gtrk 的话，把下面这行加进你的 shell 配置",
				hint: posixPathHint(dir),
			};
		}
	}

	return { channel: channel.kind, plan, resolvedBefore, install, launcherDir: dir, path };
}

// ── doctor 行 ─────────────────────────────────────────────────────────────

export interface DoctorRowLike {
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
}

/**
 * `gtrk doctor` 的「命令可达」行：按持久 PATH 解析 → 跑 `--version` → 与运行版比。
 * 判据 MUST NOT 取进程 PATH（design D-5）；POSIX 无持久 PATH 可读，注明「按当前 shell」。
 */
export function commandReachDoctorRow(deps: SelfInstallDeps = {}): DoctorRowLike {
	const platform = deps.platform ?? process.platform;
	const running = deps.runningVersion ?? currentVersion();
	const suffix = platform === "win32" ? "" : "（按当前 shell）";
	const shim = persistedResolve("gtrk", { platform, ...deps.pathDeps });
	if (!shim) {
		return { name: "命令可达", status: "fail", detail: `新开终端敲不到 gtrk —— 跑 gtrk install${suffix}` };
	}
	const v = (deps.spawnVersion ?? spawnVersion)(shim);
	if (!v) return { name: "命令可达", status: "warn", detail: `敲到了但不可响：${shim}${suffix}` };
	if (cmpSemver(v, running) === 0) {
		return { name: "命令可达", status: "ok", detail: `新终端可敲（v${v}，${shim}）${suffix}` };
	}
	return {
		name: "命令可达",
		status: "warn",
		detail: `新终端敲到的是另一版 v${v}（${shim}），当前运行 v${running}${suffix}`,
	};
}
