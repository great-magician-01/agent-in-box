# Windows Host + QEMU/WHPX 稳定性与自定义路径验证

> 对应阶段 0.2 的 Hypervisor 稳定性补充验证。日期 2026-11-10；宿主机 H1；全程普通用户权限，未启用任何 Windows 功能、未提权、未启动 Pi/模型任务、未改动 broker。所有 QEMU 均只绑定 127.0.0.1。

## 0. 环境与范围

| 项 | 实测值 |
| --- | --- |
| OS | Microsoft Windows 11 家庭版 中文版 25H2，10.0.26200.9711，ProductType 1，EditionID `CoreCountrySpecific` |
| CPU | Intel Core Ultra 5 225H，14 核 / 14 逻辑处理器 |
| 物理内存 | 33,816,190,976 bytes（约 31.5 GiB） |
| QEMU | 11.1.3（MSYS2 mingw-w64-ucrt-x86_64-qemu），加速器 `tcg`, `whpx` |
| 系统卷 | C: 500 GB（测试时约 200 GB 可用） |
| 其他卷 | D: 451.6 GB（约 180 GB 可用）；与 C: 同属 Disk 0（YMTC YMSS2ED08B66MC 953.9 GB NVMe）的**非系统分区，不是第二块物理盘** |
| 工作环境 | WSL2（Ubuntu 26.04），通过 `powershell.exe` 驱动 Windows 侧脚本与 QEMU |
| 桌面 VM | `%LOCALAPPDATA%\AgentInBox\vms\phase0-desktop`，保留未删除；测试前最后一次关机为 19:11 的 ACPI 正常关机 |
| 基础镜像 | `%LOCALAPPDATA%\AgentInBox\images\noble-server-cloudimg-amd64.img`，保留未删除 |

方法说明：

- 新脚本 `tests/phase0/scripts/phase0-stability-provider.ps1`、`phase0-stability-desktop.ps1`、`phase0-stability-hyperv.ps1` 为纯 ASCII 源码（Windows PowerShell 5.1 会把无 BOM 脚本按 ANSI 读取，中文路径在脚本内由 Unicode 码点构造）。为规避 `RemoteSigned` 对 UNC 路径的限制，执行副本放在 `%LOCALAPPDATA%\AgentInBox\tools\`，仓库内脚本为源。
- Go 集成测试二进制用 `GOOS=windows GOARCH=amd64 go test -c -o ... ./internal/vmprovider` 编译；原始 5 轮使用 2026-11-10T11:54:31Z 的构建，Provider 短路径修复后重新构建，C:/D: 最终两轮使用修复后的最终二进制。
- 未提交 Git。原始结果、控制台、stderr 与截图保存在 `%LOCALAPPDATA%\AgentInBox\stability-logs\`，小体积失败证据复制到 `tests/phase0/results/evidence/`。

## 1. Provider 重复启动稳定性（5 轮）

命令（Windows PowerShell）：

```powershell
powershell -NoProfile -File C:\Users\admin\AppData\Local\AgentInBox\tools\phase0-stability-provider.ps1 `
  -Rounds 5 -StartRound 1 `
  -ResultJson C:\Users\admin\AppData\Local\AgentInBox\stability-logs\provider-stability-default.json
