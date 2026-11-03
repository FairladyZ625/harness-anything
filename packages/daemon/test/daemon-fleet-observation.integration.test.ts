// harness-test-tier: integration
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { TLSSocket } from "node:tls";
import { TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel";
import { withDaemonObservation, type DaemonOperationObserver } from "../src/daemon-operation.ts";
import type { DaemonTrafficLogEntry } from "../src/conn-log.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
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
        record: Record<string, unknown> = { ...fields };
      records.push(record);
      active.set(id, record);
      return {
        update: (update) => {
          Object.assign(record, update);
          if (typeof update.phase === "string") {
            const sequence = (record.phaseSequence as string[] | undefined) ?? [];
            sequence.push(update.phase);
            record.phaseSequence = sequence;
          }
        },
        end: () => {
          record.endCount = Number(record.endCount ?? 0) + 1;
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
  assert.equal(request.phase, "reply");
  assert.equal(request.nodeId, f.subject.nodeId);
  assert.ok(Number(request.requestBytes) > 0);
  assert.ok(Number(request.replyBytes) > 0);
  assert.equal(request.outcome, "ok");
  assert.ok((request.phaseSequence as string[]).includes("authorization"), JSON.stringify(request.phaseSequence));
  assert.ok((request.phaseSequence as string[]).includes("projection-read"), JSON.stringify(request.phaseSequence));
  assert.ok((request.phaseSequence as string[]).includes("serialization"), JSON.stringify(request.phaseSequence));
  assert.ok((request.phaseSequence as string[]).includes("reply"), JSON.stringify(request.phaseSequence));
  assert.deepEqual(Object.keys(request).sort(), [
    "actor",
    "endCount",
    "endedAtMs",
    "method",
    "nodeId",
    "outcome",
    "phase",
    "phaseMark",
    "phaseSequence",
    "replyBytes",
    "repoId",
    "requestBytes",
    "spanId",
    "startedAt",
    "startedAtMs",
    "traceId",
  ]);
  const failedResponse = await peer.request({
    schema: "fleet.repo.metadata.get/v1",
    messageId: "observed-failure",
    repoId: "repo-missing",
    accessToken: "invalid-token",
    includeGitMetadata: false,
  });
  assert.equal(failedResponse.schema, "fleet.error/v1");
  const failed = observed.records.find((row) => row.method === "fleet.repo.metadata.get/v1");
  assert.ok(failed);
  assert.equal(failed.outcome, "error");
  assert.ok(Number(failed.requestBytes) > 0);
  assert.ok(Number(failed.replyBytes) > 0);
  assert.ok((failed.phaseSequence as string[]).includes("serialization"), JSON.stringify(failed.phaseSequence));
  assert.ok((failed.phaseSequence as string[]).includes("reply"), JSON.stringify(failed.phaseSequence));
  assert.ok(!JSON.stringify(observed.records).includes("machine-secret"));
  assert.equal(observed.active.size, 0);
});

async function failingCenter(t: TestContext, nodeOwner: (nodeId: string) => Promise<string | null>) {
  const f = await fleetFixture(t),
    observed = observation(),
    traffic: DaemonTrafficLogEntry[] = [];
  const center = await withDaemonObservation(observed.observer, () =>
    f.hold(
      listenFleetTls({
        host: f.host,
        stateRoot: f.stateRoot,
        ...f.writerOptions,
        key: f.key,
        cert: f.cert,
        authenticate: () => true,
        nodeOwner,
        recordTraffic: (row) => traffic.push(row),
        onError: (entry) => f.transportErrors.push(entry),
      }),
    ),
  );
  return { f, center, observed, traffic };
}

test("Fleet error encoding and backpressure belong to serialization and reply until delivery ends", async (t) => {
  const { f, center, observed, traffic } = await failingCenter(t, async () => null),
    peer = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret"),
    started = Promise.withResolvers<TLSSocket>(),
    hrtime = process.hrtime.bigint,
    stringify = JSON.stringify,
    write = TLSSocket.prototype.write;
  let offset = 0n,
    encoded = false;
  t.mock.method(process.hrtime, "bigint", () => hrtime() + offset);
  t.mock.method(JSON, "stringify", (value: unknown, ...args: unknown[]) => {
    if (!encoded && (value as { schema?: string })?.schema === "fleet.error/v1") {
      encoded = true;
      offset += 30_000_000n;
    }
    return Reflect.apply(stringify, JSON, [value, ...args]);
  });
  t.mock.method(TLSSocket.prototype, "write", function (this: TLSSocket, chunk: unknown, ...args: unknown[]) {
    const sent = Reflect.apply(write, this, [chunk, ...args]);
    if (typeof chunk === "string" && chunk.includes('"schema":"fleet.error/v1"')) {
      started.resolve(this);
      return false;
    }
    return sent;
  });
  const response = peer.request({ schema: "fleet.device.sessions.revoke/v1", messageId: "slow-error" }),
    socket = await started.promise;
  try {
    assert.equal(traffic.length, 0, "error operation must stay open while its socket is backpressured");
    assert.equal(observed.active.size, 1);
    offset += 50_000_000n;
  } finally {
    socket.emit("drain");
  }
  assert.equal((await response).schema, "fleet.error/v1");
  await waitForState(() => traffic.length === 1, "error delivery settled");
  const row = traffic[0]!,
    duration = (name: string) =>
      (row.phases ?? [])
        .filter((phase) => phase.name === name)
        .reduce((total, phase) => total + phase.endedAtMs - phase.startedAtMs, 0);
  assert.ok(duration("serialization") >= 30, JSON.stringify(row.phases));
  assert.ok(duration("reply") >= 50, JSON.stringify(row.phases));
  assert.equal(row.ok, false);
  assert.equal(row.code, "node_owner_unregistered");
  assert.ok(Number(row.replyBytes) > 0);
  assert.equal(observed.active.size, 0);
  assert.equal(observed.records.at(-1)!.endCount, 1);
});

test("two Fleet nodes reuse a messageId, fail together and settle their own deliveries out of order", async (t) => {
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()],
    verdicts = [Promise.withResolvers<string | null>(), Promise.withResolvers<string | null>()],
    { f, center, observed, traffic } = await failingCenter(t, (nodeId) => {
      const index = nodeId === "node-one" ? 0 : 1;
      entered[index]!.resolve();
      return verdicts[index]!.promise;
    }),
    peerA = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret"),
    peerB = await rawPeer(f.track, center.port, f.cert, f.peerSubject.nodeId, "machine-secret");
  const frame = {
      schema: "fleet.device.sessions.revoke/v1" as const,
      messageId: "shared-failure",
    },
    a = peerA.request(frame),
    b = peerB.request(frame);
  await Promise.all(entered.map((entry) => entry.promise));
  assert.equal(observed.active.size, 2);
  // Both handlers have failed before either delivery finishes; B sends first and has a different byte count.
  verdicts[0]!.resolve(null);
  verdicts[1]!.reject(Object.assign(new Error("node-two owner registry unavailable"), { code: "registry_down" }));
  const write = TLSSocket.prototype.write,
    blocked = Promise.withResolvers<TLSSocket>();
  t.mock.method(TLSSocket.prototype, "write", function (this: TLSSocket, chunk: unknown, ...args: unknown[]) {
    const sent = Reflect.apply(write, this, [chunk, ...args]);
    if (typeof chunk === "string" && chunk.includes('"code":"node_owner_unregistered"')) {
      blocked.resolve(this);
      return false;
    }
    return sent;
  });
  const socket = await blocked.promise;
  try {
    assert.equal((await b).schema, "fleet.error/v1");
    await waitForState(() => traffic.length === 1, "B settled while A waits for drain");
    assert.equal(traffic[0]!.nodeId, "node-two");
    assert.equal(traffic[0]!.code, "handler_failed");
    assert.equal(observed.active.size, 1);
  } finally {
    socket.emit("drain");
  }
  assert.equal((await a).schema, "fleet.error/v1");
  await waitForState(() => traffic.length === 2, "both error deliveries settled");
  const failed = observed.records.filter((row) => row.method === frame.schema);
  assert.equal(failed.length, 2, JSON.stringify(failed));
  for (const row of failed) {
    assert.equal(row.outcome, "error");
    assert.ok(Number(row.replyBytes) > 0);
    assert.equal(row.endCount, 1);
    assert.equal(row.replyBytes, traffic.find((entry) => entry.nodeId === row.nodeId)!.replyBytes);
  }
  assert.notEqual(traffic[0]!.replyBytes, traffic[1]!.replyBytes);
  assert.equal(observed.active.size, 0);
});

test("a Fleet failure after disconnect ends its request once with zero sent bytes", async (t) => {
  const entered = Promise.withResolvers<void>(),
    verdict = Promise.withResolvers<string | null>(),
    { f, center, observed, traffic } = await failingCenter(t, () => {
      entered.resolve();
      return verdict.promise;
    }),
    peer = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret");
  peer.write({ schema: "fleet.device.sessions.revoke/v1", messageId: "disconnected-error" });
  await entered.promise;
  center.disconnectNode(f.subject.nodeId);
  await peer.closed;
  verdict.resolve(null);
  await waitForState(() => traffic.length === 1, "disconnected failure settled");
  assert.equal(traffic[0]!.replyBytes, 0);
  assert.equal(traffic[0]!.ok, false);
  assert.equal(observed.active.size, 0);
  assert.equal(observed.records.at(-1)!.endCount, 1);
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
