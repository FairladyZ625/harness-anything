// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
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
