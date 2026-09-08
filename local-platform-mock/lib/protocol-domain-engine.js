const { createHash, randomUUID } = require("node:crypto");
const { hasConfig, loadConfig } = require("./official-config-catalog");

const DAY = 86400;
const WEEK = DAY * 7;
const SEASON = DAY * 28;

const QUERY = /(?:^|_)(?:open|info|query|list|get|status|records?|rank|view|panel|detail|history|his|summary|recommend|search|log)(?:_|$)/;
const CLAIM = /(?:recv|receive|claim|reward|draw_reward|open_box|treasure)/;
const START = /(?:^|_)(?:start|enter|challenge|prepare|enrollment|apply|explore_start)(?:_|$)/;
const END = /(?:^|_)(?:end|finish|settle|result|explore_end)(?:_|$)/;
const BUY = /(?:^|_)(?:buy|exchange|purchase|refresh|reset_cd|skip_cd|revive)(?:_|$)/;
const SELL = /(?:^|_)(?:sell|refund|disband|degrade|rollback)(?:_|$)/;
const UPGRADE = /(?:up_|upgrade|enhance|evolve|train|level_up|active|activate|awaken|refine|nobility)/;
const SET = /(?:^|_)(?:set|save|edit|update|wear|equip|place|select|choose|use|lock|unlock|mark|station|operate)(?:_|$)/;
const MOVE = /(?:^|_)(?:move|transmit|trans_area|explore_region|open_map|enter_area|next_floor|next_level)(?:_|$)/;
const SOCIAL = /(?:create|join|leave|quit|invite|accept|apply|handle|kick|promote|demote|follow|remove|block|present|send|share)/;
const DRAW = /(?:^|_)(?:draw|dice|divine|conjuring)(?:_|$)/;
const GENERIC_ALIASES = new Set(["info", "start_battle", "finish_battle", "end_battle", "claim_reward", "set", "save", "update"]);

const DOMAIN_RULES = [
  ["admin", /^(?:gm|acc|users|settings|ukv|verify_code|upload_token|ver_sign)$/],
  ["social", /^(?:guild|friend|chat|comm_team|apostle|mentor|sp_employ|ufans|ublacklist|red_packet)/],
  ["growth", /^(?:unit|equip|artifact|sig|pentagram|pet|furniture|homeland|astrolabe|emblem|grid|skin|troop|altar|cross_hero|medal|album|achv|book|bounty)/],
  ["competitive", /(?:arena|pvp|champion|gvg|world_boss|rank|curseland|race_dream|sp_boss|activity_boss)/],
  ["event", /^(?:act_|activity|daily_login|sign_in|backflow|pumpkin|fish|candy|cook|texas|shoot_game|god_box|conjuring|divination|dream|starland|carnival|hero_benefit|hero_return|perman_login|monthly_card|hyper_hero|contra_benefit|raid_(?:mira|octopus|care_pet|celebration|journey|food|puffer_fish|act_detective))/],
  ["exploration", /^(?:raid|slg|maze|tower|trial|infinite|cof|side_story|gve|dragon|challenge|mystic|big_rich_man)/],
  ["commerce", /(?:shop|charge|auction|fund|discount|gift|circus|sp_sell)/],
];

function clean(value, depth = 0) {
  if (depth > 6) return null;
  if (value == null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) return value.slice(0, 128).map((entry) => clean(entry, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 128).map(([key, entry]) => [String(key).slice(0, 96), clean(entry, depth + 1)]));
  return String(value);
}

function period(now = new Date()) {
  const ts = Math.floor(now.getTime() / 1000);
  return { day: Math.floor(ts / DAY), week: Math.floor((ts + 3 * DAY) / WEEK), season: Math.floor(ts / SEASON) };
}

function classifyDomain(module) {
  const name = String(module || "");
  return DOMAIN_RULES.find(([, pattern]) => pattern.test(name))?.[0] || "feature";
}

function initialDomainState(module, now = new Date()) {
  return {
    module: String(module), engine: "afk-local-domain-v1", domain: classifyDomain(module), revision: 0,
    progress: 0, level: 1, score: 0, rank: 9999, attempts: 0, wins: 0, losses: 0,
    position: 1, season: period(now).season, resources: {}, claims: {}, counters: {}, values: {},
    roster: [], lineup: [], records: [], history: [], active_session: null, updated_at: null,
  };
}

