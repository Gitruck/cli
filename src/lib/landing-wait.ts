/**
 * 落点不可写时的**阻塞重探等待器**（add-artifact-landing-gate §2 · 裁决 D2）。
 *
 * 裁决原话：落点写不进去时 MUST 停下来拉着用户处理**到可写为止**，
 * MUST NOT 静默改投别处、MUST NOT 降级成「告警一句然后照跑」。
 * 于是本模块只做一件事：**探失败 → 告知 → 等 → 重探 → 通过则让调用方继续本次运行**。
 * 「继续本次运行」是重点：MUST NOT 重跑任务、MUST NOT 二次计费——
 * 调用方拿到 resolve 后接着往下走，云端任务与已付的钱都还在。
 *
 * ══ 为什么另立而不复用 `src/lib/prompt.ts` 的 `ask()`（逐条实读确认）══
 * ① `ask()` 模块私有（`prompt.ts:36` 无 export），对外只有 promptText/promptSecret/promptConfirm；
 * ② 无 isTTY 短路：管道下 `stdin.setRawMode?.(true)` 静默 no-op，随后 `stdin.resume()`
 *    挂在一个永远不会来的 `data` 事件上 —— **正是 D2 明令禁止的挂起**；
 * ③ 无超时；
 * ④ 提示写 **stdout**，`--json` 下会破「stdout 只有一行结果 JSON」的契约。
 * 本模块：提示与重探回执**一律走 stderr**；isTTY 谓词可注入，使非交互硬失败路径在无 pty 的单测里可闸。
 *
 * ══ 无旁路（capability 第 6 条：裁决即缺省）══
 * 本模块**不接受**任何跳过开关：无 `--force`、无 `--yes`、无环境变量、无配置项。
 * 非交互环境下的硬失败**不是旁路**——它比阻塞更严（当场非零退出），是同一裁决在无人值守面上的落位。
 */
import { createInterface } from "node:readline";
import { ArtifactLandingError, probeLandingWritable, type LandingProbeResult } from "./outdir-guard";

/** 阻塞重探的次数上界（tasks §0 的 0.3 取倾向项：3 次后转非零退出并给取回指令）。 */
export const LANDING_RETRY_LIMIT = 3;

export interface LandingWaitDeps {
	/**
	 * 交互判据。**MUST NOT 照抄** `src/commands/feedback.ts:506` 的 stdout-only 谓词：
	 * 那条服务的是「载荷要被人看见」这件**输出侧**的事；而阻塞**输入**的必要条件在 stdin。
	 * `gtrk oralcut … < /dev/null` 从终端里跑时 stdout 仍是 TTY 而 stdin 已死，照抄会挂住。
	 */
	isTty: () => boolean;
	/** 等用户按一次回车（提示已由调用方写到 stderr）。注入点使单测无需 pty。 */
	waitForEnter: () => Promise<void>;
	/** 人读文案出口，恒 stderr。 */
	notify: (line: string) => void;
	/**
	 * 探针本体。缺省即真实探针；**注入只为单测**（重探循环要能在任何平台上确定性复现
	 * 「第一次失败、第二次通过」——Windows 上 chmod 造不出只读目录）。
	 * ⚠️ 这是测试缝，**不是旁路**：生产路径恒走缺省实现，且无任何命令行/环境变量能改它。
	 */
	probe: (target: string) => Promise<LandingProbeResult>;
}

function defaultWaitForEnter(): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const rl = createInterface({ input: process.stdin });
		const done = (fn: () => void) => {
			rl.removeAllListeners();
			rl.close();
			fn();
		};
		rl.once("line", () => done(resolve));
		// stdin 在等待期间被关掉（EOF）：不能静默当成「用户确认了」，按放弃处理
		rl.once("close", () => done(() => reject(new Error("输入已关闭（EOF），放弃等待"))));
	});
}

