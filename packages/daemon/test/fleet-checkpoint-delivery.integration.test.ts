// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fleetFixture } from "./fleet-tls-session.fixture.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { openPeer, runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { readHeadConfirmation } from "../src/fleet/replica-read-model.ts";
import { withEdgeReadModel } from "../src/fleet-edge-task-read.ts";

test(
  "historical snapshot ACK is usable with truthful lag, then delta and watch follow published checkpoints",
  { timeout: 30_000 },
  async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    const source = f.host.replica(f.subject.repoId);
    const first = (await source.prepare())!;
    const originalPrepare = source.prepare,
      originalActivate = source.activate,
      originalKick = source.kick;
    source.prepare = async () => first;
    source.activate = () => first;
    source.kick = () => {};
    const center = await f.center();
    const options = {
      port: center.port,
      ca: f.cert,
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
      repoId: f.subject.repoId,
      viewRoot: path.join(f.root, "historical"),
      diskQuotaBytes: 64 * 1024 * 1024,
    };
    for (let i = 0; i < 3; i++) {
      const result = await f.host.run(
        f.subject.repoId,
        { kind: "task-create", taskId: `task-new-${i}`, title: `New ${i}` },
        f.auth,
      );
      assert.equal(result.outcome, "applied");
      await waitForFleetPublication(f.host, f.subject.repoId, result.opId, f.auth);
    }
    const head = source.ledgerCut()!;
    assert.ok(head.revision > first.revision);
    assert.equal(source.latest()!.revision, first.revision);
    const frames: string[] = [];
    const frameTimes: number[] = [];
    const pulled = await runFleetReplicaPullClient({
      ...options,
      onFrame: (frame) => {
        frames.push(frame.schema);
        frameTimes.push(performance.now());
      },
    });
    assert.equal(pulled.replica.schema, "fleet.ack.result/v1");
    assert.equal(pulled.current.cut.revision, first.revision);
    assert.equal(pulled.replica.knownHead.revision, head.revision);
    assert.ok(frames.includes("fleet.snapshot.begin/v1"));
    assert.ok(frames.includes("fleet.snapshot.chunk/v1"));
    assert.ok(!frames.includes("fleet.replica.current/v1"));
    const viewDir = path.join(options.viewRoot, "repos", options.repoId, "views", options.nodeId);
    assert.equal(readHeadConfirmation(viewDir)!.headRevision, head.revision);
    withEdgeReadModel({ ...options, principalId: "person-owner" }, (queries, frame) => {
      assert.equal(queries.readCut().sourceRevision, first.revision);
      const listed = queries.list();
      assert.equal(listed.status, "ready");
      assert.ok(listed.rows.some((row) => row.taskId === f.subject.taskId));
      assert.ok(!listed.rows.some((row) => row.taskId === "task-new-0"));
      assert.equal(frame.cut.revision, first.revision);
      assert.equal(frame.freshness.lagRevisions, head.revision - first.revision);
    });
    const maxFrameGap = Math.max(...frameTimes.slice(1).map((at, index) => at - frameTimes[index]!));
    assert.ok(maxFrameGap < 30_000);
    t.diagnostic(
      `historical TLS max frame gap=${maxFrameGap}ms; task list contains the R task and excludes later tasks`,
    );
    const unchanged = await runFleetReplicaPullClient(options);
    assert.equal(unchanged.replica.schema, "fleet.replica.checkpoint/v1");
    assert.equal(unchanged.replica.knownHead.revision, head.revision);
    const watcher = await openPeer(options);
    t.after(() => watcher.close());
    watcher.send({
      schema: "fleet.replica.watch/v1",
      messageId: watcher.messageId(),
      repoId: options.repoId,
      afterRevision: first.revision,
    });
    source.prepare = originalPrepare;
    source.activate = originalActivate;
    source.kick = originalKick;
    originalKick();
    const target = await source.waitForCut(head.revision);
    const hint = await watcher.next();
    assert.equal(hint.schema, "fleet.replica.head-hint/v1");
    if (hint.schema !== "fleet.replica.head-hint/v1") assert.fail("head hint expected");
    assert.equal(hint.cut.revision, target.revision);
    assert.equal(source.cut(first.revision + 1), null, "watch skipped unpublished ledger integers");
    const deltaFrames: string[] = [];
    const caughtUp = await runFleetReplicaPullClient({
      ...options,
      onFrame: (frame) => deltaFrames.push(frame.schema),
    });
    assert.ok(deltaFrames.includes("fleet.delta.begin/v1"));
    assert.equal(caughtUp.current.cut.revision, target.revision);
    assert.equal(caughtUp.current.cut.headDigest, target.headDigest);
    assert.equal(caughtUp.current.manifestDigest, target.manifest.digest);
    const current = await runFleetReplicaPullClient(options);
    assert.equal(current.replica.schema, "fleet.replica.current/v1");
    t.diagnostic(
      `snapshot begin/bytes/ACK R=${first.revision}, H=${head.revision}; local model readable; delta identity=${target.manifest.digest}`,
    );
  },
);

test("a slow content RPC cannot revive its expired delivery lease", { timeout: 15_000 }, async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const source = f.host.replica(f.subject.repoId);
  await source.prepare();
  const content = source.delivery.content;
  const { DatabaseSync } = await import("node:sqlite");
  let crossed = false;
  t.mock.method(source.delivery, "content", async (blob) => {
    const result = await content(blob);
    if (!crossed) {
      crossed = true;
      const db = new DatabaseSync(path.join(f.stateRoot, "replica/repos", f.subject.repoId, "ack.sqlite"));
      try {
        db.prepare("UPDATE delivery_lease SET expires_at=0 WHERE node_id=?").run(f.subject.nodeId);
      } finally {
        db.close();
      }
    }
    return result;
  });
  const center = await f.center();
  await assert.rejects(
    runFleetReplicaPullClient({
      port: center.port,
      ca: f.cert,
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
      repoId: f.subject.repoId,
      viewRoot: path.join(f.root, "expired-rpc"),
      diskQuotaBytes: 64 * 1024 * 1024,
    }),
    { code: "replica_delivery_fenced" },
  );
  assert.equal(crossed, true);
});
