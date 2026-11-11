# 阶段 6 验收记录：Pi Worker、会话和模型接入

日期：2026-11-11

## 结论

阶段 6 的代码主链路、自动化测试和真实本地进程 Smoke 已完成。Pi Worker Runtime 通过认证 Guest RPC 接入 TaskService 认领、统一 Execution Lease、Worker Registry 和持久会话；Model Broker 使用宿主机短期令牌转发 OpenAI-compatible 与 Anthropic Messages 请求，长期 Provider Key 不进入 Guest；Worker Engine Adapter 支持 Start、Prompt、Steer、Follow-up、Abort、Subscribe、Archive 和 Native Resume；控制平面重启后保留 Worker 绑定和会话引用并显式对账，不重放旧桌面动作。

机器结果：[`results/2026-11-11-smoke.json`](results/2026-11-11-smoke.json)。其中 `realModel=false`、`realQemuWxpx=false`、`browserElectronUi=false`，Smoke 的 Guest Worker 使用本仓库假的 Pi RPC 进程。

**边界说明**：本轮没有启动真实 QEMU/WHPX、Linux Golden Image、真实 Pi 1.5.1 进程或真实模型 Provider。Smoke 使用真实控制平面、真实 SQLite、真实 HTTP/SSE Model Broker、真实 Node 子进程和真实 Worker RPC 客户端/服务端，但 Pi 端是固定协议的测试进程；因此不把结果表述为真实 VM 内 Worker、真实模型 CUA 成功率或人工 UI 验收通过。

## 6.1 Worker Runtime 与 Guest RPC

已实现：

- `packages/agent-runtime` 提供 `WorkerRpcServer` / `WorkerRpcClient`：JSONL Pi RPC 进程封装、Bearer 认证、SSE 事件流（`after` 序号重连回放）、命令超时、请求/响应大小上限和明确版本握手。
- Pi 固定 `@earendil-works/pi-coding-agent@1.5.1`，Engine 版本 `1.5.1`，Session Format `1`；版本不兼容时 Worker 创建或恢复在启动 Pi 前失败，不读写不兼容会话。
- 每个 Worker 独立 Pi 子进程、独立 `HOME` 和 session 目录，不跨项目/VM 共享。模型短期令牌在会话启动时由 Host 通过 session spec 写入 Guest Worker 的 `<session-root>/<workerId>/home/.pi/agent/models.json`（0600），不写入镜像。
- 会话归档写入 JSONL 备份、大小和 SHA-256 manifest；恢复只接受运行时根内的普通文件、校验 manifest/哈希/版本，备份恢复到新的 session 文件。没有“无损恢复”的伪造降级；Summary 恢复属于显式 Host 启动路径。
- `images/linux/**` 提供 Worker Runtime 安装资产：固定 Node 24.18.0 与 Pi 1.5.1，非 root `aib-worker` 用户、systemd 单元、可选 CUA extension、RPC token 文件、受控 cloud-init 说明；安装脚本要求显式绝对路径和 SHA-256，且不在 Guest 写 Provider Key。
- `pnpm package:worker-runtime` 生成 `release/worker-runtime/agent-in-box-worker-0.1.0.tar.gz` 与 SHA-256，归档根含自包含 CommonJS `dist/worker-rpc-main.js`。

逐项验收：

- [x] Worker RPC 令牌轮换后旧令牌立即失效。
- [x] Worker 版本/Session 不兼容明确失败，不打开不兼容会话。
- [x] Worker 以 Guest 非 root 用户资产运行（安装资产已准备；真实 Golden Image 启动验证见未关闭项）。

## 6.2 Model Broker

已实现：

