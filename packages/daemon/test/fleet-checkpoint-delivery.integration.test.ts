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
      originalKick = source.kick;
    source.prepare = async () => first;
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
    const pulled = await runFleetReplicaPullClient({ ...options, onFrame: (frame) => frames.push(frame.schema) });
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
      assert.equal(frame.cut.revision, first.revision);
      assert.equal(frame.freshness.lagRevisions, head.revision - first.revision);
    });
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
