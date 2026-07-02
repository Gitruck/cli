## Why

服务端已上分片上传/断点续传接口（gitruck-infra change `add-chunked-resumable-upload`，五接口 `/base/file/upload/chunk/*`），但 CLI 仍只会单发 `POST /base/file/upload`：多 GB 毛片一条长请求扛全程，断一次全重传。CLI 是该接口的第一消费方——接入后大文件断点只补缺片、每个请求秒级（32MiB/片），客户端超时问题（undici 默认 300s）自然消解，无需任何 timeout hack。

## What Changes

- **按大小自动分流**：`uploadCached` 内部按文件大小路由——小于阈值（256MiB）维持现有单发流式上传**零改动**；达到阈值走分片闭环 init → 并行 part → complete。
- **新增 `src/lib/chunk-upload.ts`**：分片上传客户端（init/part/status/complete/abort 五接口封装、并行度 3 的分片池、单片有界重试、会话级一次性重建）。
- **断点续传持久化**：`~/.gtrk-cli/upload-sessions.json`（与 upload-cache 同目录、独立文件）记录 指纹→进行中会话（upload_id 等）；重跑命令时先 `GET status` 拿缺片列表只补缺片，会话失效（6024）则自动重开。
- **秒传指纹**：init 前用 `hash-wasm`（新依赖，纯 WASM Blake3）算与服务端 `GetBlake3 fast_mode` **逐字节一致**的指纹（8192 字节/块、计数达 64MiB 即停且该块不入哈希 → 实际哈希前 67,100,672 字节）随 init 发送；命中未过期同内容文件零字节秒传。
- **单片完整性**：每片附 `?blake3=`（整片 Blake3），服务端校验不符自动重传该片。
- **进度可见**：分片上传用现有 `log.tick` 原地刷新（`--json` 模式自动走 stderr，stdout 机读契约不变）。
- **`--reupload` 语义顺延**：跳过本地缓存 + 跳过会话续传 + 不发秒传指纹（服务端 complete 的内容去重仍可能命中，与单发上传现状一致）。
- 结果 JSON、`files`/`report` 等对外输出**完全不变**——上传路径对上层（oralcut 等命令）透明。

## Capabilities

### New Capabilities

- `chunked-upload-client`：CLI 大文件分片上传/断点续传/秒传客户端行为契约。

### Modified Capabilities

（无——本仓首个 OpenSpec change，无既有 capability）

## Impact

- **代码**：新增 `src/lib/chunk-upload.ts`；`src/lib/upload-cache.ts` 加大小路由与会话存取；`src/lib/cloud.ts` 导出既有 `parseJson` 供复用（单发上传逻辑不动）。
- **依赖**：新增 `hash-wasm`（纯 WASM、无原生编译、可被 bun/esbuild 打包）。
- **服务端契约**：只消费 gitruck-infra `add-chunked-resumable-upload` 已定义的五接口与错误码（6024–6028），无服务端改动诉求；两 change 的 proposal 互链。
- **文档**：AGENT.md 上传章节补分片/断点续传/秒传说明。
- **测试**：本仓无测试框架 → 新增 `test/` 下 node 原生 `node:test` 脚本 + 进程内 mock 服务端（实现五接口的内存版），离线验证分片数学/断点/重试/秒传；真机 E2E 等服务端部署后与 4.37GB 毛片一起跑。

### 非目标（刻意不做）

- 不改单发上传路径（小文件继续走它；其 ≥4GiB 截断修复已在工作区，随本 change 一起发版）。
- 不做多文件并行上传编排（单文件内分片并行已够；上层一次只传一条毛片）。
- 不做上传限速/暂停恢复 UI（CLI 场景 Ctrl+C 即暂停，重跑即恢复）。
- 不动 `gtrk oralcut` 等命令的参数面与结果 JSON 契约。
