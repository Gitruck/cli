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
import { cpus } from "node:os";
import {
	buildScenePassArgs, buildGpuProbeArgs, gpuLaneEligible, nextLane, explainIneligible,
	GPU_FAIL_STREAK_LIMIT, PROXY_WIDTH_DEFAULT, PROXY_SCALER_DEFAULT, summarizeDowngrades,
	type DecodeLane,
} from "./index-decode";

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
/** 场景检测「产出够不够」的下限比例（实得帧数 / 时长×帧率）。
 * 低于此值判本趟无效——不是为了严谨好看：解码中途夭折时 ffmpeg 可能已退 0 且吐了一部分帧，
 * 而**部分帧序列在下游与「这片真没什么切点」不可区分**，会被当成权威结论落库。
 * 取 0.5 而非 0.95：VFR 素材、容器帧率不准、丢帧容器都会让实得数合法地低于名义值，
 * 宁可放过一半的病例，也不能把正常素材误杀。 */
export const SCENE_FRAME_COUNT_MIN_RATIO = 0.5;

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
  stable INTEGER,                       -- 1=stable（固定机位，中点单帧）；NULL/0=unstable（旧行/图片行按 unstable 语义）
  -- 运动量分级信号（add-material-motion-signal）：去重后帧间分分位 + 样本数 + 倍帧注记。
  -- NULL = 该场景无信号（旧行未重建 / 样本不足），消费方按「不可判」兜底，MUST NOT 当 0 用。
  motion_p50 REAL,
  motion_p90 REAL,
  motion_samples INTEGER,
  effective_fps REAL,
  doubled INTEGER                       -- 1=倍帧（低帧率内容装进高帧率容器）；NULL/0=未判定/否
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
CREATE TABLE IF NOT EXISTS cuts (
  material_id INTEGER NOT NULL,         -- → materials.id（级联删由 deleteMaterialRows 显式做）
  t_ms INTEGER NOT NULL,                -- 切点全集：含被 buildScenes 0.5s 合并吞并的微切点（fix-broll-flash-frames D4）
  -- 来源（add-material-motion-signal）：'detected'=检测所得（缺省，旧行 NULL 同义）；
  -- 'qc_confirmed'=成片像素上确认后回流（治 θ 临界漏网）。分来源存是为了保住检测口径的可复算性。
  origin TEXT,
  PRIMARY KEY (material_id, t_ms)
);
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
		// 运动量列幂等迁移（add-material-motion-signal）：旧行 NULL = 无信号（不可判），
		// 消费方兜底；--rebuild 全量补齐。与 stable/cuts_indexed 同款迁移先例。
		const sceneCols2 = db.all<{ name: string }>("PRAGMA table_info(scenes)").map((c) => c.name);
		for (const [col, type] of [
			["motion_p50", "REAL"],
			["motion_p90", "REAL"],
			["motion_samples", "INTEGER"],
			["effective_fps", "REAL"],
			["doubled", "INTEGER"],
		] as const) {
			if (!sceneCols2.includes(col)) db.exec(`ALTER TABLE scenes ADD COLUMN ${col} ${type}`);
		}
		// cuts.origin 幂等迁移：旧行 NULL 与 'detected' 同义（检测所得）
		const cutCols = db.all<{ name: string }>("PRAGMA table_info(cuts)").map((c) => c.name);
		if (!cutCols.includes("origin")) db.exec("ALTER TABLE cuts ADD COLUMN origin TEXT");
		// 镜头卡片列幂等迁移（add-shot-cards-and-alignment-qc 1.1）：subject/action/shot_size 客观层
		// 永续；highlight 与 rubric_hash 成对（换 rubric 只失效 highlight，不清客观层）。
		const descCols = db.all<{ name: string }>("PRAGMA table_info(describes)").map((c) => c.name);
		for (const [col, type] of [
			["subject", "TEXT"],
			["action", "TEXT"],
			["shot_size", "TEXT"],
			["highlight", "REAL"],
			["rubric_hash", "TEXT"],
		] as const) {
			if (!descCols.includes(col)) db.exec(`ALTER TABLE describes ADD COLUMN ${col} ${type}`);
		}
		// materials.cuts_indexed 幂等迁移（fix-broll-flash-frames D4）：NULL=旧行无切点全集数据
		// （检索侧不透出 cuts、消费方按无已知切点兜底）；1=本素材已落切点全集（空集=真无切点）。
		if (!cols.some((c) => c.name === "cuts_indexed")) {
			db.exec("ALTER TABLE materials ADD COLUMN cuts_indexed INTEGER");
		}
		// materials.decode_lane 幂等迁移（speedup-matrix-index-proxy-decode）：NULL=旧行（当时只有全清一条路）。
		// 溯源用，检索侧不读——增量索引下同库素材可能走了不同车道，其 motion 分位彼此不完全可比；
		// 这一列只保证该差异**可见**，MUST NOT 因换车道强制全库重建（那等于「换机器 = 全库重扫」）。
		const cols2 = db.all<{ name: string }>("PRAGMA table_info(materials)").map((c) => c.name);
		if (!cols2.includes("decode_lane")) db.exec("ALTER TABLE materials ADD COLUMN decode_lane TEXT");
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
	/** 建此行时实际跑成的解码车道；NULL=旧行（当时只有全清一条路）。溯源用，检索侧不读。 */
	decode_lane?: string | null;
}

