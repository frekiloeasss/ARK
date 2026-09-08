# AFK Local Platform Mock

The full nine-goal delivery matrix and evidence boundaries are in `docs/nine-goal-completion-matrix.md`; deployment and disaster recovery are in `docs/production-runbook.md`.

## Complete MySQL private-server deployment

The current deployment includes project-owned MySQL persistence, server-authoritative
battle verification, player accounts and an audited GM API, periodic live operations,
expanded arena/tower/labyrinth/guild/social systems, backups, health supervision, and
automatic emulator routing.

Recharge is a local instant-grant flow: the native payment entry is intercepted,
the selected recovered ChargeGoods resources are committed to MySQL, and the client
receives its normal success callback without opening a real checkout.

The recovered protocol surface is closed across 184 modules and 1,599 operations:
13 dedicated integrations, 6 hybrid integrations, and 165 local-authoritative domain
integrations. All replies are synthesized against the 2,587-message protobuf schema;
there are no stateful-generic or unimplemented routes in the generated coverage report.

```powershell
cd D:\Project\AFK\local-platform-mock
.\deploy-private-server.ps1 -Serial 127.0.0.1:16384
```

Operational commands, credentials, recovery, and verification are documented in
`docs/private-server-operations.md`. Exact captured behavior versus deterministic
local extensions is tracked in `docs/official-parity-matrix.md`.

This folder contains a lightweight local platform mock for the AFK Dragon Android build we captured on 2026-06-23.

It currently covers the startup and login-preflight endpoints we have already confirmed:

- `POST /api/park/sdk/common/user_agreement`
- `POST /api/sdk/sls/token`
- `GET /park/parkway/prodf77cc4944d7a6ad7ccc665f84ba6.json`
- `GET /park/parkway/prodf77cc4944d7a6ad7ccc665f84ba6_report.json`
- `GET /http/user-service/userstatus`

Unknown requests can be transparently proxied upstream and logged, which is useful for capturing the next real login-submit endpoint without losing app flow.

It also includes a transparent websocket proxy for the actual game login socket so we can capture `req_sdk_login`, `req_login`, `reply_login`, heartbeat, and then switch those replies to local structured login plus request-matched interaction replay.

When MySQL credentials are available through `AFK_DB_*` or `AFK_DB_URL`, websocket frames are written directly into `AFK.ws_frame_logs` while still keeping the JSONL log file.
Interaction rules can also be loaded directly from `AFK.ws_interaction_rules` with `-WsInteractionDb`.
Structured websocket login writes local account, session, and player rows into `AFK.accounts`, `AFK.sessions`, and `AFK.players`.
Login also seeds inventory, character, and stage state; `stage_query_assist_summaries` responses are generated from `AFK.inventory_items`, `AFK.characters`, and `AFK.stage_progress` instead of being copied verbatim from a fixture.
Use `GET /__afk/db/business-state` plus `POST /__afk/db/inventory`, `POST /__afk/db/characters`, and `POST /__afk/db/stages` to inspect or edit local game state without writing SQL.

## Files

- `server.js`: local mock/proxy service
- `websocket_proxy.py`: transparent websocket proxy/logger for the game socket
- `extract_ws_replay_fixture.py`: turns a captured websocket session into either a timeline fixture or request-matched interaction fixture
- `mitmproxy/route_to_local_mock.py`: rewrites Lilith platform hosts to the local mock
- `start-stack.ps1`: starts both the mock service and mitmproxy in the background
- `stop-stack.ps1`: stops the background processes started by `start-stack.ps1`
- `set-device-ws-redirect.ps1`: applies `iptables` redirection on a rooted emulator/device
- `clear-device-ws-redirect.ps1`: removes the websocket redirection rule
- `logs/requests.jsonl`: recorded mocked and proxied requests
- `logs/ws-frames.jsonl`: recorded websocket frames

## Quick Start

### One-command local private-server mode

This starts the local HTTP platform mock, mitmproxy router, and websocket
structured-login/interaction replay without touching upstream game servers.
MySQL is disabled by default and the game state falls back to in-memory seed data.

