const test = require("node:test");
const assert = require("node:assert/strict");
const systems = require("../lib/game-systems-service");

function state(items = {}) {
  return { inventory: Object.entries(items).map(([item_id, quantity]) => ({ item_id, quantity })) };
}

function applyTransition(base, transition) {
  const byId = new Map((base.inventory || []).map((row) => [String(row.item_id), row]));
  for (const row of transition.inventory || []) byId.set(String(row.item_id), { item_id: row.item_id, quantity: row.quantity, extra_json: row.extra || row.extra_json || {} });
  return { ...base, inventory: [...byId.values()] };
}

test("task chest uses decrypted official rewards and rejects duplicate receipt", () => {
  const first = systems.claimTaskChest(state(), [1]);
  assert.equal(first.ok, true);
  assert(first.rewards.some((entry) => entry.type === "item" && entry.id === 1 && entry.amount === 20));
  assert.equal(systems.claimTaskChest(state({ meta_task_chest_1: 1 }), [1]).error, "task_chest_already_claimed");
});

test("shop purchase is atomic and marks a slot sold", () => {
  const catalog = systems.shopCatalog(state({ gold: 1000000, meta_campaign_cur_stage: 13 }), 2);
  assert(catalog.goods.length > 0);
  const purchase = systems.buyShopGood(state({ gold: 1000000, diamond: 1000000, meta_campaign_cur_stage: 13 }), 2, catalog.goods[0].index, 1);
  assert.equal(purchase.ok, true);
  assert(purchase.inventory.some((entry) => entry.item_id.startsWith("meta_shop_2_")));
});

test("mail rewards, tower rewards, arena progress and maze adjacency persist", () => {
  const mail = systems.receiveMail(state(), [1]);
  assert.equal(mail.ok, true);
  assert(mail.rewards.some((entry) => entry.id === "diamond"));
  const tower = systems.towerWin(state({ meta_tower_floor: 1 }));
  assert.equal(tower.floor_id, 2);
  assert(tower.rewards.some((entry) => entry.id === "diamond" && entry.amount === 20));
  assert.equal(systems.arenaChallenge(state(), true).point, 1010);
  assert.equal(systems.mazeMove(state({ meta_maze_cell: 1 }), 2).ok, true);
  assert.equal(systems.mazeMove(state({ meta_maze_cell: 1 }), 9).error, "maze_cell_not_adjacent");
});

test("generic hero quality, equipment and lock transitions update hero state", () => {
  const heroes = { characters: [
    { character_id: "1", level: 10, star: 1, extra_json: { hero_id: 1, tid: 1, quality: 1, rank: 2 } },
    { character_id: "2", level: 1, star: 1, extra_json: { hero_id: 2, tid: 3, quality: 1, rank: 1 } },
  ], inventory: [
    { item_id: "equip_27", quantity: 1, extra_json: { asset_type: "equip", asset_id: 27 } },
    { item_id: "equip_30", quantity: 1, extra_json: { asset_type: "equip", asset_id: 30 } },
  ] };
  const quality = systems.heroQualityUp(heroes, 1, [2]);
  assert.equal(quality.character.extra.quality, 2);
  assert.deepEqual(quality.remove_characters, ["2"]);
  assert.equal(systems.heroEquipment(heroes, 1, 1, 27).character.extra.equips["1"].tid, 27);
  const best = systems.gameAction(heroes, { op: "hero_wear_best_equip", hero_id: 1 });
  assert.equal(best.character.extra.equips["1"].tid, 27);
  assert.equal(best.character.extra.equips["2"].tid, 30);
  const removed = systems.gameAction({ ...heroes, characters: [best.character] }, { op: "hero_remove_all_equips", hero_id: 1 });
  assert.deepEqual(removed.character.extra.equips, {});
  assert.equal(systems.heroLock(heroes, 1, true).character.extra.locked, true);
});

