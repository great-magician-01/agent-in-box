# 阶段 13 验收记录：Windows VM 可行性、开发与本期最终联合验收

日期：2026-11-11

## 结论

阶段 13 完成了当前环境可在代码与本机自动化中交付的 Windows Guest 主链路：

- **Windows VM Provider Profile**：`VmSpec` 增加 `osFamily`，QEMU 对 Windows 使用 `if=ide`、`e1000`、`std` VGA、`qemu-xhci` + `usb-tablet`，不依赖 stock Windows 缺失的 VirtIO 驱动；Linux 参数保持原状。
- **Windows Guest Agent**：新增 Windows 原生 GDI 屏幕采集、`SetCursorPos`/`SendInput` 鼠标键盘、Unicode 输入、滚轮/拖拽、DPR 感知、虚拟桌面坐标和进程证据枚举。锁屏或 UAC 安全桌面返回 `423 session_locked` / `secure_desktop`，Heartbeat 降级为 `degraded`，任务转 `blocked` 等待人工接管。
- **Windows 路径与策略**：项目工作目录、文件证据根目录、workspace 归档/恢复支持 Windows 盘符绝对路径；拒绝 `..`、UNC、NTFS 数据流和文件系统根目录。
- **Windows Worker Runtime**：Windows 上 npm 的 `.cmd` shim 不能直接 `spawn`，新增 `AGENT_IN_BOX_PI_SCRIPT` 通过 Node 启动 Pi CLI；Worker Runtime 打包包含该入口。
- **混合项目与调度**：项目可同时绑定 Linux/Windows VM；看板任务包含 `vmOsFamily`；Router 的 `list_projects` 与 `get_board_summary` 暴露 OS 和每 VM 队列；同 VM 串行、跨 VM 并行由原 TaskService 保证。
- **镜像与安装资产**：新增 `images/windows/` 的合法 ISO 构建脚本、无人值守模板、Guest Runtime 安装/启动/token 注入脚本、内部 Manifest 示例和 `pnpm package:guest-agent`；Linux/Windows CUA 扩展字节一致。
- **自动化**：新增 `pnpm smoke:phase13`，使用真实 Guest Agent 进程、真实控制平面/SQLite、真实 Guest workspace 往返和混合 VM Fixture 完成 12 项检查。

`pnpm smoke:phase13` 12 项通过；机器结果见 [`results/2026-11-11-smoke.json`](results/2026-11-11-smoke.json)。

**边界说明**：本轮没有真实的合法 Windows ISO 安装、WHPX Windows Guest、Windows 截图/中文输入、UAC/锁屏、多显示器/DPI、Windows Pi/模型任务、NSIS 干净安装或长时 soak。`smoke:phase13` 中的 VM 是持久数据库 Fixture，Guest Agent 只验证启动、认证、进程证据和 workspace 往返，未对宿主桌面截图或注入输入。真实环境结果不能由本记录替代。

## 13.1 Windows Guest 镜像与基本可行性

### 已落地

1. **合法来源与许可**：`images/windows/README.md` 明确只接受用户提供的合法 ISO/评估镜像/内部镜像；不下载、不分发、不绕过激活。
2. **无人值守安装**：`unattend/autounattend.xml.example` 提供与 SeaBIOS 一致的 BIOS/MBR 分区、OOBE 跳过、本地账号、自动登录和首次登录 provisioning；**UAC 保持开启**，未禁用锁屏或安全桌面。
3. **Golden Image 构建**：`scripts/build-golden-image.ps1` 校验 ISO 哈希、创建 qcow2、以 IDE/e1000/std VGA 启动 Windows 安装、等待 provisioning 关机、执行 `qemu-img check`，输出 `.sha256` 与 `.build.json`。
4. **镜像校验与适用性**：`manifest.example.json` 给出 Windows Manifest；`AGENT_IN_BOX_IMAGE_MANIFEST` 可同时加载 Linux/Windows 条目。构建元数据记录 ISO 哈希、qemu 参数、镜像格式、虚拟大小和 SHA-256。
5. **Provider 参数**：`TestBuildQemuArgsWindows` 校验 IDE 磁盘、provisioning CD-ROM、`std` VGA、xHCI/USB tablet、e1000 和 Guest/Worker hostfwd，并断言不出现 VirtIO 桌面/网络设备。
6. **版本边界**：当前冻结 profile 不含 TPM 2.0/UEFI Secure Boot，面向 Windows 10/Server 评估镜像；Windows 11 客户机需要额外 OVMF + `swtpm` 方案，未在本期 profile 中宣称支持。CPU 模型在阶段 0 的 `qemu64` 基线上增加 SSE4.2/POPCNT，需在目标 WHPX CPU 上重新验证启动与 SMP 稳定性。

### 验收对照

