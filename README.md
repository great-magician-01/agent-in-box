<h1 align="center">
  <img src="apps/web/public/logo.svg" alt="Agent-in-Box 图标" width="64" style="vertical-align: middle;">
  &nbsp;Agent-in-Box
</h1>

<p align="center">
  <strong>让 Agent 住进虚拟机，虚拟机住进你自己的电脑 🤖</strong><br>
  Router 分派任务，Worker 在 Linux / Windows 盒子里看屏幕、点鼠标、敲键盘；每个动作都能被观察、审批、接管和停止。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-45-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron 45">
  <img src="https://img.shields.io/badge/Go-1.26+-00ADD8?style=for-the-badge&logo=go&logoColor=white" alt="Go 1.26+">
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 19">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript 5.9">
  <img src="https://img.shields.io/badge/QEMU-WHPX%20%2F%20KVM-FF6600?style=for-the-badge" alt="QEMU WHPX / KVM">
  <img src="https://img.shields.io/badge/SQLite-WAL-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite WAL">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License MIT">
</p>

**Agent-in-Box** 是一个面向个人用户的本地 AI 虚拟机工作平台。你通过 Electron、本机网页、飞书或 QQ 与主会话 Router 对话；Router 把工作拆成持久任务，分派给完整的 Worker Agent；Worker 在你电脑上的 Linux 或 Windows 虚拟机里，用截图、鼠标和键盘把任务做完。

它不把聊天记录搬到桌面，也不是一次性远程桌面。项目、Worker、会话、任务、虚拟机、快照和归档都长期保存、停止、恢复和追溯；AI 与人工共用同一套执行锁，谁在操作桌面始终是确定的。

它也没有产品方服务器：长期 API Key、机器人凭据、数据库和虚拟机都在本机；模型请求经宿主 Model Broker 转发，VM 内拿不到长期密钥；飞书和 QQ 由本地客户端通过官方长连接直接接入，不经过中转。

---

## 🤔 为什么是「Agent-in-Box」？

聊天机器人可以告诉你「怎么做」，但很多事得有人真的坐到电脑前。Agent-in-Box 想把这个「电脑前」变成一台可停止、可恢复、可被看见的虚拟机。

- 🖥️ **Agent 要真的动手**：Worker 通过 Computer Use 观察屏幕、点击、输入、滚动和拖拽；任务不是一段回答，而是一串可回放的桌面动作和证据。
- 📦 **盒子是隔离边界**：Worker 和文件工具天然活在 Guest 里；Router 与控制平面没有宿主 Shell，也不向模型开放任意 Hypervisor 指令。
- 🔐 **长期秘密留在盒子外**：Provider Key 只经 Electron `safeStorage` 解密；Guest 只拿绑定 Worker / VM / 任务的短期 Broker 令牌；机器人 Secret 不进入 VM。
- 🧾 **完成要有证据**：模型说「做完了」不算完成；Guest 文件 / 进程证据或重新截图通过独立校验，任务才会置为完成。
- 🕹️ **人始终能接管**：AI 与人工共用 Per-VM Execution Lease；只读观察不抢锁，人工接管显式抢占，旧 AI 动作会被拒绝。
- 🏠 **本地优先**：数据库、镜像、VM、产物和备份全在数据根目录；没有产品方服务器，远程 Relay 不是本地核心依赖。

## ✨ 一眼看懂

