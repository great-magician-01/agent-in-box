# Windows Host + QEMU/WHPX 验证 Runbook

> 对应开发计划阶段 0.2。目标是证明 Windows 宿主机（包括家庭版）可以用 QEMU/WHPX 运行 Linux Guest，全程普通用户权限，不安装系统服务。

## 1. 目录

所有文件位于用户目录，可整体删除：

```text
%LOCALAPPDATA%\AgentInBox\
  tools\msys64\            MSYS2 + QEMU
  downloads\               安装包、SHA256SUMS
  images\                  校验通过的 Guest 基础镜像
  vms\phase0-linux\        覆盖盘、cloud-init seed、控制台与验证结果
```

## 2. 安装 QEMU（TUNA 镜像）

```powershell
$root = "$env:LOCALAPPDATA\AgentInBox"
New-Item -ItemType Directory -Force "$root\tools", "$root\downloads", "$root\images", "$root\vms" | Out-Null

# 约 43 MB；不要用 qemu.weilnetz.de 的 207 MB 安装包（当前网络约 65 KB/s）
curl.exe -fL -o "$root\downloads\msys2-base-x86_64-20260927.sfx.exe" `
  https://mirrors.tuna.tsinghua.edu.cn/msys2/distrib/x86_64/msys2-base-x86_64-20260927.sfx.exe

& "$root\downloads\msys2-base-x86_64-20260927.sfx.exe" -y -o"$root\tools"
```

pacman 只保留国内镜像并关闭并行下载（并行连接容易触发限速后回退到慢速境外源）：

```bash
cat >/etc/pacman.d/mirrorlist.mingw <<'EOF'
Server = https://mirrors.tuna.tsinghua.edu.cn/msys2/mingw/$repo/
Server = https://mirrors.ustc.edu.cn/msys2/mingw/$repo/
Server = https://mirrors.aliyun.com/msys2/mingw/$repo/
EOF
cat >/etc/pacman.d/mirrorlist.msys <<'EOF'
Server = https://mirrors.tuna.tsinghua.edu.cn/msys2/msys/$arch/
Server = https://mirrors.ustc.edu.cn/msys2/msys/$arch/
Server = https://mirrors.aliyun.com/msys2/msys/$arch/
EOF
sed -i 's/^ParallelDownloads = .*/ParallelDownloads = 1/' /etc/pacman.conf
pacman -Syy --noconfirm
pacman -S --noconfirm --needed mingw-w64-ucrt-x86_64-qemu
```

在 MSYS2 bash 中执行：

```bash
/ucrt64/bin/qemu-system-x86_64.exe --version
/ucrt64/bin/qemu-system-x86_64.exe -accel help   # 必须包含 whpx
```

## 3. 下载并校验 Linux 镜像

```powershell
curl.exe -fL -C - -o "$root\downloads\noble-server-cloudimg-amd64.img" `
  https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/noble/current/noble-server-cloudimg-amd64.img
curl.exe -fsSL -o "$root\downloads\SHA256SUMS" `
  https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/noble/current/SHA256SUMS
```

SHA256 必须与 `SHA256SUMS` 一致后才移动到 `images\`。2026-11-10 实际下载文件：

```text
04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94  noble-server-cloudimg-amd64.img
```

## 4. 启动参数基线

```text
-machine q35
-accel whpx,kernel-irqchip=off
-cpu max
-smp 2 -m 2048
-drive file=<overlay.qcow2>,if=virtio,format=qcow2
-drive file=<seed.iso>,if=virtio,media=cdrom,format=raw,readonly=on
-netdev user,id=n0,hostfwd=tcp:127.0.0.1:10022-:22
-device virtio-net-pci,netdev=n0
-display none -vnc 127.0.0.1:0
-serial file:<console.log>
-qmp tcp:127.0.0.1:14444,server,nowait
-pidfile <qemu.pid>
```

约束：

- VNC、QMP、SSH 转发只绑定 `127.0.0.1`，不得暴露到局域网。
- 使用独立覆盖盘，不直接修改基础镜像。
- 优雅停止通过 QMP `system_powerdown`；`quit` 仅用于超时后的强制退出。
- `failed to get xsave state` 在当前 WHPX 构建上是启动期告警，需记录但不等于 Guest 启动失败；以控制台和 SSH 结果为准。

## 5. 验证结果

实际结果写入 `tests/phase0/results/`。本 runbook 只描述方法，不代替结果记录。

## 6. 仓库脚本

上述步骤已固化为可重复脚本，默认读写 `%LOCALAPPDATA%\AgentInBox`：

```text
scripts/setup-qemu.sh                 在 MSYS2 bash 中配置镜像并安装 QEMU
scripts/phase0-validate.ps1           创建覆盖盘、WHPX 启动、SSH 验证、优雅关机、快照
scripts/phase0-snapshot-restore.ps1   验证快照恢复后的文件状态
scripts/qmp.ps1                       向 127.0.0.1 QMP 发送固定 JSON 命令
```

在 Windows PowerShell 中运行：

```powershell
powershell -NoProfile -File tests\phase0\scripts\phase0-validate.ps1
powershell -NoProfile -File tests\phase0\scripts\phase0-snapshot-restore.ps1 -SnapshotTag phase0-snap1
```

脚本不使用 `-ExecutionPolicy Bypass`，不请求管理员权限。若本机策略禁止本地脚本，应先调整终端策略或由用户手动执行，而不是在自动化中绕过。