```powershell
cd D:\Project\AFK\local-platform-mock
.\start-local-private-server.ps1
```

The script auto-detects the PC LAN IP and publishes:

- HTTP mock: `http://<PC-IP>:18080`
- mitmproxy: `<PC-IP>:8082`
- WebSocket mock: `ws://<PC-IP>:15007`

To configure a rooted emulator/device in the same command:

```powershell
.\start-local-private-server.ps1 `
  -ConfigureDeviceProxy `
  -PatchDeviceWsCache `
  -AdbPath "D:\study\MuMuPlayer\nx_device\12.0\shell\adb.exe" `
  -Serial emulator-5554
```

Alternative websocket routing through DNAT:

```powershell
.\start-local-private-server.ps1 `
  -ConfigureDeviceProxy `
  -UseIptablesRedirect `
  -RedirectHost <PC-IP-or-10.0.2.2>
```

Stop the local private-server stack:

```powershell
.\stop-local-private-server.ps1 -ClearDeviceProxy
```

If DNAT was used, also clear it:

```powershell
.\stop-local-private-server.ps1 -ClearDeviceProxy -ClearIptablesRedirect -RedirectHost <same-host-used-above>
```

Current built-in fixtures:

- `data\fixtures\ws-login-timeline-1.json`: structured local login.
- `data\fixtures\ws-interactions-stage-battle-1.json`: captured stage/battle interactions.
- `data\fixtures\ws-interactions-chat-probe-1.json`: captured chat probe interactions.

Use `-InteractionFixture <path>` to switch or extend replay coverage.

1. Start the stack:

```powershell
cd D:\Project\AFK\local-platform-mock
.\start-stack.ps1 -MitmPort 8082
```

If you only want the HTTP stack and do not want to bind the websocket port locally:

```powershell
.\start-stack.ps1 -MitmPort 8082 -NoWebSocketProxy
```

2. Verify the local service:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18080/__afk/health | Select-Object -ExpandProperty Content
```

3. Set the emulator or device HTTP proxy to the same port you started mitmproxy with:

```text
<your-PC-IP>:8080
```

4. Make sure the mitmproxy CA is already installed on the emulator. This repo already has the CA under `D:\Project\AFK\artifacts\mitmproxy\`.

5. On a rooted emulator, redirect the real game websocket to the local proxy:

```powershell
.\set-device-ws-redirect.ps1 -Serial emulator-5554
```

6. Launch the app and watch:

- `D:\Project\AFK\local-platform-mock\logs\requests.jsonl`
- `D:\Project\AFK\local-platform-mock\logs\ws-frames.jsonl`
- `D:\Project\AFK\local-platform-mock\runtime\mock-service.out.log`
- `D:\Project\AFK\local-platform-mock\runtime\mitmproxy.out.log`
- `D:\Project\AFK\local-platform-mock\runtime\websocket-proxy.out.log`

7. When you are done testing, clear the websocket redirect:

```powershell
.\clear-device-ws-redirect.ps1 -Serial emulator-5554
```

8. To replay a captured websocket login locally instead of forwarding upstream:

```powershell
python .\extract_ws_replay_fixture.py `
  --log-file .\logs\ws-frames.jsonl `
  --session-id 2 `
  --output .\data\fixtures\ws-login-session-2.json

.\stop-stack.ps1
.\start-stack.ps1 -MitmPort 8082 -WsReplayFixture D:\Project\AFK\local-platform-mock\data\fixtures\ws-login-session-2.json

# The replay fixture now preserves the full websocket timeline, including
# server-initiated pushes after login and post-login heartbeat auto-replies.
```

9. To run structured local login plus request-matched local in-game interactions:

```powershell
python .\extract_ws_replay_fixture.py `
  --mode interaction `
  --log-file D:\Project\AFK\artifacts\afkdragon\runtime\chat_probe_after_login\ws-frames_after_chat.jsonl `
  --session-id 1 `
  --output .\data\fixtures\ws-interactions-chat-probe-1.json `
  --write-mysql

