param(
    [string]$PublicHost = "",
    [string]$ListenHost = "0.0.0.0",
    [int]$MockPort = 18080,
    [int]$MockHttpsPort = 18443,
    [int]$MitmPort = 8082,
    [int]$WsPort = 15007,
    [int]$ImPort = 15008,
    [int]$WsTlsPort = 15443,
    [int]$ResourcePort = 6505,
    [string]$ResourceListenHost = "127.0.0.1",
    [string]$ResourceUpstream = "https://hgame-cdn.lilithgame.com/global/v2/",
    [switch]$ResourceOffline,
    [string]$ResourceCacheRoot = "",
    [string]$LoginFixture = "",
    [string]$InteractionFixture = "",
    [switch]$UseMysql,
    [switch]$ProxyUnknown,
    [switch]$NoMitmProxy,
    [switch]$NoWebSocketProxy,
    [long]$ForceDiamond = -1,
    [switch]$ConfigureDeviceProxy,
    [switch]$PatchDeviceWsCache,
    [switch]$UseIptablesRedirect,
    [string]$AdbPath = "D:\study\MuMuPlayer\nx_device\12.0\shell\adb.exe",
    [string]$Serial = "emulator-5554",
    [string]$Package = "cyou.sharesrc.afk.release146",
    [string]$PythonExe = "python",
    [string]$RedirectHost = "",
    [string]$ApkPath = "",
    [string]$ClientVersion = "1.182.03.301371",
    [string]$ResourceVersionRoot = "",
    [string]$ResourceExtractedRoot = "",
    [string]$ResourceTimelyRoot = "",
    [string]$ResourceExtraRoot = ""
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot

function Resolve-DefaultIPv4Address {
    $routes = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
        Sort-Object -Property RouteMetric, InterfaceMetric

    foreach ($route in $routes) {
        $addresses = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue |
            Where-Object {
                $_.IPAddress -and
                $_.IPAddress -notmatch "^(127|169\.254)\." -and
                $_.AddressState -in @("Preferred", "Tentative")
            }

        foreach ($address in $addresses) {
            return $address.IPAddress
        }
    }

    $fallback = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -and
            $_.IPAddress -notmatch "^(127|169\.254)\." -and
            $_.AddressState -in @("Preferred", "Tentative")
        } |
        Select-Object -First 1

    if ($fallback) {
        return $fallback.IPAddress
    }

    throw "Could not auto-detect a LAN IPv4 address. Re-run with -PublicHost <your-PC-IP>."
}

function Invoke-Adb {
    param([string[]]$CommandArgs)

    $adbPrefix = @()
    if ($Serial) {
        $adbPrefix += @("-s", $Serial)
    }

    & $AdbPath @adbPrefix @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "adb command failed: $($CommandArgs -join ' ')"
    }
}

if (-not $PublicHost) {
    $PublicHost = Resolve-DefaultIPv4Address
}

if (-not $RedirectHost) {
    $RedirectHost = $PublicHost
}

if (-not $LoginFixture) {
    $LoginFixture = Join-Path $root "data\fixtures\ws-login-timeline-1.json"
}
if (-not $InteractionFixture) {
    $InteractionFixture = Join-Path $root "data\fixtures\ws-interactions-stage-battle-1.json"
}

if (-not (Test-Path -LiteralPath $LoginFixture)) {
    throw "Login fixture not found: $LoginFixture"
}
if ($InteractionFixture -and -not (Test-Path -LiteralPath $InteractionFixture)) {
    throw "Interaction fixture not found: $InteractionFixture"
}

$localBaseUrl = "http://${PublicHost}:$MockPort"
$wsUrl = "ws://${PublicHost}:$WsPort"

$env:AFK_DB_ENABLED = if ($UseMysql) { "1" } else { "0" }

$startParams = @{
    MockHost = $ListenHost
    MockPort = $MockPort
    MockHttpsPort = $MockHttpsPort
    MitmPort = $MitmPort
    WsListenHost = $ListenHost
    WsListenPort = $WsPort
    ImListenPort = $ImPort
    WsTlsListenPort = $WsTlsPort
    WsStructuredLoginFixture = $LoginFixture
    LocalBaseUrl = $localBaseUrl
    SdkBaseUrl = $localBaseUrl
    ForceDiamond = $ForceDiamond
}

