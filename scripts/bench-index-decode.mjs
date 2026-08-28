#!/usr/bin/env node
/**
 * 索引阶段一解码路径基准台架（speedup-matrix-index-proxy-decode 验证件）
 *
 * 为什么要有它：换解码路径（代理缩放 / GPU 硬解）必须同时证明两件事——**更快**，且**切点没漂**。
 * 墙钟好测，切点一致性不好测：scene score 是归一化帧间差，换了分辨率数值分布必然轻微偏移，
 * 逐字节比对必然失败。本台架的判据因此是「切点集合在容差内可配对」，而非「score 逐帧相等」。
 *
 * 用法：
 *   node scripts/bench-index-decode.mjs <视频> [--variants a,b,c] [--threshold 0.3] [--tol 0.10] [--json out.json]
 *   node scripts/bench-index-decode.mjs --list          # 列出所有变体
 *
 * 变体是纯数据（VARIANTS），加一条新路线只需加一行——不改台架逻辑。
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// ── ffmpeg 定位（与 CLI 定位优先级同序：--ffmpeg-path > ~/.gitruck/ffmpeg > PATH）─────────
function locateFfmpeg() {
	const argIdx = process.argv.indexOf("--ffmpeg-path");
	if (argIdx >= 0 && process.argv[argIdx + 1]) return process.argv[argIdx + 1];
	const home = join(homedir(), ".gitruck", "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
	if (existsSync(home)) return home;
	return "ffmpeg";
}

/** select 表达式：gte(scene,0) 全帧通过，metadata=print 逐帧打 score（与生产链同构，勿改）。 */
const SCENE_TAP = "select='gte(scene,0)',metadata=print";

/**
 * 变体表。`args(input, proxyW)` 返回完整 ffmpeg 参数数组。
 * 注意滤镜序：缩放 MUST 在 scene tap 之前——scene score 要在缩放后的帧上算才省 CPU。
 */
const VARIANTS = {
	/** 对照组：生产现状，全清全解码。 */
	full: {
		desc: "全清 CPU（生产现状基线）",
		args: (input) => ["-i", input, "-vf", SCENE_TAP, "-f", "null", "-"],
	},
	/** proposal 原方案：CPU 解码 + CPU 缩放。解码仍全清，省的是滤镜与 score 计算。 */
	proxy: {
		desc: "CPU 解码 + CPU 代理缩放",
		args: (input, w) => ["-i", input, "-vf", `scale=${w}:-2,${SCENE_TAP}`, "-f", "null", "-"],
	},
	/** 代理缩放显式钉 neighbor（点采样，不滤波）。默认 bicubic 缩 4K 的开销正好吃掉省下的
	 * scene score 开销 ⇒ 净亏损；neighbor 便宜得多。副作用：点采样保住帧间差幅度，
	 * 保真度反而**优于**默认 bicubic（bicubic 低通滤波会压低 scene score）。 */
	proxy_neighbor: {
		desc: "CPU 代理缩放 + flags=neighbor",
		args: (input, w) => ["-i", input, "-vf", `scale=${w}:-2:flags=neighbor,${SCENE_TAP}`, "-f", "null", "-"],
	},
	/** GPU 解码后自动回传 CPU（不带 hwaccel_output_format），再 CPU 缩放。回传的是全清帧 = PCIe 压力最大。 */
	nvdec: {
		desc: "NVDEC 解码 → 自动回 CPU → CPU 缩放",
		args: (input, w) => ["-hwaccel", "cuda", "-i", input, "-vf", `scale=${w}:-2,${SCENE_TAP}`, "-f", "null", "-"],
	},
	/** GPU 解码 + GPU 缩放 + 只回传小图。PCIe 压力最小，理论最优。scale_cuda 非 nonfree（不是 libnpp）。 */
	nvdec_cuda_scale: {
		desc: "NVDEC 解码 + scale_cuda GPU 缩放 → 只回传小图",
		args: (input, w) => [
			"-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-i", input,
			"-vf", `scale_cuda=${w}:-2,hwdownload,format=nv12,${SCENE_TAP}`,
			"-f", "null", "-",
		],
	},
	/** cuvid 解码器内建 resize：缩放在解码器内部完成。
	 * ⚠️ cuvid 解码器**按 codec 硬绑**（h264_cuvid 喂 AV1 流会报 "No start code is found"），
	 * 用它必须先 ffprobe 出 codec_name 再选对应解码器——这是它相对 `-hwaccel cuda`（自动选）的额外复杂度。 */
	cuvid_resize: {
		desc: "cuvid 内建 resize（需按 codec 选解码器）",
		args: (input, w, h, codec) => [
			"-c:v", `${codec || "h264"}_cuvid`, "-resize", `${w}x${h}`, "-i", input, "-vf", SCENE_TAP, "-f", "null", "-",
		],
	},
	/** GPU 全套 + 降帧：60fps 素材的镜头切换不可能比 30fps 更密，逐帧算 score 是浪费。
	 * ⚠️ 降帧改变「相邻帧」的语义（帧间差变成隔帧差）→ scene score 整体抬升，θ 可能需重标定。
	 * 本变体存在的意义就是把这个漂移量测出来，而不是假设它无害。 */
	gpu_fps15: {
		desc: "GPU 全套 + 降帧 15fps（score 语义有变，需验漂移）",
		args: (input, w) => [
			"-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-i", input,
			"-vf", `scale_cuda=${w}:-2,hwdownload,format=nv12,fps=15,${SCENE_TAP}`,
			"-f", "null", "-",
		],
	},
	gpu_fps30: {
		desc: "GPU 全套 + 降帧 30fps",
		args: (input, w) => [
			"-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-i", input,
			"-vf", `scale_cuda=${w}:-2,hwdownload,format=nv12,fps=30,${SCENE_TAP}`,
			"-f", "null", "-",
		],
	},
};

