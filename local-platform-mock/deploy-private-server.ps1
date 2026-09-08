param(
    [string]$Serial = "127.0.0.1:16384",
    [string]$AdbPath = "D:\study\MuMuPlayer\nx_device\12.0\shell\adb.exe",
    [ValidateSet("1.182", "1.201")]
    [string]$ClientTrack = "1.182",
    [string]$PublicHost = "198.18.0.1",
    [switch]$NoSupervisor
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$runtimeDir = Join-Path $root "runtime"
$secretPath = Join-Path $runtimeDir "private-server-secrets.json"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
function New-PrivateSecret {
    $bytes = [byte[]]::new(32)
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}
if (Test-Path -LiteralPath $secretPath) {
    $privateSecrets = Get-Content -LiteralPath $secretPath -Raw | ConvertFrom-Json
} else {
    $privateSecrets = [pscustomobject]@{
        admin_user = "admin"
        admin_password = New-PrivateSecret
        payment_secret = New-PrivateSecret
        generated_at = (Get-Date).ToUniversalTime().ToString("o")
    }
    $privateSecrets | ConvertTo-Json | Set-Content -LiteralPath $secretPath -Encoding UTF8
}
$opsState = Join-Path $root "runtime\ops-supervisor.json"
if (Test-Path -LiteralPath $opsState) {
    $existingOps = Get-Content -LiteralPath $opsState -Raw | ConvertFrom-Json
    Stop-Process -Id $existingOps.pid -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $opsState -Force -ErrorAction SilentlyContinue
}
$mysql = & (Join-Path $root "start-portable-mysql.ps1") | Select-Object -Last 1 | ConvertFrom-Json
$env:AFK_DB_ENABLED = "1"
$env:AFK_DB_HOST = "127.0.0.1"
$env:AFK_DB_PORT = [string]$mysql.port
$env:AFK_DB_USER = "afk_local"
$env:AFK_DB_PASSWORD = "afk-local-only"
$env:AFK_DB_NAME = "AFK"
if (-not $env:AFK_ADMIN_USER) { $env:AFK_ADMIN_USER = [string]$privateSecrets.admin_user }
if (-not $env:AFK_ADMIN_PASSWORD) { $env:AFK_ADMIN_PASSWORD = [string]$privateSecrets.admin_password }
if (-not $env:AFK_PAYMENT_SECRET) { $env:AFK_PAYMENT_SECRET = [string]$privateSecrets.payment_secret }
$env:AFK_ROTATE_BOOTSTRAP_ADMIN = "1"
$clientPackage = "cyou.sharesrc.afk.release146"
$clientVersion = "1.182.03.301371"
$clientApk = Join-Path (Split-Path $root -Parent) "artifacts\afkdragon\base.apk"
$resourceRoot = ""
if ($ClientTrack -eq "1.201") {
    $latestRoot = Join-Path $root "runtime\official-updates\1.201.01"
    $clientPackage = "com.lilithgame.hgame.gp"
    $clientVersion = "1.201.01.360409"
    $clientApk = Join-Path $latestRoot "xapk\com.lilithgame.hgame.gp.apk"
    $resourceRoot = Join-Path $latestRoot "official-assets\extraAsset\assets\classic"
    $env:AFK_PROTOCOL_ROUTE_MAP = Join-Path $latestRoot "protocol\protocol-route-map.json"
    $env:AFK_PROTOBUF_SCHEMA = Join-Path $latestRoot "protocol\protobuf-schema.json"
    $env:AFK_PROTOCOL_COVERAGE = Join-Path $latestRoot "protocol\protocol-coverage.json"
} else {
    Remove-Item Env:\AFK_PROTOCOL_ROUTE_MAP -ErrorAction SilentlyContinue
    Remove-Item Env:\AFK_PROTOBUF_SCHEMA -ErrorAction SilentlyContinue
    Remove-Item Env:\AFK_PROTOCOL_COVERAGE -ErrorAction SilentlyContinue
}
$env:AFK_CLIENT_VERSION = $clientVersion
$env:AFK_CLIENT_PACKAGE = $clientPackage
$env:AFK_DISABLE_AUTO_LOGIN = "0"
$clientStart = @{
    PublicHost = $PublicHost; ListenHost = "0.0.0.0"; ResourceListenHost = "0.0.0.0"; UseMysql = $true; NoUpstreamProxy = $true
    Serial = $Serial; AdbPath = $AdbPath; UseIptablesRedirect = $true; RedirectHost = "127.0.0.1"
    Package = $clientPackage; ClientVersion = $clientVersion; ApkPath = $clientApk
    ResourceCacheRoot = Join-Path $runtimeDir ("resource-cache-" + $ClientTrack)
}
if ($resourceRoot) {
    $clientStart.ResourceVersionRoot = $latestRoot
    $clientStart.ResourceExtractedRoot = $resourceRoot
    $clientStart.ResourceExtraRoot = $resourceRoot
}
& (Join-Path $root "start-local-private-server.ps1") @clientStart
& $AdbPath -s $Serial reverse "tcp:8082" "tcp:8082"
if ($LASTEXITCODE -ne 0) { throw "failed to configure ADB reverse for the HTTP proxy" }
& $AdbPath -s $Serial shell settings put global http_proxy "127.0.0.1:8082"
if ($LASTEXITCODE -ne 0) { throw "failed to configure the emulator HTTP proxy" }
& $AdbPath -s $Serial root | Out-Null
$fridaServerLocal = Join-Path $root "runtime\frida-server-x86_64"
if (Test-Path -LiteralPath $fridaServerLocal) {
    & $AdbPath -s $Serial push $fridaServerLocal "/data/local/tmp/frida-server" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "failed to install frida-server on the test device" }
    & $AdbPath -s $Serial shell chmod 755 /data/local/tmp/frida-server
}
& $AdbPath -s $Serial shell test -x /data/local/tmp/frida-server
if ($LASTEXITCODE -ne 0) { throw "frida-server is missing; provide runtime\frida-server-x86_64" }
& $AdbPath -s $Serial shell "pidof frida-server >/dev/null || (nohup /data/local/tmp/frida-server -l 0.0.0.0:27042 >/data/local/tmp/frida-server.log 2>&1 &)"
& $AdbPath -s $Serial forward "tcp:27042" "tcp:27042"
$python311 = Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"
if (-not (Test-Path -LiteralPath $python311)) { throw "Python 3.11 with Frida is required for the instant payment bridge: $python311" }
$instantPayBridge = Start-Process -FilePath $python311 `
    -ArgumentList @((Join-Path $root "scripts\afk-instant-pay-bridge.py"), "--host", "127.0.0.1:27042", "--base-url", "http://127.0.0.1:18080", "--package", $clientPackage) `
    -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $root "runtime\instant-pay-bridge.out.log") `
    -RedirectStandardError (Join-Path $root "runtime\instant-pay-bridge.err.log") `
    -WindowStyle Hidden -PassThru
