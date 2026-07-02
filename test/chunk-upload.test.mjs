/**
 * 分片上传客户端离线测试（change add-chunked-upload-client tasks 4.x）。
 * 进程内 mock 服务端实现五接口内存版（含故障注入），零真云端依赖。
 * 运行：npm test（esbuild 打包 src/lib/chunk-upload.ts → node --test 本文件）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { CHUNK_THRESHOLD, fastBlake3, uploadChunked } from "../.test-build/chunk-upload.mjs";

// ---------------------------------------------------------------- helpers

/** 与黄金向量同一确定性内容模式：byte[i] = (i*31+7) & 0xFF。 */
function patternBytes(n) {
	const buf = Buffer.alloc(n);
	for (let i = 0; i < n; i++) buf[i] = (i * 31 + 7) & 0xff;
	return buf;
}

let tmp;
before(async () => {
	tmp = await mkdtemp(join(tmpdir(), "gtrk-chunk-test-"));
});

/** 内存版会话存取（生产为 ~/.gtrk-cli/upload-sessions.json）。 */
function memStore() {
	const m = new Map();
	return {
		async load(fp) {
			return m.get(fp);
		},
		async save(fp, rec) {
			m.set(fp, rec);
		},
		async clear(fp) {
			m.delete(fp);
		},
		_map: m,
	};
}

// ---------------------------------------------------------- mock 服务端

const PART_SIZE = 1024; // 测试用小分片（客户端以 init 响应为准，不假设 32MiB）

function makeMockServer() {
	const state = {
		sessions: new Map(), // id -> {size, ext, parts: Map<idx,Buffer>, totalParts}
		seq: 1000,
		assembled: new Map(), // completeId -> Buffer
		putCounts: new Map(), // `${id}:${idx}` -> n
		initCount: 0,
		instantFingerprint: undefined, // 设置后：init 带此 blake3_id → 秒传
		fail502Parts: new Set(), // `${id}:${idx}` 或 `*:${idx}`：下一次 PUT 回 502（一次性）
		reject6026Parts: new Set(), // 同上：下一次 PUT 回 6026（一次性）
		dropPartOnFirstComplete: undefined, // idx：首次 complete 前删掉该片并回 6027
		_droppedOnce: false,
	};

	const json = (res, code, obj) => {
		res.writeHead(code, { "Content-Type": "application/json" });
		res.end(JSON.stringify(obj));
	};
	const envelope = (res, code, msg, data) => json(res, code === 200 ? 200 : 400, { code, msg, data });

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, "http://x");
		const m = req.method;
		const p = url.pathname;

		if (m === "POST" && p === "/base/file/upload/chunk/init") {
			state.initCount++;
			let body = "";
			for await (const c of req) body += c;
			const { filename, size, blake3_id } = JSON.parse(body || "{}");
			if (!filename?.includes(".")) return envelope(res, 6001, "不支持的文件类型");
			if (blake3_id && blake3_id === state.instantFingerprint) {
				return envelope(res, 200, "该文件曾上传过云端~", { file_id: "F-INSTANT", instant: true });
			}
			const id = String(state.seq++);
			const totalParts = Math.ceil(size / PART_SIZE);
			state.sessions.set(id, { size, parts: new Map(), totalParts });
			return envelope(res, 200, "success", {
				upload_id: id,
				part_size: PART_SIZE,
				total_parts: totalParts,
				expires_at: "2099-01-01 00:00:00",
			});
		}

		const putM = p.match(/^\/base\/file\/upload\/chunk\/(\d+)\/(\d+)$/);
		if (m === "PUT" && putM) {
			const [, id, idxS] = putM;
			const idx = Number(idxS);
			const key = `${id}:${idx}`;
			state.putCounts.set(key, (state.putCounts.get(key) ?? 0) + 1);
			if (state.fail502Parts.delete(key) || state.fail502Parts.delete(`*:${idx}`)) {
				res.writeHead(502);
				return res.end("Bad Gateway");
			}
			const s = state.sessions.get(id);
			if (!s) return envelope(res, 6024, "分片上传会话不存在或已过期");
			const chunks = [];
			for await (const c of req) chunks.push(c);
			if (state.reject6026Parts.delete(key) || state.reject6026Parts.delete(`*:${idx}`)) {
				return envelope(res, 6026, "分片内容校验不符，请重传该分片");
			}
			s.parts.set(idx, Buffer.concat(chunks));
			return envelope(res, 200, "success", { received: s.parts.size, total_parts: s.totalParts });
		}

		const oneM = p.match(/^\/base\/file\/upload\/chunk\/(\d+)$/);
		if (m === "GET" && oneM) {
			const s = state.sessions.get(oneM[1]);
			if (!s) return envelope(res, 6024, "分片上传会话不存在或已过期");
			const missing = [];
			for (let i = 0; i < s.totalParts; i++) if (!s.parts.has(i)) missing.push(i);
			return envelope(res, 200, "success", {
				part_size: PART_SIZE,
				total_parts: s.totalParts,
				missing,
				size: s.size,
			});
		}

		const cplM = p.match(/^\/base\/file\/upload\/chunk\/(\d+)\/complete$/);
		if (m === "POST" && cplM) {
			const id = cplM[1];
			const s = state.sessions.get(id);
			if (!s) return envelope(res, 6024, "分片上传会话不存在或已过期");
			if (state.dropPartOnFirstComplete !== undefined && !state._droppedOnce) {
				state._droppedOnce = true;
				s.parts.delete(state.dropPartOnFirstComplete);
			}
			const missing = [];
			for (let i = 0; i < s.totalParts; i++) if (!s.parts.has(i)) missing.push(i);
			if (missing.length) return envelope(res, 6027, `仍有分片缺失：${missing}`);
			const bufs = [];
			for (let i = 0; i < s.totalParts; i++) bufs.push(s.parts.get(i));
			state.assembled.set(id, Buffer.concat(bufs).subarray(0, s.size));
			state.sessions.delete(id);
			return envelope(res, 200, "文件上传成功~", { file_id: `F-${id}` });
		}

		if (m === "DELETE" && oneM) {
			state.sessions.delete(oneM[1]);
			return envelope(res, 200, "success", { aborted: true });
		}

		json(res, 404, { code: 404, msg: "not found" });
	});

	return { server, state };
}

