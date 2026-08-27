// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeCiGateResult } from "./ci-gate-result.mjs";

test("CI gate results replace one canonical gate row without textual output parsing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-ci-gate-result-")),
    destination = path.join(root, "gates.json"),
    previous = process.env.HARNESS_CI_GATE_RESULTS;
  process.env.HARNESS_CI_GATE_RESULTS = destination;
  try {
    writeCiGateResult("G32", true, { actualLines: 10 });
    writeCiGateResult("G32", false, { actualLines: 11 });
    assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), [
      { gate: "G32", pass: false, metrics: { actualLines: 11 } },
    ]);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CI_GATE_RESULTS;
    else process.env.HARNESS_CI_GATE_RESULTS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
