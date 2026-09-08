const { loadConfig } = require("./official-config-catalog");
const SHOP_GOODS = loadConfig("ShopGoods").table;
const SHOP_GROUPS = loadConfig("ShopGroup").table;
const TASK_CHESTS = loadConfig("TaskTodoChest").table;
const TOWER_FLOORS = loadConfig("StageTower").table;
const MAZE_CELLS = loadConfig("MazeCell").table;
const MAZE_CELL_TYPES = loadConfig("MazeCellType").table;
const MAZE_MAPS = loadConfig("MazeMap").table;
const UNIT_LEVELS = loadConfig("UnitLevel").table;
const UNITS = loadConfig("Unit").table;
const UNIT_QUALITIES = loadConfig("UnitQuality").table;
const EQUIPMENT = loadConfig("Equip").table;
const EQUIP_QUALITIES = loadConfig("EquipQuality").table;
const EQUIP_ENHANCEMENT = loadConfig("EquipEnhancement").table;
const EQUIP_ENHANCE_ITEMS = loadConfig("EquipEnhanceItem").table;
const COST_SETS = loadConfig("CostSet").table;
const EQUIP_RESONATE = loadConfig("EquipResonate").table;
const PARAMS = loadConfig("Param").table;
const { battlePassClaim, battlePassProgress, dailyLoginClaim, runDueResets } = require("./liveops-service");
const guildDomain = require("./guild-domain-service");

const CURRENCY_IDS = {
  gold: 10000001, diamond: 10000002, diamond_charge: 10000003,
  hero_exp: 10000004, player_exp: 10000006, exp: 10000006,
  guild_coin: 10000007, maze_coin: 10000008, friend_coin: 10000011,
};

function normalizeName(value) {
  const text = String(value || "");
  const aliases = { Gold: "gold", Diamond: "diamond", HeroExp: "hero_exp", Exp: "player_exp" };
  return aliases[text] || text.toLowerCase();
}

function asset(type, id, amount) {
  const rawKind = String(type || "").toLowerCase();
  const kind = { battlepassexp: "battle_pass_exp", dailyvariable: "daily_variable" }[rawKind] || rawKind;
  if (kind === "currency") return { type: "currency", id: normalizeName(id), amount: Number(amount) };
  return { type: kind === "item" ? "item" : kind, id: Number(id), amount: Number(amount) };
}

function parseAssets(tokens = []) {
  const result = [];
  for (let index = 0; index + 2 < tokens.length; index += 3) {
    const parsed = asset(tokens[index], tokens[index + 1], tokens[index + 2]);
    if (Number.isFinite(parsed.amount) && parsed.amount > 0) result.push(parsed);
  }
  return result;
}

function keyOf(entry) {
  return entry.type === "currency" ? String(entry.id) : `${entry.type}_${entry.id}`;
}

function quantity(state, key) {
  return Number((state.inventory || []).find((row) => String(row.item_id) === String(key))?.quantity || 0);
}

function meta(state, key, fallback = 0) { return quantity(state, `meta_${key}`) || fallback; }

function inventoryRow(state, key) {
  return (state.inventory || []).find((row) => String(row.item_id) === String(key)) || null;
}

function mutateAssets(state, costs = [], rewards = [], source = "game_action") {
  const totals = new Map();
  const mutationFor = (entry, sign) => {
    const key = keyOf(entry);
    const before = totals.has(key) ? totals.get(key) : quantity(state, key);
    const after = before + sign * Number(entry.amount);
    if (after < 0) return { ok: false, error: "insufficient_asset", asset: entry, available: before };
    totals.set(key, after);
    return null;
  };
  for (const entry of costs) {
    const failure = mutationFor(entry, -1);
    if (failure) return failure;
  }
  for (const entry of rewards) mutationFor(entry, 1);
  return {
    ok: true,
    inventory: Array.from(totals, ([item_id, value]) => ({
      item_id, quantity: value, extra: { source, evidence_level: "decrypted_official_client_config" },
    })),
  };
}

function taskInfo(state) {
  const dailyIds = [1, 4, 5, 6];
  return {
    ok: true,
    task_info: {
      daily_point: meta(state, "task_daily_point", 100), weekly_point: meta(state, "task_weekly_point", 100),
      daily_recved_chests: dailyIds.filter((id) => meta(state, `task_chest_${id}`) > 0),
      weekly_recved_chests: [],
      daily_todolists: dailyIds.map((id) => ({ id, target_progress: meta(state, `daily_todo_${id}`, 1) })),
      weekly_todolists: [], line_tasklists: [], recent_daily_points: [100],
    },
  };
}

function claimTask(state, ids = []) {
  const clean = [...new Set(ids.map(Number))].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!clean.length) return { ok: false, status: 422, error: "invalid_task_ids" };
  const duplicate = clean.find((id) => meta(state, `task_claim_${id}`) > 0);
  if (duplicate) return { ok: false, status: 409, error: "task_already_claimed", task_id: duplicate };
  return {
    ok: true, ids: clean, rewards: [],
    inventory: clean.map((id) => ({ item_id: `meta_task_claim_${id}`, quantity: 1, extra: { source: "task_claim" } })),
  };
}

function claimTaskChest(state, chestIds = []) {
  const clean = [...new Set(chestIds.map(Number))].filter((id) => TASK_CHESTS[String(id)]);
  if (!clean.length) return { ok: false, status: 422, error: "unknown_task_chest" };
  const duplicate = clean.find((id) => meta(state, `task_chest_${id}`) > 0);
  if (duplicate) return { ok: false, status: 409, error: "task_chest_already_claimed", chest_id: duplicate };
  const rewards = clean.flatMap((id) => parseAssets(TASK_CHESTS[String(id)].Rewards));
  const transition = mutateAssets(state, [], rewards, "task_chest");
  if (!transition.ok) return transition;
  transition.inventory.push(...clean.map((id) => ({ item_id: `meta_task_chest_${id}`, quantity: 1, extra: { source: "task_chest" } })));
  return { ...transition, chest_ids: clean, rewards };
}

function shopGroupFor(groupId, stageId) {
  const matches = Object.values(SHOP_GROUPS)
    .filter((row) => Number(row.GroupID) === Number(groupId) && Number(row.StageRange || 0) <= stageId)
    .sort((a, b) => Number(b.StageRange || 0) - Number(a.StageRange || 0));
  return matches[0] || null;
}

function shopCatalog(state, shopId) {
  const configured = SHOP_GOODS[String(shopId)] || {};
  const stageId = meta(state, "campaign_cur_stage", 13);
  const goods = Object.values(configured).map((slot) => {
    const row = shopGroupFor(slot.GroupID, stageId);
    if (!row) return null;
    const rewards = parseAssets(row.Goods);
    const special = parseAssets(row.SpecialCost);
    const currency = normalizeName(row.Currency || "gold");
    const cost = special[0] || asset("currency", currency, Number(row.PriceDiscountPercent || 0));
    return {
      index: Number(slot.GoodsID), group_tid: Number(row.ID), good: rewards[0], rewards,
      cost, discount_pct: Number(row.DisplayDiscount || 100),
      is_sold: meta(state, `shop_${shopId}_${slot.GoodsID}_bought`) > 0,
    };
  }).filter(Boolean);
  return { ok: true, shop_id: Number(shopId), goods, refresh_times: meta(state, `shop_${shopId}_refresh`) };
}

function buyShopGood(state, shopId, index, count = 1) {
  const catalog = shopCatalog(state, shopId);
  const good = catalog.goods.find((entry) => entry.index === Number(index));
  if (!good) return { ok: false, status: 404, error: "shop_good_not_found" };
  if (good.is_sold) return { ok: false, status: 409, error: "shop_good_sold" };
  const num = Math.max(1, Number(count));
  const costs = [{ ...good.cost, amount: good.cost.amount * num }];
  const rewards = good.rewards.map((entry) => ({ ...entry, amount: entry.amount * num }));
  const transition = mutateAssets(state, costs, rewards, "shop_purchase");
  if (!transition.ok) return { ...transition, status: 409 };
  transition.inventory.push({ item_id: `meta_shop_${shopId}_${index}_bought`, quantity: num, extra: { source: "shop_purchase" } });
  return { ...transition, shop_id: Number(shopId), index: Number(index), cost: costs, rewards, sell_good: { ...good, is_sold: true } };
}

const DEFAULT_MAILS = [
  { id: 1, type_id: 0, from: "伊索米亚", title: "欢迎归来", body: "这是为本地冒险准备的补给。", assets: [asset("currency", "diamond", 300)] },
  { id: 2, type_id: 4, from: "系统", title: "召唤补给", body: "十连召唤券已送达。", assets: [asset("item", 13, 10)] },
];

function mailList(state, ids = []) {
  const wanted = ids.length ? new Set(ids.map(Number)) : null;
  return { ok: true, mails: DEFAULT_MAILS.filter((mail) => !wanted || wanted.has(mail.id)).map((mail) => ({
    ...mail, status: meta(state, `mail_${mail.id}_read`) ? 2 : 1,
    is_assets_rcvd: meta(state, `mail_${mail.id}_received`) > 0,
  })) };
}

function readMail(state, id) {
  if (!DEFAULT_MAILS.some((mail) => mail.id === Number(id))) return { ok: false, status: 404, error: "mail_not_found" };
  return { ok: true, inventory: [{ item_id: `meta_mail_${id}_read`, quantity: 1, extra: { source: "mail_read" } }] };
}

