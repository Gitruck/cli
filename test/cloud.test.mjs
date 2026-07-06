import { test } from "node:test";
import assert from "node:assert/strict";
import { getTaskResult } from "../.test-build/cloud.mjs";

const cfg = { base: "http://x", apiKey: "k" };
const resp = (obj) => new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } });

test("getTaskResult: completed 返回 status+progress+output", async () => {
	const orig = globalThis.fetch;
	globalThis.fetch = async () =>
		resp({
			code: 200,
			data: {
				status: "completed",
				progress: 100,
				output_result: {
					report: { coverage: 0.9 },
					files: [{ type: "project", format: "gtrk", download_url: "u", filename: "project.gtrk" }],
				},
			},
		});
	try {
		const r = await getTaskResult(cfg, "cli/video_oral_cut_for_cli", "T1");
		assert.equal(r.status, "completed");
		assert.equal(r.progress, 100);
		assert.equal(r.output.files[0].format, "gtrk");
		assert.equal(r.output.report.coverage, 0.9);
	} finally {
		globalThis.fetch = orig;
	}
});

test("getTaskResult: 非 completed 保留 status/progress（不丢弃）", async () => {
	const orig = globalThis.fetch;
	globalThis.fetch = async () => resp({ code: 200, data: { status: "processing", progress: 42, output_result: {} } });
	try {
		const r = await getTaskResult(cfg, "tt", "T1");
		assert.equal(r.status, "processing");
		assert.equal(r.progress, 42);
	} finally {
		globalThis.fetch = orig;
	}
});

test("getTaskResult: 非 200 code 抛 CloudError（带 code，供上层提示 TASK_NOT_FOUND）", async () => {
	const orig = globalThis.fetch;
	globalThis.fetch = async () => resp({ code: 6006, msg: "找不到此任务" });
	try {
		await assert.rejects(
			() => getTaskResult(cfg, "tt", "T1"),
			(e) => {
				assert.equal(e.code, 6006);
				assert.match(e.message, /6006|找不到/);
				return true;
			},
		);
	} finally {
		globalThis.fetch = orig;
	}
});
