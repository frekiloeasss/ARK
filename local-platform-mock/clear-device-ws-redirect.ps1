param(
    [string]$AdbPath = "D:\study\MuMuPlayer\nx_device\12.0\shell\adb.exe",
    [string]$Serial = "emulator-5554",
    [string]$TargetHost = "148.178.21.210",
    [int]$TargetPort = 15007,
    [string]$RedirectHost = "10.0.2.2",
    [int]$RedirectPort = 15007
)

$ErrorActionPreference = "Stop"

$adbPrefix = @()
if ($Serial) {
    $adbPrefix += @("-s", $Serial)
}

function Invoke-Adb {
    param([string[]]$CommandArgs)

    & $script:AdbPath @script:adbPrefix @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "adb command failed: $($CommandArgs -join ' ')"
    }
}

$ruleSpec = "-p tcp -d $TargetHost --dport $TargetPort -j DNAT --to-destination $($RedirectHost):$RedirectPort"
$shellCommand = "for i in 1 2 3 4 5; do iptables -t nat -D OUTPUT $ruleSpec >/dev/null 2>&1 || break; done; iptables -t nat -S OUTPUT"

Write-Host "Restarting adbd as root on $Serial..."
Invoke-Adb -CommandArgs @("root")
Invoke-Adb -CommandArgs @("wait-for-device")
Start-Sleep -Seconds 1

Write-Host "Clearing redirect: $TargetHost`:$TargetPort -> $RedirectHost`:$RedirectPort"
Invoke-Adb -CommandArgs @("shell", $shellCommand)
