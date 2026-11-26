$ErrorActionPreference = 'SilentlyContinue'
$url = 'http://127.0.0.1:4747'
$appDir = $PSScriptRoot
$serverScript = Join-Path $appDir 'src\server.mjs'
$electronExe = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
$electronMain = Join-Path $appDir 'electron\main.cjs'
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }

function Test-QDirServer {
  try {
    $res = Invoke-WebRequest -Uri "$url/api/drives" -UseBasicParsing -TimeoutSec 1
    return ($res.StatusCode -eq 200)
  } catch {
    return $false
  }
}

if (-not (Test-QDirServer)) {
  Start-Process -FilePath $nodeExe `
    -ArgumentList "`"$serverScript`"" `
    -WorkingDirectory $appDir `
    -WindowStyle Hidden

  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 200
    if (Test-QDirServer) { break }
  }
}

if ((Test-Path $electronExe) -and (Test-Path $electronMain)) {
  Start-Process -FilePath $electronExe `
    -ArgumentList "`"$electronMain`"" `
    -WorkingDirectory $appDir
} else {
  Start-Process $url
}