.\stop-stack.ps1
.\start-stack.ps1 `
  -MitmPort 8082 `
  -WsStructuredLoginFixture D:\Project\AFK\local-platform-mock\data\fixtures\ws-login-timeline-1.json `
  -WsInteractionDb
```

The interaction rules store request signatures and one or more captured responses per rule. At runtime, the websocket mock matches incoming client requests by route-like protobuf shape and payload fingerprint, patches the response sequence number to the current request, and sends the captured response without contacting upstream. Rules can also mark a response with `business_generator` so the captured payload is only used as a protobuf template while list/content fields are rebuilt from local DB state.

Current DB response generators:

- `stage_assist_summaries`: powers `stage_query_assist_summaries` from `inventory_items`, `characters`, and `stage_progress`.
- `stage_battle_start`: builds battle-start state from the current player and stage state.
- `stage_battle_result`: persists and returns stage-result state.

Structured local mode also implements `tavern_draw`, including the captured official item-13 cost and character/inventory updates.

## Automated validation

Run the self-contained baseline test without an emulator or MySQL:

```powershell
npm test
```

It starts temporary HTTP and WebSocket services, validates health and inventory/character/stage state, then exercises structured login, heartbeat, captured stage interaction replay, and a stateful tavern draw. The draw assertion verifies both the official `item id=13, amount=1` cost and the awarded hero. Temporary processes are stopped automatically.

Official parity is tracked in `docs/official-parity-matrix.md`; evidence-backed values are versioned under `data/official/`.

The captured hero upgrade transaction is available at `POST /__afk/game/heroes/upgrade`. The verified case is hero `1`, level `10 -> 11`; it atomically validates and deducts item `1 x 10`, gold `1116`, and hero EXP `417` before applying level and GS `1110`.

Use `--mysql-only --write-mysql` with `extract_ws_replay_fixture.py --mode interaction` when you want to write rules into `AFK.ws_interaction_rules` without creating a fixture file.

## Control Endpoints

Read current mocked `userstatus`:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18080/__afk/control/userstatus | Select-Object -ExpandProperty Content
```

Update mocked `userstatus`:

```powershell
Invoke-WebRequest `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"last_ticketid":"mock-ticket","need_loop":false,"unack_num":1}' `
  -UseBasicParsing `
  http://127.0.0.1:18080/__afk/control/userstatus
```

Reset mocked state:

```powershell
Invoke-WebRequest -Method Post -UseBasicParsing http://127.0.0.1:18080/__afk/control/reset
```

Monitor platform-currency related traffic:

```powershell
Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:18080/__afk/monitor/platform-currency?limit=50" |
  Select-Object -ExpandProperty Content
```

The monitor scans `logs/requests.jsonl` and `logs/ws-frames.jsonl` for charge/currency-like HTTP records and websocket frames. Add comma-separated custom keywords with `q`, for example:

```powershell
Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:18080/__afk/monitor/platform-currency?q=diamond_charge,vip_exp&limit=100" |
  Select-Object -ExpandProperty Content
```

Stop the stack:

```powershell
.\stop-stack.ps1
```

## Environment Knobs

- `AFK_PROXY_UNKNOWN=0`: disable upstream passthrough and fail on unknown routes
- `AFK_LOCAL_BASE_URL=http://10.0.2.2:18080`: rewrite `base_url.sdk` and `sdk_server_list` in the parkway config
- `AFK_DISABLE_SDK_SLS=0`: keep SDK SLS reporting enabled in the served config
- `AFK_DISABLE_AUTO_LOGIN=1`: turn off `login_auto` in the served config

## Current scope

The stack runs the captured client fully against local HTTP, WebSocket, resources,
accounts, MySQL state and deterministic server authority. Recovered facts remain
separate from local policy: uncaptured production matchmaking, fraud decisions,
live calendars and real-money settlement are configurable local equivalents rather
than claims about unavailable official server internals. Real payment stays in the
signed sandbox flow.
