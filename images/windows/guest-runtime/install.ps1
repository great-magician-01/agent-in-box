#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs the Agent-in-Box Windows Guest runtime into a golden image.

.DESCRIPTION
  This script consumes explicit external artifacts (Node zip, Pi npm tarball,
  Worker runtime archive and Guest Agent executable). It never downloads code,
  never writes Provider or bot secrets, and never disables UAC or other Windows
  security mechanisms.

  Token files are provisioned separately through Provision-Tokens.ps1. The
  scheduled tasks start only after the per-VM tokens exist.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodeZip,
    [Parameter(Mandatory = $true)][string]$PiTarball,
    [Parameter(Mandatory = $true)][string]$WorkerArchive,
    [Parameter(Mandatory = $true)][string]$GuestAgentExe,
    [string]$CuaExtension = "",
    [string]$NodeVersion = "24.18.0",
    [string]$PiVersion = "1.5.1",
    [string]$User = $env:USERNAME,
    [string]$InstallRoot = "C:\AgentInBox",
    [string]$DataRoot = "C:\ProgramData\AgentInBox",
    [string]$WorkspaceRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-FileHashIfPresent {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Missing artifact: $Path"
    }
    $sidecar = "$Path.sha256"
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) { return }
    $expected = ((Get-Content -LiteralPath $sidecar -TotalCount 1) -split "\s+")[0].ToLowerInvariant()
    if ($expected -notmatch "^[a-f0-9]{64}$") { throw "Invalid checksum sidecar: $sidecar" }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "SHA-256 mismatch for $Path" }
}

function Set-RestrictedAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$UserSid,
        [switch]$WriteForUser
    )
    $userRight = if ($WriteForUser) { "M" } else { "R" }
    $arguments = @(
        $Path, "/inheritance:r",
        "/grant:r", "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
        "*${userSid}:(OI)(CI)$userRight"
    )
    & icacls.exe @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed for $Path" }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell window."
}
if (-not (Get-LocalUser -Name $User -ErrorAction SilentlyContinue)) {
    throw "Local user '$User' does not exist. Create the interactive guest user first."
}
$userSid = (New-Object Security.Principal.NTAccount($User)).Translate(
    [Security.Principal.SecurityIdentifier]
).Value

if (-not $WorkspaceRoot) { $WorkspaceRoot = Join-Path "C:\Users\$User" "AgentInBox\workspace" }

$artifacts = @($NodeZip, $PiTarball, $WorkerArchive, $GuestAgentExe)
if ($CuaExtension) { $artifacts += $CuaExtension }
foreach ($artifact in $artifacts) { Assert-FileHashIfPresent -Path ((Resolve-Path -LiteralPath $artifact).Path) }

