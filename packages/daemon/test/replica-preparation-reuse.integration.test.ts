// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import workerThreads from "node:worker_threads";
import test from "node:test";
import { fleetFixture, rawPeer } from "./fleet-tls-session.fixture.ts";

test(
  "400,000-entry preparation survives an expired request and serves later edges from the same cut",
  { timeout: 120_000 },
  async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    const source = f.host.replica(f.subject.repoId);
    const db = new DatabaseSync(path.join(f.repo, ".harness/cache/task.sqlite"));
    try {
      const insert = db.prepare("INSERT INTO replica_entry VALUES (?,NULL,?,'model','')");
      db.exec("BEGIN");
      for (let i = 0; i < 400_000; i++) insert.run(`rows/${String(i).padStart(8, "0")}`, `body-${i}`);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const control = new Int32Array(new SharedArrayBuffer(4));
    const { promise: held, resolve: markHeld } = Promise.withResolvers<void>();
    const Worker = workerThreads.Worker;
    let builds = 0;
    const mocked = t.mock.method(
      workerThreads,
      "Worker",
      class extends Worker {
        constructor(url: string | URL, options: workerThreads.WorkerOptions = {}) {
          const checkpoint = String(url).endsWith("/replica-cut-executor.ts");
          super(checkpoint ? new URL("./fleet-checkpoint-build-barrier.fixture.ts", import.meta.url) : url, {
            ...options,
            ...(checkpoint
              ? {
                  workerData: { ...options.workerData, control, moduleUrl: String(url) },
                  resourceLimits: { maxOldGenerationSizeMb: 256 },
                }
              : {}),
          });
          if (checkpoint) {
            builds++;
            this.on("message", (message) => {
              if (message.checkpointBuildHeld) markHeld();
            });
          }
        }
      },
    );
    syncBuiltinESMExports();
    const release = () => {
      Atomics.store(control, 0, 0);
      Atomics.notify(control, 0);
    };
    t.after(() => {
      release();
      mocked.mock.restore();
      syncBuiltinESMExports();
    });
    const center = await f.center(undefined, { replicaPreparationTimeoutMs: 100, replicaWatchProgressMs: 20 });
    const started = performance.now();
    const building = source.prepare();
    await held;
    const first = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret");
    let frame = await first.request({ schema: "fleet.replica.pull/v1", messageId: "first", repoId: f.subject.repoId });
    while (frame.schema === "fleet.replica.preparing/v1") frame = await first.receive();
    assert.equal(frame.schema, "fleet.error/v1", JSON.stringify(frame));
    if (frame.schema !== "fleet.error/v1") assert.fail("expected a bounded request wait");
    assert.equal(frame.code, "replica_pending");
    first.close();
    assert.strictEqual(source.prepare(), building, "the expired request did not discard the shared preparation");
    assert.equal(center.status().replicas.length, 0, "waiting edges claim no delivery lease");
    release();
    const cut = (await building)!;
    assert.ok(cut.manifest.entryCount >= 400_000);
    assert.ok(performance.now() - started > 100);
    for (const node of [f.subject.nodeId, f.peerSubject.nodeId]) {
      const peer = await rawPeer(f.track, center.port, f.cert, node, "machine-secret");
      let next = await peer.request({ schema: "fleet.replica.pull/v1", messageId: "later", repoId: f.subject.repoId });
      while (next.schema === "fleet.replica.preparing/v1") next = await peer.receive();
      assert.equal(next.schema, "fleet.snapshot.begin/v1", JSON.stringify(next));
      if (next.schema !== "fleet.snapshot.begin/v1") assert.fail("expected the retained checkpoint");
      assert.equal(next.cut.revision, cut.revision);
      assert.equal(next.manifest.digest, cut.manifest.digest);
      peer.close();
    }
    assert.equal(builds, 1);
    assert.deepEqual(source.latest(), cut);
    t.diagnostic(
      `entries=${cut.manifest.entryCount} elapsedMs=${performance.now() - started} requestBudgetMs=100 builds=${builds}`,
    );
  },
);
