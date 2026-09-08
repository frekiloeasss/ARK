"use strict";

const assert = require("node:assert/strict");
const { createPool, closePool, upsertJson, getJson } = require("../db");

const BASE = process.env.AFK_SOCIAL_BASE_URL || "http://127.0.0.1:18080";
const accounts = [
  { id: 68, uid: "local-account:55", login: "afk_test01" },
  { id: 69, uid: "local-account:56", login: "afk_test02" },
  { id: 70, uid: "local-account:57", login: "afk_test03" },
];
const marker = `smk-${Date.now().toString(36)}-${process.pid.toString(36)}`;

async function request(path, options = {}, expected = [200, 201]) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json();
  assert.ok(expected.includes(response.status), `${path}: expected ${expected}, got ${response.status} ${JSON.stringify(data)}`);
  return { status: response.status, data };
}

function post(path, body, expected) { return request(path, { method: "POST", body: JSON.stringify(body) }, expected); }
function get(path, expected) { return request(path, {}, expected); }

async function verify(pool) {
  const saved = await getJson(pool, "social_smoke:last");
  assert.ok(saved && saved.marker, "missing persisted social smoke marker");
  const friendA = (await get(`/__afk/social/friends?player_uid=${encodeURIComponent(accounts[0].uid)}`)).data;
  assert.ok(friendA.friends.some((row) => Number(row.friend_player_id) === 69), "A/B friendship did not persist");
  const friendC = (await get(`/__afk/social/friends?player_uid=${encodeURIComponent(accounts[2].uid)}`)).data;
  assert.ok(friendC.blacklist.some((row) => Number(row.friend_player_id) === 68), "C/A blacklist did not persist");
  const privateChat = (await get(`/__afk/social/chat?player_uid=${encodeURIComponent(accounts[1].uid)}&recipient_player_id=68`)).data;
  assert.ok(privateChat.messages.some((row) => row.message === saved.private_message), "private chat did not persist");
  const guildChat = (await get(`/__afk/social/chat?player_uid=${encodeURIComponent(accounts[2].uid)}&channel=guild`)).data;
  assert.ok(guildChat.messages.some((row) => row.message === saved.guild_message), "guild chat did not persist");
  const [loans] = await pool.execute("SELECT status,uses FROM mercenary_loans WHERE id=?", [saved.loan_id]);
  assert.equal(loans[0]?.status, "returned", "mercenary return did not persist");
  assert.equal(Number(loans[0]?.uses), 1, "mercenary use counter did not persist");
  const [uses] = await pool.execute("SELECT result,settled_at FROM mercenary_battle_uses WHERE loan_id=?", [saved.loan_id]);
  assert.equal(uses[0]?.result, "victory", "mercenary settlement did not persist");
  assert.ok(uses[0]?.settled_at, "mercenary settlement timestamp missing");
  return { ok: true, phase: "post_restart", marker: saved.marker, friend: true, blacklist: true, private_chat: true, guild_chat: true, loan_status: loans[0].status, loan_uses: Number(loans[0].uses), settlement: uses[0].result };
}

