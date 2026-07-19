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
      available: true,
      scanned: 1,
      unregisteredPackages: [],
      duplicateTaskIds: []
    });
  });
});

test("missing canonical ledger fails closed", () => {
  withFixture((rootDir) => {
    const result = checkGhostTaskPackages(rootDir);

    assert.deepEqual(result, {
      available: false,
      scanned: 0,
      unregisteredPackages: [],
      duplicateTaskIds: []
    });
    assert.match(formatGhostTaskPackageReport(result), /canonical harness\/tasks ledger is unavailable/u);
  });
});

test("duplicate task id identifies the canonical and ghost directories", () => {
  withFixture((rootDir) => {
    writeCanonicalPackage(rootDir, `${taskId}-authority`);
    mkdirSync(path.join(rootDir, "harness", "tasks", `${taskId}-ghost-packages`));

    const result = checkGhostTaskPackages(rootDir);
    const report = formatGhostTaskPackageReport(result);

    assert.equal(result.available, true);
    assert.deepEqual(result.unregisteredPackages, [{
      relativePath: `harness/tasks/${taskId}-ghost-packages`,
      directoryTaskId: taskId,
      registeredTaskId: null
    }]);
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

test("positive control: a ghost directory without ledger registration turns the check red", () => {
  withFixture((rootDir) => {
    const packageName = `${taskId}-authority`;
    writeCanonicalPackage(rootDir, packageName);
    unlinkSync(path.join(rootDir, "harness", "tasks", packageName, "INDEX.md"));

    const result = checkGhostTaskPackages(rootDir);

    assert.deepEqual(result.unregisteredPackages, [{
      relativePath: `harness/tasks/${packageName}`,
      directoryTaskId: taskId,
      registeredTaskId: null
    }]);
  });
});

test("directory task id must match the authored ledger task id", () => {
  withFixture((rootDir) => {
    const packageName = `${taskId}-authority`;
    writeCanonicalPackage(rootDir, packageName, "task_01KXVMJ093BMM53KXPPMS8CRNQ");

    const result = checkGhostTaskPackages(rootDir);

    assert.deepEqual(result.unregisteredPackages, [{
      relativePath: `harness/tasks/${packageName}`,
      directoryTaskId: taskId,
      registeredTaskId: "task_01KXVMJ093BMM53KXPPMS8CRNQ"
    }]);
  });
});

function writeCanonicalPackage(rootDir, packageName, registeredTaskId = taskId) {
  const packageDir = path.join(rootDir, "harness", "tasks", packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${registeredTaskId}`,
    "---",
    "",
    "# Task",
    ""
  ].join("\n"), "utf8");
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
