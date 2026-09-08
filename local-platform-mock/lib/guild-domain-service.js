"use strict";

const BOSS_MAX_HP = 1_000_000;
// Classic 1.201 exposes two guild hunt attempts per daily cycle.
const DAILY_ATTEMPTS = 2;
const SHOP_GOODS = [
  { index: 1, cost: { type: "currency", id: "guild_coin", amount: 500 }, reward: { type: "item", id: 13, amount: 1 }, limit: 1 },
  { index: 2, cost: { type: "currency", id: "guild_coin", amount: 800 }, reward: { type: "item", id: 40, amount: 1 }, limit: 1 },
  { index: 3, cost: { type: "currency", id: "guild_coin", amount: 1200 }, reward: { type: "item", id: 13, amount: 3 }, limit: 1 },
];
const TASKS = [
  { id: 1, target: 10, rewards: [{ type: "currency", id: "guild_coin", amount: 100 }] },
  { id: 2, target: 30, rewards: [{ type: "currency", id: "guild_coin", amount: 250 }] },
  { id: 3, target: 60, rewards: [{ type: "currency", id: "diamond", amount: 50 }] },
];

function cycles(nowTs = Math.floor(Date.now() / 1000)) {
  const now = Math.max(0, Number(nowTs || 0));
  const day = Math.floor(now / 86400), week = Math.floor(now / 604800);
  return { day, week, daily_reset_at: (day + 1) * 86400, weekly_reset_at: (week + 1) * 604800 };
}

function quantity(state, key) {
  return Number((state.inventory || []).find((row) => String(row.item_id) === String(key))?.quantity || 0);
}
function meta(state, key, fallback = 0) { return quantity(state, `meta_${key}`) || fallback; }
function keyOf(asset) { return asset.type === "currency" ? String(asset.id) : `${asset.type}_${asset.id}`; }

function mutateAssets(state, costs = [], rewards = [], source = "guild") {
  const values = new Map();
  const value = (key) => values.has(key) ? values.get(key) : quantity(state, key);
  for (const cost of costs) {
    const key = keyOf(cost), next = value(key) - Number(cost.amount || 0);
    if (next < 0) return { ok: false, status: 409, error: "insufficient_asset", asset: cost, available: value(key) };
    values.set(key, next);
  }
  for (const reward of rewards) { const key = keyOf(reward); values.set(key, value(key) + Number(reward.amount || 0)); }
  return { ok: true, inventory: [...values].map(([item_id, amount]) => ({ item_id, quantity: amount, extra: { source } })) };
}

function playerOf(state, request = {}) {
  const player = request.player || state.player || {};
  return {
    uid: String(request.player_uid || player.player_uid || player.id || "local-player"),
    id: Number(request.player_id || player.id || 1),
    name: String(request.nickname || player.nickname || "本地玩家"),
    level: Number(player.level || 1),
  };
}

function newBoss(day) {
  return { day, boss_id: 1, max_hp: BOSS_MAX_HP, hp: BOSS_MAX_HP, total_damage: 0, records: [], settled_battle_ids: [] };
}

function createDocument(state, request = {}) {
  const now = Number(request.now_ts || Math.floor(Date.now() / 1000)), c = cycles(now), player = playerOf(state, request);
  const guild = {
    version: 1, guild_id: Number(request.guild_id || 1),
    name: String(request.name || "本地冒险者公会").trim().slice(0, 24),
    notice: String(request.notice || "共同建设伊索米亚").slice(0, 120),
    icon: Number(request.icon || 1), level: 1, exp: 0, active_point: 0,
    join_type: 1, require_lv: 1, capacity: 70, owner_uid: player.uid,
    created_at: now, updated_at: now, dissolved: false,
    members: {}, history: [], messages: [], shop_purchases: {}, task_claims: {},
    applications: {}, processed_requests: {},
    boss: newBoss(c.day), weekly: { cycle: c.week, active_point: 0, reward_claims: {} },
  };
  guild.members[player.uid] = { ...player, role: 3, contribution: 0, weekly_contribution: 0, donation_day: c.day, donation_count: 0, joined_at: now, last_active_at: now };
  guild.history.push({ type: "create", uid: player.uid, name: player.name, at: now });
  return guild;
}

