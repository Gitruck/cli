/**
 * 版本工具：读当前版本、查 npm 上的最新版、比大小。
 * 供 `gtrk doctor`（提示有无新版）与 `gtrk upgrade`（升级前后对照）复用。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./paths";

// 用「abbreviated packument」拿 dist-tags.latest：比全量元数据小很多，且对 scoped 包稳定。
const REGISTRY = "https://registry.npmjs.org/@gitruck%2Fcli";

/** 当前安装的版本（读随包发布的 package.json，与 --version 同源、不漂移）。 */
export function currentVersion(): string {
	try {
		const { version } = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
			version: string;
		};
		return version;
	} catch {
		return "0.0.0";
	}
}

/** 查 npm 上的最新版本号；网断 / 超时返回 null（best-effort，绝不抛）。 */
export async function latestVersion(timeoutMs = 5000): Promise<string | null> {
	try {
		const res = await fetch(REGISTRY, {
			headers: { accept: "application/vnd.npm.install-v1+json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { "dist-tags"?: { latest?: string } };
		return data["dist-tags"]?.latest ?? null;
	} catch {
		return null;
	}
}

/** semver 比较：a>b→1，a<b→-1，相等→0（只比 major.minor.patch，忽略预发布标记）。 */
export function cmpSemver(a: string, b: string): number {
	const norm = (s: string) =>
		s
			.replace(/^v/, "")
			.split("-")[0]
			.split(".")
			.map((n) => parseInt(n, 10) || 0);
	const pa = norm(a);
	const pb = norm(b);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d > 0 ? 1 : -1;
	}
	return 0;
}