$stackPath = Join-Path $root "runtime\stack.json"
$stack = Get-Content $stackPath -Raw | ConvertFrom-Json
$stack | Add-Member -NotePropertyName mysql_pid -NotePropertyValue $mysql.pid -Force
$stack | Add-Member -NotePropertyName mysql_port -NotePropertyValue $mysql.port -Force
$stack | Add-Member -NotePropertyName deployment -NotePropertyValue "complete-private-server" -Force
$stack | Add-Member -NotePropertyName client_track -NotePropertyValue $ClientTrack -Force
$stack | Add-Member -NotePropertyName public_host -NotePropertyValue $PublicHost -Force
$stack | Add-Member -NotePropertyName instant_pay_bridge_pid -NotePropertyValue $instantPayBridge.Id -Force
$stack | ConvertTo-Json | Set-Content -LiteralPath $stackPath -Encoding UTF8
if (-not $NoSupervisor) {
    $existing = if (Test-Path $opsState) { Get-Content $opsState -Raw | ConvertFrom-Json } else { $null }
    if (-not $existing -or -not (Get-Process -Id $existing.pid -ErrorAction SilentlyContinue)) {
        $node = (Get-Command node).Source
        $ops = Start-Process -FilePath $node -ArgumentList @((Join-Path $root "scripts\ops-supervisor.js"), "--root", $root, "--client-track", $ClientTrack, "--public-host", $PublicHost) -WorkingDirectory $root -RedirectStandardOutput (Join-Path $root "runtime\ops-supervisor.out.log") -RedirectStandardError (Join-Path $root "runtime\ops-supervisor.err.log") -WindowStyle Hidden -PassThru
        @{pid=$ops.Id;started_at=(Get-Date).ToString("o")} | ConvertTo-Json | Set-Content -LiteralPath $opsState -Encoding UTF8
    }
}
Write-Host "AFK complete private-server deployment is running with MySQL persistence."
Write-Host "Private admin credentials are stored at: $secretPath"
