# Agent-in-Box 技术设计文档

> 文档状态：技术设计草案 v0.1  
> 本文给出推荐技术栈、模块边界、核心数据模型、执行协议和主要技术风险。标记为“待验证”的选型必须通过开发计划中的技术验证阶段后才能冻结。

## 1. 技术目标

- 面向个人电脑的本地优先部署；
- **Windows 宿主机运行 Linux VM 是 P0 必须支持能力**，不是可选保留项；
- Linux 宿主机复用主要架构，按测试矩阵验证；
- 本期先完成 Linux Guest 全链路验证，再验证和开发 Windows Guest；两者均属于本期最终技术范围；
- Windows Guest 镜像下载可以提前，但不得据此提前宣称 Windows VM 可行或已支持；
- Electron 与本地 Web 共用前端；
- 飞书和 QQ 通过本地出站长连接接入；
- AI Worker 在 VM 内运行，直接执行不落在宿主机；
- Router、Worker、会话、任务和 VM 状态全部可持久化、可恢复；
- 不限制镜像和 VM 数量，通过动态资源调度控制自动启动；
- 项目与 VM 多对多绑定，同 VM 默认单执行 Worker；
- 开源 Agent 内核可替换，产品核心协议和数据模型不被单一项目绑死。

## 2. 推荐技术栈

| 层级 | 推荐技术 | 用途与理由 |
| --- | --- | --- |
| 前端 | React + TypeScript + Vite | 同时支持 Electron 与本地 Web，适合任务看板、会话和 VM 控制台 |
| UI 基础 | Tailwind CSS + Radix UI / shadcn/ui | 构建可组合桌面界面，不将业务状态绑定到组件库 |
| 桌面端 | Electron + electron-builder | 本地安装、托盘、通知、后台服务管理和自动更新 |
| 本地控制平面 | Node.js + TypeScript + NestJS | 模块化单体，承载 Router、任务、项目、绑定、机器人和本地 API |
| Node 运行时 | Node.js 22.19 或更高经测试版本 | 满足当前 Pi 运行要求，实际发布时固定到经过验证的版本 |
| 仓库与包管理 | 单 Monorepo + pnpm Workspaces；Go 使用 Go Modules | 适合个人开发的跨模块原子修改、统一锁文件、内部包复用和整体发布 |
| 本地 API | REST + WebSocket，OpenAPI 与版本化事件 Schema | REST 执行命令和查询，WebSocket 推送任务、Worker、VM 和机器人状态 |
| 本地数据库 | SQLite WAL + better-sqlite3 + Kysely | 无需外部数据库，支持事务、迁移、持久队列和本地单实例并发 |
| 本地任务队列 | SQLite 持久任务表 + Outbox + Lease | 避免要求 C 端安装 Redis；支持重启恢复、幂等和心跳 |
| Agent 内核 | Pi SDK / Pi RPC | 复用 Agent Loop、Provider、会话、事件、Steer、Follow-up 和自定义工具 |
| Router Runtime | 本地 Pi SDK / pi-agent-core | Router 在宿主机本地运行，只注册任务与查询工具 |
| Worker Runtime | VM 内 Pi RPC 为首选 | 平台通过受控管理通道启动和控制 Worker，天然限制文件与 Shell 在 VM 内 |
| Computer Use | 自研工具适配层 + Guest Agent；官方模型 SDK 作为专用适配器备选 | 将截图、动作和验证与 Agent 内核解耦 |
| VM Supervisor | Go 系统服务 | 跨平台系统服务、进程和 Hypervisor 生命周期、特权操作与本地 IPC |
| Guest Agent | Go；先实现 Linux 原生 API，本期后段增加 Windows 原生 API | 截图、输入、健康、文件交换；宿主和 Guest 共用系统级工具链 |
| Hypervisor | QEMU；Windows Host 必须验证 WHPX/Hyper-V 运行 Linux VM，Linux Host 使用 KVM/QEMU | 通过 VmProvider 抽象隔离差异，不能假设 Hyper-V 覆盖全部 C 端 Windows |
| VM 管理 | QEMU 命令/API；Linux 可选 libvirt | 所有操作由 Supervisor 固定实现，不向模型开放任意命令 |
| 远程控制台 | noVNC / VNC WebSocket 代理 | 提供实时画面和人工接管，Guest Agent 截图用于 AI 观察 |
| 镜像构建 | 先用 Packer + QEMU + cloud-init 构建 Linux；本期后段增加 Windows 无人值守安装 | 构建版本化 Golden Image，安装 Guest Agent 与 Worker 依赖 |
| 镜像格式 | QCOW2 + 可写覆盖盘 + 版本化 Manifest | 支持基础镜像复用、校验、缓存和快照链 |
| 凭据存储 | Windows DPAPI/Credential Manager、Linux Secret Service 等 OS 能力 | 长期模型和机器人凭据不写入普通配置或 VM |
| 飞书接入 | 飞书官方 SDK，WebSocket 事件 + Open API | 本地主动连接，无需公网回调 |
| QQ 接入 | QQ Bot API v2，WebSocket Intents + REST | 使用官方支持的长连接，具体事件受机器人类型和权限限制 |
| 日志与诊断 | 结构化 JSON 日志、本地环形日志、任务 Trace | 本地可诊断，敏感字段脱敏，不默认上传 |
| 测试 | Vitest、React Testing Library、Playwright、Go test、VM 集成测试 | 覆盖前端、控制平面、系统服务和真实 VM 任务 |

