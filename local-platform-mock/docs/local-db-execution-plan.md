# 本地 MySQL 落地执行文档

## 0. 当前结论

项目数据库名固定为：

```text
AFK
```

MySQL 适合本项目。它比 SQLite 多一个本机服务依赖，但更适合后续的 Pinus 多进程、本地完整后端、账号/玩家/背包/角色/关卡/日志统一持久化。

## 1. 当前已完成

- 已安装 Node 依赖：`mysql2`。
- 已新增建表文件：`D:\Project\AFK\local-platform-mock\db\schema.mysql.sql`。
- 已新增数据库连接层：`D:\Project\AFK\local-platform-mock\db\index.js`。
- 已新增迁移脚本：`D:\Project\AFK\local-platform-mock\db\migrate.js`。
- 已新增脚本命令：`npm run db:migrate`。
- `server.js` 已支持 MySQL 持久化：
  - 启动时读取 `kv_state.userStatus`。
  - `POST /__afk/control/userstatus` 写回 MySQL。
  - `POST /__afk/control/reset` 写回 MySQL。
  - HTTP 请求日志双写到 `request_logs`。
  - MySQL 不可用时自动回退到内存/JSON，不阻塞 mock 服务。
- `websocket_proxy.py` 已支持 WS 帧直接写入 `ws_frame_logs`。
- `extract_ws_replay_fixture.py` 已支持交互规则直接写入 `ws_interaction_rules`。
- `websocket_proxy.py` 已支持从 `ws_interaction_rules` 加载交互规则。
- `websocket_proxy.py` 已支持结构化登录写入 `accounts` / `sessions` / `players`。
- `stage_query_assist_summaries` 已支持从 `players` / `inventory_items` / `characters` / `stage_progress` 生成本地响应。
- 登录后会 seed 默认 `inventory_items` / `characters` / `stage_progress`。
- HTTP mock 已提供业务 DB 管理接口，可直接修改背包、角色、关卡状态。
- `npm run analyze:ws` 可扫描现有 WS 日志里的请求 kind。

## 2. 连接配置

推荐 PowerShell 环境变量：

```powershell
$env:AFK_DB_HOST = "127.0.0.1"
$env:AFK_DB_PORT = "3306"
$env:AFK_DB_USER = "root"
$env:AFK_DB_PASSWORD = "你的MySQL密码"
$env:AFK_DB_NAME = "AFK"
```

也可以使用 URL：

```powershell
$env:AFK_DB_URL = "mysql://root:你的MySQL密码@127.0.0.1:3306/AFK"
```

临时禁用 DB：

```powershell
$env:AFK_DB_ENABLED = "0"
```

## 3. 初始化数据库

当前本机 MySQL 服务已运行，但 root 空密码连接失败，所以需要填入你的 root 密码。

推荐一键初始化：

```powershell
cd D:\Project\AFK\local-platform-mock
.\init-mysql.ps1
```

也可以手动执行：

```powershell
cd D:\Project\AFK\local-platform-mock
$env:AFK_DB_PASSWORD = "你的MySQL密码"
npm run db:migrate
```

迁移成功后验证：

```powershell
mysql -h 127.0.0.1 -P 3306 -u root -p -D AFK -e "SHOW TABLES;"
```

预期表包括：

- `kv_state`
- `accounts`
- `sessions`
- `players`
- `inventory_items`
- `characters`
- `stage_progress`
- `chat_messages`
- `request_logs`
- `ws_frame_logs`
- `ws_interaction_rules`

## 4. 第一阶段验证

启动 mock：

```powershell
cd D:\Project\AFK\local-platform-mock
$env:AFK_DB_PASSWORD = "你的MySQL密码"
.\start-stack.ps1 `
  -MitmPort 8082 `
  -WsStructuredLoginFixture D:\Project\AFK\local-platform-mock\data\fixtures\ws-login-timeline-1.json `
  -WsInteractionDb
```

检查健康状态：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18080/__afk/health |
  Select-Object -ExpandProperty Content
```

预期 JSON 中：

```json
"db":{"enabled":true,"ready":true,"name":"AFK","error":null}
```

写入 `userStatus`：

```powershell
Invoke-WebRequest `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"last_ticketid":"mysql-ticket","need_loop":false,"unack_num":2}' `
  -UseBasicParsing `
  http://127.0.0.1:18080/__afk/control/userstatus
```

