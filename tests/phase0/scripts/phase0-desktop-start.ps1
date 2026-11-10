param([string]$CpuModel = 'max')
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'AgentInBox'
$qemu = Join-Path $root 'tools\msys64\ucrt64\bin\qemu-system-x86_64.exe'
$qmpScript = Join-Path $root 'tools\qmp.ps1'
$vmDir = Join-Path $root 'vms\phase0-desktop'

$existing = Get-Process qemu-system-x86_64 -ErrorAction SilentlyContinue
if ($existing) {
  & $qmpScript -Port 14445 -Command '{"execute":"quit"}' | Out-Host
  $existing.WaitForExit(10000)
}

$console = Join-Path $vmDir 'console.log'
if (Test-Path $console) { Move-Item -Force $console "$console.previous" }
$arguments = @(
  '-name', 'agent-in-box-phase0-desktop',
  '-machine', 'q35',
  '-accel', 'whpx,kernel-irqchip=off',
  '-cpu', $CpuModel,
  '-smp', '2',
  '-m', '4096',
  '-vga', 'none',
  '-device', 'virtio-gpu-pci',
  '-device', 'virtio-tablet-pci',
  '-drive', "file=$vmDir\disk.qcow2,if=virtio,format=qcow2",
  '-drive', "file=$vmDir\seed.iso,if=virtio,media=cdrom,format=raw,readonly=on",
  '-netdev', 'user,id=n0,hostfwd=tcp:127.0.0.1:10023-:22,hostfwd=tcp:127.0.0.1:17611-:7611',
  '-device', 'virtio-net-pci,netdev=n0',
  '-display', 'none',
  '-vnc', '127.0.0.1:1',
  '-serial', "file:$console",
  '-qmp', 'tcp:127.0.0.1:14445,server,nowait',
  '-pidfile', (Join-Path $vmDir 'qemu.pid')
)
$p = Start-Process -FilePath $qemu -ArgumentList $arguments -PassThru -RedirectStandardOutput (Join-Path $vmDir 'qemu-stdout.log') -RedirectStandardError (Join-Path $vmDir 'qemu-stderr.log') -WindowStyle Hidden
Write-Output "started qemu pid=$($p.Id) cpu=$CpuModel"
