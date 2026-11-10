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

明确未实现：

- 镜像下载、VM 创建和 Hypervisor 接入
- Guest Agent 截图与输入
- Pi Worker、模型代理和 Computer Use 执行
- Router、HTTP 任务 API、Worker 注册表查询接口和任务看板
- 飞书/QQ 适配器

阶段 1 已完成。下一步按 [开发计划](docs/03-development-plan.md) 执行阶段 0 的技术验证，再进入阶段 2～4 的 Electron、存储和 VM 生命周期。
