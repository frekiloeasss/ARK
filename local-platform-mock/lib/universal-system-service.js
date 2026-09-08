const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { hasConfig, loadConfig } = require("./official-config-catalog");
const { finishAuthoritativeBattle, startAuthoritativeBattle } = require("./authoritative-battle-service");
const { classifyDomain, initialDomainState, operationKind, reduceDomainState } = require("./protocol-domain-engine");

const coveragePath = path.resolve(
  process.env.AFK_PROTOCOL_COVERAGE || path.join(__dirname, "..", "runtime", "protocol-coverage.json")
);
const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"));
const deviceCoveragePath = path.join(
  __dirname, "..", "runtime", "official-updates", "1.201.01", "protocol", "device-protocol-coverage.json"
);
const deviceCoverage = fs.existsSync(deviceCoveragePath)
  ? JSON.parse(fs.readFileSync(deviceCoveragePath, "utf8"))
  : { summary: { client_version: null, module_count: 0 }, modules: [] };
const modules = new Map();
for (const entry of [...coverage.modules, ...(deviceCoverage.modules || [])]) {
  const current = modules.get(entry.module);
  if (!current) {
    modules.set(entry.module, entry);
    continue;
  }
  // Classic and HD can expose the same root module with different operation
  // sets (for example stage.query_reward versus stage.query_idle_reward).
  // Keep the newest field metadata, but never discard operations/configs that
  // are still emitted by another supported client variant.
  modules.set(entry.module, {
    ...current,
    ...entry,
    operations: [...new Set([...(current.operations || []), ...(entry.operations || [])])],
    configs: [...new Set([...(current.configs || []), ...(entry.configs || [])])],
    runtime_mentions: Math.max(Number(current.runtime_mentions || 0), Number(entry.runtime_mentions || 0)),
  });
}
const latestConfigOverrides = {
  act_farm: ["ActFarmBuff", "ActFarmConfig", "ActFarmField", "ActFarmFieldLevel", "ActFarmItem"],
  raid_care_pet: ["ActCarePetArea", "ActCarePetDiary", "ActCarePetGrowth", "ActCarePetGrowthEvent", "ActCarePetSummary", "ActCarePetToy"],
  raid_celebration: ["ActCelebrationBuilding", "ActCelebrationCartoon", "ActCelebrationHeatReward", "ActCelebrationTask", "ActCelebrationHeroBook", "ActCelebrationLog"],
};

function clean(value, depth = 0) {
  if (depth > 5) return null;
  if (value == null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => clean(entry, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, entry]) => [String(key).slice(0, 96), clean(entry, depth + 1)]));
  return String(value);
}

function moduleInfo(name) {
  const info = modules.get(String(name || ""));
  if (!info) return null;
  return {
    module: info.module,
    request_field: info.field_number,
    operations: info.operations,
    configs: [...new Set([...(latestConfigOverrides[info.module] || []), ...info.configs.map((name) => name.replace(/\.json$/, ""))])],
    deprecated: info.deprecated,
    evidence_level: "recovered_official_proto_and_client_config",
  };
}

function configPreview(info, request = {}) {
  const requested = request.config ? String(request.config).replace(/\.json$/, "") : "";
  const names = requested ? [requested] : info.configs.slice(0, 3);
  return names.filter(hasConfig).map((name) => {
    const loaded = loadConfig(name);
    const ids = request.config_id != null ? [String(request.config_id)] : Object.keys(loaded.table).slice(0, 12);
    return { name, sha256: loaded.sha256, rows: ids.map((id) => loaded.table[id]).filter(Boolean) };
  });
}

function initialState(module) { return initialDomainState(module); }

