param(
    [switch]$ClearDeviceProxy,
    [switch]$ClearIptablesRedirect,
    [string]$AdbPath = "D:\study\MuMuPlayer\nx_device\12.0\shell\adb.exe",
    [string]$Serial = "emulator-5554",
    [string]$RedirectHost = "10.0.2.2",
    [int]$WsPort = 15007,
    [int]$WsTlsPort = 15443,
    [switch]$KeepMysql,
    [switch]$KeepSupervisor
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot

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

if ($ClearDeviceProxy) {
    if (-not (Test-Path -LiteralPath $AdbPath)) {
        throw "adb not found: $AdbPath"
    }
    Write-Host "Clearing Android HTTP proxy on $Serial"
    Invoke-Adb -CommandArgs @("shell", "settings put global http_proxy :0")
    Invoke-Adb -CommandArgs @("shell", "settings delete global global_http_proxy_host >/dev/null 2>&1 || true")
    Invoke-Adb -CommandArgs @("shell", "settings delete global global_http_proxy_port >/dev/null 2>&1 || true")
}

if ($ClearIptablesRedirect) {
    & (Join-Path $root "clear-device-ws-redirect.ps1") `
        -AdbPath $AdbPath `
        -Serial $Serial `
        -RedirectHost $RedirectHost `
        -RedirectPort $WsPort
    & (Join-Path $root "clear-device-ws-redirect.ps1") `
        -AdbPath $AdbPath `
        -Serial $Serial `
        -TargetHost "hdgame-dglobal-gate.lilithgame.com" `
        -TargetPort 10000 `
        -RedirectHost $RedirectHost `
        -RedirectPort $WsPort
    & (Join-Path $root "clear-device-ws-redirect.ps1") `
        -AdbPath $AdbPath `
        -Serial $Serial `
        -TargetHost "hdgame-dglobal-gate.lilithcdn.com" `
        -TargetPort 443 `
        -RedirectHost $RedirectHost `
        -RedirectPort $WsTlsPort
    & (Join-Path $root "clear-device-ws-redirect.ps1") `
        -AdbPath $AdbPath `
        -Serial $Serial `
        -TargetHost "34.160.168.53" `
        -TargetPort 10000 `
        -RedirectHost $RedirectHost `
        -RedirectPort $WsPort
}

& (Join-Path $root "stop-stack.ps1")

if (-not $KeepSupervisor) {
    $opsState = Join-Path $root "runtime\ops-supervisor.json"
    if (Test-Path -LiteralPath $opsState) {
        $ops = Get-Content -LiteralPath $opsState -Raw | ConvertFrom-Json
        Stop-Process -Id $ops.pid -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $opsState -Force -ErrorAction SilentlyContinue
    }
}
if (-not $KeepMysql) {
    & (Join-Path $root "stop-portable-mysql.ps1")
}
