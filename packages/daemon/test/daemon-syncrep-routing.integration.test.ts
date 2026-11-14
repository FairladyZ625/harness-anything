// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import { openRepoCellProxy } from "../src/repo-cell-proxy.ts";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";
import { bundle, eventAt } from "../../storage/test/store/task-event-store.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { fixtureFence, settleSettingsEvent } from "./repo-settings.fixture.ts";
import { policyTestCenter, provisionPolicyTestRepository, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import type { RepoWriterRequestV1 } from "../src/repo-writer-protocol.ts";
import { REPO_WRITER_QUEUE_LIMIT } from "../src/writer-request-queue.ts";

async function synchronous(fixture: Awaited<ReturnType<typeof pgRuntimeFixture>>, enabled: boolean) {
  console.log("S3_GUC", "alter", enabled);
  await fixture.adminPool.query(
    enabled ? "ALTER SYSTEM SET synchronous_standby_names='*'" : "ALTER SYSTEM RESET synchronous_standby_names",
  );
  console.log("S3_GUC", "reload", enabled);
  await fixture.adminPool.query("SELECT pg_reload_conf()");
  let observed = (await fixture.adminPool.query("SHOW synchronous_standby_names")).rows[0]!.synchronous_standby_names;
  console.log("S3_GUC", "observed", JSON.stringify(observed), enabled);
  while (observed !== (enabled ? "*" : ""))
    observed = (await fixture.adminPool.query("SHOW synchronous_standby_names")).rows[0]!.synchronous_standby_names;
}

test(
  "C2-C5: real RepoCell read pool, receipt and PG backup progress while its writer waits in SyncRep",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await pgRuntimeFixture(),
      root = join(fixture.root, "repo"),
      repoId = workspaceId("s3-routing"),
      storage = {
        backend: "postgres" as const,
        connectionString: fixture.connectionString,
        authorityConnectionString: fixture.managementConnectionString,
        materialize: false,
        scope: { tenantId: "s3", projectId: "s3", readers: ["person-1"], policyEpoch: 1 },
      };
    mkdirSync(root, { recursive: true });
    const rootDir = canonicalRoot(root);
    provisionPolicyTestRepository(repoId);
    const fence = fixtureFence(repoId, rootDir, join(fixture.root, "epochs"), storage);
    await settleSettingsEvent({ repoId, rootDir, storage, writerEpochFence: fence });
    console.log("S3_STAGE", "seeded");
    const releaseSyncRepOnAbort = () => {
      void synchronous(fixture, false);
    };
    t.signal.addEventListener("abort", releaseSyncRepOnAbort, { once: true });
    const binding = withPolicyGroup(
      {
        actor: { principal: { personId: "person-1" }, executor: null },
        source: "local" as const,
        writerEpochFence: fence,
        writerEpoch: fence.epoch,
      },
      "maintainer",
    );
    let terminateCalls = 0;
    let attemptedOpId: string | undefined;
    const requests: RepoWriterRequestV1[] = [];
    const cell = await openRepoCellProxy(
      { repoId, rootDir, storage, ownerId: "s3", defaultWriterEpochFence: fence, keycloakCenter: policyTestCenter },
      {
        createWriterWorker: (url, options) => {
          const worker = new Worker(url, options),
            post = worker.postMessage.bind(worker),
            terminate = worker.terminate.bind(worker);
          worker.postMessage = (message: RepoWriterRequestV1) => {
            if (message.schema === "harness-repo-writer-request/v1") requests.push(message);
            post(message);
          };
          worker.on("message", (message: { schema?: string; capability?: string; payload?: { opId?: string } }) => {
            if (message.schema === "harness-repo-writer-capability-call/v1" && message.capability === "writeOperation")
              attemptedOpId = message.payload?.opId;
          });
          worker.terminate = () => {
            terminateCalls++;
            return terminate();
          };
          return worker;
        },
      },
    );
    console.log("S3_STAGE", "writer-open");
    let inflight: Promise<unknown> | undefined;
    try {
      const baseline = await cell.run(
        { kind: "task-create", taskId: "task-s3-baseline", title: "Attempt_0", riskTier: "low" },
        binding,
      );
      console.log("S3_STAGE", "baseline-receipt");
      assert.equal(baseline.outcome, "applied", JSON.stringify(baseline));
      await cell.settlePendingMaterialization("baseline");
      // Warm every reader lane outside the measured interruption window.
      await Promise.all(
        Array.from({ length: 4 }, () => cell.run({ kind: "receipt-show", opId: baseline.opId }, binding)),
      );
      console.log("S3_STAGE", "readers-warmed");
      const seed = await cell.fleetBackup!({ directory: join(fixture.root, "backup-warm"), writerEpochFence: fence });
      assert.ok(seed.size > 0);
      console.log("S3_STAGE", "backup-warmed");
      attemptedOpId = undefined;
      await synchronous(fixture, true);
      console.log("S3_STAGE", "strict-enabled");
      const abort = new AbortController();
      inflight = cell.run(
        { kind: "task-create", taskId: "task-s3-blocked", title: "Attempt_X", riskTier: "low" },
        binding,
        abort.signal,
      );
      let completed: unknown;
      void inflight.then(
        (value) => {
          completed = value;
        },
        (error: unknown) => {
          completed = { error: String(error) };
        },
      );
      // A management acknowledgement identifies every owner, including epoch authority connections.
      let blocked: { pid: number; usename: string; query: string }[] = [];
      while (!blocked.length) {
        if (t.signal.aborted) throw new Error("SyncRep observation cancelled by test hang guard");
        if (completed !== undefined)
          throw new Error(`Write settled before SyncRep barrier: ${JSON.stringify(completed)}`);
        blocked = (
          await fixture.adminPool.query(
            "SELECT pid,usename,left(query,100) AS query FROM pg_stat_activity WHERE wait_event='SyncRep' AND state='active'",
          )
        ).rows;
      }
      console.log("S3_BLOCKED_OWNER", JSON.stringify(blocked));
      assert.equal(
        blocked[0]!.usename,
        "ha_runtime",
        "epoch authority must not block before the canonical append; see pg-epoch-transaction.integration.test.ts",
      );
      assert.ok(attemptedOpId, "the actual attempted publication identity must precede COMMIT");
      console.log("S3_STAGE", "syncrep-blocked");
      const at = performance.now();
      const [read, oldReceipt, absent] = await Promise.all([
        cell.read("repo.tasks.list", {}, binding),
        cell.run({ kind: "receipt-show", opId: baseline.opId }, binding),
        cell.run({ kind: "receipt-show", opId: attemptedOpId }, binding),
      ]);
      const readMs = performance.now() - at;
      console.log("S3_STAGE", "reads-complete", readMs);
      assert.equal(oldReceipt.proof?.durable, true, JSON.stringify(oldReceipt));
      assert.ok(
        ["operation_not_published", "publication_indeterminate"].includes(String(absent.code)),
        JSON.stringify(absent),
      );
      assert.ok(read);
      const backup = await cell.fleetBackup!({
        directory: join(fixture.root, "backup-blocked"),
        writerEpochFence: fence,
      });
      assert.ok(backup.size > 0);
      console.log("S3_STAGE", "backup-complete");
      const beforeQueue = requests.length,
        queuedAbort = new AbortController();
      const cancelled = assert.rejects(
        cell.run({ kind: "task-create", taskId: "task-s3-queued", title: "cancelled" }, binding, queuedAbort.signal),
        { name: "AbortError" },
      );
      // Proxy admission yields once; letting that turn complete puts the request in the host FIFO.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const cancelAt = performance.now();
      queuedAbort.abort();
      await cancelled;
      const cancelMs = performance.now() - cancelAt;
      assert.equal(requests.length, beforeQueue);
      const cancelledRows = (
        await fixture.adminPool.query(
          "SELECT count(*)::int AS n FROM ha_events WHERE event_json LIKE '%task-s3-queued%'",
        )
      ).rows[0]!.n;
      assert.equal(cancelledRows, 0);
      const controllers = Array.from({ length: REPO_WRITER_QUEUE_LIMIT - 1 }, () => new AbortController());
      const waiting = controllers.map((controller, i) =>
        assert.rejects(
          cell.run(
            { kind: "task-create", taskId: `task-s3-capacity-${i}`, title: "never dispatched" },
            binding,
            controller.signal,
          ),
          { name: "AbortError" },
        ),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const overloadedAt = performance.now();
      await assert.rejects(
        cell.run({ kind: "task-create", taskId: "task-s3-overloaded", title: "overloaded" }, binding),
        { code: "write_overloaded", data: { retryable: true } },
      );
      const overloadMs = performance.now() - overloadedAt;
      assert.equal(requests.length, beforeQueue);
      for (const controller of controllers) controller.abort();
      await Promise.all(waiting);
      assert.equal(
        (
          await fixture.adminPool.query(
            "SELECT count(*)::int AS n FROM ha_events WHERE event_json LIKE '%task-s3-capacity-%' OR event_json LIKE '%task-s3-overloaded%'",
          )
        ).rows[0]!.n,
        0,
      );
      const detachAt = performance.now();
      abort.abort();
      const detached = (await inflight) as { outcome: string; opId: string };
      assert.equal(detached.outcome, "indeterminate", JSON.stringify(detached));
      assert.ok(detached.opId);
      assert.equal(detached.opId, attemptedOpId);
      const detachMs = performance.now() - detachAt;
      assert.equal(terminateCalls, 0);
      assert.ok(
        (
          await fixture.adminPool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='SyncRep'", [
            blocked[0]!.pid,
          ])
        ).rows.length,
      );
      const next = cell.run({ kind: "task-create", taskId: "task-s3-next", title: "next", riskTier: "low" }, binding);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(requests.length, beforeQueue, "caller detach cannot release the underlying slot");
      await synchronous(fixture, false);
      const continued = await next;
      assert.equal(continued.outcome, "applied", JSON.stringify(continued));
      const confirmed = await cell.run({ kind: "receipt-show", opId: detached.opId }, binding);
      assert.equal(confirmed.proof?.durable, true, JSON.stringify(confirmed));
      assert.equal(terminateCalls, 0);
      console.log(
        "S3_C2_C5",
        JSON.stringify({
          readMs,
          cancelMs,
          overloadMs,
          queueLimit: REPO_WRITER_QUEUE_LIMIT,
          detachMs,
          cancelledRows,
          blockedPid: blocked[0]!.pid,
          terminateCalls,
          oldDurable: oldReceipt.proof?.durable,
          callerOutcome: detached.outcome,
          opId: detached.opId,
          afterRecoveryDurable: confirmed.proof?.durable,
          backupBytes: backup.size,
        }),
      );
    } finally {
      t.signal.removeEventListener("abort", releaseSyncRepOnAbort);
      await synchronous(fixture, false);
      await inflight;
      await cell.close();
      await fixture.pool.end();
      await fixture.close();
    }
  },
);

