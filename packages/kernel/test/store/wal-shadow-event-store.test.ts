// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { serializePersistedCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import { type TaskCreatedEvent } from "../../src/domain/task-lifecycle.contract.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { sha256Text, stableStringify } from "../../src/integrity/stable-hash.ts";
import { contentObjectRelativePath } from "../../src/layout/ledger-object-layout.ts";
import { localWalFileSystem } from "../../src/local/local-layout-file-system.ts";
import { VcsCommandError } from "../../src/ports/version-control-system.ts";
import { resolveLedgerGitLayout } from "../../src/store/ledger-git-layout.ts";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import { makeTaskEventStore as makeGitEventStore } from "../../src/store/task-event-store.ts";
import {
  isRetryableWalMaterializationError,
  runWalMaterializationRequest,
} from "../../src/store/wal-materialization-worker.ts";
import { makeWalShadowEventStore } from "../../src/store/wal-shadow-event-store.ts";
import { captureWalDurableCut, openWalDurablePrefix, openWalEventLog } from "../../src/store/wal-event-log.ts";
import { withTempStoreAsync } from "./helpers.ts";

test("ledger Git layout resolution reuses one normalized-root identity", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const before = localGitObjectRefStore.processCount(),
      first = resolveLedgerGitLayout(rootDir),
      afterFirst = localGitObjectRefStore.processCount(),
      second = resolveLedgerGitLayout(rootDir);
    assert.equal(first, second);
    assert.equal(afterFirst - before, 1, "the first layout resolution probes the Git top level");
    assert.equal(localGitObjectRefStore.processCount() - afterFirst, 0, "the cached layout starts no subprocess");
  });
});

test("S4 acknowledges the durable WAL cut with zero Git processes and immediate worktree visibility", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-shadow", rootDir, walFlushEvents: 64, walFlushMs: 60_000 });
    const bundle = taskBundle(1, "visible on return\n");
    assert.deepEqual(
      bundle.plan.targets.filter((target) => target.kind === "local_wal_file"),
      [
        { kind: "local_wal_file", path: ".harness/wal/seg-000000.log", operation: "append" },
        { kind: "local_wal_file", path: ".harness/wal/head.json", operation: "replace" },
        { kind: "local_wal_file", path: `.harness/wal/objects/${bundle.blobs[0]!.sha256}`, operation: "replace" },
      ],
    );
    const committedEvents = store.read().events;
    const branchBefore = git(rootDir, "rev-parse", "HEAD");
    const receipt = store.append(bundle);
    const wal = openWalEventLog(rootDir, { mutable: false });
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.commitSha, null);
    assert.equal(receipt.cut.opId, bundle.event.opId);
    assert.deepEqual(
      { repoId: receipt.cut.repoId, revision: receipt.cut.revision, headDigest: receipt.cut.headDigest },
      store.currentCut(),
    );
    assert.equal(receipt.metrics.gitProcesses, 0);
    assert.equal(committedEvents.length, 0, "an already-returned Git stream remains immutable");
    assert.equal(git(rootDir, "rev-parse", "HEAD"), branchBefore);
    assert.equal(
      readFileSync(path.join(rootDir, "harness", "tasks", "task-1", "task.md"), "utf8"),
      "visible on return\n",
    );
    assert.equal(existsSync(path.join(rootDir, ".harness", "wal", "seg-000000.log")), true);
    assert.deepEqual(wal.readEvent(bundle.event.opId), bundle.event);
    assert.deepEqual(wal.audit(store.read().events, store.read().revision), {
      status: "equivalent",
      walRevision: 1,
      gitRevision: 1,
      compared: 1,
      divergence: null,
    });
    await store.drain();
  });
});

test("S4 batches a WAL suffix into one Git commit and garbage-collects local content", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-shadow", rootDir, walFlushEvents: 64, walFlushMs: 60_000 });
    const countBefore = Number(git(rootDir, "rev-list", "--count", "HEAD"));
    for (let revision = 1; revision <= 3; revision += 1)
      assert.equal(store.append(taskBundle(revision, `document ${revision}\n`)).commitSha, null);
    assert.deepEqual(
      openWalEventLog(rootDir, { mutable: false })
        .records()
        .map((record) => record.revision),
      [1, 2, 3],
    );
    await store.drain();
    assert.equal(Number(git(rootDir, "rev-list", "--count", "HEAD")), countBefore + 1);
    assert.deepEqual(openWalEventLog(rootDir, { mutable: false }).records(), []);
    assert.deepEqual(readdirSync(path.join(rootDir, ".harness", "wal", "objects")), []);
    const reopened = makeWalShadowEventStore({ repoId: "wal-shadow", rootDir });
    assert.deepEqual(
      reopened.read().events.map((event) => event.workspaceRevision),
      [1, 2, 3],
    );
    await reopened.drain();
  });
});

