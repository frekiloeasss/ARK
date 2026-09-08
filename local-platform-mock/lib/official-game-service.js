const OFFICIAL_RULES = require("../data/official/v1.182.03.301371.json");
const HERO_LEVEL_COSTS = require("../data/official/hero-level-costs.json");
const { loadConfig } = require("./official-config-catalog");

const LOCAL_TAVERN_POLICY = {
  evidence_level: "captured_single_draw_with_configurable_local_extensions",
  pools: {
    1: {
      cost: OFFICIAL_RULES.tavern.single_draw.cost,
      allowed_counts: [1, 10],
      heroes: [{ ...OFFICIAL_RULES.tavern.single_draw.reward_hero, weight: 1 }],
      pity: {
        counter_item: "meta_tavern_pity_1",
        threshold: null,
        guaranteed_tids: [],
      },
      duplicate: {
        mode: "copy_item",
        item_prefix: "hero_copy_",
        amount: 1,
      },
    },
  },
};

function extendTavernPolicyFromOfficialConfig(policy) {
  let taverns;
  let units;
  try {
    taverns = loadConfig("Tavern").table;
    units = Object.values(loadConfig("Unit").table).filter((row) =>
      row && row.Enable !== false && row.UnitType === "Hero" && Number(row.ID) > 0
    );
  } catch {
    return policy;
  }
  const baseHero = OFFICIAL_RULES.tavern.single_draw.reward_hero;
  for (const [idText, variants] of Object.entries(taverns)) {
    const tavernId = Number(idText);
    if (policy.pools[tavernId]) continue;
    const row = variants?.["0"] || Object.values(variants || {})[0];
    if (!row) continue;
    const costs = Array.isArray(row.Costs) ? row.Costs : [];
    const drawSize = Math.max(1, Number(row.TaskCount || (tavernId % 2 === 0 ? 10 : 1)));
    let cost = { type: "currency", id: "diamond", amount: 300 };
    if (costs.length >= 3) {
      const type = String(costs[0]).toLowerCase();
      const rawId = String(costs[1]);
      const total = Math.max(1, Number(costs[2]) || 1);
      cost = { type, id: type === "currency" ? rawId.toLowerCase() : Number(rawId) || rawId, amount: Math.max(1, Math.ceil(total / drawSize)) };
    }
    const candidates = units.slice((tavernId * 7) % Math.max(1, units.length - 8), (tavernId * 7) % Math.max(1, units.length - 8) + 8);
    policy.pools[tavernId] = {
      cost, allowed_counts: [1, 10],
      heroes: candidates.map((unit, index) => ({ ...baseHero, id: 100000 + tavernId * 100 + index,
        tid: Number(unit.ID), quality: Math.max(1, Number(unit.InitialQuality || 1)), weight: 1 })),
      pity: { counter_item: `meta_tavern_pity_${tavernId}`, threshold: 30,
        guaranteed_tids: candidates.slice(0, 1).map((unit) => Number(unit.ID)) },
      duplicate: { mode: "copy_item", item_prefix: "hero_copy_", amount: 1 },
      config_evidence: { table: "Tavern", row_id: tavernId, pool_id: Number(row.PoolID || 0) },
    };
  }
  return policy;
}

extendTavernPolicyFromOfficialConfig(LOCAL_TAVERN_POLICY);

function unitsForSpecialPool(kind) {
  const units = Object.values(loadConfig("Unit").table).filter((row) =>
    row && row.Enable !== false && row.UnitType === "Hero" && Number(row.ID) > 0
  );
  if (kind === "sp") {
    return units.filter((row) => row.UnitRarity === "Golden" && row.HeroTag !== "Dragon");
  }
  if (kind === "dragon-highborn") {
    return units.filter((row) => row.UnitRarity === "Golden" && row.HeroTag === "Dragon");
  }
  return units.filter((row) => row.HeroTag === "Dragon" && row.UnitRarity !== "Golden");
}