function normalizedState(current, module, now) {
  const base = initialDomainState(module, now);
  const source = clean(current || {});
  return {
    ...base, ...source, module: String(module), engine: base.engine, domain: classifyDomain(module),
    resources: { ...base.resources, ...(source.resources || {}) }, claims: { ...base.claims, ...(source.claims || {}) },
    counters: { ...base.counters, ...(source.counters || {}) }, values: { ...base.values, ...(source.values || {}) },
    roster: [...(source.roster || [])].slice(-200), lineup: [...(source.lineup || [])].slice(0, 25),
    records: [...(source.records || [])].slice(-49), history: [...(source.history || [])].slice(-99),
  };
}

function stableNumber(...parts) {
  return createHash("sha256").update(parts.map(String).join(":"), "utf8").digest().readUInt32LE(0);
}

function operationKind(operation) {
  const op = String(operation || "info").toLowerCase();
  if (QUERY.test(op)) return "query";
  if (CLAIM.test(op)) return "claim";
  if (END.test(op)) return "end";
  if (START.test(op)) return "start";
  if (DRAW.test(op)) return "draw";
  if (BUY.test(op)) return "buy";
  if (SELL.test(op)) return "sell";
  // Tavern "set_up_hero" means choosing a wishlist target, not upgrading
  // that hero.  Classify it before the broad `up_` growth expression.
  if (/(?:^|_)set_up(?:_|$)/.test(op)) return "set";
  if (UPGRADE.test(op)) return "upgrade";
  if (MOVE.test(op)) return "move";
  if (SOCIAL.test(op)) return "social";
  if (SET.test(op)) return "set";
  return "action";
}

function parseAssetTriples(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (let index = 0; index + 2 < value.length; index += 3) {
    const type = String(value[index] || "").toLowerCase();
    const id = String(value[index + 1] ?? "0");
    const amount = Number(value[index + 2]);
    if (type && Number.isFinite(amount) && amount > 0) result.push({ type, id, amount });
  }
  return result;
}

function findAssets(value, depth = 0) {
  if (!value || depth > 4) return [];
  if (Array.isArray(value)) {
    const direct = parseAssetTriples(value);
    return direct.length ? direct : value.flatMap((entry) => findAssets(entry, depth + 1));
  }
  if (typeof value !== "object") return [];
  const preferred = Object.entries(value).filter(([key]) => /(?:rewards?|drop|goods|cost)$/i.test(key));
  for (const [, entry] of preferred) {
    const assets = findAssets(entry, depth + 1);
    if (assets.length) return assets;
  }
  return Object.values(value).flatMap((entry) => findAssets(entry, depth + 1)).slice(0, 12);
}

function selectConfigRow(info, request, seed) {
  for (const rawName of info.configs || []) {
    const name = String(rawName).replace(/\.json$/, "");
    if (!hasConfig(name)) continue;
    const config = loadConfig(name);
    const ids = Object.keys(config.table);
    if (!ids.length) continue;
    const requested = request.config_id ?? request.stage_id ?? request.floor_id ?? request.id;
    const id = requested != null && config.table[String(requested)] ? String(requested) : ids[seed % ids.length];
    return { name, id, row: config.table[id], sha256: config.sha256 };
  }
  return null;
}

function applyResources(state, costs, rewards) {
  const next = { ...state.resources };
  for (const entry of costs) {
    const key = `${entry.type}:${entry.id}`;
    const available = Number(next[key] || 0);
    if (available < Number(entry.amount)) return { ok: false, error: "insufficient_resource", resource: entry, available };
    next[key] = available - Number(entry.amount);
  }
  for (const entry of rewards) {
    const key = `${entry.type}:${entry.id}`;
    next[key] = Number(next[key] || 0) + Number(entry.amount);
  }
  state.resources = next;
  return { ok: true };
}

