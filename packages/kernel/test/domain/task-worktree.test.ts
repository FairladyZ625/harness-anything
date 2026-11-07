// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { deriveTaskWorktreeBinding, REPLAY_TASK_GRAPH, validateTaskV2 } from "../../src/index.ts";

const standard = {
  taskId: "task_b7ca3b72da0be23393b16f0a10",
  taskClass: "standard",
} as const;

test("a repository-diff task's branch and .worktrees/ directory are its full task id", () => {
  assert.deepEqual(deriveTaskWorktreeBinding({ ...standard, outputShape: "repository-diff" }), {
    branch: "task_b7ca3b72da0be23393b16f0a10",
    path: ".worktrees/task_b7ca3b72da0be23393b16f0a10",
  });
});

test("the name does not depend on the title, so tasks titled without Latin letters stay distinct", () => {
  const first = deriveTaskWorktreeBinding({ ...standard, outputShape: "repository-diff" }),
    second = deriveTaskWorktreeBinding({
      ...standard,
      taskId: "task_0f1e2d3c4b5a69788796a5b4c3",
      outputShape: "repository-diff",
    });
  assert.notEqual(first?.path, second?.path);
  assert.equal(second?.branch, "task_0f1e2d3c4b5a69788796a5b4c3");
});

test("a task-package artifact and a declared work root are never bound", () => {
  assert.equal(deriveTaskWorktreeBinding({ ...standard, outputShape: "task-package-artifact" }), null);
  for (const taskClass of ["work", "long_running"] as const)
    assert.equal(deriveTaskWorktreeBinding({ ...standard, taskClass, outputShape: "repository-diff" }), null);
});

test("Task/v2 does not store a worktree binding: every reader derives it", () => {
  const task = {
    schema: "task/v2",
    taskId: standard.taskId,
    title: "Worktree",
    taskClass: "standard",
    status: "planned",
    graph: REPLAY_TASK_GRAPH,
    currentNode: "implementation",
    iteration: 0,
    createdBy: { principal: { personId: "person-1" }, executor: null },
    completionGateIds: [],
    presetSnapshotDigest: null,
    pinned: false,
  };
  const unknownField = { code: "invalid_task", message: "Task/v2 fields are incomplete or unknown" },
    worktree = deriveTaskWorktreeBinding({ ...standard, outputShape: "repository-diff" });
  assert.equal(
    validateTaskV2(task).some(({ message }) => message === unknownField.message),
    false,
  );
  assert.deepEqual(validateTaskV2({ ...task, worktree }), [unknownField]);
  assert.deepEqual(
    validateTaskV2({
      ...task,
      reviewDispatchIntent: {
        executionId: "execution-review-intent",
        reviewerId: "reviewer-one",
        runtimeInstanceId: "instance-one",
        model: "model-one",
        effort: "high",
        fast: true,
      },
    }),
    [],
  );
  assert.deepEqual(
    validateTaskV2({
      ...task,
      reviewDispatchIntent: {
        executionId: "execution-review-intent",
        reviewerId: "reviewer-one",
        fast: "yes",
      },
    }),
    [{ code: "invalid_task", message: "review dispatch intent is invalid" }],
  );
  // The writer omits every choice the dispatch did not make, so the minimal intent must be valid.
  assert.deepEqual(
    validateTaskV2({
      ...task,
      reviewDispatchIntent: { executionId: "execution-review-intent", reviewerId: "reviewer-one" },
    }),
    [],
  );
  assert.deepEqual(
    validateTaskV2({
      ...task,
      reviewDispatchIntent: { executionId: "execution-review-intent", reviewerId: "reviewer-one", nodeId: "n" },
    }),
    [{ code: "invalid_task", message: "review dispatch intent is invalid" }],
  );
  assert.deepEqual(validateTaskV2({ ...task, reviewDispatchIntent: { reviewerId: "reviewer-one" } }), [
    { code: "invalid_task", message: "review dispatch intent is invalid" },
  ]);
});

test("a review dispatch intent requires execution and reviewer, and admits optional fields it declares", () => {
  const task = {
    schema: "task/v2",
    taskId: standard.taskId,
    title: "Review dispatch intent",
    taskClass: "standard",
    status: "planned",
    graph: REPLAY_TASK_GRAPH,
    currentNode: "implementation",
    iteration: 0,
    createdBy: { principal: { personId: "person-1" }, executor: null },
    completionGateIds: [],
    presetSnapshotDigest: null,
    pinned: false,
  };
  const invalid = [{ code: "invalid_task", message: "review dispatch intent is invalid" }];
  assert.deepEqual(
    validateTaskV2({
      ...task,
      reviewDispatchIntent: { executionId: "execution-review-intent", reviewerId: "reviewer-one" },
    }),
    [],
  );
  const optionalFields = {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    effort: "high",
    fast: false,
  };
  for (let mask = 0; mask < 1 << Object.keys(optionalFields).length; mask += 1) {
    const selected = Object.entries(optionalFields).filter((_, index) => (mask & (1 << index)) !== 0);
    assert.deepEqual(
      validateTaskV2({
        ...task,
        reviewDispatchIntent: {
          executionId: "execution-review-intent",
          reviewerId: "reviewer-one",
          ...Object.fromEntries(selected),
        },
      }),
      [],
    );
  }
  assert.deepEqual(
    validateTaskV2({
      ...task,
      reviewDispatchIntent: {
        executionId: "execution-review-intent",
        reviewerId: "reviewer-one",
        seat: "primary",
      },
    }),
    invalid,
  );
});
