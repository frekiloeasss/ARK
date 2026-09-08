const test = require("node:test");
const assert = require("node:assert/strict");
const social = require("../lib/social-service");

test("social protocol scalar decoder accepts nested and repeated protobuf projections", () => {
  assert.equal(social.scalar({ field_1: { value: 69 } }), 69);
  assert.deepEqual(social.values([{ field_1: 69 }, 70, 69]), [69, 70]);
});

test("private channels are stable and independent of sender order", () => {
  assert.equal(social.privateChannel(70, 68), "private:68:70");
  assert.equal(social.privateChannel(68, 70), "private:68:70");
});

test("daily and weekly periods use server timestamps", () => {
  assert.equal(social.dayOf(172800), 2);
  assert.equal(social.weekOf(1209600), 2);
});