function dailyLoginReward(seasonId, rewardId) {
  if (!hasConfig("DailyLogin")) return [];
  const season = loadConfig("DailyLogin").table[String(seasonId)] || {};
  const row = season[String(rewardId)];
  const values = row?.Rewards;
  if (!Array.isArray(values)) return [];
  const rewards = [];
  for (let index = 0; index + 2 < values.length; index += 3) {
    const type = String(values[index] || "").toLowerCase();
    const rawId = String(values[index + 1] ?? "0");
    const id = type === "currency" ? rawId.toLowerCase() : rawId;
    const amount = Math.max(0, Math.trunc(Number(values[index + 2]) || 0));
    if (type && id && amount > 0) rewards.push({ type, id, amount });
  }
  return rewards;
}

function reduceDailyLoginState(state, operation, request, now) {
  const op = String(operation || "open_panel");
  const at = now.toISOString();
  const nowTs = Math.floor(now.getTime() / 1000);
  const requestedCreatedAt = request.player_created_at || request.created_at;
  const parsedCreatedTs = requestedCreatedAt ? Math.floor(new Date(requestedCreatedAt).getTime() / 1000) : 0;
  const storedCreatedTs = Number(state.values.daily_login_created_ts || 0);
  const createdTs = parsedCreatedTs > 0 ? parsedCreatedTs : (storedCreatedTs > 0 ? storedCreatedTs : nowTs);
  const seasonId = Math.max(1, Math.min(2, Number(state.values.daily_login_season_id || 1)));
  const eligibleDay = Math.max(1, Math.min(7, Math.floor(nowTs / DAY) - Math.floor(createdTs / DAY) + 1));
  const cycle = String(request.cycle || `season:${state.season}`);
  const claimed = Array.isArray(state.values.daily_login_claimed_rewards)
    ? state.values.daily_login_claimed_rewards.map(Number).filter((value) => value >= 1 && value <= 7)
    : [];
  let mutated = false;

  for (const [key, value] of Object.entries(state.resources)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey !== key) {
      state.resources[normalizedKey] = Number(state.resources[normalizedKey] || 0) + Number(value || 0);
      delete state.resources[key];
      mutated = true;
    }
  }

  if (storedCreatedTs !== createdTs) {
    state.values.daily_login_created_ts = createdTs;
    mutated = true;
  }
  if (Number(state.values.daily_login_season_id || 0) !== seasonId) {
    state.values.daily_login_season_id = seasonId;
    mutated = true;
  }

  const projection = {
    result: 1,
    season: seasonId,
    season_id: seasonId,
    progress: eligibleDay,
    eligible_day: eligibleDay,
    recved_rewards: [...new Set(claimed)].sort((a, b) => a - b),
    timestamp: nowTs,
  };
  if (operationKind(op) === "query") {
    if (mutated) {
      state.revision += 1;
      state.updated_at = at;
    }
    return { ok: true, mutated, state, kind: "query", costs: [], rewards: [], applied_costs: [], applied_rewards: [], wire_projection: projection,
      policy: "official_daily_login_calendar", config_evidence: { table: "DailyLogin", row_id: String(seasonId) } };
  }

  if (operationKind(op) !== "claim") {
    return { ok: false, status: 422, error: "unsupported_daily_login_operation", operation: op };
  }
  const rewardId = Number(request.reward_id ?? request.field_2 ?? request.id ?? request.value);
  if (!Number.isInteger(rewardId) || rewardId < 1 || rewardId > 7) {
    return { ok: false, status: 422, error: "invalid_daily_login_reward", reward_id: rewardId };
  }
  if (rewardId > eligibleDay) {
    return { ok: false, status: 409, error: "daily_login_reward_locked", reward_id: rewardId, eligible_day: eligibleDay };
  }
  if (claimed.includes(rewardId)) {
    return { ok: false, status: 409, error: "reward_already_claimed", reward_id: rewardId };
  }
  const rewards = dailyLoginReward(seasonId, rewardId);
  if (!rewards.length) {
    return { ok: false, status: 500, error: "daily_login_reward_config_missing", reward_id: rewardId };
  }
  applyResources(state, [], rewards);
  claimed.push(rewardId);
  projection.recved_rewards = [...new Set(claimed)].sort((a, b) => a - b);
  state.values.daily_login_claimed_rewards = projection.recved_rewards;
  state.claims[`daily_login:${cycle}:${rewardId}`] = at;
  state.revision += 1;
  state.updated_at = at;
  state.history.push({ id: randomUUID(), operation: op, kind: "claim", reward_id: rewardId, at });
  state.history = state.history.slice(-100);
  return { ok: true, mutated: true, state, kind: "claim", costs: [], rewards, applied_costs: [], applied_rewards: rewards, wire_projection: projection,
    policy: "official_daily_login_calendar", config_evidence: { table: "DailyLogin", row_id: `${seasonId}.${rewardId}` } };
}

