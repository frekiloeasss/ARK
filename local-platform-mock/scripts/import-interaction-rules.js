const fs = require("node:fs");
const path = require("node:path");
const { createPool } = require("../db");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--fixture") {
      parsed.fixture = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.fixture) {
    throw new Error("--fixture is required.");
  }
  return parsed;
}

async function importInteractionRules(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const rules = fixture.rules || [];
  if (!rules.length) {
    return 0;
  }

  const sourceFixture = fixturePath ? path.resolve(fixturePath) : fixture.source_log || null;
  const pool = createPool();
  try {
    for (const rule of rules) {
      await pool.execute(
        "DELETE FROM ws_interaction_rules WHERE rule_name = ? AND source_fixture <=> ?",
        [rule.label || `rule_${rule.index || 0}`, sourceFixture]
      );
    }

    for (const rule of rules) {
      await pool.execute(
        `INSERT INTO ws_interaction_rules (
          rule_name,
          enabled,
          priority,
          request_signature,
          response_sequence,
          source_fixture
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          rule.label || `rule_${rule.index || 0}`,
          1,
          Number(rule.index || 100),
          JSON.stringify({
            match: rule.match || {},
            request: rule.request || {},
          }),
          JSON.stringify(rule.responses || []),
          sourceFixture,
        ]
      );
    }
  } finally {
    await pool.end();
  }

  return rules.length;
}

async function main() {
  const args = parseArgs();
  const inserted = await importInteractionRules(args.fixture);
  console.log(`Inserted ${inserted} interaction rules into MySQL.`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
