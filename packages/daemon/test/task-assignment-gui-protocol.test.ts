// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { actionForDaemonMethod, parseDaemonRpcParams } from "../src/protocol/daemon-protocol.contract.ts";
import { task } from "../src/protocol/daemon-protocol-validate-entities.ts";

test("assignment GUI aliases keep version and target on the canonical action", () => {
  for (const target of [{ personId: "person-a" }, { nodeId: "node-a" }, { teamId: "team-a" }]) {
    const payload = { taskId: "task-a", expectedVersion: 4, ...target };
    assert.deepEqual(actionForDaemonMethod("repo.task.assign", payload), { kind: "task-assign", ...payload });
    assert.equal(parseDaemonRpcParams("repo.task.assign", { repo: { repoId: "repo-a" }, payload }).ok, true);
    assert.equal(
      parseDaemonRpcParams("repo.task.assign", {
        repo: { repoId: "repo-a" },
        payload: { ...payload, principal: "client-person" },
      }).ok,
      false,
    );
  }
  assert.equal(
    parseDaemonRpcParams("repo.task.unassign", { repo: { repoId: "repo-a" }, payload: { taskId: "task-a" } }).ok,
    false,
  );
});

test("task read accepts the canonical assignment and rejects malformed assignments", () => {
  const value = {
    schema: "task/v2",
    taskId: "task-a",
    title: "A",
    taskClass: "standard",
    status: "planned",
    graph: {},
    currentNode: "implementation",
    iteration: 1,
    createdBy: { principal: { personId: "person-a" }, executor: null },
    completionGateIds: [],
    presetSnapshotDigest: null,
    pinned: false,
  };
  assert.equal(task(value), true);
  for (const assignment of [
    null,
    { assignee: { kind: "person", personId: "person-a", nodeId: "node-a" }, expiresAt: "2099-01-01T00:00:00.000Z" },
    { assignee: { kind: "team", teamId: "team-a" }, expiresAt: "2099-01-01T00:00:00.000Z" },
  ])
    assert.equal(task({ ...value, assignment }), true);
  for (const assignment of [
    {},
    { assignee: { kind: "node", nodeId: "node-a" }, expiresAt: "2099-01-01T00:00:00.000Z" },
    { assignee: { kind: "team", teamId: "team-a" }, expiresAt: "bad" },
  ])
    assert.equal(task({ ...value, assignment }), false);
});

test("selection and claimable reads never accept a client principal or node", () => {
  assert.equal(
    parseDaemonRpcParams("repo.tasks.assignmentDirectory", {
      repo: { repoId: "repo-a" },
      payload: { taskId: "task-a" },
    }).ok,
    true,
  );
  for (const payload of [
    { taskId: "task-a", nodeId: "node-a" },
    { taskId: "task-a", personId: "owner" },
  ])
    assert.equal(
      parseDaemonRpcParams("repo.tasks.assignmentDirectory", { repo: { repoId: "repo-a" }, payload }).ok,
      false,
    );
  assert.equal(parseDaemonRpcParams("repo.tasks.claimable", { repo: { repoId: "repo-a" } }).ok, true);
  assert.equal(
    parseDaemonRpcParams("repo.tasks.claimable", { repo: { repoId: "repo-a" }, payload: { nodeId: "node-a" } }).ok,
    false,
  );
});
