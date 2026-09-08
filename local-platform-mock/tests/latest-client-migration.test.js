"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const latestRoot = path.join(root, "runtime", "official-updates", "1.201.01");

test("latest client artifacts and recovered protocol are migration-ready", () => {
  const inspection = JSON.parse(fs.readFileSync(path.join(latestRoot, "inspection.json"), "utf8"));
  const sync = JSON.parse(fs.readFileSync(path.join(latestRoot, "sync-result.json"), "utf8"));
  const schema = JSON.parse(fs.readFileSync(path.join(latestRoot, "protocol", "protobuf-schema.json"), "utf8"));
  const routes = JSON.parse(fs.readFileSync(path.join(latestRoot, "protocol", "protocol-route-map.json"), "utf8"));
  assert.equal(inspection.ok, true);
  assert.equal(inspection.package, "com.lilithgame.hgame.gp");
  assert.equal(inspection.version_name, "1.201.01");
  assert.equal(sync.activated, true);
  assert.equal(sync.decrypted_config_count, 5930);
  assert.equal(sync.decrypted_config_failures, 0);
  assert.equal(schema.message_count, 3266);
  assert.equal(schema.enum_count, 239);
  assert.equal(routes.module_count, 222);
  assert.equal(fs.readdirSync(path.join(latestRoot, "recovered-client", "csproto")).filter((name) => name.endsWith(".proto")).length, 6);
});

test("all 1.182 top-level protocol fields remain stable in 1.201", () => {
  const previous = require(path.join(root, "runtime", "protocol-route-map.json")).modules;
  const latest = require(path.join(latestRoot, "protocol", "protocol-route-map.json")).modules;
  const latestByModule = new Map(Object.entries(latest).map(([field, route]) => [route.module, Number(field)]));
  for (const [field, route] of Object.entries(previous)) {
    assert.equal(latestByModule.get(route.module), Number(field), route.module);
  }
});
