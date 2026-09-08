param([Parameter(Mandatory=$true)][string]$BackupPath, [switch]$ConfirmRestore)
$ErrorActionPreference = "Stop"
if (-not $ConfirmRestore) { throw "Restore overwrites AFK database state. Re-run with -ConfirmRestore." }
$root = (Resolve-Path $PSScriptRoot).Path
$backupRoot = (Resolve-Path (Join-Path $root "runtime\backups")).Path
$resolved = (Resolve-Path -LiteralPath $BackupPath).Path
if (-not $resolved.StartsWith($backupRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Backup must be inside $backupRoot" }
if ([IO.Path]::GetExtension($resolved) -ne ".sql") { throw "Backup must be a .sql file." }
$state = Get-Content (Join-Path $root "runtime\mysql\state.json") -Raw | ConvertFrom-Json
$mysql = "D:\study\Mysql\mysql-8.4.8-winx64\bin\mysql.exe"
& $mysql --protocol=TCP -h 127.0.0.1 -P $state.port -u root -e "DROP DATABASE IF EXISTS AFK; CREATE DATABASE AFK CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL PRIVILEGES ON AFK.* TO 'afk_local'@'127.0.0.1'; FLUSH PRIVILEGES;"
if ($LASTEXITCODE -ne 0) { throw "Failed to recreate AFK database." }
$import = Start-Process -FilePath $mysql -ArgumentList @("--binary-mode=1","--skip-commands","--protocol=TCP","-h","127.0.0.1","-P",[string]$state.port,"-u","afk_local","-pafk-local-only","-D","AFK") -RedirectStandardInput $resolved -WindowStyle Hidden -Wait -PassThru
if ($import.ExitCode -ne 0) { throw "Database restore failed." }
Write-Host "Restored AFK from $resolved"
