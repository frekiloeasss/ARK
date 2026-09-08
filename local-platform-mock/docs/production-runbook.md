# Production and recovery runbook

## Start and verify

Run `deploy-private-server.ps1`. It starts portable MySQL, migrates schema, launches HTTP/HTTPS, WebSocket, MITM and strict-offline resource services, configures the MuMu redirect, and starts the supervisor.

Verification endpoints:

- `http://127.0.0.1:18080/__afk/health`
- `http://127.0.0.1:18080/__afk/metrics`
- `http://127.0.0.1:18080/__afk/evidence`
- `http://127.0.0.1:18080/gm-ui/`

Before exposing the service beyond a trusted private network, set unique `AFK_ADMIN_PASSWORD` and `AFK_PAYMENT_SECRET`, restrict ports at the host firewall, and terminate TLS with a trusted certificate. Optional `AFK_ALERT_WEBHOOK` receives supervisor state transitions.

## Backups and recovery

`backup-private-server.ps1` creates a transaction-consistent, restorable business SQL dump, a SHA-256 sidecar, and a second copy under `runtime/offsite-backups` (or `-OffsiteRoot`). Binary request/WebSocket payload logs are exported separately as a checksummed `.logs.zip`, so diagnostic bytes cannot corrupt SQL recovery. Fourteen local and thirty offsite generations are retained.

`verify-backup-restore.ps1 -BackupPath <path>` verifies the SQL and log-archive checksums, restores into the isolated `AFK_restore_verify` database, checks essential rows and all 24 tables, then removes only that exact verification database.

`restore-private-server.ps1 -BackupPath <path> -ConfirmRestore` is the guarded destructive recovery procedure. Stop player traffic first and always run the isolated verification command before it.

## Monitoring and incident artifacts

The supervisor writes current health to `runtime/ops-health.json`, history to `runtime/ops-health.jsonl`, and transitions to `runtime/ops-alerts.jsonl`. It checks all five processes and MySQL every 30 seconds, makes a daily backup, and performs a bounded restart after an unhealthy transition.

HTTP metrics are Prometheus text. Request and WebSocket audit trails remain in JSONL and MySQL. GM mutations are written to `gm_audit_logs`; throttling is written to `security_events`.
