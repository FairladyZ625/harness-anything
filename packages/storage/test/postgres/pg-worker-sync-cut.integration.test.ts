// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { serializePersistedCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { MessageChannel, Worker } from "node:worker_threads";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { waitForPgQueryWorker } from "../../src/pg/pg-task-query-reader.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { makeTaskEventReader, makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeDaemonProjectionReader, openFleetStorage } from "../../src/storage-daemon-composition.ts";
import { bundle, eventAt, initRepo } from "../store/task-event-store.fixtures.ts";
import type { PostgresTaskEventStoreRequest } from "../../src/postgres/pg-task-event-store.ts";
import type { PostgresStorageBackendConfig } from "../../src/storage-backend.ts";

const scope = { tenantId: "s2", projectId: "s2", policyEpoch: 1, readers: [] };
const shared = (length: number) => new Int32Array(new SharedArrayBuffer(length * 4));
function worker(
  storage: PostgresStorageBackendConfig,
  repoId: string,
  input: Record<string, unknown>,
  transferList: import("node:worker_threads").Transferable[] = [],
) {
  return new Worker(new URL("./pg-sync-worker.fixture.ts", import.meta.url), {
    workerData: { storage, repoId, ...input },
    transferList,
  });
}
async function strict(fixture: Awaited<ReturnType<typeof pgRuntimeFixture>>, enabled: boolean) {
  await fixture.adminPool.query(
    enabled ? "ALTER SYSTEM SET synchronous_standby_names = '*'" : "ALTER SYSTEM RESET synchronous_standby_names",
  );
  await fixture.adminPool.query("SELECT pg_reload_conf()");
  while (
    (await fixture.adminPool.query("SHOW synchronous_standby_names")).rows[0]!.synchronous_standby_names !==
    (enabled ? "*" : "")
  ) {
    /* observable configuration barrier */
  }
}
async function blocked(fixture: Awaited<ReturnType<typeof pgRuntimeFixture>>) {
  for (;;) {
    const result = await fixture.adminPool.query(
      "SELECT pid,wait_event FROM pg_stat_activity WHERE usename='ha_runtime' AND wait_event='SyncRep' AND state='active'",
    );
    if (result.rows.length) return result.rows;
  }
}
const attempts = new Map<string, ReturnType<typeof bundle>>();
function append(repoId: string, revision: number): PostgresTaskEventStoreRequest & { operation: "append" } {
  const key = `${repoId}:${revision}`;
  let value = attempts.get(key);
  if (!value) {
    const id = randomUUID(),
      original = eventAt(revision),
      payloadMarker = `marker_${id}`;
    value = bundle({
      ...original,
      opId: `op_inj_${id}`,
      eventId: `evt_inj_${id}`,
      payload: { ...original.payload, task: { ...original.payload.task, title: payloadMarker } },
    });
    attempts.set(key, value);
    console.log(
      "S2_ATTEMPT",
      JSON.stringify({
        opId: value.event.opId,
        eventId: value.event.eventId,
        payloadMarker,
        intentDigest: `sha256:${sha256Text(JSON.stringify([serializePersistedCanonicalEvent(value.event)]))}`,
      }),
    );
  }
  return {
    operation: "append",
    bundle: value,
    expectedRevision: revision - 1,
    writerFence: { repoId, holderId: "direct-store", epoch: 1 },
  };
}

