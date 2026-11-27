// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalResourceAncestors,
  evaluateRepoCellAction,
  policyActionForTarget,
} from "../src/daemon-host/repo-cell-authorization.ts";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization/keycloak";
import { fakeKeycloak } from "./keycloak.fixtures.ts";
import type { RepoCellBinding } from "../src/daemon-host/repo-cell-types.ts";

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

test("evaluateRepoCellAction skips readTask for task-create without targetOverride while retaining ancestor resolution for existing tasks", async () => {
  const realm = fakeKeycloak(),
    userToken = realm.account("person-scope"),
    kcConfig = { url: "http://127.0.0.1:8080", realm: "harness", resourceServerClientId: "harness-center" };
  realm.permit("person-scope", "repo-scope", ["task-create", "task-release"]);
  const provider = Object.defineProperty(new KeycloakPolicyAdapter(kcConfig, realm.fetch), "withFetchPort", {
    value: undefined,
    configurable: true,
  });
  const binding: RepoCellBinding = {
    actor: { principal: { personId: "person-scope" }, executor: null },
    source: "local",
    keycloakAuthorization: {
      session: {
        provider,
        personId: "person-scope",
        accessToken: userToken,
        url: kcConfig.url,
        realm: kcConfig.realm,
        clientId: kcConfig.resourceServerClientId,
      },
      center: async () => ({
        provider,
        accessToken: "center-token",
        url: kcConfig.url,
        realm: kcConfig.realm,
        clientId: kcConfig.resourceServerClientId,
      }),
    },
  };
  const readCalls: string[] = [];
  const readTask = (taskId: string) => {
    readCalls.push(taskId);
    return projection({
      task_work_1: { taskId: "task_work_1", taskClass: "work", parentTaskId: null },
      task_child_1: { taskId: "task_child_1", taskClass: "standard", parentTaskId: "task_work_1" },
    })(taskId);
  };

  const created = await evaluateRepoCellAction({
    action: { kind: "task-create", taskId: "task_not_yet_created_1", title: "New" },
    binding,
    actionId: "op-create",
    repoId: "repo-scope",
    revision: 1,
    now: "2026-11-27T00:00:00.000Z",
    readTask,
  });
  assert.equal(created.outcome, "allowed");
  assert.deepEqual(readCalls, [], "task-create must not read a not-yet-created task from projection");

  const released = await evaluateRepoCellAction({
    action: { kind: "task-release", taskId: "task_child_1", reason: "Cleanup" },
    binding,
    actionId: "op-release",
    repoId: "repo-scope",
    revision: 1,
    now: "2026-11-27T00:00:00.000Z",
    readTask,
  });
  assert.equal(released.outcome, "allowed");
  assert.deepEqual(
    readCalls,
    ["task_child_1", "task_work_1"],
    "existing task writes must still resolve Work ancestors",
  );

  readCalls.length = 0;
  const overridden = await evaluateRepoCellAction({
    action: { kind: "task-create", taskId: "task_not_yet_created_1", title: "New" },
    binding,
    actionId: "op-create-override",
    repoId: "repo-scope",
    revision: 1,
    now: "2026-11-27T00:00:00.000Z",
    targetOverride: "task/task_child_1",
    readTask,
  });
  assert.equal(overridden.outcome, "allowed");
  assert.deepEqual(
    readCalls,
    ["task_child_1", "task_work_1"],
    "explicit targetOverride must retain ancestor resolution",
  );
});
