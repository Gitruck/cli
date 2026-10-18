/**
 * 本机 Chromium 系浏览器的无头驱动（change add-composite-layer，design D5 / DP-2）：合成颗粒的逐帧排版机检与静帧。
 *
 * - 不加 npm 依赖：用本机已装的 Chrome / Edge（Windows 必有 Edge），找不到就如实报「排版未机检」。
 * - 走 `--remote-debugging-pipe`（CDP 消息经 fd 3 / 4 的管道、NUL 分隔），不开端口、不依赖 WebSocket
 *   （Node 20 没有全局 WebSocket，本仓 engines 是 >=20.6）。
 * - 进程树收干净：Chrome 会拉起一串子进程，Windows 上按进程树结束，结束前先提优先级（满载时才退得完，见 `boostForExit`）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { constants as osConstants, setPriority, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { installedHeadlessShell, PINNED_HEADLESS_SHELL } from "./runtime-assets";

/** 候选浏览器（按平台）；环境变量 `GTRK_CHROME` 优先。 */
export function browserCandidates(platform = process.platform, env = process.env): string[] {
	const out: string[] = [];
	if (env.GTRK_CHROME) out.push(env.GTRK_CHROME);
	if (platform === "win32") {
		const pf = env.ProgramFiles ?? "C:\\Program Files";
		const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const local = env.LOCALAPPDATA ?? "";
		out.push(
			join(pf, "Google", "Chrome", "Application", "chrome.exe"),
			join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
			...(local ? [join(local, "Google", "Chrome", "Application", "chrome.exe")] : []),
			join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
			join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
		);
	} else if (platform === "darwin") {
		out.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		);
	} else {
		out.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium");
	}
	return out;
}

export function findBrowser(): string | null {
	return browserCandidates().find((p) => existsSync(p)) ?? null;
}

/** 烘焙用的浏览器：来源决定截帧方式（headless-shell 走 beginFrame，系统浏览器走截图）。 */
export interface BakeBrowser {
	exe: string;
	/** `env` = `GTRK_CHROME` 显式指定；`pinned` = ~/.gitruck 下的钉定 headless-shell；`system` = 本机 Chrome / Edge 退路。 */
	source: "env" | "pinned" | "system";
	/** 截帧方式：确定性出帧（beginFrame）只有 headless-shell 支持。 */
	mode: "beginframe" | "screenshot";
	/** 进缓存键的浏览器标识：钉定版本号，或可执行文件路径（系统浏览器 / 显式指定）。 */
	build: string;
}

/** 可执行文件名是否为 chrome-headless-shell（`GTRK_CHROME` 指到它时也走 beginFrame）。 */
export const isHeadlessShell = (exe: string): boolean => /chrome-headless-shell(\.exe)?$/i.test(exe);

/**
 * 烘焙浏览器定位（capability `composite-bake`「浏览器供给与退路」）：
 * `GTRK_CHROME` → 钉定版本 headless-shell → 系统 Chrome / Edge → null。**绝不下载**——安装只走
 * `gtrk deps install --browser` 或显式授权的 `bake --install-browser`。
 */
export function resolveBakeBrowser(
	{ env = process.env, pinned = installedHeadlessShell(), system = () => findSystemBrowser(env) } = {} as {
		env?: NodeJS.ProcessEnv;
		pinned?: string | null;
		system?: () => string | null;
	},
): BakeBrowser | null {
	if (env.GTRK_CHROME) {
		const exe = env.GTRK_CHROME;
		const shell = isHeadlessShell(exe);
		return { exe, source: "env", mode: shell ? "beginframe" : "screenshot", build: `env:${exe}` };
	}
	if (pinned) return { exe: pinned, source: "pinned", mode: "beginframe", build: `chrome-headless-shell@${PINNED_HEADLESS_SHELL}` };
	const sys = system();
	return sys ? { exe: sys, source: "system", mode: "screenshot", build: `system:${sys}` } : null;
}

/** 本机 Chrome / Edge（不含 `GTRK_CHROME`）。 */
export function findSystemBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
	return browserCandidates(process.platform, { ...env, GTRK_CHROME: undefined }).find((p) => existsSync(p)) ?? null;
}

type Pending = { res: (v: Record<string, unknown>) => void; rej: (e: Error) => void };

export type LaunchMode = "default" | "beginframe" | "screenshot-soft";

/** beginFrame 出帧间隔（毫秒；只用于推进合成器时钟，页面内的画面由 renderAt 按帧号决定）。 */
const FRAME_INTERVAL_MS = 1000 / 30;

