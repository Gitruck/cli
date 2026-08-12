/**
 * 本地素材免切片索引（add-matrix-local-search · local-material-index spec）。
 *
 * 链路：ffmpeg 场景边界检测（select gte(scene,0)+metadata=print 单趟解码双产物——切点=score>θ
 * 客户端判定，与旧 select gt(scene,θ)+showinfo 链切点逐字节一致（真机对拍 35/35）；每帧 scene score
 * 顺手供场景稳定性判定，add-index-stability-sampling；**只记时间戳不产生任何切片文件**）
 * → 场景自适应抽帧（≤4s 场景中点 1 帧；>4s 每 2s 加密；**stable 场景收敛为中点 1 帧**；
 *   512px 最长边 jpg，抽到 ~/.gitruck/tmp）
 * → 自建 embed 端点向量化（批 ≤16，embed-client）→ SQLite 三表落库（帧图 embed 成功即删，即传即弃）。
 *
 * 存储（D1）：~/.gitruck/local-broll-index/index.db，materials/scenes/frames 三表，
 * vec = float32 **小端** BLOB。检索时全量载入内存点积（local-search.ts），不引向量库。
 *
 * 增量（D2）：素材粒度 (绝对路径, size, mtime) 指纹——未变跳过；变了级联删旧行重建；
 * 文件消失行**保留**（可移动盘场景，检索时过滤）；`--rebuild` 强制全量。
 * 断点续传 = 每素材一个事务：中断不留半素材，重跑从未完成素材继续、已完成零重算。
 * 索引键是绝对路径 ⇒ **跨机不可移植**（三机盘符各异），属机器本地缓存，可随时重建，不进 git 不同步。
 *
 * 计量会话（infra 计费细案第 6 条，2026-08-12）：编排两阶段化——阶段一先对全部待索引素材做
 * 场景检测+抽帧计划（零 embed 请求），得**抽帧计划总数** → session open（预扣）；阶段二逐素材
 * 抽帧+embed（批请求带 session_token）+ 事务落库；完成/失败均 close 结算实际用量（失败也结算，
 * close 自身失败由服务端 /internal/quota/reconcile 15min cron 兜底）。internal 矩阵成员豁免
 * （无会话零计费）由命令层探身份后以「不传 session hooks」表达。
 *
 * SQLite 运行时（tasks 1.2/2.1 注记）：Bun 下用内置 bun:sqlite；发布产物跑在 node（bin=dist/index.js，
 * engines>=20.6 实际需 22.5+）时退 node:sqlite（同为内置，零新依赖）——二者经统一 SqlDb 薄适配。
 */
import { mkdirSync, existsSync, readdirSync, statSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, join, resolve, basename } from "node:path";
import { createBLAKE3 } from "hash-wasm";
import { homeFile, tmpDir } from "./paths";
import { requireFfmpeg, runFfmpeg, type FfmpegResolution } from "./ffmpeg";
import { probeGeometry } from "./media";
import { BROLL_LOCAL_MATERIAL_PREFIX } from "./matrix-lay";
import { EMBED_BATCH_MAX, EMBED_UNREACHABLE_CODE, type EmbedInput } from "./embed-client";

// ── 参数基线（POC 标定值，design D4；θ 经 --scene-threshold 暴露）──────────
export const SCENE_THRESHOLD_DEFAULT = 0.3;
/** 场景稳定性判定阈值（--stability-threshold，add-index-stability-sampling）：场景内最大帧间
 * scene score 低于此值 → stable（固定机位）。默认取保守值 0.05——**待 2.2 验证批次标定**；
 * 宁严勿松（误判 unstable 只是不省钱，误判 stable 丢检索粒度）。 */
export const STABILITY_THRESHOLD_DEFAULT = 0.05;
/** 比这短的边界间隔并入前段（秒）。 */
export const MIN_SCENE_SEC = 0.5;
/** >4s 场景的加密抽帧间隔（秒）。 */
export const FRAME_LONG_INTERVAL_SEC = 2.0;
/** 抽帧最长边（px）。 */
export const FRAME_MAX_EDGE = 512;

/** 索引可收录的视频扩展名。 */
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|wmv|mpg|mpeg|ts|mts|m2ts|flv)$/i;

/** 索引可收录的图片扩展名（add-matrix-local-image-broll · image_ext 白名单，与 tool 族图片白名单同族）。 */
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|bmp|gif|tif|tiff|heic|heif|avif)$/i;

export type MaterialKind = "video" | "image";

/** 按扩展名判素材 kind（白名单外返回 null，不收录）。 */
export function materialKindForPath(path: string): MaterialKind | null {
	if (VIDEO_EXT.test(path)) return "video";
	if (IMAGE_EXT.test(path)) return "image";
	return null;
}

/** 索引目录 ~/.gitruck/local-broll-index（env GITRUCK_LOCAL_INDEX_DIR 可覆盖，测试/多机隔离用）。 */
export function localIndexDir(): string {
	return process.env.GITRUCK_LOCAL_INDEX_DIR?.trim() || homeFile("local-broll-index");
}
export function localIndexDbPath(): string {
	return join(localIndexDir(), "index.db");
}

// ── 身份（task 1.2）：broll-local-<blake3-16>，文件**全量内容**哈希，改名/移动不变身份 ──