function normalize(state, request = {}) {
  const source = request.guild_document || request.guild_state;
  const guild = source && typeof source === "object" ? JSON.parse(JSON.stringify(source)) : createDocument(state, request);
  guild.members ||= {}; guild.history = Array.isArray(guild.history) ? guild.history : [];
  guild.messages = Array.isArray(guild.messages) ? guild.messages : [];
  guild.shop_purchases ||= {}; guild.task_claims ||= {}; guild.applications ||= {}; guild.processed_requests ||= {};
  const c = cycles(request.now_ts);
  if (!guild.weekly || Number(guild.weekly.cycle) !== c.week) guild.weekly = { cycle: c.week, active_point: 0, reward_claims: {} };
  if (!guild.boss || Number(guild.boss.day) !== c.day) guild.boss = newBoss(c.day);
  guild.boss.records ||= []; guild.boss.settled_battle_ids ||= [];
  return guild;
}

function member(guild, uid) { return guild?.members?.[String(uid)] || null; }
function role(state, request, guild) { return Number(member(guild, playerOf(state, request).uid)?.role || meta(state, "guild_role", 1)); }
function summary(guild) {
  return { guild_id: Number(guild.guild_id), name: guild.name, notice: guild.notice, icon: Number(guild.icon || 1), level: Number(guild.level || 1), exp: Number(guild.exp || 0), active_point: Number(guild.active_point || 0), member_count: Object.keys(guild.members || {}).length, capacity: Number(guild.capacity || 70), join_type: Number(guild.join_type || 1), require_lv: Number(guild.require_lv || 1) };
}
function result(guild, extra = {}) { return { ok: true, guild_id: Number(guild.guild_id), guild: summary(guild), guild_document: guild, ...extra }; }
function inventoryMembership(guildId, memberRole, source) {
  return [
    { item_id: "meta_guild_id", quantity: Number(guildId), extra: { source } },
    { item_id: "meta_guild_role", quantity: Number(memberRole), extra: { source } },
  ];
}

function open(state, request = {}) {
  const guildId = meta(state, "guild_id");
  if (!guildId) return { ok: true, guild_id: 0, joined: false, guilds: request.recommendations || request.bot_guilds || [] };
  const guild = normalize(state, { ...request, guild_id: guildId }), player = playerOf(state, request), now = Number(request.now_ts || Math.floor(Date.now() / 1000));
  if (request.guild_document && !guild.members[player.uid]) {
    return { ok: true, guild_id: 0, joined: false, membership_revoked: true, guild_document: guild, inventory: inventoryMembership(0, 0, "guild_membership_reconciled") };
  }
  if (!guild.members[player.uid]) guild.members[player.uid] = { ...player, role: meta(state, "guild_role", 1), contribution: meta(state, "guild_contribution"), weekly_contribution: 0, donation_day: cycles(now).day, donation_count: 0, joined_at: now, last_active_at: now };
  guild.members[player.uid].last_active_at = now;
  const correctedRole = Number(guild.members[player.uid].role || 1), inventory = correctedRole !== meta(state, "guild_role", 1) ? inventoryMembership(guildId, correctedRole, "guild_role_reconciled") : [];
  return result(guild, { joined: true, members: Object.values(guild.members), cycles: cycles(request.now_ts), inventory });
}

function create(state, request = {}) {
  if (meta(state, "guild_id")) return { ok: false, status: 409, error: "already_in_guild" };
  const name = String(request.name || "").trim();
  if (name.length < 2 || name.length > 24) return { ok: false, status: 422, error: "invalid_guild_name" };
  const guild = createDocument(state, { ...request, name });
  return result(guild, { joined: true, name, members: Object.values(guild.members), inventory: [...inventoryMembership(guild.guild_id, 3, "guild_create"), { item_id: "meta_guild_contribution", quantity: 0, extra: { source: "guild_create" } }] });
}

function search(state, request = {}) {
  const rows = request.recommendations || request.bot_guilds || [];
  const fallback = rows.length ? rows : [{ guild_id: Number(request.guild_id || 1), name: "本地冒险者公会", level: 1, member_count: meta(state, "guild_id") === Number(request.guild_id || 1) ? 1 : 0 }];
  const id = Number(request.guild_id || 0), text = String(request.name || "").trim().toLowerCase();
  return { ok: true, guilds: fallback.filter((row) => (!id || Number(row.guild_id) === id) && (!text || String(row.name || "").toLowerCase().includes(text))) };
}

