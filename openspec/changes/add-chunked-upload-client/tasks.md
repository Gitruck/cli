## 1. 依赖与基础

- [x] 1.1 `package.json` 增依赖 `hash-wasm`（dependencies）+ devDep `esbuild` + `npm test` 脚本；`.test-build/` 入 .gitignore
- [x] 1.2 `src/lib/cloud.ts` 导出 `parseJson`/`ApiResp`（供 chunk-upload 复用同一 {code,msg,data} 解析），单发上传逻辑零改动（顺带修正其 body 类型声明，运行时不变）

## 2. 分片客户端（src/lib/chunk-upload.ts 新增）

- [x] 2.1 `fastBlake3(path)`：逐字节复刻服务端 fast_mode（8192/块、计数达 64MiB 停且该块不哈希 → 实哈希 67,100,672 字节）；失败返 undefined 降级无指纹 init
- [x] 2.2 五接口封装（init/part/status/complete/abort 中前四个，abort 客户端暂无调用场景未封装——会话废弃走云端 TTL + 服务端清扫兜底）；part 用 `FileHandle.read` 定长切片 + `?blake3=` 整片校验
- [x] 2.3 并行度 3 分片池 + 重试分类（网络/校验类退避重试 3 次〔2/4/8s〕；6024 会话重建一次；其他业务码立即失败）；complete 的 6027 补片至多 2 轮
- [x] 2.4 `log.tick` 进度（已收/总片+百分比），`--json` 下自动走 stderr（沿用 routeLogsToStderr 机制）

## 3. 路由与会话（src/lib/upload-cache.ts）

- [x] 3.1 会话存取 `fileSessionStore`：`~/.gtrk-cli/upload-sessions.json`（指纹→{uploadId,...}），损坏当空；complete/秒传后清除
- [x] 3.2 `uploadCached` 按 size ≥ 256MiB 路由到分片路径；`--reupload`（force）跳过缓存+会话+秒传指纹；返回值与缓存写入语义不变

## 4. 测试（test/chunk-upload.test.mjs，node:test + mock 服务端，13/13 全绿）

- [x] 4.1 mock 服务端（node:http 内存版五接口，故障注入：502 一次性、6026 一次性、complete 前丢片→6027、秒传指纹开关）
- [x] 4.2 用例：分片数学（末片余数/单片文件）、全新上传字节级还原+会话清理、断点续传只补缺 3 片（PUT 计数断言）、会话过期重建一次（init 计数=1）、单片 502 退避自愈、6026 校验不符重传、6027 补片自愈、秒传零上传零会话、--reupload 三跳过、业务拒绝（6001）不重试、阈值常量
- [x] 4.3 指纹对齐黄金用例：小文件（1000B 全文哈希）与大文件（68MB 含截断怪癖）两个向量，与服务端 Python `get_raw_file_blake3(fast_mode=True)` 实算输出逐字节一致
- [x] 4.4 `tsc --noEmit` 通过；esbuild 全量构建（dist，hash-wasm 打包正常）；`gtrk doctor` 冒烟全绿

## 5. 文档

- [x] 5.1 AGENT.md 上传章节补：大文件自动分片、断点续传（重跑即恢复）、秒传、`--reupload` 新语义、chunk-upload.ts 模块指引

## 6. 联调与发版（等服务端部署后）

- [x] 6.1 真机 E2E 通过（2026-07-02）：4.37GB→131 片；传 25 片模拟中断 → 重跑自动续传"云端已有 25/131 片，补 106 片"（putOk=106，100.7s）→ complete 去重返回既有 file_id；清会话后重跑秒传 0.89s 零字节命中同 file_id；该 file_id 提交 video_oral_cut 成功出片
- [ ] 6.2 bun build + npm publish 新版本（连同已修的单发 ≥4GiB 截断 fix 一起发）