重启 stack：

```powershell
.\stop-stack.ps1
$env:AFK_DB_PASSWORD = "你的MySQL密码"
.\start-stack.ps1 -MitmPort 8082
```

再次读取：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18080/__afk/control/userstatus |
  Select-Object -ExpandProperty Content
```

预期仍能看到：

```json
"last_ticketid":"mysql-ticket"
```

验证 HTTP 日志入库：

```powershell
mysql -h 127.0.0.1 -P 3306 -u root -p -D AFK -e "SELECT COUNT(*) FROM request_logs;"
```

验证 WS 日志直接入库：

```powershell
mysql -h 127.0.0.1 -P 3306 -u root -p -D AFK -e "SELECT COUNT(*) FROM ws_frame_logs;"
```

把交互规则直接写入 MySQL：

```powershell
cd D:\Project\AFK\local-platform-mock
$env:AFK_DB_PASSWORD = "你的MySQL密码"
python .\extract_ws_replay_fixture.py `
  --mode interaction `
  --log-file D:\Project\AFK\artifacts\afkdragon\runtime\chat_probe_after_login\ws-frames_after_chat.jsonl `
  --session-id 1 `
  --output .\data\fixtures\ws-interactions-chat-probe-1.json `
  --write-mysql
```

只写 MySQL、不生成 fixture 文件：

```powershell
python .\extract_ws_replay_fixture.py `
  --mode interaction `
  --log-file D:\Project\AFK\artifacts\afkdragon\runtime\chat_probe_after_login\ws-frames_after_chat.jsonl `
  --session-id 1 `
  --mysql-only `
  --write-mysql
```

验证规则入库：

```powershell
mysql -h 127.0.0.1 -P 3306 -u root -p -D AFK -e "SELECT id, rule_name, enabled, priority FROM ws_interaction_rules;"
```

使用 MySQL 规则驱动 WS 回放：

```powershell
cd D:\Project\AFK\local-platform-mock
$env:AFK_DB_PASSWORD = "你的MySQL密码"
.\stop-stack.ps1
.\start-stack.ps1 `
  -MitmPort 8082 `
  -WsStructuredLoginFixture D:\Project\AFK\local-platform-mock\data\fixtures\ws-login-timeline-1.json `
  -WsInteractionDb
npm run validate:ws
```

验证登录入库：

```powershell
mysql -h 127.0.0.1 -P 3306 -u root -p -D AFK -e "SELECT id, provider, provider_uid, display_name FROM accounts ORDER BY id DESC LIMIT 5;"
mysql -h 127.0.0.1 -P 3306 -u root -p -D AFK -e "SELECT id, account_id, session_token, last_ticketid, status FROM sessions ORDER BY id DESC LIMIT 5;"
mysql -h 127.0.0.1 -P 3306 -u root -p -D AFK -e "SELECT id, account_id, player_uid, nickname FROM players ORDER BY id DESC LIMIT 5;"
```

验证业务表和 DB 生成响应：

```powershell
mysql -h 127.0.0.1 -P 3306 -u root -p -D AFK -e "SELECT item_id, quantity FROM inventory_items;"
mysql -h 127.0.0.1 -P 3306 -u root -p -D AFK -e "SELECT character_id, level, star, JSON_EXTRACT(extra_json, '$.assist_uid') AS assist_uid FROM characters;"
mysql -h 127.0.0.1 -P 3306 -u root -p -D AFK -e "SELECT direction, route, sequence_id, JSON_UNQUOTE(JSON_EXTRACT(frame_json, '$.fixture_label')) AS label, JSON_EXTRACT(frame_json, '$.size') AS size FROM ws_frame_logs ORDER BY id DESC LIMIT 8;"
```

预期 `label` 能看到 `db_stage_assist_summaries`，表示响应来自 DB 业务状态，而不是固定 fixture。

## 5. 业务 DB 管理接口

读取当前业务状态：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18080/__afk/db/business-state |
  Select-Object -ExpandProperty Content
```

修改背包物品：

```powershell
Invoke-WebRequest `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"item_id":"gold","quantity":999999,"extra":{"source":"manual"}}' `
  -UseBasicParsing `
  http://127.0.0.1:18080/__afk/db/inventory
```

