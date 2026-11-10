# 阶段 4 验收记录：Guest Agent、noVNC 与统一 Execution Lease

日期：2026-11-11

## 结论

阶段 4 的代码主链路、本机真实控制平面/Guest Agent 进程 Smoke 和自动化回归已完成。Synthetic RFB 对端只用于验证代理协议与权限边界，**不代表真实 QEMU/WHPX、X11、浏览器或 Electron 人工桌面验收通过**。

机器结果：[`results/2026-11-11-smoke.json`](results/2026-11-11-smoke.json)，其中 `realQemuValidated=false`、`realDesktopInputValidated=false`。

## 4.1 Guest Agent 基础服务

已实现：

- Bearer 认证管理通道；无令牌、错误令牌、令牌文件被删除均不能执行管理或输入操作。
- `-token-file` 每次请求重新读取小型普通文件，拒绝 symlink，支持原子轮换和删除即撤销；令牌不写日志。
- `GET /v1/heartbeat`、`GET /v1/version`、`GET /v1/capabilities`：Agent 版本、协议范围、兼容性、桌面可用性与独立错误状态。
- 截图、桌面宽高、DPI、缩放比例；X11 每次信息查询、截图和输入前重新读取 Root Window 几何信息，避免分辨率改变后沿用旧坐标边界。
- 鼠标、键盘、Unicode、滚动、拖拽与可取消等待；动作 ID 格式校验、10 分钟有界去重、默认/调用方超时和 30 秒硬上限。
- `POST /v1/update`：固定版本、大小和 SHA-256 Manifest；HTTPS 或回环 HTTP；逐跳重定向校验、禁止 HTTPS 降级、大小限制、流式校验、`fsync` 和原子暂存。
- 更新只暂存到内容寻址文件，不执行下载内容、不自行重启；结果明确 `restartRequired=true` 和 `activation=external_service_manager`。
- 发布构建可通过 `-ldflags "-X main.version=<version>"` 注入 Agent 版本。

控制平面提供对应 VM 路由：

```text
GET  /api/v1/vms/:id/guest/heartbeat
GET  /api/v1/vms/:id/guest/version
GET  /api/v1/vms/:id/guest/capabilities
GET  /api/v1/vms/:id/guest/desktop
GET  /api/v1/vms/:id/guest/screenshot
POST /api/v1/vms/:id/guest/actions
```

宿主侧逐请求读取 `<vm-storage-root>/guest-agent.token`；开发/旧镜像可用 `AGENT_IN_BOX_GUEST_TOKEN_FILE` 指定共享令牌文件。新镜像仍需通过受控 NoCloud/镜像构建流程把对应令牌 provision 到 Guest，不能把宿主令牌路径当成 Guest 内路径。

## 4.2 noVNC 实时控制台

已实现：

- Web/Electron 共用 React noVNC 组件，使用 `@novnc/novnc` 1.5.0；Vite 开发代理支持 WebSocket。
- `POST /api/v1/vms/:id/console/sessions` 创建人工 Lease 和 60 秒、一次性、32 字节随机票据。
- WebSocket 仅接受回环客户端、回环 Host、匹配的本地 HTTP Origin 和 Supervisor 返回的 `vnc://127.0.0.1:<port>`；不是通用 TCP 代理。
- 严格支持 RFB 3.8 no-auth 协商。ServerInit 前的客户端字节只允许精确的版本、安全类型和 ClientInit；其他字节缓存，之后仍进入输入检查。
- 对 RFB 客户端消息分帧；KeyEvent、PointerEvent、ClientCutText 逐条检查当前人工 Lease。未知消息、超大消息、文本 WebSocket 帧和过量队列均 fail closed。
- Lease 失效或输入协议错误时关闭 WebSocket，并有强制终止兜底；旧票据不能重用。
- 画面缩放、鼠标/键盘接管、Ctrl+Alt+Del、连接状态和断开提示；断开后释放自己的 Lease。重新连接会显式创建新会话，不静默复用旧票据。

## 4.3 统一 Execution Lease

复用既有 SQLite `vm_leases` 唯一 VM 约束，无需破坏性迁移：