```

默认存储根为 `%LOCALAPPDATA%\AgentInBox\vms-go`，每轮运行真实 `TestQemuProviderIntegration`：创建 qcow2 覆盖盘，QEMU/WHPX 启动，等待 Guest login，Provider 重启后按 PID 对账，幂等 Start/Stop，ACPI 优雅停止，内部快照创建/恢复，删除 VM。

| 轮次 | 开始（UTC） | 墙钟秒 | Go test 秒 | 退出码 | 结果 | 残留 QEMU |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 11:56:45 | 31.69 | 31.65 | 0 | pass | 0 |
| 2 | 11:57:19 | 31.20 | 31.17 | 0 | pass | 0 |
| 3 | 11:57:53 | 30.74 | 30.70 | 0 | pass | 0 |
| 4 | 11:58:26 | 29.18 | 29.15 | 0 | pass | 0 |
| 5 | 11:58:57 | 31.30 | 31.25 | 0 | pass | 0 |

- 5/5 通过；墙钟均值 30.82 s，最小 29.18 s，最大 31.69 s；Go test 均值 30.78 s。
- 每轮结束等待 2 s 后按命令行含 `go-provider-smoke` 过滤 QEMU 进程，均为 0；最终也为 0。`go-provider-smoke` VM 目录在通过轮次后均被删除，无遗留。
- 说明：第一次运行的 Harness 受 `Start-Process -PassThru` 在该机返回空 `ExitCode` 的缺陷影响，把一轮实际 `PASS` 误记成失败并退出；随后改用 `System.Diagnostics.Process` 捕获退出码。上表 5 轮是修复后的干净结果，未把误记轮计入。
- 时间跨度：同日 17:51–17:52 的历史日志还有 4 轮通过（33.18 s、31.73 s、31.27 s、31.27 s，见 `%LOCALAPPDATA%\AgentInBox\vms-go-test-output-run*.txt`）。与本轮 5 轮合并为 9 次成功，跨约 2 小时，均无残留 QEMU 记录。
- 结论：**默认路径下 Provider 生命周期 5 轮重复启动通过**，未见残留 QEMU 或目录泄漏。它不是长时间 soak（本轮总耗时 165.76 s）。

结果文件：`tests/phase0/results/2026-11-10-h1-whpx-provider-stability-5x.json`。

## 2. CPU 模型对比（host / max / qemu64）

均使用 `phase0-stability-desktop.ps1 -HoldMinutes 0` 做启动探针：启动现有桌面盘，等待 SSH 与 `xfce4-session`，QMP `screendump`，然后 QMP `system_powerdown` 优雅关机。

| CPU 模型 | 结果 | SSH 就绪 | 到 XFCE | QMP screendump | ACPI 关机 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `host` | pass | 18.55 s | 18.74 s | 12.3 ms / 3,072,016 B | 1.4 s | 单次探针通过；stderr 仅 `failed to get xsave state` |
| `max` | pass | 14.88 s | 15.04 s | 13.6 ms / 3,072,016 B | 1.4 s | 单次探针通过；历史上“装机后 SMP 启动卡住”本次未复现 |
| `qemu64` | pass | 23.57 s | 24.09 s | 17.5 ms / 3,072,016 B | 2.1 s | 通过；随后用于 10 分钟长稳 |

- 三个模型本次都能到 XFCE。此前（同日更早）记录过 WHPX + 该 CPU 上 `-cpu max` 在桌面装机后 SMP 初始化卡住，以及一次 Guest 内核 panic（init SIGSEGV）。本次 `max` 单次通过**不能关闭**上述历史事故；根因仍未定位。
- `qemu64` 仍是 Provider 默认与保守基线，长稳也使用 `qemu64`；`host` / `max` 只做了短探针，未做长稳，不建议据此改变默认。
- 启动到 XFCE 在多次探针中为 13.43–24.09 s，差异主要来自前一次运行的 qcow2 恢复/宿主缓存状态，未观察到与 CPU 模型的稳定相关性。
- stderr 只有非致命告警：`failed to get xsave state: No error`（host/max）与 `host doesn't support requested feature ... .svm`（qemu64）；均未导致启动失败。控制台未发现 `Kernel panic` / `Oops` / `segfault`。
- 按任务原文直接运行**现有** `phase0-desktop-start.ps1 -CpuModel host`：QEMU 启动成功，`guest-ssh` 在 17.28 s 检测到 SSH、17.3 s 检测到 `xfce4-session`；外部 `qmp.ps1` 截图 62.2 ms（3,072,016 B，1280×800），ACPI 关机 5.1 s，QEMU 退出。原始指标保存在 `%LOCALAPPDATA%\AgentInBox\stability-logs\desktop-startscript-host.json`。
- 因三种模型均通过，**没有产生 CPU 模型启动失败证据**；历史事故证据见 `tests/phase0/results/2026-11-10-h1-whpx-stability-incident.json` 与 `tests/phase0/runbook-windows-qemu.md`。

