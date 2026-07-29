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

test("lineage gate accepts taskClass and keeps legacy long-running packages compatible", () => {
  for (const fixture of [
    { taskId: legacyLongRunningTaskId, preset: "long-running-task" },
    { taskId: classifiedLongRunningTaskId, preset: "standard-task", taskClass: "epic" as const }
  ]) {
    withTempRoot((rootDir) => {
      writeIndex(rootDir, fixture.taskId, "Lineage Required", "in_review", fixture);
      writeReview(rootDir, fixture.taskId);
      writeRealCloseout(rootDir, fixture.taskId);
      const blocked = runJson(rootDir, [
        "task", "complete", fixture.taskId, "--reviewer", "reviewer-a", "--ci", "passed"
      ], false);

      assert.equal(blocked.error?.code, "closeout_not_ready");
      assert.match(blocked.error?.hint ?? "", /decision.*derives/u);
    });
  }
});
