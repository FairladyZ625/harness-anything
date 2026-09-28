// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { deriveTaskWorktreeBinding, validateTaskV2 } from "../../src/index.ts";

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
    graph: {
      schema: "task-graph/v1",
      nodes: [
        { id: "implementation", kind: "work" },
        { id: "review", kind: "review" },
      ],
      edges: [],
    },
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
});
