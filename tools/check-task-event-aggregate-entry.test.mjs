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
  TASK_EVENT_CONSTRUCTION_ALLOWLIST,
} from "./check-task-event-aggregate-entry.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

// S8's two exact registrations do not authorize another path or a second constructor.
for (const eventType of ["task_assigned", "task_unassigned", "task_completion_generation_retired"]) {
  test(`${eventType} registration rejects duplicate and unregistered constructors`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-assignment-entry-"));
    try {
      const allowed = path.join(
        root,
        "packages/kernel/src/domain",
        eventType === "task_completion_generation_retired"
          ? "task-completion-generation-retirement.ts"
          : "task-assignment-transitions.ts",
      );
      mkdirSync(path.dirname(allowed), { recursive: true });
      const constructor = `envelope(command, "${eventType}", {});\n`;
      writeFileSync(allowed, constructor);
      assert.deepEqual(checkTaskEventConstructionSites(scanTaskEventConstructionSites(root)), []);
      writeFileSync(allowed, constructor.repeat(2));
      assert.match(
        checkTaskEventConstructionSites(scanTaskEventConstructionSites(root)).join("\n"),
        /found 2 construction sites, allowlist ceiling is 1/u,
      );
      writeFileSync(allowed, constructor);
      writeFileSync(path.join(path.dirname(allowed), "unregistered.ts"), constructor);
      assert.match(
        checkTaskEventConstructionSites(scanTaskEventConstructionSites(root)).join("\n"),
        /unregistered.ts.*outside the aggregate-entry allowlist/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("task event aggregate-entry gate accepts the repository allowlist", () => {
  const result = spawnSync("node", [path.join(repoRoot, "tools/check-task-event-aggregate-entry.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /aggregate-entry check passed/u);
  assert.deepEqual(checkTaskEventConstructionSites(scanTaskEventConstructionSites(repoRoot)), []);
});

test("positive control: a task_* construction site outside the allowlist fails", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-task-event-entry-"));
  try {
    const sourceDir = path.join(root, "packages/rogue/src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      path.join(sourceDir, "rogue.ts"),
      'export const event = { schema: "task-event/v1", type: "task_rogue", payload: {} };\n',
    );
    const findings = checkTaskEventConstructionSites(
      scanTaskEventConstructionSites(root),
      TASK_EVENT_CONSTRUCTION_ALLOWLIST,
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.includes("packages/rogue/src/rogue.ts") && finding.includes("outside the aggregate-entry allowlist"),
      ),
      findings.join("\n"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { spawnSync as runGate } from "node:child_process";
import {
  mkdtempSync as makeGateRoot,
  mkdirSync as makeGateDir,
  writeFileSync as writeGateFile,
  rmSync as removeGateRoot,
} from "node:fs";

const requiredScanRoots = ["packages"];
for (const omitted of requiredScanRoots) {
  for (const state of ["missing", "empty", "excluded-only"]) {
    test(`check-task-event-aggregate-entry rejects ${state} required scan root ${omitted}`, () => {
      const root = makeGateRoot(path.join(tmpdir(), "ha-gate-discovery-"));
      try {
        for (const scanRoot of requiredScanRoots) {
          if (scanRoot === omitted && state === "missing") continue;
          makeGateDir(path.join(root, scanRoot), { recursive: true });
          if (scanRoot !== omitted) writeGateFile(path.join(root, scanRoot, "good.ts"), "export const ok = true;\n");
          if (scanRoot === omitted && state === "excluded-only") {
            makeGateDir(path.join(root, scanRoot, "dist"), { recursive: true });
            writeGateFile(path.join(root, scanRoot, "dist/ignored.ts"), "export const ignored = true;\n");
          }
        }
        const result = runGate(
          process.execPath,
          [path.join(repoRootForDiscovery, "tools/check-task-event-aggregate-entry.mjs")],
          { cwd: root, encoding: "utf8" },
        );
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stderr, /ENOENT|no source files/u);
      } finally {
        removeGateRoot(root, { recursive: true, force: true });
      }
    });
  }
}
const repoRootForDiscovery = path.resolve(import.meta.dirname, "..");

test("zero constructors are legal when production source discovery is intact", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-task-event-clean-"));
  try {
    mkdirSync(path.join(root, "packages/clean/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/clean/src/good.ts"), "export const ok = true;\n");
    assert.deepEqual(checkTaskEventConstructionSites(scanTaskEventConstructionSites(root)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