/**
 * headless-shell 确定性出帧旗标（与 infra hyperframes 引擎 `browserManager` 同组）+ 软件 GL。
 * `--disable-partial-raster` 是分段逐位等价的必要条件：不关时同一帧在「连续渲染」与「段首起渲」下
 * 抗锯齿边缘不同（spike-1 实测最低 72 dB）。
 */
export const BEGIN_FRAME_ARGS = [
	"--deterministic-mode",
	"--enable-begin-frame-control",
	"--disable-new-content-rendering-timeout",
	"--run-all-compositor-stages-before-draw",
	"--disable-threaded-animation",
	"--disable-threaded-scrolling",
	"--disable-checker-imaging",
	"--disable-image-animation-resync",
	"--enable-surface-synchronization",
	"--disable-gpu-compositing",
	"--use-gl=angle",
	"--use-angle=swiftshader",
	"--enable-unsafe-swiftshader",
	"--disable-partial-raster",
];

/** 系统浏览器烘焙退路：新无头模式 + 关 GPU（spike-1：比开 GPU 快约 1.5 倍）+ 关局部重绘。 */
export const SOFT_SCREENSHOT_ARGS = ["--headless=new", "--disable-gpu", "--disable-partial-raster"];

/** 主进程退出后等子进程自己跟着退的时长；平时约 0.2 秒内就全退了。 */
export const REAP_GRACE_MS = 1000;
/** 结束遗留子进程之后，再等调试管道关上的时长。 */
export const REAP_WAIT_MS = 5000;
/** 查进程表的 PowerShell 本身的时限（满载时起它也要几秒）。 */
const REAP_QUERY_TIMEOUT_MS = 15_000;
/** 删浏览器用户目录的总时限：删不掉（还有进程握着文件）就留在系统临时目录，不拖收尾。 */
const PROFILE_RM_BUDGET_MS = 2000;

/**
 * Windows：把本进程的一个子进程（浏览器主进程、编码器）的优先级类提到「高」，让它的退出（自己退或被结束）尽快走完。
 *
 * 浏览器多数线程低于普通优先级运行；进程退出要等每个线程都被调度到一次，普通优先级的负载占满 CPU 时它们排不上。
 * 实测（2026-10-17，20 线程机器 + 24 个普通优先级烧核进程）：直接结束，主进程 4–11 分钟后才真正退出（期间握着调试管道
 * 与用户目录、工作目录里的文件）；先提到「高」再结束 0.06–0.2 秒；已在结束中的进程再提也随即退出。
 * 只用于本进程的直接子进程且尚未退出时（句柄在手，进程号不会被复用）；失败不抛。
 */
