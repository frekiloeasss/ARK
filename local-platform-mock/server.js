const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { createHash, randomUUID } = require("node:crypto");
const { buildPlatformCurrencyMonitor } = require("./lib/platform-currency-monitor");
const { observedHeroUpgrade, taskBatchClaim, tavernDraw } = require("./lib/official-game-service");
const { gameAction } = require("./lib/game-systems-service");
const guildDomain = require("./lib/guild-domain-service");
const { enemyTeam, finishAuthoritativeBattle, startAuthoritativeBattle } = require("./lib/authoritative-battle-service");
const { audit, authenticateToken, loginAccount, makeCredential, registerAccount } = require("./lib/account-admin-service");
const { periodInfo, runDueResets } = require("./lib/liveops-service");
const { battleEvidence, listConfigs } = require("./lib/official-config-catalog");
const { catalogSummary, executeSystemAction, moduleInfo } = require("./lib/universal-system-service");
const { catalog: paymentCatalog, confirmOrder, createOrder, purchaseNow } = require("./lib/sandbox-payment-service");
const { arenaOpponents, botBattleRecords, botChatReply, botGuildMembers, botGuilds, getBot, recordBotBattle, seedBotChat, seedBotEcosystem } = require("./lib/bot-ecosystem-service");
const {
  attachMercenaryHeroes,
  chatMessages,
  executeSocialProtocolAction,
  gift: executeFriendGift,
  rankings: socialRankings,
  sendChat,
  settleMercenary,
  socialSnapshot,
  summaries: socialSummaries,
  useMercenary,
} = require("./lib/social-service");
const {
  calculateIdleAssets,
  calculateConfiguredIdleAssets,
  campaignBattleResult,
  claimIdleRewards,
} = require("./lib/gameplay-service");
const {
  DEFAULT_DB_NAME,
  closePool,
  createPool,
  getJson,
  insertRequestLog,
  insertWsFrameLog,
  upsertJson,
} = require("./db");

function getCliArg(name) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[index + 1];
}

const HOST = getCliArg("host") || process.env.AFK_MOCK_HOST || "127.0.0.1";
const PORT = Number(
  getCliArg("port") || process.env.AFK_MOCK_PORT || "18080"
);
const HTTPS_PORT = Number(
  getCliArg("https-port") || process.env.AFK_MOCK_HTTPS_PORT || "0"
);
const HTTPS_KEY_FILE =
  getCliArg("https-key-file") || process.env.AFK_MOCK_HTTPS_KEY_FILE || "";
const HTTPS_CERT_FILE =
  getCliArg("https-cert-file") || process.env.AFK_MOCK_HTTPS_CERT_FILE || "";
const PROXY_UNKNOWN =
  (getCliArg("proxy-unknown") || process.env.AFK_PROXY_UNKNOWN || "1") !== "0";
const LOCAL_BASE_URL =
  getCliArg("local-base-url") || process.env.AFK_LOCAL_BASE_URL || "http://192.168.3.4:18080";
const SDK_BASE_URL =
  getCliArg("sdk-base-url") || process.env.AFK_SDK_BASE_URL || LOCAL_BASE_URL;
const DISABLE_SDK_SLS =
  (getCliArg("disable-sdk-sls") || process.env.AFK_DISABLE_SDK_SLS || "1") !==
  "0";
const DISABLE_AUTO_LOGIN =
  (getCliArg("disable-auto-login") || process.env.AFK_DISABLE_AUTO_LOGIN || "0") ===
  "1";
const DB_ENABLED =
  (getCliArg("db-enabled") || process.env.AFK_DB_ENABLED || "1") !== "0";
const CLIENT_MAX_CAMPAIGN_STAGE = (() => {
  const value = Number(process.env.AFK_CLIENT_MAX_CAMPAIGN_STAGE || 3232);
  return Number.isSafeInteger(value) && value > 0 ? value : 3232;
})();
const PARKWAY_ENV_ID = "prodf77cc4944d7a6ad7ccc665f84ba6";
const FORCE_DIAMOND_ARG = getCliArg("force-diamond");
const INITIAL_FORCED_DIAMOND = parseOptionalNonNegativeSafeInteger(
  FORCE_DIAMOND_ARG !== null ? FORCE_DIAMOND_ARG : process.env.AFK_FORCE_DIAMOND
);

const DATA_DIR = path.join(__dirname, "data");
const LOG_DIR = path.join(__dirname, "logs");
const REQUEST_LOG = path.join(LOG_DIR, "requests.jsonl");
const WS_FRAME_LOG = path.join(LOG_DIR, "ws-frames.jsonl");
const GM_UI_DIR = path.join(__dirname, "gm-console");
const PUBLIC_CLIENT_APK = path.join(
  __dirname,
  "runtime",
  "public-client-build",
  "AFK-Private-1.201.01-arm64.apk"
);

fs.mkdirSync(LOG_DIR, { recursive: true });

const parkwayConfigSnapshot = readJson(
  path.join(DATA_DIR, "parkway", `${PARKWAY_ENV_ID}.json`)
);
const parkwayReportSnapshot = readJson(
  path.join(DATA_DIR, "parkway", `${PARKWAY_ENV_ID}_report.json`)
);
const userAgreementSnapshot = readJson(
  path.join(DATA_DIR, "responses", "user_agreement.json")
);
const defaultUserStatus = readJson(
  path.join(DATA_DIR, "responses", "user_status.json")
);

const state = {
  userStatus: clone(defaultUserStatus),
  localAccount: null,
  overrides: {
    forcedDiamond: INITIAL_FORCED_DIAMOND,
  },
  business: {
    nextAccountId: 1,
    nextPlayerId: 1,
    nextSessionId: 1,
    player: null,
    inventory: [],
    characters: [],
    stages: [],
    sessions: [],
  },
};

let dbPool = null;
let dbReady = false;
let dbErrorMessage = null;
const activeMemoryBattles = new Map();
const runtimeMetrics = { startedAt: Date.now(), requests: 0, errors: 0, rateLimited: 0 };
const rateWindows = new Map();

const EMPTY_OK = Buffer.from("{}", "utf8");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeHost(hostHeader) {
  return String(hostHeader || "")
    .trim()
    .replace(/:\d+$/, "")
    .toLowerCase();
}

function isLocalMockHost(host) {
  const normalized = normalizeHost(host);
  const localBaseHost = (() => {
    try {
      return normalizeHost(new URL(LOCAL_BASE_URL).host);
    } catch {
      return "";
    }
  })();
  return (
    normalized === normalizeHost(HOST) ||
    normalized === localBaseHost ||
    normalized === "127.0.0.1" ||
    normalized === "localhost"
  );
}

function previewText(input, maxLength = 1200) {
  if (!input) {
    return null;
  }

  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input);
  if (!text) {
    return null;
  }

  if (text.length > maxLength) {
    return `${text.slice(0, maxLength)}...<truncated>`;
  }

  return text;
}

function logRecord(record) {
  fs.appendFileSync(
    REQUEST_LOG,
    `${JSON.stringify(record, null, 0)}\n`,
    "utf8"
  );
}

async function initializeDb() {
  if (!DB_ENABLED) {
    return;
  }

  try {
    dbPool = createPool();
    await dbPool.query("SELECT 1");

    const storedUserStatus = await getJson(dbPool, "userStatus");
    if (storedUserStatus && typeof storedUserStatus === "object") {
      state.userStatus = storedUserStatus;
    } else {
      await upsertJson(dbPool, "userStatus", state.userStatus);
    }

    dbReady = true;
    dbErrorMessage = null;
    const adminUsername = process.env.AFK_ADMIN_USER || "admin";
    const [adminRows] = await dbPool.execute(
      "SELECT id FROM accounts WHERE provider='local_password' AND provider_uid=? LIMIT 1",
      [adminUsername.toLowerCase()]
    );
    if (!adminRows.length) {
      await registerAccount(dbPool, {
        username: adminUsername,
        password: process.env.AFK_ADMIN_PASSWORD || "afk-admin-local",
        display_name: "AFK Administrator",
        role: "admin",
      });
    } else if (process.env.AFK_ROTATE_BOOTSTRAP_ADMIN === "1" && process.env.AFK_ADMIN_PASSWORD) {
      const credential = makeCredential(process.env.AFK_ADMIN_PASSWORD);
      await dbPool.execute(
        "UPDATE local_credentials SET password_salt=?,password_hash=?,sdk_password_hash=?,role='admin' WHERE account_id=?",
        [credential.salt, credential.hash, credential.sdkHash, adminRows[0].id]
      );
    }
    await seedLocalLiveops();
    await seedBotEcosystem(dbPool);
    await seedBotChat(dbPool);
  } catch (error) {
    dbReady = false;
    dbErrorMessage = String(error && error.message ? error.message : error);
    if (dbPool) {
      await closePool(dbPool).catch(() => {});
      dbPool = null;
    }
    console.error(`[mysql] unavailable, using in-memory fallback: ${dbErrorMessage}`);
  }
}

async function seedLocalLiveops() {
  const now = new Date();
  const starts = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const ends = new Date(starts); ends.setUTCDate(ends.getUTCDate() + 28);
  const templates = [
    ["daily_login", "ActivityConfig", "每日登录"], ["battle_pass", "BattlePassConfig", "勇者战令"],
    ["trial", "TrialConfigure", "英雄试炼"], ["world_boss", "ActivityRankBossConfig", "世界首领"],
    ["infinite_pve", "InfinitePVEFloor", "乱时之境"], ["act_fish", "ActFishConfig", "垂钓活动"],
    ["act_cook", "ActCookConfig", "烹饪活动"], ["act_guild_box", "ActGuildBoxConfig", "公会宝箱"],
  ];
  await dbPool.execute("DELETE FROM liveops_instances WHERE activity_key='guild_box'");
  const existingKeys = new Set(templates.map((entry) => entry[0]));
  for (const module of catalogSummary().modules) {
    if (!/^(?:act_|activity|daily_login|battle_pass|trial|raid|infinite|curseland|world_boss|side_story|dream|camp_pvp|cof|gvg|guild_trial|hero_benefit|hero_return|perman_login|monthly_card|hyper_hero|contra_benefit)/.test(module.module) || existingKeys.has(module.module)) continue;
    templates.push([module.module, module.configs[0] || null, module.module.replaceAll("_", " ")]); existingKeys.add(module.module);
  }
  for (const [key, table, title] of templates) {
    await dbPool.execute(
      `INSERT INTO liveops_instances (activity_key,config_table,title,starts_at,ends_at,claim_ends_at,status,rules_json)
       VALUES (?,?,?,?,?,DATE_ADD(?,INTERVAL 7 DAY),'active',?)
       ON DUPLICATE KEY UPDATE
         config_table=VALUES(config_table),title=VALUES(title),
         starts_at=IF(status<>'paused' AND ends_at<NOW(),VALUES(starts_at),starts_at),
         claim_ends_at=IF(status<>'paused' AND ends_at<NOW(),VALUES(claim_ends_at),claim_ends_at),
         rules_json=IF(status<>'paused' AND ends_at<NOW(),VALUES(rules_json),rules_json),
         status=IF(status<>'paused' AND ends_at<NOW(),'active',status),
         ends_at=IF(status<>'paused' AND ends_at<NOW(),VALUES(ends_at),ends_at)`,
      [key, table, title, starts, ends, ends, JSON.stringify({ cycle: "local_28_day", source: "official_client_config_local_schedule", timezone: "Asia/Shanghai" })]
    );
  }
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

async function requireIdentity(req, res, roles = []) {
  if (!dbReady || !dbPool) {
    sendJson(res, 503, { error: "db_unavailable" });
    return null;
  }
  const identity = await authenticateToken(dbPool, bearerToken(req), roles);
  if (!identity) sendJson(res, 401, { error: "unauthorized" });
  return identity;
}

async function persistUserStatus() {
  if (!dbReady || !dbPool) {
    return;
  }

  try {
    await upsertJson(dbPool, "userStatus", state.userStatus);
  } catch (error) {
    dbErrorMessage = String(error && error.message ? error.message : error);
    console.error(`[mysql] failed to persist userStatus: ${dbErrorMessage}`);
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const bodyBuffer = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bodyBuffer.length),
    "x-afk-mock": "local-platform-mock",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(bodyBuffer);
}

function sendBuffer(res, statusCode, bodyBuffer, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-length": String(bodyBuffer.length),
    "x-afk-mock": "local-platform-mock",
    ...extraHeaders,
  });
  res.end(bodyBuffer);
}

function sendGmAsset(res, name) {
  const safeName = { "/gm-ui/": "index.html", "/gm-ui/index.html": "index.html", "/gm-ui/styles.css": "styles.css", "/gm-ui/app.js": "app.js" }[name];
  if (!safeName) return false;
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  sendBuffer(res, 200, fs.readFileSync(path.join(GM_UI_DIR, safeName)), {
    "content-type": types[path.extname(safeName)], "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'",
    "x-content-type-options": "nosniff", "x-frame-options": "DENY",
  });
  return true;
}

function rateLimit(req, pathname) {
  if (!pathname.startsWith("/__afk/")) return null;
  const now = Date.now(), windowMs = 60000;
  const remote = String(req.socket.remoteAddress || "unknown");
  const sensitive = pathname.startsWith("/__afk/accounts/") || pathname.startsWith("/__afk/gm/") || pathname.startsWith("/__afk/payments/");
  const limit = sensitive ? Number(process.env.AFK_SENSITIVE_RATE_LIMIT || 60) : Number(process.env.AFK_API_RATE_LIMIT || 600);
  const key = `${remote}:${sensitive ? "sensitive" : "api"}`;
  let bucket = rateWindows.get(key); if (!bucket || now - bucket.started >= windowMs) bucket = { started: now, count: 0 };
  bucket.count += 1; rateWindows.set(key, bucket);
  if (rateWindows.size > 10000) for (const [entryKey, value] of rateWindows) if (now - value.started >= windowMs * 2) rateWindows.delete(entryKey);
  return bucket.count > limit ? { retryAfter: Math.max(1, Math.ceil((windowMs - (now - bucket.started)) / 1000)), remote, limit } : null;
}