test("quality upgrades enforce faction, locks and one-key material uniqueness", () => {
  const heroes = { inventory: [], characters: [
    { character_id: "1", level: 10, star: 1, extra_json: { hero_id: 1, tid: 1, quality: 1 } },
    { character_id: "2", level: 1, star: 1, extra_json: { hero_id: 2, tid: 3, quality: 1 } },
    { character_id: "3", level: 1, star: 1, extra_json: { hero_id: 3, tid: 2, quality: 1 } },
    { character_id: "4", level: 1, star: 1, extra_json: { hero_id: 4, tid: 3, quality: 1, locked: true } },
  ] };
  assert.equal(systems.heroQualityUp(heroes, 1, [3]).error, "quality_cost_hero_faction_mismatch");
  assert.equal(systems.heroQualityUp(heroes, 1, [4]).error, "quality_cost_hero_locked");
  const oneKey = systems.heroQualityOneKey(heroes, [{ hero_id: 1, cost_hero_ids: [2] }]);
  assert.equal(oneKey.ok, true);
  assert.equal(oneKey.characters[0].extra.quality, 2);
  assert.deepEqual(oneKey.remove_characters, ["2"]);
  assert.equal(systems.heroQualityOneKey(heroes, [
    { hero_id: 1, cost_hero_ids: [2] },
    { hero_id: 3, cost_hero_ids: [2] },
  ]).error, "invalid_quality_cost_heroes");
});

test("equipment validates ownership, job and slot before changing a hero", () => {
  const base = { characters: [
    { character_id: "1", level: 10, star: 3, extra_json: { hero_id: 1, tid: 1, quality: 3 } },
    { character_id: "2", level: 10, star: 3, extra_json: { hero_id: 2, tid: 1, quality: 3, equips: { "1": { id: 27, tid: 27 } } } },
  ], inventory: [
    { item_id: "equip_27", quantity: 1, extra_json: { asset_type: "equip", asset_id: 27 } },
    { item_id: "equip_28", quantity: 1, extra_json: { asset_type: "equip", asset_id: 28 } },
    { item_id: "equip_30", quantity: 1, extra_json: { asset_type: "equip", asset_id: 30 } },
  ] };
  assert.equal(systems.heroEquipment(base, 1, 1, 999).error, "equipment_not_owned");
  assert.equal(systems.heroEquipment(base, 1, 2, 27).error, "equipment_slot_mismatch");
  assert.equal(systems.heroEquipment(base, 1, 2, 28).error, "equipment_job_mismatch");
  assert.equal(systems.heroEquipment(base, 1, 1, 27).error, "equipment_already_worn");
  assert.equal(systems.heroEquipment(base, 1, 2, 30).ok, true);
});

test("equipment enhancement consumes configured material and gold atomically", () => {
  const base = { characters: [{
    character_id: "1", level: 10, star: 3,
    extra_json: { hero_id: 1, tid: 1, quality: 3, equips: { "1": { id: 27, tid: 27, enhance_lv: 0, enhance_exp: 0 } } },
  }], inventory: [
    { item_id: "item_15", quantity: 6 },
    { item_id: "gold", quantity: 6000 },
  ] };
  const result = systems.equipmentEnhance(base, 1, 1, [{ type: "item", id: 15, amount: 6 }]);
  assert.equal(result.ok, true);
  assert.equal(result.character.extra.equips["1"].enhance_lv, 1);
  assert.equal(result.inventory.find((row) => row.item_id === "item_15").quantity, 0);
  assert.equal(result.inventory.find((row) => row.item_id === "gold").quantity, 0);
  const failed = systems.equipmentEnhance({ ...base, inventory: [{ item_id: "item_15", quantity: 6 }, { item_id: "gold", quantity: 5999 }] }, 1, 1, [{ type: "item", id: 15, amount: 6 }]);
  assert.equal(failed.error, "insufficient_asset");
  assert.equal(failed.inventory, undefined);
});

test("equipment evolution and refine confirmation persist the actual instance", () => {
  const evolving = { characters: [{
    character_id: "1", level: 240, star: 9,
    extra_json: { hero_id: 1, tid: 4, quality: 9, equips: { "1": { id: 99001, tid: 99, enhance_lv: 5 } } },
  }], inventory: [{ item_id: "item_57", quantity: 1 }, { item_id: "item_123", quantity: 1 }] };
  const evolved = systems.equipmentEvolve(evolving, 1, 1);
  assert.equal(evolved.ok, true);
  assert.equal(evolved.character.extra.equips["1"].tid, 111);
  assert.equal(evolved.inventory[0].quantity, 0);

  const refined = systems.equipmentRefine({ ...evolving, characters: [evolved.character] }, 1, 1);
  assert.equal(refined.ok, true);
  assert.equal(refined.inventory.find((row) => row.item_id === "item_123").quantity, 0);
  const confirmed = systems.equipmentConfirmRefine({ ...evolving, characters: [refined.character] }, 1, 1, true);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.character.extra.equips["1"].refine_tag, refined.pending_refine_tag);
  assert.equal(confirmed.character.extra.equips["1"].pending_refine_tag, undefined);
});

