# 阶段 0.3 镜像自动供给验证原型：分块下载与断点续传

> 状态：验证原型通过（单元级机器检查）。尚未接入控制平面 Image Service。
> 日期：2026-11-10
> 对应计划：阶段 0.3（V-IMG：分块下载、续传、校验、原子启用、自定义存储路径）
> 记录任务 ID：`IMG-DOWNLOAD-001`（该 ID 不在 `acceptance-tasks.json` 中，本次未修改该文件）

## 1. 结论

新增 Go 标准库实现 `internal/imagedownload`，证明镜像下载具备以下行为：

- HTTP Range 分块续传；进程重启后可从 `<target>.partial` 恢复；
- 服务器忽略 Range 时安全地从零重下，不伪造续传；
- SHA256 与大小校验通过后才原子 rename 为最终文件；
- 校验失败绝不产生最终文件，坏 partial 被删除；
- 同目标文件并发下载只发起一次 HTTP 请求（进程内互斥/去重）；
- context 取消可中止下载并保留可续传 partial；
- 可配置自定义存储目录、大小上限、重定向上限和进度回调。

本原型只用本地 `httptest` 验证，没有下载真实镜像，也没有访问外部网络。它不接入控制平面，不写数据库，不代表 Windows Host 上的阶段 0 验收已完成。

## 2. 实现

### 2.1 文件

- `internal/imagedownload/downloader.go`：Downloader、Manifest、Result、Progress、错误类型。
- `internal/imagedownload/downloader_test.go`：全部单元测试，使用 `net/http/httptest`。
- `tests/phase0/results/2026-11-10-image-download.json`：本次机器检查结果。
- 本文件：实现说明、命令、结果与边界。

### 2.2 Manifest 与 API

```go
type Manifest struct {
    URL      string // 必须是 http 或 https
    FileName string // 只能是安全的基础文件名，不能包含路径
    Size     int64  // 可选；0 表示未知，正数表示预期字节数
    SHA256   string // 必需；64 位十六进制
}

downloader := imagedownload.New(storageDir)
result, err := downloader.Download(ctx, manifest)
```

`Downloader` 的公开配置：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `StorageDir` | 由调用方传入 | 用户选择的镜像存储目录，按需 `MkdirAll` |
| `MaxSize` | 64 GiB | 单镜像大小上限；0 使用默认，负数表示不限制（不推荐） |
| `MaxRedirects` | 10 | 允许跟随的重定向上限；只允许 http/https |
| `DeletePartialOnError` | false | 传输类失败时是否删除 partial；默认保留以便续传 |
| `Progress` | nil | 进度回调，约 200 ms 节流，首字节和完成时必发 |

`Result` 包含最终路径、大小、SHA256、`AlreadyPresent`、`ResumedFrom`、`RangeIgnored` 和耗时。只有校验通过的最终文件才会产生 `Result`。

### 2.3 下载与启用流程

1. 校验 Manifest：http(s) URL、安全文件名（拒绝路径分隔符、`..`、Windows 非法字符、控制字符、首尾空白、绝对路径）、64 位十六进制 SHA256、非负 Size、Size 不超上限。
2. 将 `StorageDir` 解析为绝对路径并创建目录；最终路径为 `<StorageDir>/<FileName>`，临时文件为 `<最终路径>.partial`。
3. 按最终绝对路径加进程内互斥锁（带引用计数的信号量）。
4. 若最终文件已存在：按 Manifest 校验大小与 SHA256。通过则直接返回 `AlreadyPresent=true`，不再发请求；不通过则删除，绝不保留为可用镜像。
5. 检查 partial：
   - 大于预期大小或大于 `MaxSize`：删除并从头开始；
   - 大小恰好等于已知预期大小：先校验 SHA256，通过则直接 rename 启用（覆盖“写完但 rename 前崩溃”的恢复场景）；失败则删除 partial 并从头开始。
