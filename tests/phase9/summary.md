# 阶段 9 验收记录：多 VM 资源调度、共享环境与多端状态同步

日期：2026-11-11

## 结论

阶段 9 的代码主链路、自动化测试和真实本地进程 Smoke 已完成。Resource Manager 从 SQLite 和宿主内存计数重建资源报告，按 Soft Memory Budget 自动启动/恢复 VM、将资源不足的任务置为 `waiting_resources`，并在无任务、无 Worker、无 Lease 时执行空闲休眠。共享 VM 的整机快照恢复会先列出全部受影响项目并要求显式确认；项目目录备份独立保存 Guest workspace tar.gz 和产物引用，恢复只覆盖本项目目录。看板、VM 页和项目页共享同一数据库快照，任务详情可跳转实时控制台和 Worker 会话。

机器结果：[`results/2026-11-11-smoke.json`](results/2026-11-11-smoke.json)。其中 `realQemuWxpx=false`、`realLinuxGuest=false`、`realWorkerPi=false`、`realRouterPi=false`、`realModel=false`、`browserElectronUi=false`；Supervisor 与 Guest Agent 为协议测试替身。

**边界说明**：本轮没有启动真实 QEMU/WHPX、Linux Golden Image、真实 Pi 或模型。Smoke 使用真实控制平面、真实 SQLite、真实宿主内存计数、真实 HTTP API 和真实 workspace 流式传输，但 Supervisor 生命周期、Guest workspace archive/restore 和 Guest health 使用固定协议的测试服务；不把结果表述为真实 QEMU 快照、真实 Guest 目录归档或人工 UI 验收通过。

## 9.1 Resource Manager

已实现：

- `ResourcePolicy` 扩展 `softMemoryBudgetBytes`（0 = 总内存 - Host Reserve）、`idleSuspendEnabled`、`idleSuspendTimeoutMs`；旧设置读取时自动补齐并校验，Dashboard 可配置。
- `GET /api/v1/resources` 报告宿主总/可用内存、预算、运行/休眠 VM、已分配内存、等待资源/等待 VM/排队任务、压力等级、自动启动阻塞列表和每个 VM 的资源分配。
- `POST /api/v1/resources/reconcile` 与后台 tick 共用 `ResourceManagerService.reconcile()`：
  - `autoStartPolicy=when_needed` 时，对 `waiting_vm`/`waiting_resources` 任务的 stopped/suspended VM 检查预算和实际可用内存，允许则 start/resume 后 `reconcileVm` 回到队列；不允许则 `waiting_vm → waiting_resources` 并写 `resource.waiting_for_memory`。
  - 自动启动/恢复/休眠/等待均写 Outbox 通知，UI 通过 WebSocket 失效后重新读取完整快照。
  - 空闲休眠仅针对 running VM，且要求无活动任务（含 waiting/queued）、无 attached Worker（starting/running/idle/archiving/restoring）、无未过期 Lease；活动时间取 `last_started_at`、任务 `updated_at` 和 Worker `last_active_at` 的最大值。
  - 手动启动可以突破 Soft Memory Budget，VM 视图返回预算告警；系统不会为了回收资源停止有任务的 VM。
- 任务状态机新增 `waiting_vm → waiting_resources`；`reconcileVm` 不会在 VM 停止时把 Resource Manager 的 `waiting_resources` 改回 `waiting_vm`，避免状态抖动。用户手动启动/恢复 VM 后，等待任务回到 `queued`。

逐项验收：

- [x] VM 数量不受固定值限制；报告和队列均从数据库重建。
- [x] 资源足够时不同 VM 可并行运行和排队。
- [x] 资源不足时自动任务进入 `waiting_resources` 并发出通知。
- [x] 用户停止/休眠后，等待任务保持；按 `when_needed` 策略可自动恢复，或手动启动后回到队列。
- [x] 空闲休眠不会停止有任务、Worker 或 Lease 的 VM。

## 9.2 共享 VM 项目保护

已实现：

