// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { sqliteLedgerPath, resolveActiveGeneration } from "@harness-anything/kernel";
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

test(
  "continuous canonical writes outpace construction while TLS snapshot reaches ACK",
  { timeout: 60_000 },
  async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    const source = f.host.replica(f.subject.repoId);
    const generation = resolveActiveGeneration({ rootInput: f.repo, repoId: f.subject.repoId });
    const objectRoot = path.join(path.dirname(sqliteLedgerPath(f.repo, generation)), "objects/sha256");
    const db = new DatabaseSync(path.join(f.repo, ".harness/cache/task.sqlite"));
    try {
      const insert = db.prepare("INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)");
      db.exec("BEGIN");
      for (let i = 0; i < 2048; i++) {
        const body = `${i}:` + "x".repeat(32 * 1024);
        const itemPath = `context/load-${i}.md`;
        const digest = createHash("sha256").update(body).digest("hex");
        const objectDir = path.join(objectRoot, digest.slice(0, 2));
        mkdirSync(objectDir, { recursive: true });
        writeFileSync(path.join(objectDir, digest.slice(2)), body);
        insert.run(
          itemPath,
          1,
          JSON.stringify({
            path: itemPath,
            body,
            blobSha256: digest,
            size: Buffer.byteLength(body),
            mediaType: "text/markdown",
            policyId: "markdown-body-replaceable/v1",
            workspaceRevision: 1,
          }),
        );
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    // Reserve the bounded writer's logical manifest retention, not just one snapshot.
    const quota = 16 * 1024 * 1024 * 1024;
    const center = await f.center(quota);
    const started = performance.now();
    const progress: { phase: string; ms: number; writes: number; head: number; built: number }[] = [];
    let writes = 0,
      built = false,
      acknowledged = false,
      began = false;
    let writesDuringBuild = 0,
      writesDuringDelivery = 0,
      contentBytes = 0;
    const sample = (phase: string) =>
      progress.push({
        phase,
        ms: performance.now() - started,
        writes,
        head: source.ledgerCut()!.revision,
        built: source.latest()?.revision ?? 0,
      });
    t.after(() => {
      acknowledged = true;
      t.diagnostic(JSON.stringify({ writesDuringBuild, writesDuringDelivery, progress }));
      for (const entry of f.transportErrors) t.diagnostic(String((entry as { error: Error }).error?.stack));
    });
    const building = source.prepare().then((cut) => {
      built = true;
      sample("built");
      return cut;
    });
    const writing = (async () => {
      while (!acknowledged && writes < 200) {
        const result = await f.host.run(
          f.subject.repoId,
          { kind: "task-create", taskId: `task-load-${writes}`, title: `Load ${writes}` },
          f.auth,
        );
        assert.equal(result.outcome, "applied");
        await waitForFleetPublication(f.host, f.subject.repoId, result.opId, f.auth);
        writes++;
        if (!built) writesDuringBuild++;
        if (began && !acknowledged) writesDuringDelivery++;
        sample("write");
      }
    })();
    const pulling = runFleetReplicaPullClient({
      port: center.port,
      ca: f.cert,
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
      repoId: f.subject.repoId,
      viewRoot: path.join(f.root, "continuous"),
      diskQuotaBytes: quota,
      onFrame: (frame) => {
        if (frame.schema === "fleet.snapshot.begin/v1") {
          began = true;
          sample("begin");
        }
        if (frame.schema === "fleet.snapshot.chunk/v1") {
          contentBytes += Buffer.from(frame.dataBase64, "base64").length;
          if (!progress.some((row) => row.phase === "content")) sample("content");
        }
        if (frame.schema === "fleet.ack.result/v1") {
          acknowledged = true;
          sample("ack");
        }
      },
    }).finally(() => {
      acknowledged = true;
    });
    const [first, , pulled] = await Promise.all([building, writing, pulling]);
    assert.ok(first);
    t.diagnostic(
      JSON.stringify({
        firstRevision: first.revision,
        deliveredRevision: pulled.current.cut.revision,
        knownHead: pulled.replica.knownHead.revision,
        contentBytes,
      }),
    );
    assert.ok(contentBytes >= 64 * 1024 * 1024);
    assert.ok(writes < 200, "writer remains active until ACK rather than exhausting its bound");
    assert.ok(
      progress.find((row) => row.phase === "built")!.head > first.revision,
      "canonical writes advance beyond the captured snapshot before construction finishes",
    );
    assert.ok(writesDuringBuild >= 2, "multiple real writes complete during one checkpoint build");
    assert.ok(writesDuringDelivery > 0, "real writes continue between begin and ACK");
    assert.ok(progress.some((row) => row.phase === "content"));
    assert.ok(progress.some((row) => row.phase === "ack"));
    assert.equal(pulled.replica.schema, "fleet.ack.result/v1");
    assert.ok(pulled.replica.knownHead.revision > pulled.current.cut.revision);
    withEdgeReadModel(
      {
        viewRoot: path.join(f.root, "continuous"),
        repoId: f.subject.repoId,
        nodeId: f.subject.nodeId,
        principalId: "person-owner",
      },
      (queries) => {
        assert.equal(queries.readCut().sourceRevision, pulled.current.cut.revision);
        assert.ok(queries.list().rows.some((row) => row.taskId === f.subject.taskId));
      },
    );
  },
);
