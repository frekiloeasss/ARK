"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const protoRoot = path.resolve(arg("--proto-root", path.join(root, "runtime", "official-updates", "1.201.01", "device-proto")));
const logPath = path.resolve(arg("--log", path.join(root, "logs", "ws-frames.jsonl")));
const runsRoot = path.resolve(arg("--runs", path.join(root, "runtime", "device-runs")));
const outputPath = path.resolve(arg("--output", path.join(root, "runtime", "device-coverage.json")));
const epochPath = path.resolve(arg("--epoch", path.join(root, "runtime", "device-coverage-epoch.json")));
const clientVersion = arg("--client-version", "1.201.01.360409");

function messageBody(source, name) {
  const match = new RegExp(`\\bmessage\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\{`).exec(source);
  if (!match) return "";
  let depth = 0;
  let opened = false;
  for (let index = match.index; index < source.length; index += 1) {
    if (source[index] === "{") { depth += 1; opened = true; }
    if (source[index] === "}" && opened && --depth === 0) return source.slice(match.index, index + 1);
  }
  return "";
}

function fields(source, name) {
  return [...messageBody(source, name).matchAll(/^\s*(optional|required|repeated)\s+([A-Za-z0-9_.<>]+)\s+([A-Za-z0-9_]+)\s*=\s*(\d+)/gm)]
    .map((match) => ({ label: match[1], type: match[2], name: match[3], number: Number(match[4]) }));
}

function moduleForKind(kind, explicitModule = "") {
  if (explicitModule) return explicitModule;
  const original = String(kind || "");
  if (original.startsWith("generic_")) return original.slice("generic_".length);
  const value = original;
  const rules = [
    ["assist_stage", /^hd_assist_stage/], ["deep_stage", /^stage_hd_/], ["stage", /^stage_/],
    ["unit", /^hero_/], ["pvp_arena", /^arena_/], ["tower", /^tower_/], ["maze", /^maze_/],
    ["guild", /^guild_/], ["friend", /^friend_/], ["chat", /^chat_/], ["mail", /^mail_/],
    ["shop", /^shop_/], ["tavern", /^tavern_/], ["task", /^task_/], ["item", /^item_/],
    ["altar", /^altar_/], ["charge", /^charge/], ["heartbeat", /^heartbeat$/],
    ["sdk_login", /^sdk_login$/], ["login", /^login$/], ["reconnect", /^reconnect$/],
  ];
  return rules.find(([, pattern]) => pattern.test(value))?.[0] || value.split("_")[0] || "unknown";
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { rows.push({ event: "invalid_jsonl", raw: line.slice(0, 256) }); }
  }
  return rows;
}

function readRunManifests(directory) {
  if (!fs.existsSync(directory)) return [];
  const found = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.name === "manifest.json") {
        try { found.push(JSON.parse(fs.readFileSync(target, "utf8"))); } catch { /* retained as absent evidence */ }
      }
    }
  }
  return found;
}