test("tavern targets, wishlist and special pool state survive through inventory", () => {
  let current = state();
  const wish = systems.gameAction(current, { op: "tavern_set_wishlist", slot_id: 1, hero_tid: 1 });
  assert.equal(wish.ok, true);
  current = applyTransition(current, wish);
  const target = systems.gameAction(current, { op: "tavern_set_wish_tid", pool_id: 25, hero_tid: 18 });
  current = applyTransition(current, target);
  const open = systems.gameAction(current, { op: "tavern_open" });
  assert.equal(open.wishlist["1"], 1);
  assert.equal(open.wish_tids["25"], 18);
  assert.equal(systems.gameAction(current, { op: "tavern_set_wishlist", slot_id: 24, hero_tid: 1 }).error, "invalid_tavern_wishlist_slot");
});

test("equipment resonance enforces unlock count and projects a better compatible template", () => {
  const base = { characters: [{
    character_id: "1", level: 50, star: 5,
    extra_json: { hero_id: 1, tid: 1, quality: 5, equips: { "1": { id: 27001, tid: 27 } } },
  }], inventory: [{ item_id: "equip_99", quantity: 60, extra_json: { asset_type: "equip", equip_id: 99001, tid: 99 } }] };
  assert.equal(systems.equipmentSetResonate(base, 1, [1], true).error, "equipment_resonate_not_unlocked");
  const unlocked = systems.equipmentResonateQuality(base, 9);
  assert.equal(unlocked.ok, true);
  let current = applyTransition(base, unlocked);
  const opened = systems.equipmentSetResonate(current, 1, [1], true);
  assert.equal(opened.ok, true);
  assert.equal(opened.character.extra.equips["1"].resonate_tid, 99);
  current = { ...current, characters: [opened.character] };
  const closed = systems.equipmentResonateAll(current, false);
  assert.equal(closed.characters[0].extra.equips["1"].resonate_tid, 0);
});

test("artifact, assist and totem actions return a complete persisted hero", () => {
  const base = { inventory: [], characters: [{ character_id: "101", level: 240, star: 5, extra_json: { hero_id: 101, tid: 22 } }] };
  const artifact = systems.gameAction(base, { op: "hero_wear_artifact", hero_id: 101, artifact_id: 7 });
  assert.equal(artifact.character.extra.artifact_id, 7);
  const assist = systems.gameAction(base, { op: "hero_set_assist", hero_id: 101, assist_hero_id: 102, lineup_type: "normal" });
  assert.equal(assist.character.extra.assist_hero_id.normal, 102);
  const totem = systems.gameAction(base, { op: "hero_totem_up", hero_id: 101, node: 3, up_level: 5 });
  assert.equal(totem.character.extra.totem_node_lvs["3"], 5);
});

test("guild create, search, join and leave form a persistent lifecycle", () => {
  const created = systems.guildCreate(state(), "测试公会");
  assert.equal(created.guild_id, 1);
  assert.equal(systems.guildSearch(state(), { guild_id: 1 }).guilds[0].name, "本地冒险者公会");
  assert.equal(systems.guildJoin(state(), 7).inventory[0].quantity, 7);
  const left = systems.guildLeave(state({ meta_guild_id: 7 }));
  assert.equal(left.ok, true);
  assert.equal(left.inventory[0].quantity, 0);
});