let mock, cfg;
before(async () => {
	mock = makeMockServer();
	await new Promise((r) => mock.server.listen(0, "127.0.0.1", r));
	cfg = { base: `http://127.0.0.1:${mock.server.address().port}`, apiKey: "test-key" };
});
after(() => mock.server.close());
beforeEach(() => {
	const s = mock.state;
	s.sessions.clear();
	s.assembled.clear();
	s.putCounts.clear();
	s.initCount = 0;
	s.instantFingerprint = undefined;
	s.fail502Parts.clear();
	s.reject6026Parts.clear();
	s.dropPartOnFirstComplete = undefined;
	s._droppedOnce = false;
});

// ------------------------------------------------- 4.3 指纹黄金向量对齐

test("fastBlake3 与服务端 fast_mode 逐字节一致（小文件全文）", async () => {
	const f = join(tmp, "small.bin.mp4");
	await writeFile(f, patternBytes(1000));
	// 黄金值：gitruck-infra GetBlake3().get_raw_file_blake3(BytesIO(pattern(1000)), fast_mode=True)
	assert.equal(await fastBlake3(f), "9e488940536ee753d05b6f7f6f40a000d47c9a3fed17f8c241ba1ad5112cbb9a");
});

test("fastBlake3 与服务端 fast_mode 逐字节一致（大文件含阈值块不入哈希怪癖）", async () => {
	const f = join(tmp, "large.bin.mp4");
	await writeFile(f, patternBytes(68_000_000));
	// 黄金值同上，n=68_000_000（> 64MiB，验证 67,100,672 字节截断行为）
	assert.equal(await fastBlake3(f), "cdc127d13971089d4b3bced4e113d78c5af1e10ae697d91503cf2a1ba8b66bb3");
});

// ------------------------------------------------------- 4.2 主流程用例

async function makeFile(name, size) {
	const f = join(tmp, name);
	const content = patternBytes(size);
	await writeFile(f, content);
	return { f, content };
}

test("全新上传：分片数学（含末片余数）+ 字节级还原 + 会话清理", async () => {
	const { f, content } = await makeFile("fresh.mp4", 10 * PART_SIZE + 37);
	const store = memStore();
	const fileId = await uploadChunked(cfg, f, { fingerprint: "fp-fresh", store });
	assert.match(fileId, /^F-\d+$/);
	const assembled = mock.state.assembled.get(fileId.slice(2));
	assert.ok(assembled.equals(content), "装配内容必须与源文件逐字节一致");
	assert.equal(store._map.size, 0, "complete 后本地会话记录必须清除");
});

test("单片文件（size < part_size）", async () => {
	const { f, content } = await makeFile("tiny.mp4", 300);
	const fileId = await uploadChunked(cfg, f, { fingerprint: "fp-tiny", store: memStore() });
	assert.ok(mock.state.assembled.get(fileId.slice(2)).equals(content));
});