function officialAssets(configName, rowId, field) {
  if (!hasConfig(configName)) return [];
  const row = loadConfig(configName).table[String(rowId)];
  return parseAssetTriples(row?.[field]);
}

function activityProjection(state, now) {
  return { result: 1, level: state.level, progress: state.progress, score: state.score, rank: state.rank,
    position: state.position, attempts: state.attempts, season: state.season, timestamp: Math.floor(now.getTime() / 1000), values: clean(state.values) };
}

function activityResult(state, operation, kind, now, details = {}) {
  const at = now.toISOString();
  const rewards = details.rewards || [];
  const costs = details.costs || [];
  if (details.mutated !== false) {
    state.revision += 1;
    state.updated_at = at;
    state.history.push({ id: randomUUID(), operation, kind, at, ...(details.event || {}) });
    state.history = state.history.slice(-100);
  }
  return { ok: true, mutated: details.mutated !== false, state, kind, costs, rewards,
    applied_costs: details.applied_costs || [], applied_rewards: details.applied_rewards || rewards,
    policy: details.policy || "official_1_201_activity_rules", config_evidence: details.config_evidence || null,
    wire_projection: activityProjection(state, now) };
}

function claimActivityReward(state, key, rewards) {
  if (state.claims[key]) return { ok: false, status: 409, error: "reward_already_claimed", claim_id: key };
  state.claims[key] = new Date().toISOString();
  applyResources(state, [], rewards);
  return { ok: true };
}

