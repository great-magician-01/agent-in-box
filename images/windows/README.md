# Windows Guest 镜像与运行时资产

本目录是阶段 13 的 Windows Guest 构建与安装资产。它只被构建机或受控 provisioning 使用；产品不会从本仓库自动下载 Windows，也不分发未授权镜像。Windows ISO、评估镜像或内部镜像的来源与激活责任属于镜像提供方。

> 边界：这些脚本是**参考构建路径**，必须在目标 Windows 版本和合法镜像上实际执行并记录结果。仓库内的自动化测试不下载 Windows ISO、不启动真实 Windows Guest，也不宣称 UAC/锁屏/多显示器已经在本机验收通过。

## 固定版本与运行形态

| 组件 | 版本/来源 | 约束 |
| --- | --- | --- |
| Windows | 用户提供的合法 Windows 10/Server ISO/评估镜像 | 不提交 ISO；不绕过激活、UAC 或安全桌面 |
| QEMU | 阶段 0 冻结的 MSYS2 UCRT64 QEMU 11.1.3 | Windows Host 使用 WHPX；普通用户权限 |
| Node.js | `24.18.0` Windows x64 zip | `node.exe --version` 必须为 `v24.18.0` |
| Pi | `@earendil-works/pi-coding-agent@1.5.1` npm tarball | 无法从公网安装时由显式 tarball 提供 |
| Worker Runtime | `packages/agent-runtime` 的 release 归档 | 含 `dist/worker-rpc-main.js` 与 `pi-launch.js` |
| Guest Agent | Go `windows/amd64` 构建 | 运行在交互式登录会话内 |
| 端口 | Guest `0.0.0.0:7611` / `0.0.0.0:7612` | Windows 防火墙只允许来自 `10.0.2.2` 和 `127.0.0.1` |
| 长期秘密 | 无 | Provider Key、机器人 Secret、Guest/RPC token 不进入镜像 |

Windows Guest 的 QEMU 参数由 `internal/vmprovider` 固定为：

- `-machine q35 -drive ...if=ide`：避免 stock Windows 缺少 virtio-block 驱动；
- `-device e1000`：Windows 自带的模拟 Intel NIC 驱动；
- `-cpu qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt`：保留 WHPX 已验证的 qemu64 基线，同时满足现代 Windows 的指令集要求；
- `-vga std` + `qemu-xhci` + `usb-tablet`：标准 VGA 与绝对坐标指针，供 noVNC 和 Guest Agent 使用；
- 不依赖 VirtIO GPU/输入/网络驱动；VirtIO 驱动 ISO 只是可选构建辅助。

该 profile 不含 TPM 2.0 与 UEFI/Secure Boot。Windows 10 和 Windows Server 评估镜像可直接安装；**Windows 11 客户机需要额外的 OVMF + `swtpm` 配置**，不属于当前冻结 profile。若必须交付 Windows 11，应先在目标 Provider 上验证 TPM/UEFI 方案，再更新本目录与 Provider 参数，不能用跳过硬件检查的安装脚本冒充已验证支持。

`qemu64` 加装的 SSE4.2/POPCNT 组合用于现代 Windows 内核；阶段 0 在目标 WHPX 主机上只验证过纯 `qemu64` 的 Linux Guest，Windows Guest 的实际启动、SMP 与稳定性仍需在目标 CPU 上复测，出现启动挂起时优先回退并记录 CPU 能力差异。

## 文件

```text
images/windows/
├── README.md
├── manifest.example.json              # 自定义镜像 Manifest 示例（校验和需替换）
├── unattend/
│   └── autounattend.xml.example       # 无人值守安装参考模板（UAC 保持开启）
├── scripts/
│   └── build-golden-image.ps1         # 用合法 ISO 构建 Windows Golden Image
└── guest-runtime/
    ├── install.ps1                    # 安装 Node/Pi/Worker/Guest Agent、防火墙与登录任务
    ├── Install-FromProvisioning.ps1   # 首次登录入口，从 AIB-PROVISION 卷安装后关机
    ├── Start-GuestAgent.ps1           # 登录会话内启动 Guest Agent
    ├── Start-Worker.ps1               # 登录会话内启动 Worker RPC
    ├── Provision-Tokens.ps1           # 写入每 VM 的 Guest/RPC token（不打印值）
    └── cua-extension.js               # 与 Linux 版本字节一致的 Computer Use 扩展
```

## 1. 准备镜像

1. 从合法渠道取得 Windows 10/Server ISO（例如 Microsoft Evaluation Center）并记录 SHA-256；必须选择 Desktop Experience，Server Core 没有可操作的桌面；
2. 复制 `unattend/autounattend.xml.example`，按实际 ISO 调整 `/IMAGE/INDEX`、语言、时区、管理员密码和 VirtIO 驱动路径；
3. 准备 provisioning 根目录（例如 `D:\iso\aib-provision`）：

```text
provision-root/
├── autounattend.xml                 # 复制并修改 unattend/autounattend.xml.example
└── AIB-PROVISION/
    ├── install-guest-runtime.ps1    # 复制 guest-runtime/Install-FromProvisioning.ps1
    ├── install.ps1                  # 复制 guest-runtime/install.ps1
    ├── Start-GuestAgent.ps1         # 复制 guest-runtime/Start-GuestAgent.ps1
    ├── Start-Worker.ps1             # 复制 guest-runtime/Start-Worker.ps1
    ├── Provision-Tokens.ps1         # 复制 guest-runtime/Provision-Tokens.ps1
    ├── cua-extension.js             # 复制 guest-runtime/cua-extension.js
    └── artifacts/
        ├── node-v24.18.0-win-x64.zip
        ├── earendil-works-pi-coding-agent-1.5.1.tgz
        ├── agent-in-box-worker-<version>.tar.gz
        └── guest-agent-windows-amd64.exe
```

