import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeResult, baseFormat } from "../.test-build/materialize.mjs";

test("baseFormat: 细分格式归一到基础格式", () => {
	assert.equal(baseFormat("jianying_draft"), "jianying");
	assert.equal(baseFormat("jianying_meta"), "jianying");
	assert.equal(baseFormat("capcut_x"), "capcut");
	assert.equal(baseFormat("xml"), "xml");
	assert.equal(baseFormat("gtrk"), "gtrk");
});

test("materializeResult: 下载 404（产物过期）容错——报告仍落盘、不整体抛", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gtrk-mat-"));
	try {
		const output = {
			report: { coverage: 0.99, duration_after: 100 },
			files: [
				{ type: "project", format: "gtrk", download_url: "http://x/g", filename: "project.gtrk" },
				{ type: "project", format: "xml", download_url: "http://x/x", filename: "premiere.xml" },
			],
			errors: {},
		};
		const fakeDownload = async (url) => {
			throw new Error(`下载失败 HTTP 404：${url}`);
		};
		const r = await materializeResult({ outDir: dir, output, taskId: "T1", json: true, open: false, download: fakeDownload });
		const rj = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
		assert.equal(rj.report.coverage, 0.99); // 报告落盘
		assert.equal(rj.ok, false); // 有 errors → ok=false
		assert.ok(Object.keys(rj.errors).length >= 2); // 两个产物都记入 errors
		assert.equal(r.report.coverage, 0.99);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("materializeResult: 成功下载按 baseFormat 分组 + result.json 两段写", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gtrk-mat-"));
	try {
		const output = {
			report: { coverage: 1 },
			files: [
				{ type: "project", format: "gtrk", download_url: "http://x/g", filename: "project.gtrk" },
				{ type: "project", format: "jianying_draft", download_url: "http://x/j", filename: "draft_content.json" },
			],
			errors: {},
		};
		const fakeDownload = async (_url, dest) => {
			await writeFile(dest, "x");
		};
		const r = await materializeResult({ outDir: dir, output, taskId: "T2", json: true, open: false, download: fakeDownload });
		assert.ok(r.files.gtrk[0].endsWith("project.gtrk"));
		assert.ok(r.files.jianying[0].endsWith("draft_content.json")); // jianying_draft → jianying
		assert.equal(r.ok, true);
		const rj = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
		assert.ok(rj.files.gtrk); // 末段补写了解析后的本地路径
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("materializeResult: 无产物即抛（对齐主命令旧行为）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gtrk-mat-"));
	try {
		await assert.rejects(
			() => materializeResult({ outDir: dir, output: { report: {}, files: [], errors: {} }, taskId: "T3", json: true, open: false }),
			/无工程文件产物/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