test("altar disband resolves protocol hero ids and removes persisted character ids", () => {
  const heroes = { characters: [
    { character_id: "tavern_hero_1006", level: 1, star: 1, extra_json: { hero_id: 1006 } },
    { character_id: "tavern_hero_1007", level: 1, star: 1, extra_json: { hero_id: 1007 } },
  ], inventory: [] };
  const disband = systems.altarHeroDisband(heroes, [1006, 1007]);
  assert.equal(disband.ok, true);
  assert.deepEqual(disband.remove_characters, ["tavern_hero_1006", "tavern_hero_1007"]);
  assert.deepEqual(disband.rewards, []);
  assert.equal(systems.altarHeroDisband(heroes, [9999]).ok, true);
  assert.deepEqual(systems.altarHeroDisband(heroes, [9999]).remove_characters, []);
});

test("extended arena, maze and guild boss loops persist costs and progress", () => {
  const arena = systems.arenaBuyTicket(state({ diamond: 100 }), 2);
  assert.equal(arena.ok, true);
  assert(arena.inventory.some((row) => row.item_id === "arena_ticket" && row.quantity === 2));
  assert.equal(systems.arenaRecords(state()).records.length, 2);
  const opened = systems.mazeOpen(state(), 1788360000);
  assert.equal(opened.maze.cells.length, 24);
  assert.equal(opened.maze.cells[0].type, "start");
  const bossState = state({ meta_guild_id: 1, meta_guild_boss_attempts: 2 });
  assert.equal(systems.guildBossStart(bossState).ok, true);
  const boss = systems.guildBossEnd(bossState, 50000);
  assert.equal(boss.damage, 50000);
  assert.equal(boss.attempts, 1);
});

test("guild shared document closes membership, economy, chat, tasks and boss loops", () => {
  const now = 1788360000;
  let owner = { ...state({ gold: 1000000 }), player: { player_uid: "owner", id: 101, nickname: "会长", level: 240 } };
  const created = systems.gameAction(owner, { op: "guild_create", guild_id: 7001, name: "闭环公会", player_uid: "owner", now_ts: now });
  assert.equal(created.ok, true);
  owner = applyTransition(owner, created);
  let document = created.guild_document;

  let member = { ...state({ gold: 1000000 }), player: { player_uid: "member", id: 102, nickname: "成员", level: 240 } };
  const joined = systems.gameAction(member, { op: "guild_join", guild_id: 7001, guild_document: document, player_uid: "member", now_ts: now });
  assert.equal(joined.members.length, 2);
  member = applyTransition(member, joined); document = joined.guild_document;

  const promoted = systems.gameAction(owner, { op: "guild_promote", target_uid: "member", guild_document: document, player_uid: "owner", now_ts: now });
  assert.equal(promoted.guild_document.members.member.role, 2); document = promoted.guild_document;
  assert.equal(systems.gameAction(member, { op: "guild_kick", target_uid: "owner", guild_document: document, player_uid: "member", now_ts: now }).error, "guild_permission_denied");

  for (let index = 0; index < 3; index += 1) {
    const donated = systems.gameAction(member, { op: "guild_donate", count: 20, guild_document: document, player_uid: "member", now_ts: now });
    assert.equal(donated.ok, true); member = applyTransition(member, donated); document = donated.guild_document;
  }
  assert.equal(systems.gameAction(member, { op: "guild_donate", count: 1, guild_document: document, player_uid: "member", now_ts: now }).error, "guild_donation_limit");
  const claimed = systems.gameAction(member, { op: "guild_task_claim", id: 3, guild_document: document, player_uid: "member", now_ts: now });
  assert.equal(claimed.ok, true); member = applyTransition(member, claimed); document = claimed.guild_document;
  assert.equal(systems.gameAction(member, { op: "guild_task_claim", id: 3, guild_document: document, player_uid: "member", now_ts: now }).error, "guild_task_already_claimed");

  const bought = systems.gameAction(member, { op: "guild_shop_buy", index: 1, guild_document: document, player_uid: "member", now_ts: now });
  assert.equal(bought.ok, true); member = applyTransition(member, bought); document = bought.guild_document;
  assert.equal(systems.gameAction(member, { op: "guild_shop_buy", index: 1, guild_document: document, player_uid: "member", now_ts: now }).error, "guild_shop_good_sold");
  const message = systems.gameAction(member, { op: "guild_chat", message_id: "msg-1", message: "准备打首领", guild_document: document, player_uid: "member", now_ts: now });
  document = message.guild_document;
  const replay = systems.gameAction(member, { op: "guild_chat", message_id: "msg-1", message: "准备打首领", guild_document: document, player_uid: "member", now_ts: now });
  assert.equal(replay.messages.filter((row) => row.id === "msg-1").length, 1);

  const started = systems.gameAction(member, { op: "guild_boss_start", battle_id: "boss-1", lineup_ids: [1, 2, 3], guild_document: document, player_uid: "member", now_ts: now });
  assert.equal(started.ok, true); document = started.guild_document;
  const resumed = systems.gameAction(member, { op: "guild_boss_open", guild_document: document, player_uid: "member", now_ts: now });
  assert.equal(resumed.active_battle.battle_id, "boss-1");
  assert.equal(resumed.attempts, 2);
  const ended = systems.gameAction(member, { op: "guild_boss_end", battle_id: "boss-1", damage: 1000000, guild_document: document, player_uid: "member", now_ts: now });
  assert.equal(ended.defeated, true); member = applyTransition(member, ended); document = ended.guild_document;
  const duplicate = systems.gameAction(member, { op: "guild_boss_end", battle_id: "boss-1", damage: 1000000, guild_document: document, player_uid: "member", now_ts: now });
  assert.equal(duplicate.idempotent_replay, true);
  const finalReward = systems.gameAction(member, { op: "guild_boss_final_reward", guild_document: document, player_uid: "member", now_ts: now });
  assert.equal(finalReward.ok, true); document = finalReward.guild_document;
  assert.equal(systems.gameAction(member, { op: "guild_boss_final_reward", guild_document: document, player_uid: "member", now_ts: now }).error, "guild_boss_reward_claimed");

  const outsider = { ...state({ meta_guild_id: 7001 }), player: { player_uid: "outsider", id: 103, nickname: "非成员", level: 240 } };
  assert.equal(systems.gameAction(outsider, { op: "guild_boss_start", guild_document: document, player_uid: "outsider", now_ts: now }).error, "guild_membership_not_found");
});