function isSinkHost(host) {
  return (
    host === "mock-client-sdk.mock.invalid" ||
    host === "f.l01.sharesrc.cyou" ||
    host === "graph.facebook.com"
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseOptionalNonNegativeSafeInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    console.warn(
      `[override] ignored invalid forced diamond amount: ${JSON.stringify(value)}`
    );
    return null;
  }

  return amount;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneBusinessStatePayload(payload) {
  return {
    player: payload && payload.player ? { ...payload.player } : null,
    inventory: Array.isArray(payload?.inventory)
      ? payload.inventory.map((item) => ({ ...item }))
      : [],
    characters: Array.isArray(payload?.characters)
      ? payload.characters.map((character) => ({ ...character }))
      : [],
    stages: Array.isArray(payload?.stages)
      ? payload.stages.map((stage) => ({ ...stage }))
      : [],
  };
}

function applyServerOverridesToBusinessState(payload) {
  const forcedDiamond = state.overrides.forcedDiamond;
  if (!Number.isSafeInteger(forcedDiamond) || forcedDiamond < 0) {
    return payload;
  }

  const overridden = cloneBusinessStatePayload(payload || {});
  const updatedAt = nowIso();
  if (overridden.player) {
    overridden.player.diamond = forcedDiamond;
    overridden.player.updated_at = updatedAt;
  }

  let diamond = overridden.inventory.find((item) => item.item_id === "diamond");
  if (!diamond) {
    diamond = {
      item_id: "diamond",
      quantity: forcedDiamond,
      extra_json: {},
      updated_at: updatedAt,
    };
    overridden.inventory.push(diamond);
  }

  diamond.quantity = forcedDiamond;
  diamond.updated_at = updatedAt;
  diamond.extra_json = {
    ...(isPlainObject(diamond.extra_json) ? diamond.extra_json : {}),
    source: "server_forced_diamond",
    server_override: true,
  };

  return overridden;
}

function parseRequestPayload(context) {
  const text = context.bodyBuffer ? context.bodyBuffer.toString("utf8") : "";
  if (!text) {
    return {};
  }

  const json = safeParseJson(text);
  if (json && typeof json === "object") {
    return json;
  }

  const params = new URLSearchParams(text);
  const payload = {};
  for (const [key, value] of params.entries()) {
    payload[key] = value;
  }
  return payload;
}

function firstStringValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function deriveLocalAccountInput(payload) {
  return firstStringValue(
    payload.account,
    payload.username,
    payload.user_name,
    payload.login_name,
    payload.email,
    payload.mobile,
    payload.phone,
    payload.uid,
    payload.app_uid,
    payload.open_id,
    payload.openid,
    payload.tempid,
    payload.temp_id
  ) || "local-account";
}

function buildLocalAccountSession(payload = {}, overrides = {}) {
  const loginName = String(overrides.account || deriveLocalAccountInput(payload)).toLowerCase();
  const digest = createHash("sha256")
    .update(`${loginName}:${PARKWAY_ENV_ID}`)
    .digest("hex");
  const appUid = `local-${digest.slice(0, 24)}`;
  // Lilith SDK 7.x deserializes app_uid into a Java long. Keep the stable
  // string id for our own account model, and expose this bounded numeric id
  // in the v2 SDK response below.
  const numericAppUid = Number.parseInt(digest.slice(0, 12), 16);
  const ticket = String(overrides.ticket || `local-ticket-${digest.slice(0, 32)}`);
  const now = Math.floor(Date.now() / 1000);

  return {
    app_uid: appUid,
    numeric_app_uid: numericAppUid,
    uid: appUid,
    open_id: appUid,
    account: loginName,
    nickname: String(overrides.nickname || (loginName === "local-account" ? "local player" : loginName)),
    ticket,
    ticketid: ticket,
    last_ticketid: ticket,
    token: ticket,
    access_token: ticket,
    htoken: ticket,
    expires_in: 86400,
    expire_time: now + 86400,
    created_at: now,
  };
}

function buildLocalAccountLoginResponse(context, authenticatedSession = null) {
  const payload = parseRequestPayload(context);
  const pass = firstStringValue(payload.pass, payload.token, payload.app_token, payload.access_token);
  const session = authenticatedSession || (state.localAccount && pass && state.localAccount.ticket === pass
    ? state.localAccount : buildLocalAccountSession(payload));
  const defaultRouter = "app";
  const user = {
    ID: 1,
    id: 1,
    uuid: session.uid,
    uid: session.uid,
    app_uid: session.app_uid,
    open_id: session.open_id,
    userName: session.account,
    username: session.account,
    nickName: session.nickname,
    nickname: session.nickname,
    headerImg: "",
    authorityId: "local-player",
    authority: {
      authorityId: "local-player",
      authorityName: "Local Player",
      defaultRouter,
    },
  };
  state.localAccount = session;
  state.userStatus = {
    ...state.userStatus,
    app_uid: session.app_uid,
    last_ticketid: session.last_ticketid,
    need_loop: false,
    unack_num: 0,
  };
  persistUserStatus();

  // SDK 7.16 parses /v2/api/sdk/login through UserPropertyConversion. Those
  // fields live directly under `data` (not inside an account/session object),
  // and several values are non-null Java primitives used immediately after
  // deserialization. Snake-case is the wire format used by the SDK API; the
  // camel-case aliases make the mock tolerant of SDK builds without the Gson
  // field-name annotations.
  const identity = {
    is_rn: true,
    isRn: true,
    is_adult: true,
    isAdult: true,
    is_auto_rn: false,
    isAutoRn: false,
    can_play: true,
    canPlay: true,
    age_level: 4,
    ageLevel: 4,
    phone_verify: true,
    phoneVerify: true,
  };
  const chargeLimit = {
    is_safe: 1,
    isSafe: 1,
    limit_devices: 0,
    limitDevices: 0,
  };
  const sdkData = {
    uid: session.numeric_app_uid,
    app_uid: session.numeric_app_uid,
    appUid: session.numeric_app_uid,
    app_token: session.ticket,
    appToken: session.ticket,
    access_token: session.ticket,
    accessToken: session.ticket,
    open_id: session.open_id,
    openId: session.open_id,
    gm_openid: `gm-${session.numeric_app_uid}`,
    gmOpenid: `gm-${session.numeric_app_uid}`,
    svr_time: session.created_at,
    svrTime: session.created_at,
    is_reg: false,
    isReg: false,
    need_bind_account: false,
    isNeedBindAccount: false,
    identity,
    rest_points: 0,
    restPoints: 0,
    bindings: [],
    lilith_bindings: [],
    lilithBindings: [],
    charge_limit: chargeLimit,
    chargeLimit,
    region: "CN",
    sdk_region: "CN",
    sdkRegion: "CN",
    ip: "127.0.0.1",
    ip_region: { city_name: "Local", country_name: "CN" },
    ipRegion: { cityName: "Local", countryName: "CN" },
    silence_heartbeat: true,
    silenceHeartbeat: true,
  };

  return {
    ...session,
    code: 0,
    msg: "success",
    message: "success",
    user,
    defaultRouter,
    result: {
      code: 0,
      msg: "success",
      action: "",
      attach: 1,
    },
    data: {
      ...sdkData,
      ...session,
      // Preserve the numeric value after spreading the internal string id.
      uid: session.numeric_app_uid,
      app_uid: session.numeric_app_uid,
      appUid: session.numeric_app_uid,
      token: session.token,
      user,
      account: {
        uid: session.uid,
        app_uid: session.app_uid,
        open_id: session.open_id,
        nickname: session.nickname,
        account: session.account,
      },
      defaultRouter,
    },
  };
}

function localAccountPassword(payload) {
  const explicit = firstStringValue(payload.password, payload.passwd, payload.pwd);
  if (explicit) return explicit;
  const pass = firstStringValue(payload.pass);
  return pass && !/^(?:local-ticket-|local-auth:)/.test(pass) ? pass : "";
}

async function buildAuthenticatedLocalAccountLoginResponse(context) {
  const payload = parseRequestPayload(context);
  const requestedName = deriveLocalAccountInput(payload).toLowerCase();
  const password = localAccountPassword(payload);
  const sdkTicket = firstStringValue(payload.pass, payload.ticket, payload.ticketid, payload.token);
  if (/^local-auth:/.test(sdkTicket) && dbReady && dbPool) {
    const identity = await authenticateToken(dbPool, sdkTicket);
    if (identity) {
      const session = buildLocalAccountSession(payload, {
        account: identity.provider_uid,
        nickname: identity.display_name,
        ticket: sdkTicket,
      });
      return buildLocalAccountLoginResponse(context, session);
    }
  }
  const passwordIsSdkHash = !firstStringValue(payload.password, payload.passwd, payload.pwd)
    && /^[a-f0-9]{32}$/i.test(firstStringValue(payload.pass));
  if (requestedName === "local-account" || !password) return buildLocalAccountLoginResponse(context);
  if (!dbReady || !dbPool) {
    return { code: 1, msg: "账号服务尚未启动", message: "account service unavailable", result: { code: 1, msg: "账号服务尚未启动", action: "", attach: 0 }, data: {} };
  }
  const candidates = [requestedName];
  if (requestedName.endsWith("@test.local")) candidates.push(requestedName.slice(0, -"@test.local".length));
  let login = null;
  let resolvedName = requestedName;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const result = await loginAccount(dbPool, { username: candidate, password, password_is_sdk_hash: passwordIsSdkHash, client_ip: context.req?.socket?.remoteAddress || "sdk", user_agent: context.req?.headers?.["user-agent"] || "lilith-sdk" });
      if (result.ok) { login = result; resolvedName = candidate; break; }
    } catch (error) {
      if (!error.status) throw error;
    }
  }
  if (!login) {
    return { code: 1, msg: "账号或密码错误", message: "invalid credentials", result: { code: 1, msg: "账号或密码错误", action: "", attach: 0 }, data: {} };
  }
  const session = buildLocalAccountSession(payload, { account: resolvedName, nickname: login.display_name, ticket: login.token });
  return buildLocalAccountLoginResponse(context, session);
}

function isPlatformLoginHost(host) {
  return (
    host === "account-global.lilith.com" ||
    host === "park-m-global.lilith.com" ||
    host === "app.lilithgame.com" ||
    host === "app-global.lilithgame.com" ||
    host === "app-global-1.lilithgame.com" ||
    host === "app-global-2.lilithgame.com"
  );
}

function isLocalAccountLoginPath(pathname) {
  const normalized = pathname.toLowerCase();
  const exactLoginPaths = new Set([
    "/api/agentextend/login",
    "/player/login",
    "/api/player/login",
    "/api/app/applicationsdkcreateresp",
    "/api/app/applicationsdkloginresp",
    "/api/account/login",
  ]);
  if (exactLoginPaths.has(normalized)) {
    return true;
  }

  const loginNeedles = [
    "login",
    "signin",
    "sign_in",
    "register",
    "signup",
    "sign_up",
    "guest",
    "visitor",
    "quick",
    "ticket",
    "bind",
  ];
  return loginNeedles.some((needle) => normalized.includes(needle));
}

function requireDb(res) {
  if (dbReady && dbPool) {
    return true;
  }

  sendJson(res, 503, {
    error: "db_unavailable",
    message: dbErrorMessage || "MySQL is not ready.",
  });
  return false;
}

function nowIso() {
  return new Date().toISOString();
}

function findMemoryInventoryItem(itemId) {
  return state.business.inventory.find((item) => item.item_id === itemId) || null;
}

function findMemoryCharacter(characterId) {
  return state.business.characters.find(
    (character) => character.character_id === characterId
  ) || null;
}

function findMemoryStage(stageId) {
  return state.business.stages.find((stage) => stage.stage_id === stageId) || null;
}

function buildDefaultMemoryCharacters() {
  return [
    ["1", 10, 1, { hero_id: 1, tid: 22, quality: 1, rank: 2, gs: 997, source: "official_login_seed" }],
    ["assist_24230", 12, 1, { assist_uid: 24230, hero_id: 26, avatar: "avatar:102", power: 10000 }],
    ["assist_24238", 9, 1, { assist_uid: 24238, hero_id: 24, avatar: "avatar:102", power: 10000 }],
    ["assist_24249", 8, 1, { assist_uid: 24249, hero_id: 18, avatar: "avatar:102", power: 10000 }],
    ["assist_24261", 10, 1, { assist_uid: 24261, hero_id: 33, avatar: "avatar:102", power: 10000 }],
    ["assist_24270", 17, 1, { assist_uid: 24270, hero_id: 17, avatar: "avatar:102", power: 10000 }],
  ];
}

function upsertMemoryInventoryItem(payload) {
  ensureMemoryBusinessState();
  const itemId = String(payload.item_id || payload.itemId || "");
  if (!itemId) {
    return;
  }

  const quantity = Number(payload.quantity || 0);
  const existing = findMemoryInventoryItem(itemId);
  const record = {
    item_id: itemId,
    quantity: Number.isFinite(quantity) ? quantity : 0,
    extra_json: payload.extra_json || payload.extra || {},
    updated_at: nowIso(),
  };

  if (existing) {
    Object.assign(existing, record);
  } else {
    state.business.inventory.push(record);
  }

  if (itemId === "diamond" && state.business.player) {
    state.business.player.diamond = record.quantity;
    state.business.player.updated_at = record.updated_at;
  }
}

function upsertMemoryCharacter(payload) {
  ensureMemoryBusinessState();
  const characterId = String(payload.character_id || payload.characterId || "");
  if (!characterId) {
    return;
  }

  const existing = findMemoryCharacter(characterId);
  const record = {
    character_id: characterId,
    level: Number(payload.level || 1),
    star: Number(payload.star || 0),
    extra_json: {
      ...(existing?.extra_json || {}),
      ...(payload.extra_json || payload.extra || {}),
    },
    updated_at: nowIso(),
  };

  if (existing) {
    Object.assign(existing, record);
  } else {
    state.business.characters.push(record);
  }
}

function upsertMemoryStageProgress(payload) {
  ensureMemoryBusinessState();
  const stageId = String(payload.stage_id || payload.stageId || "");
  if (!stageId) {
    return;
  }

  const existing = findMemoryStage(stageId);
  const shouldClear = Boolean(payload.cleared ?? true);
  const record = {
    stage_id: stageId,
    best_result_json: {
      ...(existing?.best_result_json || {}),
      ...(payload.best_result_json || payload.bestResult || {}),
    },
    cleared_at: shouldClear ? existing?.cleared_at || nowIso() : existing?.cleared_at || null,
    updated_at: nowIso(),
  };

  if (existing) {
    Object.assign(existing, record);
  } else {
    state.business.stages.push(record);
  }
}

function ensureMemoryBusinessState(seed = {}) {
  if (state.business.player) {
    return state.business;
  }

  const createdAt = nowIso();
  const htoken = seed.htoken || "local-memory-player";
  const accountId = state.business.nextAccountId++;
  const playerId = state.business.nextPlayerId++;
  const playerUid = `local-player:${htoken}`;

  state.business.player = {
    id: playerId,
    account_id: accountId,
    player_uid: playerUid,
    nickname: "local player",
    level: 1,
    exp: 0,
    gold: 0,
    diamond: 1000000,
    profile_json: {
      source: "memory_fallback",
      session_id: seed.session_id || null,
      htoken,
      svr_id: seed.svr_id || null,
      sdk_login_seq: seed.sdk_login_seq || null,
      login_seq: seed.login_seq || null,
      charge_seq: seed.charge_seq || null,
      persisted_at: createdAt,
    },
    created_at: createdAt,
    updated_at: createdAt,
  };

  const seedByItemId = new Map();
  if (Array.isArray(seed.inventory)) {
    for (const item of seed.inventory) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const itemId = String(item.item_id || item.itemId || "");
      if (!itemId) {
        continue;
      }
      seedByItemId.set(itemId, {
        quantity: item.quantity,
        extra: item.extra_json || item.extra || {},
      });
    }
  }

  state.business.inventory = [
    {
      item_id: "gold",
      quantity: inventorySeedQuantity(seedByItemId, "gold", 10000),
      extra_json: inventorySeedExtra(seedByItemId, "gold", { source: "memory_seed" }),
      updated_at: createdAt,
    },
    {
      item_id: "diamond",
      quantity: inventorySeedQuantity(seedByItemId, "diamond", 1000000),
      extra_json: inventorySeedExtra(seedByItemId, "diamond", { source: "memory_seed" }),
      updated_at: createdAt,
    },
    {
      item_id: "diamond_charge",
      quantity: inventorySeedQuantity(seedByItemId, "diamond_charge", 20),
      extra_json: inventorySeedExtra(seedByItemId, "diamond_charge", { source: "memory_seed" }),
      updated_at: createdAt,
    },
    {
      item_id: "stage_ticket",
      quantity: inventorySeedQuantity(seedByItemId, "stage_ticket", 30),
      extra_json: inventorySeedExtra(seedByItemId, "stage_ticket", { source: "memory_seed" }),
      updated_at: createdAt,
    },
    {
      item_id: "hero_exp",
      quantity: inventorySeedQuantity(seedByItemId, "hero_exp", 188992),
      extra_json: inventorySeedExtra(seedByItemId, "hero_exp", { source: "official_login_seed" }),
      updated_at: createdAt,
    },
    {
      item_id: "player_exp",
      quantity: inventorySeedQuantity(seedByItemId, "player_exp", 889),
      extra_json: inventorySeedExtra(seedByItemId, "player_exp", { source: "official_login_seed" }),
      updated_at: createdAt,
    },
    {
      item_id: "item_1",
      quantity: inventorySeedQuantity(seedByItemId, "item_1", 773),
      extra_json: inventorySeedExtra(seedByItemId, "item_1", {
        source: "official_login_seed",
        asset_type: "item",
        asset_id: 1,
      }),
      updated_at: createdAt,
    },
    {
      item_id: "item_13",
      quantity: inventorySeedQuantity(seedByItemId, "item_13", 20),
      extra_json: inventorySeedExtra(seedByItemId, "item_13", {
        source: "memory_seed",
        asset_type: "item",
        asset_id: 13,
      }),
      updated_at: createdAt,
    },
    {
      item_id: "meta_campaign_cur_stage",
      quantity: inventorySeedQuantity(seedByItemId, "meta_campaign_cur_stage", 13),
      extra_json: inventorySeedExtra(seedByItemId, "meta_campaign_cur_stage", { source: "official_login_seed" }),
      updated_at: createdAt,
    },
    {
      item_id: "meta_idle_last_claim_ts",
      quantity: inventorySeedQuantity(
        seedByItemId,
        "meta_idle_last_claim_ts",
        Math.floor(Date.now() / 1000) - 9296
      ),
      extra_json: inventorySeedExtra(seedByItemId, "meta_idle_last_claim_ts", { source: "captured_idle_seed" }),
      updated_at: createdAt,
    },
  ];

  const diamond = findMemoryInventoryItem("diamond");
  if (diamond) {
    state.business.player.diamond = diamond.quantity;
  }

  state.business.characters = [];
  for (const [characterId, level, star, extra] of buildDefaultMemoryCharacters()) {
    upsertMemoryCharacter({
      character_id: characterId,
      level,
      star,
      extra,
    });
  }

  upsertMemoryStageProgress({
    stage_id: "stage_query_assist_summaries",
    best_result_json: {
      source: "memory_seed",
      assist_summary_limit: state.business.characters.length,
    },
    cleared: true,
  });

  return state.business;
}

