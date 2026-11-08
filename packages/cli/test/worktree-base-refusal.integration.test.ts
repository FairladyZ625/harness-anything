// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRuntimeFixture, installIdentities, published, run, runMaybe, seedTask } from "./runtime-cli.fixtures.ts";

// Issue #4431: a task started in an unborn repository records "no workspace here"; a later task-bound
// dispatch must still refuse before provider launch instead of letting resolveDispatchCwd use the root.
test("a task-bound dispatch after a start refuses an unborn repository before launch", async (context) => {
  const fixture = createRuntimeFixture(context),
    { parent, root, env } = fixture;
  // No gitRepository(root): the project repository is left exactly as ha init made it, with an unborn main.
  installIdentities(parent, root, env);
  const task = seedTask(root, env, "wt-unborn-started");
  published(root, env, run(root, env, ["task", "start", task.taskId, "--execution-id", task.executionId]));
  const dispatch = runMaybe(root, env, ["agent", "run", "terra", "--task", task.taskId, "--no-stream"]);
  assert.notEqual(dispatch.status, 0, `${dispatch.stderr}\n${JSON.stringify(dispatch.receipt)}`);
  assert.equal(dispatch.receipt.code, "worktree_base_unavailable", JSON.stringify(dispatch.receipt));
  assert.equal("spawn" in dispatch.receipt, false, "no provider launch may be recorded");
  assert.equal(existsSync(path.join(root, ".worktrees", task.taskId)), false);
});
