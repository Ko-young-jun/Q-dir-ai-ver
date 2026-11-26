<#
.SYNOPSIS
  Q-Dir AI 원클릭 설치 및 AI 클라이언트(MCP) 자동 연동 스크립트
#>
$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$mcpScript = Join-Path $appDir 'src\mcp-server.mjs'
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  Write-Host "[오류] Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 먼저 설치해 주세요." -ForegroundColor Red
  exit 1
}

Write-Host "1/3. Node.js 패키지 설치 중..." -ForegroundColor Cyan
Push-Location $appDir
npm install
Pop-Location

Write-Host "`n2/3. 설치된 AI 클라이언트(Antigravity / Codex / Claude)에 qdir-ai MCP 등록 중..." -ForegroundColor Cyan
$mcpEntry = @{
  command = $nodeExe
  args = @($mcpScript)
}

function Register-JsonMcp($jsonPath, $label) {
  $dir = Split-Path $jsonPath -Parent
  if (-not (Test-Path $dir)) { return }
  $obj = @{}
  if (Test-Path $jsonPath) {
    $raw = Get-Content $jsonPath -Raw -Encoding UTF8
    if ($raw.Trim()) { $obj = $raw | ConvertFrom-Json -AsHashtable }
  }
  if (-not $obj.ContainsKey('mcpServers')) { $obj['mcpServers'] = @{} }
  $obj['mcpServers']['qdir-ai'] = $mcpEntry
  $obj | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonPath -Encoding UTF8
  Write-Host "  [완료] $label -> $jsonPath" -ForegroundColor Green
}

# Antigravity
Register-JsonMcp (Join-Path $env:USERPROFILE '.gemini\config\mcp_config.json') 'Antigravity'

# Claude Code
if (Test-Path (Join-Path $env:USERPROFILE '.claude.json')) {
  Register-JsonMcp (Join-Path $env:USERPROFILE '.claude.json') 'Claude Code'
}

# Claude Desktop (Standard & MSIX)
Register-JsonMcp (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json') 'Claude Desktop'
$msixClaude = Get-ChildItem "$env:LOCALAPPDATA\Packages\Claude_*" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
if ($msixClaude) {
  Register-JsonMcp (Join-Path $msixClaude.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json') 'Claude Desktop (MSIX)'
}

# Codex
$codexToml = Join-Path $env:USERPROFILE '.codex\config.toml'
if (Test-Path $codexToml) {
  $toml = Get-Content $codexToml -Raw -Encoding UTF8
  if ($toml -notmatch '\[mcp_servers\.qdir_ai\]' -and $toml -notmatch '\[mcp_servers\.qdir-ai\]') {
    $block = "`n[mcp_servers.qdir_ai]`ncommand = '$nodeExe'`nargs = ['$mcpScript']`n"
    Add-Content -Path $codexToml -Value $block -Encoding UTF8
  }
  Write-Host "  [완료] Codex -> $codexToml" -ForegroundColor Green
}

Write-Host "`n3/3. 바탕화면 바로가기(Q-Dir AI.lnk) 생성 중..." -ForegroundColor Cyan
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Q-Dir AI.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$sc.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$appDir\launch-qdir-ai.ps1`""
$sc.WorkingDirectory = $appDir
$sc.Description = 'Q-Dir AI - Quad File Explorer for Humans & AI'
$sc.Save()
Write-Host "  [완료] $lnkPath" -ForegroundColor Green

Write-Host "`n설치가 완료되었습니다! 바탕화면의 [Q-Dir AI]를 실행하고, 사용 중인 AI 앱을 재시작해 주세요." -ForegroundColor Yellow
Write-Host "(선택) Excel/PDF/AI 누끼 미리보기를 쓰려면 Python에서 다음을 설치하세요:" -ForegroundColor Gray
Write-Host "  pip install openpyxl pypdf pypdfium2 reportlab pillow olefile `"rembg[cpu]`"" -ForegroundColor Gray
