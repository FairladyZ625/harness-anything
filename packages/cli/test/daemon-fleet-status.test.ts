// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderDaemonFleetStatus, runDaemonFleetStatus } from "../src/daemon/fleet-status.ts";
import type { DaemonGuiReadResultMap } from "@harness-anything/daemon/internal/protocol/daemon-protocol-gui-types";

type FleetOverview = DaemonGuiReadResultMap["repo.fleet.overview.read"];

// The render is the CLI half of the shared read model: every row below fixes one honest-display
// contract from the task — never-acked stays visible, heartbeat-not-integrated names the only
// future online source, and unavailable/redacted fields keep their machine reason.
function overview(): FleetOverview {
  return {
    schema: "daemon.fleet-overview/v1",
    ok: true,
    repoId: "demo",
    mode: "local",
    generatedAt: "2026-10-10T12:00:00.000Z",
    center: {
      nodeId: "center",
      daemonId: "default",
      startedAt: "2026-10-10T08:00:00.000Z",
      version: "0.0.0",
      commitSha: "deadbeef",
    },
    centerRevision: 410,
    nodes: [
      {
        nodeId: "center",
        role: "center",
        owner: { kind: "value", text: "daemon" },
        build: { kind: "value", text: "0.0.0 @ deadbeef" },
        online: { kind: "value", text: "running" },
        leases: [],
        replica: null,
        replicaNote: null,
        watch: { kind: "value", text: "local canonical writer" },
        lastFailure: { kind: "unavailable", reason: "no-replica-sync-failure-record-in-lifecycle-read" },
      },
      {
        nodeId: "edge-caught-up",
        role: "edge",
        owner: { kind: "value", text: "person_owner" },
        build: { kind: "unavailable", reason: "replica-status-has-no-build-field" },
        online: { kind: "unavailable", reason: "tls-session-fact-not-exposed" },
        leases: [
          {
            taskId: "task_demo",
            title: "Ship the overview",
            coordinationStatus: "active",
            phase: "held",
            expiresAt: "2026-10-10T13:00:00.000Z",
            personId: "person_owner",
            runtimeSessionId: "session-1",
            dispatchId: "dispatch-1",
            agentId: "agent_sol",
            agentLabel: "Sol",
            startedAt: "2026-10-10T11:30:00.000Z",
            dispatchStatus: "running",
          },
        ],
        replica: {
          repoId: "demo",
          viewId: "edge-caught-up",
          centerRevision: 410,
          centerEventAt: "2026-10-10T11:59:00.000Z",
          ackRevision: 410,
          ackedAt: "2026-10-10T11:59:30.000Z",
          lagRevisions: 0,
          lagMs: 0,
          delivery: "current",
          deliveryLease: null,
          transferMetrics: {
            transferBytes: 2048,
            snapshotStarts: 1,
            deltaStarts: 3,
            errors: 0,
            lastFailureCode: null,
          },
        },
        replicaNote: null,
        watch: { kind: "unavailable", reason: "edge-sync-internals-not-exposed" },
        lastFailure: { kind: "unavailable", reason: "no-replica-sync-failure-record-in-lifecycle-read" },
      },
      {
        nodeId: "edge-behind",
        role: "edge",
        owner: { kind: "redacted", reason: "authorization_denied" },
        build: { kind: "unavailable", reason: "replica-status-has-no-build-field" },
        online: { kind: "unavailable", reason: "tls-session-fact-not-exposed" },
        leases: { redacted: "insufficient_scope" },
        replica: {
          repoId: "demo",
          viewId: "edge-behind",
          centerRevision: 410,
          centerEventAt: "2026-10-10T11:59:00.000Z",
          ackRevision: 404,
          ackedAt: "2026-10-10T11:40:00.000Z",
          lagRevisions: 6,
          lagMs: 1_140_000,
          delivery: "delta",
          deliveryLease: null,
          transferMetrics: {
            transferBytes: 1024,
            snapshotStarts: 0,
            deltaStarts: 2,
            errors: 1,
            lastFailureCode: "replica_delivery_fenced",
          },
        },
        replicaNote: null,
        watch: { kind: "unavailable", reason: "edge-sync-internals-not-exposed" },
        lastFailure: { kind: "unavailable", reason: "no-replica-sync-failure-record-in-lifecycle-read" },
      },
      {
        nodeId: "edge-never-acked",
        role: "edge",
        owner: { kind: "value", text: "not-in-registry" },
        build: { kind: "unavailable", reason: "replica-status-has-no-build-field" },
        online: { kind: "unavailable", reason: "tls-session-fact-not-exposed" },
        leases: [],
        replica: {
          repoId: "demo",
          viewId: "edge-never-acked",
          centerRevision: 410,
          centerEventAt: "2026-10-10T11:59:00.000Z",
          ackRevision: null,
          ackedAt: null,
          lagRevisions: 410,
          lagMs: null,
          delivery: "snapshot_required",
          deliveryLease: null,
          transferMetrics: {
            transferBytes: 0,
            snapshotStarts: 0,
            deltaStarts: 0,
            errors: 0,
            lastFailureCode: null,
          },
        },
        replicaNote: null,
        watch: { kind: "unavailable", reason: "edge-sync-internals-not-exposed" },
        lastFailure: { kind: "unavailable", reason: "no-replica-sync-failure-record-in-lifecycle-read" },
      },
    ],
    links: [
      {
        nodeId: "edge-caught-up",
        state: "fresh",
        delivery: "current",
        lagRevisions: 0,
        lagMs: 0,
        ackedAt: "2026-10-10T11:59:30.000Z",
        centerRevision: 410,
      },
      {
        nodeId: "edge-behind",
        state: "lag",
        delivery: "delta",
        lagRevisions: 6,
        lagMs: 1_140_000,
        ackedAt: "2026-10-10T11:40:00.000Z",
        centerRevision: 410,
      },
    ],
    events: [
      {
        eventId: "evt-1",
        type: "runtime_session_started",
        occurredAt: "2026-10-10T11:30:00.000Z",
        workspaceRevision: 405,
        taskId: "task_demo",
        title: "Ship the overview",
        nodeId: "edge-caught-up",
      },
    ],
    notes: ["events-attribution=current-lease", "edge-online=unavailable", "sync-internals=unavailable"],
    warnings: [],
  };
}

