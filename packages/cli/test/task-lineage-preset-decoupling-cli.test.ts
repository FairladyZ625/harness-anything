// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import {
  runJson,
  withTempRoot,
  writeIndex,
  writeRealCloseout,
  writeReview
} from "./helpers/task-document-gates-fixtures.ts";

const legacyLongRunningTaskId = "task_01KX7H00000000000000000005";
const classifiedLongRunningTaskId = "task_01KX7H00000000000000000006";
const legacyMilestoneTaskId = "task_01KX7H00000000000000000007";
const legacySupersedeTaskId = "task_01KX7H00000000000000000008";
const classifiedSupersedeTaskId = "task_01KX7H00000000000000000009";

test("CLI long-running creation writes and preserves the epic task class", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Long Running Work", "--long-running"]);
    const indexPath = path.join(rootDir, created.packagePath, "INDEX.md");

    assert.match(readFileSync(indexPath, "utf8"), /^taskClass: epic$/mu);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const transitioned = runJson(rootDir, ["task", "transition", created.taskId, "active"]);

    assert.equal(transitioned.status, "active");
    assert.match(readFileSync(indexPath, "utf8"), /^taskClass: epic$/mu);
  });
});

test("epic and milestone packages no longer acquire a lineage completion gate", () => {
  for (const fixture of [
    { taskId: legacyLongRunningTaskId, preset: "long-running-task" },
    { taskId: classifiedLongRunningTaskId, preset: "standard-task", taskClass: "epic" as const },
    { taskId: legacyMilestoneTaskId, preset: "create-milestone" }
  ]) {
    withTempRoot((rootDir) => {
      writeIndex(rootDir, fixture.taskId, "Lineage Required", "in_review", fixture);
      writeReview(rootDir, fixture.taskId);
      writeRealCloseout(rootDir, fixture.taskId);
      const blocked = runJson(rootDir, [
        "task", "complete", fixture.taskId, "--reviewer", "reviewer-a", "--ci", "passed"
      ], false);

      assert.equal(blocked.error?.code, "invalid_transition");
      assert.doesNotMatch(blocked.error?.hint ?? "", /decision.*derives|lineage/u);
    });
  }
});

test("supersede materializes the epic task class for a legacy long-running package", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, legacySupersedeTaskId, "Legacy Long Running", "planned", {
      preset: "long-running-task"
    });

    const superseded = runJson(rootDir, [
      "task", "supersede", legacySupersedeTaskId,
      "--title", "Replacement Long Running",
      "--reason", "replace legacy package"
    ]);
    const replacementIndex = readFileSync(path.join(rootDir, superseded.packagePath, "INDEX.md"), "utf8");

    assert.match(replacementIndex, /^taskClass: epic$/mu);
  });
});

test("supersede preserves an explicit epic class independently of retired lineage semantics", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, classifiedSupersedeTaskId, "Explicit Epic", "planned", {
      preset: "standard-task",
      taskClass: "epic"
    });

    const superseded = runJson(rootDir, [
      "task", "supersede", classifiedSupersedeTaskId,
      "--title", "Replacement Explicit Epic",
      "--reason", "replace classified package"
    ]);
    const replacementTaskId = String(superseded.path).replace(/^task\//u, "");
    const replacementIndex = readFileSync(path.join(rootDir, superseded.packagePath, "INDEX.md"), "utf8");
    assert.match(replacementIndex, /^preset: standard-task$/mu);
    assert.match(replacementIndex, /^taskClass: epic$/mu);

    const blocked = runJson(rootDir, [
      "task", "complete", replacementTaskId, "--reviewer", "reviewer-a", "--ci", "passed"
    ], false);
    assert.equal(blocked.ok, false);
    assert.doesNotMatch(blocked.error?.hint ?? "", /decision.*derives|lineage/u);
  });
});