function getMemoryBusinessState(playerUid = "") {
  ensureMemoryBusinessState();
  if (
    playerUid &&
    state.business.player &&
    state.business.player.player_uid !== playerUid
  ) {
    return applyServerOverridesToBusinessState({
      player: null,
      inventory: [],
      characters: [],
      stages: [],
    });
  }

  return applyServerOverridesToBusinessState({
    player: state.business.player,
    inventory: state.business.inventory,
    characters: state.business.characters,
    stages: state.business.stages,
  });
}

async function findPlayerId(playerUid = "") {
  if (!dbReady || !dbPool) {
    return null;
  }

  if (playerUid) {
    const [rows] = await dbPool.execute(
      "SELECT id FROM players WHERE player_uid = ? LIMIT 1",
      [playerUid]
    );
    return rows.length ? rows[0].id : null;
  }

  const [rows] = await dbPool.execute(
    "SELECT id FROM players ORDER BY updated_at DESC, id DESC LIMIT 1"
  );
  return rows.length ? rows[0].id : null;
}

async function insertSocialEvent(executor, recipientPlayerId, actorPlayerId, eventType, payload = {}) {
  const [result] = await executor.execute(
    "INSERT INTO social_events (recipient_player_id,actor_player_id,event_type,payload_json) VALUES (?,?,?,?)",
    [recipientPlayerId, actorPlayerId || null, String(eventType).slice(0, 64), JSON.stringify(payload)]
  );
  return result.insertId;
}

function privateChatChannel(firstPlayerId, secondPlayerId) {
  const ids = [Number(firstPlayerId), Number(secondPlayerId)].sort((a, b) => a - b);
  return `private:${ids[0]}:${ids[1]}`;
}

async function getBusinessState(playerUid = "") {
  const playerId = await findPlayerId(playerUid);
  if (!playerId) {
    return {
      player: null,
      inventory: [],
      characters: [],
      stages: [],
      liveops: [],
    };
  }

  const [[player], [inventory], [characters], [stages], [liveops]] = await Promise.all([
    dbPool.execute("SELECT * FROM players WHERE id = ? LIMIT 1", [playerId]),
    dbPool.execute(
      "SELECT item_id, quantity, extra_json, updated_at FROM inventory_items WHERE player_id = ? ORDER BY item_id",
      [playerId]
    ),
    dbPool.execute(
      "SELECT character_id, level, star, extra_json, updated_at FROM characters WHERE player_id = ? ORDER BY character_id",
      [playerId]
    ),
    dbPool.execute(
      "SELECT stage_id, best_result_json, cleared_at, updated_at FROM stage_progress WHERE player_id = ? ORDER BY stage_id",
      [playerId]
    ),
    dbPool.execute(
      `SELECT id, activity_key, config_table, title, starts_at, ends_at, claim_ends_at, status, rules_json
       FROM liveops_instances
       WHERE status = 'active' AND starts_at <= NOW() AND ends_at > NOW()
       ORDER BY id`,
    ),
  ]);

  return applyServerOverridesToBusinessState({
    player: player[0] || null,
    inventory,
    characters,
    stages,
    liveops,
  });
}

async function upsertInventoryItemWith(executor, playerId, payload) {
  const itemId = String(payload.item_id || payload.itemId || "");
  const quantity = Number(payload.quantity || 0);
  await executor.execute(
    `INSERT INTO inventory_items (player_id, item_id, quantity, extra_json)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       quantity = VALUES(quantity),
       extra_json = VALUES(extra_json),
       updated_at = CURRENT_TIMESTAMP`,
    [
      playerId,
      itemId,
      quantity,
      JSON.stringify(payload.extra_json || payload.extra || {}),
    ]
  );

  if (itemId === "diamond") {
    await executor.execute("UPDATE players SET diamond = ? WHERE id = ?", [quantity, playerId]);
  }
}

async function upsertInventoryItem(playerId, payload) {
  return upsertInventoryItemWith(dbPool, playerId, payload);
}

const GUILD_ACTIONS = new Set([
  "guild_open", "guild_create", "guild_search", "guild_join", "guild_apply", "guild_applications", "guild_approve",
  "guild_leave", "guild_edit", "guild_disband", "guild_members", "guild_kick", "guild_promote", "guild_demote",
  "guild_transfer", "guild_donate", "guild_shop_open", "guild_shop_buy", "guild_task_info", "guild_task_claim",
  "guild_chat", "guild_rank", "guild_history", "guild_boss_open", "guild_boss_start", "guild_boss_end",
  "guild_boss_final_reward",
]);

function businessMeta(currentState, key, fallback = 0) {
  const row = (currentState.inventory || []).find((item) => String(item.item_id) === `meta_${key}`);
  return row ? Number(row.quantity || 0) : fallback;
}

function guildRuntimeKey(guildId) { return `guild:runtime:${Number(guildId)}`; }

async function seedBotGuildDocument(executor, guildId, nowTs) {
  const [guildRows] = await executor.execute("SELECT guild_id,name,level,notice,capacity FROM bot_guilds WHERE guild_id=? LIMIT 1", [Number(guildId)]);
  if (!guildRows.length) return null;
  const row = guildRows[0], [botRows] = await executor.execute("SELECT bot_id,nickname,level FROM bot_profiles WHERE guild_id=? ORDER BY power DESC,bot_id LIMIT 70", [Number(guildId)]);
  const owner = botRows[0] || { bot_id: 90000000 + Number(guildId), nickname: `${row.name}会长`, level: 240 };
  const ownerUid = `bot:${owner.bot_id}`;
  const document = guildDomain.createDocument({ player: { player_uid: ownerUid, id: Number(owner.bot_id), nickname: owner.nickname, level: Number(owner.level || 240) }, inventory: [] }, {
    guild_id: Number(guildId), name: row.name, notice: row.notice, now_ts: nowTs,
  });
  document.level = Number(row.level || 1); document.capacity = Number(row.capacity || 70); document.members = {};
  const members = botRows.length ? botRows : [owner];
  members.forEach((bot, index) => {
    const uid = `bot:${bot.bot_id}`;
    document.members[uid] = { uid, id: Number(bot.bot_id), name: bot.nickname, level: Number(bot.level || 1), role: index === 0 ? 3 : index < 3 ? 2 : 1, contribution: Math.max(0, 500 - index * 7), weekly_contribution: Math.max(0, 100 - index * 3), donation_day: guildDomain.cycles(nowTs).day, donation_count: index % 4, joined_at: Number(nowTs || Math.floor(Date.now() / 1000)) - (index + 1) * 86400, last_active_at: Number(nowTs || Math.floor(Date.now() / 1000)) - index * 300 };
  });
  document.owner_uid = ownerUid;
  return document;
}

async function handleGuildGameAction(res, payload, playerUid) {
  const playerId = await findPlayerId(playerUid);
  if (!playerId) { sendJson(res, 404, { error: "player_not_found" }); return; }
  let currentState = await getBusinessState(playerUid);
  const op = String(payload.op || ""), currentGuildId = businessMeta(currentState, "guild_id", 0);
  const guildId = op === "guild_create"
    ? Number(payload.guild_id || 1000000 + Number(playerId))
    : Number(payload.guild_id || currentGuildId || 0);
  const actionPayload = { ...payload, guild_id: guildId, player_id: playerId, player_uid: currentState.player?.player_uid || playerUid, player: currentState.player };
  if (["guild_open", "guild_search"].includes(op)) actionPayload.bot_guilds = await botGuilds(dbPool, 20);

  if (op === "guild_search" || (!guildId && op === "guild_open")) {
    const transition = gameAction(currentState, actionPayload);
    sendJson(res, transition.ok ? 200 : transition.status || 409, transition.ok ? { ...transition, businessState: currentState } : transition);
    return;
  }
  if (!guildId) { sendJson(res, 409, { ok: false, error: "not_in_guild" }); return; }

  const connection = await dbPool.getConnection(), lockName = `afk:guild:${guildId}`;
  let transactionStarted = false;
  try {
    const [lockRows] = await connection.execute("SELECT GET_LOCK(?,5) AS acquired", [lockName]);
    if (Number(lockRows[0]?.acquired) !== 1) { sendJson(res, 503, { ok: false, error: "guild_busy" }); return; }
    await connection.beginTransaction(); transactionStarted = true;
    currentState = await getBusinessState(playerUid);
    actionPayload.player = currentState.player;
    let document = await getJson(connection, guildRuntimeKey(guildId));
    if (!document && op !== "guild_create") document = await seedBotGuildDocument(connection, guildId, payload.now_ts);
    if (!document && !["guild_create"].includes(op)) { await connection.rollback(); transactionStarted = false; sendJson(res, 404, { ok: false, error: "guild_not_found" }); return; }
    if (document) actionPayload.guild_document = document;
    if (op === "guild_members") actionPayload.bot_members = await botGuildMembers(connection, guildId);

    const transition = gameAction(currentState, actionPayload);
    if (!transition.ok) { await connection.rollback(); transactionStarted = false; sendJson(res, transition.status || 409, transition); return; }
    for (const item of transition.inventory || []) await upsertInventoryItemWith(connection, playerId, item);
    if (transition.guild_document) await upsertJson(connection, guildRuntimeKey(guildId), transition.guild_document);
    if (["guild_create", "guild_edit"].includes(op) && transition.guild) {
      await connection.execute("INSERT INTO bot_guilds (guild_id,name,level,notice,capacity) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),level=VALUES(level),notice=VALUES(notice),capacity=VALUES(capacity)", [guildId, transition.guild.name, Number(transition.guild.level || 1), transition.guild.notice || "", Number(transition.guild.capacity || 70)]);
    }
    if (op === "guild_disband" && guildId >= 1000000) await connection.execute("DELETE FROM bot_guilds WHERE guild_id=?", [guildId]);
    await connection.commit(); transactionStarted = false;
    const updatedState = await getBusinessState(playerUid);
    sendJson(res, 200, { ...transition, businessState: updatedState });
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    try { await connection.execute("SELECT RELEASE_LOCK(?)", [lockName]); } catch {}
    connection.release();
  }
}

function inventorySeedQuantity(seedByItemId, itemId, fallback) {
  const seeded = seedByItemId.get(itemId);
  if (!seeded) {
    return fallback;
  }

  const quantity = Number(seeded.quantity);
  return Number.isFinite(quantity) ? quantity : fallback;
}

function inventorySeedExtra(seedByItemId, itemId, fallback) {
  const seeded = seedByItemId.get(itemId);
  if (!seeded || !seeded.extra || typeof seeded.extra !== "object") {
    return fallback;
  }

  return seeded.extra;
}

async function upsertCharacterWith(executor, playerId, payload) {
  await executor.execute(
    `INSERT INTO characters (player_id, character_id, level, star, extra_json)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       level = VALUES(level),
       star = VALUES(star),
       extra_json = JSON_MERGE_PATCH(COALESCE(extra_json, JSON_OBJECT()), VALUES(extra_json)),
       updated_at = CURRENT_TIMESTAMP`,
    [
      playerId,
      String(payload.character_id || payload.characterId || ""),
      Number(payload.level || 1),
      Number(payload.star || 0),
      JSON.stringify(payload.extra_json || payload.extra || {}),
    ]
  );
}

async function upsertCharacter(playerId, payload) {
  return upsertCharacterWith(dbPool, playerId, payload);
}

async function persistGameTransitionWith(executor, playerId, transition) {
  for (const item of transition.inventory || []) await upsertInventoryItemWith(executor, playerId, item);
  const characters = [];
  if (transition.character) characters.push(transition.character);
  for (const character of transition.characters || []) {
    if (!characters.some((row) => String(row.character_id) === String(character.character_id))) characters.push(character);
  }
  for (const character of characters) await upsertCharacterWith(executor, playerId, character);
  for (const characterId of transition.remove_characters || []) {
    await executor.execute("DELETE FROM characters WHERE player_id = ? AND character_id = ?", [playerId, String(characterId)]);
  }
}

