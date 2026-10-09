// harness-test-tier: integration
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
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
