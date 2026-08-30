// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditExplainExecutableActions, main } from "../ontology-explain-executable-actions.mjs";
import { captureGate } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("G0-4 ratchet accepts the repository and rejects explain output that advertises execution:null", () => {
  assert.equal(captureGate(() => main(["--root", repoRoot, "--mode", "ratchet"])).code, 0);
  const fixture = path.join(mkdtempSync(path.join(tmpdir(), "ontology-explain-")), "catalog.json");
  const catalog = [{ kind: "task", available: ["pretend"], actions: [{ id: "pretend", execution: null }] }];
  writeFileSync(fixture, `${JSON.stringify(catalog)}\n`);
  const result = auditExplainExecutableActions(catalog);
  assert.deepEqual(result.findings, [{ kind: "task", action: "pretend" }]);
  const positive = captureGate(() => main(["--fixture", fixture, "--mode", "ratchet"]));
  assert.equal(positive.code, 1);
  assert.match(positive.stdout, /task\/pretend/u);
});