function validatePlayerNickname(value) {
  const nickname = String(value ?? "").normalize("NFKC").trim();
  const length = [...nickname].length;
  if (length < 2 || length > 16) return { ok: false, error: "nickname_length", nickname };
  if (/[\u0000-\u001f\u007f<>\\/]/u.test(nickname)) return { ok: false, error: "nickname_invalid_characters", nickname };
  const compact = nickname.replace(/\s+/gu, "").toLowerCase();
  const blocked = ["管理员", "系统公告", "官方客服", "game master", "gamemaster", "administrator"];
  if (blocked.some((word) => compact.includes(word.replace(/\s+/gu, "")))) {
    return { ok: false, error: "nickname_blocked", nickname };
  }
  return { ok: true, nickname };
}

async function editUserProfile(connection, playerId, request) {
  const [rows] = await connection.execute(
    "SELECT nickname,profile_json FROM players WHERE id=? LIMIT 1 FOR UPDATE", [playerId]
  );
  if (!rows.length) return { ok: false, status: 404, error: "player_not_found" };
  const current = rows[0];
  const profile = typeof current.profile_json === "string"
    ? JSON.parse(current.profile_json || "{}") : (current.profile_json || {});
  const fields = request.payload && typeof request.payload === "object" ? request.payload : request;
  const nicknameValue = fields.field_1 ?? fields.name;
  let nickname = String(current.nickname || "Player");
  if (nicknameValue != null) {
    const checked = validatePlayerNickname(nicknameValue);
    if (!checked.ok) return { ...checked, status: 422 };
    nickname = checked.nickname;
  }
  const profileFields = {
    avatar: fields.field_2 ?? fields.avatar,
    frame: fields.field_3 ?? fields.frame,
    gender: fields.field_4 ?? fields.gender,
    country_or_region: fields.field_5 ?? fields.country_or_region,
    desc: fields.field_6 ?? fields.desc,
    lang: fields.field_7 ?? fields.lang,
    city: fields.field_8 ?? fields.city,
    im_bubble: fields.field_9 ?? fields.im_bubble,
    display_opt: fields.field_11 ?? fields.display_opt,
    nameplate: fields.field_12 ?? fields.nameplate,
  };
  for (const [key, value] of Object.entries(profileFields)) {
    if (value != null) profile[key] = value;
  }
  profile.nickname_updated_at = new Date().toISOString();
  await connection.execute(
    "UPDATE players SET nickname=?,profile_json=? WHERE id=?",
    [nickname, JSON.stringify(profile), playerId]
  );
  return {
    ok: true, module: "users", operation: "req_edit_user", kind: "mutation",
    nickname, profile, costs: [], rewards: [],
    wire_projection: { result: "success", name: nickname, desc: String(profile.desc || "") },
    implementation: "local_authoritative_user_profile",
    evidence_level: "official_req_edit_user_schema_local_persistence",
  };
}

function reduceState(current, operation, request = {}, now = new Date()) {
  const info = moduleInfo(current.module);
  if (!info) return { ok: false, status: 404, error: "unknown_protocol_module", module: current.module };
  return reduceDomainState(current, info, operation, clean(request), now);
}

async function readState(pool, playerId, module) {
  const [rows] = await pool.execute("SELECT state_json,version,updated_at FROM player_system_state WHERE player_id=? AND module_name=? LIMIT 1", [playerId, module]);
  if (!rows.length) return initialState(module);
  const state = typeof rows[0].state_json === "string" ? JSON.parse(rows[0].state_json) : rows[0].state_json;
  return { ...initialState(module), ...state, version: Number(rows[0].version) };
}

function persistedItemId(reward) {
  const type = String(reward?.type || "item").toLowerCase();
  const id = String(reward?.id ?? "0").toLowerCase();
  return type === "currency" ? id : `${type}_${id}`;
}

function rewardCharacterId(playerId, info, operation, request, transition, reward, index) {
  const identity = [playerId, info.module, operation, request.idempotency_key ?? request.request_seq ?? "", request.cycle ?? "",
    request.claim_id ?? request.reward_id ?? request.field_2 ?? request.id ?? "", transition.event?.id ?? transition.state?.revision ?? "", reward.id ?? "", index].join(":");
  return `system:${info.module}:${createHash("sha256").update(identity).digest("hex").slice(0, 48)}`.slice(0, 128);
}

