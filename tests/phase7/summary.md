# 阶段 7 验收记录：完整 Computer Use 执行器、保护与审批

日期：2026-11-11

## 结论

阶段 7 的代码主链路、自动化测试和真实本地进程 Smoke 已完成。Host 侧 Computer Use Broker 使用短期令牌接收 Guest Pi 工具调用，每次请求重新校验 Worker、VM、任务和 Per-VM Execution Lease，再通过 Guest Agent 执行；动作、屏幕元数据、前后截图、审批和执行限制计数持久化在 SQLite，任务看板可查看 Trace 和待审批动作。完成状态必须由 Guest 文件/进程只读证据或重新捕获的截图验证，模型自述不会使任务完成。

机器结果：[`results/2026-11-11-smoke.json`](results/2026-11-11-smoke.json)。其中 `realGuestAgent=false`、`realPiProcess=false`、`realModel=false`、`realQemuWxpx=false`、`browserElectronUi=false`。

**边界说明**：本轮没有启动真实 QEMU/WHPX、Linux Golden Image、真实 Pi 1.5.1 进程或真实模型 Provider。Smoke 使用真实控制平面、真实 SQLite、真实 HTTP CUA/Model Broker、真实 Worker RPC 客户端/服务端和真实 Node 子进程，但 Guest Agent 与 Pi 端是固定协议的测试替身；因此不把结果表述为真实 VM 内 CUA 成功率或真实 X11 输入验收通过。

## 7.1 Computer Use 工具集

已实现：

- `packages/computer-use` 动作协议扩展：截图、点击/双击（`click count=2`）、移动、输入、按键、滚动、拖拽和等待；支持 `pixels` / `normalized` 坐标空间，转换只发生在 Host 执行层。
- Host `CuaBrokerService`（默认回环 `6720`）：`POST /v1/observe`、`/v1/actions`、`/v1/complete`；Bearer 短期 `cua_tokens` 绑定 Worker/VM/session/task，控制平面重启撤销全部旧令牌。
- Guest Pi `images/linux/worker-runtime/cua-extension.js` 只访问 CUA Broker，不读取 Guest Agent token；工具结果包含最新的 `screenshotId` 和屏幕图像。
- 每个动作记录任务、Worker、VM、Lease、来源截图、屏幕宽高/DPI/缩放、参数、结果、错误、前后截图；拒绝的动作也尽力记录。
- 动作必须引用最新截图；未观察、过期截图、显示分辨率变化、坐标越界或有效 Lease 缺失都会在执行前拒绝。
- 自动化测试覆盖中文 `type_text`、滚动、拖拽、归一化坐标、分辨率变化和坐标边界。

逐项验收：

- [x] 所有动作可审计到任务和 Worker（`cua_actions`、`cua_screenshots`、`GET /api/v1/tasks/:id/trace`）。
- [x] 无有效 Lease 的动作不会执行（Broker 预检 + `GuestService.input` Lease 锁内复检）。
- [x] 中文、滚动、拖拽和分辨率变化通过自动化测试；真实 X11 回归仍待执行。

## 7.2 Agent 执行闭环与保护

已实现：

- `task_execution_state` 记录开始时间、deadline、步数、动作数、无进展/重复计数、完成尝试和是否要求重新观察。
- 最大步数、最长执行时间、连续重复动作 + 屏幕无变化、连续无进展保护和完成后回合收敛。
- 取消任务会通过 Worker tick 触发 Pi Abort，并让等待中的审批立即取消；审批超时不会执行动作。
- Worker 断线/VM 停止不会重放旧动作：VM 停止时任务进入 Blocked，并可通过 `POST /api/v1/tasks/:id/requeue` 在用户恢复环境后重新排队；新执行状态重新要求观察。
- 完成任务由 `CuaExecutionService.complete` 独立校验并写入结果证据；Pi 回合自然结束但未校验时任务仍进入 Blocked（`awaiting_verification`）。

逐项验收：

- [x] 无进展/重复任务会 Blocked，不无限点击。
- [x] 用户取消及时生效，审批等待也会被取消。
- [x] 完成状态有独立结果证据（Guest 文件/进程或重新截图）。
- [x] VM 停止时任务 Blocked 并要求重新观察，不假定旧桌面动作成功。

## 7.3 Policy 与 Approval

已实现：

