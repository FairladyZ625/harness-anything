import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withTempStore } from "../packages/kernel/test/store/helpers.ts";
import { applyDuplicateSoftDeletePlan, buildDuplicateSoftDeletePlan } from "./duplicate-soft-delete.mjs";

test("duplicate soft-delete plans are dry-run first and skip tombstoned tasks idempotently", () => {
  withTempStore((rootDir) => {
    seedTask(rootDir, "task-a", "active");
    seedTask(rootDir, "task-b", "tombstoned");
    const undecided = manifest([{ key: "copies", candidates: ["task-a", "task-b"] }]);
    const dryRun = buildDuplicateSoftDeletePlan(rootDir, undecided);

    assert.equal(dryRun.readyToApply, false);
    assert.deepEqual(dryRun.groups[0].candidates.map((candidate) => candidate.action), ["awaiting-selection", "awaiting-selection"]);
    assert.throws(() => applyDuplicateSoftDeletePlan(rootDir, undecided, dryRun, () => undefined), /must select exactly one keep task/u);

    const decided = manifest([{ key: "copies", keep: "task-a", candidates: ["task-a", "task-b"] }]);
    const decidedPlan = buildDuplicateSoftDeletePlan(rootDir, decided);
    const calls = [];
    assert.deepEqual(applyDuplicateSoftDeletePlan(rootDir, decided, decidedPlan, (_root, taskId) => calls.push(taskId)), []);
    assert.deepEqual(calls, []);
    assert.deepEqual(decidedPlan.groups[0].candidates.map((candidate) => candidate.action), ["keep", "skip-already-tombstoned"]);
  });
});

test("duplicate soft-delete apply selects every non-canonical active copy exactly once", () => {
  withTempStore((rootDir) => {
    seedTask(rootDir, "task-a", "active");
    seedTask(rootDir, "task-b", "active");
    seedTask(rootDir, "task-c", "active");
    const input = manifest([{ key: "copies", keep: "task-b", candidates: ["task-a", "task-b", "task-c"] }]);
    const plan = buildDuplicateSoftDeletePlan(rootDir, input);
    const calls = [];

    const applied = applyDuplicateSoftDeletePlan(rootDir, input, plan, (_root, taskId) => calls.push(taskId));

    assert.deepEqual(applied, ["task-a", "task-c"]);
    assert.deepEqual(calls, ["task-a", "task-c"]);
  });
});

function manifest(groups) {
  return { schema: "duplicate-soft-delete-plan/v1", source: "test", reason: "duplicate", groups };
}

function seedTask(rootDir, taskId, disposition) {
  const taskRoot = path.join(rootDir, "harness/tasks", `${taskId}-fixture`);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), `---\ntask_id: ${taskId}\npackageDisposition: ${disposition}\n---\n`, "utf8");
}
