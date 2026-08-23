// harness-test-tier: contract
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { evaluateProductionDelta, parseProductionDeclaration, parseRetainedPaths } from "../production-delta.mjs";
import { signReceipt } from "../receipt-verify.mjs";
import { makeRepo, writeRepoFile } from "./helpers.mjs";

test("G33 matches the declared production addition and deletion", () => {
  const { rootDir, base } = makeRepo({ "packages/kernel/src/index.ts": "one\ntwo\n" });
  writeRepoFile(rootDir, "packages/kernel/src/index.ts", "one\nthree\nfour\n");
  const result = evaluateProductionDelta({ rootDir, base, prBody: "Production-Delta: +2/-1" });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual({ added: result.computed.added, deleted: result.computed.deleted }, { added: 2, deleted: 1 });
});

test("G33 rejects a missing or inaccurate declaration", () => {
  const { rootDir, base } = makeRepo({ "packages/kernel/src/index.ts": "one\n" });
  writeRepoFile(rootDir, "packages/kernel/src/index.ts", "one\ntwo\n");
  const missing = evaluateProductionDelta({ rootDir, base, prBody: "No delta here" });
  const inaccurate = evaluateProductionDelta({ rootDir, base, prBody: "Production-Delta: +0/-0" });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("\n"), /exactly one Production-Delta/u);
  assert.equal(inaccurate.ok, false);
  assert.match(inaccurate.errors.join("\n"), /does not match computed \+1\/-0/u);
});

test("G33 does not read a Production-Delta value from the next line", () => {
  const result = parseProductionDeclaration("Production-Delta:\n+2/-1");

  assert.equal(result.declaration, null);
  assert.match(result.errors.join("\n"), /exactly one Production-Delta/u);
});

test("G33 does not read a Retained-Path value from the next line", () => {
  const result = parseRetainedPaths([
    "Retained-Path:",
    "packages/kernel/src/legacy.ts until 2099-12-30 per dec_01KZQ92VEPTDRS2HS8CKDBKW2Q"
  ].join("\n"));

  assert.deepEqual(result.declarations, []);
  assert.match(result.errors.join("\n"), /each Retained-Path line must use/u);
});

test("G33 verifies retained production paths against an expiring decision receipt", () => {
  const { rootDir, base } = makeRepo({ "packages/kernel/src/legacy.ts": "legacy\n" });
  const unsigned = {
    decisionId: "dec_01KZQ92VEPTDRS2HS8CKDBKW2Q",
    scope: "retained-path:packages/kernel/src/legacy.ts",
    kind: "retained-path",
    limit: "2099-12-30",
    expiry: "2099-12-31T23:59:59Z"
  };
  writeRepoFile(rootDir, "tools/gates/receipts/retained.json", `${JSON.stringify({ ...unsigned, signature: signReceipt(unsigned) }, null, 2)}\n`);
  const prBody = [
    "Production-Delta: +0/-0",
    "Retained-Path: packages/kernel/src/legacy.ts until 2099-12-30 per dec_01KZQ92VEPTDRS2HS8CKDBKW2Q"
  ].join("\n");
  const result = evaluateProductionDelta({
    rootDir,
    base,
    prBody,
    receiptsDir: path.join(rootDir, "tools/gates/receipts"),
    now: new Date("2026-08-11T00:00:00Z")
  });
  assert.equal(result.ok, true, result.errors.join("\n"));
});