6. 若 partial 非空，发送 `Range: bytes=<offset>-`。
7. 处理响应：
   - `206 Partial Content`：解析并核对 `Content-Range` 的起点、终点和总大小，不符则拒绝；
   - `200 OK` 且请求过分段：判定服务器忽略 Range，截断 partial，从零完整重下，并在 Result/Progress 中标记 `RangeIgnored=true`；
   - `416 Requested Range Not Satisfiable`：删除 partial 并返回 `ErrRangeRejected`，调用方重试时从头开始；
   - 其他非 2xx：返回带状态的 `ErrHTTPStatus`。
8. 以 256 KiB 缓冲流式写入 partial；每块写入前检查 `MaxSize` 和 Manifest Size，超限立即中止并删除 partial；请求显式使用 `Accept-Encoding: identity`，避免自动解压破坏 Range 与哈希语义。
9. 写入完成后 `fsync`，再校验实际大小与 SHA256。
10. 校验通过后 `os.Rename(partial, final)`，partial 与 final 位于同一目录/同一文件系统；随后 best-effort 对目录 fsync。校验失败一律删除 partial，不 rename。

### 2.4 partial 失败策略

| 失败类型 | 行为 |
| --- | --- |
| 网络断开、读写错误、context 取消 | 默认保留 partial，供下次续传；`DeletePartialOnError=true` 时删除 |
| SHA256 不匹配 | 始终删除 partial，返回 `ErrChecksumMismatch` |
| 最终大小不符、服务器发送超过预期、超过 `MaxSize` | 始终删除 partial，返回大小类错误 |
| `Content-Range` 起点/总大小不符、416 | 删除 partial（不可安全续传或服务器拒绝该范围） |
| 非法响应但尚未写入新字节 | 保留 partial，返回 `ErrInvalidResponse`，避免误删仍有效的已下载字节 |
| 已存在的最终文件校验失败 | 先删除旧最终文件，再下载；期间最终路径不存在 |

任何失败路径都不会留下被称为“可用”的最终文件。

### 2.5 并发去重

同一 `Downloader` 实例内，按最终绝对路径维护引用计数的信号量：

- 第一个调用者执行下载；
- 其余同目标调用者等待，随后校验并复用已启用的最终文件（`AlreadyPresent=true`）；
- 测试中 5 个并发调用只产生 1 次 HTTP 请求；
- 不同目标路径互不阻塞。

注意：这是进程内去重，不是跨进程文件锁。两个独立进程同时下载同一目标尚未纳入本原型。

## 3. 命令与测试结果

执行日期：2026-11-10；Go 版本：`go1.26.4 linux/amd64`。

```text
$ go test ./internal/imagedownload/ -v -count=1
--- PASS: TestDownloadSuccessVerifyAndReuse (0.01s)
--- PASS: TestResumeAfterInterruptedTransfer (0.00s)
--- PASS: TestRangeIgnoredRestartsFromZero (0.00s)
--- PASS: TestWrongContentRangeDoesNotCorruptPartial (0.00s)
--- PASS: TestChecksumMismatchLeavesNoFinalFile (0.00s)
--- PASS: TestContextCancellationKeepsResumablePartial (0.00s)
--- PASS: TestConcurrentSameTargetDownloadsOnce (0.04s)
--- PASS: TestCompletePartialIsPromotedWithoutNetwork (0.00s)
--- PASS: TestManifestValidation (0.00s)
--- PASS: TestMaxSizeEnforcedDuringStream (0.00s)
--- PASS: TestDeclaredSizeMismatchRejectedBeforeWriting (0.00s)
--- PASS: TestRedirectLimit (0.00s)
--- PASS: TestDeletePartialOnErrorPolicy (0.00s)
PASS
ok  	agent-in-box/internal/imagedownload	0.058s
```

`TestManifestValidation` 内含 16 个非法 Manifest 子测试，全部通过。

```text
$ go vet ./internal/imagedownload
(无输出，退出码 0)

$ GOOS=windows GOARCH=amd64 go vet ./internal/imagedownload
(无输出，退出码 0；仅交叉编译检查，未在 Windows 上运行)

$ go test ./internal/imagedownload/ -race -count=1
ok  	agent-in-box/internal/imagedownload	1.127s
```

