// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { taskAssignmentMatches, validTaskAssignment } from "../src/domain/task-assignment.ts";
import { assignmentMatchesViewer } from "../src/domain/assignment-viewer.ts";
import { migrateTaskAssignments } from "../src/domain/assignment-migration.ts";
import { getEntityKindContract } from "../src/domain/entity-kind-registry.ts";
import {
  applyTransition,
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  validateCurrentTaskEvent,
  validateTaskEvent,
} from "../src/domain/task-lifecycle.contract.ts";
import type { TaskEventV1 } from "../src/domain/task-lifecycle-event.ts";
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

test("assignment viewer routing matches principal targets and falls back only to the owner", () => {
  const viewer = { personId: "person-a", nodeId: "node-a", teamIds: ["team-a"] } as const,
    owner = "owner-person",
    relation = (targetRef: string, rationale = `assigned-to: expiresAt=${expiresAt}`) => ({
      sourceRef: "task/task-a",
      targetRef,
      relationType: "assigned-to",
      state: "active",
      rationale,
    });
  assert.equal(assignmentMatchesViewer(relation("person/person-a"), viewer, owner, now), true);
  assert.equal(assignmentMatchesViewer(relation("person/other"), viewer, owner, now), false);
  assert.equal(assignmentMatchesViewer(relation("node/node-a"), viewer, owner, now), true);
  assert.equal(assignmentMatchesViewer(relation("node/node-b"), viewer, owner, now), false);
  assert.equal(assignmentMatchesViewer(relation("team/team-a"), viewer, owner, now), true);
  assert.equal(assignmentMatchesViewer(relation("team/team-b"), viewer, owner, now), false);
  assert.equal(assignmentMatchesViewer(null, viewer, "person-a", now), true);
  assert.equal(assignmentMatchesViewer(null, viewer, owner, now), false);
  assert.equal(
    assignmentMatchesViewer(relation("person/person-a", `assigned-to: expiresAt=${now}`), viewer, owner, now),
    false,
  );
});

test("every assignable entity kind exposes the same assign and unassign catalog shape", () => {
  const assignable = ["task", "decision", "fact", "agent", "squad", "schedule"] as const;
  for (const kind of assignable) {
    const actions = getEntityKindContract(kind)!.actionCatalog!.actions,
      assign = actions.find((action) => action.id === "assign"),
      unassign = actions.find((action) => action.id === "unassign");
    assert.ok(assign, kind);
    assert.ok(unassign, kind);
    assert.equal(assign.policy.action, `${kind}-assign`);
    assert.equal(unassign.policy.action, `${kind}-unassign`);
    assert.deepEqual(assign.input.exactlyOneOf, [["personId", "nodeId", "teamId"]]);
    assert.deepEqual(unassign.input.exactlyOneOf, []);
    assert.equal(assign.target.kind, kind);
    assert.equal(unassign.target.kind, kind);
  }
  for (const kind of ["execution", "review", "runtime-session", "relation", "person", "settings"] as const)
    assert.equal(
      getEntityKindContract(kind)!.actionCatalog!.actions.some((action) => action.id === "assign"),
      false,
    );
});
test("legacy task assignment commands are no longer lifecycle transitions", () => {
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
  assert.throws(() => applyTransition(initial, assign, {}), /no lifecycle transition accepts AssignTask/);
  assert.throws(
    () => applyTransition(initial, command({ type: "UnassignTask", taskId: "task-a" }, 1), {}),
    /no lifecycle transition accepts UnassignTask/,
  );
});

test("legacy task assignment migration retires replacements and leaves one active edge", () => {
  const initial = applyTransition(
      emptyTaskLifecycleSnapshot(),
      command(
        {
          type: "CreateReplayTask",
          taskId: "task-migrate",
          title: "Migration",
          taskClass: "standard",
          graph: REPLAY_TASK_GRAPH,
          completionGateIds: [],
          presetSnapshotDigest: null,
        },
        0,
      ),
      { actorBinding: actor, taskIdUnique: true },
    ).snapshot,
    legacyEvent = (
      type: "task_assigned" | "task_unassigned",
      task: NonNullable<typeof initial.task>,
      revision: number,
      opId: string,
    ): TaskEventV1 =>
      ({
        schema: "task-event/v1",
        eventId: `event-${opId}`,
        workspaceRevision: revision,
        opId,
        taskId: task.taskId,
        type,
        actor,
        source: "local",
        occurredAt: now,
        payload: {
          task,
          mutation: {
            command: type === "task_assigned" ? "assign" : "unassign",
            reason: type === "task_assigned" ? "Task assigned." : "Task assignment removed.",
            fields: ["assignment"],
          },
          documentClaims: [],
        },
      }) as TaskEventV1,
    first = legacyEvent(
      "task_assigned",
      { ...initial.task!, assignment: { assignee: { kind: "person", personId: "person-a" }, expiresAt } },
      2,
      "legacy-assign-person",
    ),
    second = legacyEvent(
      "task_assigned",
      { ...initial.task!, assignment: { assignee: { kind: "node", nodeId: "node-a" }, expiresAt } },
      3,
      "legacy-assign-node",
    ),
    removed = legacyEvent("task_unassigned", { ...initial.task!, assignment: null }, 4, "legacy-unassign"),
    report = migrateTaskAssignments([first, second, removed]);
  assert.deepEqual(validateTaskEvent(first), []);
  assert.notDeepEqual(validateCurrentTaskEvent(first), []);
  assert.deepEqual([report.assigned, report.unassigned, report.invalid], [2, 1, 0]);
  assert.deepEqual(
    report.converted.map((event) => event.type),
    ["relation_created", "relation_retired", "relation_created", "relation_retired"],
  );
  assert.equal(new Set(report.converted.map((event) => event.opId)).size, report.converted.length);
  assert.equal(
    report.converted.every((event) => !event.opId.includes(":")),
    true,
  );
  const active = new Map<string, string>();
  for (const event of report.converted) {
    if (event.type === "relation_created") active.set(event.relationId, event.payload.relation.target);
    else active.delete(event.relationId);
  }
  assert.equal(active.size, 0);
});
