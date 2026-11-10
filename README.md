# Agent-in-Box

面向个人用户的本地 AI 虚拟机工作平台。当前仓库已完成 **开发计划阶段 1（工程骨架、协议和本地持久化）**：包含可构建的工程边界、共享协议、领域状态机、SQLite 持久化、任务/Worker/VM 仓储、Outbox、执行 Lease 和事件去重。尚未包含可用的 Hypervisor、Computer Use 或 Worker 功能。

完整方案见：

- [产品方案](docs/01-product-solution.md)
- [技术设计](docs/02-technical-design.md)
- [开发计划](docs/03-development-plan.md)

## 环境要求

- Node.js 22.19 或更高版本（当前验证环境为 Node.js 24）
- pnpm 11.22（由根 `packageManager` 固定）
- Go 1.26 或更高版本
- Windows 宿主机是首要目标；当前脚手架也可在 Linux/WSL 中开发和测试

启用 Corepack 后可自动使用固定 pnpm 版本：

```bash
corepack enable
corepack prepare pnpm@11.22.0 --activate
```

## 安装与开发

```bash
pnpm install

# 控制平面 + Web 本地开发
pnpm dev

# 或分别启动
pnpm --filter @agent-in-box/control-plane dev
pnpm --filter @agent-in-box/web dev
```

- Web: http://127.0.0.1:5173
- 控制平面: http://127.0.0.1:3000
- 健康检查: http://127.0.0.1:3000/api/v1/health

Electron 开发需要先启动 Web，然后构建并启动桌面壳：

```bash
pnpm --filter @agent-in-box/web dev
pnpm --filter @agent-in-box/desktop build
pnpm --filter @agent-in-box/desktop start
```

也可用 `AGENT_IN_BOX_WEB_URL` 指向其他本地 Web 地址。Electron 窗口只加载页面，不直接执行系统命令。

## 构建与检查

```bash
pnpm build        # 所有 TypeScript 包 + Go
pnpm test         # Vitest + Go test
pnpm typecheck
pnpm lint
pnpm check        # lint + typecheck + test + build
```

Go 服务可单独运行：

```bash
go run ./services/vm-supervisor/cmd/vm-supervisor
go run ./services/guest-agent/cmd/guest-agent
```

两者默认只监听回环地址，并提供 `/healthz` 和 `/readyz`。

## 目录结构

```text
apps/
  desktop/           Electron 无特权桌面壳
  web/               React + Vite 本地 Web UI
services/
  control-plane/     NestJS 本地控制平面
  vm-supervisor/     Go 宿主机 VM 管理服务（当前仅健康检查）
  guest-agent/       Go Guest Agent（当前仅健康检查）
packages/
  protocol/          跨进程协议与事件类型
  domain/            任务/Worker 状态机与绑定规则
  config/            数据目录和本地服务配置
  agent-runtime/     Worker Engine 抽象
  computer-use/      Computer Use 动作协议与校验
  bot-connector/     飞书/QQ 平台无关接口
  ui/                状态文案与样式辅助
internal/health/     共享 Go 健康检查实现
images/              后续 Linux/Windows 镜像构建
tests/               后续集成与真实 VM 测试
docs/                产品、技术与开发计划
```

## 数据目录

大体积文件不会写入仓库。默认数据根目录：

- Windows：`%LOCALAPPDATA%\AgentInBox`
- Linux/macOS：`~/.local/share/agent-in-box`

可通过 `AGENT_IN_BOX_DATA_ROOT` 覆盖。控制平面的 `/api/v1/runtime` 会返回解析后的存储布局和数据库路径。

SQLite 数据库位于数据根目录下的 `agent-in-box.sqlite`，使用 WAL 模式并启用外键约束。启动时执行内置 Migration Runner；迁移记录保存在 `schema_migrations` 表中，每条迁移在独立事务中应用。数据库包含：

- `projects`、`project_vm_bindings`、`vm_instances`、`conversations`
- `tasks`、`task_events`、`workers`、`idempotency_keys`
- `outbox`、`vm_leases`、`processed_events`
- `images`