function runTimed(bin, args) {
	return new Promise((resolve) => {
		const t0 = process.hrtime.bigint();
		const p = spawn(bin, args, { env: process.env });
		let err = "";
		p.stderr.on("data", (b) => { err += b.toString("utf8"); });
		p.on("error", (e) => resolve({ ok: false, ms: 0, stderr: String(e), code: -1 }));
		p.on("close", (code) => {
			const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
			resolve({ ok: code === 0, ms, stderr: err, code });
		});
	});
}

/** 与 local-index.ts parseSceneScores 同构（台架独立实现，避免依赖构建产物）。 */
function parseSceneScores(stderr) {
	const out = [];
	let pending = null;
	for (const line of stderr.split(/\r?\n/)) {
		const head = line.match(/pts_time:([0-9]+(?:\.[0-9]+)?)/);
		if (head) { pending = Number(head[1]); continue; }
		const kv = line.match(/lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)/);
		if (kv && pending !== null) { out.push({ t: pending, score: Number(kv[1]) }); pending = null; }
	}
	return out;
}

const cutsFrom = (frames, theta) => frames.filter((f) => f.score > theta).map((f) => f.t);

/**
 * 切点集合配对：贪心最近邻，容差内算命中。
 * 返回 { matched, onlyA, onlyB, maxDrift, meanDrift } —— onlyB 是新增的假切点（最伤观感的那类）。
 */
/** 在 frames 里查 t 时刻附近的 score（用于「这个切点在该变体里到底拿了多少分」）。 */
function scoreAt(frames, t, tol) {
	let best = null, bestD = Infinity;
	for (const fr of frames) {
		const d = Math.abs(fr.t - t);
		if (d < bestD) { bestD = d; best = fr; }
	}
	return bestD <= tol ? best : null;
}

function compareCuts(a, b, tol) {
	const usedB = new Set();
	const drifts = [];
	const onlyA = [];
	for (const ta of a) {
		let best = -1, bestD = Infinity;
		for (let i = 0; i < b.length; i++) {
			if (usedB.has(i)) continue;
			const d = Math.abs(b[i] - ta);
			if (d < bestD) { bestD = d; best = i; }
		}
		if (best >= 0 && bestD <= tol) { usedB.add(best); drifts.push(bestD); }
		else onlyA.push(ta);
	}
	const onlyB = b.filter((_, i) => !usedB.has(i));
	return {
		matched: drifts.length,
		onlyA: onlyA.length, onlyB: onlyB.length,
		// 控制台只打前 12 条，但普查要数全量——两者分开存，别让展示截断污染统计
		onlyA_times: onlyA.slice(0, 12), onlyB_times: onlyB.slice(0, 12),
		onlyA_all: onlyA, onlyB_all: onlyB,
		maxDrift: drifts.length ? Math.max(...drifts) : 0,
		meanDrift: drifts.length ? drifts.reduce((s, d) => s + d, 0) / drifts.length : 0,
	};
}

