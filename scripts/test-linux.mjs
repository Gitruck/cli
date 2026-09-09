#!/usr/bin/env node
/**
 * 在 Linux 容器里跑一遍全量测试 —— 开发机是 Windows，而 parity CI 是 Linux。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 一批缺陷**只在 Linux 上现形**，在 Windows 开发机上永远看不见：
 *
 *   · 路径语义 —— `node:path` 裸导出的 `join` 走宿主机平台（2026-09-09，10 条红）
 *   · 文件系统大小写 —— NTFS 不区分、ext4 区分（`a50a4a7`）
 *   · 容器内以 root 跑 —— chmod 造的「不可写」夹具对 root 无效（`cbce517`）
 *   · runner 上没装 ffmpeg（`fc39527`）
 *
 * 这些的代价一律是「推上去、CI 红、main 挡着不敢发版」。本脚本把那一刻提前到推之前。
 *
 * ── 与源码守卫的分工 ────────────────────────────────────────────────
 * `test/windows-fixture-path-semantics.test.mjs` 是**词法守卫**：秒级、日常改动跑，
 * 但只拦**已知形状**。本脚本兜**未知形状**，代价是几分钟。两者互不替代 ——
 * 2026-09-09 当天各自抓到了对方抓不到的东西。
 *
 * ── 什么时候跑 ──────────────────────────────────────────────────────
 * **发版前**、**动了跨平台面的代码后**（路径 / 文件系统 / 子进程 / 环境探测）跑一次。
 * 刻意**不挂进 pre-push**：每次 push 都等几分钟，人就会开始 `--no-verify`，那等于没有。
 *
 * 用法：`npm run test:linux`
 */
import { spawnSync } from "node:child_process";

const REPO = process.cwd();
const IMAGE = "node:22";
/** bun 的下载缓存留成具名卷，重复跑时 `bun install` 走缓存、快很多。 */
const BUN_CACHE_VOLUME = "gtrk-cli-bun-cache";

function die(msg) {
	console.error("\n❌ " + msg + "\n");
	process.exit(1);
}

const probe = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
if (probe.error) {
	die("找不到 docker 命令。装 Docker Desktop（Windows）或 docker engine（Linux）后再跑。");
}
if (probe.status !== 0) {
	die(
		"docker 命令在，但**守护进程没起**（Docker Desktop 未启动）。\n" +
			"   启动 Docker Desktop、等托盘图标变绿，再跑一次。\n" +
			"   原始报错：" +
			String(probe.stderr || "").trim().split("\n")[0],
	);
}

console.log(`[test:linux] docker server ${probe.stdout.trim()}｜镜像 ${IMAGE}｜仓库 ${REPO}`);
console.log("[test:linux] 首跑要拉镜像 + 装 bun，约几分钟；之后 bun 缓存走具名卷会快不少。\n");

// node_modules 与 .test-build 用**匿名卷**盖住宿主机的那份：
// 前者装着 Windows 的原生二进制（esbuild 一类），直接挂进 Linux 必崩；
// 后者是构建产物，让容器写进卷里，宿主机工作区保持干净。
const args = [
	"run",
	"--rm",
	"-v",
	`${REPO}:/w`,
	"-v",
	"/w/node_modules",
	"-v",
	"/w/.test-build",
	"-v",
	`${BUN_CACHE_VOLUME}:/root/.bun/install/cache`,
	"-w",
	"/w",
	IMAGE,
	"sh",
	"-c",
	[
		"set -e",
		"npm i -g bun --silent >/dev/null 2>&1",
		'echo "[test:linux] bun $(bun --version) / node $(node -v)"',
		"bun install --frozen-lockfile >/dev/null 2>&1",
		'echo "[test:linux] 依赖就位，开跑"',
		"npm test",
	].join(" && "),
];

const run = spawnSync("docker", args, { stdio: "inherit" });
if (run.status !== 0) {
	console.error(
		"\n❌ Linux 车道未通过。\n" +
			"   这些红在 Windows 上多半复现不出来 —— 别用「我这儿是绿的」当结论。\n" +
			"   常见成因：路径分隔符 / 文件系统大小写 / 容器内是 root / 镜像里没装 ffmpeg。\n",
	);
	process.exit(run.status ?? 1);
}
console.log("\n✅ Linux 车道通过。");
