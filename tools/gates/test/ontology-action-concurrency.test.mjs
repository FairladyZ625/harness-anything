// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditActionConcurrency, main } from "../ontology-action-concurrency.mjs";
import { captureGate } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("G0-6 ratchet accepts the repository and names every concurrency field missing from an action", () => {
  assert.equal(captureGate(() => main(["--root", repoRoot, "--mode", "ratchet"])).code, 0);
  const fixture = path.join(mkdtempSync(path.join(tmpdir(), "ontology-concurrency-")), "catalog.json");
  const catalog = [{ kind: "task", available: ["start"], actions: [{ id: "start", execution: null }] }];
  writeFileSync(fixture, `${JSON.stringify(catalog)}\n`);
  const result = auditActionConcurrency(catalog);
  assert.deepEqual(result.findings[0].missing, [
    "concurrency",
    "concurrency.expectedVersion",
    "concurrency.leasePolicy",
    "concurrency.occurrenceClaim",
    "concurrency.idempotency",
    "concurrency.artifactOwnership",
  ]);
  const positive = captureGate(() => main(["--fixture", fixture, "--mode", "ratchet"]));
  assert.equal(positive.code, 1);
  assert.match(positive.stdout, /concurrency\.expectedVersion/u);
});