结果文件：`tests/phase0/results/2026-11-10-h1-whpx-cpu-model-boot.json`。

## 3. 自定义存储路径（空格 / Unicode）

`AGENT_IN_BOX_VM_STORAGE` 分别指向以下目录，各跑一轮真实 `TestQemuProviderIntegration`：

| 路径 | 属性 | 结果 | 实测 |
| --- | --- | --- | --- |
| `%LOCALAPPDATA%\AgentInBox\space path test\vms` | ASCII + 空格 | **pass** | 24.77 s，exit 0，创建/启动/登录/重启对账/幂等启停/优雅停止/快照创建与恢复全部走完 |
| `%LOCALAPPDATA%\AgentInBox\路径 测试\vms` | Unicode + 空格，C: | **fail** | 0.54 s 时 `start vm: qemu exited during startup`；QEMU stderr：`cannot create PID file: Failed to create PID file` |
| `D:\路径 测试\vms` | Unicode + 空格，D: 非系统分区 | **fail** | 0.55 s，同样错误 |

失败细节：

- Provider 已成功用 `qemu-img` 在 Unicode 目录创建 20 GiB qcow2 覆盖盘并写入 `vm.json`，说明 Go 侧与 qemu-img 的 Unicode 路径可用；失败发生在 QEMU 进程启动阶段。
- 用正确引用参数（与 Go `os/exec` 生成的带空格参数形式一致）单独测试 QEMU 11.1.3：
  - ASCII + 空格的 `-pidfile`：成功创建 6 字节 pid 文件，QEMU 保持运行；
  - Unicode + 空格 / Unicode 无空格的 `-pidfile`：均 `cannot create PID file`；
  - Unicode 的 `-serial file:`：`open ... failed`；
  - Unicode 的 `-drive file=...qcow2`：`Could not open ...: 系统找不到指定的路径。`；
  - `qemu-img info` 同一 Unicode 路径覆盖盘：成功，20 GiB 虚拟、192 KiB 实占、backing file 正常。
- 根因判断：该 MSYS2 QEMU Windows 构建对 `-pidfile`、`-serial`、`-drive` 的文件路径处理与 Windows ANSI 代码页（CP936）不兼容；中文路径在 ANSI API 下变成不可用路径。它不只是空格问题，也与 C:/D: 卷无关。
- `tests/phase0/results/evidence/2026-11-10-h1-whpx-unicode-path-manual-probes.txt` 保存了上述隔离探针；“非系统盘”方面，D: 只是同一块 NVMe 上的第二分区，**第二块物理盘仍未验证**。

修复前结论：**自定义 ASCII 空格路径通过；含 Unicode 的自定义路径未通过**（创建成功、启动失败，停止/快照在 Unicode 路径上无法验证）。

### 3.1 修复实现与复测（短路径 + ASCII junction）

修复前失败证据保留：上面的失败仍保存在 `2026-11-10-h1-whpx-custom-storage.json` 与 `tests/phase0/results/evidence/2026-11-10-h1-whpx-unicode-path-*`，用于证明问题真实存在。

本次在 `internal/vmprovider` 实现：

- 新增 `qemu_path.go`（纯路径解析与注入式测试）、`qemu_path_windows.go`（`GetShortPathNameW` + ASCII junction 回退）、`qemu_path_unix.go`（非 Windows 不转换）、`qemu_path_test.go`。
- `qemu_provider.go`：`CreateVm` 在 `qemu-img create` 前解析 base image 与 overlay 路径（确保 qcow2 backing filename 可被 QEMU 打开）；`StartVm` 在启动 QEMU 前解析 overlay disk、seed、`-serial file:`、`-pidfile`、`-L` 与 QEMU 工作目录；解析失败返回明确的 `prepare QEMU paths: ...` 并写入 `PowerError`/`LastError`，不会“启动后莫名失败”。`DeleteVm` 清理该 VM 的 runtime junction。
- 本机关键事实：C: 的 8.3 短名仍含中文（`...\路径测~1\...`），单靠 `GetShortPathNameW` 不够；D: 的 8.3 生成被禁用，API 返回长路径。因此回退到 ASCII 目录 junction：`%LOCALAPPDATA%\AgentInBox\vm-runtime\dirs\<sha256 前缀>` -> 长 Unicode 目录，使用非提权的 `mklink /J` 创建。QEMU 参数中只出现 ASCII 路径。
- 捕获到的实际 QEMU 命令行（已保存为证据）：`-drive file=C:\...\vm-runtime\dirs\583da32...\disk.qcow2,... -serial file=...\console.log ... -pidfile ...\qemu.pid -L C:\...\tools\msys64\ucrt64\share\qemu`，参数中无中文。
- 单元测试 `go test ./internal/vmprovider` 通过；路径转换测试使用注入 resolver，不依赖本机 8.3 状态；Windows/amd64 交叉编译通过。