function reduceFarmState(state, operation, request, now) {
  const op = String(operation || "open_panel");
  const kind = operationKind(op);
  state.values.fields = state.values.fields && typeof state.values.fields === "object" ? state.values.fields : {};
  state.values.farm_level = Math.max(1, Number(state.values.farm_level || 1));
  if (kind === "query" || op === "open_panel" || op === "open_albums") return activityResult(state, op, "query", now, { mutated: false });
  if (op === "select_type") {
    state.values.selected_type = Math.max(1, Number(request.type_id ?? request.field_2 ?? request.id ?? 1));
    return activityResult(state, op, "set", now);
  }
  if (op === "plant") {
    const fieldId = String(request.field_id ?? request.block_id ?? request.field_2 ?? request.id ?? 1);
    const typeId = Math.max(1, Number(request.type_id ?? request.seed_id ?? state.values.selected_type ?? 1));
    const fieldRow = loadConfig("ActFarmField").table[String(typeId)] || loadConfig("ActFarmField").table["1"];
    const levelRow = loadConfig("ActFarmFieldLevel").table[String(state.values.farm_level)] || {};
    const growSeconds = request.free === true ? 0 : Math.max(1, Number(levelRow.GrowTime || 60));
    state.values.fields[fieldId] = { field_id: fieldId, type_id: typeId, planted_at: Math.floor(now.getTime() / 1000),
      ready_at: Math.floor(now.getTime() / 1000) + growSeconds, watered: false };
    state.attempts += 1;
    return activityResult(state, op, "start", now, { costs: parseAssetTriples(fieldRow?.Cost), applied_costs: request.free === true ? [] : parseAssetTriples(fieldRow?.Cost),
      config_evidence: { table: "ActFarmField", row_id: String(typeId) } });
  }
  if (op === "watering" || op === "watering_all") {
    const ids = op === "watering_all" ? Object.keys(state.values.fields) : [String(request.field_id ?? request.block_id ?? request.id ?? 1)];
    for (const id of ids) if (state.values.fields[id]) { state.values.fields[id].watered = true; state.values.fields[id].ready_at = Math.min(state.values.fields[id].ready_at, Math.floor(now.getTime() / 1000)); }
    return activityResult(state, op, "action", now);
  }
  if (op === "harvest" || op === "harvest_all") {
    let ids = op === "harvest_all" ? Object.keys(state.values.fields) : [String(request.field_id ?? request.block_id ?? request.id ?? 1)];
    if (request.free === true && !ids.some((id) => state.values.fields[id])) {
      const syntheticId = ids[0] || "1";
      state.values.fields[syntheticId] = { field_id: syntheticId, type_id: 1, planted_at: Math.floor(now.getTime() / 1000), ready_at: Math.floor(now.getTime() / 1000), watered: true };
      ids = [syntheticId];
    }
    const ready = ids.filter((id) => state.values.fields[id] && (request.free === true || Number(state.values.fields[id].ready_at) <= Math.floor(now.getTime() / 1000)));
    if (!ready.length) return { ok: false, status: 409, error: "crop_not_ready" };
    const rewards = [];
    for (const id of ready) {
      const crop = state.values.fields[id];
      const fieldRow = loadConfig("ActFarmField").table[String(crop.type_id)] || loadConfig("ActFarmField").table["1"];
      const itemId = String(fieldRow?.FieldShow?.[stableNumber(id, crop.planted_at) % Math.max(1, fieldRow?.FieldShow?.length || 1)] || 101);
      rewards.push({ type: "actfarmitem", id: itemId, amount: Math.max(1, Number(fieldRow?.BasicRate || 10)) });
      delete state.values.fields[id];
      state.progress += 1;
    }
    applyResources(state, [], rewards);
    return activityResult(state, op, "end", now, { rewards, config_evidence: { table: "ActFarmField", row_id: "harvest" } });
  }
  if (op === "recv_album_reward") {
    const itemId = String(request.item_id ?? request.reward_id ?? request.id ?? 101);
    const rewards = officialAssets("ActFarmItem", itemId, "AlbumRewards");
    const claimed = claimActivityReward(state, `album:${itemId}`, rewards);
    if (!claimed.ok) return claimed;
    return activityResult(state, op, "claim", now, { rewards, config_evidence: { table: "ActFarmItem", row_id: itemId } });
  }
  if (op === "recv_daily_reward" || op === "recv_boss_reward") {
    const id = String(request.reward_id ?? request.id ?? 1);
    const rewards = [{ type: "currency", id: "diamond", amount: 50 }];
    const claimed = claimActivityReward(state, `${op}:${period(now).day}:${id}`, rewards);
    if (!claimed.ok) return claimed;
    return activityResult(state, op, "claim", now, { rewards });
  }
  if (op === "challenge_boss") { state.attempts += 1; state.score += Math.max(0, Number(request.damage || 100)); return activityResult(state, op, "end", now); }
  return activityResult(state, op, kind, now);
}