修改助战角色，下一次 `stage_query_assist_summaries` 响应会立刻受影响：

```powershell
Invoke-WebRequest `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"character_id":"assist_99999","level":66,"star":5,"extra":{"assist_uid":99999,"hero_id":88,"avatar":"avatar:102","power":88888,"title":"本地","title_id":1,"title_quality":3}}' `
  -UseBasicParsing `
  http://127.0.0.1:18080/__afk/db/characters
```

修改关卡进度：

```powershell
Invoke-WebRequest `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"stage_id":"stage_query_assist_summaries","best_result_json":{"assist_summary_limit":6,"source":"manual"},"cleared":true}' `
  -UseBasicParsing `
  http://127.0.0.1:18080/__afk/db/stages
```

分析 WS 日志里还有哪些请求：

```powershell
cd D:\Project\AFK\local-platform-mock
npm run analyze:ws
```

## 6. 交互规则接业务 DB 生成器

现在交互规则支持在单条 response 上声明：

```json
{
  "business_generator": "stage_assist_summaries",
  "business_label": "db_stage_assist_summaries",
  "business_tables": ["players", "inventory_items", "characters", "stage_progress"]
}
```

执行规则：

- 捕获响应仍作为 protobuf 模板。
- `business_generator` 负责把模板里的业务列表/字段替换成本地 DB 状态。
- 未实现的 generator 会自动回退到原 fixture 响应，不会中断回放。

当前已实现：

- `stage_assist_summaries`
  - 请求：`stage_query_assist_summaries`
  - 读表：`players` / `inventory_items` / `characters` / `stage_progress`
  - 行为：
    - `characters` 生成助战角色列表。
    - `stage_progress.best_result_json.assist_summary_limit` 控制返回数量。
    - `inventory_items.stage_ticket.quantity` 写入可借用次数。
- `stage_battle_start`
  - 从当前玩家与关卡状态生成战斗开始响应。
- `stage_battle_result`
  - 将战斗结算结果写回并生成对应响应。
- 结构化本地模式另有 `tavern_draw`
  - 按实机抓包扣除 `item id=13, amount=1`，并将奖励角色 `tavern_hero_1005` 写入角色状态。
  - `npm test` 会在无 MySQL 模式下验证该完整状态变更。

继续接背包、角色、关卡结算的执行步骤：

1. 启动带上游代理的 stack，真实操作目标功能。
2. 用 `npm run analyze:ws` 找到新增请求 kind；如果仍是 `unknown_binary`，先补 `parse_client_message_kind` 的 protobuf 路由识别。
3. 用 `extract_ws_replay_fixture.py --mode interaction --write-mysql` 把请求/响应写入 `ws_interaction_rules`。
4. 在 `websocket_proxy.py` 的 `BUSINESS_RESPONSE_GENERATORS` 增加 generator 名称、匹配 kind、label、tables。
5. 在 `BusinessStateProvider.build_response()` 分支里实现对应模板替换逻辑。
6. 给 response 加 `business_generator`，或让 `extract_ws_replay_fixture.py` 自动按 kind 标记。
7. 重启 `-WsInteractionDb`，执行真实客户端动作，查 `ws_frame_logs.frame_json` 是否出现 `business_response_generated`。

## 7. 当前实现状态

本轮目标的状态事务已经统一由 `/__afk/game/action`、专用抽卡/成长/关卡接口和 WebSocket 协议层驱动，覆盖英雄成长、主线、挂机、任务、商店、邮件背包、酒馆十连以及竞技场/塔/迷宫/公会。MySQL 可用时写入表；当前开发机没有可用凭据时自动使用同结构的内存状态，因此前端和协议测试不被数据库服务阻塞。

仍在目标范围之外的是聊天、战令、竞技场记录/购票、公会 Boss 以及迷宫全部遗物商店分支。它们需要新的官方流量证据，不能用猜测值冒充官方行为。

## 8. 后续扩展准则

1. 先捕获目标版本的真实请求与响应。
2. 补充 protobuf 路由、官方配置来源和原子状态事务。
3. 同时增加协议单测、状态单测和端到端集成测试。
4. 最后在模拟器中完成可见 UI 闭环，并把证据等级更新到 `official-parity-matrix.md`。