- Provider 配置（`model_providers`）只保存 base URL、API 类型、凭据 Provider ID 和模型白名单；长期密钥只由 Electron Main 的 `safeStorage` 解密，经 0600 描述文件和进程内 Bearer 桥按需提供给控制平面。
- 短期 `model_tokens` 令牌绑定 Worker、VM、session、Provider、模型和可选任务；TTL 默认 5 分钟，Worker Runtime 定期续期；控制平面重启撤销全部旧令牌。
- Broker 只接受 Host 配置的 Provider/模型，Guest 不能指定任意上游地址；每次请求重新校验令牌、模型白名单、任务归属（任务必须仍在该 Worker 上运行）、并发和每分钟频率。
- OpenAI-compatible `/v1/chat/completions` 与 Anthropic Messages `/v1/messages` 按原始请求体转发；SSE 字节流不改写，图片、工具、Thinking 内容块由 Pi/Provider协议自行承载。仅在收到任何上游响应前对连接错误和 429/502/503/504 做有限重试。
- 撤销令牌会中断进行中的流；请求记录包含上游状态、尝试次数、时长、token usage 和错误代码，不记录请求/响应正文或密钥。
- 上游密钥作为 Guest Broker Bearer 会被拒绝；Guest 会话文件只有短期令牌哈希对应的原文，不含长期 Key。

逐项验收：

- [x] VM 镜像/会话文件中没有长期 Provider Key（Smoke 校验 Guest `models.json`）。
- [x] 撤销令牌后 Broker 返回 401；绑定任务取消后返回 409。
- [x] Provider 流式文本、usage 与上游错误协议保持原样。
- [ ] 真实 Provider 的 Computer Use/Anthropic Messages 兼容性与限流行为仍需真实凭据验收。

主要路由：

```text
GET/PUT       /api/v1/models/providers
GET           /api/v1/models/requests
POST          /api/v1/models/tokens/:id/revoke
POST          /v1/chat/completions      (Broker, Bearer 短期令牌)
POST          /v1/messages              (Broker, Bearer 短期令牌)
```

## 6.3 Worker Engine Adapter 与调度

已实现：

- Worker 创建/复用、Guest RPC 握手、Pi session 启动、Provider/模型持久化、心跳和运行视图；`workers` 表新增 `agent_session_ref`、`session_version`、`last_heartbeat_at`、归档摘要、错误和 Broker token 引用。
- Worker Runtime 周期对账：认领 `queued` 任务、获取统一 Execution Lease、把任务目标 Prompt 给 Pi、将 Pi 事件映射为 TaskEvent（`worker.turn_started`、`worker.tool_started`、`worker.tool_finished`、`worker.steer`、`worker.follow_up`、`worker.turn_finished`、`worker.aborted`、`worker.failed`）并持久化会话消息。
- 回合结束时任务进入 `blocked`（`awaiting_verification`），释放 Lease 并解除令牌的任务绑定；阶段 7 的独立完成校验实现前，不以模型自称完成作为成功标准。
- 任务取消通过周期对账触发 Pi `abort`，停止工具执行、释放 Lease、Worker 回到 idle，任务保持 `cancelled`。
- RPC 断线/进程失败：撤销 Broker 令牌、释放 Lease、任务 `failed`（`worker_rpc_failed`）、Worker `failed` 并保留 `agent_session_ref` 供显式恢复。
- 控制平面重启：旧 Worker 标记 `failed`（`control_plane_restarted`），运行中任务 `failed`（`worker_runtime_restarted`），保留 Worker 绑定和会话引用；`POST /workers/:id/resume` 通过持久引用 Native Resume，成功后才回到 idle。
- 会话归档：仅 idle 且无任务时可归档；保存归档引用/摘要并撤销令牌；恢复入口重新签发短期令牌并 Native Resume。
- Web/Electron 共用 `WorkerPanel`：项目内 Worker 列表、绑定 VM 选择、消息历史、Prompt/Steer/Follow-up/Abort/Archive/Resume；不提供伪造任务完成入口。

主要路由：

```text
GET/POST       /api/v1/workers
GET            /api/v1/workers/:id
GET            /api/v1/workers/:id/messages
POST           /api/v1/workers/:id/prompt
POST           /api/v1/workers/:id/steer
POST           /api/v1/workers/:id/follow-up
POST           /api/v1/workers/:id/abort
POST           /api/v1/workers/:id/archive
POST           /api/v1/workers/:id/resume
```

逐项验收：

