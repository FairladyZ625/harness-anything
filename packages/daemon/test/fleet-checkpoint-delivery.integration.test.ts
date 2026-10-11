// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { sqliteLedgerPath, resolveActiveGeneration } from "@harness-anything/kernel";
import test from "node:test";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { fleetFixture } from "./fleet-tls-session.fixture.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { openPeer, runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { readHeadConfirmation } from "../src/fleet/replica-read-model.ts";
import { withEdgeReadModel } from "../src/fleet-edge-task-read.ts";
import { openReplicaAckStore } from "../src/fleet/replica-ack-store.ts";

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
      readAccessToken: async () => `device-token-${f.subject.nodeId}`,
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

for (const through of ["known-head", "write-revision"] as const) {
  test(`command pull waits beyond a historical ACK through ${through}`, async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    const source = f.host.replica(f.subject.repoId);
    const first = (await source.prepare())!;
    const activate = source.activate,
      kick = source.kick;
    source.activate = () => first;
    source.kick = () => {};
    const write = await f.host.run(
      f.subject.repoId,
      { kind: "task-create", taskId: "task-after-checkpoint", title: "After checkpoint" },
      f.auth,
    );
    assert.equal(write.outcome, "applied");
    await waitForFleetPublication(f.host, f.subject.repoId, write.opId, f.auth);
    const target = source.ledgerCut()!.revision;
    assert.ok(target > first.revision);
    const center = await f.center();
    const acked: number[] = [];
    const result = await runFleetReplicaPullClient({
      readAccessToken: async () => `device-token-${f.subject.nodeId}`,
      port: center.port,
      ca: f.cert,
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
      repoId: f.subject.repoId,
      viewRoot: path.join(f.root, "command-pull"),
      diskQuotaBytes: 64 * 1024 * 1024,
      through: through === "known-head" ? "known-head" : target,
      beforeAck: (ack) => {
        acked.push(ack.cut.revision);
        source.activate = activate;
        source.kick = kick;
        kick();
      },
    });
    assert.equal(acked[0], first.revision, "the first ACK is only the usable historical checkpoint");
    assert.ok(result.current.cut.revision >= target, "command settlement includes its fixed target revision");
    withEdgeReadModel(
      {
        viewRoot: path.join(f.root, "command-pull"),
        repoId: f.subject.repoId,
        nodeId: f.subject.nodeId,
        principalId: "person-owner",
      },
      (queries) => {
        assert.ok(queries.list().rows.some((row) => row.taskId === "task-after-checkpoint"));
      },
    );
  });
}

test(
  "delivery leases use the host wall clock across worker pins and business clock jumps",
  { timeout: 30_000 },
  async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    let businessTime = "2000-01-01T00:00:00.000Z";
    const center = await f.center(undefined, { now: () => businessTime });
    const source = f.host.replica(f.subject.repoId);
    const content = source.delivery.content;
    let observed = false;
    t.mock.method(source.delivery, "content", async (blob) => {
      businessTime = "2100-01-01T00:00:00.000Z";
      const status = center.status().replicas.find((row) => row.nodeId === f.subject.nodeId)!;
      assert.equal(status.activeTransfers, 1);
      assert.ok(status.deliveryLease!.expiresAt > Date.now());
      assert.ok(status.deliveryLease!.expiresAt <= Date.now() + 30_000);
      observed = true;
      return content(blob);
    });
    const result = await runFleetReplicaPullClient({
      readAccessToken: async () => `device-token-${f.subject.nodeId}`,
      port: center.port,
      ca: f.cert,
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
      repoId: f.subject.repoId,
      viewRoot: path.join(f.root, "lease-clock"),
      diskQuotaBytes: 64 * 1024 * 1024,
    });
    assert.equal(observed, true);
    assert.equal(result.replica.schema, "fleet.ack.result/v1");
    const status = center.status().replicas.find((row) => row.nodeId === f.subject.nodeId)!;
    assert.equal(status.activeTransfers, 0);
    assert.equal(status.ackRevision, result.current.cut.revision);
    assert.ok(Math.abs(Date.parse(status.ackedAt!) - Date.now()) < 30_000);
  },
);