function main() {
  const up = fs.readFileSync(path.join(protoRoot, "up.proto"), "utf8");
  const roots = fields(up, "up_msg").filter((field) => field.type.startsWith("req_"));
  const modules = new Map(roots.map((outer) => {
    const name = outer.type.slice(4);
    return [name, {
      module: name,
      request_outer_field: outer.number,
      request_type: outer.type,
      operation_count: fields(up, outer.type).length,
      request_count: 0,
      reply_count: 0,
      ui_pass_count: 0,
      db_pass_count: 0,
      idempotent_pass_count: 0,
      reconnect_pass_count: 0,
      errors: [],
      last_seen_at: null,
    }];
  }));

  const pending = new Map();
  const epoch = fs.existsSync(epochPath) ? JSON.parse(fs.readFileSync(epochPath, "utf8")) : null;
  const epochMs = epoch?.started_at ? new Date(epoch.started_at).getTime() : 0;
  const rows = readJsonLines(logPath).filter((row) => !epochMs || !row.ts || new Date(row.ts).getTime() >= epochMs);
  for (const row of rows) {
    const key = `${row.session_id || 0}:${row.request_seq ?? "none"}`;
    if (row.event === "generic_protocol_route_served") {
      const module = moduleForKind("", row.module);
      const entry = modules.get(module);
      if (entry) {
        entry.request_count = Math.max(entry.request_count, 1);
        entry.reply_count += 1;
        entry.last_seen_at = row.ts || entry.last_seen_at;
        // Empty module probes contain no operation to mutate. A decoded reply
        // is the expected outcome and should not be mislabeled as a failed DB
        // write; concrete operations still require persisted=true.
        if (!row.persisted && row.operation !== "operation_0") {
          entry.errors.push({ ts: row.ts, event: row.event, error: "not_persisted" });
        }
      }
      continue;
    }
    if (row.event === "frame" && String(row.direction || "").startsWith("client_to_")) {
      const module = moduleForKind(row.request_kind);
      const entry = modules.get(module);
      if (entry) {
        entry.request_count += 1;
        entry.last_seen_at = row.ts || entry.last_seen_at;
        pending.set(key, module);
      }
      continue;
    }
    if (row.event === "frame" && String(row.direction || "").includes("to_client")) {
      const module = pending.get(key) || moduleForKind(row.request_kind);
      const entry = modules.get(module);
      if (entry) entry.reply_count += 1;
      pending.delete(key);
      continue;
    }
    if (/unhandled|unmatched|invalid|rejected/.test(String(row.event || ""))) {
      const module = pending.get(key) || moduleForKind(row.request_kind);
      const entry = modules.get(module);
      if (entry) entry.errors.push({ ts: row.ts, event: row.event, request_kind: row.request_kind || null });
    }
  }

  const manifests = readRunManifests(runsRoot)
    .filter((manifest) => !epochMs || !manifest.finished_at || new Date(manifest.finished_at).getTime() >= epochMs)
    .sort((left, right) => new Date(left.finished_at || 0).getTime() - new Date(right.finished_at || 0).getTime());
  const latestDeviceResultByModule = new Map();
  for (const manifest of manifests) {
    for (const result of manifest.results || []) {
      for (const module of result.modules || []) {
        const entry = modules.get(module);
        if (!entry) continue;
        if (result.ui_pass) entry.ui_pass_count += 1;
        if (result.db_pass) entry.db_pass_count += 1;
        if (result.idempotent_pass) entry.idempotent_pass_count += 1;
        if (result.reconnect_pass) entry.reconnect_pass_count += 1;
        latestDeviceResultByModule.set(module, { ok: Boolean(result.ok), ts: manifest.finished_at, scenario: result.name });
      }
    }
  }
  for (const [module, result] of latestDeviceResultByModule) {
    if (!result.ok) modules.get(module)?.errors.push({ ts: result.ts, event: "device_scenario_failed", scenario: result.scenario });
  }

  const outputModules = [...modules.values()].map((entry) => {
    let status = "never_seen";
    if (entry.request_count > 0) status = "request_seen";
    if (entry.reply_count > 0) status = "reply_decoded";
    if (entry.ui_pass_count > 0) status = "ui_pass";
    if (entry.db_pass_count > 0) status = "db_pass";
    if (entry.idempotent_pass_count > 0) status = "idempotent_pass";
    if (entry.reconnect_pass_count > 0) status = "reconnect_pass";
    const lastSuccessAt = entry.last_seen_at ? new Date(entry.last_seen_at).getTime() : 0;
    const latestErrorAt = entry.errors.reduce((latest, error) => Math.max(latest, new Date(error.ts || 0).getTime()), 0);
    if (entry.errors.length && (!lastSuccessAt || latestErrorAt >= lastSuccessAt)) status = "failed";
    return { ...entry, errors: entry.errors.slice(-20), status };
  });
  const count = (status) => outputModules.filter((entry) => entry.status === status).length;
  const report = {
    format: "afk-device-coverage-v1",
    generated_at: new Date().toISOString(),
    client_version: clientVersion,
    evidence: { websocket_log: logPath, device_runs_root: runsRoot, epoch: epoch?.started_at || null, websocket_event_count: rows.length, device_run_count: manifests.length },
    summary: {
      module_count: outputModules.length,
      never_seen: count("never_seen"),
      request_seen: count("request_seen"),
      reply_decoded: count("reply_decoded"),
      ui_pass: count("ui_pass"),
      db_pass: count("db_pass"),
      idempotent_pass: count("idempotent_pass"),
      reconnect_pass: count("reconnect_pass"),
      failed: count("failed"),
      unhandled_event_count: rows.filter((row) => /unhandled|unmatched|invalid/.test(String(row.event || ""))).length,
    },
    modules: outputModules,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}

if (require.main === module) main();
module.exports = { fields, messageBody, moduleForKind };