### 2.1 为什么不是全 TypeScript 单进程

Electron 或 Node 进程不应直接持有管理员权限。VM Supervisor 和 Guest Agent 需要操作系统服务、原生输入、屏幕和进程能力，独立 Go 系统服务可以形成更清晰的权限边界，也避免 Electron 崩溃直接影响 VM 管理。

### 2.2 为什么本地不用 Redis 和外部数据库

本产品默认单电脑、单控制平面、多 Worker。SQLite WAL、事务、持久任务表和 Lease 足以支撑这一部署形态，并显著减少安装和故障依赖。这里不是按最低成本选择，而是减少不必要的分布式故障面。未来云端多节点部署需要单独设计控制平面，不应直接套用本地 SQLite。

### 2.3 本期操作系统支持与开发门控

| 顺序 | 范围 | 要求 |
| --- | --- | --- |
| P0 | Windows Host + Linux Guest | 必须支持，是首要端到端运行形态 |
| Linux 全链路 | 镜像、VM、Guest Agent、Pi、Computer Use、Router、看板、机器人、恢复和真实任务 | 必须完整验收，不能只验证 VM 能启动 |
| 本期后段 | Windows Guest 的可行性、镜像构建、Guest Agent、Worker 和 Computer Use | Linux 全链路验收后开始，本期必须完成 |
| 可提前 | Windows 镜像 Manifest、下载、续传、校验和存储 | 仅做 Image Service，不提前开展 Windows VM 可行性与功能开发 |

协议和数据模型从第一版保留 `os_family`、Provider 和 Guest Capability 抽象，但 Linux 先行阶段不能用未经验证的 Windows 实现阻塞开发，也不能把 Windows Guest 从本期最终范围删除。

### 2.4 仓库与包管理决策

本期确定采用：**单一 Monorepo + pnpm Workspaces + Go Modules，根项目统一构建和发布**。不使用“总集成仓库 + 多个业务子仓库”，也不使用 Git Submodule 做日常联动开发。

单仓库不等于单进程。Electron、Control Plane、VM Supervisor 和 Guest Agent 仍分别构建、独立运行并具有不同权限；仓库统一只是为了适应个人开发中的跨模块原子修改、共享协议、统一测试和联合发布。

#### 为什么使用 pnpm 而不是 npm

npm Workspaces 在功能上可行，但本项目包含多个 TypeScript 应用、内部共享包、Pi、Electron 和原生依赖，pnpm 更适合：

- Workspace 和按包 Filter 命令清晰；
- 严格依赖隔离可尽早发现 Phantom Dependency；
- 内部依赖通过 `workspace:*` 明确声明；
- 单一 `pnpm-lock.yaml` 固定整个 TypeScript 工作区；
- 多包共享依赖时磁盘和安装结构更可控；
- 第三方依赖的小修复优先使用 `pnpm patch`，避免立即维护 Fork。

这里不是单纯按安装速度或成本选择，而是按多模块依赖正确性和个人维护效率选择。

#### 使用规则

- 根目录 `package.json` 设置 `private: true`；
- 通过 `packageManager` 固定 pnpm 版本，安装器和开发环境使用同一版本；
- 仓库只保留 `pnpm-lock.yaml`，禁止混用 npm/Yarn 锁文件；
- 内部包统一使用 `workspace:*`，内部包默认不发布到公共 Registry；
- 根脚本统一编排开发、构建、测试和打包，并调用 Go 构建与测试；
- 原生依赖的安装/构建脚本使用明确 Allowlist；
- Pi、Electron、NestJS、better-sqlite3 等关键依赖固定经过验证的版本；
- 保持 pnpm 严格隔离，遇到依赖问题不默认全局 Hoist；确需提升时精确配置并记录原因；
- 首阶段只使用 pnpm 原生 Workspace 能力，不提前引入 Nx/Turborepo，任务图确实复杂后再评估。

#### Electron 与原生依赖验证

pnpm 的链接结构必须在早期通过真实打包验证，不能只保证开发模式可运行：

- electron-builder 能将 Workspace 和传递依赖完整打包；
- better-sqlite3 等原生模块在目标 Windows Host 上正确构建；
- Control Plane 运行在独立、固定的 Node 服务进程中，不使用 Renderer 的 Node 环境；
- 避免不必要的 Electron ABI 与 Node 原生模块混用；
- 打包后执行数据库打开、Migration、Pi 加载和本地 API 的 Smoke Test；
- Windows 干净环境安装包不依赖开发机上的 pnpm Store。

#### Go 与发布边界

