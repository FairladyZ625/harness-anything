// harness-test-tier: fast
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { withTestHarnessRoot as withTempRoot } from "./helpers/git-fixtures.ts";
import { runJson } from "./helpers/local-lifecycle-fixtures.ts";

test("CLI task-complete requires paired commit-anchor flags and forbids reviewer self-report", () => {
  withTempRoot((rootDir) => {
    const missingJudgment = runJson(rootDir, ["task", "complete", "task-packet", "--commit-anchor", "HEAD"], false);
    const missingAnchor = runJson(rootDir, ["task", "complete", "task-packet", "--judgment", "done"], false);
    const reviewer = runJson(rootDir, [
      "task", "complete", "task-packet", "--commit-anchor", "HEAD", "--judgment", "done", "--reviewer", "self"
    ], false);
    const approvalPacket = path.join(rootDir, "approval.json");
    writeFileSync(approvalPacket, "{}\n", "utf8");
    const conflictingModes = runJson(rootDir, [
      "task", "complete", "task-packet", "--approve", "--from-file", approvalPacket,
      "--commit-anchor", "HEAD", "--judgment", "done"
    ], false);

    assert.equal(missingJudgment.error?.code, "invalid_task_metadata");
    assert.equal(missingAnchor.error?.code, "invalid_task_metadata");
    assert.equal(reviewer.error?.code, "invalid_task_metadata");
    assert.equal(conflictingModes.error?.code, "invalid_task_metadata");
    assert.match(conflictingModes.error?.hint ?? "", /one owner approval mode.+not both/iu);
  });
});
