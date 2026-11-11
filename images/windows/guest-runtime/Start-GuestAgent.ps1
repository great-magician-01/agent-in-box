# Starts the authenticated Guest Agent in the interactive guest session.
# The task intentionally runs as the logged-in user: Windows GDI capture and
# SendInput only operate on that user's desktop. It does not run as SYSTEM.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$dataRoot = "C:\ProgramData\AgentInBox"
$configPath = Join-Path $dataRoot "config.json"
$logRoot = Join-Path $dataRoot "logs"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$log = Join-Path $logRoot "guest-agent.log"

function Rotate-Log {
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5MB) {
        Move-Item -LiteralPath $log -Destination "$log.1" -Force
    }
}

while ($true) {
    try {
        if (-not (Test-Path -LiteralPath $configPath)) {
            Start-Sleep -Seconds 10
            continue
        }
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        $token = Join-Path $config.tokenRoot "guest-agent.token"
        if (-not (Test-Path -LiteralPath $token -PathType Leaf)) {
            Start-Sleep -Seconds 10
            continue
        }
        Rotate-Log
        $arguments = @(
            "-addr", "0.0.0.0:7611",
            "-token-file", $token,
            "-verify-roots", "$env:USERPROFILE;$($config.dataRoot)",
            "-workspace-roots", "$env:USERPROFILE",
            "-update-dir", $config.updateRoot
        )
        & $config.guestAgentExe @arguments *>> $log
        "Guest Agent exited with code $LASTEXITCODE at $(Get-Date -Format o)" | Out-File -Append -Encoding UTF8 $log
    } catch {
        "Guest Agent wrapper error: $($_.Exception.Message)" | Out-File -Append -Encoding UTF8 $log
    }
    Start-Sleep -Seconds 5
}
