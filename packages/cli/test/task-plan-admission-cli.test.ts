// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import {
  runJson,
  withTempRoot
} from "./helpers/task-document-gates-fixtures.ts";

test("CLI active transition rejects an untouched standard-task scaffold plan", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Scaffold Plan", "--vertical", "software/coding", "--preset", "standard-task", "--locale", "zh-CN"]);
    assert.match(readFileSync(path.join(rootDir, created.packagePath, "task_plan.md"), "utf8"), /一句话说明任务目标与范围。/u);
    const blocked = runJson(rootDir, ["task", "transition", created.taskId, "active"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "task_plan_placeholder");
    assert.match(blocked.error?.hint ?? "", /task_plan\.md/u);
    assert.match(blocked.error?.hint ?? "", /substantive implementation plan/u);
    assert.doesNotMatch(readFileSync(path.join(rootDir, created.packagePath, "INDEX.md"), "utf8"), /^  status: active$/mu);
  });
});

test("CLI active transition accepts a substantive task plan", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Substantive Plan", "--vertical", "software/coding", "--preset", "standard-task"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);

    const transitioned = runJson(rootDir, ["task", "transition", created.taskId, "active"]);

    assert.equal(transitioned.ok, true);
    assert.equal(transitioned.status, "active");
  });
});

test("CLI active transition fails closed when task_plan.md is missing", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Missing Plan", "--vertical", "software/coding", "--preset", "standard-task"]);
    rmSync(path.join(rootDir, created.packagePath, "task_plan.md"));

    const checked = runJson(rootDir, ["check", "--profile", "source-package", "--strict"], false);
    const transitioned = runJson(rootDir, ["task", "transition", created.taskId, "active"], false);

    assert.equal(checked.warnings.some((warning: Record<string, unknown>) => warning.code === "task_plan_missing"), true);
    assert.equal(transitioned.error?.code, "task_plan_placeholder");
    assert.match(transitioned.error?.hint ?? "", /Restore .*task_plan\.md/u);
  });
});

test("CLI check ignores a planned scaffold while active transition still requires substantive content", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Two-sided Plan Gate", "--vertical", "software/coding", "--preset", "standard-task"]);
    const scaffoldCheck = runJson(rootDir, ["check", "--profile", "source-package", "--strict"]);
    const scaffoldTransition = runJson(rootDir, ["task", "transition", created.taskId, "active"], false);

    assert.equal(scaffoldCheck.warnings.some((warning: Record<string, unknown>) => warning.code === "task_plan_placeholder"), false);
    assert.equal(scaffoldTransition.error?.code, "task_plan_placeholder");

    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const substantiveCheck = runJson(rootDir, ["check", "--profile", "source-package", "--strict"]);
    const substantiveTransition = runJson(rootDir, ["task", "transition", created.taskId, "active"]);

    assert.equal(substantiveCheck.warnings.some((warning: Record<string, unknown>) => warning.code === "task_plan_placeholder"), false);
    assert.equal(substantiveTransition.ok, true);
  });
});
