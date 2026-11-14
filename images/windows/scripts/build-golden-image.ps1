#Requires -Version 5.1
<#
.SYNOPSIS
  Builds a local Windows Golden Image qcow2 with QEMU (WHPX on Windows hosts).

.DESCRIPTION
  The caller must provide a legally obtained Windows ISO (for example a
  Microsoft evaluation image) and a provisioning directory. This script does
  not download or redistribute Windows, and it does not bypass activation, UAC
  or any Windows security boundary.

  The provisioning directory must follow images/windows/README.md and include
  autounattend.xml plus an AIB-PROVISION folder. The guest provisioning script
  shuts Windows down when installation finishes; this script then checks the
  qcow2 and writes SHA-256 and build-manifest metadata.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$WindowsIso,
    [Parameter(Mandatory = $true)][string]$ProvisionDirectory,
    [Parameter(Mandatory = $true)][string]$OutputQcow2,
    [string]$WindowsIsoSha256 = "",
    [string]$VirtioIso = "",
    [string]$QemuSystem = "qemu-system-x86_64.exe",
    [string]$QemuImg = "qemu-img.exe",
    [int]$CpuCount = 4,
    [int]$MemoryMb = 8192,
    [int]$DiskGb = 64,
    [int]$VncDisplay = 9,
    [int]$TimeoutMinutes = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-CommandPath {
    param([Parameter(Mandatory = $true)][string]$Command)
    if (Test-Path -LiteralPath $Command -PathType Leaf) { return (Resolve-Path -LiteralPath $Command).Path }
    $resolved = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $resolved) { throw "Command not found: $Command" }
    return $resolved.Source
}

function Quote-Argument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
    return $Value
}

$qemuSystemPath = Resolve-CommandPath $QemuSystem
$qemuImgPath = Resolve-CommandPath $QemuImg
if (-not (Test-Path -LiteralPath $WindowsIso -PathType Leaf)) { throw "Windows ISO not found: $WindowsIso" }
if (-not (Test-Path -LiteralPath $ProvisionDirectory -PathType Container)) {
    throw "Provisioning directory not found: $ProvisionDirectory"
}
$unattend = Join-Path $ProvisionDirectory "autounattend.xml"
if (-not (Test-Path -LiteralPath $unattend -PathType Leaf)) {
    throw "Provisioning directory must contain autounattend.xml"
}
if (-not (Test-Path -LiteralPath (Join-Path $ProvisionDirectory "AIB-PROVISION") -PathType Container)) {
    throw "Provisioning directory must contain the AIB-PROVISION folder"
}

$unattendText = Get-Content -LiteralPath $unattend -Raw
if ($unattendText -match 'AIB-LOCAL-ONLY-CHANGE-ME') {
    throw "autounattend.xml still uses the example password; set a unique password before building"
}
if ($unattendText -match '<PlainText>true</PlainText>') {
    Write-Warning "autounattend.xml contains a plaintext password and AutoLogon credentials; protect the golden image as a secret."
}

if ($WindowsIsoSha256) {
    $actualIsoHash = (Get-FileHash -LiteralPath $WindowsIso -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualIsoHash -ne $WindowsIsoSha256.ToLowerInvariant()) {
        throw "Windows ISO SHA-256 does not match the expected value"
    }
}

$outputDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($OutputQcow2))
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
if (Test-Path -LiteralPath $OutputQcow2) { throw "Refusing to overwrite $OutputQcow2" }

Write-Host "Creating qcow2 disk $DiskGb GiB..."
& $qemuImgPath create -f qcow2 $OutputQcow2 "$($DiskGb)G"
if ($LASTEXITCODE -ne 0) { throw "qemu-img create failed" }

