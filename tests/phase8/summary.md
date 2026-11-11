# 阶段 8 验收记录：Router、Worker Registry 与归档

日期：2026-11-11

## 结论

阶段 8 的代码主链路、自动化测试和真实本地进程 Smoke 已完成。Worker Registry 每次从 SQLite 重建 Active Roster，Archive Registry 保存可搜索的会话引用、恢复点、摘要和产物；宿主 Router 只通过回环短期令牌访问项目/任务/Worker/看板/归档工具，工具调用全部审计，Router 没有任何 VM 输入、Shell 或 Supervisor 工具。Worker 支持空闲自动归档、阻塞条件、同版本原生恢复、显式摘要降级和新 Worker 加载归档摘要；恢复前捕获最新截图和离开期间的项目/VM 变化并注入首回合，后续桌面输入仍必须先重新观察。

机器结果：[`results/2026-11-11-smoke.json`](results/2026-11-11-smoke.json)。其中 `realGuestAgent=false`、`realPiProcess=false`、`realRouterPi=false`、`realModel=false`、`realQemuWxpx=false`、`browserElectronUi=false`。

**边界说明**：本轮没有启动真实 QEMU/WHPX、Linux Golden Image、真实 Pi 1.5.1 或真实模型 Provider。Smoke 使用真实控制平面、真实 SQLite、真实 HTTP Router Tool Broker、真实 Worker RPC 客户端/服务端，但 Guest Agent、Guest Pi 和 Router Pi 使用固定协议的测试进程；因此不把结果表述为真实 Router 决策质量、真实 VM 内恢复或人工 UI 验收通过。

## 8.1 Worker Registry 与 Conversation Binding

已实现：

- `workers` 继续持久化项目、VM、来源会话、Agent Session 引用、引擎/Session 版本和摘要；新增 `worker_archives` 保存每次归档的引用、版本、摘要、恢复点、产物和来源。
- Active Roster 是数据库读模型，不维护 Router 专用缓存：项目/VM 名称、能力、状态、当前/最近任务、VM 队列深度、待审批和排队消息数均可从 SQLite 重建。
- Archive Registry 支持项目过滤和摘要/归档引用/产物名称关键词检索；同一 Worker 新归档会把旧记录标记 `superseded`，历史仍可搜索。
- `find_related_worker` 只返回同一项目的候选；项目和状态是确定性过滤，文本重叠只影响排序。归档候选返回 `resume` 建议。
- 新增 `GET /api/v1/registry/workers`、`/workers/:id/summary`、`/workers/:id/archives`、`/archives`、`/find-related`。

逐项验收：

- [x] Router 重启后 Active Roster 和摘要从数据库完整重建（无进程内状态）。
- [x] Worker 的项目/VM/来源会话绑定持久化，不跨项目错误复用（候选查询按项目硬过滤）。
- [x] Archive Registry 在归档后保留可搜索摘要、引用和产物。
- [x] Router 获得结构化的项目、任务、Worker、看板和归档查询工具。

## 8.2 Router Runtime

已实现：

- 宿主 `RouterRuntimeService` 使用独立 Pi 进程（`--no-builtin-tools`），系统提示明确禁止 VM 桌面操作和宿主 Shell。
- 生成的 Router Pi 扩展只访问回环 Router Tool Broker（默认 `6721`）；工具令牌为短期随机值，哈希保存在 `router_sessions`，控制平面重启后旧令牌失效。
- Router 模型请求经 Model Broker，使用 `router_model_tokens` 短期令牌；长期 Provider Key 不进入 Router 进程配置或 VM。
- 工具面：`list_projects`、`list_active_workers`、`list_tasks`、`get_task`、`get_board_summary`、`get_worker_summary`、`find_related_worker`、`search_worker_archive`、`create_task`、`assign_task`、`steer_task`、`follow_up_task`、`reprioritize_task`、`cancel_task`、`retry_task`、`resume_worker`、`archive_worker`。
- 每次工具调用写入 `router_tool_calls`（参数、结果、状态、错误、耗时），并发布 `router.tool_call` 失效通知供 UI 实时刷新 Router 进度；Router 对话写入 `router_messages`。
- Router 回合有最大时长保护；超时会 Abort Pi、保留已生成文本并进入 failed，下一次消息可重试或恢复。
- `create_task` 默认使用项目主 VM；`assign_task` 只能复用目标 Worker 已绑定的项目和 VM，最终仍由 Worker Runtime 认领并经过 VM 队列/Lease。
- `POST /api/v1/router/messages` 异步受理，`GET /api/v1/router` 提供状态；WebSocket Outbox 通知 UI 重新读取完整快照。

