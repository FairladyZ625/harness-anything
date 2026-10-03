// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeFixture, run, runMaybe, seedTask } from "./runtime-cli.fixtures.ts";

test("CLI assignment freezes expiry and a center start preserves it across release", (context) => {
  const { root, env } = createRuntimeFixture(context),
    { taskId, executionId } = seedTask(root, env, "assignment");
  const show = () => JSON.parse(String(run(root, env, ["task", "show", taskId]).evidence));
  const before = show();
  const assigned = run(root, env, [
    "task",
    "assign",
    taskId,
    "--person",
    "owner",
    "--expected-version",
    String(before.revision),
  ]);
  assert.equal(assigned.outcome, "applied");
  const after = show();
  assert.equal(after.task.assignment.assignee.personId, "owner");
  const expiresAt = after.task.assignment.expiresAt;
  assert.ok(Date.parse(expiresAt) > Date.now() + 23 * 60 * 60 * 1000);
  const conflict = runMaybe(root, env, ["task", "unassign", taskId, "--expected-version", String(before.revision)]);
  assert.notEqual(conflict.status, 0);
  run(root, { ...env, HARNESS_ACTOR: "" }, ["settings", "update", "--task-assignment-ttl-ms", "3600000"]);
  assert.equal(show().task.assignment.expiresAt, expiresAt);
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const rejected = runMaybe(root, env, ["task", "unassign", taskId, "--expected-version", String(show().revision)]);
  assert.notEqual(rejected.status, 0);
  run(root, env, ["task", "release", taskId]);
  assert.equal(show().task.assignment.expiresAt, expiresAt);
  run(root, env, ["task", "unassign", taskId, "--expected-version", String(show().revision)]);
  assert.equal(show().task.assignment, null);
});
