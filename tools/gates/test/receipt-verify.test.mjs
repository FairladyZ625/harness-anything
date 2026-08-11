// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  antiEntropyVerificationKey,
  decodeReceiptToken,
  encodeReceiptToken,
  signReceipt,
  validateReceiptSchema,
  verifyReceipt
} from "../receipt-verify.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/receipts");
const readFixture = (name) => JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8"));
const expectations = { scope: "module:kernel", kind: "line-budget", minimumLimit: 20000, now: new Date("2026-08-11T00:00:00Z") };

test("decision receipt schema and signature verify", () => {
  const receipt = readFixture("valid-line-budget.json");
  assert.deepEqual(validateReceiptSchema(receipt), []);
  assert.deepEqual(verifyReceipt(receipt, expectations), { ok: true, errors: [] });
});

test("altered, expired, and wrong-scope receipt fixtures are rejected", () => {
  const altered = verifyReceipt(readFixture("altered-line-budget.json"), expectations);
  const expired = verifyReceipt(readFixture("expired-line-budget.json"), expectations);
  const wrongScope = verifyReceipt(readFixture("scope-mismatch-line-budget.json"), expectations);
  assert.equal(altered.ok, false);
  assert.match(altered.errors.join("\n"), /signature does not match/u);
  assert.equal(expired.ok, false);
  assert.match(expired.errors.join("\n"), /expired/u);
  assert.equal(wrongScope.ok, false);
  assert.match(wrongScope.errors.join("\n"), /scope must be module:kernel/u);
});

test("anti-entropy review receipt binds verdict and HEAD", () => {
  const key = Buffer.from("anti-entropy-test-key", "utf8");
  const unsigned = {
    scope: "replay-pr:task-lifecycle",
    kind: "anti-entropy-review",
    verdict: "approved",
    headSha: "a".repeat(40),
    expiry: "2099-12-31T23:59:59Z"
  };
  const receipt = { ...unsigned, signature: signReceipt(unsigned, key) };
  const token = encodeReceiptToken(receipt);
  assert.deepEqual(decodeReceiptToken(token), { receipt, errors: [] });
  assert.equal(verifyReceipt(receipt, { key, scope: unsigned.scope, kind: unsigned.kind, verdict: "approved", headSha: unsigned.headSha }).ok, true);
  assert.equal(verifyReceipt(receipt, { key, headSha: "b".repeat(40) }).ok, false);
  assert.match(verifyReceipt(receipt).errors.join("\n"), /verification key is required/u);
});

test("anti-entropy key comes only from the explicit environment variable", () => {
  assert.equal(antiEntropyVerificationKey({}), null);
  assert.equal(antiEntropyVerificationKey({ ANTI_ENTROPY_HMAC_KEY: "" }), null);
  assert.equal(antiEntropyVerificationKey({ ANTI_ENTROPY_HMAC_KEY: "local-key" }).toString("utf8"), "local-key");
});

test("anti-entropy token decoding rejects non-base64url and non-JSON values", () => {
  assert.match(decodeReceiptToken("has=padding").errors.join("\n"), /base64url/u);
  assert.match(decodeReceiptToken(Buffer.from("not json", "utf8").toString("base64url")).errors.join("\n"), /receipt JSON/u);
});