- [x] 用户可在项目会话中持续与 Worker 对话（Prompt 创建任务；Steer/Follow-up 插入当前/下一回合）。
- [x] Steer 与 Follow-up 行为可区分（`queued`/`handled` 返回值独立持久化）。
- [x] Abort 后工具执行停止且任务状态准确（取消触发 Pi abort，任务保持 cancelled；手动 Abort 进入 blocked）。
- [x] 控制平面重启不丢 Worker 绑定（绑定/会话引用保留，恢复为显式动作）。
- [x] Worker 状态、心跳、当前任务和错误持久化。
- [x] 会话备份与 Native Resume 入口可用。
- [ ] 真实浏览器/Electron 中人工操作 Worker 面板、消息流和布局/可访问性复核尚未执行。

## 自动化与真实进程证据

- 全仓 `pnpm check`：lint、typecheck、183 个 Vitest 测试（1 个环境依赖测试跳过）、Go test 和全部构建通过。
- `packages/agent-runtime` 新增 Worker RPC、令牌轮换、事件重放、归档校验和 Native Resume 测试。
- 控制平面新增 Worker Runtime（回合、Steer、取消→Abort、断线、重启→恢复）和 Model Broker（流式 usage、模型白名单、任务取消门控、令牌撤销、活动中流撤销中断）测试。
- 桌面壳新增凭据桥测试：0600 描述文件、Bearer 校验、解密成功/缺失和退出清理。
- Go VM Provider 为 Guest Worker RPC 分配独立回环端口并生成 `hostfwd=...-:7612`，QEMU 参数测试覆盖。
- `pnpm smoke:phase6` 在真实控制平面进程中验证 11 项：迁移/Worker 握手、Guest 无长期 Key、事件/消息/Lease、取消→Abort、RPC 令牌轮换、Broker 流式/usage/撤销、重启对账、Native Resume、归档恢复和恢复后继续接收任务。
- `pnpm smoke:phase2`、`smoke:phase3`、`smoke:phase4`、`smoke:phase5` 回归通过；新增 Worker/Model 路由、Model Broker 监听和事件 WebSocket 未造成既有主链路回归。

## 未关闭的限制

1. **真实 Guest 镜像与 systemd 未验收**：安装资产、unit 和 cloud-init 示例已准备，但未在真实 QEMU/WHPX Linux Guest 中安装、启动并完成一次真实 Pi 任务。
2. **真实 Pi/模型未验收**：Smoke 使用测试 Pi RPC 进程；真实 Pi 1.5.1 的 Computer Use、Thinking、长会话压缩和真实 Provider 流式兼容性仍按阶段 0 资产单独执行。
3. **完成校验属于阶段 7**：Worker 回合结束只把任务置为 Blocked；没有自动完成、没有目标完成机器检查，也没有 Computer Use Trace/Policy/Approval。
4. **Guest 重连可能留下旧 Pi 进程**：Host 重启后可能不再持有原 RPC 订阅；Guest Worker RPC 的 Reconcile/孤儿进程清理需在后续 Heartbeat/TTL 策略中补强。当前 Host 不重放旧动作，恢复是显式动作。
5. **自动恢复未启用**：控制平面重启后将 Worker 标记 failed，要求显式 Resume；不自动假定 Guest Pi 进程仍健康。
6. **Broker 真实上游限制**：Anthropic Messages 透传路径尚未与真实 Anthropic/兼容端点验证；速率限制是进程内每分钟上限，不是分布式限额。图片/Thinking 块由协议透传，本轮没有真实模型回归。
7. **Provider 凭据配置体验**：WorkerPanel 已提供 Provider/模型白名单保存入口，长期密钥仍使用既有首次向导/安全设置的凭据录入；两者当前需要用户手动保持 Provider ID 一致，后续应合并为单一设置流程并支持多模型编辑。
8. **真实 QEMU/WHPX、WHPX 稳定性、noVNC 人工交互、NSIS 干净安装与飞书/QQ 长连接**继续按阶段 2～5 记录跟踪。

## 复现

```bash
pnpm check
pnpm smoke:phase6
pnpm package:worker-runtime
```

机器结果可另存到 `AGENT_IN_BOX_PHASE6_RESULT`。CI 不启动真实 QEMU/WHPX、真实 Pi 或真实模型。Guest 安装资产说明见 [`images/linux/README.md`](../../images/linux/README.md)。
