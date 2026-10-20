/** 用系统默认程序打开文件夹 / 文件（Windows / macOS / Linux）。打不开不致命。 */
import { spawn } from "node:child_process";
import { win32 } from "node:path";

/** Windows 的系统程序不依赖调用环境的 PATH；无可信系统目录时沿用系统查找。 */
function windowsProgram(name: string, system32 = false): string {
	const root = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir;
	return root && win32.isAbsolute(root)
		? win32.join(root, ...(system32 ? ["System32"] : []), name)
		: name;
}

/** 在文件管理器里打开文件夹。 */
export function openFolder(dir: string): void {
	const plat = process.platform;
	const cmd =
		plat === "win32" ? [windowsProgram("explorer.exe"), dir] : plat === "darwin" ? ["open", dir] : ["xdg-open", dir];
	launch(cmd, dir, "目录");
}

/** 用默认程序打开文件（如图片用看图器）。 */
export function openFile(path: string): void {
	const plat = process.platform;
	const cmd =
		plat === "win32"
			? [windowsProgram("cmd.exe", true), "/d", "/c", "start", "", path] // start 首个引号参数是窗口标题
			: plat === "darwin"
				? ["open", path]
				: ["xdg-open", path];
	launch(cmd, path, "文件");
}

/** 后台 fire-and-forget 启动：不阻塞、detached+unref 不随父进程退出。 */
function launch(cmd: string[], path: string, kind: string): void {
	let warned = false;
	const warn = (reason: string): void => {
		if (warned) return;
		warned = true;
		// 自动打开仅为辅助操作；stdout 保留给业务回执（包括 --json）。
		process.stderr.write(`无法自动打开${kind}（${reason}），请手动打开：${path}\n`);
	};
	try {
		const child = spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true });
		child.once("error", (error: NodeJS.ErrnoException) => warn(error.code ?? "启动失败"));
		child.once("exit", (code, signal) => {
			if (code !== 0) warn(signal ? `进程终止 ${signal}` : `退出码 ${code}`);
		});
		child.unref();
	} catch (error) {
		warn((error as NodeJS.ErrnoException).code ?? "启动失败");
	}
}