- 每 VM 只有 `idle`、`ai`、`human` 三种控制状态；Lease 记录持有者、任务、获取时间和过期时间。
- 同 Worker/Task 重复获取幂等；不同 Worker 不得并发；人工获取会抢占 AI，新人工会话也会撤销旧人工会话。
- 心跳只能续期当前未过期 Lease；过期后不能续期或重放旧动作。
- Guest AI Input 与 noVNC Input 调用同一个 `LeaseService.executeWithLease`。
- 输入和 Lease 获取/释放共享 Per-VM 异步锁，防止“检查后、写入前”发生接管竞争；同一 Lease 的输入也串行。
- 控制变化写入 `vm.control_changed` Outbox，和 Lease 变化处于同一数据库事务。
- 人工接管后的旧 AI Guest 动作返回 `lease_conflict`，不会发送到 Guest Agent。

相关路由：

```text
GET  /api/v1/vms/:id/control
POST /api/v1/vms/:id/lease/worker
POST /api/v1/vms/:id/lease/heartbeat
POST /api/v1/vms/:id/lease/release
```

## 自动化证据

- 控制平面：14 个测试文件，63 个测试通过，3 个 Windows 不适用的 POSIX 权限/symlink 用例显式跳过。
- 新增覆盖：人工抢占、AI 拒绝、Lease 过期/续期/重放、锁后时钟、续期不缩短既有 TTL、同 Lease 输入串行、Guest 动作门控、一次性票据、RFB 分帧、QEMU 扩展键盘、ServerInit 拆包时早期输入不得绕过 Lease。
- `go test -race ./internal/guestagent` 通过；动作、心跳、版本、更新、令牌轮换均有 Go 测试。
- `pnpm package:control-plane` 通过，并直接启动打包产物验证健康检查、SQLite、NestJS 和 `ws` 运行时解析。打包脚本修复了 pnpm 11 绝对链接在 `runtime_modules` 改名后失效的问题：POSIX 使用相对链接，Windows 使用免提升权限的 junction；CI 新增自包含打包门禁。
- `pnpm smoke:phase2`、`pnpm smoke:phase3`、`pnpm smoke:phase4` 连续通过。Windows 阶段 2 Smoke 补上了 `LOCALAPPDATA`/XDG 隔离，避免读取或写入真实默认数据目录。
- `pnpm smoke:phase4`：真实控制平面与 Guest Agent 进程通过六项检查，包括真实更新暂存和 RFB 代理输入撤销。
- 修复了一个实际 Smoke 发现的 Nest 注入问题：`LeaseRepository` 必须显式 `@Inject(KYSELY)`，否则生产进程中的 Lease DB 为 undefined。
- 独立代码审查后补测并修复：noVNC/QEMU Extended Key Event（type 255/subtype 0）支持、按 Lease ID 重建重连组件、心跳在获得 VM 锁后读取时间、续期不缩短既有过期时间。最终全仓 `pnpm check` 为 145 个 Vitest 测试通过、4 个环境依赖用例显式跳过。
- 修复了 RFB 拆包安全边界：不能把 ServerInit 前的任意客户端数据都当作协商转发。

## 尚未关闭的真实环境门槛

1. 使用真实 QEMU/WHPX 和 XFCE/X11 Guest 验证 noVNC 画面、鼠标键盘、Unicode、分辨率/DPI 动态变化及 VM 重启重连。
2. 在本地浏览器和打包 Electron 中各执行一次人工接管，确认 AI 暂停/拒绝与恢复流程；本次没有启动图形桌面做此验收。
3. 在 Guest 内由 systemd/服务管理器执行已暂存更新的安装、重启、健康检查和失败回滚；当前仅验证安全暂存，不声称已完成自更新激活。
4. 更新 Manifest 当前依赖认证通道和 SHA-256，尚无独立发布签名；真实 CDN 与长期更新源仍需发布前验收。
5. X11 原生调用是同步操作；`wait` 支持 context 取消，其他动作的硬超时依赖底层 X11 调用及时返回，需真实桌面故障测试。
6. 新 Golden Image 的 Guest Token 自动 provision、Guest Agent 崩溃恢复和 Electron 托管 Supervisor 仍属于镜像/安装集成工作。

## 复现

```bash
pnpm check
go test -race ./internal/guestagent
pnpm smoke:phase4
```

CI 在 Windows/Linux 矩阵运行同一 Smoke，并上传 `phase4-smoke-<OS>` artifact；CI 不启动真实 QEMU/WHPX，不需要模型或机器人凭据。