- VM Supervisor 和 Guest Agent 继续使用 Go Modules，不纳入 npm 包语义；
- 如有多个 Go Module，可用根目录 `go.work` 统一本地开发；
- 根项目脚本同时编排 TypeScript 与 Go，但不要求两者使用同一种依赖工具；
- 产品采用整体版本发布，内部 TypeScript 包不独立发布；
- Host-Guest Protocol、Pi Session Format、镜像和数据库 Migration 另有独立兼容版本；
- VM 镜像、大体积测试磁盘和构建产物不提交 Git，只保存构建脚本、Manifest、哈希、签名和版本说明。

#### 不过度拆包，后续再拆仓库

只将独立进程、真实多方复用逻辑、需要独立测试的核心能力和稳定协议拆为 Workspace Package；普通 Service、Repository、DTO 留在各应用 `src/` 中，不为了形式建立大量小包。

只有出现独立开源发布、外部用户、独立发布周期、不同 License/安全审计、长期 Pi Fork 或独立云端部署边界时，才将模块拆到独立仓库。拆出后主仓库使用固定版本依赖集成，不转为 Submodule 日常联动。

## 3. 进程与权限边界

```text
Electron Renderer（无特权）
        │ 本地 HTTP / WebSocket
Electron Main + Local Control Plane（普通用户权限）
        │ 命名管道 / Unix Socket / 受 ACL 保护的本地 IPC
VM Supervisor（仅必要特权）
        │ Hypervisor API / QEMU 进程
        ├────────────── Linux VM（本期先行）
        │               ├─ Guest Agent
        │               └─ Pi Worker
        └────────────── Windows VM（Linux 全链路验收后，本期后段完成）
                        ├─ Guest Agent
                        └─ Pi Worker

Feishu / QQ Connector 位于 Local Control Plane，凭据不进入 VM。
Model Broker 位于 Local Control Plane，VM 仅获得短期受限访问令牌。
```

原则：

- Renderer 不能直接执行系统命令；
- 控制平面不能向模型暴露 Supervisor 的通用接口；
- Supervisor 只接受白名单操作和结构化参数；
- Guest Agent 与控制通道必须认证、加密并绑定 VM；
- Pi Worker 默认使用 VM 内非 root / 非 Administrator 用户；
- Guest Agent 的桌面输入权限与 Worker 文件权限尽量分离；
- 宿主机密钥、数据库和机器人 Secret 不写入 Guest 镜像。

## 4. 建议代码结构

```text
package.json               # private 根项目、统一脚本、固定 packageManager
pnpm-workspace.yaml        # TypeScript Workspace 范围
pnpm-lock.yaml             # 唯一 JS/TS 锁文件
go.work                    # 存在多个 Go Module 时使用
apps/
  desktop/                 Electron 壳、安装、托盘、自动更新
  web/                     React 前端，本地 Web 与 Electron 复用
services/
  control-plane/           NestJS 本地控制服务
  vm-supervisor/           Go 特权 VM 管理服务
  guest-agent/             Go VM 内 Agent
packages/
  protocol/                API、事件、RPC 和状态 Schema
  domain/                  Project、Task、Worker、VM 领域类型
  agent-runtime/           Router、Worker Engine 适配层
  computer-use/            Computer Use 工具与动作协议
  bot-connector/           飞书、QQ 连接器公共框架
  ui/                      可复用 UI 组件
  config/                  配置、路径与版本约束
images/
  linux/                   Packer、cloud-init、Golden Image 构建
  windows/                 无人值守安装、驱动与镜像构建
tests/
  integration/             本地服务与数据库集成测试
  vm/                      真实 VM 自动化测试
  computer-use/            Computer Use 任务集和结果检查
  e2e/                     Electron / Web 端到端测试
docs/
```

这是目标结构，开发计划会按依赖顺序逐步创建，而不是一次性生成所有空模块。

## 5. 核心数据模型

**已实现（阶段 1）**：SQLite 使用 `better-sqlite3` + `Kysely`。迁移由内置轻量 Runner 管理，`schema_migrations` 表记录已应用版本，每条迁移在独立事务中执行；不依赖 Kysely Migrator 的 ESM 子路径，避免与 NestJS 的 CommonJS 构建冲突。Kysely 继续负责类型化查询、事务和表达式。

已落库的表包括 `images`、`vm_instances`、`projects`、`project_vm_bindings`、`conversations`、`workers`、`tasks`、`task_events`、`outbox`、`vm_leases`、`processed_events`、`idempotency_keys`。仓储方法支持传入调用方事务，任务创建、状态迁移、任务事件和 Outbox 在同一事务内提交。

### 5.1 Image

```text
id
name, os_family, os_version, architecture
version, source_url, checksum, signature
local_path, size, status
created_at, verified_at
```

状态包括 `not_downloaded`、`downloading`、`verifying`、`available`、`failed`。只有 `available` 镜像可用于创建 VM。

### 5.2 VMInstance

```text
id
name, image_id, os_family
provider_id, provider_vm_id
cpu_count, memory_bytes, disk_bytes
storage_root, disk_path
power_state, health_state
resource_policy
created_at, last_started_at, last_used_at
```

Power State 与 Guest Health 分开存储。QEMU 进程存在不代表 Guest Agent 和桌面已可用。

### 5.3 Project 与 ProjectVmBinding