for (const before of [true, false])
  test(
    `C6${before ? "a" : "b"}: real PG transaction and worker response honor ${before ? "abort" : "commit"} CAS winner`,
    { timeout: 60_000 },
    async () => {
      const fixture = await pgRuntimeFixture(),
        repoId = `cas-${randomUUID()}`,
        storage = { backend: "postgres" as const, connectionString: fixture.connectionString, scope },
        state = shared(3),
        stats = shared(3),
        gate = shared(1),
        ready = shared(3),
        { port1, port2 } = new MessageChannel();
      const host = worker(storage, repoId, { mode: "cas", state, stats, gate, ready, port: port2, before }, [port2]);
      try {
        const [startup] = await once(port1, "message");
        assert.equal(startup.error, undefined);
        const barrier = once(host, "message");
        Atomics.store(state, 2, 1);
        port1.postMessage({ id: 1, op: "canonical", args: [append(repoId, 1)] });
        assert.equal((await barrier)[0].event, "barrier");
        const previous = Atomics.compareExchange(state, 1, 0, -1);
        assert.equal(previous, before ? 0 : 1);
        let detach: { code: string; opId: string } | undefined;
        if (!before) {
          const abort = new AbortController();
          abort.signal.addEventListener("abort", () => {
            assert.equal(Atomics.load(state, 2), 1);
            assert.equal(Atomics.compareExchange(state, 1, 0, -1), 1);
            detach = { code: "publication_indeterminate", opId: append(repoId, 1).bundle.event.opId };
          });
          abort.abort();
          assert.equal(detach?.code, "publication_indeterminate");
        }
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        const endpoint = {
          terminate() {
            Atomics.add(stats, 2, 1);
            return host.terminate();
          },
        };
        const response = waitForPgQueryWorker(state, port1, 1, 200, endpoint as never, "timeout", {
          rollbackGraceMs: 5000,
        });
        assert.equal(stats[0], before ? 0 : 1);
        assert.equal(stats[1], before ? 1 : 0);
        assert.equal(stats[2], 0);
        assert.equal(state[1], before ? -1 : 1);
        if (before) assert.equal(response.error?.fields?.code, "write_aborted_pre_commit");
        else assert.equal(response.error, undefined);
        const rows = await fixture.adminPool.query("SELECT op_id FROM ha_events WHERE repo_id=$1", [repoId]);
        assert.equal(rows.rowCount, before ? 0 : 1);
        const watermarks = await fixture.adminPool.query(
          "SELECT confirmed_revision FROM ha_repo_sync_watermarks WHERE repo_id=$1",
          [repoId],
        );
        assert.equal(watermarks.rowCount, before ? 0 : 1);
        if (!before) assert.equal(Number(watermarks.rows[0].confirmed_revision), 1);
        console.log(
          before ? "C6A_REAL_PG" : "C6B_REAL_PG",
          JSON.stringify({
            previous,
            state: [...state],
            commitCalls: stats[0],
            rollbackCalls: stats[1],
            terminateCalls: stats[2],
            detach,
            response,
            rows: rows.rows,
            watermarks: watermarks.rows,
          }),
        );
      } finally {
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        const closing = once(host, "message");
        host.postMessage({ operation: "close" });
        await closing;
        port1.close();
        await host.terminate();
        await fixture.pool.end();
        await fixture.close();
      }
    },
  );

for (const mode of ["product", "bridge"])
  test(
    `C1: independent product readers progress while a ${mode} writer waits in SyncRep`,
    { timeout: 60_000 },
    async () => {
      const fixture = await pgRuntimeFixture(),
        repoId = `c1-${mode}-${randomUUID()}`,
        storage = { backend: "postgres" as const, connectionString: fixture.connectionString, scope },
        stats = shared(3),
        state = shared(3),
        gate = shared(1);
      const backend = createPgStorageBackend({ pool: fixture.pool, repoId, scope });
      await backend.eventStore.execute(append(repoId, 1));
      const reader = makeTaskEventReader({ repoId, storage }),
        projection = makeDaemonProjectionReader({ repoId, rootDir: fixture.root, storage }),
        fleet = openFleetStorage({ repoId, rootDir: fixture.root, storage });
      const host = worker(storage, repoId, { mode, stats, state, gate });
      try {
        assert.equal((await once(host, "message"))[0].event, "ready");
        const healthyStart = performance.now();
        const healthyBackup = await fleet.startBackup(join(fixture.root, "healthy-backup"), "unused");
        const healthyBackupMs = performance.now() - healthyStart;
        await healthyBackup.complete;
        console.log(
          "C1_HEALTHY_BACKUP_CONTROL",
          JSON.stringify({ mode, healthyBackupMs, metadata: healthyBackup.metadata }),
        );
        await strict(fixture, true);
        const response = once(host, "message");
        host.postMessage(append(repoId, 2));
        const blockedRows = await blocked(fixture),
          blockedAt = performance.now(),
          timings: Record<string, number> = {},
          results: Record<string, unknown> = {};
        const read = <T>(name: string, action: () => T): T => {
          const start = performance.now();
          const result = action();
          timings[name] = performance.now() - start;
          results[name] = result;
          return result;
        };
        assert.equal(read("readHead", () => reader.readHead())!.revision, 1);
        assert.notEqual(
          read("baselineOutcome", () => reader.readCommandOutcome(append(repoId, 1).bundle.event.opId)),
          null,
        );
        assert.equal(
          read("pendingOutcome", () => reader.readCommandOutcome(append(repoId, 2).bundle.event.opId)),
          null,
        );
        const position = fleet.replicationPosition();
        read("replicationPage", () => fleet.replicationCommits(position, 10));
        read("listTasks", () => projection.withSession((q) => q.list({})));
        const backupStart = performance.now(),
          backup = await fleet.startBackup(join(fixture.root, "backup"), "unused");
        timings.startBackup = performance.now() - backupStart;
        results.backup = backup.metadata;
        await backup.complete;
        // The short-deadline bridge signals an actual 1s commit-liveness poll.
        if (mode === "bridge") await Atomics.waitAsync(gate, 0, 0).value;
        const blockedForMs = performance.now() - blockedAt;
        if (mode === "bridge") assert.ok(blockedForMs > 500, `commit polling covered only ${blockedForMs}ms`);
        assert.ok((await blocked(fixture)).length);
        assert.equal(stats[2], 0);
        if (mode === "bridge") assert.equal(state[1], 1);
        console.log(
          "C1_REAL_PRODUCT",
          JSON.stringify({
            mode,
            healthyBackupMs,
            timings,
            results,
            blockedRows,
            blockedForMs,
            state: [...state],
            terminateCalls: stats[2],
          }),
        );
        for (const [name, ms] of Object.entries(timings)) assert.ok(ms < 500, `${name} took ${ms}ms`);
        await strict(fixture, false);
        assert.equal((await response)[0].error, undefined);
      } finally {
        await strict(fixture, false);
        const closing = once(host, "message");
        host.postMessage({ operation: "close" });
        await closing;
        await host.terminate();
        await reader.drain?.();
        projection.close();
        fleet.close();
        await backend.projection.close();
        await fixture.pool.end();
        await fixture.close();
      }
    },
  );

