# Non-elevated, read-only Hyper-V availability probe. It does not enable any
# Windows feature, does not start/stop services, and does not modify the system.
param(
  [string]$ResultJson = ''
)
$ErrorActionPreference = 'Continue'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$root = Join-Path $env:LOCALAPPDATA 'AgentInBox'
$logDir = Join-Path $root "stability-logs\hyperv-$stamp"
New-Item -ItemType Directory -Force $logDir | Out-Null
if ($ResultJson -eq '') { $ResultJson = Join-Path $logDir 'summary.json' }

function Try-Read([scriptblock]$Block) {
  try {
    return [ordered]@{ ok = $true; value = (& $Block); error = $null }
  } catch {
    return [ordered]@{ ok = $false; value = $null; error = $_.Exception.Message }
  }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$version = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'

$optionalFeatures = @()
try {
  $optionalFeatures = @(Get-CimInstance Win32_OptionalFeature |
    Where-Object { $_.Name -like 'Microsoft-Hyper-V*' } |
    Select-Object Name, InstallState)
} catch { }

$hyperVModules = @()
try { $hyperVModules = @(Get-Module -ListAvailable Hyper-V) } catch { }

$services = @()
foreach ($name in @('vmms', 'vmcompute', 'HvHost')) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($null -ne $service) {
    $services += [ordered]@{ name = $name; status = [string]$service.Status; startType = [string]$service.StartType }
  } else {
    $services += [ordered]@{ name = $name; status = 'missing'; startType = 'missing' }
  }
}

$vmmsExe = Join-Path $env:SystemRoot 'System32\vmms.exe'
$wmiProbe = $null
try {
  $vmms = Get-CimInstance -Namespace 'root\virtualization\v2' -ClassName Msvm_ComputerSystem -ErrorAction Stop
  $wmiProbe = [ordered]@{ ok = $true; count = @($vmms).Count; error = $null }
} catch {
  $wmiProbe = [ordered]@{ ok = $false; count = 0; error = $_.Exception.Message }
}

$windowsFeatureProbe = $null
try {
  $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -ErrorAction Stop
  $windowsFeatureProbe = [ordered]@{ ok = $true; state = [string]$feature.State; error = $null }
} catch {
  $windowsFeatureProbe = [ordered]@{ ok = $false; state = $null; error = $_.Exception.Message }
}

$systemInfo = @()
try { $systemInfo = @(systeminfo.exe | Select-Object -Last 12) } catch { }

$hyperVUsable = ($services | Where-Object { $_.name -eq 'vmms' -and $_.status -ne 'missing' -and $_.status -ne 'stopped' }).Count -gt 0
$vmmsPresent = (Test-Path $vmmsExe)
$edition = [string]$version.EditionID
$isHomeEdition = $edition -match 'Core'

$summary = [ordered]@{
  script = 'phase0-stability-hyperv.ps1'
  runId = "2026-11-10-h1-whpx-hyperv-availability-$stamp"
  hostProfile = 'H1'
  recordedAt = (Get-Date).ToUniversalTime().ToString('o')
  elevated = $isElevated
  os = [ordered]@{
    caption = [string]$os.Caption
    version = [string]$os.Version
    build = [string]$os.BuildNumber
    productType = [int]$os.ProductType
    productName = [string]$version.ProductName
    editionId = $edition
    displayVersion = [string]$version.DisplayVersion
    ubr = [int]$version.UBR
  }
  hypervisorPresent = [bool]$computer.HypervisorPresent
  cpu = [ordered]@{
    name = [string]$cpu.Name
    virtualizationFirmwareEnabled = $cpu.VirtualizationFirmwareEnabled
    vmMonitorModeExtensions = $cpu.VMMonitorModeExtensions
    slat = $cpu.SecondLevelAddressTranslationExtensions
  }
  optionalHyperVFeatures = @($optionalFeatures)
  hyperVManagementModules = @($hyperVModules | ForEach-Object { [ordered]@{ name = $_.Name; version = [string]$_.Version; path = [string]$_.Path } })
  services = @($services)
  vmmsExePresent = $vmmsPresent
  hyperVWMIV2 = $wmiProbe
  getWindowsOptionalFeature = $windowsFeatureProbe
  systeminfoTail = @($systemInfo)
  conclusion = [ordered]@{
    editionLooksHome = [bool]$isHomeEdition
    vmmsServiceUsable = [bool]$hyperVUsable
    hyperVProviderValidationPossible = [bool]($hyperVUsable -and $vmmsPresent -and $wmiProbe.ok)
    limitation = $null
  }
}
if (-not $summary.conclusion.hyperVProviderValidationPossible) {
  $summary.conclusion.limitation = 'This host is Windows 11 Home (CoreCountrySpecific). Hyper-V management service vmms, the Hyper-V WMI v2 namespace and Hyper-V optional features are absent, so a Hyper-V Provider cannot be validated here without changing the Windows edition/features. HvHost and vmcompute are present for virtualization-based security, not as a Hyper-V management stack. A Windows 11 Pro/Enterprise host is required.'
}
$summary | ConvertTo-Json -Depth 10 | Set-Content -Path $ResultJson -Encoding UTF8
Write-Host "summary written to $ResultJson"
Write-Host ("hyperVProviderValidationPossible={0}" -f $summary.conclusion.hyperVProviderValidationPossible)
