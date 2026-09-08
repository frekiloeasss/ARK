const path = require("node:path");
const {
  DEFAULT_DB_NAME,
  createBootstrapConnection,
  createPool,
  ensureDatabase,
  getDbConfig,
  readJson,
  runSchema,
  upsertJson,
} = require("./index");

async function main() {
  const config = getDbConfig({ ignoreUrl: true });
  const databaseName = config.database || DEFAULT_DB_NAME;
  const bootstrapConnection = await createBootstrapConnection();

  try {
    await ensureDatabase(bootstrapConnection, databaseName);
    await bootstrapConnection.changeUser({ database: databaseName });
    await runSchema(bootstrapConnection);
    const [legacyPreviewColumns] = await bootstrapConnection.query(
      "SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE FROM information_schema.columns WHERE table_schema=? AND ((table_name='request_logs' AND column_name IN ('request_body_preview','response_body_preview')) OR (table_name='ws_frame_logs' AND column_name='payload_preview'))",
      [databaseName]
    );
    for (const column of legacyPreviewColumns) {
      if (String(column.DATA_TYPE).toLowerCase() === "mediumblob") continue;
      await bootstrapConnection.query(`ALTER TABLE \`${column.TABLE_NAME}\` MODIFY COLUMN \`${column.COLUMN_NAME}\` MEDIUMBLOB NULL`);
    }
    const [sdkPasswordColumns] = await bootstrapConnection.query(
      "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=? AND table_name='local_credentials' AND column_name='sdk_password_hash'",
      [databaseName]
    );
    if (!sdkPasswordColumns.length) {
      await bootstrapConnection.query("ALTER TABLE local_credentials ADD COLUMN sdk_password_hash CHAR(32) NULL AFTER password_hash");
    }
  } finally {
    await bootstrapConnection.end();
  }

  const pool = createPool();
  try {
    const defaultUserStatus = readJson(
      path.join(__dirname, "..", "data", "responses", "user_status.json")
    );
    await upsertJson(pool, "userStatus", defaultUserStatus);
  } finally {
    await pool.end();
  }

  console.log(`MySQL database '${databaseName}' is ready.`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
