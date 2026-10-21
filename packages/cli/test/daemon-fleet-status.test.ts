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
        replicaReason: "center-local-writer",
        watch: { kind: "value", text: "local canonical writer" },
        lastFailure: { kind: "unavailable", reason: "no-replica-sync-failure-in-replica-status-row" },
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
          centerSequence: 500,
          ackRevision: 410,
          ackSequence: 500,
          lagCommits: 0,
          connected: true,
          ackedAt: "2026-10-10T11:59:30.000Z",
          lagRevisions: 0,
          lagMs: 0,
          delivery: "current",
        },
        replicaReason: "replica-current",
        watch: { kind: "unavailable", reason: "edge-sync-internals-not-exposed" },
        lastFailure: { kind: "unavailable", reason: "no-replica-sync-failure-in-replica-status-row" },
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
          centerSequence: 500,
          ackRevision: 404,
          ackSequence: 493,
          lagCommits: 7,
          connected: false,
          ackedAt: "2026-10-10T11:40:00.000Z",
          lagRevisions: 6,
          lagMs: 1_140_000,
          delivery: "delta",
        },
        replicaReason: "replica-catching-up",
        watch: { kind: "unavailable", reason: "edge-sync-internals-not-exposed" },
        lastFailure: { kind: "unavailable", reason: "no-replica-sync-failure-in-replica-status-row" },
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
          centerSequence: 500,
          ackRevision: null,
          ackSequence: null,
          lagCommits: null,
          connected: false,
          ackedAt: null,
          lagRevisions: 410,
          lagMs: null,
          delivery: "snapshot_required",
        },
        replicaReason: "replica-snapshot-required",
        watch: { kind: "unavailable", reason: "edge-sync-internals-not-exposed" },
        lastFailure: { kind: "unavailable", reason: "no-replica-sync-failure-in-replica-status-row" },
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
  assert.ok(
    lines.some((line) => line.includes("commits=493/500 lagCommits=7") && line.includes("stream=disconnected")),
  );
  assert.ok(lines.some((line) => line.includes("ack=never-acked") && line.includes("ackedAt=never")));
  assert.ok(lines.some((line) => line === "  reason replica-catching-up"));
  assert.ok(lines.some((line) => line === "  reason replica-snapshot-required"));
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

test("a node with no replica row states the gap once, on the reason line", () => {
  const data = overview();
  data.nodes = [
    ...data.nodes,
    {
      ...data.nodes[1]!,
      nodeId: "ghost-node",
      leases: [],
      replica: null,
      replicaReason: "replica-row-missing",
    },
  ];
  const lines = renderDaemonFleetStatus(data as unknown as Record<string, unknown>).split("\n");
  assert.ok(lines.includes("  sync no replica row"));
  assert.ok(lines.includes("  reason replica-row-missing"));
  // 同一状态只出现一个原因码:sync 行不再引用第二个码。
  assert.equal(lines.filter((line) => line.includes("center-replica-ledger-has-no-row-for-node")).length, 0);
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
