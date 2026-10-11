// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalResourceAncestors } from "../src/repo-cell-authorization.ts";

function projection(
  tasks: Record<string, { taskId: string; taskClass: "work" | "standard"; parentTaskId: string | null }>,
) {
  return (taskId: string) => {
    const task = tasks[taskId];
    return (task ? { ...task, metadata: { parentTaskId: task.parentTaskId } } : null) as
      | import("@harness-anything/kernel").TaskV2
      | null;
  };
}

test("derives the canonical Work ancestor from the writer projection", async () => {
  const ancestors = await canonicalResourceAncestors(
    projection({
      work: { taskId: "work", taskClass: "work", parentTaskId: null },
      child: { taskId: "child", taskClass: "standard", parentTaskId: "work" },
    }),
    { kind: "entity", repoId: "repo", entityRef: "task/child" },
  );
  assert.deepEqual(ancestors, [{ kind: "entity", repoId: "repo", entityRef: "task/work" }]);
});

test("does not broaden repository or non-task resources", async () => {
  const p = projection({ task: { taskId: "task", taskClass: "standard", parentTaskId: null } });
  assert.deepEqual(await canonicalResourceAncestors(p, { kind: "repository", repoId: "repo" }), []);
  assert.deepEqual(
    await canonicalResourceAncestors(p, { kind: "entity", repoId: "repo", entityRef: "person/alice" }),
    [],
  );
});

test("terminates on a malformed parent cycle without inventing a scope", async () => {
  const ancestors = await canonicalResourceAncestors(
    projection({
      a: { taskId: "a", taskClass: "standard", parentTaskId: "b" },
      b: { taskId: "b", taskClass: "standard", parentTaskId: "a" },
    }),
    { kind: "entity", repoId: "repo", entityRef: "task/a" },
  );
  assert.deepEqual(ancestors, []);
});

test("drops every ancestor when a Work chain contains a cycle", async () => {
  const ancestors = await canonicalResourceAncestors(
    projection({
      work: { taskId: "work", taskClass: "work", parentTaskId: "child" },
      child: { taskId: "child", taskClass: "standard", parentTaskId: "work" },
    }),
    { kind: "entity", repoId: "repo", entityRef: "task/child" },
  );
  assert.deepEqual(ancestors, []);
});