test("fleet status render keeps honest three-state fields and never-acked visible", () => {
  const text = renderDaemonFleetStatus(overview() as unknown as Record<string, unknown>);
  const lines = text.split("\n");
  assert.match(text, /fleet overview repo=demo mode=local/u);
  assert.match(text, /center daemon=default version=0\.0\.0 commit=deadbeef .*revision=410/u);
  // center row: process fact, not an inferred edge online.
  assert.ok(lines.includes("node center role=center"));
  assert.ok(lines.includes("  online running (center daemon process)"));
  // lease row carries the task name, agent, session and dispatch facts.
  assert.ok(
    lines.some(
      (line) =>
        line.includes('task task_demo "Ship the overview"') &&
        line.includes("person=person_owner") &&
        line.includes("agent=Sol") &&
        line.includes("session=session-1") &&
        line.includes("dispatch=running"),
    ),
  );
  // sync progress states: caught up, behind with a count, and never acked — never 0 in disguise.
  assert.ok(lines.some((line) => line.includes("sync view=edge-caught-up ack=410 center=410 lag=0rev")));
  assert.ok(lines.some((line) => line.includes("sync view=edge-behind ack=404 center=410 lag=6rev")));
  assert.ok(lines.some((line) => line.includes("ack=never-acked") && line.includes("ackedAt=never")));
  // redaction keeps its machine code instead of an empty cell.
  assert.ok(lines.some((line) => line.includes("doing leases redacted (insufficient_scope)")));
  assert.ok(lines.some((line) => line.includes("owner redacted (authorization_denied)")));
  // online for edges names the heartbeat gap and refuses ACK/runtime inference.
  assert.ok(
    lines.filter((line) => line.includes("online heartbeat-not-integrated")).length === 3,
    "every edge states heartbeat-not-integrated",
  );
  assert.match(text, /links 2/u);
  assert.match(
    text,
    /notes events-attribution=current-lease \| edge-online=unavailable \| sync-internals=unavailable/u,
  );
});

test("fleet status rejects unknown options before contacting a daemon", async () => {
  await assert.rejects(
    runDaemonFleetStatus(
      ["node", "cli.ts", "daemon", "fleet", "status", "--nonsense"],
      "/tmp/ha-fleet-status-user",
      "default",
    ),
    (error: unknown) => (error as { code?: string }).code === "invalid_field",
  );
});
