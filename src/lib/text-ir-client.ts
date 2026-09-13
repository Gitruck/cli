/**
 * 文字模板两口的云端客户端（change add-text-template-source）。
 *
 * - `POST /task/cli/text_ir_compile`  —— 同步，0 积分。改 IR 重编译（L0）
 * - `POST /task/cli/text_particle_generate` + 轮询 —— 异步，2 积分/候选。自然语言改写
 *
 * **本地没有编译器**（主理人拍板 L0 永远走后端）。第二份编译器意味着第二套产物字节，
 * 而颗粒的三态身份判的就是字节——本地编出来的东西在服务端眼里会是 `detached`。
 */
import type { CloudConfig } from "./config";
import { loadConfig } from "./config";
import { parseJson, pollTask, submitTask } from "./cloud";

export const COMPILE_TASK_TYPE = "cli/text_ir_compile";
export const GENERATE_TASK_TYPE = "cli/text_particle_generate";
/** yudao 价格表里的键（计费提示用）。 */
export const GENERATE_PRICE_KEY = "text_particle_generate";

export interface CompileResult {
	html: string;
	ir_sha256: string;
	html_sha256: string;
	composition_id: string;
	duration: number;
	task_id?: string;
}

export interface GenerateCandidate {
	scope: "L0" | "L1" | "L2";
	note?: string | null;
	model?: string | null;
	ir_sha256: string;
	html_sha256: string;
	html_file_id: string;
	html_download_url: string;
	ir_file_id: string;
	ir_download_url: string;
	duplicate_of?: number | null;
}

export interface GenerateResult {
	candidates: GenerateCandidate[];
	refusal?: string | null;
	billable_units?: number;
	attempts?: unknown[];
}

export interface ClientDeps {
	fetch?: typeof fetch;
	loadCfg?: () => CloudConfig;
	submit?: typeof submitTask;
	poll?: typeof pollTask;
}

/**
 * 同步编译。服务端校验失败会指名到路径（如 `layers[1].mask.type`），
 * 这里 SHALL 原样转述，MUST NOT 包装成一句「编译失败」——路径才是能修的那个信息。
 */
export async function compileIr(ir: unknown, deps: ClientDeps = {}): Promise<CompileResult> {
	const cfg = (deps.loadCfg ?? loadConfig)();
	const f = deps.fetch ?? fetch;
	const res = await f(`${cfg.base.replace(/\/+$/, "")}/task/${COMPILE_TASK_TYPE}`, {
		method: "POST",
		headers: { Authorization: cfg.apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({ ir }),
	});
	const r = await parseJson<CompileResult>(res);
	if (r.code !== 200 || !r.data?.html) {
		throw new Error(`编译失败${r.code ? `（code=${r.code}）` : ""}：${r.msg ?? "服务端未给原因"}`);
	}
	return r.data;
}

/** 提交自然语言改写并轮询到终态。候选为空数组是「拒绝」，不是失败——调用方分开处置。 */
export async function generateParticle(
	payload: { html?: string; ir?: unknown; instruction: string; n: number },
	onTick?: (status: string, progress?: number) => void,
	deps: ClientDeps = {},
): Promise<{ result: GenerateResult; taskId: string }> {
	const cfg = (deps.loadCfg ?? loadConfig)();
	const taskId = await (deps.submit ?? submitTask)(cfg, GENERATE_TASK_TYPE, payload);
	const output = (await (deps.poll ?? pollTask)(cfg, GENERATE_TASK_TYPE, taskId, onTick)) as unknown as GenerateResult;
	return {
		result: {
			candidates: output?.candidates ?? [],
			refusal: output?.refusal ?? null,
			...(output?.billable_units !== undefined ? { billable_units: output.billable_units } : {}),
			...(output?.attempts !== undefined ? { attempts: output.attempts } : {}),
		},
		taskId,
	};
}
