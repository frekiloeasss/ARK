const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "data", "official");
const unitLevel = require(path.join(root, "client", "UnitLevel.json"));
const table = unitLevel.ed.UnitLevelTable;
const levels = {};

for (const [key, row] of Object.entries(table)) {
  const level = Number(key);
  if (!Number.isSafeInteger(level) || level < 1 || level > 240) continue;
  const costs = Array.isArray(row.LevelUpCost) ? row.LevelUpCost : [];
  let essence = 0;
  for (let index = 0; index + 2 < costs.length; index += 3) {
    if (String(costs[index]).toLowerCase() === "item" && Number(costs[index + 1]) === 1) {
      essence += Number(costs[index + 2] || 0);
    }
  }
  levels[level] = {
    gold: Number(row.GoldConsume || 0),
    hero_exp: Number(row.HeroExpConsume || 0),
    essence,
    rank: Number(row.Rank || 1),
    display_level: Number(row.DisplayLevel || row.Level || level),
    stat_delta: {
      hp: Number(row["+HP"] || 0),
      atk: Number(row["+ATK"] || 0),
      arm: Number(row["+ARM"] || 0),
      mr: Number(row["+MR"] || 0),
    },
  };
}

if (Object.keys(levels).length !== 240) {
  throw new Error(`Expected 240 exact client levels, got ${Object.keys(levels).length}`);
}
if (levels[10].gold !== 1116 || levels[10].hero_exp !== 417 || levels[10].essence !== 10) {
  throw new Error("Decrypted level 10 does not match the captured official response");
}

const output = {
  schema_version: 2,
  client_version: "1.182.03.301371",
  levels,
  evidence: {
    all_levels: "decrypted_official_client_UnitLevel.jsone",
    level_10: "decrypted_client_config_and_captured_official_response",
    source_file: "assets/srcmodule/UnitLevel.jsone",
  },
};
fs.writeFileSync(
  path.join(root, "hero-level-costs.json"),
  `${JSON.stringify(output, null, 2)}\n`,
  "utf8"
);
console.log(`Derived ${Object.keys(levels).length} exact hero levels`);
