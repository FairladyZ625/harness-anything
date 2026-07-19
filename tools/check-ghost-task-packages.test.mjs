// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkGhostTaskPackages, formatGhostTaskPackageReport, main } from "./check-ghost-task-packages.mjs";

const taskId = "task_01KXVMJ093BMM53KXPPMS8CRNP";

test("canonical task packages pass", () => {
  withFixture((rootDir) => {
    writeCanonicalPackage(rootDir, `${taskId}-authority`);

    assert.deepEqual(checkGhostTaskPackages(rootDir), {
      status: "checked",
      reason: null,
      scanned: 1,
      unregisteredPackages: [],
      duplicateTaskIds: []
    });
  });
});

test("public checkout without a self-hosted layout is explicitly not applicable", () => {
  withFixture((rootDir) => {
    const result = checkGhostTaskPackages(rootDir);

    assert.deepEqual(result, {
      status: "not-applicable",
      reason: "checkout does not declare harness/harness.yaml",
      scanned: 0,
      unregisteredPackages: [],
      duplicateTaskIds: []
    });
    assert.match(formatGhostTaskPackageReport(result), /not applicable: checkout does not declare harness\/harness.yaml/u);
    assert.equal(main(rootDir), 0);
  });
});

test("self-hosted layout with an unreachable tasks root fails closed", () => {
  withFixture((rootDir) => {
    writeHarnessConfig(rootDir);

    const result = checkGhostTaskPackages(rootDir);

    assert.equal(result.status, "unavailable");
    assert.match(result.reason, /declared tasks\.root is not a directory/u);
    assert.match(formatGhostTaskPackageReport(result), /self-hosted task ledger unavailable/u);
    assert.equal(main(rootDir), 1);
  });
});

test("worktree noise cannot shadow the canonical configured ledger", () => {
  withFixture((rootDir) => {
    const canonicalRoot = path.join(rootDir, "canonical");
    const worktreeRoot = path.join(rootDir, "worktree");
    writeCanonicalPackage(canonicalRoot, `${taskId}-authority`);
    writeWorktreeGitMetadata(canonicalRoot, worktreeRoot);
    mkdirSync(path.join(worktreeRoot, "harness", "tasks"), { recursive: true });

    const result = checkGhostTaskPackages(worktreeRoot);

    assert.equal(result.status, "checked");
    assert.equal(result.scanned, 1);
    assert.deepEqual(result.unregisteredPackages, []);
  });
});

test("duplicate task id identifies the canonical and ghost directories", () => {
  withFixture((rootDir) => {
    writeCanonicalPackage(rootDir, `${taskId}-authority`);
    mkdirSync(path.join(rootDir, "harness", "tasks", `${taskId}-ghost-packages`));

    const result = checkGhostTaskPackages(rootDir);
    const report = formatGhostTaskPackageReport(result);

    assert.equal(result.status, "checked");
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

test("hidden directories are ignored but visible non-task directories fail", () => {
  withFixture((rootDir) => {
    writeCanonicalPackage(rootDir, `${taskId}-authority`);
    mkdirSync(path.join(rootDir, "harness", "tasks", ".tool-cache"));
    mkdirSync(path.join(rootDir, "harness", "tasks", "visible-noise"));

    const result = checkGhostTaskPackages(rootDir);

    assert.equal(result.scanned, 2);
    assert.deepEqual(result.unregisteredPackages, [{
      relativePath: "harness/tasks/visible-noise",
      directoryTaskId: null,
      registeredTaskId: null
    }]);
  });
});

test("tasks root and INDEX.md wrong types become clean unavailable results", () => {
  withFixture((rootDir) => {
    writeHarnessConfig(rootDir);
    writeFileSync(path.join(rootDir, "harness", "tasks"), "not a directory\n", "utf8");
    const tasksResult = checkGhostTaskPackages(rootDir);
    assert.equal(tasksResult.status, "unavailable");
    assert.match(formatGhostTaskPackageReport(tasksResult), /declared tasks\.root is not a directory/u);
  });

  withFixture((rootDir) => {
    const packageName = `${taskId}-authority`;
    writeCanonicalPackage(rootDir, packageName);
    const indexPath = path.join(rootDir, "harness", "tasks", packageName, "INDEX.md");
    unlinkSync(indexPath);
    mkdirSync(indexPath);
    const indexResult = checkGhostTaskPackages(rootDir);
    assert.equal(indexResult.status, "unavailable");
    assert.match(formatGhostTaskPackageReport(indexResult), /INDEX\.md must be a regular file/u);
  });
});

test("quoted schema and task_id YAML scalars register a package", () => {
  withFixture((rootDir) => {
    writeCanonicalPackage(rootDir, `${taskId}-authority`, taskId, { quoteScalars: true });

    const result = checkGhostTaskPackages(rootDir);

    assert.equal(result.status, "checked");
    assert.deepEqual(result.unregisteredPackages, []);
  });
});

function writeCanonicalPackage(rootDir, packageName, registeredTaskId = taskId, { quoteScalars = false } = {}) {
  writeHarnessConfig(rootDir, quoteScalars ? "'harness/tasks'" : "harness/tasks");
  const packageDir = path.join(rootDir, "harness", "tasks", packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "INDEX.md"), [
    "---",
    `schema: ${quoteScalars ? "'task-package/v2'" : "task-package/v2"}`,
    `task_id: ${quoteScalars ? `"${registeredTaskId}"` : registeredTaskId}`,
    "---",
    "",
    "# Task",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(packageDir, "task-contract.json"), "{}\n", "utf8");
}

function writeHarnessConfig(rootDir, tasksRoot = "harness/tasks") {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  writeFileSync(path.join(harnessRoot, "harness.yaml"), [
    "schema: harness-anything/v1",
    "tasks:",
    `  root: ${tasksRoot}`,
    ""
  ].join("\n"), "utf8");
}

function writeWorktreeGitMetadata(canonicalRoot, worktreeRoot) {
  const worktreeGitDir = path.join(canonicalRoot, ".git", "worktrees", "review-fixture");
  mkdirSync(worktreeGitDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");
  writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
}

function withFixture(run) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-ghost-task-packages-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