test("断点续传：本地会话 + 云端缺片列表 → 只补缺片", async () => {
	const { f, content } = await makeFile("resume.mp4", 8 * PART_SIZE);
	// 先手动建服务端会话并"传好"0..4 片（模拟上次进程被杀前的进度）
	const init = await fetch(`${cfg.base}/base/file/upload/chunk/init`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ filename: "resume.mp4", size: content.length }),
	}).then((r) => r.json());
	const uid = init.data.upload_id;
	for (let i = 0; i < 5; i++) {
		await fetch(`${cfg.base}/base/file/upload/chunk/${uid}/${i}`, {
			method: "PUT",
			body: content.subarray(i * PART_SIZE, (i + 1) * PART_SIZE),
		});
	}
	mock.state.putCounts.clear(); // 只统计续传阶段的 PUT
	const store = memStore();
	await store.save("fp-resume", {
		uploadId: uid, partSize: PART_SIZE, totalParts: 8, size: content.length, path: f, createdAt: 1,
	});

	const fileId = await uploadChunked(cfg, f, { fingerprint: "fp-resume", store });

	assert.ok(mock.state.assembled.get(fileId.slice(2)).equals(content));
	const putIdxes = [...mock.state.putCounts.keys()].map((k) => Number(k.split(":")[1])).sort();
	assert.deepEqual(putIdxes, [5, 6, 7], "只允许补缺的 3 片，不得重传已有片");
});

test("会话过期自动重建一次（本地记录指向云端已消亡的会话）", async () => {
	const { f, content } = await makeFile("rebuild.mp4", 3 * PART_SIZE);
	const store = memStore();
	await store.save("fp-rebuild", {
		uploadId: "999999", partSize: PART_SIZE, totalParts: 3, size: content.length, path: f, createdAt: 1,
	});
	const fileId = await uploadChunked(cfg, f, { fingerprint: "fp-rebuild", store });
	assert.ok(mock.state.assembled.get(fileId.slice(2)).equals(content));
	assert.equal(mock.state.initCount, 1, "重建 = 一次新 init");
});

test("单片 502 瞬态自愈（退避重试，不中断整体）", async () => {
	const { f, content } = await makeFile("t502.mp4", 4 * PART_SIZE);
	mock.state.fail502Parts.add("*:2");
	const fileId = await uploadChunked(cfg, f, { fingerprint: "fp-502", store: memStore() });
	assert.ok(mock.state.assembled.get(fileId.slice(2)).equals(content));
});

test("分片校验不符（6026）自动重传该片", async () => {
	const { f, content } = await makeFile("t6026.mp4", 3 * PART_SIZE);
	mock.state.reject6026Parts.add("*:1");
	const fileId = await uploadChunked(cfg, f, { fingerprint: "fp-6026", store: memStore() });
	assert.ok(mock.state.assembled.get(fileId.slice(2)).equals(content));
});

test("complete 遇 6027 缺片 → status 补片 → 再 complete", async () => {
	const { f, content } = await makeFile("t6027.mp4", 5 * PART_SIZE);
	mock.state.dropPartOnFirstComplete = 3; // 首次 complete 前服务端"丢"第 3 片
	const fileId = await uploadChunked(cfg, f, { fingerprint: "fp-6027", store: memStore() });
	assert.ok(mock.state.assembled.get(fileId.slice(2)).equals(content));
});

test("秒传：指纹命中零分片上传", async () => {
	const { f } = await makeFile("instant.mp4", 2 * PART_SIZE);
	mock.state.instantFingerprint = await fastBlake3(f);
	const store = memStore();
	const fileId = await uploadChunked(cfg, f, { fingerprint: "fp-instant", store });
	assert.equal(fileId, "F-INSTANT");
	assert.equal(mock.state.putCounts.size, 0, "秒传不得上传任何分片");
	assert.equal(store._map.size, 0, "秒传不留会话记录");
});

test("--reupload：跳过会话续传 + 不发秒传指纹，强制整传", async () => {
	const { f, content } = await makeFile("force.mp4", 3 * PART_SIZE);
	mock.state.instantFingerprint = await fastBlake3(f); // 若发指纹会秒传 → 必须没发
	const store = memStore();
	await store.save("fp-force", {
		uploadId: "888888", partSize: PART_SIZE, totalParts: 3, size: content.length, path: f, createdAt: 1,
	});
	const fileId = await uploadChunked(cfg, f, { fingerprint: "fp-force", store, force: true });
	assert.notEqual(fileId, "F-INSTANT", "force 不得命中秒传");
	assert.ok(mock.state.assembled.get(fileId.slice(2)).equals(content));
});

test("业务拒绝（非分片类错误码）立即失败不重试", async () => {
	const f = join(tmp, "noext"); // 无扩展名 → mock 回 6001
	await writeFile(f, patternBytes(100));
	await assert.rejects(
		uploadChunked(cfg, f, { fingerprint: "fp-biz", store: memStore() }),
		/6001/,
	);
	assert.equal(mock.state.initCount, 1, "业务拒绝不得重试 init");
});

test("CHUNK_THRESHOLD 常量导出（路由阈值 256MiB）", () => {
	assert.equal(CHUNK_THRESHOLD, 256 * 1024 * 1024);
});
