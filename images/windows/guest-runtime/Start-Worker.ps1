# Starts the Guest Worker RPC server as the interactive guest user. The Worker
# itself has no Windows desktop permissions; Computer Use goes through the host
# broker and the Guest Agent. Tokens are read from protected per-VM files.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$dataRoot = "C:\ProgramData\AgentInBox"
$configPath = Join-Path $dataRoot "config.json"
$logRoot = Join-Path $dataRoot "logs"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$log = Join-Path $logRoot "worker.log"

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
        $token = Join-Path $config.tokenRoot "worker-rpc.token"
        if (-not (Test-Path -LiteralPath $token -PathType Leaf)) {
            Start-Sleep -Seconds 10
            continue
        }
        $env:AGENT_IN_BOX_WORKER_TOKEN_FILE = $token
        $env:AGENT_IN_BOX_SESSION_ROOT = $config.sessionRoot
        $env:AGENT_IN_BOX_PI_BINARY = $config.nodeExe
        $env:AGENT_IN_BOX_PI_SCRIPT = $config.piScript
        $env:AGENT_IN_BOX_WORKER_HOST = "0.0.0.0"
        $env:AGENT_IN_BOX_WORKER_PORT = "7612"
        if ($config.cuaExtension -and (Test-Path -LiteralPath $config.cuaExtension)) {
            $env:AGENT_IN_BOX_CUA_EXTENSION = $config.cuaExtension
        } else {
            Remove-Item Env:AGENT_IN_BOX_CUA_EXTENSION -ErrorAction SilentlyContinue
        }

        Rotate-Log
        & $config.nodeExe $config.workerMain *>> $log
        "Worker exited with code $LASTEXITCODE at $(Get-Date -Format o)" | Out-File -Append -Encoding UTF8 $log
    } catch {
        "Worker wrapper error: $($_.Exception.Message)" | Out-File -Append -Encoding UTF8 $log
    }
    Start-Sleep -Seconds 5
}
