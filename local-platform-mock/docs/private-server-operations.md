# Local private-server operations

This document describes the complete local deployment for client `1.182.03.301371`.
It runs entirely on the workstation and rooted MuMu emulator; it does not require the
official game service after the client has reached the locally reproduced flows.

## Deploy

```powershell
cd D:\Project\AFK\local-platform-mock
.\deploy-private-server.ps1 -Serial 127.0.0.1:16384
```

The command starts and verifies:

- dedicated MySQL 8.4 on `127.0.0.1:3307` (`AFK` database);
- HTTP/account/GM/game API on port `18080`;
- platform routing proxy on port `8082`;
- authoritative game WebSocket on port `15007`;
- official-resource cache on port `6505`;
- health supervisor, automatic recovery, and daily database backup;
- emulator ADB reverse rules (including the local HTTP proxy) and WebSocket DNAT.
- native instant-payment bridge; clicking a client礼包 grants its recovered resources directly without opening a store.

Runtime state is written to `runtime/stack.json`; continuous health is written to
`runtime/ops-health.json`. A healthy deployment reports `ok: true` and
`db.ready: true` from `GET /__afk/health`.

## Persistence and recovery

The project-owned MySQL instance uses `runtime/mysql/data`. Start and stop it with
`start-portable-mysql.ps1` and `stop-portable-mysql.ps1`.

Create a logical backup:

```powershell
.\backup-private-server.ps1 -Label manual
```

Backups are stored under `runtime/backups`. Restore only an explicitly selected
project backup:

```powershell
.\restore-private-server.ps1 `
  -BackupPath .\runtime\backups\AFK-YYYYMMDD-HHMMSS-manual.sql `
  -ConfirmRestore
```

Restore replaces only the exact `AFK` database. Stop the game services first and
redeploy afterward.

## Accounts and GM

Player APIs:

- `POST /__afk/accounts/register`
- `POST /__afk/accounts/login`

GM APIs require `Authorization: Bearer <token>` from an `admin` or `gm` login:

- `GET /__afk/gm/players`
- `GET /__afk/gm/audit`
- `POST /__afk/gm/action`

Supported audited actions include asset grant, stage correction, ban/unban, mail,
period reset, and all 257 recovered GM protocol operations. Deployment creates a
random bootstrap password and payment signing secret in the ignored
`runtime/private-server-secrets.json`; it does not retain a published default.

## Server-authoritative systems

Campaign, tower, and labyrinth battle starts create a server battle record from
the submitted lineup and decrypted client configuration. A deterministic server
simulation decides the result. Client-reported victory is treated as evidence only
and cannot forge progression or rewards. Battle records and verification state are
stored in `battle_records`.

The live-operations scheduler applies idempotent daily, weekly, and 28-day seasonal
resets. Daily-login and battle-pass progress/claims are exposed through game actions.
Expanded arena records/tickets, tower records/assists, labyrinth relic/shop/give-up,
guild-boss, chat, and friendship state are also persisted.

## Verification

```powershell
npm test
npm run test:mysql
npm run verify:production
Invoke-RestMethod http://127.0.0.1:18080/__afk/health
```

`npm test` covers unit, protocol, and HTTP/WebSocket integration behavior.
`npm run test:mysql` proves account registration/login, GM auditing, live operations,
authoritative anti-forgery, social state, server restart, and state survival in MySQL.
`npm run verify:production` checks protocol closure, the 47,326-file resource
manifest, credentials/TLS, six supervised processes (including instant payment),
MySQL, and both backup copies.

## Stop

```powershell
.\stop-local-private-server.ps1 `
  -ClearDeviceProxy `
  -ClearIptablesRedirect `
  -RedirectHost 198.18.0.1
```

This stops the application services, supervisor, and project-owned MySQL unless a
corresponding `Keep*` switch is supplied.

## Scope note

“Official parity” in this repository means the recovered protocol and configuration
for the exact captured client. The battle outcome is now authoritative and uses
official decrypted stats/stages, but it is a deterministic local simulation rather
than a claim that the unavailable official combat engine source code was reproduced
instruction-for-instruction. Locally inferred policies remain labeled in the parity
matrix.