export function buildLandingWaitDeps(o: Partial<LandingWaitDeps> = {}): LandingWaitDeps {
	return {
		isTty: o.isTty ?? (() => process.stdin.isTTY === true && process.stderr.isTTY === true),
		waitForEnter: o.waitForEnter ?? defaultWaitForEnter,
		notify: o.notify ?? ((line) => process.stderr.write(`${line}\n`)),
		probe: o.probe ?? probeLandingWritable,
	};
}

export interface LandingWaitOpts {
	/** 机读模式。归入「非交互」：随包 skill 教 agent 用 `--json` 驱动本 CLI，agent 可能持有 pty。 */
	json?: boolean;
	/** 重探次数上界，缺省 `LANDING_RETRY_LIMIT`。 */
	limit?: number;
	/** 上界耗尽 / 非交互时，附在报错尾部的可照抄出路（如 `gtrk oralcut-result <id> --out <dir>`）。 */
	recoveryHint?: string;
	deps?: Partial<LandingWaitDeps>;
}

/**
 * 确保 `target` 可写：先探一次，通过就直接返回（零副作用、零输出）。
 * 不通过则按交互性分流：
 *  · **非交互**（管道 / CI / `--json` / stdin 非 TTY）⇒ 当场抛，MUST NOT 挂起；
 *  · **交互** ⇒ 告知 → 等回车 → 重探，最多 `limit` 轮；通过即返回（调用方继续本次运行）。
 * 上界耗尽或用户放弃 ⇒ 抛最后一次的 `ArtifactLandingError`。
 */
export async function ensureLandingWritable(
	target: string,
	label: string,
	opts: LandingWaitOpts = {},
): Promise<void> {
	const deps = buildLandingWaitDeps(opts.deps);
	const limit = opts.limit ?? LANDING_RETRY_LIMIT;
	const interactive = !opts.json && deps.isTty();

	let last: LandingProbeResult = await deps.probe(target);
	if (last.ok) return;

	const err = (): ArtifactLandingError => {
		if (last.ok) throw new Error("unreachable: err() 只在探针失败后调用"); // 给 TS 收窄，运行期不可达
		const { ok: _ok, ...failure } = last;
		const e = new ArtifactLandingError(failure, label);
		if (opts.recoveryHint) e.message += `\n${opts.recoveryHint}`;
		return e;
	};

	if (!interactive) {
		// 非交互硬失败：比阻塞更严，不是旁路。MUST NOT 在这里等任何输入。
		throw err();
	}

	for (let attempt = 1; attempt <= limit; attempt++) {
		if (last.ok) return; // 不可达（循环入口恒为失败态），仅供 TS 收窄
		const f = last;
		deps.notify("");
		deps.notify(`⛔ ${label}写不进去，已停下（第 ${attempt}/${limit} 次）：`);
		deps.notify(`   落点：${target}`);
		if (f.probed) deps.notify(`   实际探测目录：${f.probed}${f.errno ? `（${f.errno}）` : ""}`);
		deps.notify(
			f.reason === "no_existing_ancestor"
				? "   原因：一路上溯都找不到既存目录 —— 盘符未映射 / 网络共享未连接 / 路径拼错？"
				: "   原因：该目录不允许写入 —— 权限 / 只读挂载 / 被占用 / 磁盘满？",
		);
		deps.notify("   请处理后回来按回车重试。本次任务与已产生的费用都还在，修好即从此处继续，不会重跑。");
		deps.notify("   （本闸没有跳过开关：换个地方写会让产物落到你以为之外的位置，这正是它要防的事。）");

		try {
			await deps.waitForEnter();
		} catch {
			deps.notify("   已放弃等待。");
			throw err();
		}

		last = await deps.probe(target);
		if (last.ok) {
			deps.notify(`✅ ${label}已可写，继续本次运行。`);
			return;
		}
	}
	deps.notify(`   已达重试上界（${limit} 次），退出。`);
	throw err();
}