```text
Project:
  id, name, description, status
  default_vm_binding_id
  workspace_policy, network_policy
  created_at, archived_at

ProjectVmBinding:
  id, project_id, vm_id
  guest_workspace_path
  is_primary
  created_at
```

底层允许多对多。UI 默认要求项目选择一个主 VM，跨平台项目可增加绑定。

### 5.4 Conversation 与 Worker

```text
Conversation:
  id, kind, project_id, title
  router_session_ref, worker_session_ref
  created_at, last_message_at

Worker:
  id, project_id, vm_id
  engine_type, engine_version
  agent_session_ref
  capability_set
  status, current_task_id
  last_active_at, archive_summary_ref

ConversationBinding:
  id, conversation_id, worker_id
  project_id, last_task_id
  status, created_at
```

Worker 默认绑定 Project + VM，不跨项目复用。Worker 的 Agent Session 与用户 Conversation 是不同对象，通过 Binding 关联。

### 5.5 Task

```text
id, idempotency_key
project_id, vm_id, origin_conversation_id
assigned_worker_id, parent_task_id
objective, status, priority
dependencies
lease_id, attempt_count
latest_summary, result_ref, error_ref
created_at, started_at, completed_at
```

任务显式记录目标 VM，而不是通过 Worker 临时推断。调度器以 `vm_id` 建立队列和执行 Lease。

### 5.6 TaskEvent 与 Outbox

- TaskEvent 使用追加式事件记录状态变化、工具执行摘要、截图引用和审批；
- Outbox 保证数据库状态提交后再向 Web、Router 和机器人发布事件；
- 所有事件有单调 ID、任务 ID、项目 ID、时间和 Schema 版本；
- 消费方按事件 ID 去重；
- 看板是数据库投影，不单独维护另一套任务事实。

## 6. 状态机与调度

### 6.1 Task 状态机

```text
created
  → waiting_resources
  → waiting_vm
  → queued
  → running
  → waiting_approval
  → running
  → completed | failed | cancelled

running / waiting_approval → blocked
blocked → queued（用户明确恢复或重试）
```

任何状态迁移都通过事务和合法迁移表完成。不能由前端拖拽直接写成 `completed`。

### 6.2 Per-VM Execution Lease

- 每个 VM 同时只有一个 AI/Human 执行 Lease；
- Lease 包含持有者、任务、获取时间、心跳和过期时间；
- Worker 所有桌面动作必须校验当前 Lease；
- 人工接管时撤销或暂停 AI Lease；
- Lease 过期后不自动假定原动作成功，需要重新截图和核对任务；
- 同 VM 不同项目共享同一个 Lease 管理器；
- 新建 Worker 不会创建额外通道绕过 Lease。

首版所有执行型任务按 VM 串行。未来只读并行必须另设能力标记，不改变 GUI 输入独占原则。

### 6.3 Resource Manager

不配置固定的全局最大 VM 数量。维护：

- Host Reserve：用户可配置的宿主机资源余量；
- Soft Memory Budget：自动启动 VM 使用的软预算；
- Running VM 资源分配和实测压力；
- 磁盘下载、快照和休眠所需空间；
- 手动启动与自动启动的不同策略。

自动任务资源不足时进入 `waiting_resources`。系统不得擅自停止有运行任务的 VM。用户手动启动可以突破建议值，但界面应提示宿主机卡顿风险。

### 6.4 Worker 生命周期

```text
running → idle → archiving → archived
archived → restoring → idle
```

归档由独立 Worker Lifecycle Service 执行。运行任务、排队消息、待审批和持有 Lease 都是归档阻塞条件。归档完成产生 `worker.archived` 事件，活跃工作集投影自动更新。

恢复优先级：

1. 同 Engine、同兼容版本的 Native Session Resume；
2. 新 Agent Session 加载 Archive Summary；
3. 两种恢复都注入当前 VM 截图和离开期间环境增量。

## 7. VmProvider 与 VM Supervisor

### 7.1 统一接口

```text
inspectHost()
createVm(spec)
startVm(vmId)
stopVm(vmId, mode)
suspendVm(vmId)
resumeVm(vmId)
deleteVm(vmId)              # 仅由用户明确操作
createSnapshot(vmId)
restoreSnapshot(vmId)       # 共享 VM 全局影响提示
getVmState(vmId)
attachConsole(vmId)
```

所有实现必须遵守相同的状态和错误语义。Provider 不接受模型生成的任意命令行。

### 7.2 Windows 宿主机

Windows Host 运行 Linux Guest 是必须通过的 P0 路径，不能只实现 Hyper-V：

- Hyper-V Provider 用于系统支持且验证通过的环境；
- QEMU/WHPX 是跨 Windows 版本的候选 Provider，Linux 先行阶段必须验证其运行 Linux Guest 的性能、稳定性、快照、输入和显示；
- Windows Guest 不在本阶段验证，等 Linux 全链路验收后于本期后段补测两种 Provider；
- Host Inspect 负责 CPU 虚拟化、系统功能、权限、内存和磁盘检查；
- 启用系统功能或安装服务由安装器明确提权，不由 Electron Renderer 执行。

Linux Guest 的默认 Provider 在技术验证后确定，不在验证前写死。