- VM 页和项目页展示共享项目、共享桌面/软件/系统状态提示；`VmSharingView` 汇总绑定项目与警告。
- 整机快照：`vm_snapshots` 记录 tag、标签、状态、创建时绑定项目、恢复时间；Go Supervisor 新增 snapshot create/restore 和 VM delete 路由，Provider 仍要求 stopped。
- 快照恢复影响预览 `GET /api/v1/vms/:id/snapshots/:snapshotId/impact` 返回当前全部绑定项目、每项目活动任务数/最近活动、绑定集合是否变化、阻塞原因；共享快照要求 `confirmSharedImpact=true`。恢复前同时检查 stopped、无活动任务、无 Lease。
- 项目目录备份：`project_backups`、`project_backup_bindings` 保存项目每个 VM 绑定的 workspace tar.gz 路径、SHA-256、大小、文件数、状态和产物引用快照；`GET/POST /api/v1/projects/:id/backups`、impact、restore、verify、delete。`verify` 同时校验工作目录归档和产物引用的存在、大小与 SHA-256，作为项目级产物版本检查。
- Guest Agent 新增 `GET /v1/workspace/archive` 与 `POST /v1/workspace/restore`：
  - 仅允许配置的 `WorkspaceRoots` 内路径；拒绝 `..`、NUL、根目录和越界 realpath。
  - archive 拒绝符号链接和特殊文件，输出有界 tar.gz，返回 SHA-256/文件数/原始字节数。
  - restore 校验 SHA-256，staging 目录解包后 rename 原子替换；拒绝符号链接、硬链接、绝对路径和路径逃逸。
- 项目恢复前检查绑定仍存在、Guest 目录未变化、无活动任务/Lease、VM 运行、备份文件存在；如果目录被其他项目绑定，明确阻止，避免静默覆盖其他项目。恢复按绑定逐个执行并持有 human Lease；多绑定恢复不是跨 VM 原子操作，会在状态和错误中体现。
- 项目删除检查任务、Worker、归档历史，并在删除前清理项目备份文件；VM 删除检查项目绑定、任务、Worker/归档、项目备份引用和 Lease，只允许无依赖的 stopped VM。
- Worker 恢复上下文新增 `sharedVm`、`sharedProjects`（含归档状态和活动任务数）以及 `changesSinceArchive`（VM 电源变化、本项目新任务/活动、共享项目离开期间活动）；恢复首回合注入这些增量。

逐项验收：

- [x] 恢复共享 VM 快照前明确列出全部受影响项目，并要求显式确认。
- [x] 项目级备份可以独立校验和恢复，不使用整机快照回滚单项目。
- [x] 共享 VM 上其他项目不会被静默删除或回滚；共享目录冲突会阻止恢复。
- [x] 项目/VM 删除有显式依赖检查，不会级联删除共享数据。
- [x] Worker 恢复包含共享环境增量摘要。

## 9.3 完整多端状态同步

已实现：

- `TaskBoardItem.vmPowerState`、`TaskBoardSnapshot.resources`：看板展示任务目标 VM 电源状态、等待资源/等待 VM、预算与自动启动阻塞。
- `VmInstanceView.queue`、`activeWorkers`、`sharing`、`scheduling`：VM 页显示完整活动队列（含队列位置）、活跃 Worker、共享警告、自动启动决策、空闲休眠最早时间与阻塞原因。
- `ProjectBindingView.activeWorkers`、`queueDepth`、`ProjectView.activeWorkerCount`：项目页显示所有绑定、每绑定的活跃 Worker 和排队深度。
- 任务详情新增“打开实时控制台”和“打开 Worker 会话”；控制台请求经 Dashboard 传给 VmManager，自动滚动并建立 noVNC 会话；Worker 会话跳转会切换项目并聚焦 Worker。
- VmManager 订阅任务 WebSocket 失效通知，断线重连后重新读取 VM/资源/快照完整快照；WorkManager 原有重连全量同步保持。
- Router、看板、项目、VM 页均读取同一 SQLite 事实；Router 工具不维护独立任务状态。

逐项验收：