test("maze enforces routes, battle retries, relic selection and persistent stacking", () => {
  const now = 1788360000;
  let current = applyTransition({ ...state({ maze_coin: 5000 }), characters: [{ character_id: "1", level: 240, star: 5, extra_json: { tid: 22, quality: 5 } }] }, systems.mazeOpen(state({ maze_coin: 5000 }), now));
  assert.equal(systems.mazeMove(current, 9, now).error, "maze_cell_not_adjacent");
  let run = systems.readMazeRun(current, now);
  const shop = run.cells.find((cell) => cell.type === "peddler");
  assert(shop.shop.goods.every((good) => good.good.type === "item"), "classic mini shop only supports item rewards");
  run.cell_id = shop.id;
  current = applyTransition(current, { inventory: [{ item_id: "meta_maze_run", quantity: run.cycle_id, extra: { source: "test", run } }] });
  const bought = systems.mazeBuy(current, 1, now);
  assert.equal(bought.ok, true);
  current = applyTransition(current, bought);
  assert.equal(systems.mazeBuy(current, 1, now).error, "maze_shop_good_sold");
  current = applyTransition(current, systems.mazeGiveUp(current, now));
  run = systems.readMazeRun(current, now);
  const battle = run.cells.find((cell) => ["normal", "elite"].includes(cell.type));
  run.cell_id = battle.id;
  current = applyTransition(current, { inventory: [{ item_id: "meta_maze_run", quantity: run.cycle_id, extra: { source: "test", run } }] });
  const first = systems.mazeStart(current, { now_ts: now, battle_id: "maze-test-1", lineup_ids: [1] });
  current = applyTransition(current, first);
  const defeat = systems.mazeEnd(current, { now_ts: now, battle_id: "maze-test-1", authoritative_result: "defeat" });
  assert.equal(defeat.battle_result, 2);
  current = applyTransition(current, defeat);
  const retry = systems.mazeStart(current, { now_ts: now, battle_id: "maze-test-2", lineup_ids: [1] });
  current = applyTransition(current, retry);
  const victory = systems.mazeEnd(current, { now_ts: now, battle_id: "maze-test-2", authoritative_result: "victory" });
  assert.equal(victory.battle_result, 1);
  assert.equal(victory.cell.heirloom_pool.length, 3);
  current = applyTransition(current, victory);
  const nextId = Number(require("../lib/official-config-catalog").loadConfig("MazeCell").table[String(battle.id)].To[0]);
  assert.equal(systems.mazeMove(current, nextId, now).error, "maze_heirloom_not_selected");
  const selected = systems.mazeSelectRelic(current, victory.cell.heirloom_pool[0], now);
  assert.equal(selected.relic_effects.stack_count, 1);
  current = applyTransition(current, selected);
  assert.equal(systems.mazeOpen(current, now).heirlooms.length, 1);
});

