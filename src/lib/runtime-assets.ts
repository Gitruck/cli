/**
 * 运行时资产（ffmpeg/ffprobe 二进制、渲染字体）经 manifest 从同合云自建镜像按需获取。
 *
 * 纪律（change: add-runtime-asset-mirror）：
 *  - **绝不静默自动下载**——只在用户/agent 显式跑 `gtrk deps install` 时才拉。
 *  - 一律 https；下载先落 ~/.gitruck/tmp、**过 sha256 强校验**后才原子改名到目标位。
 *  - 解包**调系统 tar**，不引 npm 解压依赖（`.tar.xz` 的 BCJ+LZMA2 与 7z 压缩率等同，
 *    而 Win10+ bsdtar / macOS bsdtar / Linux GNU tar 均可直接解）。
 *  - 字体落 ~/.gitruck/fonts，**不装进系统字体表**（由 ass 滤镜的 fontsdir 供给 libass）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, chmodSync, renameSync, rmSync, readdirSync } from "node:fs";
import { createReadStream } from "node:fs";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { basename, dirname, join } from "node:path";
import { ffmpegDir, fontsDir, tmpDir } from "./paths";

/** 分发 manifest 位置。**该端口只说 HTTPS**，http:// 会被 nginx 以 400 拒绝。 */
export const MANIFEST_URL =
	"https://api.ai-mcn.tv:9000/broadcast/exe/ffmpeg/dist/manifest.json";

/** 本 CLI 支持的 manifest schema 版本上限；更高版本拒绝解析而非按旧格式猜。 */
export const SUPPORTED_SCHEMA = 1;

export interface FfmpegEntry {
	file: string;
	sha256: string;
	size: number;
	members: string[];
	version: string;
	builder: string;
	license: string;
	source: string;
	archive: string;
}
export interface FontEntry {
	file: string;
	sha256: string;
	size: number;
	license: string;
	aliases?: string[];
	url: string;
}
export interface AssetManifest {
	schema: number;
	generated: string;
	base: string;
	ffmpeg: Record<string, FfmpegEntry>;
	font: Record<string, FontEntry>;
	source?: Record<string, { sha256: string; size: number }>;
}

/** URL 必须是 https。分发端口只接 HTTPS，http 会拿到 400 而不是内容——早失败好过下到一坨 HTML。 */
export function assertHttps(url: string): void {
	if (!/^https:\/\//i.test(url)) {
		throw new Error(`运行时资产下载 MUST 用 https，收到：${url}`);
	}
}

/** 实际分发的平台组合。**不是 OS × CPU 的笛卡尔积**——如 linux-arm64 并无分发包。 */
export const DISTRIBUTED_PLATFORMS = ["win-x64", "linux-x64", "mac-x64", "mac-arm64"] as const;

/** `${platform}-${arch}` → manifest 平台键。未覆盖组合明确抛错，不静默落空、不错装其他架构。 */
export function resolvePlatformKey(
	platform: string = process.platform,
	arch: string = process.arch,
): string {
	const os = { win32: "win", linux: "linux", darwin: "mac" }[platform];
	const cpu = { x64: "x64", arm64: "arm64" }[arch];
	const key = os && cpu ? `${os}-${cpu}` : "";
	if (!key || !(DISTRIBUTED_PLATFORMS as readonly string[]).includes(key)) {
		throw new Error(
			`当前平台 ${platform}-${arch} 无对应的 ffmpeg 分发包（已分发：${DISTRIBUTED_PLATFORMS.join(" / ")}）。` +
				`请自行安装 ffmpeg/ffprobe 到 ${ffmpegDir()}，或用 --ffmpeg-path <目录> 指定已装位置。`,
		);
	}
	return key;
}

