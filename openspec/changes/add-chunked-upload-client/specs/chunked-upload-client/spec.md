## ADDED Requirements

### Requirement: 按大小自动分流上传路径

`uploadCached` MUST 按文件大小自动路由：`size < CHUNK_THRESHOLD`（256MiB）走既有单发流式上传（行为逐字节不变）；`size >= CHUNK_THRESHOLD` 走分片闭环。路由对调用方（oralcut 等命令）透明——返回值仍为 `{fileId, cached}`，本地指纹缓存（`upload-cache.json`）读写语义不变（成功后才写）。

#### Scenario: 小文件走单发
- **WHEN** 上传 10MB 文件
- **THEN** 走 `POST /base/file/upload` 单发路径，分片模块零介入

#### Scenario: 大文件走分片
- **WHEN** 上传 4.37GB 毛片
- **THEN** 走 init → 并行 part → complete，最终返回 `file_id` 并写入本地指纹缓存

---

### Requirement: 秒传指纹与服务端逐字节对齐

分片路径 init 前 MUST 计算与服务端 `GetBlake3.get_raw_file_blake3(fast_mode=True)` **逐字节一致**的 Blake3 指纹并随 init 发送：按 8192 字节/块顺序读，每读一块计数 +8192，**计数 ≥ 64MiB 时立即停止且该块不入哈希**（即大文件实际哈希前 67,100,672 字节；小于该长度的文件哈希全文）。指纹计算失败（如 WASM 初始化异常）MUST 降级为不带 `blake3_id` 的 init，不阻断上传。init 响应含 `instant: true` 时 MUST 直接采用返回的 `file_id`，零字节上传。

#### Scenario: 秒传命中
- **WHEN** 云端存在未过期同内容文件，CLI 带指纹 init
- **THEN** 拿到 `instant: true` + `file_id`，不传任何分片，本地缓存照常写入

#### Scenario: 指纹算法对齐
- **WHEN** 对同一文件分别用 CLI 实现与服务端 `get_raw_file_blake3(fast_mode=True)` 计算
- **THEN** 两侧 hex 结果完全一致（含"阈值块不入哈希"的边界行为）

---

### Requirement: 断点续传会话持久化

进行中的分片会话 MUST 持久化到 `~/.gtrk-cli/upload-sessions.json`（键 = 与 upload-cache 相同的 `size:mtimeMs` 指纹，值含 `uploadId/partSize/totalParts/path/createdAt`）。再次上传同一文件时 MUST 先 `GET status`：会话有效则**只补缺片**后 complete；会话已失效（`CHUNK_SESSION_NOT_FOUND`）则清掉本地会话记录、重新 init 整传（**最多重建一次**，防死循环）。complete 成功或 abort 后 MUST 清除会话记录。

#### Scenario: 中断后重跑只补缺片
- **WHEN** 上传 131 片中的 100 片后进程被杀，用户重跑同一命令
- **THEN** CLI 读到本地会话 → status 返回缺 31 片 → 仅上传这 31 片 → complete 成功

#### Scenario: 会话过期自动重建
- **WHEN** 本地会话记录存在但云端会话已过 TTL
- **THEN** status 返回 `CHUNK_SESSION_NOT_FOUND`，CLI 清本地记录、重新 init 并整传，全程不需人工干预

---

### Requirement: 分片并行、完整性与重试分类

分片上传 MUST 以固定并行度（3）推进；每片 MUST 附 `?blake3=`（该片整片 Blake3）供服务端校验。单片失败按错误分类处理：

| 错误 | 处理 |
|---|---|
| 网络层（fetch failed / ECONNRESET / 5xx / 502-504） | 该片退避重试（2/4/8s，至多 3 次），超限抛错 |
| `CHUNK_CHECKSUM_MISMATCH` / `CHUNK_PART_INVALID` | 该片立即重传（计入同一重试预算） |
| `CHUNK_SESSION_NOT_FOUND` | 中止本轮，走"会话重建一次"流程 |
| 其他业务码（如 `FILE_TYPE_NOT_SUPPORTED`） | 立即失败上抛，不重试 |

complete 返回 `CHUNK_INCOMPLETE` 时 MUST 重新 status → 补缺片 → 再 complete（至多 2 轮）。

#### Scenario: 单片网络抖动自愈
- **WHEN** 某片第一次 PUT 遇 502
- **THEN** 该片退避重传成功，整体上传不中断、其余并行片不受影响

#### Scenario: 业务拒绝不重试
- **WHEN** 服务端返回非分片类业务错误
- **THEN** 立即失败并把服务端 msg 原样上抛，不做任何重试

---

### Requirement: 进度可见与输出契约不变

分片路径 MUST 用 `log.tick` 原地刷新进度（已收片数/总片数）；`--json` 模式下人读日志走 stderr、stdout 仍只输出最终一行结果 JSON（既有机读契约逐字段不变）。

#### Scenario: --json 模式 stdout 纯净
- **WHEN** `gtrk oralcut <4.37GB毛片> --json` 走分片上传
- **THEN** stdout 仅最终结果 JSON 一行；分片进度全部在 stderr

---

### Requirement: --reupload 顺延分片语义

`--reupload` MUST 同时跳过：本地指纹缓存命中、本地会话续传、init 秒传指纹（不发 `blake3_id`）——强制真实整传。服务端 complete 的内容级去重仍可能返回既有 `file_id`（与单发上传现状一致，不属本仓可控范围）。

#### Scenario: --reupload 强制整传
- **WHEN** 带 `--reupload` 上传本地缓存/会话/云端指纹均命中的文件
- **THEN** CLI 忽略三者、从第 0 片开始整传
