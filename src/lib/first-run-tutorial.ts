/**
 * 初次运行教程入口（change add-first-run-tutorial · first-run-tutorial spec）。
 *
 * 缺口：教程资产早就有（README 顶部飞书教程 wiki + 官网 quick-start），但**运行时不指路** ——
 * 全仓零 first-run 钩子（无 postinstall、index.ts 无钩子），上手面全是显式命令
 * （`gtrk install` / `gtrk init`）；`init` 收尾的 `afterConfigDoctor` 有用法提示，
 * 但**没跑 init 就零露出**。小白装完 CLI 直接敲 `gtrk oralcut` 撞一鼻子灰，
 * 或者压根不知道有教程可看。
 *
 * 定位：**只做一次性指路（signpost），不做向导（wizard）**。本模块 MUST NOT 阻断任何命令、
 * MUST NOT 要任何交互输入、MUST NOT 新增开关或环境变量、
 * MUST NOT 把留痕的有无当作命令执行的前置条件。
 * 刻意不做交互式分步向导：本 CLI 的主要驱动者是 agent，交互向导在 agent 场景下是纯负担
 * （非 TTY 挂起、或被迫加一堆 `-y` 旁路）；「初次可见的一块指路牌」已经解决 90% 的问题。
 *
 * 整套机制**照抄同仓 compliance-notice 的成熟先例**（见 `./compliance-notice.ts` 文件头），
 * 五条口径逐条对齐：
 *   ① 幂等靠 `~/.gitruck/config.json` **留痕**而非进程内标志（agent 每条命令都是新进程）；
 *   ② 输出**恒走 process.stderr**，与 `--json` 无关（不用 `log.*`：log.info 默认写 stdout，
 *      「stdout 干净」依赖调用方记得 routeLogsToStderr()，是个会漏的保证）；
 *   ③ 行数上限（agent 上下文是稀缺资源，本仓有过进度刷屏被迫加节流的先例）；
 *   ④ 留痕写失败 = **良性降级**（打一行可读提示后照常返回，MUST NOT 把底层异常抛给上游）；
 *   ⑤ **文案全仓单一副本** —— `init` 收尾的用法提示与本块并源（见 {@link FIRST_RUN_USAGE_LINES}），
 *      test/first-run-tutorial.test.mjs 守卫，防两处漂移。
 * **零网络往返**：全为本地常量，断网照常可用。
 */
import { configPath, readUserConfig, writeUserConfig, type UserConfig } from "./user-config";

/** 飞书使用教程正本（README 顶部同一条链接，单一副本）。 */
export const TUTORIAL_URL = "https://hocassian.feishu.cn/wiki/HCFpwoF7SivIFbkKosgcFMcEnxk";
/** 官网快速开始。 */
export const QUICK_START_URL = "https://cloud.ai-mcn.tv/zh-CN/docs/quick-start";

/**
 * 「装好之后怎么用」的两条路 —— **全仓单一副本**。
 * `gtrk init` 收尾的 `afterConfigDoctor()` 与本模块的首跑块**共用这份常量**，
 * 防同一句话在两处各写一遍、改一处漏一处（本仓 compliance-notice 立过同样的守卫）。
 */
export const FIRST_RUN_USAGE_LINES: readonly string[] = [
	'① 命令行直接剪：gtrk oralcut "<毛片.mp4>" --script "<文字稿.txt>"（无稿就别加 --script）',
	"② 刷新你常用的 AI Agent，在它的 Skills 入口选择或点名 gtrk-oralcut；不同客户端也都可以直接描述剪辑需求触发。",
];

/**
 * 首跑教程块（无 ANSI 的纯文本行）。**MUST ≤6 行**：主要使用者是 agent，多余输出实打实污染上下文。
 * 细节归教程正本，CLI 只负责指路 —— 这里只放「看哪里」+「最小三步」。
 */
export const FIRST_RUN_TUTORIAL_LINES: readonly string[] = [
	"👋 第一次用 gtrk？三步跑通第一条口播：",
	"   1) gtrk install   —— 装依赖与运行时资产",
	"   2) gtrk init      —— 填 API Key、认剪映草稿目录（跑完会自动体检）",
	`   3) ${FIRST_RUN_USAGE_LINES[0]}`,
	`   使用教程 ${TUTORIAL_URL}`,
	`   快速开始 ${QUICK_START_URL}`,
];

