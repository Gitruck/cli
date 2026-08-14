/**
 * CLI 侧合规告知面（change add-compliance-notice · compliance-notice spec）。
 *
 * 定位：**只做告知（notice），不做同意闸（consent）**。同意行为发生在官网
 * （cloud.ai-mcn.tv 登录/注册页已声明「登录或完成注册即代表你同意用户协议和隐私政策」，
 * 且 API Key 只能由官网控制台签发），故每个 CLI 用户在拿到 Key 之前必然已完成同意。
 * 本模块因此 MUST NOT 阻断任何命令、MUST NOT 为条款确认要任何交互输入、
 * MUST NOT 新增 `--accept-terms` 之类开关或等价环境变量、
 * MUST NOT 把留痕的有无当作命令执行的前置条件。
 * 该禁令是**刻意的设计**而非漏做：CLI 为 MIT 开源可 fork、云端 API 可被 curl 直连、
 * 且 `gtrk init --api-key <KEY> -y` 是 agent 驱动的刚需而 `-y` 天然等于「同意跳过键」——
 * 客户端侧同意闸的绕过成本为零，做成闸门只会在合规叙事上制造「有闸」的假象。
 *
 * 文案三要素（**全仓单一副本**，别处不得再硬编码条款 URL 或文案——
 * test/compliance-notice.test.mjs 守卫）：
 *   ① 本机将按用户协议使用同合云云端能力；② 用户是所处理内容合法性的第一责任人；③ 两份条款正本链接。
 *
 * 幂等靠**留痕**（`~/.gitruck/config.json` 的 termsNoticeVersion）而**非进程内标志**——
 * agent 每条命令都是新进程，进程内标志等于每次都告知，正是要避免的刷屏。
 * 输出**恒走 process.stderr**（抄 tool-runner 的 emitBilling 口径，**不用 `log.*`**：
 * log.info 默认写 stdout，「stdout 干净」依赖调用方记得 routeLogsToStderr()，是个会漏的保证）。
 * **零网络往返**：文案与链接全为本地常量，断网照常可用。
 */
import { configPath, readUserConfig, writeUserConfig, type UserConfig } from "./user-config";

/** 条款版本标识（CLI 侧常量）。两份条款是飞书 wiki 页、无内建版本号，故版本由此常量承担：
 * 条款**实质**变更时手工 bump 一次，老用户的留痕即失配、被重新告知一次。
 * 已知残留：bump 依赖人工，与飞书文档的实际修订无联动——改条款时须记得同步改这里。 */
export const TERMS_VERSION = "terms-2026-08";

/** 用户协议正本（飞书 wiki）。 */
export const TERMS_AGREEMENT_URL = "https://hocassian.feishu.cn/wiki/T6UywR8b3ik4Mgk7tP9c1b7Kn0b";
/** 隐私政策正本（飞书 wiki）。 */
export const TERMS_PRIVACY_URL = "https://hocassian.feishu.cn/wiki/ZLRNwlEhfishYtkosUhcofMYnPf";
/** 用户协议全称（与条款正本标题逐字一致）。 */
export const TERMS_AGREEMENT_TITLE = '《"OpenCut Gitruck Edition 客户端"与"gtrk CLI"用户协议》';

/**
 * 告知文案（无 ANSI 的纯文本行）。**MUST ≤3 行**：本 CLI 的主要使用者是 agent，
 * 多余输出会实打实污染其上下文（本仓已有进度刷屏被迫加节流的先例）。
 * 条款细节归条款正本，CLI 只负责指路。
 */
export const COMPLIANCE_NOTICE_LINES: readonly string[] = [
	`⚖️  合规告知：本机将按${TERMS_AGREEMENT_TITLE}使用同合云云端能力；你是所处理内容合法性的第一责任人。`,
	`   用户协议 ${TERMS_AGREEMENT_URL}`,
	`   隐私政策 ${TERMS_PRIVACY_URL}`,
];

/** 留痕写失败时的降级提示（良性降级：只影响「下次会再提示一次」，不构成执行障碍）。 */
function traceFailedLine(): string {
	return `   告知留痕未能写入 ${configPath()}：不影响本次执行，下次运行会再提示一次`;
}

/**
 * 进程内「已打印过」标记。
 * **这不是幂等机制**（幂等靠留痕，见文件头）——它只兜一种边角：留痕写失败时，
 * 同一次运行里多处收口（uploadCached / embedInputs / describeImages）各打印一遍会刷屏。
 * 留痕正常时根本轮不到它。
 */
let printedInThisProcess = false;

/** 仅供单测：重置进程内「已打印过」标记（生产代码不该调）。 */
export function resetComplianceNoticeProcessState(): void {
	printedInThisProcess = false;
}

/** 注入面（仅测试用；生产零注入）。 */
export interface ComplianceNoticeDeps {
	readConfig?: () => UserConfig;
	writeConfig?: (patch: UserConfig) => void;
	/** 输出通道，缺省 process.stderr。**恒 stderr**，与是否 `--json` 无关。 */
	write?: (chunk: string) => void;
	now?: () => Date;
}

/**
 * 幂等告知入口：**内容真正离开本机之前**调一次即可，各挂载点零改动地共用同一份文案与留痕。
 *
 * - 留痕里的版本标识与 {@link TERMS_VERSION} 一致 ⇒ 静默返回 false（永不复读）；
 * - 缺失 / 旧版本 / 配置损坏（readUserConfig 的「当空」语义）⇒ 打印一次并刷新留痕，返回 true；
 * - 留痕写失败 ⇒ 打一行可读提示后**照常返回**，**MUST NOT 把底层异常抛给上游**（良性降级）。
 *
 * 同步、单向、不等任何输入、不引任何网络往返——非 TTY（管道 / agent 子进程）下同样直出不挂起。
 */
export function noticeOnce(deps: ComplianceNoticeDeps = {}): boolean {
	const write = deps.write ?? ((chunk: string) => void process.stderr.write(chunk));

	let recorded: string | undefined;
	try {
		recorded = (deps.readConfig ?? readUserConfig)().termsNoticeVersion;
	} catch {
		recorded = undefined; // 读不出 = 视为未留痕（重新告知一次，MUST NOT 报致命错误）
	}
	if (recorded === TERMS_VERSION) return false;
	if (printedInThisProcess) return false;

	const [head, ...links] = COMPLIANCE_NOTICE_LINES;
	write(`\x1b[36m${head}\x1b[0m\n\x1b[2m${links.join("\n")}\x1b[0m\n`);
	printedInThisProcess = true;

	try {
		(deps.writeConfig ?? writeUserConfig)({
			termsNoticeVersion: TERMS_VERSION,
			termsNoticeAt: (deps.now ?? (() => new Date()))().toISOString(),
		});
	} catch {
		// 良性降级：告知的目的是「用户看见」，看见已经发生；落痕失败不阻断、不抛天书
		write(`\x1b[2m${traceFailedLine()}\x1b[0m\n`);
	}
	return true;
}