逐项验收：

- [x] Router 工具面没有 VM 输入、Shell 或 Supervisor 接口（测试枚举并拒绝未知工具）。
- [x] 新任务分派前工具可查询已有 Worker；Smoke 验证 `list_active_workers` → `find_related_worker` → `assign_task`。
- [x] 跨项目任务只能使用目标项目绑定 VM（`create_task`/`assign_task` 由 TaskService 校验）。
- [x] Router 返回后 Worker 由 Worker Runtime 独立执行，Router 不是任务事实来源。

## 8.3 Worker 自动归档

已实现：

- `workerLifecycle` 设置（`autoArchiveEnabled`、`idleTimeoutMs`，默认 30 分钟），UI 可配置；心跳只更新 `last_heartbeat_at`，不重置空闲计时。
- 归档阻塞条件：运行/恢复上下文注入中、当前任务、活动任务、待审批、`worker_inputs` 排队 Steer/Follow-up、Per-VM Execution Lease、失败/正在归档状态。
- 归档流程：`idle → archiving → archived`；Guest 会话归档成功后写入 Archive Registry、Outbox `worker.archived` 并停止 Worker Pi，不停止 VM。
- 自动归档由 Worker Runtime tick 周期性检查；有阻塞条件时跳过并保持 idle。
- Steer/Follow-up 返回 `queued` 时写入 `worker_inputs`，回合结束标记 delivered，Abort/断线/重启标记 cancelled。

逐项验收：

- [x] 运行、待审批、排队消息或持锁 Worker 不会被归档（自动化测试覆盖）。
- [x] 归档后摘要/引用/产物仍可搜索，Active Roster 不再包含该 Worker。
- [x] Router 默认上下文不含归档 Worker 卡片；归档不删除 VM、项目或任务。
- [x] 归档只停止 Worker 进程，VM 电源状态保持不变（Smoke 校验）。

## 8.4 Worker 恢复

已实现：

- `POST /api/v1/workers/:id/resume` 支持 `auto`、`native`、`summary`：
  - 同版本 `native` 使用 Guest JSONL 备份 manifest 校验后恢复；
  - 版本不兼容、没有原生引用或 Native Resume 失败时，`auto` 显式降级为摘要语义恢复，并在响应、Outbox 和 UI 标注；
  - `summary` 强制创建新的 Agent Session，加载归档摘要。
- 恢复前从 Guest Agent 捕获最新截图，保存到 `archives/resume-contexts/` 和 `worker_resume_contexts`；同时记录 VM 电源/健康、工作区、活动任务 ID、最近任务和离开时长。
- 首回合注入环境 brief 和内联 PNG（Worker RPC 支持内联图片）；注入回合不持有任务，CUA Broker 因没有任务绑定而拒绝桌面动作。
- 后续任务仍由阶段 7 的 `requiresObservation` 和最新截图校验约束，不会使用恢复前截图直接输入。
- `POST /api/v1/workers` 支持 `restoreArchiveId`，从归档摘要启动新的 Worker。

逐项验收：

- [x] 用户能继续归档前工作（Native Resume / 摘要恢复 + 环境注入）。
- [x] 不使用过期截图直接输入（注入回合无任务绑定；后续动作需重新观察）。
- [x] 语义恢复在 API 响应、`worker.resumed` 事件和 UI 中明确标注恢复类型。
- [x] Engine/Session 不兼容时明确失败或显式降级，不伪装无损恢复。

## 自动化与真实进程证据

