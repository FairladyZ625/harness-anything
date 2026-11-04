// harness-test-tier: integration
import { openSqliteEventStore } from "@harness-anything/storage";
import { serializeEventHead, sha256Text } from "@harness-anything/kernel";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { writeFleetEdgeConfig } from "../src/client/fleet-edge-config.ts";
import { readReplicaGeneration, replicaGenerationReaders } from "../src/fleet/replica-generation.ts";
import { openRepoReadClient } from "../src/repo-read-pool.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";

test(
  "a query worker pins its generation in the receiver owner until the read completes",
  { timeout: 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true),
      viewRoot = path.join(f.root, "pin-view"),
      rootDir = path.join(f.root, "query-edge"),
      barrier = new Int32Array(new SharedArrayBuffer(12));
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "pin-task", title: "Pinned" })).outcome,
      "applied",
    );
    await catchUpReplica({ ...f.peer("node-one"), viewRoot, diskQuotaBytes: 64 * 1024 * 1024 });
    await f.center.close();
    await f.closeHost(f.host);
    mkdirSync(rootDir);
    writeFleetEdgeConfig(rootDir, {
      repoId: "lease-repo",
      host: "127.0.0.1",
      port: f.center.port,
      caPath: path.join(f.root, "tls.crt"),
      nodeId: "node-one",
      credential: "secret-node-one",
      viewRoot,
      quotaBytes: 64 * 1024 * 1024,
    });
    const client = openRepoReadClient(
      { repoId: "lease-repo" as never, rootDir: rootDir as never, ownerId: "pin-test", mode: "remote-edge" },
      (_url, options) =>
        new Worker(new URL("./fixtures/replica-read-pin-worker.ts", import.meta.url), {
          ...options,
          workerData: { ...options.workerData, barrier: barrier.buffer },
        }),
    );
    const viewDir = path.join(viewRoot, "repos", "lease-repo", "views", "node-one"),
      before = readReplicaGeneration(viewDir)!,
      pointer = path.join(viewDir, "current.json"),
      next = { ...JSON.parse(readFileSync(pointer, "utf8")), id: "replacement" };
    cpSync(before.rootDir, path.join(viewDir, "generations", next.id), { recursive: true });
    Atomics.store(barrier, 0, 1);
    const pending = client.request<{ rows: { taskId: string }[] }>("read", ["repo.tasks.list", {}], {
      actor: { principal: { personId: "person-one" }, executor: null },
      source: "local",
    });
    // Attach a rejection handler while the assertion owns the paused read.
    const settled = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      while (Atomics.load(barrier, 1) === 0) await Atomics.waitAsync(barrier, 1, 0).value;
      writeFileSync(pointer, JSON.stringify(next));
      replicaGenerationReaders(viewDir).collect();
      assert.equal(existsSync(before.rootDir), true, "receiver collection must see the query worker's pin");
      Atomics.store(barrier, 2, 1);
      Atomics.notify(barrier, 2);
      assert.deepEqual(
        (await pending).rows.map((row) => row.taskId),
        ["pin-task"],
      );
      assert.equal(existsSync(before.rootDir), false, "the last completed read releases the superseded generation");
    } finally {
      Atomics.store(barrier, 2, 1);
      Atomics.notify(barrier, 2);
      await settled;
      await client.close();
    }
  },
);

test(
  "rows and cut share one snapshot while the receiver advances the same generation",
  { timeout: 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true),
      viewRoot = path.join(f.root, "cut-view"),
      rootDir = path.join(f.root, "cut-edge"),
      barrier = new Int32Array(new SharedArrayBuffer(12));
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "cut-before", title: "Before" })).outcome,
      "applied",
    );
    await catchUpReplica({ ...f.peer("node-one"), viewRoot, diskQuotaBytes: 64 * 1024 * 1024 });
    const viewDir = path.join(viewRoot, "repos", "lease-repo", "views", "node-one"),
      before = readReplicaGeneration(viewDir)!;
    await f.center.close();
    await f.closeHost(f.host);
    mkdirSync(rootDir);
    writeFleetEdgeConfig(rootDir, {
      repoId: "lease-repo",
      host: "127.0.0.1",
      port: f.center.port,
      caPath: path.join(f.root, "tls.crt"),
      nodeId: "node-one",
      credential: "secret-node-one",
      viewRoot,
      quotaBytes: 64 * 1024 * 1024,
    });
    const client = openRepoReadClient(
      { repoId: "lease-repo" as never, rootDir: rootDir as never, ownerId: "cut-test", mode: "remote-edge" },
      (_url, options) =>
        new Worker(new URL("./fixtures/replica-read-pin-worker.ts", import.meta.url), {
          ...options,
          workerData: { ...options.workerData, barrier: barrier.buffer },
        }),
    );
    Atomics.store(barrier, 0, 1);
    const pending = client.request<{
      rows: { taskId: string }[];
      cut: { revision: number; headDigest: string };
      watermark: number;
    }>("read", ["repo.tasks.list", {}], {
      actor: { principal: { personId: "person-one" }, executor: null },
      source: "local",
    });
    const settled = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      while (Atomics.load(barrier, 1) === 0) await Atomics.waitAsync(barrier, 1, 0).value;
      const host = await f.openHost(),
        center = await f.openCenter(host);
      assert.equal(
        (await f.commandOn(center, "center-node", { kind: "task-create", taskId: "cut-after", title: "After" }))
          .outcome,
        "applied",
      );
      await catchUpReplica({ ...f.peer("node-one"), port: center.port, viewRoot, diskQuotaBytes: 64 * 1024 * 1024 });
      const after = readReplicaGeneration(viewDir)!;
      assert.equal(after.id, before.id, "the receiver must advance in place, without installing another generation");
      assert.ok(after.metadata.position.revision > before.metadata.position.revision);
      Atomics.store(barrier, 2, 1);
      Atomics.notify(barrier, 2);
      const result = await pending,
        revision = result.rows.some((row) => row.taskId === "cut-after")
          ? after.metadata.position.revision
          : before.metadata.position.revision;
      assert.ok(result.rows.some((row) => row.taskId === "cut-before"));
      assert.equal(result.cut.revision, revision, "frame revision must describe the returned rows");
      assert.equal(result.watermark, revision);
      const ledger = openSqliteEventStore({
        databasePath: after.ledgerPath,
        repoId: "lease-repo",
        generation: after.metadata.ledgerGeneration,
        readOnly: true,
      });
      try {
        const head = ledger.eventIdentityAtRevision(revision);
        assert.equal(
          result.cut.headDigest,
          `sha256:${sha256Text(head === null ? "null\n" : serializeEventHead(head))}`,
        );
      } finally {
        ledger.close();
      }
      t.diagnostic(
        JSON.stringify({
          before: before.metadata.position.revision,
          after: after.metadata.position.revision,
          returned: result.cut.revision,
          rows: result.rows.map((row) => row.taskId),
        }),
      );
    } finally {
      Atomics.store(barrier, 2, 1);
      Atomics.notify(barrier, 2);
      await settled;
      await client.close();
    }
  },
);
