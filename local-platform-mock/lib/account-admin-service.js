const { createHash, randomBytes, scryptSync, timingSafeEqual, randomUUID } = require("node:crypto");

function validateUsername(value) {
  const username = String(value || "").trim();
  if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) throw Object.assign(new Error("invalid_username"), { status: 422 });
  return username;
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 8 || password.length > 128) throw Object.assign(new Error("invalid_password"), { status: 422 });
  return password;
}

function passwordDigest(password, salt) {
  return scryptSync(String(password), Buffer.from(salt, "hex"), 64).toString("hex");
}

function sdkPasswordDigest(password) {
  return createHash("md5").update(`${String(password)}PassHandler`, "utf8").digest("hex");
}

function makeCredential(password) {
  const salt = randomBytes(16).toString("hex");
  const validated = validatePassword(password);
  return { salt, hash: passwordDigest(validated, salt), sdkHash: sdkPasswordDigest(validated) };
}

function verifyCredential(password, salt, expectedHash) {
  const actual = Buffer.from(passwordDigest(password, salt), "hex");
  const expected = Buffer.from(String(expectedHash), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function registerAccount(pool, input = {}) {
  const username = validateUsername(input.username);
  const role = new Set(["player", "gm", "admin"]).has(input.role) ? input.role : "player";
  const credential = makeCredential(input.password);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO accounts (provider, provider_uid, display_name) VALUES ('local_password', ?, ?)`,
      [username.toLowerCase(), String(input.display_name || username).slice(0, 191)]
    );
    const [rows] = await connection.execute("SELECT id FROM accounts WHERE provider='local_password' AND provider_uid=?", [username.toLowerCase()]);
    const accountId = rows[0].id;
    await connection.execute("INSERT INTO local_credentials (account_id, password_salt, password_hash, sdk_password_hash, role) VALUES (?, ?, ?, ?, ?)", [accountId, credential.salt, credential.hash, credential.sdkHash, role]);
    const playerUid = `local-account:${accountId}`;
    await connection.execute("INSERT INTO players (account_id, player_uid, nickname, profile_json) VALUES (?, ?, ?, ?)", [accountId, playerUid, String(input.display_name || username).slice(0, 191), JSON.stringify({ source: "local_registration" })]);
    await connection.commit();
    return { ok: true, account_id: accountId, player_uid: playerUid, username, role };
  } catch (error) {
    await connection.rollback();
    if (error.code === "ER_DUP_ENTRY") return { ok: false, status: 409, error: "account_exists" };
    throw error;
  } finally {
    connection.release();
  }
}

async function loginAccount(pool, input = {}) {
  const username = validateUsername(input.username).toLowerCase();
  const password = validatePassword(input.password);
  const [rows] = await pool.execute(
    `SELECT a.id, a.display_name, c.password_salt, c.password_hash, c.sdk_password_hash, c.role, c.banned_until, c.ban_reason,
            p.id AS player_id, p.player_uid
       FROM accounts a JOIN local_credentials c ON c.account_id=a.id
       LEFT JOIN players p ON p.account_id=a.id
      WHERE a.provider='local_password' AND a.provider_uid=? LIMIT 1`, [username]
  );
  const row = rows[0];
  const suppliedSdkHash = Boolean(input.password_is_sdk_hash) && /^[a-f0-9]{32}$/i.test(password);
  const sdkMatches = suppliedSdkHash && row?.sdk_password_hash
    ? timingSafeEqual(Buffer.from(password.toLowerCase(), "hex"), Buffer.from(String(row.sdk_password_hash).toLowerCase(), "hex"))
    : false;
  if (!row || (!sdkMatches && !verifyCredential(password, row.password_salt, row.password_hash))) return { ok: false, status: 401, error: "invalid_credentials" };
  if (row.banned_until && new Date(row.banned_until).getTime() > Date.now()) return { ok: false, status: 403, error: "account_banned", banned_until: row.banned_until, reason: row.ban_reason };
  const token = `local-auth:${randomUUID()}`;
  await pool.execute("INSERT INTO sessions (account_id, session_token, status, client_ip, user_agent, expires_at) VALUES (?, ?, 'active', ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))", [row.id, token, input.client_ip || "local", input.user_agent || "local-platform-mock"]);
  await pool.execute("UPDATE local_credentials SET last_login_at=NOW() WHERE account_id=?", [row.id]);
  return { ok: true, token, account_id: row.id, player_id: row.player_id, player_uid: row.player_uid, display_name: row.display_name, role: row.role, expires_in: 604800 };
}

async function authenticateToken(pool, token, roles = []) {
  if (!token) return null;
  const [rows] = await pool.execute(
    `SELECT s.account_id, a.provider_uid, a.display_name, c.role, p.id AS player_id, p.player_uid
       FROM sessions s JOIN local_credentials c ON c.account_id=s.account_id
       JOIN accounts a ON a.id=s.account_id
       LEFT JOIN players p ON p.account_id=s.account_id
      WHERE s.session_token=? AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>NOW()) LIMIT 1`, [token]
  );
  const identity = rows[0] || null;
  if (!identity || (roles.length && !roles.includes(identity.role))) return null;
  return identity;
}

async function audit(pool, identity, action, targetPlayerId, payload, result) {
  await pool.execute("INSERT INTO gm_audit_logs (gm_account_id, action, target_player_id, payload_json, result_json) VALUES (?, ?, ?, ?, ?)", [identity?.account_id || null, String(action), targetPlayerId || null, JSON.stringify(payload || {}), JSON.stringify(result || {})]);
}

module.exports = { audit, authenticateToken, loginAccount, makeCredential, passwordDigest, registerAccount, sdkPasswordDigest, validatePassword, validateUsername, verifyCredential };
