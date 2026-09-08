const test = require("node:test");
const assert = require("node:assert/strict");
const accounts = require("../lib/account-admin-service");

test("password credentials use salted scrypt and constant-time verification", () => {
  const first = accounts.makeCredential("correct-horse-battery");
  const second = accounts.makeCredential("correct-horse-battery");
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(first.sdkHash, second.sdkHash);
  assert.equal(first.sdkHash, accounts.sdkPasswordDigest("correct-horse-battery"));
  assert.equal(accounts.verifyCredential("correct-horse-battery", first.salt, first.hash), true);
  assert.equal(accounts.verifyCredential("wrong-password", first.salt, first.hash), false);
});

test("account input validation rejects weak values", () => {
  assert.throws(() => accounts.validateUsername("x"));
  assert.throws(() => accounts.validatePassword("short"));
  assert.equal(accounts.validateUsername("player_01"), "player_01");
});