for (const phase of ["Delivery", "ACK"] as const) {
  for (const cause of [
    "pin",
    "expired",
    "replaced",
    "released",
    "missing",
    "expired-replaced",
    "expired-released",
  ] as const) {
    test(`${phase} reports ${cause} fencing separately`, { timeout: 15_000 }, async (t) => {
      const f = await fleetFixture(t);
      t.after(() => f.close());
      const source = f.host.replica(f.subject.repoId);
      await source.prepare();
      const interleaving = cause === "expired-replaced" || cause === "expired-released";
      const initialCause = interleaving ? "expired" : cause;
      let changedAfterDecision = false;
      let crossed = false;
      const fence = () => {
        crossed = true;
        if (cause === "pin") {
          t.mock.method(source, "pinActive", () => false);
        } else {
          const db = new DatabaseSync(path.join(f.stateRoot, "replica/repos", f.subject.repoId, "ack.sqlite"));
          try {
            const sql = {
              expired: "UPDATE delivery_lease SET expires_at=0 WHERE node_id=?",
              replaced: "UPDATE delivery_lease SET holder_id='replacement', claim_fence=claim_fence+1 WHERE node_id=?",
              released: "UPDATE delivery_lease SET holder_id=NULL, expires_at=0 WHERE node_id=?",
              missing: "DELETE FROM delivery_lease WHERE node_id=?",
            };
            if (interleaving) {
              const peer = openReplicaAckStore(f.stateRoot);
              t.after(() => peer.close());
              const key = { repoId: f.subject.repoId, nodeId: f.subject.nodeId, viewId: f.subject.nodeId };
              const original = peer.delivery.active(key, Date.now())!;
              const changeLease = () => {
                changedAfterDecision = true;
                if (cause === "expired-replaced") assert.ok(peer.delivery.claim(key, "successor", Date.now(), 30_000));
                else peer.delivery.release(original);
              };
              const prepare = DatabaseSync.prototype.prepare;
              const exec = DatabaseSync.prototype.exec;
              const deciding = new WeakSet<DatabaseSync>();
              t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, query: string) {
                const statement = prepare.call(this, query);
                if (query.startsWith("UPDATE delivery_lease SET expires_at=?")) {
                  const run = statement.run.bind(statement);
                  t.mock.method(statement, "run", (...args: Parameters<typeof run>) => {
                    const result = run(...args);
                    if (Number(result.changes) === 0 && !changedAfterDecision) {
                      deciding.add(this);
                      if (!this.isTransaction) changeLease();
                    }
                    return result;
                  });
                }
                return statement;
              });
              // An independent writer acts at the first unlocked boundary after the failed UPDATE.
              t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, query: string) {
                exec.call(this, query);
                if (deciding.has(this) && !this.isTransaction && !changedAfterDecision) changeLease();
              });
            }
            db.prepare(sql[initialCause as keyof typeof sql]).run(f.subject.nodeId);
          } finally {
            db.close();
          }
        }
      };
      const content = source.delivery.content;
      if (phase === "Delivery")
        t.mock.method(source.delivery, "content", async (blob) => {
          const result = await content(blob);
          if (!crossed) fence();
          return result;
        });
      const center = await f.center();
      await assert.rejects(
        runFleetReplicaPullClient({
          readAccessToken: async () => `device-token-${f.subject.nodeId}`,
          port: center.port,
          ca: f.cert,
          nodeId: f.subject.nodeId,
          credential: "machine-secret",
          repoId: f.subject.repoId,
          viewRoot: path.join(f.root, "fenced-rpc"),
          diskQuotaBytes: 64 * 1024 * 1024,
          ...(phase === "ACK" ? { beforeAck: fence } : {}),
        }),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, "replica_delivery_fenced");
          const detail = JSON.parse(error.message.split(" diagnostics=")[1]!);
          assert.equal(detail.phase, phase);
          assert.equal(detail.branch, cause === "pin" ? "pin_inactive" : "lease_renewal_failed");
          assert.equal(detail.lease.state, cause === "pin" ? "active" : initialCause);
          assert.equal(detail.requested.nodeId, f.subject.nodeId);
          assert.equal(detail.requested.viewId, f.subject.nodeId);
          assert.equal(detail.requested.repoId, f.subject.repoId);
          assert.ok(detail.requested.holderId);
          assert.ok(detail.requested.claimFence > 0);
          assert.equal(detail.pinReleaseReason, cause === "pin" ? "not_retained; correlate pin-release log" : null);
          assert.ok(Number.isSafeInteger(detail.now));
          if (initialCause === "expired") {
            assert.ok(detail.now >= detail.lease.current.expiresAt);
            assert.equal(detail.lease.current.holderId, detail.requested.holderId);
            assert.equal(detail.lease.current.claimFence, detail.requested.claimFence);
          }
          if (cause === "replaced") assert.equal(detail.lease.current.holderId, "replacement");
          const logged = f.transportErrors.find(
            (entry) =>
              (entry as { error: Error }).error.message === error.message.replace("replica_delivery_fenced: ", ""),
          );
          assert.ok(logged, "the same rejection evidence must reach the center log sink");
          return true;
        },
      );
      assert.equal(crossed, true);
      assert.equal(changedAfterDecision, interleaving);
    });
  }
}

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
        // Seed the disposable canonical-state fixture beside document rows; no production
        // exporter reads ad hoc writes to the projection's serving tables.
        db.prepare("INSERT INTO replica_entry VALUES (?, ?, NULL, 'document', ?)").run(
          itemPath,
          JSON.stringify({ sha256: digest, size: Buffer.byteLength(body), mediaType: "text/markdown" }),
          JSON.stringify([itemPath]),
        );
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
    // About five snapshot sizes, matching the center-to-snapshot ratio in a large repository.
    const quota = 320 * 1024 * 1024;
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
    // Pause the real executor after it captures the read snapshot, before its first build transaction.
    const control = new Int32Array(new SharedArrayBuffer(4));
    const { promise: buildHeld, resolve: markBuildHeld } = Promise.withResolvers<void>();
    const Worker = workerThreads.Worker;
    const workerMock = t.mock.method(
      workerThreads,
      "Worker",
      class extends Worker {
        constructor(url: string | URL, options: workerThreads.WorkerOptions = {}) {
          const checkpoint = String(url).endsWith("/replica-cut-executor.ts");
          super(checkpoint ? new URL("./fleet-checkpoint-build-barrier.fixture.ts", import.meta.url) : url, {
            ...options,
            ...(checkpoint ? { workerData: { ...options.workerData, control, moduleUrl: String(url) } } : {}),
          });
          if (checkpoint)
            this.on("message", (message) => {
              if (message.checkpointBuildHeld) markBuildHeld();
            });
        }
      },
    );
    syncBuiltinESMExports();
    const releaseBuild = () => {
      Atomics.store(control, 0, 0);
      Atomics.notify(control, 0);
    };
    t.after(() => {
      releaseBuild();
      workerMock.mock.restore();
      syncBuiltinESMExports();
    });
    const { promise: deliveryWrite, resolve: markDeliveryWrite } = Promise.withResolvers<void>();
    const content = source.delivery.content;
    t.mock.method(source.delivery, "content", async (blob) => {
      if (blob.mediaType === "text/markdown" && blob.size >= 32 * 1024) await deliveryWrite;
      return content(blob);
    });
    const building = source.prepare().then((cut) => {
      built = true;
      sample("built");
      return cut;
    });
    const writing = (async () => {
      await buildHeld;
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
        if (writesDuringBuild === 2) releaseBuild();
        if (began && !acknowledged) {
          writesDuringDelivery++;
          markDeliveryWrite();
        }
        sample("write");
      }
    })();
    const pulling = runFleetReplicaPullClient({
      readAccessToken: async () => `device-token-${f.subject.nodeId}`,
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
