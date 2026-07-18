// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkGhostTaskPackages, formatGhostTaskPackageReport } from "./check-ghost-task-packages.mjs";

const taskId = "task_01KXVMJ093BMM53KXPPMS8CRNP";

test("canonical task packages pass", () => {
  withFixture((rootDir) => {
    writeCanonicalPackage(rootDir, `${taskId}-authority`);

    assert.deepEqual(checkGhostTaskPackages(rootDir), {
      skipped: false,
      scanned: 1,
      missingIndexes: [],
      duplicateTaskIds: []
    });
  });
});

test("missing harness skips cleanly", () => {
  withFixture((rootDir) => {
    const result = checkGhostTaskPackages(rootDir);

    assert.deepEqual(result, {
      skipped: true,
      scanned: 0,
      missingIndexes: [],
      duplicateTaskIds: []
    });
    assert.match(formatGhostTaskPackageReport(result), /harness\/tasks not present; skipping/u);
  });
});

test("duplicate task id identifies the canonical and ghost directories", () => {
  withFixture((rootDir) => {
    writeCanonicalPackage(rootDir, `${taskId}-authority`);
    mkdirSync(path.join(rootDir, "harness", "tasks", `${taskId}-ghost-packages`));

    const result = checkGhostTaskPackages(rootDir);
    const report = formatGhostTaskPackageReport(result);

    assert.equal(result.skipped, false);
    assert.deepEqual(result.missingIndexes, [
      `harness/tasks/${taskId}-ghost-packages`
    ]);
    assert.deepEqual(result.duplicateTaskIds, [{
      taskId,
      directories: [
        `harness/tasks/${taskId}-authority`,
        `harness/tasks/${taskId}-ghost-packages`
      ]
    }]);
    assert.match(report, new RegExp(taskId, "u"));
    assert.match(report, /task_01KXVMJ093BMM53KXPPMS8CRNP-authority/u);
    assert.match(report, /task_01KXVMJ093BMM53KXPPMS8CRNP-ghost-packages/u);
  });
});

test("removing the canonical INDEX.md turns the check red", () => {
  withFixture((rootDir) => {
    const packageName = `${taskId}-authority`;
    writeCanonicalPackage(rootDir, packageName);
    unlinkSync(path.join(rootDir, "harness", "tasks", packageName, "INDEX.md"));

    const result = checkGhostTaskPackages(rootDir);

    assert.deepEqual(result.missingIndexes, [`harness/tasks/${packageName}`]);
  });
});

function writeCanonicalPackage(rootDir, packageName) {
  const packageDir = path.join(rootDir, "harness", "tasks", packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "INDEX.md"), "# Task\n", "utf8");
  writeFileSync(path.join(packageDir, "task-contract.json"), "{}\n", "utf8");
}

function withFixture(run) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-ghost-task-packages-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