test(
  "E3/E8/E9 fail closed per repository and E5 defers Follower before mutating its cut",
  { timeout: 60_000 },
  async () => {
    const fixture = await pgRuntimeFixture(),
      repoId = "dirty",
      storage = { backend: "postgres" as const, connectionString: fixture.connectionString, scope };
    const backend = createPgStorageBackend({ pool: fixture.pool, repoId, scope });
    const cleanScope = { ...scope, tenantId: "clean", projectId: "clean" },
      clean = createPgStorageBackend({ pool: fixture.pool, repoId: "clean", scope: cleanScope });
    const rootDir = join(fixture.root, "worktree");
    mkdirSync(rootDir);
    initRepo(rootDir);
    execFileSync("git", ["branch", "authored"], { cwd: rootDir, stdio: "pipe" });
    await backend.eventStore.execute(append(repoId, 1));
    await clean.eventStore.execute(append("clean", 1));
    const store = makeTaskEventStore({ repoId, storage: { ...storage, gitFollower: { branch: "authored" } }, rootDir });
    const reader = makeTaskEventReader({ repoId, storage });
    const projection = makeDaemonProjectionReader({ repoId, storage, rootDir });
    const cleanReader = makeDaemonProjectionReader({
      repoId: "clean",
      storage: { ...storage, scope: cleanScope },
      rootDir,
    });
    try {
      await store.settlePendingMaterialization!();
      const baseline = store.followerStatus!();
      console.log("S2_FOLLOWER_BASELINE", JSON.stringify({ baseline, health: store.materializationHealth?.() }));
      assert.equal(baseline.git.cut?.revision, 1);
      await backend.eventStore.execute(append(repoId, 2));
      // A visible, unconfirmed tail is a fixture state. S1 separately tests the cancelled-COMMIT injection.
      await fixture.adminPool.query(
        "UPDATE ha_repo_sync_watermarks SET confirmed_revision=1,confirmed_sequence=1 WHERE repo_id=$1",
        [repoId],
      );
      await strict(fixture, true);
      assert.throws(() => projection.withSession((q) => q.list({})), { code: "sync_replication_unconfirmed" });
      assert.throws(() => reader.readEntityDeclarations!({ kind: "task" }), { code: "sync_replication_unconfirmed" });
      await assert.rejects(backend.projection.readOperation(append(repoId, 2).bundle.event.opId), {
        code: "sync_replication_unconfirmed",
      });
      assert.ok(cleanReader.withSession((q) => q.list({})));
      await store.settlePendingMaterialization!();
      const deferred = store.followerStatus!();
      assert.equal(deferred.git.status, "pending");
      assert.equal(deferred.git.cut?.revision, 1);
      assert.equal(deferred.git.commitSha, baseline.git.commitSha);
      assert.equal(deferred.worktree.cut?.revision, 1);
      console.log(
        "S2_PROJECTION_CUT",
        JSON.stringify({ baseline, deferred, cleanTasks: cleanReader.withSession((q) => q.list({})) }),
      );
      await strict(fixture, false);
      assert.ok(projection.withSession((q) => q.list({})));
      await store.settlePendingMaterialization!();
      assert.equal(store.followerStatus!().git.cut?.revision, 2);
      await fixture.adminPool.query("DELETE FROM ha_repo_sync_watermarks WHERE repo_id=$1", [repoId]);
      assert.ok(
        projection.withSession((q) => q.list({})),
        "a cold read session must register and flush the real owner's commit work",
      );
      const healed = await fixture.adminPool.query(
        "SELECT confirmed_revision FROM ha_repo_sync_watermarks WHERE repo_id=$1",
        [repoId],
      );
      assert.equal(Number(healed.rows[0].confirmed_revision), 2);
    } finally {
      await strict(fixture, false);
      await reader.drain?.();
      projection.close();
      cleanReader.close();
      await store.drain();
      await backend.projection.close();
      await clean.projection.close();
      await fixture.pool.end();
      await fixture.close();
    }
  },
);

