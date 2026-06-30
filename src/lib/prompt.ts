/**
 * 极简交互输入（零依赖）——关键诉求：支持 Ctrl+V 粘贴。
 *
 * 为什么不用 @clack/prompts：clack 把终端切到 raw mode，会顶掉 Windows 经典 cmd 原生的 Ctrl+V
 * 粘贴（小白只会 Ctrl+V、不懂右键粘贴，直接卡死）。本组件在 raw mode 下自己接管 Ctrl+V（\x16）→
 * 读系统剪贴板插入；右键粘贴（字符直接灌进 stdin）也照常支持。
 */
import { stdin, stdout } from "node:process";
import { spawnSync } from "node:child_process";

const c = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/** 读系统剪贴板（Win: Get-Clipboard / mac: pbpaste / Linux: xclip|wl-paste）。失败返回空串。 */
function readClipboard(): string {
	try {
		if (process.platform === "win32") {
			const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard"], {
				encoding: "utf8",
			});
			return (r.stdout ?? "").replace(/\r?\n$/, "");
		}
		if (process.platform === "darwin") {
			return spawnSync("pbpaste", { encoding: "utf8" }).stdout ?? "";
		}
		const x = spawnSync("xclip", ["-selection", "clipboard", "-o"], { encoding: "utf8" });
		if (x.status === 0) return x.stdout ?? "";
		return spawnSync("wl-paste", ["-n"], { encoding: "utf8" }).stdout ?? "";
	} catch {
		return "";
	}
}

function ask(message: string, opts: { mask?: boolean; defaultValue?: string } = {}): Promise<string> {
	return new Promise((resolve) => {
		const hint = opts.defaultValue ? c.dim(` (${opts.defaultValue})`) : "";
		stdout.write(`${c.cyan("?")} ${message}${hint} `);
		let value = "";
		const echo = (s: string) => stdout.write(opts.mask ? "•".repeat([...s].length) : s);
		const wasRaw = stdin.isRaw ?? false;
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.setEncoding("utf8");

		const cleanup = () => {
			stdin.off("data", onData);
			stdin.setRawMode?.(wasRaw);
			stdin.pause();
		};
		const onData = (chunk: string) => {
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n") {
					stdout.write("\n");
					cleanup();
					resolve(value || opts.defaultValue || "");
					return;
				}
				if (ch === "\x03") {
					// Ctrl+C
					stdout.write("\n");
					cleanup();
					process.exit(130);
				}
				if (ch === "\x16") {
					// Ctrl+V → 系统剪贴板
					const clip = readClipboard().replace(/[\r\n]+/g, "");
					value += clip;
					echo(clip);
					continue;
				}
				if (ch === "\x7f" || ch === "\b") {
					// 退格
					if (value.length) {
						value = value.slice(0, -1);
						stdout.write("\b \b");
					}
					continue;
				}
				if (ch.charCodeAt(0) >= 32) {
					// 可打印字符（含右键粘贴灌进来的字符流）
					value += ch;
					echo(ch);
				}
			}
		};
		stdin.on("data", onData);
	});
}

/** 明文输入。回车留空则用 defaultValue。 */
export function promptText(message: string, opts: { defaultValue?: string } = {}): Promise<string> {
	return ask(message, { defaultValue: opts.defaultValue });
}

/** 掩码输入（密码 / API Key）。粘贴成功会显示等量圆点，便于确认粘进去了。 */
export function promptSecret(message: string): Promise<string> {
	return ask(message, { mask: true });
}

/** y/n 确认，回车用默认。 */
export async function promptConfirm(message: string, defaultYes = true): Promise<boolean> {
	const a = (await ask(`${message} ${c.dim(defaultYes ? "[Y/n]" : "[y/N]")}`)).trim().toLowerCase();
	if (!a) return defaultYes;
	return a === "y" || a === "yes";
}
