"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function has(name) { return process.argv.includes(name); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

function findAdb() {
  const candidates = [
    arg("--adb", ""), process.env.AFK_TEST_ADB_PATH, process.env.ADB,
    "D:\\study\\MuMuPlayer\\nx_device\\12.0\\shell\\adb.exe",
    "C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell\\adb.exe",
    "adb",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "adb" || fs.existsSync(candidate)) {
      const result = spawnSync(candidate, ["version"], { encoding: "utf8", windowsHide: true });
      if (result.status === 0) return candidate;
    }
  }
  throw new Error("adb_not_found: set AFK_TEST_ADB_PATH or pass --adb");
}

function connectedDevices(adb) {
  const result = spawnSync(adb, ["devices"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`adb_devices_failed: ${result.stderr || result.stdout}`);
  return result.stdout.split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === "device").map((parts) => parts[0]);
}

function selectSerial(adb) {
  const explicit = arg("--serial", process.env.AFK_TEST_ADB_SERIAL || "");
  const devices = connectedDevices(adb);
  if (explicit) {
    if (!devices.includes(explicit)) throw new Error(`requested_test_device_not_connected:${explicit}`);
    return explicit;
  }
  const primary = process.env.AFK_DEV_ADB_SERIAL || "";
  const dedicated = devices.find((serial) => serial !== primary);
  if (dedicated) return dedicated;
  if (devices.length && has("--allow-primary")) return devices[0];
  throw new Error("dedicated_test_device_required: start a second emulator or pass --allow-primary explicitly");
}