test("a verified WAL flush reuses the process-local Git content validation prefix", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({
      repoId: "wal-validation-prefix",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 60_000,
    });
    store.append(taskBundle(1, "validated once\n"));
    await store.drain();

    const trustedStarted = localGitObjectRefStore.processCount();
    assert.equal(store.read().revision, 1);
    const trustedProcesses = localGitObjectRefStore.processCount() - trustedStarted;

    const fresh = makeWalShadowEventStore({ repoId: "wal-validation-prefix", rootDir, walFlushMs: 60_000 });
    const freshStarted = localGitObjectRefStore.processCount();
    assert.equal(fresh.read().revision, 1);
    const freshProcesses = localGitObjectRefStore.processCount() - freshStarted;
    assert.equal(
      freshProcesses,
      trustedProcesses + 1,
      "a fresh process view performs the content batch that the validated prefix can omit",
    );
    await fresh.drain();
  });
});

test("an unvalidated Git prefix is still checked after a WAL suffix flush", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const first = taskBundle(1, "valid history\n"),
      gitStore = makeGitEventStore({ repoId: "wal-unvalidated-prefix", rootDir });
    gitStore.append(first);
    writeFileSync(
      path.join(rootDir, "harness", contentObjectRelativePath(first.blobs[0]!.sha256)),
      "corrupt history\n",
    );
    git(rootDir, "add", "harness/objects");
    git(rootDir, "commit", "-qm", "corrupt historical content fixture");
    git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");

    const store = makeWalShadowEventStore({
      repoId: "wal-unvalidated-prefix",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 60_000,
    });
    store.append(taskBundle(2, "verified suffix\n"));
    await store.drain();
    assert.throws(
      () => store.read(),
      (error: unknown) => {
        assert.equal((error as { readonly code?: string }).code, "invalid_store");
        return /content blob.*not reachable and exact/u.test(String(error));
      },
    );
  });
});

test("WAL materialization rechecks content bytes before trusting the flushed suffix", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({
        repoId: "wal-corrupt-object",
        rootDir,
        walFlushEvents: 64,
        walFlushMs: 60_000,
        walRetryLimit: 1,
      }),
      bundle = taskBundle(1, "durable bytes\n");
    store.append(bundle);
    writeFileSync(path.join(rootDir, ".harness", "wal", "objects", bundle.blobs[0]!.sha256), "corrupt\n");
    const errors: string[] = [],
      originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await assert.rejects(
        store.drain(),
        (error: unknown) => (error as { readonly code?: string }).code === "materialization_failed",
      );
    } finally {
      console.error = originalError;
    }
    assert.equal(
      errors.some((error) => error.includes("WAL content object") && error.includes("corrupt")),
      true,
    );
    assert.equal(store.materializationHealth().reason, "deterministic_failure");
    assert.equal(makeGitEventStore({ repoId: "wal-corrupt-object", rootDir }).read().revision, 0);
  });
});

test("bulk writes defer visibility and settle one Git cut", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-bulk", rootDir, walFlushMs: 1 });
    const bulk = store.beginBulkWrite!();
    const countBefore = Number(git(rootDir, "rev-list", "--count", "HEAD"));
    for (let revision = 1; revision <= 3; revision += 1)
      store.append(taskBundle(revision, `bulk document ${revision}\n`));
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-3/task.md")), false);
    await bulk.finish();
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-3/task.md"), "utf8"), "bulk document 3\n");
    assert.equal(Number(git(rootDir, "rev-list", "--count", "HEAD")), countBefore + 1);
    const eventPath = git(rootDir, "ls-tree", "-r", "--name-only", "HEAD")
      .split("\n")
      .find((target) => target.endsWith("/op-1.json"));
    assert.ok(eventPath, "bulk event remains committed in Git");
    assert.equal(existsSync(path.join(rootDir, eventPath)), false, "immutable bulk events stay out of the active tree");
    assert.equal(
      git(rootDir, "status", "--porcelain", "--untracked-files=no"),
      "",
      "skip-worktree keeps tracked compact objects clean",
    );
    await store.drain();
  });
});

test("byte threshold flushes a durable WAL batch independently of the event threshold", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const byteThreshold = 1;
    let resolveMaterialization!: () => void;
    const materialized = new Promise<void>((resolve) => {
      resolveMaterialization = resolve;
    });
    const store = makeWalShadowEventStore({
      repoId: "wal-bytes",
      rootDir,
      walFlushEvents: 10_000,
      walFlushBytes: byteThreshold,
      walFlushMs: 60_000,
      walFlushAdaptive: false,
      walMaterializationSpan: (span) => {
        if (span.name === "materialization") resolveMaterialization();
      },
    });
    let checkpointDeadline: ReturnType<typeof setTimeout> | null = null;
    try {
      store.append(taskBundle(1));
      const durableBytes = openWalEventLog(rootDir, { mutable: false }).head().lastOffset;
      assert.ok(
        durableBytes >= byteThreshold,
        `the fixture must cross its ${byteThreshold}-byte threshold (wrote ${durableBytes} bytes)`,
      );
      await Promise.race([
        materialized,
        new Promise<never>((_, reject) => {
          checkpointDeadline = setTimeout(
            () => reject(new Error("byte-threshold WAL materialization did not checkpoint within 30 seconds")),
            30_000,
          );
          checkpointDeadline.unref?.();
        }),
      ]);
      assert.deepEqual(openWalEventLog(rootDir, { mutable: false }).records(), []);
    } finally {
      if (checkpointDeadline !== null) clearTimeout(checkpointDeadline);
      await store.drain();
    }
  });
});

