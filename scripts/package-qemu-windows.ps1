# Build a relocatable Windows QEMU toolchain from MSYS2 UCRT64.
# Run on a Windows build machine (or GitHub Actions windows-latest).
# The resulting archive contains bin/ and share/qemu/, matching the layout
# expected by the VM Supervisor and QemuToolchainManager.
param(
  [string]$OutputDirectory = "release/qemu",
  [string]$Version = "11.1.3"
)

$ErrorActionPreference = "Stop"
$repository = Split-Path -Parent $PSScriptRoot
$msysRoot = $env:MSYS2_ROOT
if (-not $msysRoot) { $msysRoot = "C:\msys64" }
if (-not (Test-Path (Join-Path $msysRoot "usr\bin\bash.exe"))) {
  throw "MSYS2 not found at $msysRoot; set MSYS2_ROOT or install MSYS2"
}

$bash = Join-Path $msysRoot "usr\bin\bash.exe"
& $bash -lc "pacman -S --noconfirm --needed mingw-w64-ucrt-x86_64-qemu"
if ($LASTEXITCODE -ne 0) { throw "pacman failed to install QEMU" }

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$staging = Join-Path $tempRoot "agent-in-box-qemu-staging"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
$qemuRoot = Join-Path $staging "qemu"
New-Item -ItemType Directory -Force -Path (Join-Path $qemuRoot "bin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $qemuRoot "share") | Out-Null

$ucrtBin = Join-Path $msysRoot "ucrt64\bin"
foreach ($name in @("qemu-system-x86_64.exe", "qemu-img.exe")) {
  Copy-Item -LiteralPath (Join-Path $ucrtBin $name) -Destination (Join-Path $qemuRoot "bin\$name")
}
# QEMU's MSYS2 build depends on mingw runtime DLLs. Shipping the UCRT64 DLLs
# keeps the archive self-contained and avoids requiring MSYS2 on user machines.
Get-ChildItem -LiteralPath $ucrtBin -Filter *.dll | Copy-Item -Destination (Join-Path $qemuRoot "bin")
Copy-Item -Recurse -Force -LiteralPath (Join-Path $msysRoot "ucrt64\share\qemu") -Destination (Join-Path $qemuRoot "share\qemu")

$license = Join-Path $qemuRoot "QEMU-LICENSE.txt"
@"
QEMU is distributed under the GNU General Public License version 2 (or later).
Source code and build scripts: https://www.qemu.org/ and https://github.com/msys2/MINGW-packages
This archive is assembled from the MSYS2 UCRT64 package for local VM execution.
"@ | Set-Content -Encoding UTF8 $license

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputAbsolute = (Resolve-Path $OutputDirectory).Path
$archive = Join-Path $outputAbsolute "qemu-windows-x64.tar.gz"
if (Test-Path $archive) { Remove-Item -Force $archive }
Push-Location $staging
try {
  tar -czf $archive "qemu"
  if ($LASTEXITCODE -ne 0) { throw "tar failed" }
} finally {
  Pop-Location
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $archive).Length
@"
$hash  qemu-windows-x64.tar.gz
"@ | Set-Content -Encoding ASCII "$archive.sha256"
[ordered]@{
  version = $Version
  url = "https://github.com/great-magician-01/agent-in-box/releases/latest/download/qemu-windows-x64.tar.gz"
  sha256 = $hash
  sizeBytes = $size
} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $OutputDirectory "qemu-windows-x64.json")

Write-Host "QEMU toolchain packaged: $archive ($size bytes, sha256 $hash)"