if ($InteractionFixture) {
    $startParams.WsInteractionFixture = $InteractionFixture
}
if (-not $ProxyUnknown) {
    $startParams.NoUpstreamProxy = $true
}
if (-not $UseMysql) {
    $startParams.NoWebSocketMysql = $true
    $startParams.NoLoginMysql = $true
    # BusinessStateProvider talks to the local HTTP service, which already has
    # an in-memory fallback. Keep it enabled so tavern/stage transactions work
    # even when no external MySQL instance is configured.
}
if ($NoMitmProxy) {
    $startParams.NoMitmProxy = $true
}
if ($NoWebSocketProxy) {
    $startParams.NoWebSocketProxy = $true
}

Write-Host "Starting AFK local private server..."
Write-Host "public host : $PublicHost"
Write-Host "http mock   : $localBaseUrl"
Write-Host "mitm proxy  : ${PublicHost}:$MitmPort"
Write-Host "websocket   : $wsUrl"
Write-Host "mysql       : $(if ($UseMysql) { 'enabled' } else { 'disabled/in-memory' })"

& (Join-Path $root "start-stack.ps1") @startParams

if (-not (Test-Path -LiteralPath $AdbPath)) {
    throw "adb not found: $AdbPath"
}

$resourceScript = Join-Path $root "scripts\resource-cache-server.js"
$resourceStdout = Join-Path $root "runtime\resource-cache.out.log"
$resourceStderr = Join-Path $root "runtime\resource-cache.err.log"
$resourceCache = if ($ResourceCacheRoot) { $ResourceCacheRoot } else { Join-Path $root "runtime\resource-cache" }
$versionRoot = if ($ResourceVersionRoot) { $ResourceVersionRoot } else { Join-Path (Split-Path $root -Parent) "artifacts\afkdragon\runtime\app_data_pull\files\1.145.01" }
$extractedRoot = if ($ResourceExtractedRoot) { $ResourceExtractedRoot } else { Join-Path $versionRoot "patch" }
$timelyRoot = if ($ResourceTimelyRoot) { $ResourceTimelyRoot } else { Join-Path $versionRoot "timely" }
$extraRoot = if ($ResourceExtraRoot) { $ResourceExtraRoot } else { Join-Path $versionRoot "extra" }
if (-not $ApkPath) {
    $ApkPath = Join-Path (Split-Path $root -Parent) "artifacts\afkdragon\base.apk"
}
$resourceArguments = @(
    $resourceScript,
    "--host", $ResourceListenHost,
    "--port", [string]$ResourcePort,
    "--adb", $AdbPath,
    "--serial", $Serial,
    "--package", $Package,
    "--cache-root", $resourceCache,
    "--version-root", $versionRoot,
    "--extracted-root", $extractedRoot,
    "--timely-root", $timelyRoot,
    "--extra-root", $extraRoot,
    "--apk", $ApkPath,
    "--upstream", $ResourceUpstream,
    "--no-device"
)
if ($ResourceOffline) {
    $resourceArguments += "--offline"
}
$resourceProcess = Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList $resourceArguments `
    -RedirectStandardOutput $resourceStdout `
    -RedirectStandardError $resourceStderr `
    -WindowStyle Hidden `
    -PassThru
Start-Sleep -Milliseconds 500
$resourceProcess.Refresh()
if ($resourceProcess.HasExited) {
    $resourceError = if (Test-Path $resourceStderr) { Get-Content $resourceStderr -Raw } else { "" }
    throw "Resource cache service exited during startup: $resourceError"
}

$stackStatePath = Join-Path $root "runtime\stack.json"
$stackState = Get-Content $stackStatePath -Raw | ConvertFrom-Json
$stackState | Add-Member -NotePropertyName resource_pid -NotePropertyValue $resourceProcess.Id -Force
$stackState | Add-Member -NotePropertyName resource_port -NotePropertyValue $ResourcePort -Force
$stackState | Add-Member -NotePropertyName resource_listen_host -NotePropertyValue $ResourceListenHost -Force
$stackState | Add-Member -NotePropertyName resource_stdout -NotePropertyValue $resourceStdout -Force
$stackState | Add-Member -NotePropertyName resource_stderr -NotePropertyValue $resourceStderr -Force
$stackState | Add-Member -NotePropertyName client_package -NotePropertyValue $Package -Force
$stackState | Add-Member -NotePropertyName client_version -NotePropertyValue $ClientVersion -Force
$stackState | Add-Member -NotePropertyName resource_version_root -NotePropertyValue $versionRoot -Force
$stackState | ConvertTo-Json | Set-Content -Path $stackStatePath -Encoding UTF8

