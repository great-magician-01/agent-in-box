# Run display/input validation against the already-running desktop VM.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'AgentInBox'
$qmpScript = Join-Path $root 'tools\qmp.ps1'
$sshScript = Join-Path $root 'tools\guest-ssh.ps1'
$vmDir = Join-Path $root 'vms\phase0-desktop'
$resultPath = Join-Path $vmDir 'input-result.json'

$result = [ordered]@{
  name = 'qemu-qmp-display-input'
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  absoluteMouseVerified = $false
  mouseLocation = $null
  keyboardCommandVerified = $false
  status = 'failed'
  error = $null
}

function Invoke-DesktopQmp([hashtable]$Body) {
  $json = $Body | ConvertTo-Json -Compress -Depth 10
  return (& $qmpScript -Port 14445 -Command $json)
}

function Send-QmpKeys([string]$KeyCode) {
  $keys = @(@{ type = 'qcode'; data = $KeyCode })
  Invoke-DesktopQmp @{ execute = 'send-key'; arguments = @{ keys = $keys } } | Out-Null
  Start-Sleep -Milliseconds 45
}

function Send-Pointer([int]$X, [int]$Y, [bool]$Click) {
  $events = @(
    @{ type = 'abs'; data = @{ axis = 'x'; value = $X } },
    @{ type = 'abs'; data = @{ axis = 'y'; value = $Y } }
  )
  if ($Click) {
    $events += @{ type = 'btn'; data = @{ button = 'left'; down = $true } }
    $events += @{ type = 'btn'; data = @{ button = 'left'; down = $false } }
  }
  Invoke-DesktopQmp @{ execute = 'input-send-event'; arguments = @{ events = $events } } | Out-Null
}

try {
  & $sshScript -Command 'DISPLAY=:0 nohup xfce4-terminal --maximize >/tmp/aib-terminal.log 2>&1 </dev/null &' | Out-Host
  Start-Sleep -Seconds 4

  Send-Pointer -X 32767 -Y 32767 -Click $false
  Start-Sleep -Milliseconds 500
  $mouse = & $sshScript -Command 'DISPLAY=:0 xdotool getmouselocation'
  $result.mouseLocation = ($mouse -join ' ').Trim()
  if ($result.mouseLocation -match 'x:(\d+) y:(\d+)') {
    $mx = [int]$Matches[1]
    $my = [int]$Matches[2]
    if ($mx -ge 1200 -and $my -ge 750) { $result.absoluteMouseVerified = $true }
  }
  Write-Host "Mouse after max abs event: $($result.mouseLocation)"

  Send-Pointer -X 16383 -Y 16383 -Click $true
  Start-Sleep -Milliseconds 500
  $command = 'touch /tmp/aib-qmp-input-ok'
  $map = @{ ' ' = 'spc'; '/' = 'slash'; '-' = 'minus'; '.' = 'dot' }
  foreach ($char in $command.ToCharArray()) {
    $name = $map[[string]$char]
    if (-not $name) { $name = [string]$char }
    Send-QmpKeys $name
  }
  Send-QmpKeys 'ret'
  Start-Sleep -Seconds 2

  $verify = & $sshScript -Command 'test -e /tmp/aib-qmp-input-ok && echo input-ok'
  $result.keyboardCommandVerified = (($verify -join ' ') -match 'input-ok')

  $after = Join-Path $vmDir 'input-after.ppm'
  Invoke-DesktopQmp @{ execute = 'screendump'; arguments = @{ filename = $after } } | Out-Host
  if ($result.absoluteMouseVerified -and $result.keyboardCommandVerified) { $result.status = 'passed' }
  Write-Host "Input verification: $verify"
} catch {
  $result.error = $_.Exception.Message
  Write-Error $_
} finally {
  $result.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  $result | ConvertTo-Json -Depth 5 | Set-Content -Path $resultPath -Encoding UTF8
  Write-Host "Result written to $resultPath"
}