/** 留痕写失败时的降级提示（良性降级：只影响「下次会再提示一次」，不构成执行障碍）。 */
function traceFailedLine(): string {
	return `   首跑留痕未能写入 ${configPath()}：不影响本次执行，下次运行会再提示一次`;
}

/**
 * 进程内「已打印过」标记。
 * **这不是幂等机制**（幂等靠留痕，见文件头）——只兜「留痕写失败时同一次运行里多处收口各打一遍」
 * 这一种边角。留痕正常时根本轮不到它。
 */
let printedInThisProcess = false;

/** 仅供单测：重置进程内「已打印过」标记（生产代码不该调）。 */
export function resetFirstRunTutorialProcessState(): void {
	printedInThisProcess = false;
}

/** 注入面（仅测试用；生产零注入）。 */
export interface FirstRunTutorialDeps {
	readConfig?: () => UserConfig;
	writeConfig?: (patch: UserConfig) => void;
	/** 输出通道，缺省 process.stderr。**恒 stderr**，与是否 `--json` 无关。 */
	write?: (chunk: string) => void;
	now?: () => Date;
}

/**
 * 判定「是否算已上手」——**存量老用户 MUST NOT 被这块打扰**。
 *
 * 判据刻意用 `apiKey` 而非只看 `firstRunNoticeAt`：本 change 之前的用户配置里
 * 压根没有 `firstRunNoticeAt` 这个键，只看它会让**所有存量用户在升级后被打一次**——
 * 而他们显然早就上手了，那一次纯属噪音。有 `apiKey` = 跑过 `gtrk init`（Key 只能由官网签发、
 * 由 init 或手工写入配置）= 已经见过 `afterConfigDoctor` 的用法提示，无需再指路。
 */
function looksOnboarded(cfg: UserConfig): boolean {
	return typeof cfg.apiKey === "string" && cfg.apiKey.trim().length > 0;
}

/**
 * 幂等首跑指路入口：挂在 CLI 入口一处收口即可（commander `preAction`），各子命令零改动共享。
 *
 * - 已留痕（`firstRunNoticeAt` 在）⇒ 静默返回 false（永不复读）；
 * - 看起来已上手（配置里有 `apiKey`）⇒ 静默返回 false **并补写留痕**（存量老用户零打扰，
 *   补痕是为了让「已上手」这个判断只做一次，日后 Key 被清掉也不会突然又开始提示）；
 * - 否则 ⇒ 打印一次并写留痕，返回 true；
 * - 留痕写失败 ⇒ 打一行可读提示后**照常返回**（良性降级，MUST NOT 抛给上游）。
 *
 * 同步、单向、不等任何输入、不引任何网络往返——非 TTY（管道 / agent 子进程）下同样直出不挂起。
 */
export function firstRunTutorialOnce(deps: FirstRunTutorialDeps = {}): boolean {
	const write = deps.write ?? ((chunk: string) => void process.stderr.write(chunk));

	let cfg: UserConfig;
	try {
		cfg = (deps.readConfig ?? readUserConfig)();
	} catch {
		cfg = {}; // 读不出 = 当空（与 compliance-notice 同口径，MUST NOT 报致命错误）
	}

	const stamp = () => {
		try {
			(deps.writeConfig ?? writeUserConfig)({
				firstRunNoticeAt: (deps.now ?? (() => new Date()))().toISOString(),
			});
			return true;
		} catch {
			return false;
		}
	};

	if (typeof cfg.firstRunNoticeAt === "string" && cfg.firstRunNoticeAt.length > 0) return false;
	if (looksOnboarded(cfg)) {
		stamp(); // 静默补痕，不打印
		return false;
	}
	if (printedInThisProcess) return false;

	const [head, ...rest] = FIRST_RUN_TUTORIAL_LINES;
	write(`\x1b[36m${head}\x1b[0m\n\x1b[2m${rest.join("\n")}\x1b[0m\n`);
	printedInThisProcess = true;

	if (!stamp()) {
		// 良性降级：指路的目的是「用户看见」，看见已经发生；落痕失败不阻断、不抛天书
		write(`\x1b[2m${traceFailedLine()}\x1b[0m\n`);
	}
	return true;
}
