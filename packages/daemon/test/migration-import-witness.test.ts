// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { reboundRef, type MigrationRelationsContext } from "../src/migration-import-relations.ts";
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

test("archived identities satisfy reconciliation but cannot keep relation endpoints active", () => {
  const context = {
    taskMap: new Map([["task_active", "task_active"]]),
    decisionMap: new Map<string, string>(),
    factMap: new Map<string, string>(),
    archivedIds: {
      task: new Set(["task_archived"]),
      decision: new Set(["dec_archived"]),
      fact: new Set(["F-ARCHIVED"]),
      relation: new Set<string>(),
      execution: new Set(["exe_archived"]),
    },
    cold: { knownFactRefs: new Set(["fact/F-ARCHIVED", "fact/F-ACTIVE00"]) },
    oracle: {
      entityKeys: new Set(["execution\0exe_archived", "execution\0exe_active"]),
    },
  } as unknown as MigrationRelationsContext;
  assert.equal(reboundRef(context, "task/task_active"), "task/task_active");
  assert.equal(reboundRef(context, "execution/exe_active"), "execution/exe_active");
  assert.equal(reboundRef(context, "task/task_archived"), null);
  assert.equal(reboundRef(context, "decision/dec_archived"), null);
  assert.equal(reboundRef(context, "fact/F-ARCHIVED"), null);
  assert.equal(reboundRef(context, "execution/exe_archived"), null);
});