修复后真实 `TestQemuProviderIntegration`：

| 存储路径 | 轮次 | 墙钟 / Go test | 结果 |
| --- | --- | --- | --- |
| `%LOCALAPPDATA%\AgentInBox\路径 测试\vms` | 5 | 24.21/22.80、22.82/22.78、31.87/30.75、28.34/28.29、31.94/30.73 s | 5/5 pass，exit 0，无残留 QEMU |
| `D:\路径 测试\vms` | 3 | 21.20/21.16、29.30/29.26、29.23/29.19 s | 3/3 pass，exit 0，无残留 QEMU |
| C: Unicode 存储 + Unicode base image/seed | 1 | 29.22/29.19 s | pass，exit 0，无残留 QEMU |
| 默认 `vms-go` 回归 | 1 | 29.18/29.14 s | pass |

- 每轮均走完创建、启动、登录、Provider 重启按 PID 对账、幂等 Start/Stop、ACPI 优雅停止、快照创建/恢复和 DeleteVm。
- 额外端到端用例：base image（硬链接）与 seed 放在 `...\路径 测试\images`，overlay 存储放在 `...\路径 测试\vms`；测试 29.19 s 通过，证明 base image 与 seed 的路径转换也真实可用，而不只是 unit test。
- `DeleteVm` 后 runtime junction 目录为空，最终 qemu 计数 0。
- 异常观察：一次使用长时 WMI 轮询捕获命令行的附加轮，在 Guest 已 `reboot: Power down` 后触发 `TerminateProcess: Access is denied`（PID 44984，疑似 PID 复用/存活判断竞态）；同配置的 8 次正常运行（C 5 + D 3）以及 1 次 Unicode base/seed 用例均通过。该现象与路径修复无关，建议后续单独加固 `processAlive`/`killProcess`。最终 2 轮（C/D）使用加锁清理后的最终二进制，仍通过。

修复后结论：**含 Unicode+空格的自定义存储路径在 C: 和 D: 均已通过**。仍有限制：

- 非 ASCII 文件名（basename，例如 `中文.img`）没有可用 ASCII 映射，会返回明确错误；当前 Provider 受控文件名均为 ASCII。
- 若 base image 本身位于非 ASCII 目录，qcow2 的 backing filename 会记录 runtime junction 路径，因此 `%LOCALAPPDATA%\AgentInBox\vm-runtime` 需保持存在；本次已用 Unicode base image/seed 目录实测通过，但该持久性约束仍需在产品清理策略中考虑。
- D: 仍是同一物理 NVMe 上的非系统分区，第二块物理盘未验证。
- 未启用任何 Windows 功能、未提权；未测试 UTF-8 beta locale 方案（本次不需要）。

结果文件：修复前 `tests/phase0/results/2026-11-10-h1-whpx-custom-storage.json`（failed，保留作证据）；修复后 `tests/phase0/results/2026-11-10-h1-whpx-custom-storage-shortpath-fix.json`（success）。可提交的小体积证据在 `tests/phase0/results/evidence/`。

## 4. 桌面 10 分钟长稳

命令：`phase0-stability-desktop.ps1 -CpuModel qemu64 -HoldMinutes 10 -SampleSeconds 30`。QEMU 参数与 `phase0-desktop-start.ps1` 一致（q35、WHPX、2 vCPU、4096 MB、virtio-gpu/tablet、hostfwd 10023/17611、QMP 14445）。

