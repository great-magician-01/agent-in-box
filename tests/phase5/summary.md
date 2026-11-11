# 阶段 5 验收记录：项目、绑定和任务内核

日期：2026-11-11

## 结论

阶段 5 的代码主链路、自动化测试和真实控制平面 HTTP/WebSocket Smoke 已完成。项目/VM 多对多绑定、任务持久化与 Per-VM 串行队列、依赖/取消/重试、完成产物校验和看板全量重同步均已落地。

机器结果：[`results/2026-11-11-smoke.json`](results/2026-11-11-smoke.json)。其中 `realQemuValidated=false`、`browserInteractionValidated=false`、`workerRuntimeIntegrated=false`。

**边界说明**：Smoke 使用真实控制平面进程和独立打开同一 SQLite 数据库的服务端 `TaskService` Worker 驱动。VM 电源状态为预置测试数据；没有启动 Pi RPC、QEMU/WHPX 或浏览器/Electron，因此不将这些结果表述为真实 Worker、Hypervisor 或人工 UI 验收。

## 5.1 Project 与 ProjectVmBinding

已实现：

- 项目创建、读取、更新、删除、归档和恢复；名称、描述和默认 Guest 工作目录校验。
- 多项目绑定同一 VM、单项目绑定多台 VM；停止 VM 也可绑定。第一个绑定自动成为主 VM，主 VM 切换和解绑后的主 VM 递补均在事务内完成。
- 项目会话创建与列表、项目活动时间线、完成产物引用。
- 项目和 VM 页面显示全部共享项目、归档状态、VM 电源状态及活跃任务影响，明确共享桌面/软件/系统状态和跨项目串行语义。
- 有未结束任务的项目不能归档，对应 VM 不能解绑；已有任务历史的项目只能归档，不能硬删除。
- 删除项目只删除项目自有元数据，不删除 VM 记录、覆盖盘或其他项目的绑定。

主要路由：

```text
GET/POST              /api/v1/projects
GET/PATCH/DELETE      /api/v1/projects/:id
POST                  /api/v1/projects/:id/archive
POST                  /api/v1/projects/:id/restore
POST                  /api/v1/projects/:id/bindings
PATCH/DELETE          /api/v1/projects/:id/bindings/:bindingId
POST                  /api/v1/projects/:id/conversations
```

逐项验收：

- [x] 多项目可绑定同 VM。
- [x] 单项目可绑定多 VM。
- [x] 项目可绑定停止 VM。
- [x] 解绑或删除项目不会误删共享 VM。
- [x] UI 明示共享 VM 项目清单和状态影响（代码与生产构建验证；人工浏览器验收见未关闭项）。

## 5.2 Task Service

### 状态、队列与恢复

- 创建时验证活跃项目、项目/VM 绑定、来源会话、父任务和依赖任务；来源会话可省略并由服务端选择/创建项目会话。
- `x-idempotency-key` 与规范化请求 SHA-256 一起持久化；同键同请求返回原任务，同键不同请求返回 409。
- 依赖未完成时保持 `created`；依赖完成且 VM 停止时进入 `waiting_vm`，VM 运行时进入 `queued`。依赖完成后在同一完成事务中唤醒后续任务。
- `TaskService.claimNext()` 在事务中按 `priority DESC, created_at ASC, id ASC` 选择依赖已完成的排队任务，记录 `running`、Worker 和 `attempt_count`。
- Migration `004_phase5_projects_tasks` 增加部分唯一索引 `tasks_single_execution_idx`：同一 VM 最多一个 `running` 或 `waiting_approval` 任务。即使来自不同项目，也不能并行占用同一执行位置。
- 取消、失败、重试和优先级修改均有 TaskEvent 和 Outbox；重试重新校验项目未归档、VM 仍绑定、依赖和 VM 电源状态，清除旧错误/结果，下一次认领才增加尝试次数。依赖未完成时回到 `created`，停止 VM 时进入 `waiting_vm`。
- `claimNext()` 最后再次检查 VM 必须为 `running`、项目未归档且绑定仍存在；VM 停止时依赖就绪的 `queued` 会退回 `waiting_vm`。项目 Worker 遇到其他项目的队首任务返回 `null`，不抢走该任务。
- 控制平面重启不重置或重复认领持久化的运行中任务。该语义防止重复执行，但不代表真实 Worker 进程健康对账已经完成。
- 所有状态迁移、任务事件、项目活动和 Outbox 在同一 SQLite 事务中提交。

