const assert = require("node:assert/strict");
const test = require("node:test");

const {
  LOCAL_TAVERN_POLICY,
  observedHeroUpgrade,
  taskBatchClaim,
  tavernDraw,
} = require("../lib/official-game-service");

function state() {
  return {
    characters: [
      { character_id: "1", level: 10, star: 1, extra_json: { hero_id: 1 } },
    ],
    inventory: [
      { item_id: "item_1", quantity: 20 },
      { item_id: "gold", quantity: 5000 },
      { item_id: "hero_exp", quantity: 1000 },
    ],
  };
}

test("keeps Classic 1.201 SP and Draconis pool IDs, tickets and renderable factions", () => {
  assert.deepEqual(LOCAL_TAVERN_POLICY.pools[23].cost, { type: "item", id: 2044, amount: 1 });
  assert.deepEqual(LOCAL_TAVERN_POLICY.pools[25].cost, { type: "item", id: 6000, amount: 1 });
  assert.deepEqual(LOCAL_TAVERN_POLICY.pools[27].cost, { type: "item", id: 6001, amount: 1 });
  assert(LOCAL_TAVERN_POLICY.pools[23].heroes.some((hero) => hero.tid === 124));
  assert(LOCAL_TAVERN_POLICY.pools[25].heroes.some((hero) => hero.tid === 187));
  assert(LOCAL_TAVERN_POLICY.pools[27].heroes.some((hero) => hero.tid === 185));
  assert.equal(LOCAL_TAVERN_POLICY.pools[23].config_evidence.pool_id, 12);
  assert.equal(LOCAL_TAVERN_POLICY.pools[25].config_evidence.pool_id, 14);
  assert.equal(LOCAL_TAVERN_POLICY.pools[27].config_evidence.pool_id, 15);
  assert.equal(LOCAL_TAVERN_POLICY.pools[29].config_evidence.pool_id, 15);
});