async function persistGameTransition(playerId, transition, receipt = null) {
  const connection = await dbPool.getConnection();
  let started = false;
  try {
    await connection.beginTransaction(); started = true;
    // Serialize every inventory/hero mutation for this player. The writes use
    // absolute post-action quantities, so a retry cannot duplicate resources.
    await connection.execute("SELECT id FROM players WHERE id=? FOR UPDATE", [playerId]);
    if (receipt?.key) {
      const [rows] = await connection.execute(
        "SELECT response_json FROM system_action_receipts WHERE player_id=? AND module_name=? AND request_key=? LIMIT 1 FOR UPDATE",
        [playerId, receipt.module || "game_action", receipt.key]
      );
      if (rows.length) {
        const stored = typeof rows[0].response_json === "string" ? JSON.parse(rows[0].response_json) : rows[0].response_json;
        await connection.commit(); started = false;
        return { ...stored, idempotent_replay: true };
      }
    }
    await persistGameTransitionWith(connection, playerId, transition);
    if (receipt?.key) await connection.execute(
      "INSERT INTO system_action_receipts (player_id,module_name,request_key,response_json) VALUES (?,?,?,?)",
      [playerId, receipt.module || "game_action", receipt.key, JSON.stringify(transition)]
    );
    await connection.commit(); started = false;
    return { ...transition, idempotent_replay: false };
  } catch (error) {
    if (started) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function readGameActionReceipt(playerId, requestKey) {
  if (!requestKey) return null;
  const [rows] = await dbPool.execute(
    "SELECT response_json FROM system_action_receipts WHERE player_id=? AND module_name='game_action' AND request_key=? LIMIT 1",
    [playerId, requestKey]
  );
  if (!rows.length) return null;
  const stored = typeof rows[0].response_json === "string"
    ? JSON.parse(rows[0].response_json)
    : rows[0].response_json;
  return { ...stored, idempotent_replay: true };
}

async function executeTavernDraw(playerId, playerUid, payload) {
  const connection = await dbPool.getConnection();
  let started = false;
  try {
    await connection.beginTransaction(); started = true;
    await connection.execute("SELECT id FROM players WHERE id=? FOR UPDATE", [playerId]);
    const requestKey = payload.idempotency_key
      ? String(payload.idempotency_key).slice(0, 191)
      : (payload.request_seq == null ? null : `draw:${Number(payload.tavern_id ?? payload.tavernId ?? 1)}:${String(payload.request_seq)}`.slice(0, 191));
    if (requestKey) {
      const [rows] = await connection.execute(
        "SELECT response_json FROM system_action_receipts WHERE player_id=? AND module_name='tavern_draw' AND request_key=? LIMIT 1 FOR UPDATE",
        [playerId, requestKey]
      );
      if (rows.length) {
        const stored = typeof rows[0].response_json === "string" ? JSON.parse(rows[0].response_json) : rows[0].response_json;
        await connection.commit(); started = false;
        return { ...stored, idempotent_replay: true };
      }
    }
    const currentState = await getBusinessState(playerUid);
    const transition = tavernDraw(currentState, payload);
    if (!transition.ok) { await connection.rollback(); started = false; return transition; }
    await persistGameTransitionWith(connection, playerId, transition);
    if (requestKey) await connection.execute(
      "INSERT INTO system_action_receipts (player_id,module_name,request_key,response_json) VALUES (?,?,?,?)",
      [playerId, "tavern_draw", requestKey, JSON.stringify(transition)]
    );
    await connection.commit(); started = false;
    return { ...transition, idempotent_replay: false };
  } catch (error) {
    if (started) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function executeHeroUpgrade(playerId, playerUid, payload) {
  const connection = await dbPool.getConnection();
  let started = false;
  try {
    await connection.beginTransaction(); started = true;
    await connection.execute("SELECT id FROM players WHERE id=? FOR UPDATE", [playerId]);
    const requestKey = payload.idempotency_key
      ? String(payload.idempotency_key).slice(0, 191)
      : (payload.request_seq == null ? null : `upgrade:${String(payload.hero_id ?? payload.heroId ?? 0)}:${String(payload.request_seq)}`.slice(0, 191));
    if (requestKey) {
      const [rows] = await connection.execute(
        "SELECT response_json FROM system_action_receipts WHERE player_id=? AND module_name='hero_upgrade' AND request_key=? LIMIT 1 FOR UPDATE",
        [playerId, requestKey]
      );
      if (rows.length) {
        const stored = typeof rows[0].response_json === "string" ? JSON.parse(rows[0].response_json) : rows[0].response_json;
        await connection.commit(); started = false;
        return { ...stored, idempotent_replay: true };
      }
    }
    const transition = observedHeroUpgrade(await getBusinessState(playerUid), payload);
    if (!transition.ok) { await connection.rollback(); started = false; return transition; }
    await persistGameTransitionWith(connection, playerId, transition);
    if (requestKey) await connection.execute(
      "INSERT INTO system_action_receipts (player_id,module_name,request_key,response_json) VALUES (?,?,?,?)",
      [playerId, "hero_upgrade", requestKey, JSON.stringify(transition)]
    );
    await connection.commit(); started = false;
    return { ...transition, idempotent_replay: false };
  } catch (error) {
    if (started) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function upsertStageProgressWith(executor, playerId, payload) {
  await executor.execute(
    `INSERT INTO stage_progress (player_id, stage_id, best_result_json, cleared_at)
     VALUES (?, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END)
     ON DUPLICATE KEY UPDATE
       best_result_json = JSON_MERGE_PATCH(COALESCE(best_result_json, JSON_OBJECT()), VALUES(best_result_json)),
       cleared_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE cleared_at END,
       updated_at = CURRENT_TIMESTAMP`,
    [
      playerId,
      String(payload.stage_id || payload.stageId || ""),
      JSON.stringify(payload.best_result_json || payload.bestResult || {}),
      Boolean(payload.cleared ?? true),
      Boolean(payload.cleared ?? true),
    ]
  );
}

async function upsertStageProgress(playerId, payload) {
  return upsertStageProgressWith(dbPool, playerId, payload);
}

async function applyInventoryMutations(playerId, inventory = []) {
  for (const item of inventory) await upsertInventoryItem(playerId, item);
}

async function runLiveopsForPlayer(playerId, nowTs = Math.floor(Date.now() / 1000)) {
  const [playerRows] = await dbPool.execute("SELECT player_uid FROM players WHERE id=? LIMIT 1", [playerId]);
  if (!playerRows.length) return { ok: false, error: "player_not_found" };
  const business = await getBusinessState(playerRows[0].player_uid);
  const transition = runDueResets(business, nowTs);
  await applyInventoryMutations(playerId, transition.inventory);
  return transition;
}

async function persistBattleRecord(playerId, battle) {
  await dbPool.execute(
    `INSERT INTO battle_records (id, player_id, mode, stage_id, seed, lineup_json, simulation_json, server_result, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [battle.battle_id, playerId, battle.mode, battle.stage_id, battle.seed, JSON.stringify(battle.lineup_ids), JSON.stringify(battle.simulation), battle.server_result]
  );
}

async function battleRecordById(battleId) {
  if (!battleId) return null;
  const [rows] = await dbPool.execute(
    "SELECT * FROM battle_records WHERE id=? LIMIT 1",
    [String(battleId)]
  );
  return rows[0] || null;
}

async function latestActiveBattle(playerId, mode = "campaign") {
  const [rows] = await dbPool.execute(
    "SELECT * FROM battle_records WHERE player_id=? AND mode=? AND status='active' ORDER BY started_at DESC LIMIT 1",
    [playerId, mode]
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    ok: true, battle_id: row.id, mode: row.mode, stage_id: Number(row.stage_id), seed: Number(row.seed),
    lineup_ids: typeof row.lineup_json === "string" ? JSON.parse(row.lineup_json) : row.lineup_json,
    simulation: typeof row.simulation_json === "string" ? JSON.parse(row.simulation_json) : row.simulation_json,
    server_result: row.server_result,
    evidence_level: "server_authoritative_decrypted_unit_and_stage_config",
  };
}

async function persistBattleFinish(playerId, result) {
  await dbPool.execute(
    "UPDATE battle_records SET client_result=?, verified=?, status='finished', finished_at=COALESCE(finished_at,NOW()) WHERE id=? AND player_id=?",
    [result.client_result || null, result.verified ? 1 : 0, result.battle_id, playerId]
  );
}

function battleRecordFromRow(row) {
  if (!row) return null;
  return {
    ok: true,
    battle_id: row.id,
    mode: row.mode,
    stage_id: Number(row.stage_id),
    seed: Number(row.seed),
    lineup_ids: typeof row.lineup_json === "string" ? JSON.parse(row.lineup_json) : row.lineup_json,
    simulation: typeof row.simulation_json === "string" ? JSON.parse(row.simulation_json) : row.simulation_json,
    server_result: row.server_result,
    evidence_level: "server_authoritative_decrypted_unit_and_stage_config",
  };
}

async function closeSupersededCampaignRoundsWith(connection, playerId, stageId, settledBattleId) {
  await connection.execute(
    `UPDATE battle_records
        SET client_result=COALESCE(client_result, 'victory'),
            verified=CASE WHEN server_result='victory' THEN 1 ELSE 0 END,
            status='finished',
            finished_at=COALESCE(finished_at, NOW())
      WHERE player_id=? AND mode='campaign' AND stage_id=? AND status='active' AND id<>?`,
    [playerId, stageId, settledBattleId]
  );
}

async function settleCampaignBattle(playerId, playerUid, payload) {
  const connection = await dbPool.getConnection();
  let lockedBattleId = null;
  try {
    await connection.beginTransaction();
    const parameters = [playerId];
    let sql = "SELECT * FROM battle_records WHERE player_id=? AND mode='campaign'";
    if (payload.battle_id) { sql += " AND id=?"; parameters.push(String(payload.battle_id)); }
    sql += " ORDER BY started_at DESC LIMIT 1 FOR UPDATE";
    const [battleRows] = await connection.execute(sql, parameters);
    if (!battleRows.length) {
      await connection.rollback();
      return { ok: false, status: 404, error: "active_battle_not_found" };
    }
    const battle = battleRecordFromRow(battleRows[0]);
    lockedBattleId = battle.battle_id;
    const [settlementRows] = await connection.execute(
      "SELECT response_json FROM battle_settlements WHERE battle_id=? LIMIT 1",
      [battle.battle_id]
    );
    if (settlementRows.length) {
      const stored = typeof settlementRows[0].response_json === "string"
        ? JSON.parse(settlementRows[0].response_json) : settlementRows[0].response_json;
      if (stored && stored.result === "victory") {
        await closeSupersededCampaignRoundsWith(connection, playerId, battle.stage_id, battle.battle_id);
      }
      await connection.commit();
      return { ...stored, idempotent_replay: true };
    }

    const verification = finishAuthoritativeBattle(battle, payload.result);
    const currentState = await getBusinessState(playerUid);
    const authoritativePayload = {
      ...payload,
      battle_id: battle.battle_id,
      stage_id: battle.stage_id,
      result: verification.result,
      completed_replay_stage: CLIENT_MAX_CAMPAIGN_STAGE,
    };
    const transition = campaignBattleResult(currentState, authoritativePayload);
    if (!transition.ok) {
      await connection.rollback();
      return transition;
    }
    for (const item of transition.inventory || []) {
      await upsertInventoryItemWith(connection, playerId, item);
    }
    await upsertStageProgressWith(connection, playerId, {
      stage_id: transition.stage.stage_id,
      cleared: transition.stage.cleared,
      best_result: transition.stage.best_result,
    });
    await connection.execute(
      "UPDATE battle_records SET client_result=?,verified=?,status='finished',finished_at=NOW() WHERE id=? AND player_id=?",
      [verification.client_result || null, verification.verified ? 1 : 0, battle.battle_id, playerId]
    );
    if (verification.result === "victory") {
      await closeSupersededCampaignRoundsWith(connection, playerId, battle.stage_id, battle.battle_id);
    }
    const response = { ...transition, battleVerification: verification, battle_id: battle.battle_id, idempotent_replay: false };
    const requestKey = String(payload.idempotency_key || `campaign:${battle.battle_id}`).slice(0, 191);
    await connection.execute(
      `INSERT INTO battle_settlements
       (battle_id,player_id,request_key,client_result,authoritative_result,verified,response_json)
       VALUES (?,?,?,?,?,?,?)`,
      [battle.battle_id, playerId, requestKey, verification.client_result || null, verification.result, verification.verified ? 1 : 0, JSON.stringify(response)]
    );
    await connection.commit();
    return response;
  } catch (error) {
    await connection.rollback();
    if (error && error.code === "ER_DUP_ENTRY") {
      const requestKey = payload.idempotency_key ? String(payload.idempotency_key).slice(0, 191) : null;
      const [rows] = await dbPool.execute(
        requestKey
          ? "SELECT response_json FROM battle_settlements WHERE player_id=? AND request_key=? LIMIT 1"
          : "SELECT response_json FROM battle_settlements WHERE battle_id=? LIMIT 1",
        requestKey ? [playerId, requestKey] : [String(lockedBattleId || payload.battle_id || "")]
      );
      if (rows.length) {
        const stored = typeof rows[0].response_json === "string" ? JSON.parse(rows[0].response_json) : rows[0].response_json;
        return { ...stored, idempotent_replay: true };
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function persistStructuredLogin(payload) {
  if (!dbReady || !dbPool) {
    const business = ensureMemoryBusinessState(payload);
    const sessionToken = `ws-session:${payload.session_id || "0"}:${randomUUID()}`;
    business.sessions.push({
      id: business.nextSessionId++,
      account_id: business.player.account_id,
      session_token: sessionToken,
      last_ticketid: payload.htoken || null,
      status: "active",
      client_ip: "websocket-local",
      user_agent: "local-platform-mock-memory",
      created_at: nowIso(),
    });

    return {
      account_id: business.player.account_id,
      player_id: business.player.id,
      player_uid: business.player.player_uid,
      session_id: payload.session_id || null,
      db_session_id: null,
      session_token: sessionToken,
      source: "memory",
    };
  }

  const htoken = payload.htoken || `anonymous-session-${payload.session_id || "unknown"}`;
  const providerUid = String(htoken);
  const localUsername = providerUid.startsWith("local-auth:")
    ? providerUid.slice("local-auth:".length).toLowerCase()
    : "";
  let playerUid = `local-player:${providerUid}`;
  let accountId = null;
  const sessionToken = `ws-session:${payload.session_id || "0"}:${randomUUID()}`;
  const profile = {
    source: "structured_ws_login",
    session_id: payload.session_id || null,
    htoken,
    svr_id: payload.svr_id || null,
    sdk_login_seq: payload.sdk_login_seq || null,
    login_seq: payload.login_seq || null,
    charge_seq: payload.charge_seq || null,
    persisted_at: new Date().toISOString(),
  };

  if (localUsername) {
    const tokenIdentity = await authenticateToken(dbPool, providerUid);
    if (tokenIdentity) {
      accountId = tokenIdentity.account_id;
      playerUid = tokenIdentity.player_uid || `local-account:${accountId}`;
    }
  }

  if (localUsername && !accountId) {
    const [credentialRows] = await dbPool.execute(
      `SELECT a.id, p.player_uid
         FROM accounts a
         LEFT JOIN players p ON p.account_id = a.id
        WHERE a.provider = 'local_password' AND a.provider_uid = ?
        LIMIT 1`,
      [localUsername]
    );
    if (credentialRows.length) {
      accountId = credentialRows[0].id;
      playerUid = credentialRows[0].player_uid || `local-account:${accountId}`;
    }
  }

  if (!accountId) {
    await dbPool.execute(
      `INSERT INTO accounts (provider, provider_uid, display_name)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         updated_at = CURRENT_TIMESTAMP`,
      ["local_ws", providerUid, `Local WS ${providerUid.slice(0, 24)}`]
    );
    const [accountRows] = await dbPool.execute(
      "SELECT id FROM accounts WHERE provider = ? AND provider_uid = ? LIMIT 1",
      ["local_ws", providerUid]
    );
    accountId = accountRows[0].id;
  }

  await dbPool.execute(
    `INSERT INTO players (account_id, player_uid, nickname, profile_json)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       account_id = VALUES(account_id),
       nickname = IF(nickname IS NULL OR nickname = '', VALUES(nickname), nickname),
       profile_json = IF(profile_json IS NULL OR profile_json = '' OR profile_json = '{}', VALUES(profile_json), profile_json),
       updated_at = CURRENT_TIMESTAMP`,
    [accountId, playerUid, "本地玩家", JSON.stringify(profile)]
  );
  const [playerRows] = await dbPool.execute(
    "SELECT id FROM players WHERE player_uid = ? LIMIT 1",
    [playerUid]
  );
  const playerId = playerRows[0].id;

  const seedByItemId = new Map();
  if (Array.isArray(payload.inventory)) {
    for (const item of payload.inventory) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const itemId = String(item.item_id || item.itemId || "");
      if (!itemId) {
        continue;
      }
      seedByItemId.set(itemId, {
        quantity: item.quantity,
        extra: item.extra_json || item.extra || {},
      });
    }
  }

  const defaultInventory = [
    {
      item_id: "gold",
      quantity: inventorySeedQuantity(seedByItemId, "gold", 10000),
      extra: inventorySeedExtra(seedByItemId, "gold", { source: "login_seed" }),
    },
    {
      item_id: "diamond",
      quantity: inventorySeedQuantity(seedByItemId, "diamond", 1000000),
      extra: inventorySeedExtra(seedByItemId, "diamond", { source: "login_seed" }),
    },
    {
      item_id: "diamond_charge",
      quantity: inventorySeedQuantity(seedByItemId, "diamond_charge", 20),
      extra: inventorySeedExtra(seedByItemId, "diamond_charge", { source: "login_seed" }),
    },
    {
      item_id: "stage_ticket",
      quantity: inventorySeedQuantity(seedByItemId, "stage_ticket", 30),
      extra: inventorySeedExtra(seedByItemId, "stage_ticket", { source: "login_seed" }),
    },
    {
      item_id: "hero_exp",
      quantity: inventorySeedQuantity(seedByItemId, "hero_exp", 188992),
      extra: inventorySeedExtra(seedByItemId, "hero_exp", { source: "official_login_seed" }),
    },
    {
      item_id: "player_exp",
      quantity: inventorySeedQuantity(seedByItemId, "player_exp", 889),
      extra: inventorySeedExtra(seedByItemId, "player_exp", { source: "official_login_seed" }),
    },
    {
      item_id: "item_1",
      quantity: inventorySeedQuantity(seedByItemId, "item_1", 773),
      extra: inventorySeedExtra(seedByItemId, "item_1", {
        source: "official_login_seed",
        asset_type: "item",
        asset_id: 1,
      }),
    },
    {
      item_id: "item_13",
      quantity: inventorySeedQuantity(seedByItemId, "item_13", 20),
      extra: inventorySeedExtra(seedByItemId, "item_13", {
        source: "official_login_seed",
        asset_type: "item",
        asset_id: 13,
      }),
    },
    {
      item_id: "meta_campaign_cur_stage",
      quantity: inventorySeedQuantity(seedByItemId, "meta_campaign_cur_stage", 13),
      extra: inventorySeedExtra(seedByItemId, "meta_campaign_cur_stage", { source: "official_login_seed" }),
    },
    {
      item_id: "meta_idle_last_claim_ts",
      quantity: inventorySeedQuantity(
        seedByItemId,
        "meta_idle_last_claim_ts",
        Math.floor(Date.now() / 1000) - 9296
      ),
      extra: inventorySeedExtra(seedByItemId, "meta_idle_last_claim_ts", { source: "captured_idle_seed" }),
    },
  ];
  for (const item of defaultInventory) {
    await dbPool.execute(
      `INSERT INTO inventory_items (player_id, item_id, quantity, extra_json)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         quantity = GREATEST(quantity, VALUES(quantity)),
         extra_json = VALUES(extra_json),
         updated_at = CURRENT_TIMESTAMP`,
      [playerId, item.item_id, item.quantity, JSON.stringify(item.extra)]
    );
  }

  const defaultCharacters = [
    ["1", 10, 1, { hero_id: 1, tid: 22, quality: 1, rank: 2, gs: 997, source: "official_login_seed" }],
    ["assist_24230", 12, 1, { assist_uid: 24230, hero_id: 26, avatar: "avatar:102", power: 10000 }],
    ["assist_24238", 9, 1, { assist_uid: 24238, hero_id: 24, avatar: "avatar:102", power: 10000 }],
    ["assist_24249", 8, 1, { assist_uid: 24249, hero_id: 18, avatar: "avatar:102", power: 10000 }],
    ["assist_24261", 10, 1, { assist_uid: 24261, hero_id: 33, avatar: "avatar:102", title: "帝", title_id: 12, title_quality: 3, power: 10000 }],
    ["assist_24270", 17, 1, { assist_uid: 24270, hero_id: 17, avatar: "avatar:102", power: 10000 }],
  ];
  for (const [characterId, level, star, extra] of defaultCharacters) {
    await upsertCharacter(playerId, {
      character_id: characterId,
      level,
      star,
      extra,
    });
  }

  await upsertStageProgress(playerId, {
    stage_id: "stage_query_assist_summaries",
    best_result_json: {
      source: "login_seed",
      assist_summary_limit: defaultCharacters.length,
    },
    cleared: true,
  });

  await dbPool.execute(
    `INSERT INTO sessions (
      account_id,
      session_token,
      last_ticketid,
      status,
      client_ip,
      user_agent
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [accountId, sessionToken, htoken, "active", "websocket-local", "local-platform-mock"]
  );

  return {
    account_id: accountId,
    player_id: playerId,
    player_uid: playerUid,
    session_id: payload.session_id || null,
    db_session_id: null,
    session_token: sessionToken,
  };
}

async function getEnabledInteractionRules() {
  const [rows] = await dbPool.execute(
    `SELECT
      id,
      rule_name,
      priority,
      request_signature,
      response_sequence,
      source_fixture
    FROM ws_interaction_rules
    WHERE enabled = 1
    ORDER BY priority ASC, id ASC`
  );
  return rows;
}

function buildParkwayConfig() {
  const payload = clone(parkwayConfigSnapshot);

  if (DISABLE_SDK_SLS) {
    payload.feature_switch.sdk_sls = 0;
    payload.feature_switch.game_sls_report = 0;
    payload.feature_switch.diagnose_network = 0;
    payload.feature_switch.is_stop_report_sls_cp = 1;
  }

  if (DISABLE_AUTO_LOGIN) {
    payload.feature_switch.login_auto = 0;
  }

  if (SDK_BASE_URL) {
    payload.base_url.sdk = SDK_BASE_URL;
    payload.base_url.account_center = SDK_BASE_URL;
    payload.base_url.device_score = SDK_BASE_URL;
    payload.base_url.device_manager = `${SDK_BASE_URL}/devicemanage`;
    payload.base_url.file_upload = SDK_BASE_URL;
    payload.base_url.qrcode_login = `${SDK_BASE_URL}/qrCode`;
    payload.base_url.sdk_server_list = [SDK_BASE_URL];
  }

  return payload;
}

function buildSlsToken() {
  const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return {
    access_key_id: "mock-access-key-id",
    access_key_secret: "mock-access-key-secret",
    security_token: "mock-security-token",
    expiration: expirationDate.toISOString().replace(".000", ""),
    expiration_utc: Math.floor(expirationDate.getTime() / 1000),
    expiration_seconds: 86400,
    project: "mock-client-sdk",
    endpoint: "https://app.lilithgame.com/log",
    expedite_endpoint: "https://app.lilithgame.com/log",
    logstore: "client-sdk",
    sdk_error_logstore: "client-sdk-errorlog",
    dgc_project_name: "mock-gdc",
    dgc_log_store_name: "gdc",
    project_game: "mock-game-10046",
    logstore_game: "game-10046",
  };
}

async function proxyUnknownRequest(context) {
  const headers = {};

  for (const [key, value] of Object.entries(context.req.headers)) {
    if (value == null) {
      continue;
    }

    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "host" ||
      lowerKey === "content-length" ||
      lowerKey === "connection" ||
      lowerKey === "transfer-encoding" ||
      lowerKey === "accept-encoding" ||
      lowerKey.startsWith("x-afk-original-")
    ) {
      continue;
    }

    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  const upstreamUrl = new URL(
    `${context.originalScheme}://${context.originalHost}${context.req.url}`
  );

  const response = await fetch(upstreamUrl, {
    method: context.req.method,
    headers,
    body:
      context.req.method === "GET" || context.req.method === "HEAD"
        ? undefined
        : context.bodyBuffer,
    redirect: "manual",
  });

  const upstreamBody = Buffer.from(await response.arrayBuffer());
  const responseHeaders = {};

  response.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "content-length" ||
      lowerKey === "connection" ||
      lowerKey === "transfer-encoding" ||
      lowerKey === "content-encoding"
    ) {
      return;
    }
    responseHeaders[key] = value;
  });

  responseHeaders["x-afk-mock"] = "proxy";
  responseHeaders["x-afk-upstream-host"] = context.originalHost;

  return {
    upstreamUrl: upstreamUrl.toString(),
    statusCode: response.status,
    headers: responseHeaders,
    bodyBuffer: upstreamBody,
  };
}

function buildContext(req, bodyBuffer) {
  const hostHeader = Array.isArray(req.headers.host)
    ? req.headers.host[0]
    : req.headers.host;
  const requestUrl = new URL(req.url, `http://${hostHeader || "localhost"}`);
  requestUrl.pathname = normalizePatchedApkPath(requestUrl.pathname);
  const incomingHost = normalizeHost(hostHeader);
  const originalHostHeader = req.headers["x-afk-original-host"];
  const originalHost = normalizeHost(
    Array.isArray(originalHostHeader) ? originalHostHeader[0] : originalHostHeader
  ) || (incomingHost && !isLocalMockHost(incomingHost) ? incomingHost : "");
  const originalSchemeHeader = req.headers["x-afk-original-scheme"];
  const originalScheme = String(
    Array.isArray(originalSchemeHeader)
      ? originalSchemeHeader[0]
      : originalSchemeHeader || (req.socket.encrypted ? "https" : "http")
  ).toLowerCase();

  return {
    req,
    requestUrl,
    bodyBuffer,
    requestBodyPreview: previewText(bodyBuffer),
    originalHost,
    originalScheme,
    proxiedByMitm: Boolean(originalHost),
  };
}

function normalizePatchedApkPath(pathname) {
  const knownPrefixes = [
    "/api/",
    "/park/",
    "/http/",
    "/log/",
    "/__afk/",
  ];

  for (const prefix of knownPrefixes) {
    const index = pathname.indexOf(prefix, 1);
    if (index > 0) {
      return pathname.slice(index);
    }
  }

  return pathname;
}

function writeRequestLog(baseRecord, extra = {}) {
  const record = {
    ...baseRecord,
    ...extra,
  };

  logRecord(record);

  if (dbReady && dbPool) {
    insertRequestLog(dbPool, record).catch((error) => {
      dbErrorMessage = String(error && error.message ? error.message : error);
      console.error(`[mysql] failed to write request log: ${dbErrorMessage}`);
    });
  }
}

async function handleRequest(req, res) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  runtimeMetrics.requests += 1;

  let bodyBuffer;
  try {
    bodyBuffer = await readBody(req);
  } catch (error) {
    sendJson(res, 400, {
      error: "invalid_request_body",
      message: String(error),
    });
    return;
  }

  const context = buildContext(req, bodyBuffer);
  const limited = rateLimit(req, context.requestUrl.pathname);
  if (limited) {
    runtimeMetrics.rateLimited += 1;
    sendJson(res, 429, { error: "rate_limited", retry_after: limited.retryAfter }, { "retry-after": String(limited.retryAfter) });
    if (dbReady && dbPool) dbPool.execute("INSERT INTO security_events (severity,event_type,actor,remote_ip,payload_json) VALUES ('warning','rate_limit',NULL,?,?)", [limited.remote, JSON.stringify({ path: context.requestUrl.pathname, limit: limited.limit })]).catch(()=>{});
    return;
  }
  const baseRecord = {
    time: new Date().toISOString(),
    request_id: requestId,
    method: req.method,
    local_path: context.requestUrl.pathname,
    local_query: context.requestUrl.searchParams.toString(),
    original_host: context.originalHost || null,
    original_scheme: context.originalScheme,
    request_body_preview: context.requestBodyPreview,
  };

  try {
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      context.requestUrl.pathname === "/download/AFK-Private-1.201.01-arm64.apk"
    ) {
      if (!fs.existsSync(PUBLIC_CLIENT_APK)) {
        sendJson(res, 404, { error: "private_client_not_built" });
        return;
      }
      const stat = fs.statSync(PUBLIC_CLIENT_APK);
      res.writeHead(200, {
        "content-type": "application/vnd.android.package-archive",
        "content-length": stat.size,
        "content-disposition": 'attachment; filename="AFK-Private-1.201.01-arm64.apk"',
        "cache-control": "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
        expires: "0",
        "x-afk-client-build": "1.201.01-classic-hotfix-20260903",
      });
      if (req.method === "HEAD") {
        res.end();
      } else {
        fs.createReadStream(PUBLIC_CLIENT_APK).pipe(res);
      }
      return;
    }

    if (req.method === "GET" && context.requestUrl.pathname.startsWith("/gm-ui")) {
      if (!sendGmAsset(res, context.requestUrl.pathname)) sendJson(res, 404, { error: "gm_asset_not_found" });
      return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/health") {
      const payload = {
        ok: true,
        host: HOST,
        port: PORT,
        proxyUnknown: PROXY_UNKNOWN,
        localBaseUrl: LOCAL_BASE_URL || null,
        disableSdkSls: DISABLE_SDK_SLS,
        disableAutoLogin: DISABLE_AUTO_LOGIN,
        client: {
          version: process.env.AFK_CLIENT_VERSION || "1.201.01.360409",
          package: process.env.AFK_CLIENT_PACKAGE || "cyou.sharesrc.afk.release146",
        },
        overrides: {
          forcedDiamond: state.overrides.forcedDiamond,
        },
        db: {
          enabled: DB_ENABLED,
          ready: dbReady,
          name: process.env.AFK_DB_NAME || process.env.MYSQL_DATABASE || DEFAULT_DB_NAME,
          error: dbErrorMessage,
        },
      };
      sendJson(res, 200, payload);
      writeRequestLog(baseRecord, {
        action: "control",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(payload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/evidence") {
      const protocol = catalogSummary();
      sendJson(res, 200, { ok: true, battle: battleEvidence(), config: { config_count: listConfigs().length, evidence_level: "decrypted_official_client_artifact" },
        protocol: { module_count: protocol.module_count, client_version: protocol.client_version, evidence_level: protocol.evidence_level },
        boundaries: { official_server_private_logic: "not_available", local_authority: ["matchmaking","liveops_schedule","payment_fulfillment","anti_cheat_policy"],
          statement: "Client artifacts prove schemas, resources and client-side rules; private official server code is not claimed." } });
      return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/metrics") {
      let players=0,battles=0,orders=0;
      if(dbReady&&dbPool){const sets=await Promise.all([dbPool.query("SELECT COUNT(*) count FROM players"),dbPool.query("SELECT COUNT(*) count FROM battle_records"),dbPool.query("SELECT COUNT(*) count FROM payment_orders")]);players=Number(sets[0][0][0].count);battles=Number(sets[1][0][0].count);orders=Number(sets[2][0][0].count);}
      const lines=[`afk_uptime_seconds ${Math.floor((Date.now()-runtimeMetrics.startedAt)/1000)}`,`afk_http_requests_total ${runtimeMetrics.requests}`,`afk_http_errors_total ${runtimeMetrics.errors}`,`afk_rate_limited_total ${runtimeMetrics.rateLimited}`,`afk_players_total ${players}`,`afk_battles_total ${battles}`,`afk_payment_orders_total ${orders}`,`afk_database_ready ${dbReady?1:0}`];
      sendBuffer(res,200,Buffer.from(lines.join("\n")+"\n"),{"content-type":"text/plain; version=0.0.4; charset=utf-8","cache-control":"no-store"});return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/systems/catalog") {
      sendJson(res, 200, catalogSummary()); return;
    }

    if (req.method === "POST" && context.requestUrl.pathname === "/__afk/systems/action") {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      if (String(payload.module || "") === "gm") return sendJson(res, 403, { error: "gm_protocol_requires_authenticated_admin_endpoint" });
      const playerId = await findPlayerId(payload.player_uid || "");
      if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
      if (["friend", "ublacklist", "mercenary", "apostle", "rank_board", "chat"].includes(String(payload.module || ""))) {
        const result = await executeSocialProtocolAction(
          dbPool, playerId, String(payload.module), String(payload.operation || payload.op || ""),
          payload.payload && typeof payload.payload === "object" ? payload.payload : payload
        );
        sendJson(res, Number.isInteger(result.status) ? result.status : (result.ok ? 200 : 409), result); return;
      }
      const result = await executeSystemAction(dbPool, playerId, payload.module, payload.operation || payload.op, payload);
      sendJson(res, Number.isInteger(result.status) ? result.status : (result.ok ? 200 : 409), result); return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/liveops/instances") {
      if (!requireDb(res)) return;
      const [instances] = await dbPool.execute("SELECT * FROM liveops_instances ORDER BY starts_at DESC,id DESC");
      sendJson(res, 200, { ok: true, instances, schedule_authority: "local_configurable", config_evidence: "decrypted_official_client_config" }); return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/payments/catalog") {
      sendJson(res, 200, { ok: true, sandbox: true, products: paymentCatalog() }); return;
    }

    if (req.method === "POST" && context.requestUrl.pathname === "/__afk/payments/orders") {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const playerId = await findPlayerId(payload.player_uid || "");
      if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
      const result = await purchaseNow(dbPool, playerId, payload);
      sendJson(res, result.http_status || (result.ok ? 200 : 409), result); return;
    }

    if (req.method === "POST" && context.requestUrl.pathname === "/__afk/payments/purchase") {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const playerId = await findPlayerId(payload.player_uid || "");
      if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
      const result = await purchaseNow(dbPool, playerId, payload);
      sendJson(res, result.http_status || (result.ok ? 200 : 409), result); return;
    }

    if (req.method === "POST" && /^\/__afk\/payments\/orders\/[^/]+\/confirm$/.test(context.requestUrl.pathname)) {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const orderId = context.requestUrl.pathname.split("/")[4];
      const result = await confirmOrder(dbPool, orderId, payload.signature);
      sendJson(res, result.http_status || (result.ok ? 200 : 409), result); return;
    }

    if (
      req.method === "GET" &&
      context.requestUrl.pathname === "/__afk/monitor/platform-currency"
    ) {
      const payload = buildPlatformCurrencyMonitor(context.requestUrl.searchParams, {
        requestLog: REQUEST_LOG,
        wsFrameLog: WS_FRAME_LOG,
      });
      sendJson(res, 200, payload);
      writeRequestLog(baseRecord, {
        action: "control",
        status_code: 200,
        response_body_preview: previewText(
          JSON.stringify({
            monitor: payload.monitor,
            returned: payload.counts.returned,
            by_source: payload.counts.by_source,
          })
        ),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "GET" &&
      context.requestUrl.pathname === "/__afk/control/diamond"
    ) {
      const payload = {
        forcedDiamond: state.overrides.forcedDiamond,
        enabled: Number.isSafeInteger(state.overrides.forcedDiamond),
      };
      sendJson(res, 200, payload);
      writeRequestLog(baseRecord, {
        action: "control",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(payload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/control/diamond"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, {
          error: "invalid_json",
          message: "Expected JSON like {\"amount\":999999999} or {\"enabled\":false}.",
        });
        writeRequestLog(baseRecord, {
          action: "control",
          status_code: 400,
          response_body_preview: "invalid_json",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      if (payload.enabled === false || payload.amount === null || payload.quantity === null) {
        state.overrides.forcedDiamond = null;
      } else {
        const amount = Number(payload.amount ?? payload.quantity ?? payload.diamond);
        if (!Number.isSafeInteger(amount) || amount < 0) {
          sendJson(res, 400, {
            error: "invalid_amount",
            message: "amount must be a non-negative safe integer.",
          });
          writeRequestLog(baseRecord, {
            action: "control",
            status_code: 400,
            response_body_preview: "invalid_amount",
            duration_ms: Date.now() - startedAt,
          });
          return;
        }
        state.overrides.forcedDiamond = amount;
      }

      const statePayload = dbReady && dbPool
        ? await getBusinessState(payload.player_uid || payload.playerUid || "")
        : getMemoryBusinessState(payload.player_uid || payload.playerUid || "");
      const responsePayload = {
        ok: true,
        forcedDiamond: state.overrides.forcedDiamond,
        enabled: Number.isSafeInteger(state.overrides.forcedDiamond),
        businessState: statePayload,
      };
      sendJson(res, 200, responsePayload);
      writeRequestLog(baseRecord, {
        action: "control",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(responsePayload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "GET" &&
      context.requestUrl.pathname === "/__afk/control/userstatus"
    ) {
      sendJson(res, 200, state.userStatus);
      writeRequestLog(baseRecord, {
        action: "control",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(state.userStatus)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/control/userstatus"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, {
          error: "invalid_json",
          message: "Expected a JSON object body.",
        });
        writeRequestLog(baseRecord, {
          action: "control",
          status_code: 400,
          response_body_preview: "invalid_json",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      state.userStatus = {
        ...state.userStatus,
        ...payload,
      };
      await persistUserStatus();

      sendJson(res, 200, state.userStatus);
      writeRequestLog(baseRecord, {
        action: "control",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(state.userStatus)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/control/reset"
    ) {
      state.localAccount = null;
      state.userStatus = clone(defaultUserStatus);
      await persistUserStatus();
      sendJson(res, 200, {
        ok: true,
        userStatus: state.userStatus,
      });
      writeRequestLog(baseRecord, {
        action: "control",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(state.userStatus)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/internal/ws-frame"
    ) {
      if (!requireDb(res)) {
        writeRequestLog(baseRecord, {
          action: "internal",
          status_code: 503,
          response_body_preview: "db_unavailable",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, { error: "invalid_json" });
        writeRequestLog(baseRecord, {
          action: "internal",
          status_code: 400,
          response_body_preview: "invalid_json",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      await insertWsFrameLog(dbPool, payload);
      sendJson(res, 200, { ok: true });
      writeRequestLog(baseRecord, {
        action: "internal",
        status_code: 200,
        response_body_preview: "{\"ok\":true}",
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/internal/structured-login"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, { error: "invalid_json" });
        writeRequestLog(baseRecord, {
          action: "internal",
          status_code: 400,
          response_body_preview: "invalid_json",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      const persisted = await persistStructuredLogin(payload);
      sendJson(res, 200, persisted);
      writeRequestLog(baseRecord, {
        action: "internal",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(persisted)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "GET" &&
      context.requestUrl.pathname === "/__afk/internal/interaction-rules"
    ) {
      if (!requireDb(res)) {
        writeRequestLog(baseRecord, {
          action: "internal",
          status_code: 503,
          response_body_preview: "db_unavailable",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      const rules = await getEnabledInteractionRules();
      sendJson(res, 200, { rules });
      writeRequestLog(baseRecord, {
        action: "internal",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify({ rule_count: rules.length })),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/accounts/register"
    ) {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const result = await registerAccount(dbPool, { username: payload.username, password: payload.password, display_name: payload.display_name, role: "player" });
      sendJson(res, result.status || (result.ok ? 201 : 400), result);
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/accounts/login"
    ) {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const result = await loginAccount(dbPool, { ...payload, client_ip: req.socket.remoteAddress, user_agent: req.headers["user-agent"] });
      sendJson(res, result.status || (result.ok ? 200 : 400), result);
      return;
    }

    if (
      req.method === "GET" &&
      context.requestUrl.pathname === "/__afk/gm/players"
    ) {
      const identity = await requireIdentity(req, res, ["gm", "admin"]);
      if (!identity) return;
      const [players] = await dbPool.execute(
        `SELECT p.id, p.player_uid, p.nickname, p.level, p.exp, p.gold, p.diamond, p.updated_at,
                a.provider_uid AS account_name, c.role, c.banned_until, c.ban_reason
           FROM players p LEFT JOIN accounts a ON a.id=p.account_id
           LEFT JOIN local_credentials c ON c.account_id=a.id ORDER BY p.updated_at DESC LIMIT 200`
      );
      sendJson(res, 200, { ok: true, players });
      return;
    }

    if (
      req.method === "GET" &&
      context.requestUrl.pathname === "/__afk/gm/audit"
    ) {
      const identity = await requireIdentity(req, res, ["gm", "admin"]);
      if (!identity) return;
      const [records] = await dbPool.execute("SELECT * FROM gm_audit_logs ORDER BY id DESC LIMIT 200");
      sendJson(res, 200, { ok: true, records });
      return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/gm/payments") {
      const identity = await requireIdentity(req, res, ["gm", "admin"]);
      if (!identity) return;
      const [orders] = await dbPool.execute("SELECT o.*,p.player_uid,p.nickname FROM payment_orders o JOIN players p ON p.id=o.player_id ORDER BY o.created_at DESC LIMIT 200");
      sendJson(res, 200, { ok: true, sandbox: true, orders }); return;
    }

    if (req.method === "POST" && context.requestUrl.pathname === "/__afk/gm/liveops") {
      const identity = await requireIdentity(req, res, ["admin"]);
      if (!identity) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const activityKey = String(payload.activity_key || "").slice(0,128);
      if (!activityKey || !payload.starts_at || !payload.ends_at) return sendJson(res, 422, { error: "invalid_liveops_instance" });
      await dbPool.execute("INSERT INTO liveops_instances (activity_key,config_table,title,starts_at,ends_at,claim_ends_at,status,rules_json) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE config_table=VALUES(config_table),title=VALUES(title),starts_at=VALUES(starts_at),ends_at=VALUES(ends_at),claim_ends_at=VALUES(claim_ends_at),status=VALUES(status),rules_json=VALUES(rules_json)",
        [activityKey, payload.config_table || null, String(payload.title || activityKey).slice(0,191), new Date(payload.starts_at), new Date(payload.ends_at), payload.claim_ends_at ? new Date(payload.claim_ends_at) : null, payload.status || "draft", JSON.stringify(payload.rules || {})]);
      const result = { ok: true, activity_key: activityKey };
      await audit(dbPool, identity, "upsert_liveops", null, payload, result);
      sendJson(res, 200, result); return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/gm/action"
    ) {
      const identity = await requireIdentity(req, res, ["gm", "admin"]);
      if (!identity) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const playerId = Number(payload.player_id || identity.player_id || 0);
      const [targetRows] = await dbPool.execute("SELECT * FROM players WHERE id=? LIMIT 1", [playerId]);
      if (!targetRows.length) return sendJson(res, 404, { error: "player_not_found" });
      const target = targetRows[0];
      let result = { ok: true, action: payload.action, player_id: playerId };
      if (payload.action === "grant_asset") {
        const itemId = String(payload.item_id || "");
        const delta = Number(payload.amount || 0);
        if (!itemId || !Number.isSafeInteger(delta)) return sendJson(res, 422, { error: "invalid_asset_grant" });
        const [rows] = await dbPool.execute("SELECT quantity FROM inventory_items WHERE player_id=? AND item_id=?", [playerId, itemId]);
        await upsertInventoryItem(playerId, { item_id: itemId, quantity: Math.max(0, Number(rows[0]?.quantity || 0) + delta), extra: { source: "gm_grant", gm_account_id: identity.account_id } });
        result.item_id = itemId; result.delta = delta;
      } else if (payload.action === "set_stage") {
        const stage = Math.max(1, Number(payload.stage_id || 1));
        await upsertInventoryItem(playerId, { item_id: "meta_campaign_cur_stage", quantity: stage, extra: { source: "gm_set_stage" } });
        result.stage_id = stage;
      } else if (payload.action === "ban" || payload.action === "unban") {
        if (!target.account_id) return sendJson(res, 409, { error: "account_not_managed" });
        if (payload.action === "ban") {
          const hours = Math.max(1, Math.min(8760, Number(payload.hours || 24)));
          await dbPool.execute("UPDATE local_credentials SET banned_until=DATE_ADD(NOW(), INTERVAL ? HOUR), ban_reason=? WHERE account_id=?", [hours, String(payload.reason || "GM ban").slice(0, 512), target.account_id]);
          result.hours = hours;
        } else {
          await dbPool.execute("UPDATE local_credentials SET banned_until=NULL, ban_reason=NULL WHERE account_id=?", [target.account_id]);
        }
      } else if (payload.action === "send_mail") {
        await dbPool.execute("INSERT INTO player_mails (player_id, sender, title, body, assets_json, expires_at) VALUES (?, 'GM', ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))", [playerId, String(payload.title || "GM 补偿").slice(0, 191), String(payload.body || ""), JSON.stringify(payload.assets || [])]);
      } else if (payload.action === "run_resets") {
        result.transition = await runLiveopsForPlayer(playerId, Number(payload.now_ts || Math.floor(Date.now() / 1000)));
      } else if (payload.action === "reset_system") {
        const moduleName = String(payload.module || "");
        if (moduleName) await dbPool.execute("DELETE FROM player_system_state WHERE player_id=? AND module_name=?", [playerId, moduleName]);
        else await dbPool.execute("DELETE FROM player_system_state WHERE player_id=?", [playerId]);
        result.module = moduleName || "all";
      } else if (payload.action === "set_player") {
        const level = Math.max(1, Math.trunc(Number(payload.level || target.level)));
        const nickname = String(payload.nickname || target.nickname || "Player").slice(0,191);
        await dbPool.execute("UPDATE players SET level=?,nickname=? WHERE id=?", [level,nickname,playerId]);
        result.level = level; result.nickname = nickname;
      } else if (payload.action === "protocol_gm") {
        const operation = String(payload.operation || "");
        const gmInfo = moduleInfo("gm");
        if (!gmInfo.operations.includes(operation)) return sendJson(res, 422, { error: "unsupported_gm_protocol_operation", operation });
        if (/req_(?:delete|cut|refund|clear|clean)/.test(operation) && identity.role !== "admin") return sendJson(res, 403, { error: "admin_role_required", operation });
        const args = payload.args && typeof payload.args === "object" ? payload.args : {};
        if (operation === "req_diamond" || operation === "req_gold" || operation === "req_item_id" || operation === "req_item_number") {
          const itemId = operation === "req_diamond" ? "diamond" : operation === "req_gold" ? "gold" : String(args.item_id || args.id || "");
          const amount = Math.max(0, Math.trunc(Number(args.amount ?? args.number ?? 0)));
          if (!itemId || !Number.isSafeInteger(amount)) return sendJson(res, 422, { error: "invalid_gm_asset_value" });
          await upsertInventoryItem(playerId, { item_id: itemId, quantity: amount, extra: { source: "protocol_gm", operation, gm_account_id: identity.account_id } });
          result.operation = operation; result.item_id = itemId; result.amount = amount;
        } else if (operation === "req_set_level") {
          const level = Math.max(1, Math.min(10000, Math.trunc(Number(args.level || 1))));
          await dbPool.execute("UPDATE players SET level=? WHERE id=?", [level, playerId]);
          result.operation = operation; result.level = level;
        } else if (operation === "req_unlock_stages") {
          const stage = Math.max(1, Math.trunc(Number(args.stage_id || args.stage || 1)));
          await upsertInventoryItem(playerId, { item_id: "meta_campaign_cur_stage", quantity: stage, extra: { source: "protocol_gm", operation } });
          result.operation = operation; result.stage_id = stage;
        } else if (operation === "req_set_tower") {
          const floor = Math.max(1, Math.trunc(Number(args.floor || args.floor_id || 1)));
          await upsertInventoryItem(playerId, { item_id: "meta_tower_floor", quantity: floor, extra: { source: "protocol_gm", operation } });
          result.operation = operation; result.floor = floor;
        } else if (operation === "req_add_assets" || operation === "req_batch_items_number") {
          const assets = Array.isArray(args.assets) ? args.assets.slice(0, 500) : [];
          for (const entry of assets) {
            const itemId = String(entry.item_id || entry.id || "");
            const amount = Math.max(0, Math.trunc(Number(entry.amount || entry.number || 0)));
            if (itemId) await upsertInventoryItem(playerId, { item_id: itemId, quantity: amount, extra: { source: "protocol_gm", operation } });
          }
          result.operation = operation; result.assets = assets.length;
        } else {
          const transition = await executeSystemAction(dbPool, playerId, "gm", operation, { payload: args, include_config: false, actor_account_id: identity.account_id });
          result = { ...result, operation, transition };
        }
      } else {
        return sendJson(res, 422, { error: "unsupported_gm_action" });
      }
      await audit(dbPool, identity, payload.action, playerId, payload, result);
      sendJson(res, 200, result);
      return;
    }

    if (
      req.method === "GET" &&
      context.requestUrl.pathname === "/__afk/liveops/status"
    ) {
      sendJson(res, 200, { ok: true, ...periodInfo(Number(context.requestUrl.searchParams.get("now_ts")) || Math.floor(Date.now() / 1000)) });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/liveops/tick"
    ) {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const nowTs = Number(payload.now_ts || Math.floor(Date.now() / 1000));
      const [players] = await dbPool.execute("SELECT id FROM players ORDER BY id");
      const results = [];
      for (const player of players) results.push({ player_id: player.id, ...(await runLiveopsForPlayer(player.id, nowTs)) });
      await dbPool.execute("INSERT INTO server_jobs (job_name,last_run_at,next_run_at,status,result_json) VALUES ('liveops_tick',NOW(),FROM_UNIXTIME(?),'ok',?) ON DUPLICATE KEY UPDATE last_run_at=VALUES(last_run_at),next_run_at=VALUES(next_run_at),status='ok',result_json=VALUES(result_json)", [periodInfo(nowTs).next_daily_ts, JSON.stringify({ player_count: results.length })]);
      sendJson(res, 200, { ok: true, now_ts: nowTs, results });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/game/battles/start"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const playerUid = payload.player_uid || "";
      const requestedBattleId = payload.battle_id == null ? "" : String(payload.battle_id);
      if (requestedBattleId.length > 36) {
        return sendJson(res, 422, { ok: false, error: "battle_id_too_long", max_length: 36 });
      }
      if (requestedBattleId) payload.battle_id = requestedBattleId;
      let business = dbReady && dbPool ? await getBusinessState(playerUid) : getMemoryBusinessState(playerUid);
      let playerId = null;
      let attachedMercenary = null;
      if (dbReady && dbPool) {
        playerId = await findPlayerId(playerUid);
        if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
        const existingRow = await battleRecordById(payload.battle_id);
        if (existingRow) {
          if (Number(existingRow.player_id) !== Number(playerId)) {
            return sendJson(res, 409, { ok: false, error: "battle_id_conflict" });
          }
          return sendJson(res, 200, {
            ...battleRecordFromRow(existingRow),
            battle_status: existingRow.status,
            idempotent_replay: true,
          });
        }
        const attached = await attachMercenaryHeroes(dbPool, playerId, business, payload.lineup_ids || [], payload.battle_id || "");
        business = attached.business;
        attachedMercenary = attached.loan;
      }
      if (dbReady && dbPool && String(payload.mode || "") === "arena" && Number(payload.opponent_uid || 0) > 0) {
        const bot = await getBot(dbPool, payload.opponent_uid);
        if (!bot) return sendJson(res, 404, { error: "bot_opponent_not_found" });
        payload.enemy_lineup = bot.lineup;
      }
      const battle = startAuthoritativeBattle(business, payload);
      if (!battle.ok) return sendJson(res, battle.status || 409, battle);
      if (dbReady && dbPool) {
        try {
          await persistBattleRecord(playerId, battle);
        } catch (error) {
          if (!error || error.code !== "ER_DUP_ENTRY") throw error;
          const existingRow = await battleRecordById(battle.battle_id);
          if (!existingRow || Number(existingRow.player_id) !== Number(playerId)) {
            return sendJson(res, 409, { ok: false, error: "battle_id_conflict" });
          }
          return sendJson(res, 200, {
            ...battleRecordFromRow(existingRow),
            battle_status: existingRow.status,
            idempotent_replay: true,
          });
        }
        if (attachedMercenary) {
          const use = await useMercenary(dbPool, playerId, {
            loan_id: attachedMercenary.loan_id,
            request_key: `battle:${battle.battle_id}`,
            battle_id: battle.battle_id,
            battle_mode: battle.mode,
          });
          if (!use.ok) return sendJson(res, Number.isInteger(use.status) ? use.status : 409, use);
          battle.mercenary = { ...attachedMercenary, use };
        }
      } else activeMemoryBattles.set(battle.battle_id, battle);
      sendJson(res, 200, battle);
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/game/battles/finish"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const playerUid = payload.player_uid || "";
      let record;
      let playerId = null;
      if (dbReady && dbPool) {
        playerId = await findPlayerId(playerUid);
        if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
        if (payload.battle_id) {
          const [rows] = await dbPool.execute("SELECT * FROM battle_records WHERE id=? AND player_id=? LIMIT 1", [payload.battle_id, playerId]);
          if (rows.length) record = { ok: true, battle_id: rows[0].id, server_result: rows[0].server_result, simulation: typeof rows[0].simulation_json === "string" ? JSON.parse(rows[0].simulation_json) : rows[0].simulation_json, evidence_level: "server_authoritative_decrypted_unit_and_stage_config" };
        } else record = await latestActiveBattle(playerId, payload.mode || "campaign");
      } else record = activeMemoryBattles.get(payload.battle_id);
      const result = finishAuthoritativeBattle(record, payload.result);
      if (!result.ok) return sendJson(res, result.status || 404, result);
      if (dbReady && dbPool) {
        await persistBattleFinish(playerId, result);
        const mercenary = await settleMercenary(dbPool, playerId, { battle_id: result.battle_id, result: result.result });
        if (mercenary.ok) result.mercenary = mercenary;
      } else activeMemoryBattles.delete(result.battle_id);
      sendJson(res, 200, result);
      return;
    }

    if (
      req.method === "GET" && context.requestUrl.pathname === "/__afk/social/chat"
    ) {
      if (!requireDb(res)) return;
      const playerId = await findPlayerId(context.requestUrl.searchParams.get("player_uid") || "");
      if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
      const result = await chatMessages(dbPool, playerId, {
        recipient_player_id: context.requestUrl.searchParams.get("recipient_player_id"),
        channel: context.requestUrl.searchParams.get("channel") || "world",
      });
      sendJson(res, Number.isInteger(result.status) ? result.status : (result.ok ? 200 : 409), result); return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/bots/status") {
      if (!requireDb(res)) return;
      const [[bots],[guilds]] = await Promise.all([
        dbPool.query("SELECT COUNT(*) count,MIN(rating) min_rating,MAX(rating) max_rating FROM bot_profiles"),
        dbPool.query("SELECT COUNT(*) count FROM bot_guilds"),
      ]);
      sendJson(res, 200, { ok: true, bot_count: Number(bots[0].count), guild_count: Number(guilds[0].count), min_rating: Number(bots[0].min_rating), max_rating: Number(bots[0].max_rating), authority: "local_official_config_driven_bots" }); return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/bots/opponents") {
      if (!requireDb(res)) return;
      const playerId = await findPlayerId(context.requestUrl.searchParams.get("player_uid") || "");
      if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
      sendJson(res, 200, { ok: true, opponents: await arenaOpponents(dbPool, playerId, Number(context.requestUrl.searchParams.get("count") || 5)) }); return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/bots/guilds") {
      if (!requireDb(res)) return;
      sendJson(res, 200, { ok: true, guilds: await botGuilds(dbPool) }); return;
    }

    if (
      req.method === "POST" && context.requestUrl.pathname === "/__afk/social/chat"
    ) {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const playerId = await findPlayerId(payload.player_uid || "");
      if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
      const result = await sendChat(dbPool, playerId, payload);
      if (result.ok && result.channel === "world") result.bot_reply = await botChatReply(dbPool, result.channel, payload.message);
      sendJson(res, Number.isInteger(result.status) ? result.status : (result.ok ? 201 : 409), result); return;
    }

    if (
      req.method === "GET" && context.requestUrl.pathname === "/__afk/social/friends"
    ) {
      if (!requireDb(res)) return;
      const playerId = await findPlayerId(context.requestUrl.searchParams.get("player_uid") || "");
      if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
      sendJson(res, 200, await socialSnapshot(dbPool, playerId)); return;
    }

    if (req.method === "POST" && context.requestUrl.pathname === "/__afk/social/session") {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const identity = await authenticateToken(dbPool, String(payload.token || ""));
      if (!identity?.player_id) return sendJson(res, 401, { ok: false, error: "invalid_social_session" });
      const self = (await socialSummaries(dbPool, [Number(identity.player_id)]))[0] || null;
      sendJson(res, 200, { ok: true, player_id: Number(identity.player_id), player_uid: identity.player_uid, self }); return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/social/users") {
      if (!requireDb(res)) return;
      const ids = String(context.requestUrl.searchParams.get("ids") || "")
        .split(",").map(Number).filter((value) => Number.isInteger(value) && value > 0).slice(0, 100);
      sendJson(res, 200, { ok: true, users: await socialSummaries(dbPool, ids) }); return;
    }

    if (
      req.method === "POST" && context.requestUrl.pathname === "/__afk/social/friends"
    ) {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const playerId = await findPlayerId(payload.player_uid || "");
      const botId = Number(payload.bot_id || 0);
      if (playerId && botId) {
        if (!(await getBot(dbPool, botId))) return sendJson(res, 404, { error: "bot_not_found" });
        if (payload.action === "remove") await dbPool.execute("DELETE FROM bot_friendships WHERE player_id=? AND bot_id=?", [playerId, botId]);
        else await dbPool.execute("INSERT INTO bot_friendships (player_id,bot_id,status) VALUES (?,?,'accepted') ON DUPLICATE KEY UPDATE status='accepted'", [playerId, botId]);
        sendJson(res, 200, { ok: true, action: payload.action || "accept", bot_id: botId, is_robot: true }); return;
      }
      const friendId = Number(payload.friend_player_id || 0);
      if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
      const action = String(payload.action || "request");
      const mapping = {
        request: ["friend", "apply", { field_1: [friendId] }],
        accept: ["friend", "handle_app", { field_1: 1, field_2: friendId }],
        reject: ["friend", "handle_app", { field_1: 2, field_2: friendId }],
        accept_all: ["friend", "handle_app", { field_1: 3 }],
        reject_all: ["friend", "handle_app", { field_1: 4 }],
        remove: ["friend", "remove", { field_1: [friendId] }],
        block: ["ublacklist", "add", { value: friendId }],
        unblock: ["ublacklist", "remove", { value: friendId }],
        search: ["friend", "search", { field_1: Number(payload.id || friendId || 0), field_2: payload.name || "" }],
      };
      const command = mapping[action];
      if (!command) return sendJson(res, 422, { error: "invalid_friend_action" });
      const result = await executeSocialProtocolAction(dbPool, playerId, ...command);
      sendJson(res, Number.isInteger(result.status) ? result.status : (result.ok ? 200 : 409), result); return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/social/events") {
      if (!requireDb(res)) return;
      const playerId = await findPlayerId(context.requestUrl.searchParams.get("player_uid") || "");
      if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
      const afterId = Math.max(0, Number(context.requestUrl.searchParams.get("after_id") || 0));
      const [events] = await dbPool.execute(
        "SELECT id,actor_player_id,event_type,payload_json,read_at,created_at FROM social_events WHERE recipient_player_id=? AND id>? ORDER BY id LIMIT 200",
        [playerId, afterId]
      );
      sendJson(res, 200, { ok: true, events, next_after_id: events.length ? Number(events[events.length - 1].id) : afterId }); return;
    }

    if (req.method === "POST" && context.requestUrl.pathname === "/__afk/social/events/ack") {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const playerId = await findPlayerId(payload.player_uid || "");
      const throughId = Math.max(0, Number(payload.through_id || 0));
      if (!playerId || !throughId) return sendJson(res, 422, { error: "invalid_social_ack" });
      const [updated] = await dbPool.execute("UPDATE social_events SET read_at=COALESCE(read_at,NOW()) WHERE recipient_player_id=? AND id<=?", [playerId, throughId]);
      sendJson(res, 200, { ok: true, acknowledged: updated.affectedRows, through_id: throughId }); return;
    }

    if (req.method === "POST" && context.requestUrl.pathname === "/__afk/social/friends/gift") {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const playerId = await findPlayerId(payload.player_uid || "");
      if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
      const action = String(payload.action || "send");
      if (!["send", "receive"].includes(action)) return sendJson(res, 422, { error: "invalid_friend_gift_action" });
      const ids = Array.isArray(payload.friend_player_ids) ? payload.friend_player_ids.map(Number) : payload.friend_player_id ? [Number(payload.friend_player_id)] : [];
      const result = await executeFriendGift(dbPool, playerId, action, ids, payload.now_ts);
      sendJson(res, Number.isInteger(result.status) ? result.status : (result.ok ? 200 : 409), result); return;
    }

    if (req.method === "POST" && context.requestUrl.pathname === "/__afk/social/mercenary") {
      if (!requireDb(res)) return;
      const payload = safeParseJson(bodyBuffer.toString("utf8")) || {};
      const playerId = await findPlayerId(payload.player_uid || "");
      if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
      let result;
      if (payload.action === "use") result = await useMercenary(dbPool, playerId, payload);
      else if (payload.action === "settle") result = await settleMercenary(dbPool, playerId, payload);
      else {
        const map = {
          offer: ["mercenary", "add", { value: payload.hero_id }],
          remove_offer: ["mercenary", "remove", { value: payload.hero_id }],
          request: ["apostle", "apply", { field_1: payload.owner_player_id, field_2: payload.hero_id }],
          accept: ["apostle", "handle_apply", { field_1: 1, field_2: payload.borrower_player_id, field_3: payload.hero_id }],
          reject: ["apostle", "handle_apply", { field_1: 2, field_2: payload.borrower_player_id, field_3: payload.hero_id }],
          cancel: ["apostle", "cancel_apply", { field_2: payload.hero_id }],
          return: ["apostle", "return_hero", { value: payload.hero_id }],
          friend_heroes: ["apostle", "req_friend_heroes", { value: payload.hero_id }],
          panel: ["apostle", "open_apostle_panel", {}],
        };
        const command = map[payload.action || "panel"];
        result = command ? await executeSocialProtocolAction(dbPool, playerId, ...command) : { ok: false, status: 422, error: "invalid_mercenary_action" };
      }
      sendJson(res, Number.isInteger(result.status) ? result.status : (result.ok ? 200 : 409), result); return;
    }

    if (req.method === "GET" && context.requestUrl.pathname === "/__afk/social/rankings") {
      if (!requireDb(res)) return;
      const playerId = await findPlayerId(context.requestUrl.searchParams.get("player_uid") || "");
      if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
      const board = String(context.requestUrl.searchParams.get("board") || "power");
      if (!["power", "friend", "guild"].includes(board)) return sendJson(res, 422, { error: "invalid_ranking_board" });
      sendJson(res, 200, await socialRankings(dbPool, playerId, board, Number(context.requestUrl.searchParams.get("limit") || 100))); return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/game/action"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      const playerUid = payload.player_uid || payload.playerUid || "";
      if (dbReady && dbPool && GUILD_ACTIONS.has(String(payload.op || ""))) {
        await handleGuildGameAction(res, payload, playerUid);
        return;
      }
      const currentState = dbReady && dbPool
        ? await getBusinessState(playerUid)
        : getMemoryBusinessState(playerUid);
      let actionPayload = { ...payload };
      let playerId = null;
      let gameActionRequestKey = null;
      let selectedBot = null;
      if (dbReady && dbPool) {
        playerId = await findPlayerId(playerUid);
        if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
        gameActionRequestKey = payload.idempotency_key
          ? String(payload.idempotency_key).slice(0, 191)
          : (payload.request_seq == null ? null : `${String(payload.op || "action")}:${String(payload.request_seq)}`.slice(0, 191));
        const replay = await readGameActionReceipt(playerId, gameActionRequestKey);
        if (replay) return sendJson(res, 200, replay);
        if (["arena_open","arena_refresh"].includes(payload.op)) actionPayload.bot_opponents = await arenaOpponents(dbPool, playerId, 5);
        if (["arena_query_lineup","arena_challenge"].includes(payload.op)) {
          selectedBot = await getBot(dbPool, payload.opponent_uid || payload.bot_id);
          if (!selectedBot) return sendJson(res, 404, { error: "bot_opponent_not_found" });
          actionPayload.bot_opponent = selectedBot;
          if (payload.op === "arena_challenge") {
            const battle = startAuthoritativeBattle(currentState, { mode: "arena", stage_id: selectedBot.bot_id, opponent_uid: selectedBot.bot_id, enemy_lineup: selectedBot.lineup, lineup_ids: payload.lineup_ids || [] });
            if (!battle.ok) return sendJson(res, battle.status || 409, battle);
            actionPayload.victory = battle.server_result === "victory";
            actionPayload.authoritative_battle = battle;
          }
        }
        if (payload.op === "arena_records") actionPayload.bot_records = await botBattleRecords(dbPool, playerId);
        if (["guild_open","guild_search"].includes(payload.op)) actionPayload.bot_guilds = await botGuilds(dbPool);
        if (payload.op === "guild_members") {
          const guildId = Number(payload.guild_id || currentState.inventory.find((row)=>row.item_id==="meta_guild_id")?.quantity || 1);
          actionPayload.bot_members = await botGuildMembers(dbPool, guildId);
        }
      }
      let transition = gameAction(currentState, actionPayload);
      if (actionPayload.authoritative_battle) transition.authoritative_battle = actionPayload.authoritative_battle;
      if (!transition.ok) {
        sendJson(res, transition.status || 409, transition);
        return;
      }
      if (payload.op === "maze_query" && ["normal", "elite", "boss", "goblin", "bloody_carriage"].includes(transition.cell?.type)) {
        transition.authoritative_battle = {
          mode: "maze", stage_id: Number(transition.cell.id), enemy_team: enemyTeam("maze", Number(transition.cell.id)),
        };
      }
      if (dbReady && dbPool) {
        transition = await persistGameTransition(playerId, transition, gameActionRequestKey ? { module: "game_action", key: gameActionRequestKey } : null);
      } else {
        for (const item of transition.inventory || []) upsertMemoryInventoryItem(item);
        const characters = [];
        if (transition.character) characters.push(transition.character);
        for (const character of transition.characters || []) {
          if (!characters.some((row) => String(row.character_id) === String(character.character_id))) characters.push(character);
        }
        for (const character of characters) upsertMemoryCharacter(character);
        if (Array.isArray(transition.remove_characters) && transition.remove_characters.length) {
          const removed = new Set(transition.remove_characters.map(String));
          state.business.characters = state.business.characters.filter((row) => !removed.has(String(row.character_id)));
        }
      }
      const updatedState = dbReady && dbPool
        ? await getBusinessState(playerUid)
        : getMemoryBusinessState(playerUid);
      if (dbReady && dbPool && payload.op === "arena_challenge" && selectedBot) {
        const battle = actionPayload.authoritative_battle;
        if (battle?.ok) {
          await persistBattleRecord(playerId, battle);
          await persistBattleFinish(
            playerId,
            finishAuthoritativeBattle(battle, battle.server_result)
          );
        }
        const replayId = Number(String(Date.now()).slice(-15));
        await recordBotBattle(dbPool, playerId, selectedBot, transition.battle_result === 1 ? "victory" : "defeat", transition.battle_result === 1 ? 10 : -2, replayId);
        transition.replay_id = replayId;
      }
      sendJson(res, 200, { ...transition, businessState: updatedState });
      return;
    }

    if (
      req.method === "GET" &&
      context.requestUrl.pathname === "/__afk/game/idle"
    ) {
      const playerUid = context.requestUrl.searchParams.get("player_uid") || "";
      const currentState = dbReady && dbPool
        ? await getBusinessState(playerUid)
        : getMemoryBusinessState(playerUid);
      const now = Math.floor(Date.now() / 1000);
      const lastClaim = Number(
        currentState.inventory.find((item) => item.item_id === "meta_idle_last_claim_ts")?.quantity || now
      );
      const currentStage = Number(
        currentState.inventory.find((item) => item.item_id === "meta_campaign_cur_stage")?.quantity || 13
      );
      sendJson(res, 200, {
        ok: true,
        start_ts: lastClaim,
        end_ts: now,
        elapsed_seconds: Math.max(0, now - lastClaim),
        assets: calculateConfiguredIdleAssets(currentStage, now - lastClaim, false),
        quick_idle: { reward_seconds: 7200, daily_limit: 1 },
        evidence_level: "captured_official_stage_idle_snapshot",
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/game/idle/claim"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      const playerUid = payload.player_uid || payload.playerUid || "";
      const currentState = dbReady && dbPool
        ? await getBusinessState(playerUid)
        : getMemoryBusinessState(playerUid);
      const transition = claimIdleRewards(currentState, payload);
      if (!transition.ok) {
        sendJson(res, transition.status, transition);
        return;
      }
      if (dbReady && dbPool) {
        const playerId = await findPlayerId(playerUid);
        if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
        for (const item of transition.inventory) await upsertInventoryItem(playerId, item);
      } else {
        for (const item of transition.inventory) upsertMemoryInventoryItem(item);
      }
      const updatedState = dbReady && dbPool
        ? await getBusinessState(playerUid)
        : getMemoryBusinessState(playerUid);
      sendJson(res, 200, { ...transition, businessState: updatedState });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/game/stages/result"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      const playerUid = payload.player_uid || payload.playerUid || "";
      if (dbReady && dbPool) {
        const playerId = await findPlayerId(playerUid);
        if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
        const settled = await settleCampaignBattle(playerId, playerUid, payload);
        if (!settled.ok) return sendJson(res, settled.status || 409, settled);
        const updatedState = await getBusinessState(playerUid);
        sendJson(res, 200, { ...settled, businessState: updatedState });
        return;
      }

      const currentState = getMemoryBusinessState(playerUid);
      let battleVerification = null;
      if (payload.battle_id && activeMemoryBattles.has(payload.battle_id)) {
        const active = activeMemoryBattles.get(payload.battle_id);
        battleVerification = finishAuthoritativeBattle(active, payload.result);
        payload.result = battleVerification.result;
        payload.stage_id = active.stage_id;
        activeMemoryBattles.delete(payload.battle_id);
      }
      const transition = campaignBattleResult(currentState, {
        ...payload,
        completed_replay_stage: CLIENT_MAX_CAMPAIGN_STAGE,
      });
      if (!transition.ok) {
        sendJson(res, transition.status, transition);
        return;
      }
      for (const item of transition.inventory) upsertMemoryInventoryItem(item);
      upsertMemoryStageProgress({
        stage_id: transition.stage.stage_id,
        cleared: transition.stage.cleared,
        best_result: transition.stage.best_result,
      });
      const updatedState = getMemoryBusinessState(playerUid);
      sendJson(res, 200, { ...transition, battleVerification, businessState: updatedState });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/game/heroes/upgrade"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }

      const playerUid = payload.player_uid || payload.playerUid || "";
      let transition;
      if (dbReady && dbPool) {
        const playerId = await findPlayerId(playerUid);
        if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
        transition = await executeHeroUpgrade(playerId, playerUid, payload);
      } else {
        transition = observedHeroUpgrade(getMemoryBusinessState(playerUid), payload);
      }
      if (!transition.ok) {
        sendJson(res, transition.status, transition);
        writeRequestLog(baseRecord, {
          action: "official_game_rule",
          status_code: transition.status,
          response_body_preview: previewText(JSON.stringify(transition)),
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      if (!dbReady || !dbPool) {
        for (const item of transition.inventory) {
          upsertMemoryInventoryItem(item);
        }
        upsertMemoryCharacter(transition.character);
      }

      const updatedState = dbReady && dbPool
        ? await getBusinessState(playerUid)
        : getMemoryBusinessState(playerUid);
      const responsePayload = {
        ok: true,
        official_rule: "hero_upgrade.observed_case",
        idempotent_replay: Boolean(transition.idempotent_replay),
        reply_unit: {
          reply_up_level: {
            new_hero: transition.character,
            reward: {},
            cost: { assets: transition.rule.cost },
          },
        },
        businessState: updatedState,
      };
      sendJson(res, 200, responsePayload);
      writeRequestLog(baseRecord, {
        action: "official_game_rule",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(responsePayload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/game/tasks/batch-claim"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      const playerUid = payload.player_uid || payload.playerUid || "";
      const currentState = dbReady && dbPool
        ? await getBusinessState(playerUid)
        : getMemoryBusinessState(playerUid);
      const transition = taskBatchClaim(currentState, payload);
      if (!transition.ok) {
        sendJson(res, transition.status, transition);
        return;
      }
      if (dbReady && dbPool) {
        const playerId = await findPlayerId(playerUid);
        if (!playerId) {
          sendJson(res, 404, { error: "player_not_found" });
          return;
        }
        for (const item of transition.inventory) await upsertInventoryItem(playerId, item);
      } else {
        for (const item of transition.inventory) upsertMemoryInventoryItem(item);
      }
      const updatedState = dbReady && dbPool
        ? await getBusinessState(playerUid)
        : getMemoryBusinessState(playerUid);
      const responsePayload = {
        ok: true,
        evidence_level: "captured_reply",
        reply_task: { batch_todo_reward: { id: 0, ids: transition.ids } },
        businessState: updatedState,
      };
      sendJson(res, 200, responsePayload);
      writeRequestLog(baseRecord, {
        action: "official_game_rule",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(responsePayload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/game/tavern/draw"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      const playerUid = payload.player_uid || payload.playerUid || "";
      let transition;
      if (dbReady && dbPool) {
        const playerId = await findPlayerId(playerUid);
        if (!playerId) return sendJson(res, 404, { error: "player_not_found" });
        transition = await executeTavernDraw(playerId, playerUid, payload);
      } else {
        transition = tavernDraw(getMemoryBusinessState(playerUid), payload);
      }
      if (!transition.ok) {
        sendJson(res, transition.status, transition);
        return;
      }
      if (!dbReady || !dbPool) {
        for (const item of transition.inventory) {
          upsertMemoryInventoryItem(item);
        }
        for (const character of transition.characters) {
          upsertMemoryCharacter(character);
        }
      }
      const updatedState = dbReady && dbPool
        ? await getBusinessState(playerUid)
        : getMemoryBusinessState(playerUid);
      const responsePayload = {
        ok: true,
        evidence_level: transition.evidence_level,
        idempotent_replay: Boolean(transition.idempotent_replay),
        reply_tavern: {
          draw: {
            reward: {
              heroes: transition.rewards.filter((reward) => Number.isFinite(Number(reward.tid))),
              assets: transition.reward_assets || transition.rewards.filter((reward) => !Number.isFinite(Number(reward.tid))),
            },
            cost: { assets: [transition.cost] },
          },
        },
        businessState: updatedState,
      };
      sendJson(res, 200, responsePayload);
      writeRequestLog(baseRecord, {
        action: "official_game_rule",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(responsePayload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "GET" &&
      context.requestUrl.pathname === "/__afk/db/business-state"
    ) {
      const playerUid = context.requestUrl.searchParams.get("player_uid") || "";
      const payload = dbReady && dbPool
        ? await getBusinessState(playerUid)
        : getMemoryBusinessState(playerUid);
      sendJson(res, 200, payload);
      writeRequestLog(baseRecord, {
        action: "control",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(payload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/db/inventory"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, {
          error: "invalid_json",
          message: "Expected a JSON object body.",
        });
        writeRequestLog(baseRecord, {
          action: "control",
          status_code: 400,
          response_body_preview: "invalid_json",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      if (!dbReady || !dbPool) {
        upsertMemoryInventoryItem(payload);
        const statePayload = getMemoryBusinessState(payload.player_uid || payload.playerUid || "");
        sendJson(res, 200, statePayload);
        writeRequestLog(baseRecord, {
          action: "control",
          status_code: 200,
          response_body_preview: previewText(JSON.stringify(statePayload)),
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      const playerId = await findPlayerId(payload.player_uid || payload.playerUid || "");
      if (!playerId) {
        sendJson(res, 404, { error: "player_not_found" });
        writeRequestLog(baseRecord, {
          action: "control",
          status_code: 404,
          response_body_preview: "player_not_found",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      await upsertInventoryItem(playerId, payload);
      const statePayload = await getBusinessState(payload.player_uid || payload.playerUid || "");
      sendJson(res, 200, statePayload);
      writeRequestLog(baseRecord, {
        action: "control",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(statePayload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/db/characters"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, {
          error: "invalid_json",
          message: "Expected a JSON object body.",
        });
        writeRequestLog(baseRecord, {
          action: "control",
          status_code: 400,
          response_body_preview: "invalid_json",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      if (!dbReady || !dbPool) {
        upsertMemoryCharacter(payload);
        const statePayload = getMemoryBusinessState(payload.player_uid || payload.playerUid || "");
        sendJson(res, 200, statePayload);
        writeRequestLog(baseRecord, {
          action: "control",
          status_code: 200,
          response_body_preview: previewText(JSON.stringify(statePayload)),
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      const playerId = await findPlayerId(payload.player_uid || payload.playerUid || "");
      if (!playerId) {
        sendJson(res, 404, { error: "player_not_found" });
        writeRequestLog(baseRecord, {
          action: "control",
          status_code: 404,
          response_body_preview: "player_not_found",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      await upsertCharacter(playerId, payload);
      const statePayload = await getBusinessState(payload.player_uid || payload.playerUid || "");
      sendJson(res, 200, statePayload);
      writeRequestLog(baseRecord, {
        action: "control",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(statePayload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname === "/__afk/db/stages"
    ) {
      const payload = safeParseJson(bodyBuffer.toString("utf8"));
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, {
          error: "invalid_json",
          message: "Expected a JSON object body.",
        });
        writeRequestLog(baseRecord, {
          action: "control",
          status_code: 400,
          response_body_preview: "invalid_json",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      if (!dbReady || !dbPool) {
        upsertMemoryStageProgress(payload);
        const statePayload = getMemoryBusinessState(payload.player_uid || payload.playerUid || "");
        sendJson(res, 200, statePayload);
        writeRequestLog(baseRecord, {
          action: "control",
          status_code: 200,
          response_body_preview: previewText(JSON.stringify(statePayload)),
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      const playerId = await findPlayerId(payload.player_uid || payload.playerUid || "");
      if (!playerId) {
        sendJson(res, 404, { error: "player_not_found" });
        writeRequestLog(baseRecord, {
          action: "control",
          status_code: 404,
          response_body_preview: "player_not_found",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      await upsertStageProgress(playerId, payload);
      const statePayload = await getBusinessState(payload.player_uid || payload.playerUid || "");
      sendJson(res, 200, statePayload);
      writeRequestLog(baseRecord, {
        action: "control",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(statePayload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      (context.requestUrl.pathname === "/api/park/sdk/common/user_agreement" ||
        context.requestUrl.pathname === "/park/sdk/common/user_agreement")
    ) {
      sendJson(res, 200, userAgreementSnapshot);
      writeRequestLog(baseRecord, {
        action: "mock",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(userAgreementSnapshot)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (req.method === "POST" && context.requestUrl.pathname === "/api/sdk/sls/token") {
      const payload = buildSlsToken();
      sendJson(res, 200, payload);
      writeRequestLog(baseRecord, {
        action: "mock",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(payload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "GET" &&
      /^\/park\/parkway\/prod[a-z0-9]+\.json$/i.test(context.requestUrl.pathname)
    ) {
      const payload = buildParkwayConfig();
      sendJson(res, 200, payload);
      writeRequestLog(baseRecord, {
        action: "mock",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(payload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "GET" &&
      /^\/park\/parkway\/prod[a-z0-9]+_report\.json$/i.test(context.requestUrl.pathname)
    ) {
      sendJson(res, 200, parkwayReportSnapshot);
      writeRequestLog(baseRecord, {
        action: "mock",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(parkwayReportSnapshot)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "GET" &&
      context.requestUrl.pathname === "/http/user-service/userstatus"
    ) {
      sendJson(res, 200, state.userStatus);
      writeRequestLog(baseRecord, {
        action: "mock",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(state.userStatus)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      context.requestUrl.pathname.toLowerCase().endsWith("/api/sdk/account/user") &&
      (
        (context.proxiedByMitm && isPlatformLoginHost(context.originalHost)) ||
        isLocalMockHost(context.originalHost || context.req.headers.host)
      )
    ) {
      const loginPayload = buildLocalAccountLoginResponse(context);
      const payload = {
        result: loginPayload.result,
        data: {
          ...loginPayload.data,
          app_id: 6241329,
          appId: 6241329,
          binding_types: [],
          bindingTypes: [],
          third_bindings: [],
          thirdBindings: [],
        },
      };
      sendJson(res, 200, payload);
      writeRequestLog(baseRecord, {
        action: "mock-account-detail",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(payload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      context.proxiedByMitm &&
      isPlatformLoginHost(context.originalHost) &&
      isLocalAccountLoginPath(context.requestUrl.pathname)
    ) {
      const payload = await buildAuthenticatedLocalAccountLoginResponse(context);
      sendJson(res, 200, payload);
      writeRequestLog(baseRecord, {
        action: "mock-account-login",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(payload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (
      isLocalMockHost(context.originalHost || context.req.headers.host) &&
      isLocalAccountLoginPath(context.requestUrl.pathname) &&
      !context.requestUrl.pathname.startsWith("/__afk/")
    ) {
      const payload = await buildAuthenticatedLocalAccountLoginResponse(context);
      sendJson(res, 200, payload);
      writeRequestLog(baseRecord, {
        action: "mock-local-account-login",
        status_code: 200,
        response_body_preview: previewText(JSON.stringify(payload)),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (context.requestUrl.pathname.startsWith("/log/")) {
      sendBuffer(res, 200, EMPTY_OK, {
        "content-type": "application/json; charset=utf-8",
      });
      writeRequestLog(baseRecord, {
        action: "sink",
        status_code: 200,
        response_body_preview: "{}",
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (context.proxiedByMitm && isSinkHost(context.originalHost)) {
      sendBuffer(res, 200, EMPTY_OK, {
        "content-type": "application/json; charset=utf-8",
      });
      writeRequestLog(baseRecord, {
        action: "sink",
        status_code: 200,
        response_body_preview: "{}",
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (PROXY_UNKNOWN && context.proxiedByMitm) {
      const proxied = await proxyUnknownRequest(context);
      sendBuffer(res, proxied.statusCode, proxied.bodyBuffer, proxied.headers);
      writeRequestLog(baseRecord, {
        action: "proxy",
        upstream_url: proxied.upstreamUrl,
        status_code: proxied.statusCode,
        response_body_preview: previewText(proxied.bodyBuffer),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    const payload = {
      error: "unhandled_route",
      method: req.method,
      path: context.requestUrl.pathname,
      original_host: context.originalHost || null,
      note:
        "Route not mocked locally. Enable AFK_PROXY_UNKNOWN=1 when running behind mitmproxy to transparently forward unknown requests.",
    };
    sendJson(res, 404, payload);
    writeRequestLog(baseRecord, {
      action: "miss",
      status_code: 404,
      response_body_preview: previewText(JSON.stringify(payload)),
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    runtimeMetrics.errors += 1;
    const statusCode = Number(error?.status || 500);
    const payload = {
      error: statusCode >= 500 ? "internal_error" : String(error.message || "request_rejected"),
      message: statusCode >= 500 ? String(error && error.stack ? error.stack : error) : String(error.message || error),
    };
    sendJson(res, statusCode, payload);
    writeRequestLog(baseRecord, {
      action: "error",
      status_code: statusCode,
      response_body_preview: previewText(JSON.stringify(payload)),
      duration_ms: Date.now() - startedAt,
    });
  }
}

const httpServer = http.createServer(handleRequest);

let httpsServer = null;
if (HTTPS_PORT > 0) {
  if (!HTTPS_KEY_FILE || !HTTPS_CERT_FILE) {
    throw new Error(
      "HTTPS listener requested but --https-key-file/--https-cert-file were not provided."
    );
  }

  httpsServer = https.createServer(
    {
      key: fs.readFileSync(HTTPS_KEY_FILE),
      cert: fs.readFileSync(HTTPS_CERT_FILE),
    },
    handleRequest
  );
}

const startupMessages = [
  `proxy unknown requests: ${PROXY_UNKNOWN}`,
  `rewrite parkway base_url.sdk: ${SDK_BASE_URL || "<disabled>"}`,
  `local base url: ${LOCAL_BASE_URL || "<disabled>"}`,
  `disable sdk sls: ${DISABLE_SDK_SLS}`,
  `disable auto login: ${DISABLE_AUTO_LOGIN}`,
  `request log: ${REQUEST_LOG}`,
];

let listenersRemaining = httpsServer ? 2 : 1;
let liveopsTimer = null;

function markListenerReady(message) {
  startupMessages.unshift(message);
  listenersRemaining -= 1;
  if (listenersRemaining === 0) {
    console.log(startupMessages.join("\n"));
  }
}

async function shutdown() {
  if (liveopsTimer) clearInterval(liveopsTimer);
  await closePool(dbPool).catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

async function main() {
  await initializeDb();

  if (DB_ENABLED) {
    startupMessages.push(
      `mysql: ${dbReady ? "ready" : "fallback"} (${process.env.AFK_DB_NAME || process.env.MYSQL_DATABASE || DEFAULT_DB_NAME})`
    );
  } else {
    startupMessages.push("mysql: disabled");
  }

  if (dbReady && dbPool) {
    const tick = async () => {
      try {
        const [players] = await dbPool.execute("SELECT id FROM players ORDER BY id");
        const nowTs = Math.floor(Date.now() / 1000);
        for (const player of players) await runLiveopsForPlayer(player.id, nowTs);
      } catch (error) {
        console.error(`[liveops] tick failed: ${error.message || error}`);
      }
    };
    await tick();
    liveopsTimer = setInterval(tick, 60000);
    liveopsTimer.unref();
    startupMessages.push("liveops scheduler: active (60s)");
  }

  httpServer.listen(PORT, HOST, () => {
    markListenerReady(`local-platform-mock listening on http://${HOST}:${PORT}`);
  });

  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      markListenerReady(`local-platform-mock listening on https://${HOST}:${HTTPS_PORT}`);
    });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
