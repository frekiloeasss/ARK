"use strict";

const { createHash } = require("node:crypto");
const { loadConfig } = require("./official-config-catalog");
const { statsFor, teamPower } = require("./authoritative-battle-service");

const UNIT_HEROES = loadConfig("UnitHero").table;
const BOT_NAMES = [
  "耀光守望者", "蛮血猎手", "绿裔旅人", "亡灵诗人", "晨星骑士", "薄暮游侠",
  "橡木贤者", "王城卫兵", "月桂祭司", "荒原行者", "苍穹之翼", "深林回声",
  "灰烬剑士", "星辉学者", "远征先锋", "秘银守卫", "风语者", "永夜哨兵",
  "霜叶法师", "沙海佣兵", "黎明侍从", "古墓看守", "赤羽斥候", "白塔记录官",
];
const GUILD_NAMES = ["伊索米亚远征队", "薄暮森林", "王城守卫军", "荒火部族", "星界旅团", "永夜图书馆"];
const CHAT_LINES = [
  "今天的悬赏已经清完了。", "有人一起挑战公会首领吗？", "迷宫记得先选恢复类遗物。",
  "竞技场防守阵容刚调整好。", "挂机奖励满了，记得领取。", "祝大家十连都出想要的英雄！",
  "王座之塔又推进了一层。", "今天的商店刷新还不错。",
];

function hashInt(value) {
  return createHash("sha256").update(String(value)).digest().readUInt32LE(0);
}

function heroIds() {
  return Object.keys(UNIT_HEROES).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
}

function buildBot(botId) {
  const ids = heroIds();
  const seed = hashInt(`afk-bot:${botId}`);
  const level = 20 + (seed % 221);
  const quality = 2 + (seed % 8);
  const lineup = Array.from({ length: 5 }, (_, index) => {
    const tid = ids[(seed + index * 37 + botId * 11) % ids.length];
    return { slot: index + 1, tid, level, quality, rank: 1 + ((seed >>> (index * 3)) % 6) };
  });
  const units = lineup.map((hero, index) => ({ id: `bot_${botId}_${index + 1}`, ...hero, ...statsFor(hero.tid, hero.level, hero.quality, { rank: hero.rank }) }));
  const guildId = 1 + (botId % GUILD_NAMES.length);
  return {
    bot_id: 90000000 + botId,
    nickname: `${BOT_NAMES[botId % BOT_NAMES.length]}${String(Math.floor(botId / BOT_NAMES.length) + 1).padStart(2, "0")}`,
    level,
    avatar: `avatar:${ids[seed % ids.length]}`,
    guild_id: guildId,
    guild_name: GUILD_NAMES[guildId - 1],
    power: teamPower(units),
    rating: 700 + level * 8 + quality * 30,
    lineup,
    personality: { chat_line: CHAT_LINES[seed % CHAT_LINES.length], activity_offset: seed % 3600 },
  };
}

function blueprints(count = 120) { return Array.from({ length: count }, (_, index) => buildBot(index + 1)); }

async function seedBotEcosystem(pool, count = 120) {
  for (let id = 1; id <= GUILD_NAMES.length; id += 1) {
    await pool.execute(
      "INSERT INTO bot_guilds (guild_id,name,level,notice,capacity) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),level=VALUES(level),notice=VALUES(notice),capacity=VALUES(capacity)",
      [id, GUILD_NAMES[id - 1], 1 + id * 2, "欢迎加入本地人机公会，一起远征伊索米亚。", 70]
    );
  }
  for (const bot of blueprints(count)) {
    await pool.execute(
      "INSERT INTO bot_profiles (bot_id,nickname,level,avatar,guild_id,power,rating,lineup_json,personality_json,last_active_at) VALUES (?,?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE nickname=VALUES(nickname),level=VALUES(level),avatar=VALUES(avatar),guild_id=VALUES(guild_id),power=VALUES(power),rating=VALUES(rating),lineup_json=VALUES(lineup_json),personality_json=VALUES(personality_json),last_active_at=NOW()",
      [bot.bot_id, bot.nickname, bot.level, bot.avatar, bot.guild_id, bot.power, bot.rating, JSON.stringify(bot.lineup), JSON.stringify(bot.personality)]
    );
  }
  return { ok: true, bot_count: count, guild_count: GUILD_NAMES.length };
}

function parseJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeBot(row) {
  return { ...row, bot_id: Number(row.bot_id), level: Number(row.level), guild_id: Number(row.guild_id), power: Number(row.power), rating: Number(row.rating),
    lineup: parseJson(row.lineup_json, []), personality: parseJson(row.personality_json, {}) };
}

async function getBot(pool, botId) {
  const [rows] = await pool.execute("SELECT b.*,g.name guild_name FROM bot_profiles b LEFT JOIN bot_guilds g ON g.guild_id=b.guild_id WHERE b.bot_id=? LIMIT 1", [Number(botId)]);
  return rows.length ? normalizeBot(rows[0]) : null;
}