- [x] 同一任务在 Router（数据库事实）、看板、项目和 VM 页状态一致。
- [x] 所有页面在断线重连后能通过完整快照对账恢复。
- [x] 看板包含等待资源与 VM 状态，VM 页包含队列与当前 Worker，项目页包含绑定与活跃 Worker。
- [x] 任务可跳转实时控制台和 Worker 会话。

## 自动化与真实进程证据

- 全仓 `pnpm check`（lint、typecheck、Vitest、Go 测试、构建）通过。
- 新增/更新控制平面测试：
  - `resource-manager.service.test.ts`：软预算阻塞、自动启动、不同 VM 按预算并行启动、suspended resume、空闲休眠、活动任务阻止休眠。
  - `snapshot.service.test.ts`：共享 VM 影响列表、确认门槛、运行/任务阻塞、Provider 失败状态。
  - `project-backup.service.test.ts`：备份/校验/恢复、共享目录冲突、VM 停止和活动 Worker 阻塞。
  - `vm.service.test.ts`：VM 删除依赖检查。
  - `project.service.test.ts`：Worker 历史阻止项目删除。
  - `worker-runtime.service.test.ts`：恢复上下文包含共享项目和离开期间增量。
- Go 测试新增 `workspace_test.go`（archive/restore、越界路径、符号链接归档拒绝）和 Supervisor snapshot/delete 路由测试。
- `pnpm smoke:phase9` 10 项通过：迁移与资源报告、预算不足等待、预算恢复自动启动、看板/VM/项目页一致、共享快照影响确认、项目备份独立恢复、VM 删除依赖、空闲休眠保护、项目删除依赖、全量快照对账。
- CI 增加 phase 8/9 Smoke；Smoke 结果上传为 artifact。

## 未关闭的限制

1. **真实 QEMU 快照未回归**：Go Provider 的 `qemu-img snapshot -c/-a` 已有单元测试，但阶段 9 Smoke 使用假 Supervisor；未在真实 QEMU/WHPX 上验证大磁盘快照耗时、失败恢复和 Windows 路径。
2. **真实 Guest workspace 归档未回归**：Go archive/restore 端点和流式传输有单元测试，但未在真实 Linux Guest 上验证大目录、权限、符号链接常见场景和真实磁盘压力。
3. **项目备份不是跨 VM 原子操作**：多绑定项目逐 VM 恢复；中途失败会保留已完成绑定并将备份标记 failed，需人工核对。
4. **符号链接和特殊文件会阻止备份**：为避免越过 workspace root 和恢复逃逸，包含符号链接/设备文件的目录当前不能备份，需用户整理目录或后续实现受限的链接保留策略。
5. **资源调度只覆盖内存**：Soft Memory Budget 与 Host Reserve 只基于内存；未调度 CPU、磁盘 IO、GPU 或宿主负载。手动启动允许突破预算。
6. **实际可用内存判断依赖宿主计数**：WSL/Windows 的 `freemem` 语义可能低估可用内存，导致自动启动偏保守；需要真实环境调参。
7. **空闲休眠的活动定义有限**：使用任务、Worker 心跳、VM 启动时间；控制台连接通过 human Lease 阻塞，但未纳入其他宿主侧活动（如手工文件操作）。
8. **环境增量是数据库语义摘要**：不包含未落库的 Guest 桌面瞬时变化、剪贴板或其他项目的人工操作细节。
9. **快照/备份无保留期限**：快照记录和项目备份当前只写不清理；发布前需要保留策略、空间配额和敏感内容清理。
10. **人工 UI 未验收**：资源面板、快照确认、项目备份、控制台/Worker 跳转已实现，但未做真实浏览器/Electron 可用性和可访问性验收。
11. **API 认证仍是本地回环模型**：项目备份下载/恢复依赖 Guest 令牌和回环 API；完整本地管理员认证/CSRF 在阶段 11～12。

## 复现

```bash
pnpm check
pnpm smoke:phase9
pnpm smoke:phase8
```

机器结果可另存到 `AGENT_IN_BOX_PHASE9_RESULT`。CI 不启动真实 QEMU/WHPX、真实 Pi、真实模型或真实 Guest 桌面。
