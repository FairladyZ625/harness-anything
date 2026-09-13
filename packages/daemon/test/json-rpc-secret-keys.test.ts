// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { isJsonObject, rejectSecretKeys } from "../src/protocol/json-rpc-types.ts";

test("secret-like keys are rejected at any depth while the JSON object check stays shallow", () => {
  assert.deepEqual(rejectSecretKeys({ note: "fine", nested: { detail: { apiKey: "x" } } }), [
    "payload contains a forbidden secret-like key",
  ]);
  assert.deepEqual(rejectSecretKeys({ items: [{ ok: 1 }, { token: "t" }] }), [
    "payload contains a forbidden secret-like key",
  ]);
  assert.deepEqual(rejectSecretKeys({ note: "token appears only in a value" }), []);
  assert.equal(isJsonObject({ nested: { anything: () => 1 } }), true);
  assert.equal(isJsonObject([]), false);
});
