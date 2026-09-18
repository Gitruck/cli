/** 极简终端输出（无依赖）。所有面向用户文字用简体中文。 */
const c = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

// 人读日志默认走 stdout；--json 模式调 routeLogsToStderr() 后全转 stderr，stdout 只留机读 JSON。
let humanOut: NodeJS.WriteStream = process.stdout;

/** --json 模式：把人读日志全部转到 stderr，保持 stdout 纯净（只输出最终 JSON）。 */
export function routeLogsToStderr(): void {
	humanOut = process.stderr;
}

/**
 * 读端已经没了的具名码（change `fix-local-io-environment-failures` · design D2）。
 *
 * 生产报错 `base_error#179`：`gtrk … | head` 之类把读端关掉之后，这里一行进度日志
 * 就抛 `EPIPE` 一路炸到顶层，被当成崩溃上报，退出路上还要等最多 2 s 发一个网络请求
 * ——发给一个已经没人在看的终端。
 *
 * ⚠️ **只吞这两个码。** 其他写入失败（重定向到文件时的 `ENOSPC` 之类）照旧抛：
 * 那是真出事了，吞掉等于让用户拿着一份不完整的输出以为没事。
 */
const DEAD_STREAM_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);

/**
 * 已经写不动的流。**按流分记**：`--json` 模式下 stdout 走机读、stderr 走人读，
 * 只关掉其中一个是常见形态；共用一个闩会让另一个也跟着哑掉。
 */
const deadStreams = new Set<NodeJS.WritableStream>();

/** 单测注入旋钮（形制同 `crash-report.ts` 的 `__crashReportIo`）。**生产恒 `null`**。 */
export const __logIo: {
	impl: null | { human?: NodeJS.WritableStream; err?: NodeJS.WritableStream };
} = { impl: null };

const humanStream = (): NodeJS.WritableStream => __logIo.impl?.human ?? humanOut;
const errStream = (): NodeJS.WritableStream => __logIo.impl?.err ?? process.stderr;

/**
 * 往呈现流写一段。读端没了就就地熄火，**不炸业务** ——
 * gtrk 的交付物是磁盘上的文件，终端里的字只是呈现。
 */
function writeTo(stream: NodeJS.WritableStream, chunk: string): void {
	if (deadStreams.has(stream)) return;
	try {
		stream.write(chunk);
	} catch (e) {
		const code = (e as { code?: unknown }).code;
		if (typeof code === "string" && DEAD_STREAM_CODES.has(code)) {
			deadStreams.add(stream);
			return;
		}
		throw e;
	}
}

/**
 * 装进程级呈现流守卫：收 `stdout` / `stderr` 的**异步**写入失败。
 *
 * `writeTo` 收的是同步抛那条（`base_error#179` 的栈就是同步抛）；
 * 流已排队时 Node 走 `error` 事件，那条在这里收。**两条都堵住才算堵住**（design D2）。
 * ⚠️ 只吞具名两码，其余重抛 —— 真出事的写入失败照旧落到 uncaughtException 与崩溃上报。
 *
 * 幂等：重复调用只装一次。
 */
let guardsInstalled = false;
export function installStreamGuards(): void {
	if (guardsInstalled) return;
	guardsInstalled = true;
	for (const stream of [process.stdout, process.stderr]) {
		stream.on("error", (e: NodeJS.ErrnoException) => {
			if (typeof e?.code === "string" && DEAD_STREAM_CODES.has(e.code)) {
				deadStreams.add(stream);
				return;
			}
			throw e;
		});
	}
}

/** 仅供单测：清空熄火闩与注入面（生产代码不该调）。 */
export function resetLogStreamState(): void {
	deadStreams.clear();
	__logIo.impl = null;
}

const line = (s: string) => writeTo(humanStream(), `${s}\n`);

export const log = {
	/** 主步骤（带 ① ② 序号自己传）。 */
	step: (msg: string) => line(c.cyan(msg)),
	/** 缩进的细节行。 */
	info: (msg: string) => line(c.dim(`   ${msg}`)),
	ok: (msg: string) => line(c.green(`✅ ${msg}`)),
	warn: (msg: string) => line(c.yellow(`⚠️  ${msg}`)),
	/** 错误始终走 stderr。 */
	err: (msg: string) => writeTo(errStream(), `${c.red(`❌ ${msg}`)}\n`),
	/** 原地刷新（轮询进度用），不换行。 */
	tick: (msg: string) => writeTo(humanStream(), `\r   ${msg}\x1b[K`),
	tickEnd: () => writeTo(humanStream(), "\n"),
};