### 完成与产物

浏览器没有通用状态 PATCH，也没有 `POST /complete`。HTTP 只开放创建、取消、重试、未开始任务优先级调整和产物重新校验。

完成由后续 Worker Engine 在服务端调用：

```ts
TaskService.complete(taskId, {
  summary,
  result,
  artifacts: [{ relativePath, sha256, sizeBytes, name, mediaType }],
});
```

完成约束：

- 只有 `running` 任务可完成，结果摘要不能为空；通用 `transition(..., "completed")` 也会拒绝绕过。
- 产物只能引用 Storage Manager `artifacts/` 内的相对 POSIX 路径；拒绝绝对路径、`..`、反斜杠路径和符号链接。
- 只打开一次产物文件：支持的宿主使用 `O_NOFOLLOW`，并校验文件描述符和真实路径，随后从同一个描述符流式计算 SHA-256、核对实际大小；不再通过第二个路径打开绕过检查。错误哈希、缺失文件、符号链接或路径越界不会完成任务。
- 重新校验先检查任务/产物归属，错归属返回 404 且不写时间线。校验失败清空 `verifiedAt`，并事务化记录 `task.artifact_verification_failed` 和 Outbox。
- 状态、结果、产物引用、TaskEvent 和 Outbox 在事务中提交；后续可重新校验，篡改后 `verifiedAt` 会清空并返回错误。

主要路由：

```text
GET/POST        /api/v1/tasks
GET             /api/v1/tasks/board
GET             /api/v1/tasks/:id
PATCH           /api/v1/tasks/:id/priority
POST            /api/v1/tasks/:id/cancel
POST            /api/v1/tasks/:id/retry
POST            /api/v1/tasks/:id/artifacts/:artifactId/verify
```

逐项验收：

- [x] 所有状态迁移合法且有事件。
- [x] 同 VM 任务串行，即使来自不同项目。
- [x] 真实控制平面重启后任务不会重复执行/认领。
- [x] 前端不能直接将任务伪改为完成。
- [x] 任务完成结果和产物校验接口已实现并测试。

## 5.3 基础任务看板

已实现：

- 展示已创建、等待资源、等待 VM、排队、执行中、等待审批、阻塞、完成、失败和取消状态。
- 按项目、VM、Worker 和状态筛选；显示依赖数、Worker、队列位置和优先级。
- 支持未执行任务的优先级修改、取消、失败重试和任务详情。
- 详情展示结果/错误、依赖、产物、TaskEvent 时间线，并可跳转项目、VM 锚点和来源会话。
- `/api/v1/events/ws` 使用回环、Host 和 Origin 校验；与 noVNC 各自只处理自己的 upgrade 路径。
- Outbox 发布器发送带单调 `eventId`、`eventVersion=1`、协议版本、时间和任务上下文的失效通知。
- WebSocket 不是另一套任务事实，也不承诺离线增量重放；浏览器在每次打开/重连后请求 `/api/v1/tasks/board` 完整数据库快照。并发刷新会合并，避免事件风暴造成重复请求。

逐项验收：

- [x] 看板与数据库一致。
- [x] 重连后完整同步，不只依赖漏收的增量事件。
- [x] 任务详情能跳转项目、VM 和来源会话。
- [ ] 真实浏览器和打包 Electron 的人工交互、响应式布局与可访问性复核尚未执行。

## 自动化与真实进程证据

