// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fleetCredentialFromRoster, FleetRosterError, parseFleetRoster } from "../src/fleet-center-admission.ts";

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

test("credential lookup rejects a node absent from the roster", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-roster-")),
    rosterPath = path.join(root, "fleet-roster.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    rosterPath,
    `${JSON.stringify({
      schema: "fleet-roster/v2",
      nodes,
      assignments: [
        { ...common, scope: { kind: "task", taskId: "task-one", executionId: "execution-one", paths: ["tasks"] } },
      ],
    })}\n`,
  );
  assert.throws(
    () => fleetCredentialFromRoster("edge-missing", rosterPath),
    (error: unknown) => error instanceof FleetRosterError && error.code === "node_unknown",
  );
});

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
