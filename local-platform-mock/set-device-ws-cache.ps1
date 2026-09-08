param(
    [string]$AdbPath = "D:\study\MuMuPlayer\nx_device\12.0\shell\adb.exe",
    [string]$Serial = "emulator-5554",
    [string]$Package = "cyou.sharesrc.afk.release146",
    [string]$PublishedWsUrl = "ws://192.168.3.4:15007",
    [string]$PythonExe = "python"
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$runtimeDir = Join-Path $root "runtime\device-ws-cache"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

$deviceDbPath = "/data/data/$Package/databases/jsb.sqlite"
$remoteTempPath = "/data/local/tmp/afk-jsb.sqlite"
$localDbPath = Join-Path $runtimeDir "jsb.sqlite"
$backupPath = Join-Path $runtimeDir ("jsb.sqlite.backup." + (Get-Date -Format "yyyyMMdd-HHmmss"))

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

function Invoke-Python {
    param([string[]]$CommandArgs)

    & $script:PythonExe @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "python command failed: $($CommandArgs -join ' ')"
    }
}

if (-not (Test-Path -LiteralPath $AdbPath)) {
    throw "adb not found: $AdbPath"
}

Write-Host "Restarting adbd as root on $Serial..."
Invoke-Adb -CommandArgs @("root")
Invoke-Adb -CommandArgs @("wait-for-device")
Start-Sleep -Seconds 1

Write-Host "Stopping app: $Package"
Invoke-Adb -CommandArgs @("shell", "am force-stop $Package")

Write-Host "Pulling $deviceDbPath"
Invoke-Adb -CommandArgs @("shell", "test -f '$deviceDbPath'")
Invoke-Adb -CommandArgs @("pull", $deviceDbPath, $localDbPath)
Copy-Item -LiteralPath $localDbPath -Destination $backupPath -Force
Write-Host "Backup saved: $backupPath"

$pythonCode = @'
import json
import sqlite3
import sys

db_path = sys.argv[1]
published_ws_url = sys.argv[2]

connection = sqlite3.connect(db_path)
try:
    rows = connection.execute(
        """
        SELECT key, value
        FROM data
        WHERE key LIKE '%DGSave_Host'
           OR key LIKE '%DGSave_Cur_Server'
           OR key LIKE '%DGSave_Next_Host'
        """
    ).fetchall()

    changed = []
    existing_keys = {key for key, _ in rows}
    prefixes = sorted(
        {
            key[: -len("DGSave_Host")]
            for key, _ in rows
            if key.endswith("DGSave_Host")
        }
    )
    for key, value in rows:
        new_value = value
        if key.endswith("DGSave_Host"):
            new_value = published_ws_url
        elif key.endswith("DGSave_Cur_Server"):
            try:
                server = json.loads(value)
            except Exception:
                server = None
            if isinstance(server, dict):
                server["host"] = published_ws_url
                new_value = json.dumps(server, ensure_ascii=False, separators=(",", ":"))
        elif key.endswith("DGSave_Next_Host"):
            # Keep the client from rotating to the next saved remote host after relaunch.
            new_value = "0"

        if new_value != value:
            connection.execute("UPDATE data SET value = ? WHERE key = ?", (new_value, key))
            changed.append((key, value, new_value))

    for prefix in prefixes:
        cur_server_key = f"{prefix}DGSave_Cur_Server"
        if cur_server_key in existing_keys:
            continue
        cur_server = {
            "id": 19,
            "name": "19\u533a",
            "host": published_ws_url,
            "status": "open",
            "activit": "ok",
        }
        cur_server_value = json.dumps(cur_server, ensure_ascii=True, separators=(",", ":"))
        connection.execute(
            "INSERT OR REPLACE INTO data(key, value) VALUES (?, ?)",
            (cur_server_key, cur_server_value),
        )
        changed.append((cur_server_key, None, cur_server_value))

    connection.commit()
finally:
    connection.close()

print(json.dumps({"published_ws_url": published_ws_url, "changed": changed}, ensure_ascii=False, indent=2))
'@

$pythonScript = Join-Path $runtimeDir "patch-jsb-ws-cache.py"
Set-Content -LiteralPath $pythonScript -Value $pythonCode -Encoding UTF8
Invoke-Python -CommandArgs @($pythonScript, $localDbPath, $PublishedWsUrl)

Write-Host "Pushing patched database back to device..."
Invoke-Adb -CommandArgs @("push", $localDbPath, $remoteTempPath)
Invoke-Adb -CommandArgs @(
    "shell",
    "cp '$remoteTempPath' '$deviceDbPath' && chown `$(stat -c '%u:%g' /data/data/$Package/databases) '$deviceDbPath' && chmod 660 '$deviceDbPath' && rm -f '$remoteTempPath'"
)

Write-Host "Patched $deviceDbPath with $PublishedWsUrl"
Write-Host "Restart the app, then open the server list to verify the displayed host."
