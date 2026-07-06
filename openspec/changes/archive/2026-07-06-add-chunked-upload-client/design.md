## Context

服务端五接口已实现（gitruck-infra `add-chunked-resumable-upload`，待部署）：init（可秒传）/ PUT part（raw octet-stream + 可选 `?blake3=`）/ status（缺片列表）/ complete（与单发同构 FileResponse）/ abort；错误码 6024–6028；`part_size` 服务端定值 32MiB 由 init 下发。CLI 现状：`uploadCached`（指纹缓存）→ `uploadFile`（单发流式，≥4GiB 截断 bug 已修待发）。CLI 无测试框架、bun 构建（本机无 bun，esbuild 等价验证）。

## Goals / Non-Goals

**Goals**：大文件断点只补缺片；重跑命令即恢复；秒传省整传；对上层命令与 `--json` 契约零感知。
**Non-Goals**：见 proposal 非目标；另不做上传器抽象层（两条路径各自直写，避免过度设计）。

## Decisions

**D1 路由阈值 256MiB 定值。** 单发流式对中小文件已稳（几秒内完成，碰不到任何超时）；256MiB 起分片收益（断点/并行）才明显。不做 env 可调——阈值语义属实现细节，客户端从 init 响应拿 `part_size` 本就与阈值解耦，将来要调改常量即可。

**D2 秒传指纹用 `hash-wasm`，逐字节复刻服务端 fast_mode 怪癖。** 服务端循环是「读 8192 → 计数 +8192 → 计数≥64MiB 则 break（该块不哈希）→ 哈希」，即大文件实际哈希 **67,100,672 字节（64MiB−8KiB）而非 64MiB**。客户端 MUST 复刻同一循环（含该 off-by-one-block 行为），否则指纹永不命中（安全降级但秒传全废）。选 `hash-wasm`：纯 WASM 零原生编译、内嵌 base64 可被 bun/esbuild 打包；指纹失败降级为无指纹 init（try/catch 一处，不阻断）。**风险自担点：服务端若未来改 fast_mode 口径，客户端秒传静默失效（不报错、只退化为实传）——两侧 spec 已互相锁定该算法。**

**D3 会话持久化独立文件 `upload-sessions.json`（不并入 upload-cache.json）。** cache 是「已完成上传」的稳定映射，session 是易失的进行中状态——混在一个文件里会让 cache 的"成功后才写"不变式变糊。同目录独立文件、同样损坏当空处理。

**D4 分片读取用 `FileHandle.read` 定长切片（非流拼接）。** 每片 32MiB 定长（末片余数），`fh.read(buf, 0, len, index*partSize)` 精确定位；并行度 3 → 峰值内存 ~96MiB，可接受。不用 stream slice：offset 语义直白、重试天然幂等（重读即重传）。

**D5 重试分类照 spec 表。** 会话级重建**最多一次**（`CHUNK_SESSION_NOT_FOUND` 场景），防云端异常时死循环；complete 的 `CHUNK_INCOMPLETE` 补片至多 2 轮。所有非分片类业务码立即失败——与单发上传"业务拒绝不重试"口径一致。undici 超时不做任何调整：32MiB/片在任何现实带宽下远小于 300s 默认值，这正是分片方案優于 timeout hack 的理由。

**D6 测试：node:test + 进程内 mock 服务端。** 本仓无框架、无 bun，引入测试框架超范围。esbuild 把 `chunk-upload.ts` 打成临时 ESM，`node --test` 跑 `test/chunk-upload.test.mjs`：mock 服务端用 `node:http` 实现五接口内存版（含 6024/6026/6027 注入开关），离线覆盖分片数学/断点/重试/秒传/会话重建。指纹对齐用例以服务端算法的 Python 参考值做黄金断言（预生成向量写死在测试里）。真机 E2E 留给部署后（与 4.37GB 毛片同跑）。

## Risks / Trade-offs

- [并行 3 片 × 32MiB 内存 ~96MiB] → 可接受；不做可调并发（YAGNI）。
- [会话文件与云端 TTL 漂移] → status 是唯一真相，本地记录只是"去问一下"的线索；6024 即弃。
- [秒传指纹算法漂移]（见 D2）→ 静默退化为实传，功能不坏；跨仓 spec 互锁提醒。
- [complete 内容去重使 --reupload 无法真正替换云端同内容文件] → 与单发上传现状一致，非本 change 引入。

## Migration Plan

纯客户端增量：发 npm 新版本即生效；旧版本 CLI 继续走单发不受影响。回滚 = 回退版本。联调依赖服务端 `add-chunked-resumable-upload` 先部署。

## Open Questions

（无——阈值/并行度/重试预算均已定值，运行数据回来后再议是否要调。）
