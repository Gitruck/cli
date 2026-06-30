/** 包根定位：从当前模块向上找含 package.json 的目录。
 * 兼容两种布局——dev 跑源码（src/lib/paths.ts）与发布跑打包产物（dist/index.js，所有模块塌进一个文件），
 * 二者的 import.meta.url 深度不同，固定 "../.." 会错位，故向上搜索 package.json 为锚。 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

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