function boostForExit(proc: ChildProcess): void {
	if (process.platform !== "win32" || !proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
	try {
		setPriority(proc.pid, osConstants.priority.PRIORITY_HIGH);
	} catch {
		/* 已退出 / 无权：照常结束，只是满载时退得慢 */
	}
}

/** 强制结束本进程的一个子进程（浏览器主进程、编码器）：Windows 上先提优先级，满载时才退得完（见 `boostForExit`）。 */
export function forceKill(proc: ChildProcess): void {
	boostForExit(proc);
	proc.kill("SIGKILL");
}

/**
 * 删目录：只在顶层重试、总时长有上限，返回是否删净。不用 `fs.rm` 自带的 `maxRetries`：它在每一层目录各重试一圈，
 * 文件被别的进程占着时重试次数逐层相乘（两层深、`maxRetries: 3` 要试 4×4×4 轮，约 28 秒才放弃，2026-10-17 实测）。
 */
export async function removeDir(path: string, budgetMs: number): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	for (let delay = 50; ; delay = Math.min(delay * 2, 400)) {
		try {
			await rm(path, { recursive: true, force: true });
			return true;
		} catch {
			if (Date.now() + delay > deadline) return false;
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

export interface BrowserTreeTarget {
	/** 本次独有的用户目录（主进程命令行里带着它）。 */
	profile: string;
	/** 主进程号。 */
	pid: number;
	/** 主进程映像名（子进程同名）。 */
	image: string;
	/** 子进程创建时刻上限：主进程退出时刻，或强制结束之前的那一刻。 */
	before: Date;
}

let pendingReap: { targets: BrowserTreeTarget[]; done: Promise<void> } | null = null;

/**
 * Windows：结束一棵无头浏览器进程树里还活着的进程（执行查询的 PowerShell 自己除外）。两条认法，查询、提优先级与结束
 * 在同一条管道里逐个完成（认到一个处理一个，并核对启动时刻；不先攒进程号列表——进程号会被复用）：
 * - 命令行里带本次独有的用户目录 = 主进程（用户自己的浏览器不会带这个目录）；
 * - 父进程号 = 本次主进程号、映像名相同、且创建时刻不晚于 `before` = 它的子进程。gpu / utility / renderer 的
 *   命令行**不带**用户目录（2026-10-16 实测），只能这样认；主进程退出后号若被复用，复用者的子进程必在那一刻之后创建，
 *   认不进来。
 * 认到的先提优先级（进程「高」、各线程「最高」）再结束（原因见 `boostForExit`；已在结束中的也照提，提了才退得完）。
 * 同一轮事件里的多次调用并成一次进程表查询（取消时几个工作页同时结束；满载时 PowerShell 起一次加查一遍进程表要
 * 1.5–4 秒，几个一起起互相拖慢）。有时限、失败不抛：这是收尾，不能反过来拖住收尾。非 Windows 无需（子进程随主进程结束）。
 */
export function terminateBrowserTree(t: BrowserTreeTarget): Promise<void> {
	if (process.platform !== "win32" || !Number.isInteger(t.pid)) return Promise.resolve();
	if (!pendingReap) {
		const batch: { targets: BrowserTreeTarget[]; done: Promise<void> } = { targets: [], done: Promise.resolve() };
		batch.done = new Promise((res) =>
			setImmediate(() => {
				pendingReap = null;
				reapTrees(batch.targets).then(res);
			}),
		);
		pendingReap = batch;
	}
	pendingReap.targets.push(t);
	return pendingReap.done;
}

function reapTrees(targets: BrowserTreeTarget[]): Promise<void> {
	const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
	const ps =
		targets.map((t, i) => `$t${i} = [datetime]::Parse(${q(t.before.toISOString())}); `).join("") +
		"Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (" +
		targets
			.map(
				(t, i) =>
					`($_.CommandLine -and $_.CommandLine.Contains(${q(t.profile)})) -or ` +
					`($_.ParentProcessId -eq ${t.pid} -and $_.Name -eq ${q(t.image)} -and $_.CreationDate -le $t${i})`,
			)
			.join(" -or ") +
		// 认到即在本进程里提优先级、结束（不走 CIM 方法：每次调用一个来回，十来个进程要多花 3 秒以上）：
		// - 按进程号打开后核对启动时刻与查到的创建时刻一致：查询之后号若被复用，复用者的启动时刻不同，不碰；
		//   已在退出、读不到启动时刻的，只提优先级不结束（它本就在退，提了才退得完）；
		// - 优先级类之外逐个线程提到「最高」：已在退出的进程改优先级类，正在走退出的那个线程跟不上（实测 GPU 进程
		//   剩一个基础优先级 7 的线程，满载下排不上；直接提线程才随即退完）
		") } | ForEach-Object { try { $p = [Diagnostics.Process]::GetProcessById([int]$_.ProcessId); $exiting = $false; " +
		"try { if ([math]::Abs(($p.StartTime - $_.CreationDate).TotalMilliseconds) -ge 1) { return } } catch { $exiting = $true }; " +
		"$p.PriorityClass = 'High'; foreach ($th in $p.Threads) { try { $th.PriorityLevel = 'Highest' } catch {} }; " +
		"if (-not $exiting) { $p.Kill() } } catch {} }";
	return new Promise((res) => {
		const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore", windowsHide: true });
		const t = setTimeout(() => p.kill(), REAP_QUERY_TIMEOUT_MS);
		const end = () => {
			clearTimeout(t);
			res();
		};
		p.on("close", end);
		p.on("error", end);
	});
}

/** 一个无头浏览器会话：一个页面 target，经管道收发 CDP。 */
export class HeadlessBrowser {
	private proc: ChildProcess;
	private profile: string;
	private id = 0;
	private pending = new Map<number, Pending>();
	private buf = "";
	private listeners = new Set<(m: Record<string, unknown>) => void>();
	private sessionId: string | null = null;
	private exited = false;
	/** 调试管道已关（本端 `close`）：管道只由主进程握着，与主进程退出同时关上（2026-10-17 实测）；子进程可能还在退。 */
	private pipesClosed = false;
	/** 主进程映像名与退出时刻：收遗留子进程时按「父进程号 + 映像名 + 创建早于退出」认（见 `terminateBrowserTree`）。 */
	private image: string;
	private exitedAt: Date | null = null;
	/** `closeAsync` 只走一遍（取消与出错可能先后各收一次）；收过树就不再收。 */
	private closing: Promise<void> | null = null;
	private reaped = false;

	private mode: LaunchMode;
	private frameTicks = 0;
	private lastFrame: Buffer | null = null;
	private beginFrameReady = false;

	private constructor(exe: string, mode: LaunchMode, size: [number, number] = [1920, 1080]) {
		this.mode = mode;
		const name = basename(exe);
		this.image = /\.exe$/i.test(name) ? name : `${name}.exe`;
		this.profile = mkdtempSync(join(tmpdir(), "gtrk-composite-chrome-"));
		this.proc = spawn(
			exe,
			[
				...(mode === "beginframe" ? BEGIN_FRAME_ARGS : mode === "screenshot-soft" ? SOFT_SCREENSHOT_ARGS : ["--headless=new"]),
				"--remote-debugging-pipe",
				`--user-data-dir=${this.profile}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--allow-file-access-from-files",
				"--autoplay-policy=no-user-gesture-required",
				"--mute-audio",
				"--hide-scrollbars",
				"--disable-background-timer-throttling",
				"--disable-renderer-backgrounding",
				"--disable-backgrounding-occluded-windows",
				`--window-size=${size[0]},${size[1]}`,
				"about:blank",
			],
			{ stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
		);
		const out = this.proc.stdio[4] as Readable;
		out.setEncoding("utf8");
		out.on("data", (chunk: string) => {
			this.buf += chunk;
			let i: number;
			while ((i = this.buf.indexOf("\0")) >= 0) {
				const raw = this.buf.slice(0, i);
				this.buf = this.buf.slice(i + 1);
				let m: Record<string, unknown>;
				try {
					m = JSON.parse(raw) as Record<string, unknown>;
				} catch {
					continue;
				}
				const id = m.id as number | undefined;
				if (id !== undefined && this.pending.has(id)) {
					const p = this.pending.get(id) as Pending;
					this.pending.delete(id);
					if (m.error) p.rej(new Error((m.error as { message?: string }).message ?? "CDP 错误"));
					else p.res((m.result as Record<string, unknown>) ?? {});
				} else for (const l of this.listeners) l(m);
			}
		});
		const fail = (why: string) => {
			this.exited = true;
			for (const p of this.pending.values()) p.rej(new Error(why));
			this.pending.clear();
		};
		// 起不来（路径不对、不是可执行文件）时 spawn 发 error 而不是 exit：不接住会把整个 CLI 进程带崩
		this.proc.on("error", (e) => fail(`浏览器起不来：${e.message}`));
		(this.proc.stdio[3] as Writable | null)?.on("error", () => {});
		this.proc.on("exit", () => {
			this.exitedAt = new Date();
			fail("浏览器进程已退出");
		});
		this.proc.on("close", () => (this.pipesClosed = true));
	}

	/** 当前页面视口（= 截图尺寸）。合成舞台随工程画布，换到另一种舞台的颗粒前 `setViewport` 一次。 */
	viewport: [number, number] = [1920, 1080];

	/** 视口改成 w×h（与当前相同则不动）。截图、beginFrame 出图都是这个尺寸。 */
	async setViewport([w, h]: [number, number]): Promise<void> {
		if (this.viewport[0] === w && this.viewport[1] === h) return;
		await this.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
		this.viewport = [w, h];
	}

	/**
	 * 起浏览器并开一个 `size`（缺省 1920×1080，合成舞台随工程画布时传舞台尺寸）的页面。
	 * - `default`：既有行为（lint / 静帧），新无头模式、截图；
	 * - `beginframe`：chrome-headless-shell 确定性出帧（烘焙首选）；
	 * - `screenshot-soft`：系统浏览器烘焙退路（截图，软件栅格、关局部重绘）。
	 */
	static async launch(exe: string, mode: LaunchMode = "default", size: [number, number] = [1920, 1080]): Promise<HeadlessBrowser> {
		const b = new HeadlessBrowser(exe, mode, size);
		try {
			const { targetId } = (await b.send(
				"Target.createTarget",
				{ url: "about:blank", ...(mode === "beginframe" ? { enableBeginFrameControl: true } : {}) },
				false,
			)) as { targetId: string };
			const { sessionId } = (await b.send("Target.attachToTarget", { targetId, flatten: true }, false)) as { sessionId: string };
			b.sessionId = sessionId;
			await b.send("Page.enable");
			await b.send("Runtime.enable");
			await b.send("Emulation.setDeviceMetricsOverride", { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
			b.viewport = [size[0], size[1]];
			return b;
		} catch (e) {
			void b.closeAsync();
			throw e;
		}
	}

	/** 单条 CDP 指令的超时：浏览器卡住时报错而不是让调用方永远等下去（并行跑满 CPU 时也够用）。 */
	static COMMAND_TIMEOUT_MS = 60_000;

	send(method: string, params: Record<string, unknown> = {}, onPage = true, timeoutMs = HeadlessBrowser.COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
		if (this.exited) return Promise.reject(new Error("浏览器进程已退出"));
		const id = ++this.id;
		const msg: Record<string, unknown> = { id, method, params };
		if (onPage && this.sessionId) msg.sessionId = this.sessionId;
		return new Promise((res, rej) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) rej(new Error(`浏览器 ${timeoutMs / 1000} 秒没回应：${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				res: (v) => {
					clearTimeout(timer);
					res(v);
				},
				rej: (e) => {
					clearTimeout(timer);
					rej(e);
				},
			});
			(this.proc.stdio[3] as Writable).write(`${JSON.stringify(msg)}\0`);
		});
	}

	private waitEvent(method: string, timeoutMs: number): Promise<void> {
		return new Promise((res, rej) => {
			const timer = setTimeout(() => {
				this.listeners.delete(l);
				rej(new Error(`等待 ${method} 超时`));
			}, timeoutMs);
			const l = (m: Record<string, unknown>) => {
				if (m.method === method && m.sessionId === this.sessionId) {
					clearTimeout(timer);
					this.listeners.delete(l);
					res();
				}
			};
			this.listeners.add(l);
		});
	}

	/**
	 * 打开一个 URL 并等到 load。
	 *
	 * ⚠️ 偶发（机器忙时实测）：新开的页面第一次导航，`Page.navigate` 迟迟不回、load 事件也不来，原样等会卡死整轮
	 * （原型 render.mjs 同一现象，靠定时补导航解决）。所以：不阻塞在导航的回包上；每轮等 load 至多 8 秒，
	 * 没等到就看页面是否其实已经到了（事件丢了），还没到就再导航一次，整体限时。
	 */
	async open(url: string, timeoutMs = 60000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const same = (a: string) => {
			try {
				return decodeURI(a) === decodeURI(url);
			} catch {
				return a === url;
			}
		};
		while (Date.now() < deadline) {
			const loaded = this.waitEvent("Page.loadEventFired", 8000).then(
				() => true,
				() => false,
			);
			this.send("Page.navigate", { url }, true, 8000).catch(() => {});
			if (await loaded) return;
			const href = await this.send("Runtime.evaluate", { expression: "document.readyState === 'complete' ? location.href : ''", returnByValue: true }, true, 5000)
				.then((r) => String((r as { result?: { value?: unknown } }).result?.value ?? ""))
				.catch(() => "");
			if (href && same(href)) return;
		}
		throw new Error(`打开页面超时：${url}`);
	}

	/** 在页面里求值（可 await），返回 JSON 值；页面抛错时带回错误文本。 */
	async evaluate<T = unknown>(expression: string): Promise<T> {
		const r = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
			result?: { value?: unknown };
			exceptionDetails?: { exception?: { description?: string }; text?: string };
		};
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "页面求值出错");
		return r.result?.value as T;
	}

	async screenshot(format: "jpeg" | "png" = "jpeg", quality = 92): Promise<Buffer> {
		if (this.mode === "beginframe") return this.beginFrame(format, quality);
		const r = (await this.send(
			"Page.captureScreenshot",
			format === "jpeg" ? { format, quality, ...(this.mode === "screenshot-soft" ? { optimizeForSpeed: true } : {}) } : { format },
		)) as { data: string };
		return Buffer.from(r.data, "base64");
	}

	/**
	 * 确定性出一帧（`HeadlessExperimental.beginFrame`，只在 `beginframe` 模式可用）：推进一帧并直接回图。
	 * 没有画面损伤时浏览器不回图，返回上一帧（画面本就没变）；「Another frame is pending」= 浏览器忙，退避重试。
	 */
	async beginFrame(format: "jpeg" | "png" = "jpeg", quality = 92): Promise<Buffer> {
		if (this.mode !== "beginframe") throw new Error("beginFrame 只在 headless-shell 的确定性出帧模式下可用");
		if (!this.beginFrameReady) {
			await this.send("HeadlessExperimental.enable");
			this.frameTicks = 1000;
			this.beginFrameReady = true;
		}
		const shot = format === "jpeg" ? { format, quality, optimizeForSpeed: true } : { format };
		for (let attempt = 0; ; attempt++) {
			this.frameTicks += FRAME_INTERVAL_MS;
			try {
				const r = (await this.send("HeadlessExperimental.beginFrame", {
					frameTimeTicks: this.frameTicks,
					interval: FRAME_INTERVAL_MS,
					screenshot: shot,
				})) as { screenshotData?: string };
				if (r.screenshotData) {
					this.lastFrame = Buffer.from(r.screenshotData, "base64");
					return this.lastFrame;
				}
				if (this.lastFrame) return this.lastFrame;
			} catch (e) {
				if (!/pending/i.test(String((e as Error).message)) || attempt >= 6) throw e;
				await new Promise((r) => setTimeout(r, 20 * 2 ** attempt));
			}
		}
	}

	/** 进程号（取消时按进程树结束用）。 */
	get pid(): number | undefined {
		return this.proc.pid;
	}

	/**
	 * 异步结束浏览器进程树，随后清临时用户目录——全程不阻塞事件循环（烘焙时工作页收尾若同步等 taskkill，
	 * 机读进度会断档 1 秒以上；删目录的重试同理走异步）。
	 *
	 * `graceMs > 0`：先发 `Browser.close` 请浏览器自己退（整棵进程树一起收、文件随即解锁），超时再强制结束。
	 * 实测（2026-10-16）：空闲时自己退出约 0.2 秒、随后删目录 0.2 秒。`graceMs = 0` 立即强制结束。
	 *
	 * 满载时（2026-10-17 实测）：被结束的浏览器进程排不上调度、迟迟退不完（主进程 4–11 分钟），期间握着调试管道（本进程
	 * 退不出）和用户目录、工作目录里的文件；`taskkill /T` 并没有漏掉子进程，它们只是在排队退出。所以结束（或请它自己退）
	 * 之前先把主进程提到「高」优先级（`boostForExit`），强制结束时直接结束主进程，同时按进程树收子进程（同样先提优先级，
	 * 见 `terminateBrowserTree`），收完再删用户目录（`removeProfile`）。重复调用返回同一个 Promise。
	 */
	closeAsync(graceMs = 0): Promise<void> {
		return (this.closing ??= new Promise((res) => {
			let finished = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let forced: Promise<void> | null = null;
			const done = () => {
				if (finished) return;
				finished = true;
				if (timer) clearTimeout(timer);
				this.reapChildren(forced)
					.then(() => this.removeProfile())
					.then(res, () => res());
			};
			if (this.exited || !this.proc.pid) return done();
			const kill = () => {
				if (finished) return;
				// 主进程此刻还活着，进程号不会被复用：子进程创建时刻上限取结束之前的这一刻
				const before = new Date();
				forceKill(this.proc);
				if (process.platform === "win32") forced = this.reapTree(before);
				done();
			};
			if (graceMs <= 0) return kill();
			this.proc.once("exit", done);
			timer = setTimeout(kill, graceMs);
			boostForExit(this.proc);
			this.send("Browser.close", {}, false, graceMs).catch(() => {
				/* 管道已断或没回应：等超时强制结束 */
			});
		}));
	}

	private reapTree(before: Date): Promise<void> {
		this.reaped = true;
		return terminateBrowserTree({ profile: this.profile, pid: this.proc.pid as number, image: this.image, before });
	}

	/**
	 * 主进程退出后收子进程。强制结束时收树已随结束发起（`forced`），等它完成；自己退出的，`REAP_GRACE_MS` 内调试管道
	 * 没关才去结束这棵树里还活着的进程（认法见 `terminateBrowserTree`：用户目录 / 父进程号 + 映像名 + 创建时刻；
	 * MUST NOT 按进程号列表结束）。再等 `REAP_WAIT_MS` 仍没关，松开本端管道，不让本进程陪着等（残留由系统随后回收，
	 * 不影响结果）。
	 */
	private async reapChildren(forced: Promise<void> | null): Promise<void> {
		if (this.pipesClosed) return;
		const closed = new Promise<boolean>((r) => this.proc.once("close", () => r(true)));
		const within = (ms: number) => Promise.race([closed, new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
		if (forced) await forced;
		else if (await within(REAP_GRACE_MS)) return;
		else await this.reapTree(this.exitedAt ?? new Date());
		if (await within(REAP_WAIT_MS)) return;
		// 极端满载（连 PowerShell 都排不上）：不再陪等，交还本进程的退出权
		(this.proc.stdio[3] as Writable | null)?.destroy();
		(this.proc.stdio[4] as Readable | null)?.destroy();
		this.proc.unref();
	}

	/**
	 * 删临时用户目录。删不掉 = 还有子进程握着里面的文件（满载时主进程退了、子进程还在排队退出）：没收过树就收一遍
	 * （提优先级让它们退完）再删；仍删不净的留在系统临时目录，不影响结果。
	 */
	private async removeProfile(): Promise<void> {
		if (await removeDir(this.profile, PROFILE_RM_BUDGET_MS)) return;
		if (this.reaped || process.platform !== "win32" || !this.proc.pid) return;
		await this.reapTree(this.exitedAt ?? new Date());
		await removeDir(this.profile, PROFILE_RM_BUDGET_MS);
	}

	close(): void {
		if (!this.exited && this.proc.pid) {
			if (process.platform === "win32") {
				boostForExit(this.proc);
				spawnSync("taskkill", ["/F", "/T", "/PID", String(this.proc.pid)], { stdio: "ignore" });
			} else this.proc.kill("SIGKILL");
		}
		try {
			rmSync(this.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
		} catch {
			/* 浏览器刚退，个别文件还被占着：留在系统临时目录，不影响结果 */
		}
	}
}

/**
 * 页面里跑的排版自检脚本：颗粒作为顶层页面，自己发 init / apply / lint 给自己，按 seq 收 `lint-result`。
 * 工具箱 `lint()` 查画面几何（描边压画面、线条穿画面、画面出舞台）；之后这里就地再查一项
 * `unpositioned-offset`（change add-composite-lint-unpositioned）：计算样式 position 为 static、却写了非零
 * left / top / right / bottom 的元素——偏移不生效、按文档流排（典型是容器里没写 position:absolute / .abs 的徽章）。
 * 这项只在注入脚本里判、不进工具箱：工具箱字节内联进每颗颗粒、并进烘焙缓存身份，改它要全部重烤。
 * 返回 `{ f, issues }[]`（只含有问题的帧）。
 */
export function layoutLintScript(init: { fps: number; anchors: Record<string, number>; texts: Record<string, unknown> }, frames: number[]): string {
	return `(async () => {
  const msgs = [];
  const stage = document.getElementById("stage");
  // 元素定位符：有 id 用 #id、槽位用 [data-slot="…"]；否则从最近带 id 的祖先（或舞台）起逐级写「标签.首个类名:第几个」
  const keyOf = (el) => {
    if (el === stage) return "舞台";
    const parts = [];
    for (let e = el; e && e !== stage; e = e.parentElement) {
      if (e.id) { parts.unshift("#" + e.id); break; }
      if (e.dataset.slot) { parts.unshift('[data-slot="' + e.dataset.slot + '"]'); break; }
      const cls = e.classList && e.classList[0] ? "." + e.classList[0] : "";
      parts.unshift(e.tagName.toLowerCase() + cls + ":" + (Array.prototype.indexOf.call(e.parentElement.children, e) + 1));
    }
    return parts.join(" > ");
  };
  const offset = (v) => v !== "auto" && parseFloat(v) !== 0;
  const unpositioned = () => {
    const out = [];
    if (!stage) return out;
    for (const el of stage.querySelectorAll("*")) {
      if (el.ownerSVGElement) continue; // SVG 内部元素不吃 CSS 偏移
      const cs = getComputedStyle(el);
      if (cs.position !== "static") continue;
      if (![cs.left, cs.top, cs.right, cs.bottom].some(offset)) continue;
      out.push({ kind: "unpositioned-offset", el: keyOf(el), parent: keyOf(el.parentElement) });
    }
    return out;
  };
  const wait = (pred, ms = 8000) => new Promise((res, rej) => {
    const t = setTimeout(() => { removeEventListener("message", h); rej(new Error("颗粒无回应")); }, ms);
    const h = (ev) => { const m = ev.data; if (m && m.ch === "gtrk-composite" && pred(m)) { clearTimeout(t); removeEventListener("message", h); res(m); } };
    addEventListener("message", h);
  });
  const send = (m) => window.postMessage(Object.assign({ ch: "gtrk-composite" }, m), "*");
  const errs = [];
  addEventListener("message", (ev) => { const m = ev.data; if (m && m.ch === "gtrk-composite" && m.type === "error") errs.push(m.message); });
  let p = wait((m) => m.type === "ready");
  send(Object.assign({ type: "init", layer: "all" }, ${JSON.stringify(init)}));
  await p;
  const out = [];
  for (const f of ${JSON.stringify(frames)}) {
    p = wait((m) => m.type === "lint-result" && m.seq === f + 1);
    send({ type: "apply", seq: f + 1, frame: f });
    send({ type: "lint", seq: f + 1 });
    const r = await p;
    const issues = (r.issues || []).concat(unpositioned());
    if (issues.length) out.push({ f, issues });
  }
  return { samples: out, errors: errs };
})()`;
}

/**
 * 帧纯度机检脚本（change add-composite-bake，design D10）：同一帧号必须画出同一画面。
 * 每个抽样帧渲两次——连续顺序（先渲前一帧）与跳跃顺序（先渲相距半个窗口的帧）——比对舞台内带 `id` 的元素、
 * `data-layer` 子树内的元素与工具箱回报的槽位几何（舞台坐标，容差 0.5px）。只比几何不比像素：像素差还可能来自栅格化。
 * 返回 `{ samples: [{ f, diffs: [{ target, prop, a, b }] }], errors }`（只含有差异的帧）。
 */
export function purityLintScript(init: { fps: number; anchors: Record<string, number>; texts: Record<string, unknown> }, frames: number[], span: number): string {
	return `(async () => {
  const wait = (pred, ms = 8000) => new Promise((res, rej) => {
    const t = setTimeout(() => { removeEventListener("message", h); rej(new Error("颗粒无回应")); }, ms);
    const h = (ev) => { const m = ev.data; if (m && m.ch === "gtrk-composite" && pred(m)) { clearTimeout(t); removeEventListener("message", h); res(m); } };
    addEventListener("message", h);
  });
  const send = (m) => window.postMessage(Object.assign({ ch: "gtrk-composite" }, m), "*");
  const errs = [];
  addEventListener("message", (ev) => { const m = ev.data; if (m && m.ch === "gtrk-composite" && m.type === "error") errs.push(m.message); });
  let p = wait((m) => m.type === "ready");
  send(Object.assign({ type: "init", layer: "all" }, ${JSON.stringify(init)}));
  await p;
  let seq = 100000;
  const apply = async (f) => { const s = ++seq; const q = wait((m) => m.type === "frame" && m.seq === s); send({ type: "apply", seq: s, frame: f }); return (await q).slots; };
  const stage = document.getElementById("stage");
  const keyOf = (el) => {
    if (el.id) return "#" + el.id;
    const parts = [];
    for (let e = el; e && e !== stage; e = e.parentElement) parts.unshift(e.id ? "#" + e.id : e.tagName.toLowerCase() + ":" + (Array.prototype.indexOf.call(e.parentElement.children, e) + 1));
    return parts.join(" > ");
  };
  const geom = (slots) => {
    const s = stage.getBoundingClientRect(), k = s.width / CP.W;
    const out = {};
    const seen = new Set([...stage.querySelectorAll("[id]"), ...stage.querySelectorAll("[data-layer] *")]);
    for (const el of seen) {
      if (el.closest("[data-slot]") === el) continue; // 槽位按工具箱回报的几何比
      const r = el.getBoundingClientRect();
      out[keyOf(el)] = { left: (r.left - s.left) / k, top: (r.top - s.top) / k, width: r.width / k, height: r.height / k };
    }
    for (const g of slots) out["槽位 " + g.id] = { left: g.x, top: g.y, width: g.w, height: g.h, opacity: g.opacity };
    return out;
  };
  const out = [];
  for (const f of ${JSON.stringify(frames)}) {
    const far = (f + Math.max(1, Math.floor(${span} / 2))) % ${span};
    await apply(Math.max(f - 1, 0));
    const a = geom(await apply(f));
    await apply(far);
    const b = geom(await apply(f));
    const diffs = [];
    for (const key of Object.keys(a)) {
      if (!b[key]) continue;
      for (const prop of Object.keys(a[key])) {
        const tol = prop === "opacity" ? 0.002 : 0.5;
        if (Math.abs(a[key][prop] - b[key][prop]) > tol) diffs.push({ target: key, prop, a: a[key][prop], b: b[key][prop] });
      }
    }
    if (diffs.length) out.push({ f, diffs });
  }
  return { samples: out, errors: errs };
})()`;
}
