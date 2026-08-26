// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { parseFleetRoster } from "../src/fleet-center-admission.ts";

const common = {
  assignmentId: "assignment-one",
  nodeId: "edge-one",
  repoId: "repo-one",
  viewId: "view-one",
  personId: "operator-one",
  executorId: "agent-one",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const nodes = [{ nodeId: "edge-one", credential: "machine-secret" }];

test("fleet-roster/v1 is a read alias normalized to a task discriminant", () => {
  const roster = parseFleetRoster({
    schema: "fleet-roster/v1",
    nodes,
    assignments: [{ ...common, taskId: "task-one", executionId: "execution-one", paths: ["tasks"] }],
  });
  assert.deepEqual(roster.assignments[0]?.scope, {
    kind: "task",
    taskId: "task-one",
    executionId: "execution-one",
    paths: ["tasks"],
  });
});

test("fleet-roster/v2 admits task and Schedule assignments", () => {
  const task = parseFleetRoster({
      schema: "fleet-roster/v2",
      nodes,
      assignments: [
        { ...common, scope: { kind: "task", taskId: "task-one", executionId: "execution-one", paths: ["tasks"] } },
      ],
    }),
    schedule = parseFleetRoster({
      schema: "fleet-roster/v2",
      nodes,
      assignments: [{ ...common, scope: { kind: "schedule", scheduleId: "e2e-probe", paths: ["schedules"] } }],
    });
  assert.equal(task.assignments[0]?.scope.kind, "task");
  assert.deepEqual(schedule.assignments[0]?.scope, {
    kind: "schedule",
    scheduleId: "e2e-probe",
    paths: ["schedules"],
  });
  assert.throws(
    () =>
      parseFleetRoster({
        schema: "fleet-roster/v2",
        nodes,
        assignments: [{ ...common, taskId: "legacy-not-written", paths: ["tasks"] }],
      }),
    /roster is invalid/u,
  );
  assert.throws(
    () =>
      parseFleetRoster({
        schema: "fleet-roster/v2",
        nodes,
        assignments: [
          {
            ...common,
            taskId: "legacy-extra",
            scope: { kind: "schedule", scheduleId: "e2e-probe", paths: ["schedules"] },
          },
        ],
      }),
    /roster is invalid/u,
  );
});
