/**
 * gtrk doctor —— 一键体检：配置 / 云端连通 / 剪映目录 / 运行时是否就绪。
 * 排障入口（对标飞书 lark-cli 的 auth check）。非交互、只读，不改任何配置。
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import { readUserConfig, configPath, DEFAULT_API_BASE } from "../lib/user-config";
import { resolveJianyingDraftDir } from "../lib/jianying";
import { currentVersion, latestVersion, cmpSemver } from "../lib/version";

export function registerDoctor(program: Command): void {
	program
		.command("doctor")
		.description("体检：配置 / 云端连通 / 剪映目录 / 运行时是否就绪")
		.action(async () => {
			await runDoctor();
		});
}

type Status = "ok" | "warn" | "fail";
const MARK: Record<Status, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };

interface Row {
	name: string;
	status: Status;
	detail: string;
}

export async function runDoctor(): Promise<boolean> {
	const rows: Row[] = [];

	// 后台查最新版（与下面的云端连通检查并行，不额外拖慢体检）
	const latestP = latestVersion(5000).catch(() => null);

	const bunVer = (process.versions as { bun?: string }).bun;
	rows.push({
		name: "运行时",
		status: "ok",
		detail: bunVer ? `bun ${bunVer}` : `node ${process.version}`,
	});

	const uc = readUserConfig();
	const apiKey = (process.env.GITRUCK_API_KEY ?? uc.apiKey ?? "").trim();
	const apiBase = (process.env.GITRUCK_API_BASE ?? uc.apiBase ?? DEFAULT_API_BASE)
		.trim()
		.replace(/\/+$/, "");
	rows.push({
		name: "API Key",
		status: apiKey ? "ok" : "fail",
		detail: apiKey
			? `已配（${apiKey.slice(0, 6)}…，来源 ${process.env.GITRUCK_API_KEY ? "环境变量" : "gtrk init"}）`
			: "未配 —— 跑 gtrk init",
	});
	rows.push({ name: "API 根地址", status: "ok", detail: apiBase });

	// 云端连通 + 鉴权：实打一发受保护接口（POST /user/get_user_info 带 Authorization）。
	// 比 GET 根路径（永远 404、误导人）有意义——拿到 code=200 才算真通且 Key 有效。
	let apiStatus: Status = "warn";
	let apiDetail = "跳过（未配 Key）";
	if (apiKey) {
		try {
			const res = await fetch(`${apiBase}/user/get_user_info`, {
				method: "POST",
				headers: { accept: "application/json", Authorization: apiKey },
				body: "",
				signal: AbortSignal.timeout(8000),
			});
			const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
			if (data.code === 200) {
				apiStatus = "ok";
				apiDetail = "可达，鉴权通过";
			} else {
				apiStatus = "fail";
				apiDetail = `可达，但鉴权失败（code=${data.code ?? res.status}${data.msg ? `，${data.msg}` : ""}）—— 检查 API Key`;
			}
		} catch (e) {
			apiStatus = "fail";
			apiDetail = `连不上：${e instanceof Error ? e.message : String(e)}`;
		}
	}
	rows.push({ name: "云端连通 + 鉴权", status: apiStatus, detail: apiDetail });

	const draftDir = resolveJianyingDraftDir(undefined);
	const draftOk = !!draftDir && existsSync(draftDir);
	rows.push({
		name: "剪映草稿目录",
		status: draftOk ? "ok" : "warn",
		detail: draftOk ? (draftDir as string) : "未配/未探到 —— 要剪映直开就跑 gtrk init 或加 --jianying-draft-dir",
	});

	rows.push({
		name: "配置文件",
		status: existsSync(configPath()) ? "ok" : "warn",
		detail: existsSync(configPath()) ? configPath() : `未生成 —— 跑 gtrk init（${configPath()}）`,
	});

	// CLI 版本（best-effort，查不到就只显当前版本、不判 fail；有新版给升级提示、但不致 doctor 失败）
	const cur = currentVersion();
	const latest = await latestP;
	rows.splice(1, 0, {
		name: "CLI 版本",
		status: latest && cmpSemver(latest, cur) > 0 ? "warn" : "ok",
		detail:
			latest && cmpSemver(latest, cur) > 0
				? `v${cur} —— 有新版 v${latest}，跑 gtrk upgrade 升级`
				: latest
					? `v${cur}（已是最新）`
					: `v${cur}`,
	});

	console.log("\ngtrk 体检：\n");
	for (const r of rows) console.log(`  ${MARK[r.status]} ${r.name}：${r.detail}`);
	const failed = rows.some((r) => r.status === "fail");
	console.log(failed ? "\n有项不通，按提示处理后再开剪。\n" : "\n一切就绪，可以开剪。\n");
	if (failed) process.exitCode = 1;
	return !failed;
}