4. 生成 Worker 归档与 Guest Agent 二进制：

```bash
pnpm package:worker-runtime
pnpm package:guest-agent
```

5. 运行构建脚本（当前工作目录为仓库根目录）：

```powershell
pwsh -File images/windows/scripts/build-golden-image.ps1 `
  -WindowsIso D:\iso\windows11-eval.iso `
  -WindowsIsoSha256 <iso-sha256> `
  -ProvisionDirectory D:\iso\aib-provision `
  -OutputQcow2 D:\images\windows-golden.qcow2 `
  -VncDisplay 9
```

构建脚本会安装 Windows、执行首次登录 provisioning、在结束时关机，并生成：

- `<image>.qcow2`
- `<image>.qcow2.sha256`
- `<image>.build.json`（ISO 哈希、QEMU 参数、镜像大小、构建时间）

之后把 `osVersion` 填入 `build.json`，把 qcow2 上传到内部 HTTPS 地址，并复制 `manifest.example.json` 替换 URL、大小和 SHA-256。控制平面通过 `AGENT_IN_BOX_IMAGE_MANIFEST` 加载该 Manifest。

## 2. 首次启动会话与自动登录

Guest Agent 使用 Windows GDI 屏幕采集和 `SendInput`，必须运行在**已登录用户**的交互式桌面会话内。参考模板创建本地用户 `aib` 并开启自动登录；镜像提供方必须：

- 在隔离 VM 内使用本地账号，不放入个人 Microsoft 账号；
- 保持 UAC 开启，不关闭锁屏、Ctrl+Alt+Del、安全桌面或激活机制；
- 理解自动登录会降低宿主 VM 的本地保护，建议在镜像说明中明确提示；
- 在多显示器、DPI 缩放、锁屏和 UAC 场景下实际录入验收结果。

登录任务以 `RunLevel Limited` 运行 Guest Agent 和 Worker：

- `AgentInBox-GuestAgent`：`Start-GuestAgent.ps1`；
- `AgentInBox-Worker`：`Start-Worker.ps1`。

两者会在 token 文件存在前保持等待，不会以匿名模式开放端口。

## 3. 每 VM Token 注入

Golden Image **不包含** Guest Agent token 或 Worker RPC token。控制平面在 VM 存储目录读取：

```text
<vm storage>/guest-agent.token
<vm storage>/worker-rpc.token
```

每台 Windows VM 需要把同值的 token 注入 Guest。推荐流程：

1. 宿主生成两个随机 token，分别写入 VM 存储目录（0600）；
2. 把 token 文件放到受控 provisioning 介质（例如临时只读卷）；
3. 在 Guest 内执行：

```powershell
pwsh -File C:\AgentInBox\scripts\Provision-Tokens.ps1 `
  -SourceDirectory E:\AIB-TOKENS `
  -User aib `
  -RemoveSource
```

4. 重启 `AgentInBox-GuestAgent` 与 `AgentInBox-Worker` 任务，或重新登录。

`Provision-Tokens.ps1` 拒绝空值、空白字符、reparse point 和异常大小，并把目标目录 ACL 限制为 SYSTEM/Administrators/目标用户只读。token 值不会打印。

Guest Agent 额外使用 `-allowed-client-cidrs 10.0.2.2/32`：只有经 QEMU 宿主机转发（在 Guest 内显示为网关 `10.0.2.2`）的请求才被接受，Guest 内进程即使读到 token 也不能直接调用 `127.0.0.1:7611`。宿主机侧 VNC/QMP、Guest Agent 与 Worker RPC 的转发端口统一绑定 `127.0.0.2`，Guest 经 `10.0.2.2` 无法访问这些管理面。仍应把交互用户视为不可信：不要给 `aib` 用户额外的管理员权限，也不要在镜像中保留示例密码。

当前产品没有自动把 token 注入 Windows Guest 的介质生成器；这是阶段 13 真实环境验收仍待关闭的发布门槛。不得用镜像内固定 token 规避该边界。

## 4. 安全桌面与人工接管

Windows Guest Agent 在以下状态返回稳定的 `423 Locked`：

| 状态 | `errorCode` | 行为 |
| --- | --- | --- |
| 锁屏或无法打开输入桌面 | `session_locked` | 截图/输入拒绝，Computer Use 任务转 `blocked` |
| UAC/安全桌面（非 Default 桌面） | `secure_desktop` | 同上，不尝试注入或绕过 |

Heartbeat 会把这两种状态报告为 `degraded` 并带 `sessionState`。人工可通过 noVNC 控制台登录、处理 UAC 或解锁，然后重新观察并恢复任务。`Ctrl+Alt+Del` 不能由 `SendInput` 注入，属于必须人工处理的安全序列。

## 5. 验证状态（2026-11-11）

已实现并在本仓库自动化中验证：

- Go Windows Guest Agent 编译与单元测试（键位映射、滚轮换算、会话状态、进程证据枚举）；
- Windows QEMU profile 参数单元测试（IDE/e1000/std VGA/xHCI）；
- 共享的 Windows 路径校验与文件证据根目录；
- `pnpm package:guest-agent` 生成 Windows 二进制与 SHA-256；
- CI 在 Ubuntu 上交叉编译 Windows Guest Agent，在 Windows 上运行原生 Go 测试。

尚未关闭的真实环境门槛：

- 使用合法 Windows ISO 实际完成无人值守安装与 Golden Image 启动；
- 真实 WHPX 下 Windows 桌面会话、DPI、多显示器、锁屏、UAC 与中文输入回归；
- 真实 Windows Pi/模型 Computer Use 任务集和重复成功率；
- 自动 token 介质注入与干净电脑端到端安装。