test("applies the captured hero 1 level 10 to 11 transition", () => {
  const result = observedHeroUpgrade(state(), { hero_id: 1, up_level: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.character.level, 11);
  assert.equal(result.character.extra.gs, 1110);
  assert.deepEqual(
    Object.fromEntries(result.inventory.map((item) => [item.item_id, item.quantity])),
    {
      item_1: 10,
      gold: 3884,
      hero_exp: 583,
      meta_daily_todo_4: 30,
      meta_line_task_18_1: 1,
    }
  );
  assert.equal(
    result.inventory.find((item) => item.item_id === "meta_daily_todo_4").extra.evidence_level,
    "captured_official_response"
  );
  assert.equal(
    result.inventory.find((item) => item.item_id === "meta_line_task_18_1").extra.line,
    18
  );
});

test("supports multi-level growth with accumulated costs", () => {
  const input = state();
  input.inventory.find((item) => item.item_id === "gold").quantity = 10000;
  input.inventory.find((item) => item.item_id === "hero_exp").quantity = 10000;
  const result = observedHeroUpgrade(input, { hero_id: 1, up_level: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.character.level, 12);
  assert.deepEqual(result.rule.cost, [
    { type: "item", id: 1, amount: 10 },
    { type: "currency", id: "gold", amount: 2416 },
    { type: "currency", id: "hero_exp", amount: 873 },
  ]);
  assert.equal(result.rule.evidence_level, "decrypted_official_client_UnitLevel.jsone");
});

test("does not mutate state when an asset is insufficient", () => {
  const input = state();
  input.inventory.find((item) => item.item_id === "gold").quantity = 100;
  const result = observedHeroUpgrade(input, { hero_id: 1, up_level: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "insufficient_asset");
  assert.equal(input.characters[0].level, 10);
});

test("applies the captured tavern single draw without spending diamonds", () => {
  const input = { inventory: [{ item_id: "item_13", quantity: 3 }, { item_id: "diamond", quantity: 99 }], characters: [] };
  const result = tavernDraw(input, { tavern_id: 1, count: 1 }, LOCAL_TAVERN_POLICY, () => 0);
  assert.equal(result.ok, true);
  assert.equal(result.evidence_level, "captured_single_draw");
  assert.equal(result.rewards[0].id, 1005);
  assert.equal(result.characters[0].character_id, "tavern_hero_1005");
  assert.equal(result.inventory.find((item) => item.item_id === "item_13").quantity, 2);
  assert.equal(result.inventory.some((item) => item.item_id === "diamond"), false);
  assert.equal(
    result.inventory.find((item) => item.item_id === "meta_daily_todo_6").quantity,
    2
  );
  assert.equal(
    result.inventory.find((item) => item.item_id === "meta_weekly_todo_105").quantity,
    2
  );
});

test("supports a configurable ten-pull and converts repeated tids into copy items", () => {
  const input = { inventory: [{ item_id: "item_13", quantity: 20 }], characters: [] };
  const result = tavernDraw(input, { tavern_id: 1, count: 10 }, LOCAL_TAVERN_POLICY, () => 0);
  assert.equal(result.ok, true);
  assert.equal(result.rewards.length, 10);
  assert.equal(new Set(result.rewards.map((hero) => hero.id)).size, 10);
  assert.equal(result.characters.length, 1);
  assert.equal(result.inventory.find((item) => item.item_id === "item_13").quantity, 10);
  assert.equal(result.inventory.find((item) => item.item_id === "hero_copy_17").quantity, 9);
  assert.equal(result.evidence_level, "official_schema_config_backed_local_probability");
  assert.equal(result.draw_times, 10);
  assert.equal(result.amazing_point, 10);
});

test("forces a configured pity tier at the threshold", () => {
  const policy = {
    pools: {
      1: {
        cost: { type: "item", id: 13, amount: 1 },
        allowed_counts: [1],
        heroes: [
          { id: 1, tid: 1, quality: 1, level: 1, weight: 99 },
          { id: 2, tid: 2, quality: 2, level: 1, weight: 1 },
        ],
        pity: { counter_item: "pity", threshold: 3, guaranteed_tids: [2] },
        duplicate: { mode: "copy_item", item_prefix: "copy_", amount: 1 },
      },
    },
  };
  const input = {
    inventory: [{ item_id: "item_13", quantity: 1 }, { item_id: "pity", quantity: 2 }],
    characters: [],
  };
  const result = tavernDraw(input, { tavern_id: 1 }, policy, () => 0);
  assert.equal(result.rewards[0].tid, 2);
  assert.equal(result.rewards[0].pity_triggered, true);
  assert.equal(result.inventory.find((item) => item.item_id === "pity").quantity, 0);
});

test("special pool pity honors the persisted target and updates its own counters", () => {
  const input = { inventory: [
    { item_id: "item_6000", quantity: 1 },
    { item_id: "meta_tavern_pity_25", quantity: 29 },
    { item_id: "meta_tavern_wish_tid_25", quantity: 187 },
    { item_id: "meta_tavern_draw_count_25", quantity: 7 },
  ], characters: [] };
  const result = tavernDraw(input, { tavern_id: 25, count: 1 }, LOCAL_TAVERN_POLICY, () => 0);
  assert.equal(result.ok, true);
  assert.equal(result.rewards[0].tid, 187);
  assert.equal(result.rewards[0].pity_triggered, true);
  assert.equal(result.selected_target_tid, 187);
  assert.equal(result.pity_counter, 0);
  assert.equal(result.draw_times, 8);
});

test("classic Draconis pool keeps the official four-tier probability weights", () => {
  const heroes = LOCAL_TAVERN_POLICY.pools[25].heroes;
  const totals = heroes.reduce((map, hero) => {
    map[hero.quality] = (map[hero.quality] || 0) + hero.weight;
    return map;
  }, {});
  assert.ok(Math.abs(totals[1] - 52.43) < 1e-9);
  assert.ok(Math.abs(totals[2] - 42.86) < 1e-9);
  assert.ok(Math.abs(totals[4] - 4.61) < 1e-9);
  assert.ok(Math.abs(totals[6] - 0.10) < 1e-9);
});

test("SP hyper-gacha returns resources on an ordinary roll and a hero on a hit", () => {
  const base = { inventory: [{ item_id: "item_2044", quantity: 2 }], characters: [] };
  const missRng = [0.5, 0].values();
  const miss = tavernDraw(base, { tavern_id: 23, count: 1 }, LOCAL_TAVERN_POLICY, () => missRng.next().value ?? 0);
  assert.equal(miss.ok, true);
  assert.equal(miss.rewards[0].type, "item");
  assert.equal(miss.reward_assets.length, 1);
  assert.equal(miss.characters.length, 0);

  const hit = tavernDraw(base, { tavern_id: 23, count: 1 }, LOCAL_TAVERN_POLICY, () => 0);
  assert.equal(hit.ok, true);
  assert.ok(Number.isFinite(hit.rewards[0].tid));
  assert.equal(hit.reward_assets.length, 0);
});

test("rejects a tavern draw atomically when tickets are insufficient", () => {
  const input = { inventory: [{ item_id: "item_13", quantity: 0 }], characters: [] };
  const before = JSON.stringify(input);
  const result = tavernDraw(input, { tavern_id: 1 }, LOCAL_TAVERN_POLICY, () => 0);
  assert.equal(result.ok, false);
  assert.equal(result.error, "insufficient_asset");
  assert.equal(JSON.stringify(input), before);
});

test("persists the captured task batch and rejects a duplicate claim", () => {
  const first = taskBatchClaim({ inventory: [] }, { ids: [1, 2, 3] });
  assert.equal(first.ok, true);
  assert.deepEqual(first.inventory.map((item) => item.item_id), [
    "meta_task_claim_1", "meta_task_claim_2", "meta_task_claim_3",
  ]);
  const duplicate = taskBatchClaim(
    { inventory: [{ item_id: "meta_task_claim_2", quantity: 1 }] },
    { ids: [1, 2, 3] }
  );
  assert.equal(duplicate.error, "task_already_claimed");
});

test("rejects malformed task batches", () => {
  assert.equal(taskBatchClaim({ inventory: [] }, { ids: [] }).error, "invalid_task_batch");
  assert.equal(taskBatchClaim({ inventory: [] }, { ids: [1, 1] }).error, "invalid_task_batch");
  assert.equal(taskBatchClaim({ inventory: [] }, { ids: [0] }).error, "invalid_task_batch");
});
