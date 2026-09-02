/**
 * 限流窗口感知等待（fix-embed-ratelimit-backoff §1）—— **三个客户端共用的唯一出口**。
 *
 * ## 为什么不是指数退避
 *
 * 服务端的限流是**固定窗口**，不是漏桶：`embed_gateway_services.py:307` 拿
 * `int(time.time() // 60)` 当窗口键，也就是**按 epoch 分钟对齐**、整点翻页、计数清零。
 *
 * 对固定窗口用 1s/2s/4s 的指数退避是错配的：撞限流那一刻离窗口翻页可能还有 50 秒，
 * 退避七秒后重试三次，三次全撞、预算耗尽、硬失败——而只要再等一会儿它本来一定会成功。
 * 正确的等待时长只有一个：**等到下一个窗口**。
 *
 * epoch 取模天然与时区无关（`Date.now()` 本就是 UTC 毫秒），不需要任何本地时间换算。
 *
 * ## `Retry-After` 的坐标（今天不实现）
 *
 * 服务端目前**不发** `Retry-After` 头（`embed_gateway_services.py` 的 429 响应体只有
 * `code`/`msg`）。若日后 infra 补上，接线点是本模块：优先取头里的秒数，取不到再回落本算式。
 * 今天 MUST NOT 实现解析——那会是一段永远走不到、也永远没人验的死码。
 */

/** 固定窗口长度（毫秒）：服务端 `int(time.time() // 60)` 即 60 秒一页。 */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * 跨过窗口边界后的额外缓冲（毫秒）。
 *
 * 不加缓冲会卡在边界上：客户端与服务端的时钟、网络单程延迟、服务端取 `time.time()`
 * 的时刻都有几十到几百毫秒的抖动，正好踩线重试有相当概率仍落在旧窗口里，
 * 于是「等满一分钟又失败一次」——那是最贵的一种失败。1.5s 足够盖住上述抖动。
 */
export const RATE_LIMIT_WINDOW_BUFFER_MS = 1_500;

/**
 * 距离下一个限流窗口开始还要等多久（毫秒）。
 *
 * 值域 `(缓冲, 窗口 + 缓冲]`：恰好落在边界上（`now % 60_000 === 0`）时返回
 * `60_000 + 缓冲`——那一刻新窗口才刚开，但我们**不知道**这一刻的失败是记在哪一页上的，
 * 等满一整页是唯一不会再撞的选择。
 */
export function nextRateLimitWaitMs(nowMs: number = Date.now()): number {
	return RATE_LIMIT_WINDOW_MS - (nowMs % RATE_LIMIT_WINDOW_MS) + RATE_LIMIT_WINDOW_BUFFER_MS;
}

/**
 * 限流等待的人读告知。
 *
 * ★ 这一行**不是附赠**：窗口等待可达 60 秒量级，不打出来就等于把「在等限流窗口」
 * 伪装成「挂死了」——用户会去按 Ctrl-C，而那恰恰是最不该做的动作。
 */
export function rateLimitWaitNotice(limitPerMinute: number, waitMs: number, attempt: number, total: number): string {
	const sec = Math.ceil(waitMs / 1000);
	return (
		`撞上服务端限流（${limitPerMinute} 次/分钟，固定窗口）。等待 ${sec}s 到下一个窗口后自动续跑` +
		`（第 ${attempt}/${total} 次）。这不是卡死，请勿中断。`
	);
}
