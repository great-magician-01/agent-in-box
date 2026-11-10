# Agent-in-Box phase-0 validation: Windows host + WHPX + Linux guest.
# Runs entirely under the current user; no admin rights, no system services.
param(
  [int]$BootTimeoutSec = 180,
  [int]$SshTimeoutSec = 240,
  [switch]$SkipSsh
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'AgentInBox'
$qemuDir = Join-Path $root 'tools\msys64\ucrt64\bin'
$qemu = Join-Path $qemuDir 'qemu-system-x86_64.exe'
$qemuImg = Join-Path $qemuDir 'qemu-img.exe'
$vmDir = Join-Path $root 'vms\phase0-linux'
$baseImage = Join-Path $root 'images\noble-server-cloudimg-amd64.img'
$disk = Join-Path $vmDir 'disk.qcow2'
$seed = Join-Path $vmDir 'seed.iso'
$console = Join-Path $vmDir 'console.log'
$stderrLog = Join-Path $vmDir 'qemu-stderr.log'
$pidFile = Join-Path $vmDir 'qemu.pid'
$key = Join-Path $vmDir 'id_ed25519'
$resultPath = Join-Path $vmDir 'validation-result.json'

$script:result = [ordered]@{
  name = 'windows-host-whpx-linux-guest'
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  hostOs = (Get-CimInstance Win32_OperatingSystem).Caption
  qemuVersion = $null
  accelerators = $null
  overlayCreated = $false
  bootReachedLogin = $false
  bootSeconds = $null
  sshVerified = $false
  sshOutput = $null
  gracefulShutdown = $false
  snapshotCreated = $false
  snapshotList = $null
  status = 'failed'
  error = $null
}

function Write-Step([string]$Message) {
  Write-Host ("[{0}] {1}" -f (Get-Date).ToString('HH:mm:ss'), $Message)
}

function Invoke-Qmp {
  param([int]$Port, [string[]]$Commands)
  $client = New-Object System.Net.Sockets.TcpClient
  $client.Connect('127.0.0.1', $Port)
  try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 8000
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)
    $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::ASCII)
    $writer.NewLine = "`n"
    $writer.AutoFlush = $true
    $null = $reader.ReadLine()
    $writer.WriteLine('{"execute":"qmp_capabilities"}')
    $null = Read-QmpResponse $reader
    $responses = @()
    foreach ($command in $Commands) {
      $writer.WriteLine($command)
      $responses += (Read-QmpResponse $reader)
    }
    return $responses
  } finally {
    $client.Close()
  }
}

function Read-QmpResponse($Reader) {
  while ($true) {
    $line = $Reader.ReadLine()
    if ($null -eq $line) { throw 'QMP connection closed' }
    if ($line -match '"return"' -or $line -match '"error"') { return $line }
  }
}

