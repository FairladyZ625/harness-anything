// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fleetFixture, replicaQuota } from "./fleet-tls-session.fixture.ts";
import { FleetRemoteError, openFleetEdgeView, runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import type { FleetFrameV1 } from "../src/fleet/contract.ts";
import { FleetFault } from "../src/fleet/center-types.ts";
import { edgeContentBytes, withEdgeManifest } from "../src/fleet/replica-read-model.ts";
import { locateFleetMirrorView, fleetMirrorCutFile } from "../src/fleet-edge-mirror.ts";

for (const phase of ["after_page", "after_chunk", "before_current_rename"] as const) {
  test(`failed first pull at ${phase} removes staging, unpublished cuts and orphan content`, async (t) => {
    const f = await fleetFixture(t);
    const center = await f.center();
    const viewRoot = path.join(f.root, "edge");
    const options = {
      port: center.port,
      ca: f.cert,
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
      repoId: f.subject.repoId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
    };
    const failure = new Error(`interrupted at ${phase}`);
    await assert.rejects(
      runFleetReplicaPullClient({
        ...options,
        edgeKillpoint: (point) => {
          if (point === phase) throw failure;
        },
      }),
      (error: unknown) => error === failure,
    );
    assertEmptyTransfer(viewRoot, f.subject.repoId, f.subject.nodeId);
    // A new connection and receiver must complete from the clean disk state.
    const recovered = await runFleetReplicaPullClient(options);
    assert.equal(recovered.replica.outcome, "applied");
    assert.ok(locateFleetMirrorView(viewRoot, f.subject.repoId, f.subject.nodeId));
  });
}

test("a center delivery error cleans received content and preserves its error code", async (t) => {
  const f = await fleetFixture(t);
  const center = await f.center();
  const source = f.host.replica(f.subject.repoId);
  const content = source.delivery.content;
  let reads = 0,
    chunks = 0;
  // First read checks offer metadata; the next read supplies a real delivered blob.
  t.mock.method(source.delivery, "content", async (...args: Parameters<typeof content>) => {
    if (++reads === 3) throw new FleetFault("replica_delivery_fenced", "interrupted delivery");
    return content(...args);
  });
  const viewRoot = path.join(f.root, "remote-error");
  await assert.rejects(
    runFleetReplicaPullClient({
      port: center.port,
      ca: f.cert,
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
      repoId: f.subject.repoId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
      onFrame: (frame) => {
        if (frame.schema === "fleet.snapshot.chunk/v1") chunks++;
      },
    }),
    (error: unknown) => error instanceof FleetRemoteError && error.code === "replica_delivery_fenced",
  );
  assert.ok(chunks > 0, "the transport must deliver content before failing");
  assertEmptyTransfer(viewRoot, f.subject.repoId, f.subject.nodeId);
});

test("lost ACK preserves the published cut while removing transfer staging", async (t) => {
  const f = await fleetFixture(t);
  const center = await f.center();
  const viewRoot = path.join(f.root, "lost-ack");
  await assert.rejects(
    runFleetReplicaPullClient({
      port: center.port,
      ca: f.cert,
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
      repoId: f.subject.repoId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
      beforeAck: () => {
        throw new Error("lost ACK");
      },
    }),
    /lost ACK/u,
  );
  const view = locateFleetMirrorView(viewRoot, f.subject.repoId, f.subject.nodeId)!;
  assert.ok(view);
  assert.deepEqual(readdirSync(path.join(view.viewDir, ".staging")), []);
  for (const [entryPath] of view.entries) assert.ok(fleetMirrorCutFile(view, entryPath));
});

test("the next pull removes staging left by a stopped receiver before accepting a new offer", async (t) => {
  const f = await fleetFixture(t);
  const center = await f.center();
  const options = {
    port: center.port,
    ca: f.cert,
    credential: "machine-secret",
    repoId: f.subject.repoId,
    diskQuotaBytes: replicaQuota,
  };
  const frames: FleetFrameV1[] = [];
  await runFleetReplicaPullClient({
    ...options,
    nodeId: f.peerSubject.nodeId,
    viewRoot: path.join(f.root, "source"),
    onFrame: (frame) => {
      if (frame.schema.startsWith("fleet.snapshot.")) frames.push(frame);
    },
  });
  const viewRoot = path.join(f.root, "restart");
  const stopped = openFleetEdgeView(viewRoot, replicaQuota, (point) => {
    if (point === "before_current_rename") throw new Error("stopped receiver");
  });
  assert.throws(() => {
    for (const frame of frames)
      stopped.receive(frame.schema === "fleet.snapshot.begin/v1" ? { ...frame, viewId: f.subject.nodeId } : frame);
  }, /stopped receiver/u);
  let begins = 0;
  const result = await runFleetReplicaPullClient({
    ...options,
    nodeId: f.subject.nodeId,
    viewRoot,
    onFrame: (frame) => {
      if (frame.schema === "fleet.snapshot.begin/v1") {
        begins++;
        assertEmptyTransfer(viewRoot, f.subject.repoId, f.subject.nodeId);
      }
    },
  });
  assert.equal(begins, 1);
  assert.equal(result.replica.outcome, "applied");
});

function assertEmptyTransfer(root: string, repoId: string, nodeId: string): void {
  const repo = path.join(root, "repos", repoId);
  const view = path.join(repo, "views", nodeId);
  assert.deepEqual(readdirSync(path.join(view, ".staging")), []);
  assert.equal(existsSync(path.join(view, "current.json")), false);
  const cuts = path.join(view, "cuts");
  assert.deepEqual(existsSync(cuts) ? readdirSync(cuts) : [], []);
  const cas = path.join(repo, "cas", "sha256");
  assert.deepEqual(
    existsSync(cas) ? readdirSync(cas).flatMap((prefix) => readdirSync(path.join(cas, prefix))) : [],
    [],
  );
  assert.equal(edgeContentBytes(repo), 0);
  withEdgeManifest(view, (db) => {
    for (const table of ["edge_cut", "edge_entry", "edge_content", "edge_orphan"])
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table);
    assert.equal(
      db.prepare("PRAGMA freelist_count").get()!.freelist_count,
      0,
      "deleted index pages release disk space",
    );
  });
}
