#!/usr/bin/env node
/**
 * Claude Code 插件清单版本闸：`.claude-plugin/plugin.json` 的 `version` MUST 与 package.json 一致。
 *
 * 插件按 `version` 判更新：发版只改 package.json、漏改 plugin.json 时，`/plugin update` 报「已是最新」，
 * 从插件市场装的用户就停在旧 Skill 上。prepublishOnly 先跑本闸，不一致即拒发。
 */
import { readFileSync } from "node:fs";

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const pkg = readJson("../package.json");
const plugin = readJson("../.claude-plugin/plugin.json");

if (plugin.version !== pkg.version) {
	console.error(
		`.claude-plugin/plugin.json 的 version（${plugin.version}）≠ package.json（${pkg.version}）：发版时两处一起改。`,
	);
	process.exit(1);
}