/** 解析 + 校验 manifest（纯函数，便于离线测）。schema 高于支持上限直接拒绝。 */
export function parseManifest(raw: unknown): AssetManifest {
	if (!raw || typeof raw !== "object") throw new Error("manifest 不是对象");
	const m = raw as Partial<AssetManifest>;
	if (typeof m.schema !== "number") throw new Error("manifest 缺 schema 字段");
	if (m.schema > SUPPORTED_SCHEMA) {
		throw new Error(
			`manifest schema=${m.schema} 高于本 CLI 支持的 ${SUPPORTED_SCHEMA}，请先升级 CLI（gtrk upgrade）`,
		);
	}
	if (!m.base || !m.ffmpeg || !m.font) throw new Error("manifest 缺 base/ffmpeg/font 字段");
	assertHttps(m.base);
	return m as AssetManifest;
}

/** 取 manifest。 */
export async function fetchManifest(url = MANIFEST_URL): Promise<AssetManifest> {
	assertHttps(url);
	const r = await fetch(url);
	if (!r.ok) throw new Error(`取 manifest 失败：HTTP ${r.status} ${url}`);
	return parseManifest(await r.json());
}

/** 算文件 sha256。 */
export async function sha256File(path: string): Promise<string> {
	const h = createHash("sha256");
	await pipeline(createReadStream(path), h);
	return h.digest("hex");
}

/**
 * 定位系统 tar。Windows 上**优先 System32\tar.exe（bsdtar）**——用户 PATH 里常有
 * Git-Bash/MSYS 的 GNU tar 排在前面，而 GNU tar 会把 `C:\...` 当成远程主机 `C` 的路径
 * （报 "Cannot connect to C: resolve failed"）。
 */
export function systemTarPath(): string {
	if (process.platform === "win32") {
		const sys = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
		if (existsSync(sys)) return sys;
	}
	return "tar";
}

