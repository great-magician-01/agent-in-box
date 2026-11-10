# Start the phase0 desktop VM under QEMU/WHPX, measure cold boot to XFCE, hold it
# for a stability window, sample guest uptime and xfce4-session over SSH, take a
# QMP screendump and a Guest Agent screenshot, then shut down gracefully.
# HoldMinutes=0 runs a boot/screenshot/shutdown probe only.
param(
  [string]$CpuModel = 'qemu64',
  [int]$HoldMinutes = 10,
  [int]$SampleSeconds = 30,
  [int]$BootTimeoutSec = 240,
  [int]$SettleSeconds = 10,
  [int]$ShutdownTimeoutSec = 90,
  [string]$ResultJson = ''
)
$ErrorActionPreference = 'Stop'

$root = Join-Path $env:LOCALAPPDATA 'AgentInBox'
$qemuDir = Join-Path $root 'tools\msys64\ucrt64\bin'
$qemu = Join-Path $qemuDir 'qemu-system-x86_64.exe'
$vmDir = Join-Path $root 'vms\phase0-desktop'
$key = Join-Path $vmDir 'id_ed25519'
$console = Join-Path $vmDir 'console.log'
$stderrLog = Join-Path $vmDir 'qemu-stderr.log'
$stdoutLog = Join-Path $vmDir 'qemu-stdout.log'
$pidFile = Join-Path $vmDir 'qemu.pid'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$safeCpu = $CpuModel -replace '[^A-Za-z0-9_.-]', '_'
$logDir = Join-Path $root "stability-logs\desktop-$safeCpu-$stamp"
New-Item -ItemType Directory -Force $logDir | Out-Null
if ($ResultJson -eq '') { $ResultJson = Join-Path $logDir 'summary.json' }

foreach ($required in @($qemu, (Join-Path $vmDir 'disk.qcow2'), (Join-Path $vmDir 'seed.iso'), $key)) {
  if (-not (Test-Path $required)) { throw "required file not found: $required" }
}

$transcript = Join-Path $logDir 'harness.log'
function Write-Log([string]$Message) {
  $line = ("[{0}] {1}" -f (Get-Date).ToString('HH:mm:ss'), $Message)
  Write-Host $line
  Add-Content -Path $transcript -Value $line -Encoding UTF8
}

function Read-QmpResponse($Reader) {
  while ($true) {
    $line = $Reader.ReadLine()
    if ($null -eq $line) { throw 'QMP connection closed' }
    if ($line -match '"return"' -or $line -match '"error"') { return $line }
  }
}

