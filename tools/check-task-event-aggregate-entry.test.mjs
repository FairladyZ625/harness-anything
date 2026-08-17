// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  checkTaskEventConstructionSites,
  scanTaskEventConstructionSites,
  TASK_EVENT_CONSTRUCTION_ALLOWLIST
} from "./check-task-event-aggregate-entry.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("task event aggregate-entry gate accepts the repository allowlist", () => {
  const result = spawnSync("node", [path.join(repoRoot, "tools/check-task-event-aggregate-entry.mjs")], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /aggregate-entry check passed/u);
  assert.deepEqual(checkTaskEventConstructionSites(scanTaskEventConstructionSites(repoRoot)), []);
});

test("positive control: a task_* construction site outside the allowlist fails", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-task-event-entry-"));
  try {
    const sourceDir = path.join(root, "packages/rogue/src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "rogue.ts"), 'export const event = { schema: "task-event/v1", type: "task_rogue", payload: {} };\n');
    const findings = checkTaskEventConstructionSites(scanTaskEventConstructionSites(root), TASK_EVENT_CONSTRUCTION_ALLOWLIST);
    assert.ok(findings.some((finding) => finding.includes("packages/rogue/src/rogue.ts") && finding.includes("outside the aggregate-entry allowlist")), findings.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
