// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { syncFleetEdgeMirror } from "../src/fleet-center-admission.ts";
import { openPeer, runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { DatabaseSync } from "node:sqlite";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { fleetFixture, rawPeer } from "./fleet-tls-session.fixture.ts";

for (const fixtureMiB of [64, 256]) {
  test(`hello responds during a ${fixtureMiB} MiB shared cut build`, { timeout: 60_000 }, async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    const center = await f.center(),
      replica = f.host.replica(f.subject.repoId),
      db = new DatabaseSync(path.join(f.repo, ".harness/cache/task.sqlite"));
    try {
      // Authored document bodies exercise the real SQLite descriptor selection during cut construction.
      const body = "x".repeat(64 * 1024),
        insert = db.prepare("INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)");
      db.exec("BEGIN");
      for (let i = 0; i < fixtureMiB * 16; i++) {
        const itemPath = `context/large-${i}.md`;
        insert.run(
          itemPath,
          1,
          JSON.stringify({
            path: itemPath,
            body,
            blobSha256: "a".repeat(64),
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
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    const sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 5);
    t.after(() => clearInterval(sample));
    let complete = false;
    const first = replica.prepare(),
      second = replica.prepare();
    const building = first.then((cut) => {
      complete = true;
      return cut;
    });
    const peer = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret");
    assert.equal(complete, false, "real TLS hello must finish before the large cut build");
    assert.strictEqual(first, second, "concurrent edges share the same construction promise");
    peer.close();
    const cut = await building;
    assert.ok(cut);
    assert.ok(cut.manifest.totalBytes >= fixtureMiB * 1024 * 1024);
    assert.equal(replica.latest()?.manifest.digest, cut.manifest.digest);
    const written = await f.host.run(
      f.subject.repoId,
      { kind: "task-create", taskId: "task-during-build", title: "During build" },
      f.auth,
    );
    assert.equal(written.outcome, "applied");
    await waitForFleetPublication(f.host, f.subject.repoId, written.opId, f.auth);
    let rebuilt = false;
    const rebuilding = replica.waitForCut(written.revision!).then((value) => {
      rebuilt = true;
      return value;
    });
    const readStarted = performance.now();
    const page = await replica.delivery.manifestPage(cut.revision, 0);
    assert.ok(page?.entries.length);
    assert.equal(rebuilt, false, "delivery reads are independent of the builder response queue");
    t.diagnostic(
      `immutable page delivery gap=${performance.now() - readStarted}ms while checkpoint builder is pending`,
    );
    await rebuilding;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    clearInterval(sample);
    t.diagnostic(
      `cut RSS fixtureMiB=${fixtureMiB} baselineBytes=${baselineRss} peakBytes=${peakRss} deltaBytes=${peakRss - baselineRss} samplingMs=5`,
    );
  });
}

test("default TLS name remains localhost and explicit servername is honored", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const center = await f.center();
  for (const hostname of [undefined, "localhost", "127.0.0.1"]) {
    const peer = await openPeer({
      hostname,
      port: center.port,
      ca: f.cert,
      repoId: f.subject.repoId,
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
    });
    peer.close();
  }
  await assert.rejects(
    openPeer({
      hostname: "127.0.0.1",
      port: center.port,
      ca: f.cert,
      servername: "wrong.example",
      repoId: f.subject.repoId,
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
    }),
    { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
  );
});

test("internal admission failure retains its code without registration advice", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const center = await f.center();
  f.failOwnerLookup(new Error("registry unreadable"));
  await assert.rejects(
    syncFleetEdgeMirror({
      payload: {
        host: "127.0.0.1",
        port: center.port,
        caPath: f.certFile,
        servername: "localhost",
        nodeId: f.subject.nodeId,
        credential: "machine-secret",
        repoId: f.subject.repoId,
        viewRoot: path.join(f.root, "failed-edge"),
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot: f.repo,
      },
    } as Parameters<typeof syncFleetEdgeMirror>[0]),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "handler_failed");
      assert.match(String(error), /Center replica admission failed/u);
      assert.doesNotMatch(String(error), /Register the node|credential/u);
      return true;
    },
  );
  assert.match(String((f.transportErrors[0] as { error: unknown }).error), /registry unreadable/u);
});

test("worker cut failure reaches edge admission with its original cause", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const center = await f.center();
  const db = new DatabaseSync(path.join(f.repo, ".harness/cache/task.sqlite"));
  const resultRef = `artifact:runtime-result/sha256/${"c".repeat(64)}`;
  try {
    db.prepare("INSERT INTO runtime_session(runtime_session_id, workspace_revision, value_json) VALUES (?, ?, ?)").run(
      "current-missing",
      1,
      JSON.stringify({ runtimeSessionId: "current-missing", taskBindings: [], resultRef }),
    );
  } finally {
    db.close();
  }
  await assert.rejects(
    syncFleetEdgeMirror({
      payload: {
        host: "127.0.0.1",
        port: center.port,
        caPath: f.certFile,
        nodeId: f.subject.nodeId,
        credential: "machine-secret",
        repoId: f.subject.repoId,
        viewRoot: path.join(f.root, "failed-worker-edge"),
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot: f.repo,
      },
    }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "handler_failed");
      assert.match(
        String(error),
        /Center replica admission failed: handler_failed: Runtime result.*has no content claim/u,
      );
      assert.doesNotMatch(String(error), /Register the node|correct --node-id/u);
      return true;
    },
  );
  assert.match(String((f.transportErrors[0] as { error: unknown }).error), /has no content claim/u);
});

