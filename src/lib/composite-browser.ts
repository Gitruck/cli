/**
 * 本机 Chromium 系浏览器的无头驱动（change add-composite-layer，design D5 / DP-2）：合成颗粒的逐帧排版机检与静帧。
 *
 * - 不加 npm 依赖：用本机已装的 Chrome / Edge（Windows 必有 Edge），找不到就如实报「排版未机检」。
 * - 走 `--remote-debugging-pipe`（CDP 消息经 fd 3 / 4 的管道、NUL 分隔），不开端口、不依赖 WebSocket
 *   （Node 20 没有全局 WebSocket，本仓 engines 是 >=20.6）。
 * - 进程树收干净：Chrome 会拉起一串子进程，Windows 上按进程树 taskkill。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	private mode: LaunchMode;
	private frameTicks = 0;
	private lastFrame: Buffer | null = null;
	private beginFrameReady = false;

	private constructor(exe: string, mode: LaunchMode) {
		this.mode = mode;
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
				"--window-size=1920,1080",
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
		this.proc.on("exit", () => fail("浏览器进程已退出"));
	}

	/**
	 * 起浏览器并开一个 1920×1080 的页面。
	 * - `default`：既有行为（lint / 静帧），新无头模式、截图；
	 * - `beginframe`：chrome-headless-shell 确定性出帧（烘焙首选）；
	 * - `screenshot-soft`：系统浏览器烘焙退路（截图，软件栅格、关局部重绘）。
	 */
	static async launch(exe: string, mode: LaunchMode = "default"): Promise<HeadlessBrowser> {
		const b = new HeadlessBrowser(exe, mode);
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
			await b.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
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
	 * 实测（2026-10-16）：强制结束本身 0.5–0.8 秒，但子进程还占着用户目录里的文件，删目录要重试到 1.6–26 秒；
	 * 自己退出约 0.2 秒、随后删目录 0.2 秒。取消 / 出错时传 0（立即结束，不等）。
	 */
	closeAsync(graceMs = 0): Promise<void> {
		return new Promise((res) => {
			let finished = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				if (finished) return;
				finished = true;
				if (timer) clearTimeout(timer);
				// 浏览器刚退，个别文件还被占着时删不掉：留在系统临时目录，不影响结果
				rm(this.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).then(res, () => res());
			};
			if (this.exited || !this.proc.pid) return done();
			const kill = () => {
				if (finished) return;
				if (process.platform === "win32") spawn("taskkill", ["/F", "/T", "/PID", String(this.proc.pid)], { stdio: "ignore" }).on("close", done);
				else {
					this.proc.kill("SIGKILL");
					done();
				}
			};
			if (graceMs <= 0) return kill();
			this.proc.once("exit", done);
			timer = setTimeout(kill, graceMs);
			this.send("Browser.close", {}, false, graceMs).catch(() => {
				/* 管道已断或没回应：等超时强制结束 */
			});
		});
	}

	close(): void {
		if (!this.exited && this.proc.pid) {
			if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(this.proc.pid)], { stdio: "ignore" });
			else this.proc.kill("SIGKILL");
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
 * 返回 `{ f, issues }[]`（只含有问题的帧）。
 */
export function layoutLintScript(init: { fps: number; anchors: Record<string, number>; texts: Record<string, unknown> }, frames: number[]): string {
	return `(async () => {
  const msgs = [];
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
    if (r.issues && r.issues.length) out.push({ f, issues: r.issues });
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
