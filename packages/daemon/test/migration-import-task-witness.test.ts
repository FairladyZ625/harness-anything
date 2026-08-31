// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { taskTitleFromPackage } from "../src/migration-import-tasks.ts";

test("Task/v1 title witness prefers task_plan.md H1 and falls back to INDEX.md H1", () => {
  const authoredRoot = mkdtempSync(path.join(tmpdir(), "migration-task-title-")),
    packageRoot = path.join(authoredRoot, "tasks/task_legacy");
  try {
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(packageRoot, "task_plan.md"), "# Plan title\n");
    assert.deepEqual(taskTitleFromPackage(packageRoot, "# Index title\n", authoredRoot), {
      value: "Plan title",
      source: "tasks/task_legacy/task_plan.md",
    });
    writeFileSync(path.join(packageRoot, "task_plan.md"), "No heading\n");
    assert.deepEqual(taskTitleFromPackage(packageRoot, "# Index title\n", authoredRoot), {
      value: "Index title",
      source: "tasks/task_legacy/INDEX.md",
    });
    assert.equal(taskTitleFromPackage(packageRoot, "No heading\n", authoredRoot), null);
  } finally {
    rmSync(authoredRoot, { recursive: true, force: true });
  }
});
