// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { TASK_EVENT_SHAPE_COMPAT_VERSION, deriveBasePolicyGroups } from "@harness-anything/kernel";
import { daemonBuildStamp } from "../src/build-identity.ts";
import { buildFleetOverview } from "../src/fleet/fleet-overview-read.ts";
import type { FleetTlsCenter } from "../src/fleet/center.ts";
import { createNodeSessionStatus } from "../src/fleet/node-session-status.ts";
import {
  fleetReplicationFixture,
  replicationPeer,
  replicationRepoId,
  waitForState,
} from "./fleet-replication.fixture.ts";

const first = "2026-11-03T01:00:00.000Z",
  ended = "2026-11-03T02:00:00.000Z";
function overview(center: FleetTlsCenter) {
  const status = center.status();
  return buildFleetOverview({
    repoId: replicationRepoId,
    mode: "remote-center",
    generatedAt: ended,
    center: { daemonId: "center", startedAt: first, version: "0.1", commitSha: daemonBuildStamp().commit },
    replicas: status.replicas,
    nodeSessions: status.nodeSessions,
    leaseReads: { ok: true, leases: [], dispatches: [] },
    events: [],
    nodeOwners: new Map(),
    centerRevision: 0,
  });
}

test(
  "real TLS session facts survive disconnect and restart, isolate nodes, and preserve the latest failure",
  { timeout: 60_000 },
  async (t) => {
    let now = first;
    const fixture = await fleetReplicationFixture(t, { now: () => now });
    t.diagnostic("fixture ready");
    const center = await fixture.openCenter();
    t.diagnostic("session center opened");
    const open = (nodeId: string, build: string) =>
      replicationPeer(fixture.track, center.port, fixture.cert, nodeId, `secret-${nodeId}`, build);
    const a = await open("edge-one", "0".repeat(40)),
      b = await open("edge-two", "1".repeat(40));
    t.diagnostic("both authenticated hellos returned");
    const start = {
      type: "replica.start" as const,
      repoId: replicationRepoId,
      position: null,
      taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
    };
    assert.equal((await a.request(start)).type, "replica.accept");
    assert.equal((await b.request(start)).type, "replica.accept");
    t.diagnostic("both replication sessions accepted");
    await waitForState(() => center.status().replicas.length === 2, "both real replication slots");
    const edge = (nodeId: string) => overview(center).nodes.find((node) => node.nodeId === nodeId)!;
    assert.deepEqual(edge("edge-one").online, { kind: "value", text: "connected" });
    assert.equal(edge("edge-one").build.kind, "value");
    assert.match((edge("edge-one").build as { text: string }).text, /0000000000.*version mismatch/u);
    assert.equal(edge("edge-one").watch.kind, "unavailable");
    // A syntactically valid JSON object with an invalid replication shape. Neither the raw
    // payload nor credentials may enter the center's persisted failure summary.
    now = ended;
    a.sendRawBytes(
      Buffer.from('{"type":"replica.ack","durable":"PRIVATE_PAYLOAD","credential":"PRIVATE_CREDENTIAL"}\n'),
    );
    await a.closed;
    t.diagnostic("invalid frame socket closed");
    await waitForState(
      () => !center.status().nodeSessions.find((row) => row.nodeId === "edge-one")?.connected,
      "the center's close observation",
    );
    assert.deepEqual(edge("edge-one").online, { kind: "value", text: `disconnected; lastOnlineAt=${ended}` });
    const failure = edge("edge-one").lastFailure;
    assert.equal(failure.kind, "value");
    assert.match((failure as { text: string }).text, /invalid_frame @ 2026-11-03T02:00:00.000Z:.*frame=.*peer=/u);
    assert.doesNotMatch((failure as { text: string }).text, /PRIVATE_PAYLOAD|PRIVATE_CREDENTIAL/u);
    assert.deepEqual(edge("edge-two").online, { kind: "value", text: "connected" });
    assert.deepEqual(edge("edge-two").lastFailure, { kind: "unavailable", reason: "no-session-failure-observed" });
    b.close();
    await b.closed;
    await waitForState(() => !center.status().nodeSessions.some((row) => row.connected), "both center sessions closed");
    assert.match((edge("edge-two").lastFailure as { text: string }).text, /connection_closed @/u);
    t.diagnostic("both closed, closing center");
    await center.close();
    t.diagnostic("center closed, reopening");
    const reopened = await fixture.openCenter();
    t.diagnostic("center reopened");
    const saved = overview(reopened).nodes.find((node) => node.nodeId === "edge-one")!;
    assert.deepEqual(saved.lastFailure, failure);
    assert.deepEqual(saved.online, edge("edge-one").online);
    assert.deepEqual(saved.build, edge("edge-one").build);
    // Repeated reconnects overwrite the two node rows rather than retaining session history.
    for (let index = 0; index < 3; index++) {
      const peer = await replicationPeer(
        fixture.track,
        reopened.port,
        fixture.cert,
        "edge-one",
        "secret-edge-one",
        "0".repeat(40),
      );
      peer.close();
      await peer.closed;
    }
    const rows = JSON.parse(readFileSync(path.join(fixture.root, "state/node-sessions.json"), "utf8"));
    assert.equal(rows.length, 2);
  },
);