- `project_policies` 保存项目级最大步数、最长执行时间、无进展/重复阈值、审批超时、需要审批的动作、网络白名单基础、文件交换根目录/大小和 Guest 凭据策略。
- 默认敏感动作由全局 `requireApprovalForSensitiveActions` 设置推导（`type_text`、`keypress`、`drag`）；项目可覆盖。
- `cua_approvals` 记录待审批、批准、拒绝、超时、取消、上下文摘要、解析人和备注；审批绑定具体动作行（`action_id` + `action_json`）。
- 审批通过只执行原存储动作；拒绝/超时/任务取消返回明确工具错误并写入 `task.approval_requested` / `task.approval_resolved` 任务事件。
- 文件证据必须位于项目允许根目录并通过 Guest 只读校验；Guest 拒绝符号链接和根目录外路径；完成摘要不允许明显凭据文本。
- 网络隔离尚未实现：`network.mode=broker_only` 会被控制平面拒绝并报告为 `unrestricted`；CUA/Model Broker 只监听 Host 回环。VNC、QMP、Guest Agent 与 Worker RPC 的宿主机转发绑定 `127.0.0.2`，Guest 经 `10.0.2.2` 无法访问这些管理端口；VM 级出网隔离仍属于后续实现项。

逐项验收：

- [x] 审批前动作不执行。
- [x] 拒绝后产生明确工具结果和任务事件。
- [x] 审批记录可审计（Trace、任务事件、数据库行）。
- [x] VM 网络访问不默认桥接宿主机管理网段；QEMU user-mode 网络和真实出网策略仍需真实 VM 回归。

## 7.4 首轮真实任务评测

**未执行。** 当前环境没有真实 QEMU/WHPX、Linux Golden Image、真实 Pi 1.5.1 或模型凭据，因此没有形成 7.4 真实基线报告，也没有 Pi 与专用 Engine 的对比数据。评测协议、字段和阶段 0 任务集映射见 [`README.md`](README.md)；记录模板见 [`task-eval-template.json`](task-eval-template.json)。真实评测必须使用独立证据（文件 SHA-256、进程、截图）而不是模型自述，关键任务至少重复 2 次。

## 自动化与真实进程证据

- 全仓 `pnpm check`：lint、typecheck、212 个 Vitest 测试（1 个环境依赖测试跳过）、Go test 和全部构建通过。
- 新增 `packages/computer-use` 测试：动作 Schema、归一化坐标转换、动作签名、显示边界和截图引用。
- 控制平面新增 16 个 CUA 执行/审批/完成测试、3 个策略测试和 3 个 CUA Broker HTTP 测试；TaskService 增加 Blocked 重新排队测试；WorkerRuntime 增加 CUA 令牌、VM 停止 Blocked 和重新排队测试。
- Guest Agent 新增 `/v1/verify`：只读文件大小/SHA-256 和 Linux `/proc` 进程检查；拒绝符号链接、根目录外路径和未知检查；Go 测试覆盖文件证据、符号链接、路径越界、未配置根目录和未知检查。
- `pnpm smoke:phase7` 15 项检查通过；`pnpm smoke:phase6`、`smoke:phase5`、`smoke:phase4`、`smoke:phase3`、`smoke:phase2` 回归通过。

## 未关闭的限制

1. **真实 Guest/Desktop 未验收**：真实 QEMU/WHPX、Linux Golden Image、X11 中文输入、滚动、拖拽、动态分辨率和 DPI 仍需在真实 VM 中执行。
2. **7.4 真实任务基线缺失**：没有真实 Pi/模型成功率、人工接管率、平均步数、卡死率和验证通过率；不能以本轮 Smoke 代替稳定性结论。
3. **Guest Agent 证据根目录需 provisioning**：默认 `-verify-roots /home:/tmp`，生产镜像应显式配置并只开放工作区。
4. **网络策略基础版**：项目策略和 Broker 回环/上游白名单已落地，但 VM 级出网、宿主机管理网段和云元数据地址限制需要 QEMU/WHPX 网络回归。
5. **无进展检测使用截图哈希**：时钟或动画会降低“屏幕无变化”命中率；真实评测后应引入更稳的图像差异/任务检查点。
6. **多显示器/复杂 DPI**：当前以 X11 root window 合并屏幕为主，`displayId` 仅保留协议位；多显示器和 HiDPI 缩放需真实桌面验证。
7. **截图保留与清理**：Trace 截图当前只写不清理；发布前需要保留期限、清理和诊断包敏感内容提示。
8. **真实浏览器/Electron 审批 UX**：看板 Trace/审批按钮已实现，但未做真实浏览器或 Electron 人工可用性验收。
9. **Pi 真实扩展兼容性**：`cua-extension.js` 依赖 Pi 1.5.1 的扩展加载和工具 Schema 行为；真实 Pi 进程内安装/加载需在 Golden Image 中验收。

## 复现

```bash
pnpm check
pnpm smoke:phase7
pnpm smoke:phase6
```

机器结果可另存到 `AGENT_IN_BOX_PHASE7_RESULT`。CI 不启动真实 QEMU/WHPX、真实 Pi 或真实模型。Guest 安装资产说明见 [`images/linux/README.md`](../../images/linux/README.md)。
