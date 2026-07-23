/**
 * gtrk upgrade —— 一条命令升级 CLI 到最新版 + 刷新 skill（配置原样保留）。
 *   gtrk upgrade          有新版则升级、通过通用适配器刷新 Agent Skills
 *   gtrk upgrade --check  只查有没有新版、不动手
 * 客户端（桌面端）升级见输出提示：重跑安装脚本即覆盖装最新版，配置不动。
 */
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { currentVersion, latestVersion, cmpSemver } from "../lib/version";
import { log } from "../lib/log";

// 客户端（桌面端）一键升级 = 重跑安装脚本（NSIS 覆盖装最新、per-user、免管理员）。
const CLIENT_UPGRADE = "irm https://api.ai-mcn.tv:9000/broadcast/exe/install.ps1 | iex";

interface UpgradeOpts {
	check?: boolean;
}

/** 走系统 shell 跑命令（npm / gtrk 在 Windows 是 .cmd shim，shell:true 才能按 PATH 解析）。 */
function run(cmd: string): number {
	const r = spawnSync(cmd, { stdio: "inherit", shell: true });
	return r.status ?? 1;
}

export function registerUpgrade(program: Command): void {
	program
		.command("upgrade")
		.description("升级 gtrk CLI 到最新版 + 刷新 skill（配置保留）；--check 只查不装")
		.option("--check", "只检查有没有新版本，不执行升级")
		.action(async (opts: UpgradeOpts) => {
			const cur = currentVersion();
			log.step(`当前 v${cur}，查询最新版…`);
			const latest = await latestVersion();

			if (!latest) {
				log.warn("查不到最新版本（网络问题？）。手动升级：npm i -g @gitruck/cli@latest");
				log.info(`客户端（桌面端）升级：${CLIENT_UPGRADE}`);
				return;
			}
			if (cmpSemver(latest, cur) <= 0) {
				log.ok(`已是最新版 v${cur}。`);
				log.info(`客户端（桌面端）如需升级：${CLIENT_UPGRADE}`);
				return;
			}

			log.info(`发现新版本 v${latest}（当前 v${cur}）。`);
			if (opts.check) {
				log.info("跑 `gtrk upgrade` 升级（会保留你现有的配置）。");
				return;
			}

			// ① 升级全局 CLI 包
			log.step(`① 升级 CLI → v${latest}…`);
			if (run("npm i -g @gitruck/cli@latest") !== 0) {
				log.err("升级失败。手动重试：npm i -g @gitruck/cli@latest（若报权限，按你的 npm 全局目录权限处理）");
				process.exitCode = 1;
				return;
			}

			// ② 用升级后的新版刷新 skill（只装 skill、不碰配置；gtrk shim 已指向新包）
			log.step("② 通过通用适配器刷新 Agent Skills…");
			if (run("gtrk skills install") !== 0) {
				log.warn("skill 没刷成，手动跑一次：gtrk skills install");
			}

			log.ok(`已升级到 v${latest}。配置原样保留，直接接着用即可（gtrk doctor 可自检）。`);
			log.info(`客户端（桌面端）如需一起升级：${CLIENT_UPGRADE}`);
		});
}