test("S4 discards a torn WAL tail without losing the acknowledged record", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const first = taskCreated(1);
    const wal = openWalEventLog(rootDir);
    wal.append({ event: first, blobs: [] });
    wal.close();
    const segment = path.join(rootDir, ".harness", "wal", "seg-000000.log");
    appendFileSync(segment, '{"torn":');
    const reopened = openWalEventLog(rootDir);
    assert.deepEqual(
      reopened.records().map((record) => record.revision),
      [1],
    );
    assert.equal(readFileSync(segment, "utf8").endsWith("\n"), true);
    assert.equal(reopened.audit([first], 1).status, "equivalent");
    reopened.close();
  });
});

test("an authoritative WAL fsync failure rejects the write without changing Git or memory", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-shadow-failure", rootDir });
    const before = git(rootDir, "rev-parse", "HEAD");
    const originalAppend = localWalFileSystem.append;
    localWalFileSystem.append = () => {
      throw new Error("simulated WAL I/O failure");
    };
    try {
      const event = taskCreated(1);
      assert.throws(
        () => store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] }),
        /simulated WAL I\/O failure/u,
      );
    } finally {
      localWalFileSystem.append = originalAppend;
    }
    assert.equal(git(rootDir, "rev-parse", "HEAD"), before);
    assert.equal(store.read().revision, 0);
    assert.deepEqual(openWalEventLog(rootDir, { mutable: false }).records(), []);
    await store.drain();
  });
});

test("materialization failures warn, retry with a bound, and do not revoke the write receipt", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    const store = makeWalShadowEventStore({
      repoId: "wal-retry",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 60_000,
      walRetryLimit: 4,
      walRetryBaseMs: 1,
      walMaterializationTestFault: { point: "after_git_commit", failures: 2 },
    });
    try {
      const receipt = store.append(taskBundle(1, "retry remains visible\n"));
      assert.equal(receipt.status, "applied");
      assert.equal(receipt.commitSha, null);
      await store.drain();
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.filter((warning) => warning.includes("materialization failed")).length, 2);
    assert.deepEqual(openWalEventLog(rootDir, { mutable: false }).records(), []);
    assert.equal(makeGitEventStore({ repoId: "wal-retry", rootDir }).read().revision, 1);
    assert.deepEqual(store.materializationHealth(), {
      state: "ok",
      lastCheckpointRevision: 1,
      lastCheckpointAt: "2026-08-20T00:00:00.000Z",
      pendingWalEvents: 0,
    });
  });
});

test("materialization retry classification admits only recognized transient failures", () => {
  assert.equal(
    isRetryableWalMaterializationError(
      new VcsCommandError({
        command: "update-index",
        cwd: "/repo",
        exitCode: 128,
        stderrSummary: "fatal: Unable to create '/repo/.git/index.lock': File exists",
      }),
    ),
    true,
  );
  assert.equal(
    isRetryableWalMaterializationError(
      new VcsCommandError({
        command: "update-ref",
        cwd: "/repo",
        exitCode: 128,
        stderrSummary: "fatal: cannot lock ref 'refs/ha/canonical': is at aaa but expected bbb",
      }),
    ),
    false,
  );
  assert.equal(
    isRetryableWalMaterializationError(Object.assign(new Error("temporarily unavailable"), { code: "EAGAIN" })),
    true,
  );
  assert.equal(
    isRetryableWalMaterializationError(
      new Error(
        "Command failed: git update-index\nfatal: Unable to create '/repo/.git/index.lock': File exists.\n\n" +
          "Another git process seems to be running in this repository.",
      ),
    ),
    true,
  );
  assert.equal(isRetryableWalMaterializationError(Object.assign(new Error("resource busy"), { code: "EBUSY" })), true);
  assert.equal(
    isRetryableWalMaterializationError(
      Object.assign(new Error("writer epoch is stale"), { code: "writer_epoch_stale" }),
    ),
    false,
  );
});