| 验收项 | 当前证据 | 状态 |
| --- | --- | --- |
| 可重复镜像构建与启动路径 | 构建脚本、无人值守模板、构建元数据 | **参考路径已交付，未在真实 ISO 上执行** |
| 镜像来源和许可清晰、不分发无许可镜像 | README、Manifest 示例、构建脚本不下载 ISO | 通过（文档/代码边界） |
| UAC、锁屏、安全桌面有明确人工方案 | Guest Agent 423 错误、Heartbeat 降级、任务 blocked | 自动化通过；真实 Windows 待验收 |
| 主路径不可行时先调整 Provider/镜像 | IDE/e1000/std VGA 的 Windows profile 已独立 | 通过（参数级） |

## 13.2 Windows VM 生命周期与存储适配

### 已落地

- `SupervisorCreateSpec.osFamily` 由控制平面传入；Supervisor 仍只接受固定 `VmSpec`，没有任意命令接口。
- `VmService.create` 允许 Windows 镜像，强制至少 4 GiB 内存和 32 GiB 磁盘；VM 记录保存真实 `os_family`。
- Create/Start/Stop/Suspend/Resume/Snapshot/State 复用统一 Provider；Windows 只是参数 profile 差异，生命周期语义与 Linux 相同。
- Windows 工作目录允许 `C:\...`，项目备份、文件证据与 Guest workspace 操作使用同一套安全绝对路径校验。
- 资源管理、Per-VM Lease、共享 VM、Supervisor 重启对账不区分 Guest OS。

### 验收对照

| 验收项 | 当前证据 | 状态 |
| --- | --- | --- |
| Windows/Linux 使用统一领域模型和任务协议 | `VmSpec.osFamily`、`VmInstanceRecord.osFamily`、统一 Task/Lease | 通过 |
| 停止、休眠、宿主重启后状态准确 | 复用阶段 3/9 生命周期与对账；Windows 参数单元测试 | 自动化通过；真实 Windows 未验收 |
| 同一 Windows VM 跨项目任务串行 | `smoke:phase13` 同 VM claim 第二次返回 null | 通过（数据库/Fixture） |
| 多台 Windows VM、无固定数量硬限制 | 无数量上限；仅资源软预算与队列 | 通过（代码） |

## 13.3 Windows Guest Agent 与 Computer Use

### 已落地

- `internal/guestagent/desktop_windows.go`：
  - 进程启动时启用 Per-Monitor V2 DPI 感知（失败回退）；
  - 虚拟桌面 GDI `BitBlt` + `GetDIBits` 采集，32 位 BGRA 转 RGBA PNG；
  - `SetCursorPos` + `SendInput` 完成移动、点击/双击、左右/中键、滚轮/横向滚轮、拖拽；
  - `KEYEVENTF_UNICODE` 发送 UTF-16 文本，支持中文/emoji 代理对；换行映射 `VK_RETURN`；
  - 命名键和单字符组合键通过 `VkKeyScanW` 映射，扩展键带 `KEYEVENTF_EXTENDEDKEY`；
  - `OpenInputDesktop` + `GetUserObjectInformationW` 检测 Default/锁屏/安全桌面，拒绝截图和输入并返回稳定错误码；
  - `SessionState`、`Locked`、`SecureDesktop` 进入 `/v1/desktop`、`/v1/capabilities` 和 `/v1/heartbeat`。
- `internal/guestagent/verify_proc_windows.go` 使用 Toolhelp32 进程快照实现只读进程证据，不打开进程、不执行命令。
- 控制平面 `GuestClient` 保留 Guest 错误码；`CuaExecutionService` 在 `session_locked`/`secure_desktop` 时把任务置为 `blocked`，错误码 `guest_session_locked`，不重放旧动作。
- 文件名/进程名/路径均拒绝 NUL、父目录段、数据流和路径分隔符滥用。

### 验收对照

| 验收项 | 当前证据 | 状态 |
| --- | --- | --- |
| Windows 截图、坐标、中文输入、人工接管 | 代码与单元测试；`smoke:phase13` 不触碰真实宿主桌面 | **真实 Windows Guest 待验收** |
| 无有效 Lease 的输入不会执行 | 原有 GuestService/Lease 流程未改；Windows 走同一通道 | 通过（复用阶段 4/7） |
| 取消后无残留动作 | 动作 ID 去重、超时、Lease 校验；Windows 输入循环检查 ctx | 自动化通过；真实 Windows 待验收 |
| 状态不确定时不盲目重放 | 锁屏/UAC 返回 blocked；分辨率变化强制重新观察 | 自动化通过 |

## 13.4 Windows Pi Worker 与 Model Broker

### 已落地

- `resolvePiLaunch`/`AGENT_IN_BOX_PI_SCRIPT`：Windows 用当前 Node 执行 Pi CLI 脚本，避免直接 `spawn` `.cmd`；Linux 保持 `pi` shim。
- `package-worker-runtime` 归档包含 `dist/pi-launch.js`。
- `images/windows/guest-runtime/install.ps1` 固定 Node 24.18.0 与 Pi 1.5.1，校验 Node/Pi 版本、归档内容和可选 SHA-256 sidecar；Worker 以登录会话普通权限任务运行。
- 系统提示根据 VM OS 注入 Linux/Windows，并明确锁屏/UAC 需人工接管。
- Windows Worker 使用与 Linux 相同的 RPC 协议、短期 Broker token 和 Controller 侧 Lease；安装资产不写长期 Provider/机器人 Secret。