| 模块 | 你能得到什么 |
| --- | --- |
| 🖥️ **工作区** | Codex 式三栏：左侧项目 / Worker 会话，中间 Router 或 Worker 主会话，右侧可展开只读观察栏；通知中心、文件投递和原生桌面通知 |
| 📁 **项目与任务** | 多项目、项目与 Linux / Windows VM 多对多绑定、持久任务队列、依赖与优先级、跨项目串行、任务看板、Trace / 截图 / 审批 / 产物 |
| 📦 **虚拟机** | Ubuntu 24.04 一键创建、Windows Golden Image、QEMU / WHPX 生命周期、快照、项目目录备份、共享 VM 影响确认、资源预算与空闲休眠 |
| 🤖 **Agent** | 宿主 Router + Guest Worker、Pi 运行时、原生 / 摘要恢复、自动归档、Active Roster、可搜索 Archive Registry、按项目开启 MCP / 默认 Subagent |
| 🖱️ **Computer Use** | 截图、点击 / 双击、移动、输入、按键、滚动、拖拽、等待、完成；每一步动作与前后截图入库，受步数 / 时长 / 无进展保护；遇到扫码 / CAPTCHA / 手机验证码会暂停并通知人工处理 |
| 🔐 **安全** | 只监听回环、本机访问密钥、HttpOnly 会话、CSRF / Origin 校验、Per-VM Lease、人工审批、Guest 证据校验、日志与诊断脱敏 |
| 🧠 **模型** | 多 Provider 配置、Worker 默认模型与 Router 模型、OpenAI-compatible / Anthropic Messages 流式转发、用量记录、短期令牌 |
| 💬 **机器人** | 飞书官方 SDK 长连接、QQ Bot API v2、身份 / 群白名单、绑定码、任务 / 审批通知、敏感操作二次确认 |
| 🚀 **运维** | 首次启动向导、自定义数据根、存储迁移与备份、诊断报告、托盘 / 开机启动、更新检查 / 校验 / 回滚、Windows NSIS 与 Linux AppImage 打包 |

<table>
<tr>
<td width="33%">

### 🧑‍💻 想把活交出去的人

建一个项目，绑定一台或几台 VM，写清目标，然后让 Router 排队、分派、等待审批。任务跨重启还在，Worker 可以归档再恢复，长活不必一口气盯完。

</td>
<td width="33%">

### 🛡️ 在意边界的人

API Key、机器人 Secret、SQLite 和 VM 都留在本机。AI 在 Guest 里动手，宿主只给短期令牌；锁屏、UAC 和 Ctrl+Alt+Del 不绕过，交给人工。

</td>
<td width="33%">

### 🧰 愿意折腾的人

Electron + NestJS + React + Go + QEMU，没有隐藏云服务。数据目录、迁移、备份、诊断、阶段 Smoke 和打包脚本都在仓库里。

</td>
</tr>
</table>

## 🤖 Agent 不是住在聊天窗口里

主会话（Router）和 Worker 是两个不同的 Pi 运行时。Router 在宿主，只拿结构化工具：查项目、查看板、建任务、分派 Worker、归档和检索归档；它没有 Shell、宿主文件系统、VM 输入或 Supervisor 接口。Worker 在 Guest，拥有自己的 HOME、Pi 会话、工具和生命周期；它通过 Computer Use Broker 操作桌面，每个动作都要先确认 Lease 和最新截图。

| 角色 | 住在哪里 | 主要职责 |
| --- | --- | --- |
| 🧭 **Router** | 宿主 Pi 进程 | 主会话、项目 / 看板 / 归档查询、任务创建与 Worker 分派；不接触 Shell 和 VM 输入 |
| 🛠️ **Worker** | Guest 内的 Pi + Worker Runtime | 认领任务、观察桌面、调用 Computer Use、提交产物；独立会话，可归档 / 恢复 |
| 🖱️ **Guest Agent** | Linux / Windows Guest | 认证管理通道、GDI / X11 截图、鼠标键盘、心跳、workspace 归档 / 恢复 |
| 📦 **VM Supervisor** | 宿主 Go 服务 | ACL、QEMU / WHPX 生命周期、QMP 对账、快照；不向模型开放任意指令 |
| 🧠 **Control Plane** | 宿主 NestJS | 项目、任务、Worker、Lease、审批、Model Broker、机器人、通知和持久化 |

> 一次任务长这样：你说目标 → Router 建持久任务 → 队列按 VM 认领 → Worker 在 Guest 里观察 / 操作 → 每步写入 Trace 与截图 → Guest 证据或 completion 截图通过校验 → 任务完成。模型自述和「看起来像完成了」都不算数。

## 🛡️ 盒子里的安全边界

