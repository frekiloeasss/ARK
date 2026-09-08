const test = require("node:test");
const assert = require("node:assert/strict");
const { catalogSummary, initialState, moduleInfo, persistSystemRewards, reduceState, validatePlayerNickname } = require("../lib/universal-system-service");

test("player nickname validation accepts Chinese names and rejects unsafe names", () => {
  assert.deepEqual(validatePlayerNickname("  伊索米亚勇者  "), { ok: true, nickname: "伊索米亚勇者" });
  assert.equal(validatePlayerNickname("A").error, "nickname_length");
  assert.equal(validatePlayerNickname("官方客服01").error, "nickname_blocked");
  assert.equal(validatePlayerNickname("bad/name").error, "nickname_invalid_characters");
});

test("advanced mode enforces one active authority session and persists settlement", () => {
  let state = initialState("infinite_pve");
  let result = reduceState(state, "start_battle", { stage_id: 3, lineup_ids: [1, 2, 3] });
  assert.equal(result.ok, true);
  assert.equal(result.state.active_session.stage, 3);
  assert.equal(reduceState(result.state, "start_battle", {}).error, "session_already_active");
  result = reduceState(result.state, "end_battle", { result: "victory", score_delta: 120, stage_id: 3 });
  assert.equal(result.state.progress, 3);
  assert.equal(result.state.score, 120);
  assert.equal(result.state.wins, 1);
  assert.equal(result.state.active_session, null);
});

test("tavern wishlist selection is a free persisted setting", () => {
  const result = reduceState(initialState("tavern"), "req_set_up_hero", { field_1: 1, field_2: 150 });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "set");
  assert.equal(result.mutated, true);
  assert.deepEqual(result.applied_costs, []);
});

test("activity rewards are cycle-idempotent and configuration backed when possible", () => {
  let state = initialState("act_fish");
  const first = reduceState(state, "recv_album_reward", { reward_id: 1 }, new Date("2026-09-01T00:00:00Z"));
  assert.equal(first.ok, true);
  assert(first.rewards.length > 0);
  assert.equal(reduceState(first.state, "recv_album_reward", { reward_id: 1 }, new Date("2026-09-01T01:00:00Z")).error, "reward_already_claimed");
});

test("newcomer daily login enforces calendar unlocks and tracks each received reward", () => {
  const createdAt = "2026-09-01T10:39:34Z";
  let state = initialState("daily_login");
  const panel = reduceState(state, "open_panel", { player_created_at: createdAt, cycle: "liveops:1" }, new Date("2026-09-01T13:00:00Z"));
  assert.equal(panel.ok, true);
  assert.equal(panel.wire_projection.eligible_day, 1);
  assert.deepEqual(panel.wire_projection.recved_rewards, []);
  assert.equal(reduceState(panel.state, "recv_reward", { field_2: 2, player_created_at: createdAt, cycle: "liveops:1" }, new Date("2026-09-01T13:00:00Z")).error, "daily_login_reward_locked");
  const claimed = reduceState(panel.state, "recv_reward", { field_2: 1, player_created_at: createdAt, cycle: "liveops:1" }, new Date("2026-09-01T13:00:00Z"));
  assert.equal(claimed.ok, true);
  assert.deepEqual(claimed.wire_projection.recved_rewards, [1]);
  assert.deepEqual(claimed.rewards, [{ type: "currency", id: "diamond", amount: 1000 }]);
  assert.equal(reduceState(claimed.state, "recv_reward", { field_2: 1, player_created_at: createdAt, cycle: "liveops:1" }, new Date("2026-09-01T13:00:00Z")).error, "reward_already_claimed");
});

