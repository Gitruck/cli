/**
 * 按 AI Drama Desk 的**项目 id** 解析出回轨导出包目录。
 *
 * 立命之本：**本模块里不允许出现任何目录遍历**（readdir / glob / walk / opendir）。
 * 它存在的全部理由就是让「id → 路径」有一条合规的路走——2026-09-18 真机里，执行方
 * 因为没有这条路而跑了一次跨盘全量 find，那违反了 desk 仓 `agent-project-handoff`
 * 「仓库定位只在必要时发生」。路通了，纪律才立得住；这里自己再开一个后门就全白做了。
 *
 * 两条确定性路径，按序：
 *   ① 服务可达 → GET <deskUrl>/api/v1/projects/<id>，取 `exportDir`
 *      （**字段缺席 = 尚未导出**，不是「再想想办法」）
 *   ② 服务不可达 → 读 ~/.gitruck/ai-drama-desk.json 的 instances[]，逐条试
 *      <projectsDir>/<id>/exports/aidrama
 * 两条都不可用就报错并给出路，不再扩大范围。
 *
 * 读取面（HTTP、文件）以参数注入，便于单测不起真服务、不碰真 ~/.gitruck。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_DESK_URL = "http://127.0.0.1:7799";

/** 与 desk 侧 `server/lib/desk-pointer.ts` 的结构对齐；对侧改了这里要同批改。 */
export interface DeskInstance {
  dataRoot: string;
  projectsDir: string;
  port?: number;
  buildId?: string;
  lastSeenAt?: number;
}

export type DeskResolveVia = "api" | "pointer";

export interface DeskResolved {
  projectId: string;
  packageDir: string;
  via: DeskResolveVia;
}

export class DeskResolveError extends Error {
  constructor(
    message: string,
    readonly projectId: string,
    /** 已经查过的数据根。零命中时报给用户——「它在另一个部署里」只能靠这个看出来。 */
    readonly searchedRoots: string[] = [],
  ) {
    super(message);
    this.name = "DeskResolveError";
  }
}

export interface DeskLocateDeps {
  /** 取 JSON；网络不可达等一律返回 null（不抛），由调用方决定降级。 */
  fetchJson: (url: string) => Promise<Record<string, unknown> | null>;
  readPointer: () => DeskInstance[];
  exists: (p: string) => boolean;
}

export function pointerPath(): string {
  const override = process.env.GITRUCK_DESK_POINTER_PATH;
  return override ? resolve(override) : join(homedir(), ".gitruck", "ai-drama-desk.json");
}

export function deskUrl(): string {
  const raw = process.env.GITRUCK_AI_DRAMA_DESK_URL?.trim();
  return (raw || DEFAULT_DESK_URL).replace(/\/+$/, "");
}

/**
 * 这个响应来自**带路径面的构建**吗？
 *
 * 判据取 `dir` 而不是 `exportDir`：前者在新构建里对任何项目**恒有**，后者按导出包是否存在缺席。
 * 拿 `exportDir` 判会把「老服务没这功能」与「新服务说没导出」混成一件事——真机已经栽过一次。
 */
function hasPathSurface(body: Record<string, unknown>): boolean {
  return typeof body.dir === "string" && !!body.dir;
}

/** 导出包目录的口径必须与 desk 侧一致：`<projectsDir>/<id>/exports/aidrama`。 */
export function packageDirUnder(projectsDir: string, projectId: string): string {
  return join(projectsDir, projectId, "exports", "aidrama");
}

export function defaultDeps(): DeskLocateDeps {
  return {
    fetchJson: async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return null;
        return (await res.json()) as Record<string, unknown>;
      } catch {
        // 服务没起 / 连不上 / 超时，一律当「这条路不通」，交给落脚点那条
        return null;
      }
    },
    readPointer: () => {
      const file = pointerPath();
      if (!existsSync(file)) return [];
      try {
        const raw = JSON.parse(readFileSync(file, "utf-8")) as { instances?: unknown };
        if (!Array.isArray(raw.instances)) return [];
        return raw.instances.filter(
          (x): x is DeskInstance =>
            !!x && typeof (x as DeskInstance).projectsDir === "string" && !!(x as DeskInstance).projectsDir,
        );
      } catch {
        return [];
      }
    },
    exists: existsSync,
  };
}

/**
 * 解析单个项目 id。
 *
 * 存在性判据用 `manifest.json` 而非目录——与 desk 侧同一判据：导出一开始就会
 * mkdir 出目录，拿目录判会把「导到一半」误报成「已导出」。
 */
export async function resolveDeskProject(
  projectId: string,
  deps: DeskLocateDeps = defaultDeps(),
): Promise<DeskResolved> {
  // ① API
  const body = await deps.fetchJson(`${deskUrl()}/api/v1/projects/${encodeURIComponent(projectId)}`);
  if (body) {
    const dir = body.exportDir;
    if (typeof dir === "string" && dir) return { projectId, packageDir: dir, via: "api" };
    // ⚠️ 「没有 exportDir」有两种完全不同的含义，**MUST NOT 混为一谈**：
    //   (a) 新构建 + 这个项目确实还没导出 ⇒ 确定的答案，报出来即可；
    //   (b) 旧构建**压根没有路径面** ⇒ 这条路不通，应当降级走落脚点。
    // 2026-09-18 真机撞到过 (b)：在跑的打包版是路径面上线前的构建，三个**已导出**的项目
    // 被判成「尚未导出」。判据用 `dir`——它在新构建里**恒有**（不像 exportDir 会按存在性缺席），
    // 所以「连 dir 都没有」就是老服务，此时缺席不可采信。
    if (hasPathSurface(body)) {
      throw new DeskResolveError(
        `项目 ${projectId} 在工作台里还没有导出回轨包（服务已应答但未给出导出目录）。请先在工作台点「导出回轨包」。`,
        projectId,
      );
    }
    // 落到这里 = 老服务。不报错、不猜，继续走落脚点那条路。
  }

  // ② 落脚点
  const instances = deps.readPointer();
  if (instances.length === 0) {
    throw new DeskResolveError(
      `无法解析项目 ${projectId}：工作台服务不可达（${deskUrl()}），且落脚点 ${pointerPath()} 不存在或为空。\n` +
        `出路二选一：① 启动 AI Drama Desk 后重试；② 直接用 --package 传导出包目录。`,
      projectId,
    );
  }
  const hits: string[] = [];
  const searched: string[] = [];
  for (const inst of instances) {
    searched.push(inst.dataRoot || inst.projectsDir);
    const dir = packageDirUnder(inst.projectsDir, projectId);
    if (deps.exists(join(dir, "manifest.json"))) hits.push(dir);
  }
  if (hits.length === 1) return { projectId, packageDir: hits[0]!, via: "pointer" };
  if (hits.length > 1) {
    throw new DeskResolveError(
      `项目 ${projectId} 在多个数据根下都存在，无法判定用哪一个：\n${hits.map((h) => `  · ${h}`).join("\n")}\n` +
        `请用 --package 明确指定其中一个。`,
      projectId,
      searched,
    );
  }
  throw new DeskResolveError(
    `落脚点记录的数据根里都没有项目 ${projectId} 的导出包。已查过：\n${searched.map((r) => `  · ${r}`).join("\n")}\n` +
      `它可能属于另一个部署（源码运行与打包安装的数据根不同），也可能还没导出。` +
      `出路：启动那个部署的工作台后重试，或直接用 --package 传路径。`,
    projectId,
    searched,
  );
}
