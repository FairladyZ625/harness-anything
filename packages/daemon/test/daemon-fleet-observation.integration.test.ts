// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel";
import { withDaemonObservation, type DaemonOperationObserver } from "../src/daemon-operation.ts";
import { fleetFixture, rawPeer } from "./fleet-tls-session.fixture.ts";
import {
  fleetReplicationFixture,
  replicationPeer,
  replicationRepoId,
  waitForState,
} from "./fleet-replication.fixture.ts";

function observation() {
  let next = 0;
  const active = new Map<number, Record<string, unknown>>(),
    records: Record<string, unknown>[] = [];
  const observer: DaemonOperationObserver = {
    begin: (fields) => {
      const id = ++next,
        record = { ...fields };
      records.push(record);
      active.set(id, record);
      return {
        update: (update) => {
          Object.assign(record, update);
        },
        end: () => {
          active.delete(id);
        },
      };
    },
  };
  return { observer, active, records };
}

test("real Fleet callbacks bind their observer across TLS queues without recording credentials or payloads", async (t) => {
  const f = await fleetFixture(t),
    observed = observation();
  t.after(() => f.close());
  const center = await withDaemonObservation(observed.observer, () => f.center()),
    peer = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret");
  const response = await peer.request({
    schema: "fleet.operational.read/v1",
    messageId: "observed-read",
    repoId: f.subject.repoId,
    method: "repo.task.dispatches",
    payload: { taskId: f.subject.taskId },
  });
  assert.equal(response.schema, "fleet.operational.read.result/v1");
  assert.ok(observed.records.some((row) => row.method === "fleet.hello"));
  const request = observed.records.find((row) => row.method === "repo.task.dispatches");
  assert.ok(request);
  assert.equal(request.repoId, f.subject.repoId);
  assert.equal(request.actor, `node:${f.subject.nodeId}`);
  assert.equal(request.phase, "fleet-dispatch");
  assert.equal(request.nodeId, f.subject.nodeId);
  assert.deepEqual(Object.keys(request).sort(), [
    "actor",
    "endedAtMs",
    "method",
    "nodeId",
    "outcome",
    "phase",
    "replyBytes",
    "repoId",
    "requestBytes",
    "spanId",
    "startedAt",
    "startedAtMs",
    "traceId",
  ]);
  assert.ok(!JSON.stringify(observed.records).includes("machine-secret"));
  assert.equal(observed.active.size, 0);
});

test(
  "real replication stream and basebackup remain visible until their own completion",
  { timeout: 60_000 },
  async (t) => {
    const f = await fleetReplicationFixture(t),
      observed = observation(),
      center = await withDaemonObservation(observed.observer, () => f.openCenter()),
      peer = await replicationPeer(f.track, center.port, f.cert, "edge-one", "secret-edge-one", "0".repeat(40));
    const accepted = await peer.request({
      type: "replica.start",
      repoId: replicationRepoId,
      position: null,
      edgeBuildCommit: null,
      taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
    });
    assert.equal(accepted.type, "replica.accept");
    const stream = [...observed.active.values()].find((row) => row.method === "replica.start");
    assert.ok(stream);
    assert.equal(stream.repoId, replicationRepoId);
    assert.equal(stream.actor, "node:edge-one");
    assert.equal(stream.phase, "replication-stream");
    await waitForState(
      () => observed.records.some((row) => row.method === "fleet.basebackup" && row.repoId === replicationRepoId),
      "observed real basebackup",
    );
    assert.ok(observed.records.some((row) => row.method === "fleet.basebackup" && row.phase === "archive"));
    peer.close();
    await peer.closed;
    await waitForState(
      () => ![...observed.active.values()].some((row) => row.method === "replica.start"),
      "observed stream removed",
    );
    await center.close();
    assert.equal(observed.active.size, 0);
  },
);
