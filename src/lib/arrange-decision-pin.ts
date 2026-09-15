/**
 * 本机决策层版本的登记 + 与服务端回传值的比对（change: `link-arrange-decision-pin-echo`）。
 *
 * ## ★ 它是 **CLI 自有事实**，不是远端常量的一份拷贝
 *
 * 本模块回答的是「**本机这份 `matrix-lay.ts` 实现的是哪一版决策层**」。CLI 有自己的一份
 * 决策层实现（`planBeatFills` 那一套），云端档的自校验就是拿它复算的
 * （`arrange-gate.ts` 的 `deps.runLocal()`）—— 所以「本机跑的是第几版」只能由 CLI 自己声明。
 *
 * ⚠️ **MUST NOT 把它读成「服务端常量的镜像」**。一旦这么读，下一个人就会去写
 * 「从服务端能力发现端点拉当前 pin 当期望值」——那条路 2026-09-03 走查**已判死**：
 * 拉回来的是服务端自己的值，拿它跟服务端比是**恒等式，零信息量**，
 * 它回答不了「本机决策层是哪一版」，而那才是要比的东西。
 *
 * ⚠️ **MUST NOT 提供 env / 配置覆盖**（如 `GITRUCK_ARRANGE_DECISION_PIN`）。
 * `arrange-gate.ts` 的总闸已经把这条立法过：「任何取值都只会让路径**更保守**，
 * MUST NOT 有『env 打开更激进』的口子」。让用户能一键接受一份不可比的产物正好是反面。
 *
 * ## 与 `METERING_ALGO_PIN` 是**两条独立的轴**，MUST NOT 合并
 *
 * 引 infra `broll_arrange/constants.py` 的原文理由：
 *
 * > 与 `METERING_ALGO_PIN`（计量口径）**是两条独立的变更线，MUST NOT 合并**：
 * > 合并后「只改计费」也会失效决策缓存，「只改决策」也会被报成公式漂移。
 *
 * 先例在仓内：`arrange-metering.ts` 的 `METERING_ALGO_PIN` 就是同一机制的第一条轴
 * （CLI 侧硬编码常量 + 与服务端同步 + 改常量 MUST bump）。本模块是**第二条轴**。
 *
 * ## 防漂移：金样 ↔ pin 绑定闸
 *
 * 光有常量必然退化成「一个没人记得改的字符串」。绑定闸在
 * `test/arrange-decision-pin.test.mjs`：金样清单哈希变了而本值没 bump ⇒ **红**。
 * 哈希口径逐字复刻 infra `add-broll-arrange-api/sync-fixtures.sh`，
 * 使两侧登记的是**同一个数**、可肉眼互比（口径差一个字，人会把它误读成「金样分叉了」）。
 */

/**
 * 本机决策层实现所对应的版本。
 *
 * ⚠️ **MUST 与 infra `broll_arrange/constants.py` 的 `DECISION_ALGO_PIN` 同批 bump。**
 * 两侧各存一份是刻意的：**存一份就没有可比对的对象**，而这里要的恰恰是
 * 「两侧各自声明、不一致就喊出来」。
 *
 * ⚠️ **`link-arrange-decision-pin-echo` 自己不 bump 它** —— 那一件不改任何决策字节，
 * 只是把这个事实**登记**下来并让它过线。bump 的触发器只有一个：
 * 决策产物字节变了（⇒ 金样清单变了 ⇒ 绑定闸红）。
 *
 * 版本沿革（与 infra 那份逐条对应；漏记一件，就等于让「幂等缓存为什么失效」在那件上失去答案）：
 *   v1 —— 初始（`add-broll-arrange-atom` 起至 2026-09-01）
 *   v2 —— `relax-gapfill-cross-beat-borrow` + `fix-borrow-residue-absorption`
 *          + `relax-gapfill-subfloor-picture`（2026-09-01~02，三件都改了 gap 填充的决策字节）
 *   v3 —— `link-anchor-top-hit-guarantee`（2026-09-02）：锚槽取材序回归原始 sim
 *          + 锚 sim top-1 对普通序贯槽预留 + 锚 outcome 新增 5 个条件键
 *   v4 —— 2026-09-03 **同批两刀**：① `link-describe-window-coverage`（`blurry` 降权射程
 *          由候选级收窄为段级）；② `link-arrange-wire-decision-signal-dropped`
 *          （`black` 纳入上行白名单 + 黑段收缩）。金样清单条数 49 → 52。
 *   v5 —— `fix-gapfill-eps-boundary-residue`（2026-09-07）三条：① 恰等 1ms 的 gap 残量**并入前一颗**
 *          （恒进既有 ②a / ②a′ 延长链、`kind: "extend"`，不新增分支不新增 kind）；② A 档：gap 填充 / 黑底合并 /
 *          空洞检测 / 落位重叠 / 越 beat / 碎尾吸收 / 锚槽 room / 段界包含的判据改**整毫秒格**
 *          （`sec2ms` 整数差 ≥ `BLACK_BED_MERGE_TOL_MS = 1`，消灭浮点相位下同一行代码的「两个真相」）；
 *          ③ B 档改名零字节（`CUT_ALIGN_EPS → CUT_ALIGN_WINDOW_SEC`、`BLACK_BED_MERGE_EPS → BLACK_BED_MERGE_TOL_MS`）。
 *          金样清单条数 52 → 53（新增 `cases/43-gapfill-eps-exact-residue`，既有 52 项逐字节未变）。
 *          ⟲ 同批（发版前）含 `fix-anchor-top-hit-guarantee` §5.1–5.4 的四条锚点金样 `cases/44–47`
 *          （锚槽 sim 序 / 跨 beat 预留 lay2 / 预留释放两路 / 双锚 at_sec 先到先得；决策层零改动、既有 53 项逐字节未变），
 *          清单 53 → 57、`PIN_TO_MANIFEST_SHA[v5]` **哈希重登记而不升 v6**——v5 尚未发版，没有任何已上线缓存条目会因此失效。
 *          ⚠️ 版本差的**真实后果**（design D5 纠偏，MUST NOT 再写成「≤1.1.2 被服务端前置拒绝并直接报错」）：
 *          服务端只把决策 pin 混进幂等键并回传，**不按它拒绝客户端**；≥ 1.1.3 客户端读到 v5 走 `server_ahead`
 *          采纳服务端产物；≤ 1.1.2 客户端不比对 ⇒ 退回自校验 → `self_check_failed` 回落本地并白付一次编排费。
 *          真会前置拒绝的是 `METERING_ALGO_PIN`（`broll_arrange_services.py`）。发版序：`add-arrange-decision-pin-echo`
 *          回传先上线 → infra 决策层 v5 上线 → cli 发版（push ≠ 部署）。
 */
