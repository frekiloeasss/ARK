# 经典服 1.201.01 配置说明

本文对应 `com.lilithgame.hgame.gp` 的经典服 1.201.01 私服运行环境。文中的 `<PUBLIC_HOST>` 是部署机的公网 IP 或域名，必须替换为实际值。

## 前置条件

- Windows 10/11 x64、PowerShell、Node.js、Git、Git LFS 与 Python 3.11。
- MySQL 可由 `start-portable-mysql.ps1` 启动；MuMu1 的 ADB 序列号为 `127.0.0.1:16384`。
- 克隆后先获取 LFS 资源：

```powershell
git lfs install
git clone https://github.com/frekiloeasss/ARK.git
cd ARK
git lfs pull
```

## 资源还原

资源包在 `distribution\classic-1.201.01`，必须解压至 `local-platform-mock\runtime\resource-cache-1.201`。以下命令会先验证 SHA-256 再解压：

```powershell
cd D:\Project\AFK
$bundle = '.\distribution\classic-1.201.01'
$target = '.\local-platform-mock\runtime\resource-cache-1.201'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Get-Content "$bundle\manifest.json" -Raw | ConvertFrom-Json |
  Select-Object -ExpandProperty archives |
  ForEach-Object {
    $file = Join-Path $bundle $_.file
    if ((Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $_.sha256) { throw "checksum mismatch: $($_.file)" }
    tar -xf $file -C $target
  }
```

完成后应存在 `runtime\resource-cache-1.201\rel\res`。

## 私密配置

首次运行 `deploy-private-server.ps1` 会生成 `runtime\private-server-secrets.json`。它含管理员密码与支付签名密钥，只能保留在部署机。生产环境通过环境变量设置：

```powershell
$env:AFK_ADMIN_USER = 'admin'
$env:AFK_ADMIN_PASSWORD = '<至少32位随机密码>'
$env:AFK_PAYMENT_SECRET = '<至少32位随机密钥>'
$env:AFK_DB_ENABLED = '1'
$env:AFK_DB_HOST = '127.0.0.1'
$env:AFK_DB_PORT = '3307'
$env:AFK_DB_USER = 'afk_local'
$env:AFK_DB_PASSWORD = '<数据库密码>'
$env:AFK_DB_NAME = 'AFK'
```

## 启动经典服

`-PublicHost` 必须是手机可访问的公网地址，不能填 `127.0.0.1`：

```powershell
cd D:\Project\AFK\local-platform-mock
.\deploy-private-server.ps1 `
  -ClientTrack 1.201 `
  -PublicHost <PUBLIC_HOST> `
  -Serial 127.0.0.1:16384
```

已部署时重启：

```powershell
.\restart-core-services.ps1 -PublicHost <PUBLIC_HOST>
.\restart-resource-service.ps1 -ListenHost 0.0.0.0 -Serial 127.0.0.1:16384
```

## 公网端口

| 端口 | 服务 | 用途 |
| --- | --- | --- |
| 18080 | API | 登录、角色、活动与 GM 接口 |
| 15007 | WebSocket | 游戏协议、战斗与聊天 |
| 6505 | 资源服务 | 登录校验、预下载与热更新 |

在 Windows 管理员 PowerShell 开放端口：

```powershell
New-NetFirewallRule -DisplayName 'AFK API 18080' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 18080
New-NetFirewallRule -DisplayName 'AFK Gateway 15007' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 15007
New-NetFirewallRule -DisplayName 'AFK Resource 6505' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 6505
```

路由器/NAT 必须将同样的三个 TCP 端口转发至部署机。不要公开 MySQL、GM 管理界面或调试 TLS 端口。

## 健康检查

```powershell
Get-NetTCPConnection -State Listen -LocalPort 18080,15007,6505 |
  Format-Table LocalAddress,LocalPort,OwningProcess
Invoke-RestMethod 'http://127.0.0.1:18080/__afk/health'
Invoke-WebRequest 'http://127.0.0.1:6505/global/v2/rel/checkversionSplit.zipe' -Method Head
```

真机出现 `checkversion` 404 时，确认 6505 是否监听 `0.0.0.0`，然后重启资源服务；不要删除玩家数据库。

## APK 与 MuMu1 测试

正式 APK 从 GitHub Release 下载。首次登录顺序为 6505 资源校验、18080 API、15007 网关。移动网络测试必须移除 ADB 转发，确认客户端使用公网地址。

```powershell
$adb = 'D:\study\MuMuPlayer\nx_device\12.0\shell\adb.exe'
& $adb -s 127.0.0.1:16384 shell "curl -r 0-1023 -D - -o /dev/null http://<PUBLIC_HOST>:6505/global/v2/rel/checkversionSplit.zipe"
```

## 备份与恢复

```powershell
.\backup-private-server.ps1
.\verify-backup-restore.ps1 -BackupPath <备份SQL路径>
```

只有隔离验证通过且已停止玩家流量时，才可恢复：

```powershell
.\restore-private-server.ps1 -BackupPath <备份SQL路径> -ConfirmRestore
```

## 永不上传的内容

- `runtime\private-server-secrets.json`
- `runtime\mysql\`、玩家数据库与数据库备份
- TLS 私钥、`*.jks`、`*.keystore`
- 设备缓存、真实账号令牌、抓包日志与设备标识
