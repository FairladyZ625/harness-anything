// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { taskAssignmentMatches, validTaskAssignment } from "../src/domain/task-assignment.ts";
import {
  applyTransition,
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  reduceTaskEvent,
} from "../src/domain/task-lifecycle.contract.ts";
import { REPLAY_TASK_GRAPH } from "../src/domain/task-graph.ts";

const now = "2026-10-03T12:00:00.000Z",
  expiresAt = "2026-10-04T12:00:00.000Z";
const actor = { principal: { personId: "person-a" }, executor: null } as const;
const claimant = { personId: "person-a", nodeId: "node-a", teamIds: ["team-a"] };
function command(intent: Parameters<typeof normalizeTaskLifecycleCommand>[1], revision: number) {
  return {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "repo", actor, source: "local", expectedRevision: revision },
      intent,
    ),
    eventId: `event-${revision}`,
    workspaceRevision: revision + 1,
    occurredAt: now,
  };
}
test("assignment eligibility distinguishes nodes, memberships, expiry and auto scopes", () => {
  const person = { assignee: { kind: "person", personId: "person-a" }, expiresAt } as const;
  const node = { ...person, assignee: { ...person.assignee, nodeId: "node-a" } };
  const team = { assignee: { kind: "team", teamId: "team-a" }, expiresAt } as const;
  assert.equal(taskAssignmentMatches(node, claimant, now, "node"), true);
  assert.equal(taskAssignmentMatches(node, { ...claimant, nodeId: "node-b" }, now), false);
  assert.equal(taskAssignmentMatches(node, { ...claimant, personId: "new-owner" }, now), false);
  assert.equal(taskAssignmentMatches(person, claimant, now, "node"), false);
  assert.equal(taskAssignmentMatches(person, claimant, now, "reserved"), true);
  assert.equal(taskAssignmentMatches(team, claimant, now, "reserved"), true);
  assert.equal(taskAssignmentMatches(team, { ...claimant, teamIds: [] }, now), false);
  assert.equal(taskAssignmentMatches(team, { ...claimant, teamIds: [] }, expiresAt), true);
  assert.equal(taskAssignmentMatches(team, claimant, expiresAt, "reserved"), false);
  assert.equal(taskAssignmentMatches(null, claimant, now, "startable"), true);
  assert.equal(taskAssignmentMatches(null, claimant, now, "node"), false);
  assert.equal(validTaskAssignment({ ...person, assignee: { kind: "person", nodeId: "node-a" } }), false);
});
test("aggregate assigns and unassigns with revision CAS and replay", () => {
  const initial = applyTransition(
    emptyTaskLifecycleSnapshot(),
    command(
      {
        type: "CreateReplayTask",
        taskId: "task-a",
        title: "Assignment",
        taskClass: "standard",
        graph: REPLAY_TASK_GRAPH,
        completionGateIds: [],
        presetSnapshotDigest: null,
      },
      0,
    ),
    { actorBinding: actor, taskIdUnique: true },
  ).snapshot;
  const assign = command(
    {
      type: "AssignTask",
      taskId: "task-a",
      assignment: { assignee: { kind: "person", personId: "person-a" }, expiresAt },
    },
    1,
  );
  for (const phase of ["held", "reserving"] as const) {
    assert.throws(
      () => applyTransition({ ...initial, lease: { phase } as never }, assign, {}),
      /no reserving or held lease/,
    );
  }
  const assigned = applyTransition(initial, assign, {});
  assert.equal(assigned.event.type, "task_assigned");
  assert.deepEqual(reduceTaskEvent(initial, assigned.event), assigned.snapshot);
  assert.throws(() => applyTransition(assigned.snapshot, assign, {}), /expected revision/);
  const removed = applyTransition(assigned.snapshot, command({ type: "UnassignTask", taskId: "task-a" }, 2), {});
  assert.equal(removed.snapshot.task?.assignment, null);
  assert.equal(removed.snapshot.lease, initial.lease);
  assert.deepEqual(reduceTaskEvent(assigned.snapshot, removed.event), removed.snapshot);
});