function join(state, request = {}) {
  if (meta(state, "guild_id")) return { ok: false, status: 409, error: "already_in_guild" };
  const guildId = Number(request.guild_id || 1), guild = normalize(state, { ...request, guild_id: guildId }), player = playerOf(state, request), now = Number(request.now_ts || Math.floor(Date.now() / 1000));
  if (guild.dissolved) return { ok: false, status: 410, error: "guild_dissolved" };
  if (player.level < Number(guild.require_lv || 1)) return { ok: false, status: 409, error: "guild_level_requirement" };
  if (Number(guild.join_type || 1) === 2 && !request.approved) return { ok: false, status: 409, error: "guild_application_required" };
  if (Object.keys(guild.members).length >= Number(guild.capacity || 70)) return { ok: false, status: 409, error: "guild_full" };
  guild.members[player.uid] = { ...player, role: 1, contribution: 0, weekly_contribution: 0, donation_day: cycles(now).day, donation_count: 0, joined_at: now, last_active_at: now };
  guild.history.unshift({ type: "join", uid: player.uid, name: player.name, at: now });
  return result(guild, { joined: true, members: Object.values(guild.members), inventory: inventoryMembership(guildId, 1, "guild_join") });
}

function edit(state, request = {}) {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request), actor = playerOf(state, request);
  if (role(state, request, guild) < 2) return { ok: false, status: 403, error: "guild_permission_denied" };
  if (request.name != null) {
    const name = String(request.name).trim();
    if (name.length < 2 || name.length > 24) return { ok: false, status: 422, error: "invalid_guild_name" };
    guild.name = name;
  }
  if (request.notice != null) guild.notice = String(request.notice).trim().slice(0, 120);
  if (request.icon != null) guild.icon = Math.max(1, Number(request.icon || 1));
  if (request.join_type != null) guild.join_type = [1, 2].includes(Number(request.join_type)) ? Number(request.join_type) : 1;
  if (request.require_lv != null) guild.require_lv = Math.max(1, Math.min(999, Number(request.require_lv || 1)));
  guild.updated_at = Number(request.now_ts || Math.floor(Date.now() / 1000));
  guild.history.unshift({ type: "edit", uid: actor.uid, at: guild.updated_at });
  return result(guild);
}

function applyJoin(state, request = {}) {
  if (meta(state, "guild_id")) return { ok: false, status: 409, error: "already_in_guild" };
  const guild = normalize(state, request), player = playerOf(state, request), requestId = String(request.request_id || `apply:${guild.guild_id}:${player.uid}`);
  if (!guild.applications[player.uid]) guild.applications[player.uid] = { request_id: requestId, ...player, at: Number(request.now_ts || Math.floor(Date.now() / 1000)) };
  return result(guild, { applied: true, application: guild.applications[player.uid] });
}

function applications(state, request = {}) {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request);
  if (role(state, request, guild) < 2) return { ok: false, status: 403, error: "guild_permission_denied" };
  return result(guild, { applications: Object.values(guild.applications) });
}

function approveJoin(state, request = {}) {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request), actor = playerOf(state, request), targetUid = String(request.target_uid || ""), application = guild.applications[targetUid];
  if (role(state, request, guild) < 2) return { ok: false, status: 403, error: "guild_permission_denied" };
  if (!application) return { ok: false, status: 404, error: "guild_application_not_found" };
  if (Object.keys(guild.members).length >= Number(guild.capacity || 70)) return { ok: false, status: 409, error: "guild_full" };
  guild.members[targetUid] = { uid: targetUid, id: application.id, name: application.name, level: application.level, role: 1, contribution: 0, weekly_contribution: 0, donation_day: cycles(request.now_ts).day, donation_count: 0, joined_at: Number(request.now_ts || Math.floor(Date.now() / 1000)), last_active_at: Number(request.now_ts || Math.floor(Date.now() / 1000)) };
  delete guild.applications[targetUid];
  guild.history.unshift({ type: "approve", uid: actor.uid, target_uid: targetUid, at: Number(request.now_ts || Math.floor(Date.now() / 1000)) });
  return result(guild, { approved_uid: targetUid, members: Object.values(guild.members) });
}