| 边界 | 做法 |
| --- | --- |
| 🔑 **长期秘密** | Provider Key 只经 Electron `safeStorage` 解密，由宿主 Model Broker 持有；机器人 Secret 只在宿主；Guest 拿不到长期凭据 |
| 🎫 **短期令牌** | Worker RPC、Model Broker、Computer Use Broker、noVNC 各自使用绑定 VM / Worker / 任务 / 会话的短期令牌，可轮换、可撤销 |
| 🕹️ **执行锁** | Per-VM Execution Lease 让 AI 与人工互斥；只读观察不取锁、不转发输入；人工接管显式抢占 |
| ✅ **审批与保护** | 项目级审批动作、步数 / 时长上限、无进展与重复动作检测、最新截图 / 分辨率校验；等待审批时占用该 VM 执行位 |
| 🧾 **完成校验** | Guest 文件 / 进程证据（大小、SHA-256、PID）或重新截图；连续失败会阻塞任务 |
| 🚫 **系统安全桌面** | Windows 锁屏 / UAC 返回 `session_locked` / `secure_desktop`，任务转 `blocked`；不绕过系统机制 |
| 🌐 **本机 Web** | 只允许回环监听；访问密钥 0600；HttpOnly + SameSite=Strict 会话；CSRF、Host、Origin、Sec-Fetch-Site 校验；无宽松 CORS |
| 🧹 **可观测与脱敏** | 动作 / 截图 Trace、任务事件、诊断报告；访问密钥、Bearer、Provider Key、机器人 Secret、Cookie 在日志和诊断中脱敏 |

## 📦 一台电脑，几个盒子

| 能力 | 说明 |
| --- | --- |
| 🐧 **一键 Linux VM** | 版本化 Ubuntu 24.04 Cloud Image，默认 4 vCPU / 8 GiB / 40 GiB；QEMU NoCloud + cloud-init 自动装 XFCE、Guest Agent、Node / Pi 与 Worker，首次初始化通常 5～20 分钟 |
| 🪟 **Windows VM** | 合法 ISO 或内部 Golden Image；IDE 磁盘、e1000、标准 VGA、xHCI + USB tablet，不依赖 stock Windows 缺少的 VirtIO；最低建议 4 GiB / 32 GiB |
| 🧩 **混合项目** | 一个项目可同时绑定 Linux 和 Windows VM；同 VM 串行、跨 VM 并发，看板显示 `vmOsFamily` |
| ⚖️ **资源调度** | Host Reserve、Soft Memory Budget、按需自动启动 / 恢复、`waiting_resources`；空闲休眠只作用于无任务、无 Worker、无 Lease 的 VM |
| 🧷 **共享与快照** | 多项目共享 VM 时明确展示桌面 / 软件 / 系统状态；整机快照只允许 stopped VM，恢复前列出受影响项目并二次确认；项目目录备份独立校验 |
| 💾 **存储与迁移** | 应用配置与数据根分离；迁移在存储锁下复制、校验哈希、在线备份 SQLite；失败保留旧目录；旧目录不自动删除 |

## 🧠 模型与入口

设置页可以维护多套 Provider：配置名、Base URL、API 类型、模型白名单和凭据引用。模型白名单可声明是否支持图片输入；Computer Use Worker 必须使用支持图片的多模态模型，否则创建/恢复 Worker 会被拒绝。Worker 默认模型和 Router 模型分开选择；Router 空闲时应用新模型并重建会话，已有 Worker 切换模型会归档旧会话再新建。长期 API Key 只显示「已保存 / 未保存」，不在接口或页面回显。

飞书和 QQ 都从本机出站：

- 飞书：官方 `@larksuiteoapi/node-sdk` WebSocket + Open API。
- QQ：Bot API v2 WebSocket Intents + REST。
- 单聊按绑定授权，群聊必须显式加入白名单；飞书群聊必须 @ 机器人，QQ 只处理 @ 机器人的事件。
- 任务、审批和 Router 回合事件会回到来源会话；取消、重试、批准 / 拒绝等敏感操作需要管理员二次确认。
- 首版不发附件；QQ 被动回复窗口外发送失败会明确报错。没有产品方机器人中继。

> Agent 扩展：Subagent 随 Worker Runtime 默认安装；MCP 默认关闭，可在项目设置中按项目开启，只影响新建 / 恢复的 Worker 会话，不热改运行中的 Pi，也不会自动安装 Server 或注入凭据。