function receiveMail(state, ids) {
  const selected = DEFAULT_MAILS.filter((mail) => ids.includes(mail.id));
  const duplicate = selected.find((mail) => meta(state, `mail_${mail.id}_received`) > 0);
  if (!selected.length) return { ok: false, status: 404, error: "mail_not_found" };
  if (duplicate) return { ok: false, status: 409, error: "mail_reward_received", mail_id: duplicate.id };
  const rewards = selected.flatMap((mail) => mail.assets);
  const transition = mutateAssets(state, [], rewards, "mail_reward");
  transition.inventory.push(...selected.flatMap((mail) => [
    { item_id: `meta_mail_${mail.id}_read`, quantity: 1, extra: { source: "mail_reward" } },
    { item_id: `meta_mail_${mail.id}_received`, quantity: 1, extra: { source: "mail_reward" } },
  ]));
  return { ...transition, mails: selected, rewards };
}

function towerOpen(state) { return { ok: true, floor_id: meta(state, "tower_floor", 1), type: 1 }; }
function towerWin(state) {
  const floorId = meta(state, "tower_floor", 1);
  const row = TOWER_FLOORS[String(floorId)];
  if (!row) return { ok: false, status: 409, error: "tower_complete" };
  const rewards = parseAssets(row.Rewards);
  const transition = mutateAssets(state, [], rewards, "tower_victory");
  transition.inventory.push({ item_id: "meta_tower_floor", quantity: floorId + 1, extra: { source: "tower_victory" } });
  return { ...transition, battle_result: 1, floor_id: floorId + 1, rewards };
}

function arenaOpen(state, opponents = []) { return { ok: true, rank: meta(state, "arena_rank", 100), point: meta(state, "arena_point", 1000), ticket: quantity(state, "arena_ticket") || 5, opponents }; }
function arenaChallenge(state, victory = true, opponent = null) {
  const oldPoint = meta(state, "arena_point", 1000), oldRank = meta(state, "arena_rank", 100);
  const point = Math.max(0, oldPoint + (victory ? 10 : -2)), rank = Math.max(1, oldRank + (victory ? -1 : 1));
  return { ok: true, battle_result: victory ? 1 : 2, old_point: oldPoint, old_rank: oldRank, point, rank, opponent,
    inventory: [
      { item_id: "meta_arena_point", quantity: point, extra: { source: "arena" } },
      { item_id: "meta_arena_rank", quantity: rank, extra: { source: "arena" } },
    ] };
}
function arenaBuyTicket(state, count = 1) {
  const amount = Math.max(1, Math.min(20, Number(count || 1)));
  const cost = asset("currency", "diamond", amount * 20);
  const reward = { type: "currency", id: "arena_ticket", amount };
  const transition = mutateAssets(state, [cost], [reward], "arena_ticket_purchase");
  return { ...transition, count: amount, cost: [cost], rewards: [reward] };
}
function arenaRecords(state, botRecords = []) {
  if (Array.isArray(botRecords) && botRecords.length) return { ok: true, records: botRecords };
  const rank = meta(state, "arena_rank", 100), point = meta(state, "arena_point", 1000);
  return { ok: true, records: [
    { id: 1, opponent_uid: 90001, opponent_name: "本地守卫", result: 1, point_delta: 10, rank, point },
    { id: 2, opponent_uid: 90002, opponent_name: "王城卫队", result: 2, point_delta: -2, rank: rank + 1, point: Math.max(0, point - 2) },
  ] };
}

const MAZE_CYCLE_SECONDS = 2 * 86400;
const MAZE_TYPE_IDS = { normal: 0, elite: 1, hot_spring: 2, boss: 3, empty: 4, start: 5, mystic: 6, peddler: 7, thief: 8, carriage: 9, goblin: 10, bloody_carriage: 11 };
const MAZE_BATTLE_TYPES = new Set(["normal", "elite", "boss", "goblin", "bloody_carriage"]);

function mazeCycle(nowTs = Math.floor(Date.now() / 1000)) {
  const now = Math.max(0, Number(nowTs || 0));
  const id = Math.floor(now / MAZE_CYCLE_SECONDS);
  return { id, reset_at: (id + 1) * MAZE_CYCLE_SECONDS };
}

function mazeShop(cellId) {
  const base = Number(cellId) % 3;
  const goods = [
    { index: 1, good: asset("item", 13, 1), cost: asset("currency", "maze_coin", 300 + base * 25), discount_pct: 100, is_sold: false, group_tid: 0 },
    { index: 2, good: asset("item", 40, 1), cost: asset("currency", "maze_coin", 450 + base * 25), discount_pct: 100, is_sold: false, group_tid: 0 },
    // The classic MazeMiniShop only renders item/equipment rewards. Supplying a
    // currency here makes the client route the id through the equipment table,
    // leaving an empty slot and throwing while building the render node.
    { index: 3, good: asset("item", 13, 2), cost: asset("currency", "maze_coin", 600 + base * 25), discount_pct: 100, is_sold: false, group_tid: 0 },
  ];
  return { id: Number(cellId), refresh_times: 0, goods };
}

function mazeAssistHeroes(cellId) {
  const base = 6_000_000 + Number(cellId) * 10;
  return [22, 31, 17, 39].map((tid, index) => ({
    id: base + index + 1,
    hero_id: base + index + 1,
    tid,
    quality: 8,
    rank: 10,
    level: 240,
    gs: 120000 + index * 7500,
  }));
}

