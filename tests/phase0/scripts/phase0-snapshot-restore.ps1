# Snapshot restore verification: marker written after snapshot must disappear after restore.
param([string]$SnapshotTag = 'phase0-snap1')
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'AgentInBox'
$qemuDir = Join-Path $root 'tools\msys64\ucrt64\bin'
$qemu = Join-Path $qemuDir 'qemu-system-x86_64.exe'
$qemuImg = Join-Path $qemuDir 'qemu-img.exe'
$qmpScript = Join-Path $root 'tools\qmp.ps1'
$vmDir = Join-Path $root 'vms\phase0-linux'
$disk = Join-Path $vmDir 'disk.qcow2'
$seed = Join-Path $vmDir 'seed.iso'
$key = Join-Path $vmDir 'id_ed25519'
$resultPath = Join-Path $vmDir 'snapshot-restore-result.json'

$result = [ordered]@{
  name = 'qcow2-snapshot-restore'
  snapshotTag = $SnapshotTag
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  markerCreatedAfterSnapshot = $false
  markerAbsentAfterRestore = $false
  bootMarkerStillPresent = $false
  status = 'failed'
  error = $null
}

function Start-Guest {
  $console = Join-Path $vmDir "console-restore-$((Get-Date).ToString('HHmmss')).log"
  $arguments = @(
    '-name', 'agent-in-box-phase0',
    '-machine', 'q35',
    '-accel', 'whpx,kernel-irqchip=off',
    '-cpu', 'max',
    '-smp', '2',
    '-m', '2048',
    '-drive', "file=$disk,if=virtio,format=qcow2",
    '-drive', "file=$seed,if=virtio,media=cdrom,format=raw,readonly=on",
    '-netdev', 'user,id=n0,hostfwd=tcp:127.0.0.1:10022-:22',
    '-device', 'virtio-net-pci,netdev=n0',
    '-display', 'none',
    '-serial', "file:$console",
    '-qmp', 'tcp:127.0.0.1:14444,server,nowait'
  )
  return (Start-Process -FilePath $qemu -ArgumentList $arguments -PassThru -WindowStyle Hidden)
}

function Invoke-GuestSsh([string]$RemoteCommand) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & ssh.exe -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ConnectTimeout=5 -o BatchMode=yes -p 10022 -i $key aib@127.0.0.1 $RemoteCommand 2>$null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  return @{ Code = $code; Output = ($output -join "`n") }
}

function Wait-GuestSsh([int]$TimeoutSec = 180) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $r = Invoke-GuestSsh 'true'
    if ($r.Code -eq 0) { return $true }
    Start-Sleep -Seconds 4
  }
  return $false
}

function Stop-Guest($Process) {
  & $qmpScript -Command '{"execute":"system_powerdown"}' | Out-Host
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) { return }
    Start-Sleep -Seconds 3
  }
  & $qmpScript -Command '{"execute":"quit"}' | Out-Host
  $Process.WaitForExit(15000)
}

try {
  Write-Host 'Boot 1: create post-snapshot marker'
  $p = Start-Guest
  if (-not (Wait-GuestSsh)) { throw 'SSH not ready for marker creation' }
  $r = Invoke-GuestSsh 'echo after-snapshot | sudo tee /var/lib/aib-after-snap'
  if ($r.Code -ne 0) { throw "Failed to create marker: $($r.Output)" }
  $result.markerCreatedAfterSnapshot = $true
  Stop-Guest $p

  Write-Host "Restore snapshot $SnapshotTag"
  & $qemuImg snapshot -a $SnapshotTag $disk | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "snapshot restore failed: $LASTEXITCODE" }

  Write-Host 'Boot 2: verify restored state'
  $p = Start-Guest
  if (-not (Wait-GuestSsh)) { throw 'SSH not ready after restore' }
  $r = Invoke-GuestSsh 'test ! -e /var/lib/aib-after-snap && echo marker-absent'
  $result.markerAbsentAfterRestore = ($r.Code -eq 0 -and $r.Output -match 'marker-absent')
  $r = Invoke-GuestSsh 'cat /var/lib/agent-in-box-boot-ok'
  $result.bootMarkerStillPresent = ($r.Code -eq 0 -and $r.Output -match 'boot-ok')
  Stop-Guest $p

  if ($result.markerAbsentAfterRestore -and $result.bootMarkerStillPresent) { $result.status = 'passed' }
} catch {
  $result.error = $_.Exception.Message
  Write-Error $_
} finally {
  $result.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  $result | ConvertTo-Json -Depth 4 | Set-Content -Path $resultPath -Encoding UTF8
  Write-Host "Result written to $resultPath"
}