test("a temporary real Git index lock reports retrying and self-heals without restart", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const lockPath = path.join(rootDir, ".git", "index.lock"),
      warnings: string[] = [],
      originalWarn = console.warn;
    let retryingHealth: ReturnType<ReturnType<typeof makeWalShadowEventStore>["materializationHealth"]> | null = null,
      retryingError: Record<string, unknown> | null = null,
      observeRetry!: () => void;
    const retryObserved = new Promise<void>((resolve) => {
      observeRetry = resolve;
    });
    let store!: ReturnType<typeof makeWalShadowEventStore>;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      store = makeWalShadowEventStore({
        repoId: "wal-temporary-index-lock",
        rootDir,
        walFlushEvents: 1,
        walFlushMs: 60_000,
        walRetryLimit: 3,
        walRetryBaseMs: 1,
        onMaterializationHealthChange: (health) => {
          if (health.state !== "retrying" || retryingHealth !== null) return;
          retryingHealth = health;
          try {
            store.append(taskBundle(2, "blocked during retry\n"));
            assert.fail("a new write must be refused while the durable WAL is retrying");
          } catch (error) {
            retryingError = error as Record<string, unknown>;
          }
          rmSync(lockPath, { force: true });
          observeRetry();
        },
      });
      writeFileSync(lockPath, "held by contract test\n");
      assert.equal(store.append(taskBundle(1, "temporary lock\n")).status, "applied");
      await retryObserved;
      await store.drain();
    } finally {
      console.warn = originalWarn;
      rmSync(lockPath, { force: true });
    }
    assert.equal(retryingHealth?.state, "retrying");
    assert.equal(retryingHealth?.reason, undefined);
    assert.equal(Number.isSafeInteger(retryingHealth?.retryElapsedMs), true);
    assert.match(retryingHealth?.lastError ?? "", /index\.lock[\s\S]*File exists/iu);
    assert.equal(retryingError?.code, "materialization_failed");
    assert.deepEqual((retryingError?.diagnostic as Record<string, unknown>).kind, "materialization-retrying");
    assert.equal((retryingError?.diagnostic as Record<string, unknown>).state, "retrying");
    assert.equal(Number.isSafeInteger((retryingError?.diagnostic as Record<string, unknown>).retryElapsedMs), true);
    assert.equal(warnings.filter((warning) => warning.includes("materialization failed")).length, 1);
    assert.deepEqual(openWalEventLog(rootDir, { mutable: false }).records(), []);
    assert.deepEqual(store.materializationHealth(), {
      state: "ok",
      lastCheckpointRevision: 1,
      lastCheckpointAt: "2026-08-20T00:00:00.000Z",
      pendingWalEvents: 0,
    });
  });
});

test("a persistent real Git index lock exhausts retries and keeps the bounded red light", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const lockPath = path.join(rootDir, ".git", "index.lock"),
      warnings: string[] = [],
      originalWarn = console.warn;
    const store = makeWalShadowEventStore({
      repoId: "wal-persistent-index-lock",
      rootDir,
      walFlushEvents: 1,
      walFlushMs: 60_000,
      walRetryLimit: 2,
      walRetryBaseMs: 1,
    });
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      writeFileSync(lockPath, "held by contract test\n");
      assert.equal(store.append(taskBundle(1, "persistent lock\n")).status, "applied");
      const failed = await waitForMaterializationState(store, "failed");
      assert.equal(failed.reason, "retry_budget_exhausted");
      assert.notEqual(failed.reason, "deterministic_failure");
      assert.equal(failed.pendingWalEvents, 1);
      assert.match(failed.lastError ?? "", /index\.lock[\s\S]*File exists/iu);
      assert.throws(
        () => store.append(taskBundle(2, "still blocked\n")),
        (error: unknown) => (error as { readonly code?: string }).code === "materialization_failed",
      );
      await waitForMaterializationState(store, "failed");
      rmSync(lockPath, { force: true });
      assert.throws(
        () => store.append(taskBundle(2, "recovery probe\n")),
        (error: unknown) => (error as { readonly code?: string }).code === "materialization_failed",
      );
      await waitForMaterializationState(store, "ok");
      assert.equal(store.append(taskBundle(2, "accepted after repair\n")).status, "applied");
      await store.drain();
    } finally {
      console.warn = originalWarn;
      rmSync(lockPath, { force: true });
    }
    assert.equal(warnings.filter((warning) => warning.includes("materialization failed")).length, 4);
    assert.deepEqual(openWalEventLog(rootDir, { mutable: false }).records(), []);
    assert.deepEqual(store.materializationHealth(), {
      state: "ok",
      lastCheckpointRevision: 2,
      lastCheckpointAt: "2026-08-20T00:00:00.000Z",
      pendingWalEvents: 0,
    });
  });
});

test("deterministic materialization failure latches before drain consumes the retry budget", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    let attempts = 0;
    const store = makeWalShadowEventStore({
      repoId: "wal-deterministic-failure",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 60_000,
      walRetryLimit: 8,
      walRetryBaseMs: 250,
      walMaterialize: (_config, request) => {
        attempts += 1;
        return {
          schema: "harness-wal-materialization-response/v1",
          requestId: request.requestId,
          outcome: "failed",
          cut: request.cut,
          error: {
            name: "TaskEventStoreError",
            message: "Git cut changed before materialization",
            code: "publication_indeterminate",
            classification: "deterministic_failure",
            canonicalSha: null,
          },
        };
      },
    });
    store.append(taskBundle(1, "deterministic failure\n"));
    await assert.rejects(
      store.drain(),
      (error: unknown) => (error as { readonly code?: string }).code === "materialization_failed",
    );
    assert.equal(attempts, 1);
    assert.equal(store.materializationHealth().reason, "deterministic_failure");
  });
});

