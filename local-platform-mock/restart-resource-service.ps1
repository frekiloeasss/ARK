param(
    [string]$ListenHost = "0.0.0.0",
    [int]$Port = 6505,
    [string]$Serial = "127.0.0.1:16416",
    [string]$AdbPath = "D:\study\MuMuPlayer\nx_device\12.0\shell\adb.exe",
    [string]$Package = "com.lilithgame.hgame.gp"
)

$ErrorActionPreference = "Stop"
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

$oldPid = Get-ListenerProcessId -LocalPort $Port
if ($oldPid) {
    $oldProcess = Get-Process -Id $oldPid -ErrorAction Stop
    if ($oldProcess.ProcessName -ne "node") {
        throw "Port $Port belongs to unexpected process $($oldProcess.ProcessName) ($oldPid)."
    }
    Stop-Process -Id $oldPid -Force
    Wait-Process -Id $oldPid -Timeout 8 -ErrorAction SilentlyContinue
}

$versionRoot = Join-Path $runtime "official-updates\1.201.01"
$classicRoot = Join-Path $versionRoot "official-assets\extraAsset\assets\classic"
$cacheRoot = Join-Path $runtime "resource-cache-1.201"
$apkPath = Join-Path $versionRoot "xapk\com.lilithgame.hgame.gp.apk"
$stdout = Join-Path $runtime "resource-cache.out.log"
$stderr = Join-Path $runtime "resource-cache.err.log"
$node = (Get-Command node).Source
$resource = Start-Process -FilePath $node -ArgumentList @(
    "scripts\resource-cache-server.js",
    "--host", $ListenHost,
    "--port", [string]$Port,
    "--adb", $AdbPath,
    "--serial", $Serial,
    "--package", $Package,
    "--cache-root", $cacheRoot,
    "--version-root", $versionRoot,
    "--extracted-root", $classicRoot,
    "--timely-root", (Join-Path $versionRoot "timely"),
    "--extra-root", $classicRoot,
    "--apk", $apkPath,
    "--upstream", "https://hgame-cdn.lilithgame.com/global/v2/",
    "--no-device"
) -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

Start-Sleep -Milliseconds 800
$listenerPid = Get-ListenerProcessId -LocalPort $Port
if ($listenerPid -ne $resource.Id) {
    $errorText = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { "" }
    throw "Resource service PID $($resource.Id) did not listen on port $Port. $errorText"
}

$statePath = Join-Path $runtime "stack.json"
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$state | Add-Member -NotePropertyName resource_pid -NotePropertyValue $resource.Id -Force
$state | Add-Member -NotePropertyName resource_port -NotePropertyValue $Port -Force
$state | Add-Member -NotePropertyName resource_listen_host -NotePropertyValue $ListenHost -Force
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

@{ ok = $true; resource_pid = $resource.Id; port = $Port; host = $ListenHost } | ConvertTo-Json -Compress
