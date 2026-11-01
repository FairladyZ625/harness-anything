// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalResourceAncestors, policyActionForTarget } from "../src/repo-cell-authorization.ts";

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

test("the four artifact CRUD ingress kinds resolve to each runtime kind's own scope", () => {
  const kindA = "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94",
    kindB = "entity-kind/KND-2a6d1b8f0c4e5d7b9f3a1c2e4d6b8f05",
    target = "settings/repository" as const,
    resolve = (kind: string) =>
      kind === "architecture-decision-record" ? kindA : kind === "external-issue" ? kindB : null;
  for (const [kind, suffix] of [
    ["entity-import", "import"],
    ["entity-update", "update"],
    ["entity-archive", "archive"],
    ["entity-delete", "delete"],
  ] as const) {
    assert.equal(
      policyActionForTarget(
        { kind, entityKind: "architecture-decision-record" } as Parameters<typeof policyActionForTarget>[0],
        target,
        resolve,
      ),
      `${kindA}/${suffix}`,
    );
    assert.equal(
      policyActionForTarget(
        { kind, entityKind: "external-issue" } as Parameters<typeof policyActionForTarget>[0],
        target,
        resolve,
      ),
      `${kindB}/${suffix}`,
    );
  }
  assert.notEqual(`${kindA}/import`, `${kindB}/import`);
  // An unknown kind has no declared scope and must not fall through to a granted command name.
  assert.equal(
    policyActionForTarget(
      { kind: "entity-import", entityKind: "unregistered" } as Parameters<typeof policyActionForTarget>[0],
      target,
      resolve,
    ),
    "entity-import",
  );
});
