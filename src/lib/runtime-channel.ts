/**
 * 运行时通道（change add-gtrk-command-availability · gtrk-command-availability spec）。
 *
 * 两条通道，MUST NOT 混用：
 *   - `npm-global`：经 `npm i -g` 装出来的那份，升级走 `npm i -g @gitruck/cli@latest`（现状不变）；
 *   - `private`：客户端自举落位的私有运行时（gitruck-home spec 登记的三目录）——
 *       `~/.gitruck/node/`   便携 Node（含 `node.exe` 与自带 `node_modules/npm`）
 *       `~/.gitruck/npm/`    私有 npm 前缀（包落 `npm/node_modules/@gitruck/cli`）
 *       `~/.gitruck/bin/`    启动器 `gtrk.cmd`，**唯一**进 PATH 的目录
 *     升级 MUST 用私有 node + 私有 npm + `--prefix ~/.gitruck/npm`，**即使系统 PATH 上有 npm 也不用**——
 *     那会把包装进另一个前缀，启动器指向的仍是旧版：「升级成功」但敲到的还是老的。
 *
 * 判据只看一件事：`process.execPath` 的 realpath 是否在 `~/.gitruck/node/` 之下。
 * 启动器脚本内容全仓单一来源在此（客户端 Rust 侧另持一份同文，两侧都以 gitruck-home 规格条文为锚）。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { gitruckHome } from "./paths";
import { pathFor } from "./command-path";

export interface PrivateChannel {
	kind: "private";
	/** 判定时的平台（路径拼接按它选 path 实现）。 */
	platform: string;
	/** `~/.gitruck/node/node.exe`（POSIX 为 `node`）。 */
	node: string;
	/** 便携 Node 自带的 `node_modules/npm/bin/npm-cli.js`。 */
	npmCli: string;
	/** `~/.gitruck/npm`——`npm --prefix` 目标。 */
	prefix: string;
	/** `~/.gitruck/bin`——启动器目录。 */
	bin: string;
	/** `~/.gitruck/npm/node_modules/@gitruck/cli`。 */
	pkgRoot: string;
	/** `~/.gitruck/npm-cache`——私有通道的 npm 缓存。 */
	npmCache: string;
}
export interface NpmGlobalChannel {
	kind: "npm-global";
}
export type Channel = PrivateChannel | NpmGlobalChannel;

export interface ChannelDeps {
	execPath?: string;
	home?: string;
	platform?: string;
	realpath?: (p: string) => string;
}

function safeRealpath(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		return p;
	}
}

/** 私有运行时各路径（只按布局算，不检查存在性）。 */
export function privateLayout(home: string = gitruckHome(), platform: string = process.platform): Omit<PrivateChannel, "kind"> {
	const P = pathFor(platform);
	const nodeDir = P.join(home, "node");
	const isWin = platform === "win32";
	return {
		platform,
		node: isWin ? P.join(nodeDir, "node.exe") : P.join(nodeDir, "bin", "node"),
		npmCli: isWin
			? P.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")
			: P.join(nodeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		prefix: P.join(home, "npm"),
		bin: P.join(home, "bin"),
		pkgRoot: P.join(home, "npm", "node_modules", "@gitruck", "cli"),
		npmCache: P.join(home, "npm-cache"),
	};
}

/** 判定当前进程所在的通道。前缀比对在 Windows 忽略大小写；realpath 解 junction/符号链接。 */
export function detectChannel(deps: ChannelDeps = {}): Channel {
	const platform = deps.platform ?? process.platform;
	const home = deps.home ?? gitruckHome();
	const rp = deps.realpath ?? safeRealpath;
	const P = pathFor(platform);
	const exec = rp(deps.execPath ?? process.execPath);
	const nodeDir = rp(P.join(home, "node")).replace(/[\\/]+$/, "") + P.sep;
	const norm = (s: string) => (platform === "win32" ? s.replace(/\//g, "\\").toLowerCase() : s);
	if (norm(exec).startsWith(norm(nodeDir))) return { kind: "private", ...privateLayout(home, platform) };
	return { kind: "npm-global" };
}

/**
 * 启动器脚本（Windows `.cmd`）——**单一来源**。写 `%USERPROFILE%` 形态而非绝对路径：用户目录搬家也不死；
 * 与 gitruck-home 规格、opencut 仓 design D-6 逐字同文。CRLF 行尾（cmd 解析最稳）。
 */
export const LAUNCHER_CMD =
	"@echo off\r\n" +
	'"%USERPROFILE%\\.gitruck\\node\\node.exe" "%USERPROFILE%\\.gitruck\\npm\\node_modules\\@gitruck\\cli\\dist\\index.js" %*\r\n';

export function launcherScript(): string {
	return LAUNCHER_CMD;
}

/** 私有通道的升级命令（不经 shell：路径含空格也无需引号地狱）。 */
export function privateUpgradeInvocation(
	ch: PrivateChannel,
	spec = "@gitruck/cli@latest",
): { command: string; args: string[]; env: Record<string, string> } {
	return {
		command: ch.node,
		args: [ch.npmCli, "install", "-g", "--prefix", ch.prefix, spec],
		env: {
			npm_config_update_notifier: "false",
			npm_config_fund: "false",
			npm_config_cache: ch.npmCache,
		},
	};
}

/** 私有通道下调自身（`skills install` 等）：绕开 PATH，直接 node + 包入口。 */
export function privateSelfInvocation(ch: PrivateChannel, args: string[]): { command: string; args: string[] } {
	return { command: ch.node, args: [pathFor(ch.platform).join(ch.pkgRoot, "dist", "index.js"), ...args] };
}

export interface LauncherIo {
	exists?: (p: string) => boolean;
	read?: (p: string) => string;
	write?: (p: string, content: string) => void;
	mkdir?: (dir: string) => void;
}

/** 复核启动器：内容逐字相同则不动（`kept`），缺失或不同则重写（`written`）。 */
export function ensureLauncher(ch: PrivateChannel, io: LauncherIo = {}): "kept" | "written" {
	const exists = io.exists ?? existsSync;
	const read = io.read ?? ((p: string) => readFileSync(p, "utf8"));
	const write = io.write ?? ((p: string, c: string) => writeFileSync(p, c, "utf8"));
	const mkdir = io.mkdir ?? ((d: string) => mkdirSync(d, { recursive: true }));
	const target = pathFor(ch.platform).join(ch.bin, "gtrk.cmd");
	if (exists(target) && read(target) === LAUNCHER_CMD) return "kept";
	mkdir(ch.bin);
	write(target, LAUNCHER_CMD);
	return "written";
}
