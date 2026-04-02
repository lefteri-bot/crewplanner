$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Schelle Crew Planner.lnk'

# Edge path fallback
$edgeCandidates = @(
  Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe',
  Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe'
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) {
  $cmd = Get-Command msedge.exe -ErrorAction SilentlyContinue
  if ($cmd) { $edge = $cmd.Source }
}
if (-not $edge) { throw "Edge (msedge.exe) niet gevonden." }

# Create shortcut
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($lnkPath)
$sc.TargetPath = $edge
$sc.Arguments = '--app=http://localhost:3000/ --new-window'
$sc.WorkingDirectory = $root
$iconPath = Join-Path $root 'frontend\icons\app.ico'
if (Test-Path $iconPath) { $sc.IconLocation = "$iconPath,0" }
$sc.Save()

Write-Host "✅ Bureaublad icoon gemaakt: $lnkPath"