### 7.3 Linux 宿主机

优先 KVM/QEMU，可选 libvirt 简化设备、网络和快照管理。无 KVM 时明确提示性能和能力限制，不将纯软件模拟作为默认体验。

### 7.4 Guest OS 差异与开发顺序

- Linux：本期先行；Golden Image 使用经过验证、可自动化的桌面会话，Wayland 输入与截图单独验证；
- Windows：本期后段必做；在 Linux 全链路验收后处理 VirtIO、显示、DPI、桌面会话、自动登录策略、UAC 和授权；
- QEMU/VNC 控制台作为救援路径，Guest Agent 是正常运行路径。

## 8. 镜像和存储系统

### 8.1 Image Downloader

- Manifest 描述 URL、版本、架构、大小、哈希和签名；
- 分块下载、断点续传、应用重启恢复；
- 写入 `.partial` 临时文件，校验后原子改名；
- 同节点相同镜像去重下载；
- 校验失败不进入 Available；
- 更新生成新版本，不覆盖使用中版本；
- 镜像来源和重定向需要白名单与大小限制。

### 8.2 Storage Manager

数据根目录由用户选择，支持按 VM 覆盖：

```text
<storage-root>/
  images/
  downloads/
  vms/<vm-id>/
  snapshots/<vm-id>/
  artifacts/
  archives/
```

小体积应用配置可以位于 OS 标准配置目录，但所有大文件位置由 Storage Manager 统一解析，业务模块不能自行拼接默认系统盘路径。

### 8.3 迁移与快照链

- 停止相关 VM 并获得存储锁；
- 复制基础镜像引用、覆盖盘、快照和休眠文件；
- 尽可能使用相对 backing file 关系；
- 校验哈希和 QEMU 镜像链；
- 原子更新数据库路径；
- 启动验证；
- 旧文件保留到用户确认，不自动删除。

### 8.4 共享 VM 快照限制

整机 Snapshot 是 VM 级操作，影响全部绑定项目。项目级备份必须独立实现，不能通过恢复共享 VM 来回滚单项目。

## 9. Guest Agent 与 Computer Use

### 9.1 Guest Agent 接口

```text
health()
getCapabilities()
captureScreen()
getDesktopState()
executeInput(actionBatch)
transferFileIn(out)         # 需要用户或任务授权
getProcessHealth()
```

管理通道优先使用隔离的 Host-Guest 通道；不支持时使用仅绑定管理网络、具有 mTLS 或等效认证的通道。该接口不能暴露到 VM 的普通业务网络或公网。

### 9.2 Computer Use 动作协议

基础动作：

```text
screenshot
click, double_click, move
type_text, keypress
scroll, drag
wait
```

每个动作记录：任务、Worker、VM、Lease、动作 ID、来源截图 ID、屏幕宽高、DPI/缩放、参数、结果、错误和新截图引用。

坐标必须明确使用实际像素或归一化坐标，转换只在执行层完成。处理多显示器、分辨率和 DPI 变化。

### 9.3 输入与显示

- Linux 在先行阶段验证 X11/XTest 等输入路径，Wayland 不作为未经验证的默认假设；
- Windows 在本期后段使用原生输入和屏幕采集能力，验证 Unicode 输入、窗口焦点、RDP/锁屏和 UAC 行为；
- 中文输入优先使用可靠的 Unicode 输入或 VM 内剪贴板方案，不打开宿主机共享剪贴板；
- VNC/noVNC 人工输入与 AI 输入必须经过同一个 Lease；
- UAC、安全桌面和锁屏不通过绕过安全机制处理，转交用户。

### 9.4 Agent 闭环

1. 获取当前任务、项目和 VM 状态；
2. 检查 VM Health 和 Execution Lease；
3. 截图并附带环境元数据；
4. 模型返回结构化动作或文本；
5. 校验工具参数、权限和审批策略；
6. 在目标 VM 执行；
7. 获取新截图和动作结果；
8. 检查是否无进展、重复、超时或被用户打断；
9. 继续、等待审批或完成；
10. 完成前通过屏幕、文件、进程或测试结果验证目标。

## 10. Pi 与 Worker Engine 适配

### 10.1 复用范围

Pi 提供 Agent Loop、模型 Provider、会话、压缩、事件、RPC、自定义工具、Steer、Follow-up 和 Abort。优先通过 SDK、RPC 和扩展集成，不直接深度 Fork。

### 10.2 Router 与 Worker 的不同工具面

Router：

- 无宿主机 Shell；
- 无 Computer Use；
- 只有任务、项目、Worker、看板和归档查询/控制工具。

Worker：

- 在 VM 内运行；
- 可使用 VM 内文件、Shell 和 Computer Use 工具；
- 所有外部能力由策略层控制；
- 无 Supervisor 管理接口。

### 10.3 Worker Engine 抽象

```text
startSession(spec)
prompt(sessionId, input)
steer(sessionId, input)
followUp(sessionId, input)
abort(sessionId)
archive(sessionId)
resume(sessionId, archiveRef)
subscribeEvents(sessionId)
getCapabilities()
```

