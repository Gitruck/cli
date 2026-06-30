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

const line = (s: string) => humanOut.write(`${s}\n`);

export const log = {
	/** 主步骤（带 ① ② 序号自己传）。 */
	step: (msg: string) => line(c.cyan(msg)),
	/** 缩进的细节行。 */
	info: (msg: string) => line(c.dim(`   ${msg}`)),
	ok: (msg: string) => line(c.green(`✅ ${msg}`)),
	warn: (msg: string) => line(c.yellow(`⚠️  ${msg}`)),
	/** 错误始终走 stderr。 */
	err: (msg: string) => process.stderr.write(`${c.red(`❌ ${msg}`)}\n`),
	/** 原地刷新（轮询进度用），不换行。 */
	tick: (msg: string) => humanOut.write(`\r   ${msg}\x1b[K`),
	tickEnd: () => humanOut.write("\n"),
};
