# Agent-in-Box

面向个人用户的本地 AI 虚拟机工作平台。当前仓库已完成 **开发计划阶段 1（工程骨架、协议和本地持久化）**、**阶段 2（Electron、本地服务与自定义存储）**、**阶段 3（镜像服务、VM 生命周期与管理 UI）**、**阶段 4（Guest Agent、noVNC 实时控制台与统一 Execution Lease）**、**阶段 5（项目、多 VM 绑定、持久任务队列与任务看板）** 和 **阶段 6（Pi Worker Runtime、Model Broker 与 Worker Engine Adapter）**。包含无特权 Electron 壳、控制平面进程监管、首次启动向导、自定义数据目录、可续传镜像服务、受 ACL 保护的 Go VM Supervisor、QEMU/WHPX 生命周期、认证 Guest 管理通道、AI/人工互斥桌面输入、跨项目串行的 VM 任务内核，以及认证 Guest Worker RPC、短期模型令牌、流式 Broker、Worker 心跳/归档/恢复和项目 Worker 会话面板。真实 QEMU/WHPX、Linux Golden Image、真实 Pi/模型和浏览器/Electron 人工交互验收仍按各阶段记录单独执行。

完整方案见：

- [产品方案](docs/01-product-solution.md)
- [技术设计](docs/02-technical-design.md)
- [开发计划](docs/03-development-plan.md)
- [阶段 2 验收记录](tests/phase2/summary.md)
- [阶段 3 验收记录](tests/phase3/summary.md)
- [阶段 4 验收记录](tests/phase4/summary.md)
- [阶段 5 验收记录](tests/phase5/summary.md)
- [阶段 6 验收记录](tests/phase6/summary.md)
- [Linux Guest Worker 安装资产](images/linux/README.md)

## 阶段 6 已落地

- **Worker Runtime**：Guest 内认证 Worker RPC（Bearer 令牌轮换、SSE 事件重连回放、版本握手、命令超时和大小限制）、每 Worker 独立 Pi 进程/HOME/session、非 root `aib-worker` 安装资产与固定 Node 24.18.0 / Pi 1.5.1。
- **会话归档与恢复**：JSONL 备份、大小/SHA-256 manifest、版本校验、只接受运行时根内普通文件；Native Resume 失败明确报错，不伪造无损恢复。
- **Model Broker**：Provider/模型白名单、短期令牌绑定 Worker/VM/session/任务、TTL 续期、撤销即中断流、OpenAI-compatible 与 Anthropic Messages 流式透传、用量/错误记录、上游重试；长期 Provider Key 由 Electron `safeStorage` 解密，经 0600 描述文件的进程内凭据桥提供，不进入 Guest。
- **Worker Engine Adapter**：接入 TaskService 认领、统一 Execution Lease、Worker Registry、心跳、事件→TaskEvent/会话消息映射、取消→Pi Abort、RPC 断线→失败对账、控制平面重启保留绑定并显式 Resume。
- **任务状态边界**：Pi 回合结束后任务进入 Blocked（`awaiting_verification`），阶段 7 实现独立完成校验前不以模型自称完成作为成功标准。
- **验证边界**：`pnpm smoke:phase6` 使用真实控制平面/SQLite/HTTP Broker/Worker RPC 和测试 Pi 进程验证 11 项主链路；未启动真实 QEMU/WHPX、Linux Golden Image、真实 Pi 或真实模型，真实浏览器/Electron 人工验收仍未执行。

详见 [`tests/phase6/summary.md`](tests/phase6/summary.md)。

## 阶段 5 已落地

