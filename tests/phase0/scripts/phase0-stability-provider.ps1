# Repeat the real Go VmProvider integration test and record per-round timing and
# residual QEMU processes. ASCII-only source on purpose: Windows PowerShell 5.1
# reads BOM-less scripts as ANSI, so the Unicode storage path is built from code
# points instead of being embedded as a literal.
param(
  [int]$Rounds = 5,
  [int]$StartRound = 1,
  [string]$StorageRoot = '',
  [switch]$CustomUnicodeStorage,
  [string]$ResultJson = '',
  [int]$RoundTimeoutSec = 360
)
$ErrorActionPreference = 'Stop'

$root = Join-Path $env:LOCALAPPDATA 'AgentInBox'
$testExe = Join-Path $root 'tools\vmprovider-integration.test.exe'
$qemuDir = Join-Path $root 'tools\msys64\ucrt64\bin'
$baseImage = Join-Path $root 'images\noble-server-cloudimg-amd64.img'
$seedImage = Join-Path $root 'vms\phase0-linux\seed.iso'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logDir = Join-Path $root "stability-logs\provider-$stamp"
New-Item -ItemType Directory -Force $logDir | Out-Null
if ($ResultJson -eq '') { $ResultJson = Join-Path $logDir 'summary.json' }

foreach ($required in @($testExe, $baseImage, $seedImage)) {
  if (-not (Test-Path $required)) { throw "required file not found: $required" }
}

# "lu jing ce shi" (Unicode path segment) + space, built without non-ASCII source.
$unicodeSegment = ([string][char]0x8DEF) + ([string][char]0x5F84) + ' ' +
                  ([string][char]0x6D4B) + ([string][char]0x8BD5)
if ($CustomUnicodeStorage) {
  if ($StorageRoot -ne '') { throw 'use either -CustomUnicodeStorage or -StorageRoot, not both' }
  $storage = Join-Path (Join-Path $root $unicodeSegment) 'vms'
} elseif ($StorageRoot -ne '') {
  $storage = $StorageRoot
} else {
  $storage = Join-Path $root 'vms-go'
}
New-Item -ItemType Directory -Force $storage | Out-Null

$env:AGENT_IN_BOX_QEMU_INTEGRATION = '1'
$env:AGENT_IN_BOX_QEMU_DIR = $qemuDir
$env:AGENT_IN_BOX_BASE_IMAGE = $baseImage
$env:AGENT_IN_BOX_VM_STORAGE = $storage
$env:AGENT_IN_BOX_SEED_IMAGE = $seedImage

function Get-ProviderQemuProcesses {
  # Only match QEMU processes belonging to this test VM so an unrelated VM is
  # never killed by the stability harness.
  @(Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*go-provider-smoke*' } |
    Select-Object ProcessId, CommandLine)
}

$preExisting = @(Get-Process qemu-system-x86_64 -ErrorAction SilentlyContinue)
if ($preExisting.Count -gt 0) {
  $ids = ($preExisting | ForEach-Object { $_.Id }) -join ','
  throw "QEMU already running before provider stability run (pids: $ids); stop it first"
}

$startedAt = (Get-Date).ToUniversalTime()
$roundResults = @()
$vmID = 'go-provider-smoke'

Write-Host "storageRoot=$storage"
Write-Host "rounds=$Rounds timeout=${RoundTimeoutSec}s testBinary=$testExe"

