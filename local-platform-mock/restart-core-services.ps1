param(
    [string]$PublicHost = "",
    [string]$PythonExe = "D:\study\ShadowBot\shadowbot-6.0.30\python310\python.exe",
    [string]$ClientPackage = "com.lilithgame.hgame.gp",
    [string]$ClientVersion = "1.201.01.360409"
)

$ErrorActionPreference = "Stop"
if (-not $PublicHost) { throw "Provide -PublicHost <public-ip-or-domain>." }
$root = $PSScriptRoot
$runtime = Join-Path $root "runtime"

function Get-ListenerProcessId {
    param([int]$LocalPort)
    $listener = Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue |
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

function Stop-ValidatedListener {
    param([int]$Port, [string[]]$AllowedNames)
    $listenerPid = Get-ListenerProcessId -LocalPort $Port
    if (-not $listenerPid) { return }
    $process = Get-Process -Id $listenerPid -ErrorAction Stop
    if ($AllowedNames -notcontains $process.ProcessName) {
        throw "Port $Port belongs to unexpected process $($process.ProcessName) ($($process.Id))."
    }
    Stop-Process -Id $process.Id -Force
    Wait-Process -Id $process.Id -Timeout 8 -ErrorAction SilentlyContinue
}

Stop-ValidatedListener -Port 18080 -AllowedNames @("node")
Stop-ValidatedListener -Port 15007 -AllowedNames @("python", "python3")
Stop-ValidatedListener -Port 15008 -AllowedNames @("python", "python3")

$mysql = & (Join-Path $root "start-portable-mysql.ps1") | Select-Object -Last 1 | ConvertFrom-Json
$env:AFK_DB_ENABLED = "1"
$env:AFK_DB_HOST = "127.0.0.1"
$env:AFK_DB_PORT = [string]$mysql.port
$env:AFK_DB_USER = "afk_local"
$env:AFK_DB_PASSWORD = "afk-local-only"
$env:AFK_DB_NAME = "AFK"
$env:AFK_MOCK_INTERNAL_BASE_URL = "http://127.0.0.1:18080"
$env:AFK_IM_PUBLIC_URL = "ws://${PublicHost}:15007/im"
$env:AFK_CLIENT_PACKAGE = $ClientPackage
$env:AFK_CLIENT_VERSION = $ClientVersion

$node = (Get-Command node).Source
$api = Start-Process -FilePath $node -ArgumentList @(
    "server.js", "--host", "0.0.0.0", "--port", "18080",
    "--https-port", "18443", "--https-key-file", "runtime\tls\mock-key.pem",
    "--https-cert-file", "runtime\tls\mock-cert.pem", "--proxy-unknown", "0",
    "--disable-sdk-sls", "1", "--local-base-url", "http://${PublicHost}:18080",
    "--sdk-base-url", "http://${PublicHost}:18080"
) -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $runtime "server-bg.out.log") `
  -RedirectStandardError (Join-Path $runtime "server-bg.err.log") -PassThru

$gateway = Start-Process -FilePath $PythonExe -ArgumentList @(
    "-u", "websocket_proxy.py", "--listen-host", "0.0.0.0", "--listen-port", "15007",
    "--tls-listen-port", "15443", "--tls-cert-file", "runtime\tls\gateway-cert.pem",
    "--tls-key-file", "runtime\tls\gateway-key.pem", "--upstream-url", "ws://148.178.21.210:15007",
    "--structured-login-fixture", "data\fixtures\ws-login-timeline-1.json",
    "--interaction-fixture", "data\fixtures\ws-interactions-stage-battle-1.json"
) -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $runtime "websocket-proxy.out.log") `
  -RedirectStandardError (Join-Path $runtime "websocket-proxy.err.log") -PassThru

