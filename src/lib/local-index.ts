/**
 * 本地素材免切片索引（add-matrix-local-search · local-material-index spec）。
 *
 * 链路：ffmpeg 场景边界检测（select gte(scene,0)+metadata=print **+ blackdetect** 并联，
 * 单趟解码三产物——切点=score>θ
 * 客户端判定，与旧 select gt(scene,θ)+showinfo 链切点逐字节一致（真机对拍 35/35）；每帧 scene score
 * 顺手供场景稳定性判定，add-index-stability-sampling；黑段供渐变过黑检出
 * （fix-index-gradual-transition-blindness——逐帧打分对匀速渐变结构性失明，见 detectCutsFromScores
 * 头注）；**只记时间戳不产生任何切片文件**）
 * → 场景自适应抽帧（≤4s 场景中点 1 帧；>4s 每 2s 加密；**stable 场景收敛为中点 1 帧**；
 *   512px 最长边 jpg，抽到 ~/.gitruck/tmp）
 * → 自建 embed 端点向量化（批 ≤16，embed-client）→ SQLite 三表落库（帧图 embed 成功即删，即传即弃）。
 *
 * 存储（D1）：~/.gitruck/local-broll-index/index.db，materials/scenes/frames 三表
 * （+ cuts 切点全集 / black_spans 黑段两张正交信号表），
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
import { mkdirSync, existsSync, readdirSync, statSync, lstatSync, realpathSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { dirname, extname, join, resolve, basename, sep } from "node:path";
import { createBLAKE3 } from "hash-wasm";
import { log } from "./log";
import { homeFile, tmpDir } from "./paths";
import { requireFfmpeg, runFfmpeg, type FfmpegResolution } from "./ffmpeg";
import { probeGeometry } from "./media";
import { sec2ms } from "./frame-domain";
import { BROLL_LOCAL_MATERIAL_PREFIX } from "./matrix-lay";
import { EMBED_BATCH_MAX, EMBED_UNREACHABLE_CODE, type EmbedInput } from "./embed-client";
import { cpus } from "node:os";
import {
	buildScenePassArgs, buildGpuProbeArgs, gpuLaneEligible, nextLane, explainIneligible,
	GPU_FAIL_STREAK_LIMIT, PROXY_WIDTH_DEFAULT, PROXY_SCALER_DEFAULT, summarizeDowngrades,
	createBlackSpanParser,
	type DecodeLane,
} from "./index-decode";

// ── 参数基线（POC 标定值，design D4；θ 经 --scene-threshold 暴露）──────────
/** 切点判定阈值。
 *
 * ⚠️ **调低它来接住渐变转场（叠化过黑）这条路已被实测判死**
 * （fix-index-gradual-transition-blindness），后人 MUST NOT 重走：
 * 真机那处叠化的**整段峰值**只有 0.028180，要接住得把 θ 压到 0.028；
 * 而同素材 380–500s 共 7200 帧的分数直方图是 >0.3 有 32 个（真切点）、>0.1 有 50、
 * >0.05 有 105、>0.028 有 **122（+281%，多出来的全是假切点）**。
 * 且 0.0282 还只是这一条叠化的峰值——更慢的叠化只会更低，没有下界可言。
 * 渐变过黑走**独立信号** blackdetect（见 index-decode.ts `BLACK_TAP`），与本阈值正交。 */
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

// ── 长跑进度心跳（add-matrix-index-phase-progress）────────────────────────────

/** 心跳最小间隔（ms）。场景检测的 `metadata=print` 逐帧两行——1h@30fps ≈ 10.8 万次回调，
 * 不节流就是逐帧刷屏（还把「原地刷新」变成真实的 IO 负担）。
 * ⚠️ 节流责任在本模块，MUST NOT 推给命令层：命令层只知道「有一行要刷」，不知道它来自哪个热循环。 */
export const TICK_MIN_INTERVAL_MS = 500;

/** 心跳通道（原地刷新 + 收口换行 + 节流）。 */
export interface TickChannel {
	/** 刷一条心跳读数（不换行、不留痕）。距上次 <{@link TICK_MIN_INTERVAL_MS} 的调用直接丢弃。 */
	tick(line: string): void;
	/** 收口当前心跳行。**只在真有未收口心跳时**才触发 onTickEnd。 */
	end(): void;
	/** 重开一段心跳（换素材 / 车道降级重跑）：清节流窗口，让新一段第一条立刻可见。 */
	reset(): void;
}

/**
 * 造一个心跳通道。三条纪律，缺一就会出用户肉眼可见的怪状：
 *   ① **节流**：见 {@link TICK_MIN_INTERVAL_MS}；
 *   ② **end 只在有未收口心跳时才调**——没心跳还调 `log.tickEnd()` 就是凭空多一个空行，
 *      而索引一轮里绝大多数 onProgress 行前面根本没有心跳；
 *   ③ **reset 只清节流窗口不动 pending**：降级重跑时读数从 0 重来，但那半行心跳仍欠一个收口。
 *
 * `now` 可注入：节流是时间行为，闸不该靠 sleep 去撞真实时钟。
 */