function reduceCarePetState(state, operation, request, now) {
  const op = String(operation || "open_pet_panel");
  const kind = operationKind(op);
  state.values.growth_step = Math.max(0, Number(state.values.growth_step || 0));
  state.values.intimacy = Math.max(0, Number(state.values.intimacy || 0));
  if (kind === "query" || op === "open_pet_panel") return activityResult(state, op, "query", now, { mutated: false });
  if (op === "care_pet") {
    const step = Math.max(1, Number(request.step_id ?? request.growth_id ?? request.id ?? state.values.growth_step + 1));
    const row = loadConfig("ActCarePetGrowth").table[String(step)];
    if (!row) return { ok: false, status: 422, error: "invalid_pet_growth_step", growth_step: step };
    if (step !== state.values.growth_step + 1 && request.free !== true) return { ok: false, status: 409, error: "pet_growth_step_locked", expected: state.values.growth_step + 1 };
    const rewards = parseAssetTriples(row.Rewards);
    state.values.growth_step = Math.max(state.values.growth_step, step);
    state.progress = state.values.growth_step;
    applyResources(state, [], rewards);
    return activityResult(state, op, "upgrade", now, { costs: parseAssetTriples(row.CareCost), applied_costs: request.free === true ? [] : parseAssetTriples(row.CareCost), rewards,
      config_evidence: { table: "ActCarePetGrowth", row_id: String(step) } });
  }
  if (op === "play_pet" || op === "touch_pet") {
    const toyId = String(request.toy_id ?? request.item_id ?? request.id ?? 202648201);
    const row = loadConfig("ActCarePetToy").table[toyId];
    state.values.intimacy += Math.max(1, Number(row?.AddIntimacy || (op === "touch_pet" ? 1 : 5)));
    return activityResult(state, op, "action", now, { config_evidence: row ? { table: "ActCarePetToy", row_id: toyId } : null });
  }
  if (op === "trans_area") { state.position = Math.max(1, Number(request.area_id ?? request.id ?? state.position + 1)); return activityResult(state, op, "move", now); }
  if (op === "recv_mural_reward" || op === "recv_boss_reward") {
    const id = String(request.reward_id ?? request.id ?? 1);
    const rewards = [{ type: "currency", id: "pet_coin", amount: 30 }];
    const claimed = claimActivityReward(state, `${op}:${id}`, rewards);
    if (!claimed.ok) return claimed;
    return activityResult(state, op, "claim", now, { rewards, config_evidence: { table: "ActCarePetGrowth", row_id: String(state.values.growth_step) } });
  }
  if (op === "challenge_boss") { state.attempts += 1; state.score += Math.max(0, Number(request.damage || 100)); return activityResult(state, op, "end", now); }
  return activityResult(state, op, kind, now);
}

function reduceCelebrationState(state, operation, request, now) {
  const op = String(operation || "open_panel");
  const kind = operationKind(op);
  state.values.heat = Math.max(0, Number(state.values.heat || 0));
  state.values.buildings = state.values.buildings && typeof state.values.buildings === "object" ? state.values.buildings : {};
  if (kind === "query" || op === "open_panel") return activityResult(state, op, "query", now, { mutated: false });
  if (op === "submit_task") {
    const taskId = String(request.task_id ?? request.id ?? 1);
    if (state.claims[`task:${taskId}`]) return { ok: false, status: 409, error: "celebration_task_already_submitted", task_id: taskId };
    const row = loadConfig("ActCelebrationTask").table[taskId];
    if (!row) return { ok: false, status: 422, error: "invalid_celebration_task", task_id: taskId };
    const rewards = parseAssetTriples(row.Rewards);
    state.claims[`task:${taskId}`] = now.toISOString();
    state.values.heat += rewards.filter((asset) => asset.type === "celebration" && asset.id === "1").reduce((sum, asset) => sum + Number(asset.amount), 0);
    applyResources(state, [], rewards);
    return activityResult(state, op, "claim", now, { rewards, config_evidence: { table: "ActCelebrationTask", row_id: taskId } });
  }
  if (op === "heat_reward") {
    const rewardId = String(request.reward_id ?? request.id ?? 1);
    const row = loadConfig("ActCelebrationHeatReward").table[rewardId];
    if (!row) return { ok: false, status: 422, error: "invalid_heat_reward", reward_id: rewardId };
    if (state.values.heat < Number(row.HeatRequired || 0) && request.free !== true) return { ok: false, status: 409, error: "celebration_heat_not_reached", required: Number(row.HeatRequired || 0), current: state.values.heat };
    const rewards = parseAssetTriples(row.Rewards);
    const claimed = claimActivityReward(state, `heat:${rewardId}`, rewards);
    if (!claimed.ok) return claimed;
    return activityResult(state, op, "claim", now, { rewards, config_evidence: { table: "ActCelebrationHeatReward", row_id: rewardId } });
  }
  if (op === "upgrade_building") {
    const buildingId = String(request.building_id ?? request.id ?? 1000);
    state.values.buildings[buildingId] = Math.max(1, Number(state.values.buildings[buildingId] || 0) + 1);
    state.level = Math.max(state.level, state.values.buildings[buildingId]);
    return activityResult(state, op, "upgrade", now, { config_evidence: { table: "ActCelebrationBuilding", row_id: buildingId } });
  }
  if (op === "challenge_boss") { state.attempts += 1; state.score += Math.max(0, Number(request.damage || 100)); return activityResult(state, op, "end", now); }
  if (op === "recv_boss_reward") {
    const id = String(request.reward_id ?? request.id ?? 1);
    const rewards = [{ type: "currency", id: "diamond", amount: 100 }];
    const claimed = claimActivityReward(state, `boss:${id}`, rewards);
    if (!claimed.ok) return claimed;
    return activityResult(state, op, "claim", now, { rewards });
  }
  return activityResult(state, op, kind, now);
}