- **项目与多 VM 绑定**：项目 CRUD、归档/恢复、Guest 工作区配置、主 VM 切换、停止 VM 绑定；项目会话、活动和产物引用。项目与 VM 页面明确列出共享项目、归档状态和串行状态影响，解绑/删除项目不会删除共享 VM。
- **持久任务内核**：幂等创建、依赖、优先级、合法状态迁移、取消、失败重试和错误记录；TaskEvent、项目活动与 Outbox 同事务写入。SQLite 唯一约束和事务化认领保证同一 VM 只有一个运行中/待审批任务，不同 VM 可独立执行。
- **结果与产物**：服务端 `TaskService.complete()` 校验非空摘要和产物目录内文件的实际大小/SHA-256，支持重新校验；浏览器没有通用状态覆盖或完成路由。
- **任务看板**：项目/VM/Worker/状态筛选、排队位置和优先级、取消/重试、依赖/结果/产物/TaskEvent 时间线，以及项目、VM、来源会话跳转。WebSocket 只通知失效，打开和重连后读取完整数据库快照。
- **验证边界**：真实控制平面 HTTP/WebSocket Smoke 已验证重启不重复认领；Smoke 使用服务端 TaskService 驱动和预置 VM 状态，不代表 Pi Worker、真实 QEMU/WHPX 或浏览器/Electron 人工 UI 验收通过。

详见 [`tests/phase5/summary.md`](tests/phase5/summary.md)。

## 阶段 4 已落地

- **Guest Agent 管理通道**：Bearer 令牌文件轮换/撤销、心跳、能力与版本兼容握手；截图、动态分辨率/DPI、输入动作 ID/超时/去重；更新包经大小和 SHA-256 校验后原子暂存，由外部服务管理器激活。
- **noVNC 实时画面**：Web/Electron 共用控制台组件；回环 WebSocket 代理使用短时一次性票据和 Origin/Host 校验，严格解析 RFB 3.8，不是通用 TCP 隧道。
- **统一 Execution Lease**：SQLite Per-VM Lease、心跳、过期和释放；AI 与人工输入共用校验和串行锁；人工接管抢占 AI，旧 AI 动作和失效控制台输入均被拒绝。
- **验证边界**：真实控制平面/Guest Agent 进程 Smoke 已通过；RFB 对端是合成测试服务，真实 QEMU/WHPX、X11 和浏览器/Electron 人工操作仍需显式验收。

详见 [`tests/phase4/summary.md`](tests/phase4/summary.md)。

## 阶段 3 已落地

- **Image Service**：Manifest 与来源白名单、不可变版本、流式下载、Range 续传、并发去重、取消、失败诊断、SHA-256/大小校验和原子启用；数据库进度、SSE 事件和应用重启后的自动恢复。
- **VM Supervisor**：回环监听和文件支持的 Bearer ACL；Create/List/Start/Stop/Suspend/Resume/State/Console；QEMU 进程/QMP 对账、按 VM 锁、结构化错误和超时；不开放删除 HTTP 路由。
- **Linux Guest**：只从 Available 镜像创建独立 qcow2 覆盖盘，配置 VirtIO、回环网络/显示/控制台与 Guest Agent 转发；电源状态和 Guest Health 分开，异常 VM 不误标 Ready。
- **VM 管理 UI**：镜像下载与进度、VM 创建和资源建议、多 VM 状态、存储路径和实际占用、绑定项目、当前任务、启停/休眠/恢复及控制台入口；强制停止有数据风险说明。
- **验证边界**：本机服务 Smoke 和全部自动化测试通过；当前环境没有阶段 0 的 QEMU/镜像资产，因此新的真实 WHPX 休眠/恢复回归仍需按验收记录显式执行。

详见 [`tests/phase3/summary.md`](tests/phase3/summary.md)。

## 阶段 2 已落地

