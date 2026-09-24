/** 搜索建单前的不可变记录；按输出位置、服务、凭据和参数隔离。 */
import { createHmac, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CloudConfig } from "./config";
import type { OnlineSearchRequest, OnlineSearchSubmission } from "./online-broll-client";

export async function claimOnlineSearch(
	directory: string, cfg: CloudConfig, request: OnlineSearchRequest, session = "default",
): Promise<OnlineSearchSubmission> {
	const payload: OnlineSearchRequest = { query: request.query,
		...(request.platforms ? { platforms: [...request.platforms] } : {}),
		...(request.discovery_queries ? { discovery_queries: [...request.discovery_queries] } : {}),
		...(request.max_videos !== undefined ? { max_videos: request.max_videos } : {}),
		...(request.top_k !== undefined ? { top_k: request.top_k } : {}) };
	const scope = createHmac("sha256", cfg.apiKey).update(JSON.stringify([
		cfg.base.replace(/\/+$/, ""), session, payload,
	])).digest("hex");
	await mkdir(directory, { recursive: true });
	const target = join(directory, `${scope}.json`);
	const temporary = join(directory, `${scope}.${randomUUID()}.tmp`);
	const record = { version: 1, scope, submission: { requestId: randomUUID(), request: payload } };
	// 先完整写入并同步，再用不覆盖目标的硬链接选出唯一赢家。
	// 进程退出后无需抢锁；失败/损坏不能自动换新身份重新扣费。
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(JSON.stringify(record));
		await file.sync();
	} finally { await file.close(); }
	try {
		try { await link(temporary, target); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	} finally { await unlink(temporary); }
	const saved = JSON.parse(await readFile(target, "utf8"));
	if (saved?.version !== 1 || saved.scope !== scope
		|| typeof saved.submission?.requestId !== "string"
		|| !/^[A-Za-z0-9_-]{16,128}$/.test(saved.submission.requestId)
		|| JSON.stringify(saved.submission.request) !== JSON.stringify(payload))
		throw new Error(`外网检索恢复记录损坏，请保留文件并排查：${target}`);
	return saved.submission;
}