function derivedEconomy(info, request, kind, seed) {
  const selected = selectConfigRow(info, request, seed);
  const configured = selected ? findAssets(selected.row) : [];
  const evidence = selected ? { table: selected.name, row_id: selected.id, sha256: selected.sha256 } : null;
  if (kind === "claim" || kind === "end" || kind === "draw" || kind === "sell") {
    const rewards = configured.length ? configured.slice(0, 8) : [{ type: "currency", id: "gold", amount: 100 + seed % 900 }];
    return { costs: [], rewards, evidence, policy: configured.length ? "official_config" : "deterministic_local" };
  }
  if (kind === "buy" || kind === "upgrade") {
    const amount = Math.max(1, Number(request.cost_amount || 10));
    return { costs: [{ type: "currency", id: String(request.cost_id || "diamond"), amount }], rewards: [], evidence, policy: "local_transaction_policy" };
  }
  return { costs: [], rewards: [], evidence, policy: selected ? "official_config" : "deterministic_local" };
}

function claimKey(state, operation, request, now) {
  const cycle = request.cycle || (state.domain === "event" ? `season:${period(now).season}` : `day:${period(now).day}`);
  return `${cycle}:${request.claim_id ?? request.reward_id ?? request.id ?? operation}`.slice(0, 160);
}