async function persistSystemRewards(connection, playerId, info, operation, request, transition) {
  const rewards = Array.isArray(transition.applied_rewards) ? transition.applied_rewards : [];
  for (let index = 0; index < rewards.length; index += 1) {
    const reward = rewards[index] || {};
    const type = String(reward.type || "item").toLowerCase();
    const id = String(reward.id ?? "0");
    const amount = Math.max(0, Math.trunc(Number(reward.amount) || 0));
    if (!id || amount < 1) continue;
    const source = JSON.stringify({ source: "system_action", module: info.module, operation: String(operation || "info"),
      config_evidence: transition.config_evidence || null, policy: transition.policy || null });
    if (type === "hero") {
      const count = Math.min(amount, 100);
      for (let copy = 0; copy < count; copy += 1) {
        const characterId = rewardCharacterId(playerId, info, operation, request, transition, reward, `${index}:${copy}`);
        await connection.execute(
          "INSERT IGNORE INTO characters (player_id,character_id,level,star,extra_json) VALUES (?,?,?,?,?)",
          [playerId, characterId, 1, 1, JSON.stringify({ source: "system_action", module: info.module, tid: Number(id) || id, hero_id: characterId })]
        );
      }
      continue;
    }
    const itemId = persistedItemId(reward);
    await connection.execute(
      "INSERT INTO inventory_items (player_id,item_id,quantity,extra_json) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE quantity=quantity+VALUES(quantity),extra_json=VALUES(extra_json)",
      [playerId, itemId, amount, source]
    );
  }
  if (rewards.length) {
    await connection.execute(
      "UPDATE players SET diamond=COALESCE((SELECT quantity FROM inventory_items WHERE player_id=? AND item_id='diamond'),diamond),gold=COALESCE((SELECT quantity FROM inventory_items WHERE player_id=? AND item_id='gold'),gold) WHERE id=?",
      [playerId, playerId, playerId]
    );
  }
  return rewards.length;
}

function isAuthoritativeBattleOperation(module, operation, kind) {
  if (kind !== "start" && kind !== "end") return false;
  if (!/(?:battle|challenge|boss|fight|settle|result)/i.test(String(operation || ""))) return false;
  return /(?:arena|pvp|champion|boss|raid|tower|maze|infinite|trial|gve|slg|war|curseland|challenge|cof)/i.test(String(module || ""));
}

function battleRecord(row) {
  return { ok: true, battle_id: row.id, mode: row.mode, stage_id: Number(row.stage_id), seed: Number(row.seed),
    lineup_ids: typeof row.lineup_json === "string" ? JSON.parse(row.lineup_json) : row.lineup_json,
    simulation: typeof row.simulation_json === "string" ? JSON.parse(row.simulation_json) : row.simulation_json,
    server_result: row.server_result, evidence_level: "server_authoritative_decrypted_unit_and_stage_config" };
}