- **Electron 无特权壳**：`sandbox` + `contextIsolation`，Renderer 没有 `require`、Node `process` 或通用 IPC；只有白名单方法通过 preload 暴露。
- **本地服务监管**：Electron Main 启动并监管 Control Plane，带健康检查、启动超时、异常退出自动重启上限、结构化日志、崩溃诊断、托盘和“关闭窗口后后台运行/退出”设置。
- **首次启动向导**：检查操作系统、CPU 虚拟化、内存和磁盘；在首次下载前选择数据目录；设置 Host Reserve、自动启动策略、本机管理员和敏感操作审批。
- **存储管理**：镜像、下载缓存、VM、快照、产物和归档统一由 Storage Manager 解析；路径可写/空间检查、存储锁、哈希校验迁移、SQLite 在线备份与完整性检查；迁移失败保留旧目录。
- **模型凭据**：只在 Electron Main 中通过 `safeStorage`（Windows DPAPI、macOS Keychain、Linux Secret Service）加密保存；`basic_text` 等不安全后端会明确拒绝保存；凭据不经过普通配置或日志。
- **打包**：electron-builder 配置、`pnpm deploy` 生成自包含 Control Plane、`runtime_modules` + `NODE_PATH` 解决 pnpm/extraResources 结构；Linux 打包 Smoke Test 和 Windows portable/win-unpacked 构建已实际执行。

详细验收项、证据和未关闭门槛见 [`tests/phase2/summary.md`](tests/phase2/summary.md)。

## 环境要求

- Node.js 22.19 或更高版本（当前验证环境为 Node.js 24）
- pnpm 11.22（由根 `packageManager` 固定）
- Go 1.26 或更高版本
- Windows 宿主机是首要目标；当前脚手架也可在 Linux/WSL 中开发和测试

启用 Corepack 后可自动使用固定 pnpm 版本：

```bash
corepack enable
corepack prepare pnpm@11.22.0 --activate
```

## 安装与开发

```bash
pnpm install

# 控制平面 + Web 本地开发
pnpm dev

# 或分别启动
pnpm --filter @agent-in-box/control-plane dev
pnpm --filter @agent-in-box/web dev
```

- Web: http://127.0.0.1:5173
- 控制平面: http://127.0.0.1:3000
- 健康检查: http://127.0.0.1:3000/api/v1/health

VM 操作另需启动 Go Supervisor（普通用户、仅回环监听）：

```bash
go run ./services/vm-supervisor/cmd/vm-supervisor
```

Supervisor 与控制平面读取同一个 `AGENT_IN_BOX_DATA_ROOT` 或首次向导保存的 `app-config.json`，默认 ACL 令牌位于 `<data-root>/supervisor-acl.token`。QEMU 不在 PATH 时通过 `-qemu-system` 和 `-qemu-img` 指定阶段 0 已安装的固定二进制路径。Electron 自动托管/打包 Supervisor 仍是后续安装集成项。

桌面壳开发可以直接使用统一脚本（构建共享包、Web、Control Plane 和 Electron，并由 Control Plane 提供同源页面）：

```bash
pnpm dev:desktop
```

也可分别启动 Vite 和 Electron；`AGENT_IN_BOX_WEB_URL` 可指向其他本地 Web 地址。Electron 窗口只加载页面，不直接执行系统命令。

打包与 Smoke Test：

```bash
# 构建自包含 Control Plane + Web + Electron 并生成当前平台目录包
pnpm package:desktop:dir

# 生成 Windows portable exe（Linux/WSL 可构建，无需 wine）
pnpm package:desktop:win:portable

# 在 Windows 上生成 NSIS 安装包（需要 Windows 或可用的 wine）
pnpm package:desktop:win

# 控制平面首次启动/迁移/重启对账（不需要 Electron）
pnpm smoke:phase2

# Image Service + 真实控制平面/Supervisor + ACL + 进程重启续传
pnpm smoke:phase3

# Guest Agent + 版本/更新握手 + noVNC 代理 + AI/人工 Lease 互斥
pnpm smoke:phase4

# 项目/绑定 + 任务队列 + 产物校验 + 真实重启 + WebSocket 全量重同步
pnpm smoke:phase5

# Worker RPC + 短期 Broker 令牌/撤销 + 事件映射/取消 Abort + 归档/重启恢复
pnpm smoke:phase6

# 生成 Guest Worker Runtime 自包含 tar.gz 与 SHA-256
pnpm package:worker-runtime

# 已打包桌面壳的 Renderer 隔离、preload IPC 和 UI 加载
# 需先执行 pnpm package:desktop:dir；Linux/WSL 还需要 X/WSLg 和 Electron 系统库
pnpm smoke:desktop
```