## 🏗️ 架构与几条不肯让步的原则

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Electron shell                                                             │
│  BrowserWindow (sandbox) · preload whitelist IPC · tray · safeStorage      │
│  native notifications · autostart · update check / rollback                │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ supervise / local HTTP + WebSocket
┌───────────────────────────────▼────────────────────────────────────────────┐
│ NestJS control plane + React Web UI (same origin, 127.0.0.1 only)          │
│  host Router Pi · projects · tasks · workers · models · bots               │
│  approvals · notifications · storage · diagnostics · SQLite (WAL)          │
└───────┬─────────────────────────────────────┬──────────────────────────────┘
        │ ACL token                           │ short-lived broker tokens
┌───────▼──────────────────────┐      ┌───────▼──────────────────────────────┐
│ Go VM Supervisor             │      │ Linux / Windows Guest                │
│ QEMU / WHPX · QMP · snapshots│      │ Guest Agent · Worker · Pi            │
│ lifecycle · state reconcile  │      │ Computer Use · workspace             │
└──────────────────────────────┘      └──────────────────────────────────────┘
```

1. **后端才是权限边界。** 认证、授权、VM 绑定、Lease 和可见性判断都在服务端执行；前端隐藏按钮只是体验，不是安全措施。
2. **长期秘密不出宿主。** API Key 只经 `safeStorage` 解密，Guest 只拿短期令牌；机器人 Secret 和数据库不进入 VM。
3. **同一 VM 同时只有一个执行者。** AI 与人工共用 Per-VM Execution Lease；人工接管抢占 AI，旧动作和失效控制台输入一律拒绝。
4. **数据库是任务事实源。** 任务、Worker、Lease、Outbox 和事件去重都持久化；控制平面重启后对账，不重复执行，也不重放旧动作。
5. **完成必须由 Guest 证据校验。** 模型的自我总结不能直接把任务置为完成；文件 / 进程证据和重新截图才是闭环。
6. **Router 只持结构化工具。** 宿主 Shell、VM 输入和 Supervisor 接口不对模型开放；任何桌面动作都要经过 Lease、Broker 和审计。

> 当前验证栈：Electron 45.2.3 · NestJS 12 · React 19.3.1 · Vite 8.3.7 · better-sqlite3 13 + Kysely 0.29 · Go 1.26 · Vitest 5.1。

## 🚀 快速开始

### 环境要求

| 依赖 | 版本 / 说明 |
| --- | --- |
| 操作系统 | Windows 11 + WHPX 是首要目标；Linux / WSL 可开发、跑测试和 Smoke，真实 Hypervisor 验收需对应环境 |
| Node.js | 22.19 或更高（当前验证环境为 24） |
| pnpm | 11.22（由根 `packageManager` 固定） |
| Go | 1.26 或更高（以 `go.mod` 为准） |
| QEMU | Electron 可托管下载到数据根，也可在设置中选择已有 QEMU；Windows 用 WHPX，Linux 用 KVM |
| 模型与机器人 | 至少一套 OpenAI-compatible 或 Anthropic Messages Provider；飞书 / QQ 凭据可选 |
| Windows Guest | 需要合法 ISO 或内部 Golden Image；建议至少 4 GiB 内存 / 32 GiB 磁盘 |

启用 Corepack 后可自动使用固定 pnpm 版本：

```bash
corepack enable
corepack prepare pnpm@11.22.0 --activate
pnpm install
```

### 第一步：把桌面壳跑起来

```bash
pnpm dev:desktop
```

这个脚本会构建共享包、Web、控制平面和 VM Supervisor，然后启动 Electron。Electron 会监管控制平面，并在资源就绪时托管 Go VM Supervisor。

如果只想开发 Web 与控制平面：

```bash
pnpm dev
```

- Web：`http://127.0.0.1:5173`
- 控制平面：`http://127.0.0.1:3000`
- 健康检查：`http://127.0.0.1:3000/api/v1/health`

浏览器首次访问需要本机访问密钥。控制平面启动后在配置目录创建 `web-access-key`：

- Windows：`%APPDATA%\AgentInBox\web-access-key`
- Linux：`~/.config/agent-in-box/web-access-key`
- 设置了 `AGENT_IN_BOX_CONFIG_DIR` 时位于该目录

把文件中的 `aib_...` 粘贴到解锁页即可；Electron 会自动读取并登录，Renderer 不接触密钥。本机自动化可使用 `Authorization: Bearer <key>`。控制平面只允许回环监听，远程访问不在当前范围。