export function createTickChannel(opts: {
	onTick?: (line: string) => void;
	onTickEnd?: () => void;
	minIntervalMs?: number;
	now?: () => number;
}): TickChannel {
	const minMs = opts.minIntervalMs ?? TICK_MIN_INTERVAL_MS;
	const now = opts.now ?? ((): number => Date.now());
	let lastMs = Number.NEGATIVE_INFINITY;
	let pending = false;
	return {
		tick(line: string): void {
			if (!opts.onTick) return;
			const t = now();
			if (t - lastMs < minMs) return;
			lastMs = t;
			pending = true;
			opts.onTick(line);
		},
		end(): void {
			if (!pending) return;
			pending = false;
			opts.onTickEnd?.();
		},
		reset(): void {
			lastMs = Number.NEGATIVE_INFINITY;
		},
	};
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
-- 源片自带黑场区间（fix-index-gradual-transition-blindness）：索引场景检测同趟解码的
-- blackdetect 产物，毫秒，按 st_ms 升序。
--
-- ★ **为什么不复用 cuts 表**（哪怕只是加一个 origin 值）——三条，缺一不可：
--   ① cuts 的 spec 明文锁死「切点判定口径本身 MUST NOT 变更」（维持逐帧 score>θ 单帧判定），
--      那条承诺的兑现方式就是「拿同样的 θ 重扫一遍，切点集合逐字节复现」。往里塞一类**不由 θ 判**
--      的行，这条可复算性当场破产，而且破得**无声**——重扫者只会发现集合对不上，查不出为什么；
--   ② 黑段是**正交信号**：切点是「画面换了」，黑段是「画面没了」。真机五处叠化过黑附近 ±4s 内
--      cuts 全部无切点（最近的差 2.85–3.95s）⇒ 两者连位置都不重合，不是同一件事的两种来源；
--   ③ cuts.origin 的 qc_confirmed 先例是「**同类**信号异来源」（成片像素上确认的切点仍是切点），
--      黑段不属同类，援引不成立。
-- 区间是**两点**而非一点：一次过黑有起止，塞进单点表会把「黑多长」这个铺轨要用的量丢掉。
CREATE TABLE IF NOT EXISTS black_spans (
  material_id INTEGER NOT NULL,         -- → materials.id（级联删由 deleteMaterialRows 显式做）
  st_ms INTEGER NOT NULL,
  ed_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_black_spans_material ON black_spans(material_id);
-- 编排期 QC 判定缓存（add-broll-arrange-atom P3.2）。
--
-- ★ 与 describes 分表，不是懒：describes 缓存的是**这一帧长什么样**（客观、与稿句无关），
-- 而这里缓存的是**这一帧配这句稿对不对得上**（主观、随稿句变）。同一帧配不同稿句判定不同，
-- 塞进同一张表就得让键带 claim，那会把「客观描述」的复用面白白切碎。
--
-- 缓存键第三维是 claim 哈希 ⇒ 改稿即失效、重跑幂等（同一份稿重跑一次判定都不烧）。
CREATE TABLE IF NOT EXISTS qc_verdicts (
  material_id TEXT NOT NULL,            -- broll- 家族材料 id
  ts_ms INTEGER NOT NULL,               -- 帧时刻
  claim_hash TEXT NOT NULL,             -- 稿句哈希（改稿即失效）
  verdict TEXT NOT NULL,                -- match | partial | mismatch
  reason TEXT,                          -- 判定理由（人读；mismatch 时指名差在哪）
  frame_desc TEXT,                      -- 该帧客观描述（降级态与对照表共用）
  created_at TEXT NOT NULL,
  PRIMARY KEY (material_id, ts_ms, claim_hash)
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
-- 看点层缓存（fix-highlight-rubric-wiring）：一帧在**某套评判准则下**的看点分。
--
-- ★ 与 describes 分表的理由与 qc_verdicts 同源，但更硬：describes 是「这一帧长什么样」
--   （客观，与准则无关，一帧一份、永续复用）；这里是「按这套准则这一帧值不值得看」
--   （主观，随准则变，一帧 × N 套准则 N 份）。
--
-- 塞回 describes 只有两条路，都错：
--   ① 让 rubric_hash 进 describes 的唯一键 ⇒ 每换一套准则就把 desc/tags/flags 全量复制一份，
--      「客观层唯一一份」的语义没了；
--   ② 保持单行 INSERT OR REPLACE ⇒ 两套准则来回切会持续互相刷掉，
--      而重看片是**按张计费**的动作——那是把钱烧在结构缺陷上。
--
-- 前瞻：将来服务端上「免看片的文本级重打分」轻通道，它只写本表、一行不碰 describes。
CREATE TABLE IF NOT EXISTS describe_highlights (
  material_id TEXT NOT NULL,            -- broll- 家族材料 id（同 describes）
  ts_ms INTEGER NOT NULL,               -- 帧时刻
  rubric_hash TEXT NOT NULL,            -- 分桶键；缺省准则恒为 'L0'（哨兵，非 NULL——见 highlight-rubric.ts）
  highlight REAL,                       -- 0-100 看点分；NULL = 服务端没给这一维（旧服务端）
  created_at TEXT NOT NULL,
  PRIMARY KEY (material_id, ts_ms, rubric_hash)
);
-- 查询向量持久缓存（fix-embed-ratelimit-backoff §4）：检索词 → 向量。
-- 一次成片会反复用同一批 query 打 embed（三条片实测 104 次请求里绝大多数是重复的），
-- 而进程内 Map 一退出就没了 ⇒ 每次重跑都从头烧一遍、还把限流窗口撑爆。
-- ⚠️ query 列存**原文**，MUST NOT 归一化大小写/空格——那本就是不同的 query，
--    合并等于替用户偷改语义，而检索结果会静默变。
CREATE TABLE IF NOT EXISTS query_vecs (
  query TEXT NOT NULL,                  -- 检索词原文（未归一化）
  space TEXT NOT NULL,                  -- 向量空间身份：模型+维度+端点（换任一维即换空间，见 embedSpaceId）
  dim INTEGER NOT NULL,                 -- 维度（读回时与 BLOB 长度互校）
  vec BLOB NOT NULL,                    -- float32 小端（复用 encodeVec/decodeVec，MUST NOT 另造编码）
  created_at TEXT NOT NULL,
  PRIMARY KEY (query, space)
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
		// 镜头卡片列幂等迁移（add-shot-cards-and-alignment-qc 1.1）：subject/action/shot_size 客观层永续。
		// ⚠️ [fix-highlight-rubric-wiring] `describes.highlight` / `describes.rubric_hash` 两列**已冻结**：
		//    看点层自本件起住在 describe_highlights（按 rubric 分桶）。这两列**停写但保留**——
		//    同一台机器上旧版与新版 gtrk 读写同一个索引库，DROP COLUMN 会让旧版的 SELECT 当场炸，
		//    而本地索引库是缓存，用户不会想到它跟 CLI 版本有耦合。留两列冗余，换回滚安全。
		//    仍在 ALTER 列表里，是因为旧版建的库仍需要它们存在才能被旧版读。
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
		// [fix-highlight-rubric-wiring] 看点层一次性数据迁移：本件之前写下的 highlight 一律是
		// **服务端 L0 缺省准则**打出来的（rubric 从来没人传过，那一列自建库以来零写入），
		// 故按缺省桶 'L0' 灌进新表 ⇒ 不传准则的路径照常命中旧分，零回归靠这一步兜住。
		// INSERT OR IGNORE = 幂等：已在新桶里的（含后续新写的）一行不动，重开库跑几次结果相同。
		db.exec(
			"INSERT OR IGNORE INTO describe_highlights(material_id, ts_ms, rubric_hash, highlight, created_at) " +
				"SELECT material_id, ts_ms, 'L0', highlight, created_at FROM describes WHERE highlight IS NOT NULL",
		);
		// materials.cuts_indexed 幂等迁移（fix-broll-flash-frames D4）：NULL=旧行无切点全集数据
		// （检索侧不透出 cuts、消费方按无已知切点兜底）；1=本素材已落切点全集（空集=真无切点）。
		if (!cols.some((c) => c.name === "cuts_indexed")) {
			db.exec("ALTER TABLE materials ADD COLUMN cuts_indexed INTEGER");
		}
		// materials.black_indexed 幂等迁移（fix-index-gradual-transition-blindness）：
		// NULL=旧行**没扫过**黑段（检索侧整键不透出 `black`，消费方按「不可判」兜底）；
		// 1=本素材已扫（空集=真无黑段）。与 cuts_indexed 同款先例——
		// 「扫过且无黑」与「没扫过」MUST 可分辨，那正是 fix-cut-scan-warning-semantics 踩过的坑。
		if (!cols.some((c) => c.name === "black_indexed")) {
			db.exec("ALTER TABLE materials ADD COLUMN black_indexed INTEGER");
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

/** 级联删一个素材的全部行（frames → scenes → cuts → black_spans → materials；显式删，不依赖外键 pragma）。 */
export function deleteMaterialRows(db: SqlDb, materialRowId: number): void {
	db.run("DELETE FROM frames WHERE material_id = ?", [materialRowId]);
	db.run("DELETE FROM scenes WHERE material_id = ?", [materialRowId]);
	db.run("DELETE FROM cuts WHERE material_id = ?", [materialRowId]);
	// 漏了这一行就是重建后黑段翻倍（同一素材两次扫出的区间各存一份）：
	// black_spans 无主键（一次过黑有起止两点，不适合拿 st_ms 当唯一键去 OR IGNORE），
	// 去重完全靠这条级联删 ⇒ 它 MUST 与上面三张表同批。
	db.run("DELETE FROM black_spans WHERE material_id = ?", [materialRowId]);
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
	// [fix-highlight-rubric-wiring] 看点层同批清 —— **漏了这一行就是本件最贵的 bug**：
	// 素材内容换了、客观描述作废重来，而各准则桶里的看点分还留在原 (material, ts) 上，
	// 于是新画面拿着旧画面的看点分参与排序，且现象只在排序次序上，肉眼不可见。
	db.run("DELETE FROM describe_highlights WHERE material_id = ?", [materialId]);
}

// ── 查询向量持久缓存（fix-embed-ratelimit-backoff §4）────────────────────────

/**
 * 向量空间身份串 —— 缓存键的第二维。
 *
 * 三个分量缺一不可，**任一维变了，缓存里的向量就不再可比**：
 *
 * 1. **模型标识**（`jina-clip-v2`）——换模就是换空间，旧向量与新向量点积无意义；
 * 2. **维度**（`EMBED_DIM`）——维度不同连算都算不了，且能兜住「模型名没变但截断维度变了」；
 * 3. **端点身份**（`resolveEmbedUrl()`）——自建镜像/测试端点/生产端点可能挂着不同权重，
 *    这一维是「同名不同物」的唯一防线。
 *
 * 拼进键而不是拿来做校验：换空间时**旧行原样留着**（下次换回来还能用），
 * 不 DELETE、不迁移。索引库本就是可随时重建的本机缓存，多留几行 4KB 不值得写迁移码。
 */
export function embedSpaceId(model: string, dim: number, endpointUrl: string): string {
	return `${model}#${dim}#${endpointUrl}`;
}

/** 读一条查询向量缓存；未命中或 BLOB 长度与 dim 不符回 undefined。 */
export function getCachedQueryVec(db: SqlDb, query: string, space: string): Float32Array | undefined {
	const row = db.all<{ dim: number; vec: Uint8Array }>("SELECT dim, vec FROM query_vecs WHERE query = ? AND space = ?", [query, space])[0];
	if (!row) return undefined;
	const bytes = row.vec instanceof Uint8Array ? row.vec : new Uint8Array(row.vec as ArrayLike<number>);
	// ⚠️ 坏缓存 MUST NOT 抛 —— 一条写坏的行不该让整次检索炸掉。当作未命中走端点即可。
	// 但也 MUST NOT **静默**：良性降级要打可读的一行，否则「为什么这条 query 每次都重发」
	// 就成了无从排查的怪事（本仓「良性降级打可读 INFO」那条口径）。
	if (bytes.byteLength !== row.dim * 4) {
		log.warn(`查询向量缓存行损坏（query=${JSON.stringify(query).slice(0, 40)}，声称 ${row.dim} 维 = ${row.dim * 4} 字节，实为 ${bytes.byteLength}）——当未命中走端点，本次检索不受影响。`);
		return undefined;
	}
	return decodeVec(bytes);
}

/** 写一条查询向量缓存（幂等覆盖）。 */
export function putCachedQueryVec(db: SqlDb, query: string, space: string, vec: Float32Array): void {
	// 排障留痕：把当前空间身份记进 meta（`INSERT OR IGNORE` 范式，与 schema_version 同款）。
	// 换端点/换模之后翻库能一眼看出「这库里躺着哪几个空间的向量」，不必去逐行解 space 串。
	db.run("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)", [`embed_space:${space}`, new Date().toISOString()]);
	db.run("INSERT OR REPLACE INTO query_vecs(query, space, dim, vec, created_at) VALUES (?, ?, ?, ?, ?)", [
		query,
		space,
		vec.length,
		encodeVec(vec),
		new Date().toISOString(),
	]);
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

/**
 * {@link parseSceneScores} 的**增量**版：逐行喂入、边跑边出（生产链自 add-matrix-index-phase-progress
 * 起走本函数——全量攒串再解析等于把整段场景检测变成一个 0 输出的黑盒）。
 *
 * ⚠️ 为什么两份实现而不是让整串版转调本函数：本件对判定安全的唯一承诺就是「流式与整串**逐字节等价**」，
 * 转调会把那条闸变成同义反复（差分闸就白跑了）。故整串版原样保留作**对拍基线**，两者由
 * `test/local-index-phase-progress.test.mjs` 的差分闸钉住。改任一份都 MUST 让那条闸红。
 *
 * 状态机与整串版逐行一致：`Parsed_metadata` 行内先取帧头 `pts_time` 暂存，再由紧随的
 * `lavfi.scene_score` 配对成帧；配不上的帧头被下一个帧头覆盖（同整串版）。
 */
export function createSceneScoreParser(): {
	push(line: string): void;
	readonly frames: { ts: number; score: number }[];
	/** 已配对成帧的最大 pts_time（秒）；一帧都没有时为 0。心跳读数取此值——
	 * 取「已成帧」而非「已见帧头」是为了让读数与 frames 同源，心跳与判定不会各说各话。 */
	readonly maxTs: number;
} {
	const frames: { ts: number; score: number }[] = [];
	let ts: number | undefined;
	let maxTs = 0;
	return {
		frames,
		get maxTs(): number {
			return maxTs;
		},
		push(line: string): void {
			if (!line.includes("Parsed_metadata")) return;
			const head = line.match(/frame:\d+\s.*\bpts_time:([0-9]+(?:\.[0-9]+)?)/);
			if (head) {
				ts = Number(head[1]);
				return;
			}
			const kv = line.match(/lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)/);
			if (kv && ts !== undefined) {
				frames.push({ ts, score: Number(kv[1]) });
				if (ts > maxTs) maxTs = ts;
				ts = undefined;
			}
		},
	};
}

/** 逐帧 score → 切点全集：`score > θ` 单帧判定（与旧 `select gt(scene,θ)` 选帧集合定义相同）。
 *
 * 「切点全集」相对场景表的增量在于**不做 <0.5s 合并**（buildScenes 会把紧邻切点并入前段）——
 * 被并掉的微切点正是快切蒙太奇的段内隐藏切点，铺轨窗口跨过它即闪帧（fix-broll-flash-frames D4）。
 *
 * ★ 帧率归一（滑窗和）判定曾在本 change 内实现，后按 2026-08-19 打样归因证据**撤出**：
 * 黄石 60fps 素材的 52 处真段内跳变里 49 处落在**已检出**的场景边界上（窗口越段，D1），
 * 3 处符合微切点特征（D4），无一处可归因于「高帧率软切漏检」；定向复扫（源 1185-1205s 等 7 段）
 * 新旧判定切点集合完全一致。无证据的检测阈值变更只会引入误检风险，故维持单帧判定。
 *
 * ★★ 2026-09-02 补证（fix-index-gradual-transition-blindness）：上面那次撤回在「高帧率软切」
 * 这件事上**成立，本件不翻它**；但它 MUST NOT 被后人读成「渐变转场无需处理」——那是两回事。
 * 实测匀速叠化过黑处 **1 秒滚动分数和峰值仅 0.1265**，而同素材 120s 内 7141 个滚动窗里有
 * **3639 个（51%）**的和 >0.15 ⇒ 滑窗和对这一类**完全不可分离**：即当初没撤回，它也接不住。
 * 换言之，渐变过黑不是「判据不够灵敏」，是**逐帧打分这条路本身对它失明**
 * （score 取 min(mafd,|Δmafd|)，匀速渐变 Δmafd≈0 把分数压到零），只能换正交信号（blackdetect）。 */
export function detectCutsFromScores(
	frames: { ts: number; score: number }[],
	threshold: number = SCENE_THRESHOLD_DEFAULT,
): number[] {
	return frames.filter((f) => f.score > threshold).map((f) => f.ts);
}

/** 切点 → 场景区间（秒）：<0.5s 的边界间隔并入前段（POC detect_scenes 逐行对齐）。
 *
 * `blackMidpoints`（fix-index-gradual-transition-blindness）：黑段**中点**作为额外的场景边界注入。
 * 缺省 `[]` ⇒ 与本 change 之前逐字节同行为（旧调用/旧对拍一字不改）。
 *
 * ★ **这是本 change 杠杆最大的一刀——不改铺轨代码就治住主路径**：段界是下游取窗的硬钳位
 * （`matrix-lay.ts sourceWindowFor` 的 `lo=seg.start` / `maxSt=seg.end-d`），
 * 真机那条 414.633–432.667 的 18.034s 假场景（内含 424.083–424.367 的叠化过黑）一旦在 424.225
 * 被劈开，「best 居中截 6s」得到的 420.65–426.65 就再也跨不过去。
 *
 * 取**中点**而不是起止两点：起止各注入一次会在两个边界之间留一条 0.28s 的「纯黑场景」，
 * 它会被 0.5s 并段规则吞掉一半、剩下的那条还会真的进候选池（一段全黑的 B-roll 候选）。
 * 中点一刀两断，黑段前后各归一侧，两侧都带着半截黑 ⇒ 由取窗侧的黑段收缩负责剔（见 matrix-lay）。
 *
 * 并段规则对注入点**一视同仁**：黑段中点距上一条边界 <minSceneSec 时同样被吞（不劈）。
 * 那种情形下黑段仍与场景区间交叠 ⇒ `annotateSceneStability` 的 stable 否决照常生效，信号不丢。 */
export function buildScenes(
	cuts: number[],
	durationSec: number,
	minSceneSec: number = MIN_SCENE_SEC,
	blackMidpoints: number[] = [],
): { st: number; ed: number }[] {
	// 归并成一条升序边界候选流。⚠️ MUST NOT 改动 `cuts` 本身——切点全集要按 θ 可复算，
	// 黑段是**另一种**边界来源，只影响场景分段，不进 cuts 表、不进切点透出。
	const marks = blackMidpoints.length ? [...cuts, ...blackMidpoints].sort((a, b) => a - b) : cuts;
	const bounds = [0];
	for (const t of marks) {
		if (t - bounds[bounds.length - 1]! >= minSceneSec) bounds.push(t);
	}
	if (durationSec - bounds[bounds.length - 1]! >= minSceneSec) bounds.push(durationSec);
	else bounds[bounds.length - 1] = durationSec;
	const scenes: { st: number; ed: number }[] = [];
	for (let i = 0; i < bounds.length - 1; i++) scenes.push({ st: bounds[i]!, ed: bounds[i + 1]! });
	return scenes;
}

/** 场景检测 stderr 的**诊断尾巴**保留行数（环形缓冲）。
 * `assertScenePassProductive` 只取过滤后的尾 3 行；留 40 是给「报错之后又被别的行刷了一片」留余量，
 * 再多也只是喂给一个 `.slice(-3)`。 */
const STDERR_DIAG_TAIL_LINES = 40;

/**
 * 这一行是不是**逐帧噪声**（该被排除在诊断尾巴之外）。
 *
 * ⚠️ 本函数存在的唯一理由是**口径唯一**：`runFfmpegCaptureStderr` 的环形缓冲与
 * `assertScenePassProductive` 的 `.slice(-3)` 必须过同一把筛子，否则前者留下的 40 行与后者
 * 认可的行不是同一批，报错尾巴会缺斤少两。此前两处各写一份 `.filter(...)`，靠头注互相自陈
 * 「逐字一致」维持——`black_start` 这次同批补排恰好证明那种约定不可靠（改一处即破约）。
 *
 * 三类噪声，量级都是 O(帧数)，混进诊断尾巴就会把真正的根因行**刷出窗口**：
 *   · `lavfi.scene_score` —— metadata=print 的键值行；
 *   · `pts_time:`        —— metadata=print 的帧头行；
 *   · `black_start`      —— blackdetect 的黑段行（fix-index-gradual-transition-blindness）。
 *     它虽然不是逐帧一条，但过黑频繁的素材（叠化转场片）一趟能刷出几十上百条，
 *     而诊断尾巴只有 3 行的展示预算 ⇒ 不排就是把「ffmpeg 为什么挂了」换成「哪里黑过」。
 */
export function isScenePassNoiseLine(line: string): boolean {
	return !line.trim() || line.includes("lavfi.scene_score") || line.includes("pts_time:") || line.includes("black_start");
}

/** 跑 ffmpeg **流式逐行**消费 stderr **并回退出码**（runFfmpeg 只留尾 4000 字会截断，故独立实现）。
 *
 * **已流式**（add-matrix-index-phase-progress）：`onLine` 边跑边收，调用方据此产心跳读数——
 * 场景检测是全程最长的一段（实测约占一半），攒完再解析等于它必然全程 0 输出。
 * 顺带清掉旧头注自陈的那笔账：metadata=print 逐帧两行 ⇒ 全量 stderr 体量 O(帧数)
 * （~170B/帧，1h@30fps ≈ 18MB 字符串），现在只留诊断尾巴。
 *
 * ⚠️ 返回的 `stderr` 是**过滤后的尾 {@link STDERR_DIAG_TAIL_LINES} 行**，不再是全量串。
 * 过滤口径与 `assertScenePassProductive` 里那条**逐字一致**（非空 且 不含 `lavfi.scene_score`
 * 且 不含 `pts_time:`），故它 `.slice(-3)` 取到的三行与全量串时代**完全相同**——
 * 改窄这里的口径会让降级 / 失败消息变哑（那正是「良性降级打可读 INFO」要防的）。
 *
 * ⚠️ 退出码 MUST 上抛给调用方判定。本函数曾经吞掉退出码（注释写「调用方解析不出切点自然为空」），
 * 那条推理是错的：空切点在下游**与「这片真没有切点」完全同形**——buildScenes([]) 得单场景 →
 * 稳定性注记拿不到帧判 stable → planFrames 收敛成 1 帧 → 整片被当作有效结论落库并打成功进度行，
 * 而 size:mtime 指纹会把这条坏行**粘住**，重跑直接 skip、永不自愈。
 *
 * 导出仅供闸用（生产调用方只有 probeCudaRuntime 与 runScenePassWithFallback）：
 * 「边跑边出行」与「诊断尾巴不丢」这两条性质只有真 spawn 一个进程才测得出来。 */
export function runFfmpegCaptureStderr(
	bin: string,
	args: string[],
	onLine?: (line: string) => void,
): Promise<{ exitCode: number | null; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const p = spawn(bin, args, { env: process.env });
		// StringDecoder 而非逐 chunk toString：chunk 边界会切开多字节 UTF-8 字符。
		// 全量攒串时代这只脏了诊断文案；流式后它会直接毁掉那一行的解析。
		const dec = new StringDecoder("utf8");
		const diag: string[] = [];
		let buf = "";
		const feed = (line: string): void => {
			onLine?.(line);
			if (!isScenePassNoiseLine(line)) {
				diag.push(line);
				if (diag.length > STDERR_DIAG_TAIL_LINES) diag.shift();
			}
		};
		p.stderr.on("data", (b: Buffer) => {
			buf += dec.write(b);
			// 只按 \n 切、并剥掉行尾 \r —— 与整串版的 `split(/\r?\n/)` 逐字节同义
			// （裸 \r 的 ffmpeg 进度行在两版里同样**不**成行，会粘在下一行前面）。
			for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
				const raw = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				feed(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
			}
		});
		p.on("error", (e) => reject(e));
		p.on("close", (code) => {
			buf += dec.end();
			// 末尾无换行的残段也要喂：整串版 split 会给出这一段，漏掉就是少解析一帧
			if (buf) feed(buf);
			resolvePromise({ exitCode: code, stderr: diag.join("\n") });
		});
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
	/** maxScore < stabilityThreshold ⇒ 固定机位类稳定场景（抽帧收敛为中点 1 帧）。
	 * 含黑段者恒 false（见 blackVeto）。 */
	stable: boolean;
	/** 本场景是否**因含黑段被否决 stable**（fix-index-gradual-transition-blindness）：
	 * 即「按 maxScore 本会判 stable、但区间内有黑段」。恒与 stable 互斥。
	 * 只为**成本可见**而存在——这一否决直接进 embed 计费（抽帧由 1 帧涨到 ~⌈时长/2s⌉ 帧），
	 * 账面 MUST 分列，MUST NOT 静默上涨。 */
	blackVeto: boolean;
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
 * ts==ed 是切入下一场景的切帧；<0.5s 并段丢弃的切点留在段内 ⇒ 其高分自然把该段判 unstable（正确语义）。
 *
 * `blackSpans`（fix-index-gradual-transition-blindness）：**与本场景区间有交叠的黑段一票否决 stable**。
 * 缺省 `[]` ⇒ 与本 change 之前逐字节同行为。
 *
 * 为什么必须否决：现行判据把含**完整 fade-to-black** 的 18.034s 判成「固定机位」
 * （真机五处所属场景 motion_p90 0.0104–0.0359 全在稳定阈 0.05 之下——渐变的帧间差本就极小），
 * 然后 planFrames 把它收敛成中点单帧。**这一步把「代表整段的向量取自一张渐变中途的暗帧」
 * 变成了必然事件**：实测五个代表帧 YAVG 82.4 / 123.0 / 70.8 / 130.9 / 103.3，三个明确落在渐变里；
 * id=2647 那条的唯一代表帧 YAVG=130.9，而该镜头的平台亮度是 191（淡到 68%）。
 * 检索拿这种帧当整段的语义，既召不回该召的、又召回了不该召的，且全程无任何异常信号。 */
export function annotateSceneStability(
	scenes: { st: number; ed: number }[],
	frameScores: { ts: number; score: number }[],
	stabilityThreshold: number = STABILITY_THRESHOLD_DEFAULT,
	containerFps?: number,
	blackSpans: { st: number; ed: number }[] = [],
): SceneSpan[] {
	const buckets: number[][] = scenes.map(() => []);
	const out: SceneSpan[] = scenes.map((s) => ({
		st: s.st,
		ed: s.ed,
		maxScore: 0,
		stable: true,
		blackVeto: false,
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
		const s = out[i]!;
		const calm = s.maxScore < stabilityThreshold;
		// 交叠判据用**闭区间相触即交**：黑段中点被注入成边界后，黑段的两半各落在相邻两个场景里，
		// 两条都该被否决（那半截黑就在它们各自的区间内）。
		const hasBlack = blackSpans.some((b) => b.st < s.ed && b.ed > s.st);
		s.blackVeto = calm && hasBlack;
		s.stable = calm && !hasBlack;
		s.motion = computeSceneMotion(buckets[i]!, containerFps);
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
	/** 源片自带黑场区间（秒，升序；fix-index-gradual-transition-blindness）。
	 * 与 `cuts` **并列而非合并**：切点是「画面换了」、黑段是「画面没了」，见 black_spans 表头注。
	 * `[]` = 扫过且真无黑段；本字段在 SceneDetection 上恒在场（视频趟必扫）。 */
	blackSpans: { st: number; ed: number }[];
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
	// stderr 尾部才是根因所在（前面全是逐帧 metadata / 黑段刷屏），且要给可读长度不给天书全文。
	// ⚠️ 过滤口径与 runFfmpegCaptureStderr 的环形缓冲**同一个函数**，见 isScenePassNoiseLine 头注。
	const tail = x.stderr.split(/\r?\n/).filter((l) => !isScenePassNoiseLine(l))
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
	const { frames, lane, blackSpans } = await runScenePassWithFallback(ffmpeg, path, durationSec, containerFps, laneOpts);
	const cuts = detectCutsFromScores(frames, threshold);
	// 黑段中点注入场景边界 + 含黑段场景否决 stable（fix-index-gradual-transition-blindness）。
	// ⚠️ 两者都只作用于**场景表**，`cuts` 一字未动——切点口径可复算是既有承诺。
	const mids = blackSpans.map((b) => (b.st + b.ed) / 2);
	return {
		scenes: annotateSceneStability(
			buildScenes(cuts, durationSec, MIN_SCENE_SEC, mids),
			frames,
			stabilityThreshold,
			containerFps,
			blackSpans,
		),
		cuts,
		blackSpans,
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
	/** 单素材内心跳（add-matrix-index-phase-progress）：原地刷新的解码读数，**不留痕、不参与任何判定**。
	 * 节流由调用方的 TickChannel 负责——本层每成一帧就报一次，是热路径。 */
	onTick?: (line: string) => void;
}

/** 阶段一心跳读数文案（纯函数，便于直接钉）：`已解码 1234s / 1800s（69%）· 车道 cpu_full`。
 * 时长探不到（≤0）时**不编百分比**——估不准的进度比没有更坏。
 * 百分比钳在 100：VFR / 容器时长不准时 pts 会越过名义时长，让它显示 107% 只会让人以为程序坏了。 */
export function sceneTickLine(decodedSec: number, durationSec: number, lane: DecodeLane): string {
	const head = `已解码 ${decodedSec.toFixed(0)}s`;
	if (!(durationSec > 0)) return `${head} · 车道 ${lane}`;
	const pct = Math.min(100, Math.round((decodedSec / durationSec) * 100));
	return `${head} / ${durationSec.toFixed(0)}s（${pct}%）· 车道 ${lane}`;
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
): Promise<{ frames: { ts: number; score: number }[]; lane: DecodeLane; blackSpans: { st: number; ed: number }[] }> {
	const fallback = opts?.fallback !== false;
	let lane: DecodeLane = opts?.lane ?? "cpu_full";
	const onTick = opts?.onTick;
	for (;;) {
		// 流式解析（add-matrix-index-phase-progress）：边解码边成帧，心跳读数取已成帧的最大 pts_time。
		// ⚠️ 心跳是**旁路**：parser.frames 与整串 parseSceneScores 逐字节等价（差分闸钉住），
		//    assertScenePassProductive 的三条判据、θ 判定、场景合并一字未动。
		// ⚠️ 每一轮降级重跑都新建 parser ⇒ 读数天然从 0 重开；文案带 lane，否则用户会看到进度倒退且无解释。
		const parser = createSceneScoreParser();
		// 黑段解析与 score 解析共吃同一条 stderr 流（同一趟解码双滤镜并联；**MUST NOT** 另起一趟）。
		// ⚠️ 每轮降级重跑都新建：降级前那半趟的黑段属于失败的那次，留着就是与新一趟的结果混账。
		const blacks = createBlackSpanParser();
		const { exitCode, stderr } = await runFfmpegCaptureStderr(
			ffmpeg,
			buildScenePassArgs({ src: path, lane, proxyWidth: opts?.proxyWidth, proxyScaler: opts?.proxyScaler }),
			onTick
				? (line): void => {
						const before = parser.frames.length;
						parser.push(line);
						blacks.push(line);
						// 只在真成了新帧才报：banner / 进度行 / 报错行不该让读数跳
						if (parser.frames.length !== before) onTick(sceneTickLine(parser.maxTs, durationSec, lane));
					}
				: (line): void => {
						parser.push(line);
						blacks.push(line);
					},
		);
		const frames = parser.frames;
		try {
			assertScenePassProductive({ exitCode, stderr, frameCount: frames.length, durationSec, fps: containerFps });
			return { frames, lane, blackSpans: blacks.spans };
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
	/** 单素材内心跳（add-matrix-index-phase-progress）。编排层传的是已带 `[i/N] 名字 · ` 前缀
	 * 且已节流的闭包；本层只管把读数递上去，不留痕、不参与判定。 */
	onTick?: (line: string) => void;
}

/** 阶段一产物：单素材抽帧**计划**（零 embed 请求；注入面 planMaterial 可整体替换，免 ffmpeg 依赖）。 */
export interface PlannedMaterial {
	materialId: string;
	/** 素材 kind（缺省按 video 兜底——旧注入面/旧调用零改动）。 */
	kind?: MaterialKind;
	durationMs: number;
	width: number;
	height: number;
	/** 名义帧率（`r_frame_rate` 求值）——落库 `materials.fps`。视频 ≤ 0 = 帧率不可解析 ⇒ 编排层跳过不入库（T6 不兜底）。 */
	fps: number;
	/** 平均帧率（`avg_frame_rate`；add-frame-rate-table-vfr-detect）。只作告警呈现，**不落库**（登记转出：索引 DB 不加列）。 */
	avgFps?: number;
	/** VFR 三态（`probeGeometry` 判据）：`true` ⇒ 编排层 WARN + `vfrMaterials` 计数；`false / null / undefined`（旧注入面）零告警。 */
	vfr?: boolean | null;
	/** 场景区间（毫秒取整）；图片恒统一形态一行 0..0（无场景轴，D1）。
	 * stable（add-index-stability-sampling）：缺省 undefined = unstable 语义（旧注入面零改动）；
	 * 图片行不参与判定（本就单帧），恒不带该标记。 */
	scenes: { st_ms: number; ed_ms: number; stable?: boolean; blackVeto?: boolean; motion?: SceneMotion }[];
	/** 抽帧计划（sceneIdx 指向 scenes 下标）——计划总数即计量会话 planned_units；图片恒单帧 ts_ms=0。 */
	framePlan: { sceneIdx: number; ts_ms: number }[];
	/** 切点全集（毫秒，升序；fix-broll-flash-frames D4）：含被 0.5s 合并吞并的微切点。
	 * 缺省 undefined = 无数据（旧注入面零改动）→ 落库 cuts_indexed=NULL、检索不透出 cuts；
	 * `[]` = 真无切点（cuts_indexed=1）。图片素材恒缺省（无时间轴）。 */
	cutsMs?: number[];
	/** 源片黑段区间（毫秒，升序；fix-index-gradual-transition-blindness）。
	 * 缺省 undefined = **没扫过**（旧注入面零改动）→ 落库 black_indexed=NULL、检索不透出 `black`；
	 * `[]` = 扫过且真无黑段（black_indexed=1）。图片素材恒缺省（无时间轴）。
	 * ⚠️ 三态与 `cutsMs` 同构，MUST NOT 拿长度判「扫没扫过」。 */
	blackMs?: [number, number][];
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
	/** 逐素材进度行（人读，命令层接 log.info）。**换行留痕**的事实行。 */
	onProgress?: (line: string) => void;
	/** 逐素材告警行（人读，命令层接 log.warn；add-frame-rate-table-vfr-detect：VFR / 帧率不可解析）。
	 *  缺席时退回 `onProgress` 通道——旧注入面一行不丢。与 `onProgress` 同受「先收口心跳」纪律。 */
	onWarn?: (line: string) => void;
	/** 单素材内心跳（人读，命令层接 log.tick）：**原地刷新不留痕**的过程读数
	 * （add-matrix-index-phase-progress）。与 onProgress 分工明确，MUST NOT 互相顶替——
	 * 心跳留痕会把日志刷爆，事实行不留痕会让「这条素材处理过」这件事查无实据。 */
	onTick?: (line: string) => void;
	/** 收口当前心跳行（命令层接 log.tickEnd）。编排层保证：**任何 onProgress 之前**先调它，
	 * 否则换行的信息行会与半截心跳互相覆盖。 */
	onTickEnd?: () => void;
	/** 测试注入：整体替换阶段一（探测/场景检测/抽帧计划）。 */
	planMaterial?: (path: string, ctx: PlanMaterialCtx) => Promise<PlannedMaterial>;
	/** 测试注入：整体替换阶段二（抽帧/embed；sessionToken 透传）。
	 * `onTick` 是**可选第四参**：不带它的旧注入实现行为与本 change 之前逐字节一致。 */
	embedFrames?: (
		path: string,
		planned: PlannedMaterial,
		sessionToken?: string,
		onTick?: (line: string) => void,
	) => Promise<FrameVec[]>;
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
	stability: {
		stableScenes: number;
		unstableScenes: number;
		framesSaved: number;
		/** 因**含黑段**被否决 stable 的场景数（fix-index-gradual-transition-blindness）。 */
		blackVetoScenes: number;
		/** 该否决带来的**新增**抽帧数（直接进 embed 计费；与 framesSaved 分列不相抵——
		 * 一笔是省、一笔是增，合并成净值会把「成本为什么涨了」这件事藏起来）。 */
		blackVetoFrames: number;
	};
	/** 本轮入库的视频素材里判为 VFR 的条数（add-frame-rate-table-vfr-detect D4；只计数不落库）；为 0 时无本键，
	 *  命令层 `--json vfr_materials` 恒带（`?? 0`）。 */
	vfrMaterials?: number;
	/** 计量会话账面：仅会话真开过时出现（豁免/零计划帧 = 无本键）。 */
	billing?: IndexBillingOutcome;
	/** 本轮枚举遇到的**断链**（目标不可达的链接自身路径）；无断链时无本键。
	 * 命令层的零枚举诊断按 `string[]` duck-typing 消费（`matrix.ts readBrokenLinks`）——
	 * ⚠️ 改形状（换成计数/对象）MUST 同批改那一头，否则诊断会静默退化成「没检出真因」，
	 * 而那正是本 change 要治的病。 */
	brokenLinks?: string[];
	/** 经符号链接引入、真身落在 `--dirs` 域外的素材数；为 0 时无本键（照收不丢，只是告知）。 */
	linkedOutsideDirs?: number;
	elapsedMs: number;
}

/** 通用枚举（递归，深度上限 4；隐藏目录跳过）。 */
/**
 * 把一个文件路径的**末段**换成盘上真实大小写（父目录段不动——索引键是绝对路径，
 * 而父目录的大小写在同一台机器上由用户的 `--dirs` 决定、两条路径都会指向同一批文件，
 * 真正会造成「同一文件两行」的是文件名本身）。
 *
 * 读不到父目录（权限/竞态）时原样返回：宁可退回旧行为，也 MUST NOT 因为归一化失败就丢掉这个文件。
 */
function realBasenamePath(abs: string): string {
	try {
		const dir = dirname(abs);
		const want = basename(abs).toLowerCase();
		for (const name of readdirSync(dir)) {
			if (name.toLowerCase() === want) return join(dir, name);
		}
	} catch {
		/* 读不到就原样返回 */
	}
	return abs;
}

/** 枚举期的符号链接诊断（fix-material-intake-path-and-enumeration §2.8/§2.9）。 */
export interface EnumDiagnostics {
	/** 断链：目标不可达的**链接自身路径**（不是 target —— target 已经没了）。 */
	brokenLinks: string[];
	/** 经链接引入、真身落在 `--dirs` 域外的素材（link = 域内看到的路径，real = 真身）。 */
	crossDomain: { link: string; real: string }[];
}

/**
 * 诊断挂在**返回数组的身份**上，而不是塞进返回值或模块级全局。
 *
 * 为什么：枚举口的签名 `(dirs: string[]) => string[]` 同时是 `IndexRunOptions.listFiles`
 * 的注入面，而命令层（`matrix.ts runIndexMode`）为了逐项计数**自己先枚举一次**、再把
 * 同一份清单原样经 `listFiles: () => enumerated` 交回给 `indexLocalMaterials`
 * （全轮只走一遍文件系统）。改返回类型会当场掐断那条注入面；模块级全局则会在
 * 同一进程的多轮枚举之间串味（index 与 `--local` 检索各枚举一次）。
 * 挂在数组身份上：谁拿着那份清单谁读得到，读不到就是「本轮无事发生」。
 */
const ENUM_DIAGNOSTICS = new WeakMap<readonly string[], EnumDiagnostics>();

/** 读取某次枚举结果携带的符号链接诊断；本轮没有断链也没有跨域链接时返回 undefined。 */
export function enumerationDiagnosticsOf(files: readonly string[]): EnumDiagnostics | undefined {
	return ENUM_DIAGNOSTICS.get(files);
}

/** 路径比较键：win32 大小写不敏感（与 local-search.ts `pathInDirs` 同口径），posix 原样。 */
function pathKey(p: string): string {
	return process.platform === "win32" ? p.toLowerCase() : p;
}

/** 真身是否落在本轮检索域内（跨域告知用；与 `pathInDirs` 同判据，此处不跨模块引以免耦合）。 */
function insideAnyDir(p: string, dirsResolved: string[]): boolean {
	const k = pathKey(p);
	return dirsResolved.some((d) => {
		const base = pathKey(d.endsWith(sep) ? d.slice(0, -1) : d);
		return k === base || k.startsWith(base + sep);
	});
}

function listFilesMatching(dirs: string[], match: (name: string) => boolean): string[] {
	const out: string[] = [];
	// 经符号链接收录的候选（link = 域内路径 / real = 真身）：**先攒着**，收口时按真身统一去重。
	const linked: { link: string; real: string }[] = [];
	const brokenLinks: string[] = [];
	// visited-set：已走过的目录（词法路径，纯 Set 维护、零 syscall）+ 已进过的链接目标真身。
	// 深度上限 4 只封死无限递归，自指链接仍会把同一棵树在 4 层内反复展开 —— 故必须显式查重。
	const walkedDirs = new Set<string>();
	const visitedReal = new Set<string>();
	/** 本枝是经链接进来的时 realBase = 该链接目标的真身目录；否则 null（= 老路径，零额外 syscall）。 */
	const walk = (dir: string, depth: number, realBase: string | null): void => {
		if (depth > 4) return;
		walkedDirs.add(pathKey(resolve(dir)));
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(dir, { withFileTypes: true }) as never;
		} catch {
			return;
		}
		for (const e of entries as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>) {
			if (e.name.startsWith(".")) continue;
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				// 经链接进来的枝：子路径的真身按字符串推导（父目录的 realpath 已经拿到了，**不再 syscall**）
				walk(p, depth + 1, realBase === null ? null : join(realBase, e.name));
			} else if (e.isFile()) {
				if (!match(e.name)) continue;
				if (realBase === null) out.push(resolve(p));
				else linked.push({ link: resolve(p), real: join(realBase, e.name) });
			} else if (e.isSymbolicLink()) {
				// ── 第三态（fix-material-intake-path-and-enumeration §2）────────────────
				// 符号链接在 Dirent 上 `isFile() === false && isDirectory() === false`
				// （Windows 的 junction / 重解析点同样落这一枝），此前两个 else-if 全落空 ⇒
				// **无声丢弃**，目录型链接连递归都不做。这是疏漏不是立法：同一函数的顶层分支
				// 走 `statSync`（按定义跟随链接）—— 点名一条链接文件时收录、同一条躺在被遍历的
				// 目录里就丢弃，顶层跟随、递归不跟随的不一致本身即缺陷。
				// 本机 49 条现成链接（skills 安装建的 junction）实测：Dirent 走法 69 个 .md，
				// 跟随走法 588 个 —— **519 个被吞**。
				// ⚠️ 性能红线：只有走到这一枝才落 syscall。普通文件/目录一次都不多花，
				//    MUST NOT 用 statSync 无条件替换 Dirent 判型（上万文件的库会当场变慢）。
				let st: ReturnType<typeof statSync>;
				try {
					st = statSync(p); // 跟随链接；断链在这里抛
				} catch {
					brokenLinks.push(resolve(p)); // 只跳不崩：路径上抛给零枚举诊断去点名
					continue;
				}
				// ⚠️ 判型用**链接自身的 basename**（`e.name`），MUST NOT 用 target 的：
				// `--dirs` 划的域是链接所在的那一侧，而 `matrix lay` 要按这个路径回写工程。
				if (st.isFile() && !match(e.name)) continue; // 非素材链接：连 realpath 都不必花
				let real: string;
				try {
					real = realpathSync.native(p);
				} catch {
					brokenLinks.push(resolve(p));
					continue;
				}
				if (st.isFile()) {
					// ⚠️ 收录的是**链接路径**，且 MUST NOT 套 realBasenamePath —— 它按父目录 listing
					//    回填链接名的大小写，不解析 target；这里的名字本就来自 readdirSync（盘上真名）。
					linked.push({ link: resolve(p), real });
				} else if (st.isDirectory()) {
					const k = pathKey(real);
					if (visitedReal.has(k) || walkedDirs.has(k)) continue; // 防环：进目录前先查
					visitedReal.add(k);
					walk(p, depth + 1, real);
				}
				// 其余类型（socket/fifo/块设备）照旧不收
			}
		}
	};
	// 枚举分流（add-local-search-material-scope）：`--dirs` 的每一项既可以是**文件夹**，
	// 也可以是**单个素材文件**——传文件即把检索域收窄到该素材。
	// ★ 这不是新增能力，是把已有的巧合扶正：检索侧 `pathInDirs` 的 `p === base` 分支
	//   本来就认单文件，只是索引侧枚举不到它，于是「钉到某一部片」这件事一直做不成。
	//   二创解说场景实测：三片同夹时 187 个候选里有 86 条来自邻片（46.0%），
	//   agent 只能事后按 clip_id 手删——那是把结构性问题当成个案在擦。
	for (const d of dirs) {
		const abs = resolve(d);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(abs);
		} catch {
			// 路径不存在/不可读：跳过该项，MUST NOT 中止整轮（其余项照枚举）。
			// ⚠️ 只在**已经失败**的这条岔路上多探一次 lstat，分辨「压根没这个路径」与
			//    「链接在、真身没了」—— 后者要被零枚举诊断点名（用户 `ls` 明明看得见那个名字）。
			//    happy path 一次都不多花。
			try {
				if (lstatSync(abs).isSymbolicLink()) brokenLinks.push(abs);
			} catch {
				/* 真的没这个路径 */
			}
			continue;
		}
		// 显式传入的文件即使 basename 以 `.` 开头也**尊重**——`walk` 里那条跳过隐藏项的规则
		// 是给「遍历目录时不要自作主张收录」用的，用户点名要的东西不适用。
		if (st.isFile()) {
			if (!match(basename(abs))) continue;
			// ⚠️ **MUST 取盘上真实大小写**，MUST NOT 直接 push 用户手打的路径。
			// 目录分支的 basename 一直来自 readdirSync（盘上真名），单文件分支若原样收用户输入，
			// Windows 上大小写一错，同一个物理文件就会被枚举成两条：
			// materials 表两行、去重失效、增量失效、**重复烧 embed 积分**，检索侧还吐重复候选
			// —— 正是本 change 要消灭的那类污染，从另一个方向又造了一遍。
			out.push(realBasenamePath(abs));
			continue;
		}
		// 顶层显式点名的目录**不当链接枝处理**（realBase=null）：用户划的域就是这个名字，
		// 域内路径一律按用户的写法回写工程。
		if (st.isDirectory()) walk(abs, 0, null);
	}
	// ── 收口 ──────────────────────────────────────────────────────────────────
	// 一整轮没遇到任何符号链接 ⇒ 走与本条落地前**逐字节等价**的老路：零 realpath、零额外 syscall。
	// 去重：同时传「文件夹」与「其内部某文件」时不重复计数（否则素材总数会虚高）
	if (linked.length === 0 && brokenLinks.length === 0) return [...new Set(out)].sort();
	// 真身归一：按**目录**缓存 realpath（同一目录下 N 个文件只花 1 次 syscall），
	// 这样 8.3 短名 / 大小写 / 上层还套着一层链接的路径都能与链接的 realpath 对上。
	const realDirCache = new Map<string, string>();
	const canonKey = (p: string): string => {
		const dir = dirname(p);
		const ck = pathKey(dir);
		let realDir = realDirCache.get(ck);
		if (realDir === undefined) {
			try {
				realDir = realpathSync.native(dir);
			} catch {
				realDir = dir; // 读不到就退回词法路径：宁可少去一次重，也 MUST NOT 因此丢文件
			}
			realDirCache.set(ck, realDir);
		}
		return pathKey(join(realDir, basename(p)));
	};
	const keys = new Set(out.map(canonKey));
	const kept: { link: string; real: string }[] = [];
	// 链接侧按真身去重，同一真身**保留真实路径那一条**（依据：`materials.path` UNIQUE 且增量按路径判，
	// 而 `material_id` 是内容哈希 ⇒ 不去重就是「同一 material_id 两行 path」：增量失效、
	// 检索侧吐重复候选、**重复烧 embed 积分**）。先按链接路径排序再去重 ⇒ 两条链接指同一真身时
	// 留哪一条与遍历顺序无关（同一批素材跑两遍结果一致）。
	for (const cand of [...linked].sort((a, b) => (pathKey(a.link) < pathKey(b.link) ? -1 : 1))) {
		const k = pathKey(cand.real);
		if (keys.has(k)) continue;
		keys.add(k);
		kept.push(cand);
	}
	const files = [...new Set([...out, ...kept.map((c) => c.link)])].sort();
	// 跨域：真身在 `--dirs` 域外 —— **照收**（那正是用户建这条链接的意图），只是要说一声。
	// ⚠️ 判据的两侧 MUST 都归一后再比：左边是 realpath（长名/真大小写），右边若原样用用户手打的
	//    `--dirs`，一个 8.3 短名（本机 TEMP 就是 `C:\Users\ADMINI~1\…`）或上层套了一层链接的写法，
	//    就会把**真身明明在域内**的链接报成跨域。实测：单测 `真身在域内的链接不报跨域` 第一次跑就
	//    红在这上面（short vs long）。误报「已检出的真因」比不报更坏 —— 那正是本 change 要治的病。
	const dirsResolved = dirs.flatMap((d) => {
		const abs = resolve(d);
		try {
			const real = realpathSync.native(abs);
			return pathKey(real) === pathKey(abs) ? [abs] : [abs, real];
		} catch {
			return [abs]; // 路径已经没了（如断链项）：拿词法路径顶上，不影响其余项
		}
	});
	const crossDomain = kept.filter((c) => !insideAnyDir(c.real, dirsResolved));
	if (brokenLinks.length || crossDomain.length) {
		ENUM_DIAGNOSTICS.set(files, { brokenLinks: [...new Set(brokenLinks)].sort(), crossDomain });
	}
	return files;
}

/** 枚举视频文件。`dirs` 的每一项可以是**文件夹**（递归）或**单个素材文件**（见 listFilesMatching）。 */
export function listVideoFiles(dirs: string[]): string[] {
	return listFilesMatching(dirs, (n) => VIDEO_EXT.test(n));
}

/** 枚举视频+图片素材（add-matrix-local-image-broll：索引缺省枚举口，图片与视频一视同仁）。
 *  `dirs` 的每一项可以是**文件夹**（递归）或**单个素材文件**（见 listFilesMatching）。 */
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
		onTick: ctx.onTick,
	});
	const scenes = det.scenes;
	const plan = planFrames(scenes); // stable 场景在此收敛为中点 1 帧
	return {
		materialId,
		kind,
		durationMs: sec2ms(geo.duration),
		width: geo.width,
		height: geo.height,
		fps: geo.fps,
		// VFR 两值随同一次 ffprobe 带出（零额外进程），入库门与告警在编排层统一处置（注入面同一口径）
		avgFps: geo.avgFps,
		vfr: geo.vfr ?? null,
		scenes: scenes.map((s) => ({
			st_ms: sec2ms(s.st),
			ed_ms: sec2ms(s.ed),
			stable: s.stable,
			blackVeto: s.blackVeto,
			motion: s.motion,
		})),
		framePlan: plan.map((p) => ({ sceneIdx: p.sceneIdx, ts_ms: sec2ms(p.ts) })),
		cutsMs: det.cuts.map((t) => sec2ms(t)),
		blackMs: det.blackSpans.map((b) => [sec2ms(b.st), sec2ms(b.ed)] as [number, number]),
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
	onTick?: (line: string) => void,
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
		// 心跳分子取「已走过的计划帧」而非「抽成的帧」：坏帧连片时后者会卡住不动，
		// 让用户以为程序死了——真实抽成数由 `已向量化` 那段如实报（flush 后才计入）。
		let done = 0;
		for (const { sceneIdx, ts_ms } of planned.framePlan) {
			done++;
			const jpg = join(frameDir, `${basename(path, extname(path))}_${ts_ms}.jpg`);
			if (await extractFrameJpg(ff.ffmpeg, path, ts_ms / 1000, jpg)) {
				batch.push({ sceneIdx, ts_ms, jpg }); // 个别坏帧跳过（抽不出即不入批）
				if (batch.length >= EMBED_BATCH_MAX) await flush();
			}
			onTick?.(`抽帧 ${done}/${planned.framePlan.length} · 已向量化 ${frames.length}`);
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
	// ── 进度通道（add-matrix-index-phase-progress）────────────────────────────
	// 心跳走 \r 原地刷新，事实行走换行。**所有**行式进度统一经 `progress()` 出口：
	// 它先收口心跳再打行，漏一处就会看到被心跳吃掉半截的日志行。
	const ticker = createTickChannel({ onTick: opts.onTick, onTickEnd: opts.onTickEnd });
	const progress = (line: string): void => {
		ticker.end();
		opts.onProgress?.(line);
	};
	const warn = (line: string): void => {
		ticker.end();
		(opts.onWarn ?? opts.onProgress)?.(line);
	};
	// 缺省枚举口 = 视频 + 图片（--no-image-broll 下索引仍收录图片：索引是缓存，排除发生在检索/铺轨侧）
	const files = (opts.listFiles ?? listMaterialFiles)(opts.dirs);
	// 先给分母（spec §1）：此前第一条带总数的行是下面那条「抽帧计划就绪」，要等**阶段一全跑完**
	// （实测约占全程一半，真机 1715s 里约 850s）才打——在那之前用户连「这轮要处理几个」都不知道。
	// ⚠️ 这里只**读** files 做分列统计：MUST NOT 碰枚举分流本身（那是 add-local-search-material-scope
	//    的靶位），也 MUST NOT 复用循环里的 `kinds[...].total++`（那是入库账面，混用即双计）。
	const enumeratedVideo = files.filter((p) => (materialKindForPath(p) ?? "video") === "video").length;
	progress(`枚举到 ${files.length} 个素材（视频 ${enumeratedVideo} · 图片 ${files.length - enumeratedVideo}）`);
	// 符号链接账面（fix-material-intake-path-and-enumeration §2.8/§2.9）：诊断跟着**这份清单的
	// 身份**走 —— 命令层为逐项计数先枚举一次、再把同一个数组经 `listFiles` 交回来，注入面上照样读得到。
	const enumDiag = enumerationDiagnosticsOf(files);
	if (enumDiag?.crossDomain.length) {
		// 跨域是**正常用法**（把 X 盘那部片链进工作夹就是为了跨域），故走 info 不走 warn：
		// 良性降级/越界只需要一句可读的交代，MUST NOT 抛错、更 MUST NOT 静默丢弃。
		progress(
			`${enumDiag.crossDomain.length} 个素材经符号链接引入、真身在检索域外（照收）：\n` +
				enumDiag.crossDomain.slice(0, 3).map((c) => `     ${c.link} → ${c.real}`).join("\n") +
				(enumDiag.crossDomain.length > 3 ? `\n     …（其余 ${enumDiag.crossDomain.length - 3} 条略）` : ""),
		);
	}
	if (enumDiag?.brokenLinks.length) {
		// 断链只跳不崩。这里说一声是因为：本轮**有产出**时零枚举诊断根本不会打，
		// 不说的话「链接在、真身没了」这件事就只剩用户自己去 `ls -la` 发现。
		progress(
			`${enumDiag.brokenLinks.length} 条符号链接的目标不可达，已跳过：\n` +
				enumDiag.brokenLinks.slice(0, 3).map((p) => `     ${p}`).join("\n") +
				(enumDiag.brokenLinks.length > 3 ? `\n     …（其余 ${enumDiag.brokenLinks.length - 3} 条略）` : ""),
		);
	}
	const db = await openLocalIndexDb(dbPath);
	const stats = { total: files.length, indexed: 0, skipped: 0, rebuilt: 0, failed: 0 };
	const kinds = { video: { total: 0, indexed: 0 }, image: { total: 0, indexed: 0 } };
	const stability = { stableScenes: 0, unstableScenes: 0, framesSaved: 0, blackVetoScenes: 0, blackVetoFrames: 0 };
	let sceneCount = 0;
	let frameCount = 0;
	// VFR 素材计数（add-frame-rate-table-vfr-detect D4）：只计本轮真正入库（阶段一通过）的视频素材；不落库、只进 summary。
	let vfrMaterials = 0;
	// ffmpeg 只在走默认处理链时才是硬依赖（测试注入 planMaterial+embedFrames 免装）。
	// ⚠️ 零枚举时 MUST NOT 要 ffmpeg：一个素材都没有就没有任何抽帧要做，这里若先 `requireFfmpeg` 抛
	//    「未找到 ffmpeg」，命令层的零枚举诊断（真因点名 / ok:false / 退出码 1）就一句都到不了用户面前——
	//    用户看到的是一条与真因无关的装包提示（2026-09-03 parity CI 的 Linux runner 首跑实证：
	//    intake-dirs-path 三条 + local-search-material-scope 一条正是这么红的）。`ff` 只在逐素材循环里解引用。
	const ff = (opts.planMaterial && opts.embedFrames) || files.length === 0 ? null : requireFfmpeg(opts.ffmpegPath);
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
		((p: string, planned: PlannedMaterial, token?: string, onTick?: (line: string) => void) =>
			embedFramesDefault(p, planned, ff!, opts.embed, token, onTick));

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
		let seq = 0;
		for (const path of files) {
			const name = basename(path);
			seq++;
			kinds[materialKindForPath(path) ?? "video"].total++;
			let st: { size: number; mtimeMs: number };
			try {
				st = statSync(path);
			} catch {
				stats.failed++;
				progress(`[${name}] 读不到文件（跳过）`);
				continue;
			}
			const size = st.size;
			const mtimeMs = Math.round(st.mtimeMs);
			const prev = db.get<MaterialRow>("SELECT * FROM materials WHERE path = ?", [path]);
			if (prev && !opts.rebuild && prev.size === size && prev.mtime_ms === mtimeMs) {
				stats.skipped++;
				progress(`[${name}] 指纹未变，跳过`);
				continue;
			}
			// 进场行（spec §2）：本件之前，成功路径在阶段一**一条都不打**——四处 onProgress 全在
			// 跳过 / 降级 / 失败分支上，于是「一切正常」恰恰是唯一完全静默的情形。
			// ⚠️ 不带时长：时长要等 planOne 里那次 ffprobe 才有，为这一行提前探一次就是白烧一个进程
			//    （spec 明令 MUST NOT 为进度新增探测）。时长在下面的收尾行里给。
			progress(`[${seq}/${files.length}] ${name} · 场景检测中…`);
			ticker.reset(); // 新素材重开节流窗口：第一条心跳立刻可见，不必先等 500ms
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
								progress("GPU 硬解不可用（本机未探到可用 CUDA 解码设备），本轮走 CPU 解码——索引结果不受影响");
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
					// 心跳（spec §3）：前缀在这里加、节流在 ticker 里做——下层只报读数，
					// 不知道自己是第几条素材，也不该操心刷屏。
					onTick: (line) => ticker.tick(`[${seq}/${files.length}] ${name} · ${line}`),
				});
				// 熔断：静态门只看编码格式，拦不住「驱动挂了/卡被占满」这类整机态问题——
				// 那种情况下每个素材都要白试 ~3s，连挂两次就不再试。
				if (before === laneState.degradeLog.length) laneState.gpuFailStreak = 0;
				if (laneState.gpuFailStreak >= GPU_FAIL_STREAK_LIMIT && !laneState.tripped) {
					laneState.tripped = true;
					laneState.gpuStatus = "tripped";
					progress(`GPU 硬解连续 ${GPU_FAIL_STREAK_LIMIT} 次失败，本轮余下素材直接走 CPU 解码`);
				}
				if (planned.decodeLane) {
					laneState.lanes[planned.decodeLane] = (laneState.lanes[planned.decodeLane] ?? 0) + 1;
					if (planned.decodeLane === "gpu") laneState.gpuStatus = laneState.tripped ? "tripped" : "on";
				}
				// 帧率门（add-frame-rate-table-vfr-detect D5）：视频素材帧率不可解析 ⇒ 跳过不入库 + WARN（计入 failed），
				// MUST NOT 以 25 / 30 兜底落库——`materials.fps` 是检索 / 铺轨侧帧网格吸附的时间基，写个猜的值比缺席更坏
				// （下游会以为「帧网格吸附已生效」）。判在入库边界而非探测处：注入面（planMaterial）产的计划同受此门。
				const plannedKind = planned.kind ?? materialKindForPath(path) ?? "video";
				if (plannedKind !== "image" && !(Number.isFinite(planned.fps) && planned.fps > 0)) {
					stats.failed++;
					warn(
						`[${seq}/${files.length}] ${name} · 源文件帧率不可解析（r_frame_rate 求值得 ${String(planned.fps)}），已跳过不入库——` +
							"帧率是帧网格吸附的时间基，不以 25/30 兜底；请先重封装（ffmpeg -c copy）或重编码后再索引",
					);
					continue;
				}
				// VFR 可见（D4）：只告警不阻断、照常入库；`results[].fps` 仍是名义值，不加 DB 列，计数进 summary `vfrMaterials`。
				if (plannedKind !== "image" && planned.vfr === true) {
					vfrMaterials++;
					warn(
						`[${seq}/${files.length}] ${name} · 疑似可变帧率（VFR）：r_frame_rate ${planned.fps.toFixed(3)} / avg_frame_rate ${planned.avgFps !== undefined ? planned.avgFps.toFixed(3) : "?"}——` +
							"照常入库，检索透出的 fps 是名义值；铺轨的帧网格吸附按名义帧率，VFR 源端点在播放器 / 渲染器上可能逐段漂移",
					);
				}
				// 收尾行（spec §2）：数据全部取自 planned，MUST NOT 为这一行新增任何 ffprobe / 解码。
				// ⚠️ 这一行 MUST NOT 顶替阶段二那条「时长 / 场景 / 帧」行（主规格 `首次索引` 要的是后者，
				//    **帧数**天然要等 embed 跑完才有）——两行各说各的阶段，都要在。
				progress(
					(planned.kind ?? materialKindForPath(path) ?? "video") === "image"
						? `[${seq}/${files.length}] ${name} · 图片 · 单帧计划`
						: `[${seq}/${files.length}] ${name} · 时长 ${(planned.durationMs / 1000).toFixed(1)}s · ` +
							`场景 ${planned.scenes.length} · 切点 ${planned.cutsMs?.length ?? "—"} · ` +
							// 黑段数同列（fix-index-gradual-transition-blindness）：黑段与切点是两路正交信号，
							// 只报切点会让「这片有没有渐变过黑」在整条日志里查无实据。
							`黑段 ${planned.blackMs?.length ?? "—"} · 车道 ${planned.decodeLane ?? "—"}`,
				);
				pending.push({ path, name, size, mtimeMs, prev, planned });
			} catch (e) {
				stats.failed++;
				progress(`[${name}] 探测/场景检测失败：${e instanceof Error ? e.message : String(e)}（跳过）`);
			}
		}
		plannedFrames = pending.reduce((n, p) => n + p.planned.framePlan.length, 0);
		if (pending.length) {
			progress(`抽帧计划就绪：${pending.length} 个素材待索引 · 计划 ${plannedFrames} 帧`);
		}

		// ── 计量会话 open（planned_units = 抽帧计划总数；无钩子/零计划帧不开会话）──
		if (opts.session && plannedFrames > 0) {
			opened = await opts.session.open(plannedFrames); // 积分不足即在此失败（CloudError 上抛）
			billing = { plannedUnits: plannedFrames, preDeductedCredits: opened.preDeductedCredits };
		}

		// ── 阶段二：抽帧 + embed（批请求带 session_token）+ 素材粒度事务落库 ──
		let seq2 = 0;
		for (const p of pending) {
			seq2++;
			let frames: FrameVec[];
			ticker.reset(); // 同阶段一：换素材即重开节流窗口
			try {
				// 心跳（spec §3）：本例平均每素材约 535 帧，`embedOne` 内部此前全程无回调——
				// 这一段静默同样按分钟计。前缀分母用 pending.length（阶段二只跑待索引的那批）。
				frames = await embedOne(p.path, p.planned, opened?.sessionToken, (line) =>
					ticker.tick(`[${seq2}/${pending.length}] ${p.name} · ${line}`),
				);
			} catch (e) {
				// 端点级失败：中止整轮（spec「整体失败」；已完成素材已各自落库，finally 仍会 close 结算）
				if (isEndpointFatal(e)) throw e;
				stats.failed++;
				progress(`[${p.name}] 处理失败：${e instanceof Error ? e.message : String(e)}（跳过）`);
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
					"INSERT INTO materials(material_id, path, kind, size, mtime_ms, duration_ms, width, height, fps, indexed_at, cuts_indexed, black_indexed, decode_lane) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
						// black_indexed（fix-index-gradual-transition-blindness）：同 cuts_indexed 三态口径——
						// 扫过=1（空集=真无黑段）；旧注入面/图片缺省 undefined → NULL（检索侧不透出 black）
						p.planned.blackMs !== undefined ? 1 : null,
						p.planned.decodeLane ?? null,
					],
				);
				const matRowId = Number(db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id);
				if (p.planned.cutsMs !== undefined) {
					for (const t of p.planned.cutsMs) {
						db.run("INSERT OR IGNORE INTO cuts(material_id, t_ms, origin) VALUES (?,?,'detected')", [matRowId, t]);
					}
				}
				if (p.planned.blackMs !== undefined) {
					for (const [st, ed] of p.planned.blackMs) {
						db.run("INSERT INTO black_spans(material_id, st_ms, ed_ms) VALUES (?,?,?)", [matRowId, st, ed]);
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
				// 黑段否决 stable 的**增帧**账（fix-index-gradual-transition-blindness）：
				// 这一条直接进 embed 计费（真机 5 个场景由 5 帧涨到约 33 帧），MUST NOT 静默上涨。
				// 口径 = 同一场景集里把「因黑段被否决」的那些当作 stable 重算计划帧 → 与实际计划之差。
				// 与 framesSaved 对称（都在 ms→秒 域重算，与取整漂移解耦），两笔各记各的、不相抵。
				const vetoed = p.planned.scenes.filter((s) => s.blackVeto === true).length;
				if (vetoed > 0) {
					const asIfStable = p.planned.scenes.map((s) => ({
						st: s.st_ms / 1000,
						ed: s.ed_ms / 1000,
						stable: s.blackVeto === true ? true : s.stable,
					}));
					const added = planFrames(secs).length - planFrames(asIfStable).length;
					stability.blackVetoScenes += vetoed;
					stability.blackVetoFrames += added;
					stableNote += ` · 含黑段否决 stable ${vetoed} 段（增 ${added} 帧）`;
				}
			}
			progress(
				kind === "image"
					? `[${p.name}] 图片 · 单帧向量${p.prev ? "（指纹变化，已级联重建）" : ""}`
					: `[${p.name}] 时长 ${(p.planned.durationMs / 1000).toFixed(1)}s · 场景 ${p.planned.scenes.length} · 帧 ${frames.length}${stableNote}${p.prev ? "（指纹变化，已级联重建）" : ""}`,
			);
		}
		// 降级轮末聚合成一条：逐素材打会把真正的问题淹在良性噪声里（良性降级打可读 INFO）。
		// ffmpeg 原始 stderr 不上抛——那是天书；根因已经翻成人话装进这一行。
		const summary = summarizeDowngrades(laneState.degradeLog);
		if (summary) progress(summary);
	} finally {
		// 收口（spec §4）：抛异常中断时心跳可能停在半行上，后面所有输出都会贴在它后面
		ticker.end();
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
				progress(
					`计量会话已结算：实际用量 ${closed.usedUnits} 帧 → 实结 ${closed.settledCredits} 积分 · 退还 ${closed.refundedCredits} 积分（预扣 ${opened.preDeductedCredits}）`,
				);
			} catch (e) {
				if (billing) billing.reconcilePending = true;
				progress(
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
		// VFR 计数与 brokenLinks / linkedOutsideDirs 同款「没有就不带键」：全 CFR 的一轮在库侧机读面上与本件之前逐字节一致
		// （既有 phase-progress 用例锁着 IndexRunResult 键集）；命令层 --json 恒带 `vfr_materials`（0 也带）。
		...(vfrMaterials > 0 ? { vfrMaterials } : {}),
		...(billing ? { billing } : {}),
		// 断链/跨域上抛给命令层诊断消费（§2.8）：**没有就不带这两个键**，
		// 于是「本轮没遇到链接」在机读面上与本条落地前逐字节一致。
		...(enumDiag?.brokenLinks.length ? { brokenLinks: enumDiag.brokenLinks } : {}),
		...(enumDiag?.crossDomain.length ? { linkedOutsideDirs: enumDiag.crossDomain.length } : {}),
		elapsedMs: Date.now() - t0,
	};
}
