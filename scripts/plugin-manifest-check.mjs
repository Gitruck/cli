#!/usr/bin/env node
/**
 * 插件市场 / Skills 目录上架闸，prepublishOnly 先跑本闸，任一不过即拒发：
 *
 * 1. Claude Code、Codex、Cursor 三份插件清单（`.claude-plugin/`、`.codex-plugin/`、`.cursor-plugin/` 下的 plugin.json）
 *    的 `version` MUST 与 package.json 一致。插件按 `version` 判更新：发版只改 package.json、漏改清单时，
 *    `/plugin update` 报「已是最新」，从插件市场装的用户就停在旧 Skill 上（Codex 的安装缓存也按版本号分目录）。
 * 2. `.claude/skills/`、`.agents/skills/` 下的仓内开发 Skill（openspec 生成）MUST 带 `metadata.internal: true`。
 *    skills CLI 会扫这两个目录：不标的话 `npx skills add Gitruck/cli` 会把它们和随包 Skill 一起列出、装上，
 *    skills.sh 也会收录。`openspec update` 重新生成这些文件时会把标记冲掉，发版前在这里兜住。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, root), "utf8"));
const pkg = readJson("package.json");
const errors = [];

for (const manifest of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
	const { version } = readJson(manifest);
	if (version !== pkg.version) {
		errors.push(`${manifest} 的 version（${version}）≠ package.json（${pkg.version}）：发版时三份插件清单与 package.json 一起改。`);
	}
}

for (const dir of [".claude/skills", ".agents/skills"]) {
	const base = new URL(`${dir}/`, root);
	if (!existsSync(base)) continue;
	for (const entry of readdirSync(base, { withFileTypes: true })) {
		const rel = `${dir}/${entry.name}/SKILL.md`;
		const file = new URL(rel, root);
		if (!entry.isDirectory() || !existsSync(file)) continue;
		const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
		if (!/^metadata:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+internal:[ \t]*true[ \t]*\r?$/m.test(front)) {
			errors.push(`${rel} 缺 metadata.internal: true（openspec update 后要补回）。`);
		}
	}
}

if (errors.length > 0) {
	for (const message of errors) console.error(message);
	process.exit(1);
}
