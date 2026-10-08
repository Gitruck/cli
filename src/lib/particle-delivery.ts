/** 颗粒交付恢复：任务回执先落盘，缓存只在下载完整后公布。 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureLandingWritable, type LandingWaitDeps } from "./landing-wait";
import { LOCAL_WRITE_ERRNOS } from "./outdir-guard";

export class ParticleDeliveryError extends Error {
	readonly code = "particle_delivery_incomplete";
}

export interface ParticleDeliveryOptions {
	json?: boolean;
	landingWait?: Partial<LandingWaitDeps>;
}

const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

export async function preflightParticleDelivery(paths: string[], opts: ParticleDeliveryOptions): Promise<void> {
	for (const dir of new Set(paths.map(dirname))) {
		await ensureLandingWritable(dir, "颗粒缓存目录", { json: opts.json, deps: opts.landingWait });
		await mkdir(dir, { recursive: true });
	}
}

/** 只接管 export 的持久交付；云端任务明确失败仍由上层原有 continue 策略处理。 */
export async function deliverParticle(
	cachePath: string,
	opts: ParticleDeliveryOptions,
	deps: {
		submit: () => Promise<string>;
		poll: (taskId: string) => Promise<{ download_url?: unknown }>;
		download: (url: string, dest: string) => Promise<void>;
	},
): Promise<{ submitted: boolean }> {
	const receipt = `${cachePath}.task.json`;
	let taskId: string | undefined;
	let submitted = false;
	try {
		const saved = JSON.parse(await readFile(receipt, "utf8"));
		if (saved.version !== 1 || typeof saved.taskId !== "string" || !saved.taskId) {
			throw new ParticleDeliveryError(`颗粒提交结果尚未确认，请先核对任务回执 ${receipt}；已停止自动重提，避免重复扣费`);
		}
		taskId = saved.taskId;
	} catch (e) {
		if (!missing(e)) throw e instanceof ParticleDeliveryError ? e : new ParticleDeliveryError(`颗粒回执无法读取：${receipt}；请核对后继续，未重新计费`);
	}
	if (!taskId) {
		// wx 同时防并发建单；未知提交结果保留占位，不把中断当成未收费。
		try { await writeFile(receipt, JSON.stringify({ version: 1, taskId: null }), { flag: "wx" }); }
		catch { throw new ParticleDeliveryError(`颗粒回执无法独占写入：${receipt}；尚未提交新任务`); }
		try { taskId = await deps.submit(); }
		catch { throw new ParticleDeliveryError(`颗粒提交结果未知，请核对回执 ${receipt} 与云端任务，禁止直接重提`); }
		submitted = true;
		const pending = `${receipt}.${randomUUID()}.tmp`;
		try {
			await writeFile(pending, JSON.stringify({ version: 1, taskId }));
			await rename(pending, receipt);
		} catch {
			throw new ParticleDeliveryError(`颗粒任务 ${taskId} 已创建，但回执保存失败：${receipt}；请保留任务 ID，勿重新渲染`);
		} finally { await unlink(pending).catch(() => {}); }
	}
	let output: { download_url?: unknown };
	try { output = await deps.poll(taskId); }
	catch (e) {
		const status = (e as { taskStatus?: string })?.taskStatus;
		if (status === "failed" || status === "cancelled") throw e;
		throw new ParticleDeliveryError(`颗粒任务 ${taskId} 状态尚未确认：${(e as Error).message}。已保留 ${receipt}；稍后重跑会继续查询原任务，不重新计费`);
	}
	if (typeof output.download_url !== "string" || !output.download_url) {
		throw new ParticleDeliveryError(`颗粒任务 ${taskId} 没有下载地址，保留回执等待核对，未重新计费`);
	}
	const partial = `${cachePath}.${randomUUID()}.part`;
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				await deps.download(output.download_url, partial);
				if ((await stat(partial)).size === 0) throw new Error("下载产物为空");
				await rename(partial, cachePath);
				return { submitted };
			} catch (e) {
				const code = (e as NodeJS.ErrnoException)?.code;
				if (attempt === 0 && code && (LOCAL_WRITE_ERRNOS as readonly string[]).includes(code)) {
					await ensureLandingWritable(dirname(cachePath), "颗粒缓存目录", {
						json: opts.json, deps: opts.landingWait,
						recoveryHint: `任务 ${taskId} 已保存；修好目录后重跑相同工程，只补下载、不重新渲染计费`,
					});
					continue;
				}
				throw e;
			}
		}
	} catch (e) {
		throw new ParticleDeliveryError(`颗粒任务 ${taskId} 已完成但交付未完成：${(e as Error).message}。已保留 ${receipt}；修好后重跑相同工程，只补下载、不重新计费`);
	} finally { await unlink(partial).catch(() => {}); }
}
