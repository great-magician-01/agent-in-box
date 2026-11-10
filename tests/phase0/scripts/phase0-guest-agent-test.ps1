# End-to-end validation of the authenticated Go guest agent on the desktop VM.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'AgentInBox'
$vmDir = Join-Path $root 'vms\phase0-desktop'
$token = (Get-Content (Join-Path $vmDir 'guest-token') -Raw).Trim()
$sshScript = Join-Path $root 'tools\guest-ssh.ps1'
$baseUrl = 'http://127.0.0.1:17611'
$headers = @{ Authorization = "Bearer $token" }
# Do not put non-ASCII literals in this .ps1: Windows PowerShell 5.1 reads
# BOM-less files as the system ANSI codepage. Build the test text by codepoint.
$chinese = [string][char]0x4F60 + [string][char]0x597D
$resultPath = Join-Path $vmDir 'guest-agent-result.json'
function Invoke-AgentInput([hashtable]$Body) {
  $json = $Body | ConvertTo-Json -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Method Post -Uri "$baseUrl/v1/input" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes
}


$result = [ordered]@{
  name = 'authenticated-guest-agent-x11'
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  healthWithoutAuth = $false
  rejectedWithoutToken = $false
  capabilities = $null
  screenshotCaptured = $false
  unicodeInputVerified = $false
  guestContent = $null
  rejectedWrongToken = $false
  status = 'failed'
  error = $null
}

try {
  $health = Invoke-RestMethod -Uri "$baseUrl/healthz"
  $result.healthWithoutAuth = ($health.status -eq 'ok')

  try {
    Invoke-RestMethod -Uri "$baseUrl/v1/capabilities" | Out-Null
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 401) { $result.rejectedWithoutToken = $true }
  }

  $capabilities = Invoke-RestMethod -Uri "$baseUrl/v1/capabilities" -Headers $headers
  $result.capabilities = ($capabilities | ConvertTo-Json -Compress)
  if (-not ($capabilities.screenshot -and $capabilities.input -and $capabilities.unicodeInput)) {
    throw "Guest agent capabilities incomplete: $($result.capabilities)"
  }

  $desktop = Invoke-RestMethod -Uri "$baseUrl/v1/desktop" -Headers $headers
  Write-Host "Guest desktop: $($desktop.displayServer) $($desktop.width)x$($desktop.height)"

  $screenshot = Join-Path $vmDir 'guest-agent-desktop.png'
  Invoke-WebRequest -Uri "$baseUrl/v1/screenshot" -Headers $headers -OutFile $screenshot
  $bytes = [System.IO.File]::ReadAllBytes($screenshot)
  if ($bytes.Length -lt 10000 -or $bytes[0] -ne 0x89 -or $bytes[1] -ne 0x50) {
    throw 'Screenshot response is not a PNG image'
  }
  $result.screenshotCaptured = $true

  & $sshScript -Command 'DISPLAY=:0 nohup xfce4-terminal --maximize >/tmp/aib-agent-terminal.log 2>&1 </dev/null &' | Out-Null
  Start-Sleep -Seconds 4

  $click = @{ type = 'click'; point = @{ x = 640; y = 400 } } | ConvertTo-Json -Compress
  Invoke-AgentInput @{ type = 'click'; point = @{ x = 640; y = 400 } } | Out-Host

  $text = "echo $chinese-Agent-in-Box > /tmp/aib-guest-agent-unicode.txt"
  $typeBody = @{ type = 'type_text'; text = $text } | ConvertTo-Json -Compress
  Invoke-AgentInput @{ type = 'type_text'; text = $text } | Out-Host
  $enter = @{ type = 'keypress'; keys = @('enter') } | ConvertTo-Json -Compress
  Invoke-AgentInput @{ type = 'keypress'; keys = @('enter') } | Out-Host
  Start-Sleep -Seconds 2

  $expected = "$chinese-Agent-in-Box"
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $expectedBytes = [System.Text.Encoding]::UTF8.GetBytes($expected + "`n")
  $expectedHash = [BitConverter]::ToString($sha.ComputeHash($expectedBytes)).Replace('-', '').ToLowerInvariant()
  $remote = & $sshScript -Command 'sha256sum /tmp/aib-guest-agent-unicode.txt'
  $remoteText = ($remote -join ' ').Trim()
  $result.guestSha256 = $remoteText
  $result.expectedSha256 = $expectedHash
  if ($remoteText.StartsWith($expectedHash)) { $result.unicodeInputVerified = $true }
  $result.guestContent = "verified-by-sha256"

  $after = Join-Path $vmDir 'guest-agent-after.png'
  Invoke-WebRequest -Uri "$baseUrl/v1/screenshot" -Headers $headers -OutFile $after

  try {
    Invoke-RestMethod -Method Post -Uri "$baseUrl/v1/input" -Headers @{ Authorization = 'Bearer wrong' } -ContentType 'application/json' -Body $click | Out-Null
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 401) { $result.rejectedWrongToken = $true }
  }

  if ($result.healthWithoutAuth -and $result.rejectedWithoutToken -and $result.screenshotCaptured -and $result.unicodeInputVerified -and $result.rejectedWrongToken) {
    $result.status = 'passed'
  }
} catch {
  $result.error = $_.Exception.Message
  Write-Error $_
} finally {
  $result.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  $result | ConvertTo-Json -Depth 5 | Set-Content -Path $resultPath -Encoding UTF8
  Write-Host "Result written to $resultPath"
}
