/**
 * 桌面客户端提示（change gate-desktop-client-hint-by-platform · desktop-client-boundary spec）。
 *
 * 主理人 2026-08-17 定的方向性约束：**exe 顺带装 cli，但 cli 别顺带装 exe**。
 * 随附关系严格单向 —— 客户端安装包可以随附/引导安装 CLI（见 opencut 仓
 * `cli-companion-install` spec 的 Requirement 4），反向不成立：
 * 本 CLI 的任何发行物与任何命令 MUST NOT 随附、下载、静默安装桌面客户端，
 * 也 MUST NOT 把客户端当作自身任何能力的运行前置。
 *
 * 单向的两条硬理由：
 *   ① **CLI 跨平台，客户端只有 Windows**（mac 在 opencut 的 add-macos-desktop-support
 *      射程内、Linux 无计划）——反向随附等于把跨平台的 CLI 绑死在 Windows；
 *   ② CLI 的消费者是终端里的 agent，其中相当一部分从头到尾不需要 GUI。
 *
 * 本模块的定位：CLI **MAY 在信息层面提及**客户端，但
 *   - 止步于「告知」：只打一行命令，MUST NOT 代为执行；
 *   - **限定在客户端真实可用的平台**上呈现 —— 在 macOS/Linux 上打一条
 *     PowerShell `irm … | iex` 既跑不通也无从谈起，是纯噪音。
 */

/** 客户端（桌面端）一键升级 = 重跑安装脚本（NSIS 覆盖装最新、per-user、免管理员）。 */
export const CLIENT_UPGRADE_CMD = "irm https://api.ai-mcn.tv:9000/broadcast/exe/install.ps1 | iex";

/** 客户端有发行版的平台。目前只有 Windows；mac 版上线后在此扩，别散落在各调用点判。 */
const CLIENT_PLATFORMS: readonly string[] = ["win32"];

/**
 * 本平台是否有桌面客户端可言。
 * @param platform 缺省取 `process.platform`（注入仅供测试）
 */
export function hasDesktopClient(platform: string = process.platform): boolean {
	return CLIENT_PLATFORMS.includes(platform);
}

/**
 * 取「客户端升级」提示行；**无客户端的平台恒返 null**（调用点据此静默跳过）。
 *
 * 刻意返回 `string | null` 而不是空串：null 表达「这个平台没有这回事」，
 * 空串会被误当成「有提示但内容为空」。
 *
 * @param prefix 提示的前半句（如「客户端（桌面端）如需一起升级」）
 */
export function desktopClientUpgradeHint(
	prefix: string,
	platform: string = process.platform,
): string | null {
	return hasDesktopClient(platform) ? `${prefix}：${CLIENT_UPGRADE_CMD}` : null;
}