function leave(state, request = {}) {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request), player = playerOf(state, request), current = member(guild, player.uid), now = Number(request.now_ts || Math.floor(Date.now() / 1000));
  if (current?.role === 3) {
    const successor = Object.values(guild.members).filter((row) => row.uid !== player.uid).sort((a, b) => Number(b.role) - Number(a.role) || Number(a.joined_at) - Number(b.joined_at))[0];
    if (successor) { successor.role = 3; guild.owner_uid = successor.uid; } else guild.dissolved = true;
  }
  delete guild.members[player.uid]; guild.history.unshift({ type: guild.dissolved ? "disband" : "leave", uid: player.uid, name: player.name, at: now });
  return result(guild, { joined: false, inventory: inventoryMembership(0, 0, "guild_leave") });
}

function manage(state, request = {}, action = "promote") {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request), actor = playerOf(state, request), targetUid = String(request.target_uid || request.id || ""), target = member(guild, targetUid);
  if (role(state, request, guild) < 3) return { ok: false, status: 403, error: "guild_permission_denied" };
  if (!target || target.uid === actor.uid) return { ok: false, status: 404, error: "guild_member_not_found" };
  if (target.role === 3 && action !== "transfer") return { ok: false, status: 409, error: "guild_owner_protected" };
  if (action === "kick") delete guild.members[targetUid];
  else if (action === "promote") target.role = 2;
  else if (action === "demote") target.role = 1;
  else if (action === "transfer") { const owner = member(guild, actor.uid); if (owner) owner.role = 2; target.role = 3; guild.owner_uid = target.uid; }
  guild.history.unshift({ type: action, uid: actor.uid, target_uid: targetUid, at: Number(request.now_ts || Math.floor(Date.now() / 1000)) });
  return result(guild, { members: Object.values(guild.members), target_uid: targetUid, action });
}

function disband(state, request = {}) {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request), actor = playerOf(state, request);
  if (String(guild.owner_uid) !== actor.uid) return { ok: false, status: 403, error: "guild_permission_denied" };
  guild.dissolved = true; guild.members = {}; guild.history.unshift({ type: "disband", uid: actor.uid, at: Number(request.now_ts || Math.floor(Date.now() / 1000)) });
  return result(guild, { joined: false, inventory: inventoryMembership(0, 0, "guild_disband") });
}

function members(state, request = {}) {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request), merged = [...Object.values(guild.members)];
  for (const row of request.bot_members || []) if (!merged.some((item) => String(item.uid || item.id) === String(row.uid || row.id || row.bot_id))) merged.push(row);
  return result(guild, { members: merged });
}

function donate(state, request = {}) {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request), player = playerOf(state, request), c = cycles(request.now_ts);
  const m = member(guild, player.uid) || (guild.members[player.uid] = { ...player, role: 1, contribution: 0, weekly_contribution: 0, donation_day: c.day, donation_count: 0 });
  if (Number(m.donation_day) !== c.day) { m.donation_day = c.day; m.donation_count = 0; }
  if (Number(m.donation_count || 0) >= 3) return { ok: false, status: 409, error: "guild_donation_limit" };
  const amount = Math.max(1, Math.min(20, Number(request.count || 10))), cost = { type: "currency", id: "gold", amount: amount * 1000 }, rewards = [{ type: "currency", id: "guild_coin", amount: amount * 10 }];
  const transition = mutateAssets(state, [cost], rewards, "guild_donate"); if (!transition.ok) return transition;
  m.contribution = Number(m.contribution || 0) + amount; m.weekly_contribution = Number(m.weekly_contribution || 0) + amount; m.donation_count++;
  guild.exp += amount; guild.active_point += amount; guild.weekly.active_point += amount;
  transition.inventory.push({ item_id: "meta_guild_contribution", quantity: m.contribution, extra: { source: "guild_donate" } });
  return { ...result(guild, { contribution: m.contribution, donation_count: m.donation_count, cost: [cost], rewards }), ...transition, guild_document: guild };
}

function shopOpen(state, request = {}) {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request), player = playerOf(state, request), cycle = cycles(request.now_ts).week;
  const purchases = guild.shop_purchases[String(cycle)]?.[player.uid] || {};
  return result(guild, { cycle, goods: SHOP_GOODS.map((row) => ({ ...row, purchased: Number(purchases[row.index] || 0), sold: Number(purchases[row.index] || 0) >= row.limit })) });
}

