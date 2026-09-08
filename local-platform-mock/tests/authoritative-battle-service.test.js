const test = require("node:test");
const assert = require("node:assert/strict");
const battle = require("../lib/authoritative-battle-service");

const state = { characters: [
  { character_id: "1", level: 60, star: 6, extra_json: { hero_id: 1, tid: 22, quality: 6 } },
  { character_id: "2", level: 60, star: 6, extra_json: { hero_id: 2, tid: 23, quality: 6 } },
] };

test("authoritative battle is deterministic and ignores a forged client result", () => {
  const first = battle.startAuthoritativeBattle(state, { battle_id: "fixed", mode: "campaign", stage_id: 13, seed: 7 });
  const second = battle.startAuthoritativeBattle(state, { battle_id: "fixed", mode: "campaign", stage_id: 13, seed: 7 });
  assert.equal(first.ok, true);
  assert.equal(first.server_result, second.server_result);
  assert.deepEqual(first.simulation.events, second.simulation.events);
  const forged = battle.finishAuthoritativeBattle(first, first.server_result === "victory" ? "defeat" : "victory");
  assert.equal(forged.result, first.server_result);
  assert.equal(forged.rejected_client_result, true);
});

test("tower enemies and config-derived hero stats are available", () => {
  assert(battle.enemyTeam("tower", 1).length > 0);
  const stats = battle.statsFor(22, 10, 2);
  assert(stats.hp > 0 && stats.atk > 0 && stats.arm >= 0);
});

test("campaign StageID resolves through its chapter and StageName", () => {
  const config = battle.stageConfig("campaign", 3231);
  assert.equal(config.StageName, "61-59");
  assert.equal(Number(config.LevelList[0]), 12730);
});

test("campaign authority can use the installed Classic enemy level scale", () => {
  const enemies = battle.enemyTeam("campaign", 3231, { enemy_level_cap: 1004 });
  assert.equal(enemies.length, 5);
  assert(enemies.every((hero) => hero.level === 1004));
  const rawEnemies = battle.enemyTeam("campaign", 3231);
  assert(rawEnemies.every((hero) => hero.level === 12730));
});

test("unsupported quality clamps to the highest hero-specific Classic row", () => {
  const quality15 = battle.statsFor(4, 1004, 15, { rank: 13 });
  const quality20 = battle.statsFor(4, 1004, 20, { rank: 13 });
  assert.equal(quality20.hp, quality15.hp);
  assert.equal(quality20.atk, quality15.atk);
});

test("equipment enhancement contributes to authoritative stats", () => {
  const base = battle.statsFor(4, 1004, 15, { rank: 13 });
  const bonus = battle.growthBonuses(4, { equips: { 1: { tid: 157, enhance_lv: 5 } } });
  const equipped = battle.statsFor(4, 1004, 15, { rank: 13, growth: bonus });
  assert(equipped.hp > base.hp || equipped.atk > base.atk);
  assert(equipped.source.growth.some((entry) => entry.startsWith("Equip:")));
});

test("resonance and matching refine tag use the same effective battle equipment", () => {
  const low = battle.growthBonuses(1, { equips: { 1: { tid: 27 } } });
  const resonated = battle.growthBonuses(1, { equips: { 1: { tid: 27, resonate_tid: 99 } } });
  const tagged = battle.growthBonuses(1, { equips: { 1: { tid: 27, resonate_tid: 99, refine_tag: 1 } } });
  assert(resonated.atkAdd > low.atkAdd || resonated.hpAdd > low.hpAdd);
  assert(tagged.atkAdd >= resonated.atkAdd && tagged.hpAdd >= resonated.hpAdd);
  assert(resonated.rows.some((entry) => entry.includes("27=>99")));
});

test("late-game combat preserves a large growth advantage instead of timing out", () => {
  const self = [4, 5, 9, 20, 34].map((tid, index) => ({
    id: `self_${tid}`, slot: index + 1,
    ...battle.statsFor(tid, 18000, 15, { rank: 14 }),
  }));
  const enemy = [43, 47, 83, 113, 51].map((tid, index) => ({
    id: `enemy_${tid}`, slot: index + 1,
    ...battle.statsFor(tid, 12730, 15, { rank: 14, hpScale: 1.4, atkScale: 1.4 }),
  }));
  const result = battle.simulateBattle(self, enemy, 7);
  assert.equal(result.result, "victory");
  assert(result.duration < 90);
});

test("artifact signature and pet growth uses recovered configuration", () => {
  const bonus = battle.growthBonuses(1, { artifact_id: 1, artifact_rank: 1, signature_level: 10 }, { pet_id: 6001, pet_level: 1 });
  assert(bonus.hpPct > 0);
  assert(bonus.hpAdd > 0);
  const base = battle.statsFor(1, 10, 1);
  const grown = battle.statsFor(1, 10, 1, { growth: bonus });
  assert(grown.hp > base.hp);
  assert(grown.source.growth.some((entry) => entry.startsWith("ArtifactRank")));
});

test("maze carriage assistant is accepted by authoritative battle input", () => {
  const assisted = {
    characters: state.characters,
    inventory: [{
      item_id: "meta_maze_run",
      extra_json: { run: { assist_heroes: [{ id: 6000221, tid: 22, level: 240, quality: 8, rank: 10, gs: 120000 }] } },
    }],
  };
  const started = battle.startAuthoritativeBattle(assisted, {
    battle_id: "maze-assist",
    mode: "maze",
    stage_id: 24,
    lineup_ids: [6000221],
  });
  assert.equal(started.ok, true);
  assert.deepEqual(started.lineup_ids, ["6000221"]);
  assert.equal(started.self_team[0].tid, 22);
});