/** 级联删一个素材的全部行（frames → scenes → cuts → materials；显式删，不依赖外键 pragma）。 */
export function deleteMaterialRows(db: SqlDb, materialRowId: number): void {
	db.run("DELETE FROM frames WHERE material_id = ?", [materialRowId]);
	db.run("DELETE FROM scenes WHERE material_id = ?", [materialRowId]);
	db.run("DELETE FROM cuts WHERE material_id = ?", [materialRowId]);
	db.run("DELETE FROM materials WHERE id = ?", [materialRowId]);
}

/** 确认切点回流（add-material-motion-signal D3 · local-material-index「确认切点回流」）：把成片
 * 像素上确认、映射回源时码的切点补录进索引，标 `qc_confirmed` 以区别于检测所得。
 *
 * 为何需要：检测存在**阈值临界漏网**——打样实测源 618.483 处一刀真实硬切（抽帧确认为两个不同
 * 场景）仅得 0.290296 分，差 0.01 未过默认 θ=0.3。索引对自身判据是忠实的（全片重扫复现全部
 * 切点），故这类缺口 MUST NOT 靠调低 θ 全局解决（会引入误检、且 θ 是用户可调参数），
 * 而应由「成片像素上看得见的一方」补录。
 *
 * 返回实际新增条数（已存在的时码不重复计）。调用方须确保这是**显式动作**——常规扫描不写库。 */
export function recordConfirmedCuts(db: SqlDb, materialId: string, tsMs: number[]): number {
	const row = db.get<{ id: number }>("SELECT id FROM materials WHERE material_id = ?", [materialId]);
	if (!row) return 0;
	let added = 0;
	withTransaction(db, () => {
		for (const t of tsMs) {
			const ms = Math.round(t);
			const exists = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cuts WHERE material_id = ? AND t_ms = ?", [row.id, ms]);
			if (exists && exists.n > 0) continue;
			db.run("INSERT INTO cuts(material_id, t_ms, origin) VALUES (?,?,'qc_confirmed')", [row.id, ms]);
			added++;
		}
	});
	return added;
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

/** 逐帧 score → 切点全集：`score > θ` 单帧判定（与旧 `select gt(scene,θ)` 选帧集合定义相同）。
 *
 * 「切点全集」相对场景表的增量在于**不做 <0.5s 合并**（buildScenes 会把紧邻切点并入前段）——
 * 被并掉的微切点正是快切蒙太奇的段内隐藏切点，铺轨窗口跨过它即闪帧（fix-broll-flash-frames D4）。
 *
 * ★ 帧率归一（滑窗和）判定曾在本 change 内实现，后按 2026-08-19 打样归因证据**撤出**：
 * 黄石 60fps 素材的 52 处真段内跳变里 49 处落在**已检出**的场景边界上（窗口越段，D1），
 * 3 处符合微切点特征（D4），无一处可归因于「高帧率软切漏检」；定向复扫（源 1185-1205s 等 7 段）
 * 新旧判定切点集合完全一致。无证据的检测阈值变更只会引入误检风险，故维持单帧判定。 */
export function detectCutsFromScores(
	frames: { ts: number; score: number }[],
	threshold: number = SCENE_THRESHOLD_DEFAULT,
): number[] {
	return frames.filter((f) => f.score > threshold).map((f) => f.ts);
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

/** 跑 ffmpeg 抓全量 stderr **并回退出码**（runFfmpeg 只留尾 4000 字会截断，故独立实现）。
 * metadata=print 逐帧两行 ⇒ stderr 体量 O(帧数)（~170B/帧，1h@30fps ≈ 18MB 字符串）——CLI 单素材
 * 串行处理下可接受；若未来撑不住再换流式逐行消费。
 *
 * ⚠️ 退出码 MUST 上抛给调用方判定。本函数曾经吞掉退出码（注释写「调用方解析不出切点自然为空」），
 * 那条推理是错的：空切点在下游**与「这片真没有切点」完全同形**——buildScenes([]) 得单场景 →
 * 稳定性注记拿不到帧判 stable → planFrames 收敛成 1 帧 → 整片被当作有效结论落库并打成功进度行，
 * 而 size:mtime 指纹会把这条坏行**粘住**，重跑直接 skip、永不自愈。 */
function runFfmpegCaptureStderr(bin: string, args: string[]): Promise<{ exitCode: number | null; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const p = spawn(bin, args, { env: process.env });
		let err = "";
		p.stderr.on("data", (b: Buffer) => {
			err += b.toString("utf8");
		});
		p.on("error", (e) => reject(e));
		p.on("close", (code) => resolvePromise({ exitCode: code, stderr: err }));
	});
}