单独运行 VM Supervisor（例如只用 `pnpm dev`）：

```bash
go run ./services/vm-supervisor/cmd/vm-supervisor
```

Supervisor 与控制平面读取同一个 `AGENT_IN_BOX_DATA_ROOT` 或首次向导保存的 `app-config.json`；默认 ACL 令牌位于 `<data-root>/supervisor-acl.token`。QEMU 不在 PATH 时用 `-qemu-system` 和 `-qemu-img` 指定固定二进制路径。端口、Broker 令牌、机器人凭据等高级配置见 [`.env.example`](.env.example) 与 [技术设计](docs/02-technical-design.md)。

### 第二步：走一遍首次启动

1. 在首次启动向导里选择**非系统盘**上的数据根目录，确认 Host Reserve、VM 自动启动策略、本机管理员和敏感操作审批。
2. 在“设置 → 模型与 API 配置”里保存 Provider 凭据，并选择 Worker 默认模型和 Router 模型。长期 Key 只进系统安全存储。
3. 在“设置 → 虚拟机运行组件”下载托管 QEMU，或选择已有 QEMU 的 `bin` 目录。托管下载依赖发布 Manifest；开发环境可用 `AGENT_IN_BOX_RUNTIME_MANIFEST` 指向本地或自建 Manifest。
4. 打开“虚拟机”，使用“一键创建 Linux 工作 VM”；等待下载、创建、cloud-init 初始化和就绪。首次通常需要 5～20 分钟。开发环境首次使用前先执行 `pnpm package:guest-runtime`，发布包已内置这些资产。
5. 新建项目，绑定一台或多台 VM，设置 Guest 工作目录；然后在项目页创建任务，或直接在 Router 主会话里描述目标。

### 第三步：确认服务真的活了

```bash
curl -s http://127.0.0.1:3000/api/v1/health
# {"status":"ok","service":"control-plane","protocolVersion":...}
```

登录后访问 `/api/v1/runtime` 可以拿到解析后的存储布局和数据库路径。VM Supervisor 与 Guest Agent 也提供 `/healthz` 和 `/readyz`；Guest Agent 的认证管理接口还需要对应 token 文件。更多排障与首次使用细节见 [用户指南](docs/04-user-guide.md)。

### 常用命令

```bash
pnpm check                    # lint + typecheck + Vitest + Go test + 构建
pnpm test                     # 前端与 Go 测试
pnpm build                    # 所有 TypeScript 包 + Go
pnpm typecheck
pnpm lint
go vet ./...

pnpm smoke:phase2             # 阶段 Smoke；phase3～phase14 同理
pnpm package:desktop:dir      # 当前平台目录包
pnpm package:desktop:win:portable
pnpm package:desktop:win      # Windows 或可用的 wine；NSIS 安装包
pnpm package:guest-runtime    # Linux Guest Agent / Worker / Node / Pi / cloud-init 资产
pnpm package:vm-supervisor    # Windows / Linux Supervisor 二进制
pnpm release:checksums        # release/SHA256SUMS 与 build-manifest.json
```

阶段 Smoke 的完整清单、各项断言和未关闭门槛见 [`tests/`](tests) 与 [`scripts/`](scripts)。CI 在 `.github/workflows/ci.yml` 中运行 `pnpm check`、`go vet`、关键 Go 包 race 测试和阶段 2～11 服务 Smoke；Windows / Linux 双矩阵使用固定 pnpm、Node 和 `go.mod` 中的 Go 版本。

## 📦 打包、更新与卸载