// Classic 1.201 uses the three paired Tavern IDs from Tavern.json directly:
// 23/24 = SP, 25/26 = normal Draconis, 27/28 = selected highborn Draconis.
// An earlier compatibility shim shifted and overwrote these policies, then
// returned starter TIDs 17..24. The Dragon Tavern can draw its faction badge
// for those rows but cannot build a Dragon card portrait, producing the black
// cards seen on device. Keep the official IDs/costs and only use heroes whose
// metadata and art belong to the requested Classic pool.
const spUnits = unitsForSpecialPool("sp");
const normalDragonUnits = unitsForSpecialPool("dragon-normal");
const highbornDragonUnits = unitsForSpecialPool("dragon-highborn");
for (const tavernId of [23, 24, 25, 26, 27, 28]) {
  const pool = LOCAL_TAVERN_POLICY.pools[tavernId];
  if (!pool) continue;
  const candidates = tavernId <= 24
    ? spUnits
    : tavernId <= 26
      ? [...normalDragonUnits, ...highbornDragonUnits]
      : highbornDragonUnits;
  pool.heroes = candidates.map((unit, index) => ({
    ...OFFICIAL_RULES.tavern.single_draw.reward_hero,
    id: 100000 + tavernId * 100 + index,
    tid: Number(unit.ID),
    quality: Number(unit.InitialQuality || (unit.UnitRarity === "Golden" ? 6 : 4)),
    weight: 1,
  }));
  pool.pity.guaranteed_tids = candidates.slice(0, 1).map((unit) => Number(unit.ID));

  if (tavernId === 25 || tavernId === 26) {
    // TavernPool 14 (Classic 1.201): Green 52.43%, Blue 42.86%,
    // Purple 4.61%, SP/Highborn 0.10%. Split each tier evenly between
    // the eligible heroes so adding a new hero does not change tier odds.
    const tierWeight = new Map([[1, 52.43], [2, 42.86], [4, 4.61], [6, 0.10]]);
    const tierCounts = new Map();
    for (const hero of pool.heroes) tierCounts.set(hero.quality, (tierCounts.get(hero.quality) || 0) + 1);
    pool.heroes = pool.heroes.map((hero) => ({
      ...hero,
      weight: (tierWeight.get(hero.quality) || 0) / Math.max(1, tierCounts.get(hero.quality) || 1),
    }));
    pool.probability_evidence = "TavernPool:14";
  } else {
    // Hyper-gacha tables are server-owned and expose the reward art but not
    // numeric odds in the client config. Use the retail-like 2% target rate,
    // with the remaining draws represented by real HyperGacha item assets.
    pool.hero_rate = 0.02;
    pool.asset_rewards = [
      { type: "item", id: 84, amount: 1, weight: 40 },
      { type: "item", id: 60, amount: 1, weight: 25 },
      { type: "item", id: 61, amount: 1, weight: 20 },
      { type: "currency", id: "diamond", amount: 300, weight: 10 },
      { type: "item", id: 87, amount: 1, weight: 3 },
    ];
    pool.pity.threshold = 65;
    pool.probability_evidence = "classic_hypergacha_local_2_percent_policy";
  }
}

// Retain 29/30 as non-Classic compatibility aliases without mutating the
// canonical 23..28 policies used by MuMu1 Classic regression.
for (const [targetId, sourceId] of [[29, 27], [30, 28]]) {
  const source = LOCAL_TAVERN_POLICY.pools[sourceId];
  if (!source) continue;
  LOCAL_TAVERN_POLICY.pools[targetId] = {
    ...source,
    pity: { ...source.pity, counter_item: `meta_tavern_pity_${targetId}` },
    config_evidence: { ...(source.config_evidence || {}), compatibility_tavern_id: targetId },
  };
}

function inventoryKey(asset) {
  return asset.type === "currency" ? String(asset.id) : `${asset.type}_${asset.id}`;
}