数据库备份通过 `AppDatabase.backup()` 使用 SQLite 在线备份能力，后续会接入本地备份与恢复流程。

## 当前验证记录（2026-11-10）

已在当前开发环境实际执行：

- `pnpm install`：成功；pnpm 11 仅允许 `esbuild`、`electron`、`better-sqlite3` 构建脚本
- `pnpm check`：lint、typecheck、33 个 Vitest 测试、Go test、全部构建均通过
- 控制平面 `GET /api/v1/health`、`GET /api/v1/runtime` 返回正常
- 控制平面启动时创建 SQLite 数据库并应用 `001_initial_schema`
- SQLite 表、WAL 模式和迁移记录在真实运行中验证通过
- Web 开发服务器可访问，`/api` 代理到控制平面正常
- VM Supervisor 与 Guest Agent 的 `/healthz`、`/readyz` 正常
- Electron TypeScript 构建通过，但 **Electron 二进制在当前网络环境下载失败**

### 阶段 0 P0 验证（2026-11-10）

已在真实 Windows 11 家庭版宿主机上完成，而非仅在 WSL 中模拟：

- WHPX API 探测：`WHvGetCapability` 返回 `S_OK` 且 `hypervisorPresent=True`
- MSYS2 UCRT64 QEMU 11.1.3 安装到 `%LOCALAPPDATA%\AgentInBox\tools\msys64`，`-accel help` 包含 `whpx`
- Ubuntu 24.04 cloud image 从 TUNA 镜像下载并通过 SHA256 校验
- 使用 qcow2 覆盖盘启动 Linux Guest，冷启动到登录提示约 14 秒
- cloud-init NoCloud 创建验证用户，SSH 经 `127.0.0.1:10022` 读取启动标记成功
- QMP `system_powerdown` 优雅关机成功
- qcow2 快照创建、列出和恢复成功，恢复后快照后写入的标记文件消失
- XFCE + LightDM 桌面在 WHPX 上自动登录，QMP 截图与 `xdotool` 分辨率一致（1280x800，切换 1024x768 后截图尺寸同步变化）
- QMP 绝对鼠标归一化坐标和 `send-key` ASCII 输入通过验证：在终端输入命令后，Guest 内生成预期文件
- Go `vm-supervisor.exe /api/v1/host` 在 Windows 上返回 `ready=true`、`recommendedProvider=qemu-whpx`
- Go Guest Agent 以非特权用户在 X11 桌面运行：无令牌/错误令牌均返回 401，截图返回可解码 PNG，点击、ASCII 和中文 `你好` 输入通过 Guest 文件 SHA256 验证
- Go Provider 真实集成测试在 Windows/WHPX 上 31.83 秒通过：创建、启动、登录、Provider 重启对账、重复 Start/Stop、优雅关机、快照恢复和删除
- Pi 1.5.1 RPC + 脚本化模型 + 真实 Guest Agent 的工具循环通过：截图 PNG 回传、点击、中文输入、活跃工具 Abort、Session Resume
- **真实模型 `pro` 经本地 Model Broker 完成首个 CUA 任务**：13.37 秒内完成截图、中文输入、回车和复核截图，Guest 文件 SHA256 一致；VM 内不含上游 API Key
- 真实模型继续通过桌面 Home 双击打开 Thunar（25.14 秒）和 Mousepad 多行编辑保存（27.84 秒）
- WHPX 在桌面 VM 并行运行时连续通过 3 轮 Go Provider 生命周期回归（33.18/31.73/31.27 秒）
- Epiphany 页面滚动到底部成功，但 HTML5 drag-and-drop 未完成（已记录为失败）；窗口标题栏拖拽由 Guest Agent 独立验证通过

注意：Pi 验证同时使用本地脚本化模型和真实 `pro` 模型。首个真实任务已通过，但单次任务不能代表 Computer Use 成功率基线。验证中出现过一次 Guest 内核 panic，已记录为 WHPX 长稳风险，需重复复测。

