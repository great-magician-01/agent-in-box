# 阶段 0 验证资产

本目录保存 Linux 高风险技术验证的固定输入与结果，供不同 VmProvider、Worker Engine 和后续回归复用。

## 文件

- `test-matrix.md`：宿主机、Guest、资源档位与验证范围矩阵。
- `acceptance-tasks.json`：Computer Use 与 VM 生命周期验收任务集。所有 Linux 验证必须使用同一批任务，禁止用临时演示代替。
- `result-schema.json`：单次任务运行的结果记录格式。
- `runbook-windows-qemu.md`：Windows Host 上用国内镜像安装 QEMU/WHPX 并启动 Linux Guest 的步骤。
- `scripts/`：实际执行过的 MSYS2/QEMU 安装、启动验证、QMP 控制和快照恢复脚本。
- `pi/`：Pi RPC + 脚本化模型 + 真实 Guest Agent 的 Computer Use 工具循环验证 Harness。
- `results/`：实际运行结果，小体积 JSON 入库；截图、控制台日志等大文件保存在数据目录，只在结果中引用路径与哈希。

## 结果状态

| 状态 | 含义 |
| --- | --- |
| `success` | 完成条件由机器检查或人工复核确认通过，有证据 |
| `failed` | 环境正常，但功能或任务未达到完成条件 |
| `human_takeover` | AI 无法继续，由人工接管完成；必须记录接管原因 |
| `environment_error` | Hypervisor、镜像、网络或宿主资源异常，不能据此判断任务能力 |

禁止把“模型自述完成”记录为 `success`。每个 `success` 必须有 `completionEvidence`，至少包含一项机器检查结果或明确的人工复核记录。

## 运行约定

1. 先记录 Host Inspect 结果，再运行 VM 生命周期与任务集。
2. 同一任务在同一 Provider/Engine 组合上至少重复两次，关键任务重复三次。
3. 环境异常与功能失败分开统计，不混入成功率。
4. 宿主机截图、机器人凭据、模型密钥不得写入结果文件。
5. Windows Guest 的结果在阶段 13 前不得出现；提前下载镜像不属于 Windows VM 验证。
