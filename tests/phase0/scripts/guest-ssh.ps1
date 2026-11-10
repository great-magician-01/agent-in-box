param(
  [Parameter(Mandatory = $true)][string]$Command,
  [int]$Port = 10023,
  [string]$Vm = 'phase0-desktop'
)
$ErrorActionPreference = 'Continue'
$root = Join-Path $env:LOCALAPPDATA 'AgentInBox'
$key = Join-Path $root "vms\$Vm\id_ed25519"
& ssh.exe -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ConnectTimeout=8 -o BatchMode=yes -p $Port -i $key "aib@127.0.0.1" $Command 2>$null
exit $LASTEXITCODE