function taskProgressMutation(kind, identity, targetProgress, source) {
  const suffix = Array.isArray(identity) ? identity.join("_") : identity;
  return {
    item_id: `meta_${kind}_${suffix}`,
    quantity: Number(targetProgress),
    extra: {
      source,
      task_kind: kind,
      ...(Array.isArray(identity)
        ? { line: Number(identity[0]), task_id: Number(identity[1]) }
        : { task_id: Number(identity) }),
      target_progress: Number(targetProgress),
      evidence_level: "captured_official_response",
    },
  };
}

function observedHeroUpgrade(state, request) {
  const rule = OFFICIAL_RULES.hero_upgrade.observed_case;
  const heroId = Number(request.hero_id ?? request.heroId);
  const upLevel = Number(request.up_level ?? request.upLevel);
  if (!Number.isSafeInteger(heroId) || heroId <= 0 || !Number.isSafeInteger(upLevel) || upLevel <= 0) {
    return {
      ok: false,
      status: 422,
      error: "invalid_hero_upgrade",
    };
  }

  const hero = (state.characters || []).find(
    (item) =>
      String(item.character_id) === String(heroId) ||
      Number(item.extra_json?.hero_id) === heroId
  );
  if (!hero) {
    return {
      ok: false,
      status: 404,
      error: "hero_not_found",
    };
  }

  const fromLevel = Number(hero.level);
  const toLevel = fromLevel + upLevel;
  const maxLevel = Number(hero.extra_json?.max_level || 240);
  if (toLevel > maxLevel || toLevel > 240) {
    return { ok: false, status: 409, error: "hero_level_cap", max_level: Math.min(maxLevel, 240) };
  }

  const levelRows = [];
  for (let level = fromLevel; level < toLevel; level += 1) {
    const row = HERO_LEVEL_COSTS.levels[String(level)];
    if (!row) {
      return { ok: false, status: 422, error: "unsupported_level_cost", level };
    }
    levelRows.push({ level, ...row });
  }

  const costs = [
    { type: "item", id: 1, amount: levelRows.reduce((sum, row) => sum + Number(row.essence || 0), 0) },
    { type: "currency", id: "gold", amount: levelRows.reduce((sum, row) => sum + Number(row.gold || 0), 0) },
    { type: "currency", id: "hero_exp", amount: levelRows.reduce((sum, row) => sum + Number(row.hero_exp || 0), 0) },
  ].filter((cost) => cost.amount > 0);

  const mutations = [];
  for (const cost of costs) {
    const itemId = inventoryKey(cost);
    const item = (state.inventory || []).find((entry) => entry.item_id === itemId);
    const before = Number(item?.quantity || 0);
    if (before < cost.amount) {
      return {
        ok: false,
        status: 409,
        error: "insufficient_asset",
        asset: cost,
        available: before,
      };
    }
    mutations.push({
      item_id: itemId,
      quantity: before - cost.amount,
      extra: {
        ...(item?.extra_json || {}),
        source: "hero_upgrade",
        official_cost: cost,
      },
    });
  }
  for (const todo of rule.todo_updates?.daily || []) {
    mutations.push(
      taskProgressMutation(
        "daily_todo",
        todo.id,
        Math.max(Number(findInventory(state, `meta_daily_todo_${todo.id}`)?.quantity || 0), Number(todo.target_progress)),
        "hero_upgrade"
      )
    );
  }
  for (const todo of rule.todo_updates?.line || []) {
    mutations.push(
      taskProgressMutation(
        "line_task",
        [todo.line, todo.id],
        Math.max(Number(findInventory(state, `meta_line_task_${todo.line}_${todo.id}`)?.quantity || 0), Number(todo.target_progress)),
        "hero_upgrade"
      )
    );
  }

  return {
    ok: true,
    rule: {
      hero_id: heroId,
      from_level: fromLevel,
      to_level: toLevel,
      cost: costs,
      evidence_level:
        heroId === rule.hero_id && fromLevel === rule.from_level && toLevel === rule.to_level
          ? "captured_official_response"
          : HERO_LEVEL_COSTS.evidence.all_levels,
    },
    inventory: mutations,
    character: {
      character_id: String(hero.character_id),
      level: toLevel,
      star: Number(hero.star || 1),
      extra: {
        ...(hero.extra_json || {}),
        hero_id: heroId,
        gs:
          heroId === rule.hero_id && fromLevel === rule.from_level && toLevel === rule.to_level
            ? rule.gs
            : Number(hero.extra_json?.gs || 0),
        source: "official_hero_upgrade",
        growth_evidence:
          heroId === rule.hero_id && fromLevel === rule.from_level && toLevel === rule.to_level
            ? "captured_official_response"
            : HERO_LEVEL_COSTS.evidence.all_levels,
      },
    },
  };
}

