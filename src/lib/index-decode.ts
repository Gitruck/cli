/**
 * 索引场景检测的解码车道（speedup-matrix-index-proxy-decode）。
 *
 * 本模块是**纯函数层**：只造参数、只做判定，零 I/O、零 spawn——无 N 卡的 CI 也能全覆盖。
 * 执行与降级编排在 local-index.ts。
 *
 * ── 为什么是三档而不是「开/关硬解」──────────────────────────────────────────
 * 实测（RTX 4090 / AV1 4K60 / 安静机 / min-of-3 / 180s 样本）：
 *   全清 CPU 41.2s(1.00×) · 代理 CPU+bicubic 42.0s(0.98×) · 代理 CPU+neighbor 35.3s(1.16×)
 *   · GPU+scale_cuda 23.2s(1.77×)
 * 三个结论定了本模块的形状：
 *   ① 代理缩放**默认 scaler 是净亏损**（bicubic 缩 4K 的开销正好吃掉省下的 scene score 开销），
 *      必须显式钉 neighbor 才有收益——所以 scaler 是常量不是可选项；
 *   ② GPU 是唯一能砍到解码本身的档（解码占全链 56%），但它逐素材可用性不同；
 *   ③ 全清档必须保留：它是对照基准，也是两档都失败时的终局。
 */

/** 解码车道。降级方向恒为 gpu → cpu_proxy → cpu_full。 */
export type DecodeLane = "gpu" | "cpu_proxy" | "cpu_full";

/** 代理宽度（px）。384 是 POC 标定值；实测 47/47 切点零分歧。
 * 再往下（256）保真度明显劣化，不要随手调小。 */
export const PROXY_WIDTH_DEFAULT = 384;

/** 代理缩放算法。**必须显式钉死**，MUST NOT 依赖 ffmpeg 默认值。
 * 默认 bicubic 实测 0.98×（比不缩还慢）且保真更差——它的低通滤波会压低帧间差、
 * 把刀刃切点滤没；neighbor 是点采样不滤波，实测 1.16× 且 47/47 切点零分歧。
 * 「更快」和「更准」在这里恰好同向，没有取舍。 */
export const PROXY_SCALER_DEFAULT = "neighbor";

/** 同一轮内 GPU 车道连续失败多少次后钉死不再试。
 * 存在的理由：静态门只看编码格式，拦不住「驱动挂了 / 卡被别的进程占满」这类整机态问题——
 * 那种情况下每个素材都要白白试错 ~3s。 */
export const GPU_FAIL_STREAK_LIMIT = 2;

/** NVDEC 支持的像素格式白名单。4:2:2 与 4:4:4 直到 Blackwell 才有硬解，
 * 消费级卡（含 4090）实测一律报 `Hardware is lacking required capabilities`。 */
export const GPU_PIXFMT_ALLOW = new Set(["yuv420p", "yuvj420p", "nv12", "yuv420p10le", "p010le"]);

/** 可走 GPU 的编码。ProRes/DNxHD 等中间码流无硬解（实测滤镜链直接断）。 */
export const GPU_CODEC_ALLOW = new Set(["h264", "hevc", "av1", "vp9", "mpeg2video", "vc1"]);

/** H.264 在多核机上默认不走 GPU 的核数门槛。
 * 依据：4090(Ada) 的 H.264 NVDEC 是弱路（NVIDIA 自述 Blackwell 才「doubles H.264 decoding
 * throughput」），而 libavcodec 的 H.264 软解帧级多线程在多核上极强。侦察实测在 0.65×–3.9×
 * 之间**互相矛盾**，尚无定论——故取保守缺省：核多就别赌，让遥测回收数据后再调这张表。 */
export const GPU_H264_MAX_CORES = 8;

/** select 表达式：gte(scene,0) 全帧通过、metadata=print 逐帧打 score。
 * 单趟解码双产物（切点与稳定性注记都从这一趟的 score 序列派生），
 * spec 有 MUST NOT 为判定新增解码 pass 的条款——改这里前先读那条。 */
const SCENE_TAP = "select='gte(scene,0)',metadata=print";

export interface ScenePassArgsOpts {
	src: string;
	lane: DecodeLane;
	proxyWidth?: number;
	proxyScaler?: string;
}

/**
 * 造场景检测这一趟的 ffmpeg 参数。
 *
 * 滤镜序有三条铁律，全部是实测踩出来的，改动前先看单测断言：
 *  ① 缩放 MUST 在 SCENE_TAP 之前——写反了就是在全清帧上算 score，收益归零；
 *  ② GPU 档的 `scale_cuda` MUST 在 `hwdownload` 之前——写反了就是把全清帧过 PCIe 回传，
 *     实测比纯 CPU 还慢（0.69×）；
 *  ③ GPU 档 `scale_cuda` MUST 带 `:format=nv12` 且 `hwdownload` 后 MUST 紧跟 `format=nv12`——
 *     NVDEC 对 10bit 源输出 p010le，缺了前者 10bit 素材报 `Invalid output format nv12` 直接死；
 *     缺了后者连 8bit 都报 `Invalid output format gray`。
 */
