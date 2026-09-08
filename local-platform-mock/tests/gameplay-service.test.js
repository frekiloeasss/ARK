const assert = require("node:assert/strict");
const test = require("node:test");

const {
  IDLE_CAPTURE,
  calculateConfiguredIdleAssets,
  calculateIdleAssets,
  campaignBattleResult,
  claimIdleRewards,
} = require("../lib/gameplay-service");

test("reproduces the captured stage-13 idle snapshot", () => {
  assert.deepEqual(calculateIdleAssets(IDLE_CAPTURE.elapsed_seconds), IDLE_CAPTURE.assets);
});

test("quick idle grants exactly 120 minutes without player experience", () => {
  const result = claimIdleRewards(
    { inventory: [{ item_id: "meta_idle_last_claim_ts", quantity: 1000 }] },
    { quick: true, now_ts: 200000 }
  );
  assert.equal(result.ok, true);
  assert.equal(result.elapsed_seconds, 7200);
  assert.equal(result.assets.some((asset) => asset.id === "player_exp"), false);
  assert.equal(result.inventory.find((item) => item.item_id === "meta_quick_idle_count").quantity, 1);
});

test("quick idle uses decrypted stage-13 reward intervals", () => {
  assert.deepEqual(calculateConfiguredIdleAssets(13, 7200, true), [
    { type: "currency", id: "hero_exp", amount: 3240 },
    { type: "currency", id: "gold", amount: 11520 },
    { type: "item", id: 1, amount: 9 },
  ]);
});

test("quick idle enforces the captured daily free limit", () => {
  const now = 200000;
  const result = claimIdleRewards(
    {
      inventory: [
        { item_id: "meta_quick_idle_day", quantity: Math.floor(now / 86400) },
        { item_id: "meta_quick_idle_count", quantity: 1 },
      ],
    },
    { quick: true, now_ts: now }
  );
  assert.equal(result.error, "quick_idle_daily_limit");
});

test("campaign victory advances once while defeat preserves progress", () => {
  const state = { inventory: [{ item_id: "meta_campaign_cur_stage", quantity: 13 }] };
  const defeat = campaignBattleResult(state, { stage_id: 13, result: "defeat" });
  assert.equal(defeat.cur_stage, 13);
  assert.equal(defeat.evidence_level, "captured_official_response");
  const victory = campaignBattleResult(state, { stage_id: 13, result: "victory" });
  assert.equal(victory.cur_stage, 14);
  assert.equal(victory.stage.cleared, true);
  assert(victory.assets.some((asset) => asset.id === "gold" && asset.amount === 32));
  assert(victory.inventory.some((item) => item.item_id === "meta_campaign_cur_stage" && item.quantity === 14));
});

test("completed Classic max stage can be replayed without rewards or progression", () => {
  const state = {
    inventory: [
      { item_id: "meta_campaign_cur_stage", quantity: 3233 },
      { item_id: "gold", quantity: 1234 },
    ],
  };
  const replay = campaignBattleResult(state, {
    stage_id: 3232,
    result: "victory",
    completed_replay_stage: 3232,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.completed_stage_replay, true);
  assert.equal(replay.cur_stage, 3233);
  assert.deepEqual(replay.assets, []);
  assert.deepEqual(replay.inventory, []);

  const defeat = campaignBattleResult(state, {
    stage_id: 3232,
    result: "defeat",
    completed_replay_stage: 3232,
  });
  assert.equal(defeat.ok, true);
  assert.equal(defeat.completed_stage_replay, true);
  assert.equal(defeat.cur_stage, 3233);
  assert.equal(defeat.stage.cleared, false);
  assert.deepEqual(defeat.assets, []);

  const older = campaignBattleResult(state, {
    stage_id: 3231,
    result: "victory",
    completed_replay_stage: 3232,
  });
  assert.equal(older.ok, false);
  assert.equal(older.error, "campaign_stage_mismatch");
});