$im = Start-Process -FilePath $PythonExe -ArgumentList @(
    "-u", "im_websocket_server.py", "--listen-host", "0.0.0.0", "--listen-port", "15008",
    "--api-base-url", "http://127.0.0.1:18080"
) -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $runtime "im-websocket.out.log") `
  -RedirectStandardError (Join-Path $runtime "im-websocket.err.log") -PassThru

$proxy = $null
$proxyListenerPid = Get-ListenerProcessId -LocalPort 8082
if (-not $proxyListenerPid) {
    $mitmPython = Join-Path $root "runtime\mitm-venv\Scripts\python.exe"
    if (-not (Test-Path $mitmPython)) { throw "mitmproxy runtime is missing: $mitmPython" }
    $proxy = Start-Process -FilePath $mitmPython -ArgumentList @(
        "mitmproxy\run_mitmdump.py", "-s", "mitmproxy\route_to_local_mock.py",
        "--listen-host", "0.0.0.0", "--listen-port", "8082",
        "--ignore-hosts", "^(?!.*(account-global\.lilith\.com|park-m-global\.lilith\.com|lilithgame\.com|farlightgames\.com|sharesrc\.cyou|graph\.facebook\.com|34\.149\.80\.225)).*$",
        "--set", "upstream_cert=false", "--set", "ssl_insecure=true",
        "--set", "connection_strategy=lazy", "--set", "afk_mock_host=127.0.0.1",
        "--set", "afk_mock_port=18080", "--set", "afk_mock_https_port=18443"
    ) -WorkingDirectory $root -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $runtime "mitmproxy.out.log") `
      -RedirectStandardError (Join-Path $runtime "mitmproxy.err.log") -PassThru
}

Start-Sleep -Seconds 2
foreach ($entry in @(@{Port=18080; Process=$api}, @{Port=15007; Process=$gateway}, @{Port=15008; Process=$im})) {
    $listenerPid = Get-ListenerProcessId -LocalPort $entry.Port
    if ($listenerPid -ne $entry.Process.Id) {
        throw "Service PID $($entry.Process.Id) did not listen on port $($entry.Port)."
    }
}
if ($proxy) {
    $proxyListenerPid = Get-ListenerProcessId -LocalPort 8082
    if ($proxyListenerPid -ne $proxy.Id) { throw "mitmproxy PID $($proxy.Id) did not listen on port 8082." }
}

$statePath = Join-Path $runtime "stack.json"
$state = if (Test-Path $statePath) { Get-Content $statePath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$state | Add-Member -NotePropertyName mock_pid -NotePropertyValue $api.Id -Force
$state | Add-Member -NotePropertyName ws_pid -NotePropertyValue $gateway.Id -Force
$state | Add-Member -NotePropertyName im_pid -NotePropertyValue $im.Id -Force
$state | Add-Member -NotePropertyName proxy_pid -NotePropertyValue $(if ($proxy) { $proxy.Id } else { $proxyListenerPid }) -Force
$state | Add-Member -NotePropertyName mysql_pid -NotePropertyValue $mysql.pid -Force
$resourceListenerPid = Get-ListenerProcessId -LocalPort 6505
if ($resourceListenerPid) {
    $state | Add-Member -NotePropertyName resource_pid -NotePropertyValue $resourceListenerPid -Force
}
$state | Add-Member -NotePropertyName im_listen_port -NotePropertyValue 15008 -Force
$state | Add-Member -NotePropertyName im_stdout -NotePropertyValue (Join-Path $runtime "im-websocket.out.log") -Force
$state | Add-Member -NotePropertyName im_stderr -NotePropertyValue (Join-Path $runtime "im-websocket.err.log") -Force
$state | Add-Member -NotePropertyName client_package -NotePropertyValue $ClientPackage -Force
$state | Add-Member -NotePropertyName client_version -NotePropertyValue $ClientVersion -Force
$state | Add-Member -NotePropertyName public_host -NotePropertyValue $PublicHost -Force
$state | Add-Member -NotePropertyName started_at -NotePropertyValue (Get-Date).ToString("o") -Force
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

$health = Invoke-RestMethod "http://127.0.0.1:18080/__afk/health"
@{
    ok = [bool]$health.ok
    api_pid = $api.Id
    gateway_pid = $gateway.Id
    im_pid = $im.Id
    mysql_pid = $mysql.pid
    proxy_pid = if ($proxy) { $proxy.Id } else { $proxyListenerPid }
} | ConvertTo-Json -Compress
