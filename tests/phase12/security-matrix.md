# 阶段 12 安全测试矩阵

日期：2026-11-11  
范围：本机控制平面、Web/Electron 边界、Guest 管理通道、Worker/Computer Use、机器人、文件交换、日志与诊断。真实 Linux VM 的网络边界仍需在阶段 12 验收构建中复测，具体见文末。

| 攻击面 | 必须证明的边界 | 自动化证据 | 本轮状态 | 剩余外部验收 |
| --- | --- | --- | --- | --- |
| Renderer → Supervisor | Renderer 没有 Node、通用 IPC、Shell 或 Supervisor 凭据 | 阶段 2 打包 Smoke；Electron `contextIsolation`/sandbox；preload 白名单；阶段 11 桌面测试 | 自动化通过 | 打包 Electron 人工 DevTools/权限检查 |
| 本地 HTTP API | 未登录不能读数据；Cookie 写操作必须 CSRF；拒绝跨端口 Origin、跨站 Sec-Fetch-Site 和伪造 Host | `smoke:phase12`；阶段 11 `auth.test.ts`、`smoke:phase11` | 自动化通过 | 真实浏览器扩展/恶意页面人工验证 |
| WebSocket | 事件和 noVNC 升级都需要有效会话/一次性票据与同源 Origin | 阶段 4 控制台测试；阶段 11 WebSocket 认证测试；`smoke:phase11` | 自动化通过 | 真实 noVNC 浏览器人工接管 |
| Guest Agent / Guest RPC | Bearer 令牌、轮换/撤销、动作大小/超时/去重、Worker RPC 版本握手 | 阶段 4/6 Go 与 Vitest 测试、`smoke:phase4`、`smoke:phase6` | 自动化通过 | 真实 X11 Linux Guest 令牌轮换 |
| VNC | 一次性回环票据、Host/Origin 校验、Lease 失效后拒绝输入 | 阶段 4 RFB 测试与 Smoke | 自动化通过 | 真实 noVNC RFB 输入 |
| 机器人 | 平台事件持久去重、身份/群白名单、管理员二次确认、Secret 不落库 | 阶段 10 测试与 `smoke:phase10` | 自动化通过（协议替身） | 真实飞书/QQ 应用凭据与权限矩阵 |
| Router 工具面 | 只暴露项目/任务/Worker/看板/归档结构化工具，没有 Shell、VM 输入或 Supervisor 通道 | `smoke:phase12` 检查 17 个工具名称；阶段 8 测试 | 自动化通过 | 真实 Router 模型的提示词注入评测 |
| Computer Use 策略 | 动作必须持有 Lease、引用最新截图、经过项目 Policy/审批；不能绕过达到宿主执行 | 阶段 7 测试与 `smoke:phase7`；阶段 12 崩溃/Lease 对账 | 自动化通过 | 真实模型在恶意网页/文件中的注入测试 |
| 文件交换 | 上传文件名/路径清洗、大小限制、SHA-256；项目备份拒绝符号链接和路径逃逸 | 阶段 9/11 测试；`smoke:phase11`；Inbox 路径穿越测试 | 自动化通过 | 真实 Guest 文件交换与下载 |
| 路径穿越 | VM ID、项目备份、Inbox、控制台票据和归档恢复路径均在允许根目录内 | 阶段 3/4/9/11 测试 | 自动化通过 | 真实 workspace 归档/恢复 |
| 密钥与凭据 | 长期模型/机器人 Secret 不进入 VM、SQLite、普通日志；诊断报告不输出访问密钥 | 阶段 6/10 测试；`smoke:phase12` 诊断脱敏；桌面日志正则脱敏测试 | 自动化通过 | 真实 Provider/机器人凭据轮换 |
| 日志与截图 | 日志轮转、错误堆栈和凭据形状脱敏；截图只通过认证 API 访问 | 阶段 11 日志轮转；阶段 12 `redactText` 测试与诊断测试 | 自动化通过 | 人工检查截图中的第三方页面敏感信息 |
| 数据库升级 | 迁移前先创建并校验 SQLite 备份；备份可恢复 | 阶段 12 `migration-backup.test.ts`、`smoke:phase12` | 自动化通过 | 真实升级/回滚安装包演练 |
| VM → 宿主/内网/元数据 | Guest 只能使用受控回环转发；管理端口需要 Bearer；不得把 VM 宣传为强安全隔离 | 阶段 0 Provider 网络参数与 Guest Agent 测试；本阶段记录边界 | 部分覆盖 | 真实 Linux Guest 访问 `10.0.2.2`、内网和 `169.254.169.254` 的网络策略验收 |
| 外部网络影响 | Computer Use 访问外部网站/发送内容时必须有审批或明确提示 | 阶段 7 项目 Policy/Approval 自动化 | 部分覆盖 | 真实任务集的外网/敏感操作人工复核 |

## 已确认的产品边界

- **同 VM 项目不是强安全隔离**。共享 VM 的桌面、软件和系统状态互相可见；产品只承诺 Per-VM Execution Lease 串行化、项目目录备份独立，以及 UI 明示共享影响。
- **“AI 无宿主机通用执行通道”** 指 Router/Worker 没有 Shell、文件系统或 Supervisor 工具；Computer Use 只能通过 Guest Agent/Broker 在 VM 内行动。这不等于阻止 VM 内登录网站、发送消息或删除云端数据，外部影响仍需审批和提示。
- **QEMU user networking 的宿主回环暴露**：Guest 可通过 `10.0.2.2` 访问宿主回环服务；当前用回环绑定、Bearer/短期令牌和 Lease 限制风险，但没有在 SLIRP 层实现任意端口的出口 ACL。真实 Linux Guest 的网络边界测试仍是阶段 12 验收门槛，不能把本矩阵的自动化结果表述为已完成真实网络隔离验收。

## 复现

```bash
pnpm check
pnpm smoke:phase12
```

真实 VM 网络边界与恶意网页/文件提示词注入必须使用 [`full-chain-tasks.json`](full-chain-tasks.json) 中的 `LC-NET-008` 和 `LC-FAIL-007` 在验收构建中执行，并记录到本目录的结果文件。
