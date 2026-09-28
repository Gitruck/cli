/** 去除模式必须来自用户选择；不得以速度或失败为由代选、降档。 */
export const PURIFY_METHOD_HELP = "先询问用户：ffmpeg 快速模糊，效果基础、可能留痕；raft 较慢的内容修复，通常更自然、可接近无痕，但不保证无损或还原遮挡细节";

export function requirePurifyMethod(value: unknown, flag = "--purify-func-type"): "ffmpeg" | "raft" {
	if (value !== "ffmpeg" && value !== "raft") {
		throw new Error(`请先让用户选择去除模式，再显式传 ${flag} ffmpeg|raft。${PURIFY_METHOD_HELP}。不得默认 ffmpeg 或在失败后擅自切换模式。`);
	}
	return value;
}
