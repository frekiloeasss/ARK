const IDLE_CAPTURE = {
  elapsed_seconds: 1782204727 - 1782195431,
  assets: [
    { type: "currency", id: "hero_exp", amount: 23442 },
    { type: "currency", id: "player_exp", amount: 17898 },
    { type: "currency", id: "gold", amount: 85122 },
    { type: "item", id: 1, amount: 72 },
    { type: "equip", id: 10, amount: 3 },
    { type: "equip", id: 8, amount: 2 },
    { type: "equip", id: 4, amount: 4 },
    { type: "equip", id: 1, amount: 6 },
    { type: "equip", id: 6, amount: 5 },
    { type: "equip", id: 3, amount: 9 },
    { type: "equip", id: 5, amount: 6 },
    { type: "equip", id: 11, amount: 5 },
    { type: "equip", id: 2, amount: 4 },
    { type: "equip", id: 12, amount: 3 },
    { type: "equip", id: 7, amount: 2 },
    { type: "equip", id: 9, amount: 5 },
  ],
  evidence_level: "captured_official_stage_idle_snapshot",
};
const STAGE_IDLE_TABLE = require("./official-config-catalog").loadConfig("StageIdle").table;

function normalizeConfiguredAsset(type, id, amount) {
  const typeName = String(type).toLowerCase();
  const idName = String(id).toLowerCase();
  if (typeName === "currency") {
    const currencyId = {
      heroexp: "hero_exp",
      exp: "player_exp",
      gold: "gold",
      diamond: "diamond",
    }[idName] || idName;
    return { type: "currency", id: currencyId, amount: Number(amount) };
  }
  return { type: typeName, id: Number.isNaN(Number(id)) ? idName : Number(id), amount: Number(amount) };
}

function triples(values = []) {
  const assets = [];
  for (let index = 0; index + 2 < values.length; index += 3) {
    assets.push(normalizeConfiguredAsset(values[index], values[index + 1], values[index + 2]));
  }
  return assets;
}

function calculateConfiguredIdleAssets(stageId, elapsedSeconds, quick = false) {
  const row = STAGE_IDLE_TABLE[String(stageId)] || STAGE_IDLE_TABLE["1"];
  const source = triples(quick ? row.QuickIdleRewards : row.NewRewards || row.Rewards);
  const reference = triples(row.NewRewards || row.Rewards);
  const cds = row.NewRewardCDs || row.RewardCDs || [];
  return source.map((asset) => {
    const refIndex = reference.findIndex(
      (entry) => entry.type === asset.type && String(entry.id) === String(asset.id)
    );
    const cd = Math.max(1, Number(cds[refIndex] || row.RewardCD || 20));
    return { ...asset, amount: Math.floor(Number(elapsedSeconds) / cd) * asset.amount };
  }).filter((asset) => asset.amount > 0);
}

function findInventory(state, itemId) {
  return (state.inventory || []).find((item) => String(item.item_id) === String(itemId));
}

function assetKey(asset) {
  if (asset.type === "currency") return String(asset.id);
  return `${asset.type}_${asset.id}`;
}

function inventoryMutation(state, itemId, delta, source, extra = {}) {
  const before = Number(findInventory(state, itemId)?.quantity || 0);
  return {
    item_id: itemId,
    quantity: Math.max(0, before + Number(delta)),
    extra: { source, delta: Number(delta), ...extra },
  };
}

function calculateIdleAssets(elapsedSeconds, options = {}) {
  const seconds = Math.max(0, Math.min(Number(elapsedSeconds) || 0, Number(options.max_seconds || 43200)));
  const excludePlayerExp = Boolean(options.exclude_player_exp);
  return IDLE_CAPTURE.assets
    .filter((asset) => !(excludePlayerExp && asset.id === "player_exp"))
    .map((asset) => ({
      ...asset,
      amount: Math.floor((asset.amount * seconds) / IDLE_CAPTURE.elapsed_seconds),
    }))
    .filter((asset) => asset.amount > 0);
}

