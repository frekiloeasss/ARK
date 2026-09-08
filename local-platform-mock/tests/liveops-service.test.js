const test = require("node:test");
const assert = require("node:assert/strict");
const liveops = require("../lib/liveops-service");

function state(items = {}) { return { inventory: Object.entries(items).map(([item_id, quantity]) => ({ item_id, quantity })) }; }

test("daily weekly and season reset is idempotent for the same timestamp", () => {
  const now = 200 * liveops.DAY;
  const first = liveops.runDueResets(state(), now);
  assert.deepEqual(first.resets, ["daily", "weekly", "season"]);
  const applied = state(Object.fromEntries(first.inventory.map((row) => [row.item_id, row.quantity])));
  assert.deepEqual(liveops.runDueResets(applied, now).resets, []);
});

test("daily login and battle pass enforce claim boundaries", () => {
  const login = liveops.dailyLoginClaim(state(), 10 * liveops.DAY);
  assert.equal(login.ok, true);
  const progressed = liveops.battlePassProgress(state(), 2500);
  assert.equal(progressed.level, 3);
  assert.equal(liveops.battlePassClaim(state({ meta_battle_pass_level: 1 }), 2).error, "battle_pass_level_locked");
});