受限网络下下载 Electron/NSIS 依赖可设置镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
pnpm package:desktop:win:portable
```

## 构建与检查

```bash
pnpm build        # 所有 TypeScript 包 + Go
pnpm test         # Vitest + Go test
pnpm typecheck
pnpm lint
pnpm check        # lint + typecheck + test + build
```

## 持续集成

GitHub Actions 工作流位于 `.github/workflows/ci.yml`，在 `main` 推送、Pull Request 和手动触发时运行。Windows 与 Linux 矩阵使用固定 pnpm、Node.js 24 和 `go.mod` 中的 Go 版本，依次执行：

- `pnpm install --frozen-lockfile`；
- `pnpm check`、`go vet ./...`、关键 Go 包的 race 测试与自包含 Control Plane 打包；
- 阶段 2～6 服务 Smoke Test，并上传阶段 3/4/5/6 的机器结果 artifact。

CI 不申请模型或机器人凭据，也不运行真实 QEMU/WHPX；这些仍由对应阶段的显式集成测试和宿主环境验收覆盖。

Go 服务可单独运行：

```bash
go run ./services/vm-supervisor/cmd/vm-supervisor
go run ./services/guest-agent/cmd/guest-agent
```

两者默认只监听回环地址，并提供 `/healthz` 和 `/readyz`。Guest Agent 的认证管理接口还需 `-token-file <guest-token-file>`；宿主控制平面读取 `<vm-storage-root>/guest-agent.token`，或通过 `AGENT_IN_BOX_GUEST_TOKEN_FILE` 使用开发/旧镜像的共享令牌文件。两处令牌必须一致，令牌文件支持轮换，删除后旧凭据立即失效。

阶段 6 的 Guest Worker RPC 监听 `0.0.0.0:7612`，由 QEMU 仅转发到宿主机回环端口；宿主读取 `<vm-storage-root>/worker-rpc.token`（开发环境可用 `AGENT_IN_BOX_WORKER_TOKEN_FILE`）。该令牌与 Guest Agent token、模型 Broker 短期令牌相互独立。模型 Broker 默认监听 `127.0.0.1:6719`，Guest 通过 QEMU user networking 的 `10.0.2.2:6719` 访问；长期 Provider Key 由 Electron `safeStorage` 解密，经 `credential-bridge.json`（0600）和进程内 Bearer 桥交给控制平面。Worker Runtime 安装与固定版本见 [`images/linux/README.md`](images/linux/README.md)。

## 目录结构

```text
apps/
  desktop/           Electron 无特权桌面壳、Control Plane 监管、托盘与凭据存储
  web/               React + Vite 本地 Web UI（首次向导、存储和设置页面）
services/
  control-plane/     NestJS 本地控制平面（宿主检查、存储管理、设置与持久化）
  vm-supervisor/     Go 宿主机 VM 管理服务（ACL、QEMU 生命周期与状态对账）
  guest-agent/       Go Guest Agent（认证管理、桌面输入/截图、心跳与更新暂存）
scripts/             打包、开发启动与阶段 Smoke Test
packages/
  protocol/          跨进程协议与事件类型
  domain/            任务/Worker 状态机与绑定规则
  config/            数据目录和本地服务配置
  agent-runtime/     Worker Engine 抽象、Pi RPC、Guest Worker RPC 与自包含运行时入口
  computer-use/      Computer Use 动作协议与校验
  bot-connector/     飞书/QQ 平台无关接口
  ui/                状态文案与样式辅助