async function arenaOpponents(pool, playerId, count = 5) {
  const [rankRows] = await pool.execute("SELECT quantity FROM inventory_items WHERE player_id=? AND item_id='meta_arena_point' LIMIT 1", [playerId]);
  const target = Number(rankRows[0]?.quantity || 1000);
  const safeLimit = Math.max(1, Math.min(10, Math.trunc(Number(count))));
  const [rows] = await pool.execute(`SELECT b.*,g.name guild_name FROM bot_profiles b LEFT JOIN bot_guilds g ON g.guild_id=b.guild_id ORDER BY ABS(b.rating-?),b.bot_id LIMIT ${safeLimit}`, [target]);
  return rows.map(normalizeBot).map((bot, index) => ({ ...bot, rank: Math.max(1, 100 - index), point: bot.rating, is_robot: true }));
}

async function botGuilds(pool, limit = 6) {
  const safeLimit = Math.max(1, Math.min(20, Math.trunc(Number(limit))));
  const [rows] = await pool.execute(`SELECT g.*,COUNT(b.bot_id) member_count,SUM(b.power) total_power FROM bot_guilds g LEFT JOIN bot_profiles b ON b.guild_id=g.guild_id GROUP BY g.guild_id ORDER BY g.level DESC,g.guild_id LIMIT ${safeLimit}`);
  return rows.map((row) => ({ ...row, guild_id: Number(row.guild_id), level: Number(row.level), member_count: Number(row.member_count), total_power: Number(row.total_power || 0) }));
}

async function botGuildMembers(pool, guildId, limit = 30) {
  const safeLimit = Math.max(1, Math.min(70, Math.trunc(Number(limit))));
  const [rows] = await pool.execute(`SELECT b.*,g.name guild_name FROM bot_profiles b LEFT JOIN bot_guilds g ON g.guild_id=b.guild_id WHERE b.guild_id=? ORDER BY b.power DESC LIMIT ${safeLimit}`, [Number(guildId)]);
  return rows.map(normalizeBot);
}

async function recordBotBattle(pool, playerId, bot, result, pointChange, replayId) {
  await pool.execute("INSERT INTO bot_battle_records (player_id,bot_id,result,point_change,replay_id,detail_json) VALUES (?,?,?,?,?,?)", [playerId, bot.bot_id, result, pointChange, String(replayId), JSON.stringify({ bot_name: bot.nickname, bot_power: bot.power, bot_lineup: bot.lineup })]);
}

async function botBattleRecords(pool, playerId, limit = 20) {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(Number(limit))));
  const [rows] = await pool.execute(`SELECT r.*,b.nickname opponent_name,b.power opponent_power,b.avatar,b.guild_id,g.name guild_name FROM bot_battle_records r JOIN bot_profiles b ON b.bot_id=r.bot_id LEFT JOIN bot_guilds g ON g.guild_id=b.guild_id WHERE r.player_id=? ORDER BY r.id DESC LIMIT ${safeLimit}`, [playerId]);
  return rows.map((row) => ({ id: Number(row.id), timestamp: Math.floor(new Date(row.created_at).getTime() / 1000), opponent_uid: Number(row.bot_id), opponent_name: row.opponent_name,
    opponent_power: Number(row.opponent_power), avatar: row.avatar, guild_id: Number(row.guild_id), guild_name: row.guild_name, result: row.result === "victory" ? 1 : 2,
    point_delta: Number(row.point_change), replay_id: Number(row.replay_id), is_robot: true }));
}

async function seedBotChat(pool, channel = "world", count = 8) {
  const [existing] = await pool.execute("SELECT COUNT(*) count FROM chat_messages WHERE channel=? AND JSON_EXTRACT(payload_json,'$.source')='bot_ecosystem'", [channel]);
  if (Number(existing[0].count) >= count) return;
  const bots = blueprints(count);
  for (const bot of bots) {
    await pool.execute("INSERT INTO chat_messages (player_id,channel,message,payload_json) VALUES (NULL,?,?,?)", [channel, bot.personality.chat_line, JSON.stringify({ source: "bot_ecosystem", bot_id: bot.bot_id, bot_name: bot.nickname, avatar: bot.avatar })]);
  }
}

async function botChatReply(pool, channel, playerMessage) {
  const bots = blueprints(120); const bot = bots[hashInt(playerMessage) % bots.length];
  const replies = [bot.personality.chat_line, "收到，祝你冒险顺利！", "这个阵容看起来不错。", "我也正在做这个玩法。"];
  const message = replies[hashInt(`${playerMessage}:reply`) % replies.length];
  const [insert] = await pool.execute("INSERT INTO chat_messages (player_id,channel,message,payload_json) VALUES (NULL,?,?,?)", [channel, message, JSON.stringify({ source: "bot_ecosystem", bot_id: bot.bot_id, bot_name: bot.nickname, avatar: bot.avatar, reply_to: playerMessage })]);
  return { id: Number(insert.insertId), bot_id: bot.bot_id, nickname: bot.nickname, message };
}

module.exports = { arenaOpponents, blueprints, botBattleRecords, botChatReply, botGuildMembers, botGuilds, getBot, recordBotBattle, seedBotChat, seedBotEcosystem };
