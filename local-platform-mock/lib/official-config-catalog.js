const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const PROJECT_ROOT = path.join(__dirname, "..");
const LEGACY_CONFIG_ROOT = path.join(PROJECT_ROOT, "data", "official", "client-full");
// Tables decrypted from the exact Classic archive requested by the 1.201
// Android build take precedence over the broader HD configuration snapshot.
// Individual files still fall through to the HD/legacy roots, so this folder
// can be populated incrementally as each split archive is verified.
const CLASSIC_CONFIG_ROOT = path.join(PROJECT_ROOT, "runtime", "official-updates", "1.201.01", "decrypted-config", "classic-cn");
const LATEST_CONFIG_ROOT = path.join(PROJECT_ROOT, "runtime", "official-updates", "1.201.01", "decrypted-config", "en");
const LEGACY_SCRIPT_ROOT = path.join(PROJECT_ROOT, "data", "official", "client-scripts", "srcmodule");
const LATEST_SCRIPT_ROOT = path.join(PROJECT_ROOT, "runtime", "official-updates", "1.201.01", "recovered-client", "srcmodule");
const CONFIG_ROOTS = [process.env.AFK_OFFICIAL_CONFIG_ROOT, CLASSIC_CONFIG_ROOT, LATEST_CONFIG_ROOT, LEGACY_CONFIG_ROOT]
  .filter(Boolean).map((entry) => path.resolve(entry));
const SCRIPT_ROOTS = [process.env.AFK_OFFICIAL_SCRIPT_ROOT, LATEST_SCRIPT_ROOT, LEGACY_SCRIPT_ROOT]
  .filter(Boolean).map((entry) => path.resolve(entry));
const CONFIG_ROOT = CONFIG_ROOTS.find((entry) => fs.existsSync(entry)) || LEGACY_CONFIG_ROOT;
const SCRIPT_ROOT = SCRIPT_ROOTS.find((entry) => fs.existsSync(entry)) || LEGACY_SCRIPT_ROOT;
const cache = new Map();

function configPath(name) {
  if (!/^[A-Za-z0-9_]+$/.test(String(name || ""))) throw new Error("invalid_config_name");
  const fileName = `${name}.json`;
  return CONFIG_ROOTS.map((root) => path.join(root, fileName)).find((file) => fs.existsSync(file)) || path.join(CONFIG_ROOT, fileName);
}

function unwrap(document) {
  if (!document || typeof document !== "object") return {};
  const ed = document.ed && typeof document.ed === "object" ? document.ed : document;
  const keys = Object.keys(ed);
  return keys.length === 1 && ed[keys[0]] && typeof ed[keys[0]] === "object" ? ed[keys[0]] : ed;
}

function loadConfig(name) {
  const key = String(name);
  if (!cache.has(key)) {
    const file = configPath(key);
    const raw = fs.readFileSync(file, "utf8");
    cache.set(key, { name: key, file, sha256: createHash("sha256").update(raw).digest("hex"), table: unwrap(JSON.parse(raw)) });
  }
  return cache.get(key);
}

function hasConfig(name) {
  try { return fs.existsSync(configPath(name)); } catch { return false; }
}

function listConfigs() {
  const names = new Set();
  for (const root of CONFIG_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (name.endsWith(".json") && !name.startsWith("manifest-")) names.add(name.slice(0, -5));
    }
  }
  return [...names].sort();
}

function rows(name) { return Object.values(loadConfig(name).table); }
function row(name, id) { return loadConfig(name).table[String(id)] || null; }

function battleEvidence() {
  const file = SCRIPT_ROOTS.map((root) => path.join(root, "game_battle.js")).find((entry) => fs.existsSync(entry));
  if (!file) throw new Error("official_battle_script_missing");
  const raw = fs.readFileSync(file);
  const latest = path.resolve(file).startsWith(path.resolve(LATEST_SCRIPT_ROOT));
  return {
    client_version: latest ? "1.201.01.360409" : "1.182.03.301371",
    recovered_script: path.relative(PROJECT_ROOT, file).replaceAll("\\", "/"),
    bytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
    config_count: listConfigs().length,
    config_roots: CONFIG_ROOTS.filter((entry) => fs.existsSync(entry)).map((entry) => path.relative(PROJECT_ROOT, entry).replaceAll("\\", "/")),
    evidence_level: "decrypted_official_client_artifact",
  };
}

module.exports = { CONFIG_ROOT, CONFIG_ROOTS, SCRIPT_ROOT, SCRIPT_ROOTS, battleEvidence, hasConfig, listConfigs, loadConfig, row, rows };