test("maze carriage requires a valid hero and persists the selected assistant", () => {
  const now = 1788360000;
  let current = applyTransition(state(), systems.mazeOpen(state(), now));
  const run = systems.readMazeRun(current, now);
  const carriage = run.cells.find((cell) => cell.type === "carriage");
  assert.equal(carriage.assist_heroes.length, 4);
  run.cell_id = carriage.id;
  current = applyTransition(current, { inventory: [{ item_id: "meta_maze_run", quantity: run.cycle_id, extra: { run } }] });
  assert.equal(systems.gameAction(current, { op: "maze_use_relic", params: [999], now_ts: now }).error, "maze_assist_hero_required");
  const hero = carriage.assist_heroes[0];
  const selected = systems.gameAction(current, { op: "maze_use_relic", params: [hero.id], now_ts: now });
  assert.equal(selected.ok, true);
  assert.equal(selected.assist_hero.id, hero.id);
  current = applyTransition(current, selected);
  assert.equal(systems.readMazeRun(current, now).assist_heroes[0].id, hero.id);
});

test("maze floor rewards, transmit and cycle reset are idempotent", () => {
  const now = 1788360000;
  let current = applyTransition(state({ diamond: 1000 }), systems.mazeOpen(state({ diamond: 1000 }), now));
  const run = systems.readMazeRun(current, now);
  run.cell_id = 24;
  const boss = run.cells.find((cell) => cell.id === 24);
  boss.status = 1; boss.special_reward = true; boss.heirloom_pool = [];
  current = applyTransition(current, { inventory: [{ item_id: "meta_maze_run", quantity: run.cycle_id, extra: { source: "test", run } }] });
  const received = systems.mazeReceive(current, now);
  assert.equal(received.ok, true);
  current = applyTransition(current, received);
  assert.equal(systems.mazeReceive(current, now).error, "maze_floor_reward_not_available");
  const transmitted = systems.mazeTransmit(current, 25, now);
  assert.equal(transmitted.floor_id, 2);
  assert.equal(transmitted.maze.cells.length, 24);
  assert.deepEqual(transmitted.maze.path, []);
  assert.deepEqual(transmitted.maze.floor_paths["1"], [24]);
  current = applyTransition(current, transmitted);
  const reset = systems.mazeOpen(current, now + 172801);
  assert.equal(reset.floor_id, 1);
  assert.notEqual(reset.maze.cycle_id, transmitted.maze.cycle_id);
});

test("maze transmit accepts classic target map id but rejects unrelated targets", () => {
  let current = state();
  const now = 1_760_000_000;
  current = applyTransition(current, systems.mazeOpen(current, now));
  const run = systems.readMazeRun(current, now);
  run.map_id = 1;
  run.floor_id = 1;
  run.cell_id = 24;
  run.cells = run.cells.map((cell) => Number(cell.id) === 24
    ? { ...cell, status: 1, special_reward: false, heirloom_pool: [] }
    : cell);
  current = applyTransition(current, { inventory: [{ item_id: "meta_maze_run", quantity: 1, extra: { run } }] });

  assert.equal(systems.mazeTransmit(current, 99, now).error, "maze_invalid_transmit_target");
  const classic = systems.mazeTransmit(current, 2, now);
  assert.equal(classic.ok, true);
  assert.equal(classic.floor_id, 2);
  assert.equal(classic.cell_id, 25);
  assert.deepEqual(classic.maze.path, []);
});

