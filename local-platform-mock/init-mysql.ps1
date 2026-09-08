param(
    [string]$HostName = "127.0.0.1",
    [int]$Port = 3306,
    [string]$User = "root",
    [string]$Database = "AFK",
    [string]$Password = ""
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot

if (-not $Password) {
    $securePassword = Read-Host "MySQL password for $User" -AsSecureString
    $credential = New-Object System.Management.Automation.PSCredential($User, $securePassword)
    $Password = $credential.GetNetworkCredential().Password
}

$env:AFK_DB_HOST = $HostName
$env:AFK_DB_PORT = [string]$Port
$env:AFK_DB_USER = $User
$env:AFK_DB_PASSWORD = $Password
$env:AFK_DB_NAME = $Database

Push-Location $root
try {
    npm run db:migrate
    mysql -h $HostName -P $Port -u $User "-p$Password" -D $Database -e "SHOW TABLES;"
} finally {
    Pop-Location
}