$arguments = @(
    "-name", "agent-in-box-windows-build",
    "-machine", "q35",
    "-accel", "whpx,kernel-irqchip=off",
    "-cpu", "qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt",
    "-smp", "$CpuCount",
    "-m", "$MemoryMb",
    "-drive", "file=$($OutputQcow2),if=ide,format=qcow2",
    "-drive", "file=$((Resolve-Path -LiteralPath $WindowsIso).Path),media=cdrom,readonly=on",
    # Build-only vvfat CD carrying autounattend.xml and AIB-PROVISION. Windows
    # Setup searches removable media for autounattend.xml; the first-logon
    # script scans all drives for AIB-PROVISION.
    "-drive", "file=fat:rw:$((Resolve-Path -LiteralPath $ProvisionDirectory).Path),format=raw,media=cdrom",
    "-netdev", "user,id=n0",
    "-device", "e1000,netdev=n0",
    "-vga", "std",
    "-device", "qemu-xhci",
    "-device", "usb-tablet",
    "-display", "none",
    "-vnc", "127.0.0.1:$VncDisplay"
)
if ($VirtioIso) {
    if (-not (Test-Path -LiteralPath $VirtioIso -PathType Leaf)) { throw "VirtIO ISO not found: $VirtioIso" }
    $arguments += @(
        "-drive",
        "file=$((Resolve-Path -LiteralPath $VirtioIso).Path),media=cdrom,readonly=on"
    )
}

$argumentLine = ($arguments | ForEach-Object { Quote-Argument $_ }) -join " "
Write-Host "Starting Windows unattended installation. VNC: 127.0.0.1:$VncDisplay"
Write-Host "This is a build-only vvfat provisioning medium; do not use it for production VMs."
$process = Start-Process -FilePath $qemuSystemPath -ArgumentList $argumentLine -PassThru -NoNewWindow
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ($true) {
    $process.Refresh()
    if ($process.HasExited) { break }
    if ((Get-Date) -gt $deadline) {
        Stop-Process -Id $process.Id -Force
        throw "Windows installation timed out after $TimeoutMinutes minutes"
    }
    Start-Sleep -Seconds 10
}
if ($process.ExitCode -ne 0) {
    throw "QEMU exited with code $($process.ExitCode); inspect the VNC console and qcow2 before retrying"
}

Write-Host "Checking qcow2..."
& $qemuImgPath check $OutputQcow2
if ($LASTEXITCODE -ne 0) { throw "qemu-img check failed" }
$infoJson = (& $qemuImgPath info --output=json $OutputQcow2) -join "`n"
$info = $infoJson | ConvertFrom-Json
$sha256 = (Get-FileHash -LiteralPath $OutputQcow2 -Algorithm SHA256).Hash.ToLowerInvariant()
$sizeBytes = (Get-Item -LiteralPath $OutputQcow2).Length
$manifest = [ordered]@{
    format             = "agent-in-box.windows-golden-image"
    schemaVersion      = 1
    osFamily           = "windows"
    osVersion          = "REPLACE_WITH_WINDOWS_VERSION"
    architecture       = "amd64"
    builtAt            = (Get-Date).ToUniversalTime().ToString("o")
    sourceIso          = (Split-Path -Leaf $WindowsIso)
    sourceIsoSha256    = (Get-FileHash -LiteralPath $WindowsIso -Algorithm SHA256).Hash.ToLowerInvariant()
    virtualSizeBytes   = [int64]$info."virtual-size"
    fileSizeBytes      = $sizeBytes
    sha256             = $sha256
    qemuImageFormat    = $info.format
    qemuArguments      = $arguments
    licenseNote        = "Built only from a Windows ISO supplied by the operator; activation and redistribution are the operator's responsibility."
    provisioningNote   = "Tokens are not baked into this image. Provision them per VM after cloning."
}
$manifestPath = [IO.Path]::ChangeExtension($OutputQcow2, ".build.json")
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Set-Content -LiteralPath "$OutputQcow2.sha256" -Value "$sha256  $(Split-Path -Leaf $OutputQcow2)" -Encoding ASCII

Write-Host ""
Write-Host "Golden Image built: $OutputQcow2" -ForegroundColor Green
Write-Host "SHA-256: $sha256"
Write-Host "Build metadata: $manifestPath"
Write-Host "Fill osVersion in the build metadata and publish the qcow2 through your internal image URL."