function shopBuy(state, request = {}) {
  const opened = shopOpen(state, request); if (!opened.ok) return opened;
  const guild = opened.guild_document, player = playerOf(state, request), good = SHOP_GOODS.find((row) => row.index === Number(request.index));
  if (!good) return { ok: false, status: 404, error: "guild_shop_good_not_found" };
  const cycle = String(opened.cycle); guild.shop_purchases[cycle] ||= {}; guild.shop_purchases[cycle][player.uid] ||= {};
  const purchases = guild.shop_purchases[cycle][player.uid]; if (Number(purchases[good.index] || 0) >= good.limit) return { ok: false, status: 409, error: "guild_shop_good_sold" };
  const transition = mutateAssets(state, [good.cost], [good.reward], "guild_shop"); if (!transition.ok) return transition;
  purchases[good.index] = Number(purchases[good.index] || 0) + 1;
  return { ...result(guild, { index: good.index, cost: [good.cost], rewards: [good.reward], sold: true }), ...transition, guild_document: guild };
}

function taskInfo(state, request = {}) {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request), player = playerOf(state, request), m = member(guild, player.uid) || { contribution: meta(state, "guild_contribution") }, claims = guild.task_claims[player.uid] || [];
  return result(guild, { tasks: TASKS.map((task) => ({ ...task, progress: Number(m.contribution || 0), claimed: claims.includes(task.id), claimable: Number(m.contribution || 0) >= task.target && !claims.includes(task.id) })) });
}

function taskClaim(state, request = {}) {
  const info = taskInfo(state, request); if (!info.ok) return info;
  const task = info.tasks.find((row) => row.id === Number(request.id));
  if (!task) return { ok: false, status: 404, error: "guild_task_not_found" };
  if (task.claimed) return { ok: false, status: 409, error: "guild_task_already_claimed" };
  if (!task.claimable) return { ok: false, status: 409, error: "guild_task_condition_not_met" };
  const guild = info.guild_document, player = playerOf(state, request); guild.task_claims[player.uid] ||= []; guild.task_claims[player.uid].push(task.id);
  const transition = mutateAssets(state, [], task.rewards, "guild_task");
  return { ...result(guild, { task_id: task.id, rewards: task.rewards }), ...transition, guild_document: guild };
}

function chat(state, request = {}) {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request), player = playerOf(state, request), now = Number(request.now_ts || Math.floor(Date.now() / 1000));
  if (request.message != null) {
    const message = String(request.message).trim().slice(0, 200); if (!message) return { ok: false, status: 422, error: "guild_message_empty" };
    const id = String(request.message_id || `${player.uid}:${now}:${guild.messages.length}`);
    if (!guild.messages.some((row) => row.id === id)) guild.messages.push({ id, uid: player.uid, name: player.name, message, at: now });
  }
  guild.messages = guild.messages.slice(-100); return result(guild, { messages: guild.messages });
}

function rank(state, request = {}) {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request), rankings = Object.values(guild.members).sort((a, b) => Number(b.weekly_contribution || 0) - Number(a.weekly_contribution || 0)).map((row, index) => ({ rank: index + 1, uid: row.uid, name: row.name, score: Number(row.weekly_contribution || 0) }));
  return result(guild, { rankings });
}

function bossOpen(state, request = {}) {
  if (!meta(state, "guild_id")) return { ok: false, status: 409, error: "not_in_guild" };
  const guild = normalize(state, request), player = playerOf(state, request), currentMember = member(guild, player.uid);
  if (!currentMember) return { ok: false, status: 409, error: "guild_membership_not_found" };
  const own = guild.boss.records.filter((row) => row.uid === player.uid);
  return result(guild, { boss_id: guild.boss.boss_id, hp: guild.boss.hp, max_hp: guild.boss.max_hp, total_damage: guild.boss.total_damage, attempts: Math.max(0, DAILY_ATTEMPTS - own.length), active_battle: currentMember.active_battle || null, records: guild.boss.records, defeated: guild.boss.hp <= 0, cycles: cycles(request.now_ts) });
}