test("captured worker OOM error reaches the edge without a closed-schema rejection", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const center = await f.center();
  const message = "Worker terminated due to reaching memory limit: JS heap out of memory";
  f.failOwnerLookup(Object.assign(new Error(message), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
  await assert.rejects(
    syncFleetEdgeMirror({
      payload: {
        host: "127.0.0.1",
        port: center.port,
        caPath: f.certFile,
        nodeId: f.subject.nodeId,
        credential: "machine-secret",
        repoId: f.subject.repoId,
        viewRoot: path.join(f.root, "oom-edge"),
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot: f.repo,
      },
    }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "handler_failed");
      assert.equal((error as Error).message, `Center replica admission failed: handler_failed: ${message}`);
      return true;
    },
  );
});

for (const phase of ["prepare", "checkpoint"] as const) {
  test(`preparing frames cannot extend the overall ${phase} deadline`, { timeout: 15_000 }, async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    const replica = f.host.replica(f.subject.repoId);
    let waitingSignal: AbortSignal | undefined;
    t.mock.method(replica, "prepare", () => (phase === "prepare" ? new Promise(() => {}) : Promise.resolve(null)));
    if (phase === "checkpoint") {
      const wait = replica.waitForCut;
      t.mock.method(replica, "waitForCut", (revision: number, signal?: AbortSignal) => {
        waitingSignal = signal;
        return wait(revision, signal);
      });
    }
    const center = await f.center(undefined, { replicaPreparationTimeoutMs: 100, replicaWatchProgressMs: 10 });
    let progress = 0;
    await assert.rejects(
      runFleetReplicaPullClient({
        port: center.port,
        ca: f.cert,
        nodeId: f.subject.nodeId,
        credential: "machine-secret",
        repoId: f.subject.repoId,
        viewRoot: path.join(f.root, phase),
        diskQuotaBytes: 64 * 1024 * 1024,
        timeoutMs: 1000,
        onFrame: (frame) => {
          if (frame.schema === "fleet.replica.preparing/v1") progress++;
        },
      }),
      { code: "replica_pending", message: "replica_pending: Checkpoint preparation deadline exceeded." },
    );
    assert.ok(progress >= 2, "preparing continues but is not completion");
    if (phase === "checkpoint") assert.equal(waitingSignal?.aborted, true);
    assert.equal(center.status().replicas.length, 0, "no delivery lease or registration before readiness");
    t.diagnostic(`${phase}: ${progress} preparing frames, overall deadline 100ms, no delivery claimed`);
  });
}

test("closing a preparing connection releases its wait without claiming a delivery", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const replica = f.host.replica(f.subject.repoId);
  const original = replica.prepare;
  let buildCalls = 0;
  let complete!: (value: Awaited<ReturnType<typeof original>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof original>>>((resolve) => {
    complete = resolve;
  });
  replica.prepare = () => {
    buildCalls++;
    return pending;
  };
  const center = await f.center();
  const peer = await openPeer({
    port: center.port,
    ca: f.cert,
    nodeId: f.subject.nodeId,
    credential: "machine-secret",
  });
  peer.send({ schema: "fleet.replica.pull/v1", messageId: peer.messageId(), repoId: f.subject.repoId });
  assert.equal((await peer.next()).schema, "fleet.replica.preparing/v1");
  peer.close();
  await center.close();
  assert.equal(buildCalls, 1);
  assert.equal(center.status().replicas.length, 0);
  complete(await original());
  replica.prepare = original;
});

test("repository authorization fails before any preparing frame", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  f.owners.keycloak.account("person-denied");
  f.owners.keycloak.node(f.subject.nodeId, "person-denied");
  const center = await f.center();
  const peer = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret");
  const response = await peer.request({
    schema: "fleet.replica.pull/v1",
    messageId: "denied",
    repoId: f.subject.repoId,
  });
  assert.equal(response.schema, "fleet.error/v1");
  if (response.schema === "fleet.error/v1") assert.equal(response.code, "authorization_denied");
  assert.equal(center.status().replicas.length, 0);
});
