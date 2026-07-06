/** 包根定位 + 用户级统一目录 ~/.gitruck。 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { cpSync, existsSync, mkdirSync } from "node:fs";

/** 包根定位：从当前模块向上找含 package.json 的目录。
 * 兼容两种布局——dev 跑源码（src/lib/paths.ts）与发布跑打包产物（dist/index.js，所有模块塌进一个文件），
 * 二者的 import.meta.url 深度不同，固定 "../.." 会错位，故向上搜索 package.json 为锚。 */
export function packageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break; // 到盘符根了
		dir = parent;
	}
	return dir;
}

// ---- 用户级统一目录 ~/.gitruck（config / caches / ffmpeg / audio-cache 全归一，未来只保留这一个）----
const LEGACY_HOME = join(homedir(), ".gtrk-cli");
const GITRUCK_HOME = join(homedir(), ".gitruck");

/** 用户级统一目录 ~/.gitruck 的绝对路径。 */
export function gitruckHome(): string {
	return GITRUCK_HOME;
}
/** ~/.gitruck 下的文件绝对路径。 */
export function homeFile(name: string): string {
	return join(GITRUCK_HOME, name);
}
/** ffmpeg/ffprobe 二进制目录 ~/.gitruck/ffmpeg。 */
export function ffmpegDir(): string {
	return join(GITRUCK_HOME, "ffmpeg");
}
/** 本地抽出的音频/720p 代理缓存目录 ~/.gitruck/audio-cache。 */
export function audioCacheDir(): string {
	return join(GITRUCK_HOME, "audio-cache");
}
/** 旧目录 ~/.gtrk-cli（仅迁移用途）。 */
export function legacyHome(): string {
	return LEGACY_HOME;
}

let _migrated = false;
/** 一次性迁移旧 ~/.gtrk-cli → ~/.gitruck：仅当旧目录存在且新目录尚无 config.json 时执行。
 * 幂等（进程内只跑一次 + 新目录已就位则跳过）、不删旧目录（保留观察期）、损坏/失败不阻断
 * （降级为以空目录继续，用户可 gtrk init 重写）。CLI 启动时调一次。 */
export function migrateLegacyHome(): void {
	if (_migrated) return;
	_migrated = true;
	try {
		if (!existsSync(LEGACY_HOME)) return;
		if (existsSync(join(GITRUCK_HOME, "config.json"))) return; // 新目录已就位，不重复迁
		mkdirSync(GITRUCK_HOME, { recursive: true });
		// 复制旧目录内容到新目录：不覆盖已存在项、遇已存在不报错、保留旧目录
		cpSync(LEGACY_HOME, GITRUCK_HOME, { recursive: true, force: false, errorOnExist: false });
	} catch {
		/* 迁移失败不阻断当前命令 */
	}
}