/**
 * CUDA 运行时探针：跑完整条 hwupload→scale_cuda→hwdownload 链形，成功才认为本机可硬解。
 *
 * 为什么不只查 `-hwaccels` 里有没有 cuda：构建里编了 ≠ 这台机器此刻能用。
 * 无卡、驱动过旧、设备号错、显存被占满——全都只在真跑时暴露，而 `-hwaccels` 一律说「有」。
 * 实测成功 ~314ms、失败 ~177ms，一轮只跑一次，成本可忽略。
 *
 * 结果**只在进程内缓存、绝不落盘**：用户可能中途插拔外接卡或换驱动，落盘缓存会把
 * 一次偶然的失败钉死成永久结论。
 */
export async function probeCudaRuntime(ffmpeg: string, timeoutMs = 8000): Promise<boolean> {
	try {
		const p = runFfmpegCaptureStderr(ffmpeg, buildGpuProbeArgs());
		const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
		const res = await Promise.race([p, timeout]);
		return res !== null && res.exitCode === 0;
	} catch {
		return false;
	}
}

/** 场景区间 + 稳定性注记（add-index-stability-sampling）。 */
export interface SceneSpan {
	st: number;
	ed: number;
	/** 场景内最大帧间 scene score（不含场景起点切帧本身——它量的是切入该场景的跳变；无内点=0）。 */
	maxScore: number;
	/** maxScore < stabilityThreshold ⇒ 固定机位类稳定场景（抽帧收敛为中点 1 帧）。 */
	stable: boolean;
	/** 运动量分级信号（add-material-motion-signal）：**去重后**帧间分的分位。
	 * 为何不用 maxScore 当运动量：含真实切点的平稳场景其 max 反而更高（打样实测干净窗口
	 * max=0.5262 > 高运动窗口 0.2903）——max 量的是「有没有切点」，不是「抖不抖」。
	 * 为何必须去重：倍帧素材近半数是复制帧，不去重会把中位数腰斩（同一快摇窗口 0.0068 → 0.2747）。 */
	motion: SceneMotion;
}

/** 场景运动量与倍帧注记（add-material-motion-signal）。 */
export interface SceneMotion {
	/** 去重后帧间分中位数；样本不足时为 null（不可判，MUST NOT 当 0 消费）。 */
	p50: number | null;
	/** 去重后帧间分 p90；样本不足时为 null。 */
	p90: number | null;
	/** 参与统计的去重后帧数——长静止镜头去重后可能只剩个位数，此时分位不可靠。 */
	samples: number;
	/** 推定有效帧率（倍帧素材低于容器帧率）；判不出时为 null。 */
	effectiveFps: number | null;
	/** 该场景是否判为倍帧（低帧率内容装进高帧率容器）。 */
	doubled: boolean;
}

/** 场景区间 → 稳定性注记（双指针单趟；scenes 与 frameScores 均按时间升序）。
 * 每场景取 (st, ed) **开区间内**帧的最大 score：ts==st 是切入本场景的切帧（跳变分不算场内运动）、
 * ts==ed 是切入下一场景的切帧；<0.5s 并段丢弃的切点留在段内 ⇒ 其高分自然把该段判 unstable（正确语义）。 */
