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
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

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

type Pending = { res: (v: Record<string, unknown>) => void; rej: (e: Error) => void };

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

	private constructor(exe: string) {
		this.profile = mkdtempSync(join(tmpdir(), "gtrk-composite-chrome-"));
		this.proc = spawn(
			exe,
			[
				"--headless=new",
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
		this.proc.on("exit", () => {
			this.exited = true;
			for (const p of this.pending.values()) p.rej(new Error("浏览器进程已退出"));
			this.pending.clear();
		});
	}

	/** 起浏览器并开一个 1920×1080 的页面。 */
	static async launch(exe: string): Promise<HeadlessBrowser> {
		const b = new HeadlessBrowser(exe);
		try {
			const { targetId } = (await b.send("Target.createTarget", { url: "about:blank" }, false)) as { targetId: string };
			const { sessionId } = (await b.send("Target.attachToTarget", { targetId, flatten: true }, false)) as { sessionId: string };
			b.sessionId = sessionId;
			await b.send("Page.enable");
			await b.send("Runtime.enable");
			await b.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
			return b;
		} catch (e) {
			b.close();
			throw e;
		}
	}

	send(method: string, params: Record<string, unknown> = {}, onPage = true): Promise<Record<string, unknown>> {
		if (this.exited) return Promise.reject(new Error("浏览器进程已退出"));
		const id = ++this.id;
		const msg: Record<string, unknown> = { id, method, params };
		if (onPage && this.sessionId) msg.sessionId = this.sessionId;
		return new Promise((res, rej) => {
			this.pending.set(id, { res, rej });
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

	/** 打开一个 URL 并等到 load。 */
	async open(url: string, timeoutMs = 30000): Promise<void> {
		const loaded = this.waitEvent("Page.loadEventFired", timeoutMs);
		await this.send("Page.navigate", { url });
		await loaded;
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

	async screenshot(format: "jpeg" | "png" = "jpeg"): Promise<Buffer> {
		const r = (await this.send("Page.captureScreenshot", format === "jpeg" ? { format, quality: 92 } : { format })) as { data: string };
		return Buffer.from(r.data, "base64");
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
