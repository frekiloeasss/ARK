"use strict";

const DAY_SECONDS = 86400;
const WEEK_SECONDS = 7 * DAY_SECONDS;

function json(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function scalar(value, fallback = 0) {
  if (Array.isArray(value)) return scalar(value[0], fallback);
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "value")) return scalar(value.value, fallback);
    if (Object.hasOwn(value, "field_1")) return scalar(value.field_1, fallback);
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function values(value) {
  const source = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(source.map((item) => scalar(item, 0)).filter((item) => item > 0))];
}

function text(value) {
  if (Array.isArray(value)) return text(value[0]);
  return typeof value === "string" ? value.trim() : "";
}

function dayOf(nowTs = Date.now() / 1000) { return Math.floor(Number(nowTs) / DAY_SECONDS); }
function weekOf(nowTs = Date.now() / 1000) { return Math.floor(Number(nowTs) / WEEK_SECONDS); }
function privateChannel(a, b) { return `private:${[Number(a), Number(b)].sort((x, y) => x - y).join(":")}`; }

async function event(executor, recipient, actor, type, payload = {}) {
  await executor.execute(
    "INSERT INTO social_events (recipient_player_id,actor_player_id,event_type,payload_json) VALUES (?,?,?,?)",
    [recipient, actor || null, String(type).slice(0, 64), JSON.stringify(payload)]
  );
}

async function playerExists(executor, id) {
  const [rows] = await executor.execute("SELECT 1 FROM players WHERE id=? LIMIT 1", [id]);
  return Boolean(rows.length);
}

function profilePower(row) {
  const profile = json(row.profile_json);
  const candidates = [profile.full_gs, profile.power, profile.battle_power, profile.combat_power, profile.rating];
  const configured = candidates.map(Number).find((number) => Number.isFinite(number) && number > 0);
  return Math.max(1, Math.floor(configured || Number(row.level || 1) * 1000 + Number(row.hero_power || 0)));
}

async function guildIdFor(executor, playerId) {
  const [rows] = await executor.execute(
    "SELECT quantity FROM inventory_items WHERE player_id=? AND item_id='meta_guild_id' LIMIT 1",
    [playerId]
  );
  return rows.length ? Number(rows[0].quantity || 0) : 0;
}

async function summaries(executor, ids = null) {
  const params = [];
  let filter = "";
  if (Array.isArray(ids)) {
    if (!ids.length) return [];
    filter = `WHERE p.id IN (${ids.map(() => "?").join(",")})`;
    params.push(...ids);
  }
  const [rows] = await executor.execute(
    `SELECT p.id,p.player_uid,p.nickname,p.level,p.profile_json,p.updated_at,COALESCE(SUM(c.level*50+c.star*500),0) hero_power
       FROM players p LEFT JOIN characters c ON c.player_id=p.id ${filter}
      GROUP BY p.id,p.player_uid,p.nickname,p.level,p.profile_json,p.updated_at`, params
  );
  const [guildRows] = rows.length ? await executor.execute(
    `SELECT player_id,quantity guild_id FROM inventory_items WHERE item_id='meta_guild_id' AND player_id IN (${rows.map(() => "?").join(",")})`,
    rows.map((row) => row.id)
  ) : [[]];
  const guildIds = new Map(guildRows.map((row) => [Number(row.player_id), Number(row.guild_id || 0)]));
  const playerRows = rows.map((row) => ({
    uid: Number(row.id), friend_player_id: Number(row.id), player_uid: row.player_uid,
    nickname: row.nickname || `玩家${row.id}`, level: Number(row.level || 1),
    power: profilePower(row), guild_id: guildIds.get(Number(row.id)) || 0,
    last_offline: Math.floor(new Date(row.updated_at).getTime() / 1000), is_robot: false,
  }));
  if (!Array.isArray(ids)) return playerRows;
  const found = new Set(playerRows.map((row) => row.uid));
  const botIds = ids.filter((id) => !found.has(Number(id)));
  if (!botIds.length) return playerRows;
  const [botRows] = await executor.execute(
    `SELECT bot_id,nickname,level,avatar,guild_id,power,updated_at FROM bot_profiles WHERE bot_id IN (${botIds.map(() => "?").join(",")})`,
    botIds
  );
  return playerRows.concat(botRows.map((row) => ({
    uid: Number(row.bot_id), friend_player_id: Number(row.bot_id), player_uid: `bot:${row.bot_id}`,
    nickname: row.nickname || `机器人${row.bot_id}`, level: Number(row.level || 1),
    avatar: row.avatar || "avatar:1", power: Number(row.power || 0),
    guild_id: Number(row.guild_id || 0),
    last_offline: Math.floor(new Date(row.updated_at).getTime() / 1000), is_robot: true,
  })));
}