export function annotateSceneStability(
	scenes: { st: number; ed: number }[],
	frameScores: { ts: number; score: number }[],
	stabilityThreshold: number = STABILITY_THRESHOLD_DEFAULT,
	containerFps?: number,
): SceneSpan[] {
	const buckets: number[][] = scenes.map(() => []);
	const out: SceneSpan[] = scenes.map((s) => ({
		st: s.st,
		ed: s.ed,
		maxScore: 0,
		stable: true,
		motion: { p50: null, p90: null, samples: 0, effectiveFps: null, doubled: false },
	}));
	let si = 0;
	for (const f of frameScores) {
		while (si < out.length && f.ts >= out[si]!.ed) si++;
		if (si >= out.length) break;
		const s = out[si]!;
		if (f.ts > s.st) {
			if (f.score > s.maxScore) s.maxScore = f.score;
			buckets[si]!.push(f.score);
		}
	}
	for (let i = 0; i < out.length; i++) {
		out[i]!.stable = out[i]!.maxScore < stabilityThreshold;
		out[i]!.motion = computeSceneMotion(buckets[i]!, containerFps);
	}
	return out;
}

/** 近零帧判据（复制帧）：低于此分视为与前帧无差异。 */
const DUP_FRAME_EPS = 0.004;
/** 倍帧判定：近零帧占比下限（30fps→60fps 理论 50%，留裕度）。 */
const DUP_RATIO_MIN = 0.35;
/** 倍帧判定：近零帧最长连续长度上限——倍帧在运动段是**单帧交替**（实测连零 ≤2），
 * 而静止镜头是长串连零（实测 15–118 帧）。「近零帧占比高」本身判不了倍帧，多数只是固定机位。 */
const DUP_MAX_RUN = 2;
/** 运动量分位可信所需的最小去重样本数（长静止镜头去重后可能只剩个位数）。 */
const MOTION_MIN_SAMPLES = 12;

/**
 * 场景内逐帧分 → 运动量与倍帧注记（add-material-motion-signal D1/D2，纯函数供单测直调）。
 *
 * 倍帧判据取**近零帧的连续长度**而非占比：二者都产生大量近零帧，区别在倍帧运动段呈单帧交替
 * （连零 ≤2），静止镜头呈长串连零。且判定仅在区段确有运动时作出——静止段无从判也不需要判。
 */
export function computeSceneMotion(scores: number[], containerFps?: number): SceneMotion {
	if (!scores.length) return { p50: null, p90: null, samples: 0, effectiveFps: null, doubled: false };
	let zeros = 0;
	let run = 0;
	let maxRun = 0;
	const kept: number[] = [];
	for (const s of scores) {
		if (s < DUP_FRAME_EPS) {
			zeros++;
			run++;
			if (run > maxRun) maxRun = run;
		} else {
			run = 0;
			kept.push(s);
		}
	}
	const ratio = zeros / scores.length;
	const moving = kept.length >= MOTION_MIN_SAMPLES;
	const doubled = moving && ratio >= DUP_RATIO_MIN && maxRun <= DUP_MAX_RUN;
	if (!moving) {
		// 去重后样本不足：静止/极短场景，分位不可信 —— 如实报 null，MUST NOT 拿它当「平稳」的证据
		return { p50: null, p90: null, samples: kept.length, effectiveFps: null, doubled: false };
	}
	const v = [...kept].sort((a, b) => a - b);
	const at = (q: number): number => v[Math.min(v.length - 1, Math.floor(v.length * q))]!;
	const effectiveFps =
		doubled && typeof containerFps === "number" && Number.isFinite(containerFps) && containerFps > 0
			? Math.round(containerFps * (1 - ratio) * 10) / 10
			: null;
	return { p50: at(0.5), p90: at(0.9), samples: kept.length, effectiveFps, doubled };
}

/** 场景检测三产物（fix-broll-flash-frames）：场景区间 + 稳定性注记 + **切点全集**（秒，升序，
 * 含被 buildScenes 0.5s 合并吞并、未成为场景边界的微切点——快切蒙太奇的段内隐藏切点即在此）。 */
export interface SceneDetection {
	scenes: SceneSpan[];
	cuts: number[];
	/** 实际跑成的车道（降级后是降到的那一档）。落库供溯源：
	 * 不同车道的 motion 分位彼此不完全可比，出问题时要能查出这条素材当时走的哪条路。 */
	lane?: DecodeLane;
}