- 全仓 `pnpm check`：lint、typecheck、168 个 Vitest 测试、Go test 和全部构建通过；1 个环境依赖测试显式跳过。
- 控制平面：17 个测试文件、85 个测试通过；新增项目 CRUD/绑定/归档、依赖、跨项目队列、取消/重试、重启认领、产物、WebSocket 和 upgrade fallback 测试。
- `pnpm smoke:phase5`：10 项真实控制平面检查通过，覆盖上述项目、任务、产物、重启和重连主链路。
- `pnpm smoke:phase2`、`pnpm smoke:phase3`、`pnpm smoke:phase4` 回归通过：首次启动/存储迁移、镜像续传/VM 管理、noVNC 与新增事件 WebSocket 路由共存，统一 Lease 输入门控无回归。
- `pnpm package:control-plane`、`go vet ./...` 和 CI 同款关键 Go 包 race 测试通过。
- Smoke 在任务 `running` 时真实停止并重启控制平面；重启后认领返回 `null`，任务仍为 `running`，`attemptCount=1`。
- 独立代码审查后补测并修复：同项目详情跳转被清空、归档/解绑/停止 VM 的重试与认领绕过、Worker 跨项目队首冲突、产物错归属副作用、未知 upgrade 悬挂、产物二次路径打开竞争，以及畸形 workspaceConfig 返回 500/重置配置。最终全部回归通过。
- 初版 Smoke 在末尾等待一个已于控制平面重启时发生的 `close` 事件而超时；脚本改为识别已关闭状态并为等待增加 5 秒超时后通过。该问题是测试等待时序，不是事件服务关闭失败。
- CI Windows/Linux 矩阵新增 `pnpm smoke:phase5`，并上传 `phase5-smoke-<OS>` artifact。

## 错误、取消和故障行为

- 无效项目/VM/会话/路径返回 `validation_failed`（400）；不存在资源返回 404；非法状态迁移、归档/解绑冲突和幂等键冲突返回 409。
- 重复取消已取消任务幂等返回；完成或失败任务不能取消。只有失败任务可以重试。
- Outbox 发布失败保留未发布记录并由定时器重试；WebSocket 发送失败只移除该连接，客户端通过全量快照恢复。
- 当前离线事件不作为可靠逐条日志；`eventCursor` 用于诊断快照位置，不用于替代数据库读取。
- 项目删除失败不会删除 VM；产物校验失败不会改变运行中任务状态。

## 尚未关闭的限制与阶段 6 依赖

1. **Pi Worker 未接入**：`claimNext/complete/fail` 当前由服务端测试驱动调用；阶段 6 必须接 Pi RPC、Worker Registry、心跳和真实进程对账。
2. **运行中取消尚未触发 Pi Abort**：本阶段没有真实 Worker 可中止。阶段 6 必须把取消映射到 Engine Abort、工具停止和 Execution Lease 释放，不能只更新数据库。
3. **重启对账仍限于不重复认领**：持久化 `running` 不等于 Pi 进程健康。阶段 6 需明确恢复、失败或 Blocked，不允许旧动作盲放。
4. **自动 VM/资源调度属于阶段 9**：本阶段停止 VM 上的任务等待启动，不自动启动 VM，也不处理 Host 资源预算。
5. **真实 UI 验收未执行**：生产构建通过，但未在浏览器/Electron 人工点击项目、筛选、跳转和控制台联动。
6. **产物下载与独立任务验证器**：本阶段提供引用和哈希校验；用户下载、阶段 7 的机器可检查完成条件和 Computer Use Trace 仍需后续实现。
7. **依赖失败/取消传播**：依赖未成功完成时后续任务不会执行；当前保持等待状态并在依赖详情中显示失败/取消，尚需后续策略决定自动 Blocked、取消还是显式恢复，避免长期等待被忽略。
8. 既有真实 QEMU/WHPX、X11/noVNC、Electron 托管 Supervisor、NSIS 干净安装和长时稳定性门槛继续按阶段 2～4 记录跟踪。

## 复现

```bash
pnpm check
pnpm smoke:phase5
```

机器结果可另存到 `AGENT_IN_BOX_PHASE5_RESULT`。CI 不启动真实 QEMU/WHPX、Pi 或模型服务。