test("retry exhaustion latches writes until recovery checkpoints the pending WAL", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const observedStates: string[] = [],
      store = makeWalShadowEventStore({
        repoId: "wal-retry-exhausted",
        rootDir,
        walFlushEvents: 1,
        walFlushMs: 60_000,
        walRetryLimit: 2,
        walRetryBaseMs: 1,
        walMaterializationTestFault: { point: "before_materialization", failures: 2 },
        onMaterializationHealthChange: ({ state }) => observedStates.push(state),
      });
    store.append(taskBundle(1, "latched retry\n"));
    const failed = await waitForMaterializationState(store, "failed");
    assert.deepEqual(failed, {
      state: "failed",
      lastCheckpointRevision: 0,
      lastCheckpointAt: null,
      pendingWalEvents: 1,
      reason: "retry_budget_exhausted",
      lastError: "simulated worker materialization failure",
    });
    assert.deepEqual(observedStates.slice(-2), ["retrying", "failed"]);
    assert.throws(
      () => store.append(taskBundle(2, "must be rejected\n")),
      (error: unknown) => {
        const materialization = error as Record<string, unknown>;
        assert.equal(materialization.code, "materialization_failed");
        assert.deepEqual(materialization.data, {
          lastCheckpointRevision: 0,
          lastCheckpointAt: null,
          pendingWalEvents: 1,
          reason: "retry_budget_exhausted",
          lastError: "simulated worker materialization failure",
        });
        assert.deepEqual(materialization.diagnostic, {
          kind: "materialization-failed",
          ...(materialization.data as Record<string, unknown>),
        });
        return true;
      },
    );
    assert.notEqual(store.recover().status, "indeterminate");
    await store.settleRecoveryMaterialization?.();
    assert.deepEqual(store.materializationHealth(), {
      state: "ok",
      lastCheckpointRevision: 1,
      lastCheckpointAt: "2026-08-20T00:00:00.000Z",
      pendingWalEvents: 0,
    });
    assert.equal(store.append(taskBundle(2, "accepted after recovery\n")).revision, 2);
    await store.drain();
  });
});

test("a master branch forked from canonical rejects writes until refs are repaired and recovered", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({
      repoId: "wal-diverged",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 1,
      walRetryBaseMs: 1,
    });
    const canonical = git(rootDir, "rev-parse", "refs/ha/canonical");
    const fork = git(rootDir, "commit-tree", `${canonical}^{tree}`, "-m", "worker direct fork");
    git(rootDir, "reset", "--hard", fork);
    const errors: string[] = [];
    const originalError = console.error;
    try {
      console.error = (...args: unknown[]) => errors.push(args.join(" "));
      store.append(taskBundle(1, "diverged cut\n"));
      const failed = await waitForMaterializationState(store, "failed");
      assert.equal(failed.reason, "git_diverged");
      assert.equal(failed.lastCheckpointRevision, 0);
      assert.equal(failed.lastCheckpointAt, null);
      assert.equal(failed.pendingWalEvents, 1);
      assert.throws(
        () => store.append(taskBundle(2, "must not queue\n")),
        (error: unknown) => {
          const materialization = error as Record<string, unknown>;
          assert.equal(materialization.code, "materialization_failed");
          assert.equal((materialization.data as Record<string, unknown>).reason, "git_diverged");
          return true;
        },
      );
      assert.throws(
        () =>
          store.append(taskBundle(2, "atomic rewrite must not queue\n"), [
            { target: "harness/blocked.txt", body: "blocked\n", mode: "100644" },
          ]),
        (error: unknown) => (error as { readonly code?: string }).code === "materialization_failed",
      );
      const processesAfterExplicitProbes = localGitObjectRefStore.processCount();
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(errors.filter((line) => line.includes("materializer stopped")).length, 1);
      assert.equal(
        localGitObjectRefStore.processCount(),
        processesAfterExplicitProbes,
        "a stopped materializer must not spin Git calls between explicit recovery probes",
      );
      const stopped = store.recover();
      assert.equal(stopped.status, "indeterminate");
      assert.match(stopped.error ?? "", new RegExp(`git -C ${rootDir} reset ${canonical}`, "u"));
      assert.equal(errors.filter((line) => line.includes("materializer stopped")).length, 1);
      git(rootDir, "reset", "--hard", canonical);
      const recovered = store.recover();
      assert.notEqual(recovered.status, "indeterminate");
      await store.settleRecoveryMaterialization?.();
      assert.deepEqual(store.materializationHealth(), {
        state: "ok",
        lastCheckpointRevision: 1,
        lastCheckpointAt: "2026-08-20T00:00:00.000Z",
        pendingWalEvents: 0,
      });
      assert.equal(store.append(taskBundle(2, "accepted after repair\n")).revision, 2);
      await store.drain();
    } finally {
      console.error = originalError;
    }
  });
});