function reduceDomainState(current, info, operation, request = {}, now = new Date()) {
  const module = String(info.module);
  const allowed = new Set(info.operations || []);
  const op = String(operation || "info").slice(0, 96);
  if (allowed.size && !allowed.has(op) && !GENERIC_ALIASES.has(op)) return { ok: false, status: 422, error: "unsupported_module_operation", module, operation: op };
  const state = normalizedState(current, module, now);
  if (module === "daily_login") return reduceDailyLoginState(state, op, request, now);
  if (module === "act_farm") return reduceFarmState(state, op, request, now);
  if (module === "raid_care_pet") return reduceCarePetState(state, op, request, now);
  if (module === "raid_celebration") return reduceCelebrationState(state, op, request, now);
  const kind = operationKind(op);
  const at = now.toISOString();
  const seed = Number(request.seed || stableNumber(module, op, state.revision, request.id || request.stage_id || 0));
  const event = { id: randomUUID(), operation: op, kind, at, seed };
  const economy = derivedEconomy(info, request, kind, seed);
  let appliedCosts = [];
  let appliedRewards = [];
  let mutated = kind !== "query";

  if (state.season !== period(now).season) {
    state.season = period(now).season;
    state.attempts = 0; state.score = 0; state.rank = 9999; state.active_session = null;
    event.season_reset = true; mutated = true;
  }

  if (kind === "claim") {
    const key = claimKey(state, op, request, now);
    if (state.claims[key]) return { ok: false, status: 409, error: "reward_already_claimed", claim_id: key };
    const applied = applyResources(state, [], economy.rewards);
    if (!applied.ok) return { ...applied, status: 409 };
    appliedRewards = economy.rewards;
    state.claims[key] = at; event.claim_id = key;
  } else if (kind === "start") {
    if (state.active_session && request.force !== true) return { ok: false, status: 409, error: "session_already_active", session: state.active_session };
    state.attempts += 1;
    state.active_session = { id: randomUUID(), operation: op, seed, started_at: at, stage: Number(request.stage_id || request.floor_id || state.progress + 1), lineup: clean(request.lineup || request.lineup_ids || state.lineup) };
    event.session_id = state.active_session.id;
  } else if (kind === "end") {
    const victory = request.victory !== false && String(request.result || "victory").toLowerCase() !== "defeat";
    const scoreDelta = Math.max(0, Math.trunc(Number(request.score_delta ?? request.damage ?? (victory ? 100 : 0)) || 0));
    if (victory) { state.wins += 1; state.progress = Math.max(state.progress, Number(request.progress || request.floor || request.stage_id || state.progress + 1)); }
    else state.losses += 1;
    state.score += scoreDelta; state.rank = Math.max(1, state.rank - (victory ? 1 : 0));
    if (victory) { applyResources(state, [], economy.rewards); appliedRewards = economy.rewards; }
    state.records.push({ id: randomUUID(), at, result: victory ? "victory" : "defeat", score_delta: scoreDelta, session: state.active_session });
    state.active_session = null; event.result = victory ? "victory" : "defeat"; event.score_delta = scoreDelta;
  } else if (kind === "draw") {
    const count = Math.max(1, Math.min(100, Number(request.count || 1)));
    state.counters.draws = Number(state.counters.draws || 0) + count;
    appliedCosts = economy.costs;
    appliedRewards = economy.rewards.map((row) => ({ ...row, amount: row.amount * count }));
    applyResources(state, appliedCosts, appliedRewards);
    state.roster.push(...Array.from({ length: count }, (_, index) => ({ id: `${module}_${seed}_${index + 1}`, tid: 1 + ((seed + index) % 9999), acquired_at: at })));
  } else if (kind === "buy" || kind === "upgrade") {
    appliedCosts = request.free === true ? [] : economy.costs;
    appliedRewards = economy.rewards;
    const applied = applyResources(state, appliedCosts, appliedRewards);
    if (!applied.ok) return { ...applied, status: 409 };
    if (kind === "upgrade") state.level = Math.max(state.level + 1, Number(request.level || 0));
    state.counters[op] = Number(state.counters[op] || 0) + 1;
  } else if (kind === "sell") {
    applyResources(state, [], economy.rewards);
    appliedRewards = economy.rewards;
    const target = String(request.id || request.entity_id || "");
    if (target) state.roster = state.roster.filter((row) => String(row.id) !== target);
  } else if (kind === "move") {
    state.position = Math.max(1, Number(request.position || request.cell_id || request.block_id || state.position + 1));
    state.progress = Math.max(state.progress, state.position); event.position = state.position;
  } else if (kind === "set") {
    const values = request.payload || request.values || {};
    if (request.lineup || request.lineup_ids) state.lineup = clean(request.lineup || request.lineup_ids).slice(0, 25);
    if (request.key) state.values[String(request.key).slice(0, 96)] = clean(request.value);
    if (values && typeof values === "object" && !Array.isArray(values)) Object.assign(state.values, clean(values));
  } else if (kind === "social") {
    const id = String(request.target_id || request.uid || request.guild_id || request.id || seed);
    if (/(?:leave|quit|remove|cancel|kick|unfollow|block)/.test(op)) state.roster = state.roster.filter((row) => String(row.id) !== id);
    else if (!state.roster.some((row) => String(row.id) === id)) state.roster.push({ id, name: String(request.name || `${module}-${id}`).slice(0, 64), joined_at: at });
  } else if (kind === "action") {
    state.counters[op] = Number(state.counters[op] || 0) + 1;
    if (request.payload && typeof request.payload === "object") Object.assign(state.values, clean(request.payload));
  }

  if (mutated) {
    state.revision += 1; state.updated_at = at;
    state.history.push(event); state.history = state.history.slice(-100); state.records = state.records.slice(-50); state.roster = state.roster.slice(-200);
  }
  return {
    ok: true, mutated, state, event, kind, costs: economy.costs, rewards: economy.rewards, applied_costs: appliedCosts, applied_rewards: appliedRewards,
    config_evidence: economy.evidence, policy: economy.policy,
    wire_projection: { result: 1, level: state.level, progress: state.progress, score: state.score, rank: state.rank, position: state.position, attempts: state.attempts, season: state.season, timestamp: Math.floor(now.getTime() / 1000) },
  };
}

module.exports = { classifyDomain, initialDomainState, operationKind, reduceDomainState };