async function prepareAuthoritativeBattle(connection, playerId, info, operation, request) {
  const kind = operationKind(operation);
  if (!isAuthoritativeBattleOperation(info.module, operation, kind)) return null;
  const mode = String(info.module).slice(0, 32);
  if (kind === "end") {
    const [rows] = await connection.execute(
      "SELECT * FROM battle_records WHERE player_id=? AND mode=? AND status='active' ORDER BY started_at DESC LIMIT 1 FOR UPDATE",
      [playerId, mode]
    );
    if (!rows.length) return { ok: false, status: 404, error: "active_battle_not_found", mode };
    const verification = finishAuthoritativeBattle(battleRecord(rows[0]), request.result);
    await connection.execute(
      "UPDATE battle_records SET client_result=?,verified=?,status='finished',finished_at=NOW() WHERE id=? AND player_id=?",
      [verification.client_result || null, verification.verified ? 1 : 0, verification.battle_id, playerId]
    );
    return { ...verification, mode, phase: "settlement" };
  }
  const [characters] = await connection.execute("SELECT character_id,level,star,extra_json FROM characters WHERE player_id=? ORDER BY id LIMIT 200", [playerId]);
  const [inventory] = await connection.execute("SELECT item_id,quantity,extra_json FROM inventory_items WHERE player_id=? ORDER BY id LIMIT 2000", [playerId]);
  const state = {
    characters: characters.map((row) => ({ ...row, extra_json: typeof row.extra_json === "string" ? JSON.parse(row.extra_json) : (row.extra_json || {}) })),
    inventory: inventory.map((row) => ({ ...row, extra_json: typeof row.extra_json === "string" ? JSON.parse(row.extra_json) : (row.extra_json || {}) })),
  };
  const battle = startAuthoritativeBattle(state, { ...request, mode,
    stage_id: Number(request.stage_id ?? request.floor_id ?? request.boss_id ?? request.id ?? 1),
    lineup_ids: request.lineup_ids || request.lineup || [] });
  if (!battle.ok) return battle;
  await connection.execute(
    "INSERT INTO battle_records (id,player_id,mode,stage_id,seed,lineup_json,simulation_json,server_result,status) VALUES (?,?,?,?,?,?,?,?,'active')",
    [battle.battle_id, playerId, mode, battle.stage_id, battle.seed, JSON.stringify(battle.lineup_ids), JSON.stringify(battle.simulation), battle.server_result]
  );
  return { ...battle, phase: "start" };
}