Invoke-Adb -CommandArgs @("reverse", "tcp:$ResourcePort", "tcp:$ResourcePort")
Write-Host "resources   : http://${ResourceListenHost}:$ResourcePort (ADB reverse enabled)"

$healthUrl = "http://127.0.0.1:$MockPort/__afk/health"
try {
    $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 $healthUrl |
        Select-Object -ExpandProperty Content
    Write-Host "health      : $health"
} catch {
    Write-Host "health check failed: $($_.Exception.Message)"
}

if ($ConfigureDeviceProxy) {
    if (-not (Test-Path -LiteralPath $AdbPath)) {
        throw "adb not found: $AdbPath"
    }
    Write-Host "Configuring Android HTTP proxy on $Serial -> ${PublicHost}:$MitmPort"
    Invoke-Adb -CommandArgs @("shell", "settings put global http_proxy ${PublicHost}:$MitmPort")
}

if ($PatchDeviceWsCache) {
    Write-Host "Patching device jsb.sqlite websocket cache -> $wsUrl"
    & (Join-Path $root "set-device-ws-cache.ps1") `
        -AdbPath $AdbPath `
        -Serial $Serial `
        -Package $Package `
        -PublishedWsUrl $wsUrl `
        -PythonExe $PythonExe
}

if ($UseIptablesRedirect) {
    Write-Host "Applying device websocket DNAT redirect -> ${RedirectHost}:$WsPort"
    & (Join-Path $root "set-device-ws-redirect.ps1") `
        -AdbPath $AdbPath `
        -Serial $Serial `
        -RedirectHost $RedirectHost `
        -RedirectPort $WsPort
    if ($ClientVersion -like "1.201*") {
        Write-Host "Applying 1.201 global gateway redirect: hdgame-dglobal-gate.lilithgame.com:10000"
        & (Join-Path $root "set-device-ws-redirect.ps1") `
            -AdbPath $AdbPath `
            -Serial $Serial `
            -TargetHost "hdgame-dglobal-gate.lilithgame.com" `
            -TargetPort 10000 `
            -RedirectHost $RedirectHost `
            -RedirectPort $WsPort
        Write-Host "Applying 1.201 TLS gateway redirect: hdgame-dglobal-gate.lilithcdn.com:443"
        & (Join-Path $root "set-device-ws-redirect.ps1") `
            -AdbPath $AdbPath `
            -Serial $Serial `
            -TargetHost "hdgame-dglobal-gate.lilithcdn.com" `
            -TargetPort 443 `
            -RedirectHost $RedirectHost `
            -RedirectPort $WsTlsPort
        Write-Host "Applying 1.201 regional fallback redirect: 34.160.168.53:10000"
        & (Join-Path $root "set-device-ws-redirect.ps1") `
            -AdbPath $AdbPath `
            -Serial $Serial `
            -TargetHost "34.160.168.53" `
            -TargetPort 10000 `
            -RedirectHost $RedirectHost `
            -RedirectPort $WsPort
    }
    if ($RedirectHost -in @("127.0.0.1", "localhost")) {
        Invoke-Adb -CommandArgs @("reverse", "tcp:$WsPort", "tcp:$WsPort")
        Invoke-Adb -CommandArgs @("reverse", "tcp:$ImPort", "tcp:$ImPort")
        Invoke-Adb -CommandArgs @("reverse", "tcp:$WsTlsPort", "tcp:$WsTlsPort")
        Invoke-Adb -CommandArgs @("reverse", "tcp:$MockPort", "tcp:$MockPort")
        Invoke-Adb -CommandArgs @("reverse", "tcp:$ResourcePort", "tcp:$ResourcePort")
        Write-Host "ADB reverse : HTTP $MockPort, WS $WsPort, IM $ImPort, WSS $WsTlsPort, resources $ResourcePort"
    }
}

Write-Host ""
Write-Host "AFK local private server is ready."
Write-Host "Set emulator/device HTTP proxy to ${PublicHost}:$MitmPort if it was not configured automatically."
Write-Host "Use websocket URL $wsUrl via jsb cache patch or DNAT redirect."
Write-Host "Stop with: .\stop-local-private-server.ps1"