function adbRun(adb, serial, args, options = {}) {
  const result = spawnSync(adb, ["-s", serial, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`adb_failed:${args.join(" ")}:${String(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

function loadScenarios() {
  const file = path.resolve(arg("--scenarios", path.join(root, "data", "device-scenarios-1.201.json")));
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return { file, scenarios: (parsed.scenarios || []).filter((scenario) => scenario.enabled !== false) };
}

function websocketEvidenceSince(startedAt) {
  const file = path.join(root, "logs", "ws-frames.jsonl");
  if (!fs.existsSync(file)) return [];
  const threshold = new Date(startedAt).getTime();
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return new Date(entry.ts || 0).getTime() >= threshold ? [entry] : [];
    } catch { return []; }
  });
}

async function serviceHealth(baseUrl) {
  const response = await fetch(`${baseUrl}/__afk/health`, { signal: AbortSignal.timeout(5000) });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(`service_unhealthy:${JSON.stringify(payload)}`);
  return payload;
}

function collect(adb, serial, directory, label) {
  const screenshot = adbRun(adb, serial, ["exec-out", "screencap", "-p"], { encoding: null });
  fs.writeFileSync(path.join(directory, `${label}.png`), screenshot.stdout);
  // Capture the game log before invoking Android's UI automation service. Some
  // emulator builds crash the short-lived uiautomator command itself when a
  // stale service is registered; that must never be reported as a game crash.
  const logcat = adbRun(adb, serial, ["logcat", "-d", "-v", "threadtime"], { encoding: "utf8", allowFailure: true });
  fs.writeFileSync(path.join(directory, `${label}.logcat.txt`), logcat.stdout || "", "utf8");
  adbRun(adb, serial, ["shell", "uiautomator", "dump", "/sdcard/afk-device-window.xml"], { encoding: "utf8", allowFailure: true });
  const ui = adbRun(adb, serial, ["exec-out", "cat", "/sdcard/afk-device-window.xml"], { encoding: "utf8", allowFailure: true });
  fs.writeFileSync(path.join(directory, `${label}.xml`), ui.stdout || "", "utf8");
  return { ui: ui.stdout || "", logcat: logcat.stdout || "", screenshot_bytes: screenshot.stdout?.length || 0 };
}

async function executeStep(adb, serial, packageName, step) {
  if (step.action === "launch") {
    adbRun(adb, serial, ["shell", "am", "force-stop", packageName], { encoding: "utf8" });
    adbRun(adb, serial, ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"], { encoding: "utf8" });
  } else if (step.action === "tap") {
    adbRun(adb, serial, ["shell", "input", "tap", String(step.x), String(step.y)], { encoding: "utf8" });
  } else if (step.action === "back") {
    adbRun(adb, serial, ["shell", "input", "keyevent", "4"], { encoding: "utf8" });
  } else if (step.action === "shell") {
    adbRun(adb, serial, ["shell", ...String(step.command || "").split(/\s+/).filter(Boolean)], { encoding: "utf8" });
  } else if (step.action !== "wait") {
    throw new Error(`unsupported_device_step:${step.action}`);
  }
  if (Number(step.wait_ms || 0) > 0) await delay(Math.min(60000, Number(step.wait_ms)));
}

async function runOnce(adb, serial, config, packageName, baseUrl) {
  await serviceHealth(baseUrl);
  const runId = stamp();
  const runDir = path.join(root, "runtime", "device-runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  adbRun(adb, serial, ["logcat", "-c"], { encoding: "utf8", allowFailure: true });
  const startedAt = new Date().toISOString();
  const results = [];

  for (const scenario of config.scenarios) {
    const scenarioStarted = Date.now();
    const scenarioStartedAt = new Date(scenarioStarted).toISOString();
    let error = null;
    try {
      for (const step of scenario.steps || []) await executeStep(adb, serial, packageName, step);
    } catch (caught) { error = caught.message || String(caught); }
    const evidence = collect(adb, serial, runDir, scenario.name.replace(/[^A-Za-z0-9_-]/g, "_"));
    const fatalPatterns = scenario.forbidden_log_patterns || ["FATAL EXCEPTION", "ANR in com.lilithgame.hgame.gp", "protobuf.*required", "CRC mismatch"];
    const fatal = fatalPatterns.find((pattern) => new RegExp(pattern, "is").test(evidence.logcat));
    const required = scenario.required_ui_patterns || [];
    const missing = required.filter((pattern) => !new RegExp(pattern, "i").test(evidence.ui));
    const requiredLogs = scenario.required_log_patterns || [];
    const missingLogs = requiredLogs.filter((pattern) => !new RegExp(pattern, "is").test(evidence.logcat));
    const wsEvidence = websocketEvidenceSince(scenarioStartedAt);
    const requiredWsKinds = scenario.required_ws_request_kinds || [];
    const missingWsKinds = requiredWsKinds.filter((kind) => !wsEvidence.some((entry) => entry.request_kind === kind && entry.direction === "client_to_local_structured"));
    const requiredWsModules = scenario.required_ws_modules || [];
    const missingWsModules = requiredWsModules.filter((module) => !wsEvidence.some((entry) => entry.event === "generic_protocol_route_served" && entry.module === module && entry.persisted === true));
    const process = adbRun(adb, serial, ["shell", "pidof", packageName], { encoding: "utf8", allowFailure: true });
    const processAlive = Boolean(String(process.stdout || "").trim());
    const validScreenshot = evidence.screenshot_bytes > 4096;
    const dbAsserted = requiredWsKinds.length + requiredWsModules.length > 0 && !missingWsKinds.length && !missingWsModules.length;
    const ok = !error && !fatal && !missing.length && !missingLogs.length && !missingWsKinds.length && !missingWsModules.length && processAlive && validScreenshot;
    results.push({
      name: scenario.name, modules: scenario.modules || [], ok, ui_pass: ok,
      db_pass: Boolean(ok && dbAsserted), idempotent_pass: Boolean(ok && scenario.idempotent_asserted),
      reconnect_pass: Boolean(ok && scenario.reconnect_asserted), process_alive: processAlive,
      screenshot_bytes: evidence.screenshot_bytes,
      duration_ms: Date.now() - scenarioStarted,
      websocket_evidence_count: wsEvidence.length,
      error: error || (fatal ? `fatal_log:${fatal}` : missing.length ? `missing_ui:${missing.join(",")}` : missingLogs.length ? `missing_log:${missingLogs.join(",")}` : missingWsKinds.length ? `missing_ws_kind:${missingWsKinds.join(",")}` : missingWsModules.length ? `missing_ws_module:${missingWsModules.join(",")}` : !validScreenshot ? "invalid_screenshot" : processAlive ? null : "process_not_running"),
    });
  }
  const manifest = {
    format: "afk-device-run-v1", run_id: runId, started_at: startedAt, finished_at: new Date().toISOString(),
    client_version: "1.201.01.360409", package: packageName, serial, scenario_file: config.file, ok: results.every((result) => result.ok), results,
  };
  fs.writeFileSync(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const builder = spawnSync(process.execPath, [path.join(root, "scripts", "build-device-coverage.js")], { cwd: root, encoding: "utf8", windowsHide: true });
  if (builder.status !== 0) throw new Error(`device_coverage_build_failed:${builder.stderr || builder.stdout}`);
  process.stdout.write(`${JSON.stringify({ run_id: runId, ok: manifest.ok, results, coverage: String(builder.stdout).trim() })}\n`);
  return manifest;
}

async function main() {
  const epochFile = path.join(root, "runtime", "device-coverage-epoch.json");
  if (!fs.existsSync(epochFile) || has("--reset-epoch")) {
    fs.mkdirSync(path.dirname(epochFile), { recursive: true });
    fs.writeFileSync(epochFile, `${JSON.stringify({ format: "afk-device-coverage-epoch-v1", started_at: new Date().toISOString() }, null, 2)}\n`);
  }
  const adb = findAdb();
  const serial = selectSerial(adb);
  const packageName = arg("--package", "com.lilithgame.hgame.gp");
  const baseUrl = arg("--base-url", "http://127.0.0.1:18080");
  const config = loadScenarios();
  const interval = Math.max(60, Number(arg("--interval-seconds", "3600"))) * 1000;
  do {
    try { await runOnce(adb, serial, config, packageName, baseUrl); }
    catch (error) { process.stderr.write(`${error.stack || error}\n`); if (!has("--continuous")) throw error; }
    if (has("--continuous")) await delay(interval);
  } while (has("--continuous"));
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { connectedDevices, findAdb, selectSerial };
