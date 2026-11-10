#!/usr/bin/env bash
# One-time QEMU toolchain bootstrap for Agent-in-Box phase-0 validation.
# Uses Chinese MSYS2 mirrors only; no system-wide installation or admin rights.
set -euo pipefail
export LANG=C.UTF-8

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

/ucrt64/bin/qemu-system-x86_64.exe --version
/ucrt64/bin/qemu-system-x86_64.exe -accel help