| 项 | 实测 |
| --- | --- |
| QEMU 启动 → SSH 就绪 | 19.32 s |
| QEMU 启动 → XFCE 就绪 | 22.31 s |
| XFCE 后保持窗口 | 600.0 s（QEMU 总运行 637.67 s，含启动、截图与关机） |
| 采样 | 每 30 s 一次，共 20 次；t=0.3–570.2 s |
| SSH 成功 | 20/20，`sshFailures=0` |
| `xfce4-session` 计数 | 每次采样均为 1 |
| Guest Agent 进程计数 | 每次采样均为 1 |
| Guest uptime | 31 s → 601 s，按 30 s/采样线性增长 |
| QEMU 进程存活 | 整个窗口均存活，无重启/退出 |
| QEMU WorkingSet64 | min 1172.5 / max 1192.4 / avg 1189.3 / last 1191.1 MB，无增长趋势 |
| 宿主可用内存（运行前） | 5485.5 MB free |
| 控制台 panic 扫描 | 无 `Kernel panic` / `BUG: unable to handle` / `Oops` / `general protection fault` / `segfault` |
| QEMU stderr | 仅非致命 `host doesn't support requested feature ... .svm` |
| 启动后截图 | QMP 20.4 ms / 3,072,016 B P6 1280×800；Guest Agent 251.7 ms / 511,505 B PNG 1280×800 |
| 结束截图 | QMP 12.1 ms / 3,072,016 B P6 1280×800 |
| 关机 | QMP ACPI 2.1 s，QEMU 进程退出；串口末尾 `reboot: Power down`（Guest uptime 633.9 s） |

结论：**10 分钟桌面空闲长稳通过**。未再次出现内核 panic、卡死、SSH 断连、Guest Agent 退出或明显性能异常；WorkingSet 稳定在约 1.17–1.19 GB。历史 `max` SMP 卡住与 Guest 内核 panic 未复现，但仍是未闭环的风险。长稳期间没有运行 Pi/模型/broker 任务。