$nodeRoot = Join-Path $InstallRoot "node"
$workerRoot = Join-Path $InstallRoot "worker"
$guestAgentRoot = Join-Path $InstallRoot "guest-agent"
$scriptsRoot = Join-Path $InstallRoot "scripts"
$tokenRoot = Join-Path $DataRoot "tokens"
$sessionRoot = Join-Path $DataRoot "worker\sessions"
$logRoot = Join-Path $DataRoot "logs"
$updateRoot = Join-Path $DataRoot "updates"
foreach ($directory in @(
    $nodeRoot, $workerRoot, $guestAgentRoot, $scriptsRoot,
    $tokenRoot, $sessionRoot, $logRoot, $updateRoot, $WorkspaceRoot
)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

Write-Host "Extracting Node.js $NodeVersion..."
$nodeStage = Join-Path $InstallRoot "node-stage"
Remove-Item -LiteralPath $nodeStage -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $NodeZip -DestinationPath $nodeStage -Force
$nodeExeSource = Get-ChildItem -LiteralPath $nodeStage -Recurse -Filter "node.exe" |
    Select-Object -First 1
if (-not $nodeExeSource) { throw "Node archive does not contain node.exe" }
$nodeSourceRoot = Split-Path -Parent $nodeExeSource.FullName
Copy-Item -Path (Join-Path $nodeSourceRoot "*") -Destination $nodeRoot -Recurse -Force
Remove-Item -LiteralPath $nodeStage -Recurse -Force
$nodeExe = Join-Path $nodeRoot "node.exe"
$npmCmd = Join-Path $nodeRoot "npm.cmd"
$actualNode = (& $nodeExe --version).Trim()
if ($actualNode -ne "v$NodeVersion") { throw "Node version is $actualNode; required v$NodeVersion" }

Write-Host "Extracting Worker runtime..."
& tar.exe -xzf $WorkerArchive -C $workerRoot
if ($LASTEXITCODE -ne 0) { throw "Failed to extract the Worker runtime archive" }
$workerMain = Join-Path $workerRoot "dist\worker-rpc-main.js"
if (-not (Test-Path -LiteralPath $workerMain)) { throw "Worker runtime is missing dist\worker-rpc-main.js" }
$subagentExtension = Join-Path $workerRoot "extensions\subagent-extension.js"
if (-not (Test-Path -LiteralPath $subagentExtension -PathType Leaf)) {
    throw "Worker runtime is missing the default extensions\subagent-extension.js"
}

Write-Host "Installing Pi $PiVersion from the explicit npm tarball..."
& $npmCmd install --prefix $workerRoot --omit=dev --no-audit --no-fund --ignore-scripts $PiTarball
if ($LASTEXITCODE -ne 0) { throw "npm failed to install the Pi tarball" }
$piPackageJson = Join-Path $workerRoot "node_modules\@earendil-works\pi-coding-agent\package.json"
if (-not (Test-Path -LiteralPath $piPackageJson)) { throw "Pi package was not installed" }
$piPackage = Get-Content -LiteralPath $piPackageJson -Raw | ConvertFrom-Json
if ($piPackage.version -ne $PiVersion) {
    throw "Installed Pi version is $($piPackage.version); required $PiVersion"
}
$piBin = if ($piPackage.bin -is [string]) { $piPackage.bin } elseif ($piPackage.bin.pi) { $piPackage.bin.pi } else { "" }
if (-not $piBin) { throw "Pi package does not declare a pi bin entry" }
$piScript = Join-Path (Split-Path -Parent $piPackageJson) $piBin

Write-Host "Installing Guest Agent..."
Copy-Item -LiteralPath $GuestAgentExe -Destination (Join-Path $guestAgentRoot "guest-agent.exe") -Force
$guestAgentExePath = Join-Path $guestAgentRoot "guest-agent.exe"

$cuaExtensionPath = ""
if ($CuaExtension) {
    $extensionRoot = Join-Path $workerRoot "extensions"
    New-Item -ItemType Directory -Force -Path $extensionRoot | Out-Null
    $cuaExtensionPath = Join-Path $extensionRoot "cua-extension.js"
    Copy-Item -LiteralPath $CuaExtension -Destination $cuaExtensionPath -Force
}

foreach ($script in @("Start-GuestAgent.ps1", "Start-Worker.ps1", "Provision-Tokens.ps1")) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination $scriptsRoot -Force
}

Set-RestrictedAcl -Path $tokenRoot -UserSid $userSid
Set-RestrictedAcl -Path $sessionRoot -UserSid $userSid -WriteForUser
Set-RestrictedAcl -Path $logRoot -UserSid $userSid -WriteForUser
Set-RestrictedAcl -Path $WorkspaceRoot -UserSid $userSid -WriteForUser

$config = [ordered]@{
    installRoot      = $InstallRoot
    dataRoot         = $DataRoot
    user             = $User
    workspaceRoot    = $WorkspaceRoot
    nodeExe          = $nodeExe
    workerMain       = $workerMain
    workerRoot       = $workerRoot
    guestAgentExe    = $guestAgentExePath
    piScript         = $piScript
    cuaExtension     = $cuaExtensionPath
    tokenRoot        = $tokenRoot
    sessionRoot      = $sessionRoot
    logRoot          = $logRoot
    updateRoot       = $updateRoot
}
$config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $DataRoot "config.json") -Encoding UTF8

Write-Host "Configuring Windows Firewall for QEMU user networking (10.0.2.2)..."
foreach ($rule in @("Agent-in-Box Guest Agent", "Agent-in-Box Worker RPC")) {
    Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}
New-NetFirewallRule -DisplayName "Agent-in-Box Guest Agent" -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 7611 -RemoteAddress @("10.0.2.2", "127.0.0.1") -Profile Any | Out-Null
New-NetFirewallRule -DisplayName "Agent-in-Box Worker RPC" -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 7612 -RemoteAddress @("10.0.2.2", "127.0.0.1") -Profile Any | Out-Null

Write-Host "Registering per-user logon tasks..."
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
foreach ($entry in @(
    @{ Name = "AgentInBox-GuestAgent"; Script = "Start-GuestAgent.ps1" },
    @{ Name = "AgentInBox-Worker"; Script = "Start-Worker.ps1" }
)) {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $scriptsRoot $entry.Script)`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $entry.Name -Action $action -Trigger $trigger `
        -Principal $taskPrincipal -Settings $settings -Force | Out-Null
}

Write-Host ""
Write-Host "Guest runtime installed." -ForegroundColor Green
Write-Host "Next: provision per-VM tokens into $tokenRoot with Provision-Tokens.ps1,"
Write-Host "then sign in as '$User'. The tasks start automatically at logon."
Write-Host "Do not bake Provider keys, bot secrets or long-lived tokens into the image."
