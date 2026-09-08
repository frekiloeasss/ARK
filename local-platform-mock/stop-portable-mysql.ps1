param([string]$Password = "afk-local-only")
$ErrorActionPreference = "Stop"
$statePath = Join-Path $PSScriptRoot "runtime\mysql\state.json"
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host "Portable MySQL state not found."; exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$admin = "D:\study\Mysql\mysql-8.4.8-winx64\bin\mysqladmin.exe"
try { & $admin --protocol=TCP -h 127.0.0.1 -P $state.port -u afk_local "-p$Password" shutdown } catch {}
Start-Sleep -Seconds 1
if (Get-Process -Id $state.pid -ErrorAction SilentlyContinue) { Stop-Process -Id $state.pid -Force }
Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
Write-Host "Portable MySQL stopped. Data retained at $($state.data)."