async function executeSystemAction(pool, playerId, moduleName, operation, request = {}) {
  const info = moduleInfo(moduleName);
  if (!info) return { ok: false, status: 404, error: "unknown_protocol_module", module: moduleName };
  if (request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)) {
    request = { ...request, ...request.payload };
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (info.module === "users" && String(operation || "") === "req_edit_user") {
      const response = await editUserProfile(connection, playerId, request);
      if (!response.ok) { await connection.rollback(); return response; }
      await connection.commit();
      return response;
    }
    const requestKeyRaw = request.idempotency_key ?? request.request_seq;
    const requestKey = requestKeyRaw == null ? null : String(requestKeyRaw).slice(0, 191);
    if (requestKey && operationKind(operation) !== "query") {
      const [receipts] = await connection.execute(
        "SELECT response_json FROM system_action_receipts WHERE player_id=? AND module_name=? AND request_key=? LIMIT 1 FOR UPDATE",
        [playerId, info.module, requestKey]
      );
      if (receipts.length) {
        const stored = typeof receipts[0].response_json === "string" ? JSON.parse(receipts[0].response_json) : receipts[0].response_json;
        await connection.commit();
        return { ...stored, idempotent_replay: true };
      }
    }
    let liveops = null;
    if (classifyDomain(info.module) === "event") {
      const [instances] = await connection.execute("SELECT * FROM liveops_instances WHERE activity_key=? LIMIT 1 FOR UPDATE", [info.module]);
      if (!instances.length) { await connection.rollback(); return { ok: false, status: 404, error: "activity_instance_not_found", module: info.module }; }
      const instance = instances[0];
      const nowMs = request.now_ts ? Number(request.now_ts) * 1000 : Date.now();
      const startsAt = new Date(instance.starts_at).getTime();
      const endsAt = new Date(instance.ends_at).getTime();
      const claimEndsAt = instance.claim_ends_at ? new Date(instance.claim_ends_at).getTime() : endsAt;
      let phase = "preheat";
      if (instance.status === "paused") phase = "paused";
      else if (instance.status === "ended" || nowMs > claimEndsAt) phase = "closed";
      else if (nowMs >= startsAt && nowMs <= endsAt && instance.status === "active") phase = "active";
      else if (nowMs > endsAt && nowMs <= claimEndsAt) phase = "claim";
      const kind = operationKind(operation);
      const readOnly = kind === "query";
      const claimAllowed = kind === "claim" && (phase === "active" || phase === "claim");
      if (!readOnly && !claimAllowed && phase !== "active") {
        await connection.rollback();
        return { ok: false, status: 409, error: "activity_phase_disallows_operation", module: info.module, phase, operation };
      }
      const rules = typeof instance.rules_json === "string" ? JSON.parse(instance.rules_json) : instance.rules_json;
      liveops = { id: Number(instance.id), activity_key: instance.activity_key, title: instance.title, phase,
        starts_at: instance.starts_at, ends_at: instance.ends_at, claim_ends_at: instance.claim_ends_at, rules: rules || {} };
      request = { ...request, cycle: `liveops:${instance.id}` };
    }
    if (info.module === "daily_login") {
      const [players] = await connection.execute("SELECT created_at FROM players WHERE id=? LIMIT 1 FOR UPDATE", [playerId]);
      if (!players.length) { await connection.rollback(); return { ok: false, status: 404, error: "player_not_found" }; }
      const createdAt = players[0].created_at instanceof Date
        ? players[0].created_at.toISOString()
        : String(players[0].created_at);
      request = { ...request, player_created_at: createdAt };
    }
    const [rows] = await connection.execute("SELECT state_json,version FROM player_system_state WHERE player_id=? AND module_name=? FOR UPDATE", [playerId, info.module]);
    const before = rows.length ? (typeof rows[0].state_json === "string" ? JSON.parse(rows[0].state_json) : rows[0].state_json) : initialState(info.module);
    const authoritativeBattle = await prepareAuthoritativeBattle(connection, playerId, info, operation, request);
    if (authoritativeBattle && !authoritativeBattle.ok) { await connection.rollback(); return authoritativeBattle; }
    if (authoritativeBattle?.phase === "settlement") request = { ...request, result: authoritativeBattle.result, victory: authoritativeBattle.result === "victory" };
    const transition = reduceState(before, operation, request);
    if (!transition.ok) { await connection.rollback(); return transition; }
    if (authoritativeBattle?.phase === "start" && transition.state.active_session) {
      transition.state.active_session = { ...transition.state.active_session, battle_id: authoritativeBattle.battle_id,
        seed: authoritativeBattle.seed, server_result: authoritativeBattle.server_result, authority: "afk-local-authoritative-v2" };
    }
    if (transition.mutated) {
      await connection.execute(
        "INSERT INTO player_system_state (player_id,module_name,state_json,version) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE state_json=VALUES(state_json),version=version+1",
        [playerId, info.module, JSON.stringify(transition.state)]
      );
    }
    await persistSystemRewards(connection, playerId, info, operation, request, transition);
    const response = { ok: true, module: info.module, operation: String(operation || "info"), kind: transition.kind, state: transition.state,
      costs: transition.costs, rewards: transition.rewards, wire_projection: transition.wire_projection,
      config: request.include_config === false ? [] : configPreview(info, request), protocol: info, liveops,
      authoritative_battle: authoritativeBattle,
      implementation: "local_authoritative_domain_engine", evidence_level: "official_protocol_and_config_local_server_policy", idempotent_replay: false };
    if (requestKey && transition.mutated) {
      await connection.execute(
        "INSERT INTO system_action_receipts (player_id,module_name,request_key,response_json) VALUES (?,?,?,?)",
        [playerId, info.module, requestKey, JSON.stringify(response)]
      );
    }
    await connection.commit();
    return response;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

function catalogSummary() {
  return { ok: true, client_version: deviceCoverage.summary?.client_version || coverage.summary?.client_version,
    module_count: modules.size,
    config_count: Math.max(Number(coverage.summary?.decrypted_config_count || 0), Number(deviceCoverage.summary?.decrypted_config_count || 0)),
    coverage: { classic: coverage.summary, hd_1_201: deviceCoverage.summary }, modules: [...modules.keys()].map(moduleInfo),
    evidence_level: "recovered_official_proto_and_client_config" };
}

module.exports = { catalogSummary, executeSystemAction, initialState, moduleInfo, persistSystemRewards, prepareAuthoritativeBattle, readState, reduceState, validatePlayerNickname };
