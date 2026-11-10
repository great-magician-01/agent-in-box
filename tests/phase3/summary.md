# 阶段 3 验收记录：镜像和 VM 生命周期

> 实现日期：2026-11-10 ～ 2026-11-11  
> 状态：代码主链路、自动化测试和本机服务 Smoke 已完成；真实 QEMU/WHPX 的阶段 3 回归、Windows NSIS 干净环境验收仍需在具备对应资产的环境中执行。  
> 机器结果：[`results/2026-11-10-smoke.json`](results/2026-11-10-smoke.json)

## 1. Image Service

已实现：

- Manifest schema、来源白名单、Linux/Windows 工件元数据和不可变版本 ID；
- 控制平面 `GET /api/v1/images`、`POST /manifest/refresh`、下载与取消接口；
- 流式下载、HTTP Range 续传、手动重定向检查、大小上限、SHA-256 校验；
- 写入 `<image>.partial`，只有完整校验通过才原子改名，Available 必须同时具有 `verifiedAt` 和本地路径；
- 同一镜像的进程内并发请求去重；Available 镜像再次请求不访问网络；
- 取消保留断点；校验/大小失败删除不可信数据；失败包含错误码和诊断；
- 数据库进度与 `GET /api/v1/images/events` SSE 事件；
- 应用重启后发现 `downloading/verifying` 记录并自动从现有 partial 恢复；
- 同一版本 ID 的工件定义发生变化时拒绝刷新；更新必须使用新 ID/文件名，不覆盖使用中版本；
- 内置阶段 0 Ubuntu 24.04 基线；`AGENT_IN_BOX_IMAGE_MANIFEST` 可指定部署自己的 JSON Manifest。内置源使用记录时的固定哈希，若上游 `current` 已变化会安全校验失败，部署应提供新的不可变版本条目。

对应自动化证据：

- 并发下载只产生一次 HTTP 请求；
- 新服务实例使用 `Range: bytes=N-` 恢复真实 HTTP 传输；
- 取消后 final 文件不存在、partial 保留；
- 错误 SHA-256 不进入 Available；
- 原版本定义被修改时拒绝，旧校验文件保持不变。

## 2. VM Supervisor 与 QEMU Provider

已实现：

- `Create / Start / Stop / Suspend / Resume / State / Console` 和 VM 列表 API；
- QMP 固定 `stop` / `cont` 命令，不暴露任意命令执行；
- QEMU 进程 PID、QMP 状态和持久化 `vm.json` 对账；新 Supervisor 实例可识别已有 VM；
- 按 VM 操作锁、操作超时、结构化 JSON 错误和 slog 日志；
- Start/Stop/Suspend/Resume 幂等语义；Start 遇到 suspended VM 不会伪报 running，也不会隐式恢复；
- 独立 qcow2 覆盖盘、VirtIO 磁盘/网络/GPU/Tablet、回环 VNC/QMP/SSH/Guest Agent 转发；
- 默认读取与控制平面相同的 `app-config.json` 自定义数据根目录；环境覆盖和显式 CLI 仍可用；
- 所有 `/api/v1/*` 需要文件支持的随机 Bearer ACL 令牌；无/错令牌返回 401；
- 仅允许回环监听；令牌不进入日志；Supervisor 不注册 DELETE 路由，自动任务无通用 Supervisor 工具面。

注意：ACL 文件在 Unix 使用 0600；Windows 依赖用户配置/数据目录继承的本机用户 ACL。当前 Supervisor 是独立 Go 进程，Electron 自动托管与打包 Go 二进制不属于本次 Smoke 的验证范围。

## 3. Linux Guest 与控制平面

已实现：