function bossStart(state, request = {}) {
  const panel = bossOpen(state, request); if (!panel.ok) return panel;
  if (panel.attempts <= 0) return { ok: false, status: 409, error: "guild_boss_no_attempts" };
  if (panel.defeated) return { ok: false, status: 409, error: "guild_boss_defeated" };
  const guild = panel.guild_document, player = playerOf(state, request), m = member(guild, player.uid), existing = m?.active_battle;
  if (existing) return result(guild, { ...panel, battle_id: existing.battle_id, idempotent_replay: true });
  const battleId = String(request.battle_id || `guild-${guild.guild_id}-${guild.boss.day}-${player.uid}-${DAILY_ATTEMPTS - panel.attempts + 1}`);
  if (m) m.active_battle = { battle_id: battleId, lineup_ids: (request.lineup_ids || []).map(Number), started_at: Number(request.now_ts || Math.floor(Date.now() / 1000)) };
  return result(guild, { ...panel, battle_id: battleId, lineup_ids: request.lineup_ids || [] });
}

function bossEnd(state, request = {}) {
  const panel = bossOpen(state, request); if (!panel.ok) return panel;
  const guild = panel.guild_document, player = playerOf(state, request), m = member(guild, player.uid), active = m?.active_battle;
  const battleId = String(request.battle_id || active?.battle_id || "");
  if (battleId && guild.boss.settled_battle_ids.includes(battleId)) return result(guild, { ...panel, battle_id: battleId, damage: 0, rewards: [], idempotent_replay: true });
  if (!active && request.require_active !== false) return { ok: false, status: 409, error: "guild_boss_active_battle_not_found" };
  const damage = Math.max(0, Math.min(Number(guild.boss.hp), Number(request.damage || 0))), rewards = damage ? [{ type: "currency", id: "guild_coin", amount: Math.max(1, Math.floor(damage / 1000)) }] : [];
  const transition = mutateAssets(state, [], rewards, "guild_boss"); if (!transition.ok) return transition;
  guild.boss.hp -= damage; guild.boss.total_damage += damage;
  guild.boss.settled_battle_ids.push(battleId || `legacy-${player.uid}-${guild.boss.records.length}`);
  guild.boss.records.push({ uid: player.uid, name: player.name, damage, battle_id: battleId, at: Number(request.now_ts || Math.floor(Date.now() / 1000)) });
  if (m) delete m.active_battle;
  const attempts = Math.max(0, DAILY_ATTEMPTS - guild.boss.records.filter((row) => row.uid === player.uid).length);
  transition.inventory.push({ item_id: "meta_guild_boss_damage", quantity: guild.boss.records.filter((row) => row.uid === player.uid).reduce((sum, row) => sum + Number(row.damage), 0), extra: { source: "guild_boss", cycle: guild.boss.day } }, { item_id: "meta_guild_boss_attempts", quantity: attempts, extra: { source: "guild_boss", cycle: guild.boss.day } });
  return { ...result(guild, { boss_id: guild.boss.boss_id, hp: guild.boss.hp, max_hp: guild.boss.max_hp, total_damage: guild.boss.total_damage, attempts, damage, battle_id: battleId, rewards, defeated: guild.boss.hp <= 0 }), ...transition, guild_document: guild };
}

function bossFinalReward(state, request = {}) {
  const panel = bossOpen(state, request); if (!panel.ok) return panel;
  if (!panel.defeated) return { ok: false, status: 409, error: "guild_boss_not_defeated" };
  const guild = panel.guild_document, player = playerOf(state, request), key = `${guild.boss.day}:${player.uid}`;
  if (guild.weekly.reward_claims[key]) return { ok: false, status: 409, error: "guild_boss_reward_claimed" };
  const rewards = [{ type: "currency", id: "guild_coin", amount: 1000 }, { type: "currency", id: "diamond", amount: 100 }];
  guild.weekly.reward_claims[key] = true; const transition = mutateAssets(state, [], rewards, "guild_boss_final");
  return { ...result(guild, { rewards }), ...transition, guild_document: guild };
}

module.exports = { BOSS_MAX_HP, DAILY_ATTEMPTS, SHOP_GOODS, TASKS, cycles, createDocument, normalize, open, create, search, join, edit, applyJoin, applications, approveJoin, leave, manage, disband, members, donate, shopOpen, shopBuy, taskInfo, taskClaim, chat, rank, bossOpen, bossStart, bossEnd, bossFinalReward };
