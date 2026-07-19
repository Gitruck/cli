/**
 * MAD 引擎共享类型（add-tool-mad）。
 * 池条目字段口径见 design D3；manifest schema 契约以 gitruck-infra add-mad-content-api 为准。
 */

/** 技法池条目（build_mad_pool.py 预计算产物，随 manifest 分发；字段口径 design D3）。 */
export interface PoolEntry {
	/** 技法唯一 id（也是 IR 引用键）。 */
	uid: string;
	/** pattern id（同片去重维度）。 */
	pid: string;
	/** 类目（10 类之一，轮转维度）。 */
	cat: string;
	/** 源档位：四值枚举（NV 并 AM 档优先、剪映并 AE 档降权）。 */
	format: "am" | "ae" | "剪映" | "nv";
	/** 置信度（池口径 = high）。 */
	conf: string;
	/** 动作强度（池口径 ∈ {live, full}）。 */
	motion: string;
	/** 钳后窗口起点（秒）。 */
	t0: number;
	/** 钳后窗口终点（秒）。 */
	t1: number;
	/** 窗内 slot 数（≥1）。 */
	slot: number;
	/** 经典度（加权抽样正向）。 */
	n_seen: number;
	/** 工程画布宽。 */
	w: number;
	/** 工程画布高。 */
	h: number;
	/** 工程画布帧率。 */
	fps: number;
	/** IR 引用键（工程 uid；分片内按此取工程 IR，与 uid 分离——一工程可含多技法窗）。 */
	ir: string;
	/** IR 所在分片键（数据获取层按此拉取重资产）。 */
	shard: string;
	/** 窗内未映射 fx 占比（加权抽样降权）。 */
	unmapped_fx_ratio: number;
}

/** manifest 数据集条目（infra 契约：完整绝对 URL + 校验字段）。 */
export interface ManifestDataset {
	url: string;
	version: number;
	size: number;
	sha256: string;
}

/** manifest（GET /task/mad/manifest 出参，infra 契约）。 */
export interface MadManifest {
	/** 当前生效版本（单调递增整数）。 */
	version: number;
	/** 各数据集清单（key ∈ {catalog, projects_index, techniques_index, patterns, mad_pool}）。 */
	datasets: Record<string, ManifestDataset>;
	/** 静态重资产基址（HTTPS，形如 .../mad_wiki/v{n}）。 */
	assets_base: string;
}

/** 用户素材（扫描 + ffprobe 后）。 */
export interface UserVideo {
	path: string;
	width: number;
	height: number;
	duration: number;
}

/** 母合成朝向。 */
export type Orientation = "landscape" | "portrait";

/** beat 降级档位（① 全量卡点 / ② 有 BGM 无卡点 / ③ 无 BGM）。 */
export type DegradeLevel = 1 | 2 | 3;
