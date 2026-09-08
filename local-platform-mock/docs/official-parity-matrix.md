# Official parity matrix — client 1.182.03.301371

“Official” means reproduced from this exact client version using captured protobuf traffic, decoded client logs, decrypted client configuration, or exact official CDN files. Local deterministic extensions are identified explicitly.

| Target loop | Evidence and implementation | Validation | Status |
|---|---|---|---|
| Startup, login, reconnect, heartbeat | Captured binary timelines; local state is injected into the official login shape | Python protocol + integration + emulator | Implemented |
| General hero growth | Captured level-up request/reply and exact level costs; quality, equipment removal/wear, and lock routes use recovered schemas and persistent hero state | Unit + WebSocket integration + emulator relog | Implemented |
| Campaign victory, reward, progression | Recovered stage start/end routes; victory advances `meta_campaign_cur_stage` once and grants decrypted `StageIdle`/boss rewards, defeat does not advance | Unit + integration | Implemented |
| Idle rewards | Captured query/claim/quick-idle shapes; stage-13 rates and 120-minute quick-idle window come from decrypted configuration | Unit + protocol + emulator | Implemented |
| General tasks | Captured batch `[1,4,5,6]`; task info, single/batch claims, and configured activity chests persist markers and rewards | Unit + protocol + integration + emulator UI | Implemented |
| Shop purchase | Recovered shop open/buy/refresh schemas; catalog and goods come from `ShopGoods`/`ShopGroup`; cost/reward mutations are atomic | Unit + protocol + integration | Implemented; uncaptured price fallback remains explicitly local for rows without `SpecialCost` |
| Mail and inventory | Recovered list/read/receive/receive-all and item-use routes; read/receive markers and assets persist | Unit + protocol + integration + emulator | Implemented; local seed mail text is deterministic fixture content |
| Tavern single and ten pull | Captured draw route; ten-pull returns ten unique entity IDs, costs ten tickets, tracks pity/duplicates, and completes the automatic altar-disband request | Unit + integration + emulator card reveal | Implemented end-to-end; pool probability/pity policy beyond the captured single draw is a configurable local extension |
| Arena | Recovered open/refresh/query-lineup/challenge/record shapes; 120 persistent bots use official Unit tables for five-hero teams and server-authoritative settlement | Unit + protocol + MySQL integration | Implemented with local bot matchmaking and replay records |
| King’s Tower | Recovered open/start/end/retry shapes; floor rewards come from `StageTower`, victory advances floor | Unit + protocol + integration | Implemented target loop |
| Arcane Labyrinth | Recovered open/query/move/start/end routes; adjacency and rewards come from `MazeCell` | Unit + protocol + integration | Implemented target loop |
| Guild | Recovered open/create/search/join/leave/member shapes; six persistent bot guilds expose populated rosters and boss activity | Unit + protocol + MySQL integration | Implemented with local bot ecology |
| Resource delivery | Installed tree, hot-update cache, APK fallback, PPZ rebuild, and exact official-CDN read-through cache | Unit + live emulator asset load | Implemented |
| MySQL persistence | Dedicated project MySQL, migration schema, login/game mutation persistence, restart survival, logical backup/restore | MySQL integration + redeploy | Implemented and deployed |
| Authoritative battle | Server creates campaign/tower/maze battle records from recovered lineup schemas and decrypted official unit/stage configuration; progression consumes only the server result | Unit + anti-forgery integration | Implemented; deterministic local simulator, not a claim of official engine source parity |
| Accounts and GM | Salted scrypt credentials, expiring bearer sessions, roles/bans, audited asset/stage/mail/reset actions | Unit + MySQL integration | Implemented and deployed; bootstrap credentials are local-development defaults |
| Periodic activities | Idempotent daily/weekly/28-day scheduler, login rewards, arena/todo/guild reset state, battle-pass progress and claims | Unit + MySQL integration | Implemented as a deterministic local live-operations policy |
| Extended systems | Arena tickets/records, tower records/assists, maze relic/shop/give-up, guild bosses, chat, friendships, bot suggestions and bot chat replies | Unit + protocol + MySQL integration | Implemented as recovered-schema or explicitly local deterministic extensions |
| Instant recharge | Recovered Charge and 161 visible ChargeGoods rows; native pay bridge bypasses the store, grants the selected resources transactionally, reports success to the existing callback, and prevents duplicate fulfillment | Unit + protobuf + MySQL integration + native bridge attach | Implemented as local instant-grant test policy; no real-money payment or official receipt |
| Deployment operations | One-command deploy, health supervisor, recovery cooldown, daily backup, guarded restore, emulator routing | Full stack health + live emulator | Implemented and deployed |

The extended surfaces above are available locally. Where exact traffic or policy was
not captured, they remain explicitly identified as deterministic local behavior and
are not presented as evidence of one-to-one official server internals.

Evidence-backed runtime values are versioned in `data/official/v1.182.03.301371.json`. Unknown official values stay labeled as local extensions instead of being presented as captured facts.