internal/health/     共享 Go 健康检查实现
images/linux/        Worker Runtime 安装脚本、systemd unit、cloud-init 示例
tests/               阶段验证记录与后续集成/真实 VM 测试
docs/                产品、技术与开发计划
```

## 数据目录

小体积应用配置保存在 OS 配置目录，大文件全部位于用户选择的数据根目录：

- 配置文件：Windows `%APPDATA%\AgentInBox\app-config.json`；Linux `~/.config/agent-in-box/app-config.json`；macOS `~/Library/Application Support/AgentInBox/app-config.json`
- 默认数据根目录（首次启动向导会要求确认或改选）：Windows `%LOCALAPPDATA%\AgentInBox`；Linux/macOS 为 OS 数据目录
- 存储布局：`images/`、`downloads/`、`vms/<vm-id>/`、`snapshots/<vm-id>/`、`artifacts/`、`archives/`

`AGENT_IN_BOX_CONFIG_DIR` 可覆盖配置目录（桌面应用会自动传给 Control Plane）；`AGENT_IN_BOX_DATA_ROOT` 可强制指定数据根目录，此时向导和存储迁移会锁定该路径。控制平面的 `/api/v1/runtime` 会返回解析后的存储布局和数据库路径，`/api/v1/storage` 返回分类占用和存储锁状态。

迁移会在存储锁保护下复制并逐个校验文件哈希，使用 SQLite 在线备份复制数据库并执行 `integrity_check`，全部成功后原子更新配置；失败时旧目录和旧配置保持可用。旧目录不会自动删除。

SQLite 数据库位于数据根目录下的 `agent-in-box.sqlite`，使用 WAL 模式并启用外键约束。启动时执行内置 Migration Runner；迁移记录保存在 `schema_migrations` 表中，每条迁移在独立事务中应用。数据库包含：

- `projects`、`project_vm_bindings`、`project_activities`、`vm_instances`、`conversations`
- `tasks`、`task_events`、`task_dependencies`、`task_artifacts`、`workers`、`idempotency_keys`
- `outbox`、`vm_leases`、`processed_events`
- `model_providers`、`model_tokens`、`model_requests`、`conversation_messages`
- `images`
- `app_settings`、`local_users`、`storage_migrations`

数据库备份通过 `AppDatabase.backup()` 使用 SQLite 在线备份能力，后续会接入本地备份与恢复流程。

## 当前验证记录（2026-11-10～11）

已在当前开发环境实际执行：

- `pnpm install`：成功；pnpm 11 仅允许 `esbuild`、`electron`、`better-sqlite3` 构建脚本
- `pnpm check`：lint、typecheck、183 个 Vitest 测试、Go test、全部构建均通过；1 个环境依赖测试显式跳过
- 控制平面 `GET /api/v1/health`、`GET /api/v1/runtime` 返回正常
- 控制平面启动时创建 SQLite 数据库并应用 `001_initial_schema`、`002_phase2_settings`、`003_phase3_images`、`004_phase5_projects_tasks`、`005_phase6_workers_models`
- SQLite 表、WAL 模式和迁移记录在真实运行中验证通过
- Web 开发服务器可访问，`/api` 代理到控制平面正常
- VM Supervisor 与 Guest Agent 的 `/healthz`、`/readyz` 正常

### 阶段 6 验证（2026-11-11）

- `pnpm smoke:phase6`：真实控制平面完成 Worker Guest RPC 握手、短期 Broker 令牌、Guest 无长期 Provider Key、TaskEvent/会话消息映射、Steer/Follow-up、任务取消触发 Pi Abort、令牌原子轮换、Broker 流式 usage/撤销、重启对账、Native Resume、归档恢复和恢复后继续接收任务。
- 测试 Pi 进程是固定 RPC 协议的测试替身；`realModel=false`、`realQemuWxpx=false`、`browserElectronUi=false`。
- 详细证据和未关闭门槛见 [`tests/phase6/summary.md`](tests/phase6/summary.md)。

### 阶段 5 验证（2026-11-11）

- `pnpm smoke:phase5`：真实控制平面完成项目多对多绑定、共享 VM 删除保护、幂等/依赖/优先级、跨项目串行认领、失败重试、取消和产物 SHA-256 校验。
- 在任务保持 `running` 时停止并重新启动真实控制平面，新的认领请求返回空且尝试次数保持为 1；浏览器 `POST /complete` 返回 404。
- WebSocket 事件包含单调 ID、Schema/协议版本和任务上下文；断线后通过 `/api/v1/tasks/board` 重新读取完整快照，不依赖漏收事件重放。
- `realQemuValidated=false`、`browserInteractionValidated=false`、`workerRuntimeIntegrated=false`；本阶段 Smoke 的 Worker 是服务端 TaskService 驱动，不是 Pi RPC。
- 详细证据和未关闭门槛见 [`tests/phase5/summary.md`](tests/phase5/summary.md)。

### 阶段 4 验证（2026-11-11）

- `pnpm smoke:phase4`：真实控制平面和 Guest Agent 进程验证认证、心跳/版本握手、更新校验暂存、人工抢占 AI、一次性控制台票据及 Lease 释放后的 RFB 输入阻断
- 控制平面新增 Lease/Guest/RFB 测试，包含 ServerInit 拆包时早期输入不得绕过 Lease 的回归；Go Guest Agent race 测试通过
- Smoke 使用合成 RFB/更新对端，`realQemuValidated=false`、`realDesktopInputValidated=false`；真实 noVNC 浏览器/Electron 与 X11 动态分辨率验收尚未执行
- 详细证据和未关闭门槛见 [`tests/phase4/summary.md`](tests/phase4/summary.md)

### 阶段 3 验证（2026-11-10～11）

- `pnpm smoke:phase3`：在 Windows 上启动真实 Go Supervisor 和控制平面，验证 ACL、Manifest、SSE、校验启用、同镜像去重及强制结束控制平面后的自动续传
- Image Service 与 VM Service 新增 9 个测试；Go API/ACL/QMP/Provider 包含状态、幂等、并发锁和异常测试
- `go vet ./...` 和关键 VM/下载包 race 测试通过
- 当前未重新运行真实 QEMU/WHPX；`realQemuValidated=false` 已写入机器结果，不能用合成镜像 Smoke 替代 Hypervisor 验收
- 详细证据和未关闭门槛见 [`tests/phase3/summary.md`](tests/phase3/summary.md)

### 阶段 2 验证（2026-11-10）

阶段 2 的验收记录、逐项状态和未关闭门槛见 [`tests/phase2/summary.md`](tests/phase2/summary.md)。当前环境实际执行：

- `pnpm smoke:phase2`：首次启动状态、WSL 宿主机检查、Unicode/空格数据目录校验、首次向导完成、6 类存储目录迁移、SQLite 备份、旧目录保留、重启后数据根目录对账全部通过
- `pnpm package:desktop:dir`：electron-builder 生成 Linux 目录包，Control Plane 依赖通过 `runtime_modules` + `NODE_PATH` 装入 resources
- 已打包 Linux 桌面 Smoke Test：Control Plane 在 1 秒内 healthy；Renderer 中 `window.agentInBox` 可用、`require`/`process` 为 `undefined`；IPC 返回 `running`；页面实际渲染首次启动向导和宿主机检查结果
- Windows 目标：`win-unpacked` 与 portable exe 构建成功；NSIS 安装包在 Linux/WSL 中因缺少 wine 无法完成，需在 Windows 或安装 wine 的构建机执行
- 存储迁移失败回滚、锁竞争/陈旧锁、只读目录、符号链接、缓存清理不影响 VM/产物、凭据 `basic_text` 拒绝保存均有自动化测试
- Electron 二进制通过 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 下载；WSL 中运行还需系统提供 X/WSLg 以及 libnspr4/libnss3/libasound2

### 阶段 0 技术验证（2026-11-10）

阶段 0 的高风险主链路已完成验证，完整结果与未关闭门槛见 [`tests/phase0/summary.md`](tests/phase0/summary.md)。首版选型已冻结为 QEMU/WHPX + XFCE/X11 + Pi RPC + 宿主 Model Broker；飞书使用官方 Node SDK，机器人平台可扩展。

已在真实 Windows 11 家庭版宿主机上完成，而非仅在 WSL 中模拟：

- WHPX API 探测：`WHvGetCapability` 返回 `S_OK` 且 `hypervisorPresent=True`
- MSYS2 UCRT64 QEMU 11.1.3 安装到 `%LOCALAPPDATA%\AgentInBox\tools\msys64`，`-accel help` 包含 `whpx`
- Ubuntu 24.04 cloud image 从 TUNA 镜像下载并通过 SHA256 校验
- 使用 qcow2 覆盖盘启动 Linux Guest，冷启动到登录提示约 14 秒
- cloud-init NoCloud 创建验证用户，SSH 经 `127.0.0.1:10022` 读取启动标记成功
- QMP `system_powerdown` 优雅关机成功
- qcow2 快照创建、列出和恢复成功，恢复后快照后写入的标记文件消失
- XFCE + LightDM 桌面在 WHPX 上自动登录，QMP 截图与 `xdotool` 分辨率一致（1280x800，切换 1024x768 后截图尺寸同步变化）
- QMP 绝对鼠标归一化坐标和 `send-key` ASCII 输入通过验证：在终端输入命令后，Guest 内生成预期文件
- Go `vm-supervisor.exe /api/v1/host` 在 Windows 上返回 `ready=true`、`recommendedProvider=qemu-whpx`
- Go Guest Agent 以非特权用户在 X11 桌面运行：无令牌/错误令牌均返回 401，截图返回可解码 PNG，点击、ASCII 和中文 `你好` 输入通过 Guest 文件 SHA256 验证
- Go Provider 真实集成测试在 Windows/WHPX 上 31.83 秒通过：创建、启动、登录、Provider 重启对账、重复 Start/Stop、优雅关机、快照恢复和删除
- Pi 1.5.1 RPC + 脚本化模型 + 真实 Guest Agent 的工具循环通过：截图 PNG 回传、点击、中文输入、活跃工具 Abort、Session Resume
- **真实模型 `pro` 经本地 Model Broker 完成首个 CUA 任务**：13.37 秒内完成截图、中文输入、回车和复核截图，Guest 文件 SHA256 一致；VM 内不含上游 API Key
- 真实模型继续通过桌面 Home 双击打开 Thunar（25.14 秒）和 Mousepad 多行编辑保存（27.84 秒）
- WHPX 在桌面 VM 并行运行时连续通过 3 轮 Go Provider 生命周期回归（33.18/31.73/31.27 秒）
- Epiphany 页面滚动到底部成功，但 HTML5 drag-and-drop 未完成（已记录为失败）；窗口标题栏拖拽由 Guest Agent 独立验证通过

注意：Pi 验证同时使用本地脚本化模型和真实 `pro` 模型。首个真实任务已通过，但单次任务不能代表 Computer Use 成功率基线。验证中出现过一次 Guest 内核 panic，已记录为 WHPX 长稳风险，需重复复测。

验证中确认的必要配置：桌面 VM 使用 `-vga none -device virtio-gpu-pci -device virtio-tablet-pci`；当前 WHPX 环境暂用 `-cpu qemu64`，`-cpu max` 的启动卡住问题尚未解决。

测试矩阵、验收任务集和结果记录位于 [`tests/phase0/`](tests/phase0/README.md)。阶段 0 的 Linux 高风险主链路已经完成，默认 VmProvider 与 Worker Engine 已冻结；真实飞书/QQ 凭据、更长稳定性、Hyper-V 环境和真实镜像 CDN 等外部门槛仍然保留，详见阶段 0 总结。

## 当前技术栈版本

- Node.js 24（要求 >= 22.19）
- pnpm 11.22.0
- TypeScript 5.9.3
- React 19.3.1 + Vite 8.3.7
- NestJS 12.4.2
- SQLite: better-sqlite3 13.0.3 + Kysely 0.29.8
- Electron 45.2.3
- noVNC 1.5.0 + WebSocket RFB 代理
- Vitest 5.1.0
- Go 1.26

## 当前边界

已具备：

- pnpm Monorepo、共享 TypeScript 严格配置、Go Module
- 协议类型、分页/错误/幂等契约、Guest RPC 与 VmProvider 接口
- 任务与 Worker 状态机、VM 多对多绑定校验
- Computer Use 动作结构校验
- SQLite Migration、WAL、外键、在线备份
- 项目、VM、会话、任务、Worker、Lease、Outbox 和事件去重仓储
- 幂等任务创建、事务化状态迁移、任务事件与 Outbox 同事务写入
- Per-VM 执行 Lease 与过期替换
- NestJS 健康检查、运行时信息和持久化模块
- React 本地页面与 Electron 无特权入口
- VM Supervisor / Guest Agent 的 Go 健康服务
- Go QMP 客户端（状态、关机、截图、键盘、绝对鼠标事件）
- QEMU VmProvider 原型：qcow2 覆盖盘、启动/停止幂等、进程与 QMP 状态对账、快照、控制台地址
- Windows/Linux Host Inspect：WHPX/KVM、QEMU 加速器、内存和磁盘检查；Windows amd64 版本已在本机实际运行
- Linux X11 Guest Agent：Bearer 认证、能力/桌面信息、PNG 截图、鼠标/键盘/Unicode 输入和动作日志
- `PiWorkerEngine`：Pi RPC 子进程、受控工具暴露、事件映射、Prompt/Steer/Follow-up/Abort、会话归档与原生恢复；包含假 Pi 单元测试和真实 Pi 集成测试
- Guest Agent 心跳/版本/能力/截图/输入/更新暂存，noVNC 实时画面与统一 AI/人工 Execution Lease
- Electron 无特权壳、Renderer 白名单 IPC、Control Plane 进程监管、健康检查超时、日志轮转和崩溃诊断
- 首次启动向导、宿主机检查、数据目录选择、Host Reserve/自动启动策略、本机管理员和敏感操作审批
- Storage Manager：分类路径、可写/空间检查、存储锁、哈希校验迁移、SQLite 在线备份与完整性检查、下载缓存清理
- `safeStorage` 模型凭据存储（拒绝 Linux `basic_text`）、electron-builder 打包与自包含 Control Plane bundle
- Linux 打包桌面 Smoke Test；Windows `win-unpacked` 与 portable exe 构建

明确未实现或未在本环境验证：

- Windows 干净环境中的 NSIS 安装、安装包运行和卸载验证；Linux/WSL 缺少 wine，当前只验证了 win-unpacked/portable 构建
- 迁移后 qcow2 backing file 路径重写；当前会校验镜像并警告旧路径引用，依赖旧目录保留
- 迁移进度流式事件；当前为单次请求并持有存储锁
- 本地 API 管理员认证/CSRF 加固；当前为回环监听、Host 白名单与 CORS 限制，完整防护在阶段 11～12
- 生产级镜像来源签名与 CDN 长期可用性；当前 Manifest 使用来源白名单、大小和 SHA-256，跨多个控制平面进程的下载文件锁尚未实现
- Electron 自动托管/打包 VM Supervisor 与 Go 二进制更新；当前 Supervisor 作为独立本机进程启动
- Guest Agent 更新的服务管理器激活/回滚、发布签名和新镜像令牌自动 provision；当前已实现认证、令牌轮换/撤销与安全暂存
- 真实 QEMU/WHPX + X11 的动态分辨率/DPI、noVNC 浏览器/Electron 人工接管回归；合成 RFB Smoke 不替代此验收
- Wayland 与 Windows Guest 的截图/输入路径
- Pi Worker 与 Task/Lease/Router 的控制平面接入、生产级 Model Broker 服务
- Router、HTTP 任务 API、Worker 注册表查询接口和任务看板
- 真实飞书/QQ 应用凭据验收；本地长连接框架和 mock 协议测试已完成

阶段 0～4 的代码主链路已完成。下一步按 [开发计划](docs/03-development-plan.md) 进入阶段 5：项目/VM 绑定、Task Service 和任务看板；同时继续跟踪阶段 4 的真实桌面交互与更新激活、真实 QEMU/WHPX 回归、Windows NSIS 安装包和干净环境 Smoke Test 门槛。