- `pnpm package:desktop:dir` 生成当前平台目录包；`pnpm package:desktop:win:portable` 可在 Linux / WSL 直接构建 Windows portable exe；`pnpm package:desktop:win` 生成 per-user NSIS 安装包，需要 Windows 或可用的 wine。
- NSIS 不申请管理员权限，安装后提示首次启动向导；卸载默认保留 VM、数据库和用户数据。只有用户明确选择删除且目录带有数据根标记时，才调用清理工具。
- 更新使用 HTTPS Manifest：流式下载、SHA-256 校验、安装前备份数据库与已安装资源，失败可回滚。Windows 上替换 `app.asar` 等资源可能受文件锁影响，干净安装环境的升级 / 回滚仍需验收。
- 受限网络下可设置镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
pnpm package:desktop:win:portable
```

- 发布资产清单、SHA-256 和构建 Manifest 由 `pnpm release:checksums` 生成；它不等于外部代码签名。

## 📂 项目结构

```text
agent-in-box/
├── 🖥️ apps/
│   ├── desktop/          Electron 无特权壳、控制平面监管、托盘、safeStorage、更新
│   └── web/              React + Vite 本地 Web UI；public/logo.svg 为品牌图标
├── 🧩 services/
│   ├── control-plane/    NestJS 控制平面、SQLite、任务 / Worker / 模型 / 机器人 / 审批
│   ├── vm-supervisor/    Go 宿主机 VM 管理（ACL、QEMU / WHPX、QMP、快照）
│   └── guest-agent/      Go Guest Agent（截图 / 输入 / 心跳 / workspace）
├── 📦 packages/
│   ├── protocol/         跨进程协议与事件类型
│   ├── domain/           任务 / Worker 状态机与绑定规则
│   ├── config/           数据目录和本地服务配置
│   ├── agent-runtime/    Worker Engine、Pi RPC、Guest Worker RPC
│   ├── computer-use/     Computer Use 动作协议与校验
│   ├── bot-connector/    飞书 / QQ 长连接、Ingress / 去重
│   └── ui/               状态文案与样式辅助
├── 🧱 internal/          Go 共享实现：QMP、Guest Agent、VM Provider、Supervisor、镜像下载、健康检查
├── 🧪 scripts/           开发启动、打包、发布校验和阶段 Smoke
├── 🗂️ images/            Linux Guest Runtime、Windows Golden Image 资产
├── ✅ tests/             阶段 0～14 验收记录、任务集与安全矩阵
├── 📚 docs/              产品、技术、计划、用户、机器人、存储、隐私
├── ⚙️ .github/workflows/ CI 与发布资产
├── package.json / pnpm-workspace.yaml
├── go.mod
├── .env.example
└── LICENSE（MIT）
```

## 🎨 界面与视觉

工作区采用 Codex 式三栏：左侧项目 / Worker 会话，中间 Router 或 Worker 主会话，右侧只读观察栏。品牌图标源文件是 [`apps/web/public/logo.svg`](apps/web/public/logo.svg)，浏览器 favicon 与 Electron / NSIS / AppImage 图标都由它导出；桌面图标资产在 `apps/desktop/build/`。

## 💾 数据目录

小体积应用配置保存在 OS 配置目录，大文件全部位于用户选择的数据根目录：

- 配置目录：Windows `%APPDATA%\AgentInBox`；Linux `~/.config/agent-in-box`；macOS `~/Library/Application Support/AgentInBox`
- 默认数据根：Windows `%LOCALAPPDATA%\AgentInBox`；首次向导要求确认或改选；`AGENT_IN_BOX_DATA_ROOT` 可强制锁定
- 布局：`images/`、`downloads/`、`vms/<vm-id>/`、`snapshots/<vm-id>/`、`artifacts/`、`archives/`、`inbox/`、`backups/`、`tools/qemu/`
- SQLite：数据根下的 `agent-in-box.sqlite`，WAL 模式 + 外键约束；启动时执行内置 Migration Runner
- 迁移：存储锁下复制并逐个校验文件哈希，SQLite 在线备份并执行 `integrity_check`，全部成功后原子更新配置；失败保留旧目录
- 迁移前备份：检测到待应用 Migration 时先写入 `backups/pre-migration-*.sqlite`、校验完整性并保存 SHA-256；默认保留 5 份

更完整的存储、备份和恢复步骤见 [存储与备份指南](docs/06-storage-guide.md)。

## 📚 文档地图

所有需求与设计决策以 [`docs/`](docs) 和 [`tests/`](tests) 为准，聊天记录不作为最终依据。

| 文档 | 它回答什么问题 |
| --- | --- |
| [`01-product-solution.md`](docs/01-product-solution.md) | 产品定位、核心原则、概念模型与功能范围 |
| [`02-technical-design.md`](docs/02-technical-design.md) | 进程、协议、数据、VM、Worker、Computer Use 与安全设计 |
| [`03-development-plan.md`](docs/03-development-plan.md) | 阶段划分、交付顺序与验收口径 |
| [`04-user-guide.md`](docs/04-user-guide.md) | 安装、首次启动、VM / 项目 / 任务 / 模型 / 机器人 / 更新排障 |
| [`05-bot-guide.md`](docs/05-bot-guide.md) | 飞书与 QQ 应用创建、凭据、白名单和绑定流程 |
| [`06-storage-guide.md`](docs/06-storage-guide.md) | 数据根、迁移、备份、恢复与磁盘空间 |
| [`07-privacy.md`](docs/07-privacy.md) | 本地数据、模型请求、机器人消息与诊断信息边界 |
| [`tests/phase0/`](tests/phase0/README.md) | 高风险技术验证：WHPX、QEMU、Pi、真实模型 CUA |
| [`tests/phase2` ～ `phase14`](tests) | 各阶段验收记录、任务集、安全矩阵与未关闭门槛 |
| [`images/linux/`](images/linux/README.md) | Guest Worker Runtime 安装、systemd 与 cloud-init 资产 |
| [`images/windows/`](images/windows/README.md) | Windows Golden Image 构建、Manifest 与 token 注入 |

阶段 13 的真实 Windows 宿主 + Linux Guest 验收记录见 [`tests/phase13/real-verification-2026-11-12.md`](tests/phase13/real-verification-2026-11-12.md)。

## 🧪 验证与已知边界

当前开发环境已通过 `pnpm check`（lint、typecheck、Vitest、Go test、构建）和阶段 2～14 Smoke。真实 Windows 11 + WHPX 宿主 + Ubuntu Guest 主链路、真实 Router / Worker CUA 与证据校验已有单次验收记录；但单次任务不等于 Computer Use 成功率基线。

明确未实现或未在本环境验证：

- 真实 Windows Guest、Windows ISO Golden Image、WHPX Windows 截图 / 中文输入 / UAC / DPI / 每 VM token 注入仍未验收；Windows 锁屏、UAC、Ctrl+Alt+Del 必须人工处理。
- Windows 干净环境 NSIS 安装、升级和卸载；当前验证了 `win-unpacked` 与 portable 构建。
- 真实飞书 / QQ 应用凭据、平台权限矩阵、网络重推与长时连接稳定性。
- 真实更新源与 Windows 替换 / 回滚实测；回滚替换 `app.asar` 可能受文件锁影响。
- 远程 Relay / 远程 Web / 设备授权 / 端到端加密未实现；只支持本机回环，非回环监听会拒绝启动。
- 真实浏览器与打包 Electron 的人工可访问性 / 响应式验收；前端未做路由级代码分割。
- 存储迁移不重写 qcow2 backing file 路径；迁移进度不流式；下载文件锁只覆盖单控制平面进程。
- 文件投递只落在宿主 `inbox/`，不自动进 Guest，也不直接附加到 Worker 任务。
- 共享 VM 不是强安全隔离；同一 VM 上多个项目共享桌面 / 软件 / 系统状态。
- Wayland、长时 soak、真实 Guest 网络边界和跨多控制平面进程的下载协调未验证。

## 🤝 参与与约定

欢迎提 Issue 和 PR。改动前建议先读 [技术设计](docs/02-technical-design.md) 和 [开发计划](docs/03-development-plan.md)，至少跑完：

```bash
pnpm check
go vet ./...
pnpm smoke:phase2     # 或与改动对应的阶段 Smoke
```

如果改到了部署文件、端口、镜像构建参数或配置变量，请同时更新 [用户指南](docs/04-user-guide.md)、[存储指南](docs/06-storage-guide.md)、[`.env.example`](.env.example) 和本文件，避免文档漂移。

## 📄 License

[MIT](LICENSE) © 2026 great-magician-01

---

<div align="center">

**Agent-in-Box** — *让 Agent 住进虚拟机，虚拟机住进你自己的电脑。*

<img src="apps/web/public/logo.svg" alt="Agent-in-Box 图标" width="56">

<sub>用 Electron、NestJS、React、Go 和 QEMU 慢慢搭起来</sub>

</div>
