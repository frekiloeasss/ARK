param()

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$stateFile = Join-Path $root "runtime\\stack.json"

if (-not (Test-Path $stateFile)) {
    Write-Host "No running stack metadata found."
    exit 0
}

$state = Get-Content $stateFile -Raw | ConvertFrom-Json
$processIds = @($state.mock_pid, $state.proxy_pid, $state.ws_pid, $state.im_pid, $state.resource_pid, $state.instant_pay_bridge_pid) | Where-Object { $_ }

foreach ($processId in $processIds) {
    try {
        Stop-Process -Id $processId -Force -ErrorAction Stop
        Wait-Process -Id $processId -Timeout 5 -ErrorAction SilentlyContinue
        Write-Host "Stopped process $processId"
    } catch {
        Write-Host "Process $processId was already stopped."
    }
}

if (Test-Path $stateFile) {
    Remove-Item -LiteralPath $stateFile -Force
}
