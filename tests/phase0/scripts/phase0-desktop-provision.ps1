# Provision an XFCE desktop Linux guest on Windows QEMU/WHPX and capture its display.
param([switch]$Resume)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'AgentInBox'
$qemuDir = Join-Path $root 'tools\msys64\ucrt64\bin'
$qemu = Join-Path $qemuDir 'qemu-system-x86_64.exe'
$qemuImg = Join-Path $qemuDir 'qemu-img.exe'
$qmpScript = Join-Path $root 'tools\qmp.ps1'
$vmDir = Join-Path $root 'vms\phase0-desktop'
$baseImage = Join-Path $root 'images\noble-server-cloudimg-amd64.img'
$disk = Join-Path $vmDir 'disk.qcow2'
$seed = Join-Path $vmDir 'seed.iso'
$key = Join-Path $vmDir 'id_ed25519'
$console = Join-Path $vmDir 'console.log'
$stderrLog = Join-Path $vmDir 'qemu-stderr.log'
$resultPath = Join-Path $vmDir 'provision-result.json'
$screenshot = Join-Path $vmDir 'desktop.png'

$result = [ordered]@{
  name = 'windows-host-whpx-xfce-desktop'
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  sshReady = $false
  cloudInitReady = $false
  graphicalSession = $false
  sessionInfo = $null
  screenshotCaptured = $false
  screenshotPath = $screenshot
  status = 'failed'
  error = $null
}

function Invoke-GuestSsh([string]$RemoteCommand) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & ssh.exe -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ConnectTimeout=8 -o BatchMode=yes -p 10023 -i $key aib@127.0.0.1 $RemoteCommand 2>$null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  return @{ Code = $code; Output = ($output -join "`n") }
}

function Wait-GuestSsh([int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $r = Invoke-GuestSsh 'true'
    if ($r.Code -eq 0) { return $true }
    Start-Sleep -Seconds 5
  }
  return $false
}

try {
  if ($Resume) {
    $process = Get-Process -Id (Get-Content (Join-Path $vmDir 'qemu.pid')) -ErrorAction Stop
    Write-Host "Resuming with running QEMU process $($process.Id)"
  } else {
  if (-not (Test-Path $disk)) {
    Write-Host 'Creating desktop overlay disk'
    & $qemuImg create -f qcow2 -F qcow2 -b $baseImage $disk 40G | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "qemu-img create failed: $LASTEXITCODE" }
  }

  foreach ($log in @($console, $stderrLog)) {
    if (Test-Path $log) { Move-Item -Force $log "$log.previous" }
  }

  $arguments = @(
    '-name', 'agent-in-box-phase0-desktop',
    '-machine', 'q35',
    '-accel', 'whpx,kernel-irqchip=off',
    '-cpu', 'qemu64',
    '-smp', '2',
    '-m', '4096',
    '-vga', 'none',
    '-device', 'virtio-gpu-pci',
    '-device', 'virtio-tablet-pci',
    '-drive', "file=$disk,if=virtio,format=qcow2",
    '-drive', "file=$seed,if=virtio,media=cdrom,format=raw,readonly=on",
    '-netdev', 'user,id=n0,hostfwd=tcp:127.0.0.1:10023-:22',
    '-device', 'virtio-net-pci,netdev=n0',
    '-display', 'none',
    '-vnc', '127.0.0.1:1',
    '-serial', "file:$console",
    '-qmp', 'tcp:127.0.0.1:14445,server,nowait',
    '-pidfile', (Join-Path $vmDir 'qemu.pid')
  )
  $process = Start-Process -FilePath $qemu -ArgumentList $arguments -PassThru -RedirectStandardOutput (Join-Path $vmDir 'qemu-stdout.log') -RedirectStandardError $stderrLog -WindowStyle Hidden
  Write-Host "QEMU started: $($process.Id)"
  }

  if (-not (Wait-GuestSsh 600)) { throw 'SSH did not become ready within 10 minutes' }
  $result.sshReady = $true
  Write-Host 'SSH ready; waiting for desktop package installation'

  # Poll the runcmd marker instead of failing on recoverable cloud-init module errors.
  $deadline = (Get-Date).AddSeconds(1800)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    $r = Invoke-GuestSsh 'cat /var/lib/agent-in-box-desktop-ready 2>/dev/null'
    if ($r.Code -eq 0 -and $r.Output -match 'desktop-packages-ready') { $ready = $true; break }
    Start-Sleep -Seconds 20
  }
  if (-not $ready) { throw 'Desktop package installation marker not found before timeout' }
  $result.cloudInitReady = $true
  Write-Host "Desktop packages installed: $($r.Output)"

  Write-Host 'Rebooting into graphical target'
  $null = Invoke-GuestSsh 'sudo systemctl reboot'
  Start-Sleep -Seconds 15
  if (-not (Wait-GuestSsh 600)) { throw 'SSH did not return after reboot' }

  $deadline = (Get-Date).AddSeconds(300)
  while ((Get-Date) -lt $deadline) {
    $r = Invoke-GuestSsh 'pgrep -a Xorg; pgrep -a xfce4-session; loginctl list-sessions --no-legend'
    if ($r.Output -match 'Xorg' -and $r.Output -match 'xfce4-session') {
      $result.graphicalSession = $true
      $result.sessionInfo = $r.Output
      break
    }
    Start-Sleep -Seconds 5
  }
  if (-not $result.graphicalSession) { throw 'XFCE graphical session did not start' }
  Write-Host "Graphical session detected: $($result.sessionInfo)"

  Start-Sleep -Seconds 20
  $screendump = @{ execute = 'screendump'; arguments = @{ filename = $screenshot } } | ConvertTo-Json -Compress
  & $qmpScript -Port 14445 -Command $screendump | Out-Host
  if (-not (Test-Path $screenshot)) { throw 'QMP screendump did not create a file' }
  $result.screenshotCaptured = $true
  $result.status = 'passed'
  Write-Host "Screenshot captured: $screenshot"
  Write-Host 'Desktop VM left running for follow-up input validation'
} catch {
  $result.error = $_.Exception.Message
  Write-Error $_
} finally {
  $result.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  $result | ConvertTo-Json -Depth 4 | Set-Content -Path $resultPath -Encoding UTF8
  Write-Host "Result written to $resultPath"
}