try {
  Write-Step 'Checking QEMU and accelerator support'
  $script:result.qemuVersion = (& $qemu --version | Select-Object -First 1).Trim()
  $accels = (& $qemu -accel help) -join ' '
  $script:result.accelerators = $accels.Trim()
  if ($accels -notmatch 'whpx') { throw 'QEMU build does not list whpx accelerator' }

  if (-not (Test-Path $disk)) {
    Write-Step 'Creating qcow2 overlay disk'
    & $qemuImg create -f qcow2 -F qcow2 -b $baseImage $disk 20G | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "qemu-img create failed: $LASTEXITCODE" }
  }
  $script:result.overlayCreated = Test-Path $disk
  & $qemuImg info $disk | Out-Host

  Write-Step 'Starting Linux guest with WHPX'
  # Rotate logs so a previous boot's "login:" line cannot fake a zero-second boot.
  foreach ($log in @($console, $stderrLog)) {
    if (Test-Path $log) { Move-Item -Force $log "$log.previous" }
  }
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
    '-vnc', '127.0.0.1:0',
    '-serial', "file:$console",
    '-qmp', 'tcp:127.0.0.1:14444,server,nowait',
    '-pidfile', $pidFile
  )
  $process = Start-Process -FilePath $qemu -ArgumentList $arguments -PassThru -RedirectStandardError $stderrLog -WindowStyle Hidden
  $bootStart = Get-Date

  $deadline = $bootStart.AddSeconds($BootTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) {
      $err = if (Test-Path $stderrLog) { Get-Content $stderrLog -Raw } else { '' }
      throw "QEMU exited before boot completed (code $($process.ExitCode)): $err"
    }
    if ((Test-Path $console) -and ((Get-Content $console -Raw -ErrorAction SilentlyContinue) -match 'login:')) {
      $script:result.bootReachedLogin = $true
      $script:result.bootSeconds = [math]::Round(((Get-Date) - $bootStart).TotalSeconds, 1)
      break
    }
    Start-Sleep -Seconds 2
    $process.Refresh()
  }
  if (-not $script:result.bootReachedLogin) { throw "Guest did not reach login prompt within $BootTimeoutSec seconds" }
  Write-Step "Guest reached login prompt in $($script:result.bootSeconds)s"

  if (-not $SkipSsh) {
    Write-Step 'Waiting for cloud-init and SSH verification'
    $sshDeadline = (Get-Date).AddSeconds($SshTimeoutSec)
    while ((Get-Date) -lt $sshDeadline) {
      # ssh.exe writes its host-key notice to stderr. Under ErrorActionPreference=Stop
      # PowerShell would turn that notice into a terminating NativeCommandError.
      $previousPreference = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      $output = & ssh.exe -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ConnectTimeout=5 -o BatchMode=yes -p 10022 -i $key aib@127.0.0.1 'cat /var/lib/agent-in-box-boot-ok && uname -a' 2>$null
      $sshExitCode = $LASTEXITCODE
      $ErrorActionPreference = $previousPreference
      if ($sshExitCode -eq 0 -and $output) {
        $script:result.sshVerified = $true
        $script:result.sshOutput = ($output -join ' | ').Trim()
        break
      }
      Start-Sleep -Seconds 5
    }
    if ($script:result.sshVerified) { Write-Step "SSH verified: $($script:result.sshOutput)" }
    else { Write-Step 'SSH verification did not succeed within timeout' }
  }

  Write-Step 'Requesting graceful ACPI shutdown through QMP'
  $qmpResponses = Invoke-Qmp -Port 14444 -Commands @('{"execute":"query-status"}', '{"execute":"system_powerdown"}')
  Write-Host ($qmpResponses -join "`n")

  $shutdownDeadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $shutdownDeadline) {
    $process.Refresh()
    if ($process.HasExited) { break }
    Start-Sleep -Seconds 3
  }
  $process.Refresh()
  if ($process.HasExited) {
    $script:result.gracefulShutdown = $true
    Write-Step "Guest shut down gracefully (exit $($process.ExitCode))"
  } else {
    Write-Step 'Graceful shutdown timed out; forcing QEMU exit through QMP quit'
    Invoke-Qmp -Port 14444 -Commands @('{"execute":"quit"}') | Out-Host
    $process.WaitForExit(15000)
  }

  Write-Step 'Creating and listing qcow2 internal snapshot'
  $snapshotTag = 'phase0-snap-' + (Get-Date).ToString('yyyyMMddHHmmss')
  & $qemuImg snapshot -c $snapshotTag $disk | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "qemu-img snapshot failed: $LASTEXITCODE" }
  $script:result.snapshotCreated = $true
  $script:result.snapshotTag = $snapshotTag
  $script:result.snapshotList = ((& $qemuImg snapshot -l $disk) -join ' | ').Trim()

  $script:result.status = if ($script:result.sshVerified -or $SkipSsh) { 'passed' } else { 'partial' }
} catch {
  $script:result.error = $_.Exception.Message
  Write-Error $_
} finally {
  $script:result.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  $script:result | ConvertTo-Json -Depth 5 | Set-Content -Path $resultPath -Encoding UTF8
  Write-Step "Result written to $resultPath"
}