Pi 是第一个 General Worker Engine。Computer Use 专用引擎可作为另一实现，不影响 Task 和 Router。

### 10.4 必须验证的 Pi 兼容问题

通用 `click` 自定义工具不自动等于完整 Computer Use。需要验证：

- 截图作为工具结果或后续输入的回传；
- 目标模型原生 Computer Tool 支持；
- 多轮视觉上下文；
- Thinking 和响应内容块的完整重放；
- RPC 下的事件、取消、断线和恢复；
- 长会话压缩后继续 GUI 任务；
- 模型切换后的会话兼容性；
- Pi 升级后的 Session Format 兼容。

如果 Pi 路径不能满足 Computer Use，保留 Pi 作为 General/Coding Worker，并增加专用 CUA Worker Engine。专用 Claude 适配器使用官方 Anthropic TypeScript SDK；首个官方验证模型采用 `claude-opus-5-5`，使用当前支持的 Computer Use 工具和自适应思考接口。不得通过 OpenAI 兼容 Shim 替代官方 Computer Use 路径。

Agent S 等开源项目用于对照评测和专用引擎研究，不直接承担产品控制平面。

## 11. Model Broker

目标是不把长期 Provider API Key 放入 VM：

- 长期凭据保存在宿主机 OS 安全存储；
- Router 本地使用凭据；
- VM Worker 通过短期、绑定 VM/会话的令牌访问本地 Model Broker；
- Broker 限定可用模型、速率、任务和有效期；
- 网络策略只允许 VM 访问必要的 Broker 地址；
- Broker 记录用量和错误，敏感内容默认不写普通日志；
- 重启或撤销令牌后 VM 不能继续使用旧凭据。

技术验证必须覆盖 Provider 流式响应、工具调用、图片、Thinking 块、取消和重试。若 Pi 的 Proxy 协议与目标模型能力不兼容，应先做专用 Provider Adapter，不通过降低安全边界解决。

## 12. Router、看板和归档实现

### 12.1 Router Tools

```text
list_active_workers(project_id?)
list_tasks(project_id?, status?)
get_task(task_id)
get_worker_summary(worker_id)
find_related_worker(conversation_id, objective)
search_worker_archive(project_id, query)
create_task(...)
assign_task(...)
steer_task(...)
follow_up_task(...)
reprioritize_task(...)
pause_task / cancel_task / retry_task
```

每次分派前从数据库读取候选 Worker。语义相关性只用于建议，项目、VM、权限和状态由确定性规则过滤。

### 12.2 Active Roster Projection

Active Roster 是可重建的读模型，仅包含 Router 当前需要的紧凑卡片：Worker ID、项目、VM、能力、状态、当前任务摘要、最近任务摘要和最后活跃时间。

Router 不默认加载全部 Worker 历史和截图。归档后从投影移除，但 Archive Registry 保留可搜索记录。不得通过修改历史模型消息来维持正确性。

### 12.3 看板实时更新

控制平面事务提交 Task 和 Outbox，发布 `task.*`、`worker.*`、`vm.*` 事件。React 前端通过 WebSocket 更新，Router 在相关里程碑收到通知。普通鼠标动作不逐条推送给 Router，只进入任务 Trace。

## 13. 飞书和 QQ 本地连接

### 13.1 Connector 结构

```text
Platform WebSocket → Ingress → Dedup / Auth → Local Message Queue → Router
Local Task Events → Outgoing Formatter → Platform REST API
```

- 事件接收与任务执行解耦；
- 事件先落库，再按平台要求及时确认；
- 通过平台事件 ID 和内容幂等键去重；
- 维护连接状态、心跳、重连和最后错误；
- 机器人和用户白名单在本地数据库配置；
- App Secret 位于 OS 凭据存储；
- Connector 在后台服务中运行，不依赖 Electron 窗口存活。

### 13.2 平台差异

- 飞书：使用官方长连接接收事件，按企业自建应用的权限和发布规则配置；
- QQ：使用 Bot API v2 WebSocket 和 Intents，按机器人类型验证群聊、单聊和富媒体能力；
- 只支持 Webhook 的特定未来接入形态不作为默认路径，可增加可选中继；
- 同一机器人默认只允许一台活跃执行电脑，避免多实例随机消费事件。

### 13.3 离线与恢复

本地离线时不承诺平台补投。重连后按事件 ID 去重，任务和 Worker 先对账再恢复。没有可选云端队列时，不能宣称离线任务可靠排队。

## 14. 安全设计

- 定期更新 Hypervisor 和 Guest Agent；
- 默认无宿主机目录、USB、磁盘和剪贴板共享；
- VM 虚拟设备最小化；
- 默认无 VM 入站连接；
- 限制宿主机管理网络、内网敏感地址和云元数据服务；
- 出网代理和域名策略按项目/任务配置；
- 机器人、网页和文件内容均视为不可信输入；
- 高风险工具通过 Policy Engine 和 Approval Service；
- 所有工具参数使用 JSON Schema 校验；
- Supervisor 和 Guest RPC 有明确鉴权、超时、大小限制和审计；
- VM 上传产物与下载文件通过受控通道，不自动执行；
- 本地日志、截图和会话可能含敏感信息，提供保留期限、清理和访问控制；
- 审计保存动作和结果，不保存或展示模型隐藏推理。