const fmtMs = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(2)}min` : `${(ms / 1000).toFixed(1)}s`);

async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--list")) {
		for (const [k, v] of Object.entries(VARIANTS)) console.log(`  ${k.padEnd(18)} ${v.desc}`);
		return;
	}
	const input = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--variants"
		&& argv[argv.indexOf(a) - 1] !== "--threshold" && argv[argv.indexOf(a) - 1] !== "--tol"
		&& argv[argv.indexOf(a) - 1] !== "--json" && argv[argv.indexOf(a) - 1] !== "--proxy-width"
		&& argv[argv.indexOf(a) - 1] !== "--ffmpeg-path"
		&& argv[argv.indexOf(a) - 1] !== "--repeat");
	if (!input || !existsSync(input)) { console.error("用法：node scripts/bench-index-decode.mjs <视频> [--variants full,proxy] [--proxy-width 384]"); process.exit(2); }

	const pick = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
	const variants = String(pick("--variants", "full,proxy")).split(",").map((s) => s.trim()).filter(Boolean);
	const theta = Number(pick("--threshold", "0.3"));
	const tol = Number(pick("--tol", "0.10"));
	const proxyW = Number(pick("--proxy-width", "384"));
	const proxyH = Math.round(proxyW * 9 / 16 / 2) * 2; // cuvid -resize 要显式高，按 16:9 取偶
	const jsonOut = pick("--json", "");
	const repeat = Math.max(1, Number(pick("--repeat", "1")));
	const ffmpeg = locateFfmpeg();
	// cuvid 变体要按 codec 选解码器（h264_cuvid/av1_cuvid/…），先 probe 一次
	const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.toLowerCase().startsWith("ffmpeg.exe") ? "ffprobe.exe" : "ffprobe");
	const codec = await new Promise((res) => {
		const p = spawn(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", input]);
		let o = ""; p.stdout.on("data", (b) => { o += b.toString(); });
		p.on("error", () => res("")); p.on("close", () => res(o.trim()));
	});
	if (codec) console.log(`编码:   ${codec}`);

	console.log(`ffmpeg: ${ffmpeg}`);
	console.log(`素材:   ${basename(input)}`);
	console.log(`参数:   θ=${theta} 容差=${tol}s 代理宽=${proxyW}（cuvid 高=${proxyH}）重复=${repeat} 取中位\n`);

	const results = {};
	for (const name of variants) {
		const v = VARIANTS[name];
		if (!v) { console.log(`  ✗ ${name}：未知变体（--list 看清单）`); continue; }
		process.stdout.write(`  跑 ${name.padEnd(18)} ${v.desc} ... `);
		const args = v.args(input, proxyW, proxyH, codec);
		// 取**最小值**而非均值/中位数：干扰（后台进程、热降频）只会让某次变慢、绝不会让它变快，
		// 所以最快的那次最接近「这条路径本身的成本」。均值与中位数都会把干扰算进去。
		const runs = [];
		let r = null;
		for (let i = 0; i < repeat; i++) { r = await runTimed(ffmpeg, args); runs.push(r.ms); }
		const medMs = Math.min(...runs);
		const frames = parseSceneScores(r.stderr);
		// ffmpeg 对不支持的硬解会退出非零或产出零帧——两者都当失败，不静默当成「跑得飞快」
		if (!r.ok || frames.length === 0) {
			const tail = r.stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(" | ");
			console.log(`失败（code=${r.code} 帧数=${frames.length}）\n      ${tail.slice(0, 300)}`);
			results[name] = { ok: false, code: r.code, stderrTail: tail.slice(0, 600), cmd: args.join(" ") };
			continue;
		}
		const cuts = cutsFrom(frames, theta);
		const spread = runs.length > 1 ? `  (${runs.map((m) => (m / 1000).toFixed(1)).join("/")})` : "";
		// 极差 >25% ⇒ 机器上有别的活，这批数字不能当准（别人的干扰只会让某次变慢）
		const jitter = runs.length > 1 ? (Math.max(...runs) - Math.min(...runs)) / Math.min(...runs) : 0;
		const noisy = jitter > 0.25 ? `  ⚠️极差${(jitter * 100).toFixed(0)}%` : "";
		console.log(`${fmtMs(medMs).padStart(8)}  帧=${frames.length} 切点=${cuts.length}${spread}${noisy}`);
		results[name] = { ok: true, ms: medMs, runsMs: runs, jitter, frames: frames.length, cuts: cuts.length, cutTimes: cuts, scores: frames, cmd: args.join(" ") };
	}

	const base_ = results[variants[0]];
	const base = base_;
	if (base?.ok) {
		console.log(`\n对照基准 = ${variants[0]}（${fmtMs(base.ms)}，${base.cuts} 切点）`);
		for (const name of variants.slice(1)) {
			const r = results[name];
			if (!r?.ok) continue;
			const cmp = compareCuts(base.cutTimes, r.cutTimes, tol);
			r.speedup = base.ms / r.ms;
			r.cmp = cmp;
			console.log(`\n  ${name}：提速 ${r.speedup.toFixed(2)}×`);
			console.log(`    切点配对 ${cmp.matched}/${base.cuts}  漏 ${cmp.onlyA}  多 ${cmp.onlyB}` +
				`  漂移 均 ${cmp.meanDrift.toFixed(4)}s / 最大 ${cmp.maxDrift.toFixed(4)}s`);
			if (cmp.onlyA) {
				// 逐个报「它在本变体拿了多少分」——离 θ 只差一丝 = 刀刃上的边界切点（缩放算法差异所致），
				// 分数塌到远低于 θ = 这条路径真的看不见这个切点（性质完全不同，修法也不同）
				const detail = cmp.onlyA_times.map((t) => {
					const sc = scoreAt(r.scores, t, tol);
					const base = scoreAt(base_.scores, t, tol);
					return sc ? `${t.toFixed(2)}s(本路${sc.score.toFixed(3)} vs 基线${base ? base.score.toFixed(3) : "?"} θ=${theta})` : `${t.toFixed(2)}s(无对应帧)`;
				});
				console.log(`    漏掉的切点：${detail.join("  ")}`);
			}
			if (cmp.onlyB) console.log(`    多出的切点(前12)：${cmp.onlyB_times.map((t) => t.toFixed(2)).join(" ")}`);
		}
	}

	// ── 刀刃普查 ──────────────────────────────────────────────────────────────────
	// 「换解码路径后少了一个切点」听着像回归，但要先问：那个切点本来就稳吗？
	// score 落在 θ±ε 带内的切点是**天然不稳定**的——换 ffmpeg 版本、换机器、换编码参数
	// 都可能把它翻到另一边。这类分歧不是新路径的锅，把它和真回归分开算才有意义。
	if (base_?.ok) {
		const EPS = 0.02;
		const near = base_.scores.filter((fr) => Math.abs(fr.score - theta) < EPS);
		const nearCuts = near.filter((fr) => fr.score > theta);
		console.log(`\n刀刃普查（|score−θ| < ${EPS}）：基线 ${base_.cuts} 个切点里 ${nearCuts.length} 个坐在刀刃上` +
			`（另有 ${near.length - nearCuts.length} 个差一点就成切点）`);
		const nearSet = new Set(nearCuts.map((fr) => fr.t.toFixed(3)));
		for (const name of variants.slice(1)) {
			const r = results[name];
			if (!r?.ok || !r.cmp) continue;
			const onEdge = r.cmp.onlyA_all.filter((t) => nearSet.has(t.toFixed(3))).length;
			const offEdge = r.cmp.onlyA - onEdge;
			const tag = offEdge === 0 ? "✓ 分歧全在刀刃带内（非回归）" : `⚠️ 有 ${offEdge} 个分歧在刀刃带外——这才是真回归`;
			console.log(`  ${name.padEnd(18)} 漏 ${r.cmp.onlyA}（刀刃 ${onEdge} / 带外 ${offEdge}） 多 ${r.cmp.onlyB}  ${tag}`);
		}
		console.log(`  → 判据：**带外分歧为 0** 才算切点一致；刀刃带内的进出属固有噪声，不作回归。`);
	}

	if (jsonOut) {
		// cutTimes 体量大（千级），落盘留证但控制台不打
		// scores 逐帧体量大（万级），落盘只留切点与计时；边界分析在控制台已出
		const slim = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { ...v, scores: undefined }]));
		writeFileSync(jsonOut, JSON.stringify({ input, ffmpeg, theta, tol, proxyW, results: slim }, null, 2), "utf8");
		console.log(`\n证据落盘：${jsonOut}`);
	}
}

main();