### 验收对照

| 验收项 | 当前证据 | 状态 |
| --- | --- | --- |
| Windows/Linux Worker 同一 Engine 协议 | 同一 `WorkerRpcServer`/`WorkerRpcClient`/`PiWorkerEngine` | 通过（代码） |
| 取消、断线、归档、恢复准确 | 阶段 6/8 测试复用；Windows 仅启动方式差异 | 自动化通过；真实 Windows 待验收 |
| 会话不兼容时明确降级 | 原有 native/summary 降级路径 | 通过 |
| Windows VM 不含长期 Provider/机器人 Secret | 安装脚本无密钥参数、token 独立目录、镜像不写 token | 通过（资产审查） |

## 13.5 Linux/Windows 混合项目与调度

`smoke:phase13` 在真实控制平面内验证：

1. 自定义 Manifest 同时加载 Linux 与 Windows 镜像；
2. 一个项目通过 HTTP 绑定 Linux 和 Windows VM，Windows 工作目录为 `C:\Users\aib\AgentInBox\workspace`；
3. 非法 Windows 父目录穿越与 NTFS 数据流在 HTTP 边界返回 400；
4. 两个 VM 各有一个任务运行，另有两个任务排队：跨 VM 并行成立；
5. 对同一 VM 再次 `claimNext` 返回 null：同 VM 串行成立；
6. 任务看板返回 `vmOsFamily`；Router `list_projects` 和 `get_board_summary` 返回 OS 与每 VM 队列；
7. Router 工具面仍不包含宿主 Shell、VM 输入或 Supervisor 通用接口。

各端使用同一数据库快照与失效通知；Web/Electron 的任务行和项目绑定已显示 Linux/Windows。

## 13.6 最终联合回归与发布

### 已自动化

- `pnpm smoke:phase13` 12 项通过；阶段 2～12 Smoke 已在阶段 13 改动后全部重跑通过；
- Go Windows Guest Agent 原生测试：键位映射、滚轮、会话状态、进程快照、路径安全；
- QEMU Windows profile 参数测试；
- `pnpm package:guest-agent` 生成 Linux/Windows 二进制、`.sha256` 和 manifest；
- CI 增加 Ubuntu 交叉编译 Windows Guest Agent、Windows 原生 Go 测试和 phase13 Smoke/artifact。

### 尚未关闭的发布门槛

1. 用合法 Windows ISO 在目标 WHPX 上执行无人值守安装、Golden Image 启动和重复构建；
2. 真实 Windows 截图、鼠标、滚动、拖拽、中文/emoji 输入，以及 DPI/多显示器回归；
3. 真实 UAC、锁屏、Ctrl+Alt+Del 和现代待机/休眠行为；
4. 真实 Windows Pi/模型 Computer Use 与 Router 任务集成功率/接管率；
5. 每 VM token 自动注入介质（当前需受控 provisioning）；
6. 干净 Windows Host 的 NSIS 安装、升级、回滚、卸载，以及两种 Guest 的端到端任务；
7. Windows Host 重跑 Linux 全链路，确认 P0 无回归；
8. 多台 Windows/Linux VM 并行、内存压力、断电和长时 soak。

## 自动化与真实进程证据

- `pnpm smoke:phase13` 12 项通过：
  1. 真实 Guest Agent 进程启动、未认证请求被拒绝、平台与能力可读取；
  2. Guest 只读进程证据返回真实 PID（Windows `node.exe`）；
  3. Guest workspace 归档/恢复到 Windows/Linux 路径并校验 SHA-256；
  4. 每 VM Guest/RPC token 生成可复现，默认拒绝覆盖；
  5. 控制平面以自定义 Linux+Windows Manifest 启动；
  6. Image Service 同时接受两种 OS 条目；
  7. HTTP 项目创建与双 OS 绑定接受 Windows 绝对工作目录；
  8. Windows 父目录穿越和 NTFS 数据流被拒绝；
  9. 跨 VM 并行、同 VM 串行；
  10. 看板任务带 `vmOsFamily`；
  11. Router 项目与看板摘要暴露 OS/队列且无宿主执行能力；
  12. Windows 构建/安装/Manifest 资产齐全，Linux/Windows CUA 扩展字节一致。
- Go 测试：`go test ./internal/guestagent ./internal/vmprovider ./internal/vmsupervisor`；
- 新增 Vitest：`guest.client.test.ts`、`pi-launch.test.ts`、domain Windows 路径、CUA 锁屏/UAC block、VM Windows profile、policy Windows roots。

## 复现

```bash
pnpm check
pnpm smoke:phase13
pnpm package:guest-agent
pnpm package:worker-runtime
```

机器结果可另存到 `AGENT_IN_BOX_PHASE13_RESULT`；设置 `AGENT_IN_BOX_PHASE13_KEEP=1` 保留临时数据目录。真实 Windows 环境请按 [`images/windows/README.md`](../../images/windows/README.md) 和 [`mixed-tasks.json`](mixed-tasks.json) 执行，并逐项记录证据。