test("worker failure transport preserves divergence detected during ref finalization", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    let fork = "",
      moved = false,
      transportedClassification: string | null = null;
    const store = makeWalShadowEventStore({
      repoId: "wal-finalization-diverged",
      rootDir,
      walFlushEvents: 1,
      walFlushMs: 60_000,
      walMaterializationFence: () => ({
        schema: "harness-writer-epoch-fence/v1",
        stateRoot: rootDir,
        repoId: "wal-finalization-diverged",
        epoch: 1,
        holderId: "finalization-divergence-test",
      }),
      walMaterialize: (config, request) => {
        const response = runWalMaterializationRequest(config, request, {
          withFinalizeFence: (_fence, operation) => {
            if (!moved) {
              git(rootDir, "reset", "--hard", fork);
              moved = true;
            }
            return operation();
          },
        });
        if (response.outcome === "failed") transportedClassification = response.error.classification;
        return response;
      },
    });
    const canonical = git(rootDir, "rev-parse", "refs/ha/canonical");
    fork = git(rootDir, "commit-tree", `${canonical}^{tree}`, "-m", "finalization fork");
    store.append(taskBundle(1, "diverged during finalization\n"));
    await waitForMaterializationState(store, "failed");
    assert.equal(transportedClassification, "git_diverged");
    assert.equal(store.materializationHealth().reason, "git_diverged");
    git(rootDir, "reset", "--hard", canonical);
    assert.notEqual(store.recover().status, "indeterminate");
    await store.settleRecoveryMaterialization?.();
  });
});

test("a compatible authored ref race retries the same WAL prefix without latching", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    let advance = "",
      moved = false,
      firstClassification: string | null = null;
    const store = makeWalShadowEventStore({
      repoId: "wal-finalization-race",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 60_000,
      walRetryLimit: 2,
      walRetryBaseMs: 1,
      walMaterializationFence: () => ({
        schema: "harness-writer-epoch-fence/v1",
        stateRoot: rootDir,
        repoId: "wal-finalization-race",
        epoch: 1,
        holderId: "finalization-race-test",
      }),
      walMaterialize: (config, request) => {
        const response = runWalMaterializationRequest(config, request, {
          withFinalizeFence: (_fence, operation) => {
            if (!moved) {
              git(rootDir, "reset", "--hard", advance);
              moved = true;
            }
            return operation();
          },
        });
        if (response.outcome === "failed" && firstClassification === null)
          firstClassification = response.error.classification;
        return response;
      },
    });
    const canonical = git(rootDir, "rev-parse", "refs/ha/canonical");
    advance = git(rootDir, "commit-tree", `${canonical}^{tree}`, "-p", canonical, "-m", "compatible advance");
    store.append(taskBundle(1, "retry compatible finalization\n"));
    await store.drain();
    assert.equal(firstClassification, "retryable");
    assert.deepEqual(store.materializationHealth(), {
      state: "ok",
      lastCheckpointRevision: 1,
      lastCheckpointAt: "2026-08-20T00:00:00.000Z",
      pendingWalEvents: 0,
    });
  });
});

test("healthy materialization reports an ok checkpoint before and after a WAL flush", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({
      repoId: "wal-healthy",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 60_000,
    });
    assert.deepEqual(store.materializationHealth(), {
      state: "ok",
      lastCheckpointRevision: 0,
      lastCheckpointAt: null,
      pendingWalEvents: 0,
    });
    store.append(taskBundle(1, "healthy checkpoint\n"));
    assert.equal(store.materializationHealth().pendingWalEvents, 1);
    await store.drain();
    assert.deepEqual(store.materializationHealth(), {
      state: "ok",
      lastCheckpointRevision: 1,
      lastCheckpointAt: "2026-08-20T00:00:00.000Z",
      pendingWalEvents: 0,
    });
  });
});

test("restart recovery reports bounded progress and checkpoints a WAL cut whose Git refs already advanced", async (context) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const first = makeWalShadowEventStore({
      repoId: "wal-recovery",
      rootDir,
      walFlushEvents: 512,
      walFlushMs: 60_000,
      walRetryLimit: 1,
      walRetryBaseMs: 1,
      walMaterializationTestFault: { point: "after_git_ref_update", failures: 1 },
    });
    const receipt = first.append(taskBundle(1, "recover me\n"));
    for (let revision = 2; revision <= 257; revision += 1) first.append(taskBundle(revision));
    assert.equal(receipt.commitSha, null);
    await assert.rejects(
      first.drain(),
      (error: unknown) => (error as { readonly code?: string }).code === "materialization_failed",
    );
    const documentPath = path.join(rootDir, "harness", "tasks", "task-1", "task.md");
    rmSync(documentPath);
    assert.equal(openWalEventLog(rootDir, { mutable: false }).records().length, 257);
    const progress: Array<{ readonly applied: number; readonly total?: number; readonly watermark: number }> = [],
      recovered = makeWalShadowEventStore({
        repoId: "wal-recovery",
        rootDir,
        walFlushMs: 60_000,
        onRecoveryProgress: (observed) => progress.push(observed),
      }),
      walPath = path.join(rootDir, ".harness", "wal", "seg-000000.log"),
      recovery = recovered.recover();
    context.diagnostic(
      `recovered ${String(progress.at(-1)?.applied)} work units from ${String(statSync(walPath).size)} WAL bytes in ${recovery.elapsedMs.toFixed(3)}ms`,
    );
    assert.deepEqual(progress, [
      { applied: 256, watermark: 256 },
      { applied: 257, watermark: 257 },
      { applied: 513, watermark: 257 },
      { applied: 769, watermark: 257 },
      { applied: 770, watermark: 257 },
      { applied: 771, watermark: 257 },
      { applied: 772, total: 772, watermark: 257 },
    ]);
    await recovered.drain();
    assert.equal(readFileSync(documentPath, "utf8"), "recover me\n");
    assert.deepEqual(openWalEventLog(rootDir, { mutable: false }).records(), []);
    assert.equal(recovered.read().revision, 257);
  });
});

