"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { blueprints } = require("../lib/bot-ecosystem-service");
const { startAuthoritativeBattle } = require("../lib/authoritative-battle-service");

test("bot ecosystem creates stable official-config lineups", () => {
  const first = blueprints(120), second = blueprints(120);
  assert.equal(first.length, 120);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((bot) => bot.bot_id)).size, 120);
  assert(first.every((bot) => bot.lineup.length === 5 && bot.power > 0 && bot.rating > 0));
});

test("arena bot lineup runs through authoritative battle", () => {
  const bot = blueprints(1)[0];
  const state = { characters: [{ character_id: "1", level: 50, star: 4, extra_json: { tid: 1, quality: 4, rank: 3 } }] };
  const battle = startAuthoritativeBattle(state, { mode: "arena", opponent_uid: bot.bot_id, enemy_lineup: bot.lineup });
  assert.equal(battle.ok, true);
  assert(["victory", "defeat"].includes(battle.server_result));
  assert.equal(battle.simulation.engine_version, "afk-local-authoritative-v2");
  assert.equal(battle.simulation.final_units.filter((unit) => unit.side === "enemy").length, 5);
});