async function socialSnapshot(pool, playerId, nowTs = Date.now() / 1000) {
  const day = dayOf(nowTs);
  const [friendRows] = await pool.execute(
    "SELECT friend_player_id,status,updated_at FROM friendships WHERE player_id=? ORDER BY updated_at DESC", [playerId]
  );
  const [incomingRows] = await pool.execute(
    "SELECT player_id friend_player_id,status,updated_at FROM friendships WHERE friend_player_id=? AND status='pending' ORDER BY updated_at DESC", [playerId]
  );
  const [giftRows] = await pool.execute(
    "SELECT sender_player_id,recipient_player_id,received_at FROM friend_gifts WHERE period_day=? AND (sender_player_id=? OR recipient_player_id=?)",
    [day, playerId, playerId]
  );
  const ids = [...new Set([...friendRows, ...incomingRows].map((row) => Number(row.friend_player_id)))];
  const info = new Map((await summaries(pool, ids)).map((row) => [row.uid, row]));
  const enriched = (rows) => rows.map((row) => ({ ...info.get(Number(row.friend_player_id)), ...row, friend_player_id: Number(row.friend_player_id) }));
  const sent = new Set(giftRows.filter((row) => Number(row.sender_player_id) === Number(playerId)).map((row) => Number(row.recipient_player_id)));
  const receivable = new Set(giftRows.filter((row) => Number(row.recipient_player_id) === Number(playerId) && !row.received_at).map((row) => Number(row.sender_player_id)));
  const friends = enriched(friendRows.filter((row) => row.status === "accepted")).map((row) => ({ ...row, can_present_gift: !sent.has(Number(row.friend_player_id)), can_recv_gift: receivable.has(Number(row.friend_player_id)) }));
  const [bots] = await pool.execute("SELECT f.bot_id,b.nickname,b.level,b.avatar,b.power,f.status,f.updated_at FROM bot_friendships f JOIN bot_profiles b ON b.bot_id=f.bot_id WHERE f.player_id=? AND f.status='accepted'", [playerId]);
  const [suggested] = await pool.execute("SELECT id FROM players WHERE id<>? ORDER BY updated_at DESC,id DESC LIMIT 20", [playerId]);
  const excluded = new Set([...ids, playerId]);
  const suggestions = (await summaries(pool, suggested.map((row) => Number(row.id)))).filter((row) => !excluded.has(row.uid));
  const self = (await summaries(pool, [Number(playerId)]))[0] || null;
  return {
    ok: true, self, friends, incoming_requests: enriched(incomingRows),
    outgoing_requests: enriched(friendRows.filter((row) => row.status === "pending")),
    blacklist: enriched(friendRows.filter((row) => row.status === "blocked")),
    bot_friends: bots.map((row) => ({ ...row, uid: Number(row.bot_id), is_robot: true, can_recv_gift: false })),
    suggestions, presented_uids: [...sent], received_uids: giftRows.filter((row) => Number(row.recipient_player_id) === Number(playerId) && row.received_at).map((row) => Number(row.sender_player_id)),
    period_day: day,
  };
}