test("all applied system rewards are persisted into the shared inventory and hero roster", async () => {
  const calls = [];
  const connection = { execute: async (sql, params) => { calls.push({ sql, params }); return [[], []]; } };
  const count = await persistSystemRewards(connection, 54, { module: "act_fish" }, "recv_album_reward",
    { idempotency_key: "reward-1", reward_id: 1 }, {
      state: { revision: 3 }, event: { id: "event-1" }, policy: "official_config",
      config_evidence: { table: "ActFishAlbum", row_id: "1" },
      applied_rewards: [{ type: "currency", id: "Diamond", amount: 120 }, { type: "item", id: "35", amount: 2 }, { type: "hero", id: "78", amount: 1 }],
    });
  assert.equal(count, 3);
  assert(calls.some((entry) => entry.sql.includes("inventory_items") && entry.params[1] === "diamond" && entry.params[2] === 120));
  assert(calls.some((entry) => entry.sql.includes("inventory_items") && entry.params[1] === "item_35" && entry.params[2] === 2));
  assert(calls.some((entry) => entry.sql.includes("characters") && entry.params[4].includes('"tid":78')));
  assert(calls.some((entry) => entry.sql.startsWith("UPDATE players SET diamond=")));
});

test("1.201 farm activity enforces crop maturity and pays configured album rewards", () => {
  let state = initialState("act_farm");
  let result = reduceState(state, "plant", { field_id: 1, type_id: 1, free: true }, new Date("2026-09-01T00:00:00Z"));
  assert.equal(result.ok, true);
  state = result.state;
  result = reduceState(state, "harvest", { field_id: 1 }, new Date("2026-09-01T00:00:01Z"));
  assert.equal(result.ok, true);
  assert(result.applied_rewards.some((reward) => reward.type === "actfarmitem"));
  result = reduceState(result.state, "recv_album_reward", { item_id: 101 }, new Date("2026-09-01T00:00:02Z"));
  assert.deepEqual(result.applied_rewards, [{ type: "currency", id: "diamond", amount: 50 }]);
});

test("1.201 celebration heat rewards and pet growth have official eligibility rules", () => {
  let celebration = initialState("raid_celebration");
  assert.equal(reduceState(celebration, "heat_reward", { reward_id: 1 }).error, "celebration_heat_not_reached");
  for (let id = 1; id <= 5; id += 1) celebration = reduceState(celebration, "submit_task", { task_id: id, free: true }).state;
  const heat = reduceState(celebration, "heat_reward", { reward_id: 1 });
  assert.equal(heat.ok, true);
  assert(heat.applied_rewards.length > 0);
  let pet = initialState("raid_care_pet");
  const growth = reduceState(pet, "care_pet", { step_id: 1, free: true });
  assert.equal(growth.state.values.growth_step, 1);
  const played = reduceState(growth.state, "play_pet", { toy_id: 202648201 });
  assert.equal(played.state.values.intimacy, 12);
});

test("every recovered module operation is accepted by the domain engine", () => {
  for (const name of ["equip", "bounty", "raid", "slg", "world_boss", "act_pumpkin", "homeland", "pet"]) {
    const info = moduleInfo(name);
    assert(info);
    const op = info.operations[0];
    assert.equal(reduceState(initialState(name), op, {}).ok, true, `${name}.${op}`);
    assert.equal(reduceState(initialState(name), "not_a_real_operation", {}).error, "unsupported_module_operation");
  }
});

test("classic and HD operations are merged for shared protocol modules", () => {
  const stage = moduleInfo("stage");
  assert.ok(stage.operations.includes("query_reward"));
  assert.ok(stage.operations.includes("query_idle_reward"));
  assert.equal(reduceState(initialState("stage"), "query_reward", {}).ok, true);
  assert.equal(reduceState(initialState("stage"), "query_idle_reward", {}).ok, true);
});

test("all recovered protocol operations execute without generic acknowledgements", () => {
  const catalog = catalogSummary();
  let operationCount = 0;
  for (const info of catalog.modules) {
    for (const operation of info.operations) {
      const result = reduceState(initialState(info.module), operation, { free: true, id: 1, reward_id: 1 });
      assert.equal(result.ok, true, `${info.module}.${operation}: ${result.error || "failed"}`);
      assert.equal(result.state.engine, "afk-local-domain-v1");
      operationCount += 1;
    }
  }
  assert(operationCount > 1500, `expected >1500 recovered operations, got ${operationCount}`);
});