test("a concurrent append burst remains contiguous and materializes as one cut", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-burst", rootDir, walFlushEvents: 64, walFlushMs: 60_000 });
    const receipts = await Promise.all(
      Array.from({ length: 24 }, (_, index) => Promise.resolve().then(() => store.append(taskBundle(index + 1)))),
    );
    assert.equal(
      receipts.every((receipt) => receipt.commitSha === null && receipt.metrics.gitProcesses === 0),
      true,
    );
    assert.deepEqual(
      store.read().events.map((event) => event.workspaceRevision),
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    assert.equal(store.read().events, store.read().events, "repeated stream reads reuse the merged event array");
    await store.drain();
    assert.equal(git(rootDir, "log", "-1", "--format=%s"), "harness WAL flush 1-24");
  });
});

test("the RepoWriterCell materializer retries fail closed after a simulated retired-worker exit", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({
      repoId: "wal-worker-exit",
      rootDir,
      walFlushEvents: 64,
      walFlushMs: 60_000,
      walRetryLimit: 2,
      walRetryBaseMs: 1,
      walMaterializationTestFault: { point: "worker_exit", failures: 1 },
    });
    store.append(taskBundle(1, "worker restart\n"));
    await store.drain();
    assert.deepEqual(openWalEventLog(rootDir, { mutable: false }).records(), []);
    assert.equal(makeGitEventStore({ repoId: "wal-worker-exit", rootDir }).read().revision, 1);
  });
});

test("one in-flight RepoWriterCell flush coalesces a newer durable suffix and reports materialization spans", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const spans: { readonly name: string; readonly durationMs: number; readonly throughRevision: number }[] = [],
      store = makeWalShadowEventStore({
        repoId: "wal-worker-coalesce",
        rootDir,
        walFlushEvents: 1,
        walFlushMs: 60_000,
        walMaterializationSpan: (span) => spans.push(span),
      });
    store.append(taskBundle(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    store.append(taskBundle(2));
    store.append(taskBundle(3));
    await store.drain();
    const materializations = spans.filter((span) => span.name === "materialization");
    assert.deepEqual(
      materializations.map((span) => span.throughRevision),
      [1, 3],
    );
    assert.equal(
      materializations.every((span) => span.durationMs >= 0),
      true,
    );
  });
});

test("durable prefix validation rejects a wrong digest and checkpoints only the verified prefix", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const wal = openWalEventLog(rootDir);
    wal.append({ event: taskCreated(1), blobs: [] });
    const cut = captureWalDurableCut(wal)!;
    wal.append({ event: taskCreated(2), blobs: [] });
    assert.throws(
      () =>
        openWalDurablePrefix(rootDir, {
          ...cut,
          headDigest: `sha256:${"0".repeat(64)}`,
        }),
      /does not end at revision 1 and digest/u,
    );
    wal.checkpointCut(cut);
    assert.deepEqual(
      wal.records().map((record) => record.revision),
      [2],
    );
    wal.close();
  });
});

test("a normalized WAL root admits only one process-local mutable owner", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const owner = openWalEventLog(rootDir);
    assert.throws(() => openWalEventLog(path.join(rootDir, ".")), /mutable WAL owner already exists/u);
    assert.doesNotThrow(() => openWalEventLog(rootDir, { mutable: false }).records());
    owner.close();
    const replacement = openWalEventLog(rootDir);
    replacement.close();
  });
});