async function requestFriends(pool, playerId, ids) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const applied = [];
    for (const friendId of ids) {
      if (friendId === Number(playerId) || !(await playerExists(connection, friendId))) continue;
      const [blocked] = await connection.execute(
        "SELECT 1 FROM friendships WHERE ((player_id=? AND friend_player_id=?) OR (player_id=? AND friend_player_id=?)) AND status='blocked' LIMIT 1 FOR UPDATE",
        [playerId, friendId, friendId, playerId]
      );
      if (blocked.length) continue;
      await connection.execute(
        "INSERT INTO friendships (player_id,friend_player_id,status) VALUES (?,?,'pending') ON DUPLICATE KEY UPDATE status=IF(status='accepted','accepted','pending')",
        [playerId, friendId]
      );
      await event(connection, friendId, playerId, "friend_request", {});
      applied.push(friendId);
    }
    await connection.commit();
    return { ok: applied.length > 0, applied_uids: applied, status: applied.length ? 200 : 409, error: applied.length ? undefined : "no_friend_request_created" };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function handleApplications(pool, playerId, type, friendId = 0) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const accept = type === 1 || type === 3;
    const all = type === 3 || type === 4;
    const params = all ? [playerId] : [playerId, friendId];
    const [requests] = await connection.execute(
      `SELECT player_id FROM friendships WHERE friend_player_id=? AND status='pending'${all ? "" : " AND player_id=?"} FOR UPDATE`, params
    );
    if (!requests.length) { await connection.rollback(); return { ok: false, status: 409, error: "friend_request_not_found" }; }
    const handled = [];
    for (const row of requests) {
      const actor = Number(row.player_id);
      if (accept) {
        await connection.execute("UPDATE friendships SET status='accepted' WHERE player_id=? AND friend_player_id=?", [actor, playerId]);
        await connection.execute("INSERT INTO friendships (player_id,friend_player_id,status) VALUES (?,?,'accepted') ON DUPLICATE KEY UPDATE status='accepted'", [playerId, actor]);
        await event(connection, actor, playerId, "friend_accepted", {});
      } else {
        await connection.execute("DELETE FROM friendships WHERE player_id=? AND friend_player_id=? AND status='pending'", [actor, playerId]);
        await event(connection, actor, playerId, "friend_rejected", {});
      }
      handled.push(actor);
    }
    await connection.commit();
    return { ok: true, accepted: accept, handled_uids: handled, new_friends: accept ? await summaries(pool, handled) : [] };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function removeFriends(pool, playerId, ids) {
  if (!ids.length) return { ok: false, status: 422, error: "friend_id_required" };
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const id of ids) await connection.execute("DELETE FROM friendships WHERE (player_id=? AND friend_player_id=?) OR (player_id=? AND friend_player_id=?)", [playerId, id, id, playerId]);
    await connection.commit();
    return { ok: true, removed_uids: ids };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function blockPlayer(pool, playerId, friendId) {
  if (!friendId || friendId === Number(playerId) || !(await playerExists(pool, friendId))) return { ok: false, status: 422, error: "invalid_friend" };
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("DELETE FROM friendships WHERE player_id=? AND friend_player_id=?", [friendId, playerId]);
    await connection.execute("INSERT INTO friendships (player_id,friend_player_id,status) VALUES (?,?,'blocked') ON DUPLICATE KEY UPDATE status='blocked'", [playerId, friendId]);
    await connection.commit();
    return { ok: true, blocked_uid: friendId, blocked: (await summaries(pool, [friendId]))[0] || null };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function unblockPlayer(pool, playerId, friendId) {
  const [result] = await pool.execute("DELETE FROM friendships WHERE player_id=? AND friend_player_id=? AND status='blocked'", [playerId, friendId]);
  return result.affectedRows ? { ok: true, unblocked_uid: friendId } : { ok: false, status: 409, error: "blacklist_entry_not_found" };
}

async function searchPlayers(pool, playerId, payload) {
  const id = scalar(payload.field_1 ?? payload.id, 0);
  const name = text(payload.field_2 ?? payload.name).slice(0, 191);
  const params = [playerId];
  let clause = "";
  if (id) { clause = "AND (p.id=? OR p.player_uid=?)"; params.push(id, String(id)); }
  else if (name) { clause = "AND p.nickname LIKE ?"; params.push(`%${name}%`); }
  else return { ok: true, search_results: [] };
  const [rows] = await pool.execute(`SELECT p.id FROM players p WHERE p.id<>? ${clause} ORDER BY p.level DESC,p.id LIMIT 20`, params);
  return { ok: true, search_results: await summaries(pool, rows.map((row) => Number(row.id))) };
}

async function gift(pool, playerId, action, ids, nowTs = Date.now() / 1000) {
  const day = dayOf(nowTs);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const completed = [];
    if (action === "send") {
      const targets = ids.length ? ids : (await connection.execute("SELECT friend_player_id FROM friendships WHERE player_id=? AND status='accepted'", [playerId]))[0].map((row) => Number(row.friend_player_id));
      for (const target of targets) {
        const [accepted] = await connection.execute("SELECT 1 FROM friendships WHERE player_id=? AND friend_player_id=? AND status='accepted' LIMIT 1", [playerId, target]);
        if (!accepted.length) continue;
        const [created] = await connection.execute("INSERT IGNORE INTO friend_gifts (sender_player_id,recipient_player_id,period_day) VALUES (?,?,?)", [playerId, target, day]);
        if (!created.affectedRows) continue;
        await event(connection, target, playerId, "friend_gift", { period_day: day });
        completed.push(target);
      }
      if (!completed.length) { await connection.rollback(); return { ok: false, status: 409, error: "friend_gift_already_sent_or_unavailable" }; }
    } else {
      const params = [playerId, day];
      let filter = "";
      if (ids.length) { filter = ` AND sender_player_id IN (${ids.map(() => "?").join(",")})`; params.push(...ids); }
      const [available] = await connection.execute(`SELECT sender_player_id FROM friend_gifts WHERE recipient_player_id=? AND period_day=? AND received_at IS NULL${filter} FOR UPDATE`, params);
      if (!available.length) { await connection.rollback(); return { ok: false, status: 409, error: "friend_gift_not_available" }; }
      completed.push(...available.map((row) => Number(row.sender_player_id)));
      await connection.execute(`UPDATE friend_gifts SET received_at=NOW() WHERE recipient_player_id=? AND period_day=? AND received_at IS NULL${filter}`, params);
      await connection.execute("INSERT INTO inventory_items (player_id,item_id,quantity,extra_json) VALUES (?,'friend_coin',?,JSON_OBJECT('source','friend_gift')) ON DUPLICATE KEY UPDATE quantity=quantity+VALUES(quantity),updated_at=NOW()", [playerId, completed.length]);
    }
    await connection.commit();
    return { ok: true, action, completed_uids: completed, received: action === "receive" ? completed.length : 0, rewards: action === "receive" ? [{ item_id: "friend_coin", quantity: completed.length }] : [] };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function mercenaryPanel(pool, playerId) {
  const week = weekOf();
  const [offers] = await pool.execute("SELECT o.owner_player_id,o.hero_id,o.created_at,p.nickname,p.level FROM mercenary_offers o JOIN players p ON p.id=o.owner_player_id WHERE o.owner_player_id=? AND o.active=1 ORDER BY o.created_at", [playerId]);
  const [ownRows] = await pool.execute("SELECT character_id,level,star,extra_json FROM characters WHERE player_id=? ORDER BY level DESC,star DESC,character_id LIMIT 300", [playerId]);
  const [borrowed] = await pool.execute("SELECT l.*,p.nickname owner_nickname,c.character_id,c.level hero_level,c.star hero_quality,c.extra_json FROM mercenary_loans l JOIN players p ON p.id=l.owner_player_id LEFT JOIN characters c ON c.player_id=l.owner_player_id AND c.character_id=l.hero_id WHERE l.borrower_player_id=? AND l.period_week=? AND l.status IN ('pending','active','used') ORDER BY l.id", [playerId, week]);
  const [received] = await pool.execute("SELECT l.*,p.nickname borrower_nickname FROM mercenary_loans l JOIN players p ON p.id=l.borrower_player_id WHERE l.owner_player_id=? AND l.period_week=? AND l.status='pending' ORDER BY l.id", [playerId, week]);
  const [lent] = await pool.execute("SELECT l.*,p.nickname borrower_nickname FROM mercenary_loans l JOIN players p ON p.id=l.borrower_player_id WHERE l.owner_player_id=? AND l.period_week=? AND l.status IN ('active','used') ORDER BY l.id", [playerId, week]);
  const seenTids = new Set();
  const ownHeroes = [];
  for (const row of ownRows) {
    const extra = json(row.extra_json);
    const tid = scalar(extra.tid, scalar(row.character_id, 0));
    if (!tid || seenTids.has(tid)) continue;
    seenTids.add(tid);
    ownHeroes.push({
      hero_id: tid, source_character_id: String(row.character_id), tid,
      level: Number(row.level || 1), quality: Number(row.star || 1), extra_json: extra,
      is_lent: offers.some((offer) => String(offer.hero_id) === String(row.character_id)) || lent.some((loan) => String(loan.hero_id) === String(row.character_id)),
    });
  }
  return { ok: true, period_week: week, offers, own_heroes: ownHeroes, applies: borrowed, received_applies: received, lent, got_friend_coins: 0 };
}

async function addOffer(pool, playerId, heroId) {
  if (!heroId) return { ok: false, status: 422, error: "hero_id_required" };
  const [heroes] = await pool.execute("SELECT character_id,level,star,extra_json FROM characters WHERE player_id=? AND character_id=? LIMIT 1", [playerId, String(heroId)]);
  if (!heroes.length) return { ok: false, status: 404, error: "hero_not_owned" };
  await pool.execute("INSERT INTO mercenary_offers (owner_player_id,hero_id,active) VALUES (?,?,1) ON DUPLICATE KEY UPDATE active=1,updated_at=NOW()", [playerId, String(heroId)]);
  return { ok: true, hero_id: String(heroId), hero: heroes[0] };
}

async function removeOffer(pool, playerId, heroId) {
  const [active] = await pool.execute("SELECT 1 FROM mercenary_loans WHERE owner_player_id=? AND hero_id=? AND status IN ('pending','active','used') LIMIT 1", [playerId, String(heroId)]);
  if (active.length) return { ok: false, status: 409, error: "mercenary_hero_in_use" };
  const [result] = await pool.execute("UPDATE mercenary_offers SET active=0 WHERE owner_player_id=? AND hero_id=? AND active=1", [playerId, String(heroId)]);
  return result.affectedRows ? { ok: true, hero_id: String(heroId) } : { ok: false, status: 404, error: "mercenary_offer_not_found" };
}

async function friendHeroes(pool, playerId, ownerId) {
  const [accepted] = await pool.execute("SELECT 1 FROM friendships WHERE player_id=? AND friend_player_id=? AND status='accepted' LIMIT 1", [playerId, ownerId]);
  if (!accepted.length) return { ok: false, status: 403, error: "friend_not_accepted" };
  const [rows] = await pool.execute("SELECT o.owner_player_id uid,o.hero_id,c.level,c.star,c.extra_json FROM mercenary_offers o JOIN characters c ON c.player_id=o.owner_player_id AND c.character_id=o.hero_id WHERE o.owner_player_id=? AND o.active=1", [ownerId]);
  return { ok: true, friend_heroes: rows.map((row) => ({ ...row, hero_id: String(row.hero_id), tid: scalar(json(row.extra_json).tid, scalar(row.hero_id, 1)), quality: Number(row.star || 1), level: Number(row.level || 1) })) };
}

async function friendHeroesForSelection(pool, playerId, selectedHeroId) {
  const [ownRows] = await pool.execute(
    "SELECT character_id,extra_json FROM characters WHERE player_id=? AND (character_id=? OR JSON_UNQUOTE(JSON_EXTRACT(extra_json,'$.tid'))=?) LIMIT 1",
    [playerId, String(selectedHeroId), String(selectedHeroId)]
  );
  const selectedTid = ownRows.length ? scalar(json(ownRows[0].extra_json).tid, scalar(ownRows[0].character_id, selectedHeroId)) : scalar(selectedHeroId, 0);
  if (!selectedTid) return { ok: false, status: 422, error: "hero_id_required" };
  const [rows] = await pool.execute(
    `SELECT o.owner_player_id uid,o.hero_id,c.level,c.star,c.extra_json,
            (SELECT COUNT(*) FROM mercenary_loans l WHERE l.owner_player_id=o.owner_player_id AND l.hero_id=o.hero_id AND l.period_week=? AND l.status IN ('pending','active','used')) apply_cnt,
            (SELECT borrower_player_id FROM mercenary_loans l WHERE l.owner_player_id=o.owner_player_id AND l.hero_id=o.hero_id AND l.period_week=? AND l.status IN ('active','used') ORDER BY l.id DESC LIMIT 1) borrower
       FROM friendships f JOIN mercenary_offers o ON o.owner_player_id=f.friend_player_id AND o.active=1
       JOIN characters c ON c.player_id=o.owner_player_id AND c.character_id=o.hero_id
      WHERE f.player_id=? AND f.status='accepted' AND JSON_UNQUOTE(JSON_EXTRACT(c.extra_json,'$.tid'))=?
      ORDER BY c.level DESC,c.star DESC,o.owner_player_id`,
    [weekOf(), weekOf(), playerId, String(selectedTid)]
  );
  return { ok: true, selected_hero_id: selectedHeroId, selected_tid: selectedTid, friend_heroes: rows.map((row) => ({
    ...row, hero_id: String(row.hero_id), tid: scalar(json(row.extra_json).tid, selectedTid),
    quality: Number(row.star || 1), level: Number(row.level || 1), apply_cnt: Number(row.apply_cnt || 0), borrower: Number(row.borrower || 0),
  })) };
}

async function applyMercenary(pool, borrowerId, ownerId, heroId) {
  const available = await friendHeroes(pool, borrowerId, ownerId);
  if (!available.ok || !available.friend_heroes.some((row) => String(row.hero_id) === String(heroId))) return { ok: false, status: available.status || 404, error: available.error || "mercenary_offer_not_found" };
  const week = weekOf();
  try {
    const [insert] = await pool.execute("INSERT INTO mercenary_loans (owner_player_id,borrower_player_id,hero_id,period_week,status) VALUES (?,?,?,?,'pending')", [ownerId, borrowerId, String(heroId), week]);
    await event(pool, ownerId, borrowerId, "mercenary_request", { loan_id: insert.insertId, hero_id: String(heroId) });
    return { ok: true, loan_id: Number(insert.insertId), owner_player_id: ownerId, hero_id: String(heroId), period_week: week };
  } catch (error) {
    if (error && error.code === "ER_DUP_ENTRY") return { ok: false, status: 409, error: "mercenary_already_requested_this_week" };
    throw error;
  }
}

async function handleMercenary(pool, ownerId, type, borrowerId = 0, heroId = 0) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const accept = type === 1 || type === 3;
    const all = type === 3 || type === 4;
    const params = [ownerId, weekOf()];
    let filter = "";
    if (!all) { filter = " AND borrower_player_id=? AND hero_id=?"; params.push(borrowerId, String(heroId)); }
    const [rows] = await connection.execute(`SELECT * FROM mercenary_loans WHERE owner_player_id=? AND period_week=? AND status='pending'${filter} FOR UPDATE`, params);
    if (!rows.length) { await connection.rollback(); return { ok: false, status: 409, error: "mercenary_request_not_found" }; }
    const handled = [];
    for (const row of rows) {
      const next = accept ? "active" : "rejected";
      await connection.execute("UPDATE mercenary_loans SET status=?,handled_at=NOW() WHERE id=?", [next, row.id]);
      if (accept) await connection.execute("UPDATE mercenary_loans SET status='rejected',handled_at=NOW() WHERE owner_player_id=? AND hero_id=? AND period_week=? AND status='pending' AND id<>?", [ownerId, row.hero_id, row.period_week, row.id]);
      await event(connection, row.borrower_player_id, ownerId, accept ? "mercenary_accepted" : "mercenary_rejected", { loan_id: Number(row.id), hero_id: row.hero_id });
      handled.push({ loan_id: Number(row.id), borrower_player_id: Number(row.borrower_player_id), hero_id: row.hero_id, status: next });
    }
    await connection.commit();
    return { ok: true, handled, lend_heroes: handled.filter((row) => row.status === "active") };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function updateBorrowed(pool, borrowerId, heroId, fromStatuses, nextStatus) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const placeholders = fromStatuses.map(() => "?").join(",");
    const [rows] = await connection.execute(`SELECT * FROM mercenary_loans WHERE borrower_player_id=? AND hero_id=? AND period_week=? AND status IN (${placeholders}) ORDER BY id DESC LIMIT 1 FOR UPDATE`, [borrowerId, String(heroId), weekOf(), ...fromStatuses]);
    if (!rows.length) { await connection.rollback(); return { ok: false, status: 409, error: "mercenary_loan_not_found" }; }
    const row = rows[0];
    await connection.execute(`UPDATE mercenary_loans SET status=?${nextStatus === "returned" ? ",returned_at=NOW()" : ""} WHERE id=?`, [nextStatus, row.id]);
    await event(connection, row.owner_player_id, borrowerId, `mercenary_${nextStatus}`, { loan_id: Number(row.id), hero_id: row.hero_id });
    await connection.commit();
    return { ok: true, loan_id: Number(row.id), hero_id: row.hero_id, status: nextStatus };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function useMercenary(pool, borrowerId, payload) {
  const loanId = scalar(payload.loan_id, 0);
  const requestKey = String(payload.request_key || payload.idempotency_key || "").slice(0, 191);
  if (!loanId || !requestKey) return { ok: false, status: 422, error: "loan_id_and_request_key_required" };
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [loans] = await connection.execute("SELECT * FROM mercenary_loans WHERE id=? AND borrower_player_id=? FOR UPDATE", [loanId, borrowerId]);
    if (!loans.length || !["active", "used"].includes(loans[0].status)) { await connection.rollback(); return { ok: false, status: 409, error: "mercenary_not_active" }; }
    const loan = loans[0];
    const [existing] = await connection.execute("SELECT * FROM mercenary_battle_uses WHERE borrower_player_id=? AND request_key=? LIMIT 1", [borrowerId, requestKey]);
    if (existing.length) { await connection.commit(); return { ok: true, duplicate: true, use: existing[0] }; }
    if (Number(loan.uses) >= Number(loan.max_uses)) { await connection.rollback(); return { ok: false, status: 409, error: "mercenary_use_limit" }; }
    const [created] = await connection.execute("INSERT INTO mercenary_battle_uses (loan_id,borrower_player_id,request_key,battle_id,battle_mode) VALUES (?,?,?,?,?)", [loanId, borrowerId, requestKey, payload.battle_id || null, String(payload.battle_mode || "campaign").slice(0, 64)]);
    await connection.execute("UPDATE mercenary_loans SET uses=uses+1,status='used' WHERE id=?", [loanId]);
    await connection.commit();
    return { ok: true, duplicate: false, use_id: Number(created.insertId), loan_id: loanId, uses: Number(loan.uses) + 1, max_uses: Number(loan.max_uses) };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function settleMercenary(pool, borrowerId, payload) {
  const requestKey = String(payload.request_key || payload.idempotency_key || "").slice(0, 191);
  const battleId = String(payload.battle_id || "").slice(0, 191);
  if (!requestKey && !battleId) return { ok: false, status: 422, error: "request_key_or_battle_id_required" };
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT u.*,l.owner_player_id,l.hero_id FROM mercenary_battle_uses u JOIN mercenary_loans l ON l.id=u.loan_id WHERE u.borrower_player_id=? AND ${requestKey ? "u.request_key=?" : "u.battle_id=?"} ORDER BY u.id DESC LIMIT 1 FOR UPDATE`,
      [borrowerId, requestKey || battleId]
    );
    if (!rows.length) { await connection.rollback(); return { ok: false, status: 404, error: "mercenary_battle_use_not_found" }; }
    const row = rows[0];
    if (row.settled_at) { await connection.commit(); return { ok: true, duplicate: true, result: row.result, loan_id: Number(row.loan_id) }; }
    const result = payload.result === "victory" ? "victory" : "defeat";
    await connection.execute("UPDATE mercenary_battle_uses SET result=?,settled_at=NOW() WHERE id=?", [result, row.id]);
    await connection.execute("INSERT INTO inventory_items (player_id,item_id,quantity,extra_json) VALUES (?,'friend_coin',10,JSON_OBJECT('source','mercenary_battle')) ON DUPLICATE KEY UPDATE quantity=quantity+10,updated_at=NOW()", [row.owner_player_id]);
    await event(connection, row.owner_player_id, borrowerId, "mercenary_battle_settled", { loan_id: Number(row.loan_id), result });
    await connection.commit();
    return { ok: true, duplicate: false, result, loan_id: Number(row.loan_id), owner_reward: [{ item_id: "friend_coin", quantity: 10 }] };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function attachMercenaryHeroes(pool, borrowerId, business, lineupIds = [], battleId = "") {
  const selected = new Set((lineupIds || []).map(String));
  if (!selected.size) return { business, loan: null };
  const [rows] = await pool.execute(
    `SELECT l.id loan_id,l.owner_player_id,l.hero_id,l.status,l.uses,l.max_uses,c.level,c.star,c.extra_json
       FROM mercenary_loans l JOIN characters c ON c.player_id=l.owner_player_id AND c.character_id=l.hero_id
      WHERE l.borrower_player_id=? AND l.period_week=? AND (
        (l.status='active' AND l.uses<l.max_uses) OR
        (l.status='used' AND EXISTS (SELECT 1 FROM mercenary_battle_uses u WHERE u.loan_id=l.id AND u.battle_id=?))
      )`,
    [borrowerId, weekOf(), String(battleId || "")]
  );
  const loan = rows.find((row) => selected.has(String(row.hero_id)));
  if (!loan) return { business, loan: null };
  const characters = [...(business.characters || [])];
  if (!characters.some((row) => String(row.character_id) === String(loan.hero_id))) {
    characters.push({
      character_id: String(loan.hero_id), level: Number(loan.level || 1), star: Number(loan.star || 1),
      extra_json: { ...json(loan.extra_json), mercenary: true, mercenary_loan_id: Number(loan.loan_id), owner_player_id: Number(loan.owner_player_id) },
    });
  }
  return { business: { ...business, characters }, loan: { loan_id: Number(loan.loan_id), hero_id: String(loan.hero_id), owner_player_id: Number(loan.owner_player_id), status: loan.status } };
}

async function rankings(pool, playerId, board = "power", limit = 100) {
  const all = await summaries(pool, null);
  let entries = all;
  if (board === "friend") {
    const [rows] = await pool.execute("SELECT friend_player_id FROM friendships WHERE player_id=? AND status='accepted'", [playerId]);
    const allowed = new Set([Number(playerId), ...rows.map((row) => Number(row.friend_player_id))]);
    entries = all.filter((row) => allowed.has(row.uid));
  }
  if (board === "guild") {
    const grouped = new Map();
    for (const row of all.filter((entry) => entry.guild_id)) {
      const current = grouped.get(row.guild_id) || { guild_id: row.guild_id, guild_name: `公会${row.guild_id}`, point: 0, member_count: 0 };
      current.point += row.power; current.member_count += 1; grouped.set(row.guild_id, current);
    }
    const [botScores] = await pool.execute("SELECT guild_id,COALESCE(SUM(power),0) point,COUNT(*) member_count FROM bot_profiles WHERE guild_id IS NOT NULL GROUP BY guild_id");
    for (const row of botScores) {
      const id = Number(row.guild_id);
      const current = grouped.get(id) || { guild_id: id, guild_name: `公会${id}`, point: 0, member_count: 0 };
      current.point += Number(row.point || 0); current.member_count += Number(row.member_count || 0); grouped.set(id, current);
    }
    const [guilds] = await pool.execute("SELECT guild_id,name,level FROM bot_guilds");
    const names = new Map(guilds.map((row) => [Number(row.guild_id), row]));
    entries = [...grouped.values()].map((entry) => ({ ...entry, guild_name: names.get(entry.guild_id)?.name || entry.guild_name, level: Number(names.get(entry.guild_id)?.level || 1) }));
  }
  entries.sort((a, b) => Number(b.point ?? b.power) - Number(a.point ?? a.power) || Number(a.uid ?? a.guild_id) - Number(b.uid ?? b.guild_id));
  const ranked = entries.slice(0, Math.max(1, Math.min(200, Number(limit) || 100))).map((entry, index) => ({ ...entry, rank: index + 1, point: Number(entry.point ?? entry.power) }));
  const selfGuildId = board === "guild" ? await guildIdFor(pool, playerId) : 0;
  const self = board === "guild" ? ranked.find((entry) => entry.guild_id === selfGuildId) : ranked.find((entry) => entry.uid === Number(playerId));
  return { ok: true, board, entries: ranked, self_rank: self?.rank || 0, self_point: self?.point || 0, count: entries.length };
}

async function sendChat(pool, playerId, payload) {
  const message = String(payload.message || "").trim();
  if (!message || message.length > 500) return { ok: false, status: 422, error: "invalid_chat_message" };
  const recipient = scalar(payload.recipient_player_id, 0);
  let channel = String(payload.channel || "world").slice(0, 64);
  if (recipient) {
    if (recipient === Number(playerId)) return { ok: false, status: 422, error: "invalid_chat_recipient" };
    const [relation] = await pool.execute("SELECT status FROM friendships WHERE player_id=? AND friend_player_id=? LIMIT 1", [playerId, recipient]);
    if (!relation.length || relation[0].status !== "accepted") return { ok: false, status: 403, error: relation[0]?.status === "blocked" ? "social_interaction_blocked" : "friend_not_accepted" };
    const [reverseBlock] = await pool.execute("SELECT 1 FROM friendships WHERE player_id=? AND friend_player_id=? AND status='blocked' LIMIT 1", [recipient, playerId]);
    if (reverseBlock.length) return { ok: false, status: 403, error: "social_interaction_blocked" };
    channel = privateChannel(playerId, recipient);
  } else if (channel === "guild" || channel.startsWith("guild:")) {
    const guildId = await guildIdFor(pool, playerId);
    if (!guildId) return { ok: false, status: 403, error: "not_in_guild" };
    channel = `guild:${guildId}`;
  } else if (channel !== "world") return { ok: false, status: 422, error: "invalid_chat_channel" };
  const [insert] = await pool.execute("INSERT INTO chat_messages (player_id,channel,message,payload_json) VALUES (?,?,?,?)", [playerId, channel, message, JSON.stringify({ source: "local_chat", recipient_player_id: recipient || null })]);
  if (recipient) await event(pool, recipient, playerId, "private_chat", { message_id: insert.insertId, channel });
  return { ok: true, id: Number(insert.insertId), channel, recipient_player_id: recipient || null };
}

async function chatMessages(pool, playerId, query = {}) {
  const recipient = scalar(query.recipient_player_id, 0);
  let channel = String(query.channel || "world").slice(0, 64);
  if (recipient) {
    const [relation] = await pool.execute("SELECT status FROM friendships WHERE player_id=? AND friend_player_id=? LIMIT 1", [playerId, recipient]);
    if (!relation.length || relation[0].status !== "accepted") return { ok: false, status: 403, error: relation[0]?.status === "blocked" ? "social_interaction_blocked" : "friend_not_accepted" };
    const [reverseBlock] = await pool.execute("SELECT 1 FROM friendships WHERE player_id=? AND friend_player_id=? AND status='blocked' LIMIT 1", [recipient, playerId]);
    if (reverseBlock.length) return { ok: false, status: 403, error: "social_interaction_blocked" };
    channel = privateChannel(playerId, recipient);
  }
  else if (channel === "guild" || channel.startsWith("guild:")) {
    const guildId = await guildIdFor(pool, playerId);
    if (!guildId) return { ok: false, status: 403, error: "not_in_guild" };
    channel = `guild:${guildId}`;
  } else if (channel !== "world") return { ok: false, status: 422, error: "invalid_chat_channel" };
  const [rows] = await pool.execute("SELECT c.id,c.player_id,p.nickname,c.channel,c.message,c.payload_json,c.created_at FROM chat_messages c LEFT JOIN players p ON p.id=c.player_id WHERE c.channel=? ORDER BY c.id DESC LIMIT 100", [channel]);
  return { ok: true, channel, messages: rows.reverse().map((row) => ({ ...row, payload_json: json(row.payload_json, null) })) };
}

async function executeSocialProtocolAction(pool, playerId, module, operation, payload = {}) {
  const data = payload && typeof payload === "object" ? payload : {};
  let result;
  if (module === "friend") {
    if (operation === "open_panel" || operation === "open_apply_panel" || operation === "query_rec_friends" || operation === "refresh_rec_friends") result = { ok: true };
    else if (operation === "apply") result = await requestFriends(pool, playerId, values(data.field_1 ?? data.value));
    else if (operation === "handle_app") result = await handleApplications(pool, playerId, scalar(data.field_1), scalar(data.field_2));
    else if (operation === "remove") result = await removeFriends(pool, playerId, values(data.field_1 ?? data.value));
    else if (operation === "search") result = await searchPlayers(pool, playerId, data);
    else if (operation === "present_gift") result = await gift(pool, playerId, "send", values(data.value ?? data.field_1));
    else if (operation === "receive_gift") result = await gift(pool, playerId, "receive", values(data.value ?? data.field_1));
    else if (operation === "gift_one_key") {
      const sent = await gift(pool, playerId, "send", values(data.field_1));
      const received = await gift(pool, playerId, "receive", values(data.field_2));
      result = { ok: sent.ok || received.ok, presented_uids: sent.completed_uids || [], received_uids: received.completed_uids || [], rewards: received.rewards || [], send_error: sent.ok ? null : sent.error, receive_error: received.ok ? null : received.error };
    } else if (operation === "query_summaries") result = { ok: true, summaries: await summaries(pool, values(data.field_1 ?? data.value)) };
    else if (operation === "query_lineup") result = { ok: true, lineup_uid: scalar(data.value ?? data.field_1), lineup: [] };
    else result = { ok: false, status: 422, error: "unsupported_friend_operation" };
    return { ...result, social_friends: await socialSnapshot(pool, playerId) };
  }
  if (module === "ublacklist") {
    if (operation === "open_panel") result = { ok: true };
    else if (operation === "add") result = await blockPlayer(pool, playerId, scalar(data.value ?? data.field_1));
    else if (operation === "remove") result = await unblockPlayer(pool, playerId, scalar(data.value ?? data.field_1));
    else result = { ok: false, status: 422, error: "unsupported_blacklist_operation" };
    return { ...result, social_friends: await socialSnapshot(pool, playerId) };
  }
  if (module === "mercenary") {
    if (operation === "open_panel") result = await mercenaryPanel(pool, playerId);
    else if (operation === "add") result = await addOffer(pool, playerId, scalar(data.value ?? data.field_1));
    else if (operation === "remove") result = await removeOffer(pool, playerId, scalar(data.value ?? data.field_1));
    else result = { ok: false, status: 422, error: "unsupported_mercenary_operation" };
    return { ...result, mercenary: await mercenaryPanel(pool, playerId) };
  }
  if (module === "apostle") {
    if (operation === "open_handle_apply_panel" || operation === "open_apostle_panel") result = { ok: true };
    else if (operation === "req_friend_heroes") result = await friendHeroesForSelection(pool, playerId, scalar(data.value ?? data.field_1));
    else if (operation === "apply") result = await applyMercenary(pool, playerId, scalar(data.field_1), scalar(data.field_2));
    else if (operation === "handle_apply") result = await handleMercenary(pool, playerId, scalar(data.field_1), scalar(data.field_2), scalar(data.field_3));
    else if (operation === "cancel_apply") result = await updateBorrowed(pool, playerId, scalar(data.field_2), ["pending"], "cancelled");
    else if (operation === "return_hero") result = await updateBorrowed(pool, playerId, scalar(data.value ?? data.field_1), ["active", "used"], "returned");
    else result = { ok: false, status: 422, error: "unsupported_apostle_operation" };
    return { ...result, apostle: await mercenaryPanel(pool, playerId) };
  }
  if (module === "rank_board") {
    const boardType = scalar(data.value ?? data.field_1, 0);
    const board = boardType === 3 ? "guild" : String(data.board || "power");
    return rankings(pool, playerId, board, scalar(data.field_4 ?? data.limit, 100));
  }
  if (module === "chat") return { ok: true, channel: scalar(data.value ?? data.field_1, 1), channels: [1, 2, 3] };
  return { ok: false, status: 422, error: "unsupported_social_module" };
}

module.exports = {
  attachMercenaryHeroes, chatMessages, dayOf, executeSocialProtocolAction, gift, privateChannel, rankings,
  scalar, sendChat, socialSnapshot, summaries, useMercenary, settleMercenary, values, weekOf,
};
