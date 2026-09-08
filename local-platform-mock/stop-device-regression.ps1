$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $projectRoot "runtime\device-regression.pid"
if (!(Test-Path $pidFile)) { Write-Host "device regression is not running"; exit 0 }
$processId = [int](Get-Content -Raw $pidFile)
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($process) { Stop-Process -Id $processId -Force }
Remove-Item -LiteralPath $pidFile -Force
Write-Host "device regression stopped: $processId"
