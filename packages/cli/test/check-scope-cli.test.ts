// harness-test-tier: integration
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import { runJson, withTempRoot } from "./helpers/task-document-gates-fixtures.ts";

test("CLI check --task scopes to the named task tree", () => {
  withTempRoot((rootDir) => {
    const parent = runJson(rootDir, ["task", "create", "--title", "Scoped Parent", "--vertical", "software/coding", "--preset", "standard-task"]);
    writeSubstantiveTaskPlan(rootDir, parent.packagePath);
    const unrelated = runJson(rootDir, ["task", "create", "--title", "Unrelated Broken Task", "--vertical", "software/coding", "--preset", "standard-task"]);
    rmSync(path.join(rootDir, unrelated.packagePath, "task_plan.md"));

    const unscoped = runJson(rootDir, ["check", "--strict"], false);
    const scoped = runJson(rootDir, ["check", "--strict", "--task", parent.taskId]);

    assert.equal(unscoped.warnings.some((warning: Record<string, unknown>) => warning.code === "task_plan_missing"), true);
    assert.equal(scoped.ok, true);
    assert.deepEqual(scoped.report.scope.taskIds, [parent.taskId]);
    assert.equal(scoped.report.summary.rowCount, 1);

    const child = runJson(rootDir, ["task", "create", "--title", "Broken Child", "--parent", parent.taskId, "--vertical", "software/coding", "--preset", "standard-task"]);
    rmSync(path.join(rootDir, child.packagePath, "task_plan.md"));
    const tree = runJson(rootDir, ["check", "--strict", "--task", parent.taskId], false);
    assert.equal(tree.warnings.some((warning: Record<string, unknown>) =>
      warning.code === "task_plan_missing" && warning.message.includes(child.packagePath)), true);
    assert.deepEqual(tree.report.scope.taskIds.sort(), [child.taskId, parent.taskId].sort());
  });
});

test("CLI check --path scopes to the intersecting task package", () => {
  withTempRoot((rootDir) => {
    const clean = runJson(rootDir, ["task", "create", "--title", "Path Scoped Clean", "--vertical", "software/coding", "--preset", "standard-task"]);
    writeSubstantiveTaskPlan(rootDir, clean.packagePath);
    const broken = runJson(rootDir, ["task", "create", "--title", "Path Scoped Broken", "--vertical", "software/coding", "--preset", "standard-task"]);
    rmSync(path.join(rootDir, broken.packagePath, "task_plan.md"));

    const cleanScope = runJson(rootDir, ["check", "--strict", "--path", clean.packagePath]);
    const brokenScope = runJson(rootDir, ["check", "--strict", "--path", broken.packagePath], false);

    assert.equal(cleanScope.ok, true);
    assert.equal(cleanScope.report.scope.kind, "path");
    assert.deepEqual(cleanScope.report.scope.taskIds, [clean.taskId]);
    assert.equal(brokenScope.warnings.some((warning: Record<string, unknown>) => warning.code === "task_plan_missing"), true);
  });
});

test("CLI check rejects ambiguous or unsafe scopes", () => {
  withTempRoot((rootDir) => {
    const ambiguous = runJson(rootDir, ["check", "--task", "task_01ABC", "--path", "harness/tasks/task_01ABC"], false);
    const unsafe = runJson(rootDir, ["check", "--path", "../outside"], false);

    assert.equal(ambiguous.error?.code, "invalid_check_scope");
    assert.equal(unsafe.error?.code, "invalid_check_scope");
  });
});