/** 场景检测这一趟到底有没有产出——不合格就抛，MUST NOT 让空/残缺的 score 序列流进下游。
 * 判据取三条的并集（任一不过即失败）：
 *   ① 进程非零退出；② 零帧；③ 实得帧数 < 时长×帧率×{@link SCENE_FRAME_COUNT_MIN_RATIO}。
 * 只看 ① 不够——硬解滤镜链断裂等情形实测会出现「退 0 但零帧」；只看 ①② 也不够——
 * 解码中途夭折会留下一段合法但残缺的序列。 */
export function assertScenePassProductive(x: {
	exitCode: number | null;
	stderr: string;
	frameCount: number;
	durationSec: number;
	fps?: number;
}): void {
	// stderr 尾部才是根因所在（前面全是逐帧 metadata 刷屏），且要给可读长度不给天书全文
	const tail = x.stderr.split(/\r?\n/).filter((l) => l.trim() && !l.includes("lavfi.scene_score") && !l.includes("pts_time:"))
		.slice(-3).join(" | ").slice(0, 400);
	if (x.exitCode !== 0) {
		// Windows 上退出码回来是无符号 32 位（-40 会显示成 4294967256），归一成有符号才有可读性
		const code = x.exitCode === null ? "null" : String(x.exitCode > 0x7fffffff ? x.exitCode - 0x100000000 : x.exitCode);
		throw new Error(`场景检测 ffmpeg 退出码 ${code}${tail ? `：${tail}` : ""}`);
	}
	if (x.frameCount === 0) {
		throw new Error(`场景检测零帧产出（退出码 0 但一帧 scene score 都没解析到）${tail ? `：${tail}` : ""}`);
	}
	if (x.fps && x.fps > 0 && x.durationSec > 0) {
		const expected = x.durationSec * x.fps;
		const floor = expected * SCENE_FRAME_COUNT_MIN_RATIO;
		if (x.frameCount < floor) {
			throw new Error(
				`场景检测产出残缺：实得 ${x.frameCount} 帧，按 ${x.durationSec.toFixed(1)}s × ${x.fps}fps 应约 ` +
				`${Math.round(expected)} 帧（下限 ${Math.round(floor)}）${tail ? `：${tail}` : ""}`,
			);
		}
	}
}

/** 场景边界检测：返回场景区间（秒）+ 稳定性注记 + 切点全集。源文件与其所在目录不产生任何新媒体文件。
 * 单趟解码双产物（spec MUST NOT 为判定新增解码 pass）：select 表达式放到 gte(scene,0)（全帧通过，
 * scene score 本就逐帧计算，解码量不变），metadata=print 打出每帧 score——切点由客户端按
 * score>θ 判定（与旧 select gt(scene,θ) 的选帧集合定义相同，真机对拍逐字节一致）。 */
export async function detectScenesAndCuts(
	ffmpeg: string,
	path: string,
	durationSec: number,
	threshold: number = SCENE_THRESHOLD_DEFAULT,
	stabilityThreshold: number = STABILITY_THRESHOLD_DEFAULT,
	containerFps?: number,
	laneOpts?: ScenePassLaneOpts,
): Promise<SceneDetection> {
	const { frames, lane } = await runScenePassWithFallback(ffmpeg, path, durationSec, containerFps, laneOpts);
	const cuts = detectCutsFromScores(frames, threshold);
	return {
		scenes: annotateSceneStability(buildScenes(cuts, durationSec), frames, stabilityThreshold, containerFps),
		cuts,
		lane,
	};
}

/** 单素材场景检测的车道选项。缺省（全不传）= `cpu_full`，与本 change 之前逐字节同行为。 */
export interface ScenePassLaneOpts {
	/** 起始车道。缺省 `cpu_full`（零回归）。 */
	lane?: DecodeLane;
	/** 车道失败时是否自动降级。用户**显式**指定车道时应传 false——
	 * 显式指定的意图就是验证这条路，静默换成别的路等于没验。 */
	fallback?: boolean;
	proxyWidth?: number;
	proxyScaler?: string;
	/** 降级发生时的回调（编排层据此聚合成一条轮末 INFO，而非逐素材刷屏）。 */
	onDowngrade?: (from: DecodeLane, to: DecodeLane, reason: string) => void;
}