/** 文件内容 blake3 全量哈希（流式，8MiB/块；与 chunk-upload 的 fast_mode 秒传指纹**不是**同一口径）。 */
export async function fileBlake3Hex(path: string): Promise<string> {
	const hasher = await createBLAKE3();
	hasher.init();
	const fh = await open(path, "r");
	try {
		const buf = Buffer.alloc(8 * 1024 * 1024);
		for (;;) {
			const { bytesRead } = await fh.read(buf, 0, buf.length, -1);
			if (bytesRead === 0) break;
			hasher.update(buf.subarray(0, bytesRead));
		}
		return hasher.digest("hex") as string;
	} finally {
		await fh.close();
	}
}

/** 本地素材身份：`broll-local-` + 内容 blake3 前 16 hex（免碰撞、同内容改名同 id）。 */
export async function brollLocalIdForFile(path: string): Promise<string> {
	return `${BROLL_LOCAL_MATERIAL_PREFIX}${(await fileBlake3Hex(path)).slice(0, 16)}`;
}

// ── SQLite 薄适配（bun:sqlite / node:sqlite 双内置，统一到 SqlDb）──────────

export interface SqlDb {
	exec(sql: string): void;
	run(sql: string, params?: unknown[]): void;
	all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
	get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
	close(): void;
}

export async function openSqlite(path: string): Promise<SqlDb> {
	mkdirSync(dirname(path), { recursive: true });
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
		const { Database } = await import("bun:sqlite");
		const db = new Database(path, { create: true });
		return {
			exec: (sql) => db.exec(sql),
			run: (sql, params = []) => void db.query(sql).run(...(params as never[])),
			all: <T>(sql: string, params: unknown[] = []) => db.query(sql).all(...(params as never[])) as T[],
			get: <T>(sql: string, params: unknown[] = []) => (db.query(sql).get(...(params as never[])) ?? undefined) as T | undefined,
			close: () => db.close(),
		};
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(path);
	return {
		exec: (sql) => db.exec(sql),
		run: (sql, params = []) => void db.prepare(sql).run(...(params as never[])),
		all: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
		get: <T>(sql: string, params: unknown[] = []) => (db.prepare(sql).get(...(params as never[])) ?? undefined) as T | undefined,
		close: () => db.close(),
	};
}

/** 事务包裹（跨适配统一 BEGIN/COMMIT/ROLLBACK；素材粒度断点续传的原子性来源）。 */
export function withTransaction(db: SqlDb, fn: () => void): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		fn();
		db.exec("COMMIT");
	} catch (e) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* 回滚失败不掩盖原错误 */
		}
		throw e;
	}
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id TEXT NOT NULL,            -- broll-local-<blake3-16>（身份随内容不随路径）
  path TEXT NOT NULL UNIQUE,            -- 绝对路径（索引键；跨机不可移植）
  kind TEXT NOT NULL DEFAULT 'video',   -- video|image（add-matrix-local-image-broll；旧库 ALTER 迁移）
  size INTEGER NOT NULL,                -- 指纹：size
  mtime_ms INTEGER NOT NULL,            -- 指纹：mtime（毫秒取整）
  duration_ms INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_material_id ON materials(material_id);
CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL,         -- → materials.id（级联删由 deleteMaterialRows 显式做）
  st_ms INTEGER NOT NULL,
  ed_ms INTEGER NOT NULL,
  stable INTEGER                        -- 1=stable（固定机位，中点单帧）；NULL/0=unstable（旧行/图片行按 unstable 语义）
);
CREATE INDEX IF NOT EXISTS idx_scenes_material ON scenes(material_id);
CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,            -- → scenes.id
  material_id INTEGER NOT NULL,         -- → materials.id（检索载入免二跳）
  ts_ms INTEGER NOT NULL,
  vec BLOB NOT NULL                     -- float32 小端 1024 维
);
CREATE INDEX IF NOT EXISTS idx_frames_material ON frames(material_id);
CREATE TABLE IF NOT EXISTS describes (
  material_id TEXT NOT NULL,            -- broll- 家族材料 id（字符串，随内容不随行号——生命周期独立于三表）
  ts_ms INTEGER NOT NULL,               -- 帧时刻（缓存键第二维）
  desc_text TEXT NOT NULL,              -- VLM 一句话描述（desc 是 SQL 关键字，列名避让）
  tags_json TEXT NOT NULL,              -- string[] JSON
  mark INTEGER,                         -- 0-100 质量分
  flags_json TEXT NOT NULL,             -- usable_flags JSON（watermark/text_overlay/black_border/blurry…）
  created_at TEXT NOT NULL,
  PRIMARY KEY (material_id, ts_ms)
);
`;

/** 打开（或初建）索引库：建三表 + kind/stable 列幂等迁移 + schema 版本登记。 */
export async function openLocalIndexDb(dbPath: string = localIndexDbPath()): Promise<SqlDb> {
	const db = await openSqlite(dbPath);
	db.exec(SCHEMA_SQL);
	// kind 列幂等迁移（add-matrix-local-image-broll 2.1）：图片能力引入前的旧库以 ALTER 补列，
	// 旧行 DEFAULT 'video' 天然回填（旧视频行为零影响）；新库由 CREATE TABLE 直接带列，两路都幂等。
	// scenes.stable 列幂等迁移（add-index-stability-sampling）：旧行 NULL 按 unstable 语义消费
	// （检索聚合只对 stable=1 走整场景对齐），增量素材按新逻辑判定；--rebuild 全量重判。
	try {
		const cols = db.all<{ name: string }>("PRAGMA table_info(materials)");
		if (!cols.some((c) => c.name === "kind")) {
			db.exec("ALTER TABLE materials ADD COLUMN kind TEXT NOT NULL DEFAULT 'video'");
		}
		const sceneCols = db.all<{ name: string }>("PRAGMA table_info(scenes)");
		if (!sceneCols.some((c) => c.name === "stable")) {
			db.exec("ALTER TABLE scenes ADD COLUMN stable INTEGER");
		}
	} catch (e) {
		db.close();
		throw new Error(
			`索引库列迁移失败（${e instanceof Error ? e.message : String(e)}）——索引是可随时重建的本机缓存，` +
				`建议跑 gtrk matrix index --dirs <...> --rebuild 重建（或删除 ${dbPath} 后重跑索引）`,
		);
	}
	db.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')");
	return db;
}

export interface MaterialRow {
	id: number;
	material_id: string;
	path: string;
	/** video|image（迁移后旧行恒 video）。 */
	kind: string;
	size: number;
	mtime_ms: number;
	duration_ms: number;
	width: number | null;
	height: number | null;
	fps: number | null;
	indexed_at: string;
}

/** 级联删一个素材的全部行（frames → scenes → materials；显式删，不依赖外键 pragma）。 */
export function deleteMaterialRows(db: SqlDb, materialRowId: number): void {
	db.run("DELETE FROM frames WHERE material_id = ?", [materialRowId]);
	db.run("DELETE FROM scenes WHERE material_id = ?", [materialRowId]);
	db.run("DELETE FROM materials WHERE id = ?", [materialRowId]);
}

/** 清一个素材的全部理解缓存（describes 键=字符串材料 id；add-matrix-describe-and-window D1）。
 * 只在 size:mtime **指纹真变**时由索引编排调用（--rebuild 指纹未变 MUST NOT 清——理解产物与向量
 * 生命周期独立，重建向量不该报废花过钱的 VLM 缓存）。 */
export function clearDescribesForMaterial(db: SqlDb, materialId: string): void {
	db.run("DELETE FROM describes WHERE material_id = ?", [materialId]);
}

// ── 向量编解码（float32 小端 BLOB；平台字节序无关的确定性写读）──────────────

const IS_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export function encodeVec(vec: Float32Array): Uint8Array {
	if (IS_LE) return new Uint8Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
	const out = new Uint8Array(vec.length * 4);
	const dv = new DataView(out.buffer);
	for (let i = 0; i < vec.length; i++) dv.setFloat32(i * 4, vec[i]!, true);
	return out;
}

export function decodeVec(blob: Uint8Array): Float32Array {
	// 拷贝一份保证 4 字节对齐（SQLite 驱动返回的 view 可能带任意 byteOffset）
	const bytes = new Uint8Array(blob);
	if (IS_LE) return new Float32Array(bytes.buffer, 0, bytes.byteLength / 4);
	const n = bytes.byteLength / 4;
	const dv = new DataView(bytes.buffer);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
	return out;
}

// ── 场景边界检测（D4 + add-index-stability-sampling：单趟解码双产物；只记时间戳，MUST NOT 产生切片文件）──

/** 从 ffmpeg showinfo stderr 提取 pts_time（升序，即场景切换时间点）。
 * 旧 select gt(scene,θ)+showinfo 链的解析器——生产链已换 metadata=print（parseSceneScores），
 * 保留本函数供切点回归对拍（新旧链切点必须逐字节一致）。 */
export function parseSceneCuts(stderr: string): number[] {
	const out: number[] = [];
	for (const m of stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)) out.push(Number(m[1]));
	return out;
}

/** 从 ffmpeg `select='gte(scene,0)',metadata=print` stderr 提取每帧 (pts_time, scene score)。
 * metadata=print 每帧两行：帧头行（frame:N pts:P pts_time:T）+ 键值行（lavfi.scene_score=S），
 * 逐行配对（真机验证格式，ffmpeg n8.1）；首帧 score 恒 0（无前帧）。 */
export function parseSceneScores(stderr: string): { ts: number; score: number }[] {
	const out: { ts: number; score: number }[] = [];
	let ts: number | undefined;
	for (const line of stderr.split(/\r?\n/)) {
		if (!line.includes("Parsed_metadata")) continue;
		const head = line.match(/frame:\d+\s.*\bpts_time:([0-9]+(?:\.[0-9]+)?)/);
		if (head) {
			ts = Number(head[1]);
			continue;
		}
		const kv = line.match(/lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)/);
		if (kv && ts !== undefined) {
			out.push({ ts, score: Number(kv[1]) });
			ts = undefined;
		}
	}
	return out;
}

/** 切点 → 场景区间（秒）：<0.5s 的边界间隔并入前段（POC detect_scenes 逐行对齐）。 */
export function buildScenes(cuts: number[], durationSec: number, minSceneSec: number = MIN_SCENE_SEC): { st: number; ed: number }[] {
	const bounds = [0];
	for (const t of cuts) {
		if (t - bounds[bounds.length - 1]! >= minSceneSec) bounds.push(t);
	}
	if (durationSec - bounds[bounds.length - 1]! >= minSceneSec) bounds.push(durationSec);
	else bounds[bounds.length - 1] = durationSec;
	const scenes: { st: number; ed: number }[] = [];
	for (let i = 0; i < bounds.length - 1; i++) scenes.push({ st: bounds[i]!, ed: bounds[i + 1]! });
	return scenes;
}

/** 跑 ffmpeg 抓全量 stderr（runFfmpeg 只留尾 4000 字会截断，故独立实现）。
 * metadata=print 逐帧两行 ⇒ stderr 体量 O(帧数)（~170B/帧，1h@30fps ≈ 18MB 字符串）——CLI 单素材
 * 串行处理下可接受；若未来撑不住再换流式逐行消费。 */
function runFfmpegCaptureStderr(bin: string, args: string[]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const p = spawn(bin, args, { env: process.env });
		let err = "";
		p.stderr.on("data", (b: Buffer) => {
			err += b.toString("utf8");
		});
		p.on("error", (e) => reject(e));
		// select+showinfo 到 -f null 正常退 0；异常码也先回 stderr（调用方解析不出切点自然为空）
		p.on("close", () => resolvePromise(err));
	});
}

/** 场景区间 + 稳定性注记（add-index-stability-sampling）。 */
export interface SceneSpan {
	st: number;
	ed: number;
	/** 场景内最大帧间 scene score（不含场景起点切帧本身——它量的是切入该场景的跳变；无内点=0）。 */
	maxScore: number;
	/** maxScore < stabilityThreshold ⇒ 固定机位类稳定场景（抽帧收敛为中点 1 帧）。 */
	stable: boolean;
}

/** 场景区间 → 稳定性注记（双指针单趟；scenes 与 frameScores 均按时间升序）。
 * 每场景取 (st, ed) **开区间内**帧的最大 score：ts==st 是切入本场景的切帧（跳变分不算场内运动）、
 * ts==ed 是切入下一场景的切帧；<0.5s 并段丢弃的切点留在段内 ⇒ 其高分自然把该段判 unstable（正确语义）。 */
export function annotateSceneStability(
	scenes: { st: number; ed: number }[],
	frameScores: { ts: number; score: number }[],
	stabilityThreshold: number = STABILITY_THRESHOLD_DEFAULT,
): SceneSpan[] {
	const out: SceneSpan[] = scenes.map((s) => ({ st: s.st, ed: s.ed, maxScore: 0, stable: true }));
	let si = 0;
	for (const f of frameScores) {
		while (si < out.length && f.ts >= out[si]!.ed) si++;
		if (si >= out.length) break;
		const s = out[si]!;
		if (f.ts > s.st && f.score > s.maxScore) s.maxScore = f.score;
	}
	for (const s of out) s.stable = s.maxScore < stabilityThreshold;
	return out;
}

/** 场景边界检测：返回场景区间（秒）+ 稳定性注记。源文件与其所在目录不产生任何新媒体文件。
 * 单趟解码双产物（spec MUST NOT 为判定新增解码 pass）：select 表达式放到 gte(scene,0)（全帧通过，
 * scene score 本就逐帧计算，解码量不变），metadata=print 打出每帧 score——切点改为客户端按
 * score>θ 判定，与旧 select gt(scene,θ) 的选帧集合定义相同（真机对拍切点逐字节一致）。 */
export async function detectScenes(
	ffmpeg: string,
	path: string,
	durationSec: number,
	threshold: number = SCENE_THRESHOLD_DEFAULT,
	stabilityThreshold: number = STABILITY_THRESHOLD_DEFAULT,
): Promise<SceneSpan[]> {
	const stderr = await runFfmpegCaptureStderr(ffmpeg, [
		"-i", path,
		"-vf", "select='gte(scene,0)',metadata=print",
		"-f", "null", "-",
	]);
	const frames = parseSceneScores(stderr);
	const cuts = frames.filter((f) => f.score > threshold).map((f) => f.ts);
	return annotateSceneStability(buildScenes(cuts, durationSec), frames, stabilityThreshold);
}

// ── 场景自适应抽帧计划（POC plan_frames 逐行对齐）──────────────────────────

/** ≤4s 场景取中点 1 帧；>4s 场景自 st+1.0 起每 2s 一帧（t < ed-0.5 为界）。
 * stable 场景（add-index-stability-sampling）：无论长短收敛为中点 1 帧——固定机位 60s 场景
 * 从 30 帧收敛到 1 帧；不带 stable 标记（旧调用/旧注入面）行为与之前逐字节一致。 */
export function planFrames(scenes: { st: number; ed: number; stable?: boolean }[]): { sceneIdx: number; ts: number }[] {
	const plan: { sceneIdx: number; ts: number }[] = [];
	for (let si = 0; si < scenes.length; si++) {
		const { st, ed, stable } = scenes[si]!;
		const dur = ed - st;
		if (dur <= 4.0 || stable === true) {
			plan.push({ sceneIdx: si, ts: st + dur / 2 });
		} else {
			let t = st + 1.0;
			while (t < ed - 0.5) {
				plan.push({ sceneIdx: si, ts: t });
				t += FRAME_LONG_INTERVAL_SEC;
			}
		}
	}
	return plan;
}

/** 抽单帧 512px jpg（POC 同款 scale 表达式；-q:v 3）。 */
export async function extractFrameJpg(ffmpeg: string, path: string, tsSec: number, outJpg: string): Promise<boolean> {
	try {
		await runFfmpeg(ffmpeg, [
			"-y", "-v", "error", "-ss", tsSec.toFixed(3), "-i", path, "-vframes", "1",
			"-vf", `scale='if(gte(iw,ih),min(${FRAME_MAX_EDGE},iw),-2)':'if(lt(iw,ih),min(${FRAME_MAX_EDGE},ih),-2)'`,
			"-q:v", "3", outJpg,
		]);
	} catch {
		return false;
	}
	return existsSync(outJpg);
}

// ── 素材处理与索引编排（2.3/2.4/2.5 + 计量会话联动）────────────────────────

/** 阶段一产物：单素材抽帧**计划**（零 embed 请求；注入面 planMaterial 可整体替换，免 ffmpeg 依赖）。 */
export interface PlannedMaterial {
	materialId: string;
	/** 素材 kind（缺省按 video 兜底——旧注入面/旧调用零改动）。 */
	kind?: MaterialKind;
	durationMs: number;
	width: number;
	height: number;
	fps: number;
	/** 场景区间（毫秒取整）；图片恒统一形态一行 0..0（无场景轴，D1）。
	 * stable（add-index-stability-sampling）：缺省 undefined = unstable 语义（旧注入面零改动）；
	 * 图片行不参与判定（本就单帧），恒不带该标记。 */
	scenes: { st_ms: number; ed_ms: number; stable?: boolean }[];
	/** 抽帧计划（sceneIdx 指向 scenes 下标）——计划总数即计量会话 planned_units；图片恒单帧 ts_ms=0。 */
	framePlan: { sceneIdx: number; ts_ms: number }[];
}

/** 阶段二产物：帧向量（sceneIdx 指向 PlannedMaterial.scenes 下标）。 */
export interface FrameVec {
	sceneIdx: number;
	ts_ms: number;
	vec: Float32Array;
}

/** 计量会话钩子（命令层接 embed-client 的 open/close；internal 豁免 = 不传本钩子）。 */
export interface IndexSessionHooks {
	open(plannedUnits: number): Promise<{ sessionToken: string; preDeductedCredits: number }>;
	close(sessionToken: string): Promise<{ usedUnits: number; settledCredits: number; refundedCredits: number }>;
}

/** 计量会话账面（仅会话真开过时出现在结果里）。 */
export interface IndexBillingOutcome {
	plannedUnits: number;
	preDeductedCredits: number;
	usedUnits?: number;
	settledCredits?: number;
	refundedCredits?: number;
	/** close 调用失败：结算交由服务端 /internal/quota/reconcile 兜底（15min cron），用量不丢。 */
	reconcilePending?: boolean;
}

export interface IndexRunOptions {
	/** 索引范围（--dirs，绝对/相对均可，内部 resolve）。 */
	dirs: string[];
	dbPath?: string;
	sceneThreshold?: number;
	/** 场景稳定性判定阈值（--stability-threshold，默认 STABILITY_THRESHOLD_DEFAULT——保守值待标定）。 */
	stabilityThreshold?: number;
	rebuild?: boolean;
	/** embed 客户端（命令层注入 embedInputs 闭包；测试注入假端点）。图像批请求带会话 token。 */
	embed: (inputs: EmbedInput[], sessionToken?: string) => Promise<Float32Array[]>;
	/** 计量会话钩子：缺省/计划帧数为 0 时不开会话（internal 豁免、纯增量跳过场景零计费）。 */
	session?: IndexSessionHooks;
	ffmpegPath?: string;
	/** 逐素材进度行（人读，命令层接 log.info）。 */
	onProgress?: (line: string) => void;
	/** 测试注入：整体替换阶段一（探测/场景检测/抽帧计划）。 */
	planMaterial?: (path: string, ctx: { sceneThreshold: number; stabilityThreshold: number }) => Promise<PlannedMaterial>;
	/** 测试注入：整体替换阶段二（抽帧/embed；sessionToken 透传）。 */
	embedFrames?: (path: string, planned: PlannedMaterial, sessionToken?: string) => Promise<FrameVec[]>;
	/** 测试注入：文件枚举。 */
	listFiles?: (dirs: string[]) => string[];
}

export interface IndexRunResult {
	dbPath: string;
	dirs: string[];
	materials: { total: number; indexed: number; skipped: number; rebuilt: number; failed: number };
	/** kind 分列计数（add-matrix-local-image-broll：进度与 --json summary 分列图片/视频）。 */
	kinds: { video: { total: number; indexed: number }; image: { total: number; indexed: number } };
	scenes: number;
	frames: number;
	/** 本轮抽帧计划总数（= 计量会话 planned_units 口径；豁免/零新帧时也如实报）。 */
	plannedFrames: number;
	/** 稳定性收敛账面（add-index-stability-sampling；只计本轮实际入库的视频素材，图片不参与）：
	 * framesSaved = 同场景集不带 stable 标记的旧策略计划帧数 − 带标记的实际计划帧数（降本透明）。 */
	stability: { stableScenes: number; unstableScenes: number; framesSaved: number };
	/** 计量会话账面：仅会话真开过时出现（豁免/零计划帧 = 无本键）。 */
	billing?: IndexBillingOutcome;
	elapsedMs: number;
}

/** 通用枚举（递归，深度上限 4；隐藏目录跳过）。 */
function listFilesMatching(dirs: string[], match: (name: string) => boolean): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 4) return;
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(dir, { withFileTypes: true }) as never;
		} catch {
			return;
		}
		for (const e of entries as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>) {
			if (e.name.startsWith(".")) continue;
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p, depth + 1);
			else if (e.isFile() && match(e.name)) out.push(resolve(p));
		}
	};
	for (const d of dirs) walk(resolve(d), 0);
	return out.sort();
}

/** 枚举文件夹内视频文件。 */
export function listVideoFiles(dirs: string[]): string[] {
	return listFilesMatching(dirs, (n) => VIDEO_EXT.test(n));
}

/** 枚举文件夹内视频+图片素材（add-matrix-local-image-broll：索引缺省枚举口，图片与视频一视同仁）。 */
export function listMaterialFiles(dirs: string[]): string[] {
	return listFilesMatching(dirs, (n) => VIDEO_EXT.test(n) || IMAGE_EXT.test(n));
}

/** 默认阶段一：ffprobe 几何 → 内容哈希身份 → 场景检测 → 抽帧计划（零 embed 请求，不落任何文件）。
 * 图片素材（add-matrix-local-image-broll D1）：单帧向量 ts=0 + 统一形态 scenes 一行 0..0，无场景轴。 */
async function planMaterialDefault(
	path: string,
	ctx: { sceneThreshold: number; stabilityThreshold: number },
	ff: FfmpegResolution,
	ffmpegPathOpt: string | undefined,
): Promise<PlannedMaterial> {
	const kind = materialKindForPath(path) ?? "video";
	const materialId = await brollLocalIdForFile(path);
	if (kind === "image") {
		let width = 0;
		let height = 0;
		try {
			const geo = probeGeometry(path, ffmpegPathOpt);
			width = geo.width;
			height = geo.height;
		} catch {
			/* 宽高探测 best-effort：失败只损失 orientation，不拦收录 */
		}
		return {
			materialId,
			kind,
			durationMs: 0,
			width,
			height,
			fps: 0,
			scenes: [{ st_ms: 0, ed_ms: 0 }],
			framePlan: [{ sceneIdx: 0, ts_ms: 0 }],
		};
	}
	const geo = probeGeometry(path, ffmpegPathOpt);
	if (!(geo.duration > 0)) throw new Error("探测不到有效时长（疑似损坏/非视频文件）");
	const scenes = await detectScenes(ff.ffmpeg, path, geo.duration, ctx.sceneThreshold, ctx.stabilityThreshold);
	const plan = planFrames(scenes); // stable 场景在此收敛为中点 1 帧
	return {
		materialId,
		kind,
		durationMs: Math.round(geo.duration * 1000),
		width: geo.width,
		height: geo.height,
		fps: geo.fps,
		scenes: scenes.map((s) => ({ st_ms: Math.round(s.st * 1000), ed_ms: Math.round(s.ed * 1000), stable: s.stable })),
		framePlan: plan.map((p) => ({ sceneIdx: p.sceneIdx, ts_ms: Math.round(p.ts * 1000) })),
	};
}

/** 默认阶段二：按计划抽帧（~/.gitruck/tmp）→ embed（批 ≤16，带 session_token）→ 删帧图（即传即弃）。
 * 图片素材：本体 512px 缩放为单帧 jpg 走**同一 embed 通道**即传即弃（原图不送，D1）。 */
async function embedFramesDefault(
	path: string,
	planned: PlannedMaterial,
	ff: FfmpegResolution,
	embed: IndexRunOptions["embed"],
	sessionToken: string | undefined,
): Promise<FrameVec[]> {
	// 抽帧到 ~/.gitruck/tmp/broll-index-<pid>（工作目录/素材目录零残留），embed 成功即删（即传即弃）
	const frameDir = join(tmpDir(), `broll-index-${process.pid}`);
	mkdirSync(frameDir, { recursive: true });
	const frames: FrameVec[] = [];
	if (planned.kind === "image") {
		try {
			const jpg = join(frameDir, `${basename(path, extname(path))}_0.jpg`);
			if (!(await extractFrameJpg(ff.ffmpeg, path, 0, jpg))) {
				throw new Error("图片 512px 缩放抽取失败（格式可能不受本机 ffmpeg 支持）");
			}
			const [vec] = await embed([{ image: readFileSync(jpg).toString("base64") }], sessionToken);
			return [{ sceneIdx: 0, ts_ms: 0, vec: vec! }];
		} finally {
			rmSync(frameDir, { recursive: true, force: true }); // 即传即弃兜底同视频口径
		}
	}
	try {
		let batch: { sceneIdx: number; ts_ms: number; jpg: string }[] = [];
		const flush = async (): Promise<void> => {
			if (!batch.length) return;
			const inputs: EmbedInput[] = batch.map((b) => ({ image: readFileSync(b.jpg).toString("base64") }));
			const vecs = await embed(inputs, sessionToken); // 失败即 EmbedError/EmbedRejectedError 上抛（硬失败不降级）
			batch.forEach((b, i) => frames.push({ sceneIdx: b.sceneIdx, ts_ms: b.ts_ms, vec: vecs[i]! }));
			for (const b of batch) {
				try {
					unlinkSync(b.jpg);
				} catch {
					/* 删失败由 finally 的整目录清理兜底 */
				}
			}
			batch = [];
		};
		for (const { sceneIdx, ts_ms } of planned.framePlan) {
			const jpg = join(frameDir, `${basename(path, extname(path))}_${ts_ms}.jpg`);
			if (!(await extractFrameJpg(ff.ffmpeg, path, ts_ms / 1000, jpg))) continue; // 个别坏帧跳过
			batch.push({ sceneIdx, ts_ms, jpg });
			if (batch.length >= EMBED_BATCH_MAX) await flush();
		}
		await flush();
	} finally {
		rmSync(frameDir, { recursive: true, force: true }); // 即传即弃兜底：无论成败不留抽帧图
	}
	return frames;
}

/** 端点级失败判据：unreachable（string code）或业务拒绝（rejected 标记）——两者都该中止整轮。
 * 按属性判而非 instanceof：测试多 bundle 下类身份不唯一。 */
function isEndpointFatal(e: unknown): boolean {
	const err = e as { code?: unknown; rejected?: unknown } | null;
	return err?.code === EMBED_UNREACHABLE_CODE || err?.rejected === true;
}

/**
 * 索引编排（gtrk matrix index 的纯逻辑面）：指纹增量 + 素材粒度断点续传 + --rebuild + 计量会话。
 * 两阶段：①全量场景检测/抽帧计划（零 embed）→ session open（planned_units=计划帧总数）→
 * ②逐素材抽帧+embed（带 token）+ 事务落库。embed 端点级失败（unreachable/业务拒绝）原样上抛
 * 中止整轮（已完成素材已各自落库，重跑零重算）；其余单素材错误局部化（failed 计数 + 告警行）。
 * 会话**完成/失败均 close**（finally；失败也结算已用量），close 自身失败标 reconcilePending。
 */
export async function indexLocalMaterials(opts: IndexRunOptions): Promise<IndexRunResult> {
	const t0 = Date.now();
	const dbPath = opts.dbPath ?? localIndexDbPath();
	const sceneThreshold = opts.sceneThreshold ?? SCENE_THRESHOLD_DEFAULT;
	const stabilityThreshold = opts.stabilityThreshold ?? STABILITY_THRESHOLD_DEFAULT;
	// 缺省枚举口 = 视频 + 图片（--no-image-broll 下索引仍收录图片：索引是缓存，排除发生在检索/铺轨侧）
	const files = (opts.listFiles ?? listMaterialFiles)(opts.dirs);
	const db = await openLocalIndexDb(dbPath);
	const stats = { total: files.length, indexed: 0, skipped: 0, rebuilt: 0, failed: 0 };
	const kinds = { video: { total: 0, indexed: 0 }, image: { total: 0, indexed: 0 } };
	const stability = { stableScenes: 0, unstableScenes: 0, framesSaved: 0 };
	let sceneCount = 0;
	let frameCount = 0;
	// ffmpeg 只在走默认处理链时才是硬依赖（测试注入 planMaterial+embedFrames 免装）
	const ff = opts.planMaterial && opts.embedFrames ? null : requireFfmpeg(opts.ffmpegPath);
	const planOne =
		opts.planMaterial ??
		((p: string, ctx: { sceneThreshold: number; stabilityThreshold: number }) => planMaterialDefault(p, ctx, ff!, opts.ffmpegPath));
	const embedOne =
		opts.embedFrames ??
		((p: string, planned: PlannedMaterial, token?: string) => embedFramesDefault(p, planned, ff!, opts.embed, token));

	interface Pending {
		path: string;
		name: string;
		size: number;
		mtimeMs: number;
		prev: MaterialRow | undefined;
		planned: PlannedMaterial;
	}
	let opened: { sessionToken: string; preDeductedCredits: number } | undefined;
	let billing: IndexBillingOutcome | undefined;
	let plannedFrames = 0;
	try {
		// ── 阶段一：指纹增量筛选 + 场景检测/抽帧计划（零 embed 请求）──
		const pending: Pending[] = [];
		for (const path of files) {
			const name = basename(path);
			kinds[materialKindForPath(path) ?? "video"].total++;
			let st: { size: number; mtimeMs: number };
			try {
				st = statSync(path);
			} catch {
				stats.failed++;
				opts.onProgress?.(`[${name}] 读不到文件（跳过）`);
				continue;
			}
			const size = st.size;
			const mtimeMs = Math.round(st.mtimeMs);
			const prev = db.get<MaterialRow>("SELECT * FROM materials WHERE path = ?", [path]);
			if (prev && !opts.rebuild && prev.size === size && prev.mtime_ms === mtimeMs) {
				stats.skipped++;
				opts.onProgress?.(`[${name}] 指纹未变，跳过`);
				continue;
			}
			try {
				pending.push({ path, name, size, mtimeMs, prev, planned: await planOne(path, { sceneThreshold, stabilityThreshold }) });
			} catch (e) {
				stats.failed++;
				opts.onProgress?.(`[${name}] 探测/场景检测失败：${e instanceof Error ? e.message : String(e)}（跳过）`);
			}
		}
		plannedFrames = pending.reduce((n, p) => n + p.planned.framePlan.length, 0);
		if (pending.length) {
			opts.onProgress?.(`抽帧计划就绪：${pending.length} 个素材待索引 · 计划 ${plannedFrames} 帧`);
		}

		// ── 计量会话 open（planned_units = 抽帧计划总数；无钩子/零计划帧不开会话）──
		if (opts.session && plannedFrames > 0) {
			opened = await opts.session.open(plannedFrames); // 积分不足即在此失败（CloudError 上抛）
			billing = { plannedUnits: plannedFrames, preDeductedCredits: opened.preDeductedCredits };
		}

		// ── 阶段二：抽帧 + embed（批请求带 session_token）+ 素材粒度事务落库 ──
		for (const p of pending) {
			let frames: FrameVec[];
			try {
				frames = await embedOne(p.path, p.planned, opened?.sessionToken);
			} catch (e) {
				// 端点级失败：中止整轮（spec「整体失败」；已完成素材已各自落库，finally 仍会 close 结算）
				if (isEndpointFatal(e)) throw e;
				stats.failed++;
				opts.onProgress?.(`[${p.name}] 处理失败：${e instanceof Error ? e.message : String(e)}（跳过）`);
				continue;
			}
			const kind = p.planned.kind ?? materialKindForPath(p.path) ?? "video";
			// 素材粒度事务：旧行级联删 + 新行整批入，一把落库（中断不留半素材 = 断点续传）
			withTransaction(db, () => {
				if (p.prev) {
					deleteMaterialRows(db, p.prev.id);
					// 理解缓存级联（D1）：仅指纹真变时按材料清 describes；--rebuild（指纹未变）不清
					if (p.prev.size !== p.size || p.prev.mtime_ms !== p.mtimeMs) {
						clearDescribesForMaterial(db, p.prev.material_id);
					}
				}
				db.run(
					"INSERT INTO materials(material_id, path, kind, size, mtime_ms, duration_ms, width, height, fps, indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
					[
						p.planned.materialId,
						p.path,
						kind,
						p.size,
						p.mtimeMs,
						p.planned.durationMs,
						kind === "image" ? (p.planned.width > 0 ? p.planned.width : null) : p.planned.width,
						kind === "image" ? (p.planned.height > 0 ? p.planned.height : null) : p.planned.height,
						kind === "image" ? null : p.planned.fps,
						new Date().toISOString(),
					],
				);
				const matRowId = Number(db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id);
				const sceneIds: number[] = [];
				for (const s of p.planned.scenes) {
					// stable：video 按判定写 1/0；无标记（旧注入面/图片行）写 NULL——消费侧 NULL 恒按 unstable
					db.run("INSERT INTO scenes(material_id, st_ms, ed_ms, stable) VALUES (?,?,?,?)", [
						matRowId,
						s.st_ms,
						s.ed_ms,
						s.stable === undefined ? null : s.stable ? 1 : 0,
					]);
					sceneIds.push(Number(db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id));
				}
				for (const f of frames) {
					const sceneId = sceneIds[f.sceneIdx];
					if (sceneId === undefined) continue;
					db.run("INSERT INTO frames(scene_id, material_id, ts_ms, vec) VALUES (?,?,?,?)", [sceneId, matRowId, f.ts_ms, encodeVec(f.vec)]);
				}
			});
			if (p.prev) stats.rebuilt++;
			stats.indexed++;
			kinds[kind].indexed++;
			sceneCount += p.planned.scenes.length;
			frameCount += frames.length;
			// 稳定性收敛账面（图片不参与——本就单帧无场景轴）：省帧数 = 同场景集去掉 stable 标记
			// 重算旧策略计划 − 带标记的实际计划（同在 ms 域重算，与 float→ms 取整漂移解耦）
			let stableNote = "";
			if (kind === "video") {
				const secs = p.planned.scenes.map((s) => ({ st: s.st_ms / 1000, ed: s.ed_ms / 1000, stable: s.stable }));
				for (const s of secs) (s.stable === true ? stability.stableScenes++ : stability.unstableScenes++);
				const saved = planFrames(secs.map(({ st, ed }) => ({ st, ed }))).length - planFrames(secs).length;
				stability.framesSaved += saved;
				if (saved > 0) stableNote = ` · stable 收敛省 ${saved} 帧`;
			}
			opts.onProgress?.(
				kind === "image"
					? `[${p.name}] 图片 · 单帧向量${p.prev ? "（指纹变化，已级联重建）" : ""}`
					: `[${p.name}] 时长 ${(p.planned.durationMs / 1000).toFixed(1)}s · 场景 ${p.planned.scenes.length} · 帧 ${frames.length}${stableNote}${p.prev ? "（指纹变化，已级联重建）" : ""}`,
			);
		}
	} finally {
		db.close();
		// 完成/失败均 close：失败也要结算已用量（infra 计费细案第 6 条）
		if (opened && opts.session) {
			try {
				const closed = await opts.session.close(opened.sessionToken);
				if (billing) {
					billing.usedUnits = closed.usedUnits;
					billing.settledCredits = closed.settledCredits;
					billing.refundedCredits = closed.refundedCredits;
				}
				opts.onProgress?.(
					`计量会话已结算：实际用量 ${closed.usedUnits} 帧 → 实结 ${closed.settledCredits} 积分 · 退还 ${closed.refundedCredits} 积分（预扣 ${opened.preDeductedCredits}）`,
				);
			} catch (e) {
				if (billing) billing.reconcilePending = true;
				opts.onProgress?.(
					`计量会话结算调用失败（${e instanceof Error ? e.message : String(e)}）——服务端 15 分钟内自动对账兜底结算，已用量不会丢`,
				);
			}
		}
	}
	return {
		dbPath,
		dirs: opts.dirs.map((d) => resolve(d)),
		materials: stats,
		kinds,
		scenes: sceneCount,
		frames: frameCount,
		plannedFrames,
		stability,
		...(billing ? { billing } : {}),
		elapsedMs: Date.now() - t0,
	};
}
