/**
 * 机读进度的输出线程（change add-composite-bake，规格「机读进度、取消与 ABI」：相邻两行 ≤ 1 秒）。
 *
 * JSONL 行由独立的 worker 线程写 stdout，静默超过 `keepaliveMs` 时重发上一条阶段事件。
 * 为什么不在主线程写：Windows 上起子进程（ffmpeg / ffprobe / 浏览器）是同步的，机器满载时单次能卡住主线程近 1 秒
 * （apply 时 CPU 剖析实测 874 毫秒，连着几次出现过 2.4 秒断档），主线程上的定时器跟着停摆；worker 线程不受影响。
 * 本对象在用期间，调用方 MUST NOT 再经 `process.stdout` 写东西（两边并发写会交错）。
 */
import { Worker } from "node:worker_threads";

const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
let last = null, lastAt = Date.now(), broken = false;
const pause = new Int32Array(new SharedArrayBuffer(4));
function write(s) {
  if (broken) return;
  const buf = Buffer.from(s + "\\n");
  for (let off = 0; off < buf.length; ) {
    try { off += fs.writeSync(1, buf, off); }
    catch (e) {
      if (e.code === "EAGAIN") { Atomics.wait(pause, 0, 0, 5); continue; }
      broken = true; // 读端关了（EPIPE 等）：不再写，交给主线程按取消处理
      return;
    }
  }
  lastAt = Date.now();
}
const timer = setInterval(() => { if (last !== null && Date.now() - lastAt >= workerData.keepaliveMs) write(last); }, 100);
parentPort.on("message", (m) => {
  if (m.line !== undefined) { write(m.line); if (m.status) last = m.line; }
  if (m.end) { clearInterval(timer); parentPort.postMessage("ended"); }
});
`;

export class JsonlOut {
	private worker: Worker;
	private ended: Promise<void>;

	constructor(keepaliveMs = 600) {
		this.worker = new Worker(WORKER_SRC, { eval: true, workerData: { keepaliveMs } });
		this.worker.on("error", () => {});
		this.ended = new Promise((res) => {
			this.worker.on("message", (m) => m === "ended" && res());
			this.worker.on("exit", () => res());
		});
	}

	/** 写一行；`status` = 阶段事件（静默时会被重发）。 */
	line(obj: unknown, status = false): void {
		this.worker.postMessage({ line: JSON.stringify(obj), status });
	}

	/** 写完已投递的行后结束线程。 */
	async close(): Promise<void> {
		this.worker.postMessage({ end: true });
		await this.ended;
		await this.worker.terminate();
	}
}