### 3.1 需求到测试映射

| 验证目标 | 测试 |
| --- | --- |
| 正常下载、大小与 SHA256 校验、进度、已存在最终文件复用 | `TestDownloadSuccessVerifyAndReuse` |
| 中途断开后从已有 partial 续传（新 Downloader 模拟应用重启） | `TestResumeAfterInterruptedTransfer` |
| 服务器忽略 Range 时安全从零重下 | `TestRangeIgnoredRestartsFromZero` |
| 服务器返回错误 206 范围时不向 partial 错位追加 | `TestWrongContentRangeDoesNotCorruptPartial` |
| SHA256 不匹配时不产生最终文件，且删除坏 partial | `TestChecksumMismatchLeavesNoFinalFile` |
| context 取消，保留可续传 partial | `TestContextCancellationKeepsResumablePartial` |
| 同目标并发去重，只发 1 次 HTTP 请求 | `TestConcurrentSameTargetDownloadsOnce` |
| 写完但 rename 前崩溃的恢复 | `TestCompletePartialIsPromotedWithoutNetwork` |
| 路径穿越/非法文件名/SHA/URL/负大小拒绝 | `TestManifestValidation` |
| 流式大小上限 | `TestMaxSizeEnforcedDuringStream` |
| 声明的 Content-Length 与 Manifest 不符 | `TestDeclaredSizeMismatchRejectedBeforeWriting` |
| 重定向上限 | `TestRedirectLimit` |
| `DeletePartialOnError=true` 的删除策略 | `TestDeletePartialOnErrorPolicy` |

## 4. 结果记录

`tests/phase0/results/2026-11-10-image-download.json` 使用现有 `result-schema.json` 字段，`taskId=IMG-DOWNLOAD-001`。`acceptance-tasks.json` 中没有该任务，本次未修改 `acceptance-tasks.json`；该结果属于阶段 0.3 原型机器检查，不是正式验收任务的替代。

## 5. 边界与未解决问题

- **尚未接入控制平面 Image Service**：没有 Manifest 注册、数据库状态、下载队列、HTTP API、UI 状态或“已验证/可用”标记。本包只提供下载核心。
- **未做真实镜像下载**：全部测试使用本地 `httptest` 与合成字节；没有访问官方镜像源，也没有验证真实 CDN 的 Range 行为、签名 URL 和限速。
- **未在 Windows 文件系统上运行**：交叉编译/vet 通过，但原子 rename、杀进程后的 partial 恢复和目录 fsync 只在 Linux/WSL2 上实测。Windows 上的断电/崩溃一致性仍需真实 Host 验证。
- **跨进程互斥缺失**：并发去重仅限单个 `Downloader` 实例/进程；多进程或多服务实例同时下载同一目标需要后续文件锁或上层调度。
- **无自动重试/退避/限速**：调用方负责重试策略；本包不会对 5xx 或断线自动重试，也不会限制带宽。
- **续传只支持单段**：仅 `bytes=N-`，不支持 multipart range；没有保存 ETag/Last-Modified，也不发送 `If-Range`。
- **远端对象可能在续传期间变化**：若长度相同但内容变化，续传后会 SHA256 不匹配，partial 被删除，下次需从头下载；这是安全的，但不是最省流量的做法。
- **Size 未知时的完整 partial**：已知大小为零（未知）时无法仅凭本地大小判断 partial 已完成；若服务器对 `bytes=N-` 返回 416，本包删除 partial 并返回显式错误，调用方需重试。
- **大小上限是保护性默认值**：默认 64 GiB，需根据实际镜像目录调整；本阶段未确定最终镜像清单与大小。
- **未验证 Windows 镜像可用性**：本原型没有下载 Windows 镜像，也没有创建 Windows VM；即使未来提前下载，也不得在界面或日志中标记为已验证 VM。
