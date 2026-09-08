param(
    [string]$Version = "1.201.01",
    [string]$Package = "com.lilithgame.hgame.gp",
    [string]$ExpectedCertSha1 = "acf60a05aa19fa5de96b1988a87a29e90e4c6f15"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$target = Join-Path $root "runtime\official-updates\$Version"
$xapk = Join-Path $target "AFK-Arena-$Version.xapk"
$extracted = Join-Path $target "xapk"
$assets = Join-Path $target "official-assets"
$inspection = Join-Path $target "inspection.json"
New-Item -ItemType Directory -Force -Path $target | Out-Null

if (-not (Test-Path -LiteralPath $xapk) -or (Get-Item -LiteralPath $xapk).Length -lt 700000000) {
    & curl.exe -L --fail --retry 5 -C - --output $xapk "https://d.apkpure.net/b/XAPK/$Package`?version=latest"
    if ($LASTEXITCODE -ne 0) { throw "XAPK download failed" }
}

python (Join-Path $PSScriptRoot "inspect-official-xapk.py") $xapk --expected-package $Package --expected-version $Version --expected-cert-sha1 $ExpectedCertSha1 --output $inspection
if ($LASTEXITCODE -ne 0) { throw "Downloaded package did not match the expected official identity" }

New-Item -ItemType Directory -Force -Path $extracted | Out-Null
& tar.exe -xf $xapk -C $extracted
if ($LASTEXITCODE -ne 0) { throw "XAPK extraction failed" }
$apks = Get-ChildItem -LiteralPath $extracted -Filter *.apk -File
if (-not $apks) { throw "No APK found after extraction" }
New-Item -ItemType Directory -Force -Path $assets | Out-Null
foreach ($apk in $apks) {
    $apkTarget = Join-Path $assets $apk.BaseName
    New-Item -ItemType Directory -Force -Path $apkTarget | Out-Null
    $assetEntries = & tar.exe -tf $apk.FullName | Where-Object { $_ -like "assets/*" }
    if ($assetEntries) {
        & tar.exe -xf $apk.FullName -C $apkTarget assets
        if ($LASTEXITCODE -ne 0) { throw "APK asset extraction failed: $($apk.Name)" }
    }
}

$bootstrap = Join-Path $target "project.jsone"
Invoke-WebRequest -Uri "https://hgame-cdn.lilithgame.com/global/v2/rel/project.jsone" -OutFile $bootstrap -UseBasicParsing
$bootstrapHash = (Get-FileHash -LiteralPath $bootstrap -Algorithm SHA256).Hash.ToLowerInvariant()
$assetCount = (Get-ChildItem -LiteralPath $assets -Recurse -File | Measure-Object).Count
$metadata = [ordered]@{
    format = "afk-official-resource-sync-v1"
    version = $Version
    package = $Package
    synced_at = (Get-Date).ToUniversalTime().ToString("o")
    xapk = $xapk
    inspection = $inspection
    assets_root = $assets
    asset_file_count = $assetCount
    official_cdn_bootstrap = "https://hgame-cdn.lilithgame.com/global/v2/rel/project.jsone"
    official_cdn_bootstrap_sha256 = $bootstrapHash
    activated = $false
    activation_reason = "Versioned quarantine: protocol/client compatibility must pass before replacing the live 1.182 resource tree."
}
$metadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $target "sync-result.json") -Encoding UTF8
$metadata | ConvertTo-Json -Depth 5