- 全仓 `pnpm check`：lint、typecheck、全部 Vitest/Go 测试和构建通过。
- 新增控制平面测试：
  - `worker-registry.service.test.ts`：Roster 重建、项目名/VM/队列/审批/排队消息、归档阻塞、Archive 检索、同项目关联建议。
  - `worker-runtime.service.test.ts`：手动/自动归档、待处理消息阻塞、Native Resume 截图注入、摘要降级、新 Worker 从归档恢复。
  - `router-tool.service.test.ts`：工具面白名单、主 VM 创建任务/幂等、Worker 分派、Steer/Follow-up、归档检索。
  - `router-tool-broker.service.test.ts`：短期令牌认证、HTTP 工具调用、审计、未知/过期工具拒绝。
  - `router-runtime.service.test.ts`：Router 回合持久化、并发拒绝/Abort、超时中止、重启恢复、不兼容会话清除与摘要恢复、无 Provider 失败。
- `packages/agent-runtime` 扩展 Worker RPC 内联图片输入与 16 MiB 请求上限。
- `pnpm smoke:phase8` 10 项通过：迁移、Worker 创建、Router 工具面、Router 复用 Worker 分派、取消→Abort、归档/Roster/Archive、Native Resume+截图注入、归档后 Router 创建后续任务、Router 重启恢复、Outbox/归档/恢复上下文持久化。

## 未关闭的限制

1. **真实 Router 决策质量未评估**：没有真实 Pi/模型运行；需求澄清、项目识别、复用/恢复决策和长会话压缩仍需真实 Provider 与阶段 0 任务集评测。
2. **真实 Guest 恢复未验收**：真实 QEMU/WHPX、Linux Golden Image、真实 Guest Pi 的归档/Native Resume 和截图注入仍需在 VM 中执行。
3. **摘要恢复是语义恢复**：不保留完整隐藏推理和工具上下文；UI 已标注，但不能宣称与原生恢复等价。
4. **自动归档只是 Worker 级**：不停止 VM、不做宿主资源回收；VM 空闲休眠属于阶段 9 Resource Manager。
5. **Router Pi 扩展依赖 Pi 1.5.1 的扩展/TypeBox 行为**：真实 Pi 进程加载生成的 `router-extension.js` 仍需 Golden Image 验收。
6. **Router 恢复不是无损**：Router 原生会话恢复失败时会清除失效引用，下一条消息用最近对话文本摘要启动新会话；隐藏推理和工具上下文不保留，系统提示与错误响应已明确标注。
7. **工具结果大小限制**：Router 工具结果超过 512 KiB 会拒绝审计写入并返回错误；真实大量任务查询需要分页策略。
8. **浏览器/Electron 人工 UI**：Router、Roster、归档检索与恢复按钮已实现，但未做真实浏览器/Electron 可用性和可访问性验收。
9. **安全边界**：Router Tool Broker 只监听回环并使用短期令牌，但本机恶意进程仍可能尝试竞争端口；完整本地 API 认证/CSRF 加固在阶段 11～12。
10. **归档截图保留**：恢复截图当前只写不清理；发布前需要保留期限和敏感内容清理策略。
11. **Router 会话文件未归档**：Router Pi 的 session 文件保留在数据目录 `router/pi/`，当前没有归档/清理流程；长期运行需要保留策略。
12. **Router 进度通知为拉取式**：Router 通过 `get_board_summary`/`list_tasks` 获取进度，工具调用和任务状态通过 Outbox 推送 UI；Router 自己尚未主动消费任务里程碑并生成汇总消息，主动通知留待机器人/多端阶段。
13. **恢复失败可能留下 Guest 会话**：Native Resume 失败后自动降级摘要恢复时，Guest RPC 可能已注册过旧会话；Host 不持有句柄，依赖 Guest 侧后续对账清理。

## 复现

```bash
pnpm check
pnpm smoke:phase8
pnpm smoke:phase7
```

机器结果可另存到 `AGENT_IN_BOX_PHASE8_RESULT`。CI 不启动真实 QEMU/WHPX、真实 Pi 或真实模型。Router 测试 Pi 与 Guest 测试进程均为固定协议替身。
