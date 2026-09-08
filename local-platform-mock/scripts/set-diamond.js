const { createPool } = require("../db");

function parseAmount(value) {
  const amount = Number(value || "1000000");
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Expected a non-negative safe integer diamond amount.");
  }
  return amount;
}

async function main() {
  const amount = parseAmount(process.argv[2]);
  const playerUid = process.argv[3] || "";
  const pool = createPool();

  try {
    const playerFilter = playerUid ? " WHERE player_uid = ?" : "";
    const playerParams = playerUid ? [playerUid] : [];
    const [players] = await pool.execute(
      `SELECT id, player_uid FROM players${playerFilter} ORDER BY id`,
      playerParams
    );

    if (players.length === 0) {
      throw new Error(playerUid ? `Player not found: ${playerUid}` : "No players found.");
    }

    const playerIds = players.map((player) => player.id);
    await pool.query("UPDATE players SET diamond = ? WHERE id IN (?)", [amount, playerIds]);

    for (const player of players) {
      await pool.execute(
        `INSERT INTO inventory_items (player_id, item_id, quantity, extra_json)
         VALUES (?, 'diamond', ?, JSON_OBJECT('source', 'manual_set_diamond'))
         ON DUPLICATE KEY UPDATE
           quantity = VALUES(quantity),
           extra_json = VALUES(extra_json),
           updated_at = CURRENT_TIMESTAMP`,
        [player.id, amount]
      );
    }

    console.log(
      JSON.stringify(
        {
          diamond: amount,
          players_updated: players.length,
          player_uids: players.map((player) => player.player_uid),
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