/** 系统 tar 是否可用。 */
export function hasSystemTar(): boolean {
	try {
		return spawnSync(systemTarPath(), ["--version"], { stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
}

/**
 * 下载到暂存区并过 sha256 闸。**校验不通过 MUST 删除半成品且不落地**——
 * 返回的是暂存路径，调用方负责搬到目标位。
 */
export async function downloadVerified(
	url: string,
	expectSha256: string,
	onProgress?: (got: number, total: number) => void,
): Promise<string> {
	assertHttps(url);
	mkdirSync(tmpDir(), { recursive: true });
	const tmp = join(tmpDir(), `dl-${Date.now()}-${url.split("/").pop() ?? "asset"}`);
	try {
		const r = await fetch(url);
		if (!r.ok) throw new Error(`下载失败：HTTP ${r.status} ${url}`);
		if (!r.body) throw new Error(`下载失败：响应无 body ${url}`);
		const total = Number(r.headers.get("content-length") ?? 0);
		let got = 0;
		const reader = r.body.getReader();
		const ws = createWriteStream(tmp);
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				got += value.length;
				if (onProgress) onProgress(got, total);
				if (!ws.write(value)) await once(ws, "drain");
			}
		} finally {
			ws.end();
		}
		await once(ws, "close");

		const actual = await sha256File(tmp);
		if (actual !== expectSha256) {
			rmSync(tmp, { force: true });
			throw new Error(
				`sha256 校验不通过，已丢弃下载物、未落地任何文件。\n  期望 ${expectSha256}\n  实得 ${actual}\n  来源 ${url}`,
			);
		}
		return tmp;
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}

/** 调**系统 tar** 解包到目标目录。不引 npm 解压依赖。 */
export function extractTar(archive: string, destDir: string): void {
	if (!hasSystemTar()) {
		throw new Error(
			`未找到可用的系统 tar，无法解包 ${archive}。\n` +
				`Windows 10+/macOS/Linux 通常自带；若确无，请手工解开该 .tar.xz 并把二进制放到 ${destDir}。`,
		);
	}
	mkdirSync(destDir, { recursive: true });
	// 档名只传 basename + cwd 落在其所在目录：彻底绕开 GNU tar 的「冒号=远程主机」启发式
	// （`C:\x\a.tar` 会被解析成 host=C、path=\x\a.tar）。-C 的参数不受该启发式影响，可原样传。
	const r = spawnSync(systemTarPath(), ["-xf", basename(archive), "-C", destDir], {
		cwd: dirname(archive),
		encoding: "utf8",
	});
	if (r.status !== 0) {
		throw new Error(`tar 解包失败（code=${r.status}）：${(r.stderr || "").slice(-300)}`);
	}
}

export interface InstallResult {
	installed: boolean;
	/** installed=false 时说明为何跳过 */
	reason?: string;
	detail?: string;
}

/**
 * 装 ffmpeg/ffprobe 到 ~/.gitruck/ffmpeg。**已存在则跳过**（先查后拉）。
 * 只填 ~/.gitruck/ffmpeg 这一格，不改变 resolveFfmpeg 的优先级、不越过用户自装的 ffmpeg。
 */
export async function installFfmpeg(
	m: AssetManifest,
	opts: { force?: boolean; onProgress?: (got: number, total: number) => void } = {},
): Promise<InstallResult> {
	const key = resolvePlatformKey();
	const entry = m.ffmpeg[key];
	if (!entry) {
		throw new Error(
			`manifest 中无 ${key} 的 ffmpeg 包（可用：${Object.keys(m.ffmpeg).join(" / ")}）。` +
				`请自行安装到 ${ffmpegDir()} 或用 --ffmpeg-path。`,
		);
	}
	const dest = ffmpegDir();
	const already = entry.members.every((f) => existsSync(join(dest, f)));
	if (already && !opts.force) {
		return { installed: false, reason: "已存在", detail: `${dest}（--force 可覆盖）` };
	}

	const tmp = await downloadVerified(`${m.base}/${entry.file}`, entry.sha256, opts.onProgress);
	try {
		// 先解到暂存子目录，确认成员齐备后再整体搬入目标位（避免半套二进制污染 ~/.gitruck/ffmpeg）
		const stage = join(tmpDir(), `x-${Date.now()}`);
		extractTar(tmp, stage);
		for (const f of entry.members) {
			if (!existsSync(join(stage, f))) {
				rmSync(stage, { recursive: true, force: true });
				throw new Error(`解包结果缺成员 ${f}，已中止，未改动 ${dest}`);
			}
		}
		mkdirSync(dest, { recursive: true });
		for (const f of entry.members) {
			const target = join(dest, f);
			rmSync(target, { force: true });
			renameSync(join(stage, f), target);
			if (process.platform !== "win32") chmodSync(target, 0o755);
		}
		rmSync(stage, { recursive: true, force: true });
		return { installed: true, detail: `${entry.version} → ${dest}` };
	} finally {
		rmSync(tmp, { force: true });
	}
}

/** 装字体到 ~/.gitruck/fonts。**不写系统字体表、不碰注册表、不要管理员权限。** */
export async function installFont(
	m: AssetManifest,
	opts: { force?: boolean; onProgress?: (got: number, total: number) => void } = {},
): Promise<InstallResult[]> {
	const out: InstallResult[] = [];
	const dest = fontsDir();
	for (const [name, entry] of Object.entries(m.font)) {
		const target = join(dest, entry.file);
		if (existsSync(target) && !opts.force) {
			out.push({ installed: false, reason: "已存在", detail: `${name} → ${target}` });
			continue;
		}
		const tmp = await downloadVerified(entry.url, entry.sha256, opts.onProgress);
		mkdirSync(dest, { recursive: true });
		rmSync(target, { force: true });
		renameSync(tmp, target);
		out.push({ installed: true, detail: `${name} → ${target}` });
	}
	return out;
}

/** ~/.gitruck/fonts 下是否已有字体文件（决定烧录时要不要传 fontsdir）。 */
export function hasLocalFonts(): boolean {
	try {
		return readdirSync(fontsDir()).some((f) => /\.(otf|ttf|ttc|otc)$/i.test(f));
	} catch {
		return false;
	}
}
