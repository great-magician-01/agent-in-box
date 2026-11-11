# 阶段 7 验证资产：Computer Use 执行器与首轮评测

本目录保存阶段 7 的自动化验收结果和真实任务评测协议。自动化 Smoke 使用真实控制平面、SQLite、HTTP Computer Use Broker、Worker RPC 和伪造 Guest Agent；真实 QEMU/WHPX、Linux Golden Image、真实 Pi/模型仍需在具备桌面环境的主机上单独执行。

## 自动化入口

```bash
pnpm check
pnpm smoke:phase7
```

`pnpm smoke:phase7` 默认写入 `tests/phase7/results/<date>-smoke.json`，可用 `AGENT_IN_BOX_PHASE7_RESULT` 指定路径。结果中的 `boundaries` 明确记录是否使用真实 Guest Agent、QEMU/WHPX、Pi 进程和模型。

## 首轮真实任务评测协议（7.4）

评测使用阶段 0 的 [`acceptance-tasks.json`](../phase0/acceptance-tasks.json) 中 `worker_engine` 和 `desktop` 任务，至少覆盖：

- 浏览器和本地桌面应用；
- 中文输入、滚动、拖拽；
- 分辨率/DPI 变化后的重新观察；
- 应用报错、弹窗、网络失败；
- VM 停止/重启后恢复；
- 人工接管和取消；
- 长任务上下文压缩；
- 多项目共享 VM 排队（阶段 9 前只记录串行影响）。

每个任务必须记录：

| 字段 | 说明 |
| --- | --- |
| `taskId` / `objective` | 任务标识与目标 |
| `engine` / `model` | Pi 1.5.1 与实际 Provider/模型 |
| `repeat` | 重复运行次数（关键任务至少 2 次） |
| `result` | `success` / `failure` / `human_takeover` / `environment_error` |
| `steps` | `cua_actions` 数量与 `task_execution_state.step_count` |
| `durationMs` | 从 `started_at` 到终态 |
| `stuck` | 是否触发无进展/重复动作/超时保护 |
| `approvals` | 审批次数、批准/拒绝/超时 |
| `evidence` | 完成证据类型与校验结果，不使用模型自述 |
| `artifacts` | 截图/SHA-256 引用；敏感内容不导出到外部 |

基线结论必须按任务类别给出成功率、人工接管率、平均步数、卡死率和结果验证通过率；单次演示不能作为稳定性结论。评测期间发现的高频基础设施问题（Guest Agent、Lease、Broker、Pi RPC、输入/显示）必须先修复，再调整 Prompt 或模型配置。

## 当前边界

- 本仓库当前环境没有启动真实 QEMU/WHPX、Linux Golden Image、真实 Pi 1.5.1 或真实模型 Provider，因此没有生成 7.4 真实基线报告。
- 真实 X11 中文输入、滚动、拖拽、动态分辨率和 DPI 回归仍待执行；自动化测试只验证协议、坐标转换、执行前校验和 Trace 行为。
- 阶段 7 的网络策略为项目策略与 Broker 白名单基础版本；QEMU/WHPX 的宿主网络隔离和真实出网限制仍需在 VM 环境验收。