“操作局限于 VM”指直接执行环境。VM 内登录网站、发送内容或删除云端数据仍会影响外部系统，必须单独审批和限制。

## 15. 可靠性、备份与升级

- 所有命令使用幂等键；
- 任务、Lease、Worker 和 VM 在重启后执行 Reconcile；
- 状态不确定时转入 Blocked 或等待用户，不盲目重放桌面动作；
- SQLite 定期备份，备份包含配置和 Worker/任务元数据；
- VM 磁盘备份与数据库备份保持版本关联；
- Pi、模型配置、Guest Agent 和镜像版本固定并可回滚；
- Golden Image 更新不自动改变已有 VM；
- 应用升级先迁移数据库备份，再运行 Schema Migration；
- Electron 窗口退出与本地后台服务退出分开处理；
- 宿主机休眠、断电和 Guest 崩溃纳入故障测试。

## 16. 可观测性与评测

### 16.1 本地诊断

- 控制平面、Supervisor、Guest Agent、Worker、Connector 分别记录结构化日志；
- Task Trace 关联任务、Worker、VM、动作、截图、审批和结果；
- 提供本机诊断包，但导出前提示敏感内容；
- 默认不向外部遥测服务上传任务内容。

### 16.2 Computer Use 评测

建立固定任务集，按本期开发顺序覆盖：

- Linux 先行全链路，随后在本期后段加入 Windows；
- 浏览器和本地桌面应用；
- 中文输入、滚动、拖拽、文件上传下载；
- 分辨率/DPI 变化；
- 应用报错、弹窗、网络失败；
- VM 停止和重启后的恢复；
- 人工接管和取消；
- 长任务上下文压缩；
- 多项目共享 VM 排队；
- Router 复用、归档和恢复 Worker。

记录任务成功率、人工接管率、平均步数、卡死率、错误恢复率和结果验证通过率。OSWorld 等基准可用于参考，但不能替代本产品真实任务集。

## 17. 主要技术风险与验证顺序

| 风险 | 需要证明的内容 | 未通过时的处理 |
| --- | --- | --- |
| Windows Host Hypervisor 兼容（P0，先行验证） | WHPX/QEMU 或 Hyper-V 能稳定运行 Linux Guest | 调整默认 Provider，保留 Provider 适配层；P0 未通过不能进入 Linux 产品开发 |
| Windows Guest 镜像供给（本期后段） | Linux 全链路验收后，证明合法 ISO 到可用 Golden Image 的自动构建 | 保留用户 ISO 与评估镜像流程，不分发无许可镜像 |
| Pi Computer Use 兼容 | 图片、工具、Thinking、RPC、恢复和长任务完整可用 | Pi 保留为 General Worker，增加专用 CUA Engine |
| Model Broker 兼容 | 流式、工具、图片、取消和重试无损 | 实现专用 Provider Adapter，不向 VM 暴露长期密钥 |
| Windows GUI 自动化（本期后段） | 桌面、DPI、Unicode、焦点和锁屏行为明确 | 不支持的安全界面转人工，不绕过安全机制 |
| Linux 桌面差异 | 默认镜像桌面和输入路径稳定 | 固定经验证的桌面栈，Wayland 单独支持 |
| 长任务可靠性 | 可验证完成、可取消、可恢复、不重复执行 | 增加检查点、人工审批和更细任务拆分 |
| 共享 VM 状态污染 | 用户能识别共享状态，项目备份独立 | 推荐独占 VM，不宣称项目强隔离 |
| 机器人平台差异 | 目标账号类型的 WebSocket 与消息权限可用 | 明示能力矩阵，可选中继只作补充 |

## 18. 技术决策冻结条件

### 18.1 Linux 先行阶段必须冻结

以下事项在对应验证前不得视为已经定型，并应在进入 Linux 产品开发前形成结论：

1. Windows Host 运行 Linux Guest 的默认 VmProvider，这是 P0 必过项；
2. Pi 是否直接承担首个 CUA Worker，还是采用双 Engine；
3. Host-Linux Guest 管理通道的最终传输方式；
4. Linux Guest 默认桌面与显示栈；
5. Model Broker 对 Pi 和目标模型的具体协议适配；
6. QQ 目标机器人类型的实际权限矩阵。

2026-11-10 验证记录：H1（Windows 11 家庭版 26200）上，MSYS2 QEMU 11.1.3 的 WHPX 加速器已实际启动 Ubuntu 24.04 Linux Guest，并通过 SSH、QMP 优雅关机和 qcow2 快照恢复验证；XFCE 桌面已通过 QMP 截图、分辨率切换、绝对鼠标和 ASCII 键盘输入验证。认证 Go Guest Agent 已在 X11 上完成 PNG 截图、鼠标、ASCII 与中文输入，未认证请求返回 401。Go `vm-supervisor.exe` 的 Host Inspect 在该宿主机返回 `ready=true` 和 `recommendedProvider=qemu-whpx`。全程普通用户权限，无需 Hyper-V 管理器或系统服务。该结果支持将 QEMU/WHPX 作为 Windows Host 的优先候选 Provider，但在 WHPX 性能与长稳、Guest RPC 短期令牌/Lease 强制接入、Wayland、Supervisor 崩溃接管和其他 Windows 版本验证完成前，第 1 项仍不冻结。桌面 QEMU 基线固定为 `-vga none -device virtio-gpu-pci -device virtio-tablet-pci`，WHPX 暂用 `-cpu qemu64`。证据见 `tests/phase0/results/`。

