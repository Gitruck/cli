/** 搜索建单前的不可变记录；按输出位置、服务、凭据和参数隔离。 */
import { createHmac, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CloudConfig } from "./config";
import type { OnlineRequest, OnlineSearchSubmission } from "./online-broll-client";
import { searchPayload } from "./online-broll-client";

/** 续跑身份：服务、凭据、批次名与规范化请求体的摘要。claim 与只读 find 共用这一处公式。 */
function onlineSearchIdentity(directory: string, cfg: CloudConfig, request: OnlineRequest, session: string) {
	const payload = searchPayload(request);
	const scope = createHmac("sha256", cfg.apiKey).update(JSON.stringify([
		cfg.base.replace(/\/+$/, ""), session, payload,
	])).digest("hex");
	return { payload, scope, target: join(directory, `${scope}.json`) };
}

/** 读已落盘记录；与本次身份不符一律按损坏报错，不得自动换新身份重新扣费。 */
function parseRecord(text: string, scope: string, payload: OnlineRequest, target: string): OnlineSearchSubmission {
	const saved = JSON.parse(text);
	if (saved?.version !== 1 || saved.scope !== scope
		|| typeof saved.submission?.requestId !== "string"
		|| !/^[A-Za-z0-9_-]{16,128}$/.test(saved.submission.requestId)
		|| JSON.stringify(saved.submission.request) !== JSON.stringify(payload))
		throw new Error(`外网检索恢复记录损坏，请保留文件并排查：${target}`);
	return saved.submission;
}

/** 只读查找已有续跑记录：不存在返回 undefined，不创建目录或文件。 */
export async function findOnlineSearch(
	directory: string, cfg: CloudConfig, request: OnlineRequest, session = "default",
): Promise<OnlineSearchSubmission | undefined> {
	const { payload, scope, target } = onlineSearchIdentity(directory, cfg, request, session);
	let text: string;
	try { text = await readFile(target, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return parseRecord(text, scope, payload, target);
}

export async function claimOnlineSearch(
	directory: string, cfg: CloudConfig, request: OnlineRequest, session = "default",
): Promise<OnlineSearchSubmission> {
	const { payload, scope, target } = onlineSearchIdentity(directory, cfg, request, session);
	await mkdir(directory, { recursive: true });
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
	return parseRecord(await readFile(target, "utf8"), scope, payload, target);
}