async function run(pool) {
  const ids = accounts.map((row) => row.id);
  const [players] = await pool.execute("SELECT id,player_uid,nickname FROM players WHERE id IN (68,69,70) ORDER BY id");
  assert.deepEqual(players.map((row) => Number(row.id)), ids, "three test players are missing");

  // The script only resets relations and smoke artifacts owned by these dedicated test accounts.
  await pool.execute("DELETE FROM friendships WHERE player_id IN (68,69,70) AND friend_player_id IN (68,69,70)");
  await pool.execute("DELETE FROM friend_gifts WHERE sender_player_id IN (68,69,70) AND recipient_player_id IN (68,69,70)");
  await pool.execute("DELETE FROM mercenary_battle_uses WHERE borrower_player_id IN (68,69,70)");
  await pool.execute("DELETE FROM mercenary_loans WHERE owner_player_id IN (68,69,70) OR borrower_player_id IN (68,69,70)");
  await pool.execute("DELETE FROM mercenary_offers WHERE owner_player_id IN (68,69,70)");
  await pool.execute("DELETE FROM chat_messages WHERE payload_json->>'$.smoke_marker' LIKE 'social-smoke-%'");
  await pool.execute("INSERT INTO characters (player_id,character_id,level,star,extra_json) VALUES (69,'690001',240,5,JSON_OBJECT('tid',101,'source','social_smoke')) ON DUPLICATE KEY UPDATE level=240,star=5,extra_json=VALUES(extra_json)");
  for (const id of ids) await pool.execute("INSERT INTO inventory_items (player_id,item_id,quantity,extra_json) VALUES (?,'meta_guild_id',1,JSON_OBJECT('source','social_smoke')) ON DUPLICATE KEY UPDATE quantity=1", [id]);

  const search = (await post("/__afk/social/friends", { player_uid: accounts[0].uid, action: "search", name: players[2].nickname })).data;
  assert.ok(search.search_results.some((row) => Number(row.uid) === 70), "friend nickname search failed");

  await post("/__afk/social/friends", { player_uid: accounts[0].uid, action: "request", friend_player_id: 69 });
  await post("/__afk/social/friends", { player_uid: accounts[1].uid, action: "accept", friend_player_id: 68 });
  const accepted = (await get(`/__afk/social/friends?player_uid=${encodeURIComponent(accounts[0].uid)}`)).data;
  assert.ok(accepted.friends.some((row) => Number(row.friend_player_id) === 69), "friend acceptance is not symmetric");

  await post("/__afk/social/friends", { player_uid: accounts[0].uid, action: "request", friend_player_id: 70 });
  await post("/__afk/social/friends", { player_uid: accounts[2].uid, action: "block", friend_player_id: 68 });
  await post("/__afk/social/friends", { player_uid: accounts[0].uid, action: "request", friend_player_id: 70 }, [409]);
  await post("/__afk/social/friends", { player_uid: accounts[2].uid, action: "unblock", friend_player_id: 68 });
  await post("/__afk/social/friends", { player_uid: accounts[0].uid, action: "request", friend_player_id: 70 });
  await post("/__afk/social/friends", { player_uid: accounts[2].uid, action: "reject", friend_player_id: 68 });
  await post("/__afk/social/friends", { player_uid: accounts[0].uid, action: "request", friend_player_id: 70 });
  await post("/__afk/social/friends", { player_uid: accounts[2].uid, action: "accept", friend_player_id: 68 });
  await post("/__afk/social/friends", { player_uid: accounts[0].uid, action: "remove", friend_player_id: 70 });
  await post("/__afk/social/friends", { player_uid: accounts[2].uid, action: "block", friend_player_id: 68 });

  const [coinBefore] = await pool.execute("SELECT quantity FROM inventory_items WHERE player_id=69 AND item_id='friend_coin'");
  const beforeGift = Number(coinBefore[0]?.quantity || 0);
  await post("/__afk/social/friends/gift", { player_uid: accounts[0].uid, action: "send", friend_player_id: 69 });
  await post("/__afk/social/friends/gift", { player_uid: accounts[0].uid, action: "send", friend_player_id: 69 }, [409]);
  const received = (await post("/__afk/social/friends/gift", { player_uid: accounts[1].uid, action: "receive", friend_player_id: 68 })).data;
  assert.equal(received.received, 1);
  await post("/__afk/social/friends/gift", { player_uid: accounts[1].uid, action: "receive", friend_player_id: 68 }, [409]);
  const [coinAfter] = await pool.execute("SELECT quantity FROM inventory_items WHERE player_id=69 AND item_id='friend_coin'");
  assert.equal(Number(coinAfter[0].quantity), beforeGift + 1, "duplicate friendship gift changed balance");

  const worldMessages = [];
  for (const account of accounts) {
    const message = `${marker}-world-${account.id}`; worldMessages.push(message);
    await post("/__afk/social/chat", { player_uid: account.uid, channel: "world", message });
    await pool.execute("UPDATE chat_messages SET payload_json=JSON_SET(COALESCE(payload_json,JSON_OBJECT()),'$.smoke_marker',?) WHERE player_id=? AND message=?", [marker, account.id, message]);
  }
  const guildMessage = `${marker}-guild-70`;
  await post("/__afk/social/chat", { player_uid: accounts[2].uid, channel: "guild", message: guildMessage });
  await pool.execute("UPDATE chat_messages SET payload_json=JSON_SET(COALESCE(payload_json,JSON_OBJECT()),'$.smoke_marker',?) WHERE player_id=70 AND message=?", [marker, guildMessage]);
  const privateMessage = `${marker}-private-68-69`;
  await post("/__afk/social/chat", { player_uid: accounts[0].uid, recipient_player_id: 69, message: privateMessage });
  await pool.execute("UPDATE chat_messages SET payload_json=JSON_SET(COALESCE(payload_json,JSON_OBJECT()),'$.smoke_marker',?) WHERE player_id=68 AND message=?", [marker, privateMessage]);
  const world = (await get(`/__afk/social/chat?player_uid=${encodeURIComponent(accounts[1].uid)}&channel=world`)).data;
  assert.ok(worldMessages.every((message) => world.messages.some((row) => row.message === message)), "world chat did not synchronize across accounts");
  const guild = (await get(`/__afk/social/chat?player_uid=${encodeURIComponent(accounts[0].uid)}&channel=guild`)).data;
  assert.ok(guild.messages.some((row) => row.message === guildMessage), "guild chat did not synchronize across accounts");
  const direct = (await get(`/__afk/social/chat?player_uid=${encodeURIComponent(accounts[1].uid)}&recipient_player_id=68`)).data;
  assert.ok(direct.messages.some((row) => row.message === privateMessage), "private chat did not synchronize");

  await post("/__afk/social/mercenary", { player_uid: accounts[1].uid, action: "offer", hero_id: 690001 });
  const requested = (await post("/__afk/social/mercenary", { player_uid: accounts[0].uid, action: "request", owner_player_id: 69, hero_id: 690001 })).data;
  await post("/__afk/social/mercenary", { player_uid: accounts[1].uid, action: "accept", borrower_player_id: 68, hero_id: 690001 });
  const battle = (await post("/__afk/game/battles/start", { player_uid: accounts[0].uid, mode: "tower", stage_id: 1, lineup_ids: [690001], battle_id: `${marker}-battle` })).data;
  assert.equal(Number(battle.mercenary?.loan_id), Number(requested.loan_id), "borrowed hero was not attached to battle input");
  assert.ok(battle.self_team.some((row) => String(row.id) === "690001"), "borrowed hero is missing from authoritative battle team");
  const battleReplay = (await post("/__afk/game/battles/start", { player_uid: accounts[0].uid, mode: "tower", stage_id: 1, lineup_ids: [690001], battle_id: `${marker}-battle` })).data;
  assert.equal(battleReplay.idempotent_replay, true, "duplicate battle start was not replayed idempotently");
  assert.equal(battleReplay.battle_id, battle.battle_id, "duplicate battle start changed battle id");
  const useKey = `battle:${battle.battle_id}`;
  const use = battle.mercenary.use;
  assert.equal(use.uses, 1);
  const duplicateUse = (await post("/__afk/social/mercenary", { player_uid: accounts[0].uid, action: "use", loan_id: requested.loan_id, request_key: useKey })).data;
  assert.equal(duplicateUse.duplicate, true);
  const finished = (await post("/__afk/game/battles/finish", { player_uid: accounts[0].uid, battle_id: battle.battle_id, result: battle.server_result })).data;
  assert.equal(finished.mercenary?.result, battle.server_result, "borrowed hero battle was not settled automatically");
  const settled = finished.mercenary;
  const duplicateSettle = (await post("/__afk/social/mercenary", { player_uid: accounts[0].uid, action: "settle", request_key: useKey, result: "defeat" })).data;
  assert.equal(duplicateSettle.duplicate, true);
  await post("/__afk/social/mercenary", { player_uid: accounts[0].uid, action: "return", hero_id: 690001 });

  const rankingResults = {};
  for (const board of ["power", "friend", "guild"]) {
    rankingResults[board] = (await get(`/__afk/social/rankings?player_uid=${encodeURIComponent(accounts[0].uid)}&board=${board}`)).data;
    assert.ok(rankingResults[board].entries.length > 0, `${board} ranking is empty`);
    assert.ok(rankingResults[board].entries.every((entry, index) => entry.rank === index + 1), `${board} ranking order is invalid`);
  }

  const saved = { marker, accounts: accounts.map((row) => row.login), loan_id: requested.loan_id, private_message: privateMessage, guild_message: guildMessage, world_messages: worldMessages };
  await upsertJson(pool, "social_smoke:last", saved);
  return {
    ok: true, phase: "pre_restart", marker, accounts: saved.accounts,
    friend_search: true, request_accept_remove_blacklist: true,
    gift_received: received.received, gift_duplicate_blocked: true,
    world_messages: worldMessages.length, guild_messages: 1, private_messages: 1,
    mercenary: { loan_id: requested.loan_id, uses: 1, result: settled.result, authoritative_battle_id: battle.battle_id, returned: true, idempotent: true },
    rankings: Object.fromEntries(Object.entries(rankingResults).map(([key, value]) => [key, { count: value.count, self_rank: value.self_rank }])),
  };
}

(async () => {
  const pool = createPool();
  try {
    const output = process.argv.includes("--verify") ? await verify(pool) : await run(pool);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally { await closePool(pool); }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
