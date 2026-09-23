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

/* ══════════ 同合云字体库（change: link-cloud-font-library） ══════════ */

/**
 * 同合云字体库的对外清单。
 *
 * **与客户端的 `GET /task/font/families` 同源** —— 两者都由服务端
 * `font_services.list_font_families()` 投影产出，族名、字重、`font_id` 逐字段一致。
 * 这是本 change 的要点：`~/.gitruck/fonts` 是 CLI 与客户端**共享**的目录，
 * 两边各持一份清单、各用一套命名，就会出现同一款字体两份文件、两套清单各说各话。
 *
 * 旧路径（ffmpeg 分发 manifest 的 `font` 字段）过渡期保留，本版**不下线**：
 * 存量 CLI 还在拉它，且实测两处指向同一份文件（见 `SUBTITLE_FONT_FILE`）。
 */
export const FONT_MANIFEST_URL =
	"https://api.ai-mcn.tv:9000/cloud/static/assets/fonts/manifest.json";

/** 本 CLI 支持的字体清单 schema 上限；更高版本拒绝解析而非按旧格式猜（同 ffmpeg manifest 范式）。 */
export const SUPPORTED_FONT_SCHEMA = 1;

/**
 * 字幕烧录的缺省字体文件。
 *
 * ⚠️ **归一化后 MUST 等于 `sourcehansanscnbold`** —— 客户端
 * （`subtitles/subtitle-font-file.ts`）正是按这个归一化名在 `~/.gitruck/fonts` 里
 * 精确认字幕字体的，认错就会出现「画面上的字与属性面板写的字体对不上」。
 * 旧路径的 `SourceHanSansCN-Bold.otf` 归一化后同名，且 sha256 实测相同
 * （`97e5eff6dd208ccb…`，2026-09-16 两处比对），故过渡期并存不会让字形漂。
 */
export const SUBTITLE_FONT_FILE = "sourcehansanscn-bold.otf";

export interface CloudFontFace {
	face_id: string;
	file: string;
	weight: string;
	/** CSS 数值权重（字体 OS/2 表实报）。name 表的 subfamily 不可信，别拿 `weight` 当数值用。 */
	weight_css: number;
	italic: boolean;
	bytes: number;
	/** 下载强校验值。服务端老索引可能为空串 —— 空串 MUST NOT 当成「校验通过」。 */
	sha256: string;
	url: string;
}
export interface CloudFontFamily {
	font_id: string;
	family: string;
	family_en: string;
	license: string;
	face_count: number;
	weights: number[];
	faces: CloudFontFace[];
}
export interface CloudFontManifest {
	schema: number;
	generated: string;
	base_url: string;
	family_count: number;
	file_count: number;
	total_bytes: number;
	families: CloudFontFamily[];
}

/** 解析 + 校验字体清单（纯函数，便于离线测）。schema 高于支持上限直接拒绝。 */
export function parseFontManifest(raw: unknown): CloudFontManifest {
	if (!raw || typeof raw !== "object") throw new Error("字体清单不是对象");
	const m = raw as Partial<CloudFontManifest>;
	if (typeof m.schema !== "number") throw new Error("字体清单缺 schema 字段");
	if (m.schema > SUPPORTED_FONT_SCHEMA) {
		throw new Error(
			`字体清单 schema=${m.schema} 高于本 CLI 支持的 ${SUPPORTED_FONT_SCHEMA}，请先升级 CLI（gtrk upgrade）`,
		);
	}
	if (!Array.isArray(m.families)) throw new Error("字体清单缺 families 字段");
	return m as CloudFontManifest;
}

/** 取字体清单。 */
export async function fetchFontManifest(
	url = FONT_MANIFEST_URL,
): Promise<CloudFontManifest> {
	assertHttps(url);
	const r = await fetch(url);
	if (!r.ok) throw new Error(`取字体清单失败：HTTP ${r.status} ${url}`);
	return parseFontManifest(await r.json());
}

/**
 * 选出本次要装的 face。
 *
 * **缺省只装字幕字体那一款**，不是全库——184 款共 2.5GB，全量预装既慢又没必要
 * （烧录只用得到缺省字体，其余按需）。给了 `families` 就装这些族的全部字重，
 * 匹配 `font_id` / 中文族名 / 英文族名三者之一，大小写不敏感。
 *
 * 点名的族一个都没匹配上时**抛错而不是装 0 个**——「装完了但什么都没装」
 * 是最难察觉的一种失败。
 */
export function selectFontFaces(
	m: CloudFontManifest,
	families?: readonly string[],
): CloudFontFace[] {
	if (!families || families.length === 0) {
		const hit = m.families
			.flatMap((f) => f.faces)
			.find((f) => f.file === SUBTITLE_FONT_FILE);
		if (!hit) {
			throw new Error(
				`字体清单里没有缺省字幕字体 ${SUBTITLE_FONT_FILE}（清单 ${m.file_count} 款），` +
					`清单或字体库可能已漂移`,
			);
		}
		return [hit];
	}
	const want = families.map((s) => s.trim().toLowerCase()).filter(Boolean);
	const rows = m.families.filter((f) =>
		want.some(
			(w) =>
				f.font_id.toLowerCase() === w ||
				f.family.toLowerCase() === w ||
				f.family_en.toLowerCase() === w,
		),
	);
	if (rows.length === 0) {
		throw new Error(
			`字体清单里没有匹配 ${families.join(" / ")} 的族；` +
				`可选族名见 ${FONT_MANIFEST_URL}`,
		);
	}
	return rows.flatMap((f) => f.faces);
}

/**
 * 装字体到 ~/.gitruck/fonts。**不写系统字体表、不碰注册表、不要管理员权限。**
 *
 * 落盘文件名沿用清单命名（PostScript 名派生），与客户端下载的完全一致，
 * 故同一款字体在共享目录里只会有一份。
 */
export async function installFont(
	m: CloudFontManifest,
	opts: {
		force?: boolean;
		families?: readonly string[];
		onProgress?: (got: number, total: number) => void;
	} = {},
): Promise<InstallResult[]> {
	const out: InstallResult[] = [];
	const dest = fontsDir();
	for (const face of selectFontFaces(m, opts.families)) {
		const target = join(dest, face.file);
		if (existsSync(target) && !opts.force) {
			out.push({ installed: false, reason: "已存在", detail: `${face.file} → ${target}` });
			continue;
		}
		// 无校验值就拒装：强校验是这条链路的既有纪律，退化成「下了就用」会让
		// 传输层静默截断悄悄落盘，而字体半截的表现是缺字而不是报错。
		if (!face.sha256) {
			throw new Error(
				`字体 ${face.file} 在清单里没有 sha256，拒绝安装（强校验不可降级）`,
			);
		}
		const tmp = await downloadVerified(face.url, face.sha256, opts.onProgress);
		mkdirSync(dest, { recursive: true });
		rmSync(target, { force: true });
		renameSync(tmp, target);
		out.push({ installed: true, detail: `${face.file} → ${target}` });
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