- 仅 Available Linux 镜像可创建 VM；Windows 镜像可下载但本阶段不能创建 Windows VM；
- 保存 CPU、内存、磁盘档位、独立 VM 存储目录、创建时间和最近启动时间；
- 创建不自动启动；停止保留磁盘、配置、项目绑定和任务引用；
- 没有固定 VM 数量上限；
- 每次状态读取与真实 Supervisor/QMP 对账；元数据缺失或操作失败不会被标为 Ready；
- 运行中的 VM 通过回环转发的 Guest Agent `/healthz` 独立探测；QMP running 不等于 Guest healthy；
- 电源变化写入 SQLite 和 Outbox；
- VM 视图聚合绑定项目、当前任务和实际目录占用。

真实 QEMU 集成入口保留在 `internal/vmprovider/qemu_integration_test.go`，现已覆盖休眠、休眠后 Start 对账和恢复。该测试默认跳过，必须显式提供 QEMU、已校验基础镜像、临时 VM 目录，并可提供阶段 0 NoCloud Seed。当前执行环境未找到这些资产，因此本次没有生成新的真实 WHPX 成功记录。

## 4. VM 管理 UI

已实现：

- 镜像状态、版本、架构、大小、下载进度、错误诊断、取消和 Manifest 刷新；
- Available Linux 镜像选择与创建表单，CPU/内存/磁盘校验和资源建议；
- VM 名称、Linux 系统、资源、存储路径、覆盖盘、实际占用、绑定项目和当前任务；
- “已拥有”和“正在运行”分别展示；电源与 Guest Health 不混用；
- 创建、启动、优雅/强制停止、休眠、恢复和控制台入口；
- 强制停止明确提示未保存数据风险；没有删除按钮；
- Supervisor 离线时保留持久化记录并标注“最后已知”，禁用实时操作；
- SSE 实时进度加轮询兜底；运行中 VM 每 2 秒对账；卸载关闭事件流。

控制台目前显示仅回环的 VNC 地址。实时 noVNC 画面、人工输入与统一 Execution Lease 属于阶段 4，本阶段没有伪造内嵌控制台。

## 5. 实际执行结果

### 全仓检查

```text
pnpm check
```

通过：ESLint、全部 TypeScript 类型检查、**129 个 Vitest 测试通过**、Go test、全部 TypeScript/Web/Go 构建。另有 4 个显式跳过：1 个需要真实 Pi 的集成测试，3 个依赖 Unix 符号链接/权限语义的阶段 2 Windows 不适用测试。

同时执行并通过：

```text
go vet ./...
go test -race ./internal/vmprovider ./internal/vmsupervisor ./internal/imagedownload
```

### 阶段 3 服务 Smoke

```text
pnpm smoke:phase3
```

在 Windows 上实际启动编译后的 Go Supervisor 和控制平面，使用本地 HTTP 合成工件完成：

1. Supervisor 健康检查和随机 ACL 文件生成；
2. 匿名请求 401、正确 ACL 令牌成功；
3. 控制平面应用 `003_phase3_images` 并连接 Supervisor；
4. Manifest 注册、下载进度 SSE、SHA-256 校验、原子启用；
5. 同镜像第二次请求不重复访问网络；
6. 控制平面调用受 ACL 保护的 VM API；
7. 下载中强制结束控制平面进程，重启后自动从已保留字节续传并校验最终文件。

机器记录中的 `realQemuValidated=false` 是有意保留的边界，不代表 QEMU 失败。

## 6. 尚未关闭的验收门槛

- 在具备阶段 0 QEMU/WHPX、基础镜像和 NoCloud Seed 的 Windows Host 上运行新的 Supervisor/控制平面全链路，并复测休眠/恢复和 Guest Health；
- 真实镜像 CDN 的签名、长期可用性和大文件下载基线；内置 `current` URL 的上游变化需要发布新版本 Manifest；
- 跨多个控制平面进程下载同一目标的文件锁；当前设计假定单节点单控制平面实例；
- Supervisor 多进程同时管理同一 VM 存储根目录不在当前支持范围；
- Electron 自动托管/打包 Supervisor、Go 二进制更新与系统服务安装；
- Windows NSIS 安装、干净环境运行和卸载；
- 阶段 4 的 noVNC、Guest 认证令牌签发/撤销和统一输入 Lease。
