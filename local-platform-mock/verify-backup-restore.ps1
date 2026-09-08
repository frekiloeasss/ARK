param([Parameter(Mandatory=$true)][string]$BackupPath)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path $PSScriptRoot).Path
$backupRoot = (Resolve-Path (Join-Path $root "runtime\backups")).Path
$resolved = (Resolve-Path -LiteralPath $BackupPath).Path
if (-not $resolved.StartsWith($backupRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Backup must be inside $backupRoot" }
if ([IO.Path]::GetExtension($resolved) -ne ".sql") { throw "Backup must be a .sql file." }
$checksumPath = "${resolved}.sha256"
if (Test-Path -LiteralPath $checksumPath) {
    $expected = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split '\s+')[0]
    $actual = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected.ToLowerInvariant()) { throw "Backup checksum mismatch." }
}
$logArchivePath = "${resolved}.logs.zip"
if (Test-Path -LiteralPath $logArchivePath) {
    $logChecksumPath = "${logArchivePath}.sha256"
    if (-not (Test-Path -LiteralPath $logChecksumPath)) { throw "Log archive checksum is missing." }
    $logExpected = ((Get-Content -LiteralPath $logChecksumPath -Raw).Trim() -split '\s+')[0]
    $logActual = (Get-FileHash -LiteralPath $logArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($logActual -ne $logExpected.ToLowerInvariant()) { throw "Log archive checksum mismatch." }
}
$state = Get-Content (Join-Path $root "runtime\mysql\state.json") -Raw | ConvertFrom-Json
$mysql = "D:\study\Mysql\mysql-8.4.8-winx64\bin\mysql.exe"
$verifyDb = "AFK_restore_verify"
& $mysql --protocol=TCP -h 127.0.0.1 -P $state.port -u root -e "DROP DATABASE IF EXISTS $verifyDb; CREATE DATABASE $verifyDb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
if ($LASTEXITCODE -ne 0) { throw "Failed to create restore verification database." }
try {
    $import = Start-Process -FilePath $mysql -ArgumentList @("--binary-mode=1","--skip-commands","--protocol=TCP","-h","127.0.0.1","-P",[string]$state.port,"-u","root","-D",$verifyDb) -RedirectStandardInput $resolved -WindowStyle Hidden -Wait -PassThru
    if ($import.ExitCode -ne 0) { throw "Restore verification import failed." }
    $counts = & $mysql --batch --skip-column-names --protocol=TCP -h 127.0.0.1 -P $state.port -u root -D $verifyDb -e "SELECT CONCAT('players=',COUNT(*)) FROM players UNION ALL SELECT CONCAT('accounts=',COUNT(*)) FROM accounts UNION ALL SELECT CONCAT('tables=',COUNT(*)) FROM information_schema.tables WHERE table_schema='$verifyDb';"
    if ($LASTEXITCODE -ne 0) { throw "Restore verification query failed." }
    [pscustomobject]@{ok=$true;backup=$resolved;log_archive_verified=(Test-Path -LiteralPath $logArchivePath);database=$verifyDb;checks=@($counts);verified_at=(Get-Date).ToString('o')} | ConvertTo-Json -Compress
} finally {
    & $mysql --protocol=TCP -h 127.0.0.1 -P $state.port -u root -e "DROP DATABASE IF EXISTS $verifyDb;" | Out-Null
}
