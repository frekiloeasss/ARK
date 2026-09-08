const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fields, moduleForKind } = require("../scripts/build-device-coverage");

test("device coverage catalog reads the actual 1.201 HD root", () => {
  const proto = fs.readFileSync(path.join(__dirname, "..", "runtime", "official-updates", "1.201.01", "device-proto", "up.proto"), "utf8");
  const modules = fields(proto, "up_msg").filter((field) => field.type.startsWith("req_"));
  assert.equal(modules.length, 178);
  assert(modules.some((field) => field.type === "req_hero_return"));
  assert(modules.some((field) => field.type === "req_act_farm"));
});

test("device websocket evidence maps specialized and native generic routes", () => {
  assert.equal(moduleForKind("stage_battle_result"), "stage");
  assert.equal(moduleForKind("hd_assist_stage"), "assist_stage");
  assert.equal(moduleForKind("generic_hero_return"), "hero_return");
  assert.equal(moduleForKind("", "act_limit_divine_pool"), "act_limit_divine_pool");
});
