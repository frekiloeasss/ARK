param(
    [int]$Port = 3307,
    [string]$MysqlBase = "D:\study\Mysql\mysql-8.4.8-winx64",
    [string]$Database = "AFK",
    [string]$User = "afk_local",
    [string]$Password = "afk-local-only"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$runtime = Join-Path $root "runtime\mysql"
$data = Join-Path $runtime "data"
$statePath = Join-Path $runtime "state.json"
$mysqld = Join-Path $MysqlBase "bin\mysqld.exe"
$mysql = Join-Path $MysqlBase "bin\mysql.exe"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

function Get-ListenerProcessId {
    param([int]$LocalPort)
    $listener = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($listener) { return [int]$listener.OwningProcess }
    foreach ($line in (& netstat.exe -ano -p TCP)) {
        $fields = @($line.Trim() -split '\s+')
        if ($fields.Count -ge 5 -and $fields[0] -eq "TCP" -and
            $fields[1] -match ":$LocalPort$" -and $fields[3] -eq "LISTENING") {
            return [int]$fields[4]
        }
    }
    return $null
}

if (-not (Test-Path -LiteralPath $mysqld)) { throw "mysqld not found: $mysqld" }
if (-not (Test-Path -LiteralPath (Join-Path $data "mysql"))) {
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    & $mysqld --no-defaults --initialize-insecure "--basedir=$MysqlBase" "--datadir=$data" --console
    if ($LASTEXITCODE -ne 0) { throw "Portable MySQL initialization failed." }
}

$listenerPid = Get-ListenerProcessId -LocalPort $Port
if (-not $listenerPid) {
    $process = Start-Process -FilePath $mysqld -ArgumentList @(
        "--no-defaults", "--basedir=$MysqlBase", "--datadir=$data", "--port=$Port",
        "--bind-address=127.0.0.1", "--mysqlx=0", "--skip-log-bin",
        "--pid-file=$(Join-Path $runtime 'mysqld.pid')", "--log-error=$(Join-Path $runtime 'mysqld.err')"
    ) -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if (Get-ListenerProcessId -LocalPort $Port) { break }
        if ($process.HasExited) { throw "Portable MySQL exited during startup." }
    }
} else {
    $process = Get-Process -Id $listenerPid -ErrorAction Stop
    if ($process.ProcessName -ne "mysqld") {
        throw "Port $Port belongs to unexpected process $($process.ProcessName) ($($process.Id))."
    }
}

if (-not (Get-ListenerProcessId -LocalPort $Port)) { throw "Portable MySQL did not open port $Port." }
& $mysql --protocol=TCP -h 127.0.0.1 -P $Port -u root -e "CREATE DATABASE IF NOT EXISTS $Database CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS '$User'@'127.0.0.1' IDENTIFIED BY '$Password'; ALTER USER '$User'@'127.0.0.1' IDENTIFIED BY '$Password'; GRANT ALL PRIVILEGES ON $Database.* TO '$User'@'127.0.0.1'; FLUSH PRIVILEGES;"
if ($LASTEXITCODE -ne 0) { throw "Portable MySQL account bootstrap failed." }

$env:AFK_DB_HOST = "127.0.0.1"
$env:AFK_DB_PORT = [string]$Port
$env:AFK_DB_USER = $User
$env:AFK_DB_PASSWORD = $Password
$env:AFK_DB_NAME = $Database
Push-Location $root
try { npm run db:migrate } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "AFK schema migration failed." }

$state = [ordered]@{ pid=$process.Id; port=$Port; host="127.0.0.1"; database=$Database; user=$User; started_at=(Get-Date).ToString("o"); data=$data }
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
$state | ConvertTo-Json -Compress
