#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createMazeRun } = require("../lib/game-systems-service");
const { loadConfig } = require("../lib/official-config-catalog");

const baseUrl = process.env.AFK_API_BASE_URL || "http://127.0.0.1:18080";
const playerUid = process.env.AFK_MAZE_TEST_PLAYER || "local-account:57";
const mazeCells = loadConfig("MazeCell").table;

async function json(path, options = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function action(op, body = {}, expectedStatus = 200) {
  return json("/__afk/game/action", { method: "POST", body: JSON.stringify({ player_uid: playerUid, op, ...body }) }, expectedStatus);
}

async function persistRun(run, source = "maze_api_smoke") {
  return json("/__afk/db/inventory", { method: "POST", body: JSON.stringify({
    player_uid: playerUid, item_id: "meta_maze_run", quantity: run.cycle_id, extra_json: { source, run },
  }) });
}

async function main() {
  const originalState = await json(`/__afk/db/business-state?player_uid=${encodeURIComponent(playerUid)}`);
  assert(originalState.player, "test player not found");
  assert((originalState.characters || []).length > 0, "test player has no heroes");
  const originalRow = (originalState.inventory || []).find((row) => row.item_id === "meta_maze_run") || null;
  const now = Math.floor(Date.now() / 1000);
  const priorRun = originalRow?.extra_json?.run || null;
  const fresh = createMazeRun(originalState, now, priorRun);
  fresh.cell_id = 1;
  fresh.cells = fresh.cells.map((cell) => ({ ...cell, status: cell.type === "start" ? 1 : 0 }));
  await persistRun(fresh, "maze_api_smoke_seed");

  let failedRetryCovered = false;
  let battleCount = 0;
  let shopCount = 0;
  let relicCount = 0;
  try {
    let opened = await action("maze_open");
    assert.equal(opened.maze.cells.length, 24);
    assert.equal(opened.cell_id, 1);
    const lineupIds = originalState.characters
      .filter((hero) => !String(hero.character_id).startsWith("assist_"))
      .sort((left, right) => (Number(right.level || 1) * Number(right.extra_json?.quality || right.star || 1)) - (Number(left.level || 1) * Number(left.extra_json?.quality || left.star || 1)))
      .slice(0, 5)
      .map((hero) => Number(hero.extra_json?.hero_id || hero.character_id))
      .filter(Number.isSafeInteger);
    assert(lineupIds.length > 0, "test player has no numeric hero ids");

    for (let floor = 1; floor <= 3; floor += 1) {
      while (true) {
        opened = await action("maze_open");
        const current = opened.maze.cells.find((cell) => Number(cell.id) === Number(opened.cell_id));
        if (current.type === "boss" && current.status === 1) break;
        const nextId = (mazeCells[String(opened.cell_id)].To || []).map(Number)
          .find((id) => opened.maze.cells.find((candidate) => Number(candidate.id) === id)?.type !== "empty");
        assert(nextId, `no playable route from cell ${opened.cell_id}`);
        const moved = await action("maze_move", { cell_id: nextId });
        const cell = moved.cell;
        if (["normal", "elite", "boss", "goblin", "bloody_carriage"].includes(cell.type)) {
          if (!failedRetryCovered) {
            const failedId = `maze-api-fail-${Date.now()}`;
            await action("maze_start", { battle_id: failedId, lineup_ids: lineupIds });
            const failed = await action("maze_end", { battle_id: failedId, authoritative_result: "defeat" });
            assert.equal(failed.battle_result, 2);
            failedRetryCovered = true;
          }
          const battleId = `maze-api-${floor}-${cell.id}-${Date.now()}`;
          const started = await action("maze_start", { battle_id: battleId, lineup_ids: lineupIds });
          const authority = await json("/__afk/game/battles/start", { method: "POST", body: JSON.stringify({
            player_uid: playerUid, mode: "maze", stage_id: started.enemy_stage_id, lineup_ids: lineupIds,
            battle_id: battleId, maze_relic_effects: started.relic_effects,
          }) });
          assert.equal(authority.battle_id, battleId);
          const verified = await json("/__afk/game/battles/finish", { method: "POST", body: JSON.stringify({
            player_uid: playerUid, mode: "maze", battle_id: battleId, result: authority.server_result,
          }) });
          assert.equal(verified.verified, true);
          assert.equal(verified.result, "victory", `graduated account lost cell ${cell.id}`);
          const ended = await action("maze_end", { battle_id: battleId, authoritative_result: verified.result });
          assert.equal(ended.battle_result, 1);
          battleCount += 1;
          if ((ended.cell.heirloom_pool || []).length) {
            const chosen = ended.cell.heirloom_pool[0];
            const selected = await action("maze_select_heirloom", { heirlooms: [chosen] });
            assert(selected.heirlooms.includes(chosen));
            relicCount += 1;
          }
        } else if (cell.type === "peddler") {
          const bought = await action("maze_buy", { index: 1 });
          assert.equal(bought.cell.shop.goods.find((good) => good.index === 1).is_sold, true);
          const duplicate = await action("maze_buy", { index: 1 }, 409);
          assert.equal(duplicate.error, "maze_shop_good_sold");
          await action("maze_give_up");
          shopCount += 1;
        } else if (cell.type === "carriage") {
          assert((cell.assist_heroes || []).length > 0, "carriage has no selectable assistant");
          const selected = await action("maze_use_relic", { params: [cell.assist_heroes[0].id] });
          assert.equal(selected.assist_hero.id, cell.assist_heroes[0].id);
        } else if (cell.type === "empty") {
          await action("maze_query", { cell_id: cell.id });
        } else {
          await action("maze_use_relic", { params: [] });
        }
      }
      await action("maze_receive");
      const duplicateReward = await action("maze_receive", {}, 409);
      assert.equal(duplicateReward.error, "maze_floor_reward_not_available");
      if (floor < 3) await action("maze_transmit", { cell_id: floor === 1 ? 25 : 49 });
    }

    const finished = await action("maze_open");
    assert.equal(finished.maze.completed, true);
    assert(finished.passed_times >= 1);
    assert(failedRetryCovered);
    assert(battleCount >= 3);
    assert(shopCount >= 1);
    assert(relicCount >= 3);
    process.stdout.write(`${JSON.stringify({ ok: true, player_uid: playerUid, floors: 3, battles: battleCount, shops: shopCount, relics: relicCount, passed_times: finished.passed_times })}\n`);
  } finally {
    if (originalRow) {
      await json("/__afk/db/inventory", { method: "POST", body: JSON.stringify({
        player_uid: playerUid, item_id: "meta_maze_run", quantity: originalRow.quantity, extra_json: originalRow.extra_json || {},
      }) });
    } else {
      // The control endpoint is upsert-only. Restore an untouched fresh cycle
      // instead of leaving the smoke run completed on the user's test account.
      await persistRun(createMazeRun(originalState, now, null), "maze_api_smoke_restore");
    }
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
