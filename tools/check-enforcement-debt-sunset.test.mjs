import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-enforcement-debt-sunset.mjs");
const now = "2026-07-07T00:00:00.000Z";

test("enforcement debt sunset check skips public-only checkouts without private harness roots", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-d4-public-"));
  try {
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /skipped/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enforcement debt sunset check fails active decisions with overdue unfinished enforcement tasks", () => {
  const root = makeHarnessRoot();
  try {
    writeDecision(root, {
      decisionId: "dec_OVERDUE",
      state: "active",
      decidedAt: "2026-06-01T00:00:00.000Z",
      targetTaskId: "task_OVERDUE",
      rationale: "ADR names an enforcement gate that must be implemented."
    });
    writeTask(root, {
      taskId: "task_OVERDUE",
      title: "Implement enforcement gate for ADR",
      status: "active"
    });

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dec_OVERDUE derives task_OVERDUE/);
    assert.match(result.stderr, /overdue enforcement task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enforcement debt sunset check ignores completed enforcement tasks and ordinary derived work", () => {
  const root = makeHarnessRoot();
  try {
    writeDecision(root, {
      decisionId: "dec_DONE",
      state: "active",
      decidedAt: "2026-06-01T00:00:00.000Z",
      targetTaskId: "task_DONE",
      rationale: "ADR names an enforcement gate that must be implemented."
    });
    writeTask(root, {
      taskId: "task_DONE",
      title: "Implement enforcement gate for ADR",
      status: "done"
    });
    writeDecision(root, {
      decisionId: "dec_ORDINARY",
      state: "active",
      decidedAt: "2026-06-01T00:00:00.000Z",
      targetTaskId: "task_ORDINARY",
      rationale: "Ordinary feature work."
    });
    writeTask(root, {
      taskId: "task_ORDINARY",
      title: "Build ordinary feature",
      status: "active"
    });

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 overdue enforcement task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeHarnessRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-d4-sunset-"));
  mkdirSync(path.join(root, "harness/decisions"), { recursive: true });
  mkdirSync(path.join(root, "harness/tasks"), { recursive: true });
  return root;
}

function writeDecision(root, options) {
  const dir = path.join(root, "harness/decisions", `decision-${options.decisionId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${options.decisionId}`,
    "title: Test decision",
    `state: ${options.state}`,
    'proposedAt: "2026-05-30T00:00:00.000Z"',
    `decidedAt: "${options.decidedAt}"`,
    "relations:",
    `  - { relation_id: "rel_test", source: "decision/${options.decisionId}/CH1", target: "task/${options.targetTaskId}", type: "derives", strength: "strong", direction: "directed", origin: "declared", rationale: "${options.rationale}", state: "active" }`,
    "---",
    "",
    "# Test decision"
  ].join("\n"), "utf8");
}

function writeTask(root, options) {
  const dir = path.join(root, "harness/tasks", `${options.taskId}-fixture`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${options.taskId}`,
    `title: ${options.title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${options.status}`,
    "packageDisposition: active",
    "---",
    "",
    `# ${options.title}`
  ].join("\n"), "utf8");
}

function runChecker(root) {
  return spawnSync(process.execPath, [checkerPath, "--root", root, "--now", now], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });
}