for (const before of [true, false])
  test(
    `daemon C6${before ? "a" : "b"}: ${before ? "abort" : "commit"} wins across both real worker threads`,
    { timeout: 60_000 },
    async () => {
      const fixture = await pgRuntimeFixture(),
        repoId = workspaceId(`daemon-cas-${before}`),
        gate = new Int32Array(new SharedArrayBuffer(4)),
        reached = new Int32Array(new SharedArrayBuffer(4)),
        stats = new Int32Array(new SharedArrayBuffer(12)),
        storage = {
          backend: "postgres" as const,
          connectionString: fixture.connectionString,
          scope: { tenantId: "s3", projectId: "cas", policyEpoch: 1, readers: [] },
        };
      const requests: RepoWriterRequestV1[] = [];
      let terminateCalls = 0;
      const supervisor = await openWriterSupervisor(
        { repoId, rootDir: canonicalRoot(fixture.root), ownerId: "cas", storage },
        {
          createWorker: () => {
            const worker = new Worker(new URL("./fixtures/syncrep-cas-worker.ts", import.meta.url), {
              workerData: { storage, repoId, gate, reached, stats, before },
            });
            const post = worker.postMessage.bind(worker),
              terminate = worker.terminate.bind(worker);
            worker.postMessage = (request: RepoWriterRequestV1) => {
              if (request.schema === "harness-repo-writer-request/v1") requests.push(request);
              post(request);
            };
            worker.terminate = () => {
              terminateCalls++;
              return terminate();
            };
            return worker;
          },
        },
      );
      const append = (revision: number) => ({
        operation: "append",
        bundle: bundle(eventAt(revision)),
        expectedRevision: revision - 1,
        writerFence: { repoId, holderId: "direct-store", epoch: 1 },
      });
      let next: Promise<unknown> | undefined;
      try {
        const abort = new AbortController(),
          pending = supervisor.request("run", append(1), undefined, abort.signal);
        const outcome = before ? assert.rejects(pending, { name: "AbortError" }) : pending;
        await Atomics.waitAsync(reached, 0, 0).value;
        const state = requests[0]!.writeRequest!.state;
        assert.equal(Atomics.load(state, 1), before ? 0 : 1);
        abort.abort();
        assert.equal(Atomics.load(state, 1), before ? -1 : 1);
        if (!before) {
          const receipt = (await pending) as { outcome: string; opId: string };
          assert.equal(receipt.outcome, "indeterminate");
          assert.equal(receipt.opId, append(1).bundle.event.opId);
        }
        next = supervisor.request("run", append(before ? 1 : 2));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(requests.length, 1, "detach/abort cannot free the underlying slot");
        assert.equal(terminateCalls, 0);
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        await outcome;
        await next;
        assert.equal(Atomics.load(stats, 0), before ? 1 : 2); // next commits after the contested operation
        assert.equal(Atomics.load(stats, 1), before ? 1 : 0);
        assert.equal(Atomics.load(stats, 2), 0);
        assert.equal(terminateCalls, 0);
        const rows = await fixture.adminPool.query("SELECT revision FROM ha_repo_heads WHERE repo_id=$1", [repoId]);
        assert.equal(Number(rows.rows[0]!.revision), before ? 1 : 2);
        console.log(
          "S3_REAL_C6",
          JSON.stringify({
            before,
            contestedCommitCalls: Atomics.load(stats, 0) - 1,
            rollbackCalls: Atomics.load(stats, 1),
            terminateCalls,
            phase: state[1],
            finalRevision: rows.rows[0]!.revision,
          }),
        );
      } finally {
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        await next;
        await supervisor.close();
        await fixture.pool.end();
        await fixture.close();
      }
    },
  );

