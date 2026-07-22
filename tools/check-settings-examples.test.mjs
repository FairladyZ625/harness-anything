// harness-test-tier: contract
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { landedSettingsRegistry } from "@harness-anything/kernel";
import { writeSettingsExamples } from "./generate-settings-examples.mjs";

const checker = path.resolve("tools/check-settings-examples.mjs");

test("settings example generator covers exactly the 14 landed clusters", () => {
  assert.deepEqual([...new Set(landedSettingsRegistry.map((definition) => definition.cluster))].sort(), [
    "D-02", "D-03", "D-04", "D-05", "D-12", "E-02", "E-03", "E-08", "E-09", "E-10", "E-11", "H-01", "H-02", "H-04"
  ]);
  assert.equal(landedSettingsRegistry.length, 23);
});

test("settings example checker rejects one-line generated-file drift", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-settings-examples-"));
  try {
    writeSettingsExamples(root);
    const clean = runChecker(root);
    assert.equal(clean.status, 0, clean.stderr);

    appendFileSync(path.join(root, "harness.yaml.example"), "# manual drift\n", "utf8");
    const drifted = runChecker(root);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /harness\.yaml\.example differs/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runChecker(root) {
  return spawnSync(process.execPath, [checker, "--root", root], { encoding: "utf8" });
}