test("F1: cold reader retains its legacy maintenance COMMIT across a read deadline", { timeout: 60_000 }, async () => {
  const fixture = await pgRuntimeFixture(),
    repoId = `cold-${randomUUID()}`,
    storage = { backend: "postgres" as const, connectionString: fixture.connectionString, scope },
    state = shared(3),
    stats = shared(3),
    gate = shared(1),
    backend = createPgStorageBackend({ pool: fixture.pool, repoId, scope });
  await backend.eventStore.execute(append(repoId, 1));
  await fixture.adminPool.query("UPDATE ha_command_outcomes SET replication_sequence=NULL WHERE repo_id=$1", [repoId]);
  await fixture.adminPool.query("DELETE FROM ha_repo_sync_watermarks WHERE repo_id=$1", [repoId]);
  const { port1, port2 } = new MessageChannel();
  const host = worker(storage, repoId, { mode: "cold-read", state, stats, gate, controlPort: port2 }, [port2]);
  try {
    assert.equal((await once(host, "message"))[0].event, "ready");
    const snapshot = once(port1, "message");
    host.postMessage({ operation: "cold-read" });
    assert.deepEqual((await snapshot)[0], { event: "cold-snapshot", hasNull: true });
    // The reader has proved its snapshot, but has not committed or run maintenance yet.
    await strict(fixture, true);
    const progress = once(host, "message");
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const message = (await progress)[0];
    console.log("F1_READ_PROGRESS", JSON.stringify({ message, state: [...state], stats: [...stats] }));
    assert.equal(message.event, "poll", "the read deadline must retain the worker through maintenance SyncRep");
    assert.equal(state[1], 1);
    assert.equal(stats[2], 0);
    assert.ok((await blocked(fixture)).length);
    assert.equal(
      (await fixture.adminPool.query("SELECT * FROM ha_repo_sync_watermarks WHERE repo_id=$1", [repoId])).rowCount,
      0,
    );
    const completed = once(host, "message");
    await strict(fixture, false);
    const result = (await completed)[0];
    assert.equal(result.event, "result");
    assert.equal(result.error, undefined);
    assert.equal(stats[0], 2, "read owner and legacy maintenance both committed");
    assert.equal(stats[1], 0);
    assert.equal(stats[2], 0);
    const outcomes = await fixture.adminPool.query(
      "SELECT replication_sequence FROM ha_command_outcomes WHERE repo_id=$1",
      [repoId],
    );
    assert.equal(Number(outcomes.rows[0].replication_sequence), 1);
    const watermarks = await fixture.adminPool.query(
      "SELECT confirmed_revision FROM ha_repo_sync_watermarks WHERE repo_id=$1",
      [repoId],
    );
    assert.equal(Number(watermarks.rows[0].confirmed_revision), 1);
    console.log(
      "F1_READ_COMMITTED",
      JSON.stringify({ state: [...state], stats: [...stats], outcomes: outcomes.rows, watermarks: watermarks.rows }),
    );
  } finally {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    await strict(fixture, false);
    const closing = once(host, "message");
    host.postMessage({ operation: "close" });
    await closing;
    await host.terminate();
    port1.close();
    await backend.projection.close();
    await fixture.pool.end();
    await fixture.close();
  }
});
