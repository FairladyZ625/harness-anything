// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FleetRosterError,
  keycloakNodeRegistry,
  parseFleetRoster,
  startFleetCenterAdmission,
} from "../src/fleet-center-admission.ts";
import { fakeKeycloak, keycloakRealm, keycloakUrl } from "./keycloak.fixtures.ts";

const common = {
  assignmentId: "assignment-one",
  nodeId: "edge-one",
  repoId: "repo-one",
  viewId: "view-one",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const taskScope = { kind: "task", taskId: "task-one", executionId: "execution-one", paths: ["tasks"] };
const invalid = (detail: string) => (error: unknown) =>
  error instanceof FleetRosterError && error.code === "roster_invalid" && error.message.includes(detail);

test("fleet-roster/v3 admits task and Schedule assignments", () => {
  const task = parseFleetRoster({ schema: "fleet-roster/v3", assignments: [{ ...common, scope: taskScope }] }),
    schedule = parseFleetRoster({
      schema: "fleet-roster/v3",
      assignments: [{ ...common, scope: { kind: "schedule", scheduleId: "e2e-probe", paths: ["schedules"] } }],
    });
  assert.deepEqual(task.assignments[0], { ...common, scope: taskScope });
  assert.deepEqual(schedule.assignments[0]?.scope, {
    kind: "schedule",
    scheduleId: "e2e-probe",
    paths: ["schedules"],
  });
});

test("a roster names no machine credential and no acting person", () => {
  // Credentials and node owners live in the center's Keycloak node registry; a roster that still
  // carries them is refused instead of being read as a second source of who a node is.
  assert.throws(
    () =>
      parseFleetRoster({
        schema: "fleet-roster/v3",
        nodes: [{ nodeId: "edge-one", credential: "machine-secret" }],
        assignments: [{ ...common, scope: taskScope }],
      }),
    invalid("unknown or missing top-level fields"),
  );
  for (const selfDeclared of [{ personId: "operator-one" }, { executorId: "agent-one" }, { actor: {} }])
    assert.throws(
      () =>
        parseFleetRoster({
          schema: "fleet-roster/v3",
          assignments: [{ ...common, ...selfDeclared, scope: taskScope }],
        }),
      invalid("complete assignment rows"),
      JSON.stringify(selfDeclared),
    );
});

test("the retired roster schemas are refused, not read as aliases", () => {
  const nodes = [{ nodeId: "edge-one", credential: "machine-secret" }];
  for (const retired of [
    {
      schema: "fleet-roster/v1",
      nodes,
      assignments: [{ ...common, personId: "operator-one", taskId: "task-one", executionId: "e", paths: ["tasks"] }],
    },
    { schema: "fleet-roster/v2", nodes, assignments: [{ ...common, personId: "operator-one", scope: taskScope }] },
  ])
    assert.throws(() => parseFleetRoster(retired), invalid("top-level schema must be fleet-roster/v3"), retired.schema);
});

test("fleet-roster/v3 rejects incomplete or unscoped assignments", () => {
  assert.throws(() => parseFleetRoster({ schema: "fleet-roster/v3", assignments: [] }), invalid("non-empty array"));
  assert.throws(
    () => parseFleetRoster({ schema: "fleet-roster/v3", assignments: [{ ...common, scope: { kind: "repo" } }] }),
    invalid("complete assignment rows"),
  );
  assert.throws(
    () =>
      parseFleetRoster({
        schema: "fleet-roster/v3",
        assignments: [{ ...common, scope: { ...taskScope, paths: ["../outside"] } }],
      }),
    invalid("complete assignment rows"),
  );
});

test("the node registry asks Keycloak who a node is and whether its credential is its own", async () => {
  const keycloak = fakeKeycloak(),
    credential = keycloak.node("edge-one", "operator-one"),
    registry = keycloakNodeRegistry(
      async () => ({ url: keycloakUrl, realm: keycloakRealm, clientId: "harness-center", accessToken: "center-token" }),
      keycloak.fetch,
    );
  assert.equal(await registry.authenticate("edge-one", credential), true);
  assert.equal(await registry.authenticate("edge-one", `${credential}-other`), false);
  assert.equal(await registry.authenticate("edge-unregistered", credential), false);
  assert.equal(await registry.nodeOwner("edge-one"), "operator-one");
  assert.equal(await registry.nodeOwner("edge-unregistered"), null);
  // Re-registration to another person is what the next frame reads; nothing is cached in between.
  keycloak.node("edge-one", "operator-two");
  assert.equal(await registry.nodeOwner("edge-one"), "operator-two");
  assert.equal(await registry.authenticate("edge-one", credential), true);
});

test("fleet center admission rejects unreadable TLS material before opening a listener", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-material-")),
    rosterPath = path.join(root, "fleet-roster.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    rosterPath,
    `${JSON.stringify({ schema: "fleet-roster/v3", assignments: [{ ...common, scope: taskScope }] })}\n`,
  );
  await assert.rejects(
    startFleetCenterAdmission({
      host: {} as Parameters<typeof startFleetCenterAdmission>[0]["host"],
      userRoot: root,
      nodes: { authenticate: () => false, nodeOwner: () => null },
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