同日 Pi 验证记录：`@earendil-works/pi-coding-agent` 1.5.1 在 Guest 内通过 RPC 与自定义 CUA 工具完成图片回传、工具循环、活跃工具 Abort 和 Session Resume，驱动真实 Guest Agent 写入预期中文文件。随后真实 `pro` 模型经 WSL Model Broker 完成一个真实 CUA 任务，且 Guest models.json 不含上游 API Key。这些结果支持继续采用 Pi SDK/RPC 而不 Fork，并证明本地 Model Broker 的流式/图片/工具协议可行；但“Pi 直接承担 CUA Worker 还是增加专用 Engine”必须在完整真实任务集、长会话和重复运行后冻结。

### 18.2 Windows VM 阶段必须冻结

以下事项不在阶段 0 提前做可行性结论，等 Linux 全链路完整验收后，在本期后段 Windows VM 开发前形成结论：

1. Windows Guest 的合法镜像来源、分发和激活流程；
2. Windows Host 运行 Windows Guest 的 Provider 能力与默认选择；
3. Windows Guest 的显示、DPI、桌面会话和 Guest Agent 输入路径；
4. Windows Pi Worker、Model Broker 和 Computer Use 兼容结果；
5. UAC、锁屏、安全桌面和人工接管的能力边界。

Windows Guest 的延迟验证只改变开发顺序，不改变其属于本期最终交付范围的决定。

### 18.3 2026-11-10 Linux 先行阶段冻结结果

基于 `tests/phase0/summary.md` 中的真实验证记录，以下选型进入产品化基线：

1. **Windows Host 默认 VmProvider 冻结为 QEMU + WHPX**：使用 MSYS2 UCRT64 QEMU 11.1.3，普通用户权限，不依赖 Hyper-V 管理器。桌面 QEMU 参数固定 `-vga none -device virtio-gpu-pci -device virtio-tablet-pci`，默认 `-cpu qemu64`。Hyper-V 仅保留为待 Pro/Enterprise 环境验证的备选，不宣称已支持。非 ASCII 路径通过 Windows 短路径或 ASCII junction 解析；非 ASCII 文件名仍明确报错。
2. **Pi 直接承担首个 CUA Worker**：使用 Pi 1.5.1 RPC 与自定义 CUA 工具，不 Fork Pi，暂不增加独立 CUA Engine。若后续完整真实任务集或长会话基线不达标，再启用专用 Engine 备选。
3. **Guest 管理通道**：首版使用 QEMU loopback hostfwd + Guest Agent HTTP + Bearer 认证。生产接入必须补充短期令牌签发/撤销和 Per-VM Lease 强制校验；当前静态测试令牌只属于验证原型。
4. **Linux 默认桌面冻结为 XFCE + LightDM + Xorg**。Wayland 首版不支持，Guest Agent 在非 X11 显示栈上必须返回明确不可用，不能误报能力。
5. **Model Broker 采用宿主侧本地代理**：真实上游凭据只存在宿主/WSL，VM 使用本地 Broker Token；已验证 OpenAI-compatible 的流式、图片和工具调用。生产需补模型白名单、短期令牌、用量、超时和撤销。
6. **机器人框架保持本地 Ingress + 持久化去重**：飞书生产使用官方 `@larksuiteoapi/node-sdk` WSClient；QQ 保留经过 openclaw-qqbot 对照的最小适配器；BotPlatform 为开放字符串，后续可增加 OneBot/Discord/Telegram 等。真实飞书/QQ 权限矩阵和平台重推行为在获得测试凭据前仍未验证。

这些冻结不代表外部验收全部完成：Epiphany HTML5 drag-and-drop 失败、一次 Guest 内核 panic、Hyper-V/Wayland/真实机器人凭据和更长 soak 均保留为显式限制或发布门槛。

其余领域模型、本地优先、VM 多对多绑定、Per-VM Lease、Worker Registry、任务看板和本地机器人长连接是当前架构基准。

## 19. 参考资料

- Pi 官方仓库：https://github.com/badlogic/pi-mono
- Pi SDK：https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md
- Pi RPC：https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
- Pi Agent Core：https://github.com/badlogic/pi-mono/tree/main/packages/agent
- Agent S：https://github.com/simular-ai/Agent-S
- OpenStack VM 镜像指南：https://docs.openstack.org/image-guide/obtain-images.html
- Ubuntu Cloud Images：https://cloud-images.ubuntu.com/
- Microsoft Hyper-V 要求：https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/reference/hyper-v-requirements
- 飞书事件订阅：https://open.feishu.cn/document/server-docs/event-subscription-guide/overview
- QQ 事件订阅与通知：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
