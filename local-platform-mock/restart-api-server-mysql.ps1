param(
    [string]$PublicHost = ""
)

$ErrorActionPreference = "Stop"
if (-not $PublicHost) { throw "Provide -PublicHost <public-ip-or-domain>." }
$root = $PSScriptRoot
$mysql = & (Join-Path $root "start-portable-mysql.ps1") |
    Select-Object -Last 1 |
    ConvertFrom-Json

$env:AFK_DB_ENABLED = "1"
$env:AFK_DB_HOST = "127.0.0.1"
$env:AFK_DB_PORT = [string]$mysql.port
$env:AFK_DB_USER = "afk_local"
$env:AFK_DB_PASSWORD = "afk-local-only"
$env:AFK_DB_NAME = "AFK"

$listener = Get-NetTCPConnection -State Listen -LocalPort 18080 -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($listener) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    if ($process.CommandLine -notmatch "server\.js") {
        throw "Port 18080 belongs to an unexpected process: $($process.CommandLine)"
    }
    Stop-Process -Id $listener.OwningProcess -Force
}

$node = (Get-Command node).Source
$arguments = @(
    "server.js", "--host", "0.0.0.0", "--port", "18080",
    "--https-port", "18443",
    "--https-key-file", "runtime\tls\mock-key.pem",
    "--https-cert-file", "runtime\tls\mock-cert.pem",
    "--proxy-unknown", "0", "--disable-sdk-sls", "1",
    "--local-base-url", "http://${PublicHost}:18080",
    "--sdk-base-url", "http://${PublicHost}:18080"
)
$server = Start-Process -FilePath $node -ArgumentList $arguments `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $root "runtime\server-bg.out.log") `
    -RedirectStandardError (Join-Path $root "runtime\server-bg.err.log") `
    -PassThru

@{ server_pid = $server.Id; mysql_pid = $mysql.pid; mysql_port = $mysql.port } |
    ConvertTo-Json -Compress