export function buildScenePassArgs(opts: ScenePassArgsOpts): string[] {
	const w = opts.proxyWidth ?? PROXY_WIDTH_DEFAULT;
	const scaler = opts.proxyScaler ?? PROXY_SCALER_DEFAULT;
	switch (opts.lane) {
		case "gpu":
			return [
				"-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
				"-i", opts.src,
				"-vf", `scale_cuda=${w}:-2:format=nv12,hwdownload,format=nv12,${SCENE_TAP}`,
				"-f", "null", "-",
			];
		case "cpu_proxy":
			return ["-i", opts.src, "-vf", `scale=${w}:-2:flags=${scaler},${SCENE_TAP}`, "-f", "null", "-"];
		case "cpu_full":
			return ["-i", opts.src, "-vf", SCENE_TAP, "-f", "null", "-"];
	}
}

/**
 * CUDA 运行时探针参数：走 lavfi 造一帧，**跑完整条链形**（hwupload → scale_cuda → hwdownload），
 * 而不是只问 `-hwaccels` 里有没有 cuda。
 * 理由：构建里编了 CUDA ≠ 这台机器此刻能用（无卡/驱动过旧/设备号错/显存耗尽都只在真跑时暴露）。
 * 实测成功 ~314ms、失败 ~177ms，够便宜。
 */
export function buildGpuProbeArgs(deviceIdx = 0): string[] {
	return [
		"-hide_banner", "-v", "error",
		"-init_hw_device", `cuda=g:${deviceIdx}`, "-filter_hw_device", "g",
		"-f", "lavfi", "-i", "color=c=black:s=256x144:d=0.04",
		"-vf", "format=nv12,hwupload,scale_cuda=64:-2:format=nv12,hwdownload,format=nv12",
		"-frames:v", "1", "-f", "null", "-",
	];
}

export interface MaterialCodecInfo {
	codecName?: string;
	pixFmt?: string;
}

export interface MachineInfo {
	/** 逻辑核数。用于 H.264 的保守门（见 GPU_H264_MAX_CORES）。 */
	cores: number;
}

/**
 * 素材静态门：不花任何额外进程，只看 ffprobe 已经拿到的 codec/pix_fmt 判断该不该试 GPU。
 * 复用阶段一本来就要跑的那次 ffprobe ⇒ 零成本。
 *
 * 返回 `ok:false` 时 `reason` 是**给日志用的机器码**（不是给用户看的话术），
 * 便于按原因聚合统计。
 */
export function gpuLaneEligible(info: MaterialCodecInfo, machine: MachineInfo): { ok: boolean; reason: string } {
	const codec = (info.codecName || "").toLowerCase();
	const pix = (info.pixFmt || "").toLowerCase();
	// 探不到就别赌：宁可少省点时间，也不要拿一次失败去换一次试错
	if (!codec || !pix) return { ok: false, reason: "codec_unknown" };
	if (!GPU_CODEC_ALLOW.has(codec)) return { ok: false, reason: `codec_${codec}` };
	if (!GPU_PIXFMT_ALLOW.has(pix)) return { ok: false, reason: `pixfmt_${pix}` };
	if (codec === "h264" && machine.cores >= GPU_H264_MAX_CORES) return { ok: false, reason: "h264_cpu_wins" };
	return { ok: true, reason: "ok" };
}

/** 降级方向。到 cpu_full 就是终局，再失败就是这个素材真有问题。 */
export function nextLane(lane: DecodeLane): DecodeLane | null {
	if (lane === "gpu") return "cpu_proxy";
	if (lane === "cpu_proxy") return "cpu_full";
	return null;
}

/** 静态门的机器码 → 人话。降级日志给用户看的是这个，不是 ffmpeg 的滤镜链天书。 */
export function explainIneligible(reason: string): string {
	if (reason === "codec_unknown") return "探不到编码信息";
	if (reason === "h264_cpu_wins") return "H.264 在多核机上软解更快";
	if (reason.startsWith("pixfmt_")) return `像素格式 ${reason.slice(7)} 无硬解支持`;
	if (reason.startsWith("codec_")) return `编码 ${reason.slice(6)} 无硬解支持`;
	return reason;
}

/**
 * 轮末聚合 INFO 的文案。
 *
 * 为什么是聚合而不是逐素材打：降级是**已知根因的良性事件**，逐条刷屏会把真正的问题淹掉。
 * 一行说清「多少个、为什么、结果受不受影响」即可；ffmpeg 原始 stderr 只在 --verbose 可取。
 */
export function summarizeDowngrades(entries: { name: string; reason: string }[]): string | null {
	if (!entries.length) return null;
	const byReason = new Map<string, number>();
	for (const e of entries) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
	const parts = [...byReason.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([r, n]) => `${explainIneligible(r)} ${n} 个`);
	return `GPU 硬解对 ${entries.length} 个素材不适用（${parts.join("、")}），已自动走 CPU 解码——索引结果不受影响`;
}