test("maze transmit is idempotent when classic client replays the new map gate", () => {
  const now = 1_760_000_000;
  let current = state();
  current = applyTransition(current, systems.mazeOpen(current, now));
  const run = systems.readMazeRun(current, now);
  run.map_id = 1;
  run.floor_id = 1;
  run.cell_id = 24;
  run.cells = run.cells.map((cell) => Number(cell.id) === 24
    ? { ...cell, status: 1, special_reward: false, heirloom_pool: [] }
    : cell);
  current = applyTransition(current, { inventory: [{ item_id: "meta_maze_run", quantity: run.cycle_id, extra: { run } }] });
  const first = systems.mazeTransmit(current, 2, now);
  current = applyTransition(current, first);

  const replay = systems.mazeTransmit(current, 2, now);
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.floor_id, 2);
  assert.equal(replay.cell_id, 25);
  assert.deepEqual(replay.maze.path, []);
  assert.deepEqual(replay.maze.floor_paths["1"], [24]);
  assert.equal(systems.mazeTransmit(current, 99, now).error, "maze_floor_not_complete");
});

test("maze read repairs cross-floor path ids that crash the classic map", () => {
  const now = 1_760_000_000;
  const base = state();
  const run = systems.createMazeRun(base, now);
  run.map_id = 2;
  run.floor_id = 2;
  run.cell_id = 25;
  run.cells = run.cells.map((cell) => ({ ...cell, id: Number(cell.id) + 24, map_id: 2 }));
  run.path = [1, 2, 5, 24, 25];
  const persisted = applyTransition(base, { inventory: [{ item_id: "meta_maze_run", quantity: run.cycle_id, extra: { run } }] });
  assert.deepEqual(systems.readMazeRun(persisted, now).path, [25]);
});

test("maze completes a real three-floor route with every node transition persisted", () => {
  const now = 1788360000;
  let current = { ...state({ maze_coin: 100000, diamond: 1000 }), characters: [{ character_id: "1", level: 240, star: 5, extra_json: { tid: 22, quality: 5, rank: 10 } }] };
  current = applyTransition(current, systems.mazeOpen(current, now));
  let battles = 0;
  for (let floor = 1; floor <= 3; floor += 1) {
    while (true) {
      let run = systems.readMazeRun(current, now);
      const cell = run.cells.find((row) => row.id === run.cell_id);
      if (cell.type === "boss" && cell.status === 1) break;
      const row = require("../lib/official-config-catalog").loadConfig("MazeCell").table[String(run.cell_id)];
      const nextId = (row.To || []).map(Number).find((id) => run.cells.find((candidate) => candidate.id === id)?.type !== "empty");
      assert(nextId, `no playable route from cell ${run.cell_id}`);
      current = applyTransition(current, systems.mazeMove(current, nextId, now));
      run = systems.readMazeRun(current, now);
      const entered = run.cells.find((candidate) => candidate.id === run.cell_id);
      if (["normal", "elite", "boss", "goblin", "bloody_carriage"].includes(entered.type)) {
        const battleId = `full-${floor}-${entered.id}`;
        current = applyTransition(current, systems.mazeStart(current, { now_ts: now, battle_id: battleId, lineup_ids: [1] }));
        const won = systems.mazeEnd(current, { now_ts: now, battle_id: battleId, authoritative_result: "victory" });
        battles += 1; current = applyTransition(current, won);
        if (won.cell.heirloom_pool.length) current = applyTransition(current, systems.mazeSelectRelic(current, won.cell.heirloom_pool[0], now));
      } else if (entered.type === "peddler") {
        current = applyTransition(current, systems.mazeBuy(current, 1, now));
        current = applyTransition(current, systems.mazeGiveUp(current, now));
      } else if (entered.type === "carriage") {
        current = applyTransition(current, systems.mazeUseRelic(current, [entered.assist_heroes[0].id], now));
      } else if (entered.type === "empty") {
        current = applyTransition(current, systems.mazeQuery(current, entered.id, now));
      } else {
        current = applyTransition(current, systems.mazeUseRelic(current, [], now));
      }
    }
    current = applyTransition(current, systems.mazeReceive(current, now));
    if (floor < 3) {
      const nextStart = floor === 1 ? 25 : 49;
      current = applyTransition(current, systems.mazeTransmit(current, nextStart, now));
    }
  }
  const finished = systems.mazeOpen(current, now);
  assert.equal(finished.maze.completed, true);
  assert.equal(finished.passed_times, 1);
  assert(battles >= 3);
  assert(finished.relic_effects.stack_count >= 3);
});