/**
 * 按车道跑场景检测，失败自动降级到下一档。
 *
 * 为什么降级必须由我们自己做：实测 `-hwaccel cuda -hwaccel_output_format cuda` **不会自愈**——
 * 硬解不可用时 ffmpeg 确实把解码回落到软解，但滤镜链仍在索要 CUDA 帧，于是整条命令
 * 报 `Impossible to convert between the formats…` 死掉、零帧产出。指望 ffmpeg 内部兜底
 * 只会得到一个静默的空索引（正是 assertScenePassProductive 拦的那个形态）。
 */
export async function runScenePassWithFallback(
	ffmpeg: string,
	path: string,
	durationSec: number,
	containerFps?: number,
	opts?: ScenePassLaneOpts,
): Promise<{ frames: { ts: number; score: number }[]; lane: DecodeLane }> {
	const fallback = opts?.fallback !== false;
	let lane: DecodeLane = opts?.lane ?? "cpu_full";
	for (;;) {
		const { exitCode, stderr } = await runFfmpegCaptureStderr(
			ffmpeg,
			buildScenePassArgs({ src: path, lane, proxyWidth: opts?.proxyWidth, proxyScaler: opts?.proxyScaler }),
		);
		const frames = parseSceneScores(stderr);
		try {
			assertScenePassProductive({ exitCode, stderr, frameCount: frames.length, durationSec, fps: containerFps });
			return { frames, lane };
		} catch (e) {
			const to = fallback ? nextLane(lane) : null;
			// 无下一档（或用户钉死了车道）⇒ 原样上抛，让编排层记 failed。
			// MUST NOT 在这里把失败咽掉返回空 frames——那正是本 change 修掉的那个 bug 的形状。
			if (!to) throw e;
			opts?.onDowngrade?.(lane, to, e instanceof Error ? e.message : String(e));
			lane = to;
		}
	}
}

