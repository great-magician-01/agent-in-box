param(
  [int]$Port = 14444,
  [Parameter(Mandatory = $true)][string[]]$Command
)
$ErrorActionPreference = 'Stop'
$client = New-Object System.Net.Sockets.TcpClient
$client.Connect('127.0.0.1', $Port)
try {
  $stream = $client.GetStream()
  $stream.ReadTimeout = 8000
  $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)
  $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::ASCII)
  $writer.NewLine = "`n"
  $writer.AutoFlush = $true
  $null = $reader.ReadLine()
  $writer.WriteLine('{"execute":"qmp_capabilities"}')
  while ($true) {
    $line = $reader.ReadLine()
    if ($line -match '"return"' -or $line -match '"error"') { break }
  }
  foreach ($c in $Command) {
    $writer.WriteLine($c)
    while ($true) {
      $line = $reader.ReadLine()
      if ($null -eq $line) { throw 'QMP connection closed' }
      if ($line -match '"return"' -or $line -match '"error"') {
        Write-Output $line
        break
      }
    }
  }
} finally {
  $client.Close()
}