export const LOCAL_DECISION_ALGO_PIN = "broll-arrange-decision@v5";

/** 四态判别结果。
 *
 * ⚠️ **MUST NOT 有第五个「不确定」取值**：服务端**缺席**那一档在调用点前就分掉了，
 * 根本不进比较器。缺席是「服务端尚未上线该字段」这一**确定的事实**，不是「判不出来」——
 * 同 `idempotent_replay` 那条已判死的错（`link-arrange-replay-honesty` 初版即此错）。 */
export type DecisionPinRelation = "same" | "server_ahead" | "server_behind" | "unparsable";

/** 版本钉的形态：`broll-arrange-decision@vN`。
 *
 * 与 infra 的形态闸逐字对应（`utils/test/contract/test_broll_arrange_decision_pin.py`：
 * `startswith("broll-arrange-decision@v")` 且 `split("@v")[1].isdigit()`）。 */
const PIN_SHAPE = /^broll-arrange-decision@v(\d+)$/;

/**
 * 抽 `@vN` 的整数。**形态不符 ⇒ `null`**。
 *
 * ⚠️ MUST NOT 兜底成 `0`，也 MUST NOT 当成一致：形态变了说明对面在跑一套我们不认识的东西，
 * 那正是最该拒绝采纳的一档。兜底成 0 会让它悄悄变成「比我旧」，兜底成一致更糟。
 */
export function parseDecisionPin(s: string): number | null {
	const m = PIN_SHAPE.exec(s);
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isSafeInteger(n) ? n : null;
}

/**
 * 比较服务端回传值与本机期望值。
 *
 * ★ **按版本号序比，MUST NOT 用纯字符串相等**：纯相等会让**每一个发版窗口**
 * （服务端先上线、CLI 后发）都触发拒绝，把一次正常滚动变成全员回落本地。
 * 分出 `server_ahead` / `server_behind` 两档才区别得了「我们还没发」与「对面还没部署」。
 */
export function compareDecisionPin(server: string, local: string = LOCAL_DECISION_ALGO_PIN): DecisionPinRelation {
	const a = parseDecisionPin(server);
	const b = parseDecisionPin(local);
	if (a === null || b === null) return "unparsable";
	if (a === b) return "same";
	return a > b ? "server_ahead" : "server_behind";
}

/**
 * infra `fix-arrange-idem-key-decision-version`（把决策层版本钉进**服务端幂等键**）**是否已部署**。
 *
 * ⚠️ 这不是「代码在不在仓」：那件的代码 2026-09-03 就在仓了
 * （`broll_arrange.py` 的 `idem_key = blake2b(f"{request_digest}\x1f{DECISION_ALGO_PIN}")`），
 * 能确证生产 HTTP 含它的是 2026-09-13 15:33（CST）那次部署。**「代码在仓」与「已部署」
 * MUST 分开陈述**，混成一句会让下面那条成因跟着说错。
 *
 * 本值只影响**成因清单**，不影响任何处置与机读面（见 `decisionPinCauses`）。
 * ⟲ 2026-09-16 改为 `true`：入键前的条目已随 24h TTL 排空，生产新鲜请求与逐字节重放
 * 都回传 `broll-arrange-decision@v5`（link-arrange-decision-pin-echo 9.7）。
 * 服务端若回滚到版本钉入键之前，MUST 改回 `false`。
 */
export const IDEM_KEY_PINNED_DEPLOYED = true;

/**
 * 版本不匹配时人读告警里的**成因清单**。
 *
 * ★ 它是**条件式**的，MUST NOT 写死一张恒定的清单。判据是**结构可达性**不是习惯：
 * 幂等键含上版本钉之后，不含钉的旧键与含钉的新键**永不相等** ⇒ 那批旧条目
 * **不可能再被命中** ⇒ 「陈旧回放」这条成因变成一条**永假**的排查指引。
 * **一条把人引向不存在的地方的指引，比不给指引更糟** —— 它消耗的是排查时间而不是省下排查时间。
 *
 * 通则：**告警里列出的每一条成因，SHALL 在当时的部署态下真实可能发生。**
 */
export function decisionPinCauses(idemKeyPinnedDeployed: boolean = IDEM_KEY_PINNED_DEPLOYED): string[] {
	const causes = ["① 服务端尚未部署到本机对应的这一版决策层（push ≠ 部署）"];
	// 条件式：只在「版本钉尚未进入服务端幂等键」时成立（含进入后又回滚回去）
	if (!idemKeyPinnedDeployed) causes.push("② 命中了「版本钉入幂等键之前」写下的幂等条目（24h TTL 内）");
	return causes;
}