/** 兼容包装（旧签名，只要场景区间）：既有调用/对拍测试零改动。 */
export async function detectScenes(
	ffmpeg: string,
	path: string,
	durationSec: number,
	threshold: number = SCENE_THRESHOLD_DEFAULT,
	stabilityThreshold: number = STABILITY_THRESHOLD_DEFAULT,
): Promise<SceneSpan[]> {
	return (await detectScenesAndCuts(ffmpeg, path, durationSec, threshold, stabilityThreshold)).scenes;
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

/** 阶段一入参上下文。lane 相关字段缺省时行为与本 change 之前逐字节一致。 */
export interface PlanMaterialCtx {
	sceneThreshold: number;
	stabilityThreshold: number;
	/** 本素材应起跑的车道（编排层按静态门 + 探针结果给定）。缺省 cpu_full。 */
	lane?: DecodeLane;
	/** 失败是否自动降级。用户钉死车道时为 false。 */
	fallback?: boolean;
	proxyWidth?: number;
	proxyScaler?: string;
	onDowngrade?: (from: DecodeLane, to: DecodeLane, reason: string) => void;
}

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
	scenes: { st_ms: number; ed_ms: number; stable?: boolean; motion?: SceneMotion }[];
	/** 抽帧计划（sceneIdx 指向 scenes 下标）——计划总数即计量会话 planned_units；图片恒单帧 ts_ms=0。 */
	framePlan: { sceneIdx: number; ts_ms: number }[];
	/** 切点全集（毫秒，升序；fix-broll-flash-frames D4）：含被 0.5s 合并吞并的微切点。
	 * 缺省 undefined = 无数据（旧注入面零改动）→ 落库 cuts_indexed=NULL、检索不透出 cuts；
	 * `[]` = 真无切点（cuts_indexed=1）。图片素材恒缺省（无时间轴）。 */
	cutsMs?: number[];
	/** 实际跑成的解码车道（溯源用；注入面缺省 undefined）。 */
	decodeLane?: DecodeLane;
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
	planMaterial?: (path: string, ctx: PlanMaterialCtx) => Promise<PlannedMaterial>;
	/** 测试注入：整体替换阶段二（抽帧/embed；sessionToken 透传）。 */
	embedFrames?: (path: string, planned: PlannedMaterial, sessionToken?: string) => Promise<FrameVec[]>;
	/** 测试注入：文件枚举。 */
	listFiles?: (dirs: string[]) => string[];
	/** 解码路径（speedup-matrix-index-proxy-decode）：
	 * `auto` = 三层探测 + 自动降级；`gpu`/`cpu`/`full` = 用户钉死某档且**失败不降级**。
	 * 缺省 undefined = `full`（本 change 之前的逐字节同行为）。 */
	decodePath?: "auto" | "gpu" | "cpu" | "full";
	proxyWidth?: number;
	proxyScaler?: string;
	/** 测试注入：替换 CUDA 运行时探针（返回 true=本机可用）。无卡 CI 靠它跑通全部车道状态机。 */
	probeGpuLane?: () => Promise<boolean>;
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
	/** 解码车道账面（--json 恒带；默认路的降级静默但**永远可查**）。 */
	decode?: {
		requested: "auto" | "gpu" | "cpu" | "full";
		/** GPU 车道状态：off_flag=用户没开 / off_probe=探针未过 / on=用过 / tripped=熔断。 */
		gpu: "off_flag" | "off_probe" | "on" | "tripped";
		/** 各车道实际跑成的素材数。 */
		lanes: Record<string, number>;
		/** 降级次数（含静态门拦下的与执行期失败的）。 */
		degraded: number;
		probeMs?: number;
	};
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
	ctx: PlanMaterialCtx,
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
	// 素材静态门：编排层只负责判「整机能不能硬解」，「这条素材能不能」在这里判——
	// 复用上面这次 ffprobe 的 codec/pix_fmt ⇒ 零额外进程。
	let lane = ctx.lane ?? "cpu_full";
	if (lane === "gpu") {
		const gate = gpuLaneEligible({ codecName: geo.codecName, pixFmt: geo.pixFmt }, { cores: cpus().length });
		if (!gate.ok) {
			lane = "cpu_proxy";
			ctx.onDowngrade?.("gpu", "cpu_proxy", gate.reason);
		}
	}
	// 容器帧率透传给运动量注记（倍帧判定后据此推有效帧率）
	const det = await detectScenesAndCuts(ff.ffmpeg, path, geo.duration, ctx.sceneThreshold, ctx.stabilityThreshold, geo.fps, {
		lane,
		fallback: ctx.fallback,
		proxyWidth: ctx.proxyWidth,
		proxyScaler: ctx.proxyScaler,
		onDowngrade: ctx.onDowngrade,
	});
	const scenes = det.scenes;
	const plan = planFrames(scenes); // stable 场景在此收敛为中点 1 帧
	return {
		materialId,
		kind,
		durationMs: Math.round(geo.duration * 1000),
		width: geo.width,
		height: geo.height,
		fps: geo.fps,
		scenes: scenes.map((s) => ({
			st_ms: Math.round(s.st * 1000),
			ed_ms: Math.round(s.ed * 1000),
			stable: s.stable,
			motion: s.motion,
		})),
		framePlan: plan.map((p) => ({ sceneIdx: p.sceneIdx, ts_ms: Math.round(p.ts * 1000) })),
		cutsMs: det.cuts.map((t) => Math.round(t * 1000)),
		decodeLane: det.lane,
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
	// ── 解码车道状态（speedup-matrix-index-proxy-decode）────────────────────────
	// requested=auto 时才允许自动降级；用户钉死车道时失败必须响亮——显式指定的意图就是验证这条路，
	// 静默换成别的路等于没验。
	const requested = opts.decodePath ?? "full";
	const laneState = {
		baseLane: (requested === "gpu" ? "gpu" : requested === "cpu" ? "cpu_proxy" : requested === "auto" ? "gpu" : "cpu_full") as DecodeLane,
		fallback: requested === "auto",
		probed: null as boolean | null,
		probeMs: undefined as number | undefined,
		tripped: false,
		gpuFailStreak: 0,
		gpuStatus: (requested === "gpu" || requested === "auto" ? "off_probe" : "off_flag") as "off_flag" | "off_probe" | "on" | "tripped",
		lanes: {} as Record<string, number>,
		degradeLog: [] as { name: string; reason: string }[],
	};
	const probeGpu = opts.probeGpuLane ? () => opts.probeGpuLane!() : (bin: string) => probeCudaRuntime(bin);

	const planOne =
		opts.planMaterial ??
		((p: string, ctx: PlanMaterialCtx) => planMaterialDefault(p, ctx, ff!, opts.ffmpegPath));
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
				// 车道决策：整机门（探针，一轮一次惰性触发）→ 素材静态门（在 planMaterialDefault 内，
				// 复用它那次 ffprobe）→ 执行期降级。三层层层收窄，每层的成本都比下一层低。
				let lane: DecodeLane = laneState.baseLane;
				if (lane === "gpu") {
					if (laneState.tripped) lane = "cpu_proxy";
					else {
						if (laneState.probed === null) {
							const t0 = Date.now();
							laneState.probed = await probeGpu(ff!.ffmpeg);
							laneState.probeMs = Date.now() - t0;
							if (!laneState.probed) {
								laneState.gpuStatus = "off_probe";
								if (!laneState.fallback) {
									throw new Error("--decode-path gpu：本机未探到可用的 CUDA 解码设备（显式指定车道时不降级）");
								}
								opts.onProgress?.("GPU 硬解不可用（本机未探到可用 CUDA 解码设备），本轮走 CPU 解码——索引结果不受影响");
							}
						}
						if (!laneState.probed) lane = "cpu_proxy";
					}
				}
				const before = laneState.degradeLog.length;
				const planned = await planOne(path, {
					sceneThreshold, stabilityThreshold,
					lane, fallback: laneState.fallback,
					proxyWidth: opts.proxyWidth, proxyScaler: opts.proxyScaler,
					onDowngrade: (from, _to, reason) => {
						if (from === "gpu") laneState.gpuFailStreak++;
						laneState.degradeLog.push({ name, reason });
					},
				});
				// 熔断：静态门只看编码格式，拦不住「驱动挂了/卡被占满」这类整机态问题——
				// 那种情况下每个素材都要白试 ~3s，连挂两次就不再试。
				if (before === laneState.degradeLog.length) laneState.gpuFailStreak = 0;
				if (laneState.gpuFailStreak >= GPU_FAIL_STREAK_LIMIT && !laneState.tripped) {
					laneState.tripped = true;
					laneState.gpuStatus = "tripped";
					opts.onProgress?.(`GPU 硬解连续 ${GPU_FAIL_STREAK_LIMIT} 次失败，本轮余下素材直接走 CPU 解码`);
				}
				if (planned.decodeLane) {
					laneState.lanes[planned.decodeLane] = (laneState.lanes[planned.decodeLane] ?? 0) + 1;
					if (planned.decodeLane === "gpu") laneState.gpuStatus = laneState.tripped ? "tripped" : "on";
				}
				pending.push({ path, name, size, mtimeMs, prev, planned });
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
					"INSERT INTO materials(material_id, path, kind, size, mtime_ms, duration_ms, width, height, fps, indexed_at, cuts_indexed, decode_lane) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
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
						// cuts_indexed（fix-broll-flash-frames D4）：有切点全集数据=1（空集=真无切点）；
						// 旧注入面/图片缺省 undefined → NULL（检索侧不透出 cuts）
						p.planned.cutsMs !== undefined ? 1 : null,
						p.planned.decodeLane ?? null,
					],
				);
				const matRowId = Number(db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id);
				if (p.planned.cutsMs !== undefined) {
					for (const t of p.planned.cutsMs) {
						db.run("INSERT OR IGNORE INTO cuts(material_id, t_ms, origin) VALUES (?,?,'detected')", [matRowId, t]);
					}
				}
				const sceneIds: number[] = [];
				for (const s of p.planned.scenes) {
					// stable：video 按判定写 1/0；无标记（旧注入面/图片行）写 NULL——消费侧 NULL 恒按 unstable
					// motion：缺席或样本不足时各列写 NULL（「不可判」），消费侧 MUST NOT 当 0 用
					db.run(
						"INSERT INTO scenes(material_id, st_ms, ed_ms, stable, motion_p50, motion_p90, motion_samples, effective_fps, doubled) VALUES (?,?,?,?,?,?,?,?,?)",
						[
							matRowId,
							s.st_ms,
							s.ed_ms,
							s.stable === undefined ? null : s.stable ? 1 : 0,
							s.motion?.p50 ?? null,
							s.motion?.p90 ?? null,
							s.motion?.samples ?? null,
							s.motion?.effectiveFps ?? null,
							s.motion ? (s.motion.doubled ? 1 : 0) : null,
						],
					);
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
		// 降级轮末聚合成一条：逐素材打会把真正的问题淹在良性噪声里（良性降级打可读 INFO）。
		// ffmpeg 原始 stderr 不上抛——那是天书；根因已经翻成人话装进这一行。
		const summary = summarizeDowngrades(laneState.degradeLog);
		if (summary) opts.onProgress?.(summary);
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
		decode: {
			requested,
			gpu: laneState.gpuStatus,
			lanes: laneState.lanes,
			degraded: laneState.degradeLog.length,
			probeMs: laneState.probeMs,
		},
		stability,
		...(billing ? { billing } : {}),
		elapsedMs: Date.now() - t0,
	};
}