test("checkpoint reparses disk and preserves the incident-shaped 51564-51569 suffix", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const owner = openWalEventLog(rootDir);
    owner.append({ event: taskCreated(51_563), blobs: [] });
    const cut = captureWalDurableCut(owner)!;
    const segment = path.join(rootDir, ".harness", "wal", "seg-000000.log"),
      objectsRoot = path.join(rootDir, ".harness", "wal", "objects");
    let previousDigest = cut.headDigest;
    for (let revision = 51_564; revision <= 51_569; revision += 1) {
      const event = taskCreated(revision),
        eventDigest = `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}` as const,
        blobBody = `suffix ${revision}\n`,
        blobDigest = sha256Text(blobBody);
      writeFileSync(path.join(objectsRoot, blobDigest), blobBody);
      appendFileSync(
        segment,
        `${stableStringify({
          schema: "harness-wal/v1",
          revision,
          opId: event.opId,
          event,
          blobs: [{ sha256: blobDigest, size: Buffer.byteLength(blobBody), mediaType: "text/plain" }],
          eventDigest,
          previousDigest,
        })}\n`,
      );
      previousDigest = eventDigest;
    }

    owner.checkpointCut(cut);
    owner.append({ event: taskCreated(51_570), blobs: [] });
    const records = owner.records();
    assert.deepEqual(
      records.map((record) => record.revision),
      [51_564, 51_565, 51_566, 51_567, 51_568, 51_569, 51_570],
    );
    assert.equal(records.at(-1)?.previousDigest, records.at(-2)?.eventDigest);
    assert.equal(owner.head().lastOffset, Buffer.byteLength(readFileSync(segment)));
    for (let revision = 51_564; revision <= 51_569; revision += 1)
      assert.equal(existsSync(path.join(objectsRoot, sha256Text(`suffix ${revision}\n`))), true);
    owner.close();
  });
});

function taskCreated(revision: number): TaskCreatedEvent {
  return {
    schema: "task-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    taskId: `task-${revision}`,
    type: "task_created",
    actor: {
      principal: { personId: "person-1" },
      executor: { kind: "agent", id: "codex" },
    },
    source: "local",
    occurredAt: "2026-08-20T00:00:00.000Z",
    payload: {
      task: {
        schema: "task/v2",
        taskId: `task-${revision}`,
        title: `Task ${revision}`,
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: {
          principal: { personId: "person-1" },
          executor: { kind: "agent", id: "codex" },
        },
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
      },
    },
  };
}

function taskBundle(revision: number, document?: string) {
  const base = taskCreated(revision);
  if (document === undefined) return { event: base, plan: taskLifecycleWritePlan(base), blobs: [] };
  const claim = {
    path: `tasks/task-${revision}/task.md`,
    sha256: sha256Text(document),
    size: Buffer.byteLength(document),
    mediaType: "text/markdown" as const,
    policyId: "typed-machine-writer/v1",
  };
  const event = { ...base, payload: { ...base.payload, documentClaims: [claim] } };
  return {
    event,
    plan: taskLifecycleWritePlan(event),
    blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body: document }],
  };
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "WAL Shadow Test");
  git(rootDir, "config", "user.email", "wal-shadow@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}

async function waitForMaterializationState(
  store: ReturnType<typeof makeWalShadowEventStore>,
  state: "ok" | "retrying" | "failed",
) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const health = store.materializationHealth();
    if (health.state === state) return health;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`materialization did not reach ${state}: ${JSON.stringify(store.materializationHealth())}`);
}

test("materialize reads canonical blobs only for divergent files, not once per document", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const docCount = 8,
      store = makeWalShadowEventStore({ repoId: "materialize-scale", rootDir, walFlushEvents: 64, walFlushMs: 60_000 });
    for (let revision = 1; revision <= docCount; revision += 1)
      store.append(taskBundle(revision, `# doc ${revision}\n`));
    await store.drain();

    // A fresh process view holds no WAL content in memory, so every canonical blob read must fall through
    // to a Git subprocess — exactly what processCount observes. The first materialize settles the worktree
    // and any one-off content validation; steady-state cost is then measured on the second call.
    const fresh = makeWalShadowEventStore({ repoId: "materialize-scale", rootDir, walFlushMs: 60_000 });
    assert.deepEqual(fresh.materialize().changed, []);
    const cleanStarted = localGitObjectRefStore.processCount(),
      clean = fresh.materialize(),
      cleanProcesses = localGitObjectRefStore.processCount() - cleanStarted;
    assert.deepEqual(clean.changed, []);
    assert.ok(
      cleanProcesses < docCount,
      `a current worktree must not start one Git read per document (started ${cleanProcesses} for ${docCount} docs)`,
    );

    // Deleting a subset makes materialize restore exactly those files and read strictly more than the clean
    // pass — proving the blob reads are proportional to divergence, not to the size of the corpus.
    const removed = [2, 5, 7].map((revision) => `tasks/task-${revision}/task.md`);
    for (const target of removed) rmSync(path.join(rootDir, "harness", target));
    const restoreStarted = localGitObjectRefStore.processCount(),
      restored = fresh.materialize(),
      restoreProcesses = localGitObjectRefStore.processCount() - restoreStarted;
    assert.deepEqual([...restored.changed].sort(), [...removed].sort());
    assert.ok(
      restoreProcesses > cleanProcesses,
      `restoring ${removed.length} divergent files must read their blobs (${restoreProcesses}) — a clean pass reads ${cleanProcesses}`,
    );
    await fresh.drain();
  });
});
