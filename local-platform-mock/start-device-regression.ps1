param(
    [string]$AdbPath = $env:AFK_TEST_ADB_PATH,
    [string]$Serial = $env:AFK_TEST_ADB_SERIAL,
    [int]$IntervalSeconds = 3600,
    [switch]$AllowPrimary,
    [switch]$ResetEpoch
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeDir = Join-Path $projectRoot "runtime"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $projectRoot "scripts\device-regression-runner.js"
$stdout = Join-Path $runtimeDir "device-regression.out.log"
$stderr = Join-Path $runtimeDir "device-regression.err.log"
$pidFile = Join-Path $runtimeDir "device-regression.pid"

if (Test-Path $pidFile) {
    $existingPid = [int](Get-Content -Raw $pidFile)
    if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
        Write-Host "device regression already running: $existingPid"
        exit 0
    }
}

$arguments = @($runner, "--continuous", "--interval-seconds", [string]$IntervalSeconds)
if ($AdbPath) { $arguments += @("--adb", $AdbPath) }
if ($Serial) { $arguments += @("--serial", $Serial) }
if ($AllowPrimary) { $arguments += "--allow-primary" }
if ($ResetEpoch) { $arguments += "--reset-epoch" }

$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
Write-Host "device regression started: $($process.Id)"
Write-Host "stdout: $stdout"
Write-Host "stderr: $stderr"