for ($i = 0; $i -lt $Rounds; $i++) {
  $roundNo = $StartRound + $i
  $roundStamp = Get-Date -Format 'HHmmss'
  $outFile = Join-Path $logDir ("provider-round-{0:D2}-{1}.stdout.log" -f $roundNo, $roundStamp)
  $errFile = Join-Path $logDir ("provider-round-{0:D2}-{1}.stderr.log" -f $roundNo, $roundStamp)
  $roundStart = (Get-Date).ToUniversalTime()
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Write-Host ("[{0}] round {1} starting" -f (Get-Date).ToString('HH:mm:ss'), $roundNo)

  $argumentsText = '-test.v -test.run TestQemuProviderIntegration -test.timeout ' + $RoundTimeoutSec + 's'
  # System.Diagnostics.Process is used instead of Start-Process because
  # Start-Process -PassThru returned an empty ExitCode on this Windows host.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $testExe
  $psi.Arguments = $argumentsText
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderrTask = $proc.StandardError.ReadToEndAsync()
  $completed = $proc.WaitForExit(($RoundTimeoutSec + 30) * 1000)
  $timedOut = $false
  if (-not $completed) {
    $timedOut = $true
    try { $proc.Kill(); $null = $proc.WaitForExit(5000) } catch { }
  }
  $sw.Stop()
  $roundEnd = (Get-Date).ToUniversalTime()
  $stdout = ''
  $stderr = ''
  try {
    if ($stdoutTask.Wait(5000)) { $stdout = [string]$stdoutTask.Result }
    if ($stderrTask.Wait(5000)) { $stderr = [string]$stderrTask.Result }
  } catch { }
  [System.IO.File]::WriteAllText($outFile, $stdout, [System.Text.Encoding]::UTF8)
  [System.IO.File]::WriteAllText($errFile, $stderr, [System.Text.Encoding]::UTF8)
  $exitCode = $null
  if ($completed) {
    try { $exitCode = $proc.ExitCode } catch { }
  }

  # Give the provider/test cleanup a short window before judging residuals.
  Start-Sleep -Seconds 2
  $residual = @(Get-ProviderQemuProcesses)
  $residualKilled = $false
  if ($residual.Count -gt 0) {
    foreach ($p in $residual) {
      try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
    }
    $residualKilled = $true
    Start-Sleep -Seconds 1
    $residual = @(Get-ProviderQemuProcesses)
  }

  $match = [regex]::Match([string]$stdout, '--- (PASS|FAIL): TestQemuProviderIntegration \(([0-9.]+)s\)')
  $testSeconds = $null
  if ($match.Success) { $testSeconds = [double]$match.Groups[2].Value }

  $failureReasons = @()
  if ($timedOut) { $failureReasons += "round timeout after $($RoundTimeoutSec + 30)s" }
  if ($exitCode -ne 0) { $failureReasons += "exit code $exitCode" }
  if ($stdout -notmatch '(?m)^PASS\r?$') { $failureReasons += 'stdout did not contain PASS' }
  if ($residual.Count -gt 0) { $failureReasons += 'residual QEMU process after round' }
  $passed = ($failureReasons.Count -eq 0)

  $vmDir = Join-Path $storage $vmID
  $vmDirLeft = Test-Path $vmDir
  if ($passed -and $vmDirLeft) { $failureReasons += 'VM directory was not deleted' ; $passed = $false }

  $roundResults += [ordered]@{
    round = $roundNo
    startedAt = $roundStart.ToString('o')
    finishedAt = $roundEnd.ToString('o')
    durationSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    testDurationSeconds = $testSeconds
    exitCode = $exitCode
    timedOut = $timedOut
    passed = $passed
    vmDirectoryLeftBehind = $vmDirLeft
    residualQemu = @($residual | ForEach-Object { [ordered]@{ pid = $_.ProcessId; commandLine = $_.CommandLine } })
    residualQemuKilled = $residualKilled
    stdoutLog = $outFile
    stderrLog = $errFile
    failureReasons = @($failureReasons)
  }
  Write-Host ("[{0}] round {1} passed={2} wall={3}s test={4}s exit={5} residual={6}" -f `
    (Get-Date).ToString('HH:mm:ss'), $roundNo, $passed, `
    [math]::Round($sw.Elapsed.TotalSeconds, 2), $testSeconds, $exitCode, $residual.Count)
  if (-not $passed) {
    Write-Host ("round {0} failure reasons: {1}" -f $roundNo, ($failureReasons -join '; '))
    $stderrText = [string]$stderr
    if ($stderrText.Length -gt 0) { Write-Host ("round {0} stderr tail: {1}" -f $roundNo, ($stderrText.Substring([Math]::Max(0, $stderrText.Length - 800)))) }
  }
}

$finishedAt = (Get-Date).ToUniversalTime()
$endResidual = @(Get-ProviderQemuProcesses)
$passCount = @($roundResults | Where-Object { $_.passed }).Count
$status = if ($passCount -eq $Rounds -and $endResidual.Count -eq 0) { 'success' } else { 'failed' }

$summary = [ordered]@{
  script = 'phase0-stability-provider.ps1'
  runId = "2026-11-10-h1-whpx-provider-stability-$stamp"
  hostProfile = 'H1'
  startedAt = $startedAt.ToString('o')
  finishedAt = $finishedAt.ToString('o')
  durationSeconds = [math]::Round(($finishedAt - $startedAt).TotalSeconds, 2)
  storageRoot = $storage
  customUnicodeStorage = [bool]$CustomUnicodeStorage
  qemuDir = $qemuDir
  baseImage = $baseImage
  seedImage = $seedImage
  testBinary = $testExe
  testBinaryLastWriteTime = (Get-Item $testExe).LastWriteTimeUtc.ToString('o')
  roundCount = $Rounds
  passCount = $passCount
  failCount = $Rounds - $passCount
  rounds = @($roundResults)
  residualQemuAtEnd = @($endResidual | ForEach-Object { [ordered]@{ pid = $_.ProcessId; commandLine = $_.CommandLine } })
  status = $status
  notes = 'Each round runs TestQemuProviderIntegration: create overlay, start WHPX guest, wait for login, reconcile after provider restart, idempotent start/stop, graceful stop, snapshot create/restore, delete VM.'
}
$summary | ConvertTo-Json -Depth 10 | Set-Content -Path $ResultJson -Encoding UTF8
Write-Host "summary written to $ResultJson"
Write-Host "status=$status pass=$passCount/$Rounds"
if ($status -ne 'success') { exit 1 }