test(
  "daemon C3: a pre-dispatched queued write cancels while its predecessor remains in real SyncRep",
  { timeout: 60_000 },
  async () => {
    const fixture = await pgRuntimeFixture(),
      repoId = workspaceId("daemon-predispatched-cancel"),
      gate = new Int32Array(new SharedArrayBuffer(4)),
      reached = new Int32Array(new SharedArrayBuffer(4)),
      queued = new Int32Array(new SharedArrayBuffer(4)),
      stats = new Int32Array(new SharedArrayBuffer(12)),
      storage = {
        backend: "postgres" as const,
        connectionString: fixture.connectionString,
        scope: { tenantId: "s3", projectId: "queued-cancel", policyEpoch: 1, readers: [] },
      },
      requests: RepoWriterRequestV1[] = [];
    let terminateCalls = 0;
    const supervisor = await openWriterSupervisor(
      { repoId, rootDir: canonicalRoot(fixture.root), ownerId: "queued-cancel", storage },
      {
        createWorker: () => {
          const worker = new Worker(new URL("./fixtures/syncrep-cas-worker.ts", import.meta.url), {
            workerData: { storage, repoId, gate, reached, queued, stats, before: false, staged: true },
          });
          const post = worker.postMessage.bind(worker),
            terminate = worker.terminate.bind(worker);
          worker.postMessage = (request: RepoWriterRequestV1) => {
            if (request.schema === "harness-repo-writer-request/v1") requests.push(request);
            post(request);
          };
          worker.terminate = () => {
            terminateCalls++;
            return terminate();
          };
          return worker;
        },
      },
    );
    const append = (revision: number, opId: string) => ({
      operation: "append",
      bundle: bundle({ ...eventAt(revision), opId, eventId: `event-${opId}` }),
      expectedRevision: revision - 1,
      writerFence: { repoId, holderId: "direct-store", epoch: 1 },
    });
    let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined, next: Promise<unknown> | undefined;
    try {
      await synchronous(fixture, true);
      const abort = new AbortController();
      first = supervisor.request("run", append(1, "head-syncrep"));
      second = supervisor.request("run", append(2, "cancelled-before-turn"), undefined, abort.signal);
      const cancelled = assert.rejects(second, { name: "AbortError" });
      while (Atomics.load(queued, 0) < 2) {
        const count = Atomics.load(queued, 0);
        if (count < 2) await Atomics.waitAsync(queued, 0, count).value;
      }
      assert.equal(requests.length, 2, "both RPCs were dispatched before either acquired its write slot");
      await Atomics.waitAsync(reached, 0, 0).value;
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      for (;;) {
        const waiting = await fixture.adminPool.query(
          "SELECT 1 FROM pg_stat_activity WHERE usename='ha_runtime' AND wait_event='SyncRep' AND state='active'",
        );
        if (waiting.rowCount) break;
      }
      const abortedAt = performance.now();
      abort.abort();
      assert.equal(
        await Promise.race([
          cancelled.then(() => "cancelled"),
          new Promise<string>((resolve) => setImmediate(() => resolve("still waiting"))),
        ]),
        "cancelled",
        "caller cancellation must not wait for the first COMMIT or a worker message",
      );
      const cancelMs = performance.now() - abortedAt;
      assert.equal(supervisor.status().queueDepth, 2, "both underlying owners remain bounded through cleanup");
      assert.equal(terminateCalls, 0);
      assert.equal(
        (
          await fixture.adminPool.query("SELECT 1 FROM ha_events WHERE repo_id=$1 AND op_id=$2", [
            repoId,
            "cancelled-before-turn",
          ])
        ).rowCount,
        0,
      );
      await synchronous(fixture, false);
      await first;
      await cancelled;
      while (supervisor.status().queueDepth !== 0) await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        (
          await fixture.adminPool.query("SELECT 1 FROM ha_events WHERE repo_id=$1 AND op_id=$2", [
            repoId,
            "cancelled-before-turn",
          ])
        ).rowCount,
        0,
        "a delayed cancel message cannot allow a ghost write after SyncRep recovers",
      );
      assert.equal(stats[0], 1);
      assert.equal(stats[1], 0);
      next = supervisor.request("run", append(2, "after-queued-cleanup"));
      await next;
      assert.equal(
        Number(
          (await fixture.adminPool.query("SELECT revision FROM ha_repo_heads WHERE repo_id=$1", [repoId])).rows[0]!
            .revision,
        ),
        2,
      );
      console.log(
        "S3_PREDISPATCHED_C3",
        JSON.stringify({ cancelMs, cancelledRows: 0, terminateCalls, finalRevision: 2, queueDepthAfterCleanup: 0 }),
      );
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      await synchronous(fixture, false);
      await Promise.allSettled([first, second, next].filter((value): value is Promise<unknown> => value !== undefined));
      await supervisor.close();
      await fixture.pool.end();
      await fixture.close();
    }
  },
);
