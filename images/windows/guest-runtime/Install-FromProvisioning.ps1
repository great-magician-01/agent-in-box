#Requires -RunAsAdministrator
<#
.SYNOPSIS
  First-logon entry point used by the reference autounattend file.

.DESCRIPTION
  Expects the following layout on the AIB-PROVISION volume:

    AIB-PROVISION\
      install-guest-runtime.ps1   (this file)
      install.ps1
      cua-extension.js
      artifacts\
        node-v24.18.0-win-x64.zip
        <pi-coding-agent>.tgz
        agent-in-box-worker-<version>.tar.gz
        guest-agent-windows-amd64.exe

  It installs the guest runtime and shuts the VM down so the qcow2 can be used
  as a Golden Image. Per-VM tokens are NOT part of this medium; provision them
  after cloning the image.
#>
[CmdletBinding()]
param(
    [string]$ProvisionRoot = $PSScriptRoot,
    [string]$User = "aib",
    [switch]$NoShutdown
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Start-Transcript -Path "C:\Windows\Temp\agent-in-box-provision.log" -Append | Out-Null
try {
    $artifactRoot = Join-Path $ProvisionRoot "artifacts"
    if (-not (Test-Path -LiteralPath $artifactRoot -PathType Container)) {
        throw "Missing artifacts directory: $artifactRoot"
    }
    $nodeZip = Get-ChildItem -LiteralPath $artifactRoot -Filter "node-v*-win-x64.zip" |
        Select-Object -First 1
    $piTarball = Get-ChildItem -LiteralPath $artifactRoot -Filter "*.tgz" |
        Select-Object -First 1
    $workerArchive = Get-ChildItem -LiteralPath $artifactRoot -Filter "agent-in-box-worker-*.tar.gz" |
        Select-Object -First 1
    $guestAgent = Get-ChildItem -LiteralPath $artifactRoot -Filter "guest-agent-windows-amd64.exe" |
        Select-Object -First 1
    if (-not $nodeZip -or -not $piTarball -or -not $workerArchive -or -not $guestAgent) {
        throw "Provisioning artifacts are incomplete under $artifactRoot"
    }
    $extension = Join-Path $ProvisionRoot "cua-extension.js"
    if (-not (Test-Path -LiteralPath $extension -PathType Leaf)) {
        throw "Missing cua-extension.js in $ProvisionRoot"
    }

    & (Join-Path $ProvisionRoot "install.ps1") `
        -NodeZip $nodeZip.FullName `
        -PiTarball $piTarball.FullName `
        -WorkerArchive $workerArchive.FullName `
        -GuestAgentExe $guestAgent.FullName `
        -CuaExtension $extension `
        -User $User
    if (-not $NoShutdown) {
        Write-Host "Guest runtime installed; shutting down for Golden Image capture."
        Stop-Computer -Force
    }
} finally {
    Stop-Transcript | Out-Null
}
