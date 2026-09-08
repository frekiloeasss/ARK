const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

const DEFAULT_DB_NAME = "AFK";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseDbUrl(dbUrl) {
  const url = new URL(dbUrl);
  return {
    host: url.hostname || "127.0.0.1",
    port: Number(url.port || "3306"),
    user: decodeURIComponent(url.username || "root"),
    password: decodeURIComponent(url.password || ""),
    database: decodeURIComponent(url.pathname.replace(/^\/+/, "")) || DEFAULT_DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.AFK_DB_CONNECTION_LIMIT || "8"),
    charset: "utf8mb4",
  };
}

function getDbConfig(options = {}) {
  if (process.env.AFK_DB_URL) {
    const urlConfig = parseDbUrl(process.env.AFK_DB_URL);
    const database =
      options.database ||
      process.env.AFK_DB_NAME ||
      process.env.MYSQL_DATABASE ||
      urlConfig.database ||
      DEFAULT_DB_NAME;

    if (options.ignoreUrl) {
      return {
        ...urlConfig,
        database,
      };
    }

    return {
      uri: process.env.AFK_DB_URL,
      database,
    };
  }

  const database =
    options.database ||
    process.env.AFK_DB_NAME ||
    process.env.MYSQL_DATABASE ||
    DEFAULT_DB_NAME;

  return {
    host: process.env.AFK_DB_HOST || process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.AFK_DB_PORT || process.env.MYSQL_PORT || "3306"),
    user: process.env.AFK_DB_USER || process.env.MYSQL_USER || "root",
    password:
      process.env.AFK_DB_PASSWORD ||
      process.env.MYSQL_PASSWORD ||
      process.env.MYSQL_PWD ||
      "",
    database,
    waitForConnections: true,
    connectionLimit: Number(process.env.AFK_DB_CONNECTION_LIMIT || "8"),
    charset: "utf8mb4",
  };
}

function createPool() {
  const config = getDbConfig();
  if (config.uri) {
    return mysql.createPool(config.uri);
  }
  return mysql.createPool(config);
}

async function createBootstrapConnection() {
  const config = getDbConfig({ ignoreUrl: true });
  const { database, connectionLimit, waitForConnections, ...bootstrapConfig } = config;
  return mysql.createConnection(bootstrapConfig);
}

async function ensureDatabase(connection, databaseName = DEFAULT_DB_NAME) {
  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${databaseName}\` ` +
      "DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci"
  );
}

async function runSchema(connection) {
  const schemaPath = path.join(__dirname, "schema.mysql.sql");
  const statements = fs
    .readFileSync(schemaPath, "utf8")
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await connection.query(statement);
  }
}

async function upsertJson(pool, stateKey, value) {
  await pool.execute(
    "INSERT INTO kv_state (state_key, state_value) VALUES (?, ?) " +
      "ON DUPLICATE KEY UPDATE state_value = VALUES(state_value)",
    [stateKey, JSON.stringify(value)]
  );
}

async function getJson(pool, stateKey) {
  const [rows] = await pool.execute(
    "SELECT state_value FROM kv_state WHERE state_key = ? LIMIT 1",
    [stateKey]
  );
  if (rows.length === 0) {
    return null;
  }
  const value = rows[0].state_value;
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function insertRequestLog(pool, record) {
  await pool.execute(
    `INSERT INTO request_logs (
      request_id,
      time,
      method,
      local_path,
      local_query,
      original_host,
      original_scheme,
      action,
      upstream_url,
      status_code,
      duration_ms,
      request_body_preview,
      response_body_preview,
      record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.request_id,
      record.time ? new Date(record.time) : new Date(),
      record.method || "",
      record.local_path || "",
      record.local_query || null,
      record.original_host || null,
      record.original_scheme || null,
      record.action || null,
      record.upstream_url || null,
      Number.isInteger(record.status_code) ? record.status_code : null,
      Number.isInteger(record.duration_ms) ? record.duration_ms : null,
      record.request_body_preview || null,
      record.response_body_preview || null,
      JSON.stringify(record),
    ]
  );
}

async function insertWsFrameLog(pool, record) {
  const requestSignature = record.request_signature || {};
  const responseSignature = record.response_signature || {};
  const signature = Object.keys(requestSignature).length ? requestSignature : responseSignature;
  const route =
    record.request_kind ||
    signature.kind ||
    record.interaction_rule ||
    record.fixture_label ||
    null;
  const sequenceId =
    record.request_seq ||
    signature.seq ||
    responseSignature.seq ||
    null;

  await pool.execute(
    `INSERT INTO ws_frame_logs (
      time,
      session_id,
      direction,
      opcode,
      route,
      sequence_id,
      payload_preview,
      frame_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.ts ? new Date(record.ts) : null,
      record.session_id == null ? null : String(record.session_id),
      record.direction || null,
      record.message_type || null,
      route,
      sequenceId,
      record.text || record.base64 || null,
      JSON.stringify(record),
    ]
  );
}

async function closePool(pool) {
  if (pool) {
    await pool.end();
  }
}

module.exports = {
  DEFAULT_DB_NAME,
  closePool,
  createBootstrapConnection,
  createPool,
  ensureDatabase,
  getDbConfig,
  getJson,
  insertRequestLog,
  insertWsFrameLog,
  readJson,
  runSchema,
  upsertJson,
};
