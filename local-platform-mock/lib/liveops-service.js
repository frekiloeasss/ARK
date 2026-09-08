const DAY = 86400;
const WEEK = DAY * 7;
const SEASON = DAY * 28;

function qty(state, key) {
  return Number((state.inventory || []).find((row) => String(row.item_id) === String(key))?.quantity || 0);
}

function marker(item_id, quantity, source, extra = {}) {
  return { item_id, quantity, extra: { source, ...extra } };
}

function periodInfo(nowTs = Math.floor(Date.now() / 1000)) {
  const now = Math.max(0, Number(nowTs));
  return {
    day: Math.floor(now / DAY),
    week: Math.floor((now + 3 * DAY) / WEEK),
    season: Math.floor(now / SEASON),
    next_daily_ts: (Math.floor(now / DAY) + 1) * DAY,
    next_weekly_ts: (Math.floor((now + 3 * DAY) / WEEK) + 1) * WEEK - 3 * DAY,
    next_season_ts: (Math.floor(now / SEASON) + 1) * SEASON,
  };
}

function runDueResets(state, nowTs = Math.floor(Date.now() / 1000)) {
  const period = periodInfo(nowTs);
  const inventory = [];
  const resets = [];
  if (qty(state, "meta_liveops_day") !== period.day) {
    resets.push("daily");
    inventory.push(
      marker("meta_liveops_day", period.day, "liveops_daily"),
      marker("meta_quick_idle_day", period.day, "liveops_daily"),
      marker("meta_quick_idle_count", 0, "liveops_daily"),
      marker("arena_ticket", 5, "liveops_daily"),
      marker("meta_daily_login_claimed", 0, "liveops_daily")
    );
    for (const id of [1, 4, 5, 6]) {
      inventory.push(marker(`meta_task_claim_${id}`, 0, "liveops_daily"));
      inventory.push(marker(`meta_daily_todo_${id}`, 0, "liveops_daily"));
      inventory.push(marker(`meta_task_chest_${id}`, 0, "liveops_daily"));
    }
  }
  if (qty(state, "meta_liveops_week") !== period.week) {
    resets.push("weekly");
    inventory.push(marker("meta_liveops_week", period.week, "liveops_weekly"));
    for (const id of [101, 102, 103, 104, 105]) {
      inventory.push(marker(`meta_weekly_todo_${id}`, 0, "liveops_weekly"));
      inventory.push(marker(`meta_weekly_claim_${id}`, 0, "liveops_weekly"));
    }
    inventory.push(marker("meta_guild_boss_attempts", 2, "liveops_weekly"));
  }
  if (qty(state, "meta_liveops_season") !== period.season) {
    resets.push("season");
    inventory.push(
      marker("meta_liveops_season", period.season, "liveops_season"),
      marker("meta_arena_rank", 100, "liveops_season"),
      marker("meta_arena_point", 1000, "liveops_season"),
      marker("meta_battle_pass_level", 1, "liveops_season"),
      marker("meta_battle_pass_exp", 0, "liveops_season"),
      marker("meta_battle_pass_claimed", 0, "liveops_season")
    );
  }
  return { ok: true, now_ts: Number(nowTs), period, resets, inventory };
}

function dailyLoginClaim(state, nowTs = Math.floor(Date.now() / 1000)) {
  const period = periodInfo(nowTs);
  if (qty(state, "meta_daily_login_claimed") === period.day) return { ok: false, status: 409, error: "daily_login_already_claimed" };
  const loginDay = Math.max(1, qty(state, "meta_daily_login_streak") + 1);
  const reward = loginDay % 7 === 0
    ? { item_id: "diamond", amount: 300 }
    : { item_id: "gold", amount: 1000 * loginDay };
  return { ok: true, login_day: loginDay, rewards: [reward], inventory: [
    marker(reward.item_id, qty(state, reward.item_id) + reward.amount, "daily_login"),
    marker("meta_daily_login_streak", loginDay, "daily_login"),
    marker("meta_daily_login_claimed", period.day, "daily_login"),
  ] };
}

function battlePassProgress(state, exp) {
  const before = qty(state, "meta_battle_pass_exp");
  const after = before + Math.max(0, Number(exp || 0));
  const level = Math.min(100, Math.floor(after / 1000) + 1);
  return { ok: true, exp: after, level, inventory: [
    marker("meta_battle_pass_exp", after, "battle_pass"),
    marker("meta_battle_pass_level", level, "battle_pass"),
  ] };
}

function battlePassClaim(state, level) {
  const target = Number(level);
  const current = qty(state, "meta_battle_pass_level") || 1;
  const claimed = qty(state, "meta_battle_pass_claimed");
  if (!Number.isInteger(target) || target < 1 || target > current) return { ok: false, status: 409, error: "battle_pass_level_locked" };
  if (target <= claimed) return { ok: false, status: 409, error: "battle_pass_reward_claimed" };
  const diamonds = target * 20;
  return { ok: true, level: target, rewards: [{ item_id: "diamond", amount: diamonds }], inventory: [
    marker("diamond", qty(state, "diamond") + diamonds, "battle_pass_reward"),
    marker("meta_battle_pass_claimed", target, "battle_pass_reward"),
  ] };
}

module.exports = { DAY, SEASON, WEEK, battlePassClaim, battlePassProgress, dailyLoginClaim, periodInfo, runDueResets };
