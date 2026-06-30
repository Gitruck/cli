/** 用系统默认程序打开文件夹 / 文件（Windows / macOS / Linux）。打不开不致命。 */
import { spawn } from "node:child_process";

/** 在文件管理器里打开文件夹。 */
export function openFolder(dir: string): void {
	const plat = process.platform;
	const cmd =
		plat === "win32" ? ["explorer", dir] : plat === "darwin" ? ["open", dir] : ["xdg-open", dir];
	launch(cmd);
}

/** 用默认程序打开文件（如图片用看图器）。 */
export function openFile(path: string): void {
	const plat = process.platform;
	const cmd =
		plat === "win32"
			? ["cmd", "/c", "start", "", path] // start 的首个引号参数是窗口标题，必须留空占位
			: plat === "darwin"
				? ["open", path]
				: ["xdg-open", path];
	launch(cmd);
}

/** 后台 fire-and-forget 启动：不阻塞、detached+unref 不随父进程退出。 */
function launch(cmd: string[]): void {
	try {
		spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).unref();
	} catch {
		/* 打不开不致命，路径已打印 */
	}
}
