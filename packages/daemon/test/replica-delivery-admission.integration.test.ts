// harness-test-tier: integration
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { fleetFixture } from "./fleet-tls-session.fixture.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";

test("waiting for the cut owner does not consume the delivery lease", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const source = f.host.replica(f.subject.repoId);
  await source.prepare();
  const center = await f.center();
  const { promise: queued, resolve: markQueued } = Promise.withResolvers<void>();
  const { promise: resume, resolve: release } = Promise.withResolvers<void>();
  t.after(release);
  const pin = source.pin;
  t.mock.method(source, "pin", async (...args: Parameters<typeof pin>) => {
    markQueued();
    await resume;
    return pin(...args);
  });
  const pulling = runFleetReplicaPullClient({
    port: center.port,
    ca: f.cert,
    nodeId: f.subject.nodeId,
    credential: "machine-secret",
    repoId: f.subject.repoId,
    viewRoot: path.join(f.root, "queued"),
    diskQuotaBytes: 64 * 1024 * 1024,
  });
  await queued;
  assert.equal(center.pendingDeliveries(), 1, "queued owner work must hold build drain before lease claim");
  // Expire any lease acquired before the queued owner operation without a wall-clock sleep.
  const file = path.join(f.stateRoot, "replica", "repos", f.subject.repoId, "ack.sqlite");
  const database = new DatabaseSync(file);
  try {
    if (database.prepare("SELECT name FROM sqlite_master WHERE name='delivery_lease'").get())
      database.prepare("UPDATE delivery_lease SET expires_at=? WHERE node_id=?").run(Date.now() - 1, f.subject.nodeId);
  } finally {
    database.close();
  }
  release();
  const result = await pulling;
  assert.equal(result.replica.schema, "fleet.ack.result/v1");
  assert.equal(center.pendingDeliveries(), 0, "accepted ACK settles the admitted delivery");
});

test("edge collection waits until the center accepts the durable ACK", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const center = await f.center();
  const viewRoot = path.join(f.root, "after-ack");
  const views = path.join(viewRoot, "repos", f.subject.repoId, "views");
  let acknowledged = false,
    collections = 0;
  const read = fs.readdirSync;
  const mocked = t.mock.method(fs, "readdirSync", (...args: Parameters<typeof read>) => {
    if (String(args[0]) === views && fs.existsSync(path.join(views, f.subject.nodeId, "current.json"))) {
      assert.equal(acknowledged, true, "garbage collection must not spend the ACK lease");
      collections++;
    }
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const result = await runFleetReplicaPullClient({
    port: center.port,
    ca: f.cert,
    nodeId: f.subject.nodeId,
    credential: "machine-secret",
    repoId: f.subject.repoId,
    viewRoot,
    diskQuotaBytes: 64 * 1024 * 1024,
    onFrame: (frame) => {
      if (frame.schema === "fleet.ack.result/v1") acknowledged = frame.outcome !== "op_rejected";
    },
  });
  assert.equal(result.replica.schema, "fleet.ack.result/v1");
  assert.equal(collections, 1);
  assert.deepEqual(fs.readdirSync(path.join(views, f.subject.nodeId, ".staging")), []);
});

for (const phase of ["makeOffer", "manifestPage"] as const) {
  test(`${phase} keeps its lease across the TTL while another first sync ACKs`, { timeout: 60_000 }, async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    const source = f.host.replica(f.subject.repoId);
    await source.prepare();
    const center = await f.center();
    const { promise: held, resolve: markHeld } = Promise.withResolvers<void>();
    const { promise: resume, resolve: release } = Promise.withResolvers<void>();
    t.after(release);
    let stalled = false;
    const hold = async () => {
      if (!stalled) {
        stalled = true;
        markHeld();
        await resume;
      }
    };
    if (phase === "makeOffer") {
      const content = source.delivery.content;
      t.mock.method(source.delivery, "content", async (blob) => {
        await hold();
        return content(blob);
      });
    } else {
      const page = source.delivery.manifestPage;
      t.mock.method(source.delivery, "manifestPage", async (...args: Parameters<typeof page>) => {
        await hold();
        return page(...args);
      });
    }
    const options = {
      port: center.port,
      ca: f.cert,
      credential: "machine-secret",
      repoId: f.subject.repoId,
      diskQuotaBytes: 64 * 1024 * 1024,
      timeoutMs: 55_000,
    };
    const pulling = runFleetReplicaPullClient({
      ...options,
      nodeId: f.subject.nodeId,
      viewRoot: path.join(f.root, "stalled"),
    });
    // Observe rejection immediately even if an assertion fails before the held read resumes.
    const outcome = pulling.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await held;
    const slowLease = center.status().replicas.find((row) => row.nodeId === f.subject.nodeId)!.deliveryLease!;
    const healthy = await runFleetReplicaPullClient({
      ...options,
      nodeId: f.peerSubject.nodeId,
      viewRoot: path.join(f.root, "healthy"),
    });
    assert.equal(healthy.replica.schema, "fleet.ack.result/v1");
    const afterPeer = center.status().replicas.find((row) => row.nodeId === f.subject.nodeId)!.deliveryLease!;
    assert.equal(afterPeer.holderId, slowLease.holderId);
    assert.equal(afterPeer.claimFence, slowLease.claimFence);
    // Real elapsed time across the production TTL: no fabricated expiry or changed lease duration.
    await delay(Math.max(0, slowLease.expiresAt - Date.now() + 100));
    const renewed = center.status().replicas.find((row) => row.nodeId === f.subject.nodeId)!.deliveryLease;
    t.diagnostic(
      JSON.stringify({ phase, waitedMs: Date.now() - slowLease.expiresAt + 30_000, initial: slowLease, renewed }),
    );
    assert.ok(renewed, "legitimate preparation must retain the lease beyond its original TTL");
    assert.equal(renewed.holderId, slowLease.holderId);
    assert.equal(renewed.claimFence, slowLease.claimFence);
    assert.ok(renewed.expiresAt > slowLease.expiresAt);
    assert.equal(source.pinActive(slowLease), true);
    const write = await f.host.run(
      f.subject.repoId,
      { kind: "task-create", taskId: "task-prune", title: "Prune" },
      f.auth,
    );
    assert.equal(write.outcome, "applied");
    await waitForFleetPublication(f.host, f.subject.repoId, write.opId, f.auth);
    await source.waitForCut(source.ledgerCut()!.revision);
    assert.equal(source.pinActive(slowLease), true, "checkpoint GC must retain the live delivery pin");
    release();
    const result = await outcome;
    if ("error" in result) throw result.error;
    assert.equal(result.value.replica.schema, "fleet.ack.result/v1");
    assert.equal(center.pendingDeliveries(), 0);
    assert.equal(center.status().replicas.find((row) => row.nodeId === f.subject.nodeId)!.deliveryLease, null);
    assert.equal(
      center.status().replicas.find((row) => row.nodeId === f.peerSubject.nodeId)!.ackRevision,
      healthy.current.cut.revision,
    );
  });
}
