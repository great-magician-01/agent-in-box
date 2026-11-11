# 阶段 13 真实 Windows 宿主机 + Linux Guest 验收记录（2026-11-12）

本记录只包含在本机实际执行并通过的检查。飞书/QQ 集成、Windows Guest 和 Electron/NSIS 安装不在本轮范围。

## 环境

| 项目                | 值                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------ |
| 宿主机              | Windows 11 家庭中文版 10.0.26200                                                     |
| Node.js / pnpm / Go | 22.22.0 / 11.22.0 / 1.26.0                                                           |
| QEMU                | MSYS2 UCRT64 QEMU 11.1.3，`-accel whpx,kernel-irqchip=off`                           |
| Guest 镜像          | Ubuntu 24.04 cloud image（SHA-256 `04e8f246…b6c94`），cloud-init 安装 XFCE + LightDM |
| Guest 资源          | 4 vCPU / **8192 MiB**（按本轮要求不超过 16 GiB）/ 40 GiB qcow2                       |
| Guest 运行时        | Guest Agent 0.1.0；Node.js 24.18.0；Pi 1.5.1；Worker RPC 0.1.0                       |
| 模型                | any-llm（OpenAI-compatible）`flash`，`reasoning: true`，经内网 relay 转发            |

宿主机数据根目录位于 `F:\AgentInBox`；镜像、VM 覆盖盘、Router 会话和日志均未写入 C 盘。

## 通过项

1. **Windows 宿主服务**：控制平面 `/api/v1/health`、Supervisor `/healthz` 正常；Supervisor 使用固定 QEMU 路径并仅监听 `127.0.0.1:7610`。
2. **镜像与 VM 生命周期**：Image Service 校验本地 Ubuntu 镜像为 `available`；VM 创建、WHPX 启动、QMP 状态、suspend、resume、graceful stop 均成功。QEMU 实际参数包含 `-m 8192`，VNC/QMP/SSH/Guest/Worker 转发全部绑定 `127.0.0.1`。
3. **真实 Linux 桌面**：Guest 内 Xorg 1280×800、DPI 96.2；Guest Agent `/v1/capabilities` 返回 `platform=linux, displayServer=x11, screenshot=true, input=true, unicodeInput=true`；`/v1/screenshot` 返回真实 1280×800 PNG。
4. **Router 真实模型链路**：Host 侧 Pi 1.5.1 经 Model Broker 调用 `flash`，成功执行 `list_projects`、`list_board_summary`、`list_active_workers`、`assign_task` 等工具；`model_requests` 记录 `upstreamStatus=200`。
5. **Worker 真实 Guest RPC**：Worker 由 API 创建，握手 `protocol=0.1.0 / engine=1.5.1 / session=1`，Guest Pi 以 `aib-worker` 非 root 用户运行，状态 `idle`、`connected=true`。
6. **Router → Worker → Computer Use 全链路**：Router 调用 `assign_task` 创建任务 `9d3a97a4-aedc-4d76-add0-b9f2c2f9ec44`；Worker 依次执行 `click`、`type_text`、`keypress` 等真实 X11 动作，任务 `completed`。
7. **独立完成校验**：`vm_task_complete` 提交的文件证据由 Guest Agent 独立校验：`/home/aib-worker/workspace/cua-proof.txt`，15 字节，SHA-256 `50b61bca5687a10ff48322bf12078db23aef6908cf1a95eacf91df65fba8c985`；同时重新捕获完成截图。Guest 内 `cat`/`sha256sum` 与校验结果一致。
8. **归档与恢复**：Worker 手动归档生成真实备份引用与摘要；VM suspend/resume 后 Worker 以 `native` 模式恢复并回到 `idle`；最后再次归档并 graceful 停止 VM。
9. **长时 CUA 与 Lease 续期**：修复后再次执行 40 秒 `sleep` 任务 `2fccd944-4106-4eb5-b2f3-c28f11de953e`，实际动作时间跨度 **74.8 秒**（含 5 次 10 秒级 `vm_wait`），期间持续产生事件，任务仍 `completed`，控制平面无 Lease 续期告警、无 `lease_conflict`；证据文件 `/home/aib-worker/workspace/slow-proof.txt`（16 字节，SHA-256 `29bf117a86467c56882769626e34af93811dd24d7b63f09871fd695566a4cd34`）通过独立校验。
10. **质量门禁**：最终代码执行 `pnpm check`（lint、typecheck、Vitest、Go test、全部构建）与 `go vet ./...` 均通过。

## 本轮发现并修复的真实缺陷

1. **Model Broker 路由不匹配**：Pi 的 OpenAI SDK 请求 `/chat/completions`，Broker 只接受 `/v1/chat/completions`，导致 Router/Worker 首次真实模型调用返回 404。修复为同时接受带/不带 `/v1` 的 chat 与 messages 路径，并新增回归测试。
2. **Execution Lease 续期被事件心跳饿死**：Worker 的 tool/text 事件会刷新 RPC 心跳时间，而 Lease 续期原先放在心跳分支内，忙时永不执行；真实 CUA 在约 30 秒后开始全部返回 `lease_conflict`。修复为将 Broker 令牌与 Execution Lease 续期移出心跳门控，并新增回归测试；修复后 74.8 秒的连续 CUA 任务通过。
3. **归档响应中的 `archivedAt` 滞后**：归档接口返回的是写 `archived_at` 之前的记录。修复为归档后重新读取 Worker 记录。

## 证据位置

- 宿主机日志与截图：`F:\AgentInBox\logs\`（`guest-screenshot.png`、`completion.png`、`control-plane.log`、`supervisor.log`）
- 真实桌面完成截图可通过 `GET /api/v1/tasks/9d3a97a4-aedc-4d76-add0-b9f2c2f9ec44/screenshots/completion-e5ebdf25-ac27-406f-8df5-01fc4ed41a55` 重新读取。
- 长时任务完成截图：`GET /api/v1/tasks/2fccd944-4106-4eb5-b2f3-c28f11de953e/screenshots/completion-d80a2a4e-939e-4fd8-9ab0-980b9bb531bf`。

## 未覆盖边界

- 飞书/QQ 真实平台凭据与公网连接。
- Windows Guest、Windows Golden Image、Windows 桌面截图/输入/UAC/DPI。
- Electron/浏览器人工 UI、NSIS 干净安装、更新源与长时 soak。
- Provider 直连策略仍要求 HTTPS（仅回环允许 HTTP）；本轮 any-llm 通过 `127.0.0.1` 回环端口转发使用内网 relay，未放宽该策略。