test("authenticated replication rejection preserves the upgrade code and timestamp", { timeout: 60_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t, { now: () => ended }),
    center = await fixture.openCenter();
  const peer = await replicationPeer(fixture.track, center.port, fixture.cert, "edge-one", "secret-edge-one");
  const rejected = await peer.request({
    type: "replica.start",
    repoId: replicationRepoId,
    position: null,
    taskEventShapeVersion: 0,
  });
  assert.equal(rejected.type, "replica.reject");
  await peer.closed;
  await waitForState(() => center.status().nodeSessions[0]?.lastFailure !== null, "upgrade rejection recorded");
  const edge = overview(center).nodes.find((node) => node.nodeId === "edge-one")!;
  assert.match((edge.lastFailure as { text: string }).text, /edge_upgrade_required @ 2026-11-03T02:00:00.000Z/u);
  assert.equal(edge.replicaReason, "sync-failure:edge_upgrade_required");
});

test(
  "fleet overview is a viewer Policy action and repository-read alone cannot authorize it",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    assert.ok(
      deriveBasePolicyGroups()
        .find((group) => group.id === "viewer")!
        .scopes.includes("fleet-overview-read"),
    );
    fixture.owners.keycloak.revoke("person-local", replicationRepoId, ["fleet-overview-read"]);
    fixture.owners.keycloak.permit("person-local", replicationRepoId, ["repository-read"]);
    await assert.rejects(fixture.host.read(replicationRepoId, "repo.fleet.overview.read", {}, fixture.localAuth), {
      code: "authorization_denied",
    });
    fixture.owners.keycloak.permit("person-local", replicationRepoId, ["repository-read", "fleet-overview-read"]);
    assert.equal(
      (await fixture.host.read(replicationRepoId, "repo.fleet.overview.read", {}, fixture.localAuth)).schema,
      "daemon.fleet-overview/v1",
    );
  },
);

test(
  "an edge-reported center upgrade failure keeps its code in the center overview",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t, { now: () => ended }),
      center = await fixture.openCenter();
    const peer = await replicationPeer(fixture.track, center.port, fixture.cert, "edge-one", "secret-edge-one");
    await peer.request({
      type: "replica.start",
      repoId: replicationRepoId,
      position: null,
      taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
    });
    peer.sendRawBytes(
      Buffer.from(
        JSON.stringify({
          type: "replica.failure",
          code: "center_upgrade_required",
          message: "center_upgrade_required: incompatible backup; peer=center; frame=backup",
        }) + "\n",
      ),
    );
    await peer.closed;
    await waitForState(
      () => center.status().nodeSessions[0]?.lastFailure?.code === "center_upgrade_required",
      "the reported failure code",
    );
    const edge = overview(center).nodes.find((node) => node.nodeId === "edge-one")!;
    assert.match(
      (edge.lastFailure as { text: string }).text,
      /center_upgrade_required @ 2026-11-03T02:00:00.000Z:.*frame=backup/u,
    );
  },
);

test(
  "pre-observation nodes are offline without inventing build, online time or failures",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    const state = createNodeSessionStatus({ file: path.join(fixture.root, "observations.json"), now: () => first });
    assert.deepEqual(state.snapshot(["legacy-node"], new Set()), [
      { nodeId: "legacy-node", connected: false, buildCommit: null, lastOnlineAt: null, lastFailure: null },
    ]);
    state.hello("legacy-node", "a".repeat(40));
    state.hello("legacy-node", null);
    assert.equal(state.snapshot([], new Set())[0]!.buildCommit, "a".repeat(40));
    state.removeNode("legacy-node");
    state.online("legacy-node");
    state.failure("legacy-node", "connection_closed", "late close callback");
    assert.deepEqual(state.snapshot([], new Set()), [], "late socket callbacks cannot revive a removed node");
  },
);
