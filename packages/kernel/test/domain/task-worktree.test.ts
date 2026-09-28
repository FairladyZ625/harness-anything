// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { deriveTaskWorktreeBinding, validateTaskV2 } from "../../src/index.ts";

const standard = {
  taskId: "task_b7ca3b72da0be23393b16f0a10",
  slug: "worktree-lifecycle",
  taskClass: "standard",
} as const;

test("a repository-diff task is bound to a codex/ branch and a .worktrees/ checkout off origin/main", () => {
  assert.deepEqual(deriveTaskWorktreeBinding({ ...standard, outputShape: "repository-diff" }), {
    branch: "codex/worktree-lifecycle-b7ca3b72",
    path: ".worktrees/worktree-lifecycle-b7ca3b72",
    baseRef: "origin/main",
  });
});

test("tasks sharing a slug still get distinct worktrees", () => {
  const first = deriveTaskWorktreeBinding({ ...standard, slug: "task", outputShape: "repository-diff" }),
    second = deriveTaskWorktreeBinding({
      ...standard,
      taskId: "task_0f1e2d3c4b5a69788796a5b4c3",
      slug: "task",
      outputShape: "repository-diff",
    });
  assert.notEqual(first?.path, second?.path);
  assert.notEqual(first?.branch, second?.branch);
});

test("a task-package artifact and a declared work root are never bound", () => {
  assert.equal(deriveTaskWorktreeBinding({ ...standard, outputShape: "task-package-artifact" }), null);
  for (const taskClass of ["milestone", "long_running"] as const)
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