function weightedHero(heroes, rng) {
  const total = heroes.reduce((sum, hero) => sum + Math.max(0, Number(hero.weight || 0)), 0);
  if (total <= 0) {
    throw new Error("Tavern pool has no positive hero weights.");
  }
  let cursor = Math.min(0.999999999999, Math.max(0, Number(rng()))) * total;
  for (const hero of heroes) {
    cursor -= Math.max(0, Number(hero.weight || 0));
    if (cursor < 0) {
      return hero;
    }
  }
  return heroes[heroes.length - 1];
}

function weightedEntry(entries, rng) {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, Number(entry.weight || 0)), 0);
  if (total <= 0) throw new Error("Weighted table has no positive weights.");
  let cursor = Math.min(0.999999999999, Math.max(0, Number(rng()))) * total;
  for (const entry of entries) {
    cursor -= Math.max(0, Number(entry.weight || 0));
    if (cursor < 0) return entry;
  }
  return entries[entries.length - 1];
}

function findInventory(state, itemId) {
  return (state.inventory || []).find((item) => String(item.item_id) === String(itemId));
}

function tavernDraw(state, request = {}, policy = LOCAL_TAVERN_POLICY, rng = Math.random) {
  const poolId = Number(request.tavern_id ?? request.tavernId ?? 1);
  const count = Number(request.count ?? 1);
  const pool = policy.pools?.[poolId];
  if (!pool) {
    return { ok: false, status: 422, error: "unsupported_tavern_pool", pool_id: poolId };
  }
  if (!pool.allowed_counts?.includes(count)) {
    return { ok: false, status: 422, error: "unsupported_draw_count", count };
  }

  const costAmount = Number(pool.cost.amount) * count;
  const cost = { ...pool.cost, amount: costAmount };
  const costKey = inventoryKey(cost);
  const costItem = findInventory(state, costKey);
  const costBefore = Number(costItem?.quantity || 0);
  if (costBefore < costAmount) {
    return {
      ok: false,
      status: 409,
      error: "insufficient_asset",
      asset: cost,
      available: costBefore,
    };
  }

  const pity = pool.pity || {};
  const pityKey = pity.counter_item || `meta_tavern_pity_${poolId}`;
  let pityCounter = Number(findInventory(state, pityKey)?.quantity || 0);
  const threshold = Number.isInteger(pity.threshold) && pity.threshold > 0 ? pity.threshold : null;
  const guaranteed = new Set((pity.guaranteed_tids || []).map(Number));
  const configuredTarget = Number(
    request.target_tid ?? request.targetTid ??
    findInventory(state, `meta_tavern_wish_tid_${poolId}`)?.quantity ??
    ([7].includes(poolId) ? findInventory(state, "meta_tavern_stargazer_id")?.quantity : 0) ??
    ([12, 23, 24, 25, 26, 27, 28, 29, 30].includes(poolId) ? findInventory(state, "meta_tavern_hyper_tid")?.quantity : 0) ?? 0
  );
  const selectedTarget = pool.heroes.find((entry) => Number(entry.tid) === configuredTarget) || null;
  if (selectedTarget) guaranteed.add(Number(selectedTarget.tid));
  const existingTids = new Set(
    (state.characters || [])
      .map((hero) => Number(hero.extra_json?.tid))
      .filter(Number.isFinite)
  );
  const existingHeroIds = (state.characters || [])
    .map((hero) => Number(hero.extra_json?.hero_id ?? hero.character_id))
    .filter(Number.isFinite);
  const configuredHeroIds = pool.heroes.map((hero) => Number(hero.id)).filter(Number.isFinite);
  let nextHeroId = Math.max(0, ...existingHeroIds, ...configuredHeroIds.map((id) => id - 1)) + 1;
  const inventoryTotals = new Map([[costKey, costBefore - costAmount]]);
  const inventoryMetadata = new Map([
    [costKey, { ...(costItem?.extra_json || {}), source: "tavern_draw", official_cost: cost }],
  ]);
  const characters = [];
  const rewards = [];
  const rewardAssets = [];

  for (let index = 0; index < count; index += 1) {
    pityCounter += 1;
    let hero;
    const pityTriggered = threshold !== null && pityCounter >= threshold && guaranteed.size > 0;
    if (pityTriggered) {
      if (selectedTarget) hero = selectedTarget;
      else {
        const candidates = pool.heroes.filter((entry) => guaranteed.has(Number(entry.tid)));
        hero = weightedHero(candidates.length ? candidates : pool.heroes, rng);
      }
    } else if (pool.asset_rewards && Number(pool.hero_rate) < 1 && Number(rng()) >= Number(pool.hero_rate)) {
      const asset = weightedEntry(pool.asset_rewards, rng);
      const assetKey = inventoryKey(asset);
      const before = inventoryTotals.has(assetKey)
        ? inventoryTotals.get(assetKey)
        : Number(findInventory(state, assetKey)?.quantity || 0);
      inventoryTotals.set(assetKey, before + Number(asset.amount || 1));
      inventoryMetadata.set(assetKey, {
        source: "tavern_draw_reward",
        pool_id: poolId,
        evidence_level: pool.probability_evidence,
      });
      rewardAssets.push({ type: asset.type, id: asset.id, amount: Number(asset.amount || 1) });
      rewards.push({ type: asset.type, id: asset.id, amount: Number(asset.amount || 1), pity_triggered: false });
      continue;
    } else {
      hero = weightedHero(pool.heroes, rng);
    }
    // Hero entity IDs are unique even when multiple summons resolve to the
    // same template (tid). Reusing the captured single-draw entity ID makes
    // the client discard a multi-draw reply as duplicate state.
    hero = { ...hero, id: nextHeroId++ };

    const isGuaranteedTier = guaranteed.has(Number(hero.tid));
    if (isGuaranteedTier) {
      pityCounter = 0;
    }
    const duplicate = existingTids.has(Number(hero.tid));
    if (duplicate && pool.duplicate?.mode === "copy_item") {
      const duplicateKey = `${pool.duplicate.item_prefix || "hero_copy_"}${hero.tid}`;
      const before = inventoryTotals.has(duplicateKey)
        ? inventoryTotals.get(duplicateKey)
        : Number(findInventory(state, duplicateKey)?.quantity || 0);
      inventoryTotals.set(duplicateKey, before + Number(pool.duplicate.amount || 1));
      inventoryMetadata.set(duplicateKey, {
        source: "tavern_duplicate",
        tid: Number(hero.tid),
        evidence_level: "configurable_local_extension",
      });
    } else {
      existingTids.add(Number(hero.tid));
      characters.push({
        character_id: `tavern_hero_${hero.id}`,
        level: Number(hero.level || 1),
        star: Number(hero.quality || 1),
        extra: {
          source: "tavern_draw",
          hero_id: Number(hero.id),
          tid: Number(hero.tid),
          quality: Number(hero.quality || 1),
          rank: Number(hero.rank || 1),
          gs: Number(hero.gs || 0),
        },
      });
    }
    rewards.push({ ...hero, duplicate, pity_triggered: pityTriggered });
  }

  inventoryTotals.set(pityKey, pityCounter);
  inventoryMetadata.set(pityKey, {
    source: "tavern_pity_counter",
    pool_id: poolId,
    threshold,
    evidence_level: threshold === null ? "disabled_pending_official_evidence" : "configured_local_extension",
  });
  const drawCountKey = `meta_tavern_draw_count_${poolId}`;
  const drawCount = Number(findInventory(state, drawCountKey)?.quantity || 0) + count;
  inventoryTotals.set(drawCountKey, drawCount);
  inventoryMetadata.set(drawCountKey, {
    source: "tavern_draw_count", pool_id: poolId,
    last_rewards: rewards.map((row) => row.tid
      ? { tid: Number(row.tid), quality: Number(row.quality), duplicate: Boolean(row.duplicate) }
      : { type: row.type, id: row.id, amount: Number(row.amount || 1) }),
    evidence_level: "official_reply_tavern_open_panel_schema",
  });
  const amazingKey = "meta_tavern_amazing_point";
  const amazingPoint = Number(findInventory(state, amazingKey)?.quantity || 0) + count;
  inventoryTotals.set(amazingKey, amazingPoint);
  inventoryMetadata.set(amazingKey, { source: "tavern_draw", evidence_level: "official_reply_tavern_draw_schema" });

  if (count === 1) {
    for (const todo of OFFICIAL_RULES.tavern.single_draw.todo_updates?.daily || []) {
      const mutation = taskProgressMutation(
        "daily_todo",
        todo.id,
        todo.target_progress,
        "tavern_draw"
      );
      inventoryTotals.set(mutation.item_id, mutation.quantity);
      inventoryMetadata.set(mutation.item_id, mutation.extra);
    }
    for (const todo of OFFICIAL_RULES.tavern.single_draw.todo_updates?.weekly || []) {
      const mutation = taskProgressMutation(
        "weekly_todo",
        todo.id,
        todo.target_progress,
        "tavern_draw"
      );
      inventoryTotals.set(mutation.item_id, mutation.quantity);
      inventoryMetadata.set(mutation.item_id, mutation.extra);
    }
  }

  return {
    ok: true,
    pool_id: poolId,
    count,
    cost,
    rewards,
    reward_assets: rewardAssets,
    selected_target_tid: selectedTarget ? Number(selectedTarget.tid) : 0,
    pity_counter: pityCounter,
    draw_times: drawCount,
    amazing_point: amazingPoint,
    characters,
    inventory: Array.from(inventoryTotals, ([item_id, quantity]) => ({
      item_id,
      quantity,
      extra: inventoryMetadata.get(item_id) || {},
    })),
    evidence_level: count === 1 ? "captured_single_draw" : "official_schema_config_backed_local_probability",
  };
}

function taskBatchClaim(state, request = {}) {
  const ids = (request.ids ?? request.task_ids ?? request.taskIds ?? []).map(Number);
  if (
    ids.length === 0 ||
    ids.length > 100 ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  ) {
    return {
      ok: false,
      status: 422,
      error: "invalid_task_batch",
    };
  }
  const duplicate = ids.find((id) => Number(findInventory(state, `meta_task_claim_${id}`)?.quantity || 0) > 0);
  if (duplicate !== undefined) {
    return { ok: false, status: 409, error: "task_already_claimed", task_id: duplicate };
  }
  return {
    ok: true,
    ids,
    inventory: ids.map((id) => ({
      item_id: `meta_task_claim_${id}`,
      quantity: 1,
      extra: {
        source: "task_batch_claim",
        task_id: id,
        evidence_level: "captured_protocol_shape",
      },
    })),
  };
}

module.exports = {
  LOCAL_TAVERN_POLICY,
  inventoryKey,
  observedHeroUpgrade,
  taskBatchClaim,
  tavernDraw,
  weightedHero,
};
