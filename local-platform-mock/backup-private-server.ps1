param([string]$Label = "manual", [string]$OffsiteRoot = "")
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backupRoot = Join-Path $root "runtime\backups"
if (-not $OffsiteRoot) { $OffsiteRoot = Join-Path $root "runtime\offsite-backups" }
$statePath = Join-Path $root "runtime\mysql\state.json"
if (-not (Test-Path -LiteralPath $statePath)) { throw "Portable MySQL is not initialized." }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
New-Item -ItemType Directory -Force -Path $OffsiteRoot | Out-Null
$safeLabel = ($Label -replace '[^A-Za-z0-9_-]', '_')
$target = Join-Path $backupRoot ("AFK-{0}-{1}.sql" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $safeLabel)
$dump = "D:\study\Mysql\mysql-8.4.8-winx64\bin\mysqldump.exe"
$mainDump = "${target}.main.tmp"
$logSchemaDump = "${target}.log-schema.tmp"
& $dump --protocol=TCP -h 127.0.0.1 -P $state.port -u afk_local "-pafk-local-only" --single-transaction --hex-blob --ignore-table=AFK.request_logs --ignore-table=AFK.ws_frame_logs --no-tablespaces --routines --events --triggers --set-gtid-purged=OFF AFK --result-file=$mainDump
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $mainDump)) { throw "MySQL main-state backup failed." }
& $dump --protocol=TCP -h 127.0.0.1 -P $state.port -u afk_local "-pafk-local-only" --no-data --no-tablespaces --set-gtid-purged=OFF AFK request_logs ws_frame_logs --result-file=$logSchemaDump
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $logSchemaDump)) { throw "MySQL log-schema backup failed." }
$output = [IO.File]::Create($target)
try {
    foreach ($part in @($mainDump, $logSchemaDump)) {
        $input = [IO.File]::OpenRead($part)
        try { $input.CopyTo($output) } finally { $input.Dispose() }
    }
} finally { $output.Dispose() }
Remove-Item -LiteralPath $mainDump,$logSchemaDump -Force
if (-not (Test-Path -LiteralPath $target)) { throw "MySQL backup assembly failed." }
$hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "${target}.sha256" -Value "$hash  $([IO.Path]::GetFileName($target))" -Encoding ASCII
$offsiteTarget = Join-Path $OffsiteRoot ([IO.Path]::GetFileName($target))
Copy-Item -LiteralPath $target -Destination $offsiteTarget -Force
Copy-Item -LiteralPath "${target}.sha256" -Destination "${offsiteTarget}.sha256" -Force
$logFiles = @((Join-Path $root "logs\requests.jsonl"), (Join-Path $root "logs\ws-frames.jsonl")) | Where-Object { Test-Path -LiteralPath $_ }
$logArchive = $null
if ($logFiles.Count -gt 0) {
    $logArchive = "${target}.logs.zip"
    Compress-Archive -LiteralPath $logFiles -DestinationPath $logArchive -CompressionLevel Optimal -Force
    $logHash = (Get-FileHash -LiteralPath $logArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "${logArchive}.sha256" -Value "$logHash  $([IO.Path]::GetFileName($logArchive))" -Encoding ASCII
    Copy-Item -LiteralPath $logArchive -Destination (Join-Path $OffsiteRoot ([IO.Path]::GetFileName($logArchive))) -Force
    Copy-Item -LiteralPath "${logArchive}.sha256" -Destination (Join-Path $OffsiteRoot ([IO.Path]::GetFileName("${logArchive}.sha256"))) -Force
}
Get-ChildItem -LiteralPath $backupRoot -Filter "AFK-*.sql" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item -Force
Get-ChildItem -LiteralPath $OffsiteRoot -Filter "AFK-*.sql" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 30 | Remove-Item -Force
[pscustomobject]@{ ok=$true; path=$target; offsite_path=$offsiteTarget; log_archive=$logArchive; size=(Get-Item -LiteralPath $target).Length; sha256=$hash } | ConvertTo-Json -Compress
