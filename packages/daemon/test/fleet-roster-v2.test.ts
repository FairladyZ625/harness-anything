// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fleetCredentialFromRoster,
  FleetRosterError,
  parseFleetRoster,
  startFleetCenterAdmission,
  syncFleetEdgeMirror,
} from "../src/fleet-center-admission.ts";

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

test("fleet-roster rejects an unsupported top-level schema", () => {
  assert.throws(
    () => parseFleetRoster({ schema: "fleet-roster/v3", nodes, assignments: [] }),
    (error: unknown) =>
      error instanceof FleetRosterError &&
      error.code === "roster_invalid" &&
      error.message.includes("top-level schema must be fleet-roster/v1 or fleet-roster/v2"),
  );
});

test("fleet-roster/v2 rejects unknown or missing top-level fields", () => {
  assert.throws(
    () => parseFleetRoster({ schema: "fleet-roster/v2", nodes, assignments: [], legacy: true }),
    (error: unknown) =>
      error instanceof FleetRosterError &&
      error.code === "roster_invalid" &&
      error.message.includes("unknown or missing top-level fields"),
  );
});

test("fleet-roster rejects assignments for undeclared nodes", () => {
  assert.throws(
    () =>
      parseFleetRoster({
        schema: "fleet-roster/v2",
        nodes,
        assignments: [
          {
            ...common,
            nodeId: "edge-missing",
            scope: { kind: "task", taskId: "task-one", executionId: "execution-one", paths: ["tasks"] },
          },
        ],
      }),
    (error: unknown) =>
      error instanceof FleetRosterError &&
      error.code === "roster_invalid" &&
      error.message.includes("every assignment nodeId must also be declared in nodes"),
  );
});

test("fleet center admission rejects unreadable TLS material before opening a listener", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-material-")),
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
  await assert.rejects(
    startFleetCenterAdmission({
      host: {} as Parameters<typeof startFleetCenterAdmission>[0]["host"],
      userRoot: root,
      payload: {
        port: 0,
        keyPath: path.join(root, "missing.key"),
        certPath: path.join(root, "missing.crt"),
        rosterPath,
        quotaBytes: 1,
      },
    }),
    (error: unknown) => error instanceof FleetRosterError && error.code === "fleet_material_unreadable",
  );
});

test("fleet edge sync rejects a missing credential source before touching the mirror", async () => {
  await assert.rejects(
    syncFleetEdgeMirror({
      payload: {
        host: "127.0.0.1",
        port: 1,
        caPath: "unused",
        nodeId: "edge-one",
        assignmentId: "assignment-one",
        repoId: "repo-one",
        viewRoot: "unused",
        quotaBytes: 1,
        workspaceRoot: "unused",
      },
    }),
    (error: unknown) => error instanceof FleetRosterError && error.code === "credential_required",
  );
});