结果文件：`tests/phase0/results/2026-11-10-h1-whpx-desktop-soak-10m.json`；原始 summary 与截图在 `%LOCALAPPDATA%\AgentInBox\stability-logs\desktop-longrun-qemu64.json` 和 `desktop-qemu64-20261110-203536\`。

## 5. 性能实测

| 指标 | 实测 |
| --- | --- |
| 桌面 VM 冷启动到 SSH 就绪 | 13.25–23.57 s（qemu64 多次探针）；现有 start 脚本 17.28 s；长稳 19.32 s |
| 桌面 VM 冷启动到 XFCE | 13.43–24.09 s（stability harness 多次）；现有 start 脚本 17.3 s；长稳 22.31 s |
| QMP `screendump` 耗时 | 12.1–20.4 ms/次（进程内 QMP）；外部 `qmp.ps1` 一次为 62.2 ms（含 PowerShell 进程启动） |
| QMP screendump 产物 | 3,072,016 B，P6，1280×800（约 3.07 MB PPM） |
| Guest Agent 截图耗时 | 161.1 ms 与 251.7 ms（两次） |
| Guest Agent 截图产物 | PNG 1280×800，511,464 B 与 511,505 B |
| QEMU 进程 WorkingSet | 长稳期间 1172.5–1192.4 MB，均值 1189.3 MB |
| 宿主可用内存 | 各次运行前约 5.0–6.5 GB free（随其他进程波动） |
| ACPI 优雅关机 | 1.0–5.1 s（正常关机的桌面 VM；直接 start 脚本那次 5.1 s） |

说明：以上是功能验证用的近似数字，不是 benchmark；宿主有其他进程活动，且部分启动发生在前一轮刚关机后的 qcow2 恢复状态。QMP 截图时间包含 PowerShell 建立 TCP、收发 JSON 与 QEMU 落盘；Guest Agent 截图时间包含 HTTP 转发与 Guest 内 X11 截图/PNG 编码。

## 6. Hyper-V 备选路径（本机限制）

非提权、只读检查结果：

| 检查 | 结果 |
| --- | --- |
| Windows 版本 | 11 家庭版 中文版，`CoreCountrySpecific`，build 26200 / 25H2 |
| `HypervisorPresent` | True（WHPX/VBS） |
| Hyper-V 管理服务 `vmms` | 不存在；`C:\Windows\System32\vmms.exe` 不存在 |
| Hyper-V WMI | `root\virtualization\v2` 命名空间不存在 |
| Hyper-V 可选功能 | `Win32_OptionalFeature` 中无 `Microsoft-Hyper-V*`；`Get-WindowsOptionalFeature` 非提权时报“需要提升” |
| 相关服务 | `HvHost`、`vmcompute` 在运行（用于 VBS/内核隔离，不是 Hyper-V 管理栈） |
| `systeminfo` | “已检测到虚拟机监控程序。将不显示 Hyper-V 所需的功能。” |
| CPU CIM 虚拟化标志 | `VirtualizationFirmwareEnabled=False` 等（在已运行的 WHPX 下不代表不可用） |

结论：**本机是 Windows 11 家庭版，不能作为 Hyper-V Provider 的验证环境**。缺少 `vmms`、Hyper-V WMI 和 Hyper-V 可选功能；在不启用功能、不提权、不改系统的约束下无法继续。需要 Windows 11 Pro/Enterprise 且安装 Hyper-V 角色的机器复测。该结论记为 `environment_error`，不是 Hyper-V Provider 功能失败。

结果文件：`tests/phase0/results/2026-11-10-h1-whpx-hyperv-availability.json`。

## 7. 清理状态与仍需其他环境验证

清理：

- 测试结束后所有由本任务启动的 QEMU 均已停止：最终 `qemu-system-x86_64` 计数 0、`ssh` 计数 0。
- `phase0-desktop` VM 保留（`disk.qcow2` 3,140,878,336 B，`seed.iso` 存在）；基础镜像 `noble-server-cloudimg-amd64.img` 保留（621,284,352 B）；`vms` 下仍有 `phase0-desktop`、`phase0-linux`，`vms-go` 为空。
- 修复前/后自定义路径测试目录（`C:\Users\admin\AppData\Local\AgentInBox\路径 测试`、`D:\路径 测试`、`...\space path test`、`...\stability-logs\space test dir`）在证据复制后已删除；`vm-runtime\dirs` 中无残留 junction；原始稳定性日志、summary、PPM/PNG 截图仍保留在 `%LOCALAPPDATA%\AgentInBox\stability-logs\`。
- 未启动 Pi/模型任务，未改动 broker，未提交 Git。

仍需其他环境/更长时间验证的事项：

1. **Hyper-V Provider**：Windows 11 Pro/Enterprise + Hyper-V 角色 + `vmms` 的真实机器。
2. **Unicode 自定义存储**：C:/D: 已通过（短路径 + ASCII junction）；Unicode 目录中的 base image 与 seed 也已实测通过。非 ASCII 文件名（basename）仍会明确报错，若产品要求中文文件名，需要文件级 ASCII 映射/硬链接；runtime junction 目录需保持存在。
3. **第二块物理盘**：本机 D: 与 C: 在同一块 NVMe 上，独立物理盘的性能/路径未验证。
4. **更长 soak**：10 分钟只是下限；建议 ≥1 小时桌面空闲、重复开关机、重复桌面装机后启动，尤其针对历史 `-cpu max` SMP 卡住与 Guest 内核 panic。
5. **CPU 模型长稳**：`host`、`max` 只做了单次启动探针，未做长稳；当前仅 `qemu64` 有 10 分钟长稳。
6. **StopVm PID 存活判断竞态**：一次高开销 WMI 捕获轮在 Guest 已 power down 后触发 `TerminateProcess: Access is denied`（PID 复用/存活判断），同配置 6 次正常轮通过；建议单独加固 `processAlive`/`killProcess`。
7. **其他**：Wayland、多 VM 并发、宿主睡眠/唤醒、不同 Windows 版本与 AMD CPU、Windows 家庭版其他 build。