function claimIdleRewards(state, request = {}) {
  const now = Number(request.now_ts || Math.floor(Date.now() / 1000));
  const quick = Boolean(request.quick);
  const lastClaim = Number(findInventory(state, "meta_idle_last_claim_ts")?.quantity || now);
  const elapsed = quick ? 7200 : Math.max(0, now - lastClaim);
  if (!quick && elapsed < 1) {
    return { ok: false, status: 409, error: "idle_reward_empty" };
  }

  const day = Math.floor(now / 86400);
  const quickDay = Number(findInventory(state, "meta_quick_idle_day")?.quantity || -1);
  const quickCount = quickDay === day
    ? Number(findInventory(state, "meta_quick_idle_count")?.quantity || 0)
    : 0;
  if (quick && quickCount >= 1) {
    return { ok: false, status: 409, error: "quick_idle_daily_limit", daily_limit: 1 };
  }

  const currentStage = Number(findInventory(state, "meta_campaign_cur_stage")?.quantity || 13);
  const assets = quick
    ? calculateConfiguredIdleAssets(currentStage, elapsed, true)
    : calculateConfiguredIdleAssets(currentStage, elapsed, false);
  const inventory = assets.map((asset) =>
    inventoryMutation(state, assetKey(asset), asset.amount, quick ? "quick_idle" : "idle_claim", {
      asset,
      evidence_level: IDLE_CAPTURE.evidence_level,
    })
  );
  inventory.push({
    item_id: "meta_idle_last_claim_ts",
    quantity: quick ? lastClaim : now,
    extra: { source: "idle_claim_clock" },
  });
  if (quick) {
    inventory.push(
      { item_id: "meta_quick_idle_day", quantity: day, extra: { source: "quick_idle" } },
      { item_id: "meta_quick_idle_count", quantity: quickCount + 1, extra: { source: "quick_idle", daily_limit: 1 } }
    );
  }
  return {
    ok: true,
    quick,
    elapsed_seconds: elapsed,
    assets,
    inventory,
    evidence_level: IDLE_CAPTURE.evidence_level,
  };
}

function campaignBattleResult(state, request = {}) {
  const result = String(request.result || "").toLowerCase();
  if (!new Set(["victory", "defeat"]).has(result)) {
    return { ok: false, status: 422, error: "invalid_battle_result" };
  }
  const current = Number(findInventory(state, "meta_campaign_cur_stage")?.quantity || 13);
  const stageId = Number(request.stage_id ?? request.stageId ?? current);
  const completedReplayStage = Number(request.completed_replay_stage || 0);
  const isCompletedReplay =
    Number.isSafeInteger(completedReplayStage) &&
    completedReplayStage > 0 &&
    stageId === completedReplayStage &&
    current === completedReplayStage + 1;
  if (!Number.isSafeInteger(stageId) || stageId !== current) {
    if (isCompletedReplay) {
      return {
        ok: true,
        result,
        stage_id: stageId,
        cur_stage: current,
        assets: [],
        inventory: [],
        completed_stage_replay: true,
        stage: {
          stage_id: `campaign_${stageId}`,
          cleared: result === "victory",
          best_result: { result, stage_id: stageId, cur_stage: current, rewards: [], replay: true },
        },
        evidence_level: "client_max_stage_reward_safe_replay",
      };
    }
    return { ok: false, status: 409, error: "campaign_stage_mismatch", current_stage: current };
  }
  const nextStage = result === "victory" ? current + 1 : current;
  const assets = result === "victory"
    ? triples((STAGE_IDLE_TABLE[String(current)] || STAGE_IDLE_TABLE["1"]).Rewards || [])
    : [];
  const inventory = assets.map((entry) =>
    inventoryMutation(state, assetKey(entry), entry.amount, "campaign_victory", {
      asset: entry,
      evidence_level: "decrypted_stage_progression_reward_unit",
    })
  );
  inventory.push(
    {
      item_id: "meta_campaign_cur_stage",
      quantity: nextStage,
      extra: { source: "campaign_battle", previous_stage: current, result },
    }
  );
  return {
    ok: true,
    result,
    stage_id: stageId,
    cur_stage: nextStage,
    assets,
    inventory,
    stage: {
      stage_id: `campaign_${stageId}`,
      cleared: result === "victory",
      best_result: { result, stage_id: stageId, cur_stage: nextStage, rewards: assets },
    },
    evidence_level:
      result === "defeat" && stageId === 13
        ? "captured_official_response"
        : "client_reported_result_with_server_progression",
  };
}

module.exports = {
  IDLE_CAPTURE,
  assetKey,
  calculateIdleAssets,
  calculateConfiguredIdleAssets,
  campaignBattleResult,
  claimIdleRewards,
};