function Invoke-Qmp {
  param([int]$Port = 14445, [string[]]$Commands)
  $client = New-Object System.Net.Sockets.TcpClient
  $client.Connect('127.0.0.1', $Port)
  try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 10000
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

function Wait-Qmp([int]$Port = 14445, [int]$TimeoutSec = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-Qmp -Port $Port -Commands @('{"execute":"query-status"}')
      return $response
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  throw "QMP did not become ready within $TimeoutSec seconds"
}

function Invoke-GuestSsh {
  param([string]$Command, [int]$TimeoutSec = 8)
  # System.Diagnostics.Process gives a hard client-side timeout. OpenSSH can
  # stay alive long after the remote shell finished if a background guest
  # process inherited the ssh channel; the old native invocation then blocked
  # for minutes. Killing the client does not stop a nohup/setsid guest process.
  $connectTimeout = [Math]::Max(3, [Math]::Min($TimeoutSec, 8))
  $argLine = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL ' +
    '-o ConnectTimeout=' + $connectTimeout + ' -o BatchMode=yes ' +
    '-p 10023 -i ' + $key + ' aib@127.0.0.1 ' + $Command
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'ssh.exe'
  $psi.Arguments = $argLine
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $stdoutTask = $p.StandardOutput.ReadToEndAsync()
  $stderrTask = $p.StandardError.ReadToEndAsync()
  $completed = $p.WaitForExit($TimeoutSec * 1000)
  if (-not $completed) {
    try { $p.Kill(); $null = $p.WaitForExit(3000) } catch { }
  }
  $output = ''
  $errOutput = ''
  try {
    if ($stdoutTask.Wait(3000)) { $output = [string]$stdoutTask.Result }
    if ($stderrTask.Wait(3000)) { $errOutput = [string]$stderrTask.Result }
  } catch { }
  $code = -1
  if ($completed) { try { $code = $p.ExitCode } catch { } }
  return [pscustomobject]@{
    ExitCode = $code
    Output = $output.TrimEnd()
    Stderr = $errOutput.TrimEnd()
    TimedOut = (-not $completed)
  }
}

function Get-PpmInfo([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $len = [Math]::Min(64, $bytes.Length)
  $header = [System.Text.Encoding]::ASCII.GetString($bytes, 0, $len)
  $info = [ordered]@{ sizeBytes = $bytes.Length; width = $null; height = $null; format = 'unknown' }
  if ($header -match 'P6\s+(\d+)\s+(\d+)\s+(\d+)') {
    $info.format = 'P6'
    $info.width = [int]$Matches[1]
    $info.height = [int]$Matches[2]
  }
  return $info
}

function Get-PngInfo([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $info = [ordered]@{ sizeBytes = $bytes.Length; width = $null; height = $null; format = 'unknown' }
  if ($bytes.Length -ge 24 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) {
    $info.format = 'png'
    $info.width = [int]((([uint32]$bytes[16]) * 16777216) + (([uint32]$bytes[17]) * 65536) + (([uint32]$bytes[18]) * 256) + ([uint32]$bytes[19]))
    $info.height = [int]((([uint32]$bytes[20]) * 16777216) + (([uint32]$bytes[21]) * 65536) + (([uint32]$bytes[22]) * 256) + ([uint32]$bytes[23]))
  }
  return $info
}

function Get-ConsolePanics([string]$Path) {
  $matches = @()
  if (-not (Test-Path $Path)) { return $matches }
  $text = Get-Content $Path -Raw -ErrorAction SilentlyContinue
  if ($null -eq $text) { return $matches }
  foreach ($pattern in @('Kernel panic', 'BUG: unable to handle', 'Oops:', 'general protection fault', 'segfault at')) {
    if ($text -match [regex]::Escape($pattern)) {
      $lineMatches = [regex]::Matches([string]$text, '.{0,80}' + [regex]::Escape($pattern) + '.{0,120}')
      $excerpt = ''
      if ($lineMatches.Count -gt 0) { $excerpt = ($lineMatches[$lineMatches.Count - 1].Value -replace "`r|`n", ' ') }
      $matches += [ordered]@{ pattern = $pattern; excerpt = $excerpt }
    }
  }
  return $matches
}

function Take-QmpScreendump([string]$Tag) {
  $path = Join-Path $logDir ("qmp-screendump-{0}-{1}.ppm" -f $Tag, $stamp)
  $command = @{ execute = 'screendump'; arguments = @{ filename = $path } } | ConvertTo-Json -Compress -Depth 4
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $response = $null
  $errorText = ''
  try {
    $response = Invoke-Qmp -Port 14445 -Commands @($command)
  } catch {
    $errorText = $_.Exception.Message
  }
  $sw.Stop()
  $info = Get-PpmInfo $path
  $ok = ($null -ne $info -and $info.width -gt 0)
  return [ordered]@{
    tag = $Tag
    durationMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
    path = $path
    response = ($response -join ' ')
    ok = $ok
    error = $errorText
    image = $info
  }
}

$summary = [ordered]@{
  script = 'phase0-stability-desktop.ps1'
  runId = "2026-11-10-h1-whpx-desktop-$safeCpu-$stamp"
  hostProfile = 'H1'
  guestProfile = 'G2'
  provider = 'qemu-whpx'
  cpuModel = $CpuModel
  holdMinutes = $HoldMinutes
  sampleSeconds = $SampleSeconds
  startedAt = $null
  finishedAt = $null
  durationSeconds = $null
  boot = [ordered]@{ sshReadySeconds = $null; xfceReadySeconds = $null; consoleLoginSeen = $false }
  qemu = [ordered]@{ pid = $null; exitCode = $null; stderrWarnings = @() }
  screendumps = @()
  guestAgentScreenshot = $null
  samples = @()
  sampleCount = 0
  sshFailures = 0
  memory = [ordered]@{ workingSetMinMB = $null; workingSetMaxMB = $null; workingSetAvgMB = $null; workingSetLastMB = $null }
  hostMemory = [ordered]@{ freeMBBefore = $null; freeMBAfter = $null }
  consolePanics = @()
  shutdown = [ordered]@{ method = $null; seconds = $null; qemuExited = $false }
  evidenceDir = $null
  status = 'failed'
  error = $null
}

$bootStart = $null
$proc = $null
$holdStart = $null
$failure = $null
$shutdownInfo = $null

try {
  $summary.startedAt = (Get-Date).ToUniversalTime().ToString('o')
  $scriptStart = Get-Date
  $hostOs = Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 8
  $summary.hostMemory.freeMBBefore = [math]::Round($hostOs.FreePhysicalMemory / 1024, 1)

  $existing = @(Get-Process qemu-system-x86_64 -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 0) {
    Write-Log ("existing QEMU processes: {0}; asking desktop QMP to quit" -f (($existing | ForEach-Object { $_.Id }) -join ','))
    try { Invoke-Qmp -Port 14445 -Commands @('{"execute":"quit"}') | Out-Null } catch { Write-Log "QMP quit failed: $($_.Exception.Message)" }
    Start-Sleep -Seconds 3
    $existing = @(Get-Process qemu-system-x86_64 -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) { throw "QEMU still running before desktop test: $(($existing | ForEach-Object { $_.Id }) -join ',')" }
  }

  # Rotate logs so a previous boot cannot fake this boot's state.
  foreach ($log in @($console, $stderrLog, $stdoutLog)) {
    if (Test-Path $log) { Move-Item -Force $log "$log.previous" }
  }

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
    '-pidfile', $pidFile
  )
  Write-Log "starting QEMU cpu=$CpuModel"
  $proc = Start-Process -FilePath $qemu -ArgumentList $arguments -PassThru `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden
  $bootStart = Get-Date
  $summary.qemu.pid = $proc.Id
  Write-Log "QEMU pid=$($proc.Id)"

  $null = Wait-Qmp -Port 14445 -TimeoutSec 30

  $sshReady = $false
  $xfceReady = $false
  $deadline = $bootStart.AddSeconds($BootTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $proc.Refresh()
    if ($proc.HasExited) {
      throw "QEMU exited during boot with code $($proc.ExitCode); see $stderrLog"
    }
    if (-not $sshReady) {
      $r = Invoke-GuestSsh -Command 'echo AIB_SSH_OK; cut -d. -f1 /proc/uptime || /usr/bin/uptime' -TimeoutSec 5
      if ($r.ExitCode -eq 0 -and $r.Output -match 'AIB_SSH_OK') {
        $sshReady = $true
        $summary.boot.sshReadySeconds = [math]::Round(((Get-Date) - $bootStart).TotalSeconds, 2)
        Write-Log "SSH ready in $($summary.boot.sshReadySeconds)s"
      }
    }
    if ($sshReady) {
      $r = Invoke-GuestSsh -Command 'pgrep -x xfce4-session >/dev/null && echo AIB_XFCE_OK; pgrep -x lightdm >/dev/null && echo AIB_LIGHTDM_OK' -TimeoutSec 5
      if ($r.ExitCode -eq 0 -and $r.Output -match 'AIB_XFCE_OK') {
        $xfceReady = $true
        $summary.boot.xfceReadySeconds = [math]::Round(((Get-Date) - $bootStart).TotalSeconds, 2)
        Write-Log "XFCE ready in $($summary.boot.xfceReadySeconds)s"
        break
      }
    }
    Start-Sleep -Seconds 2
  }
  if (-not $xfceReady) { throw "XFCE session did not appear within $BootTimeoutSec seconds" }

  $consoleText = Get-Content $console -Raw -ErrorAction SilentlyContinue
  $summary.boot.consoleLoginSeen = ([string]$consoleText -match 'login:')
  if ($SettleSeconds -gt 0) { Start-Sleep -Seconds $SettleSeconds }

  $summary.screendumps += Take-QmpScreendump 'boot'
  Write-Log ("QMP screendump boot ok={0} duration={1}ms size={2}" -f $summary.screendumps[-1].ok, $summary.screendumps[-1].durationMs, $summary.screendumps[-1].image.sizeBytes)

  # Ensure the Guest Agent is running so a guest-side PNG screenshot is attempted.
  # pgrep -f "/home/aib/guest-agent" matches the ssh shell command itself,
  # because that string is part of the shell's own command line. Use the
  # process name instead so an absent agent is actually detected.
  $agent = Invoke-GuestSsh -Command 'pgrep -x guest-agent >/dev/null && echo AIB_AGENT_RUNNING || echo AIB_AGENT_STOPPED' -TimeoutSec 6
  if ($agent.Output -notmatch 'AIB_AGENT_RUNNING') {
    Write-Log 'guest-agent not running; starting it as aib'
    # setsid -f detaches the agent into its own session so the ssh channel can
    # close even if the agent inherited a pipe. The harness also kills the ssh
    # client after a hard timeout, so a held channel cannot block the run.
    $startAgent = 'cd /home/aib && DISPLAY=:0 setsid -f /home/aib/guest-agent -addr 0.0.0.0:7611 -token-file /home/aib/.agent-in-box-token </dev/null >>/tmp/guest-agent.log 2>&1; sleep 1; pgrep -x guest-agent >/dev/null && echo AIB_AGENT_STARTED || echo AIB_AGENT_FAILED'
    $agentStart = Invoke-GuestSsh -Command $startAgent -TimeoutSec 10
    Write-Log ("guest-agent start output=[{0}] timedOut={1} exit={2} stderr=[{3}]" -f $agentStart.Output, $agentStart.TimedOut, $agentStart.ExitCode, $agentStart.Stderr)
  }

  $token = ''
  $tokenResult = Invoke-GuestSsh -Command 'cat /home/aib/.agent-in-box-token 2>/dev/null' -TimeoutSec 6
  if ($tokenResult.ExitCode -eq 0) { $token = $tokenResult.Output.Trim() }

  $agentShot = $null
  if ($token -ne '') {
    $agentReady = $false
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
      $previous = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      $health = & curl.exe -s -m 2 -o NUL -w '%{http_code}' http://127.0.0.1:17611/healthz 2>$null
      $ErrorActionPreference = $previous
      Write-Log ("guest-agent healthz http_code=[{0}]" -f $health)
      if ($health -eq '200') { $agentReady = $true; break }
      Start-Sleep -Seconds 1
    }
    if ($agentReady) {
      $pngPath = Join-Path $logDir ("agent-screenshot-$stamp.png")
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $previous = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      & curl.exe -sS -m 15 -H "Authorization: Bearer $token" -o $pngPath http://127.0.0.1:17611/v1/screenshot 2>$null | Out-Null
      $curlCode = $LASTEXITCODE
      $ErrorActionPreference = $previous
      $sw.Stop()
      $pngInfo = Get-PngInfo $pngPath
      $agentShot = [ordered]@{
        durationMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
        httpExitCode = $curlCode
        path = $pngPath
        ok = ($curlCode -eq 0 -and $null -ne $pngInfo -and $pngInfo.format -eq 'png')
        image = $pngInfo
      }
      Write-Log ("guest-agent screenshot ok={0} duration={1}ms size={2}" -f $agentShot.ok, $agentShot.durationMs, $pngInfo.sizeBytes)
    } else {
      $diagnostics = Invoke-GuestSsh -Command 'pgrep -x guest-agent; ls -l /home/aib/guest-agent 2>&1; tail -20 /tmp/guest-agent.log 2>&1' -TimeoutSec 8
      Write-Log ("guest-agent diagnostics: {0}" -f $diagnostics.Output)
      $agentShot = [ordered]@{ ok = $false; error = 'guest-agent healthz did not return 200'; diagnostics = $diagnostics.Output }
      Write-Log 'guest-agent healthz did not return 200'
    }
  } else {
    $agentShot = [ordered]@{ ok = $false; error = 'guest token unavailable' }
    Write-Log 'guest token unavailable'
  }
  $summary.guestAgentScreenshot = $agentShot

  if ($HoldMinutes -gt 0) {
    Write-Log "holding VM for $HoldMinutes minutes, sampling every ${SampleSeconds}s"
    $holdStart = Get-Date
    $holdSeconds = $HoldMinutes * 60
    $nextSampleAt = $holdStart
    $memorySamples = @()
    $sshFailures = 0
    while ((((Get-Date) - $holdStart).TotalSeconds) -lt $holdSeconds) {
      $sampleStarted = Get-Date
      $proc.Refresh()
      $alive = -not $proc.HasExited
      $r = Invoke-GuestSsh -Command 'echo AIB_UP:$(cut -d. -f1 /proc/uptime); echo AIB_XFCE:$(pgrep -x xfce4-session | wc -l); echo AIB_AGENT:$(pgrep -x guest-agent | wc -l); uptime' -TimeoutSec 8
      $sshOk = ($r.ExitCode -eq 0 -and $r.Output -match 'AIB_UP:')
      if (-not $sshOk) {
        $sshFailures++
        $retry = Invoke-GuestSsh -Command 'echo AIB_UP:$(cut -d. -f1 /proc/uptime); echo AIB_XFCE:$(pgrep -x xfce4-session | wc -l); uptime' -TimeoutSec 8
        if ($retry.ExitCode -eq 0 -and $retry.Output -match 'AIB_UP:') { $r = $retry; $sshOk = $true }
      }
      $xfceCount = $null
      $guestUptimeSec = $null
      $agentCount = $null
      if ($r.Output -match 'AIB_UP:(\d+)') { $guestUptimeSec = [int]$Matches[1] }
      if ($r.Output -match 'AIB_XFCE:(\d+)') { $xfceCount = [int]$Matches[1] }
      if ($r.Output -match 'AIB_AGENT:(\d+)') { $agentCount = [int]$Matches[1] }
      $workingSetMB = $null
      $cpuSeconds = $null
      if ($alive) {
        $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
        if ($p) {
          $workingSetMB = [math]::Round($p.WorkingSet64 / 1MB, 1)
          $memorySamples += $workingSetMB
          try { $cpuSeconds = [math]::Round($p.TotalProcessorTime.TotalSeconds, 1) } catch { }
        }
      }
      $tail = Get-Content $console -Tail 60 -ErrorAction SilentlyContinue
      $panicTail = ([string]($tail -join "`n")) -match 'Kernel panic|BUG: unable to handle|Oops:|general protection fault|segfault at'
      $sample = [ordered]@{
        index = $summary.samples.Count + 1
        elapsedSeconds = [math]::Round(((Get-Date) - $holdStart).TotalSeconds, 1)
        sshOk = $sshOk
        sshExitCode = $r.ExitCode
        guestUptimeSeconds = $guestUptimeSec
        xfceSessionCount = $xfceCount
        guestAgentCount = $agentCount
        qemuAlive = $alive
        qemuWorkingSetMB = $workingSetMB
        qemuCpuSeconds = $cpuSeconds
        panicInConsoleTail = [bool]$panicTail
        hostFreeMB = $null
      }
      $summary.samples += $sample
      Write-Log ("sample {0} t={1}s ssh={2} uptime={3}s xfce={4} agent={5} alive={6} ws={7}MB" -f `
        $sample.index, $sample.elapsedSeconds, $sshOk, $guestUptimeSec, $xfceCount, $agentCount, $alive, $workingSetMB)
      if (-not $alive) { $failure = 'QEMU exited during hold'; break }
      if ($panicTail) { $failure = 'kernel panic signature observed in console tail'; break }

      $nextSampleAt = $nextSampleAt.AddSeconds($SampleSeconds)
      $sleepMs = [int](($nextSampleAt - (Get-Date)).TotalMilliseconds)
      if ($sleepMs -gt 0) { Start-Sleep -Milliseconds $sleepMs }
    }
    $summary.sampleCount = $summary.samples.Count
    $summary.sshFailures = $sshFailures
    $summary.holdActualSeconds = [math]::Round(((Get-Date) - $holdStart).TotalSeconds, 1)
    if ($memorySamples.Count -gt 0) {
      $summary.memory.workingSetMinMB = ($memorySamples | Measure-Object -Minimum).Minimum
      $summary.memory.workingSetMaxMB = ($memorySamples | Measure-Object -Maximum).Maximum
      $summary.memory.workingSetAvgMB = [math]::Round(($memorySamples | Measure-Object -Average).Average, 1)
      $summary.memory.workingSetLastMB = $memorySamples[-1]
    }
    $summary.screendumps += Take-QmpScreendump 'final'
    Write-Log ("QMP screendump final ok={0} duration={1}ms size={2}" -f $summary.screendumps[-1].ok, $summary.screendumps[-1].durationMs, $summary.screendumps[-1].image.sizeBytes)
  }
} catch {
  $failure = $_.Exception.Message
  Write-Log "FAILURE: $failure"
} finally {
  # Always attempt an ACPI shutdown; then quit/kill only if it does not exit.
  if ($null -ne $proc) {
    try {
      $proc.Refresh()
      if (-not $proc.HasExited) {
        $shutdownStart = Get-Date
        $method = 'acpi'
        try { Invoke-Qmp -Port 14445 -Commands @('{"execute":"system_powerdown"}') | Out-Null } catch { Write-Log "system_powerdown failed: $($_.Exception.Message)" }
        $exited = $proc.WaitForExit($ShutdownTimeoutSec * 1000)
        if (-not $exited) {
          $method = 'qmp-quit'
          Write-Log 'ACPI shutdown timed out; sending QMP quit'
          try { Invoke-Qmp -Port 14445 -Commands @('{"execute":"quit"}') | Out-Null } catch { Write-Log "QMP quit failed: $($_.Exception.Message)" }
          $exited = $proc.WaitForExit(15000)
        }
        if (-not $exited) {
          $method = 'force-kill'
          Write-Log 'QMP quit timed out; forcing process kill'
          try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop; $null = $proc.WaitForExit(5000) } catch { Write-Log "force kill failed: $($_.Exception.Message)" }
        }
        $proc.Refresh()
        $summary.shutdown.method = $method
        $summary.shutdown.seconds = [math]::Round(((Get-Date) - $shutdownStart).TotalSeconds, 1)
        $summary.shutdown.qemuExited = $proc.HasExited
        if ($proc.HasExited) { $summary.qemu.exitCode = $proc.ExitCode }
        Write-Log ("shutdown method={0} seconds={1} exited={2} exitCode={3}" -f $method, $summary.shutdown.seconds, $proc.HasExited, $summary.qemu.exitCode)
      } else {
        $summary.shutdown.method = 'already-exited'
        $summary.shutdown.qemuExited = $true
        $summary.qemu.exitCode = $proc.ExitCode
        Write-Log "QEMU had already exited with code $($proc.ExitCode)"
      }
    } catch {
      Write-Log "shutdown handling error: $($_.Exception.Message)"
    }
  }

  if (Test-Path $stderrLog) {
    # Cast to [string[]]: Windows PowerShell 5.1 attaches FileSystem ETS
    # metadata (PSDrive/PSProvider/ReadCount) to Get-Content results. Letting
    # ConvertTo-Json walk that metadata recursed to a multi-GB working set.
    $warnings = [string[]]@(Get-Content $stderrLog -ErrorAction SilentlyContinue | Where-Object { $_ -match 'warning|error|failed' })
    $summary.qemu.stderrWarnings = [string[]]@($warnings | Select-Object -Last 20)
  }
  $summary.consolePanics = @(Get-ConsolePanics $console)

  $evidenceDir = Join-Path $root "stability-logs\evidence-desktop-$safeCpu-$stamp"
  New-Item -ItemType Directory -Force $evidenceDir | Out-Null
  foreach ($log in @($console, $stderrLog, $stdoutLog)) {
    if (Test-Path $log) { Copy-Item -Force $log (Join-Path $evidenceDir (Split-Path $log -Leaf)) }
  }
  Copy-Item -Force $transcript (Join-Path $evidenceDir 'harness.log') -ErrorAction SilentlyContinue
  $summary.evidenceDir = $evidenceDir
  Write-Log "stage: evidence copied to $evidenceDir"

  # Do not query WMI again after QEMU shutdown. In the first probe run a WMI
  # call in this position hung for minutes after the WHPX process exited, while
  # the evidence copy had already completed. Host memory evidence is collected
  # from Get-Process WorkingSet64 during the hold and from FreePhysicalMemory
  # before boot.
  $summary.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  if ($null -ne $bootStart) { $summary.durationSeconds = [math]::Round(((Get-Date) - $bootStart).TotalSeconds, 2) }

  $holdComplete = $true
  if ($HoldMinutes -gt 0 -and $null -eq $holdStart) { $holdComplete = $false }
  if ($HoldMinutes -gt 0 -and $null -ne $holdStart) {
    $holdElapsed = [math]::Round(((Get-Date) - $holdStart).TotalSeconds, 1)
    if ($holdElapsed -lt ($HoldMinutes * 60)) { $holdComplete = $false }
  }
  $panicFound = ($summary.consolePanics.Count -gt 0)
  if ($null -eq $failure -and $holdComplete -and -not $panicFound -and $summary.shutdown.qemuExited) {
    $summary.status = 'success'
  } else {
    $summary.status = 'failed'
    if ($null -ne $failure) { $summary.error = $failure }
    elseif ($panicFound) { $summary.error = 'kernel panic signature found in console log' }
    elseif (-not $holdComplete) { $summary.error = 'stability hold window did not complete' }
    elseif (-not $summary.shutdown.qemuExited) { $summary.error = 'QEMU did not exit after shutdown requests' }
  }
  if ($summary.sshFailures -gt 1) { $summary.status = 'failed'; if ($null -eq $summary.error) { $summary.error = "SSH sample failures: $($summary.sshFailures)" } }

  Write-Log 'stage: summary fields done'
  $json = $summary | ConvertTo-Json -Depth 10
  Write-Log 'stage: summary serialized'
  [System.IO.File]::WriteAllText($ResultJson, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Log "summary written to $ResultJson status=$($summary.status)"
}

if ($summary.status -ne 'success') { exit 1 }
