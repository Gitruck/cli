#!/usr/bin/env node
/**
 * Claude Code 插件 / Skills 目录上架闸，prepublishOnly 先跑本闸，任一不过即拒发：
 *
 * 1. `.claude-plugin/plugin.json` 的 `version` MUST 与 package.json 一致。
 *    插件按 `version` 判更新：发版只改 package.json、漏改 plugin.json 时，`/plugin update` 报「已是最新」，
 *    从插件市场装的用户就停在旧 Skill 上。
 * 2. `.claude/skills/`、`.agents/skills/` 下的仓内开发 Skill（openspec 生成）MUST 带 `metadata.internal: true`。
 *    skills CLI 会扫这两个目录：不标的话 `npx skills add Gitruck/cli` 会把它们和随包 Skill 一起列出、装上，
 *    skills.sh 也会收录。`openspec update` 重新生成这些文件时会把标记冲掉，发版前在这里兜住。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, root), "utf8"));
const pkg = readJson("package.json");
const plugin = readJson(".claude-plugin/plugin.json");
const errors = [];

if (plugin.version !== pkg.version) {
	errors.push(`.claude-plugin/plugin.json 的 version（${plugin.version}）≠ package.json（${pkg.version}）：发版时两处一起改。`);
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