function weightedRelicIds(type) {
  const source = MAZE_CELL_TYPES[type]?.Heirlooms || MAZE_CELL_TYPES.normal.Heirlooms || [];
  const ids = [];
  for (let index = 0; index + 1 < source.length; index += 2) {
    const id = Number(source[index]);
    if (id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function mazeRelicPool(type, cellId, cycleId, owned = []) {
  const candidates = weightedRelicIds(type).filter((id) => !owned.includes(id));
  if (!candidates.length) return [];
  const offset = Math.abs((Number(cellId) * 37 + Number(cycleId) * 17) % candidates.length);
  return Array.from({ length: Math.min(3, candidates.length) }, (_, index) => candidates[(offset + index * 13) % candidates.length]);
}

function mapRoomTypes(mapId) {
  const map = MAZE_MAPS[String(mapId)] || MAZE_MAPS["1"];
  const expanded = [];
  for (let index = 0; index + 1 < (map.RandomCells || []).length; index += 2) {
    for (let count = 0; count < Number(map.RandomCells[index + 1] || 0); count += 1) expanded.push(String(map.RandomCells[index]));
  }
  // Classic maps no longer advertise the old merchant in RandomCells, but the
  // 1.201 UI and protocol still expose it. Preserve one deterministic merchant
  // per floor by replacing an empty room.
  const emptyIndex = expanded.indexOf("empty");
  if (emptyIndex >= 0) expanded[emptyIndex] = "peddler";
  return expanded;
}

function seededRandom(seed) {
  let value = Number(seed) >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, seed) {
  const result = [...values], random = seededRandom(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function mazeLayoutIsPlayable(rows, typeById, startCell, endCell) {
  const rowById = new Map(rows.map((row) => [Number(row.ID), row]));
  const canReachEnd = new Map();
  const visit = (id) => {
    if (Number(id) === Number(endCell)) return true;
    if (canReachEnd.has(id)) return canReachEnd.get(id);
    // Maze rows are acyclic and always point upwards. Set the provisional value
    // so malformed future configs cannot recurse forever.
    canReachEnd.set(id, false);
    const next = (rowById.get(Number(id))?.To || []).map(Number)
      .filter((nextId) => typeById.get(nextId) !== "empty");
    const playable = next.length > 0 && next.every((nextId) => visit(nextId));
    canReachEnd.set(id, playable);
    return playable;
  };
  return visit(Number(startCell));
}

function buildMazeMapCells(mapId, cycleId) {
  const map = MAZE_MAPS[String(mapId)] || MAZE_MAPS["1"];
  const rows = Object.values(MAZE_CELLS).filter((row) => Number(row.Map) === Number(mapId)).sort((a, b) => Number(a.ID) - Number(b.ID));
  const randomRows = rows.filter((row) => Number(row.ID) !== Number(map.StartCell) && Number(row.ID) !== Number(map.EndCell));
  const configuredRooms = mapRoomTypes(mapId);
  const roomTypes = [...configuredRooms, ...Array.from({ length: Math.max(0, randomRows.length - configuredRooms.length) }, () => "normal")];
  let typeById = null;
  // The official client hides `empty` cells completely. Keep shuffling until
  // every selectable branch remains connected to the boss, otherwise a valid
  // player choice can strand the run behind an invisible cell.
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const rowOrder = shuffled(randomRows, Number(cycleId) * 131 + Number(mapId) * 977 + attempt * 7919);
    const rooms = shuffled(roomTypes, Number(cycleId) * 313 + Number(mapId) * 2017 + attempt * 104729);
    const candidate = new Map(rows.map((row) => [Number(row.ID), String(row.DefultType || "normal")]));
    rowOrder.forEach((row, index) => candidate.set(Number(row.ID), rooms[index] || "normal"));
    if (mazeLayoutIsPlayable(rows, candidate, map.StartCell, map.EndCell)) { typeById = candidate; break; }
  }
  // Extremely defensive fallback: all-normal is always traversable and keeps
  // the run usable even if a future map config cannot satisfy the constraints.
  if (!typeById) typeById = new Map(rows.map((row) => [Number(row.ID), String(row.DefultType || "normal")]));
  return rows.map((row) => {
    const type = typeById.get(Number(row.ID)) || String(row.DefultType || "normal");
    const cell = { id: Number(row.ID), map_id: Number(mapId), type, type_id: MAZE_TYPE_IDS[type] ?? 0, status: type === "start" ? 1 : 0,
      assets: parseAssets(row.StaticRewards || []), heirloom_pool: [], picked_heirlooms: [], special_reward: false, attempts: 0, settled_battle_ids: [] };
    if (type === "peddler") cell.shop = mazeShop(row.ID);
    if (type === "carriage") cell.assist_heroes = mazeAssistHeroes(row.ID);
    return cell;
  });
}

function createMazeRun(state, nowTs, previous = null) {
  const cycle = mazeCycle(nowTs);
  const mapId = 1;
  const map = MAZE_MAPS[String(mapId)];
  const legacyCell = Math.max(1, meta(state, "maze_cell", Number(map.StartCell)));
  const legacyFloor = Math.max(1, meta(state, "maze_floor", 1));
  return {
    version: 3, cycle_id: cycle.id, reset_at: cycle.reset_at, id: Number(previous?.id || 1), counter: Number(previous?.counter || 0) + (previous ? 1 : 0),
    map_id: mapId, floor_id: 1, cell_id: legacyFloor === 1 && legacyCell <= Number(map.EndCell) ? legacyCell : Number(map.StartCell),
    gs: Number(state.player?.power || 6000), cells: buildMazeMapCells(mapId, cycle.id), path: [], heirlooms: [], heirloom_stacks: {}, assist_heroes: [],
    passed_times: Number(previous?.passed_times || meta(state, "maze_passed_times", 0)), battle_victory_times: 0,
    active_battle: null, last_battle: null, completed: false, final_claimed: false,
  };
}

function readMazeRun(state, nowTs = Math.floor(Date.now() / 1000)) {
  const row = inventoryRow(state, "meta_maze_run");
  let stored = row?.extra_json?.run || row?.extra?.run || row?.extra_json || row?.extra || null;
  if (typeof stored === "string") { try { stored = JSON.parse(stored); } catch { stored = null; } }
  const cycle = mazeCycle(nowTs);
  if (!stored || Number(stored.version || 0) < 3 || Number(stored.cycle_id) !== cycle.id || Number(stored.reset_at || 0) <= Number(nowTs)) {
    return createMazeRun(state, nowTs, stored);
  }
  const run = JSON.parse(JSON.stringify(stored));
  run.assist_heroes = Array.isArray(run.assist_heroes) ? run.assist_heroes : [];
  // `maze.path` is consumed by the classic client as a list of cells in the
  // currently rendered map.  Old-floor ids make getAllSameRowCell receive an
  // undefined cell and crash the map view, so repair legacy stored runs too.
  const currentCellIds = new Set((run.cells || []).map((cell) => Number(cell.id)));
  run.path = (Array.isArray(run.path) ? run.path : []).map(Number).filter((id) => currentCellIds.has(id));
  for (const cell of run.cells || []) {
    if (cell.type === "carriage" && !(cell.assist_heroes || []).length && Number(cell.status) !== 1) {
      cell.assist_heroes = mazeAssistHeroes(cell.id);
    }
  }
  return run;
}

function mazeRunItem(run, source) {
  return { item_id: "meta_maze_run", quantity: Number(run.cycle_id), extra: { source, run } };
}

function mazeCell(run, cellId = run.cell_id) { return (run.cells || []).find((cell) => Number(cell.id) === Number(cellId)); }
function mazeActionResult(run, source, extra = {}) {
  const cell = mazeCell(run);
  return { ok: true, maze: run, floor_id: run.floor_id, map_id: run.map_id, cell_id: run.cell_id, cell, reset_at: run.reset_at,
    passed_times: run.passed_times, heirlooms: run.heirlooms || [], relic_effects: mazeRelicEffects(run), inventory: [mazeRunItem(run, source)], ...extra };
}

function mazeRelicEffects(run) {
  const stacks = Object.values(run.heirloom_stacks || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  const rare = (run.heirlooms || []).filter((id) => Number(id) % 3 === 1).length;
  return { stack_count: stacks, atk_pct: stacks * 3 + rare * 2, hp_pct: stacks * 4, haste: Math.min(30, stacks * 2) };
}

function mazeOpen(state, nowTs) {
  const run = readMazeRun(state, nowTs);
  return mazeActionResult(run, "maze_open", { reset: !inventoryRow(state, "meta_maze_run") || Number(inventoryRow(state, "meta_maze_run")?.quantity) !== Number(run.cycle_id) });
}

function mazeQuery(state, cellId, nowTs) {
  const run = readMazeRun(state, nowTs), id = Number(cellId || run.cell_id), cell = mazeCell(run, id);
  if (!cell || Number(cell.map_id) !== Number(run.map_id)) return { ok: false, status: 404, error: "maze_cell_not_found" };
  const current = mazeCell(run), currentRow = MAZE_CELLS[String(run.cell_id)], targetRow = MAZE_CELLS[String(id)];
  const rowDelta = Number(targetRow?.Y || 0) - Number(currentRow?.Y || 0);
  const alwaysVisible = Boolean(MAZE_CELL_TYPES[cell.type]?.AlwaysVisible);
  // Query is a preview operation, not movement. The native client allows
  // inspecting cells up to two rows ahead, every previous cell and special
  // AlwaysVisible cells. Actual route enforcement remains in mazeMove.
  if (id !== Number(run.cell_id) && rowDelta > 10 && !alwaysVisible) return { ok: false, status: 409, error: "maze_cell_not_visible" };
  if (id === Number(run.cell_id) && cell.type === "empty") cell.status = 1;
  return mazeActionResult(run, "maze_query", { cell });
}

function mazeMove(state, cellId, nowTs) {
  const run = readMazeRun(state, nowTs), id = Number(cellId), target = mazeCell(run, id), current = mazeCell(run);
  if (!target || Number(target.map_id) !== Number(run.map_id)) return { ok: false, status: 404, error: "maze_cell_not_found" };
  const row = MAZE_CELLS[String(run.cell_id)];
  if (!(row?.To || []).map(Number).includes(id)) return { ok: false, status: 409, error: "maze_cell_not_adjacent" };
  if (!current || Number(current.status) !== 1) return { ok: false, status: 409, error: "maze_current_cell_unresolved" };
  if ((current.heirloom_pool || []).length) return { ok: false, status: 409, error: "maze_heirloom_not_selected" };
  if (current.special_reward) return { ok: false, status: 409, error: "maze_floor_reward_not_received" };
  if (run.completed) return { ok: false, status: 409, error: "maze_cycle_complete" };
  run.path.push(Number(run.cell_id)); run.cell_id = id;
  return mazeActionResult(run, "maze_move", { cell: target });
}

function mazeStart(state, request = {}) {
  const run = readMazeRun(state, request.now_ts), cell = mazeCell(run);
  if (!cell || !MAZE_BATTLE_TYPES.has(cell.type)) return { ok: false, status: 409, error: "maze_cell_not_battle" };
  if (Number(cell.status) === 1) return { ok: false, status: 409, error: "maze_battle_already_won" };
  if (run.active_battle) return { ok: false, status: 409, error: "maze_battle_already_active" };
  const battleId = String(request.battle_id || `maze-${run.cycle_id}-${cell.id}-${Number(cell.attempts || 0) + 1}`);
  cell.attempts = Number(cell.attempts || 0) + 1;
  run.active_battle = { battle_id: battleId, cell_id: cell.id, attempt: cell.attempts, lineup_ids: (request.lineup_ids || []).map(Number) };
  return mazeActionResult(run, "maze_start", { battle_id: battleId, enemy_stage_id: cell.id, lineup_ids: run.active_battle.lineup_ids });
}

function mazeEnd(state, request = {}) {
  const run = readMazeRun(state, request.now_ts), cell = mazeCell(run), battleId = String(request.battle_id || "");
  if ((cell?.settled_battle_ids || []).includes(battleId) && battleId) return mazeActionResult(run, "maze_end_replay", { battle_id: battleId, battle_result: Number(cell.status) === 1 ? 1 : 2, rewards: [], idempotent_replay: true });
  if (!run.active_battle || (battleId && String(run.active_battle.battle_id) !== battleId)) return { ok: false, status: 409, error: "maze_active_battle_not_found" };
  const resolvedId = String(run.active_battle.battle_id);
  cell.settled_battle_ids = [...new Set([...(cell.settled_battle_ids || []), resolvedId])];
  run.active_battle = null;
  const victory = request.authoritative_result === "victory" || request.victory === true || Number(request.battle_result) === 1;
  run.last_battle = { battle_id: resolvedId, cell_id: cell.id, result: victory ? "victory" : "defeat" };
  if (!victory) return mazeActionResult(run, "maze_defeat", { battle_id: resolvedId, battle_result: 2, rewards: [] });
  cell.status = 1; run.battle_victory_times = Number(run.battle_victory_times || 0) + 1;
  const rewards = parseAssets(MAZE_CELLS[String(cell.id)]?.StaticRewards || []);
  if (MAZE_CELL_TYPES[cell.type]?.Heirlooms?.length) cell.heirloom_pool = mazeRelicPool(cell.type, cell.id, run.cycle_id, run.heirlooms || []);
  if (cell.type === "boss") cell.special_reward = true;
  const transition = mutateAssets(state, [], rewards, "maze_victory");
  if (!transition.ok) return transition;
  transition.inventory.push(mazeRunItem(run, "maze_victory"));
  return { ...mazeActionResult(run, "maze_victory"), ...transition, maze: run, cell, battle_id: resolvedId, battle_result: 1, rewards };
}

function mazeSelectRelic(state, relicIds, nowTs) {
  const run = readMazeRun(state, nowTs), cell = mazeCell(run);
  const candidates = Array.isArray(relicIds) ? relicIds.map(Number) : [Number(relicIds)];
  const selected = [...new Set(candidates)].filter((id) => (cell?.heirloom_pool || []).includes(id));
  if (!cell || !(cell.heirloom_pool || []).length) return { ok: false, status: 409, error: "maze_heirloom_pool_empty" };
  if (!selected.length) return { ok: false, status: 422, error: "invalid_maze_relic" };
  for (const id of selected.slice(0, 1)) {
    run.heirlooms.push(id); run.heirloom_stacks[String(id)] = Number(run.heirloom_stacks[String(id)] || 0) + 1; cell.picked_heirlooms.push(id);
  }
  cell.heirloom_pool = [];
  return mazeActionResult(run, "maze_select_heirloom", { relic_id: selected[0], selected_heirlooms: selected.slice(0, 1) });
}

function mazeUseRelic(state, params = [], nowTs) {
  const run = readMazeRun(state, nowTs), cell = mazeCell(run);
  if (!cell || MAZE_BATTLE_TYPES.has(cell.type) || cell.type === "peddler") return { ok: false, status: 409, error: "maze_relic_not_usable_here" };
  if (cell.status === 1) return { ok: false, status: 409, error: "maze_cell_already_resolved" };
  let assistHero = null;
  if (cell.type === "carriage") {
    const heroId = Number((params || [])[0] || 0);
    assistHero = (cell.assist_heroes || []).find((hero) => Number(hero.id || hero.hero_id) === heroId) || null;
    if (!assistHero) return { ok: false, status: 422, error: "maze_assist_hero_required" };
    run.assist_heroes = [...(run.assist_heroes || []).filter((hero) => Number(hero.id || hero.hero_id) !== heroId), assistHero];
    cell.selected_assist_hero_id = heroId;
  }
  cell.status = 1;
  return mazeActionResult(run, "maze_use_relic", { params: (params || []).map(Number), self_dyns: {}, assist_hero: assistHero });
}

function mazeBuy(state, index, nowTs) {
  const run = readMazeRun(state, nowTs), cell = mazeCell(run), goodIndex = Number(index);
  if (!cell || cell.type !== "peddler" || !cell.shop) return { ok: false, status: 409, error: "maze_shop_not_active" };
  const good = cell.shop.goods.find((entry) => Number(entry.index) === goodIndex);
  if (!good) return { ok: false, status: 404, error: "maze_shop_good_not_found" };
  if (good.is_sold) return { ok: false, status: 409, error: "maze_shop_good_sold" };
  const transition = mutateAssets(state, [good.cost], [good.good], "maze_shop");
  if (!transition.ok) return { ...transition, status: 409 };
  good.is_sold = true; transition.inventory.push(mazeRunItem(run, "maze_shop"));
  return { ...mazeActionResult(run, "maze_shop"), ...transition, maze: run, cell, index: goodIndex, cost: [good.cost], rewards: [good.good], sell_good: good };
}

function mazeGiveUp(state, nowTs) {
  const run = readMazeRun(state, nowTs), cell = mazeCell(run);
  if (!cell || MAZE_BATTLE_TYPES.has(cell.type)) return { ok: false, status: 409, error: "maze_cell_cannot_give_up" };
  if (cell.status === 1) return mazeActionResult(run, "maze_give_up_replay", { idempotent_replay: true });
  cell.status = 1;
  return mazeActionResult(run, "maze_give_up");
}

function mazeReceive(state, nowTs) {
  const run = readMazeRun(state, nowTs), cell = mazeCell(run);
  if (!cell || cell.type !== "boss" || Number(cell.status) !== 1 || !cell.special_reward) return { ok: false, status: 409, error: "maze_floor_reward_not_available" };
  const rewards = [asset("currency", "diamond", [0, 100, 200, 500][Number(run.floor_id)] || 500)];
  const transition = mutateAssets(state, [], rewards, "maze_floor_reward");
  if (!transition.ok) return transition;
  cell.special_reward = false;
  if (Number(run.floor_id) >= 3) { run.completed = true; run.final_claimed = true; run.passed_times = Number(run.passed_times || 0) + 1; }
  transition.inventory.push(mazeRunItem(run, "maze_floor_reward"));
  return { ...mazeActionResult(run, "maze_floor_reward"), ...transition, maze: run, cell, rewards };
}

function mazeTransmit(state, targetCellId, nowTs) {
  const run = readMazeRun(state, nowTs), cell = mazeCell(run), map = MAZE_MAPS[String(run.map_id)];
  const requested = Number(targetCellId || map?.StartCell);
  // The classic client may replay the same gate request after the first reply
  // has already persisted the next map.  Treat that exact replay as an
  // idempotent success; otherwise the client reaches the new floor but shows a
  // misleading `maze_floor_not_complete` modal over it.
  const previousFloorPath = run.floor_paths?.[String(Number(run.floor_id) - 1)];
  const isTransmitReplay = Number(cell?.id) === Number(map?.StartCell)
    && (requested === Number(run.map_id) || requested === Number(map?.StartCell))
    && Array.isArray(previousFloorPath) && previousFloorPath.length > 0;
  if (isTransmitReplay) return mazeActionResult(run, "maze_transmit_replay", { idempotent_replay: true });
  if (!cell || Number(cell.id) !== Number(map?.EndCell) || Number(cell.status) !== 1 || cell.special_reward || (cell.heirloom_pool || []).length) return { ok: false, status: 409, error: "maze_floor_not_complete" };
  if (run.completed || !(map.NextMaps || []).length) return { ok: false, status: 409, error: "maze_cycle_complete" };
  const nextMapId = Number((map.NextMaps || []).find((id) => Number(id) <= 3) || map.NextMaps[0]);
  const nextMap = MAZE_MAPS[String(nextMapId)], requestedNext = Number(targetCellId || nextMap.StartCell);
  // The classic client sends the target map id from the gate node, while newer
  // clients send the first cell id of that map.  Both identify the same single
  // server-authorized next map; accepting either keeps route validation strict.
  if (requestedNext !== nextMapId && requestedNext !== Number(nextMap.StartCell)) return { ok: false, status: 409, error: "maze_invalid_transmit_target" };
  run.floor_paths = run.floor_paths && typeof run.floor_paths === "object" ? run.floor_paths : {};
  run.floor_paths[String(run.floor_id)] = [...run.path, Number(run.cell_id)];
  run.path = []; run.map_id = nextMapId; run.floor_id = Number(nextMap.Floor); run.cell_id = Number(nextMap.StartCell);
  run.cells = buildMazeMapCells(nextMapId, run.cycle_id); run.active_battle = null;
  return mazeActionResult(run, "maze_transmit");
}

function guildOpen(state, recommendations = [], request = {}) { return guildDomain.open(state, { ...request, recommendations }); }
function guildJoin(state, guildId = 1, request = {}) { return guildDomain.join(state, { ...request, guild_id: Number(guildId) }); }
function guildCreate(state, name = "本地冒险者公会", request = {}) { return guildDomain.create(state, { ...request, name }); }
function guildSearch(state, request = {}) { return guildDomain.search(state, request); }
function guildMembers(state, members = [], request = {}) { return guildDomain.members(state, { ...request, bot_members: members }); }
function guildLeave(state, request = {}) { return guildDomain.leave(state, request); }
function guildEdit(state, request = {}) { return guildDomain.edit(state, request); }
function guildApply(state, request = {}) { return guildDomain.applyJoin(state, request); }
function guildApplications(state, request = {}) { return guildDomain.applications(state, request); }
function guildApprove(state, request = {}) { return guildDomain.approveJoin(state, request); }
function guildManageMember(state, request = {}, action = "promote") { return guildDomain.manage(state, request, action); }
function guildDisband(state, request = {}) { return guildDomain.disband(state, request); }
function guildDonate(state, request = {}) { return guildDomain.donate(state, request); }
function guildShopOpen(state, request = {}) { return guildDomain.shopOpen(state, request); }
function guildShopBuy(state, request = {}) { return guildDomain.shopBuy(state, request); }
function guildTaskInfo(state, request = {}) { return guildDomain.taskInfo(state, request); }
function guildTaskClaim(state, request = {}) { return guildDomain.taskClaim(state, request); }
function guildChat(state, request = {}) { return guildDomain.chat(state, request); }
function guildRank(state, request = {}) { return guildDomain.rank(state, request); }
function guildBossOpen(state, request = {}) { return guildDomain.bossOpen(state, request); }
function guildBossStart(state, request = {}) { return guildDomain.bossStart(state, request); }
function guildBossEnd(state, damage = 0, request = {}) { return guildDomain.bossEnd(state, { ...request, damage, require_active: request.require_active ?? false }); }
function guildBossFinalReward(state, request = {}) { return guildDomain.bossFinalReward(state, request); }

function useItem(state, itemId, count = 1) {
  const cost = asset("item", Number(itemId), Math.max(1, Number(count)));
  const transition = mutateAssets(state, [cost], [], "item_use");
  return { ...transition, cost: [cost], rewards: [] };
}

function tavernState(state) {
  const readMap = (prefix) => Object.fromEntries((state.inventory || [])
    .filter((row) => String(row.item_id).startsWith(prefix) && Number(row.quantity || 0) > 0)
    .map((row) => [String(row.item_id).slice(prefix.length), Number(row.quantity)]));
  return {
    ok: true,
    draw_times: readMap("meta_tavern_draw_count_"),
    pity: readMap("meta_tavern_pity_"),
    wishlist: readMap("meta_tavern_wishlist_slot_"),
    wish_tids: readMap("meta_tavern_wish_tid_"),
    stargazer_id: meta(state, "tavern_stargazer_id", 22),
    // 124 is the first Awakened/SP hero in the Classic 1.201 Unit table.
    // Returning starter hero 22 leaves the SP selector without valid art.
    hyper_tid: meta(state, "tavern_hyper_tid", 124),
    daily_pool: meta(state, "tavern_daily_pool", 5),
    pick_pool: meta(state, "tavern_pick_pool", 22),
    npc_id: meta(state, "tavern_npc", 1),
    amazing_point: meta(state, "tavern_amazing_point", 0),
    evidence_level: "official_tavern_schema_persisted_local_state",
  };
}

function tavernSettingAction(state, request = {}) {
  const op = String(request.op || "tavern_open");
  if (["tavern_open", "tavern_history", "tavern_open_stargazer_wanted", "tavern_open_wish", "tavern_open_dragon"].includes(op)) return tavernState(state);
  let itemId, value;
  if (op === "tavern_set_wishlist") {
    const slot = Number(request.slot_id || request.id || 0);
    if (!Number.isInteger(slot) || slot < 1 || slot > 23) return { ok: false, status: 422, error: "invalid_tavern_wishlist_slot" };
    itemId = `meta_tavern_wishlist_slot_${slot}`; value = Math.max(0, Number(request.hero_tid || 0));
  } else if (op === "tavern_set_wish_tid") {
    const poolId = Number(request.pool_id || 0), heroTid = Number(request.hero_tid || 0);
    if (!Number.isInteger(poolId) || poolId < 1 || !UNITS[String(heroTid)]) return { ok: false, status: 422, error: "invalid_tavern_wish_target" };
    itemId = `meta_tavern_wish_tid_${poolId}`; value = heroTid;
  } else {
    const definitions = {
      tavern_set_stargazer: ["meta_tavern_stargazer_id", request.hero_tid],
      tavern_set_daily_pool: ["meta_tavern_daily_pool", request.pool_id],
      tavern_set_pick_pool: ["meta_tavern_pick_pool", request.hero_tid],
      tavern_set_npc: ["meta_tavern_npc", request.npc_id],
      tavern_set_hyper: ["meta_tavern_hyper_tid", request.hero_tid],
    };
    const definition = definitions[op];
    if (!definition) return { ok: false, status: 422, error: "unsupported_tavern_action", op };
    [itemId, value] = definition; value = Number(value || 0);
    if (!Number.isInteger(value) || value < 0) return { ok: false, status: 422, error: "invalid_tavern_setting" };
    if (["tavern_set_stargazer", "tavern_set_pick_pool", "tavern_set_hyper"].includes(op) && value > 0 && !UNITS[String(value)]) return { ok: false, status: 422, error: "unknown_tavern_target_hero" };
  }
  const transition = {
    ok: true,
    inventory: [{ item_id: itemId, quantity: value, extra: { source: op, evidence_level: "official_tavern_request_schema" } }],
  };
  return { ...tavernState({ ...state, inventory: [...(state.inventory || []).filter((row) => String(row.item_id) !== itemId), transition.inventory[0]] }), ...transition };
}

function findHero(state, heroId) {
  return (state.characters || []).find((row) => String(row.character_id) === String(heroId) || Number(row.extra_json?.hero_id) === Number(heroId));
}

function heroExtra(hero) {
  if (!hero) return {};
  if (hero.extra_json && typeof hero.extra_json === "object") return hero.extra_json;
  if (hero.extra && typeof hero.extra === "object") return hero.extra;
  return {};
}

function persistedHero(hero, extra, source) {
  return {
    character_id: String(hero.character_id), level: Number(hero.level || 1),
    star: Number(extra.quality || hero.star || 1), extra: { ...extra, source },
  };
}

function heroTid(hero) { return Number(heroExtra(hero).tid || 0); }
function heroQuality(hero) { return Number(heroExtra(hero).quality || hero?.star || 1); }

function qualityRule(tid, targetQuality) {
  return UNIT_QUALITIES[String(tid)]?.[String(targetQuality)] || null;
}

function validateQualityCost(target, cost, targetQuality, rule) {
  if (!cost || cost === target) return "invalid_quality_cost_heroes";
  const costExtra = heroExtra(cost);
  if (costExtra.locked) return "quality_cost_hero_locked";
  if (heroQuality(cost) < Number(rule?.AssistantHero1Quality || 1)) return "quality_cost_hero_quality_too_low";
  const targetUnit = UNITS[String(heroTid(target))] || {};
  const costUnit = UNITS[String(heroTid(cost))] || {};
  const requiredTid = Number(rule?.AssistantHero1ID || 0);
  if (requiredTid > 1 && heroTid(cost) !== requiredTid) return "quality_cost_hero_mismatch";
  // Four-faction fodder is interchangeable inside its faction; celestial,
  // hypogean, dimensional and dragon ascension requires the same hero.
  const strictTags = new Set(["God", "Devil", "Cross", "Dragon"]);
  if (strictTags.has(String(targetUnit.HeroTag || ""))) {
    if (heroTid(cost) !== heroTid(target)) return "quality_cost_hero_mismatch";
  } else if (targetUnit.HeroTag && targetUnit.HeroTag !== costUnit.HeroTag) {
    return "quality_cost_hero_faction_mismatch";
  }
  if (targetQuality <= heroQuality(target)) return "invalid_target_quality";
  return null;
}

function heroQualityUp(state, heroId, costHeroIds = []) {
  const hero = findHero(state, heroId);
  if (!hero) return { ok: false, status: 404, error: "hero_not_found" };
  const extra = heroExtra(hero);
  if (extra.locked) return { ok: false, status: 409, error: "hero_locked" };
  const unit = UNITS[String(heroTid(hero))];
  if (!unit) return { ok: false, status: 422, error: "unknown_hero_tid" };
  const quality = heroQuality(hero) + 1;
  if (quality > Number(unit.MaxQuality || quality)) return { ok: false, status: 409, error: "hero_max_quality" };
  const rule = qualityRule(heroTid(hero), quality);
  if (!rule) return { ok: false, status: 422, error: "quality_rule_not_found" };
  const required = Math.max(1, Number(rule.UpgradeSoulAmount || 1));
  const uniqueIds = [...new Set((costHeroIds || []).map(String))];
  if (uniqueIds.length !== required) return { ok: false, status: 422, error: "quality_cost_count_mismatch", required, provided: uniqueIds.length };
  const costs = uniqueIds.map((id) => findHero(state, id));
  const invalid = costs.find((row) => !row);
  if (invalid !== undefined) return { ok: false, status: 422, error: "invalid_quality_cost_heroes" };
  for (const cost of costs) {
    const error = validateQualityCost(hero, cost, quality, rule);
    if (error) return { ok: false, status: error.includes("locked") ? 409 : 422, error, hero_id: String(cost?.character_id || "") };
  }
  return {
    ok: true,
    remove_characters: costs.map((row) => String(row.character_id)),
    character: persistedHero(hero, { ...extra, quality }, "hero_quality_up"),
    quality_before: quality - 1, quality_after: quality,
    evidence_level: "decrypted_official_unit_quality_config",
  };
}

function heroQualityOneKey(state, upgrades = []) {
  const requested = Array.isArray(upgrades) && upgrades.length
    ? upgrades
    : [];
  if (!requested.length) return { ok: false, status: 422, error: "quality_upgrades_required" };
  const working = { ...state, characters: [...(state.characters || [])] };
  const updated = [];
  const removed = [];
  for (const request of requested) {
    const result = heroQualityUp(working, request.hero_id, request.cost_hero_ids || []);
    if (!result.ok) return result;
    working.characters = working.characters
      .filter((row) => !result.remove_characters.includes(String(row.character_id)))
      .map((row) => String(row.character_id) === String(result.character.character_id) ? { ...result.character, extra_json: result.character.extra } : row);
    updated.push(result.character);
    removed.push(...result.remove_characters);
  }
  return {
    ok: true, character: updated[0], characters: updated,
    remove_characters: [...new Set(removed)],
    evidence_level: "decrypted_official_unit_quality_config",
  };
}

function equippedInstance(value, fallbackId = 0) {
  if (value && typeof value === "object") {
    const id = Number(value.id || value.equip_id || value.tid || fallbackId);
    return { ...value, id, tid: Number(value.tid || value.source_tid || id), amount: 1 };
  }
  const id = Number(value || fallbackId);
  return { id, tid: id, amount: 1, enhance_lv: 0, enhance_exp: 0 };
}

function equipmentInventory(state) {
  const result = [];
  for (const row of state.inventory || []) {
    const extra = row.extra_json || row.extra || {};
    const key = String(row.item_id || "");
    const match = key.match(/^(?:u?equip)_([0-9]+)$/);
    const id = Number(extra.equip_id || extra.id || extra.asset_id || (match && match[1]) || 0);
    const tid = Number(extra.tid || extra.equip_tid || extra.asset_id || id);
    const isEquip = extra.asset_type === "equip" || extra.type === "equip" || Boolean(match);
    if (isEquip && id > 0 && tid > 0 && Number(row.quantity || 0) > 0) result.push({ ...equippedInstance(extra, id), id, tid, row });
  }
  return result;
}

function allEquippedIds(state, ignoredCharacterId = null) {
  const result = new Set();
  for (const hero of state.characters || []) {
    if (ignoredCharacterId !== null && String(hero.character_id) === String(ignoredCharacterId)) continue;
    for (const value of Object.values(heroExtra(hero).equips || {})) {
      const id = equippedInstance(value).id;
      if (id > 0) result.add(id);
    }
  }
  return result;
}

function validateEquipmentForHero(hero, index, instance) {
  const slot = Number(index);
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) return "invalid_equip_slot";
  const config = EQUIPMENT[String(instance.tid)];
  if (!config) return "unknown_equipment_tid";
  if (Number(config.Position) !== slot) return "equipment_slot_mismatch";
  const unit = UNITS[String(heroTid(hero))] || {};
  if (unit.HeroJob && config.Job && unit.HeroJob !== config.Job) return "equipment_job_mismatch";
  return null;
}

function heroEquipment(state, heroId, index, equipId = 0) {
  const hero = findHero(state, heroId);
  if (!hero) return { ok: false, status: 404, error: "hero_not_found" };
  const extra = heroExtra(hero);
  const equips = { ...(extra.equips || {}) };
  const slot = Number(index);
  if (Number(equipId) > 0) {
    const instance = equipmentInventory(state).find((entry) => entry.id === Number(equipId));
    if (!instance) return { ok: false, status: 404, error: "equipment_not_owned" };
    const validation = validateEquipmentForHero(hero, slot, instance);
    if (validation) return { ok: false, status: 422, error: validation };
    if (allEquippedIds(state, hero.character_id).has(instance.id)) return { ok: false, status: 409, error: "equipment_already_worn" };
    equips[String(slot)] = equippedInstance(instance);
  } else {
    if (!Number.isInteger(slot) || slot < 1 || slot > 4) return { ok: false, status: 422, error: "invalid_equip_slot" };
    delete equips[String(slot)];
  }
  return { ok: true, character: persistedHero(hero, { ...extra, equips }, "hero_equipment") };
}

function heroWearBestEquipment(state, heroId) {
  const hero = findHero(state, heroId);
  if (!hero) return { ok: false, status: 404, error: "hero_not_found" };
  const extra = heroExtra(hero);
  const equips = { ...(extra.equips || {}) };
  const wornElsewhere = allEquippedIds(state, hero.character_id);
  const candidates = equipmentInventory(state)
    .filter((entry) => !wornElsewhere.has(entry.id) && !validateEquipmentForHero(hero, Number(EQUIPMENT[String(entry.tid)]?.Position), entry))
    .sort((a, b) => Number(EQUIPMENT[String(b.tid)]?.Quality || 0) - Number(EQUIPMENT[String(a.tid)]?.Quality || 0)
      || Number(b.enhance_lv || 0) - Number(a.enhance_lv || 0)
      || b.tid - a.tid);
  for (let slot = 1; slot <= 4; slot += 1) {
    const candidate = candidates.find((entry) => Number(EQUIPMENT[String(entry.tid)]?.Position) === slot);
    if (candidate) equips[String(slot)] = equippedInstance(candidate);
  }
  return {
    ok: true,
    character: persistedHero(hero, { ...extra, equips }, "hero_wear_best_equipment"),
  };
}

function heroRemoveAllEquipment(state, heroId) {
  const hero = findHero(state, heroId);
  if (!hero) return { ok: false, status: 404, error: "hero_not_found" };
  const extra = heroExtra(hero);
  return {
    ok: true,
    character: persistedHero(hero, { ...extra, equips: {} }, "hero_remove_all_equipment"),
  };
}

function equippedAt(state, heroId, index) {
  const hero = findHero(state, heroId);
  if (!hero) return { error: { ok: false, status: 404, error: "hero_not_found" } };
  const slot = Number(index);
  const raw = heroExtra(hero).equips?.[String(slot)];
  if (!raw) return { error: { ok: false, status: 404, error: "equipped_item_not_found" } };
  const equip = equippedInstance(raw);
  const config = EQUIPMENT[String(equip.tid)];
  if (!config) return { error: { ok: false, status: 422, error: "unknown_equipment_tid" } };
  return { hero, slot, equip, config };
}

function mergeCosts(costs = []) {
  const merged = new Map();
  for (const entry of costs) {
    const key = keyOf(entry);
    const current = merged.get(key) || { ...entry, amount: 0 };
    current.amount += Number(entry.amount || 0);
    merged.set(key, current);
  }
  return [...merged.values()].filter((entry) => entry.amount > 0);
}

function equipmentEnhance(state, heroId, index, materials = []) {
  const found = equippedAt(state, heroId, index);
  if (found.error) return found.error;
  const quality = Number(found.config.Quality || 1);
  const maxLevel = Number(EQUIP_QUALITIES[String(quality)]?.MaxEnhanceLevel || 0);
  let level = Number(found.equip.enhance_lv || 0), exp = Number(found.equip.enhance_exp || 0);
  if (level >= maxLevel) return { ok: false, status: 409, error: "equipment_max_enhance_level" };
  const costs = [];
  let suppliedExp = 0;
  for (const material of materials || []) {
    const type = String(material.type || material.asset_type || "item").toLowerCase();
    const id = Number(material.id || material.item_id || material.tid || 0);
    const amount = Math.max(0, Number(material.amount || material.count || 0));
    if (!amount) continue;
    let value = Number(EQUIP_ENHANCE_ITEMS[String(id)]?.Value || 0);
    if (!value && type === "equip") value = Number(EQUIP_QUALITIES[String(EQUIPMENT[String(id)]?.Quality || 0)]?.EnhancementValue || 0);
    if (!value) return { ok: false, status: 422, error: "invalid_enhancement_material", material_id: id };
    suppliedExp += value * amount;
    costs.push(asset(type === "equip" ? "equip" : "item", id, amount));
  }
  if (suppliedExp <= 0) return { ok: false, status: 422, error: "enhancement_material_required" };
  let remaining = suppliedExp, gold = 0;
  while (remaining > 0 && level < maxLevel) {
    const row = EQUIP_ENHANCEMENT[String(quality)]?.[String(level)];
    if (!row) return { ok: false, status: 422, error: "enhancement_rule_not_found", quality, level };
    const needed = Math.max(0, Number(row.EnhancementExp || 0) - exp);
    const used = Math.min(remaining, needed);
    gold += used * Number(row.CostPerExp?.[2] || 0);
    exp += used; remaining -= used;
    if (exp >= Number(row.EnhancementExp || 0)) { level += 1; exp = 0; }
  }
  costs.push(asset("currency", "gold", gold));
  const rewards = [];
  if (remaining > 0) {
    const returned = Math.floor(remaining / Number(EQUIP_ENHANCE_ITEMS["15"]?.Value || 10));
    if (returned > 0) rewards.push(asset("item", 15, returned));
  }
  const mergedCosts = mergeCosts(costs);
  const transition = mutateAssets(state, mergedCosts, rewards, "equipment_enhance");
  if (!transition.ok) return { ...transition, status: 409 };
  const extra = heroExtra(found.hero), equips = { ...(extra.equips || {}) };
  equips[String(found.slot)] = { ...found.equip, enhance_lv: level, enhance_exp: exp };
  return { ...transition, character: persistedHero(found.hero, { ...extra, equips }, "equipment_enhance"), cost: mergedCosts, rewards, enhance_lv: level, enhance_exp: exp, evidence_level: "decrypted_official_equip_enhancement_config" };
}

function resolveConfiguredCost(state, tokens = []) {
  if (!Array.isArray(tokens) || !tokens.length) return { costs: [] };
  if (String(tokens[0]).toLowerCase() !== "costset") return { costs: parseAssets(tokens) };
  const multiplier = Math.max(1, Number(tokens[2] || 1));
  const rows = Object.values(COST_SETS[String(tokens[1])] || {}).sort((a, b) => Number(a.Priority || 0) - Number(b.Priority || 0));
  for (const row of rows) {
    const costs = parseAssets(row.Cost || []).map((entry) => ({ ...entry, amount: entry.amount * multiplier }));
    if (costs.every((entry) => quantity(state, keyOf(entry)) >= Number(entry.amount))) return { costs, cost_set_id: Number(tokens[1]), priority: Number(row.Priority || 0) };
  }
  return { error: { ok: false, status: 409, error: "insufficient_evolution_material", cost_set_id: Number(tokens[1]) } };
}

function equipmentEvolve(state, heroId, index) {
  const found = equippedAt(state, heroId, index);
  if (found.error) return found.error;
  if (!found.config.CanEvolve || !Number(found.config.EvolveID)) return { ok: false, status: 409, error: "equipment_cannot_evolve" };
  const resolved = resolveConfiguredCost(state, found.config.Comsume || []);
  if (resolved.error) return resolved.error;
  const transition = mutateAssets(state, resolved.costs, [], "equipment_evolve");
  if (!transition.ok) return { ...transition, status: 409 };
  const extra = heroExtra(found.hero), equips = { ...(extra.equips || {}) };
  equips[String(found.slot)] = { ...found.equip, tid: Number(found.config.EvolveID), source_tid: Number(found.config.EvolveID) };
  return { ...transition, character: persistedHero(found.hero, { ...extra, equips }, "equipment_evolve"), cost: resolved.costs, rewards: [], cost_set_id: resolved.cost_set_id, evidence_level: "decrypted_official_equip_and_cost_set_config" };
}

function equipmentRefine(state, heroId, index) {
  const found = equippedAt(state, heroId, index);
  if (found.error) return found.error;
  if (Number(found.config.TagSignatureProbability || 0) <= 0) return { ok: false, status: 409, error: "equipment_cannot_refine" };
  const refineCosts = parseAssets(PARAMS.Equip?.EquipRefineTag?.AsrValue || []);
  const transition = mutateAssets(state, refineCosts, [], "equipment_refine");
  if (!transition.ok) return { ...transition, status: 409 };
  const refineCount = Number(found.equip.refine_count || 0) + 1;
  // The official server rolls the race tag. Its private RNG weights are not
  // present in the client; use a deterministic eight-faction roll so retries
  // cannot reroll for free while preserving the same protocol semantics.
  const tagId = ((Number(found.equip.id || found.equip.tid) + refineCount - 1) % 8) + 1;
  const extra = heroExtra(found.hero), equips = { ...(extra.equips || {}) };
  equips[String(found.slot)] = { ...found.equip, pending_refine_tag: tagId, refine_count: refineCount };
  return { ...transition, character: persistedHero(found.hero, { ...extra, equips }, "equipment_refine"), cost: refineCosts, rewards: [], pending_refine_tag: tagId, evidence_level: "decrypted_official_param_equip_refine_cost" };
}

function equipmentConfirmRefine(state, heroId, index, accept = true) {
  const found = equippedAt(state, heroId, index);
  if (found.error) return found.error;
  if (!Number(found.equip.pending_refine_tag || 0)) return { ok: false, status: 409, error: "equipment_refine_not_pending" };
  const extra = heroExtra(found.hero), equips = { ...(extra.equips || {}) };
  const next = { ...found.equip };
  if (accept) next.refine_tag = Number(next.pending_refine_tag);
  delete next.pending_refine_tag;
  equips[String(found.slot)] = next;
  return { ok: true, inventory: [], character: persistedHero(found.hero, { ...extra, equips }, "equipment_confirm_refine"), accepted: Boolean(accept), evidence_level: "decrypted_official_equip_tag_config" };
}

function equipmentSetResonate(state, heroId, indexes = [], enabled = true) {
  const hero = findHero(state, heroId);
  if (!hero) return { ok: false, status: 404, error: "hero_not_found" };
  const extra = heroExtra(hero), equips = { ...(extra.equips || {}) };
  const slots = [...new Set((indexes || []).map(Number))].filter((slot) => slot >= 1 && slot <= 4);
  if (!slots.length) return { ok: false, status: 422, error: "resonate_indexes_required" };
  for (const slot of slots) {
    if (!equips[String(slot)]) return { ok: false, status: 404, error: "equipped_item_not_found", index: slot };
    const instance = equippedInstance(equips[String(slot)]);
    if (enabled) {
      const targetQuality = meta(state, "equip_resonate_quality", 0);
      const current = EQUIPMENT[String(instance.tid)] || {};
      if (!targetQuality) return { ok: false, status: 409, error: "equipment_resonate_not_unlocked" };
      if (Number(current.Quality || 0) >= targetQuality) return { ok: false, status: 409, error: "equipment_resonate_not_better", index: slot };
      const target = Object.values(EQUIPMENT).find((row) => Number(row.Quality) === targetQuality && Number(row.Position) === slot && row.Job === current.Job);
      if (!target) return { ok: false, status: 422, error: "equipment_resonate_template_not_found", index: slot };
      equips[String(slot)] = { ...instance, resonate_tid: Number(target.TID) };
    } else equips[String(slot)] = { ...instance, resonate_tid: 0 };
  }
  return { ok: true, inventory: [], character: persistedHero(hero, { ...extra, equips }, enabled ? "equipment_open_resonate" : "equipment_close_resonate") };
}

function equipmentResonateQuality(state, quality) {
  const target = Number(quality);
  const rule = EQUIP_RESONATE[String(target)];
  if (!rule) return { ok: false, status: 422, error: "equipment_resonate_quality_not_found" };
  const owned = equipmentInventory(state).filter((entry) => Number(EQUIPMENT[String(entry.tid)]?.Quality || 0) >= target).reduce((total, entry) => total + Number(entry.row?.quantity || 1), 0)
    + (state.characters || []).flatMap((hero) => Object.values(heroExtra(hero).equips || {})).filter((value) => Number(EQUIPMENT[String(equippedInstance(value).tid)]?.Quality || 0) >= target).length;
  if (owned < Number(rule.UnlockNum || 0)) return { ok: false, status: 409, error: "equipment_resonate_requirement_not_met", required: Number(rule.UnlockNum || 0), owned };
  return { ok: true, inventory: [{ item_id: "meta_equip_resonate_quality", quantity: target, extra: { source: "equipment_resonate_quality", owned } }], quality: target, owned, characters: [], evidence_level: "decrypted_official_equip_resonate_config" };
}

function equipmentResonateAll(state, enabled = true) {
  const quality = meta(state, "equip_resonate_quality", 0);
  if (enabled && !quality) return { ok: false, status: 409, error: "equipment_resonate_not_unlocked" };
  const characters = [];
  for (const hero of state.characters || []) {
    const extra = heroExtra(hero), equips = { ...(extra.equips || {}) };
    let changed = false;
    for (const [slotText, raw] of Object.entries(equips)) {
      const instance = equippedInstance(raw), config = EQUIPMENT[String(instance.tid)] || {};
      if (!enabled) {
        if (Number(instance.resonate_tid || 0)) { equips[slotText] = { ...instance, resonate_tid: 0 }; changed = true; }
        continue;
      }
      if (Number(config.Quality || 0) >= quality) continue;
      const target = Object.values(EQUIPMENT).find((row) => Number(row.Quality) === quality && Number(row.Position) === Number(slotText) && row.Job === config.Job);
      if (target) { equips[slotText] = { ...instance, resonate_tid: Number(target.TID) }; changed = true; }
    }
    if (changed) characters.push(persistedHero(hero, { ...extra, equips }, "equipment_resonate_all"));
  }
  return { ok: true, inventory: [{ item_id: "meta_equip_resonate_all", quantity: enabled ? 1 : 0, extra: { source: "equipment_resonate_all" } }], characters, character: characters[0] || null, quality };
}

function equipmentSell(state, equips = {}) {
  const entries = Array.isArray(equips) ? equips : Object.entries(equips || {}).map(([id, amount]) => ({ id, amount }));
  const worn = allEquippedIds(state);
  const costs = [], rewards = [], soldRows = [];
  for (const row of entries) {
    const id = Number(row.id || row.equip_id || 0), amount = Math.max(1, Number(row.amount || row.count || 1));
    if (worn.has(id)) return { ok: false, status: 409, error: "cannot_sell_worn_equipment", equip_id: id };
    const instance = equipmentInventory(state).find((entry) => entry.id === id);
    if (!instance) return { ok: false, status: 404, error: "equipment_not_owned", equip_id: id };
    if (Number(instance.row.quantity || 0) < amount) return { ok: false, status: 409, error: "insufficient_asset", equip_id: id, available: Number(instance.row.quantity || 0) };
    costs.push(asset("equip", id, amount));
    rewards.push(...parseAssets(EQUIPMENT[String(instance.tid)]?.SellPrice || []).map((entry) => ({ ...entry, amount: entry.amount * amount })));
    soldRows.push({ item_id: instance.row.item_id, quantity: Number(instance.row.quantity) - amount, extra: { ...(instance.row.extra_json || instance.row.extra || {}), source: "equipment_sell" } });
  }
  const mergedCosts = mergeCosts(costs), mergedRewards = mergeCosts(rewards);
  const transition = mutateAssets(state, [], mergedRewards, "equipment_sell");
  if (transition.ok) transition.inventory = [...soldRows, ...(transition.inventory || []).filter((row) => !soldRows.some((sold) => String(sold.item_id) === String(row.item_id)))];
  return { ...transition, cost: mergedCosts, rewards: mergedRewards, evidence_level: "decrypted_official_equip_sell_config" };
}

function heroLock(state, heroId, locked) {
  const hero = findHero(state, heroId);
  if (!hero) return { ok: false, status: 404, error: "hero_not_found" };
  return { ok: true, character: { character_id: String(hero.character_id), level: Number(hero.level || 1), star: Number(hero.star || 1), extra: { ...(hero.extra_json || {}), locked: Boolean(locked), source: "hero_lock" } } };
}

function heroExtendedAction(state, request = {}) {
  const hero = findHero(state, request.hero_id);
  if (!hero) return { ok: false, status: 404, error: "hero_not_found" };
  const extra = { ...(hero.extra_json || {}) };
  if (request.op === "hero_wear_artifact") extra.artifact_id = Number(request.artifact_id || extra.artifact_id || 1);
  if (request.op === "hero_remove_artifact") delete extra.artifact_id;
  if (request.op === "hero_set_assist") extra.assist_hero_id = { ...(extra.assist_hero_id || {}), [request.lineup_type || "normal"]: Number(request.assist_hero_id || 0) };
  if (request.op === "hero_totem_up") extra.totem_node_lvs = { ...(extra.totem_node_lvs || {}), [String(request.node || 0)]: Number((extra.totem_node_lvs || {})[String(request.node || 0)] || 0) + Number(request.up_level || 1) };
  return { ok: true, artifact_id: Number((hero.extra_json || {}).artifact_id || request.artifact_id || 1), character: { character_id: String(hero.character_id), level: Number(hero.level || 1), star: Number(hero.star || 1), extra: { ...extra, source: request.op } } };
}

function altarHeroDisband(state, heroIds = []) {
  const clean = [...new Set(heroIds.map(Number))].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!clean.length) return { ok: false, status: 422, error: "invalid_altar_hero_ids" };
  // Duplicate tavern results may already have been converted to copy items by
  // the draw transaction. Treat those temporary IDs as already disbanded so
  // the client's automatic batch request is safe to retry.
  const heroes = clean.map((id) => findHero(state, id)).filter(Boolean);
  const locked = heroes.find((hero) => Boolean(hero.extra_json?.locked));
  if (locked) return { ok: false, status: 409, error: "altar_hero_locked", hero_id: Number(locked.extra_json?.hero_id || locked.character_id) };
  const rewards = heroes.flatMap((hero) => parseAssets(UNIT_LEVELS[String(Number(hero.level || 1))]?.DisbandRewards || []));
  const transition = mutateAssets(state, [], rewards, "altar_disband");
  return {
    ...transition,
    hero_ids: clean,
    remove_characters: heroes.map((hero) => String(hero.character_id)),
    rewards,
    evidence_level: "decrypted_official_unit_level_config",
  };
}

function gameAction(state, request = {}) {
  const op = request.op;
  if (op === "task_info") return taskInfo(state);
  if (op === "task_claim") return claimTask(state, request.ids || []);
  if (op === "task_chest") return claimTaskChest(state, request.ids || []);
  if (op === "shop_open") return shopCatalog(state, request.shop_id);
  if (op === "shop_buy") return buyShopGood(state, request.shop_id, request.index, request.count);
  if (op === "shop_refresh") {
    const result = shopCatalog(state, request.shop_id);
    result.refresh_times += 1;
    result.inventory = [{ item_id: `meta_shop_${request.shop_id}_refresh`, quantity: result.refresh_times, extra: { source: "shop_refresh" } }];
    return result;
  }
  if (op === "mail_list") return mailList(state, request.ids || []);
  if (op === "mail_read") return readMail(state, request.id);
  if (op === "mail_receive") return receiveMail(state, [Number(request.id)]);
  if (op === "mail_receive_all") return receiveMail(state, DEFAULT_MAILS.filter((mail) => !meta(state, `mail_${mail.id}_received`)).map((mail) => mail.id));
  if (op === "tower_open") return towerOpen(state);
  if (op === "tower_win") return towerWin(state);
  if (op === "arena_open" || op === "arena_refresh") return arenaOpen(state, request.bot_opponents || []);
  if (op === "arena_query_lineup") return { ok: true, opponent: request.bot_opponent || null, lineup: request.bot_opponent?.lineup || [] };
  if (op === "arena_challenge") return arenaChallenge(state, request.victory !== false, request.bot_opponent || null);
  if (op === "arena_records") return arenaRecords(state, request.bot_records || []);
  if (op === "arena_buy_ticket") return arenaBuyTicket(state, request.count);
  if (op === "maze_open") return mazeOpen(state, request.now_ts);
  if (op === "maze_query") return mazeQuery(state, request.cell_id, request.now_ts);
  if (op === "maze_move") return mazeMove(state, request.cell_id, request.now_ts);
  if (op === "maze_start") return mazeStart(state, request);
  if (op === "maze_end" || op === "maze_win") return mazeEnd(state, request);
  if (op === "maze_select_heirloom") return mazeSelectRelic(state, request.heirlooms || request.relic_ids || request.relic_id || request.heirloom_id || request.id, request.now_ts);
  if (op === "maze_use_relic") return mazeUseRelic(state, request.params || [], request.now_ts);
  if (op === "maze_buy") return mazeBuy(state, request.index, request.now_ts);
  if (op === "maze_give_up") return mazeGiveUp(state, request.now_ts);
  if (op === "maze_receive") return mazeReceive(state, request.now_ts);
  if (op === "maze_transmit") return mazeTransmit(state, request.cell_id, request.now_ts);
  if (op === "guild_open") return guildOpen(state, request.bot_guilds || [], request);
  if (op === "guild_create") return guildCreate(state, request.name, request);
  if (op === "guild_search") return guildSearch(state, request);
  if (op === "guild_join") return guildJoin(state, request.guild_id, request);
  if (op === "guild_apply") return guildApply(state, request);
  if (op === "guild_applications") return guildApplications(state, request);
  if (op === "guild_approve") return guildApprove(state, request);
  if (op === "guild_leave") return guildLeave(state, request);
  if (op === "guild_edit") return guildEdit(state, request);
  if (op === "guild_disband") return guildDisband(state, request);
  if (op === "guild_members") return guildMembers(state, request.bot_members || [], request);
  if (["guild_kick", "guild_promote", "guild_demote", "guild_transfer"].includes(op)) return guildManageMember(state, request, op.slice(6));
  if (op === "guild_donate") return guildDonate(state, request);
  if (op === "guild_shop_open") return guildShopOpen(state, request);
  if (op === "guild_shop_buy") return guildShopBuy(state, request);
  if (op === "guild_task_info") return guildTaskInfo(state, request);
  if (op === "guild_task_claim") return guildTaskClaim(state, request);
  if (op === "guild_chat") return guildChat(state, request);
  if (op === "guild_rank") return guildRank(state, request);
  if (op === "guild_history") return guildOpen(state, [], request);
  if (op === "guild_boss_open") return guildBossOpen(state, request);
  if (op === "guild_boss_start") return guildBossStart(state, request);
  if (op === "guild_boss_end") return guildBossEnd(state, request.damage, { ...request, require_active: request.require_active ?? true });
  if (op === "guild_boss_final_reward") return guildBossFinalReward(state, request);
  if (op === "item_use") return useItem(state, request.item_id, request.count);
  if (op.startsWith("tavern_")) return tavernSettingAction(state, request);
  if (op === "hero_quality") return heroQualityUp(state, request.hero_id, request.cost_hero_ids || []);
  if (op === "hero_wear_equip") return heroEquipment(state, request.hero_id, request.index, request.equip_id);
  if (op === "hero_remove_equip") return heroEquipment(state, request.hero_id, request.index, 0);
  if (op === "hero_wear_best_equip") return heroWearBestEquipment(state, request.hero_id);
  if (op === "hero_remove_all_equips") return heroRemoveAllEquipment(state, request.hero_id);
  if (op === "hero_lock") return heroLock(state, request.hero_id, request.locked);
  if (["hero_wear_artifact", "hero_remove_artifact", "hero_query", "hero_set_assist", "hero_totem_up", "hero_batch_artifact_mitama", "hero_wear_mitama", "hero_remove_mitama"].includes(op)) return heroExtendedAction(state, request);
  if (op === "hero_quality_one_key") return heroQualityOneKey(state, request.quality_upgrades || (request.hero_id ? [{ hero_id: request.hero_id, cost_hero_ids: request.cost_hero_ids || request.hero_ids || [] }] : []));
  if (op === "equip_enhance") return equipmentEnhance(state, request.hero_id, request.index, request.assets || request.materials || []);
  if (op === "equip_evolve") return equipmentEvolve(state, request.hero_id, request.index);
  if (op === "equip_refine") return equipmentRefine(state, request.hero_id, request.index);
  if (op === "equip_confirm_refine") return equipmentConfirmRefine(state, request.hero_id, request.index, request.is_accept !== false && request.accept !== false);
  if (op === "equip_open_resonate") return equipmentSetResonate(state, request.hero_id, request.indexes || [], true);
  if (op === "equip_close_resonate") return equipmentSetResonate(state, request.hero_id, request.indexes || [], false);
  if (op === "equip_resonate_quality") return equipmentResonateQuality(state, request.quality);
  if (op === "equip_resonate_all") return equipmentResonateAll(state, request.value !== false);
  if (op === "equip_sell") return equipmentSell(state, request.equips || request.entries || {});
  if (op === "equip_repl_evolve_cost") return { ok: true, cost: [], rewards: [], evidence_level: "decrypted_official_equip_config" };
  if (op === "altar_disband") return altarHeroDisband(state, request.hero_ids || []);
  if (op === "liveops_tick") return runDueResets(state, request.now_ts);
  if (op === "daily_login_claim") return dailyLoginClaim(state, request.now_ts);
  if (op === "battle_pass_progress") return battlePassProgress(state, request.exp);
  if (op === "battle_pass_claim") return battlePassClaim(state, request.level);
  return { ok: false, status: 422, error: "unsupported_game_action", op };
}

module.exports = { CURRENCY_IDS, parseAssets, mutateAssets, taskInfo, claimTask, claimTaskChest, shopCatalog, buyShopGood, mailList, receiveMail, towerOpen, towerWin, arenaOpen, arenaChallenge, arenaBuyTicket, arenaRecords,
  createMazeRun, readMazeRun, mazeRelicEffects, mazeOpen, mazeQuery, mazeMove, mazeStart, mazeEnd, mazeSelectRelic, mazeUseRelic, mazeBuy, mazeGiveUp, mazeReceive, mazeTransmit,
  guildOpen, guildCreate, guildSearch, guildJoin, guildApply, guildApplications, guildApprove, guildLeave, guildEdit, guildDisband, guildMembers, guildManageMember, guildDonate, guildShopOpen, guildShopBuy, guildTaskInfo, guildTaskClaim, guildChat, guildRank, guildBossOpen, guildBossStart, guildBossEnd, guildBossFinalReward, useItem, tavernState, tavernSettingAction,
  heroQualityUp, heroQualityOneKey, heroEquipment, heroWearBestEquipment, heroRemoveAllEquipment, heroLock, heroExtendedAction,
  equipmentEnhance, equipmentEvolve, equipmentRefine, equipmentConfirmRefine, equipmentSetResonate, equipmentResonateQuality, equipmentResonateAll, equipmentSell,
  altarHeroDisband, gameAction };