验证中确认的必要配置：桌面 VM 使用 `-vga none -device virtio-gpu-pci -device virtio-tablet-pci`；当前 WHPX 环境暂用 `-cpu qemu64`，`-cpu max` 的启动卡住问题尚未解决。

测试矩阵、验收任务集和结果记录位于 [`tests/phase0/`](tests/phase0/README.md)。当前已完成 G1 Server 生命周期核心链路、G2 XFCE 桌面的 QMP 显示/输入验证，以及认证 Go Guest Agent 的 X11 截图和中文输入。WHPX 性能与长稳、Supervisor 崩溃接管、Pi Computer Use、Model Broker 和机器人长连接仍未验证，默认 VmProvider 尚未冻结。

Electron 二进制的失败与代码无关。在网络可用的机器上重试：

```bash
pnpm --filter @agent-in-box/desktop exec install-electron
```

WSL 环境还需要可用的图形转发或 Windows 侧运行 Electron。桌面壳的实际窗口、打包和安装程序验证属于后续阶段，当前不要把“TypeScript 构建通过”当作“桌面应用已验证”。

## 当前技术栈版本

- Node.js 24（要求 >= 22.19）
- pnpm 11.22.0
- TypeScript 5.9.3
- React 19.3.1 + Vite 8.3.7
- NestJS 12.4.2
- SQLite: better-sqlite3 13.0.3 + Kysely 0.29.8
- Electron 45.2.3
- Vitest 5.1.0
- Go 1.26

## 当前边界

已具备：

- pnpm Monorepo、共享 TypeScript 严格配置、Go Module
- 协议类型、分页/错误/幂等契约、Guest RPC 与 VmProvider 接口
- 任务与 Worker 状态机、VM 多对多绑定校验
- Computer Use 动作结构校验
- SQLite Migration、WAL、外键、在线备份
- 项目、VM、会话、任务、Worker、Lease、Outbox 和事件去重仓储
- 幂等任务创建、事务化状态迁移、任务事件与 Outbox 同事务写入
- Per-VM 执行 Lease 与过期替换
- NestJS 健康检查、运行时信息和持久化模块
- React 本地页面与 Electron 无特权入口
- VM Supervisor / Guest Agent 的 Go 健康服务
- Go QMP 客户端（状态、关机、截图、键盘、绝对鼠标事件）
- QEMU VmProvider 原型：qcow2 覆盖盘、启动/停止幂等、进程与 QMP 状态对账、快照、控制台地址
- Windows/Linux Host Inspect：WHPX/KVM、QEMU 加速器、内存和磁盘检查；Windows amd64 版本已在本机实际运行
- Linux X11 Guest Agent：Bearer 认证、能力/桌面信息、PNG 截图、鼠标/键盘/Unicode 输入和动作日志
- `PiWorkerEngine`：Pi RPC 子进程、受控工具暴露、事件映射、Prompt/Steer/Follow-up/Abort、会话归档与原生恢复；包含假 Pi 单元测试和真实 Pi 集成测试

明确未实现：

- 生产级 Image Service（分块续传、下载去重和版本管理）
- Supervisor 的完整 VM 生命周期 HTTP API 与 ACL；当前仅 Host Inspect 和 Go Provider 原型
- Guest RPC 的生产级传输、短期令牌签发/撤销和 Per-VM Lease 强制接入；当前验证使用静态测试令牌
- Wayland 与 Windows Guest 的截图/输入路径
- Pi Worker 与 Task/Lease/Router 的控制平面接入、生产级 Model Broker 服务
- Router、HTTP 任务 API、Worker 注册表查询接口和任务看板
- 飞书/QQ 适配器

阶段 1 已完成；阶段 0 已开始，Windows Host + QEMU/WHPX 运行 Linux Guest 的核心 P0 链路已在本机验证。下一步按 [开发计划](docs/03-development-plan.md) 补齐 Linux 桌面 Golden Image、显示/输入、Supervisor 接管和 Pi Computer Use 验证，再进入阶段 2～4 的 Electron、存储和 VM 生命周期。
