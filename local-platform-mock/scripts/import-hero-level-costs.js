const fs = require("node:fs");
const path = require("node:path");

const API =
  "https://afk-arena.fandom.com/api.php?action=parse&page=Leveling_Requirements&prop=wikitext&format=json&origin=*";

async function main() {
  let wikitext;
  if (process.env.AFK_LEVELING_WIKITEXT_FILE) {
    wikitext = fs.readFileSync(process.env.AFK_LEVELING_WIKITEXT_FILE, "utf8");
  } else {
    const response = await fetch(API, {
      headers: { "user-agent": "AFK-local-platform-mock/1.0" },
    });
    if (!response.ok) throw new Error(`Fandom API returned ${response.status}`);
    const payload = await response.json();
    wikitext = payload?.parse?.wikitext?.["*"] || "";
  }
  const rows = {};
  const pattern = /\|-\s*\n\|(\d+)\s*\n\|(\d+)\s*\n\|(\d+)\s*\n\|([^\n]*)/g;
  for (const match of wikitext.matchAll(pattern)) {
    const level = Number(match[1]);
    if (level > 240) break;
    rows[level] = {
      gold: Number(match[2]),
      hero_exp: Number(match[3]),
      essence: Number(String(match[4]).trim() || 0),
    };
  }
  if (Object.keys(rows).length !== 240) {
    throw new Error(`Expected 240 hero levels, got ${Object.keys(rows).length}`);
  }
  const captured = rows[10];
  if (captured.gold !== 1116 || captured.hero_exp !== 417 || captured.essence !== 10) {
    throw new Error("Level 10 costs do not match the captured v1.182.03 transition");
  }
  const output = {
    schema_version: 1,
    client_version: "1.182.03.301371",
    levels: rows,
    evidence: {
      level_10: "captured_official_response",
      other_levels: "community_table_corroborated_by_captured_level_10",
      source_url: "https://afk-arena.fandom.com/wiki/Leveling_Requirements",
      imported_at: new Date().toISOString(),
    },
  };
  const outputPath = path.join(__dirname, "..", "data", "official", "hero-level-costs.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote ${Object.keys(rows).length} levels to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
