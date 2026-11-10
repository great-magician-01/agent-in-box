# 阶段 0 验证总结（2026-11-10）

> 范围：Linux 高风险技术验证。结论均基于仓库内的真实运行记录；mock、原型与真实环境验收分开标注。

## 总体结论

Windows Host 运行 Linux Guest 的 P0 主链路已经打通，并且不是停留在命令行脚本：Go VmProvider、认证 Guest Agent、Pi Worker Engine、Model Broker 和机器人连接框架均有代码与测试。

建议冻结的首版技术选型：

- Windows Host 默认 Provider：**QEMU 11.1.3 + WHPX**（MSYS2 UCRT64，普通用户权限），默认 `-cpu qemu64`。
- Linux Guest 默认桌面：**XFCE + LightDM + Xorg**；Wayland 暂不支持，Guest Agent 在不支持的显示栈上必须明确报不可用。
- Worker：**Pi 1.5.1 RPC + 自定义 CUA 工具**，不 Fork Pi，暂不增加独立 CUA Engine。
- Guest 控制：Guest Agent HTTP + Bearer 认证；验证使用 loopback hostfwd，生产需短期令牌、撤销和 Per-VM Lease 强制接入。
- 模型访问：宿主机/WSL Model Broker 持有真实凭据，VM 只持有本地 Broker Token。
- 机器人：保留本地 Ingress/持久化去重框架；飞书使用官方 Node SDK，QQ 保留已对照的最小适配器，平台 ID 可扩展。

## 逐项结果

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| WHPX 能力检测与 QEMU 安装 | 通过 | `results/2026-11-10-h1-host-inspection.json`、`results/2026-11-10-h1-go-host-inspection.json` |
| Linux VM 创建、启动、SSH、优雅关机 | 通过 | `results/2026-11-10-h1-vm-boot-001.json` |
| 快照创建与恢复 | 通过 | `results/2026-11-10-h1-vm-snap-003.json` |
| 重复 Start/Stop 与 Provider 重启对账 | 通过 | `results/2026-11-10-h1-vm-life-002.json`、`results/2026-11-10-h1-vm-recov-004.json` |
| Provider 重复生命周期 | 9 次通过，跨约 2 小时 | `results/2026-11-10-h1-vm-life-repeat3.json`、`results/2026-11-10-h1-whpx-provider-stability-5x.json` |
| 桌面 10 分钟长稳 | 通过，20/20 采样正常，无内存增长趋势 | `results/2026-11-10-h1-whpx-desktop-soak-10m.json` |
| CPU host/max/qemu64 启动探针 | 本次均通过；历史 max 卡住未关闭 | `results/2026-11-10-h1-whpx-cpu-model-boot.json` |
| 自定义 ASCII+空格路径 | 通过 | `results/2026-11-10-h1-whpx-custom-storage.json` |
| Unicode VM 路径 | 修复后 C:/D: 复测通过 | `results/2026-11-10-h1-whpx-custom-storage-shortpath-fix.json` |
| 镜像下载、续传、校验、原子启用 | 本地原型测试通过 | `results/2026-11-10-image-download.json` |
| Guest Agent 认证、截图、点击、中文输入 | 通过 | `results/2026-11-10-h1-guest-agent-core.json`、`results/2026-11-10-h1-cua-type-003.json` |
| QMP 救援通道截图与输入 | 通过 | `results/2026-11-10-h1-cua-qmp-001.json` |
| 真实模型终端中文任务 | 通过 | `results/2026-11-10-h1-pi-real-001.json` |
| 真实模型桌面双击 / GUI 编辑 | 通过 | `results/2026-11-10-h1-cua-click-002.json`、`results/2026-11-10-h1-cua-file-006.json` |
| Pi 图片回传、工具循环、Abort、Session Resume | 通过 | `results/2026-11-10-h1-pi-cua-001.json` |
| PiWorkerEngine 真实 Pi 集成 | 通过 | `packages/agent-runtime/src/pi-engine.integration.test.ts` |
| 飞书/QQ 长连接框架 | mock 协议测试通过 | `results/2026-11-10-bot-connectors.json` |
| Epiphany HTML5 drag-and-drop | **失败**，保留负面结果 | `results/2026-11-10-h1-cua-scroll-005.json` |
| 窗口标题栏拖拽 | 通过 | `results/2026-11-10-h1-cua-drag-001.json` |
| Hyper-V 备选 Provider | 本机家庭版无法验证 | `results/2026-11-10-h1-whpx-hyperv-availability.json` |
| Guest 内核 panic | 发生过一次，未再复现，需长时跟踪 | `results/2026-11-10-h1-whpx-stability-incident.json` |

## 未关闭的外部验收门槛

以下事项不能用本地 mock 或本机结果替代，仍属于正式发布前必须完成的验证：

1. **真实飞书应用**：企业自建应用、长连接事件、`im.message.receive_v1` 权限、真实收发与重推。
2. **真实 QQ 机器人**：AppID/ClientSecret、群/单聊权限、Resume 补发、频限与权限错误。
3. **Hyper-V Provider**：需要 Windows Pro/Enterprise + Hyper-V 角色的机器。
4. **更长稳定性**：至少 1 小时桌面/CUA soak、宿主睡眠唤醒、host/max 长稳、历史内核 panic 根因跟踪。
5. **Wayland**：当前明确不在首版支持范围内；不得把 X11 结果宣传为 Wayland 已支持。
6. **真实镜像源/CDN 与断电恢复**：下载器当前为本地 httptest 原型。
7. **HTML5 浏览器拖拽**：需要换浏览器复测或明确产品限制。

## 阶段 0 退出判断

技术选型和高风险主链路已经具备进入产品化的条件。真实飞书/QQ 凭据和少数外部环境项作为显式验收门槛保留，不影响进入 Electron、Image Service、VM 生命周期和 Task/Worker 主链路开发；在它们补齐前，不得宣称“所有平台均已验收”或对外发布完整版本。
